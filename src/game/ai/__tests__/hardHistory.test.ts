import { test, expect } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState, computeCatAiTrajectory } from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import {
  captureHardRoot,
  restoreHardRoot,
  snapshotStateKey,
  pushHardHistory,
  makeHardHistoryEntry,
  snapshotsEqual,
  HARD_HISTORY_LIMIT,
  type HardRootSnapshot,
  type HardSearchHistoryEntry,
  type HardProductionDiag,
} from '../hardHistory';
import { stateKey } from '../transposition';
import { gameAffectingEqual } from '../stateCompare';

// ===========================================================================
// G0.2-2 — Exact snapshot round-trip + bounded history (debug only).
// ===========================================================================

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

/** A small Hard root with a box + trap + butter set, cat to move. */
function richRoot(): GameEngineState {
  let s = createInitialState(cleanConfig({ difficulty: 'hard', boxPositions: [{ r: 1, c: 3 }] }));
  s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 1 });
  s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 3,
    phase: GamePhase.Playing,
    mouseHasButter: true,
    mouseSkillActive: false,
    catTrapsRemaining: 1,
    trapPosition: { r: 1, c: 2 },
    butterPositions: [{ r: 1, c: 3 }],
    blockedTunnels: [],
    tunnelExitChoices: [],
  };
}

const dummyProd = (over?: Partial<HardProductionDiag>): HardProductionDiag => ({
  completedDepth: 2,
  attemptedDepth: 3,
  nodes: 100,
  elapsedMs: 50,
  rootValue: -999994,
  mate: 'mouse' as const,
  plan: [{ type: 'catStep', direction: { key: 'ArrowRight', dr: 0, dc: 1, label: '→' } }],
  rootValues: [],
  ...over,
});

// --- G0.2-2 focused tests ---

test('G0.2: snapshot is a DEEP copy (mutating live state does not touch snapshot)', () => {
  const root = richRoot();
  const snap = captureHardRoot(root);
  const before = JSON.stringify(snap);

  // Mutate live state heavily.
  root.catPosition = { r: 9, c: 9 };
  root.mouseHasButter = false;
  root.catTrapsRemaining = 0;
  root.trapPosition = null;
  root.butterPositions = [];
  root.board[0][0] = { ...root.board[0][0], type: CellType.Wall, piece: undefined, hasButter: false };

  expect(JSON.stringify(snap)).toBe(before); // snapshot unchanged
});

test('G0.2: restore(snapshot) → exact stateKey round-trip', () => {
  const root = richRoot();
  const snap = captureHardRoot(root);
  const key = stateKey(root);
  const restored = restoreHardRoot(snap);
  expect(stateKey(restored)).toBe(key);
  expect(snapshotStateKey(snap)).toBe(key);
  expect(restored.hardSearchHistory).toEqual([]);
  expect(gameAffectingEqual(restored, root)).toBe(true);
});

test('G0.2: debug history is EXCLUDED from gameAffectingEqual/stateKey', () => {
  const root = richRoot();
  const snapA = captureHardRoot(root);
  const withHistory: GameEngineState = {
    ...root,
    hardSearchHistory: [
      makeHardHistoryEntry(root, 1, dummyProd()),
      makeHardHistoryEntry(root, 2, dummyProd()),
      makeHardHistoryEntry(root, 3, dummyProd()),
    ],
  };
  // Debug-only history must NOT change game identity.
  expect(gameAffectingEqual(root, withHistory)).toBe(true);
  expect(stateKey(root)).toBe(stateKey(withHistory));
  void snapA;
});

test('G0.2: history bounded — oldest entries dropped at limit (default 20)', () => {
  const root = richRoot();
  let h: HardSearchHistoryEntry[] = [];
  for (let i = 1; i <= HARD_HISTORY_LIMIT + 5; i++) {
    h = pushHardHistory(h, makeHardHistoryEntry(root, i, dummyProd()));
  }
  expect(h.length).toBe(HARD_HISTORY_LIMIT);
  // Oldest dropped: turns 1..5 gone, newest are 6..25.
  expect(h[0].turn).toBe(HARD_HISTORY_LIMIT + 5 - HARD_HISTORY_LIMIT + 1);
  expect(h[h.length - 1].turn).toBe(HARD_HISTORY_LIMIT + 5);
});

test('G0.2: makeHardHistoryEntry captures correct stateKey + production diag', () => {
  const root = richRoot();
  const entry = makeHardHistoryEntry(root, 7, dummyProd());
  expect(entry.turn).toBe(7);
  expect(entry.stateKey).toBe(stateKey(root));
  expect(entry.production.completedDepth).toBe(2);
  expect(entry.production.plan[0].type).toBe('catStep');
  expect(entry.execution.endStateKey).toBeNull(); // pending until executed
});

test('G0.2: restoreHardRoot rebuilds a fully-playable state (trajectory works)', () => {
  const root = richRoot();
  const snap = captureHardRoot(root);
  const restored = restoreHardRoot(snap);

  // A trajectory on the restored state can actually run (Hard route) and
  // produces a history entry with an execution link.
  const traj = computeCatAiTrajectory(restored);
  expect(traj).not.toBeNull();
  expect(traj!.length).toBeGreaterThanOrEqual(1);
  const last = traj![traj!.length - 1].state;
  expect(last.hardSearchHistory.length).toBeGreaterThanOrEqual(1);
  const h = last.hardSearchHistory[0];
  expect(h.execution.endStateKey).toBeTruthy();
  expect(typeof h.execution.matchedPlan).toBe('boolean');
});

test('G0.2: snapshotsEqual deep-compares exactly', () => {
  const root = richRoot();
  const a = captureHardRoot(root);
  const b = captureHardRoot({ ...root, catTrapsRemaining: root.catTrapsRemaining });
  expect(snapshotsEqual(a, b)).toBe(true);
  const c = captureHardRoot({ ...root, catPosition: { r: 2, c: 2 } });
  expect(snapshotsEqual(a, c)).toBe(false);
});

/** trims false TS-unsafe usage in this file */
function restoreRef(snap: HardRootSnapshot): { hardSearchHistory: unknown[] } {
  const s = restoreHardRoot(snap);
  return { hardSearchHistory: s.hardSearchHistory };
}

void restoreRef;