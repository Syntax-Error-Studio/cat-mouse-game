/**
 * PPC-MCTS-01A — CHANCE cardinality probe (read-only).
 *
 * Walks sampled reachable states with the shared simulator and records how many
 * outcomes a butter-pickup CHANCE layer has. No search is run and no rule is
 * reimplemented.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadRoots } from '../../PPC-MCTS-01/proto/harness';
import { createEngineRuleSet } from '../../src/game/engine';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { mulberry32, sampleWeighted } from '../../PPC-MCTS-01/proto/seededRng';
import { GamePhase } from '../../src/game/types';

const { roots, fixtureSha256 } = loadRoots(process.cwd());
const rules = createEngineRuleSet();
const perRoot: any[] = [];

function walk(rootState: any, rootId: string) {
  const rng = mulberry32(0xc0ffee ^ rootId.length);
  let s = structuredClone(rootState);
  const counts: number[] = [];
  const actionsSeen = new Set<string>();
  for (let step = 0; step < 40; step++) {
    if (s.phase !== GamePhase.Playing) break;
    const acts = generateLegalSearchActions(s, rules);
    for (const a of acts) {
      if (a.type !== 'mouseStep') continue;
      const key = `${a.direction.key}`;
      const res = simulateSearchAction(s, a, rules);
      if (res.kind === 'chance') counts.push(res.outcomes.length);
    }
    if (acts.length === 0) break;
    const a = acts[rng.int(acts.length)];
    const res = simulateSearchAction(s, a, rules);
    if (res.kind === 'chance') {
      const idx = sampleWeighted(res.outcomes.map((o) => o.weight), rng);
      s = structuredClone(res.outcomes[idx].state);
    } else {
      s = structuredClone(res.state);
    }
  }
  return { rootId, samples: counts.length, counts };
}

for (const root of roots) perRoot.push(walk(root.state, root.id));

const all = perRoot.flatMap((r) => r.counts);
const q = (p: number) => {
  if (!all.length) return 0;
  const s = [...all].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const out = {
  meta: {
    round: 'PPC-MCTS-01A',
    generatedAt: new Date().toISOString(),
    fixtureSha256,
    method: 'Read-only random walk with the shared simulator; counts are the number of outcomes in a butter-pickup CHANCE layer.',
    caveat: 'Outcome count is state-dependent and not an average over search rollouts; it bounds the per-candidate evaluation multiplier.',
  },
  perRoot,
  aggregate: {
    chanceLayers: all.length,
    min: all.length ? Math.min(...all) : 0,
    p50: q(50),
    p95: q(95),
    max: all.length ? Math.max(...all) : 0,
    mean: all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0,
    histogram: all.reduce((m, v) => { m[v] = (m[v] ?? 0) + 1; return m; }, {}),
  },
};
const file = path.resolve('PPC-MCTS-01A/data/chance-cardinality.json');
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`WROTE ${file} layers=${all.length} p50=${out.aggregate.p50} max=${out.aggregate.max}`);
