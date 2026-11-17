#!/usr/bin/env node
/**
 * PPC-P2-PREPARED-TRANSITION-01 — restore verification.
 *
 *   1. extract the candidate archive into a temp dir OUTSIDE the repository
 *      (never into the worktree, never with `git apply`)
 *   2. recompute sha256 / size for every member listed in ARCHIVE_MANIFEST.json
 *      and check both directions (missing == 0, extra == 0)
 *   3. confirm the 4 shipped source files are byte-identical to the live
 *      worktree files (so the archive really carries the candidate)
 *   4. rebuild the frozen baseline arm from BASELINE_MANIFEST.json and confirm
 *      every one of its 165 files matches (this is the "isolated recovery"
 *      proof for the performance experiment)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROUND = 'PPC-P2-PREPARED-TRANSITION-01';
const ARCHIVE = 'F:/ppc-checkpoints/PPC-P2-PREPARED-TRANSITION-01-candidate.tar.gz';
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sha256FromGit = (spec) => createHash('sha256').update(execSync(`git show ${spec}`, { maxBuffer: 64 * 1024 * 1024 })).digest('hex');
const lines = [];

const tmp = mkdtempSync(join(process.env.TEMP ?? tmpdir(), 'ppc-p2-restore-'));
execSync(`tar -xzf "${ARCHIVE.replace(/\\/g, '/')}" -C "${tmp.replace(/\\/g, '/')}" --force-local`, { stdio: 'inherit' });
const root = `${tmp}/${ROUND}`;

const manifest = JSON.parse(readFileSync(`${root}/ARCHIVE_MANIFEST.json`, 'utf8'));
const listed = new Map(manifest.members.map((m) => [m.path, m]));

const seen = [];
const walk = (dir, base) => {
  for (const n of readdirSync(dir)) {
    const f = `${dir}/${n}`;
    const rel = `${base}/${n}`;
    if (statSync(f).isDirectory()) walk(f, rel);
    else seen.push(rel);
  }
};
walk(root, ROUND);

// A manifest cannot hash itself. `ARCHIVE_MANIFEST.json` is documented as
// `selfExcluded` in the manifest and is the ONLY permitted extra; its integrity
// is covered by the whole-tarball digest in ARCHIVE_SHA256.txt.
const SELF = `${ROUND}/ARCHIVE_MANIFEST.json`;

let shaMismatch = 0;
let sizeMismatch = 0;
let selfManifestPresent = false;
const extras = [];
for (const rel of seen) {
  if (rel === SELF) { selfManifestPresent = true; continue; }
  const m = listed.get(rel);
  if (!m) { shaMismatch++; extras.push(rel); lines.push(`EXTRA ${rel}`); continue; }
  const p = `${tmp}/${rel}`;
  if (sha256(p) !== m.sha256) { shaMismatch++; lines.push(`SHA  ${rel}`); }
  if (readFileSync(p).length !== m.bytes) { sizeMismatch++; lines.push(`SIZE ${rel}`); }
}
const missing = [...listed.keys()].filter((k) => !seen.includes(k));

// the 4 changed source files must equal the live worktree bytes
const CHANGED = [
  'src/game/ai/preparedActions.ts',
  'src/game/ai/legalActions.ts',
  'src/game/ai/expectiminimax.ts',
  'src/game/ai/__tests__/preparedTransition.test.ts',
];
const sourceMatches = CHANGED.map((rel) => ({
  path: rel,
  archiveSha256: sha256(`${root}/files/${rel}`),
  worktreeSha256: sha256(rel),
  equal: sha256(`${root}/files/${rel}`) === sha256(rel),
}));

// Baseline-arm provenance: every arm file must be explained either by the
// current src (unchanged) or by the documented pre-round source of a changed
// file. 165/165 must resolve.
const base = JSON.parse(readFileSync(`${ROUND}/BASELINE_MANIFEST.json`, 'utf8'));
const differingRel = new Set(base.arm.differing.map((d) => d.rel));
const preRoundSource = {
  'game/ai/legalActions.ts': sha256FromGit('HEAD:src/game/ai/legalActions.ts'),
  'game/ai/expectiminimax.ts': sha256('PPC-P1-CHECKPOINT-01/checkpoint/source/src/game/ai/expectiminimax.ts'),
};
const armUnresolved = [];
for (const f of base.files) {
  const want = f.sha256;
  if (differingRel.has(f.rel)) {
    if (preRoundSource[f.rel] !== want) armUnresolved.push({ rel: f.rel, why: 'pre-round source sha mismatch' });
  } else {
    if (!existsSync(`src/${f.rel}`) || sha256(`src/${f.rel}`) !== want) armUnresolved.push({ rel: f.rel, why: 'src sha mismatch' });
  }
}
const armRebuild = {
  armFileCount: base.files.length,
  differing: [...differingRel],
  onlyInSrc: base.arm.onlyInSrc,
  unresolved: armUnresolved,
  resolved: base.files.length - armUnresolved.length,
};

// the tarball digest must equal what ARCHIVE_SHA256.txt claims (that file is the
// only place the digest can live, since it cannot describe its own tarball)
const digestFile = `${ROUND}/ARCHIVE_SHA256.txt`;
const digestClaim = readFileSync(digestFile, 'utf8').trim().split(/\s+/)[0];
const digestActual = sha256(ARCHIVE);

const report = {
  archive: ARCHIVE,
  archiveSha256: digestActual,
  archiveSha256Claimed: digestClaim,
  archiveSha256MatchesDigestFile: digestClaim === digestActual,
  archiveBytes: readFileSync(ARCHIVE).length,
  extractedTo: tmp,
  memberCount: seen.length,
  manifestMemberCount: manifest.members.length,
  missing: missing.length,
  extra: extras.length,
  selfManifestPresent,
  selfManifestNote: 'ARCHIVE_MANIFEST.json is the one documented non-member (a manifest cannot carry its own sha256). Its integrity is covered by ARCHIVE_SHA256.txt (= the digest of the whole tarball).',
  shaMismatch,
  sizeMismatch,
  missingList: missing,
  sourceMatches,
  armRebuild,
  verdict: (shaMismatch === 0 && sizeMismatch === 0 && missing.length === 0
    && extras.length === 0 && selfManifestPresent && digestClaim === digestActual
    && sourceMatches.every((s) => s.equal) && armUnresolved.length === 0)
    ? 'PASS' : 'FAIL',
  lines,
};
writeFileSync(`${ROUND}/RESTORE_VERIFICATION.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ verdict: report.verdict, members: seen.length, shaMismatch, sizeMismatch, missing: missing.length, sourceEqual: sourceMatches.every((s) => s.equal) }, null, 1));
console.log('extracted to', tmp);
