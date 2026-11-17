/**
 * PPC-MCTS-01 — unified cat-perspective reward scale.
 *
 * Terminal states are separated from heuristic leaves:
 *   CatWins   → +1
 *   MouseWins → -1
 *   otherwise → 0.8 * tanh(hybridEvaluateForCat(state) / 2)  ∈ (-0.8, 0.8)
 *
 * The same mapping is applied by UCT-R, UCT-H and by the MCTS leaf evaluator,
 * so the three terminal/ordinary regions can never be confused numerically.
 * `hybridEvaluateForCat` remains the single leaf evaluator (frozen weights,
 * eligibility gate and out-of-domain fallback unchanged).
 */
import type { GameEngineState } from '../../src/game/engine';
import { GamePhase } from '../../src/game/types';

export const CAT_WIN_REWARD = 1;
export const MOUSE_WIN_REWARD = -1;
export const HEURISTIC_SCALE = 0.8;
export const HEURISTIC_TANH_SCALE = 2;

export function terminalReward(state: GameEngineState): number | null {
  if (state.phase === GamePhase.CatWins) return CAT_WIN_REWARD;
  if (state.phase === GamePhase.MouseWins) return MOUSE_WIN_REWARD;
  return null;
}

export function normalizeLeafValue(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return HEURISTIC_SCALE * Math.tanh(raw / HEURISTIC_TANH_SCALE);
}
