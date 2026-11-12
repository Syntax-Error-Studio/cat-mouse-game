/// <reference types="node" />
/**
 * PPC-HV19 — two-layer ghost-gift risk screener (RESEARCH MODULE, test-only).
 *
 * It answers a narrow question: given the real hand-off after a cat plan, can
 * the mouse gain butter for free through the ghost-butter rule (end its turn on
 * a ghost cell so the CAT→MOUSE boundary auto-picks it), and can that be
 * PROVEN against every legal cat response inside one bounded pair?
 *
 * LAYER 1 (cheap): real legal actions + real movement rules + the formal
 *   announcement support. It returns SUSPECTED_RISK or NOT_DETECTED.
 *   NOT_DETECTED is NOT a safety statement.
 *
 * LAYER 2 (certification): replay one explicit mouse route, then enumerate
 *   EVERY complete legal cat turn and EVERY formal boundary CHANCE outcome
 *   from the end state. PROVEN only when, in every outcome, the mouse can
 *   reach the hole inside its next turn under the real simulator. A cat
 *   capture/block, an unexpected boundary or a cut search forbids PROVEN
 *   (cut search = UNKNOWN, never promoted).
 *
 * Neither layer calls Math.random. No production module imports this file.
 */
import { enumerateButterSpawnsForState } from '../../engine';
import type { GameEngineState } from '../../engine';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../types';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { gameAffectingEqual } from '../stateCompare';
import { generateLegalSearchActions } from '../legalActions';
import type { RuleSet, SearchAction, SearchTransitionResult } from '../searchTypes';

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;

export interface ScreenCounters {
  simCalls: number;
  legalChecks: number;
  chanceEnumerations: number;
  chanceOutcomes: number;
  mouseStates: number;
  catStates: number;
  /** The screener never imports or calls an evaluation function. */
  h1EvalCalls: number;
}

export interface ScreenBudget {
  deadlineAt: number;
  maxSimCalls: number;
  counters: ScreenCounters;
  overflow: string | null;
}

export function makeScreenBudget(wallMs: number, maxSimCalls: number): ScreenBudget {
  return {
    deadlineAt: clock() + wallMs,
    maxSimCalls,
    counters: {
      simCalls: 0, legalChecks: 0, chanceEnumerations: 0, chanceOutcomes: 0,
      mouseStates: 0, catStates: 0, h1EvalCalls: 0,
    },
    overflow: null,
  };
}

export function spend(b: ScreenBudget, n = 1): boolean {
  if (b.overflow) return false;
  b.counters.simCalls += n;
  if (b.counters.simCalls > b.maxSimCalls) {
    b.overflow = `SIM_CAP_${b.maxSimCalls}`;
    return false;
  }
  if ((b.counters.simCalls & 255) < n && clock() > b.deadlineAt) {
    b.overflow = 'WALL_CLOCK';
    return false;
  }
  return true;
}

function checkClock(b: ScreenBudget): boolean {
  if (b.overflow) return false;
  if (clock() > b.deadlineAt) { b.overflow = 'WALL_CLOCK'; return false; }
  return true;
}

function sim(
  s: GameEngineState,
  a: SearchAction,
  b: ScreenBudget,
  rules: RuleSet,
): SearchTransitionResult | null {
  if (!spend(b)) return null;
  const res = simulateSearchAction(s, a, rules);
  if (res.kind === 'chance') {
    b.counters.chanceEnumerations++;
    b.counters.chanceOutcomes += res.outcomes.length;
  }
  return res;
}

/**
 * Win-in-turn key. Pending ghosts/debt are EXCLUDED: the screener only asks
 * whether the mouse can reach the hole inside its CURRENT turn, and ghosts
 * neither block movement nor get picked during a turn (only at the next
 * CAT→MOUSE boundary). Two states that differ only in pending ghosts therefore
 * have the same in-turn win verdict, so this key is sound for that predicate
 * and collapses the ~26 boundary variants per cat plan to one check.
 */
function winKey(s: GameEngineState): string {
  return stateKey({ ...s, pendingButterSpawns: [], pendingButterPlacementDebt: 0 });
}

export type WinVerdict = 'yes' | 'no' | 'unknown';

/**
 * Can the mouse force a win inside its current turn? ∃ action per mouse node;
 * at a pickup CHANCE node the mouse chose the action, so the win must hold for
 * EVERY formal outcome (the mouse adapts afterwards). Deterministic-only test:
 * a chance outcome that still wins is fine; a cut branch is UNKNOWN.
 */
export function mouseWinWithin(
  start: GameEngineState,
  b: ScreenBudget,
  rules: RuleSet,
  memo?: Map<string, WinVerdict>,
): WinVerdict {
  const seen = memo ?? new Map<string, WinVerdict>();
  const dfs = (s: GameEngineState, depth: number): WinVerdict => {
    if (s.phase === GamePhase.MouseWins) return 'yes';
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) return 'no';
    if (depth > 10) return 'no';
    const k = winKey(s);
    const hit = seen.get(k);
    if (hit) return hit;

    let sawUnknown = false;
    const legal = generateLegalSearchActions(s, rules);
    b.counters.legalChecks += legal.length;
    b.counters.mouseStates++;
    for (const a of legal) {
      if (a.type === 'chooseTunnel') continue; // every chooseTunnel is handled by the caller state
      const res = sim(s, a, b, rules);
      if (!res) return 'unknown';
      if (res.kind === 'chance') {
        let all: WinVerdict = 'yes';
        for (const o of res.outcomes) {
          const v = dfs(o.state, depth + 1);
          if (v === 'unknown') { all = 'unknown'; break; }
          if (v === 'no') { all = 'no'; break; }
        }
        if (all === 'yes') { seen.set(k, 'yes'); return 'yes'; }
        if (all === 'unknown') sawUnknown = true;
      } else {
        const v = dfs(res.state, depth + 1);
        if (v === 'yes') { seen.set(k, 'yes'); return 'yes'; }
        if (v === 'unknown') sawUnknown = true;
      }
    }
    if (sawUnknown) return 'unknown';
    seen.set(k, 'no');
    return 'no';
  };
  return dfs(start, 0);
}

interface EndRoute {
  actions: SearchAction[];
  end: GameEngineState;
}

/** Find a deterministic mouse continuation that ENDS the turn on `target`. */
function findEndRoute(
  start: GameEngineState,
  target: { r: number; c: number },
  b: ScreenBudget,
  rules: RuleSet,
  maxVisited = 2500,
): EndRoute | null {
  const seen = new Set<string>();
  const stack: { s: GameEngineState; acts: SearchAction[] }[] = [{ s: start, acts: [] }];
  let visited = 0;
  while (stack.length > 0) {
    if (!checkClock(b)) return null;
    const { s, acts } = stack.pop()!;
    if (s.phase === GamePhase.MouseWins) continue;
    if (s.phase !== GamePhase.Playing) continue; // CatWins / tunnel choice
    if (s.tunnelExitChoices.length > 0) continue;
    if (acts.length > 10) continue;
    const k = stateKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    visited++;
    if (visited > maxVisited) return null; // bounded witness search (layer 1)
    b.counters.mouseStates++;
    const legal = generateLegalSearchActions(s, rules);
    b.counters.legalChecks += legal.length;
    for (const a of legal) {
      if (a.type === 'chooseTunnel') continue;
      const res = sim(s, a, b, rules);
      if (!res) return null;
      if (res.kind === 'chance') continue; // a witness suffix must stay deterministic
      const ns = res.state;
      if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Cat
        && ns.mousePosition.r === target.r && ns.mousePosition.c === target.c) {
        return { actions: [...acts, a], end: ns };
      }
      if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0) {
        stack.push({ s: ns, acts: [...acts, a] });
      }
    }
  }
  return null;
}

/** Cheap cat reachability: real cat moves/pushes, `catBaseMoves` plies. */
function catCanReach(
  handoff: GameEngineState,
  target: { r: number; c: number },
  b: ScreenBudget,
  rules: RuleSet,
): boolean {
  const baseMoves = handoff.config.catBaseMoves;
  let frontier: GameEngineState[] = [{
    ...handoff,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Cat,
    catMovesLeft: baseMoves,
    tunnelExitChoices: [],
  }];
  const seen = new Set<string>(frontier.map((s) => stateKey(s)));
  if (frontier[0].catPosition.r === target.r && frontier[0].catPosition.c === target.c) return true;
  for (let d = 0; d < baseMoves; d++) {
    const next: GameEngineState[] = [];
    for (const s of frontier) {
      if (!checkClock(b)) return false;
      if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat) continue;
      for (const dir of DIRECTIONS) {
        b.counters.legalChecks++;
        const ns = rules.catMove(s, dir);
        if (!gameAffectingEqual(s, ns)) continue;
        b.counters.catStates++;
        if (ns.catPosition.r === target.r && ns.catPosition.c === target.c) return true;
        if (ns.phase !== GamePhase.Playing || ns.currentPlayer !== PieceType.Cat) continue;
        if (ns.catMovesLeft <= 0) continue;
        const k = stateKey(ns);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(ns);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return false;
}

function newGhostOf(
  out: GameEngineState,
  base: GameEngineState,
): { r: number; c: number } | null {
  const baseSet = new Set((base.pendingButterSpawns ?? []).map((p) => `${p.r},${p.c}:${p.blockedMaterializations}`));
  const pend = out.pendingButterSpawns ?? [];
  for (const p of pend) {
    if (!baseSet.has(`${p.r},${p.c}:${p.blockedMaterializations}`)) return { r: p.r, c: p.c };
  }
  return null;
}

/**
 * Cheap layer-1 hole reach: from the post-boundary state the mouse is carrying
 * with `mouseCarryingMoves` moves. Walk the REAL mouse steps (boxes, piles,
 * tunnels-while-carrying, traps, cat occupancy all come from the engine) and
 * look for a hole. Layer 2 never trusts this — it is only a necessary filter.
 */
function optimisticHoleWin(
  end: GameEngineState,
  b: ScreenBudget,
  rules: RuleSet,
): boolean {
  const start: GameEngineState = {
    ...end,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: end.config.mouseCarryingMoves,
    mouseHasButter: true,
    mouseSkillActive: false,
    tunnelExitChoices: [],
  };
  const seen = new Set<string>([stateKey(start)]);
  let frontier: GameEngineState[] = [start];
  for (let step = 0; step < end.config.mouseCarryingMoves && frontier.length > 0; step++) {
    const next: GameEngineState[] = [];
    for (const s of frontier) {
      if (!checkClock(b)) return false;
      b.counters.mouseStates++;
      for (const a of generateLegalSearchActions(s, rules)) {
        if (a.type !== 'mouseStep') continue; // skill would CONSUME the butter
        const res = sim(s, a, b, rules);
        if (!res || res.kind !== 'deterministic') continue;
        const ns = res.state;
        if (ns.phase === GamePhase.MouseWins) return true;
        if (ns.phase !== GamePhase.Playing || ns.currentPlayer !== PieceType.Mouse) continue;
        if (ns.mouseMovesLeft <= 0) continue;
        const k = stateKey(ns);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(ns);
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * Layer-1 reach over the REAL cell semantics: boxes, piles, walls and void
 * block; the cat's current cell blocks; tunnels are unusable while carrying.
 * It deliberately over-approximates the "end exactly here" requirement (a cell
 * merely reachable within the move budget is kept), so it can only ADD
 * suspects. Layer 2 replays a real route and decides.
 */
function mouseReachSet(
  s: GameEngineState,
  maxSteps: number,
  carrying: boolean,
): Set<string> {
  const seen = new Set<string>([rc(s.mousePosition)]);
  let frontier: { r: number; c: number }[] = [{ ...s.mousePosition }];
  for (let d = 0; d < maxSteps && frontier.length > 0; d++) {
    const next: { r: number; c: number }[] = [];
    for (const p of frontier) {
      for (const dir of DIRECTIONS) {
        const r = p.r + dir.dr;
        const c = p.c + dir.dc;
        if (r < 0 || c < 0 || r >= s.config.boardSize || c >= s.config.boardSize) continue;
        if (s.catPosition.r === r && s.catPosition.c === c) continue;
        const t = s.board[r][c].type;
        if (t === CellType.Box || t === CellType.Pile || t === CellType.Wall || t === CellType.Void) continue;
        if (t === CellType.Tunnel && carrying) continue;
        const k = `${r},${c}`;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ r, c });
      }
    }
    frontier = next;
  }
  return seen;
}

/** The post-boundary gift state: the mouse stands on the ghost, carrying. */
function optimisticHoleWinAt(
  base: GameEngineState,
  g: { r: number; c: number },
  b: ScreenBudget,
  rules: RuleSet,
): boolean {
  const s: GameEngineState = {
    ...base,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Mouse,
    mousePosition: { r: g.r, c: g.c },
    mouseMovesLeft: base.config.mouseCarryingMoves,
    mouseHasButter: true,
    mouseSkillActive: false,
    tunnelExitChoices: [],
  };
  return optimisticHoleWin(s, b, rules);
}

export interface GiftSuspect {
  source: 'PICKUP' | 'PENDING';
  ghostCell: { r: number; c: number };
  /** Formal announcement weight: 1/N for a pickup, 1 for an already-observed ghost. */
  weight: number;
  announcementN: number;
  prefix: SearchAction[];
  pickup: SearchAction | null;
  suffix: SearchAction[];
  catReachable: false;
}

export interface Layer1Result {
  label: 'SUSPECTED_RISK' | 'NOT_DETECTED';
  complete: boolean;
  alreadyCarrying: boolean;
  suspects: GiftSuspect[];
  elapsedMs: number;
  counters: ScreenCounters;
  note: string;
}

/**
 * Layer 1. Bounded cheap scan of ONE mouse-to-move hand-off.
 *
 * Scope: the FIRST butter pickup of the mouse turn (or a ghost already pending
 * at hand-off), a ghost cell inside the mouse's real-rule reach, an optimistic
 * 3-carrying-move hole route, and a cat that cannot reach that cell in its base
 * moves. These are necessary-looking conditions, never a proof — layer 2
 * replays the concrete route and enumerates the cat's response.
 */
export function screenHandoff(
  handoff: GameEngineState,
  rules: RuleSet,
  budget: ScreenBudget,
): Layer1Result {
  const t0 = clock();
  const empty = (label: Layer1Result['label'], complete: boolean, note: string, alreadyCarrying = false): Layer1Result => ({
    label, complete, alreadyCarrying, suspects: [], elapsedMs: clock() - t0,
    counters: { ...budget.counters }, note,
  });
  if (handoff.phase !== GamePhase.Playing) return empty('NOT_DETECTED', true, `terminal:${handoff.phase}`);
  if (handoff.currentPlayer !== PieceType.Mouse) return empty('NOT_DETECTED', true, 'not-a-mouse-handoff');

  const alreadyCarrying = handoff.mouseHasButter;
  const suspects: GiftSuspect[] = [];
  const push = (
    source: GiftSuspect['source'],
    g: { r: number; c: number },
    weight: number,
    n: number,
    prefix: SearchAction[],
    pickup: SearchAction | null,
  ): void => {
    if (suspects.some((x) => x.ghostCell.r === g.r && x.ghostCell.c === g.c && x.source === source)) return;
    suspects.push({ source, ghostCell: g, weight, announcementN: n, prefix, pickup, suffix: [], catReachable: false });
  };

  if (!alreadyCarrying) {
    // (a) ghosts ALREADY pending at hand-off: which cells can this turn reach?
    if (handoff.mouseMovesLeft > 0) {
      const reach = mouseReachSet(handoff, handoff.mouseMovesLeft, false);
      for (const g of handoff.pendingButterSpawns ?? []) {
        if (!reach.has(rc(g))) continue;
        if (catCanReach(handoff, g, budget, rules)) continue;
        if (!optimisticHoleWinAt(handoff, g, budget, rules)) continue;
        push('PENDING', { r: g.r, c: g.c }, 1, 1, [], null);
      }
    }

    // (b) first pickup of this turn: BFS over the deterministic prefix, then
    //     the formal announcement outcomes (uniform 1/N). The mouse is carrying
    //     after a pickup, so the reach budget may include the skill (+3).
    let frontier: { s: GameEngineState; prefix: SearchAction[] }[] = [{ s: handoff, prefix: [] }];
    const seen = new Set<string>([stateKey(handoff)]);
    while (frontier.length > 0 && !budget.overflow) {
      const next: { s: GameEngineState; prefix: SearchAction[] }[] = [];
      for (const { s, prefix } of frontier) {
        if (!checkClock(budget)) break;
        b_counters_prefix(budget);
        const legal = generateLegalSearchActions(s, rules);
        budget.counters.legalChecks += legal.length;
        for (const a of legal) {
          if (a.type === 'chooseTunnel') continue;
          const res = sim(s, a, budget, rules);
          if (!res) break;
          if (res.kind === 'chance') {
            const N = res.outcomes.length;
            const base = res.outcomes[0]?.state;
            if (base) {
              const reach = mouseReachSet(
                base,
                base.mouseMovesLeft + base.config.mouseSkillExtraMoves,
                true,
              );
              for (const o of res.outcomes) {
                const g = newGhostOf(o.state, s);
                if (!g || !reach.has(rc(g))) continue;
                if (catCanReach(handoff, g, budget, rules)) continue;
                if (!optimisticHoleWinAt(o.state, g, budget, rules)) continue;
                push('PICKUP', g, 1 / N, N, prefix, a);
              }
            }
            continue; // first pickup only: do not traverse through it
          }
          if (res.kind !== 'deterministic') continue;
          const ns = res.state;
          if (a.type !== 'mouseStep' && a.type !== 'mouseSkill') continue;
          if (ns.phase !== GamePhase.Playing || ns.currentPlayer !== PieceType.Mouse) continue;
          if (ns.mouseMovesLeft <= 0 || ns.tunnelExitChoices.length > 0) continue;
          const k = stateKey(ns);
          if (seen.has(k)) continue;
          seen.add(k);
          next.push({ s: ns, prefix: [...prefix, a] });
        }
      }
      frontier = next;
    }
  }

  suspects.sort((x, y) => (rc(x.ghostCell) + x.source).localeCompare(rc(y.ghostCell) + y.source));
  const complete = budget.overflow === null;
  const note = alreadyCarrying
    ? 'handoff-already-carrying: not a ghost-gift (no butter gained)'
    : complete ? 'scan-complete' : `scan-incomplete:${budget.overflow}`;
  return {
    label: suspects.length > 0 ? 'SUSPECTED_RISK' : 'NOT_DETECTED',
    complete,
    alreadyCarrying,
    suspects,
    elapsedMs: clock() - t0,
    counters: { ...budget.counters },
    note,
  };
}

function b_counters_prefix(b: ScreenBudget): void {
  // The prefix BFS generates one state per dequeued node; counted separately
  // from the action simulations so the two costs stay visible.
  b.counters.mouseStates++;
}

// ===========================================================================
// LAYER 2 — bounded certification
// ===========================================================================

export interface CatPlanTurn {
  actions: SearchAction[];
  label: string;
  outcomes: GameEngineState[];
}

export interface CatTurnSet {
  plans: CatPlanTurn[];
  outcomes: number;
  chanceOutcomes: number;
  transitions: number;
  complete: boolean;
  overflow: string | null;
}

const MAX_CAT_ACTIONS = 12;

/** Enumerate every complete legal cat turn + every formal boundary outcome. */
export function enumCatTurns(start: GameEngineState, b: ScreenBudget, rules: RuleSet): CatTurnSet {
  let transitions = 0;
  let chanceOutcomes = 0;
  const plans = new Map<string, CatPlanTurn>();
  const labelOf = (actions: SearchAction[]): string => actions.map((a) => {
    if (a.type === 'catStep') return a.direction!.key.replace('Arrow', '').slice(0, 1);
    return a.type === 'catPlaceTrap' ? 'T' : '?';
  }).join('');
  const add = (actions: SearchAction[], outcomes: GameEngineState[]): void => {
    if (actions.length === 0) return;
    const label = labelOf(actions);
    if (plans.has(label)) return;
    const seen = new Set<string>();
    const uniq: GameEngineState[] = [];
    for (const o of outcomes) {
      const k = stateKey(o);
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(o);
    }
    plans.set(label, { actions, label, outcomes: uniq });
  };
  const walk = (s: GameEngineState, prefix: SearchAction[]): void => {
    if (b.overflow) return;
    const atBoundary = s.phase !== GamePhase.Playing
      || s.currentPlayer !== PieceType.Cat
      || s.catMovesLeft <= 0;
    if (atBoundary) { add(prefix, [s]); return; }
    if (prefix.length >= MAX_CAT_ACTIONS) { add(prefix, [s]); return; }
    const legal = generateLegalSearchActions(s, rules)
      .filter((a) => a.type === 'catStep' || a.type === 'catPlaceTrap');
    b.counters.legalChecks += legal.length;
    if (legal.length === 0) { add(prefix, [s]); return; }
    for (const a of legal) {
      transitions++;
      b.counters.catStates++;
      const res = sim(s, a, b, rules);
      if (!res) return;
      if (res.kind === 'chance') {
        chanceOutcomes += res.outcomes.length;
        add([...prefix, a], res.outcomes.map((o) => o.state));
        continue;
      }
      walk(res.state, [...prefix, a]);
    }
  };
  walk(start, []);
  const list = [...plans.values()];
  return {
    plans: list,
    outcomes: list.reduce((n, p) => n + p.outcomes.length, 0),
    chanceOutcomes,
    transitions,
    complete: b.overflow === null,
    overflow: b.overflow,
  };
}

export interface CertifyResult {
  status: 'PROVEN' | 'REFUTED' | 'UNKNOWN';
  reason: string;
  ghostCell: { r: number; c: number };
  weight: number;
  announcementN: number;
  catPlans: number;
  catOutcomes: number;
  catWins: number;
  mouseWinFailures: number;
  distinctWinChecks: number;
  transitions: number;
  elapsedMs: number;
  route: string;
  /** The exact mouse actions the certificate replayed (pickup included). */
  routeActions: SearchAction[];
}

function replayPrefix(
  handoff: GameEngineState,
  prefix: SearchAction[],
  b: ScreenBudget,
  rules: RuleSet,
): GameEngineState | null {
  let s = handoff;
  for (const a of prefix) {
    const res = sim(s, a, b, rules);
    if (!res || res.kind !== 'deterministic') return null;
    s = res.state;
    // A PREFIX action always leaves the mouse still to move (the pickup is last).
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) return null;
  }
  return s;
}

/**
 * Cross-check the formal announcement support against the production spawn
 * kernel: removing the newly added ghost from any outcome must reproduce
 * exactly the announced cell set. Guards against a biased or wrong chance
 * source before a certificate is issued.
 */
function announcementSupportOk(
  pre: GameEngineState,
  outcomes: { state: GameEngineState }[],
): boolean {
  const first = outcomes[0]?.state;
  if (!first) return false;
  const g0 = newGhostOf(first, pre);
  if (!g0) return false;
  const base: GameEngineState = {
    ...first,
    pendingButterSpawns: (first.pendingButterSpawns ?? []).filter(
      (p) => !(p.r === g0.r && p.c === g0.c),
    ),
  };
  const cells = enumerateButterSpawnsForState(base).map(rc);
  const support = new Set<string>();
  for (const o of outcomes) {
    const g = newGhostOf(o.state, pre);
    if (!g) return false;
    support.add(rc(g));
  }
  if (cells.length !== outcomes.length || cells.length !== support.size) return false;
  const set = new Set(cells);
  return [...support].every((k) => set.has(k));
}

/** Replay the deterministic suffix; only the LAST action may end the turn. */
function replaySuffix(
  start: GameEngineState,
  suffix: SearchAction[],
  b: ScreenBudget,
  rules: RuleSet,
): { state: GameEngineState | null; reason: string } {
  let s = start;
  for (let i = 0; i < suffix.length; i++) {
    const res = sim(s, suffix[i], b, rules);
    if (!res) return { state: null, reason: `suffix-incomplete:${b.overflow}` };
    if (res.kind !== 'deterministic') return { state: null, reason: 'suffix-chance' };
    s = res.state;
    if (i < suffix.length - 1) {
      if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse || s.mouseMovesLeft <= 0) {
        return { state: null, reason: 'suffix-early-turn-end' };
      }
    }
  }
  return { state: s, reason: 'ok' };
}

/**
 * Layer 2 for ONE candidate. The probability certificate is the announcement
 * weight (1/N). PROVEN means: in every complete legal cat turn and every formal
 * boundary outcome, the mouse (carrying after the boundary) can win inside its
 * next turn under the real simulator — no cat counterplay in this bounded pair.
 * The cat's adaptive next-turn response IS the enumeration; the mouse's
 * post-announcement route is fixed as the witness.
 */
const ROUTE_VISITED = 40000;

function actLabel(a: SearchAction): string {
  if (a.type === 'mouseSkill') return 'K';
  if (a.type === 'mouseStep' || a.type === 'catStep') {
    return a.direction!.key.replace('Arrow', '').slice(0, 1);
  }
  return a.type === 'catPlaceTrap' ? 'T' : '?';
}

export function certifyCandidate(
  handoff: GameEngineState,
  cand: GiftSuspect,
  rules: RuleSet,
  budget: ScreenBudget,
): CertifyResult {
  const t0 = clock();
  const base = {
    ghostCell: cand.ghostCell,
    weight: cand.weight,
    announcementN: cand.announcementN,
    catPlans: 0, catOutcomes: 0, catWins: 0, mouseWinFailures: 0,
    distinctWinChecks: 0, transitions: 0,
    elapsedMs: 0,
    route: [cand.prefix, cand.pickup ? [cand.pickup] : [], cand.suffix]
      .flat().map(actLabel).join(''),
    routeActions: [] as SearchAction[],
  };
  const fail = (status: CertifyResult['status'], reason: string): CertifyResult => ({
    ...base, status, reason, elapsedMs: clock() - t0,
  });

  let end: GameEngineState;
  if (cand.source === 'PENDING') {
    // An already-announced ghost: derive a concrete route that ends the turn on it.
    const route = findEndRoute(handoff, cand.ghostCell, budget, rules, ROUTE_VISITED);
    if (!route) {
      return budget.overflow
        ? fail('UNKNOWN', `route-incomplete:${budget.overflow}`)
        : fail('REFUTED', 'no-terminating-route');
    }
    base.route = route.actions.map(actLabel).join('');
    base.routeActions = [...route.actions];
    const r = replaySuffix(handoff, route.actions, budget, rules);
    if (!r.state) return fail(r.reason.includes('incomplete') ? 'UNKNOWN' : 'REFUTED', r.reason);
    end = r.state;
  } else {
    if (!cand.pickup) return fail('REFUTED', 'missing-pickup');
    const pre = replayPrefix(handoff, cand.prefix, budget, rules);
    if (!pre) {
      return budget.overflow
        ? fail('UNKNOWN', `prefix-incomplete:${budget.overflow}`)
        : fail('REFUTED', 'prefix-illegal');
    }
    const pickup = sim(pre, cand.pickup, budget, rules);
    if (!pickup) return fail('UNKNOWN', `pickup-incomplete:${budget.overflow}`);
    if (pickup.kind !== 'chance') return fail('REFUTED', 'pickup-not-chance');
    if (!announcementSupportOk(pre, pickup.outcomes)) {
      return fail('UNKNOWN', 'announcement-support-mismatch');
    }
    const N = pickup.outcomes.length;
    if (N !== cand.announcementN) return fail('REFUTED', `announcement-N-mismatch:${N}!=${cand.announcementN}`);
    const target = pickup.outcomes.filter((o) => {
      const g = newGhostOf(o.state, pre);
      return g !== null && g.r === cand.ghostCell.r && g.c === cand.ghostCell.c;
    });
    if (target.length !== 1) return fail('REFUTED', `announcement-cell-not-unique:${target.length}`);
    const w = target[0].weight;
    if (Math.abs(w - 1 / N) > 1e-12 || Math.abs(cand.weight - 1 / N) > 1e-12) {
      return fail('REFUTED', 'announcement-weight-mismatch');
    }
    const route = findEndRoute(target[0].state, cand.ghostCell, budget, rules, ROUTE_VISITED);
    if (!route) {
      return budget.overflow
        ? fail('UNKNOWN', `route-incomplete:${budget.overflow}`)
        : fail('REFUTED', 'no-terminating-route');
    }
    base.route = [...cand.prefix, cand.pickup, ...route.actions].map(actLabel).join('');
    base.routeActions = [...cand.prefix, cand.pickup, ...route.actions];
    const r = replaySuffix(target[0].state, route.actions, budget, rules);
    if (!r.state) return fail(r.reason.includes('incomplete') ? 'UNKNOWN' : 'REFUTED', r.reason);
    end = r.state;
  }

  if (end.phase !== GamePhase.Playing) return fail('REFUTED', `mouse-turn-did-not-hand-off:${end.phase}`);
  if (end.currentPlayer !== PieceType.Cat) return fail('REFUTED', 'mouse-turn-still-active');
  if (end.mousePosition.r !== cand.ghostCell.r || end.mousePosition.c !== cand.ghostCell.c) {
    return fail('REFUTED', 'mouse-not-on-ghost-cell');
  }
  if (!(end.pendingButterSpawns ?? []).some((p) => p.r === cand.ghostCell.r && p.c === cand.ghostCell.c)) {
    return fail('REFUTED', 'ghost-not-pending-at-handoff');
  }

  const cats = enumCatTurns(end, budget, rules);
  base.catPlans = cats.plans.length;
  base.catOutcomes = cats.outcomes;
  base.transitions = cats.transitions;
  if (!cats.complete) return fail('UNKNOWN', `cat-enumeration-incomplete:${cats.overflow}`);
  if (cats.plans.length === 0) return fail('UNKNOWN', 'no-cat-plans');

  const winMemo = new Map<string, WinVerdict>();
  const checked = new Set<string>();
  let catWins = 0;
  let failures = 0;
  for (const plan of cats.plans) {
    for (const o of plan.outcomes) {
      if (o.phase === GamePhase.CatWins) { catWins++; return { ...fail('REFUTED', 'cat-captures'), catWins }; }
      if (o.phase === GamePhase.MouseWins) continue;
      if (o.phase !== GamePhase.Playing || o.currentPlayer !== PieceType.Mouse) {
        return fail('UNKNOWN', `non-boundary-outcome:${o.phase}/${o.currentPlayer}`);
      }
      const k = winKey(o);
      let v = winMemo.get(k);
      if (!v) {
        if (!checked.has(k)) { checked.add(k); base.distinctWinChecks++; }
        v = mouseWinWithin(o, budget, rules, winMemo);
        if (v === 'unknown') return fail('UNKNOWN', 'mouse-win-check-incomplete');
      }
      if (v !== 'yes') {
        failures++;
        return { ...fail('REFUTED', 'mouse-cannot-win-after-cat-response'), mouseWinFailures: failures };
      }
    }
  }
  return {
    ...base,
    status: 'PROVEN',
    reason: 'all-cat-turns-and-boundary-outcomes-lose-to-immediate-mouse-win',
    catWins,
    mouseWinFailures: failures,
    elapsedMs: clock() - t0,
  };
}

/**
 * Per-pickup probability aggregation. Each certified cell is a distinct formal
 * announcement outcome, so the lower bound for one pickup is the SUM of its
 * cells' weights. The mouse chooses the pickup, so the plan-level lower bound
 * is the MAX over pickups (never the sum across different pickups).
 */
export interface ProbabilityCertificate {
  pickupKey: string;
  weightSum: number;
  cells: { r: number; c: number }[];
  announcementN: number;
}

export function aggregateCertificates(
  certified: { cand: GiftSuspect; res: CertifyResult }[],
): ProbabilityCertificate[] {
  const byPickup = new Map<string, ProbabilityCertificate>();
  for (const { cand, res } of certified) {
    if (res.status !== 'PROVEN') continue;
    const key = `${cand.prefix.length}:${cand.pickup ? cand.pickup.type + (cand.pickup.type === 'mouseStep' ? cand.pickup.direction!.key : '') : 'PENDING'}`;
    const entry = byPickup.get(key) ?? { pickupKey: key, weightSum: 0, cells: [], announcementN: cand.announcementN };
    if (!entry.cells.some((c) => c.r === cand.ghostCell.r && c.c === cand.ghostCell.c)) {
      entry.cells.push({ ...cand.ghostCell });
      entry.weightSum += cand.weight;
    }
    byPickup.set(key, entry);
  }
  return [...byPickup.values()].sort((a, b) => b.weightSum - a.weightSum);
}
