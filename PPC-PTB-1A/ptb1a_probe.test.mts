/**
 * PPC-PTB-1A — single-turn tactical certificate: correctness pre-audit probe.
 *
 * READ-ONLY with respect to the product: this file imports production modules
 * and never mutates them. It exists to (a) falsify the naive distance
 * certificate, (b) compare it against a REAL-ENGINE one-turn ground truth,
 * (c) measure trigger coverage on frozen real roots, and (d) measure cost.
 *
 * Ground truth = full DFS over the REAL engine transitions
 * (`catMove` / `mouseMove`) for the current actor's own turn only.
 * Search-side parity = the same DFS through `defaultRuleSet` + the simulator.
 *
 * Every sweep is bounded and reports its own candidate count, so no number here
 * is extrapolated beyond what was actually executed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { catMove, mouseMove } from '../src/game/engine';
import type { GameEngineState } from '../src/game/engine';
import { GamePhase, PieceType, DIRECTIONS } from '../src/game/types';
import { DEFAULT_CONFIG, validateGameConfig, withBoardSize } from '../src/game/config';
import {
  createEvaluationContext,
  evaluateForCat,
  evaluationCellKey,
  mouseCarryingDistanceToHole,
} from '../src/game/ai/evaluation';
import { defaultRuleSet } from '../src/game/ai/searchRules';
import { generateLegalSearchActions } from '../src/game/ai/legalActions';
import { simulateSearchAction } from '../src/game/ai/simulator';

// Run from the repository root (see vitest.config.mts in this folder).
const REPO = process.cwd();
if (!fs.existsSync(path.join(REPO, 'src', 'game', 'engine.ts'))) {
  throw new Error(`probe must run from the repository root, got cwd=${REPO}`);
}
const OUT_DIR = path.join(REPO, 'PPC-PTB-1A', 'out');
const MAX_DFS_STEPS = 8;

// ---------------------------------------------------------------------------
// State revival
// ---------------------------------------------------------------------------

function revive(snap: any): GameEngineState {
  return {
    ...snap,
    pendingButterSpawns: snap.pendingButterSpawns ?? [],
    pendingButterPlacementDebt: snap.pendingButterPlacementDebt ?? 0,
    tunnelExitChoices: snap.tunnelExitChoices ?? [],
    blockedTunnels: snap.blockedTunnels ?? [],
    butterPositions: snap.butterPositions ?? [],
    trapPosition: snap.trapPosition ?? null,
    catTrapsRemaining: snap.catTrapsRemaining ?? 0,
    catActionLog: [],
    gameEventLog: [],
    message: '',
    lastHardSearch: null,
    hardSearchHistory: [],
    hardProgressGuardMemory: null,
  } as GameEngineState;
}

const fixturesPath = path.join(REPO, 'ai-training', 'f2b19a', 'key_root_fixtures.json');
const FIXTURES: Record<string, any> = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
const ROOT_LABELS = Object.keys(FIXTURES);

function rootState(label: string): GameEngineState {
  return revive(FIXTURES[label].rootSnapshot);
}

// ---------------------------------------------------------------------------
// Ground truth: does the CURRENT actor win inside its OWN turn?
// ---------------------------------------------------------------------------

type Witness = { win: boolean; path: string[]; nodes: number };

function sigMouse(s: GameEngineState): string {
  return `${s.mousePosition.r},${s.mousePosition.c}|${s.mouseMovesLeft}|${s.mouseHasButter}${s.mouseSkillActive}|${s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : '-'}`;
}

function sigCat(s: GameEngineState): string {
  return `${s.catPosition.r},${s.catPosition.c}|${s.catMovesLeft}|${s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : '-'}`;
}

/**
 * Mouse one-turn win, REAL ENGINE only.
 *
 * `mouseSkill` is deliberately NOT explored: it CONSUMES the carried butter
 * (`mouseHasButter=false`), and a mouse only wins by entering a hole while
 * carrying — so no skill line can produce a same-turn win. Tunnel entry while
 * carrying is forbidden by the engine, so no tunnel edge is explored either.
 */
function mouseWinThisTurn(state: GameEngineState): Witness {
  if (state.phase !== GamePhase.Playing) return { win: state.phase === GamePhase.MouseWins, path: [], nodes: 0 };
  if (state.currentPlayer !== PieceType.Mouse || state.mouseMovesLeft <= 0) return { win: false, path: [], nodes: 0 };

  const seen = new Set<string>();
  let nodes = 0;

  const dfs = (s: GameEngineState, depth: number, trail: string[]): string[] | null => {
    if (s.phase === GamePhase.MouseWins) return trail;
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) return null;
    if (s.mouseMovesLeft <= 0 || depth >= MAX_DFS_STEPS) return null;
    for (const d of DIRECTIONS) {
      nodes++;
      const next = mouseMove(s, d);
      if (next === s) continue;
      if (next.phase === GamePhase.MouseWins) return [...trail, d.label];
      if (next.phase !== GamePhase.Playing || next.currentPlayer !== PieceType.Mouse) continue;
      const k = sigMouse(next);
      if (seen.has(k)) continue;
      seen.add(k);
      const r = dfs(next, depth + 1, [...trail, d.label]);
      if (r) return r;
    }
    return null;
  };

  // A NON-winning branch may let the engine hand the turn over, which can sample
  // ghost-butter positions with Math.random INSIDE the engine. That only affects
  // states we discard; every WIN line stops before any hand-off.
  const w = dfs(state, 0, []);
  return { win: w !== null, path: w ?? [], nodes };
}

/**
 * Cat one-turn win, REAL ENGINE only.
 * `catPlaceTrap` is not explored: it never moves the cat, and a capture needs
 * the cat to stand on the mouse's cell.
 */
function catWinThisTurn(state: GameEngineState): Witness {
  if (state.phase !== GamePhase.Playing) return { win: state.phase === GamePhase.CatWins, path: [], nodes: 0 };
  if (state.currentPlayer !== PieceType.Cat || state.catMovesLeft <= 0) return { win: false, path: [], nodes: 0 };

  const seen = new Set<string>();
  let nodes = 0;

  const dfs = (s: GameEngineState, depth: number, trail: string[]): string[] | null => {
    if (s.phase === GamePhase.CatWins) return trail;
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat) return null;
    if (s.catMovesLeft <= 0 || depth >= MAX_DFS_STEPS) return null;
    for (const d of DIRECTIONS) {
      nodes++;
      const next = catMove(s, d);
      if (next === s) continue;
      if (next.phase === GamePhase.CatWins) return [...trail, d.label];
      if (next.phase !== GamePhase.Playing || next.currentPlayer !== PieceType.Cat) continue;
      const k = sigCat(next);
      if (seen.has(k)) continue;
      seen.add(k);
      const r = dfs(next, depth + 1, [...trail, d.label]);
      if (r) return r;
    }
    return null;
  };

  const w = dfs(state, 0, []);
  return { win: w !== null, path: w ?? [], nodes };
}

/** Same one-turn mouse win through the SEARCH simulator (parity check). */
function mouseWinViaSimulator(state: GameEngineState): boolean {
  if (state.phase !== GamePhase.Playing) return state.phase === GamePhase.MouseWins;
  if (state.currentPlayer !== PieceType.Mouse || state.mouseMovesLeft <= 0) return false;
  const seen = new Set<string>();

  const dfs = (s: GameEngineState, depth: number): boolean => {
    if (s.phase === GamePhase.MouseWins) return true;
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) return false;
    if (s.mouseMovesLeft <= 0 || depth >= MAX_DFS_STEPS) return false;
    for (const a of generateLegalSearchActions(s, defaultRuleSet)) {
      const res = simulateSearchAction(s, a, defaultRuleSet);
      const outs = res.kind === 'deterministic' ? [res.state] : res.outcomes.map((o) => o.state);
      for (const o of outs) {
        if (o.phase === GamePhase.MouseWins) return true;
        if (o.phase !== GamePhase.Playing || o.currentPlayer !== PieceType.Mouse) continue;
        const k = sigMouse(o);
        if (seen.has(k)) continue;
        seen.add(k);
        if (dfs(o, depth + 1)) return true;
      }
    }
    return false;
  };
  return dfs(state, 0);
}

/** Same one-turn cat win through the SEARCH simulator. */
function catWinViaSimulator(state: GameEngineState): boolean {
  if (state.phase !== GamePhase.Playing) return state.phase === GamePhase.CatWins;
  if (state.currentPlayer !== PieceType.Cat || state.catMovesLeft <= 0) return false;
  const seen = new Set<string>();

  const dfs = (s: GameEngineState, depth: number): boolean => {
    if (s.phase === GamePhase.CatWins) return true;
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat) return false;
    if (s.catMovesLeft <= 0 || depth >= MAX_DFS_STEPS) return false;
    for (const a of generateLegalSearchActions(s, defaultRuleSet)) {
      if (a.type === 'catPlaceTrap') continue;
      const res = simulateSearchAction(s, a, defaultRuleSet);
      const outs = res.kind === 'deterministic' ? [res.state] : res.outcomes.map((o) => o.state);
      for (const o of outs) {
        if (o.phase === GamePhase.CatWins) return true;
        if (o.phase !== GamePhase.Playing || o.currentPlayer !== PieceType.Cat) continue;
        const k = sigCat(o);
        if (seen.has(k)) continue;
        seen.add(k);
        if (dfs(o, depth + 1)) return true;
      }
    }
    return false;
  };
  return dfs(state, 0);
}

// ---------------------------------------------------------------------------
// The NAIVE certificates (exactly as hypothesised in PPC-ARIMAA-01)
// ---------------------------------------------------------------------------

type Cert = { fires: boolean; dist: number | null; gated: string | null };

function naiveMouseCert(s: GameEngineState): Cert {
  if (s.phase !== GamePhase.Playing) return { fires: false, dist: null, gated: 'not_playing' };
  if (s.currentPlayer !== PieceType.Mouse) return { fires: false, dist: null, gated: 'not_mouse_turn' };
  if (s.mouseMovesLeft <= 0) return { fires: false, dist: null, gated: 'no_moves_left' };
  if (!s.mouseHasButter) return { fires: false, dist: null, gated: 'no_butter' };
  const d = mouseCarryingDistanceToHole(s);
  if (d === null) return { fires: false, dist: null, gated: 'unreachable' };
  return { fires: d <= s.mouseMovesLeft, dist: d, gated: null };
}

function naiveCatCert(s: GameEngineState): Cert {
  if (s.phase !== GamePhase.Playing) return { fires: false, dist: null, gated: 'not_playing' };
  if (s.currentPlayer !== PieceType.Cat) return { fires: false, dist: null, gated: 'not_cat_turn' };
  if (s.catMovesLeft <= 0) return { fires: false, dist: null, gated: 'no_moves_left' };
  const ctx = createEvaluationContext(s);
  const d = ctx.catMap.get(evaluationCellKey(s.mousePosition));
  if (d === undefined) return { fires: false, dist: null, gated: 'unreachable' };
  return { fires: d <= s.catMovesLeft, dist: d, gated: null };
}

// ---------------------------------------------------------------------------
// Corrected mouse certificate (trap-aware) — the candidate M1 design
// ---------------------------------------------------------------------------

/**
 * Exact one-turn mouse win: BFS on the CARRYING graph with the trap cell
 * removed. Exactness argument (see report §P2):
 *  - the mouse is the only actor that moves inside its own turn;
 *  - nothing the mouse can do changes terrain, boxes, the trap position or the
 *    cat position, so the graph is STATIC for the whole turn;
 *  - carrying holds for the whole turn (only `mouseSkill` consumes it, and
 *    using the skill forfeits the win);
 *  - entering a tunnel while carrying is illegal (the carrying graph already
 *    excludes tunnel cells);
 *  - stepping on the trap ends the turn with zero moves left, so the trap cell
 *    must be removed from the graph.
 * Therefore `dist(mouse) <= movesLeft` is necessary AND sufficient.
 */
function correctedMouseCertificate(s: GameEngineState, holeSource: 'config' | 'board' = 'board'): { proven: boolean; dist: number | null } {
  if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) return { proven: false, dist: null };
  if (s.mouseMovesLeft <= 0 || !s.mouseHasButter) return { proven: false, dist: null };

  const size = s.config.boardSize;
  const holeKeys = new Set<string>();
  if (holeSource === 'config') {
    const { r, c, size: hs } = s.config.mouseHole;
    for (let dr = 0; dr < hs; dr++) for (let dc = 0; dc < hs; dc++) holeKeys.add(evaluationCellKey({ r: r + dr, c: c + dc }));
  } else {
    // The ENGINE tests `targetCell.type === CellType.MouseHole`; the config rect
    // is only the map-authoring intent. On a hand-drawn map the two can diverge.
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++) if (s.board[r][c].type === 'mouse_hole') holeKeys.add(evaluationCellKey({ r, c }));
    if (holeKeys.size === 0) return { proven: false, dist: null };
  }

  const blocked = (rr: number, cc: number): boolean => {
    const cell = s.board[rr][cc];
    if (cell.type === 'box' || cell.type === 'pile' || cell.type === 'wall' || cell.type === 'void') return true;
    if (s.catPosition.r === rr && s.catPosition.c === cc) return true;
    if (cell.type === 'tunnel') return true; // carrying forbids tunnel entry
    if (s.trapPosition && s.trapPosition.r === rr && s.trapPosition.c === cc) return true;
    return false;
  };

  const start = s.mousePosition;
  const dist = new Set<string>([evaluationCellKey(start)]);
  let frontier = [start];
  let d = 0;
  while (frontier.length > 0) {
    d++;
    if (d > s.mouseMovesLeft) return { proven: false, dist: null };
    const next: { r: number; c: number }[] = [];
    for (const cur of frontier) {
      for (const dir of DIRECTIONS) {
        const nr = cur.r + dir.dr;
        const nc = cur.c + dir.dc;
        if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
        const k = evaluationCellKey({ r: nr, c: nc });
        if (dist.has(k)) continue;
        if (blocked(nr, nc)) continue;
        if (holeKeys.has(k)) return { proven: true, dist: d };
        dist.add(k);
        next.push({ r: nr, c: nc });
      }
    }
    frontier = next;
  }
  return { proven: false, dist: null };
}

// ---------------------------------------------------------------------------
// Synthetic-state builder (default-map terrain, legal positions only)
// ---------------------------------------------------------------------------

function baseTerrain(): GameEngineState {
  const s = rootState('G1T9_chance_mixed');
  return {
    ...s,
    board: s.board.map((row: any[]) => row.map((cell) => ({ type: cell.type }))),
    butterPositions: [],
    pendingButterSpawns: [],
    pendingButterPlacementDebt: 0,
    trapPosition: null,
    catTrapsRemaining: 0,
    blockedTunnels: [],
    tunnelExitChoices: [],
    message: '',
  } as GameEngineState;
}

function makeState(over: Partial<GameEngineState>): GameEngineState {
  return { ...baseTerrain(), ...over } as GameEngineState;
}

function replayMouseWitness(s: GameEngineState, dirs: string[]): boolean {
  let cur = s;
  for (const label of dirs) {
    const d = DIRECTIONS.find((x) => x.label === label);
    if (!d) return false;
    cur = mouseMove(cur, d);
  }
  return cur.phase === GamePhase.MouseWins;
}

function writeOut(name: string, payload: any): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(payload, null, 1));
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('PPC-PTB-1A certificate pre-audit', () => {
  it('P1-A: the naive mouse certificate is falsified by real-engine counterexamples', () => {
    const terrain = baseTerrain();
    const N = terrain.config.boardSize;
    const cells: { r: number; c: number }[] = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push({ r, c });

    // Carrying-graph distance index (no trap on the board).
    const distIndex = new Map<string, number>();
    for (const m of cells) {
      const st = makeState({ mousePosition: m, mouseHasButter: true, currentPlayer: PieceType.Mouse, mouseMovesLeft: 6 });
      const d = mouseCarryingDistanceToHole(st);
      if (d !== null && d > 0) distIndex.set(evaluationCellKey(m), d);
    }

    const falseProven: any[] = [];
    const positiveControls: any[] = [];
    let candidateStates = 0;
    let certFired = 0;

    const mouseCells = [...distIndex.entries()].filter(([, d]) => d >= 2 && d <= 4);
    for (const [mKey, d0] of mouseCells) {
      const [mr, mc] = mKey.split(',').map(Number);
      // Tight budget: exactly the carrying distance, so any obstruction bites.
      const moves = Math.min(d0, 4);
      const trapCandidates = [...distIndex.entries()]
        .filter(([tKey, td]) => td < d0 && tKey !== mKey)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 10);

      const clean = makeState({
        mousePosition: { r: mr, c: mc },
        catPosition: { r: 0, c: 3 },
        mouseHasButter: true,
        currentPlayer: PieceType.Mouse,
        mouseMovesLeft: moves,
        catMovesLeft: 0,
        trapPosition: null,
      });
      const cleanCert = naiveMouseCert(clean);
      if (cleanCert.fires) {
        certFired++;
        const truth = mouseWinThisTurn(clean);
        if (truth.win) positiveControls.push({ mouse: { r: mr, c: mc }, moves, dist: cleanCert.dist, path: truth.path });
        else falseProven.push({ kind: 'CLEAN_FALSE_PROVEN', mouse: { r: mr, c: mc }, moves, dist: cleanCert.dist });
      }

      for (const [tKey, td] of trapCandidates) {
        const [tr, tc] = tKey.split(',').map(Number);
        const st = makeState({
          mousePosition: { r: mr, c: mc },
          catPosition: { r: 0, c: 3 },
          mouseHasButter: true,
          currentPlayer: PieceType.Mouse,
          mouseMovesLeft: moves,
          catMovesLeft: 0,
          trapPosition: { r: tr, c: tc },
        });
        candidateStates++;
        const cert = naiveMouseCert(st);
        if (!cert.fires) continue;
        certFired++;
        const truth = mouseWinThisTurn(st);
        if (!truth.win) {
          falseProven.push({
            kind: 'TRAP_ON_ROUTE',
            mouse: { r: mr, c: mc },
            moves,
            trap: { r: tr, c: tc },
            trapDistToHole: td,
            certDist: cert.dist,
            certSays: 'PROVEN_SAME_TURN_WIN',
            engineSays: 'NO_WIN',
          });
        }
      }
    }

    // Parity: identical verdicts through the search simulator.
    let parityMismatch = 0;
    for (const fp of falseProven.slice(0, 40)) {
      const st = makeState({
        mousePosition: fp.mouse,
        catPosition: { r: 0, c: 3 },
        mouseHasButter: true,
        currentPlayer: PieceType.Mouse,
        mouseMovesLeft: fp.moves,
        catMovesLeft: 0,
        trapPosition: fp.trap ?? null,
      });
      if (mouseWinViaSimulator(st) !== mouseWinThisTurn(st).win) parityMismatch++;
    }

    writeOut('p1a_mouse_falsification.json', {
      section: 'P1-A mouse naive certificate falsification',
      candidateStates,
      certFired,
      falseProvenCount: falseProven.length,
      positiveControls: positiveControls.length,
      parityMismatch,
      falseProvenSamples: falseProven.slice(0, 12),
      positiveControlSamples: positiveControls.slice(0, 3),
    });

    expect(falseProven.length).toBeGreaterThan(0);
    expect(parityMismatch).toBe(0);
    expect(positiveControls.length).toBeGreaterThan(0);
  });

  it('P1-B: the corrected trap-aware certificate is exact against the engine', () => {
    const terrain = baseTerrain();
    const N = terrain.config.boardSize;
    const cells: { r: number; c: number }[] = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push({ r, c });

    let checked = 0;
    let agreed = 0;
    let provenCount = 0;
    const disagreements: any[] = [];
    const witnessFailures: any[] = [];

    for (const m of cells) {
      for (const k of [2, 3]) {
        for (const trap of [null, { r: 5, c: 5 }]) {
          const st = makeState({
            mousePosition: m,
            catPosition: { r: 0, c: 3 },
            mouseHasButter: true,
            currentPlayer: PieceType.Mouse,
            mouseMovesLeft: k,
            catMovesLeft: 0,
            trapPosition: trap,
          });
          const d0 = mouseCarryingDistanceToHole(st);
          if (d0 === null) continue; // not a legal standing cell (box / void / ...)
          checked++;
          const cert = correctedMouseCertificate(st);
          const truth = mouseWinThisTurn(st);
          if (cert.proven === truth.win) agreed++;
          else disagreements.push({ mouse: m, k, trap, cert: cert.proven, truth: truth.win });
          if (cert.proven) {
            provenCount++;
            if (!truth.win || !replayMouseWitness(st, truth.path)) {
              witnessFailures.push({ mouse: m, k, trap, path: truth.path, truth: truth.win });
            }
          }
        }
      }
    }

    writeOut('p1b_mouse_exactness.json', {
      section: 'P1-B corrected (trap-aware) mouse certificate exactness',
      checked,
      agreed,
      provenCount,
      disagreementCount: disagreements.length,
      disagreements: disagreements.slice(0, 10),
      witnessFailures,
    });

    expect(disagreements.length).toBe(0);
    expect(witnessFailures.length).toBe(0);
    expect(provenCount).toBeGreaterThan(0);
  });

  it('P1-C: cat walk distance is SOUND as a sufficient condition, but incomplete', () => {
    const terrain = baseTerrain();
    const N = terrain.config.boardSize;
    const cells: { r: number; c: number }[] = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push({ r, c });

    let checked = 0;
    let fired = 0;
    let bandBudget = 400;
    let pushOnlyBudget = 400;
    const falseProven: any[] = [];
    const missed: any[] = [];
    const pushOnly: any[] = [];

    const isStandingCell = (st: GameEngineState, p: { r: number; c: number }) => {
      const t = st.board[p.r][p.c].type;
      return t !== 'box' && t !== 'tunnel' && t !== 'pile' && t !== 'wall' && t !== 'void' && t !== 'mouse_hole';
    };

    for (const cat of cells) {
      for (const k of [2, 3]) {
        const st = makeState({
          catPosition: cat,
          mousePosition: { r: 9, c: 0 },
          currentPlayer: PieceType.Cat,
          catMovesLeft: k,
          mouseMovesLeft: 0,
          trapPosition: null,
          mouseHasButter: false,
        });
        const ctx = createEvaluationContext(st);
        for (const mouse of cells) {
          if (mouse.r === cat.r && mouse.c === cat.c) continue;
          const d = ctx.catMap.get(evaluationCellKey(mouse));
          const probe = { ...st, mousePosition: mouse } as GameEngineState;

          if (d !== undefined && d <= k + 1) {
            checked++;
            const certFires = d <= k;
            if (certFires) {
              fired++;
              const truth = catWinThisTurn(probe);
              if (!truth.win) falseProven.push({ cat, mouse, k, dist: d });
            } else if (bandBudget > 0) {
              // d === k+1: the cert does NOT fire. Is there a shorter real route?
              bandBudget--;
              const truth = catWinThisTurn(probe);
              if (truth.win) missed.push({ cat, mouse, k, dist: d, path: truth.path });
            }
          } else if (d === undefined && pushOnlyBudget > 0 && isStandingCell(st, mouse)) {
            // Walk-unreachable: only a box push could get the cat there.
            pushOnlyBudget--;
            const truth = catWinThisTurn(probe);
            if (truth.win) pushOnly.push({ cat, mouse, k, path: truth.path });
          }
        }
      }
    }

    writeOut('p1c_cat_falsification.json', {
      section: 'P1-C cat naive certificate soundness / completeness',
      checked,
      fired,
      falseProvenCount: falseProven.length,
      falseProvenSamples: falseProven.slice(0, 10),
      nearMissBandChecked: 400 - bandBudget,
      missedCount: missed.length,
      missedSamples: missed.slice(0, 10),
      pushOnlyChecked: 400 - pushOnlyBudget,
      pushOnlyWinCount: pushOnly.length,
      pushOnlySamples: pushOnly.slice(0, 10),
      note: 'walk-only BFS excludes box pushes, so the certificate can only MISS wins, never invent them',
    });

    expect(falseProven.length).toBe(0);
    expect(fired).toBeGreaterThan(0);
  });

  it('P1-D: named fixtures (the cases from the brief) behave as classified', () => {
    const terrain = baseTerrain();
    const N = terrain.config.boardSize;

    // ---- (1) find a REAL trap dead-end: the trap must cut every route ----
    let trapCase: any = null;
    for (let r = 0; r < N && !trapCase; r++) {
      for (let c = 0; c < N && !trapCase; c++) {
        const m = { r, c };
        const clean = makeState({
          mousePosition: m,
          catPosition: { r: 0, c: 3 },
          mouseHasButter: true,
          currentPlayer: PieceType.Mouse,
          mouseMovesLeft: 4,
          catMovesLeft: 0,
          trapPosition: null,
        });
        const d = mouseCarryingDistanceToHole(clean);
        if (d === null || d < 2 || d > 4) continue;
        for (let tr = 0; tr < N && !trapCase; tr++) {
          for (let tc = 0; tc < N && !trapCase; tc++) {
            if (tr === r && tc === c) continue;
            const st = { ...clean, trapPosition: { r: tr, c: tc } } as GameEngineState;
            if (!naiveMouseCert(st).fires) continue;
            if (correctedMouseCertificate(st).proven) continue; // trap did not cut the route
            if (mouseWinThisTurn(st).win) continue;             // still a win somehow
            trapCase = { state: st, mouse: m, trap: { r: tr, c: tc }, dist: d };
          }
        }
      }
    }
    expect(trapCase).not.toBeNull();

    // ---- (2) same geometry, but the CAT sits on the cut cell ----
    const caseCatBlock = { ...trapCase.state, trapPosition: null, catPosition: trapCase.trap } as GameEngineState;

    // ---- (3) the mouse has no action right ----
    const caseNotTurn = makeState({
      mousePosition: trapCase.mouse,
      catPosition: { r: 0, c: 3 },
      mouseHasButter: true,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
      mouseMovesLeft: 0,
      trapPosition: null,
    });

    // ---- (4) carrying flag off ----
    const caseNoButter = { ...trapCase.state, mouseHasButter: false } as GameEngineState;

    // ---- (5) cat positive control: find a genuine adjacent capture ----
    let catKill: any = null;
    for (let r = 0; r < N && !catKill; r++) {
      for (let c = 0; c < N && !catKill; c++) {
        const st = makeState({
          catPosition: { r, c },
          mousePosition: { r: 0, c: 3 },
          currentPlayer: PieceType.Cat,
          catMovesLeft: 1,
          mouseMovesLeft: 0,
          trapPosition: null,
        });
        const ctx = createEvaluationContext(st);
        for (const d of DIRECTIONS) {
          const t = { r: r + d.dr, c: c + d.dc };
          if (t.r < 0 || t.c < 0 || t.r >= N || t.c >= N) continue;
          const dist = ctx.catMap.get(evaluationCellKey(t));
          if (dist !== 1) continue;
          const cand = { ...st, mousePosition: t } as GameEngineState;
          const truth = catWinThisTurn(cand);
          if (truth.win) {
            catKill = { state: cand, truth };
            break;
          }
        }
      }
    }
    expect(catKill).not.toBeNull();

    const out = {
      section: 'P1-D named fixtures',
      trapOnRoute: {
        mouse: trapCase.mouse,
        trap: trapCase.trap,
        cleanCarryDist: trapCase.dist,
        naive: naiveMouseCert(trapCase.state),
        corrected: correctedMouseCertificate(trapCase.state),
        truth: mouseWinThisTurn(trapCase.state),
      },
      catCorridorBlock: {
        catOnCutCell: trapCase.trap,
        naive: naiveMouseCert(caseCatBlock),
        truth: mouseWinThisTurn(caseCatBlock),
      },
      notMouseTurn: { naive: naiveMouseCert(caseNotTurn) },
      carryingGate: { naive: naiveMouseCert(caseNoButter), truth: mouseWinThisTurn(caseNoButter) },
      catAdjacent: { naive: naiveCatCert(catKill.state), truth: catKill.truth },
    };
    writeOut('p1d_named_fixtures.json', out);

    // (1) naive says PROVEN, the engine says NO WIN -> the core counterexample
    expect(out.trapOnRoute.naive.fires).toBe(true);
    expect(out.trapOnRoute.truth.win).toBe(false);
    expect(out.trapOnRoute.corrected.proven).toBe(false);

    // (2) the cat block is already handled correctly by the distance graph
    expect(out.catCorridorBlock.naive.fires).toBe(false);
    expect(out.catCorridorBlock.truth.win).toBe(false);

    // (3)(4) the gates must reject before any distance is consulted
    expect(out.notMouseTurn.naive.gated).toBe('not_mouse_turn');
    expect(out.carryingGate.naive.gated).toBe('no_butter');

    // (5) cat positive control
    expect(out.catAdjacent.naive.fires).toBe(true);
    expect(out.catAdjacent.truth.win).toBe(true);
  });

  it('P5-A: how boardSize=6 is actually applied decides whether S3 is even a legal game', () => {
    const raw = { ...DEFAULT_CONFIG, boardSize: 6 };
    const rawVerdict = validateGameConfig(raw);
    const rederived = withBoardSize(DEFAULT_CONFIG, 6);
    const rederivedVerdict = validateGameConfig(rederived);
    const size15 = withBoardSize(DEFAULT_CONFIG, 15);
    const size15Verdict = validateGameConfig(size15);

    writeOut('p5a_config_legality.json', {
      section: 'P5-A S3 boardSize application paths',
      rawMutation: {
        config: { boardSize: raw.boardSize, mouseHole: raw.mouseHole, boxCount: raw.boxCount, pileCount: raw.pileCount },
        ok: rawVerdict.ok,
        issues: rawVerdict.issues,
      },
      viaWithBoardSize: {
        config: { boardSize: rederived.boardSize, mouseHole: rederived.mouseHole, boxCount: rederived.boxCount, pileCount: rederived.pileCount },
        ok: rederivedVerdict.ok,
        issues: rederivedVerdict.issues,
      },
      size15: { ok: size15Verdict.ok, issues: size15Verdict.issues },
      note: 'withBoardSize re-derives hole/starts only while the layout is untouched default; raw mutation leaves S0 coordinates and is rejected',
    });

    expect(rawVerdict.ok).toBe(false); // S0 hole (7,8) does not fit a 6x6 board
  });

  it('P2-A: the certificate must key on BOARD terrain, not the config hole rect', () => {
    const base = makeState({});
    // Find a real hole cell and a legal neighbour.
    const holeR = base.config.mouseHole.r;
    const holeC = base.config.mouseHole.c;
    const neighbour = { r: holeR, c: holeC - 1 };

    // Synthetic map defect: the cell inside the configured rect is NOT a
    // MouseHole in the terrain. The engine will NOT award a win there.
    const board = base.board.map((row: any[]) => row.map((c) => ({ ...c })));
    board[holeR][holeC] = { type: 'empty' };

    const st = {
      ...base,
      board,
      mousePosition: neighbour,
      catPosition: { r: 0, c: 3 },
      mouseHasButter: true,
      currentPlayer: PieceType.Mouse,
      mouseMovesLeft: 1,
      catMovesLeft: 0,
      trapPosition: null,
    } as GameEngineState;

    const v1 = correctedMouseCertificate(st, 'config');
    const v2 = correctedMouseCertificate(st, 'board');
    const truth = mouseWinThisTurn(st);

    writeOut('p2a_map_divergence.json', {
      section: 'P2-A config-rect vs board-terrain hole divergence',
      configHole: base.config.mouseHole,
      boardCellType: board[holeR][holeC].type,
      configRectVariant: v1,
      boardTerrainVariant: v2,
      truth,
      note: 'the engine wins on targetCell.type === mouse_hole; the config rect is authoring intent only',
    });

    // The config-rect variant claims a win the engine does not award.
    expect(v1.proven).toBe(true);
    expect(truth.win).toBe(false);
    // Keying on terrain removes the false proof.
    expect(v2.proven).toBe(false);
  });

  it('P4: trigger coverage on the seven frozen real roots (depth-1 traversal)', () => {
    const perRoot: any[] = [];

    for (const label of ROOT_LABELS) {
      const root = rootState(label);
      const leaves: GameEngineState[] = [];
      const t0 = performance.now();

      const rec = (s: GameEngineState, guard: number) => {
        if (guard > 12) return;
        if (s.phase !== GamePhase.Playing) return;
        if (s.currentPlayer !== PieceType.Cat || s.catMovesLeft <= 0) {
          leaves.push(s);
          return;
        }
        const actions = generateLegalSearchActions(s, defaultRuleSet);
        for (const a of actions) {
          const res = simulateSearchAction(s, a, defaultRuleSet);
          const outs = res.kind === 'deterministic' ? [res.state] : res.outcomes.map((o) => o.state);
          for (const o of outs) rec(o, guard + 1);
        }
      };
      rec(root, 0);

      let mouseLeaves = 0;
      let catLeaves = 0;
      let carryingLeaves = 0;
      let naiveFire = 0;
      let correctedProven = 0;
      let catCertFires = 0;
      let engineWin = 0;
      let falseProven = 0;
      let missedByCorrected = 0;
      let truthCalls = 0;

      for (const lf of leaves) {
        if (lf.currentPlayer === PieceType.Mouse) mouseLeaves++;
        else if (lf.currentPlayer === PieceType.Cat) catLeaves++;
        const isMouseTurn = lf.currentPlayer === PieceType.Mouse && lf.mouseMovesLeft > 0;
        if (isMouseTurn && lf.mouseHasButter) carryingLeaves++;

        const nc = naiveMouseCert(lf);
        if (nc.fires) naiveFire++;
        const cc = correctedMouseCertificate(lf);
        if (cc.proven) correctedProven++;
        if (naiveCatCert(lf).fires) catCertFires++;

        // Ground truth only on certificate-relevant leaves plus a bounded
        // sample of near-miss leaves (the DFS is the expensive part).
        if (isMouseTurn && (nc.fires || cc.proven || (lf.mouseHasButter && truthCalls < 40))) {
          truthCalls++;
          const truth = mouseWinThisTurn(lf);
          if (truth.win) engineWin++;
          if (cc.proven && !truth.win) falseProven++;
          if (!cc.proven && truth.win) missedByCorrected++;
        }
      }

      perRoot.push({
        root: label,
        totalLeaves: leaves.length,
        mouseLeaves,
        catLeaves,
        carryingLeaves,
        naiveMouseCertFires: naiveFire,
        correctedProven,
        catCertFires,
        truthChecked: truthCalls,
        engineOneTurnWins: engineWin,
        falseProven,
        missedByCorrected,
        // true only if the certificate SEPARATES leaves of this root — i.e. it
        // could actually change which cat move the root planner prefers.
        discriminating: correctedProven > 0 && correctedProven < mouseLeaves,
        traversalMs: +(performance.now() - t0).toFixed(2),
      });
    }

    const discriminatingRoots = perRoot.filter((r) => r.discriminating).map((r) => r.root);
    writeOut('p4_coverage.json', {
      section: 'P4 trigger coverage, depth-1 traversal on frozen roots',
      totals: {
        leaves: perRoot.reduce((a, b) => a + b.totalLeaves, 0),
        mouseLeaves: perRoot.reduce((a, b) => a + b.mouseLeaves, 0),
        catLeaves: perRoot.reduce((a, b) => a + b.catLeaves, 0),
        correctedProven: perRoot.reduce((a, b) => a + b.correctedProven, 0),
        catCertFires: perRoot.reduce((a, b) => a + b.catCertFires, 0),
        falseProven: perRoot.reduce((a, b) => a + b.falseProven, 0),
      },
      discriminatingRoots,
      perRoot,
    });

    const totMouse = perRoot.reduce((a, b) => a + b.mouseLeaves, 0);
    const totCat = perRoot.reduce((a, b) => a + b.catLeaves, 0);
    expect(totMouse + totCat).toBeGreaterThan(0);
    expect(totCat).toBe(0); // frozen fixed-depth lane reported 453/453 mouse leaves
    expect(perRoot.every((r) => r.falseProven === 0)).toBe(true);
    // The cat-side certificate has no leaf to fire on at D1 at all.
    expect(perRoot.reduce((a, b) => a + b.catCertFires, 0)).toBe(0);
  });

  it('P4-cost: measured CPU cost per certificate check', () => {
    const base = rootState('G1T9_chance_mixed');
    const probe = {
      ...base,
      mouseHasButter: true,
      currentPlayer: PieceType.Mouse,
      mouseMovesLeft: 3,
      catMovesLeft: 0,
      phase: GamePhase.Playing,
      trapPosition: { r: 6, c: 7 },
    } as GameEngineState;

    const time = (fn: () => void, reps: number) => {
      fn(); // warm-up
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) fn();
      return (performance.now() - t0) / reps;
    };

    const preCtx = createEvaluationContext(probe);

    const gateOnly = time(() => {
      if (probe.phase !== GamePhase.Playing || probe.currentPlayer !== PieceType.Mouse) return;
      if (probe.mouseMovesLeft <= 0 || !probe.mouseHasButter) return;
    }, 20000);

    const mapLookup = time(() => {
      preCtx.carryHoleMap.get(evaluationCellKey(probe.mousePosition));
    }, 20000);

    const freshBfs = time(() => { mouseCarryingDistanceToHole(probe); }, 300);
    const ctxBuild = time(() => { createEvaluationContext(probe); }, 200);
    const corrected = time(() => { correctedMouseCertificate(probe); }, 300);
    const h1 = time(() => { evaluateForCat(probe); }, 200);

    const out = {
      section: 'P4 cost (single-thread, warm, this machine)',
      perCheckMs: {
        gateOnlyMs: +gateOnly.toFixed(5),
        reusedCarryHoleMapLookupMs: +mapLookup.toFixed(5),
        freshCarryingBfsMs: +freshBfs.toFixed(4),
        fullEvaluationContextMs: +ctxBuild.toFixed(4),
        correctedTrapAwareBfsMs: +corrected.toFixed(4),
        h1EvaluationMs: +h1.toFixed(4),
      },
      ratios: {
        correctedOverH1: +(corrected / h1).toFixed(3),
        freshBfsOverH1: +(freshBfs / h1).toFixed(3),
      },
      note: 'the lookup path reuses the H1 context carryHoleMap; the corrected path rebuilds one BFS and only when the gate fires',
    };
    writeOut('p4_cost.json', out);

    expect(mapLookup).toBeLessThan(freshBfs);
    expect(corrected).toBeGreaterThan(0);
  });

  it('P3: H1 is blind to a decided one-turn win', () => {
    const st = makeState({
      mousePosition: { r: 8, c: 7 },
      catPosition: { r: 0, c: 3 },
      mouseHasButter: true,
      currentPlayer: PieceType.Mouse,
      mouseMovesLeft: 2,
      catMovesLeft: 0,
      trapPosition: null,
    });
    const truth = mouseWinThisTurn(st);
    const ctx = createEvaluationContext(st);
    const carry = ctx.carryHoleMap.get(evaluationCellKey(st.mousePosition)) ?? null;
    const h1 = evaluateForCat(st);
    writeOut('p3_h1_blindness.json', {
      section: 'P3 H1 blindness to a decided one-turn win',
      truth,
      carryHoleDist: carry,
      mouseMovesLeft: st.mouseMovesLeft,
      h1ValueForCat: h1,
      mateScoreForCompare: 1_000_000,
      note: 'a decided MouseWins state is scored at H1 magnitude; the search only sees the mate if it simulates the remaining plies',
    });
    expect(truth.win).toBe(true);
    expect(Math.abs(h1)).toBeLessThan(100_000);
  });
});
