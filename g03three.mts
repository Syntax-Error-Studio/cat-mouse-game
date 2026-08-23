/**
 * G0.3B — Three-group REAL-snapshot validation runner.
 *
 * Can run against BOTH the LEGACY a713bca code and the CURRENT (G0.3B) code:
 *   --legacy            : run against a713bca (no threat params available);
 *                         only BASELINE-equivalent path exists.
 *   --mode off|order    : CURRENT code only.
 *                         off   = useThreatOrdering=false, maxThreatExtensions=0
 *                         order = useThreatOrdering=true,  maxThreatExtensions=0
 *
 * Everything else identical: real wall-clock 100ms deadline, maxNodes,
 * evaluator, RuleSet, TT policy, D3 move-ordering baseline.
 *
 * Usage (LEGACY worktree):
 *   npx tsx g03three.mts --legacy <history-file> <runs>
 * Usage (current worktree):
 *   npx tsx g03three.mts --mode off   <history-file> <runs>
 *   npx tsx g03three.mts --mode order <history-file> <runs>
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { restoreHardRoot, type HardRootSnapshot } from './src/game/ai/hardHistory';
import { searchBestActionIterative, type IterativeSearchResult } from './src/game/ai/expectiminimax';
import { defaultRuleSet } from './src/game/ai/searchRules';
import { evaluateForCat } from './src/game/ai/evaluation';
import { simulateSearchAction } from './src/game/ai/simulator';
import type { SearchAction } from './src/game/ai/searchTypes';
import { GamePhase, PieceType } from './src/game/types';

const isLegacy = process.argv.includes('--legacy');
const modeIdx = process.argv.indexOf('--mode');
const mode = modeIdx >= 0 ? process.argv[modeIdx + 1] : 'off';
// Positional args: everything that is not a flag and not a value of --mode.
const flagValues = new Set<string>();
if (modeIdx >= 0) {
  flagValues.add(mode);
  flagValues.add('--mode');
}
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && !flagValues.has(a));
const HISTORY_FILE = positional[0] ?? 'C:\\Users\\zheng\\Downloads\\hard-search-history-20260820.txt';
const RUNS = Number(positional[1] ?? 20);

console.log(`mode=${isLegacy ? 'LEGACY(a713bca)' : `CURRENT ${mode}`} runs=${RUNS}`);

function parseHistory(text: string): Map<number, HardRootSnapshot> {
  const blocks = text.split(/Turn\s*#(\d+)/).slice(1);
  const out = new Map<number, HardRootSnapshot>();
  for (let i = 0; i + 1 < blocks.length; i += 2) {
    const turn = Number(blocks[i]);
    const body = blocks[i + 1];
    const snapM = body.match(/SNAPSHOT_JSON=(\{.*\})/);
    if (!snapM) {
      console.error(`turn #${turn}: missing SNAPSHOT_JSON`);
      process.exit(5);
    }
    try {
      out.set(turn, JSON.parse(snapM[1]) as HardRootSnapshot);
    } catch (e) {
      console.error(`turn #${turn}: SNAPSHOT_JSON failed to parse: ${(e as Error).message}`);
      process.exit(6);
    }
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

function countReversals(plan: SearchAction[]): number {
  const OPP: Record<string, string> = {
    ArrowUp: 'ArrowDown', ArrowDown: 'ArrowUp',
    ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft',
  };
  let n = 0;
  for (let i = 1; i < plan.length; i++) {
    const a = plan[i - 1], b = plan[i];
    if (a.type === 'catStep' && b.type === 'catStep' && OPP[a.direction!.key] === b.direction!.key) n++;
  }
  return n;
}

interface Run {
  cDepth: number;
  aDepth: number;
  mate: string;
  value: number;
  nodes: number;
  elapsed: number;
  ext: number;
  extDepth: number;
  plan: string;
  reversals: number;
}

function runOnce(state: ReturnType<typeof restoreHardRoot>): Run {
  const t0 = performance.now();
  const base = {
    rules: defaultRuleSet,
    maxDepthTurns: 4,
    maxNodes: 500_000,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    leafEvaluator: evaluateForCat,
    deadlineMs: t0 + 100,
    now: () => performance.now(),
  };
  const res: IterativeSearchResult = isLegacy
    ? searchBestActionIterative(state, base)
    : searchBestActionIterative(state, {
        ...base,
        useThreatOrdering: mode === 'order',
        maxThreatExtensions: 0,
      });
  const elapsed = performance.now() - t0;
  const plan = replayPlan(state, res.catTurnPlan);
  const d = res.diagnostics as unknown as {
    extensionsTriggered?: number;
    maxExtensionDepth?: number;
  };
  return {
    cDepth: res.completedDepth,
    aDepth: res.attemptedDepth,
    mate: res.mate ?? 'null',
    value: res.value,
    nodes: res.diagnostics.totalNodes,
    elapsed,
    ext: d.extensionsTriggered ?? 0,
    extDepth: d.maxExtensionDepth ?? 0,
    plan: plan.map((a) => (a.type === 'catStep' ? a.direction!.key : a.type)).join('→'),
    reversals: countReversals(plan),
  };
}

function dist(f: (r: Run) => number | string): string {
  const m = new Map<string | number, number>();
  for (const r of runs) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, v]) => `${k}:${v}`).join(' ');
}
let runs: Run[] = [];

function summarize(turn: number, label: string): void {
  const n = runs.length;
  const avg = (f: (r: Run) => number) => (runs.reduce((a, r) => a + f(r), 0) / n).toFixed(1);
  const mateMice = runs.filter((r) => r.mate === 'mouse').length;
  console.log(`--- ${label} (n=${n}) ---`);
  console.log(`completedDepth : ${dist((r) => r.cDepth)}`);
  console.log(`attemptedDepth : ${dist((r) => r.aDepth)}`);
  console.log(`mate=mouse     : ${mateMice}/${n}`);
  console.log(`value range    : ${Math.min(...runs.map((r) => r.value))} .. ${Math.max(...runs.map((r) => r.value))}`);
  console.log(`nodes avg      : ${avg((r) => r.nodes)}`);
  console.log(`elapsed avg    : ${avg((r) => r.elapsed)}ms`);
  console.log(`extensions     : ${avg((r) => r.ext)} (must be 0)`);
  console.log(`extDepth       : ${dist((r) => r.extDepth)}`);
  console.log(`plan           : ${dist((r) => r.plan)}`);
  console.log(`reversals      : ${dist((r) => r.reversals)}`);
  console.log('');
  runs = [];
}

function main(): void {
  const snaps = parseHistory(readFileSync(HISTORY_FILE, 'utf8'));
  for (const turn of [3, 4, 5]) {
    const state = restoreHardRoot(snaps.get(turn)!);
    console.log(`\n=== REAL Turn #${turn}  cat=${state.catPosition.r},${state.catPosition.c} mouse=${state.mousePosition.r},${state.mousePosition.c} butter=${state.mouseHasButter} ===`);
    runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(runOnce(state));
    summarize(turn, isLegacy ? 'LEGACY' : `CURRENT-${mode}`);
  }
}

main();