import type { GameEngineState } from '../engine';
import { GamePhase, PieceType } from '../types';
import type { RuleSet, SearchAction } from './searchTypes';
import { simulateSearchAction } from './simulator';
import { stateKey } from './transposition';
import { type SearchContext } from './expectiminimax';
import { evaluateForCat } from './evaluation';

/**
 * ============================================================================
 * G0.3E-R2 — Context-Aware Exact-Tie Plan Extraction.
 * ============================================================================
 *
 * ARCHITECTURE:
 *   1. Search records an equal-primary action graph (non-authoritative).
 *   2. Post-search, a context-aware DP extracts the best catTurnPlan.
 *
 * The graph records ALL fully-resolved primary-equal actions at cat MAX nodes
 * within the root cat turn. The extractor uses prefix-dependent reversal
 * comparison to choose the plan with the fewest immediate reversals.
 *
 * CONSTRAINTS:
 *   - Does NOT modify SearchValue.value / mate / bound / completed / cacheable;
 *   - Does NOT modify TT key/value;
 *   - Does NOT modify alpha-beta;
 *   - searchCallsPerTurn remains 1 (no second search);
 *   - Deterministic (root state + rules => same plan every time);
 *   - Does NOT use history / lastCatPosition / actionLog.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Equal-primary action graph
// ---------------------------------------------------------------------------

/** One graph node: a cat MAX state + its primary-equal actions. */
export interface EqualPrimaryNode {
  state: GameEngineState;
  equalActions: SearchAction[];
}

/** Graph: keyed by `${stateKey}|${depthTurns}` (search-context-aware identity). */
export type EqualPrimaryGraph = Map<string, EqualPrimaryNode>;

// ---------------------------------------------------------------------------
// Shared plan-quality primitives
// ---------------------------------------------------------------------------

export type QualityMode = 'forced-loss-original' | 'general';

export function dirKey(a: SearchAction): string {
  if (a.type === 'catStep') return a.direction!.key;
  return a.type;
}

export function isImmediateReversal(a: SearchAction, b: SearchAction): boolean {
  if (a.type !== 'catStep' || b.type !== 'catStep') return false;
  const OPPOSITES: Record<string, string> = {
    ArrowUp: 'ArrowDown',
    ArrowDown: 'ArrowUp',
    ArrowLeft: 'ArrowRight',
    ArrowRight: 'ArrowLeft',
  };
  return OPPOSITES[a.direction!.key] === b.direction!.key;
}

export function countReversals(plan: SearchAction[]): number {
  let count = 0;
  for (let i = 1; i < plan.length; i++) {
    if (isImmediateReversal(plan[i - 1], plan[i])) count++;
  }
  return count;
}

/** Standalone count of cat-position revisits (for tests). */
export function countRevisits(root: GameEngineState, plan: SearchAction[], rules: RuleSet): number {
  const positions: string[] = [`${root.catPosition.r},${root.catPosition.c}`];
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
    positions.push(`${cur.catPosition.r},${cur.catPosition.c}`);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  let revisits = 0;
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p)) revisits++;
    seen.add(p);
  }
  return revisits;
}

// ---------------------------------------------------------------------------
// Candidate plan construction (root-level, for G0.3A forcedLossTieBreak)
// ---------------------------------------------------------------------------

export interface CandidatePlan {
  firstAction: SearchAction;
  firstActionKey: string;
  plan: SearchAction[];
  reversalCount: number;
  revisitCount: number;
  uniqueProgress: number;
  boundaryEval: number;
  originalIndex: number;
}

export function buildPlanForFirstAction(
  root: GameEngineState,
  firstAction: SearchAction,
  ctx: SearchContext,
  maxLength = 8,
): SearchAction[] {
  const plan: SearchAction[] = [];
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

export function buildCandidate(
  root: GameEngineState,
  firstAction: SearchAction,
  ctx: SearchContext,
  originalIndex: number,
): CandidatePlan | null {
  const plan = buildPlanForFirstAction(root, firstAction, ctx);
  if (plan.length === 0) return null;
  const positions: string[] = [`${root.catPosition.r},${root.catPosition.c}`];
  let cur = root;
  let reversalCount = 0;
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    if (i > 0 && isImmediateReversal(plan[i - 1], a)) reversalCount++;
    const t = simulateSearchAction(cur, a, ctx.rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
    positions.push(`${cur.catPosition.r},${cur.catPosition.c}`);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  let revisitCount = 0;
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p)) revisitCount++;
    seen.add(p);
  }
  const uniqueProgress = new Set(positions).size - 1;
  const boundaryEval = evaluateForCat(cur);
  return {
    firstAction,
    firstActionKey: dirKey(firstAction),
    plan,
    reversalCount,
    revisitCount,
    uniqueProgress,
    boundaryEval,
    originalIndex,
  };
}

export function compareCatTurnPlanQuality(
  a: CandidatePlan,
  b: CandidatePlan,
  mode: QualityMode = 'general',
): number {
  if (a.reversalCount !== b.reversalCount) return a.reversalCount - b.reversalCount;
  if (a.revisitCount !== b.revisitCount) return a.revisitCount - b.revisitCount;
  if (mode === 'general') {
    if (a.uniqueProgress !== b.uniqueProgress) return b.uniqueProgress - a.uniqueProgress;
  }
  if (a.boundaryEval !== b.boundaryEval) return b.boundaryEval - a.boundaryEval;
  return a.originalIndex - b.originalIndex;
}

// ---------------------------------------------------------------------------
// G0.3E-R2: Context-aware plan extractor
// ---------------------------------------------------------------------------

/**
 * Prefix context for reversal-aware plan extraction.
 * Only the previous catStep direction matters for reversal detection.
 * catPlaceTrap and other non-catStep actions break the reversal chain
 * (isImmediateReversal returns false for non-catStep pairs).
 */
interface PlanPrefixContext {
  /** Direction key of the last catStep in the prefix, or null if none / last was non-catStep. */
  prevCatStepKey: string | null;
}

/**
 * Context-aware DP that extracts the best catTurnPlan from the equal-primary graph.
 *
 * At each state, looks up equalActions from the graph. For each action:
 *   1. Simulate via simulateSearchAction (real rules).
 *   2. If terminal / cat→mouse / cat turn ends → candidatePlan = [action].
 *   3. Else recurse with updated prefix context.
 *   4. Compare candidates by: fewer reversals → stable order.
 *
 * Memo key: (graphKey, prevCatStepKey) — correctly distinguishes the same
 * state under different prefix directions (e.g., after Down vs after Up).
 *
 * Fallback: if graph lookup misses (TT hit or no tie), uses planBranches
 * single-action walk (same as buildCatTurnPlan).
 */
export function extractBestCatTurnPlan(
  root: GameEngineState,
  rules: RuleSet,
  graph: EqualPrimaryGraph,
  planBranches: Map<string, SearchAction>,
  maxLength = 8,
): SearchAction[] {
  // Find the root's graph key. The root is at depth = the graph's depthTurns.
  // We need to discover which depthTurns the graph was recorded at.
  // The graph keys are `${stateKey}|${depthTurns}`. Try all possible depths.
  const rootKey = stateKey(root);
  let rootGraphKey: string | null = null;
  let rootDepth = 0;
  for (const gk of graph.keys()) {
    // Graph key format: `${stateKey}\x00${depthTurns}` (null byte separator,
    // since stateKey may contain '|' from pointSetKey).
    const sep = gk.lastIndexOf('\x00');
    if (sep >= 0 && gk.slice(0, sep) === rootKey) {
      rootGraphKey = gk;
      rootDepth = Number(gk.slice(sep + 1));
      break;
    }
  }

  // If root has no graph entry (no tie at root level), fall back to planBranches.
  if (!rootGraphKey) {
    return fallbackPlanWalk(root, rules, planBranches, maxLength);
  }

  // Run the context-aware DP.
  const memo = new Map<string, SearchAction[]>();
  const result = extractDp(root, rules, graph, planBranches, rootDepth, { prevCatStepKey: null }, memo, maxLength, new Set<string>());
  return result;
}

/**
 * Recursive DP. Returns the best catTurnPlan from this state under the given
 * prefix context, using the equal-primary graph.
 */
function extractDp(
  state: GameEngineState,
  rules: RuleSet,
  graph: EqualPrimaryGraph,
  planBranches: Map<string, SearchAction>,
  depthTurns: number,
  prefix: PlanPrefixContext,
  memo: Map<string, SearchAction[]>,
  maxLength: number,
  pathGuard: Set<string>,
): SearchAction[] {
  // Boundary: cat turn ended.
  if (state.phase !== GamePhase.Playing || state.currentPlayer !== PieceType.Cat) {
    return [];
  }
  if (maxLength <= 0) return [];

  const sk = stateKey(state);
  const graphKey = `${sk}\x00${depthTurns}`;
  const memoKey = `${graphKey}#${prefix.prevCatStepKey ?? 'null'}`;

  // Check memo.
  const cached = memo.get(memoKey);
  if (cached) return cached;

  // Check path guard (prevent zero-cost loops).
  if (pathGuard.has(sk)) return [];
  pathGuard.add(sk);

  // Look up equal actions from graph.
  const graphNode = graph.get(graphKey);

  let actionsToTry: SearchAction[];
  if (graphNode && graphNode.equalActions.length > 1) {
    // Graph has multiple equal-primary actions — try them all.
    actionsToTry = graphNode.equalActions;
  } else {
    // No tie recorded — fall back to planBranches single action.
    const singleAction = planBranches.get(sk);
    if (singleAction) {
      actionsToTry = [singleAction];
    } else {
      pathGuard.delete(sk);
      return [];
    }
  }

  let bestPlan: SearchAction[] = [];
  let bestReversal = Infinity;

  for (const action of actionsToTry) {
    const trans = simulateSearchAction(state, action, rules);
    if (trans.kind !== 'deterministic') {
      continue;
    }

    const childState = trans.state;
    const switched = state.currentPlayer !== childState.currentPlayer;

    // Compute reversal contribution of this action.
    let actionReversal = 0;
    if (action.type === 'catStep' && prefix.prevCatStepKey !== null) {
      const dummyPrev: SearchAction = { type: 'catStep', direction: { key: prefix.prevCatStepKey, dr: 0, dc: 0, label: '' } };
      if (isImmediateReversal(dummyPrev, action)) actionReversal = 1;
    }

    // Build child prefix context.
    const childPrefix: PlanPrefixContext = {
      prevCatStepKey: action.type === 'catStep' ? action.direction!.key : null,
    };

    let childPlan: SearchAction[];
    if (switched || childState.phase !== GamePhase.Playing || childState.currentPlayer !== PieceType.Cat) {
      // Cat turn ended after this action.
      childPlan = [];
    } else {
      const childDepth = depthTurns - (switched ? 1 : 0);
      childPlan = extractDp(childState, rules, graph, planBranches, childDepth, childPrefix, memo, maxLength - 1, pathGuard);
    }

    const fullPlan = [action, ...childPlan];
    const totalReversal = actionReversal + countReversals(childPlan);

    if (totalReversal < bestReversal || (totalReversal === bestReversal && bestPlan.length === 0)) {
      bestPlan = fullPlan;
      bestReversal = totalReversal;
    }
    // Tie on reversal → stable order (first in actionsToTry wins, already handled by <).
  }

  pathGuard.delete(sk);
  memo.set(memoKey, bestPlan);
  return bestPlan;
}

/** Fallback: walk planBranches from root (same as buildCatTurnPlan). */
function fallbackPlanWalk(
  root: GameEngineState,
  rules: RuleSet,
  planBranches: Map<string, SearchAction>,
  maxLength: number,
): SearchAction[] {
  const plan: SearchAction[] = [];
  let cur = root;
  const seen = new Set<string>();
  while (plan.length < maxLength) {
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
    const key = stateKey(cur);
    if (seen.has(key)) break;
    seen.add(key);
    const action = planBranches.get(key);
    if (!action) break;
    plan.push(action);
    const t = simulateSearchAction(cur, action, rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
  }
  return plan;
}

// We need planBranches in extractDp fallback. Let's pass it through.
// Actually, the graph already has the state, and if no graph entry exists,
// we should use the planBranches map. Let me refactor to pass planBranches.

// generalTieBreak removed in R2 — replaced by extractBestCatTurnPlan.
