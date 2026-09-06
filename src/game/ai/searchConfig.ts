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

/**
 * G0.3X — Human Hard Validation build configuration (feature flag ON).
 *
 * This is the FROZEN trial configuration from G0.3W (§24 verdict
 * READY_FOR_HUMAN_VALIDATION, §18 TRIAL_BUDGET = 150ms). The bounded
 * refutation sidecar is ENABLED for local Hard play. The 100ms baseline
 * search budget is UNCHANGED; the sidecar runs only in the remaining time
 * inside the 150ms total-turn budget.
 *
 * Easy / Medium never take the refutation path (the flag is read only by the
 * Hard planner call sites). No selector / ordering / comparator / evaluator
 * changes. This is a trial build, not a release; do not commit.
 */
export const HARD_TRIAL = {
  refutationEnabled: true,
  totalTurnBudgetMs: 150,
} as const;

/**
 * G0.4E-1 / G0.4F-1.3 / G0.4F-2B-1.2 — Feature-flagged Hard leaf mode.
 *
 * Default = 'baseline' (byte-identical to current production; the Hard leaf is
 * evaluateForCat exactly as before).
 *   - 'baseline_hole_corrected'      → H1 leaf (G0.4F-2B-1.2): corrected
 *                                      both-reachable holeControl sign only,
 *                                      every other contribution untouched.
 *                                      NO eligibility gate — H1 is not a
 *                                      ValueNet; it evaluates ghost/debt states
 *                                      normally (ghost gameplay itself is
 *                                      handled by the search transitions).
 *   - 'hybrid_standard_only'         → validated Hybrid V1 leaf (G0.4E), only on
 *                                      canonical standard-map states (fail-closed
 *                                      eligibility inside hybridLeaf.ts).
 *   - 'hybrid_route_v2_standard_only'→ F12-confirmed Hybrid V2 (route-aware +
 *                                      corrected holeControl) leaf, only on
 *                                      canonical standard-map states.
 * This is a TRIAL switch — production default stays 'baseline'; one-key revert =
 * set back to 'baseline'.
 */
export const HARD_LEAF_MODE_DEFAULT = 'baseline' as const;
export type HardLeafModeConfig = 'baseline' | 'baseline_hole_corrected' | 'hybrid_standard_only' | 'hybrid_route_v2_standard_only';
export const HARD_LEAF_MODE_CONFIG: { current: HardLeafModeConfig } = {
  current: HARD_LEAF_MODE_DEFAULT,
};

/**
 * G0.4F-2B-1.6 — M3-lite Progress Guard feature flag (DEFAULT OFF).
 *
 * Independent from HARD_LEAF_MODE_CONFIG: the guard is NOT a leaf evaluator —
 * it is a root-level rescue policy that can replace the *final* cat plan with
 * the previous completed depth's plan when a repeated no-progress closed loop
 * is detected (F2B-1.5 prototype, preflight-authorization pending).
 *
 * First-version eligibility is deliberately narrow (§19): difficulty hard ∧
 * leafMode 'baseline_hole_corrected' ∧ enabled ∧ mouseHasButter ∧ no
 * pendingGhosts ∧ no placementDebt ∧ search.mate==null ∧ completedDepth>=2.
 * baseline / V1 / V2 are IMMUNE to it.
 *
 * Kill switch = flip back to false (byte-identical to pre-F2B-1.6 behavior).
 */
export const HARD_PROGRESS_GUARD_DEFAULT = false as const;
export const HARD_PROGRESS_GUARD_CONFIG: { enabled: boolean } = {
  enabled: HARD_PROGRESS_GUARD_DEFAULT,
};
