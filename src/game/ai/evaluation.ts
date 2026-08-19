import type { GameEngineState } from '../engine';
import { PieceType, CellType, DIRECTIONS } from '../types';
import {
  getTunnelCorners,
  getOpenTunnelCorners,
  isTunnelUsable,
  isMouseTunnelEntryAllowed,
  getMouseHoleGateCells,
} from '../rules/tunnelRules';

// ============================================================
// Phase E1 — Strategic Evaluation v1
// ------------------------------------------------------------
// Builds on the E0 foundation (rule-aware, pure, explainable) and adds:
//   1. Tunnel ACCESS semantics (reachability-aware, not a global flag)
//   2. Two-stage MOUSE WIN ROUTE distance (butter -> hole, carrying mode)
//   3. HOLE CONTROL (gate cells from the shared kernel)
//   4. Rule-aware VORONOI v1 (area control, board-size normalized)
//   5. Small, explainable TEMPO contribution
//   6. Trap feature fixed to mouse-side reachability
//   7. Centralized DEFAULT_EVALUATION_WEIGHTS (no magic numbers in code)
//
// FROZEN RULES (user-approved): this module ONLY reads a GameEngineState.
// It never creates rules, never mutates input, never reads logs, never calls
// Math.random / Date.now, and never depends on search-path info. Terminal
// outcomes are scored by the search, NOT here (HEURISTIC_LIMIT clamp).
//
// STILL NOT WIRED (spec #19): expectiminimax.ts keeps defaultLeafEval as the
// production leaf. evaluateForCat* is the E1 foundation, injected only in
// benchmarks/tests.
// ============================================================

export const HEURISTIC_LIMIT = 10_000;

// ---------------------------------------------------------------------------
// Local rule helpers
// ---------------------------------------------------------------------------

type RC = { r: number; c: number };
const key = (p: RC): string => `${p.r},${p.c}`;
const inBounds = (state: GameEngineState, r: number, c: number): boolean =>
  r >= 0 && r < state.config.boardSize && c >= 0 && c < state.config.boardSize;

function isMouseHoleCell(state: GameEngineState, r: number, c: number): boolean {
  const { r: hr, c: hc, size } = state.config.mouseHole;
  return r >= hr && r < hr + size && c >= hc && c < hc + size;
}

function hasButterAt(state: GameEngineState, r: number, c: number): boolean {
  return state.butterPositions.some((b) => b.r === r && b.c === c);
}

function isFixedObstacle(type: CellType): boolean {
  return type === CellType.Pile || type === CellType.Wall;
}

/** Mouse-hole cells (generic over size). */
function mouseHoleCells(state: GameEngineState): RC[] {
  const cells: RC[] = [];
  const { r, c, size } = state.config.mouseHole;
  for (let dr = 0; dr < size; dr++)
    for (let dc = 0; dc < size; dc++) cells.push({ r: r + dr, c: c + dc });
  return cells;
}

// ---------------------------------------------------------------------------
// Rule-aware movement predicates
// ---------------------------------------------------------------------------

/**
 * Can the MOUSE legally step onto (r,c)? Mirrors engine.applyMouseStepCore:
 *  - box / pile / wall / void / cat position: NO
 *  - tunnel: only if NOT blocked AND the butter rule allows entry. The engine
 *    forbids entry whenever the mouse carries butter (skill activation
 *    CONSUMES the butter, so `!mouseHasButter` is the complete rule — a
 *    skill-active mouse that picks up new butter mid-turn cannot enter).
 */
function mouseCanEnter(state: GameEngineState, r: number, c: number): boolean {
  const cell = state.board[r][c];
  if (cell.type === CellType.Box) return false;
  if (isFixedObstacle(cell.type)) return false;
  if (cell.type === CellType.Void) return false;
  if (state.catPosition.r === r && state.catPosition.c === c) return false;
  if (cell.type === CellType.Tunnel) {
    if (!isTunnelUsable(state, r, c)) return false;
    if (!isMouseTunnelEntryAllowed(state)) return false;
    return true;
  }
  return true; // Empty, ButterSpot, MouseHole
}

/**
 * Can the CAT legally step onto (r,c)? Mirrors engine.catMove:
 *  - hole / tunnel / butter / pile / wall / void / box: NO
 *  - trap: YES (cat walks onto its own trap to recover it)
 *  - the cat MAY step onto the mouse's cell — that is the capture (win).
 */
function catCanEnter(state: GameEngineState, r: number, c: number): boolean {
  const cell = state.board[r][c];
  if (isMouseHoleCell(state, r, c)) return false;
  if (cell.type === CellType.Tunnel) return false;
  if (hasButterAt(state, r, c)) return false;
  if (isFixedObstacle(cell.type)) return false;
  if (cell.type === CellType.Void) return false;
  if (cell.type === CellType.Box) return false;
  return true;
}

/** Orthogonal neighbours (no teleport) the mouse may legally enter. */
function mouseOrthogonal(state: GameEngineState, r: number, c: number): RC[] {
  const out: RC[] = [];
  for (const d of DIRECTIONS) {
    const nr = r + d.dr;
    const nc = c + d.dc;
    if (!inBounds(state, nr, nc)) continue;
    if (mouseCanEnter(state, nr, nc)) out.push({ r: nr, c: nc });
  }
  return out;
}

/**
 * Neighbours for MOUSE reachability: orthogonal steps PLUS tunnel teleport
 * edges. From a (usable, butter-allowed) tunnel corner the mouse may teleport
 * to any other usable corner in 1 step — the engine's "stay in place" bug
 * edge is deliberately NOT modelled (matches the Search Simulator).
 */
function mouseNeighbors(state: GameEngineState, r: number, c: number): RC[] {
  const out = mouseOrthogonal(state, r, c);
  if (
    state.board[r][c].type === CellType.Tunnel &&
    isTunnelUsable(state, r, c) &&
    isMouseTunnelEntryAllowed(state)
  ) {
    for (const t of getTunnelCorners(state.config)) {
      if (t.r === r && t.c === c) continue;
      if (!isTunnelUsable(state, t.r, t.c)) continue;
      out.push({ r: t.r, c: t.c });
    }
  }
  return out;
}

/** Orthogonal neighbours the cat may legally enter (no tunnel edges). */
function catNeighbors(state: GameEngineState, r: number, c: number): RC[] {
  const out: RC[] = [];
  for (const d of DIRECTIONS) {
    const nr = r + d.dr;
    const nc = c + d.dc;
    if (!inBounds(state, nr, nc)) continue;
    if (catCanEnter(state, nr, nc)) out.push({ r: nr, c: nc });
  }
  return out;
}

// ---------------------------------------------------------------------------
// BFS kernels
// ---------------------------------------------------------------------------

/** Shortest rule-aware distance from `start` to the NEAREST target (null = unreachable). */
function bfsDistance(
  start: RC,
  targets: RC[],
  neighbors: (r: number, c: number) => RC[],
): number | null {
  if (targets.length === 0) return null;
  const targetSet = new Set(targets.map(key));
  if (targetSet.has(key(start))) return 0;
  const visited = new Set<string>([key(start)]);
  let frontier: RC[] = [start];
  let dist = 0;
  while (frontier.length > 0) {
    dist++;
    const next: RC[] = [];
    for (const cur of frontier) {
      for (const nb of neighbors(cur.r, cur.c)) {
        const k = key(nb);
        if (visited.has(k)) continue;
        if (targetSet.has(k)) return dist;
        visited.add(k);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

/** Full distance map: distance from `start` to every reachable cell. */
function buildDistanceMap(start: RC, neighbors: (r: number, c: number) => RC[]): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(key(start), 0);
  let frontier: RC[] = [start];
  let d = 0;
  while (frontier.length > 0) {
    d++;
    const next: RC[] = [];
    for (const cur of frontier) {
      for (const nb of neighbors(cur.r, cur.c)) {
        const k = key(nb);
        if (dist.has(k)) continue;
        dist.set(k, d);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return dist;
}

/**
 * Multi-source reverse distance map: shortest distance from ANY source to
 * every cell. Used for the carrying-mode hole map: because the carrying graph
 * is undirected (every edge is symmetric; tunnels are not part of it), the
 * distance from a butter cell to the nearest hole cell equals the distance
 * from the hole set to that butter cell. One BFS, not one per butter.
 */
function buildMultiSourceDistanceMap(
  sources: RC[],
  neighbors: (r: number, c: number) => RC[],
): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier: RC[] = [];
  for (const s of sources) {
    const k = key(s);
    if (dist.has(k)) continue;
    dist.set(k, 0);
    frontier.push(s);
  }
  let d = 0;
  while (frontier.length > 0) {
    d++;
    const next: RC[] = [];
    for (const cur of frontier) {
      for (const nb of neighbors(cur.r, cur.c)) {
        const k = key(nb);
        if (dist.has(k)) continue;
        dist.set(k, d);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Diagnostics: BFS counters (metadata only — never affect evaluation).
// ---------------------------------------------------------------------------

let evaluationCallCount = 0;
let mouseBfsCallCount = 0;
let catBfsCallCount = 0;
let carryMouseBfsCallCount = 0;

export function resetEvaluationCalls(): void {
  evaluationCallCount = 0;
  mouseBfsCallCount = 0;
  catBfsCallCount = 0;
  carryMouseBfsCallCount = 0;
}
export function getEvaluationCalls(): number {
  return evaluationCallCount;
}
export function getMouseBfsCalls(): number {
  return mouseBfsCallCount;
}
export function getCatBfsCalls(): number {
  return catBfsCallCount;
}
export function getCarryMouseBfsCalls(): number {
  return carryMouseBfsCallCount;
}

// ---------------------------------------------------------------------------
// EvaluationFeatures — raw, objective, rule-aware facts about the state.
// ---------------------------------------------------------------------------

export interface EvaluationFeatures {
  /** Rule-aware shortest cat→mouse path length (null = unreachable). */
  catMouseDistance: number | null;
  /** Mouse→hole distance in CARRYING mode; meaningful only when carrying. */
  mouseGoalDistance: number | null;
  /** Mouse→nearest-butter distance (non-carrying graph; null = no butter). */
  mouseButterDistance: number | null;
  /**
   * Two-stage mouse win route: carrying → distance to hole; not carrying →
   * min over real butters of (mouse→butter non-carrying + butter→hole
   * carrying). Never predicts future random butters, never reads RNG.
   * null = no complete legal route exists.
   */
  mouseWinRouteDistance: number | null;
  /** Immediate legal mouse steps (orthogonal, tunnel-entry aware). */
  mouseMobility: number;
  /** Immediate legal cat steps (orthogonal). */
  catMobility: number;
  /** Cells the mouse can reach (tunnels counted as teleport edges). */
  mouseReachableArea: number;
  /** Cells the cat can reach. */
  catReachableArea: number;
  /** Tunnel corners NOT blocked by a box. */
  openTunnelCount: number;
  /** Tunnel corners blocked by a box. */
  blockedTunnelCount: number;
  /** Rule-level: may the mouse legally enter a tunnel at all (butter/skill)? */
  mouseTunnelAllowed: boolean;
  /** Rule-aware distance from the mouse to the nearest reachable open tunnel. */
  mouseTunnelAccessDistance: number | null;
  /** How many open tunnel corners lie inside the mouse's reachable region. */
  reachableOpenTunnelCount: number;
  /** The mouse can actually reach at least one open tunnel entrance. */
  mouseCanReachTunnel: boolean;
  mouseHasButter: boolean;
  mouseSkillActive: boolean;
  /** Cat still has a trap in inventory. */
  catHasTrapAvailable: boolean;
  /** A trap is currently placed on the board. */
  trapActive: boolean;
  /** Mouse-side distance to the placed trap (null = no trap / unreachable). */
  mouseTrapDistance: number | null;
  currentPlayer: 'cat' | 'mouse';
  catMovesLeft: number;
  mouseMovesLeft: number;
  /** Number of legal cells adjacent to the mouse hole (shared kernel). */
  holeGateCount: number;
  /** Cat distance to the nearest gate cell (null = unreachable / no gates). */
  catHoleGateDistance: number | null;
  /** Mouse distance to the nearest gate cell (null = unreachable / no gates). */
  mouseHoleGateDistance: number | null;
  /** gate: catDist − mouseDist; + = cat closer to the gates (good for cat). */
  holeControlMargin: number | null;
  /** Voronoi v1: cells the cat reaches strictly sooner. */
  catControlledArea: number;
  /** Voronoi v1: cells the mouse reaches strictly sooner. */
  mouseControlledArea: number;
  /** Voronoi v1: cells both reach in the same number of steps. */
  contestedArea: number;
  /** (catArea − mouseArea) / strategicArea ∈ [-1, 1]. */
  voronoiBalance: number;
}

// ---------------------------------------------------------------------------
// EvaluationContributions — the explainable additive breakdown.
// ---------------------------------------------------------------------------

export interface EvaluationContributions {
  capturePressure: number;
  mouseGoalThreat: number;
  butterRace: number;
  confinement: number;
  mobility: number;
  trapControl: number;
  tunnelControl: number;
  holeControl: number;
  voronoiBalance: number;
  tempo: number;
}

export interface EvaluationBreakdown {
  total: number;
  features: EvaluationFeatures;
  contributions: EvaluationContributions;
  clamped: boolean;
}

// ---------------------------------------------------------------------------
// Centralized weights (spec #11). Every feature is normalized to a stable
// range ([-1,1] / [0,1] or board-size-proportional distance ratios) BEFORE
// multiplication, so 5x5 / 10x10 / 20x20 boards do not drift. The total stays
// far below MATE_SCORE via HEURISTIC_LIMIT.
// ---------------------------------------------------------------------------

export interface EvaluationWeights {
  /** Cat→mouse proximity (per-step, normalized by board size). */
  capturePressure: number;
  /** Win threat when the mouse carries butter near the hole. */
  mouseGoalThreat: number;
  /** Mouse→butter distance when not carrying (per ratio of board size). */
  butterRace: number;
  /** (cat reachable-ratio − mouse reachable-ratio). */
  confinement: number;
  /** (catMobility − mouseMobility) / 4. */
  mobility: number;
  /** Trap near the mouse (normalized proximity). */
  trapControl: number;
  /** Mouse can REACH an open tunnel (inverse access distance). */
  tunnelEscape: number;
  /** Cat guards the hole gates earlier than the mouse. */
  holeControl: number;
  /** Voronoi balance (cat-controlled vs mouse-controlled area). */
  voronoiBalance: number;
  /** Small turn/moves tempo signal. */
  tempo: number;
}

export const DEFAULT_EVALUATION_WEIGHTS: EvaluationWeights = {
  capturePressure: 900,
  mouseGoalThreat: 1100,
  butterRace: 700,
  confinement: 1100,
  mobility: 250,
  trapControl: 600,
  tunnelEscape: 900,
  holeControl: 500,
  voronoiBalance: 600,
  tempo: 200,
};

// ---------------------------------------------------------------------------
// Shared per-call context: one evaluation builds its BFS maps ONCE and reuses
// them across features + Voronoi + contributions (spec #17 — no repeated BFS).
// ---------------------------------------------------------------------------

interface EvaluationContext {
  state: GameEngineState;
  boardSize: number;
  /** Distance from the mouse to every reachable cell (tunnel edges incl.). */
  mouseMap: Map<string, number>;
  /** Distance from the cat to every reachable cell. */
  catMap: Map<string, number>;
  /** Carrying-mode distance from the hole SET to every cell (multi-source). */
  carryHoleMap: Map<string, number>;
  /** Voronoi classification for every strategic cell. */
  voronoi: {
    catControlled: number;
    mouseControlled: number;
    contested: number;
    strategicArea: number;
  };
  gateCells: RC[];
}

function buildContext(state: GameEngineState, needCarry: boolean): EvaluationContext {
  const mouseMap = buildDistanceMap(state.mousePosition, (r, c) => mouseNeighbors(state, r, c));
  mouseBfsCallCount++;
  const catMap = buildDistanceMap(state.catPosition, (r, c) => catNeighbors(state, r, c));
  catBfsCallCount++;
  const carryHoleMap = needCarry
    ? buildMultiSourceDistanceMap(mouseHoleCells(state), (r, c) => mouseOrthogonal(state, r, c))
    : new Map<string, number>();
  if (needCarry) carryMouseBfsCallCount++;

  // Voronoi v1: strategic cells only (empty/butter cells outside hole/tunnel).
  const voronoi = { catControlled: 0, mouseControlled: 0, contested: 0, strategicArea: 0 };
  for (let r = 0; r < state.config.boardSize; r++) {
    for (let c = 0; c < state.config.boardSize; c++) {
      const cell = state.board[r][c];
      if (cell.type === CellType.Tunnel) continue;
      if (isMouseHoleCell(state, r, c)) continue;
      if (cell.type === CellType.Box) continue;
      if (isFixedObstacle(cell.type)) continue;
      if (cell.type === CellType.Void) continue;
      const cd = catMap.get(key({ r, c }));
      const md = mouseMap.get(key({ r, c }));
      if (cd === undefined && md === undefined) continue; // unreachable: ignored
      voronoi.strategicArea++;
      if (cd !== undefined && md === undefined) voronoi.catControlled++;
      else if (md !== undefined && cd === undefined) voronoi.mouseControlled++;
      else if (cd !== undefined && md !== undefined) {
        if (cd < md) voronoi.catControlled++;
        else if (md < cd) voronoi.mouseControlled++;
        else voronoi.contested++;
      }
    }
  }

  const gateCells = getMouseHoleGateCells(state);
  return { state, boardSize: state.config.boardSize, mouseMap, catMap, carryHoleMap, voronoi, gateCells };
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

export function extractEvaluationFeatures(state: GameEngineState): EvaluationFeatures {
  const ctx = buildContext(state, true);
  return featuresFromContext(ctx);
}

function featuresFromContext(ctx: EvaluationContext): EvaluationFeatures {
  const { state, boardSize, mouseMap, catMap, carryHoleMap, voronoi, gateCells } = ctx;

  const catMouseDistance = catMap.get(key(state.mousePosition)) ?? null;

  // Carrying-mode goal distance (mouse position -> nearest hole cell).
  const mouseGoalDistance =
    state.mouseHasButter && carryHoleMap.has(key(state.mousePosition))
      ? carryHoleMap.get(key(state.mousePosition))!
      : null;

  // Butter distances (non-carrying mouse map for the pre-pickup leg).
  let mouseButterDistance: number | null = null;
  if (state.butterPositions.length > 0) {
    for (const b of state.butterPositions) {
      const d = mouseMap.get(key(b));
      if (d !== undefined && (mouseButterDistance === null || d < mouseButterDistance)) {
        mouseButterDistance = d;
      }
    }
  }

  // Two-stage win route.
  let mouseWinRouteDistance: number | null = null;
  if (state.mouseHasButter) {
    mouseWinRouteDistance = mouseGoalDistance;
  } else if (state.butterPositions.length > 0) {
    for (const b of state.butterPositions) {
      const d1 = mouseMap.get(key(b));
      const d2 = carryHoleMap.get(key(b));
      if (d1 === undefined || d2 === undefined) continue;
      const total = d1 + d2;
      if (mouseWinRouteDistance === null || total < mouseWinRouteDistance) {
        mouseWinRouteDistance = total;
      }
    }
  }

  const mouseMobility = mouseOrthogonal(state, state.mousePosition.r, state.mousePosition.c).length;
  const catMobility = catNeighbors(state, state.catPosition.r, state.catPosition.c).length;

  const mouseReachableArea = mouseMap.size;
  const catReachableArea = catMap.size;

  const allTunnels = getTunnelCorners(state.config);
  const openTunnels = getOpenTunnelCorners(state);
  const openTunnelCount = openTunnels.length;
  const blockedTunnelCount = allTunnels.length - openTunnelCount;

  const mouseTunnelAllowed = isMouseTunnelEntryAllowed(state) && openTunnelCount > 0;
  let mouseTunnelAccessDistance: number | null = null;
  let reachableOpenTunnelCount = 0;
  for (const t of openTunnels) {
    const d = mouseMap.get(key(t));
    if (d !== undefined) {
      reachableOpenTunnelCount++;
      if (mouseTunnelAccessDistance === null || d < mouseTunnelAccessDistance) {
        mouseTunnelAccessDistance = d;
      }
    }
  }
  const mouseCanReachTunnel =
    reachableOpenTunnelCount > 0 ||
    (state.board[state.mousePosition.r][state.mousePosition.c].type === CellType.Tunnel &&
      mouseTunnelAllowed);

  // Trap: mouse-side distance; unreachable (outside the mouse's region) = null.
  let mouseTrapDistance: number | null = null;
  if (state.trapPosition) {
    const d = mouseMap.get(key(state.trapPosition));
    mouseTrapDistance = d === undefined ? null : d;
  }

  // Hole control.
  const holeGateCount = gateCells.length;
  let catHoleGateDistance: number | null = null;
  let mouseHoleGateDistance: number | null = null;
  for (const g of gateCells) {
    const cd = catMap.get(key(g));
    const md = mouseMap.get(key(g));
    if (cd !== undefined && (catHoleGateDistance === null || cd < catHoleGateDistance)) {
      catHoleGateDistance = cd;
    }
    if (md !== undefined && (mouseHoleGateDistance === null || md < mouseHoleGateDistance)) {
      mouseHoleGateDistance = md;
    }
  }
  let holeControlMargin: number | null = null;
  if (holeGateCount > 0) {
    if (catHoleGateDistance !== null && mouseHoleGateDistance !== null) {
      holeControlMargin = catHoleGateDistance - mouseHoleGateDistance;
    } else if (catHoleGateDistance !== null) {
      holeControlMargin = boardSize; // cat can, mouse cannot → full cat control
    } else if (mouseHoleGateDistance !== null) {
      holeControlMargin = -boardSize; // mouse can, cat cannot → full mouse control
    }
  }

  const voronoiBalance =
    voronoi.strategicArea > 0
      ? (voronoi.catControlled - voronoi.mouseControlled) / voronoi.strategicArea
      : 0;

  return {
    catMouseDistance,
    mouseGoalDistance,
    mouseButterDistance,
    mouseWinRouteDistance,
    mouseMobility,
    catMobility,
    mouseReachableArea,
    catReachableArea,
    openTunnelCount,
    blockedTunnelCount,
    mouseTunnelAllowed,
    mouseTunnelAccessDistance,
    reachableOpenTunnelCount,
    mouseCanReachTunnel,
    mouseHasButter: state.mouseHasButter,
    mouseSkillActive: state.mouseSkillActive,
    catHasTrapAvailable: state.catTrapsRemaining > 0,
    trapActive: state.trapPosition !== null,
    mouseTrapDistance,
    currentPlayer: state.currentPlayer === PieceType.Cat ? 'cat' : 'mouse',
    catMovesLeft: state.catMovesLeft,
    mouseMovesLeft: state.mouseMovesLeft,
    holeGateCount,
    catHoleGateDistance,
    mouseHoleGateDistance,
    holeControlMargin,
    catControlledArea: voronoi.catControlled,
    mouseControlledArea: voronoi.mouseControlled,
    contestedArea: voronoi.contested,
    voronoiBalance,
  };
}

// ---------------------------------------------------------------------------
// Contribution scoring (normalized features × centralized weights)
// ---------------------------------------------------------------------------

function scoreFeatures(
  f: EvaluationFeatures,
  boardSize: number,
  weights: EvaluationWeights,
  ctx: EvaluationContext,
): EvaluationContributions {
  // capturePressure: negative when the cat is far. (dist / boardSize) ∈ [0,1].
  const capturePressure =
    f.catMouseDistance === null
      ? -weights.capturePressure
      : -((f.catMouseDistance / boardSize) * weights.capturePressure);

  // mouseGoalThreat: the CLOSER the carrying mouse is to the hole, the worse
  // for the cat. Inverse-distance form, board-size independent. A null goal
  // distance (mouse not carrying) is NO threat at all → 0.
  const mouseGoalThreat =
    f.mouseGoalDistance === null
      ? 0
      : f.mouseGoalDistance === 0
        ? -weights.mouseGoalThreat // distance 0 = standing at the hole entry
        : -(weights.mouseGoalThreat / f.mouseGoalDistance);

  // butterRace: mouse farther from butter is better for the cat.
  const butterRace =
    f.mouseButterDistance === null
      ? 0
      : (f.mouseButterDistance / boardSize) * weights.butterRace;

  // confinement: reachable-area ratios ([-1,1]).
  const area = boardSize * boardSize;
  const mouseRatio = f.mouseReachableArea / area;
  const catRatio = f.catReachableArea / area;
  const confinement = (catRatio - mouseRatio) * weights.confinement;

  // mobility: (cat − mouse) / 4 ∈ [-1,1].
  const mobility = ((f.catMobility - f.mouseMobility) / 4) * weights.mobility;

  // trapControl: mouse-side reachable proximity.
  const trapControl =
    f.trapActive && f.mouseTrapDistance !== null
      ? Math.max(0, 1 - f.mouseTrapDistance / boardSize) * weights.trapControl
      : 0;

  // tunnelControl: only a REACHABLE open tunnel penalizes the cat, scaled by
  // proximity. Unreachable / absent tunnels contribute exactly 0 (spec #12:
  // never "fix" unreachable tunnels by zeroing the weight).
  const tunnelControl =
    f.mouseCanReachTunnel && f.mouseTunnelAccessDistance !== null
      ? -(weights.tunnelEscape / Math.max(1, f.mouseTunnelAccessDistance))
      : 0;

  // holeControl: cat guarding the gates earlier than the mouse is good.
  const holeControl =
    f.holeControlMargin === null
      ? 0
      : Math.max(-1, Math.min(1, f.holeControlMargin / boardSize)) * weights.holeControl;

  // voronoiBalance ∈ [-1,1].
  const voronoiContribution = f.voronoiBalance * weights.voronoiBalance;

  // tempo: small, explainable, bounded. It can never flip a clearly dangerous
  // state (weights << forced-terminal scoring, and it is a raw moves-left
  // difference normalized by the base budget).
  const base = Math.max(1, Math.min(ctx.state.config.catBaseMoves, ctx.state.config.mouseBaseMoves));
  let tempo: number;
  if (f.currentPlayer === 'cat') {
    tempo = ((f.catMovesLeft - f.mouseMovesLeft) / base) * weights.tempo;
  } else {
    tempo = -((f.mouseMovesLeft - f.catMovesLeft) / base) * weights.tempo;
  }

  return {
    capturePressure,
    mouseGoalThreat,
    butterRace,
    confinement,
    mobility,
    trapControl,
    tunnelControl,
    holeControl,
    voronoiBalance: voronoiContribution,
    tempo,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function evaluateForCatDetailed(
  state: GameEngineState,
  weights: EvaluationWeights = DEFAULT_EVALUATION_WEIGHTS,
): EvaluationBreakdown {
  evaluationCallCount++;
  const ctx = buildContext(state, true);
  const features = featuresFromContext(ctx);
  const contributions = scoreFeatures(features, ctx.boardSize, weights, ctx);
  let total = 0;
  for (const v of Object.values(contributions)) total += v;
  let clamped = false;
  if (total > HEURISTIC_LIMIT) {
    total = HEURISTIC_LIMIT;
    clamped = true;
  } else if (total < -HEURISTIC_LIMIT) {
    total = -HEURISTIC_LIMIT;
    clamped = true;
  }
  return { total, features, contributions, clamped };
}

/** External evaluator entry point (still not wired into the production search). */
export function evaluateForCat(state: GameEngineState): number {
  return evaluateForCatDetailed(state).total;
}

// Exported kernels (spec #5/#6) — built on the same BFS as the features.
export function buildMouseDistanceMap(state: GameEngineState): Map<string, number> {
  const ctx = buildContext(state, false);
  return ctx.mouseMap;
}
export function buildCatDistanceMap(state: GameEngineState): Map<string, number> {
  const ctx = buildContext(state, false);
  return ctx.catMap;
}
export function bfsMouseDistance(state: GameEngineState, targets: RC[]): number | null {
  return bfsDistance(state.mousePosition, targets, (r, c) => mouseNeighbors(state, r, c));
}
export function bfsCatDistance(state: GameEngineState, targets: RC[]): number | null {
  return bfsDistance(state.catPosition, targets, (r, c) => catNeighbors(state, r, c));
}

// Retain the legacy terminal constants for callers/tests that referenced them;
// they are NOT used inside the heuristic (terminal scoring is the search's job).
export const WIN_SCORE = 1e9;
export const LOSS_SCORE = -1e9;
