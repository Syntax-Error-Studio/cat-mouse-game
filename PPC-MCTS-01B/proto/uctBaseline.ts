/**
 * PPC-MCTS-01B-HARNESS-REPAIR — BASELINE harness fork of `PPC-MCTS-01/proto/uct.ts`.
 *
 * WHY A FORK: Phase 1 must stop both arms after exactly K COMPLETE simulations.
 * The original prototype stops on `maxNodes` or a wall deadline, which makes the
 * two arms run different amounts of work and turns "parity" into "parity of
 * whatever happened to fit". `PPC-MCTS-01/` is frozen by the brief, so the seam
 * cannot be added there.
 *
 * WHAT IS IDENTICAL TO THE FORK PARENT (line-for-line, same order):
 *   - module-level: `evaluateLeaf`, `isTerminal`, `guidanceValue`,
 *     `selectRolloutAction` (only a trailing optional trace argument added),
 *     `actionKey`, `makeDecisionNode`, `makeChanceNode`, `handoffDelta`
 *   - class: `simulate`, `applyEdge`, `createDecision`, `noteCreation`,
 *     `selectEdge`, `rollout`, `backprop`, `bestRootEdge`, `extractPlan`
 *   - every threshold, comparison, tie-break, epsilon and iteration order
 *   - the RNG construction, the salt constants, the seed derivation
 *
 * WHAT IS NEW (and nothing else):
 *   1. `maxCompletedSimulations?: number` — TEST-ONLY stop seam. The counter is
 *      tested only at the TOP of the simulation loop, i.e. after a simulation
 *      has completed and been backpropagated. A simulation is never abandoned
 *      halfway, and the K-th simulation is always a full one.
 *   2. `trace?: TraceCollector` — read-only instrumentation. When it is absent
 *      every recording call is a single null check and the two RNG objects are
 *      `mulberry32(...)` exactly as before.
 *
 * PROOF OBLIGATION (recorded in BASELINE_FORK_PROVENANCE.json):
 *   with `maxCompletedSimulations` and `trace` both absent, this class must
 *   produce a byte-identical tree fingerprint, plan, root-action stats and every
 *   non-timing diagnostic compared with `UctSearch` from the frozen parent.
 *   That is verified at 96 fixed-node cells and at fixed simulation counts.
 */
import type { GameEngineState } from '../../src/game/engine';
import type { RuleSet, SearchAction, SearchTransitionResult } from '../../src/game/ai/searchTypes';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { stateKey } from '../../src/game/ai/transposition';
import { gameAffectingEqual } from '../../src/game/ai/stateCompare';
import { mateActionCost } from '../../src/game/ai/expectiminimax';
import { hybridEvaluateForCat } from '../../src/game/ai/hybridLeaf';
import { GamePhase, PieceType } from '../../src/game/types';
import type { Rng } from '../../PPC-MCTS-01/proto/seededRng';
import { mulberry32, seedFor, hashString32 } from '../../PPC-MCTS-01/proto/seededRng';
import { normalizeLeafValue, terminalReward } from '../../PPC-MCTS-01/proto/value';
import { validateChance, sampleChance } from '../../PPC-MCTS-01/proto/chance';
import type { ValidatedChance } from '../../PPC-MCTS-01/proto/chance';
import { TraceCollector, countingTraceRng } from './trace';
import type { Encodable } from './trace';

export type RolloutMode = 'random' | 'hybrid';

export interface UctOptions {
  rules: RuleSet;
  /** Main-search wall budget (ms). Production comparison uses 100. */
  deadlineMs: number;
  /** Maximum action-right hand-offs from the root. */
  maxHandoffs: number;
  /** Safety cap on created tree nodes. */
  maxNodes: number;
  /** Exploration constant; standard normalised value sqrt(2). */
  c: number;
  /** Seed material (root id + algorithm + repetition). */
  seed: string;
  rollout: RolloutMode;
  now?: () => number;
  /** Hard cap on primitive rollout actions (safety valve; horizon is primary). */
  maxRolloutActions?: number;
  /**
   * TEST-ONLY stop seam. Stop once exactly this many simulations have
   * COMPLETED and been backpropagated. Never stops mid-simulation. `undefined`
   * = the original node-cap / deadline behaviour.
   */
  maxCompletedSimulations?: number;
  /** TEST-ONLY read-only trace sink. `undefined` = no instrumentation at all. */
  trace?: TraceCollector;
}

export type EdgeTransitionKind = 'unvisited' | 'deterministic' | 'chance';

export interface UctEdge {
  action: SearchAction;
  key: string;
  transitionKind: EdgeTransitionKind;
  child: UctNode | null;
}

export interface UctChanceOutcome {
  state: GameEngineState;
  weight: number;
  samples: number;
  child: UctNode | null;
}

export type NodeKind = 'decision' | 'chance';

export interface UctNode {
  kind: NodeKind;
  state: GameEngineState;
  currentPlayer: PieceType;
  /** Action-right hand-offs from the root to this node. */
  handoffs: number;
  visitCount: number;
  totalReward: number;
  meanReward: number;
  legalActions: SearchAction[];
  /** Decision nodes: one edge per legal action. Chance nodes: empty. */
  childNodes: UctEdge[];
  /** Chance nodes: validated outcome layer (sampled by weight). */
  chanceOutcomes: UctChanceOutcome[];
  chanceMassError: number;
  /** How this node was reached (root marker for diagnostics). */
  actionTransition: { action: SearchAction | null; kind: 'root' | 'deterministic' | 'chance-outcome' };
  expanded: boolean;
  parent: UctNode | null;
}

export interface RootActionStat {
  action: SearchAction;
  key: string;
  transitionKind: EdgeTransitionKind;
  visits: number;
  meanReward: number;
  totalReward: number;
  childStateKey: string | null;
}

export interface UctDiagnostics {
  simulations: number;
  abortedSimulations: number;
  nodesCreated: number;
  chanceNodes: number;
  chanceSamples: number;
  maxChanceMassError: number;
  rolloutSteps: number;
  maxHandoffsReached: number;
  elapsedMs: number;
  deadlineHit: boolean;
  nodeCapHit: boolean;
  postDeadlineNodeCreations: number;
  /** True when the test-only completed-simulation seam decided the stop. */
  completedSimulationLimitHit: boolean;
}

export interface UctResult {
  root: UctNode;
  plan: SearchAction[];
  planCost: number;
  planExtended: boolean;
  treePlanLength: number;
  extensionSteps: number;
  rootAction: SearchAction | null;
  rootActionStats: RootActionStat[];
  rootVisits: number;
  rootMeanReward: number;
  diagnostics: UctDiagnostics;
  chanceSamples: number;
  planTraceDigest: string | null;
}

const ROOT_TRANSITION = { action: null, kind: 'root' as const };

function actionKey(a: SearchAction): string {
  switch (a.type) {
    case 'catStep': return `C:${a.direction.key}`;
    case 'catPlaceTrap': return 'T';
    case 'mouseStep': return `M:${a.direction.key}`;
    case 'mouseSkill': return 'S';
    case 'chooseTunnel': return `X:${a.r},${a.c}`;
  }
}

function makeDecisionNode(
  state: GameEngineState,
  handoffs: number,
  action: SearchAction | null,
  kind: 'root' | 'deterministic' | 'chance-outcome',
  parent: UctNode | null,
): UctNode {
  return {
    kind: 'decision',
    state,
    currentPlayer: state.currentPlayer,
    handoffs,
    visitCount: 0,
    totalReward: 0,
    meanReward: 0,
    legalActions: [],
    childNodes: [],
    chanceOutcomes: [],
    chanceMassError: 0,
    actionTransition: { action, kind },
    expanded: false,
    parent,
  };
}

function makeChanceNode(parent: UctNode, validated: ValidatedChance, action: SearchAction): UctNode {
  return {
    kind: 'chance',
    state: parent.state,
    currentPlayer: parent.currentPlayer,
    handoffs: parent.handoffs,
    visitCount: 0,
    totalReward: 0,
    meanReward: 0,
    legalActions: [],
    childNodes: [],
    chanceOutcomes: validated.outcomes.map((o) => ({
      state: o.state,
      weight: o.weight,
      samples: 0,
      child: null,
    })),
    chanceMassError: validated.massError,
    actionTransition: { action, kind: 'deterministic' },
    expanded: true,
    parent,
  };
}

function handoffDelta(fromPlayer: PieceType, toState: GameEngineState): number {
  return toState.currentPlayer !== fromPlayer ? 1 : 0;
}

/** Cat-perspective normalised leaf value (terminal ±1; nonterminal via hybrid). */
export function evaluateLeaf(state: GameEngineState): number {
  const t = terminalReward(state);
  if (t !== null) return t;
  const raw = hybridEvaluateForCat(state);
  return normalizeLeafValue(raw);
}

function isTerminal(state: GameEngineState): boolean {
  return state.phase === GamePhase.CatWins || state.phase === GamePhase.MouseWins;
}

/** Expected normalised value of an action, used ONLY as UCT-H rollout guidance. */
function guidanceValue(
  state: GameEngineState,
  action: SearchAction,
  rules: RuleSet,
): number {
  const res = simulateSearchAction(state, action, rules);
  if (res.kind === 'deterministic') return evaluateLeaf(res.state);
  const v = validateChance(res.outcomes);
  let acc = 0;
  for (let i = 0; i < v.outcomes.length; i++) acc += v.weights[i] * evaluateLeaf(v.outcomes[i].state);
  return acc;
}

/**
 * UNCHANGED selection rule. The only addition is an OPTIONAL read-only tap that
 * records `(stateKey, actionKey, value)` per candidate. The tap runs strictly
 * AFTER the value is computed and never touches the RNG or the state.
 */
function selectRolloutAction(
  state: GameEngineState,
  actions: SearchAction[],
  mode: RolloutMode,
  rules: RuleSet,
  rng: Rng,
  trace?: { collector: TraceCollector; kind: 'rollout.guidance' | 'plan.guidance' } | null,
): SearchAction {
  if (actions.length === 1) return actions[0];
  if (mode === 'random') return actions[rng.int(actions.length)];

  const maximize = state.currentPlayer === PieceType.Cat;
  let bestVal = maximize ? -Infinity : Infinity;
  let best: number[] = [];
  const sk = trace ? stateKey(state) : '';
  for (let i = 0; i < actions.length; i++) {
    const val = guidanceValue(state, actions[i], rules);
    if (trace) trace.collector.record(trace.kind, sk, actionKey(actions[i]), val);
    if (!Number.isFinite(val)) continue;
    const better = maximize ? val > bestVal + 1e-12 : val < bestVal - 1e-12;
    const equal = Math.abs(val - bestVal) <= 1e-12;
    if (better) { bestVal = val; best = [i]; }
    else if (equal) best.push(i);
  }
  if (best.length === 0) return actions[rng.int(actions.length)];
  return actions[best[rng.int(best.length)]];
}

interface SimOutcome {
  completed: boolean;
  path: UctNode[];
  reward: number;
  chanceSamples: number;
  rolloutSteps: number;
  maxHandoffs: number;
  leafValue: number;
  terminal: boolean;
}

export class UctSearchBaseline {
  private readonly opts: Required<Pick<UctOptions, 'deadlineMs' | 'maxHandoffs' | 'maxNodes' | 'c' | 'seed' | 'rollout'>> & {
    rules: RuleSet; now: () => number; maxRolloutActions: number;
  };
  private readonly chanceRng: Rng;
  private readonly policyRng: Rng;
  private readonly deadlineAt: number;
  private readonly chanceSalt = 0x9e3779b9;
  private readonly policySalt = 0x85ebca6b;

  // ---- test seam / instrumentation (inert unless explicitly enabled) ----
  private readonly stopAfterSims: number | null;
  private readonly trace: TraceCollector | null;
  private readonly policyDrawCount: () => number;
  private readonly chanceDrawCount: () => number;
  // ----------------------------------------------------------------------

  readonly root: UctNode;
  private createdNodes = 1;
  private sims = 0;
  private aborted = 0;
  private chanceNodes = 0;
  private chanceSamples = 0;
  private maxMassError = 0;
  private rolloutSteps = 0;
  private maxHandoffsReached = 0;
  private deadlineHit = false;
  private nodeCapHit = false;
  private postDeadlineCreations = 0;
  private deadlineReached = false;
  private completedSimLimitHit = false;

  constructor(state: GameEngineState, options: UctOptions) {
    this.opts = {
      rules: options.rules,
      deadlineMs: options.deadlineMs,
      maxHandoffs: options.maxHandoffs,
      maxNodes: options.maxNodes,
      c: options.c,
      seed: options.seed,
      rollout: options.rollout,
      now: options.now ?? (() => performance.now()),
      maxRolloutActions: options.maxRolloutActions ?? 40,
    };
    // ---- test seam / instrumentation -----------------------------------
    // When `trace` is absent the two RNGs below are EXACTLY the parent's, and
    // the draw counters are constant zero.
    this.stopAfterSims = options.maxCompletedSimulations ?? null;
    this.trace = options.trace ?? null;
    if (this.trace) {
      const chance = countingTraceRng(
        mulberry32(seedFor([options.seed, 'chance']) >>> 0), this.trace, 'chance',
      );
      const policy = countingTraceRng(
        mulberry32(seedFor([options.seed, 'policy']) >>> 0), this.trace, 'policy',
      );
      this.chanceRng = chance.rng;
      this.policyRng = policy.rng;
      this.chanceDrawCount = chance.draws;
      this.policyDrawCount = policy.draws;
    } else {
      this.chanceRng = mulberry32(seedFor([options.seed, 'chance']) >>> 0);
      this.policyRng = mulberry32(seedFor([options.seed, 'policy']) >>> 0);
      this.chanceDrawCount = () => 0;
      this.policyDrawCount = () => 0;
    }
    // --------------------------------------------------------------------
    this.deadlineAt = this.opts.now() + Math.max(1, this.opts.deadlineMs);
    this.root = makeDecisionNode(state, 0, null, 'root', null);
  }

  private tr(kind: Parameters<TraceCollector['record']>[0], ...fields: Encodable[]): void {
    if (this.trace !== null) this.trace.record(kind, ...fields);
  }

  run(): UctResult {
    const t0 = this.opts.now();
    for (;;) {
      // ---- test seam: only between simulations, never inside one --------
      if (this.stopAfterSims !== null && this.sims >= this.stopAfterSims) {
        this.completedSimLimitHit = true;
        break;
      }
      // ------------------------------------------------------------------
      if (this.createdNodes >= this.opts.maxNodes) { this.nodeCapHit = true; break; }
      if (this.sims > 0 && this.opts.now() >= this.deadlineAt) { this.deadlineHit = true; break; }
      const traceIndex = this.sims;
      const policyBefore = this.policyDrawCount();
      const chanceBefore = this.chanceDrawCount();
      if (this.trace) this.trace.simulationBegin(traceIndex, stateKey(this.root.state));
      const sim = this.simulate(this.sims === 0);
      if (!sim.completed) {
        this.aborted++;
        this.deadlineHit = true;
        // `simulationEnd` records the `sim.end` event itself — do not emit a
        // second one here.
        if (this.trace) {
          this.trace.simulationEnd({
            index: traceIndex, completed: false, reward: 0, leafValue: 0, terminal: false,
            pathLength: sim.path.length, rolloutSteps: sim.rolloutSteps,
            chanceSamples: sim.chanceSamples, policyDraws: 0, chanceDraws: 0,
            maxHandoffs: sim.maxHandoffs,
          });
        }
        break;
      }
      this.backprop(sim.path, sim.reward);
      this.sims++;
      this.chanceSamples += sim.chanceSamples;
      this.rolloutSteps += sim.rolloutSteps;
      if (sim.maxHandoffs > this.maxHandoffsReached) this.maxHandoffsReached = sim.maxHandoffs;
      if (this.trace) {
        this.trace.simulationEnd({
          index: traceIndex, completed: true, reward: sim.reward, leafValue: sim.leafValue,
          terminal: sim.terminal, pathLength: sim.path.length, rolloutSteps: sim.rolloutSteps,
          chanceSamples: sim.chanceSamples,
          policyDraws: this.policyDrawCount() - policyBefore,
          chanceDraws: this.chanceDrawCount() - chanceBefore,
          maxHandoffs: sim.maxHandoffs,
        });
      }
    }
    const elapsedMs = this.opts.now() - t0;
    if (this.sims > 0 && this.opts.now() >= this.deadlineAt) this.deadlineHit = true;

    if (this.trace) this.trace.planBegin();
    const plan = this.extractPlan();
    const planTraceDigest = this.trace ? this.trace.planEnd() : null;
    const rootActionStats = this.root.childNodes.map((e) => ({
      action: e.action,
      key: e.key,
      transitionKind: e.transitionKind,
      visits: e.child?.visitCount ?? 0,
      meanReward: e.child?.meanReward ?? 0,
      totalReward: e.child?.totalReward ?? 0,
      childStateKey: e.child && e.child.kind === 'decision' ? stateKey(e.child.state) : null,
    }));
    const best = this.bestRootEdge();
    return {
      root: this.root,
      plan: plan.plan,
      planCost: plan.plan.reduce((sum, a) => sum + mateActionCost(a), 0),
      planExtended: plan.extended,
      treePlanLength: plan.treeLength,
      extensionSteps: plan.extensionSteps,
      rootAction: best ? best.action : null,
      rootActionStats,
      rootVisits: this.root.visitCount,
      rootMeanReward: this.root.meanReward,
      diagnostics: {
        simulations: this.sims,
        abortedSimulations: this.aborted,
        nodesCreated: this.createdNodes,
        chanceNodes: this.chanceNodes,
        chanceSamples: this.chanceSamples,
        maxChanceMassError: this.maxMassError,
        rolloutSteps: this.rolloutSteps,
        maxHandoffsReached: this.maxHandoffsReached,
        elapsedMs,
        deadlineHit: this.deadlineHit,
        nodeCapHit: this.nodeCapHit,
        postDeadlineNodeCreations: this.postDeadlineCreations,
        completedSimulationLimitHit: this.completedSimLimitHit,
      },
      chanceSamples: this.chanceSamples,
      planTraceDigest,
    };
  }

  // ---------------------------------------------------------------- selection
  private simulate(allowOverrunForFirst: boolean): SimOutcome {
    const path: UctNode[] = [this.root];
    const keys = new Set<string>([stateKey(this.root.state)]);
    let cur = this.root;
    let rolloutSteps = 0;
    let chanceSamples = 0;
    let maxHandoffs = cur.handoffs;

    const aborted = (): SimOutcome => ({
      completed: false, path, reward: 0, chanceSamples, rolloutSteps, maxHandoffs,
      leafValue: 0, terminal: false,
    });
    const checkDeadline = (): boolean => {
      if (allowOverrunForFirst && this.sims === 0) return false;
      if (this.deadlineReached) return true;
      if (this.opts.now() >= this.deadlineAt) { this.deadlineReached = true; return true; }
      return false;
    };

    while (true) {
      if (checkDeadline()) return aborted();
      if (isTerminal(cur.state)) { this.tr('tree.cycle', stateKey(cur.state), 'terminal'); break; }
      if (cur.handoffs >= this.opts.maxHandoffs) { this.tr('tree.cycle', stateKey(cur.state), 'handoff-cap'); break; }

      this.tr('tree.visit', cur.kind, stateKey(cur.state), String(cur.currentPlayer),
        cur.handoffs, cur.visitCount, path.length);

      if (cur.kind === 'chance') {
        if (cur.chanceOutcomes.length === 0) { this.tr('tree.cycle', stateKey(cur.state), 'empty-chance'); break; }
        const idx = sampleChance(
          { outcomes: cur.chanceOutcomes.map((o) => ({ state: o.state, weight: o.weight })), weights: cur.chanceOutcomes.map((o) => o.weight), massError: cur.chanceMassError },
          this.chanceRng,
        );
        chanceSamples++;
        const oc = cur.chanceOutcomes[idx];
        oc.samples++;
        this.tr('tree.chancePick', stateKey(cur.state), idx, stateKey(oc.state),
          cur.chanceOutcomes.length);
        if (!oc.child) {
          oc.child = this.createDecision(oc.state, cur.handoffs + handoffDelta(cur.currentPlayer, oc.state), cur, null, 'chance-outcome');
        }
        const child = oc.child;
        if (keys.has(stateKey(child.state))) {
          // Cycle: stop here and ROLLOUT from the sampled outcome instead of
          // re-entering an already-seen position this simulation.
          this.tr('tree.cycle', stateKey(child.state), 'chance-outcome');
          cur = child;
          path.push(child);
          break;
        }
        keys.add(stateKey(child.state));
        cur = child;
        path.push(child);
        maxHandoffs = Math.max(maxHandoffs, cur.handoffs);
        // Continue the tree descent from the sampled outcome's fresh node.
        continue;
      }

      // --- decision node ---
      if (!cur.expanded) {
        cur.legalActions = generateLegalSearchActions(cur.state, this.opts.rules);
        cur.childNodes = cur.legalActions.map((a) => ({
          action: a,
          key: actionKey(a),
          transitionKind: 'unvisited' as EdgeTransitionKind,
          child: null,
        }));
        cur.expanded = true;
        this.tr('tree.expand', stateKey(cur.state), cur.childNodes.length);
        continue; // select one newly available action edge
      }
      if (cur.childNodes.length === 0) { this.tr('tree.expand', stateKey(cur.state), 0); break; }

      const edge = this.selectEdge(cur);
      this.tr('tree.edge', stateKey(cur.state), edge.key,
        edge.child === null ? 'unvisited' : edge.transitionKind,
        edge.child === null ? null : stateKey(edge.child.state));
      if (!edge.child) {
        const made = this.applyEdge(cur, edge, chanceSamples);
        chanceSamples = made.chanceSamples;
        if (!made.node) continue;
        path.push(made.node);
        cur = made.node;
        maxHandoffs = Math.max(maxHandoffs, cur.handoffs);
        if (cur.kind === 'chance') continue;
        if (made.cycle) break;
        break; // fresh decision child → rollout from it
      }

      const key = stateKey(edge.child.state);
      if (keys.has(key)) {
        this.tr('tree.cycle', key, 'deterministic');
        path.push(edge.child);
        cur = edge.child;
        break; // cycle detected → evaluate (rollout) from here
      }
      keys.add(key);
      path.push(edge.child);
      cur = edge.child;
      maxHandoffs = Math.max(maxHandoffs, cur.handoffs);
    }

    // ------------------------------------------------------------------ rollout
    const rollout = this.rollout(cur.state, cur.handoffs, allowOverrunForFirst, keys);
    if (!rollout.completed) return aborted();
    rolloutSteps += rollout.steps;
    chanceSamples += rollout.chanceSamples;
    maxHandoffs = Math.max(maxHandoffs, rollout.maxHandoffs);
    return {
      completed: true, path, reward: rollout.reward, chanceSamples, rolloutSteps,
      maxHandoffs, leafValue: rollout.leafValue, terminal: rollout.terminal,
    };
  }

  private applyEdge(
    parent: UctNode,
    edge: UctEdge,
    chanceSamples: number,
  ): { node: UctNode | null; chanceSamples: number; cycle: boolean } {
    const res: SearchTransitionResult = simulateSearchAction(parent.state, edge.action, this.opts.rules);
    if (res.kind === 'deterministic') {
      if (gameAffectingEqual(parent.state, res.state)) {
        throw new Error(`illegal no-op edge reached the tree: ${actionKey(edge.action)}`);
      }
      edge.transitionKind = 'deterministic';
      const switched = res.state.currentPlayer !== parent.currentPlayer ? 1 : 0;
      const child = this.createDecision(res.state, parent.handoffs + switched, parent, edge.action, 'deterministic');
      edge.child = child;
      return { node: child, chanceSamples, cycle: false };
    }
    edge.transitionKind = 'chance';
    const validated = validateChance(res.outcomes);
    this.maxMassError = Math.max(this.maxMassError, validated.massError);
    this.tr('tree.chanceLayer', stateKey(parent.state), actionKey(edge.action),
      validated.outcomes.length, validated.weights.map((w) => w),
      validated.outcomes.map((o) => stateKey(o.state)));
    const chanceNode = makeChanceNode(parent, validated, edge.action);
    edge.child = chanceNode;
    this.createdNodes++;
    this.chanceNodes++;
    this.noteCreation();
    return { node: chanceNode, chanceSamples, cycle: false };
  }

  private createDecision(
    state: GameEngineState,
    handoffs: number,
    parent: UctNode,
    action: SearchAction | null,
    kind: 'deterministic' | 'chance-outcome',
  ): UctNode {
    this.createdNodes++;
    this.noteCreation();
    return makeDecisionNode(state, handoffs, action, kind, parent);
  }

  private noteCreation(): void {
    if (this.deadlineReached) this.postDeadlineCreations++;
  }

  private selectEdge(node: UctNode): UctEdge {
    const logN = Math.log(Math.max(1, node.visitCount));
    const c = this.opts.c;
    const maximize = node.currentPlayer === PieceType.Cat;
    let bestScore = -Infinity;
    const best: UctEdge[] = [];
    for (const edge of node.childNodes) {
      if (!edge.child) return edge; // unvisited: expand first
      const n = edge.child.visitCount;
      if (n === 0) return edge;
      const q = edge.child.meanReward;
      const explore = c * Math.sqrt(logN / n);
      const score = (maximize ? q : -q) + explore;
      if (score > bestScore + 1e-15) { bestScore = score; best.length = 0; best.push(edge); }
      else if (Math.abs(score - bestScore) <= 1e-15) best.push(edge);
    }
    return best[this.policyRng.int(best.length)];
  }

  // ----------------------------------------------------------------- rollout
  private rollout(
    start: GameEngineState,
    startHandoffs: number,
    allowOverrunForFirst: boolean,
    startKeys: Set<string>,
  ): { completed: boolean; reward: number; steps: number; chanceSamples: number; maxHandoffs: number; leafValue: number; terminal: boolean } {
    let state = start;
    let handoffs = startHandoffs;
    let steps = 0;
    let chanceSamples = 0;
    let maxHandoffs = startHandoffs;
    const keys = new Set(startKeys);
    const tap = this.trace ? { collector: this.trace, kind: 'rollout.guidance' as const } : null;

    while (steps < this.opts.maxRolloutActions) {
      const t = terminalReward(state);
      if (t !== null) {
        this.tr('rollout.leaf', stateKey(state), t, true, steps);
        return { completed: true, reward: t, steps, chanceSamples, maxHandoffs, leafValue: t, terminal: true };
      }
      if (handoffs >= this.opts.maxHandoffs) { this.tr('rollout.stop', 'handoff-cap', steps); break; }
      if (!(allowOverrunForFirst && this.sims === 0)) {
        if (this.deadlineReached) {
          this.tr('rollout.stop', 'deadline', steps);
          return { completed: false, reward: 0, steps, chanceSamples, maxHandoffs, leafValue: 0, terminal: false };
        }
        if (this.opts.now() >= this.deadlineAt) {
          this.deadlineReached = true;
          this.tr('rollout.stop', 'deadline', steps);
          return { completed: false, reward: 0, steps, chanceSamples, maxHandoffs, leafValue: 0, terminal: false };
        }
      }
      const actions = generateLegalSearchActions(state, this.opts.rules);
      this.tr('rollout.step', steps, stateKey(state), String(state.currentPlayer),
        handoffs, actions.length);
      if (actions.length === 0) { this.tr('rollout.empty', stateKey(state)); break; }
      const action = selectRolloutAction(state, actions, this.opts.rollout, this.opts.rules, this.policyRng, tap);
      this.tr('rollout.pick', stateKey(state), actionKey(action), actions.length);
      const res = simulateSearchAction(state, action, this.opts.rules);
      let next: GameEngineState;
      if (res.kind === 'chance') {
        const v = validateChance(res.outcomes);
        this.maxMassError = Math.max(this.maxMassError, v.massError);
        const idx = sampleChance(v, this.chanceRng);
        chanceSamples++;
        next = v.outcomes[idx].state;
        this.tr('rollout.chance', stateKey(state), idx, stateKey(next), v.outcomes.length);
      } else {
        next = res.state;
      }
      const switched = next.currentPlayer !== state.currentPlayer ? 1 : 0;
      handoffs += switched;
      maxHandoffs = Math.max(maxHandoffs, handoffs);
      steps++;
      const k = stateKey(next);
      const cycled = keys.has(k);
      this.tr('rollout.next', k, handoffs, cycled);
      if (cycled) { state = next; break; }
      keys.add(k);
      state = next;
    }
    const leafValue = evaluateLeaf(state);
    this.tr('rollout.leaf', stateKey(state), leafValue, false, steps);
    return { completed: true, reward: leafValue, steps, chanceSamples, maxHandoffs, leafValue, terminal: false };
  }

  private backprop(path: UctNode[], reward: number): void {
    for (let i = path.length - 1; i >= 0; i--) {
      const n = path[i];
      n.visitCount++;
      n.totalReward += reward;
      n.meanReward = n.totalReward / n.visitCount;
    }
  }

  // -------------------------------------------------------------------- plan
  private bestRootEdge(): UctEdge | null {
    let best: UctEdge | null = null;
    for (const e of this.root.childNodes) {
      if (!e.child) continue;
      if (!best || (best.child!.visitCount < e.child.visitCount)) best = e;
      else if (best.child!.visitCount === e.child.visitCount && e.key < best.key) best = e;
    }
    return best;
  }

  /**
   * Principal-line cat-turn plan: repeatedly take the most-visited child while
   * the actor is still the cat and the edge is deterministic. The walk stops at
   * the action-right hand-off, at a CHANCE boundary, at a terminal, or when no
   * explored child exists.
   *
   * If the principal line ends before the hand-off only because the tree was
   * not expanded that deep, the remaining cat actions are filled with the same
   * rollout policy used by this arm (uniform for UCT-R, hybrid-guided for
   * UCT-H). Those steps are counted separately as `extensionSteps` so tree
   * evidence and completion can never be confused.
   */
  extractPlan(): { plan: SearchAction[]; treeLength: number; extended: boolean; extensionSteps: number } {
    const plan: SearchAction[] = [];
    let cur: UctNode | null = this.root;
    let treeEndedAtHandoff = false;
    const maxActions = 12;
    const tap = this.trace ? { collector: this.trace, kind: 'plan.guidance' as const } : null;
    while (cur && plan.length < maxActions) {
      if (cur.state.phase !== GamePhase.Playing || cur.state.currentPlayer !== PieceType.Cat) {
        this.tr('plan.stop', 'actor', stateKey(cur.state));
        break;
      }
      let best: UctEdge | null = null;
      for (const e of cur.childNodes) {
        if (!e.child) continue;
        if (!best || best.child!.visitCount < e.child.visitCount) best = e;
        else if (best.child!.visitCount === e.child.visitCount && e.key < best.key) best = e;
      }
      if (!best || !best.child) { this.tr('plan.stop', 'no-child', stateKey(cur.state)); break; }
      this.tr('plan.edge', stateKey(cur.state), best.key, best.transitionKind);
      if (best.transitionKind === 'chance' || best.child.kind === 'chance') {
        // The final cat action of the turn is legal even though the engine
        // resolves the CAT->MOUSE boundary as a CHANCE successor. Keep the
        // action in the plan, then stop at the hand-off.
        plan.push(best.action);
        treeEndedAtHandoff = true;
        break;
      }
      // The child must be a decision node; chance children were handled above.
      if (best.child.kind !== 'decision') break;
      plan.push(best.action);
      cur = best.child;
    }
    const treeLength = plan.length;

    let extensionSteps = 0;
    let state = cur ? cur.state : this.root.state;
    while (!treeEndedAtHandoff && plan.length < maxActions) {
      if (state.phase !== GamePhase.Playing || state.currentPlayer !== PieceType.Cat || state.catMovesLeft <= 0) break;
      const actions = generateLegalSearchActions(state, this.opts.rules);
      if (actions.length === 0) break;
      const action = selectRolloutAction(state, actions, this.opts.rollout, this.opts.rules, this.policyRng, tap);
      this.tr('plan.pick', stateKey(state), actionKey(action), actions.length);
      const res = simulateSearchAction(state, action, this.opts.rules);
      // The action itself is legal; a CHANCE result is the post-action
      // CAT->MOUSE boundary. Keep the action, then end the plan at hand-off.
      if (res.kind === 'chance') {
        plan.push(action);
        extensionSteps++;
        this.tr('plan.extension', stateKey(state), actionKey(action), 'handoff');
        break;
      }
      plan.push(action);
      extensionSteps++;
      this.tr('plan.extension', stateKey(state), actionKey(action), 'step');
      state = res.state;
    }
    return { plan, treeLength, extended: extensionSteps > 0, extensionSteps };
  }
}

/** Re-export for tests/tools that need the same seed derivation. */
export function uctSeed(rootId: string, algorithm: string, repetition: number): string {
  return `PPC-MCTS-01|${rootId}|${algorithm}|rep=${repetition}|h=${hashString32(`${rootId}:${algorithm}:${repetition}`)}`;
}

export { ROOT_TRANSITION };
