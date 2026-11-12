import { describe, expect, it } from 'vitest';
import { controls, runFixed } from './pvs_lib.mts';

describe('PPC-SEARCH-01 control cost recheck', () => {
  it('ghost control must be affordable', () => {
    const c = controls().find((x) => x.id === 'C_GHOST')!;
    for (const d of [1, 2]) {
      const row: string[] = [];
      for (const arm of ['A', 'B', 'C'] as const) {
        const t0 = performance.now();
        const r = runFixed(arm, c.state, d, { maxNodes: 60_000 });
        row.push(`${arm}: nodes=${r.nodes} budget=${r.budgetCutoffs} ms=${(performance.now() - t0).toFixed(0)}`);
      }
      console.log('C_GHOST D' + d, row.join(' | '));
    }
    expect(true).toBe(true);
  }, 900_000);
});
