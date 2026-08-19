import type { GameEngineState } from '../engine';
import { DIRECTIONS, GamePhase, PieceType } from '../types';
import type { RuleSet, SearchAction } from './searchTypes';
import { gameAffectingEqual } from './stateCompare';
import { simulateSearchAction } from './simulator';

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
 */
export function generateLegalSearchActions(
  state: GameEngineState,
  rules: RuleSet,
): SearchAction[] {
  const actions: SearchAction[] = [];

  if (state.phase === GamePhase.CatWins || state.phase === GamePhase.MouseWins) {
    return actions;
  }

  if (state.phase === GamePhase.ChoosingTunnelExit) {
    for (const choice of state.tunnelExitChoices) {
      actions.push({ type: 'chooseTunnel', r: choice.r, c: choice.c });
    }
    return actions;
  }

  // phase === Playing
  if (state.currentPlayer === PieceType.Mouse) {
    for (const d of DIRECTIONS) {
      const cand: SearchAction = { type: 'mouseStep', direction: d };
      if (isEffective(cand, state, rules)) actions.push(cand);
    }
    if (state.mouseHasButter && !state.mouseSkillActive) {
      const cand: SearchAction = { type: 'mouseSkill' };
      if (isEffective(cand, state, rules)) actions.push(cand);
    }
  } else {
    for (const d of DIRECTIONS) {
      const cand: SearchAction = { type: 'catStep', direction: d };
      if (isEffective(cand, state, rules)) actions.push(cand);
    }
    if (state.trapPosition === null && state.catTrapsRemaining > 0) {
      const cand: SearchAction = { type: 'catPlaceTrap' };
      if (isEffective(cand, state, rules)) actions.push(cand);
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
