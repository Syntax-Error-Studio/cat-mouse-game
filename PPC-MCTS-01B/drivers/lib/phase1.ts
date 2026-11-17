/**
 * PPC-MCTS-01B-HARNESS-REPAIR — Phase 1 arm runner (fixed COMPLETED simulations).
 *
 * Both arms are driven by the SAME stop seam (`maxCompletedSimulations`), which
 * fires only at the top of the simulation loop, i.e. after a simulation has
 * completed and been backpropagated. `maxNodes` keeps its production value
 * (500 000) purely as a safety net: if it ever fires first the call is an
 * EXECUTION ANOMALY, not a shorter experiment, and it must be reported as such.
 *
 * The clock is frozen (`now() => 0`), so the wall deadline can never intervene
 * and the number of simulations is decided by K alone.
 */
import { createHash } from 'node:crypto';
import type { GameEngineState } from '../../../src/game/engine';
import { createEngineRuleSet } from '../../../src/game/engine';
import type { RuleSet, SearchAction } from '../../../src/game/ai/searchTypes';
import { stateKey } from '../../../src/game/ai/transposition';
import { actionLabel } from '../../../PPC-MCTS-01/proto/replay';
import { UctSearchBaseline } from '../../proto/uctBaseline';
import type { UctResult as UctResultBaseline } from '../../proto/uctBaseline';
import { UctSearchPrepared } from '../../proto/uctPrepared';
import type { UctResult as UctResultPrepared } from '../../proto/uctPrepared';
import { TraceCollector } from '../../proto/trace';
import { countingRules } from './arms';

// ---------------------------------------------------------------------------
// frozen experimental contract (see PHASE1_PREREGISTRATION.json)
// ---------------------------------------------------------------------------
export const PHASE1_ROOTS = 24;
export const PHASE1_REPETITIONS = 20;
export const PHASE1_ARMS = 2;
export const COMPLETED_SIMULATIONS_PER_CALL = 200;
export const PHASE1_MAX_HANDOFFS = 4;
/** Production value, kept as a safety net only. Never the reason to stop. */
export const PHASE1_MAX_NODES = 500_000;
export const PHASE1_TOTAL_SEARCH_CALLS = PHASE1_ROOTS * PHASE1_REPETITIONS * PHASE1_ARMS;
export const PHASE1_FRESH_NODE_PROCESSES = PHASE1_REPETITIONS;

export type Phase1Arm = 'UCT-H-BASELINE' | 'UCT-H-PREPARED';

export interface ArmResultLike {
  root: unknown;
  plan: SearchAction[];
  planCost: number;
  planExtended: boolean;
  treePlanLength: number;
  extensionSteps: number;
  rootAction: SearchAction | null;
  rootActionStats: {
    action: SearchAction; key: string; transitionKind: string;
    visits: number; meanReward: number; totalReward: number; childStateKey: string | null;
  }[];
  rootVisits: number;
  rootMeanReward: number;
  diagnostics: {
    simulations: number; abortedSimulations: number; nodesCreated: number;
    chanceNodes: number; chanceSamples: number; maxChanceMassError: number;
    rolloutSteps: number; maxHandoffsReached: number; elapsedMs: number;
    deadlineHit: boolean; nodeCapHit: boolean; postDeadlineNodeCreations: number;
    completedSimulationLimitHit: boolean;
  };
  chanceSamples: number;
  planTraceDigest: string | null;
}

export interface Phase1Run {
  arm: Phase1Arm;
  result: ArmResultLike;
  trace: TraceCollector;
  digests: string[];
  wallMs: number;
  ruleCalls: number;
  /** Math.random draws consumed during this arm (stub or guard). */
  mathRandomDraws: number;
}

export interface Phase1RunOptions {
  /** Exactly how many COMPLETE simulations to run. Defaults to the contract K. */
  completedSimulations?: number;
  /** Retain the full event body of this one simulation (mismatch forensics). */
  captureSimulation?: number | null;
  capturePlan?: boolean;
  /** Rollout policy. Phase 1 uses hybrid on both arms; `random` is extra breadth. */
  rollout?: 'hybrid' | 'random';
  /** Node safety cap. Production 500 000; only lowered for breadth probes. */
  maxNodes?: number;
  /**
   * Math.random discipline.
   *   number (default 0x5eed) → install a fixed-seed LCG stub so that the ONE
   *     known impurity (`sanitizeItemOverlaps` relocating a butter under the
   *     trap, reached only via `catMove`) is reproducible on both arms.
   *   null → install the throw-on-call guard. A draw then aborts the call, which
   *     is the correct behaviour when the caller wants to PROVE the run is pure.
   */
  mathRandomSeed?: number | null;
}

/**
 * Run one arm under the fixed-completed-simulation workload.
 *
 * `deadlineMs: 1` with `now() => 0` gives `deadlineAt = 1` and a clock that
 * never advances, so `deadlineHit` can only be false. Together with K this makes
 * the workload a pure function of the root, the seed and the arm's decisions.
 */
export function runPhase1Arm(
  arm: Phase1Arm,
  state: GameEngineState,
  seed: string,
  opts: Phase1RunOptions = {},
): Phase1Run {
  const trace = new TraceCollector({
    captureSimulation: opts.captureSimulation ?? null,
    capturePlan: opts.capturePlan ?? false,
  });
  const counter = countingRules(createEngineRuleSet());
  const options = {
    rules: counter.rules,
    deadlineMs: 1,
    maxHandoffs: PHASE1_MAX_HANDOFFS,
    maxNodes: opts.maxNodes ?? PHASE1_MAX_NODES,
    c: Math.SQRT2,
    seed,
    rollout: opts.rollout ?? ('hybrid' as const),
    now: () => 0,
    maxCompletedSimulations: opts.completedSimulations ?? COMPLETED_SIMULATIONS_PER_CALL,
    trace,
  };
  const t0 = performance.now();
  // Deterministic entropy discipline around the WHOLE call.
  const originalRandom = Math.random;
  const stubSeed = opts.mathRandomSeed === undefined ? 0x5eed : opts.mathRandomSeed;
  let draws = 0;
  if (stubSeed === null) {
    Math.random = () => {
      draws++;
      throw new Error('Math.random inside a run declared pure (mathRandomSeed=null)');
    };
  } else {
    let s = stubSeed >>> 0;
    Math.random = () => {
      draws++;
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  let result: UctResultBaseline | UctResultPrepared;
  try {
    result = arm === 'UCT-H-BASELINE'
      ? new UctSearchBaseline(state, options).run()
      : new UctSearchPrepared(state, options).run();
  } finally {
    Math.random = originalRandom;
  }
  const wallMs = performance.now() - t0;
  return {
    arm,
    result: result! as unknown as ArmResultLike,
    trace,
    digests: trace.sims.map((s) => s.digest),
    wallMs,
    ruleCalls: counter.calls(),
    mathRandomDraws: draws,
  };
}

// ---------------------------------------------------------------------------
// structural digest of the WHOLE search tree
// ---------------------------------------------------------------------------
interface AnyNode {
  kind: string;
  state: GameEngineState;
  currentPlayer: string;
  handoffs: number;
  visitCount: number;
  totalReward: number;
  meanReward: number;
  childNodes: { key: string; transitionKind: string; child: AnyNode | null }[];
  chanceOutcomes: { weight: number; samples: number; state: GameEngineState; child: AnyNode | null }[];
  chanceMassError: number;
}

function n(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Inf';
  if (x === -Infinity) return '-Inf';
  if (Object.is(x, -0)) return '-0';
  return String(x);
}

/**
 * Whole-tree fingerprint: every node's kind, hand-off depth, stateKey, visit
 * statistics and CHANCE layer, plus every edge key/kind. Iterative (explicit
 * stack) so a deep tree can never overflow the call stack.
 */
export function treeDigest(root: unknown): string {
  const parts: string[] = [];
  const stack: AnyNode[] = [root as AnyNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    parts.push(
      node.kind, String(node.handoffs), stateKey(node.state), String(node.visitCount),
      n(node.totalReward), n(node.meanReward), String(node.childNodes.length),
      String(node.chanceOutcomes.length), n(node.chanceMassError),
    );
    for (const e of node.childNodes) parts.push(e.key, e.transitionKind);
    for (const o of node.chanceOutcomes) parts.push(n(o.weight), String(o.samples), stateKey(o.state));
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      const c = node.childNodes[i].child;
      if (c) stack.push(c);
    }
    for (let i = node.chanceOutcomes.length - 1; i >= 0; i--) {
      const c = node.chanceOutcomes[i].child;
      if (c) stack.push(c);
    }
  }
  return createHash('sha256').update(parts.join('\u0001')).digest('hex');
}

// ---------------------------------------------------------------------------
// comparable projection
// ---------------------------------------------------------------------------
export interface Phase1Comparison {
  simulations: number;
  abortedSimulations: number;
  nodesCreated: number;
  chanceNodes: number;
  chanceSamples: number;
  maxChanceMassError: string;
  rolloutSteps: number;
  maxHandoffsReached: number;
  deadlineHit: boolean;
  nodeCapHit: boolean;
  postDeadlineNodeCreations: number;
  completedSimulationLimitHit: boolean;
  treeDigest: string;
  planTraceDigest: string | null;
  rootVisits: number;
  rootTotalReward: string;
  rootMeanReward: string;
  plan: string;
  planCost: number;
  planExtended: boolean;
  treePlanLength: number;
  extensionSteps: number;
  rootAction: string | null;
  rootActionStats: { key: string; transitionKind: string; visits: number; meanReward: string; totalReward: string; childStateKey: string | null }[];
  /**
   * Math.random draws this arm consumed. Zero is the expected value: the 24
   * frozen roots never reach the one known impurity. A non-zero count is not an
   * error — both arms see the same fixed-seed stub — but it must be equal across
   * the arms, otherwise one of them walks the impure path more often.
   */
  mathRandomDraws: number;
}

export function phase1Comparable(run: Phase1Run): Phase1Comparison {
  const r = run.result;
  const d = r.diagnostics;
  const root = r.root as AnyNode;
  return {
    simulations: d.simulations,
    abortedSimulations: d.abortedSimulations,
    nodesCreated: d.nodesCreated,
    chanceNodes: d.chanceNodes,
    chanceSamples: d.chanceSamples,
    maxChanceMassError: n(d.maxChanceMassError),
    rolloutSteps: d.rolloutSteps,
    maxHandoffsReached: d.maxHandoffsReached,
    deadlineHit: d.deadlineHit,
    nodeCapHit: d.nodeCapHit,
    postDeadlineNodeCreations: d.postDeadlineNodeCreations,
    completedSimulationLimitHit: d.completedSimulationLimitHit,
    treeDigest: treeDigest(root),
    planTraceDigest: r.planTraceDigest,
    rootVisits: r.rootVisits,
    rootTotalReward: n(root.totalReward),
    rootMeanReward: n(r.rootMeanReward),
    plan: r.plan.map(actionLabel).join(' '),
    planCost: r.planCost,
    planExtended: r.planExtended,
    treePlanLength: r.treePlanLength,
    extensionSteps: r.extensionSteps,
    rootAction: r.rootAction ? actionLabel(r.rootAction) : null,
    rootActionStats: r.rootActionStats.map((s) => ({
      key: s.key,
      transitionKind: s.transitionKind,
      visits: s.visits,
      meanReward: n(s.meanReward),
      totalReward: n(s.totalReward),
      childStateKey: s.childStateKey,
    })),
    mathRandomDraws: run.mathRandomDraws,
  };
}

export interface Phase1Diff {
  /** Empty = full parity on every required axis. */
  fieldDiffs: string[];
  /** Per-simulation digest differences, in order. */
  digestDiffs: { index: number; baseline: string; prepared: string }[];
  firstDivergentSimulation: number | null;
}

export function diffPhase1(
  baseline: Phase1Run,
  prepared: Phase1Run,
): Phase1Diff {
  const a = phase1Comparable(baseline);
  const b = phase1Comparable(prepared);
  const fieldDiffs: string[] = [];
  const keys = Object.keys(a) as (keyof Phase1Comparison)[];
  for (const k of keys) {
    const va = a[k];
    const vb = b[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      fieldDiffs.push(`${String(k)}: baseline=${JSON.stringify(va)} prepared=${JSON.stringify(vb)}`);
    }
  }
  const digestDiffs: Phase1Diff['digestDiffs'] = [];
  const len = Math.max(baseline.digests.length, prepared.digests.length);
  for (let i = 0; i < len; i++) {
    if (baseline.digests[i] !== prepared.digests[i]) {
      digestDiffs.push({
        index: i,
        baseline: baseline.digests[i] ?? '<missing>',
        prepared: prepared.digests[i] ?? '<missing>',
      });
    }
  }
  return {
    fieldDiffs,
    digestDiffs,
    firstDivergentSimulation: digestDiffs.length > 0 ? digestDiffs[0].index : null,
  };
}

/** Hard precondition of a valid Phase 1 call (§3.2). */
export function phase1ExecutionAnomaly(run: Phase1Run, expectedSims: number): string | null {
  const d = run.result.diagnostics;
  if (d.nodeCapHit) return `NODE_CAP_BEFORE_K: nodeCapHit at simulations=${d.simulations} (K=${expectedSims})`;
  if (d.deadlineHit) return `DEADLINE_FIRED_IN_FIXED_WORKLOAD: simulations=${d.simulations}`;
  if (d.abortedSimulations !== 0) return `ABORTED_SIMULATION: ${d.abortedSimulations}`;
  if (!d.completedSimulationLimitHit) return `STOP_SEAM_NOT_REACHED: simulations=${d.simulations}`;
  if (d.simulations !== expectedSims) return `SIMULATION_COUNT: expected ${expectedSims}, got ${d.simulations}`;
  return null;
}
