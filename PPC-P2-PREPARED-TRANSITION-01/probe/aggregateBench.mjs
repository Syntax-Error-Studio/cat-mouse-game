#!/usr/bin/env node
/**
 * PPC-P2-PREPARED-TRANSITION-01 — benchmark aggregator.
 *
 *   node PPC-P2-PREPARED-TRANSITION-01/probe/aggregateBench.mjs aa
 *   node PPC-P2-PREPARED-TRANSITION-01/probe/aggregateBench.mjs ab
 *
 * Reads every `<mode>_<role>_<rep>_<arm>.json` produced by `runBench.mjs`,
 * pairs A/B by repetition, and reports
 *
 *   - the per-repetition ratio B/A of the primary statistic (median in-process
 *     sweep time of the 24-root frozen D1 protocol),
 *   - the geometric mean of the paired ratios and its 95% CI (Student t),
 *   - for A/B, the same per ROOT so a single regressing map cannot hide inside
 *     a global average.
 *
 * The primary statistic is pre-registered: median of the 5 in-process sweeps,
 * ratio computed per repetition, geometric mean across the 20 repetitions.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const mode = (process.argv[2] ?? '').toLowerCase();
if (!['aa', 'ab'].includes(mode)) {
  console.error('usage: aggregateBench.mjs <aa|ab>');
  process.exit(2);
}

const DIR = 'PPC-P2-PREPARED-TRANSITION-01/_raw/bench';
const OUT = `PPC-P2-PREPARED-TRANSITION-01/_raw/${mode.toUpperCase()}_AGGREGATE_${mode}.json`;

/** Two-sided 95% Student-t critical values, df 1..30. */
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

const files = readdirSync(DIR).filter((f) => f.startsWith(`${mode}_`) && f.endsWith('.json'));
const byRep = new Map();
for (const f of files) {
  const d = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
  const key = d.rep;
  if (!byRep.has(key)) byRep.set(key, {});
  byRep.get(key)[d.role] = { file: f, ...d };
}

const rows = [];
const missing = [];
for (const rep of [...byRep.keys()].sort((a, b) => a - b)) {
  const pair = byRep.get(rep);
  if (!pair.A || !pair.B) { missing.push(rep); continue; }
  rows.push({
    rep,
    a: pair.A.medianSweepMs,
    b: pair.B.medianSweepMs,
    aArm: pair.A.arm,
    bArm: pair.B.arm,
    aMin: pair.A.minSweepMs,
    bMin: pair.B.minSweepMs,
    aFile: pair.A.file,
    bFile: pair.B.file,
  });
}

const ratios = rows.map((r) => r.b / r.a);
const logs = ratios.map(Math.log);
const n = logs.length;
const mean = logs.reduce((a, b) => a + b, 0) / n;
const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
const se = sd / Math.sqrt(n);
const t = T95[Math.min(T95.length, n) - 1];
const lo = Math.exp(mean - t * se);
const hi = Math.exp(mean + t * se);
const geo = Math.exp(mean);

const sortedR = [...ratios].sort((a, b) => a - b);
const medianRatio = sortedR[Math.floor(sortedR.length / 2)];

// Per-root view (all repetitions): median in-process ms per root for each arm.
const rootIds = rows[0] ? Object.keys(Object.fromEntries(JSON.parse(readFileSync(`${DIR}/${rows[0].aFile}`, 'utf8')).roots.map((r) => [r.id, 1]))) : [];
const perRoot = rootIds.map((id) => {
  const aMs = [];
  const bMs = [];
  for (const row of rows) {
    const A = JSON.parse(readFileSync(`${DIR}/${row.aFile}`, 'utf8')).roots.find((r) => r.id === id);
    const B = JSON.parse(readFileSync(`${DIR}/${row.bFile}`, 'utf8')).roots.find((r) => r.id === id);
    const med = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    aMs.push(med(A.msBySweep));
    bMs.push(med(B.msBySweep));
  }
  const perRepRatio = aMs.map((a, i) => bMs[i] / a);
  const l = perRepRatio.map(Math.log);
  const m = l.reduce((x, y) => x + y, 0) / l.length;
  const s = Math.sqrt(l.reduce((x, y) => x + (y - m) ** 2, 0) / (l.length - 1));
  const tt = T95[Math.min(T95.length, l.length) - 1];
  return {
    id,
    medianAMs: [...aMs].sort((x, y) => x - y)[Math.floor(aMs.length / 2)],
    medianBMs: [...bMs].sort((x, y) => x - y)[Math.floor(bMs.length / 2)],
    geoRatio: Math.exp(m),
    ci95: [Math.exp(m - tt * s / Math.sqrt(l.length)), Math.exp(m + tt * s / Math.sqrt(l.length))],
  };
}).sort((a, b) => b.geoRatio - a.geoRatio);

const result = {
  round: 'PPC-P2-PREPARED-TRANSITION-01',
  mode,
  arms: mode === 'aa' ? { A: 'baseline', B: 'baseline' } : { A: 'baseline', B: 'candidate' },
  primaryStatistic: 'median of 5 in-process sweeps of the frozen D1 protocol (24 roots, maxNodes=10000)',
  pairs: n,
  missingReps: missing,
  rows,
  summary: {
    geometricMeanRatio: geo,
    medianRatio,
    meanLog: mean,
    sdLog: sd,
    tCritical: t,
    ci95: [lo, hi],
    worstRatio: Math.max(...ratios),
    bestRatio: Math.min(...ratios),
    speedupPct: (1 - geo) * 100,
  },
  perRoot,
};

writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`[${mode}] pairs=${n} geo=${geo.toFixed(5)} ci95=[${lo.toFixed(5)}, ${hi.toFixed(5)}] median=${medianRatio.toFixed(5)} speedup=${((1 - geo) * 100).toFixed(2)}%`);
console.log(`     worst=${Math.max(...ratios).toFixed(4)} best=${Math.min(...ratios).toFixed(4)}`);
const reg = perRoot.filter((r) => r.geoRatio > 1.0);
console.log(`     per-root slower than A: ${reg.length}/${perRoot.length} ${JSON.stringify(reg.slice(0, 6).map((r) => `${r.id}:${r.geoRatio.toFixed(3)}`))}`);
