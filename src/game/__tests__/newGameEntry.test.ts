import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInitialState } from '../engine';
import type { GameEngineState } from '../engine';
import { DEFAULT_CONFIG } from '../config';
import type { GameConfig } from '../config';
import { CellType, GameMode, GamePhase, PieceType } from '../types';
import { PHASE_B_CONFIG } from '../tutorial';
import { certifyOpening, generateFairOpening } from '../openingFairness';
import { createGameState } from '../newGame';
import type { NewGameOpening } from '../newGame';
import { catHasLegalSpatialMove, mouseHasLegalSpatialMove } from '../rules/mobility';

/**
 * P1 — the REAL opening entrypoint.
 *
 * MatchSetupPage only writes config and navigates; GamePage mounts and calls
 * `createGameState` for the first game, every restart and every difficulty
 * switch. These tests pin that the state the entrypoint hands to the board is
 * exactly the state that passed certification — same terrain, butters, piece
 * positions and every rule field — and that a failed certification can never
 * masquerade as a certified opening.
 */

/** Deterministic Math.random replacement so a random opening is reproducible. */
function withSeed<T>(seed: number, fn: () => T): T {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => {
    // Numerical Recipes LCG; only the reproducibility matters here.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function snapshot(state: GameEngineState): string {
  return JSON.stringify(state);
}

/** Narrow an opening that may be played, asserting it is not a blocked result. */
function playable(opening: NewGameOpening): GameEngineState {
  if (opening.state === null) {
    throw new Error(`opening is not playable (${opening.status.kind})`);
  }
  return opening.state;
}

const FIVE_BUTTER_IMPOSSIBLE: GameConfig = {
  ...DEFAULT_CONFIG,
  boardSize: 5,
  mouseHole: { r: 4, c: 4, size: 1 },
  mouseStart: { r: 0, c: 0 },
  catStart: { r: 0, c: 4 },
  boxCount: 0,
  pileCount: 0,
  boxPositions: [],
  pilePositions: [],
  butterCount: 5,
  butterPositions: [],
  tunnelCorners: [{ r: 2, c: 3, label: 'br' }],
};

describe('P1 — real-game opening entrypoint', () => {
  it('A. single-player default opening is the certified state, in full', () => {
    // Same seed, separately reseeded: both runs walk the identical RNG stream.
    const entry = withSeed(20261111, () => createGameState(DEFAULT_CONFIG));
    const expected = withSeed(20261111, () => generateFairOpening(DEFAULT_CONFIG));

    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(entry.status.kind).toBe('certified');
    const s = playable(entry);
    // Same seed + same config: the board the player sees IS the certified one.
    expect(snapshot(s)).toBe(snapshot(expected.state));

    expect(s.config.boardSize).toBe(DEFAULT_CONFIG.boardSize);
    expect(s.board).toHaveLength(DEFAULT_CONFIG.boardSize);
    expect(s.board.every((row) => row.length === DEFAULT_CONFIG.boardSize)).toBe(true);
    expect(s.board.flat().every((cell) => Object.values(CellType).includes(cell.type))).toBe(true);
    expect(s.butterPositions).toHaveLength(DEFAULT_CONFIG.butterCount);
    const seen = new Set<string>();
    for (const b of s.butterPositions) {
      const cell = s.board[b.r][b.c];
      expect(cell.type).toBe(CellType.Empty);
      expect(seen.has(`${b.r},${b.c}`)).toBe(false);
      seen.add(`${b.r},${b.c}`);
      const dist = (p: { r: number; c: number }) => Math.abs(p.r - b.r) + Math.abs(p.c - b.c);
      expect(dist(s.mousePosition)).toBeGreaterThanOrEqual(3);
      expect(dist(s.catPosition)).toBeGreaterThanOrEqual(3);
      expect(dist(DEFAULT_CONFIG.mouseHole)).toBeGreaterThanOrEqual(5);
    }
    expect(s.catPosition).toEqual(DEFAULT_CONFIG.catStart);
    expect(s.mousePosition).toEqual(DEFAULT_CONFIG.mouseStart);
    expect(s.phase).toBe(GamePhase.Playing);
    expect(s.currentPlayer).toBe(PieceType.Mouse);
    expect(s.mouseMovesLeft).toBe(DEFAULT_CONFIG.mouseBaseMoves);
    expect(s.catMovesLeft).toBe(DEFAULT_CONFIG.catBaseMoves);
    expect(s.mouseHasButter).toBe(false);
    expect(s.mouseSkillActive).toBe(false);
    expect(s.trapPosition).toBeNull();
    expect(s.pendingButterSpawns).toHaveLength(0);
    expect(s.pendingButterPlacementDebt ?? 0).toBe(0);
    expect(s.gameMode).toBe(GameMode.Single);
    expect(mouseHasLegalSpatialMove(s)).toBe(true);
    expect(catHasLegalSpatialMove(s)).toBe(true);

    expect(certifyOpening(s, { caps: expected.certification }).verdict)
      .toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
  }, 120000);

  it('B. dual-player opening goes through the same certified factory', () => {
    const cfg: GameConfig = { ...DEFAULT_CONFIG, gameMode: GameMode.Dual };
    const entry = withSeed(777, () => createGameState(cfg));
    const expected = withSeed(777, () => generateFairOpening(cfg));

    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(entry.status.kind).toBe('certified');
    const s = playable(entry);
    expect(snapshot(s)).toBe(snapshot(expected.state));
    expect(s.gameMode).toBe(GameMode.Dual);
    expect(s.phase).toBe(GamePhase.Playing);
  }, 120000);

  it('C. explicit layouts are preserved verbatim and never regenerated', () => {
    const explicit: GameConfig = {
      ...DEFAULT_CONFIG,
      butterCount: 1,
      butterPositions: [{ r: 5, c: 3 }],
    };
    const entry = withSeed(31415, () => createGameState(explicit));
    const raw = withSeed(31415, () => createInitialState(explicit));
    expect(entry.status.kind).toBe('explicit');
    expect(snapshot(playable(entry))).toBe(snapshot(raw));
    expect(playable(entry).butterPositions).toEqual([{ r: 5, c: 3 }]);

    const tutorial = withSeed(27182, () => createGameState(PHASE_B_CONFIG));
    const tutorialRaw = withSeed(27182, () => createInitialState(PHASE_B_CONFIG));
    expect(tutorial.status.kind).toBe('explicit');
    expect(snapshot(playable(tutorial))).toBe(snapshot(tutorialRaw));

    const customTerrain = Array.from({ length: 10 }, () =>
      Array.from({ length: 10 }, () => CellType.Empty));
    const custom: GameConfig = {
      ...DEFAULT_CONFIG,
      customTerrain,
      boxCount: 0,
      pileCount: 0,
      butterCount: 0,
    };
    const customEntry = withSeed(16180, () => createGameState(custom));
    const customRaw = withSeed(16180, () => createInitialState(custom));
    expect(customEntry.status.kind).toBe('explicit');
    expect(snapshot(playable(customEntry))).toBe(snapshot(customRaw));
  });

  it('D. UNKNOWN / no-certified-opening fails closed with no operable state', () => {
    const entry = withSeed(424242, () => createGameState(DEFAULT_CONFIG, { caps: { maxNodes: 1 } }));
    expect(entry.status.kind).toBe('unverified');
    if (entry.status.kind !== 'unverified') return;
    expect(entry.status.reason).toBe('NO_CERTIFIED_OPENING');
    // No state is handed out: an unverified auto opening may never start a match.
    expect(entry.state).toBeNull();
  }, 120000);

  it('E. under-generated layouts fail closed with a bounded retry count', () => {
    const entry = withSeed(99, () =>
      createGameState(FIVE_BUTTER_IMPOSSIBLE, { maxAttempts: 3 }));
    expect(entry.status.kind).toBe('unverified');
    if (entry.status.kind !== 'unverified') return;
    expect(entry.status.reason).toBe('UNDER_GENERATED');
    expect(entry.state).toBeNull();
  }, 60000);

  it('F. unsupported board sizes fail closed instead of crashing', () => {
    const entry = createGameState({ ...DEFAULT_CONFIG, boardSize: 21 });
    expect(entry.status.kind).toBe('unverified');
    if (entry.status.kind !== 'unverified') return;
    expect(entry.status.reason).toBe('UNSUPPORTED_CONFIG');
    expect(entry.state).toBeNull();
  });

  it('G. GamePage only reaches openings through the certified factory and blocks failures', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../../pages/GamePage.tsx', import.meta.url)), 'utf8');
    expect(page).toContain("from '../game/newGame'");
    expect(page).toContain('createGameState(');
    // Direct constructor / generator / bypass predicates must not appear: every
    // entry (mount, restart, difficulty switch) has to pass the factory.
    expect(page).not.toContain('createInitialState(');
    expect(page).not.toContain('generateFairOpening(');
    expect(page).not.toContain('isExplicitLayout(');
    expect(page).toContain('openingBlocked');
    expect(page).toContain('开局未通过公平性认证');
    expect(page).toContain('重新生成开局');
    // The old "keep playing without a certificate" notice is gone, and the
    // blocked screen short-circuits BEFORE the only operable board render.
    expect(page).not.toContain('规则照常运行');
    const blockedAt = page.indexOf('if (openingBlocked !== null || gameState === null)');
    const boardAt = page.indexOf('<Board');
    expect(blockedAt).toBeGreaterThan(-1);
    expect(boardAt).toBeGreaterThan(blockedAt);

    const factory = readFileSync(
      fileURLToPath(new URL('../newGame.ts', import.meta.url)), 'utf8');
    expect(factory).toContain('generateFairOpening');
    expect(factory).toContain('console.warn');
    // Unverified results carry no state at all.
    expect(factory).toContain('state: null');
  });
});
