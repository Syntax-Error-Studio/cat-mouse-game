/**
 * PPC-MCTS-01B-HARNESS-REPAIR — PHASE 1 DRIVER (fixed completed-simulation parity).
 *
 * Contract (frozen in PHASE1_PREREGISTRATION.json):
 *   PHASE1_ROOTS                = 24
 *   PHASE1_REPETITIONS          = 20
 *   PHASE1_ARMS                 = 2
 *   COMPLETED_SIMULATIONS_PER_CALL = 200
 *   TOTAL_SEARCH_CALLS          = 960
 *   FRESH_NODE_PROCESSES        = 20
 *
 * ONE process = ONE repetition = 24 roots x 2 arms = 48 calls.
 *
 * Stop rule: the test-only `maxCompletedSimulations` seam, which is evaluated
 * only BETWEEN simulations. `maxNodes` stays at its production value
 * (500 000) purely as a safety net; if it fires first the call is recorded as
 * `HARNESS_EXECUTION_ANOMALY` and the run FAILS. K is never lowered silently.
 *
 * Usage (the formal envelope is NOT run by this round):
 *   node PPC-MCTS-01B/build/phase1Parity.mjs --rep=7
 *   node PPC-MCTS-01B/build/phase1Parity.mjs --smoke
 *
 * `--smoke` uses 2 roots x 1 repetition and a reduced K, and is labelled
 * SMOKE_NOT_EVIDENCE. It exists to prove the harness runs; it is not Phase 1.
 */
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { loadRoots } from './lib/arms';
import {
  runPhase1Arm, diffPhase1, phase1ExecutionAnomaly, phase1Comparable,
  PHASE1_ROOTS, PHASE1_REPETITIONS, PHASE1_ARMS, COMPLETED_SIMULATIONS_PER_CALL,
  PHASE1_MAX_HANDOFFS, PHASE1_MAX_NODES, PHASE1_TOTAL_SEARCH_CALLS,
  PHASE1_FRESH_NODE_PROCESSES,
} from './lib/phase1';
import type { Phase1Arm, Phase1Run } from './lib/phase1';
import { uctSeed } from '../../PPC-MCTS-01/proto/uct';

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const hasFlag = (f: string): boolean => process.argv.includes(`--${f}`);

const smoke = hasFlag('smoke');

// --rep=k selects a single fresh process; without it the number of repetitions
// defaults to 1 so a bare invocation cannot silently start the whole envelope.
const repArg = process.argv.find((a) => a.startsWith('--rep='));
const rep = repArg ? Number(repArg.slice(6)) : 1;
if (!Number.isInteger(rep) || rep < 1 || rep > PHASE1_REPETITIONS) {
  throw new Error(`bad --rep ${String(repArg)} (expected 1..${PHASE1_REPETITIONS})`);
}

const rootsSel = arg('roots', smoke ? 'G1T1,G2T6' : 'all');

// K is frozen in formal mode. A smaller K is only reachable through --smoke,
// and every record produced that way is stamped SMOKE_NOT_EVIDENCE.
const simsOverride = arg('sims', '');
if (simsOverride !== '' && !smoke) {
  throw new Error(
    'refusing to change COMPLETED_SIMULATIONS_PER_CALL outside --smoke: ' +
    `K is frozen at ${COMPLETED_SIMULATIONS_PER_CALL} by the pre-registration`,
  );
}
const K = smoke ? Number(simsOverride || '20') : COMPLETED_SIMULATIONS_PER_CALL;
if (!Number.isInteger(K) || K <= 0) throw new Error(`bad K=${String(K)}`);

if (!smoke && rootsSel !== 'all') {
  throw new Error('refusing a partial root set outside --smoke: Phase 1 is defined on all 24 roots');
}

const outDir = arg('outDir', smoke ? 'PPC-MCTS-01B/data/phase1-smoke' : 'PPC-MCTS-01B/data/phase1');
const repTag = String(rep).padStart(2, '0');
const jsonlPath = resolve(process.cwd(), `${outDir}/rep-${repTag}.jsonl`);

const { roots, fixtureSha256 } = loadRoots();
const selected = rootsSel === 'all'
  ? roots
  : roots.filter((r) => rootsSel.split(',').map((s) => s.trim()).includes(r.id));
if (selected.length === 0) throw new Error(`no roots matched --roots=${rootsSel}`);
if (!smoke && selected.length !== PHASE1_ROOTS) {
  throw new Error(`Phase 1 requires ${PHASE1_ROOTS} roots, got ${selected.length}`);
}

mkdirSync(dirname(jsonlPath), { recursive: true });
// Never delete existing results (§4.3). Append, and say so when resuming.
const resumed = existsSync(jsonlPath);
if (resumed) {
  const existing = readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
  process.stdout.write(`RESUME: ${jsonlPath} already holds ${existing} records — appending, never truncating\n`);
}

const started = Date.now();
let calls = 0;
let passed = 0;
let failed = 0;
let anomalies = 0;
let drawsBaseline = 0;
let drawsPrepared = 0;
const failures: unknown[] = [];

process.stdout.write([
  'PPC-MCTS-01B PHASE 1 — FIXED COMPLETED-SIMULATION PARITY',
  `LABEL=${smoke ? 'SMOKE_NOT_EVIDENCE' : 'PHASE1_FORMAL'}`,
  `REPETITION=${rep}/${PHASE1_REPETITIONS}`,
  `FRESH_NODE_PROCESSES=${PHASE1_FRESH_NODE_PROCESSES}`,
  `TOTAL_SEARCH_CALLS=${PHASE1_TOTAL_SEARCH_CALLS}`,
  `COMPLETED_SIMULATIONS_PER_CALL=${K}`,
  `PHASE1_ARMS=${PHASE1_ARMS}`,
  `HEAVY_WORKER_CONCURRENCY=1`,
  `SERIAL_FRESH_REPETITIONS=TRUE`,
  `FIXTURE_SHA256=${fixtureSha256}`,
  '',
].join('\n'));

for (let i = 0; i < selected.length; i++) {
  const root = selected[i];
  const seed = uctSeed(root.id, 'UCT-H', rep);
  const arms: Phase1Arm[] = ['UCT-H-BASELINE', 'UCT-H-PREPARED'];

  const runs: Record<string, Phase1Run> = {};
  const anomaliesOf: Record<string, string | null> = {};
  for (const arm of arms) {
    const run = runPhase1Arm(arm, root.state, seed, { completedSimulations: K });
    runs[arm] = run;
    anomaliesOf[arm] = phase1ExecutionAnomaly(run, K);
  }

  const base = runs['UCT-H-BASELINE'];
  const prep = runs['UCT-H-PREPARED'];
  const anomaly = anomaliesOf['UCT-H-BASELINE'] ?? anomaliesOf['UCT-H-PREPARED'];
  const diff = diffPhase1(base, prep);

  let forensics: unknown = null;
  if (anomaly === null && (diff.fieldDiffs.length > 0 || diff.digestDiffs.length > 0)) {
    // Recover the full event body of the FIRST divergent simulation. The call is
    // deterministic (fixed seed, frozen clock, fixed K), so a targeted re-run
    // reproduces the same events.
    const idx = diff.firstDivergentSimulation;
    if (idx !== null) {
      const b2 = runPhase1Arm('UCT-H-BASELINE', root.state, seed, { completedSimulations: K, captureSimulation: idx, capturePlan: true });
      const p2 = runPhase1Arm('UCT-H-PREPARED', root.state, seed, { completedSimulations: K, captureSimulation: idx, capturePlan: true });
      forensics = {
        simulation: idx,
        baselineEvents: b2.trace.sims[idx]?.events ?? null,
        preparedEvents: p2.trace.sims[idx]?.events ?? null,
        baselinePlanEventsDigest: b2.result.planTraceDigest,
        preparedPlanEventsDigest: p2.result.planTraceDigest,
      };
    }
  }

  const record = {
    phase: 'PHASE1_FIXED_COMPLETED_SIMULATIONS',
    label: smoke ? 'SMOKE_NOT_EVIDENCE' : 'PHASE1_FORMAL',
    isPhase1Formal: !smoke,
    repetition: rep,
    root: root.id,
    rootStateKey: root.stateKey,
    seed,
    fixtureSha256,
    completedSimulationsPerCall: K,
    armOrder: arms,
    arms: {
      baseline: {
        simulations: base.result.diagnostics.simulations,
        abortedSimulations: base.result.diagnostics.abortedSimulations,
        nodesCreated: base.result.diagnostics.nodesCreated,
        chanceNodes: base.result.diagnostics.chanceNodes,
        chanceSamples: base.result.diagnostics.chanceSamples,
        rolloutSteps: base.result.diagnostics.rolloutSteps,
        maxHandoffsReached: base.result.diagnostics.maxHandoffsReached,
        nodeCapHit: base.result.diagnostics.nodeCapHit,
        deadlineHit: base.result.diagnostics.deadlineHit,
        completedSimulationLimitHit: base.result.diagnostics.completedSimulationLimitHit,
        mathRandomDraws: base.mathRandomDraws,
        ruleCalls: base.ruleCalls,
        wallMs: base.wallMs,
      },
      prepared: {
        simulations: prep.result.diagnostics.simulations,
        abortedSimulations: prep.result.diagnostics.abortedSimulations,
        nodesCreated: prep.result.diagnostics.nodesCreated,
        chanceNodes: prep.result.diagnostics.chanceNodes,
        chanceSamples: prep.result.diagnostics.chanceSamples,
        rolloutSteps: prep.result.diagnostics.rolloutSteps,
        maxHandoffsReached: prep.result.diagnostics.maxHandoffsReached,
        nodeCapHit: prep.result.diagnostics.nodeCapHit,
        deadlineHit: prep.result.diagnostics.deadlineHit,
        completedSimulationLimitHit: prep.result.diagnostics.completedSimulationLimitHit,
        mathRandomDraws: prep.mathRandomDraws,
        ruleCalls: prep.ruleCalls,
        wallMs: prep.wallMs,
      },
    },
    // Every axis §3.3 requires: per-simulation digests, whole tree, node
    // statistics, cumulative/average reward, final plan.
    simulationDigests: { baseline: base.digests, prepared: prep.digests },
    simulationDigestAggregate: {
      baseline: sha(baselineDigestKey(base)),
      prepared: sha(baselineDigestKey(prep)),
    },
    comparison: { baseline: phase1Comparable(base), prepared: phase1Comparable(prep) },
    verdict: anomaly !== null ? 'HARNESS_EXECUTION_ANOMALY' : (diff.fieldDiffs.length === 0 && diff.digestDiffs.length === 0 ? 'PASS' : 'FAIL'),
    anomaly,
    fieldDiffs: diff.fieldDiffs,
    digestDiffs: diff.digestDiffs.slice(0, 8),
    digestDiffCount: diff.digestDiffs.length,
    forensics,
  };

  appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, 'utf8');
  calls++;
  drawsBaseline += base.mathRandomDraws;
  drawsPrepared += prep.mathRandomDraws;
  if (record.verdict === 'PASS') passed++; else failed++;
  if (record.verdict === 'HARNESS_EXECUTION_ANOMALY') anomalies++;

  process.stdout.write(
    `${record.verdict.padEnd(26)} ${root.id.padEnd(6)} sims=${K} ` +
    `digests=${base.digests.length}/${prep.digests.length} ` +
    `nodes=${base.result.diagnostics.nodesCreated} ` +
    `wall=${base.wallMs.toFixed(0)}/${prep.wallMs.toFixed(0)}ms` +
    `${anomaly ? ` ANOMALY=${anomaly}` : ''}\n`,
  );
  if (record.verdict === 'FAIL') {
    for (const d of diff.fieldDiffs.slice(0, 10)) process.stdout.write(`      ${d}\n`);
    for (const d of diff.digestDiffs.slice(0, 3)) process.stdout.write(`      sim#${d.index} ${d.baseline.slice(0, 16)} != ${d.prepared.slice(0, 16)}\n`);
    failures.push(record);
    // §3.3: any unexpected difference STOPS the formal Phase 1 immediately.
    process.stdout.write('STOP: first non-parity cell recorded with full forensics; aborting the remaining roots\n');
    break;
  }
  if (record.verdict === 'HARNESS_EXECUTION_ANOMALY') {
    failures.push(record);
    process.stdout.write('STOP: harness execution anomaly — K was not reached by a complete simulation\n');
    break;
  }
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function baselineDigestKey(run: Phase1Run): string {
  return [...run.digests, run.result.planTraceDigest ?? 'null'].join('\n');
}

const summaryPath = resolve(process.cwd(), `${outDir}/rep-${repTag}.summary.json`);
const summary = {
  driver: 'phase1Parity',
  label: smoke ? 'SMOKE_NOT_EVIDENCE' : 'PHASE1_FORMAL',
  isPhase1Formal: !smoke,
  note: smoke
    ? 'SMOKE ONLY — proves the fixed-completed-simulation harness executes. Not the pre-registered 960-call Phase 1.'
    : 'One repetition of the pre-registered Phase 1 envelope (24 roots x 2 arms).',
  generatedAt: new Date().toISOString(),
  wallMs: Date.now() - started,
  node: process.version,
  pid: process.pid,
  repetition: rep,
  fixture: { path: 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', sha256: fixtureSha256 },
  contract: {
    PHASE1_ROOTS, PHASE1_REPETITIONS, PHASE1_ARMS,
    COMPLETED_SIMULATIONS_PER_CALL: K,
    PHASE1_TOTAL_SEARCH_CALLS, PHASE1_FRESH_NODE_PROCESSES,
    PHASE1_MAX_HANDOFFS, PHASE1_MAX_NODES,
    seedFormula: "uctSeed(rootId,'UCT-H',repetition) — identical for both arms",
    clock: 'now() = 0, deadlineMs = 1 → deadlineAt = 1 → never fires',
    rollout: 'hybrid (both arms)',
  },
  rootsRun: selected.length,
  calls,
  passed,
  failed,
  anomalies,
  mathRandomDraws: { baseline: drawsBaseline, prepared: drawsPrepared },
  jsonl: jsonlPath,
  failures,
  verdict: failed === 0 && calls === selected.length ? 'PASS' : 'FAIL',
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

process.stdout.write(
  `\n${summary.verdict}: ${passed}/${calls} calls (roots run ${selected.length}/${selected.length}) ` +
  `anomalies=${anomalies}\njsonl=${jsonlPath}\nsummary=${summaryPath}\n`,
);
if (summary.verdict !== 'PASS') process.exit(1);
