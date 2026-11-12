/// <reference types="node" />
/**
 * PPC-HV-5 §3 — the audited mouse-line prover.
 *
 * HV-4 decided `FORCED_WIN` from `next.has('__WIN__')` — literally "some cat-plan
 * branch let the mouse walk its line into the hole". This module replaces that
 * predicate with an explicit ∀ over the cat-plan tree and makes every
 * approximation visible, so a "lost root" claim can no longer rest on an unstated
 * invariant:
 *
 *   QUANTIFIER  FORCED_WIN is returned only when EVERY branch of the cat-plan
 *               tree ends that mouse turn in MouseWins. Any branch that does not
 *               win is kept as a WITNESS (its action list) and forces NOT_FORCED.
 *   TRAPS       placement uses the real `catPlaceTrap` (needs `catTrapsRemaining
 *               > 0` and no standing trap; the trap is recycled by stepping onto
 *               it), so a refutation is a plan the cat can actually execute.
 *               HV-4's `catTurnReach` instead credited the cat with a free trap
 *               on every cell it could ever touch — sound in the direction of
 *               "the mouse is safe", unsound in the direction of "the cat had a
 *               defensive option", which is exactly the claim §4 needs.
 *   CAPS        every enumeration carries a node budget; hitting it returns
 *               ENUMERATION_INCOMPLETE instead of a win/loss verdict.
 *   CHANCE      ghost butter materialises at the CAT→MOUSE boundary
 *               (GAMEPLAY.md 幽灵黄油, engine.ts `resolveGhostBoundaryCore`).
 *               `maximizeCatPower` suppresses ghosts entirely. A butter cell only
 *               ever REMOVES cat options (engine.ts:862 refuses entry, and the
 *               push destination too), never adds one, so the suppressed world is
 *               the strongest cat: a line that survives it survives every chance
 *               world.
 *   INVARIANTS  the branch frontier must agree on the mouse's cell and remaining
 *               moves. If it does not, the prover reports INVARIANT_VIOLATION
 *               instead of silently reading `frontier[0]`.
 *
 * `hv4LegacyProbeMouseLine` below is a faithful copy of the HV-4 predicate, kept
 * only so the audit can run both provers on identical inputs.
 */
import { readFileSync } from 'node:fs';
import { catMove, catPlaceTrap, endTurn, mouseStepDeterministic } from '../../engine';
import type { GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { stateKey } from '../transposition';

const LOG_URL = new URL(
  '../../../../ai-training/human-logs/PPC-HV4/PPC_HV3_GAME4_H1_ORIGINAL.txt',
  import.meta.url,
);

// ---------------------------------------------------------------------------
// fixture: the user's own H1 GAME 4 export
// ---------------------------------------------------------------------------

export interface H1Turn {
  turn: number;
  loggedStateKey: string;
  snapshot: HardRootSnapshot;
  state: GameEngineState;
  loggedPlan: string;
  loggedSearch: string;
  loggedDeadline: string;
  loggedRootActions: string[];
  lines: string[];
}

let cached: H1Turn[] | null = null;

export function h1Game4(): H1Turn[] {
  if (cached) return cached;
  const lines = (readFileSync(LOG_URL, 'utf8') as string).split(/\r?\n/);
  const out: H1Turn[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^Turn #(\d+)\s*$/.exec(lines[i]);
    if (!m) { i++; continue; }
    const turn = Number(m[1]);
    const block: string[] = [];
    let j = i + 1;
    while (j < lines.length && !/^Turn #\d+\s*$/.test(lines[j])) { block.push(lines[j]); j++; }
    const find = (prefix: string): string =>
      block.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
    const snapLine = block.find((l) => l.startsWith('SNAPSHOT_JSON='));
    if (!snapLine) throw new Error(`Turn #${turn} has no SNAPSHOT_JSON line`);
    const raStart = block.findIndex((l) => l.trim() === 'ROOT_ACTIONS:');
    out.push({
      turn,
      loggedStateKey: find('STATE_KEY='),
      snapshot: JSON.parse(snapLine.slice('SNAPSHOT_JSON='.length)) as HardRootSnapshot,
      state: restoreHardRoot(JSON.parse(snapLine.slice('SNAPSHOT_JSON='.length)) as HardRootSnapshot),
      loggedPlan: find('PLAN:'),
      loggedSearch: find('SEARCH:'),
      loggedDeadline: find('DEADLINE:'),
      loggedRootActions: block.slice(raStart + 1).filter((l) => /^\s+\S+: value=/.test(l)).map((l) => l.trim()),
      lines: block,
    });
    i = j;
  }
  cached = out;
  return out;
}

export const h1Turn = (n: number): H1Turn => h1Game4().find((t) => t.turn === n)!;

// ---------------------------------------------------------------------------
// small geometry helpers
// ---------------------------------------------------------------------------

export const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;
export const eq = (a: { r: number; c: number }, b: { r: number; c: number }): boolean =>
  a.r === b.r && a.c === b.c;
const dirToken = (d: Direction): string => d.key.replace('Arrow', '').slice(0, 1);

export const tokenToDirection = (token: string): Direction | undefined =>
  DIRECTIONS.find((d) => dirToken(d) === token) as Direction | undefined;

/**
 * Replay a cat plan token string (`U`/`D`/`L`/`R`/`P`) through the real engine.
 * `illegalAt` is the first token the engine refuses, which is what makes a witness
 * plan falsifiable instead of merely printed.
 */
export function replayCatPlan(
  start: GameEngineState,
  tokens: string[],
): { end: GameEngineState; applied: string[]; illegalAt: string | null } {
  let s = start;
  const applied: string[] = [];
  for (const t of tokens) {
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat) break;
    const next = t === 'P'
      ? catPlaceTrap(s)
      : (() => { const d = tokenToDirection(t); return d ? catMove(s, d) : s; })();
    const changed = t === 'P'
      ? (next.trapPosition !== null && (s.trapPosition === null || !eq(next.trapPosition, s.trapPosition)))
      : !eq(next.catPosition, s.catPosition);
    if (!changed) return { end: s, applied, illegalAt: t };
    s = next;
    applied.push(t);
  }
  return { end: s, applied, illegalAt: null };
}

export function holeCells(s: GameEngineState): { r: number; c: number }[] {
  const h = s.config.mouseHole;
  const out: { r: number; c: number }[] = [];
  for (let r = h.r; r < h.r + h.size; r++) for (let c = h.c; c < h.c + h.size; c++) out.push({ r, c });
  return out;
}

/** Place the cat on a free cell, keeping `board[][].piece` consistent. */
export function withCatAt(s: GameEngineState, r: number, c: number): GameEngineState {
  const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
  board[s.catPosition.r][s.catPosition.c].piece = undefined;
  board[r][c].piece = PieceType.Cat;
  return { ...s, board, catPosition: { r, c } };
}

// ---------------------------------------------------------------------------
// exact cat-turn enumeration with plan witnesses
// ---------------------------------------------------------------------------

export interface CatBranch { state: GameEngineState; plan: string[]; }

export interface TurnEnumeration {
  ends: CatBranch[];
  captures: string[][];
  truncated: boolean;
  nodes: number;
}

/** The cat's legal actions from `s`, each with the state the REAL engine reaches. */
export function catActions(s: GameEngineState): { token: string; state: GameEngineState }[] {
  const out: { token: string; state: GameEngineState }[] = [];
  for (const d of DIRECTIONS) {
    const moved = catMove(s, d as Direction);
    if (eq(moved.catPosition, s.catPosition)) continue;
    out.push({ token: dirToken(d), state: moved });
  }
  const placed = catPlaceTrap(s);
  const movedTrap = placed.trapPosition !== null
    && (s.trapPosition === null || !eq(placed.trapPosition, s.trapPosition));
  if (movedTrap) out.push({ token: 'P', state: placed });
  return out;
}

/**
 * Every cat plan for one turn, as action sequences the engine actually accepts.
 * A turn ends when the step budget is spent (GAMEPLAY.md §5: 猫步数用完 → 切换到
 * 鼠的回合 — the cat may NOT stop early) or when no legal step remains, in which
 * case the kernel's stall hand-off ends it.
 */
export function enumerateCatTurnExact(starts: CatBranch[], nodeCap: number): TurnEnumeration {
  const ends: CatBranch[] = [];
  const captures: string[][] = [];
  const seen = new Set<string>();
  let nodes = 0;
  let truncated = false;
  const stack = [...starts];
  while (stack.length > 0) {
    if (nodes >= nodeCap) { truncated = true; break; }
    const cur = stack.pop()!;
    if (cur.state.phase !== GamePhase.Playing || cur.state.currentPlayer !== PieceType.Cat) {
      ends.push(cur);
      continue;
    }
    const k = stateKey(cur.state);
    if (seen.has(k)) continue;
    seen.add(k);
    nodes++;
    if (cur.state.catMovesLeft <= 0) { ends.push(cur); continue; }
    let expanded = false;
    for (const a of catActions(cur.state)) {
      expanded = true;
      const plan = [...cur.plan, a.token];
      if (a.state.phase === GamePhase.CatWins) { captures.push(plan); continue; }
      stack.push({ state: a.state, plan });
    }
    // dead end with steps still in the bank: the stall hand-off ends the turn here
    if (!expanded) ends.push(cur);
  }
  return { ends, captures, truncated, nodes };
}

/**
 * Fewest REAL `catMove` steps from `s` to `cell`, counting the box pushes the march
 * performs on the way. Each cat cell is taken once and the step budget is re-banked
 * per ply (a fresh cat turn grants `catBaseMoves` again), so this ranks plans — it
 * proves nothing; the proofs are the `auditMouseLine` verdicts. `-1` = unreachable
 * inside `maxDepth`.
 */
export function catMarchSteps(s: GameEngineState, cell: string, maxDepth = 16): number {
  let frontier: GameEngineState[] = [s];
  const seen = new Set<string>([rc(s.catPosition)]);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: GameEngineState[] = [];
    for (const cur of frontier) {
      const banked = { ...cur, catMovesLeft: cur.config.catBaseMoves };
      for (const d of DIRECTIONS) {
        const moved = catMove(banked, d as Direction);
        if (moved.phase !== GamePhase.Playing) continue;
        if (rc(moved.catPosition) === cell) return depth;
        if (rc(moved.catPosition) === rc(cur.catPosition)) continue;
        const k = rc(moved.catPosition);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(moved);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return -1;
}

/** Cat turn over → mouse turn start. `maximizeCatPower` forbids any ghost. */
export function handOffToMouse(s: GameEngineState, maximizeCatPower: boolean): GameEngineState {
  const base = maximizeCatPower
    ? { ...s, pendingButterSpawns: [], pendingButterPlacementDebt: 0 }
    : s;
  const next = endTurn({ ...base, currentPlayer: PieceType.Cat });
  return maximizeCatPower
    ? { ...next, pendingButterSpawns: [], pendingButterPlacementDebt: 0 }
    : next;
}

export type WalkStatus = 'WIN' | 'BROKEN' | 'CONTINUED';

export interface WalkResult { status: WalkStatus; state: GameEngineState; walked: number; why: string; }

/** Walk one fixed mouse segment with the real step function. */
export function walkMouseSegment(start: GameEngineState, segment: string[]): WalkResult {
  let s = start;
  for (let i = 0; i < segment.length; i++) {
    const target = segment[i];
    const dir = DIRECTIONS.find((d) => rc({ r: s.mousePosition.r + d.dr, c: s.mousePosition.c + d.dc }) === target);
    if (!dir) {
      return { status: 'BROKEN', state: s, walked: i, why: `${target} is not adjacent to ${rc(s.mousePosition)} on this branch` };
    }
    const moved = mouseStepDeterministic(s, dir as Direction);
    if (moved.phase === GamePhase.MouseWins) {
      return { status: 'WIN', state: moved, walked: i + 1, why: `entered the hole at ${target}` };
    }
    if (moved.phase === GamePhase.CatWins) {
      return { status: 'BROKEN', state: moved, walked: i, why: `the cat catches the mouse at ${target}` };
    }
    if (eq(moved.mousePosition, s.mousePosition)) {
      return { status: 'BROKEN', state: s, walked: i, why: `${target} is not a legal mouse step on this branch (box / cat / terrain)` };
    }
    s = moved;
    // The kernel hands the turn to the cat when the mouse's budget runs out. That
    // is only a break when the segment still has cells left to walk.
    if (i + 1 < segment.length && s.currentPlayer !== PieceType.Mouse) {
      return { status: 'BROKEN', state: s, walked: i + 1, why: `the mouse turn ended early at ${target} (trap or teleport hand-off)` };
    }
    if (s.tunnelExitChoices.length > 0) {
      return { status: 'BROKEN', state: s, walked: i + 1, why: `${target} is a tunnel entrance, the line cannot continue` };
    }
  }
  return { status: 'CONTINUED', state: s, walked: segment.length, why: 'segment consumed without reaching the hole' };
}

// ---------------------------------------------------------------------------
// the audited prover
// ---------------------------------------------------------------------------

export type AuditOutcome =
  | 'FORCED_WIN'
  | 'NOT_FORCED'
  | 'ENUMERATION_INCOMPLETE'
  | 'INVARIANT_VIOLATION';

export interface AuditResult {
  outcome: AuditOutcome;
  detail: string;
  /** A cat plan that stops the line (present whenever the ∀ fails). */
  witnessPlan: string[] | null;
  catTurns: number;
  stepsWalked: number;
  nodes: number;
  branches: number;
  wins: number;
  broken: number;
  continued: number;
  captures: number;
  /** True only when a node budget cut the cat-plan tree short. */
  truncated: boolean;
}

/**
 * Replay one pinned cat turn. A pin is only a *complete* turn when the engine
 * spent the whole step budget or the cat is boxed in; anything else would be the
 * illegal "stop early" hand-off, so it is reported as an error instead of quietly
 * auditing a different rule set than the kernel.
 */
export function pinFirstTurn(
  start: GameEngineState,
  tokens: string[],
): { turn: TurnEnumeration; error: string | null } {
  const seq = tokens.map((t) => (t.startsWith('Arrow') ? t.slice(5) : t).slice(0, 1).toUpperCase());
  const rp = replayCatPlan(start, seq);
  if (rp.end.phase === GamePhase.CatWins) {
    return { turn: { ends: [], captures: [rp.applied], truncated: false, nodes: 1 }, error: null };
  }
  const boxedIn = catActions(rp.end).length === 0;
  if (rp.end.catMovesLeft > 0 && !boxedIn) {
    return {
      turn: { ends: [], captures: [], truncated: false, nodes: 0 },
      error: `pinned plan [${seq.join('')}] leaves ${rp.end.catMovesLeft} cat step(s) unspent with legal moves available — not a complete turn`,
    };
  }
  return { turn: { ends: [{ state: rp.end, plan: rp.applied }], captures: [], truncated: false, nodes: 1 }, error: null };
}

export interface AuditOptions {
  nodeCap?: number;
  maximizeCatPower?: boolean;
  maxCatTurns?: number;
  /**
   * Pin the cat's FIRST turn to this action sequence and quantify only over the
   * continuations. This is how a counterfactual ("had the cat played UUUR") is
   * asked without pretending the later turns were chosen.
   */
  forceFirstPlan?: string[];
}

/**
 * Does the mouse win along `line` against EVERY legal cat plan?
 *
 * `line` lists the cells the mouse steps ON (its start cell is excluded), one
 * walk of the board. The prover expands the full cat-plan tree turn by turn and
 * only calls the line forced when every branch of the tree ends that mouse turn
 * in a win.
 */
export function auditMouseLine(
  root: GameEngineState,
  line: string[],
  opts: AuditOptions = {},
): AuditResult {
  const nodeCap = opts.nodeCap ?? 60_000;
  const maximizeCatPower = opts.maximizeCatPower ?? false;
  const maxCatTurns = opts.maxCatTurns ?? 6;
  const holes = new Set(holeCells(root).map(rc));

  let branches: CatBranch[] = [{ state: root, plan: [] }];
  let idx = 0;
  let catTurns = 0;
  let nodes = 0;
  let captures = 0;

  const fail = (outcome: AuditOutcome, detail: string, extra: Partial<AuditResult> = {}): AuditResult => ({
    outcome,
    detail,
    witnessPlan: extra.witnessPlan ?? null,
    catTurns,
    stepsWalked: idx,
    nodes,
    branches: extra.branches ?? branches.length,
    wins: extra.wins ?? 0,
    broken: extra.broken ?? 0,
    continued: extra.continued ?? 0,
    captures,
    truncated: extra.truncated ?? false,
  });

  while (idx < line.length) {
    catTurns++;
    if (catTurns > maxCatTurns) return fail('INVARIANT_VIOLATION', `horizon of ${maxCatTurns} cat turns reached before the line ends`);

    // frontier invariant: all branches must agree about the mouse
    const m0 = rc(branches[0].state.mousePosition);
    const carry0 = branches[0].state.mouseHasButter;
    for (const b of branches) {
      if (rc(b.state.mousePosition) !== m0) return fail('INVARIANT_VIOLATION', `branch mouse cells disagree: ${m0} vs ${rc(b.state.mousePosition)}`);
      if (b.state.mouseHasButter !== carry0) return fail('INVARIANT_VIOLATION', `branch carrying flags disagree at ${m0}`);
      if (b.state.currentPlayer !== PieceType.Cat) return fail('INVARIANT_VIOLATION', `branch ${b.plan.join('')} is not a cat-turn start`);
      if (b.state.catMovesLeft !== b.state.config.catBaseMoves) {
        return fail('INVARIANT_VIOLATION', `branch ${b.plan.join('')} did not start a full cat turn (catMovesLeft=${b.state.catMovesLeft})`);
      }
    }
    const budget = carry0 ? branches[0].state.config.mouseCarryingMoves : branches[0].state.config.mouseBaseMoves;
    const segment = line.slice(idx, idx + budget);

    let turn: TurnEnumeration;
    if (catTurns === 1 && opts.forceFirstPlan) {
      const pinned = pinFirstTurn(branches[0].state, opts.forceFirstPlan);
      if (pinned.error) return fail('INVARIANT_VIOLATION', pinned.error);
      turn = pinned.turn;
    } else {
      turn = enumerateCatTurnExact(branches, nodeCap - nodes);
      if (turn.truncated) return fail('ENUMERATION_INCOMPLETE', `cat-plan tree hit the ${nodeCap}-node budget at cat turn ${catTurns} (${nodes} nodes, ${branches.length} branches open)`, { truncated: true });
    }
    nodes += turn.nodes;
    captures += turn.captures.length;
    if (turn.captures.length > 0) {
      return fail('NOT_FORCED', `a legal cat plan captures the mouse on cat turn ${catTurns}`, { witnessPlan: turn.captures[0] });
    }
    if (turn.ends.length === 0) return fail('INVARIANT_VIOLATION', `no cat plan ended turn ${catTurns}`);

    let wins = 0;
    let broken = 0;
    let continued = 0;
    const survivors: CatBranch[] = [];
    let witness: { plan: string[]; why: string } | null = null;
    for (const end of turn.ends) {
      const mouseStart = handOffToMouse(end.state, maximizeCatPower);
      const walk = walkMouseSegment(mouseStart, segment);
      if (walk.status === 'WIN') {
        if (!holes.has(rc(walk.state.mousePosition))) {
          return fail('INVARIANT_VIOLATION', `engine reported a win off a hole at ${rc(walk.state.mousePosition)} on plan ${end.plan.join('')}`);
        }
        wins++;
      } else if (walk.status === 'BROKEN') {
        broken++;
        if (!witness) witness = { plan: end.plan, why: walk.why };
      } else {
        continued++;
        // the line is not finished: keep this branch for the next cat turn
        const back = walk.state.currentPlayer === PieceType.Cat
          ? { ...walk.state, catMovesLeft: walk.state.config.catBaseMoves }
          : handOffToMouse({ ...walk.state, currentPlayer: PieceType.Cat }, maximizeCatPower);
        survivors.push({ state: back, plan: end.plan });
      }
    }
    if (witness) {
      return fail('NOT_FORCED', `cat plan [${witness.plan.join('')}] stops the line: ${witness.why}`, { witnessPlan: witness.plan, wins, broken, continued });
    }
    if (wins > 0 && continued === 0) {
      // ∀ enforced: every one of the turn's branches won, none merely continued
      return fail('FORCED_WIN', `all ${wins} cat-plan branches let the mouse reach ${rc(branches[0].state.mousePosition)}…${segment[segment.length - 1]} on cat turn ${catTurns}`, { wins, broken, continued });
    }
    if (wins > 0) {
      return fail('INVARIANT_VIOLATION', `${wins} branches won while ${continued} only continued — the line is not segment-aligned`, { wins, broken, continued });
    }
    idx += segment.length;
    const dedup = new Map<string, CatBranch>();
    for (const s of survivors) dedup.set(stateKey(s.state), s);
    branches = [...dedup.values()];
    if (branches.length === 0) return fail('NOT_FORCED', `no cat plan leaves the line alive after cat turn ${catTurns}`, { wins, broken, continued });
  }
  return fail('NOT_FORCED', 'the line ran out without a win');
}

// ---------------------------------------------------------------------------
// mouse line generation (candidate lines only — never a proof)
// ---------------------------------------------------------------------------

export interface MouseReach {
  dist: Map<string, number>;
  parent: Map<string, string>;
  states: Map<string, GameEngineState>;
  expanded: number;
}

/**
 * BFS over the real mouse step function with the cat given no moves. Used ONLY to
 * propose candidate lines; coordinate dedup here is a search heuristic, and every
 * proposal is re-walked branch by branch by `auditMouseLine`, so a merged state
 * can cost a candidate line but can never manufacture a FORCED_WIN.
 */
export function mouseReach(root: GameEngineState, maxSteps: number): MouseReach {
  const dist = new Map<string, number>();
  const parent = new Map<string, string>();
  const states = new Map<string, GameEngineState>();
  const startPos = rc(root.mousePosition);
  dist.set(startPos, 0);
  states.set(startPos, root);
  let frontier = [{ pos: startPos, state: root }];
  let expanded = 0;
  for (let step = 1; step <= maxSteps; step++) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      expanded++;
      for (const dir of DIRECTIONS) {
        const moved = mouseStepDeterministic(node.state, dir as Direction);
        const won = moved.phase === GamePhase.MouseWins;
        if (!won && eq(moved.mousePosition, node.state.mousePosition)) continue;
        const pos = rc(moved.mousePosition);
        let s = moved;
        if (s.currentPlayer !== PieceType.Mouse || s.mouseMovesLeft <= 0) {
          s = {
            ...s,
            currentPlayer: PieceType.Mouse,
            mouseMovesLeft: s.mouseHasButter ? s.config.mouseCarryingMoves : s.config.mouseBaseMoves,
          };
        }
        if (!dist.has(pos)) {
          dist.set(pos, step);
          parent.set(pos, node.pos);
          states.set(pos, s);
          if (!won) next.push({ pos, state: s });
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return { dist, parent, states, expanded };
}

export function routeOf(reach: MouseReach, target: string): string[] {
  const out: string[] = [];
  let cur: string | undefined = target;
  while (cur !== undefined) {
    out.unshift(cur);
    cur = reach.parent.get(cur);
  }
  return out;
}

/** The cat-root state handed straight to the mouse with the cat playing nothing. */
export function mouseTurnFrom(s: GameEngineState): GameEngineState {
  return {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: s.mouseHasButter ? s.config.mouseCarryingMoves : s.config.mouseBaseMoves,
    catMovesLeft: s.config.catBaseMoves,
  };
}

/** Every candidate winning line available to the mouse from a cat root (≤ `limit`). */
export function candidateMouseLines(root: GameEngineState, maxSteps = 12, limit = 8): string[][] {
  const reach = mouseReach(mouseTurnFrom(root), maxSteps);
  const holes = holeCells(root);
  const out: string[][] = [];
  if (root.mouseHasButter) {
    for (const h of holes) {
      const full = routeOf(reach, rc(h));
      if (full.length > 1 && full[0] === rc(root.mousePosition)) out.push(full.slice(1));
    }
  } else {
    for (const b of root.butterPositions) {
      if (!reach.dist.has(rc(b))) continue;
      const toB = routeOf(reach, rc(b));
      const after = mouseReach(reach.states.get(rc(b))!, maxSteps);
      for (const h of holes) {
        if (!after.dist.has(rc(h))) continue;
        const home = routeOf(after, rc(h));
        if (toB.length < 2 || home.length < 2) continue;
        out.push([...toB.slice(1), ...home.slice(1)]);
      }
    }
  }
  out.sort((a, b) => a.length - b.length);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// HV-4's original predicate, copied verbatim for the audit
// ---------------------------------------------------------------------------

interface LegacyReach {
  occupied: Set<string>;
  endStates: Map<string, GameEngineState>;
  captured: boolean;
  nodes: number;
}

/** HV-4 `catTurnReach` (hv4H1Game4T5.test.ts:253) — union occupancy, no traps. */
function hv4CatTurnReach(starts: GameEngineState[], nodeCap: number): LegacyReach {
  const seen = new Map<string, GameEngineState>();
  const endStates = new Map<string, GameEngineState>();
  const occupied = new Set<string>();
  let captured = false;
  let nodes = 0;
  const stack = [...starts];
  while (stack.length > 0 && nodes < nodeCap) {
    const cur = stack.pop()!;
    const k = stateKey(cur);
    if (seen.has(k)) continue;
    seen.set(k, cur);
    nodes++;
    occupied.add(rc(cur.catPosition));
    let extended = false;
    for (const d of DIRECTIONS) {
      const moved = catMove(cur, d as Direction);
      if (eq(moved.catPosition, cur.catPosition)) continue;
      if (moved.phase === GamePhase.CatWins) { captured = true; continue; }
      if (moved.currentPlayer === PieceType.Cat && moved.catMovesLeft > 0) {
        stack.push(moved);
        extended = true;
      } else {
        endStates.set(stateKey(moved), moved);
      }
    }
    if (!extended) endStates.set(k, cur);
  }
  for (const s of endStates.values()) occupied.add(rc(s.catPosition));
  return { occupied, endStates, captured, nodes };
}

export interface LegacyResult {
  outcome: 'FORCED_WIN' | 'LINE_REFUTED' | 'CAPTURED';
  refutation: string;
  catTurns: number;
  nodes: number;
  frontier: number;
}

/**
 * HV-4 `probeMouseLine` (hv4H1Game4T5.test.ts:703) with its ghost-boundary fix,
 * kept byte-for-byte faithful so the counterexamples below test the real thing.
 * Note the absence of any truncation guard: `nodeCapPerTurn` silently decides how
 * many cat plans the ∀ is actually over.
 */
export function hv4LegacyProbeMouseLine(
  root: GameEngineState,
  line: string[],
  nodeCapPerTurn = 200_000,
): LegacyResult {
  const holes = new Set(holeCells(root).map(rc));
  let frontier = [root];
  let idx = 0;
  let catTurns = 0;
  let nodes = 0;
  const threatened = new Set<string>();
  while (idx < line.length) {
    catTurns++;
    const reach = hv4CatTurnReach(frontier, nodeCapPerTurn);
    nodes += reach.nodes;
    const mouseNow = rc(frontier[0].mousePosition);
    if (reach.captured || reach.occupied.has(mouseNow)) {
      return { outcome: 'CAPTURED', refutation: `a cat plan can stand on ${mouseNow} (cat turn ${catTurns})`, catTurns, stepsWalked: idx, nodes, frontier: frontier.length } as LegacyResult;
    }
    for (const p of reach.occupied) threatened.add(p);
    const budget = frontier[0].mouseHasButter
      ? frontier[0].config.mouseCarryingMoves
      : frontier[0].config.mouseBaseMoves;
    const segment = line.slice(idx, idx + budget);
    const blocked = segment.filter((p) => threatened.has(p));
    if (blocked.length > 0) {
      return { outcome: 'LINE_REFUTED', refutation: `a cat plan can trap/block ${blocked.join(' ')} (by cat turn ${catTurns})`, catTurns, nodes, frontier: frontier.length };
    }
    const next = new Map<string, GameEngineState>();
    for (const endState of reach.endStates.values()) {
      let s: GameEngineState = { ...endState, currentPlayer: endState.currentPlayer };
      if (s.currentPlayer !== PieceType.Mouse) s = endTurn(s);
      let walked = 0;
      for (const target of segment) {
        const dir = DIRECTIONS.find((d) => rc({ r: s.mousePosition.r + d.dr, c: s.mousePosition.c + d.dc }) === target);
        if (!dir) return { outcome: 'LINE_REFUTED', refutation: `no direction from ${rc(s.mousePosition)} toward ${target}`, catTurns, nodes, frontier: frontier.length };
        const moved = mouseStepDeterministic(s, dir as Direction);
        if (moved.phase === GamePhase.MouseWins) { s = moved; break; }
        if (eq(moved.mousePosition, s.mousePosition)) {
          return { outcome: 'LINE_REFUTED', refutation: `${target} is not a legal mouse step on a cat-plan branch`, catTurns, nodes, frontier: frontier.length };
        }
        s = moved;
        walked++;
      }
      if (s.phase === GamePhase.MouseWins) {
        if (!holes.has(rc(s.mousePosition))) return { outcome: 'LINE_REFUTED', refutation: 'win reported off-hole', catTurns, nodes, frontier: frontier.length };
        next.set('__WIN__', s);
        void walked;
        continue;
      }
      if (s.currentPlayer !== PieceType.Cat) s = endTurn({ ...s, currentPlayer: PieceType.Mouse });
      next.set(stateKey(s), s);
    }
    if (next.has('__WIN__')) {
      return { outcome: 'FORCED_WIN', refutation: '', catTurns, nodes, frontier: next.size };
    }
    idx += segment.length;
    frontier = [...next.values()];
    if (frontier.length === 0) return { outcome: 'LINE_REFUTED', refutation: 'empty frontier', catTurns, nodes, frontier: 0 };
  }
  return { outcome: 'LINE_REFUTED', refutation: 'line exhausted without a win', catTurns, nodes, frontier: frontier.length };
}

/** Terrain/piece cells, for the board prints the reports quote. */
export function boardText(s: GameEngineState): string {
  const rows: string[] = [];
  for (let r = 0; r < s.config.boardSize; r++) {
    let line = '';
    for (let c = 0; c < s.config.boardSize; c++) {
      const cell = s.board[r][c];
      line += cell.piece === PieceType.Cat ? 'C'
        : cell.piece === PieceType.Mouse ? 'M'
          : cell.type === CellType.MouseHole ? 'H'
            : cell.type === CellType.Tunnel ? 'T'
              : cell.type === CellType.Box ? 'B'
                : cell.type === CellType.Pile ? 'p'
                  : s.trapPosition && s.trapPosition.r === r && s.trapPosition.c === c ? 'X'
                    : s.butterPositions.some((b) => b.r === r && b.c === c) ? 'b' : '.';
    }
    rows.push(line);
  }
  return rows.join('\n');
}
