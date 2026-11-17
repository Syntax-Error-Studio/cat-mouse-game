// PPC-CAT-STRATEGY-SEAL-01 — Phase 7 evidence & hash seal.
// Light, read-only hashing + an out-of-repo archive restore verification.
// NO production source is touched; previous-round artifacts are never overwritten.
//
// Self-reference fix (task §7):
//   SOURCE_MANIFEST.json declares selfExcluded:true and carries NO self-SHA.
//   The EXTERNAL SHA256SUMS.txt records the manifest digest (and every content
//   file's binary SHA256 + byte length). SEAL_VERIFICATION.json anchors the
//   SHA256SUMS digest + the archive digest + the restore-verify result.
//   Cycle: content -> manifest(no self) -> SHA256SUMS(anchors manifest)
//          -> SEAL_VERIFICATION(anchors SHA256SUMS + archive). No file hashes itself.
//
// All hashes are over RAW BYTES (Buffer), so CRLF/LF cannot produce a false proof.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();                       // F:\小猫小鼠
const DIR = join(ROOT, 'PPC-CAT-STRATEGY-SEAL-01');
const OUTSIDE = 'F:/ppc-checkpoints';             // archive + restore live OUTSIDE the repo
const ARCHIVE = join(OUTSIDE, 'PPC-CAT-STRATEGY-SEAL-01-deliverables.tar.gz');
const RESTORE = join(OUTSIDE, '_restore_seal01');
const HEAD = '48eaac6c4f3801d351787696ba5876995b64e8d8';

// Sealing outputs are generated here; never treated as content (avoids self-hash).
const SEAL_OUTPUTS = new Set(['SOURCE_MANIFEST.json', 'SHA256SUMS.txt', 'SEAL_VERIFICATION.json']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hashFile = (abs) => { const b = readFileSync(abs); return { sha256: sha256(b), bytes: b.length }; };

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, base, acc);
    else acc.push(abs);
  }
  return acc;
}

const rel = (abs) => relative(DIR, abs).split(sep).join('/');

// 1. Enumerate content files (everything except the sealing outputs).
const contentAbs = walk(DIR).filter((abs) => !SEAL_OUTPUTS.has(rel(abs))).sort();
const content = contentAbs.map((abs) => ({ path: rel(abs), ...hashFile(abs) }));

// 2. SOURCE_MANIFEST.json — selfExcluded, NO self-SHA.
const manifest = {
  artifactId: 'SOURCE_MANIFEST', round: 'PPC-CAT-STRATEGY-SEAL-01', phase: 7,
  generatedAt: new Date().toISOString(), generatedBy: 'PPC-CAT-STRATEGY-SEAL-01/probe/seal.mjs',
  head: HEAD,
  selfExcluded: true, selfSha256: null,
  selfReferenceNote: 'This manifest deliberately carries NO digest of itself. Its digest is recorded externally in SHA256SUMS.txt (which is itself anchored by SEAL_VERIFICATION.json).',
  sealingOutputsExcluded: [...SEAL_OUTPUTS],
  hashAlgorithm: 'sha256 over raw file bytes (CRLF/LF agnostic)',
  contentFileCount: content.length,
  files: content,
  sourceIntegrity: {
    evidence: '_raw/source_integrity.json',
    modifiedChecked: 29, modifiedMismatches: 0, depsChecked: 16, depsMismatches: 0, totalMismatches: 0,
    productionSourceChanged: false, gameRulesChanged: false, searchMathChanged: false, h1Changed: false, sidecarChanged: false,
  },
  frozenInputs: [
    { path: 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', sha256: '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09', bytes: 264328 },
    { path: 'GAMEPLAY.md', sha256: 'e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34', bytes: 21128 },
  ],
};
const manifestAbs = join(DIR, 'SOURCE_MANIFEST.json');
writeFileSync(manifestAbs, JSON.stringify(manifest, null, 2));
const manifestHash = hashFile(manifestAbs);

// 3. SHA256SUMS.txt — external ledger; records the manifest digest + every content file.
//    Format: <sha256>  <bytes>  <path>   (path relative to the SEAL-01 dir).
const sumsLines = [
  ...content.map((f) => `${f.sha256}  ${f.bytes}  ${f.path}`),
  `${manifestHash.sha256}  ${manifestHash.bytes}  SOURCE_MANIFEST.json`,
];
const sumsAbs = join(DIR, 'SHA256SUMS.txt');
writeFileSync(sumsAbs, sumsLines.join('\n') + '\n');
const sumsHash = hashFile(sumsAbs);

// 4. Archive (content + manifest + SHA256SUMS) OUTSIDE the repo; restore-verify.
mkdirSync(OUTSIDE, { recursive: true });
if (existsSync(ARCHIVE)) rmSync(ARCHIVE);
if (existsSync(RESTORE)) rmSync(RESTORE, { recursive: true, force: true });
mkdirSync(RESTORE, { recursive: true });
// tar from the repo root so paths are PPC-CAT-STRATEGY-SEAL-01/...
const archiveMembers = [...content.map((f) => `PPC-CAT-STRATEGY-SEAL-01/${f.path}`),
  'PPC-CAT-STRATEGY-SEAL-01/SOURCE_MANIFEST.json', 'PPC-CAT-STRATEGY-SEAL-01/SHA256SUMS.txt'];
execFileSync('tar', ['--force-local', '-czf', ARCHIVE, ...archiveMembers], { cwd: ROOT, stdio: 'pipe' });
const archiveHash = hashFile(ARCHIVE);
execFileSync('tar', ['--force-local', '-xzf', ARCHIVE, '-C', RESTORE], { cwd: ROOT, stdio: 'pipe' });

// re-hash every restored member; compare to the recorded digests (byte-exact).
const expected = new Map([...content.map((f) => [`PPC-CAT-STRATEGY-SEAL-01/${f.path}`, f]),
  ['PPC-CAT-STRATEGY-SEAL-01/SOURCE_MANIFEST.json', { path: 'SOURCE_MANIFEST.json', ...manifestHash }],
  ['PPC-CAT-STRATEGY-SEAL-01/SHA256SUMS.txt', { path: 'SHA256SUMS.txt', ...sumsHash }]]);
let restoredChecked = 0, restoredMismatches = 0; const mismatchDetail = [];
for (const [member, exp] of expected) {
  const restoredAbs = join(RESTORE, member);
  if (!existsSync(restoredAbs)) { restoredMismatches++; mismatchDetail.push({ member, reason: 'MISSING_AFTER_RESTORE' }); continue; }
  const got = hashFile(restoredAbs);
  restoredChecked++;
  if (got.sha256 !== exp.sha256 || got.bytes !== exp.bytes) {
    restoredMismatches++; mismatchDetail.push({ member, expectedSha256: exp.sha256, gotSha256: got.sha256, expectedBytes: exp.bytes, gotBytes: got.bytes });
  }
}

// 5. SEAL_VERIFICATION.json — anchors SHA256SUMS + archive + restore result.
const verification = {
  artifactId: 'SEAL_VERIFICATION', round: 'PPC-CAT-STRATEGY-SEAL-01', phase: 7,
  generatedAt: new Date().toISOString(), generatedBy: 'PPC-CAT-STRATEGY-SEAL-01/probe/seal.mjs', head: HEAD,
  hashAlgorithm: 'sha256 over raw bytes',
  contentFileCount: content.length,
  manifest: { path: 'SOURCE_MANIFEST.json', selfExcluded: true, sha256: manifestHash.sha256, bytes: manifestHash.bytes },
  sha256sums: { path: 'SHA256SUMS.txt', sha256: sumsHash.sha256, bytes: sumsHash.bytes, recordsManifestDigest: true },
  archive: { path: ARCHIVE, sha256: archiveHash.sha256, bytes: archiveHash.bytes, memberCount: archiveMembers.length, outsideRepo: true },
  restore: { dir: RESTORE, outsideRepo: true, filesChecked: restoredChecked, mismatches: restoredMismatches,
    allByteIdentical: restoredMismatches === 0 && restoredChecked === expected.size, mismatchDetail },
  selfReferenceCycleBroken: true,
  crlfLfFalseProof: 'NONE — every digest is over raw Buffer bytes; restore compared byte-for-byte',
  previousRoundOverwritten: false,
};
writeFileSync(join(DIR, 'SEAL_VERIFICATION.json'), JSON.stringify(verification, null, 2));

console.log('CONTENT_FILES=', content.length);
console.log('MANIFEST_SHA=', manifestHash.sha256, manifestHash.bytes);
console.log('SHA256SUMS_SHA=', sumsHash.sha256, sumsHash.bytes);
console.log('ARCHIVE=', ARCHIVE, archiveHash.sha256, archiveHash.bytes);
console.log('RESTORE checked=', restoredChecked, 'mismatches=', restoredMismatches, 'allByteIdentical=', verification.restore.allByteIdentical);
if (restoredMismatches > 0) { console.log('MISMATCH_DETAIL=', JSON.stringify(mismatchDetail)); process.exitCode = 1; }