/**
 * PPC-MCTS-01 — independent seeded PRNG.
 *
 * The MCTS chance layer and the rollout policy MUST NOT touch Math.random, the
 * game WORLD entropy source, or any mouse-policy RNG. This module is the only
 * random source of the UCT prototype. Two streams are created per search
 * (chance + policy) from independent salts, so tuning one does not shift the
 * other.
 *
 * mulberry32: small, fast, deterministic, good enough for sampling weights.
 */

export interface Rng {
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(n: number): number {
      if (!Number.isInteger(n) || n <= 0) throw new Error(`rng.int bad n=${n}`);
      return Math.min(n - 1, Math.floor(next() * n));
    },
  };
}

/** FNV-1a 32-bit string hash, used only to derive reproducible seeds. */
export function hashString32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seedFor(parts: string[]): number {
  return hashString32(parts.join('|'));
}

/**
 * Weighted categorical draw. Returns the chosen index. Weights are assumed to
 * have been validated (finite, > 0, sum == 1). The final index is used as a
 * guard against floating-point residue.
 */
export function sampleWeighted(weights: number[], rng: Rng): number {
  const u = rng.next();
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (u < acc) return i;
  }
  return weights.length - 1;
}
