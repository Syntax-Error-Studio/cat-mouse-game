/**
 * PPC-P1-CHECKPOINT-01 · CP-1 / CP-2 — numeric safety of the cat-turn plan bound.
 *
 * The bound is `B(M) = M + 1 + floor(M/2)`, with `M = catMovesLeft`.
 * `hasCertifiableCatMoveBudget` used to accept any non-negative SAFE integer M.
 * That is not sufficient: B is three-halves of M, so the largest M whose bound is
 * still a safe integer is well below `Number.MAX_SAFE_INTEGER`.
 *
 *   M = 6004799503160660  ⇒  B = 9007199254740991 = Number.MAX_SAFE_INTEGER   safe
 *   M = 6004799503160661  ⇒  B = 9007199254740992 = 2^53                    UNSAFE
 *
 * Everything here is function-level. No game search is run, no plan is replayed
 * over trillions of steps — the inputs are absurd on purpose and the contract is
 * about refusing them, not about exploring them.
 *
 * Run: npx vitest run --config PPC-P1-CHECKPOINT-01/probe/vitest.config.mts
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateGameConfig } from '../../src/game/config';
import type { GameConfig } from '../../src/game/config';
import { createEngineRuleSet, createInitialState } from '../../src/game/engine';
import { createGameState } from '../../src/game/newGame';
import { buildCatTurnPlan, createSearchContext } from '../../src/game/ai/expectiminimax';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import {
  buildCandidate,
  buildPlanForFirstAction,
  extractBestCatTurnPlan,
  planFullTurnCompleteness,
  type EqualPrimaryGraph,
} from '../../src/game/ai/planQuality';
import {
  catTurnMoveBudget,
  hasCertifiableCatMoveBudget,
  maxCatTurnPlanActions,
} from '../../src/game/ai/planBound';
import { catTurnRoot } from '../../src/game/ai/__tests__/planActionBoundFixtures';

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991
const SAFE_EDGE = 6004799503160660;       // largest M with a safe bound
const UNSAFE_EDGE = 6004799503160661;     // smallest M with an unsafe bound

const rules = createEngineRuleSet();

const withCatBaseMoves = (catBaseMoves: number): GameConfig => ({ ...DEFAULT_CONFIG, catBaseMoves });

function catRoot(catMovesLeft?: number) {
  const root = catTurnRoot({ cat: { r: 1, c: 1 }, mouse: { r: 8, c: 8 } });
  return catMovesLeft === undefined ? root : { ...root, catMovesLeft };
}

function ctxFor() {
  const ctx = createSearchContext(rules, 50_000, false, false, false, 0, false);
  ctx.capturePlan = true;
  ctx.leafEvaluator = evaluateForCat;
  return ctx;
}

// ---------------------------------------------------------------------------
// A — the arithmetic itself (no production symbol involved; pins the premise)
// ---------------------------------------------------------------------------
describe('A · B(M) = M + 1 + floor(M/2) leaves the safe-integer range in between', () => {
  it('the two edge values are exactly as stated', () => {
    expect(Number.isSafeInteger(SAFE_EDGE)).toBe(true);
    expect(Number.isSafeInteger(UNSAFE_EDGE)).toBe(true);
    expect(SAFE_EDGE).toBe(6004799503160660);
    expect(UNSAFE_EDGE).toBe(6004799503160661);

    // Exact integer arithmetic, independent of float rounding.
    const bSafe = BigInt(SAFE_EDGE) + 1n + BigInt(SAFE_EDGE) / 2n;
    const bUnsafe = BigInt(UNSAFE_EDGE) + 1n + BigInt(UNSAFE_EDGE) / 2n;
    expect(bSafe).toBe(9007199254740991n);
    expect(bUnsafe).toBe(9007199254740992n);
    expect(bSafe).toBe(BigInt(MAX_SAFE));
    expect(bUnsafe).toBe(BigInt(2) ** 53n);
  });

  it('a safe M with an UNSAFE derived bound: float result is not the proven number', () => {
    const M = UNSAFE_EDGE;
    const floatBound = M + 1 + Math.floor(M / 2);
    const exact = BigInt(M) + 1n + BigInt(M) / 2n;
    expect(Number.isSafeInteger(floatBound)).toBe(false);
    expect(BigInt(floatBound)).toBe(exact);

    // Two steps further the float sum rounds AWAY from the exact value, so a
    // "safe" M can yield a cap that is not even the bound the proof promises.
    const M2 = 6004799503160663;
    const float2 = M2 + 1 + Math.floor(M2 / 2);
    const exact2 = BigInt(M2) + 1n + BigInt(M2) / 2n;
    expect(Number.isSafeInteger(M2)).toBe(true);
    expect(BigInt(float2)).not.toBe(exact2);
    expect(BigInt(float2)).toBeGreaterThan(exact2);
  });
});

// ---------------------------------------------------------------------------
// B — the production predicate must close the gap
// ---------------------------------------------------------------------------
describe('B · a state whose derived bound is unsafe is not certifiable', () => {
  it('accepts the largest safe edge and reports the exact MAX_SAFE bound', () => {
    const edge = catRoot(SAFE_EDGE);
    expect(hasCertifiableCatMoveBudget(edge)).toBe(true);
    expect(catTurnMoveBudget(edge)).toBe(SAFE_EDGE);
    expect(maxCatTurnPlanActions(edge)).toBe(MAX_SAFE);
    expect(Number.isSafeInteger(maxCatTurnPlanActions(edge))).toBe(true);
  });

  it('rejects the first M whose bound is 2^53', () => {
    const over = catRoot(UNSAFE_EDGE);
    expect(hasCertifiableCatMoveBudget(over)).toBe(false);
    // Fail-closed normalisation: zero moves, one-action bound — never a guess.
    expect(catTurnMoveBudget(over)).toBe(0);
    expect(maxCatTurnPlanActions(over)).toBe(1);
  });

  it('every extractor fails closed on the unsafe edge', () => {
    const ctx = ctxFor();
    const emptyGraph: EqualPrimaryGraph = new Map();
    const emptyBranches = new Map<string, never>();

    for (const M of [UNSAFE_EDGE, 6004799503160662, 6004799503160663, 2 ** 53 - 1]) {
      const over = catRoot(M);
      expect(hasCertifiableCatMoveBudget(over), `M=${M}`).toBe(false);
      expect(buildCatTurnPlan(over, ctx), `log walk M=${M}`).toEqual([]);
      expect(extractBestCatTurnPlan(over, rules, emptyGraph, emptyBranches), `DP M=${M}`).toEqual([]);
      const legal = generateLegalSearchActions(over, rules);
      expect(legal.length).toBeGreaterThan(0);
      expect(buildPlanForFirstAction(over, legal[0], ctx), `plan path M=${M}`).toEqual([]);
      expect(buildCandidate(over, legal[0], ctx, 0), `candidate M=${M}`).toBeNull();
      const verdict = planFullTurnCompleteness(over, [], rules);
      expect(verdict.kind, `completeness M=${M}`).toBe('TRUNCATED');
    }
  });

  it('the safe edge is NOT rejected as an invalid budget (gate is not a blanket refusal)', () => {
    const edge = catRoot(SAFE_EDGE);
    const ctx = ctxFor();
    expect(buildCatTurnPlan(edge, ctx)).toEqual([]);
    // An empty plan on a huge budget is a NORMAL truncation (moves remain and
    // legal actions exist) — never the "invalid cat move budget" rejection.
    const verdict = planFullTurnCompleteness(edge, [], rules);
    expect(verdict.kind).toBe('TRUNCATED');
    expect('reason' in verdict ? verdict.reason : '').not.toContain('invalid cat move budget');
  });
});

// ---------------------------------------------------------------------------
// C — the config layer closes the same gap, coherently with CLOSURE-FIX-01
// ---------------------------------------------------------------------------
describe('C · a config whose derived bound is unsafe fails closed at the config gate', () => {
  it('rejects the unsafe edge with the same actionable cat-budget issue', () => {
    const v = validateGameConfig(withCatBaseMoves(UNSAFE_EDGE));
    expect(v.ok).toBe(false);
    const catIssues = v.issues.filter((i) => i.message.includes('基础步数'));
    expect(catIssues.length).toBe(1);
    expect(catIssues[0].kind).toBe('invalid');
  });

  it('createGameState yields no state, createInitialState throws the budget RangeError', () => {
    const opening = createGameState(withCatBaseMoves(UNSAFE_EDGE));
    expect(opening.state).toBeNull();
    expect(opening.status.kind).toBe('unverified');
    // Must be OUR assertion, not an incidental crash: pre-fix this config runs
    // into `Maximum call stack size exceeded` inside mobility.ts, which is also
    // a RangeError. The message has to name the field.
    expect(() => createInitialState(withCatBaseMoves(UNSAFE_EDGE))).toThrow(/catBaseMoves/);
  });

  it('accepts the safe edge config and seeds the budget verbatim', () => {
    expect(validateGameConfig(withCatBaseMoves(SAFE_EDGE)).ok).toBe(true);
    const s = createInitialState(withCatBaseMoves(SAFE_EDGE));
    expect(s.catMovesLeft).toBe(SAFE_EDGE);
    expect(hasCertifiableCatMoveBudget(s)).toBe(true);
    expect(maxCatTurnPlanActions(s)).toBe(MAX_SAFE);
  });
});

// ---------------------------------------------------------------------------
// D — nothing changed for real budgets
// ---------------------------------------------------------------------------
describe('D · ordinary budgets are untouched', () => {
  it('the documented table still holds', () => {
    const table: Array<[number, number]> = [
      [0, 1], [1, 2], [2, 4], [3, 5], [4, 7], [5, 8], [6, 10], [7, 11], [9, 14], [12, 19],
    ];
    for (const [m, expected] of table) {
      expect(maxCatTurnPlanActions(catRoot(m)), `M=${m}`).toBe(expected);
      expect(catTurnMoveBudget(catRoot(m)), `M=${m}`).toBe(m);
      expect(hasCertifiableCatMoveBudget(catRoot(m)), `M=${m}`).toBe(true);
    }
    expect(maxCatTurnPlanActions(catRoot(1_000_000))).toBe(1_500_001);
  });

  it('the default 10×10 opening is unaffected by the numeric gate', () => {
    expect(validateGameConfig(DEFAULT_CONFIG).ok).toBe(true);
    const s = createInitialState({ ...DEFAULT_CONFIG, boxCount: 0, pileCount: 0, butterPositions: [{ r: 2, c: 3 }] });
    expect(s.catMovesLeft).toBe(4);
    expect(maxCatTurnPlanActions(s)).toBe(7);
  });
});
