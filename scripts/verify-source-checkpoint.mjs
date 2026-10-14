// Lightweight SHA-256 verifier for FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json.
// Run from the repository root:  node scripts/verify-source-checkpoint.mjs
//
// It re-reads the digests the checkpoint declares for its 21 file references
// (6 production + 14 formal tooling/artifact + 1 duplicate reference to the
// T1G final artifact, which is already one of those 14 => 20 unique files) and
// recomputes them from the working tree. It does NOT re-run any experiment,
// benchmark or replay, and it does not re-derive any result: a digest match
// proves only that the bytes are the bytes the checkpoint described.
//
// Exit code rule (two obligations):
//   PRODUCTION source — every BOUND_PRODUCTION_SOURCE file MUST exist, be
//   committed in git, and match its declared SHA-256. Missing, untracked or
//   mismatching => non-zero exit. A fresh clone has to be able to reproduce
//   these bytes; "present on the author's machine only" is a failure, not a
//   pass, so an absent-and-untracked production file is never reported as
//   ABSENT-LOCAL-ONLY-and-forgotten.
//   Formal tooling / artifact references under the gitignored ai-training/ tree
//   — absence is expected on a clone and is tolerated (and reported as such);
//   but if such a file IS present its digest must match, and a file that git
//   tracks yet has vanished from the work tree is a defect too.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import c from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHECKPOINT = path.join(ROOT, 'FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json');

const sha256 = p => c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function isTracked(rel) {
  try {
    return cp.execFileSync('git', ['ls-files', '--error-unmatch', rel],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === rel;
  } catch {
    return false;
  }
}

const cp_ = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));
const declared = [
  ...cp_.BOUND_PRODUCTION_SOURCE.map(r => ({ group: 'PRODUCTION', ...r })),
  ...cp_.DIGEST_BOUND_FORMAL_TOOLING.map(r => ({ group: 'TOOLING', ...r })),
  { group: 'ARTIFACT', ...cp_.T1G_FINAL_ARTIFACT, role: 'T1G final authority artifact' },
];

const results = declared.map(r => {
  const rel = r.path.replace(/\\/g, '/');
  const abs = path.join(ROOT, rel);
  const exists = fs.existsSync(abs);
  const tracked = isTracked(rel);
  let status;
  if (!exists) status = tracked ? 'MISSING-BUT-TRACKED' : 'ABSENT-LOCAL-ONLY';
  else if (sha256(abs) !== r.sha256) status = 'MISMATCH';
  // Present with the right bytes but not committed is NOT the bound production
  // source — it is an untracked local copy, which a clone would not have.
  else if (r.group === 'PRODUCTION' && !tracked) status = 'MATCH-BUT-UNTRACKED';
  else status = 'MATCH';
  return { group: r.group, rel, exists, tracked, status, role: r.role || '' };
});

const fmt = s => s.padEnd(18);
console.log(`${fmt('GROUP')}${fmt('STATUS')}${fmt('IN GIT')}${fmt('SIZE')}${'PATH'}`);
for (const r of results) {
  console.log(`${fmt(r.group)}${fmt(r.status)}${fmt(r.tracked ? 'committed' : 'no')}${fmt(String(r.exists ? fs.statSync(path.join(ROOT, r.rel)).size : '-'))}${r.rel}`);
}

const prod = results.filter(r => r.group === 'PRODUCTION');
const local = results.filter(r => !r.tracked);
// Two different obligations, so two different rules:
//  · PRODUCTION source (6 files) must exist, be committed in git AND match by
//    SHA-256. Any other combination breaks the checkpoint, because a fresh
//    clone cannot reproduce it — this is what makes a tracked-and-present
//    requirement instead of a mere byte comparison.
//  · non-production tooling/artifact under the gitignored ai-training/ tree is
//    expected to be absent on a clone; absence is tolerated and reported, but a
//    file that IS there must match, and a tracked file that vanished is a defect.
const badProduction = prod.filter(r => r.status !== 'MATCH');
const badTooling = results.filter(r => r.group !== 'PRODUCTION'
  && (r.status === 'MISMATCH' || r.status === 'MISSING-BUT-TRACKED'));
const bad = [...badProduction, ...badTooling];

console.log('');
console.log(`production-source files declared : ${prod.length}`);
console.log(`  committed in git + digest MATCH: ${prod.filter(r => r.tracked && r.status === 'MATCH').length}`);
console.log(`PRODUCTION GATE (exist+tracked+MATCH): ${badProduction.length === 0 ? 'PASS' : 'FAIL'}`
  + (badProduction.length ? `  offending: ${badProduction.map(r => `${r.rel} [${r.status}]`).join(', ')}` : ''));
console.log(`tooling/artifact files declared  : ${results.length - prod.length}`);
console.log(`  absent on this clone (gitignored ai-training/): ${local.filter(r => r.status === 'ABSENT-LOCAL-ONLY').length}`);
console.log(`  present + digest MATCH         : ${local.filter(r => r.status === 'MATCH').length}`);
// One count definition for the whole repo: references vs unique files. The
// checkpoint's T1G_FINAL_ARTIFACT repeats a path already in
// DIGEST_BOUND_FORMAL_TOOLING, so 21 references resolve to 20 distinct files.
const uniquePaths = new Set(declared.map(r => r.path.replace(/\\/g, '/')));
console.log(`CHECKPOINT_FILE_REFERENCES       : ${declared.length}  (6 production + 14 tooling + 1 duplicate ref to the final artifact)`);
console.log(`UNIQUE_BOUND_FILES               : ${uniquePaths.size}  (the final artifact is one of the 14, not a 21st file)`);
console.log(`problems (production gate failures + tooling MISMATCH / tracked-but-missing): ${bad.length}`);
console.log('');
console.log(bad.length === 0
  ? 'VERDICT: DIGEST_CONSISTENT_FOR_COMMITTED_SOURCE  (this verifies bytes only — it is NOT a re-run of any experiment and NOT an independent reproduction of any PASS)'
  : 'VERDICT: DIGEST_CONSISTENCY_BROKEN');
process.exitCode = bad.length === 0 ? 0 : 1;
