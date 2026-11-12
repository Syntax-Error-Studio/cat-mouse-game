/// <reference types="node" />
/**
 * PPC-HV15 P1 — GAME2 T4 search-cost forensics (read-only on production).
 *
 * Reuses ONLY existing instrumentation:
 *   - G0.3C `SearchProfiler` (stateKey / legalActions / transition / evaluate /
 *     TT / ordering call-counts + wall time; detail: its wall-time accumulators
 *     are diagnostic samples, not a formal timing authority),
 *   - `SearchDiagnostics` (nodes/leaves/terminal/chance/TT/AB),
 *   - evaluation.ts module counters (`resetEvaluationCalls` + BFS getters).
 *
 * Every root is restored from the byte-verified PPC-HV14 logs. No production
 * code is modified; no budget or seed is changed.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createEngineRuleSet } from '../../engine';
import type { GameEngineState } from '../../engine';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import {
  createSearchContext,
  searchBestAction,
  searchBestActionIterative,
  type SearchProfiler,
  type IterativeSearchResult,
  type IterationDiagnostic,
} from '../expectiminimax';
import { evaluateForCatDetailed, createEvaluationContext, buildCarryingDistanceMap, DEFAULT_EVALUATION_WEIGHTS } from '../evaluation';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { extractBestCatTurnPlan, dirKey } from '../planQuality';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { generateLegalSearchActions } from '../legalActions';
import type { SearchAction } from '../searchTypes';
import {
  resetEvaluationCalls,
  getEvaluationCalls,
  getMouseBfsCalls,
  getCatBfsCalls,
  getCarryMouseBfsCalls,
} from '../evaluation';

const LOG_DIR = new URL('../../../../ai-training/human-logs/PPC-HV14/', import.meta.url);
const rules = createEngineRuleSet();

function logText(game: 'GAME2' | 'GAME4'): string {
  return readFileSync(new URL(`${game}_H1.txt`, LOG_DIR), 'utf8');
}

function turnBlock(game: 'GAME2' | 'GAME4', turn: number): string[] {
  const lines = logText(game).split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  const idx = starts.findIndex((s) => Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]) === turn);
  if (idx < 0) throw new Error(`${game} T${turn} not found`);
  const s = starts[idx];
  const e = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
  return lines.slice(s + 1, e);
}

function field(lines: string[], prefix: string): string {
  return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
}

function rootOf(game: 'GAME2' | 'GAME4', turn: number): { state: GameEngineState; loggedKey: string; plan: string; lines: string[] } {
  const lines = turnBlock(game, turn);
  const snap = JSON.parse(field(lines, 'SNAPSHOT_JSON=')) as HardRootSnapshot;
  return { state: restoreHardRoot(snap), loggedKey: field(lines, 'STATE_KEY='), plan: field(lines, 'PLAN:'), lines };
}

const token = (a: SearchAction): string =>
  a.type === 'catPlaceTrap' ? 'T' : a.type === 'catStep' ? a.direction!.key.replace('Arrow', '').slice(0, 1) : '?';
const planText = (p: SearchAction[]): string => p.map(token).join('');

function newProfiler(): SearchProfiler {
  return {
    stateKeyCalls: 0,
    stateKeyMs: 0,
    legalActionsCalls: 0,
    legalActionsMs: 0,
    transitionCalls: 0,
    transitionMs: 0,
    evaluateCalls: 0,
    evaluateMs: 0,
    ttProbeCalls: 0,
    ttStoreCalls: 0,
    orderingSortCalls: 0,
    orderingSortMs: 0,
    leafStateKeys: new Set<string>(),
    repeatedLeafEvals: 0,
  };
}

interface FixedRun {
  depth: number;
  value: number;
  mate: string | null;
  best: string;
  plan: string;
  completed: boolean;
  ms: number;
  nodes: number;
  leafNodes: number;
  terminalNodes: number;
  chanceNodes: number;
  repetitions: number;
  noLegalActionNodes: number;
  deadlineCutoffs: number;
  ttProbes: number;
  ttHits: number;
  ttExactHits: number;
  ttDepthMismatches: number;
  ttStores: number;
  abCutoffs: number;
  abMax: number;
  abMin: number;
  chanceFullWindow: number;
  orderedNodes: number;
  orderingChangedFirst: number;
  evalCalls: number;
  mouseBfs: number;
  catBfs: number;
  carryBfs: number;
  prof: SearchProfiler | null;
  rootValues: { key: string; value: number; mate: string | null; bound: string }[];
}

function runFixed(root: GameEngineState, depth: number, withProfiler: boolean): FixedRun {
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const prof = withProfiler ? newProfiler() : null;
  if (prof) ctx.profiler = prof;
  resetEvaluationCalls();
  const t0 = performance.now();
  const res = searchBestAction(root, depth, ctx);
  const ms = performance.now() - t0;
  const evalCalls = getEvaluationCalls();
  const plan = extractBestCatTurnPlan(root, rules, ctx.equalPrimaryGraph!, ctx.planBranches);
  return {
    depth,
    value: res.value,
    mate: res.mate,
    best: res.action ? dirKey(res.action) : '-',
    plan: planText(plan),
    completed: res.completed,
    ms,
    nodes: ctx.diagnostics.nodes,
    leafNodes: ctx.diagnostics.leafNodes,
    terminalNodes: ctx.diagnostics.terminalNodes,
    chanceNodes: ctx.diagnostics.chanceNodes,
    repetitions: ctx.diagnostics.repetitions,
    noLegalActionNodes: ctx.diagnostics.noLegalActionNodes,
    deadlineCutoffs: ctx.diagnostics.deadlineCutoffs,
    ttProbes: ctx.diagnostics.ttProbes,
    ttHits: ctx.diagnostics.ttHits,
    ttExactHits: ctx.diagnostics.ttExactHits,
    ttDepthMismatches: ctx.diagnostics.ttDepthMismatches,
    ttStores: ctx.diagnostics.ttStores,
    abCutoffs: ctx.diagnostics.alphaBetaCutoffs,
    abMax: ctx.diagnostics.alphaBetaMaxCutoffs,
    abMin: ctx.diagnostics.alphaBetaMinCutoffs,
    chanceFullWindow: ctx.diagnostics.fullWindowChanceSearches,
    orderedNodes: ctx.diagnostics.orderedNodes,
    orderingChangedFirst: ctx.diagnostics.orderingChangedFirstMove,
    evalCalls,
    mouseBfs: getMouseBfsCalls(),
    catBfs: getCatBfsCalls(),
    carryBfs: getCarryMouseBfsCalls(),
    prof,
    rootValues: ctx.rootValues.map((a) => ({ key: dirKey(a.action), value: a.value, mate: a.mate, bound: a.bound })),
  };
}

function fmt(r: FixedRun): string {
  const p = r.prof;
  const evalReq = p ? p.evaluateCalls + p.repeatedLeafEvals : 0;
  return `D${r.depth} completed=${r.completed} ms=${r.ms.toFixed(1)} nodes=${r.nodes} leaves=${r.leafNodes}`
    + ` best=${r.best} plan=${r.plan} v=${r.value} mate=${r.mate ?? 'null'}`
    + ` [evals=${r.evalCalls} bfs=${r.mouseBfs}/${r.catBfs}/${r.carryBfs}`
    + (p ? ` evalMs=${p.evaluateMs.toFixed(2)} cacheHits=${p.repeatedLeafEvals}/${evalReq} uniq=${p.leafStateKeys.size}`
      + ` sk=${p.stateKeyCalls}/${p.stateKeyMs.toFixed(2)}ms la=${p.legalActionsCalls}/${p.legalActionsMs.toFixed(2)}ms`
      + ` tr=${p.transitionCalls}/${p.transitionMs.toFixed(2)}ms sort=${p.orderingSortCalls}/${p.orderingSortMs.toFixed(2)}ms` : '')
    + ` tt=${r.ttProbes}/${r.ttHits}/exact=${r.ttExactHits}/mism=${r.ttDepthMismatches}/st=${r.ttStores}`
    + ` ab=${r.abCutoffs}${r.abMax}/${r.abMin} chance=${r.chanceNodes}/fw=${r.chanceFullWindow} ord=${r.orderedNodes}]`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ===========================================================================
// HV15-P1-1 — fixed-depth D1/D2 cost at T4 and its control roots
// ===========================================================================
test('HV15-P1-1 fixed-depth D1/D2 cost (profiled) at GAME2 T4 + control roots', () => {
  const roots: [string, GameEngineState][] = [
    ['GAME2 T3', rootOf('GAME2', 3).state],
    ['GAME2 T4', rootOf('GAME2', 4).state],
    ['GAME2 T5', rootOf('GAME2', 5).state],
    ['GAME4 T7', rootOf('GAME4', 7).state],
  ];
  const out: string[] = [];
  const results: Record<string, { d1: FixedRun; d2: FixedRun }> = {};
  for (const [name, root] of roots) {
    const d1 = runFixed(root, 1, true);
    const d2 = runFixed(root, 2, true);
    results[name] = { d1, d2 };
    out.push(`${name}  ${fmt(d1)}\n          ${fmt(d2)}`);
    // Instrumentation must never change the fixed-depth truth.
    const plain1 = runFixed(root, 1, false);
    const plain2 = runFixed(root, 2, false);
    expect(plain1.value, `${name} D1 value with/without profiler`).toBe(d1.value);
    expect(plain1.mate).toBe(d1.mate);
    expect(plain1.best).toBe(d1.best);
    expect(plain2.value, `${name} D2 value with/without profiler`).toBe(d2.value);
    expect(plain2.mate).toBe(d2.mate);
    expect(plain2.best).toBe(d2.best);
    // H1 costs exactly three full BFS maps per actual evaluation, and the
    // module counter must agree with the profiler's miss count.
    expect(d1.mouseBfs, `${name} D1 mouse BFS == evals`).toBe(d1.evalCalls);
    expect(d1.catBfs, `${name} D1 cat BFS == evals`).toBe(d1.evalCalls);
    expect(d1.carryBfs, `${name} D1 carry BFS == evals`).toBe(d1.evalCalls);
    expect(d1.prof!.evaluateCalls, `${name} D1 profiler misses == eval counter`).toBe(d1.evalCalls);
    expect(d2.mouseBfs, `${name} D2 mouse BFS == evals`).toBe(d2.evalCalls);
    expect(d2.catBfs, `${name} D2 cat BFS == evals`).toBe(d2.evalCalls);
    expect(d2.carryBfs, `${name} D2 carry BFS == evals`).toBe(d2.evalCalls);
    expect(d2.leafNodes, `${name} leaf nodes > 0`).toBeGreaterThan(0);
  }
  // The inherited T4 facts are re-proved on the current tree.
  expect(results['GAME2 T4'].d1.best, 'T4 D1 best is Left').toBe('ArrowLeft');
  expect(results['GAME2 T4'].d1.plan, 'T4 D1 plan is LLLL').toBe('LLLL');
  expect(results['GAME2 T4'].d1.value, 'T4 D1 value reproduces the log').toBe(-535.0526315789473);
  expect(results['GAME2 T4'].d2.best, 'T4 D2 best is Right').toBe('ArrowRight');
  expect(results['GAME2 T4'].d2.plan, 'T4 D2 plan').toBe('RUDD');
  expect(results['GAME2 T4'].d2.completed).toBe(true);

  // eslint-disable-next-line no-console
  console.log(`\nHV15-P1-1 fixed-depth cost\n  ${out.join('\n  ')}`);
}, 300000);

// ===========================================================================
// HV15-P1-2 — profiler off / on wall time (diagnostic, not authority)
// ===========================================================================
test('HV15-P1-2 profiler overhead estimate on T4 D1/D2 (3 fresh runs each)', () => {
  const root = rootOf('GAME2', 4).state;
  const off1: number[] = [];
  const on1: number[] = [];
  const off2: number[] = [];
  const on2: number[] = [];
  for (let i = 0; i < 3; i++) {
    off1.push(runFixed(root, 1, false).ms);
    on1.push(runFixed(root, 1, true).ms);
  }
  for (let i = 0; i < 2; i++) {
    off2.push(runFixed(root, 2, false).ms);
    on2.push(runFixed(root, 2, true).ms);
  }
  const mOff1 = median(off1);
  const mOn1 = median(on1);
  const mOff2 = median(off2);
  const mOn2 = median(on2);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV15-P1-2 profiler overhead (median)\n`
    + `  D1 off=${off1.map((x) => x.toFixed(1)).join('/')}ms on=${on1.map((x) => x.toFixed(1)).join('/')}ms`
    + ` -> ${(mOn1 / mOff1).toFixed(2)}x\n`
    + `  D2 off=${off2.map((x) => x.toFixed(1)).join('/')}ms on=${on2.map((x) => x.toFixed(1)).join('/')}ms`
    + ` -> ${(mOn2 / mOff2).toFixed(2)}x`,
  );
  // Diagnostic-only bound: the profiler may cost time but must not be wild.
  expect(mOff1).toBeGreaterThan(0);
  expect(mOn2 / mOff2).toBeLessThan(3);
}, 300000);

// ===========================================================================
// HV15-P1-3 — eval cache: hit rate, duplicate work, unique leaf states
// ===========================================================================
test('HV15-P1-3 eval-cache hit rate and duplicate leaf evaluation on T4 D1/D2', () => {
  const root = rootOf('GAME2', 4).state;
  const rows: string[] = [];
  for (const depth of [1, 2]) {
    const r = runFixed(root, depth, true);
    const p = r.prof!;
    const requests = p.evaluateCalls + p.repeatedLeafEvals;
    rows.push(
      `D${depth} leafRequests=${requests} actualEvals=${p.evaluateCalls} cacheHits=${p.repeatedLeafEvals}`
      + ` hitRate=${((p.repeatedLeafEvals / requests) * 100).toFixed(1)}% uniqueKeys=${p.leafStateKeys.size}`
      + ` evalMs=${p.evaluateMs.toFixed(1)} of ${r.ms.toFixed(1)}ms (${((p.evaluateMs / r.ms) * 100).toFixed(1)}%)`
      + ` bfsCalls=${r.mouseBfs + r.catBfs + r.carryBfs}`,
    );
    expect(p.leafStateKeys.size).toBe(p.evaluateCalls);
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV15-P1-3 eval cache\n  ${rows.join('\n  ')}`);
}, 300000);

// ===========================================================================
// HV15-P1-4 — production-like 100 ms iterative deepening
// ===========================================================================
interface IterRun {
  completedDepth: number;
  attemptedDepth: number;
  deadlineExceeded: boolean;
  ms: number;
  nodes: number;
  iterations: IterationDiagnostic[];
  best: string;
  plan: string;
  value: number;
  mate: string | null;
  diagnostics: IterativeSearchResult['diagnostics'];
  prof: SearchProfiler;
}

function runIterative100(root: GameEngineState): IterRun {
  const prof = newProfiler();
  const t0 = performance.now();
  const res = searchBestActionIterative(root, {
    rules,
    maxDepthTurns: 4,
    maxNodes: 500_000,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    useThreatOrdering: false,
    maxThreatExtensions: 0,
    leafEvaluator: evaluateCorrectedHoleForCat,
    deadlineMs: t0 + 100,
    now: () => performance.now(),
    profiler: prof,
  });
  const ms = performance.now() - t0;
  return {
    completedDepth: res.completedDepth,
    attemptedDepth: res.attemptedDepth,
    deadlineExceeded: res.deadlineExceeded,
    ms,
    nodes: res.diagnostics.totalNodes,
    iterations: res.iterations,
    best: res.bestAction ? dirKey(res.bestAction) : '-',
    plan: planText(res.catTurnPlan),
    value: res.value,
    mate: res.mate,
    diagnostics: res.diagnostics,
    prof,
  };
}

const iterFmt = (r: IterRun): string =>
  `cDepth=${r.completedDepth} aDepth=${r.attemptedDepth} deadline=${r.deadlineExceeded}`
  + ` ms=${r.ms.toFixed(1)} nodes=${r.nodes} best=${r.best} plan=${r.plan} v=${r.value} mate=${r.mate ?? 'null'}`
  + ` iters=[${r.iterations.map((i) => `D${i.depthTurns}:${i.completed ? 'C' : 'X'}/${i.nodesUsed}n/${i.bestAction ? dirKey(i.bestAction) : '-'}`).join(' ')}]`
  + ` tt=${r.prof.ttProbeCalls}/${r.diagnostics.ttHits}/ex=${r.diagnostics.ttExactHits}/mism=${r.diagnostics.ttDepthMismatches}`
  + ` ab=${r.diagnostics.alphaBetaCutoffs} ord=${r.diagnostics.orderedNodes}`
  + ` eval=${r.prof.evaluateCalls}+${r.prof.repeatedLeafEvals}h/${r.prof.evaluateMs.toFixed(1)}ms`;

test('HV15-P1-4 production-like 100 ms iterative deepening at T4 and controls', () => {
  const roots: [string, GameEngineState][] = [
    ['GAME2 T3', rootOf('GAME2', 3).state],
    ['GAME2 T4', rootOf('GAME2', 4).state],
    ['GAME2 T5', rootOf('GAME2', 5).state],
    ['GAME4 T7', rootOf('GAME4', 7).state],
  ];
  const rows: string[] = [];
  for (const [name, root] of roots) {
    const reps: IterRun[] = [];
    const n = name === 'GAME2 T4' ? 5 : 2;
    for (let i = 0; i < n; i++) reps.push(runIterative100(root));
    rows.push(`${name}\n    ${reps.map(iterFmt).join('\n    ')}`);
    for (const r of reps) {
      expect(r.completedDepth, `${name} at least D1 completed`).toBeGreaterThanOrEqual(1);
      expect(r.ms, `${name} own wall time`).toBeGreaterThan(0);
    }
  }
  // Inherited T4 fact: 100 ms cannot complete D2; the frozen answer stays D1.
  const t4 = rows[1];
  expect(t4).toContain('cDepth=1');
  // eslint-disable-next-line no-console
  console.log(`\nHV15-P1-4 100 ms iterative\n  ${rows.join('\n  ')}`);
}, 300000);

// ===========================================================================
// HV15-P1-5 — un-deadlined iterative D2 (work needed vs 100 ms)
// ===========================================================================
test('HV15-P1-5 T4 full iterative D1+D2 wall time and node split (no deadline)', () => {
  const root = rootOf('GAME2', 4).state;
  const prof = newProfiler();
  const t0 = performance.now();
  const res = searchBestActionIterative(root, {
    rules,
    maxDepthTurns: 2,
    maxNodes: 500_000,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    useThreatOrdering: false,
    maxThreatExtensions: 0,
    leafEvaluator: evaluateCorrectedHoleForCat,
    profiler: prof,
  });
  const ms = performance.now() - t0;
  const rows = res.iterations.map((i) => `D${i.depthTurns} completed=${i.completed} nodes=${i.nodesUsed} best=${i.bestAction ? dirKey(i.bestAction) : '-'} v=${i.value}`);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV15-P1-5 T4 full D1+D2 (no deadline)\n  ms=${ms.toFixed(1)} nodes=${res.diagnostics.totalNodes} cDepth=${res.completedDepth}`
    + ` plan=${planText(res.catTurnPlan)}\n  ${rows.join('\n  ')}`
    + `\n  eval=${prof.evaluateCalls}+${prof.repeatedLeafEvals}h/${prof.evaluateMs.toFixed(1)}ms`
    + ` sk=${prof.stateKeyCalls}/${prof.stateKeyMs.toFixed(1)}ms la=${prof.legalActionsCalls}/${prof.legalActionsMs.toFixed(1)}ms`
    + ` tr=${prof.transitionCalls}/${prof.transitionMs.toFixed(1)}ms sort=${prof.orderingSortMs.toFixed(1)}ms`
    + `\n  speedupNeededVs100ms=${(ms / 100).toFixed(1)}x`,
  );
  expect(res.completedDepth).toBe(2);
  expect(res.catTurnPlan.length).toBeGreaterThan(0);
}, 300000);

// ===========================================================================
// HV15-P1-6 — unit costs on a real T4 state (microbench, diagnostic)
// ===========================================================================
test('HV15-P1-6 unit costs: H1 eval, context/BFS, stateKey, transition', () => {
  const { state } = rootOf('GAME2', 4);
  const N = 200;
  const warm = 20;
  const time = (n: number, fn: () => void): number => {
    for (let i = 0; i < warm; i++) fn();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    return (performance.now() - t0) / n;
  };

  const fullEval = time(N, () => { evaluateCorrectedHoleForCat(state); });
  const ctxBuilt = createEvaluationContext(state);
  const scoringOnly = time(N, () => { evaluateForCatDetailed(state, DEFAULT_EVALUATION_WEIGHTS, ctxBuilt); });
  const ctxBuild = time(N, () => { createEvaluationContext(state); });
  const oneBfs = time(N, () => { buildCarryingDistanceMap(state, state.mousePosition); });
  const sk = time(20_000, () => { stateKey(state); });

  const actions = generateLegalSearchActions(state, rules).filter((a) => a.type === 'catStep' || a.type === 'catPlaceTrap');
  expect(actions.length, 'the T4 hard root is a cat-turn state').toBeGreaterThan(0);
  const tr = time(500, () => {
    for (const a of actions) simulateSearchAction(state, a, rules);
  }) / actions.length;

  // BFS/eval decomposition (three full maps per H1 call).
  const inferredBfsShare = (3 * oneBfs) / fullEval;
  // eslint-disable-next-line no-console
  console.log(
    `\nHV15-P1-6 unit costs on T4 root (avg of ${N} after ${warm} warmup)\n`
    + `  H1 full eval=${(fullEval * 1000).toFixed(1)}us  context(3 BFS+Voronoi)=${(ctxBuild * 1000).toFixed(1)}us`
    + `  scoring-only(reused ctx)=${(scoringOnly * 1000).toFixed(1)}us\n`
    + `  1 carrying-graph BFS (single-source proxy)=${(oneBfs * 1000).toFixed(1)}us -> 3*BFS/H1=${(inferredBfsShare * 100).toFixed(1)}% of full eval\n`
    + `  stateKey=${(sk * 1000).toFixed(2)}us  transition=${(tr * 1000).toFixed(1)}us (${actions.length} legal cat actions)`
    + `\n  context+scoring=${((ctxBuild + scoringOnly) * 1000).toFixed(1)}us vs full=${(fullEval * 1000).toFixed(1)}us`,
  );
  expect(fullEval).toBeGreaterThan(0);
  expect(ctxBuild).toBeGreaterThan(0);
  expect(oneBfs).toBeGreaterThan(0);
}, 300000);

// ===========================================================================
// HV15-P1-7 — where the D2 fan-out comes from: the mouse's first step
// ===========================================================================
test('HV15-P1-7 chance fan-out at the mouse turn after the depth-1 cat plan', () => {
  const roots: [string, 'GAME2' | 'GAME4', number][] = [
    ['GAME2 T3', 'GAME2', 3],
    ['GAME2 T4', 'GAME2', 4],
    ['GAME2 T5', 'GAME2', 5],
    ['GAME4 T7', 'GAME4', 7],
  ];
  const rows: string[] = [];
  const mouseChanceSteps: Record<string, number> = {};
  for (const [name, game, turn] of roots) {
    const { state } = rootOf(game, turn);
    // Cheapest legal-step distance from the mouse to its nearest butter.
    const mouseToButter = state.butterPositions.map((b) =>
      Math.abs(b.r - state.mousePosition.r) + Math.abs(b.c - state.mousePosition.c));
    const minMouseToButter = mouseToButter.length ? Math.min(...mouseToButter) : Infinity;

    // The cat turn actually chosen at production depth (depth 1).
    const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = true;
    searchBestAction(state, 1, ctx);
    const plan = extractBestCatTurnPlan(state, rules, ctx.equalPrimaryGraph!, ctx.planBranches);

    // Replay the cat turn. A cat turn may itself END on the ghost-butter CHANCE
    // boundary (pending ghost spawns/debt); that is a second, separate fan-out.
    let cur = state;
    let boundaryOutcomes = 0;
    for (const a of plan) {
      const t = simulateSearchAction(cur, a, rules);
      if (t.kind === 'chance') {
        boundaryOutcomes = t.outcomes.length;
        break;
      }
      cur = t.state;
    }
    if (boundaryOutcomes > 0) {
      mouseChanceSteps[name] = -1;
      rows.push(
        `${name} catPlan=${planText(plan)} mouse=${state.mousePosition.r},${state.mousePosition.c}`
        + ` minMouseToButter=${minMouseToButter} cat-turn end = CHANCE boundary with ${boundaryOutcomes} outcomes (no mouse turn reached)`,
      );
      continue;
    }
    expect(cur.currentPlayer, `${name} cat plan hands the turn to the mouse`).toBe('mouse');

    // Enumerate the mouse's REAL legal steps and simulate each one through the
    // simulator, counting which steps open a CHANCE node and how wide it is.
    const steps = generateLegalSearchActions(cur, rules).filter((a) => a.type === 'mouseStep');
    let chanceSteps = 0;
    let maxOutcomes = 0;
    let totalOutcomes = 0;
    for (const a of steps) {
      const t = simulateSearchAction(cur, a, rules);
      if (t.kind === 'chance') {
        chanceSteps++;
        maxOutcomes = Math.max(maxOutcomes, t.outcomes.length);
        totalOutcomes += t.outcomes.length;
      }
    }
    mouseChanceSteps[name] = chanceSteps;
    rows.push(
      `${name} catPlan=${planText(plan)} mouse=${cur.mousePosition.r},${cur.mousePosition.c}`
      + ` butter=[${state.butterPositions.map((b) => `${b.r},${b.c}`).join(' ')}] minMouseToButter=${minMouseToButter}`
      + ` legalMouseSteps=${steps.length} chanceSteps=${chanceSteps} outcomes=${chanceSteps ? `${chanceSteps}x~${(totalOutcomes / chanceSteps).toFixed(1)} (max ${maxOutcomes})` : '0'}`,
    );
  }
  // The T4 root's mouse stands on the butter's doorstep: at least one immediate
  // mouse step opens a full-width ghost-spawn CHANCE node.
  expect(mouseChanceSteps['GAME2 T4'], 'T4 has an immediate butter pickup').toBeGreaterThan(0);
  // Control roots must not have that trigger — the whole difference is distance.
  expect(mouseChanceSteps['GAME2 T3'], 'T3 mouse is not adjacent to butter').toBe(0);
  expect(mouseChanceSteps['GAME2 T5'], 'T5 mouse is not adjacent to butter').toBe(0);
  // eslint-disable-next-line no-console
  console.log(`\nHV15-P1-7 chance fan-out (mouse turn right after the depth-1 cat plan)\n  ${rows.join('\n  ')}`);
}, 300000);

// ===========================================================================
// HV15-P2-1 — distance-map reuse potential among the T4 D2 leaves
// ===========================================================================
test('HV15-P2-1 how many D2 leaf states could share a distance map (key-population proxy)', () => {
  const root = rootOf('GAME2', 4).state;
  const r = runFixed(root, 2, true);
  const p = r.prof!;
  const keys = [...p.leafStateKeys];
  // stateKey layout (transposition.ts:42-61):
  //   0 board, 1 mode, 2 phase, 3 player, 4 cat, 5 mouse, 6 catMoves, 7 mouseMoves,
  //   8 butter, 11 mouseHasButter, 15 blockedTunnels, ...
  // EXACT map inputs, read from evaluation.ts:448-456 and its neighbour rules:
  //   mouseMap  = board + cat (cat cell is unenterable) + hasButter (tunnel entry)
  //               + blockedTunnels + mouse (BFS source)
  //   catMap    = board + cat (source) + butter (butter cells unenterable)
  //   carryMap  = board + cat (unenterable) + hasButter + blockedTunnels
  //               (multi-source from the static hole cells; NO mouse position)
  // `full-key-minus-source` is the conservative bound: every irrelevant field is
  // kept in the signature, so true reuse can only be higher.
  const parts = keys.map((k) => k.split('#'));
  const pick = (fields: number[]): Set<string> =>
    new Set(parts.map((q) => fields.map((i) => q[i]).join('#')));
  const without = (drop: number): Set<string> =>
    new Set(parts.map((q) => q.map((x, i) => (i === drop ? '?' : x)).join('#')));
  const exactMouse = pick([0, 4, 11, 15, 5]);
  const exactCat = pick([0, 4, 8]);
  const exactCarry = pick([0, 4, 11, 15]);
  const boardKeys = new Set(parts.map((q) => q[0]));
  const conservativeCat = without(4);
  const conservativeMouse = without(5);
  const total = keys.length;
  const share = (n: number): string => `${(((total - n) / total) * 100).toFixed(1)}%`;
  const rows = [
    `D2 unique leaf states=${total} (all ${p.evaluateCalls} actual evals)`,
    `  carry-hole map (board+cat+hasButter+blockedTunnels): distinct=${exactCarry.size} -> reusable ${share(exactCarry.size)}`
      + `  [board-only upper ${share(boardKeys.size)}, full-key lower 0.0%]`,
    `  cat map   (board+cat+butter):                        distinct=${exactCat.size} -> reusable ${share(exactCat.size)}`
      + `  [full-key-minus-cat lower ${share(conservativeCat.size)}]`,
    `  mouse map (board+cat+hasButter+blockedTunnels+mouse): distinct=${exactMouse.size} -> reusable ${share(exactMouse.size)}`
      + `  [full-key-minus-mouse lower ${share(conservativeMouse.size)}]`,
  ];
  // eslint-disable-next-line no-console
  console.log(`\nHV15-P2-1 distance-map reuse proxy on T4 D2\n  ${rows.join('\n  ')}`);
  expect(exactMouse.size).toBeLessThanOrEqual(total);
  expect(exactCat.size).toBeLessThanOrEqual(total);
  expect(exactCarry.size).toBeLessThanOrEqual(total);
}, 300000);
