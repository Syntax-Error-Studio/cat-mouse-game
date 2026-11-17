/**
 * PPC-MCTS-01A — read-only UCT diagnostics.
 *
 * This entry never edits the algorithm. It instantiates the unchanged
 * PPC-MCTS-01 UctSearch with the exact harness options and reads:
 *   - UctResult / UctDiagnostics (including rolloutSteps / chanceNodes that the
 *     72-call smoke did not persist);
 *   - evaluation.ts's built-in BFS / evaluation counters;
 *   - a separate, explicit evaluator microbenchmark.
 *
 * Outputs JSON only under PPC-MCTS-01A/data.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadRoots, UCB_C, MAX_HANDOFFS, MAX_NODES, MAIN_SEARCH_BUDGET_MS } from '../../PPC-MCTS-01/proto/harness';
import { UctSearch, uctSeed } from '../../PPC-MCTS-01/proto/uct';
import { replayPlanWithEngine, planLabel } from '../../PPC-MCTS-01/proto/replay';
import { createEngineRuleSet } from '../../src/game/engine';
import {
  resetEvaluationCalls, getEvaluationCalls, getMouseBfsCalls, getCatBfsCalls,
  getCarryMouseBfsCalls, getCarryRouteBfsCalls, getCatPushBfsCalls,
} from '../../src/game/ai/evaluation';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { hybridEvaluateForCat, isHybridEligibleState, productionValueNet } from '../../src/game/ai/hybridLeaf';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { mulberry32, sampleWeighted } from '../../PPC-MCTS-01/proto/seededRng';
import { GamePhase, PieceType } from '../../src/game/types';
import { mateActionCost } from '../../src/game/ai/expectiminimax';

const OUT = path.resolve('PPC-MCTS-01A/data');
fs.mkdirSync(OUT, { recursive: true });

const repoRoot = process.cwd();
const { roots, fixtureSha256 } = loadRoots(repoRoot);
const rules = createEngineRuleSet();

function counters(): Record<string, number> {
  return {
    evaluations: getEvaluationCalls(),
    mouseBfs: getMouseBfsCalls(),
    catBfs: getCatBfsCalls(),
    carryBfs: getCarryMouseBfsCalls(),
    carryRouteBfs: getCarryRouteBfsCalls(),
    catPushBfs: getCatPushBfsCalls(),
  };
}

function cpuMsSince(t: [number, number]): number {
  const d = process.cpuUsage(t);
  return (d.user + d.system) / 1000;
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

interface ArmRecord {
  rootId: string;
  arm: 'UCT-R' | 'UCT-H';
  rootStateKey: string;
  rootEligible: boolean;
  seed: string;
  wallMs: number;
  cpuMs: number;
  searchElapsedMs: number;
  sims: number;
  aborted: number;
  nodes: number;
  chanceNodes: number;
  chanceSamples: number;
  rolloutSteps: number;
  maxHandoffsReached: number;
  deadlineHit: boolean;
  nodeCapHit: boolean;
  postDeadlineNodeCreations: number;
  eval: Record<string, number>;
  evalPerSim: number;
  evalPerRolloutStep: number;
  bfsPerEval: number;
  plan: string;
  treePlanLength: number;
  extensionSteps: number;
  planExtended: boolean;
  planLength: number;
  planCost: number;
  rootAction: string | null;
  rootVisits: number;
  rootMeanReward: number;
  rootActions: { action: string; visits: number; meanReward: number; top: boolean; chosen: boolean }[];
  replayOk: boolean;
  replayFullTurnConsumed: boolean;
  // Diagnostic-only second extraction on the frozen tree (policy RNG state has
  // already advanced, so it is NOT the original plan; it measures extension cost).
  extensionDiag: {
    wallMs: number;
    cpuMs: number;
    eval: Record<string, number>;
    treeLength: number;
    extensionSteps: number;
    planLength: number;
  };
  replayDiag: {
    wallMs: number;
    cpuMs: number;
    evalCalls: number;
  };
}

const records: ArmRecord[] = [];

for (const root of roots) {
  for (const arm of ['UCT-R', 'UCT-H'] as const) {
    const rollout = arm === 'UCT-H' ? 'hybrid' : 'random';
    const seed = uctSeed(root.id, arm, 1);
    resetEvaluationCalls();
    const c0 = process.cpuUsage();
    const t0 = nowMs();
    const search = new UctSearch(root.state, {
      rules,
      deadlineMs: MAIN_SEARCH_BUDGET_MS,
      maxHandoffs: MAX_HANDOFFS,
      maxNodes: MAX_NODES,
      c: UCB_C,
      seed,
      rollout,
    });
    const result = search.run();
    const wallMs = nowMs() - t0;
    const cpuMs = cpuMsSince(c0);
    const ev = counters();
    const replay0 = nowMs();
    const replay = replayPlanWithEngine(root.state, result.plan);
    const replayWall = nowMs() - replay0;

    resetEvaluationCalls();
    const ext0 = nowMs();
    const cExt0 = process.cpuUsage();
    const ext = search.extractPlan();
    const extWall = nowMs() - ext0;
    const extCpu = cpuMsSince(cExt0);
    const extEval = counters();

    resetEvaluationCalls();
    const rp0 = nowMs();
    const cRp0 = process.cpuUsage();
    replayPlanWithEngine(root.state, result.plan);
    const rpWall = nowMs() - rp0;
    const rpCpu = cpuMsSince(cRp0);
    const rpEval = counters();

    const maxVisits = Math.max(0, ...result.rootActionStats.map((r) => r.visits));
    const chosen = result.rootAction ? `${result.rootAction.type}:${(result.rootAction as any).direction?.key ?? ''}` : null;
    records.push({
      rootId: root.id,
      arm,
      rootStateKey: root.stateKey,
      rootEligible: isHybridEligibleState(root.state),
      seed,
      wallMs,
      cpuMs,
      searchElapsedMs: result.diagnostics.elapsedMs,
      sims: result.diagnostics.simulations,
      aborted: result.diagnostics.abortedSimulations,
      nodes: result.diagnostics.nodesCreated,
      chanceNodes: result.diagnostics.chanceNodes,
      chanceSamples: result.diagnostics.chanceSamples,
      rolloutSteps: result.diagnostics.rolloutSteps,
      maxHandoffsReached: result.diagnostics.maxHandoffsReached,
      deadlineHit: result.diagnostics.deadlineHit,
      nodeCapHit: result.diagnostics.nodeCapHit,
      postDeadlineNodeCreations: result.diagnostics.postDeadlineNodeCreations,
      eval: ev,
      evalPerSim: result.diagnostics.simulations > 0 ? ev.evaluations / result.diagnostics.simulations : 0,
      evalPerRolloutStep: result.diagnostics.rolloutSteps > 0 ? ev.evaluations / result.diagnostics.rolloutSteps : 0,
      bfsPerEval: ev.evaluations > 0 ? (ev.mouseBfs + ev.catBfs + ev.carryBfs) / ev.evaluations : 0,
      plan: planLabel(result.plan),
      treePlanLength: result.treePlanLength,
      extensionSteps: result.extensionSteps,
      planExtended: result.planExtended,
      planLength: result.plan.length,
      planCost: result.planCost,
      rootAction: chosen,
      rootVisits: result.rootVisits,
      rootMeanReward: result.rootMeanReward,
      rootActions: result.rootActionStats.map((r) => ({
        action: r.key,
        visits: r.visits,
        meanReward: r.meanReward,
        top: r.visits === maxVisits && maxVisits > 0,
        chosen: result.rootAction ? r.key === `${result.rootAction.type === 'catStep' ? 'C' : result.rootAction.type === 'catPlaceTrap' ? 'T' : '?'}:${(result.rootAction as any).direction?.key ?? ''}` : false,
      })),
      replayOk: replay.ok,
      replayFullTurnConsumed: replay.fullTurnConsumed,
      extensionDiag: {
        wallMs: extWall,
        cpuMs: extCpu,
        eval: extEval,
        treeLength: ext.treeLength,
        extensionSteps: ext.extensionSteps,
        planLength: ext.plan.length,
      },
      replayDiag: {
        wallMs: rpWall,
        cpuMs: rpCpu,
        evalCalls: rpEval.evaluations,
      },
    });
    console.log(`DIAG ${arm} ${root.id} sims=${result.diagnostics.simulations} nodes=${result.diagnostics.nodesCreated} evals=${ev.evaluations} rolloutSteps=${result.diagnostics.rolloutSteps} treePlan=${result.treePlanLength} ext=${result.extensionSteps}`);
  }
}

// ---------------------------------------------------------------------------
// Direct evaluator microbenchmark on distinct reachable states.
// ---------------------------------------------------------------------------
function sampleStates(rootState: any, n: number, seed: number): any[] {
  const rng = mulberry32(seed);
  let s = structuredClone(rootState);
  const out: any[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n * 4 && out.length < n; i++) {
    if (s.phase !== GamePhase.Playing) break;
    const acts = generateLegalSearchActions(s, rules);
    if (acts.length === 0) break;
    const a = acts[rng.int(acts.length)];
    const res = simulateSearchAction(s, a, rules);
    if (res.kind === 'chance') {
      const idx = sampleWeighted(res.outcomes.map((o) => o.weight), rng);
      s = structuredClone(res.outcomes[idx].state);
    } else {
      s = structuredClone(res.state);
    }
    const key = JSON.stringify({ c: s.catPosition, m: s.mousePosition, p: s.currentPlayer, b: s.butterPositions, t: s.trapPosition, ph: s.phase });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(structuredClone(s));
  }
  return out;
}

function timedBatch(fn: (s: any) => number, states: any[], reps: number): { wallUs: number[]; cpuMs: number; checksum: number } {
  const wallUs: number[] = [];
  let checksum = 0;
  const c0 = process.cpuUsage();
  for (let r = 0; r < reps; r++) {
    for (const s of states) {
      const t0 = process.hrtime.bigint();
      checksum += fn(s);
      const dt = Number(process.hrtime.bigint() - t0) / 1000;
      wallUs.push(dt);
    }
  }
  const cpuMs = cpuMsSince(c0);
  return { wallUs, cpuMs, checksum };
}

function quantile(a: number[], p: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

// Warm up on the first root (do not score).
for (let i = 0; i < 30; i++) hybridEvaluateForCat(roots[0].state);

const benchStates: any[] = [];
for (const root of roots) benchStates.push(...sampleStates(root.state, 6, 0x51ed ^ Number(root.id.length)));

const bench = [];
for (const [name, fn] of [
  ['hybrid', hybridEvaluateForCat],
  ['baseline', evaluateForCat],
  ['valuenet', productionValueNet],
] as const) {
  resetEvaluationCalls();
  const c0 = process.cpuUsage();
  const res = timedBatch(fn, benchStates, 3);
  const cpu = cpuMsSince(c0);
  const ev = counters();
  bench.push({
    name,
    calls: benchStates.length * 3,
    eligibleStates: benchStates.filter(isHybridEligibleState).length,
    states: benchStates.length,
    wallUsP50: quantile(res.wallUs, 50),
    wallUsP95: quantile(res.wallUs, 95),
    wallUsP99: quantile(res.wallUs, 99),
    wallUsMax: Math.max(...res.wallUs),
    wallUsMean: res.wallUs.reduce((a, b) => a + b, 0) / res.wallUs.length,
    cpuMs: cpu,
    usPerCallCpu: (cpu * 1000) / (benchStates.length * 3),
    evalCalls: ev.evaluations,
    bfs: ev,
    checksum: res.checksum,
  });
}

function agg(arm: 'UCT-R' | 'UCT-H') {
  const r = records.filter((x) => x.arm === arm);
  const sum = (f: (x: ArmRecord) => number) => r.reduce((s, x) => s + f(x), 0);
  const mean = (f: (x: ArmRecord) => number) => sum(f) / r.length;
  return {
    n: r.length,
    totalSims: sum((x) => x.sims),
    meanSims: mean((x) => x.sims),
    totalEvals: sum((x) => x.eval.evaluations),
    meanEvals: mean((x) => x.eval.evaluations),
    evalsPerSim: sum((x) => x.eval.evaluations) / sum((x) => x.sims),
    totalMouseBfs: sum((x) => x.eval.mouseBfs),
    totalCatBfs: sum((x) => x.eval.catBfs),
    totalCarryBfs: sum((x) => x.eval.carryBfs),
    totalRolloutSteps: sum((x) => x.rolloutSteps),
    meanRolloutSteps: mean((x) => x.rolloutSteps),
    evalsPerRolloutStep: sum((x) => x.rolloutSteps) > 0 ? sum((x) => x.eval.evaluations) / sum((x) => x.rolloutSteps) : 0,
    meanNodes: mean((x) => x.nodes),
    meanChanceNodes: mean((x) => x.chanceNodes),
    meanChanceSamples: mean((x) => x.chanceSamples),
    meanMaxHandoffs: mean((x) => x.maxHandoffsReached),
    meanTreePlanLength: mean((x) => x.treePlanLength),
    meanExtensionSteps: mean((x) => x.extensionSteps),
    meanPlanLength: mean((x) => x.planLength),
    meanCpuMs: mean((x) => x.cpuMs),
    meanWallMs: mean((x) => x.wallMs),
    usPerSimCpu: (sum((x) => x.cpuMs) * 1000) / sum((x) => x.sims),
    usPerEvalCpu: (sum((x) => x.cpuMs) * 1000) / sum((x) => x.eval.evaluations),
    extensionTotalEvals: sum((x) => x.extensionDiag.eval.evaluations),
    extensionTotalSteps: sum((x) => x.extensionDiag.extensionSteps),
    extensionMeanWallMs: mean((x) => x.extensionDiag.wallMs),
    replayTotalEvals: sum((x) => x.replayDiag.evalCalls),
    replayMeanWallMs: mean((x) => x.replayDiag.wallMs),
    fullTurn: r.filter((x) => x.replayFullTurnConsumed).length,
    replayOk: r.filter((x) => x.replayOk).length,
  };
}

const payload = {
  meta: {
    round: 'PPC-MCTS-01A',
    generatedAt: new Date().toISOString(),
    head: '48eaac6c4f3801d351787696ba5876995b64e8d8',
    fixtureSha256,
    budgets: { mainMs: MAIN_SEARCH_BUDGET_MS, maxHandoffs: MAX_HANDOFFS, maxNodes: MAX_NODES, ucbC: UCB_C },
    repetition: 1,
    note: 'Diagnostic re-run of the unchanged UctSearch. Simulation counts are deadline-bound and therefore machine-load sensitive; evaluator call ratios are structural.',
    externalLoad: 'ai-reliability final run + docmap-studio servers were active during this diagnostic; wall/cpu timings are not official benchmark results.',
  },
  perRoot: records,
  aggregate: { uctR: agg('UCT-R'), uctH: agg('UCT-H') },
  microbench: {
    states: benchStates.length,
    eligibleStates: benchStates.filter(isHybridEligibleState).length,
    results: bench,
  },
};

const outFile = path.join(OUT, 'diagnostics.json');
fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`WROTE ${outFile} roots=${records.length} benchStates=${benchStates.length}`);
