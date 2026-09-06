/**
 * G0.4F-1.3 — Hybrid V2 (route-aware) leaf (production, feature-flagged, DEFAULT OFF).
 *
 * Math (FROZEN — G0.4F-1.1R/F1.1P/F1.2 confirmed candidate):
 *   correctedHoleControl:
 *     both cat/mouse gate distances non-null →
 *       margin = mouseHoleGateDistance − catHoleGateDistance
 *       correctedHoleControl = clamp(margin/boardSize, −1, 1) * holeControl weight
 *     single-sided (cat-can-mouse-cannot / mouse-can-cat-cannot) → keep old
 *     contribution semantics unchanged.
 *   correctedEval = total − oldHoleControl + correctedHoleControl
 *   routeContribution:
 *     mouseHasButter             → 0
 *     mouseWinRouteDistance null → +1        (no complete route → good for cat)
 *     else norm = clamp(route/(2*boardSize), 0, 1); contribution = −(1−norm)
 *   H = 0.5*tanh(correctedEval / S) + 0.5*productionValueNet(state) + 0.05*routeContribution
 *
 * STRICT eligibility: reuse isHybridEligibleState (canonical standard-map Hard
 * Playing only); anything else (custom map / wall / void / non-hard /
 * ChoosingTunnelExit / unsupported) → baseline evaluateForCat.
 *
 * FAIL-CLOSED (G0.4F-1.3 §4): any V2 fault (nonfinite model output, thrown
 * exception) falls DIRECTLY back to baseline evaluateForCat — never through
 * Hybrid V1. The fault-injectable core `evaluateHybridRouteV2Eligible(state,
 * valueNetFn)` lets tests inject a NaN/throwing model and assert the result is
 * exactly evaluateForCat(state).
 *
 * This module touches NO rules, NO search math, NO global evaluateForCat
 * (the known holeControl sign bug in evaluateForCat is NOT fixed globally; the
 * corrected holeControl comes from the SINGLE-SOURCE shared helper in
 * correctedHoleLeaf.ts, used by BOTH H1 and V2, keeping baseline/V1 frozen as
 * rollback/control). G0.4F-2B-1.2: the corrected-hole math was factored out of
 * V2 into that helper so the definition can never drift; V2 numeric behavior
 * is bit-identical (V2_NUMERIC_PARITY = 0).
 */
import { evaluateForCat, evaluateForCatDetailed } from './evaluation';
import { correctedHoleEvalTotal } from './correctedHoleLeaf';
import { productionValueNet, isHybridEligibleState } from './hybridLeaf';
import { HYBRID_S } from './hybridWeights';
import type { GameEngineState } from '../engine';

export const HYBRID_ROUTE_V2_MATH_FROZEN = {
  S: HYBRID_S,
  catWeight: 0.5,
  valueNetWeight: 0.5,
  routeWeight: 0.05,
} as const;

export type ValueNetFn = (state: GameEngineState) => number;

/**
 * Fault-injectable core: compute the eligible V2 value with an injected
 * valueNet function. The PRODUCTION wrapper calls this with
 * productionValueNet; tests inject () => NaN / throwing model.
 * Returns the final hybrid V2 value (finite) — caller decides fallback.
 */
export function evaluateHybridRouteV2Eligible(
  state: GameEngineState,
  valueNetFn: ValueNetFn = productionValueNet,
): number {
  const breakdown = evaluateForCatDetailed(state);
  const { mouseWinRouteDistance, mouseHasButter } = breakdown.features;
  const boardSize = state.config.boardSize;

  // Corrected holeControl — SINGLE-SOURCE shared helper (correctedHoleLeaf.ts).
  // G0.4F-2B-1.2 §6: the corrected-hole math must have exactly ONE definition
  // shared by H1 and Hybrid V2 so it can never drift. V2's numeric behavior is
  // bit-identical to the former inline math (proved by V2_NUMERIC_PARITY:
  // maxAbsError = 0, never "approximately equal").
  const correctedEval = correctedHoleEvalTotal(breakdown, boardSize);

  // Route contribution (pre-pickup urgency).
  let routeContribution: number;
  if (mouseHasButter) routeContribution = 0;
  else if (mouseWinRouteDistance === null) routeContribution = 1;
  else {
    const norm = Math.max(0, Math.min(1, mouseWinRouteDistance / (2 * boardSize)));
    routeContribution = -(1 - norm);
  }

  const v = valueNetFn(state);
  const h = 0.5 * Math.tanh(correctedEval / HYBRID_S) + 0.5 * v + 0.05 * routeContribution;
  return h;
}

/**
 * Production V2 wrapper: strict eligibility + DIRECT fail-closed to baseline.
 *
 *   if !isHybridEligibleState(state) → evaluateForCat(state)
 *   try { h = evaluateHybridRouteV2Eligible(state, productionValueNet);
 *         if (!finite) return evaluateForCat(state); return h; }
 *   catch { return evaluateForCat(state); }
 */
export function hybridRouteV2EvaluateForCat(state: GameEngineState): number {
  if (!isHybridEligibleState(state)) return evaluateForCat(state);
  try {
    const h = evaluateHybridRouteV2Eligible(state, productionValueNet);
    if (!Number.isFinite(h)) return evaluateForCat(state);
    return h;
  } catch {
    return evaluateForCat(state);
  }
}
