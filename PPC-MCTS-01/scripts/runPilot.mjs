/**
 * PPC-MCTS-01 — serial fresh-process pilot driver.
 *
 * 20 independent `node` processes, one repetition each. Process N produces its
 * JSONL + raw log and must EXIT before process N+1 starts. No Promise.all, no
 * worker pool, no background concurrency (HEAVY_WORKER_CONCURRENCY = 1).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const roundDir = path.join(here, '..');
const repoRoot = path.resolve(roundDir, '..');
const bench = path.join(roundDir, 'out', 'bench.mjs');
const logsDir = path.join(roundDir, 'logs');
const rawDir = path.join(roundDir, 'out', 'raw');
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(rawDir, { recursive: true });

const TOTAL = 20;
console.log('PPC-MCTS-01 PILOT DRIVER');
console.log(`TOTAL_JOBS=${TOTAL}`);
console.log('HEAVY_WORKER_CONCURRENCY=1');
console.log(`NODE=${process.version} PLATFORM=${process.platform}`);
console.log(`RAM_FREE_MB=${Math.round(os.freemem() / 1048576)} RAM_TOTAL_MB=${Math.round(os.totalmem() / 1048576)}`);
console.log(`BENCH=${bench}`);

for (let rep = 1; rep <= TOTAL; rep++) {
  console.log(`CURRENT_JOB=${rep}/${TOTAL}`);
  const out = path.join(rawDir, `rep-${String(rep).padStart(2, '0')}.jsonl`);
  const log = path.join(logsDir, `rep-${String(rep).padStart(2, '0')}.log`);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [bench, '--rep', String(rep), '--out', out, '--root', repoRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  const elapsed = Date.now() - t0;
  const text = `PPC-MCTS-01 REP=${rep} EXIT=${res.status} WALL_MS=${elapsed}\n${res.stdout ?? ''}${res.stderr ? `\nSTDERR:\n${res.stderr}` : ''}`;
  fs.writeFileSync(log, text);
  process.stdout.write(res.stdout ?? '');
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    console.error(`JOB ${rep} FAILED exit=${res.status}; stopping (serial driver).`);
    process.exit(res.status ?? 1);
  }
  console.log(`JOB ${rep}/${TOTAL} EXITED CLEANLY wallMs=${elapsed}`);
}
console.log('PILOT_ALL_JOBS_DONE=TRUE');
