/**
 * PPC-MCTS-01A — semantics-preserving function-call coverage for the unchanged
 * UctSearch. Uses V8 precise coverage (call counts) only; it does not patch the
 * algorithm or the evaluator.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import inspector from 'node:inspector';
import { loadRoots, UCB_C, MAX_HANDOFFS, MAX_NODES, MAIN_SEARCH_BUDGET_MS } from '../../PPC-MCTS-01/proto/harness';
import { UctSearch, uctSeed } from '../../PPC-MCTS-01/proto/uct';
import { createEngineRuleSet } from '../../src/game/engine';

const session = new inspector.Session();
session.connect();
const post = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => {
  session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
});
await post('Profiler.enable');
await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });

const { roots, fixtureSha256 } = loadRoots(process.cwd());
const rules = createEngineRuleSet();
const onlyOne = process.argv.includes('--one');
const selected = onlyOne ? roots.slice(0, 1) : roots;

const NAMES = [
  'guidanceValue', 'selectRolloutAction', 'evaluateLeaf', 'hybridEvaluateForCat',
  'productionValueNet', 'evaluateForCatDetailed', 'simulateSearchAction',
  'selectEdge', 'applyEdge', 'extractPlan', 'rollout', 'simulate', 'createDecision',
  'terminalReward', 'isHybridEligibleState', 'buildContext', 'featuresFromContext',
];

interface CovRow { arm: string; rootId: string; sims: number; counts: Record<string, number> }
const rows: CovRow[] = [];

for (const root of selected) {
  for (const arm of ['UCT-R', 'UCT-H'] as const) {
    await post('Profiler.takePreciseCoverage'); // discard prior
    const search = new UctSearch(root.state, {
      rules,
      deadlineMs: MAIN_SEARCH_BUDGET_MS,
      maxHandoffs: MAX_HANDOFFS,
      maxNodes: MAX_NODES,
      c: UCB_C,
      seed: uctSeed(root.id, arm, 1),
      rollout: arm === 'UCT-H' ? 'hybrid' : 'random',
    });
    const result = search.run();
    const cov = await post('Profiler.takePreciseCoverage');
    const counts: Record<string, number> = {};
    for (const script of cov.result) {
      for (const fn of script.functions) {
        const name = fn.functionName;
        if (!name) continue;
        if (!NAMES.includes(name)) continue;
        const top = fn.ranges?.[0]?.count ?? 0;
        counts[name] = (counts[name] ?? 0) + top;
      }
    }
    rows.push({ arm, rootId: root.id, sims: result.diagnostics.simulations, counts });
    console.log(`COV ${arm} ${root.id} sims=${result.diagnostics.simulations} guidance=${counts.guidanceValue ?? 0} select=${counts.selectRolloutAction ?? 0} evalLeaf=${counts.evaluateLeaf ?? 0} hybrid=${counts.hybridEvaluateForCat ?? 0}`);
  }
}

await post('Profiler.stopPreciseCoverage');
session.disconnect();

const agg = (arm: string) => {
  const a = rows.filter((r) => r.arm === arm);
  const total = (n: string) => a.reduce((s, r) => s + (r.counts[n] ?? 0), 0);
  const sims = a.reduce((s, r) => s + r.sims, 0);
  return {
    n: a.length,
    sims,
    guidance: total('guidanceValue'),
    guidancePerSim: sims > 0 ? total('guidanceValue') / sims : 0,
    selectRollout: total('selectRolloutAction'),
    selectPerSim: sims > 0 ? total('selectRolloutAction') / sims : 0,
    evaluateLeaf: total('evaluateLeaf'),
    hybrid: total('hybridEvaluateForCat'),
    baseline: total('evaluateForCatDetailed'),
    valuenet: total('productionValueNet'),
    simulateSearchAction: total('simulateSearchAction'),
    selectEdge: total('selectEdge'),
    applyEdge: total('applyEdge'),
    extractPlan: total('extractPlan'),
    terminalReward: total('terminalReward'),
    buildContext: total('buildContext'),
  };
};

const out = {
  meta: {
    round: 'PPC-MCTS-01A',
    generatedAt: new Date().toISOString(),
    fixtureSha256,
    method: 'V8 Profiler.startPreciseCoverage(callCount:true) around the unchanged UctSearch.run()',
    caveat: 'Coverage instrumentation slows execution, so sims differ from the uninstrumented smoke; ratios/counts are diagnostic.',
    onlyOne,
  },
  rows,
  aggregate: { uctR: agg('UCT-R'), uctH: agg('UCT-H') },
};
const file = path.resolve('PPC-MCTS-01A/data/function-coverage.json');
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`WROTE ${file}`);
