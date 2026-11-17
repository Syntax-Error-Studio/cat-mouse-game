/**
 * Bundle the 01B drivers with esbuild, exactly like the Pilot's `bench.mjs`.
 *
 * WHY: vite-node's SSR module shims make the hybrid leaf evaluator ~7x slower
 * here (measured 691 us/call vs 97 us/call bundled), which collapses the 100 ms
 * budget to 2 simulations and makes any timing comparison meaningless.
 * Bundled numbers reproduce the PPC-MCTS-01A figure (3.16 ms per simulation).
 *
 * ALL formal timing runs MUST go through `build/*.mjs` with plain `node`.
 * `vite-node` and `vitest` are for correctness only.
 *
 * Usage: node PPC-MCTS-01B/scripts/build-drivers.mjs
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

const ENTRIES = ['parityFixedSims', 'perfBudget100', 'phase1Parity'];
const built = [];

for (const name of ENTRIES) {
  const out = resolve(here, '../build', `${name}.mjs`);
  await build({
    entryPoints: [resolve(here, '../drivers', `${name}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    logLevel: 'error',
    banner: { js: `// built from PPC-MCTS-01B/drivers/${name}.ts — do not edit` },
  });
  const bytes = readFileSync(out);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  built.push({
    entry: `PPC-MCTS-01B/drivers/${name}.ts`,
    outfile: relative(repo, out).replace(/\\/g, '/'),
    bytes: statSync(out).size,
    sha256,
  });
  console.log(`built ${relative(repo, out).replace(/\\/g, '/')}  sha256=${sha256.slice(0, 16)}…  ${statSync(out).size}B`);
}

writeFileSync(
  resolve(here, '../build/BUILD_OUTPUTS.json'),
  `${JSON.stringify({ builtAt: new Date().toISOString(), node: process.version, outputs: built }, null, 2)}\n`,
  'utf8',
);
console.log('wrote PPC-MCTS-01B/build/BUILD_OUTPUTS.json');
