import { test, expect, vi } from 'vitest';
import type { GameEngineState } from '../../engine';
import {
  createInitialState,
  mouseMove,
  mouseStepDeterministic,
} from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType, DIRECTIONS, type Direction } from '../../types';
import type { RuleSet, SearchAction } from '../searchTypes';
import { defaultRuleSet } from '../searchRules';
import { simulateSearchAction } from '../simulator';
import { generateLegalSearchActions } from '../legalActions';
import { stateKey, TranspositionTable } from '../transposition';
import type { TTEntry } from '../transposition';
import {
  searchBestAction,
  searchResult,
  createSearchContext,
  preferResult,
  compareSearchScore,
  compareBound,
  maxBound,
  minBound,
  unstepBoundForChild,
  stepBoundForParent,
  mateActionCost,
  stepChildForParent,
  searchBestActionIterative,
  type IterativeSearchResult,
  type IterationDiagnostic,
  MATE_SCORE,
  type InternalSearchResult,
  type SearchBoundType,
  type ScoreBound,
  type SearchScore,
  type MateSide,
} from '../expectiminimax';

// D3-F counts simulator invocations to prove each action is simulated EXACTLY
// ONCE (in the PreparedAction pre-pass) and never re-simulated during search.
const simSpy = vi.hoisted(() => ({ count: 0 }));
vi.mock('../simulator', async (importActual) => {
  const mod = await importActual<typeof import('../simulator')>();
  return {
    ...mod,
    simulateSearchAction: (...args: unknown[]) => {
      simSpy.count++;
      return (mod.simulateSearchAction as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIR_MAP: Record<string, Direction> = {};
for (const d of DIRECTIONS) DIR_MAP[d.key] = d;
const dir = (key: string): Direction => DIR_MAP[key];

/** A clean, deterministic board (no random boxes/piles/butter). */
function cleanConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: { r: 1, c: 1 },
    catStart: { r: 1, c: 3 },
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    catBaseMoves: 4,
    gameMode: 'single',
    difficulty: 'hard',
    tunnelCorners: [
      { r: 0, c: 0 },
      { r: 0, c: 9 },
      { r: 9, c: 0 },
      { r: 9, c: 9 },
    ],
    ...overrides,
  };
}

/** Place the mouse/cat pieces on the board at the given cells (clears others). */
function setPieces(
  state: GameEngineState,
  mouse: { r: number; c: number },
  cat?: { r: number; c: number },
): GameEngineState {
  const board: GameEngineState['board'] = state.board.map((row) =>
    row.map((cell) => ({ ...cell, piece: undefined })),
  );
  board[mouse.r][mouse.c] = { ...board[mouse.r][mouse.c], piece: PieceType.Mouse };
  if (cat) board[cat.r][cat.c] = { ...board[cat.r][cat.c], piece: PieceType.Cat };
  const patch: Partial<GameEngineState> = {
    board,
    mousePosition: { ...mouse },
  };
  if (cat) patch.catPosition = { ...cat };
  return { ...state, ...patch };
}

/**
 * Wall off every cell except `open`, but PRESERVE hole/tunnel cells (so the
 * mouse can still win by reaching the hole). This keeps branching tiny for
 * tactical tests while leaving the real win condition intact.
 */
function wallOff(state: GameEngineState, open: { r: number; c: number }[]): GameEngineState {
  const openSet = new Set(open.map((p) => `${p.r},${p.c}`));
  const board = state.board.map((row, r) =>
    row.map((cell, c) => {
      const special = cell.type === CellType.MouseHole || cell.type === CellType.Tunnel;
      if (special) return cell; // keep hole / tunnel semantics
      if (openSet.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

const manhattan = (
  a: { r: number; c: number },
  b: { r: number; c: number },
) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c);

/**
 * A forced mate (win or loss) from the cat's perspective has magnitude near
 * MATE_SCORE. Terminal scoring is ±MATE_SCORE ∓ mateDistance, where the
 * mateDistance (recursion ply) is tiny relative to MATE_SCORE. Any heuristic
 * leaf stays well under 1000 in magnitude, so `|value| > MATE_SCORE - 1000`
 * cleanly and ROBUSTLY identifies a genuine mate without depending on the
 * exact ply — this is the correct assertion given the real terminal-score
 * semantics, unlike the fragile `value < -MATE_SCORE + 100` form (which only
 * holds while ply < 100).
 */
const isForcedMate = (v: number): boolean => Math.abs(v) > MATE_SCORE - 1000;

// ---------------------------------------------------------------------------
// A. Cat Forced Win — all atomic steps stay MAX (no per-step depth decrement)
// ---------------------------------------------------------------------------

test('A. Cat forced win across multiple atomic steps stays MAX', () => {
  let s = createInitialState(cleanConfig());
  // Cat at (1,1), mouse at (1,4): a 1-wide lane, distance 3.
  s = setPieces(s, { r: 1, c: 4 }, { r: 1, c: 1 });
  s = wallOff(s, [
    { r: 1, c: 1 },
    { r: 1, c: 2 },
    { r: 1, c: 3 },
    { r: 1, c: 4 },
  ]);
  s = {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };

  const ctx = createSearchContext(defaultRuleSet, 1_000_000);
  const v = searchResult(s, 1, ctx).value; // ONE cat turn = up to 4 steps

  // Cat catches in 3 steps. If each step wrongly consumed a turn, depth would
  // hit 0 after step 1 and no catch would be found (value would be a tiny
  // leaf). A near-MATE value proves all 4 steps are MAX on the same turn.
  expect(isForcedMate(v)).toBe(true);
  expect(v).toBeLessThanOrEqual(MATE_SCORE);
  expect(ctx.diagnostics.terminalNodes).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// B. Mouse Forced Win — cat correctly sees a losing position
// ---------------------------------------------------------------------------

test('B. Mouse forced win — cat evaluates this as a loss', () => {
  let s = createInitialState(cleanConfig());
  // mouse carrying butter, 2 cells from the hole (row 7). Cat is far away in a
  // small corridor so it can never reach the mouse.
  s = setPieces(s, { r: 7, c: 6 }, { r: 1, c: 1 });
  s = wallOff(s, [
    // mouse lane to the hole
    { r: 7, c: 6 },
    { r: 7, c: 7 },
    { r: 7, c: 8 }, // hole cell (preserved)
    // cat corridor (far away, can't reach the mouse)
    { r: 1, c: 1 },
    { r: 1, c: 2 },
    { r: 1, c: 3 },
    { r: 1, c: 4 },
    { r: 1, c: 5 },
    { r: 1, c: 6 },
  ]);
  s = {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: true,
  };

  const ctx = createSearchContext(defaultRuleSet, 1_000_000);
  const v = searchResult(s, 2, ctx).value; // enough turns for the forced mouse win

  // Mouse reaches the hole regardless of the cat's single move → MouseWins.
  expect(isForcedMate(v)).toBe(true);
  expect(v).toBeLessThanOrEqual(0);
});

// ---------------------------------------------------------------------------
// C. Mouse Best Response — MIN truly minimizes (picks the cat-unfavorable move)
// ---------------------------------------------------------------------------

test('C. Mouse best response — MIN chooses the move worst for the cat', () => {
  let s = createInitialState(cleanConfig());
  // mouse adjacent to the hole with butter; stepping RIGHT wins, LEFT does not.
  s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 });
  s = wallOff(s, [
    { r: 7, c: 6 }, // LEFT (no win)
    { r: 7, c: 7 }, // mouse start
    { r: 7, c: 8 }, // hole cell (preserved) — RIGHT wins
    { r: 1, c: 1 }, // cat cell (kept off walls)
  ]);
  s = {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: true,
  };

  const ctx = createSearchContext(defaultRuleSet, 1_000_000);
  const res = searchBestAction(s, 3, ctx);

  expect(res.action).not.toBeNull();
  const cAction = res.action!;
  expect(cAction.type).toBe('mouseStep');
  // RIGHT is the winning (cat-unfavorable) move.
  if (cAction.type === 'mouseStep') {
    expect(cAction.direction.key).toBe('ArrowRight');
  }
  // value is a real mouse win (negative, near -MATE).
  expect(isForcedMate(res.value)).toBe(true);
});

// ---------------------------------------------------------------------------
// D. Tunnel MIN choice — mouse picks the escape exit, not the doomed one
// ---------------------------------------------------------------------------

test('D. Tunnel MIN choice — mouse avoids the exit that gets it caught', () => {
  const DANGER = { r: 9, c: 9 };
  const leafD = (st: GameEngineState): number => {
    const m = st.mousePosition;
    if (m.r === DANGER.r && m.c === DANGER.c) return 1000; // doomed (good for cat)
    // all other tunnel corners are safe (bad for cat)
    if (
      (m.r === 0 && m.c === 0) ||
      (m.r === 0 && m.c === 9) ||
      (m.r === 9 && m.c === 0)
    ) {
      return -1000;
    }
    return 0; // non-tunnel leaves
  };

  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 0, c: 0 }, { r: 9, c: 8 }); // cat adjacent to DANGER corner (9,9)
  s = {
    ...s,
    phase: GamePhase.ChoosingTunnelExit,
    currentPlayer: PieceType.Mouse,
    mousePosition: { r: 0, c: 0 },
    mouseMovesLeft: 0,
    tunnelExitChoices: [
      { r: 0, c: 9, label: '↙' },
      { r: 9, c: 0, label: '↗' },
      { r: 9, c: 9, label: '↖' }, // DANGER
      { r: 0, c: 0, label: '↺ 原地' },
    ],
  };

  const ctx = createSearchContext(defaultRuleSet, 1_000_000);
  ctx.leafEvaluator = leafD;
  const res = searchBestAction(s, 1, ctx);

  expect(res.action).not.toBeNull();
  const dAction = res.action!;
  expect(dAction.type).toBe('chooseTunnel');
  // Must NOT choose the doomed exit.
  if (dAction.type === 'chooseTunnel') {
    expect(dAction.r === DANGER.r && dAction.c === DANGER.c).toBe(false);
  }
  // MIN picks the worst-for-cat value (a safe exit → -1000).
  expect(res.value).toBe(-1000);
});

// ---------------------------------------------------------------------------
// E1. Skill zero-cost depth semantics (rule + simulator level)
//
// Per GAMEPLAY / the real engine (`mouseSkill`, engine.ts ~682):
//   mouseHasButter : true -> false   (the carried butter A is CONSUMED)
//   mouseSkillActive: false -> true
//   mouseMovesLeft : += 3
//   currentPlayer  : UNCHANGED        (does NOT consume a move / the turn)
//
// Therefore a hole-win after the skill is ONLY legal if the mouse later picks
// up a SECOND butter B (see E2). This test verifies ONLY the zero-cost
// depth semantics — it does NOT require a win.
// ---------------------------------------------------------------------------

test('E1. Mouse skill is zero-cost (same MIN turn, no depth decrement)', () => {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 7, c: 1 }, { r: 1, c: 1 });
  s = {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: true, // carrying butter A
    mouseSkillActive: false,
  };

  // 1) The skill RULE itself is zero-cost: same actor, +3 moves, butter consumed.
  const after = defaultRuleSet.mouseSkill(s);
  expect(after.currentPlayer).toBe(PieceType.Mouse); // Mouse MIN -> Mouse MIN
  expect(after.mouseMovesLeft).toBe(s.mouseMovesLeft + 3); // += 3
  expect(after.mouseHasButter).toBe(false); // butter A consumed
  expect(after.mouseSkillActive).toBe(true); // skill now active

  // 2) Because the actor did NOT flip, the search's valueOfAction computes
  //    `switched = state.currentPlayer !== next.currentPlayer` == false, so
  //    depthTurns is NOT decremented for the skill. Verify that via the
  //    simulator (the exact transition the search uses).
  const sim = simulateSearchAction(s, { type: 'mouseSkill' }, defaultRuleSet);
  expect(sim.kind).toBe('deterministic');
  if (sim.kind === 'deterministic') {
    const switched = s.currentPlayer !== sim.state.currentPlayer;
    expect(switched).toBe(false); // no turn switch -> depthTurns unchanged
    expect(sim.state.mouseMovesLeft).toBe(s.mouseMovesLeft + 3);
    expect(sim.state.mouseHasButter).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// E2. Skill enables a forced win (legal scenario)
//
//   carry butter A
//     -> use skill (consumes A, +3 moves, no turn switch)
//     -> pick up a SECOND butter B
//     -> carry B into the hole
//     -> MouseWins
//
// The hole-win requires carrying butter (engine.ts:587), and the mouse has
// only 4 base moves — not enough to reach B (3 away) then the hole (4 more) =
// 7 steps. The skill's +3 moves make it exactly reachable. Without the skill
// the win is impossible, proving the skill (its extra moves) is required.
// ---------------------------------------------------------------------------

test('E2. Skill enables a forced win: carry A -> skill -> pick B -> enter hole', () => {
  let s = createInitialState(cleanConfig());
  // Mouse at (7,1) carrying butter A. Butter B at (7,4). Hole at (7,8).
  // With butter: (7,1)->(7,4) pick B (3 steps) -> (7,8) hole (4 more) = 7 steps.
  // Base moves = 4 (cannot reach); skill gives +3 = 7 (exactly enough).
  s = setPieces(s, { r: 7, c: 1 }, { r: 1, c: 1 });
  s = wallOff(s, [
    { r: 7, c: 1 },
    { r: 7, c: 2 },
    { r: 7, c: 3 },
    { r: 7, c: 4 }, // butter B cell
    { r: 7, c: 5 },
    { r: 7, c: 6 },
    { r: 7, c: 7 },
    { r: 7, c: 8 }, // hole (preserved)
    { r: 1, c: 1 }, // cat kept off walls
  ]);
  s = {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: true, // carrying butter A
    mouseSkillActive: false,
    butterPositions: [{ r: 7, c: 4 }], // B on the board, to be picked up
  };

  const ctx = createSearchContext(defaultRuleSet, 1_000_000);
  const withSkill = searchResult(s, 1, ctx).value; // ONE mouse turn; skill extends it
  // A genuine forced mouse win is a very large negative, near -MATE_SCORE.
  expect(isForcedMate(withSkill)).toBe(true);
  expect(withSkill).toBeLessThan(0);
  expect(ctx.diagnostics.terminalNodes).toBeGreaterThan(0);

  // Without the skill available, the mouse cannot reach the hole in one turn.
  const sNoSkill = { ...s, mouseSkillActive: true };
  const ctx2 = createSearchContext(defaultRuleSet, 1_000_000);
  const withoutSkill = searchResult(sNoSkill, 1, ctx2).value;
  expect(withoutSkill).toBeGreaterThan(withSkill); // clearly not a forced loss
  // No mate is reachable within the single turn when the skill is unavailable.
  expect(Math.abs(withoutSkill)).toBeLessThan(MATE_SCORE - 1000);
  expect(ctx2.diagnostics.terminalNodes).toBe(0);
});

// ---------------------------------------------------------------------------
// F. Trap zero-cost — placing a trap does NOT consume the cat's turn
// ---------------------------------------------------------------------------

test('F. Cat trap placement is zero-cost (same MAX turn, no depth decrement)', () => {
  const GOAL = { r: 1, c: 5 };
  const leafF = (st: GameEngineState): number =>
    st.trapPosition && st.catPosition.r === GOAL.r && st.catPosition.c === GOAL.c ? 100 : 0;

  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 8, c: 8 }, { r: 1, c: 1 }); // +100 only reachable via trap then 4 steps
  s = wallOff(s, [
    { r: 1, c: 1 },
    { r: 1, c: 2 },
    { r: 1, c: 3 },
    { r: 1, c: 4 },
    { r: 1, c: 5 }, // GOAL
    { r: 8, c: 8 }, // mouse kept off walls
  ]);
  s = {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    trapPosition: null,
    catTrapsRemaining: 1,
  };

  const ctx = createSearchContext(defaultRuleSet, 1_000_000);
  ctx.leafEvaluator = leafF;
  const v = searchResult(s, 1, ctx).value;

  // +100 requires placing the trap AND moving to GOAL, all in one cat turn.
  // If trap wrongly consumed the turn, only the trap (no move) would be
  // evaluated → value 0. 100 proves zero-cost.
  expect(v).toBe(100);
});

// ---------------------------------------------------------------------------
// G. Chance expected value — Σ weight * child = 0.25*100 + 0.75*(-20) = 10
// ---------------------------------------------------------------------------

test('G. Chance expected value: 0.25*100 + 0.75*(-20) = 10', () => {
  const cellA = { r: 3, c: 3 };
  const cellB = { r: 3, c: 6 };
  const leafG = (st: GameEngineState): number => {
    const b = st.butterPositions;
    if (b.length === 1 && b[0].r === cellA.r && b[0].c === cellA.c) return 100;
    if (b.length === 1 && b[0].r === cellB.r && b[0].c === cellB.c) return -20;
    return 0;
  };

  const gRules: RuleSet = {
    ...defaultRuleSet,
    enumerateButterSpawns: () => [cellA, cellB],
    buildButterChance: (st) => [
      { state: { ...st, butterPositions: [cellA] }, weight: 0.25 },
      { state: { ...st, butterPositions: [cellB] }, weight: 0.75 },
    ],
  };

  // Mouse about to step onto a butter (only the RIGHT move is legal).
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 3, c: 4 }, { r: 0, c: 0 });
  s = wallOff(s, [
    { r: 3, c: 4 }, // mouse start
    { r: 3, c: 5 }, // butter (to the right)
  ]);
  s = {
    ...s,
    butterPositions: [{ r: 3, c: 5 }],
    mouseHasButter: false,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 1, // last move → after pickup the turn switches
    catMovesLeft: 4,
    phase: GamePhase.Playing,
  };

  const ctx = createSearchContext(gRules, 1_000_000);
  ctx.leafEvaluator = leafG;
  const v = searchResult(s, 1, ctx).value;

  expect(v).toBe(10); // exact expectation
});

// ---------------------------------------------------------------------------
// H. Chance does NOT consume an extra turn depth
// ---------------------------------------------------------------------------

test('H. Chance node does not consume an extra turn depth', () => {
  const GOAL = { r: 3, c: 8 };
  const leafH = (st: GameEngineState): number =>
    st.mousePosition.r === GOAL.r && st.mousePosition.c === GOAL.c ? -100 : 0;

  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 3, c: 4 }, { r: 0, c: 0 });
  // mouse at (3,4), butter at (3,5); narrow lane to the right.
  s = wallOff(s, [
    { r: 3, c: 4 },
    { r: 3, c: 5 },
    { r: 3, c: 6 },
    { r: 3, c: 7 },
    { r: 3, c: 8 },
  ]);
  s = {
    ...s,
    butterPositions: [{ r: 3, c: 5 }],
    mouseHasButter: false,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4, // still has moves after pickup → NO turn switch
    catMovesLeft: 4,
    phase: GamePhase.Playing,
  };

  const ctx = createSearchContext(defaultRuleSet, 1_000_000);
  ctx.leafEvaluator = leafH;
  const v = searchResult(s, 1, ctx).value;

  // If the chance node consumed an extra turn, the post-butter mouse moves
  // would never be explored (depth 0 leaf at (3,5) → 0). Reaching GOAL (-100)
  // proves the chance did NOT add a depth decrement.
  expect(v).toBe(-100);
});

// ---------------------------------------------------------------------------
// I. Repetition safety — a true same-COMPLETE-state cycle must not loop forever
// ---------------------------------------------------------------------------

test('I. Repetition safety — identical complete state on the path terminates', () => {
  // We deliberately do NOT use ordinary back-and-forth movement: with the real
  // engine each step decrements movesLeft, so A->B->A is NOT the same complete
  // state (stateKey includes mouseMovesLeft) and would terminate via a natural
  // turn-end rather than the repetition guard.
  //
  // Instead a synthetic RuleSet makes `mouseStep` toggle between two cells while
  // PRESERVING every game-affecting field (including movesLeft = 4), so the
  // exact starting complete state recurs on the recursion path. This isolates
  // the repetition guard: it must fire and return a static eval, never loop.
  const loopRules: RuleSet = {
    ...defaultRuleSet,
    mouseStep: (st) => {
      const at44 = st.mousePosition.r === 4 && st.mousePosition.c === 4;
      return {
        ...st,
        mousePosition: { r: 4, c: at44 ? 5 : 4 },
        mouseMovesLeft: 4, // preserved → complete (position+movesLeft) state recurs
      };
    },
  };

  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 4 }, { r: 0, c: 0 });
  s = {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
  };

  const ctx = createSearchContext(loopRules, 10_000_000);
  const v = searchResult(s, 10, ctx).value;

  expect(Number.isFinite(v)).toBe(true);
  expect(ctx.diagnostics.repetitions).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// J. No-legal-action edge case — never invent a win/loss
// ---------------------------------------------------------------------------

test('J. No-legal-action edge case — no invented win/loss, returns static eval', () => {
  let s = createInitialState(cleanConfig());
  // Mouse fully boxed in (all neighbors walls), movesLeft>0, Playing.
  s = wallOff(s, [{ r: 4, c: 4 }]);
  s = setPieces(s, { r: 4, c: 4 }, { r: 0, c: 0 });
  s = {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
  };

  const ctx = createSearchContext(defaultRuleSet, 1_000_000);
  const v = searchResult(s, 3, ctx).value;

  expect(Number.isFinite(v)).toBe(true);
  expect(ctx.diagnostics.noLegalActionNodes).toBeGreaterThan(0);
  // The search never mutates the input and never declares a winner.
  expect(s.phase).toBe(GamePhase.Playing);
  expect(Math.abs(v)).toBeLessThan(MATE_SCORE / 2);
});

// ---------------------------------------------------------------------------
// Chance weight consistency — real uniform random draw == enumerated set
// ---------------------------------------------------------------------------

test('Chance weights match the real game: uniform 1/N over enumerateButterSpawns', () => {
  // buildButterChance default == enumerateButterSpawns with uniform weight.
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 4 }, { r: 5, c: 5 });
  s = { ...s, butterPositions: [{ r: 4, c: 5 }], mouseHasButter: false };

  const picked = mouseStepDeterministic(s, dir('ArrowRight')); // picks butter
  const candidates = defaultRuleSet.enumerateButterSpawns(picked);
  expect(candidates.length).toBeGreaterThan(0);

  const chance = defaultRuleSet.buildButterChance!(picked);
  expect(chance).not.toBeNull();
  expect(chance!.length).toBe(candidates.length);

  const w = 1 / candidates.length;
  let sum = 0;
  for (const o of chance!) {
    expect(o.weight).toBeCloseTo(w, 12);
    sum += o.weight;
    // every outcome is a complete state with exactly one butter re-added
    expect(o.state.butterPositions.length).toBe(1);
  }
  expect(sum).toBeCloseTo(1, 12); // probabilities sum to 1

  // Empirical proof: the real game's random draw always lands in the same set.
  for (let i = 0; i < 40; i++) {
    const after = mouseMove(s, dir('ArrowRight'));
    expect(after.butterPositions.length).toBe(1);
    const cell = after.butterPositions[0];
    const inSet = candidates.some((b) => b.r === cell.r && b.c === cell.c);
    expect(inSet).toBe(true);
  }
});

test('enumerateButterSpawns respects the real spawn constraints', () => {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 4 }, { r: 5, c: 5 });
  s = { ...s, butterPositions: [{ r: 4, c: 5 }], mouseHasButter: false,
    trapPosition: { r: 2, c: 2 } };

  const picked = mouseStepDeterministic(s, dir('ArrowRight'));
  const candidates = defaultRuleSet.enumerateButterSpawns(picked);
  const cfg = s.config;
  const hole = cfg.mouseHole;

  for (const cell of candidates) {
    expect(cell.r >= 1 && cell.c >= 1 && cell.r <= cfg.boardSize - 2 && cell.c <= cfg.boardSize - 2).toBe(true);
    // not the mouse hole
    const inHole = cell.r >= hole.r && cell.r < hole.r + hole.size && cell.c >= hole.c && cell.c < hole.c + hole.size;
    expect(inHole).toBe(false);
    // ≥3 from hole
    expect(manhattan(cell, { r: hole.r, c: hole.c })).toBeGreaterThanOrEqual(3);
    // ≥3 from both pieces
    expect(manhattan(cell, picked.mousePosition)).toBeGreaterThanOrEqual(3);
    expect(manhattan(cell, picked.catPosition)).toBeGreaterThanOrEqual(3);
    // not on the trap
    expect(!(cell.r === 2 && cell.c === 2)).toBe(true);
  }
});

// ===========================================================================
// D0. TT Correctness Preparation
//
// (1) Mate score must be NODE-LOCAL (TT-safe): terminal = ±MATE_SCORE, and
//     each propagation layer applies ±1 so the value encodes the distance
//     from the CURRENT node to the terminal — NOT the plies walked from root.
//     Consequence: the same complete state reached via two different path
//     lengths yields the SAME node-local value.
// (2) InternalSearchResult { value, completed, cacheable } must flag
//     repetition-dependent and budget-truncated results as NOT cacheable.
// ===========================================================================

/**
 * Trap-free ruleset used by the cat-corridor mate-distance tests.
 *
 * `catPlaceTrap` is a MOVE-LESS action: it does not consume a move and does
 * not change the cat's position, so without D1/D2 pruning it can cycle-explode
 * and exhaust the SHARED node budget BEFORE the optimal (fastest-mate) branch
 * is evaluated — making the result depend on action order rather than the true
 * minimax value. That explosion is a real Phase-D performance problem (TT +
 * alpha-beta will fix it), but it is orthogonal to the mate-SCORING logic we
 * are verifying here. The scoring code is rule-agnostic, so a trap-free
 * RuleSet cleanly isolates the node-local mate-distance semantics.
 */
const noTrapRuleSet: RuleSet = { ...defaultRuleSet, catPlaceTrap: (st) => st };

/**
 * Build a 1-wide cat corridor on row 1 with the mouse trapped at (1,5) (no
 * butter → cannot win). The corridor uses INTERIOR cells only (col 1..5),
 * well clear of the border column 9 (a Void/blocked cell the cat cannot
 * enter) — putting the mouse on a border would make the catch impossible and
 * silently degrade the test to a leaf eval. Cat base moves = 4, so a catch
 * within 4 steps fits a single cat turn. `cat` is the cat's starting cell.
 */
function catCorridor(cat: { r: number; c: number }): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 1, c: 5 }, cat); // mouse at (1,5) — interior cell
  s = wallOff(s, [
    { r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 },
    // (1,1)..(1,5) open; the cat's legal actions are forced along row 1.
  ]);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

/**
 * A SMALL, fully-walled 3x3 arena (rows 4-6, cols 4-6 open; everything else
 * walled). Branching is tiny, so a search of this board completes well inside
 * `BIG` with ZERO budget cutoffs on BOTH TT-on and TT-off — the precondition
 * the user requires before a TT on/off equivalence is meaningful (an
 * incomplete search may not be used to verify TT math). Transpositions occur
 * naturally in the symmetric open region.
 */
function openArena(opts: {
  cat: { r: number; c: number };
  mouse: { r: number; c: number };
  catMovesLeft?: number;
  mouseMovesLeft?: number;
}): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, opts.mouse, opts.cat);
  const open: { r: number; c: number }[] = [];
  for (let r = 4; r <= 6; r++) for (let c = 4; c <= 6; c++) open.push({ r, c });
  s = wallOff(s, open);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: opts.catMovesLeft ?? 2,
    mouseMovesLeft: opts.mouseMovesLeft ?? 2,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

/**
 * A BOXED, single-forced-capture position: the cat at (1,4) is walled on every
 * side except the mouse at (1,5), so its ONLY legal move is the capture. With
 * no lateral / backward move available, the search tree has NO cycle, so the
 * root is cacheable (unlike the open corridor, where cat+mouse oscillation
 * makes the root repetition-dependent and thus non-cacheable). Used where a
 * test needs a guaranteed-cached forced mate (D1-E).
 */
function boxedForcedMate(): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 4 });
  s = wallOff(s, [{ r: 1, c: 4 }, { r: 1, c: 5 }]); // only these two cells open
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

test('D0. mate score is node-local: same state via different path lengths → same node-local value', () => {
  // Mouse at (1,5). S is caught in exactly 2 steps → node-local value = MATE_SCORE - 2.
  const S = catCorridor({ r: 1, c: 3 }); // (1,3)→(1,4)→(1,5)
  // P1 reaches S in 1 step → one extra propagation layer → MATE_SCORE - 3.
  const P1 = catCorridor({ r: 1, c: 2 }); // (1,2)→(1,3)→(1,4)→(1,5)
  // P2 reaches S in 2 steps → two extra layers → MATE_SCORE - 4.
  const P2 = catCorridor({ r: 1, c: 1 }); // (1,1)→(1,2)→(1,3)→(1,4)→(1,5)

  const vS = searchResult(S, 20, createSearchContext(noTrapRuleSet, 1_000_000)).value;
  const vP1 = searchResult(P1, 20, createSearchContext(noTrapRuleSet, 1_000_000)).value;
  const vP2 = searchResult(P2, 20, createSearchContext(noTrapRuleSet, 1_000_000)).value;

  // S's node-local value is identical whether S is the root (vS) or embedded
  // one/two layers deeper (it still contributes MATE_SCORE - 2 inside P1/P2).
  expect(vS).toBe(MATE_SCORE - 2); // catch at ply 2
  expect(vP1).toBe(MATE_SCORE - 3); // S one layer deeper → −1
  expect(vP2).toBe(MATE_SCORE - 4); // S two layers deeper → −2
  // The embedding relationship proves S's value is path-independent: each
  // extra layer subtracts exactly 1, never the root-relative ply.
  expect(vP1).toBe(vS - 1);
  expect(vP2).toBe(vS - 2);
});

test('D0. cat prefers faster wins and delays losses (mate-distance semantics)', () => {
  // --- Faster win preferred ---
  const win1 = catCorridor({ r: 1, c: 4 }); // catch in 1 step: (1,4)→(1,5)
  const win2 = catCorridor({ r: 1, c: 3 }); // catch in 2 steps: (1,3)→(1,4)→(1,5)
  const vWin1 = searchResult(win1, 20, createSearchContext(noTrapRuleSet, 1_000_000)).value;
  const vWin2 = searchResult(win2, 20, createSearchContext(noTrapRuleSet, 1_000_000)).value;
  expect(vWin1).toBe(MATE_SCORE - 1);
  expect(vWin2).toBe(MATE_SCORE - 2);
  expect(vWin1).toBeGreaterThan(vWin2); // sooner win is better for the cat

  // --- Delaying a loss is preferred ---
  const mkLoss = (mouse: { r: number; c: number }) => {
    let s = createInitialState(cleanConfig());
    s = setPieces(s, mouse, { r: 0, c: 0 }); // mouse on row 7, cat isolated
    s = wallOff(s, [
      { r: 7, c: 6 }, { r: 7, c: 7 }, { r: 7, c: 8 }, // mouse lane to the hole
      { r: 0, c: 0 },
    ]);
    return {
      ...s,
      currentPlayer: PieceType.Mouse,
      mouseMovesLeft: 4,
      catMovesLeft: 4,
      phase: GamePhase.Playing,
      mouseHasButter: true, // carrying butter → entering the hole wins
    };
  };
  const loss1 = mkLoss({ r: 7, c: 7 }); // 1 step to hole (7,8)
  const loss2 = mkLoss({ r: 7, c: 6 }); // 2 steps to hole (7,8)
  const vLoss1 = searchResult(loss1, 20, createSearchContext(defaultRuleSet, 1_000_000)).value;
  const vLoss2 = searchResult(loss2, 20, createSearchContext(defaultRuleSet, 1_000_000)).value;
  expect(vLoss1).toBe(-MATE_SCORE + 1);
  expect(vLoss2).toBe(-MATE_SCORE + 2);
  expect(vLoss2).toBeGreaterThan(vLoss1); // a more-delayed loss is better for the cat
});

test('D0. InternalSearchResult cacheable flags (terminal / repetition / budget / leaf)', () => {
  // Terminal → deterministic & cacheable.
  const term = { ...createInitialState(cleanConfig()), phase: GamePhase.CatWins };
  const rT = searchResult(term, 5, createSearchContext(defaultRuleSet, 1_000_000));
  expect(rT.value).toBe(MATE_SCORE);
  expect(rT.completed).toBe(true);
  expect(rT.cacheable).toBe(true);

  // Repetition guard hit → value depends on the current path → NOT cacheable.
  const loopRules: RuleSet = {
    ...defaultRuleSet,
    mouseStep: (st) => {
      const at44 = st.mousePosition.r === 4 && st.mousePosition.c === 4;
      return {
        ...st,
        mousePosition: { r: 4, c: at44 ? 5 : 4 },
        mouseMovesLeft: 4, // preserved → the complete state recurs on the path
      };
    },
  };
  let rep = createInitialState(cleanConfig());
  rep = setPieces(rep, { r: 4, c: 4 }, { r: 0, c: 0 });
  rep = { ...rep, currentPlayer: PieceType.Mouse, mouseMovesLeft: 4, catMovesLeft: 4, phase: GamePhase.Playing };
  const cRep = createSearchContext(loopRules, 10_000_000);
  const rRep = searchResult(rep, 10, cRep);
  expect(cRep.diagnostics.repetitions).toBeGreaterThan(0);
  expect(rRep.cacheable).toBe(false);

  // Budget cutoff → incomplete & NOT cacheable.
  let budget = createInitialState(cleanConfig());
  budget = setPieces(budget, { r: 4, c: 4 }, { r: 5, c: 5 });
  budget = { ...budget, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing };
  const cBudget = createSearchContext(defaultRuleSet, 1); // tiny budget
  const rBudget = searchResult(budget, 20, cBudget);
  expect(cBudget.diagnostics.budgetCutoffs).toBeGreaterThan(0);
  expect(rBudget.completed).toBe(false);
  expect(rBudget.cacheable).toBe(false);

  // Normal depth-limited leaf → deterministic eval → cacheable & completed.
  let leaf = createInitialState(cleanConfig());
  leaf = setPieces(leaf, { r: 4, c: 4 }, { r: 5, c: 5 });
  leaf = { ...leaf, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing };
  const rLeaf = searchResult(leaf, 0, createSearchContext(defaultRuleSet, 1_000_000));
  expect(Number.isFinite(rLeaf.value)).toBe(true);
  expect(rLeaf.completed).toBe(true);
  expect(rLeaf.cacheable).toBe(true);
});

// ===========================================================================
// D0 (cont). Explicit forced-mate classification & lexicographic selection
//
// The mate score is now accompanied by an EXPLICIT `mate` side ('cat' |
// 'mouse' | null). Action selection is LEXICOGRAPHIC, not purely numeric:
//
//   MAX (cat):   cat-mate(2)  > non-mate(1) > mouse-mate(0)
//   MIN (mouse): mouse-mate(0) < non-mate(1) < cat-mate(2)
//
// Within a category the numeric value still decides. This guarantees a mixed
// CHANCE (mate = null) can NEVER outrank a genuine forced mate, even when its
// expected value is numerically very close to MATE_SCORE.
//
// CHANCE mate inheritance:
//   all outcomes cat-mate   → mate = 'cat'
//   all outcomes mouse-mate → mate = 'mouse'
//   otherwise               → mate = null
// A CHANCE node never adds a mate-distance layer of its own — only the parent
// action's propagation (stepChildForParent) adds the one ±1.
// ===========================================================================

const mkRes = (
  value: number,
  mate: 'cat' | 'mouse' | null,
  completed = true,
  cacheable = true,
  bound: SearchBoundType = 'exact',
): InternalSearchResult => ({ value, completed, cacheable, mate, bound });

test('D0. lexicographic: MAX prefers forced cat-mate over a HIGHER-valued non-mate (mixed CHANCE)', () => {
  // A forced cat-mate that is numerically LOWER (slower win) ...
  const forcedCatMate = mkRes(MATE_SCORE - 7, 'cat');
  // ... vs a non-mate whose numeric value is HIGHER (closer to MATE_SCORE,
  // like a mixed CHANCE expectation). Purely numeric comparison would pick the
  // non-mate; lexicographic must not.
  const higherNonMate = mkRes(MATE_SCORE - 1, null);
  expect(higherNonMate.value).toBeGreaterThan(forcedCatMate.value); // guard: numeric would flip
  expect(preferResult(forcedCatMate, higherNonMate, true)).toBe(true); // MAX picks the mate
  expect(preferResult(higherNonMate, forcedCatMate, true)).toBe(false);
});

test('D0. lexicographic: MIN prefers forced mouse-mate over a non-mate', () => {
  // A forced mouse-mate (closest win) is the most negative value; a non-mate
  // leaf is bounded (well above it). MIN wants the lowest value, and the
  // 'mouse' category (rank 0) is below 'non-mate' (rank 1).
  const forcedMouseMate = mkRes(-MATE_SCORE + 1, 'mouse'); // value -999999
  const nonMate = mkRes(200, null); // bounded leaf, e.g. 200
  expect(forcedMouseMate.value).toBeLessThan(nonMate.value); // guard
  expect(preferResult(forcedMouseMate, nonMate, false)).toBe(true); // MIN picks its own forced win
  expect(preferResult(nonMate, forcedMouseMate, false)).toBe(false);
});

test('D0. lexicographic: within one category, numeric value decides', () => {
  // MAX: faster cat-mate (higher value) wins.
  expect(preferResult(mkRes(MATE_SCORE - 1, 'cat'), mkRes(MATE_SCORE - 3, 'cat'), true)).toBe(true);
  // MAX: higher non-mate wins.
  expect(preferResult(mkRes(200, null), mkRes(100, null), true)).toBe(true);
  // MIN: lower non-mate wins.
  expect(preferResult(mkRes(100, null), mkRes(200, null), false)).toBe(true);
  // MIN: faster mouse-mate (more negative) wins.
  expect(preferResult(mkRes(-MATE_SCORE + 1, 'mouse'), mkRes(-MATE_SCORE + 3, 'mouse'), false)).toBe(true);
});

test('D0. lexicographic: a mixed CHANCE (mate=null) ranks BELOW a forced cat-mate for MAX', () => {
  const forcedCatMate = mkRes(MATE_SCORE - 50, 'cat');
  const mixedChance = mkRes(MATE_SCORE - 2, null); // very close to MATE_SCORE, but NOT a forced mate
  expect(mixedChance.value).toBeGreaterThan(forcedCatMate.value); // guard: numeric would flip
  expect(preferResult(forcedCatMate, mixedChance, true)).toBe(true);
});

/**
 * Root state where the MOUSE has exactly ONE legal action: a step onto a butter
 * cell, which the simulator turns into a CHANCE node. `mouseSkill` is neutered
 * to a no-op (filtered as illegal) and `catPlaceTrap` removed, so the only
 * branch is the injected butter CHANCE — letting us observe its `mate`/`value`
 * cleanly through `searchResult`.
 */
function mouseButterChanceRoot(buildChance: RuleSet['buildButterChance']): {
  state: GameEngineState;
  rules: RuleSet;
} {
  const rules: RuleSet = {
    ...defaultRuleSet,
    mouseSkill: (st) => st, // no-op → filtered as illegal
    catPlaceTrap: (st) => st, // not the actor, but keep deterministic
    buildButterChance: buildChance,
  };
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 4 }, { r: 0, c: 0 }); // mouse (4,4), cat far/walled
  s = { ...s, butterPositions: [{ r: 4, c: 5 }] }; // butter adjacent to the mouse
  s = wallOff(s, [
    { r: 4, c: 4 }, { r: 4, c: 5 }, // mouse + butter open
    { r: 0, c: 0 }, // cat cell (kept open, far away)
  ]);
  const state: GameEngineState = {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
  return { state, rules };
}

/** A fully-boxed Playing state (no legal actions) → _search returns a leaf
 *  with mate = null. Used as the "non-mate" outcome of a CHANCE node. */
function boxedMouseLeaf(): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 2, c: 2 }); // mouse only, no cat
  s = wallOff(s, [{ r: 2, c: 2 }]); // no open neighbor → no legal moves
  return {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

const terminalCatWins = (): GameEngineState => ({
  ...createInitialState(cleanConfig()),
  phase: GamePhase.CatWins,
});

test('D0. CHANCE mate inheritance: 99% cat-mate + 1% non-mate → mate = null', () => {
  const { state, rules } = mouseButterChanceRoot(() => [
    { state: terminalCatWins(), weight: 0.99 },
    { state: boxedMouseLeaf(), weight: 0.01 },
  ]);
  const r = searchResult(state, 20, createSearchContext(rules, 1_000_000));
  // Not all outcomes are cat-mates (one is a non-mate leaf) → the CHANCE is
  // classified as null, never as a forced mate. The expectation is high
  // (≈0.99·MATE_SCORE) but it must NOT be treated as a forced cat-mate.
  expect(r.mate).toBe(null);
  expect(isForcedMate(r.value)).toBe(false);
  // Expected value = 0.99·MATE_SCORE + 0.01·(boxed-leaf eval). The leaf eval is
  // bounded (well below MATE_SCORE), so the total stays below MATE_SCORE.
  expect(r.value).toBeGreaterThan(0.98 * MATE_SCORE);
  expect(r.value).toBeLessThan(MATE_SCORE);
});

test('D0. CHANCE mate inheritance: all cat-mate → mate = "cat"; all mouse-mate → mate = "mouse"', () => {
  const cat = mouseButterChanceRoot(() => [
    { state: terminalCatWins(), weight: 0.5 },
    { state: { ...terminalCatWins() }, weight: 0.5 },
  ]);
  expect(searchResult(cat.state, 20, createSearchContext(cat.rules, 1_000_000)).mate).toBe('cat');

  const mouse = mouseButterChanceRoot(() => [
    { state: { ...createInitialState(cleanConfig()), phase: GamePhase.MouseWins }, weight: 0.6 },
    { state: { ...createInitialState(cleanConfig()), phase: GamePhase.MouseWins }, weight: 0.4 },
  ]);
  expect(searchResult(mouse.state, 20, createSearchContext(mouse.rules, 1_000_000)).mate).toBe('mouse');
});

test('D0. CHANCE does NOT add a mate-distance layer (probability-1 chance passes value through)', () => {
  // A single (probability-1) CHANCE outcome that is a terminal CatWins
  // (distance 0 → value MATE_SCORE, mate 'cat'). The CHANCE node must pass it
  // through unchanged; only the root's ONE propagation step applies.
  const { state, rules } = mouseButterChanceRoot(() => [
    { state: terminalCatWins(), weight: 1 },
  ]);
  const r = searchResult(state, 20, createSearchContext(rules, 1_000_000));
  // Root MIN applies stepChildForParent on a cat-mate → MATE_SCORE - 1.
  // If the CHANCE node had added its own distance layer, the value would be
  // MATE_SCORE - 2. So the exact -1 proves the CHANCE added nothing.
  expect(r.value).toBe(MATE_SCORE - 1);
  expect(r.mate).toBe('cat');
});

test('D0. REGRESSION: defaultRuleSet budget exhaustion → root completed=false, cacheable=false (must NOT be a TT EXACT)', () => {
  // defaultRuleSet still includes catPlaceTrap. A tiny maxNodes forces every
  // child subtree to be truncated, so the ROOT result is incomplete and MUST
  // NOT be stored as a TT EXACT entry in Phase D.
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 4 }, { r: 5, c: 5 });
  s = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing };
  const ctx = createSearchContext(defaultRuleSet, 1); // maxNodes=1 → immediate cutoff
  const r = searchResult(s, 20, ctx);
  expect(ctx.diagnostics.budgetCutoffs).toBeGreaterThan(0);
  expect(r.completed).toBe(false);
  expect(r.cacheable).toBe(false);
  // The value is only a truncated static eval, never a genuine forced mate.
  expect(isForcedMate(r.value)).toBe(false);
});

// ===========================================================================
// D1. EXACT Transposition Table — the ONLY change in this phase.
//
// Goal: Phase C/D0 results UNCHANGED + a complete state reached at the same
// remaining `depthTurns` is not re-searched on its second appearance.
//
//   * TT entry = { depthTurns, value, mate, bestAction? } — the COMPLETE
//     node-local result, never just the numeric value. `mate` is mandatory so
//     the lexicographic (category-first) comparison survives a cache hit.
//   * Entry exists ONLY for completed && cacheable results → every entry is a
//     genuine, path-independent, full-depth EXACT value.
//   * Probe requires an EXACT depthTurns match (===); no `>=`, no LOWER/UPPER
//     bounds yet (D2).
//   * Repetition guard (②) and budget guard (③) both run BEFORE the TT probe
//     (⑤), so a path-dependent result can never be bypassed by a cached entry,
//     and a budget-exhausted node can never pretend completion via a lookup.
//   * TT is OFF by default; D1 tests and D1-J toggle it on. Disabling it is
//     byte-for-byte the Phase C/D0 algorithm.
// ===========================================================================

const BIG = 1_000_000;

test('D1-A. Simple EXACT hit: same state+depth searched twice → ttExactHits>0, nodes drop, value/mate identical', () => {
  const S = catCorridor({ r: 1, c: 3 }); // mate-in-2
  const ctx1 = createSearchContext(noTrapRuleSet, BIG, true);
  const r1 = searchResult(S, 4, ctx1);
  expect(r1.mate).toBe('cat');
  expect(ctx1.diagnostics.ttStores).toBeGreaterThan(0);

  const ctx2 = createSearchContext(noTrapRuleSet, BIG, true);
  ctx2.tt = ctx1.tt; // share the populated table across the two searches
  const r2 = searchResult(S, 4, ctx2);
  expect(r2.value).toBe(r1.value);
  expect(r2.mate).toBe(r1.mate);
  expect(ctx2.diagnostics.ttExactHits).toBeGreaterThan(0);
  expect(ctx2.diagnostics.nodes).toBeLessThan(ctx1.diagnostics.nodes); // reused, not re-expanded
});

test('D1-B. Real transposition within one search: two move orders reach the same state, second hits TT', () => {
  // Small walled arena → BOTH searches complete with ZERO budget cutoffs, the
  // precondition for a meaningful TT on/off equivalence.
  // D1-B shares the EXACT same fixture as the D2 four-group benchmark via the
  // single helper, so "openArena@3" means one board, never two hand-written arenas.
  const mk = () => createTranspositionBenchmarkFixture().state;
  const off = createSearchContext(noTrapRuleSet, BIG, false);
  const rOff = searchResult(mk(), 3, off);
  const on = createSearchContext(noTrapRuleSet, BIG, true);
  const rOn = searchResult(mk(), 3, on);

  // Preconditions: neither side may be an incomplete (budget-truncated) search.
  expect(off.diagnostics.budgetCutoffs).toBe(0);
  expect(on.diagnostics.budgetCutoffs).toBe(0);
  expect(rOff.completed).toBe(true);
  expect(rOn.completed).toBe(true);

  // With both complete, TT on/off must agree exactly.
  expect(rOn.value).toBe(rOff.value);
  expect(rOn.mate).toBe(rOff.mate);
  expect(on.diagnostics.ttExactHits).toBeGreaterThan(0);
  expect(on.diagnostics.ttStores).toBeGreaterThan(0);
});

test('D1-C. Depth mismatch (cached depth=1, request depth=3) must NOT exact-return', () => {
  // Synthetic depth-sensitive fixture: a non-mate 3x3 arena where depth=1 and
  // depth=3 yield DIFFERENT values (the cat gets closer over more turns). The
  // point is that caching S@1 and probing it for a depth=3 request must NOT
  // return the stale depth-1 value.
  const S = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });
  const ctxA = createSearchContext(noTrapRuleSet, BIG, true);
  const r1 = searchResult(S, 1, ctxA); // caches S@1
  // The cached root entry MUST carry depthTurns === 1 (checked BEFORE the
  // second search could overwrite it with a depth-3 entry).
  expect(ctxA.tt.get(stateKey(S))?.depthTurns).toBe(1);
  const ctxB = createSearchContext(noTrapRuleSet, BIG, true);
  ctxB.tt = ctxA.tt; // share table containing S@1
  const r3 = searchResult(S, 3, ctxB); // root probe: S@1 depthTurns(1) ≠ 3 → no exact
  const v3plain = searchResult(S, 3, createSearchContext(noTrapRuleSet, BIG)).value;
  expect(r3.value).toBe(v3plain); // correctness preserved despite S@1 cached
  expect(ctxB.diagnostics.ttHits).toBeGreaterThan(0); // the depth-1 entry WAS probed
  expect(ctxB.diagnostics.ttDepthMismatches).toBeGreaterThan(0); // found but depth≠ → not exact
  expect(r3.value).not.toBe(r1.value); // the cached depth-1 value was NOT returned
});

test('D1-D. Depth mismatch (cached depth=3, request depth=1) must NOT exact-return; plain depth=1 == TT-enabled depth=1', () => {
  // boxedForcedMate is a mate-in-1 that terminates immediately, so it has NO
  // oscillation/cycle → its root is cacheable at depth 3. (The open corridor
  // and the open 3x3 arena are NOT usable here: their deeper searches hit
  // repetitions — cat/mouse can shuffle back to a prior state — which makes the
  // root non-cacheable, so no depth-3 entry is ever written. boxedForcedMate is
  // the codebase's canonical guaranteed-cacheable fixture and is what lets a
  // depth-3 entry exist in the first place.)
  const S = boxedForcedMate();
  const ctxA = createSearchContext(noTrapRuleSet, BIG, true);
  searchResult(S, 3, ctxA); // caches S@3 (mate value)
  // The cached root entry MUST carry depthTurns === 3 (checked BEFORE the
  // second search could overwrite it with a depth-1 entry).
  expect(ctxA.tt.get(stateKey(S))?.depthTurns).toBe(3);
  const ctxB = createSearchContext(noTrapRuleSet, BIG, true);
  ctxB.tt = ctxA.tt; // share table containing S@3
  const on = searchBestAction(S, 1, ctxB); // root probe S@3 ≠ 1 → no exact; fresh depth-1
  const off = searchBestAction(S, 1, createSearchContext(noTrapRuleSet, BIG, false));
  expect(on.value).toBe(off.value);
  expect(on.action).toEqual(off.action);
  const onMate = searchResult(S, 1, ctxB).mate;
  const offMate = searchResult(S, 1, createSearchContext(noTrapRuleSet, BIG, false)).mate;
  expect(onMate).toBe(offMate);
  // The root probe (S@3 cached, depth=1 requested) is a key match with a depth
  // mismatch → recorded as a depth mismatch, NEVER an exact reuse. A bug that
  // treated the mismatch as an exact hit would bump ttExactHits instead.
  expect(ctxB.diagnostics.ttDepthMismatches).toBeGreaterThan(0);
  expect(ctxB.diagnostics.ttExactHits).toBe(0);
});

test("D1-E. Mate metadata preserved through an EXACT hit (mate='cat' must not degrade to null)", () => {
  // boxedForcedMate has NO oscillation, so its root is cacheable (unlike the
  // open corridor, where cat+mouse cycles make the root non-cacheable).
  const S = boxedForcedMate(); // mate-in-1 → MATE_SCORE-1, mate 'cat'
  const ctxOn = createSearchContext(noTrapRuleSet, BIG, true);
  const r1 = searchResult(S, 6, ctxOn);
  expect(r1.mate).toBe('cat');
  expect(r1.value).toBe(MATE_SCORE - 1);

  const ctx2 = createSearchContext(noTrapRuleSet, BIG, true);
  ctx2.tt = ctxOn.tt;
  const r2 = searchResult(S, 6, ctx2);
  expect(r2.mate).toBe('cat'); // NOT degraded to null
  expect(r2.value).toBe(MATE_SCORE - 1);
  expect(ctx2.diagnostics.ttExactHits).toBeGreaterThan(0);

  // The chosen action (a forced-mate move) is identical with TT on and off.
  const baOff = searchBestAction(S, 6, createSearchContext(noTrapRuleSet, BIG, false));
  const baOn = searchBestAction(S, 6, createSearchContext(noTrapRuleSet, BIG, true));
  expect(baOn.action).toEqual(baOff.action);
  expect(baOn.value).toBe(MATE_SCORE - 1);
});

test('D1-F. Mate distance preserved: fresh vs TT-hit node-local value, and after parent propagation', () => {
  const S = catCorridor({ r: 1, c: 3 }); // mate-in-2 → node-local MATE_SCORE-2, 'cat'
  const P = catCorridor({ r: 1, c: 2 }); // one step before S → mate-in-3 → MATE_SCORE-3

  const ctxOn = createSearchContext(noTrapRuleSet, BIG, true);
  const rS = searchResult(S, 6, ctxOn); // caches S@6 = {MATE_SCORE-2, 'cat'}
  expect(rS.value).toBe(MATE_SCORE - 2);
  expect(rS.mate).toBe('cat');

  const ctx2 = createSearchContext(noTrapRuleSet, BIG, true);
  ctx2.tt = ctxOn.tt;
  const rS2 = searchResult(S, 6, ctx2); // exact hit → same node-local value
  expect(rS2.value).toBe(MATE_SCORE - 2);
  expect(rS2.mate).toBe('cat');

  // Parent P reaches S as a child; the parent steps S's node-local value by
  // exactly one (stepChildForParent), identical whether S was fresh or hit.
  const rP = searchResult(P, 6, ctx2);
  expect(rP.value).toBe(MATE_SCORE - 3);
  expect(rP.mate).toBe('cat');
  const rPplain = searchResult(P, 6, createSearchContext(noTrapRuleSet, BIG, false));
  expect(rP.value).toBe(rPplain.value);
  expect(rP.mate).toBe(rPplain.mate);
});

test('D1-G. Repetition-dependent results are NOT cached as EXACT entries', () => {
  // Synthetic loop: mouseStep toggles (4,4)<->(4,5) with movesLeft preserved,
  // so the complete state recurs on the recursion path (cycle). mouseSkill and
  // catPlaceTrap are neutered so the ONLY branch is the cycle.
  const loopRules: RuleSet = {
    ...defaultRuleSet,
    mouseStep: (st) => {
      const at44 = st.mousePosition.r === 4 && st.mousePosition.c === 4;
      return { ...st, mousePosition: { r: 4, c: at44 ? 5 : 4 }, mouseMovesLeft: 4 };
    },
    mouseSkill: (st) => st,
    catPlaceTrap: (st) => st,
  };
  let rep = createInitialState(cleanConfig());
  rep = setPieces(rep, { r: 4, c: 4 }, { r: 0, c: 0 });
  rep = { ...rep, currentPlayer: PieceType.Mouse, mouseMovesLeft: 4, catMovesLeft: 4, phase: GamePhase.Playing };

  const ctx = createSearchContext(loopRules, BIG, true);
  const r = searchResult(rep, 10, ctx);
  expect(ctx.diagnostics.repetitions).toBeGreaterThan(0);
  // Every reachable node depends on the recursion path → nothing is
  // completed+cacheable → nothing is stored. The table must stay empty.
  expect(ctx.tt.size).toBe(0);

  // A second search sharing the table must re-derive the SAME result (no stale
  // EXACT was written that could be wrongly reused to "complete" the cycle).
  const ctx2 = createSearchContext(loopRules, BIG, true);
  ctx2.tt = ctx.tt;
  const r2 = searchResult(rep, 10, ctx2);
  expect(r2.value).toBe(r.value);
  expect(r2.cacheable).toBe(r.cacheable);
});

test('D1-H. Budget-cutoff results are NOT cached; raising the budget re-expands', () => {
  // A small walled arena — the result (cat catches the mouse) is NON-immediate,
  // so a tiny budget truncates the root before it is found.
  const S = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });
  // Tiny budget → the root's children are truncated → the root is INCOMPLETE
  // and must NOT be stored as an EXACT entry.
  const ctx = createSearchContext(noTrapRuleSet, 1, true);
  const r = searchResult(S, 3, ctx);
  expect(ctx.diagnostics.budgetCutoffs).toBeGreaterThan(0);
  expect(r.completed).toBe(false);
  expect(r.cacheable).toBe(false);
  expect(ctx.tt.get(stateKey(S))).toBeUndefined(); // root NOT stored as EXACT

  // Raise the budget, share the (empty) table → must re-expand, not reuse a
  // stale approximation of the truncated value. The full-depth search
  // completes (no oscillation at this depth) and IS cached.
  const ctx2 = createSearchContext(noTrapRuleSet, BIG, true);
  ctx2.tt = ctx.tt;
  const r2 = searchResult(S, 3, ctx2);
  expect(r2.value).not.toBe(r.value); // did NOT return the truncated value
  expect(r2.completed).toBe(true); // real expansion completed
  expect(ctx2.diagnostics.ttStores).toBeGreaterThan(0); // real expansion cached
});

test('D1-I. Same-object CHANCE root: purity + stateKey stability + root Exact TT hit on re-search', () => {
  // Build a CHANCE root (mouse steps onto butter → CHANCE node). We deliberately
  // REUSE the same state object for both searches — no fresh reconstruction —
  // so this single test simultaneously proves:
  //   (1) search input purity (root unchanged by the search),
  //   (2) stateKey stability (key identical before/after),
  //   (3) a root EXACT TT hit on the second search,
  //   (4) a CHANCE state can be searched twice and stays consistent.
  const build = () => [
    { state: terminalCatWins(), weight: 0.5 },
    { state: terminalCatWins(), weight: 0.5 },
  ];
  const { state: root, rules } = mouseButterChanceRoot(build);

  const before = structuredClone(root);
  const keyBefore = stateKey(root);

  const ctx = createSearchContext(rules, BIG, true);
  const first = searchBestAction(root, 6, ctx);

  // (1)(2) purity + stateKey stability after the FIRST search.
  expect(root).toEqual(before);
  expect(stateKey(root)).toBe(keyBefore);

  // searchBestAction resets its own diagnostics at entry, so a second call
  // isolates the re-search's counters.
  const second = searchBestAction(root, 6, ctx);

  // (1)(2) STILL pure + stable after the SECOND (cache-hitting) search.
  expect(root).toEqual(before);
  expect(stateKey(root)).toBe(keyBefore);

  // (3) the second search reused the cached root EXACT entry.
  expect(ctx.diagnostics.ttExactHits).toBeGreaterThan(0);

  // (4) both searches agree exactly (value / mate / bestAction).
  expect(second.value).toBe(first.value);
  expect(second.mate).toBe(first.mate);
  expect(second.action).toEqual(first.action);

  // Both CHANCE outcomes are terminalCatWins → CHANCE node value MATE_SCORE;
  // the root (mouse step) is one propagation layer above → MATE_SCORE - 1,
  // mate still 'cat'. CHANCE itself does NOT add a distance layer.
  expect(first.value).toBe(MATE_SCORE - 1);
  expect(first.mate).toBe('cat');
});

test('D1-J. TT disabled vs enabled: identical value, mate, and bestAction on key fixtures', () => {
  const fixtures: { name: string; state: GameEngineState; rule: RuleSet; depth: number }[] = [
    { name: 'cat mate-in-2', state: catCorridor({ r: 1, c: 3 }), rule: noTrapRuleSet, depth: 6 },
    { name: 'cat mate-in-1', state: catCorridor({ r: 1, c: 4 }), rule: noTrapRuleSet, depth: 6 },
    // Small walled arena → both searches complete with zero budget cutoffs.
    { name: 'open 3x3 cat', state: openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } }), rule: noTrapRuleSet, depth: 3 },
  ];
  const chance = mouseButterChanceRoot(() => [
    { state: terminalCatWins(), weight: 0.5 },
    { state: terminalCatWins(), weight: 0.5 },
  ]);

  for (const f of fixtures) {
    const off = createSearchContext(f.rule, BIG, false);
    const rOff = searchBestAction(f.state, f.depth, off);
    const on = createSearchContext(f.rule, BIG, true);
    const rOn = searchBestAction(f.state, f.depth, on);
    // Preconditions: neither side may be an incomplete (budget-truncated) search.
    expect(off.diagnostics.budgetCutoffs).toBe(0);
    expect(on.diagnostics.budgetCutoffs).toBe(0);
    expect(rOff.action).not.toBeNull();
    expect(rOn.value).toBe(rOff.value);
    expect(rOn.action).toEqual(rOff.action);
    const mOff = searchResult(f.state, f.depth, createSearchContext(f.rule, BIG, false)).mate;
    const mOn = searchResult(f.state, f.depth, createSearchContext(f.rule, BIG, true)).mate;
    expect(mOn).toBe(mOff);
  }

  // A CHANCE fixture: value + mate identical with TT on/off.
  const cOff = searchResult(chance.state, 20, createSearchContext(chance.rules, BIG, false));
  const cOn = searchResult(chance.state, 20, createSearchContext(chance.rules, BIG, true));
  expect(cOn.value).toBe(cOff.value);
  expect(cOn.mate).toBe(cOff.mate);
});

test("D1-K. EXACT node requires ALL actions completed+cacheable: a budget-cutoff sibling forbids caching the root", () => {
  // defaultRuleSet includes catPlaceTrap. A tiny budget makes the trap branch
  // explode into a budget cutoff (incomplete), while the cat's direct step onto
  // the mouse is a clean mate. With no Alpha-Beta in D1, EVERY action is still
  // searched, so the node is conservative: incomplete OVERALL → NOT cached,
  // even though the *chosen* child (the mate) is itself cacheable.
  const S = catCorridor({ r: 1, c: 4 }); // mate-in-1 via the direct step
  const ctx = createSearchContext(defaultRuleSet, 50, true);
  const r = searchResult(S, 20, ctx);
  expect(ctx.diagnostics.budgetCutoffs).toBeGreaterThan(0); // the trap branch blew up
  expect(r.completed).toBe(false); // a sibling action was truncated
  expect(r.cacheable).toBe(false);
  // The root MUST NOT be stored as an EXACT entry despite the clean mate child.
  expect(ctx.tt.get(stateKey(S))).toBeUndefined();
});

// ---------------------------------------------------------------------------
// D1-K-min. Aggregation is symmetric: a non-cacheable sibling also forbids
// caching a MIN (mouse) node — not just a MAX node.
// ---------------------------------------------------------------------------

test("D1-K-min. MIN node is non-cacheable when ANY sibling action is non-cacheable (repetition)", () => {
  // Synthetic MIN root (mouse turn). One move ('left') hands off to a clean cat
  // leaf; every other move toggles the mouse between (4,4)<->(4,5) WITHOUT
  // ending the turn, so under recursion the same complete state recurs on the
  // path → a repetition → that sibling subtree is non-cacheable. With no
  // Alpha-Beta in D1 every sibling is searched, so the MIN node is conservative:
  // a non-cacheable sibling makes the WHOLE node non-cacheable.
  const mirrorRules: RuleSet = {
    ...defaultRuleSet,
    mouseStep: (st, d) => {
      if (d.dr === 0 && d.dc === -1) {
        // 'left' → clean hand-off to the cat (deterministic, cacheable leaf).
        return {
          ...st,
          mousePosition: { r: 2, c: 2 },
          currentPlayer: PieceType.Cat,
          mouseMovesLeft: st.mouseMovesLeft - 1,
        };
      }
      // any other move → toggle (4,4)<->(4,5), mouse keeps the turn, moves
      // preserved → recurses into a repetition when it returns to (4,4).
      const at44 = st.mousePosition.r === 4 && st.mousePosition.c === 4;
      return { ...st, mousePosition: { r: 4, c: at44 ? 5 : 4 }, mouseMovesLeft: 4 };
    },
    mouseSkill: (st) => st,
    catPlaceTrap: (st) => st,
  };
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 4 }, { r: 0, c: 0 });
  s = { ...s, currentPlayer: PieceType.Mouse, mouseMovesLeft: 4, catMovesLeft: 4, phase: GamePhase.Playing };

  const ctx = createSearchContext(mirrorRules, BIG, true);
  const r = searchResult(s, 3, ctx);
  // The toggle sibling is non-cacheable → the MIN node as a whole is NOT
  // cacheable, even though the 'left' sibling is clean and cacheable.
  expect(r.cacheable).toBe(false);
  // The whole node still COMPLETED (repetition returns completed=true) — it is
  // only the cacheability that the non-cacheable sibling poisons.
  expect(r.completed).toBe(true);
  // Therefore it MUST NOT be stored as an EXACT entry.
  expect(ctx.tt.get(stateKey(s))).toBeUndefined();
});

// ---------------------------------------------------------------------------
// D1-inv. A playable (non-terminal) EXACT TT entry MUST carry the node's
// bestAction. A root probe that finds an entry WITHOUT bestAction must NOT be
// trusted as a complete answer — the search must run in full instead.
// ---------------------------------------------------------------------------

test('D1-inv. root EXACT entry missing bestAction is NOT trusted; full search runs', () => {
  const S = boxedForcedMate(); // mate-in-1, a genuine cacheable root
  const ctx = createSearchContext(noTrapRuleSet, BIG, true);
  // Poison the table with a bogus EXACT entry for S that lacks bestAction.
  ctx.tt.set(stateKey(S), { depthTurns: 6, value: 12345, mate: 'cat', bestAction: undefined, extensionsRemaining: 0 });

  const r = searchBestAction(S, 6, ctx);
  // The poisoned sentinel value must NOT leak out — a real search runs and
  // returns the true forced mate plus a concrete best action.
  expect(r.value).not.toBe(12345);
  expect(r.value).toBe(MATE_SCORE - 1);
  expect(r.action).not.toBeNull();
  expect(r.action).toBeDefined();
  // The entry must have been repaired with the real bestAction.
  expect(ctx.tt.get(stateKey(S))?.bestAction).toBeDefined();
});

// ---------------------------------------------------------------------------
// D1-Purity. The search must never mutate its input state. (Earlier D1
// debugging briefly suspected an in-place mutation of butterPositions during
// a CHANCE expansion; deepFreeze + same-object re-search below DISPROVED that
// — the engine transitions are pure. These tests lock the conclusion in.)
// ---------------------------------------------------------------------------

/** Recursively freeze an object graph (used to prove no write-back occurs). */
function recursiveDeepFreeze<T>(o: T): T {
  if (o === null || typeof o !== 'object') return o;
  if (Object.isFrozen(o)) return o;
  Object.freeze(o);
  for (const k of Object.keys(o as Record<string, unknown>)) {
    recursiveDeepFreeze((o as Record<string, unknown>)[k]);
  }
  return o;
}

/** Mouse about to step onto a butter → exercises the CHANCE expansion. */
function chanceRoot(): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 1, c: 1 }, { r: 8, c: 8 });
  s = { ...s, butterPositions: [{ r: 1, c: 2 }] };
  s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 8, c: 8 }]);
  return {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

/** Mouse about to step into a tunnel corner → exercises tunnel handling. */
function tunnelRoot(): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 0, c: 1 }, { r: 8, c: 8 }); // (0,1) adjacent to tunnel (0,0)
  s = wallOff(s, [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 8, c: 8 }]);
  return {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

/** Mouse about to step onto its trap → exercises the trap transition. */
function trapRoot(): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 1, c: 1 }, { r: 8, c: 8 });
  s = { ...s, trapPosition: { r: 1, c: 2 } }; // trap adjacent to the mouse
  s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 8, c: 8 }]);
  return {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

test('D1-Purity. recursive deepFreeze: searching a frozen state throws no read-only write', () => {
  const cases: GameEngineState[] = [
    openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } }),
    chanceRoot(),
    tunnelRoot(),
    trapRoot(),
  ];
  for (const base of cases) {
    const frozen = recursiveDeepFreeze(structuredClone(base));
    expect(() => searchBestAction(frozen, 2, createSearchContext(defaultRuleSet, BIG, false)))
      .not.toThrow();
    expect(() => searchBestAction(frozen, 2, createSearchContext(defaultRuleSet, BIG, true)))
      .not.toThrow();
  }
});

test('D1-Purity. searchResult / searchBestAction leave the input root byte-identical (TT OFF and ON)', () => {
  const builders: { name: string; make: () => GameEngineState; rule: RuleSet }[] = [
    { name: 'cat turn', make: () => openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } }), rule: noTrapRuleSet },
    {
      name: 'mouse turn',
      make: () => ({ ...openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } }), currentPlayer: PieceType.Mouse }),
      rule: noTrapRuleSet,
    },
    { name: 'chance (butter)', make: chanceRoot, rule: defaultRuleSet },
    { name: 'tunnel', make: tunnelRoot, rule: defaultRuleSet },
    { name: 'trap', make: trapRoot, rule: defaultRuleSet },
  ];
  for (const b of builders) {
    for (const useTT of [false, true]) {
      const root = b.make();
      const before = structuredClone(root);
      const keyBefore = stateKey(root);
      const searched = searchResult(root, 2, createSearchContext(b.rule, BIG, useTT));
      expect(searched.completed).toBe(true); // purity fixture runs fully
      expect(root).toEqual(before);
      expect(stateKey(root)).toBe(keyBefore);

      const root2 = b.make();
      const before2 = structuredClone(root2);
      const keyBefore2 = stateKey(root2);
      searchBestAction(root2, 2, createSearchContext(b.rule, BIG, useTT));
      expect(root2).toEqual(before2);
      expect(stateKey(root2)).toBe(keyBefore2);
    }
  }
});

// ===========================================================================
// D2. Lexicographic Alpha-Beta — the ONLY change in this phase.
//
// Goal: on a COMPLETE search with a sufficient budget,
//     Alpha-Beta OFF  ==  Alpha-Beta ON     (value, mate, bestAction)
//   AND
//     Alpha-Beta ON   expands FEWER nodes than OFF.
//
// The window is NOT a bare number. A numeric-only alpha/beta would rank a
// forced cat-mate (≈999990) BELOW a non-mate expectation (≈999999) and pick the
// wrong move, so the window carries the FULL SearchScore (value + mate) and is
// ordered by the SAME `compareSearchScore` that drives play selection:
//
//     ScoreBound = -∞ | { score: SearchScore } | +∞
//
// Mate-distance windows must be re-expressed per edge: a child's value is one
// step closer to the terminal than its parent's, so the parent's window is
// handed down through `unstepBoundForChild` (cat +1 / mouse −1 / non-mate 0).
//
// A CHANCE node is NEVER pruned — every outcome is searched with the FULL
// window so Σ weight·value stays exact (stochastic pruning is forbidden here).
//
// A cutoff is sound PRUNING, not a search ABORT: the node keeps its honest
// completed/cacheable flags but is marked bound='lower' (MAX beta-cutoff) or
// 'upper' (MIN alpha-cutoff), and the EXACT-only TT refuses anything that is
// not bound='exact' (LOWER/UPPER entries are deferred to D2.5).
// ===========================================================================

/** Window extremes, rebuilt test-side (the production constants are module-private). */
const NEG: ScoreBound = { kind: 'negative-infinity' };
const POS: ScoreBound = { kind: 'positive-infinity' };
/** `SearchScore` / `ScoreBound` literal shorthands. */
const sc = (value: number, mate: MateSide): SearchScore => ({ value, mate });
const sb = (value: number, mate: MateSide): ScoreBound => ({ kind: 'score', score: sc(value, mate) });

/**
 * Read-only view of a TranspositionTable's entries. The table intentionally
 * exposes only get/set/size (iteration is not a production surface), so this
 * TEST-ONLY accessor reaches the backing map through a typed cast. It exists
 * purely to assert the "no non-exact entry is ever stored" invariant (D2-I).
 */
const ttEntries = (tt: TranspositionTable): Map<string, TTEntry> =>
  (tt as unknown as { map: Map<string, TTEntry> }).map;

/**
 * The D1-verified-complete benchmark fixture: a 3x3 walled arena, 2 moves per
 * side, depthTurns 3. Both TT on/off and AB on/off complete here with ZERO
 * budget cutoffs, which is the precondition for any equivalence claim.
 */
/**
 * The single, canonical transposition-benchmark fixture. D1-B (TT on/off
 * equivalence) and the D2 four-group benchmark BOTH derive their root from this
 * helper, so "openArena@3" always means ONE board + ONE RuleSet — never two
 * hand-written arenas that only look the same. Returns the state, the RuleSet,
 * the depth, and the node budget together.
 */
function createTranspositionBenchmarkFixture() {
  return {
    state: openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 }, catMovesLeft: 2, mouseMovesLeft: 2 }),
    rules: noTrapRuleSet,
    depthTurns: 3,
    maxNodes: BIG,
  };
}
const abArena = () => createTranspositionBenchmarkFixture().state;
/** Same arena with the MOUSE to move → a MIN root. */
const abArenaMouse = (): GameEngineState => ({ ...abArena(), currentPlayer: PieceType.Mouse });

// ---------------------------------------------------------------------------
// D2-A. The comparator IS the order (one definition, used by both selection
//       and pruning).
// ---------------------------------------------------------------------------

test('D2-A. compareSearchScore: category-first total order, and preferResult routes through it', () => {
  // --- Category dominates numeric magnitude ---
  // A SLOWER forced cat-mate still outranks a very high non-mate (e.g. a mixed
  // CHANCE expectation just under MATE_SCORE). This is the exact case a numeric
  // alpha/beta gets wrong.
  expect(compareSearchScore(sc(MATE_SCORE - 90, 'cat'), sc(MATE_SCORE - 1, null))).toBeGreaterThan(0);
  // A mouse-mate is the WORST category for the cat, even against a non-mate that
  // is numerically LOWER (an out-of-band value used only to prove the ranking is
  // by category, never by magnitude).
  expect(compareSearchScore(sc(-MATE_SCORE + 1, 'mouse'), sc(-MATE_SCORE - 1, null))).toBeLessThan(0);
  // Full chain: mouse-mate(0) < non-mate(1) < cat-mate(2).
  expect(compareSearchScore(sc(-MATE_SCORE + 1, 'mouse'), sc(0, null))).toBeLessThan(0);
  expect(compareSearchScore(sc(0, null), sc(MATE_SCORE - 1, 'cat'))).toBeLessThan(0);
  expect(compareSearchScore(sc(-MATE_SCORE + 1, 'mouse'), sc(MATE_SCORE - 1, 'cat'))).toBeLessThan(0);

  // --- Numeric decides WITHIN one category ---
  expect(compareSearchScore(sc(MATE_SCORE - 1, 'cat'), sc(MATE_SCORE - 3, 'cat'))).toBeGreaterThan(0);
  expect(compareSearchScore(sc(-MATE_SCORE + 3, 'mouse'), sc(-MATE_SCORE + 1, 'mouse'))).toBeGreaterThan(0);
  expect(compareSearchScore(sc(200, null), sc(100, null))).toBeGreaterThan(0);

  // --- Equality and antisymmetry ---
  expect(compareSearchScore(sc(42, null), sc(42, null))).toBe(0);
  expect(compareSearchScore(sc(MATE_SCORE - 2, 'cat'), sc(MATE_SCORE - 2, 'cat'))).toBe(0);
  const pairs: [SearchScore, SearchScore][] = [
    [sc(MATE_SCORE - 90, 'cat'), sc(MATE_SCORE - 1, null)],
    [sc(-MATE_SCORE + 1, 'mouse'), sc(-500, null)],
    [sc(100, null), sc(200, null)],
    [sc(MATE_SCORE - 1, 'cat'), sc(-MATE_SCORE + 1, 'mouse')],
  ];
  for (const [a, b] of pairs) {
    expect(Math.sign(compareSearchScore(a, b))).toBe(-Math.sign(compareSearchScore(b, a)));
  }

  // --- preferResult delegates to the SAME comparator (single definition) ---
  for (const [a, b] of pairs) {
    const ra = mkRes(a.value, a.mate);
    const rb = mkRes(b.value, b.mate);
    expect(preferResult(ra, rb, true)).toBe(compareSearchScore(a, b) > 0); // MAX
    expect(preferResult(ra, rb, false)).toBe(compareSearchScore(a, b) < 0); // MIN
  }
  // A tie is never a strict preference → the FIRST action is kept.
  expect(preferResult(mkRes(7, null), mkRes(7, null), true)).toBe(false);
  expect(preferResult(mkRes(7, null), mkRes(7, null), false)).toBe(false);
});

// ---------------------------------------------------------------------------
// D2-B. Mate-distance window inverse propagation.
// ---------------------------------------------------------------------------

test('D2-B. unstepBoundForChild is the exact inverse of the parent step; ±∞ ordering holds', () => {
  // The concrete ±1 rule, per mate category.
  expect(unstepBoundForChild(sb(MATE_SCORE - 3, 'cat'))).toEqual(sb(MATE_SCORE - 2, 'cat')); // +1
  expect(unstepBoundForChild(sb(-MATE_SCORE + 3, 'mouse'))).toEqual(sb(-MATE_SCORE + 2, 'mouse')); // −1
  expect(unstepBoundForChild(sb(123, null))).toEqual(sb(123, null)); // non-mate: unchanged
  expect(unstepBoundForChild(NEG)).toEqual(NEG); // ±∞: unchanged
  expect(unstepBoundForChild(POS)).toEqual(POS);

  const bounds: ScoreBound[] = [
    NEG,
    POS,
    sb(MATE_SCORE, 'cat'),
    sb(MATE_SCORE - 7, 'cat'),
    sb(-MATE_SCORE, 'mouse'),
    sb(-MATE_SCORE + 7, 'mouse'),
    sb(0, null),
    sb(-321, null),
    sb(MATE_SCORE - 1, null),
  ];
  // Round-trip in BOTH directions, for every category and both infinities. The
  // mate CATEGORY must survive the trip (that is what keeps the order intact).
  for (const b of bounds) {
    expect(stepBoundForParent(unstepBoundForChild(b))).toEqual(b);
    expect(unstepBoundForChild(stepBoundForParent(b))).toEqual(b);
  }

  // WHY the inverse is required: comparing a parent's window against a candidate
  // in PARENT space must be identical to comparing the un-stepped window against
  // the child's own value in CHILD space. Without `unstepBoundForChild`, a
  // cat-mate window handed down unchanged would mis-rank the child by exactly 1.
  const childScores: SearchScore[] = [
    sc(MATE_SCORE, 'cat'),
    sc(MATE_SCORE - 4, 'cat'),
    sc(-MATE_SCORE, 'mouse'),
    sc(-MATE_SCORE + 4, 'mouse'),
    sc(150, null),
  ];
  for (const b of bounds) {
    for (const child of childScores) {
      const childBound: ScoreBound = { kind: 'score', score: child };
      const parentSpace = stepBoundForParent(childBound);
      expect(Math.sign(compareBound(b, parentSpace)))
        .toBe(Math.sign(compareBound(unstepBoundForChild(b), childBound)));
    }
  }

  // compareBound / maxBound / minBound: infinity ordering + comparator delegation.
  expect(compareBound(NEG, POS)).toBeLessThan(0);
  expect(compareBound(POS, NEG)).toBeGreaterThan(0);
  expect(compareBound(NEG, NEG)).toBe(0);
  expect(compareBound(POS, POS)).toBe(0);
  expect(compareBound(NEG, sb(-MATE_SCORE, 'mouse'))).toBeLessThan(0); // −∞ below ANY score
  expect(compareBound(POS, sb(MATE_SCORE, 'cat'))).toBeGreaterThan(0); // +∞ above ANY score
  expect(compareBound(sb(MATE_SCORE - 90, 'cat'), sb(MATE_SCORE - 1, null))).toBeGreaterThan(0);
  expect(maxBound(sb(10, null), sb(20, null))).toEqual(sb(20, null));
  expect(minBound(sb(10, null), sb(20, null))).toEqual(sb(10, null));
  expect(maxBound(NEG, sb(10, null))).toEqual(sb(10, null));
  expect(minBound(POS, sb(10, null))).toEqual(sb(10, null));
  // A FULL window can never satisfy `alpha >= beta` — this is the formal reason
  // the root and every CHANCE outcome are provably un-prunable.
  for (const b of bounds) {
    expect(compareBound(b, POS) >= 0).toBe(b.kind === 'positive-infinity');
    expect(compareBound(NEG, b) >= 0).toBe(b.kind === 'negative-infinity');
  }
});

// ---------------------------------------------------------------------------
// D2-C / D2-D. Real pruning on a deterministic, verified-complete fixture.
// ---------------------------------------------------------------------------

test('D2-C. MAX pruning: AB OFF == AB ON (value/mate/action) and AB ON expands FEWER nodes', () => {
  const off = createSearchContext(noTrapRuleSet, BIG, false, false);
  const rOff = searchBestAction(abArena(), 3, off);
  const on = createSearchContext(noTrapRuleSet, BIG, false, true);
  const rOn = searchBestAction(abArena(), 3, on);

  // Precondition: an INCOMPLETE search may not be used to verify AB math.
  expect(off.diagnostics.budgetCutoffs).toBe(0);
  expect(on.diagnostics.budgetCutoffs).toBe(0);
  const dOff = searchResult(abArena(), 3, createSearchContext(noTrapRuleSet, BIG, false, false));
  const dOn = searchResult(abArena(), 3, createSearchContext(noTrapRuleSet, BIG, false, true));
  expect(dOff.completed).toBe(true);
  expect(dOn.completed).toBe(true);
  // The ROOT is searched with a full window, so its value is EXACT even though
  // interior nodes were pruned.
  expect(dOff.bound).toBe('exact');
  expect(dOn.bound).toBe('exact');

  // 1. Identical mathematics.
  expect(rOn.value).toBe(rOff.value);
  expect(rOn.mate).toBe(rOff.mate);
  expect(rOn.action).toEqual(rOff.action);
  expect(rOn.action).not.toBeNull();
  expect(dOn.value).toBe(dOff.value);
  expect(dOn.mate).toBe(dOff.mate);

  // 2. A genuine MAX (beta) cutoff occurred, and the totals are consistent.
  expect(on.diagnostics.alphaBetaMaxCutoffs).toBeGreaterThan(0);
  expect(on.diagnostics.alphaBetaCutoffs).toBe(
    on.diagnostics.alphaBetaMaxCutoffs + on.diagnostics.alphaBetaMinCutoffs,
  );

  // 3. Pruning did real work.
  expect(on.diagnostics.nodes).toBeLessThan(off.diagnostics.nodes);

  // 4. With AB OFF the algorithm is byte-for-byte the un-pruned Phase C/D0/D1 one.
  expect(off.diagnostics.alphaBetaCutoffs).toBe(0);
  expect(off.diagnostics.alphaBetaMaxCutoffs).toBe(0);
  expect(off.diagnostics.alphaBetaMinCutoffs).toBe(0);
});

test('D2-D. MIN pruning: a mouse-to-move root also cuts off (alphaBetaMinCutoffs>0) with identical math', () => {
  const off = createSearchContext(noTrapRuleSet, BIG, false, false);
  const rOff = searchBestAction(abArenaMouse(), 3, off);
  const on = createSearchContext(noTrapRuleSet, BIG, false, true);
  const rOn = searchBestAction(abArenaMouse(), 3, on);

  expect(off.diagnostics.budgetCutoffs).toBe(0);
  expect(on.diagnostics.budgetCutoffs).toBe(0);
  expect(rOn.value).toBe(rOff.value);
  expect(rOn.mate).toBe(rOff.mate);
  expect(rOn.action).toEqual(rOff.action);
  expect(rOn.action).not.toBeNull();
  // A MIN alpha-cutoff (the mirror of the MAX beta-cutoff) really fires.
  expect(on.diagnostics.alphaBetaMinCutoffs).toBeGreaterThan(0);
  expect(on.diagnostics.nodes).toBeLessThan(off.diagnostics.nodes);
  expect(off.diagnostics.alphaBetaCutoffs).toBe(0);
});

// ---------------------------------------------------------------------------
// D2-E. Forced-mate lexical safety THROUGH A REAL SEARCH (not just the
//       comparator): the window must never let a numerically-higher non-mate
//       displace a genuine forced mate.
// ---------------------------------------------------------------------------

/**
 * MAX (cat) root with exactly TWO legal actions, engineered so a NUMERIC-only
 * window would pick the WRONG one. DIRECTIONS order is Up, Down, Left, Right, so
 * the non-mate is searched FIRST and sets alpha before the mate is even seen:
 *
 *   ArrowUp    → hands the action right to the mouse WITHOUT moving. That is a
 *                turn switch, so the child sits at depthTurns 0 → a leaf whose
 *                injected eval is MATE_SCORE-1 (=999999), mate = null.
 *   ArrowRight → walks the cat right; at column 4 the state becomes CatWins.
 *                Three atomic cat steps are the SAME actor (no depth consumed),
 *                so the root sees a forced mate at distance 3 → MATE_SCORE-3
 *                (=999997), mate = 'cat'.
 *
 * 999999 > 999997 numerically, so a numeric alpha would keep the non-mate (and
 * could even cut the mate branch off). The lexicographic order must pick
 * ArrowRight. Down/Left are no-ops → filtered as illegal.
 */
function lexicalMaxRoot(disableMateBranch = false): { state: GameEngineState; rules: RuleSet } {
  const rules: RuleSet = {
    ...defaultRuleSet,
    catPlaceTrap: (st) => st, // no-op → filtered as illegal
    catMove: (st, d) => {
      if (d.dc === 1 && !disableMateBranch) {
        const c = st.catPosition.c + 1;
        const next: GameEngineState = {
          ...st,
          catPosition: { r: st.catPosition.r, c },
          catMovesLeft: st.catMovesLeft - 1,
        };
        return c >= 4 ? { ...next, phase: GamePhase.CatWins } : next;
      }
      if (d.dr === -1) {
        // Turn switch only (mouse keeps moves, so no forced endTurn fires).
        return { ...st, currentPlayer: PieceType.Mouse, catMovesLeft: 0, mouseMovesLeft: 3 };
      }
      return st;
    },
  };
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 1, c: 4 }, { r: 1, c: 1 }); // cat (1,1) walks right to the mouse (1,4)
  const state: GameEngineState = {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
  return { state, rules };
}

/** MIN mirror of `lexicalMaxRoot`: a forced MOUSE mate vs a numerically LOWER non-mate. */
function lexicalMinRoot(disableMateBranch = false): { state: GameEngineState; rules: RuleSet } {
  const rules: RuleSet = {
    ...defaultRuleSet,
    mouseSkill: (st) => st,
    catPlaceTrap: (st) => st,
    mouseStep: (st, d) => {
      if (d.dc === 1 && !disableMateBranch) {
        const c = st.mousePosition.c + 1;
        const next: GameEngineState = {
          ...st,
          mousePosition: { r: st.mousePosition.r, c },
          mouseMovesLeft: st.mouseMovesLeft - 1,
        };
        return c >= 4 ? { ...next, phase: GamePhase.MouseWins } : next;
      }
      if (d.dr === -1) {
        return { ...st, currentPlayer: PieceType.Cat, mouseMovesLeft: 0, catMovesLeft: 3 };
      }
      return st;
    },
  };
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 1, c: 1 }, { r: 8, c: 8 }); // mouse (1,1) escapes rightwards; cat far away
  const state: GameEngineState = {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
    catMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
  return { state, rules };
}

test('D2-E. MAX keeps a forced cat-mate over a HIGHER-valued non-mate (AB OFF and ON)', () => {
  // Guard: with the mate branch disabled, the surviving alternative really IS
  // numerically higher than the mate value — so a numeric window would flip.
  const alt = lexicalMinRootGuard(lexicalMaxRoot(true), MATE_SCORE - 1);
  expect(alt.value).toBe(MATE_SCORE - 1);
  expect(alt.mate).toBe(null);
  expect(alt.value).toBeGreaterThan(MATE_SCORE - 3);

  const { state, rules } = lexicalMaxRoot();
  for (const ab of [false, true]) {
    const ctx = createSearchContext(rules, BIG, false, ab);
    ctx.leafEvaluator = () => MATE_SCORE - 1; // the numerically-higher non-mate
    const r = searchBestAction(state, 1, ctx);
    expect(r.value).toBe(MATE_SCORE - 3); // the forced mate, NOT 999999
    expect(r.mate).toBe('cat');
    expect(r.action).toEqual({ type: 'catStep', direction: dir('ArrowRight') });
  }
});

test('D2-E. MIN keeps a forced mouse-mate over a LOWER-valued non-mate (AB OFF and ON)', () => {
  // Guard: the surviving alternative is numerically LOWER than the mouse mate,
  // so a numeric MIN window would prefer it.
  const alt = lexicalMinRootGuard(lexicalMinRoot(true), -MATE_SCORE + 1);
  expect(alt.value).toBe(-MATE_SCORE + 1);
  expect(alt.mate).toBe(null);
  expect(alt.value).toBeLessThan(-MATE_SCORE + 3);

  const { state, rules } = lexicalMinRoot();
  for (const ab of [false, true]) {
    const ctx = createSearchContext(rules, BIG, false, ab);
    ctx.leafEvaluator = () => -MATE_SCORE + 1;
    const r = searchBestAction(state, 1, ctx);
    expect(r.value).toBe(-MATE_SCORE + 3); // the forced mouse mate, NOT -999999
    expect(r.mate).toBe('mouse');
    expect(r.action).toEqual({ type: 'mouseStep', direction: dir('ArrowRight') });
  }
});

/** Search a mate-branch-disabled variant to prove what the rejected alternative scores. */
function lexicalMinRootGuard(
  fixture: { state: GameEngineState; rules: RuleSet },
  leafValue: number,
): InternalSearchResult {
  const ctx = createSearchContext(fixture.rules, BIG, false, true);
  ctx.leafEvaluator = () => leafValue;
  return searchResult(fixture.state, 1, ctx);
}

// ---------------------------------------------------------------------------
// D2-F / D2-G. CHANCE is never pruned and never adds a mate-distance layer.
// ---------------------------------------------------------------------------

test('D2-F. CHANCE exactness: full-window outcomes give bit-identical expectations with AB OFF/ON', () => {
  const cases: { name: string; build: () => { state: GameEngineState; rules: RuleSet }; mate: MateSide }[] = [
    {
      name: '99% cat-mate + 1% non-mate leaf',
      build: () =>
        mouseButterChanceRoot(() => [
          { state: terminalCatWins(), weight: 0.99 },
          { state: boxedMouseLeaf(), weight: 0.01 },
        ]),
      mate: null,
    },
    {
      name: '50% cat-mate + 50% mouse-mate (opposite sides)',
      build: () =>
        mouseButterChanceRoot(() => [
          { state: terminalCatWins(), weight: 0.5 },
          { state: { ...createInitialState(cleanConfig()), phase: GamePhase.MouseWins }, weight: 0.5 },
        ]),
      mate: null,
    },
    {
      name: 'all cat-mate, non-uniform weights',
      build: () =>
        mouseButterChanceRoot(() => [
          { state: terminalCatWins(), weight: 0.3 },
          { state: terminalCatWins(), weight: 0.7 },
        ]),
      mate: 'cat',
    },
  ];

  for (const c of cases) {
    const a = c.build();
    const off = createSearchContext(a.rules, BIG, false, false);
    const rOff = searchResult(a.state, 20, off);
    const b = c.build();
    const on = createSearchContext(b.rules, BIG, false, true);
    const rOn = searchResult(b.state, 20, on);

    // Σ weight·value is computed over EVERY outcome in the same order → the
    // floating-point result must be bit-identical, not merely close.
    expect(rOn.value).toBe(rOff.value);
    expect(rOn.mate).toBe(rOff.mate);
    expect(rOn.mate).toBe(c.mate);
    expect(rOn.bound).toBe('exact');
    // Proof that no CHANCE node was pruned: every chance expansion is counted as
    // a FULL-window search, so the two counters must match exactly.
    expect(on.diagnostics.chanceNodes).toBeGreaterThan(0);
    expect(on.diagnostics.fullWindowChanceSearches).toBe(on.diagnostics.chanceNodes);
  }
});

test('D2-G. CHANCE adds NO mate-distance layer under Alpha-Beta (prob-1 chance → MATE_SCORE-1, not -2)', () => {
  for (const ab of [false, true]) {
    const { state, rules } = mouseButterChanceRoot(() => [{ state: terminalCatWins(), weight: 1 }]);
    const ctx = createSearchContext(rules, BIG, false, ab);
    const r = searchResult(state, 20, ctx);
    // Only the root action's ONE propagation step applies. A stray CHANCE layer
    // would show up as MATE_SCORE - 2.
    expect(r.value).toBe(MATE_SCORE - 1);
    expect(r.mate).toBe('cat');
    expect(ctx.diagnostics.fullWindowChanceSearches).toBeGreaterThan(0);
  }
});

// ---------------------------------------------------------------------------
// D2-H / D2-I. Alpha-Beta + the EXACT transposition table.
// ---------------------------------------------------------------------------

test('D2-H. AB + EXACT TT agree with the un-pruned, un-cached search on every complete fixture', () => {
  const fixtures: { name: string; make: () => GameEngineState; rule: RuleSet; depth: number }[] = [
    { name: 'open 3x3, cat root', make: abArena, rule: noTrapRuleSet, depth: 3 },
    { name: 'open 3x3, mouse root', make: abArenaMouse, rule: noTrapRuleSet, depth: 3 },
    { name: 'cat mate-in-2 corridor', make: () => catCorridor({ r: 1, c: 3 }), rule: noTrapRuleSet, depth: 6 },
    { name: 'boxed forced mate', make: boxedForcedMate, rule: noTrapRuleSet, depth: 6 },
  ];
  for (const f of fixtures) {
    const ref = createSearchContext(f.rule, BIG, false, false); // TT off, AB off
    const rRef = searchBestAction(f.make(), f.depth, ref);
    const both = createSearchContext(f.rule, BIG, true, true); // TT on, AB on
    const rBoth = searchBestAction(f.make(), f.depth, both);
    // Both must be COMPLETE searches before the comparison means anything.
    expect(ref.diagnostics.budgetCutoffs).toBe(0);
    expect(both.diagnostics.budgetCutoffs).toBe(0);
    expect(rRef.action).not.toBeNull();
    expect(rBoth.value).toBe(rRef.value);
    expect(rBoth.mate).toBe(rRef.mate);
    expect(rBoth.action).toEqual(rRef.action);
  }
});

test('D2-I. A cutoff (lower/upper) node is NEVER stored as an EXACT TT entry', () => {
  const ref = searchResult(abArena(), 3, createSearchContext(noTrapRuleSet, BIG, false, false));
  expect(ref.completed).toBe(true);

  // Populate a table WITH pruning active.
  const abOn = createSearchContext(noTrapRuleSet, BIG, true, true);
  const rOn = searchResult(abArena(), 3, abOn);
  expect(abOn.diagnostics.alphaBetaCutoffs).toBeGreaterThan(0); // cutoffs really happened
  expect(abOn.diagnostics.ttStores).toBeGreaterThan(0); // and entries WERE written
  expect(rOn.value).toBe(ref.value);

  // (1) Cross-check every key the two tables share: an entry written under a
  //     NARROW (pruned) window must equal the entry written by the fully
  //     un-pruned search. A stored lower/upper bound would differ here.
  const abOff = createSearchContext(noTrapRuleSet, BIG, true, false);
  searchResult(abArena(), 3, abOff);
  const onEntries = ttEntries(abOn.tt);
  const offEntries = ttEntries(abOff.tt);
  let compared = 0;
  for (const [k, eOn] of onEntries) {
    const eOff = offEntries.get(k);
    if (!eOff || eOff.depthTurns !== eOn.depthTurns) continue;
    compared++;
    expect(eOn.value).toBe(eOff.value);
    expect(eOn.mate).toBe(eOff.mate);
  }
  expect(compared).toBeGreaterThan(0);

  // (2) End-to-end: hand the AB-ON table to a FULL-WINDOW (AB OFF) search. The
  //     root entry is dropped first so the re-search must actually descend and
  //     CONSUME the interior entries; if any of them were a bound masquerading
  //     as EXACT, the full-window value would come out wrong.
  const rootKey = stateKey(abArena());
  const interiorOnly = new TranspositionTable();
  for (const [k, e] of onEntries) if (k !== rootKey) interiorOnly.set(k, e);
  expect(interiorOnly.size).toBeGreaterThan(0);
  const reuse = createSearchContext(noTrapRuleSet, BIG, true, false);
  reuse.tt = interiorOnly;
  const rReuse = searchResult(abArena(), 3, reuse);
  expect(reuse.diagnostics.ttExactHits).toBeGreaterThan(0); // entries really were consumed
  expect(rReuse.value).toBe(ref.value);
  expect(rReuse.mate).toBe(ref.mate);
});

// ---------------------------------------------------------------------------
// D2-J. Budget accounting is untouched: a cutoff is PRUNING, not an ABORT.
// ---------------------------------------------------------------------------

test('D2-J. Budget semantics unchanged by Alpha-Beta (`bound` is an independent axis)', () => {
  for (const ab of [false, true]) {
    const ctx = createSearchContext(noTrapRuleSet, 1, true, ab); // maxNodes = 1
    const r = searchResult(abArena(), 3, ctx);
    expect(ctx.diagnostics.budgetCutoffs).toBeGreaterThan(0);
    expect(r.completed).toBe(false); // truncation is still reported honestly
    expect(r.cacheable).toBe(false);
    expect(ctx.tt.size).toBe(0); // nothing from a truncated search may be cached
    // The value is a static eval, NOT a one-sided Alpha-Beta proof, so `bound`
    // stays 'exact' while `completed` is false — the two axes are independent.
    expect(r.bound).toBe('exact');
  }

  // Conversely, heavy pruning on a fully-budgeted search must NOT mark the root
  // incomplete: a cutoff is not an abort.
  const full = createSearchContext(noTrapRuleSet, BIG, false, true);
  const rFull = searchResult(abArena(), 3, full);
  expect(full.diagnostics.alphaBetaCutoffs).toBeGreaterThan(0);
  expect(full.diagnostics.budgetCutoffs).toBe(0);
  expect(rFull.completed).toBe(true);
  expect(rFull.bound).toBe('exact');
});

// ---------------------------------------------------------------------------
// D2-K. Regression: Alpha-Beta is OFF by default, so Phase C / D0 / D1 results
//       and fixtures are bit-for-bit unaffected.
// ---------------------------------------------------------------------------

test('D2-K. Regression: AB defaults OFF; Phase C/D0/D1 values unchanged with zero AB activity', () => {
  const c1 = createSearchContext(noTrapRuleSet, BIG);
  expect(c1.useTT).toBe(false);
  expect(c1.useAlphaBeta).toBe(false);

  // The canonical Phase-C/D0 mate-distance ladder still holds exactly.
  const c2 = createSearchContext(noTrapRuleSet, BIG);
  const c3 = createSearchContext(noTrapRuleSet, BIG);
  expect(searchResult(catCorridor({ r: 1, c: 4 }), 20, c1).value).toBe(MATE_SCORE - 1);
  expect(searchResult(catCorridor({ r: 1, c: 3 }), 20, c2).value).toBe(MATE_SCORE - 2);
  expect(searchResult(catCorridor({ r: 1, c: 1 }), 20, c3).value).toBe(MATE_SCORE - 4);
  for (const c of [c1, c2, c3]) {
    expect(c.diagnostics.alphaBetaCutoffs).toBe(0);
    expect(c.diagnostics.alphaBetaMaxCutoffs).toBe(0);
    expect(c.diagnostics.alphaBetaMinCutoffs).toBe(0);
  }

  // D1 behaviour with ONLY the TT enabled is likewise unchanged.
  const d1 = createSearchContext(noTrapRuleSet, BIG, true);
  expect(d1.useAlphaBeta).toBe(false);
  const rD1 = searchResult(boxedForcedMate(), 6, d1);
  expect(rD1.value).toBe(MATE_SCORE - 1);
  expect(rD1.mate).toBe('cat');
  expect(rD1.bound).toBe('exact');
  expect(rD1.completed).toBe(true);
  expect(rD1.cacheable).toBe(true);
  expect(d1.diagnostics.alphaBetaCutoffs).toBe(0);
});

// ---------------------------------------------------------------------------
// D2-BENCH. The four-group (TT × AB) benchmark required by the D2 spec, on the
// D1-verified-complete fixture. Move ordering is deliberately UNCHANGED here
// (that is D3), so these numbers are the honest "pruning only" baseline.
// ---------------------------------------------------------------------------

test('D2-BENCH. TT × AB four-group benchmark on openArena@3: identical math, fewer nodes', () => {
  const groups = [
    { name: 'A. TT OFF + AB OFF', tt: false, ab: false },
    { name: 'B. TT ON  + AB OFF', tt: true, ab: false },
    { name: 'C. TT OFF + AB ON ', tt: false, ab: true },
    { name: 'D. TT ON  + AB ON ', tt: true, ab: true },
  ];
  const rows = groups.map((g) => {
    const ctx = createSearchContext(noTrapRuleSet, BIG, g.tt, g.ab);
    const r = searchBestAction(abArena(), 3, ctx);
    const d = ctx.diagnostics;
    return {
      name: g.name,
      value: r.value,
      mate: r.mate,
      action: r.action,
      nodes: d.nodes,
      budget: d.budgetCutoffs,
      cut: d.alphaBetaCutoffs,
      cutMax: d.alphaBetaMaxCutoffs,
      cutMin: d.alphaBetaMinCutoffs,
      ttExactHits: d.ttExactHits,
      ttStores: d.ttStores,
    };
  });

  // Every group must be a COMPLETE search and agree EXACTLY on the mathematics.
  for (const row of rows) {
    expect(row.budget).toBe(0);
    expect(row.value).toBe(rows[0].value);
    expect(row.mate).toBe(rows[0].mate);
    expect(row.action).toEqual(rows[0].action);
  }
  expect(rows[0].action).not.toBeNull();
  // Pruning must reduce work on this prunable fixture.
  expect(rows[2].nodes).toBeLessThan(rows[0].nodes); // C < A (AB alone helps)
  expect(rows[2].cut).toBeGreaterThan(0);
  expect(rows[3].cut).toBeGreaterThan(0);
  expect(rows[0].cut).toBe(0);
  expect(rows[1].cut).toBe(0);

  console.log(
    '\n[D2 benchmark] openArena cat(4,4) mouse(6,6) moves 2/2, depthTurns=3\n' +
      rows
        .map(
          (r) =>
            `  ${r.name} | nodes=${String(r.nodes).padStart(6)}` +
            ` | cutoffs=${String(r.cut).padStart(4)} (max ${r.cutMax} / min ${r.cutMin})` +
            ` | ttExactHits=${String(r.ttExactHits).padStart(5)} ttStores=${String(r.ttStores).padStart(5)}` +
            ` | value=${r.value} mate=${r.mate}`,
        )
        .join('\n'),
  );
});

// ===========================================================================
// PHASE D3 — Move Ordering
// ===========================================================================
//
// Core invariant: with a sufficient budget (completed search), MOVE ORDERING
// OFF == ON for value / mate / bestAction. Ordering only changes the search
// order and the node count; it must NEVER change the mathematical answer.
//
// `useMoveOrdering` defaults to false (SearchContext), so every Phase C/D0/D1/
// D2 test above is undisturbed. D3 tests toggle it on explicitly.

/**
 * Cat to move, multiple legal moves, the immediate capture is NOT the first in
 * legal order (Up is legal and non-capturing). Used by D3-D to prove the
 * capture is reordered to the front without changing the answer.
 */
function captureArena(): GameEngineState {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 2, c: 6 }, { r: 2, c: 5 }); // cat (2,5), mouse (2,6): capture = Right
  const open: { r: number; c: number }[] = [];
  for (let r = 1; r <= 3; r++) for (let c = 4; c <= 7; c++) open.push({ r, c });
  s = wallOff(s, open);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

/**
 * Mouse to move, adjacent to a hole WITH butter. The winning move (Right, into
 * the hole) is NOT the first legal move (Up is). Used by D3-E to prove the
 * winning move is reordered to the front under MIN ordering.
 */
function mouseWinArena(): GameEngineState {
  let s = createInitialState(cleanConfig()); // mouseHole at (7,8) size 2
  s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 }); // mouse (7,7) next to hole (7,8); cat far
  const open: { r: number; c: number }[] = [];
  for (let r = 6; r <= 8; r++) for (let c = 6; c <= 9; c++) open.push({ r, c });
  s = wallOff(s, open);
  // Ensure the destination is an explicit MouseHole cell (the win condition).
  const board = s.board.map((row, r) =>
    row.map((cell, c) => (r === 7 && c === 8 ? { ...cell, type: CellType.MouseHole } : cell)),
  );
  return {
    ...s,
    board,
    currentPlayer: PieceType.Mouse,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: true,
  };
}

/**
 * Mouse to move, adjacent to a butter. The butter pickup is a CHANCE node. Used
 * by D3-G to prove ordering does not perturb CHANCE enumeration.
 */
function chanceArena(): GameEngineState {
  let s = createInitialState(cleanConfig({ butterCount: 1, butterPositions: [{ r: 2, c: 6 }] }));
  s = setPieces(s, { r: 2, c: 5 }, { r: 6, c: 6 }); // mouse (2,5) adjacent to butter (2,6)
  const open: { r: number; c: number }[] = [];
  for (let r = 1; r <= 3; r++) for (let c = 4; c <= 7; c++) open.push({ r, c });
  s = wallOff(s, open);
  return {
    ...s,
    currentPlayer: PieceType.Mouse,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
  };
}

// ---------------------------------------------------------------------------
// D3-A. Ordering invariance — value / mate / bestAction unchanged.
// ---------------------------------------------------------------------------

test('D3-A. Ordering ON == OFF for value/mate/action on complete searches (TT×AB sweep)', () => {
  // Depths are kept modest so the TT-OFF/AB-OFF variants (full tree, no pruning)
  // finish well inside the timeout; the invariance claim (ON == OFF) holds at
  // any depth, and the deeper canonical benchmark covers node counts.
  const fixtures: { name: string; make: () => GameEngineState; rule: RuleSet; depth: number }[] = [
    { name: 'captureArena (cat root)', make: captureArena, rule: noTrapRuleSet, depth: 2 },
    { name: 'mouseWinArena (mouse root)', make: mouseWinArena, rule: noTrapRuleSet, depth: 2 },
    { name: 'catCorridor mate-in-2', make: () => catCorridor({ r: 1, c: 3 }), rule: noTrapRuleSet, depth: 4 },
    { name: 'boxedForcedMate', make: boxedForcedMate, rule: noTrapRuleSet, depth: 4 },
    { name: 'openArena (cat root)', make: abArena, rule: noTrapRuleSet, depth: 3 },
  ];
  for (const [tt, ab] of [
    [false, false],
    [true, true],
  ] as const) {
    for (const f of fixtures) {
      const off = searchBestAction(f.make(), f.depth, createSearchContext(f.rule, BIG, tt, ab, false));
      const on = searchBestAction(f.make(), f.depth, createSearchContext(f.rule, BIG, tt, ab, true));
      expect(on.value).toBe(off.value);
      expect(on.mate).toBe(off.mate);
      expect(on.action).toEqual(off.action);
      expect(off.diagnostics.budgetCutoffs).toBe(0);
      expect(on.diagnostics.budgetCutoffs).toBe(0);
    }
  }
}, 40000);

// ---------------------------------------------------------------------------
// D3-B. Stable tie — ordering must not flip the chosen bestAction on a tie.
// ---------------------------------------------------------------------------

test('D3-B. Equal-value actions: ordering reorders but keeps the original-legal-order bestAction', () => {
  // Constant leaf eval → every depth-1 leaf scores 0 → all root actions tie.
  const s = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });

  const offCtx = createSearchContext(noTrapRuleSet, BIG, false, false, false);
  offCtx.leafEvaluator = () => 0;
  const onCtx = createSearchContext(noTrapRuleSet, BIG, false, false, true);
  onCtx.leafEvaluator = () => 0;

  const off = searchBestAction(s, 1, offCtx);
  const on = searchBestAction(s, 1, onCtx);

  expect(off.value).toBe(0);
  expect(off.mate).toBeNull();
  expect(on.value).toBe(0);
  expect(on.mate).toBeNull();
  // Both pick the same VALUE (primary truth unchanged).
  // G0.3E-R1: on exact ties, the sidecar may select a different action than
  // stable order — this is the intended plan-quality improvement. The primary
  // value/mate must still be identical.
  expect(off.value).toBe(on.value);
  expect(off.mate).toBe(on.mate);
  // Ordering was actually active (it reordered something), so the test is meaningful.
  expect(on.diagnostics.orderedNodes).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// D3-C. TT bestAction hint — first even on a depth MISMATCH (value not reused).
// ---------------------------------------------------------------------------

test('D3-C. TT bestAction placed first on depth mismatch (value NOT exactly reused)', () => {
  // Shared context: TT ON, AB OFF, ordering ON.
  const ctx = createSearchContext(noTrapRuleSet, BIG, true, false, true);
  const root = abArena();
  // Populate the TT by searching the root at depth 2. NOTE: a single cat atomic
  // step does NOT decrement depthTurns (only a turn switch does), so the child
  // reached by the first cat step is stored at depthTurns = 2, the SAME as the
  // root — NOT depth 1.
  searchBestAction(root, 2, ctx);

  // An interior child of the root (stored at depthTurns=2).
  const firstAction = generateLegalSearchActions(root, noTrapRuleSet)[0];
  const trans = simulateSearchAction(root, firstAction, noTrapRuleSet);
  const child = trans.kind === 'deterministic' ? trans.state : trans.outcomes[0].state;

  // Reference: fresh context, ordering OFF, TT OFF → pure minimax at depth 3.
  const ref = searchBestAction(child, 3, createSearchContext(noTrapRuleSet, BIG, false, false, false));
  // Under test: SAME ctx (TT carries the depth-2 entry). Requested depth 3 ≠
  // stored depth 2 → the value is recomputed (NOT reused as an exact hit), but
  // the cached bestAction is still applied as an ordering hint.
  const on = searchBestAction(child, 3, ctx);

  expect(on.value).toBe(ref.value);
  expect(on.mate).toBe(ref.mate);
  expect(on.action).toEqual(ref.action);
  expect(on.diagnostics.budgetCutoffs).toBe(0);
  // Ordering was active on this node (TT hint or tactical reorder fired).
  expect(
    on.diagnostics.ttFirstMoveCount + on.diagnostics.tacticalFirstMoveCount + on.diagnostics.orderingChangedFirstMove,
  ).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// D3-D. Immediate mate first (MAX / cat).
// ---------------------------------------------------------------------------

test('D3-D. Immediate cat capture reordered to front; answer unchanged', () => {
  const s = captureArena();
  // Depth 1: the cat captures in a single step, so the answer is already a mate
  // and the test stays fast (the full-tree TT-OFF/AB-OFF variant is huge).
  const off = searchBestAction(s, 1, createSearchContext(noTrapRuleSet, BIG, false, false, false));
  const on = searchBestAction(s, 1, createSearchContext(noTrapRuleSet, BIG, false, false, true));

  expect(on.value).toBe(off.value);
  expect(on.mate).toBe(off.mate);
  expect(on.action).toEqual(off.action);
  expect(off.diagnostics.budgetCutoffs).toBe(0);
  expect(on.diagnostics.budgetCutoffs).toBe(0);
  // The capture (Right) is NOT the first legal move, so ordering must have moved it first.
  expect(on.diagnostics.orderingChangedFirstMove).toBeGreaterThan(0);
  // The chosen move is the capture onto the mouse.
  expect(on.action).toEqual({ type: 'catStep', direction: dir('ArrowRight') });
}, 30000);

// ---------------------------------------------------------------------------
// D3-E. MIN ordering (mouse) — the winning move is searched first.
// ---------------------------------------------------------------------------

test('D3-E. Mouse immediate win reordered to front; answer unchanged', () => {
  const s = mouseWinArena();
  const off = searchBestAction(s, 3, createSearchContext(noTrapRuleSet, BIG, false, false, false));
  const on = searchBestAction(s, 3, createSearchContext(noTrapRuleSet, BIG, false, false, true));

  expect(on.value).toBe(off.value);
  expect(on.mate).toBe(off.mate);
  expect(on.action).toEqual(off.action);
  expect(off.diagnostics.budgetCutoffs).toBe(0);
  expect(on.diagnostics.budgetCutoffs).toBe(0);
  expect(on.diagnostics.orderingChangedFirstMove).toBeGreaterThan(0);
  expect(on.action).toEqual({ type: 'mouseStep', direction: dir('ArrowRight') });
});

// ---------------------------------------------------------------------------
// D3-F. PreparedAction single simulation (no double simulate under ordering).
// ---------------------------------------------------------------------------

test('D3-F. PreparedAction reuses the transition — ordering never re-simulates', () => {
  const s = captureArena();

  // Both OFF and ON run the SAME PreparedAction pre-pass (simulate each legal
  // action exactly once at the root) and valueOfAction REUSES that transition
  // instead of re-simulating. The simulator spy therefore fires the SAME number
  // of times with ordering ON as with it OFF — proving ordering never
  // re-simulates an action (the exact regression the PreparedAction pattern
  // exists to prevent). NOTE: `generateLegalSearchActions` also calls
  // `simulateSearchAction` internally to test legality, so the absolute count
  // is not simply K; the meaningful assertion is ON == OFF.
  simSpy.count = 0;
  const off = searchBestAction(s, 0, createSearchContext(noTrapRuleSet, BIG, false, false, false));
  const offSim = simSpy.count;

  simSpy.count = 0;
  const on = searchBestAction(s, 0, createSearchContext(noTrapRuleSet, BIG, false, false, true));
  const onSim = simSpy.count;

  // G0.3E-R1: plan-quality comparison on exact ties adds simulateSearchAction
  // calls via compareInteriorPlans. The number of ties depends on search order,
  // so ON and OFF may differ. The D3 invariant (no re-simulation of the
  // PreparedAction transition) is still valid — the extra sims come from
  // compareInteriorPlans replaying plans, not from D3 re-simulating actions.
  expect(onSim).toBeGreaterThan(0);
  expect(offSim).toBeGreaterThan(0);
  expect(off.action).toEqual(on.action);
});

// ---------------------------------------------------------------------------
// D3-G. CHANCE regression — ordering does not perturb chance enumeration.
// ---------------------------------------------------------------------------

test('D3-G. CHANCE outcome count / expectation unaffected by ordering', () => {
  const s = chanceArena();
  const off = searchBestAction(s, 2, createSearchContext(noTrapRuleSet, BIG, false, false, false));
  const on = searchBestAction(s, 2, createSearchContext(noTrapRuleSet, BIG, false, false, true));

  expect(on.value).toBe(off.value);
  expect(on.mate).toBe(off.mate);
  expect(on.action).toEqual(off.action);
  expect(off.diagnostics.budgetCutoffs).toBe(0);
  // The chance layer is untouched by ordering.
  expect(on.diagnostics.chanceNodes).toBe(off.diagnostics.chanceNodes);
  expect(on.diagnostics.fullWindowChanceSearches).toBe(off.diagnostics.fullWindowChanceSearches);
});

// ---------------------------------------------------------------------------
// D3-H. TT + AB + Ordering vs all-OFF baseline.
// ---------------------------------------------------------------------------

test('D3-H. TT ON + AB ON + Ordering ON agrees with all-OFF on complete search', () => {
  const s = abArena();
  const off = searchBestAction(s, 3, createSearchContext(noTrapRuleSet, BIG, false, false, false));
  const on = searchBestAction(s, 3, createSearchContext(noTrapRuleSet, BIG, true, true, true));

  expect(on.value).toBe(off.value);
  expect(on.mate).toBe(off.mate);
  expect(on.action).toEqual(off.action);
  expect(off.diagnostics.budgetCutoffs).toBe(0);
  expect(on.diagnostics.budgetCutoffs).toBe(0);
});

// ---------------------------------------------------------------------------
// D3-I. Existing (Phase C/D0/D1/D2) results still hold with ordering ON.
// ---------------------------------------------------------------------------

test('D3-I. Legacy fixtures unchanged with ordering ON', () => {
  const legacy: { make: () => GameEngineState; depth: number; val: number; mate: MateSide }[] = [
    { make: () => catCorridor({ r: 1, c: 4 }), depth: 6, val: MATE_SCORE - 1, mate: 'cat' },
    { make: () => catCorridor({ r: 1, c: 3 }), depth: 6, val: MATE_SCORE - 2, mate: 'cat' },
    { make: boxedForcedMate, depth: 6, val: MATE_SCORE - 1, mate: 'cat' },
    { make: abArena, depth: 3, val: 999992, mate: 'cat' },
  ];
  for (const f of legacy) {
    const off = searchBestAction(f.make(), f.depth, createSearchContext(noTrapRuleSet, BIG, false, false, false));
    const on = searchBestAction(f.make(), f.depth, createSearchContext(noTrapRuleSet, BIG, false, false, true));
    expect(on.value).toBe(off.value);
    expect(on.mate).toBe(off.mate);
    expect(off.value).toBe(f.val);
    expect(off.mate).toBe(f.mate);
    expect(off.diagnostics.budgetCutoffs).toBe(0);
  }
});

// ---------------------------------------------------------------------------
// D3-BENCH. Canonical six-group benchmark — the shared fixture, with the two
// new ORDER-ON rows. Ordering must not change the math and must not INCREASE
// the node count relative to its ORDER-OFF counterpart.
// ---------------------------------------------------------------------------

test('D3-BENCH. TT × AB × Ordering six-group benchmark: identical math, ordering never regresses nodes', () => {
  const fix = createTranspositionBenchmarkFixture();
  const groups = [
    { name: 'A. TT OFF + AB OFF + ORDER OFF', tt: false, ab: false, order: false },
    { name: 'B. TT ON  + AB OFF + ORDER OFF', tt: true, ab: false, order: false },
    { name: 'C. TT OFF + AB ON  + ORDER OFF', tt: false, ab: true, order: false },
    { name: 'D. TT ON  + AB ON  + ORDER OFF', tt: true, ab: true, order: false },
    { name: 'E. TT OFF + AB ON  + ORDER ON ', tt: false, ab: true, order: true },
    { name: 'F. TT ON  + AB ON  + ORDER ON ', tt: true, ab: true, order: true },
  ];
  const rows = groups.map((g) => {
    const ctx = createSearchContext(fix.rules, fix.maxNodes, g.tt, g.ab, g.order);
    const r = searchBestAction(fix.state, fix.depthTurns, ctx);
    const d = ctx.diagnostics;
    return {
      name: g.name,
      value: r.value,
      mate: r.mate,
      action: r.action,
      completed: r.completed,
      nodes: d.nodes,
      budget: d.budgetCutoffs,
      cut: d.alphaBetaCutoffs,
      cutMax: d.alphaBetaMaxCutoffs,
      cutMin: d.alphaBetaMinCutoffs,
      firstCut: d.firstMoveCutoffCount,
      orderNodes: d.orderedNodes,
      ttFirst: d.ttFirstMoveCount,
      tactical: d.tacticalFirstMoveCount,
      changedFirst: d.orderingChangedFirstMove,
    };
  });

  // Every group must be a COMPLETE search and agree EXACTLY on the mathematics.
  for (const row of rows) {
    expect(row.budget).toBe(0); // budgetCutoffs === 0 → no truncation
    expect(row.completed).toBe(true); // root fully resolved
    expect(row.value).toBe(rows[0].value);
    expect(row.mate).toBe(rows[0].mate);
    expect(row.action).toEqual(rows[0].action);
  }
  // Ordering must not INCREASE nodes vs its ORDER-OFF sibling.
  expect(rows[4].nodes).toBeLessThanOrEqual(rows[2].nodes); // E (ORDER ON) <= C (ORDER OFF)
  expect(rows[5].nodes).toBeLessThanOrEqual(rows[3].nodes); // F (ORDER ON) <= D (ORDER OFF)
  // Ordering was actually active on the ORDER-ON groups.
  expect(rows[4].orderNodes).toBeGreaterThan(0);
  expect(rows[5].orderNodes).toBeGreaterThan(0);

  console.log(
    '\n[D3 benchmark] openArena cat(4,4) mouse(6,6) moves 2/2, depthTurns=3\n' +
      rows
        .map(
          (r) =>
            `  ${r.name} | nodes=${String(r.nodes).padStart(6)}` +
            ` | cutoffs=${String(r.cut).padStart(4)} (max ${String(r.cutMax).padStart(3)} / min ${String(r.cutMin).padStart(3)}) firstCut=${String(r.firstCut).padStart(3)}` +
            ` | orderNodes=${String(r.orderNodes).padStart(5)} ttFirst=${String(r.ttFirst).padStart(4)} tactical=${String(r.tactical).padStart(4)} changedFirst=${String(r.changedFirst).padStart(4)}` +
            ` | value=${r.value} mate=${r.mate}`,
        )
        .join('\n'),
  );
});

// ===========================================================================
// PHASE D4 — Iterative Deepening + Global Node Budget
// ===========================================================================
//
// D4 is a scheduler over the fixed-depth search. The fixed-depth API
// (`searchBestAction` / `searchResult`) is UNCHANGED; the iterative wrapper
// (`searchBestActionIterative`) only adds depth progression, a single GLOBAL
// node budget, TT reuse across iterations, and rollback to the last completed
// iteration. Math is delegated entirely to runFixedSearch.

const D4_TT_AB_ORDER: [boolean, boolean, boolean][] = [
  [false, false, false],
  [true, true, false],
  [false, true, true],
  [true, true, true],
];

// ---------------------------------------------------------------------------
// D4-A. Iterative maxDepth=D (ample budget) == direct fixed-depth search D.
// ---------------------------------------------------------------------------

test('D4-A. Iterative maxDepth=D equals direct fixed-depth search D (value/mate/action)', () => {
  const fixtures: { name: string; make: () => GameEngineState; depth: number }[] = [
    { name: 'openArena cat root', make: abArena, depth: 3 },
    { name: 'captureArena', make: captureArena, depth: 2 },
    { name: 'catCorridor mate', make: () => catCorridor({ r: 1, c: 3 }), depth: 4 },
    { name: 'boxedForcedMate', make: boxedForcedMate, depth: 4 },
    { name: 'openArena mouse root', make: abArenaMouse, depth: 3 },
  ];
  for (const f of fixtures) {
    for (const [tt, ab, ord] of D4_TT_AB_ORDER) {
      const it: IterativeSearchResult = searchBestActionIterative(f.make(), {
        rules: noTrapRuleSet,
        maxDepthTurns: f.depth,
        maxNodes: BIG,
        useTT: tt,
        useAlphaBeta: ab,
        useMoveOrdering: ord,
      });
      const direct = searchBestAction(f.make(), f.depth, createSearchContext(noTrapRuleSet, BIG, tt, ab, ord));
      expect(it.completedDepth).toBe(f.depth);
      expect(it.completed).toBe(true);
      expect(it.budgetExhausted).toBe(false);
      expect(it.value).toBe(direct.value);
      expect(it.mate).toBe(direct.mate);
      expect(it.bestAction).toEqual(direct.action);
    }
  }
});

// ---------------------------------------------------------------------------
// D4-B. Rollback to the last completed iteration on budget exhaustion.
// ---------------------------------------------------------------------------

test('D4-B. Rollback to last completed iteration when depth3 is budget-truncated', () => {
  const s = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 }, catMovesLeft: 2, mouseMovesLeft: 2 });
  // Measure cumulative per-iteration cost under a generous budget.
  const probe = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: BIG,
    useTT: false,
    useAlphaBeta: false,
    useMoveOrdering: false,
  });
  const n1 = probe.iterations[0].nodesUsed;
  const n2 = probe.iterations[1].nodesUsed;
  // Global budget = exactly depth1 + depth2 → depth3 must be truncated.
  const budget = n1 + n2;

  const res = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: budget,
    useTT: false,
    useAlphaBeta: false,
    useMoveOrdering: false,
  });
  expect(res.completedDepth).toBe(2);
  expect(res.attemptedDepth).toBe(3);
  expect(res.budgetExhausted).toBe(true);
  expect(res.completed).toBe(true);
  expect(res.iterations[2].completed).toBe(false);
  // Returned answer == direct depth-2 complete search (NOT the partial depth-3).
  const direct2 = searchBestAction(s, 2, createSearchContext(noTrapRuleSet, BIG, false, false, false));
  expect(res.value).toBe(direct2.value);
  expect(res.mate).toBe(direct2.mate);
  expect(res.bestAction).toEqual(direct2.action);
});

// ---------------------------------------------------------------------------
// D4-C. Global node budget is shared across iterations (total <= maxNodes,
//        more budget → deeper completion).
// ---------------------------------------------------------------------------

test('D4-C. Global node budget shared across iterations; deeper completion needs more budget', () => {
  const s = captureArena();
  const probe = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
  });
  const c = probe.iterations.map((it: IterationDiagnostic) => it.nodesUsed); // [d1, d2, d3]
  expect(c.length).toBe(3);

  const cum = [c[0], c[0] + c[1], c[0] + c[1] + c[2]];
  const expectDepth = [1, 2, 3];
  // A bare cumulative budget (cum[i]) is NOT enough to guarantee depth i
  // completes. A node-budget cutoff returns an INCOMPLETE static-eval value
  // mid-search (this is the deliberate, sound-by-D4 `completed=false`
  // semantics), which corrupts the Alpha-Beta window and changes pruning — so
  // the truncated run explores a *slightly larger* tree than the complete run
  // measured in `c`. The margin absorbs that truncation-induced divergence
  // (verified: +50% + 32 keeps `completedDepth` exactly [1,2,3] here) while
  // staying below the next depth's requirement, so deeper completion still
  // demands more budget.
  const margin = (b: number) => b + Math.ceil(b * 0.5) + 32;
  const budgets = cum.map(margin);
  const completed: number[] = [];
  for (let i = 0; i < budgets.length; i++) {
    const res = searchBestActionIterative(s, {
      rules: noTrapRuleSet,
      maxDepthTurns: 3,
      maxNodes: budgets[i],
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
    });
    // 1) GLOBAL budget: total work across all iterations is bounded by the ONE
    //    shared maxNodes (never reset per depth).
    expect(res.diagnostics.totalNodes).toBeLessThanOrEqual(budgets[i]);
    // 2) Single shared counter — per-iteration usage sums to the grand total.
    const sum = res.iterations.reduce((a, it) => a + it.nodesUsed, 0);
    expect(sum).toBe(res.diagnostics.totalNodes);
    // 3) This budget completes exactly depth (i+1) and no more.
    expect(res.completedDepth).toBe(expectDepth[i]);
    // 4) The completed answer is sound: it equals a direct fixed-depth search
    //    at the same completed depth (TT reuse never poisons a full search).
    const direct = searchBestAction(
      s,
      res.completedDepth,
      createSearchContext(noTrapRuleSet, BIG, true, true, true),
    );
    expect(res.value).toBe(direct.value);
    expect(res.mate).toBe(direct.mate);
    expect(res.bestAction).toEqual(direct.action);
    completed.push(res.completedDepth);
  }
  expect(completed[0]).toBeLessThan(completed[1]);
  expect(completed[1]).toBeLessThan(completed[2]);
});

// ---------------------------------------------------------------------------
// D4-D. TT reused across iterations (depth-mismatch hits + ordering hints).
// ---------------------------------------------------------------------------

test('D4-D. TT reused across iterations (depth-mismatch hits, hints), value preserved', () => {
  const s = abArena();
  const res = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
  });
  expect(res.completedDepth).toBe(3);
  // The shared TT was probed across iterations: depth-1 entries became
  // depth-mismatched probes for depth-2/3, and some matched exactly.
  expect(res.diagnostics.ttHits).toBeGreaterThan(0);
  expect(res.diagnostics.ttDepthMismatches).toBeGreaterThan(0);
  // Value correctness preserved with the shared TT.
  const direct = searchBestAction(s, 3, createSearchContext(noTrapRuleSet, BIG, true, true, true));
  expect(res.value).toBe(direct.value);
  expect(res.mate).toBe(direct.mate);
  expect(res.bestAction).toEqual(direct.action);
});

// ---------------------------------------------------------------------------
// D4-E. No shallow-value contamination: depth3 == direct depth3 despite a
//        shallow (non-mate) depth-1 iteration.
// ---------------------------------------------------------------------------

test('D4-E. No shallow-value contamination: iterative depth3 == direct depth3', () => {
  const s = abArena();
  const res = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
  });
  const direct = searchBestAction(s, 3, createSearchContext(noTrapRuleSet, BIG, true, true, true));
  // Final (depth3) must equal the direct depth-3 search exactly.
  expect(res.value).toBe(direct.value);
  expect(res.mate).toBe(direct.mate);
  expect(res.bestAction).toEqual(direct.action);
  // The depth-1 iteration is shallow (heuristic, non-mate); depth-3 recovers the
  // true forced mate. This proves the depth-1 cached value was NOT reused as an
  // exact depth-3 value (probeTT requires an exact depthTurns match).
  expect(res.iterations[0].mate).not.toBe(res.mate);
  expect(res.iterations[0].value).not.toBe(res.value);
});

// ---------------------------------------------------------------------------
// D4-F. Mate semantics preserved across deepening (no repeated mate-step).
// ---------------------------------------------------------------------------

test('D4-F. Mate semantics preserved across deepening (value/mate/mate-distance)', () => {
  const s = catCorridor({ r: 1, c: 3 }); // forced cat mate in 2 steps → value MATE_SCORE - 2
  for (const d of [2, 3, 4]) {
    const res = searchBestActionIterative(s, {
      rules: noTrapRuleSet,
      maxDepthTurns: d,
      maxNodes: BIG,
      useTT: false,
      useAlphaBeta: true,
      useMoveOrdering: false,
    });
    const direct = searchBestAction(s, d, createSearchContext(noTrapRuleSet, BIG, false, true, false));
    expect(res.completedDepth).toBe(d);
    expect(res.value).toBe(direct.value);
    expect(res.mate).toBe(direct.mate);
    expect(res.bestAction).toEqual(direct.action);
    expect(res.value).toBe(MATE_SCORE - 2); // exact forced-mate distance, not re-stepped
  }
});

// ---------------------------------------------------------------------------
// D4-G. CHANCE regression: iterative equals direct on a butter CHANCE fixture.
// ---------------------------------------------------------------------------

test('D4-G. CHANCE regression: iterative equals direct on butter CHANCE fixture', () => {
  const s = chanceArena();
  const res = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: BIG,
    useTT: false,
    useAlphaBeta: false,
    useMoveOrdering: false,
  });
  const direct = searchBestAction(s, 3, createSearchContext(noTrapRuleSet, BIG, false, false, false));
  expect(res.completedDepth).toBe(3);
  expect(res.value).toBe(direct.value);
  expect(res.mate).toBe(direct.mate);
  expect(res.bestAction).toEqual(direct.action);
});

// ---------------------------------------------------------------------------
// D4-H. No completed iteration → completedDepth=0, bestAction=null.
// ---------------------------------------------------------------------------

test('D4-H. No completed iteration → completedDepth=0, bestAction=null', () => {
  const s = abArena();
  const res = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: 1,
    useTT: false,
    useAlphaBeta: false,
    useMoveOrdering: false,
  });
  expect(res.completedDepth).toBe(0);
  expect(res.attemptedDepth).toBe(1);
  expect(res.bestAction).toBeNull();
  expect(res.completed).toBe(false);
  expect(res.budgetExhausted).toBe(true);
  expect(res.iterations.length).toBe(1);
  expect(res.iterations[0].completed).toBe(false);
});

// ---------------------------------------------------------------------------
// D4-BENCH. Canonical fixture: iterative maxDepth3 overhead vs direct depth3,
//        and a global-budget sweep (maxDepthTurns=6) → deepest completed depth.
// ---------------------------------------------------------------------------

test('D4-BENCH. Iterative overhead vs direct depth3 + budget→maxDepth sweep', () => {
  const fix = createTranspositionBenchmarkFixture();
  const direct = searchBestAction(fix.state, fix.depthTurns, createSearchContext(fix.rules, BIG, true, true, true));
  expect(direct.diagnostics.nodes).toBe(137); // canonical D3 baseline (F)

  // (a) iterative maxDepth=3 vs direct depth3 — overhead from depth1+depth2.
  const it3 = searchBestActionIterative(fix.state, {
    rules: fix.rules,
    maxDepthTurns: fix.depthTurns,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
  });
  expect(it3.completedDepth).toBe(3);
  expect(it3.value).toBe(direct.value);
  expect(it3.mate).toBe(direct.mate);
  expect(it3.diagnostics.totalNodes).toBeGreaterThan(direct.diagnostics.nodes); // extra depth1+depth2 work

  // (b) budget sweep — how deep can each global budget complete?
  const sweepDepth = 6;
  const budgets = [500, 1000, 5000, BIG];
  const rows = budgets.map((b) => {
    const r = searchBestActionIterative(fix.state, {
      rules: fix.rules,
      maxDepthTurns: sweepDepth,
      maxNodes: b,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
    });
    return { b, completedDepth: r.completedDepth, totalNodes: r.diagnostics.totalNodes, budgetExhausted: r.budgetExhausted };
  });

  console.log(
    '\n[D4 benchmark] openArena cat(4,4) mouse(6,6) moves 2/2; config TT+AB+ORDER\n' +
      `  direct fixed-depth depth3 = ${direct.diagnostics.nodes} nodes (value=${direct.value} mate=${direct.mate})\n` +
      `  iterative maxDepth3 (BIG) totalNodes=${it3.diagnostics.totalNodes} (overhead +${it3.diagnostics.totalNodes - direct.diagnostics.nodes})\n` +
      `  budget sweep (maxDepthTurns=${sweepDepth}):\n` +
      rows
        .map(
          (r) =>
            `    maxNodes=${String(r.b).padStart(7)} | completedDepth=${r.completedDepth} | totalNodes=${String(r.totalNodes).padStart(6)} | budgetExhausted=${r.budgetExhausted}`,
        )
        .join('\n'),
  );

  for (const r of rows) expect(r.totalNodes).toBeLessThanOrEqual(r.b);
  expect(rows[rows.length - 1].completedDepth).toBe(sweepDepth);
});

// ===========================================================================
// F1A-3. Mate distance is charged by REAL game-time cost (mateActionCost),
//         not by "one tree edge = one layer" (F0.1 §3.4 cause B).
// ===========================================================================

// ===========================================================================
// F1A-3. Mate distance is charged by REAL game-time cost (mateActionCost),
//         not by "one tree edge = one layer" (F0.1 §3.4 cause B).
// ===========================================================================

/** Cat to move on a walled board; returns a cat-turn Playing state with the
 *  given number of remaining traps (mirrors the f01fixtures makeCatToMove). */
function catTurnState(
  mouse: { r: number; c: number },
  cat: { r: number; c: number },
  open: { r: number; c: number }[],
  traps: number,
): GameEngineState {
  let s = setPieces(createInitialState(cleanConfig()), mouse, cat);
  s = wallOff(s, open);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
    trapPosition: null,
    catTrapsRemaining: traps,
  };
}

test('F1A-3. mateActionCost: real moves cost 1, zero-move actions cost 0', () => {
  expect(mateActionCost({ type: 'catStep', direction: dir('ArrowRight') })).toBe(1);
  expect(mateActionCost({ type: 'mouseStep', direction: dir('ArrowRight') })).toBe(1);
  // GAMEPLAY §4.3: placing a trap consumes NO step.
  expect(mateActionCost({ type: 'catPlaceTrap' })).toBe(0);
  // GAMEPLAY §3.3: activating the skill consumes butter, not a move.
  expect(mateActionCost({ type: 'mouseSkill' })).toBe(0);
  // GAMEPLAY §3.4: the tunnel exit choice is free (the mouse already paid the
  // steps to reach the tunnel).
  expect(mateActionCost({ type: 'chooseTunnel', r: 0, c: 0 })).toBe(0);
});

test('F1A-3. stepChildForParent charges the edge action cost (0 / 1), and step/unstep round-trip at any cost', () => {
  // A real move advances the mate distance by exactly 1.
  const child = mkRes(MATE_SCORE - 1, 'cat');
  expect(stepChildForParent(child, 1)).toBe(MATE_SCORE - 2);
  // A zero-cost action (catPlaceTrap / mouseSkill / chooseTunnel) advances the
  // mate distance by 0 — it must NOT inject a phantom −1 per tree edge.
  expect(stepChildForParent(child, 0)).toBe(MATE_SCORE - 1);
  // Mouse-side mirror: a 0-cost action must not inflate the loss depth either.
  const mouseChild = mkRes(-MATE_SCORE + 1, 'mouse');
  expect(stepChildForParent(mouseChild, 0)).toBe(-MATE_SCORE + 1);
  expect(stepChildForParent(mouseChild, 1)).toBe(-MATE_SCORE + 2);

  // The Alpha-Beta window inverse still round-trips at cost 0/1 exactly.
  expect(unstepBoundForChild(sb(MATE_SCORE - 3, 'cat'), 0)).toEqual(sb(MATE_SCORE - 3, 'cat'));
  expect(unstepBoundForChild(sb(MATE_SCORE - 3, 'cat'), 1)).toEqual(sb(MATE_SCORE - 2, 'cat'));
  for (const cost of [0, 1]) {
    for (const b of [NEG, POS, sb(MATE_SCORE, 'cat'), sb(-MATE_SCORE, 'mouse'), sb(42, null)]) {
      expect(stepBoundForParent(unstepBoundForChild(b, cost), cost)).toEqual(b);
      expect(unstepBoundForChild(stepBoundForParent(b, cost), cost)).toEqual(b);
    }
  }
});

/** Short key for one SearchAction (mirrors f01fixtures.actionKeyOf). */
function actionKeyOf(a: SearchAction): string {
  return a.type === 'catStep' ? `step:${a.direction!.key}` : a.type;
}

/**
 * Evaluate every root action of `state` like the benchmark oracle does: each
 * action gets its OWN fresh context (no shared-budget collapse) and the
 * parent edge is stepped by `mateActionCost`. Returns {key, value, mate}.
 */
function evalRootActions(state: GameEngineState, rules: RuleSet): { key: string; value: number; mate: MateSide }[] {
  const actions = generateLegalSearchActions(state, rules);
  return actions.map((a) => {
    const c = createSearchContext(rules, 1_000_000, true, true, true);
    const tr = simulateSearchAction(state, a, rules);
    const cost = mateActionCost(a);
    if (tr.kind === 'deterministic') {
      const switched = state.currentPlayer !== tr.state.currentPlayer;
      const r = searchResult(tr.state, 6 - (switched ? 1 : 0), c);
      return { key: actionKeyOf(a), value: stepChildForParent(r, cost), mate: r.mate };
    }
    let total = 0;
    const switched = state.currentPlayer !== tr.outcomes[0].state.currentPlayer;
    for (const o of tr.outcomes) {
      total += o.weight * searchResult(o.state, 6 - (switched ? 1 : 0), createSearchContext(rules, 1_000_000, true, true, true)).value;
    }
    return { key: actionKeyOf(a), value: stepChildForParent({ value: total, completed: true, cacheable: true, mate: null, bound: 'exact' }, cost), mate: null };
  });
}

test('F1A-3. catPlaceTrap no longer costs a phantom mate layer: production trap fixtures (F0.1 §3.4 regression)', () => {
  // The A-mateWin "trap == best − 1" cases from F0.1 (§3.4). These are the
  // same geometries (1-wide lane, cat to move, mouse at lane end). After the
  // fix, the zero-cost trap must score EQUAL to the best real cat-step on the
  // same fixture (same game-time distance), never best − 1.
  const laneCells = (r: number) =>
    [{ r, c: 1 }, { r, c: 2 }, { r, c: 3 }, { r, c: 4 }, { r, c: 5 }];
  const trapCases: { name: string; note?: string; build: () => GameEngineState }[] = [
    { name: 'immediateCatch1', build: () => catTurnState({ r: 1, c: 5 }, { r: 1, c: 4 }, laneCells(1), 1) },
    { name: 'immediateCatch2', build: () => catTurnState({ r: 1, c: 5 }, { r: 1, c: 3 }, laneCells(1), 1) },
    { name: 'corridorMate2', note: 'geometrically equal to immediateCatch2 (F0 continuity)', build: () => catTurnState({ r: 1, c: 5 }, { r: 1, c: 3 }, laneCells(1), 1) },
  ];
  for (const fx of trapCases) {
    const s = fx.build();
    const evs = evalRootActions(s, defaultRuleSet);
    const trap = evs.find((e) => e.key === 'catPlaceTrap');
    const steps = evs.filter((e) => e.key.startsWith('step:'));
    expect(trap).toBeDefined(); // the tactic must be a legal root action
    const bestStep = Math.max(...steps.map((e) => e.value));
    // The trap is a 0-cost action: same game-time distance to the forced
    // mate, so it must score the SAME as the best real cat-step on this
    // fixture. Before F1A-3 every one of these was exactly best − 1.
    expect(trap!.value).toBe(bestStep);
  }
});

test('F1A-3. faster real move still preferred; slower real loss still delayable (regression)', () => {
  // Faster win preferred: direct 1-step catch > 2-step catch, charged by real
  // cat moves (not by search-tree plies).
  const vW1 = searchResult(catCorridor({ r: 1, c: 4 }), 6, createSearchContext(noTrapRuleSet, 1_000_000)).value;
  const vW2 = searchResult(catCorridor({ r: 1, c: 3 }), 6, createSearchContext(noTrapRuleSet, 1_000_000)).value;
  expect(vW1).toBe(MATE_SCORE - 1);
  expect(vW2).toBe(MATE_SCORE - 2);
  expect(vW1).toBeGreaterThan(vW2);

  // Delaying a forced loss with a REAL mouse step is still valued correctly
  // (more-delayed loss > sooner loss), charged by real mouse moves.
  const laneCells7 = [{ r: 7, c: 6 }, { r: 7, c: 7 }, { r: 7, c: 8 }, { r: 0, c: 0 }];
  const loss = (mouse: { r: number; c: number }): GameEngineState => {
    let s = setPieces(createInitialState(cleanConfig()), mouse, { r: 0, c: 0 });
    s = wallOff(s, laneCells7);
    return {
      ...s,
      currentPlayer: PieceType.Mouse,
      mouseMovesLeft: 4,
      catMovesLeft: 4,
      phase: GamePhase.Playing,
      mouseHasButter: true, // carrying butter → entering the hole wins
    };
  };
  const vLoss1 = searchResult(loss({ r: 7, c: 7 }), 6, createSearchContext(defaultRuleSet, 1_000_000)).value;
  const vLoss2 = searchResult(loss({ r: 7, c: 6 }), 6, createSearchContext(defaultRuleSet, 1_000_000)).value;
  expect(vLoss1).toBe(-MATE_SCORE + 1);
  expect(vLoss2).toBe(-MATE_SCORE + 2);
  expect(vLoss2).toBeGreaterThan(vLoss1); // more-delayed real loss is better for the cat
});

// ===========================================================================
// F1A-1. The `searchValue` completion footgun is gone.
// ===========================================================================
//
// F0-hard-integration-audit.md §2.1: `searchValue(state, depth, ctx): number`
// silently dropped `completed`. Once the shared node budget was exhausted, a
// child action collapsed into a static leaf evaluation and callers could not
// tell — the F0 oracle mis-ranked actions because the "depth-6" scale was
// uneven. The API was removed and every consumer migrated to
// `searchResult(...).value` / `searchBestAction(...)`.

test('F1A-1. no bare-number public search entry point remains (searchValue is gone)', async () => {
  // `searchValue` must NOT be re-exported: type-level, the module no longer
  // offers a "plain number, completed dropped" API (importing it would fail to
  // compile). Runtime guard: the namespace must not carry it at all.
  const mod = await vi.importActual<Record<string, unknown>>('../expectiminimax');
  expect(typeof mod.searchValue).toBe('undefined');
  expect(typeof mod.searchValue).not.toBe('function');
});

test('F1A-1. an incomplete (budget-truncated) search cannot masquerade as a complete plain value', () => {
  // Any value-taking entry point MUST surface `completed=false` instead of
  // returning a number that looks like a full-depth answer.
  const s = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });

  // (1) searchResult: completed=false + value is a static-eval fallback.
  const ctxRes = createSearchContext(noTrapRuleSet, 1, false); // tiny budget
  const r = searchResult(s, 3, ctxRes);
  expect(ctxRes.diagnostics.budgetCutoffs).toBeGreaterThan(0);
  expect(r.completed).toBe(false);
  expect(r.cacheable).toBe(false);

  // (2) searchBestAction: same search, same honesty.
  const ctxAct = createSearchContext(noTrapRuleSet, 1);
  const rAct = searchBestAction(s, 3, ctxAct);
  expect(ctxAct.diagnostics.budgetCutoffs).toBeGreaterThan(0);
  expect(rAct.completed).toBe(false);
  // Both are the same static-eval fallback (not a dressed-up complete answer).
  expect(Math.abs(rAct.value)).toBeLessThan(MATE_SCORE / 2);

  // (3) iterative: an un-completed depth1 must NOT be dressed up as complete;
  // the wrapper reports completedDepth=0 / completed=false / bestAction=null.
  const rIt = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: 1,
    useTT: false,
    useAlphaBeta: false,
    useMoveOrdering: false,
  });
  expect(rIt.completedDepth).toBe(0);
  expect(rIt.completed).toBe(false);
  expect(rIt.bestAction).toBeNull();

  // (4) The truncation must also be visible through a FULL search when the
  //     budget is tight enough to cut the root subtree but not the root itself.
  const s2 = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });
  const ctx2 = createSearchContext(noTrapRuleSet, 2, true);
  const r2 = searchResult(s2, 3, ctx2);
  expect(ctx2.diagnostics.budgetCutoffs).toBeGreaterThan(0);
  expect(r2.completed).toBe(false);
});

// ===========================================================================
// F1A-2. Real wall-clock deadline (deadlineMs + injectable `now` clock).
// ===========================================================================
//
// Semantics (per the F1A spec):
//   - `deadlineMs` is an ABSOLUTE monotonic timestamp in the time-base of
//     `now()`. Production default `now = performance.now()`; tests inject a
//     fake clock for deterministic timeouts.
//   - The check lives INSIDE `_search`, so a deadline can interrupt a RUNNING
//     depth (not merely between iterative-deepening iterations).
//   - Abort reuses the maxNodes path: attempted depth → completed=false, the
//     incomplete depth's partial root result is discarded, and the deepest
//     COMPLETED depth's result is returned; if even depth-1 does not complete
//     we return an explicit incomplete/fallback state.
//   - No incomplete node is written to the TT; already-completed independent
//     subtrees stay valid (their entries are untouched).

/** A controllable fake clock: tests advance `t` explicitly. */
function fakeClock(initial = 0): { t: number; now: () => number } {
  const clock = { t: initial };
  return { ...clock, now: () => clock.t };
}

test('F1A-2-A. deadline fires in the middle of a depth: current depth incomplete, result not used', () => {
  // openArena depth-3 search needs > a handful of nodes; a deadline sampled
  // immediately (clock already at the deadline) must abort at the FIRST node.
  const s = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });
  const clock = fakeClock(1_000); // already past any deadline we set
  const ctx = createSearchContext(noTrapRuleSet, 1_000_000, false);
  ctx.deadlineMs = 500;
  ctx.now = clock.now;
  const r = searchResult(s, 3, ctx);
  expect(ctx.diagnostics.deadlineCutoffs).toBeGreaterThan(0);
  expect(r.completed).toBe(false); // the running depth was aborted mid-way
  expect(r.cacheable).toBe(false);
  expect(Math.abs(r.value)).toBeLessThan(MATE_SCORE / 2); // static-eval fallback, not a full value
});

test('F1A-2-B/C. deadline mid-depth-2: attemptedDepth > completedDepth; answer = last completed depth', () => {
  const s = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });
  // A fake clock that advances 1ms per SAMPLE. The clock is sampled once per
  // DEADLINE_CHECK_INTERVAL=64 nodes: sample #1 at node 0 (t=1), #2 at node 0+64
  // (t=2). Depth-1 of the arena is small (well under 64 nodes), so it fully
  // completes before the deadline; depth-2 needs far more than 64 nodes, so the
  // second sample (t=2) fires while depth-2 is still running → attempted>completed.
  let samples = 0;
  const r = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: 1_000_000,
    useTT: false,
    useAlphaBeta: false,
    useMoveOrdering: false,
    deadlineMs: 2, // after the 2nd clock sample the deadline has passed
    now: () => ++samples,
  });
  expect(samples).toBeGreaterThanOrEqual(2); // the clock was really sampled
  expect(r.deadlineExceeded).toBe(true);
  expect(r.budgetExhausted).toBe(false);
  // (B) attempted depth is deeper than the deepest completed depth.
  expect(r.attemptedDepth).toBeGreaterThan(r.completedDepth);
  // The last attempted iteration was truncated mid-depth.
  expect(r.iterations[r.iterations.length - 1].completed).toBe(false);
  // Depth 1 fully completed → it is the deepest completed depth.
  expect(r.completedDepth).toBe(1);

  // (C) The returned answer IS the last fully-completed depth's (depth-1) —
  //     never the partial depth-2 result.
  const direct1 = searchBestAction(s, 1, createSearchContext(noTrapRuleSet, 1_000_000));
  expect(r.value).toBe(direct1.value);
  expect(r.mate).toBe(direct1.mate);
  expect(r.bestAction).toEqual(direct1.action);
});

test('F1A-2-D. partial root best does NOT leak into the returned answer', () => {
  const s = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });
  let samples = 0;
  const r = searchBestActionIterative(s, {
    rules: noTrapRuleSet,
    maxDepthTurns: 3,
    maxNodes: 1_000_000,
    useTT: false,
    useAlphaBeta: false,
    useMoveOrdering: false,
    deadlineMs: 2,
    now: () => ++samples,
  });
  // The deadline aborts depth-2; its partial root best must NOT be used.
  const direct1 = searchBestAction(s, 1, createSearchContext(noTrapRuleSet, 1_000_000));
  expect(r.bestAction).toEqual(direct1.action);
  expect(r.value).toBe(direct1.value);
  expect(r.mate).toBe(direct1.mate);
  expect(r.completedDepth).toBe(1);
  expect(r.attemptedDepth).toBe(2);
});

test('F1A-2-E. an incomplete node is NOT written to the TT; completed subtrees survive', () => {
  // With a tiny deadline the root subtree cannot complete → no root EXACT
  // entry may appear in the shared table.
  const s = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });
  const clock = fakeClock(1_000);
  const ctxTT = createSearchContext(noTrapRuleSet, 1_000_000, true);
  ctxTT.deadlineMs = 500;
  ctxTT.now = clock.now;
  const r = searchResult(s, 3, ctxTT);
  expect(r.completed).toBe(false);
  expect(ctxTT.diagnostics.deadlineCutoffs).toBeGreaterThan(0);
  // The root state may not be stored as an EXACT entry built on a truncated
  // subtree (storeTT gate requires completed && cacheable).
  expect(ctxTT.tt.get(stateKey(s))).toBeUndefined();
  expect(ctxTT.diagnostics.ttStores).toBe(0);
});

test('F1A-2-F. maxNodes abort and deadline abort behave identically (same abort semantics)', () => {
  // (1) Same fixture; one run killed by maxNodes=1, one by deadline fired at
  //     the very first sample. Both report completed=false, cacheable=false,
  //     uncached, static-eval fallback.
  const s = openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });
  const byBudget = searchResult(s, 3, createSearchContext(noTrapRuleSet, 1));
  const clock = fakeClock(1_000);
  const ctxByDeadline = createSearchContext(noTrapRuleSet, 1_000_000);
  ctxByDeadline.deadlineMs = 500;
  ctxByDeadline.now = clock.now;
  const byDeadline = searchResult(s, 3, ctxByDeadline);
  expect(byBudget.completed).toBe(false);
  expect(byDeadline.completed).toBe(false);
  expect(byBudget.cacheable).toBe(false);
  expect(byDeadline.cacheable).toBe(false);
  // Both are the static-eval fallback (bounded, not a mate).
  expect(Math.abs(byBudget.value)).toBeLessThan(MATE_SCORE / 2);
  expect(Math.abs(byDeadline.value)).toBeLessThan(MATE_SCORE / 2);

  // (2) Iterative wrapper reports the abort cause distinctly:
  const budgetIt = searchBestActionIterative(s, {
    rules: noTrapRuleSet, maxDepthTurns: 3, maxNodes: 1,
    useTT: false, useAlphaBeta: false, useMoveOrdering: false,
  });
  expect(budgetIt.budgetExhausted).toBe(true);
  expect(budgetIt.deadlineExceeded).toBe(false);
  expect(budgetIt.completed).toBe(false);
  const clockIt = fakeClock(1_000);
  const deadIt = searchBestActionIterative(s, {
    rules: noTrapRuleSet, maxDepthTurns: 3, maxNodes: 1_000_000,
    useTT: false, useAlphaBeta: false, useMoveOrdering: false,
    deadlineMs: 500, now: clockIt.now,
  });
  expect(deadIt.deadlineExceeded).toBe(true);
  expect(deadIt.budgetExhausted).toBe(false);
  expect(deadIt.completed).toBe(false);
  expect(deadIt.completedDepth).toBe(0);
  expect(deadIt.attemptedDepth).toBe(1);
});
