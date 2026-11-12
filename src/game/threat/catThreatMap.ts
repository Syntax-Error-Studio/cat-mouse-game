// ============================================================
// G1 — EXACT cat danger region ("危险区域").
//
// Definition this module implements, verbatim from the Web V1 contract:
//
//   A cell X is DANGEROUS iff the mouse ends its action standing on X, and then
//   during the cat's turn there exists at least one LEGAL ACTION SEQUENCE of
//   cat moves that captures the mouse before the cat's whole-turn step budget is
//   exhausted.
//
// That is an existence proof over the real rules, so it is computed by walking
// the actual engine: the state is copied, `mousePosition` is pinned to X, and
// four directions are expanded through `catMove(state, direction)`. There is no
// BFS over `catPosition`, no Manhattan-distance verdict, no AI prediction and no
// second copy of the movement rules — the engine answers legality, and a cell is
// only called dangerous when `catMove` itself returns `phase === CatWins`.
//
// Why the search is exact rather than probabilistic:
//   * The cat's turn is fully deterministic. Ghost butter is resolved at the
//     CAT→MOUSE boundary (engine.endTurn), i.e. AFTER the cat's turn, so the
//     butter set, boxes, piles, traps and tunnels are frozen while the cat
//     moves. No chance node can appear inside the horizon we search.
//   * `catPlaceTrap` is deliberately not expanded: it consumes no step and does
//     not move the cat (engine.catPlaceTrap), and the mouse does not move during
//     the cat's turn, so it can never be part of a capture-within-this-turn
//     witness. Traps already ON the board still constrain the cat, because the
//     real engine applies that constraint.
//
// BFS explores level by level, so the first witness found for a cell is also the
// shortest one — `minimumSteps` is exact, and `witnessPath` replays through
// `catMove` to `CatWins` (asserted by the test suite, not assumed here).
//
// Cost is bounded twice over:
//   * a cell is only expanded while `manhattan(cat, X) <= steps left`, which is
//     sound because one `catMove` moves the cat exactly one cell — a shorter
//     route can never appear later. Cells too far away are rejected without any
//     search at all;
//   * `maxNodesPerCell` caps the rest. If a cap is ever hit the cell is reported
//     in `unknownCells` with `incomplete: true`. It is never quietly called safe.
// ============================================================

import { catMove } from '../engine';
import type { GameEngineState } from '../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType } from '../types';
import { isInBounds } from '../rules/tunnelRules';
import { stateKey } from '../ai/transposition';

/** One dangerous cell: how fast the cat kills there, and how. */
export interface ThreatCell {
  r: number;
  c: number;
  /** Cat steps needed for the capture — exact, not an estimate. */
  minimumSteps: number;
  /** `DIRECTIONS[].key` values; replaying them through `catMove` reaches CatWins. */
  witnessPath: string[];
}

export interface CatThreatMap {
  /** The cat's whole-turn step budget this map was computed against. */
  budget: number;
  catPosition: { r: number; c: number };
  /** Every cell the cat can kill the mouse on this turn, cheapest witness first. */
  dangerousCells: ThreatCell[];
  /** Cells proven safe by an exhaustive search (cap never hit). */
  safeCells: { r: number; c: number }[];
  /** Cells whose search hit the node cap — NOT proven safe. */
  unknownCells: { r: number; c: number }[];
  /** True when at least one cell is in `unknownCells`. */
  incomplete: boolean;
  /**
   * The mouse's CURRENT cell when it is dangerous, i.e. the cat already has a
   * kill on this turn wherever the mouse stands. The UI shows this differently
   * from an ordinary dangerous cell: leaving is still the mouse's only hope.
   */
  mouseCell: ThreatCell | null;
}

export interface ThreatOptions {
  maxNodesPerCell?: number;
}

/**
 * What the analyzer actually reads: every game-affecting field, and nothing else.
 *
 * A local `GameEngineState` satisfies it, and so does the online protocol's
 * `SnapshotState`, which is the same object minus these exact five debug/AI-only
 * fields (the server must not leak the opponent's AI internals). They are
 * excluded from `stateKey` too, so no conclusion here can depend on them —
 * which is why one shape serves single, local-dual and remote play instead of a
 * second state type.
 */
export type ThreatInputState = Omit<
  GameEngineState,
  'catActionLog' | 'gameEventLog' | 'lastHardSearch' | 'hardSearchHistory' | 'hardProgressGuardMemory'
>;

/** Debug-only fields the root clears (or supplies, when a snapshot omitted them). */
const DEBUG_CLEARED = {
  catActionLog: [],
  gameEventLog: [],
  lastHardSearch: null,
  hardSearchHistory: [],
  hardProgressGuardMemory: null,
} satisfies Partial<GameEngineState>;

const DEFAULT_MAX_NODES_PER_CELL = 20000;

/** Manhattan distance — used only as a SOUND cut, never as a verdict. */
function stepsToTarget(r: number, c: number, target: { r: number; c: number }): number {
  return Math.abs(r - target.r) + Math.abs(c - target.c);
}

/**
 * The state the cat actually faces when the mouse has just ended its action on
 * `target`. Only the fields the boundary itself changes are touched; every
 * terrain / butter / trap / tunnel field is the real one, and movement legality
 * is then whatever `catMove` says it is.
 */
export function buildCatTurnRoot(state: ThreatInputState, target: { r: number; c: number }): GameEngineState {
  // Asked mid-cat-turn, the honest horizon is what the cat has LEFT; asked on
  // the mouse's turn, the cat will start fresh with its whole-turn budget.
  const budget =
    state.phase === GamePhase.Playing && state.currentPlayer === PieceType.Cat
      ? state.catMovesLeft
      : state.config.catBaseMoves;
  return {
    ...state,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Cat,
    catMovesLeft: budget,
    mousePosition: target,
    // Debug-only fields, blanked last so they cannot influence anything here:
    // the transposition keys ignore them, and a remote snapshot never has them.
    ...DEBUG_CLEARED,
  };
}

type Verdict =
  | { kind: 'dangerous'; minimumSteps: number; witnessPath: string[] }
  | { kind: 'safe' }
  | { kind: 'unknown' };

/**
 * Breadth-first over the cat's legal moves. Returns the shortest witness, the
 * proof that none exists, or `unknown` when the node cap was reached.
 */
function findCaptureWithinTurn(root: GameEngineState, maxNodes: number): Verdict {
  interface Node {
    state: GameEngineState;
    path: string[];
  }
  const target = root.mousePosition;
  let frontier: Node[] = [{ state: root, path: [] }];
  const visited = new Set<string>([stateKey(root)]);
  let nodes = 0;

  for (let depth = 0; frontier.length > 0; depth++) {
    const nextFrontier: Node[] = [];
    for (const node of frontier) {
      for (const dir of DIRECTIONS) {
        const next = catMove(node.state, dir);
        // Illegal moves come back unchanged; a legal step always spends one of
        // the cat's steps, so that also rules out any no-op the engine might
        // hand back after normalising the board.
        if (next === node.state || next.catMovesLeft >= node.state.catMovesLeft) continue;
        if (next.phase === GamePhase.CatWins) {
          return { kind: 'dangerous', minimumSteps: depth + 1, witnessPath: [...node.path, dir.key] };
        }
        nodes++;
        if (nodes >= maxNodes) return { kind: 'unknown' };
        // Sound cut: one step moves the cat exactly one cell, so a node that can
        // no longer reach the mouse within its remaining budget can never be the
        // start of a witness.
        if (stepsToTarget(next.catPosition.r, next.catPosition.c, target) > next.catMovesLeft) continue;
        const key = stateKey(next);
        if (visited.has(key)) continue;
        visited.add(key);
        nextFrontier.push({ state: next, path: [...node.path, dir.key] });
      }
    }
    frontier = nextFrontier;
  }
  return { kind: 'safe' };
}

/** Where the mouse could conceivably end its action: not a wall, box, pile or void. */
function isStandable(state: ThreatInputState, r: number, c: number): boolean {
  const cell = state.board[r]?.[c];
  if (!cell) return false;
  if (cell.type === CellType.Box) return false;
  if (cell.type === CellType.Void) return false;
  if (cell.type === CellType.Pile) return false;
  if (cell.type === CellType.Wall) return false;
  return true;
}

/**
 * The danger region for the cat's next whole turn.
 *
 * Pure: same state in, same map out (no RNG, no Date, no engine mutation). The
 * caller decides where to show it; single / local-dual / online all get the same
 * answer because they all get it from the same `GameEngineState`.
 */
export function getCatThreatMap(state: ThreatInputState, options: ThreatOptions = {}): CatThreatMap {
  const maxNodes = options.maxNodesPerCell ?? DEFAULT_MAX_NODES_PER_CELL;
  const size = state.config.boardSize;
  const budget =
    state.phase === GamePhase.Playing && state.currentPlayer === PieceType.Cat
      ? state.catMovesLeft
      : state.config.catBaseMoves;

  const dangerousCells: ThreatCell[] = [];
  const safeCells: { r: number; c: number }[] = [];
  const unknownCells: { r: number; c: number }[] = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isInBounds(r, c, size) || !isStandable(state, r, c)) continue;
      // The cat's own cell is not a place the mouse can be standing and still
      // be in play — the game would already be over.
      if (state.catPosition.r === r && state.catPosition.c === c) continue;
      const target = { r, c };

      // Too far for the cat to reach at all: decided without any search, and
      // decided by the one rule even the cheapest witness must obey (a step
      // covers a single cell).
      if (stepsToTarget(state.catPosition.r, state.catPosition.c, target) > budget) {
        safeCells.push(target);
        continue;
      }

      const verdict = findCaptureWithinTurn(buildCatTurnRoot(state, target), maxNodes);
      if (verdict.kind === 'dangerous') {
        dangerousCells.push({ r, c, minimumSteps: verdict.minimumSteps, witnessPath: verdict.witnessPath });
      } else if (verdict.kind === 'safe') {
        safeCells.push(target);
      } else {
        unknownCells.push(target);
      }
    }
  }

  dangerousCells.sort((a, b) => a.minimumSteps - b.minimumSteps || a.r - b.r || a.c - b.c);
  const mouseCell =
    dangerousCells.find(d => d.r === state.mousePosition.r && d.c === state.mousePosition.c) ?? null;

  return {
    budget,
    catPosition: state.catPosition,
    dangerousCells,
    safeCells,
    unknownCells,
    incomplete: unknownCells.length > 0,
    mouseCell,
  };
}

/** Look up one cell; `null` means "not dangerous". */
export function threatCellAt(map: CatThreatMap, r: number, c: number): ThreatCell | null {
  return map.dangerousCells.find(d => d.r === r && d.c === c) ?? null;
}
