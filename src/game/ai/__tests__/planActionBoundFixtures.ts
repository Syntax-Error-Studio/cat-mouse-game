/// <reference types="node" />
/**
 * PPC-P1-PLAN-01 — shared fixtures for the cat-turn plan action-bound work.
 *
 * Everything here is built from the REAL engine: `createInitialState` for the
 * board, `createEngineRuleSet` for the transitions, `simulateSearchAction` for
 * every legality claim. Nothing re-implements a rule, and no fixture asserts a
 * plan is legal — it replays it and reports what the rules actually did.
 *
 * The two boards below are deliberately tiny and deterministic (no boxes, no
 * piles, no butter, fixed tunnels): the only thing under test is how many
 * actions a legal cat turn can carry, so the map must not add its own reasons
 * for a turn to end.
 */
import { createEngineRuleSet, createInitialState } from '../../engine';
import type { GameEngineState } from '../../engine';
import type { GameConfig } from '../../config';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../types';
import { createSearchContext } from '../expectiminimax';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { evaluateForCat } from '../evaluation';
import type { RuleSet, SearchAction } from '../searchTypes';

export const rules: RuleSet = createEngineRuleSet();

/** Corner tunnels for a 10×10 board (the default layout's own corners). */
export const TUNNELS = [
  { r: 0, c: 0 },
  { r: 0, c: 9 },
  { r: 9, c: 0 },
  { r: 9, c: 9 },
];

type CellData = GameEngineState['board'][number][number];
export interface Pt { r: number; c: number }

export interface BoardOpts {
  cat: Pt;
  mouse: Pt;
  /** Default 4. */
  catBaseMoves?: number;
  /** Trap inventory at the root (default 1, the engine's initial value). */
  traps?: number;
  /** A trap already on the board when the turn starts (default null). */
  trap?: Pt | null;
  /** Extra obstacles, applied after the board is flattened to Empty. */
  walls?: Pt[];
  /** Cells that keep the mouse-hole terrain (default: the 2×2 hole). */
  hole?: { r: number; c: number; size: number };
}

function config(opts: BoardOpts): GameConfig {
  const hole = opts.hole ?? { r: 7, c: 8, size: 2 };
  return {
    boardSize: 10,
    mouseHole: hole,
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: opts.mouse,
    catStart: opts.cat,
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    // PPC-P1-CLOSURE-FIX-01: `createInitialState` now rejects a config whose
    // `catBaseMoves` is not a positive safe integer (a turn the cat can never
    // act in is not a legal match). These fixtures still need a ROOT with 0
    // remaining moves — the bound is derived from `catMovesLeft`, not from the
    // config — so the config keeps a legal base budget and the root override
    // below carries the requested M. No assertion changes: `catTurnMoveBudget`
    // reads `catMovesLeft` only.
    catBaseMoves: Math.max(1, opts.catBaseMoves ?? 4),
    gameMode: 'single',
    difficulty: 'hard',
    tunnelCorners: TUNNELS,
  };
}

/**
 * A fresh Playing Hard CAT root: flat 10×10 board (only the mouse hole and the
 * corner tunnels keep terrain), no butter, no ghosts, no debt.
 */
export function catTurnRoot(opts: BoardOpts): GameEngineState {
  const base = createInitialState(config(opts));
  const hole = opts.hole ?? { r: 7, c: 8, size: 2 };
  const inHole = (r: number, c: number): boolean =>
    r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;

  const board: CellData[][] = base.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.Tunnel) return { ...cell, piece: undefined };
      if (inHole(r, c)) return { ...cell, type: CellType.MouseHole, piece: undefined, hasButter: false };
      return { ...cell, type: CellType.Empty, piece: undefined, hasButter: false };
    }),
  );
  for (const w of opts.walls ?? []) {
    // `pile` (a fixed obstacle) rather than `box`: a box could be PUSHED along
    // the corridor and change the geometry mid-plan, which is not what these
    // fixtures are about.
    board[w.r][w.c] = { ...board[w.r][w.c], type: CellType.Pile, piece: undefined };
  }
  board[opts.cat.r][opts.cat.c] = { ...board[opts.cat.r][opts.cat.c], piece: PieceType.Cat };
  board[opts.mouse.r][opts.mouse.c] = { ...board[opts.mouse.r][opts.mouse.c], piece: PieceType.Mouse };

  return {
    ...base,
    board,
    catPosition: { ...opts.cat },
    mousePosition: { ...opts.mouse },
    currentPlayer: PieceType.Cat,
    catMovesLeft: opts.catBaseMoves ?? 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
    pendingButterSpawns: [],
    pendingButterPlacementDebt: 0,
    catTrapsRemaining: opts.traps ?? 1,
    trapPosition: opts.trap ?? null,
    butterPositions: [],
  };
}

const DIR_BY_CHAR: Record<string, string> = {
  U: 'ArrowUp',
  D: 'ArrowDown',
  L: 'ArrowLeft',
  R: 'ArrowRight',
};

/** `T` → catPlaceTrap, `U/D/L/R` → catStep. Any other character throws. */
export function actionOf(ch: string): SearchAction {
  if (ch === 'T') return { type: 'catPlaceTrap' };
  const key = DIR_BY_CHAR[ch];
  if (!key) throw new Error(`unknown plan character: ${ch}`);
  const direction = DIRECTIONS.find((d) => d.key === key);
  if (!direction) throw new Error(`no direction for ${key}`);
  return { type: 'catStep', direction };
}

export function parsePlan(label: string): SearchAction[] {
  return [...label].map(actionOf);
}

export function labelOf(plan: SearchAction[]): string {
  return plan
    .map((a) => (a.type === 'catPlaceTrap' ? 'T' : a.type === 'catStep' ? (a.direction!.key.slice(5)[0] ?? '?') : '?'))
    .join('');
}

export interface ReplayStep {
  index: number;
  action: SearchAction;
  /** Transition kind reported by the real simulator. */
  kind: 'deterministic' | 'chance' | 'unexpected';
  /** True iff the state actually changed (a blocked/no-op action is `false`). */
  effective: boolean;
  /** catMovesLeft AFTER the action (only meaningful for deterministic). */
  catMovesLeft: number;
  catTrapsRemaining: number;
  trap: Pt | null;
  cat: Pt;
  /** Turn/phase facts after the action. */
  actor: string;
  phase: string;
}

export interface ReplayResult {
  ok: boolean;
  steps: ReplayStep[];
  states: GameEngineState[];
  end: GameEngineState;
}

/**
 * Apply a plan through the REAL simulator and report what happened at each
 * action. `ok` is false as soon as an action is a no-op or the transition is
 * not deterministic — i.e. the fixture never claims a legality the rules do not
 * grant.
 */
export function replayPlan(root: GameEngineState, plan: SearchAction[]): ReplayResult {
  const steps: ReplayStep[] = [];
  const states: GameEngineState[] = [];
  let cur = root;
  let ok = true;
  for (let i = 0; i < plan.length; i++) {
    const action = plan[i];
    const trans = simulateSearchAction(cur, action, rules);
    if (trans.kind !== 'deterministic') {
      steps.push({
        index: i, action, kind: trans.kind === 'chance' ? 'chance' : 'unexpected',
        effective: trans.kind === 'chance', catMovesLeft: cur.catMovesLeft,
        catTrapsRemaining: cur.catTrapsRemaining, trap: cur.trapPosition ?? null,
        cat: { ...cur.catPosition }, actor: String(cur.currentPlayer), phase: String(cur.phase),
      });
      ok = trans.kind === 'chance' && i === plan.length - 1;
      break;
    }
    const next = trans.state;
    const effective = stateKey(next) !== stateKey(cur);
    if (!effective) ok = false;
    cur = next;
    states.push(next);
    steps.push({
      index: i, action, kind: 'deterministic', effective,
      catMovesLeft: next.catMovesLeft, catTrapsRemaining: next.catTrapsRemaining,
      trap: next.trapPosition ?? null, cat: { ...next.catPosition },
      actor: String(next.currentPlayer), phase: String(next.phase),
    });
    if (next.phase !== GamePhase.Playing) break;
  }
  return { ok, steps, states, end: cur };
}

/**
 * Populate `planBranches` with exactly the edges of `plan`, replayed through
 * the real rules — the same shape the search writes when it captures its
 * principal line (`ctx.planBranches.set(stateKey(state), bestAction)`).
 * An action that does not actually change the state aborts the chain, so this
 * can never manufacture an edge the search could not have produced.
 */
export function chainCtx(root: GameEngineState, plan: SearchAction[]) {
  const ctx = createSearchContext(rules, 1_000_000, false, false, false, 0);
  ctx.leafEvaluator = evaluateForCat;
  ctx.capturePlan = true;
  ctx.planBranches = new Map<string, SearchAction>();
  ctx.equalPrimaryGraph = new Map();
  let cur = root;
  let chained = 0;
  for (const action of plan) {
    if (lineIsOver(cur)) break;
    const trans = simulateSearchAction(cur, action, rules);
    if (trans.kind !== 'deterministic') break;
    const next = trans.state;
    if (stateKey(next) === stateKey(cur)) break;
    ctx.planBranches.set(stateKey(cur), action);
    chained++;
    cur = next;
  }
  return { ctx, chained, end: cur };
}

export function lineIsOver(state: GameEngineState): boolean {
  return state.phase !== GamePhase.Playing || state.currentPlayer !== PieceType.Cat;
}

/** Every legal cat action at `state` (real rules, no-op filtered). */
export function legalCatActions(state: GameEngineState): SearchAction[] {
  // Deliberately re-derives from the RuleSet via the simulator so the count is
  // independent of generateLegalSearchActions' own filtering.
  const out: SearchAction[] = [];
  if (lineIsOver(state)) return out;
  for (const d of DIRECTIONS) {
    const action: SearchAction = { type: 'catStep', direction: d };
    const t = simulateSearchAction(state, action, rules);
    if (t.kind === 'deterministic' && stateKey(t.state) !== stateKey(state)) out.push(action);
    if (t.kind === 'chance') out.push(action);
  }
  const trap: SearchAction = { type: 'catPlaceTrap' };
  const tt = simulateSearchAction(state, trap, rules);
  if (tt.kind === 'deterministic' && stateKey(tt.state) !== stateKey(state)) out.push(trap);
  return out;
}

export interface DfsResult {
  /** Longest legal cat-action sequence found (whether or not the turn ended). */
  maxLen: number;
  /** True iff a sequence longer than `cap` existed (i.e. the cap is unsound). */
  exceeded: boolean;
  /** True iff the search hit its own visit budget instead of finishing. */
  truncated: boolean;
  visits: number;
}

/**
 * Exhaustive DFS over the REAL cat-action graph: every legal action, every
 * reachable state, recording the longest sequence. This is the empirical check
 * of the analytic bound — it never uses `maxCatTurnPlanActions`, so agreement is
 * evidence rather than a tautology.
 *
 * `maxVisits` only exists so a pathological map cannot hang the suite; when it
 * is hit the result says so instead of pretending to be exhaustive.
 */
export function dfsLongestPlan(root: GameEngineState, cap: number, maxVisits = 60_000): DfsResult {
  let maxLen = 0;
  let exceeded = false;
  let visits = 0;
  let truncated = false;
  const path = new Set<string>();

  const walk = (st: GameEngineState, depth: number): void => {
    if (depth > maxLen) maxLen = depth;
    if (depth > cap) {
      exceeded = true;
      return;
    }
    if (lineIsOver(st)) return;
    const k = stateKey(st);
    if (path.has(k)) return;
    path.add(k);
    for (const a of legalCatActions(st)) {
      if (visits >= maxVisits) { truncated = true; break; }
      visits++;
      const t = simulateSearchAction(st, a, rules);
      if (t.kind !== 'deterministic') {
        if (depth + 1 > maxLen) maxLen = depth + 1;
        continue;
      }
      if (stateKey(t.state) === k) continue;
      walk(t.state, depth + 1);
    }
    path.delete(k);
  };

  walk(root, 0);
  return { maxLen, exceeded, truncated, visits };
}

