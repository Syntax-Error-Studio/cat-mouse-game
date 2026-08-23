import type { GameEngineState } from '../engine';
import { GamePhase } from '../types';
import { mouseCarryingDistanceToHole } from './evaluation';

/**
 * ============================================================================
 * G0.3B — Threat Classifier (PURE function, no side effects).
 * ============================================================================
 *
 * Classifies the goal-scoring threat level of a state for the mouse: how
 * urgently the mouse can reach a hole with butter.
 *
 * Design constraints (user-approved):
 *   - Uses the REAL BFS route from the evaluator's shared kernel
 *     (`mouseCarryingDistanceToHole`), NOT Manhattan distance.
 *   - Thresholds are derived from `state.config.mouseCarryingMoves` —
 *     NEVER hardcoded magic numbers.
 *   - Does NOT modify any game state, rules, or search value.
 *   - Does NOT call Math.random / Date.now.
 *   - Pure: same state → same result, always.
 *
 * The classifier is called at TWO points in the search:
 *   1. Move ordering: when the current node is classified as critical/near,
 *      actions are reordered to prioritize threat-relevant moves (cat blocks
 *      the route, mouse shortens it). This is an ORDERING KEY only — it never
 *      enters the SearchValue.
 *   2. Selective extension: when the search reaches its depth horizon and the
 *      state is `critical`, up to `maxThreatExtensions` additional turn-switch
 *      credits are granted to search deeper along that line.
 * ============================================================================
 */

export type ThreatUrgency = 'none' | 'near' | 'critical';

export interface GoalThreat {
  /** Whether the mouse is currently carrying butter. */
  mouseHasButter: boolean;
  /**
   * Real BFS route distance (in mouse steps) from the mouse to the nearest
   * hole cell in CARRYING mode (orthogonal-only, no tunnels).
   * null = mouse is not carrying butter, OR no legal route exists.
   */
  winRoute: number | null;
  /** Classified urgency level. */
  urgency: ThreatUrgency;
}

/**
 * Classify the goal-scoring threat of a state.
 *
 * Urgency semantics (thresholds derived from `mouseCarryingMoves`):
 *
 *   `none`:
 *     - Mouse does NOT carry butter, OR
 *     - No legal carrying-mode route to the hole exists (blocked by
 *       boxes/piles/walls), OR
 *     - Route is longer than 2 × mouseCarryingMoves (too far to be a threat).
 *
 *   `critical`:
 *     - Mouse carries butter, AND
 *     - winRoute ≤ mouseCarryingMoves (mouse can reach the hole within
 *       ONE mouse turn — immediate threat).
 *
 *   `near`:
 *     - Mouse carries butter, AND
 *     - winRoute ≤ mouseCarryingMoves × 2 (mouse can reach the hole within
 *       ~2 mouse turns — developing threat, not yet critical).
 *
 * The `mouseCarryingMoves` value comes from `state.config`, so a 5x5 board
 * with carryingMoves=2 and a 10x10 board with carryingMoves=3 get different
 * thresholds automatically — no hardcoded "3" assumption.
 */
export function classifyGoalThreat(state: GameEngineState): GoalThreat {
  const mouseHasButter = state.mouseHasButter;

  // No butter → no threat (the mouse cannot win without butter).
  if (!mouseHasButter) {
    return { mouseHasButter: false, winRoute: null, urgency: 'none' };
  }

  // Terminal states have no further threat to classify.
  if (state.phase !== GamePhase.Playing) {
    return { mouseHasButter: true, winRoute: null, urgency: 'none' };
  }

  // Real BFS route (orthogonal-only, no tunnels — mirrors carrying rules).
  const winRoute = mouseCarryingDistanceToHole(state);

  // No legal route → mouse is carrying but cannot reach the hole.
  if (winRoute === null) {
    return { mouseHasButter: true, winRoute: null, urgency: 'none' };
  }

  // Config-derived thresholds (NOT hardcoded).
  const carryingMoves = state.config.mouseCarryingMoves;
  const criticalThreshold = carryingMoves;       // 1 mouse turn
  const nearThreshold = carryingMoves * 2;        // ~2 mouse turns

  let urgency: ThreatUrgency;
  if (winRoute <= criticalThreshold) {
    urgency = 'critical';
  } else if (winRoute <= nearThreshold) {
    urgency = 'near';
  } else {
    urgency = 'none';
  }

  return { mouseHasButter: true, winRoute, urgency };
}
