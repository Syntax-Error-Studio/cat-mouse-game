/**
 * F0.1 — BUDGET-FAIR oracle audit + trajectory-level Medium baseline.
 * MEASUREMENT ONLY. Nothing in src/ is modified.
 *
 * WHY THIS EXISTS
 * ---------------
 * F0's oracle (`oracleBestDirs` in f0bench.mts) evaluated every root child with
 * ONE shared 500k-node SearchContext, in generation order, via `searchValue`
 * which DISCARDS the `completed` flag. Once the shared budget is exhausted the
 * remaining children silently collapse to a static leaf evaluation. So F0's
 * "depth-6 oracle" was not necessarily a depth-6 search for every action, and
 * F0 could not have noticed.
 *
 * This script instead:
 *   - gives EVERY root child its OWN fresh context and node budget;
 *   - deepens d = 1..D and keeps the deepest depth at which ALL children
 *     finished without a budget cutoff  => `commonCompletedDepth`;
 *   - ranks actions ONLY at that common, fully-completed depth;
 *   - classifies each fixture A (terminal/mate-decided) vs B (horizon /
 *     default-eval reference);
 *   - measures the Medium baseline the way the GAME actually calls it, i.e. the
 *     first step of `computeCatAiTrajectory` (which contains the BFS fallback
 *     layer that a bare `catAiMove` call misses).
 *
 * Run:  npx vite-node f01oracle2.mts
 */
import { catAiMove, computeCatAiTrajectory, type GameEngineState } from './src/game/engine';
import {
  searchBestAction,
  searchResult,
  createSearchContext,
  stepChildForParent,
  mateActionCost,
  compareSearchScore,
  type MateSide,
} from './src/game/ai/expectiminimax';
import { defaultRuleSet } from './src/game/ai/searchRules';
import type { RuleSet } from './src/game/ai/searchTypes';
import { simulateSearchAction } from './src/game/ai/simulator';
import { generateLegalSearchActions } from './src/game/ai/legalActions';
import { evaluateForCat } from './src/game/ai/evaluation';
import { fixtures, noTrapRuleSet, actionKeyOf, dirOfDelta, manhattan } from './f01fixtures.mts';

const D = Number(process.env.F01_ORACLE_DEPTH ?? 6);
const PER_ACTION_NODES = Number(process.env.F01_PER_ACTION_NODES ?? 60_000);
const TACTIC_DEPTH = Number(process.env.F01_DEPTH ?? 3);
const PLAYER_NODES = 500_000;

type Ev = { key: string; value: number; mate: MateSide; completed: boolean; nodes: number; distDelta: number | null };

/** Evaluate every root action at `depth`, each with its OWN fresh budget. */
function evalRoot(state: GameEngineState, rules: RuleSet, depth: number): Ev[] {
  const actions = generateLegalSearchActions(state, rules);
  const distBefore = manhattan(state.catPosition, state.mousePosition);
  const out: Ev[] = [];
  for (const a of actions) {
    const ctx = createSearchContext(rules, PER_ACTION_NODES, true, true, true);
    const t = simulateSearchAction(state, a, rules);
    let value: number, mate: MateSide, completed: boolean, rep: GameEngineState;
    // F1A-3: mirror the search's edge-cost semantics — a parent action's real
    // game-time cost (mateActionCost) is charged, NOT a flat ±1 per tree edge.
    const cost = mateActionCost(a);
    if (t.kind === 'deterministic') {
      const switched = state.currentPlayer !== t.state.currentPlayer;
      const r = searchResult(t.state, depth - (switched ? 1 : 0), ctx);
      value = stepChildForParent(r, cost); mate = r.mate; completed = r.completed; rep = t.state;
    } else {
      let total = 0, allCat = true, allMouse = true, comp = true;
      const switched = state.currentPlayer !== t.outcomes[0].state.currentPlayer;
      for (const o of t.outcomes) {
        const r = searchResult(o.state, depth - (switched ? 1 : 0), ctx);
        total += o.weight * r.value;
        if (r.mate !== 'cat') allCat = false;
        if (r.mate !== 'mouse') allMouse = false;
        if (!r.completed) comp = false;
      }
      mate = allCat ? 'cat' : allMouse ? 'mouse' : null;
      // A CHANCE node itself adds NO mate-cost layer; the parent action's cost
      // (e.g. the mouseStep that triggered the butter pick-up) is applied here.
      value = stepChildForParent({ value: total, mate, completed: comp, cacheable: true, bound: 'exact' }, cost);
      completed = comp; rep = t.outcomes[0].state;
    }
    const moved = rep.catPosition.r !== state.catPosition.r || rep.catPosition.c !== state.catPosition.c;
    out.push({
      key: actionKeyOf(a as any), value, mate, completed,
      nodes: ctx.diagnostics.nodes,
      distDelta: moved ? manhattan(rep.catPosition, state.mousePosition) - distBefore : null,
    });
  }
  return out;
}

function classify(evs: Ev[]) {
  let best = evs[0];
  for (const e of evs) if (compareSearchScore(e, best) > 0) best = e;
  const bestList = evs.filter((e) => compareSearchScore(e, best) === 0);
  const rejected = evs.filter((e) => compareSearchScore(e, best) < 0);
  const allBestMateWin = bestList.every((e) => e.mate === 'cat');
  const anyRejectedLoss = rejected.some((e) => e.mate === 'mouse');
  const anyMate = evs.some((e) => e.mate !== null);
  let klass: 'A-mateWin' | 'A-lossAvoid' | 'B-horizon';
  if (allBestMateWin) klass = 'A-mateWin';
  else if (anyRejectedLoss) klass = 'A-lossAvoid';
  else klass = 'B-horizon';
  return { best, bestKeys: bestList.map((e) => e.key), bestList, rejected, klass, anyMate };
}

function soundVerdict(evs: Ev[], klass: string, chosen: string | null): 'ok' | 'lost' | 'missedWin' | 'unknown' {
  if (chosen == null) return 'unknown';
  const e = evs.find((x) => x.key === chosen);
  if (!e) return 'unknown';
  if (klass === 'A-mateWin') return e.mate === 'cat' ? 'ok' : 'missedWin';
  if (e.mate === 'mouse') return evs.some((x) => x.mate !== 'mouse') ? 'lost' : 'ok';
  return 'ok';
}

function runSearchPlayer(state: GameEngineState, rules: RuleSet, leaf: ((s: GameEngineState) => number) | undefined) {
  const ctx = createSearchContext(rules, PLAYER_NODES, true, true, true);
  if (leaf) ctx.leafEvaluator = leaf;
  const t0 = performance.now();
  const r = searchBestAction(state, TACTIC_DEPTH, ctx);
  const ms = performance.now() - t0;
  return {
    key: r.action ? actionKeyOf(r.action as any) : null,
    completed: r.completed, value: r.value, mate: r.mate,
    nodes: ctx.diagnostics.nodes, elapsedMs: Number(ms.toFixed(1)),
  };
}

/** Bare heuristic call (what f0bench.mts measured). */
function runMediumBare(state: GameEngineState) {
  const next = catAiMove(state);
  if (!next) return { key: null as string | null, raw: 'catAiMove returned NULL' };
  const d = dirOfDelta(state.catPosition, next.catPosition);
  if (d) return { key: `step:${d}`, raw: 'catStep' };
  if (next.trapPosition && !state.trapPosition) return { key: 'catPlaceTrap', raw: 'trap' };
  return { key: null as string | null, raw: 'no game-affecting cat change' };
}

/** Production path: first step of the trajectory the GAME actually plays. */
function runMediumTrajectory(state: GameEngineState) {
  const traj = computeCatAiTrajectory(state);
  if (!traj || traj.length === 0) return { key: null as string | null, raw: 'trajectory null/empty', steps: 0, detail: '' };
  const first = traj[0];
  const d = dirOfDelta(state.catPosition, first.to);
  const key = d ? `step:${d}` : (first.state.trapPosition && !state.trapPosition ? 'catPlaceTrap' : null);
  return { key, raw: 'trajectory', steps: traj.length, detail: first.detail };
}

// ---------------------------------------------------------------------------
const suites: { name: string; rules: RuleSet; traps: number }[] = [
  { name: 'noTrap', rules: noTrapRuleSet, traps: 0 },
  { name: 'production', rules: defaultRuleSet, traps: 1 },
];

const out: any = {
  config: { oracleMaxDepth: D, perActionNodes: PER_ACTION_NODES, tacticDepth: TACTIC_DEPTH, playerNodes: PLAYER_NODES },
  suites: {},
};

for (const suite of suites) {
  const rows: any[] = [];
  for (const fx of fixtures) {
    const state = fx.build(suite.traps);

    // --- budget-fair deepening -------------------------------------------
    let commonDepth = 0;
    let lastComplete: Ev[] | null = null;
    let firstIncomplete: { depth: number; evs: Ev[] } | null = null;
    for (let d = 1; d <= D; d++) {
      const evs = evalRoot(state, suite.rules, d);
      if (evs.every((e) => e.completed)) { commonDepth = d; lastComplete = evs; }
      else { firstIncomplete = { depth: d, evs }; break; }
    }
    const evs = lastComplete ?? firstIncomplete!.evs;
    const cls = classify(evs);

    // --- players ----------------------------------------------------------
    const def = runSearchPlayer(state, suite.rules, undefined);
    const e1 = runSearchPlayer(state, suite.rules, evaluateForCat);
    const medBare = runMediumBare(state);
    const medTraj = runMediumTrajectory(state);

    const strict = (k: string | null) => k != null && cls.bestKeys.includes(k);

    let retreat: any = null;
    if (fx.retreatClaim) {
      const decreasing = evs.filter((e) => (e.distDelta ?? 0) < 0);
      retreat = {
        assertionHolds: cls.bestList.length > 0 && cls.bestList.every((e) => (e.distDelta ?? 0) > 0),
        bestDeltas: cls.bestList.map((e) => ({ key: e.key, distDelta: e.distDelta, value: e.value, mate: e.mate })),
        decreasing: decreasing.map((e) => ({ key: e.key, distDelta: e.distDelta, value: e.value, mate: e.mate })),
        allDecreasingStrictlyWorse: decreasing.length > 0 && decreasing.every((e) => compareSearchScore(e, cls.best) < 0),
      };
    }

    rows.push({
      fixture: fx.name,
      category: fx.category,
      note: fx.note ?? null,
      oracle: {
        commonCompletedDepth: commonDepth,
        firstIncompleteDepth: firstIncomplete ? firstIncomplete.depth : null,
        rankedAtDepth: lastComplete ? commonDepth : firstIncomplete!.depth,
        rankingIsBudgetComplete: lastComplete !== null,
        value: cls.best.value,
        mate: cls.best.mate,
        bestKeys: cls.bestKeys,
        class: cls.klass,
        perAction: evs,
      },
      default: { ...def, strict: strict(def.key), sound: soundVerdict(evs, cls.klass, def.key) },
      e1: { ...e1, strict: strict(e1.key), sound: soundVerdict(evs, cls.klass, e1.key) },
      mediumBare: { ...medBare, strict: strict(medBare.key), sound: soundVerdict(evs, cls.klass, medBare.key) },
      mediumTrajectory: { ...medTraj, strict: strict(medTraj.key), sound: soundVerdict(evs, cls.klass, medTraj.key) },
      retreat,
    });
  }

  const agg = (sel: (r: any) => any) => ({
    strict: rows.filter((r) => sel(r).strict).length,
    soundErrors: rows.filter((r) => sel(r).sound !== 'ok').length,
  });

  out.suites[suite.name] = {
    rules: suite.name === 'noTrap' ? 'noTrapRuleSet (catPlaceTrap disabled, catTrapsRemaining=0)' : 'defaultRuleSet (real engine bindings, catTrapsRemaining=1)',
    total: rows.length,
    classA: rows.filter((r) => r.oracle.class.startsWith('A')).length,
    classB: rows.filter((r) => r.oracle.class === 'B-horizon').length,
    budgetCompleteRankings: rows.filter((r) => r.oracle.rankingIsBudgetComplete).length,
    default: agg((r) => r.default),
    e1: agg((r) => r.e1),
    mediumBare: agg((r) => r.mediumBare),
    mediumTrajectory: agg((r) => r.mediumTrajectory),
    rows,
  };
}

console.log(JSON.stringify(out, null, 2));
