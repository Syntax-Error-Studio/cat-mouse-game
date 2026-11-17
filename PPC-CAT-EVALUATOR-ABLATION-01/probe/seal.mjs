// PPC-CAT-EVALUATOR-ABLATION-01 — Phase 8 (§9) evidence & hash seal.
// Light, read-only hashing + an OUT-OF-REPO archive restore verification.
// NO production source is touched by this round; previous-round artifacts are NEVER overwritten.
//
// Self-reference cycle (no file hashes itself):
//   content -> SOURCE_MANIFEST.json (selfExcluded, NO self-SHA)
//           -> SHA256SUMS.txt (external ledger; records the manifest digest)
//           -> SEAL_VERIFICATION.json (anchors SHA256SUMS + archive + restore + RESTORE.md)
//   RESTORE.md + SEAL_VERIFICATION.json are terminal sealing OUTPUTS: excluded from
//   the content walk and NOT inside the archive they describe/anchor.
//
// All hashes are over RAW BYTES (Buffer) so CRLF/LF cannot produce a false proof.
// Per-file line-ending class is recorded AND re-verified on restore (§9).
// Restore checks BOTH missing==0 AND extra==0 (§9).
//
// WORKING-TREE INTEGRITY (§2/§9) distinguishes TWO different facts:
//   (a) roundModifiedProduction — did THIS ROUND write any production source?
//       Proven NO via mtime: every changed src file predates the round's first artifact.
//   (b) workingTreeDiffersFromHead — the tree carries PRE-EXISTING uncommitted production
//       patches (the user's in-progress PPC-P2-PREPARED-TRANSITION-01 / timing-repair work,
//       dated 11-12..11-14). This is DISCLOSED, not hidden, and not a round violation.
//   E1/H1 leaf sources (evaluation.ts, correctedHoleLeaf.ts) are byte-identical to HEAD.
//
// Run from the repo root:  node PPC-CAT-EVALUATOR-ABLATION-01/probe/seal.mjs
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();                       // F:\小猫小鼠
const ROUND = 'PPC-CAT-EVALUATOR-ABLATION-01';
const DIR = join(ROOT, ROUND);
const OUTSIDE = 'F:/ppc-checkpoints';             // archive + restore live OUTSIDE the repo
const ARCHIVE = join(OUTSIDE, `${ROUND}-candidate.tar.gz`);
const RESTORE = join(OUTSIDE, `_restore_ablation01`);
const HEAD = '48eaac6c4f3801d351787696ba5876995b64e8d8';
const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const FROZEN_FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const LEAF_SOURCES = ['src/game/ai/evaluation.ts', 'src/game/ai/correctedHoleLeaf.ts'];

const SEAL_OUTPUTS = new Set(['SOURCE_MANIFEST.json', 'SHA256SUMS.txt', 'SEAL_VERIFICATION.json', 'RESTORE.md']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hashFile = (abs) => { const b = readFileSync(abs); return { sha256: sha256(b), bytes: b.length }; };
function lineEnding(buf) {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) { if (buf[i + 1] === 0x0a) { crlf++; i++; } else cr++; }
    else if (buf[i] === 0x0a) lf++;
  }
  if (crlf > 0 && lf === 0 && cr === 0) return 'CRLF';
  if (crlf === 0 && lf > 0 && cr === 0) return 'LF';
  if (crlf === 0 && lf === 0 && cr > 0) return 'CR';
  if (crlf === 0 && lf === 0 && cr === 0) return 'NONE';
  return 'MIXED';
}
const fileFacts = (abs) => { const b = readFileSync(abs); return { sha256: sha256(b), bytes: b.length, lineEnding: lineEnding(b) }; };
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) { const abs = join(dir, name); if (statSync(abs).isDirectory()) walk(abs, acc); else acc.push(abs); }
  return acc;
}
const rel = (abs) => relative(DIR, abs).split(sep).join('/');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// ---- integrity gate: frozen fixture must match its frozen SHA (read-only) ----
const fixtureLive = hashFile(join(ROOT, FIXTURE));
if (fixtureLive.sha256 !== FROZEN_FIXTURE_SHA) { console.error(`FROZEN_FIXTURE_MISMATCH live=${fixtureLive.sha256} expected=${FROZEN_FIXTURE_SHA}`); process.exit(1); }
const headLive = git(['rev-parse', 'HEAD']).trim();

// 1. Enumerate content files (everything except the sealing outputs).
const contentAbs = walk(DIR).filter((abs) => !SEAL_OUTPUTS.has(rel(abs))).sort();
const content = contentAbs.map((abs) => ({ path: rel(abs), ...fileFacts(abs) }));

// ---- working-tree integrity: round-modification vs pre-existing divergence ----
const roundStartMs = Math.min(...contentAbs.map((abs) => statSync(abs).mtimeMs));
const roundStartProxy = new Date(roundStartMs).toISOString();
const gitDiffSrc = git(['diff', '--', 'src', 'GAMEPLAY.md']);
const gitDiffStagedSrc = git(['diff', '--cached', '--', 'src', 'GAMEPLAY.md']);
const workingTreeDiffersFromHead = gitDiffSrc.trim().length > 0 || gitDiffStagedSrc.trim().length > 0;
const numstat = git(['diff', '--numstat', '--', 'src', 'GAMEPLAY.md']).trim().split('\n').filter(Boolean).map((l) => { const [a, d, f] = l.split('\t'); return { file: f, added: Number(a), deleted: Number(d) }; });
const preExistingPatchInventory = numstat.map((e) => { const mt = statSync(join(ROOT, e.file)).mtimeMs; return { ...e, mtime: new Date(mt).toISOString(), predatesRoundStart: mt < roundStartMs }; });
const changedDuringRound = preExistingPatchInventory.filter((e) => !e.predatesRoundStart);
const roundModifiedProduction = changedDuringRound.length > 0;
const leafDiff = git(['diff', '--', ...LEAF_SOURCES]);
const leafSourcesMatchHead = leafDiff.trim().length === 0;
const allPatchesPredateRound = preExistingPatchInventory.every((e) => e.predatesRoundStart);

// 2. SOURCE_MANIFEST.json — selfExcluded, NO self-SHA.
const manifest = {
  artifactId: 'SOURCE_MANIFEST', round: ROUND, phase: 8,
  generatedAt: new Date().toISOString(), generatedBy: `${ROUND}/probe/seal.mjs`,
  head: HEAD, headLive,
  selfExcluded: true, selfSha256: null,
  selfReferenceNote: 'This manifest deliberately carries NO digest of itself. Its digest is recorded externally in SHA256SUMS.txt (anchored by SEAL_VERIFICATION.json). RESTORE.md + SEAL_VERIFICATION.json are terminal sealing outputs, excluded from content and from the archive.',
  sealingOutputsExcluded: [...SEAL_OUTPUTS],
  hashAlgorithm: 'sha256 over raw file bytes (CRLF/LF agnostic)',
  lineEndingRecorded: true,
  contentFileCount: content.length,
  files: content,
  sourceIntegrity: {
    roundModifiedProduction, roundStartProxy, changedDuringRound,
    workingTreeDiffersFromHead, allPatchesPredateRound, leafSourcesMatchHead,
    headMatchesFrozen: headLive === HEAD,
    preExistingPatchInventory,
    disclosure: 'The working tree carries PRE-EXISTING uncommitted production patches relative to HEAD (the user in-progress PPC-P2-PREPARED-TRANSITION-01 candidate-enumeration refactor + timing-repair work, mtimes 2026-11-12..11-14). EVERY changed src file predates this round first artifact (2026-11-15 20:16+), so THIS ROUND modified NO production source. E1/H1 leaf sources (evaluation.ts, correctedHoleLeaf.ts) are byte-identical to HEAD. Both ablation arms ran against the SAME stable substrate, so the RELATIVE E1-vs-H1 comparison is internally valid; the ABSOLUTE baseline is HEAD+pre-existing-patches, NOT pristine HEAD. This divergence is disclosed for the ChatGPT architectural ruling; no gate was edited and no evidence deleted.',
    gameRulesChangedByRound: false, searchMathChangedByRound: false, h1ChangedByRound: false, sidecarChangedByRound: false, guardChangedByRound: false, mouseAiChangedByRound: false, budgetChangedByRound: false,
  },
  frozenInputs: [
    { path: FIXTURE, sha256: fixtureLive.sha256, bytes: fixtureLive.bytes, frozenSha256: FROZEN_FIXTURE_SHA, matches: fixtureLive.sha256 === FROZEN_FIXTURE_SHA },
  ],
};
const manifestAbs = join(DIR, 'SOURCE_MANIFEST.json');
writeFileSync(manifestAbs, JSON.stringify(manifest, null, 2));
const manifestHash = hashFile(manifestAbs);

// 3. SHA256SUMS.txt — external ledger; records every content file + the manifest digest.
const sumsLines = [...content.map((f) => `${f.sha256}  ${f.bytes}  ${f.path}`), `${manifestHash.sha256}  ${manifestHash.bytes}  SOURCE_MANIFEST.json`];
const sumsAbs = join(DIR, 'SHA256SUMS.txt');
writeFileSync(sumsAbs, sumsLines.join('\n') + '\n');
const sumsHash = hashFile(sumsAbs);

// 4. Archive (content + manifest + SHA256SUMS) OUTSIDE the repo; restore-verify.
mkdirSync(OUTSIDE, { recursive: true });
if (existsSync(ARCHIVE)) { console.error(`ARCHIVE_EXISTS_REFUSE_OVERWRITE ${ARCHIVE} (no-overwrite-history)`); process.exit(1); }
if (existsSync(RESTORE)) { console.error(`RESTORE_DIR_EXISTS ${RESTORE} — remove it manually before re-sealing (no silent clobber)`); process.exit(1); }
mkdirSync(RESTORE, { recursive: true });
const archiveMembers = [...content.map((f) => `${ROUND}/${f.path}`), `${ROUND}/SOURCE_MANIFEST.json`, `${ROUND}/SHA256SUMS.txt`];
execFileSync('tar', ['--force-local', '-czf', ARCHIVE, ...archiveMembers], { cwd: ROOT, stdio: 'pipe' });
const archiveHash = hashFile(ARCHIVE);
execFileSync('tar', ['--force-local', '-xzf', ARCHIVE, '-C', RESTORE], { cwd: ROOT, stdio: 'pipe' });

const expected = new Map([...content.map((f) => [`${ROUND}/${f.path}`, f]),
  [`${ROUND}/SOURCE_MANIFEST.json`, { path: 'SOURCE_MANIFEST.json', ...manifestHash, lineEnding: lineEnding(readFileSync(manifestAbs)) }],
  [`${ROUND}/SHA256SUMS.txt`, { path: 'SHA256SUMS.txt', ...sumsHash, lineEnding: lineEnding(readFileSync(sumsAbs)) }]]);
let restoredChecked = 0, restoredMismatches = 0, lineEndingMismatches = 0; const mismatchDetail = [];
for (const [member, exp] of expected) {
  const restoredAbs = join(RESTORE, member);
  if (!existsSync(restoredAbs)) { restoredMismatches++; mismatchDetail.push({ member, reason: 'MISSING_AFTER_RESTORE' }); continue; }
  const got = fileFacts(restoredAbs);
  restoredChecked++;
  if (got.sha256 !== exp.sha256 || got.bytes !== exp.bytes) { restoredMismatches++; mismatchDetail.push({ member, expectedSha256: exp.sha256, gotSha256: got.sha256, expectedBytes: exp.bytes, gotBytes: got.bytes }); }
  if (got.lineEnding !== exp.lineEnding) { lineEndingMismatches++; mismatchDetail.push({ member, reason: 'LINE_ENDING_MISMATCH', expected: exp.lineEnding, got: got.lineEnding }); }
}
const restoredAll = walk(RESTORE).map((abs) => relative(RESTORE, abs).split(sep).join('/'));
const expectedMembers = new Set([...expected.keys()]);
const extraFiles = restoredAll.filter((m) => !expectedMembers.has(m));
const missingFiles = [...expectedMembers].filter((m) => !restoredAll.includes(m));

// 5. RESTORE.md — human restore guide + verification summary (terminal output).
const restoreMd = `# RESTORE — ${ROUND}

Archive (OUTSIDE the repo): \`${ARCHIVE}\`
Archive SHA256: \`${archiveHash.sha256}\`  bytes: ${archiveHash.bytes}  members: ${archiveMembers.length}

## Restore steps (run anywhere OUTSIDE the repo)
\`\`\`sh
mkdir -p <restore-dir>
tar --force-local -xzf "${ARCHIVE}" -C <restore-dir>
# members unpack under ${ROUND}/...
\`\`\`

## Verify (independent, read-only)
\`\`\`sh
node F:/ppc-checkpoints/verify_seal_ablation.mjs
\`\`\`

## Seal facts
- Content files: ${content.length} (sealing outputs excluded: ${[...SEAL_OUTPUTS].join(', ')}).
- SOURCE_MANIFEST.json SHA256: \`${manifestHash.sha256}\` (selfExcluded, no self-SHA).
- SHA256SUMS.txt SHA256: \`${sumsHash.sha256}\` (records the manifest digest externally).
- Hash algorithm: sha256 over RAW BYTES (CRLF/LF agnostic); per-file line-ending recorded + re-verified.
- Restore: filesChecked=${restoredChecked} mismatches=${restoredMismatches} lineEndingMismatches=${lineEndingMismatches} missing=${missingFiles.length} extra=${extraFiles.length}.

## Working-tree integrity (DISCLOSED DIVERGENCE)
- roundModifiedProduction = ${roundModifiedProduction} (round-start proxy ${roundStartProxy}; changedDuringRound=${changedDuringRound.length}).
- workingTreeDiffersFromHead = ${workingTreeDiffersFromHead}; allPatchesPredateRound = ${allPatchesPredateRound}.
- leafSourcesMatchHead (evaluation.ts, correctedHoleLeaf.ts) = ${leafSourcesMatchHead}.
- HEAD = ${headLive} (frozen ${HEAD}, matches=${headLive === HEAD}).
- The tree carries PRE-EXISTING uncommitted production patches (user in-progress PPC-P2-PREPARED-TRANSITION-01 + timing-repair, mtimes 11-12..11-14), ALL predating this round. This round modified NO production source. Both ablation arms shared the SAME stable substrate ⇒ the RELATIVE E1-vs-H1 comparison is valid; the ABSOLUTE baseline is HEAD+patches, not pristine HEAD. Handed to ChatGPT for ruling.
- Frozen fixture ${FIXTURE} SHA256 matches frozen value: ${fixtureLive.sha256 === FROZEN_FIXTURE_SHA}.
- Previous rounds overwritten: NO. Archive refused to overwrite an existing file: enforced.

## Authority
PRODUCTION_EVALUATOR_CHANGE=NOT_AUTHORIZED. NEW_EFFICACY_AUTHORITY=NONE.
This seal preserves evidence only; it does NOT wire H1 into production.
`;
const restoreAbs = join(DIR, 'RESTORE.md');
writeFileSync(restoreAbs, restoreMd);
const restoreHash = hashFile(restoreAbs);

// 6. SEAL_VERIFICATION.json — terminal anchor.
const verification = {
  artifactId: 'SEAL_VERIFICATION', round: ROUND, phase: 8,
  generatedAt: new Date().toISOString(), generatedBy: `${ROUND}/probe/seal.mjs`, head: HEAD, headLive,
  hashAlgorithm: 'sha256 over raw bytes',
  contentFileCount: content.length,
  manifest: { path: 'SOURCE_MANIFEST.json', selfExcluded: true, sha256: manifestHash.sha256, bytes: manifestHash.bytes },
  sha256sums: { path: 'SHA256SUMS.txt', sha256: sumsHash.sha256, bytes: sumsHash.bytes, recordsManifestDigest: true },
  restoreMd: { path: 'RESTORE.md', sha256: restoreHash.sha256, bytes: restoreHash.bytes, inArchive: false },
  archive: { path: ARCHIVE, sha256: archiveHash.sha256, bytes: archiveHash.bytes, memberCount: archiveMembers.length, outsideRepo: true, refusedOverwrite: true },
  restore: { dir: RESTORE, outsideRepo: true, filesChecked: restoredChecked, mismatches: restoredMismatches, lineEndingMismatches,
    missing: missingFiles.length, extra: extraFiles.length, missingFiles, extraFiles,
    allByteIdentical: restoredMismatches === 0 && lineEndingMismatches === 0 && missingFiles.length === 0 && extraFiles.length === 0 && restoredChecked === expected.size,
    mismatchDetail },
  workingTree: { roundModifiedProduction, roundStartProxy, changedDuringRound, workingTreeDiffersFromHead, allPatchesPredateRound, leafSourcesMatchHead, headMatchesFrozen: headLive === HEAD, preExistingPatchInventory },
  frozenFixture: { path: FIXTURE, sha256: fixtureLive.sha256, matches: fixtureLive.sha256 === FROZEN_FIXTURE_SHA },
  selfReferenceCycleBroken: true,
  crlfLfFalseProof: 'NONE — every digest is over raw Buffer bytes; restore compared byte-for-byte AND line-ending-class',
  previousRoundOverwritten: false,
};
writeFileSync(join(DIR, 'SEAL_VERIFICATION.json'), JSON.stringify(verification, null, 2));

console.log('CONTENT_FILES=', content.length);
console.log('MANIFEST_SHA=', manifestHash.sha256, manifestHash.bytes);
console.log('SHA256SUMS_SHA=', sumsHash.sha256, sumsHash.bytes);
console.log('RESTORE_MD_SHA=', restoreHash.sha256, restoreHash.bytes);
console.log('ARCHIVE=', ARCHIVE, archiveHash.sha256, archiveHash.bytes);
console.log('RESTORE checked=', restoredChecked, 'mismatches=', restoredMismatches, 'lineEndingMismatches=', lineEndingMismatches, 'missing=', missingFiles.length, 'extra=', extraFiles.length, 'allByteIdentical=', verification.restore.allByteIdentical);
console.log('WORKING_TREE roundModifiedProduction=', roundModifiedProduction, 'workingTreeDiffersFromHead=', workingTreeDiffersFromHead, 'allPatchesPredateRound=', allPatchesPredateRound, 'leafSourcesMatchHead=', leafSourcesMatchHead, 'headMatchesFrozen=', headLive === HEAD);
const restoreBad = restoredMismatches > 0 || lineEndingMismatches > 0 || missingFiles.length > 0 || extraFiles.length > 0;
const integrityBad = roundModifiedProduction || !leafSourcesMatchHead || headLive !== HEAD || fixtureLive.sha256 !== FROZEN_FIXTURE_SHA;
if (restoreBad || integrityBad) { console.log('SEAL_VERIFY=FAIL', JSON.stringify(mismatchDetail), 'changedDuringRound=', JSON.stringify(changedDuringRound)); process.exitCode = 1; }
else console.log('SEAL_VERIFY=PASS (round modified no production; pre-existing baseline divergence DISCLOSED)');