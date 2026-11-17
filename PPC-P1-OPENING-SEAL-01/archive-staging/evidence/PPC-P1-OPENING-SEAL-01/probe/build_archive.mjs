/**
 * PPC-P1-OPENING-SEAL-01 — archive builder.
 *
 * Produces a NEW archive next to (never over) the two prior candidates. It holds
 * the resealed test file's bytes, the corrected RESTORE.md, and this round's
 * sealing evidence.
 *
 * Layout:
 *   RESTORE.md                 corrected restore order (supersedes the note in
 *                              the OPENING-STACK-01 archive)
 *   CHECKPOINT_MANIFEST.json   member list with sha256 / bytes / EOL
 *   files/src/...              the ONE source overlay this round reseals
 *   evidence/PPC-P1-OPENING-SEAL-01/...  report, manifests, probe, logs, raw
 *
 * The archive's own sha256 cannot live inside itself, so it is written to the
 * repo-side ARCHIVE_SHA256.txt after packaging.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROUND = 'PPC-P1-OPENING-SEAL-01';
const STAGE = path.join(ROUND, 'archive-staging');
const OUT_DIR = 'F:/ppc-checkpoints';
const OUT = `${OUT_DIR}/${ROUND}-candidate.tar.gz`;
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const eolOf = (buf) => {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 13) { if (buf[i + 1] === 10) crlf++; else cr++; }
    else if (buf[i] === 10 && buf[i - 1] !== 13) lf++;
  }
  return crlf > 0 && lf === 0 && cr === 0 ? 'CRLF' : crlf === 0 && cr === 0 ? 'LF' : 'MIXED';
};

// (repoPath, archivePath, kind)
const MEMBERS = [
  [`${ROUND}/RESTORE.md`, 'RESTORE.md', 'restore-instructions-corrected'],
  ['src/game/__tests__/openingFairnessStackSafety.test.ts', 'files/src/game/__tests__/openingFairnessStackSafety.test.ts', 'test-source-resealed'],
  [`${ROUND}/REPORT.md`, `evidence/${ROUND}/REPORT.md`, 'report'],
  [`${ROUND}/SOURCE_MANIFEST.json`, `evidence/${ROUND}/SOURCE_MANIFEST.json`, 'manifest'],
  [`${ROUND}/EVIDENCE_CORRECTIONS.json`, `evidence/${ROUND}/EVIDENCE_CORRECTIONS.json`, 'correction'],
  [`${ROUND}/probe/build_source_manifest.mjs`, `evidence/${ROUND}/probe/build_source_manifest.mjs`, 'probe'],
  [`${ROUND}/probe/verify_restore.mjs`, `evidence/${ROUND}/probe/verify_restore.mjs`, 'probe'],
  [`${ROUND}/probe/build_archive.mjs`, `evidence/${ROUND}/probe/build_archive.mjs`, 'probe'],
  [`${ROUND}/_raw/pre_state.json`, `evidence/${ROUND}/_raw/pre_state.json`, 'raw'],
  [`${ROUND}/_raw/status_seal.txt`, `evidence/${ROUND}/_raw/status_seal.txt`, 'raw'],
  [`${ROUND}/_raw/from_archive/DEEP_STACK_RESULTS.pre_seal.json`, `evidence/${ROUND}/_raw/from_archive/DEEP_STACK_RESULTS.pre_seal.json`, 'raw'],
];
// The restore-verification transcripts are deliberately NOT members: each run
// rewrites its own transcript, so packing one would make the archive describe a
// slightly different archive on every rebuild. They stay repo-side next to
// RESTORE_VERIFICATION.json, and the verifier is re-runnable at any time.
for (const f of readdirSync(`${ROUND}/logs`)) {
  if (/restore/i.test(f)) continue;
  MEMBERS.push([`${ROUND}/logs/${f}`, `evidence/${ROUND}/logs/${f}`, 'log']);
}

const missing = MEMBERS.filter(([repo]) => !existsSync(repo));
if (missing.length) {
  console.error('MISSING BEFORE ARCHIVE: ' + missing.map((m) => m[0]).join(', '));
  process.exit(1);
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const entries = [];
for (const [repo, archivePath, kind] of MEMBERS) {
  const dest = path.join(STAGE, archivePath);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(repo, dest);
  const buf = readFileSync(dest);
  entries.push({ repoPath: repo, archivePath, kind, sha256: sha256(dest), bytes: buf.length, lineEnding: eolOf(buf) });
}

const manifest = {
  artifactId: 'OPENING_SEAL_ARCHIVE_MANIFEST',
  round: ROUND,
  base: {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    checkpoint01: { path: 'F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz', sha256: sha256('F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz'), overwritten: false },
    openingStack01: { path: 'F:/ppc-checkpoints/PPC-P1-OPENING-STACK-01-candidate.tar.gz', sha256: sha256('F:/ppc-checkpoints/PPC-P1-OPENING-STACK-01-candidate.tar.gz'), overwritten: false },
  },
  selfContained: false,
  selfContainedNote:
    'Only this round\'s resealed test bytes + sealing evidence. Rebuilding the candidate needs the base commit and the two prior archives; see RESTORE.md.',
  archiveSha256Location:
    'Not inside this archive (a package cannot contain its own hash). Recorded in PPC-P1-OPENING-SEAL-01/ARCHIVE_SHA256.txt after packaging, and re-derivable with sha256sum.',
  excludedOnPurpose: {
    'RESTORE_VERIFICATION.json': 'output of the verifier run against the shipped archive; regenerated on demand, embedding it would make the archive hash depend on a verification of itself',
    'logs/*restore*': 'restore-verification transcripts; kept repo-side because each run rewrites its own transcript, which would make the archive describe a different archive on every rebuild',
    'archive-staging/': 'the staging copy of these members',
  },
  members: entries,
  totals: {
    files: entries.length,
    bytes: entries.reduce((a, e) => a + e.bytes, 0),
    CRLF: entries.filter((e) => e.lineEnding === 'CRLF').length,
    LF: entries.filter((e) => e.lineEnding === 'LF').length,
  },
};
writeFileSync(path.join(STAGE, 'CHECKPOINT_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

mkdirSync(OUT_DIR, { recursive: true });
// Windows GNU tar reads `F:/...` as host:path; --force-local + POSIX separators.
execFileSync('tar', ['--force-local', '-czf', OUT, '-C', STAGE.replace(/\\/g, '/'), '.'], { stdio: 'inherit' });

const members = execFileSync('tar', ['--force-local', '-tzf', OUT], { encoding: 'utf8' })
  .split('\n').filter((l) => l && !l.endsWith('/')).length;
writeFileSync(`${ROUND}/ARCHIVE_SHA256.txt`, [
  `path   = ${OUT}`,
  `sha256 = ${sha256(OUT)}`,
  `bytes  = ${statSync(OUT).size}`,
  `members(regular files, excludes directories) = ${members}`,
  `manifest members = ${entries.length} (+ CHECKPOINT_MANIFEST.json itself)`,
  `computed = ${new Date().toISOString()}`,
  '',
].join('\n'));

console.log(`staged files=${entries.length} bytes=${manifest.totals.bytes} (CRLF ${manifest.totals.CRLF} / LF ${manifest.totals.LF})`);
console.log(`archive=${OUT} bytes=${statSync(OUT).size} members=${members} sha256=${sha256(OUT)}`);
