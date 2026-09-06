import { test, expect, describe } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState } from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import { createSearchContext, searchBestAction } from '../expectiminimax';
import {
  extractBestCatTurnPlan,
  planFullTurnCompleteness,
  type EqualPrimaryGraph,
} from '../planQuality';
import { createEngineRuleSet } from '../../engine';
import type { RuleSet } from '../searchTypes';
import { setHardLeafMode, resolveHardLeaf } from '../hybridLeaf';
import { simulateSearchAction } from '../simulator';
import type { SearchAction } from '../searchTypes';
import type { Direction } from '../../types';

setHardLeafMode('baseline_hole_corrected');
const rules: RuleSet = createEngineRuleSet();

const TUNNELS = [{ r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 }];

type CellData = GameEngineState['board'][number][number];

/** Build a legal canonical board with the cat/mouse placed on empty cells,
 *  an open corridor connecting them, and optional pending ghost/debt/trap. */
function buildRoot(
  cat: { r: number; c: number },
  mouse: { r: number; c: number },
  opts: { ghosts?: { r: number; c: number }[]; debt?: number; trap?: boolean; carrying?: boolean; boxCells?: { r: number; c: number }[] } = {},
): GameEngineState {
  const cfg: GameConfig = {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0, pileCount: 0, butterCount: 0,
    mouseStart: mouse, catStart: cat,
    mouseBaseMoves: 4, mouseCarryingMoves: 3, mouseSkillExtraMoves: 3,
    catBaseMoves: 4, gameMode: 'single', difficulty: 'hard',
    tunnelCorners: TUNNELS,
  };
  const base = createInitialState(cfg);
  const board: CellData[][] = base.board.map(row => row.map(cell => {
    if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) return { ...cell, piece: undefined };
    return { ...cell, type: CellType.Empty, piece: undefined, hasButter: false };
  }));
  for (const b of opts.boxCells ?? []) board[b.r][b.c] = { ...board[b.r][b.c], type: CellType.Box };
  board[cat.r][cat.c] = { ...board[cat.r][cat.c], piece: PieceType.Cat };
  board[mouse.r][mouse.c] = { ...board[mouse.r][mouse.c], piece: PieceType.Mouse };
  return {
    ...base, board,
    catPosition: { ...cat }, mousePosition: { ...mouse },
    currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: opts.carrying ?? false,
    pendingButterSpawns: (opts.ghosts ?? []).map(g => ({ r: g.r, c: g.c, blockedMaterializations: 0 })),
    pendingButterPlacementDebt: opts.debt ?? 0,
    catTrapsRemaining: opts.trap ? 1 : 0,
    trapPosition: null,
    butterPositions: [],
  };
}

/** Run a deterministic D1 search with plan capture (same harness as §6/§7). */
function d1Plan(root: GameEngineState): { plan: SearchAction[]; res: ReturnType<typeof searchBestAction>; graph: EqualPrimaryGraph; branches: Map<string, SearchAction> } {
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0);
  ctx.capturePlan = true;
  ctx.leafEvaluator = resolveHardLeaf();
  const res = searchBestAction(root, 1, ctx);
  const graph = ctx.equalPrimaryGraph as EqualPrimaryGraph;
  const branches = ctx.planBranches as Map<string, SearchAction>;
  const plan = extractBestCatTurnPlan(root, rules, graph, branches);
  return { plan, res, graph, branches };
}

/** Narrow a PlanCompletionVerdict to the COMPLETE_* members and assert
 *  catMovesLeft === 0 (lint-clean discriminated check). */
function expectComplete(v: ReturnType<typeof planFullTurnCompleteness>): void {
  if (v.kind === 'COMPLETE_TURN_BOUNDARY' || v.kind === 'COMPLETE_CHANCE_BOUNDARY') {
    expect(v.catMovesLeft).toBe(0);
  } else {
    expect(v.kind).toBe('COMPLETE_TURN_BOUNDARY');
  }
}
function expectTruncated(v: ReturnType<typeof planFullTurnCompleteness>): void {
  if (v.kind === 'TRUNCATED') {
    expect(v.catMovesLeft).toBeGreaterThan(0);
  } else {
    expect(v.kind).toBe('TRUNCATED');
  }
}

describe('G0.4F-2B-1.9B §18 — chance authority', () => {
  test('C1. final Cat action → deterministic Mouse boundary: plan complete', () => {
    // Cat at (5,5), mouse near; open cross corridor; no ghosts.
    const root = buildRoot({ r: 5, c: 5 }, { r: 1, c: 1 });
    const { plan, res } = d1Plan(root);
    expect(plan.length).toBeGreaterThan(0);
    const v = planFullTurnCompleteness(root, plan, rules);
    // No ghost → the final catStep hits a deterministic TURN_BOUNDARY.
    expectComplete(v);
    expect(res.mate).toBeNull();
  });

  test('C2. final Cat action → ghost CHANCE boundary: cat action preserved, plan complete', () => {
    // Same board as C1 but with ONE pending ghost → the final catStep ends at
    // a CAT→MOUSE ghost CHANCE boundary. Cat action must be preserved (4 moves
    // when a full turn is possible).
    const root = buildRoot({ r: 5, c: 5 }, { r: 1, c: 1 }, { ghosts: [{ r: 2, c: 2 }] });
    const { plan } = d1Plan(root);
    expect(plan.length).toBeGreaterThan(0);
    const v = planFullTurnCompleteness(root, plan, rules);
    expectComplete(v);

    // A full cat turn on this open board is 4 catSteps.
    expect(plan.length).toBe(4);
    // Replay the plan: each non-final action is deterministic; the FINAL action
    // transitions to 'chance' (ghost boundary) but is itself a cat action that
    // MUST sit in the plan (this is the repaired pre-extraction skip).
    let cur = root;
    for (let i = 0; i < plan.length; i++) {
      const a = plan[i];
      if (i === plan.length - 1) {
        const lastTrans = simulateSearchAction(cur, a, rules);
        expect(lastTrans.kind).toBe('chance');
        // even though the child is chance, the action stays in the plan
        expect(a.type).toBe('catStep');
      } else {
        const t = simulateSearchAction(cur, a, rules);
        expect(t.kind).toBe('deterministic');
        if (t.kind === 'deterministic') cur = t.state;
      }
    }
  });

  test('C3. mid-plan chance is impossible for cat actions (invariant documented)', () => {
    // INVARIANT: for CAT actions, simulateSearchAction returns 'chance' ONLY on
    // the FINAL catStep (catMovesLeft 1->0 at a CAT→MOUSE ghost/debt boundary).
    // Proof: simulateSearchAction catStep → rules.catMove + forceEndTurnIfNeeded;
    // forceEndTurnIfNeeded only builds the ghost/debt CHANCE when
    // catMovesLeft<=0 (see simulator.ts). catPlaceTrap is always deterministic.
    // A catStep with catMovesLeft 4/3/2 can never be chance.
    const root = buildRoot({ r: 5, c: 5 }, { r: 1, c: 1 }, { ghosts: [{ r: 2, c: 2 }], debt: 1 });
    // First action from catMovesLeft=4:
    const firstActions = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    for (const k of firstActions) {
      const dir: Direction = { key: k, dr: 0, dc: 0, label: '' };
      const t = simulateSearchAction(root, { type: 'catStep', direction: dir }, rules);
      // catMovesLeft=4 → first step cannot end the turn → never chance.
      expect(t.kind).toBe('deterministic');
    }
    // catPlaceTrap is deterministic even with ghosts/debt pending.
    const tTrap = simulateSearchAction(root, { type: 'catPlaceTrap' }, rules);
    expect(tTrap.kind).toBe('deterministic');
  });
});

describe('G0.4F-2B-1.9B §5 — full-turn completeness invariant helper', () => {
  test('completeness: truncated plan is TRUNCATED, full plan is COMPLETE', () => {
    const root = buildRoot({ r: 5, c: 5 }, { r: 1, c: 1 });
    // Construct a 3-step plan (truncated: 1 move left).
    const truncated: SearchAction[] = [
      { type: 'catStep', direction: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } },
      { type: 'catStep', direction: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } },
      { type: 'catStep', direction: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } },
    ];
    const v = planFullTurnCompleteness(root, truncated, rules);
    expectTruncated(v);
  });

  test('completeness: full 4-step plan → COMPLETE_TURN_BOUNDARY catMovesLeft=0', () => {
    const root = buildRoot({ r: 5, c: 5 }, { r: 1, c: 1 });
    const full: SearchAction[] = ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft'].map(key => ({ type: 'catStep', direction: { key, dr: 0, dc: -1, label: '←' } as Direction }));
    const v = planFullTurnCompleteness(root, full, rules);
    expectComplete(v);
  });

  test('completeness: real truncated authority shape (3 steps + 1 ghost) → TRUNCATED, not complete', () => {
    // G1T6 pre-repair shape: catMovesLeft=4, ghosts pending → truncated 3-step
    // extraction leaves catMovesLeft=1.
    const root = buildRoot({ r: 5, c: 5 }, { r: 1, c: 1 }, { ghosts: [{ r: 2, c: 2 }] });
    const truncated: SearchAction[] = [
      { type: 'catStep', direction: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } },
      { type: 'catStep', direction: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } },
      { type: 'catStep', direction: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } },
    ];
    const v = planFullTurnCompleteness(root, truncated, rules);
    expectTruncated(v);
  });
});
