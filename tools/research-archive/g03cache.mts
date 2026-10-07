/**
 * G0.3C — Eval-cache correctness gate: cache OFF vs cache ON.
 *
 * Runs REAL Turn3/4/5 at fixed depth (deadline OFF, 5M nodes, fresh TT) with
 * evalCache disabled vs enabled. rootValue / mate / rootActions must be
 * bit-identical.
 *
 * Usage:
 *   npx tsx tools/research-archive/g03cache.mts <history-file>
 */
import { readFileSync } from 'node:fs';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { searchBestActionIterative, createSearchContext, searchResult } from '../../src/game/ai/expectiminimax';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import { evaluateForCat } from '../../src/game/ai/evaluation';

const HISTORY_FILE = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && !/^\d+$/.test(a) && !a.includes('\\')) ?? 'C:\\Users\\zheng\\Downloads\\hard-search-history-20260820.txt';

function parseHistory(text: string): Map<number, HardRootSnapshot> {
  const blocks = text.split(/Turn\s*#(\d+)/).slice(1);
  const out = new Map<number, HardRootSnapshot>();
  for (let i = 0; i + 1 < blocks.length; i += 2) {
    const turn = Number(blocks[i]);
    const body = blocks[i + 1];
    const snapM = body.match(/SNAPSHOT_JSON=(\{.*\})/);
    if (!snapM) continue;
    try { out.set(turn, JSON.parse(snapM[1]) as HardRootSnapshot); } catch { /* skip */ }
  }
  return out;
}

function runFixed(state: ReturnType<typeof restoreHardRoot>, depth: number, useCache: boolean) {
  const ctx = createSearchContext(defaultRuleSet, 5_000_000, false, true, true, 0, false);
  ctx.leafEvaluator = evaluateForCat;
  if (!useCache) ctx.evalCache = undefined; // disable cache
  const res = searchResult(state, depth, ctx);
  return { value: res.value, mate: res.mate, completed: res.completed };
}

function main(): void {
  const snaps = parseHistory(readFileSync(HISTORY_FILE, 'utf8'));
  let allPass = true;

  for (const turn of [3, 4, 5]) {
    const state = restoreHardRoot(snaps.get(turn)!);
    const maxDepth = turn === 3 ? 2 : 3;
    console.log(`=== REAL Turn #${turn} ===`);
    for (const depth of [1, 2, maxDepth].filter((v, i, a) => a.indexOf(v) === i)) {
      const off = runFixed(state, depth, false);
      const on = runFixed(state, depth, true);
      const match = off.value === on.value && off.mate === on.mate && off.completed === on.completed;
      if (!match) allPass = false;
      console.log(`  d=${depth}  OFF: ${off.value}/${off.mate}/${off.completed}  ON: ${on.value}/${on.mate}/${on.completed}  ${match ? '✅' : '❌ MISMATCH'}`);
    }
  }

  console.log(`\n=== ${allPass ? 'ALL BIT-IDENTICAL ✅' : 'MISMATCH DETECTED ❌'} ===`);
}

main();