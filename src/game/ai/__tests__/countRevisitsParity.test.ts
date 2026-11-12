/// <reference types="node" />
/**
 * PPC-FLT-FIX-1R P1 — `countRevisits` spatial-consistency acceptance.
 *
 * The audit's P1 defect was that a zero-move `catPlaceTrap` was counted as a
 * revisit. `countRevisits` is a standalone helper (no production call sites);
 * this file pins it to the SAME spatial semantics the production candidate
 * builder now uses, and proves the production path still agrees with it:
 *
 *   - a trap (zero-move action) is NOT a revisit;
 *   - a real back-and-forth IS counted;
 *   - a box push uses the cat's NEW cell;
 *   - the final CHANCE cell is included (all outcomes agree);
 *   - the plan/root are never mutated;
 *   - the G0.3A comparator order is unchanged.
 */
import { expect, test } from 'vitest';
import { createEngineRuleSet, createInitialState } from '../../engine';
import type { GameEngineState } from '../../engine';
import type { GameConfig } from '../../config';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../types';
import {
  buildCandidate,
  compareCatTurnPlanQuality,
  countRevisits,
  dirKey,
  type CandidatePlan,
} from '../planQuality';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { evaluateForCat } from '../evaluation';
import { createSearchContext } from '../expectiminimax';
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
    traps?: number;
    box?: { r: number; c: number };
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
  if (opts.box) board[opts.box.r][opts.box.c] = { ...board[opts.box.r][opts.box.c], type: CellType.Box, piece: undefined };
  return {
    ...base,
    board,
    catPosition: { ...cat },
    mousePosition: { ...mouse },
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
    pendingButterSpawns: (opts.ghosts ?? []).map((g) => ({ r: g.r, c: g.c, blockedMaterializations: 0 })),
    pendingButterPlacementDebt: 0,
    catTrapsRemaining: opts.traps ?? 0,
    trapPosition: null,
    butterPositions: [],
  };
}

const D = (key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): SearchAction => ({
  type: 'catStep',
  direction: DIRECTIONS.find((d) => d.key === key)!,
});
const L = D('ArrowLeft');
const R = D('ArrowRight');
const TRAP: SearchAction = { type: 'catPlaceTrap' };

function chainCtx(root: GameEngineState, plan: SearchAction[]) {
  const ctx = createSearchContext(rules, 1_000_000, false, false, false, 0);
  ctx.leafEvaluator = evaluateForCat;
  let cur = root;
  for (const a of plan) {
    ctx.planBranches.set(stateKey(cur), a);
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
  }
  return ctx;
}

function rc(p: { r: number; c: number }): string {
  return `${p.r},${p.c}`;
}

/** Independent spatial walk: record the cat's cell only when it changes. */
function spatialCells(root: GameEngineState, plan: SearchAction[]): string[] {
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
    if (t.kind !== 'deterministic') break;
    cur = t.state;
    const cell = rc(cur.catPosition);
    if (cell !== out[out.length - 1]) out.push(cell);
  }
  return out;
}

function duplicates(cells: string[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const c of cells) {
    if (seen.has(c)) n++;
    seen.add(c);
  }
  return n;
}

// ===========================================================================
// P1-a — zero-move trap is NOT a revisit (helper == candidate)
// ===========================================================================
test('P1 trap is a zero-move action: no revisit in the helper or the candidate', () => {
  const root = openBoard({ r: 5, c: 5 }, { r: 3, c: 3 }, { traps: 1 });
  const trapPlan = [TRAP, L, L, L, L];
  const movePlan = [L, L, L, L];

  expect(spatialCells(root, trapPlan)).toEqual(['5,5', '5,4', '5,3', '5,2', '5,1']);
  expect(countRevisits(root, trapPlan, rules)).toBe(0);
  expect(countRevisits(root, movePlan, rules)).toBe(0);

  const cTrap = buildCandidate(root, trapPlan[0], chainCtx(root, trapPlan), 0)!;
  const cMove = buildCandidate(root, movePlan[0], chainCtx(root, movePlan), 0)!;
  expect(cTrap.plan.map(dirKey)).toEqual(['catPlaceTrap', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']);
  expect(cTrap.revisitCount).toBe(countRevisits(root, cTrap.plan, rules));
  expect(cMove.revisitCount).toBe(countRevisits(root, cMove.plan, rules));
  expect(cTrap.revisitCount).toBe(0);
  expect(cMove.revisitCount).toBe(0);
});

// ===========================================================================
// P1-b — real back-and-forth still counted
// ===========================================================================
test('P1 real back-and-forth is still counted (3 revisits)', () => {
  const root = openBoard({ r: 5, c: 5 }, { r: 3, c: 3 });
  const plan = [L, R, L, R];
  expect(spatialCells(root, plan)).toEqual(['5,5', '5,4', '5,5', '5,4', '5,5']);
  expect(countRevisits(root, plan, rules)).toBe(3);

  const cand = buildCandidate(root, plan[0], chainCtx(root, plan), 0)!;
  expect(cand.revisitCount).toBe(3);
  expect(cand.revisitCount).toBe(countRevisits(root, cand.plan, rules));
});

// ===========================================================================
// P1-c — a box push uses the cat's NEW cell
// ===========================================================================
test('P1 box push records the cat cell it lands on', () => {
  const root = openBoard({ r: 5, c: 5 }, { r: 3, c: 3 }, { box: { r: 5, c: 4 } });
  const plan = [L, R, L, R];

  // Every action is a real push/walk and the cat actually moves.
  let cur = root;
  const cells = [rc(root.catPosition)];
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    expect(t.kind).toBe('deterministic');
    if (t.kind !== 'deterministic') return;
    cur = t.state;
    cells.push(rc(cur.catPosition));
  }
  expect(cells).toEqual(['5,5', '5,4', '5,5', '5,4', '5,5']);
  expect(countRevisits(root, plan, rules)).toBe(3);

  // The first push really moved a box, not a free step.
  const push = simulateSearchAction(root, L, rules);
  expect(push.kind).toBe('deterministic');
  if (push.kind !== 'deterministic') return;
  expect(push.state.board[5][3].type).toBe(CellType.Box);
  expect(push.state.catPosition).toEqual({ r: 5, c: 4 });
});

// ===========================================================================
// P1-d — the final CHANCE cell is included
// ===========================================================================
test('P1 final CHANCE step is not dropped from the spatial sequence', () => {
  // Ghost on an empty cell materializes deterministically at the handoff, so
  // the boundary has ONE outcome whose cat cell is the post-move cell.
  const root = openBoard({ r: 5, c: 5 }, { r: 3, c: 3 }, { ghosts: [{ r: 2, c: 2 }] });
  const plan = [L, R, L, R];

  expect(spatialCells(root, plan)).toEqual(['5,5', '5,4', '5,5', '5,4', '5,5']);
  expect(countRevisits(root, plan, rules)).toBe(3);

  // Reverse control: dropping the final cell would report only 2.
  expect(duplicates(['5,5', '5,4', '5,5', '5,4'])).toBe(2);

  const cand = buildCandidate(root, plan[0], chainCtx(root, plan), 0)!;
  expect(cand.revisitCount).toBe(3);
  expect(cand.revisitCount).toBe(countRevisits(root, cand.plan, rules));
});

// ===========================================================================
// P1-e — no mutation + unchanged G0.3A ordering
// ===========================================================================
test('P1 countRevisits mutates nothing and the comparator order is unchanged', () => {
  const root = openBoard({ r: 5, c: 5 }, { r: 3, c: 3 }, { ghosts: [{ r: 2, c: 2 }] });
  const plan = [L, R, L, R];
  const planSnapshot = plan.map(dirKey);
  const rootSnapshot = stateKey(root);

  countRevisits(root, plan, rules);

  expect(plan.map(dirKey)).toEqual(planSnapshot);
  expect(stateKey(root)).toBe(rootSnapshot);
  expect(root.catPosition).toEqual({ r: 5, c: 5 });

  const cand = (over: Partial<CandidatePlan>): CandidatePlan => ({
    firstAction: L,
    firstActionKey: 'ArrowLeft',
    plan: [L],
    reversalCount: 0,
    revisitCount: 0,
    uniqueProgress: 0,
    boundaryEval: 0,
    originalIndex: 0,
    ...over,
  });

  // reversalCount dominates
  expect(compareCatTurnPlanQuality(cand({ reversalCount: 1 }), cand({ reversalCount: 0 }))).toBeGreaterThan(0);
  // then revisitCount (fewer wins)
  expect(compareCatTurnPlanQuality(cand({ revisitCount: 3 }), cand({ revisitCount: 0 }))).toBeGreaterThan(0);
  // then boundaryEval (higher wins) when the geometry ties
  expect(compareCatTurnPlanQuality(cand({ boundaryEval: 10 }), cand({ boundaryEval: -5 }))).toBeLessThan(0);
  // then stable originalIndex
  expect(compareCatTurnPlanQuality(cand({ originalIndex: 0 }), cand({ originalIndex: 1 }))).toBeLessThan(0);
  // forced-loss mode skips uniqueProgress but keeps the rest
  expect(compareCatTurnPlanQuality(
    cand({ uniqueProgress: 0, boundaryEval: 10 }),
    cand({ uniqueProgress: 5, boundaryEval: -5 }),
    'forced-loss-original',
  )).toBeLessThan(0);
});
