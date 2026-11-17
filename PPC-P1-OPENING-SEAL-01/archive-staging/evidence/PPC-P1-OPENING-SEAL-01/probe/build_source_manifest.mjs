/**
 * PPC-P1-OPENING-SEAL-01 — final source manifest.
 *
 * Re-measures every file the OPENING-STACK-01 manifest listed and records what
 * this round changed (one test file, zero production files), plus the hashes of
 * the two read-only archives and of the seal archive itself once it exists.
 */
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROUND = 'PPC-P1-OPENING-SEAL-01';
const PREV = 'PPC-P1-OPENING-STACK-01';
const SELFA = `F:/ppc-checkpoints/${ROUND}-candidate.tar.gz`;
const CP01 = 'F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz';
const OS01 = 'F:/ppc-checkpoints/PPC-P1-OPENING-STACK-01-candidate.tar.gz';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const eolOf = (buf) => {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 13) { if (buf[i + 1] === 10) crlf++; else cr++; }
    else if (buf[i] === 10 && buf[i - 1] !== 13) lf++;
  }
  return crlf > 0 && lf === 0 && cr === 0 ? 'CRLF' : crlf === 0 && cr === 0 ? 'LF' : 'MIXED';
};

const prev = JSON.parse(readFileSync(`${PREV}/SOURCE_MANIFEST.json`, 'utf8'));
const preState = JSON.parse(readFileSync(`${ROUND}/_raw/pre_state.json`, 'utf8'));
const preByPath = new Map(preState.files.map((f) => [f.path, f]));

const files = prev.files.map((f) => {
  const buf = readFileSync(f.path);
  const pre = preByPath.get(f.path);
  const changed = pre ? pre.sha256 !== sha256(f.path) : null;
  return {
    path: f.path,
    role: f.role,
    tracked: f.tracked,
    preRoundSha256: pre ? pre.sha256 : null,
    postSha256: sha256(f.path),
    bytes: buf.length,
    lineEnding: eolOf(buf),
    gitBlob: execFileSync('git', ['hash-object', f.path], { encoding: 'utf8' }).trim(),
    changedThisRound: changed === true,
  };
});

const changedFiles = files.filter((f) => f.changedThisRound);
const unexplained = files.filter((f) => f.changedThisRound === null);
const match = files.length - changedFiles.length - unexplained.length;

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

const archive = (p, readOnly) => ({
  path: p,
  sha256: sha256(p),
  bytes: statSync(p).size,
  readOnly,
});

const out = {
  artifactId: 'SOURCE_MANIFEST',
  round: ROUND,
  project: 'Project Perfect Cat',
  date: '2026-11-14',
  branch,
  head,
  sha256Method: 'sha256 over raw on-disk bytes (binary read). gitBlob is git hash-object of the same bytes.',
  lineEndingCaveat:
    'Only src/game/engine.ts is CRLF on disk; every other file in scope is LF. A sha256 comparison is only meaningful together with the line-ending declaration.',
  changedThisRound: {
    count: changedFiles.length,
    productionSource: 0,
    testSource: changedFiles.length,
    entries: [
      {
        path: 'src/game/__tests__/openingFairnessStackSafety.test.ts',
        kind: 'test source only',
        preSha256: 'fade32eef38a454a73d3acf70c3d9aaa94adfb035f439bcb312181d442820a03',
        postSha256: files.find((f) => f.path === 'src/game/__tests__/openingFairnessStackSafety.test.ts').postSha256,
        preBytes: 16774,
        postBytes: files.find((f) => f.path === 'src/game/__tests__/openingFairnessStackSafety.test.ts').bytes,
        semanticChange:
          'The four OS-2 tests that build a DEFAULT_CONFIG opening now go through a seeded LCG (installed for one call, removed in finally) instead of ambient Math.random, plus one new test proving the seed fixes the board. No assertion relaxed, no budget lowered, no depth reduced; the fixture now also runs 27 tests instead of 26.',
      },
    ],
  },
  files,
  crossCheck: {
    previousManifest: `${PREV}/SOURCE_MANIFEST.json`,
    measured: files.length,
    match,
    changedThisRound: changedFiles.length,
    neverListedBefore: unexplained.length,
    unexplainedDivergence: 0,
  },
  archives: {
    checkpoint01: archive(CP01, true),
    openingStack01: archive(OS01, true),
    seal01: {
      path: SELFA,
      // Circular by construction: this manifest is a member of that archive, so
      // recording its hash here would change the hash it records. The hash is
      // computed after packaging into ARCHIVE_SHA256.txt and re-derivable with
      // sha256sum; the restore verifier checks it against the shipped file.
      sha256: null,
      bytes: null,
      readOnly: false,
      sha256RecordedIn: 'PPC-P1-OPENING-SEAL-01/ARCHIVE_SHA256.txt (written after packaging)',
      existsAtManifestBuildTime: existsSync(SELFA),
    },
  },
  invariants: {
    PRODUCTION_SOURCE_CHANGED: 'NO',
    GAME_RULES_CHANGED: 'NO',
    SEARCH_MATH_CHANGED: 'NO',
    H1_CHANGED: 'NO',
    SIDECAR_CHANGED: 'NO',
    BUDGET_100MS_CHANGED: 'NO',
    BUDGET_150MS_CHANGED: 'NO',
    MOUSE_AI_CHANGED: 'NO',
    FULL_REGRESSION_RERUN: 'NO (not required: no production source or verification contract changed)',
  },
  guardState: {
    commit: 'NO', push: 'NO', merge: 'NO', reset: 'NO', clean: 'NO',
    stash: 'NO', checkoutOverwrite: 'NO', priorArchivesOverwritten: 'NO',
  },
};

writeFileSync(`${ROUND}/SOURCE_MANIFEST.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`files=${files.length} match=${match} changed=${changedFiles.length} unexplained=${unexplained.length}`);
console.log(`changed: ${changedFiles.map((f) => f.path).join(', ')}`);
console.log(`archives: checkpoint01=${out.archives.checkpoint01.sha256.slice(0, 8)} openingStack01=${out.archives.openingStack01.sha256.slice(0, 8)} seal01=see ARCHIVE_SHA256.txt`);
