/**
 * PPC-MCTS-01B-HARNESS-REPAIR — PHASE 2 DRIVER (fixed 100 ms budget, bundle only).
 *
 * Contract (frozen in PHASE2_PREREGISTRATION.json):
 *   PHASE2_ROOTS = 24, PHASE2_REPETITIONS = 20, PHASE2_ARMS = 2
 *   TOTAL_SEARCH_CALLS = 960, FRESH_NODE_PROCESSES = 20
 *   one process = one repetition = 24 roots x 2 arms = 48 calls, strictly serial
 *
 * TIMING SEMANTICS — three DIFFERENT quantities, never mixed:
 *   searchMs               the searcher's own `diagnostics.elapsedMs` (inside run(),
 *                          before extractPlan)
 *   plannerWallMs          wall clock from constructing the searcher to having the
 *                          complete plan back (constructor + run + extractPlan)
 *   replayMs               offline engine replay of that plan, measured separately
 *                          and NEVER charged to the planning budget
 *   validationEndToEndMs   plannerWallMs + replayMs — a validation quantity only
 *
 * 150 ms SEMANTICS — TWO rules, both recorded, neither rewritten:
 *   withinPlanner150ms            = plannerWallMs <= 150      <- authoritative for this round
 *   legacyPilotComparable150ms    = plannerWallMs + replayMs <= 150
 * The second one reproduces the original Pilot boundary exactly:
 * `PPC-MCTS-01/proto/harness.ts:204` is
 * `withinFullTurnBudget: base.totalMs <= FULL_TURN_BUDGET_MS`, and `runUctCall`
 * (harness.ts:290-310) takes `t0` BEFORE `new UctSearch(...)` and reads
 * `totalMs = performance.now() - t0` AFTER `replayPlanWithEngine`, so the Pilot
 * number is REPLAY-INCLUSIVE. It is kept verbatim under its own name so that no
 * historical number has to be reinterpreted, but production planning time is
 * never charged for the offline replay.
 *
 * MUST run as an esbuild bundle (never `vite-node`, never `vitest`):
 *   node PPC-MCTS-01B/scripts/build-drivers.mjs
 *   node PPC-MCTS-01B/build/perfBudget100.mjs --rep=7
 *
 * THIS IS NOT PHASE 2. Phase 2 is the 960-call, 20-process envelope; this file
 * only becomes evidence when driven by `scripts/runPhase2.mjs`. `--smoke` is
 * 2 roots x 1 repetition x 2 arms = 4 calls and proves nothing about speed.
 */
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  loadRoots, runArm, actionLabel,
  MAIN_SEARCH_BUDGET_MS, FULL_TURN_BUDGET_MS, MAX_HANDOFFS, MAX_NODES, UCB_C,
} from './lib/arms';
import type { Arm } from './lib/arms';
import { uctSeed } from '../../PPC-MCTS-01/proto/uct';
import { replayPlanWithEngine } from '../../PPC-MCTS-01/proto/replay';

// ---------------------------------------------------------------------------
// frozen Phase 2 contract
// ---------------------------------------------------------------------------
export const PHASE2_ROOTS = 24;
export const PHASE2_REPETITIONS = 20;
export const PHASE2_ARMS = 2;
export const PHASE2_TOTAL_SEARCH_CALLS = PHASE2_ROOTS * PHASE2_REPETITIONS * PHASE2_ARMS;
export const PHASE2_FRESH_NODE_PROCESSES = PHASE2_REPETITIONS;

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const hasFlag = (f: string): boolean => process.argv.includes(`--${f}`);

const smoke = hasFlag('smoke');

const repFlag = process.argv.find((a) => a.startsWith('--rep='));
const singleRep = repFlag !== undefined;
const rep = singleRep ? Number(repFlag!.slice(6)) : (smoke ? 1 : NaN);
if (singleRep && (!Number.isInteger(rep) || rep < 1 || rep > PHASE2_REPETITIONS)) {
  throw new Error(`bad --rep ${repFlag} (expected 1..${PHASE2_REPETITIONS})`);
}
if (!singleRep && !smoke) {
  throw new Error(
    'Phase 2 must run one repetition per fresh process (SERIAL_FRESH_REPETITIONS=TRUE, ' +
    'FRESH_NODE_PROCESSES=20). Use --rep=k and scripts/runPhase2.mjs; ' +
    'a multi-repetition process would break the pre-registered isolation.',
  );
}

const rootSel = arg('roots', smoke ? 'G1T1,G2T6' : 'all');
if (!smoke && rootSel !== 'all') {
  throw new Error('refusing a partial root set outside --smoke: Phase 2 is defined on all 24 roots');
}

const outDir = arg('outDir', smoke ? 'PPC-MCTS-01B/data/phase2-smoke' : 'PPC-MCTS-01B/data/phase2');
const repTag = String(rep).padStart(2, '0');
const jsonlPath = resolve(process.cwd(), arg('out', `${outDir}/rep-${repTag}.jsonl`));
const ckptPath = resolve(process.cwd(), `${outDir}/rep-${repTag}.checkpoint.json`);
const summaryPath = resolve(process.cwd(), `${outDir}/rep-${repTag}.summary.json`);

const { roots, fixtureSha256 } = loadRoots();
const selected = rootSel === 'all' ? roots : roots.filter((r) => rootSel.split(',').map((s) => s.trim()).includes(r.id));
if (selected.length === 0) throw new Error(`no roots matched --roots=${rootSel}`);

mkdirSync(dirname(jsonlPath), { recursive: true });

// ---------------------------------------------------------------------------
// resume: never delete or truncate existing results
// ---------------------------------------------------------------------------
interface PerfCall {
  arm: Arm;
  root: string;
  repetition: number;
  seed: string;
  order: number;
  // --- the three distinct timing quantities ---
  searchMs: number;
  plannerWallMs: number;
  replayMs: number;
  /** plannerWallMs + replayMs — "validation end to end", never a production budget. */
  validationEndToEndMs: number;
  /** Pilot-compatible total: construction → plan → offline replay (same number as validationEndToEndMs). */
  replayInclusiveTotalMs: number;
  /** plannerWallMs - searchMs = constructor + extractPlan overhead. */
  planOverheadMs: number;
  // --- workload ---
  simulations: number;
  nodesCreated: number;
  rolloutSteps: number;
  chanceSamples: number;
  treePlanLength: number;
  extensionSteps: number;
  planLength: number;
  planActionCost: number;
  plan: string;
  // --- decisions ---
  rootAction: string | null;
  rootActionStats: { key: string; transitionKind: string; visits: number; meanReward: number }[];
  // --- flags ---
  deadlineFired: boolean;
  budgetFired: boolean;
  /**
   * AUTHORITATIVE 150 ms rule for this round:
   *   withinPlanner150ms = plannerWallMs <= 150
   * Production planning never contains the offline replay.
   */
  withinPlanner150ms: boolean;
  /**
   * The ORIGINAL Pilot rule, kept as a separate field so history is never
   * reinterpreted: `PPC-MCTS-01/proto/harness.ts:204` computes
   * `withinFullTurnBudget: base.totalMs <= FULL_TURN_BUDGET_MS` and
   * `runUctCall` (harness.ts:290-310) takes `t0` BEFORE constructing the
   * searcher and reads `totalMs` AFTER `replayPlanWithEngine`, so the Pilot
   * number is REPLAY-INCLUSIVE. Same value as `replayInclusiveTotalMs <= 150`.
   */
  legacyPilotComparable150ms: boolean;
  /** @deprecated alias of legacyPilotComparable150ms, kept so earlier artefacts stay readable. */
  withinFullTurnBudget: boolean;
  /** @deprecated alias of withinPlanner150ms, kept so earlier artefacts stay readable. */
  plannerWithinFullTurnBudget: boolean;
  // --- verification ---
  replayOk: boolean;
  replayTerminal: boolean;
  /** The replay consumed the cat turn (replay.ts:95 `fullTurnConsumed`). */
  planFullTurnConsumed: boolean;
  replaySteps: number;
  mathRandomCalls: number;
  ruleCalls: number;
  rolloutPreparedSteps: number | null;
  rolloutImpureFallbacks: number | null;
  // --- failure ---
  error: string | null;
  errorStack: string | null;
}

const done = new Set<string>();
if (existsSync(jsonlPath)) {
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as { root?: string; arm?: string };
      if (rec.root && rec.arm) done.add(`${rec.root}|${rec.arm}`);
    } catch {
      // A torn last line (process killed mid-append) is ignored, never removed.
    }
  }
  if (done.size > 0) {
    process.stdout.write(`RESUME: ${jsonlPath} already holds ${done.size} arm-records — appending, never truncating\n`);
  }
}

const started = Date.now();
process.stdout.write([
  'PPC-MCTS-01B PHASE 2 — FIXED 100 ms BUDGET',
  `LABEL=${smoke ? 'SMOKE_NOT_EVIDENCE' : 'PHASE2_FORMAL'}`,
  `REPETITION=${rep}/${PHASE2_REPETITIONS}`,
  `FRESH_NODE_PROCESSES=${PHASE2_FRESH_NODE_PROCESSES}`,
  `TOTAL_SEARCH_CALLS=${PHASE2_TOTAL_SEARCH_CALLS}`,
  `HEAVY_WORKER_CONCURRENCY=1`,
  `SERIAL_FRESH_REPETITIONS=TRUE`,
  `FIXTURE_SHA256=${fixtureSha256}`,
  `TIMING=searchMs(searcher) / plannerWallMs(construct→plan) / replayMs(offline, NOT budgeted)`,
  `BUDGET_RULE=withinPlanner150ms = plannerWallMs <= ${FULL_TURN_BUDGET_MS} (AUTHORITATIVE, replay excluded)`,
  `BUDGET_RULE_LEGACY=legacyPilotComparable150ms = plannerWallMs + replayMs <= ${FULL_TURN_BUDGET_MS} (original Pilot, replay-inclusive)` ,
  '',
].join('\n'));

const calls: PerfCall[] = [];

function writeCheckpoint(): void {
  writeFileSync(ckptPath, `${JSON.stringify({
    rep,
    label: smoke ? 'SMOKE_NOT_EVIDENCE' : 'PHASE2_FORMAL',
    completedArmRecords: done.size,
    expectedArmRecords: selected.length * PHASE2_ARMS,
    jsonl: jsonlPath,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

for (let i = 0; i < selected.length; i++) {
  const root = selected[i];
  const seed = uctSeed(root.id, 'UCT-H', rep);
  // Alternate the arm order by repetition so neither arm is systematically the
  // cold one, and record the realised order on every call.
  const order: Arm[] = rep % 2 === 1 ? ['baseline', 'prepared'] : ['prepared', 'baseline'];
  for (let k = 0; k < order.length; k++) {
    const arm = order[k];
    const key = `${root.id}|${arm}`;
    if (done.has(key)) continue;

    let rec: PerfCall;
    const tCall = performance.now();
    try {
      // 'count', not 'throw': the trap-on-butter impurity is a real production
      // path (engine.catMove → sanitizeItemOverlaps → Math.random). Throwing
      // would abort the call instead of measuring it.
      const run = runArm(arm, root.state, { mode: 'hybrid', seed, deadlineMs: MAIN_SEARCH_BUDGET_MS }, 'count');
      const plannerWallMs = run.wallMs;

      const tReplay = performance.now();
      const replay = replayPlanWithEngine(root.state, run.result.plan);
      const replayMs = performance.now() - tReplay;

      const d = run.result.diagnostics as typeof run.result.diagnostics & {
        rolloutPreparedSteps?: number; rolloutImpureFallbacks?: number;
      };
      const replayInclusiveTotalMs = plannerWallMs + replayMs;
      const planCost = (run.result as { planCost?: number }).planCost;

      rec = {
        arm,
        root: root.id,
        repetition: rep,
        seed,
        order: k,
        searchMs: d.elapsedMs,
        plannerWallMs,
        replayMs,
        validationEndToEndMs: replayInclusiveTotalMs,
        replayInclusiveTotalMs,
        planOverheadMs: plannerWallMs - d.elapsedMs,
        simulations: d.simulations,
        nodesCreated: d.nodesCreated,
        rolloutSteps: d.rolloutSteps,
        chanceSamples: d.chanceSamples,
        treePlanLength: run.result.treePlanLength,
        extensionSteps: run.result.extensionSteps,
        planLength: run.result.plan.length,
        planActionCost: typeof planCost === 'number'
          ? planCost
          : run.result.plan.length,
        plan: run.result.plan.map(actionLabel).join(' '),
        rootAction: run.result.rootAction ? actionLabel(run.result.rootAction) : null,
        rootActionStats: run.result.rootActionStats.map((s) => ({
          key: s.key, transitionKind: s.transitionKind, visits: s.visits, meanReward: s.meanReward,
        })),
        deadlineFired: d.deadlineHit,
        budgetFired: d.nodeCapHit,
        withinPlanner150ms: plannerWallMs <= FULL_TURN_BUDGET_MS,
        legacyPilotComparable150ms: replayInclusiveTotalMs <= FULL_TURN_BUDGET_MS,
        withinFullTurnBudget: replayInclusiveTotalMs <= FULL_TURN_BUDGET_MS,
        plannerWithinFullTurnBudget: plannerWallMs <= FULL_TURN_BUDGET_MS,
        replayOk: replay.ok,
        replayTerminal: replay.terminal,
        planFullTurnConsumed: replay.fullTurnConsumed,
        replaySteps: replay.steps.length,
        mathRandomCalls: run.mathRandomCalls,
        ruleCalls: run.ruleCalls,
        rolloutPreparedSteps: d.rolloutPreparedSteps ?? null,
        rolloutImpureFallbacks: d.rolloutImpureFallbacks ?? null,
        error: null,
        errorStack: null,
      };
    } catch (e) {
      const err = e as Error;
      rec = {
        arm,
        root: root.id,
        repetition: rep,
        seed,
        order: k,
        searchMs: 0, plannerWallMs: performance.now() - tCall, replayMs: 0,
        validationEndToEndMs: performance.now() - tCall,
        replayInclusiveTotalMs: performance.now() - tCall, planOverheadMs: 0,
        simulations: 0, nodesCreated: 0, rolloutSteps: 0, chanceSamples: 0,
        treePlanLength: 0, extensionSteps: 0, planLength: 0, planActionCost: 0, plan: '',
        rootAction: null, rootActionStats: [],
        deadlineFired: false, budgetFired: false,
        withinPlanner150ms: false, legacyPilotComparable150ms: false,
        withinFullTurnBudget: false, plannerWithinFullTurnBudget: false,
        replayOk: false, replayTerminal: false, planFullTurnConsumed: false, replaySteps: 0,
        mathRandomCalls: 0, ruleCalls: 0,
        rolloutPreparedSteps: null, rolloutImpureFallbacks: null,
        error: err.message ?? String(e),
        errorStack: err.stack ?? null,
      };
    }

    // Append immediately: a later crash can never cost an earlier result.
    appendFileSync(jsonlPath, `${JSON.stringify(rec)}\n`, 'utf8');
    done.add(key);
    calls.push(rec);
    process.stdout.write(
      `${arm.padEnd(8)} ${root.id.padEnd(6)} rep=${rep} ` +
      `planner=${rec.plannerWallMs.toFixed(1)}ms search=${rec.searchMs.toFixed(1)}ms replay=${rec.replayMs.toFixed(1)}ms ` +
      `sims=${rec.simulations} nodes=${rec.nodesCreated} plan=${rec.replayOk ? 'ok' : 'FAIL'}` +
      `${rec.error ? ` ERROR=${rec.error}` : ''}\n`,
    );
  }
  writeCheckpoint();
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarise(arm: Arm): Record<string, number> {
  const rows = calls.filter((c) => c.arm === arm && c.error === null);
  const planner = rows.map((r) => r.plannerWallMs);
  const search = rows.map((r) => r.searchMs);
  const replay = rows.map((r) => r.replayMs);
  const sims = rows.map((r) => r.simulations).sort((a, b) => a - b);
  return {
    calls: rows.length,
    errors: calls.filter((c) => c.arm === arm && c.error !== null).length,
    plannerMsP50: quantile(planner, 0.5),
    plannerMsP95: quantile(planner, 0.95),
    plannerMsP99: quantile(planner, 0.99),
    searchMsP50: quantile(search, 0.5),
    searchMsP95: quantile(search, 0.95),
    replayMsP50: quantile(replay, 0.5),
    simulationsMedian: quantile(sims, 0.5),
    simulationsMin: sims[0] ?? 0,
    simulationsMax: sims[sims.length - 1] ?? 0,
    withinPlanner150ms: rows.filter((r) => r.withinPlanner150ms).length,
    legacyPilotComparable150ms: rows.filter((r) => r.legacyPilotComparable150ms).length,
    withinFullTurnBudgetPilot: rows.filter((r) => r.withinFullTurnBudget).length,
    withinFullTurnBudgetPlannerOnly: rows.filter((r) => r.plannerWithinFullTurnBudget).length,
    deadlineFired: rows.filter((r) => r.deadlineFired).length,
    budgetFired: rows.filter((r) => r.budgetFired).length,
    replayOk: rows.filter((r) => r.replayOk).length,
    planFullTurnConsumed: rows.filter((r) => r.planFullTurnConsumed).length,
    mathRandomCalls: rows.reduce((s, r) => s + r.mathRandomCalls, 0),
  };
}

const summary = {
  driver: 'perfBudget100',
  label: smoke ? 'SMOKE_NOT_EVIDENCE' : 'PHASE2_FORMAL',
  isPhase2Formal: !smoke,
  note: smoke
    ? 'SMOKE ONLY — 2 roots x 1 repetition x 2 arms. Proves the driver executes; says nothing about performance.'
    : 'One repetition of the pre-registered Phase 2 envelope (24 roots x 2 arms), one fresh process.',
  generatedAt: new Date().toISOString(),
  wallMs: Date.now() - started,
  node: process.version,
  pid: process.pid,
  repetition: rep,
  fixture: { path: 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', sha256: fixtureSha256 },
  contract: {
    PHASE2_ROOTS, PHASE2_REPETITIONS, PHASE2_ARMS,
    PHASE2_TOTAL_SEARCH_CALLS, PHASE2_FRESH_NODE_PROCESSES,
    deadlineMs: MAIN_SEARCH_BUDGET_MS,
    fullTurnBudgetMs: FULL_TURN_BUDGET_MS,
    maxHandoffs: MAX_HANDOFFS,
    maxNodes: MAX_NODES,
    c: UCB_C,
    rollout: 'hybrid',
    now: 'performance.now()',
    seedFormula: "uctSeed(rootId,'UCT-H',repetition) — identical for both arms",
    armOrder: rep % 2 === 1 ? 'baseline,prepared' : 'prepared,baseline',
    budgetRule: 'withinPlanner150ms = plannerWallMs <= 150 (AUTHORITATIVE: production planning, replay excluded)',
    budgetRuleLegacy:
      'legacyPilotComparable150ms = (plannerWallMs + replayMs) <= 150 — the original Pilot rule ' +
      '(harness.ts:204 uses totalMs, and runUctCall reads totalMs after replayPlanWithEngine). ' +
      'Recorded separately; never substituted for, and never overwriting, historical data.',
    validationEndToEndMs: 'plannerWallMs + replayMs (validation only, NOT a production budget)',
  },
  rootsRun: selected.length,
  calls: calls.length,
  resumedRecords: done.size - calls.length,
  jsonl: jsonlPath,
  checkpoint: ckptPath,
  summary: { baseline: summarise('baseline'), prepared: summarise('prepared') },
  verdict: calls.every((c) => c.error === null && c.replayOk) ? 'PASS' : 'FAIL',
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

const b = summary.summary.baseline;
const p = summary.summary.prepared;
process.stdout.write(
  `\nbaseline: planner_p50=${b.plannerMsP50.toFixed(1)}ms search_p50=${b.searchMsP50.toFixed(1)}ms sims_med=${b.simulationsMedian}\n` +
  `prepared: planner_p50=${p.plannerMsP50.toFixed(1)}ms search_p50=${p.searchMsP50.toFixed(1)}ms sims_med=${p.simulationsMedian}\n` +
  `withinPlanner150ms (AUTHORITATIVE, replay excluded): baseline ${b.withinPlanner150ms}/${b.calls}, prepared ${p.withinPlanner150ms}/${p.calls}\n` +
  `legacyPilotComparable150ms (Pilot, replay-inclusive): baseline ${b.legacyPilotComparable150ms}/${b.calls}, prepared ${p.legacyPilotComparable150ms}/${p.calls}\n` +
  `planFullTurnConsumed: baseline ${b.planFullTurnConsumed}/${b.calls}, prepared ${p.planFullTurnConsumed}/${p.calls}\n` +
  `math.random draws = ${b.mathRandomCalls + p.mathRandomCalls}\n` +
  `\n${summary.verdict}\njsonl=${jsonlPath}\nsummary=${summaryPath}\n`,
);
if (summary.verdict !== 'PASS') process.exit(1);
