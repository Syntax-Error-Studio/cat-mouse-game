/**
 * PPC-HV-1A — human-game forensics repairs (turn numbering, fallback roots,
 * root-action `bound` export, real deadline diagnostics).
 *
 * Everything here is LIGHT by design (§5: "不要跑真实 40 回合 AI 搜索"):
 *  - numbering is proven on constructed entries through the SAME two helpers
 *    the engine now calls (`nextHardHistoryTurn` + `pushHardHistory`), plus a
 *    source-ordering guard that the engine really uses them;
 *  - the fallback-root cases drive the REAL `computeCatAiTrajectory` with a
 *    SPY-STUBBED planner (wrapping, never a second search), so no search runs;
 *  - the export cases call the REAL `DebugInfo` formatters (exported for
 *    tests only) over constructed entries.
 *
 * Nothing asserts a search decision, a value outcome or a timing threshold.
 */
import { test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createInitialState,
  computeCatAiTrajectory,
  type CatAiStep,
  type GameEngineState,
} from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, type Direction } from '../../types';
import type { SearchAction } from '../searchTypes';
import type { HardTurnPlan, HardSearchDebug } from '../hardTurnPlanner';
import type { IterativeSearchResult, MateSide } from '../expectiminimax';
import * as hardTurnPlannerModule from '../hardTurnPlanner';
import { DEFAULT_SEARCH_CONFIG } from '../searchConfig';
import { stateKey } from '../transposition';
import { gameAffectingEqual } from '../stateCompare';
import {
  HARD_HISTORY_LIMIT,
  makeHardHistoryEntry,
  nextHardHistoryTurn,
  pushHardHistory,
  hardHistorySnapshotJson,
  restoreHardRoot,
  type HardProductionDiag,
  type HardSearchHistoryEntry,
} from '../hardHistory';
import { formatHardSearch, formatHardSearchHistory } from '../../../components/DebugInfo';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UP: Direction = { key: 'ArrowUp', dr: -1, dc: 0, label: '↑' };
const RIGHT: Direction = { key: 'ArrowRight', dr: 0, dc: 1, label: '→' };
const DOWN: Direction = { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' };
const stepUp: SearchAction = { type: 'catStep', direction: UP };
const stepRight: SearchAction = { type: 'catStep', direction: RIGHT };
const stepDown: SearchAction = { type: 'catStep', direction: DOWN };
const placeTrap: SearchAction = { type: 'catPlaceTrap' };

const label = (plan: SearchAction[]): string =>
  plan.map((a) => (a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?')).join('');

function cleanConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: { r: 1, c: 5 },
    catStart: { r: 1, c: 1 },
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    catBaseMoves: 4,
    gameMode: 'single',
    difficulty: 'hard',
    tunnelCorners: [{ r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 }],
    ...overrides,
  };
}

/** A cat-to-move Hard root on an otherwise empty board. */
function hardRoot(): GameEngineState {
  const s = createInitialState(cleanConfig({ difficulty: 'hard' }));
  const board: GameEngineState['board'] = s.board.map((row) =>
    row.map((cell) => ({ ...cell, piece: undefined })),
  );
  board[1][1] = { ...board[1][1], piece: PieceType.Cat };
  board[1][5] = { ...board[1][5], piece: PieceType.Mouse };
  return {
    ...s,
    board,
    catPosition: { r: 1, c: 1 },
    mousePosition: { r: 1, c: 5 },
    currentPlayer: PieceType.Cat,
    phase: GamePhase.Playing,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
  };
}

interface StubSpec {
  completedDepth: number;
  attemptedDepth: number;
  hasSolution: boolean;
  plan: SearchAction[];
  bestAction: SearchAction | null;
  rootActions: { action: SearchAction; value: number; mate: MateSide; bound: 'exact' | 'lower' | 'upper' }[];
  value: number;
  mate: MateSide;
  nodes: number;
  elapsedMs: number;
  deadlineFired: boolean;
  budgetFired: boolean;
  withSearch?: boolean; // false => planner result carries no search object at all
}

const ABORTED: StubSpec = {
  completedDepth: 0, attemptedDepth: 1, hasSolution: false, plan: [], bestAction: null,
  rootActions: [], value: 0, mate: null, nodes: 17, elapsedMs: 101.2,
  deadlineFired: true, budgetFired: false, withSearch: true,
};
const EMPTY_PLAN: StubSpec = {
  completedDepth: 1, attemptedDepth: 2, hasSolution: true, plan: [], bestAction: null,
  rootActions: [], value: -42, mate: null, nodes: 91, elapsedMs: 12.5,
  deadlineFired: false, budgetFired: false, withSearch: true,
};

function stubPlan(s: StubSpec): HardTurnPlan {
  const search = {
    value: s.value, mate: s.mate,
    completedDepth: s.completedDepth, attemptedDepth: s.attemptedDepth,
    completed: s.hasSolution, catTurnPlan: s.plan,
    rootActions: s.rootActions,
    diagnostics: { totalNodes: s.nodes },
    iterations: [],
  } as unknown as IterativeSearchResult;
  const debug = {
    cat: { r: 1, c: 1 }, mouse: { r: 1, c: 5 }, mouseHasButter: false,
    completedDepth: s.completedDepth, attemptedDepth: s.attemptedDepth,
    nodes: s.nodes, elapsedMs: s.elapsedMs,
    rootValue: s.value, mate: s.mate, plan: s.plan, rootActions: s.rootActions,
    refutation: undefined, baselinePlan: s.plan, progressGuard: undefined,
  } as unknown as HardSearchDebug;
  return {
    plan: s.plan,
    bestAction: s.bestAction,
    completedDepth: s.completedDepth,
    attemptedDepth: s.attemptedDepth,
    hasSolution: s.hasSolution,
    deadlineFired: s.deadlineFired,
    budgetFired: s.budgetFired,
    search: s.withSearch ? search : (undefined as unknown as IterativeSearchResult),
    elapsedMs: s.elapsedMs,
    debug,
  };
}

/** Run ONE real cat turn with the planner stubbed (never a second search). */
function runTurnWithStub(root: GameEngineState, spec: StubSpec): { steps: CatAiStep[]; calls: number } {
  let calls = 0;
  const spy = vi.spyOn(hardTurnPlannerModule, 'planHardCatTurn').mockImplementation(
    (() => {
      calls++;
      return stubPlan(spec);
    }) as unknown as typeof hardTurnPlannerModule.planHardCatTurn,
  );
  let steps: CatAiStep[] | null = null;
  try {
    steps = computeCatAiTrajectory(root);
  } finally {
    spy.mockRestore();
  }
  expect(steps).not.toBeNull();
  return { steps: steps!, calls };
}

const lastState = (steps: CatAiStep[]): GameEngineState => steps[steps.length - 1].state;

// ===========================================================================
// P0-1 — the turn number keeps counting once the 20-entry window rolls.
// ===========================================================================

test('HV1A-1. turns 1..40 are consecutive, unique, and the window still holds <=20', () => {
  const root = hardRoot();
  let h: HardSearchHistoryEntry[] = [];
  const produced: number[] = [];
  for (let k = 1; k <= 40; k++) {
    const turn = nextHardHistoryTurn(h); // exactly what engine.ts now calls
    produced.push(turn);
    const entry = makeHardHistoryEntry(root, turn, {
      completedDepth: 1, attemptedDepth: 2, nodes: 10, elapsedMs: 5, rootValue: -1, mate: null,
      plan: [stepUp], rootValues: [],
    });
    // the engine's own write path, dedup filter included
    h = pushHardHistory(h.filter((e) => e.turn !== entry.turn), entry);
  }
  expect(produced).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  expect(h.length).toBe(HARD_HISTORY_LIMIT);
  expect(new Set(h.map((e) => e.turn)).size).toBe(HARD_HISTORY_LIMIT);
  expect(h[0].turn).toBe(21);
  expect(h[h.length - 1].turn).toBe(40);
});

test('HV1A-2. the boundary turns 20 / 21 / 22 keep the PREVIOUS turn alive', () => {
  const root = hardRoot();
  const add = (h: HardSearchHistoryEntry[]): HardSearchHistoryEntry[] => {
    const turn = nextHardHistoryTurn(h);
    return pushHardHistory(
      h.filter((e) => e.turn !== turn),
      makeHardHistoryEntry(root, turn, {
        completedDepth: 1, attemptedDepth: 1, nodes: 1, elapsedMs: 1, rootValue: 0, mate: null,
        plan: [stepUp], rootValues: [],
      }),
    );
  };
  let h: HardSearchHistoryEntry[] = [];
  for (let k = 1; k <= 20; k++) h = add(h);
  expect(h.map((e) => e.turn)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

  h = add(h); // turn 21 — the oldest (1) rolls out, 2..21 remain
  expect(h.length).toBe(20);
  expect(h.map((e) => e.turn)).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));

  h = add(h); // turn 22 — THE OLD BUG: length+1 said "21" again, and the dedup
             // filter deleted the real turn-21 record before it could be kept.
  const turns = h.map((e) => e.turn);
  expect(turns).toContain(21);
  expect(turns[turns.length - 1]).toBe(22);
  expect(new Set(turns).size).toBe(turns.length);
  // ...and the rolled window can no longer be read as a turn number.
  expect(nextHardHistoryTurn(h)).toBe(23);
  expect(h.length + 1).toBe(21);
});

test('HV1A-3. a new game resets the counter to 1', () => {
  const fresh = createInitialState(cleanConfig({ difficulty: 'hard' }));
  expect(fresh.hardSearchHistory).toEqual([]);
  expect(nextHardHistoryTurn(fresh.hardSearchHistory)).toBe(1);
});

test('HV1A-4. (source wiring) the engine numbers from the helper, and records BEFORE the plan check', () => {
  const src = readFileSync('src/game/engine.ts', 'utf8');
  expect(src).toMatch(/const hardTurnNo = nextHardHistoryTurn\(current\.hardSearchHistory \?\? \[\]\);/);
  expect(src).not.toMatch(/hardTurnNo = \(current\.hardSearchHistory\?\.length \?\? 0\) \+ 1/);
  const record = src.indexOf('pendingHistoryEntry = makeHardHistoryEntry');
  const planGate = src.indexOf('if (planned.hasSolution && planned.plan.length > 0)');
  expect(record).toBeGreaterThan(-1);
  expect(planGate).toBeGreaterThan(-1);
  // P0-2: entry creation moved OUT of the hasSolution branch.
  expect(record).toBeLessThan(planGate);
});

// ===========================================================================
// P0-2 — a turn that produced no plan still keeps its exact root snapshot.
// ===========================================================================

test('HV1A-5. depth-0 abort → root snapshot + failure markers, matchedPlan stays false', () => {
  const root = hardRoot();
  const { steps, calls } = runTurnWithStub(root, ABORTED);
  expect(calls).toBeGreaterThan(0);
  expect(steps.length).toBeGreaterThan(0); // the legacy heuristic still finished the turn

  const last = lastState(steps);
  const hist = last.hardSearchHistory;
  expect(hist.length).toBe(1);
  const e = hist[0];
  expect(e.turn).toBe(1);
  expect(e.production.planStatus).toBe('search_incomplete');
  expect(e.production.completedDepth).toBe(0);
  expect(e.production.plan.length).toBe(0);
  expect(e.production.bestAction).toBeNull();
  expect(e.production.deadlineFired).toBe(true);
  expect(e.production.budgetFired).toBe(false);
  // the budget recorded is the PRODUCTION one the engine passed, not the stub's
  expect(e.production.budgetMs).toBe(DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn);
  // no fabricated success
  expect(e.execution.matchedPlan).toBe(false);
  expect(e.execution.planCompleted).toBe(false);
  expect(e.execution.fallbackOccurred).toBe(true);
  expect(e.execution.invalidActionOccurred).toBe(false);
  // the root really is the pre-move root, exactly replayable
  expect(e.stateKey).toBe(stateKey(root));
  expect(stateKey(restoreHardRoot(JSON.parse(hardHistorySnapshotJson(e))))).toBe(e.stateKey);
  expect(label(e.production.plan)).toBe('');
  // and the turn is visibly a fallback in the engine's own log
  expect(last.catActionLog.some((l) => l.includes('SEARCH_FALLBACK reason=no_hard_plan'))).toBe(true);
});

test('HV1A-6. depth-1 completed with an EMPTY plan → recorded as empty_plan, not success', () => {
  const root = hardRoot();
  const { steps } = runTurnWithStub(root, EMPTY_PLAN);
  const e = lastState(steps).hardSearchHistory[0];
  expect(e).toBeTruthy();
  expect(e.production.planStatus).toBe('empty_plan');
  expect(e.production.completedDepth).toBe(1);
  expect(e.production.attemptedDepth).toBe(2);
  expect(e.production.rootValue).toBe(-42);
  expect(e.production.deadlineFired).toBe(false);
  expect(e.execution.matchedPlan).toBe(false);
  expect(e.execution.fallbackOccurred).toBe(true);
  expect(e.stateKey).toBe(stateKey(root));
});

test('HV1A-7. a planner result without a search object records nothing and does not crash', () => {
  const root = hardRoot();
  const { steps } = runTurnWithStub(root, { ...ABORTED, withSearch: false });
  const last = lastState(steps);
  expect(last.hardSearchHistory).toEqual([]);
  expect(steps.length).toBeGreaterThan(0);
  expect(last.catActionLog.some((l) => l.includes('SEARCH_FALLBACK reason=no_hard_plan'))).toBe(true);
});

test('HV1A-8. the new diag fields are DEBUG-ONLY: stateKey / gameAffectingEqual unchanged', () => {
  const root = hardRoot();
  const prod: HardProductionDiag = {
    completedDepth: 0, attemptedDepth: 1, nodes: 17, elapsedMs: 101.2, rootValue: 0, mate: null,
    plan: [], rootValues: [{ action: stepUp, value: -1, mate: null, bound: 'upper' }],
    bestAction: stepUp, planStatus: 'search_incomplete',
    deadlineFired: true, budgetFired: false, budgetMs: 100,
  };
  const entry = makeHardHistoryEntry(root, 41, prod);
  entry.execution = {
    plan: [], endStateKey: stateKey(root), matchedPlan: false,
    planCompleted: false, fallbackOccurred: true, invalidActionOccurred: false, reachedLegalBoundary: true,
  };
  const withHistory: GameEngineState = { ...root, hardSearchHistory: [entry] };
  expect(stateKey(withHistory)).toBe(stateKey(root));
  expect(gameAffectingEqual(root, withHistory)).toBe(true);
});

// ===========================================================================
// P1-1 / P1-2 — the export carries the real bound, the real abort cause, and
// full-precision scores; an unrecorded fact reads `unknown`, never `exact`.
// ===========================================================================

test('HV1A-9. history export prints ROOT_ACTIONS with value/mate/bound at full precision', () => {
  const root = hardRoot();
  const prod: HardProductionDiag = {
    completedDepth: 1, attemptedDepth: 2, nodes: 436, elapsedMs: 103.74,
    rootValue: -864, mate: null,
    plan: [stepRight, stepUp, stepDown],
    rootValues: [
      { action: stepUp, value: -310.729, mate: null, bound: 'exact' },
      { action: stepRight, value: -100.46, mate: null, bound: 'upper' },
      { action: stepDown, value: -100.44, mate: 'mouse', bound: 'lower' },
      { action: placeTrap, value: -500.5, mate: null }, // pre-1A record: no bound
    ],
    bestAction: stepUp, planStatus: 'planned',
    deadlineFired: true, budgetFired: false, budgetMs: 100,
  };
  const entry = makeHardHistoryEntry(root, 21, prod);
  entry.execution = {
    plan: prod.plan, endStateKey: 'K', matchedPlan: false,
    planCompleted: false, fallbackOccurred: true, invalidActionOccurred: false, reachedLegalBoundary: true,
  };
  const text = formatHardSearchHistory([entry]);

  expect(text).toContain('Turn #21');
  expect(text).toContain('ROOT_ACTIONS:');
  expect(text).toContain('ArrowUp: value=-310.729, mate=null, bound=exact');
  // full precision matters: -100.46 and -100.44 BOTH print as -100.4 at one
  // decimal, which is how a false tie would reappear on paper after RB-1.
  expect(text).toContain('value=-100.46, mate=null, bound=upper');
  expect(text).toContain('value=-100.44, mate=mouse, bound=lower');
  expect(text).toContain('catPlaceTrap: value=-500.5, mate=null, bound=unknown');
  expect(text).toContain('PLAN_STATUS=planned BEST_ACTION=ArrowUp PLAN_FIRST=ArrowRight');
  expect(text).toContain('DEADLINE: deadlineFired=true budgetFired=false elapsedMs=103.74 budgetMs=100 overNominalBudget=true');
  expect(text).toContain('SEARCH: cDepth=1 aDepth=2 nodes=436');
  expect(text).toContain('matched=false planCompleted=false fallbackOccurred=true');
  expect(text).toContain('SNAPSHOT_JSON=');
});

test('HV1A-10. a pre-1A entry shows unknown / n/a instead of a strongest-reading default', () => {
  const root = hardRoot();
  const legacy = {
    completedDepth: 2, attemptedDepth: 3, nodes: 100, elapsedMs: 50, rootValue: -999994, mate: 'mouse',
    plan: [stepUp], rootValues: [{ action: stepUp, value: -1, mate: 'mouse' }],
  } as unknown as HardProductionDiag;
  const entry = makeHardHistoryEntry(root, 3, legacy);
  const text = formatHardSearchHistory([entry]);
  expect(text).toContain('deadlineFired=unknown budgetFired=unknown');
  expect(text).toContain('budgetMs=n/a overNominalBudget=n/a');
  expect(text).toContain('PLAN_STATUS=unknown BEST_ACTION=n/a');
  expect(text).toContain('bound=unknown');
  expect(text).not.toContain('bound=exact');
});

test('HV1A-11. the live [HARD_SEARCH] block carries the same bound + deadline facts', () => {
  const debug = {
    cat: { r: 1, c: 1 }, mouse: { r: 1, c: 5 }, mouseHasButter: false,
    completedDepth: 1, attemptedDepth: 2, nodes: 436, elapsedMs: 103.74,
    rootValue: -864, mate: null,
    plan: [stepRight], baselinePlan: [stepRight],
    rootActions: [
      { action: stepUp, value: -864, mate: null, bound: 'exact' },
      { action: stepRight, value: -864, mate: null, bound: 'exact' },
      { action: placeTrap, value: -900, mate: null, bound: 'lower' },
    ],
    evalRoot: {
      mouseGoalThreat: 0, mouseWinRoute: 'none', holeControl: 0, captureDistance: '3',
      voronoi: 0, trapControl: 0, tunnelControl: 0, tempo: 0, total: -864,
    },
    deadlineFired: true, budgetFired: false, budgetMs: 100, planStatus: 'planned',
  } as unknown as HardSearchDebug;
  const text = formatHardSearch(debug);
  expect(text).toContain('TOP ROOT ACTIONS:');
  expect(text).toContain('1. ArrowUp: value=-864, mate=null, bound=exact');
  expect(text).toContain('catPlaceTrap: value=-900, mate=null, bound=lower');
  expect(text).toContain('DEADLINE: deadlineFired=true budgetFired=false elapsedMs=103.74 budgetMs=100 overNominalBudget=true');
  expect(text).toContain('planStatus=planned');
});
