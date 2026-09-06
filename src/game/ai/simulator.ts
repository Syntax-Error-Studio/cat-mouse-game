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
      return forceEndTurnIfNeeded(next, rules);
    }
    case 'catPlaceTrap': {
      const next = rules.catPlaceTrap(state);
      return { kind: 'deterministic', state: next };
    }
    case 'mouseStep': {
      // Deterministic mouse step (ghost-butter announcement DEFERRED). No Math.random.
      const next = rules.mouseStep(state, action.direction);

      // The only stochastic element: a butter was consumed (removed, not yet
      // announced as a ghost). Build a CHANCE node from the enumerated legal
      // ghost spawn cells (each outcome ADDS a pending ghost, not an entity
      // butter).
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
      return forceEndTurnIfNeeded(next, rules);
    }
  }
}

/**
 * Force the action-right hand-off when the current player has exhausted their
 * move budget and the phase is still Playing. This is the simulator's
 * substitute for an explicit `endTurn` SearchAction.
 *
 * Returns a SearchTransitionResult:
 *   - CAT→MOUSE with pending ghost-butter spawns → the ghost-boundary CHANCE
 *     node (deterministic parts resolved in the shared core, random new-ghost
 *     positions enumerated), so the search never calls Math.random.
 *   - otherwise → deterministic `rules.endTurn`.
 *
 *  - Cat: when `catMovesLeft <= 0` the turn passes to the mouse.
 *  - Mouse (after a tunnel-exit choice): `chooseTunnelExit` leaves the mouse
 *    with 0 moves but does NOT end the turn, so we end it here.
 *
 * If the resulting state is already terminal (CatWins / MouseWins) or still in
 * a tunnel-choice, or was already flipped to the other player (mouse stepping
 * on a trap), no endTurn is applied (it would wrongly flip the actor back).
 */
function forceEndTurnIfNeeded(state: GameEngineState, rules: RuleSet): SearchTransitionResult {
  if (state.phase !== GamePhase.Playing) return { kind: 'deterministic', state }; // terminal or tunnel-choice

  const noMovesLeft = state.currentPlayer === PieceType.Mouse
    ? state.mouseMovesLeft <= 0
    : state.catMovesLeft <= 0;
  if (!noMovesLeft) return { kind: 'deterministic', state };

  // G0.4F-2A/2A.1: CAT→MOUSE with pending ghost-butter spawns OR placement
  // debt MUST be resolved via the honest CHANCE builder (never falls through to
  // `rules.endTurn`, which samples Math.random for ghost positions). The builder
  // is REQUIRED to return a non-empty result for such states; if it ever did not
  // (a RuleSet contract violation), we fail loudly rather than silently sample
  // Math.random through engine.endTurn.
  const hasGhosts = (state.pendingButterSpawns?.length ?? 0) > 0;
  const hasDebt = (state.pendingButterPlacementDebt ?? 0) > 0;
  if (state.currentPlayer === PieceType.Cat && (hasGhosts || hasDebt)) {
    if (!rules.resolveGhostBoundaryChance) {
      throw new Error('RuleSet missing resolveGhostBoundaryChance for CAT→MOUSE ghost/debt boundary');
    }
    const chance = rules.resolveGhostBoundaryChance(state);
    if (chance && chance.length > 0) return { kind: 'chance', outcomes: chance };
    throw new Error('resolveGhostBoundaryChance returned null for a ghosts/debt CAT→MOUSE boundary (hidden-random fallback blocked)');
  }

  // Reached only when the current player has spent their last move:
  //  - catStep that brought catMovesLeft to 0  -> hand off to the mouse.
  //  - chooseTunnelExit (mouse, 0 moves left)  -> hand off to the cat.
  // A mouse trap-step flips currentPlayer to Cat with catMovesLeft>0, so
  // noMovesLeft is false and we never wrongly flip the actor back.
  return { kind: 'deterministic', state: rules.endTurn(state) };
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
 * Engine-free default CHANCE builder: enumerate every legal ghost spawn cell
 * (via the injected RuleSet) and assign UNIFORM weight 1/N. Each outcome ADDS
 * a pending ghost (future-spawn marker) — NOT an entity butter — mirroring the
 * real game's `generateSingleButterPosition` ghost announce. This keeps the
 * search honest about real probabilities. Used only when a RuleSet does not
 * supply its own `buildButterChance`.
 *
 * G0.4F-2A.1: when there are NO legal candidates, the one-for-one replacement
 * obligation is preserved as placement debt (+1) in a single deterministic
 * outcome — it is never dropped, and never falls through to a no-op.
 */
function defaultBuildButterChance(
  state: GameEngineState,
  rules: RuleSet,
): { state: GameEngineState; weight: number }[] | null {
  const cells = rules.enumerateButterSpawns(state);
  if (!cells || cells.length === 0) {
    return [{ state: { ...state, pendingButterPlacementDebt: (state.pendingButterPlacementDebt ?? 0) + 1 }, weight: 1 }];
  }
  const weight = 1 / cells.length;
  return cells.map((c) => ({
    state: {
      ...state,
      pendingButterSpawns: [...(state.pendingButterSpawns ?? []), { r: c.r, c: c.c, blockedMaterializations: 0 }],
    },
    weight,
  }));
}
