/// <reference types="node" />
/**
 * PPC-HV15 P3/P4 — GAME2 T7 value plateau attribution (read-only on production).
 *
 * Root: the byte-verified GAME2 T7 snapshot (HV14 log, SHA256 pinned in HV14-1).
 * Depth-2 facts are re-proved on the current tree; then representative legal
 * full-turn plans (in-place LURD, outbound UUUU, and four endpoints spanning the
 * board) are compared term-by-term:
 *
 *   - static H1 / Baseline totals at the cat-turn end (what the evaluator sees
 *     before the mouse replies),
 *   - every existing contribution from evaluation.ts (no new formula),
 *   - the REAL mouse reply (depth-1 mouse-turn search, frozen settings),
 *   - a targeted horizon extension: the SAME fixed cat turn, then the mouse
 *     turn searched at depth 2 (mouse turn + cat turn + mouse turn).
 *
 * Only existing instrumentation. No production file is edited; no weight,
 * budget, depth cap, rule, or seed is changed anywhere.
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
import {
  evaluateForCat,
  evaluateForCatDetailed,
  DEFAULT_EVALUATION_WEIGHTS,
  type EvaluationBreakdown,
} from '../evaluation';
import { correctedHoleControlValue, correctedHoleEvalTotal, evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { countReversals, dirKey, extractBestCatTurnPlan, type EqualPrimaryGraph } from '../planQuality';
import type { SearchAction } from '../searchTypes';

const LOG = new URL('../../../../ai-training/human-logs/PPC-HV14/GAME2_H1.txt', import.meta.url);
const rules = createEngineRuleSet();

function turnBytes(turn: number): { lines: string[]; key: string; plan: SearchAction[]; execKey: string } {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
  const s = lines.findIndex((l) => l.trim() === `Turn #${turn}`);
  if (s < 0) throw new Error(`T${turn} not found`);
  let e = lines.findIndex((l, i) => i > s && /^Turn #\d+$/.test(l.trim()));
  if (e < 0) e = lines.length;
  const seg = lines.slice(s + 1, e);
  const f = (p: string): string => seg.find((l) => l.startsWith(p))?.slice(p.length).trim() ?? '';
  return {
    lines: seg,
    key: f('STATE_KEY='),
    plan: parsePlan(f('PLAN:')),
    execKey: f('EXEC:').replace(/^endState=/, '').split(/\s+/)[0],
  };
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

function replay(start: GameEngineState, plan: SearchAction[]): GameEngineState {
  let cur = start;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') return cur;
    cur = t.state;
  }
  return cur;
}

function catPathCells(start: GameEngineState, plan: SearchAction[]): string[] {
  let cur = start;
  const out = [rc(cur.catPosition)];
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
    if (a.type === 'catStep') out.push(rc(cur.catPosition));
  }
  return out;
}

function revisits(start: GameEngineState, plan: SearchAction[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const p of catPathCells(start, plan)) {
    if (seen.has(p)) n++;
    seen.add(p);
  }
  return n;
}

/** Cat-turn plans the equal-primary graph admits (same walk as extractBestCatTurnPlan). */
function equalPrimaryPlans(
  rootState: GameEngineState,
  graph: EqualPrimaryGraph,
  planBranches: Map<string, SearchAction>,
  maxLength = 8,
): SearchAction[][] {
  const byState = new Map<string, SearchAction[]>();
  for (const [, v] of graph) byState.set(stateKey(v.state), v.equalActions);
  const out: SearchAction[][] = [];
  const walk = (s: GameEngineState, prefix: SearchAction[], guard: Set<string>): void => {
    const sk = stateKey(s);
    if (prefix.length >= maxLength || guard.has(sk)) {
      if (prefix.length > 0) out.push(prefix.slice());
      return;
    }
    const options = byState.get(sk) ?? (planBranches.get(sk) ? [planBranches.get(sk)!] : []);
    if (options.length === 0) {
      if (prefix.length > 0) out.push(prefix.slice());
      return;
    }
    guard.add(sk);
    for (const a of options) {
      const t = simulateSearchAction(s, a, rules);
      if (t.kind === 'chance') {
        out.push([...prefix, a]);
        continue;
      }
      const nxt = t.state;
      if (nxt.phase === GamePhase.Playing && nxt.currentPlayer === PieceType.Cat) walk(nxt, [...prefix, a], guard);
      else out.push([...prefix, a]);
    }
    guard.delete(sk);
  };
  walk(rootState, [], new Set<string>());
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = planText(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Every legal full cat turn (deterministic ones only), for the endpoint census. */
function legalCatTurns(start: GameEngineState): SearchAction[][] {
  const out: SearchAction[][] = [];
  const walk = (s: GameEngineState, prefix: SearchAction[]): void => {
    if (prefix.length > 0 && (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat || s.catMovesLeft <= 0)) {
      out.push(prefix);
      return;
    }
    if (prefix.length >= 8) {
      out.push(prefix);
      return;
    }
    const actions = generateLegalSearchActions(s, rules).filter((a) => a.type === 'catStep' || a.type === 'catPlaceTrap');
    if (actions.length === 0) {
      out.push(prefix);
      return;
    }
    for (const a of actions) {
      const t = simulateSearchAction(s, a, rules);
      if (t.kind === 'chance') continue; // purely deterministic representatives
      walk(t.state, [...prefix, a]);
    }
  };
  walk(start, []);
  return out;
}

function contributionsOf(b: EvaluationBreakdown): string {
  return Object.entries(b.contributions)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(' ');
}

function featureLine(s: GameEngineState, b: EvaluationBreakdown): string {
  const f = b.features;
  return `catMouse=${f.catMouseDistance} mouseGoal=${f.mouseGoalDistance} winRoute=${f.mouseWinRouteDistance}`
    + ` mob=${f.catMobility}/${f.mouseMobility} area=${f.catReachableArea}/${f.mouseReachableArea}`
    + ` gate=${f.catHoleGateDistance}/${f.mouseHoleGateDistance} margin=${f.holeControlMargin}`
    + ` butterD=${f.mouseButterDistance} tunnel=${f.mouseCanReachTunnel ? f.mouseTunnelAccessDistance : 'no'}`
    + ` trap=${f.trapActive ? f.mouseTrapDistance : 'off'}`
    + ` voronoi=${f.catControlledArea}/${f.mouseControlledArea}/${f.contestedArea} bal=${f.voronoiBalance.toFixed(3)}`
    + ` player=${s.currentPlayer} moves=${s.catMovesLeft}/${s.mouseMovesLeft} boxes=${s.board.flat().filter((c) => c.type === 'box').length}`;
}

interface EvalPair {
  h1: number;
  base: number;
  breakdown: EvaluationBreakdown;
  holeCorr: number;
}

function evaluateBoth(s: GameEngineState): EvalPair {
  const breakdown = evaluateForCatDetailed(s);
  return {
    h1: correctedHoleEvalTotal(breakdown, s.config.boardSize),
    base: breakdown.total,
    breakdown,
    holeCorr: correctedHoleControlValue(breakdown, s.config.boardSize),
  };
}

interface Reply {
  value: number;
  best: string;
  leaf: GameEngineState | null;
  chance: boolean;
  leafH1: number;
  leafBase: number;
  leafHoleCorr: number;
  leafContrib: string;
}

/**
 * The REAL mouse reply to a fixed cat turn: a normal depth-1 mouse-turn search
 * with exactly the production settings and the frozen H1 leaf. The returned
 * principal line is re-simulated through the real rules; if it ends on a CHANCE
 * boundary the expectation is reported instead of pretending a single leaf.
 */
function mouseReply(catEnd: GameEngineState): Reply {
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const res = searchBestAction(catEnd, 1, ctx);
  let cur = catEnd;
  let chance = false;
  let incomplete = false;
  for (let i = 0; i < 12; i++) {
    // A decision node is either a mouse step or the mouse's tunnel-exit choice.
    const decision =
      cur.phase === GamePhase.ChoosingTunnelExit
      || (cur.phase === GamePhase.Playing && cur.currentPlayer === PieceType.Mouse && cur.mouseMovesLeft > 0);
    if (!decision) break;
    const a = ctx.planBranches.get(stateKey(cur));
    if (!a) {
      incomplete = true;
      break;
    }
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') {
      chance = true;
      break;
    }
    cur = t.state;
  }
  if (chance || incomplete) {
    // CHANCE / unfinished principal line: report the search value only.
    return { value: res.value, best: res.action ? dirKey(res.action) : '-', leaf: null, chance: true, leafH1: NaN, leafBase: NaN, leafHoleCorr: NaN, leafContrib: '' };
  }
  const e = evaluateBoth(cur);
  return {
    value: res.value,
    best: res.action ? dirKey(res.action) : '-',
    leaf: cur,
    chance: false,
    leafH1: e.h1,
    leafBase: e.base,
    leafHoleCorr: e.holeCorr,
    leafContrib: contributionsOf(e.breakdown),
  };
}

/** Targeted horizon extension: the fixed cat turn, then the mouse turn searched at depth 2. */
function mouseTurnDepth2(catEnd: GameEngineState): { value: number; nodes: number; completed: boolean; best: string } {
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  const res = searchBestAction(catEnd, 2, ctx);
  return { value: res.value, nodes: ctx.diagnostics.nodes, completed: res.completed, best: res.action ? dirKey(res.action) : '-' };
}

function boardDiff(a: GameEngineState, b: GameEngineState): string {
  const diffs: string[] = [];
  for (let r = 0; r < a.config.boardSize; r++) {
    for (let c = 0; c < a.config.boardSize; c++) {
      const x = a.board[r][c];
      const y = b.board[r][c];
      if (x.type !== y.type || x.hasButter !== y.hasButter) {
        diffs.push(`(${r},${c}) ${x.type}${x.hasButter ? '+b' : ''}->${y.type}${y.hasButter ? '+b' : ''}`);
      }
    }
  }
  if (JSON.stringify(a.trapPosition) !== JSON.stringify(b.trapPosition)) diffs.push(`trap ${rc(a.trapPosition!)}->${b.trapPosition ? rc(b.trapPosition) : 'none'}`);
  if (a.catTrapsRemaining !== b.catTrapsRemaining) diffs.push(`trapsRemaining ${a.catTrapsRemaining}->${b.catTrapsRemaining}`);
  return diffs.length ? diffs.join('; ') : '(none)';
}

const CONTRIB_KEYS = Object.keys(DEFAULT_EVALUATION_WEIGHTS);

test('HV15-P3-1 T7 root + depth-2 plateau re-proof', () => {
  const t = turnBytes(7);
  const r = root(7);
  expect(stateKey(r), 'snapshot re-hashes to the logged STATE_KEY').toBe(t.key);
  expect(planText(t.plan), 'logged plan').toBe('LURD');
  const execEnd = replay(r, t.plan);
  expect(rc(execEnd.catPosition), 'logged plan ends where EXEC says').toBe('6,6');
  expect(rc(execEnd.mousePosition)).toBe('0,3');
  expect(execEnd.catMovesLeft).toBe(0);
  expect(t.execKey.length).toBeGreaterThan(0);

  const d1 = createSearchContext(rules, 500_000, true, true, true, 0, false);
  d1.leafEvaluator = evaluateCorrectedHoleForCat;
  d1.capturePlan = true;
  const r1 = searchBestAction(r, 1, d1);
  const d2 = createSearchContext(rules, 500_000, true, true, true, 0, false);
  d2.leafEvaluator = evaluateCorrectedHoleForCat;
  d2.capturePlan = true;
  const r2 = searchBestAction(r, 2, d2);
  const prodPlan = planText(extractBestCatTurnPlan(r, rules, d2.equalPrimaryGraph!, d2.planBranches));

  const rootVals = d2.rootValues.map((v) => `${dirKey(v.action)}=${v.value}/${v.bound}`).join(' ');
  const certified = equalPrimaryPlans(r, d2.equalPrimaryGraph!, d2.planBranches);
  const ends = certified.map((p) => rc(replay(r, p).catPosition));
  const allLegal = legalCatTurns(r);
  const endCensus = new Map<string, number>();
  for (const p of allLegal) {
    const k = rc(replay(r, p).catPosition);
    endCensus.set(k, (endCensus.get(k) ?? 0) + 1);
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nHV15-P3-1 GAME2 T7\n`
    + `  D1 nodes=${d1.diagnostics.nodes} best=${dirKey(r1.action!)} v=${r1.value} plan=${planText(extractBestCatTurnPlan(r, rules, d1.equalPrimaryGraph!, d1.planBranches))}\n`
    + `  D2 nodes=${d2.diagnostics.nodes} leaves=${d2.diagnostics.leafNodes} chance=${d2.diagnostics.chanceNodes}/fw=${d2.diagnostics.fullWindowChanceSearches}`
    + ` v=${r2.value} completed=${r2.completed} rootActions=[${rootVals}]\n`
    + `  D2 production-extracted plan=${prodPlan} (logged LURD)\n`
    + `  legal cat turns=${allLegal.length} endpoints=${endCensus.size} certificationPlans=${certified.length}`
    + ` allEnd6_6=${ends.every((e) => e === '6,6')} ends=${[...new Set(ends)].join('|')}\n`
    + `  endpoint census: ${[...endCensus.entries()].sort().map(([k, n]) => `${k}x${n}`).join(' ')}\n`
    + `  root STATE_KEY=${t.key}\n`
    + `  end  STATE_KEY=${stateKey(execEnd)}`,
  );
  expect(r2.completed).toBe(true);
  expect(r1.value).toBe(-273.7368421052631);
  expect(r2.value).toBe(-914.5263157894738);
  expect(d2.rootValues.length).toBe(4);
  for (const v of d2.rootValues) expect(v.value, 'every root action is the same exact plateau').toBe(r2.value);
  expect(allLegal.length).toBe(169);
  expect(certified.length).toBe(32);
  expect(ends.every((e) => e === '6,6')).toBe(true);
}, 300000);

test('HV15-P3-2 representative plans: state change, H1 terms, real mouse reply', () => {
  const r = root(7);
  const rootEval = evaluateBoth(r);
  const plans: { name: string; plan: SearchAction[] }[] = [
    { name: 'LURD', plan: [step('ArrowLeft'), step('ArrowUp'), step('ArrowRight'), step('ArrowDown')] },
    { name: 'UUUU', plan: [step('ArrowUp'), step('ArrowUp'), step('ArrowUp'), step('ArrowUp')] },
    { name: 'UDDR', plan: [step('ArrowUp'), step('ArrowDown'), step('ArrowDown'), step('ArrowRight')] },
    { name: 'RRUR', plan: [step('ArrowRight'), step('ArrowRight'), step('ArrowUp'), step('ArrowRight')] },
    { name: 'DDDL', plan: [step('ArrowDown'), step('ArrowDown'), step('ArrowDown'), step('ArrowLeft')] },
    { name: 'UUDL', plan: [step('ArrowUp'), step('ArrowUp'), step('ArrowDown'), step('ArrowLeft')] },
  ];
  const rows: string[] = [];
  const byName: Record<string, { end: GameEngineState; stat: EvalPair; reply: Reply; deep: ReturnType<typeof mouseTurnDepth2> }> = {};
  for (const { name, plan } of plans) {
    // every chosen plan must be a legal deterministic FULL cat turn
    expect(planText(plan), `${name} token spelling`).toBe(name);
    const end = replay(r, plan);
    expect(end.currentPlayer, `${name} hands the turn to the mouse`).toBe(PieceType.Mouse);
    expect(end.catMovesLeft, `${name} ends the cat turn`).toBe(0);
    const stat = evaluateBoth(end);
    const reply = mouseReply(end);
    const deep = mouseTurnDepth2(end);
    byName[name] = { end, stat, reply, deep };
    if (reply.leaf && reply.leaf.phase === GamePhase.Playing) {
      // The reported search value must be the H1 value of the principal-line leaf.
      expect(reply.leafH1, `${name} reply value is the principal leaf's H1`).toBe(reply.value);
    }
    rows.push(
      `${name} end=${rc(end.catPosition)} net=${Math.abs(end.catPosition.r - r.catPosition.r) + Math.abs(end.catPosition.c - r.catPosition.c)}`
      + ` rev=${countReversals(plan)} revisit=${revisits(r, plan)} endKeyDiff=${boardDiff(r, end)}`
      + `\n      static H1=${stat.h1.toFixed(4)} baseline=${stat.base.toFixed(4)} holeCorr=${stat.holeCorr.toFixed(4)}`
      + `\n      static terms: ${contributionsOf(stat.breakdown)}`
      + `\n      static features: ${featureLine(end, stat.breakdown)}`
      + `\n      mouse reply=${reply.best} v=${reply.value.toFixed(4)}${reply.chance ? ' (CHANCE line)' : ''}`
      + (reply.leaf
        ? ` leaf(${rc(reply.leaf.catPosition)}/${rc(reply.leaf.mousePosition)}) phase=${reply.leaf.phase} H1=${reply.leafH1.toFixed(4)} base=${reply.leafBase.toFixed(4)} holeCorr=${reply.leafHoleCorr.toFixed(4)}`
        + `\n      leaf terms: ${reply.leafContrib}`
        + `\n      leaf features: ${featureLine(reply.leaf, evaluateForCatDetailed(reply.leaf))}`
        : '')
      + `\n      fixed-first-turn horizon (mouseD2): v=${deep.value.toFixed(4)} best=${deep.best} nodes=${deep.nodes} completed=${deep.completed}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nHV15-P3-2 T7 representative plans (root static H1=${rootEval.h1.toFixed(4)} base=${rootEval.base.toFixed(4)}`
    + ` holeCorr=${rootEval.holeCorr.toFixed(4)})\n  root terms: ${contributionsOf(rootEval.breakdown)}\n  `
    + rows.join('\n  '),
  );

  // The in-place loop's real value IS the depth-2 plateau value.
  expect(byName.LURD.reply.value).toBe(-914.5263157894738);
  // Outbound UUUU is strictly worse under the real rule set.
  expect(byName.UUUU.reply.value).toBeLessThan(byName.LURD.reply.value);
  // The hole-correction is not what creates the preference: Baseline already
  // ranks the in-place loop ahead of the outbound push plan.
  expect(byName.LURD.stat.base).toBeGreaterThan(byName.UUUU.stat.base);

  // The in-place loop changes no board feature: every non-tempo contribution at
  // the cat-turn end is bit-identical to the root's (only tempo flips sign when
  // the turn hands over).
  const contribs = rootEval.breakdown.contributions as unknown as Record<string, number>;
  const lumdContribs = byName.LURD.stat.breakdown.contributions as unknown as Record<string, number>;
  for (const key of CONTRIB_KEYS) {
    if (key === 'tempo') continue;
    expect(lumdContribs[key], `LURD leaves ${key} unchanged`).toBe(contribs[key]);
  }
  expect(rootEval.breakdown.contributions.tempo).toBe(200);
  expect(byName.LURD.stat.breakdown.contributions.tempo).toBe(-200);
  // And the cat returns to exactly the same cell on the same board.
  expect(byName.LURD.end.catPosition).toEqual(r.catPosition);
  expect(boardDiff(r, byName.LURD.end)).toBe('(none)');

  // UUUU does change the real position: it pushes boxes and leaves the chokepoint.
  expect(boardDiff(r, byName.UUUU.end)).not.toBe('(none)');
  expect(byName.UUUU.end.catPosition).toEqual({ r: 2, c: 6 });
}, 300000);

test('HV15-P3-3 H1 vs Baseline ranking and horizon flip check', () => {
  const r = root(7);
  const lumd = [step('ArrowLeft'), step('ArrowUp'), step('ArrowRight'), step('ArrowDown')];
  const uuuu = [step('ArrowUp'), step('ArrowUp'), step('ArrowUp'), step('ArrowUp')];
  const endOf = (p: SearchAction[]) => replay(r, p);
  const lumdEnd = endOf(lumd);
  const uuuuEnd = endOf(uuuu);

  // Baseline-only reply: identical search, leaf = evaluateForCat (no hole fix).
  const baseReply = (catEnd: GameEngineState): number => {
    const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateForCat;
    ctx.capturePlan = false;
    return searchBestAction(catEnd, 1, ctx).value;
  };
  const lumdBase = baseReply(lumdEnd);
  const uuuuBase = baseReply(uuuuEnd);
  const lumdDeep = mouseTurnDepth2(lumdEnd);
  const uuuuDeep = mouseTurnDepth2(uuuuEnd);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV15-P3-3 H1/Baseline reply and horizon\n`
    + `  H1 reply      LURD=${byNameValue(lumdEnd).toFixed(4)} UUUU=${byNameValue(uuuuEnd).toFixed(4)}\n`
    + `  Baseline reply LURD=${lumdBase.toFixed(4)} UUUU=${uuuuBase.toFixed(4)}\n`
    + `  fixed-turn horizon D2-from-mouse LURD=${lumdDeep.value.toFixed(4)} (${lumdDeep.nodes}n)`
    + ` UUUU=${uuuuDeep.value.toFixed(4)} (${uuuuDeep.nodes}n)\n`
    + `  verdict: H1 prefers LURD=${byNameValue(lumdEnd) > byNameValue(uuuuEnd)}`
    + ` Baseline prefers LURD=${lumdBase > uuuuBase} deeper prefers LURD=${lumdDeep.value > uuuuDeep.value}`,
  );
  expect(lumdBase).toBeGreaterThan(uuuuBase);
  expect(lumdDeep.completed && uuuuDeep.completed).toBe(true);

  function byNameValue(catEnd: GameEngineState): number {
    return mouseReply(catEnd).value;
  }
}, 300000);
