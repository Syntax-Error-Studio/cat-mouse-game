import type { GameEngineState } from '../engine';
import { GamePhase, PieceType } from '../types';

/**
 * Shared rule kernel: apply a chosen tunnel exit.
 *
 * This is the SINGLE implementation of the tunnel-exit landing transition.
 * It was previously duplicated inline in `GamePage` and `TutorialPage`; the
 * future Search Simulator also calls it, so the search operates on the exact
 * same rules the real game uses (no simplified "fake" tunnel logic).
 *
 * Contract:
 *  - Only valid when `phase === ChoosingTunnelExit` and `(r, c)` is one of
 *    `tunnelExitChoices` (the exits were already validated by `mouseMove`).
 *  - Performs ONLY the teleport: clears the entrance cell, moves the mouse to
 *    `(r, c)`, zeroes `mouseMovesLeft`, clears `tunnelExitChoices`, and sets
 *    `phase = Playing` with `currentPlayer` still Mouse.
 *  - Does NOT call `endTurn`. The caller (UI or simulator) ends the turn
 *    afterwards. This keeps "tunnel exit selection" as a continuation of the
 *    mouse's current action — the action right only changes at `endTurn`
 *    (see Phase B depthTurns semantics), not at exit selection.
 *  - Pure: returns a new state and never mutates the input.
 *  - No-op: returns the SAME reference when the choice is invalid or the phase
 *    is wrong, so callers can detect "nothing happened" via `===`.
 */
export function chooseTunnelExit(
  state: GameEngineState,
  r: number,
  c: number,
): GameEngineState {
  if (state.phase !== GamePhase.ChoosingTunnelExit) return state;
  const choices = state.tunnelExitChoices || [];
  const isValid = choices.some((t) => t.r === r && t.c === c);
  if (!isValid) return state;

  const board = state.board.map((row) => row.map((cell) => ({ ...cell })));
  const entrance = state.mousePosition;
  board[entrance.r][entrance.c] = { ...board[entrance.r][entrance.c], piece: undefined };
  board[r][c] = { ...board[r][c], piece: PieceType.Mouse };

  return {
    ...state,
    board,
    blockedTunnels: state.blockedTunnels,
    mousePosition: { r, c },
    mouseMovesLeft: 0,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Mouse,
    tunnelExitChoices: [],
  };
}
