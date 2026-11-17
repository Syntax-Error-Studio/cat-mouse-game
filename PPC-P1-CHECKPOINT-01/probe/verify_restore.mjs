// PPC-P1-CHECKPOINT-01 · CP-5/CP-6 — independent restore verification.
//
// Extracts the archive into a throwaway directory OUTSIDE the repository, then
// checks: every member present, byte length, sha256, line endings, no extra or
// missing files, and — separately — that the extracted source is identical to
// the working tree that the regression run actually tests.
//
// It never writes inside the repository working tree (the .json result is the
// only write, and it is a report, not source).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const ARCHIVE = process.argv[2];
const EXTRACT_BASE = process.argv[3] ?? path.join(os.tmpdir(), 'ppc-restore');

if (!ARCHIVE || !existsSync(ARCHIVE)) {
  console.error('usage: node verify_restore.mjs <archive.tar.gz> [extractBaseDir]');
  process.exit(2);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
function eolOf(buf) {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 13) { if (buf[i + 1] === 10) crlf++; else cr++; }
    else if (c === 10 && buf[i - 1] !== 13) lf++;
  }
  if (crlf > 0 && lf === 0 && cr === 0) return 'CRLF';
  if (crlf === 0 && cr === 0) return 'LF';
  return 'MIXED';
}
function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, acc); else acc.push(abs);
  }
  return acc;
}

mkdirSync(EXTRACT_BASE, { recursive: true });
const dest = mkdtempSync(path.join(EXTRACT_BASE, 'restore-'));
const toUnix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);

console.log('archive      =', ARCHIVE);
console.log('archiveSha256=', sha256(readFileSync(ARCHIVE)), 'bytes=' + statSync(ARCHIVE).size);
console.log('extractTo    =', dest);

// GNU tar on MSYS treats `F:/...` as a remote host — hand it POSIX paths only.
execFileSync('tar', ['-xzf', toUnix(ARCHIVE), '-C', toUnix(dest)], { stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(path.join(dest, 'CHECKPOINT_MANIFEST.json'), 'utf8'));
console.log('manifestMembers =', manifest.members.length);

const failures = [];
let ok = 0;
for (const m of manifest.members) {
  const abs = path.join(dest, m.archivePath);
  if (!existsSync(abs)) { failures.push({ archivePath: m.archivePath, problem: 'MISSING' }); continue; }
  const buf = readFileSync(abs);
  const problems = [];
  if (buf.length !== m.bytes) problems.push(`bytes ${buf.length} != ${m.bytes}`);
  const h = sha256(buf);
  if (h !== m.sha256) problems.push(`sha256 ${h.slice(0, 12)}… != ${m.sha256.slice(0, 12)}…`);
  if (eolOf(buf) !== m.eol) problems.push(`eol ${eolOf(buf)} != ${m.eol}`);
  if (problems.length) failures.push({ archivePath: m.archivePath, problem: problems.join('; ') });
  else ok++;
}

// --- no extras / no missing ---
const onDisk = walk(dest)
  .map((a) => path.relative(dest, a).split(path.sep).join('/'))
  .filter((p) => p !== 'CHECKPOINT_MANIFEST.json');
const listed = new Set(manifest.members.map((m) => m.archivePath));
const extras = onDisk.filter((p) => !listed.has(p));
const missing = [...listed].filter((p) => !onDisk.includes(p));

// --- does the archive reproduce the tree that regression tests? ---
const treeMismatch = [];
let treeMatched = 0;
for (const m of manifest.members) {
  if (!m.repoPath) continue;
  const live = path.join(ROOT, m.repoPath);
  if (!existsSync(live)) { treeMismatch.push({ repoPath: m.repoPath, problem: 'ABSENT_IN_WORKTREE' }); continue; }
  const h = sha256(readFileSync(live));
  if (h === m.sha256) treeMatched++;
  else treeMismatch.push({ repoPath: m.repoPath, problem: 'WORKTREE_DIFFERS', worktreeSha256: h, archiveSha256: m.sha256 });
}

const result = {
  artifactId: 'RESTORE_VERIFICATION',
  round: 'PPC-P1-CHECKPOINT-01',
  verifiedAt: new Date().toISOString(),
  archive: { path: ARCHIVE, sha256: sha256(readFileSync(ARCHIVE)), bytes: statSync(ARCHIVE).size },
  extractedTo: dest,
  method:
    'tar -xzf into a fresh mkdtemp directory outside the repository; per-file sha256/bytes/EOL compared against CHECKPOINT_MANIFEST.json; file-list equality checked both ways. NO git apply, NO git write command, NO touch of the working tree.',
  manifestMembers: manifest.members.length,
  byteExactMatches: ok,
  failures,
  extras,
  missing,
  archiveEqualsWorktree: { matched: treeMatched, mismatched: treeMismatch.length, detail: treeMismatch },
  eolPreserved: manifest.members.filter((m) => m.eol === 'CRLF').map((m) => m.archivePath),
  verdict: failures.length === 0 && extras.length === 0 && missing.length === 0 && treeMismatch.length === 0
    ? 'PASS' : 'FAIL',
};

writeFileSync('PPC-P1-CHECKPOINT-01/RESTORE_VERIFICATION.json', JSON.stringify(result, null, 2) + '\n');

console.log('--- verification ---');
console.log('byte-exact matches =', ok, '/', manifest.members.length);
console.log('failures           =', failures.length);
console.log('extras             =', extras.length);
console.log('missing            =', missing.length);
console.log('archive == worktree=', treeMatched, 'matched /', treeMismatch.length, 'mismatched');
console.log('CRLF members       =', result.eolPreserved.length, result.eolPreserved);
console.log('VERDICT            =', result.verdict);

// keep the extraction for inspection; the caller decides when to drop it
console.log('NOTE: extraction kept at', dest);
