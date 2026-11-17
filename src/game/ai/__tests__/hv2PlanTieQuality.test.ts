import { test, expect } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState } from '../../engine';
import { GamePhase, PieceType, CellType, type Direction } from '../../types';
import type { GameConfig } from '../../config';
import { extractBestCatTurnPlan, countReversals, type EqualPrimaryGraph } from '../planQuality';
import { defaultRuleSet } from '../searchRules';
import type { SearchAction } from '../searchTypes';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';

/**
 * PPC-HV-2 §4C — minimal counterexample for the equal-primary plan DP.
 *
 * The DP used to score a branch by `actionReversal + countReversals(childPlan)`
 * (planQuality.ts:434 before PPC-P1-QUALITY-01). `countReversals` only walks
 * pairs INSIDE one array, so the pair that straddles the recursion boundary —
 * (action, childPlan[0]) — was never charged to the branch that contains it.
 * The child DP did consider that pair when choosing (it is the child's own
 * `actionReversal`), so the plan the child returned could legitimately contain
 * an immediate reversal at a tie, and the parent then scored that reversal as 0.
 *
 * PPC-P1-QUALITY-01 replaced the two-half sum with a single
 * `countPlanReversals(prefix, [action, ...childPlan])` over the concatenated
 * plan, so C1 is now a live gate instead of a reproduction. This root is a
 * PROVEN exact tie (both actions sit in `equalActions`), which is the only place
 * secondary optimisation is allowed. Nothing here changes a primary score; it
 * only says that among exactly-equal continuations the one with fewer real
 * reversals must win.
 */

function cleanConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: { r: 0, c: 0 },
    catStart: { r: 5, c: 5 },
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    catBaseMoves: 4,
    gameMode: 'single',
    difficulty: 'hard',
    tunnelCorners: [{ r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 }],
    ...overrides,
  };
}

/** A plus-shaped corridor: column 5 and row 5 walkable, everything else walled. */
function mkRoot(): GameEngineState {
  const open = new Set<string>();
  for (let i = 0; i < 10; i++) {
    open.add(`${i},5`);
    open.add(`5,${i}`);
  }
  let s = createInitialState(cleanConfig());
  const board: GameEngineState['board'] = s.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) return cell;
      if (open.has(`${r},${c}`)) return { ...cell, type: CellType.Empty, piece: undefined, hasButter: false };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  board[0][0] = { ...board[0][0], piece: PieceType.Mouse };
  board[5][5] = { ...board[5][5], piece: PieceType.Cat };
  return {
    ...s,
    board,
    mousePosition: { r: 0, c: 0 },
    catPosition: { r: 5, c: 5 },
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    trapPosition: null,
    catTrapsRemaining: 0,
  };
}

const step = (key: 'ArrowUp' | 'ArrowDown'): SearchAction => ({
  type: 'catStep',
  direction: key === 'ArrowUp'
    ? ({ key, dr: -1, dc: 0, label: '↑' } as Direction)
    : ({ key, dr: 1, dc: 0, label: '↓' } as Direction),
});

// PPC-P1-QUALITY-01: the reproduction is now a GATE. The accounting fix in
// `extractDp` (a single `countPlanReversals(prefix, [action, ...childPlan])`)
// makes this pass, so it is un-skipped exactly as the original note required.
test('HV2-C1. exact-tie branches are compared by the TRUE reversal count of the whole plan', () => {
  const root = mkRoot();
  const graph: EqualPrimaryGraph = new Map();
  graph.set(`${stateKey(root)}\x002`, {
    state: root,
    // Proven exact tie, in this order: Up first.
    equalActions: [step('ArrowUp'), step('ArrowDown')],
  });

  // Each branch has exactly one continuation (no tie below), chosen so that:
  //   Up  → Down  = cat walks back onto its own starting square (1 real reversal)
  //   Down→ Down  = cat keeps walking down                  (0 reversals)
  const planBranches = new Map<string, SearchAction>();
  for (const [first, second] of [['ArrowUp', 'ArrowDown'], ['ArrowDown', 'ArrowDown']] as const) {
    const trans = simulateSearchAction(root, step(first), defaultRuleSet);
    expect(trans.kind, `branch ${first} must be deterministic`).toBe('deterministic');
    if (trans.kind === 'deterministic') planBranches.set(stateKey(trans.state), step(second));
  }

  const plan = extractBestCatTurnPlan(root, defaultRuleSet, graph, planBranches);
  const trueReversals = countReversals(plan);
  const keys = plan.map((a) => (a.type === 'catStep' ? a.direction.key : 'Trap'));

  // The counterexample condition itself, stated independently of the DP:
  expect(trueReversals >= 1 ? 'loop' : 'progress', `${JSON.stringify(keys)} reversal count`).toBe('progress');

  // And the required behaviour: among two exactly-equal primary branches, the
  // zero-reversal one must be returned.
  expect(keys, `plan ${JSON.stringify(plan)}`).toEqual(['ArrowDown', 'ArrowDown']);
  expect(trueReversals, 'countReversals of the returned plan').toBe(0);
});

test('HV2-C2. countReversals sees only pairs inside one array (which is why the DP needs its own prefix-aware count)', () => {
  // Documents the primitive that the old DP misused: `countReversals` is a
  // BATCH counter over one array. Concatenating two scored halves and adding
  // their numbers is not the same as scoring the concatenation — which is what
  // C1 caught. Since PPC-P1-QUALITY-01 the DP calls `countPlanReversals` on the
  // full plan instead, so this primitive keeps its narrow, honest meaning.
  expect(countReversals([step('ArrowUp')])).toBe(0);
  expect(countReversals([step('ArrowDown')])).toBe(0);
  expect(countReversals([step('ArrowUp'), step('ArrowDown')])).toBe(1);
});
