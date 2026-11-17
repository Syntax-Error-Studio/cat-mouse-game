/**
 * PPC-P1-CLOSURE-FIX-01 — cat move-budget INPUT DOMAIN.
 *
 * The game rule is discrete: a cat turn is a sequence of unit-cost moves, a
 * `catPlaceTrap` costs none, and the turn hands off when the budget is spent.
 * `GameConfig.catBaseMoves` was typed `number` and reached `catMovesLeft`
 * verbatim, so a fractional / non-finite / negative value could become a running
 * game state:
 *
 *   - `2.5`  — `catMove` allows three steps (2.5 → 1.5 → 0.5 → −0.5) while the
 *              plan bound only budgets for `floor(2.5) = 2`;
 *   - `NaN`  — `NaN <= 0` is false, so the turn never hands off; worse, the
 *              completeness residual check `catMovesLeft > 0` is ALSO false, so
 *              a truncated one-action plan was certified COMPLETE;
 *   - `±Infinity` — an unbounded turn;
 *   - `0` / negative — a turn the cat can never act in.
 *
 * This file pins the three layers of the fix:
 *   1. `validateGameConfig` rejects the value (so `createGameState` fails closed
 *      with the existing `unverified` result type, `state: null`);
 *   2. `createInitialState` — the raw constructor — can no longer be used as a
 *      backdoor (explicit front assertion, never a silent clamp);
 *   3. every plan extractor refuses to certify a turn whose runtime
 *      `catMovesLeft` is not a non-negative safe integer.
 *
 * `catMovesLeft === 0` is a LEGITIMATE turn-boundary value and is deliberately
 * kept legal here — it must not be conflated with a corrupted budget.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateGameConfig } from '../config';
import type { GameConfig } from '../config';
import { createEngineRuleSet, createInitialState } from '../engine';
import { createGameState } from '../newGame';
import {
  buildCatTurnPlan,
  createSearchContext,
  type SearchContext,
} from '../ai/expectiminimax';
import { evaluateForCat } from '../ai/evaluation';
import { generateLegalSearchActions } from '../ai/legalActions';
import {
  buildCandidate,
  buildPlanForFirstAction,
  extractBestCatTurnPlan,
  planFullTurnCompleteness,
  type EqualPrimaryGraph,
} from '../ai/planQuality';
import {
  catTurnMoveBudget,
  hasCertifiableCatMoveBudget,
  MAX_CERTIFIABLE_CAT_MOVE_BUDGET,
  maxCatTurnPlanActions,
} from '../ai/planBound';
import { catTurnRoot } from '../ai/__tests__/planActionBoundFixtures';
import { stateKey } from '../ai/transposition';
import type { SearchAction } from '../ai/searchTypes';

const rules = createEngineRuleSet();

/** Accepted: a count of moves the cat can actually spend. */
const ACCEPTED = [1, 2, 4, 9, 12];

/** Rejected: everything that is not a positive safe integer. */
const REJECTED: number[] = [
  2.5,          // fractional
  0,            // no move at all
  -1,           // already spent
  -0.5,         // fractional negative
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  2 ** 53 + 2,  // not a safe integer
];

const withCatBaseMoves = (catBaseMoves: number): GameConfig => ({
  ...DEFAULT_CONFIG,
  catBaseMoves: catBaseMoves as number,
});

/** Deterministic butter so two constructions are comparable byte-for-byte. */
const FIXED_BUTTER = [{ r: 2, c: 3 }];

function ctxFor(): SearchContext {
  const ctx = createSearchContext(rules, 50_000, false, false, false, 0, false);
  ctx.capturePlan = true;
  ctx.leafEvaluator = evaluateForCat;
  return ctx;
}

/** A real Playing-Hard-Cat root with legal actions (flat 10×10 corridor). */
function catRoot(catMovesLeft?: number) {
  const root = catTurnRoot({ cat: { r: 1, c: 1 }, mouse: { r: 8, c: 8 } });
  return catMovesLeft === undefined ? root : { ...root, catMovesLeft };
}

// ---------------------------------------------------------------------------
// CF-1 / CF-2 — the config input domain
// ---------------------------------------------------------------------------
describe('CF-1/CF-2 · catBaseMoves is a positive safe integer or the config is rejected', () => {
  it('accepts every positive integer budget, including the production default', () => {
    expect(validateGameConfig(DEFAULT_CONFIG).ok, 'default config (M=4)').toBe(true);
    for (const moves of ACCEPTED) {
      const v = validateGameConfig(withCatBaseMoves(moves));
      expect(v.ok, `catBaseMoves=${moves} accepted`).toBe(true);
      expect(v.issues, `catBaseMoves=${moves} has no issues`).toEqual([]);
    }
  });

  it('rejects fractional, zero, negative, non-finite and unsafe budgets with one actionable issue', () => {
    for (const bad of REJECTED) {
      const v = validateGameConfig(withCatBaseMoves(bad));
      expect(v.ok, `catBaseMoves=${String(bad)} rejected`).toBe(false);
      const catIssues = v.issues.filter((i) => i.message.includes('基础步数'));
      expect(catIssues.length, `catBaseMoves=${String(bad)} names the cat budget`).toBe(1);
      expect(catIssues[0].kind).toBe('invalid');
    }
  });

  it('createGameState fails closed on an illegal budget — state null, never a playable match', () => {
    for (const bad of REJECTED) {
      const opening = createGameState(withCatBaseMoves(bad));
      expect(opening.state, `catBaseMoves=${String(bad)} has no state`).toBeNull();
      expect(opening.status.kind).toBe('unverified');
      if (opening.status.kind === 'unverified') {
        expect(opening.status.reason, `catBaseMoves=${String(bad)} reason`).toBe('INVALID_CONFIG');
        expect(opening.status.detail ?? '').toContain('基础步数');
      }
    }
  });

  it('does not reject any legal config field it does not own (layout validation still runs)', () => {
    // A bad budget must be reported alongside — not instead of — layout issues.
    const broken = { ...withCatBaseMoves(2.5), catStart: { r: 0, c: 99 } };
    const v = validateGameConfig(broken);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.message.includes('基础步数'))).toBe(true);
    expect(v.issues.some((i) => i.message.includes('初始位置越界'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CF-3 — the raw constructor is not a backdoor
// ---------------------------------------------------------------------------
describe('CF-3 · createInitialState cannot be used to bypass the budget contract', () => {
  it('throws an explicit RangeError instead of silently normalising', () => {
    for (const bad of REJECTED) {
      expect(
        () => createInitialState(withCatBaseMoves(bad)),
        `catBaseMoves=${String(bad)} must not construct a state`,
      ).toThrow(RangeError);
    }
  });

  it('still constructs every legal budget exactly as before', () => {
    for (const moves of ACCEPTED) {
      const s = createInitialState(withCatBaseMoves(moves));
      expect(s.catMovesLeft, `catBaseMoves=${moves}`).toBe(moves);
      expect(s.config.catBaseMoves).toBe(moves);
    }
  });

  it('leaves the default 10×10 opening byte-identical (same input ⇒ same stateKey)', () => {
    // Box/pile placement is random, so determinism is pinned on a config with a
    // fixed layout: identical input must still produce an identical state.
    const cfg: GameConfig = {
      ...DEFAULT_CONFIG,
      boxCount: 0,
      pileCount: 0,
      butterPositions: FIXED_BUTTER,
    };
    const a = createInitialState(cfg);
    const b = createInitialState(cfg);
    expect(stateKey(a)).toBe(stateKey(b));
    // The budget contract is an input gate only: the produced state is unchanged.
    expect(a.catMovesLeft).toBe(4);
    expect(a.config.catBaseMoves).toBe(4);
    expect(a.phase).toBe('playing');
    expect(a.currentPlayer).toBe('mouse');
    expect(a.board.length).toBe(DEFAULT_CONFIG.boardSize);
    expect(a.board[0].length).toBe(DEFAULT_CONFIG.boardSize);

    const d = createInitialState(DEFAULT_CONFIG);
    expect(d.catMovesLeft).toBe(DEFAULT_CONFIG.catBaseMoves);
    expect(d.mouseMovesLeft).toBe(DEFAULT_CONFIG.mouseBaseMoves);
    expect(d.catTrapsRemaining).toBe(1);
    expect(d.trapPosition).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CF-4 — an illegal RUNTIME budget cannot yield a certified complete plan
// ---------------------------------------------------------------------------
describe('CF-4 · illegal runtime catMovesLeft never produces a certified complete plan', () => {
  const ILLEGAL_RUNTIME: number[] = [
    2.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
  ];

  it('reports the budget as non-certifiable and sticks to a zero-move bound', () => {
    for (const bad of ILLEGAL_RUNTIME) {
      const broken = catRoot(bad);
      expect(hasCertifiableCatMoveBudget(broken), `catMovesLeft=${String(bad)}`).toBe(false);
      expect(catTurnMoveBudget(broken)).toBe(0);
      // The bound stays the documented one-derivation value (PLAN-0 keeps this
      // assertion); it is simply never trusted, because every extractor gates.
      expect(maxCatTurnPlanActions(broken)).toBe(1);
    }
  });

  it('every extractor fails closed (empty plan / null candidate)', () => {
    const ctx = ctxFor();
    const emptyGraph: EqualPrimaryGraph = new Map();
    const emptyBranches = new Map<string, SearchAction>();

    for (const bad of ILLEGAL_RUNTIME) {
      const broken = catRoot(bad);
      const legal = generateLegalSearchActions(broken, rules);
      expect(legal.length, `catMovesLeft=${String(bad)} has legal actions to try`).toBeGreaterThan(0);
      const first = legal[0];

      expect(buildPlanForFirstAction(broken, first, ctx), `plan path catMovesLeft=${String(bad)}`).toEqual([]);
      expect(buildCandidate(broken, first, ctx, 0), `candidate catMovesLeft=${String(bad)}`).toBeNull();
      expect(buildCatTurnPlan(broken, ctx), `log walk catMovesLeft=${String(bad)}`).toEqual([]);
      expect(
        extractBestCatTurnPlan(broken, rules, emptyGraph, emptyBranches),
        `DP extraction catMovesLeft=${String(bad)}`,
      ).toEqual([]);
    }
  });

  it('the completeness verdict is TRUNCATED (never COMPLETE*) for every legal action', () => {
    const COMPLETE = new Set([
      'COMPLETE_TURN_BOUNDARY',
      'COMPLETE_CHANCE_BOUNDARY',
      'GAME_ENDED',
      'NO_LEGAL_ACTIONS',
    ]);
    for (const bad of ILLEGAL_RUNTIME) {
      const broken = catRoot(bad);
      const legal = generateLegalSearchActions(broken, rules);
      // The empty plan is the exact case the old code mis-certified for NaN.
      for (const plan of [[], ...legal.map((a) => [a])]) {
        const verdict = planFullTurnCompleteness(broken, plan, rules);
        expect(COMPLETE.has(verdict.kind), `catMovesLeft=${String(bad)} plan=${plan.length} ⇒ ${verdict.kind}`)
          .toBe(false);
        expect(verdict.kind).toBe('TRUNCATED');
        expect('reason' in verdict ? verdict.reason : '').toContain('invalid cat move budget');
      }
    }
  });

  it('a genuine zero-move boundary is NOT treated as an illegal budget', () => {
    const boundary = catRoot(0);
    expect(hasCertifiableCatMoveBudget(boundary)).toBe(true);
    expect(catTurnMoveBudget(boundary)).toBe(0);
    expect(maxCatTurnPlanActions(boundary)).toBe(1);
    // An already-spent turn is complete with an empty plan — a distinct verdict
    // from the illegal-budget rejection above.
    expect(planFullTurnCompleteness(boundary, [], rules).kind).toBe('COMPLETE_TURN_BOUNDARY');
  });
});

// ---------------------------------------------------------------------------
// CF-5/CF-6 — the bound itself is untouched for legal budgets
// ---------------------------------------------------------------------------
describe('CF-5/CF-6 · the P1-PLAN bound is preserved for legal budgets', () => {
  it('M=4 ⇒ 7 (below the legacy constant 8) and M=9 ⇒ 14', () => {
    expect(maxCatTurnPlanActions(catRoot(4))).toBe(7);
    expect(maxCatTurnPlanActions(catRoot(9))).toBe(14);
    expect(catTurnMoveBudget(catRoot(4))).toBe(4);
    expect(catTurnMoveBudget(catRoot(9))).toBe(9);
  });

  it('a huge legal budget stays a safe integer and extraction stays bounded', () => {
    const big = catRoot(1_000_000);
    expect(hasCertifiableCatMoveBudget(big)).toBe(true);
    const bound = maxCatTurnPlanActions(big);
    expect(bound).toBe(1_500_001);
    expect(Number.isSafeInteger(bound)).toBe(true);
    // No recorded branches ⇒ nothing to walk: the cap is never the termination
    // mechanism, and a huge budget cannot turn into unbounded recursion.
    const ctx = ctxFor();
    expect(buildCatTurnPlan(big, ctx)).toEqual([]);
    expect(buildPlanForFirstAction(big, generateLegalSearchActions(big, rules)[0], ctx).length)
      .toBeLessThanOrEqual(bound);
  });
});

// ---------------------------------------------------------------------------
// CF-9 — numeric representability of the plan bound itself
// ---------------------------------------------------------------------------
/**
 * `B(M) = M + 1 + floor(M/2)` is 1.5·M, so "M is a safe integer" does not imply
 * "B(M) is a safe integer": at M = 6004799503160661 the bound is exactly 2^53.
 * An unsafe bound is not a large cap, it is a cap with no exact value — and every
 * extractor feeds it into a recursion capacity, so it must be refused like any
 * other illegal budget rather than silently rounded.
 */
describe('CF-9 · the plan bound must itself be an exactly representable integer', () => {
  const SAFE_EDGE = MAX_CERTIFIABLE_CAT_MOVE_BUDGET;
  const UNSAFE_EDGE = SAFE_EDGE + 1;

  it('pins the exact edge of the representable range', () => {
    expect(Number.isSafeInteger(SAFE_EDGE)).toBe(true);
    expect(Number.isSafeInteger(UNSAFE_EDGE)).toBe(true);
    // Exact integer arithmetic, independent of float rounding.
    expect(BigInt(SAFE_EDGE) + 1n + BigInt(SAFE_EDGE) / 2n).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(BigInt(UNSAFE_EDGE) + 1n + BigInt(UNSAFE_EDGE) / 2n).toBe(BigInt(2) ** 53n);
  });

  it('accepts the last representable budget and reports an exact MAX_SAFE bound', () => {
    const edge = catRoot(SAFE_EDGE);
    expect(hasCertifiableCatMoveBudget(edge)).toBe(true);
    expect(catTurnMoveBudget(edge)).toBe(SAFE_EDGE);
    expect(maxCatTurnPlanActions(edge)).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(maxCatTurnPlanActions(edge))).toBe(true);
  });

  it('rejects the first budget whose bound leaves the safe range', () => {
    for (const m of [UNSAFE_EDGE, UNSAFE_EDGE + 1, UNSAFE_EDGE + 2, 2 ** 53 - 1]) {
      const over = catRoot(m);
      expect(hasCertifiableCatMoveBudget(over), `M=${m}`).toBe(false);
      expect(catTurnMoveBudget(over), `M=${m}`).toBe(0);
      expect(maxCatTurnPlanActions(over), `M=${m}`).toBe(1);
    }
  });

  it('every extractor fails closed on an unrepresentable bound', () => {
    const over = catRoot(UNSAFE_EDGE);
    const ctx = ctxFor();
    const emptyGraph: EqualPrimaryGraph = new Map();
    const emptyBranches = new Map<string, SearchAction>();
    const legal = generateLegalSearchActions(over, rules);
    expect(legal.length).toBeGreaterThan(0);
    expect(buildCatTurnPlan(over, ctx)).toEqual([]);
    expect(extractBestCatTurnPlan(over, rules, emptyGraph, emptyBranches)).toEqual([]);
    expect(buildPlanForFirstAction(over, legal[0], ctx)).toEqual([]);
    expect(buildCandidate(over, legal[0], ctx, 0)).toBeNull();
    const verdict = planFullTurnCompleteness(over, [], rules);
    expect(verdict.kind).toBe('TRUNCATED');
    expect('reason' in verdict ? verdict.reason : '').toContain('invalid cat move budget');
  });

  it('the config gate and the raw constructor refuse it too', () => {
    const v = validateGameConfig(withCatBaseMoves(UNSAFE_EDGE));
    expect(v.ok).toBe(false);
    expect(v.issues.filter((i) => i.message.includes('基础步数')).length).toBe(1);
    expect(createGameState(withCatBaseMoves(UNSAFE_EDGE)).state).toBeNull();
    expect(() => createInitialState(withCatBaseMoves(UNSAFE_EDGE))).toThrow(/catBaseMoves/);
    // ...while the representable edge still builds a real match.
    expect(validateGameConfig(withCatBaseMoves(SAFE_EDGE)).ok).toBe(true);
    expect(createInitialState(withCatBaseMoves(SAFE_EDGE)).catMovesLeft).toBe(SAFE_EDGE);
  });
});
