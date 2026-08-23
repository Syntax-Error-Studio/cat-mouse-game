import type { GameEngineState } from '../engine';
import type { RuleSet, SearchAction } from './searchTypes';
import { searchBestActionIterative, type IterativeSearchResult, type MateSide } from './expectiminimax';
import { evaluateForCat, evaluateForCatDetailed } from './evaluation';

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
  /** Wall-clock spent on the single main search for this turn (ms). */
  elapsedMs: number;
  /** HARD_SEARCH debug record (rendered by the UI debug panel with copy). */
  debug: HardSearchDebug;
}

/** EVAL ROOT breakdown shown in the HARD_SEARCH debug panel. */
export interface HardSearchEvalRoot {
  mouseGoalThreat: number;
  /** Two-stage mouse win route distance (null = no complete route). */
  mouseWinRoute: string;
  holeControl: number;
  /** Cat→mouse path distance (null = unreachable). */
  captureDistance: string;
  voronoi: number;
  trapControl: number;
  tunnelControl: number;
  tempo: number;
  total: number;
}

/** The per-Hard-turn debug record (persisted into the game state + UI). */
export interface HardSearchDebug {
  cat: { r: number; c: number };
  mouse: { r: number; c: number };
  mouseHasButter: boolean;
  completedDepth: number;
  attemptedDepth: number;
  nodes: number;
  elapsedMs: number;
  rootValue: number;
  mate: MateSide;
  plan: SearchAction[];
  rootActions: { action: SearchAction; value: number; mate: MateSide }[];
  evalRoot: HardSearchEvalRoot;
  /** G0.3B: threat-aware search diagnostics. */
  extensionsTriggered: number;
  extendedNodes: number;
  criticalLeaves: number;
  extensionAbortCount: number;
  /** G0.3B: max extension credits consumed beyond nominal horizon on any path. */
  maxExtensionDepth: number;
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
  const t0 = now();
  const deadlineMs = t0 + opts.timeBudgetMs;

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
    // G0.3B FINAL: selective threat extension FAILED real-snapshot validation
    // (REAL Turn5: completedDepth 1→0, empty-plan fallback 10/20). Production
    // is rolled back to 0 credits; the extension machinery stays in the code
    // base for experiments/forensics only (see G0.3B report).
    maxThreatExtensions: 0,
  });
  const elapsedMs = now() - t0;

  const plan = search.catTurnPlan;
  const debug: HardSearchDebug = {
    cat: { r: state.catPosition.r, c: state.catPosition.c },
    mouse: { r: state.mousePosition.r, c: state.mousePosition.c },
    mouseHasButter: state.mouseHasButter,
    completedDepth: search.completedDepth,
    attemptedDepth: search.attemptedDepth,
    nodes: search.diagnostics.totalNodes,
    elapsedMs,
    rootValue: search.value,
    mate: search.mate,
    plan,
    rootActions: search.rootActions,
    evalRoot: buildEvalRoot(state),
    extensionsTriggered: search.diagnostics.extensionsTriggered,
    extendedNodes: search.diagnostics.extendedNodes,
    criticalLeaves: search.diagnostics.criticalLeaves,
    extensionAbortCount: search.diagnostics.extensionAbortCount,
    maxExtensionDepth: search.diagnostics.maxExtensionDepth,
  };

  return {
    plan,
    bestAction: search.bestAction,
    completedDepth: search.completedDepth,
    attemptedDepth: search.attemptedDepth,
    hasSolution: search.completed,
    deadlineFired: search.deadlineExceeded,
    budgetFired: search.budgetExhausted,
    search,
    elapsedMs,
    debug,
  };
}

/** EVAL_ROOT breakdown of the ROOT state (via evaluateForCatDetailed). */
function buildEvalRoot(state: GameEngineState): HardSearchEvalRoot {
  try {
    const b = evaluateForCatDetailed(state);
    return {
      mouseGoalThreat: b.contributions.mouseGoalThreat,
      mouseWinRoute: b.features.mouseWinRouteDistance === null
        ? 'unreachable'
        : String(b.features.mouseWinRouteDistance),
      holeControl: b.contributions.holeControl,
      captureDistance: b.features.catMouseDistance === null
        ? 'unreachable'
        : String(b.features.catMouseDistance),
      voronoi: b.contributions.voronoiBalance,
      trapControl: b.contributions.trapControl,
      tunnelControl: b.contributions.tunnelControl,
      tempo: b.contributions.tempo,
      total: b.total,
    };
  } catch {
    // The debug panel must never take the game down.
    return {
      mouseGoalThreat: NaN,
      mouseWinRoute: 'n/a',
      holeControl: NaN,
      captureDistance: 'n/a',
      voronoi: NaN,
      trapControl: NaN,
      tunnelControl: NaN,
      tempo: NaN,
      total: NaN,
    };
  }
}