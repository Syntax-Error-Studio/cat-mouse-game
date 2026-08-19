import { describe, it, expect } from 'vitest';
import { createInitialState, endTurn } from '../../engine';
import { GamePhase, PieceType } from '../../types';
import { chooseTunnelExit } from '../tunnels';
import type { GameEngineState } from '../../engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a realistic "ChoosingTunnelExit" state by taking a real initial state
// (so every field is valid) and overriding only the fields that describe
// "mouse is sitting at a tunnel entrance, choosing an exit".
function makeChoosingState(exitR: number, exitC: number): GameEngineState {
  const s = createInitialState();
  const entrance = { r: 0, c: 0 };
  const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
  board[entrance.r][entrance.c] = { ...board[entrance.r][entrance.c], piece: PieceType.Mouse };
  return {
    ...s,
    board,
    phase: GamePhase.ChoosingTunnelExit,
    currentPlayer: PieceType.Mouse,
    mousePosition: entrance,
    mouseMovesLeft: 0,
    tunnelExitChoices: [
      { r: exitR, c: exitC, label: '↘' },
      { r: entrance.r, c: entrance.c, label: '↺ 原地' },
    ],
  };
}

// Reference implementation = the OLD inline UI logic (teleport + endTurn),
// kept here ONLY to prove the shared kernel is behavior-preserving.
function referenceChooseTunnelExit(state: GameEngineState, r: number, c: number): GameEngineState {
  if (state.phase !== GamePhase.ChoosingTunnelExit) return state;
  const valid = (state.tunnelExitChoices || []).some((t) => t.r === r && t.c === c);
  if (!valid) return state;
  const nb = state.board.map((row) => row.map((cell) => ({ ...cell })));
  nb[state.mousePosition.r][state.mousePosition.c] = {
    ...nb[state.mousePosition.r][state.mousePosition.c],
    piece: undefined,
  };
  nb[r][c] = { ...nb[r][c], piece: PieceType.Mouse };
  const after = {
    ...state,
    board: nb,
    mousePosition: { r, c },
    mouseMovesLeft: 0,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Mouse,
    tunnelExitChoices: [],
  };
  return endTurn(after);
}

// Fields that actually define the game and affect subsequent transitions.
// Deliberately EXCLUDES message / catActionLog / gameEventLog (UI/debug only).
function comparedFields(s: GameEngineState) {
  return {
    board: s.board,
    catPosition: s.catPosition,
    mousePosition: s.mousePosition,
    catMovesLeft: s.catMovesLeft,
    mouseMovesLeft: s.mouseMovesLeft,
    butterPositions: s.butterPositions,
    mouseHasButter: s.mouseHasButter,
    mouseSkillActive: s.mouseSkillActive,
    trapPosition: s.trapPosition,
    catTrapsRemaining: s.catTrapsRemaining,
    blockedTunnels: s.blockedTunnels,
    currentPlayer: s.currentPlayer,
    phase: s.phase,
    tunnelExitChoices: s.tunnelExitChoices,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chooseTunnelExit — shared rule kernel', () => {
  it('matches the old inline UI logic exactly (behavior-preserving refactor)', () => {
    const exit = { r: 9, c: 9 };
    const state = makeChoosingState(exit.r, exit.c);

    const shared = endTurn(chooseTunnelExit(state, exit.r, exit.c));
    const reference = referenceChooseTunnelExit(state, exit.r, exit.c);

    expect(comparedFields(shared)).toEqual(comparedFields(reference));
  });

  it('teleports the mouse: clears entrance, lands on chosen exit, zeroes moves', () => {
    const exit = { r: 9, c: 9 };
    const state = makeChoosingState(exit.r, exit.c);
    const result = chooseTunnelExit(state, exit.r, exit.c);

    expect(result.board[state.mousePosition.r][state.mousePosition.c].piece).toBeUndefined();
    expect(result.board[exit.r][exit.c].piece).toBe(PieceType.Mouse);
    expect(result.mousePosition).toEqual(exit);
    expect(result.mouseMovesLeft).toBe(0);
    expect(result.phase).toBe(GamePhase.Playing);
    expect(result.currentPlayer).toBe(PieceType.Mouse);
    expect(result.tunnelExitChoices).toEqual([]);
  });

  it('does not end the turn itself — currentPlayer is still Mouse until endTurn', () => {
    const exit = { r: 9, c: 9 };
    const state = makeChoosingState(exit.r, exit.c);
    const tel = chooseTunnelExit(state, exit.r, exit.c);
    // Action right has NOT changed yet (ChoosingTunnelExit is part of mouse's action).
    expect(tel.currentPlayer).toBe(PieceType.Mouse);
    // The caller (UI / simulator) applies endTurn, which flips to Cat.
    expect(endTurn(tel).currentPlayer).toBe(PieceType.Cat);
  });

  it('is a no-op (same reference, no mutation) for an invalid choice', () => {
    const exit = { r: 9, c: 9 };
    const state = makeChoosingState(exit.r, exit.c);
    const bad = chooseTunnelExit(state, 5, 5); // (5,5) is not in tunnelExitChoices
    expect(bad).toBe(state);
  });

  it('is a no-op (same reference) when not in ChoosingTunnelExit phase', () => {
    const exit = { r: 9, c: 9 };
    const s = createInitialState();
    const bad = chooseTunnelExit(s, exit.r, exit.c);
    expect(bad).toBe(s);
  });

  it('supports the "原地" (stay) option without moving the mouse', () => {
    const state = makeChoosingState(9, 9); // choices: real exit + stay(0,0)
    const stay = { r: 0, c: 0 };
    const result = chooseTunnelExit(state, stay.r, stay.c);
    expect(result.board[0][0].piece).toBe(PieceType.Mouse);
    expect(result.mousePosition).toEqual(stay);
    expect(result.tunnelExitChoices).toEqual([]);
  });
});
