import type { GameEngineState } from '../engine';
import type { RuleSet, SearchAction } from './searchTypes';
import { searchBestActionIterative, type IterativeSearchResult } from './expectiminimax';
import { evaluateForCat } from './evaluation';

/**
 * ============================================================================
 * F1B-3 — Hard turn planner (ONE main search per cat turn)
 * ============================================================================
 *
 * This is the PRODUCTION entry point for the Hard (Search) difficulty. It is a
 * thin wrapper over the iterative-deepening Expectiminimax search, wired with
 * the HARD production profile:
 *
 *   - leafEvaluator = evaluateForCat  (E1 evaluator, injected per F1B-6;
 *                                      `defaultLeafEval` stays the test/standalone
 *                                      default inside expectiminimax)
 *   - Alpha-Beta pruning  ON
 *   - Transposition table ON
 *   - Move ordering       ON
 *   - WALL-CLOCK deadline = now() + timeBudgetMs   (F1A-2 real deadline)
 *   - maxNodes safety valve                       (F1A-2 hard cap)
 *
 * The whole budget (`timeBudgetMs`) is the budget for the ENTIRE cat turn — a
 * normal turn performs exactly ONE main search (F1B-3). The plan for the turn
 * comes from that single search's principal line (F1B-2, `catTurnPlan`).
 *
 * DEPENDENCY INJECTION (F1B-1): this module imports NO engine-function import
 * at runtime — it receives the `RuleSet` from the caller (engine provides the
 * real transition adapter via its own `createEngineRuleSet`). This is what
 * keeps the graph acyclic:
 *
 *   engine.ts ──> ai/hardTurnPlanner ──> ai/expectiminimax / ai/evaluation
 *   ai/*       ──(type-only)──> engine
 */

/** One per-cat-turn planner call's summary (for trajectory + diagnostics). */
export interface HardTurnPlan {
  /** The current cat turn's principal-line plan (may be empty on fallback). */
  plan: SearchAction[];
  /** The single best first action (same as plan[0] when a plan exists). */
  bestAction: SearchAction | null;
  /** Deepest fully-completed search depth (0 => not even depth-1 completed). */
  completedDepth: number;
  /** Deepest attempted depth. */
  attemptedDepth: number;
  /** True iff at least depth-1 completed (a valid answer exists). */
  hasSolution: boolean;
  /** True iff the search hit the wall-clock deadline (vs the node budget). */
  deadlineFired: boolean;
  /** True iff the search hit the maxNodes safety valve. */
  budgetFired: boolean;
  /** Internal iterative-search result (diagnostics, iterations, values). */
  search: IterativeSearchResult;
}

/** Options for one Hard cat-turn plan. `rules` is INJECTED by the caller (engine). */
export interface HardTurnPlanOptions {
  rules: RuleSet;
  /** Whole-cat-turn think budget in ms (from timeBudgetMsPerCatTurn). */
  timeBudgetMs: number;
  /** Node safety valve for the whole iterative search (default 500_000). */
  maxNodes?: number;
  /** Max search depth in turns (default 4). */
  maxDepthTurns?: number;
  /** Monotonic clock (default performance.now) — tests inject fake clocks. */
  now?: () => number;
  /** Optional per-call leaf override (default evaluateForCat). */
  leafEvaluator?: (state: GameEngineState) => number;
}

/**
 * Plan one full cat turn using ONE main search.
 *
 * A normal call performs exactly ONE `searchBestActionIterative` (iterative
 * deepening internally re-searches per depth, but that is ONE planner call). A
 * NEVER-per-step re-search here — this is the whole turn budget.
 *
 * Returns `hasSolution=false` with an empty plan when not even depth-1
 * completed (deadline/budget too tight) — the trajectory must fall back to the
 * legacy heuristic, never block or crash.
 */
export function planHardCatTurn(
  state: GameEngineState,
  opts: HardTurnPlanOptions,
): HardTurnPlan {
  const now = opts.now ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
  const deadlineMs = now() + opts.timeBudgetMs;

  const search = searchBestActionIterative(state, {
    rules: opts.rules,
    maxDepthTurns: opts.maxDepthTurns ?? 4,
    maxNodes: opts.maxNodes ?? 500_000,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    leafEvaluator: opts.leafEvaluator ?? evaluateForCat,
    deadlineMs,
    now,
  });

  return {
    plan: search.catTurnPlan,
    bestAction: search.bestAction,
    completedDepth: search.completedDepth,
    attemptedDepth: search.attemptedDepth,
    hasSolution: search.completed,
    deadlineFired: search.deadlineExceeded,
    budgetFired: search.budgetExhausted,
    search,
  };
}