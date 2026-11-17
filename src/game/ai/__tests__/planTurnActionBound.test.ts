/// <reference types="node" />
/**
 * PPC-P1-PLAN-01 — cat-turn plan action-bound acceptance (PLAN-1 … PLAN-9).
 *
 * THE DEFECT
 * ----------
 * Five plan extractors capped their output at a hard-coded `maxLength = 8`:
 *
 *   expectiminimax.buildCatTurnPlan
 *   planQuality.buildPlanForFirstAction   (feeds buildCandidate -> forcedLossTieBreak)
 *   planQuality.extractBestCatTurnPlan    (feeds searchBestAction / iterative / finalize)
 *   planQuality.extractDp / fallbackPlanWalk (the two extractBestCatTurnPlan bodies)
 *
 * A cat turn is bounded by its MOVE budget, and `catPlaceTrap` costs no move, so
 * a legal plan can exceed `catBaseMoves` and, from `catBaseMoves = 6` on, exceed
 * 8. The extractors then returned a plan that fails the project's own
 * full-turn completeness invariant (`planFullTurnCompleteness` -> TRUNCATED).
 *
 * THE FIX
 * -------
 * One derivation (`planBound.maxCatTurnPlanActions`, proof in
 * `PPC-P1-PLAN-01/PLAN_ACTION_BOUND_PROOF.md`) used as the DEFAULT cap of every
 * extractor. Nothing about the search, the evaluation, the TT, alpha-beta, the
 * rule set, the sidecar, the guard or the deadline contract is touched: only the
 * post-search plan walk is allowed to reach the actions it was always allowed to
 * have.
 *
 * Every number below comes from the real `createEngineRuleSet`, the real
 * `simulateSearchAction` and the real extractors; nothing is hand-computed.
 */
import { describe, expect, it } from 'vitest';
import { createEngineRuleSet } from '../../engine';
import type { GameEngineState } from '../../engine';
import { DIRECTIONS, PieceType } from '../../types';
import {
  buildCatTurnPlan, createSearchContext, searchBestAction, searchBestActionIterative,
} from '../expectiminimax';
import {
  buildCandidate, buildPlanForFirstAction, extractBestCatTurnPlan, planFullTurnCompleteness,
} from '../planQuality';
import type { EqualPrimaryGraph } from '../planQuality';
import { isSearchDeadlineExceeded } from '../planQuality';
import { simulateSearchAction } from '../simulator';
import type { RuleSet, SearchAction } from '../searchTypes';
import { evaluateForCat } from '../evaluation';
import { stateKey } from '../transposition';
import { catTurnMoveBudget, maxCatTurnPlanActions } from '../planBound';
import {
  catTurnRoot, chainCtx, dfsLongestPlan, labelOf, legalCatActions, parsePlan, replayPlan, TUNNELS,
} from './planActionBoundFixtures';

const rules: RuleSet = createEngineRuleSet();
const LEGACY_CAP = 8;

/** Piles everywhere except the corridor `col` in rows `r0..r1`, the hole and the tunnels. */
function corridorWalls(col: number, r0: number, r1: number): { r: number; c: number }[] {
  const hole = { r: 7, c: 8, size: 2 };
  const inHole = (r: number, c: number): boolean =>
    r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;
  const isTunnel = (r: number, c: number): boolean => TUNNELS.some((t) => t.r === r && t.c === c);
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (c === col && r >= r0 && r <= r1) continue;
      if (inHole(r, c) || isTunnel(r, c)) continue;
      out.push({ r, c });
    }
  }
  return out;
}

function corridorRoot(catBaseMoves: number): GameEngineState {
  return catTurnRoot({
    cat: { r: 1, c: 3 },
    mouse: { r: 8, c: 8 },
    catBaseMoves,
    traps: 1,
    walls: corridorWalls(3, 1, 6),
  });
}

/** Production-shaped fixed-depth D1 search with an inspectable context. */
function searchedContext(root: GameEngineState, depthTurns = 1) {
  const ctx = createSearchContext(rules, 400_000, true, true, true, 0);
  ctx.leafEvaluator = evaluateForCat;
  ctx.capturePlan = true;
  const result = searchBestAction(root, depthTurns, ctx);
  return { ctx, result };
}

function verdictOf(root: GameEngineState, plan: SearchAction[]) {
  return planFullTurnCompleteness(root, plan, rules);
}

// ---------------------------------------------------------------------------
// PLAN-0 — the shared bound is one derivation, not five constants
// ---------------------------------------------------------------------------
describe('PLAN-0 · one proven bound, used by every extractor', () => {
  it('derives M + 1 + floor(M/2) from the root state and never returns 8 by habit', () => {
    const cases: [number, number][] = [
      [0, 1], [1, 2], [2, 4], [3, 5], [4, 7], [5, 8], [6, 10], [7, 11], [9, 14], [12, 19],
    ];
    for (const [moves, expected] of cases) {
      const root = catTurnRoot({ cat: { r: 1, c: 1 }, mouse: { r: 8, c: 8 }, catBaseMoves: moves });
      expect(maxCatTurnPlanActions(root), `M=${moves}`).toBe(expected);
      expect(catTurnMoveBudget(root)).toBe(moves);
    }
  });

  it('clamps a non-finite / non-positive budget to a zero-move bound instead of guessing', () => {
    const root = catTurnRoot({ cat: { r: 1, c: 1 }, mouse: { r: 8, c: 8 }, catBaseMoves: 4 });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -3, 0]) {
      const broken = { ...root, catMovesLeft: bad };
      expect(catTurnMoveBudget(broken)).toBe(0);
      expect(maxCatTurnPlanActions(broken)).toBe(1);
    }
  });

  it('keeps the default 4-move bound below the legacy constant (that is why the bug hid)', () => {
    const root = catTurnRoot({ cat: { r: 1, c: 1 }, mouse: { r: 8, c: 8 }, catBaseMoves: 4 });
    expect(maxCatTurnPlanActions(root)).toBe(7);
    expect(maxCatTurnPlanActions(root)).toBeLessThan(LEGACY_CAP);
  });
});

// ---------------------------------------------------------------------------
// PLAN-1 — nine-move turn
// ---------------------------------------------------------------------------
describe('PLAN-1 · a nine-move cat turn yields a nine-plus-action plan', () => {
  it('returns a COMPLETE plan longer than the legacy cap, and the bound covers it', () => {
    const root = corridorRoot(9);
    expect(root.config.catBaseMoves).toBe(9);
    const { ctx, result } = searchedContext(root);
    const plan = result.catTurnPlan;

    expect(result.completed).toBe(true);
    expect(plan.length).toBeGreaterThan(LEGACY_CAP);
    expect(plan.length).toBeLessThanOrEqual(maxCatTurnPlanActions(root));
    expect(verdictOf(root, plan).kind).toBe('COMPLETE_TURN_BOUNDARY');
    expect(maxCatTurnPlanActions(root)).toBe(14);

    // The plan really is a legal replay, action by action.
    const rep = replayPlan(root, plan);
    expect(rep.ok).toBe(true);
    expect(rep.steps.every((s) => s.effective)).toBe(true);
    expect(rep.end.catMovesLeft).toBe(0);
    expect(rep.end.currentPlayer).toBe(PieceType.Mouse);

    // Every extractor that can see this ctx agrees the turn is complete.
    expect(verdictOf(root, buildCatTurnPlan(root, ctx)).kind).toBe('COMPLETE_TURN_BOUNDARY');
    expect(buildCatTurnPlan(root, ctx).length).toBeGreaterThan(LEGACY_CAP);
  });

  it('the legacy cap really was what truncated it (same ctx, cap lifted vs default)', () => {
    const root = corridorRoot(9);
    const { ctx, result } = searchedContext(root);
    const capped = buildCatTurnPlan(root, ctx, LEGACY_CAP);
    const uncapped = buildCatTurnPlan(root, ctx, 1_000);
    expect(capped.length).toBe(LEGACY_CAP);
    expect(verdictOf(root, capped).kind).toBe('TRUNCATED');
    expect(uncapped.length).toBe(9);
    expect(verdictOf(root, uncapped).kind).toBe('COMPLETE_TURN_BOUNDARY');
    expect(result.catTurnPlan.length).toBeGreaterThan(LEGACY_CAP);
  });
});

// ---------------------------------------------------------------------------
// PLAN-2 — six moves, nine actions (T + U/D alternation)
// ---------------------------------------------------------------------------
describe('PLAN-2 · TUDTUDTDD is a legal nine-action turn and survives every extractor', () => {
  const label = 'TUDTUDTDD';

  function chain() {
    const root = catTurnRoot({
      cat: { r: 3, c: 3 }, mouse: { r: 8, c: 8 }, catBaseMoves: 6, traps: 1,
    });
    const plan = parsePlan(label);
    const rep = replayPlan(root, plan);
    const { ctx } = chainCtx(root, plan);
    return { root, plan, rep, ctx };
  }

  it('replays under the real rules: 6 moves, 3 zero-cost placements, nothing forged', () => {
    const { root, plan, rep } = chain();
    expect(root.config.catBaseMoves).toBe(6);
    expect(rep.ok).toBe(true);
    expect(rep.steps).toHaveLength(9);
    expect(rep.steps.filter((s) => s.action.type === 'catStep')).toHaveLength(6);
    expect(rep.steps.filter((s) => s.action.type === 'catPlaceTrap')).toHaveLength(3);

    // Placements consume no move; moves consume exactly one.
    expect(rep.steps[0].catMovesLeft).toBe(6);
    expect(rep.steps[0].catTrapsRemaining).toBe(0);
    expect(rep.steps[1].catMovesLeft).toBe(5);
    // ...and the return step collects the trap.
    expect(rep.steps[2].trap).toBeNull();
    expect(rep.steps[2].catTrapsRemaining).toBe(1);
    expect(rep.steps[3].catTrapsRemaining).toBe(0);
    expect(rep.steps[5].trap).toBeNull();
    expect(rep.steps[5].catTrapsRemaining).toBe(1);

    expect(rep.end.catMovesLeft).toBe(0);
    expect(rep.end.currentPlayer).toBe(PieceType.Mouse);
    expect(verdictOf(root, plan).kind).toBe('COMPLETE_TURN_BOUNDARY');
    // ...while the eight-action prefix is a TRUNCATION, not a complete turn.
    expect(verdictOf(root, plan.slice(0, LEGACY_CAP)).kind).toBe('TRUNCATED');
  });

  it('every extraction entry point returns all nine actions', () => {
    const { root, plan, ctx } = chain();
    expect(buildCatTurnPlan(root, ctx).length).toBe(9);
    expect(labelOf(buildCatTurnPlan(root, ctx))).toBe(label);
    expect(labelOf(buildPlanForFirstAction(root, plan[0], ctx))).toBe(label);

    const walk = extractBestCatTurnPlan(root, rules, new Map() as EqualPrimaryGraph, ctx.planBranches);
    expect(labelOf(walk)).toBe(label);

    // buildCandidate is the forced-loss tie-break's plan source: a truncated plan
    // used to make it fail closed, so the selector silently lost its candidate.
    const cand = buildCandidate(root, plan[0], ctx, 0);
    expect(cand).not.toBeNull();
    expect(labelOf(cand!.plan)).toBe(label);
  });

  it('still refuses to certify an incomplete plan (the invariant is unchanged)', () => {
    const { root, ctx } = chain();
    // Drop the last two edges of the chain: the walk now stops mid-turn.
    const truncatedCtx = { ...ctx, planBranches: new Map(ctx.planBranches) };
    const plan = parsePlan(label);
    let cur = root;
    for (let i = 0; i < plan.length - 2; i++) {
      const rep = replayPlan(cur, [plan[i]]);
      cur = rep.end;
    }
    truncatedCtx.planBranches.delete(stateKey(cur));
    const short = buildCatTurnPlan(root, truncatedCtx);
    expect(short.length).toBe(7);
    expect(verdictOf(root, short).kind).toBe('TRUNCATED');
    // ...and buildCandidate refuses it (fail closed, unchanged semantics).
    expect(buildCandidate(root, plan[0], truncatedCtx, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PLAN-3 — every entry point over one real search context
// ---------------------------------------------------------------------------
describe('PLAN-3 · no extractor keeps a private cap', () => {
  it('all entry points are complete and identical to their uncapped selves', () => {
    const root = corridorRoot(9);
    const { ctx, result } = searchedContext(root);
    const graph: EqualPrimaryGraph = ctx.equalPrimaryGraph ?? new Map();
    const branches = ctx.planBranches;
    expect(graph.size).toBeGreaterThan(0); // the root really has an equal-primary tie

    const first = result.catTurnPlan[0] ?? result.action!;
    const entries: [string, SearchAction[]][] = [
      ['buildCatTurnPlan', buildCatTurnPlan(root, ctx)],
      ['buildPlanForFirstAction', buildPlanForFirstAction(root, first, ctx)],
      ['extractBestCatTurnPlan(DP)', extractBestCatTurnPlan(root, rules, graph, branches)],
      ['extractBestCatTurnPlan(walk)', extractBestCatTurnPlan(root, rules, new Map() as EqualPrimaryGraph, branches)],
    ];
    for (const [name, plan] of entries) {
      expect(plan.length, name).toBeGreaterThan(LEGACY_CAP);
      expect(verdictOf(root, plan).kind, name).toBe('COMPLETE_TURN_BOUNDARY');
    }

    // Lifting the cap changes nothing: it is already non-binding.
    expect(labelOf(buildCatTurnPlan(root, ctx))).toBe(labelOf(buildCatTurnPlan(root, ctx, 1_000)));
    expect(labelOf(extractBestCatTurnPlan(root, rules, graph, branches)))
      .toBe(labelOf(extractBestCatTurnPlan(root, rules, graph, branches, 1_000)));
    expect(labelOf(extractBestCatTurnPlan(root, rules, new Map() as EqualPrimaryGraph, branches)))
      .toBe(labelOf(extractBestCatTurnPlan(root, rules, new Map() as EqualPrimaryGraph, branches, 1_000)));

    // The production plan agrees with the extractors (it IS one of them).
    expect(result.catTurnPlan.length).toBeGreaterThan(LEGACY_CAP);
  });

  it('reaches the deepest completed depth plan too (previousCompletedPlan)', () => {
    const root = corridorRoot(9);
    const search = searchBestActionIterative(root, {
      rules, maxDepthTurns: 2, maxNodes: 400_000,
      useTT: true, useAlphaBeta: true, useMoveOrdering: true,
    });
    expect(search.completedDepth).toBeGreaterThanOrEqual(1);
    expect(search.catTurnPlan.length).toBeGreaterThan(LEGACY_CAP);
    if (search.previousCompletedDepth >= 1) {
      expect(search.previousCompletedPlan.length).toBeGreaterThan(LEGACY_CAP);
    }
  });
});

// ---------------------------------------------------------------------------
// PLAN-4 — the CHANCE boundary is still a boundary, not a hole
// ---------------------------------------------------------------------------
describe('PLAN-4 · a final catStep that opens a ghost/debt CHANCE boundary', () => {
  it('keeps the final cat action, stops there, and certifies COMPLETE_CHANCE_BOUNDARY', () => {
    const base = catTurnRoot({ cat: { r: 1, c: 1 }, mouse: { r: 8, c: 8 }, catBaseMoves: 4, traps: 0 });
    const root: GameEngineState = {
      ...base,
      catMovesLeft: 1,
      pendingButterSpawns: [{ r: 5, c: 5, blockedMaterializations: 0 }],
    };
    const step: SearchAction = { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === 'ArrowDown')! };

    // The real simulator classifies this step as the CAT->MOUSE CHANCE boundary.
    expect(simulateSearchAction(root, step, rules).kind).toBe('chance');

    const ctx = createSearchContext(rules, 400_000, true, true, true, 0);
    ctx.leafEvaluator = evaluateForCat;
    ctx.capturePlan = true;
    ctx.planBranches.set(stateKey(root), step);
    const plan = buildCatTurnPlan(root, ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toBe(step);
    expect(verdictOf(root, plan).kind).toBe('COMPLETE_CHANCE_BOUNDARY');
  });
});

// ---------------------------------------------------------------------------
// PLAN-5 — zero-cost trap correctness and the proven bound
// ---------------------------------------------------------------------------
describe('PLAN-5 · zero-cost placements never break the bound', () => {
  it('bound exceeds the longest legal sequence found by exhaustive DFS', () => {
    const roots: [string, GameEngineState][] = [
      ['corridor M=4', corridorRoot(4)],
      ['corridor M=9', corridorRoot(9)],
      ['open M=4', catTurnRoot({ cat: { r: 2, c: 2 }, mouse: { r: 8, c: 8 }, catBaseMoves: 4, traps: 1 })],
      ['open M=6', catTurnRoot({ cat: { r: 2, c: 2 }, mouse: { r: 8, c: 8 }, catBaseMoves: 6, traps: 1 })],
      ['open M=6, no trap stock', catTurnRoot({ cat: { r: 2, c: 2 }, mouse: { r: 8, c: 8 }, catBaseMoves: 6, traps: 0 })],
    ];
    for (const [name, root] of roots) {
      const bound = maxCatTurnPlanActions(root);
      const dfs = dfsLongestPlan(root, bound);
      expect(dfs.truncated, `${name} DFS exhausted`).toBe(false);
      expect(dfs.exceeded, `${name} exceeded its own proven bound`).toBe(false);
      expect(dfs.maxLen, `${name} longest legal sequence`).toBeLessThanOrEqual(bound);
    }
  });

  it('a placement costs no move, cannot repeat, and is collected by stepping back on it', () => {
    const root = catTurnRoot({ cat: { r: 3, c: 3 }, mouse: { r: 8, c: 8 }, catBaseMoves: 4, traps: 1 });
    const T: SearchAction = { type: 'catPlaceTrap' };
    const up: SearchAction = { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === 'ArrowUp')! };
    const down: SearchAction = { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === 'ArrowDown')! };

    const rep = replayPlan(root, [T, up, down, T]);
    expect(rep.ok).toBe(true);
    expect(rep.steps[0].catMovesLeft).toBe(4);
    expect(rep.steps[0].catTrapsRemaining).toBe(0);
    expect(rep.steps[1].catMovesLeft).toBe(3);
    expect(rep.steps[2].catMovesLeft).toBe(2);
    expect(rep.steps[2].trap).toBeNull();
    expect(rep.steps[2].catTrapsRemaining).toBe(1);
    expect(rep.steps[3].catMovesLeft).toBe(2);
    expect(rep.steps[3].catTrapsRemaining).toBe(0);

    // A second placement with the trap still on the board is NOT a legal action.
    const afterPlace = replayPlan(root, [T]).end;
    expect(legalCatActions(afterPlace).filter((a) => a.type === 'catPlaceTrap')).toHaveLength(0);
    // With no stock, no placement is offered either.
    const noStock = catTurnRoot({ cat: { r: 3, c: 3 }, mouse: { r: 8, c: 8 }, catBaseMoves: 4, traps: 0 });
    expect(legalCatActions(noStock).filter((a) => a.type === 'catPlaceTrap')).toHaveLength(0);
  });

  it('a trap already on the board is collected by walking onto it', () => {
    const root = catTurnRoot({
      cat: { r: 2, c: 3 }, mouse: { r: 8, c: 8 }, catBaseMoves: 4, traps: 0, trap: { r: 3, c: 3 },
    });
    const down: SearchAction = { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === 'ArrowDown')! };
    const rep = replayPlan(root, [down]);
    expect(rep.ok).toBe(true);
    expect(rep.end.trapPosition).toBeNull();
    expect(rep.end.catTrapsRemaining).toBe(1);
    expect(rep.end.catMovesLeft).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// PLAN-6 — DP memo / prefix context / termination
// ---------------------------------------------------------------------------
describe('PLAN-6 · DP determinism, prefix context, termination', () => {
  it('is deterministic and independent of the cap', () => {
    const root = corridorRoot(9);
    const { ctx } = searchedContext(root);
    const graph: EqualPrimaryGraph = ctx.equalPrimaryGraph ?? new Map();
    const a = extractBestCatTurnPlan(root, rules, graph, ctx.planBranches);
    const b = extractBestCatTurnPlan(root, rules, graph, ctx.planBranches);
    const c = extractBestCatTurnPlan(root, rules, graph, ctx.planBranches, 1_000);
    expect(labelOf(a)).toBe(labelOf(b));
    expect(labelOf(a)).toBe(labelOf(c));
  });

  it('distinguishes prefix direction (reversal-aware) rather than caching one answer', () => {
    // Two plans with the same action multiset but a different order: the DP must
    // score the reversal, which is only possible if the prefix is part of its
    // identity. A "D then U" plan has one reversal; "D then D" has none.
    const root = catTurnRoot({ cat: { r: 3, c: 3 }, mouse: { r: 8, c: 8 }, catBaseMoves: 4, traps: 0 });
    const down: SearchAction = { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === 'ArrowDown')! };
    const up: SearchAction = { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === 'ArrowUp')! };
    const flip = chainCtx(root, [down, up, down, up]);
    const straight = chainCtx(root, [down, down, down, down]);
    const flipPlan = extractBestCatTurnPlan(root, rules, new Map() as EqualPrimaryGraph, flip.ctx.planBranches);
    const straightPlan = extractBestCatTurnPlan(root, rules, new Map() as EqualPrimaryGraph, straight.ctx.planBranches);
    expect(labelOf(flipPlan)).toBe('DUDU');
    expect(labelOf(straightPlan)).toBe('DDDD');
  });

  it('terminates on a broad board well inside a diagnostic time budget', () => {
    const root = corridorRoot(9);
    const { ctx } = searchedContext(root);
    const t0 = Date.now();
    const plan = extractBestCatTurnPlan(root, rules, ctx.equalPrimaryGraph ?? new Map(), ctx.planBranches);
    const ms = Date.now() - t0;
    expect(plan.length).toBeLessThanOrEqual(maxCatTurnPlanActions(root));
    expect(ms).toBeLessThan(2_000); // DIAGNOSTIC_ONLY, not a performance gate
  });
});

// ---------------------------------------------------------------------------
// PLAN-8/9 — search authority and deadline authority are untouched
// ---------------------------------------------------------------------------
describe('PLAN-9 · extraction never creates or extends a time window', () => {
  it('fails closed when the search deadline has already passed', () => {
    const root = catTurnRoot({ cat: { r: 3, c: 3 }, mouse: { r: 8, c: 8 }, catBaseMoves: 6, traps: 1 });
    const plan = parsePlan('TUDTUDTDD');
    const { ctx } = chainCtx(root, plan);
    ctx.deadlineMs = ctx.now ? ctx.now() - 1 : -1;
    expect(isSearchDeadlineExceeded(ctx)).toBe(true);
    expect(buildCandidate(root, plan[0], ctx, 0)).toBeNull();
  });

  it('a completed search keeps its value/mate/nodes whether or not the plan got longer', () => {
    const root = corridorRoot(9);
    const first = searchedContext(root);
    const second = searchedContext(root);
    expect(first.result.completed).toBe(true);
    expect(Number.isFinite(first.result.value)).toBe(true);
    expect(first.result.mate).toBeNull();
    // Two independent runs of the SAME search protocol: the primary result must
    // be identical, i.e. the plan-length change never feeds back into the value.
    expect(second.result.value).toBe(first.result.value);
    expect(second.result.mate).toBe(first.result.mate);
    expect(second.ctx.diagnostics.nodes).toBe(first.ctx.diagnostics.nodes);
    expect(JSON.stringify(second.result.action)).toBe(JSON.stringify(first.result.action));
  });
});
