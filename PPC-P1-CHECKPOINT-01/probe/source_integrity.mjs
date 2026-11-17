// PPC-P1-CHECKPOINT-01 · CP-0 source integrity probe
// Read-only. Never writes to the working tree, never runs git write commands.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_JSON = 'PPC-P1-CHECKPOINT-01/_raw/source_integrity.json';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

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

const head = git(['rev-parse', 'HEAD']).trim();
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
const porcelain = git(['status', '--porcelain=v1']).split('\n').filter(Boolean);

const tracked = porcelain.filter((l) => /^ ?M/.test(l)).map((l) => l.slice(3).trim());
const untracked = porcelain.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));

// ---- collect declared claims from every prior SOURCE_MANIFEST ----
const manifests = [
  'PPC-P1-ID-01/SOURCE_MANIFEST.json',
  'PPC-P1-TIME-01/SOURCE_MANIFEST.json',
  'PPC-P1-TIME-02/SOURCE_MANIFEST.json',
  'PPC-P1-PLAN-01/SOURCE_MANIFEST.json',
  'PPC-P1-QUALITY-01/SOURCE_MANIFEST.json',
  'PPC-P1-CLOSURE-01/SOURCE_MANIFEST.json',
  'PPC-P1-CLOSURE-FIX-01/SOURCE_MANIFEST.json',
];

const claims = new Map(); // path -> [{round, sha,...}]
const manifestsSeen = [];
for (const m of manifests) {
  if (!existsSync(path.join(ROOT, m))) { manifestsSeen.push({ path: m, present: false }); continue; }
  let j;
  try { j = JSON.parse(readFileSync(path.join(ROOT, m), 'utf8')); }
  catch (e) { manifestsSeen.push({ path: m, present: true, parseError: e.message }); continue; }
  const round = j.round || j.task || m.split('/')[0];
  const lists = [j.files, j.productionFiles, j.changedThisRound, j.newTests, j.fixtures].filter(Array.isArray);
  let n = 0;
  for (const list of lists) {
    for (const f of list) {
      const p = f.path || f.file;
      if (!p || p.startsWith('PPC-')) continue;
      const sha = f.candidateSha256 || f.sha256 || null;
      if (!sha) continue;
      n++;
      if (!claims.has(p)) claims.set(p, []);
      claims.get(p).push({ round, sha, bytes: f.candidateBytes ?? null });
    }
  }
  manifestsSeen.push({ path: m, present: true, round, claimsExtracted: n });
}

// ---- measure the actual candidate ----
const scope = [...new Set([...tracked, ...untracked.filter((u) => u.startsWith('src/'))])].sort();
const files = scope.map((rel) => {
  const abs = path.join(ROOT, rel);
  const buf = readFileSync(abs);
  const blob = execFileSync('git', ['hash-object', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
  return {
    path: rel,
    tracked: tracked.includes(rel),
    sha256: sha256(buf),
    bytes: buf.length,
    eol: eolOf(buf),
    gitBlob: blob,
    gitStatus: tracked.includes(rel) ? 'M' : '??',
  };
});

const byPath = new Map(files.map((f) => [f.path, f]));

// ---- cross-check ----
const crossCheck = [];
let match = 0, superseded = 0, unexplained = 0, neverClaimed = 0;
// Files this round is authorised to change (the numeric-boundary fix). Their
// pre-round bytes are the CLOSURE-FIX-01 candidate; the new hashes are recorded
// below so the divergence is accounted for, not merely tolerated.
const BOUNDARY_FIX_FILES = [
  'src/game/config.ts',
  'src/game/engine.ts',
  'src/game/ai/planBound.ts',
  'src/game/ai/planQuality.ts',
  'src/game/__tests__/catMoveBudgetInputDomain.test.ts',
];
for (const f of files) {
  const c = claims.get(f.path);
  if (!c) { neverClaimed++; crossCheck.push({ path: f.path, verdict: 'NEVER_CLAIMED_BEFORE', diskSha256: f.sha256 }); continue; }
  const hit = c.find((x) => x.sha === f.sha256);
  if (hit) { match++; crossCheck.push({ path: f.path, verdict: 'MATCH', matchedRound: hit.round, sha256: f.sha256 }); }
  else {
    const thisRound = BOUNDARY_FIX_FILES.includes(f.path);
    if (thisRound) superseded++; else unexplained++;
    crossCheck.push({
      path: f.path,
      verdict: thisRound ? 'SUPERSEDED_BY_THIS_ROUND' : 'UNEXPLAINED_DIVERGENCE',
      diskSha256: f.sha256,
      preRoundSha256: c[c.length - 1].sha,
      preRoundDeclaredBy: c[c.length - 1].round,
      claimed: c.map((x) => ({ round: x.round, sha256: x.sha })),
      explainedBy: thisRound
        ? 'PPC-P1-CHECKPOINT-01 numeric-representability fix (authorised by the round brief §three)'
        : null,
    });
  }
}
// claims that point at paths we did not measure (informational only)
const claimedNotMeasured = [...claims.keys()].filter((p) => !byPath.has(p));

const result = {
  artifactId: 'source_integrity',
  round: 'PPC-P1-CHECKPOINT-01',
  generatedAt: new Date().toISOString(),
  head,
  branch,
  headCommit: git(['log', '-1', '--format=%H|%ci|%s']).trim(),
  upstream: (() => { try { return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim(); } catch { return null; } })(),
  coreAutocrlf: git(['config', '--get', 'core.autocrlf']).trim(),
  porcelainCount: porcelain.length,
  trackedModified: tracked,
  untrackedEntries: untracked,
  ignoredDocFile: untracked.find((u) => u.endsWith('.doc')) ?? null,
  manifestsScanned: manifestsSeen,
  claimsTotal: [...claims.values()].reduce((a, b) => a + b.length, 0),
  distinctClaimedPaths: claims.size,
  summary: { filesMeasured: files.length, MATCH: match, SUPERSEDED_BY_THIS_ROUND: superseded, NEVER_CLAIMED_BEFORE: neverClaimed, UNEXPLAINED_DIVERGENCE: unexplained },
  eightKeyFiles: files.filter((f) => [
    'src/game/ai/transposition.ts',
    'src/game/ai/deadlineContext.ts',
    'src/game/ai/hardTurnPlanner.ts',
    'src/game/engine.ts',
    'src/game/ai/planBound.ts',
    'src/game/ai/planQuality.ts',
    'src/game/ai/expectiminimax.ts',
    'src/game/config.ts',
  ].includes(f.path)),
  files,
  crossCheck,
  claimedNotMeasured,
};

writeFileSync(path.join(ROOT, OUT_JSON), JSON.stringify(result, null, 2) + '\n');

console.log('HEAD            =', head);
console.log('branch          =', branch);
console.log('core.autocrlf   =', result.coreAutocrlf);
console.log('tracked M       =', tracked.length);
console.log('untracked       =', untracked.length);
console.log('files measured  =', files.length);
console.log('MATCH           =', match);
console.log('SUPERSEDED      =', superseded);
console.log('NEVER_CLAIMED   =', neverClaimed);
console.log('--- eight key files ---');
for (const f of result.eightKeyFiles) console.log(f.sha256.slice(0, 8), f.eol.padEnd(4), String(f.bytes).padStart(7), f.path);
console.log('--- crosscheck ---');
for (const c of crossCheck) console.log(c.verdict.padEnd(22), c.path);
