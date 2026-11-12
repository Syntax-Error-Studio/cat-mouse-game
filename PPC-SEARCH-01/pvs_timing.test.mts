import { describe, expect, it } from 'vitest';
import { corpus, runFixed } from './pvs_lib.mts';

describe('PPC-SEARCH-01 timing probe', () => {
  it('single root D2 timing per arm', () => {
    const c = corpus();
    for (const id of ['G1T1', 'G1T9', 'G8T10']) {
      const e = c.find((x) => x.id === id)!;
      for (const d of [1, 2]) {
        const t0 = performance.now();
        const a = runFixed('A', e.root, d);
        const ta = performance.now() - t0;
        const t1 = performance.now();
        const b = runFixed('B', e.root, d);
        const tb = performance.now() - t1;
        console.log(
          id, 'D' + d,
          'A nodes', a.nodes, 'chance', a.chanceNodes, 'ms', +ta.toFixed(1),
          '| B nodes', b.nodes, 'chance', b.chanceNodes, 'ms', +tb.toFixed(1),
          '| pvs', JSON.stringify(b.pvs),
        );
      }
    }
    expect(true).toBe(true);
  });
});
