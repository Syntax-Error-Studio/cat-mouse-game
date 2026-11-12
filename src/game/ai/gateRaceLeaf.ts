/**
 * PPC-HV-6 — GATE RACE (关口竞速) trial leaf. INDEPENDENT, REVERTIBLE, NOT H1.
 *
 * ============================================================================
 * §3 EVALUATION DEFINITION (written down before the code, as the round demands)
 * ============================================================================
 *
 * QUESTION THE TERM ANSWERS
 *   "Before the mouse has the butter, does the cat have a legally reachable cell
 *   on the corridor the mouse will have to run back through, and can the cat get
 *   there in time?" H1 knows how close the cat is to the mouse and to the hole
 *   GATES; it knows nothing about the route between the butter and the hole.
 *
 * THREAT SET — derived only from the current public, legal board state
 *   carrying mouse : its own cell, single leg → hole. (No butter is chased: the
 *                    butter is already spent on the run home.)
 *   idle mouse     : the REAL `state.butterPositions` only. For each butter b,
 *                    the two-leg win route  mouse →(not carrying)→ b →(carrying)→ hole.
 *   NEVER a target: `pendingButterSpawns` / placement debt (unmaterialised random
 *                    butter is not a definite future target — §3.1), no future
 *                    human log, no prediction of the mouse's choice, no fixed
 *                    board coordinate. (4,8) exists only in this round's TESTS.
 *
 * CORRIDOR (per threat b) — the union of ALL shortest carrying routes, layered
 *   distB       = BFS from b on the evaluator's carrying graph.
 *   carryHoleMap= BFS from the hole set on the SAME graph (already built by H1).
 *   D           = carryHoleMap[b]  (b → nearest hole cell, carrying mode).
 *   L_j         = { g : distB[g] = j  ∧  distB[g] + carryHoleMap[g] = D },
 *                 j = 1 … D-1.
 *   L_j is every cell that SOME shortest b→hole route passes through at step j.
 *   Taking the whole layer (not one route) is what satisfies "不能把一条最短路线
 *   当成老鼠唯一会走的路线"; longer-than-shortest routes are deliberately
 *   omitted, and they only make the mouse slower, so the margins below are a
 *   LOWER bound on the cat's real interception value.
 *   j = 0 (the butter cell) and j = D (hole cells) can never be interception
 *   cells: `catCanEnter` forbids both, and they are absent from `catMap`.
 *
 * TURN-AWARE ARRIVAL (§3.3) — one shared atomic clock, NOT a Manhattan compare
 *   Turns alternate from `state.currentPlayer`; each turn contributes its own
 *   real budget and time is the sum of the preceding turn lengths plus the step
 *   index inside the turn that contains it. Conventions taken from the engine
 *   (verified in engine.ts):
 *     - the first turn of the acting side is PARTIAL (`mouseMovesLeft` /
 *       `catMovesLeft`), every later turn is full;
 *     - cat turns are always `catBaseMoves`;
 *     - a mouse turn is `mouseBaseMoves` while it starts the turn without butter
 *       and `mouseCarryingMoves` when it starts the turn carrying — and the
 *       pickup does NOT shrink the turn it happens in (engine.ts:714 only
 *       decrements), so the 4→3 switch lands on the first turn AFTER step P;
 *     - P = distB-independent approach distance `mouseMap[b]`, i.e. the tunnel
 *       aware non-carrying graph, and the return leg runs on the carrying graph.
 *   mouseAt[s]  = atomic time of mouse route-step s.
 *   catAt[k]    = atomic time of the cat's k-th step, k = `catMap[g]` (k ≥ 1; the
 *                 cell the cat already occupies can never be a layer cell, because
 *                 the evaluator's own mouse graph refuses to enter the cat's cell —
 *                 see §3.3 HELD GATE below).
 *   margin_j    = mouseAt[P + j] − min_{g∈L_j} catAt[catMap[g]]   (+ ⇒ cat first)
 *   Unmoded turn shorteners (teleport ends the turn, the mouse's own trap zeros
 *   its moves, cat stalls, box pushes) all move the mouse EARLIER or the cat
 *   LATER than this clock says, so they shrink the credit. See §3.2 EXACTNESS.
 *
 * HELD GATE (§3.3 "不得放弃猫已经控制住的关口") — measured, not assumed
 *   `mouseCanEnter` (evaluation.ts:83) already removes the CAT'S OWN CELL from the
 *   carrying graph, so a corridor cell the cat stands on disappears from `distB`
 *   and the priced route is rebuilt AROUND it. On the real Turn #4 board that
 *   lengthens the mouse's return leg from 8 to 9 carrying steps (probe, HV6-DB),
 *   and every width-1 chokepoint of that route, held, prices at the ceiling
 *   (aggregate 1.0). So holding a gate is credited by the graph itself, and no
 *   plan that gives it up can out-score it. Known corner: if a held cell were a
 *   true cut vertex, the threat would lose its route and drop out of the min; with
 *   only that one threat priced, the term goes NEUTRAL rather than claiming a
 *   block. That case was searched for on the real board and does not occur (0 of
 *   7 corridor cells), and the term's one-sided clamp means the cost of the corner
 *   is a lost credit, never an invented danger.
 *
 * SCORING (§3.3 direction, §4 bounded form)
 *   value_j   = clamp(margin_j / boardSize, −1, +1) / |L_j|
 *               (the 1/|L_j| term is the "multiple mouse routes bypass this cell"
 *               discount: standing on one cell of a wide layer blocks one route,
 *               not the corridor)
 *   threat_b  = max_j value_j            (the cat's best interception layer)
 *   aggregate = min over the IMMINENT threats of threat_b, where imminent is the
 *               set of butters whose complete two-leg route length
 *               (approach + return) equals the shortest one.
 *
 *   WHY THAT AGGREGATION AND NOT A PLAIN min OVER ALL BUTTERS: a far butter with a
 *   long return leg is not an alternative the cat has to be ready for, and taking
 *   the min over every butter let that dead corridor decide the score — measured
 *   at Turn #4, it rewarded positions that covered the WRONG corridor and left the
 *   chosen action unchanged. Imminence is the rule evaluation.ts ALREADY uses for
 *   the mouse's win route (`mouseWinRouteDistance` = min over butters of
 *   approach + return), so this term reads the same threat the rest of the
 *   evaluator reads instead of inventing a second, inconsistent one.
 *   Within the imminent set the aggregation is still a MIN, not a MAX: if the
 *   mouse has two equally fast options the cat is only credited for covering both
 *   (that is the "不能只选择对猫有利的一条路线" requirement, kept exactly). And the
 *   threat that is priced is the mouse's BEST plan, never a cat-favourable one.
 *   GateRaceContribution = clamp(aggregate, 0, +1) * GATE_RACE_WEIGHT
 *
 *   ONE-SIDED ON PURPOSE: aggregate ≤ 0 (mouse passes first everywhere) and any
 *   state without a complete, legal, modelled route both collapse to 0 — a
 *   NEUTRAL contribution, never a fabricated danger penalty. So the term can only
 *   add interception credit; it can never invent a threat that is not on the
 *   board, and it can never outscore a real terminal/mate score (those are not
 *   produced here at all; the search owns them).
 *
 *   H1_GATE_RACE = H1_EVALUATION + GateRaceContribution, with H1 itself
 *   untouched: the corrected-hole math is called through
 *   `correctedHoleEvalTotal(evaluateForCatDetailed(state, DEFAULT, ctx))`, so
 *   `evaluateCorrectedHoleForCat` gains no new weight (§5).
 *
 * §3.2 EXACTNESS CLAIM — stated plainly, because it is a limited one
 *   Every distance here is a STATIC single-agent BFS on the current board:
 *   exact legal STEP COUNTS for one mover on today's obstacles, NOT exact legal
 *   outcomes of the two-player game.
 *   Cat arrival uses `buildCatPushDistanceMap`, which applies the engine's own
 *   push legality (§4.2) and charges one step per push, so it can price a cell the
 *   walk-only `ctx.catMap` reports as 20 steps away as the 4 real steps it is. Its
 *   error is the SEQUENCE (the box layout is treated as static), so it is a LOWER
 *   bound on the cat's legal steps and can only over-credit the cat; every layer
 *   records `pushRequired` so the over-credited part is visible, and §7 control E
 *   checks the credited cell is a cell the cat may actually stand on.
 *   Mouse arrival uses the carrying graph already used by Baseline's hole map,
 *   which in a non-carrying state lets a route pass through tunnel corner cells a
 *   carrying mouse may not legally enter ⇒ the mouse's corridor is
 *   over-approximated ⇒ the cat is under-credited there.
 *   Box moves, the mouse's skill (+3 steps on the turn it spends butter) and trap
 *   /teleport turn-endings are not modelled; all three move the mouse earlier or
 *   the cat later than this clock says, i.e. they shrink the credit. None of them
 *   is used to claim the cat is safe, and the term never equates blocking one
 *   route with winning.
 *
 * §4 COST
 *   Reuses H1's own context (3 BFS + 1 Voronoi scan) through the exported
 *   `createEvaluationContext` + the optional `prebuiltCtx` parameter, so the
 *   trial leaf's shared cost equals H1's. The extra work is ONE push-aware cat
 *   arrival map, plus ONE bounded carrying BFS per threat butter (≤
 *   GATE_RACE_MAX_THREAT_TARGETS, and 0 for a carrying mouse, whose map is already
 *   `ctx.mouseMap`), one ≤ 40-turn clock, and one board scan. No path enumeration,
 *   no global cache, no log reads, no RNG, no repeated per-leaf tactical search.
 *   Measured once at the real GAME4 Turn #4 root under the frozen 100ms/150ms
 *   budgets (HV6-E3): 409 leaves cost 408 cat-push BFSs + 343 carrying BFSs. One
 *   measurement per arm, so the wall-clock columns carry no timing authority.
 *
 * WEIGHT — chosen ONCE, a priori, not tuned
 *   GATE_RACE_WEIGHT = 500 = `DEFAULT_EVALUATION_WEIGHTS.holeControl`. The term
 *   is the same shape as holeControl (a normalized race margin clamped to ±1
 *   times one weight) one stage EARLIER in the mouse's plan, so it inherits that
 *   scale: large enough to separate plans inside one heuristic band, small enough
 *   to never outvote capturePressure/mouseGoalThreat/confinement, and far too
 *   small to touch terminal scores. Per §4 this round does NOT search weights; if
 *   acceptance fails, the round reports failure.
 */
import type { GameEngineState } from '../engine';
import { PieceType } from '../types';
import {
  DEFAULT_EVALUATION_WEIGHTS,
  buildCarryingDistanceMap,
  buildCatPushDistanceMap,
  createEvaluationContext,
  evaluateForCatDetailed,
  evaluationCellKey,
  type EvaluationContext,
} from './evaluation';
import { correctedHoleEvalTotal } from './correctedHoleLeaf';

/** See the header: scale analogue of `holeControl`, fixed before any measurement. */
export const GATE_RACE_WEIGHT = 500;
/** Cost cap on threat BFSs per leaf. Exceeding it is fail-closed NEUTRAL, never a truncation that could over-credit. */
export const GATE_RACE_MAX_THREAT_TARGETS = 4;
/** Hard bound on the alternating clock; keeps the turn model finite on any route length. */
const MAX_CLOCK_TURNS = 40;

export interface GateRaceLayer {
  /** Carrying steps from the threat target into the return leg. */
  step: number;
  /** Cells on SOME shortest return route at this step. */
  width: number;
  /** Earliest atomic time the cat can legally occupy any cell of the layer. */
  catArrival: number | null;
  /** The cat's push-aware step count to that cell (lower bound, see header). */
  catSteps: number | null;
  /** TRUE when the walk-only graph cannot reach the cell at all, i.e. the priced
   *  arrival depends on at least one push and is therefore the approximate part. */
  pushRequired: boolean;
  /** Atomic time the mouse crosses this layer on the route. */
  mouseArrival: number | null;
  /** mouseArrival − catArrival; > 0 ⇒ the cat gets there first. */
  interceptionMargin: number | null;
  /** clamp(margin / boardSize, −1, 1) / width. */
  value: number;
  /** One representative layer cell the cat can reach first (diagnostic only). */
  bestCell: string | null;
}

export interface GateRaceThreat {
  /** Origin of the return leg: the butter cell, or the mouse's own cell. */
  origin: string;
  /** Mouse steps to reach `origin` (0 when it starts there). */
  approachSteps: number;
  /** Carrying steps from `origin` to the nearest hole cell. */
  returnSteps: number;
  /** `approachSteps + returnSteps` — the mouse's full two-leg win route through this target. */
  routeLength: number;
  /** TRUE when `routeLength` equals `GateRaceResult.fastestRoute`, i.e. this threat is one the cat must answer. */
  imminent: boolean;
  layers: GateRaceLayer[];
  /** max over layers, i.e. the best interception chance on this threat. */
  bestValue: number;
}

export interface GateRaceResult {
  contribution: number;
  aggregate: number | null;
  threats: GateRaceThreat[];
  /** Shortest complete route length among the priced threats. */
  fastestRoute: number | null;
  /** The origins that sit on `fastestRoute` — the threats the aggregation is a MIN over. */
  imminentOrigins: string[];
  /** Why the term stayed neutral (auditable; never changes the number). */
  reason:
    | 'ok'
    | 'not_playing'
    | 'no_threat_target'
    | 'threat_set_exceeds_cap'
    | 'no_complete_return_route'
    | 'no_interception_layer';
  /** Extra carrying BFSs performed by this call (Baseline/H1 perform 0). */
  extraCarryBfs: number;
  /** Extra cat-arrival BFSs performed by this call (1, push-aware; H1 uses its own walk-only map). */
  extraCatPushBfs: number;
}

const rc = (p: { r: number; c: number }) => `${p.r},${p.c}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The alternating-turn clock (see §3.3 in the header). `pickupStep` is the mouse
 * route step at which butter is picked up; a mouse turn only switches to the
 * carrying budget when it STARTS at or after that step.
 */
export function buildRouteClock(
  state: GameEngineState,
  pickupStep: number,
  mouseRouteSteps: number,
): { mouseAt: Map<number, number>; catAt: Map<number, number> } {
  const cfg = state.config;
  const mouseMovesFirst = state.currentPlayer === PieceType.Mouse;
  const mouseAt = new Map<number, number>();
  const catAt = new Map<number, number>();
  let t = 0;
  let consumed = 0;
  let catStepsDone = 0;
  for (let turn = 0; turn < MAX_CLOCK_TURNS; turn++) {
    const catTurn = mouseMovesFirst ? turn % 2 === 1 : turn % 2 === 0;
    if (catTurn) {
      const allowance = turn === 0 && !mouseMovesFirst
        ? Math.max(0, state.catMovesLeft)
        : cfg.catBaseMoves;
      for (let i = 1; i <= allowance; i++) catAt.set(++catStepsDone, t + i);
      t += allowance;
    } else {
      // A turn that STARTS without butter keeps the full budget even if the
      // pickup happens inside it (engine.ts:714 only decrements the remainder).
      const carrying = consumed >= pickupStep;
      const allowance = turn === 0 && mouseMovesFirst
        ? Math.max(0, state.mouseMovesLeft)
        : carrying ? cfg.mouseCarryingMoves : cfg.mouseBaseMoves;
      const recorded = Math.min(allowance, mouseRouteSteps - consumed);
      for (let i = 1; i <= recorded; i++) mouseAt.set(consumed + i, t + i);
      consumed += allowance;
      t += allowance;
    }
    if (mouseAt.has(mouseRouteSteps) && catStepsDone >= cfg.boardSize * 4) break;
  }
  return { mouseAt, catAt };
}

function layersFor(
  state: GameEngineState,
  ctx: EvaluationContext,
  catPush: Map<string, number>,
  distB: Map<string, number>,
  returnSteps: number,
  clock: { mouseAt: Map<number, number>; catAt: Map<number, number> },
  approachSteps: number,
): GateRaceLayer[] {
  const boardSize = state.config.boardSize;
  const buckets = new Map<number, { r: number; c: number }[]>();
  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c < boardSize; c++) {
      const k = evaluationCellKey({ r, c });
      const db = distB.get(k);
      if (db === undefined || db < 1 || db >= returnSteps) continue;
      const toHole = ctx.carryHoleMap.get(k);
      if (toHole === undefined || db + toHole !== returnSteps) continue;
      const list = buckets.get(db) ?? [];
      list.push({ r, c });
      buckets.set(db, list);
    }
  }
  const out: GateRaceLayer[] = [];
  for (const [step, cells] of buckets) {
    let catArrival: number | null = null;
    let catSteps: number | null = null;
    let bestCell: string | null = null;
    let pushRequired = false;
    for (const g of cells) {
      const k = evaluationCellKey(g);
      const walk = ctx.catMap.get(k);
      const pushable = catPush.get(k);
      if (walk === undefined && pushable === undefined) continue; // not standable at all
      const steps = Math.min(walk ?? Infinity, pushable ?? Infinity);
      const at = clock.catAt.get(steps);
      if (at === undefined) continue;
      if (catArrival === null || at < catArrival) {
        catArrival = at;
        catSteps = steps;
        bestCell = rc(g);
        pushRequired = walk === undefined;
      }
    }
    const mouseArrival = clock.mouseAt.get(approachSteps + step) ?? null;
    if (catArrival === null || mouseArrival === null) continue;
    const margin = mouseArrival - catArrival;
    out.push({
      step,
      width: cells.length,
      catArrival,
      catSteps,
      pushRequired,
      mouseArrival,
      interceptionMargin: margin,
      value: (clamp(margin / boardSize, -1, 1) / cells.length),
      bestCell,
    });
  }
  return out.sort((a, b) => a.step - b.step);
}

/** The Gate Race term alone, with the per-layer table the round asks to inspect. */
export function computeGateRace(
  state: GameEngineState,
  ctx: EvaluationContext = createEvaluationContext(state),
): GateRaceResult {
  const neutral = (reason: GateRaceResult['reason'], pushBfs = 0): GateRaceResult => ({
    contribution: 0, aggregate: null, threats: [], fastestRoute: null, imminentOrigins: [],
    reason, extraCarryBfs: 0, extraCatPushBfs: pushBfs,
  });
  if (state.phase !== 'playing') return neutral('not_playing');

  // Threat origins are PUBLIC legal facts of this state, nothing else.
  const carrying = state.mouseHasButter;
  const targets = carrying
    ? [state.mousePosition]
    : [...state.butterPositions].sort(
        (a, b) =>
          (ctx.mouseMap.get(evaluationCellKey(a)) ?? Number.POSITIVE_INFINITY) -
          (ctx.mouseMap.get(evaluationCellKey(b)) ?? Number.POSITIVE_INFINITY),
      );
  if (targets.length === 0) return neutral('no_threat_target');
  // Fail-closed: a threat set we cannot price completely is NOT truncated to the
  // cat's advantage — the mouse chooses the butter, so a partial min could lie.
  if (targets.length > GATE_RACE_MAX_THREAT_TARGETS) return neutral('threat_set_exceeds_cap');

  const threats: GateRaceThreat[] = [];
  let extraCarryBfs = 0;
  // ONE extra BFS for the whole call: the cat's push-aware arrival map. It is the
  // same 100-cell BFS shape as the three H1 already builds.
  const catPush = buildCatPushDistanceMap(state);
  for (const t of targets) {
    const approach = carrying ? 0 : ctx.mouseMap.get(evaluationCellKey(t)) ?? null;
    if (approach === null) continue; // mouse cannot legally reach this butter
    // When the mouse already carries, ctx.mouseMap IS the carrying map from its
    // own cell (tunnel entry is forbidden while carrying), so the route layers
    // cost no extra BFS at all.
    let distB: Map<string, number>;
    if (carrying) {
      distB = ctx.mouseMap;
    } else {
      distB = buildCarryingDistanceMap(state, t);
      extraCarryBfs++;
    }
    const returnSteps = ctx.carryHoleMap.get(evaluationCellKey(t));
    if (returnSteps === undefined || returnSteps < 2) continue; // no usable corridor
    const clock = buildRouteClock(state, approach, approach + returnSteps - 1);
    const layers = layersFor(state, ctx, catPush, distB, returnSteps, clock, approach);
    threats.push({
      origin: rc(t),
      approachSteps: approach,
      returnSteps,
      routeLength: approach + returnSteps,
      imminent: false,
      layers,
      // A route with no priced layer keeps its row in the min with the value
      // floor: dropping it would quietly remove the mouse's fastest plan from
      // the aggregate, which is exactly the cat-favourable cherry-pick §3.1
      // forbids. (value_j ∈ [−1, 1], so −1 is the worst a layer can report.)
      bestValue: layers.length > 0 ? Math.max(...layers.map((l) => l.value)) : -1,
    });
  }

  if (threats.length === 0) {
    return { ...neutral('no_complete_return_route', 1), extraCarryBfs };
  }
  // Imminence is the SAME rule evaluation.ts already uses for the mouse's win
  // route (`mouseWinRouteDistance` = min over butters of approach + return): the
  // threats the cat must answer are those whose complete route is as fast as the
  // fastest one. A slower butter is not an alternative the mouse would choose.
  const fastestRoute = Math.min(...threats.map((th) => th.routeLength));
  for (const th of threats) th.imminent = th.routeLength === fastestRoute;
  const imminent = threats.filter((th) => th.imminent);
  // Inside the imminent set the aggregation stays a MIN: if the mouse has two
  // equally fast options the cat is only credited when it covers BOTH, so the
  // term never selects the corridor that happens to favour the cat.
  const aggregate = Math.min(...imminent.map((th) => th.bestValue));
  const credit = clamp(aggregate, 0, 1);
  return {
    contribution: credit * GATE_RACE_WEIGHT,
    aggregate,
    threats,
    fastestRoute,
    imminentOrigins: imminent.map((th) => th.origin),
    reason: credit > 0 ? 'ok' : 'no_interception_layer',
    extraCarryBfs,
    extraCatPushBfs: 1,
  };
}

/** Diagnostic view: the term plus the full per-layer race table (§5 inspectability). */
export function gateRaceBreakdown(
  state: GameEngineState,
  ctx?: EvaluationContext,
): GateRaceResult {
  return computeGateRace(state, ctx);
}

/**
 * H1 + Gate Race trial leaf. H1's own number is produced by the SAME corrected-hole
 * math through the SAME context, so this leaf is H1 plus exactly one bounded,
 * explainable, non-negative term.
 */
export function evaluateH1GateRaceForCat(state: GameEngineState): number {
  const ctx = createEvaluationContext(state);
  const breakdown = evaluateForCatDetailed(state, DEFAULT_EVALUATION_WEIGHTS, ctx);
  const h1 = correctedHoleEvalTotal(breakdown, state.config.boardSize);
  return h1 + computeGateRace(state, ctx).contribution;
}
