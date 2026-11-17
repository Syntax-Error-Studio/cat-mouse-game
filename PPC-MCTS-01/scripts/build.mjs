import { build } from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proto = path.join(here, '..', 'proto');
const outfile = path.join(here, '..', 'out', 'bench.mjs');

await build({
  entryPoints: [path.join(proto, 'benchEntry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
});
console.log(`built ${outfile}`);
