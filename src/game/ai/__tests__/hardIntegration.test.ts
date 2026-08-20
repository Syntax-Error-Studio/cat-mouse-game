import { test, expect, vi } from 'vitest';
import type { GameEngineState } from '../../engine';
import {
  createInitialState,
  computeCatAiTrajectory,
  catMove,
} from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import type { SearchAction } from '../searchTypes';
import * as hardTurnPlannerModule from '../hardTurnPlanner';
import { searchBestActionIterative } from '../expectiminimax';
import { defaultRuleSet } from '../searchRules';
import type { RuleSet } from '../searchTypes';
import { simulateSearchAction } from '../simulator';

// ===========================================================================
// F1B-7 — Hard Production Integration (A–J)
// ===========================================================================

const BIG = 1_000_000;

function cleanConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: { r: 1, c: 1 },
    catStart: { r: 1, c: 3 },
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    catBaseMoves: 4,
    gameMode: 'single',
    difficulty: 'hard',
    tunnelCorners: [
      { r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 },
    ],
    ...overrides,
  };
}

function setPieces(
  state: GameEngineState,
  mouse: { r: number; c: number },
  cat?: { r: number; c: number },
): GameEngineState {
  const board: GameEngineState['board'] = state.board.map((row) =>
    row.map((cell) => ({ ...cell, piece: undefined })),
  );
  board[mouse.r][mouse.c] = { ...board[mouse.r][mouse.c], piece: PieceType.Mouse };
  if (cat) board[cat.r][cat.c] = { ...board[cat.r][cat.c], piece: PieceType.Cat };
  const patch: Partial<GameEngineState> = { board, mousePosition: { ...mouse } };
  if (cat) patch.catPosition = { ...cat };
  return { ...state, ...patch };
}

function wallOff(state: GameEngineState, open: { r: number; c: number }[]): GameEngineState {
  const openSet = new Set(open.map((p) => `${p.r},${p.c}`));
  const board: GameEngineState['board'] = state.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) return cell;
      if (openSet.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

/** A 1-wide lane on row 1 (cat at (1,4), mouse at (1,5)) → immediate capture. */
function captureRow(difficulty: 'easy' | 'medium' | 'hard'): GameEngineState {
  let s = createInitialState(cleanConfig({ difficulty }));
  s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 4 });
  s = wallOff(s, [{ r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 2,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

/** 1-wide corridor on row 1, cat at (1,catC), mouse at (1,5), traps given. */
function corridor(catC: number, traps: number): GameEngineState {
  let s = createInitialState(cleanConfig({ difficulty: 'hard' }));
  s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: catC });
  s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
    catTrapsRemaining: traps,
    trapPosition: null,
  };
}

/** No-trap RuleSet (cat trap is a no-op) for search-level tests. */
function noTrapRules(): RuleSet {
  return { ...defaultRuleSet, catPlaceTrap: (st: GameEngineState) => st };
}

function countBoxes(board: GameEngineState['board']): number {
  let n = 0;
  for (const row of board) for (const cell of row) if (cell.type === CellType.Box) n++;
  return n;
}

/** Replay one plan action through the REAL rules and return the successor. */
function replayPlan(cur: GameEngineState, a: SearchAction): GameEngineState {
  const t = simulateSearchAction(cur, a, defaultRuleSet);
  if (t.kind !== 'deterministic') throw new Error('cat actions must be deterministic');
  return t.state;
}

// ---------------------------------------------------------------------------
// A. Difficulty routing
// ---------------------------------------------------------------------------

test('F1B-7-A. Difficulty routing: Easy/Medium/Hard all produce a legal trajectory; Hard is Search-driven', () => {
  const easy = computeCatAiTrajectory(captureRow('easy'));
  expect(easy).not.toBeNull();
  expect(easy!.length).toBeGreaterThanOrEqual(1);

  const medium = computeCatAiTrajectory(captureRow('medium'));
  expect(medium).not.toBeNull();

  const hard = computeCatAiTrajectory(captureRow('hard'));
  expect(hard).not.toBeNull();
  // Hard search captures the adjacent mouse on this fixture.
  expect(hard!.some((st) => st.state.phase === GamePhase.CatWins)).toBe(true);
});

// ---------------------------------------------------------------------------
// B. ONE search per turn
// ---------------------------------------------------------------------------

test('F1B-7-B. Hard turn executes ONE main planner search (trajectory plans once)', () => {
  const spy = vi.spyOn(hardTurnPlannerModule, 'planHardCatTurn');
  try {
    computeCatAiTrajectory(captureRow('hard'));
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});

test('F1B-7-B2. searchBestActionIterative returns the full cat-turn plan in ONE call', () => {
  const s = corridor(1, 0);
  const res = searchBestActionIterative(s, {
    rules: noTrapRules(),
    maxDepthTurns: 4,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
  });
  const plan = res.catTurnPlan;
  expect(plan.length).toBeGreaterThanOrEqual(1);
  expect(plan.every((a) => a.type === 'catStep' || a.type === 'catPlaceTrap')).toBe(true);
});

// ---------------------------------------------------------------------------
// C. Multiple catSteps; stops at mouse switch / terminal
// ---------------------------------------------------------------------------

test('F1B-7-C. catTurnPlan has multiple catSteps and stops at the mouse turn', () => {
  const s = corridor(1, 0);
  const res = searchBestActionIterative(s, {
    rules: noTrapRules(),
    maxDepthTurns: 4,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
  });
  const plan = res.catTurnPlan;
  expect(plan.length).toBeGreaterThan(1);

  let cur = s;
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    expect(cur.currentPlayer).toBe(PieceType.Cat);
    cur = replayPlan(cur, a);
    if (cur.phase !== GamePhase.Playing) break;
    if (cur.currentPlayer !== PieceType.Cat) {
      // The mouse-switch action must be the LAST.
      expect(i).toBe(plan.length - 1);
    }
  }
  expect(cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat).toBe(true);
});

// ---------------------------------------------------------------------------
// D. Zero-cost trap: catPlaceTrap does NOT consume catMovesLeft
// ---------------------------------------------------------------------------

test('F1B-7-D. catPlaceTrap is zero-cost: real engine, plan replay, and never burns catMovesLeft', () => {
  // (a) Direct: placing a trap through the REAL engine leaves catMovesLeft.
  const s = corridor(4, 1); // cat (1,4), mouse (1,5), trap available
  const trapBefore = s.catMovesLeft;
  const trapped = simulateSearchAction(s, { type: 'catPlaceTrap' }, defaultRuleSet);
  if (trapped.kind === 'deterministic') {
    expect(trapped.state.catMovesLeft).toBe(trapBefore);
    expect(trapped.state.trapPosition).not.toBeNull();
  }

  // (b) If the search's best line uses a trap, replay must keep movesLeft at
  //     that step.
  const res = searchBestActionIterative(s, {
    rules: defaultRuleSet,
    maxDepthTurns: 4,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
  });
  let cur = s;
  for (const a of res.catTurnPlan) {
    const movesBefore = cur.catMovesLeft;
    cur = replayPlan(cur, a);
    if (a.type === 'catPlaceTrap') {
      expect(cur.catMovesLeft).toBe(movesBefore);
      expect(cur.trapPosition).not.toBeNull();
    }
  }

  // (c) Semantic guard independent of geometry: a trap planning action never
  //     decrements moves (this is the F1B-3/F1B-2 zero-cost contract).
  const planActions = searchBestActionIterative(s, {
    rules: defaultRuleSet,
    maxDepthTurns: 2,
    maxNodes: BIG,
    useTT: false,
    useAlphaBeta: false,
    useMoveOrdering: false,
  }).catTurnPlan;
  for (const a of planActions) {
    if (a.type === 'catPlaceTrap') {
      // mateActionCost contract (F1A-3) holds for planning too.
      const t2 = simulateSearchAction(s, a, defaultRuleSet);
      if (t2.kind === 'deterministic') expect(t2.state.catMovesLeft).toBe(s.catMovesLeft);
    }
  }
});

// ---------------------------------------------------------------------------
// E. Push: plan based on the post-push board
// ---------------------------------------------------------------------------

test('F1B-7-E. catTurnPlan push: replay through real engines keeps board intact', () => {
  let s = createInitialState(cleanConfig({ difficulty: 'hard' }));
  s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 1 });
  s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
  s = {
    ...s,
    board: s.board.map((row, r) => row.map((cell, c) => (r === 1 && c === 3 ? { ...cell, type: CellType.Box } : cell))),
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
    catTrapsRemaining: 0,
    trapPosition: null,
  };
  const beforeBoxes = countBoxes(s.board);
  const res = searchBestActionIterative(s, {
    rules: defaultRuleSet,
    maxDepthTurns: 4,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
  });
  expect(res.catTurnPlan.length).toBeGreaterThanOrEqual(1);
  const first = res.catTurnPlan[0];
  expect(first.type).toBe('catStep');
  if (first.type === 'catStep') expect(first.direction.key).toBe('ArrowRight');

  let cur = s;
  for (const a of res.catTurnPlan) cur = replayPlan(cur, a);
  expect(countBoxes(cur.board)).toBe(beforeBoxes); // no box lost/duplicated
});

// ---------------------------------------------------------------------------
// F. Trap reclaim (engine applies real reclaim on catStep onto trap)
// ---------------------------------------------------------------------------

test('F1B-7-F. Cat stepping onto its own trap reclaims it (real engine rules)', () => {
  // Cat at (1,4), its trap at (1,3) in front.
  let s = captureRow('hard');
  s = { ...s, trapPosition: { r: 1, c: 3 }, catTrapsRemaining: 0, mouseHasButter: false };
  const dir = { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' };
  const after = catMove(s, dir);
  expect(after.trapPosition).toBeNull();
  expect(after.catTrapsRemaining).toBe(1);

  // Same via the search simulator path used by plan replays.
  const t = simulateSearchAction(s, { type: 'catStep', direction: dir }, defaultRuleSet);
  if (t.kind === 'deterministic') {
    expect(t.state.trapPosition).toBeNull();
    expect(t.state.catTrapsRemaining).toBe(1);
  }
});

// ---------------------------------------------------------------------------
// G. Early capture stops the plan
// ---------------------------------------------------------------------------

test('F1B-7-G. Early capture immediately stops the trajectory plan', () => {
  const traj = computeCatAiTrajectory(captureRow('hard'));
  expect(traj).not.toBeNull();
  const winIdx = traj!.findIndex((st) => st.state.phase === GamePhase.CatWins);
  expect(winIdx).toBeGreaterThanOrEqual(0);
  // The trajectory is truncated at the win: no steps AFTER the CatWins state.
  if (winIdx >= 0) expect(traj!.slice(winIdx + 1)).toEqual([]);
});

// ---------------------------------------------------------------------------
// H. Deadline fallback
// ---------------------------------------------------------------------------

test('F1B-7-H. Hard planner with an immediate deadline returns clean no-solution (fallback)', () => {
  const s = captureRow('hard');
  const planned = hardTurnPlannerModule.planHardCatTurn(s, { rules: defaultRuleSet, timeBudgetMs: -1, now: () => 0 });
  expect(planned.hasSolution).toBe(false);
  expect(planned.plan).toEqual([]);
  expect(planned.completedDepth).toBe(0);
});

// ---------------------------------------------------------------------------
// I. Invalid cat actions rejected
// ---------------------------------------------------------------------------

test('F1B-7-I. Invalid plan action triggers SEARCH_FALLBACK (explicit, non-silent)', () => {
  // Corrupt the planner: force it to return a plan whose first action is an
  // illegal mouse-step. The trajectory must detect the invalid plan step,
  // log SEARCH_FALLBACK, and complete the turn with the legacy heuristic
  // (never crash / freeze / return null).
  const spy = vi.spyOn(hardTurnPlannerModule, 'planHardCatTurn').mockReturnValueOnce({
    plan: [{ type: 'mouseStep', direction: { key: 'ArrowRight', dr: 0, dc: 1, label: '→' } }],
    bestAction: null,
    completedDepth: 1,
    attemptedDepth: 1,
    hasSolution: true,
    deadlineFired: false,
    budgetFired: false,
    search: null as unknown as import('../expectiminimax').IterativeSearchResult,
  } as never);
  try {
    const s = captureRow('hard');
    const traj = computeCatAiTrajectory(s);
    expect(traj).not.toBeNull();
    // The invalid mouseStep was rejected → explicit fallback marker present.
    const hasFallback = traj!.some((st) => st.state.catActionLog.some((m) => m.includes('SEARCH_FALLBACK')));
    expect(hasFallback).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test('F1B-7-I2. Plan exhausted before the cat turn ends → SEARCH_FALLBACK reason=plan_exhausted', () => {
  // Force the planner to return a VALID but SHORT plan (one catStep Right on
  // a corridor needing more steps). The trajectory consumes the plan, then the
  // turn still has cat moves left → the plan is exhausted early. This must:
  //   - not crash / not freeze;
  //   - log an EXPLICIT `SEARCH_FALLBACK reason=plan_exhausted` (non-silent);
  //   - let the legacy AI safely finish the rest of the cat turn.
  const right = { key: 'ArrowRight', dr: 0, dc: 1, label: '→' };
  const spy = vi.spyOn(hardTurnPlannerModule, 'planHardCatTurn').mockReturnValueOnce({
    plan: [{ type: 'catStep', direction: right }],
    bestAction: { type: 'catStep', direction: right },
    completedDepth: 2,
    attemptedDepth: 2,
    hasSolution: true,
    deadlineFired: false,
    budgetFired: false,
    search: null as unknown as import('../expectiminimax').IterativeSearchResult,
  } as never);
  try {
    // cat (1,1), mouse (1,5), catMovesLeft=4, no trap → the single plan step
    // is valid but the turn is far from over → plan exhaustion.
    const s = corridor(1, 0);
    const traj = computeCatAiTrajectory(s);
    expect(traj).not.toBeNull();
    // The turn finished (capture or hand-off), so more than the 1 plan step
    // executed → the remaining moves were completed by the legacy fallback.
    expect(traj!.length).toBeGreaterThan(1);
    // Explicit (non-silent) fallback with the dedicated reason.
    const hasExhaustLog = traj!.some((st) =>
      st.state.catActionLog.some((m) => m.includes('SEARCH_FALLBACK') && m.includes('reason=plan_exhausted')),
    );
    expect(hasExhaustLog).toBe(true);
    // The turn terminated cleanly (capture, or catMovesLeft consumed to 0).
    const last = traj![traj!.length - 1].state;
    expect(last.phase !== GamePhase.Playing || last.catMovesLeft === 0).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// J. Determinism
// ---------------------------------------------------------------------------

test('F1B-7-J. Deterministic: same state+budget → identical plan', () => {
  const s = captureRow('hard');
  const a = hardTurnPlannerModule.planHardCatTurn(s, { rules: defaultRuleSet, timeBudgetMs: 100, now: () => 10 });
  const b = hardTurnPlannerModule.planHardCatTurn(s, { rules: defaultRuleSet, timeBudgetMs: 100, now: () => 10 });
  expect(a.plan).toEqual(b.plan);
  expect(a.bestAction).toEqual(b.bestAction);
  expect(a.search.value).toBe(b.search.value);
});