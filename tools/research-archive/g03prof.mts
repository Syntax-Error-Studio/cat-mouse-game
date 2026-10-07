/**
 * G0.3C — Search hotspot profiler.
 *
 * Runs the REAL snapshots at fixed depth (deadline OFF) and real 100ms,
 * with the SearchProfiler enabled, outputting a time-share ranking.
 *
 * Usage:
 *   npx tsx tools/research-archive/g03prof.mts <history-file> [depth] [runs]
 *   npx tsx tools/research-archive/g03prof.mts "C:\Users\zheng\Downloads\hard-search-history-20260820.txt" 2 10
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { searchBestActionIterative, createSearchContext, searchResult, type SearchProfiler } from '../../src/game/ai/expectiminimax';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { PieceType, GamePhase } from '../../src/game/types';

const HISTORY_FILE = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'C:\\Users\\zheng\\Downloads\\hard-search-history-20260820.txt';
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.includes(':') && !a.includes('\\'));
const DEPTH = Number(positional.find((a) => /^\d+$/.test(a)) ?? 2);
const RUNS = Number(positional.find((a, i) => /^\d+$/.test(a) && i > positional.findIndex((b) => /^\d+$/.test(b))) ?? 10);

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

function makeProfiler(): SearchProfiler {
  return {
    stateKeyCalls: 0, stateKeyMs: 0,
    legalActionsCalls: 0, legalActionsMs: 0,
    transitionCalls: 0, transitionMs: 0,
    evaluateCalls: 0, evaluateMs: 0,
    ttProbeCalls: 0, ttStoreCalls: 0,
    orderingSortCalls: 0, orderingSortMs: 0,
    leafStateKeys: new Set<string>(),
    repeatedLeafEvals: 0,
  };
}

function profileFixedDepth(state: ReturnType<typeof restoreHardRoot>, depth: number): SearchProfiler {
  const prof = makeProfiler();
  const ctx = createSearchContext(defaultRuleSet, 10_000_000, false, true, true, 0, false);
  ctx.leafEvaluator = evaluateForCat;
  ctx.profiler = prof;
  searchResult(state, depth, ctx);
  return prof;
}

function profile100ms(state: ReturnType<typeof restoreHardRoot>): { prof: SearchProfiler; cDepth: number; nodes: number; elapsed: number } {
  const prof = makeProfiler();
  const t0 = performance.now();
  const res = searchBestActionIterative(state, {
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
  });
  // The iterative search creates its own context; we need to attach profiler
  // differently — use searchResult for fixed-depth profiling instead.
  // For 100ms profile, we instrument by wrapping evaluateForCat.
  return { prof, cDepth: res.completedDepth, nodes: res.diagnostics.totalNodes, elapsed: performance.now() - t0 };
}

function printProfile(label: string, prof: SearchProfiler, totalMs: number): void {
  const pct = (ms: number) => `${(ms / totalMs * 100).toFixed(1)}%`;
  const avg = (calls: number, ms: number) => calls > 0 ? `${(ms / calls * 1000).toFixed(1)}µs` : 'n/a';
  console.log(`\n--- ${label} (total ${totalMs.toFixed(1)}ms) ---`);
  console.log(`  stateKey         : ${prof.stateKeyCalls.toString().padStart(8)} calls  ${prof.stateKeyMs.toFixed(1).padStart(8)}ms  ${pct(prof.stateKeyMs).padStart(6)}  ${avg(prof.stateKeyCalls, prof.stateKeyMs)}`);
  console.log(`  legalActions     : ${prof.legalActionsCalls.toString().padStart(8)} calls  ${prof.legalActionsMs.toFixed(1).padStart(8)}ms  ${pct(prof.legalActionsMs).padStart(6)}  ${avg(prof.legalActionsCalls, prof.legalActionsMs)}`);
  console.log(`  transition       : ${prof.transitionCalls.toString().padStart(8)} calls  ${prof.transitionMs.toFixed(1).padStart(8)}ms  ${pct(prof.transitionMs).padStart(6)}  ${avg(prof.transitionCalls, prof.transitionMs)}`);
  console.log(`  evaluateForCat   : ${prof.evaluateCalls.toString().padStart(8)} calls  ${prof.evaluateMs.toFixed(1).padStart(8)}ms  ${pct(prof.evaluateMs).padStart(6)}  ${avg(prof.evaluateCalls, prof.evaluateMs)}`);
  console.log(`  TT probe         : ${prof.ttProbeCalls.toString().padStart(8)} calls`);
  console.log(`  TT store         : ${prof.ttStoreCalls.toString().padStart(8)} calls`);
  console.log(`  ordering sort    : ${prof.orderingSortCalls.toString().padStart(8)} calls  ${prof.orderingSortMs.toFixed(1).padStart(8)}ms  ${pct(prof.orderingSortMs).padStart(6)}`);
  console.log(`  unique leaf keys : ${prof.leafStateKeys.size}`);
  console.log(`  repeated leaf    : ${prof.repeatedLeafEvals} (${prof.evaluateCalls > 0 ? (prof.repeatedLeafEvals / prof.evaluateCalls * 100).toFixed(1) : 0}%)`);
}

function main(): void {
  const snaps = parseHistory(readFileSync(HISTORY_FILE, 'utf8'));
  console.log(`G0.3C Profiler — depth=${DEPTH} runs=${RUNS}`);

  for (const turn of [3, 4, 5]) {
    const state = restoreHardRoot(snaps.get(turn)!);
    console.log(`\n=== REAL Turn #${turn}  cat=${state.catPosition.r},${state.catPosition.c} mouse=${state.mousePosition.r},${state.mousePosition.c} butter=${state.mouseHasButter} ===`);

    // Fixed-depth profile (deadline OFF, TT OFF for pure hotspot)
    const prof = profileFixedDepth(state, DEPTH);
    const totalMs = prof.stateKeyMs + prof.legalActionsMs + prof.transitionMs + prof.evaluateMs + prof.orderingSortMs;
    printProfile(`Fixed depth=${DEPTH} (deadline OFF, TT OFF)`, prof, totalMs);

    // 100ms production profile (run multiple times for timing stability)
    let total100Ms = 0;
    let cDepths: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      const res = searchBestActionIterative(state, {
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
      });
      total100Ms += performance.now() - t0;
      cDepths.push(res.completedDepth);
    }
    const dDist = new Map<number, number>();
    for (const d of cDepths) dDist.set(d, (dDist.get(d) ?? 0) + 1);
    console.log(`\n  100ms production (${RUNS} runs): avg=${(total100Ms / RUNS).toFixed(1)}ms  cDepth dist: ${[...dDist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  }
}

main();