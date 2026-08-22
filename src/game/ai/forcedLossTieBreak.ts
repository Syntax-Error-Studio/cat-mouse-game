import type { GameEngineState } from '../engine';
import { GamePhase, PieceType } from '../types';
import type { RuleSet, SearchAction } from './searchTypes';
import { simulateSearchAction } from './simulator';
import { generateLegalSearchActions } from './legalActions';
import { stateKey } from './transposition';
import { compareSearchScore, type SearchContext, type MateSide } from './expectiminimax';
import { evaluateForCat } from './evaluation';

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
 * using a lexicographic secondary key that NEVER touches the search value / TT /
 * alpha-beta. The primary comparator is completely unchanged.
 *
 * SECONDARY ORDER (lexicographic, first non-zero wins):
 *   1. fewer immediate reversals in the cat-turn plan
 *   2. fewer cat-position revisits within the cat-turn plan
 *   3. higher evaluateForCat at the boundary (end-of-cat-turn) state
 *   4. stable original-legal-order (deterministic fallback)
 *
 * CONSTRAINTS:
 *   - does NOT modify SearchValue.value / mate / bound / completed / cacheable;
 *   - does NOT modify TT key/value;
 *   - does NOT modify alpha-beta;
 *   - does NOT modify SearchContext;
 *   - searchCallsPerTurn remains 1 (no second search);
 *   - deterministic (root state + rules => same plan every time);
 *   - does NOT use history / lastCatPosition / actionLog.
 * ============================================================================
 */

/** A candidate plan with its secondary metrics pre-computed. */
interface CandidatePlan {
  firstAction: SearchAction;
  firstActionKey: string;
  plan: SearchAction[];
  reversalCount: number;
  revisitCount: number;
  boundaryEval: number;
  originalIndex: number;
}

/** Direction key for reversal detection. */
function dirKey(a: SearchAction): string {
  if (a.type === 'catStep') return a.direction!.key;
  return a.type;
}

/** True iff `b` is the immediate opposite direction of `a` (both catStep). */
function isImmediateReversal(a: SearchAction, b: SearchAction): boolean {
  if (a.type !== 'catStep' || b.type !== 'catStep') return false;
  const OPPOSITES: Record<string, string> = {
    ArrowUp: 'ArrowDown',
    ArrowDown: 'ArrowUp',
    ArrowLeft: 'ArrowRight',
    ArrowRight: 'ArrowLeft',
  };
  return OPPOSITES[a.direction!.key] === b.direction!.key;
}

/**
 * Build the catTurnPlan for a given FIRST root action by walking the search's
 * own decision log (planBranches), starting from the root state, following the
 * first action, then continuing along planBranches while the actor stays Cat.
 */
function buildPlanForFirstAction(
  root: GameEngineState,
  firstAction: SearchAction,
  ctx: SearchContext,
  maxLength = 8,
): SearchAction[] {
  const plan: SearchAction[] = [];
  // Apply first action.
  const trans = simulateSearchAction(root, firstAction, ctx.rules);
  if (trans.kind !== 'deterministic') return plan;
  let cur = trans.state;
  plan.push(firstAction);
  if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) return plan;

  const seen = new Set<string>([stateKey(root)]);
  while (plan.length < maxLength) {
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
    const key = stateKey(cur);
    if (seen.has(key)) break;
    seen.add(key);
    const action = ctx.planBranches.get(key);
    if (!action) break;
    plan.push(action);
    const t = simulateSearchAction(cur, action, ctx.rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
  }
  return plan;
}

/** Replay a cat-turn plan through the REAL rules to get the boundary state. */
function replayToBoundary(root: GameEngineState, plan: SearchAction[], rules: RuleSet): GameEngineState {
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return cur;
}

/** Count immediate reversals in a plan. */
function countReversals(plan: SearchAction[]): number {
  let count = 0;
  for (let i = 1; i < plan.length; i++) {
    if (isImmediateReversal(plan[i - 1], plan[i])) count++;
  }
  return count;
}

/** Count cat-position revisits (excluding the starting position). */
function countRevisits(root: GameEngineState, plan: SearchAction[], rules: RuleSet): number {
  const positions: string[] = [`${root.catPosition.r},${root.catPosition.c}`];
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
    const pos = `${cur.catPosition.r},${cur.catPosition.c}`;
    if (positions.includes(pos)) {
      // revisit
    }
    positions.push(pos);
  }
  let revisits = 0;
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p)) revisits++;
    seen.add(p);
  }
  return revisits;
}

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

  // Build candidate plans for each primary-equal first action.
  const legal = generateLegalSearchActions(root, ctx.rules);
  const candidates: CandidatePlan[] = [];

  for (const pe of primaryEqual) {
    const originalIndex = legal.findIndex((a) => {
      if (a.type !== pe.action.type) return false;
      if (a.type === 'catStep') return a.direction!.key === (pe.action as { type: 'catStep'; direction: { key: string } }).direction!.key;
      return true;
    });
    const plan = buildPlanForFirstAction(root, pe.action, ctx);
    if (plan.length === 0) continue;
    const boundary = replayToBoundary(root, plan, ctx.rules);
    const boundaryEval = evaluateForCat(boundary);
    candidates.push({
      firstAction: pe.action,
      firstActionKey: dirKey(pe.action),
      plan,
      reversalCount: countReversals(plan),
      revisitCount: countRevisits(root, plan, ctx.rules),
      boundaryEval,
      originalIndex: originalIndex >= 0 ? originalIndex : 999,
    });
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].plan;

  // Sort by secondary lexicographic key:
  // 1. fewer reversals
  // 2. fewer revisits
  // 3. higher boundary eval
  // 4. stable original order
  candidates.sort((a, b) => {
    if (a.reversalCount !== b.reversalCount) return a.reversalCount - b.reversalCount;
    if (a.revisitCount !== b.revisitCount) return a.revisitCount - b.revisitCount;
    if (a.boundaryEval !== b.boundaryEval) return b.boundaryEval - a.boundaryEval;
    return a.originalIndex - b.originalIndex;
  });

  return candidates[0].plan;
}