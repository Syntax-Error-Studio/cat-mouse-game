import type { GameEngineState } from '../engine';
import type { SearchAction } from './searchTypes';
import type { MateSide, SearchBoundType } from './expectiminimax';
import type { HardProgressGuardMemory, ProgressGuardDiag } from './progressGuard';
import { stateKey } from './transposition';

/**
 * ============================================================================
 * G0.2 — Exact Hard-root history (DEBUG ONLY).
 *
 * Stores a bounded history of every Hard cat-turn root as an EXACT
 * game-affecting snapshot, so a lost real game can be replayed offline to find
 * the Point of No Return ("which turn did it become a forced loss").
 *
 * Rules:
 *   - snapshots are DEEP copies (no live references to the running state);
 *   - the history field on GameEngineState is EXCLUDED from
 *     `gameAffectingEqual` / `stateKey` / TT (see those modules — they only
 *     compare the specific game-affecting fields, and we never add history to
 *     them), so saving history NEVER changes AI behavior;
 *   - bounded: at most `HARD_HISTORY_LIMIT` entries (oldest dropped).
 * ============================================================================
 */

/** Max number of Hard cat-turn roots kept per game (debug only). */
export const HARD_HISTORY_LIMIT = 20;

/** Exact deep snapshot of every GAME-AFFECTING field of a root state. */
export interface HardRootSnapshot {
  board: GameEngineState['board'];
  config: GameEngineState['config'];
  gameMode: GameEngineState['gameMode'];
  phase: GameEngineState['phase'];
  currentPlayer: GameEngineState['currentPlayer'];
  catPosition: { r: number; c: number };
  mousePosition: { r: number; c: number };
  catMovesLeft: number;
  mouseMovesLeft: number;
  butterPositions: { r: number; c: number }[];
  pendingButterSpawns: GameEngineState['pendingButterSpawns'];
  /** G0.4F-2A.1: optional for backward compatibility with pre-2A.1 snapshots. */
  pendingButterPlacementDebt?: number;
  mouseHasButter: boolean;
  mouseSkillActive: boolean;
  trapPosition: { r: number; c: number } | null;
  catTrapsRemaining: number;
  blockedTunnels: { r: number; c: number }[];
  tunnelExitChoices: { r: number; c: number; label: string }[];
  /** G0.4F-2B-1.6: M3-lite Progress-Guard policy memory. OPTIONAL (absent in
   *  pre-1.6 snapshots → undefined/null). It affects ROOT-LEVEL policy but is
   *  excluded from stateKey/gameAffectingEqual/TT (it is NOT game-rule
   *  transition state — documented explicitly). Debug/forensics must be able
   *  to round-trip it exactly (P23). */
  hardProgressGuardMemory?: HardProgressGuardMemory | null;
}

export interface HardProductionDiag {
  completedDepth: number;
  attemptedDepth: number;
  nodes: number;
  elapsedMs: number;
  rootValue: number;
  mate: MateSide;
  plan: SearchAction[];
  /** PPC-HV-1A P1-1: full root records of the deepest COMPLETED iteration.
   *  `bound` is the Alpha-Beta guarantee of `value` (RB-1: a one-sided bound is
   *  NOT a proved score, so two candidates may only be treated as primary-equal
   *  when both are 'exact'). OPTIONAL: entries written before 1A carry no bound,
   *  and the export must show those as `unknown`, never as `exact`. */
  rootValues: { action: SearchAction; value: number; mate: MateSide; bound?: SearchBoundType }[];
  /** PPC-HV-1A P1-1: the search's own first action (`IterativeSearchResult
   *  .bestAction`), i.e. before the forced-loss tie-break / equal-primary route
   *  optimisation produced `plan`. Recording both lets the human log tell a
   *  proved-exact tie reordering apart from an illegal replacement.
   *  OPTIONAL (absent in pre-1A entries). */
  bestAction?: SearchAction | null;
  /** PPC-HV-1A P0-2: what the planner actually produced for this turn. Since
   *  1A an entry is written even when NO plan came out, so a failed search keeps
   *  its root snapshot. OPTIONAL (pre-1A entries only existed when a plan did,
   *  so an absent status reads as a normal planned turn).
   *   - 'planned'           : a non-empty plan drove the cat turn;
   *   - 'empty_plan'        : depth-1 completed but the plan had no actions;
   *   - 'search_incomplete' : not even depth-1 completed (completedDepth === 0). */
  planStatus?: 'planned' | 'empty_plan' | 'search_incomplete';
  /** PPC-HV-1A P1-2: the REAL abort cause reported by the planner
   *  (`HardTurnPlan.deadlineFired` / `.budgetFired`, i.e. the search's
   *  `deadlineExceeded` / `budgetExhausted`). Log-only — never fed back into a
   *  search abort. OPTIONAL (pre-1A entries show `unknown`). */
  deadlineFired?: boolean;
  budgetFired?: boolean;
  /** PPC-HV-1A P1-2: the nominal main-search wall budget this turn was given
   *  (ms), so `elapsedMs > budgetMs` (an over-nominal spend) is a fact in the
   *  log instead of an assumption about the constant. OPTIONAL. */
  budgetMs?: number;
  /** G0.3X: bounded-refutation sidecar diagnostics for this turn (absent when
   *  the flag was OFF or the turn predates the trial build). */
  refutation?: HardRefutationDiag;
  /** G0.4F-2B-1.8: M3-lite Progress-Guard diagnostics for this turn (compact,
   *  mirrors ProgressGuardDebug). Recorded from the SAME live debug object as
   *  `refutation` so the human-validation log can prove the feature flag state
   *  per turn. Debug-only; excluded from stateKey/gameAffectingEqual. Absent
   *  when the turn predates 1.8 (no guard diag was captured). */
  progressGuard?: ProgressGuardDiag;
}

/** G0.3X: compact bounded-refutation diagnostics recorded per Hard turn so the
 *  human-validation log can reconstruct baseline→final decision, override
 *  usage and sidecar cost WITHOUT the live debug object. Debug-only; the
 *  history field is excluded from stateKey/gameAffectingEqual. */
export interface HardRefutationDiag {
  triggered: boolean;
  candidateCount: number;
  baselineProbeStatus: string | null;
  candidateStatuses: string[];
  refutedCount: number;
  cleanCount: number;
  overrideEligible: boolean;
  overrideUsed: boolean;
  selectedPlanSource: 'baseline' | 'bounded_refutation';
  refutationCpuMs: number;
  refutationWallMs: number;
  fallbackUsed: boolean;
  sidecarAbortReason: string;
  baselinePlan: SearchAction[];
  finalPlan: SearchAction[];
}

/** Execution link: what the production trajectory actually did + end key. */
export interface HardHistoryExecution {
  plan: SearchAction[];
  /** stateKey of the state at the END of the cat turn (POST-plan, before
   *  the separate `endTurn` call). null if the turn could not execute. */
  endStateKey: string | null;
  /** True if the executed trajectory's final state matched the plan replay. */
  matchedPlan: boolean;
  /**
   * PPC-HV-1A P0-2: the remaining single-turn execution truths, copied verbatim
   * from `buildHardTurnExecutionStatus` (never re-derived from the cumulative
   * catActionLog). Together with `production.planStatus` they let the log
   * distinguish a planned turn, an incomplete search, an empty plan, a legacy
   * fallback that replaced the plan, and what the turn actually reached.
   * OPTIONAL (pre-1A entries show `n/a`).
   */
  planCompleted?: boolean;
  fallbackOccurred?: boolean;
  invalidActionOccurred?: boolean;
  reachedLegalBoundary?: boolean;
}

/** One saved Hard turn root. */
export interface HardSearchHistoryEntry {
  /** Monotonic cat-turn counter (1-based, per game). Since PPC-HV-1A P0-1 it
   *  keeps increasing past `HARD_HISTORY_LIMIT` — see `nextHardHistoryTurn`. */
  turn: number;
  /** stateKey of the EXACT root snapshot. */
  stateKey: string;
  /** Deep snapshot of the game-affecting root state (no shared refs). */
  root: HardRootSnapshot;
  /** Production search diagnostics at that root. */
  production: HardStateDiag;
  /** Execution linkage (filled after the cat turn completes). */
  execution: HardHistoryExecution;
}

/** Alias so both consumers read the same block type. */
export type HardStateDiag = HardProductionDiag;
export type HardStateExecution = HardHistoryExecution;

/** Deep snapshot (game-affecting fields only; debug fields excluded). */
export function captureHardRoot(state: GameEngineState): HardRootSnapshot {
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  return {
    board: clone(state.board),
    config: clone(state.config),
    gameMode: state.gameMode,
    phase: state.phase,
    currentPlayer: state.currentPlayer,
    catPosition: { ...state.catPosition },
    mousePosition: { ...state.mousePosition },
    catMovesLeft: state.catMovesLeft,
    mouseMovesLeft: state.mouseMovesLeft,
    butterPositions: clone(state.butterPositions),
    pendingButterSpawns: clone(state.pendingButterSpawns ?? []),
    pendingButterPlacementDebt: state.pendingButterPlacementDebt ?? 0,
    mouseHasButter: state.mouseHasButter,
    mouseSkillActive: state.mouseSkillActive,
    trapPosition: state.trapPosition ? { ...state.trapPosition } : null,
    catTrapsRemaining: state.catTrapsRemaining,
    blockedTunnels: clone(state.blockedTunnels),
    tunnelExitChoices: clone(state.tunnelExitChoices),
    hardProgressGuardMemory: state.hardProgressGuardMemory ? clone(state.hardProgressGuardMemory) : null,
  };
}

/** Rebuild a full GameEngineState from a snapshot (debug/offline replay). */
export function restoreHardRoot(snap: HardRootSnapshot): GameEngineState {
  return {
    board: JSON.parse(JSON.stringify(snap.board)) as GameEngineState['board'],
    config: JSON.parse(JSON.stringify(snap.config)) as GameEngineState['config'],
    gameMode: snap.gameMode,
    phase: snap.phase,
    currentPlayer: snap.currentPlayer,
    catPosition: { ...snap.catPosition },
    mousePosition: { ...snap.mousePosition },
    catMovesLeft: snap.catMovesLeft,
    mouseMovesLeft: snap.mouseMovesLeft,
    butterPositions: JSON.parse(JSON.stringify(snap.butterPositions)),
    pendingButterSpawns: JSON.parse(JSON.stringify(snap.pendingButterSpawns ?? [])) as GameEngineState['pendingButterSpawns'],
    pendingButterPlacementDebt: snap.pendingButterPlacementDebt ?? 0,
    mouseHasButter: snap.mouseHasButter,
    mouseSkillActive: snap.mouseSkillActive,
    trapPosition: snap.trapPosition ? { ...snap.trapPosition } : null,
    catTrapsRemaining: snap.catTrapsRemaining,
    blockedTunnels: JSON.parse(JSON.stringify(snap.blockedTunnels)),
    message: '',
    tunnelExitChoices: JSON.parse(JSON.stringify(snap.tunnelExitChoices)),
    catActionLog: [],
    gameEventLog: [],
    lastHardSearch: null,
    hardSearchHistory: [],
    hardProgressGuardMemory: snap.hardProgressGuardMemory
      ? JSON.parse(JSON.stringify(snap.hardProgressGuardMemory)) as HardProgressGuardMemory
      : null,
  };
}

/** True iff the snapshot deep-equals another snapshot (game-affecting). */
export function snapshotsEqual(a: HardRootSnapshot, b: HardRootSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Append a history entry (bounded). Returns the new (immutable) array. */
export function pushHardHistory(
  history: HardSearchHistoryEntry[],
  entry: HardSearchHistoryEntry,
  limit = HARD_HISTORY_LIMIT,
): HardSearchHistoryEntry[] {
  const next = [...history, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * PPC-HV-1A P0-1 — the next monotonic cat-turn number, from the RETAINED window.
 *
 * The old caller derived it as `history.length + 1`. That is only correct while
 * the window is not full: once `HARD_HISTORY_LIMIT` entries exist the array
 * rolls (oldest dropped), so `length` stops counting distinct turns, every turn
 * from #21 on is numbered `21` again, and the write-side dedup filter then
 * deletes the PREVIOUS turn's record instead of a duplicate — the exact failure
 * that would have hidden the early-game evidence in a long human game.
 * `pushHardHistory` always keeps the newest entry in the window, so the maximum
 * retained `turn` is always the previous turn's number and max+1 is exact.
 * Debug-only: it reads nothing but `turn`, and the history field itself is
 * excluded from stateKey / gameAffectingEqual / TT.
 */
export function nextHardHistoryTurn(history: HardSearchHistoryEntry[]): number {
  let max = 0;
  for (const e of history) if (e.turn > max) max = e.turn;
  return max + 1;
}

/** Compute the exact stateKey of a root snapshot WITHOUT restoring a state. */
export function snapshotStateKey(snap: HardRootSnapshot): string {
  return stateKey(restoreHardRoot(snap));
}

/**
 * Make a history entry from a live root state + production diag.
 * The snapshot is taken NOW (deep); `execution` is left pending until the
 * turn actually executes (fillExecution).
 */
export function makeHardHistoryEntry(
  state: GameEngineState,
  turn: number,
  prod: HardProductionDiag,
): HardSearchHistoryEntry {
  return {
    turn,
    stateKey: stateKey(state),
    root: captureHardRoot(state),
    production: prod,
    execution: { plan: prod.plan, endStateKey: null, matchedPlan: false },
  };
}

/**
 * Machine-readable EXACT snapshot export for one history entry.
 *
 * Serializes the DEEP-COPIED game-affecting snapshot (all fields
 * `restoreHardRoot` needs: board/cells, positions, moves, butter, trap,
 * catTrapsRemaining, mouseHasButter, mouseSkillActive, blockedTunnels,
 * tunnelExitChoices, currentPlayer/phase, config). The output is a single
 * JSON object — NOT derived from `stateKey` — and can be JSON.parsed and fed
 * to `restoreHardRoot` for an exact stateKey round-trip (G0.2).
 */
export function hardHistorySnapshotJson(e: HardSearchHistoryEntry): string {
  // The snapshot stored in `e.root` is already a deep copy (captureHardRoot);
  // re-serialize from it directly so no live reference leaks into the text.
  return JSON.stringify(e.root);
}