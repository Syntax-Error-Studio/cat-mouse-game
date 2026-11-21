#!/usr/bin/env node
/**
 * Split each artifact into a SEMANTIC projection (hashed, must be identical
 * across fresh processes) and a PERFORMANCE projection (reported separately).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROUND = 'PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01';
const FILES = [
  `${ROUND}/DUUD_INDEPENDENT_PROOF.json`,
  `${ROUND}/INDEPENDENT_VERIFIER_RESULT.json`,
  `${ROUND}/QUANTIFIER_COUNTEREXAMPLES.json`,
  `${ROUND}/WITNESS_COST_ABLATION.json`,
  `${ROUND}/logs/g0_identity.json`,
  `${ROUND}/logs/g0_count_separation.json`,
  `${ROUND}/logs/g0_plan_set.json`,
  `${ROUND}/logs/g1_lineage.json`,
  `${ROUND}/logs/g1_g1t9_artifact.json`,
  `${ROUND}/logs/g2_g1t9_root_equiv.json`,
  `${ROUND}/logs/g2_control_uud.json`,
  `${ROUND}/logs/g2_control_drrr.json`,
  `${ROUND}/logs/g3_truncation.json`,
  `${ROUND}/logs/g3_window_isolation.json`,
  `${ROUND}/logs/g3_no_win_dual.json`,
  `${ROUND}/logs/g3_rule_isolation.json`,
];

const VOLATILE = new Set([
  'generatedAt', 'elapsedMs', 'solveElapsedMs', 'verifyElapsedMs', 'riskMs', 'witnessMs',
  'enumerationMs', 'enumerateMs', 'oneTurnMs', 'staticReachMs', 'twoTurnMs', 'proofElapsedMs',
  'shadowTotalMs', 'shadowWitnessMs', 'peakRssMB',
  'proofNecessaryMs', 'certificateMs', 'optionalDiagnosticsMs', 'rssBeforeMB', 'rssAfterMB', 'withinCheapBudget',
  'host', 'totalMB', 'freeMB', 'vitestProcesses', 'vitestOutOfTree', 'foreignNodeProcesses',
  'duplicateHeavyWorkers', 'admission', 'freeFloorMB', 'live',
]);

function split(value, perf, path = '') {
  if (Array.isArray(value)) {
    return value.map((v, i) => split(v, perf, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    const sem = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE.has(k)) {
        perf[`${path}.${k}`] = v;
        continue;
      }
      sem[k] = split(v, perf, `${path}.${k}`);
    }
    return sem;
  }
  return value;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const out = { round: ROUND, files: {}, combined: null, performance: {} };
const combo = [];

for (const f of FILES) {
  const raw = JSON.parse(readFileSync(f, 'utf8'));
  const perf = {};
  const sem = split(raw, perf, f);
  const text = JSON.stringify(sem);
  out.files[f] = sha256(text);
  out.performance[f] = perf;
  combo.push(`${f}:${out.files[f]}`);
}
out.combined = sha256(combo.join('\n'));

writeFileSync(`${ROUND}/logs/digest.json`, JSON.stringify(out, null, 2));
console.log(`combined semantic digest: ${out.combined}`);
console.log(`performance keys: ${Object.values(out.performance).reduce((a, p) => a + Object.keys(p).length, 0)} (not hashed)`);