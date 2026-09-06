import type { GameEngineState } from '../engine';
import type { RuleSet, SearchAction } from './searchTypes';
import { searchBestActionIterative, type IterativeSearchResult, type MateSide } from './expectiminimax';
import { evaluateForCat, evaluateForCatDetailed } from './evaluation';
import {
  runRefutationSidecar, shouldRunSidecar, runBoundedProbe,
  FIXED_PATHS, FIXED_CPU_MS, FIXED_EXACT,
  type RefutationDiagnostics,
} from './boundedPlanRefutation';
// G0.4F-2B-1.6 — M3-lite Progress Guard (imports the production helper + the
// feature flag; NO ai-training/ imports).
import {
  replayCatPlanLabel, progressGuardEligible, progressGuardTrigger,
  type HardProgressGuardMemory,
} from './progressGuard';
import { HARD_PROGRESS_GUARD_CONFIG, HARD_LEAF_MODE_CONFIG } from './searchConfig';
import { enumerateFullTurnLegacy } from './turnBoundary';
import { stateKey } from './transposition';
import { GamePhase, PieceType } from '../types';

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
  /** G0.3W: bounded plan-refutation sidecar diagnostics (compact scalars only;
   *  excluded from stateKey like the rest of this debug record). Absent when
   *  the feature is OFF. */
  refutation?: RefutationDiagnostics;
  /** G0.3X: the baseline cat-turn plan BEFORE any refutation override (the
   *  primary-search result). Equal to `plan` when no override was used. */
  baselinePlan: SearchAction[];
  /** G0.4F-2B-1.6: M3-lite Progress-Guard diagnostics (compact; excluded from
   *  stateKey). Absent when the feature is OFF or the turn predates 1.6. */
  progressGuard?: ProgressGuardDebug;
}

/** G0.4F-2B-1.6: compact M3-lite guard debug (mirrors ProgressGuardDiag). */
export interface ProgressGuardDebug {
  enabled: boolean;
  eligible: boolean;
  previousNoProgressLoop: boolean;
  currentNoProgressLoop: boolean;
  signatureMatch: boolean;
  mouseTurnObserved: boolean;
  triggered: boolean;
  previousCompletedDepth: number | null;
  previousCompletedPlan: string;
  originalPlan: string;
  rescuePlan: string;
  exactImmediateMouseWins: number;
  rescueProbeStatus: string | null;
  rescueApplied: boolean;
  abortReason: string;
  guardMs: number;
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
  /**
   * G0.3W: FEATURE-FLAGGED bounded plan-refutation sidecar. Default OFF. When
   * OFF (or absent) the planner is bit-identical to the pre-trial behavior.
   * When ON, after the baseline search completes, a bounded adversarial mouse
   * refutation probe may override the baseline catTurnPlan under the frozen
   * G0.3V rules. `totalTurnBudgetMs` (if given) is the TOTAL turn budget in ms
   * (baseline + sidecar); the sidecar only uses the remaining time and is cut
   * (INCOMPLETE) at that deadline. `timeBudgetMs` (baseline) is NEVER changed.
   */
  refutation?: {
    enabled: boolean;
    totalTurnBudgetMs?: number;
  };
  /**
   * G0.4F-2B-1.6 — M3-lite Progress Guard (DEFAULT OFF via
   * HARD_PROGRESS_GUARD_CONFIG.enabled). Optional knobs for tests:
   *   - `passGuardMemory` lets the caller inject the policy memory that the
   *     planner reads as previous-turn context (production reads it from the
   *     state; tests can simulate a specific history).
   *     When absent, the planner reads `state.hardProgressGuardMemory`.
   * The guard NEVER runs a second main search; it may only replace `plan` with
   * `search.previousCompletedPlan` after all safety gates.
   */
  progressGuard?: {
    passMemory?: HardProgressGuardMemory | null;
    totalTurnBudgetMs?: number;
  };
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

  let plan = search.catTurnPlan;
  let refutation: RefutationDiagnostics | undefined;

  // ---- G0.3W sidecar (feature-flagged, default OFF) ----
  if (opts.refutation?.enabled) {
    const refStart = now();
    const gate = shouldRunSidecar({
      difficulty: String(state.config.difficulty),
      phase: state.phase,
      currentPlayer: state.currentPlayer,
      baselinePlanLegal: search.completed && search.catTurnPlan.length > 0,
      baselineCompleted: search.completed,
      baselineMate: search.mate,
      enabled: true,
    });
    // External total-turn deadline (absolute). Baseline budget is UNCHANGED;
    // the sidecar only uses the remaining time after the baseline search.
    const totalBudgetMs = opts.refutation.totalTurnBudgetMs ?? elapsedMs;
    const totalDeadlineMs = t0 + totalBudgetMs;
    const remaining = totalDeadlineMs - now();
    if (!gate) {
      refutation = {
        refutationEnabled: true,
        refutationTriggered: false,
        candidateCount: 0,
        baselineProbeStatus: null,
        baselineRefutationWitness: [],
        candidatesProbed: 0,
        candidateStatuses: [],
        pathCount: 0,
        exactLocalChecks: 0,
        refutationCpuMs: 0,
        refutationWallMs: 0,
        overrideEligible: false,
        overrideUsed: false,
        selectedPlanSource: 'baseline',
        sidecarAbortReason: !search.completed || search.mate !== null
          ? (search.mate !== null ? 'mate_bypass' : 'baseline_not_refuted')
          : 'baseline_not_refuted',
      };
    } else if (remaining <= 0) {
      // Total deadline already exhausted by the baseline search → sidecar never
      // starts; fall back to baseline (INCOMPLETE-equivalent, no partial leak).
      refutation = {
        refutationEnabled: true,
        refutationTriggered: false,
        candidateCount: 0,
        baselineProbeStatus: null,
        baselineRefutationWitness: [],
        candidatesProbed: 0,
        candidateStatuses: [],
        pathCount: 0,
        exactLocalChecks: 0,
        refutationCpuMs: 0,
        refutationWallMs: 0,
        overrideEligible: false,
        overrideUsed: false,
        selectedPlanSource: 'baseline',
        sidecarAbortReason: 'deadline',
      };
    } else {
      const sidecar = runRefutationSidecar(state, search.catTurnPlan, search.value, {
        rules: opts.rules,
        totalDeadlineMs,
        now,
        enabled: true,
      });
      plan = sidecar.plan;
      refutation = { ...sidecar.diagnostics, refutationWallMs: now() - refStart };
    }
  }

  // ---- G0.4F-2B-1.6: M3-lite Progress Guard (root rescue policy, after refutation) ----
  let progressGuardDebug: ProgressGuardDebug | undefined;
  {
    const guardEnabled = HARD_PROGRESS_GUARD_CONFIG.enabled;
    if (guardEnabled) {
      // G0.4F-2B-1.6R §7/§8: absolute total-turn deadline computed ONCE from
      // plannerStart (t0) + the TOTAL turn budget — the SAME semantics the
      // refutation sidecar uses. The guard never receives a fresh 150ms window.
      const totalBudgetMs = opts.refutation?.enabled
        ? (opts.refutation.totalTurnBudgetMs ?? 150)
        : (opts.progressGuard?.totalTurnBudgetMs ?? opts.timeBudgetMs);
      const absoluteTotalDeadlineMs = t0 + totalBudgetMs;
      const guardResult = runProgressGuard({
        state, plan, search, refutation, opts, now,
        passMemory: opts.progressGuard?.passMemory,
        totalBudgetMs,
        absoluteTotalDeadlineMs,
      });
      if (guardResult.applied) {
        plan = guardResult.rescuePlan!;
        if (opts.refutation?.enabled) {
          refutation = refutation ? { ...refutation, selectedPlanSource: 'baseline' } : refutation;
        }
      }
      progressGuardDebug = guardResult.debug;
    } else {
      progressGuardDebug = {
        enabled: false, eligible: false, previousNoProgressLoop: false,
        currentNoProgressLoop: false, signatureMatch: false, mouseTurnObserved: false,
        triggered: false, previousCompletedDepth: null, previousCompletedPlan: '',
        originalPlan: planLabelOf(plan), rescuePlan: '', exactImmediateMouseWins: 0,
        rescueProbeStatus: null, rescueApplied: false, abortReason: 'disabled', guardMs: 0,
      };
    }
  }

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
    refutation,
    baselinePlan: search.catTurnPlan,
    progressGuard: progressGuardDebug,
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

/** Compact plan label (same token scheme as the debug UI / f2b15). */
function planLabelOf(plan: SearchAction[]): string {
  return plan.map(a => a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?').join('');
}

/**
 * G0.4F-2B-1.6 — M3-lite Progress Guard (root rescue policy, run AFTER the
 * bounded refutation sidecar). ALL of the §19/§20/§21/§23/§24-26 gates must
 * pass before the final plan may be replaced by `search.previousCompletedPlan`
 * (R1). Any failure aborts the guard and keeps the current plan.
 *
 * Security model:
 *   - enabled ∧ eligible scope (§19) — hard + baseline_hole_corrected +
 *     mouseHasButter + no ghosts/debt + mate==null + completedDepth>=2
 *   - refutation interaction (§20): only when selectedPlanSource==baseline AND
 *     baselineProbeStatus==NO_REFUTATION_FOUND (else SKIP).
 *   - trigger (§8/§21): previous executed no-progress loop memory + current
 *     plan is a no-progress loop + same signature + mouseTurnObserved.
 *   - R1 = search.previousCompletedPlan (§22) — production never uses R2.
 *   - rescue legality (§23) — real replay: valid, complete, NON_LOOP.
 *   - exact immediate mouse win (§24-25): enumerate ALL legal Mouse full turns
 *     from the rescue's cat-end; any MouseWins terminal → REJECT.
 *   - rescue bounded probe (§26): runBoundedProbe on the rescue Mouse root MUST
 *     be NO_REFUTATION_FOUND; PLAN_REFUTED/INCOMPLETE/CHANCE_MIXED → fail-closed.
 *   - deadline (§27): guard only uses the REMAINING total-turn time; if a stage
 *     would exceed it → abort, keep original plan (no budget increase).
 */
/**
 * G0.4F-2B-1.6R §15: pure gate — may the bounded-refutation status allow a
 * Progress-Guard rescue? ONLY a clean NO_REFUTATION_FOUND permits the rescue;
 * PLAN_REFUTED / INCOMPLETE / CHANCE_MIXED fail closed (keep original plan).
 * Shared by production and tests (no overclaim: each status is really tested).
 */
export function rescueProbeAllows(status: string | null | undefined): boolean {
  return status === 'NO_REFUTATION_FOUND';
}

export function runProgressGuard(args: {
  state: GameEngineState;
  plan: SearchAction[];
  search: IterativeSearchResult;
  refutation?: RefutationDiagnostics;
  opts: HardTurnPlanOptions;
  now: () => number;
  passMemory?: HardProgressGuardMemory | null;
  totalBudgetMs?: number;
  /** G0.4F-2B-1.6R: ABSOLUTE total-turn deadline from planner start (t0 +
   *  totalTurnBudgetMs), shared with the refutation sidecar. The guard must NOT
   *  receive its own fresh budget window. */
  absoluteTotalDeadlineMs?: number;
}): { applied: boolean; rescuePlan: SearchAction[] | null; debug: ProgressGuardDebug } {
  const { state, plan, search, refutation, opts, now } = args;
  const t0 = now();
  // G0.4F-2B-1.6R §7: the Total-turn deadline is an ABSOLUTE time computed ONCE
  // at planner start (planHardCatTurn t0 + totalTurnBudgetMs) and SHARED by the
  // bounded-refutation sidecar AND the Progress Guard. We must NOT recompute a
  // fresh budget from guardStart (that would hand the guard a new 150ms).
  // `args.absoluteTotalDeadlineMs` is set by planHardCatTurn; tests may inject
  // a fake monotonic clock to make the whole budget already consumed.
  const totalDeadlineMs = args.absoluteTotalDeadlineMs ?? (t0 + (args.totalBudgetMs ?? opts.timeBudgetMs));
  const leafMode = HARD_LEAF_MODE_CONFIG.current;
  const enabled = HARD_PROGRESS_GUARD_CONFIG.enabled;

  const baseDebug = (partial: Partial<ProgressGuardDebug>): ProgressGuardDebug => ({
    enabled, eligible: false, previousNoProgressLoop: false, currentNoProgressLoop: false,
    signatureMatch: false, mouseTurnObserved: false, triggered: false,
    previousCompletedDepth: null, previousCompletedPlan: '',
    originalPlan: planLabelOf(plan), rescuePlan: '', exactImmediateMouseWins: 0,
    rescueProbeStatus: null, rescueApplied: false, abortReason: '', guardMs: now() - t0,
    ...partial,
  });

  // The policy memory: production reads state.hardProgressGuardMemory; tests
  // may inject one.
  const memory = args.passMemory !== undefined ? args.passMemory : (state.hardProgressGuardMemory ?? null);

  // §19 eligibility.
  const eligible = progressGuardEligible(state, leafMode, enabled, {
    completedDepth: search.completedDepth,
    mate: search.mate,
    previousCompletedPlanLength: search.previousCompletedPlan.length,
  });
  if (!eligible) {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: false, abortReason: 'ineligible' }) };
  }

  // §20 refutation interaction.
  const source = refutation?.selectedPlanSource ?? 'baseline';
  const baselineStatus = refutation?.baselineProbeStatus ?? null;
  if (source !== 'baseline') {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: true, abortReason: 'refutation_override' }) };
  }
  if (refutation !== undefined && baselineStatus !== 'NO_REFUTATION_FOUND') {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: true, abortReason: `refutation_current_${baselineStatus ?? 'null'}` }) };
  }

  // G0.4F-2B-1.6R §10: CHEAP previous-memory fast path — before ANY current-plan
  // replay / feature extraction / enumeration / probe. If the previous executed
  // turn cannot possibly be a repeated no-progress loop, the guard is exactly
  // guaranteed NOT to trigger, so we return immediately. This is a pure
  // short-circuit of the trigger semantics — never a semantic change.
  const prev = memory;
  const prevNoProgress = prev?.previousNoProgressLoop ?? false;
  const prevSig = prev?.previousSignature ?? null;
  const mouseObserved = prev?.mouseTurnObserved ?? false;
  if (!prev || !prevNoProgress || !prevSig || !mouseObserved) {
    return {
      applied: false, rescuePlan: null,
      debug: baseDebug({ eligible: true, abortReason: 'no_previous_repeat_context' }),
    };
  }

  // §8/§21 current plan facts.
  const currentLabel = planLabelOf(plan);
  if (currentLabel.length === 0) {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: true, abortReason: 'empty_plan' }) };
  }
  const currentFacts = replayCatPlanLabel(state, currentLabel);
  const sigMatch = prevNoProgress && prevSig !== null && currentFacts.signature !== null &&
    JSON.stringify(prevSig) === JSON.stringify(currentFacts.signature);
  const g = progressGuardTrigger({
    previous: prev,
    currentFacts,
    realMouseTurnElapsed: mouseObserved,
  });
  const trig = g.trigger;
  if (!trig) {
    return {
      applied: false, rescuePlan: null,
      debug: baseDebug({
        eligible: true, previousNoProgressLoop: prevNoProgress,
        currentNoProgressLoop: currentFacts.noProgressLoop, signatureMatch: sigMatch,
        mouseTurnObserved: mouseObserved, triggered: false,
        abortReason: 'no_trigger',
      }),
    };
  }

  // deadline check before rescue work.
  if (now() >= totalDeadlineMs) {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: true, previousNoProgressLoop: prevNoProgress, currentNoProgressLoop: true, signatureMatch: true, mouseTurnObserved: true, triggered: true, abortReason: 'deadline' }) };
  }

  // R1 = previous completed plan.
  const rescue = search.previousCompletedPlan;
  const rescueLabel = planLabelOf(rescue);
  if (rescue.length === 0) {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: true, previousNoProgressLoop: prevNoProgress, currentNoProgressLoop: true, signatureMatch: true, mouseTurnObserved: true, triggered: true, previousCompletedDepth: search.previousCompletedDepth, previousCompletedPlan: resumeLabelOrEmpty(search.previousCompletedPlan), abortReason: 'no_previous_plan' }) };
  }

  // §23 rescue legality + non-loop via real replay.
  const rescueFacts = replayCatPlanLabel(state, rescueLabel);
  if (!rescueFacts.valid || !rescueFacts.fullTurnConsumed || rescueFacts.closedLoop) {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: true, previousNoProgressLoop: prevNoProgress, currentNoProgressLoop: true, signatureMatch: true, mouseTurnObserved: true, triggered: true, previousCompletedDepth: search.previousCompletedDepth, previousCompletedPlan: rescueLabel, originalPlan: currentLabel, rescuePlan: rescueLabel, exactImmediateMouseWins: 0, rescueProbeStatus: null, abortReason: 'rescue_illegal_or_loop' }) };
  }

  // §25 exact immediate mouse win from rescue cat-end → Mouse root (real rules).
  const mouseRoot = rescueFacts.endState ? mouseRootFromCatEnd(rescueFacts.endState, opts.rules) : null;
  if (!mouseRoot) {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: true, previousNoProgressLoop: prevNoProgress, currentNoProgressLoop: true, signatureMatch: true, mouseTurnObserved: true, triggered: true, previousCompletedDepth: search.previousCompletedDepth, previousCompletedPlan: rescueLabel, originalPlan: currentLabel, rescuePlan: rescueLabel, abortReason: 'no_mouse_root' }) };
  }
  const wins = exactImmediateMouseWins(mouseRoot, opts.rules);
  if (wins > 0) {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: true, previousNoProgressLoop: prevNoProgress, currentNoProgressLoop: true, signatureMatch: true, mouseTurnObserved: true, triggered: true, previousCompletedDepth: search.previousCompletedDepth, previousCompletedPlan: rescueLabel, originalPlan: currentLabel, rescuePlan: rescueLabel, exactImmediateMouseWins: wins, rescueProbeStatus: null, abortReason: 'exact_mouse_win' }) };
  }

  // deadline again before the probe.
  if (now() >= totalDeadlineMs) {
    return { applied: false, rescuePlan: null, debug: baseDebug({ eligible: true, previousNoProgressLoop: prevNoProgress, currentNoProgressLoop: true, signatureMatch: true, mouseTurnObserved: true, triggered: true, previousCompletedDepth: search.previousCompletedDepth, previousCompletedPlan: rescueLabel, originalPlan: currentLabel, rescuePlan: rescueLabel, exactImmediateMouseWins: 0, abortReason: 'deadline' }) };
  }

  // §26 rescue bounded probe.
  const probe = runBoundedProbe(mouseRoot, opts.rules, {
    maxPaths: FIXED_PATHS, maxCpuMs: FIXED_CPU_MS, maxExact: FIXED_EXACT,
    externalDeadlineMs: totalDeadlineMs, now,
  });
  const probeStatus = probe.status;
  if (!rescueProbeAllows(probeStatus)) {
    return {
      applied: false, rescuePlan: null,
      debug: baseDebug({
        eligible: true, previousNoProgressLoop: prevNoProgress, currentNoProgressLoop: true,
        signatureMatch: true, mouseTurnObserved: true, triggered: true,
        previousCompletedDepth: search.previousCompletedDepth, previousCompletedPlan: rescueLabel,
        originalPlan: currentLabel, rescuePlan: rescueLabel, exactImmediateMouseWins: 0,
        rescueProbeStatus: probeStatus, abortReason: `rescue_probe_${probeStatus}`,
      }),
    };
  }

  // Applied.
  return {
    applied: true, rescuePlan: rescue,
    debug: baseDebug({
      eligible: true, previousNoProgressLoop: prevNoProgress, currentNoProgressLoop: true,
      signatureMatch: true, mouseTurnObserved: true, triggered: true,
      previousCompletedDepth: search.previousCompletedDepth, previousCompletedPlan: rescueLabel,
      originalPlan: currentLabel, rescuePlan: rescueLabel, exactImmediateMouseWins: 0,
      rescueProbeStatus: probeStatus, rescueApplied: true, abortReason: 'none',
    }),
  };
}

function resumeLabelOrEmpty(plan: SearchAction[]): string {
  return plan.map(a => a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?').join('');
}

/** Build the Mouse root after the cat's turn: real endTurn hand-off, ghost
 *  resolution already handled (eligibility requires ghost/debt == 0). */
function mouseRootFromCatEnd(catEnd: GameEngineState, rules: RuleSet): GameEngineState | null {
  if (catEnd.currentPlayer !== PieceType.Cat) return null;
  try {
    const next = rules.endTurn(catEnd);
    if (next.currentPlayer === PieceType.Mouse) return next;
    return null;
  } catch {
    return null;
  }
}

/** Count MouseWins terminals across ALL legal Mouse full turns (real rules). */
function exactImmediateMouseWins(mouseRoot: GameEngineState, rules: RuleSet): number {
  const ends = enumerateFullTurnLegacy(mouseRoot, rules);
  const seen = new Set<string>();
  let wins = 0;
  for (const t of ends.terminals) {
    const k = stateKey(t.state);
    if (seen.has(k)) continue;
    seen.add(k);
    if (t.state.phase === GamePhase.MouseWins) wins++;
  }
  return wins;
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