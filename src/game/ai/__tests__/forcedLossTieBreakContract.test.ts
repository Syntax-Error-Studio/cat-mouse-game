/// <reference types="node" />
/**
 * PPC-FLT-FIX-1 — forced-loss tie-break ACCEPTANCE tests.
 *
 * This file began as PPC-FLT-AUDIT-1 contract forensics (P0/P1/P2/P4/P5): it
 * proved the old defects on REAL engine transitions. Each section below keeps
 * the original reproduction and states, in order:
 *   (1) what the audit proved,
 *   (2) what the FIX now requires,
 *   (3) why the new assertion is a legal contract fix (not a weakened one),
 *   (4) the reverse control that still exercises the old behaviour where it is
 *       legitimately still observable (e.g. a TRUNCATED plan is still TRUNCATED
 *       as a verdict — it is just no longer an admissible CANDIDATE).
 *
 * Sections:
 *   FIX-1 — candidate completeness / fail-closed single candidate
 *   FIX-2 — CHANCE first action, final position, weighted expectation, deadline
 *   FIX-3 — zero-move trap is not a spatial revisit
 *   FIX-5 — RB-1 strict exactness (missing bound is unauthenticated)
 *   FIX-6 — planBranches overwrite policy is unchanged (evidence floor)
 */
import { expect, test } from 'vitest';
import { createEngineRuleSet, createInitialState } from '../../engine';
import type { GameEngineState } from '../../engine';
import type { GameConfig } from '../../config';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../types';
import {
  createSearchContext,
  searchBestAction,
  searchResult,
  compareSearchScore,
  buildCatTurnPlan,
  type MateSide,
  type RootActionRecord,
  type SearchContext,
} from '../expectiminimax';
import {
  buildCandidate,
  buildPlanForFirstAction,
  compareCatTurnPlanQuality,
  planFullTurnCompleteness,
  dirKey,
} from '../planQuality';
import { forcedLossTieBreak } from '../forcedLossTieBreak';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { evaluateForCat } from '../evaluation';
import { generateLegalSearchActions } from '../legalActions';
import { noMoveLossVerdict } from '../../rules/mobility';
import type { RuleSet, SearchAction } from '../searchTypes';
import type { Direction } from '../../types';

const rules: RuleSet = createEngineRuleSet();
const TUNNELS = [{ r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 }];
const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;

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

/** Open canonical board: every non-hole/non-tunnel cell is Empty. */
function openBoard(
  cat: { r: number; c: number },
  mouse: { r: number; c: number },
  opts: {
    ghosts?: { r: number; c: number }[];
    debt?: number;
    traps?: number;
    catMovesLeft?: number;
    mouseHasButter?: boolean;
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
    mouseHasButter: opts.mouseHasButter ?? false,
    pendingButterSpawns: (opts.ghosts ?? []).map((g) => ({ r: g.r, c: g.c, blockedMaterializations: 0 })),
    pendingButterPlacementDebt: opts.debt ?? 0,
    catTrapsRemaining: opts.traps ?? 0,
    trapPosition: null,
    butterPositions: [],
  };
}

const D = (key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): SearchAction => ({
  type: 'catStep',
  direction: DIRECTIONS.find((d) => d.key === key)! as Direction,
});
const L = D('ArrowLeft');
const R = D('ArrowRight');
const U = D('ArrowUp');
const DN = D('ArrowDown');
const TRAP: SearchAction = { type: 'catPlaceTrap' };

/** Deterministic context whose planBranches log encodes exactly `plan`. */
function chainCtx(root: GameEngineState, plan: SearchAction[], ruleSet: RuleSet = rules): SearchContext {
  const ctx = createSearchContext(ruleSet, 1_000_000, false, false, false, 0);
  ctx.leafEvaluator = evaluateForCat;
  let cur = root;
  for (const a of plan) {
    ctx.planBranches.set(stateKey(cur), a);
    const t = simulateSearchAction(cur, a, ruleSet);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
  }
  return ctx;
}

/** One context carrying several complete chains from the same root. */
function multiChainCtx(root: GameEngineState, plans: SearchAction[][]): SearchContext {
  const ctx = createSearchContext(rules, 1_000_000, false, false, false, 0);
  ctx.leafEvaluator = evaluateForCat;
  for (const plan of plans) {
    let cur = root;
    for (const a of plan) {
      ctx.planBranches.set(stateKey(cur), a);
      const t = simulateSearchAction(cur, a, rules);
      if (t.kind !== 'deterministic') break;
      cur = t.state;
    }
  }
  return ctx;
}

function revisitsIn(cells: string[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const c of cells) {
    if (seen.has(c)) n++;
    seen.add(c);
  }
  return n;
}

/** Spatial cat cells: a cell is recorded only when it actually changes. */
function catCellsSpatial(root: GameEngineState, plan: SearchAction[]): string[] {
  const out = [rc(root.catPosition)];
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind === 'chance') {
      const cells = new Set(t.outcomes.map((o) => rc(o.state.catPosition)));
      expect(cells.size).toBe(1);
      const cell = [...cells][0];
      if (cell !== out[out.length - 1]) out.push(cell);
      break;
    }
    cur = t.state;
    const cell = rc(cur.catPosition);
    if (cell !== out[out.length - 1]) out.push(cell);
  }
  return out;
}

function isLegal(root: GameEngineState, action: SearchAction): boolean {
  return generateLegalSearchActions(root, rules).some((a) => {
    if (a.type !== action.type) return false;
    if (a.type === 'catStep' && action.type === 'catStep') return a.direction!.key === action.direction!.key;
    return true;
  });
}

/** A real forced-loss shape: one cat move left, a pending ghost, mouse at hole. */
function forcedLossOneMoveRoot(): GameEngineState {
  const base = createInitialState(baseConfig({ r: 1, c: 1 }, { r: 7, c: 7 }));
  const board: CellData[][] = base.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) {
        return { ...cell, piece: undefined };
      }
      const open = (r >= 1 && r <= 2 && c >= 1 && c <= 4) || (r === 7 && c >= 6 && c <= 7);
      return open
        ? { ...cell, type: CellType.Empty, piece: undefined, hasButter: false }
        : { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  board[1][1] = { ...board[1][1], piece: PieceType.Cat };
  board[7][7] = { ...board[7][7], piece: PieceType.Mouse };
  return {
    ...base,
    board,
    catPosition: { r: 1, c: 1 },
    mousePosition: { r: 7, c: 7 },
    currentPlayer: PieceType.Cat,
    catMovesLeft: 1,
    mouseMovesLeft: 3,
    phase: GamePhase.Playing,
    mouseHasButter: true,
    pendingButterSpawns: [{ r: 2, c: 4, blockedMaterializations: 0 }],
    pendingButterPlacementDebt: 0,
    catTrapsRemaining: 1,
    trapPosition: null,
    butterPositions: [],
  };
}

/** Cat sealed in a single cell with one trap: only catPlaceTrap is legal. */
function sealedRoot(): GameEngineState {
  const base = openBoard({ r: 1, c: 1 }, { r: 8, c: 8 }, { traps: 1 });
  const board: CellData[][] = base.board.map((row, r) =>
    row.map((cell, c) => {
      const open = (r === 1 && c === 1) || (r === 8 && c === 8);
      return open
        ? { ...cell, type: CellType.Empty, piece: undefined, hasButter: false }
        : { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  board[1][1] = { ...board[1][1], piece: PieceType.Cat };
  board[8][8] = { ...board[8][8], piece: PieceType.Mouse };
  return { ...base, board };
}

const loss = (value = -999_999): Omit<RootActionRecord, 'action'> => ({
  value,
  mate: 'mouse',
  bound: 'exact',
});

// ===========================================================================
// FIX-3 / P1 — a zero-move trap must NOT be a cat-position revisit
// ===========================================================================
test('FIX-3 zero-move trap: no revisit, both plans complete, no trap penalty', () => {
  // Audit proof: a trap that moves nothing pushed a duplicate cat cell into
  // `positions`, so the trap plan reported revisit=1 vs 0 for a pure move plan
  // and lost the tie on a metric that never happened spatially.
  // FIX requirement: only real cat-position changes enter the sequence.
  // Legality of the fix: the plan is unchanged (G0.3A keeps catPlaceTrap); only
  // the spatial metric is corrected. Reverse control: real back-and-forth is
  // still counted below.
  const root = openBoard({ r: 5, c: 5 }, { r: 0, c: 2 }, { traps: 1 });
  const movePlan = [L, L, L, L];
  const trapPlan = [TRAP, L, L, L, L];

  const cMove = buildCandidate(root, L, chainCtx(root, movePlan), 0)!;
  const cTrap = buildCandidate(root, TRAP, chainCtx(root, trapPlan), 1)!;

  expect(cMove.plan.map(dirKey)).toEqual(['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']);
  expect(cTrap.plan.map(dirKey)).toEqual(['catPlaceTrap', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']);
  expect(planFullTurnCompleteness(root, cMove.plan, rules).kind).toBe('COMPLETE_TURN_BOUNDARY');
  expect(planFullTurnCompleteness(root, cTrap.plan, rules).kind).toBe('COMPLETE_TURN_BOUNDARY');

  expect(revisitsIn(catCellsSpatial(root, cMove.plan))).toBe(0);
  expect(revisitsIn(catCellsSpatial(root, cTrap.plan))).toBe(0);
  expect(cMove.revisitCount).toBe(0);
  expect(cTrap.revisitCount).toBe(0);

  // With equal reversal/revisit counts the comparator falls through to
  // boundaryEval; a spatial non-event can no longer decide the tie.
  expect(cMove.reversalCount).toBe(0);
  expect(cTrap.reversalCount).toBe(0);
  const cmp = compareCatTurnPlanQuality(cMove, cTrap, 'forced-loss-original');
  if (cMove.boundaryEval !== cTrap.boundaryEval) {
    // compare(a, b) returns b.boundaryEval - a.boundaryEval (higher is better).
    expect(Math.sign(cmp)).toBe(-Math.sign(cMove.boundaryEval - cTrap.boundaryEval));
  } else {
    expect(cmp).toBeLessThan(0); // stable original order only
  }

  // Reverse control: a REAL back-and-forth still produces revisits.
  const backForth = [L, R, L, R];
  const cBackForth = buildCandidate(root, L, chainCtx(root, backForth), 0)!;
  expect(cBackForth.revisitCount).toBe(3);
  expect(revisitsIn(catCellsSpatial(root, backForth))).toBe(3);

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-3 trap spatial accounting`
    + `\n  move: revisit=${cMove.revisitCount} boundaryEval=${cMove.boundaryEval}`
    + `\n  trap: revisit=${cTrap.revisitCount} boundaryEval=${cTrap.boundaryEval}`
    + `\n  forced-loss-original comparator (move vs trap) = ${cmp}`
    + `\n  back-and-forth real movement revisit=${cBackForth.revisitCount}`,
  );
});

// ===========================================================================
// FIX-2 / P2 — final CHANCE step: cell and boundary value are the REAL ones
// ===========================================================================
test('FIX-2 final CHANCE step: final cell counted and boundary is the weighted expectation', () => {
  // Audit proof: the final catStep was in the plan, but `positions` stopped at
  // the pre-final state (true 3 revisits reported as 2) and boundaryEval was the
  // PRE-final Baseline value.
  // FIX requirement: include the final cell (all outcomes must agree), and use
  // Σ weight·activeLeafEvaluator(outcome.state) — never outcomes[0], no extra
  // step. Legality: expected value over the honest CHANCE distribution is the
  // value of the boundary by definition; it does not touch search math.
  const root = openBoard({ r: 5, c: 5 }, { r: 3, c: 3 }, { ghosts: [{ r: 2, c: 2 }] });
  const plan = [L, R, L, R];
  const cand = buildCandidate(root, L, chainCtx(root, plan), 0)!;

  expect(cand.plan).toHaveLength(4);
  let cur = root;
  for (let i = 0; i < 3; i++) {
    const t = simulateSearchAction(cur, cand.plan[i], rules);
    expect(t.kind).toBe('deterministic');
    if (t.kind !== 'deterministic') return;
    cur = t.state;
  }
  const final = simulateSearchAction(cur, cand.plan[3], rules);
  expect(final.kind).toBe('chance');
  if (final.kind !== 'chance') return;

  const cells = new Set(final.outcomes.map((o) => rc(o.state.catPosition)));
  expect(cells.size).toBe(1);
  const spatial = catCellsSpatial(root, cand.plan);
  expect(spatial).toEqual(['5,5', '5,4', '5,5', '5,4', '5,5']);
  expect(cand.revisitCount).toBe(3);

  const weightSum = final.outcomes.reduce((s, o) => s + o.weight, 0);
  expect(weightSum).toBeCloseTo(1, 12);
  const expectation = final.outcomes.reduce((s, o) => s + o.weight * evaluateForCat(o.state), 0);
  expect(cand.boundaryEval).toBeCloseTo(expectation, 9);
  // And it is no longer the stale pre-final value.
  expect(Math.abs(cand.boundaryEval - evaluateForCat(cur))).toBeGreaterThan(1e-9);

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-2 chance boundary`
    + `\n  outcomes=${final.outcomes.length} weightSum=${weightSum} spread=${Math.max(...final.outcomes.map((o) => evaluateForCat(o.state))) - Math.min(...final.outcomes.map((o) => evaluateForCat(o.state)))}`
    + `\n  boundaryEval(expected)=${cand.boundaryEval} stalePreFinal=${evaluateForCat(cur)}`
    + `\n  revisitCount=${cand.revisitCount} spatial=${revisitsIn(spatial)}`,
  );
});

test('FIX-2 CHANCE on the FIRST cat action is a complete one-action plan', () => {
  // Audit proof: the first action's CHANCE transition returned an empty plan,
  // so the candidate was null. FIX requirement: keep the legal cat action and
  // certify it through planFullTurnCompleteness (moves exhausted ⇒ complete).
  // Legality: the cat action IS executed; the ghost boundary is resolved by the
  // engine, not by the plan. Reverse control: a zero-cost trap alone is NOT a
  // complete turn here (it leaves moves and legal actions) and stays rejected.
  const root = openBoard({ r: 5, c: 5 }, { r: 3, c: 3 }, {
    ghosts: [{ r: 2, c: 2 }],
    catMovesLeft: 1,
    traps: 1,
  });
  const steps = generateLegalSearchActions(root, rules).filter((a) => a.type === 'catStep');
  expect(steps.length).toBeGreaterThan(0);
  for (const a of steps) {
    const t = simulateSearchAction(root, a, rules);
    expect(t.kind).toBe('chance');
    const cand = buildCandidate(root, a, chainCtx(root, [a]), 0);
    expect(cand).not.toBeNull();
    expect(cand!.plan.map(dirKey)).toEqual([dirKey(a)]);
    expect(planFullTurnCompleteness(root, cand!.plan, rules).kind).toBe('COMPLETE_CHANCE_BOUNDARY');
    expect(cand!.revisitCount).toBe(0);
    // Boundary is the honest expectation for THIS final action.
    if (t.kind === 'chance') {
      const expectation = t.outcomes.reduce((s, o) => s + o.weight * evaluateForCat(o.state), 0);
      expect(cand!.boundaryEval).toBeCloseTo(expectation, 9);
    }
  }
  // The trap is deterministic but leaves catMovesLeft=1 with legal steps left.
  expect(isLegal(root, TRAP)).toBe(true);
  expect(planFullTurnCompleteness(root, [TRAP], rules).kind).toBe('TRUNCATED');
  expect(buildCandidate(root, TRAP, chainCtx(root, [TRAP]), 4)).toBeNull();
});

// ===========================================================================
// FIX-1 / P0 — candidate completeness and single-candidate fail-closed
// ===========================================================================
test('FIX-1 TRUNCATED candidate is excluded; a complete plan can still select', () => {
  // Audit proof: A (first=Left) had its successor edge missing from the sparse
  // planBranches log (TT-hit shape) and won on a 1-action "plan"; forcedLossTieBreak
  // returned that truncated plan. FIX requirement: plan.length>0 is not
  // completeness; TRUNCATED candidates are not admissible. Reverse control: the
  // completeness VERDICT still reports TRUNCATED for the same plan.
  const root = openBoard({ r: 5, c: 5 }, { r: 0, c: 2 }, { traps: 0 });
  const ctx = chainCtx(root, [R, U, DN, L]);
  ctx.planBranches.delete(stateKey(root));
  const cB = buildCandidate(root, R, ctx, 1);
  expect(cB).not.toBeNull();
  expect(cB!.plan).toHaveLength(4);
  expect(planFullTurnCompleteness(root, cB!.plan, rules).kind).toBe('COMPLETE_TURN_BOUNDARY');

  // The raw walker still produces the 1-action plan, and the verdict still says
  // TRUNCATED — but the candidate is rejected.
  const raw = buildPlanForFirstAction(root, L, ctx);
  expect(raw.map(dirKey)).toEqual(['ArrowLeft']);
  expect(planFullTurnCompleteness(root, raw, rules).kind).toBe('TRUNCATED');
  expect(buildCandidate(root, L, ctx, 0)).toBeNull();

  const rejected = forcedLossTieBreak(root, ctx, [
    { action: L, ...loss() },
    { action: R, ...loss() },
  ]);
  expect(rejected).toBeNull();

  // Positive control: with BOTH chains complete the selector compares and
  // returns a complete plan.
  const full = multiChainCtx(root, [[L, L, L, L], [R, U, DN, L]]);
  const selected = forcedLossTieBreak(root, full, [
    { action: L, ...loss() },
    { action: R, ...loss() },
  ]);
  expect(selected).not.toBeNull();
  expect(['ArrowLeft', 'ArrowRight']).toContain(dirKey(selected![0]));
  expect(['COMPLETE_TURN_BOUNDARY', 'COMPLETE_CHANCE_BOUNDARY'])
    .toContain(planFullTurnCompleteness(root, selected!, rules).kind);

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-1 truncated vs complete`
    + `\n  raw(Left)=${raw.map(dirKey).join('>')} verdict=${planFullTurnCompleteness(root, raw, rules).kind} candidate=null`
    + `\n  B(Right) len=${cB!.plan.length} verdict=${planFullTurnCompleteness(root, cB!.plan, rules).kind}`
    + `\n  selector(incomplete set)=null selector(complete set)=${selected!.map(dirKey).join('>')}`,
  );
});

test('FIX-1 real one-move ghost root: never returns a sole candidate', () => {
  // Audit proof: every chance-first catStep yielded no candidate and only the
  // zero-cost trap built, so the selector returned that lone plan and replaced
  // the search's own catStep first action.
  // FIX requirement: chance-first actions now build (FIX-2), a trap-only plan is
  // TRUNCATED, and the selector fails closed whenever any certified primary-equal
  // action cannot build a complete plan. It may never return the survivors as a
  // sole candidate.
  const root = forcedLossOneMoveRoot();
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0);
  ctx.capturePlan = true;
  ctx.leafEvaluator = evaluateForCat;
  const res = searchBestAction(root, 2, ctx);
  expect(res.completed).toBe(true);
  expect(res.mate).toBe('mouse');

  const pool = ctx.rootValues;
  expect(pool.length).toBeGreaterThan(1);
  const best = pool.reduce((a, b) =>
    compareSearchScore({ value: b.value, mate: b.mate }, { value: a.value, mate: a.mate }) > 0 ? b : a,
  );
  const primaryEqual = pool.filter(
    (a) => a.bound === 'exact' && compareSearchScore({ value: a.value, mate: a.mate }, { value: best.value, mate: best.mate }) === 0,
  );
  expect(primaryEqual.length).toBeGreaterThan(1);
  expect(primaryEqual.every((a) => a.mate === 'mouse')).toBe(true);

  let built = 0;
  const rows: string[] = [];
  for (const pe of primaryEqual) {
    const c = buildCandidate(root, pe.action, ctx, 0);
    if (c) built++;
    rows.push(`${dirKey(pe.action)}=${c ? c.plan.map(dirKey).join('>') : 'NO_CANDIDATE'}`);
  }

  const out = forcedLossTieBreak(root, ctx, primaryEqual);
  // If any certified tie could not build, the selector keeps the search plan.
  expect(out === null || built === primaryEqual.length).toBe(true);
  if (out !== null) {
    const first = out[0];
    expect(primaryEqual.some((a) => dirKey(a.action) === dirKey(first))).toBe(true);
    expect(['COMPLETE_TURN_BOUNDARY', 'COMPLETE_CHANCE_BOUNDARY'])
      .toContain(planFullTurnCompleteness(root, out, rules).kind);
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-1 one-move ghost root primaryEqual=${primaryEqual.length} built=${built}`
    + `\n  ${rows.join(' ')}`
    + `\n  search.bestAction=${res.action?.type === 'catStep' ? res.action.direction!.key : res.action?.type}`
    + `  selector=${out === null ? 'null (keeps search plan)' : out.map(dirKey).join('>')}`,
  );
});

test('FIX-1/FIX-2 a replaced execution plan really reaches the same forced-loss mate', () => {
  // §10 acceptance for the ONLY production-visible effect: the executed first
  // cat action may change inside a proved exact-primary forced-loss tie. Replay
  // both the search's own plan and the selector's plan with the real engine and
  // the mouse's forced step into the hole.
  const root = forcedLossOneMoveRoot();
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0);
  ctx.capturePlan = true;
  ctx.leafEvaluator = evaluateForCat;
  const res = searchBestAction(root, 2, ctx);
  expect(res.completed).toBe(true);
  expect(res.mate).toBe('mouse');

  const preSel = buildCatTurnPlan(root, ctx);
  expect(preSel.length).toBeGreaterThan(0);
  const out = forcedLossTieBreak(root, ctx, ctx.rootValues);
  expect(out).not.toBeNull();

  const exact = ctx.rootValues.filter((a) => a.bound === 'exact');
  const best = exact.reduce((a, b) =>
    compareSearchScore({ value: b.value, mate: b.mate }, { value: a.value, mate: a.mate }) > 0 ? b : a,
  );
  const right = DIRECTIONS.find((d) => d.key === 'ArrowRight')!;
  const toMate = (plan: SearchAction[]): GameEngineState[] => {
    let cur = root;
    for (const a of plan) {
      const t = simulateSearchAction(cur, a, rules);
      if (t.kind === 'chance') {
        return t.outcomes.map((o) => {
          const m = simulateSearchAction(o.state, { type: 'mouseStep', direction: right }, rules);
          expect(m.kind).toBe('deterministic');
          return m.kind === 'deterministic' ? m.state : o.state;
        });
      }
      expect(t.kind).toBe('deterministic');
      if (t.kind !== 'deterministic') return [];
      cur = t.state;
      if (cur.phase !== GamePhase.Playing) return [cur];
    }
    return [cur];
  };

  for (const [label, plan] of [['search', preSel], ['selector', out!]] as const) {
    const rec = exact.find((a) => dirKey(a.action) === dirKey(plan[0]));
    expect(rec, `${label} first action is certified exact`).toBeDefined();
    expect(compareSearchScore(
      { value: rec!.value, mate: rec!.mate },
      { value: best.value, mate: best.mate },
    ), `${label} first action is primary-equal`).toBe(0);
    expect(['COMPLETE_TURN_BOUNDARY', 'COMPLETE_CHANCE_BOUNDARY', 'GAME_ENDED', 'NO_LEGAL_ACTIONS'])
      .toContain(planFullTurnCompleteness(root, plan, rules).kind);
    const ends = toMate(plan);
    expect(ends.length, `${label} replay outcomes`).toBeGreaterThan(0);
    for (const e of ends) expect(e.phase, `${label} replay reaches the mouse mate`).toBe(GamePhase.MouseWins);
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-1 execution plan replacement`
    + `\n  searchPlan=${preSel.map(dirKey).join('>')} selectorPlan=${out!.map(dirKey).join('>')}`
    + `\n  firstStepChanged=${dirKey(out![0]) !== dirKey(preSel[0])}`
    + `  rootValue=${res.value} mate=${res.mate} bestAction=${dirKey(res.action!)} (unchanged by selector)`,
  );
});

test('FIX-1 direct mouse catch ends the game inside one action (GAME_ENDED)', () => {
  // A direct catch is a genuinely complete one-action turn: the game is over.
  // The candidate must be admitted, use the ACTUAL terminal state for the
  // boundary value, and remain finite.
  const root = openBoard({ r: 5, c: 5 }, { r: 5, c: 6 }, { traps: 0 });
  const cand = buildCandidate(root, R, chainCtx(root, [R]), 0);
  expect(cand).not.toBeNull();
  const verdict = planFullTurnCompleteness(root, cand!.plan, rules);
  expect(verdict.kind).toBe('GAME_ENDED');
  const terminal = simulateSearchAction(root, R, rules);
  expect(terminal.kind).toBe('deterministic');
  if (terminal.kind === 'deterministic') {
    expect(terminal.state.phase).not.toBe(GamePhase.Playing);
    expect(cand!.boundaryEval).toBe(evaluateForCat(terminal.state));
  }
  expect(Number.isFinite(cand!.boundaryEval)).toBe(true);
});

test('FIX-1 legal NO_LEGAL_ACTIONS completion is admitted', () => {
  // A plan that consumes the only remaining action while moves remain, in a
  // state with ZERO legal actions, is complete by the engine's own turn logic
  // (the turn ends anyway). It is not a truncation.
  //
  // RULE-A note: a REAL cat with catMovesLeft > 0 and no legal spatial move is
  // now terminal (MouseWins), so this Playing-edge can no longer be produced by
  // walling the cat in. The contract is therefore exercised with a synthetic
  // RuleSet that refuses spatial steps while the board around the cat stays
  // open (mobility legal → RULE-A silent); the only effective action left is
  // the zero-cost trap. The assertion itself is unchanged.
  const stalledRules: RuleSet = {
    ...rules,
    catMove: (st) => st, // no-op → every catStep is filtered as illegal
  };
  const root = openBoard({ r: 5, c: 5 }, { r: 0, c: 2 }, { traps: 1 });
  // RULE-A reverse control: the OLD fixture (a sealed cat with moves left) is
  // no longer a Playing/no-legal-action edge — it is a real terminal loss.
  expect(noMoveLossVerdict(sealedRoot())?.phase).toBe(GamePhase.MouseWins);
  const legal = generateLegalSearchActions(root, stalledRules);
  expect(legal.map(dirKey)).toEqual(['catPlaceTrap']);
  const ctx = chainCtx(root, [legal[0]], stalledRules);
  const cand = buildCandidate(root, legal[0], ctx, 0);
  expect(cand).not.toBeNull();
  expect(cand!.plan.map(dirKey)).toEqual(['catPlaceTrap']);
  expect(planFullTurnCompleteness(root, cand!.plan, stalledRules).kind).toBe('NO_LEGAL_ACTIONS');
  expect(Number.isFinite(cand!.boundaryEval)).toBe(true);
});

// ===========================================================================
// FIX-2 — deadline: never start a second window; fail closed when time is gone
// ===========================================================================
test('FIX-2 deadline is the search own authority; expired => keep search plan', () => {
  const root = openBoard({ r: 5, c: 5 }, { r: 0, c: 2 }, { traps: 1 });
  const ctx = multiChainCtx(root, [[L, L, L, L], [TRAP, L, L, L, L]]);
  // Same contract as the search: an ABSOLUTE deadline on ctx.now.
  ctx.now = () => 100;
  ctx.deadlineMs = 100;
  expect(buildCandidate(root, L, ctx, 0)).toBeNull();
  expect(forcedLossTieBreak(root, ctx, [
    { action: L, ...loss() },
    { action: TRAP, ...loss() },
  ])).toBeNull();
  // No deadline configured: nothing is refused.
  const open = multiChainCtx(root, [[L, L, L, L], [TRAP, L, L, L, L]]);
  expect(buildCandidate(root, L, open, 0)).not.toBeNull();
});

// ===========================================================================
// FIX-5 / P4 — strict RB-1 exactness
// ===========================================================================
test('FIX-5 only bound === exact enters the proved tie set; missing bound is rejected', () => {
  // Audit proof: `(bound ?? 'exact')` certified an entry that published NO
  // bound, so a JS caller omitting metadata silently created a "proved" tie.
  // FIX requirement: strict equality. A missing bound is unauthenticated.
  // Legality: RB-1 already defines certification as completed && bound==='exact';
  // the type now enforces the field, and this test bypasses it on purpose.
  const root = openBoard({ r: 5, c: 5 }, { r: 0, c: 2 }, { traps: 1 });
  const ctx = multiChainCtx(root, [[L, L, L, L], [TRAP, L, L, L, L]]);

  const boundless = [
    { action: L, value: -999_999, mate: 'mouse' as MateSide },
    { action: R, value: -999_999, mate: 'mouse' as MateSide },
  ] as unknown as RootActionRecord[];
  expect(forcedLossTieBreak(root, ctx, boundless)).toBeNull();

  const mixed = [
    { action: L, value: -999_999, mate: 'mouse' as MateSide, bound: 'exact' as const },
    { action: TRAP, value: -999_999, mate: 'mouse' as MateSide },
  ] as unknown as RootActionRecord[];
  expect(forcedLossTieBreak(root, ctx, mixed)).toBeNull();

  const oneSided = [
    { action: L, value: -999_999, mate: 'mouse' as MateSide, bound: 'exact' as const },
    { action: TRAP, value: -999_999, mate: 'mouse' as MateSide, bound: 'upper' as const },
  ];
  expect(forcedLossTieBreak(root, ctx, oneSided)).toBeNull();

  // Control: two proved, complete candidates DO compare.
  const proved = forcedLossTieBreak(root, ctx, [
    { action: L, ...loss() },
    { action: TRAP, ...loss() },
  ]);
  expect(proved).not.toBeNull();
  expect(planFullTurnCompleteness(root, proved!, rules).kind).toBe('COMPLETE_TURN_BOUNDARY');

  // eslint-disable-next-line no-console
  console.log(
    `\nFIX-5 bound strictness: missing=${forcedLossTieBreak(root, ctx, boundless) === null ? 'rejected' : 'ADMITTED'}`
    + ` mixed=${forcedLossTieBreak(root, ctx, mixed) === null ? 'rejected' : 'ADMITTED'}`
    + ` upper=${forcedLossTieBreak(root, ctx, oneSided) === null ? 'rejected' : 'ADMITTED'}`
    + ` exact=selected(${proved!.map(dirKey).join('>')})`,
  );
});

test('FIX-5 production rootActions always publish a real bound', () => {
  const root = openBoard({ r: 5, c: 5 }, { r: 0, c: 2 }, { traps: 1 });
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0);
  ctx.capturePlan = true;
  ctx.leafEvaluator = evaluateForCat;
  searchBestAction(root, 2, ctx);
  expect(ctx.rootValues.length).toBeGreaterThan(0);
  for (const r of ctx.rootValues) {
    expect(['exact', 'lower', 'upper']).toContain(r.bound);
  }
});

// ===========================================================================
// FIX-6 / P5 — planBranches overwrite policy is UNCHANGED (evidence floor)
// ===========================================================================
class TrackedBranches extends Map<string, SearchAction> {
  writes: { key: string; action: SearchAction }[] = [];
  override set(key: string, value: SearchAction): this {
    this.writes.push({ key, action: value });
    return super.set(key, value);
  }
}

test('FIX-6 planBranches write policy unchanged; no conflict on these roots', () => {
  // The audit could not prove an overwrite ever violates a correctness
  // contract. FIX-6 therefore keeps the existing write policy; this is the
  // evidence floor only. The 45-root measurement lives in the HV14 file.
  const roots = [
    openBoard({ r: 5, c: 5 }, { r: 0, c: 2 }, { traps: 1 }),
    openBoard({ r: 1, c: 1 }, { r: 2, c: 7 }, { traps: 0 }),
    forcedLossOneMoveRoot(),
  ];
  let conflicts = 0;
  for (const root of roots) {
    const ctx = createSearchContext(rules, 200_000, true, true, true, 0);
    ctx.capturePlan = true;
    ctx.leafEvaluator = evaluateForCat;
    const tracked = new TrackedBranches();
    ctx.planBranches = tracked;
    searchResult(root, 2, ctx);

    const byKey = new Map<string, Set<string>>();
    for (const w of tracked.writes) {
      const set = byKey.get(w.key) ?? new Set<string>();
      set.add(dirKey(w.action));
      byKey.set(w.key, set);
    }
    for (const [, keys] of byKey) {
      if (keys.size > 1) conflicts++;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nFIX-6 conflicting planBranches writes across ${roots.length} real searches: ${conflicts}`);
  expect(conflicts).toBe(0);
});
