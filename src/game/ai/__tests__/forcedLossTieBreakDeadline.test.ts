/// <reference types="node" />
/**
 * PPC-FLT-FIX-1R — mid-CHANCE deadline abort acceptance.
 *
 * The multi-outcome CHANCE expectation must not keep evaluating the remaining
 * outcomes after the search's OWN deadline (`ctx.deadlineMs` + `ctx.now`) has
 * passed. A single synchronous leaf call cannot be preempted; the guarantee is
 * that NO further outcome is evaluated, and NO partially accumulated
 * expectation is committed (the candidate returns null, so the selector keeps
 * the search's plan).
 *
 * Every deadline here is produced by an INJECTED clock + leaf evaluator, never
 * by wall-clock happenstance.
 */
import { expect, test } from 'vitest';
import { createEngineRuleSet, createInitialState } from '../../engine';
import type { GameEngineState } from '../../engine';
import type { GameConfig } from '../../config';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../types';
import {
  buildCandidate,
  dirKey,
  planFullTurnCompleteness,
  type CandidatePlan,
} from '../planQuality';
import { forcedLossTieBreak } from '../forcedLossTieBreak';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { evaluateForCat } from '../evaluation';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { createSearchContext, type MateSide } from '../expectiminimax';
import type { RuleSet, SearchAction } from '../searchTypes';

const rules: RuleSet = createEngineRuleSet();
const TUNNELS = [{ r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 }];

type CellData = GameEngineState['board'][number][number];

function baseConfig(cat: { r: number; c: number }, mouse: { r: number; c: number }): GameConfig {
  return {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: mouse,
    catStart: cat,
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    catBaseMoves: 4,
    gameMode: 'single',
    difficulty: 'hard',
    tunnelCorners: TUNNELS,
  };
}

function openBoard(
  cat: { r: number; c: number },
  mouse: { r: number; c: number },
  opts: {
    ghosts?: { r: number; c: number }[];
    catMovesLeft?: number;
  } = {},
): GameEngineState {
  const base = createInitialState(baseConfig(cat, mouse));
  const board: CellData[][] = base.board.map((row) =>
    row.map((cell) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) {
        return { ...cell, piece: undefined };
      }
      return { ...cell, type: CellType.Empty, piece: undefined, hasButter: false };
    }),
  );
  board[cat.r][cat.c] = { ...board[cat.r][cat.c], piece: PieceType.Cat };
  board[mouse.r][mouse.c] = { ...board[mouse.r][mouse.c], piece: PieceType.Mouse };
  return {
    ...base,
    board,
    catPosition: { ...cat },
    mousePosition: { ...mouse },
    currentPlayer: PieceType.Cat,
    catMovesLeft: opts.catMovesLeft ?? 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
    pendingButterSpawns: (opts.ghosts ?? []).map((g) => ({ r: g.r, c: g.c, blockedMaterializations: 0 })),
    pendingButterPlacementDebt: 0,
    catTrapsRemaining: 0,
    trapPosition: null,
    butterPositions: [],
  };
}

const step = (key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): SearchAction => ({
  type: 'catStep',
  direction: DIRECTIONS.find((d) => d.key === key)!,
});

function chainCtx(root: GameEngineState, plan: SearchAction[], leaf: (s: GameEngineState) => number) {
  const ctx = createSearchContext(rules, 1_000_000, false, false, false, 0);
  ctx.leafEvaluator = leaf;
  let cur = root;
  for (const a of plan) {
    ctx.planBranches.set(stateKey(cur), a);
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
  }
  return ctx;
}

interface ChanceFixture {
  root: GameEngineState;
  plan: SearchAction[];
  outcomes: { state: GameEngineState; weight: number }[];
}

/**
 * A ghost/debt boundary reached by a legal cat turn.
 * - `many` is the proven 33-outcome CHANCE state (mouse sits on the pending
 *   ghost ⇒ §7 auto-pick enumerates every legal spawn cell, uniform 1/N).
 * - `single` materializes a pending ghost on an empty cell ⇒ 1 outcome.
 */
function chanceFixture(mode: 'many' | 'single'): ChanceFixture {
  const root = mode === 'many'
    ? openBoard({ r: 5, c: 5 }, { r: 3, c: 3 }, { ghosts: [{ r: 3, c: 3 }] })
    : openBoard({ r: 1, c: 1 }, { r: 3, c: 3 }, { ghosts: [{ r: 2, c: 2 }], catMovesLeft: 1 });
  const plan = mode === 'many'
    ? [step('ArrowLeft'), step('ArrowRight'), step('ArrowLeft'), step('ArrowRight')]
    : [step('ArrowLeft')];
  const last = simulateSearchAction(
    mode === 'many' ? replayDeterministic(root, plan.slice(0, -1)) : root,
    plan[plan.length - 1],
    rules,
  );
  expect(last.kind).toBe('chance');
  if (last.kind !== 'chance') throw new Error('fixture must end at a CHANCE boundary');
  return { root, plan, outcomes: last.outcomes };
}

function replayDeterministic(root: GameEngineState, plan: SearchAction[]): GameEngineState {
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') throw new Error('fixture prefix must be deterministic');
    cur = t.state;
  }
  return cur;
}

function weighted(fixture: ChanceFixture, leaf: (s: GameEngineState) => number): number {
  return fixture.outcomes.reduce((s, o) => s + o.weight * leaf(o.state), 0);
}

// ===========================================================================
// P0-1 — deadline NOT reached: every outcome is weighted
// ===========================================================================
test('P0 deadline not reached: all 33 outcomes evaluated and fully weighted', () => {
  const fx = chanceFixture('many');
  expect(fx.outcomes.length).toBe(33); // the proven multi-outcome CHANCE state
  let now = 0;
  const evals = { n: 0 };
  const ctx = chainCtx(fx.root, fx.plan, (s) => {
    evals.n++;
    return evaluateForCat(s);
  });
  ctx.now = () => now;
  ctx.deadlineMs = 1e9;

  const cand = buildCandidate(fx.root, fx.plan[0], ctx, 0);
  expect(cand).not.toBeNull();
  expect(evals.n).toBe(fx.outcomes.length);
  expect(cand!.boundaryEval).toBeCloseTo(weighted(fx, evaluateForCat), 9);
  now = 0; // the injected clock was only advanced by a leaf in the abort test

  // eslint-disable-next-line no-console
  console.log(
    `\nP0 no-expiry multi-outcome: outcomes=${fx.outcomes.length} evals=${evals.n}`
    + ` boundary=${cand!.boundaryEval} expectation=${weighted(fx, evaluateForCat)}`,
  );
});

// ===========================================================================
// P0-2 — deadline after the k-th outcome: no further evaluation, null
// ===========================================================================
test('P0 deadline after k-th outcome: remaining outcomes are NOT evaluated; candidate is null', () => {
  const fx = chanceFixture('many');
  expect(fx.outcomes.length).toBe(33);
  const k = 3;
  let now = 0;
  const evals = { n: 0 };
  const ctx = chainCtx(fx.root, fx.plan, (s) => {
    evals.n++;
    now++; // one simulated millisecond per leaf evaluation
    return evaluateForCat(s);
  });
  ctx.now = () => now;
  // D in (k-1, k]: the post-evaluation check fires right after the k-th leaf.
  ctx.deadlineMs = k - 0.5;

  expect(buildCandidate(fx.root, fx.plan[0], ctx, 0)).toBeNull();
  expect(evals.n).toBe(k);
  expect(evals.n).toBeLessThan(fx.outcomes.length);

  // The selector sees the failed candidate and fails closed as a whole.
  const rec = (action: SearchAction) => ({
    action,
    value: -999_999,
    mate: 'mouse' as MateSide,
    bound: 'exact' as const,
  });
  let nowSel = 0;
  const selEvals = { n: 0 };
  const selCtx = chainCtx(fx.root, fx.plan, (s) => {
    selEvals.n++;
    nowSel++;
    return evaluateForCat(s);
  });
  selCtx.now = () => nowSel;
  selCtx.deadlineMs = k - 0.5;
  const out = forcedLossTieBreak(fx.root, selCtx, [rec(step('ArrowLeft')), rec(step('ArrowDown'))]);
  expect(out).toBeNull();
  expect(selEvals.n).toBe(k); // only the first candidate's k-th outcome ran

  // eslint-disable-next-line no-console
  console.log(
    `\nP0 expiry multi-outcome: outcomes=${fx.outcomes.length} k=${k} evals=${evals.n}`
    + ` selector=null selectorEvals=${selEvals.n}`,
  );
});

// ===========================================================================
// P0-3 — single outcome: expiry after its only leaf also commits nothing
// ===========================================================================
test('P0 single outcome: expiry after the only evaluation returns null (no partial commit)', () => {
  const fx = chanceFixture('single');
  expect(fx.outcomes.length).toBe(1);
  let now = 0;
  const evals = { n: 0 };
  const ctx = chainCtx(fx.root, fx.plan, (s) => {
    evals.n++;
    now++;
    return evaluateForCat(s);
  });
  ctx.now = () => now;
  ctx.deadlineMs = 0.5; // passes after the single leaf evaluation

  expect(buildCandidate(fx.root, fx.plan[0], ctx, 0)).toBeNull();
  expect(evals.n).toBe(1);

  // Without a deadline the same fixture yields the single expected value.
  const ok = buildCandidate(fx.root, fx.plan[0], chainCtx(fx.root, fx.plan, evaluateForCat), 0)!;
  expect(ok.boundaryEval).toBe(evaluateForCat(fx.outcomes[0].state));

  // eslint-disable-next-line no-console
  console.log(`\nP0 single outcome: evals=${evals.n} noDeadlineBoundary=${ok.boundaryEval}`);
});

// ===========================================================================
// P0-4 — no deadline (and a non-expiring deadline) keep the SAME numbers
// ===========================================================================
test('P0 no-deadline path equals pre-fix weighted result; a distant deadline changes nothing', () => {
  for (const mode of ['single', 'many'] as const) {
    const fx = chanceFixture(mode);
    const noDeadline = buildCandidate(fx.root, fx.plan[0], chainCtx(fx.root, fx.plan, evaluateForCat), 0)!;
    const distant = chainCtx(fx.root, fx.plan, evaluateForCat);
    distant.now = () => 0;
    distant.deadlineMs = Number.MAX_SAFE_INTEGER;
    const near = buildCandidate(fx.root, fx.plan[0], distant, 0)!;

    expect(noDeadline.boundaryEval).toBeCloseTo(weighted(fx, evaluateForCat), 12);
    expect(near.boundaryEval).toBe(noDeadline.boundaryEval);
    expect(near.plan.map(dirKey)).toEqual(noDeadline.plan.map(dirKey));
    expect(near.revisitCount).toBe(noDeadline.revisitCount);
    expect(near.reversalCount).toBe(noDeadline.reversalCount);
    expect(planFullTurnCompleteness(fx.root, near.plan, rules).kind).toBe('COMPLETE_CHANCE_BOUNDARY');
  }
});

// ===========================================================================
// P0-5 — the injected H1 leaf is still the evaluator actually used
// ===========================================================================
test('P0 H1 leaf stays in force with a non-expiring deadline', () => {
  const fx = chanceFixture('many');
  const base = weighted(fx, evaluateForCat);
  const h1 = weighted(fx, evaluateCorrectedHoleForCat);
  expect(base).not.toBeCloseTo(h1, 9); // fixture distinguishes the two leaves

  const ctx = chainCtx(fx.root, fx.plan, evaluateCorrectedHoleForCat);
  ctx.now = () => 0;
  ctx.deadlineMs = 1e9;
  const cand: CandidatePlan = buildCandidate(fx.root, fx.plan[0], ctx, 0)!;
  expect(cand.boundaryEval).toBeCloseTo(h1, 9);
  expect(cand.boundaryEval).not.toBeCloseTo(base, 9);

  // eslint-disable-next-line no-console
  console.log(`\nP0 H1 deadline-open: boundary=${cand.boundaryEval} h1=${h1} base=${base}`);
});
