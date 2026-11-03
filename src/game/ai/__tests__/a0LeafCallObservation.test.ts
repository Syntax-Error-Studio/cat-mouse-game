/// <reference types="node" />
/**
 * PPC-A0-DEV-01 §4(5) — production leaf WIRING observation for the A0 mode.
 *
 * Resolver-identity (`resolveHardLeaf() === a0ExpectedReturnEvaluateForCat`) is
 * proved in a0ExpectedReturnLeaf.test.ts (D2). Identity alone is not call
 * evidence: `planHardCatTurn` defaults its leaf to `opts.leafEvaluator ??
 * evaluateForCat` (hardTurnPlanner.ts:220), so a call site that forgot to pass
 * the resolved leaf would still run, still return a trajectory and still look
 * green. This file instruments the two REAL Hard entries the way
 * hybridLeafCallObservation.test.ts does — test side only, no production seam
 * is added:
 *   - `../hybridLeaf` is mocked so `resolveHardLeaf()` counts reads and records
 *     the (state, value) pairs the search actually scores;
 *   - `../hardTurnPlanner` is mocked so the options object the production call
 *     site passes into the search is captured.
 *
 * Evidence is behavioural in both directions: under the A0 mode the evaluator
 * the search uses must return the affine model value on eligible leaves (and
 * therefore differ from evaluateForCat there), while under baseline it must
 * return the raw heuristic. An out-of-domain root must fail closed leaf-by-leaf
 * inside the real search.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInitialState, endTurn, computeCatAiTrajectory, catAiMove, type GameEngineState,
} from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty } from '../../types';
import { evaluateForCat } from '../evaluation';
import { a0ExpectedReturnEvaluateForCat, isA0EligibleLeafState } from '../a0ExpectedReturnLeaf';
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

/** A hard root OUTSIDE the frozen A0 map domain (fixed butter layout), the rest
 *  canonical — the search can never route it through the model. */
function fixedButterState(): GameEngineState {
  return freshState({ butterPositions: [{ r: 5, c: 2 }, { r: 2, c: 8 }] });
}

/** Probe states spanning both sides of the eligibility gate. */
function probes(): GameEngineState[] {
  const base = freshState();
  return [
    base,
    { ...base, currentPlayer: 'cat' } as GameEngineState,
    { ...base, phase: 'cat_wins' } as never,
    { ...base, pendingButterSpawns: [{ r: 2, c: 3, blockedMaterializations: 0 }] } as GameEngineState,
    { ...base, pendingButterPlacementDebt: 2 } as GameEngineState,
    fixedButterState(),
    createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Easy } as Parameters<typeof createInitialState>[0]),
  ];
}

function withMode<T>(mode: 'baseline' | 'a0_expected_return_boundary_only', fn: () => T): T {
  HARD_LEAF_MODE_CONFIG.current = mode;
  try {
    return fn();
  } finally {
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
  }
}

const divergent = (list: LeafCall[]): LeafCall[] =>
  list.filter(({ state, out }) => isA0EligibleLeafState(state) && out !== evaluateForCat(state));

describe('PPC-A0-DEV-01 §4(5) production A0 leaf wiring (observation)', () => {
  beforeEach(() => {
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
    rec.reset();
  });

  it('W1: the observer is not vacuous — the production entries read the resolver, pass a leaf and score leaves', () => {
    withMode('a0_expected_return_boundary_only', () => computeCatAiTrajectory(endTurn(freshState())));
    expect(rec.resolverReads).toBeGreaterThan(0);
    expect(plans().length).toBeGreaterThan(0);
    expect(calls().length).toBeGreaterThan(0);
  });

  it('W2: A0 mode — the evaluator the call site hands the search computes the model value, not the heuristic', () => {
    withMode('a0_expected_return_boundary_only', () => computeCatAiTrajectory(endTurn(freshState())));
    const ev = passedEvaluator();
    const eligible = probes().filter(isA0EligibleLeafState);
    const gated = probes().filter((s) => !isA0EligibleLeafState(s));
    expect(eligible.length).toBeGreaterThan(0);
    expect(gated.length).toBeGreaterThan(0);
    for (const s of probes()) expect(Object.is(ev(s), a0ExpectedReturnEvaluateForCat(s))).toBe(true);
    const diverging = eligible.filter((s) => ev(s) !== evaluateForCat(s));
    expect(diverging.length).toBeGreaterThan(0);
    for (const s of gated) expect(Object.is(ev(s), evaluateForCat(s))).toBe(true);
  });

  it('W3: A0 mode — the search itself scores leaves through that evaluator (model influenced real nodes)', () => {
    withMode('a0_expected_return_boundary_only', () => computeCatAiTrajectory(endTurn(freshState())));
    const c = calls();
    expect(c.length).toBeGreaterThan(0);
    for (const { state, out } of c) expect(Object.is(out, a0ExpectedReturnEvaluateForCat(state))).toBe(true);
    expect(divergent(c).length).toBeGreaterThan(0);
  });

  it('W4: baseline mode — every leaf is scored exactly as evaluateForCat (default production path)', () => {
    withMode('baseline', () => computeCatAiTrajectory(endTurn(freshState())));
    expect(rec.resolverReads).toBeGreaterThan(0);
    const ev = passedEvaluator();
    for (const s of probes()) expect(Object.is(ev(s), evaluateForCat(s))).toBe(true);
    const c = calls();
    expect(c.length).toBeGreaterThan(0);
    for (const { state, out } of c) expect(Object.is(out, evaluateForCat(state))).toBe(true);
    expect(divergent(c).length).toBe(0);
    // Raw heuristic magnitudes sit far outside the model band, so the two modes
    // cannot be coincidentally identical on this root.
    expect(c.some(({ out }) => Math.abs(out) > 1)).toBe(true);
  });

  it('W5: an out-of-domain root fails closed leaf-by-leaf INSIDE the real search', () => {
    withMode('a0_expected_return_boundary_only', () => computeCatAiTrajectory(endTurn(fixedButterState())));
    const c = calls();
    expect(c.length).toBeGreaterThan(0);
    expect(isA0EligibleLeafState(plans()[0].state)).toBe(false);
    for (const { state, out } of c) {
      expect(isA0EligibleLeafState(state)).toBe(false);
      expect(Object.is(out, evaluateForCat(state))).toBe(true);
    }
  });

  it('W5b: the W5 fall-back is caused by the domain gate, not by an inert seam (same root, override removed)', () => {
    withMode('a0_expected_return_boundary_only', () => computeCatAiTrajectory(endTurn(fixedButterState())));
    const gated = divergent(calls()).length;
    rec.reset();
    withMode('a0_expected_return_boundary_only', () => computeCatAiTrajectory(endTurn(freshState())));
    const open = divergent(calls()).length;
    expect(gated).toBe(0);
    expect(open).toBeGreaterThan(0);
  });

  it('W6: catAiMove (the step-by-step entry) wires the same resolved leaf', () => {
    withMode('a0_expected_return_boundary_only', () => {
      const next = catAiMove(endTurn(freshState()));
      expect(next).toBeTruthy();
      expect(next!.currentPlayer).toBe('cat');
      expect(rec.resolverReads).toBeGreaterThan(0);
      const ev = passedEvaluator();
      for (const s of probes()) expect(Object.is(ev(s), a0ExpectedReturnEvaluateForCat(s))).toBe(true);
      const c = calls();
      expect(c.length).toBeGreaterThan(0);
      for (const { state, out } of c) expect(Object.is(out, a0ExpectedReturnEvaluateForCat(state))).toBe(true);
      expect(divergent(c).length).toBeGreaterThan(0);
    });

    rec.reset();
    withMode('baseline', () => {
      expect(catAiMove(endTurn(freshState()))).toBeTruthy();
      const c = calls();
      expect(c.length).toBeGreaterThan(0);
      for (const { state, out } of c) expect(Object.is(out, evaluateForCat(state))).toBe(true);
    });
  });

  it('W7: both Hard entries still run under both modes (no plan-shape coupling)', () => {
    for (const mode of ['baseline', 'a0_expected_return_boundary_only'] as const) {
      withMode(mode, () => {
        const cat = endTurn(freshState());
        expect(computeCatAiTrajectory(cat)).toBeTruthy();
        const moved = catAiMove(cat);
        // A null step is a legal engine outcome (stuck / no solution), never a
        // wiring failure — the wiring is proven by W1-W6.
        if (moved !== null) expect(moved.currentPlayer).toBe('cat');
      });
    }
  });
});
