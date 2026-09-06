/**
 * ============================================================================
 * G0.3W — Bounded Plan Refutation (formal production-trial module).
 *
 * FEATURE-FLAGGED PRODUCTION TRIAL. Default OFF. When OFF the Hard planner is
 * bit-identical to the pre-trial behavior. This module is NEVER imported by
 * `expectiminimax.ts` and does NOT change primary search mathematics.
 *
 * RESPONSIBILITIES (spec §1):
 *   - enumerate candidate cat plans (frozen G0.3U selector, MAX 6)
 *   - cheap candidate selection (frozen G0.3U policy, MAX 6)
 *   - bounded mouse adversarial refutation probe (frozen G0.3V:
 *     MAX_MOUSE_PATHS=32, MAX_CPU_PER_CANDIDATE=20ms, MAX_EXACT_LOCAL=16,
 *     win-threat gate, validated critical intercept)
 *   - legal refutation witness (mouse atomic actions, exact replay gate §8)
 *   - conservative override decision (§5, frozen G0.3V comparator)
 *
 * PROBE STATUS (§3): PLAN_REFUTED | NO_REFUTATION_FOUND | CHANCE_MIXED |
 * INCOMPLETE. One-sided semantics (§4): PLAN_REFUTED = strong positive
 * evidence; NO_REFUTATION_FOUND / INCOMPLETE = UNKNOWN — NEVER named safe /
 * escape / good / notForced / catWin anywhere.
 *
 * DEPENDENCY RULE: this module imports NO engine-function at runtime (engine is
 * type-only). It receives the `RuleSet` from the caller (hardTurnPlanner /
 * engine's createEngineRuleSet), exactly like expectiminimax. It never imports
 * `ai/searchRules.ts` (whose top-level defaultRuleSet would touch engine
 * exports at init and form a cycle once engine imports the planner).
 *
 *   engine.ts ──> ai/hardTurnPlanner ──> ai/boundedPlanRefutation
 *   ai/*       ──(type-only)──> engine
 * ============================================================================
 */
import type { GameEngineState } from '../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType } from '../types';
import type { RuleSet, SearchAction } from './searchTypes';
import { enumerateFullTurnLegacy } from './turnBoundary';
import { computeInterception, type InterceptionResult } from './interceptionGeometry';
import { generateLegalSearchActions } from './legalActions';
import { simulateSearchAction } from './simulator';
import { stateKey } from './transposition';
import { mouseCarryingDistanceToHole } from './evaluation';

// ---------------------------------------------------------------------------
// G0.3V FROZEN parameters (§16 / G0.3W §23: MUST NOT be tuned per root)
// ---------------------------------------------------------------------------
export const FIXED_PATHS = 32;
export const FIXED_CPU_MS = 20;
export const FIXED_EXACT = 16;
export const MAX_TACTICAL_CANDIDATES = 6;
export const MAX_FRONTIER = 256;

// ---------------------------------------------------------------------------
// Public statuses (one-sided semantics — never SAFE/ESCAPE)
// ---------------------------------------------------------------------------
export type ProbeStatus =
  | 'PLAN_REFUTED'       // full legal mouse witness found (strong positive)
  | 'NO_REFUTATION_FOUND' // bounded contract completed, no guaranteed refutation
  | 'CHANCE_MIXED'       // reached a chance node not robustly refuting (never a refutation)
  | 'INCOMPLETE';        // outer deadline / abort cut the probe before contract

export type SidecarAbortReason =
  | 'none'
  | 'deadline'
  | 'invalid_witness'
  | 'invalid_candidate'
  | 'no_clean_candidate'
  | 'baseline_not_refuted'
  | 'mate_bypass'
  | 'disabled'
  | 'no_candidates';

// ---------------------------------------------------------------------------
// Candidate (frozen G0.3U shape)
// ---------------------------------------------------------------------------
export interface PlanCandidate {
  planWitness: SearchAction[];
  planLabel: string;
  mouseRoot: GameEngineState;
  semKey: string;
  cheap: InterceptionResult;
  firstAction: string;
  rankHint: string;
}

export interface BoundedRefutationProbeResult {
  status: ProbeStatus;
  /** true iff PLAN_REFUTED with a full legal witness. */
  refuted: boolean;
  witness: SearchAction[];
  witnessType: 'A' | 'B' | 'TERMINAL_WIN' | null;
  boundaryReached: GameEngineState | null;
  pathsVisited: number;
  distinctBoundaries: number;
  exactLocalChecks: number;
  l1Checked: number;
  rejectedBeforeExact: number;
  respondedCount: number;
  threatVisited: number;
  chanceMixed: boolean;
  cpuMs: number;
  /** TRUE = the probe hit an OUTER deadline (INCOMPLETE), never a normal negative. */
  incomplete: boolean;
  /** TRUE = internal path/CPU/exact caps cut the search (still a completed
   *  bounded contract → NO_REFUTATION_FOUND, unless an outer deadline fired). */
  budgetCut: boolean;
  pathRank: number | null;
  dangerOrderHit: boolean;
  /** Set when a witness failed the exact replay legality gate (§8). */
  invalidWitness: boolean;
}

interface ProbeBudget {
  maxPaths: number;
  maxCpuMs: number;
  maxExact: number;
  start: number;
  externalDeadlineMs: number | null;
  now: () => number;
  pathsUsed: number;
  exactChecks: number;
  l1Checks: number;
  rejected: number;
  respondedCount: number;
  threatVisited: number;
  internalCut: boolean;
  externalHit: boolean;
}

// ---------------------------------------------------------------------------
// Short tokens (recall labels / diagnostics; never a decision input)
// ---------------------------------------------------------------------------
function shortOf(a: { type: string; direction?: { key: string } }): string {
  if (a.type === 'catStep' || a.type === 'mouseStep') {
    const k = a.direction!.key;
    return k.slice(5)[0] ?? k;
  }
  if (a.type === 'catPlaceTrap') return 'PT';
  if (a.type === 'mouseSkill') return 'SK';
  if (a.type === 'chooseTunnel') return 'TU';
  return '?';
}

// ---------------------------------------------------------------------------
// Candidate selector — IDENTICAL to G0.3U / G0.3V (frozen, MAX 6)
// ---------------------------------------------------------------------------
function cheapRank(g: InterceptionResult): number {
  const r = g.interceptableRouteRatio ?? -1;
  const m = g.bestInterceptMargin ?? 999;
  const c = g.rawCatToCorridor ?? 999;
  return (-r) * 1e6 + m * 1e3 + c;
}

export function selectCandidates(
  root: GameEngineState,
  baselinePlan: SearchAction[],
  rules: RuleSet,
): PlanCandidate[] {
  const leg = enumerateFullTurnLegacy(root, rules);
  let baselineRoot: GameEngineState | null = null;
  let baselineCost = 0;
  {
    let cur = root;
    for (const a of baselinePlan) {
      const tr = simulateSearchAction(cur, a, rules);
      if (tr.kind !== 'deterministic') break;
      baselineCost += a.type === 'catStep' || a.type === 'mouseStep' ? 1 : 0;
      cur = tr.state;
      if (cur.currentPlayer !== PieceType.Cat || cur.phase !== GamePhase.Playing) break;
    }
    if (cur.currentPlayer === PieceType.Mouse && cur.phase === GamePhase.Playing) baselineRoot = cur;
  }

  const byRoot = new Map<string, { state: GameEngineState; cost: number; plans: { witness: SearchAction[]; first: string; label: string }[] }>();
  for (const b of leg.boundaries) {
    const sk = `${b.standardKey}\x00${b.cumulativeCost}`;
    const first = b.witness.length > 0 ? shortActionKey(b.witness[0]) : '?';
    const rec = byRoot.get(sk);
    const witness = b.witness;
    const label = witness.map(shortOf).join('');
    if (!rec) byRoot.set(sk, { state: b.state, cost: b.cumulativeCost, plans: [{ witness, first, label }] });
    else if (rec.plans.length < 2) rec.plans.push({ witness, first, label });
  }

  const geoOf = new Map<string, InterceptionResult>();
  for (const [sk, rec] of byRoot) geoOf.set(sk, computeInterception(rec.state));

  const candidates: PlanCandidate[] = [];
  const seen = new Set<string>();
  const push = (sk: string, rankHint: string, planIdx: number) => {
    if (seen.has(sk)) return;
    const rec = byRoot.get(sk)!;
    if (planIdx >= rec.plans.length) return;
    seen.add(sk);
    candidates.push({
      planWitness: rec.plans[planIdx].witness,
      planLabel: rec.plans[planIdx].label,
      mouseRoot: rec.state,
      semKey: sk,
      cheap: geoOf.get(sk)!,
      firstAction: rec.plans[planIdx].first,
      rankHint,
    });
  };

  if (baselineRoot) {
    const sk = `${stateKey(baselineRoot)}\x00${baselineCost}`;
    if (byRoot.has(sk)) push(sk, 'A-baseline', 0);
    else {
      const sorted = [...byRoot.keys()].sort((a, b) => cheapRank(geoOf.get(a)!) - cheapRank(geoOf.get(b)!));
      if (sorted.length > 0) push(sorted[0], 'A-baseline(fallback)', 0);
    }
  } else {
    const sorted = [...byRoot.keys()].sort((a, b) => cheapRank(geoOf.get(a)!) - cheapRank(geoOf.get(b)!));
    if (sorted.length > 0) push(sorted[0], 'A-baseline(no-root)', 0);
  }

  const firstBest = new Map<string, string>();
  for (const [sk, rec] of byRoot) {
    const f = rec.plans[0].first;
    const cur = firstBest.get(f);
    if (cur === undefined || cheapRank(geoOf.get(sk)!) < cheapRank(geoOf.get(cur)!)) firstBest.set(f, sk);
  }
  for (const [f, sk] of firstBest) {
    if (candidates.length >= MAX_TACTICAL_CANDIDATES) break;
    push(sk, `B-first:${f}`, 0);
  }

  const sortedRoots = [...byRoot.keys()].sort((a, b) => cheapRank(geoOf.get(a)!) - cheapRank(geoOf.get(b)!));
  let cAdded = 0;
  for (const sk of sortedRoots) {
    if (candidates.length >= MAX_TACTICAL_CANDIDATES) break;
    if (seen.has(sk)) continue;
    push(sk, `C-global:${cAdded + 1}`, 0);
    cAdded++;
  }

  return candidates.slice(0, MAX_TACTICAL_CANDIDATES);
}

function shortActionKey(a: { type: string; direction?: { key: string } }): string {
  return shortOf(a);
}

// ---------------------------------------------------------------------------
// L1 cheap pre-score
// ---------------------------------------------------------------------------
function l1Score(st: GameEngineState): { danger: number; sufficientResponded: boolean } {
  const cdist = new Map<string, number>();
  cdist.set(`${st.catPosition.r},${st.catPosition.c}`, 0);
  const cq: { r: number; c: number }[] = [{ r: st.catPosition.r, c: st.catPosition.c }];
  const mouseK = `${st.mousePosition.r},${st.mousePosition.c}`;
  let catToMouse = Infinity;
  while (cq.length > 0) {
    const cur = cq.shift()!;
    const curD = cdist.get(`${cur.r},${cur.c}`)!;
    if (curD >= 4) continue;
    for (const d of DIRECTIONS) {
      const nr = cur.r + d.dr, nc = cur.c + d.dc;
      if (nr < 0 || nr >= st.config.boardSize || nc < 0 || nc >= st.config.boardSize) continue;
      const cell = st.board[nr][nc];
      if (cell.type === CellType.Box || cell.type === CellType.Pile || cell.type === CellType.Wall || cell.type === CellType.Void) continue;
      if (cell.type === CellType.Tunnel) continue;
      const k = `${nr},${nc}`;
      if (cdist.has(k)) continue;
      cdist.set(k, curD + 1);
      if (k === mouseK) { catToMouse = curD + 1; break; }
      cq.push({ r: nr, c: nc });
    }
  }
  const goalD = mouseCarryingDistanceToHole(st);
  let danger = 0;
  if (goalD !== null) danger += (30 - goalD) * 1000;
  else {
    const md = bfsMouse(st);
    let bd = Infinity;
    for (const b of st.butterPositions) {
      const d = md.get(`${b.r},${b.c}`);
      if (d !== undefined && d < bd) bd = d;
    }
    danger += bd === Infinity ? 0 : (30 - bd) * 300;
  }
  danger += Math.max(0, 10 - catToMouse) * 50;
  const sufficientResponded = catToMouse <= 4;
  return { danger, sufficientResponded };
}

function bfsMouse(st: GameEngineState): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(`${st.mousePosition.r},${st.mousePosition.c}`, 0);
  const q: { r: number; c: number }[] = [{ r: st.mousePosition.r, c: st.mousePosition.c }];
  while (q.length > 0) {
    const cur = q.shift()!;
    for (const d of DIRECTIONS) {
      const nr = cur.r + d.dr, nc = cur.c + d.dc;
      if (nr < 0 || nr >= st.config.boardSize || nc < 0 || nc >= st.config.boardSize) continue;
      const cell = st.board[nr][nc];
      if (cell.type === CellType.Box || cell.type === CellType.Pile || cell.type === CellType.Wall || cell.type === CellType.Void) continue;
      if (cell.type === CellType.Tunnel) continue;
      if (st.catPosition.r === nr && st.catPosition.c === nc) continue;
      const k = `${nr},${nc}`;
      if (dist.has(k)) continue;
      dist.set(k, dist.get(`${cur.r},${cur.c}`)! + 1);
      q.push({ r: nr, c: nc });
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// L2 EXACT_LOCAL validated critical intercept (G0.3V §6)
// ---------------------------------------------------------------------------
function d2holeMap(st: GameEngineState): Map<string, number> {
  const { r, c, size } = st.config.mouseHole;
  const dist = new Map<string, number>();
  const q: { r: number; c: number }[] = [];
  for (let dr = 0; dr < size; dr++) for (let dc = 0; dc < size; dc++) {
    const k = `${r + dr},${c + dc}`;
    dist.set(k, 0);
    q.push({ r: r + dr, c: c + dc });
  }
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const curD = dist.get(`${cur.r},${cur.c}`)!;
    for (const d of DIRECTIONS) {
      const nr = cur.r + d.dr, nc = cur.c + d.dc;
      if (nr < 0 || nr >= st.config.boardSize || nc < 0 || nc >= st.config.boardSize) continue;
      const cell = st.board[nr][nc];
      if (cell.type === CellType.Box || cell.type === CellType.Pile || cell.type === CellType.Wall || cell.type === CellType.Void) continue;
      if (cell.type === CellType.Tunnel) continue;
      const k = `${nr},${nc}`;
      if (dist.has(k)) continue;
      dist.set(k, curD + 1);
      q.push({ r: nr, c: nc });
    }
  }
  return dist;
}

function arrivalTime(st: GameEngineState, actor: 'mouse' | 'cat', steps: number): number | null {
  if (steps === null || steps < 0) return null;
  const isFirst = (actor === 'mouse') === (st.currentPlayer === PieceType.Mouse);
  const mouseLen = st.mouseHasButter ? st.config.mouseCarryingMoves : st.config.mouseBaseMoves;
  const catLen = st.config.catBaseMoves;
  const selfLen = actor === 'mouse' ? mouseLen : catLen;
  const oppLen = actor === 'mouse' ? catLen : mouseLen;
  let t = 0, rem = steps;
  if (isFirst) {
    const firstLen = actor === 'mouse' ? Math.max(0, st.mouseMovesLeft) : Math.max(0, st.catMovesLeft);
    if (rem <= firstLen) return rem;
    t = firstLen; rem -= firstLen;
  } else t = oppLen;
  while (rem > 0) {
    if (rem <= selfLen) return t + rem;
    t += selfLen; rem -= selfLen; t += oppLen;
  }
  return t;
}

function catExactReachWithin4(st: GameEngineState, rules: RuleSet): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(`${st.catPosition.r},${st.catPosition.c}`, 0);
  const q: { s: GameEngineState; d: number }[] = [{ s: st, d: 0 }];
  while (q.length > 0) {
    const { s, d } = q.shift()!;
    if (d >= 4) continue;
    for (const a of generateLegalSearchActions(s, rules).filter(a => a.type === 'catStep' || a.type === 'catPlaceTrap')) {
      const tr = simulateSearchAction(s, a, rules);
      if (tr.kind !== 'deterministic') continue;
      const p = tr.state.catPosition;
      const k = `${p.r},${p.c}`;
      if (dist.has(k)) continue;
      dist.set(k, d + 1);
      q.push({ s: tr.state, d: d + 1 });
    }
  }
  return dist;
}

export function catCaptureOrInterceptWithin4(st: GameEngineState, rules: RuleSet): boolean {
  const reach = catExactReachWithin4(st, rules);
  const mouseK = `${st.mousePosition.r},${st.mousePosition.c}`;
  if (reach.has(mouseK)) return true;
  const goal = mouseCarryingDistanceToHole(st);
  if (goal === null) return false;
  const d2h = d2holeMap(st);
  const mdist = bfsMouse(st);
  for (const [k, cd] of reach) {
    const d2 = d2h.get(k);
    const mdv = mdist.get(k);
    if (d2 === undefined || mdv === undefined) continue;
    if (d2 >= goal) continue;
    if (mdv !== goal - d2) continue;
    const catArr = arrivalTime(st, 'cat', cd);
    const mouseArr = arrivalTime(st, 'mouse', mdv);
    if (catArr !== null && mouseArr !== null && catArr <= mouseArr) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mouse continuation danger ordering (G0.3V §5 — frozen, no per-root hack)
// ---------------------------------------------------------------------------
function mouseDanger(st: GameEngineState): number {
  if (st.mouseHasButter) {
    const g = computeInterception(st);
    const goalD = g.mouseGoalSteps ?? mouseCarryingDistanceToHole(st) ?? 99;
    const margin = g.bestInterceptMargin ?? 0;
    const unc = g.mouseHasUncoveredRoute ? 50 : 0;
    return (99 - goalD) * 1000 + margin * 20 + unc;
  }
  const md = bfsMouse(st);
  let bd = Infinity;
  for (const b of st.butterPositions) {
    const d = md.get(`${b.r},${b.c}`);
    if (d !== undefined && d < bd) bd = d;
  }
  return bd === Infinity ? -10_000 : (99 - bd) * 10 - 100_000;
}

// ---------------------------------------------------------------------------
// Bounded adversarial mouse-response probe (G0.3V §4 frozen)
// ---------------------------------------------------------------------------
export interface ProbeOpts {
  maxPaths?: number;
  maxCpuMs?: number;
  maxExact?: number;
  /** Outer total-turn deadline (absolute ms in `now` time-base). When it fires,
   *  the probe returns INCOMPLETE (never a completed negative). */
  externalDeadlineMs?: number;
  now?: () => number;
}

export function runBoundedProbe(
  mouseRoot: GameEngineState,
  rules: RuleSet,
  opts: ProbeOpts = {},
): BoundedRefutationProbeResult {
  const maxPaths = opts.maxPaths ?? FIXED_PATHS;
  const maxCpuMs = opts.maxCpuMs ?? FIXED_CPU_MS;
  const maxExact = opts.maxExact ?? FIXED_EXACT;
  const now = opts.now ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
  const budget: ProbeBudget = {
    maxPaths, maxCpuMs, maxExact, start: now(),
    externalDeadlineMs: opts.externalDeadlineMs ?? null, now,
    pathsUsed: 0, exactChecks: 0, l1Checks: 0, rejected: 0,
    respondedCount: 0, threatVisited: 0, internalCut: false, externalHit: false,
  };

  interface Partial {
    state: GameEngineState;
    actions: SearchAction[];
    danger: number;
    hasChance: boolean;
  }
  let frontier: Partial[] = [{ state: mouseRoot, actions: [], danger: mouseDanger(mouseRoot), hasChance: false }];
  let expansions = 0;
  const visitedBoundaries = new Set<string>();
  const expandedStates = new Set<string>();
  let bestWitness: SearchAction[] | null = null;
  let bestBoundary: GameEngineState | null = null;
  let bestType: 'A' | 'B' | 'TERMINAL_WIN' | null = null;
  let bestPathRank: number | null = null;

  const externalDeadlineHit = (): boolean =>
    budget.externalDeadlineMs !== null && budget.now() >= budget.externalDeadlineMs;
  const maybeCut = (): boolean => {
    if (budget.internalCut) return true;
    if (++expansions % 16 === 0 && budget.now() - budget.start > budget.maxCpuMs) budget.internalCut = true;
    return budget.internalCut;
  };
  const pathCapHit = (): boolean => budget.pathsUsed >= budget.maxPaths;

  const evaluateBoundary = (st: GameEngineState): 'UNANSWERABLE' | 'RESPONDED' | 'UNKNOWN' => {
    budget.l1Checks++;
    const l1 = l1Score(st);
    if (l1.sufficientResponded) {
      budget.rejected++;
      budget.respondedCount++;
      return 'RESPONDED';
    }
    const goalD = mouseCarryingDistanceToHole(st);
    const goalThreat = st.mouseHasButter && goalD !== null && goalD <= st.config.mouseCarryingMoves;
    if (!goalThreat) {
      budget.rejected++;
      budget.respondedCount++;
      return 'RESPONDED';
    }
    budget.threatVisited++;
    if (budget.exactChecks >= budget.maxExact) return 'UNKNOWN';
    budget.exactChecks++;
    const ok = catCaptureOrInterceptWithin4(st, rules);
    if (ok) budget.respondedCount++;
    return ok ? 'RESPONDED' : 'UNANSWERABLE';
  };

  while (frontier.length > 0 && !budget.internalCut && !pathCapHit()) {
    if (externalDeadlineHit()) { budget.externalHit = true; budget.internalCut = true; break; }
    if (budget.now() - budget.start > budget.maxCpuMs) { budget.internalCut = true; break; }
    const cur = frontier.shift()!;
    const st = cur.state;

    if (st.phase === GamePhase.MouseWins) {
      budget.pathsUsed++;
      if (!bestWitness) {
        bestWitness = cur.actions;
        bestBoundary = st;
        // A terminal mouse win reached behind a CHANCE node is NOT a guaranteed
        // refutation (chance = AND over ALL positive-prob outcomes; the
        // single-witness model cannot verify every respawn still wins). It is
        // treated exactly like a chance-bearing boundary leaf → CHANCE_MIXED.
        bestType = cur.hasChance ? 'B' : 'TERMINAL_WIN';
        bestPathRank = budget.pathsUsed;
      }
      break;
    }
    if (st.phase === GamePhase.CatWins) {
      budget.pathsUsed++;
      continue;
    }
    if (st.currentPlayer === PieceType.Cat) {
      budget.pathsUsed++;
      visitedBoundaries.add(stateKey(st));
      const v = evaluateBoundary(st);
      if (v === 'UNANSWERABLE') {
        bestWitness = cur.actions;
        bestBoundary = st;
        bestType = cur.hasChance ? 'B' : 'A';
        bestPathRank = budget.pathsUsed;
        break;
      }
      if (v === 'UNKNOWN') { budget.internalCut = true; break; }
      continue;
    }
    if (st.currentPlayer === PieceType.Mouse) {
      if (maybeCut()) break;
      const sk = stateKey(st);
      if (expandedStates.has(sk)) continue;
      expandedStates.add(sk);
      const actions = generateLegalSearchActions(st, rules);
      if (actions.length === 0) { budget.pathsUsed++; continue; }
      const expanded: Partial[] = [];
      for (const a of actions) {
        const tr = simulateSearchAction(st, a, rules);
        if (tr.kind === 'chance') {
          for (const o of tr.outcomes) {
            expanded.push({ state: o.state, actions: [...cur.actions, a], danger: mouseDanger(o.state), hasChance: true });
          }
        } else {
          expanded.push({ state: tr.state, actions: [...cur.actions, a], danger: mouseDanger(tr.state), hasChance: cur.hasChance });
        }
      }
      frontier = frontier.concat(expanded).sort((a, b) => b.danger - a.danger).slice(0, MAX_FRONTIER);
    }
  }

  const cpuMs = now() - budget.start;
  const externalHit = budget.externalHit;
  const internalCut = budget.internalCut || pathCapHit();

  let status: ProbeStatus;
  let refuted = false;
  let chanceMixed = false;
  if (externalHit) {
    // Outer total-turn deadline fired: INCOMPLETE (never a completed negative).
    status = 'INCOMPLETE';
  } else if (bestWitness && (bestType === 'A' || bestType === 'TERMINAL_WIN')) {
    refuted = true;
    status = 'PLAN_REFUTED';
  } else if (bestWitness && bestType === 'B') {
    chanceMixed = true;
    status = 'CHANCE_MIXED';
  } else {
    // Bounded contract completed (path/CPU/exact caps reached) without a
    // guaranteed refutation → honest completed negative.
    status = 'NO_REFUTATION_FOUND';
  }

  return {
    status,
    refuted,
    witness: refuted ? (bestWitness ?? []) : [],
    witnessType: refuted ? bestType : null,
    boundaryReached: refuted ? bestBoundary : null,
    pathsVisited: budget.pathsUsed,
    distinctBoundaries: visitedBoundaries.size,
    exactLocalChecks: budget.exactChecks,
    l1Checked: budget.l1Checks,
    rejectedBeforeExact: budget.rejected,
    respondedCount: budget.respondedCount,
    threatVisited: budget.threatVisited,
    chanceMixed,
    cpuMs,
    incomplete: externalHit,
    budgetCut: internalCut,
    pathRank: refuted ? bestPathRank : null,
    dangerOrderHit: refuted && bestPathRank !== null ? bestPathRank <= 16 : false,
    invalidWitness: false,
  };
}

// ---------------------------------------------------------------------------
// Witness replay legality gate (§8): every production PLAN_REFUTED must be
// replayable through exact rules — mouse atomic actions all legal, movesLeft
// correct, skill consumes butter, tunnel semantics, trap trigger, chance
// provenance, resulting boundary correct.
// ---------------------------------------------------------------------------
export function replayMouseWitness(
  mouseRoot: GameEngineState,
  witness: SearchAction[],
  rules: RuleSet,
  expectedBoundary?: GameEngineState | null,
): { valid: boolean; reason: string; finalState: GameEngineState | null } {
  if (witness.length === 0) return { valid: false, reason: 'empty_witness', finalState: null };
  let cur = mouseRoot;
  for (let i = 0; i < witness.length; i++) {
    const a = witness[i];
    const legal = generateLegalSearchActions(cur, rules);
    // exact structural match against the legal action set
    const exact = legal.some(l => {
      if (l.type !== a.type) return false;
      if (l.type === 'mouseStep' || l.type === 'catStep') {
        const d = (a as { direction?: { key: string } }).direction;
        return d !== undefined && l.direction!.key === d.key;
      }
      if (l.type === 'chooseTunnel') {
        const aa = a as { r: number; c: number };
        return l.r === aa.r && l.c === aa.c;
      }
      return true; // catPlaceTrap / mouseSkill
    });
    if (!exact) return { valid: false, reason: `illegal_action@${i}:${shortOf(a)}`, finalState: null };
    // A mouse refutation witness must be deterministic (type A / TERMINAL_WIN);
    // a chance-bearing witness is CHANCE_MIXED and never reaches this gate.
    const tr = simulateSearchAction(cur, a, rules);
    if (tr.kind === 'chance') return { valid: false, reason: `chance_in_witness@${i}`, finalState: null };
    cur = tr.state;
  }
  // resulting boundary: cat to move (or mouse terminal win)
  const okEnd =
    cur.phase === GamePhase.MouseWins ||
    (cur.phase === GamePhase.Playing && cur.currentPlayer === PieceType.Cat);
  if (!okEnd) return { valid: false, reason: 'witness_end_not_boundary', finalState: cur };
  if (expectedBoundary) {
    const ek = stateKey(expectedBoundary);
    const fk = stateKey(cur);
    if (ek !== fk) return { valid: false, reason: 'boundary_mismatch', finalState: cur };
  }
  return { valid: true, reason: 'ok', finalState: cur };
}

// ---------------------------------------------------------------------------
// Cat candidate replay legality (§9): the override plan must replay exactly
// from the ORIGINAL root — cat moves, push box, trap 0-cost, trap reclaim,
// turn ending, capture — all legal, ending at a mouse-turn or terminal.
// ---------------------------------------------------------------------------
export function replayCatCandidate(
  root: GameEngineState,
  plan: SearchAction[],
  rules: RuleSet,
): { valid: boolean; reason: string; finalState: GameEngineState | null } {
  if (plan.length === 0) return { valid: false, reason: 'empty_plan', finalState: null };
  let cur = root;
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    if (a.type !== 'catStep' && a.type !== 'catPlaceTrap') {
      return { valid: false, reason: `non_cat_action@${i}`, finalState: cur };
    }
    const legal = generateLegalSearchActions(cur, rules);
    const isStep = a.type === 'catStep';
    const stepDir = isStep ? (a as { direction: { key: string } }).direction.key : null;
    const exact = legal.some(l => {
      if (l.type !== a.type) return false;
      if (isStep && l.type === 'catStep') return stepDir !== null && l.direction!.key === stepDir;
      return true; // catPlaceTrap
    });
    if (!exact) return { valid: false, reason: `illegal_cat_action@${i}:${shortOf(a)}`, finalState: cur };
    const tr = simulateSearchAction(cur, a, rules);
    if (tr.kind === 'chance') return { valid: false, reason: `cat_chance@${i}`, finalState: cur };
    cur = tr.state;
    if (cur.phase === GamePhase.CatWins || cur.phase === GamePhase.MouseWins) break;
    if (cur.currentPlayer !== PieceType.Cat) break; // turn ended → boundary
  }
  const okEnd = cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat;
  if (!okEnd) return { valid: false, reason: 'plan_did_not_end_turn', finalState: cur };
  return { valid: true, reason: 'ok', finalState: cur };
}

// ---------------------------------------------------------------------------
// Frozen lexicographic comparator (G0.3V §10 — no scalar bonuses)
// ---------------------------------------------------------------------------
function compareRefuteCandidates(
  a: { c: PlanCandidate; r: BoundedRefutationProbeResult },
  b: { c: PlanCandidate; r: BoundedRefutationProbeResult },
  baselineValue: number,
): number {
  if (a.r.refuted !== b.r.refuted) return a.r.refuted ? 1 : -1;
  const ra = a.r.pathsVisited > 0 ? a.r.respondedCount / a.r.pathsVisited : 1;
  const rb = b.r.pathsVisited > 0 ? b.r.respondedCount / b.r.pathsVisited : 1;
  if (ra !== rb) return rb - ra;
  const wa = a.c.cheap.worstInterceptMargin ?? 0;
  const wb = b.c.cheap.worstInterceptMargin ?? 0;
  if (wa !== wb) return wa - wb;
  if (baselineValue !== 0) {
    const va = a.r.refuted ? baselineValue - 1e9 : baselineValue;
    const vb = b.r.refuted ? baselineValue - 1e9 : baselineValue;
    if (va !== vb) return vb - va;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Conservative override (§5, §10): baseline REFUTED + a NO_REFUTATION_FOUND
// candidate → pick by frozen comparator. INCOMPLETE / CHANCE_MIXED / invalid
// witness candidates are NEVER override candidates.
// ---------------------------------------------------------------------------
export function pickOverrideCandidate(
  candidates: PlanCandidate[],
  reports: BoundedRefutationProbeResult[],
  baselineValue: number,
): number {
  if (reports.length === 0) return 0;
  // The baseline must be a REAL refutation (valid witness, not CHANCE_MIXED /
  // INCOMPLETE). An invalid-witness baseline is not refuted at all.
  if (!reports[0].refuted || reports[0].invalidWitness) return 0;
  if (reports[0].status === 'CHANCE_MIXED' || reports[0].status === 'INCOMPLETE') return 0;
  const clean = reports.some((r, i) => i > 0 && r.status === 'NO_REFUTATION_FOUND' && !r.invalidWitness);
  if (!clean) return 0;
  const scored = candidates.map((c, i) => ({ c, r: reports[i], i }))
    .filter(x => x.r.status !== 'INCOMPLETE' && x.r.status !== 'CHANCE_MIXED' && !x.r.invalidWitness)
    .sort((x, y) => compareRefuteCandidates(x, y, baselineValue) || x.i - y.i);
  if (scored.length === 0) return 0;
  const best = scored[0];
  if (best.i === 0) return 0;
  return best.i;
}

// ---------------------------------------------------------------------------
// Sidecar abort gate (spec §2 STEP 2) — testable in isolation.
// ---------------------------------------------------------------------------
export function shouldRunSidecar(params: {
  difficulty: string;
  phase: GamePhase;
  currentPlayer: PieceType;
  baselinePlanLegal: boolean;
  baselineCompleted: boolean;
  baselineMate: 'cat' | 'mouse' | null;
  enabled: boolean;
}): boolean {
  if (!params.enabled) return false;
  if (params.difficulty !== 'hard') return false;
  if (params.phase !== GamePhase.Playing) return false;
  if (params.currentPlayer !== PieceType.Cat) return false;
  if (!params.baselinePlanLegal) return false;
  if (!params.baselineCompleted) return false;
  if (params.baselineMate !== null) return false; // mate=cat / mate=mouse → bypass
  return true;
}

// ---------------------------------------------------------------------------
// Full sidecar result (diagnostics, compact — NOT persisted into stateKey)
// ---------------------------------------------------------------------------
export interface RefutationDiagnostics {
  refutationEnabled: boolean;
  refutationTriggered: boolean;
  candidateCount: number;
  baselineProbeStatus: ProbeStatus | null;
  baselineRefutationWitness: string[];
  candidatesProbed: number;
  candidateStatuses: ProbeStatus[];
  pathCount: number;
  exactLocalChecks: number;
  refutationCpuMs: number;
  refutationWallMs: number;
  overrideEligible: boolean;
  overrideUsed: boolean;
  selectedPlanSource: 'baseline' | 'bounded_refutation';
  sidecarAbortReason: SidecarAbortReason;
}

export interface RefutationSidecarResult {
  diagnostics: RefutationDiagnostics;
  /** The final selected cat plan (baseline plan unless override used). */
  plan: SearchAction[];
  overrideUsed: boolean;
  selectedCandidateIdx: number;
}

export interface RefutationSidecarOpts {
  rules: RuleSet;
  /** Absolute total-turn deadline (ms in `now` time-base). */
  totalDeadlineMs: number;
  now?: () => number;
  enabled: boolean;
}

/**
 * Run the bounded plan-refutation sidecar after the baseline search.
 *
 * STEP 2 gate: sidecar runs only when difficulty hard ∧ playing ∧ cat ∧
 * baseline plan legal ∧ baseline completed ∧ mate == null ∧ flag ON.
 * STEP 3: bounded probe per candidate (per-candidate internal 20ms cap PLUS
 *   the external total-turn deadline; whichever fires first).
 * STEP 4: conservative override only after the cat candidate replays legal.
 *
 * Any INCOMPLETE / CHANCE_MIXED / invalid-witness candidate is never an
 * override candidate. Partial results never leak: the returned plan is the
 * baseline unless a full override decision completed.
 */
export function runRefutationSidecar(
  root: GameEngineState,
  baselinePlan: SearchAction[],
  baselineValue: number,
  opts: RefutationSidecarOpts,
): RefutationSidecarResult {
  const now = opts.now ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
  const t0 = now();
  const baseDiag: RefutationDiagnostics = {
    refutationEnabled: opts.enabled,
    refutationTriggered: false,
    candidateCount: 0,
    baselineProbeStatus: null,
    baselineRefutationWitness: [],
    candidatesProbed: 0,
    candidateStatuses: [],
    pathCount: 0,
    exactLocalChecks: 0,
    refutationCpuMs: 0,
    refutationWallMs: 0,
    overrideEligible: false,
    overrideUsed: false,
    selectedPlanSource: 'baseline',
    sidecarAbortReason: opts.enabled ? 'baseline_not_refuted' : 'disabled',
  };
  if (!opts.enabled) {
    return { diagnostics: baseDiag, plan: baselinePlan, overrideUsed: false, selectedCandidateIdx: 0 };
  }

  const candidates = selectCandidates(root, baselinePlan, opts.rules);
  if (candidates.length === 0) {
    return {
      diagnostics: { ...baseDiag, refutationTriggered: true, candidateCount: 0, sidecarAbortReason: 'no_candidates' },
      plan: baselinePlan, overrideUsed: false, selectedCandidateIdx: 0,
    };
  }

  const externalDeadlineMs = opts.totalDeadlineMs;
  const reports = candidates.map(c =>
    runBoundedProbe(c.mouseRoot, opts.rules, {
      maxPaths: FIXED_PATHS,
      maxCpuMs: FIXED_CPU_MS,
      maxExact: FIXED_EXACT,
      externalDeadlineMs,
      now,
    }),
  );
  const wallMs = now() - t0;

  // Witness legality gate (§8): any PLAN_REFUTED must replay.
  let invalidWitness = false;
  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    if (r.refuted) {
      const rep = replayMouseWitness(candidates[i].mouseRoot, r.witness, opts.rules, r.boundaryReached);
      if (!rep.valid) {
        r.invalidWitness = true;
        invalidWitness = true;
      }
    }
  }

  const baselineRefuted = reports[0].refuted && !reports[0].invalidWitness;
  let overrideEligible = baselineRefuted;
  let overrideIdx = 0;
  if (overrideEligible) {
    overrideIdx = pickOverrideCandidate(candidates, reports, baselineValue);
    overrideEligible = overrideIdx !== 0;
  }

  let overrideUsed = false;
  let plan = baselinePlan;
  let selectedCandidateIdx = 0;
  let abort: SidecarAbortReason = 'none';

  if (overrideEligible) {
    // Cat candidate replay legality (§9): the override plan must execute from
    // the ORIGINAL root.
    const cand = candidates[overrideIdx];
    const rep = replayCatCandidate(root, cand.planWitness, opts.rules);
    if (rep.valid) {
      plan = cand.planWitness;
      overrideUsed = true;
      selectedCandidateIdx = overrideIdx;
    } else {
      abort = 'invalid_candidate';
    }
  } else if (!baselineRefuted) {
    abort = 'baseline_not_refuted';
  } else if (invalidWitness) {
    abort = 'invalid_witness';
  } else {
    abort = 'no_clean_candidate';
  }

  const statuses = reports.map(r => r.status);
  const anyIncomplete = statuses.includes('INCOMPLETE');
  if (!overrideUsed && !baselineRefuted && anyIncomplete) {
    // If the baseline probe itself was INCOMPLETE (outer deadline), the sidecar
    // could not reach a full decision → fall back to baseline (partial result
    // must never leak).
    abort = 'deadline';
  }

  const diag: RefutationDiagnostics = {
    refutationEnabled: opts.enabled,
    refutationTriggered: true,
    candidateCount: candidates.length,
    baselineProbeStatus: reports[0].status,
    baselineRefutationWitness: reports[0].refuted ? reports[0].witness.map(shortOf) : [],
    candidatesProbed: candidates.length,
    candidateStatuses: statuses,
    pathCount: reports.reduce((s, r) => s + r.pathsVisited, 0),
    exactLocalChecks: reports.reduce((s, r) => s + r.exactLocalChecks, 0),
    refutationCpuMs: reports.reduce((s, r) => s + r.cpuMs, 0),
    refutationWallMs: wallMs,
    overrideEligible,
    overrideUsed,
    selectedPlanSource: overrideUsed ? 'bounded_refutation' : 'baseline',
    sidecarAbortReason: overrideUsed ? 'none' : abort,
  };

  return { diagnostics: diag, plan, overrideUsed, selectedCandidateIdx };
}
