import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BOARD_SIZE_MAX,
  BOARD_SIZE_MIN,
  DEFAULT_CONFIG,
  deriveDefaultLayout,
  isDerivedDefaultLayout,
  validateGameConfig,
  withBoardSize,
  withMouseHole,
} from '../config';
import type { GameConfig } from '../config';
import { createInitialState } from '../engine';
import type { GameEngineState } from '../engine';
import { createGameState } from '../newGame';
import type { NewGameOpening } from '../newGame';
import { CellType, GameMode, GamePhase, PieceType } from '../types';
import { createEmptyMap, mapDefinitionToGameConfig, validateMap } from '../mapDefinition';
import { PHASE_A_CONFIG, PHASE_B_CONFIG } from '../tutorial';
import { certifyOpening } from '../openingFairness';
import { catHasLegalSpatialMove, mouseHasLegalSpatialMove } from '../rules/mobility';

/**
 * PPC-GAMEPLAY-02 — small-board config compatibility.
 *
 * The bug: only `boardSize` was edited by the UI while the 10×10 default hole
 * (7,8,size 2) and mouse start (7,8) stayed in the config, so sizes 5–9 wrote
 * out-of-bounds cells during board creation (inside a `useState` initializer).
 *
 * These tests pin: deterministic derivation for untouched defaults, verbatim
 * preservation of explicit layouts, actionable rejection of invalid configs,
 * and the real per-size outcome of the certified opening factory.
 */

const REQUIRED_SIZES = [5, 6, 7, 8, 9, 10, 20];

/** Deterministic Math.random replacement so random openings are reproducible. */
function withSeed<T>(seed: number, fn: () => T): T {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function defaultFor(size: number): GameConfig {
  return { ...DEFAULT_CONFIG, boardSize: size, ...deriveDefaultLayout(size) };
}

function holeCells(cfg: GameConfig): { r: number; c: number }[] {
  const out: { r: number; c: number }[] = [];
  for (let dr = 0; dr < cfg.mouseHole.size; dr++) {
    for (let dc = 0; dc < cfg.mouseHole.size; dc++) {
      out.push({ r: cfg.mouseHole.r + dr, c: cfg.mouseHole.c + dc });
    }
  }
  return out;
}

function unverified(opening: NewGameOpening) {
  if (opening.status.kind !== 'unverified') {
    throw new Error(`expected unverified, got ${opening.status.kind}`);
  }
  expect(opening.state).toBeNull();
  return opening.status;
}

describe('PPC-GAMEPLAY-02 — small-board config compatibility', () => {
  it('A. the derived default layout matches 10×10 and stays in bounds for 5…20', () => {
    const at10 = deriveDefaultLayout(10);
    expect(at10.mouseHole).toEqual(DEFAULT_CONFIG.mouseHole);
    expect(at10.mouseStart).toEqual(DEFAULT_CONFIG.mouseStart);
    expect(at10.catStart).toEqual(DEFAULT_CONFIG.catStart);
    expect(validateGameConfig(DEFAULT_CONFIG).ok).toBe(true);

    for (let size = BOARD_SIZE_MIN; size <= BOARD_SIZE_MAX; size++) {
      const d = deriveDefaultLayout(size);
      // The hole size is never reduced.
      expect(d.mouseHole.size).toBe(2);
      for (const p of [
        { r: d.mouseHole.r, c: d.mouseHole.c },
        { r: d.mouseHole.r + 1, c: d.mouseHole.c + 1 },
      ]) {
        expect(p.r).toBeGreaterThanOrEqual(0);
        expect(p.c).toBeGreaterThanOrEqual(0);
        expect(p.r).toBeLessThan(size);
        expect(p.c).toBeLessThan(size);
      }
      expect(d.mouseStart).toEqual({ r: d.mouseHole.r, c: d.mouseHole.c });
      expect(d.catStart).toEqual({ r: 1, c: 1 });
      // Default tunnel corners must never overwrite a hole cell.
      for (const corner of [
        { r: 0, c: 0 }, { r: 0, c: size - 1 }, { r: size - 1, c: 0 }, { r: size - 1, c: size - 1 },
      ]) {
        const inHole = corner.r >= d.mouseHole.r && corner.r < d.mouseHole.r + 2
          && corner.c >= d.mouseHole.c && corner.c < d.mouseHole.c + 2;
        expect(inHole).toBe(false);
      }
      expect(validateGameConfig(defaultFor(size)).ok).toBe(true);
    }
  });

  it('B. board-size changes re-derive untouched defaults and never move explicit coordinates', () => {
    const shrunk = withBoardSize(DEFAULT_CONFIG, 6);
    expect(shrunk.boardSize).toBe(6);
    expect(shrunk.mouseHole).toEqual({ r: 3, c: 4, size: 2 });
    expect(shrunk.mouseStart).toEqual({ r: 3, c: 4 });
    expect(shrunk.catStart).toEqual({ r: 1, c: 1 });
    expect(shrunk.boxCount).toBe(DEFAULT_CONFIG.boxCount);
    expect(shrunk.butterCount).toBe(DEFAULT_CONFIG.butterCount);
    expect(shrunk.mouseBaseMoves).toBe(DEFAULT_CONFIG.mouseBaseMoves);

    const roundTrip = withBoardSize(shrunk, 10);
    expect(roundTrip.boardSize).toBe(10);
    expect(roundTrip.mouseHole).toEqual(DEFAULT_CONFIG.mouseHole);
    expect(roundTrip.mouseStart).toEqual(DEFAULT_CONFIG.mouseStart);
    expect(isDerivedDefaultLayout(roundTrip)).toBe(true);

    const explicit: GameConfig = {
      ...DEFAULT_CONFIG,
      mouseHole: { r: 2, c: 2, size: 1 },
      mouseStart: { r: 1, c: 3 },
      catStart: { r: 2, c: 5 },
    };
    const kept = withBoardSize(explicit, 7);
    expect(kept.boardSize).toBe(7);
    expect(kept.mouseHole).toEqual(explicit.mouseHole);
    expect(kept.mouseStart).toEqual(explicit.mouseStart);
    expect(kept.catStart).toEqual(explicit.catStart);

    // Half-explicit: hole moved but the start was not — no silent re-derivation.
    const half: GameConfig = { ...DEFAULT_CONFIG, mouseHole: { r: 5, c: 5, size: 2 } };
    const halfKept = withBoardSize(half, 8);
    expect(halfKept.mouseHole).toEqual({ r: 5, c: 5, size: 2 });
    expect(halfKept.mouseStart).toEqual(DEFAULT_CONFIG.mouseStart);

    // Out-of-range sizes never trigger a nonsense derivation.
    expect(withBoardSize(DEFAULT_CONFIG, 21).mouseHole).toEqual(DEFAULT_CONFIG.mouseHole);
    expect(withBoardSize(DEFAULT_CONFIG, 4).mouseHole).toEqual(DEFAULT_CONFIG.mouseHole);

    const movedHole = withMouseHole(DEFAULT_CONFIG, { r: 5, c: 5, size: 2 });
    expect(movedHole.mouseStart).toEqual({ r: 5, c: 5 });
    const explicitStart: GameConfig = { ...DEFAULT_CONFIG, mouseStart: { r: 2, c: 2 } };
    const keptStart = withMouseHole(explicitStart, { r: 5, c: 5, size: 2 });
    expect(keptStart.mouseStart).toEqual({ r: 2, c: 2 });
  });

  it('C. invalid configs are rejected with actionable reasons, never mutated', () => {
    const staleSmall: GameConfig = { ...DEFAULT_CONFIG, boardSize: 6 };
    const before = JSON.stringify(staleSmall);
    const validation = validateGameConfig(staleSmall);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.message.includes('鼠洞区域越界'))).toBe(true);
    expect(JSON.stringify(staleSmall)).toBe(before);
    expect(unverified(createGameState(staleSmall)).reason).toBe('INVALID_CONFIG');

    const badMouseStart: GameConfig = { ...defaultFor(6), mouseStart: { r: 7, c: 8 } };
    const badMouse = unverified(createGameState(badMouseStart));
    expect(badMouse.reason).toBe('INVALID_CONFIG');
    expect(badMouse.detail).toContain('鼠的初始位置越界');

    const holeTunnelConflict: GameConfig = { ...defaultFor(6), tunnelCorners: [{ r: 3, c: 4 }] };
    const conflict = unverified(createGameState(holeTunnelConflict));
    expect(conflict.reason).toBe('INVALID_CONFIG');
    expect(conflict.detail).toContain('传送通道与鼠洞区域重叠');

    const boxOutside: GameConfig = { ...defaultFor(6), boxPositions: [{ r: 6, c: 0 }] };
    const box = unverified(createGameState(boxOutside));
    expect(box.reason).toBe('INVALID_CONFIG');
    expect(box.detail).toContain('固定的箱子位置越界');

    const narrowTerrain = Array.from({ length: 8 }, () =>
      Array.from({ length: 7 }, () => CellType.Empty));
    const wrongShape: GameConfig = { ...defaultFor(8), customTerrain: narrowTerrain };
    const shape = unverified(createGameState(wrongShape));
    expect(shape.reason).toBe('INVALID_CONFIG');
    expect(shape.detail).toContain('自定义地图尺寸与棋盘大小不一致');

    const blockedTerrain: CellType[][] = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => CellType.Empty));
    const blocked = defaultFor(8);
    blockedTerrain[blocked.mouseStart.r][blocked.mouseStart.c] = CellType.Wall;
    const wallStart = unverified(createGameState({ ...blocked, customTerrain: blockedTerrain }));
    expect(wallStart.reason).toBe('INVALID_CONFIG');
    expect(wallStart.detail).toContain('不可通行地形');

    // Board-size range keeps its historical UNSUPPORTED_CONFIG reason.
    expect(unverified(createGameState({ ...DEFAULT_CONFIG, boardSize: 21 })).reason)
      .toBe('UNSUPPORTED_CONFIG');
    expect(unverified(createGameState({ ...DEFAULT_CONFIG, boardSize: 4 })).reason)
      .toBe('UNSUPPORTED_CONFIG');
  });

  it('D. board creation never crashes and every initial position stays in bounds', () => {
    for (const size of REQUIRED_SIZES) {
      const cfg = defaultFor(size);
      const state = withSeed(7000 + size, () => createInitialState(cfg));
      expect(state.board).toHaveLength(size);
      expect(state.board.every((row) => row.length === size)).toBe(true);
      expect(state.config.boardSize).toBe(size);
      expect(state.mousePosition).toEqual(cfg.mouseStart);
      expect(state.catPosition).toEqual(cfg.catStart);
      expect(state.board[cfg.catStart.r][cfg.catStart.c].piece).toBe(PieceType.Cat);
      expect(state.board[cfg.mouseStart.r][cfg.mouseStart.c].piece).toBe(PieceType.Mouse);
      for (const cell of holeCells(cfg)) {
        expect(state.board[cell.r][cell.c].type).toBe(CellType.MouseHole);
      }
      for (const b of state.butterPositions) {
        expect(b.r).toBeGreaterThanOrEqual(0);
        expect(b.c).toBeGreaterThanOrEqual(0);
        expect(b.r).toBeLessThan(size);
        expect(b.c).toBeLessThan(size);
        expect(state.board[b.r][b.c].type).toBe(CellType.Empty);
      }
    }
  });

  it('E. sizes 5–7 fail closed as UNDER_GENERATED; 8, 9, 10, 20 start certified', () => {
    for (const size of [5, 6, 7]) {
      for (const seed of [101, 202, 303]) {
        const status = unverified(withSeed(seed, () => createGameState(defaultFor(size))));
        expect(status.reason).toBe('UNDER_GENERATED');
        expect(status.detail).toContain('黄油必须距离鼠洞至少 5 格');
      }
    }

    for (const size of [8, 9, 10, 20]) {
      for (const seed of [101, 202, 303]) {
        const opening = withSeed(seed, () => createGameState(defaultFor(size)));
        expect(opening.status.kind).toBe('certified');
        if (opening.state === null) throw new Error('certified opening lost its state');
        const state: GameEngineState = opening.state;
        expect(state.config.boardSize).toBe(size);
        expect(state.board).toHaveLength(size);
        expect(state.phase).toBe(GamePhase.Playing);
        expect(state.currentPlayer).toBe(PieceType.Mouse);
        expect(state.mousePosition).toEqual(defaultFor(size).mouseStart);
        expect(state.catPosition).toEqual(defaultFor(size).catStart);
        expect(state.butterPositions).toHaveLength(DEFAULT_CONFIG.butterCount);
        for (const cell of holeCells(defaultFor(size))) {
          expect(state.board[cell.r][cell.c].type).toBe(CellType.MouseHole);
        }
        expect(mouseHasLegalSpatialMove(state)).toBe(true);
        expect(catHasLegalSpatialMove(state)).toBe(true);
        // The state handed to the board is the state the certifier accepts.
        expect(certifyOpening(state).verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
      }
    }
  }, 180000);

  it('F. size 7 can start only with butterCount 1; 5 and 6 cannot start at all', () => {
    const size7OneButter: GameConfig = { ...defaultFor(7), butterCount: 1 };
    for (const seed of [101, 202, 303, 404]) {
      const opening = withSeed(seed, () => createGameState(size7OneButter));
      expect(opening.status.kind).toBe('certified');
      if (opening.state) expect(opening.state.butterPositions).toHaveLength(1);
    }

    for (const size of [5, 6]) {
      const cfg: GameConfig = { ...defaultFor(size), butterCount: 1, boxCount: 0, pileCount: 0 };
      const status = unverified(withSeed(101, () => createGameState(cfg)));
      expect(status.reason).toBe('UNDER_GENERATED');
    }
  }, 180000);

  it('G. editor and tutorial explicit layouts are unchanged and still pass validation', () => {
    for (const cfg of [PHASE_A_CONFIG, PHASE_B_CONFIG]) {
      expect(validateGameConfig(cfg).ok).toBe(true);
      const snapshot = JSON.stringify(cfg);
      const opening = withSeed(55, () => createGameState(cfg));
      expect(opening.status.kind).toBe('explicit');
      if (opening.state === null) throw new Error('explicit layout lost its state');
      expect(JSON.stringify(cfg)).toBe(snapshot);
      expect(opening.state.config.mouseHole).toEqual(cfg.mouseHole);
      expect(opening.state.mousePosition).toEqual(cfg.mouseStart);
      expect(opening.state.catPosition).toEqual(cfg.catStart);
    }

    const map = createEmptyMap('测试地图', 8, 8);
    map.grid[7][7] = CellType.MouseHole;
    map.grid[3][3] = CellType.Tunnel;
    map.grid[3][4] = CellType.Tunnel;
    map.mouseStart = { r: 3, c: 5 };
    map.catStart = { r: 0, c: 0 };
    expect(validateMap(map).ok).toBe(true);
    const cfg = mapDefinitionToGameConfig(map, GameMode.Single);
    expect(validateGameConfig(cfg).ok).toBe(true);
    const snapshot = JSON.stringify(cfg);
    const opening = withSeed(56, () => createGameState(cfg));
    expect(opening.status.kind).toBe('explicit');
    if (opening.state === null) throw new Error('editor layout lost its state');
    expect(JSON.stringify(cfg)).toBe(snapshot);
    expect(opening.state.config.mouseHole).toEqual(cfg.mouseHole);
    expect(opening.state.mousePosition).toEqual(cfg.mouseStart);
    expect(opening.state.catPosition).toEqual(cfg.catStart);
  });

  it('H. setup screens validate, and the blocked screen explains an invalid config', () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

    const settings = read('../../pages/SettingsPage.tsx');
    expect(settings).toContain('validateGameConfig(config)');
    expect(settings).toContain('当前配置无法开始对局');

    const setup = read('../../pages/MatchSetupPage.tsx');
    expect(setup).toContain('validateGameConfig(matchConfig)');
    expect(setup).toContain('disabled={!validation.ok}');

    const page = read('../../pages/GamePage.tsx');
    expect(page).toContain('INVALID_CONFIG');
    expect(page).toContain('props.detail');
    expect(page).toContain('当前配置无法开始对局');
    expect(page).toContain('返回调整配置');
    // Invalid configs cannot be fixed by drawing a new random opening.
    expect(page).toContain('!invalidConfig');
  });
});
