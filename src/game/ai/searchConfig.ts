import type { SearchConfig } from './searchTypes';

/**
 * Default search parameters for the Hard (Search) AI.
 *
 * - maxDepthTurns: search depth counted in TURNS (action-right changes), not
 *   primitive steps. One turn = the cat's full move budget (or the mouse's).
 * - timeBudgetMsPerCatTurn: the search time budget is measured per COMPLETE
 *   cat turn, NOT per individual step. This avoids the old pattern of four
 *   independent ~100ms budgets inside computeCatAiTrajectory blocking the
 *   main thread four times per turn.
 * - useTranspositionTable / enableIterativeDeepening: flags for later phases;
 *   both OFF in B2 (infrastructure only).
 * - rng: reserved RNG source for chance-node (butter) sampling in later phases.
 */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  maxDepthTurns: 4,
  timeBudgetMsPerCatTurn: 100,
  useTranspositionTable: false,
  enableIterativeDeepening: false,
  rng: Math.random,
};
