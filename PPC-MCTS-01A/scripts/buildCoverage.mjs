import { build } from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const roundDir = path.join(here, '..');
const repoRoot = path.resolve(roundDir, '..');

await build({
  entryPoints: [path.join(roundDir, 'diagnostics', 'coverage.ts')],
  outfile: path.join(roundDir, 'out', 'coverage.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
  absWorkingDir: repoRoot,
});
console.log(`built ${path.join(roundDir, 'out', 'coverage.mjs')}`);
