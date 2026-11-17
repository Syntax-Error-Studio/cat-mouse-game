import type { GameEngineState } from '../engine';
import { GamePhase, PieceType } from '../types';
import type { RuleSet, SearchAction } from './searchTypes';
import { simulateSearchAction, isNoOpAction } from './simulator';
import { stateKey } from './transposition';
import { generateLegalSearchActions } from './legalActions';
import { type SearchContext } from './expectiminimax';
import { evaluateForCat } from './evaluation';
import { catMoveBudgetRejectionReason, hasCertifiableCatMoveBudget, maxCatTurnPlanActions } from './planBound';

/**
 * PPC-FLT-FIX-1: the leaf evaluator the searching context ACTUALLY used.
 * Production Hard injects H1 (`evaluateCorrectedHoleForCat`); a context without
 * an injected evaluator keeps the Baseline. This is read-only — it never feeds
 * back into the search value.
 */
function activeLeafEvaluator(ctx: SearchContext): (s: GameEngineState) => number {
  return ctx.leafEvaluator ?? evaluateForCat;
}

/**
 * PPC-FLT-FIX-1: has the SAME wall-clock deadline authority the search used
 * already passed? Postprocessing must not start a second time window; it only
 * observes `ctx.deadlineMs` with `ctx.now` and, when time is gone, fails closed
 * so the caller keeps the plan the search itself produced. No deadline
 * configured → never exceeded (identical to the search's own gate).
 */
export function isSearchDeadlineExceeded(ctx: SearchContext): boolean {
  if (ctx.deadlineMs === undefined) return false;
  const clock = ctx.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  return clock() >= ctx.deadlineMs;
}

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

/** The one place the direction-opposite relation is defined. */
const OPPOSITE_DIRECTION: Record<string, string> = {
  ArrowUp: 'ArrowDown',
  ArrowDown: 'ArrowUp',
  ArrowLeft: 'ArrowRight',
  ArrowRight: 'ArrowLeft',
};

/**
 * Direction-key level opposite test.
 *
 * Exists so a prefix that is only remembered as a DIRECTION KEY (see
 * `PlanPrefixContext.prevCatStepKey`) can be scored against a real action
 * without manufacturing a dummy `SearchAction` for it. Keeps the opposite table
 * single-sourced.
 */
export function isOppositeDirection(aKey: string, bKey: string): boolean {
  return OPPOSITE_DIRECTION[aKey] === bKey;
}

export function isImmediateReversal(a: SearchAction, b: SearchAction): boolean {
  if (a.type !== 'catStep' || b.type !== 'catStep') return false;
  return isOppositeDirection(a.direction!.key, b.direction!.key);
}

export function countReversals(plan: SearchAction[]): number {
  let count = 0;
  for (let i = 1; i < plan.length; i++) {
    if (isImmediateReversal(plan[i - 1], plan[i])) count++;
  }
  return count;
}

/**
 * PPC-P1-QUALITY-01 — TRUE reversal count of a whole cat-turn plan, including
 * the edge that leaves an externally-supplied prefix.
 *
 * Why this exists: `countReversals(plan)` walks pairs INSIDE one array only.
 * The DP used to score a branch as
 *
 *     actionReversal + countReversals(childPlan)
 *
 * which charges the prefix→action edge and the interior of the child, but NOT
 * the edge `action → childPlan[0]` that the concatenation silently creates.
 * Two exactly-equal branches could therefore be ranked by a number that omitted
 * one edge each, and the extractor returned the plan with MORE real reversals
 * (registered as PPC-PLAN-001; see `BASELINE_REVERSAL_WITNESS.json`).
 *
 * Contract: given the prefix direction key and the FULL plan, every adjacent
 * pair is charged exactly once —
 *   1. prefix → plan[0]        (only when the prefix exists and both are steps)
 *   2. plan[i-1] → plan[i]     (every interior pair, i = 1..n-1)
 * There is no third source, so nothing can be counted twice. A non-`catStep`
 * action (`catPlaceTrap`) never forms a reversal on either side: it is not a
 * direction, so it breaks the chain rather than inventing an opposite.
 */
export function countPlanReversals(prefixCatStepKey: string | null, plan: SearchAction[]): number {
  if (plan.length === 0) return 0;
  let count = 0;
  const head = plan[0];
  if (prefixCatStepKey !== null && head.type === 'catStep' && isOppositeDirection(prefixCatStepKey, head.direction!.key)) {
    count++;
  }
  for (let i = 1; i < plan.length; i++) {
    if (isImmediateReversal(plan[i - 1], plan[i])) count++;
  }
  return count;
}

/** Append the cat's cell only when it actually changed (spatial movement). */
function pushCatCellIfChanged(positions: string[], state: GameEngineState): void {
  const cell = `${state.catPosition.r},${state.catPosition.c}`;
  if (cell !== positions[positions.length - 1]) positions.push(cell);
}

/** Number of repeated cells in a spatial sequence. */
function countDuplicateCells(positions: string[]): number {
  let revisits = 0;
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p)) revisits++;
    seen.add(p);
  }
  return revisits;
}

/**
 * Standalone count of cat-position revisits (for tests).
 *
 * PPC-FLT-FIX-1R: shares `buildCandidate`'s spatial semantics exactly — only a
 * real cat-position change is recorded (a zero-cost `catPlaceTrap` is not a
 * revisit, a box push that moves the cat is), and a final CAT→MOUSE CHANCE
 * boundary contributes its (outcome-agreed) final cell instead of being
 * skipped. The action sequence itself is never altered.
 */
export function countRevisits(root: GameEngineState, plan: SearchAction[], rules: RuleSet): number {
  const positions: string[] = [`${root.catPosition.r},${root.catPosition.c}`];
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind === 'chance') {
      const cells = new Set(t.outcomes.map((o) => `${o.state.catPosition.r},${o.state.catPosition.c}`));
      // No single spatial sequence to count if outcomes disagree; the candidate
      // builder rejects that case, so the helper stops rather than inventing one.
      if (cells.size === 1) {
        const cell = [...cells][0];
        if (cell !== positions[positions.length - 1]) positions.push(cell);
      }
      break;
    }
    cur = t.state;
    pushCatCellIfChanged(positions, cur);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return countDuplicateCells(positions);
}

// ---------------------------------------------------------------------------
// G0.4F-2B-1.9B — full-turn completeness invariant (pure helper)
// ---------------------------------------------------------------------------

/**
 * Replay a cat-turn plan from a fresh Playing Hard Cat root and classify the
 * end state against the FULL-TURN COMPLETENESS INVARIANT:
 *
 *   For a Playing fresh Hard Cat root, IF the plan completes normally AND the
 *   execution did NOT hit CatWins / game termination / explicit legal-action
 *   exhaustion, THEN replaying the plan must leave catMovesLeft === 0.
 *
 * Distinguishes the legitimately-complete cases (game over, no legal actions
 * left, turn boundary reached with 0 moves) from a TRUNCATED plan (the plan
 * ran out of actions while the cat still has moves and legal actions).
 *
 * A CAT→CHANCE transition on the final catStep (CAT→MOUSE ghost/debt boundary)
 * is a complete turn: the cat action itself is executed, the boundary resolves
 * via chance (never written into the plan), and catMovesLeft is 0.
 */
export type PlanCompletionVerdict =
  | { kind: 'COMPLETE_TURN_BOUNDARY'; catMovesLeft: 0; reason: string }
  | { kind: 'COMPLETE_CHANCE_BOUNDARY'; catMovesLeft: 0; reason: string }
  | { kind: 'GAME_ENDED'; phase: GamePhase; reason: string }
  | { kind: 'NO_LEGAL_ACTIONS'; catMovesLeft: number; reason: string }
  | { kind: 'TRUNCATED'; catMovesLeft: number; reason: string };

export function planFullTurnCompleteness(
  root: GameEngineState,
  plan: SearchAction[],
  rules: RuleSet,
): PlanCompletionVerdict {
  // PPC-P1-CLOSURE-FIX-01: the completeness invariant is stated over a turn that
  // spends a discrete budget. On a non-certifiable `catMovesLeft` (fractional /
  // NaN / ±Infinity / negative / a budget whose plan bound is not representable)
  // every downstream test is meaningless: `NaN > 0` is false, so the residual
  // check below would declare a truncated plan complete. Reject the ROOT before
  // replaying anything.
  const budgetRejection = catMoveBudgetRejectionReason(root.catMovesLeft);
  if (budgetRejection !== null) {
    return {
      kind: 'TRUNCATED',
      catMovesLeft: root.catMovesLeft,
      reason: `invalid cat move budget (${budgetRejection})`,
    };
  }
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind === 'chance') {
      // Final catStep ending at a CAT→MOUSE ghost/debt CHANCE boundary. The cat
      // action was executed; the boundary is resolved by the real engine later.
      // Completeness holds iff the cat's move budget was exhausted by this
      // action (chance only fires on move exhaustion — see
      // simulator.forceEndTurnIfNeeded).
      const movesBefore = cur.catMovesLeft;
      if (movesBefore <= 1) {
        return { kind: 'COMPLETE_CHANCE_BOUNDARY', catMovesLeft: 0, reason: 'final catStep -> ghost/debt CAT→MOUSE CHANCE boundary (moves exhausted)' };
      }
      return { kind: 'TRUNCATED', catMovesLeft: cur.catMovesLeft, reason: `chance transition with catMovesLeft=${movesBefore}>1 (unexpected for cat actions)` };
    }
    if (t.kind !== 'deterministic') {
      return { kind: 'TRUNCATED', catMovesLeft: cur.catMovesLeft, reason: 'unexpected transition kind' };
    }
    cur = t.state;
    if (cur.phase !== GamePhase.Playing) {
      return { kind: 'GAME_ENDED', phase: cur.phase, reason: 'game terminated during plan replay' };
    }
    if (cur.currentPlayer !== PieceType.Cat) {
      // Turn boundary reached (auto endTurn). Completeness requires the cat's
      // move budget to be exhausted (unless a zero-cost trap-collect ended it).
      if (cur.catMovesLeft === 0 || a.type === 'catPlaceTrap') {
        return { kind: 'COMPLETE_TURN_BOUNDARY', catMovesLeft: 0, reason: 'turn handed off to mouse' };
      }
      return { kind: 'TRUNCATED', catMovesLeft: cur.catMovesLeft, reason: 'turn handed off with catMovesLeft>0' };
    }
  }
  // Plan consumed but the cat still has moves left.
  if (cur.catMovesLeft > 0) {
    // Explicit legal-action exhaustion: no actions available → turn ends anyway.
    const legal = legalCatActionCount(cur, rules);
    if (legal === 0) {
      return { kind: 'NO_LEGAL_ACTIONS', catMovesLeft: cur.catMovesLeft, reason: 'plan ended with moves left but no legal actions' };
    }
    return { kind: 'TRUNCATED', catMovesLeft: cur.catMovesLeft, reason: `plan ended with catMovesLeft=${cur.catMovesLeft} > 0 and legal actions available` };
  }
  return { kind: 'COMPLETE_TURN_BOUNDARY', catMovesLeft: 0, reason: 'plan consumed all cat moves' };
}

function legalCatActionCount(s: GameEngineState, rules: RuleSet): number {
  return generateLegalSearchActions(s, rules).filter(a => a.type === 'catStep' || a.type === 'catPlaceTrap').length;
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
  // PPC-P1-PLAN-01: one shared, proven bound (see `planBound.ts`) instead of the
  // legacy constant 8 — the same number `buildCatTurnPlan` and
  // `extractBestCatTurnPlan` use.
  maxLength: number = maxCatTurnPlanActions(root),
): SearchAction[] {
  const plan: SearchAction[] = [];
  // PPC-P1-CLOSURE-FIX-01: no plan at all on a non-certifiable budget. Returning
  // `[]` (rather than a short "plausible" plan) is what makes every caller fail
  // closed: `buildCandidate` turns it into `null`, and completeness is never
  // asked about a turn whose budget is illegal.
  if (!hasCertifiableCatMoveBudget(root)) return plan;
  // Reject a non-cat / no-op action outright. A no-op would otherwise "walk"
  // without consuming the cat's turn and could be certified as a complete plan.
  if (firstAction.type !== 'catStep' && firstAction.type !== 'catPlaceTrap') return plan;
  if (isNoOpAction(root, firstAction, ctx.rules)) return plan;
  const trans = simulateSearchAction(root, firstAction, ctx.rules);
  plan.push(firstAction);
  // FIX-2: a CAT→MOUSE ghost/debt CHANCE boundary is a real cat action, not a
  // truncation. Keep it in the plan and let completeness certification decide.
  if (trans.kind === 'chance') return plan;
  if (trans.kind !== 'deterministic') return plan;
  let cur = trans.state;
  if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) return plan;

  const seen = new Set<string>([stateKey(root)]);
  while (plan.length < maxLength) {
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
    const key = stateKey(cur);
    if (seen.has(key)) break;
    seen.add(key);
    const action = ctx.planBranches.get(key);
    if (!action) break;
    if (action.type !== 'catStep' && action.type !== 'catPlaceTrap') break;
    // An unexplained no-op edge is not a usable branch: stop and let the
    // completeness verdict reject the (now shorter) plan.
    if (isNoOpAction(cur, action, ctx.rules)) break;
    plan.push(action);
    const t = simulateSearchAction(cur, action, ctx.rules);
    if (t.kind === 'chance') break;
    if (t.kind !== 'deterministic') break;
    cur = t.state;
  }
  return plan;
}

/** FIX-1: only a plan that provably completed the full cat turn is admissible. */
function isCompleteVerdict(verdict: PlanCompletionVerdict): boolean {
  return verdict.kind === 'COMPLETE_TURN_BOUNDARY'
    || verdict.kind === 'COMPLETE_CHANCE_BOUNDARY'
    || verdict.kind === 'GAME_ENDED'
    || verdict.kind === 'NO_LEGAL_ACTIONS';
}

const CHANCE_WEIGHT_SUM_TOLERANCE = 1e-6;

export function buildCandidate(
  root: GameEngineState,
  firstAction: SearchAction,
  ctx: SearchContext,
  originalIndex: number,
): CandidatePlan | null {
  // FIX-2: postprocessing reuses the search's OWN deadline authority; once it
  // is gone the override is abandoned (caller keeps the search's plan).
  if (isSearchDeadlineExceeded(ctx)) return null;
  const plan = buildPlanForFirstAction(root, firstAction, ctx);
  if (plan.length === 0) return null;

  // FIX-1: `plan.length > 0` is NOT completeness. A missing successor branch
  // (TT hit / unexpanded node) yields a short plan that would otherwise win the
  // secondary comparison by having fewer moves.
  const completeness = planFullTurnCompleteness(root, plan, ctx.rules);
  if (!isCompleteVerdict(completeness)) return null;

  const evaluate = activeLeafEvaluator(ctx);
  const positions: string[] = [`${root.catPosition.r},${root.catPosition.c}`];
  let cur = root;
  let reversalCount = 0;
  let boundaryEval: number | null = null;

  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    if (i > 0 && isImmediateReversal(plan[i - 1], a)) reversalCount++;
    const t = simulateSearchAction(cur, a, ctx.rules);
    if (t.kind === 'chance') {
      // Completeness already certified this as the FINAL cat action; anything
      // else would be a mid-turn CHANCE for a cat action and is not admissible.
      if (i !== plan.length - 1 || t.outcomes.length === 0) return null;
      if (isSearchDeadlineExceeded(ctx)) return null;
      // The ghost/debt boundary never moves the cat. All outcomes must agree on
      // the final cell, otherwise there is no single spatial sequence to score.
      const outcomeCells = new Set(t.outcomes.map((o) => `${o.state.catPosition.r},${o.state.catPosition.c}`));
      if (outcomeCells.size !== 1) return null;
      const finalCell = [...outcomeCells][0];
      if (finalCell !== positions[positions.length - 1]) positions.push(finalCell);
      // FIX-2: honest expectation over ALL outcomes — never outcomes[0], never
      // an UNKNOWN→0 fallback. Weights must be a valid simulator distribution.
      // PPC-FLT-FIX-1R: the deadline is re-checked around EVERY outcome leaf
      // evaluation. A single synchronous leaf call cannot be preempted, but once
      // time has run out the remaining outcomes are NOT evaluated, and no
      // partially accumulated expectation is ever committed (the function
      // returns null before assigning `boundaryEval`).
      let weightSum = 0;
      let weighted = 0;
      for (const o of t.outcomes) {
        if (isSearchDeadlineExceeded(ctx)) return null;
        if (!o.state || !Number.isFinite(o.weight) || o.weight < 0) return null;
        weightSum += o.weight;
        weighted += o.weight * evaluate(o.state);
        if (isSearchDeadlineExceeded(ctx)) return null;
      }
      if (!Number.isFinite(weightSum) || Math.abs(weightSum - 1) > CHANCE_WEIGHT_SUM_TOLERANCE) return null;
      if (!Number.isFinite(weighted)) return null;
      boundaryEval = weighted;
      break;
    }
    if (t.kind !== 'deterministic') return null;
    cur = t.state;
    // FIX-3: only a real cat-position change is a movement. A zero-cost trap
    // (and any other stationary action) must not be counted as a revisit.
    pushCatCellIfChanged(positions, cur);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }

  if (boundaryEval === null) {
    // Deterministic completion: turn boundary / game over / no legal actions.
    // The terminal state, when the game ended, is the ACTUAL final state.
    boundaryEval = evaluate(cur);
  }
  if (isSearchDeadlineExceeded(ctx)) return null;
  if (!Number.isFinite(boundaryEval)) return null;

  const revisitCount = countDuplicateCells(positions);
  const uniqueProgress = new Set(positions).size - 1;
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
 * PPC-P1-PLAN-01 — why the remaining capacity does NOT belong in the memo key.
 * `maxLength` is decremented along the recursion, so two paths that reach the
 * same state at different depths arrive with different remaining capacity. That
 * would make the cached `bestPlan` context-dependent — UNLESS the capacity can
 * never bind. It cannot: `maxCatTurnPlanActions(root)` is an upper bound on the
 * length of ANY legal action sequence from `root`, so for a path that has
 * already spent `k` actions the remaining capacity is `bound - k`, and
 * `k + (actions from here) ≤ bound` gives `bound - k ≥ (actions from here)`.
 * The cap is therefore a non-binding slack on every path, the `maxLength <= 0`
 * cut can only be reached by an ILLEGAL sequence, and the memo entry is a
 * function of (state, prefix) alone. The `maxLength` parameter keeps its
 * meaning for a caller that explicitly asks for a shorter cap; it is simply
 * never the binding constraint when it is the default.
 *
 * Fallback: if graph lookup misses (TT hit or no tie), uses planBranches
 * single-action walk (same as buildCatTurnPlan).
 */
export function extractBestCatTurnPlan(
  root: GameEngineState,
  rules: RuleSet,
  graph: EqualPrimaryGraph,
  planBranches: Map<string, SearchAction>,
  // PPC-P1-PLAN-01: same proven bound as every other extractor.
  maxLength: number = maxCatTurnPlanActions(root),
): SearchAction[] {
  // PPC-P1-CLOSURE-FIX-01: an illegal budget has no bound, so there is nothing
  // to extract. Fail closed with an empty plan; callers keep whatever the
  // search produced (or nothing), never a plan certified against a broken root.
  if (!hasCertifiableCatMoveBudget(root)) return [];
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
  // PPC-P1-CLOSURE-FIX-01: defensive re-check per node. A child of a legal root
  // always carries an integer budget (a catStep decrements by 1, `catPlaceTrap`
  // keeps it, `endTurn` reseeds it from `config.catBaseMoves`), so this only
  // fires if a state was hand-built outside the contract — and then it fails
  // closed instead of extending the plan on an unsound bound.
  if (!hasCertifiableCatMoveBudget(state)) return [];
  // PPC-P1-PLAN-01: with the default cap this cut is unreachable for a legal
  // sequence (see the memo-soundness note on `extractBestCatTurnPlan`); it stays
  // as the explicit answer for a caller that asked for a shorter cap.
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

    // Build child prefix context.
    const childPrefix: PlanPrefixContext = {
      prevCatStepKey: action.type === 'catStep' ? action.direction!.key : null,
    };

    let childPlan: SearchAction[];
    if (trans.kind === 'chance') {
      // G0.4F-2B-1.9B: a CHANCE transition for a CAT action can only occur on
      // the FINAL catStep of the turn (catMovesLeft -> 0 at a CAT→MOUSE
      // ghost/debt boundary — see simulator.forceEndTurnIfNeeded; catPlaceTrap
      // is always deterministic; cat actions never chance mid-turn). The CAT
      // action itself is still fully controlled by the cat and MUST remain in
      // the plan: append it and end this extraction branch. The CHANCE
      // outcomes (ghost spawn positions) are NOT cat actions and are never
      // written into the plan — production resolves materialization with the
      // real engine. Previously this branch did `continue`, silently dropping
      // the final cat action and producing a truncated plan (plan_exhausted).
      childPlan = [];
    } else {
      const childState = trans.state;
      const switched = state.currentPlayer !== childState.currentPlayer;

      if (switched || childState.phase !== GamePhase.Playing || childState.currentPlayer !== PieceType.Cat) {
        // Cat turn ended after this action.
        childPlan = [];
      } else {
        const childDepth = depthTurns - (switched ? 1 : 0);
        childPlan = extractDp(childState, rules, graph, planBranches, childDepth, childPrefix, memo, maxLength - 1, pathGuard);
      }
    }

    const fullPlan = [action, ...childPlan];
    // PPC-P1-QUALITY-01: score the CONCATENATED plan, not the two halves.
    // The old form `actionReversal + countReversals(childPlan)` charges the
    // prefix edge and the child's interior but drops the `action → childPlan[0]`
    // edge that the concatenation creates, so an exactly-equal branch that
    // walks back on itself could look as cheap as a straight line (PPC-PLAN-001).
    // `countPlanReversals` walks every adjacent pair of `fullPlan` exactly once
    // and is the single source of the reversal total.
    const totalReversal = countPlanReversals(prefix.prevCatStepKey, fullPlan);

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
