import type { GameEngineState } from '../engine';
import type { RuleSet, SearchAction } from './searchTypes';
import { gameAffectingEqual } from './stateCompare';
import { simulateSearchAction } from './simulator';
import { enumerateSearchActionCandidates } from './preparedActions';

/**
 * Generate the legal SearchActions for a given state.
 *
 * Faithful to the real engine's turn mechanics:
 *  - Non-playing terminal phases (CatWins / MouseWins) -> no actions.
 *  - ChoosingTunnelExit phase -> only the chooseTunnel exits.
 *  - Playing + Mouse actor -> mouseStep for each legal direction, and
 *      mouseSkill (if carrying butter and not yet active).
 *  - Playing + Cat actor -> catStep for each legal direction, and catPlaceTrap
 *      (if a trap can be dropped).
 *
 * `endTurn` is intentionally NOT generated (see searchTypes.ts): the turn
 * hand-off is a FORCED transition applied by the simulator when the current
 * player has no moves left. Legality is verified by actually applying each
 * candidate through the injected RuleSet and checking for a game-affecting
 * change (no-op => illegal), so the legal set can never silently diverge
 * from what the game would allow.
 *
 * PPC-P2-PREPARED-TRANSITION-01: the candidate enumeration (which actions, in
 * which order, behind which precondition) now lives in `preparedActions.ts` so
 * the search hot path can reuse the SAME enumeration and keep the transition it
 * already paid for. This function's contract is unchanged — it still returns
 * plain `SearchAction[]`, still simulates one candidate at a time, and still
 * emits tunnel exits without a legality simulation.
 */
export function generateLegalSearchActions(
  state: GameEngineState,
  rules: RuleSet,
): SearchAction[] {
  const actions: SearchAction[] = [];

  for (const cand of enumerateSearchActionCandidates(state)) {
    if (!cand.verifyEffectiveness || isEffective(cand.action, state, rules)) {
      actions.push(cand.action);
    }
  }

  return actions;
}

/** True iff applying `cand` yields a game-affecting change (i.e. is legal). */
function isEffective(
  cand: SearchAction,
  state: GameEngineState,
  rules: RuleSet,
): boolean {
  const res = simulateSearchAction(state, cand, rules);
  if (res.kind === 'chance') return true; // a butter pickup is a real move
  return !gameAffectingEqual(state, res.state);
}
