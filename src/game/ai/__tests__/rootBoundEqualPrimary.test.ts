import { test, expect, describe } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState, createEngineRuleSet } from '../../engine';
import type { GameConfig } from '../../config';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../types';
import type { Direction } from '../../types';
import {
  createSearchContext,
  searchResult,
  searchBestAction,
  searchBestActionIterative,
  buildCatTurnPlan,
  type SearchContext,
} from '../expectiminimax';
import { stateKey } from '../transposition';
import {
  extractBestCatTurnPlan,
  planFullTurnCompleteness,
  countReversals,
  type EqualPrimaryGraph,
} from '../planQuality';
import { forcedLossTieBreak } from '../forcedLossTieBreak';
import { generateLegalSearchActions } from '../legalActions';
import { simulateSearchAction } from '../simulator';
import type { RuleSet, SearchAction } from '../searchTypes';

/**
 * PPC root/bound audit — §5 minimal deterministic counterexample.
 *
 * Question under test: can a fail-soft Alpha-Beta bound ('upper' / 'lower') be
 * mistaken for an exact score in a way that changes the cat's executed plan?
 *
 * The fixture is a hand-built 2-action x 2-action x 2-action tree (cat turn of 2
 * steps, mouse reply of 1 step) whose leaf values come from an injected table,
 * so the ONLY difference between the two arms is `ctx.useAlphaBeta`. No CHANCE
 * node, no ghost butter, no random, no production weights, no time budget.
 *
 * Searched at depthTurns = 2, `depthTurns` decrements only on an actor switch,
 * so one search = the cat's whole turn + the mouse's reply + a static eval at
 * the next cat-to-move node.
 *
 *   ROOT (cat 1,3)          MAX   children: Up -> C_P, Left -> C_Q
 *   C_P  (cat 0,3)          MAX   children: Down -> M_D, Left -> M_L
 *   C_Q  (cat 1,2)          MAX   children: Up -> M_L, Right -> M_D
 *   M_D  (mouse 5,3)        MIN   leaves: 1,3|5,2 = 10 , 1,3|5,4 = 10  -> 10
 *   M_L  (mouse 5,3)        MIN   leaves: 0,2|5,2 = 10 , 0,2|5,4 =  3  ->  3
 *
 * True minimax values: M_D 10, M_L 3, C_P 10 (via Down), C_Q 10 (via Right),
 * ROOT 10. With Alpha-Beta on, once a cat node has proven 10, M_L is entered
 * with alpha = 10, its first leaf (10) triggers the MIN alpha-cutoff, and M_L
 * comes back as value 10 / bound 'upper' although its true value is 3.
 */

const rules: RuleSet = createEngineRuleSet();

const OPEN: { r: number; c: number }[] = [
  { r: 0, c: 2 }, { r: 0, c: 3 }, { r: 1, c: 2 }, { r: 1, c: 3 },
  { r: 5, c: 2 }, { r: 5, c: 3 }, { r: 5, c: 4 },
];

/** Test-visible observation only: which leaves the search actually evaluated. */
function makeLeafEvaluator(table: Record<string, number>, evaluated: string[]) {
  return (s: GameEngineState): number => {
    const k = `${s.catPosition.r},${s.catPosition.c}|${s.mousePosition.r},${s.mousePosition.c}`;
    evaluated.push(k);
    return k in table ? table[k] : 7;
  };
}

const LEAVES_FALSE_TIE: Record<string, number> = {
  '1,3|5,2': 10, '1,3|5,4': 10, '0,2|5,2': 10, '0,2|5,4': 3,
};
const LEAVES_FLAT: Record<string, number> = {
  '1,3|5,2': 10, '1,3|5,4': 10, '0,2|5,2': 10, '0,2|5,4': 10,
};

function cleanConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0, pileCount: 0, butterCount: 0,
    mouseStart: { r: 5, c: 3 }, catStart: { r: 1, c: 3 },
    mouseBaseMoves: 1, mouseCarryingMoves: 1, mouseSkillExtraMoves: 3,
    catBaseMoves: 2,
    gameMode: 'single', difficulty: 'hard',
    tunnelCorners: [{ r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 }],
    ...overrides,
  };
}

/** A cat-to-move state on an all-wall board except `open` (plus holes/tunnels),
 *  with the cat owning 2 steps and the mouse 1 — no butter, no traps, no debt. */
function buildCatRoot(
  cat: { r: number; c: number },
  mouse: { r: number; c: number },
  open: { r: number; c: number }[],
): GameEngineState {
  type CellData = GameEngineState['board'][number][number];
  const s = createInitialState(cleanConfig({ catStart: cat, mouseStart: mouse }));
  const board: CellData[][] = s.board.map((row, r) =>
    row.map((cell, c) => {
      const special = cell.type === CellType.MouseHole || cell.type === CellType.Tunnel;
      if (special) return { ...cell, piece: undefined };
      if (open.some((p) => p.r === r && p.c === c)) {
        return { ...cell, type: CellType.Empty, piece: undefined, hasButter: false };
      }
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  board[cat.r][cat.c] = { ...board[cat.r][cat.c], piece: PieceType.Cat };
  board[mouse.r][mouse.c] = { ...board[mouse.r][mouse.c], piece: PieceType.Mouse };
  return {
    ...s, board,
    catPosition: cat, mousePosition: mouse,
    currentPlayer: PieceType.Cat, phase: GamePhase.Playing,
    catMovesLeft: 2, mouseMovesLeft: 1,
    mouseHasButter: false, mouseSkillActive: false,
    trapPosition: null, catTrapsRemaining: 0,
    butterPositions: [],
    pendingButterSpawns: [], pendingButterPlacementDebt: 0,
  };
}

const ROOT = buildCatRoot({ r: 1, c: 3 }, { r: 5, c: 3 }, OPEN);

/** `depthTurns` for a cat-to-move node of this tree: the cat's 2 steps expand
 *  at the same depth, the hand-off to the mouse costs 1, the mouse's reply and
 *  the hand-back cost the last one, so the leaf is the next cat-to-move node. */
const D_CAT = 2;
/** The same subtree seen from its mouse-to-move node (one switch later). */
const D_MOUSE = 1;

function dir(key: string): Direction {
  const d = DIRECTIONS.find((x) => x.key === key);
  if (!d) throw new Error(`unknown direction ${key}`);
  return d;
}
function step(key: string): SearchAction {
  return { type: 'catStep', direction: dir(key) };
}
function actionKeyOf(a: SearchAction): string {
  return a.type === 'catStep' ? `step:${a.direction!.key}` : a.type;
}
function legalKeys(s: GameEngineState): string[] {
  return generateLegalSearchActions(s, rules).map(actionKeyOf);
}
function fullActionKeys(s: GameEngineState): string[] {
  return generateLegalSearchActions(s, rules).map((a) =>
    a.type === 'catStep' || a.type === 'mouseStep' ? `${a.type}:${a.direction.key}` : a.type);
}
/** Deterministic (never CHANCE) successor — this is the simulator's real
 *  transition, including the forced CAT->MOUSE hand-off. */
function follow(s: GameEngineState, ...keys: string[]): GameEngineState {
  let cur = s;
  for (const k of keys) {
    const t = simulateSearchAction(cur, step(k), rules);
    if (t.kind !== 'deterministic') throw new Error(`unexpected CHANCE at ${k}`);
    cur = t.state;
  }
  return cur;
}

// --- the six interior nodes of the fixture tree -----------------------------
const C_P = follow(ROOT, 'ArrowUp');            // cat (0,3), 1 move left
const C_Q = follow(ROOT, 'ArrowLeft');          // cat (1,2), 1 move left
const M_D_FROM_P = follow(ROOT, 'ArrowUp', 'ArrowDown');    // mouse to move, cat (1,3)
const M_L_FROM_P = follow(ROOT, 'ArrowUp', 'ArrowLeft');    // mouse to move, cat (0,2)
const M_L_FROM_Q = follow(ROOT, 'ArrowLeft', 'ArrowUp');    // mouse to move, cat (0,2)
const M_D_FROM_Q = follow(ROOT, 'ArrowLeft', 'ArrowRight'); // mouse to move, cat (1,3)

function ctxFor(
  table: Record<string, number>,
  evaluated: string[],
  opts: { alphaBeta: boolean; tt?: boolean; ordering?: boolean },
): SearchContext {
  const ctx = createSearchContext(rules, 100_000, opts.tt ?? false, opts.alphaBeta, opts.ordering ?? false, 0);
  ctx.capturePlan = true;
  ctx.leafEvaluator = makeLeafEvaluator(table, evaluated);
  return ctx;
}

/** The true value of a plan prefix, measured by an UNPRUNED full-window search
 *  of the position the cat hands over after executing it. */
function trueValueOf(prefix: GameEngineState, table = LEAVES_FALSE_TIE): { value: number; bound: string } {
  const r = searchResult(prefix, D_MOUSE, ctxFor(table, [], { alphaBeta: false }));
  return { value: r.value, bound: r.bound };
}

describe('§5 T0 — the fixture really is the tree the audit assumes', () => {
  test('legal actions and turn mechanics match the hand-drawn tree', () => {
    expect(legalKeys(ROOT)).toEqual(['step:ArrowUp', 'step:ArrowLeft']);

    expect(C_P.catPosition).toEqual({ r: 0, c: 3 });
    expect(C_P.currentPlayer).toBe(PieceType.Cat);
    expect(C_P.catMovesLeft).toBe(1);
    expect(legalKeys(C_P)).toEqual(['step:ArrowDown', 'step:ArrowLeft']);

    expect(C_Q.catPosition).toEqual({ r: 1, c: 2 });
    expect(legalKeys(C_Q)).toEqual(['step:ArrowUp', 'step:ArrowRight']);

    // After the cat spends its last step the hand-off is deterministic (no
    // ghost / no debt), and the mouse gets exactly one step with two options.
    for (const m of [M_D_FROM_P, M_L_FROM_P, M_L_FROM_Q, M_D_FROM_Q]) {
      expect(m.currentPlayer).toBe(PieceType.Mouse);
      expect(m.mouseMovesLeft).toBe(1);
      expect(m.catMovesLeft).toBe(0); // the cat spent its last step to hand over
      expect(fullActionKeys(m)).toEqual(['mouseStep:ArrowLeft', 'mouseStep:ArrowRight']);
    }
    expect(M_D_FROM_P.mousePosition).toEqual({ r: 5, c: 3 });
    expect(M_L_FROM_P.catPosition).toEqual({ r: 0, c: 2 });

    // The two paths into M_D / M_L are the same searched position (a genuine
    // transposition set), which is what makes the graph keys comparable.
    expect(stateKey(M_D_FROM_P)).toBe(stateKey(M_D_FROM_Q));
    expect(stateKey(M_L_FROM_P)).toBe(stateKey(M_L_FROM_Q));
  });

  test('the four leaves are exactly the table keys', () => {
    const ev: string[] = [];
    searchResult(ROOT, D_CAT, ctxFor(LEAVES_FALSE_TIE, ev, { alphaBeta: false }));
    expect([...new Set(ev)].sort()).toEqual(['0,2|5,2', '0,2|5,4', '1,3|5,2', '1,3|5,4']);
  });
});

describe('§5 T1 — unpruned ground truth (full window, Alpha-Beta OFF)', () => {
  test('node values and bounds are exact and match the hand computation', () => {
    const md = searchResult(M_D_FROM_P, D_MOUSE, ctxFor(LEAVES_FALSE_TIE, [], { alphaBeta: false }));
    expect({ v: md.value, b: md.bound, m: md.mate, c: md.completed }).toEqual({ v: 10, b: 'exact', m: null, c: true });

    const ml = searchResult(M_L_FROM_P, D_MOUSE, ctxFor(LEAVES_FALSE_TIE, [], { alphaBeta: false }));
    expect({ v: ml.value, b: ml.bound, c: ml.completed }).toEqual({ v: 3, b: 'exact', c: true });

    const cp = searchResult(C_P, D_CAT, ctxFor(LEAVES_FALSE_TIE, [], { alphaBeta: false }));
    expect({ v: cp.value, b: cp.bound }).toEqual({ v: 10, b: 'exact' });
    const cq = searchResult(C_Q, D_CAT, ctxFor(LEAVES_FALSE_TIE, [], { alphaBeta: false }));
    expect({ v: cq.value, b: cq.bound }).toEqual({ v: 10, b: 'exact' });

    const root = searchResult(ROOT, D_CAT, ctxFor(LEAVES_FALSE_TIE, [], { alphaBeta: false }));
    expect({ v: root.value, b: root.bound, m: root.mate, c: root.completed }).toEqual({ v: 10, b: 'exact', m: null, c: true });
  });

  test('a full window rooted at the interior cat node picks the strictly better child', () => {
    // The root of any search always gets (−inf, +inf), so it can never cut off
    // and its own best action is the true optimum — the false tie only appears
    // for a cat node entered with an inherited alpha.
    const cp = searchBestAction(C_P, D_CAT, ctxFor(LEAVES_FALSE_TIE, [], { alphaBeta: true }));
    expect(actionKeyOf(cp.action!)).toBe('step:ArrowDown');
    const cq = searchBestAction(C_Q, D_CAT, ctxFor(LEAVES_FALSE_TIE, [], { alphaBeta: true }));
    expect(actionKeyOf(cq.action!)).toBe('step:ArrowRight');
  });
});

describe('§5 T2 — genuine exact tie (flat evaluator): proved vs merely-reported', () => {
  function run(alphaBeta: boolean) {
    const ev: string[] = [];
    const ctx = ctxFor(LEAVES_FLAT, ev, { alphaBeta });
    const res = searchBestAction(ROOT, D_CAT, ctx);
    const graph = ctx.equalPrimaryGraph as EqualPrimaryGraph;
    const branches = ctx.planBranches as Map<string, SearchAction>;
    return {
      res, ev, ctx, graph, branches,
      extracted: extractBestCatTurnPlan(ROOT, rules, graph, branches),
      walked: buildCatTurnPlan(ROOT, ctx),
      ties: (graph.get(`${stateKey(ROOT)}\x00${D_CAT}`)?.equalActions ?? []).map(actionKeyOf),
    };
  }

  // PPC-RB1 converted this test from "pruning is fully transparent" to what the
  // corrected code actually guarantees: the reported SCORE and the plan STRENGTH
  // are identical in both arms, while the equal-primary optimiser only fires on
  // ties the pruned arm really proved. The flat table is kept unchanged, and so
  // is the unpruned reference for the true values.
  test('value, completion and plan strength match; the optimiser needs a proof', () => {
    const p = run(true);
    const n = run(false);
    for (const arm of [p, n]) {
      expect(arm.res.value).toBe(10);
      expect(arm.res.mate).toBeNull();
      expect(arm.res.completed).toBe(true);
      expect(actionKeyOf(arm.res.action!)).toBe('step:ArrowUp');
      // Whatever the pruned arm skipped, every leaf it did resolve is 10, so an
      // 'upper'/'lower' bound and the exact value cannot disagree in this table.
      for (const k of new Set(arm.ev)) expect(LEAVES_FLAT[k]).toBe(10);
    }
    // Unpruned resolves the whole tree; pruned cuts (the arms differ in WORK).
    expect([...new Set(n.ev)].sort()).toEqual(['0,2|5,2', '0,2|5,4', '1,3|5,2', '1,3|5,4']);
    expect(n.ctx.diagnostics.alphaBetaCutoffs).toBe(0);
    expect(p.ctx.diagnostics.alphaBetaCutoffs).toBeGreaterThan(0);
    expect(p.res.diagnostics.nodes).toBeLessThanOrEqual(n.res.diagnostics.nodes);

    // UNPRUNED: with a flat table EVERY cat node of this turn — the root plus
    // both interior cat nodes — has all children proved exact 10, so a genuine
    // tie is recorded at each of the 3 keys (in the FALSE_TIE tree only the root
    // ties). The frozen G0.3E-R2 reversal reduction still picks the 0-reversal
    // line from those proved members.
    expect(n.graph.size).toBe(3);
    expect(n.ties).toHaveLength(2);
    expect(n.extracted.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowLeft']);
    expect(countReversals(n.extracted)).toBe(0);

    // PRUNED: the sibling cat node is entered with alpha = 10 and its first leaf
    // cuts, so it reports 10 as a BOUND. PPC-RB1 rejects it as a primary equal,
    // no tie set exists, and the plan falls back to the search's own principal
    // line — which is worth exactly the same 10 here.
    expect(p.graph.size).toBe(0);
    expect(p.ties).toHaveLength(0);
    expect(p.extracted.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowDown']);
    expect(p.res.catTurnPlan.map(actionKeyOf)).toEqual(p.extracted.map(actionKeyOf));
    expect(p.walked.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowDown']);
    expect(n.walked.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowDown']);

    // No strength is lost: every plan line in this fixture is a proved 10.
    expect(trueValueOf(follow(ROOT, 'ArrowUp', 'ArrowLeft'), LEAVES_FLAT)).toEqual({ value: 10, bound: 'exact' });
    expect(trueValueOf(follow(ROOT, 'ArrowUp', 'ArrowDown'), LEAVES_FLAT)).toEqual({ value: 10, bound: 'exact' });
    // DOCUMENTED COST (PPC-RB1): the route-style tie-break (reversal reduction)
    // no longer fires on a tie that pruning left unproved. countReversals of the
    // pruned arm's plan is 1 instead of 0, with the same value.
    expect(countReversals(p.extracted)).toBe(1);
    expect(countReversals([step('ArrowUp'), step('ArrowDown')])).toBe(1);
  });

  test('both plans stay legal and complete the cat turn', () => {
    for (const alphaBeta of [true, false]) {
      const plan = run(alphaBeta).extracted;
      const verdict = planFullTurnCompleteness(ROOT, plan, rules);
      if (verdict.kind === 'COMPLETE_TURN_BOUNDARY' || verdict.kind === 'COMPLETE_CHANCE_BOUNDARY') {
        expect(verdict.catMovesLeft).toBe(0);
      } else {
        expect(verdict.kind).toBe('COMPLETE_TURN_BOUNDARY');
      }
    }
  });
});

describe('§5 T3 — pruning-induced FALSE tie: the counterexample, now rejected', () => {
  // Observed on this fixture: 6 search nodes per arm, 3 alpha-beta cutoffs in
  // the pruned arm vs 0 unpruned, 1 TT exact hit when the TT is enabled.
  function run(alphaBeta: boolean, tt = false) {
    const ev: string[] = [];
    const ctx = ctxFor(LEAVES_FALSE_TIE, ev, { alphaBeta, tt });
    const res = searchBestAction(ROOT, D_CAT, ctx);
    const graph = ctx.equalPrimaryGraph as EqualPrimaryGraph;
    const branches = ctx.planBranches as Map<string, SearchAction>;
    return {
      res, ev, ctx, graph, branches,
      extracted: extractBestCatTurnPlan(ROOT, rules, graph, branches),
      walked: buildCatTurnPlan(ROOT, ctx),
      rootTies: (graph.get(`${stateKey(ROOT)}\x00${D_CAT}`)?.equalActions ?? []).map(actionKeyOf),
      cpTies: (graph.get(`${stateKey(C_P)}\x00${D_CAT}`)?.equalActions ?? []).map(actionKeyOf),
      cqTies: (graph.get(`${stateKey(C_Q)}\x00${D_CAT}`)?.equalActions ?? []).map(actionKeyOf),
    };
  }

  // Pre-fix behaviour, kept as the specification of what this fixture exercises
  // (measured on expectiminimax.ts @ 891f12b6…, 11/11 of this file reproduced
  // it): p.graph.size = 3 with cpTies = [Down, Left] and cqTies = [Up, Right],
  // and p.extracted = [Up, Left] — a plan worth 3 while the score said 10.
  test('the pruned arm never evaluates the worse leaf, so it may not call it primary-equal', () => {
    const p = run(true);
    const n = run(false);
    expect(p.ctx.diagnostics.alphaBetaCutoffs).toBeGreaterThan(0);
    expect(n.ctx.diagnostics.alphaBetaCutoffs).toBe(0);
    expect([...new Set(p.ev)].sort()).toEqual(['0,2|5,2', '1,3|5,2', '1,3|5,4']);
    expect(new Set(p.ev).has('0,2|5,4')).toBe(false);

    // Unpruned: only the (genuine, fully proved) root tie is recorded.
    expect(n.graph.size).toBe(1);
    expect(n.rootTies).toEqual(['step:ArrowUp', 'step:ArrowLeft']);
    expect(n.cpTies).toEqual([]);
    expect(n.cqTies).toEqual([]);

    // Pruned: the 'upper' 10 is no longer admitted as a primary equal, so the
    // graph keeps only ties whose members were all resolved exactly. Here that
    // leaves nothing — every candidate tie partner came out of a cutoff.
    expect(p.graph.size).toBe(0);
    expect(p.rootTies).toEqual([]);
    expect(p.cpTies).toEqual([]);
    expect(p.cqTies).toEqual([]);
    // ArrowLeft at C_P has true value 3 while ArrowDown has 10 — the reference
    // caliber the rejection is measured against.
    expect(trueValueOf(M_L_FROM_P)).toEqual({ value: 3, bound: 'exact' });
    expect(trueValueOf(M_D_FROM_P)).toEqual({ value: 10, bound: 'exact' });
  });

  test('the executed plan is worth the reported score in both arms', () => {
    const p = run(true);
    const n = run(false);

    // Search mathematics are sound: value / mate / completed / first action all
    // identical, and the reported root value equals the true root value.
    for (const arm of [p, n]) {
      expect(arm.res.value).toBe(10);
      expect(arm.res.mate).toBeNull();
      expect(arm.res.completed).toBe(true);
      expect(actionKeyOf(arm.res.action!)).toBe('step:ArrowUp');
    }

    // The plan handed to the planner is the proved-better one in BOTH arms.
    expect(p.extracted.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowDown']);
    expect(n.extracted.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowDown']);
    expect(p.extracted.map(actionKeyOf)).toEqual(n.extracted.map(actionKeyOf));
    expect(trueValueOf(follow(ROOT, 'ArrowUp', 'ArrowDown')).value).toBe(10);
    // …and the line that used to be selected (true value 3) is only reachable
    // through the unproved sibling, which is now excluded from the tie set.
    expect(trueValueOf(follow(ROOT, 'ArrowUp', 'ArrowLeft')).value).toBe(3);

    // The principal-line walk agrees with the extracted plan in the pruned arm
    // (no tie metadata to override it).
    expect(p.walked.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowDown']);
    expect(p.res.catTurnPlan.map(actionKeyOf)).toEqual(p.extracted.map(actionKeyOf));

    // Both plans remain legal and complete — the fix never truncates a plan
    // when it removes a false tie.
    for (const plan of [p.extracted, n.extracted]) {
      const v = planFullTurnCompleteness(ROOT, plan, rules);
      expect(v.kind).toBe('COMPLETE_TURN_BOUNDARY');
    }
  });

  test('root diagnostics now separate the proved score from the bound', () => {
    const p = run(true);
    const n = run(false);
    // `ctx.rootValues` is pushed with the child's own `bound`
    // (expectiminimax.ts rootValues.push) and surfaces publicly as
    // IterativeSearchResult.rootActions / hardTurnPlanner.rootActions.
    const shown = (rv: { action: SearchAction; value: number; bound: string }[]) =>
      rv.map((r) => `${actionKeyOf(r.action)}=${r.value}/${r.bound}`);
    expect(shown(p.ctx.rootValues)).toEqual(['step:ArrowUp=10/exact', 'step:ArrowLeft=10/upper']);
    expect(shown(n.ctx.rootValues)).toEqual(['step:ArrowUp=10/exact', 'step:ArrowLeft=10/exact']);
    expect(Object.keys(p.ctx.rootValues[0]).sort()).toEqual(['action', 'bound', 'mate', 'value']);
    const iterP = searchBestActionIterative(ROOT, {
      rules, maxDepthTurns: D_CAT, maxNodes: 100_000,
      useTT: false, useAlphaBeta: true, useMoveOrdering: false,
      leafEvaluator: makeLeafEvaluator(LEAVES_FALSE_TIE, []),
    });
    const iterN = searchBestActionIterative(ROOT, {
      rules, maxDepthTurns: D_CAT, maxNodes: 100_000,
      useTT: false, useAlphaBeta: false, useMoveOrdering: false,
      leafEvaluator: makeLeafEvaluator(LEAVES_FALSE_TIE, []),
    });
    expect(iterP.rootActions.map((r) => `${actionKeyOf(r.action)}=${r.value}/${r.bound}`))
      .toEqual(['step:ArrowUp=10/exact', 'step:ArrowLeft=10/upper']);
    expect(iterP.completedDepth).toBe(D_CAT);
    expect(iterN.completedDepth).toBe(D_CAT);
    // The wrapper path now agrees with the fixed-depth path in both arms.
    expect(iterP.catTurnPlan.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowDown']);
    expect(iterN.catTurnPlan.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowDown']);
  });

  test('the transposition table is NOT the source: TT on == TT off', () => {
    const plain = run(true, false);
    const withTT = run(true, true);
    expect(withTT.res.value).toBe(plain.res.value);
    expect(actionKeyOf(withTT.res.action!)).toEqual(actionKeyOf(plain.res.action!));
    expect(withTT.extracted.map(actionKeyOf)).toEqual(plain.extracted.map(actionKeyOf));
    expect(withTT.res.diagnostics.ttExactHits).toBeGreaterThanOrEqual(0);
    // And the TT keeps its exact-only invariant: the node that returned an
    // 'upper' bound must never be cached as an EXACT entry.
    const mlKey = stateKey(M_L_FROM_P);
    expect(withTT.ctx.tt.get(mlKey)).toBeUndefined();
  });

  test('search is small and deterministic (no budget / no clock involved)', () => {
    const p1 = run(true);
    const p2 = run(true);
    expect(p1.res.diagnostics.nodes).toBeLessThan(200);
    expect(p1.res.diagnostics.nodes).toBe(p2.res.diagnostics.nodes);
    expect(p1.extracted.map(actionKeyOf)).toEqual(p2.extracted.map(actionKeyOf));
    expect(p1.res.diagnostics.budgetCutoffs).toBe(0);
    expect(p1.res.diagnostics.deadlineCutoffs).toBe(0);
  });
});

// ============================================================================
// §3 — the ROOT node itself.
//
// The root is searched with a full window, so it never cuts off — but that does
// NOT make its `bestAction` sound: the window is handed to the CHILDREN, and a
// child that cuts off returns an uncertified ('upper' / 'lower') bound. The
// selection rule at expectiminimax.ts:1307 then replaces the incumbent on a
// NUMERIC tie whenever the candidate has a smaller `originalIndex`, and move
// ordering (production: useMoveOrdering = true) decides which originalIndex is
// searched first. So the ordering-promoted action can be pushed out of the root
// by a strictly worse action merely because the worse one came earlier in the
// LEGAL list.
//
//   LANE ROOT (cat 1,3 / mouse 1,7)   MAX   legal: Up -> L_B (idx 0), Right -> L_C1 (idx 1)
//     ordering: Up (1,3)->(0,3) = (4-5)*10 = -10 ; Right (1,3)->(1,4) = (4-3)*10 = +10
//     => the idx 1 action (Right) is searched FIRST, the idx 0 action SECOND.
//   L_C1 (cat 1,4)      MAX   children: Right -> (1,5) [idx 1, +10] first, Left -> (1,3) [idx 0, -10]
//     H_15 (cat 1,5 / mouse 1,7) MIN leaves 1,5|1,8 = 10 , 1,5|1,6 = 10           -> 10 exact
//     H_13 (cat 1,3 / mouse 1,7) MIN leaves 1,3|1,8 = 10 (flee, searched 1st) , 1,3|1,6 = 2
//                                     under alpha = 10 -> 10 with bound 'upper', true value 2
//   L_B  (cat 0,3)      MAX   only child: Down -> (1,3) = the SAME hand-off node
//                                     -> {10,'upper'} with true value 2
//
// True minimax: H_15 10, H_13 2, L_C1 10, L_B 2, ROOT 10 (via Right).
// ============================================================================

const OPEN_LANE: { r: number; c: number }[] = [
  { r: 0, c: 3 },
  { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 },
  { r: 1, c: 6 }, { r: 1, c: 7 }, { r: 1, c: 8 },
];

const LEAVES_LANE: Record<string, number> = {
  '1,5|1,8': 10, '1,5|1,6': 10,
  '1,3|1,8': 10, '1,3|1,6': 2,
};

const LANE = buildCatRoot({ r: 1, c: 3 }, { r: 1, c: 7 }, OPEN_LANE);

function followLane(...keys: string[]): GameEngineState {
  let cur = LANE;
  for (const k of keys) {
    const t = simulateSearchAction(cur, step(k), rules);
    if (t.kind !== 'deterministic') throw new Error(`unexpected CHANCE at ${k}`);
    cur = t.state;
  }
  return cur;
}

const L_C1 = followLane('ArrowRight');   // cat (1,4), 1 move left — searched 1st
const L_B = followLane('ArrowUp');       // cat (0,3), 1 move left — searched 2nd
const H_15 = followLane('ArrowRight', 'ArrowRight'); // hand-off, cat (1,5)
const H_13A = followLane('ArrowRight', 'ArrowLeft'); // hand-off, cat (1,3)
const H_13B = followLane('ArrowUp', 'ArrowDown');    // hand-off, cat (1,3) — transposition

/** Unpruned reference value of a hand-off / cat node in the lane fixture. */
function laneTrue(prefix: GameEngineState, depth = D_MOUSE): { value: number; bound: string } {
  const r = searchResult(prefix, depth, ctxFor(LEAVES_LANE, [], { alphaBeta: false }));
  return { value: r.value, bound: r.bound };
}

function runLane(opts: { alphaBeta: boolean; ordering: boolean; tt?: boolean }) {
  const ev: string[] = [];
  const ctx = ctxFor(LEAVES_LANE, ev, opts);
  const res = searchBestAction(LANE, D_CAT, ctx);
  const sr = searchResult(LANE, D_CAT, ctxFor(LEAVES_LANE, [], opts));
  const graph = ctx.equalPrimaryGraph as EqualPrimaryGraph;
  const branches = ctx.planBranches as Map<string, SearchAction>;
  return {
    res, sr, ev, ctx, graph, branches,
    extracted: extractBestCatTurnPlan(LANE, rules, graph, branches),
    walked: buildCatTurnPlan(LANE, ctx),
    rootTies: (graph.get(`${stateKey(LANE)}\x00${D_CAT}`)?.equalActions ?? []).map(actionKeyOf),
    c1Ties: (graph.get(`${stateKey(L_C1)}\x00${D_CAT}`)?.equalActions ?? []).map(actionKeyOf),
  };
}

describe('§3 T4 — the lane fixture is the tree the root audit assumes', () => {
  test('legal order, geometry and transposition match the hand drawing', () => {
    expect(legalKeys(LANE)).toEqual(['step:ArrowUp', 'step:ArrowRight']);
    expect(L_C1.catPosition).toEqual({ r: 1, c: 4 });
    expect(L_B.catPosition).toEqual({ r: 0, c: 3 });
    expect(legalKeys(L_C1)).toEqual(['step:ArrowLeft', 'step:ArrowRight']);
    expect(legalKeys(L_B)).toEqual(['step:ArrowDown']);
    expect(stateKey(H_13A)).toBe(stateKey(H_13B));
    for (const h of [H_15, H_13A]) {
      expect(h.currentPlayer).toBe(PieceType.Mouse);
      expect(fullActionKeys(h)).toEqual(['mouseStep:ArrowLeft', 'mouseStep:ArrowRight']);
    }
    // Move ordering really does swap the root's first move (production config
    // has useMoveOrdering = true, so this swap is live).
    const on = runLane({ alphaBeta: false, ordering: true });
    const off = runLane({ alphaBeta: false, ordering: false });
    expect(on.res.diagnostics.orderingChangedFirstMove).toBeGreaterThan(0);
    expect(off.res.diagnostics.orderingChangedFirstMove).toBe(0);
  });

  test('unpruned ground truth: the right branch is the only 10', () => {
    expect(laneTrue(H_15)).toEqual({ value: 10, bound: 'exact' });
    expect(laneTrue(H_13A)).toEqual({ value: 2, bound: 'exact' });
    expect(laneTrue(L_C1, D_CAT)).toEqual({ value: 10, bound: 'exact' });
    expect(laneTrue(L_B, D_CAT)).toEqual({ value: 2, bound: 'exact' });
    expect(laneTrue(LANE, D_CAT)).toEqual({ value: 10, bound: 'exact' });
  });
});

describe('§3 T5 — the root no longer trades a certified pick for an uncertified tie', () => {
  // PRE-FIX measurement (expectiminimax.ts @ 891f12b6…, this file 11/11):
  //   p.res.action = 'step:ArrowUp' (true value 2) while n.res.action =
  //   'step:ArrowRight' (true value 10); p.sr.bound = 'upper'; p.rootTies =
  //   [ArrowRight, ArrowUp] and p.c1Ties = [ArrowRight, ArrowLeft]; the
  //   iterative wrapper reproduced the same swap. That second correctness bug
  //   is §3's question answered YES, and these assertions are its regression.
  test('the two arms agree on the root VALUE and on the root ACTION', () => {
    const n = runLane({ alphaBeta: false, ordering: true });
    const p = runLane({ alphaBeta: true, ordering: true });
    for (const arm of [n, p]) {
      expect(arm.res.value).toBe(10);
      expect(arm.res.completed).toBe(true);
      expect(arm.res.mate).toBeNull();
    }
    expect(p.ctx.diagnostics.alphaBetaCutoffs).toBeGreaterThan(0);
    expect(n.ctx.diagnostics.alphaBetaCutoffs).toBe(0);
    // Reference (no pruning): the root keeps the true optimum.
    expect(actionKeyOf(n.res.action!)).toBe('step:ArrowRight');
    expect(laneTrue(followLane('ArrowRight', 'ArrowRight')).value).toBe(10);
    expect(laneTrue(followLane('ArrowUp', 'ArrowDown')).value).toBe(2);
    // Pruned: the later-searched ArrowUp still REPORTS 10 (only as a bound),
    // and no longer takes the root over from the certified ArrowRight.
    expect(actionKeyOf(p.res.action!)).toBe('step:ArrowRight');
    expect(p.res.value).toBe(n.res.value);
    // The root's own score is now a proved value, not just a bound.
    expect({ v: p.sr.value, b: p.sr.bound }).toEqual({ v: 10, b: 'exact' });
  });

  test('the pruned arm still cuts, it just cannot claim the sibling is equal', () => {
    const p = runLane({ alphaBeta: true, ordering: true });
    // The cut leaf is the only one the pruned arm ever sees at that hand-off —
    // the pruning itself is untouched by the fix (no extra search cost).
    expect([...new Set(p.ev)].sort()).toEqual(['1,3|1,8', '1,5|1,6', '1,5|1,8']);
    expect(new Set(p.ev).has('1,3|1,6')).toBe(false);
    expect(p.graph.size).toBe(0);
    expect(p.rootTies).toEqual([]);
    expect(p.c1Ties).toEqual([]);
    // The root diagnostics now separate the two kinds of 10.
    expect(p.ctx.rootValues.map((r) => `${actionKeyOf(r.action)}=${r.value}/${r.bound}`))
      .toEqual(['step:ArrowRight=10/exact', 'step:ArrowUp=10/upper']);
  });

  test('with ordering OFF this geometry hides the false tie (exposure is order-dependent)', () => {
    const p = runLane({ alphaBeta: true, ordering: false });
    const n = runLane({ alphaBeta: false, ordering: false });
    expect(actionKeyOf(p.res.action!)).toBe('step:ArrowRight');
    expect({ v: p.sr.value, b: p.sr.bound }).toEqual({ v: 10, b: 'exact' });
    expect(p.rootTies).toEqual([]);
    expect(p.c1Ties).toEqual([]);
    expect(p.walked.map(actionKeyOf)).toEqual(['step:ArrowRight', 'step:ArrowRight']);
    expect(p.extracted.map(actionKeyOf)).toEqual(n.extracted.map(actionKeyOf));
    // Why: with ordering off the mouse node (cat 1,3) is entered by its LEGAL
    // first step ArrowLeft -> leaf 1,3|1,6 = 2, so the alpha-cutoff fires at 2
    // and REPORTS 2 — a value that cannot numerically tie the exact 10. A
    // cutoff reports the incumbent, not alpha, so the false tie needs the
    // 10-valued leaf to be searched first — which is exactly what move ordering
    // (production: on) does by prioritising the mouse's escape. With ordering
    // off, this geometry never reaches a numeric tie at all.
  });

  test('iterative deepening (production entry point) keeps the certified action', () => {
    const iter = (alphaBeta: boolean) => searchBestActionIterative(LANE, {
      rules, maxDepthTurns: D_CAT, maxNodes: 100_000,
      useTT: false, useAlphaBeta: alphaBeta, useMoveOrdering: true,
      leafEvaluator: makeLeafEvaluator(LEAVES_LANE, []),
    });
    const n = iter(false);
    const p = iter(true);
    expect(n.completedDepth).toBe(D_CAT);
    expect(p.completedDepth).toBe(D_CAT);
    expect(n.value).toBe(10);
    expect(p.value).toBe(10);
    expect(actionKeyOf(n.bestAction!)).toBe('step:ArrowRight');
    expect(actionKeyOf(p.bestAction!)).toBe('step:ArrowRight');
    // engine.ts:3832 executes `plan.plan[0] ?? plan.bestAction`, so `bestAction`
    // is a production surface, not a display field.
    expect(p.rootActions.map((r) => `${actionKeyOf(r.action)}=${r.value}/${r.bound}`))
      .toEqual(['step:ArrowRight=10/exact', 'step:ArrowUp=10/upper']);
    expect(p.catTurnPlan.map(actionKeyOf)).toEqual(n.catTurnPlan.map(actionKeyOf));
  });

  test('the TT is not required for the swap, and keeps its exact-only rule', () => {
    const plain = runLane({ alphaBeta: true, ordering: true, tt: false });
    const withTT = runLane({ alphaBeta: true, ordering: true, tt: true });
    expect(actionKeyOf(withTT.res.action!)).toBe(actionKeyOf(plain.res.action!));
    expect(withTT.sr.bound).toBe(plain.sr.bound);
    expect(withTT.ctx.tt.get(stateKey(H_13A))).toBeUndefined();
  });

  test('small, deterministic, no budget or clock', () => {
    const a = runLane({ alphaBeta: true, ordering: true });
    const b = runLane({ alphaBeta: true, ordering: true });
    expect(a.res.diagnostics.nodes).toBeLessThan(200);
    expect(a.res.diagnostics.nodes).toBe(b.res.diagnostics.nodes);
    expect(actionKeyOf(a.res.action!)).toBe(actionKeyOf(b.res.action!));
    expect(a.res.diagnostics.budgetCutoffs).toBe(0);
    expect(a.res.diagnostics.deadlineCutoffs).toBe(0);
  });
});

// ============================================================================
// §5 step 2 — the correctness target (these MUST fail on the pre-fix code and
// pass after the fix; they keep the counterexample inputs and the unpruned
// reference values, and only change which behaviour is asserted).
//
//   FALSE_EQUAL_PRIMARY_SELECTION = REJECTED
//   ALPHA_BETA_ON_PLAN_TRUE_VALUE = the unpruned reference value
//   CAT_TURN_PLAN                 = LEGAL_AND_COMPLETE
// ============================================================================

describe('§5 T6 — post-fix correctness target', () => {
  /** Execute `plan` from `root` (real rules) and measure the position handed to
   *  the mouse with an UNPRUNED reference search. */
  function planTrueValue(root: GameEngineState, plan: SearchAction[], table: Record<string, number>): number {
    let cur = root;
    for (const a of plan) {
      const t = simulateSearchAction(cur, a, rules);
      if (t.kind !== 'deterministic') break;
      cur = t.state;
    }
    expect(cur.currentPlayer).toBe(PieceType.Mouse); // the cat turn really ended
    expect(cur.mouseMovesLeft).toBe(1);
    return searchResult(cur, D_MOUSE, ctxFor(table, [], { alphaBeta: false })).value;
  }

  function armT3(alphaBeta: boolean) {
    const ev: string[] = [];
    const ctx = ctxFor(LEAVES_FALSE_TIE, ev, { alphaBeta });
    const res = searchBestAction(ROOT, D_CAT, ctx);
    const graph = ctx.equalPrimaryGraph as EqualPrimaryGraph;
    const branches = ctx.planBranches as Map<string, SearchAction>;
    return {
      res, ctx, graph,
      extracted: extractBestCatTurnPlan(ROOT, rules, graph, branches),
      ties: (graph.get(`${stateKey(ROOT)}\x00${D_CAT}`)?.equalActions ?? []).map(actionKeyOf),
      interior: [...graph.keys()].filter((k) => !k.startsWith(stateKey(ROOT))).length,
    };
  }

  test('T3 tree: the pruned plan is worth what the reported value says', () => {
    const n = armT3(false);
    const p = armT3(true);
    expect(p.res.value).toBe(n.res.value);
    // No interior cat node may advertise a primary tie it never proved…
    expect(p.interior).toBe(0);
    // …and the root tie disappears too, because in this tree the pruned arm
    // never resolves the sibling that used to be called equal. The unpruned
    // arm still records the genuine (proved) root tie.
    expect(p.ties).toEqual([]);
    expect(p.graph.size).toBe(0);
    expect(n.ties).toEqual(['step:ArrowUp', 'step:ArrowLeft']);
    // What the user sees: the same score, and the same plan in both arms.
    expect(p.extracted.map(actionKeyOf)).toEqual(n.extracted.map(actionKeyOf));
    expect(planTrueValue(ROOT, p.extracted, LEAVES_FALSE_TIE)).toBe(10);
    expect(planTrueValue(ROOT, n.extracted, LEAVES_FALSE_TIE)).toBe(10);
  });

  test('lane tree: the root keeps the certified action and the certified value', () => {
    const n = runLane({ alphaBeta: false, ordering: true });
    const p = runLane({ alphaBeta: true, ordering: true });
    expect(actionKeyOf(p.res.action!)).toBe(actionKeyOf(n.res.action!));
    expect({ v: p.sr.value, b: p.sr.bound }).toEqual({ v: 10, b: 'exact' });
    expect(p.graph.size).toBe(0);
    expect(p.extracted.map(actionKeyOf)).toEqual(n.extracted.map(actionKeyOf));
    expect(planTrueValue(LANE, p.extracted, LEAVES_LANE)).toBe(10);
    // The root diagnostics can now tell a proved score from a bounded one.
    expect(Object.keys(p.ctx.rootValues[0]).sort()).toEqual(['action', 'bound', 'mate', 'value']);
    expect(p.ctx.rootValues.map((r) => `${actionKeyOf(r.action)}=${r.value}/${r.bound}`))
      .toEqual(['step:ArrowRight=10/exact', 'step:ArrowUp=10/upper']);
  });

  test('the root action value equals the independently measured root value', () => {
    // §6 #10: BEST_ACTION_TRUE_VALUE == ROOT_TRUE_VALUE, checked against an
    // UNPRUNED reference search rather than against the search's own display.
    for (const ordering of [true, false]) {
      for (const alphaBeta of [true, false]) {
        const arm = runLane({ alphaBeta, ordering });
        const rootTrue = laneTrue(LANE, D_CAT);
        expect(rootTrue).toEqual({ value: 10, bound: 'exact' });
        expect(arm.res.value).toBe(rootTrue.value);
        expect(arm.sr.bound).toBe('exact');
        // The first step actually picked is itself worth the root value, and so
        // is the whole plan handed to the planner.
        const key = actionKeyOf(arm.res.action!).slice('step:'.length);
        expect(laneTrue(followLane(key), D_CAT)).toEqual({ value: 10, bound: 'exact' });
        expect(planTrueValue(LANE, arm.extracted, LEAVES_LANE)).toBe(10);
      }
    }
  });

  test('the fixed plans stay legal and complete the cat turn', () => {
    for (const [root, plan] of [
      [ROOT, armT3(true).extracted],
      [ROOT, armT3(false).extracted],
      [LANE, runLane({ alphaBeta: true, ordering: true }).extracted],
      [LANE, runLane({ alphaBeta: false, ordering: true }).extracted],
    ] as [GameEngineState, SearchAction[]][]) {
      const v = planFullTurnCompleteness(root, plan, rules);
      expect(['COMPLETE_TURN_BOUNDARY', 'COMPLETE_CHANCE_BOUNDARY']).toContain(v.kind);
    }
  });

  test('proved exact ties keep the frozen reversal reduction; unproved ones lose it', () => {
    // Same fixture as §5 T2 (every leaf 10). This is the documented PPC-RB1
    // cost: the tie-break optimiser needs a PROVED tie, so a plan that is equal
    // but unproved is no longer offered as an alternate. Strength is unchanged
    // (all these plans are worth 10); only route style can be lost.
    const ev: string[] = [];
    const ctx = ctxFor(LEAVES_FLAT, ev, { alphaBeta: false });
    searchBestAction(ROOT, D_CAT, ctx);
    const proved = extractBestCatTurnPlan(
      ROOT, rules, ctx.equalPrimaryGraph as EqualPrimaryGraph, ctx.planBranches as Map<string, SearchAction>);
    expect(proved.map(actionKeyOf)).toEqual(['step:ArrowUp', 'step:ArrowLeft']);
    expect(countReversals(proved)).toBe(0);
    expect(planTrueValue(ROOT, proved, LEAVES_FLAT)).toBe(10);

    const ev2: string[] = [];
    const ctx2 = ctxFor(LEAVES_FLAT, ev2, { alphaBeta: true });
    const pruned = searchBestAction(ROOT, D_CAT, ctx2);
    const plan2 = extractBestCatTurnPlan(
      ROOT, rules, ctx2.equalPrimaryGraph as EqualPrimaryGraph, ctx2.planBranches as Map<string, SearchAction>);
    expect(pruned.value).toBe(10);
    expect(planTrueValue(ROOT, plan2, LEAVES_FLAT)).toBe(10);
    expect(countReversals(plan2)).toBe(1); // vs 0 in the proved arm
  });

  test('forced-loss tie-break is not driven by an unknown bound', () => {
    const p = runLane({ alphaBeta: true, ordering: true });
    // forcedLossTieBreak trusts the caller's mate field, so the forced-loss
    // branch can be exercised on the real root values without a mate fixture.
    const fabricated = p.ctx.rootValues.map((r) => ({ ...r, mate: 'mouse' as const }));
    expect(fabricated.map((r) => `${actionKeyOf(r.action)}/${r.bound}`))
      .toEqual(['step:ArrowRight/exact', 'step:ArrowUp/upper']);
    // One proved candidate left → no primary tie → the side channel stays out
    // and the planner keeps the search's own plan (fail-safe direction).
    expect(forcedLossTieBreak(LANE, p.ctx, fabricated)).toBeNull();
    // CONTROL (the frozen G0.3A contract still holds): with a fully proved root
    // tie the forced-loss secondary does fire and returns a legal full turn.
    const ev: string[] = [];
    const ctx = ctxFor(LEAVES_FLAT, ev, { alphaBeta: false });
    searchBestAction(ROOT, D_CAT, ctx);
    expect(ctx.rootValues.map((r) => r.bound)).toEqual(['exact', 'exact']);
    const control = ctx.rootValues.map((r) => ({ ...r, mate: 'mouse' as const }));
    const plan = forcedLossTieBreak(ROOT, ctx, control);
    expect(plan).not.toBeNull();
    expect(plan!.length).toBeGreaterThan(0);
    expect(legalKeys(ROOT)).toContain(actionKeyOf(plan![0]));
    expect(['COMPLETE_TURN_BOUNDARY', 'COMPLETE_CHANCE_BOUNDARY'])
      .toContain(planFullTurnCompleteness(ROOT, plan!, rules).kind);
  });
});
