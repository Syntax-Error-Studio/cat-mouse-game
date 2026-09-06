import type { RuleSet } from './searchTypes';
import {
  mouseStepDeterministic,
  catMove,
  mouseSkill,
  catPlaceTrap,
  endTurn,
  enumerateButterSpawnsForState,
  enumerateGhostAnnouncementOutcomes,
  enumerateGhostBoundaryOutcomes,
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
 *    and butter PICKUP but defers the ghost announcement. The simulator turns a
 *    butter pickup into an honest CHANCE node via the shared ghost-announcement
 *    kernel — so the search never calls Math.random.
 *  - `enumerateButterSpawns` lists every legal ghost spawn cell (pure, no RNG),
 *    excluding current entity butters AND current pending ghosts.
 *  - `endTurn` is used internally by the simulator to FORCE the turn hand-off
 *    (it is NOT an exposed SearchAction). At a CAT→MOUSE boundary with pending
 *    ghosts or placement debt, `resolveGhostBoundaryChance` is used instead.
 *
 * G0.4F-2A.3: ALL ghost-rule enumeration lives in the SHARED kernel exported
 * from engine.ts (enumerateButterSpawnsForState / enumerateGhostAnnouncementOutcomes
 * / enumerateGhostBoundaryOutcomes) — the SAME single source that
 * `createEngineRuleSet()` (the REAL production Hard search adapter) consumes.
 * There is exactly ONE ghost-rule enumeration source; this file holds no copies.
 */

export const defaultRuleSet: RuleSet = {
  mouseStep: mouseStepDeterministic,
  catMove,
  mouseSkill,
  catPlaceTrap,
  chooseTunnelExit,
  enumerateButterSpawns: enumerateButterSpawnsForState,
  endTurn,
  buildButterChance: enumerateGhostAnnouncementOutcomes,
  resolveGhostBoundaryChance: enumerateGhostBoundaryOutcomes,
};
