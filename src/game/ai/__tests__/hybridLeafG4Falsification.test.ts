/**
 * P0-1 acceptance evidence — the G4 S6 regression is MODEL-SENSITIVE.
 *
 * The audited S6 compared two pinned literals with each other, so no change to
 * the frozen ValueNet could ever make it fail. S6 (hybridLeaf.test.ts) now calls
 * the live production evaluator; this file proves that the rewritten claim
 * actually reacts to the model, by re-running the same restored G4 states under
 * a perturbed output layer.
 *
 * The perturbation is a test-local `vi.mock` of `../hybridWeights` (negating the
 * last layer). The real weights file is never touched, and nothing here changes
 * production behaviour: this module has its own registry, so its effect cannot
 * leak into `hybridLeaf.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { evaluateForCat } from '../evaluation';
import { g4Boundaries } from './fixtures/frozenFixtures';
import { G4_AUDIT_GOLDENS } from './fixtures/g4Goldens';

vi.mock('../hybridWeights', async (importActual) => {
  const actual = await importActual<typeof import('../hybridWeights')>();
  const neg = (a: Float64Array): Float64Array => Float64Array.from(a, (v) => -v);
  return { ...actual, HYBRID_W3f: neg(actual.HYBRID_W3f), HYBRID_b3: -actual.HYBRID_b3 };
});

// Imported AFTER the mock declaration so the leaf builds on perturbed weights.
const { hybridEvaluateForCat, productionValueNet, isHybridEligibleState } = await import('../hybridLeaf');

describe('P0-1 falsifiability of the rewritten G4 regression', () => {
  it('F1: under a perturbed output layer the frozen G4 pair REVERSES — so S6 can fail', () => {
    const { good, bad } = g4Boundaries();
    expect(isHybridEligibleState(good)).toBe(true);
    expect(isHybridEligibleState(bad)).toBe(true);

    const vGood = hybridEvaluateForCat(good);
    const vBad = hybridEvaluateForCat(bad);

    // The ordering claim S6 makes is now FALSE under the perturbed model.
    expect(vGood).toBeLessThan(vBad);
    // …and the audit goldens S6 pins no longer match either.
    expect(vGood).not.toBe(G4_AUDIT_GOLDENS.v1Good);
    expect(vBad).not.toBe(G4_AUDIT_GOLDENS.v1Bad);
    expect(productionValueNet(good)).not.toBe(G4_AUDIT_GOLDENS.vNetGood);
  });

  it('F2: the reversal is the model, not the fixture (heuristic leaf is untouched by it)', () => {
    const { good, bad } = g4Boundaries();
    // evaluateForCat has no model dependency, so its values (and its misrank of
    // this pair) survive the perturbation unchanged.
    expect(evaluateForCat(good)).toBeLessThan(evaluateForCat(bad));
    expect(hybridEvaluateForCat(good)).not.toBe(evaluateForCat(good));
  });
});
