// Diagnostic: find the first canonical (volatile-stripped) difference between two artifact snapshots.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROUND = 'PPC-G6T2-DECISION-RISK-CAUSAL-01';
const VOLATILE = new Set([
  'generatedAt', 'elapsedMs', 'riskMs', 'enumerateMs', 'wallMs', 'nodes', 'truncated',
  'rssBeforeMB', 'rssAfterMB', 'twoTurnMs', 'oneTurnMs', 'staticReachMs', 'witnessMs', 'procMs', 'peakRssMB',
  'enumerationMs',
  'deadlineFired', 'attemptedDepth', 'completedDepth', 'printedAt', 'elapsedMsTotal',
  'date', 'timestamp',
]);

function collapseReps(obj) {
  const c = obj?.contemporaneousRuntime;
  if (c && Array.isArray(c.reps)) {
    c.reps = {
      count: c.reps.length,
      planStrings: [...new Set(c.reps.map((r) => r.planString))].sort(),
      completedDepths: [...new Set(c.reps.map((r) => r.completedDepth))].sort(),
      hasSolution: [...new Set(c.reps.map((r) => r.hasSolution))].sort(),
    };
  }
  return obj;
}
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (VOLATILE.has(k)) continue;
      out[k] = strip(v[k]);
    }
    return out;
  }
  return v;
}
function diff(a, b, path = '', out = []) {
  if (out.length >= 25) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) { out.push({ path, a, b }); return out; }
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) diff(a[k], b[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, a, b });
  return out;
}

const [file, ra, rb] = process.argv.slice(2);
const load = (r) => collapseReps(JSON.parse(readFileSync(`${ROUND}/logs/snap_r${r}/${file}`, 'utf8')));
const A = strip(load(ra));
const B = strip(load(rb));
const h = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const d = diff(A, B, '', []);
console.log(JSON.stringify({ file, digestA: h(A), digestB: h(B), differences: d }, null, 2));