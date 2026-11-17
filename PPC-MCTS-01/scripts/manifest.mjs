/**
 * PPC-MCTS-01 SHA256 manifest.
 *
 * Covers the prototype, tests, scripts, fixture snapshot, raw pilot JSONL and
 * analysis outputs. Paths are relative to the repository root.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const roundDir = path.join(here, '..');
const repoRoot = path.resolve(roundDir, '..');

const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else files.push(p);
  }
}

for (const rel of ['src/game/engine.ts', 'src/game/config.ts', 'src/game/types.ts', 'GAMEPLAY.md']) {
  const p = path.join(repoRoot, rel);
  if (fs.existsSync(p)) files.push(p);
}
for (const rel of [
  'src/game/ai/legalActions.ts',
  'src/game/ai/simulator.ts',
  'src/game/ai/transposition.ts',
  'src/game/ai/hybridLeaf.ts',
  'src/game/ai/searchRules.ts',
  'src/game/ai/searchTypes.ts',
  'src/game/ai/preparedActions.ts',
  'src/game/rules/mobility.ts',
  'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json',
]) {
  const p = path.join(repoRoot, rel);
  if (fs.existsSync(p)) files.push(p);
}
walk(path.join(roundDir, 'proto'));
walk(path.join(roundDir, 'scripts'));
walk(path.join(roundDir, 'tests'));
walk(path.join(roundDir, 'logs'));
walk(path.join(roundDir, 'data'));
walk(path.join(roundDir, 'out'));
for (const rel of ['vitest.config.mts', 'REPORT.md', 'PILOT_COMPLETION_REPORT.md']) {
  const p = path.join(roundDir, rel);
  if (fs.existsSync(p)) files.push(p);
}

const unique = [...new Set(files)].filter((p) => !p.endsWith(path.join('out', 'bench.mjs')));
const entries = {};
for (const p of unique) {
  const buf = fs.readFileSync(p);
  entries[path.relative(repoRoot, p).replaceAll('\\', '/')] = {
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}
const manifest = {
  round: 'PPC-MCTS-01',
  generatedAt: new Date().toISOString(),
  algorithm: 'SHA256',
  fileCount: Object.keys(entries).length,
  files: entries,
};
const out = path.join(roundDir, 'MANIFEST.json');
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`PPC-MCTS-01 MANIFEST files=${manifest.fileCount} -> ${path.relative(repoRoot, out)}`);
