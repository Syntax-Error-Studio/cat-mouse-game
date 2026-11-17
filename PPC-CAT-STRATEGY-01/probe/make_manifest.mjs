/// <reference types="node" />
/**
 * TACT-0 / TACT-9 — provenance manifest.
 *
 * Records sha256 over the RAW on-disk bytes of every file this round's evidence
 * depends on, and cross-checks every `src/` file against the frozen P2 manifest
 * so "this round changed no production code" is a checkable claim, not a promise.
 *
 * Run: npx tsx PPC-CAT-STRATEGY-01/probe/make_manifest.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = 'PPC-CAT-STRATEGY-01';
const P2 = 'PPC-P2-PREPARED-TRANSITION-01/SOURCE_MANIFEST.json';
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const entry = (p, role) => {
  const buf = readFileSync(p);
  return {
    path: p,
    role,
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
    lineEnding: buf.includes(Buffer.from('\r\n')) ? 'CRLF' : 'LF',
  };
};

const head = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();

// ---- 1) every src/ file the frozen P2 manifest talks about -------------------
// Two independent frozen lists from the same round:
//   SOURCE_MANIFEST  — the 4 files P2 actually changed (with pre/post hashes)
//   CANDIDATE_MANIFEST — the 12 files the search depends on, hashes of the
//                        state P2 left behind (the authoritative "as of P2").
const p2 = JSON.parse(readFileSync(P2, 'utf8'));
const p2Cand = JSON.parse(readFileSync('PPC-P2-PREPARED-TRANSITION-01/CANDIDATE_MANIFEST.json', 'utf8'));
const p2Post = new Map();
for (const f of p2Cand.files) {
  p2Post.set(f.path, { want: f.sha256, changes: f.changedThisRound ? 'changed in P2' : 'unchanged in P2' });
}
for (const f of p2.files) {
  const post = f.post ?? {};
  const want = post.sha256 ?? post.sha256WorktreeCrlf ?? null;
  if (want && !p2Post.has(f.path)) p2Post.set(f.path, { want, changes: f.change });
}
const srcChecks = [];
for (const [p, meta] of p2Post) {
  const now = sha256(p);
  srcChecks.push({
    path: p,
    p2DeclaredSha256: meta.want,
    currentSha256: now,
    identicalToP2: now === meta.want,
    p2Change: meta.changes,
  });
}

// ---- 1b) EXHAUSTIVE attribution of every modified / untracked src/ file -----
// Checking only the files a previous manifest happens to mention is not proof:
// git may be carrying modifications nobody listed (it was — 6 of them). So ask
// git for the whole truth and attribute each entry to the round that produced
// it (P2 manifest, or the P1 CHECKPOINT-01 post-state). Anything left
// unattributed fails the round.
// Every frozen manifest that records a post-state, newest first. A file may
// legitimately trace to any of them; it must trace to at least one.
const ATTR_SOURCES = [
  {
    id: 'PPC-P2-PREPARED-TRANSITION-01', path: 'PPC-P2-PREPARED-TRANSITION-01/CANDIDATE_MANIFEST.json',
    // P2 publishes two lists with different shapes; the candidate list carries
    // the plain hash, the source list nests it under `post`.
    resolve: (f) => f.sha256 ?? f.post?.sha256 ?? f.post?.sha256WorktreeCrlf ?? null,
  },
  {
    id: 'PPC-P2-PREPARED-TRANSITION-01', path: 'PPC-P2-PREPARED-TRANSITION-01/SOURCE_MANIFEST.json',
    resolve: (f) => f.post?.sha256 ?? f.post?.sha256WorktreeCrlf ?? null,
  },
  { id: 'PPC-P1-OPENING-SEAL-01', path: 'PPC-P1-OPENING-SEAL-01/SOURCE_MANIFEST.json', resolve: (f) => f.postSha256 ?? null },
  { id: 'PPC-P1-OPENING-STACK-01', path: 'PPC-P1-OPENING-STACK-01/SOURCE_MANIFEST.json', resolve: (f) => f.postSha256 ?? null },
  { id: 'PPC-P1-CHECKPOINT-01', path: 'PPC-P1-CHECKPOINT-01/SOURCE_MANIFEST.json', resolve: (f) => f.postSha256 ?? null },
];
const attrIndex = ATTR_SOURCES.map((src) => {
  const doc = JSON.parse(readFileSync(src.path, 'utf8'));
  const m = new Map();
  for (const f of doc.files ?? []) {
    const h = src.resolve(f);
    if (h && !m.has(f.path)) m.set(f.path, h);
  }
  return { ...src, map: m };
});
const gitStatus = execFileSync('git', ['status', '--porcelain', 'src/']).toString()
  .split('\n').filter(Boolean);
const modified = gitStatus.filter((l) => l.startsWith(' M')).map((l) => l.slice(3).trim());
const untracked = gitStatus.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());

const attribution = [];
for (const p of [...modified, ...untracked]) {
  const now = sha256(p);
  const hit = attrIndex.find((src) => src.map.get(p) === now);
  attribution.push({
    path: p,
    gitState: modified.includes(p) ? 'M' : '??',
    currentSha256: now,
    attributedTo: hit ? hit.id : null,
    note: hit
      ? 'byte-identical to a frozen pre-round manifest ⇒ not produced by this round'
      : 'UNATTRIBUTED — this round cannot account for this file',
  });
}
const unattributed = attribution.filter((a) => a.attributedTo === null);

// ---- 2) the nine frozen dependencies the evidence also rests on -------------
const FROZEN = [
  'src/game/ai/simulator.ts',
  'src/game/ai/searchTypes.ts',
  'src/game/ai/transposition.ts',
  'src/game/ai/planQuality.ts',
  'src/game/ai/hardTurnPlanner.ts',
  'src/game/ai/planBound.ts',
  'src/game/engine.ts',
  'src/game/config.ts',
  'src/game/openingFairness.ts',
  'src/game/ai/evaluation.ts',
  'src/game/ai/correctedHoleLeaf.ts',
  'src/game/ai/hardHistory.ts',
  'src/game/ai/stateCompare.ts',
  'src/game/rules/mobility.ts',
  'src/game/rules/tunnels.ts',
  'src/game/rules/tunnelRules.ts',
];
const srcFiles = FROZEN.map((p) => {
  const e = entry(p, 'production (read-only this round)');
  const p2row = srcChecks.find((c) => c.path === p);
  return { ...e, identicalToP2Manifest: p2row ? p2row.identicalToP2 : null };
});

// ---- 3) reference inputs ----------------------------------------------------
const inputs = [
  entry('GAMEPLAY.md', 'rule authority (documentation)'),
  entry('src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', 'frozen 24 human roots'),
  entry('src/game/ai/__tests__/fixtures/ppcId01-baseline-d1.json', 'frozen D1 baseline'),
  entry('ai-training/f2b19a/log_gameA.txt', 'human game A'),
  entry('ai-training/f2b19a/log_gameB.txt', 'human game B'),
  entry('ai-training/f2b19a/log_gameC.txt', 'human game C'),
  entry('ai-training/f2b19a/log_gameD.txt', 'human game D'),
  entry(P2, 'previous round manifest (cross-check source)'),
];

// ---- 4) archived rounds (identity only; their own manifests hold detail) ----
const archives = [
  'PPC-P1-CHECKPOINT-01', 'PPC-P1-OPENING-STACK-01', 'PPC-P1-OPENING-SEAL-01',
  'PPC-P2-PREPARED-TRANSITION-01',
].map((d) => {
  // Project convention (see PPC-P2 archive notes): the sealed tarball lives
  // OUTSIDE the repo under F:/ppc-checkpoints/, so that a workspace reset can
  // never destroy the archive. Scanning only the in-repo directory would have
  // silently reported "no tarball" for three of the four archives.
  const OUTSIDE = 'F:/ppc-checkpoints';
  const outside = existsSync(OUTSIDE) ? readdirSync(OUTSIDE) : [];
  const candidates = [
    ...readdirSync(d).filter((f) => f.endsWith('.tar.gz') || f.endsWith('.tgz')).map((f) => `${d}/${f}`),
    ...outside.filter((f) => f.startsWith(d) && (f.endsWith('.tar.gz') || f.endsWith('.tgz')))
      .map((f) => `${OUTSIDE}/${f}`),
  ];
  const shaFile = readdirSync(d).find((f) => f.startsWith('ARCHIVE_SHA256'));
  let declared = null;
  if (shaFile) {
    const txt = readFileSync(`${d}/${shaFile}`, 'utf8');
    const m = txt.match(/[0-9a-f]{64}/);
    declared = m ? m[0] : null;
  }
  // A digest computed here is not the archive's declared authority — record
  // both so a reader can tell "what the tarball is" from "what was promised".
  const tarballs = candidates.map((p) => ({
    file: p,
    ...entry(p, 'archive'),
    matchesDeclared: declared ? sha256(p) === declared : null,
  }));
  // The round task book (§2.1) independently declares these four digests; they
  // are reproduced here verbatim so the check does not depend on this script's
  // own output. Three of the four archives have no in-repo ARCHIVE_SHA256.txt,
  // so without this list their tarball would be unverifiable from inside the
  // repo alone.
  const DECLARED_IN_TASK_BOOK = {
    'PPC-P1-CHECKPOINT-01': '5cd732828856f2b3cd903cc20c584bbb0fec7906d283ec08415bd2653a9425d5',
    'PPC-P1-OPENING-STACK-01': 'a6a7795c4f31533a8127ec9e8594a4974aad019b73f69a1421a5c04930c2d015',
    'PPC-P1-OPENING-SEAL-01': '27dbc3c2f4ad183f75808ab3394f0ff3675505ea6781591000b5a5594706dd2f',
    'PPC-P2-PREPARED-TRANSITION-01': '8da211e034dd514ed58f3871381a458183c737336c9a6ca99b59d261a3e70f58',
  };
  const declaredInTaskBook = DECLARED_IN_TASK_BOOK[d] ?? null;
  const computed = tarballs.length === 1 ? tarballs[0].sha256 : null;
  return {
    dir: d,
    tarballs,
    declaredInRepoFile: declared,
    declaredInTaskBook,
    computedTarballSha256: computed,
    matchesTaskBook: declaredInTaskBook && computed ? computed === declaredInTaskBook : null,
  };
});

// ---- 5) this round's own files ---------------------------------------------
const probeDir = `${ROOT}/probe`;
const probes = readdirSync(probeDir)
  .filter((f) => /\.(ts|mts|mjs)$/.test(f))
  .sort()
  .map((f) => entry(`${probeDir}/${f}`, 'research probe (not production)'));
const fixturesSyn = readdirSync(`${ROOT}/fixtures/synthetic`).sort()
  .map((f) => entry(`${ROOT}/fixtures/synthetic/${f}`, 'SYNTHETIC fixture'));
// Real and synthetic positions are kept in separate directories on purpose
// (§13: "所有真实局面和合成局面必须分开").
const fixturesReal = existsSync(`${ROOT}/fixtures/real_human`)
  ? readdirSync(`${ROOT}/fixtures/real_human`).sort()
    .map((f) => entry(`${ROOT}/fixtures/real_human/${f}`, 'REAL_HUMAN_REPLAY fixture'))
  : [];
const deliverables = readdirSync(ROOT)
  .filter((f) => statSync(`${ROOT}/${f}`).isFile())
  .sort()
  .map((f) => entry(`${ROOT}/${f}`, 'deliverable'));
const raw = readdirSync(`${ROOT}/_raw`).sort()
  .map((f) => entry(`${ROOT}/_raw/${f}`, 'raw evidence'));

const allMatch = srcChecks.every((c) => c.identicalToP2);

writeFileSync(`${ROOT}/SOURCE_MANIFEST.json`, JSON.stringify({
  artifactId: 'SOURCE_MANIFEST',
  round: 'PPC-CAT-STRATEGY-01',
  project: 'Project Perfect Cat',
  date: new Date().toISOString().slice(0, 10),
  branch,
  head,
  sha256Method: 'sha256 over raw on-disk bytes (binary read); no line-ending normalisation',
  scope: 'research only — zero production edits this round',
  srcUnchangedThisRound: {
    claim: 'every file git reports as modified or untracked under src/ is byte-identical to a '
      + 'frozen pre-round manifest (P2 CANDIDATE_MANIFEST or P1 CHECKPOINT-01 post-state) — '
      + 'i.e. none of them was produced by this round',
    // Deliberately NOT "only the files the P2 manifest happens to mention":
    // git was carrying 6 modifications that no P2 manifest listed. They are
    // attributed to P1 CHECKPOINT-01 instead. Checking the manifest's own file
    // list would have silently certified an incomplete claim.
    exhaustive: true,
    checkedAgainst: [...new Set(ATTR_SOURCES.map((x) => x.path))],
    modifiedCount: modified.length,
    untrackedCount: untracked.length,
    attributedCount: attribution.length - unattributed.length,
    unattributed: unattributed.map((a) => ({ path: a.path, currentSha256: a.currentSha256 })),
    allAttributed: unattributed.length === 0,
    allIdenticalToP2: allMatch,
    rows: attribution,
    p2OnlyRows: srcChecks,
  },
  srcDependenciesUsed: srcFiles,
  referenceInputs: inputs,
  archives,
  thisRound: {
    probes,
    realHumanFixtures: fixturesReal,
    syntheticFixtures: fixturesSyn,
    rawEvidence: raw,
    deliverables,
  },
  counts: {
    probes: probes.length,
    realHumanFixtures: fixturesReal.length,
    syntheticFixtures: fixturesSyn.length,
    rawEvidence: raw.length,
    deliverables: deliverables.length,
  },
}, null, 2));

console.log(`head=${head} branch=${branch}`);
console.log(`src modified=${modified.length} untracked=${untracked.length} `
  + `attributed=${attribution.length - unattributed.length}/${attribution.length} allAttributed=${unattributed.length === 0}`);
for (const a of unattributed) console.log(`  UNATTRIBUTED ${a.path} ${a.currentSha256}`);
console.log(`src rows(p2-only)=${srcChecks.length} allIdenticalToP2=${allMatch}`);
for (const c of srcChecks.filter((c) => !c.identicalToP2)) {
  console.log(`  DIVERGES ${c.path}\n    p2=${c.p2DeclaredSha256}\n    now=${c.currentSha256}`);
}
console.log(`probes=${probes.length} syn=${fixturesSyn.length} raw=${raw.length} deliverables=${deliverables.length}`);
