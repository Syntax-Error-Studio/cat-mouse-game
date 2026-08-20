import type { GameEngineState } from '../engine';
import { GamePhase, PieceType } from '../types';
import type { RuleSet, SearchAction, SearchTransitionResult } from './searchTypes';
import { generateLegalSearchActions } from './legalActions';
import { simulateSearchAction } from './simulator';
import { stateKey, TranspositionTable } from './transposition';
import type { TTEntry } from './transposition';

/**
 * ============================================================================
 * Phase C — Adversarial Search v0: Expectiminimax (MAX / MIN / CHANCE)
 * ============================================================================
 *
 * This is the MATHEMATICALLY-CORRECT foundation. It is NOT yet "smart" — its
 * only job in this phase is to compute the right value when a forced win/loss
 * exists within the search depth.
 *
 *   Cat    = MAX
 *   Mouse  = MIN
 *   Random = CHANCE   (a probability node, NOT a third player / not a turn)
 *
 * Design constraints (user-approved):
 *   - No Alpha-Beta pruning yet (correctness first).
 *   - Transposition table is NOT enabled (kept in transposition.ts for Phase D).
 *     We only use `stateKey` for the recursion-path repetition set.
 *   - depthTurns counts TURN changes (action-right flips), NOT primitive
 *     steps. A full cat turn (N atomic steps) and a full mouse turn are each
 *     ONE turn; the budget is NOT consumed per atomic step.
 *   - No wall-clock timeout in Phase C: results are fully deterministic.
 *   - A hard `maxNodes` safety budget returns a static eval when exceeded.
 */

/** Absolute mate score. Any non-terminal evaluation stays far below this. */
export const MATE_SCORE = 1_000_000;

/**
 * F1A-2: how often the wall-clock deadline is sampled. Calling `now()` on
 * EVERY node would make the clock a hot spot for no benefit; sampling once
 * per 64 nodes keeps a mid-depth abort bounded (≤64 nodes past the deadline)
 * at negligible cost. This is deliberately a simple constant — NOT a tuned
 * performance parameter (per the F1A spec).
 */
export const DEADLINE_CHECK_INTERVAL = 64;

/**
 * F1A-2: the default monotonic clock. `performance.now()` where available
 * (modern browsers + Node ≥ 16), otherwise `Date.now()` as a fallback. A
 * monotonic base is what a wall-clock timeout needs; tests inject their own
 * `now` for deterministic replays.
 */
function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * F1A-2: true iff the wall-clock deadline (ctx.deadlineMs) has passed on the
 * current sample. Returns false when no deadline is configured. The sample is
 * taken only every `DEADLINE_CHECK_INTERVAL` nodes (the caller has already
 * matched the interval against the shared node counter), so the clock is not
 * a per-node hot spot.
 */
function deadlineReached(ctx: SearchContext, nodeCount: { count: number }): boolean {
  if (ctx.deadlineMs === undefined) return false;
  if (nodeCount.count % DEADLINE_CHECK_INTERVAL !== 0) return false;
  const clock = ctx.now ?? defaultNow;
  return clock() >= ctx.deadlineMs;
}

/**
 * Design invariant (NOT used for stepping anymore): leaf/heuristic values are
 * bounded by a few hundred, while a genuine forced mate is reported as
 * `±MATE_SCORE` minus its distance. `MATE_DISTANCE_GUARD` was the safety margin
 * that, in the OLD magnitude-based stepping, separated mates from ordinary
 * values. Phase D0 replaced magnitude-based detection (`abs(value) >=
 * MATE_THRESHOLD`) with an EXPLICIT `mate` classification (see
 * `InternalSearchResult.mate`), so this constant is now only documentation of
 * that bound, not part of the stepping logic.
 */
export const MATE_DISTANCE_GUARD = 100_000;

/** Which side a score/value is a forced win for. `null` = ordinary bounded. */
export type MateSide = 'cat' | 'mouse' | null;

/**
 * A single search score, in the CAT's perspective: higher = better for cat.
 *
 * The `mate` classification is the PRIMARY ordering key; the numeric `value`
 * only breaks ties WITHIN the same mate category. This is what stops a
 * numerically-huge mixed value (e.g. a CHANCE expectation near ±MATE_SCORE)
 * from outranking a genuine forced mate. `InternalSearchResult` is a
 * `SearchScore` plus `bound`/`completed`/`cacheable` metadata, so anything that
 * accepts a `SearchScore` can also take an `InternalSearchResult`.
 */
export interface SearchScore {
  value: number;
  mate: MateSide;
}

/**
 * A search bound along the "better-for-cat" axis. Used as the Alpha-Beta window
 * `alpha`/`beta`. We deliberately do NOT use a bare `number` (plus ±infinity
 * sentinels) because that would rank a forced cat-mate value (≈ 999990) BELOW a
 * non-mate value (≈ 999999) when the mate classification is ignored. The bound
 * carries the full `SearchScore` (value + mate) and an explicit infinity kind,
 * so the SAME lexicographic comparator drives both play selection and pruning.
 */
export type ScoreBound =
  | { kind: 'negative-infinity' }
  | { kind: 'score'; score: SearchScore }
  | { kind: 'positive-infinity' };

/**
 * Propagate a child's value up ONE tree edge to its parent.
 *
 * Terminal scores are node-local: `±MATE_SCORE` at the terminal (distance 0).
 * Each tree edge adjusts the value by ±1 so the score ALWAYS encodes the
 * distance from the CURRENT node to the terminal — NOT the number of plies
 * walked from the root. This makes a node's value path-independent, hence
 * TT-safe.
 *
 * The step is driven by the child's EXPLICIT `mate` classification, NOT by the
 * magnitude of the value. A value is only stepped when it is a genuine
 * one-sided forced mate (`child.mate !== null`). This is what stops a CHANCE
 * node whose expectation happens to fall inside the mate band (e.g. a 50/50 mix
 * of "mate now" and "no mate") from being misread as a forced mate.
 *
 *   child.mate === 'cat'   → parent one edge closer to root → −1
 *   child.mate === 'mouse' → parent one edge closer to root → +1
 *   child.mate === null    → not a forced mate → no step (raw value)
 */
/** Lexicographic mate rank from the CAT's perspective (higher = better). */
function mateRank(mate: MateSide): number {
  if (mate === 'cat') return 2;
  if (mate === null) return 1;
  return 0; // 'mouse'
}

/**
 * THE single "who is better, from the cat's perspective" definition.
 *
 * Returns:
 *   < 0  → `a` is worse for the cat than `b`
 *   = 0  → `a` and `b` are equally good for the cat
 *   > 0  → `a` is better for the cat than `b`
 *
 * Order (category first, then numeric value WITHIN a category):
 *
 *   cat-mate(2)  > non-mate(1) > mouse-mate(0)
 *
 * This is the ONLY place the preference order is defined. `preferResult`
 * (play selection) and the Alpha-Beta `compareBound`/`maxBound`/`minBound`
 * (pruning) both route through it, so pruning can never disagree with
 * selection. A mixed CHANCE (mate = null) can therefore NEVER outrank a genuine
 * forced mate, even when its expected value is numerically extremely close to
 * MATE_SCORE.
 */
export function compareSearchScore(a: SearchScore, b: SearchScore): number {
  const ra = mateRank(a.mate);
  const rb = mateRank(b.mate);
  if (ra !== rb) return ra - rb;
  return a.value - b.value;
}

/**
 * Lexicographic action-selection comparison.
 *
 * Returns true iff result `a` is strictly preferred over result `b` by the
 * player indicated by `maximizing`. Delegates entirely to `compareSearchScore`
 * so play selection and pruning share one ordering.
 *
 *   MAX (cat):   cat-mate > non-mate > mouse-mate
 *   MIN (mouse): mouse-mate < non-mate < cat-mate
 */
export function preferResult(
  a: InternalSearchResult,
  b: InternalSearchResult,
  maximizing: boolean,
): boolean {
  const cmp = compareSearchScore(a, b);
  if (cmp === 0) return false;
  return maximizing ? cmp > 0 : cmp < 0;
}

/**
 * Real GAME-TIME cost of one primitive `SearchAction`, measured in "one cat
 * step / one mouse step" units. This is the ONLY place that decides how much a
 * search edge advances the mate distance (F1A-3).
 *
 *   catStep      → 1   (a real cat move consumes one cat move)
 *   mouseStep    → 1   (a real mouse move consumes one mouse move)
 *   catPlaceTrap → 0   (placing a trap consumes NO move — GAMEPLAY §4.3)
 *   mouseSkill   → 0   (skill activation consumes butter, not moves — §3.3)
 *   chooseTunnel → 0   (the exit choice itself is free; the mouse already paid
 *                       with the steps to reach the tunnel — §3.4)
 *
 * A CHANCE node is not a SearchAction: it adds no cost of its own (the
 * underlying mouseStep that triggered the butter regeneration is billed by
 * `mouseStep → 1` at the parent edge).
 *
 * Every SearchAction must be listed explicitly; the exhaustive switch makes
 * a future action type a compile-time decision instead of a silent default.
 */
export function mateActionCost(action: SearchAction): number {
  switch (action.type) {
    case 'catStep':
      return 1;
    case 'mouseStep':
      return 1;
    case 'catPlaceTrap':
      return 0;
    case 'mouseSkill':
      return 0;
    case 'chooseTunnel':
      return 0;
  }
}

/**
 * Step a score up ONE tree edge toward its parent, by the REAL GAME-TIME cost
 * of the edge's action (`mateActionCost`), NOT by a hard-coded ±1 per tree
 * edge (F1A-3).
 *
 *   cat mate  → −cost   (one cost-unit closer to the terminal)
 *   mouse mate→ +cost
 *   non-mate  → unchanged
 */
function stepScore(score: SearchScore, cost = 1): SearchScore {
  if (score.mate === 'cat') return { value: score.value - cost, mate: 'cat' };
  if (score.mate === 'mouse') return { value: score.value + cost, mate: 'mouse' };
  return score;
}

/** Inverse of `stepScore` — express a parent-space score in its child's space. */
function unstepScore(score: SearchScore, cost = 1): SearchScore {
  if (score.mate === 'cat') return { value: score.value + cost, mate: 'cat' };
  if (score.mate === 'mouse') return { value: score.value - cost, mate: 'mouse' };
  return score;
}

/**
 * Propagate a child's value up ONE tree edge to its parent, charging the edge's
 * REAL game-time cost (`mateActionCost`), defaulting to 1 for compatibility
 * with plain per-edge calculations (F1A-3).
 *
 * Terminal scores are node-local: `±MATE_SCORE` at the terminal (distance 0).
 * Each tree edge adjusts the value by the REAL cost of the action (catStep=1,
 * mouseStep=1, catPlaceTrap=0, mouseSkill=0, chooseTunnel=0) so the score
 * ALWAYS encodes the distance in game-time from the CURRENT node to the
 * terminal — NOT the number of search plies walked from the root. This makes a
 * node's value path-independent, hence TT-safe.
 *
 * The step is driven by the child's EXPLICIT `mate` classification, NOT by the
 * magnitude of the value. A value is only stepped when it is a genuine
 * one-sided forced mate (`child.mate !== null`). This is what stops a CHANCE
 * node whose expectation happens to fall inside the mate band (e.g. a 50/50 mix
 * of "mate now" and "no mate") from being misread as a forced mate.
 *
 *   child.mate === 'cat'   → parent: value − cost
 *   child.mate === 'mouse' → parent: value + cost
 *   child.mate === null    → not a forced mate → no step (raw value)
 */
export function stepChildForParent(child: InternalSearchResult, cost = 1): number {
  return stepScore({ value: child.value, mate: child.mate }, cost).value;
}

/**
 * Step a bound up ONE tree edge toward its parent, by the edge's real
 * game-time cost (default 1 — the D2-B round-trip proof uses plain ±1 edges).
 * @see stepChildForParent — this is the bound-shaped counterpart used by the
 *      Alpha-Beta proof that `step(unstep(bound))` round-trips (D2-B).
 */
export function stepBoundForParent(bound: ScoreBound, cost = 1): ScoreBound {
  if (bound.kind !== 'score') return bound;
  return { kind: 'score', score: stepScore(bound.score, cost) };
}

/**
 * Inverse of `stepBoundForParent`: express a parent-space Alpha-Beta window
 * bound in its child's score space, charging the edge's real game-time cost
 * (`mateActionCost`; defaults to 1).
 *
 *   cat mate   → value + cost   (parent = child − cost, so child = parent + cost)
 *   mouse mate → value − cost   (parent = child + cost, so child = parent − cost)
 *   non-mate   → unchanged
 *   ±∞         → unchanged
 *
 * Because the child returns a value one real-time step closer to the terminal,
 * the parent's window must be re-expressed before being handed to the child,
 * otherwise a cat-mate window would mis-rank a child's value. The mate
 * category is preserved, so `step(unstep(bound))` round-trips exactly at any
 * cost.
 */
export function unstepBoundForChild(bound: ScoreBound, cost = 1): ScoreBound {
  if (bound.kind !== 'score') return bound;
  return { kind: 'score', score: unstepScore(bound.score, cost) };
}

/**
 * Compare two Alpha-Beta window bounds along the "better-for-cat" axis.
 *   < 0 → `a` is worse for the cat
 *   = 0 → equivalent
 *   > 0 → `a` is better for the cat
 * negative-infinity is the worst possible score; positive-infinity the best.
 */
export function compareBound(a: ScoreBound, b: ScoreBound): number {
  if (a.kind === 'negative-infinity' && b.kind === 'negative-infinity') return 0;
  if (a.kind === 'negative-infinity') return -1;
  if (b.kind === 'negative-infinity') return 1;
  if (a.kind === 'positive-infinity' && b.kind === 'positive-infinity') return 0;
  if (a.kind === 'positive-infinity') return 1;
  if (b.kind === 'positive-infinity') return -1;
  return compareSearchScore(a.score, b.score);
}

/** The bound that is better for the cat (higher rank / value). */
export function maxBound(a: ScoreBound, b: ScoreBound): ScoreBound {
  return compareBound(a, b) >= 0 ? a : b;
}

/** The bound that is worse for the cat (lower rank / value). */
export function minBound(a: ScoreBound, b: ScoreBound): ScoreBound {
  return compareBound(a, b) <= 0 ? a : b;
}

/** Live diagnostics accumulator for one root search. */
export interface SearchDiagnostics {
  /** Internal nodes expanded (turn/action decisions made). */
  nodes: number;
  /** CHANCE transitions encountered. */
  chanceNodes: number;
  /** Maximum recursion ply (action depth) reached. */
  maxDepthReached: number;
  /** Repetition (cycle) cutoffs on the current recursion path. */
  repetitions: number;
  /** Terminal (CatWins / MouseWins) leaves evaluated. */
  terminalNodes: number;
  /** Static-eval leaves (depth limit, no-legal-action, budget cutoff). */
  leafNodes: number;
  /** Times the maxNodes safety budget was hit. */
  budgetCutoffs: number;
  /** F1A-2: times the wall-clock deadline (deadlineMs) was hit. Reuses the
   *  same abort semantics as the node budget (completed=false, uncached). */
  deadlineCutoffs: number;
  /** Times a Playing state with movesLeft>0 had zero legal actions
   *  (RULE_EDGE_CASE_NO_LEGAL_ACTIONS — see requirement #8). */
  noLegalActionNodes: number;
  /** Phase D1: actual transposition-table lookups performed. */
  ttProbes: number;
  /** Phase D1: lookups that found an entry for the same state key (any depth). */
  ttHits: number;
  /** Phase D1: lookups whose entry matched the state key but whose
   *  `depthTurns` did NOT match the requested depth. Such a hit is NOT an
   *  EXACT reuse (the value would be for the wrong remaining depth), so it is
   *  recorded separately and never fed back as a node result. */
  ttDepthMismatches: number;
  /** Phase D1: lookups whose entry ALSO matched depthTurns exactly and was
   *  reused as the node's full result. (No LOWER/UPPER bound hits yet — D2.) */
  ttExactHits: number;
  /** Phase D1: successful writes of a completed+cacheable result. */
  ttStores: number;
  /** Phase D2: total Alpha-Beta cutoffs (MAX beta-cutoffs + MIN alpha-cutoffs). */
  alphaBetaCutoffs: number;
  /** Phase D2: MAX (beta) cutoffs committed. */
  alphaBetaMaxCutoffs: number;
  /** Phase D2: MIN (alpha) cutoffs committed. */
  alphaBetaMinCutoffs: number;
  /** Phase D2: CHANCE nodes fully searched with a FULL window (−∞..+∞),
   *  never pruned by an inherited bound. Proof that chance is never cut. */
  fullWindowChanceSearches: number;
  /** Phase D3: action-loops where move ordering was active. */
  orderedNodes: number;
  /** Phase D3: nodes where a TT bestAction hint was placed first. */
  ttFirstMoveCount: number;
  /** Phase D3: nodes where tactical ordering placed a non-TT action first. */
  tacticalFirstMoveCount: number;
  /** Phase D3: nodes where ordering changed which action is searched first. */
  orderingChangedFirstMove: number;
  /** Phase D3 (optional): Alpha-Beta cutoffs triggered on the FIRST action. */
  firstMoveCutoffCount: number;
}

/** Context handed to the search. */
export interface SearchContext {
  rules: RuleSet;
  /** Hard safety valve on node count (Phase C avoids search explosions). */
  maxNodes: number;
  /**
   * Optional deterministic leaf evaluator (cat perspective; higher = better
   * for cat). When absent, a built-in simple heuristic is used. Tests inject
   * this to control exact leaf values (e.g. to verify CHANCE expectation math
   * or zero-cost depth accounting).
   */
  leafEvaluator?: (state: GameEngineState) => number;
  /**
   * F1A-2: WALL-CLOCK deadline (absolute monotonic timestamp in the same
   * time-base as `now`). When set, the search aborts the CURRENT depth on
   * `now() >= deadlineMs` using the exact same abort pathway as the maxNodes
   * safety budget (returns completed=false, uncached static eval, never an
   * EXACT TT entry). The deadline can interrupt a running depth — it is NOT
   * only checked between iterative-deepening iterations.
   *
   * To spread `now()` calls, the clock is sampled once per
   * `DEADLINE_CHECK_INTERVAL` nodes (see below) instead of every node.
   * Production callers typically compute `deadlineMs = now() + budgetMs`.
   * Tests inject a FAKE `now` clock for deterministic replays.
   */
  deadlineMs?: number;
  /**
   * F1A-2: monotonic clock used to evaluate `deadlineMs`. Default
   * `performance.now()` (a monotonic clock where available); falls back to
   * `Date.now()`. Tests inject a fake clock to make the wall-clock deadline
   * deterministic.
   */
  now?: () => number;
  diagnostics: SearchDiagnostics;
  /**
   * Phase D1 EXACT transposition table. One table per context; never shared
   * across contexts or RuleSets. Created in `createSearchContext`.
   */
  tt: TranspositionTable;
  /**
   * Phase D1 switch. When false, the search is byte-for-byte the Phase C/D0
   * algorithm (no TT probe/store). Default OFF so existing fixtures are
   * unaffected; D1 tests and D1-J toggle it on.
   */
  useTT: boolean;
  /**
   * Phase D2 switch. When false, no Alpha-Beta pruning is performed — the
   * search is byte-for-byte the Phase C/D0/D1 algorithm (only EXACT-TT
   * differences from D1 apply). Default OFF so Phase C/D0/D1 fixtures and
   * tests are completely unaffected; D2 tests toggle it on.
   */
  useAlphaBeta: boolean;
  /**
   * Phase D3 switch. When false (default), action order is the raw
   * `generateLegalSearchActions` order, identical to Phase C/D0/D1/D2 behavior.
   * When true, MAX/MIN action loops reorder by a pure tactical score (and a TT
   * bestAction hint) BEFORE searching — purely a search-order optimization that
   * must NOT change any value / mate / bestAction.
   */
  useMoveOrdering: boolean;
  /**
   * F1B-2: when true, the search records the best action chosen at EVERY
   * decided node (keyed by stateKey) into `planBranches`. This is a
   * per-search PRINCIPAL-LINE decision log — populated by the actual search
   * decisions, NOT the TT (the TT remains a disposable performance cache).
   * After the search completes, `buildCatTurnPlan` walks the log from the
   * root along the still-Cat principal line to obtain the current cat turn's
   * plan. Off by default so Phase C/D0–D4 behavior is byte-identical.
   */
  capturePlan?: boolean;
  /**
   * F1B-2: transient decision log (stateKey → best action chosen by the
   * current search). Lives on the context so it is shared across iterative
   * deepening iterations within ONE call, but it is a per-call record — never
   * persisted, never used to change values.
   */
  planBranches: Map<string, SearchAction>;
  /**
   * F1B (HARD_SEARCH debug): when `capturePlan` is on, the ROOT action values
   * of the deepest COMPLETED iteration are recorded here during the search
   * (each root candidate's stepped value + mate), with NO extra search cost —
   * the values are already computed by the root MAX loop. Used by the
   * production Hard debug panel (TOP ROOT ACTIONS). Reset per search call.
   */
  rootValues: { action: SearchAction; value: number; mate: MateSide }[];
}

/** Standard return shape for the root search entry point. */
export interface SearchBestActionResult {
  action: SearchAction | null;
  value: number;
  /** Forced-mate classification of `value` (consistent with InternalSearchResult). */
  mate: MateSide;
  /**
   * Whether the root search fully resolved (no budget truncation / no incomplete
   * subtree). Mirrors the internal `InternalSearchResult.completed`. Exposed so
   * callers (benchmark verification, later Hard integration) can distinguish a
   * fully-resolved answer from a truncated one without re-deriving it. Read-only.
   */
  completed: boolean;
  /** F1B-2: principal-line plan for the CURRENT cat turn, derived from this
   *  search's own decisions (stateKey → bestAction log), walking while the
   *  actor stays Cat. Empty when plan capture is off or no Cat actions remain. */
  catTurnPlan: SearchAction[];
  diagnostics: SearchDiagnostics;
}

/**
 * Whether the returned `value` is the EXACT true minimax value, or merely a
 * one-sided bound on it. Phase D2 adds Alpha-Beta pruning, which can prove that
 * a node's value is >= X (MAX beta-cutoff → 'lower') or <= X (MIN alpha-cutoff
 * → 'upper') without fully resolving the subtree. The current EXACT-only TT
 * (Phase D1/D2) MUST NOT store a 'lower'/'upper' result as an EXACT entry;
 * only 'exact' nodes may be cached.
 */
export type SearchBoundType = 'exact' | 'lower' | 'upper';

export interface InternalSearchResult {
  value: number;
  /**
   * Forced-mate classification of `value`.
   *   'cat'   → value is a forced WIN for the cat (cat catches the mouse).
   *   'mouse' → value is a forced WIN for the mouse (cat loses: the mouse
   *             reaches a hole with butter, or is otherwise safe).
   *   null    → value is a normal bounded heuristic, OR a CHANCE expectation
   *             whose outcomes do NOT all agree on one side. Such a value is
   *             NEVER stepped as a mate distance, and must NOT be stored as a
   *             TT EXACT entry by a forced-mate distance.
   */
  mate: MateSide;
  /**
   * Mathematical guarantee of `value` relative to the true minimax value:
   *   'exact' → value IS the true value (full search, no cutoff).
   *   'lower' → value <= true value (MAX beta-cutoff).
   *   'upper' → value >= true value (MIN alpha-cutoff).
   * An Alpha-Beta cutoff is NOT a `completed=false` (search abort) — it is a
   * sound, complete proof that the true value lies on one side; hence a cutoff
   * node keeps `completed = true` but `bound` != 'exact' and must not be cached.
   */
  bound: SearchBoundType;
  /** true if `value` is the exact full-depth evaluation (no budget truncation). */
  completed: boolean;
  /** true only if `completed` AND path-independent (no repetition dependency). */
  cacheable: boolean;
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

export function createSearchContext(
  rules: RuleSet,
  maxNodes = 200_000,
  useTranspositionTable = false,
  useAlphaBetaPruning = false,
  useMoveOrdering = false,
): SearchContext {
  return {
    rules,
    maxNodes,
    tt: new TranspositionTable(),
    useTT: useTranspositionTable,
    useAlphaBeta: useAlphaBetaPruning,
    useMoveOrdering,
    planBranches: new Map<string, SearchAction>(),
    rootValues: [],
    diagnostics: {
      nodes: 0,
      chanceNodes: 0,
      maxDepthReached: 0,
      repetitions: 0,
      terminalNodes: 0,
      leafNodes: 0,
      budgetCutoffs: 0,
      deadlineCutoffs: 0,
      noLegalActionNodes: 0,
      ttProbes: 0,
      ttHits: 0,
      ttDepthMismatches: 0,
      ttExactHits: 0,
      ttStores: 0,
      alphaBetaCutoffs: 0,
      alphaBetaMaxCutoffs: 0,
      alphaBetaMinCutoffs: 0,
      fullWindowChanceSearches: 0,
      orderedNodes: 0,
      ttFirstMoveCount: 0,
      tacticalFirstMoveCount: 0,
      orderingChangedFirstMove: 0,
      firstMoveCutoffCount: 0,
    },
  };
}

function resetDiagnostics(d: SearchDiagnostics): void {
  d.nodes = 0;
  d.chanceNodes = 0;
  d.maxDepthReached = 0;
  d.repetitions = 0;
  d.terminalNodes = 0;
  d.leafNodes = 0;
  d.budgetCutoffs = 0;
  d.deadlineCutoffs = 0;
  d.noLegalActionNodes = 0;
  d.ttProbes = 0;
  d.ttHits = 0;
  d.ttDepthMismatches = 0;
  d.ttExactHits = 0;
  d.ttStores = 0;
  d.alphaBetaCutoffs = 0;
  d.alphaBetaMaxCutoffs = 0;
  d.alphaBetaMinCutoffs = 0;
  d.fullWindowChanceSearches = 0;
  d.orderedNodes = 0;
  d.ttFirstMoveCount = 0;
  d.tacticalFirstMoveCount = 0;
  d.orderingChangedFirstMove = 0;
  d.firstMoveCutoffCount = 0;
}

// ---------------------------------------------------------------------------
// Leaf / terminal evaluation
// ---------------------------------------------------------------------------

/**
 * Default leaf evaluation (cat perspective). Phase C keeps this deliberately
 * SIMPLE and BOUNDED — it must never approach MATE_SCORE. We do NOT reuse the
 * old Hard scoring (+50000 / +30000 / -45000), per explicit instruction.
 *
 * Higher = better for the cat.
 */
export function defaultLeafEval(state: GameEngineState): number {
  const d = manhattan(state.catPosition, state.mousePosition);
  // Closer cat → better for cat. Board is small, so this stays well under MATE.
  let score = 200 - d * 5;
  // Mouse carrying butter is a real threat (bad for cat).
  if (state.mouseHasButter) score -= 60;
  return score;
}

function evaluateLeaf(state: GameEngineState, ctx: SearchContext): number {
  return ctx.leafEvaluator ? ctx.leafEvaluator(state) : defaultLeafEval(state);
}

/**
 * Terminal (mate) value — NODE-LOCAL (TT-safe).
 *
 *   CatWins  → +MATE_SCORE
 *   MouseWins→ -MATE_SCORE
 *
 * The score represents distance 0 from the terminal. The ±1-per-layer
 * adjustment in `stepChildForParent` (applied once per tree edge when the
 * parent combines a child) turns this into "distance from the current node",
 * so the value no longer depends on how many plies were walked from the root.
 *
 * A real win/loss always dominates any non-terminal leaf evaluation, so the
 * search can never "invent" a terminal outcome or let a heuristic beat a
 * genuine mate.
 */
export function terminalValue(state: GameEngineState): number {
  if (state.phase === GamePhase.CatWins) return MATE_SCORE;
  if (state.phase === GamePhase.MouseWins) return -MATE_SCORE;
  return 0;
}

function manhattan(
  a: { r: number; c: number },
  b: { r: number; c: number },
): number {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

// ---------------------------------------------------------------------------
// Core recursion
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase D1 — Transposition table probe / store helpers
// ---------------------------------------------------------------------------

/**
 * Probe the EXACT transposition table.
 *
 * Returns the cached entry IFF one exists for the same state key AND its
 * `depthTurns` matches exactly (no `>=` relaxation yet — that is D2's job). A
 * depth-mismatched entry is found (`ttHits`) but is NOT an exact reuse
 * (`ttExactHits` is not incremented and null is returned), so the caller
 * proceeds with a full (correct) search.
 *
 * Only counts as a probe when the table is enabled. When `useTT` is false this
 * returns null without touching `ttProbes`, so disabling TT is indistinguishable
 * from the Phase C/D0 code path.
 */
function probeTT(ctx: SearchContext, key: string, depthTurns: number): TTEntry | null {
  if (!ctx.useTT) return null;
  ctx.diagnostics.ttProbes++;
  const entry = ctx.tt.get(key);
  if (!entry) return null;
  // An entry for the SAME state key was found (regardless of depth).
  ctx.diagnostics.ttHits++;
  if (entry.depthTurns === depthTurns) {
    // Exact depth match → genuine EXACT reuse of the full node result.
    ctx.diagnostics.ttExactHits++;
    return entry;
  }
  // Key matched but depth did NOT → this is NOT an exact reuse (the cached
  // value belongs to a different remaining depth), so it must not be returned
  // as a node result. Record it so D1 can assert the strict-match policy.
  ctx.diagnostics.ttDepthMismatches++;
  return null;
}

/**
 * Store a node's result into the TT, but ONLY when it is a genuine,
 * path-independent, full-depth EXACT value (`completed && cacheable`). This is
 * the single write gate that keeps repetition-dependent and budget-truncated
 * results out of the table — neither may ever become a TT EXACT entry.
 */
function storeTT(
  ctx: SearchContext,
  key: string,
  depthTurns: number,
  result: InternalSearchResult,
  bestAction?: SearchAction,
): void {
  if (!ctx.useTT) return;
  if (!result.completed || !result.cacheable) return;
  // Phase D2 (D2.5 not yet): the EXACT-only TT may ONLY store nodes whose value
  // is the genuine full minimax value. An Alpha-Beta cutoff produces a
  // 'lower'/'upper' bound, NOT an exact value — storing it would hand a later
  // probe a wrong (over-/under-shot) exact entry. So gate on `bound ===
  // 'exact'` in addition to completed/cacheable.
  if (result.bound !== 'exact') return;
  // Replacement policy (D1 — one entry per state, no 2-D table yet): a deeper
  // entry is strictly more informative than a shallower one, so keep the
  // existing entry when it is deeper. Overwrite only when the new depth is
  // >= the old. EXACT reuse still requires an *exact* depth match (see
  // probeTT), so this policy is purely a cache-quality heuristic and never
  // affects correctness.
  const existing = ctx.tt.get(key);
  if (existing && existing.depthTurns > depthTurns) return;
  ctx.tt.set(key, {
    depthTurns,
    value: result.value,
    mate: result.mate,
    bestAction,
  });
  ctx.diagnostics.ttStores++;
}

/**
 * Evaluate one action from `state`:
 *   - deterministic: recurse into the single successor.
 *   - chance:        Σ weight * value(successor).
 *
 * Returns an `InternalSearchResult` so callers (and the future TT) can see
 * whether the value is `completed` and `cacheable`.
 *
 * depthTurns handling: a turn switch (Cat↔Mouse) decrements depthTurns by 1.
 * Neither an atomic step (same actor) nor a CHANCE node consumes an extra
 * turn. The CHANCE node therefore never adds a separate depthTurns - 1 beyond
 * whatever turn switch the action already caused.
 */
/** Alpha-Beta window extremes. The root search always starts at full window. */
const NEG_INF: ScoreBound = { kind: 'negative-infinity' };
const POS_INF: ScoreBound = { kind: 'positive-infinity' };

// ---------------------------------------------------------------------------
// Phase D3 — Move ordering
// ---------------------------------------------------------------------------

/** Phase D3: a legal action plus its pre-computed transition and ordering metadata. */
interface PreparedAction {
  action: SearchAction;
  transition: SearchTransitionResult;
  /** Cat-perspective tactical goodness (higher = better for cat). */
  orderingScore: number;
  /** Original index in `generateLegalSearchActions` order (stable tie-break). */
  originalIndex: number;
}

/** Structural equality for `SearchAction` (used to match a TT bestAction hint). */
function actionEqual(a: SearchAction, b: SearchAction | undefined): boolean {
  if (!b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Representative successor state, used only for ordering scoring. */
function primaryNextState(t: SearchTransitionResult): GameEngineState {
  return t.kind === 'deterministic' ? t.state : t.outcomes[0].state;
}

/**
 * Phase D3 tactical ordering score, from the CAT's perspective (higher = better
 * for cat). PURE: depends only on the pre-action state and its transition. It is
 * used ONLY to decide search ORDER, never written into the final value.
 *
 *   immediate CatWins   → +1e6   (best for cat)
 *   immediate MouseWins → -1e6   (worst for cat)
 *   otherwise           → 10 · (closeness gained)   (cat closer = good)
 *
 * For a MIN (mouse) node the caller flips the sort direction, so "worst for
 * cat" (e.g. a mouse escape) is searched first. This is intentionally small and
 * pure — NOT the Legacy Hard weight system.
 */
function computeOrderingScore(
  state: GameEngineState,
  transition: SearchTransitionResult,
): number {
  const next = primaryNextState(transition);
  if (next.phase === GamePhase.CatWins) return 1_000_000;
  if (next.phase === GamePhase.MouseWins) return -1_000_000;
  const before = manhattan(state.catPosition, state.mousePosition);
  const after = manhattan(next.catPosition, next.mousePosition);
  return (before - after) * 10;
}

/**
 * The shared MAX/MIN action loop, used by both `_search` (interior nodes) and
 * `searchBestAction` (root). It is the ONLY place that decides play selection
 * AND (when `ctx.useAlphaBeta`) Alpha-Beta cutoffs, so the two can never
 * diverge:
 *
 *   - Children are searched with the parent window re-expressed one mate-distance
 *     step away (`unstepBoundForChild`) because a child's value is one edge
 *     closer to the terminal than the parent's.
 *   - MAX updates `alpha = max(alpha, candidate)` and cuts off when
 *     `alpha >= beta` (beta-cutoff → result bound 'lower').
 *   - MIN updates `beta = min(beta, candidate)` and cuts off when
 *     `alpha >= beta` (alpha-cutoff → result bound 'upper').
 *   - CHANCE children inside `valueOfAction` ignore this window and search
 *     FULL (see `valueOfAction`): pruning is never applied across a random
 *     node.
 *
 * A cutoff is a SOUND, ALGORITHMIC proof, NOT a search abort — the two axes are
 * kept strictly separate (D2 requirement #11):
 *   - `completed` / `cacheable` keep their Phase C/D0/D1 meaning and are
 *     aggregated honestly over the actions actually searched. A cutoff neither
 *     forces them true nor forces them false.
 *   - `bound` is the Alpha-Beta axis: a cut-off node reports 'lower' (MAX) or
 *     'upper' (MIN), and `storeTT` bars any non-'exact' node from the
 *     EXACT-only table. That gate alone is sufficient.
 */
function searchActions(
  state: GameEngineState,
  depthTurns: number,
  ctx: SearchContext,
  path: Set<string>,
  nodeCount: { count: number },
  ply: number,
  alpha: ScoreBound,
  beta: ScoreBound,
): { result: InternalSearchResult; bestAction: SearchAction | null } {
  const actions = generateLegalSearchActions(state, ctx.rules);
  if (actions.length === 0) {
    // RULE_EDGE_CASE_NO_LEGAL_ACTIONS (requirement #8): Playing, movesLeft>0,
    // but fully boxed in. Do NOT invent a win/loss; return static eval.
    ctx.diagnostics.noLegalActionNodes++;
    ctx.diagnostics.leafNodes++;
    return {
      result: { value: evaluateLeaf(state, ctx), completed: true, cacheable: true, mate: null, bound: 'exact' },
      bestAction: null,
    };
  }

  const maximizing = state.currentPlayer === PieceType.Cat;

  // D3: simulate each legal action EXACTLY ONCE and reuse the transition while
  // searching. This is the single site where ordering can reorder — it never
  // re-simulates inside valueOfAction.
  const prepared: PreparedAction[] = actions.map((action, i) => ({
    action,
    transition: simulateSearchAction(state, action, ctx.rules),
    orderingScore: 0,
    originalIndex: i,
  }));

  const orderingOn = ctx.useMoveOrdering && prepared.length > 1;
  if (orderingOn) {
    for (const pa of prepared) {
      pa.orderingScore = computeOrderingScore(state, pa.transition);
    }
    // First priority: a TT bestAction hint. Even on a depth MISMATCH the cached
    // VALUE must not be reused (probeTT already enforces that), but the move is
    // still a valid ordering hint — provided it is currently legal.
    let ttFirstIndex = -1;
    if (ctx.useTT) {
      const e = ctx.tt.get(stateKey(state));
      if (e && e.bestAction) {
        const idx = prepared.findIndex((pa) => actionEqual(pa.action, e.bestAction));
        if (idx >= 0) ttFirstIndex = idx;
      }
    }
    prepared.sort((a, b) => {
      if (ttFirstIndex >= 0) {
        const aT = a.originalIndex === ttFirstIndex ? 1 : 0;
        const bT = b.originalIndex === ttFirstIndex ? 1 : 0;
        if (aT !== bT) return bT - aT; // TT hint to the front
      }
      // Tactical: MAX wants high cat-goodness first; MIN wants low first.
      const dir = maximizing ? -1 : 1;
      const diff = dir * (a.orderingScore - b.orderingScore);
      if (diff !== 0) return diff;
      return a.originalIndex - b.originalIndex; // stable tie-break
    });
    const firstOriginal = prepared[0].originalIndex;
    if (firstOriginal !== 0) ctx.diagnostics.orderingChangedFirstMove++;
    if (ttFirstIndex >= 0 && firstOriginal === ttFirstIndex) ctx.diagnostics.ttFirstMoveCount++;
    else if (firstOriginal !== 0) ctx.diagnostics.tacticalFirstMoveCount++;
    ctx.diagnostics.orderedNodes++;
  }

  let best: InternalSearchResult | null = null;
  let bestAction: SearchAction | null = null;
  let bestOriginalIndex = -1;
  // Conservative aggregation: a node is cacheable ONLY if EVERY searched action
  // completed AND was cacheable. If any action hits a repetition guard or a
  // budget cutoff, the node must NOT be stored as an EXACT entry.
  let allCompleted = true;
  let allCacheable = true;
  let cutOff = false;
  let firstIdx = true;
  for (const pa of prepared) {
    // F1A-3: the alpha-beta window and the resulting value are stepped by the
    // REAL game-time cost of THIS specific action (mateActionCost), not a
    // hard-coded ±1 per tree edge. A 0-cost action (catPlaceTrap, mouseSkill,
    // chooseTunnel) therefore leaves the mate distance untouched.
    const edgeCost = mateActionCost(pa.action);
    const childAlpha = unstepBoundForChild(alpha, edgeCost);
    const childBeta = unstepBoundForChild(beta, edgeCost);
    const childRes = valueOfAction(pa.transition, state, depthTurns, ctx, path, nodeCount, ply + 1, childAlpha, childBeta);
    // Propagate the child's value up one tree edge by the edge's real cost.
    // The step is driven by the child's EXPLICIT mate classification (see
    // stepChildForParent); a non-mate child is not stepped.
    const candidate: InternalSearchResult = {
      value: stepChildForParent(childRes, edgeCost),
      mate: childRes.mate,
      completed: childRes.completed,
      cacheable: childRes.cacheable,
      bound: childRes.bound,
    };
    // F1B (HARD_SEARCH debug): at the ROOT of a capture-enabled search, record
    // each root action's stepped value + mate for the TOP ROOT ACTIONS panel.
    // This reuses values the search already computed — no extra search cost.
    if (ctx.capturePlan && ply === 0) {
      ctx.rootValues.push({ action: pa.action, value: candidate.value, mate: candidate.mate });
    }
    // Selection: strict improvement, OR an exact tie broken by ORIGINAL legal
    // order. This guarantees ordering ON/OFF pick the SAME bestAction on ties.
    if (best === null) {
      best = candidate;
      bestAction = pa.action;
      bestOriginalIndex = pa.originalIndex;
    } else {
      const better = preferResult(candidate, best, maximizing);
      const tied = compareSearchScore(candidate, best) === 0;
      if (better || (tied && pa.originalIndex < bestOriginalIndex)) {
        best = candidate;
        bestAction = pa.action;
        bestOriginalIndex = pa.originalIndex;
      }
    }
    allCompleted = allCompleted && childRes.completed;
    allCacheable = allCacheable && childRes.cacheable;
    if (ctx.useAlphaBeta) {
      if (maximizing) {
        alpha = maxBound(alpha, { kind: 'score', score: { value: candidate.value, mate: candidate.mate } });
        if (compareBound(alpha, beta) >= 0) {
          cutOff = true;
          ctx.diagnostics.alphaBetaCutoffs++;
          ctx.diagnostics.alphaBetaMaxCutoffs++;
          if (firstIdx) ctx.diagnostics.firstMoveCutoffCount++;
          break;
        }
      } else {
        beta = minBound(beta, { kind: 'score', score: { value: candidate.value, mate: candidate.mate } });
        if (compareBound(alpha, beta) >= 0) {
          cutOff = true;
          ctx.diagnostics.alphaBetaCutoffs++;
          ctx.diagnostics.alphaBetaMinCutoffs++;
          if (firstIdx) ctx.diagnostics.firstMoveCutoffCount++;
          break;
        }
      }
    }
    firstIdx = false;
  }
  const boundType: SearchBoundType = cutOff ? (maximizing ? 'lower' : 'upper') : best!.bound;
  const result: InternalSearchResult = {
    value: best!.value,
    mate: best!.mate,
    bound: boundType,
    // `completed` / `cacheable` are NOT conflated with the Alpha-Beta cutoff
    // (D2 requirement #11). A cutoff is algorithmic PRUNING, not a search
    // ABORT, so it never by itself sets completed = false; the flags keep their
    // original meaning and are aggregated over the actions ACTUALLY searched
    // (the loop breaks on cutoff, so `allCompleted`/`allCacheable` already
    // describe exactly that subset).
    //
    // Deliberately NOT `cutOff ? true : allCompleted`: forcing completed=true
    // on a cutoff would HIDE a budget-truncated child from every ancestor, and
    // an ancestor could then be stored as a TT EXACT entry built on a truncated
    // (unsound) value. Reporting honestly keeps the budget semantics of Phase
    // C/D0/D1 byte-for-byte intact (see D2-J).
    //
    // A cutoff node is barred from the EXACT TT by `bound != 'exact'` ALONE
    // (see storeTT) — that is the single, sufficient gate. Leaving `cacheable`
    // honest means a cut-off child does not needlessly poison its parent: the
    // parent may still be stored when the parent's OWN bound is 'exact', which
    // is sound because a node marked 'exact' provably holds the true minimax
    // value (a 'lower' child forces the parent to cut off, and an 'upper' child
    // can never be the parent's best — so 'exact' is never mislabelled).
    completed: allCompleted,
    cacheable: allCompleted && allCacheable,
  };
  // F1B-2: record the decided best action for THIS node (state-keyed) when
  // plan capture is on. This is the actual search's principal-line decision —
  // the walker later follows exactly these state→action edges from the root
  // while the actor remains Cat. NOT a TT write; purely a per-search log.
  if (ctx.capturePlan && bestAction !== null) {
    ctx.planBranches.set(stateKey(state), bestAction);
  }
  return { result, bestAction };
}

function valueOfAction(
  transition: SearchTransitionResult,
  state: GameEngineState,
  depthTurns: number,
  ctx: SearchContext,
  path: Set<string>,
  nodeCount: { count: number },
  ply: number,
  alpha: ScoreBound = NEG_INF,
  beta: ScoreBound = POS_INF,
): InternalSearchResult {
  if (transition.kind === 'deterministic') {
    const next = transition.state;
    const switched = state.currentPlayer !== next.currentPlayer;
    const nd = depthTurns - (switched ? 1 : 0);
    // Pass the (already child-space) window down to the successor.
    return _search(next, nd, ctx, path, nodeCount, ply, alpha, beta);
  }

  // CHANCE node. The value is the expectation over all outcomes.
  ctx.diagnostics.chanceNodes++;
  // D2 INVARIANT: a CHANCE node is NEVER pruned by an inherited Alpha-Beta
  // window. Its expectation is Σ weight·value, and dropping "unpromising"
  // outcomes because the partial expectation already looks bad would change
  // the math (stochastic pruning is forbidden in D2). Every outcome is searched
  // with the FULL window, and we record that this happened so a test can prove
  // chance was not silently cut.
  ctx.diagnostics.fullWindowChanceSearches++;
  const outcomes = transition.outcomes;
  // All chance outcomes share the same actor flip (only the butter cell
  // differs), so the switch decision is uniform across them.
  const switched =
    outcomes.length > 0 && state.currentPlayer !== outcomes[0].state.currentPlayer;
  const nd = depthTurns - (switched ? 1 : 0);
  let total = 0;
  let allCompleted = true;
  let allCacheable = true;
  // The CHANCE node inherits a forced-mate classification ONLY when EVERY
  // outcome is a forced mate for the SAME side. A mix (one outcome mates for
  // the cat while another mates for the mouse, or one is not a mate at all)
  // collapses to `mate = null`: the expectation is then an ordinary heuristic,
  // never a forced mate, and must not be stepped or stored as a TT EXACT entry.
  // This is the explicit-mate fix that the old magnitude-based detection
  // (`abs(value) >= MATE_THRESHOLD`) could not make correctly.
  let allCat = true;
  let allMouse = true;
  if (outcomes.length === 0) {
    allCat = false;
    allMouse = false;
  }
  for (const o of outcomes) {
    // FULL WINDOW for every outcome — no pruning across a random node.
    const cr = _search(o.state, nd, ctx, path, nodeCount, ply, NEG_INF, POS_INF);
    total += o.weight * cr.value;
    if (!cr.completed) allCompleted = false;
    if (!cr.cacheable) allCacheable = false;
    if (cr.mate !== 'cat') allCat = false;
    if (cr.mate !== 'mouse') allMouse = false;
  }
  const mate: MateSide | null = allCat ? 'cat' : allMouse ? 'mouse' : null;
  // A fully-searched CHANCE (full window) yields the exact expectation, so its
  // bound is 'exact' (any truncation is already captured by completed=false).
  return { value: total, completed: allCompleted, cacheable: allCacheable, mate, bound: 'exact' };
}

function _search(
  state: GameEngineState,
  depthTurns: number,
  ctx: SearchContext,
  path: Set<string>,
  nodeCount: { count: number },
  ply: number,
  alpha: ScoreBound = NEG_INF,
  beta: ScoreBound = POS_INF,
): InternalSearchResult {
  // Repetition safety: if this exact game-affecting state already appears on
  // the CURRENT recursion path, we have a cycle. Return a static evaluation
  // and do NOT recurse (prevents infinite loops). This is NOT a game draw —
  // GAMEPLAY defines no repetition = draw, so we never alter the real phase.
  // The value depends on the current path, so it is NOT cacheable.
  const key = stateKey(state);

  // 1. Terminal (real win/loss) — always exact, dominates everything. Checked
  //    BEFORE the repetition guard (②): a terminal is a sink (no children), so
  //    it can never be a repetition *ancestor*; its mate score must never be
  //    blocked by a prior appearance of the same state on the current path.
  //    Node-local score (distance 0); the ±1 propagation happens in the parent.
  //    Path-independent → cacheable.
  if (state.phase === GamePhase.CatWins) {
    ctx.diagnostics.terminalNodes++;
    return { value: MATE_SCORE, completed: true, cacheable: true, mate: 'cat', bound: 'exact' };
  }
  if (state.phase === GamePhase.MouseWins) {
    ctx.diagnostics.terminalNodes++;
    return { value: -MATE_SCORE, completed: true, cacheable: true, mate: 'mouse', bound: 'exact' };
  }

  // 2. Repetition safety: if this exact game-affecting state already appears on
  //    the CURRENT recursion path, we have a cycle. Return a static evaluation
  //    and do NOT recurse (prevents infinite loops). This is NOT a game draw —
  //    GAMEPLAY defines no repetition = draw. The value depends on the current
  //    path, so it is NOT cacheable.
  if (path.has(key)) {
    ctx.diagnostics.repetitions++;
    return { value: evaluateLeaf(state, ctx), completed: true, cacheable: false, mate: null, bound: 'exact' };
  }
  path.add(key);
  try {
    if (ply > ctx.diagnostics.maxDepthReached) ctx.diagnostics.maxDepthReached = ply;

    // 3. Depth limit (in turns) → static eval. Deterministic for the state,
    //    so cacheable (the TT will treat it as a depth-bound, not exact).
    if (depthTurns <= 0) {
      ctx.diagnostics.leafNodes++;
      return { value: evaluateLeaf(state, ctx), completed: true, cacheable: true, mate: null, bound: 'exact' };
    }

    // 4. Hard safety budget → static eval (avoid search explosion). This is an
    //    APPROXIMATE, truncated value — NOT completed, NOT cacheable.
    if (nodeCount.count >= ctx.maxNodes) {
      ctx.diagnostics.budgetCutoffs++;
      return { value: evaluateLeaf(state, ctx), completed: false, cacheable: false, mate: null, bound: 'exact' };
    }

    // 4b. F1A-2 wall-clock deadline — SAME abort semantics as the maxNodes
    //     budget (static eval, completed=false, NOT cacheable, never an EXACT
    //     TT entry). This sits INSIDE `_search`, so the deadline can interrupt
    //     a RUNNING depth — it is not checked only between iterative-deepening
    //     iterations. The clock is sampled every `DEADLINE_CHECK_INTERVAL`
    //     nodes (see deadlineReached). A cost has already been paid for the
    //     node that reaches the deadline, so this is a soft stop, not a hard
    //     preemption — exactly the abort contract the node budget has.
    if (deadlineReached(ctx, nodeCount)) {
      ctx.diagnostics.deadlineCutoffs++;
      return { value: evaluateLeaf(state, ctx), completed: false, cacheable: false, mate: null, bound: 'exact' };
    }

    // 5. EXACT transposition-table probe (Phase D1). Must come AFTER the
    //    repetition guard (②) and the budget guard (④): a path-dependent
    //    repetition result must never be bypassed by a cached EXACT entry, and
    //    a budget-exhausted node must not pretend completion through a lookup.
    //    Only an EXACT depthTurns match is reused (no LOWER/UPPER bounds yet).
    const hit = probeTT(ctx, key, depthTurns);
    if (hit) {
      return { value: hit.value, mate: hit.mate, completed: true, cacheable: true, bound: 'exact' };
    }

    // 6. Action loop (MAX/MIN + optional Alpha-Beta). Delegated to searchActions
    //    so the interior node and the root share ONE loop definition. The node
    //    counter is bumped HERE (before the loop), matching Phase C/D0/D1
    //    budget-accounting exactly: the budget guard (④) sees the pre-increment
    //    count, then this node is counted once.
    nodeCount.count++;
    ctx.diagnostics.nodes++;
    const { result, bestAction } = searchActions(state, depthTurns, ctx, path, nodeCount, ply, alpha, beta);
    storeTT(ctx, key, depthTurns, result, bestAction ?? undefined);
    return result;
  } finally {
    path.delete(key);
  }
}

/**
 * NOTE (F1A-1): There is deliberately NO public `searchValue(state, depth,
 * ctx): number` entry point anymore.
 *
 * F0-hard-integration-audit.md §2.1 proved that a "returns a plain number"
 * API silently drops the `completed` flag: once the shared node budget is
 * exhausted, callers receive a static-eval fallback and CANNOT tell it apart
 * from a genuine full-depth value. Every earlier benchmark (f0bench.mts)
 * mis-ranked its oracle because of exactly this footgun.
 *
 * Consumers MUST go through an API that keeps `completed` (and `mate`)
 * visible:
 *   - `searchResult(state, depthTurns, ctx)`        → InternalSearchResult
 *   - `searchBestAction(state, depthTurns, ctx)`    → SearchBestActionResult
 *   - `searchBestActionIterative(state, opts)`      → IterativeSearchResult
 * Reading `.value` off one of those is fine; there is no number-only path
 * that hides truncation. A new test asserts the module no longer exports a
 * plain-number search entry point (`<no bare-number searchValue>`).
 */

/**
 * Full internal result entry point (state + completed + cacheable). Prepared
 * for the Phase D transposition table and iterative deepening.
 */
export function searchResult(
  state: GameEngineState,
  depthTurns: number,
  ctx: SearchContext,
): InternalSearchResult {
  const path = new Set<string>();
  const nodeCount = { count: 0 };
  return _search(state, depthTurns, ctx, path, nodeCount, 0, NEG_INF, POS_INF);
}

/**
 * Root entry point. Returns the best action for the current actor plus the
 * value and diagnostics. Used by tests and (later) the Hard AI. Does NOT wire
 * into the formal Hard path in Phase C.
 */
/**
 * Internal fixed-depth search used by BOTH the public `searchBestAction` and
 * the Phase D4 iterative-deepening wrapper.
 *
 * Phase D4 contract (critical):
 *   - Does NOT reset `ctx.diagnostics`. The public entry resets; the iterative
 *     wrapper deliberately does NOT, so diagnostics AND the global node budget
 *     accumulate across a deepening loop.
 *   - Uses the caller-supplied shared `nodeCount`. This is what makes the
 *     iterative search honour ONE global `maxNodes` budget across all depths
 *     instead of re-granting it per depth.
 *   - Writes into the shared `ctx.diagnostics` / `ctx.tt` exactly as the public
 *     entry would. Sharing one `ctx.tt` across iterations is therefore free,
 *     and shallow entries naturally become ordering hints for deeper ones.
 */
function runFixedSearch(
  state: GameEngineState,
  depthTurns: number,
  ctx: SearchContext,
  nodeCount: { count: number },
): { result: InternalSearchResult; bestAction: SearchAction | null } {
  if (state.phase === GamePhase.CatWins) {
    return {
      result: { value: MATE_SCORE, completed: true, cacheable: true, mate: 'cat', bound: 'exact' },
      bestAction: null,
    };
  }
  if (state.phase === GamePhase.MouseWins) {
    return {
      result: { value: -MATE_SCORE, completed: true, cacheable: true, mate: 'mouse', bound: 'exact' },
      bestAction: null,
    };
  }

  const actions = generateLegalSearchActions(state, ctx.rules);
  if (actions.length === 0) {
    const value = evaluateLeaf(state, ctx);
    return {
      result: { value, completed: true, cacheable: false, mate: null, bound: 'exact' },
      bestAction: null,
    };
  }

  // Phase D1: EXACT TT probe at the root. Reuses a prior full-depth result for
  // this exact state + depthTurns (e.g. from another search sharing this
  // context's table). Falls through to a full search on miss / mismatch.
  const rootKey = stateKey(state);
  const rootHit = probeTT(ctx, rootKey, depthTurns);
  // A playable EXACT entry MUST carry the best action for this node. Without it
  // we cannot return a complete answer, so we fall through to a full search
  // rather than pretend completion from a partial entry.
  if (rootHit && rootHit.bestAction) {
    return {
      result: { value: rootHit.value, mate: rootHit.mate, completed: true, cacheable: true, bound: 'exact' },
      bestAction: rootHit.bestAction,
    };
  }

  const path = new Set<string>();
  const { result, bestAction } = searchActions(state, depthTurns, ctx, path, nodeCount, 0, NEG_INF, POS_INF);
  if (bestAction !== null) storeTT(ctx, rootKey, depthTurns, result, bestAction);
  return { result, bestAction };
}

/**
 * F1B-2: walk the per-search decision log (`ctx.planBranches`) from `state`
 * along the principal line while the actor is still the CAT, producing the
 * current cat turn's plan.
 *
 * Semantics:
 *   - follows `stateKey(state) → bestAction` edges recorded by the ACTUAL
 *     search (never the TT);
 *   - each step is re-simulated through the REAL rules to advance to the
 *     successor state (legality is re-confirmed at execution time by the
 *     trajectory, not assumed here);
 *   - stops immediately when the successor switches to Mouse, reaches a
 *     terminal, or when the log has no entry for the next state;
 *   - zero-cost actions (catPlaceTrap, push via catStep, trap reclaim via
 *     catStep) naturally keep the same cat turn alive, so
 *     `[catPlaceTrap, catStep, …]` is a valid plan.
 */
export function buildCatTurnPlan(
  state: GameEngineState,
  ctx: SearchContext,
  maxLength = 8,
): SearchAction[] {
  const plan: SearchAction[] = [];
  let cur = state;
  // Prevent pathological cycles in the log walk (safety valve only):
  const seen = new Set<string>();
  while (plan.length < maxLength) {
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
    const key = stateKey(cur);
    if (seen.has(key)) break;
    seen.add(key);
    const action = ctx.planBranches.get(key);
    if (!action) break;
    plan.push(action);
    const trans = simulateSearchAction(cur, action, ctx.rules);
    if (trans.kind === 'chance') break; // cat actions are deterministic; safety
    const next = trans.state;
    // Stop when the cat's turn hands off to the mouse, or the game ends.
    if (next.phase !== GamePhase.Playing || next.currentPlayer !== PieceType.Cat) break;
    cur = next;
  }
  return plan;
}

export function searchBestAction(
  state: GameEngineState,
  depthTurns: number,
  ctx: SearchContext,
): SearchBestActionResult {
  resetDiagnostics(ctx.diagnostics);

  const nodeCount = { count: 0 };
  // F1B-2: record plan decisions for this fixed-depth search.
  if (ctx.capturePlan) {
    ctx.planBranches = new Map<string, SearchAction>();
    ctx.rootValues = [];
  }
  const { result, bestAction } = runFixedSearch(state, depthTurns, ctx, nodeCount);
  const catTurnPlan = ctx.capturePlan ? buildCatTurnPlan(state, ctx) : [];
  return { action: bestAction, value: result.value, mate: result.mate, completed: result.completed, diagnostics: ctx.diagnostics, catTurnPlan };
}

// ===========================================================================
// Phase D4 — Iterative Deepening + Global Node Budget (scheduler / wrapper)
// ===========================================================================
//
// D4 is a WRAPPER over the fixed-depth search. It does NOT change any search
// MATHEMATICS: every iteration is an ordinary fixed-depth search via
// `runFixedSearch`. On top of that it adds:
//
//   * Depth progression 1 → maxDepthTurns (each step a full fixed-depth search).
//   * ONE shared `maxNodes` budget across ALL iterations (a single shared
//     `nodeCount`), so total work is bounded by `maxNodes`, never `maxNodes`
//     per depth.
//   * ONE shared TranspositionTable across iterations: shallow entries become
//     ordering hints for deeper iterations (bestAction), but the D1 EXACT rule
//     (entry.depthTurns === requestedDepthTurns) still governs VALUE reuse, so a
//     depth-1 value can NEVER be returned as an exact depth-3 value.
//   * Rollback to the LAST COMPLETED iteration. A budget-truncated deeper
//     iteration is NEVER used; the returned answer comes from the deepest
//     completed depth.
//   * Optional F1A-2 wall-clock deadline: ONE shared `deadlineMs` across ALL
//     iterations, sampled inside `_search` (can interrupt a RUNNING depth).
//     The truncated iteration is discarded the same way a node-budget
//     truncation is, and `deadlineExceeded` reports the abort cause.
//   * No aspiration window (every root is full-window), no early mate stop —
//     per the D4 spec. Wall-clock timeout IS supported since F1A-2 (see
//     `IterativeSearchOptions.deadlineMs`).

/** Options for the iterative-deepening entry point. */
export interface IterativeSearchOptions {
  rules: RuleSet;
  /** Maximum depth (in turns) to attempt. */
  maxDepthTurns: number;
  /** GLOBAL node budget for the WHOLE iterative search (shared across depths). */
  maxNodes: number;
  useTT?: boolean;
  useAlphaBeta?: boolean;
  useMoveOrdering?: boolean;
  /** Optional deterministic leaf evaluator (same role as SearchContext.leafEvaluator). */
  leafEvaluator?: (state: GameEngineState) => number;
  /**
   * F1A-2: WALL-CLOCK deadline for the WHOLE iterative search (one shared
   * deadline across all depths, mirroring the one shared node budget). See
   * `SearchContext.deadlineMs` for the exact semantics — an absolute monotonic
   * timestamp in the time-base of `now`. A deadline can interrupt a RUNNING
   * depth (the check lives inside `_search`), not just between iterations; the
   * aborted depth is discarded and the deepest COMPLETED depth is returned.
   */
  deadlineMs?: number;
  /**
   * F1A-2: clock used to evaluate `deadlineMs` (default `performance.now()`).
   * Tests inject a FAKE clock for deterministic timeouts.
   */
  now?: () => number;
}

/** Per-iteration result, for inspection / diagnostics. */
export interface IterationDiagnostic {
  depthTurns: number;
  completed: boolean;
  /** Nodes consumed by THIS iteration (delta of the shared accumulator). */
  nodesUsed: number;
  value: number;
  mate: MateSide;
  bestAction: SearchAction | null;
}

/** Cumulative diagnostics for the whole iterative search. */
export interface IterativeSearchDiagnostics {
  /** Deepest depth whose iteration fully completed. 0 if none completed. */
  completedDepth: number;
  /** Deepest depth actually attempted (whether it completed or not). */
  attemptedDepth: number;
  iterationCount: number;
  /** Total nodes consumed across ALL iterations (the global budget spend). */
  totalNodes: number;
  budgetExhausted: boolean;
  /** F1A-2: true iff the search stopped because the wall-clock deadline
   *  (deadlineMs) fired before the last attempted depth completed. */
  deadlineExceeded: boolean;
  // Cumulative counters from the shared context (sum across iterations):
  ttHits: number;
  ttExactHits: number;
  ttDepthMismatches: number;
  alphaBetaCutoffs: number;
  orderedNodes: number;
  ttFirstMoveCount: number;
  tacticalFirstMoveCount: number;
  firstMoveCutoffCount: number;
}

export interface IterativeSearchResult {
  bestAction: SearchAction | null;
  value: number;
  mate: MateSide;
  /** Deepest depth whose iteration fully completed. */
  completedDepth: number;
  /** Deepest depth actually attempted (whether it completed or not). */
  attemptedDepth: number;
  /** True iff at least one iteration completed (a valid answer is returned). */
  completed: boolean;
  /** True iff the iterative search stopped early because the global node
   *  budget was exhausted before completing the last attempted depth. */
  budgetExhausted: boolean;
  /** F1A-2: True iff the iterative search stopped early because the
   *  wall-clock deadline (deadlineMs) fired before the last attempted depth
   *  completed. The returned answer still comes from the deepest COMPLETED
   *  depth (or an explicit incomplete/fallback state if none completed). */
  deadlineExceeded: boolean;
  /** F1B-2: principal-line plan for the current cat turn, from the deepest
   *  COMPLETED iteration's actual search decisions. Empty when none completed. */
  catTurnPlan: SearchAction[];
  /** F1B (HARD_SEARCH debug): root action values of the deepest COMPLETED
   *  iteration (from the actual search, no extra cost). Empty when off/none. */
  rootActions: { action: SearchAction; value: number; mate: MateSide }[];
  diagnostics: IterativeSearchDiagnostics;
  /** One entry per attempted depth (oldest first). */
  iterations: IterationDiagnostic[];
}

/**
 * Iterative-deepening search with a single GLOBAL node budget.
 *
 * Returns the result of the deepest COMPLETED iteration. If no iteration
 * completes at all (even depth 1), returns `completedDepth = 0`,
 * `bestAction = null`, and a neutral `value = 0` / `mate = null` — never a
 * partial (incomplete) result dressed up as complete.
 */
export function searchBestActionIterative(
  state: GameEngineState,
  opts: IterativeSearchOptions,
): IterativeSearchResult {
  const ctx = createSearchContext(
    opts.rules,
    opts.maxNodes,
    opts.useTT ?? false,
    opts.useAlphaBeta ?? false,
    opts.useMoveOrdering ?? false,
  );
  if (opts.leafEvaluator) ctx.leafEvaluator = opts.leafEvaluator;
  // F1A-2: one shared wall-clock deadline across ALL iterations (the deadline
  // lives on the shared context, so `_search` samples `now()` during every
  // depth — a mid-depth abort is possible, not just an inter-iteration one).
  if (opts.deadlineMs !== undefined) ctx.deadlineMs = opts.deadlineMs;
  if (opts.now) ctx.now = opts.now;
  // F1B-2: capture the principal-line decisions so the returned catTurnPlan
  // comes from THIS search (never the TT).
  ctx.capturePlan = true;

  // ONE shared node counter for the whole deepening loop → the global budget.
  const nodeCount = { count: 0 };
  const iterations: IterationDiagnostic[] = [];
  let lastCompleted: { value: number; mate: MateSide; bestAction: SearchAction | null } | null = null;
  let lastCatTurnPlan: SearchAction[] = [];
  let lastRootValues: { action: SearchAction; value: number; mate: MateSide }[] = [];
  let completedDepth = 0;
  let attemptedDepth = 0;
  let budgetExhausted = false;
  let deadlineExceeded = false;

  for (let d = 1; d <= opts.maxDepthTurns; d++) {
    attemptedDepth = d;
    const nodesBefore = ctx.diagnostics.nodes;
    // F1B-2: a fresh decision log per iteration. Completed iterations snapshot
    // their principal line; an incomplete (truncated) iteration is discarded,
    // so its partial writes never leak into the final plan.
    ctx.planBranches = new Map<string, SearchAction>();
    ctx.rootValues = [];
    const { result, bestAction } = runFixedSearch(state, d, ctx, nodeCount);
    const nodesUsed = ctx.diagnostics.nodes - nodesBefore;
    iterations.push({
      depthTurns: d,
      completed: result.completed,
      nodesUsed,
      value: result.value,
      mate: result.mate,
      bestAction,
    });
    if (result.completed) {
      // Trust ONLY completed iterations. Keep overwriting with the deeper
      // completed result — they are all mathematically full searches.
      lastCompleted = { value: result.value, mate: result.mate, bestAction };
      completedDepth = d;
      // F1B-2: a COMPLETED iteration owns its full principal line; keep it.
      lastCatTurnPlan = buildCatTurnPlan(state, ctx);
      // F1B (HARD_SEARCH debug): keep the completed depth's root action values.
      lastRootValues = ctx.rootValues.slice();
    } else {
      // Incomplete (node-budget OR wall-clock truncated). NEVER use the
      // truncated iteration's own result; the answer (and the plan) keeps
      // coming from the deepest COMPLETED iteration (F1B-2/F1B-3). Distinguish
      // the abort cause so callers can tell a deadline timeout from a
      // node-budget exhaustion (F1A-2).
      if (ctx.diagnostics.deadlineCutoffs > 0) deadlineExceeded = true;
      else budgetExhausted = true;
      break; // do NOT clear lastCatTurnPlan (it holds the completed depth's plan)
    }
  }

  const d = ctx.diagnostics;
  const finalValue = lastCompleted ? lastCompleted.value : 0;
  const finalMate = lastCompleted ? lastCompleted.mate : null;
  const finalAction = lastCompleted ? lastCompleted.bestAction : null;

  return {
    bestAction: finalAction,
    value: finalValue,
    mate: finalMate,
    completedDepth,
    attemptedDepth,
    completed: completedDepth >= 1,
    budgetExhausted,
    deadlineExceeded,
    catTurnPlan: lastCatTurnPlan,
    rootActions: lastRootValues,
    diagnostics: {
      completedDepth,
      attemptedDepth,
      iterationCount: iterations.length,
      totalNodes: d.nodes,
      budgetExhausted,
      deadlineExceeded,
      ttHits: d.ttHits,
      ttExactHits: d.ttExactHits,
      ttDepthMismatches: d.ttDepthMismatches,
      alphaBetaCutoffs: d.alphaBetaCutoffs,
      orderedNodes: d.orderedNodes,
      ttFirstMoveCount: d.ttFirstMoveCount,
      tacticalFirstMoveCount: d.tacticalFirstMoveCount,
      firstMoveCutoffCount: d.firstMoveCutoffCount,
    },
    iterations,
  };
}
