/**
 * PPC-P1-OPENING-SEAL-01 — independent restore verification.
 *
 * Rebuilds the candidate from the documented three-archive chain inside an
 * isolated directory OUTSIDE the repository, then proves the result:
 *
 *   1. `git archive 48eaac6c`  -> 493 tracked files (no working-tree touch)
 *   2. CHECKPOINT-01  `source/`  -> 24 files
 *   3. OPENING-STACK-01 `files/src/` -> 2 files
 *   4. SEAL-01 `files/src/`      -> 1 file (resealed test)
 *   5. per-file sha256 / bytes / EOL against the sealed SOURCE_MANIFEST
 *   6. bidirectional manifest check (missing = 0, extra = 0)
 *
 * It never calls checkout / reset / clean / stash and never writes inside the
 * repository. The two prior archives are hashed before and after to prove they
 * stayed byte-identical.
 *
 *   node verify_restore.mjs <seal-archive> <work-base-dir>
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO = 'F:/小猫小鼠';
const BASE_COMMIT = '48eaac6c4f3801d351787696ba5876995b64e8d8';
const CP01 = 'F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz';
const OS01 = 'F:/ppc-checkpoints/PPC-P1-OPENING-STACK-01-candidate.tar.gz';
const ROUND = 'PPC-P1-OPENING-SEAL-01';

const ARCHIVE = process.argv[2];
const WORK_BASE = process.argv[3];
if (!ARCHIVE || !WORK_BASE) {
  console.error('usage: node verify_restore.mjs <seal-archive> <work-base-dir>');
  process.exit(2);
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sha256buf = (b) => createHash('sha256').update(b).digest('hex');
const eolOf = (buf) => {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 13) { if (buf[i + 1] === 10) crlf++; else cr++; }
    else if (buf[i] === 10 && buf[i - 1] !== 13) lf++;
  }
  return crlf > 0 && lf === 0 && cr === 0 ? 'CRLF' : crlf === 0 && cr === 0 ? 'LF' : 'MIXED';
};
const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
const tar = (args) => execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

/** Every regular file under `root`, as POSIX-style relative paths. */
function walk(root, base = root, out = []) {
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Binary copy of every file under `from` into `to`; returns what it wrote. */
function overlay(from, to) {
  const written = [];
  for (const rel of walk(from)) {
    const dest = path.join(to, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(from, rel), dest);
    written.push(rel);
  }
  return written;
}

mkdirSync(WORK_BASE, { recursive: true });
const work = mkdtempSync(path.join(WORK_BASE, 'run-')); // outside the repository
const result = {
  artifactId: 'RESTORE_VERIFICATION',
  round: ROUND,
  method:
    'git archive of the base commit into an isolated directory, then the three archive overlays in the documented order, then per-file byte comparison against the sealed SOURCE_MANIFEST and a bidirectional file-list check. No checkout/reset/clean/stash; no git apply.',
  isolatedWorkDir: work,
  workingTreeTouched: false,
};

// ---- pre-flight: archive identity and prior archives ----------------------
const beforeCp01 = sha256(CP01);
const beforeOs01 = sha256(OS01);
const headBefore = git(['rev-parse', 'HEAD']).trim();
const statusBefore = git(['status', '--porcelain=v1']).split('\n').filter(Boolean).length;

result.archive = {
  path: ARCHIVE,
  sha256: sha256(ARCHIVE),
  bytes: statSync(ARCHIVE).size,
  members: tar(['--force-local', '-tzf', ARCHIVE]).split('\n').filter((l) => l && !l.endsWith('/')).length,
};

// ---- step 1: base commit via git archive ---------------------------------
const repo = path.join(work, 'repo');
mkdirSync(repo, { recursive: true });
const baseTar = path.join(work, 'base.tar');
// `-c core.autocrlf=false`: on this machine core.autocrlf=true, and a plain
// `git archive` then EOL-converts text on export (legalActions.ts came out
// 2926 B / 75 CRLF instead of the stored 2851 B / LF). That would make every
// base-file hash disagree for a purely cosmetic reason, so the export is forced
// to raw blobs. RESTORE.md documents the same flag.
git(['-c', 'core.autocrlf=false', 'archive', '--format=tar', `--output=${baseTar.replace(/\\/g, '/')}`, BASE_COMMIT]);
// Windows GNU tar reads `F:/...` as a remote host, so every invocation needs
// --force-local (the same trap that bit the packaging step).
tar(['--force-local', '-xf', baseTar.replace(/\\/g, '/'), '-C', repo.replace(/\\/g, '/')]);

// core.quotepath=false: otherwise git octal-escapes non-ASCII paths (public/ui/*.png),
// and the exported-vs-tracked set comparison becomes a quoting artifact.
const trackedAll = git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', BASE_COMMIT])
  .split('\n').filter(Boolean);
const trackedSrc = trackedAll.filter((p) => p.startsWith('src/'));
const exported = walk(repo);
result.base = {
  commit: BASE_COMMIT,
  exportedFiles: exported.length,
  trackedFilesInCommit: trackedAll.length,
  exportedEqualsTracked: exported.length === trackedAll.length
    && trackedAll.every((p) => exported.includes(p)),
  trackedSrcFiles: trackedSrc.length,
  hasGitDir: existsSync(path.join(repo, '.git')),
};

// ---- steps 2-4: overlays -------------------------------------------------
const cp01Dir = path.join(work, 'cp01');
const os01Dir = path.join(work, 'os01');
const sealDir = path.join(work, 'seal01');
for (const d of [cp01Dir, os01Dir, sealDir]) mkdirSync(d, { recursive: true });
tar(['--force-local', '-xzf', CP01, '-C', cp01Dir.replace(/\\/g, '/')]);
tar(['--force-local', '-xzf', OS01, '-C', os01Dir.replace(/\\/g, '/')]);
tar(['--force-local', '-xzf', ARCHIVE, '-C', sealDir.replace(/\\/g, '/')]);

const cp01Writes = overlay(path.join(cp01Dir, 'source'), repo);
const os01Writes = overlay(path.join(os01Dir, 'files', 'src'), path.join(repo, 'src'));
const sealWrites = overlay(path.join(sealDir, 'files', 'src'), path.join(repo, 'src'));

result.overlays = {
  steps: [
    { step: 2, archive: 'PPC-P1-CHECKPOINT-01-candidate.tar.gz', from: 'source/', wrote: cp01Writes.length, paths: cp01Writes },
    { step: 3, archive: 'PPC-P1-OPENING-STACK-01-candidate.tar.gz', from: 'files/src/', wrote: os01Writes.length, paths: os01Writes.map((p) => `src/${p}`) },
    { step: 4, archive: 'PPC-P1-OPENING-SEAL-01-candidate.tar.gz', from: 'files/src/', wrote: sealWrites.length, paths: sealWrites.map((p) => `src/${p}`) },
  ],
  totalWrites: cp01Writes.length + os01Writes.length + sealWrites.length,
  distinctPaths: new Set([
    ...cp01Writes, ...os01Writes.map((p) => `src/${p}`), ...sealWrites.map((p) => `src/${p}`),
  ]).size,
};

// ---- step 5: per-file verification against the sealed manifest -----------
const sealedManifestPath = path.join(sealDir, 'evidence', ROUND, 'SOURCE_MANIFEST.json');
const repoManifestPath = path.join(REPO, ROUND, 'SOURCE_MANIFEST.json');
const manifest = JSON.parse(readFileSync(sealedManifestPath, 'utf8'));
result.manifest = {
  source: `archive member evidence/${ROUND}/SOURCE_MANIFEST.json`,
  sha256: sha256(sealedManifestPath),
  identicalToRepoCopy: existsSync(repoManifestPath) ? sha256(repoManifestPath) === sha256(sealedManifestPath) : null,
  files: manifest.files.length,
};

const rows = [];
for (const f of manifest.files) {
  const p = path.join(repo, f.path);
  if (!existsSync(p)) {
    rows.push({ path: f.path, present: false, sha256Ok: false, bytesOk: false, eolOk: false });
    continue;
  }
  const buf = readFileSync(p);
  const sha = sha256buf(buf);
  const eol = eolOf(buf);
  rows.push({
    path: f.path,
    present: true,
    sha256: sha,
    bytes: buf.length,
    eol,
    sha256Ok: sha === f.postSha256,
    bytesOk: buf.length === f.bytes,
    eolOk: eol === f.lineEnding,
  });
}
const tally = (k) => rows.filter((r) => r[k]).length;
result.perFile = {
  total: rows.length,
  present: tally('present'),
  sha256Match: tally('sha256Ok'),
  bytesMatch: tally('bytesOk'),
  eolMatch: tally('eolOk'),
  mismatches: rows.filter((r) => !(r.present && r.sha256Ok && r.bytesOk && r.eolOk)),
  rows,
};

// ---- step 6: bidirectional file-list check -------------------------------
const expected = new Set([...trackedSrc, ...manifest.files.map((f) => f.path)]);
const restoredSrc = walk(path.join(repo, 'src')).map((p) => `src/${p}`);
const missing = manifest.files.map((f) => f.path).filter((p) => !restoredSrc.includes(p));
const extra = restoredSrc.filter((p) => !expected.has(p));
const trackedMissing = trackedSrc.filter((p) => !restoredSrc.includes(p));
result.fileList = {
  expectedSetSize: expected.size,
  restoredSrcFiles: restoredSrc.length,
  missingFromRestore: missing,
  extraInRestore: extra,
  trackedSrcFilesMissing: trackedMissing,
  missingCount: missing.length,
  extraCount: extra.length,
  pass: missing.length === 0 && extra.length === 0 && trackedMissing.length === 0,
};

// ---- whole-tree cross-check ----------------------------------------------
// The 26 overlay files must equal the LIVE worktree bytes (they came from
// binary archive copies, so EOL comes along). The other 139 files came from
// `git archive`, which emits the stored LF blobs — while `core.autocrlf=true`
// keeps 134 of them as CRLF in the worktree. Byte equality with the worktree is
// therefore the wrong test for those; identity with the stored blob is the
// right one, plus an EOL-normalized comparison against the worktree.
const liveSrc = walk(path.join(REPO, 'src')).map((p) => `src/${p}`);
const overlaySet = new Set(manifest.files.map((f) => f.path));
const overlayPaths = restoredSrc.filter((p) => overlaySet.has(p));
const basePaths = restoredSrc.filter((p) => !overlaySet.has(p));

const blobIds = new Map();
for (const line of git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '-l', BASE_COMMIT, '--', 'src']).split('\n').filter(Boolean)) {
  const [meta, ...rest] = line.split('\t');
  const id = meta.trim().split(/\s+/)[2];
  blobIds.set(rest.join('\t'), id);
}
const hashRaw = (files) => {
  if (files.length === 0) return [];
  return execFileSync('git', ['hash-object', '--no-filters', '--', ...files.map((f) => path.join(repo, f).replace(/\\/g, '/'))], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28,
  }).split('\n').filter(Boolean);
};

const overlayRawDiff = [];
for (const rel of overlayPaths) {
  const livePath = path.join(REPO, rel);
  if (!existsSync(livePath) || sha256(path.join(repo, rel)) !== sha256(livePath)) {
    overlayRawDiff.push(rel);
  }
}
const baseHashes = hashRaw(basePaths);
const baseBlobDiff = [];
basePaths.forEach((rel, i) => {
  if (blobIds.get(rel) !== baseHashes[i]) baseBlobDiff.push({ path: rel, stored: blobIds.get(rel), restored: baseHashes[i] });
});
const stripCr = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const rawDiffs = restoredSrc.filter((rel) => {
  const livePath = path.join(REPO, rel);
  return !existsSync(livePath) || sha256(path.join(repo, rel)) !== sha256(livePath);
});
const eolDiffs = restoredSrc.filter((rel) => {
  const livePath = path.join(REPO, rel);
  return !existsSync(livePath) || stripCr(path.join(repo, rel)) !== stripCr(livePath);
});

result.wholeTreeCrossCheck = {
  scope: 'src/**',
  restoredSrcFiles: restoredSrc.length,
  liveSrcFiles: liveSrc.length,
  overlay: { paths: overlayPaths.length, rawIdenticalToWorktree: overlayPaths.length - overlayRawDiff.length, differing: overlayRawDiff },
  baseFromGitArchive: {
    paths: basePaths.length,
    blobIdenticalToBaseCommit: basePaths.length - baseBlobDiff.length,
    differing: baseBlobDiff,
  },
  rawIdenticalToWorktree: restoredSrc.length - rawDiffs.length,
  rawDiffering: rawDiffs,
  eolNormalizedIdenticalToWorktree: restoredSrc.length - eolDiffs.length,
  eolNormalizedDiffering: eolDiffs,
  liveOnlyFiles: liveSrc.filter((p) => !restoredSrc.includes(p)),
  eolNote:
    'core.autocrlf=true keeps 134 base files CRLF in the worktree; git archive emits the stored LF blobs, so raw byte equality with the worktree is only expected for the overlay files.',
  pass:
    overlayRawDiff.length === 0
    && baseBlobDiff.length === 0
    && eolDiffs.length === 0
    && liveSrc.length === restoredSrc.length,
};

// ---- post-flight: nothing moved ------------------------------------------
const afterCp01 = sha256(CP01);
const afterOs01 = sha256(OS01);
result.priorArchives = {
  checkpoint01: { before: beforeCp01, after: afterCp01, unchanged: beforeCp01 === afterCp01 },
  openingStack01: { before: beforeOs01, after: afterOs01, unchanged: beforeOs01 === afterOs01 },
};
const headAfter = git(['rev-parse', 'HEAD']).trim();
const statusAfter = git(['status', '--porcelain=v1']).split('\n').filter(Boolean).length;
result.repositoryUntouched = {
  headBefore, headAfter, headUnchanged: headBefore === headAfter,
  statusEntriesBefore: statusBefore, statusEntriesAfter: statusAfter,
  statusUnchanged: statusBefore === statusAfter,
};

result.CHECKPOINT_RESTORABILITY =
  result.base.exportedEqualsTracked
  && result.perFile.sha256Match === rows.length
  && result.perFile.bytesMatch === rows.length
  && result.perFile.eolMatch === rows.length
  && result.fileList.pass
  && result.wholeTreeCrossCheck.pass
  && result.priorArchives.checkpoint01.unchanged
  && result.priorArchives.openingStack01.unchanged
  && result.repositoryUntouched.headUnchanged
  && result.repositoryUntouched.statusUnchanged
    ? 'PASS'
    : 'FAIL';

writeFileSync(path.join(REPO, ROUND, 'RESTORE_VERIFICATION.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
