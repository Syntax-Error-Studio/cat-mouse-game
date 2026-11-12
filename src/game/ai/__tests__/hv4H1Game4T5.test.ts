/// <reference types="node" />
/**
 * PPC-HV-4 §3/§4 — the REAL H1 GAME 4 log: provenance + T5 tactical chance.
 *
 * The evidence file is the user's own human-game export
 * (ai-training/human-logs/PPC-HV4/PPC_HV3_GAME4_H1_ORIGINAL.txt). Nothing here
 * reconstructs or substitutes a root: every turn is parsed out of the TXT,
 * restored with the project's existing `restoreHardRoot`, and re-hashed against
 * the STATE_KEY line the player's own client printed.
 *
 * §4 answers one question on the Turn #5 board with the REAL engine step
 * functions, and keeps three propositions apart:
 *   LEGAL_INTERCEPTION_EXISTS / IMMEDIATE_MOUSE_WIN_PREVENTABLE /
 *   LONG_TERM_CAT_SURVIVAL_PROVEN.
 *
 * Soundness direction of every model used here:
 *   - the mouse line is computed with the cat given NO moves (optimistic for the
 *     mouse ⇒ a LOWER bound on its win clock);
 *   - the cat's power is computed by EXACT enumeration of its legal move
 *     sequences over 1-2 turns with the mouse frozen (⇒ an UPPER bound on what
 *     the cat can do, because a moving mouse can only make interception
 *     harder), plus a relaxed-graph Manhattan-style lower bound on the moves it
 *     needs. So "the cat cannot be there in time" is proven against a cat that
 *     is stronger than any real one.
 * Cost: a few thousand engine step calls, zero search, zero chance oracle.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  catMove,
  catPlaceTrap,
  endTurn,
  mouseStepDeterministic,
  setWorldEntropySource,
} from '../../engine';
import type { GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { stateKey } from '../transposition';

const LOG_URL = new URL(
  '../../../../ai-training/human-logs/PPC-HV4/PPC_HV3_GAME4_H1_ORIGINAL.txt',
  import.meta.url,
);
/** Declared by PPC_HV4/README.txt beside the extracted original. */
const DECLARED_SHA256 = '25d048b581a2d6712138ebe38c923fa39b797ab66c451552acf4edacf98f149a';
const DECLARED_BYTES = 45409;

interface TurnRecord {
  turn: number;
  stateKey: string;
  snapshot: HardRootSnapshot;
  state: GameEngineState;
  loggedCat: string;
  loggedMouse: string;
  loggedButter: string;
  loggedMoves: string;
  loggedTrap: string;
  loggedSearch: string;
  loggedPlanStatus: string;
  loggedRootValue: string;
  loggedRootActions: string[];
  loggedPlan: string;
  loggedBaseline: string;
  loggedFinalPlan: string;
  loggedRefutation: string[];
}

function parseTurns(text: string): TurnRecord[] {
  const lines = text.split(/\r?\n/);
  const out: TurnRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^Turn #(\d+)\s*$/.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const turn = Number(m[1]);
    const block: string[] = [];
    let j = i + 1;
    while (j < lines.length && !/^Turn #\d+\s*$/.test(lines[j])) {
      block.push(lines[j]);
      j++;
    }
    const find = (prefix: string): string =>
      block.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
    const snapLine = block.find((l) => l.startsWith('SNAPSHOT_JSON='));
    if (!snapLine) throw new Error(`Turn #${turn} has no SNAPSHOT_JSON line`);
    const snapshot = JSON.parse(snapLine.slice('SNAPSHOT_JSON='.length)) as HardRootSnapshot;
    const raStart = block.findIndex((l) => l.trim() === 'ROOT_ACTIONS:');
    out.push({
      turn,
      stateKey: find('STATE_KEY='),
      snapshot,
      state: restoreHardRoot(snapshot),
      loggedCat: find('cat='),
      loggedMouse: find('mouse='),
      loggedButter: find('butter='),
      loggedMoves: find('catMoves='),
      loggedTrap: find('trap='),
      loggedSearch: find('SEARCH:'),
      loggedPlanStatus: find('PLAN_STATUS='),
      loggedRootValue: find('ROOT_VALUE='),
      loggedRootActions: block
        .slice(raStart + 1)
        .filter((l) => /^\s+\S+: value=/.test(l))
        .map((l) => l.trim()),
      loggedPlan: find('PLAN:'),
      loggedBaseline: find('  BASELINE_PLAN='),
      loggedFinalPlan: find('  FINAL_PLAN='),
      loggedRefutation: block.filter((l) =>
        /^(REFUTATION:|  baselineProbeStatus=|  candidateStatuses=|  overrideEligible=|  fallbackUsed=)/.test(l),
      ),
    });
    i = j;
  }
  return out;
}

let cachedTurns: TurnRecord[] | null = null;
function loadLog(): TurnRecord[] {
  if (!cachedTurns) cachedTurns = parseTurns(readFileSync(LOG_URL, 'utf8'));
  return cachedTurns;
}
const turnOf = (n: number): TurnRecord => loadLog().find((t) => t.turn === n)!;

const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;
/** The log prints coordinates parenthesised — `cat=(2,2)`, `trap=(1,1) remain=0`. */
const bare = (s: string): string => s.replace(/[()]/g, '');
const eq = (a: { r: number; c: number }, b: { r: number; c: number }): boolean => a.r === b.r && a.c === b.c;
const manhattan = (a: { r: number; c: number }, b: { r: number; c: number }): number =>
  Math.abs(a.r - b.r) + Math.abs(a.c - b.c);

function boardText(s: GameEngineState): string {
  const rows: string[] = [];
  for (let r = 0; r < s.config.boardSize; r++) {
    let line = '';
    for (let c = 0; c < s.config.boardSize; c++) {
      const cell = s.board[r][c];
      line += cell.piece === PieceType.Cat ? 'C'
        : cell.piece === PieceType.Mouse ? 'M'
          : cell.type === CellType.MouseHole ? 'H'
            : cell.type === CellType.Tunnel ? 'T'
              : cell.type === CellType.Wall ? '#'
                : cell.type === CellType.Box ? 'B'
                  : cell.type === CellType.Pile ? 'p'
                    : s.trapPosition && s.trapPosition.r === r && s.trapPosition.c === c ? 'X'
                      : s.butterPositions.some((b) => b.r === r && b.c === c) ? 'b' : '.';
    }
    rows.push(line);
  }
  return rows.join('\n');
}

function holeCells(s: GameEngineState): { r: number; c: number }[] {
  const h = s.config.mouseHole;
  const out: { r: number; c: number }[] = [];
  for (let r = h.r; r < h.r + h.size; r++) for (let c = h.c; c < h.c + h.size; c++) out.push({ r, c });
  return out;
}

/** The mouse turn as it starts right after this cat root, cat playing nothing. */
function mouseTurnFrom(s: GameEngineState): GameEngineState {
  return {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: s.mouseHasButter ? s.config.mouseCarryingMoves : s.config.mouseBaseMoves,
    catMovesLeft: s.config.catBaseMoves,
  };
}

interface ReachResult {
  dist: Map<string, number>;
  parent: Map<string, string>;
  states: Map<string, GameEngineState>;
  winAtStep: Map<string, number>;
  expanded: number;
}

/**
 * BFS over the REAL mouse step function (`mouseStepDeterministic`): pushes,
 * traps, tunnel rules and the win test are the engine's own. When the mouse's
 * budget runs out the engine hands the turn over; this probe re-grants the
 * per-turn budget without letting the cat move, so `dist` is a LOWER bound on
 * the mouse's win clock.
 */
function mouseReach(root: GameEngineState, maxSteps: number): ReachResult {
  const dist = new Map<string, number>();
  const parent = new Map<string, string>();
  const states = new Map<string, GameEngineState>();
  const winAtStep = new Map<string, number>();
  const startPos = rc(root.mousePosition);
  dist.set(startPos, 0);
  states.set(startPos, root);
  let frontier = [{ pos: startPos, state: root }];
  let expanded = 0;
  for (let step = 1; step <= maxSteps; step++) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      expanded++;
      for (const dir of DIRECTIONS) {
        const moved = mouseStepDeterministic(node.state, dir);
        const won = moved.phase === GamePhase.MouseWins;
        if (!won && eq(moved.mousePosition, node.state.mousePosition)) continue;
        const pos = rc(moved.mousePosition);
        if (won && !winAtStep.has(pos)) winAtStep.set(pos, step);
        let s = moved;
        if (s.currentPlayer !== PieceType.Mouse || s.mouseMovesLeft <= 0) {
          s = {
            ...s,
            currentPlayer: PieceType.Mouse,
            mouseMovesLeft: s.mouseHasButter ? s.config.mouseCarryingMoves : s.config.mouseBaseMoves,
          };
        }
        if (!dist.has(pos)) {
          dist.set(pos, step);
          parent.set(pos, node.pos);
          states.set(pos, s);
          if (!won) next.push({ pos, state: s });
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return { dist, parent, states, winAtStep, expanded };
}

function routeOf(reach: ReachResult, target: string): string[] {
  const out: string[] = [];
  let cur: string | undefined = target;
  while (cur !== undefined) {
    out.unshift(cur);
    cur = reach.parent.get(cur);
  }
  return out;
}

/**
 * EXACT enumeration of one cat turn: every cell the cat can stand on at any
 * point of the turn, plus the states the turn can end in. `catMove` is the real
 * engine, so illegal targets (wall/box-limit/pile/butter/tunnel/hole), box
 * pushes and the capture test are the game's own.
 *
 * Trap placement is NOT simulated: because placing costs no step and happens on
 * the cat's own cell, `occupied` is already an UPPER bound on the cells the cat
 * can trap this turn (it ignores that Hard starts a turn with `catTrapsRemaining
 * = 0` and must first walk onto the standing trap to recycle it). A mouse that
 * is safe against `occupied` is therefore safe against every legal cat plan.
 */
function catTurnReach(
  starts: GameEngineState[],
  nodeCap = 200_000,
): {
  occupied: Set<string>;
  endStates: Map<string, GameEngineState>;
  captured: boolean;
  nodes: number;
} {
  const seen = new Map<string, GameEngineState>();
  const endStates = new Map<string, GameEngineState>();
  const occupied = new Set<string>();
  let captured = false;
  let nodes = 0;
  const stack = [...starts];
  while (stack.length > 0 && nodes < nodeCap) {
    const cur = stack.pop()!;
    const k = stateKey(cur);
    if (seen.has(k)) continue;
    seen.set(k, cur);
    nodes++;
    occupied.add(rc(cur.catPosition));
    let extended = false;
    for (const dir of DIRECTIONS) {
      const moved = catMove(cur, dir);
      if (eq(moved.catPosition, cur.catPosition)) continue;
      if (moved.phase === GamePhase.CatWins) {
        captured = true;
        continue;
      }
      if (moved.currentPlayer === PieceType.Cat && moved.catMovesLeft > 0) {
        stack.push(moved);
        extended = true;
      } else {
        endStates.set(stateKey(moved), moved);
      }
    }
    // no legal step left with moves still in the bank: this is a turn end too
    if (!extended) endStates.set(k, cur);
  }
  for (const s of endStates.values()) occupied.add(rc(s.catPosition));
  return { occupied, endStates, captured, nodes };
}

/**
 * The same enumeration chained over `turns` cat turns, with the real hand-off
 * between them (ghost butter materialises, budget reloads). The mouse is a
 * passenger: `mouseAtTurn[t]` says where to place it before turn t is expanded,
 * which is what makes the capture/transit test exact for a chosen mouse line
 * instead of assuming the mouse never leaves its root cell.
 */
function catOccupiableByTurn(
  root: GameEngineState,
  turns: number,
  mouseAtTurn?: (t: number) => { r: number; c: number } | null,
  nodeCap = 200_000,
): { sets: Set<string>[]; nodes: number; captureTurns: number[]; endStatesByTurn: Map<string, GameEngineState>[] } {
  const sets: Set<string>[] = [];
  const endStatesByTurn: Map<string, GameEngineState>[] = [];
  const captureTurns: number[] = [];
  let starts = [root];
  let nodes = 0;
  for (let t = 0; t < turns; t++) {
    const cell = mouseAtTurn?.(t);
    const input = cell ? starts.map((s) => ({ ...s, mousePosition: { ...cell } })) : starts;
    const reach = catTurnReach(input, nodeCap);
    nodes += reach.nodes;
    sets.push(reach.occupied);
    endStatesByTurn.push(reach.endStates);
    if (reach.captured) captureTurns.push(t + 1);
    const next = new Map<string, GameEngineState>();
    for (const s of reach.endStates.values()) {
      const started = nextCatTurnStart(s);
      next.set(stateKey(started), started);
    }
    starts = [...next.values()];
  }
  return { sets, nodes, captureTurns, endStatesByTurn };
}

/** Cells whose terrain or piece differs between two states (box pushes show up here). */
function boardDiff(a: GameEngineState, b: GameEngineState): string[] {
  const out: string[] = [];
  for (let r = 0; r < a.config.boardSize; r++) {
    for (let c = 0; c < a.config.boardSize; c++) {
      if (r === a.mousePosition.r && c === a.mousePosition.c) continue;
      if (r === b.mousePosition.r && c === b.mousePosition.c) continue;
      const x = a.board[r][c];
      const y = b.board[r][c];
      if (x.type !== y.type || x.piece !== y.piece) out.push(`${r},${c}:${x.type}${x.piece ?? '-'}/${y.type}${y.piece ?? '-'}`);
    }
  }
  return out;
}

/** Hand-off bookkeeping: cat turn over → mouse turn (no moves) → cat turn on. */
function nextCatTurnStart(s: GameEngineState): GameEngineState {
  if (s.phase !== GamePhase.Playing) return s;
  const toMouse = endTurn({ ...s, currentPlayer: PieceType.Cat });
  const backToCat = endTurn({ ...toMouse, mouseMovesLeft: 0, currentPlayer: PieceType.Mouse });
  return {
    ...backToCat,
    currentPlayer: PieceType.Cat,
    catMovesLeft: s.config.catBaseMoves,
    phase: GamePhase.Playing,
  };
}

/** Replay a printed plan line ("catStep ArrowUp → catPlaceTrap → …"). */
function executeLoggedPlan(root: GameEngineState, planLine: string): { end: GameEngineState; path: string[] } {
  let s = root;
  const path = [rc(root.catPosition)];
  for (const raw of planLine.split('→').map((x) => x.trim())) {
    if (raw === 'catPlaceTrap') {
      s = catPlaceTrap(s);
      path.push('Trap');
    } else {
      const key = raw.replace('catStep', '').trim();
      const dir = DIRECTIONS.find((d) => d.key === key);
      if (!dir) throw new Error(`unknown plan token "${raw}"`);
      s = catMove(s, dir as Direction);
      path.push(rc(s.catPosition));
    }
  }
  return { end: s, path };
}

// ===========================================================================
// HV4-E1 — the evidence file is the original the user sent, unmodified.
// ===========================================================================
test('HV4-E1. the TXT matches its declared digest and byte size', () => {
  const buf = readFileSync(LOG_URL);
  expect(createHash('sha256').update(buf).digest('hex'), 'original TXT sha256').toBe(DECLARED_SHA256);
  expect(buf.length, 'original TXT bytes').toBe(DECLARED_BYTES);
});

// ===========================================================================
// HV4-E2 — provenance: every turn restores through the project loader and
// re-hashes to the STATE_KEY the player's own client printed.
// ===========================================================================
test('HV4-E2. all six H1 turns restore to their logged STATE_KEY', () => {
  const turns = loadLog();
  expect(turns.map((t) => t.turn), 'turn numbers present').toEqual([1, 2, 3, 4, 5, 6]);
  for (const t of turns) {
    expect(t.stateKey.length > 0, `Turn #${t.turn} STATE_KEY line`).toBe(true);
    expect(stateKey(t.state), `Turn #${t.turn} stateKey round-trip`).toBe(t.stateKey);
  }
});

test('HV4-E3. restored Turn #5 fields agree with the printed log lines', () => {
  const t = turnOf(5);
  const s = t.state;
  expect(`${s.catPosition.r},${s.catPosition.c}`, 'cat').toBe(t.loggedCat.slice(1, -1));
  expect(`${s.mousePosition.r},${s.mousePosition.c}`, 'mouse').toBe(t.loggedMouse.slice(1, -1));
  // `find(prefix)` strips the prefix, so the expected strings carry only what
  // follows `butter=` / `catMoves=` / `trap=` in the printed line.
  expect(`${s.mouseHasButter} skill=${s.mouseSkillActive}`, 'butter').toBe(t.loggedButter);
  expect(`${s.catMovesLeft} mouseMoves=${s.mouseMovesLeft}`, 'moves').toBe(t.loggedMoves);
  expect(`${s.trapPosition ? rc(s.trapPosition) : 'none'} remain=${s.catTrapsRemaining}`, 'trap').toBe(bare(t.loggedTrap));
  expect(s.currentPlayer, 'to move').toBe(PieceType.Cat);
  expect(s.phase, 'phase').toBe(GamePhase.Playing);
  expect(s.config.difficulty, 'difficulty').toBe('hard');
  expect(rc(s.catPosition)).toBe('2,2');
  expect(rc(s.mousePosition)).toBe('1,8');
  expect(s.mouseHasButter).toBe(true);
  expect(s.mouseSkillActive).toBe(false);
  expect(s.trapPosition ? rc(s.trapPosition) : 'none').toBe('1,1');
  expect(s.catTrapsRemaining).toBe(0);
  expect(s.catMovesLeft).toBe(4);
  expect(s.config.mouseCarryingMoves).toBe(3);
  expect(s.config.catBaseMoves).toBe(4);
});

// ===========================================================================
// HV4-E4 — reconstructed boards + clocks for all six turns (printed table).
// ===========================================================================
test('HV4-E4. print the reconstructed boards and win clocks', () => {
  const lines: string[] = [];
  let calls = 0;
  for (const t of loadLog()) {
    const s = t.state;
    const reach = mouseReach(mouseTurnFrom(s), 8);
    calls += reach.expanded;
    const holes = holeCells(s);
    const minToHole = Math.min(...holes.map((h) => reach.dist.get(rc(h)) ?? Infinity));
    lines.push(
      `\n===== GAME4/H1 Turn #${t.turn}\n${boardText(s)}`
      + `\nlogged: ${t.loggedSearch}\nlogged plan: ${t.loggedPlan}`
      + `\nroot values: ${t.loggedRootActions.join(' | ')}`
      + `\ncat=${rc(s.catPosition)} mouse=${rc(s.mousePosition)} carrying=${s.mouseHasButter}`
      + ` skill=${s.mouseSkillActive} trap=${s.trapPosition ? rc(s.trapPosition) : 'none'}/${s.catTrapsRemaining}`
      + ` butter=[${s.butterPositions.map(rc).join(' ')}] pending=[${(s.pendingButterSpawns ?? []).map(rc).join(' ')}]`
      + `\nmouse min steps to a hole cell (cat passive)=${minToHole === Infinity ? '>8' : minToHole}`
      + ` mouse immediate win=${[...reach.winAtStep.entries()].map(([p, d]) => `${p}@${d}`).join(' ') || 'no'}`
      + ` mouseManhattanToHole=${Math.min(...holes.map((h) => manhattan(s.mousePosition, h)))}`
      + ` catManhattanToMouse=${manhattan(s.catPosition, s.mousePosition)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`${lines.join('\n')}\n\nmouse-BFS step calls in this probe: ${calls}`);
  expect(loadLog().length).toBe(6);
});

// ===========================================================================
// HV4-S4a — T5: the mouse's legal route(s) and the tunnel-carrying rule.
// ===========================================================================
test('HV4-S4a. T5 mouse legal routes and tunnel legality while carrying', () => {
  const s = turnOf(5).state;
  const mt = mouseTurnFrom(s);
  const one = mouseReach(mt, 3);
  const many = mouseReach(mt, 8);
  const holes = holeCells(s);
  const winInOneTurn = holes.some((h) => one.winAtStep.has(rc(h)));
  const bestHole = holes
    .map((h) => ({ h, d: many.dist.get(rc(h)) ?? Infinity }))
    .sort((a, b) => a.d - b.d)[0];
  const minToHole = bestHole.d;
  const tunnels: string[] = [];
  for (let r = 0; r < s.config.boardSize; r++) {
    for (let c = 0; c < s.config.boardSize; c++) {
      if (s.board[r][c].type === CellType.Tunnel) tunnels.push(`${r},${c}`);
    }
  }
  const tunnelStep1 = tunnels.filter((p) => one.dist.has(p));

  // eslint-disable-next-line no-console
  console.log(
    `\nT5 MOUSE (carrying, ${mt.mouseMovesLeft} moves/turn, cat passive):`
    + `\n  tunnels=[${tunnels.join(' ')}] reachable in 1 turn=[${tunnelStep1.join(' ') || 'NONE'}]`
    + `\n  IMMEDIATE one-turn win available = ${winInOneTurn}`
    + `\n  min legal steps to a hole cell = ${minToHole} (mouse turns = ${Math.ceil(minToHole / s.config.mouseCarryingMoves)})`
    + `\n  shortest route to ${rc(bestHole.h)}: ${routeOf(many, rc(bestHole.h)).join(' → ')}`
    + `\n  turn-1 end cells (exactly 3 steps) = [${[...one.dist.entries()].filter(([, d]) => d === 3).map(([p]) => p).sort().join(' ')}]`,
  );

  expect(winInOneTurn, 'no immediate mouse win from (1,8) carrying').toBe(false);
  expect(minToHole, 'the mouse does have a legal route to the hole').toBeLessThanOrEqual(8);
  expect(minToHole > s.config.mouseCarryingMoves, 'route longer than one carrying turn').toBe(true);
  expect(tunnelStep1.length, 'carrying blocks tunnel entry (GAMEPLAY 3.4)').toBe(0);
});

// ===========================================================================
// HV4-S4b — T5: exact cat occupyable cells over 2 turns vs the mouse route.
// ===========================================================================
test('HV4-S4b. T5 cat interception: exact 1-2 turn occupancy vs route cells', () => {
  const s = turnOf(5).state;
  setWorldEntropySource(() => 0);
  let cat: ReturnType<typeof catOccupiableByTurn>;
  try {
    cat = catOccupiableByTurn(s, 2);
  } finally {
    setWorldEntropySource(null);
  }
  const [turn1, turn2] = cat.sets;
  const many = mouseReach(mouseTurnFrom(s), 8);
  const holes = holeCells(s);
  const bestHole = holes
    .map((h) => ({ h, d: many.dist.get(rc(h)) ?? Infinity }))
    .sort((a, b) => a.d - b.d)[0];
  const route = routeOf(many, rc(bestHole.h));
  const budget = s.config.mouseCarryingMoves;
  const rows = route.map((p, idx) => {
    const mouseTurn = Math.max(1, Math.ceil(idx / budget));
    const placeableBefore = mouseTurn >= 2 ? turn1.has(p) || turn2.has(p) : turn1.has(p);
    return { p, idx, mouseTurn, placeableBefore };
  });
  const trapable = rows.filter((x) => x.idx > 0 && x.placeableBefore);

  // eslint-disable-next-line no-console
  console.log(
    `\nT5 CAT exact occupancy (mouse frozen). turn1 cells=${turn1.size} turn2 cells=${turn2.size}`
    + ` enumeration nodes=${cat.nodes} captures=${cat.captureTurns.join(',') || 'none'}`
    + `\n  can the cat stand on the mouse cell (1,8) in 1 turn? ${turn1.has('1,8')}`
    + `\n  mouse shortest route: ${route.join(' → ')}`
    + `\n  route cells the cat could trap before the mouse crosses them: [${trapable.map((x) => x.p).join(' ') || 'NONE'}]`
    + `\n  logged T5 plan path: ${executeLoggedPlan(s, turnOf(5).loggedPlan).path.join(' → ')}`,
  );

  expect(turn1.size > 1, 'the cat has legal moves').toBe(true);
  expect(turn1.has('1,8'), 'no capture inside one cat turn').toBe(false);
});

// ===========================================================================
// HV4-S4c — T5 forced-loss probe: is there a mouse line that NO legal cat plan
// of the next two turns can capture, trap, or box-block? (exact enumeration of
// every cat plan, real turn hand-offs, entropy pinned)
// ===========================================================================
test('HV4-S4c. T5 mouse safe winning destination (forced-loss probe)', () => {
  const s = turnOf(5).state;
  const budget = s.config.mouseCarryingMoves;
  const holes = holeCells(s);
  const one = mouseReach(mouseTurnFrom(s), budget);
  const many = mouseReach(mouseTurnFrom(s), 2 * budget);
  const ends = [...one.dist.entries()].filter(([, d]) => d === budget).map(([p]) => p).sort();
  const detail: string[] = [];
  const safe: string[] = [];

  setWorldEntropySource(() => 0);
  try {
    for (const pos of ends) {
      const st = one.states.get(pos)!;
      const onward = mouseReach(st, budget);
      const best = holes
        .map((h) => ({ h, d: onward.dist.get(rc(h)) ?? Infinity }))
        .sort((a, b) => a.d - b.d)[0];
      if (best.d > budget) {
        detail.push(`${pos}: no hole inside one more carrying turn (needs ${best.d})`);
        continue;
      }
      // the whole line from the root through this cell into the hole
      const line = routeOf(many, rc(best.h));
      if (line[0] !== rc(s.mousePosition) || !line.includes(pos)) {
        detail.push(`${pos}: not on the ${rc(best.h)} shortest line (skipped)`);
        continue;
      }
      const pushes = boardDiff(s, st);
      const p = probeMouseLine(s, line.slice(1));
      if (p.outcome === 'FORCED_WIN') {
        safe.push(pos);
        detail.push(
          `${pos}: WINNING AND SAFE — line ${line.join('→')} wins in ${p.catTurns} cat turns`
            + ` against EVERY cat plan (nodes=${p.nodes}, frontier=${p.frontier})`
            + `${pushes.length ? ` [board changes along turn 1: ${pushes.join(' ')}]` : ' [turn 1 pushes no box]'}`,
        );
      } else {
        detail.push(`${pos}: ${p.outcome} — ${p.refutation} (after ${p.stepsWalked} steps)`);
      }
    }
  } finally {
    setWorldEntropySource(null);
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nT5 forced-loss probe (mouse turn-1 ends after exactly ${budget} steps at [${ends.join(' ')}];`
    + ` every cat plan enumerated):`
    + `\n${detail.map((x) => `  ${x}`).join('\n')}`
    + `\n  SAFE_WINNING_DESTINATIONS = [${safe.join(' ') || 'NONE'}]`
    + `\n  LEGAL_INTERCEPTION_EXISTS (a cat action that stops these lines) = ${safe.length === 0}`,
  );

  expect(safe.length, 'the mouse keeps a safe winning destination at T5').toBeGreaterThan(0);
});

// ===========================================================================
// HV4-S4d — the trap move itself: does relocating (1,1)→(0,1) change the
// mouse's fastest legal route or the win clock at all?
// ===========================================================================
test('HV4-S4d. the T5 trap relocation does not change the mouse win clock', () => {
  const s = turnOf(5).state;
  const logged = executeLoggedPlan(s, turnOf(5).loggedPlan);
  const many = mouseReach(mouseTurnFrom(s), 8);
  const holes = holeCells(s);
  const clockWith = (trap: GameEngineState): number => {
    const reach = mouseReach(mouseTurnFrom(trap), 8);
    return Math.min(...holes.map((h) => reach.dist.get(rc(h)) ?? Infinity));
  };
  const noTrapState: GameEngineState = { ...s, trapPosition: null };
  const clockAsLogged = clockWith(logged.end);
  const clockTrapUntouched = clockWith({ ...s });
  const clockNoTrap = clockWith(noTrapState);
  // Is either trap cell on a shortest route (i.e. crossed no later than the win)?
  const onRoute = (p: string): boolean => {
    const d1 = many.dist.get(p) ?? Infinity;
    const st = many.states.get(p);
    if (!st) return false;
    const rest = mouseReach(st, 8);
    const d2 = Math.min(...holes.map((h) => rest.dist.get(rc(h)) ?? Infinity));
    return d1 + d2 <= clockTrapUntouched;
  };

  // eslint-disable-next-line no-console
  console.log(
    `\nT5 trap move: logged plan ${logged.path.join(' → ')}`
    + `\n  end cat=${rc(logged.end.catPosition)} trap=${logged.end.trapPosition ? rc(logged.end.trapPosition) : 'none'}`
    + ` remain=${logged.end.catTrapsRemaining} catMovesLeft=${logged.end.catMovesLeft}`
    + `\n  mouse win clock: trap as logged=${clockAsLogged} trap left at (1,1)=${clockTrapUntouched} no trap at all=${clockNoTrap}`
    + `\n  (1,1) on a shortest mouse route? ${onRoute('1,1')}   (0,1) on a shortest mouse route? ${onRoute('0,1')}`
    + `\n  manhattan to nearest hole: (1,1)=${Math.min(...holes.map((h) => manhattan({ r: 1, c: 1 }, h)))}`
    + ` (0,1)=${Math.min(...holes.map((h) => manhattan({ r: 0, c: 1 }, h)))} (1,8)=${Math.min(...holes.map((h) => manhattan({ r: 1, c: 8 }, h)))}`,
  );

  expect(onRoute('1,1'), 'trap cell (1,1) is not on any shortest mouse route').toBe(false);
  expect(onRoute('0,1'), 'trap cell (0,1) is not on any shortest mouse route').toBe(false);
  expect(clockAsLogged, 'relocating the trap does not change the mouse win clock').toBe(clockTrapUntouched);
  expect(clockNoTrap, 'even removing the trap entirely does not change it').toBe(clockTrapUntouched);
  expect(rc(logged.end.catPosition)).toBe('1,1');
  expect(logged.end.trapPosition ? rc(logged.end.trapPosition) : 'none').toBe('0,1');
});

// ===========================================================================
// HV4-S4e — the same clock for T1..T6 (two-phase: fetch butter, then deliver).
// ===========================================================================
test('HV4-S4e. win clock per turn including the butter-fetch phase', () => {
  const rows: string[] = [];
  for (const t of loadLog()) {
    const s = t.state;
    const budget = s.mouseHasButter ? s.config.mouseCarryingMoves : s.config.mouseBaseMoves;
    const one = mouseReach(mouseTurnFrom(s), budget);
    const holes = holeCells(s);
    const winNow = holes.some((h) => one.winAtStep.has(rc(h)));
    // two-phase clock: steps to a butter cell, then steps from there to a hole
    let fetchThenDeliver = Infinity;
    let bestLine = 'n/a';
    if (!s.mouseHasButter) {
      for (const b of s.butterPositions) {
        const toB = one.dist.get(rc(b)) ?? Infinity;
        if (!Number.isFinite(toB)) continue;
        const st = one.states.get(rc(b))!;
        const after = mouseReach({ ...st, mouseHasButter: true }, 8);
        const fromB = Math.min(...holes.map((h) => after.dist.get(rc(h)) ?? Infinity));
        if (toB + fromB < fetchThenDeliver) {
          fetchThenDeliver = toB + fromB;
          bestLine = `butter ${rc(b)} + ${fromB} steps home`;
        }
      }
    } else {
      // already carrying: the clock is the multi-turn walk, not the 3-step BFS
      const walk = mouseReach(mouseTurnFrom(s), 8);
      fetchThenDeliver = Math.min(...holes.map((h) => walk.dist.get(rc(h)) ?? Infinity));
      bestLine = `${Number.isFinite(fetchThenDeliver) ? fetchThenDeliver : '>8'} steps home`;
    }
    const mouseTurns = Math.ceil(fetchThenDeliver / budget);
    rows.push(
      `Turn #${t.turn} cat=${rc(s.catPosition)} mouse=${rc(s.mousePosition)} carrying=${s.mouseHasButter}`
      + ` budget=${budget} winThisTurn=${winNow} mouseStepsToWin=${Number.isFinite(fetchThenDeliver) ? fetchThenDeliver : '>' + 8}`
      + ` mouseTurnsToWin=${Number.isFinite(fetchThenDeliver) ? mouseTurns : '?'} catMovesAvailableBefore=${mouseTurns * s.config.catBaseMoves}`
      + ` | ${bestLine}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nGAME4/H1 win clock per cat turn (cat passive, real step rules):\n  ${rows.join('\n  ')}`);
  expect(rows.length).toBe(6);
});

/**
 * Interleaved line probe: the mouse commits to ONE fixed cell line and the cat
 * plays EVERY legal plan (all its moves enumerated, real hand-offs, ghost
 * butter materialising). The two worlds are merged by `stateKey`, so the cat
 * frontier is the set of states reachable by some plan.
 *
 * The line is BROKEN if any cat plan can
 *   - capture (some plan stands on the mouse's cell at a cat-turn start), or
 *   - trap/block a cell the mouse is about to step on this turn (`occupied` is
 *     an over-approximation of the cells a plan can trap, since placing costs no
 *     step and the cat can also simply stand there), or
 *   - make the step itself illegal (a pushed box now sits on the line cell).
 * Nothing else a plan does can matter for this line, so a line that never breaks
 * is a FORCED win for the mouse — against every cat plan, not just the logged one.
 */
function probeMouseLine(
  root: GameEngineState,
  line: string[],
  nodeCapPerTurn = 200_000,
): {
  outcome: 'FORCED_WIN' | 'LINE_REFUTED' | 'CAPTURED';
  refutation: string;
  catTurns: number;
  stepsWalked: number;
  nodes: number;
  frontier: number;
} {
  const holes = new Set(holeCells(root).map(rc));
  let frontier = [root];
  let idx = 0;
  let catTurns = 0;
  let nodes = 0;
  // A trap placed on cat turn k is still on the board for every later mouse
  // step, so the threat set is the union of all turns so far (over-approximation:
  // it credits every plan with the cells any plan could reach).
  const threatened = new Set<string>();
  while (idx < line.length) {
    catTurns++;
    const reach = catTurnReach(frontier, nodeCapPerTurn);
    nodes += reach.nodes;
    const mouseNow = rc(frontier[0].mousePosition);
    if (reach.captured || reach.occupied.has(mouseNow)) {
      return {
        outcome: 'CAPTURED',
        refutation: `a cat plan can stand on the mouse cell ${mouseNow} during cat turn ${catTurns}`,
        catTurns,
        stepsWalked: idx,
        nodes,
        frontier: frontier.length,
      };
    }
    for (const p of reach.occupied) threatened.add(p);
    // the cells the mouse steps on during THIS mouse turn
    const budget = frontier[0].mouseHasButter
      ? frontier[0].config.mouseCarryingMoves
      : frontier[0].config.mouseBaseMoves;
    const segment = line.slice(idx, idx + budget);
    const blocked = segment.filter((p) => threatened.has(p));
    if (blocked.length > 0) {
      return {
        outcome: 'LINE_REFUTED',
        refutation: `a cat plan can trap/block ${blocked.join(' ')} before the mouse crosses it (by cat turn ${catTurns})`,
        catTurns,
        stepsWalked: idx,
        nodes,
        frontier: frontier.length,
      };
    }
    // mouse plays the segment from every cat-plan end state
    const next = new Map<string, GameEngineState>();
    for (const endState of reach.endStates.values()) {
      let s: GameEngineState = { ...endState, currentPlayer: endState.currentPlayer };
      if (s.currentPlayer !== PieceType.Mouse) s = endTurn(s);
      let walked = 0;
      for (const target of segment) {
        const dir = DIRECTIONS.find((d) => {
          const t = { r: s.mousePosition.r + d.dr, c: s.mousePosition.c + d.dc };
          return rc(t) === target;
        });
        if (!dir) return { outcome: 'LINE_REFUTED', refutation: `no direction from ${rc(s.mousePosition)} toward ${target}`, catTurns, stepsWalked: idx, nodes, frontier: frontier.length };
        const moved = mouseStepDeterministic(s, dir as Direction);
        if (moved.phase === GamePhase.MouseWins) {
          s = moved;
          break;
        }
        if (eq(moved.mousePosition, s.mousePosition)) {
          return {
            outcome: 'LINE_REFUTED',
            refutation: `${target} is not a legal mouse step from ${rc(s.mousePosition)} on a cat-plan branch (box pushed onto the line)`,
            catTurns,
            stepsWalked: idx + walked,
            nodes,
            frontier: frontier.length,
          };
        }
        s = moved;
        walked++;
      }
      if (s.phase === GamePhase.MouseWins) {
        if (!holes.has(rc(s.mousePosition))) return { outcome: 'LINE_REFUTED', refutation: 'win reported off-hole', catTurns, stepsWalked: idx, nodes, frontier: frontier.length };
        next.set('__WIN__', s);
        continue;
      }
      // The segment is exactly one mouse turn, so the engine has already handed
      // the turn back to the cat; make it explicit so the next `catTurnReach`
      // expands a real cat-turn start (budget re-granted, ghost butter resolved).
      if (s.currentPlayer !== PieceType.Cat) s = endTurn({ ...s, currentPlayer: PieceType.Mouse });
      next.set(stateKey(s), s);
    }
    if (next.has('__WIN__')) {
      return { outcome: 'FORCED_WIN', refutation: '', catTurns, stepsWalked: line.length, nodes, frontier: next.size };
    }
    idx += segment.length;
    frontier = [...next.values()];
    if (frontier.length === 0) return { outcome: 'LINE_REFUTED', refutation: 'empty frontier', catTurns, stepsWalked: idx, nodes, frontier: 0 };
  }
  return { outcome: 'LINE_REFUTED', refutation: 'line exhausted without a win', catTurns, stepsWalked: idx, nodes, frontier: frontier.length };
}

/**
 * The best line available to the mouse from this root. A mouse that is not
 * carrying cannot win, so its line has two legs: walk to a butter cell (the
 * pick-up is the engine's own), then walk home carrying. Each candidate line is
 * tested against every cat plan; ONE forced line is enough to call the root lost.
 */
function bestLineProbe(root: GameEngineState, maxSteps = 8): {
  result: ReturnType<typeof probeMouseLine>;
  bestLine: string[];
  forcedCount: number;
  tried: { line: string[]; result: ReturnType<typeof probeMouseLine> }[];
} {
  const reach = mouseReach(mouseTurnFrom(root), maxSteps);
  const holes = holeCells(root);
  const candidates: string[][] = [];
  const pushLine = (toB: string[], fromB: string[]): void => {
    if (toB.length < 2 || fromB.length < 2) return;
    candidates.push([...toB, ...fromB.slice(1)]);
  };
  if (root.mouseHasButter) {
    for (const h of holes) {
      const line = routeOf(reach, rc(h));
      if (line.length > 1 && line[0] === rc(root.mousePosition)) candidates.push(line);
    }
  } else {
    for (const b of root.butterPositions) {
      if (!reach.dist.has(rc(b))) continue;
      const toB = routeOf(reach, rc(b));
      const after = mouseReach(reach.states.get(rc(b))!, maxSteps);
      for (const h of holes) {
        if (!after.dist.has(rc(h))) continue;
        pushLine(toB, routeOf(after, rc(h)));
      }
    }
  }
  candidates.sort((a, b) => a.length - b.length);
  const tried: { line: string[]; result: ReturnType<typeof probeMouseLine> }[] = [];
  let best: ReturnType<typeof probeMouseLine> | null = null;
  let bestLine: string[] = [];
  // every candidate is tested, not just the shortest: one surviving line already
  // proves the root is lost, so the probe must not stop at the first refutation.
  for (const line of candidates.slice(0, 8)) {
    const r = probeMouseLine(root, line.slice(1));
    tried.push({ line, result: r });
    const better =
      !best ||
      (r.outcome === 'FORCED_WIN' && best.outcome !== 'FORCED_WIN') ||
      (r.outcome === best.outcome && r.stepsWalked > best.stepsWalked);
    if (better) {
      best = r;
      bestLine = line;
    }
  }
  const forcedCount = tried.filter((x) => x.result.outcome === 'FORCED_WIN').length;
  return {
    result: best ?? { outcome: 'LINE_REFUTED', refutation: 'no line', catTurns: 0, stepsWalked: 0, nodes: 0, frontier: 0 },
    bestLine,
    forcedCount,
    tried,
  };
}

// ===========================================================================
// HV4-S4g — the same forced-win probe on every turn of the game: which is the
// EARLIEST root from which the mouse already has a line no cat plan can break?
// ===========================================================================
test('HV4-S4g. earliest root with a mouse line no cat plan can refute', () => {
  const rows: string[] = [];
  const forced: number[] = [];
  setWorldEntropySource(() => 0);
  try {
    for (const t of loadLog()) {
      const s = t.state;
      const p = bestLineProbe(s, 12);
      if (p.result.outcome === 'FORCED_WIN') forced.push(t.turn);
      rows.push(
        `Turn #${t.turn} cat=${rc(s.catPosition)} mouse=${rc(s.mousePosition)} carrying=${s.mouseHasButter}`
        + ` lines=${p.tried.length} forcedLines=${p.forcedCount} best=${p.result.outcome}`
        + ` catTurns=${p.result.catTurns} steps=${p.result.stepsWalked} nodes=${p.result.nodes}`
        + ` frontier=${p.result.frontier}${p.result.refutation ? ` (${p.result.refutation})` : ''}`
        + `\n    line: ${p.bestLine.join('→')}`
        + `\n    logged: ${t.loggedPlan}`,
      );
    }
  } finally {
    setWorldEntropySource(null);
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nGAME4/H1 — mouse line vs ALL cat plans (exact per-turn enumeration):\n  ${rows.join('\n  ')}`
    + `\n  FORCED_WIN roots = [${forced.join(' ') || 'none'}]`
    + `\n  EARLIEST_PROVEN_LOST_ROOT = ${forced.length ? `Turn #${forced[0]}` : 'none proven'}`,
  );
  expect(rows.length).toBe(6);
});

// ===========================================================================
// HV4-S4f — the logged T5 plan replayed through the real engine reproduces the
// cat-side fields of the logged T6 root (turn hand-off included).
// ===========================================================================
test('HV4-S4f. replaying the logged T5 plan reproduces the T6 root fields', () => {
  const a = turnOf(5);
  const b = turnOf(6);
  setWorldEntropySource(() => 0);
  try {
    const { end } = executeLoggedPlan(a.state, a.loggedPlan);
    const handed = endTurn(end);
    // eslint-disable-next-line no-console
    console.log(
      `\nT5 replay → cat=${rc(end.catPosition)} trap=${end.trapPosition ? rc(end.trapPosition) : 'none'}`
      + ` remain=${end.catTrapsRemaining} catMovesLeft=${end.catMovesLeft}`
      + `\n  mouse turn start after hand-off: mouse=${rc(handed.mousePosition)} moves=${handed.mouseMovesLeft}`
      + ` butter=[${handed.butterPositions.map(rc).join(' ')}] pending=[${(handed.pendingButterSpawns ?? []).map(rc).join(' ')}]`
      + `\nT6 root         : cat=${rc(b.state.catPosition)} trap=${b.state.trapPosition ? rc(b.state.trapPosition) : 'none'}`
      + ` remain=${b.state.catTrapsRemaining} butter=[${b.state.butterPositions.map(rc).join(' ')}]`
      + ` pending=[${(b.state.pendingButterSpawns ?? []).map(rc).join(' ')}]`,
    );
    expect(rc(end.catPosition), 'cat cell').toBe(rc(b.state.catPosition));
    expect(end.trapPosition ? rc(end.trapPosition) : 'none', 'trap cell').toBe(
      b.state.trapPosition ? rc(b.state.trapPosition) : 'none',
    );
    expect(end.catTrapsRemaining, 'traps remaining').toBe(b.state.catTrapsRemaining);
    const start = nextCatTurnStart(end);
    expect(start.butterPositions.map(rc).sort().join(' '), 'butter after the boundary').toBe(
      b.state.butterPositions.map(rc).sort().join(' '),
    );
    expect((start.pendingButterSpawns ?? []).map(rc).sort().join(' '), 'pending spawns').toBe(
      (b.state.pendingButterSpawns ?? []).map(rc).sort().join(' '),
    );
    expect(start.catMovesLeft, 'next cat turn budget').toBe(a.state.config.catBaseMoves);
  } finally {
    setWorldEntropySource(null);
  }
});
