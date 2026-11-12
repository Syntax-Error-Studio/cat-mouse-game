/// <reference types="node" />
/**
 * PPC-HV16 — GAME2 T7 real Cat→Mouse→Cat alternation (read-only on production).
 *
 * P1 re-proves the HV15 facts byte-for-byte, including the +31.58 advantage of
 * UUUU over LURD under the depth-2 (mouse turn + cat turn + leaf) search.
 * P2 replaces the search with an INDEPENDENT exhaustive minimax enumerator that
 * applies the real rule kernel action-by-action, resolves every CHANCE node
 * with its real enumerated weights, scores terminals with the real mate values,
 * and evaluates H1 only at the horizon:
 *
 *   V(P) = min_{m in M(P)} max_{c in C(P,m)} E_chance[H1(s)]
 *
 * P3 reports the per-plan census; P4 runs the reverse controls. No production
 * file is edited; no weight, budget, depth, rule or seed changes.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createEngineRuleSet } from '../../engine';
import type { GameEngineState } from '../../engine';
import { DIRECTIONS, GamePhase, PieceType } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { createSearchContext, searchBestAction } from '../expectiminimax';
import { generateLegalSearchActions } from '../legalActions';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import type { SearchAction, SearchTransitionResult } from '../searchTypes';

const LOG = new URL('../../../../ai-training/human-logs/PPC-HV14/GAME2_H1.txt', import.meta.url);
const rules = createEngineRuleSet();
const MATE_SCORE = 1_000_000;
const NODE_CAP = 2_000_000;

function turnBytes(turn: number): { lines: string[]; key: string; plan: SearchAction[]; execKey: string } {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
  const s = lines.findIndex((l) => l.trim() === `Turn #${turn}`);
  if (s < 0) throw new Error(`T${turn} not found`);
  let e = lines.findIndex((l, i) => i > s && /^Turn #\d+$/.test(l.trim()));
  if (e < 0) e = lines.length;
  const seg = lines.slice(s + 1, e);
  const f = (p: string): string => seg.find((l) => l.startsWith(p))?.slice(p.length).trim() ?? '';
  return { lines: seg, key: f('STATE_KEY='), plan: parsePlan(f('PLAN:')), execKey: f('EXEC:').replace(/^endState=/, '').split(/\s+/)[0] };
}

function root(turn: number): GameEngineState {
  const t = turnBytes(turn);
  const snap = JSON.parse(t.lines.find((l) => l.startsWith('SNAPSHOT_JSON='))!.slice(14)) as HardRootSnapshot;
  return restoreHardRoot(snap);
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

const token = (a: SearchAction): string =>
  a.type === 'catPlaceTrap' ? 'T' : a.type === 'catStep' ? a.direction!.key.replace('Arrow', '').slice(0, 1) : '?';
const planText = (p: SearchAction[]): string => p.map(token).join('');
const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;
const step = (key: string): SearchAction => ({ type: 'catStep', direction: DIRECTIONS.find((d) => d.key === key)! });

const LURD = [step('ArrowLeft'), step('ArrowUp'), step('ArrowRight'), step('ArrowDown')];
const UUUU = [step('ArrowUp'), step('ArrowUp'), step('ArrowUp'), step('ArrowUp')];

const actionText = (a: SearchAction): string => {
  switch (a.type) {
    case 'catStep': return a.direction!.key.replace('Arrow', '')[0];
    case 'catPlaceTrap': return 'T';
    case 'mouseStep': return a.direction!.key.replace('Arrow', '')[0].toLowerCase();
    case 'mouseSkill': return 'SK';
    case 'chooseTunnel': return `EXIT(${a.r},${a.c})`;
  }
};
const seqText = (as: SearchAction[]): string => (as.length ? as.map(actionText).join('') : '-');
const isTerminal = (s: GameEngineState): boolean => s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins;

function replayPlan(start: GameEngineState, plan: SearchAction[]): { state: GameEngineState; chance: SearchTransitionResult | null } {
  let cur = start;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') return { state: cur, chance: t };
    cur = t.state;
  }
  return { state: cur, chance: null };
}

function searchDepth(catEnd: GameEngineState, depth: number): { value: number; nodes: number; completed: boolean } {
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  const res = searchBestAction(catEnd, depth, ctx);
  return { value: res.value, nodes: ctx.diagnostics.nodes, completed: res.completed };
}

// ---------------------------------------------------------------------------
// P1 — reproduction
// ---------------------------------------------------------------------------
test('HV16-P1 T7 root + plan replay + HV15 +31.58 reproduction', () => {
  const t = turnBytes(7);
  const r = root(7);
  expect(stateKey(r), 'T7 snapshot re-hashes to the logged STATE_KEY').toBe(t.key);
  expect(planText(t.plan)).toBe('LURD');

  const lumd = replayPlan(r, LURD);
  const uuuu = replayPlan(r, UUUU);
  expect(lumd.chance, 'LURD full turn is deterministic').toBeNull();
  expect(uuuu.chance, 'UUUU full turn is deterministic').toBeNull();
  expect(lumd.state.currentPlayer).toBe(PieceType.Mouse);
  expect(uuuu.state.currentPlayer).toBe(PieceType.Mouse);
  expect(lumd.state.catMovesLeft).toBe(0);
  expect(uuuu.state.catMovesLeft).toBe(0);
  expect(rc(lumd.state.catPosition)).toBe('6,6');
  expect(rc(uuuu.state.catPosition)).toBe('2,6');
  expect(lumd.state.mousePosition).toEqual(r.mousePosition);
  expect(uuuu.state.mousePosition).toEqual(r.mousePosition);
  expect(lumd.state.pendingButterSpawns.length).toBe(0);
  expect(uuuu.state.pendingButterSpawns.length).toBe(0);

  const d1l = searchDepth(lumd.state, 1);
  const d1u = searchDepth(uuuu.state, 1);
  const d2l = searchDepth(lumd.state, 2);
  const d2u = searchDepth(uuuu.state, 2);

  // eslint-disable-next-line no-console
  console.log(
    `\nHV16-P1 T7 root\n  STATE_KEY=${t.key}\n  cat=${rc(r.catPosition)} mouse=${rc(r.mousePosition)}`
    + ` butter=[${r.butterPositions.map(rc).join('|')}] trap=${r.trapPosition ? rc(r.trapPosition) : 'none'}`
    + ` trapsLeft=${r.catTrapsRemaining} moves=${r.catMovesLeft}/${r.mouseMovesLeft}`
    + ` hasButter=${r.mouseHasButter} pendingGhosts=${r.pendingButterSpawns.length} debt=${r.pendingButterPlacementDebt ?? 0}\n`
    + `  LURD end=${stateKey(lumd.state)}\n`
    + `    D1 v=${d1l.value} (${d1l.nodes}n)  D2 v=${d2l.value} (${d2l.nodes}n, completed=${d2l.completed})\n`
    + `  UUUU end=${stateKey(uuuu.state)}\n`
    + `    D1 v=${d1u.value} (${d1u.nodes}n)  D2 v=${d2u.value} (${d2u.nodes}n, completed=${d2u.completed})\n`
    + `  D2 gap UUUU-LURD = ${d2u.value - d2l.value}`,
  );

  expect(d1l.value).toBe(-914.5263157894738);
  expect(d1u.value).toBe(-1467.8157894736842);
  expect(d2l.value).toBe(-1314.5263157894738);
  expect(d2u.value).toBe(-1282.9473684210527);
  expect(d2u.value - d2l.value).toBe(31.57894736842104);
  expect(d2l.completed && d2u.completed).toBe(true);
}, 300000);

// ---------------------------------------------------------------------------
// P2 machinery — exhaustive, real-rule alternation value
// ---------------------------------------------------------------------------
interface TurnLine {
  state: GameEngineState;
  actions: SearchAction[];
  weight: number;
}

interface TurnCensus {
  lines: TurnLine[];
  chanceNodes: number;
  chanceOutcomes: number;
  truncated: boolean;
}

/** Enumerate every complete legal turn of `actor`, branching real CHANCE nodes. */
function enumerateFullTurns(start: GameEngineState, actor: PieceType, cap = 200_000): TurnCensus {
  const lines: TurnLine[] = [];
  const chanceKeys = new Set<string>();
  let chanceOutcomes = 0;
  let truncated = false;
  const walk = (s: GameEngineState, actions: SearchAction[], weight: number, guard: Set<string>): void => {
    if (truncated) return;
    if (lines.length >= cap) { truncated = true; return; }
    if (isTerminal(s)) { lines.push({ state: s, actions, weight }); return; }
    if (s.currentPlayer !== actor) { lines.push({ state: s, actions, weight }); return; }
    const acts = generateLegalSearchActions(s, rules);
    if (acts.length === 0) { lines.push({ state: s, actions, weight }); return; }
    const k = stateKey(s);
    if (guard.has(k)) { lines.push({ state: s, actions, weight }); return; }
    guard.add(k);
    for (const a of acts) {
      const tr = simulateSearchAction(s, a, rules);
      if (tr.kind === 'chance') {
        chanceKeys.add(k);
        chanceOutcomes += tr.outcomes.length;
        for (const o of tr.outcomes) walk(o.state, [...actions, a], weight * o.weight, guard);
      } else {
        walk(tr.state, [...actions, a], weight, guard);
      }
    }
    guard.delete(k);
  };
  walk(start, [], 1, new Set<string>());
  return { lines, chanceNodes: chanceKeys.size, chanceOutcomes, truncated };
}

interface ValueStats {
  calls: number;
  uniqueNodes: number;
  h1Leaves: number;
  terminalCat: number;
  terminalMouse: number;
  chanceNodes: number;
  chanceOutcomes: number;
  evalCalls: number;
  truncated: boolean;
  cap: number;
}

class IncompleteSearch extends Error {}

/** Exhaustive minimax over turn depth with real CHANCE weights; H1 at horizon. */
class AlternationValue {
  private readonly memo = new Map<string, number>();
  private readonly leafMemo = new Map<string, number>();
  private readonly reverse: boolean;
  readonly stats: ValueStats;

  constructor(cap: number = NODE_CAP, reverse = false) {
    this.reverse = reverse;
    this.stats = {
      calls: 0, uniqueNodes: 0, h1Leaves: 0, terminalCat: 0, terminalMouse: 0,
      chanceNodes: 0, chanceOutcomes: 0, evalCalls: 0, truncated: false, cap,
    };
  }

  /** V from a mouse-to-move state: turns = 2 (mouse turn, cat turn, H1). */
  value(s: GameEngineState, turns: number): number {
    this.stats.calls++;
    const k = `${stateKey(s)}|${turns}`;
    const hit = this.memo.get(k);
    if (hit !== undefined) return hit;
    this.stats.uniqueNodes++;
    if (this.stats.uniqueNodes > this.stats.cap) {
      this.stats.truncated = true;
      throw new IncompleteSearch('INCOMPLETE_NODE_CAP');
    }

    let v: number;
    if (s.phase === GamePhase.CatWins) {
      this.stats.terminalCat++;
      v = MATE_SCORE;
    } else if (s.phase === GamePhase.MouseWins) {
      this.stats.terminalMouse++;
      v = -MATE_SCORE;
    } else if (turns <= 0) {
      this.stats.h1Leaves++;
      v = this.leaf(s);
    } else {
      let acts = generateLegalSearchActions(s, rules);
      if (this.reverse) acts = [...acts].reverse();
      if (acts.length === 0) {
        this.stats.h1Leaves++;
        v = this.leaf(s);
      } else {
        const maximizing = s.currentPlayer === PieceType.Cat;
        let best = maximizing ? -Infinity : Infinity;
        for (const a of acts) {
          const av = this.after(s, a, turns, true);
          if (maximizing ? av > best : av < best) best = av;
        }
        v = best;
      }
    }
    this.memo.set(k, v);
    return v;
  }

  /** Value of applying one action; CHANCE nodes use the enumerated real weights. */
  after(s: GameEngineState, a: SearchAction, turns: number, count: boolean): number {
    const tr = simulateSearchAction(s, a, rules);
    if (tr.kind === 'deterministic') {
      const switched = s.currentPlayer !== tr.state.currentPlayer;
      return this.value(tr.state, turns - (switched ? 1 : 0));
    }
    if (count) {
      this.stats.chanceNodes++;
      this.stats.chanceOutcomes += tr.outcomes.length;
    }
    const switched = tr.outcomes.length > 0 && s.currentPlayer !== tr.outcomes[0].state.currentPlayer;
    let sum = 0;
    for (const o of tr.outcomes) sum += o.weight * this.value(o.state, turns - (switched ? 1 : 0));
    return sum;
  }

  private leaf(s: GameEngineState): number {
    const k = stateKey(s);
    const hit = this.leafMemo.get(k);
    if (hit !== undefined) return hit;
    this.stats.evalCalls++;
    const v = evaluateCorrectedHoleForCat(s);
    this.leafMemo.set(k, v);
    return v;
  }

  /** Greedy principal line (values are exact, so this is a true best response). */
  principal(start: GameEngineState, turns: number): {
    mouseActions: SearchAction[];
    mouseEnd: GameEngineState;
    catActions: SearchAction[];
    catEnd: GameEngineState;
    chanceAtEnd: number[];
  } {
    const mouseActions: SearchAction[] = [];
    const catActions: SearchAction[] = [];
    const chanceAtEnd: number[] = [];
    let s = start;
    let t = turns;
    let mouseEnd = start;
    while (!isTerminal(s) && t > 0) {
      let acts = generateLegalSearchActions(s, rules);
      if (acts.length === 0) break;
      if (this.reverse) acts = [...acts].reverse();
      const maximizing = s.currentPlayer === PieceType.Cat;
      let bestA: SearchAction = acts[0];
      let bestV = maximizing ? -Infinity : Infinity;
      for (const a of acts) {
        const av = this.after(s, a, t, false);
        if (maximizing ? av > bestV : av < bestV) { bestV = av; bestA = a; }
      }
      const actor = s.currentPlayer;
      if (actor === PieceType.Mouse) mouseActions.push(bestA); else catActions.push(bestA);
      const tr = simulateSearchAction(s, bestA, rules);
      const prevPlayer = s.currentPlayer;
      if (tr.kind === 'chance') {
        const top = Math.max(...tr.outcomes.map((o) => o.weight));
        const pick = tr.outcomes.find((o) => o.weight === top)!;
        if (actor === PieceType.Cat) chanceAtEnd.push(top);
        s = pick.state;
        t -= prevPlayer !== s.currentPlayer ? 1 : 0;
      } else {
        s = tr.state;
        t -= prevPlayer !== s.currentPlayer ? 1 : 0;
      }
      if (actor === PieceType.Mouse && s.currentPlayer !== PieceType.Mouse) mouseEnd = s;
    }
    return { mouseActions, mouseEnd, catActions, catEnd: s, chanceAtEnd };
  }
}

function computeV(start: GameEngineState, turns = 2, opts: { reverse?: boolean } = {}) {
  const e = new AlternationValue(NODE_CAP, opts.reverse ?? false);
  try {
    const value = e.value(start, turns);
    const pv = e.principal(start, turns);
    return { value, stats: e.stats, pv, incomplete: false as const };
  } catch (err) {
    if (err instanceof IncompleteSearch) {
      return { value: null, stats: e.stats, pv: null, incomplete: true as const };
    }
    throw err;
  }
}

const boardDiff = (a: GameEngineState, b: GameEngineState): string[] => {
  const out: string[] = [];
  for (let r = 0; r < a.config.boardSize; r++) {
    for (let c = 0; c < a.config.boardSize; c++) {
      const x = a.board[r][c];
      const y = b.board[r][c];
      if (x.type !== y.type || x.hasButter !== y.hasButter) out.push(`(${r},${c})`);
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// P2/P3 — LURD vs UUUU under real alternation
// ---------------------------------------------------------------------------
test('HV16-P2/P3 exhaustive real-alternation value V(P)', () => {
  const r = root(7);
  const plans = [{ name: 'LURD', plan: LURD }, { name: 'UUUU', plan: UUUU }];
  const rows: string[] = [];
  const out: Record<string, { V: number; d2: number; mouseLines: number; mouseEnds: number; catLines: number; catEnds: number; nodes: number; h1Leaves: number; evals: number; x: ReturnType<typeof computeV>; catEndStates: Map<string, GameEngineState>; mouseEndStates: Map<string, GameEngineState> }> = {};

  for (const { name, plan } of plans) {
    const rec = replayPlan(r, plan);
    expect(rec.chance, `${name} plan turn is deterministic`).toBeNull();
    const s0 = rec.state;
    expect(s0.currentPlayer).toBe(PieceType.Mouse);

    const mouseTurn = enumerateFullTurns(s0, PieceType.Mouse);
    expect(mouseTurn.truncated, `${name} mouse enumeration complete`).toBe(false);
    const mouseEndStates = new Map<string, GameEngineState>();
    let terminalMouseLeaves = 0;
    for (const l of mouseTurn.lines) {
      if (isTerminal(l.state)) { terminalMouseLeaves++; continue; }
      expect(l.state.currentPlayer, `${name} every mouse line hands off to the cat`).toBe(PieceType.Cat);
      mouseEndStates.set(stateKey(l.state), l.state);
    }

    let catLines = 0;
    let catChance = 0;
    const catEndStates = new Map<string, GameEngineState>();
    for (const [, s] of mouseEndStates) {
      const ct = enumerateFullTurns(s, PieceType.Cat);
      expect(ct.truncated, `${name} cat enumeration complete`).toBe(false);
      catChance += ct.chanceNodes;
      for (const l of ct.lines) {
        catLines++;
        if (!isTerminal(l.state)) {
          expect(l.state.currentPlayer, `${name} every cat line hands off to the mouse`).toBe(PieceType.Mouse);
          expect(l.state.catMovesLeft, `${name} cat budget is fully spent`).toBe(0);
        }
        catEndStates.set(stateKey(l.state), l.state);
      }
    }

    const x = computeV(s0, 2);
    expect(x.incomplete, `${name} exhaustive value complete (cap ${NODE_CAP})`).toBe(false);
    const pv = x.pv!;
    // the worst mouse response must itself hand off to the cat
    expect(pv.mouseActions.length).toBeGreaterThan(0);
    expect(pv.mouseEnd.currentPlayer).toBe(PieceType.Cat);
    const d2 = searchDepth(s0, 2);
    const V = x.value!;

    const h1PlanEnd = evaluateCorrectedHoleForCat(s0);
    const h1AfterWorstMouse = evaluateCorrectedHoleForCat(pv.mouseEnd);
    const h1AfterBestCat = isTerminal(pv.catEnd)
      ? (pv.catEnd.phase === GamePhase.CatWins ? MATE_SCORE : -MATE_SCORE)
      : evaluateCorrectedHoleForCat(pv.catEnd);
    rows.push(
      `${name} end=${rc(s0.catPosition)}`
      + ` | mouse: lines=${mouseTurn.lines.length} uniqueEnds=${mouseEndStates.size} chance=${mouseTurn.chanceNodes}/${mouseTurn.chanceOutcomes} terminalLines=${terminalMouseLeaves}`
      + ` | cat: plans=${catLines} uniqueEnds=${catEndStates.size} chance=${catChance}`
      + ` | H1 planEnd=${h1PlanEnd.toFixed(6)} afterWorstMouse=${h1AfterWorstMouse.toFixed(6)} afterBestCat=${h1AfterBestCat.toFixed(6)}`
      + ` | V=${V.toFixed(10)} searchD2=${d2.value.toFixed(10)} match=${V === d2.value}`
      + ` | nodes=${x.stats.uniqueNodes} h1Leaves=${x.stats.h1Leaves} evals=${x.stats.evalCalls}`
      + ` chanceNodes=${x.stats.chanceNodes} terminal=${x.stats.terminalCat}C/${x.stats.terminalMouse}M`
      + ` | worstMouse=${seqText(pv.mouseActions)} -> (${rc(pv.mouseEnd.catPosition)}/${rc(pv.mouseEnd.mousePosition)}/${pv.mouseEnd.currentPlayer})`
      + ` | catBest=${seqText(pv.catActions)} -> (${rc(pv.catEnd.catPosition)}/${rc(pv.catEnd.mousePosition)}) H1=${V.toFixed(10)}`,
    );
    out[name] = {
      V, d2: d2.value, mouseLines: mouseTurn.lines.length, mouseEnds: mouseEndStates.size,
      catLines, catEnds: catEndStates.size, nodes: x.stats.uniqueNodes, h1Leaves: x.stats.h1Leaves,
      evals: x.stats.evalCalls, x, catEndStates, mouseEndStates,
    };
  }

  const gap = out.UUUU.V - out.LURD.V;
  const endL = out.LURD.x.pv!.catEnd;
  const endU = out.UUUU.x.pv!.catEnd;
  // eslint-disable-next-line no-console
  console.log(
    `\nHV16-P2/P3 exhaustive alternation (root GAME2 T7, node cap ${NODE_CAP})\n  ${rows.join('\n  ')}\n`
    + `  V(UUUU)-V(LURD) = ${gap}\n`
    + `  HV15 horizon gap = ${out.UUUU.d2 - out.LURD.d2}\n`
    + `  principal horizon: sameCoords=${rc(endL.catPosition) === rc(endU.catPosition) && rc(endL.mousePosition) === rc(endU.mousePosition)}`
    + ` sameKey=${stateKey(endL) === stateKey(endU)} boardDiff=${boardDiff(endL, endU).join(',') || '(none)'}`
    + ` H1=${evaluateCorrectedHoleForCat(endL).toFixed(6)}/${evaluateCorrectedHoleForCat(endU).toFixed(6)}`,
  );

  // P1 gate: the independent enumerator must reproduce the search's deeper value.
  expect(out.LURD.V).toBe(-1314.5263157894738);
  expect(out.UUUU.V).toBe(-1282.9473684210527);
  expect(out.LURD.V).toBe(out.LURD.d2);
  expect(out.UUUU.V).toBe(out.UUUU.d2);
  expect(gap).toBe(31.57894736842104);
}, 300000);

// ---------------------------------------------------------------------------
// P4 — reverse controls
// ---------------------------------------------------------------------------
test('HV16-P4 reverse controls', () => {
  const r = root(7);
  const s0 = replayPlan(r, LURD).state;
  const s0u = replayPlan(r, UUUU).state;
  const base = computeV(s0, 2);
  const baseU = computeV(s0u, 2);
  expect(base.incomplete || baseU.incomplete).toBe(false);
  const baseV = base.value!;
  const baseUV = baseU.value!;

  // 1) mouse enumeration order reversed -> same value
  const rev = computeV(s0, 2, { reverse: true });
  const revU = computeV(s0u, 2, { reverse: true });
  expect(rev.value, 'reversed mouse/cat action order, LURD').toBe(baseV);
  expect(revU.value, 'reversed mouse/cat action order, UUUU').toBe(baseUV);

  // 2) identical fresh repeat -> bit-identical
  const rep = computeV(s0, 2);
  const repU = computeV(s0u, 2);
  expect(rep.value, 'fresh repeat LURD').toBe(baseV);
  expect(repU.value, 'fresh repeat UUUU').toBe(baseUV);

  // 3) same cat/mouse coordinates + same budgets, different box layout -> not merged
  const twins = boardTwins(r);
  expect(twins, 'two reachable states share coordinates but differ in boxes').not.toBeNull();
  const [twA, twB] = twins!;
  expect(rc(twA.catPosition)).toBe(rc(twB.catPosition));
  expect(rc(twA.mousePosition)).toBe(rc(twB.mousePosition));
  expect(twA.catMovesLeft).toBe(twB.catMovesLeft);
  expect(twA.mouseMovesLeft).toBe(twB.mouseMovesLeft);
  expect(boardDiff(twA, twB).length).toBeGreaterThan(0);
  const keyL = stateKey(twA);
  const keyA = stateKey(twB);
  expect(keyA, 'box layout is part of the state identity').not.toBe(keyL);
  const vL0 = new AlternationValue().value(twA, 0);
  const vA0 = new AlternationValue().value(twB, 0);
  expect(vL0).toBe(evaluateCorrectedHoleForCat(twA));
  expect(vA0).toBe(evaluateCorrectedHoleForCat(twB));

  // 4) terminal priority: terminal beats H1 and never calls the evaluator
  const eT = new AlternationValue();
  const catWin = { ...replayPlan(r, LURD).state, phase: GamePhase.CatWins } as GameEngineState;
  const mouseWin = { ...replayPlan(r, LURD).state, phase: GamePhase.MouseWins } as GameEngineState;
  expect(eT.value(catWin, 2)).toBe(MATE_SCORE);
  expect(eT.value(mouseWin, 2)).toBe(-MATE_SCORE);
  expect(eT.stats.evalCalls, 'terminal states bypass H1').toBe(0);

  // 5) CHANCE: a real multi-outcome ghost boundary (ghost on the mouse cell ->
  //    auto-pick -> replacement ghosts), both the raw weights and the weighted
  //    expectation through the enumerator.
  const ghostRoot: GameEngineState = {
    ...r,
    pendingButterSpawns: [{ r: r.mousePosition.r, c: r.mousePosition.c, blockedMaterializations: 0 }],
  };
  const boundaryState: GameEngineState = { ...ghostRoot, currentPlayer: PieceType.Cat, catMovesLeft: 0 };
  const outcomes = rules.resolveGhostBoundaryChance!(boundaryState)!;
  expect(outcomes.length).toBeGreaterThan(1);
  const wSum = outcomes.reduce((a, o) => a + o.weight, 0);
  expect(Math.abs(wSum - 1)).toBeLessThan(1e-12);
  for (const o of outcomes) expect(o.weight).toBeGreaterThan(0);

  // Weighted expectation through the real enumerator vs. an independent manual
  // group-by-sequence sum over the same enumerated CHANCE branches.
  const evChance = new AlternationValue();
  const vChance = evChance.value(ghostRoot, 1);
  const chanceLines = enumerateFullTurns(ghostRoot, PieceType.Cat).lines;
  const bySeq = new Map<string, { w: number; v: number; branches: number }>();
  for (const l of chanceLines) {
    const k = seqText(l.actions);
    const g = bySeq.get(k) ?? { w: 0, v: 0, branches: 0 };
    const lv = isTerminal(l.state)
      ? (l.state.phase === GamePhase.CatWins ? MATE_SCORE : -MATE_SCORE)
      : evaluateCorrectedHoleForCat(l.state);
    g.w += l.weight;
    g.v += l.weight * lv;
    g.branches++;
    bySeq.set(k, g);
  }
  let manualMax = -Infinity;
  for (const g of bySeq.values()) {
    expect(g.w, 'each cat sequence distributes exactly one unit of probability').toBeCloseTo(1, 12);
    manualMax = Math.max(manualMax, g.v);
  }
  expect(evChance.stats.chanceNodes).toBeGreaterThan(0);
  expect(evChance.stats.chanceOutcomes).toBeGreaterThan(0);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV16-P4 controls\n`
    + `  order: reversed LURD=${rev.value} repeated=${rep.value} | UUUU=${revU.value}/${repU.value}\n`
    + `  same coords/budget different board: keysDiffer=${keyA !== keyL} H1 ${vL0} vs ${vA0} boardDiff=${boardDiff(twA, twB).join(',')}\n`
    + `  terminal: cat=${eT.stats.terminalCat} mouse=${eT.stats.terminalMouse} evals=${eT.stats.evalCalls}\n`
    + `  chance: outcomes=${outcomes.length} weightSum=${wSum} enumerator=${vChance} manual=${manualMax}`
    + ` chanceNodes=${evChance.stats.chanceNodes} branches=${evChance.stats.chanceOutcomes}\n`
    + `  cat principal ends on mouse: ${base.pv!.catEnd.currentPlayer} catMovesLeft=${base.pv!.catEnd.catMovesLeft}`,
  );
  expect(vChance).toBeCloseTo(manualMax, 9);

  // 6) cat response fully executed + 7) engine replay of the principal line
  const pv = base.pv!;
  expect(pv.catActions.length).toBeGreaterThan(0);
  expect(pv.catEnd.currentPlayer).toBe(PieceType.Mouse);
  expect(pv.catEnd.catMovesLeft).toBe(0);
  let cur = s0;
  for (const a of [...pv.mouseActions, ...pv.catActions]) {
    const tr = simulateSearchAction(cur, a, rules);
    expect(tr.kind, 'principal line has no hidden chance at T7').toBe('deterministic');
    if (tr.kind === 'deterministic') cur = tr.state;
  }
  expect(stateKey(cur)).toBe(stateKey(pv.catEnd));
  expect(evaluateCorrectedHoleForCat(cur)).toBe(baseV);

  // 8) no future-information leakage: value depends only on the state, not on
  //    which plan produced it or on evaluation order. Compute in reverse plan
  //    order in fresh contexts and compare bit-for-bit.
  const uFirst = computeV(s0u, 2);
  const lAfter = computeV(s0, 2);
  expect(uFirst.value).toBe(baseUV);
  expect(lAfter.value).toBe(baseV);
  // 60 mouse sequences collapse to 15 unique end states: the shared value is
  // state-keyed only.
  const mt = enumerateFullTurns(s0, PieceType.Mouse);
  const ends = new Set(mt.lines.filter((l) => !isTerminal(l.state)).map((l) => stateKey(l.state)));
  expect(ends.size).toBeLessThan(mt.lines.length);
  // eslint-disable-next-line no-console
  console.log(`  dedup: ${mt.lines.length} mouse sequences -> ${ends.size} unique states (stateKey-only memo)`);
}, 300000);

/** Two reachable cat-turn states with identical coordinates/budgets but different boxes. */
function boardTwins(start: GameEngineState): [GameEngineState, GameEngineState] | null {
  const groups = new Map<string, GameEngineState[]>();
  const add = (s: GameEngineState): void => {
    if (isTerminal(s)) return;
    const g = `${rc(s.catPosition)}|${rc(s.mousePosition)}|${s.catMovesLeft}|${s.mouseMovesLeft}|${s.phase}|${s.currentPlayer}`;
    const arr = groups.get(g);
    if (arr) arr.push(s); else groups.set(g, [s]);
  };
  add(start);
  for (const plan of legalCatTurns(start)) {
    let cur = start;
    for (const a of plan) {
      const t = simulateSearchAction(cur, a, rules);
      if (t.kind !== 'deterministic') break;
      cur = t.state;
      add(cur);
    }
  }
  for (const arr of groups.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (stateKey(arr[i]) !== stateKey(arr[j]) && boardDiff(arr[i], arr[j]).length > 0) return [arr[i], arr[j]];
      }
    }
  }
  return null;
}

/** Every legal full cat turn (deterministic representatives), HV15 helper reused. */
function legalCatTurns(start: GameEngineState): SearchAction[][] {
  const out: SearchAction[][] = [];
  const walk = (s: GameEngineState, prefix: SearchAction[]): void => {
    if (prefix.length > 0 && (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat || s.catMovesLeft <= 0)) {
      out.push(prefix);
      return;
    }
    if (prefix.length >= 8) { out.push(prefix); return; }
    const actions = generateLegalSearchActions(s, rules).filter((a) => a.type === 'catStep' || a.type === 'catPlaceTrap');
    if (actions.length === 0) { out.push(prefix); return; }
    for (const a of actions) {
      const t = simulateSearchAction(s, a, rules);
      if (t.kind === 'chance') continue;
      walk(t.state, [...prefix, a]);
    }
  };
  walk(start, []);
  return out;
}
