import type { GameEngineState } from '../engine';
import type { Direction } from '../types';

/**
 * A single primitive action the Search AI can apply to a GameEngineState.
 *
 * The search operates at the granularity of ONE primitive step. A full turn
 * (the cat's N moves, or the mouse's M moves) is a SEQUENCE of these.
 *
 *  - catStep        : one cat move in `direction`            (engine.catMove)
 *  - catPlaceTrap   : cat drops a trap on its own cell        (engine.catPlaceTrap)
 *  - mouseStep      : one mouse move in `direction`           (engine.mouseStepDeterministic)
 *  - mouseSkill     : mouse activates skill (spacebar)         (engine.mouseSkill)
 *  - chooseTunnel   : mouse picks a tunnel exit                (rules.chooseTunnelExit)
 *
 * IMPORTANT (B2.5 architecture audit): `endTurn` is deliberately NOT a
 * SearchAction. In the real game there is no "actively end turn" input — the
 * turn hands off automatically when the cat spends its last move, when the
 * mouse runs out of moves, when it steps on a trap, or when a tunnel exit is
 * chosen. Those are FORCED transitions applied by the simulator (see
 * `forceEndTurnIfNeeded` in simulator.ts), never a choice the search makes.
 */
export type SearchAction =
  | { type: 'catStep'; direction: Direction }
  | { type: 'catPlaceTrap' }
  | { type: 'mouseStep'; direction: Direction }
  | { type: 'mouseSkill' }
  | { type: 'chooseTunnel'; r: number; c: number };

/** A {r,c} point used by butter-spawn enumeration. */
export type Point = { r: number; c: number };

/**
 * Result of applying one SearchAction in the simulator.
 *
 *  - deterministic : exactly one resulting state. Covers cat moves, mouse
 *      moves that do NOT consume butter, tunnel choices, skill, trap.
 *  - chance        : the action is stochastic. The ONLY stochastic element in
 *      the real engine is butter regeneration after the mouse eats a butter.
 *      We model it as a CHANCE node with one-or-more equally-weighted
 *      outcomes, one per legal spawn cell (enumerated, never a hidden
 *      Math.random draw). This is the Expectiminimax CHANCE layer.
 *
 * CONSTRAINT (user-approved): the search NEVER monkey-patches Math.random(),
 * and the simulator NEVER calls it. The chance outcomes are enumerated
 * deterministically via `RuleSet.enumerateButterSpawns`.
 */
export type SearchTransitionResult =
  | { kind: 'deterministic'; state: GameEngineState }
  | { kind: 'chance'; outcomes: { state: GameEngineState; weight: number }[] };

/**
 * Transition adapter. The concrete engine functions the simulator calls.
 *
 * Injecting these (instead of statically importing engine.ts inside the
 * simulator) keeps `simulator.ts` engine-free, so the fragile
 *   engine -> searchHard -> simulator -> engine
 * cycle CANNOT form. The single binding point is `ai/searchRules.ts`.
 *
 * `mouseStep` is the DETERMINISTIC mouse transition (butter regeneration
 * deferred — the simulator turns it into a chance node). `enumerateButterSpawns`
 * lists every legal new-butter cell so the chance node is honest.
 */
export interface RuleSet {
  mouseStep: (state: GameEngineState, direction: Direction) => GameEngineState;
  catMove: (state: GameEngineState, direction: Direction) => GameEngineState;
  mouseSkill: (state: GameEngineState) => GameEngineState;
  catPlaceTrap: (state: GameEngineState) => GameEngineState;
  chooseTunnelExit: (state: GameEngineState, r: number, c: number) => GameEngineState;
  enumerateButterSpawns: (state: GameEngineState) => Point[];
  endTurn: (state: GameEngineState) => GameEngineState;
  /**
   * Build the CHANCE node for one-for-one butter regeneration after the mouse
   * eats a butter. Each outcome is a COMPLETE, legal successor state (with the
   * new butter already placed) and its probability weight.
   *
   * Default (see `ai/searchRules.ts`): enumerate every legal spawn cell and
   * assign UNIFORM weight 1/N — exactly matching the real game's uniform
   * random draw in `generateSingleButterPosition`. This keeps the search honest
   * about real probabilities.
   *
   * Tests may inject a NON-UNIFORM distribution here to verify the Expectation
   * arithmetic handles arbitrary weights (requirement #4). Returns null when no
   * spawn is legal (the caller then treats the action as deterministic).
   *
   * OPTIONAL: if absent, the simulator falls back to its own uniform default.
   */
  buildButterChance?: (state: GameEngineState) => { state: GameEngineState; weight: number }[] | null;
}

/** Transposition-table bound (used from Phase D; type defined now). */
export type TTFlag = 'exact' | 'lower' | 'upper';
export interface TTEntry {
  key: string;
  depth: number;
  value: number;
  flag: TTFlag;
  bestAction?: SearchAction;
  /** Human-readable note for diagnostics only (excluded from identity). */
  note?: string;
}

/** Search configuration parameters (defaults in searchConfig.ts). */
export interface SearchConfig {
  /** Max search depth measured in TURNS (action-right changes), not steps. */
  maxDepthTurns: number;
  /** Per-complete-cat-turn time budget (ms). One budget per cat turn, not per step. */
  timeBudgetMsPerCatTurn: number;
  /** Enable transposition table (Phase D). */
  useTranspositionTable: boolean;
  /** Enable iterative deepening (Phase D). */
  enableIterativeDeepening: boolean;
  /** RNG source, reserved for chance-node sampling in later phases. */
  rng: () => number;
}

/** Live diagnostics accumulator (filled by the search; type defined now). */
export interface SearchDiagnostics {
  nodesVisited: number;
  nodesPruned: number;
  ttHits: number;
  ttStores: number;
  depthReached: number;
  timedOut: boolean;
  startTime: number;
  endTime: number;
  /** Per-cat-turn wall-clock used (ms). */
  elapsedMs: number;
}

/** Bundled context handed to the search (Phase C+). */
export interface SearchContext {
  config: SearchConfig;
  rules: RuleSet;
  diagnostics: SearchDiagnostics;
  tt: Map<string, TTEntry>;
}
