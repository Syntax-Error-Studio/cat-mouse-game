import type { GameEngineState } from '../engine';
import { DIRECTIONS, GamePhase, PieceType } from '../types';
import type { RuleSet, SearchAction, SearchTransitionResult } from './searchTypes';
import { gameAffectingEqual } from './stateCompare';
import { simulateSearchAction } from './simulator';

/**
 * PPC-P2-PREPARED-TRANSITION-01 — the single source of truth for "which
 * primitive SearchActions may be considered from this state, in which order".
 *
 * Before this round the enumeration and the legality check were fused inside
 * `generateLegalSearchActions`, which forced the search to simulate every
 * candidate for legality and then simulate every SURVIVOR a second time to
 * build the transition it actually recursed on. This module splits the two
 * concerns without changing either of them:
 *
 *   enumerateSearchActionCandidates  → candidates + "must I verify legality?"
 *   generatePreparedSearchActions    → candidates, verified ONCE, transition kept
 *
 * and `generateLegalSearchActions` is re-expressed on top of the enumeration so
 * the action ORDER, the precondition guards and the legality predicate exist in
 * exactly one place (a duplicated copy of this logic is the failure mode the
 * round brief calls out).
 *
 * Fidelity notes (all pre-existing behaviour, reproduced verbatim):
 *  - terminal phases yield nothing;
 *  - `ChoosingTunnelExit` yields one action per `tunnelExitChoices` entry and
 *    these are legal BY CONSTRUCTION — the legacy generator never simulated
 *    them, and it still doesn't;
 *  - `endTurn` is never an action (the simulator forces the hand-off);
 *  - legality = "applying it changes something game-affecting", with a CHANCE
 *    transition (butter pickup) always counting as a real move.
 */

/** A candidate action plus whether its legality has to be verified by simulation. */
export interface SearchActionCandidate {
  action: SearchAction;
  /**
   * `false` only for the tunnel-exit list, whose entries come straight from the
   * state and are legal by construction (the legacy generator emitted them
   * without a legality simulation — preserved). `true` for every action that
   * must be applied once to decide whether it is a real move.
   */
  verifyEffectiveness: boolean;
}

/**
 * Candidate SearchActions for `state`, in the historical generation order
 * (`DIRECTIONS` order, then skill/trap). Pure: no simulation, no RNG.
 */
export function enumerateSearchActionCandidates(
  state: GameEngineState,
): SearchActionCandidate[] {
  const out: SearchActionCandidate[] = [];

  if (state.phase === GamePhase.CatWins || state.phase === GamePhase.MouseWins) {
    return out;
  }

  if (state.phase === GamePhase.ChoosingTunnelExit) {
    for (const choice of state.tunnelExitChoices) {
      out.push({
        action: { type: 'chooseTunnel', r: choice.r, c: choice.c },
        verifyEffectiveness: false,
      });
    }
    return out;
  }

  // phase === Playing
  if (state.currentPlayer === PieceType.Mouse) {
    for (const d of DIRECTIONS) {
      out.push({ action: { type: 'mouseStep', direction: d }, verifyEffectiveness: true });
    }
    if (state.mouseHasButter && !state.mouseSkillActive) {
      out.push({ action: { type: 'mouseSkill' }, verifyEffectiveness: true });
    }
  } else {
    for (const d of DIRECTIONS) {
      out.push({ action: { type: 'catStep', direction: d }, verifyEffectiveness: true });
    }
    if (state.trapPosition === null && state.catTrapsRemaining > 0) {
      out.push({ action: { type: 'catPlaceTrap' }, verifyEffectiveness: true });
    }
  }

  return out;
}

/** A legal action bundled with the transition that proved it legal. */
export interface PreparedSearchAction {
  action: SearchAction;
  /**
   * The successor(s) produced while confirming legality. Because every engine
   * transition is pure (it returns a NEW state and never mutates its input),
   * this object is a private snapshot of this node: it may be read by the
   * subtree, never written.
   */
  transition: SearchTransitionResult;
  /** Index in the LEGAL action list — the historical stable tie-break key. */
  originalIndex: number;
}

/**
 * Generate the legal SearchActions for `state` AND the transition that made
 * each one legal, applying every candidate through the injected RuleSet exactly
 * once.
 *
 * This is the search hot path's replacement for
 * `generateLegalSearchActions(state, rules)` followed by one
 * `simulateSearchAction(state, action, rules)` per surviving action. The
 * returned list is IDENTICAL (same actions, same order, same `originalIndex`
 * semantics) to what that two-step dance produced — the only difference is that
 * the second simulation no longer happens.
 *
 * The batch is node-local: no caching across nodes, no shared mutable state.
 */
export function generatePreparedSearchActions(
  state: GameEngineState,
  rules: RuleSet,
): PreparedSearchAction[] {
  const out: PreparedSearchAction[] = [];

  for (const cand of enumerateSearchActionCandidates(state)) {
    const transition = simulateSearchAction(state, cand.action, rules);
    const legal = !cand.verifyEffectiveness
      || transition.kind === 'chance' // a butter pickup is a real move
      || !gameAffectingEqual(state, transition.state);
    if (legal) {
      out.push({ action: cand.action, transition, originalIndex: out.length });
    }
  }

  return out;
}
