import type { GameEngineState } from '../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType } from '../types';
import {
  getTunnelCorners,
  hasButterAt,
  isFixedObstacle,
  isInBounds,
  isMouseHoleCell,
  isTunnelCornerCell,
  isTunnelUsable,
} from './tunnelRules';

/**
 * RULE-A — PURE rule-layer mobility kernel.
 *
 * The single definition of "the current actor still has a truly legal SPATIAL
 * move", mirroring the real transitions exactly:
 *   - mouse: `engine.applyMouseStepCore`
 *   - cat:   `engine.catMove` (normal move, capture, trap retrieval, box push)
 *
 * It is imported by `engine.ts` (runtime) and by the engine-free Search
 * Simulator. It imports engine ONLY as `import type` (erased at compile time),
 * so `engine -> rules/mobility` stays a one-way runtime edge and no
 * `engine -> ai/legalActions` reverse dependency can form.
 *
 * Explicit non-counting actions:
 *   - `catPlaceTrap` costs no move and does not move the cat, so a trap can
 *     NEVER rescue a stranded cat.
 *   - `mouseSkill` is not a spatial move either; it matters only because
 *     consuming the carried butter unlocks tunnel entry, which is modelled
 *     explicitly by `mouseSkillUnlocksSpatialMove`.
 */

export const NO_MOVE_LOSS_MESSAGES = {
  mouseStranded: '猫获胜：老鼠已无路可走',
  catStranded: '鼠获胜：猫已无路可走',
} as const;

export type NoMoveLossVerdict = {
  phase: typeof GamePhase.CatWins | typeof GamePhase.MouseWins;
  message: string;
  reason: 'mouse_no_legal_spatial_move' | 'cat_no_legal_spatial_move';
};

/** Exact mirror of `applyMouseStepCore` target-cell legality. */
function canMouseStepTo(state: GameEngineState, nr: number, nc: number): boolean {
  if (!isInBounds(nr, nc, state.config.boardSize)) return false;
  const target = state.board[nr][nc];
  if (target.type === CellType.Box) return false;
  if (isFixedObstacle(target.type)) return false; // pile / wall
  if (target.type === CellType.Void) return false;
  if (state.catPosition.r === nr && state.catPosition.c === nc) return false;

  if (target.type === CellType.Tunnel) {
    if (!isTunnelUsable(state, nr, nc)) return false;
    // Carrying butter forbids tunnel entry (skill consumes the butter).
    if (state.mouseHasButter) return false;
    // The engine always offers "stay here", so a usable open corner is
    // enterable even when every OTHER corner is blocked.
    return true;
  }

  // Normal cell, trap step, butter pickup, and hole entry are all legal.
  return true;
}

/** Exact mirror of `catMove` target-cell legality (incl. box push). */
function canCatStepTo(state: GameEngineState, nr: number, nc: number): boolean {
  const { config } = state;
  const tunnelCorners = getTunnelCorners(config);
  if (!isInBounds(nr, nc, config.boardSize)) return false;
  if (isMouseHoleCell(nr, nc, config.mouseHole)) return false;
  if (isTunnelCornerCell(nr, nc, tunnelCorners)) return false;
  if (hasButterAt(nr, nc, state.butterPositions)) return false;

  const type = state.board[nr][nc].type;
  if (isFixedObstacle(type)) return false; // pile / wall
  if (type === CellType.Void) return false;

  if (type === CellType.Box) {
    const dr = nr - state.catPosition.r;
    const dc = nc - state.catPosition.c;
    const destR = nr + dr;
    const destC = nc + dc;
    if (!isInBounds(destR, destC, config.boardSize)) return false;
    if (isMouseHoleCell(destR, destC, config.mouseHole)) return false;
    if (state.mousePosition.r === destR && state.mousePosition.c === destC) return false;
    const destType = state.board[destR][destC].type;
    if (destType === CellType.Box) return false;
    if (isFixedObstacle(destType)) return false;
    if (destType === CellType.Void) return false;
    if (hasButterAt(destR, destC, state.butterPositions)) return false;
    if (state.trapPosition?.r === destR && state.trapPosition?.c === destC) return false;
    // NOTE: pushing a box ONTO a tunnel corner is legal (it blocks the
    // tunnel); the engine records that in blockedTunnels.
    return true;
  }

  // Empty / trap (retrieve) / mouse cell (capture) are all legal targets.
  return true;
}

export function mouseHasLegalSpatialMove(state: GameEngineState): boolean {
  for (const d of DIRECTIONS) {
    if (canMouseStepTo(state, state.mousePosition.r + d.dr, state.mousePosition.c + d.dc)) {
      return true;
    }
  }
  return false;
}

export function catHasLegalSpatialMove(state: GameEngineState): boolean {
  for (const d of DIRECTIONS) {
    if (canCatStepTo(state, state.catPosition.r + d.dr, state.catPosition.c + d.dc)) {
      return true;
    }
  }
  return false;
}

/**
 * Would activating the mouse skill (legal only while carrying butter and not
 * already active) unlock a legal spatial move? The skill consumes the butter,
 * which is what unlocks tunnel entry; extra moves alone never create a move.
 */
export function mouseSkillUnlocksSpatialMove(state: GameEngineState): boolean {
  if (!state.mouseHasButter || state.mouseSkillActive) return false;
  const afterSkill: GameEngineState = {
    ...state,
    mouseHasButter: false,
    mouseSkillActive: true,
    mouseMovesLeft: state.mouseMovesLeft + state.config.mouseSkillExtraMoves,
  };
  return mouseHasLegalSpatialMove(afterSkill);
}

/**
 * RULE-A verdict. `null` = no loss (the actor has a legal spatial action, or
 * the state is not a Playing turn with moves left — normal hand-off windows,
 * tunnel choices and terminal phases are never re-judged here).
 */
export function noMoveLossVerdict(state: GameEngineState): NoMoveLossVerdict | null {
  if (state.phase !== GamePhase.Playing) return null;

  if (state.currentPlayer === PieceType.Mouse) {
    if (state.mouseMovesLeft <= 0) return null; // normal Mouse→Cat hand-off window
    if (mouseHasLegalSpatialMove(state)) return null;
    if (mouseSkillUnlocksSpatialMove(state)) return null;
    return {
      phase: GamePhase.CatWins,
      message: NO_MOVE_LOSS_MESSAGES.mouseStranded,
      reason: 'mouse_no_legal_spatial_move',
    };
  }

  if (state.catMovesLeft <= 0) return null; // normal Cat→Mouse hand-off window
  if (catHasLegalSpatialMove(state)) return null;
  return {
    phase: GamePhase.MouseWins,
    message: NO_MOVE_LOSS_MESSAGES.catStranded,
    reason: 'cat_no_legal_spatial_move',
  };
}

/**
 * Pure application: returns the SAME reference when no verdict fires, so the
 * check is idempotent and safe to call at every formal boundary.
 */
export function applyNoMoveLoss(state: GameEngineState): GameEngineState {
  const verdict = noMoveLossVerdict(state);
  if (!verdict) return state;
  return { ...state, phase: verdict.phase, message: verdict.message };
}
