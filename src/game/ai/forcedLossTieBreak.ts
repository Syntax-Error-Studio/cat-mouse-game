import type { GameEngineState } from '../engine';
import type { SearchAction } from './searchTypes';
import { generateLegalSearchActions } from './legalActions';
import { compareSearchScore, type SearchContext, type MateSide } from './expectiminimax';
import {
  buildCandidate,
  compareCatTurnPlanQuality,
  type CandidatePlan,
} from './planQuality';

/**
 * ============================================================================
 * G0.3A — Forced-Loss Resistance Tie-Break (plan-selection side channel).
 * ============================================================================
 *
 * WHEN: only at the ROOT, after a COMPLETED search, when:
 *   - root mate === 'mouse' (the cat is in a proven forced-loss position), AND
 *   - two or more root actions have EXACTLY the same primary SearchScore
 *     (value + mate).
 *
 * WHAT: selects which catTurnPlan to return among the primary-equal candidates,
 * using the shared `compareCatTurnPlanQuality` lexicographic secondary key
 * (G0.3E extracted). The primary comparator is completely unchanged.
 *
 * G0.3E extends this mechanism to ALL exact-primary ties (not just forced-loss).
 * This function is preserved for backward compatibility and the G0.3A test
 * fixtures. Both paths use the same shared quality comparator.
 * ============================================================================
 */

/**
 * Given the root state + search context (with planBranches populated from a
 * COMPLETED search), find all primary-equal forced-loss root actions and select
 * the best plan by the secondary lexicographic key.
 *
 * Returns the winning plan, or null if tie-break does not apply (e.g. root
 * is not forced-loss, or only one action is primary-equal).
 */
export function forcedLossTieBreak(
  root: GameEngineState,
  ctx: SearchContext,
  rootActions: { action: SearchAction; value: number; mate: MateSide }[],
): SearchAction[] | null {
  // Guard: only when the root is a proven mouse-mate (forced loss for cat).
  if (rootActions.length === 0) return null;
  const anyMouseMate = rootActions.some((a) => a.mate === 'mouse');
  if (!anyMouseMate) return null;

  // Find the best primary score among root actions.
  let bestPrimary = rootActions[0];
  for (const a of rootActions) {
    if (compareSearchScore({ value: a.value, mate: a.mate }, { value: bestPrimary.value, mate: bestPrimary.mate }) > 0) {
      bestPrimary = a;
    }
  }

  // Collect all root actions whose primary score EXACTLY equals the best.
  const primaryEqual = rootActions.filter((a) =>
    compareSearchScore({ value: a.value, mate: a.mate }, { value: bestPrimary.value, mate: bestPrimary.mate }) === 0,
  );

  // If only one primary-equal action, no tie to break.
  if (primaryEqual.length <= 1) return null;

  // Guard: secondary only applies when ALL primary-equal are mouse-mate
  // (forced loss). If any non-mate is primary-equal, leave default behavior.
  if (!primaryEqual.every((a) => a.mate === 'mouse')) return null;

  // Build candidate plans using shared plan-quality module.
  const legal = generateLegalSearchActions(root, ctx.rules);
  const candidates: CandidatePlan[] = [];

  for (const pe of primaryEqual) {
    const originalIndex = legal.findIndex((a) => {
      if (a.type !== pe.action.type) return false;
      if (a.type === 'catStep') return a.direction!.key === (pe.action as { type: 'catStep'; direction: { key: string } }).direction!.key;
      return true;
    });
    const candidate = buildCandidate(root, pe.action, ctx, originalIndex >= 0 ? originalIndex : 999);
    if (candidate) candidates.push(candidate);
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].plan;

  // Sort by G0.3A original lexicographic key (NO uniqueProgress).
  // This preserves the exact G0.3A behavior: reversal → revisit → boundaryEval → stable.
  candidates.sort((a, b) => compareCatTurnPlanQuality(a, b, 'forced-loss-original'));

  return candidates[0].plan;
}
