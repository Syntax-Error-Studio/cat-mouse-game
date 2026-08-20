/**
 * F0.1 shared fixture / helper module (MEASUREMENT ONLY — nothing in src/ is
 * modified). Imported by f01bench.mts and the focused probes so the fixture
 * geometry has exactly ONE definition.
 */
import { createInitialState, type GameEngineState } from './src/game/engine';
import type { GameConfig } from './src/game/config';
import { GamePhase, PieceType, CellType, DIRECTIONS, type Direction } from './src/game/types';
import { defaultRuleSet } from './src/game/ai/searchRules';
import type { RuleSet } from './src/game/ai/searchTypes';

export type P = { r: number; c: number };

export function cleanConfig(overrides: Partial<GameConfig> = {}): GameConfig {
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
      { r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 },
    ],
    ...overrides,
  };
}

export function setPieces(state: GameEngineState, mouse: P, cat?: P): GameEngineState {
  const board = state.board.map((row) => row.map((cell) => ({ ...cell, piece: undefined })));
  board[mouse.r][mouse.c] = { ...board[mouse.r][mouse.c], piece: PieceType.Mouse };
  if (cat) board[cat.r][cat.c] = { ...board[cat.r][cat.c], piece: PieceType.Cat };
  const patch: Partial<GameEngineState> = { board, mousePosition: { ...mouse } };
  if (cat) patch.catPosition = { ...cat };
  return { ...state, ...patch };
}

export function wallOff(state: GameEngineState, open: P[]): GameEngineState {
  const openSet = new Set(open.map((p) => `${p.r},${p.c}`));
  const board = state.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) return cell;
      if (openSet.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

export const noTrapRuleSet: RuleSet = { ...defaultRuleSet, catPlaceTrap: (st) => st };

export type TurnOpts = {
  traps: number;
  catMovesLeft?: number;
  mouseMovesLeft?: number;
  hasButter?: boolean;
  skillAvailable?: boolean;
};

export function makeCatToMove(base: GameEngineState, o: TurnOpts): GameEngineState {
  const s: GameEngineState = {
    ...base,
    currentPlayer: PieceType.Cat,
    catMovesLeft: o.catMovesLeft ?? 4,
    mouseMovesLeft: o.mouseMovesLeft ?? 4,
    phase: GamePhase.Playing,
    mouseHasButter: o.hasButter ?? false,
    mouseSkillActive: false,
    butterPositions: [],
    trapPosition: null,
    catTrapsRemaining: o.traps,
  };
  if (o.skillAvailable !== undefined) {
    return { ...s, mouseSkillAvailable: o.skillAvailable } as GameEngineState;
  }
  return s;
}

// --- Ring corridor family (CORRECTED temporary-retreat geometry) ------------
export const ROW_TOP = 2, ROW_BOT = 4, COL_L = 2, COL_R = 6;
export const RING_HOLE: P = { r: ROW_TOP, c: COL_L - 1 };

export function ringCells(): P[] {
  const out: P[] = [];
  for (let c = COL_L; c <= COL_R; c++) out.push({ r: ROW_TOP, c });
  out.push({ r: 3, c: COL_R });
  for (let c = COL_R; c >= COL_L; c--) out.push({ r: ROW_BOT, c });
  out.push({ r: 3, c: COL_L });
  return out;
}

export function buildRing(cat: P, mouse: P, o: TurnOpts): GameEngineState {
  let s = createInitialState(cleanConfig({ mouseHole: { ...RING_HOLE, size: 1 } }));
  s = setPieces(s, mouse, cat);
  s = wallOff(s, ringCells());
  return makeCatToMove(s, o);
}

// --- Two-lane hole-mouth family (Trap Value geometry) ----------------------
// Hole (3,8) size 2 covers rows 3..4 / cols 8..9 => TWO gate cells (3,7),(4,7).
// The cat body can seal only one of them.
export function twoLaneCells(): P[] {
  const open: P[] = [];
  for (let c = 1; c <= 7; c++) { open.push({ r: 3, c }); open.push({ r: 4, c }); }
  return open;
}

export function buildTwoLane(cat: P, mouse: P, o: TurnOpts): GameEngineState {
  let s = createInitialState(cleanConfig({ mouseHole: { r: 3, c: 8, size: 2 } }));
  s = setPieces(s, mouse, cat);
  s = wallOff(s, twoLaneCells());
  return makeCatToMove(s, o);
}

// ---------------------------------------------------------------------------
export type Fixture = {
  name: string;
  category: string;
  note?: string;
  /** true => the fixture claims "oracle-best action increases cat<->mouse distance" */
  retreatClaim?: boolean;
  build: (traps: number) => GameEngineState;
};

export const TRAP_CAT: P = { r: 3, c: 7 };
export const TRAP_MOUSE: P = { r: 4, c: 3 };

export const fixtures: Fixture[] = [
  {
    name: 'immediateCatch1', category: 'Immediate Catch',
    build: (t) => {
      let s = createInitialState(cleanConfig());
      s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 4 });
      s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
      return makeCatToMove(s, { traps: t });
    },
  },
  {
    name: 'immediateCatch2', category: 'Immediate Catch',
    build: (t) => {
      let s = createInitialState(cleanConfig());
      s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 3 });
      s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
      return makeCatToMove(s, { traps: t });
    },
  },
  {
    name: 'corridorMate2', category: 'Immediate Catch',
    note: 'geometrically identical to immediateCatch2 (kept for F0 continuity)',
    build: (t) => {
      let s = createInitialState(cleanConfig());
      s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 3 });
      s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
      return makeCatToMove(s, { traps: t });
    },
  },
  {
    name: 'openChase', category: 'Midgame',
    build: (t) => {
      let s = createInitialState(cleanConfig());
      s = setPieces(s, { r: 6, c: 6 }, { r: 4, c: 4 });
      const open: P[] = [];
      for (let r = 4; r <= 6; r++) for (let c = 4; c <= 6; c++) open.push({ r, c });
      s = wallOff(s, open);
      return makeCatToMove(s, { traps: t });
    },
  },
  {
    name: 'emergencyHoleDefense', category: 'Emergency Hole Defense',
    build: (t) => {
      let s = createInitialState(cleanConfig());
      s = setPieces(s, { r: 7, c: 7 }, { r: 7, c: 5 });
      s = wallOff(s, [
        { r: 7, c: 5 }, { r: 7, c: 6 }, { r: 7, c: 7 }, { r: 7, c: 8 },
        { r: 6, c: 6 },
      ]);
      return makeCatToMove(s, { traps: t });
    },
  },
  {
    name: 'temporaryRetreat_v1_INVALID', category: 'Temporary Retreat',
    note: 'F0 fixture. Oracle best = ArrowLeft, which DECREASES cat<->mouse distance => not a retreat.',
    retreatClaim: true,
    build: (t) => {
      let s = createInitialState(cleanConfig({ mouseHole: { r: 4, c: 8, size: 2 } }));
      s = setPieces(s, { r: 4, c: 4 }, { r: 4, c: 6 });
      const open: P[] = [];
      for (let c = 4; c <= 8; c++) { open.push({ r: 4, c }); open.push({ r: 5, c }); }
      s = wallOff(s, open);
      return makeCatToMove(s, { traps: t });
    },
  },
  {
    name: 'temporaryRetreat_v2', category: 'Temporary Retreat',
    note: 'Ring corridor; 1x1 hole (2,1) whose ONLY gate is (2,2). cat(4,3) mouse(2,4) mouseHasButter. '
        + 'Best = ArrowLeft (dist 3->4, AWAY from the mouse, toward the gate); greedy ArrowRight (dist 3->2) is a PROVEN LOSS.',
    retreatClaim: true,
    build: (t) => buildRing({ r: 4, c: 3 }, { r: 2, c: 4 }, { traps: t, hasButter: true, mouseMovesLeft: 3 }),
  },
  {
    name: 'boxBlock', category: 'Box Block',
    build: (t) => {
      let s = createInitialState(cleanConfig({ boxCount: 1 }));
      s = setPieces(s, { r: 7, c: 7 }, { r: 7, c: 5 });
      s = wallOff(s, [
        { r: 7, c: 4 }, { r: 7, c: 5 }, { r: 7, c: 6 }, { r: 7, c: 7 }, { r: 7, c: 8 },
      ]);
      s = { ...s, board: s.board.map((row, r) => row.map((cell, c) => (r === 7 && c === 6 ? { ...cell, type: CellType.Box } : cell))) };
      return makeCatToMove(s, { traps: t });
    },
  },
  {
    name: 'skillThreat', category: 'Skill Threat',
    build: (t) => {
      let s = createInitialState(cleanConfig());
      s = setPieces(s, { r: 7, c: 5 }, { r: 7, c: 3 });
      s = wallOff(s, [
        { r: 7, c: 3 }, { r: 7, c: 4 }, { r: 7, c: 5 }, { r: 7, c: 6 }, { r: 7, c: 7 }, { r: 7, c: 8 },
      ]);
      return makeCatToMove(s, { traps: t, skillAvailable: true });
    },
  },
  {
    name: 'tunnelThreat', category: 'Tunnel Threat',
    build: (t) => {
      let s = createInitialState(cleanConfig());
      s = setPieces(s, { r: 0, c: 1 }, { r: 0, c: 3 });
      s = wallOff(s, [
        { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 },
        { r: 1, c: 0 }, { r: 1, c: 1 },
      ]);
      return makeCatToMove(s, { traps: t });
    },
  },
  {
    name: 'midgameOpen', category: 'Midgame',
    build: (t) => {
      let s = createInitialState(cleanConfig());
      s = setPieces(s, { r: 5, c: 5 }, { r: 2, c: 2 });
      const open: P[] = [];
      for (let r = 2; r <= 7; r++) for (let c = 2; c <= 7; c++) open.push({ r, c });
      s = wallOff(s, open);
      return makeCatToMove(s, { traps: t });
    },
  },
  {
    name: 'trapValue', category: 'Trap Value',
    note: `Two-lane corridor; hole (3,8) size 2 => TWO gate cells (3,7)+(4,7), so the cat BODY can seal only one. `
        + `cat(${TRAP_CAT.r},${TRAP_CAT.c}) sits on gate A, mouse(${TRAP_MOUSE.r},${TRAP_MOUSE.c}).`,
    build: (t) => buildTwoLane(TRAP_CAT, TRAP_MOUSE, { traps: t }),
  },
];

// --- action identity -------------------------------------------------------
export function actionKeyOf(a: { type: string; direction?: Direction }): string {
  if (a.type === 'catStep') return `step:${a.direction!.key}`;
  return a.type;
}

export function dirOfDelta(from: P, to: P): string | null {
  const d = DIRECTIONS.find((x) => x.dr === to.r - from.r && x.dc === to.c - from.c);
  return d ? d.key : null;
}

export const manhattan = (a: P, b: P) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
