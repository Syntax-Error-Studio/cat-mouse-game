// Normalized digest of this round's deterministic artifacts.
// Wall-clock / node-count / RSS fields are stripped so fresh-process runs compare strictly.
// The G2 trace's live 100ms reps are collapsed to their semantic outcome (plan + depth),
// because 100ms deadline cuts are documented as nondeterministic (HARD-AI-DEADLINE memory);
// the raw reps stay in the artifact as evidence, only the digest normalizes them.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROUND = 'PPC-G6T2-DECISION-RISK-CAUSAL-01';
const FILES = [
  'TACTICAL_RISK_WITNESSES.json',
  'CROSS_ROOT_SHADOW_RESULTS.json',
  'G6T2_DECISION_CAUSAL_TRACE.json',
];
const VOLATILE = new Set([
  'generatedAt', 'elapsedMs', 'riskMs', 'enumerateMs', 'wallMs', 'nodes', 'truncated',
  'rssBeforeMB', 'rssAfterMB', 'twoTurnMs', 'oneTurnMs', 'staticReachMs', 'witnessMs', 'procMs', 'peakRssMB',
  'enumerationMs',
  'deadlineFired', 'attemptedDepth', 'completedDepth', 'printedAt', 'elapsedMsTotal',
  'date', 'timestamp',
]);

function collapseReps(obj) {
  const c = obj.contemporaneousRuntime;
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

const result = {};
for (const f of FILES) {
  const p = `${ROUND}/${f}`;
  if (!existsSync(p)) { result[f] = 'MISSING'; continue; }
  const obj = collapseReps(JSON.parse(readFileSync(p, 'utf8')));
  const canonical = JSON.stringify(strip(obj));
  result[f] = createHash('sha256').update(canonical).digest('hex');
}
result.__combined = createHash('sha256').update(JSON.stringify(result)).digest('hex');
console.log(JSON.stringify(result, null, 2));