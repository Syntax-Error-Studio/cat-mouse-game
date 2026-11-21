/// <reference types="node" />
/**
 * Smoke-only: validate the instrumented copy against the frozen kernel on a
 * TRUNCATED search (cap 3000). This is NOT evidence and NOT part of any gate —
 * it exists so a coding defect is caught while the host is below the heavy
 * admission floor.
 */
import { describe, it, expect } from 'vitest';
import { planFrontier, serializeCounters, writeJson, LOG } from './hotpath_lib';
import { solveInstrumentedReal } from './seal_instrumented';
import { mouseForcesWinSeal } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

describe('smoke (non-evidence)', () => {
  it('truncated DUUD instrumented == frozen', () => {
    const { state } = planFrontier('LLLD');
    const cap = 3000;
    const f = mouseForcesWinSeal(state, 2, 1, cap);
    const h = solveInstrumentedReal(state, 2, 1, cap, 'mouseForce');
    console.log('frozen', JSON.stringify(f.stats), serializeCounters(h.counters).elapsedMs);
    console.log('self', h.counters.selfMs, 'child', h.counters.childWalkMs, 'elapsed', h.counters.elapsedMs);
    writeJson(`${LOG}/smoke_parity.json`, {
      status: 'NON_EVIDENCE_SMOKE_ONLY',
      why: 'Host free physical memory below the 2.5 GiB admission floor; cap reduced to 3000 only to validate instrumentation.',
      cap,
      frozen: f.stats,
      instrumented: { stats: h.stats, counters: serializeCounters(h.counters) },
      equal: {
        truncated: h.stats.truncated === f.stats.truncated,
        nodes: h.stats.nodes === f.stats.nodes,
        transitions: h.stats.transitions === f.stats.transitions,
        chanceNodes: h.stats.chanceNodes === f.stats.chanceNodes,
        chanceOutcomes: h.stats.chanceOutcomes === f.stats.chanceOutcomes,
        memoHits: h.stats.memoHits === f.stats.memoHits,
        cutoffs: h.stats.cutoffs === f.stats.cutoffs,
        maxIdx: h.stats.maxIdx === f.stats.maxIdx,
      },
    });
    expect(h.stats.truncated).toBe(f.stats.truncated);
    expect(h.stats.nodes).toBe(f.stats.nodes);
    expect(h.stats.transitions).toBe(f.stats.transitions);
    expect(h.stats.chanceNodes).toBe(f.stats.chanceNodes);
    expect(h.stats.chanceOutcomes).toBe(f.stats.chanceOutcomes);
    expect(h.stats.memoHits).toBe(f.stats.memoHits);
    expect(h.stats.cutoffs).toBe(f.stats.cutoffs);
    expect(h.stats.maxIdx).toBe(f.stats.maxIdx);
  });
});