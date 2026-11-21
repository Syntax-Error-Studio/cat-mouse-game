// PPC-G6T2-SELECTION-CAUSE-01 / G0 — emit SOURCE_MANIFEST.json for this round.
//
// Read-only over the production closure: the 39 files are inherited from
// PPC-D2-PCV-COUNTERLINE-02/SOURCE_MANIFEST.json, re-hashed here (raw + LF),
// and also compared against the frozen worktree commit 21fa941.  No historical
// manifest is overwritten; this file writes only this round's manifest.
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ROUND_DIR = 'PPC-G6T2-SELECTION-CAUSE-01';
const PREV = 'PPC-D2-PCV-COUNTERLINE-02/SOURCE_MANIFEST.json';
const FROZEN_COMMIT = '21fa941';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const lf = (b) => b.toString('utf8').replace(/\r\n/g, '\n');

const prev = JSON.parse(readFileSync(join(ROOT, PREV), 'utf8'));

function fileRecord(rel, prevRec) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return { path: rel, present: false };
  const buf = readFileSync(abs);
  const raw = sha256(buf);
  const lfText = lf(buf);
  const lfHash = sha256(Buffer.from(lfText, 'utf8'));
  let frozenHash = null;
  try {
    frozenHash = sha256(execFileSync('git', ['show', `${FROZEN_COMMIT}:${rel}`], { cwd: ROOT, maxBuffer: 64 << 20 }));
  } catch { frozenHash = null; }
  const rec = {
    path: rel,
    present: true,
    sha256: raw,
    sha256Lf: lfHash,
    bytes: statSync(abs).size,
  };
  if (prevRec) {
    rec.classification = raw === prevRec.sha256 ? 'IDENTICAL_RAW'
      : lfHash === prevRec.sha256 ? 'IDENTICAL_LF_ONLY' : 'CONTENT_CHANGED';
    rec.round02Sha256 = prevRec.sha256;
    rec.round02Classification = prevRec.classification;
  }
  rec.git21fa941LfSha256 = frozenHash;
  rec.matchesFrozenCommitLf = frozenHash !== null && frozenHash === lfHash;
  return rec;
}

const productionSources = prev.productionSources.map((p) => fileRecord(p.path, p));

const harness = [
  `${ROUND_DIR}/probe/expectiminimax_observed.ts`,
  `${ROUND_DIR}/probe/expectiminimax_observed.meta.json`,
  `${ROUND_DIR}/probe/observe.ts`,
  `${ROUND_DIR}/probe/sc_lib.ts`,
  `${ROUND_DIR}/probe/gen_observed.mjs`,
  `${ROUND_DIR}/probe/g0_identity.test.ts`,
  `${ROUND_DIR}/probe/progress.test.ts`,
  `${ROUND_DIR}/probe/instrumented.test.ts`,
  `${ROUND_DIR}/probe/forced.test.ts`,
  `${ROUND_DIR}/probe/verdict.test.ts`,
  `${ROUND_DIR}/probe/vitest.config.mts`,
  `${ROUND_DIR}/probe/emit_manifest03.mjs`,
  `${ROUND_DIR}/scripts/run_03.sh`,
].map((rel) => {
  const buf = readFileSync(join(ROOT, rel));
  return { path: rel, sha256: sha256(buf), bytes: buf.length };
});

const frozenInputs = prev.frozenInputs.map((f) => {
  const buf = readFileSync(join(ROOT, f.path));
  const raw = sha256(buf);
  return { path: f.path, sha256: raw, round02Sha256: f.sha256, unchanged: raw === f.sha256, bytes: buf.length };
});

const byClass = {};
for (const p of productionSources) byClass[p.classification] = (byClass[p.classification] ?? 0) + 1;
const unresolved = productionSources.filter((p) => !p.present || p.classification === 'CONTENT_CHANGED').map((p) => p.path);

const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
const localBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT }).toString().trim();

const manifest = {
  round: ROUND_DIR,
  phase: 'G0_SOURCE_MANIFEST',
  generatedAt: new Date().toISOString(),
  generatedOn: 'local Windows worktree (cloud snapshot has no git history; 57/57 byte equivalence recorded in logs/cloud_equivalence.txt)',
  productionSourceModifiedThisRound: false,
  supersedes: null,
  historicalManifestsTouched: false,
  identityA_historicalFrozenBaseline: {
    head: '48eaac6c4f3801d351787696ba5876995b64e8d8',
    frozenWorktreeCommit: `${FROZEN_COMMIT} (same content as the 48eaac6c worktree)`,
    note: 'Frozen hashes come from M01 SOURCE_MANIFEST + SEAL source_integrity, not from git show 48eaac6c.',
    authoritativeHashSources: [
      'PPC-D2-PCV-COUNTERLINE-01/SOURCE_MANIFEST.json (productionSources + frozenInputs)',
      'PPC-CAT-STRATEGY-SEAL-01/_raw/source_integrity.json (29 modified + 16 dependency files)',
    ],
  },
  identityB_currentSnapshot: {
    localHead,
    localBranch,
    cloudHead: 'NO_GIT_HISTORY',
    cloudEquivalence: {
      filesCompared: 57,
      identical: 57,
      different: 0,
      method: 'sha256 raw bytes on both hosts, serial read-only SSH',
      evidence: `${ROUND_DIR}/logs/cloud_equivalence.txt`,
    },
    closureCleanInGit: 'git status --porcelain over the 39 closure paths is empty; the only dirty src files are mapDefinition.ts / EditorPage.tsx / GamePage.tsx (+2 untracked), pre-existing and outside the closure',
  },
  closure: {
    roots: prev.closure.roots,
    fileCount: productionSources.length,
    byClass,
    unresolved,
    generator: 'inherited from PPC-D2-PCV-COUNTERLINE-02/SOURCE_MANIFEST.json; every path re-hashed this round (raw + LF) and cross-checked against git show 21fa941',
  },
  productionSources,
  harnessFiles: harness,
  frozenInputs,
  notes: [
    'Historical frozen bytes are the 48eaac6c WORKTREE (committed as 21fa941); git show 48eaac6c:<path> is not the frozen content.',
    'This manifest is new; round-01/round-02 manifests and the SEAL source_integrity file are read only.',
    'sha256 is raw-byte; sha256Lf is LF-normalised (core.autocrlf=true on the Windows worktree).',
    'expectiminimax.ts was NOT modified: the observed copy is generated from it by probe/gen_observed.mjs and byte-checked by the parity test.',
  ],
};

writeFileSync(join(ROOT, ROUND_DIR, 'SOURCE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('byClass', JSON.stringify(byClass), 'unresolved', unresolved.length);
console.log('frozenInputs unchanged', frozenInputs.every((f) => f.unchanged));
console.log('closure matchesFrozenCommitLf', productionSources.filter((p) => p.matchesFrozenCommitLf).length, '/', productionSources.length);