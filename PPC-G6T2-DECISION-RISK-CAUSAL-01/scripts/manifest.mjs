// Generates SOURCE_MANIFEST.json + SHA256SUMS.txt for this round.
// Run LAST: every listed file must be final (registered artifacts are immutable).
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const ROUND = 'PPC-G6T2-DECISION-RISK-CAUSAL-01';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const roles = {
  'REPORT.md': 'human report (Chinese, PASS/FAIL)',
  'G6T2_DECISION_CAUSAL_TRACE.json': 'G2 causal trace artifact',
  'TURN_AWARE_MOUSE_GOAL_RISK_SPEC.md': 'shadow prototype spec',
  'TACTICAL_RISK_WITNESSES.json': 'G3 per-plan witnesses',
  'CROSS_ROOT_SHADOW_RESULTS.json': 'G4 cross-root results',
  'CACHE_CONTRACT_FINAL_ERRATA.md': 'G1 cache contract errata',
  'RESOURCE_SAFETY_LOG.md': 'G5 provenance/resource log',
};
const probeRoles = {
  'probe/dr_lib.ts': 'shared shadow harness (read-only imports of production)',
  'probe/vitest.config.mts': 'isolated vitest config (serial, 1 worker)',
  'probe/digest.mjs': 'normalized artifact digest',
  'probe/digest_diff.mjs': 'diagnostic canonical diff',
  'probe/g0_identity.test.ts': 'G0 identity/ledger audit',
  'probe/g1_cache_errata.test.ts': 'G1 recompute',
  'probe/g2_causal.test.ts': 'G2 causal trace',
  'probe/g3_risk.test.ts': 'G3 calibration',
  'probe/g4_cross_root.test.ts': 'G4 cross-root controls',
  'probe/g5_env.test.ts': 'G5 provenance/resource',
  'scripts/run.sh': 'one fresh process per phase',
  'scripts/determinism.sh': '3 serial fresh-process rounds + digest',
};

const top = readdirSync(ROUND)
  .filter((n) => !['logs', 'probe', 'scripts'].includes(n) && n !== 'SHA256SUMS.txt' && n !== 'SOURCE_MANIFEST.json' && !statSync(join(ROUND, n)).isDirectory())
  .map((n) => join(ROUND, n));
const probes = walk(join(ROUND, 'probe')).filter((p) => !p.endsWith('.diff.json'));
const scripts = walk(join(ROUND, 'scripts'));
const logs = walk(join(ROUND, 'logs')).filter((p) => !p.includes('stdout.log') && !p.includes('snap_r'));

const entry = (abs) => {
  const rel = relative(ROUND, abs).replaceAll('\\', '/');
  return { path: rel, role: roles[rel] ?? probeRoles[rel] ?? (rel.startsWith('logs/') ? 'evidence log' : 'artifact'), sha256: sha(abs), bytes: statSync(abs).size };
};

const files = [...top, ...probes, ...scripts, ...logs].map(entry).sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  round: ROUND,
  generatedAt: new Date().toISOString(),
  selfDigestNote: 'This manifest cannot contain its own hash; SHA256SUMS.txt covers SOURCE_MANIFEST.json. Verify with scripts/verify_ledger.sh (recompute) or `sha256sum -c` on the 3-column ledger parse.',
  files,
  frozenInputs: {
    'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json': { sha256: '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09', note: 'root fixture (read-only)' },
    'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts': { sha256: '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b', note: 'quantifier kernel (read-only)' },
  },
  excluded: ['logs/*.stdout.log (vitest console output)', 'logs/snap_r*/ (per-round copies of the two regenerated artifacts)'],
  provenance: {
    measurementSource: 'WINDOWS_LOCAL_WORKSTATION',
    node: process.version,
    note: 'Timings are local Windows measurements and are not evidence for the 100ms production budget.',
  },
};
writeFileSync(join(ROUND, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest, null, 2));

const sums = [...files, entry(join(ROUND, 'SOURCE_MANIFEST.json'))]
  .sort((a, b) => a.path.localeCompare(b.path))
  .map((f) => `${f.sha256}  ${f.bytes}  ${ROUND}/${f.path}`)
  .join('\n');
writeFileSync(join(ROUND, 'SHA256SUMS.txt'), `${sums}\n`);
console.log(`manifest: ${files.length} files; ledger: ${files.length + 1} lines`);