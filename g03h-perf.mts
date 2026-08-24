/**
 * G0.3H — Section 5: performance (evaluator hot path, no regression).
 *
 * Runs the PRODUCTION planner (planHardCatTurn, leaf = evaluateForCat which is
 * now fixed) on REAL Turn3/4/5 roots, 20 runs each, measuring:
 *   completedDepth / nodes / elapsedMs / fallback (no solution or empty plan).
 * A side-by-side BASELINE reconstruction (baselineLeaf override) proves the fix
 * is not slower: the only leaf difference is a single branch.
 *
 * Does NOT modify src/.
 *
 * Usage:
 *   node_modules/.bin/esbuild g03h-perf.mts --bundle --platform=node --format=esm --outfile=g03h-perf.run.mjs
 *   node g03h-perf.run.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { GameEngineState } from './src/game/engine';
import { restoreHardRoot, type HardRootSnapshot } from './src/game/ai/hardHistory';
import {
  evaluateForCat,
  evaluateForCatDetailed,
  DEFAULT_EVALUATION_WEIGHTS,
  HEURISTIC_LIMIT,
} from './src/game/ai/evaluation';
import { defaultRuleSet } from './src/game/ai/searchRules';
import { planHardCatTurn } from './src/game/ai/hardTurnPlanner';

function baselineLeaf(state: GameEngineState): number {
  const d = evaluateForCatDetailed(state);
  let total = d.total;
  if (d.features.mouseHasButter && d.features.mouseButterDistance !== null) {
    const bs = state.config.boardSize;
    const oldBR = (d.features.mouseButterDistance / bs) * DEFAULT_EVALUATION_WEIGHTS.butterRace;
    total = d.total + oldBR;
    if (total > HEURISTIC_LIMIT) total = HEURISTIC_LIMIT;
    else if (total < -HEURISTIC_LIMIT) total = -HEURISTIC_LIMIT;
  }
  return total;
}

function parseTurns(): { tag: string; root: GameEngineState | null; butter: boolean }[] {
  const out: { tag: string; root: GameEngineState | null; butter: boolean }[] = [];
  const text = readFileSync('F:\\小猫小鼠\\real-failure-5games.txt', 'utf8');
  const re = /===== GAME (\d+) =====/g;
  const games: { game: string; body: string }[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = text.indexOf('===== GAME ', start + m[0].length);
    const body = end < 0 ? text.slice(start) : text.slice(start, end);
    games.push({ game: m[1], body });
  }
  for (const g of games) {
    const blocks = g.body.split(/Turn\s*#(\d+)/).slice(1);
    for (let i = 0; i + 1 < blocks.length; i += 2) {
      const turn = Number(blocks[i]);
      if (turn < 3 || turn > 5) continue;
      const m2 = blocks[i + 1].match(/SNAPSHOT_JSON=(\{.*\})/);
      if (!m2) continue;
      const snap = JSON.parse(m2[1]) as HardRootSnapshot & { mouseHasButter: boolean };
      let root: GameEngineState | null = null;
      try { root = restoreHardRoot(snap); } catch { root = null; }
      out.push({ tag: `${g.game}#${turn}`, root, butter: !!snap.mouseHasButter });
    }
  }
  return out;
}

const lines: string[] = [];
const log = (s: string) => { lines.push(s); console.log(s); };

log('=== G0.3H §5 — performance (production planner, 20 runs/root) ===\n');

const TIME_BUDGET = 100; // ms, production-like
const MAX_NODES = 500_000;
const RUNS = 20;

const roots = parseTurns().filter((r) => r.root !== null) as { tag: string; root: GameEngineState; butter: boolean }[];
log(`real Turn3/4/5 roots available (restored): ${roots.map((r) => `${r.tag}${r.butter ? '(carry)' : ''}`).join(', ')}\n`);

function runMode(root: GameEngineState, leaf: (s: GameEngineState) => number) {
  const depths: number[] = [];
  const nodes: number[] = [];
  const elaps: number[] = [];
  let fallback = 0;
  for (let i = 0; i < RUNS; i++) {
    const p = planHardCatTurn(root, {
      rules: defaultRuleSet,
      timeBudgetMs: TIME_BUDGET,
      maxNodes: MAX_NODES,
      leafEvaluator: leaf,
    });
    depths.push(p.completedDepth);
    nodes.push(p.debug.nodes);
    elaps.push(p.elapsedMs);
    if (!p.hasSolution || p.plan.length === 0) fallback++;
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const min = (a: number[]) => Math.min(...a);
  const max = (a: number[]) => Math.max(...a);
  const dist = (a: number[]) => {
    const c: Record<number, number> = {};
    for (const v of a) c[v] = (c[v] ?? 0) + 1;
    return Object.entries(c).map(([k, v]) => `${k}×${v}`).join(' ');
  };
  return {
    avgDepth: avg(depths), depthDist: dist(depths),
    avgNodes: avg(nodes), minNodes: min(nodes), maxNodes: max(nodes),
    avgMs: avg(elaps), minMs: min(elaps), maxMs: max(elaps),
    fallback,
  };
}

for (const { tag, root, butter } of roots) {
  log(`## ${tag} (mouseHasButter=${butter})`);
  const fix = runMode(root, evaluateForCat);
  const base = runMode(root, baselineLeaf);
  log(`  FIXED   completedDepth avg=${fix.avgDepth.toFixed(2)} [${fix.depthDist}]  nodes avg=${fix.avgNodes.toFixed(0)} (${fix.minNodes}-${fix.maxNodes})  ms avg=${fix.avgMs.toFixed(2)} (${fix.minMs}-${fix.maxMs})  fallback=${fix.fallback}/${RUNS}`);
  log(`  BASELN  completedDepth avg=${base.avgDepth.toFixed(2)} [${base.depthDist}]  nodes avg=${base.avgNodes.toFixed(0)} (${base.minNodes}-${base.maxNodes})  ms avg=${base.avgMs.toFixed(2)} (${base.minMs}-${base.maxMs})  fallback=${base.fallback}/${RUNS}`);
  const msRegress = base.avgMs - fix.avgMs;
  log(`  Δms (BASELN-FIXED) = ${msRegress.toFixed(3)}  -> ${Math.abs(msRegress) < 5 ? 'NO systematic regression' : 'REGRESSION?'}`);
  log('');
}

writeFileSync('F:\\小猫小鼠\\g03h-perf-output.txt', lines.join('\n'));
console.log('\n=== DONE (wrote g03h-perf-output.txt) ===');
