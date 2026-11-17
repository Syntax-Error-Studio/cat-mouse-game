/** diagnostic (throwaway): per-simulation cost calibration under vite-node. */
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEngineRuleSet, type GameEngineState } from '../../../src/game/engine';
import { restoreHardRoot } from '../../../src/game/ai/hardHistory';
import { hybridEvaluateForCat } from '../../../src/game/ai/hybridLeaf';
import { UctSearch, uctSeed } from '../../../PPC-MCTS-01/proto/uct';

const rules = createEngineRuleSet();
const raw = readFileSync(resolve(process.cwd(), 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json'));
const roots = (JSON.parse(raw.toString('utf8')) as { id: string; state: unknown }[])
  .map((r) => ({ id: String(r.id), state: restoreHardRoot(r.state as never) }));
const root = roots.find((r) => r.id === 'G2T6')!;

// leaf evaluator micro-benchmark
hybridEvaluateForCat(root.state);
const N = 2000;
const t = performance.now();
let acc = 0;
for (let i = 0; i < N; i++) acc += hybridEvaluateForCat(root.state);
const leafUs = ((performance.now() - t) / N) * 1000;
console.log(`hybridEvaluateForCat: ${leafUs.toFixed(1)} us/call (acc=${acc.toFixed(3)})`);

// fixed-workload search: ms per simulation
for (const K of [8, 32]) {
  const t0 = performance.now();
  const res = new UctSearch(root.state, {
    rules, deadlineMs: 1, maxHandoffs: 4, maxNodes: K, c: Math.SQRT2,
    seed: uctSeed(root.id, 'UCT-H', 1), rollout: 'hybrid', now: () => 0,
  }).run();
  const ms = performance.now() - t0;
  const d = res.diagnostics;
  console.log(`K=${K}: wall=${ms.toFixed(0)}ms sims=${d.simulations} rolloutSteps=${d.rolloutSteps} -> ${(ms / d.simulations).toFixed(1)} ms/sim, ${(ms / d.rolloutSteps).toFixed(2)} ms/step`);
}
