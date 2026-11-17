import { test, expect } from 'vitest';

import type { GameEngineState } from '../../engine';
import { GamePhase, PieceType, type Direction } from '../../types';
import type { SearchAction } from '../searchTypes';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { createSearchContext, searchBestAction } from '../expectiminimax';
import { maxCatTurnPlanActions } from '../planBound';
import {
  countPlanReversals,
  countReversals,
  extractBestCatTurnPlan,
  isImmediateReversal,
  isOppositeDirection,
  planFullTurnCompleteness,
  type EqualPrimaryGraph,
} from '../planQuality';
import { catTurnRoot, legalCatActions, rules, type Pt } from './planActionBoundFixtures';

/**
 * PPC-P1-QUALITY-01 — the reversal accounting gates.
 *
 * Registered defect: PPC-PLAN-001 (`PPC-NEXTGEN-01/CORRECTNESS_REGISTER.md`).
 * `extractDp` scored a branch as `actionReversal + countReversals(childPlan)`,
 * which charges the prefix edge and the child's interior but silently drops the
 * `action → childPlan[0]` edge created by the concatenation. Among exactly
 * equal-primary branches it could therefore return the plan with MORE real
 * reversals. The fix scores the concatenated plan once.
 *
 * Every gate below is stated against the plan the extractor actually returns —
 * none of them pins a buggy string.
 */

const LEAF = (s: GameEngineState): number => (s.trapPosition === null ? 0 : -1);

type CatStep = { type: 'catStep'; direction: Direction };

const STEP: Record<string, CatStep> = {
  U: { type: 'catStep', direction: { key: 'ArrowUp', dr: -1, dc: 0, label: '↑' } },
  D: { type: 'catStep', direction: { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' } },
  L: { type: 'catStep', direction: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } },
  R: { type: 'catStep', direction: { key: 'ArrowRight', dr: 0, dc: 1, label: '→' } },
};

function label(plan: SearchAction[]): string {
  return plan.map((a) => (a.type === 'catPlaceTrap' ? 'T' : a.type === 'catStep' ? a.direction!.key.slice(5)[0] : '?')).join('');
}

/** Direction key of a cat step; throws for anything else so a test can never
 *  silently compare a non-step as if it had a direction. */
function stepKeyOf(a: SearchAction): string {
  if (a.type !== 'catStep') throw new Error('not a cat step');
  return a.direction!.key;
}

/** A 10×10 board where only `open` is walkable; the mouse sits in the 2×2 hole. */
function boardWith(open: Set<string>, cat: Pt, moves: number, mouse: Pt): GameEngineState {
  const hole = { r: 7, c: 8, size: 2 };
  const walls: Pt[] = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (open.has(`${r},${c}`)) continue;
      if (r === cat.r && c === cat.c) continue;
      if (r === mouse.r && c === mouse.c) continue;
      if (r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size) continue;
      walls.push({ r, c });
    }
  }
  return catTurnRoot({ cat, mouse, catBaseMoves: moves, walls });
}

/** Vertical dead-end corridor (column 2). The far end forces a turn-around. */
function corridorV(moves: number): GameEngineState {
  const open = new Set<string>();
  for (let r = 0; r <= 6; r++) open.add(`${r},2`);
  return boardWith(open, { r: 1, c: 2 }, moves, { r: 7, c: 8 });
}

/** The same dead end, rotated: the reversal axis is Left/Right instead. */
function corridorH(moves: number): GameEngineState {
  const open = new Set<string>();
  for (let c = 0; c <= 6; c++) open.add(`2,${c}`);
  return boardWith(open, { r: 2, c: 1 }, moves, { r: 7, c: 8 });
}

/** A plus-shaped room: four equally cheap straight lines out of the centre. */
function crossRoom(): GameEngineState {
  const open = new Set<string>();
  for (let i = 0; i <= 4; i++) {
    open.add(`2,${i}`);
    open.add(`${i},2`);
  }
  return boardWith(open, { r: 2, c: 2 }, 2, { r: 7, c: 8 });
}

function runSearch(root: GameEngineState) {
  const ctx = createSearchContext(rules, 200_000, true, false, false, 0, false);
  ctx.capturePlan = true;
  ctx.leafEvaluator = LEAF;
  const got = searchBestAction(root, 1, ctx);
  return { got, ctx };
}

/** Every complete cat line reachable from `root` under the real rules. */
function enumerateCompleteLines(root: GameEngineState): { plan: SearchAction[]; endValue: number }[] {
  const cap = maxCatTurnPlanActions(root);
  const out: { plan: SearchAction[]; endValue: number }[] = [];

  const walk = (s: GameEngineState, plan: SearchAction[]): void => {
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat) {
      out.push({ plan, endValue: LEAF(s) });
      return;
    }
    if (plan.length >= cap) {
      out.push({ plan, endValue: LEAF(s) });
      return;
    }
    const actions = legalCatActions(s);
    if (actions.length === 0) {
      out.push({ plan, endValue: LEAF(s) });
      return;
    }
    for (const a of actions) {
      const t = simulateSearchAction(s, a, rules);
      if (t.kind !== 'deterministic') {
        out.push({ plan: [...plan, a], endValue: NaN });
        continue;
      }
      walk(t.state, [...plan, a]);
    }
  };

  walk(root, []);
  return out.filter((l) => {
    const verdict = planFullTurnCompleteness(root, l.plan, rules);
    return verdict.kind === 'COMPLETE_TURN_BOUNDARY'
      || verdict.kind === 'COMPLETE_CHANCE_BOUNDARY'
      || verdict.kind === 'GAME_ENDED'
      || verdict.kind === 'NO_LEGAL_ACTIONS';
  });
}

// ---------------------------------------------------------------------------
// QA-1 — the registered counterexample, on both axes and three move budgets
// ---------------------------------------------------------------------------

test('QA-1. exact tie: the extractor returns the minimum-reversal complete line, never the loop', () => {
  for (const [name, root, straight] of [
    ['V-M2', corridorV(2), 'DD'],
    ['V-M3', corridorV(3), 'DDD'],
    ['V-M4', corridorV(4), 'DDDD'],
    ['H-M2', corridorH(2), 'RR'],
    ['H-M3', corridorH(3), 'RRR'],
    ['H-M4', corridorH(4), 'RRRR'],
  ] as const) {
    const { got } = runSearch(root);
    expect(got.completed, `${name}: search completed`).toBe(true);
    expect(got.value, `${name}: primary value`).toBe(0);
    expect(got.mate, `${name}: no mate`).toBe(null);

    const plan = got.catTurnPlan;
    expect(plan.length, `${name}: full turn`).toBe(root.catMovesLeft);
    expect(planFullTurnCompleteness(root, plan, rules).kind, `${name}: complete`).toBe('COMPLETE_TURN_BOUNDARY');
    expect(countReversals(plan), `${name}: zero immediate reversals, got ${label(plan)}`).toBe(0);
    expect(label(plan), `${name}: straight line`).toBe(straight);

    // The loop that used to win is still a legal complete line — it is rejected
    // for being worse, not for being illegal.
    const loop = (straight[0] === 'D' ? 'U' : 'L') + straight.slice(1);
    const loopPlan = [...loop].map((ch) => STEP[ch]);
    expect(countReversals(loopPlan), `${name}: loop ${loop} has one reversal`).toBe(1);
    expect(
      planFullTurnCompleteness(root, loopPlan, rules).kind,
      `${name}: loop ${loop} is a complete turn, so legality is not the discriminator`,
    ).toBe('COMPLETE_TURN_BOUNDARY');
  }
});

test('QA-1b. the extractor attains the oracle minimum over ALL complete legal lines', () => {
  for (const [name, root] of [['V-M2', corridorV(2)], ['V-M3', corridorV(3)], ['H-M2', corridorH(2)], ['H-M3', corridorH(3)]] as const) {
    const { got } = runSearch(root);
    const lines = enumerateCompleteLines(root);
    expect(lines.length, `${name}: oracle found complete lines`).toBeGreaterThan(1);

    const best = Math.max(...lines.map((l) => l.endValue));
    const bestReversals = Math.min(...lines.filter((l) => l.endValue === best).map((l) => countReversals(l.plan)));

    expect(got.value, `${name}: primary value equals the oracle best`).toBe(best);
    expect(
      countReversals(got.catTurnPlan),
      `${name}: ${label(got.catTurnPlan)} must match the oracle minimum ${bestReversals}`,
    ).toBe(bestReversals);
  }
});

// ---------------------------------------------------------------------------
// QA-2/3/4/5 — the accounting contract, edge by edge
// ---------------------------------------------------------------------------

test('QA-2. the edge from an external prefix into the current action is charged', () => {
  expect(countPlanReversals('ArrowUp', [STEP.D])).toBe(1);
  expect(countPlanReversals('ArrowDown', [STEP.D])).toBe(0);
  expect(countPlanReversals('ArrowLeft', [STEP.D])).toBe(0);
  expect(countPlanReversals(null, [STEP.D]), 'no prefix, no edge').toBe(0);
  expect(isOppositeDirection('ArrowUp', 'ArrowDown')).toBe(true);
  expect(isOppositeDirection('ArrowUp', 'ArrowLeft')).toBe(false);
});

test('QA-3. the edge from the current action into the child plan head is charged', () => {
  // This is exactly the edge the old formula dropped: two-element plans used to
  // score 0 because `countReversals(childPlan)` had no interior pair to see.
  expect(countReversals([STEP.U]), 'inside one array there is no pair').toBe(0);
  expect(countPlanReversals(null, [STEP.U, STEP.D]), 'the joining edge is charged').toBe(1);
  expect(countReversals([STEP.U, STEP.D]), 'countReversals also sees it when concatenated').toBe(1);
  expect(countPlanReversals(null, [STEP.U, STEP.U])).toBe(0);
});

test('QA-4. every adjacent pair is charged exactly once, never twice', () => {
  const plan = [STEP.U, STEP.D, STEP.D, STEP.U, STEP.U];
  // pairs: U→D (1), D→D (0), D→U (1), U→U (0) => 2
  expect(countReversals(plan)).toBe(2);
  expect(countPlanReversals(null, plan), 'no prefix => identical to the batch count').toBe(2);

  // Adding a prefix must only add its own single edge, never re-charge anything.
  for (const prefix of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    const expected = countReversals(plan)
      + (isOppositeDirection(prefix, stepKeyOf(plan[0])) ? 1 : 0);
    expect(countPlanReversals(prefix, plan), `prefix ${prefix}`).toBe(expected);
  }

  // Longest legal-looking run: alternating directions, n-1 interior reversals.
  const alt = [STEP.U, STEP.D, STEP.U, STEP.D, STEP.U, STEP.D];
  expect(countPlanReversals(null, alt)).toBe(5);
});

test('QA-5. a zero-cost trap never manufactures a reversal on either side', () => {
  const trap: SearchAction = { type: 'catPlaceTrap' };
  expect(countPlanReversals('ArrowUp', [trap]), 'prefix step -> trap').toBe(0);
  expect(countPlanReversals(null, [trap, STEP.U]), 'trap -> step').toBe(0);
  expect(countPlanReversals('ArrowDown', [trap, STEP.U]), 'trap breaks the chain').toBe(0);
  expect(countPlanReversals('ArrowUp', [STEP.D, trap]), 'step -> trap').toBe(1);
  expect(countPlanReversals(null, [STEP.U, trap, STEP.D]), 'a trap in the middle breaks the pair').toBe(0);
  expect(countReversals([STEP.U, trap, STEP.D]), 'same for the batch count').toBe(0);
  expect(isImmediateReversal(STEP.U, trap)).toBe(false);
  expect(isImmediateReversal(trap, STEP.D)).toBe(false);
});

// ---------------------------------------------------------------------------
// QA-6/7 — memo context and stable ordering
// ---------------------------------------------------------------------------

test('QA-6. the memo keeps prefix contexts apart: the same state is never answered from the wrong direction', () => {
  // In the V-M3 corridor, the state "(1,2) with one move left" is reachable twice
  // inside ONE extraction:
  //   U then D  => incoming prefix Down, best continuation is D
  //   D then U  => incoming prefix Up,   best continuation is U
  // `extractDp`'s memo key carries `prevCatStepKey`, so those two visits must not
  // share an entry. A memo without the prefix would hand the first answer to the
  // second caller and the surviving root line would carry a phantom reversal.
  const root = corridorV(3);
  const { got, ctx } = runSearch(root);
  expect(countReversals(got.catTurnPlan), `got ${label(got.catTurnPlan)}`).toBe(0);

  // Order independence on the SAME real graph: reversing the recorded order of
  // the root tie must not change the answer when one branch is strictly better.
  const graph: EqualPrimaryGraph = new Map();
  const realGraph = ctx.equalPrimaryGraph ?? new Map<string, { state: GameEngineState; equalActions: SearchAction[] }>();
  for (const [key, node] of realGraph) graph.set(key, node);
  const rootGraphKey = [...graph.keys()].find((k) => k.slice(0, k.lastIndexOf('\x00')) === stateKey(root));
  expect(rootGraphKey, 'the real search recorded a root tie').toBeDefined();
  const rootNode = graph.get(rootGraphKey!)!;
  expect(rootNode.equalActions.length, 'root really is a tie').toBeGreaterThan(1);
  graph.set(rootGraphKey!, { state: rootNode.state, equalActions: [...rootNode.equalActions].reverse() });

  const reordered = extractBestCatTurnPlan(root, rules, graph, ctx.planBranches);
  expect(label(reordered), 'strictly better branch wins regardless of recording order').toBe('DDD');
  expect(countReversals(reordered)).toBe(0);
});

test('QA-7. equal-reversal branches keep the pre-existing stable order (first recorded wins)', () => {
  const root = crossRoom();
  // Four straight lines, all zero reversals, all the same primary value.
  const cases: [SearchAction, SearchAction, string][] = [
    [STEP.L, STEP.R, 'LL'],
    [STEP.R, STEP.L, 'RR'],
    [STEP.U, STEP.D, 'UU'],
    [STEP.D, STEP.U, 'DD'],
  ];

  for (const [first, second, expected] of cases) {
    const graph: EqualPrimaryGraph = new Map();
    graph.set(`${stateKey(root)}\x002`, { state: root, equalActions: [first, second] });

    const planBranches = new Map<string, SearchAction>();
    for (const head of [first, second]) {
      const t = simulateSearchAction(root, head, rules);
      expect(t.kind).toBe('deterministic');
      if (t.kind !== 'deterministic') continue;
      const key = stateKey(t.state);
      // The only continuation is "keep going in the same direction".
      planBranches.set(key, head);
    }

    const plan = extractBestCatTurnPlan(root, rules, graph, planBranches);
    expect(label(plan), `first=${label([first])} must win a 0-reversal tie`).toBe(expected);
    expect(countReversals(plan)).toBe(0);
  }
});

// ---------------------------------------------------------------------------
// QA-8 — nothing illegal, nothing incomplete
// ---------------------------------------------------------------------------

test('QA-8. every returned plan replays legally and certifies complete', () => {
  for (const root of [corridorV(2), corridorV(3), corridorV(4), corridorH(3), crossRoom()]) {
    const { got } = runSearch(root);
    expect(got.completed).toBe(true);

    let cur = root;
    for (const a of got.catTurnPlan) {
      const t = simulateSearchAction(cur, a, rules);
      expect(t.kind, 'plan action must be a legal deterministic cat action').toBe('deterministic');
      if (t.kind !== 'deterministic') break;
      expect(stateKey(t.state)).not.toBe(stateKey(cur));
      cur = t.state;
    }
    expect(cur.catMovesLeft, 'turn budget exhausted').toBe(0);
    expect(cur.currentPlayer, 'handed off to the mouse').toBe(PieceType.Mouse);
    expect(planFullTurnCompleteness(root, got.catTurnPlan, rules).kind).toBe('COMPLETE_TURN_BOUNDARY');
  }
});
