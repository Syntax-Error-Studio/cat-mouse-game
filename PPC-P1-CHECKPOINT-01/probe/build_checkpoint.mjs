// PPC-P1-CHECKPOINT-01 · CP-4/CP-5/CP-6 — build a restorable byte-level checkpoint.
// Copies real bytes (never patch references), records every member's sha256/bytes/EOL,
// then reports so that a separate verifier can compare an independent extraction.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = 'PPC-P1-CHECKPOINT-01/checkpoint';
const STAGE = path.join(ROOT, OUT);

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
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
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

// ---- reset the staging area (only the untracked staging dir we own) ----
if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const members = []; // { archivePath, repoPath, kind }

// A) candidate source: every modified tracked file + every untracked src/ file
const integrity = JSON.parse(readFileSync('PPC-P1-CHECKPOINT-01/_raw/source_integrity.json', 'utf8'));
for (const f of integrity.files) members.push({ repoPath: f.path, archivePath: `source/${f.path}`, kind: f.tracked ? 'source-modified' : 'source-new' });

// B) evidence archives from every earlier round of this line
const EVIDENCE_DIRS = [
  'PPC-P1-ID-01', 'PPC-P1-TIME-01', 'PPC-P1-TIME-02', 'PPC-P1-PLAN-01',
  'PPC-P1-QUALITY-01', 'PPC-P1-CLOSURE-01', 'PPC-P1-CLOSURE-FIX-01',
];
for (const d of EVIDENCE_DIRS) {
  if (!existsSync(d)) continue;
  for (const abs of walk(d)) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    members.push({ repoPath: rel, archivePath: `evidence/${rel}`, kind: 'evidence' });
  }
}

// C) git identity snapshot (text + the exact tracked diff at HEAD)
const GIT_DIR = path.join(STAGE, 'git');
mkdirSync(GIT_DIR, { recursive: true });
const gitSnapshots = {
  'HEAD.txt': git(['rev-parse', 'HEAD']),
  'head_commit.txt': git(['log', '-1', '--format=%H%n%an <%ae>%n%ci%n%s']),
  'branch.txt': git(['rev-parse', '--abbrev-ref', 'HEAD']),
  'core_autocrlf.txt': git(['config', '--get', 'core.autocrlf']),
  'status_porcelain.txt': git(['status', '--porcelain=v1']),
  'diff_stat.txt': git(['diff', '--stat']),
  'diff_name_status.txt': git(['diff', '--name-status']),
};
for (const [name, body] of Object.entries(gitSnapshots)) writeFileSync(path.join(GIT_DIR, name), body);
const trackedDiff = execFileSync('git', ['diff', '--binary'], { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
writeFileSync(path.join(GIT_DIR, 'tracked.diff.bin'), trackedDiff);

// ---- copy bytes ----
for (const m of members) {
  const dest = path.join(STAGE, m.archivePath);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(ROOT, m.repoPath), dest);
}

// ---- restore instructions (generated, archived and hashed like any other member) ----
const BASELINE = git(['rev-parse', 'HEAD']).trim();
const RESTORE_MD = `# PPC-P1-CHECKPOINT-01 — restore instructions

Baseline commit: \`${BASELINE}\`
Branch: \`${git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()}\`
\`core.autocrlf\` at capture time: \`${git(['config', '--get', 'core.autocrlf']).trim()}\`

## What this archive is

A byte-exact copy of the candidate DELTA over the baseline commit, plus every
evidence directory produced by this line of work (P1-ID / TIME-01 / TIME-02 /
PLAN-01 / QUALITY-01 / CLOSURE-01 / CLOSURE-FIX-01). It is **not** a full tree:
files this line never touched are not included.

## How to rebuild the candidate

1. Clone the repository and check out \`${BASELINE}\` (a clean tree, no local changes).
2. Extract this archive to any directory **outside** the clone.
3. Copy \`source/src/...\` over the clone, overwriting (bytes, not patches).
4. Verify every path in \`CHECKPOINT_MANIFEST.json\` hashes to its recorded
   \`sha256\` with the recorded byte length. Any mismatch = restore failed.
5. \`evidence/\` is documentation only; nothing in it is needed to build.
6. \`npx tsc -b\` and \`npx vitest run\` should then behave exactly as this round
   reported.

## Hard rules

* **Do not use \`git apply\` on this repository.** In this repo it prints
  \`Skipped patch\` for these paths and still exits 0 — a silent no-op. Copy bytes.
* **Do not normalise line endings.** \`src/game/engine.ts\` is CRLF; every other
  source member is LF. A CRLF/LF conversion changes \`sha256\`, so the restore
  check would fail (correctly).
* **Nothing here is committed.** The candidate lives in the working tree only;
  this archive is the only durable copy of it.
`;
writeFileSync(path.join(STAGE, 'RESTORE.md'), RESTORE_MD);
writeFileSync('PPC-P1-CHECKPOINT-01/RESTORE.md', RESTORE_MD);

// ---- manifest ----
const entries = members.map((m) => {
  const buf = readFileSync(path.join(STAGE, m.archivePath));
  return {
    archivePath: m.archivePath,
    repoPath: m.repoPath,
    kind: m.kind,
    sha256: sha256(buf),
    bytes: buf.length,
    eol: eolOf(buf),
  };
});

const restoreBuf = readFileSync(path.join(STAGE, 'RESTORE.md'));
entries.push({
  archivePath: 'RESTORE.md',
  repoPath: null,
  kind: 'restore-doc',
  sha256: sha256(restoreBuf),
  bytes: restoreBuf.length,
  eol: eolOf(restoreBuf),
});

const gitFiles = walk(GIT_DIR).map((abs) => {
  const buf = readFileSync(abs);
  return {
    archivePath: path.relative(STAGE, abs).split(path.sep).join('/'),
    repoPath: null,
    kind: 'git-snapshot',
    sha256: sha256(buf),
    bytes: buf.length,
    eol: eolOf(buf),
  };
});

const manifest = {
  artifactId: 'CHECKPOINT_MANIFEST',
  round: 'PPC-P1-CHECKPOINT-01',
  project: 'Project Perfect Cat',
  generatedAt: new Date().toISOString(),
  baseline: {
    commit: git(['rev-parse', 'HEAD']).trim(),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    coreAutocrlf: git(['config', '--get', 'core.autocrlf']).trim(),
    note: 'The archive holds the DELTA against this commit plus all evidence from this line of work. Files that this line never touched are NOT in the archive; they come from `git checkout <commit> -- .` on a clean clone.',
  },
  selfContained: false,
  selfContainedWhy:
    'Only modified/new source files are archived, not the whole tree. A full rebuild needs the repository at the baseline commit. Nothing else is required: no network, no generated artefact, no patch application.',
  restoreRecipe: [
    '1) git clone <repo> && git checkout ' + git(['rev-parse', 'HEAD']).trim(),
    '2) extract this archive to any directory OUTSIDE the clone',
    '3) copy <extract>/source/src/... over the clone (overwrite, byte for byte)',
    '4) verify: every file in CHECKPOINT_MANIFEST.json must hash to the recorded sha256',
    '5) evidence/ is documentation only — nothing in it is required to build',
    'WARNING: do NOT use `git apply` for this repository; it silently reports "Skipped patch" with exit 0 (see PPC-P1-CLOSURE-FIX-01 report, pitfall 2). Copy bytes instead.',
  ],
  eolContract:
    'Every member is stored with its exact on-disk bytes. src/game/engine.ts is CRLF; every other source file is LF. A restore that normalises line endings changes sha256 and must be treated as failed.',
  counts: {
    totalMembers: entries.length + gitFiles.length,
    sourceModified: entries.filter((e) => e.kind === 'source-modified').length,
    sourceNew: entries.filter((e) => e.kind === 'source-new').length,
    evidence: entries.filter((e) => e.kind === 'evidence').length,
    gitSnapshot: gitFiles.length,
  },
  members: [...entries, ...gitFiles],
};
writeFileSync(path.join(STAGE, 'CHECKPOINT_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync('PPC-P1-CHECKPOINT-01/CHECKPOINT_MANIFEST.json', JSON.stringify(manifest, null, 2) + '\n');

const totalBytes = manifest.members.reduce((a, b) => a + b.bytes, 0);
console.log('staged members =', manifest.counts.totalMembers);
console.log('  source modified =', manifest.counts.sourceModified);
console.log('  source new      =', manifest.counts.sourceNew);
console.log('  evidence files  =', manifest.counts.evidence);
console.log('  git snapshot    =', manifest.counts.gitSnapshot);
console.log('staged bytes   =', totalBytes, `(${(totalBytes / 1048576).toFixed(2)} MiB)`);
console.log('manifest sha   =', sha256(readFileSync(path.join(STAGE, 'CHECKPOINT_MANIFEST.json'))));
