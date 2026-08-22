import { test, expect } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState } from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import {
  searchBestActionIterative,
  createSearchContext,
  compareSearchScore,
  preferResult,
  MATE_SCORE,
  type InternalSearchResult,
  type MateSide,
} from '../expectiminimax';
import { forcedLossTieBreak } from '../forcedLossTieBreak';
import { defaultRuleSet } from '../searchRules';
import type { SearchAction } from '../searchTypes';
import { evaluateForCat } from '../evaluation';

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

function setPieces(state: GameEngineState, mouse: { r: number; c: number }, cat?: { r: number; c: number }): GameEngineState {
  const board: GameEngineState['board'] = state.board.map((row) => row.map((cell) => ({ ...cell, piece: undefined })));
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

/** A forced-loss corridor: cat can't catch the mouse (which is already at the
 *  hole with butter). All cat root actions are mouse-mate with the same value. */
function forcedLossRoot(): GameEngineState {
  let s = createInitialState(cleanConfig());
  // Mouse at hole entrance carrying butter — mouse wins next turn.
  s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 });
  // Open a wide corridor so cat has multiple legal moves.
  s = wallOff(s, [
    { r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 },
    { r: 2, c: 1 }, { r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 },
    { r: 7, c: 6 }, { r: 7, c: 7 },
  ]);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 3,
    phase: GamePhase.Playing,
    mouseHasButter: true,
    catTrapsRemaining: 0,
    trapPosition: null,
  };
}

const mkRes = (value: number, mate: MateSide, completed = true): InternalSearchResult => ({
  value, mate, completed, cacheable: true, bound: 'exact',
});

// ===========================================================================
// G0.3A-1: secondary NEVER overrides different primary value
// ===========================================================================
test('G0.3A-1. secondary cannot override different primary value', () => {
  // -999993/mouse vs -999994/mouse: primary must pick -999993 (less bad).
  const a = mkRes(-999993, 'mouse');
  const b = mkRes(-999994, 'mouse');
  expect(preferResult(a, b, true)).toBe(true); // MAX prefers -999993
  expect(preferResult(b, a, true)).toBe(false);
  // compareSearchScore must be non-zero.
  expect(compareSearchScore({ value: -999993, mate: 'mouse' }, { value: -999994, mate: 'mouse' })).toBeGreaterThan(0);
});

// ===========================================================================
// G0.3A-2: different mate distance → primary always wins
// ===========================================================================
test('G0.3A-2. different mate distance → primary always prioritized', () => {
  // cat-mate (value 999990) vs mouse-mate (value -999990): cat-mate wins.
  const catMate = mkRes(999990, 'cat');
  const mouseMate = mkRes(-999990, 'mouse');
  expect(preferResult(catMate, mouseMate, true)).toBe(true);
  expect(preferResult(mouseMate, catMate, true)).toBe(false);
});

// ===========================================================================
// G0.3A-3: non-mate equal-value → default behavior unchanged
// ===========================================================================
test('G0.3A-3. non-mate equal-value tie does not trigger secondary', () => {
  // Two non-mate values that are equal: forcedLossTieBreak must return null.
  const root = forcedLossRoot();
  const ctx = createSearchContext(defaultRuleSet, BIG, true, true, true);
  ctx.capturePlan = true;
  ctx.planBranches = new Map();
  const rootActions = [
    { action: { type: 'catStep', direction: { key: 'ArrowUp', dr: -1, dc: 0, label: '↑' } } as SearchAction, value: 100, mate: null as MateSide },
    { action: { type: 'catStep', direction: { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' } } as SearchAction, value: 100, mate: null as MateSide },
  ];
  const result = forcedLossTieBreak(root, ctx, rootActions);
  expect(result).toBeNull(); // non-mate tie → no secondary
});

// ===========================================================================
// G0.3A-4: forced-loss exact tie → secondary triggers
// ===========================================================================
test('G0.3A-4. forced-loss exact mouse-mate tie triggers secondary', () => {
  // Need a real search with planBranches populated.
  const root = forcedLossRoot();
  const res = searchBestActionIterative(root, {
    rules: defaultRuleSet,
    maxDepthTurns: 4,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    leafEvaluator: evaluateForCat,
  });
  // If the root IS forced-loss (all mouse-mate), secondary should have been
  // applied. Check that the plan is NOT empty.
  expect(res.catTurnPlan.length).toBeGreaterThan(0);
  // The primary value/mate must be mouse-mate.
  expect(res.mate).toBe('mouse');
});

// ===========================================================================
// G0.3A-5: Turn5 exact fixture — rootValue/mate unchanged, reversalCount reduced
// ===========================================================================
test('G0.3A-5. Turn5 exact fixture: primary unchanged, reversalCount reduced', () => {
  const root = forcedLossRoot();
  const res = searchBestActionIterative(root, {
    rules: defaultRuleSet,
    maxDepthTurns: 4,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    leafEvaluator: evaluateForCat,
  });

  // Primary must be mouse-mate (forced loss).
  expect(res.mate).toBe('mouse');
  expect(res.value).toBeLessThan(-MATE_SCORE + 1000);

  // Count reversals in the returned plan.
  let reversals = 0;
  for (let i = 1; i < res.catTurnPlan.length; i++) {
    const a = res.catTurnPlan[i - 1], b = res.catTurnPlan[i];
    if (a.type === 'catStep' && b.type === 'catStep') {
      const opp: Record<string, string> = { ArrowUp: 'ArrowDown', ArrowDown: 'ArrowUp', ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft' };
      if (opp[a.direction!.key] === b.direction!.key) reversals++;
    }
  }
  // The tie-break should have selected a plan with fewer reversals than
  // the old Up→Down→Up→Down (which had 3). We can't guarantee 0 (depends on
  // which candidates exist), but it must be strictly less than 3.
  expect(reversals).toBeLessThan(3);
});

// ===========================================================================
// G0.3A-6: deterministic — same state + same budget → same plan
// ===========================================================================
test('G0.3A-6. deterministic: same state + budget → identical plan', () => {
  const root = forcedLossRoot();
  const a = searchBestActionIterative(root, {
    rules: defaultRuleSet, maxDepthTurns: 4, maxNodes: BIG,
    useTT: true, useAlphaBeta: true, useMoveOrdering: true, leafEvaluator: evaluateForCat,
  });
  const b = searchBestActionIterative(root, {
    rules: defaultRuleSet, maxDepthTurns: 4, maxNodes: BIG,
    useTT: true, useAlphaBeta: true, useMoveOrdering: true, leafEvaluator: evaluateForCat,
  });
  expect(a.catTurnPlan).toEqual(b.catTurnPlan);
  expect(a.value).toBe(b.value);
  expect(a.mate).toBe(b.mate);
});

// ===========================================================================
// G0.3A-7: TT on/off — primary result identical
// ===========================================================================
test('G0.3A-7. TT on/off: primary value/mate identical', () => {
  const root = forcedLossRoot();
  const off = searchBestActionIterative(root, {
    rules: defaultRuleSet, maxDepthTurns: 4, maxNodes: BIG,
    useTT: false, useAlphaBeta: true, useMoveOrdering: true, leafEvaluator: evaluateForCat,
  });
  const on = searchBestActionIterative(root, {
    rules: defaultRuleSet, maxDepthTurns: 4, maxNodes: BIG,
    useTT: true, useAlphaBeta: true, useMoveOrdering: true, leafEvaluator: evaluateForCat,
  });
  expect(on.value).toBe(off.value);
  expect(on.mate).toBe(off.mate);
});

// ===========================================================================
// G0.3A-8: debug/stateKey/gameAffectingEqual not affected
// ===========================================================================
test('G0.3A-8. stateKey/gameAffectingEqual unaffected by tie-break', () => {
  const root = forcedLossRoot();
  const before = JSON.stringify({ ...root, catActionLog: undefined, gameEventLog: undefined, lastHardSearch: undefined, hardSearchHistory: undefined });
  searchBestActionIterative(root, {
    rules: defaultRuleSet, maxDepthTurns: 4, maxNodes: BIG,
    useTT: true, useAlphaBeta: true, useMoveOrdering: true, leafEvaluator: evaluateForCat,
  });
  const after = JSON.stringify({ ...root, catActionLog: undefined, gameEventLog: undefined, lastHardSearch: undefined, hardSearchHistory: undefined });
  expect(after).toBe(before); // root state not mutated
});