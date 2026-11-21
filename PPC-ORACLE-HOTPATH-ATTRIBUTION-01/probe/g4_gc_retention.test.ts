/// <reference types="node" />
/**
 * Why is the cached variant slower when the map ops themselves cost ~3 ms?
 * Measure GC activity and heap retention for the same root with and without the
 * solve-local cache. NON-EVIDENCE for search semantics; descriptive only.
 */
import { describe, it } from 'vitest';
import { LOG, QCAP_LOCAL, planFrontier, writeJson } from './hotpath_lib';
import { solveInstrumentedReal } from './seal_instrumented';
import type { GameEngineState } from '../../src/game/engine';

const H = 2;
const START = 1;
const CAP = QCAP_LOCAL;

function withGc<T>(fn: () => T) {
  let runs = 0;
  let pauseMs = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) { runs++; pauseMs += e.duration; }
  });
  try { obs.observe({ entryTypes: ['gc'] }); } catch { /* unsupported */ }
  const t0 = performance.now();
  const out = fn();
  const wall = performance.now() - t0;
  obs.disconnect();
  return { out, gc: { runs, pauseMs: Math.round(pauseMs * 10) / 10 }, wall: Math.round(wall * 10) / 10 };
}

describe('cache slowdown attribution', () => {
  it('DUUD: GC and heap retention, uncached vs cached', () => {
    const { state } = planFrontier('DUUD');
    const before = process.memoryUsage();

    const a = withGc(() => solveInstrumentedReal(state, H, START, CAP, 'mouseForce' as const));
    const mid = process.memoryUsage();
    const cache = new Map<string, import('../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib').Transition<GameEngineState>[]>();
    const b = withGc(() => solveInstrumentedReal(state, H, START, CAP, 'mouseForce' as const, { actionCache: cache, cacheCap: 20_000 }));
    const after = process.memoryUsage();

    const mb = (x: number) => Math.round(x / 1048576);
    writeJson(`${LOG}/g4_gc_retention.json`, {
      root: 'DUUD/mouseForce',
      cacheCap: 20_000,
      cacheHits: b.out.counters.cacheHits,
      cacheSize: cache.size,
      uncached: { wallMs: a.wall, elapsedMs: Math.round(a.out.stats.elapsedMs), selfMs: Math.round(a.out.counters.selfMs), gc: a.gc },
      cached: { wallMs: b.wall, elapsedMs: Math.round(b.out.stats.elapsedMs), selfMs: Math.round(b.out.counters.selfMs), gc: b.gc },
      heapMB: { before: mb(before.heapUsed), afterUncached: mb(mid.heapUsed), afterCached: mb(after.heapUsed) },
      rssMB: { before: mb(before.rss), afterUncached: mb(mid.rss), afterCached: mb(after.rss) },
      note: 'Non-deterministic GC timing; interpreted only as a direction, never as a gate.',
    });
    console.log('uncached', JSON.stringify(a.gc), 'cached', JSON.stringify(b.gc));
  });
});