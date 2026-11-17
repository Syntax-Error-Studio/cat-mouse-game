/**
 * PPC-P1-OPENING-STACK-01 — independent restore verification.
 *
 * Extracts the versioned archive into a fresh temp directory OUTSIDE the repo,
 * then checks every member against the manifest: byte SHA-256, byte length, line
 * endings, and an exact two-way file-list comparison. It never touches the real
 * worktree and never uses `git apply` (which silently no-ops in this repo).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ARCHIVE = process.argv[2];
const BASE = process.argv[3] ?? 'F:/ppc-checkpoints/restore-verify-opening-stack';
if (!ARCHIVE) {
  console.error('usage: node verify_restore.mjs <archive.tar.gz> [baseDir]');
  process.exit(2);
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const eol = (p) => {
  const b = readFileSync(p);
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 13) { if (b[i + 1] === 10) crlf++; else cr++; }
    else if (b[i] === 10 && b[i - 1] !== 13) lf++;
  }
  return crlf > 0 && lf === 0 && cr === 0 ? 'CRLF' : crlf === 0 && cr === 0 ? 'LF' : 'MIXED';
};

mkdirSync(BASE, { recursive: true });
const dest = mkdtempSync(path.join(BASE, 'restore-'));
console.log('archive      =', ARCHIVE);
console.log('archiveBytes =', statSync(ARCHIVE).size);
console.log('archiveSha256=', sha256(ARCHIVE));
console.log('extractTo    =', dest);

execFileSync('tar', ['--force-local', '-xzf', ARCHIVE.replace(/\\/g, '/'), '-C', dest.replace(/\\/g, '/')], { stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(path.join(dest, 'CHECKPOINT_MANIFEST.json'), 'utf8'));

const seen = [];
function walk(dir, rel = '') {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) walk(abs, r);
    else seen.push(r);
  }
}
walk(dest);

const expected = new Set(manifest.members.map((m) => m.archivePath).concat(['CHECKPOINT_MANIFEST.json', 'RESTORE.md']));
const missing = [...expected].filter((p) => !seen.includes(p));
const extra = seen.filter((p) => !expected.has(p));

let shaOk = 0, shaBad = [];
let bytesOk = 0, bytesBad = [];
let eolOk = 0, eolBad = [];
for (const m of manifest.members) {
  const p = path.join(dest, m.archivePath);
  const gotSha = sha256(p);
  const gotBytes = statSync(p).size;
  const gotEol = eol(p);
  if (gotSha === m.sha256) shaOk++; else shaBad.push({ path: m.repoPath, got: gotSha, want: m.sha256 });
  if (gotBytes === m.bytes) bytesOk++; else bytesBad.push({ path: m.repoPath, got: gotBytes, want: m.bytes });
  if (gotEol === m.lineEnding) eolOk++; else eolBad.push({ path: m.repoPath, got: gotEol, want: m.lineEnding });
}

// The two source files must also match the CURRENT worktree, byte for byte.
const worktreeCheck = manifest.members
  .filter((m) => m.kind === 'production-changed' || m.kind === 'test-new')
  .map((m) => {
    const got = sha256(m.repoPath);
    return { path: m.repoPath, archive: m.sha256, worktree: got, equal: got === m.sha256 };
  });

const result = {
  artifactId: 'RESTORE_VERIFICATION',
  round: 'PPC-P1-OPENING-STACK-01',
  archive: ARCHIVE,
  archiveBytes: statSync(ARCHIVE).size,
  archiveSha256: sha256(ARCHIVE),
  extractedTo: dest,
  method: 'tar -xzf into a fresh mkdtemp OUTSIDE the repository, then byte-level comparison against CHECKPOINT_MANIFEST.json. `git apply` is deliberately NOT used: in this repo it can report success while doing nothing.',
  members: manifest.members.length,
  sha256: { ok: shaOk, bad: shaBad },
  bytes: { ok: bytesOk, bad: bytesBad },
  lineEndings: { ok: eolOk, bad: eolBad },
  fileList: { expected: expected.size, found: seen.length, missing, extra },
  worktreeEquality: worktreeCheck,
  worktreeTouched: false,
  CHECKPOINT_RESTORABILITY:
    shaBad.length === 0 && bytesBad.length === 0 && eolBad.length === 0
    && missing.length === 0 && extra.length === 0 && worktreeCheck.every((w) => w.equal)
      ? 'PASS' : 'FAIL',
};
console.log(JSON.stringify(result, null, 2));
