#!/usr/bin/env node
/**
 * Pre-launch admission gate for PPC-ORACLE-HOTPATH-ATTRIBUTION-01.
 *
 * Runs FIVE consecutive physical-memory probes BEFORE any heavy worker exists,
 * then exits non-zero unless every probe is >= floorMB and no duplicate heavy
 * worker (a vitest process outside this process tree) is running.
 *
 * Usage: node scripts/admission.mjs [floorMB]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUND = 'PPC-ORACLE-HOTPATH-ATTRIBUTION-01';
const ROUND_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const floorMB = Number(process.argv[2] ?? 2560);
mkdirSync(join(ROUND_DIR, 'logs'), { recursive: true });

const probe = () => {
  const raw = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', join(ROUND_DIR, 'scripts', 'host_probe.ps1'), '-SelfPid', String(process.pid),
  ], { encoding: 'utf8', timeout: 60_000 }).trim().split(/\r?\n/).map((x) => Number(x.trim()));
  return {
    totalMB: raw[0], freeMB: raw[1], vitestProcesses: raw[2],
    vitestOutOfTree: raw[3], foreignNodeProcesses: raw[4],
    duplicates: Math.max(0, raw[3] ?? 0),
  };
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const records = [];
for (let i = 1; i <= 5; i++) {
  records.push({ probe: i, ...probe(), at: new Date().toISOString() });
  sleep(1000);
}

const admitted = records.every((r) => r.freeMB >= floorMB && r.duplicates === 0);
const file = join(ROUND_DIR, 'logs', `admission_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ floorMB, records, admitted }, null, 2));
console.log(records.map((r) => `${r.freeMB}`).join(' / '), ` floor=${floorMB}`, admitted ? 'ADMITTED' : 'REFUSED');
console.log(`record: ${file}`);
process.exit(admitted ? 0 : 1);