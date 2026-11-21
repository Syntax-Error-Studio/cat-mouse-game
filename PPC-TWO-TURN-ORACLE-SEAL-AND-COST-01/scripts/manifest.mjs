#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROUND = 'PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const hashFile = (p) => sha256(readFileSync(p));

const top = [
  'REPORT.md', 'WINDOW_AND_LABEL_LINEAGE.md', 'DUUD_INDEPENDENT_PROOF.json',
  'INDEPENDENT_VERIFIER_RESULT.json', 'QUANTIFIER_COUNTEREXAMPLES.json',
  'WITNESS_COST_ABLATION.json', 'RESOURCE_SAFETY_LOG.md',
];
const dirs = ['probe', 'scripts'];
const logExclude = new Set(['digest.json']);
const extraLogs = ['determinism_summary.json'];

const files = [];
const norm = (p) => p.split('\\').join('/');
const push = (p) => files.push({ path: norm(p), sha256: hashFile(p), bytes: statSync(p).size });
for (const f of top) push(join(ROUND, f));
for (const d of dirs) {
  for (const f of readdirSync(join(ROUND, d)).sort()) push(join(ROUND, d, f));
}
const logDir = join(ROUND, 'logs');
for (const f of readdirSync(logDir).sort()) {
  if (f.startsWith('rep') || f.startsWith('det_') || f.startsWith('digest_r')) continue;
  if (f.endsWith('.json') || f.endsWith('.log')) push(join(logDir, f));
}

const identity = {
  head: 'd533c8fb1e9c8b1822e84e737253f7ea73d3dbb1',
  branch: 'ppc/p1-id-state-identity-fix',
  fixture: { path: 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', sha256: hashFile('src/game/ai/__tests__/fixtures/ppcId01-human-roots.json') },
  sealKernel: { path: 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts', sha256: hashFile('PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts') },
  strategyKernel: { path: 'PPC-CAT-STRATEGY-01/probe/lib.ts', sha256: hashFile('PPC-CAT-STRATEGY-01/probe/lib.ts') },
  shadowLib: { path: 'PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.ts', sha256: hashFile('PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.ts') },
  gameplay: { path: 'GAMEPLAY.md', sha256: hashFile('GAMEPLAY.md') },
  preparedActions: { path: 'src/game/ai/preparedActions.ts', sha256: hashFile('src/game/ai/preparedActions.ts') },
};

const manifest = {
  round: ROUND,
  generatedBy: `${ROUND}/scripts/manifest.mjs`,
  identity,
  parameters: {
    oracle: 'seal_lib.solve + verifyMouseCertificate (frozen, read-only)',
    H: 2, startIdx: 1, cap: 600_000, cheapCap: 5_000, cheapWallMs: 20,
    modes: ['mouseForce', 'catSurvive(dual only, separately labelled)'],
    repetitions: 3, serialFreshProcesses: true, heavyWorkerConcurrency: 1,
    neverReusedAcrossRoots: true,
  },
  scope: {
    productionWiring: 'NO', commit: 'NO', push: 'NO', merge: 'NO',
    cloud: 'not contacted (8787/8788 untouched)',
    frozenArtifactsOverwritten: false,
    priorRoundReportCorrection: 'gloss only; frozen JSON untouched',
  },
  counts: {
    srcClosure36: 36,
    dependencyClosure39: 39,
    certificateBound37: 'THIRD_COUNT_SOURCE_NOT_FOUND',
  },
  files,
  exclusions: ['logs/rep*/ (forensic copies)', 'logs/det_*.log', 'logs/digest_r*.json', 'logs/digest.json is included'],
};
writeFileSync(`${ROUND}/SOURCE_MANIFEST.json`, JSON.stringify(manifest, null, 2));

const lines = files.map((f) => `${f.sha256}  ${String(f.bytes).padStart(8)}  ${f.path}`);
lines.push(`${sha256(readFileSync(`${ROUND}/SOURCE_MANIFEST.json`))}  ${String(statSync(`${ROUND}/SOURCE_MANIFEST.json`).size).padStart(8)}  ${ROUND}/SOURCE_MANIFEST.json`);
writeFileSync(`${ROUND}/SHA256SUMS.txt`, lines.join('\n') + '\n');
console.log(`manifest: ${files.length} files + itself = ${lines.length} lines`);