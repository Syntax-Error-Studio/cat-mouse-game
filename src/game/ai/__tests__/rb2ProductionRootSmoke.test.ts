/// <reference types="node" />
/**
 * PPC-RB-2 §3/§4 — real-root production smoke for the PPC-RB-1 root-bound fix.
 *
 * One REAL frozen game root (G24T1, the "all root scores tied" Baseline root)
 * driven through the REAL production entry point, with exactly ONE Hard
 * main-planning call at the normal production budget:
 *
 *   computeCatAiTrajectory → planHardCatTurn → searchBestActionIterative
 *     → catTurnPlan → applyPlanCatAction (per-action, real rules)
 *
 * A spy WRAPS (never replaces) `planHardCatTurn`, so the same single call that
 * the engine makes is observed for both sides of the contract:
 *   - the OPTIONS the real entry injects (budget / flags / injected RuleSet /
 *     leaf resolver) — proving the fix is reached through production, and
 *   - the RESULT's `search.rootActions`, which is where the per-candidate
 *     `bound` lives (HardSearchDebug.rootActions does not carry it).
 *
 * What is asserted is only timing-independent soundness. The 100ms/150ms
 * budgets are NOT raised, no reference search is added, and depth/value
 * outcomes are recorded rather than pinned (a wall-clock deadline legitimately
 * flips `completedDepth` between runs — see the Hard deadline nondeterminism
 * record). If the search does not complete, the engine's own fallback marker is
 * what gets recorded; that is a real fallback, not a failure.
 */
import { test, expect, vi } from 'vitest';
import {
  computeCatAiTrajectory,
  createEngineRuleSet,
  endTurn,
  type CatAiStep,
  type GameEngineState,
} from '../../engine';
import { GamePhase, PieceType } from '../../types';
import type { SearchAction } from '../searchTypes';
import * as hardTurnPlannerModule from '../hardTurnPlanner';
import type { HardTurnPlan, HardTurnPlanOptions } from '../hardTurnPlanner';
import { DEFAULT_SEARCH_CONFIG, HARD_TRIAL, HARD_LEAF_MODE_CONFIG } from '../searchConfig';
import { resolveHardLeaf } from '../hybridLeaf';
import { evaluateForCat } from '../evaluation';
import { planFullTurnCompleteness, dirKey } from '../planQuality';
import { stateKey } from '../transposition';
import { f0TurnRoot } from './fixtures/frozenFixtures';

const label = (plan: SearchAction[]): string =>
  plan.map((a) => (a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?')).join('');

interface Observed {
  plan: HardTurnPlan;
  options: HardTurnPlanOptions;
  rootAtPlanTime: GameEngineState;
  calls: number;
}

/** Run ONE production cat turn, observing (not replacing) the single planner call. */
function runRealHardTurn(root: GameEngineState): { obs: Observed; steps: CatAiStep[]; turnWallMs: number } {
  const captured: Partial<Observed> = { calls: 0 };
  const original = hardTurnPlannerModule.planHardCatTurn;
  const spy = vi.spyOn(hardTurnPlannerModule, 'planHardCatTurn').mockImplementation(
    ((state: GameEngineState, options: HardTurnPlanOptions): HardTurnPlan => {
      captured.calls = (captured.calls ?? 0) + 1;
      captured.rootAtPlanTime = state;
      captured.options = options;
      const result = original(state, options);
      captured.plan = result;
      return result;
    }) as typeof hardTurnPlannerModule.planHardCatTurn,
  );
  let steps: CatAiStep[] | null = null;
  const t0 = performance.now();
  try {
    steps = computeCatAiTrajectory(root);
  } finally {
    spy.mockRestore();
  }
  const turnWallMs = performance.now() - t0;
  expect(steps).not.toBeNull(); // a cat-to-move playing root must produce a turn
  return { obs: captured as Observed, steps: steps!, turnWallMs };
}

const root = f0TurnRoot('G24T1'); // fails closed on any provenance mismatch
const { obs, steps, turnWallMs } = runRealHardTurn(root);
const planned = obs.plan;
const debug = planned.debug;
const finalState = steps[steps.length - 1].state;
const entry = finalState.hardSearchHistory[finalState.hardSearchHistory.length - 1];
const rules = createEngineRuleSet();
const completeness = planFullTurnCompleteness(root, planned.plan, rules);
const fallbackMarkers = finalState.catActionLog.filter((l) => l.includes('SEARCH_FALLBACK') || l.includes('HARD_FALLBACK_MOVE'));

// --- §3 item 4: the certified-root view (bound lives only on search.rootActions)
const rootActions = planned.search.rootActions ?? [];
const primary = rootActions.find((r) => dirKey(r.action) === dirKey(planned.plan[0] ?? { type: 'catPlaceTrap' }));
const nonExact = rootActions.filter((r) => r.bound !== 'exact');

// ===========================================================================
// A. the real entry makes EXACTLY ONE production planner call (§4: no extra
//    planning from duplicate searches) with the production budget/flags.
// ===========================================================================
test('RB2-A. one planner call per Hard turn, injected with production options', () => {
  expect(obs.calls).toBe(1);
  expect(obs.options.timeBudgetMs).toBe(DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn);
  expect(obs.options.refutation?.enabled).toBe(HARD_TRIAL.refutationEnabled);
  expect(obs.options.refutation?.totalTurnBudgetMs).toBe(HARD_TRIAL.totalTurnBudgetMs);
  expect(obs.options.leafEvaluator).toBe(resolveHardLeaf());
  expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
  expect(obs.options.leafEvaluator).toBe(evaluateForCat);
  expect(obs.options.rules).toBeTruthy();
  // the planner ran on the FROZEN ROOT, not on a mutated copy
  expect(stateKey(obs.rootAtPlanTime)).toBe(stateKey(root));
});

// ===========================================================================
// B. §3 item 9 — a PROVED (exact) candidate is never displaced by a bounded
//    one at the same (mate, value) rank, i.e. no false tie.
// ===========================================================================
test('RB2-B. root first action is never a false tie against a proved-exact candidate', () => {
  expect(planned.hasSolution).toBe(true);
  expect(planned.plan.length).toBeGreaterThan(0);
  if (!primary) return; // plan[0] came from a tie-break over certified records; recorded, not asserted away
  for (const r of rootActions) {
    if (r.value === primary.value && r.mate === primary.mate && r.bound === 'exact') {
      expect(
        primary.bound,
        `candidate ${dirKey(r.action)} is proved-exact at rank (mate=${r.mate}, value=${r.value}); ` +
        `the executed first action ${dirKey(primary.action)} (bound=${primary.bound}) may not displace it`,
      ).toBe('exact');
    }
  }
});

// ===========================================================================
// C. §3 items 5/6 + §4 — primary result vs overridden result vs final plan are
//    reported distinctly and are internally consistent.
// ===========================================================================
test('RB2-C. baselinePlan / final plan / debug record describe one consistent turn', () => {
  expect(label(debug.plan)).toBe(label(planned.plan));
  // `baselinePlan` = the PRIMARY search result, before any sidecar/guard override
  expect(label(debug.baselinePlan)).toBe(label(planned.search.catTurnPlan));
  expect(debug.completedDepth).toBe(planned.completedDepth);
  expect(debug.attemptedDepth).toBe(planned.attemptedDepth);
  expect(debug.rootValue).toBe(planned.search.value);
  expect(debug.mate).toBe(planned.search.mate);
  // `bestAction` is the search incumbent; `plan[0]` may differ from it ONLY
  // inside a PROVED tie (both candidates exact, same value + same mate) — that
  // is the equal-primary route optimisation over certified ties. A bounded
  // candidate reordering the first action would fail here (PPC-RB-1's bug).
  const incumbent = planned.bestAction
    ? rootActions.find((r) => dirKey(r.action) === dirKey(planned.bestAction!))
    : undefined;
  if (incumbent && primary && dirKey(incumbent.action) !== dirKey(primary.action)) {
    expect(incumbent.bound, `incumbent ${dirKey(incumbent.action)} is not proved-exact`).toBe('exact');
    expect(primary.bound, `plan[0] ${dirKey(primary.action)} is not proved-exact`).toBe('exact');
    expect(primary.value).toBe(incumbent.value);
    expect(primary.mate).toBe(incumbent.mate);
  }
  // an override must be labelled, and the label must agree with the plans
  const ref = debug.refutation;
  if (ref) {
    expect(ref.refutationEnabled).toBe(HARD_TRIAL.refutationEnabled);
    if (ref.selectedPlanSource === 'baseline') expect(ref.overrideUsed).toBe(false);
    if (!ref.overrideUsed) expect(label(planned.plan)).toBe(label(debug.baselinePlan));
  }
  // the history entry is the SAME turn, not a re-search
  if (entry) {
    expect(entry.stateKey).toBe(stateKey(root));
    expect(label(entry.production.plan)).toBe(label(planned.plan));
    expect(entry.production.completedDepth).toBe(planned.completedDepth);
  }
});

// ===========================================================================
// D. §4 — every plan action is legal in the REAL engine and the turn ends at a
//    legal boundary; no forced-move fallback (which would mean an illegal/stuck
//    action reached production execution).
// ===========================================================================
test('RB2-D. plan actions execute legally through the real engine to a legal boundary', () => {
  expect(planned.plan.every((a) => a.type === 'catStep' || a.type === 'catPlaceTrap')).toBe(true);
  expect(['COMPLETE_TURN_BOUNDARY', 'COMPLETE_CHANCE_BOUNDARY', 'GAME_ENDED', 'NO_LEGAL_ACTIONS', 'TRUNCATED'])
    .toContain(completeness.kind);
  expect(steps.every((s) => s.detail !== '强制移动')).toBe(true);

  // step chain is contiguous, moves never increase and never go negative
  let prevTo = { ...root.catPosition };
  let prevMoves = root.catMovesLeft;
  for (const s of steps) {
    expect(s.from).toEqual(prevTo);
    expect(s.state.catMovesLeft).toBeLessThanOrEqual(prevMoves);
    expect(s.state.catMovesLeft).toBeGreaterThanOrEqual(0);
    prevTo = s.to;
    prevMoves = s.state.catMovesLeft;
  }
  const last = steps[steps.length - 1].state;
  expect(last.phase !== GamePhase.Playing || last.currentPlayer !== PieceType.Cat || last.catMovesLeft === 0).toBe(true);

  // a TRUNCATED plan must be visible as an explicit fallback, never silent
  if (completeness.kind === 'TRUNCATED') {
    expect(fallbackMarkers.some((l) => l.includes('plan_exhausted'))).toBe(true);
  }
  if (entry) expect(typeof entry.execution.matchedPlan).toBe('boolean');
});

// ===========================================================================
// E. §4 — CAT→MOUSE handoff after the executed turn still follows GAMEPLAY
//    (4 cat moves, mouse gets its own budget; nothing about the fix re-times it).
// ===========================================================================
test('RB2-E. handoff after the executed Hard turn is the normal rules handoff', () => {
  const last = steps[steps.length - 1].state;
  if (last.phase !== GamePhase.Playing) return; // capture win ends the game — no handoff
  if (last.currentPlayer === PieceType.Cat) {
    expect(last.catMovesLeft).toBe(0);
    const handed = endTurn(last);
    expect(handed.currentPlayer).toBe(PieceType.Mouse);
    expect(handed.mouseMovesLeft).toBe(handed.mouseHasButter ? handed.config.mouseCarryingMoves : handed.config.mouseBaseMoves);
    // the hand-off tops up the NEXT actor only — the cat's empty budget is not
    // refilled by its own hand-off (same contract as turnHandoff T1f)
    expect(handed.catMovesLeft).toBe(0);
  } else {
    // the plan handed off inside the turn: the cat's budget must have run out
    expect(last.catMovesLeft).toBe(0);
  }
});

// ===========================================================================
// Reporting only — the 10 records §3 asks for. Nothing here asserts a value.
// ===========================================================================
test('RB2-R. G24T1 real-root record (reported, not pinned)', () => {
  console.info([
    '[RB2/G24T1] ===== one production Hard main-planning call through the real engine entry =====',
    `leaf mode            : ${HARD_LEAF_MODE_CONFIG.current}`,
    `budget (main/turn)   : ${obs.options.timeBudgetMs}ms / ${obs.options.refutation?.totalTurnBudgetMs}ms`,
    `planner calls        : ${obs.calls}`,
    `1 completedDepth     : ${planned.completedDepth} / attemptedDepth ${planned.attemptedDepth} (depthTurns max ${planned.search.iterations?.length ?? '-'})`,
    `2 rootValue / mate   : ${planned.search.value} / ${planned.search.mate}`,
    `3 bestAction         : ${label(planned.bestAction ? [planned.bestAction] : [])} (plan[0]=${label(planned.plan.slice(0, 1))})`,
    `4 rootActions        : ${rootActions.map((r) => `${dirKey(r.action)}=${r.value}/${r.bound}${r.mate ? `/${r.mate}` : ''}`).join(' ') || '(none published)'}`,
    `5 baselinePlan       : ${label(debug.baselinePlan)}`,
    `  finalPlan          : ${label(debug.plan)}  (executed: ${steps.map((s) => s.detail).join('→')})`,
    `6 sidecar override   : enabled=${debug.refutation?.refutationEnabled ?? 'absent'} triggered=${debug.refutation?.refutationTriggered ?? '-'} used=${debug.refutation?.overrideUsed ?? '-'} source=${debug.refutation?.selectedPlanSource ?? '-'} abort=${debug.refutation?.sidecarAbortReason ?? '-'}`,
    `  progressGuard      : ${debug.progressGuard ? `triggered=${debug.progressGuard.triggered} rescue=${debug.progressGuard.rescueApplied}` : 'absent'}`,
    `7 fallback           : markers=[${fallbackMarkers.join(' | ') || 'none'}] matchedPlan=${entry?.execution.matchedPlan ?? '-'} planCompleted=${planned.plan.length > 0}`,
    `8 legality/completeness: kind=${completeness.kind} reason=${completeness.reason} planLen=${planned.plan.length}`,
    `9 non-exact treated as tie: nonExactRootCandidates=${nonExact.length} primaryBound=${primary?.bound ?? 'n/a'} displacedProvedExact=${rootActions.some((r) => primary && r.value === primary.value && r.mate === primary.mate && r.bound === 'exact' && primary.bound !== 'exact')}`,
    `10 elapsed           : main search ${planned.elapsedMs.toFixed(2)}ms (budget ${obs.options.timeBudgetMs}ms, overBudget=${planned.elapsedMs > obs.options.timeBudgetMs}) totalNodes=${planned.search.diagnostics?.totalNodes ?? '-'} wholeTurnWall=${turnWallMs.toFixed(2)}ms (turn budget ${obs.options.refutation?.totalTurnBudgetMs}ms, overTurnBudget=${turnWallMs > (obs.options.refutation?.totalTurnBudgetMs ?? Infinity)})`,
    '=================================================================',
  ].join('\n'));
  expect(planned.completedDepth).toBeGreaterThanOrEqual(0);
});
