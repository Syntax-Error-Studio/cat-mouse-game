/**
 * PPC-MCTS-01 — honest CHANCE validation and sampling.
 *
 * Every `SearchTransitionResult` of kind `chance` is validated BEFORE a sample
 * is drawn:
 *   1. non-empty outcome list,
 *   2. every weight is finite and strictly > 0,
 *   3. probabilities sum to 1 (floating tolerance 1e-9).
 * A violation is a hard error: the prototype never silently repairs a bad
 * distribution and never falls back to a hidden random draw.
 *
 * The caller supplies the MCTS-owned seeded PRNG; `Math.random` is never used.
 */
import type { SearchTransitionResult } from '../../src/game/ai/searchTypes';
import type { GameEngineState } from '../../src/game/engine';
import type { Rng } from './seededRng';
import { sampleWeighted } from './seededRng';

export interface ChanceOutcome {
  state: GameEngineState;
  weight: number;
}

export interface ValidatedChance {
  outcomes: ChanceOutcome[];
  weights: number[];
  /** Largest |sum(weights) - 1| observed for this node. */
  massError: number;
}

const MASS_TOL = 1e-9;

export function validateChance(
  outcomes: { state: GameEngineState; weight: number }[],
): ValidatedChance {
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    throw new Error('CHANCE_INVALID: empty outcome list');
  }
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const w = outcomes[i].weight;
    if (!Number.isFinite(w) || !(w > 0)) {
      throw new Error(`CHANCE_INVALID: outcome ${i} weight=${String(w)} (must be finite and > 0)`);
    }
    weights.push(w);
    sum += w;
  }
  const massError = Math.abs(sum - 1);
  if (!(massError <= MASS_TOL)) {
    throw new Error(`CHANCE_INVALID: probability mass=${sum} (|sum-1|=${massError} > ${MASS_TOL})`);
  }
  return { outcomes: outcomes.slice(), weights, massError };
}

export function validateTransitionChance(
  res: Extract<SearchTransitionResult, { kind: 'chance' }>,
): ValidatedChance {
  return validateChance(res.outcomes);
}

/** Draw one outcome index by the validated weights. */
export function sampleChance(chance: ValidatedChance, rng: Rng): number {
  return sampleWeighted(chance.weights, rng);
}
