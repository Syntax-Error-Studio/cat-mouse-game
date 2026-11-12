/**
 * PPC-HV-10 P1 — root-level tactical scouting (forensic prototype, NOT production).
 *
 * THE SHAPE. HV-9 proved two things: the cat can walk a THREE-consecutive-push line
 * into a defensive cell a four-step turn allows ((5,5)→(4,8) in `RRRU`), and a
 * per-leaf tactical probe cannot pay for it (≈118 µs/leaf cheap, ≈1056 µs/leaf with
 * the local tree, against a 244 µs/leaf allowance). This module moves the computation
 * to the only place where the count is small: ONE tactical scan per candidate
 * COMPLETE CAT TURN, evaluated at the root, over the engine-enumerated turn plans.
 *
 * WHAT IS REUSED, VERBATIM — NOTHING REINVENTED.
 *  - legal turn plans         → HV-5 `enumerateCatTurnExact` (real `catMove` /
 *                               `catPlaceTrap`, production `stateKey` dedup, capture
 *                               plans separated, node cap reported as truncation).
 *  - interception cells       → HV-9 `deriveInterceptionTargets` (Gate Race layer,
 *                               butter on the board, hole-feed cells, the mouse's own
 *                               shortest return route) plus the corridor cells of the
 *                               threats production Gate Race itself calls imminent.
 *  - ≤4-step arrival + witness → HV-9 `boundedTacticalReach` in cheap mode
 *                               (Manhattan-shortest permutations only, no sweep).
 *  - arrival TIMING          → production `computeGateRace` / `buildRouteClock` on the
 *                               hand-off leaf. No new tempo rule is invented:
 *                               `mouseAtomic` and `catAt` are the numbers the Gate
 *                               Race term is already built from.
 *  - "does it matter?"       → production Gate Race `aggregate`, read never written.
 *
 * CLAIM GRAMMAR (§3.4 — the point of the round).
 *  - `CAT_CAN_ARRIVE_BEFORE_MOUSE` needs all three: a complete legal witness the engine
 *    accepted, membership of an IMMINENT mouse return corridor, and a stated atomic
 *    margin (`catAt(steps) < mouseAt(routeStep)`) from the production clock.
 *  - Everything else is `POTENTIAL_INTERCEPTION`: the cat can stand there, which does
 *    NOT mean the mouse will pass, nor that the cat beats it to the cell.
 *  - No verdict here is ever a win claim. One corridor of one route is one corridor:
 *    `uncoveredThreatRoutes` stays listed next to every covered origin, and a layer of
 *    width > 1 is recorded as bypassable rather than blocked.
 *  - Absence of a witness is `UNKNOWN`, never `NO`. This module does not run the
 *    exhaustive sweep at all (§3.3: only when explicitly asked to prove coverage).
 *
 * COST DISCIPLINE (§5). The caps are inputs, not suggestions: max distinct end states,
 * max targets per end state, max `catMove` calls for the whole scan. A state the caps
 * refused to scan is `NOT_SCANNED` (unknown), and the loop is structured so a caller
 * could stop it between end states. Nothing here touches a deadline, H1, the TT,
 * Alpha-Beta, bound certification or PlanQuality; the only decision-shaped output is
 * `TACTICAL_PREFERENCE`.
 */
import type { GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../types';
import {
  buildCarryingDistanceMap,
  createEvaluationContext,
  evaluationCellKey,
  type EvaluationContext,
} from '../evaluation';
import { buildRouteClock, computeGateRace, type GateRaceResult } from '../gateRaceLeaf';
import { stateKey } from '../transposition';
import { getTunnelCorners, hasButterAt, isFixedObstacle, isMouseHoleCell, isTunnelCornerCell } from '../../rules/tunnelRules';
import { enumerateCatTurnExact, handOffToMouse, rc, replayCatPlan, walkMouseSegment } from './hv5ForcedLineAuditor';
import { bankTurn } from './hv8WitnessPush';
import {
  boundedTacticalReach,
  deriveInterceptionTargets,
  playLine,
  type TargetKind,
  type TacticalClaim,
} from './hv9BoundedTactical';

const parseCell = (key: string): { r: number; c: number } => {
  const [r, c] = key.split(',').map(Number);
  return { r, c };
};

/**
 * HV-11 §5 P2 — what the RULES of this state say about the cat standing on a cell.
 *
 * The old `standable` judged the cell TYPE alone and was wrong in both directions:
 *  - `CellType.Tunnel` was refused as a type, but `engine.catMove` refuses only tunnel
 *    CORNERS (`isTunnelCorner`), so a painted tunnel corridor is walkable; and a corner
 *    can be painted on an ordinary cell, so the type check missed the real obstacle.
 *  - a butter ENTITY was never checked at all, yet every butter position is a derived
 *    target and the cat may never step onto one.
 * Boxes are never excluded: the cat enters a box cell by pushing the box, and whether
 * THIS push is legal is a `catMove` fact, not a table fact. `PUSH_REQUIRED_POTENTIAL`
 * and `UNPROVEN` both stay in the proposal set precisely so the engine can decide.
 */
export type TargetLegality = 'NEVER_ENTERABLE' | 'PUSH_REQUIRED_POTENTIAL' | 'CURRENTLY_ENTERABLE' | 'UNPROVEN';

export interface TargetLegalityVerdict {
  legality: TargetLegality;
  note: string;
}

export function classifyCatTarget(s: GameEngineState, r: number, c: number): TargetLegalityVerdict {
  const { config, board } = s;
  if (r < 0 || c < 0 || r >= config.boardSize || c >= config.boardSize) {
    return { legality: 'NEVER_ENTERABLE', note: 'outside the board' };
  }
  if (isMouseHoleCell(r, c, config.mouseHole)) return { legality: 'NEVER_ENTERABLE', note: 'mouse-hole cell' };
  if (isTunnelCornerCell(r, c, getTunnelCorners(config))) {
    return { legality: 'NEVER_ENTERABLE', note: 'tunnel corner: the cat may never enter a tunnel' };
  }
  const t = board[r][c].type;
  if (isFixedObstacle(t)) return { legality: 'NEVER_ENTERABLE', note: `fixed obstacle (${t})` };
  if (t === CellType.Void) return { legality: 'NEVER_ENTERABLE', note: 'void: not part of the walkable map' };
  if (hasButterAt(r, c, s.butterPositions)) {
    return { legality: 'NEVER_ENTERABLE', note: 'a butter entity stands here; engine.catMove refuses the step' };
  }
  if (t === CellType.Box) {
    // Destination conditions of engine.catMove's push branch, checked for every approach.
    const pushable = ORTHO.some(([dr, dc]) => {
      const destR = r + dr;
      const destC = c + dc;
      if (destR < 0 || destC < 0 || destR >= config.boardSize || destC >= config.boardSize) return false;
      if (isMouseHoleCell(destR, destC, config.mouseHole)) return false;
      if (s.mousePosition.r === destR && s.mousePosition.c === destC) return false;
      if (board[destR][destC].type === CellType.Box) return false;
      if (isFixedObstacle(board[destR][destC].type)) return false;
      if (board[destR][destC].type === CellType.Void) return false;
      if (hasButterAt(destR, destC, s.butterPositions)) return false;
      if (s.trapPosition?.r === destR && s.trapPosition?.c === destC) return false;
      return true;
    });
    return pushable
      ? { legality: 'PUSH_REQUIRED_POTENTIAL', note: 'box cell: only an engine-accepted push can put the cat here' }
      : {
          legality: 'UNPROVEN',
          note: 'box cell with no currently legal push destination; a later push in the same turn could still free one, so only catMove can decide',
        };
  }
  return { legality: 'CURRENTLY_ENTERABLE', note: `free step (${t})` };
}

const boxCells = (s: GameEngineState): string[] => {
  const out: string[] = [];
  for (let r = 0; r < s.config.boardSize; r++) {
    for (let c = 0; c < s.config.boardSize; c++) if (s.board[r][c].type === CellType.Box) out.push(`${r},${c}`);
  }
  return out;
};

const TOKEN_TO_DIR: Record<string, Direction> = { U: DIRECTIONS[0], D: DIRECTIONS[1], L: DIRECTIONS[2], R: DIRECTIONS[3] };

// ---------------------------------------------------------------------------
// caps (§5: explicit maximum task load + truncation semantics)
// ---------------------------------------------------------------------------

export interface ScoutCaps {
  /** Enumeration node cap handed to HV-5 `enumerateCatTurnExact`. */
  nodeCap: number;
  /** At most this many DISTINCT end states are scanned in one root scan. */
  maxEndStates: number;
  /** At most this many interception cells are probed per end state. */
  maxTargetsPerEnd: number;
  /** Whole-scan `catMove` budget; the scan stops mid-flight once it is spent. */
  maxCatMoveCalls: number;
  /** At most this many HELD-CHOKE counterfactuals per root scan (HV-11 §4). */
  maxHoldProofs: number;
}

export const DEFAULT_CAPS: ScoutCaps = {
  nodeCap: 20_000,
  maxEndStates: 24,
  maxTargetsPerEnd: 6,
  maxCatMoveCalls: 3_000,
  maxHoldProofs: 3,
};

/** How many legal alternative endings one hold proof may price (a hard cap). */
const HOLD_CONTRAST_CAP = 4;

// ---------------------------------------------------------------------------
// the mouse's imminent return corridors, from production Gate Race geometry
// ---------------------------------------------------------------------------

export interface CorridorLayer {
  /** Carrying step from the threat origin (1..returnSteps-1). */
  step: number;
  /** Cells sharing this step. width 1 is a single-cell chokepoint. */
  width: number;
  cells: string[];
  /** The mouse's atomic crossing time of this layer on this route. */
  mouseAtomic: number | null;
}

export interface ImminentRoute {
  /** Butter cell — or the mouse's own cell when it carries — that the leg starts from. */
  origin: string;
  approachSteps: number;
  returnSteps: number;
  routeLength: number;
  fastest: boolean;
  /** The production clock these timings come from, cat side included. */
  catAt: Map<number, number>;
  layers: CorridorLayer[];
}

/**
 * Corridor cells of every threat production Gate Race prices as imminent, rebuilt with
 * the SAME two maps the term uses (`buildCarryingDistanceMap` from the origin and
 * `ctx.carryHoleMap`) and the SAME layer rule as `layersFor` — `distB + carryHole ===
 * returnSteps` — so this table cannot disagree with a term that already exists.
 * The mouse's BFS refuses to enter the cat's cell (evaluation.ts:83), so a cell the cat
 * stands on is already out of these layers; that is the holding mechanism, not a
 * zero-step arrival.
 */
export function imminentRoutes(leaf: GameEngineState, ctx: EvaluationContext, gr: GateRaceResult): ImminentRoute[] {
  const carrying = leaf.mouseHasButter;
  const size = leaf.config.boardSize;
  const out: ImminentRoute[] = [];
  for (const th of gr.threats) {
    if (!th.imminent) continue;
    const distB = carrying ? ctx.mouseMap : buildCarryingDistanceMap(leaf, parseCell(th.origin));
    const buckets = new Map<number, string[]>();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const k = evaluationCellKey({ r, c });
        const db = distB.get(k);
        if (db === undefined || db < 1 || db >= th.returnSteps) continue;
        const toHole = ctx.carryHoleMap.get(k);
        if (toHole === undefined || db + toHole !== th.returnSteps) continue;
        const list = buckets.get(db) ?? [];
        list.push(`${r},${c}`);
        buckets.set(db, list);
      }
    }
    // The clock production builds for this threat: on the hand-off leaf the mouse is
    // first, so the cat's NEXT turn is turn 1 and its steps land after the mouse's
    // whole upcoming turn — which is exactly the turn order §3.4 demands.
    const clock = buildRouteClock(leaf, th.approachSteps, th.routeLength - 1);
    const layers: CorridorLayer[] = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([step, cells]) => ({
        step,
        width: cells.length,
        cells: cells.sort(),
        mouseAtomic: clock.mouseAt.get(th.approachSteps + step) ?? null,
      }));
    out.push({
      origin: th.origin,
      approachSteps: th.approachSteps,
      returnSteps: th.returnSteps,
      routeLength: th.routeLength,
      fastest: th.routeLength === gr.fastestRoute,
      catAt: clock.catAt,
      layers,
    });
  }
  return out;
}

interface CellOnRoute {
  route: ImminentRoute;
  layer: CorridorLayer;
}

const indexRoutes = (routes: ImminentRoute[]): Map<string, CellOnRoute[]> => {
  const idx = new Map<string, CellOnRoute[]>();
  for (const route of routes) {
    for (const layer of route.layers) {
      for (const cell of layer.cells) {
        const list = idx.get(cell) ?? [];
        list.push({ route, layer });
        idx.set(cell, list);
      }
    }
  }
  return idx;
};

// ---------------------------------------------------------------------------
// target set per end state
// ---------------------------------------------------------------------------

export type ScoutKind = TargetKind | 'route' | 'choke';

export interface ScoutTarget {
  cell: string;
  kinds: ScoutKind[];
  /** Manhattan distance from the cat's END position — a walk-only lower bound. */
  manhattanFromCat: number;
  mouseDist: number | null;
  holeDist: number | null;
  /** Corridors of imminent threats that pass through this cell. */
  routes: { origin: string; step: number; width: number; mouseAtomic: number | null }[];
  /** HV-11 §5: what this state's rules allow, and whether a push is needed. */
  legality: TargetLegality;
  legalityNote: string;
  rank: number;
}

export interface RankedTargets {
  /** Every proposed cell the rules allow the cat to reach — at least potentially. */
  targets: ScoutTarget[];
  /** Cells the derivation proposed that the cat can NEVER enter, with the rule that says so. */
  rejectedNever: { cell: string; kinds: ScoutKind[]; note: string }[];
  /** The derivation's own internal cap, and whether it bound on this state. */
  deriveCap: number;
  deriveCapHit: boolean;
}

/** The derivation proposes at most this many cells; measured, never silently applied. */
const DERIVE_TARGET_CAP = 32;

/**
 * HV-9's four state-derived layers, then the corridor cells of the imminent routes,
 * then a deterministic rank. `(4,8)` and `(6,8)` are not here: nothing in this file
 * names a cell — every entry is a property of the position it was derived from.
 *
 * HV-11 §5: legality is CLASSIFIED, never used as a blunt filter. A cell the cat can
 * never enter leaves the proposal set and is reported; a box cell stays in it because
 * only the engine can price the push. Legality is not an ordering key — re-ranking on
 * it would be exactly the forbidden "reorder until the expected root wins".
 */
export function rankScoutTargets(
  view: GameEngineState,
  ctx: EvaluationContext,
  routes: ImminentRoute[],
): RankedTargets {
  const routeIdx = indexRoutes(routes);
  const kinds = new Map<string, Set<ScoutKind>>();
  const add = (cell: string, kind: ScoutKind): void => {
    const s = kinds.get(cell) ?? new Set<ScoutKind>();
    s.add(kind);
    kinds.set(cell, s);
  };
  // Ask for one more than the cap so a bound cap announces itself instead of hiding.
  const derived = deriveInterceptionTargets(view, ctx, { maxManhattan: view.config.catBaseMoves, maxTargets: DERIVE_TARGET_CAP + 1 });
  const deriveCapHit = derived.length > DERIVE_TARGET_CAP;
  for (const t of deriveCapHit ? derived.slice(0, DERIVE_TARGET_CAP) : derived) {
    for (const k of t.kinds) add(t.cell, k);
  }
  for (const route of routes) {
    for (const layer of route.layers) {
      for (const cell of layer.cells) add(cell, layer.width === 1 ? 'choke' : 'route');
    }
  }
  const cat = rc(view.catPosition);
  const out: ScoutTarget[] = [];
  const rejectedNever: RankedTargets['rejectedNever'] = [];
  for (const [cell, list] of kinds) {
    if (cell === cat) continue; // the cat already stands there: holding is scored, not probed
    const p = parseCell(cell);
    const verdict = classifyCatTarget(view, p.r, p.c);
    if (verdict.legality === 'NEVER_ENTERABLE') {
      // Reported, not silently dropped: every proposal lost here is a cell a planner could
      // otherwise have been asked to reach.
      rejectedNever.push({ cell, kinds: [...list].sort(), note: verdict.note });
      continue;
    }
    const man = Math.abs(p.r - view.catPosition.r) + Math.abs(p.c - view.catPosition.c);
    if (man > view.config.catBaseMoves) continue; // past the turn's own reach — this model cannot witness it
    const on = routeIdx.get(cell) ?? [];
    let rank = 0;
    if (list.has('choke')) rank += 16;
    if (list.has('route')) rank += 8;
    if (list.has('gate')) rank += 4;
    if (list.has('hole-feed')) rank += 2;
    if (list.has('butter')) rank += 1;
    out.push({
      cell,
      kinds: [...list].sort(),
      manhattanFromCat: man,
      mouseDist: ctx.mouseMap.get(cell) ?? null,
      holeDist: ctx.carryHoleMap.get(cell) ?? null,
      routes: on.map((o) => ({ origin: o.route.origin, step: o.layer.step, width: o.layer.width, mouseAtomic: o.layer.mouseAtomic })),
      legality: verdict.legality,
      legalityNote: verdict.note,
      rank,
    });
  }
  const targets = out.sort((a, b) => b.rank - a.rank || a.manhattanFromCat - b.manhattanFromCat || a.cell.localeCompare(b.cell));
  rejectedNever.sort((a, b) => a.cell.localeCompare(b.cell));
  return { targets, rejectedNever, deriveCap: DERIVE_TARGET_CAP, deriveCapHit };
}

// ---------------------------------------------------------------------------
// one end state scanned
// ---------------------------------------------------------------------------

export type ArrivalVerdict = 'CAT_CAN_ARRIVE_BEFORE_MOUSE' | 'POTENTIAL_INTERCEPTION';

export interface TimelyRow {
  cell: string;
  /** Cat actions needed from the START of the next cat turn (witness length). */
  steps: number;
  pushes: number;
  witness: string;
  verdict: ArrivalVerdict;
  /** The corridor this cell sits on, when it sits on one at all. */
  routeOrigin: string | null;
  routeStep: number | null;
  layerWidth: number | null;
  catAtomic: number | null;
  mouseAtomic: number | null;
  /** catAtomic − mouseAtomic; negative ⇒ the cat gets there first. */
  margin: number | null;
  /** Why the claim stops at POTENTIAL — no corridor, no clock entry, or too late. */
  note: string;
  endsInCapture: boolean;
}

export interface EndRow {
  endPosition: string;
  /** Production TT key of the hand-off leaf — the cache key of this scan row. */
  endStateKey: string;
  scanned: boolean;
  /** Set when the caps stopped the scan before this state was reached. */
  notScannedReason: string | null;
  gateRaceAggregate: number | null;
  gateRaceContribution: number;
  gateRaceReason: GateRaceResult['reason'];
  imminentOrigins: string[];
  targetCount: number;
  targetsDroppedByCap: number;
  /** HV-11 §5: the per-state target cap bound — this row is INCOMPLETE, never a global NO. */
  targetCapReached: boolean;
  /** The cells the target cap refused to probe. They are UNSCANNED = UNKNOWN. */
  droppedTargetCells: string[];
  /** The derivation's own cap bound before the ranking saw every proposal. */
  deriveCapHit: boolean;
  /** Cells the derivation proposed that this state's rules forbid outright, with the rule. */
  rejectedNever: { cell: string; kinds: ScoutKind[]; note: string }[];
  /** How the proposals that were actually probed classify under the rules. */
  targetLegalityCounts: Record<TargetLegality, number>;
  reachableTargets: string[];
  verifiedWitnesses: number;
  timely: TimelyRow[];
  threatRoutesCovered: string[];
  uncoveredThreatRoutes: string[];
  unknownCount: number;
  /** Cells the cheap permutation mode could not witness — UNKNOWN, never NO. */
  unknownTargets: string[];
  /** The cat's own end cell when it occupies a gate/corridor cell right now. */
  heldKeyCell: { cell: string; kinds: ScoutKind[] } | null;
  /** HV-11 §4: the counterfactual verdict for the cell the cat stands on, if it ran. */
  heldChoke: HeldChokeReport | null;
  claims: Map<string, TacticalClaim>;
  catMoveCalls: number;
  permutationsPlayed: number;
  stageMs: { derive: number; gateRace: number; reach: number; hold: number };
}

const skippedRow = (end: GameEngineState, key: string, reason: string): EndRow => ({
  endPosition: rc(end.catPosition),
  endStateKey: key,
  scanned: false,
  notScannedReason: reason,
  gateRaceAggregate: null,
  gateRaceContribution: 0,
  gateRaceReason: 'ok',
  imminentOrigins: [],
  targetCount: 0,
  targetsDroppedByCap: 0,
  targetCapReached: false,
  droppedTargetCells: [],
  deriveCapHit: false,
  rejectedNever: [],
  targetLegalityCounts: { NEVER_ENTERABLE: 0, PUSH_REQUIRED_POTENTIAL: 0, CURRENTLY_ENTERABLE: 0, UNPROVEN: 0 },
  reachableTargets: [],
  verifiedWitnesses: 0,
  timely: [],
  threatRoutesCovered: [],
  uncoveredThreatRoutes: [],
  unknownCount: 0,
  unknownTargets: [],
  heldKeyCell: null,
  heldChoke: null,
  claims: new Map(),
  catMoveCalls: 0,
  permutationsPlayed: 0,
  stageMs: { derive: 0, gateRace: 0, reach: 0, hold: 0 },
});

/**
 * Scan one complete-cat-turn end state: build the production leaf, read Gate Race,
 * derive the cells, probe them cheaply, and price the timing with production's own
 * clock. `sweep` is never on — absence stays UNKNOWN here.
 */
export function scoutEndState(
  end: GameEngineState,
  caps: ScoutCaps = DEFAULT_CAPS,
): EndRow {
  const key = stateKey(handOffToMouse(end, true));
  // A turn plan that ends the game has nothing to defend — the capture is the claim.
  if (end.phase !== GamePhase.Playing) return skippedRow(end, key, `terminal (${end.phase}): a legal win needs no interception`);

  const leaf = handOffToMouse(end, true);
  const view = bankTurn(leaf);
  const t0 = performance.now();
  const gr = computeGateRace(leaf);
  const t1 = performance.now();
  const ctx = createEvaluationContext(view);
  const routes = imminentRoutes(leaf, ctx, gr);
  const routeIndex = indexRoutes(routes);
  const ranked = rankScoutTargets(view, ctx, routes);
  const targets = ranked.targets.slice(0, caps.maxTargetsPerEnd);
  const dropped = Math.max(0, ranked.targets.length - targets.length);
  const droppedTargetCells = ranked.targets.slice(targets.length).map((t) => t.cell);
  const targetLegalityCounts = { NEVER_ENTERABLE: 0, PUSH_REQUIRED_POTENTIAL: 0, CURRENTLY_ENTERABLE: 0, UNPROVEN: 0 };
  for (const t of targets) targetLegalityCounts[t.legality]++;
  const t2 = performance.now();
  const reach = boundedTacticalReach(view, targets.map((t) => t.cell), { sweep: false });
  const t3 = performance.now();
  // HV-11 §4: the held-choke proof lives in `scoutRoot`, where the LEGAL alternative
  // endings of the same turn are known. A leaf cannot supply its own counterfactual.
  let heldChoke: HeldChokeReport | null = null;
  const holdMs = 0;

  const timely: TimelyRow[] = [];
  const reachableTargets: string[] = [];
  const unknownTargets: string[] = [];
  let verifiedWitnesses = 0;
  for (const claim of reach.claims.values()) {
    if (claim.verdict !== 'REACHABLE_WITHIN_4' || claim.witness === null || claim.steps === null) {
      unknownTargets.push(claim.cell);
      continue;
    }
    verifiedWitnesses++;
    reachableTargets.push(claim.cell);
    const on = routeIndex.get(claim.cell) ?? [];
    let best: TimelyRow | null = null;
    for (const rec of on) {
      const catAtomic = rec.route.catAt.get(claim.steps) ?? null;
      const mouseAtomic = rec.layer.mouseAtomic;
      const margin = catAtomic !== null && mouseAtomic !== null ? catAtomic - mouseAtomic : null;
      const row: TimelyRow = {
        cell: claim.cell,
        steps: claim.steps,
        pushes: claim.pushes,
        witness: claim.witness.join(''),
        verdict: margin !== null && margin < 0 ? 'CAT_CAN_ARRIVE_BEFORE_MOUSE' : 'POTENTIAL_INTERCEPTION',
        routeOrigin: rec.route.origin,
        routeStep: rec.layer.step,
        layerWidth: rec.layer.width,
        catAtomic,
        mouseAtomic,
        margin,
        note:
          margin === null
            ? 'the production clock has no entry for this step count'
            : margin < 0
              ? `cat atomic ${catAtomic} < mouse atomic ${mouseAtomic} on the ${rec.route.origin} corridor at step ${rec.layer.step}, layer width ${rec.layer.width}`
              : `cat atomic ${catAtomic} is ${margin} step(s) behind the mouse crossing at ${mouseAtomic}`,
        endsInCapture: claim.endsInCapture,
      };
      if (best === null || (row.margin ?? 1e9) < (best.margin ?? 1e9)) best = row;
    }
    timely.push(
      best ?? {
        cell: claim.cell,
        steps: claim.steps,
        pushes: claim.pushes,
        witness: claim.witness.join(''),
        verdict: 'POTENTIAL_INTERCEPTION',
        routeOrigin: null,
        routeStep: null,
        layerWidth: null,
        catAtomic: null,
        mouseAtomic: null,
        margin: null,
        note: 'no imminent mouse route passes this cell — arriving here proves position, not interception',
        endsInCapture: claim.endsInCapture,
      },
    );
  }

  const covered = new Set<string>();
  for (const t of timely) if (t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE' && t.routeOrigin !== null) covered.add(t.routeOrigin);

  const catCell = rc(view.catPosition);
  const catKinds = new Set<ScoutKind>();
  if (ctx.gateCells.some((g) => rc(g) === catCell)) catKinds.add('gate');
  if (view.butterPositions.some((b) => rc(b) === catCell)) catKinds.add('butter');
  const hole = view.config.mouseHole;
  const inHole = (r: number, c: number): boolean => r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;
  const [cr, cc] = [view.catPosition.r, view.catPosition.c];
  if (!inHole(cr, cc) && (inHole(cr - 1, cc) || inHole(cr + 1, cc) || inHole(cr, cc - 1) || inHole(cr, cc + 1))) {
    catKinds.add('hole-feed');
  }
  for (const r of ranked.targets) if (r.cell === catCell) for (const k of r.kinds) catKinds.add(k);

  return {
    endPosition: catCell,
    endStateKey: key,
    scanned: true,
    notScannedReason: null,
    gateRaceAggregate: gr.aggregate,
    gateRaceContribution: gr.contribution,
    gateRaceReason: gr.reason,
    imminentOrigins: gr.imminentOrigins,
    targetCount: targets.length,
    targetsDroppedByCap: dropped,
    targetCapReached: dropped > 0,
    droppedTargetCells,
    deriveCapHit: ranked.deriveCapHit,
    rejectedNever: ranked.rejectedNever,
    targetLegalityCounts,
    reachableTargets,
    verifiedWitnesses,
    timely,
    threatRoutesCovered: [...covered].sort(),
    uncoveredThreatRoutes: gr.imminentOrigins.filter((o) => !covered.has(o)).sort(),
    unknownCount: unknownTargets.length,
    unknownTargets,
    heldKeyCell: catKinds.size > 0 ? { cell: catCell, kinds: [...catKinds].sort() } : null,
    heldChoke,
    claims: reach.claims,
    catMoveCalls: reach.stats.catMoveCalls,
    permutationsPlayed: reach.stats.permutationsPlayed,
    stageMs: { derive: t2 - t1, gateRace: t1 - t0, reach: t3 - t2, hold: holdMs },
  };
}

// ---------------------------------------------------------------------------
// HV-11 §4 P1 — does the cell the cat ALREADY stands on defend anything?
// ---------------------------------------------------------------------------

/**
 * THE QUESTION HV-10 could not answer. HV-10's control C failed for a structural reason:
 * the mouse BFS refuses to enter the cat's cell (evaluation.ts:83), so a cell the cat
 * holds simply disappears from the corridor it blocks, and a table built from that
 * corridor cannot see the defence. `heldKeyCell` was the honest placeholder for that
 * blindness, and the ordering ignored it.
 *
 * THE ANSWER IS A COUNTERFACTUAL, NOT A BONUS. World A is the leaf as the cat left it
 * (cat on X). World B is the SAME leaf with the cat one legal step off X (Y comes from the
 * real `catActions` graph, so "the cat could have been elsewhere" is an engine fact, not
 * an assumption). X is a defence only if, with the hold REMOVED, the mouse's own shortest
 * carrying route runs through X — and only if taking X back away from the mouse costs the
 * mouse legal steps. Everything else is standing on a cell.
 *
 * NEVER `cat stood on a once-important cell → points`. The six §4.2 questions are each a
 * separate field, each derived from the current state and a legal counterfactual, and none
 * of them reads a human log or claims the mouse is lost.
 */
export type HeldVerdict = 'PROVEN' | 'NOT_PROVEN' | 'UNKNOWN';
export type HeldAnswer = 'YES' | 'NO' | 'UNKNOWN';

export interface HeldChokeRow {
  holdCell: string;
  origin: string;
  /** Which legal alternative ending of the same turn was used as the counterfactual. */
  contrastCell: string | null;
  /** (a) in the contrast world, is X on a shortest carrying route from this origin? */
  onShortestRouteWithoutHold: boolean | null;
  /** The route step of X in the contrast world. */
  crossingStep: number | null;
  /** The layer width at that step in the contrast world — 1 means no equal-cost lane there. */
  crossingLayerWidth: number | null;
  /** (b) the engine refuses the mouse step into X in world A and accepts it in world B. */
  routeBlocked: HeldAnswer;
  /** (c) does a complete carrying-return route still exist for this origin in world A? */
  alternativeRouteExists: HeldAnswer;
  /** Production Gate Race route length: world A (hold) vs world B (contrast). */
  routeLengthHeld: number | null;
  routeLengthFree: number | null;
  /** TRUE when production prices no complete route at all in world A. */
  routeGoneInHold: boolean;
  /** (d) routeLengthHeld − routeLengthFree, in legal mouse steps; null = UNKNOWN/gone. */
  routeDelaySteps: number | null;
  /** (e) does the mouse reach X before the cat must spend its next turn? */
  holdCoversCrossing: HeldAnswer;
  mouseCrossingAtomic: number | null;
  catNextTurnFirstAtomic: number | null;
  /** (f) how many imminent origins of the contrast world have X on their route. */
  originsLosingHoldCell: number;
  verdict: HeldVerdict;
  note: string;
}

export interface HeldChokeReport {
  holdCell: string;
  /** Does X touch the imminent corridor of the contrast world it was judged against? */
  corridorAdjacent: boolean;
  /** The contrast ending actually used (the cat stands here instead), or null. */
  contrastCell: string | null;
  /** TRUE when no contrast could be evaluated at all — the verdict is then UNKNOWN, not NO. */
  skipped: boolean;
  skipReason: string | null;
  rows: HeldChokeRow[];
  /** PROVEN on at least one origin / NOT_PROVEN when the evidence decided / UNKNOWN. */
  verdict: HeldVerdict;
  /** Origins with a PROVEN hold — the routes this cat turn actually defends by standing. */
  provenOrigins: string[];
  /** The single-cell, width-1 proven holds: what the ordering is allowed to see. */
  provenChokeCells: { cell: string; origin: string; step: number; delaySteps: number; mouseAtomic: number; catAtomic: number }[];
  /** How many legal alternative endings were priced before the report settled. */
  contrastsTried: number;
  costMs: number;
}

const ORTHO: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** A mouse that already carries at `cell` — a labelled position, walked by the real rule. */
const withMouseCarryingAt = (s: GameEngineState, cell: string): GameEngineState => ({
  ...s,
  mousePosition: parseCell(cell),
  mouseHasButter: true,
  currentPlayer: PieceType.Mouse,
  tunnelExitChoices: [],
});

/**
 * The proof. `leaf` is the hand-off leaf (mouse to move) with the cat on its hold cell X;
 * `contrasts` are OTHER legal endings of the SAME cat turn, supplied in preference order
 * by the caller. That is what makes the counterfactual legal: the cat could really have
 * finished its turn there, and no teleport is ever invented.
 *
 * DIRECTION MATTERS. The mouse's plan is read in the CONTRAST world B (no cat on X), never
 * in the hold world: a hold that removes a route entirely leaves production nothing to
 * price, so a route-driven scan of world A would call the strongest holds "nothing to
 * defend". World A then answers three questions against B's own plan: is X on the mouse's
 * shortest carrying route, does the real mouse step refuse X, and does the mouse cross X
 * before the cat must spend its next turn (a cat may not stand still, so a hold that ends
 * before the crossing is not a hold).
 */
export function proveHeldChoke(
  leaf: GameEngineState,
  contrasts: GameEngineState[],
): HeldChokeReport {
  const holdCell = rc(leaf.catPosition);
  const [hr, hc] = [leaf.catPosition.r, leaf.catPosition.c];
  const base: HeldChokeReport = {
    holdCell,
    corridorAdjacent: false,
    contrastCell: null,
    skipped: false,
    skipReason: null,
    rows: [],
    verdict: 'UNKNOWN',
    provenOrigins: [],
    provenChokeCells: [],
    contrastsTried: 0,
    costMs: 0,
  };
  if (contrasts.length === 0) {
    return { ...base, skipped: true, skipReason: 'no other legal ending of this cat turn exists, so no counterfactual world can be built' };
  }

  const t0 = performance.now();
  const grA = computeGateRace(leaf);
  const ctxA = createEvaluationContext(bankTurn(leaf));
  const corridorA = new Set<string>();
  for (const rt of imminentRoutes(leaf, ctxA, grA)) for (const l of rt.layers) for (const c of l.cells) corridorA.add(c);
  // A contrast that lands back on the corridor is itself a blockade; try the neutral ones
  // first, then the rest, always in a deterministic order so a report is reproducible.
  const ordered = [...contrasts].sort((x, y) => {
    const ax = corridorA.has(rc(x.catPosition)) ? 1 : 0;
    const ay = corridorA.has(rc(y.catPosition)) ? 1 : 0;
    return ax - ay || rc(x.catPosition).localeCompare(rc(y.catPosition));
  });
  let contrastsTried = 0;
  let fallback: { rows: HeldChokeRow[]; contrastCell: string } | null = null;
  for (const b of ordered) {
    if (b.phase !== GamePhase.Playing) continue;
    contrastsTried++;
    const ctxB = createEvaluationContext(bankTurn(b));
    const grB = computeGateRace(b, ctxB);
    const routesB = imminentRoutes(b, ctxB, grB);
    const corridor = new Set<string>();
    for (const rt of routesB) for (const l of rt.layers) for (const c of l.cells) corridor.add(c);
    const adjacent = corridor.has(holdCell) || ORTHO.some(([dr, dc]) => corridor.has(`${hr + dr},${hc + dc}`));
    const contrastCell = rc(b.catPosition);
    if (routesB.length === 0) {
      if (fallback === null) fallback = { rows: [], contrastCell };
      continue;
    }

    const rows: HeldChokeRow[] = [];
    let voidContrast = false;
    for (const rtB of routesB) {
      const layerX = rtB.layers.find((l) => l.cells.includes(holdCell));
      const threatA = grA.threats.find((t) => t.origin === rtB.origin);
      const lenA = threatA?.routeLength ?? null;
      const gone = lenA === null;
      const delay = lenA === null ? null : lenA - rtB.routeLength;
      if (delay !== null && delay < 0) {
        // The cat on X makes this route SHORTER than with the cat elsewhere: the two
        // worlds are not comparable, so this contrast is discarded rather than priced.
        voidContrast = true;
        break;
      }
      if (layerX === undefined) {
        rows.push({
          holdCell,
          origin: rtB.origin,
          contrastCell,
          onShortestRouteWithoutHold: false,
          crossingStep: null,
          crossingLayerWidth: null,
          routeBlocked: 'NO',
          alternativeRouteExists: gone ? 'NO' : 'YES',
          routeLengthHeld: lenA,
          routeLengthFree: rtB.routeLength,
          routeGoneInHold: gone,
          routeDelaySteps: delay,
          holdCoversCrossing: 'NO',
          mouseCrossingAtomic: null,
          catNextTurnFirstAtomic: rtB.catAt.get(1) ?? null,
          originsLosingHoldCell: 0,
          verdict: 'NOT_PROVEN',
          note: `with the cat off ${holdCell} no shortest ${rtB.origin} route passes through it, so standing there defends nothing on this route`,
        });
        continue;
      }

      // (b) the real RULE, both ways: the same carrying mouse at the same predecessor is
      // refused X in world A and accepted X in world B.
      const prev = layerX.step === 1 ? rtB.origin : rtB.layers.find((l) => l.step === layerX.step - 1)?.cells.find((c) => {
        const p = parseCell(c);
        return Math.abs(p.r - hr) + Math.abs(p.c - hc) === 1;
      }) ?? null;
      let blocked: HeldAnswer = 'UNKNOWN';
      if (prev !== null) {
        const inHold = walkMouseSegment(withMouseCarryingAt(leaf, prev), [holdCell]);
        const inFree = walkMouseSegment(withMouseCarryingAt(b, prev), [holdCell]);
        blocked = inHold.status === 'BROKEN' && inHold.walked === 0 && inFree.walked === 1 ? 'YES' : 'NO';
      }
      // (e) production's own clock. The cat must spend its next turn's moves (GAMEPLAY.md
      // §5), so a crossing that happens after catAt(1) is not covered by this hold.
      const mouseAtomic = layerX.mouseAtomic;
      const catNext = rtB.catAt.get(1) ?? null;
      const covers: HeldAnswer = mouseAtomic === null || catNext === null ? 'UNKNOWN' : mouseAtomic < catNext ? 'YES' : 'NO';
      const provenRow = blocked === 'YES' && (gone || (delay !== null && delay >= 1)) && covers === 'YES';
      rows.push({
        holdCell,
        origin: rtB.origin,
        contrastCell,
        onShortestRouteWithoutHold: true,
        crossingStep: layerX.step,
        crossingLayerWidth: layerX.width,
        routeBlocked: blocked,
        alternativeRouteExists: gone ? 'NO' : 'YES',
        routeLengthHeld: lenA,
        routeLengthFree: rtB.routeLength,
        routeGoneInHold: gone,
        routeDelaySteps: delay,
        holdCoversCrossing: covers,
        mouseCrossingAtomic: mouseAtomic,
        catNextTurnFirstAtomic: catNext,
        originsLosingHoldCell: 0,
        verdict: provenRow ? 'PROVEN' : 'NOT_PROVEN',
        note: provenRow
          ? `with the cat elsewhere the mouse takes ${holdCell} at route step ${layerX.step} (layer width ${layerX.width}); the hold makes its route ${gone ? 'disappear from production pricing' : `+${delay} step(s)`} and the crossing (atomic ${mouseAtomic}) still lands before the cat must move again at ${catNext}`
          : `hold refused on this origin: blocked=${blocked}, ${gone ? 'route gone in the hold world' : `delay=${delay ?? 'UNKNOWN'}`}, covered=${covers} (crossing ${mouseAtomic ?? '?'} vs cat next move ${catNext ?? '?'})`,
      });
    }
    if (voidContrast) continue;
    if (fallback === null) fallback = { rows, contrastCell };
    if (rows.some((r) => r.onShortestRouteWithoutHold === true)) {
      const losing = rows.filter((r) => r.onShortestRouteWithoutHold === true).length;
      const settled = rows.map((r) => ({ ...r, originsLosingHoldCell: losing }));
      const provenRows = settled.filter((r) => r.verdict === 'PROVEN');
      return {
        holdCell,
        corridorAdjacent: adjacent,
        contrastCell,
        skipped: false,
        skipReason: null,
        rows: settled,
        verdict: provenRows.length > 0 ? 'PROVEN' : settled.some((r) => r.verdict === 'UNKNOWN') ? 'UNKNOWN' : 'NOT_PROVEN',
        provenOrigins: provenRows.map((r) => r.origin).sort(),
        provenChokeCells: provenRows
          .filter((r) => r.crossingLayerWidth === 1)
          .map((r) => ({
            cell: r.holdCell,
            origin: r.origin,
            step: r.crossingStep ?? 0,
            delaySteps: r.routeDelaySteps ?? 0,
            mouseAtomic: r.mouseCrossingAtomic ?? 0,
            catAtomic: r.catNextTurnFirstAtomic ?? 0,
          })),
        contrastsTried,
        costMs: performance.now() - t0,
      };
    }
  }

  const rows = fallback?.rows ?? [];
  return {
    ...base,
    corridorAdjacent: rows.some((r) => r.onShortestRouteWithoutHold === true),
    contrastCell: fallback?.contrastCell ?? null,
    skipped: rows.length === 0,
    skipReason:
      rows.length === 0
        ? `no legal alternative ending of this cat turn prices an imminent carrying route, so no contrast world exists`
        : null,
    rows,
    verdict: rows.length === 0 ? 'UNKNOWN' : rows.some((r) => r.verdict === 'UNKNOWN') ? 'UNKNOWN' : 'NOT_PROVEN',
    contrastsTried,
    costMs: performance.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// the root scan: every legal complete cat turn, once per distinct end state
// ---------------------------------------------------------------------------

/**
 * A PROVEN hold is an interception the corridor table cannot see (the mouse BFS refuses
 * to enter the cat's cell), so it enters the same `timely` grammar as a zero-step arrival
 * carrying its counterfactual evidence — never as a bonus for standing still.
 */
function heldChokeTimelyRows(rep: HeldChokeReport): TimelyRow[] {
  return rep.provenChokeCells.map((p) => ({
    cell: p.cell,
    steps: 0,
    pushes: 0,
    witness: '',
    verdict: 'CAT_CAN_ARRIVE_BEFORE_MOUSE',
    routeOrigin: p.origin,
    routeStep: p.step,
    layerWidth: 1,
    catAtomic: 0,
    mouseAtomic: p.mouseAtomic,
    margin: -p.mouseAtomic,
    note: `held choke: the cat already stands on ${p.cell}; with it elsewhere the mouse takes that cell at route step ${p.step} (layer width 1) and the hold costs it +${p.delaySteps} step(s); crossing at atomic ${p.mouseAtomic} precedes the cat's next move at ${p.catAtomic}`,
    endsInCapture: false,
  }));
}

export interface PlanRow {
  /** Action tokens the ENGINE accepted: U/D/L/R, plus P for a trap placement. */
  plan: string;
  kind: 'turn_complete' | 'capture';
  endState: GameEngineState;
  endPosition: string;
  endStateKey: string;
  /** FALSE when an earlier plan already reached this exact full state (cache hit). */
  firstForEndState: boolean;
  sharesEndStateWith: string | null;
  /** Boxes whose cell changed over the turn (a plan may push one box twice). */
  boxesMoved: number;
  trapPlaced: boolean;
  /** TRUE when the turn ended with steps still in the bank (no legal step left). */
  stalledEarly: boolean;
  row: EndRow;
}

/**
 * HV-11 §5 — the scan is either COMPLETE or INCOMPLETE, and an INCOMPLETE scan may not
 * feed a global plan choice. "INCOMPLETE" covers every way a cap can bind: the turn
 * enumeration, the end-state cap, the per-state target cap, and the derivation's own cap.
 */
export type ScanStatus = 'COMPLETE' | 'INCOMPLETE';

export interface ScanTruncation {
  status: ScanStatus;
  /** End states the caps refused to scan. Every field of these is UNKNOWN. */
  endStates: string[];
  /** Target cells the per-state cap dropped before probing. UNSCANNED = UNKNOWN. */
  targetCells: { endStateKey: string; cell: string }[];
  /** Probed cells the engine could not place inside this turn. Also UNKNOWN, not NO. */
  unknownTargets: number;
  /** Every cap that bound, named. Empty exactly when status is COMPLETE. */
  reasons: string[];
}

/**
 * The `catMove` cap is checked BETWEEN end states, so the last state can overshoot it.
 * That is a declared contract, not a silent overrun: `overrun` is the measured cost.
 */
export interface CatMoveBudget {
  contract: 'SOFT_CAP_WITH_OVERRUN';
  cap: number;
  used: number;
  overrun: number;
  note: string;
}

export interface ScoutStats {
  rootCatPosition: string;
  rootMousePosition: string;
  ends: number;
  captures: number;
  totalPlans: number;
  distinctEndStates: number;
  distinctEndPositions: number;
  enumerationComplete: boolean;
  truncatedEnumeration: boolean;
  enumerationNodes: number;
  /** HV-11 §5: the turn enumeration is part of the root cost, so it is measured. */
  enumerationMs: number;
  scannedEndStates: number;
  notScannedEndStates: number;
  truncationReason: string | null;
  targetsTotal: number;
  targetsMaxOnOneState: number;
  targetsDroppedByCap: number;
  /** Proposals the rules forbade outright (with the rule, per state). */
  targetsRejectedByRules: number;
  /** How every probed proposal classified: the four §5 legality categories. */
  targetLegalityTotal: Record<TargetLegality, number>;
  scanStatus: ScanStatus;
  unscanned: ScanTruncation;
  catMoveBudget: CatMoveBudget;
  permutationsMaxOnOneState: number;
  catMoveCallsTotal: number;
  catMoveCallsMaxOnOneState: number;
  permutationsTotal: number;
  cacheHits: number;
  deriveMs: number;
  gateRaceMs: number;
  reachMs: number;
  /** HV-11 §4: total wall time spent on held-choke counterfactuals (a root cost). */
  holdMs: number;
  /** End states whose hold proof actually ran, and those the cap refused. */
  holdProofsRun: number;
  holdProofsSkippedByCap: number;
  totalMs: number;
}

export interface RootScout {
  plans: PlanRow[];
  /** Distinct end states, in first-seen order — the work the scan actually did. */
  scanned: EndRow[];
  stats: ScoutStats;
}

/**
 * Turn order, stated once in the structure: `root` is the real cat-turn start, the
 * plans spend THAT turn, and every scanned position is the cat's NEXT turn as seen
 * after the mouse has answered — which is why a witness stays POTENTIAL until the
 * production clock also proves the cat is quicker to the corridor cell.
 */
export function scoutRoot(root: GameEngineState, caps: ScoutCaps = DEFAULT_CAPS): RootScout {
  const t0 = performance.now();
  const turn = enumerateCatTurnExact([{ state: root, plan: [] }], caps.nodeCap);
  const enumerationMs = performance.now() - t0;
  const plans: { plan: string; kind: PlanRow['kind']; end: GameEngineState }[] = [];
  for (const e of turn.ends) plans.push({ plan: e.plan.join(''), kind: 'turn_complete', end: e.state });
  for (const c of turn.captures) {
    plans.push({ plan: c.join(''), kind: 'capture', end: replayCatPlan(root, c).end });
  }

  const rows: PlanRow[] = [];
  const cache = new Map<string, EndRow>();
  let cacheHits = 0;
  let truncationReason: string | null = null;
  let deriveMs = 0;
  let gateRaceMs = 0;
  let reachMs = 0;
  let holdMs = 0;
  let callsUsed = 0;
  const holdBudget = { left: caps.maxHoldProofs };
  const leafByKey = new Map<string, GameEngineState>();
  const layout0 = boxCells(root);

  for (const p of plans) {
    const key = stateKey(handOffToMouse(p.end, true));
    if (!leafByKey.has(key)) leafByKey.set(key, handOffToMouse(p.end, true));
    const cached = cache.get(key);
    if (cached !== undefined) {
      cacheHits++;
      rows.push(rowOf(p, key, cached, true, layout0));
      continue;
    }
    const overStates = cache.size >= caps.maxEndStates;
    const overCalls = callsUsed >= caps.maxCatMoveCalls;
    if (overStates || overCalls) {
      if (truncationReason === null) {
        truncationReason = overStates
          ? `distinct-end-state cap ${caps.maxEndStates} reached`
          : `scan catMove-call cap ${caps.maxCatMoveCalls} reached`;
      }
      const skipped = skippedRow(p.end, key, `NOT_SCANNED: ${truncationReason} — absence here is UNKNOWN, not a negative`);
      cache.set(key, skipped);
      rows.push(rowOf(p, key, skipped, false, layout0));
      continue;
    }
    const row = scoutEndState(p.end, caps);
    cache.set(key, row);
    callsUsed += row.catMoveCalls;
    deriveMs += row.stageMs.derive;
    gateRaceMs += row.stageMs.gateRace;
    reachMs += row.stageMs.reach;
    rows.push(rowOf(p, key, row, false, layout0));
  }

  // HV-11 §4: the held-choke proof needs the OTHER legal endings of this same turn, so it
  // runs here — once per scanned end state, bounded, and counted into the root totals.
  let holdRun = 0;
  const scannedForProof = [...cache.values()].filter((r) => r.scanned);
  for (const row of scannedForProof) {
    if (holdBudget.left <= 0) break;
    const leafA = leafByKey.get(row.endStateKey);
    if (leafA === undefined) continue;
    const contrasts = scannedForProof
      .filter((r) => r.endStateKey !== row.endStateKey)
      .map((r) => leafByKey.get(r.endStateKey))
      .filter((l): l is GameEngineState => l !== undefined)
      .slice(0, HOLD_CONTRAST_CAP);
    const rep = proveHeldChoke(leafA, contrasts);
    row.heldChoke = rep;
    row.stageMs.hold = rep.costMs;
    holdMs += rep.costMs;
    holdRun++;
    holdBudget.left--;
    for (const t of heldChokeTimelyRows(rep)) row.timely.push(t);
    const covered = new Set<string>();
    for (const t of row.timely) if (t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE' && t.routeOrigin !== null) covered.add(t.routeOrigin);
    row.threatRoutesCovered = [...covered].sort();
    row.uncoveredThreatRoutes = row.imminentOrigins.filter((o) => !covered.has(o)).sort();
  }

  const scanned = [...cache.values()].filter((r) => r.scanned);
  // HV-11 §5: name every cap that bound, and turn the whole scan into one status a caller
  // can refuse to consume. An INCOMPLETE scan never authorises a global plan choice.
  const capReasons: string[] = [];
  if (turn.truncated) capReasons.push(`turn enumeration node cap ${caps.nodeCap} reached`);
  if (truncationReason !== null) capReasons.push(truncationReason);
  if (scanned.some((r) => r.deriveCapHit)) capReasons.push(`target derivation cap ${DERIVE_TARGET_CAP} reached`);
  const targetTruncated = scanned.filter((r) => r.targetCapReached);
  if (targetTruncated.length > 0) {
    capReasons.push(`per-end target cap ${caps.maxTargetsPerEnd} reached on ${targetTruncated.length} end state(s)`);
  }
  const catMoveCallsTotal = scanned.reduce((a, r) => a + r.catMoveCalls, 0);
  const unscanned: ScanTruncation = {
    status: capReasons.length === 0 ? 'COMPLETE' : 'INCOMPLETE',
    endStates: [...cache.entries()].filter(([, r]) => !r.scanned).map(([k]) => k),
    targetCells: scanned.flatMap((r) => r.droppedTargetCells.map((cell) => ({ endStateKey: r.endStateKey, cell }))),
    unknownTargets: scanned.reduce((a, r) => a + r.unknownCount, 0),
    reasons: capReasons,
  };
  const legalityTotal: Record<TargetLegality, number> = { NEVER_ENTERABLE: 0, PUSH_REQUIRED_POTENTIAL: 0, CURRENTLY_ENTERABLE: 0, UNPROVEN: 0 };
  for (const r of scanned) for (const k of Object.keys(legalityTotal) as TargetLegality[]) legalityTotal[k] += r.targetLegalityCounts[k];
  const t1 = performance.now();
  return {
    plans: rows,
    scanned,
    stats: {
      rootCatPosition: rc(root.catPosition),
      rootMousePosition: rc(root.mousePosition),
      ends: turn.ends.length,
      captures: turn.captures.length,
      totalPlans: plans.length,
      distinctEndStates: cache.size,
      distinctEndPositions: new Set(plans.map((p) => rc(p.end.catPosition))).size,
      enumerationComplete: !turn.truncated,
      truncatedEnumeration: turn.truncated,
      enumerationNodes: turn.nodes,
      enumerationMs,
      scannedEndStates: scanned.length,
      notScannedEndStates: cache.size - scanned.length,
      truncationReason,
      targetsTotal: scanned.reduce((a, r) => a + r.targetCount, 0),
      targetsMaxOnOneState: scanned.reduce((a, r) => Math.max(a, r.targetCount), 0),
      targetsDroppedByCap: scanned.reduce((a, r) => a + r.targetsDroppedByCap, 0),
      targetsRejectedByRules: scanned.reduce((a, r) => a + r.rejectedNever.length, 0),
      targetLegalityTotal: legalityTotal,
      scanStatus: unscanned.status,
      unscanned,
      catMoveBudget: {
        contract: 'SOFT_CAP_WITH_OVERRUN',
        cap: caps.maxCatMoveCalls,
        used: catMoveCallsTotal,
        overrun: Math.max(0, catMoveCallsTotal - caps.maxCatMoveCalls),
        note: 'the cap is checked between end states; the last state may overshoot it by at most its own catMoveCalls',
      },
      permutationsMaxOnOneState: scanned.reduce((a, r) => Math.max(a, r.permutationsPlayed), 0),
      catMoveCallsTotal,
      catMoveCallsMaxOnOneState: scanned.reduce((a, r) => Math.max(a, r.catMoveCalls), 0),
      permutationsTotal: scanned.reduce((a, r) => a + r.permutationsPlayed, 0),
      cacheHits,
      deriveMs,
      gateRaceMs,
      reachMs,
      holdMs,
      holdProofsRun: holdRun,
      holdProofsSkippedByCap: scanned.length - holdRun,
      totalMs: t1 - t0,
    },
  };
}

const rowOf = (
  p: { plan: string; kind: PlanRow['kind']; end: GameEngineState },
  key: string,
  row: EndRow,
  isDuplicate: boolean,
  layout0: string[],
): PlanRow => {
  const layout1 = boxCells(p.end);
  const moved = layout1.filter((c) => !layout0.includes(c)).length;
  return {
    plan: p.plan,
    kind: p.kind,
    endState: p.end,
    endPosition: rc(p.end.catPosition),
    endStateKey: key,
    firstForEndState: !isDuplicate,
    sharesEndStateWith: isDuplicate ? p.plan : null,
    boxesMoved: moved,
    trapPlaced: p.plan.includes('P'),
    stalledEarly: p.kind === 'turn_complete' && p.end.phase === GamePhase.Playing && p.end.catMovesLeft > 0,
    row,
  };
};

// ---------------------------------------------------------------------------
// the only decision-shaped output: a preference over end states, never a score
// ---------------------------------------------------------------------------

/**
 * The five states the table can honestly be in. A preference is a COMPARISON over the
 * rows that were actually scanned, so a partial scan and a scan with no separation each
 * get their own word; neither is allowed to read like a global best.
 */
export type PreferenceStatus =
  | 'IMMEDIATE_CAPTURE_PRIORITY'
  /** Every end state is NOT_SCANNED: nothing to compare, so nothing is preferred. */
  | 'NO_PREFERENCE'
  /** A complete scan whose rows all tie on the contract keys: no advantage is claimed. */
  | 'NO_TACTICAL_SEPARATION'
  /** The same tie, over a subset: the unscanned rows could still change the answer. */
  | 'PARTIAL_NO_SEPARATION'
  | 'PARTIAL_PREFERENCE'
  | 'FULL_PREFERENCE';

/** One compared row: an end state reduced to the fields the contract orders on. */
export interface PreferenceCell {
  key: string;
  plans: string[];
  /** FALSE for a NOT_SCANNED row — UNKNOWN, so it is excluded from the comparison. */
  scanned: boolean;
  timely: number;
  chokeTimely: number;
  /** Imminent threat routes with no timely interception on this row. */
  uncovered: number;
  /** DIAGNOSTIC ONLY — see `comparePreferenceCells`; never consulted by the ordering. */
  held: number;
  /** DIAGNOSTIC ONLY — cells the cheap mode could witness, timely or not. */
  reachable: number;
  /**
   * HV-11 §5: TRUE when a cap bound inside this row (target or derivation cap), so the
   * row was only partially probed. Such a row may not be read as a global negative.
   */
  truncated?: boolean;
}

export interface Preference {
  best: string[];
  status: PreferenceStatus;
  reason: string;
  /** Capture plans are terminal wins and outrank every defensive row (control A). */
  immediateCapture: string[];
  /** TRUE when at least one scanned row differs from the best level on a contract key. */
  separates: boolean;
  scannedEndStates: number;
  unscannedEndStates: string[];
  /** Scanned rows whose own cap bound: their probed set is incomplete. */
  truncatedEndStates: string[];
  ranking: PreferenceCell[];
}

/**
 * The contract order, written ONCE and used by both the ranking and the best set —
 * HV-11 §3 P0. Lexicographic, and only ever lexicographic:
 *   1. more width-1 (choke) timely interceptions,
 *   2. then fewer uncovered imminent routes,
 *   3. then, for REPORTING ONLY, the production state key.
 * `compareContract` is keys 1 and 2 and nothing else: two rows equal there are a tie and
 * BOTH stay in `best`, so a key can never turn a tie into a winner. `held` and `reachable`
 * are diagnostic fields, deliberately absent here, so doc and implementation agree.
 */
const compareContract = (a: PreferenceCell, b: PreferenceCell): number => b.chokeTimely - a.chokeTimely || a.uncovered - b.uncovered;

const comparePreferenceCells = (a: PreferenceCell, b: PreferenceCell): number =>
  compareContract(a, b) || a.key.localeCompare(b.key);

/**
 * The comparison itself, over cells rather than engine rows, so it can be tested by
 * deterministic counterexamples without inventing a board state.
 */
export function preferenceFromCells(cells: PreferenceCell[]): Preference {
  const unscanned = cells.filter((c) => !c.scanned).map((c) => c.key);
  const truncated = cells.filter((c) => c.scanned && c.truncated === true).map((c) => c.key);
  const scanned = cells.filter((c) => c.scanned);
  const partialNote =
    (unscanned.length > 0 ? `${unscanned.length} end state(s) NOT_SCANNED` : '') +
    (unscanned.length > 0 && truncated.length > 0 ? ' and ' : '') +
    (truncated.length > 0 ? `${truncated.length} with a binding target cap` : '');
  const base = {
    immediateCapture: [] as string[],
    scannedEndStates: scanned.length,
    unscannedEndStates: unscanned,
    truncatedEndStates: truncated,
    ranking: [...cells].sort(comparePreferenceCells),
  };
  if (scanned.length === 0) {
    return {
      ...base,
      best: [],
      status: 'NO_PREFERENCE',
      separates: false,
      reason: `NO_PREFERENCE — all ${unscanned.length} end state(s) are NOT_SCANNED; their defensive value is UNKNOWN and no comparison exists`,
    };
  }
  // ONE sweep of ONE relation over the contract keys, so no two keys can name different
  // winners — the defect HV-11 §3 calls "two separate maxima".
  const bestCells = scanned.reduce<PreferenceCell[]>((top, c) => {
    if (top.length === 0) return [c];
    const cmp = compareContract(c, top[0]);
    if (cmp < 0) return [c];
    return cmp === 0 ? [...top, c] : top;
  }, []);
  const best = [...new Set(bestCells.flatMap((c) => c.plans))].sort();
  const level = `chokeTimely=${bestCells[0].chokeTimely}, uncovered=${bestCells[0].uncovered}`;
  const separates = scanned.some((c) => compareContract(c, bestCells[0]) !== 0);
  if (!separates) {
    return {
      ...base,
      best,
      separates,
      status: partialNote !== '' ? 'PARTIAL_NO_SEPARATION' : 'NO_TACTICAL_SEPARATION',
      reason:
        (bestCells[0].chokeTimely === 0
          ? `NO_TACTICAL_SEPARATION: all ${scanned.length} scanned end state(s) tie at ${level} — no timely choke interception exists, so no tactical advantage is claimed`
          : `NO_TACTICAL_SEPARATION: all ${scanned.length} scanned end state(s) tie at ${level}; the table lists the tie, it does not break it`) +
        (partialNote !== '' ? ` — PARTIAL: ${partialNote}, so this tie is a statement about the probed subset only` : ''),
    };
  }
  return {
    ...base,
    best,
    separates,
    status: partialNote !== '' ? 'PARTIAL_PREFERENCE' : 'FULL_PREFERENCE',
    reason:
      partialNote !== ''
        ? `PARTIAL_PREFERENCE over ${scanned.length} scanned of ${cells.length} end state(s) (${partialNote}): best=[${best.join(' ')}] at ${level} — a preference over the probed subset, never the global best`
        : `PREFERRED over ${scanned.length} distinct end state(s): best=[${best.join(' ')}] at ${level}`,
  };
}

/**
 * Reduce engine rows to compared cells and run the single lexicographic sweep. Grouping
 * is by the FULL production state key, never by the cat cell: two plans that end on the
 * same cell with a different box layout are different positions and stay apart.
 */
export function tacticalPreference(plans: PlanRow[]): Preference {
  const captures = plans.filter((p) => p.kind === 'capture').map((p) => p.plan);
  if (captures.length > 0) {
    const sorted = [...new Set(captures)].sort();
    return {
      best: sorted,
      status: 'IMMEDIATE_CAPTURE_PRIORITY',
      reason: `IMMEDIATE_CAPTURE_PRIORITY: ${sorted.length} legal plan(s) end the game this turn; no defensive row is compared against them`,
      immediateCapture: sorted,
      separates: true,
      scannedEndStates: 0,
      unscannedEndStates: [],
      truncatedEndStates: [],
      ranking: [],
    };
  }
  const byKey = new Map<string, { plans: string[]; row: PlanRow }>();
  for (const p of plans) {
    const cur = byKey.get(p.endStateKey);
    if (cur) cur.plans.push(p.plan);
    else byKey.set(p.endStateKey, { plans: [p.plan], row: p });
  }
  return preferenceFromCells(
    [...byKey.entries()].map(([key, v]) => {
      const timely = v.row.row.timely.filter((t) => t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE');
      return {
        key,
        plans: v.plans,
        scanned: v.row.row.scanned,
        timely: timely.length,
        chokeTimely: timely.filter((t) => t.layerWidth === 1).length,
        uncovered: v.row.row.uncoveredThreatRoutes.length,
        held: v.row.row.heldKeyCell !== null ? 1 : 0,
        reachable: v.row.row.reachableTargets.length,
        truncated: v.row.row.targetCapReached || v.row.row.deriveCapHit,
      };
    }),
  );
}

/** Re-play a stored witness on the engine, so a `YES` in the table is never taken on trust. */
export function reverifyWitness(end: GameEngineState, cell: string, witness: string): { ok: boolean; detail: string } {
  const view = bankTurn(handOffToMouse(end, true));
  const out = playLine(view, witnessDirections(witness));
  return {
    ok:
      out.refusedAt === -1 &&
      out.stepsApplied === witness.length &&
      rc(out.end.catPosition) === cell &&
      (out.captureAt === -1 || cell === rc(view.mousePosition)),
    detail: `refusedAt=${out.refusedAt} applied=${out.stepsApplied}/${witness.length} landed=${rc(out.end.catPosition)} pushes=${out.pushes} captureAt=${out.captureAt}`,
  };
}

/** `TOKEN_TO_DIR` is exported so the tests replay witnesses without re-deriving tokens. */
export const witnessDirections = (witness: string): Direction[] => witness.split('').map((t) => TOKEN_TO_DIR[t]);

// ---------------------------------------------------------------------------
// HV-11 §6 P3 — timing accounting that cannot confuse two different budgets
// ---------------------------------------------------------------------------

export interface PairedRuns<T> {
  /** Every run with its OWN measured time, sorted by that time. */
  pairs: { ms: number; run: T }[];
  min: number;
  median: number;
  max: number;
  spread: number;
  /**
   * The run that produced `median`. Every per-run volume in a report must be read from
   * THIS object: the old summary sorted the times, then indexed the UNSORTED run list with
   * `times.indexOf(median)`, so the reported median and the reported volumes could describe
   * two different runs.
   */
  medianRun: T;
}

export function pairedRuns<T>(runs: T[], timeOf: (run: T) => number): PairedRuns<T> {
  const pairs = runs.map((run) => ({ ms: timeOf(run), run })).sort((a, b) => a.ms - b.ms);
  const mid = Math.floor(pairs.length / 2);
  const min = pairs[0]!.ms;
  const max = pairs[pairs.length - 1]!.ms;
  return { pairs, min, median: pairs[mid]!.ms, max, spread: max - min, medianRun: pairs[mid]!.run };
}

export interface BudgetPair {
  /** The per-cat-turn search budget (production: 100ms). */
  mainSearchBudgetMs: number;
  /** The whole-turn cap that also covers the turn's non-search work (production: 150ms). */
  wholeTurnCapMs: number;
}

export interface HeadroomReport {
  mainSearchBudgetMs: number;
  mainSearchElapsedMs: number;
  /** `mainSearchBudgetMs − mainSearchElapsedMs` — what is left INSIDE the search budget. */
  mainHeadroomMs: number;
  wholeTurnCapMs: number;
  wholeTurnWallMs: number;
  /** `wholeTurnCapMs − wholeTurnWallMs` — what is left for the turn as a whole. */
  turnHeadroomMs: number;
  scanMs: number;
  fits: { main: boolean; turn: boolean };
  verdict: 'FITS_BOTH' | 'FITS_MAIN_ONLY' | 'FITS_TURN_ONLY' | 'FITS_NEITHER';
  note: string;
}

/**
 * HV-11 §6 P3 — two headrooms, never one.
 *
 * MAIN_HEADROOM is the search's own 100ms budget minus the search's own elapsed time.
 * TURN_HEADROOM is the 150ms whole-turn cap minus the wall time of the whole turn
 * (which includes refutation and selection after the search stops). Subtracting a whole
 * turn's wall time from the search budget — HV-10 E4's `100ms − wallMs` — is a category
 * error: it can be negative while the turn still has room, or positive while it does not.
 */
export function headroomReport(
  mainSearchElapsedMs: number,
  wholeTurnWallMs: number,
  scanMs: number,
  budgets: BudgetPair,
): HeadroomReport {
  const mainHeadroomMs = budgets.mainSearchBudgetMs - mainSearchElapsedMs;
  const turnHeadroomMs = budgets.wholeTurnCapMs - wholeTurnWallMs;
  const fits = { main: scanMs <= mainHeadroomMs, turn: scanMs <= turnHeadroomMs };
  return {
    mainSearchBudgetMs: budgets.mainSearchBudgetMs,
    mainSearchElapsedMs,
    mainHeadroomMs,
    wholeTurnCapMs: budgets.wholeTurnCapMs,
    wholeTurnWallMs,
    turnHeadroomMs,
    scanMs,
    fits,
    verdict: fits.main ? (fits.turn ? 'FITS_BOTH' : 'FITS_MAIN_ONLY') : fits.turn ? 'FITS_TURN_ONLY' : 'FITS_NEITHER',
    note: 'MAIN_HEADROOM prices work inside the search budget; TURN_HEADROOM prices work added after the turn. Different denominators, never interchangeable.',
  };
}
