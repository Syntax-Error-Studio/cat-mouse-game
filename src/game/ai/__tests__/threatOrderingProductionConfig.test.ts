/// <reference types="node" />
/**
 * G0.3B production ordering restoration — targeted regression.
 *
 * G0.3B judged threat-aware move ordering EXPERIMENTAL (no proven benefit on the
 * real-player root) and ruled `useThreatOrdering=false` for production, but
 * `planHardCatTurn` never passed the option and `searchBestActionIterative`
 * resolves an omitted flag to `opts.useThreatOrdering ?? true`, so production ran
 * with threat ordering ON. This file pins the restored wiring four ways:
 *
 *   P-1 the production planner's main search call carries the explicit OFF flag
 *       while keeping the ordinary D3 ordering ON (and the search-layer default
 *       is still ON, so the explicit value is load-bearing, not decoration);
 *   P-2 behaviourally: the production root path performs ZERO threat
 *       classifications, the same root with the flag omitted performs > 0
 *       (`../threatClassifier` is wrapped by a counter — call evidence, not an
 *       option-object read);
 *   P-3 at a COMPLETE fixed depth (no deadline, ample node budget, completeness
 *       asserted first) value / mate / every root-action value / plan legality /
 *       the selected action's root value are identical ON vs OFF;
 *   P-4 the real engine entry still plans one full cat turn and still captures
 *       the mouse with the real cat rules.
 *
 * A new file (not additions to threatSearch.test.ts / hardIntegration.test.ts)
 * because both of those carry recorded digests in the R1F source census.
 */
import { describe, it, expect, vi } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState, computeCatAiTrajectory } from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import * as expectiminimaxModule from '../expectiminimax';
import {
  searchBestActionIterative, createSearchContext,
} from '../expectiminimax';
import { planHardCatTurn } from '../hardTurnPlanner';
import { defaultRuleSet } from '../searchRules';
import { evaluateForCat } from '../evaluation';
import { simulateSearchAction } from '../simulator';
import type { RuleSet, SearchAction } from '../searchTypes';

const probe = vi.hoisted(() => ({ classifyCalls: 0, reset(): void { this.classifyCalls = 0; } }));

vi.mock('../threatClassifier', async (importActual) => {
  const actual = await importActual<typeof import('../threatClassifier')>();
  return {
    ...actual,
    classifyGoalThreat: (state: Parameters<typeof actual.classifyGoalThreat>[0]) => {
      probe.classifyCalls++;
      return actual.classifyGoalThreat(state);
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers (same shapes as threatSearch.test.ts / hardIntegration.test.ts)
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

/** The G0.3B threat fixture: 1-wide lane beside the hole, mouse carrying butter. */
function threatRoot(): GameEngineState {
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

/** A tiny non-threat lane, used where only the wiring (not the threat) matters. */
function laneRoot(): GameEngineState {
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

/** Cat at (1,4), mouse adjacent at (1,5) in a 1-wide lane → real rules capture. */
function captureRoot(): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = clearButter(s);
  s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 4 });
  s = wallOff(s, [{ r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

function noTrapRules(): RuleSet {
  return { ...defaultRuleSet, catPlaceTrap: (st: GameEngineState) => st };
}

/** Replay a cat plan through the REAL rules; throws if any action is illegal. */
function replayPlan(root: GameEngineState, plan: SearchAction[]): { legal: boolean; consumed: number; end: GameEngineState } {
  let cur = root;
  let consumed = 0;
  for (const a of plan) {
    if (cur.currentPlayer !== PieceType.Cat || cur.phase !== GamePhase.Playing) break;
    const t = simulateSearchAction(cur, a, defaultRuleSet);
    if (t.kind !== 'deterministic') throw new Error(`cat action must be deterministic: ${JSON.stringify(a)}`);
    cur = t.state;
    consumed++;
  }
  return {
    legal: consumed === plan.length && (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat),
    consumed,
    end: cur,
  };
}

function rootValueMap(res: ReturnType<typeof searchBestActionIterative>): Map<string, number> {
  return new Map(res.rootActions.map((r) => [JSON.stringify(r.action), r.value]));
}

const FIXED_DEPTH = 2;

function fixedDepthSearch(state: GameEngineState, useThreatOrdering?: boolean) {
  return searchBestActionIterative(state, {
    rules: noTrapRules(),
    maxDepthTurns: FIXED_DEPTH,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    maxThreatExtensions: 0,
    leafEvaluator: evaluateForCat,
    ...(useThreatOrdering === undefined ? {} : { useThreatOrdering }),
  });
}

// ===========================================================================
// P-1 — the production planner call
// ===========================================================================

describe('P-1: planHardCatTurn passes useThreatOrdering=false explicitly', () => {
  it('the single main search carries the OFF flag and keeps D3 ordering ON', () => {
    const spy = vi.spyOn(expectiminimaxModule, 'searchBestActionIterative');
    try {
      const r = planHardCatTurn(laneRoot(), {
        rules: defaultRuleSet,
        timeBudgetMs: 100,
        now: () => 0,
        refutation: { enabled: false },
      });
      expect(r).toBeTruthy();
      expect(spy).toHaveBeenCalledTimes(1);
      const opts = spy.mock.calls[0][1];
      expect(opts.useThreatOrdering).toBe(false);
      expect(opts.useMoveOrdering).toBe(true);
      expect(opts.maxThreatExtensions).toBe(0);
      expect(opts.useTT).toBe(true);
      expect(opts.useAlphaBeta).toBe(true);
      expect(opts.maxNodes).toBe(500_000);
      expect(opts.maxDepthTurns).toBe(4);
      expect(opts.deadlineMs).toBe(100);
      expect(opts.leafEvaluator).toBe(evaluateForCat);
    } finally {
      spy.mockRestore();
    }
  });

  it('the switch is load-bearing: the search-layer default stays ON when omitted', () => {
    expect(createSearchContext(defaultRuleSet, 1_000).useThreatOrdering).toBe(true);
    const explicitOff = createSearchContext(defaultRuleSet, 1_000, true, true, true, 0, false);
    expect(explicitOff.useThreatOrdering).toBe(false);
    expect(explicitOff.useMoveOrdering).toBe(true);
  });
});

// ===========================================================================
// P-2 — behavioural evidence: classification calls
// ===========================================================================

describe('P-2: production path performs zero threat classifications', () => {
  it('OFF = 0 classifyGoalThreat calls, omitted flag = > 0, on the same threat root', () => {
    const root = threatRoot();

    probe.reset();
    fixedDepthSearch(root, false);
    const offCalls = probe.classifyCalls;

    probe.reset();
    fixedDepthSearch(root);
    const onCalls = probe.classifyCalls;

    probe.reset();
    planHardCatTurn(root, {
      rules: defaultRuleSet, timeBudgetMs: 100, now: () => 0, refutation: { enabled: false },
    });
    const productionCalls = probe.classifyCalls;

    expect(offCalls).toBe(0);
    expect(onCalls).toBeGreaterThan(0);
    expect(productionCalls).toBe(0);
  });
});

// ===========================================================================
// P-3 — complete fixed-depth truth is unchanged by the switch
// ===========================================================================

describe('P-3: fixed-depth search truth unchanged (threat ordering ON vs OFF)', () => {
  it('both arms COMPLETE depth 2 — an interrupted result is never compared as complete', () => {
    for (const useThreatOrdering of [false, true]) {
      const res = fixedDepthSearch(threatRoot(), useThreatOrdering);
      expect(res.completed, `completed @ ${useThreatOrdering}`).toBe(true);
      expect(res.completedDepth).toBe(FIXED_DEPTH);
      expect(res.attemptedDepth).toBe(FIXED_DEPTH);
      expect(res.deadlineExceeded).toBe(false);
      expect(res.budgetExhausted).toBe(false);
    }
  });

  it('value / mate / every root-action value are identical', () => {
    const off = fixedDepthSearch(threatRoot(), false);
    const on = fixedDepthSearch(threatRoot(), true);

    expect(on.value).toBe(off.value);
    expect(on.mate).toBe(off.mate);
    expect(on.completedDepth).toBe(off.completedDepth);
    expect(on.rootActions.length).toBe(off.rootActions.length);

    const offMap = rootValueMap(off);
    const onMap = rootValueMap(on);
    expect([...onMap.keys()].sort()).toEqual([...offMap.keys()].sort());
    for (const [k, v] of onMap) expect(offMap.get(k)).toBe(v);
  });

  it('both final plans are legal and the selection is identical ON vs OFF', () => {
    const root = threatRoot();
    const off = fixedDepthSearch(root, false);
    const on = fixedDepthSearch(root, true);

    expect(off.catTurnPlan.length).toBeGreaterThan(0);
    expect(on.catTurnPlan.length).toBeGreaterThan(0);
    for (const res of [off, on]) {
      expect(res.catTurnPlan.every((a) => a.type === 'catStep' || a.type === 'catPlaceTrap')).toBe(true);
      const replay = replayPlan(root, res.catTurnPlan);
      expect(replay.consumed).toBe(res.catTurnPlan.length);
      expect(replay.legal).toBe(true);
      expect(replay.end.phase !== GamePhase.Playing || replay.end.currentPlayer === PieceType.Mouse).toBe(true);
    }

    // Each chosen action is optimal under its own arm's recorded root values.
    expect(rootValueMap(on).get(JSON.stringify(on.bestAction))).toBe(on.value);
    expect(rootValueMap(off).get(JSON.stringify(off.bestAction))).toBe(off.value);

    // The root tie-break is by ORIGINAL legal order, so the ordering switch must
    // not move the answer.
    expect(JSON.stringify(on.bestAction)).toBe(JSON.stringify(off.bestAction));
    expect(JSON.stringify(on.catTurnPlan)).toBe(JSON.stringify(off.catTurnPlan));
  });
});

// ===========================================================================
// P-4 — the real engine entry still plans and executes a legal full turn
// ===========================================================================

describe('P-4: the production engine turn keeps D3 ordering and real cat rules', () => {
  it('computeCatAiTrajectory → planHardCatTurn → search is the OFF-flagged call', () => {
    const spy = vi.spyOn(expectiminimaxModule, 'searchBestActionIterative');
    probe.reset();
    try {
      const traj = computeCatAiTrajectory(captureRoot());
      expect(traj).not.toBeNull();
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
      const opts = spy.mock.calls[0][1];
      expect(opts.useThreatOrdering).toBe(false);
      expect(opts.useMoveOrdering).toBe(true);
      expect(opts.maxThreatExtensions).toBe(0);
      expect(probe.classifyCalls).toBe(0);
      // Real rules still decide the turn: the adjacent mouse is captured.
      // `computeCatAiTrajectory` returns POST-action states only (every push site
      // in engine.ts records `nextState`/`forced`, never the root), so a capture
      // on the first cat step is a length-1 trajectory — the CatWins step is the
      // evidence, not the count.
      expect(traj!.length).toBeGreaterThanOrEqual(1);
      expect(traj!.some((st) => st.state.phase === GamePhase.CatWins)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
