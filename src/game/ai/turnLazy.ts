/**
 * ============================================================================
 * G0.3L — Lazy Exact Turn-Boundary Search prototype (v2).
 *
 * FORENSIC / PROTOTYPE ONLY. NOT wired into production. Does NOT modify
 * turnBoundary.ts (the G0.3K eager oracle) or expectiminimax.ts.
 *
 * CORE IDEA: don't prebuild the full within-turn DAG. Let the alpha-beta
 * search drive generation: only generate a successor when the search actually
 * requests it, and stop generating siblings once a cutoff fires
 * (LAZY_CHILDREN_SAVED_BY_AB).
 *
 * v2 fixes (from G0.3L sanity FAIL):
 *   - memo/TT key = (stateKey, depth), NOT cumulative cost. A node's value is
 *     expressed in ITS OWN frame (parent steps by edge cost), so two paths to
 *     the same state at the same remaining depth share the same value. Including
 *     cost defeated transposition (move→trap vs trap→move computed twice),
 *     exploding the tree (A d2 was 1M nodes vs legacy 4.3K).
 *   - Move ordering: tactical closeness (reuse legacy computeOrderingScore
 *     logic) + TT hint, so alpha-beta actually cuts.
 *
 * CORRECTNESS (inherited from G0.3K audit, verified exact there):
 *   A. CHANCE: DECISION→CHANCE→DECISION, full expectation, never pruned.
 *   B. mateActionCost stepping: parent steps child by real edge cost
 *      (catStep=1, mouseStep=1, 0-cost actions=0). Boundary/terminal costs are
 *      applied by the PARENT, never stored in the key.
 *   C. repetition: path set of stateKeys (same as atomic). d1/d2 no-op.
 *   D/E: terminal + immediate turn-ending rules are natural boundaries.
 *
 * Frame convention (bit-identical to legacy): resolveTurn returns its value in
 * ITS OWN frame; terminal nodes report node-local ±MATE; parent steps child by
 * edge cost.
 * ============================================================================
 */
import type { GameEngineState } from '../engine';
import { GamePhase, PieceType } from '../types';
import type { RuleSet, SearchAction, SearchTransitionResult } from './searchTypes';
import { generateLegalSearchActions } from './legalActions';
import { simulateSearchAction } from './simulator';
import { stateKey } from './transposition';
import { mateActionCost, MATE_SCORE, defaultLeafEval, compareSearchScore, type ScoreBound, type MateSide } from './expectiminimax';
import { classifyGoalThreat } from './threatClassifier';

// ---------------------------------------------------------------------------
// Score bounds (mirror expectiminimax, kept local to stay engine-free)
// ---------------------------------------------------------------------------
const NEG_INF: ScoreBound = { kind: 'negative-infinity' };
const POS_INF: ScoreBound = { kind: 'positive-infinity' };

function compareBound(a: ScoreBound, b: ScoreBound): number {
  if (a.kind === 'negative-infinity' && b.kind === 'negative-infinity') return 0;
  if (a.kind === 'negative-infinity') return -1;
  if (b.kind === 'negative-infinity') return 1;
  if (a.kind === 'positive-infinity' && b.kind === 'positive-infinity') return 0;
  if (a.kind === 'positive-infinity') return 1;
  if (b.kind === 'positive-infinity') return -1;
  return compareSearchScore(a.score, b.score);
}

function unstepBound(b: ScoreBound, cost: number): ScoreBound {
  if (b.kind !== 'score') return b;
  const s = b.score;
  if (s.mate === 'cat') return { kind: 'score', score: { value: s.value + cost, mate: 'cat' } };
  if (s.mate === 'mouse') return { kind: 'score', score: { value: s.value - cost, mate: 'mouse' } };
  return b;
}

function stepScore(v: number, mate: MateSide, cost: number): { value: number; mate: MateSide } {
  if (mate === 'cat') return { value: v - cost, mate };
  if (mate === 'mouse') return { value: v + cost, mate };
  return { value: v, mate };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface LazyDiagnostics {
  generatedTransitions: number;
  skippedByAlphaBeta: number;
  potentialChildren: number;
  /**
   * G0.3L honesty counter: how many times `simulateSearchAction` actually ran.
   * Ordering needs each child's successor state (legacy does the same in
   * `prepared`), so siblings ARE simulated even when their SUBTREE is later
   * skipped by alpha-beta. `skippedByAlphaBeta` therefore counts skipped
   * SUBTREE EXPANSIONS, not skipped simulations. Reported separately so the
   * lazy-generation claim is not overstated.
   */
  orderingSimulations: number;
  /**
   * Nodes actually EXPANDED (one per resolveTurn that got past memo/TT/budget).
   * This is the apples-to-apples counterpart of legacy `diagnostics.nodes`;
   * `generatedTransitions` counts EDGES and is therefore ~branching-factor
   * larger. Comparing gen against legacy nodes overstates lazy's cost.
   */
  expandedNodes: number;
  /** Alpha-beta cutoff EVENTS (comparable to legacy `alphaBetaCutoffs`). */
  alphaBetaCutoffs: number;
  withinTurnProbes: number;
  withinTurnHits: number;
  withinTurnMisses: number;
  nodesSavedByWithinTurn: number;
  turnTTProbes: number;
  turnTTHits: number;
  turnTTExactHits: number;
  turnTTStores: number;
  maxPly: number;
  terminalNodes: number;
  leafNodes: number;
  repetitions: number;
  chanceExpansions: number;
  chanceOutcomesTotal: number;
  maxChanceOutcomes: number;
  budgetCutoffs: number;
  deadlineCutoffs: number;
}

function freshDiag(): LazyDiagnostics {
  return {
    generatedTransitions: 0, skippedByAlphaBeta: 0, potentialChildren: 0, orderingSimulations: 0,
    expandedNodes: 0, alphaBetaCutoffs: 0,
    withinTurnProbes: 0, withinTurnHits: 0, withinTurnMisses: 0, nodesSavedByWithinTurn: 0,
    turnTTProbes: 0, turnTTHits: 0, turnTTExactHits: 0, turnTTStores: 0,
    maxPly: 0, terminalNodes: 0, leafNodes: 0, repetitions: 0,
    chanceExpansions: 0, chanceOutcomesTotal: 0, maxChanceOutcomes: 0,
    budgetCutoffs: 0, deadlineCutoffs: 0,
  };
}

// ---------------------------------------------------------------------------
// Turn-level TT (EXACT stored; LOWER/UPPER only for pruning)
// ---------------------------------------------------------------------------

export interface TurnTTEntry {
  depth: number;
  value: number;
  mate: MateSide;
  bound: 'exact' | 'lower' | 'upper';
  witness: SearchAction[];
}

export class TurnTT {
  private map = new Map<string, TurnTTEntry>();
  /**
   * G0.3L-v3 BUGFIX: ordering hints must be keyed by stateKey ALONE, exactly
   * like legacy (`ctx.tt.get(stateKey(state))` → `entry.bestAction`), because
   * the value table is keyed by (stateKey, depth) and therefore cannot be
   * probed by state alone.
   *
   * The v2 implementation ignored its `stateKey` argument and returned the
   * FIRST entry in the map that had a witness — i.e. an arbitrary action from
   * an unrelated position, force-sorted to the front of EVERY node's move
   * list. That silently destroyed alpha-beta ordering globally.
   *
   * Replacement policy mirrors legacy `storeTT`: prefer the deeper entry.
   * Ordering-only; can never change a value.
   */
  private hints = new Map<string, { depth: number; action: SearchAction }>();
  get size(): number { return this.map.size; }
  get(key: string): TurnTTEntry | undefined { return this.map.get(key); }
  set(key: string, e: TurnTTEntry): void { this.map.set(key, e); }
  /** Record a per-state ordering hint (legacy parity: from EXACT stores only). */
  setHint(stateKey: string, depth: number, action: SearchAction): void {
    const existing = this.hints.get(stateKey);
    if (existing && existing.depth > depth) return;
    this.hints.set(stateKey, { depth, action });
  }
  /** Legacy-parity ordering hint for THIS state (any depth). */
  hint(stateKey: string): SearchAction | undefined {
    return this.hints.get(stateKey)?.action;
  }
  /**
   * Reproduces the v2 BUG on demand (measurement only, never for truth runs):
   * returns the first witness-bearing entry regardless of which state is asked
   * about. Used by the G0.3L report to quantify the ordering damage.
   */
  hintFirstEntryBug(): SearchAction | undefined {
    for (const e of this.map.values()) if (e.witness.length > 0) return e.witness[0];
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Search context / state
// ---------------------------------------------------------------------------

export interface LazyOptions {
  rules: RuleSet;
  maxDepthTurns?: number;
  maxNodes?: number;
  leafEvaluator?: (state: GameEngineState) => number;
  deadlineMs?: number;
  now?: () => number;
  /**
   * Ordering-hint source. 'state' = legacy parity (default, correct).
   * 'firstEntry' = reproduce the v2 bug. 'off' = tactical ordering only.
   * ORDERING ONLY — never affects the returned value.
   */
  ttHintMode?: 'state' | 'firstEntry' | 'off';
  /**
   * When false, run ONLY `maxDepthTurns` (single pass) instead of iterative
   * deepening 1..maxDepthTurns. Needed for apples-to-apples fixed-depth
   * comparison against legacy `searchBestAction(root, depth, ctx)`, which is
   * also a single fixed-depth pass. Default true (budgeted/anytime mode).
   */
  iterativeDeepening?: boolean;
}

interface TurnResult {
  value: number;
  mate: MateSide;
  completed: boolean;
  cacheable: boolean;
  bound: 'exact' | 'lower' | 'upper';
  /** Real atomic actions from THIS node to the achieving boundary/terminal. */
  witness: SearchAction[];
}

interface SearchState {
  diag: LazyDiagnostics;
  memo: Map<string, TurnResult>;
  tt: TurnTT;
  path: Set<string>;
  nodeCount: { count: number };
  maxPly: number;
  options: LazyOptions;
  /**
   * G0.3L-v3 (§9): equal-primary alternates at the ROOT. Filled only by the
   * root invocation of `resolveTurn`; one entry per first atomic cat action
   * that the root loop actually evaluated. Same caveat as legacy
   * `ctx.rootValues`: entries produced after an alpha-beta window narrowing
   * may be bounds, so consumers must treat `bound !== 'exact'` accordingly.
   * WRITE-ONLY diagnostics — never read by the search itself.
   */
  rootActions: RootActionValue[];
}

/** One root first-action alternate (for the R2 plan-quality extractor). */
export interface RootActionValue {
  action: SearchAction;
  value: number;
  mate: MateSide;
  bound: 'exact' | 'lower' | 'upper';
  /** Atomic cat-turn prefix achieving this value (cat actions only). */
  catTurnPlan: SearchAction[];
}

export interface LazySearchResult {
  value: number;
  mate: MateSide;
  completedDepth: number;
  attemptedDepth: number;
  completed: boolean;
  budgetExhausted: boolean;
  deadlineExceeded: boolean;
  bestAction: SearchAction | null;
  /** Full principal-variation witness (may cross the turn boundary). */
  plan: SearchAction[];
  /**
   * G0.3L-v3 (§9): the REAL atomic cat turn plan — the prefix of `plan` up to
   * (excluding) the first non-cat action. This is the production-shaped
   * artifact; `plan` is the raw PV and includes the opponent's reply.
   */
  catTurnPlan: SearchAction[];
  /** G0.3L-v3 (§9): root first-action alternates for the R2 extractor. */
  rootActions: RootActionValue[];
  diagnostics: LazyDiagnostics;
  iterations: { depth: number; completed: boolean; value: number; mate: MateSide; nodes: number }[];
}

// ---------------------------------------------------------------------------
// Core recursion
// ---------------------------------------------------------------------------

/** Atomic cat-turn prefix of a witness (cat actions only). */
export function catTurnPrefix(witness: SearchAction[]): SearchAction[] {
  const out: SearchAction[] = [];
  for (const a of witness) {
    if (a.type !== 'catStep' && a.type !== 'catPlaceTrap') break;
    out.push(a);
  }
  return out;
}

function resolveTurn(
  state: GameEngineState,
  depth: number,
  alpha: ScoreBound,
  beta: ScoreBound,
  cost: number,
  ss: SearchState,
  isRoot = false,
): TurnResult {
  const d = ss.diag;
  const opts = ss.options;
  const ev = opts.leafEvaluator ?? defaultLeafEval;

  const sk = stateKey(state);

  // 1. Terminal (node-local ±MATE; parent steps).
  if (state.phase === GamePhase.CatWins) {
    d.terminalNodes++;
    return { value: MATE_SCORE, mate: 'cat', completed: true, cacheable: true, bound: 'exact', witness: [] };
  }
  if (state.phase === GamePhase.MouseWins) {
    d.terminalNodes++;
    return { value: -MATE_SCORE, mate: 'mouse', completed: true, cacheable: true, bound: 'exact', witness: [] };
  }

  // 2. Repetition.
  if (ss.path.has(sk)) {
    d.repetitions++;
    d.leafNodes++;
    return { value: ev(state), mate: null, completed: true, cacheable: false, bound: 'exact', witness: [] };
  }

  // 3. Depth limit.
  if (depth <= 0) {
    d.leafNodes++;
    return { value: ev(state), mate: null, completed: true, cacheable: true, bound: 'exact', witness: [] };
  }

  // KEY (v2): memo/TT keyed by (stateKey, depth) ONLY. A node's value is in
  // ITS OWN frame — the parent applies the real edge cost when stepping. Two
  // paths to the same state at the same remaining depth have the same value
  // regardless of accumulated cost, so including cost would break
  // transposition. EXACT for d1/d2 (stateKey covers currentPlayer ⇒ path
  // repetition never fires; memo is per-iteration so no cross-depth pollution).
  const mkey = `${sk}\x00${depth}`;

  // 4. Within-turn memo (before budget: memo hits regenerate nothing).
  //
  // G0.3L-v3 INSTRUMENTATION FIX: v2 incremented `withinTurnProbes` only on a
  // HIT, which made probes === hits and the hit rate meaningless. Count every
  // probe, then hit/miss.
  d.withinTurnProbes++;
  const cached = ss.memo.get(mkey);
  if (cached) {
    d.withinTurnHits++;
    d.nodesSavedByWithinTurn += 1;
    return cached;
  }
  d.withinTurnMisses++;

  // 5. Turn-level TT (EXACT depth match).
  const ttKey = `${sk}\x00${depth}`;
  d.turnTTProbes++;
  const tt = ss.tt.get(ttKey);
  if (tt && tt.bound === 'exact') {
    d.turnTTHits++;
    d.turnTTExactHits++;
    return { value: tt.value, mate: tt.mate, completed: true, cacheable: true, bound: 'exact', witness: tt.witness };
  }
  // Lower/upper bound entry: use for pruning. A cutoff is a SOUND proof (the
  // true value lies on one side), NOT a search abort — so `completed` stays
  // true, but the result is a bound (not cacheable as EXACT). This mirrors the
  // legacy alpha-beta cutoff semantics exactly (a cutoff keeps completed=true).
  if (tt && tt.bound === 'lower' && compareBound({ kind: 'score', score: { value: tt.value, mate: tt.mate } }, beta) >= 0) {
    d.turnTTHits++;
    return { value: tt.value, mate: tt.mate, completed: true, cacheable: false, bound: 'lower', witness: tt.witness };
  }
  if (tt && tt.bound === 'upper' && compareBound({ kind: 'score', score: { value: tt.value, mate: tt.mate } }, alpha) <= 0) {
    d.turnTTHits++;
    return { value: tt.value, mate: tt.mate, completed: true, cacheable: false, bound: 'upper', witness: tt.witness };
  }

  // 6. Budget / deadline. (`searchTurnLazy` always injects a concrete
  // maxNodes into `ss.options`; the fallback only satisfies the optional type.)
  if (ss.nodeCount.count >= (opts.maxNodes ?? Number.MAX_SAFE_INTEGER)) {
    ss.nodeCount.count++;
    d.budgetCutoffs++;
    d.leafNodes++;
    return { value: ev(state), mate: null, completed: false, cacheable: false, bound: 'exact', witness: [] };
  }
  if (opts.deadlineMs !== undefined && ss.nodeCount.count % 64 === 0) {
    const now = opts.now ?? (() => performance.now());
    if (now() >= opts.deadlineMs) {
      d.deadlineCutoffs++;
      d.leafNodes++;
      return { value: ev(state), mate: null, completed: false, cacheable: false, bound: 'exact', witness: [] };
    }
  }
  ss.nodeCount.count++;
  d.expandedNodes++;
  if (cost > ss.maxPly) ss.maxPly = cost;

  ss.path.add(sk);
  try {
    const actions = generateLegalSearchActions(state, opts.rules);
    d.potentialChildren += actions.length;
    if (actions.length === 0) {
      d.leafNodes++;
      return { value: ev(state), mate: null, completed: true, cacheable: true, bound: 'exact', witness: [] };
    }

    const maximizing = state.currentPlayer === PieceType.Cat;

    // LAZY move ordering: returns (action, precomputed transition) so the
    // main loop reuses the simulation (no double-simulate).
    const ordered = orderActions(state, actions, ss, maximizing);

    let best: TurnResult | null = null;
    let allCompleted = true;
    let allCacheable = true;
    let cut = false;

    for (let idx = 0; idx < ordered.length; idx++) {
      const { action, trans } = ordered[idx];
      // LAZY: this child's transition was generated on request.
      d.generatedTransitions++;
      const edgeCost = mateActionCost(action);
      const childAlpha = unstepBound(alpha, edgeCost);
      const childBeta = unstepBound(beta, edgeCost);

      let child: TurnResult;
      if (trans.kind === 'chance') {
        // Full-window expectation over ALL outcomes (never pruned).
        child = resolveChance(trans, depth, cost + edgeCost, ss);
      } else {
        const next = trans.state;
        const switched = state.currentPlayer !== next.currentPlayer;
        const terminal = next.phase === GamePhase.CatWins || next.phase === GamePhase.MouseWins;
        if (terminal) {
          const mate: MateSide = next.phase === GamePhase.CatWins ? 'cat' : 'mouse';
          const base = mate === 'cat' ? MATE_SCORE : -MATE_SCORE;
          child = { value: base, mate, completed: true, cacheable: true, bound: 'exact', witness: [] };
        } else if (switched) {
          // Boundary: new macro-turn frame (cost=0), depth-1.
          child = resolveTurn(next, depth - 1, childAlpha, childBeta, 0, ss);
        } else {
          // Same turn continues: same depth, cost accumulates.
          child = resolveTurn(next, depth, childAlpha, childBeta, cost + edgeCost, ss);
        }
      }

      // Step the child's value into THIS node's frame.
      const steppedScore = stepScore(child.value, child.mate, edgeCost);
      const stepped: TurnResult = {
        value: steppedScore.value,
        mate: child.mate,
        completed: child.completed,
        cacheable: child.cacheable,
        bound: child.bound,
        witness: [action, ...child.witness],
      };

      // §9: record the root alternate BEFORE any selection/cut bookkeeping so
      // every first atomic action the root loop evaluated is visible to the R2
      // extractor. Write-only; never read by the search.
      if (isRoot) {
        ss.rootActions.push({
          action,
          value: stepped.value,
          mate: stepped.mate,
          bound: stepped.bound,
          catTurnPlan: catTurnPrefix(stepped.witness),
        });
      }

      // Selection (same comparator as legacy preferResult).
      if (best === null || better(stepped, best, maximizing)) {
        best = stepped;
      }
      allCompleted = allCompleted && child.completed;
      allCacheable = allCacheable && child.cacheable;

      // Alpha-beta over the generated child.
      if (maximizing) {
        const sc = { kind: 'score', score: { value: stepped.value, mate: stepped.mate } } as ScoreBound;
        const cb = compareBound(sc, alpha);
        if (cb > 0) alpha = sc;
        if (compareBound(alpha, beta) >= 0) {
          cut = true;
          d.alphaBetaCutoffs++;
          d.skippedByAlphaBeta += (ordered.length - idx - 1);
          break;
        }
      } else {
        const sc = { kind: 'score', score: { value: stepped.value, mate: stepped.mate } } as ScoreBound;
        const cb = compareBound(sc, beta);
        if (cb < 0) beta = sc;
        if (compareBound(alpha, beta) >= 0) {
          cut = true;
          d.alphaBetaCutoffs++;
          d.skippedByAlphaBeta += (ordered.length - idx - 1);
          break;
        }
      }
    }

    if (!best) {
      d.leafNodes++;
      return { value: ev(state), mate: null, completed: true, cacheable: true, bound: 'exact', witness: [] };
    }

    const bound: 'exact' | 'lower' | 'upper' = cut ? (maximizing ? 'lower' : 'upper') : best.bound;
    const result: TurnResult = {
      value: best.value,
      mate: best.mate,
      completed: allCompleted,
      cacheable: allCacheable,
      bound,
      witness: best.witness,
    };

    // Within-turn memo (only fully-resolved, path-independent, EXACT results).
    //
    // G0.3L-v3 SOUNDNESS FIX: v2 stored the result even when `bound` was
    // 'lower'/'upper' (an alpha-beta cutoff, or a best child that was itself
    // bounded), and the memo probe returns cached entries unconditionally as
    // exact values. Reusing a fail-high/fail-low bound as an exact value in a
    // DIFFERENT window is unsound and can return a wrong value. Legacy's
    // `storeTT` gates on exactly this (`if (result.bound !== 'exact') return`),
    // so this is legacy parity, not a new rule.
    if (allCompleted && allCacheable && bound === 'exact') {
      ss.memo.set(mkey, { ...result, witness: [] });
    }

    // Turn-level TT: EXACT only (fully completed + cacheable + not a cutoff).
    if (allCompleted && allCacheable && bound === 'exact') {
      ss.tt.set(ttKey, { depth, value: best.value, mate: best.mate, bound: 'exact', witness: best.witness });
      // Legacy parity: bestAction hint recorded per-state on EXACT stores only.
      if (best.witness.length > 0) ss.tt.setHint(sk, depth, best.witness[0]);
      d.turnTTStores++;
    } else if (cut) {
      // Store a bound entry for pruning (never exact-reuse).
      ss.tt.set(ttKey, { depth, value: best.value, mate: best.mate, bound, witness: best.witness });
    }

    return result;
  } finally {
    ss.path.delete(sk);
  }
}

/** Full expectation over a chance transition (never pruned). */
function resolveChance(
  trans: { kind: 'chance'; outcomes: { state: GameEngineState; weight: number }[] },
  depth: number,
  cost: number,
  ss: SearchState,
): TurnResult {
  const d = ss.diag;
  d.chanceExpansions++;
  const outcomes = trans.outcomes;
  d.chanceOutcomesTotal += outcomes.length;
  if (outcomes.length > d.maxChanceOutcomes) d.maxChanceOutcomes = outcomes.length;
  let total = 0;
  let allCompleted = true;
  let allCacheable = true;
  let allCat = true;
  let allMouse = true;
  for (const o of outcomes) {
    // Full window for every outcome — never prune across a random node.
    const r = resolveTurn(o.state, depth, NEG_INF, POS_INF, cost, ss);
    total += o.weight * r.value;
    if (!r.completed) allCompleted = false;
    if (!r.cacheable) allCacheable = false;
    if (r.mate !== 'cat') allCat = false;
    if (r.mate !== 'mouse') allMouse = false;
  }
  const mate: MateSide = allCat ? 'cat' : allMouse ? 'mouse' : null;
  return { value: total, mate, completed: allCompleted, cacheable: allCacheable, bound: 'exact', witness: [] };
}

function better(a: TurnResult, b: TurnResult, maximizing: boolean): boolean {
  const cmp = compareSearchScore({ value: a.value, mate: a.mate }, { value: b.value, mate: b.mate });
  if (cmp === 0) return false;
  return maximizing ? cmp > 0 : cmp < 0;
}

function actionKey(a: SearchAction): string {
  if (a.type === 'catStep' || a.type === 'mouseStep') return `${a.type}:${a.direction.key}`;
  if (a.type === 'chooseTunnel') return `${a.type}:${a.r},${a.c}`;
  return a.type;
}

/**
 * LAZY move ordering (reuse legacy computeOrderingScore logic; value-neutral):
 *   1. TT hint (any-depth entry's bestAction) first.
 *   2. Tactical closeness + threat-aware BFS route delta — the SAME scoring
 *      the legacy search uses (`computeOrderingScore`): Manhattan closeness
 *      ×10, plus when the current state is classified near/critical by
 *      `classifyGoalThreat`, a BFS win-route delta term (weighted 100/500).
 *      MAX (cat) sorts descending; MIN (mouse) ascending. Only order changes,
 *      never the value.
 * The transition for each action is simulated ONCE here and returned so the
 * main loop reuses it (no double simulate).
 */
function orderActions(
  state: GameEngineState,
  actions: SearchAction[],
  ss: SearchState,
  maximizing: boolean,
): { action: SearchAction; trans: SearchTransitionResult }[] {
  const opts = ss.options;
  const sk = stateKey(state);

  const hintMode = opts.ttHintMode ?? 'state';
  const hint = hintMode === 'state' ? ss.tt.hint(sk)
    : hintMode === 'firstEntry' ? ss.tt.hintFirstEntryBug()
    : undefined;
  const hintKey = hint ? actionKey(hint) : null;

  const before = { r: state.catPosition.r, c: state.catPosition.c };
  const mouse = { r: state.mousePosition.r, c: state.mousePosition.c };
  const manhattan = (r: number, c: number) => Math.abs(r - mouse.r) + Math.abs(c - mouse.c);
  const beforeDist = manhattan(before.r, before.c);

  // Threat classification ONCE (legacy does this once per node too).
  const threat = classifyGoalThreat(state);
  const threatUrgency = threat.urgency;

  const scored = actions.map((a, i) => {
    ss.diag.orderingSimulations++;
    const trans = simulateSearchAction(state, a, opts.rules);
    const next = trans.kind === 'deterministic' ? trans.state : trans.outcomes[0].state;
    const afterDist = manhattan(next.catPosition.r, next.catPosition.c);
    // cat-perspective tactical score (higher = better for cat).
    let score = (beforeDist - afterDist) * 10;
    // Immediate win/loss dominate (mirror legacy computeOrderingScore).
    if (next.phase === GamePhase.CatWins) score += 1_000_000;
    if (next.phase === GamePhase.MouseWins) score -= 1_000_000;
    // Threat-aware BFS route delta (legacy computeOrderingScore §G0.3B).
    if (threatUrgency !== 'none') {
      const nextThreat = classifyGoalThreat(next);
      const currentRoute = threat.winRoute ?? 9999;
      const nextRoute = nextThreat.winRoute ?? 9999;
      const routeDelta = nextRoute - currentRoute; // + = mouse farther = good for cat
      const weight = threatUrgency === 'critical' ? 500 : 100;
      score += routeDelta * weight;
    }
    return { action: a, trans, score, isHint: hintKey !== null && actionKey(a) === hintKey, i };
  });

  scored.sort((x, y) => {
    if (x.isHint !== y.isHint) return x.isHint ? -1 : 1;
    const dir = maximizing ? -1 : 1; // MAX desc, MIN asc
    const diff = dir * (x.score - y.score);
    if (diff !== 0) return diff;
    return x.i - y.i; // stable tie-break by original order
  });

  return scored.map(({ action, trans }) => ({ action, trans }));
}

// ---------------------------------------------------------------------------
// Public entry — lazy iterative deepening (shared TT across depths,
// one global maxNodes, like the legacy iterative wrapper)
// ---------------------------------------------------------------------------

export function searchTurnLazy(root: GameEngineState, opts: LazyOptions): LazySearchResult {
  const maxDepthTurns = opts.maxDepthTurns ?? 4;
  const maxNodes = opts.maxNodes ?? 500_000;

  // ONE shared TT across depths: shallow entries become ordering hints for
  // deeper depths (legacy parity). One shared node budget.
  const tt = new TurnTT();
  const nodeCount = { count: 0 };

  let completedDepth = 0;
  let attempted = 0;
  let budgetExhausted = false;
  let deadlineExceeded = false;
  const iterations: { depth: number; completed: boolean; value: number; mate: MateSide; nodes: number }[] = [];
  let lastCompleted: { value: number; mate: MateSide; witness: SearchAction[] } | null = null;
  let lastDiag: LazyDiagnostics | null = null;
  let lastRootActions: RootActionValue[] = [];

  const startDepth = opts.iterativeDeepening === false ? maxDepthTurns : 1;
  for (let d = startDepth; d <= maxDepthTurns; d++) {
    attempted = d;
    const ss: SearchState = {
      diag: freshDiag(),
      memo: new Map(),
      tt,
      path: new Set<string>(),
      nodeCount,
      maxPly: 0,
      options: { ...opts, maxNodes },
      rootActions: [],
    };
    const nodesBefore = nodeCount.count;
    const res = resolveTurn(root, d, NEG_INF, POS_INF, 0, ss, true);
    const nodesUsed = nodeCount.count - nodesBefore;
    lastDiag = ss.diag;
    iterations.push({ depth: d, completed: res.completed, value: res.value, mate: res.mate, nodes: nodesUsed });
    if (res.completed) {
      completedDepth = d;
      lastCompleted = { value: res.value, mate: res.mate, witness: res.witness };
      lastRootActions = ss.rootActions;
    } else {
      if (ss.diag.deadlineCutoffs > 0) deadlineExceeded = true;
      else budgetExhausted = true;
      break;
    }
  }

  return {
    value: lastCompleted ? lastCompleted.value : 0,
    mate: lastCompleted ? lastCompleted.mate : null,
    completedDepth,
    attemptedDepth: attempted,
    completed: completedDepth >= 1,
    budgetExhausted,
    deadlineExceeded,
    bestAction: lastCompleted && lastCompleted.witness.length > 0 ? lastCompleted.witness[0] : null,
    plan: lastCompleted ? lastCompleted.witness : [],
    catTurnPlan: lastCompleted ? catTurnPrefix(lastCompleted.witness) : [],
    rootActions: lastRootActions,
    diagnostics: lastDiag ?? freshDiag(),
    iterations,
  };
}