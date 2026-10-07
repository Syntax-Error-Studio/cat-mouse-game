import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { searchBestActionIterative, type IterativeSearchResult } from '../../src/game/ai/expectiminimax';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { classifyGoalThreat } from '../../src/game/ai/threatClassifier';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { GamePhase, PieceType } from '../../src/game/types';

/**
 * G0.3B FINAL REAL-SNAPSHOT VALIDATION (read-only).
 *
 * Runs the PRODUCTION 100ms deadline profile on the G0.2-verified REAL
 * HARD_SEARCH_HISTORY snapshots (Turn 3 / 4 / 5), A/B:
 *   BASELINE = threat ordering OFF + maxThreatExtensions=0
 *   G0.3B    = threat ordering ON  + maxThreatExtensions=2
 *
 * Everything else identical: real wall-clock deadline, maxNodes, evaluator,
 * RuleSet, TT policy, D3 move-ordering baseline profile.
 *
 * Usage:
 *   npx tsx tools/research-archive/g03real.mts <history-file> <runs-per-config>
 *   npx tsx tools/research-archive/g03real.mts "C:\Users\zheng\Downloads\hard-search-history-20260820.txt" 20
 */
const HISTORY_FILE = process.argv[2] ?? 'C:\\Users\\zheng\\Downloads\\hard-search-history-20260820.txt';
const RUNS = Number(process.argv[3] ?? 20);

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
      const snap = JSON.parse(snapM[1]) as HardRootSnapshot;
      out.set(turn, snap);
    } catch (e) {
      console.error(`turn #${turn}: SNAPSHOT_JSON failed to parse: ${(e as Error).message}`);
      process.exit(6);
    }
  }
  return out;
}

function replayPlanToEnd(root: ReturnType<typeof restoreHardRoot>, plan: SearchAction[]): SearchAction[] | null {
  let cur = root;
  const executed: SearchAction[] = [];
  for (const a of plan) {
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
    const t = simulateSearchAction(cur, a, defaultRuleSet);
    if (t.kind !== 'deterministic') return null;
    cur = t.state;
    executed.push(a);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return executed;
}

function countReversals(plan: SearchAction[]): number {
  const OPPOSITES: Record<string, string> = {
    ArrowUp: 'ArrowDown',
    ArrowDown: 'ArrowUp',
    ArrowLeft: 'ArrowRight',
    ArrowRight: 'ArrowLeft',
  };
  let count = 0;
  for (let i = 1; i < plan.length; i++) {
    const a = plan[i - 1];
    const b = plan[i];
    if (a.type !== 'catStep' || b.type !== 'catStep') continue;
    if (OPPOSITES[a.direction!.key] === b.direction!.key) count++;
  }
  return count;
}

interface RunResult {
  completedDepth: number;
  attemptedDepth: number;
  mate: string;
  rootValue: number;
  nodes: number;
  elapsedMs: number;
  extensionsTriggered: number;
  extendedNodes: number;
  criticalLeaves: number;
  extensionAbortCount: number;
  maxExtensionDepth: number;
  plan: string;
  reversalCount: number;
  planLength: number;
}

function runOnce(state: ReturnType<typeof restoreHardRoot>, maxThreatExtensions: number, useThreatOrdering: boolean): RunResult {
  const t0 = performance.now();
  const deadline = t0 + 100; // REAL production 100ms budget
  const res: IterativeSearchResult = searchBestActionIterative(state, {
    rules: defaultRuleSet,
    maxDepthTurns: 4,
    maxNodes: 500_000,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    leafEvaluator: evaluateForCat,
    deadlineMs: deadline,
    now: () => performance.now(),
    maxThreatExtensions,
    useThreatOrdering,
  });
  const elapsed = performance.now() - t0;

  const plan = replayPlanToEnd(state, res.catTurnPlan) ?? [];
  return {
    completedDepth: res.completedDepth,
    attemptedDepth: res.attemptedDepth,
    mate: res.mate ?? 'null',
    rootValue: res.value,
    nodes: res.diagnostics.totalNodes,
    elapsedMs: elapsed,
    extensionsTriggered: res.diagnostics.extensionsTriggered,
    extendedNodes: res.diagnostics.extendedNodes,
    criticalLeaves: res.diagnostics.criticalLeaves,
    extensionAbortCount: res.diagnostics.extensionAbortCount,
    maxExtensionDepth: res.diagnostics.maxExtensionDepth,
    plan: plan.map((a) => (a.type === 'catStep' ? a.direction!.key : a.type)).join('→'),
    reversalCount: countReversals(plan),
    planLength: plan.length,
  };
}

function summarize(label: string, runs: RunResult[]): void {
  const n = runs.length;
  const count = (f: (r: RunResult) => boolean) => runs.filter(f).length;
  const distribution = (f: (r: RunResult) => number): string => {
    const m = new Map<number, number>();
    for (const r of runs) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' ');
  };
  const avg = (f: (r: RunResult) => number) => (runs.reduce((a, r) => a + f(r), 0) / n).toFixed(1);
  const mateRecognition = count((r) => r.mate === 'mouse');

  console.log(`--- ${label} (n=${n}) ---`);
  console.log(`completedDepth dist  : ${distribution((r) => r.completedDepth)}`);
  console.log(`attemptedDepth dist   : ${distribution((r) => r.attemptedDepth)}`);
  console.log(`mate=mouse recognition: ${mateRecognition}/${n}`);
  console.log(`rootValue range       : ${Math.min(...runs.map((r) => r.rootValue))} .. ${Math.max(...runs.map((r) => r.rootValue))}`);
  console.log(`nodes avg             : ${avg((r) => r.nodes)}`);
  console.log(`elapsedMs avg         : ${avg((r) => r.elapsedMs)}`);
  console.log(`extensionsTriggered   : ${avg((r) => r.extensionsTriggered)}`);
  console.log(`extendedNodes avg     : ${avg((r) => r.extendedNodes)}`);
  console.log(`criticalLeaves avg    : ${avg((r) => r.criticalLeaves)}`);
  console.log(`extensionAbortCount   : ${avg((r) => r.extensionAbortCount)}`);
  console.log(`maxExtensionDepth     : ${distribution((r) => r.maxExtensionDepth)}`);
  console.log(`plan distribution     : ${distribution((r) => r.plan)}`);
  console.log(`reversalCount dist    : ${distribution((r) => r.reversalCount)}`);
  console.log('');
}

function rawTable(turn: number, baseline: RunResult[], g03b: RunResult[]): void {
  console.log(`--- REAL Turn #${turn} raw runs (BASELINE vs G0.3B) ---`);
  for (let i = 0; i < Math.max(baseline.length, g03b.length); i++) {
    const b = baseline[i];
    const g = g03b[i];
    const fmt = (r: RunResult | undefined) => r
      ? `${String(r.completedDepth).padStart(2)}/${String(r.attemptedDepth).padStart(2)} ${String(r.mate).padEnd(5)} ${String(r.rootValue).padStart(10)} n=${String(r.nodes).padStart(6)} ms=${r.elapsedMs.toFixed(0).padStart(4)} ext=${r.extensionsTriggered} maxExt=${r.maxExtensionDepth} [${r.plan}] rev=${r.reversalCount}`
      : ''.padEnd(100);
    console.log(`  #${String(i).padStart(2)} BL: ${fmt(b)}`);
    console.log(`      G0: ${fmt(g)}`);
  }
  console.log('');
}

function main(): void {
  console.log(`G0.3B FINAL REAL-SNAPSHOT VALIDATION`);
  console.log(`history file: ${HISTORY_FILE}`);
  console.log(`runs per config: ${RUNS}\n`);

  const snaps = parseHistory(readFileSync(HISTORY_FILE, 'utf8'));
  const wanted = [3, 4, 5];
  for (const turn of wanted) {
    if (!snaps.has(turn)) {
      console.error(`REAL Turn #${turn} snapshot missing from history`);
      process.exit(7);
    }
  }

  for (const turn of wanted) {
    const snap = snaps.get(turn)!;
    const state = restoreHardRoot(snap);
    const cat = `${state.catPosition.r},${state.catPosition.c}`;
    const mouse = `${state.mousePosition.r},${state.mousePosition.c}`;
    const threat = classifyGoalThreat(state);
    console.log(`\n==================================================`);
    console.log(`REAL Turn #${turn}  cat=${cat} mouse=${mouse} butter=${state.mouseHasButter}`);
    console.log(`threat classifier → ${threat.urgency} (winRoute=${threat.winRoute})`);
    console.log(`==================================================`);

    const baseline: RunResult[] = [];
    const g03b: RunResult[] = [];
    for (let i = 0; i < RUNS; i++) {
      baseline.push(runOnce(state, 0, false));
      g03b.push(runOnce(state, 2, true));
    }

    rawTable(turn, baseline, g03b);
    summarize('BASELINE (threat-ordering OFF, ext=0)', baseline);
    summarize('G0.3B     (threat-ordering ON,  ext=2)', g03b);

    // Turn5 G0.3A check: mate must remain mouse; the forced-loss secondary
    // must NOT regress to the old Up→Down→Up→Down oscillation (reversal=3).
    if (turn === 5) {
      const mateOk = g03b.every((r) => r.mate === 'mouse');
      const maxRev = Math.max(...g03b.map((r) => r.reversalCount));
      console.log(`[G0.3A] Turn5 mate=mouse in ALL G0.3B runs: ${mateOk}`);
      console.log(`[G0.3A] Turn5 max reversalCount (G0.3B): ${maxRev} (old oscillation was 3)`);
      if (!mateOk || maxRev > 1) {
        console.log(`[G0.3A] ⚠ REGRESSION DETECTED`);
      } else {
        console.log(`[G0.3A] ✅ G0.3A secondary tie-break preserved`);
      }
      console.log('');
    }
  }
}

main();