/**
 * PPC-MCTS-01B — build/artefact manifest.
 *
 * Writes BUILD_MANIFEST.json and SHA256SUMS.txt.
 *
 * SELF-REFERENCE RULE (a trap from earlier rounds): a manifest must never
 * contain its own digest, and a digest list must be computed AFTER every other
 * file exists. So:
 *   - BUILD_MANIFEST.json excludes BUILD_MANIFEST.json and SHA256SUMS.txt;
 *   - SHA256SUMS.txt covers everything except itself, INCLUDING the manifest.
 *
 * Usage: node PPC-MCTS-01B/scripts/gen-build-manifest.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const root = resolve(repo, 'PPC-MCTS-01B');

const SELF = ['BUILD_MANIFEST.json', 'FINAL_BUILD_MANIFEST.json', 'SHA256SUMS.txt'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walk(p)); continue; }
    out.push(p);
  }
  return out;
}

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function bucket(rel) {
  if (rel.startsWith('build/')) return 'buildOutput';
  if (rel.startsWith('data/')) return 'dataArtefact';
  if (rel.startsWith('logs/')) return 'log';
  if (rel.startsWith('figures/')) return 'figure';
  if (rel.startsWith('PHASE1_ANALYSIS/') || rel.startsWith('PHASE2_ANALYSIS/')) return 'analysis';
  if (rel.startsWith('proto/')) return 'prototypeSource';
  if (rel.startsWith('drivers/')) return 'driverSource';
  if (rel.startsWith('probe/')) return 'probeSource';
  if (rel.startsWith('scripts/')) return 'scriptSource';
  if (rel.endsWith('.md')) return 'report';
  if (rel.endsWith('.json')) return 'registry';
  if (rel.endsWith('.patch')) return 'diffArtifact';
  return 'other';
}

const all = walk(root)
  .map((p) => relative(root, p).replace(/\\/g, '/'))
  .filter((rel) => !SELF.includes(rel))
  .sort();

const files = all.map((rel) => {
  const abs = join(root, rel);
  return {
    path: `PPC-MCTS-01B/${rel}`,
    bucket: bucket(rel),
    bytes: statSync(abs).size,
    sha256: sha256(abs),
  };
});

const byBucket = {};
for (const f of files) {
  byBucket[f.bucket] ??= { files: 0, bytes: 0 };
  byBucket[f.bucket].files++;
  byBucket[f.bucket].bytes += f.bytes;
}

const buildOutputsPath = join(root, 'build/BUILD_OUTPUTS.json');

const manifest = {
  manifest: 'BUILD_MANIFEST',
  round: 'PPC-REPORT-01-SEAL',
  roundNote: 'Document-only seal round: mathematics and semantics corrected against the source, two core figures redrawn in Chinese, quality gate raised to 37 real checks. No experiment was run, no production source, GAMEPLAY, parameter or raw artefact was touched.',
  generatedAt: new Date().toISOString(),
  node: process.version,
  provenance: {
    head: execFileSync('git', ['-c', 'core.autocrlf=false', 'rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    branch: execFileSync('git', ['-c', 'core.autocrlf=false', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    headUnchangedByThisRound: true,
    commitsMade: 0,
    pushesMade: 0,
  },
  buildCommand: 'node PPC-MCTS-01B/scripts/build-drivers.mjs',
  buildOutputs: readFileSync(buildOutputsPath, 'utf8') ? JSON.parse(readFileSync(buildOutputsPath, 'utf8')) : null,
  totals: {
    files: files.length,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    byBucket,
  },
  selfReference: {
    excluded: SELF,
    reason: 'A manifest cannot contain its own digest, and a digest list must be computed after every other file exists.',
    authorityForManifestDigest: 'SHA256SUMS.txt (computed after this file is written)',
  },
  files,
};

writeFileSync(join(root, 'BUILD_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
// The final round asks for the same artefact under a name that makes its scope
// unambiguous. Both are written; neither contains its own digest.
writeFileSync(join(root, 'FINAL_BUILD_MANIFEST.json'), `${JSON.stringify({ ...manifest, manifest: 'FINAL_BUILD_MANIFEST' }, null, 2)}\n`, 'utf8');

// SHA256SUMS covers everything except itself, now including BUILD_MANIFEST.json.
const finalList = walk(root)
  .map((p) => relative(root, p).replace(/\\/g, '/'))
  .filter((rel) => rel !== 'SHA256SUMS.txt')
  .sort();

const lines = finalList.map((rel) => `${sha256(join(root, rel))}  ${rel}`);
writeFileSync(join(root, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');

console.log(`BUILD_MANIFEST.json: ${files.length} files, ${manifest.totals.bytes} bytes`);
for (const [k, v] of Object.entries(byBucket).sort()) {
  console.log(`  ${k.padEnd(18)} ${String(v.files).padStart(3)} files  ${String(v.bytes).padStart(9)} B`);
}
console.log(`SHA256SUMS.txt: ${lines.length} entries (excludes itself, includes BUILD_MANIFEST.json)`);
