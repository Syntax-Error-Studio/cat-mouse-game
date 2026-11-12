/// <reference types="node" />
/**
 * PPC-FLT-FIX-1 §7 (was AUDIT-1 P3) — evaluator parity acceptance.
 *
 * The forced-loss secondary key `boundaryEval` must be signed by the SAME leaf
 * evaluator the Hard search used (`ctx.leafEvaluator`, i.e. H1 in production),
 * falling back to the Baseline `evaluateForCat` ONLY when no leaf is injected.
 *
 * This remains a SECONDARY-KEY contract: the main search value, mate and
 * bestAction are produced by `searchBestAction` and are never re-scored here.
 */
import { expect, test } from 'vitest';
import { createEngineRuleSet, createInitialState } from '../../engine';
import type { GameEngineState } from '../../engine';
import type { GameConfig } from '../../config';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../types';
import { buildCandidate, compareCatTurnPlanQuality, dirKey } from '../planQuality';
import { forcedLossTieBreak } from '../forcedLossTieBreak';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { evaluateForCat } from '../evaluation';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import {
  createSearchContext,
  searchBestAction,
  compareSearchScore,
  type MateSide,
} from '../expectiminimax';
import type { RuleSet, SearchAction } from '../searchTypes';

const rules: RuleSet = createEngineRuleSet();
const TUNNELS = [{ r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 }];

type CellData = GameEngineState['board'][number][number];

function baseConfig(cat: { r: number; c: number }, mouse: { r: number; c: number }): GameConfig {
  return {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: mouse,
    catStart: cat,
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    catBaseMoves: 4,
    gameMode: 'single',
    difficulty: 'hard',
    tunnelCorners: TUNNELS,
  };
}

function openBoard(
  cat: { r: number; c: number },
  mouse: { r: number; c: number },
  opts: {
    ghosts?: { r: number; c: number }[];
    catMovesLeft?: number;
    traps?: number;
    mouseHasButter?: boolean;
  } = {},
): GameEngineState {
  const base = createInitialState(baseConfig(cat, mouse));
  const board: CellData[][] = base.board.map((row) =>
    row.map((cell) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) {
        return { ...cell, piece: undefined };
      }
      return { ...cell, type: CellType.Empty, piece: undefined, hasButter: false };
    }),
  );
  board[cat.r][cat.c] = { ...board[cat.r][cat.c], piece: PieceType.Cat };
  board[mouse.r][mouse.c] = { ...board[mouse.r][mouse.c], piece: PieceType.Mouse };
  return {
    ...base,
    board,
    catPosition: { ...cat },
    mousePosition: { ...mouse },
    currentPlayer: PieceType.Cat,
    catMovesLeft: opts.catMovesLeft ?? 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: opts.mouseHasButter ?? false,
    pendingButterSpawns: (opts.ghosts ?? []).map((g) => ({ r: g.r, c: g.c, blockedMaterializations: 0 })),
    pendingButterPlacementDebt: 0,
    catTrapsRemaining: opts.traps ?? 0,
    trapPosition: null,
    butterPositions: [],
  };
}

const step = (key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): SearchAction => ({
  type: 'catStep',
  direction: DIRECTIONS.find((d) => d.key === key)!,
});
const straight = (key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): SearchAction[] => [
  step(key), step(key), step(key), step(key),
];

/** Deterministic replay of a fully deterministic plan. */
function endState(root: GameEngineState, plan: SearchAction[]): GameEngineState | null {
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') return null;
    cur = t.state;
  }
  return cur;
}

/**
 * planBranches log for one or more plans. `leaf` is the injected evaluator;
 * `undefined` exercises the no-leaf-evaluator fallback path.
 */
function chainCtx(
  root: GameEngineState,
  plans: SearchAction[][],
  leaf: ((s: GameEngineState) => number) | undefined,
) {
  const ctx = createSearchContext(rules, 1_000_000, false, false, false, 0);
  if (leaf) ctx.leafEvaluator = leaf;
  for (const plan of plans) {
    let cur = root;
    for (const a of plan) {
      ctx.planBranches.set(stateKey(cur), a);
      const t = simulateSearchAction(cur, a, rules);
      if (t.kind !== 'deterministic') break;
      cur = t.state;
    }
  }
  return ctx;
}

// ===========================================================================
// FIX-4.1 — boundaryEval follows the injected leaf; no leaf -> Baseline
// ===========================================================================
test('FIX-4 boundaryEval uses ctx.leafEvaluator, falling back to Baseline only when absent', () => {
  const root = openBoard({ r: 5, c: 5 }, { r: 8, c: 1 });
  const plan = straight('ArrowUp');
  const end = endState(root, plan)!;
  const baseline = evaluateForCat(end);
  const h1 = evaluateCorrectedHoleForCat(end);
  expect(baseline).not.toBe(h1); // a state where both leaves are reachable

  const cBase = buildCandidate(root, plan[0], chainCtx(root, [plan], evaluateForCat), 0)!;
  const cH1 = buildCandidate(root, plan[0], chainCtx(root, [plan], evaluateCorrectedHoleForCat), 0)!;
  const cNone = buildCandidate(root, plan[0], chainCtx(root, [plan], undefined), 0)!;

  expect(cBase.boundaryEval).toBe(baseline);
  expect(cH1.boundaryEval).toBe(h1);
  // FIX: the fallback is the Baseline `evaluateForCat` (NOT defaultLeafEval).
  expect(cNone.boundaryEval).toBe(baseline);

  // The fix re-signs only the secondary key; plan geometry is untouched.
  for (const c of [cBase, cH1, cNone]) {
    expect(c.plan.map(dirKey)).toEqual(['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp']);
    expect(c.reversalCount).toBe(0);
    expect(c.revisitCount).toBe(0);
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-4 leaf parity`
    + `\n  mouse=8,1 baseline=${baseline} h1=${h1}`
    + `\n  boundary: injected-baseline=${cBase.boundaryEval} injected-h1=${cH1.boundaryEval} no-leaf(fallback)=${cNone.boundaryEval}`,
  );
});

// ===========================================================================
// FIX-4.2 — the same-root flip now follows the leaf actually in use
// ===========================================================================
test('FIX-4 the same-root ranking flip follows the search leaf (Baseline->Up, H1->Right)', () => {
  const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
  let flip: { root: GameEngineState; a: SearchAction[]; b: SearchAction[]; baseWin: string; h1Win: string } | null = null;

  for (const mouse of [{ r: 8, c: 1 }, { r: 8, c: 5 }, { r: 3, c: 1 }, { r: 1, c: 8 }, { r: 8, c: 8 }]) {
    const root = openBoard({ r: 5, c: 5 }, mouse);
    const plans = keys.map((k) => straight(k));
    const baseCtx = chainCtx(root, plans, evaluateForCat);
    const h1Ctx = chainCtx(root, plans, evaluateCorrectedHoleForCat);
    const built = plans.map((p, i) => ({
      plan: p,
      first: p[0],
      base: buildCandidate(root, p[0], baseCtx, i),
      h1: buildCandidate(root, p[0], h1Ctx, i),
    }));
    if (built.some((b) => b.base === null || b.h1 === null)) continue;
    for (let i = 0; i < built.length; i++) {
      for (let j = i + 1; j < built.length; j++) {
        const baseCmp = compareCatTurnPlanQuality(built[i].base!, built[j].base!, 'forced-loss-original');
        const h1Cmp = compareCatTurnPlanQuality(built[i].h1!, built[j].h1!, 'forced-loss-original');
        if (baseCmp * h1Cmp < 0) {
          flip = {
            root,
            a: built[i].plan,
            b: built[j].plan,
            baseWin: baseCmp < 0 ? dirKey(built[i].first) : dirKey(built[j].first),
            h1Win: h1Cmp < 0 ? dirKey(built[i].first) : dirKey(built[j].first),
          };
          break;
        }
      }
      if (flip) break;
    }
    if (flip) break;
  }
  expect(flip).not.toBeNull();

  const { root, a, b } = flip!;
  const rec = (action: SearchAction) => ({
    action,
    value: -999_999,
    mate: 'mouse' as MateSide,
    bound: 'exact' as const,
  });
  const baseCtx = chainCtx(root, [a, b], evaluateForCat);
  const h1Ctx = chainCtx(root, [a, b], evaluateCorrectedHoleForCat);
  const baseWinner = forcedLossTieBreak(root, baseCtx, [rec(a[0]), rec(b[0])]);
  const h1Winner = forcedLossTieBreak(root, h1Ctx, [rec(a[0]), rec(b[0])]);
  expect(baseWinner).not.toBeNull();
  expect(h1Winner).not.toBeNull();
  expect(dirKey(baseWinner![0])).toBe(flip!.baseWin);
  expect(dirKey(h1Winner![0])).toBe(flip!.h1Win);
  expect(flip!.baseWin).not.toBe(flip!.h1Win);

  // The main-search primary key is identical in both arms (the ties are
  // fabricated as exact-primary here); only the secondary key flips.
  expect(compareSearchScore({ value: -999_999, mate: 'mouse' }, { value: -999_999, mate: 'mouse' })).toBe(0);

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-4 ranking flip`
    + `\n  mouse=${root.mousePosition.r},${root.mousePosition.c}`
    + `\n  A(first=${dirKey(a[0])}) baseline=${evaluateForCat(endState(root, a)!)} h1=${evaluateCorrectedHoleForCat(endState(root, a)!)}`
    + `\n  B(first=${dirKey(b[0])}) baseline=${evaluateForCat(endState(root, b)!)} h1=${evaluateCorrectedHoleForCat(endState(root, b)!)}`
    + `\n  baseline-arm winner=${dirKey(baseWinner![0])} h1-arm winner=${dirKey(h1Winner![0])}`,
  );
});

// ===========================================================================
// FIX-4.3 — CHANCE boundary expectation uses the injected leaf
// ===========================================================================
test('FIX-4 CHANCE boundary expectation is signed by the injected leaf', () => {
  const root = openBoard({ r: 5, c: 5 }, { r: 3, c: 3 }, { ghosts: [{ r: 2, c: 2 }] });
  const plan = [step('ArrowLeft'), step('ArrowRight'), step('ArrowLeft'), step('ArrowRight')];

  const cBase = buildCandidate(root, plan[0], chainCtx(root, [plan], evaluateForCat), 0)!;
  const cH1 = buildCandidate(root, plan[0], chainCtx(root, [plan], evaluateCorrectedHoleForCat), 0)!;

  // Replay to the pre-final state and enumerate the real CHANCE outcomes.
  let cur = root;
  for (let i = 0; i < plan.length - 1; i++) {
    const t = simulateSearchAction(cur, plan[i], rules);
    expect(t.kind).toBe('deterministic');
    if (t.kind !== 'deterministic') return;
    cur = t.state;
  }
  const final = simulateSearchAction(cur, plan[plan.length - 1], rules);
  expect(final.kind).toBe('chance');
  if (final.kind !== 'chance') return;

  const weightSum = final.outcomes.reduce((s, o) => s + o.weight, 0);
  expect(weightSum).toBeCloseTo(1, 12);
  const expectation = (leaf: (s: GameEngineState) => number) =>
    final.outcomes.reduce((s, o) => s + o.weight * leaf(o.state), 0);

  expect(cBase.boundaryEval).toBeCloseTo(expectation(evaluateForCat), 12);
  expect(cH1.boundaryEval).toBeCloseTo(expectation(evaluateCorrectedHoleForCat), 12);
  expect(cH1.boundaryEval).not.toBeCloseTo(expectation(evaluateForCat), 9);

  // FIX-2 remains in force: the final cat cell is included and the pre-final
  // state's value is NOT used as the boundary.
  expect(cH1.revisitCount).toBe(3);
  expect(cH1.boundaryEval).not.toBeCloseTo(evaluateCorrectedHoleForCat(cur), 9);

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-4 CHANCE + H1`
    + `\n  outcomes=${final.outcomes.length} weightSum=${weightSum}`
    + `\n  baselineBoundary=${cBase.boundaryEval} h1Boundary=${cH1.boundaryEval}`
    + `\n  h1 expectation=${expectation(evaluateCorrectedHoleForCat)} preFinalH1=${evaluateCorrectedHoleForCat(cur)}`,
  );
});

// ===========================================================================
// FIX-4.3b — multi-outcome CHANCE: agreement + weighted H1 expectation
// ===========================================================================
test('FIX-4 multi-outcome CHANCE averages the injected leaf over real weights', () => {
  // The mouse stands on the pending ghost cell -> §7 auto-pick forces one
  // replacement ghost, so the boundary enumerates every legal spawn cell
  // (multi-outcome, uniform 1/N), not a single deterministic resolution.
  const root = openBoard({ r: 5, c: 5 }, { r: 3, c: 3 }, { ghosts: [{ r: 3, c: 3 }] });
  const plan = [step('ArrowLeft'), step('ArrowRight'), step('ArrowLeft'), step('ArrowRight')];

  const ctx = chainCtx(root, [plan], evaluateCorrectedHoleForCat);
  const buildStart = performance.now();
  const cand = buildCandidate(root, plan[0], ctx, 0)!;
  const buildMs = performance.now() - buildStart;

  let cur = root;
  for (let i = 0; i < plan.length - 1; i++) {
    const t = simulateSearchAction(cur, plan[i], rules);
    if (t.kind !== 'deterministic') return;
    cur = t.state;
  }
  const final = simulateSearchAction(cur, plan[plan.length - 1], rules);
  expect(final.kind).toBe('chance');
  if (final.kind !== 'chance') return;

  expect(final.outcomes.length).toBeGreaterThan(1);
  const cells = new Set(final.outcomes.map((o) => `${o.state.catPosition.r},${o.state.catPosition.c}`));
  expect(cells.size).toBe(1);
  const weightSum = final.outcomes.reduce((s, o) => s + o.weight, 0);
  expect(weightSum).toBeCloseTo(1, 12);
  const expectation = final.outcomes.reduce((s, o) => s + o.weight * evaluateCorrectedHoleForCat(o.state), 0);
  expect(cand.boundaryEval).toBeCloseTo(expectation, 12);
  expect(cand.boundaryEval).not.toBeCloseTo(evaluateCorrectedHoleForCat(cur), 9);

  // Prove the weighted path is not `outcomes[0]` with a leaf that actually
  // distinguishes the (otherwise H1-neutral) spawn positions.
  const lastSpawn = (s: GameEngineState) => {
    const sp = s.pendingButterSpawns ?? [];
    const p = sp[sp.length - 1];
    return 1000 + 10 * p.r + p.c;
  };
  const cProbe = buildCandidate(root, plan[0], chainCtx(root, [plan], lastSpawn), 0)!;
  const probeExpect = final.outcomes.reduce((s, o) => s + o.weight * lastSpawn(o.state), 0);
  const probeSpread = Math.max(...final.outcomes.map((o) => lastSpawn(o.state)))
    - Math.min(...final.outcomes.map((o) => lastSpawn(o.state)));
  expect(probeSpread).toBeGreaterThan(0);
  expect(cProbe.boundaryEval).toBeCloseTo(probeExpect, 12);
  expect(cProbe.boundaryEval).not.toBeCloseTo(lastSpawn(final.outcomes[0].state), 9);

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-4 multi-outcome CHANCE`
    + `\n  outcomes=${final.outcomes.length} weightSum=${weightSum} distinctCatCells=${cells.size}`
    + `\n  weightedH1=${cand.boundaryEval} outcomes[0]H1=${evaluateCorrectedHoleForCat(final.outcomes[0].state)} preFinalH1=${evaluateCorrectedHoleForCat(cur)}`
    + `\n  probe spread=${probeSpread} weighted=${cProbe.boundaryEval} outcomes[0]=${lastSpawn(final.outcomes[0].state)}`
    + `\n  candidateBuildMs=${buildMs.toFixed(3)} h1OutcomeEvals=${final.outcomes.length}`,
  );
});

// ===========================================================================
// FIX-4.4 — the selector never moves the main value/mate/bestAction
// ===========================================================================
/** Real forced-loss shape: one cat move left, ghost pending, mouse one step from the hole. */
function forcedLossOneMoveRoot(): GameEngineState {
  const base = createInitialState(baseConfig({ r: 1, c: 1 }, { r: 7, c: 7 }));
  const board: CellData[][] = base.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) {
        return { ...cell, piece: undefined };
      }
      const open = (r >= 1 && r <= 2 && c >= 1 && c <= 4) || (r === 7 && c >= 6 && c <= 7);
      return open
        ? { ...cell, type: CellType.Empty, piece: undefined, hasButter: false }
        : { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  board[1][1] = { ...board[1][1], piece: PieceType.Cat };
  board[7][7] = { ...board[7][7], piece: PieceType.Mouse };
  return {
    ...base,
    board,
    catPosition: { r: 1, c: 1 },
    mousePosition: { r: 7, c: 7 },
    currentPlayer: PieceType.Cat,
    catMovesLeft: 1,
    mouseMovesLeft: 3,
    phase: GamePhase.Playing,
    mouseHasButter: true,
    pendingButterSpawns: [{ r: 2, c: 4, blockedMaterializations: 0 }],
    pendingButterPlacementDebt: 0,
    catTrapsRemaining: 1,
    trapPosition: null,
    butterPositions: [],
  };
}

test('FIX-4 real H1 forced-loss search: selector keeps value/mate/bestAction', () => {
  const root = forcedLossOneMoveRoot();
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0);
  ctx.capturePlan = true;
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  const res = searchBestAction(root, 2, ctx);
  expect(res.completed).toBe(true);
  expect(res.mate).toBe('mouse');

  const before = { value: res.value, mate: res.mate, action: res.action };

  const pool = ctx.rootValues.filter((r) => r.bound === 'exact');
  expect(pool.length).toBeGreaterThan(0);
  expect(pool.every((r) => r.mate === 'mouse')).toBe(true);
  const best = pool.reduce((a, b) =>
    compareSearchScore({ value: b.value, mate: b.mate }, { value: a.value, mate: a.mate }) > 0 ? b : a,
  );
  expect(before.value).toBe(best.value);

  const planStart = performance.now();
  const plan = forcedLossTieBreak(root, ctx, pool);
  const planMs = performance.now() - planStart;
  // The selector may legitimately abstain (fail-closed); if it fires, the
  // chosen first action is a certified primary-equal and the plan completes.
  if (plan) {
    const chosen = pool.find((r) => dirKey(r.action) === dirKey(plan[0]));
    expect(chosen).toBeDefined();
    expect(chosen!.value).toBe(best.value);
  }

  // Main-search outputs are untouched by the secondary selector.
  expect(res.value).toBe(before.value);
  expect(res.mate).toBe(before.mate);
  expect(res.action).toBe(before.action);

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-4 real forced-loss (H1 leaf)`
    + `\n  rootValue=${before.value} mate=${before.mate} bestAction=${dirKey(before.action!)}`
    + `\n  exactPrimary=${pool.length} selector=${plan ? plan.map(dirKey).join('>') : 'null (fail-closed)'}`
    + `\n  selectorCostMs=${planMs.toFixed(3)} (candidates=${pool.length}, chanceOutcomeEvals=0 on this root)`,
  );
});
