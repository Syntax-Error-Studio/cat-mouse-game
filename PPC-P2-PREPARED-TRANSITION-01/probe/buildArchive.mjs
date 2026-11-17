#!/usr/bin/env node
/**
 * PPC-P2-PREPARED-TRANSITION-01 — build the candidate archive.
 *
 * Layout inside the tarball:
 *   PPC-P2-PREPARED-TRANSITION-01/
 *     <every document / result JSON / log this round produced>
 *     files/src/...        the ACTUAL bytes of the 4 files this round touched
 *     RESTORE.md           how to rebuild the candidate from the frozen baseline
 *     probe/verify_restore.mjs
 *     ARCHIVE_MANIFEST.json
 *
 * Excluded on purpose: `arm/` (a 6 MB duplicate of src, reproducible from
 * BASELINE_MANIFEST.json + git), `_raw/bench` is INCLUDED (per-repetition raw
 * data is required evidence), node_modules / dist / build caches (none exist).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROUND = 'PPC-P2-PREPARED-TRANSITION-01';
const STAGE = `${ROUND}/archive-staging/${ROUND}`;
const OUT = 'F:/ppc-checkpoints/PPC-P2-PREPARED-TRANSITION-01-candidate.tar.gz';

rmSync(`${ROUND}/archive-staging`, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const TOP_FILES = readdirSync(ROUND).filter((n) => {
  const p = `${ROUND}/${n}`;
  if (statSync(p).isDirectory()) return false;
  if (!/\.(md|json|txt)$/.test(n)) return false;
  // Two files cannot be members:
  //   ARCHIVE_MANIFEST.json — a manifest cannot carry its own sha256;
  //   ARCHIVE_SHA256.txt    — it holds the digest of THIS tarball, which does not
  //                           exist yet while the tarball is being assembled. Copying
  //                           the previous build's file inside would ship a stale,
  //                           silently wrong digest.
  // Both live next to the tarball and are listed in `selfExcluded`.
  return n !== 'ARCHIVE_SHA256.txt';
});
const SKIP_JSON = new Set([`${ROUND}/archive-staging`]);

for (const n of TOP_FILES) copyFileSync(`${ROUND}/${n}`, `${STAGE}/${n}`);

// raw evidence (includes the benchmark's per-repetition JSON)
const copyTree = (from, to) => {
  mkdirSync(to, { recursive: true });
  for (const n of readdirSync(from)) {
    const f = `${from}/${n}`;
    const t = `${to}/${n}`;
    if (statSync(f).isDirectory()) copyTree(f, t);
    else copyFileSync(f, t);
  }
};
copyTree(`${ROUND}/_raw`, `${STAGE}/_raw`);
copyTree(`${ROUND}/logs`, `${STAGE}/logs`);
copyTree(`${ROUND}/probe`, `${STAGE}/probe`);

// the actual changed source bytes
const CHANGED = [
  'src/game/ai/preparedActions.ts',
  'src/game/ai/legalActions.ts',
  'src/game/ai/expectiminimax.ts',
  'src/game/ai/__tests__/preparedTransition.test.ts',
];
for (const rel of CHANGED) {
  const dest = `${STAGE}/files/${rel}`;
  mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
  copyFileSync(rel, dest);
}

// manifest of every member (path relative to the round dir)
const members = [];
const walk = (dir, base) => {
  for (const n of readdirSync(dir)) {
    const f = `${dir}/${n}`;
    const rel = `${base}/${n}`;
    if (statSync(f).isDirectory()) walk(f, rel);
    else members.push({ path: rel, sha256: sha256(f), bytes: readFileSync(f).length });
  }
};
walk(STAGE, ROUND);
writeFileSync(`${STAGE}/ARCHIVE_MANIFEST.json`, `${JSON.stringify({
  round: ROUND,
  createdAt: new Date().toISOString(),
  head: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
  memberCount: members.length,
  note: 'paths are relative to the archive root; the tarball itself is not a member',
  selfExcluded: [
    {
      path: `${ROUND}/ARCHIVE_MANIFEST.json`,
      why: 'A manifest cannot carry its own sha256. Excluded from `members`; the whole-tarball digest in '
        + 'ARCHIVE_SHA256.txt is the stronger statement anyway.',
    },
    {
      path: `${ROUND}/ARCHIVE_SHA256.txt`,
      why: 'Holds the digest of this very tarball, which cannot exist before the tarball is written. '
        + 'Copying the previous build\'s copy inside would ship a stale digest that looks authoritative. '
        + 'The authoritative copy lives next to the tarball.',
    },
  ],
  baselineDependency: 'This archive is NOT self-contained. The untouched files come from git 48eaac6c; the frozen baseline arm (arm/src) is rebuilt from BASELINE_MANIFEST.json. See RESTORE.md.',
  members,
}, null, 2)}\n`);
// NOTE: deliberately NOT pushed into `members` — a self-referential hash is
// impossible. See `selfExcluded` above; verify_restore.mjs knows the rule.

// tar it (GNU tar on Windows needs --force-local for a drive-letter path)
const tarPath = OUT.replace(/\\/g, '/');
execSync(`tar -czf "${tarPath}" --force-local -C "${ROUND}/archive-staging" "${ROUND}"`, { stdio: 'inherit' });

const digest = sha256(OUT);
writeFileSync(`${ROUND}/ARCHIVE_SHA256.txt`, `${digest}  PPC-P2-PREPARED-TRANSITION-01-candidate.tar.gz\n${readFileSync(OUT).length} bytes\n`);
console.log('archive', OUT);
console.log('sha256', digest, readFileSync(OUT).length, 'bytes,', members.length, 'members');
