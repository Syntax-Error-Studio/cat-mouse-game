/**
 * G0.4F-2B-1.2 — H1 corrected-hole leaf (production, feature-flagged, DEFAULT OFF).
 *
 * H1 is a scope-limited fix for the PROVEN holeControl SIGN bug in the baseline
 * heuristic (G0.4F-1.1: HOLE_CONTROL_SIGN_BUG=TRUE; F2B-1 §4 G16 gate; F2B-1.1
 * H1_ELIGIBLE=TRUE). It corrects ONLY the both-reachable holeControl sign and
 * leaves every other contribution untouched.
 *
 * SINGLE-SOURCE (G0.4F-2B-1.2 §6): the corrected-hole math lives HERE, as pure
 * shared helpers. Hybrid V2 (hybridRouteLeaf.ts) uses the same helpers so there
 * is exactly ONE mathematical definition that can never drift. V2's numeric
 * behavior must be bit-identical before/after the refactor (proved by the
 * V2_NUMERIC_PARITY suite — maxAbsError = 0, never "approximately equal").
 *
 * Math (FROZEN — identical to Hybrid V2 semantics + offline F2B-1.1 H1):
 *   if catHoleGateDistance !== null AND mouseHoleGateDistance !== null:
 *       correctedMargin   = mouseHoleGateDistance - catHoleGateDistance
 *       correctedHoleCtrl = clamp(correctedMargin / boardSize, -1, 1)
 *                           * DEFAULT_EVALUATION_WEIGHTS.holeControl
 *       result = total - oldHoleControl + correctedHoleCtrl
 *   else:
 *       result = total                        (single-sided semantics unchanged)
 *
 * NOT in scope (deliberately absent): ghost forecast, box/trap/tunnel rewards,
 * history / loop penalty, ValueNet. The global `evaluateForCat` in
 * evaluation.ts is UNTOUCHED (baseline must stay as the rollback/control).
 */
import type { GameEngineState } from '../engine';
import { evaluateForCatDetailed, DEFAULT_EVALUATION_WEIGHTS, type EvaluationBreakdown } from './evaluation';

/**
 * The corrected holeControl CONTRIBUTION value for a breakdown:
 *   both-reachable → sign-fixed contribution;
 *   single-sided   → the original (unchanged) contribution.
 * Pure helper shared by H1 and Hybrid V2.
 */
export function correctedHoleControlValue(breakdown: EvaluationBreakdown, boardSize: number): number {
  const oldHoleControl = breakdown.contributions.holeControl;
  const { catHoleGateDistance, mouseHoleGateDistance } = breakdown.features;
  if (catHoleGateDistance !== null && mouseHoleGateDistance !== null) {
    const margin = mouseHoleGateDistance - catHoleGateDistance;
    return Math.max(-1, Math.min(1, margin / boardSize)) * DEFAULT_EVALUATION_WEIGHTS.holeControl;
  }
  return oldHoleControl;
}

/**
 * The corrected TOTAL for a breakdown: total − oldHoleControl + correctedHoleControl.
 * Pure helper shared by H1 and Hybrid V2. Single-sided states are untouched
 * (correctedHoleControlValue returns the old contribution → result === total).
 */
export function correctedHoleEvalTotal(breakdown: EvaluationBreakdown, boardSize: number): number {
  return breakdown.total - breakdown.contributions.holeControl + correctedHoleControlValue(breakdown, boardSize);
}

/** H1 production evaluator: corrected-hole heuristic total (no ValueNet, no ghost term). */
export function evaluateCorrectedHoleForCat(state: GameEngineState): number {
  const breakdown = evaluateForCatDetailed(state);
  return correctedHoleEvalTotal(breakdown, state.config.boardSize);
}
