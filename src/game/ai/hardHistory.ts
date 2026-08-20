import type { GameEngineState } from '../engine';
import type { SearchAction } from './searchTypes';
import type { MateSide } from './expectiminimax';
import { stateKey } from './transposition';

/**
 * ============================================================================
 * G0.2 — Exact Hard-root history (DEBUG ONLY).
 *
 * Stores a bounded history of every Hard cat-turn root as an EXACT
 * game-affecting snapshot, so a lost real game can be replayed offline to find
 * the Point of No Return ("which turn did it become a forced loss").
 *
 * Rules:
 *   - snapshots are DEEP copies (no live references to the running state);
 *   - the history field on GameEngineState is EXCLUDED from
 *     `gameAffectingEqual` / `stateKey` / TT (see those modules — they only
 *     compare the specific game-affecting fields, and we never add history to
 *     them), so saving history NEVER changes AI behavior;
 *   - bounded: at most `HARD_HISTORY_LIMIT` entries (oldest dropped).
 * ============================================================================
 */

/** Max number of Hard cat-turn roots kept per game (debug only). */
export const HARD_HISTORY_LIMIT = 20;

/** Exact deep snapshot of every GAME-AFFECTING field of a root state. */
export interface HardRootSnapshot {
  board: GameEngineState['board'];
  config: GameEngineState['config'];
  gameMode: GameEngineState['gameMode'];
  phase: GameEngineState['phase'];
  currentPlayer: GameEngineState['currentPlayer'];
  catPosition: { r: number; c: number };
  mousePosition: { r: number; c: number };
  catMovesLeft: number;
  mouseMovesLeft: number;
  butterPositions: { r: number; c: number }[];
  mouseHasButter: boolean;
  mouseSkillActive: boolean;
  trapPosition: { r: number; c: number } | null;
  catTrapsRemaining: number;
  blockedTunnels: { r: number; c: number }[];
  tunnelExitChoices: { r: number; c: number; label: string }[];
}

export interface HardProductionDiag {
  completedDepth: number;
  attemptedDepth: number;
  nodes: number;
  elapsedMs: number;
  rootValue: number;
  mate: MateSide;
  plan: SearchAction[];
  rootValues: { action: SearchAction; value: number; mate: MateSide }[];
}

/** Execution link: what the production trajectory actually did + end key. */
export interface HardHistoryExecution {
  plan: SearchAction[];
  /** stateKey of the state at the END of the cat turn (POST-plan, before
   *  the separate `endTurn` call). null if the turn could not execute. */
  endStateKey: string | null;
  /** True if the executed trajectory's final state matched the plan replay. */
  matchedPlan: boolean;
}

/** One saved Hard turn root. */
export interface HardSearchHistoryEntry {
  /** Monotonic turn counter (1-based, per game). */
  turn: number;
  /** stateKey of the EXACT root snapshot. */
  stateKey: string;
  /** Deep snapshot of the game-affecting root state (no shared refs). */
  root: HardRootSnapshot;
  /** Production search diagnostics at that root. */
  production: HardStateDiag;
  /** Execution linkage (filled after the cat turn completes). */
  execution: HardHistoryExecution;
}

/** Alias so both consumers read the same block type. */
export type HardStateDiag = HardProductionDiag;
export type HardStateExecution = HardHistoryExecution;

/** Deep snapshot (game-affecting fields only; debug fields excluded). */
export function captureHardRoot(state: GameEngineState): HardRootSnapshot {
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  return {
    board: clone(state.board),
    config: clone(state.config),
    gameMode: state.gameMode,
    phase: state.phase,
    currentPlayer: state.currentPlayer,
    catPosition: { ...state.catPosition },
    mousePosition: { ...state.mousePosition },
    catMovesLeft: state.catMovesLeft,
    mouseMovesLeft: state.mouseMovesLeft,
    butterPositions: clone(state.butterPositions),
    mouseHasButter: state.mouseHasButter,
    mouseSkillActive: state.mouseSkillActive,
    trapPosition: state.trapPosition ? { ...state.trapPosition } : null,
    catTrapsRemaining: state.catTrapsRemaining,
    blockedTunnels: clone(state.blockedTunnels),
    tunnelExitChoices: clone(state.tunnelExitChoices),
  };
}

/** Rebuild a full GameEngineState from a snapshot (debug/offline replay). */
export function restoreHardRoot(snap: HardRootSnapshot): GameEngineState {
  return {
    board: JSON.parse(JSON.stringify(snap.board)) as GameEngineState['board'],
    config: JSON.parse(JSON.stringify(snap.config)) as GameEngineState['config'],
    gameMode: snap.gameMode,
    phase: snap.phase,
    currentPlayer: snap.currentPlayer,
    catPosition: { ...snap.catPosition },
    mousePosition: { ...snap.mousePosition },
    catMovesLeft: snap.catMovesLeft,
    mouseMovesLeft: snap.mouseMovesLeft,
    butterPositions: JSON.parse(JSON.stringify(snap.butterPositions)),
    mouseHasButter: snap.mouseHasButter,
    mouseSkillActive: snap.mouseSkillActive,
    trapPosition: snap.trapPosition ? { ...snap.trapPosition } : null,
    catTrapsRemaining: snap.catTrapsRemaining,
    blockedTunnels: JSON.parse(JSON.stringify(snap.blockedTunnels)),
    message: '',
    tunnelExitChoices: JSON.parse(JSON.stringify(snap.tunnelExitChoices)),
    catActionLog: [],
    gameEventLog: [],
    lastHardSearch: null,
    hardSearchHistory: [],
  };
}

/** True iff the snapshot deep-equals another snapshot (game-affecting). */
export function snapshotsEqual(a: HardRootSnapshot, b: HardRootSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Append a history entry (bounded). Returns the new (immutable) array. */
export function pushHardHistory(
  history: HardSearchHistoryEntry[],
  entry: HardSearchHistoryEntry,
  limit = HARD_HISTORY_LIMIT,
): HardSearchHistoryEntry[] {
  const next = [...history, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Compute the exact stateKey of a root snapshot WITHOUT restoring a state. */
export function snapshotStateKey(snap: HardRootSnapshot): string {
  return stateKey(restoreHardRoot(snap));
}

/**
 * Make a history entry from a live root state + production diag.
 * The snapshot is taken NOW (deep); `execution` is left pending until the
 * turn actually executes (fillExecution).
 */
export function makeHardHistoryEntry(
  state: GameEngineState,
  turn: number,
  prod: HardProductionDiag,
): HardSearchHistoryEntry {
  return {
    turn,
    stateKey: stateKey(state),
    root: captureHardRoot(state),
    production: prod,
    execution: { plan: prod.plan, endStateKey: null, matchedPlan: false },
  };
}