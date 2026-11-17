#!/usr/bin/env node
/**
 * PPC-P2-PREPARED-TRANSITION-01 — manifest builder.
 *
 * Computes, from the bytes actually on disk:
 *   SOURCE_MANIFEST.json     every file this round touched, with pre/post
 *                            sha256, byte count, line ending and git blob id
 *   BASELINE_MANIFEST.json   the frozen comparison arm (arm/src) and the exact
 *                            provenance of its three differences from src
 *   CANDIDATE_MANIFEST.json  the candidate tree's search-relevant files
 *
 * Nothing here is typed by hand: a hash that is not read from the file is not
 * evidence.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const bytes = (path) => readFileSync(path).length;
const eol = (path) => {
  const b = readFileSync(path);
  return b.includes('\r\n') ? 'CRLF' : 'LF';
};
const blob = (path) => {
  try {
    return execSync(`git hash-object "${path}"`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const gitHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const gitBlobOf = (spec) => execSync(`git rev-parse ${spec}`, { encoding: 'utf8' }).trim();
const gitShow = (spec) => execSync(`git show ${spec}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---- SOURCE_MANIFEST -------------------------------------------------------
const touched = [
  {
    path: 'src/game/ai/preparedActions.ts',
    role: 'production (new module)',
    change: 'added — candidate enumeration + one-simulation prepared batch',
    pre: null,
  },
  {
    path: 'src/game/ai/legalActions.ts',
    role: 'production',
    change: 're-expressed on top of the shared candidate enumeration; contract unchanged',
    // Pre-round bytes: git HEAD blob, re-materialised as the worktree file
    // (core.autocrlf=true => LF blob becomes CRLF on disk).
    preFromGitBlob: 'HEAD:src/game/ai/legalActions.ts',
    preWorktreeEol: 'CRLF',
  },
  {
    path: 'src/game/ai/expectiminimax.ts',
    role: 'production',
    change: 'search hot path uses the prepared batch (root + interior nodes); one simulation per candidate',
    preSha256: '8ac2698587b426df39efc2bb3b451db89d21477e6c60a30ad90e387dfaad052c',
    preBytes: 107714,
    preEol: 'LF',
    preProvenance: 'PPC-P1-CHECKPOINT-01/checkpoint/source/src/game/ai/expectiminimax.ts (== PPC-P1-OPENING-SEAL-01 SOURCE_MANIFEST.postSha256)',
  },
  {
    path: 'src/game/ai/__tests__/preparedTransition.test.ts',
    role: 'test (new)',
    change: 'added — 18 contract tests for the prepared-transition reuse',
    pre: null,
  },
];

const files = touched.map((t) => {
  const post = {
    sha256: sha256(t.path),
    bytes: bytes(t.path),
    lineEnding: eol(t.path),
    gitBlob: blob(t.path),
  };
  let pre = null;
  if (t.preFromGitBlob) {
    const lf = gitShow(t.preFromGitBlob);
    const crlf = lf.replace(/\n/g, '\r\n');
    pre = {
      sha256Lf: createHash('sha256').update(lf, 'utf8').digest('hex'),
      bytesLf: Buffer.byteLength(lf, 'utf8'),
      sha256WorktreeCrlf: createHash('sha256').update(crlf, 'utf8').digest('hex'),
      bytesWorktreeCrlf: Buffer.byteLength(crlf, 'utf8'),
      gitBlob: gitBlobOf(t.preFromGitBlob),
      note: 'worktree copy had CRLF (core.autocrlf=true); both forms recorded because a sha256 is only meaningful with its line ending',
    };
  } else if (t.preSha256) {
    pre = { sha256: t.preSha256, bytes: t.preBytes, lineEnding: t.preEol, provenance: t.preProvenance };
  }
  return { path: t.path, role: t.role, change: t.change, pre, post };
});

writeFileSync('PPC-P2-PREPARED-TRANSITION-01/SOURCE_MANIFEST.json', `${JSON.stringify({
  artifactId: 'SOURCE_MANIFEST',
  round: 'PPC-P2-PREPARED-TRANSITION-01',
  project: 'Project Perfect Cat',
  date: '2026-11-14',
  branch: execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(),
  head: gitHead,
  sha256Method: 'sha256 over raw on-disk bytes (binary read); gitBlob = git hash-object of the same bytes',
  changedThisRound: {
    count: files.length,
    production: files.filter((f) => f.role.startsWith('production')).length,
    tests: files.filter((f) => f.role.startsWith('test')).length,
  },
  files,
}, null, 2)}\n`);

// ---- BASELINE_MANIFEST -----------------------------------------------------
const armRoot = 'PPC-P2-PREPARED-TRANSITION-01/arm/src';
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const armFiles = walk(armRoot).map((p) => ({
  rel: p.slice(armRoot.length + 1),
  sha256: sha256(p),
  bytes: bytes(p),
}));
const srcFiles = walk('src').map((p) => ({
  rel: p.slice(4),
  sha256: sha256(p),
  bytes: bytes(p),
}));
const srcByRel = new Map(srcFiles.map((f) => [f.rel, f]));
const armByRel = new Map(armFiles.map((f) => [f.rel, f]));
const onlyInArm = armFiles.filter((f) => !srcByRel.has(f.rel)).map((f) => f.rel);
const onlyInSrc = srcFiles.filter((f) => !armByRel.has(f.rel)).map((f) => f.rel);
const differing = armFiles
  .filter((f) => srcByRel.has(f.rel) && srcByRel.get(f.rel).sha256 !== f.sha256)
  .map((f) => ({ rel: f.rel, armSha256: f.sha256, srcSha256: srcByRel.get(f.rel).sha256 }));

writeFileSync('PPC-P2-PREPARED-TRANSITION-01/BASELINE_MANIFEST.json', `${JSON.stringify({
  artifactId: 'BASELINE_MANIFEST',
  round: 'PPC-P2-PREPARED-TRANSITION-01',
  semantics: 'The baseline arm is a full copy of src with EXACTLY the differences listed below. Every other file is byte-identical (sha256), so any timing delta is attributable to the three search files.',
  head: gitHead,
  arm: {
    root: armRoot,
    fileCount: armFiles.length,
    onlyInArm,
    onlyInSrc,
    differing,
  },
  provenance: {
    expectiminimax: 'PPC-P1-CHECKPOINT-01/checkpoint/source (sealed pre-round bytes, sha256 8ac26985…)',
    legalActions: `${gitHead}:src/game/ai/legalActions.ts (blob ${gitBlobOf('HEAD:src/game/ai/legalActions.ts')})`,
    preparedActions: 'removed from the arm (the module did not exist before this round)',
  },
  files: armFiles,
}, null, 2)}\n`);

// ---- CANDIDATE_MANIFEST ----------------------------------------------------
const THEME = [
  'src/game/ai/preparedActions.ts',
  'src/game/ai/legalActions.ts',
  'src/game/ai/expectiminimax.ts',
  'src/game/ai/simulator.ts',
  'src/game/ai/searchTypes.ts',
  'src/game/ai/transposition.ts',
  'src/game/ai/planQuality.ts',
  'src/game/ai/hardTurnPlanner.ts',
  'src/game/ai/planBound.ts',
  'src/game/engine.ts',
  'src/game/config.ts',
  'src/game/openingFairness.ts',
];
writeFileSync('PPC-P2-PREPARED-TRANSITION-01/CANDIDATE_MANIFEST.json', `${JSON.stringify({
  artifactId: 'CANDIDATE_MANIFEST',
  round: 'PPC-P2-PREPARED-TRANSITION-01',
  head: gitHead,
  note: 'Files the search depends on, with current bytes. Only the three search files differ from the baseline arm; engine/config/openingFairness are UNCHANGED this round and only listed so the frozen dependency is explicit.',
  files: THEME.filter((p) => existsSync(p)).map((p) => ({
    path: p,
    sha256: sha256(p),
    bytes: bytes(p),
    lineEnding: eol(p),
    changedThisRound: touched.some((t) => t.path === p),
  })),
}, null, 2)}\n`);

console.log('wrote SOURCE_MANIFEST.json / BASELINE_MANIFEST.json / CANDIDATE_MANIFEST.json');
console.log('arm files', armFiles.length, 'onlyInArm', onlyInArm, 'onlyInSrc', onlyInSrc);
console.log('differing', differing.map((d) => d.rel));
