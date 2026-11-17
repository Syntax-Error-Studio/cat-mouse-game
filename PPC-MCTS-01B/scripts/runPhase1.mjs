/**
 * PPC-MCTS-01B — Phase 1 serial orchestrator (FINAL GATE A).
 *
 * ONE fresh Node process per repetition, started only after the previous one has
 * EXITED (HEAVY_WORKER_CONCURRENCY = 1, SERIAL_FRESH_REPETITIONS = TRUE).
 * No Promise.all, no worker pool, no background shell, no concurrent spawn.
 *
 * Contract (frozen in PHASE1_PREREGISTRATION.json):
 *   TOTAL_JOBS = 20, TOTAL_ROOTS = 24, TOTAL_ARMS = 2
 *   COMPLETED_SIMULATIONS_PER_CALL = 200
 *   TOTAL_SEARCH_CALLS = 960
 *
 * Each child writes one JSONL record per (root) covering BOTH arms, so:
 *   24 records/process, 480 records total, 960 arm-calls total.
 *
 * The orchestrator never deletes or truncates anything: if the output directory
 * already holds data it refuses to start unless `--resume` is passed, and it
 * re-validates whatever is already there instead of re-running it.
 *
 * Usage:
 *   node PPC-MCTS-01B/scripts/runPhase1.mjs --dry-run
 *   node PPC-MCTS-01B/scripts/runPhase1.mjs --confirm=PHASE1_FORMAL_APPROVED
 *   node PPC-MCTS-01B/scripts/runPhase1.mjs --confirm=PHASE1_FORMAL_APPROVED --resume
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const bundle = resolve(here, '../build/phase1Parity.mjs');
const outDirRel = 'PPC-MCTS-01B/data/phase1-formal';
const outDir = resolve(repo, outDirRel);

const TOTAL_JOBS = 20;
const TOTAL_ROOTS = 24;
const TOTAL_ARMS = 2;
const K = 200;
const TOTAL_CALLS = TOTAL_ROOTS * TOTAL_ARMS * TOTAL_JOBS;
const EXPECTED_SIMULATIONS = TOTAL_CALLS * K;

const REPS = Array.from({ length: TOTAL_JOBS }, (_, i) => i + 1);
const dryRun = process.argv.includes('--dry-run');
const resume = process.argv.includes('--resume');
const confirm = process.argv.find((a) => a.startsWith('--confirm='));

if (!existsSync(bundle)) {
  throw new Error(`bundle missing: ${bundle} — run node PPC-MCTS-01B/scripts/build-drivers.mjs first`);
}

if (!dryRun && confirm !== '--confirm=PHASE1_FORMAL_APPROVED') {
  throw new Error(
    'refusing to start the formal Phase 1 envelope without --confirm=PHASE1_FORMAL_APPROVED ' +
    `(it is ${TOTAL_CALLS} calls x ${K} simulations in ${TOTAL_JOBS} fresh processes)`,
  );
}

// ---------------------------------------------------------------------------
// pre-flight: never overwrite, never silently re-run
// ---------------------------------------------------------------------------
const existing = existsSync(outDir) ? readdirSync(outDir).sort() : [];
if (existing.length > 0 && !resume && !dryRun) {
  const perRep = existing.filter((f) => /^rep-\d\d\.jsonl$/.test(f)).length;
  throw new Error(
    `output directory already holds ${existing.length} file(s) (${perRep} jsonl) at ${outDirRel}. ` +
    'Inspect it first; pass --resume to validate and continue without deleting anything.',
  );
}

if (dryRun) {
  console.log('PPC-MCTS-01B PHASE 1 — DRY RUN');
  console.log(`TOTAL_JOBS=${TOTAL_JOBS}`);
  console.log('HEAVY_WORKER_CONCURRENCY=1');
  console.log('SERIAL_FRESH_REPETITIONS=TRUE');
  console.log(`FRESH_NODE_PROCESSES=${TOTAL_JOBS}`);
  console.log(`TOTAL_ROOTS=${TOTAL_ROOTS} TOTAL_ARMS=${TOTAL_ARMS} K=${K}`);
  console.log(`TOTAL_SEARCH_CALLS=${TOTAL_CALLS}`);
  console.log(`EXPECTED_TOTAL_SIMULATIONS=${EXPECTED_SIMULATIONS}`);
  console.log(`OUT_DIR=${outDirRel}`);
  for (const rep of REPS) console.log(`would run: node build/phase1Parity.mjs --rep=${rep} --outDir=${outDirRel}`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const tag = (rep) => String(rep).padStart(2, '0');

/**
 * Validate one repetition's raw output against the frozen contract.
 * Returns a machine-readable object; throws on a structural violation because a
 * malformed repetition must stop the envelope, not be summarised away.
 */
function validateRep(rep) {
  const jsonl = resolve(outDir, `rep-${tag(rep)}.jsonl`);
  const summary = resolve(outDir, `rep-${tag(rep)}.summary.json`);
  const problems = [];

  if (!existsSync(jsonl)) problems.push('missing rep jsonl');
  if (!existsSync(summary)) problems.push('missing rep summary');
  if (problems.length > 0) {
    return { rep, ok: false, problems, records: 0, armCalls: 0, simulations: 0 };
  }

  const lines = readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { problems.push('unparsable jsonl line'); }
  }

  const roots = new Set();
  let armCalls = 0;
  let simulations = 0;
  for (const r of records) {
    roots.add(r.root);
    if (r.verdict !== 'PASS') problems.push(`${r.root}: verdict=${r.verdict}`);
    if (r.anomaly !== null) problems.push(`${r.root}: anomaly=${String(r.anomaly)}`);
    if (r.digestDiffCount !== 0) problems.push(`${r.root}: digestDiffCount=${r.digestDiffCount}`);
    if (!r.isPhase1Formal) problems.push(`${r.root}: isPhase1Formal=false`);
    if (r.completedSimulationsPerCall !== K) problems.push(`${r.root}: K=${r.completedSimulationsPerCall}`);
    for (const side of ['baseline', 'prepared']) {
      const a = r.arms?.[side];
      if (!a) { problems.push(`${r.root}: arms.${side} missing`); continue; }
      armCalls++;
      simulations += a.simulations;
      if (a.simulations !== K) problems.push(`${r.root}/${side}: simulations=${a.simulations}`);
      if (a.abortedSimulations !== 0) problems.push(`${r.root}/${side}: aborted=${a.abortedSimulations}`);
      if (a.nodeCapHit) problems.push(`${r.root}/${side}: NODE_CAP_HIT`);
      if (a.deadlineHit) problems.push(`${r.root}/${side}: DEADLINE_HIT`);
      if (!a.completedSimulationLimitHit) problems.push(`${r.root}/${side}: STOP_SEAM_NOT_REACHED`);
      if (a.mathRandomDraws !== 0) problems.push(`${r.root}/${side}: mathRandomDraws=${a.mathRandomDraws}`);
      // per-simulation digests must exist, in K, one per simulation
      const dg = r.simulationDigests?.[side];
      if (!Array.isArray(dg) || dg.length !== K) problems.push(`${r.root}/${side}: digests=${Array.isArray(dg) ? dg.length : 'none'}`);
    }
    const bd = r.simulationDigests?.baseline ?? [];
    const pd = r.simulationDigests?.prepared ?? [];
    if (bd.length !== pd.length || bd.some((d, i) => d !== pd[i])) {
      problems.push(`${r.root}: per-simulation digests differ`);
    }
  }

  if (roots.size !== TOTAL_ROOTS) problems.push(`roots=${roots.size}`);
  if (armCalls !== TOTAL_ROOTS * TOTAL_ARMS) problems.push(`armCalls=${armCalls}`);

  return {
    rep,
    ok: problems.length === 0,
    problems,
    records: records.length,
    roots: roots.size,
    armCalls,
    simulations,
    sha256: {
      jsonl: sha256(jsonl),
      summary: sha256(summary),
      bytes: { jsonl: readFileSync(jsonl).length, summary: readFileSync(summary).length },
    },
  };
}

// A rep whose files exist is validated instead of re-run (never re-executed,
// never deleted) — even without --resume, because validation is read-only.
const preexisting = new Set(
  REPS.filter((rep) => existsSync(resolve(outDir, `rep-${tag(rep)}.jsonl`))),
);

console.log([
  'PPC-MCTS-01B PHASE 1 — FIXED COMPLETED SIMULATIONS',
  `LABEL=PHASE1_FORMAL`,
  `TOTAL_JOBS=${TOTAL_JOBS}`,
  'HEAVY_WORKER_CONCURRENCY=1',
  'SERIAL_FRESH_REPETITIONS=TRUE',
  `FRESH_NODE_PROCESSES=${TOTAL_JOBS}`,
  `CALLS_PER_PROCESS=${TOTAL_ROOTS * TOTAL_ARMS} (${TOTAL_ROOTS} roots x ${TOTAL_ARMS} arms)`,
  `COMPLETED_SIMULATIONS_PER_CALL=${K}`,
  `TOTAL_SEARCH_CALLS=${TOTAL_CALLS}`,
  `EXPECTED_TOTAL_SIMULATIONS=${EXPECTED_SIMULATIONS}`,
  `OUT_DIR=${outDirRel}`,
  `PREEXISTING_REPS=${preexisting.size === 0 ? 'none' : [...preexisting].join(',')}`,
  '',
].join('\n'));

const jobs = [];
const startedAll = Date.now();

for (const rep of REPS) {
  console.log(`CURRENT_JOB=${rep}/${TOTAL_JOBS}`);

  if (preexisting.has(rep)) {
    const v = validateRep(rep);
    jobs.push({ rep, executed: false, status: 0, wallMs: 0, validation: v });
    console.log(`  SKIPPED (already present, validated) ok=${v.ok} records=${v.records} armCalls=${v.armCalls}`);
    writeFileSync(resolve(outDir, 'orchestrator.log.json'),
      `${JSON.stringify({ updatedAt: new Date().toISOString(), label: 'PHASE1_FORMAL',
        totalJobs: TOTAL_JOBS, heavyWorkerConcurrency: 1, serialFreshRepetitions: true,
        completedSimulationsPerCall: K, totalSearchCalls: TOTAL_CALLS, reps: jobs }, null, 2)}\n`, 'utf8');
    if (!v.ok) throw new Error(`rep ${rep} pre-existing data is invalid: ${v.problems.slice(0, 5).join('; ')}`);
    continue;
  }

  const t0 = Date.now();
  // spawnSync returns only after the child has EXITED: one heavy process at a time.
  const res = spawnSync(process.execPath, [bundle, `--rep=${rep}`, `--outDir=${outDirRel}`], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env },
  });
  const wallMs = Date.now() - t0;

  const entry = { rep, executed: true, status: res.status, signal: res.signal ?? null, wallMs, validation: null };
  jobs.push(entry);

  if (res.status !== 0) {
    writeFileSync(resolve(outDir, 'orchestrator.log.json'),
      `${JSON.stringify({ updatedAt: new Date().toISOString(), label: 'PHASE1_FORMAL',
        totalJobs: TOTAL_JOBS, heavyWorkerConcurrency: 1, serialFreshRepetitions: true,
        completedSimulationsPerCall: K, totalSearchCalls: TOTAL_CALLS, reps: jobs }, null, 2)}\n`, 'utf8');
    throw new Error(`rep ${rep} exited with ${String(res.status)} — stopping (existing results are kept)`);
  }

  const v = validateRep(rep);
  entry.validation = v;
  writeFileSync(resolve(outDir, 'orchestrator.log.json'),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), label: 'PHASE1_FORMAL',
      totalJobs: TOTAL_JOBS, heavyWorkerConcurrency: 1, serialFreshRepetitions: true,
      completedSimulationsPerCall: K, totalSearchCalls: TOTAL_CALLS, reps: jobs }, null, 2)}\n`, 'utf8');

  console.log(`  JOB ${rep}/${TOTAL_JOBS} EXITED CLEANLY wallMs=${wallMs} records=${v.records} armCalls=${v.armCalls} ok=${v.ok}`);
  if (!v.ok) {
    throw new Error(`rep ${rep} failed validation: ${v.problems.slice(0, 8).join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// envelope verdict
// ---------------------------------------------------------------------------
const executed = jobs.filter((j) => j.executed).length;
const totalRecords = jobs.reduce((s, j) => s + (j.validation?.records ?? 0), 0);
const totalArmCalls = jobs.reduce((s, j) => s + (j.validation?.armCalls ?? 0), 0);
const totalSimulations = jobs.reduce((s, j) => s + (j.validation?.simulations ?? 0), 0);
const allOk = jobs.every((j) => j.validation?.ok === true);

const envelope = {
  label: 'PHASE1_FORMAL',
  generatedAt: new Date().toISOString(),
  wallMs: Date.now() - startedAll,
  contract: {
    TOTAL_JOBS, TOTAL_ROOTS, TOTAL_ARMS,
    COMPLETED_SIMULATIONS_PER_CALL: K,
    CALLS_PER_PROCESS: TOTAL_ROOTS * TOTAL_ARMS,
    TOTAL_SEARCH_CALLS: TOTAL_CALLS,
    EXPECTED_TOTAL_SIMULATIONS: EXPECTED_SIMULATIONS,
    HEAVY_WORKER_CONCURRENCY: 1,
    SERIAL_FRESH_REPETITIONS: true,
  },
  freshNodeProcessesExecuted: executed,
  jobRecords: jobs.map((j) => ({
    rep: j.rep, executed: j.executed, status: j.status, wallMs: j.wallMs,
    records: j.validation?.records ?? 0,
    armCalls: j.validation?.armCalls ?? 0,
    simulations: j.validation?.simulations ?? 0,
    ok: j.validation?.ok ?? false,
    problems: j.validation?.problems ?? [],
    sha256: j.validation?.sha256 ?? null,
  })),
  totals: { records: totalRecords, armCalls: totalArmCalls, simulations: totalSimulations },
  allRepetitionsValid: allOk,
  verdict: allOk && executed === TOTAL_JOBS && totalArmCalls === TOTAL_CALLS && totalSimulations === EXPECTED_SIMULATIONS
    ? 'PASS' : 'FAIL',
};
writeFileSync(resolve(outDir, 'ENVELOPE.json'), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

console.log('');
console.log(`fresh processes executed = ${executed}/${TOTAL_JOBS} (skipped-and-validated = ${TOTAL_JOBS - executed})`);
console.log(`records = ${totalRecords}  arm-calls = ${totalArmCalls}/${TOTAL_CALLS}  simulations = ${totalSimulations}/${EXPECTED_SIMULATIONS}`);
console.log(`PHASE1_ENVELOPE=${envelope.verdict}`);
console.log(`envelope=${outDirRel}/ENVELOPE.json`);
if (envelope.verdict !== 'PASS') process.exit(1);
