/// <reference types="node" />
/**
 * G4 — baseline vs prototype: item-for-item parity, frozen certificates, and a
 * paired ABBA wall-clock comparison in a fresh process.
 *
 * The cache is the same solve-local prototype validated by the G3 shadow gate:
 * key = stateKey(s), lifetime = one solve(), FIFO cap 20,000, guard-memory
 * states bypass it. This file never changes the frozen kernel, caps, roots or
 * quantifiers.
 */
import { describe, it, expect } from 'vitest';
import {
  LOG, QCAP_LOCAL, planFrontier, writeJson, digestPolicy,
} from './hotpath_lib';
import { solveInstrumentedReal } from './seal_instrumented';
import { verifyMouseCertificate, verifyCatCertificate } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import type { GameEngineState } from '../../src/game/engine';
import type { Mode } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

const H = 2;
const START = 1;
const CAP = QCAP_LOCAL;
const CACHE_CAP = 20_000;
const REP = process.env.REP ?? '1';

const targets: { plan: 'DUUD' | 'UURR' | 'DRRR' | 'LLLD'; mode: Mode }[] = [
  { plan: 'DUUD', mode: 'mouseForce' },
  { plan: 'UURR', mode: 'mouseForce' },
  { plan: 'DRRR', mode: 'mouseForce' },
  { plan: 'DRRR', mode: 'catSurvive' },
  { plan: 'LLLD', mode: 'mouseForce' },
];

function runCached(state: GameEngineState, mode: Mode) {
  const cache = new Map<string, import('../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib').Transition<GameEngineState>[]>();
  return solveInstrumentedReal(state, H, START, CAP, mode, { actionCache: cache, cacheCap: CACHE_CAP });
}

describe(`G4 parity (rep ${REP})`, () => {
  it('cache changes no boolean, node count, transition count, policy label or certificate', () => {
    const rows: Record<string, unknown> = {};
    for (const t of targets) {
      const { state } = planFrontier(t.plan);
      const id = `${t.plan}/${t.mode}`;
      const base = solveInstrumentedReal(state, H, START, CAP, t.mode);
      const proto = runCached(state, t.mode);

      expect(proto.value, id).toBe(base.value);
      expect(proto.stats.nodes, id).toBe(base.stats.nodes);
      expect(proto.stats.transitions, id).toBe(base.stats.transitions);
      expect(proto.stats.chanceNodes, id).toBe(base.stats.chanceNodes);
      expect(proto.stats.chanceOutcomes, id).toBe(base.stats.chanceOutcomes);
      expect(proto.stats.memoHits, id).toBe(base.stats.memoHits);
      expect(proto.stats.cutoffs, id).toBe(base.stats.cutoffs);
      expect(proto.stats.truncated, id).toBe(base.stats.truncated);
      expect(proto.stats.maxIdx, id).toBe(base.stats.maxIdx);
      expect(digestPolicy(proto.policy), id).toBe(digestPolicy(base.policy));

      let cert: { verdict: string; leaves?: number; policyMisses?: number; counterexample?: string[] | null } | null = null;
      if (t.mode === 'mouseForce' && proto.value === true) {
        const v = verifyMouseCertificate(state, proto.policy, H, START, CAP);
        expect(v.verdict, id).toBe('PROVEN');
        expect(v.counterexample, id).toBe(null);
        cert = { verdict: v.verdict, leaves: v.leaves, policyMisses: v.policyMisses, counterexample: v.counterexample };
      } else if (t.mode === 'catSurvive' && proto.value === true) {
        const v = verifyCatCertificate(state, proto.policy, H, START, CAP);
        expect(v.verdict, id).toBe('PROVEN');
        expect(v.counterexample, id).toBe(null);
        cert = { verdict: v.verdict, leaves: v.leaves, policyMisses: v.policyMisses, counterexample: v.counterexample };
      }

      const c = proto.counters;
      rows[id] = {
        value: proto.value,
        identicalCounters: true,
        policyDigest: digestPolicy(proto.policy),
        certificate: cert,
        cache: {
          hits: c.cacheHits, misses: c.cacheMisses, evictions: c.cacheEvictions, size: c.cacheSize,
          hitRate: (c.cacheHits + c.cacheMisses) > 0
            ? Math.round((c.cacheHits / (c.cacheHits + c.cacheMisses)) * 10000) / 10000 : 0,
        },
        base: { selfMs: Math.round(base.counters.selfMs * 10) / 10, elapsedMs: Math.round(base.stats.elapsedMs * 10) / 10 },
        proto: { selfMs: Math.round(c.selfMs * 10) / 10, elapsedMs: Math.round(c.elapsedMs * 10) / 10 },
      };
    }
    writeJson(`${LOG}/g4_parity_r${REP}.json`, {
      note: 'Every cached-hit transition list was item-by-item compared in G3 (shadow gate); this file compares full solve artifacts.',
      targets: rows,
    });
  });
});

describe(`G4 paired performance (rep ${REP})`, () => {
  it('ABBA per root measures the cache against an identical-work baseline', () => {
    const roots: { plan: 'DUUD' | 'UURR' | 'DRRR' | 'LLLD'; mode: Mode }[] = [
      { plan: 'DUUD', mode: 'mouseForce' },
      { plan: 'UURR', mode: 'mouseForce' },
      { plan: 'DRRR', mode: 'mouseForce' },
      { plan: 'LLLD', mode: 'mouseForce' },
    ];
    const order: ('A' | 'B')[] = ['A', 'B', 'B', 'A'];
    const rows: Record<string, unknown> = {};

    for (const t of roots) {
      const { state } = planFrontier(t.plan);
      const times: Record<'A' | 'B', number[]> = { A: [], B: [] };
      const rss: Record<'A' | 'B', number[]> = { A: [], B: [] };
      const nodes: Record<'A' | 'B', number[]> = { A: [], B: [] };
      for (const letter of order) {
        const before = process.memoryUsage().rss;
        const r = letter === 'A'
          ? solveInstrumentedReal(state, H, START, CAP, t.mode)
          : runCached(state, t.mode);
        const after = process.memoryUsage().rss;
        times[letter].push(Math.round(r.stats.elapsedMs * 10) / 10);
        nodes[letter].push(r.stats.nodes);
        rss[letter].push(Math.round(Math.max(before, after) / 1048576));
      }
      expect(nodes.A[0]).toBe(nodes.B[0]);
      expect(nodes.A[1]).toBe(nodes.B[1]);
      const ratio = (times.B[0] + times.B[1]) / (times.A[0] + times.A[1]);
      rows[`${t.plan}/${t.mode}`] = {
        order: order.join(''),
        timesMs: times,
        rssMB: rss,
        nodes: nodes.A[0],
        ratioBoverA: Math.round(ratio * 10000) / 10000,
        improvementPct: Math.round((1 - ratio) * 10000) / 100,
      };
    }

    writeJson(`${LOG}/perf_r${REP}.json`, {
      rep: Number(REP),
      design: 'ABBA within one fresh process per root; ratio = (B1+B2)/(A1+A2) cancels linear drift',
      A: 'baseline instrumented kernel (no cache)',
      B: 'same kernel + solve-local action cache (cap 20,000)',
      pid: process.pid,
      rows,
    });
  });
});

