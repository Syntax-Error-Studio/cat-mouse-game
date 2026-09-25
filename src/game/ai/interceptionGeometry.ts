/**
 * G0.3R/S — Turn-aware interception geometry (A+B+C cheap subset), forensic-only.
 *
 * NOT wired into production. Reimplements the G0.3R-validated A+B+C geometry:
 *   A. TIME-AWARE INTERCEPT MARGIN  (cat arrival vs mouse route arrival, with
 *      real side-to-move turn windows)
 *   B. ROUTE COVERAGE               (shortest mouse→hole route family,
 *      interceptableRouteRatio, MOUSE_HAS_UNCOVERED_ROUTE)
 *   C. CRITICAL GATE CONTROL        (bottleneck cells, cat gate arrival margin,
 *      axis control)
 *
 * TRIGGER (per G0.3R report §7, the validated minimal trigger):
 *   prefilter: phase==playing ∧ currentPlayer==mouse ∧ mouseHasButter
 *   then     : interceptableRouteRatio == 0 ∧ bestInterceptMargin > 0
 *              (the cat lost the interception race on every route)
 * plus ancillary flags (catOnGateAxis, gateMargin, rawCatToCorridor) that the
 * report verified — used only for diagnostics, the TRIGGER uses the validated
 * version above.
 *
 * IMPORTS: type-only from engine; evaluation's mouseCarryingDistanceToHole.
 * No import of expectiminimax (keeps the module graph acyclic).
 */
import type { GameEngineState } from '../engine';
import { CellType, DIRECTIONS, PieceType } from '../types';
import { mouseCarryingDistanceToHole } from './evaluation';
import { finiteDeadline, type DeadlineContext } from './deadlineContext';

type RC = { r: number; c: number };
const key = (p: RC) => `${p.r},${p.c}`;
const inBounds = (s: GameEngineState, r: number, c: number) => r >= 0 && r < s.config.boardSize && c >= 0 && c < s.config.boardSize;
const isHoleCell = (s: GameEngineState, p: RC) => { const { r, c, size } = s.config.mouseHole; return p.r >= r && p.r < r + size && p.c >= c && p.c < c + size; };
const holeCells = (s: GameEngineState): RC[] => { const { r, c, size } = s.config.mouseHole; const o: RC[] = []; for (let dr = 0; dr < size; dr++) for (let dc = 0; dc < size; dc++) o.push({ r: r + dr, c: c + dc }); return o; };
const isFixed = (t: CellType) => t === CellType.Pile || t === CellType.Wall;

function mouseCarryingNeighbors(s: GameEngineState, p: RC): RC[] {
  const o: RC[] = [];
  for (const d of DIRECTIONS) {
    const nr = p.r + d.dr, nc = p.c + d.dc;
    if (!inBounds(s, nr, nc)) continue;
    const cell = s.board[nr][nc];
    if (cell.type === CellType.Box || isFixed(cell.type) || cell.type === CellType.Void) continue;
    if (cell.type === CellType.Tunnel) continue; // carrying => no tunnel entry
    if (s.catPosition.r === nr && s.catPosition.c === nc) continue;
    o.push({ r: nr, c: nc });
  }
  return o;
}
function catNeighborsSimple(s: GameEngineState, p: RC): RC[] {
  const o: RC[] = [];
  for (const d of DIRECTIONS) {
    const nr = p.r + d.dr, nc = p.c + d.dc;
    if (!inBounds(s, nr, nc)) continue;
    const cell = s.board[nr][nc];
    if (isHoleCell(s, { r: nr, c: nc })) continue;
    if (cell.type === CellType.Tunnel || cell.type === CellType.Box) continue;
    if (isFixed(cell.type) || cell.type === CellType.Void) continue;
    if (cell.hasButter) continue;
    o.push({ r: nr, c: nc });
  }
  return o;
}
function bfs(start: RC, adj: (p: RC) => RC[]): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(key(start), 0);
  const q: RC[] = [start];
  while (q.length > 0) {
    const cur = q.shift()!;
    for (const nb of adj(cur)) {
      const k = key(nb);
      if (dist.has(k)) continue;
      dist.set(k, dist.get(key(cur))! + 1);
      q.push(nb);
    }
  }
  return dist;
}

/** Time-aware arrival in atomic half-turns (G0.3R time model). */
function arrivalTime(s: GameEngineState, actor: 'mouse' | 'cat', steps: number): number | null {
  if (steps === null || steps < 0) return null;
  const isFirst = (actor === 'mouse') === (s.currentPlayer === PieceType.Mouse);
  const mouseLen = s.mouseHasButter ? s.config.mouseCarryingMoves : s.config.mouseBaseMoves;
  const catLen = s.config.catBaseMoves;
  const selfLen = actor === 'mouse' ? mouseLen : catLen;
  const oppLen = actor === 'mouse' ? catLen : mouseLen;
  let t = 0, rem = steps;
  if (isFirst) {
    const firstLen = actor === 'mouse' ? Math.max(0, s.mouseMovesLeft) : Math.max(0, s.catMovesLeft);
    if (rem <= firstLen) return rem;
    t = firstLen; rem -= firstLen;
  } else t = oppLen;
  while (rem > 0) {
    if (rem <= selfLen) return t + rem;
    t += selfLen; rem -= selfLen; t += oppLen;
  }
  return t;
}

export interface InterceptionResult {
  /** prefilter: playing ∧ mouse-to-move ∧ carrying butter */
  prefilter: boolean;
  mouseGoalSteps: number | null;
  routeCount: number;
  bestInterceptMargin: number | null;
  worstInterceptMargin: number | null;
  interceptableRouteCount: number;
  interceptableRouteRatio: number | null;
  mouseHasUncoveredRoute: boolean;
  gateCount: number;
  catGateArrivalMargin: number | null;
  catOnGateAxis: boolean;
  rawCatToCorridor: number | null;
  /** The validated G0.3R trigger. */
  trigger: boolean;
  costUs: number;
  /** TRUE = the shared turn deadline passed mid-computation, so NO geometry field
   *  above is trustworthy. The caller must abort the whole sidecar; a partial
   *  interception may never be scored, ordered by, or used as a proof. */
  incompleteDeadline: boolean;
}

/**
 * @param deadline the shared turn deadline, or `NO_DEADLINE`/absent for the legacy
 *                 path. `finiteDeadline()` resolves the latter two to `null`, so an
 *                 unbounded turn performs ZERO total-deadline clock reads here — the
 *                 whole module runs as it always did, and `incompleteDeadline` can
 *                 only ever be set on a FINITE_ABSOLUTE turn.
 */
export function computeInterception(
  state: GameEngineState,
  deadline?: DeadlineContext,
): InterceptionResult {
  const dl = finiteDeadline(deadline);
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const prefilter =
    state.phase === 'playing' && state.currentPlayer === PieceType.Mouse && state.mouseHasButter;
  const empty: InterceptionResult = {
    prefilter, mouseGoalSteps: null, routeCount: 0, bestInterceptMargin: null,
    worstInterceptMargin: null, interceptableRouteCount: 0, interceptableRouteRatio: null,
    mouseHasUncoveredRoute: false, gateCount: 0, catGateArrivalMargin: null,
    catOnGateAxis: false, rawCatToCorridor: null, trigger: false, costUs: 0,
    incompleteDeadline: false,
  };
  // The abort value is 'empty' — no margins, no routes, trigger=false — never a
  // half-computed geometry that could read back as a completed negative.
  const geoAbort = (): InterceptionResult => {
    const abortNow = typeof performance !== 'undefined' ? performance.now() : 0;
    return { ...empty, costUs: abortNow - t0, incompleteDeadline: true };
  };
  if (!prefilter) return empty;

  const goal = mouseCarryingDistanceToHole(state);
  if (goal === null) return empty;

  // multi-source hole distance (carrying graph)
  const d2hole = new Map<string, number>();
  {
    const src = holeCells(state);
    let frontier: RC[] = [];
    for (const h of src) { d2hole.set(key(h), 0); frontier.push(h); }
    let d = 0;
    while (frontier.length > 0) {
      if (dl !== null && dl.expired()) return geoAbort(); // per BFS layer
      d++;
      const next: RC[] = [];
      for (const cur of frontier) {
        for (const nb of mouseCarryingNeighbors(state, cur)) {
          const k = key(nb);
          if (d2hole.has(k)) continue;
          d2hole.set(k, d);
          next.push(nb);
        }
      }
      frontier = next;
    }
  }

  // enumerate the shortest route family (cap 2000)
  const routes: RC[][] = [];
  const targetSet = new Set(holeCells(state).map(key));
  {
    interface Q { p: RC; d: number; path: RC[] }
    const q: Q[] = [{ p: state.mousePosition, d: 0, path: [state.mousePosition] }];
    const seen = new Set<string>();
    while (q.length > 0 && routes.length < 2000) {
      // The route family is this module's worst-case synchronous region: the cap
      // bounds the OUTPUT, while the queue holds path copies with no per-cell
      // dedup, so queue length — not the cap — bounds the work. This pop is where
      // the turn deadline must be sampled.
      if (dl !== null && dl.expired()) return geoAbort();
      const { p, d, path } = q.shift()!;
      for (const nb of mouseCarryingNeighbors(state, p)) {
        const nd = d + 1;
        if (nd > goal) continue;
        if (d2hole.get(key(nb)) !== goal - nd) continue;
        const k = key(nb);
        if (targetSet.has(k)) {
          if (!seen.has(k + '|' + path.length)) { seen.add(k + '|' + path.length); routes.push([...path, nb]); }
          continue;
        }
        q.push({ p: nb, d: nd, path: [...path, nb] });
      }
    }
  }

  // cat simple BFS (full enough for margins)
  const cdist = bfs(state.catPosition, p => catNeighborsSimple(state, p));
  const mdist = bfs(state.mousePosition, p => mouseCarryingNeighbors(state, p));

  // per-cell margins across the route family
  let best = Infinity, worst = -Infinity;
  const cellInfo = new Map<string, { catArr: number | null; mouseArr: number | null }>();
  for (const route of routes) {
    if (dl !== null && dl.expired()) return geoAbort(); // per route, not per cell
    for (const cell of route) {
      const k = key(cell);
      if (cellInfo.has(k)) continue;
      const cd = cdist.get(k);
      const md = mdist.get(k);
      const catArr = cd === undefined ? null : arrivalTime(state, 'cat', cd);
      const mouseArr = md === undefined ? null : arrivalTime(state, 'mouse', md);
      cellInfo.set(k, { catArr, mouseArr });
      if (catArr !== null && mouseArr !== null) {
        const m = catArr - mouseArr;
        if (m < best) best = m;
        if (m > worst) worst = m;
      }
    }
  }

  // per-route interceptability
  let interceptable = 0, uncovered = 0;
  for (const route of routes) {
    if (dl !== null && dl.expired()) return geoAbort(); // per route
    let hit = false;
    for (const cell of route) {
      const info = cellInfo.get(key(cell));
      if (!info || info.catArr === null || info.mouseArr === null) continue;
      if (info.catArr < info.mouseArr) { hit = true; break; }
    }
    if (hit) interceptable++; else uncovered++;
  }

  // critical gates (cells on every route)
  const freq = new Map<string, number>();
  for (const route of routes) {
    if (dl !== null && dl.expired()) return geoAbort(); // per route
    const seen = new Set<string>();
    for (const c of route) { const k = key(c); if (!seen.has(k)) { seen.add(k); freq.set(k, (freq.get(k) ?? 0) + 1); } }
  }
  let gateCount = 0, gateMargin = Infinity;
  const gates: string[] = [];
  for (const [k, f] of freq) {
    if (dl !== null && dl.expired()) return geoAbort(); // gate scan
    if (f === routes.length && routes.length > 0) {
      gateCount++;
      gates.push(k);
      const info = cellInfo.get(k);
      if (info && info.catArr !== null && info.mouseArr !== null) gateMargin = Math.min(gateMargin, info.catArr - info.mouseArr);
    }
  }
  const catOnGateAxis = gates.some(g => {
    const [r, c] = g.split(',').map(Number);
    return state.catPosition.r === r || state.catPosition.c === c;
  });

  let rawCatToCorridor: number | null = null;
  if (routes.length > 0) {
    let bd: number | null = null;
    for (const c of routes[0]) {
      const d = cdist.get(key(c));
      if (d !== undefined && (bd === null || d < bd)) bd = d;
    }
    rawCatToCorridor = bd;
  }

  const trigger =
    routes.length > 0 && interceptable === 0 && best !== Infinity && best > 0;

  return {
    prefilter,
    mouseGoalSteps: goal,
    routeCount: routes.length,
    bestInterceptMargin: best === Infinity ? null : best,
    worstInterceptMargin: worst === -Infinity ? null : worst,
    interceptableRouteCount: interceptable,
    interceptableRouteRatio: routes.length > 0 ? interceptable / routes.length : null,
    mouseHasUncoveredRoute: uncovered > 0,
    gateCount,
    catGateArrivalMargin: gateMargin === Infinity ? null : gateMargin,
    catOnGateAxis,
    rawCatToCorridor,
    trigger,
    costUs: (typeof performance !== 'undefined' ? performance.now() : 0) - t0,
    incompleteDeadline: false,
  };
}