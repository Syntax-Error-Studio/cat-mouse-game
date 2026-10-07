/**
 * G0.3B — Fixed-depth correctness gate: LEGACY vs OFF_PATH (deadline OFF).
 *
 * Runs the same REAL snapshots at fixed depthTurns ∈ {1,2,3} with large
 * maxNodes and NO deadline, comparing:
 *   - rootValue
 *   - mate
 *   - per-root-action (value, mate)
 *
 * Must be byte-identical between LEGACY (a713bca) and CURRENT-off
 * (useThreatOrdering=false, maxThreatExtensions=0). Any mismatch = feature-off
 * overhead polluted the search math.
 *
 * Usage:
 *   npx tsx tools/research-archive/g03fixed.mts <history-file>   (run in BOTH worktrees, diff output)
 */
import { readFileSync } from 'node:fs';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { searchBestActionIterative } from '../../src/game/ai/expectiminimax';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import { evaluateForCat } from '../../src/game/ai/evaluation';

const HISTORY_FILE = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'C:\\Users\\zheng\\Downloads\\hard-search-history-20260820.txt';
const isLegacy = process.argv.includes('--legacy');

function parseHistory(text: string): Map<number, HardRootSnapshot> {
  const blocks = text.split(/Turn\s*#(\d+)/).slice(1);
  const out = new Map<number, HardRootSnapshot>();
  for (let i = 0; i + 1 < blocks.length; i += 2) {
    const turn = Number(blocks[i]);
    const body = blocks[i + 1];
    const snapM = body.match(/SNAPSHOT_JSON=(\{.*\})/);
    if (!snapM) continue;
    try {
      out.set(turn, JSON.parse(snapM[1]) as HardRootSnapshot);
    } catch { /* skip */ }
  }
  return out;
}

function main(): void {
  const snaps = parseHistory(readFileSync(HISTORY_FILE, 'utf8'));
  for (const turn of [3, 4, 5]) {
    const state = restoreHardRoot(snaps.get(turn)!);
    console.log(`=== REAL Turn #${turn} ===`);
    // Turn3 is a known large search tree (G0.2): depth3+ under a big budget is
    // impractically slow. Validate d1/d2 everywhere; d3 only for the smaller
    // Turn4/Turn5 trees.
    const maxDepth = turn === 3 ? 2 : 3;
    for (const depth of [1, 2, maxDepth].filter((v, i, a) => a.indexOf(v) === i)) {
      const res = searchBestActionIterative(state, {
        rules: defaultRuleSet,
        maxDepthTurns: depth,
        maxNodes: 5_000_000,
        useTT: false, // fresh TT each depth to isolate pure math
        useAlphaBeta: true,
        useMoveOrdering: true,
        leafEvaluator: evaluateForCat,
        // NO deadline: fully deterministic
      });
      const rootActs = res.rootActions
        .map((a) => `${a.action.type === 'catStep' ? a.action.direction!.key : a.action.type}=${a.value}/${a.mate ?? 'null'}`)
        .join(' ');
      console.log(`  depth=${depth} value=${res.value} mate=${res.mate ?? 'null'} cDepth=${res.completedDepth}`);
      console.log(`    rootActions: ${rootActs}`);
    }
  }
}

main();