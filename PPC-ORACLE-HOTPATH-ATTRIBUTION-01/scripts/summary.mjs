// Aggregate the three G4 repetitions and assemble the deliverable JSON files.
// Usage: node PPC-ORACLE-HOTPATH-ATTRIBUTION-01/scripts/summary.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROUND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROUND, 'logs');

const read = (f) => JSON.parse(fs.readFileSync(path.join(LOG, f), 'utf8'));
const write = (f, o) => fs.writeFileSync(path.join(ROUND, f), JSON.stringify(o, null, 2) + '\n');

const reps = [1, 2, 3];
const perf = reps.map((r) => read(`perf_r${r}.json`));
const parity = reps.map((r) => read(`g4_parity_r${r}.json`));
const upper = read('../CACHE_HIT_UPPER_BOUND.json');

const plans = Object.keys(perf[0].rows);

// --- paired performance: per rep ratio, then cross-rep geometry
const perPlan = {};
for (const p of plans) {
  const ratios = perf.map((j) => j.rows[p].ratioBoverA);
  const sorted = [...ratios].sort((a, b) => a - b);
  const a = perf.map((j) => j.rows[p].timesMs.A);
  const b = perf.map((j) => j.rows[p].timesMs.B);
  perPlan[p] = {
    ratiosPerRep: ratios,
    medianRatio: sorted[1],
    minRatio: sorted[0],
    maxRatio: sorted[2],
    improvementsPct: ratios.map((x) => Math.round((1 - x) * 10000) / 100),
    baselineMsPerRep: a,
    prototypeMsPerRep: b,
    nodes: perf[0].rows[p].nodes,
    pids: perf.map((j) => j.pid),
  };
}

// --- parity across reps
const parityOut = { note: 'Three independent fresh processes; every counter listed is asserted equal to the uncached baseline in the same process.', cacheCap: 20000, reps: {} };
for (const [i, r] of reps.entries()) {
  parityOut.reps[`r${r}`] = { pid: perf[i].pid, targets: parity[i].targets };
}
const certOk = parity.every((j) => Object.values(j.targets).every((t) => t.certificate === null || t.certificate.verdict === 'PROVEN'));
const countersOk = parity.every((j) => Object.values(j.targets).every((t) => t.identicalCounters === true));
const digestsAgree = plans.every((p) => new Set(parity.map((j) => j.targets[p].policyDigest)).size === 1);
parityOut.allCertificatesProven = certOk;
parityOut.allCountersIdentical = countersOk;
parityOut.policyDigestsAgreeAcrossReps = digestsAgree;

write('BASELINE_VS_PROTOTYPE_PARITY.json', parityOut);

const meanImprovement = plans.map((p) => perPlan[p].improvementsPct.reduce((x, y) => x + y, 0) / 3);
write('PAIRED_PERFORMANCE_RESULTS.json', {
  design: 'ABBA (A,B,B,A) inside one fresh process per repetition; ratio = (B1+B2)/(A1+A2) cancels linear drift; A = uncached instrumented kernel, B = same kernel + solve-local action cache (cap 20,000, guard-memory states bypass).',
  repetitions: 3,
  serialFreshProcesses: true,
  roots: plans,
  perPlan,
  summary: {
    improvementPctPerPlanMean: Object.fromEntries(plans.map((p, i) => [p, Math.round(meanImprovement[i] * 10) / 10])),
    bestPlan: plans[meanImprovement.indexOf(Math.max(...meanImprovement))],
    worstPlan: plans[meanImprovement.indexOf(Math.min(...meanImprovement))],
    interpretation: 'The cache never reduced wall time: all 12 plan x rep ratios are >= 1.0 (median about 1.25). Map bookkeeping itself costs ~3 ms total (cache_wiring_microbench), so the slowdown comes from retention: holding 20,000 Transition[] lists keeps the whole successor state graph alive (heap 149 -> 1234 MB on DUUD), which is a property of caching action lists, not of this implementation detail.',
  },
  hitUpperBound: upper,
});

// --- manifest + ledger
const files = [];
const walk = (d, rel = '') => {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === 'node_modules') continue;
    if (e.isDirectory()) walk(path.join(d, e.name), r);
    else files.push(r);
  }
};
for (const d of ['probe', 'scripts', 'logs']) walk(path.join(ROUND, d), d);
for (const f of fs.readdirSync(ROUND)) {
  if (fs.statSync(path.join(ROUND, f)).isFile()) files.push(f);
}
const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
const exempt = new Set(['SOURCE_MANIFEST.json', 'SHA256SUMS.txt']);
const manifest = {
  round: 'PPC-ORACLE-HOTPATH-ATTRIBUTION-01',
  note: 'All paths are research copies under this directory. Production sources, GAMEPLAY.md, SEAL, H0/H1, E1, PCV, stateKey and the 100/150 ms limits were never modified.',
  protectedReadOnly: [
    'GAMEPLAY.md',
    'src/game/engine.ts',
    'src/game/ai/transposition.ts',
    'src/game/ai/preparedActions.ts',
    'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts',
  ],
  files: files.filter((f) => !exempt.has(f)).map((f) => ({ path: f, bytes: fs.statSync(path.join(ROUND, f)).size, sha256: sha(path.join(ROUND, f)) })),
};
write('SOURCE_MANIFEST.json', manifest);
fs.writeFileSync(path.join(ROUND, 'SHA256SUMS.txt'), manifest.files.map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n');

console.log(`wrote PAIRED_PERFORMANCE_RESULTS.json, BASELINE_VS_PROTOTYPE_PARITY.json, SOURCE_MANIFEST.json (${manifest.files.length} files), SHA256SUMS.txt`);
for (const p of plans) console.log(p, 'ratios', perPlan[p].ratiosPerRep.join(','), 'median', perPlan[p].medianRatio);