/// <reference types="node" />
/**
 * G3 — key-equivalence gate for any solve-local action cache.
 *
 * The candidate key is `stateKey(s)` (order-canonicalized, debug fields
 * excluded). The gate checks, on EVERY repeated expansion inside a real solve,
 * that the transition signature produced for that stateKey is identical
 * (same action order, same weights, same child stateKeys). Any mismatch would
 * mean the key is insufficient and a cache keyed by it would be unsound.
 *
 * The second test forces a real multi-positive-outcome CHANCE transition
 * through the cache path and compares it item by item.
 */
import { describe, it, expect } from 'vitest';
import { LOG, QCAP_LOCAL, planFrontier, writeJson, digestPolicy } from './hotpath_lib';
import { solveInstrumentedReal } from './seal_instrumented';
import { rules } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { stateKey } from '../../src/game/ai/transposition';
import type { GameEngineState } from '../../src/game/engine';
import type { Mode } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import type { Transition } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

type Prepared = ReturnType<typeof generatePreparedSearchActions>[number];

const H = 2;
const START = 1;
const CAP = QCAP_LOCAL;

const targets = [
  { plan: 'DUUD', mode: 'mouseForce' as Mode },
  { plan: 'UURR', mode: 'mouseForce' as Mode },
  { plan: 'DRRR', mode: 'mouseForce' as Mode },
  { plan: 'DRRR', mode: 'catSurvive' as Mode },
  { plan: 'LLLD', mode: 'mouseForce' as Mode },
] as const;

describe('G3 key equivalence', () => {
  it('every repeated stateKey expands to the same transition signature', () => {
    const rows: Record<string, unknown> = {};
    let totalRepeats = 0;

    for (const t of targets) {
      const { state } = planFrontier(t.plan);
      const base = solveInstrumentedReal(state, H, START, CAP, t.mode);
      const sig = solveInstrumentedReal(state, H, START, CAP, t.mode, { repeatSignatureCheck: true });
      const b = base.counters;
      const s = sig.counters;
      const id = `${t.plan}/${t.mode}`;
      const repeats = b.repeatExpansionsSameIdx + b.repeatExpansionsDiffIdx;

      expect(sig.value, id).toBe(base.value);
      expect(sig.stats.nodes, id).toBe(base.stats.nodes);
      expect(sig.stats.transitions, id).toBe(base.stats.transitions);
      expect(sig.stats.chanceNodes, id).toBe(base.stats.chanceNodes);
      expect(sig.stats.chanceOutcomes, id).toBe(base.stats.chanceOutcomes);
      expect(sig.stats.memoHits, id).toBe(base.stats.memoHits);
      expect(sig.stats.cutoffs, id).toBe(base.stats.cutoffs);
      expect(sig.stats.truncated, id).toBe(base.stats.truncated);
      expect(sig.stats.maxIdx, id).toBe(base.stats.maxIdx);
      expect(digestPolicy(sig.policy), id).toBe(digestPolicy(base.policy));

      expect(s.repeatSigChecks, id).toBe(repeats);
      expect(s.repeatSigMismatches, id).toBe(0);
      totalRepeats += repeats;

      rows[id] = {
        value: base.value,
        expansions: b.expansions,
        distinctKeys: b.distinctExpansionKeys,
        repeats,
        repeatsSameIdx: b.repeatExpansionsSameIdx,
        repeatsDiffIdx: b.repeatExpansionsDiffIdx,
        potentialHitRate: b.expansions > 0
          ? Math.round(((b.expansions - b.distinctExpansionKeys) / b.expansions) * 10000) / 10000 : 0,
        signatureChecks: s.repeatSigChecks,
        signatureMismatches: s.repeatSigMismatches,
        firstMismatch: s.repeatSigFirstMismatch,
      };
    }

    writeJson(`${LOG}/g3_key_equivalence.json`, {
      key: 'stateKey(s) (idx excluded; transitions do not read idx/H/mode)',
      method: 'for every expansion whose stateKey was expanded before in the same solve, the newly generated transition list is serialized as label[weight:childStateKey,...] and compared with the first occurrence',
      totalRepeats,
      targets: rows,
    });
    expect(totalRepeats).toBeGreaterThan(0);
  });

  it('forced CHANCE witness: a real multi-outcome transition survives the cache path item by item', () => {
    const { state: frontier } = planFrontier('DUUD');
    const found = findChanceState(frontier, 3, 400);
    expect(found, 'no multi-outcome chance transition found near the DUUD frontier').not.toBeNull();
    const { state, prepared } = found!;
    const label = labelOf(prepared.action);

    expect(prepared.transition.kind).toBe('chance');
    const outcomes = prepared.transition.kind === 'chance' ? prepared.transition.outcomes : [];
    expect(outcomes.filter((o) => o.weight > 0).length).toBeGreaterThanOrEqual(2);

    // Seed the cache with this state's transition list, then solve FROM that
    // state: the root expansion is a guaranteed hit, so the shadow gate
    // compares the cached chance list against a fresh regeneration.
    const cache = new Map<string, Transition<GameEngineState>[]>();
    const seeded = generatePreparedSearchActions(state, rules);
    cache.set(stateKey(state), seeded.map((p) => {
      const tr = p.transition;
      return tr.kind === 'deterministic'
        ? { label: labelOf(p.action), outcomes: [{ state: tr.state, weight: 1 }] }
        : { label: labelOf(p.action), outcomes: tr.outcomes.map((o) => ({ state: o.state, weight: o.weight })) };
    }));
    const shadow = solveInstrumentedReal(state, H, START, 5000, 'mouseForce', {
      actionCache: cache, shadowCompare: true,
    });
    expect(shadow.counters.shadowChecks).toBeGreaterThanOrEqual(1);
    expect(shadow.counters.shadowChanceChecks).toBeGreaterThanOrEqual(1);
    expect(shadow.counters.shadowMismatches).toBe(0);

    const pairs = prepared.transition.kind === 'chance'
      ? prepared.transition.outcomes.map((o) => ({ weight: o.weight, stateKey: stateKey(o.state) }))
      : [];
    writeJson(`${LOG}/g3_chance_witness.json`, {
      plan: 'DUUD',
      label,
      positiveOutcomes: pairs.filter((p) => p.weight > 0).length,
      totalOutcomes: pairs.length,
      outcomes: pairs,
      shadow: {
        checks: shadow.counters.shadowChecks,
        chanceChecks: shadow.counters.shadowChanceChecks,
        mismatches: shadow.counters.shadowMismatches,
      },
    });
  });
});

function labelOf(a: { type: string; direction?: { key: string }; r?: number; c?: number }): string {
  const m: Record<string, string> = { catPlaceTrap: 'T', mouseSkill: 'S' };
  if (m[a.type]) return m[a.type];
  if (a.type === 'chooseTunnel') return `t${a.r},${a.c}`;
  const d: Record<string, string> = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' };
  return d[a.direction?.key ?? ''] ?? '?';
}

function findChanceState(root: GameEngineState, depth: number, limit: number): { state: GameEngineState; prepared: Prepared } | null {
  let frontier: GameEngineState[] = [root];
  const seen = new Set<string>([stateKey(root)]);
  for (let d = 0; d < depth; d++) {
    const next: GameEngineState[] = [];
    for (const s of frontier) {
      const prepared = generatePreparedSearchActions(s, rules);
      for (const p of prepared) {
        if (p.transition.kind === 'chance' && p.transition.outcomes.filter((o) => o.weight > 0).length >= 2) {
          return { state: s, prepared: p };
        }
      }
      for (const p of prepared) {
        const outs = p.transition.kind === 'deterministic'
          ? [p.transition.state]
          : p.transition.outcomes.filter((o) => o.weight > 0).map((o) => o.state);
        for (const o of outs) {
          const k = stateKey(o);
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(o);
          if (seen.size > limit) return null;
        }
      }
    }
    frontier = next;
  }
  return null;
}