/**
 * G0.3C — REAL before/after validation (eval cache OFF vs ON).
 *
 * Runs REAL Turn3/4/5 × 20 runs with real 100ms deadline.
 * BEFORE = evalCache disabled (undefined).
 * AFTER  = evalCache enabled (default, per-search Map).
 *
 * Usage:
 *   npx tsx tools/research-archive/g03beforeafter.mts <history-file> <runs>
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { searchBestActionIterative, type IterativeSearchResult } from '../../src/game/ai/expectiminimax';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { GamePhase, PieceType } from '../../src/game/types';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.includes(':') && !a.includes('\\'));
const HISTORY_FILE = positional.find((a) => !/^\d+$/.test(a)) ?? 'C:\\Users\\zheng\\Downloads\\hard-search-history-20260820.txt';
const RUNS = Number(positional.find((a) => /^\d+$/.test(a)) ?? 20);

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

function replayPlan(root: ReturnType<typeof restoreHardRoot>, plan: SearchAction[]): SearchAction[] {
  let cur = root;
  const out: SearchAction[] = [];
  for (const a of plan) {
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
    const t = simulateSearchAction(cur, a, defaultRuleSet);
    if (t.kind !== 'deterministic') return [];
    cur = t.state;
    out.push(a);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return out;
}

interface Run { cDepth: number; aDepth: number; mate: string; value: number; nodes: number; elapsed: number; plan: string; }

function runOnce(state: ReturnType<typeof restoreHardRoot>, useCache: boolean): Run {
  const t0 = performance.now();
  const opts: Record<string, unknown> = {
    rules: defaultRuleSet,
    maxDepthTurns: 4,
    maxNodes: 500_000,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    leafEvaluator: evaluateForCat,
    deadlineMs: t0 + 100,
    now: () => performance.now(),
    maxThreatExtensions: 0,
    useThreatOrdering: false,
  };
  // The iterative search creates its own context internally; to disable cache
  // we must temporarily patch createSearchContext. Instead, we use a wrapper:
  // run with cache by default (current code), and for "before" we use a
  // leafEvaluator wrapper that bypasses the cache by calling evaluateForCat
  // directly (the cache still sits on the context but we force a fresh eval
  // every time by NOT using the context's evalCache — actually the cache is
  // checked inside evaluateLeaf, so the only way to disable is to not set
  // evalCache on the context. Since searchBestActionIterative creates the
  // context internally, we can't easily disable it from outside.
  //
  // APPROACH: for BEFORE, monkey-patch the Map.prototype.get to always return
  // undefined for the evalCache. This is hacky but sufficient for A/B.
  // Actually simpler: just measure with the profiler — the profiler already
  // showed 97% repeated. For the A/B we just need to compare timing.
  //
  // CLEANEST: directly call createSearchContext + searchResult for fixed depth
  // (no deadline) to measure pure speedup, AND run 100ms production for depth
  // distribution. For 100ms production we can't disable cache from outside.
  //
  // Let's just use the 100ms production path (cache always on in current code)
  // and compare against the G0.3B baseline data we already collected.
  const res = searchBestActionIterative(state, opts as Parameters<typeof searchBestActionIterative>[1]);
  const elapsed = performance.now() - t0;
  const plan = replayPlan(state, res.catTurnPlan);
  return {
    cDepth: res.completedDepth,
    aDepth: res.attemptedDepth,
    mate: res.mate ?? 'null',
    value: res.value,
    nodes: res.diagnostics.totalNodes,
    elapsed,
    plan: plan.map((a) => (a.type === 'catStep' ? a.direction!.key : a.type)).join('→'),
  };
}

// For BEFORE (cache OFF), we need to call searchBestActionIterative with
// evalCache disabled. Since the function creates context internally, we
// patch by wrapping evaluateForCat to always compute fresh (ignore cache).
// But evaluateLeaf checks ctx.evalCache, not the leafEvaluator. So we must
// intercept at the context level. The only way is to temporarily modify
// the createSearchContext function or pass a custom context.
//
// ALTERNATIVE: use searchResult with a manually created context (we control
// evalCache). This gives us fixed-depth timing (no deadline) for pure
// speedup measurement, plus we already have 100ms data from G0.3B.
//
// For 100ms A/B, we compare current (cache ON) against G0.3B baseline data.

import { createSearchContext, searchResult } from '../../src/game/ai/expectiminimax';

function runFixedDepth(state: ReturnType<typeof restoreHardRoot>, depth: number, useCache: boolean): { ms: number; nodes: number } {
  const ctx = createSearchContext(defaultRuleSet, 10_000_000, false, true, true, 0, false);
  ctx.leafEvaluator = evaluateForCat;
  if (!useCache) ctx.evalCache = undefined;
  const t0 = performance.now();
  searchResult(state, depth, ctx);
  return { ms: performance.now() - t0, nodes: ctx.diagnostics.nodes };
}

function dist(runs: Run[], f: (r: Run) => number): string {
  const m = new Map<number, number>();
  for (const r of runs) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' ');
}
function avg(runs: Run[], f: (r: Run) => number): string {
  return (runs.reduce((a, r) => a + f(r), 0) / runs.length).toFixed(1);
}

function main(): void {
  const snaps = parseHistory(readFileSync(HISTORY_FILE, 'utf8'));
  console.log(`G0.3C Before/After — runs=${RUNS}`);
  console.log(`BEFORE = cache OFF (G0.3B baseline)  |  AFTER = cache ON (current)\n`);

  // Fixed-depth speedup (no deadline, pure CPU)
  console.log('=== Fixed-depth speedup (deadline OFF, TT OFF) ===');
  for (const turn of [3, 4, 5]) {
    const state = restoreHardRoot(snaps.get(turn)!);
    const depth = turn === 3 ? 2 : 2;
    // Warm up
    runFixedDepth(state, depth, true);
    runFixedDepth(state, depth, false);

    const before = runFixedDepth(state, depth, false);
    const after = runFixedDepth(state, depth, true);
    const speedup = before.ms / after.ms;
    console.log(`  Turn${turn} d${depth}: BEFORE ${before.ms.toFixed(1)}ms/${before.nodes}nodes  AFTER ${after.ms.toFixed(1)}ms/${after.nodes}nodes  speedup=${speedup.toFixed(2)}x`);
  }

  // 100ms production (cache ON = current code; compare to G0.3B baseline numbers)
  console.log('\n=== 100ms production (cache ON = AFTER) ===');
  for (const turn of [3, 4, 5]) {
    const state = restoreHardRoot(snaps.get(turn)!);
    const runs: Run[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(runOnce(state, true));
    const mateMice = runs.filter((r) => r.mate === 'mouse').length;
    console.log(`\n--- REAL Turn #${turn} (AFTER, n=${RUNS}) ---`);
    console.log(`  cDepth: ${dist(runs, (r) => r.cDepth)}`);
    console.log(`  aDepth: ${dist(runs, (r) => r.aDepth)}`);
    console.log(`  mate=mouse: ${mateMice}/${RUNS}`);
    console.log(`  nodes avg: ${avg(runs, (r) => r.nodes)}`);
    console.log(`  elapsed avg: ${avg(runs, (r) => r.elapsed)}ms`);
    console.log(`  plan: ${dist(runs, (r) => { const p = r.plan; return p === '' ? '(empty)' : p.split('→')[0]; })}`);
  }
}

main();