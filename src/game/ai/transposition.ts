import type { GameEngineState } from '../engine';
import type { SearchAction } from './searchTypes';
import { pointSetKey } from './stateCompare';

/**
 * Compact, order-independent cell signature (type + piece + butter flag).
 * The board is a fixed grid, so row-major serialization is already canonical
 * (no permutation ambiguity).
 */
function boardKey(board: GameEngineState['board']): string {
  const parts: string[] = [];
  for (let r = 0; r < board.length; r++) {
    const row = board[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      const piece = cell.piece ?? '_';
      const butter = cell.hasButter ? 'B' : '_';
      parts.push(`${cell.type[0]}${piece[0]}${butter}`);
    }
  }
  return parts.join('');
}

/**
 * Canonical transposition-table key.
 *
 * Includes ONLY game-AFFECTING fields. Explicitly EXCLUDES `message`,
 * `catActionLog`, and `gameEventLog` (debug-only strings). Set-typed fields
 * (butterPositions, blockedTunnels, tunnelExitChoices) are canonicalized via
 * pointSetKey so array order does not create spurious distinct keys.
 *
 * `tunnelExitChoices` IS included: at a ChoosingTunnelExit node, which exits
 * are available is part of the state and must distinguish transpositions.
 *
 * A small config signature is included so two boards that happen to be
 * identical in every other field but were generated under different move
 * counts / butter counts are not treated as the same position.
 */
export function stateKey(state: GameEngineState): string {
  const s = state;
  const cfg = s.config;
  return [
    boardKey(s.board),
    s.gameMode,
    s.phase,
    s.currentPlayer,
    `${s.catPosition.r},${s.catPosition.c}`,
    `${s.mousePosition.r},${s.mousePosition.c}`,
    s.catMovesLeft,
    s.mouseMovesLeft,
    pointSetKey(s.butterPositions),
    s.mouseHasButter ? 1 : 0,
    s.mouseSkillActive ? 1 : 0,
    s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : '_',
    s.catTrapsRemaining,
    pointSetKey(s.blockedTunnels),
    pointSetKey(s.tunnelExitChoices),
    `${cfg.boardSize}:${cfg.mouseBaseMoves}:${cfg.mouseCarryingMoves}:${cfg.mouseSkillExtraMoves}:${cfg.catBaseMoves}:${cfg.butterCount}:${cfg.gameMode}:${cfg.difficulty}`,
  ].join('#');
}

/**
 * ============================================================================
 * Phase D1 — EXACT Transposition Table entry.
 * ============================================================================
 *
 * A TT entry stores the COMPLETE node-local search result for one state, never
 * just the numeric value. The `mate` classification is mandatory so that the
 * lexicographic (category-first) comparison in `preferResult` survives a cache
 * hit: restoring `value` with `mate = null` would let a high-but-non-mate value
 * outrank a genuine forced mate on the next probe.
 *
 * `depthTurns` is stored ON the entry (NOT folded into the key string) so D1 can
 * require an EXACT depth match before reuse — no `>=` relaxation, no LOWER/
 * UPPER bounds yet (those arrive in D2). `bestAction` is recorded for the
 * current node (never a child's) and reserved for D3 move ordering; D1 does not
 * consume it to change search order.
 *
 * Invariant: an entry exists in the table ONLY when its result was
 * `completed && cacheable`. A repetition-dependent result or a budget-truncated
 * result is forbidden from being stored, so every entry is a genuine,
 * path-independent, full-depth EXACT value. Therefore the mere presence of an
 * entry implies `completed = true` and `cacheable = true`.
 */
export interface TTEntry {
  depthTurns: number;
  value: number;
  mate: 'cat' | 'mouse' | null;
  bestAction?: SearchAction;
}

/**
 * One search owns exactly one transposition table. There is NO global
 * singleton, NO cross-game persistence, NO localStorage, and NO sharing between
 * different RuleSets: two differently-ruled contexts that happen to produce the
 * same `stateKey` would otherwise collide on search semantics. The table is
 * created fresh inside `createSearchContext` and never escapes it.
 */
export class TranspositionTable {
  private map = new Map<string, TTEntry>();

  get size(): number {
    return this.map.size;
  }

  get(key: string): TTEntry | undefined {
    return this.map.get(key);
  }

  set(key: string, entry: TTEntry): void {
    this.map.set(key, entry);
  }
}
