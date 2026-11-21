#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const ROUND = 'PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01';
const reps = [1, 2, 3].map((n) => JSON.parse(readFileSync(`${ROUND}/logs/digest_r${n}.json`, 'utf8')));
const combined = reps.map((r) => r.combined);
const files = Object.keys(reps[0].files);
const perFile = files.map((f) => ({
  file: f,
  distinct: new Set(reps.map((r) => r.files[f])).size,
  hashes: reps.map((r) => r.files[f]),
}));
const failing = perFile.filter((x) => x.distinct !== 1);
const verdict = combined.every((c) => c === combined[0]) && failing.length === 0 ? 'DETERMINISTIC' : 'DRIFT';
writeFileSync(`${ROUND}/logs/determinism_summary.json`, JSON.stringify({
  round: ROUND,
  repetitions: 3,
  serialFreshProcesses: true,
  combined,
  verdict,
  perFile,
  driftFiles: failing.map((f) => f.file),
  scope: 'semantic projection only; every time/RSS/host field is recorded in the per-round performance block and NEVER hashed',
}, null, 2));
console.log(`${verdict} ${combined[0]} (${failing.length} drifting files)`);