import { describe, expect, it } from 'vitest';
import { createInitialState, mouseMove, catMove } from '../engine';
import type { GameEngineState } from '../engine';
import { DEFAULT_CONFIG, GAMEPLAY_RULESET_VERSION } from '../config';
import type { GameConfig } from '../config';
import { DIRECTIONS, GamePhase, PieceType } from '../types';
import type { Direction } from '../types';
import { DEFAULT_SEARCH_CONFIG, HARD_TRIAL } from '../ai/searchConfig';
import {
  DEADLINE_CHECK_INTERVAL,
  EVAL_DEADLINE_CHECK_INTERVAL,
  MATE_DISTANCE_GUARD,
  MATE_SCORE,
  compareSearchScore,
  terminalValue,
} from '../ai/expectiminimax';
import { stateKey } from '../ai/transposition';
import { defaultRuleSet } from '../ai/searchRules';

type Point = { r: number; c: number };
const pt = (r: number, c: number): Point => ({ r, c });
const RIGHT: Direction = DIRECTIONS[3];

interface Opts {
  mouse: Point;
  cat: Point;
  boxes?: Point[];
  walls?: Point[];
  mouseHasButter?: boolean;
  currentPlayer?: PieceType;
  mouseMoves?: number;
  catMoves?: number;
  tentatives?: Point[];
}

function fixture(o: Opts): GameEngineState {
  const size = 7;
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    boardSize: size,
    mouseHole: { r: size - 2, c: size - 2, size: 1 },
    boxCount: 0,
    pileCount: 0,
    boxPositions: o.boxes ?? [],
    butterCount: 0,
    butterPositions: [],
    mouseStart: o.mouse,
    catStart: o.cat,
    tunnelCorners: [{ r: 0, c: 0, label: 'tl' }],
  };
  const base = createInitialState(config);
  const board = base.board.map((row, r) => row.map((cell, c) => ({
    ...cell,
    type: o.walls?.some((w) => w.r === r && w.c === c)
      ? 'wall' as const
      : o.boxes?.some((b) => b.r === r && b.c === c)
        ? 'box' as const
        : cell.type,
    piece: o.mouse.r === r && o.mouse.c === c
      ? PieceType.Mouse
      : o.cat.r === r && o.cat.c === c
        ? PieceType.Cat
        : undefined,
  })));
  return {
    ...base,
    board,
    mousePosition: o.mouse,
    catPosition: o.cat,
    butterPositions: [],
    pendingButterSpawns: (o.tentatives ?? []).map((p) => ({ ...p, blockedMaterializations: 0 })),
    pendingButterPlacementDebt: 0,
    currentPlayer: o.currentPlayer ?? PieceType.Mouse,
    mouseMovesLeft: o.mouseMoves ?? 4,
    catMovesLeft: o.catMoves ?? 4,
    mouseHasButter: o.mouseHasButter ?? false,
    phase: GamePhase.Playing,
    tunnelExitChoices: [],
  };
}

describe('gameplay parity baseline (RULE-A / RULE-B)', () => {
  it('records ruleset 2 while the AI search contracts stay frozen', () => {
    expect(GAMEPLAY_RULESET_VERSION).toBe(2);
    expect(DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn).toBe(100);
    expect(DEFAULT_SEARCH_CONFIG.maxDepthTurns).toBe(4);
    expect(DEFAULT_SEARCH_CONFIG.useTranspositionTable).toBe(false);
    expect(DEFAULT_SEARCH_CONFIG.enableIterativeDeepening).toBe(false);
    expect(HARD_TRIAL.totalTurnBudgetMs).toBe(150);
    expect(HARD_TRIAL.refutationEnabled).toBe(true);
  });

  it('pins the mate / deadline constants behind the terminal contract', () => {
    expect(MATE_SCORE).toBe(1_000_000);
    expect(MATE_DISTANCE_GUARD).toBe(100_000);
    expect(DEADLINE_CHECK_INTERVAL).toBe(1);
    expect(EVAL_DEADLINE_CHECK_INTERVAL).toBe(64);
    // Mate classification outranks any numeric value (single ordering source).
    expect(compareSearchScore({ value: 1, mate: 'cat' }, { value: 999_999, mate: null })).toBeGreaterThan(0);
    expect(compareSearchScore({ value: 999_999, mate: 'mouse' }, { value: 0, mate: null })).toBeLessThan(0);
    expect(compareSearchScore({ value: 5, mate: null }, { value: 4, mate: null })).toBeGreaterThan(0);
  });

  it('the engine RULE-A terminals are the real mate values the search sees', () => {
    const strandedMouse = fixture({
      mouse: pt(3, 3),
      cat: pt(0, 5),
      walls: [pt(2, 3), pt(4, 3), pt(3, 2), pt(3, 4)],
    });
    const catWins = mouseMove(strandedMouse, RIGHT);
    expect(catWins.phase).toBe(GamePhase.CatWins);
    expect(terminalValue(catWins)).toBe(MATE_SCORE);

    const strandedCat = fixture({
      mouse: pt(0, 5),
      cat: pt(3, 3),
      currentPlayer: PieceType.Cat,
      boxes: [pt(2, 3), pt(4, 3), pt(3, 2), pt(3, 4)],
      walls: [pt(1, 3), pt(5, 3), pt(3, 1), pt(3, 5)],
    });
    const mouseWins = catMove(strandedCat, RIGHT);
    expect(mouseWins.phase).toBe(GamePhase.MouseWins);
    expect(terminalValue(mouseWins)).toBe(-MATE_SCORE);

    const live = fixture({ mouse: pt(0, 1), cat: pt(5, 5) });
    expect(terminalValue(live)).toBe(0);
  });

  it('state keys stay deterministic and separate the two new terminals', () => {
    const a = fixture({ mouse: pt(0, 1), cat: pt(5, 5) });
    const b = fixture({ mouse: pt(0, 1), cat: pt(5, 5) });
    expect(stateKey(a)).toBe(stateKey(b));

    const mouseStranded = mouseMove(fixture({
      mouse: pt(3, 3),
      cat: pt(0, 5),
      walls: [pt(2, 3), pt(4, 3), pt(3, 2), pt(3, 4)],
    }), RIGHT);
    const catStranded = catMove(fixture({
      mouse: pt(0, 5),
      cat: pt(3, 3),
      currentPlayer: PieceType.Cat,
      boxes: [pt(2, 3), pt(4, 3), pt(3, 2), pt(3, 4)],
      walls: [pt(1, 3), pt(5, 3), pt(3, 1), pt(3, 5)],
    }), RIGHT);
    expect(stateKey(mouseStranded)).not.toBe(stateKey(catStranded));
  });

  it('the ghost boundary CHANCE weights are exactly the official probabilities', () => {
    const rules = defaultRuleSet;
    expect(rules.resolveGhostBoundaryChance).toBeTypeOf('function');

    // Idle ghost: deterministic materialization, weight 1.
    const idle = fixture({
      mouse: pt(5, 1), cat: pt(1, 1), currentPlayer: PieceType.Cat, catMoves: 0,
      tentatives: [pt(4, 1)],
    });
    const idleOut = rules.resolveGhostBoundaryChance!(idle)!;
    expect(idleOut).toHaveLength(1);
    expect(idleOut[0].weight).toBe(1);
    expect(idleOut[0].state.butterPositions).toEqual([pt(4, 1)]);
    expect(idleOut[0].state.currentPlayer).toBe(PieceType.Mouse);

    // Auto-pick at the boundary: one replacement request, uniform 1/N.
    const autoPick = fixture({
      mouse: pt(3, 3), cat: pt(1, 1), currentPlayer: PieceType.Cat, catMoves: 0,
      tentatives: [pt(3, 3)],
    });
    const out = rules.resolveGhostBoundaryChance!(autoPick)!;
    expect(out.length).toBeGreaterThan(0);
    const sum = out.reduce((a, o) => a + o.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    for (const o of out) {
      expect(o.weight).toBeCloseTo(1 / out.length, 12);
      expect(o.state.mouseHasButter).toBe(true);
      expect(o.state.pendingButterSpawns).toHaveLength(1);
      expect(o.state.currentPlayer).toBe(PieceType.Mouse);
    }
  });
});
