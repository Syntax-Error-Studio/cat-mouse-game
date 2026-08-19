import type { GameEngineState } from '../engine';
import { GamePhase, PieceType } from '../types';
import type {
  RuleSet,
  SearchAction,
  SearchTransitionResult,
} from './searchTypes';
import { gameAffectingEqual } from './stateCompare';

/**
 * Apply one SearchAction to `state` using the injected RuleSet.
 *
 * This module is intentionally ENGINE-FREE: it imports only types and the
 * shared comparison helpers. All real transition logic comes from the RuleSet
 * passed in (bound in `ai/searchRules.ts`). This is what prevents the
 * `engine -> searchHard -> simulator -> engine` cycle.
 *
 * Turn hand-off (`endTurn`) is NOT an exposed action — it is a FORCED
 * transition applied here when the current player has no moves left (cat after
 * its last step, mouse after a tunnel-exit choice). The mouse's own move
 * already ends the turn internally (trap flip / moves-exhausted), so no extra
 * endTurn is applied there.
 *
 * @returns a SearchTransitionResult.
 *  - `chance` is produced ONLY when the mouse eats a butter: the simulator
 *    enumerates every legal spawn cell (via `enumerateButterSpawns`) and emits
 *    one equally-weighted outcome per cell. No Math.random is ever called.
 *  - everything else is `deterministic`.
 */
export function simulateSearchAction(
  state: GameEngineState,
  action: SearchAction,
  rules: RuleSet,
): SearchTransitionResult {
  switch (action.type) {
    case 'catStep': {
      const next = rules.catMove(state, action.direction);
      return { kind: 'deterministic', state: forceEndTurnIfNeeded(next, rules) };
    }
    case 'catPlaceTrap': {
      const next = rules.catPlaceTrap(state);
      return { kind: 'deterministic', state: next };
    }
    case 'mouseStep': {
      // Deterministic mouse step (butter regeneration DEFERRED). No Math.random.
      const next = rules.mouseStep(state, action.direction);

      // The only stochastic element: a butter was consumed (removed, not yet
      // regenerated). Build a CHANCE node from the enumerated legal spawns.
      const pickedButter = next.butterPositions.length === state.butterPositions.length - 1;
      if (pickedButter) {
        const built = rules.buildButterChance
          ? rules.buildButterChance(next)
          : defaultBuildButterChance(next, rules);
        if (built && built.length > 0) {
          return { kind: 'chance', outcomes: built };
        }
      }
      return { kind: 'deterministic', state: next };
    }
    case 'mouseSkill': {
      const next = rules.mouseSkill(state);
      return { kind: 'deterministic', state: next };
    }
    case 'chooseTunnel': {
      const next = rules.chooseTunnelExit(state, action.r, action.c);
      return { kind: 'deterministic', state: forceEndTurnIfNeeded(next, rules) };
    }
  }
}

/**
 * Force the action-right hand-off when the current player has exhausted their
 * move budget and the phase is still Playing. This is the simulator's
 * substitute for an explicit `endTurn` SearchAction.
 *
 *  - Cat: when `catMovesLeft <= 0` the turn passes to the mouse.
 *  - Mouse (after a tunnel-exit choice): `chooseTunnelExit` leaves the mouse
 *    with 0 moves but does NOT end the turn, so we end it here.
 *
 * If the resulting state is already terminal (CatWins / MouseWins) or still in
 * a tunnel-choice, or was already flipped to the other player (mouse stepping
 * on a trap), no endTurn is applied (it would wrongly flip the actor back).
 */
function forceEndTurnIfNeeded(state: GameEngineState, rules: RuleSet): GameEngineState {
  if (state.phase !== GamePhase.Playing) return state; // terminal or tunnel-choice

  const noMovesLeft = state.currentPlayer === PieceType.Mouse
    ? state.mouseMovesLeft <= 0
    : state.catMovesLeft <= 0;
  if (!noMovesLeft) return state;

  // Reached only when the current player has spent their last move:
  //  - catStep that brought catMovesLeft to 0  -> hand off to the mouse.
  //  - chooseTunnelExit (mouse, 0 moves left)  -> hand off to the cat.
  // A mouse trap-step flips currentPlayer to Cat with catMovesLeft>0, so
  // noMovesLeft is false and we never wrongly flip the actor back.
  return rules.endTurn(state);
}

/**
 * True iff applying `action` to `state` produces NO game-affecting change
 * (i.e. the action is illegal / blocked and should be filtered out).
 */
export function isNoOpAction(
  state: GameEngineState,
  action: SearchAction,
  rules: RuleSet,
): boolean {
  const res = simulateSearchAction(state, action, rules);
  if (res.kind === 'chance') return false; // a butter pickup is a real move
  return gameAffectingEqual(state, res.state);
}

/**
 * Engine-free default CHANCE builder: enumerate every legal spawn cell (via the
 * injected RuleSet) and assign UNIFORM weight 1/N. This exactly mirrors the
 * real game's `generateSingleButterPosition`, which draws ONE cell uniformly
 * from `enumerateButterSpawns`. Used only when a RuleSet does not supply its
 * own `buildButterChance`.
 */
function defaultBuildButterChance(
  state: GameEngineState,
  rules: RuleSet,
): { state: GameEngineState; weight: number }[] | null {
  const cells = rules.enumerateButterSpawns(state);
  if (!cells || cells.length === 0) return null;
  const weight = 1 / cells.length;
  return cells.map((c) => ({
    state: { ...state, butterPositions: [...state.butterPositions, c] },
    weight,
  }));
}
