/// <reference types="node" />
/**
 * Write SOURCE_MANIFEST.json (no self-hash) and SHA256SUMS.txt.
 * Validates freeze integrity, JSON parseability, CSV row count, and frozen hashes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const OUT = 'PPC-T2-PCV-TAIL-01';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const stat = (p) => {
  const b = readFileSync(p);
  return { path: p, sha256: sha256(b), bytes: b.length };
};
const parse = (p) => JSON.parse(readFileSync(p, 'utf8'));

const artifacts = [
  [OUT + '/TAIL_CANDIDATES.json', 'Frozen tail candidate set'],
  [OUT + '/TAIL_DEDUP_AUDIT.json', 'Full identity/dedup canonical-state audit'],
  [OUT + '/_raw/TAIL_CANDIDATE_FREEZE.json', 'Pre-proof freeze record'],
  [OUT + '/TAIL_PROOF_REP1.json', 'Fresh-process proof repetition 1'],
  [OUT + '/TAIL_PROOF_REP2.json', 'Fresh-process proof repetition 2'],
  [OUT + '/TAIL_CERTIFICATE_VERIFICATION.json', 'Cross-repetition certificate verification and determinism audit'],
  [OUT + '/TAIL_MATRIX.csv', 'Four-record tail result matrix'],
  [OUT + '/REPORT.md', 'Final report'],
  [OUT + '/RESOURCE_SAFETY_LOG.md', 'Resource and read-only safety log'],
  [OUT + '/logs/generate.log', 'Generation/freeze log'],
  [OUT + '/logs/rep1.log', 'Proof repetition 1 log'],
  [OUT + '/logs/rep2.log', 'Proof repetition 2 log'],
  [OUT + '/logs/aggregate.log', 'Aggregation log'],
  [OUT + '/probe/tail_lib.ts', 'Identity, dedup, replay, certificate helper library'],
  [OUT + '/probe/generate_tail.test.ts', 'Candidate identity/freeze test step'],
  [OUT + '/probe/prove_tail.test.ts', 'H0/reuse proof test step'],
  [OUT + '/probe/vitest.config.mts', 'Serial fresh-process Vitest configuration'],
  [OUT + '/probe/aggregate_tail.mjs', 'Cross-repetition aggregator'],
  [OUT + '/probe/finalize_tail.mjs', 'Manifest and checksum finalizer'],
];

const frozenInputs = [
  ['GAMEPLAY.md', 'e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34'],
  ['src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09'],
  ['PPC-T2-PCV-RESCUE-01/CANDIDATE_PLANS.json', '8f5a3f9d99ac2f61c895255e72650b3761418cb58ff5152b7d5e94619f8fc3ed'],
  ['PPC-T2-PCV-RESCUE-01/_raw/CANDIDATE_FREEZE.json', 'ccd1925c1a4b489e330bd014c1dcc57434e1ab0e3c895c1f994c38f825e716f7'],
  ['PPC-T2-PCV-RESCUE-01/ALTERNATIVE_PROOF_RESULTS.json', '3351036f445e843c876d3629ea7698abd1e56c704aaffadeca74151cd7ef050a'],
  ['PPC-T2-PCV-RESCUE-01/SOURCE_MANIFEST.json', 'b6b5b493b275efdc5952c040e0d18a3c89ee4a7e18928b5da577f5a9b08e5041'],
  ['PPC-T1-PCV-01/SOURCE_MANIFEST.json', '01f39e30be90b422f3cc6108a1373f85eed981a31b482b5df2a89797cf84f133'],
  ['PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts', '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b'],
];

const productionSources = [
  ['src/game/ai/preparedActions.ts', '67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764'],
  ['src/game/ai/expectiminimax.ts', '50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c'],
  ['src/game/engine.ts', '099f9a7b6d97b838c664aa7186be58465e5b01b8052af4b4e4e19a5644d19f06'],
];

for (const [p, expected] of [...frozenInputs, ...productionSources]) {
  const actual = stat(p).sha256;
  if (actual !== expected) throw new Error(`HASH_MISMATCH ${p} expected=${expected} actual=${actual}`);
}
for (const p of [
  OUT + '/TAIL_CANDIDATES.json', OUT + '/TAIL_DEDUP_AUDIT.json',
  OUT + '/TAIL_PROOF_REP1.json', OUT + '/TAIL_PROOF_REP2.json',
  OUT + '/TAIL_CERTIFICATE_VERIFICATION.json', OUT + '/_raw/TAIL_CANDIDATE_FREEZE.json',
]) parse(p);
const csvLines = readFileSync(OUT + '/TAIL_MATRIX.csv', 'utf8').split(/\r?\n/).filter(Boolean);
if (csvLines.length - 1 !== 4) throw new Error('TAIL_MATRIX_ROW_COUNT');

const recorded = artifacts.map(([path, role]) => ({ ...stat(path), role }));
const byPath = new Map(recorded.map((x) => [x.path, x]));
if (byPath.get(OUT + '/TAIL_CANDIDATES.json').sha256
  !== parse(OUT + '/_raw/TAIL_CANDIDATE_FREEZE.json').candidates.sha256) {
  throw new Error('TAIL_CANDIDATE_FREEZE_HASH_MISMATCH');
}
if (byPath.get(OUT + '/TAIL_DEDUP_AUDIT.json').sha256
  !== parse(OUT + '/_raw/TAIL_CANDIDATE_FREEZE.json').audit.sha256) {
  throw new Error('TAIL_AUDIT_FREEZE_HASH_MISMATCH');
}

const statusLines = execSync('git status --porcelain', { encoding: 'utf8' })
  .replace(/\r?\n$/, '').split(/\r?\n/).filter(Boolean);
const worktree = {
  head: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
  branch: execSync('git branch --show-current', { encoding: 'utf8' }).trim(),
  preexistingTrackedModifications: 15,
  preexistingUntrackedEntries: 51,
  currentTrackedModifications: statusLines.filter((l) => l.startsWith(' M')).length,
  currentUntrackedEntries: statusLines.filter((l) => l.startsWith('??')).length,
  newUntrackedEntriesThisRound: statusLines.filter((l) => l.startsWith('??') && l.includes(OUT)).length,
  note: 'Pre-existing worktree changes were preserved; only the new TAIL directory was added by this round.',
};

const manifest = {
  round: OUT,
  type: 'READ_ONLY_TAIL_CERTIFICATION',
  generatedAt: new Date().toISOString(),
  algorithm: 'sha256',
  selfHashOmitted: true,
  note: 'This manifest omits its own hash to avoid self-reference; SHA256SUMS.txt records it, and SHA256SUMS.txt does not hash itself.',
  worktree,
  artifacts: recorded,
  frozenInputs: frozenInputs.map(([path, expected]) => ({ path, expectedSha256: expected, actualSha256: stat(path).sha256, match: true })),
  productionSources: productionSources.map(([path, expected]) => ({ path, expectedSha256: expected, actualSha256: stat(path).sha256, match: true })),
  summary: {
    originalRecords: 4,
    uniqueFrontiers: 2,
    reusedCertificates: 1,
    h0ProvenRecords: 4,
    h0RefutedRecords: 4,
    h1RunRecords: 0,
    h1ProvenRecords: 0,
    rescueRecords: 0,
    verifyFailures: 0,
    falseProven: 0,
    identityMismatches: 0,
    chanceComplete: true,
    rescueStatus: 'NO_PROVEN_TACTICAL_RESCUE_H1',
  },
};
writeFileSync(OUT + '/SOURCE_MANIFEST.json', JSON.stringify(manifest, null, 1));

const manifestStat = stat(OUT + '/SOURCE_MANIFEST.json');
const sums = [...recorded, { ...manifestStat, role: 'Source manifest (self-hash omitted)' }]
  .sort((a, b) => a.path.localeCompare(b.path))
  .map((x) => `${x.sha256}  ${x.path.replace(/\\/g, '/')}  ${x.bytes}`)
  .join('\n') + '\n';
writeFileSync(OUT + '/SHA256SUMS.txt', sums);

console.log(JSON.stringify({
  artifactCount: recorded.length,
  manifestSha256: manifestStat.sha256,
  manifestBytes: manifestStat.bytes,
  checksumLines: sums.trim().split('\n').length,
  csvDataRows: csvLines.length - 1,
  allJsonParseable: true,
  frozenHashesMatch: true,
}, null, 2));
