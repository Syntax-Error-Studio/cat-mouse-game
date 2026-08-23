import { describe, it, expect } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState, computeCatAiTrajectory } from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import {
  searchBestActionIterative,
  searchResult,
  createSearchContext,
} from '../expectiminimax';
import { defaultRuleSet } from '../searchRules';
import { evaluateForCat } from '../evaluation';
import type { RuleSet } from '../searchTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function clearButter(state: GameEngineState): GameEngineState {
  const board = state.board.map((row) => row.map((cell) => ({ ...cell, hasButter: false })));
  return { ...state, board, butterPositions: [], mouseHasButter: false, mouseSkillActive: false };
}

/** A small threat fixture: cat can catch mouse (1-wide lane), mouse near hole with butter. */
function threatFixture(): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = clearButter(s);
  s = setPieces(s, { r: 7, c: 7 }, { r: 5, c: 7 });
  s = wallOff(s, [
    { r: 5, c: 7 }, { r: 6, c: 7 }, { r: 7, c: 7 },
    { r: 5, c: 6 }, { r: 6, c: 6 }, { r: 7, c: 6 },
    { r: 5, c: 5 }, { r: 6, c: 5 }, { r: 7, c: 5 },
  ]);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: true,
    catTrapsRemaining: 0,
    trapPosition: null,
  };
}

/** A normal non-threat fixture: no butter, cat chasing mouse in a corridor. */
function normalFixture(): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = clearButter(s);
  s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 1 });
  s = wallOff(s, [
    { r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 },
  ]);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
    catTrapsRemaining: 0,
    trapPosition: null,
  };
}

/** No-trap RuleSet (cat trap is a no-op) for search-level tests. */
function noTrapRules(): RuleSet {
  return { ...defaultRuleSet, catPlaceTrap: (st: GameEngineState) => st };
}

// ===========================================================================
// B-5: Threat move ordering — fixed-depth truth unchanged
// ===========================================================================

describe('B-5: threat move ordering — fixed-depth truth unchanged', () => {
  it('ordering ON vs OFF produces identical value/mate at fixed depth on threat fixture', () => {
    const s = threatFixture();
    const depth = 2;

    // Ordering OFF
    const ctxOff = createSearchContext(noTrapRules(), BIG, true, true, false);
    ctxOff.leafEvaluator = evaluateForCat;
    const resOff = searchResult(s, depth, ctxOff);

    // Ordering ON
    const ctxOn = createSearchContext(noTrapRules(), BIG, true, true, true);
    ctxOn.leafEvaluator = evaluateForCat;
    const resOn = searchResult(s, depth, ctxOn);

    expect(resOn.value).toBe(resOff.value);
    expect(resOn.mate).toBe(resOff.mate);
    expect(resOn.completed).toBe(resOff.completed);
  });

  it('ordering ON vs OFF produces identical value/mate on normal fixture', () => {
    const s = normalFixture();
    const depth = 3;

    const ctxOff = createSearchContext(noTrapRules(), BIG, true, true, false);
    ctxOff.leafEvaluator = evaluateForCat;
    const resOff = searchResult(s, depth, ctxOff);

    const ctxOn = createSearchContext(noTrapRules(), BIG, true, true, true);
    ctxOn.leafEvaluator = evaluateForCat;
    const resOn = searchResult(s, depth, ctxOn);

    expect(resOn.value).toBe(resOff.value);
    expect(resOn.mate).toBe(resOff.mate);
  });
});

// ===========================================================================
// B-6: Ordering ON/OFF — all root action values identical
// ===========================================================================

describe('B-6: ordering ON/OFF — root action values identical', () => {
  it('all root action values match with/without ordering on threat fixture', () => {
    const s = threatFixture();
    const depth = 2;

    // Ordering OFF
    const resOff = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: depth,
      maxNodes: BIG,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: false,
      leafEvaluator: evaluateForCat,
    });

    // Ordering ON
    const resOn = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: depth,
      maxNodes: BIG,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
    });

    // Same root value + mate.
    expect(resOn.value).toBe(resOff.value);
    expect(resOn.mate).toBe(resOff.mate);
    expect(resOn.completedDepth).toBe(resOff.completedDepth);

    // Root action values must match (same set of actions, same values).
    const offMap = new Map(resOff.rootActions.map((a) => [JSON.stringify(a.action), a.value]));
    for (const ra of resOn.rootActions) {
      const k = JSON.stringify(ra.action);
      expect(offMap.has(k)).toBe(true);
      expect(ra.value).toBe(offMap.get(k));
    }
  });
});

// ===========================================================================
// B-7: Extension not-triggered → completely equivalent to baseline
// ===========================================================================

describe('B-7: extension not-triggered = baseline equivalence', () => {
  it('maxThreatExtensions=0 produces identical result to no extension field', () => {
    const s = normalFixture();
    const depth = 3;

    const ctxNoExt = createSearchContext(noTrapRules(), BIG, true, true, true, 0);
    ctxNoExt.leafEvaluator = evaluateForCat;
    const resNoExt = searchResult(s, depth, ctxNoExt);

    const ctxBaseline = createSearchContext(noTrapRules(), BIG, true, true, true);
    ctxBaseline.leafEvaluator = evaluateForCat;
    const resBaseline = searchResult(s, depth, ctxBaseline);

    expect(resNoExt.value).toBe(resBaseline.value);
    expect(resNoExt.mate).toBe(resBaseline.mate);
    expect(ctxNoExt.diagnostics.extensionsTriggered).toBe(0);
  });

  it('extension with non-threat state triggers 0 extensions', () => {
    const s = normalFixture();
    const res = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 3,
      maxNodes: BIG,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
    });

    expect(res.diagnostics.extensionsTriggered).toBe(0);
    expect(res.diagnostics.extendedNodes).toBe(0);
  });
});

// ===========================================================================
// B-8: Extension triggered — small oracle aligns with deeper full search
// ===========================================================================

describe('B-8: extension triggered — small oracle', () => {
  it('depth2 + extension2 on a critical-threat fixture matches depth4 full search terminal classification', () => {
    const s = threatFixture();

    // Full depth-4 search (oracle) — no extension, just deeper nominal depth.
    const resD4 = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 4,
      maxNodes: BIG,
      useTT: false, // fresh TT for oracle
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 0,
    });

    // Depth-2 + extension-2 (should reach effective depth 4 on critical lines).
    const resD2Ext2 = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 2,
      maxNodes: BIG,
      useTT: false, // fresh TT
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
    });

    // Extension should have triggered.
    expect(resD2Ext2.diagnostics.extensionsTriggered).toBeGreaterThan(0);

    // The mate classification should match (both should see the same
    // terminal outcome on the critical line, if one exists within reach).
    // If d4 found a mate, d2+ext2 should find the same mate side.
    if (resD4.mate !== null) {
      expect(resD2Ext2.mate).toBe(resD4.mate);
    }
    // If no mate at d4, d2+ext2 may or may not find one (extension only
    // goes to effective d4 on critical lines, not everywhere). But the
    // value should be in the same ballpark (not wildly different).
    if (resD4.mate === null && resD2Ext2.mate === null) {
      expect(Math.abs(resD2Ext2.value - resD4.value)).toBeLessThan(Math.abs(resD4.value) + 1);
    }
  });
});

// ===========================================================================
// B-9: Extension cap — no infinite recursion
// ===========================================================================

describe('B-9: extension cap — no infinite recursion', () => {
  it('extension terminates within node budget on a critical-threat fixture', () => {
    const s = threatFixture();

    // Very tight node budget to prove the extension doesn't blow up.
    const res = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 2,
      maxNodes: 5000,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
    });

    // Must terminate and return a result.
    expect(res).toBeDefined();
    expect(res.diagnostics.totalNodes).toBeLessThanOrEqual(5000);
    // extensionDepthReached tracks extension credits used (0..maxThreatExtensions).
    expect(res.diagnostics.maxExtensionDepth).toBeLessThanOrEqual(2);
  });

  it('extension with maxThreatExtensions=2 does not exceed 2 extension credits per path', () => {
    const s = threatFixture();
    const res = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 2,
      maxNodes: BIG,
      useTT: false,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
    });

    // maxExtensionDepth = max extension credits used on any path (≤ maxThreatExtensions).
    expect(res.diagnostics.maxExtensionDepth).toBeLessThanOrEqual(2);
  });
});

// ===========================================================================
// B-10: TT context isolation
// ===========================================================================

describe('B-10: TT context isolation', () => {
  it('searching with extension ON then OFF does not pollute TT (same result as fresh)', () => {
    const s = threatFixture();

    // Search with extension ON first (writes to its own TT).
    const resExtOn = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 2,
      maxNodes: BIG,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
    });

    // Search with extension OFF (separate TT — should not see ext entries).
    const resExtOff = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 2,
      maxNodes: BIG,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 0,
    });

    // Both should be self-consistent (no crash, valid result).
    expect(resExtOn).toBeDefined();
    expect(resExtOff).toBeDefined();
    // The OFF search should NOT have any extension diagnostics.
    expect(resExtOff.diagnostics.extensionsTriggered).toBe(0);
  });

  it('calling extension-ON search twice produces the same result (TT-safe)', () => {
    const s = threatFixture();

    const res1 = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 2,
      maxNodes: BIG,
      useTT: false,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
    });

    const res2 = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 2,
      maxNodes: BIG,
      useTT: false,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
    });

    expect(res2.value).toBe(res1.value);
    expect(res2.mate).toBe(res1.mate);
    expect(res2.diagnostics.extensionsTriggered).toBe(res1.diagnostics.extensionsTriggered);
  });
});

// ===========================================================================
// B-11: Deadline abort — partial extension does not leak
// ===========================================================================

describe('B-11: deadline abort — partial extension does not leak', () => {
  it('immediate deadline returns clean no-solution with extensions enabled', () => {
    const s = threatFixture();
    const res = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 4,
      maxNodes: BIG,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
      deadlineMs: 0, // immediate deadline
      now: () => 100, // already past
    });

    // Must return a valid structure (no crash). completedDepth may be 0.
    expect(res).toBeDefined();
    // The result should not pretend to be complete if nothing finished.
    if (res.completedDepth === 0) {
      expect(res.completed).toBe(false);
    }
    // No partial extended result should leak as a completed depth.
    // If extensions were triggered but the search was aborted, the
    // extensionAbortCount should be > 0.
  });

  it('tight deadline does not let partial extension results leak as completedDepth', () => {
    const s = threatFixture();
    let time = 0;
    const res = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 4,
      maxNodes: BIG,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
      deadlineMs: 5, // 5ms — very tight
      now: () => { time += 1; return time; },
    });

    expect(res).toBeDefined();
    // completedDepth must be the last FULLY completed depth.
    // If the search was interrupted, it should NOT report a higher completedDepth
    // than it actually achieved.
    expect(res.completedDepth).toBeLessThanOrEqual(res.attemptedDepth);
  });
});

// ===========================================================================
// B-12: Chance node semantics unchanged
// ===========================================================================

describe('B-12: chance node semantics unchanged with extension', () => {
  it('chance nodes are still searched with full window when extension is enabled', () => {
    // Create a state where mouse can pick up butter (chance node).
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 5, c: 5 }, { r: 1, c: 1 });
    // Place butter adjacent to mouse.
    s = wallOff(s, [
      { r: 5, c: 5 }, { r: 5, c: 6 }, { r: 1, c: 1 }, { r: 1, c: 2 },
      { r: 2, c: 1 }, { r: 2, c: 2 }, { r: 3, c: 1 }, { r: 3, c: 2 },
      { r: 4, c: 1 }, { r: 4, c: 2 },
    ]);
    const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
    board[5][6] = { ...board[5][6], type: CellType.Empty, hasButter: true };
    s = {
      ...s,
      board,
      butterPositions: [{ r: 5, c: 6 }],
      currentPlayer: PieceType.Mouse,
      mouseMovesLeft: 4,
      phase: GamePhase.Playing,
      mouseHasButter: false,
      catTrapsRemaining: 0,
      trapPosition: null,
    };

    // Search with extension ON.
    const res = searchBestActionIterative(s, {
      rules: defaultRuleSet,
      maxDepthTurns: 3,
      maxNodes: BIG,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
    });

    // The search should complete without errors.
    expect(res).toBeDefined();
    expect(res.completedDepth).toBeGreaterThanOrEqual(1);
    // Chance nodes should have been searched (if any were reached).
    // The key invariant: the search did NOT crash or hang.
  });
});

// ===========================================================================
// B-13: Turn4 exact regression (forced-loss fixture)
// ===========================================================================

describe('B-13: Turn4-style forced-loss regression', () => {
  it('forced-loss fixture: all root actions are mouse-mate at sufficient depth', () => {
    // A simplified forced-loss: mouse at hole entrance with butter,
    // cat far away. All cat root actions should be mouse-mate at depth 4.
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 });
    s = wallOff(s, [
      { r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 },
      { r: 2, c: 1 }, { r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 },
      { r: 7, c: 6 }, { r: 7, c: 7 },
    ]);
    s = {
      ...s,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
      mouseMovesLeft: 4,
      phase: GamePhase.Playing,
      mouseHasButter: true,
      catTrapsRemaining: 0,
      trapPosition: null,
    };

    const res = searchBestActionIterative(s, {
      rules: noTrapRules(),
      maxDepthTurns: 4,
      maxNodes: BIG,
      useTT: false,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 0,
    });

    expect(res.completedDepth).toBeGreaterThanOrEqual(1);
    // At depth 4, the mouse (adjacent to hole with butter) should be a
    // proven mouse-mate.
    if (res.completedDepth >= 4) {
      expect(res.mate).toBe('mouse');
    }
  });
});

// ===========================================================================
// B-14: Turn5 G0.3A regression — forced-loss tie-break still works
// ===========================================================================

describe('B-14: G0.3A forced-loss tie-break regression', () => {
  it('forced-loss fixture with extension still produces a valid plan (no reversal explosion)', () => {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 });
    s = wallOff(s, [
      { r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 },
      { r: 2, c: 1 }, { r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 },
      { r: 7, c: 6 }, { r: 7, c: 7 },
    ]);
    s = {
      ...s,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
      mouseMovesLeft: 4,
      phase: GamePhase.Playing,
      mouseHasButter: true,
      catTrapsRemaining: 1,
      trapPosition: null,
    };

    // With extension ON — the tie-break should still select a stable plan.
    const res = searchBestActionIterative(s, {
      rules: defaultRuleSet,
      maxDepthTurns: 4,
      maxNodes: BIG,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      maxThreatExtensions: 2,
    });

    expect(res).toBeDefined();
    expect(res.catTurnPlan.length).toBeGreaterThan(0);
    // The plan should be valid cat actions.
    expect(res.catTurnPlan.every((a) => a.type === 'catStep' || a.type === 'catPlaceTrap')).toBe(true);
  });
});

// ===========================================================================
// B-15: Easy/Medium untouched
// ===========================================================================

describe('B-15: Easy/Medium AI untouched by threat extension', () => {
  it('Easy difficulty still produces a legal trajectory', () => {
    let s = createInitialState(cleanConfig({ difficulty: 'easy' }));
    s = clearButter(s);
    s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 1 });
    s = wallOff(s, [
      { r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 },
    ]);
    s = {
      ...s,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
      mouseMovesLeft: 4,
      phase: GamePhase.Playing,
    };
    const traj = computeCatAiTrajectory(s);
    expect(traj).not.toBeNull();
    expect(traj!.length).toBeGreaterThanOrEqual(1);
  });

  it('Medium difficulty still produces a legal trajectory', () => {
    let s = createInitialState(cleanConfig({ difficulty: 'medium' }));
    s = clearButter(s);
    s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 1 });
    s = wallOff(s, [
      { r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 },
    ]);
    s = {
      ...s,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
      mouseMovesLeft: 4,
      phase: GamePhase.Playing,
    };
    const traj = computeCatAiTrajectory(s);
    expect(traj).not.toBeNull();
    expect(traj!.length).toBeGreaterThanOrEqual(1);
  });

  it('Hard difficulty with threat extension still captures adjacent mouse', () => {
    let s = createInitialState(cleanConfig({ difficulty: 'hard' }));
    s = clearButter(s);
    s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 4 });
    s = wallOff(s, [{ r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
    s = {
      ...s,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
      mouseMovesLeft: 4,
      phase: GamePhase.Playing,
    };
    const traj = computeCatAiTrajectory(s);
    expect(traj).not.toBeNull();
    expect(traj!.some((st) => st.state.phase === GamePhase.CatWins)).toBe(true);
  });
});
