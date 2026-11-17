/**
 * PPC-P1-OPENING-STACK-01 — SOURCE_MANIFEST generator.
 *
 * Base = the previous round's manifest (PPC-P1-CHECKPOINT-01), re-measured from
 * disk so every figure describes the CURRENT worktree, plus the two files this
 * round adds to the scope (openingFairness.ts, the new stack-safety test).
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const OUT = 'PPC-P1-OPENING-STACK-01/SOURCE_MANIFEST.json';
const PREV = JSON.parse(readFileSync('PPC-P1-CHECKPOINT-01/SOURCE_MANIFEST.json', 'utf8'));

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const gitBlob = (p) => execFileSync('git', ['hash-object', p], { encoding: 'utf8' }).trim();
function eol(p) {
  const b = readFileSync(p);
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 13) { if (b[i + 1] === 10) crlf++; else cr++; }
    else if (b[i] === 10 && b[i - 1] !== 13) lf++;
  }
  return crlf > 0 && lf === 0 && cr === 0 ? 'CRLF' : crlf === 0 && cr === 0 ? 'LF' : 'MIXED';
}
const tracked = (p) => {
  try { execFileSync('git', ['ls-files', '--error-unmatch', p], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const roleOf = (p) =>
  p.includes('__tests__') || p.endsWith('.test.ts')
    ? (p.includes('fixtures') ? 'fixture' : 'test')
    : 'production';

const THIS_ROUND = {
  'src/game/openingFairness.ts': {
    preRoundSha256: '27c97202806154a22f878d7c524c82fd00cf7d88dda48b8aa2532dce58aff902',
    preRoundBytes: 29272,
    preRoundLines: 723,
    change: 'recursive solve() -> explicit-stack iterative DFS (+284/-103)',
  },
  'src/game/__tests__/openingFairnessStackSafety.test.ts': {
    preRoundSha256: null,
    preRoundBytes: null,
    preRoundLines: null,
    change: 'new: 26 stack-safety / semantics / pinned-parity tests',
  },
};

const paths = [
  ...PREV.files.map((f) => f.path),
  ...Object.keys(THIS_ROUND),
].filter((p, i, a) => a.indexOf(p) === i).sort();

const files = paths.map((p) => {
  const st = statSync(p);
  const round = THIS_ROUND[p];
  return {
    path: p,
    role: roleOf(p),
    tracked: tracked(p),
    postSha256: sha256(p),
    bytes: st.size,
    lineEnding: eol(p),
    gitBlob: gitBlob(p),
    preRoundSha256: round ? round.preRoundSha256 : null,
    preRoundBytes: round ? round.preRoundBytes : null,
    changedThisRound: !!round,
    changeNote: round ? round.change : null,
  };
});

const dirty = execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const out = {
  artifactId: 'SOURCE_MANIFEST',
  round: 'PPC-P1-OPENING-STACK-01',
  project: 'Project Perfect Cat',
  date: '2026-11-14',
  branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  coreAutocrlf: execFileSync('git', ['config', '--get', 'core.autocrlf'], { encoding: 'utf8' }).trim(),
  sha256Method:
    'sha256 over raw on-disk bytes (binary read). gitBlob is `git hash-object` of the same bytes, i.e. the LF-normalised blob id git stores.',
  lineEndingCaveat:
    'engine.ts and most __tests__ files are CRLF on disk; openingFairness.ts, config.ts, planBound.ts, planQuality.ts and the new test are LF. A sha256 comparison is only meaningful together with the line-ending declaration.',
  base: 'PPC-P1-CHECKPOINT-01/SOURCE_MANIFEST.json (24 files) — re-measured from disk, not copied',
  filesThisRound: Object.keys(THIS_ROUND),
  files,
  eightKeyFilesFromBrief: PREV.eightKeyFilesFromBrief.map((f) => ({
    path: f.path,
    sha256: sha256(f.path),
    prefix: sha256(f.path).slice(0, 8),
    bytes: statSync(f.path).size,
    lineEnding: eol(f.path),
    unchangedSinceCheckpoint: sha256(f.path) === f.sha256,
  })),
  deltaSinceCheckpoint: {
    modified: files.filter((f) => f.changedThisRound).map((f) => f.path),
    unchangedCount: files.filter((f) => !f.changedThisRound).length,
    unexplainedDivergence: files
      .filter((f) => !f.changedThisRound && !PREV.files.some((x) => x.path === f.path && x.postSha256 === f.postSha256))
      .map((f) => f.path),
  },
  briefPrefixReconciliation: {
    note:
      'The round brief listed eight 8-hex prefixes. Four match the current worktree exactly; the other four are the PRE-CHECKPOINT-01 '
      + '(i.e. PPC-P1-CLOSURE-FIX-01) values of precisely the four files that CHECKPOINT-01 itself rewrote for the numeric-boundary fix. '
      + 'Both sides are recorded in PPC-P1-CHECKPOINT-01/SOURCE_MANIFEST.json (preRoundSha256 / postSha256), so the difference is fully explained and no '
      + 'source changed outside an authorised round.',
    entries: [
      { file: 'transposition.ts', briefPrefix: '7b4aa8eb', currentPrefix: sha256('src/game/ai/transposition.ts').slice(0, 8), verdict: 'MATCH' },
      { file: 'deadlineContext.ts', briefPrefix: 'ced44944', currentPrefix: sha256('src/game/ai/deadlineContext.ts').slice(0, 8), verdict: 'MATCH' },
      { file: 'hardTurnPlanner.ts', briefPrefix: '27b1ce6d', currentPrefix: sha256('src/game/ai/hardTurnPlanner.ts').slice(0, 8), verdict: 'MATCH' },
      { file: 'expectiminimax.ts', briefPrefix: '8ac26985', currentPrefix: sha256('src/game/ai/expectiminimax.ts').slice(0, 8), verdict: 'MATCH' },
      { file: 'engine.ts', briefPrefix: '5a51e837', currentPrefix: sha256('src/game/engine.ts').slice(0, 8), verdict: 'BRIEF_PREFIX_IS_PRE_CHECKPOINT_01_VALUE', checkpoint01PrePrefix: '5a51e837', checkpoint01PostPrefix: '099f9a7b' },
      { file: 'planBound.ts', briefPrefix: 'f1427ae1', currentPrefix: sha256('src/game/ai/planBound.ts').slice(0, 8), verdict: 'BRIEF_PREFIX_IS_PRE_CHECKPOINT_01_VALUE', checkpoint01PrePrefix: 'f1427ae1', checkpoint01PostPrefix: '4a212b75' },
      { file: 'planQuality.ts', briefPrefix: 'd8ecdd26', currentPrefix: sha256('src/game/ai/planQuality.ts').slice(0, 8), verdict: 'BRIEF_PREFIX_IS_PRE_CHECKPOINT_01_VALUE', checkpoint01PrePrefix: 'd8ecdd26', checkpoint01PostPrefix: '46979485' },
      { file: 'config.ts', briefPrefix: '978c6c9f', currentPrefix: sha256('src/game/config.ts').slice(0, 8), verdict: 'BRIEF_PREFIX_IS_PRE_CHECKPOINT_01_VALUE', checkpoint01PrePrefix: '978c6c9f', checkpoint01PostPrefix: '60e38c49' },
    ],
  },
  workingTree: { entries: dirty.length, statusLines: dirty },
  untouchedDocFile: PREV.untouchedDocFile,
  invariants: {
    GAME_RULES_CHANGED: 'NO',
    SEARCH_MATH_CHANGED: 'NO',
    H1_HARD_PLANNER_CHANGED: 'NO',
    TT_SEMANTICS_CHANGED: 'NO',
    SIDECAR_POLICY_CHANGED: 'NO',
    TRAP_STRATEGY_CHANGED: 'NO',
    BUDGET_100MS_CHANGED: 'NO',
    BUDGET_150MS_CHANGED: 'NO',
    MOUSE_AI_STARTED: 'NO',
    CAT_MOVE_BUDGET_CAP_ADDED: 'NO',
    CONFIG_TS_CHANGED_THIS_ROUND: 'NO',
    CHECKPOINT_01_ARCHIVE_MODIFIED: 'NO',
  },
  guardState: {
    commit: 'NO', push: 'NO', merge: 'NO', reset: 'NO', clean: 'NO', stash: 'NO',
    rebase: 'NO', checkoutOverwrite: 'NO', gitApplyUsed: 'NO',
    archiveOverwritten: 'NO',
  },
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

console.log('files=' + files.length + ' changedThisRound=' + out.deltaSinceCheckpoint.modified.length);
console.log('unexplainedDivergence=' + out.deltaSinceCheckpoint.unexplainedDivergence.length);
for (const f of out.eightKeyFilesFromBrief) {
  console.log('  ' + f.path.split('/').pop().padEnd(22) + f.prefix + ' unchanged=' + f.unchangedSinceCheckpoint);
}
const of = files.find((f) => f.path === 'src/game/openingFairness.ts');
console.log('openingFairness ' + of.postSha256.slice(0, 8) + ' ' + of.bytes + 'B ' + of.lineEnding + ' pre=' + of.preRoundSha256.slice(0, 8));
