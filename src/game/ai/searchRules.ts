import type { RuleSet } from './searchTypes';
import {
  mouseStepDeterministic,
  catMove,
  mouseSkill,
  catPlaceTrap,
  endTurn,
  enumerateButterSpawns,
  getTunnelCorners,
  type GameEngineState,
} from '../engine';
import { chooseTunnelExit } from '../rules/tunnels';

/**
 * The single binding point between the search subsystem and the REAL engine
 * transitions.
 *
 * The simulator receives this RuleSet and never imports engine.ts directly,
 * which is what prevents the fragile
 *   engine -> searchHard -> simulator -> engine
 * cycle. To wire the Search AI at Phase F, engine.ts will only import a tiny
 * strategy-registry (NOT this module or the simulator), so no runtime cycle
 * can form even then.
 *
 * Because these ARE the engine's own functions, the simulator is, by
 * construction, identical to the real game — no simplified "fake" rules.
 *
 *  - `mouseStep` is the DETERMINISTIC mouse transition: it performs the move
 *    and butter PICKUP but defers regeneration. The simulator turns a butter
 *    pickup into an honest CHANCE node via `enumerateButterSpawns` — so the
 *    search never calls Math.random.
 *  - `enumerateButterSpawns` lists every legal new-butter cell (pure, no RNG).
 *  - `endTurn` is used internally by the simulator to FORCE the turn hand-off
 *    (it is NOT an exposed SearchAction).
 */
// `enumerateButterSpawns` in the engine is a pure 7-arg utility
// (config, board, tunnelCorners, mousePos, catPos, existingButters, trapPos).
// The RuleSet contract is the ergonomic `(state) => Point[]`, so we adapt here
// — this is the only place that knows both shapes, keeping the simulator
// engine-free.
function enumerateButterSpawnsForState(state: GameEngineState): { r: number; c: number }[] {
  return enumerateButterSpawns(
    state.config,
    state.board,
    getTunnelCorners(state.config),
    state.mousePosition,
    state.catPosition,
    state.butterPositions,
    state.trapPosition,
  );
}

/**
 * Default CHANCE builder: uniform weight 1/N over every legal spawn cell,
 * exactly matching the real game's uniform random draw. Each outcome is a
 * complete successor state with the new butter placed.
 */
function buildButterChanceForState(
  state: GameEngineState,
): { state: GameEngineState; weight: number }[] | null {
  const cells = enumerateButterSpawnsForState(state);
  if (cells.length === 0) return null;
  const weight = 1 / cells.length;
  return cells.map((c) => ({
    state: { ...state, butterPositions: [...state.butterPositions, c] },
    weight,
  }));
}

export const defaultRuleSet: RuleSet = {
  mouseStep: mouseStepDeterministic,
  catMove,
  mouseSkill,
  catPlaceTrap,
  chooseTunnelExit,
  enumerateButterSpawns: enumerateButterSpawnsForState,
  endTurn,
  buildButterChance: buildButterChanceForState,
};
