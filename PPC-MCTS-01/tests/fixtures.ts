import { createInitialState, type GameEngineState } from '../../src/game/engine';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/game/config';
import { CellType, GamePhase, PieceType } from '../../src/game/types';

export type Pt = { r: number; c: number };

export interface ControlledOptions {
  cat: Pt;
  mouse: Pt;
  butters?: Pt[];
  boxes?: Pt[];
  walls?: Pt[];
  trap?: Pt;
  pending?: { r: number; c: number; blockedMaterializations?: number }[];
  debt?: number;
  catMoves?: number;
  mouseMoves?: number;
  player?: PieceType;
  mouseHasButter?: boolean;
  mouseSkillActive?: boolean;
  catTrapsRemaining?: number;
  mouseHole?: { r: number; c: number; size: number };
}

/**
 * Deterministic controlled state: explicit terrain/butter/box positions, then
 * pieces and rule fields set directly. Terrain still comes from the real
 * `createInitialState`; nothing here re-implements a rule.
 */
export function controlled(o: ControlledOptions): GameEngineState {
  const butters = o.butters ?? [];
  const boxes = o.boxes ?? [];
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    catStart: o.cat,
    mouseStart: o.mouse,
    boxCount: boxes.length,
    boxPositions: boxes,
    pileCount: 0,
    pilePositions: [],
    butterCount: butters.length,
    butterPositions: butters,
    ...(o.mouseHole ? { mouseHole: o.mouseHole } : {}),
  };
  const base = createInitialState(config);
  let board = base.board.map((row) =>
    row.map((cell) => ({ ...cell, piece: undefined as PieceType | undefined, hasButter: false })),
  );
  for (const p of o.walls ?? []) {
    board[p.r][p.c] = { type: CellType.Wall, piece: undefined, hasButter: false };
  }
  for (const p of boxes) {
    board[p.r][p.c] = { type: CellType.Box, piece: undefined, hasButter: false };
  }
  board[o.cat.r][o.cat.c] = { ...board[o.cat.r][o.cat.c], type: CellType.Empty, piece: PieceType.Cat };
  board[o.mouse.r][o.mouse.c] = { ...board[o.mouse.r][o.mouse.c], type: CellType.Empty, piece: PieceType.Mouse };
  return {
    ...base,
    board,
    phase: GamePhase.Playing,
    currentPlayer: o.player ?? PieceType.Cat,
    catPosition: { ...o.cat },
    mousePosition: { ...o.mouse },
    catMovesLeft: o.catMoves ?? config.catBaseMoves,
    mouseMovesLeft: o.mouseMoves ?? config.mouseBaseMoves,
    butterPositions: butters.map((p) => ({ ...p })),
    mouseHasButter: o.mouseHasButter ?? false,
    mouseSkillActive: o.mouseSkillActive ?? false,
    pendingButterSpawns: (o.pending ?? []).map((g) => ({
      r: g.r, c: g.c, blockedMaterializations: g.blockedMaterializations ?? 0,
    })),
    pendingButterPlacementDebt: o.debt ?? 0,
    trapPosition: o.trap ? { ...o.trap } : null,
    catTrapsRemaining: o.catTrapsRemaining ?? 1,
    blockedTunnels: [],
    tunnelExitChoices: [],
    message: '',
  };
}

/** All cells except `open` become walls; tunnel corners and the mouse hole keep
 *  their real terrain so geometry stays valid. */
export function wallOff(state: GameEngineState, open: Pt[]): GameEngineState {
  const keep = new Set(open.map((p) => `${p.r},${p.c}`));
  const board = state.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.Tunnel || cell.type === CellType.MouseHole) return cell;
      if (keep.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

export const RIGHT = { key: 'ArrowRight', dr: 0, dc: 1, label: '→' } as const;
export const LEFT = { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } as const;
