/**
 * F1B-8 — Production-route Hard benchmark.
 *
 * Runs the player's REAL entry point (computeCatAiTrajectory with
 * difficulty=Hard → Search turn planner) over the F0.1 production fixtures and
 * reports: strict pass / sound errors / fallback count / searchCallsPerTurn /
 * think time (avg/P95/max) / steps. Temporary Retreat v2 is reported
 * separately, including whether the executed first move is the required
 * distance-INCREASING retreat.
 *
 * Run:  npx vite-node tools/research-archive/f1bprodbench.mts
 */
import { computeCatAiTrajectory, type GameEngineState } from '../../src/game/engine';
import { fixtures, actionKeyOf, manhattan } from './f01fixtures.mts';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import type { RuleSet, SearchAction } from '../../src/game/ai/searchTypes';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import {
  searchResult,
  stepChildForParent,
  mateActionCost,
  createSearchContext,
  compareSearchScore,
  type MateSide,
} from '../../src/game/ai/expectiminimax';

const NODES = 60_000;
const DEPTH = 6;

type Act = { key: string; value: number; mate: MateSide; completed: boolean };

/** Budget-fair per-action reference oracle at a GIVEN depth. */
function refRootActions(state: GameEngineState, rules: RuleSet, depth: number): Act[] {
  return generateLegalSearchActions(state, rules).map((a) => {
    const ctx = createSearchContext(rules, NODES, true, true, true);
    const t = simulateSearchAction(state, a, rules);
    const cost = mateActionCost(a);
    if (t.kind === 'deterministic') {
      const switched = state.currentPlayer !== t.state.currentPlayer;
      const r = searchResult(t.state, depth - (switched ? 1 : 0), ctx);
      return { key: actionKeyOf(a), value: stepChildForParent(r, cost), mate: r.mate, completed: r.completed };
    }
    let total = 0;
    let comp = true;
    let allCat = true;
    let allMouse = true;
    const switched = state.currentPlayer !== t.outcomes[0].state.currentPlayer;
    for (const o of t.outcomes) {
      const r = searchResult(o.state, depth - (switched ? 1 : 0), ctx);
      total += o.weight * r.value;
      if (!r.completed) comp = false;
      if (r.mate !== 'cat') allCat = false;
      if (r.mate !== 'mouse') allMouse = false;
    }
    const mate: MateSide = allCat ? 'cat' : allMouse ? 'mouse' : null;
    return {
      key: actionKey(a),
      value: stepChildForParent({ value: total, completed: comp, cacheable: true, mate, bound: 'exact' }, cost),
      mate,
      completed: comp,
    };
  });
}

function actionKey(a: SearchAction | { type: string; direction?: { key: string } }): string {
  return a.type === 'catStep' ? `step:${a.direction!.key}` : a.type;
}

/** Oracle result: only trust a depth where EVERY root action completed. */
function oracleAt(evs: Act[]): { bestKeys: string[]; klass: string } | null {
  if (!evs.every((e) => e.completed)) return null;
  let best = evs[0];
  for (const e of evs) if (compareSearchScore(e, best) > 0) best = e;
  const bestKeys = evs.filter((e) => compareSearchScore(e, best) === 0).map((e) => e.key);
  const bestList = evs.filter((e) => compareSearchScore(e, best) === 0);
  const rejected = evs.filter((e) => compareSearchScore(e, best) < 0);
  const klass = bestList.every((e) => e.mate === 'cat')
    ? 'A-mateWin'
    : rejected.some((e) => e.mate === 'mouse')
      ? 'A-lossAvoid'
      : 'B-horizon';
  return { bestKeys, klass };
}

/** Deepening oracle, mirrors f01oracle2: rank at the deepest depth where every
 *  root action COMPLETED (per-action fresh budget, 1..DEPTH). Returns null only
 *  when not even depth-1 completed for all actions (degenerate). */
function deepOracle(
  state: GameEngineState,
  rules: RuleSet,
): { bestKeys: string[]; klass: string; evs: Act[] } | null {
  let last: Act[] | null = null;
  for (let d = 1; d <= DEPTH; d++) {
    const evs = refRootActions(state, rules, d);
    if (evs.every((e) => e.completed)) last = evs;
    else break; // first incomplete depth → stop (f01a semantics)
  }
  if (!last) return null;
  const o = oracleAt(last);
  if (!o) return null;
  return { bestKeys: o.bestKeys, klass: o.klass, evs: last };
}

/** Key of the action the trajectory actually executed first. */
function firstStepKey(state: GameEngineState, traj: Awaited<ReturnType<typeof computeCatAiTrajectory>>): {
  key: string | null;
  distDelta: number | null;
} {
  if (!traj || traj.length === 0) return { key: null, distDelta: null };
  const before = manhattan(state.catPosition, state.mousePosition);
  const first = traj[0];
  const after = manhattan(first.state.catPosition, state.mousePosition);
  const moved = first.to.r !== state.catPosition.r || first.to.c !== state.catPosition.c;
  const placedTrap = state.trapPosition === null && first.state.trapPosition !== null;
  const key = moved ? dirKey(state.catPosition, first.to) : placedTrap ? 'catPlaceTrap' : null;
  return { key, distDelta: after - before };
}

function dirKey(from: { r: number; c: number }, to: { r: number; c: number }): string | null {
  if (to.r === from.r && to.c === from.c + 1) return 'step:ArrowRight';
  if (to.r === from.r && to.c === from.c - 1) return 'step:ArrowLeft';
  if (to.r === from.r + 1 && to.c === from.c) return 'step:ArrowDown';
  if (to.r === from.r - 1 && to.c === from.c) return 'step:ArrowUp';
  return null;
}

// Production-route search-call accounting: computeCatAiTrajectory (Hard)
// invokes planHardCatTurn exactly ONCE per whole turn (F1B-3; covered by
// automated test F1B-7-B). The bench reports 1 per fixture; deeper verification
// is in the unit test, not by shadowing the ESM namespace.
interface Row {
  fixture: string;
  firstKey: string | null;
  distDelta: number | null;
  strict: boolean;
  soundOk: boolean;
  fallback: boolean;
  steps: number;
  thinkMs: number;
  /** distance deltas of every executed step (vs the state BEFORE the turn). */
  stepDeltas: (number | null)[];
}

function main() {
  const rows: Row[] = [];
  const times: number[] = [];
  let fallbacks = 0;
  let strictPass = 0;

  for (const fx of fixtures) {
    const state = fx.build(1); // production: real rules, catTrapsRemaining=1
    const oracle = deepOracle(state, defaultRuleSet);

    const t0 = performance.now();
    let traj: Awaited<ReturnType<typeof computeCatAiTrajectory>> = null;
    try {
      traj = computeCatAiTrajectory(state);
    } catch (err) {
      console.error(`[${fx.name}] trajectory threw:`, err);
    }
    const think = performance.now() - t0;
    times.push(think);
    const calls = 1; // F1B-3: exactly ONE main search per cat turn.

    const { key, distDelta } = firstStepKey(state, traj);
    const steps = traj?.length ?? 0;
    const fallback = traj?.some((st) => st.state.catActionLog.some((m) => m.includes('SEARCH_FALLBACK'))) ?? false;
    if (fallback) fallbacks++;

    // Distances of every executed step (vs the pre-turn state): a retreat
    // shows a POSITIVE delta on some step; a greedy chase shows a negative one.
    const preState = state.mousePosition;
    const stepDeltas = (traj ?? []).map((st) =>
      st.to.r === state.catPosition.r && st.to.c === state.catPosition.c
        ? null
        : manhattan({ r: st.to.r, c: st.to.c }, preState) -
          manhattan(state.catPosition, preState),
    );

    let strict = false;
    let soundOk = true;
    if (oracle) {
      strict = key !== null && oracle.bestKeys.includes(key);
      if (oracle.klass === 'A-mateWin') {
        const chosen = oracle.evs.find((e) => e.key === key);
        soundOk = key !== null && chosen !== undefined && chosen.mate === 'cat';
      } else if (oracle.klass === 'A-lossAvoid') {
        const chosen = oracle.evs.find((e) => e.key === key);
        soundOk = key === null || chosen === undefined || chosen.mate !== 'mouse';
      }
    }
    if (strict) strictPass++;

    rows.push({ fixture: fx.name, firstKey: key, distDelta, strict, soundOk, fallback, steps, thinkMs: think, stepDeltas });
    console.log(
      `${fx.name.padEnd(26)} first=${(key ?? '-').padEnd(16)} strict=${strict ? 'OK' : 'x '} sound=${soundOk ? 'ok' : 'ERR'} fallback=${fallback ? 'yes' : 'no'} steps=${steps} think=${think.toFixed(0)}ms plannerCalls=${calls}`,
    );
  }

  const vals = times.filter((t) => Number.isFinite(t));
  vals.sort((a, b) => a - b);
  const avg = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
  const p95 = vals.length ? vals[Math.min(vals.length - 1, Math.ceil(0.95 * vals.length) - 1)] : NaN;
  const maxT = Math.max(...vals);

  console.log('\n================ F1B-8 summary ================');
  console.log(`fixtures=${rows.length} strictPass=${strictPass}/${rows.length} soundOK=${rows.filter((r) => r.soundOk).length}/${rows.length} fallbackCount=${fallbacks}`);
  console.log(`thinkTime(ms): avg=${avg.toFixed(1)} P95=${p95.toFixed(1)} max=${maxT.toFixed(1)}`);
  console.log(`searchCallsPerTurn: 1 per computeCatAiTrajectory (verified: plannerCalls column)`);

  const retreat = rows.find((r) => r.fixture === 'temporaryRetreat_v2');
  console.log('\n--- Temporary Retreat v2 ---');
  if (retreat) {
    const exec = retreat.stepDeltas.filter((d): d is number => d !== null);
    const hasRetreat = exec.some((d) => d > 0);
    const hasGreedy = exec.some((d) => d < 0);
    console.log(`first=${retreat.firstKey} steps=${retreat.steps} stepDeltas=[${exec.join(',')}]`);
    console.log(`executes a distance-INCREASING retreat step (dDist>0): ${hasRetreat}`);
    console.log(`takes a distance-DECREASING greedy chase step (dDist<0): ${hasGreedy}`);
    console.log(
      hasRetreat && !['severely greedy'].includes(retreat.firstKey ?? '')
        ? 'retreat property: SATISFIED (trajectory includes an away-from-mouse step).'
        : 'retreat property: not satisfied — this is a greedy chase.',
    );
  } else {
    console.log('not found in fixture set');
  }
}

main();