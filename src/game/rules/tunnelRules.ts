import type { GameEngineState } from '../engine';
import type { GameConfig } from '../config';
import { CellType, makeTunnelCorners, type TunnelCorner } from '../types';

/**
 * SHARED TUNNEL GEOMETRY KERNEL (Phase E1).
 *
 * The single implementation of tunnel *geometry* facts:
 *   - corner resolution (custom corners, else board corners)
 *   - usable / blocked / open corner predicates
 *   - the exit-set computation (mirror of engine.applyMouseStepCore)
 *   - mouse-hole cells + gate cells (mirror of engine.getMouseHoleGateCells)
 *
 * engine.ts, the Search Simulator and the evaluator (evaluation.ts) all read
 * these so no third copy of tunnel logic can ever drift. `tunnels.ts` in this
 * directory remains the *transition* kernel (chooseTunnelExit); this module is
 * the *geometry* kernel.
 *
 * This module imports ONLY types from engine.ts (erased at compile time), so
 * it never creates a runtime cycle: engine.ts imports this module at runtime
 * (one direction), this module never imports engine.ts at runtime.
 */

export type Point = { r: number; c: number };

/**
 * Resolve tunnel corners: custom map corners if provided, else the 4 board
 * corners. Empty array means "no tunnels". (Engine.getTunnelCorners delegates
 * here so runtime + evaluator + simulator share one resolution.)
 */
export function getTunnelCorners(config: GameConfig): TunnelCorner[] {
  if (config.tunnelCorners && config.tunnelCorners.length > 0) {
    return config.tunnelCorners.map((t) => ({ r: t.r, c: t.c, label: t.label ?? '' }));
  }
  return makeTunnelCorners(config.boardSize);
}

export function isTunnelCornerCell(r: number, c: number, corners: { r: number; c: number }[]): boolean {
  return corners.some((t) => t.r === r && t.c === c);
}

export function isInBounds(r: number, c: number, boardSize: number): boolean {
  return r >= 0 && r < boardSize && c >= 0 && c < boardSize;
}

/** Fixed obstacles: piles and walls — neither walkable nor pushable. */
export function isFixedObstacle(type: CellType): boolean {
  return type === CellType.Pile || type === CellType.Wall;
}

export function hasButterAt(r: number, c: number, butters: Point[]): boolean {
  return butters.some((b) => b.r === r && b.c === c);
}

export function isMouseHoleCell(r: number, c: number, hole: { r: number; c: number; size: number }): boolean {
  return r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;
}

/**
 * Is a tunnel corner currently usable as entrance / exit?
 * A corner is blocked when a box sits on it OR it is in `blockedTunnels`
 * (the engine records both when a box is pushed onto a corner).
 */
export function isTunnelUsable(state: GameEngineState, r: number, c: number): boolean {
  if (state.board[r][c].type === CellType.Box) return false;
  return !state.blockedTunnels.some((t) => t.r === r && t.c === c);
}

/** All tunnel corners that are currently usable (open). */
export function getOpenTunnelCorners(state: GameEngineState): TunnelCorner[] {
  return getTunnelCorners(state.config).filter((t) => isTunnelUsable(state, t.r, t.c));
}

/**
 * Can the mouse legally ENTER a tunnel in the current state?
 * GAMEPLAY (mirrors engine.applyMouseStepCore): carrying butter forbids entry.
 * Skill activation consumes the butter, so `!mouseHasButter` is the full rule.
 */
export function isMouseTunnelEntryAllowed(state: GameEngineState): boolean {
  return !state.mouseHasButter;
}

const ARROW_MAP: Record<string, string> = {
  左上: '↘', 右上: '↙', 左下: '↗', 右下: '↖',
};

/**
 * Exit set for a tunnel entrance — mirror of engine.applyMouseStepCore:
 * every other open corner (not blocked, no box), label from the arrow map.
 * The engine additionally prepends the "stay here" option; callers decide
 * whether to include it (the evaluator's teleport graph does not model the
 * stay edge, mirroring the search simulator).
 */
export function getTunnelExits(
  state: GameEngineState,
  entranceR: number,
  entranceC: number,
): { r: number; c: number; label: string }[] {
  const exits: { r: number; c: number; label: string }[] = [];
  for (const corner of getTunnelCorners(state.config)) {
    if (corner.r === entranceR && corner.c === entranceC) continue;
    if (!isTunnelUsable(state, corner.r, corner.c)) continue;
    exits.push({ r: corner.r, c: corner.c, label: ARROW_MAP[corner.label] || corner.label });
  }
  return exits;
}

/** All cells of the mouse hole (supports 2x2; generic over size). */
export function getMouseHoleCells(config: GameConfig): Point[] {
  const cells: Point[] = [];
  for (let dr = 0; dr < config.mouseHole.size; dr++) {
    for (let dc = 0; dc < config.mouseHole.size; dc++) {
      cells.push({ r: config.mouseHole.r + dr, c: config.mouseHole.c + dc });
    }
  }
  return cells;
}

/**
 * Legal cells adjacent to the mouse hole — safe ambush/guard points.
 * Exact mirror of engine.getMouseHoleGateCells (which now delegates here):
 * excludes hole cells, tunnel corners, blocked tunnels, boxes, fixed
 * obstacles, and butter cells.
 */
export function getMouseHoleGateCells(state: GameEngineState): Point[] {
  const { config, board } = state;
  const corners = getTunnelCorners(config);
  const holeCells = getMouseHoleCells(config);
  const result: Point[] = [];
  const seen = new Set<string>();
  for (const hc of holeCells) {
    for (const d of [
      { dr: -1, dc: 0 }, { dr: 1, dc: 0 }, { dr: 0, dc: -1 }, { dr: 0, dc: 1 },
    ]) {
      const r = hc.r + d.dr;
      const c = hc.c + d.dc;
      if (!isInBounds(r, c, config.boardSize)) continue;
      if (isMouseHoleCell(r, c, config.mouseHole)) continue;
      if (isTunnelCornerCell(r, c, corners)) continue;
      if (state.blockedTunnels.some((t) => t.r === r && t.c === c)) continue;
      if (board[r][c].type === CellType.Box) continue;
      if (isFixedObstacle(board[r][c].type)) continue;
      if (hasButterAt(r, c, state.butterPositions)) continue;
      const k = `${r},${c}`;
      if (seen.has(k)) continue;
      seen.add(k);
      result.push({ r, c });
    }
  }
  return result;
}
