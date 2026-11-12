import { describe, expect, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { corpus, runFixed } from './pvs_lib.mts';

const CAP = 150_000;
const LOG = 'PPC-SEARCH-01/out/rootcost.log';

describe('PPC-SEARCH-01 root cost probe', () => {
  it('per-root cost at D2 with a hard node cap', () => {
    writeFileSync(LOG, '');
    for (const e of corpus()) {
      const row: string[] = [];
      for (const arm of ['A', 'B', 'C'] as const) {
        const t0 = performance.now();
        const r = runFixed(arm, e.root, 2, { maxNodes: CAP });
        row.push(`${arm}: n=${r.nodes} bud=${r.budgetCutoffs} ms=${(performance.now() - t0).toFixed(0)} chance=${r.chanceNodes}`);
      }
      const line = `${e.id.padEnd(7)} ${row.join(' | ')}`;
      console.log(line);
      appendFileSync(LOG, line + '\n');
    }
    expect(true).toBe(true);
  }, 3_600_000);
});
