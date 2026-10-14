/**
 * G0.4E-1.1 §7 (P0-2) — production leaf WIRING observation.
 *
 * The audited S7 tests proved wiring with resolver *identity*
 * (`resolveHardLeaf() === hybridEvaluateForCat`) plus "a trajectory exists".
 * That is not call evidence: `planHardCatTurn` defaults its leaf to
 * `opts.leafEvaluator ?? evaluateForCat` (hardTurnPlanner.ts:220), so a call
 * site that forgot to pass the resolved leaf would still run, still return a
 * trajectory, and still be "green" under an identity-only test.
 *
 * This file instruments the seam from the test side only (no production code is
 * touched, no new production seam is introduced):
 *   - `../hybridLeaf` is mocked so `resolveHardLeaf()` counts reads and returns
 *     the real leaf wrapped in a recorder of (state, value) pairs;
 *   - `../hardTurnPlanner` is mocked so the options object the PRODUCTION call
 *     site passes into the search is captured before delegating to the real
 *     planner — that is where `leafEvaluator` actually arrives.
 *
 * Evidence is behavioural, in both directions, so an accidental agreement of
 * the two models cannot pass it: in Hybrid V1 mode the evaluator the search
 * uses must return the ValueNet-blended value (and therefore DIFFER from
 * `evaluateForCat`) on eligible states; in baseline mode it must return the raw
 * heuristic. Out-of-domain states must fail closed leaf-by-leaf *inside* the
 * real search.
 *
 * NOTE: `../hybridLeaf` is mocked here, so resolver-identity claims
 * (`resolveHardLeaf()` returns exactly `evaluateForCat`, S1/S8) live in
 * `hybridLeaf.test.ts` instead — mocking would turn those into wrapper
 * comparisons and quietly weaken them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInitialState, endTurn, computeCatAiTrajectory, catAiMove, type GameEngineState,
} from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty } from '../../types';
import { evaluateForCat } from '../evaluation';
import { hybridEvaluateForCat, isHybridEligibleState } from '../hybridLeaf';
import { HARD_LEAF_MODE_CONFIG } from '../searchConfig';

type LeafFn = (state: GameEngineState) => number;
type LeafCall = { state: GameEngineState; out: number };
type PlannerCall = { state: GameEngineState; opts: { leafEvaluator?: LeafFn } };

const rec = vi.hoisted(() => ({
  calls: [] as Array<{ state: unknown; out: number }>,
  plans: [] as Array<{ state: unknown; opts: unknown }>,
  resolverReads: 0,
  reset(): void {
    this.calls = [];
    this.plans = [];
    this.resolverReads = 0;
  },
}));

vi.mock('../hybridLeaf', async (importActual) => {
  const actual = await importActual<typeof import('../hybridLeaf')>();
  return {
    ...actual,
    resolveHardLeaf: (): LeafFn => {
      rec.resolverReads++;
      const real = actual.resolveHardLeaf();
      return (state: GameEngineState): number => {
        const out = real(state);
        rec.calls.push({ state, out });
        return out;
      };
    },
  };
});

vi.mock('../hardTurnPlanner', async (importActual) => {
  const actual = await importActual<typeof import('../hardTurnPlanner')>();
  return {
    ...actual,
    planHardCatTurn: ((state: GameEngineState, opts: Parameters<typeof actual.planHardCatTurn>[1]) => {
      rec.plans.push({ state, opts });
      return actual.planHardCatTurn(state, opts);
    }) satisfies typeof actual.planHardCatTurn,
  };
});

const calls = (): LeafCall[] => rec.calls as LeafCall[];
const plans = (): PlannerCall[] => rec.plans as PlannerCall[];

/** The leafEvaluator the production call site handed to the search (last call). */
function passedEvaluator(): LeafFn {
  const last = plans()[plans().length - 1];
  const fn = last?.opts?.leafEvaluator;
  if (typeof fn !== 'function') {
    throw new Error('the production call site passed no explicit leafEvaluator — it is relying on hardTurnPlanner\'s `?? evaluateForCat` default');
  }
  return fn;
}

function freshState(overrides: Record<string, unknown> = {}): GameEngineState {
  return createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard, ...overrides } as Parameters<typeof createInitialState>[0]);
}

/** A hard state OUTSIDE the frozen 808-feature domain (a wall cell), everything
 *  else canonical — the search can never route it through the model. */
function walledState(): GameEngineState {
  const st = freshState();
  st.board[5][5] = { ...st.board[5][5], type: 'wall' as never };
  return st;
}

/** Probe states spanning both sides of the eligibility gate. */
function probes(): GameEngineState[] {
  const base = freshState();
  return [
    base,
    { ...base, pendingButterSpawns: [{ r: 2, c: 3, blockedMaterializations: 0 }] } as GameEngineState,
    { ...base, pendingButterPlacementDebt: 2 } as GameEngineState,
    walledState(),
    createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Easy } as Parameters<typeof createInitialState>[0]),
  ];
}

function withMode<T>(mode: 'baseline' | 'hybrid_standard_only', fn: () => T): T {
  HARD_LEAF_MODE_CONFIG.current = mode;
  try {
    return fn();
  } finally {
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
  }
}

describe('G0.4E-1.1 §7 production leaf wiring (observation)', () => {
  beforeEach(() => {
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
    rec.reset();
  });

  it('O1: the observer is not vacuous — the production entries read the resolver, pass a leaf and evaluate leaves', () => {
    withMode('hybrid_standard_only', () => computeCatAiTrajectory(endTurn(freshState())));
    expect(rec.resolverReads).toBeGreaterThan(0);
    expect(plans().length).toBeGreaterThan(0);
    expect(calls().length).toBeGreaterThan(0);
  });

  it('O2: Hybrid V1 mode — the evaluator that reaches the search computes the model value, not the heuristic', () => {
    withMode('hybrid_standard_only', () => computeCatAiTrajectory(endTurn(freshState())));
    const ev = passedEvaluator();
    const eligible = probes().filter(isHybridEligibleState);
    const gated = probes().filter((s) => !isHybridEligibleState(s));
    expect(eligible.length).toBeGreaterThan(0);
    expect(gated.length).toBeGreaterThan(0);

    // What the search was given IS the V1 leaf: identical values on every probe…
    for (const s of probes()) expect(ev(s)).toBe(hybridEvaluateForCat(s));
    // …and demonstrably NOT the baseline default it could have silently used.
    const diverging = eligible.filter((s) => ev(s) !== evaluateForCat(s));
    expect(diverging.length).toBeGreaterThan(0);
  });

  it('O3: Hybrid V1 mode — the search itself scores leaves through that evaluator (model influenced real nodes)', () => {
    withMode('hybrid_standard_only', () => computeCatAiTrajectory(endTurn(freshState())));
    const c = calls();
    expect(c.length).toBeGreaterThan(0);
    for (const { state, out } of c) expect(out).toBe(hybridEvaluateForCat(state));
    const hybridized = c.filter(({ state, out }) => isHybridEligibleState(state) && out !== evaluateForCat(state));
    expect(hybridized.length).toBeGreaterThan(0);
  });

  it('O4: baseline mode — the search scores every leaf exactly as evaluateForCat (default production path)', () => {
    withMode('baseline', () => computeCatAiTrajectory(endTurn(freshState())));
    expect(rec.resolverReads).toBeGreaterThan(0);
    const ev = passedEvaluator();
    // In baseline mode the resolved leaf IS the heuristic: identical on every
    // probe, including the eligible ones where V1 would diverge.
    for (const s of probes()) expect(ev(s)).toBe(evaluateForCat(s));
    const c = calls();
    expect(c.length).toBeGreaterThan(0);
    for (const { state, out } of c) expect(out).toBe(evaluateForCat(state));
    // Raw heuristic magnitudes are far outside the hybrid's [-1, 1] band, so the
    // two modes cannot be coincidentally identical here.
    expect(c.some(({ out }) => Math.abs(out) > 1)).toBe(true);
  });

  it('O5: an out-of-domain root fails closed leaf-by-leaf INSIDE the real search', () => {
    withMode('hybrid_standard_only', () => computeCatAiTrajectory(endTurn(walledState())));
    const c = calls();
    expect(c.length).toBeGreaterThan(0);
    expect(isHybridEligibleState(plans()[0].state)).toBe(false);
    for (const { state, out } of c) {
      expect(isHybridEligibleState(state)).toBe(false);
      expect(out).toBe(evaluateForCat(state));
    }
  });

  it('O5b: the O5 fall-back is caused by the domain gate, not by an inert seam (same root, wall removed)', () => {
    withMode('hybrid_standard_only', () => computeCatAiTrajectory(endTurn(walledState())));
    const walled = calls().filter(({ state, out }) => isHybridEligibleState(state) && out !== evaluateForCat(state)).length;
    rec.reset();
    withMode('hybrid_standard_only', () => computeCatAiTrajectory(endTurn(freshState())));
    const clean = calls().filter(({ state, out }) => isHybridEligibleState(state) && out !== evaluateForCat(state)).length;
    expect(walled).toBe(0);
    expect(clean).toBeGreaterThan(0);
  });

  it('O6: catAiMove (the step-by-step entry) wires the same resolved leaf', () => {
    withMode('hybrid_standard_only', () => {
      const next = catAiMove(endTurn(freshState()));
      expect(next).toBeTruthy();
      expect(next!.currentPlayer).toBe('cat');
      expect(rec.resolverReads).toBeGreaterThan(0);
      const ev = passedEvaluator();
      for (const s of probes()) expect(ev(s)).toBe(hybridEvaluateForCat(s));
      const c = calls();
      expect(c.length).toBeGreaterThan(0);
      for (const { state, out } of c) expect(out).toBe(hybridEvaluateForCat(state));
      expect(c.some(({ state, out }) => isHybridEligibleState(state) && out !== evaluateForCat(state))).toBe(true);
    });

    rec.reset();
    withMode('baseline', () => {
      expect(catAiMove(endTurn(freshState()))).toBeTruthy();
      const c = calls();
      expect(c.length).toBeGreaterThan(0);
      for (const { state, out } of c) expect(out).toBe(evaluateForCat(state));
    });
  });

  it('O7: both Hard entries still run under both modes (no plan-shape coupling)', () => {
    for (const mode of ['baseline', 'hybrid_standard_only'] as const) {
      withMode(mode, () => {
        const cat = endTurn(freshState());
        expect(computeCatAiTrajectory(cat)).toBeTruthy();
        const moved = catAiMove(cat);
        // A null step is a legal engine outcome (stuck / no solution), never a
        // wiring failure — the wiring is proven by O1-O6.
        if (moved !== null) expect(moved.currentPlayer).toBe('cat');
      });
    }
  });
});
