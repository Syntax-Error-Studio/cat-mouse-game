/// <reference types="node" />
/**
 * Cache-wiring microbench: how much does a 20k-entry Map keyed by ~1.2 KB stateKey
 * strings cost per expansion when it is looked up and (on miss) inserted with FIFO
 * eviction? This is a lower bound on what ANY solve-local action cache must pay in
 * bookkeeping, independent of the engine. NON-EVIDENCE for the engine itself.
 */
import { describe, it } from 'vitest';
import { writeJson, LOG } from './hotpath_lib';

const KEY_LEN = 1200;
const N_KEYS = 20_000;
const OPS = 65_585; // DUUD expansions

function makeKey(i: number): string {
  let s = `${i}:`;
  while (s.length < KEY_LEN) s += 'e__';
  return s;
}

describe('cache wiring microbench', () => {
  it('map bookkeeping cost per expansion at the measured hit rate', () => {
    const keys = new Array<string>(N_KEYS);
    for (let i = 0; i < N_KEYS; i++) keys[i] = makeKey(i);

    const cache = new Map<string, number[]>();
    // warm to cap
    for (let i = 0; i < N_KEYS; i++) cache.set(keys[i], [i]);

    // model: 65,585 lookups; 0.2% hits (reuse the same 134 keys), rest misses + insert + evict
    const hits = 134;
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < OPS; i++) {
      const k = i < hits ? keys[i] : keys[(i * 31) % N_KEYS];
      const v = cache.get(k);
      if (v !== undefined) { acc += v[0]; continue; }
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
      cache.set(k, [i]);
    }
    const ms = performance.now() - t0;

    // pure string hashing reference: build the same keys again
    const t1 = performance.now();
    let h = 0;
    for (let i = 0; i < OPS; i++) h = (h + keys[(i * 7) % N_KEYS].length) | 0;
    const rebuildMs = performance.now() - t1;

    writeJson(`${LOG}/cache_wiring_microbench.json`, {
      note: 'NON_EVIDENCE for engine work; measures only the generic Map+string cost a cache must pay.',
      keyBytes: KEY_LEN,
      entries: N_KEYS,
      ops: OPS,
      modeledHits: hits,
      mapMs: Math.round(ms * 10) / 10,
      perOpUs: Math.round((ms * 1000) / OPS * 100) / 100,
      lengthOnlyRefMs: Math.round(rebuildMs * 10) / 10,
      sink: acc + h,
    });
    console.log(`map=${ms.toFixed(1)}ms perOp=${((ms * 1000) / OPS).toFixed(2)}us`);
  });
});