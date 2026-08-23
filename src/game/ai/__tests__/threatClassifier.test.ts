import { describe, it, expect } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState } from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import { classifyGoalThreat } from '../threatClassifier';

// ---------------------------------------------------------------------------
// Helpers (mirrors hardIntegration.test.ts patterns)
// ---------------------------------------------------------------------------

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
      { r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 },
    ],
    ...overrides,
  };
}

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
  const patch: Partial<GameEngineState> = { board, mousePosition: { ...mouse } };
  if (cat) patch.catPosition = { ...cat };
  return { ...state, ...patch };
}

function wallOff(state: GameEngineState, open: { r: number; c: number }[]): GameEngineState {
  const openSet = new Set(open.map((p) => `${p.r},${p.c}`));
  const board: GameEngineState['board'] = state.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) return cell;
      if (openSet.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

function clearButter(state: GameEngineState): GameEngineState {
  const board = state.board.map((row) => row.map((cell) => ({ ...cell, hasButter: false })));
  return { ...state, board, butterPositions: [], mouseHasButter: false, mouseSkillActive: false };
}

// ===========================================================================
// B-1: Threat classifier — mouse carrying butter near hole → critical
// ===========================================================================

describe('B-1: threat classifier — carrying butter near hole', () => {
  it('classifies as critical when mouse carries butter and is within 1 turn of hole', () => {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    // Mouse at (7,7) — adjacent to hole at (7,8)/(7,9)/(8,8)/(8,9).
    // Carrying mode = 3 moves. Distance to hole = 1 ≤ 3 → critical.
    s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 7, c: 7 }, { r: 1, c: 1 }]);
    s = { ...s, mouseHasButter: true, currentPlayer: PieceType.Cat, phase: GamePhase.Playing };

    const threat = classifyGoalThreat(s);
    expect(threat.mouseHasButter).toBe(true);
    expect(threat.winRoute).not.toBeNull();
    expect(threat.winRoute).toBeLessThanOrEqual(3);
    expect(threat.urgency).toBe('critical');
  });

  it('classifies as near when mouse carries butter and is ~2 turns from hole', () => {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    // Mouse at (7,5) — distance to hole (7,8) is 3 steps.
    // carryingMoves=3, so 3 ≤ 3 → critical, not near.
    // Move mouse to (7,4) — distance 4. 4 > 3 but 4 ≤ 6 → near.
    s = setPieces(s, { r: 7, c: 4 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 7, c: 4 }, { r: 7, c: 5 }, { r: 7, c: 6 }, { r: 7, c: 7 }, { r: 1, c: 1 }]);
    s = { ...s, mouseHasButter: true, currentPlayer: PieceType.Cat, phase: GamePhase.Playing };

    const threat = classifyGoalThreat(s);
    expect(threat.mouseHasButter).toBe(true);
    expect(threat.winRoute).toBe(4);
    expect(threat.urgency).toBe('near');
  });
});

// ===========================================================================
// B-2: No butter → no threat extension
// ===========================================================================

describe('B-2: threat classifier — no butter', () => {
  it('classifies as none when mouse does not carry butter', () => {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 7, c: 7 }, { r: 1, c: 1 }]);
    s = { ...s, mouseHasButter: false, currentPlayer: PieceType.Cat, phase: GamePhase.Playing };

    const threat = classifyGoalThreat(s);
    expect(threat.mouseHasButter).toBe(false);
    expect(threat.winRoute).toBeNull();
    expect(threat.urgency).toBe('none');
  });

  it('classifies as none even when mouse is adjacent to hole without butter', () => {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    // Mouse RIGHT next to hole but no butter.
    s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 7, c: 7 }, { r: 1, c: 1 }]);
    s = { ...s, mouseHasButter: false, currentPlayer: PieceType.Cat, phase: GamePhase.Playing };

    const threat = classifyGoalThreat(s);
    expect(threat.urgency).toBe('none');
  });
});

// ===========================================================================
// B-3: Blocked route — cannot use Manhattan to fake critical
// ===========================================================================

describe('B-3: threat classifier — blocked route', () => {
  it('classifies as none when carrying butter but route to hole is blocked', () => {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    // Mouse at (7,7), carrying butter, but wall off ALL paths to the hole.
    // Hole is at (7,8)-(8,9). Surround the hole with walls except from far away.
    s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 });
    // Wall off the direct path: (7,7) → (7,8) is blocked by a wall at (7,8) area.
    // Actually, hole cells are (7,8),(7,9),(8,8),(8,9). The mouse at (7,7) can
    // go to (7,8) normally. Block it:
    s = wallOff(s, [{ r: 7, c: 7 }, { r: 1, c: 1 }]);
    // Now add a wall between mouse and hole — wall the entire column 7→8 gap.
    // The mouse is at (7,7). To reach the hole it needs (7,8) or (6,7)→(6,8)→(7,8) etc.
    // Wall off (7,8) is a hole cell — can't wall it.
    // Instead, wall off a ring around the mouse so it can't reach the hole.
    const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
    // Block all 4 orthogonal neighbors of (7,7)
    board[6][7] = { ...board[6][7], type: CellType.Wall };
    board[8][7] = { ...board[8][7], type: CellType.Wall };
    // (7,6) and (7,8) — (7,8) is a hole cell, don't wall it.
    // So (7,8) is reachable → the mouse CAN reach the hole.
    // Let's instead wall (7,8) by making the hole unreachable from the mouse.
    // Actually we can't wall a hole cell. Let's put the mouse far from hole and
    // wall the corridor.
    s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 3 }, { r: 1, c: 1 });
    // Open only (7,3) for the mouse. Wall everything else in row 7 except hole.
    // Wall the corridor at (7,4),(7,5),(7,6),(7,7) — fully blocking the path.
    s = wallOff(s, [{ r: 7, c: 3 }, { r: 1, c: 1 }]);
    // Now explicitly wall the path cells:
    const b2 = s.board.map((row) => row.map((cell) => ({ ...cell })));
    b2[7][4] = { ...b2[7][4], type: CellType.Wall };
    b2[7][5] = { ...b2[7][5], type: CellType.Wall };
    b2[7][6] = { ...b2[7][6], type: CellType.Wall };
    b2[7][7] = { ...b2[7][7], type: CellType.Wall };
    s = { ...s, board: b2, mouseHasButter: true, currentPlayer: PieceType.Cat, phase: GamePhase.Playing };

    const threat = classifyGoalThreat(s);
    expect(threat.mouseHasButter).toBe(true);
    // Manhattan distance from (7,3) to hole (7,8) is 5, which is ≤ 6 (2*carryingMoves).
    // But the real BFS route is blocked → winRoute should be null.
    expect(threat.winRoute).toBeNull();
    expect(threat.urgency).toBe('none');
  });
});

// ===========================================================================
// B-4: Configurable carrying moves — thresholds derive from config
// ===========================================================================

describe('B-4: threat classifier — configurable carrying moves', () => {
  it('uses mouseCarryingMoves from config for thresholds', () => {
    // With mouseCarryingMoves=2: critical ≤ 2, near ≤ 4.
    let s = createInitialState(cleanConfig({ mouseCarryingMoves: 2 }));
    s = clearButter(s);
    // Mouse at (7,6), distance to hole (7,8) = 2. With carryingMoves=2: 2 ≤ 2 → critical.
    s = setPieces(s, { r: 7, c: 6 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 7, c: 6 }, { r: 7, c: 7 }, { r: 1, c: 1 }]);
    s = { ...s, mouseHasButter: true, currentPlayer: PieceType.Cat, phase: GamePhase.Playing };

    const threat = classifyGoalThreat(s);
    expect(threat.winRoute).toBe(2);
    expect(threat.urgency).toBe('critical');

    // Now with mouseCarryingMoves=1: critical ≤ 1, near ≤ 2.
    // Same position (7,6), distance=2. With carryingMoves=1: 2 > 1 but 2 ≤ 2 → near.
    let s2 = createInitialState(cleanConfig({ mouseCarryingMoves: 1 }));
    s2 = clearButter(s2);
    s2 = setPieces(s2, { r: 7, c: 6 }, { r: 1, c: 1 });
    s2 = wallOff(s2, [{ r: 7, c: 6 }, { r: 7, c: 7 }, { r: 1, c: 1 }]);
    s2 = { ...s2, mouseHasButter: true, currentPlayer: PieceType.Cat, phase: GamePhase.Playing };

    const threat2 = classifyGoalThreat(s2);
    expect(threat2.winRoute).toBe(2);
    expect(threat2.urgency).toBe('near');
  });

  it('classifies as none when route exceeds 2x carrying moves', () => {
    let s = createInitialState(cleanConfig({ mouseCarryingMoves: 2 }));
    s = clearButter(s);
    // Mouse at (7,1), distance to hole (7,8) = 7. 7 > 4 (2*2) → none.
    s = setPieces(s, { r: 7, c: 1 }, { r: 1, c: 1 });
    s = wallOff(s, [
      { r: 7, c: 1 }, { r: 7, c: 2 }, { r: 7, c: 3 }, { r: 7, c: 4 },
      { r: 7, c: 5 }, { r: 7, c: 6 }, { r: 7, c: 7 }, { r: 1, c: 1 },
    ]);
    s = { ...s, mouseHasButter: true, currentPlayer: PieceType.Cat, phase: GamePhase.Playing };

    const threat = classifyGoalThreat(s);
    expect(threat.winRoute).toBe(7);
    expect(threat.urgency).toBe('none');
  });
});
