import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { searchBestActionIterative } from '../../src/game/ai/expectiminimax';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import { evaluateForCat } from '../../src/game/ai/evaluation';

const text = readFileSync('C:\\Users\\zheng\\Downloads\\hard-search-history-20260820.txt', 'utf8');
const blocks = text.split(/Turn\s*#(\d+)/).slice(1);

function getSnap(turn: number): HardRootSnapshot {
  for (let i = 0; i + 1 < blocks.length; i += 2) {
    if (Number(blocks[i]) === turn) {
      const m = blocks[i + 1].match(/SNAPSHOT_JSON=(\{.*\})/);
      if (m) return JSON.parse(m[1]) as HardRootSnapshot;
    }
  }
  throw new Error(`turn ${turn} not found`);
}

for (const turn of [3, 4, 5]) {
  const state = restoreHardRoot(getSnap(turn));
  const dist = new Map<number, number>();
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const res = searchBestActionIterative(state, {
      rules: defaultRuleSet, maxDepthTurns: 4, maxNodes: 500_000,
      useTT: true, useAlphaBeta: true, useMoveOrdering: true,
      leafEvaluator: evaluateForCat, deadlineMs: t0 + 100,
      now: () => performance.now(), maxThreatExtensions: 0, useThreatOrdering: false,
    });
    dist.set(res.completedDepth, (dist.get(res.completedDepth) ?? 0) + 1);
  }
  console.log(`Turn${turn} cDepth: ${[...dist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' ')}`);
}
