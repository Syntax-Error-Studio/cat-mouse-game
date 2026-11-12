/// <reference types="node" />
/**
 * PPC-HV18R — quantifier / probability audit of the PPC-HV18 evidence.
 *
 * Read-only production. This file does NOT re-run HV18's 25-minute T7 root
 * existence query and does NOT re-enumerate the 44 GAME4-T8 plan trees. It:
 *   1. maps the HV18 solver quantifiers to A (all-outcome safe) / B (positive
 *      risk) / C (probability-one loss) and reuses the stored HV18-5 aggregate,
 *   2. reconstructs the GAME2 T4 LLLL refutation and computes the FORMAL ghost
 *      gift probability from the real CHANCE kernel (no 1/30 guessing),
 *   3. re-audits the DUDU/RUDD bounded-safety contract at h=2,
 *   4. runs six minimal quantifier checks (safe case, partial-failure case,
 *      probability-one win, branch-order invariance, dedupe mass, incomplete).
 *
 * Every number printed here is produced by the same production rules the game
 * uses (createEngineRuleSet). No production source is edited.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createEngineRuleSet,
  enumerateButterSpawnsForState,
  enumerateGhostBoundaryOutcomes,
} from '../../engine';
import type { GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { generateLegalSearchActions } from '../legalActions';
import type { SearchAction } from '../searchTypes';

const LOG_DIR = new URL('../../../../ai-training/human-logs/PPC-HV14/', import.meta.url);
const GAMES = ['GAME1', 'GAME2', 'GAME3', 'GAME4', 'GAME5'] as const;

const rules = createEngineRuleSet();
const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;
const token = (a: SearchAction): string =>
  a.type === 'catPlaceTrap' ? 'T' : a.type === 'catStep' ? a.direction!.key.replace('Arrow', '').slice(0, 1) : '?';
const planText = (p: SearchAction[]): string => p.map(token).join('');
const step = (key: string): SearchAction =>
  ({ type: 'catStep', direction: DIRECTIONS.find((d) => d.key === `Arrow${key}`)! }) as SearchAction;
const mstep = (key: string): SearchAction =>
  ({ type: 'mouseStep', direction: DIRECTIONS.find((d) => d.key === `Arrow${key}`)! }) as SearchAction;
const K: SearchAction = { type: 'mouseSkill' };

function logText(game: (typeof GAMES)[number]): string {
  return readFileSync(new URL(`${game}_H1.txt`, LOG_DIR), 'utf8');
}

function parseTurnBlocks(text: string): { turn: number; lines: string[] }[] {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  return starts.map((s, k) => ({
    turn: Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]),
    lines: lines.slice(s + 1, k + 1 < starts.length ? starts[k + 1] : lines.length),
  }));
}

function field(lines: string[], prefix: string): string {
  return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
}

function parsePlan(line: string): SearchAction[] {
  const text = line.replace(/^PLAN:\s*/, '').trim();
  if (!text) return [];
  return text.split('→').map((part) => {
    const p = part.trim();
    if (p === 'catPlaceTrap') return { type: 'catPlaceTrap' } as SearchAction;
    const m = /^catStep Arrow(Up|Down|Left|Right)$/.exec(p);
    if (!m) throw new Error(`unparsed plan token: ${p}`);
    return { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === `Arrow${m[1]}`)! } as SearchAction;
  });
}

interface Root {
  game: (typeof GAMES)[number];
  turn: number;
  state: GameEngineState;
  plan: SearchAction[];
  execKey: string;
}

function restoreTurn(game: (typeof GAMES)[number], block: { turn: number; lines: string[] }): Root {
  const snap = JSON.parse(field(block.lines, 'SNAPSHOT_JSON=')) as HardRootSnapshot;
  return {
    game,
    turn: block.turn,
    state: restoreHardRoot(snap),
    plan: parsePlan(field(block.lines, 'PLAN:')),
    execKey: field(block.lines, 'EXEC:').replace(/^endState=/, '').split(/\s+/)[0],
  };
}

function rootOf(game: (typeof GAMES)[number], turn: number): Root {
  const block = parseTurnBlocks(logText(game)).find((b) => b.turn === turn);
  if (!block) throw new Error(`HV18R missing ${game} T${turn}`);
  return restoreTurn(game, block);
}

// --- shared solver (copied from the HV18 instrument; read-only) -------------

interface BudgetB {
  transitions: number;
  maxTransitions: number;
  deadline: number;
  overflow: string | null;
}
function makeBudgetB(wallMs: number, maxTransitions: number): BudgetB {
  return { transitions: 0, maxTransitions, deadline: Date.now() + wallMs, overflow: null };
}
function spendBudget(b: BudgetB, n = 1): boolean {
  b.transitions += n;
  if (b.transitions > b.maxTransitions) {
    b.overflow ??= `TRANSITION_CAP_${b.maxTransitions}`;
    return false;
  }
  if ((b.transitions & 8191) < n && Date.now() > b.deadline) {
    b.overflow ??= 'WALL_CLOCK_CAP';
    return false;
  }
  return true;
}

const CAT_TURN_CAP_B = 300_000;
const MOUSE_TURN_CAP_B = 300_000;
const MAX_CAT_ACTIONS_B = 12;
const MAX_MOUSE_ACTIONS_B = 9;

interface CatPlanTurn {
  actions: SearchAction[];
  label: string;
  first: string;
  outcomes: GameEngineState[];
}
interface CatTurnSetB {
  plans: CatPlanTurn[];
  ends: GameEngineState[];
  terminals: number;
  chanceLeaves: number;
  chanceOutcomes: number;
  transitions: number;
  complete: boolean;
  overflow: string | null;
}

function dedupeStates(list: GameEngineState[]): GameEngineState[] {
  const seen = new Set<string>();
  const out: GameEngineState[] = [];
  for (const s of list) {
    const k = stateKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function enumCatPlanTurns(start: GameEngineState, b: BudgetB): CatTurnSetB {
  let n = 0;
  let overflow: string | null = null;
  const plans = new Map<string, CatPlanTurn>();
  let chanceLeaves = 0;
  let chanceOutcomes = 0;
  const add = (actions: SearchAction[], outcomes: GameEngineState[]): void => {
    if (actions.length === 0) return;
    const label = planText(actions);
    if (plans.has(label)) return;
    plans.set(label, {
      actions,
      label,
      first: actions[0].type === 'catStep' ? actions[0].direction!.key : actions[0].type,
      outcomes: dedupeStates(outcomes),
    });
  };
  const walk = (s: GameEngineState, prefix: SearchAction[]): void => {
    if (overflow || b.overflow) return;
    const atBoundary = s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat || s.catMovesLeft <= 0;
    if (atBoundary) { add(prefix, [s]); return; }
    if (prefix.length >= MAX_CAT_ACTIONS_B) { add(prefix, [s]); return; }
    const actions = generateLegalSearchActions(s, rules).filter((a) => a.type === 'catStep' || a.type === 'catPlaceTrap');
    if (actions.length === 0) { add(prefix, [s]); return; }
    for (const a of actions) {
      n++;
      if (n > CAT_TURN_CAP_B) { overflow = `CAT_TURN_CAP_${CAT_TURN_CAP_B}`; return; }
      if (!spendBudget(b)) return;
      const res = simulateSearchAction(s, a, rules);
      if (res.kind === 'chance') {
        chanceLeaves++;
        chanceOutcomes += res.outcomes.length;
        add([...prefix, a], res.outcomes.map((o) => o.state));
        continue;
      }
      walk(res.state, [...prefix, a]);
    }
  };
  walk(start, []);
  const list = [...plans.values()];
  const ends = dedupeStates(list.flatMap((p) => p.outcomes));
  let terminals = 0;
  for (const e of ends) if (e.phase === GamePhase.CatWins || e.phase === GamePhase.MouseWins) terminals++;
  return { plans: list, ends, terminals, chanceLeaves, chanceOutcomes, transitions: n, complete: overflow === null, overflow };
}

interface MouseTurnSetB {
  ends: GameEngineState[];
  labels: Map<string, string>;
  terminals: number;
  chanceLeaves: number;
  chanceOutcomes: number;
  transitions: number;
  complete: boolean;
  overflow: string | null;
}

function enumMouseTurnsB(start: GameEngineState, b: BudgetB): MouseTurnSetB {
  let n = 0;
  let overflow: string | null = null;
  const ends = new Map<string, GameEngineState>();
  const labels = new Map<string, string>();
  let chanceLeaves = 0;
  let chanceOutcomes = 0;
  const addEnd = (s: GameEngineState, label: string): void => {
    const k = stateKey(s);
    if (!ends.has(k)) { ends.set(k, s); labels.set(k, label); }
  };
  const walk = (s: GameEngineState, prefix: string[], depth: number): void => {
    if (overflow || b.overflow) return;
    if (s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins) { addEnd(s, prefix.join('')); return; }
    if (s.phase === GamePhase.ChoosingTunnelExit) {
      for (const choice of s.tunnelExitChoices) {
        n++;
        if (n > MOUSE_TURN_CAP_B) { overflow = `MOUSE_TURN_CAP_${MOUSE_TURN_CAP_B}`; return; }
        if (!spendBudget(b)) return;
        const res = simulateSearchAction(s, { type: 'chooseTunnel', r: choice.r, c: choice.c }, rules);
        const lbl = [...prefix, `X(${choice.r},${choice.c})`];
        if (res.kind === 'chance') {
          chanceLeaves++;
          chanceOutcomes += res.outcomes.length;
          for (const o of res.outcomes) addEnd(o.state, lbl.join(''));
          continue;
        }
        const ns = res.state;
        if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0) walk(ns, lbl, depth + 1);
        else addEnd(ns, lbl.join(''));
      }
      return;
    }
    if (s.currentPlayer !== PieceType.Mouse || s.mouseMovesLeft <= 0) { addEnd(s, prefix.join('')); return; }
    if (depth >= MAX_MOUSE_ACTIONS_B) { addEnd(s, prefix.join('')); return; }
    const actions = generateLegalSearchActions(s, rules).filter((a) => a.type === 'mouseStep' || a.type === 'mouseSkill');
    if (actions.length === 0) { addEnd(s, prefix.join('')); return; }
    for (const a of actions) {
      n++;
      if (n > MOUSE_TURN_CAP_B) { overflow = `MOUSE_TURN_CAP_${MOUSE_TURN_CAP_B}`; return; }
      if (!spendBudget(b)) return;
      const res = simulateSearchAction(s, a, rules);
      const label = a.type === 'mouseSkill' ? 'K' : a.direction!.key.replace('Arrow', '').slice(0, 1);
      if (res.kind === 'chance') {
        chanceLeaves++;
        chanceOutcomes += res.outcomes.length;
        for (const o of res.outcomes) {
          const ns = o.state;
          if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0) walk(ns, [...prefix, label], depth + 1);
          else addEnd(ns, [...prefix, label].join(''));
        }
        continue;
      }
      const ns = res.state;
      if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0) walk(ns, [...prefix, label], depth + 1);
      else addEnd(ns, [...prefix, label].join(''));
    }
  };
  walk(start, [], 0);
  let terminals = 0;
  for (const e of ends.values()) if (e.phase === GamePhase.CatWins || e.phase === GamePhase.MouseWins) terminals++;
  return { ends: [...ends.values()], labels, terminals, chanceLeaves, chanceOutcomes, transitions: n, complete: overflow === null, overflow };
}

function mouseCanWinInTurn(s: GameEngineState): { win: boolean; complete: boolean } {
  if (s.phase === GamePhase.MouseWins) return { win: true, complete: true };
  if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) return { win: false, complete: true };
  const N = s.config.boardSize;
  const cat = s.catPosition;
  const hole = s.config.mouseHole;
  const butter = new Set(s.butterPositions.map((p) => `${p.r},${p.c}`));
  const isHole = (r: number, c: number): boolean =>
    r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;
  const passable = (r: number, c: number): boolean => {
    if (r < 0 || c < 0 || r >= N || c >= N) return false;
    if (r === cat.r && c === cat.c) return false;
    const t = s.board[r][c].type;
    return t !== CellType.Box && t !== CellType.Pile && t !== CellType.Wall && t !== CellType.Void;
  };
  const endsTurn = (r: number, c: number): boolean =>
    s.board[r][c].type === CellType.Tunnel || (s.trapPosition?.r === r && s.trapPosition?.c === c);
  const seen = new Set<string>();
  let frontier: [number, number, number, boolean, boolean][] = [
    [s.mousePosition.r, s.mousePosition.c, s.mouseMovesLeft, s.mouseHasButter, s.mouseSkillActive],
  ];
  seen.add(`${s.mousePosition.r},${s.mousePosition.c},${s.mouseMovesLeft},${s.mouseHasButter ? 1 : 0},${s.mouseSkillActive ? 1 : 0}`);
  while (frontier.length > 0) {
    const next: [number, number, number, boolean, boolean][] = [];
    for (const [r, c, moves, carrying, skilled] of frontier) {
      if (carrying && !skilled) {
        const k = `${r},${c},${moves + s.config.mouseSkillExtraMoves},0,1`;
        if (!seen.has(k)) { seen.add(k); next.push([r, c, moves + s.config.mouseSkillExtraMoves, false, true]); }
      }
      if (moves <= 0) continue;
      for (const d of DIRECTIONS) {
        const nr = r + d.dr;
        const nc = c + d.dc;
        if (!passable(nr, nc)) continue;
        const nowCarrying = carrying || butter.has(`${nr},${nc}`);
        if (nowCarrying && isHole(nr, nc)) return { win: true, complete: true };
        if (endsTurn(nr, nc)) continue;
        const k = `${nr},${nc},${moves - 1},${nowCarrying ? 1 : 0},${skilled ? 1 : 0}`;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push([nr, nc, moves - 1, nowCarrying, skilled]);
      }
    }
    frontier = next;
  }
  return { win: false, complete: true };
}

type Tri = 'yes' | 'no' | 'incomplete';
interface SolverResultB { tri: Tri; plan?: SearchAction[] }

function makeSolverB(wallMs: number, maxTransitions: number) {
  const budget = makeBudgetB(wallMs, maxTransitions);
  const memoC = new Map<string, SolverResultB>();
  const memoM = new Map<string, Tri>();
  const catCache = new Map<string, CatTurnSetB>();
  const CAT_CACHE_MAX = 120;
  const MEMO_MAX = 150_000;

  const expired = (): boolean => {
    if (budget.overflow) return true;
    if (Date.now() > budget.deadline) { budget.overflow ??= 'WALL_CLOCK_CAP'; return true; }
    return false;
  };

  const catTurns = (s: GameEngineState): CatTurnSetB => {
    const k = stateKey(s);
    const hit = catCache.get(k);
    if (hit) return hit;
    const t = enumCatPlanTurns(s, budget);
    if (catCache.size < CAT_CACHE_MAX) catCache.set(k, t);
    return t;
  };
  const mouseTurns = (s: GameEngineState): MouseTurnSetB => enumMouseTurnsB(s, budget);

  let catSurvives: (s: GameEngineState, h: number) => SolverResultB;
  let mouseSafe: (s: GameEngineState, h: number) => Tri;

  catSurvives = (s, h) => {
    if (expired()) return { tri: 'incomplete' };
    if (s.phase === GamePhase.CatWins) return { tri: 'yes' };
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat) return { tri: 'incomplete' };
    if (h <= 0) return { tri: 'yes' };
    const key = `C|${h}|${stateKey(s)}`;
    const hit = memoC.get(key);
    if (hit) return hit;
    const ct = catTurns(s);
    if (!ct.complete) return { tri: 'incomplete' };
    for (const plan of ct.plans) {
      let ok = true;
      for (const o of plan.outcomes) {
        if (o.phase === GamePhase.CatWins) continue;
        if (o.phase !== GamePhase.Playing) { ok = false; break; }
        const m = mouseSafe(o, h);
        if (m === 'incomplete') return { tri: 'incomplete' };
        if (m === 'no') { ok = false; break; }
      }
      if (ok) {
        const r: SolverResultB = { tri: 'yes', plan: plan.actions };
        if (memoC.size < MEMO_MAX) memoC.set(key, r);
        return r;
      }
    }
    const r: SolverResultB = { tri: 'no' };
    if (memoC.size < MEMO_MAX) memoC.set(key, r);
    return r;
  };

  mouseSafe = (s, h) => {
    if (expired()) return 'incomplete';
    if (s.phase === GamePhase.MouseWins) return 'no';
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) return 'incomplete';
    if (h <= 1) {
      const key = `M1|${stateKey(s)}`;
      const hit = memoM.get(key);
      if (hit) return hit;
      const w = mouseCanWinInTurn(s);
      if (!w.complete) return 'incomplete';
      const r: Tri = w.win ? 'no' : 'yes';
      if (memoM.size < MEMO_MAX) memoM.set(key, r);
      return r;
    }
    const key = `M|${h}|${stateKey(s)}`;
    const hit = memoM.get(key);
    if (hit) return hit;
    const mt = mouseTurns(s);
    if (!mt.complete) return 'incomplete';
    let r: Tri = 'yes';
    for (const e of mt.ends) {
      if (e.phase === GamePhase.CatWins) continue;
      if (e.phase === GamePhase.MouseWins) { r = 'no'; break; }
      if (e.phase !== GamePhase.Playing) continue;
      const sub = catSurvives(e, h - 1);
      if (sub.tri === 'incomplete') return 'incomplete';
      if (sub.tri === 'no') { r = 'no'; break; }
    }
    if (memoM.size < MEMO_MAX) memoM.set(key, r);
    return r;
  };

  return {
    budget,
    catSurvives: (s: GameEngineState, h: number): SolverResultB => catSurvives(s, h),
    mouseSafe: (s: GameEngineState, h: number): Tri => mouseSafe(s, h),
    catTurns,
    mouseTurns,
  };
}

interface PlanCheck {
  status: 'survives' | 'refuted' | 'incomplete' | 'illegal';
  plan: SearchAction[];
  outcomeCount: number;
  refutation: string;
  reason: string;
  elapsedMs: number;
}

function applyCatPlan(root: GameEngineState, plan: SearchAction[]): {
  end: GameEngineState;
  chance: number;
  chanceStates: GameEngineState[];
  ok: boolean;
  reason: string;
} {
  let cur = root;
  let execEnd = root;
  let chance = 0;
  let chanceStates: GameEngineState[] = [];
  let ok = true;
  let reason = 'full-turn';
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    const before = cur;
    const raw = a.type === 'catPlaceTrap'
      ? rules.catPlaceTrap(before)
      : a.type === 'catStep'
        ? rules.catMove(before, a.direction!)
        : null;
    if (!raw) { ok = false; reason = `illegal-step-${i + 1}`; break; }
    if (i === plan.length - 1) {
      execEnd = raw;
      const res = simulateSearchAction(before, a, rules);
      if (res.kind === 'chance') {
        chance = res.outcomes.length;
        chanceStates = res.outcomes.map((o) => o.state);
      } else {
        chanceStates = [res.state];
      }
      break;
    }
    if (raw.phase !== GamePhase.Playing || raw.currentPlayer !== PieceType.Cat || raw.catMovesLeft <= 0) {
      ok = false;
      reason = `cat-turn-ended-at-step-${i + 1}`;
      execEnd = raw;
      break;
    }
    cur = raw;
  }
  const boundary = execEnd.phase !== GamePhase.Playing
    || execEnd.currentPlayer !== PieceType.Cat
    || execEnd.catMovesLeft <= 0;
  if (ok && !boundary) { ok = false; reason = 'cat-still-has-moves'; }
  if (ok && chance > 0) reason = 'chance-boundary';
  return { end: execEnd, chance, chanceStates, ok, reason };
}

function checkCatPlan(
  solver: ReturnType<typeof makeSolverB>,
  root: GameEngineState,
  plan: SearchAction[],
  h: number,
): PlanCheck {
  const t0 = Date.now();
  const applied = applyCatPlan(root, plan);
  if (!applied.ok) {
    return { status: 'illegal', plan, outcomeCount: 0, refutation: '', reason: applied.reason, elapsedMs: Date.now() - t0 };
  }
  const outcomes = applied.chanceStates;
  for (const o of outcomes) {
    if (o.phase === GamePhase.CatWins) continue;
    if (o.phase !== GamePhase.Playing) {
      return { status: 'refuted', plan, outcomeCount: outcomes.length, refutation: `non-playing:${o.phase}`, reason: 'terminal-outcome', elapsedMs: Date.now() - t0 };
    }
    const m = solver.mouseSafe(o, h);
    if (m === 'incomplete') {
      return { status: 'incomplete', plan, outcomeCount: outcomes.length, refutation: '', reason: solver.budget.overflow ?? 'incomplete', elapsedMs: Date.now() - t0 };
    }
    if (m === 'no') {
      return { status: 'refuted', plan, outcomeCount: outcomes.length, refutation: 'mouse-reply-forces-loss', reason: 'mouse-reply-forces-loss', elapsedMs: Date.now() - t0 };
    }
  }
  return { status: 'survives', plan, outcomeCount: outcomes.length, refutation: '', reason: 'all-official-outcomes-and-replies', elapsedMs: Date.now() - t0 };
}

// ===========================================================================
// HV18R-P3. GAME2 T4 LLLL — formal ghost-gift probability
// ===========================================================================

function t4Handoff(): GameEngineState {
  const r = rootOf('GAME2', 4);
  const prod = applyCatPlan(r.state, r.plan);
  if (!prod.ok) throw new Error('GAME2 T4 LLLL is not a complete cat turn');
  return prod.chanceStates[0] ?? prod.end;
}

function ghostOf(s: GameEngineState): { r: number; c: number } | null {
  const list = s.pendingButterSpawns ?? [];
  return list.length > 0 ? list[list.length - 1] : null;
}

/**
 * Certify "after the mouse ends on this ghost cell, the mouse wins with
 * probability 1": for EVERY complete legal cat turn and EVERY official
 * CAT->MOUSE boundary chance outcome, the mouse can win in its next turn.
 * The cat has no capture (CatWins) and no chance-free defence.
 */
function giftCellCertified(end: GameEngineState, b: BudgetB): {
  ok: boolean; plans: number; outcomes: number; catWinPlans: number; failingOutcomes: number; complete: boolean;
} {
  const ct = enumCatPlanTurns(end, b);
  if (!ct.complete) {
    return { ok: false, plans: ct.plans.length, outcomes: 0, catWinPlans: 0, failingOutcomes: 0, complete: false };
  }
  let outcomes = 0;
  let catWinPlans = 0;
  let failingOutcomes = 0;
  for (const p of ct.plans) {
    if (p.outcomes.some((o) => o.phase === GamePhase.CatWins)) { catWinPlans++; continue; }
    for (const o of p.outcomes) {
      if (o.phase !== GamePhase.Playing || o.currentPlayer !== PieceType.Mouse) { failingOutcomes++; continue; }
      outcomes++;
      if (!mouseCanWinInTurn(o).win) failingOutcomes++;
    }
  }
  return {
    ok: catWinPlans === 0 && failingOutcomes === 0 && ct.plans.length > 0,
    plans: ct.plans.length, outcomes, catWinPlans, failingOutcomes, complete: true,
  };
}

test('HV18R-P3 GAME2 T4 LLLL ghost-gift formal probability', () => {
  const r = rootOf('GAME2', 4);
  expect(planText(r.plan)).toBe('LLLL');
  // Replay the production plan's raw cat chain: cat (5,5) -> (5,1).
  let cat = r.state;
  for (const a of r.plan) {
    if (a.type !== 'catStep') throw new Error('GAME2 T4 plan is not a pure cat step chain');
    cat = rules.catMove(cat, a.direction);
  }
  expect(rc(cat.catPosition)).toBe('5,1');
  expect(cat.catMovesLeft).toBe(0);

  const handoff = t4Handoff();
  expect(handoff.currentPlayer).toBe(PieceType.Mouse);
  expect(handoff.mouseMovesLeft).toBe(4);
  expect(handoff.mouseHasButter).toBe(false);
  expect(handoff.pendingButterSpawns.length).toBe(0);

  // The mouse's first move R steps onto the entity butter at (6,2).
  const pickup = simulateSearchAction(handoff, mstep('Right'), rules);
  expect(pickup.kind).toBe('chance');
  if (pickup.kind !== 'chance') throw new Error('pickup is not a chance node');
  const N = pickup.outcomes.length;
  const distinctCells = new Set(pickup.outcomes.map((o) => rc(ghostOf(o.state)!)));
  expect(distinctCells.size).toBe(N);
  for (const o of pickup.outcomes) expect(o.weight).toBeCloseTo(1 / N, 12);
  const mass = pickup.outcomes.reduce((acc, o) => acc + o.weight, 0);
  expect(mass).toBeCloseTo(1, 12);

  // Same formal support as the production spawn kernel.
  const pickupState: GameEngineState = { ...pickup.outcomes[0].state, pendingButterSpawns: [] };
  const spawnCells = enumerateButterSpawnsForState(pickupState);
  expect(spawnCells.length).toBe(N);
  expect(new Set(spawnCells.map(rc))).toEqual(distinctCells);

  // (6,6) IS a legal announcement outcome.
  const g66 = pickup.outcomes.find((o) => {
    const g = ghostOf(o.state)!;
    return g.r === 6 && g.c === 6;
  });
  expect(g66, '(6,6) is a legal ghost announcement outcome').toBeTruthy();
  const w66 = g66!.weight;

  // Legal chance-contingent mouse witness for the (6,6) branch:
  // R(pickup) -> U R K R D R R, ending on the pending ghost with 0 moves.
  let cur = g66!.state;
  const witness: string[] = [];
  for (const a of [mstep('Up'), mstep('Right'), K, mstep('Right'), mstep('Down'), mstep('Right'), mstep('Right')]) {
    const tr = simulateSearchAction(cur, a, rules);
    expect(tr.kind, `witness step ${witness.join('')} is deterministic`).toBe('deterministic');
    if (tr.kind !== 'deterministic') throw new Error('witness hit an unexpected chance node');
    cur = tr.state;
    witness.push(a.type === 'mouseSkill' ? 'K' : a.type === 'mouseStep' ? a.direction.key.replace('Arrow', '').slice(0, 1) : '?');
  }
  expect(rc(cur.mousePosition)).toBe('6,6');
  expect(cur.currentPlayer).toBe(PieceType.Cat);
  expect(cur.mouseMovesLeft).toBe(0);
  expect(cur.mouseHasButter).toBe(false); // skill consumed the butter
  const pending = ghostOf(cur);
  expect(pending && rc(pending)).toBe('6,6');

  // Every legal cat turn + every replacement-ghost outcome => the mouse wins.
  const cert66 = giftCellCertified(cur, makeBudgetB(120_000, 4_000_000));
  expect(cert66.complete, 'GAME2 T4 gift-cell cat-turn enumeration completes').toBe(true);
  expect(cert66.catWinPlans, 'no cat turn can capture the mouse at the gift cell').toBe(0);
  expect(cert66.failingOutcomes, 'every cat turn / boundary outcome lets the mouse win').toBe(0);
  expect(cert66.ok).toBe(true);

  // Concrete engine-verified win after the boundary auto-pick.
  const catTurns = enumCatPlanTurns(cur, makeBudgetB(120_000, 4_000_000));
  const handoffs = catTurns.plans[0].outcomes.filter((o) => o.phase === GamePhase.Playing);
  expect(handoffs.length).toBeGreaterThan(0);
  const afterGift = handoffs[0];
  expect(afterGift.currentPlayer).toBe(PieceType.Mouse);
  expect(afterGift.mouseHasButter).toBe(true);
  expect(afterGift.mouseMovesLeft).toBe(3);
  expect(mouseCanWinInTurn(afterGift).win).toBe(true);
  let winState = afterGift;
  const winRoute = ['Right', 'Right', 'Down'];
  for (const key of winRoute) {
    const tr = simulateSearchAction(winState, mstep(key), rules);
    expect(tr.kind).toBe('deterministic');
    if (tr.kind !== 'deterministic') throw new Error('win route hit a chance node');
    // eslint-disable-next-line no-console
    console.log(`winRoute ${key}: ${rc(winState.mousePosition)} -> ${rc(tr.state.mousePosition)} phase=${tr.state.phase} moves=${tr.state.mouseMovesLeft} carry=${tr.state.mouseHasButter} cell=${tr.state.board[tr.state.mousePosition.r][tr.state.mousePosition.c].type}`);
    winState = tr.state;
  }
  expect(winState.phase).toBe(GamePhase.MouseWins);

  // Gift-cell census: which announcement cells are reachable AND certified?
  const mt = enumMouseTurnsB(pickupState, makeBudgetB(120_000, 4_000_000));
  expect(mt.complete, 'GAME2 T4 mouse-turn enumeration completes').toBe(true);
  const byPos = new Map<string, GameEngineState>();
  for (const e of mt.ends) {
    if (e.phase !== GamePhase.Playing || e.currentPlayer !== PieceType.Cat) continue;
    if (e.butterPositions.length !== pickupState.butterPositions.length) continue; // no second pickup
    if ((e.pendingButterSpawns ?? []).length !== 0) continue;
    const k = rc(e.mousePosition);
    if (!byPos.has(k)) byPos.set(k, e);
  }
  const catPos = pickupState.catPosition;
  const gift: string[] = [];
  const giftRoutes: string[] = [];
  const reachableSpawns: string[] = [];
  const rejected: string[] = [];
  for (const c of spawnCells) {
    const key = rc(c);
    const end = byPos.get(key);
    if (!end) continue;
    reachableSpawns.push(key);
    const withGhost: GameEngineState = {
      ...end,
      pendingButterSpawns: [{ r: c.r, c: c.c, blockedMaterializations: 0 }],
    };
    // Cheap necessary condition first: the cat must not be able to step onto
    // the cell inside its own turn (otherwise giftCellCertified is the oracle).
    const reach = Math.abs(catPos.r - c.r) + Math.abs(catPos.c - c.c);
    if (reach <= end.config.catBaseMoves) {
      rejected.push(`${key}:cat-reach(${reach})`);
      continue;
    }
    const cert = giftCellCertified(withGhost, makeBudgetB(120_000, 2_000_000));
    if (cert.ok) {
      gift.push(key);
      giftRoutes.push(`${key}=${mt.labels.get(stateKey(end)) ?? '?'}`);
    } else {
      rejected.push(`${key}:cert(catWinPlans=${cert.catWinPlans},failingOutcomes=${cert.failingOutcomes})`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nHV18R-P3 GAME2 T4 LLLL ghost gift`
    + `\n  cat plan=${planText(r.plan)} handoff mouse=${rc(handoff.mousePosition)} moves=${handoff.mouseMovesLeft}`
    + `\n  pickup butter at (6,2): announcement outcomes N=${N} weight=1/${N}=${(1 / N).toFixed(6)} mass=${mass}`
    + `\n  (6,6) legal=${Boolean(g66)} weight=${w66.toFixed(6)} witness=R${witness.join('')}`
    + `\n  spawn cells: ${spawnCells.map(rc).join(' ')}`
    + `\n  gift-cell census reachable=${reachableSpawns.length}/${N} [${reachableSpawns.join(' ')}] certified=${gift.length}/${N} [${gift.join(' ')}]`
    + `\n  gift routes: ${giftRoutes.join(' ')}`
    + `\n  reachable-but-not-certified: ${rejected.join(' ') || '(none)'}`
    + `\n  T4_RISK_PROBABILITY_LOWER_BOUND = ${gift.length}/${N} = ${(gift.length / N).toFixed(6)}`
    + `\n  gift proof plans=${cert66.plans} outcomes=${cert66.outcomes} catWinPlans=${cert66.catWinPlans} failingOutcomes=${cert66.failingOutcomes}`
    + `\n  post-gift handoff: mouse=${rc(afterGift.mousePosition)} carry=${afterGift.mouseHasButter} moves=${afterGift.mouseMovesLeft}`
    + ` winRoute=${winRoute.map((k) => k[0]).join('')} phase=${winState.phase}`,
  );

  expect(gift.includes('6,6'), '(6,6) is a certified gift cell').toBe(true);
  expect(gift.length / N).toBeGreaterThanOrEqual(w66);
  expect(gift.length).toBeGreaterThan(0);
}, 240_000);

// ===========================================================================
// HV18R-P5.1 — every-outcome safety (probability-1 safe within the horizon)
// ===========================================================================

// A blocked ghost (block count 1, cell occupied by a butter) forces a reroll:
// the boundary node is a genuine multi-outcome CHANCE node. The mouse is far
// from its hole and not carrying, so every reroll outcome is safe at h=1.
function blockedGhostRerollState(): GameEngineState {
  const handoff = t4Handoff();
  return {
    ...handoff,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 0,
    pendingButterSpawns: [{ r: 6, c: 2, blockedMaterializations: 1 }],
    pendingButterPlacementDebt: 0,
  };
}

test('HV18R-P5.1 all-outcome safety (probability-1 safe within h=1)', () => {
  const s = blockedGhostRerollState();
  const outcomes = enumerateGhostBoundaryOutcomes(s);
  expect(outcomes.length).toBeGreaterThan(1);
  const mass = outcomes.reduce((a, o) => a + o.weight, 0);
  expect(mass).toBeCloseTo(1, 12);
  const solver = makeSolverB(60_000, 2_000_000);
  let safe = 0;
  for (const o of outcomes) {
    expect(o.state.currentPlayer).toBe(PieceType.Mouse);
    expect(solver.mouseSafe(o.state, 1)).toBe('yes');
    safe++;
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV18R-P5.1 all-outcome safety: outcomes=${outcomes.length} safe=${safe} mass=${mass}`);
  expect(safe).toBe(outcomes.length);
}, 120_000);

// ===========================================================================
// HV18R-P5.2 — only SOME positive-probability outcomes fail
// ===========================================================================

test('HV18R-P5.2 partial-failure chance node', () => {
  const handoff = t4Handoff();
  const pickup = simulateSearchAction(handoff, mstep('Right'), rules);
  if (pickup.kind !== 'chance') throw new Error('pickup is not a chance node');
  const byCell = new Map<string, GameEngineState>();
  for (const o of pickup.outcomes) byCell.set(rc(ghostOf(o.state)!), o.state);

  // Deadly branch: the announced ghost is where the mouse can end and get the
  // gift (solver: mouseSafe h=2 = 'no').
  const deadly = byCell.get('6,6');
  expect(deadly).toBeTruthy();
  // Safe branch: a far ghost the mouse cannot reach (proved safe at h=2).
  const far = byCell.get('1,8');
  expect(far, '(1,8) is a legal announcement outcome').toBeTruthy();

  const solver = makeSolverB(240_000, 8_000_000);
  const dead = solver.mouseSafe(deadly!, 2);
  const safe = solver.mouseSafe(far!, 2);
  const N = pickup.outcomes.length;
  // eslint-disable-next-line no-console
  console.log(
    `\nHV18R-P5.2 partial failure: N=${N}`
    + ` (6,6) weight=${(1 / N).toFixed(6)} mouseSafe(h=2)=${dead}`
    + ` (1,8) weight=${(1 / N).toFixed(6)} mouseSafe(h=2)=${safe}`
    + ` => failing set is a PROPER subset of the chance support (not probability 1)`,
  );
  expect(dead).toBe('no');
  expect(safe).toBe('yes');
}, 300_000);

// ===========================================================================
// HV18R-P5.3 — probability-one mouse win (legal construction)
// ===========================================================================

test('HV18R-P5.3 probability-one mouse win after the gift', () => {
  const r = rootOf('GAME2', 4);
  const prod = applyCatPlan(r.state, r.plan);
  const handoff = prod.chanceStates[0] ?? prod.end;
  const pickup = simulateSearchAction(handoff, mstep('Right'), rules);
  if (pickup.kind !== 'chance') throw new Error('pickup is not a chance node');
  const g66 = pickup.outcomes.find((o) => {
    const g = ghostOf(o.state)!;
    return g.r === 6 && g.c === 6;
  })!;
  let cur = g66.state;
  for (const a of [mstep('Up'), mstep('Right'), K, mstep('Right'), mstep('Down'), mstep('Right'), mstep('Right')]) {
    const tr = simulateSearchAction(cur, a, rules);
    if (tr.kind !== 'deterministic') throw new Error('witness hit a chance node');
    cur = tr.state;
  }
  const ct = enumCatPlanTurns(cur, makeBudgetB(120_000, 4_000_000));
  for (const p of ct.plans) {
    for (const o of p.outcomes) {
      if (o.phase !== GamePhase.Playing) throw new Error(`cat turn ended the game: ${o.phase}`);
      const w = mouseCanWinInTurn(o);
      expect(w.win && w.complete, `mouse wins after cat plan ${p.label}`).toBe(true);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV18R-P5.3 probability-one mouse win: cat plans=${ct.plans.length}, every boundary outcome => immediate MouseWins`);
}, 120_000);

// ===========================================================================
// HV18R-P5.4 — chance branch order does not change probability
// ===========================================================================

test('HV18R-P5.4 chance branch order invariance', () => {
  const handoff = t4Handoff();
  // Two blocked ghosts (block count 1 on entity-butter cells) => two reroll
  // requests => uniform k-subsets; the array order must not change weights.
  const base: GameEngineState = {
    ...handoff,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 0,
    pendingButterSpawns: [
      { r: 6, c: 2, blockedMaterializations: 1 },
      { r: 3, c: 5, blockedMaterializations: 1 },
    ],
    pendingButterPlacementDebt: 0,
  };
  const permuted: GameEngineState = {
    ...base,
    pendingButterSpawns: [...base.pendingButterSpawns].reverse(),
  };
  const a = enumerateGhostBoundaryOutcomes(base);
  const b = enumerateGhostBoundaryOutcomes(permuted);
  expect(a.length).toBeGreaterThan(1);
  expect(a.length).toBe(b.length);
  const massA = a.reduce((x, o) => x + o.weight, 0);
  const massB = b.reduce((x, o) => x + o.weight, 0);
  expect(massA).toBeCloseTo(1, 12);
  expect(massB).toBeCloseTo(1, 12);
  const weightByKey = (list: { state: GameEngineState; weight: number }[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const o of list) m.set(stateKey(o.state), (m.get(stateKey(o.state)) ?? 0) + o.weight);
    return m;
  };
  const ma = weightByKey(a);
  const mb = weightByKey(b);
  expect([...ma.keys()].sort()).toEqual([...mb.keys()].sort());
  for (const [k, v] of ma) expect(mb.get(k)!).toBeCloseTo(v, 12);
  // eslint-disable-next-line no-console
  console.log(`\nHV18R-P5.4 branch order: outcomes=${a.length} weight=${a[0].weight.toFixed(6)} massA=${massA} massB=${massB} identical=${[...ma.keys()].every((k) => Math.abs((mb.get(k) ?? -1) - ma.get(k)!) < 1e-12)}`);
}, 120_000);

// ===========================================================================
// HV18R-P5.5 — dedupe of equivalent outcomes conserves mass
// ===========================================================================

test('HV18R-P5.5 dedupe conserves probability mass', () => {
  const handoff = t4Handoff();
  const pickup = simulateSearchAction(handoff, mstep('Right'), rules);
  if (pickup.kind !== 'chance') throw new Error('pickup is not a chance node');
  const N = pickup.outcomes.length;
  const keyed = new Map<string, number>();
  for (const o of pickup.outcomes) {
    const k = stateKey(o.state);
    keyed.set(k, (keyed.get(k) ?? 0) + o.weight);
  }
  // All announcement outcomes are distinct states, and the summed mass is 1.
  expect(keyed.size).toBe(N);
  const summed = [...keyed.values()].reduce((a, b) => a + b, 0);
  expect(summed).toBeCloseTo(1, 12);

  // Synthetic duplicate branches: two different outcomes of the SAME state
  // must be summed, not dropped. Dedupe-without-sum loses mass.
  const s = pickup.outcomes[0].state;
  const dup = [
    { state: s, weight: 0.25 },
    { state: s, weight: 0.25 },
    { state: pickup.outcomes[1].state, weight: 0.5 },
  ];
  const summedDup = new Map<string, number>();
  for (const o of dup) summedDup.set(stateKey(o.state), (summedDup.get(stateKey(o.state)) ?? 0) + o.weight);
  const droppedDup = new Map<string, number>();
  for (const o of dup) if (!droppedDup.has(stateKey(o.state))) droppedDup.set(stateKey(o.state), o.weight);
  const sumSummed = [...summedDup.values()].reduce((a, b) => a + b, 0);
  const sumDropped = [...droppedDup.values()].reduce((a, b) => a + b, 0);
  // eslint-disable-next-line no-console
  console.log(`\nHV18R-P5.5 dedupe: N=${N} summedMass=${summed} synthetic summed=${sumSummed} first-wins=${sumDropped}`);
  expect(sumSummed).toBeCloseTo(1, 12);
  expect(sumDropped).toBeCloseTo(0.75, 12);
}, 60_000);

// ===========================================================================
// HV18R-P5.6 — UNKNOWN / INCOMPLETE is never WIN or SAFE
// ===========================================================================

test('HV18R-P5.6 incomplete is not promoted', () => {
  const r = rootOf('GAME2', 4);
  const tiny = makeSolverB(20, 50);
  const chk = checkCatPlan(tiny, r.state, r.plan, 2);
  expect(chk.status).toBe('incomplete');
  expect(chk.status).not.toBe('survives');
  expect(chk.status).not.toBe('refuted');
  const tri = tiny.catSurvives(r.state, 2).tri;
  expect(tri).toBe('incomplete');
  // And a capped solver inside mouseSafe returns 'incomplete', never 'yes'.
  const tiny2 = makeSolverB(20, 50);
  const handoff = t4Handoff();
  expect(tiny2.mouseSafe(handoff, 2)).toBe('incomplete');
  // eslint-disable-next-line no-console
  console.log(`\nHV18R-P5.6 incomplete: checkCatPlan=${chk.status} reason=${chk.reason} catSurvives=${tri}`);
}, 60_000);

// ===========================================================================
// HV18R-P4 — DUDU / RUDD bounded robust survival at h=2 (re-verified)
// ===========================================================================

test('HV18R-P4 DUDU and RUDD bounded robust survival (h=2)', () => {
  const r = rootOf('GAME2', 4);
  const dudu = [step('Down'), step('Up'), step('Down'), step('Up')];
  const rudd = [step('Right'), step('Up'), step('Down'), step('Down')];
  const solver = makeSolverB(240_000, 8_000_000);
  const cDudu = checkCatPlan(solver, r.state, dudu, 2);
  const cRudd = checkCatPlan(solver, r.state, rudd, 2);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV18R-P4 DUDU/RUDD bounded safety`
    + `\n  DUDU=${cDudu.status} outcomes=${cDudu.outcomeCount} reason=${cDudu.reason}`
    + `\n  RUDD=${cRudd.status} outcomes=${cRudd.outcomeCount} reason=${cRudd.reason}`
    + `\n  transitions=${solver.budget.transitions} overflow=${solver.budget.overflow ?? 'none'}`,
  );
  expect(cDudu.status).toBe('survives');
  expect(cRudd.status).toBe('survives');
  expect(solver.budget.overflow).toBeNull();
}, 300_000);

// ===========================================================================
// HV18R-T8 — root plan census only (no per-plan tree re-enumeration)
// ===========================================================================

test('HV18R-T8 root plan census (no tree re-enumeration)', () => {
  const r = rootOf('GAME4', 8);
  const ct = enumCatPlanTurns(r.state, makeBudgetB(120_000, 4_000_000));
  // eslint-disable-next-line no-console
  console.log(
    `\nHV18R-T8 root plan census: plans=${ct.plans.length} complete=${ct.complete}`
    + ` chanceLeaves=${ct.chanceLeaves} chanceOutcomes=${ct.chanceOutcomes} transitions=${ct.transitions}`
    + `\n  stored HV18-5 aggregate: catSurvives(h=2)=no, overflow=none, transitions=68535`
    + ` => all plans carry a positive-risk refutation; NO probability-one loss proof`,
  );
  expect(ct.complete).toBe(true);
  expect(ct.plans.length).toBeGreaterThan(0);
}, 120_000);
