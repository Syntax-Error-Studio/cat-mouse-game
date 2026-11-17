#!/usr/bin/env node
/**
 * PPC-P2-PREPARED-TRANSITION-01 — serial fresh-process benchmark driver.
 *
 *   node PPC-P2-PREPARED-TRANSITION-01/probe/runBench.mjs aa 20
 *   node PPC-P2-PREPARED-TRANSITION-01/probe/runBench.mjs ab 20
 *
 * Hard rules enforced here (round brief §7.1):
 *   - ONE heavy worker at a time: every measurement is a fresh `vitest` process
 *     launched with spawnSync, so the next one cannot start before the previous
 *     process has fully exited.
 *   - No `Promise.all` / worker pool / `xargs -P` / concurrent benchmark.
 *   - A lock file blocks a second driver instance (duplicate-benchmark check).
 *   - Any non-zero exit aborts the whole run and keeps what was already written.
 *
 * AA runs BOTH arms on the frozen baseline source (host noise calibration).
 * AB runs A = frozen baseline, B = candidate.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';

const mode = (process.argv[2] ?? '').toLowerCase();
const reps = Number(process.argv[3] ?? '20');
const sweeps = process.env.SWEEPS ?? '5';
if (!['aa', 'ab'].includes(mode)) {
  console.error('usage: runBench.mjs <aa|ab> [reps]');
  process.exit(2);
}

const OUT_DIR = 'PPC-P2-PREPARED-TRANSITION-01/_raw/bench';
const LOCK = 'PPC-P2-PREPARED-TRANSITION-01/_raw/.bench.lock';
const LOG = `PPC-P2-PREPARED-TRANSITION-01/logs/bench_${mode}.log`;
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync('PPC-P2-PREPARED-TRANSITION-01/logs', { recursive: true });

const logLines = [];
const say = (s) => { logLines.push(s); console.log(s); };

if (existsSync(LOCK)) {
  const holder = Number(readFileSync(LOCK, 'utf8').trim());
  let alive = false;
  if (Number.isFinite(holder) && holder > 0) {
    try {
      process.kill(holder, 0); // signal 0 = liveness probe only
      alive = true;
    } catch {
      alive = false;
    }
  }
  if (alive) {
    console.error(`ABORT: another benchmark driver holds the lock (pid ${holder}, still alive).`);
    process.exit(3);
  }
  say(`# stale lock from pid ${holder} (not running) — clearing`);
  unlinkSync(LOCK);
}
writeFileSync(LOCK, String(process.pid));

const ARMS = mode === 'aa'
  ? [['A', 'baseline'], ['B', 'baseline']]
  : [['A', 'baseline'], ['B', 'candidate']];

const t0 = Date.now();
try {
  say(`# driver start ${new Date().toISOString()} mode=${mode} reps=${reps} sweeps=${sweeps}`);
  say(`# existing bench outputs: ${readdirSync(OUT_DIR).length}`);

  for (let rep = 1; rep <= reps; rep++) {
    for (const [role, arm] of ARMS) {
      const tag = `${mode}_${role.toLowerCase()}_${String(rep).padStart(2, '0')}_${arm}`;
      const started = Date.now();
      const res = spawnSync(
        'npx',
        ['vitest', 'run', '--config', 'PPC-P2-PREPARED-TRANSITION-01/probe/vitest.bench.config.mts'],
        {
          env: { ...process.env, RUN: mode, ARM: arm, ROLE: role, REP: String(rep), SWEEPS: sweeps },
          encoding: 'utf8',
          shell: true,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      const wall = Date.now() - started;
      const line = (res.stdout ?? '').split('\n').find((l) => l.includes('medianSweep=')) ?? '';
      if (res.status !== 0) {
        say(`rep=${rep} role=${role} arm=${arm} EXIT=${res.status} wallMs=${wall}`);
        say((res.stdout ?? '').slice(-4000));
        say((res.stderr ?? '').slice(-4000));
        throw new Error(`arm run failed at rep ${rep} (${role}/${arm})`);
      }
      say(`rep=${rep} role=${role} arm=${arm} wallMs=${wall} | ${line.trim()}`);
    }
  }
  say(`# driver done ${new Date().toISOString()} totalSec=${((Date.now() - t0) / 1000).toFixed(1)}`);
} catch (e) {
  say(`# driver ABORTED: ${e.message}`);
  writeFileSync(LOG, `${logLines.join('\n')}\n`);
  unlinkSync(LOCK);
  process.exit(1);
}

writeFileSync(LOG, `${logLines.join('\n')}\n`);
unlinkSync(LOCK);
