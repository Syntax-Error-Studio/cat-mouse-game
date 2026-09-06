/**
 * G0.4F-2B-1.2 — H1 corrected-hole leaf: production tests (P1-P14).
 *
 * P1  H1 exact formula (both-reachable corrected total == total-old+corrected)
 * P2  single-sided unchanged (H1 === evaluateForCat)
 * P3  G16 flip (C0 ULUL>UDRR, H1 UDRR>ULUL) on exact G16T8 boundaries
 * P4  G17 control (production H1 keeps DDDD in top half)
 * P5  G19 oracle-safe (production H1 D2 plan in F0.3 oracleSafePlans)
 * P6  G24 no RULTD / no full-turn loop under H1
 * P7  G4 no-regression margin (H1_MARGIN >= C0_MARGIN - 1e-12)
 * P8  tactical capture (F8 mate=cat under H1 search)
 * P9  immediate defense (T2 hole threat: mate != mouse, defensive plan)
 * P10 baseline exact unchanged (resolveHardLeaf('baseline') === evaluateForCat)
 * P11 ghost H1 finite (no eligibility gate; evaluates normally)
 * P12 debt H1 finite
 * P13 V2 numeric parity (refactor did NOT change V2: inline OLD math reference
 *     vs hybridRouteV2EvaluateForCat — maxAbsError must be 0)
 * P14 default mode is baseline
 *
 * Read-only against ai-training data files (same precedent as
 * hybridRouteLeaf.test.ts / hybridGhostDomainSafety.test.ts). No src/ change
 * beyond this test file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInitialState, createEngineRuleSet, type GameEngineState } from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty, PieceType, GamePhase, DIRECTIONS, CellType, type Direction } from '../../types';
import type { SearchAction } from '../searchTypes';
import { evaluateForCat, evaluateForCatDetailed } from '../evaluation';
import { evaluateCorrectedHoleForCat, correctedHoleEvalTotal } from '../correctedHoleLeaf';
import {
  hybridRouteV2EvaluateForCat,
} from '../hybridRouteLeaf';
import { productionValueNet, resolveHardLeaf, setHardLeafMode, getHardLeafMode } from '../hybridLeaf';
import { HARD_LEAF_MODE_CONFIG, HARD_LEAF_MODE_DEFAULT } from '../searchConfig';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { enumerateFullTurnLegacy } from '../turnBoundary';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { HYBRID_S } from '../hybridWeights';
import { planHardCatTurn } from '../hardTurnPlanner';

const rules = createEngineRuleSet();
const label = (a: SearchAction): string => a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?';

/** Restore a game turn root from the F0 timeline SNAPSHOT_JSON authority. */
function restoreTurnRoot(game: number, turn: number): GameEngineState {
  const t = JSON.parse(readFileSync('ai-training/f0/f0_timelines.json', 'utf8'));
  const entry = t[String(game)].turns.find((x: { turn: number }) => x.turn === turn);
  expect(entry).toBeTruthy();
  return restoreHardRoot(entry.root as HardRootSnapshot);
}

/** G4 GOOD/BAD boundary snapshots from the frozen corpus. */
function g4Boundaries(): { good: GameEngineState; bad: GameEngineState } {
  const lines = readFileSync('ai-training/d01/exact_teacher_audit_roots.ndjson', 'utf8').trim().split('\n').filter((l: string) => l.length > 0);
  let goodSnap: HardRootSnapshot | null = null, badSnap: HardRootSnapshot | null = null;
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.source === 'G4_GOOD_boundary') goodSnap = rec.snapshot as HardRootSnapshot;
    else if (rec.source === 'G4_BAD_boundary') badSnap = rec.snapshot as HardRootSnapshot;
  }
  expect(goodSnap).toBeTruthy();
  expect(badSnap).toBeTruthy();
  return { good: restoreHardRoot(goodSnap!), bad: restoreHardRoot(badSnap!) };
}

const DIR_BY_CHAR: Record<string, Direction> = {
  U: DIRECTIONS.find((d) => d.key === 'ArrowUp')!,
  D: DIRECTIONS.find((d) => d.key === 'ArrowDown')!,
  L: DIRECTIONS.find((d) => d.key === 'ArrowLeft')!,
  R: DIRECTIONS.find((d) => d.key === 'ArrowRight')!,
};

function replayPlan(root: GameEngineState, tokens: string[]): GameEngineState {
  let cur = root;
  for (const tok of tokens) {
    const a: SearchAction = tok === 'T' ? { type: 'catPlaceTrap' } : { type: 'catStep', direction: DIR_BY_CHAR[tok] };
    const r = simulateSearchAction(cur, a, rules);
    if (r.kind === 'chance') break;
    cur = r.state;
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return cur;
}

function freshCanonical(): GameEngineState {
  return createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard } as Parameters<typeof createInitialState>[0]);
}

/** Clean deterministic canonical-hard state (all non-corner/non-hole empty). */
function cleanCanonical(): GameEngineState {
  const s = freshCanonical();
  const board = s.board.map((row, r) => row.map((cell, c) => {
    const isTunnel = (r === 0 && (c === 0 || c === 9)) || (r === 9 && (c === 0 || c === 9));
    const isHole = r >= 7 && r <= 8 && c >= 8 && c <= 9;
    const type = isTunnel ? CellType.Tunnel : isHole ? CellType.MouseHole : CellType.Empty;
    return { ...cell, type, piece: undefined as PieceType | undefined, hasButter: false };
  }));
  return { ...s, board };
}

/** Place cat/mouse/butter/ghost/debt/boxes explicitly on a clean canonical board. */
function buildState(opts: {
  cat: [number, number]; mouse: [number, number]; butter?: [number, number][];
  ghost?: { r: number; c: number; blockedMaterializations?: number }[]; debt?: number;
  box?: [number, number][]; mouseHasButter?: boolean;
}): GameEngineState {
  const s = cleanCanonical();
  const b = s.board.map(row => row.map(cell => ({ ...cell, piece: undefined as PieceType | undefined })));
  for (const [r, c] of opts.box ?? []) b[r][c] = { ...b[r][c], type: CellType.Box };
  b[opts.cat[0]][opts.cat[1]] = { ...b[opts.cat[0]][opts.cat[1]], piece: PieceType.Cat };
  b[opts.mouse[0]][opts.mouse[1]] = { ...b[opts.mouse[0]][opts.mouse[1]], piece: PieceType.Mouse };
  return {
    ...s, board: b,
    catPosition: { r: opts.cat[0], c: opts.cat[1] },
    mousePosition: { r: opts.mouse[0], c: opts.mouse[1] },
    butterPositions: (opts.butter ?? []).map(([r, c]) => ({ r, c })),
    pendingButterSpawns: (opts.ghost ?? []).map(g => ({ r: g.r, c: g.c, blockedMaterializations: g.blockedMaterializations ?? 0 })),
    pendingButterPlacementDebt: opts.debt ?? 0,
    currentPlayer: PieceType.Cat,
    phase: GamePhase.Playing,
    catMovesLeft: s.config.catBaseMoves,
    mouseMovesLeft: s.config.mouseBaseMoves,
    mouseHasButter: opts.mouseHasButter ?? false,
  };
}

/** Production H1 leaf via the resolver (single source = config mode). */
function productionH1Leaf(s: GameEngineState): number {
  setHardLeafMode('baseline_hole_corrected');
  return resolveHardLeaf()(s);
}

/** Run planHardCatTurn-equivalent search with the production H1 leaf (resolver). */
function searchWithH1(root: GameEngineState, depth: number) {
  const leaf = resolveHardLeaf(); // reads current mode
  return planHardCatTurn(root, {
    rules, timeBudgetMs: 600000, maxDepthTurns: depth, maxNodes: 2_000_000,
    leafEvaluator: leaf, refutation: { enabled: false },
  });
}

describe('G0.4F-2B-1.2 H1 corrected-hole leaf', () => {
  beforeEach(() => setHardLeafMode('baseline'));

  it('P1: H1 exact formula — corrected total == total − old + corrected (both-reachable)', () => {
    const { good } = g4Boundaries(); // G4 GOOD cat(3,7)/mouse(4,7) — both reach gates
    const bd = evaluateForCatDetailed(good);
    expect(bd.features.catHoleGateDistance).not.toBeNull();
    expect(bd.features.mouseHoleGateDistance).not.toBeNull();
    const expected = correctedHoleEvalTotal(bd, good.config.boardSize);
    expect(evaluateCorrectedHoleForCat(good)).toBe(expected);
    // exact value frozen from F2B-1.1 authority (H1 GOOD = -516.4473684210527)
    expect(evaluateCorrectedHoleForCat(good)).toBeCloseTo(-516.4473684210527, 9);
  });

  it('P2: single-sided unchanged — H1 === evaluateForCat', () => {
    // mouse fully enclosed by boxes at (1,1) → cannot reach any hole gate
    const st = buildState({ cat: [3, 6], mouse: [1, 1], box: [[0, 1], [1, 0], [2, 1], [1, 2]] });
    const bd = evaluateForCatDetailed(st);
    // assert single-sided (mouse cannot reach gate)
    expect(bd.features.mouseHoleGateDistance).toBeNull();
    expect(evaluateCorrectedHoleForCat(st)).toBe(evaluateForCat(st));
  });

  it('P3: G16 flip — C0 ULUL>UDRR, H1 UDRR>ULUL (exact G16T8 boundaries)', () => {
    const root = restoreTurnRoot(16, 8);
    const ulul = replayPlan(root, ['U', 'L', 'U', 'L']);
    const udrr = replayPlan(root, ['U', 'D', 'R', 'R']);
    expect(evaluateForCat(ulul)).toBeGreaterThan(evaluateForCat(udrr)); // C0 misrank
    expect(evaluateCorrectedHoleForCat(ulul)).toBeCloseTo(-540.8421052631579, 9);
    expect(evaluateCorrectedHoleForCat(udrr)).toBeCloseTo(-490.97368421052636, 9);
    expect(evaluateCorrectedHoleForCat(udrr)).toBeGreaterThan(evaluateCorrectedHoleForCat(ulul)); // H1 flip
  });

  it('P4: G17 control — production H1 keeps DDDD in top half', () => {
    const root = restoreTurnRoot(17, 2);
    const prodBoundary = replayPlan(root, ['D', 'D', 'D', 'D']);
    const prodKey = stateKey(prodBoundary);
    const ends = enumerateFullTurnLegacy(root, rules);
    const seen = new Set<string>();
    const scores: number[] = [];
    let prodScore: number | null = null;
    for (const b of ends.boundaries) {
      const k = stateKey(b.state);
      if (seen.has(k)) continue;
      seen.add(k);
      const s = productionH1Leaf(b.state);
      scores.push(s);
      if (k === prodKey) prodScore = s;
    }
    expect(prodScore).not.toBeNull();
    const rank = scores.filter((s) => s > prodScore!).length + 1;
    expect(rank).toBeLessThanOrEqual(Math.ceil(scores.length / 2));
  });

  it('P5: G19 oracle-safe — production H1 D2 plan in F0.3 oracleSafePlans', () => {
    const f03 = JSON.parse(readFileSync('ai-training/f03/threat_onset.json', 'utf8'));
    const authority: string[] = f03.games['G19_T7_ENUM'].oracleSafePlans.map((p: { witness: string }) => p.witness);
    expect(authority).toContain('RRRD');
    const root = restoreTurnRoot(19, 7);
    setHardLeafMode('baseline_hole_corrected');
    const res = searchWithH1(root, 2);
    const plan = res.plan.map(label).join('');
    expect(authority).toContain(plan);
  });

  it('P6: G24 no RULTD / no full-turn loop under H1', () => {
    const root = restoreTurnRoot(24, 1);
    setHardLeafMode('baseline_hole_corrected');
    const res = searchWithH1(root, 2);
    const plan = res.plan.map(label).join('');
    expect(plan).not.toBe('RULTD');
    // full-turn loop check: endCat back at start with >=4 steps
    const acts = res.plan.filter((a) => a.type === 'catStep');
    let cur = root;
    for (const a of acts) {
      const tr = simulateSearchAction(cur, a, rules);
      if (tr.kind !== 'deterministic') break;
      cur = tr.state;
      if (cur.currentPlayer !== PieceType.Cat || cur.phase !== GamePhase.Playing) break;
    }
    const loop = acts.length >= 4 && cur.catPosition.r === root.catPosition.r && cur.catPosition.c === root.catPosition.c;
    expect(loop).toBe(false);
  });

  it('P7: G4 no-regression margin (H1_MARGIN >= C0_MARGIN - 1e-12)', () => {
    const { good, bad } = g4Boundaries();
    const c0Good = evaluateForCat(good), c0Bad = evaluateForCat(bad);
    const h1Good = evaluateCorrectedHoleForCat(good), h1Bad = evaluateCorrectedHoleForCat(bad);
    const c0Margin = c0Good - c0Bad;
    const h1Margin = h1Good - h1Bad;
    expect(c0Margin).toBeCloseTo(-462.5, 9);
    expect(h1Margin).toBeGreaterThanOrEqual(c0Margin - 1e-12);
    expect(h1Margin).toBeCloseTo(-262.5, 9);
  });

  it('P8: tactical capture — F8 immediate cat capture stays mate=cat under H1', () => {
    const root = buildState({ cat: [4, 4], mouse: [4, 5] }); // F8: adjacent capture
    setHardLeafMode('baseline_hole_corrected');
    const res = searchWithH1(root, 2);
    expect(res.search.mate).toBe('cat');
    expect(res.plan.map(label).join('')).toBe('R');
  });

  it('P9: immediate defense — T2 hole threat: H1 does not abandon defense (D1)', () => {
    // mouse carrying near hole (7,8)-(8,9), 1 step from gate; cat far. Under
    // the F2B-1.1 TACTICAL gate semantics we verify the cat's DEFENSIVE plan at
    // D1 (a completed single cat turn does not search the mouse's winning
    // reply, so mate is null — NOT 'mouse'). H1 must pick the same defensive
    // plan as baseline (rush toward the mouse/hole), never an unrelated layout.
    const root = buildState({ cat: [1, 1], mouse: [6, 8], butter: [[5, 8]], mouseHasButter: true });
    // baseline D1 reference (F2B-1.1 authority: DDRTR, mate=null)
    const base = planHardCatTurn(root, { rules, timeBudgetMs: 600000, maxDepthTurns: 1, maxNodes: 2_000_000, leafEvaluator: evaluateForCat, refutation: { enabled: false } });
    expect(base.plan.map(label).join('')).toBe('DDRTR');
    expect(base.search.mate).toBeNull();
    // production H1 D1
    setHardLeafMode('baseline_hole_corrected');
    const h1 = searchWithH1(root, 1);
    expect(h1.search.mate).not.toBe('mouse');
    expect(h1.plan.map(label).join('')).toBe('DDRTR'); // same defensive plan, not abandoned
    expect(h1.plan.length).toBeGreaterThan(0);
  });

  it('P10: baseline exact unchanged — resolveHardLeaf(baseline) === evaluateForCat', () => {
    setHardLeafMode('baseline');
    expect(getHardLeafMode()).toBe('baseline');
    expect(resolveHardLeaf()).toBe(evaluateForCat);
    // a real search under baseline leaf is byte-identical to explicit evaluateForCat
    const root = restoreTurnRoot(16, 8);
    const a = planHardCatTurn(root, { rules, timeBudgetMs: 100, maxDepthTurns: 1, leafEvaluator: evaluateForCat, refutation: { enabled: false } });
    setHardLeafMode('baseline');
    const b = planHardCatTurn(root, { rules, timeBudgetMs: 100, maxDepthTurns: 1, leafEvaluator: resolveHardLeaf(), refutation: { enabled: false } });
    expect(a.plan.map(label).join('')).toBe(b.plan.map(label).join(''));
    expect(a.search.value).toBe(b.search.value);
    expect(a.search.mate).toBe(b.search.mate);
  });

  it('P11: ghost H1 finite — no eligibility gate, evaluates normally', () => {
    const st = buildState({ cat: [3, 3], mouse: [8, 2], butter: [[2, 8]], ghost: [{ r: 8, c: 3, blockedMaterializations: 0 }] });
    // H1 must evaluate ghost states (no isHybridEligibleState gate)
    const v = evaluateCorrectedHoleForCat(st);
    expect(Number.isFinite(v)).toBe(true);
    // and it is allowed to differ from baseline (ghost present affects nothing in
    // H1 itself, so it should equal the plain heuristic on the SAME state without
    // ghost — ghost is non-blocking and invisible to the heuristic).
    const stNoGhost = { ...st, pendingButterSpawns: [] };
    expect(v).toBe(evaluateCorrectedHoleForCat(stNoGhost));
  });

  it('P12: debt H1 finite', () => {
    const st = buildState({ cat: [3, 3], mouse: [8, 2], butter: [[2, 8]], debt: 2 });
    expect(Number.isFinite(evaluateCorrectedHoleForCat(st))).toBe(true);
  });

  it('P13: V2 numeric parity — refactor did NOT change V2 (inline OLD math reference, maxAbsError=0)', () => {
    // Re-implement the PRE-refactor V2 math inline (the exact arithmetic that
    // used to live in evaluateHybridRouteV2Eligible) and compare against the
    // current production hybridRouteV2EvaluateForCat on eligible states.
    function oldV2Math(state: GameEngineState): number {
      if (!state) throw new Error('no state');
      const bd = evaluateForCatDetailed(state);
      const total = bd.total;
      const oldHoleControl = bd.contributions.holeControl;
      const { catHoleGateDistance, mouseHoleGateDistance, mouseWinRouteDistance, mouseHasButter } = bd.features;
      const boardSize = state.config.boardSize;
      let correctedHoleControl: number;
      if (catHoleGateDistance !== null && mouseHoleGateDistance !== null) {
        const margin = mouseHoleGateDistance - catHoleGateDistance;
        correctedHoleControl = Math.max(-1, Math.min(1, margin / boardSize)) * 500; // DEFAULT_EVALUATION_WEIGHTS.holeControl
      } else {
        correctedHoleControl = oldHoleControl;
      }
      const correctedEval = total - oldHoleControl + correctedHoleControl;
      let routeContribution: number;
      if (mouseHasButter) routeContribution = 0;
      else if (mouseWinRouteDistance === null) routeContribution = 1;
      else {
        const norm = Math.max(0, Math.min(1, mouseWinRouteDistance / (2 * boardSize)));
        routeContribution = -(1 - norm);
      }
      const v = productionValueNet(state);
      return 0.5 * Math.tanh(correctedEval / HYBRID_S) + 0.5 * v + 0.05 * routeContribution;
    }
    // eligible-state corpus: G4 GOOD/BAD, G19 end states, G17 pair, G16/G24
    // replayed boundaries + a few canonical roots.
    const states: GameEngineState[] = [];
    const { good, bad } = g4Boundaries();
    states.push(good, bad);
    const g19root = restoreTurnRoot(19, 7);
    for (const plan of [['U', 'U', 'D', 'D'], ['R', 'R', 'R', 'D']]) states.push(replayPlan(g19root, plan));
    const g17root = restoreTurnRoot(17, 2);
    states.push(replayPlan(g17root, ['D', 'D', 'D', 'D']));
    states.push(freshCanonical());
    // dedupe by stateKey and keep only eligible states
    const seen = new Set<string>();
    let n = 0, maxErr = 0;
    for (const s of states) {
      const k = stateKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = hybridRouteV2EvaluateForCat(s);
      if (cur !== evaluateForCat(s)) {
        // only eligible states should use V2; for eligible ones compare to OLD math
        const ref = oldV2Math(s);
        const err = Math.abs(cur - ref);
        maxErr = Math.max(maxErr, err);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
    expect(maxErr).toBe(0); // exact, NOT approximate
  });

  it('P14: default mode is baseline', () => {
    expect(HARD_LEAF_MODE_DEFAULT).toBe('baseline');
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
    expect(getHardLeafMode()).toBe('baseline');
  });
});
