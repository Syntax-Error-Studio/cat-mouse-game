import type { GameEngineState } from '../engine';
import type { SearchAction } from './searchTypes';
import { generateLegalSearchActions } from './legalActions';
import { compareSearchScore, type RootActionRecord, type SearchContext } from './expectiminimax';
import {
  buildCandidate,
  compareCatTurnPlanQuality,
  isSearchDeadlineExceeded,
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
  rootActions: RootActionRecord[],
): SearchAction[] | null {
  // Guard: only when the root is a proven mouse-mate (forced loss for cat).
  if (rootActions.length === 0) return null;
  const anyMouseMate = rootActions.some((a) => a.mate === 'mouse');
  if (!anyMouseMate) return null;

  // PPC-RB1 / FIX-5: only a PROVED root score may take part in a forced-loss
  // primary tie. A 'lower'/'upper' entry is a one-sided bound produced by an
  // alpha-beta cutoff. A MISSING bound is unauthenticated — it is NOT exact and
  // must never be certified as such (`bound === 'exact'` is strict).
  const pool = rootActions.filter((a) => a.bound === 'exact');
  if (pool.length === 0) return null;

  // Find the best primary score among the proved root actions.
  let bestPrimary = pool[0];
  for (const a of pool) {
    if (compareSearchScore({ value: a.value, mate: a.mate }, { value: bestPrimary.value, mate: bestPrimary.mate }) > 0) {
      bestPrimary = a;
    }
  }

  // Collect all proved root actions whose primary score EXACTLY equals the best.
  const primaryEqual = pool.filter((a) =>
    compareSearchScore({ value: a.value, mate: a.mate }, { value: bestPrimary.value, mate: bestPrimary.mate }) === 0,
  );

  // If only one primary-equal action, no tie to break.
  if (primaryEqual.length <= 1) return null;

  // Guard: secondary only applies when ALL primary-equal are mouse-mate
  // (forced loss). If any non-mate is primary-equal, leave default behavior.
  if (!primaryEqual.every((a) => a.mate === 'mouse')) return null;

  // FIX-2: reuse the search's own deadline authority. If the time is already
  // gone, leave the search's plan untouched instead of starting extra work.
  if (isSearchDeadlineExceeded(ctx)) return null;

  // Build candidate plans using shared plan-quality module.
  const legal = generateLegalSearchActions(root, ctx.rules);
  const candidates: CandidatePlan[] = [];

  for (const pe of primaryEqual) {
    if (isSearchDeadlineExceeded(ctx)) return null;
    const originalIndex = legal.findIndex((a) => {
      if (a.type !== pe.action.type) return false;
      if (a.type === 'catStep') return a.direction!.key === (pe.action as { type: 'catStep'; direction: { key: string } }).direction!.key;
      return true;
    });
    const candidate = buildCandidate(root, pe.action, ctx, originalIndex >= 0 ? originalIndex : 999);
    // FIX-1: fail closed. If ANY proved primary-equal action cannot build a
    // COMPLETE full-turn plan (missing successor branch, truncated replay,
    // ambiguous CHANCE result, deadline), the selector has no admissible
    // comparison set. It must NOT fall back to the survivors — in particular it
    // must never return a sole candidate just because it was the only one that
    // built. The caller keeps the search's own plan.
    if (candidate === null) return null;
    candidates.push(candidate);
  }

  // ≥2 proved primary-equal actions existed (checked above); a selector that
  // only built one of them is not comparing anything.
  if (candidates.length < 2) return null;

  // Sort by G0.3A original lexicographic key (NO uniqueProgress).
  // This preserves the exact G0.3A behavior: reversal → revisit → boundaryEval → stable.
  candidates.sort((a, b) => compareCatTurnPlanQuality(a, b, 'forced-loss-original'));

  return candidates[0].plan;
}
