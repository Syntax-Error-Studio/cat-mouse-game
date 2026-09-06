/**
 * G0.4F-2B-1.9B §11/§12 — single current-turn execution truth.
 *
 * ONE pure result object for the executed cat turn, derived from per-turn
 * FACTS collected during the trajectory (never from scanning the cumulative
 * catActionLog — that log is whole-game; historical SEARCH_FALLBACK entries
 * must not pollute the CURRENT turn's matched / clean status, see §9/§10).
 *
 * matchedPlan semantics (§12): true ONLY when
 *   - the executed CAT-controlled plan actions equal the final production plan
 *     action-by-action (every plan action was applied successfully), AND
 *   - the turn completed to a legal boundary (all cat moves consumed, or the
 *     game ended along the planned line — a capture win), AND
 *   - NO plan_exhausted / plan_action_invalid / no_hard_plan / trajectory
 *     fallback replaced or truncated a plan action this turn.
 *
 * Note: a ghost/chance outcome at the CAT→MOUSE boundary does NOT make
 * matched=false — the cat's own actions followed the plan; the chance is
 * resolved by the engine later (production path).
 */
import type { SearchAction } from './searchTypes';

export interface HardTurnExecutionStatus {
  /** The final production plan for this turn (may be empty on no_hard_plan). */
  plannedPlan: SearchAction[];
  /** The plan actions ACTUALLY applied successfully this turn (prefix of
   *  plannedPlan up to any fallback). */
  appliedPlanActions: SearchAction[];
  /** True iff every plannedPlan action was applied (plan ran to completion). */
  planCompleted: boolean;
  /** True iff any fallback fired THIS turn (plan_exhausted / no_hard_plan /
   *  trajectory_fallback). plan_action_invalid is reported separately. */
  fallbackOccurred: boolean;
  /** True iff a plan action failed validation (plan_action_invalid) this turn. */
  invalidActionOccurred: boolean;
  /** True iff the cat turn ended at a legal boundary (catMovesLeft==0, or the
   *  game ended — CatWins/MouseWins — along the planned line). */
  reachedLegalBoundary: boolean;
  /** Derived single truth: see docstring above. */
  matchedPlan: boolean;
}

export interface ExecutionFacts {
  plannedPlan: SearchAction[];
  appliedPlanActions: SearchAction[];
  planCompleted: boolean;
  fallbackOccurred: boolean;
  invalidActionOccurred: boolean;
  catMovesExhausted: boolean;
  gameEndedDuringTurn: boolean;
}

/**
 * Pure derivation of the current-turn execution status from per-turn facts.
 * No global-log access. `gameEndedDuringTurn` counts as a legal boundary only
 * when it happened along the planned line (i.e. no fallback superseded it).
 */
export function buildHardTurnExecutionStatus(facts: ExecutionFacts): HardTurnExecutionStatus {
  const fallbackOccurred = facts.fallbackOccurred || facts.invalidActionOccurred;
  const reachedLegalBoundary = facts.catMovesExhausted || facts.gameEndedDuringTurn;
  const matchedPlan =
    !fallbackOccurred &&
    facts.planCompleted &&
    reachedLegalBoundary &&
    facts.appliedPlanActions.length === facts.plannedPlan.length;
  return {
    plannedPlan: facts.plannedPlan,
    appliedPlanActions: facts.appliedPlanActions,
    planCompleted: facts.planCompleted,
    fallbackOccurred: facts.fallbackOccurred,
    invalidActionOccurred: facts.invalidActionOccurred,
    reachedLegalBoundary,
    matchedPlan,
  };
}