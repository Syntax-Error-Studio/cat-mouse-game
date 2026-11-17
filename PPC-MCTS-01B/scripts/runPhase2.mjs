/**
 * PPC-MCTS-01B-HARNESS-REPAIR — Phase 2 serial orchestrator.
 *
 * ONE fresh Node process per repetition, started only after the previous one has
 * EXITED (HEAVY_WORKER_CONCURRENCY = 1, SERIAL_FRESH_REPETITIONS = TRUE).
 *
 * This script is delivered with the harness but MUST NOT be launched by the
 * harness-repair round: the formal 960-call envelope needs explicit approval.
 *
 * Usage:
 *   node PPC-MCTS-01B/scripts/runPhase2.mjs --confirm=PHASE2_FORMAL_APPROVED
 *   node PPC-MCTS-01B/scripts/runPhase2.mjs --dry-run
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const bundle = resolve(here, '../build/perfBudget100.mjs');
const outDir = resolve(repo, 'PPC-MCTS-01B/data/phase2-formal');
const outDirRel = 'PPC-MCTS-01B/data/phase2-formal';

const REPS = 20;
const dryRun = process.argv.includes('--dry-run');
const confirm = process.argv.find((a) => a.startsWith('--confirm='));

if (!existsSync(bundle)) {
  throw new Error(`bundle missing: ${bundle} — run node PPC-MCTS-01B/scripts/build-drivers.mjs first`);
}

const plan = [];
for (let rep = 1; rep <= REPS; rep++) {
  plan.push({
    rep,
    argv: [bundle, `--rep=${rep}`, `--outDir=${outDirRel}`],
  });
}

if (dryRun) {
  console.log(`HEAVY_WORKER_CONCURRENCY=1`);
  console.log(`SERIAL_FRESH_REPETITIONS=TRUE`);
  console.log(`FRESH_NODE_PROCESSES=${REPS}`);
  console.log(`TOTAL_SEARCH_CALLS=${24 * 2 * REPS}`);
  for (const p of plan) console.log(`would run: node ${bundle.replace(repo + '\\', '').replace(repo + '/', '')} ${p.argv.slice(1).join(' ')}`);
  process.exit(0);
}

if (!confirm || confirm !== '--confirm=PHASE2_FORMAL_APPROVED') {
  throw new Error(
    'refusing to start the formal Phase 2 envelope without ' +
    '--confirm=PHASE2_FORMAL_APPROVED (it is 960 timed calls in 20 fresh processes)',
  );
}

// ---------------------------------------------------------------------------
// pre-flight: never overwrite, never silently re-run
// ---------------------------------------------------------------------------
const preexisting = existsSync(outDir) ? readdirSync(outDir).filter((f) => !f.startsWith('orchestrator')).sort() : [];
if (preexisting.length > 0 && !process.argv.includes('--resume')) {
  throw new Error(
    `output directory already holds ${preexisting.length} file(s) at ${outDirRel}. ` +
    'Inspect it first; pass --resume to validate and continue without deleting anything.',
  );
}

mkdirSync(outDir, { recursive: true });
const log = [];

for (const p of plan) {
  const startedAt = Date.now();
  console.log(`\n=== PHASE 2 rep ${p.rep}/${REPS} — fresh process, pid will be logged by the driver ===`);
  // spawnSync returns only after the child has EXITED: one process at a time.
  const res = spawnSync(process.execPath, p.argv, { cwd: repo, stdio: 'inherit' });
  log.push({
    rep: p.rep,
    status: res.status,
    signal: res.signal ?? null,
    wallMs: Date.now() - startedAt,
  });
  writeFileSync(
    resolve(outDir, 'orchestrator.log.json'),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), label: 'PHASE2_FORMAL',
      totalJobs: REPS, heavyWorkerConcurrency: 1, serialFreshRepetitions: true,
      totalSearchCalls: 24 * 2 * REPS, reps: log }, null, 2)}\n`,
    'utf8',
  );
  if (res.status !== 0) {
    throw new Error(`rep ${p.rep} exited with ${String(res.status)} — stopping (existing results are kept)`);
  }
}

console.log('\nPHASE 2 envelope complete. 20 fresh processes, 960 calls.');
