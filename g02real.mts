/**
 * G0.2 REAL scan + TURN-BOUNDARY FRONTIER (diagnostic, read-only).
 *
 * Modes:
 *   <file> <turn> <depth> --canonical <budget>   canonical whole-root truth
 *   <file> <turn> <depth> --per-action <budget>  per-root-action truth
 *   <file> <turn> <depth> --frontier <budget>    turn-boundary frontier
 *
 * Uses ONLY the exported SNAPSHOT_JSON (no reconstruction).
 */
import { readFileSync, existsSync } from 'node:fs';
import { catMove, catPlaceTrap, type GameEngineState } from './src/game/engine';
import { GamePhase, PieceType, type Direction } from './src/game/types';
import type { SearchAction, RuleSet } from './src/game/ai/searchTypes';
import {
  searchBestAction,
  searchResult,
  stepChildForParent,
  mateActionCost,
  createSearchContext,
  type MateSide,
} from './src/game/ai/expectiminimax';
import { evaluateForCat } from './src/game/ai/evaluation';
import { defaultRuleSet } from './src/game/ai/searchRules';
import { restoreHardRoot, type HardRootSnapshot } from './src/game/ai/hardHistory';
import { stateKey } from './src/game/ai/transposition';
import { simulateSearchAction } from './src/game/ai/simulator';
import { generateLegalSearchActions } from './src/game/ai/legalActions';

const DIR: Record<string, Direction> = {
  ArrowUp: { key: 'ArrowUp', dr: -1, dc: 0, label: '↑' },
  ArrowDown: { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' },
  ArrowLeft: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' },
  ArrowRight: { key: 'ArrowRight', dr: 0, dc: 1, label: '→' },
};

interface Turn {
  turn: number;
  stateKey: string;
  planText: string;
  endStateKey: string | null;
  snapshot: HardRootSnapshot;
  cDepth: number;
  aDepth: number;
  rootValue: number;
  mate: string;
}

function parseTurns(text: string): Turn[] {
  const blocks = text.split(/Turn\s*#(\d+)/).slice(1);
  const out: Turn[] = [];
  for (let i = 0; i + 1 < blocks.length; i += 2) {
    const turn = Number(blocks[i]);
    const body = blocks[i + 1];
    const skM = body.match(/STATE_KEY=(\S+)/);
    const planM = body.match(/PLAN:\s*(.*)/);
    const execM = body.match(/EXEC: endState=(\S+)/);
    const snapM = body.match(/SNAPSHOT_JSON=(\{.*\})/);
    const searchM = body.match(/cDepth=(\d+)\s+aDepth=(\d+)/);
    const rootM = body.match(/ROOT_VALUE=(-?\d+(?:\.\d+)?)\s+mate=(\S+)/);
    if (!skM || !snapM) {
      console.error(`turn #${turn}: missing STATE_KEY or SNAPSHOT_JSON`);
      process.exit(4);
    }
    let snapshot: HardRootSnapshot;
    try {
      snapshot = JSON.parse(snapM[1]) as HardRootSnapshot;
    } catch (e) {
      console.error(`turn #${turn}: SNAPSHOT_JSON failed to JSON.parse: ${(e as Error).message}`);
      process.exit(5);
    }
    out.push({
      turn,
      stateKey: skM[1],
      planText: planM ? planM[1].trim() : '',
      endStateKey: execM ? execM[1] : null,
      snapshot,
      cDepth: searchM ? Number(searchM[1]) : NaN,
      aDepth: searchM ? Number(searchM[2]) : NaN,
      rootValue: rootM ? Number(rootM[1]) : NaN,
      mate: rootM ? rootM[2] : '?',
    });
  }
  return out;
}

function parsePlan(text: string): SearchAction[] {
  const out: SearchAction[] = [];
  for (const t of text.split('→').map((x) => x.trim()).filter(Boolean)) {
    if (t === 'catPlaceTrap') out.push({ type: 'catPlaceTrap' });
    else if (t.startsWith('catStep ')) {
      const key = t.slice(8).trim() as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
      out.push({ type: 'catStep', direction: DIR[key] });
    } else throw new Error(`unparsable plan token: "${t}"`);
  }
  return out;
}

function replayPlan(root: GameEngineState, planText: string): GameEngineState | null {
  let cur = root;
  try {
    for (const a of parsePlan(planText)) {
      if (a.type === 'catStep') cur = catMove(cur, a.direction);
      else if (a.type === 'catPlaceTrap') cur = catPlaceTrap(cur);
      else return null;
    }
  } catch { return null; }
  return cur;
}

const fmtMate = (m: MateSide): string => (m === null ? 'null' : m);
const actionKey = (a: SearchAction): string => (a.type === 'catStep' ? a.direction!.key : a.type);

/** TURN-BOUNDARY FRONTIER: enumerate every legal full cat-turn plan from root
 *  (same-actor actions), dedup boundaries by (stateKey, cumCost), evaluate each
 *  boundary by the ORIGINAL search with remaining depth, roll up cumCost via
 *  stepChildForParent (same edge-cost math as the search). */
function frontierTruth(
  root: GameEngineState,
  depth: number,
  rules: RuleSet,
  budget: number,
): {
  rawPlans: number;
  uniqueBoundaries: number;
  boundaries: { key: string; cumCost: number; firstActions: string[]; value: number; mate: string; completed: boolean; nodes: number }[];
  perAction: { action: string; value: number; mate: string; completed: boolean }[];
} {
  const bounds = new Map<string, { state: GameEngineState; cost: number; firsts: Set<string>; plans: string[] }>();
  let rawPlans = 0;

  const visit = (s: GameEngineState, cost: number, firstKey: string, plan: string, path: Set<string>, dt: number) => {
    const needNext = s.phase === GamePhase.Playing && s.currentPlayer === PieceType.Cat && dt > 0;
    if (!needNext) {
      rawPlans++;
      if (rawPlans % 500 === 0) console.error(`  [frontier] rawPlans=${rawPlans} bounds=${bounds.size}`);
      const key = `${stateKey(s)}#${cost}`;
      if (!bounds.has(key)) bounds.set(key, { state: s, cost, firsts: new Set(), plans: [] });
      const rec = bounds.get(key)!;
      rec.firsts.add(firstKey);
      rec.plans.push(plan);
      return;
    }
    for (const a of generateLegalSearchActions(s, rules)) {
      const t = simulateSearchAction(s, a, rules);
      if (t.kind !== 'deterministic') continue;
      const nk = stateKey(t.state);
      if (path.has(nk)) continue;
      path.add(nk);
      const switched = s.currentPlayer !== t.state.currentPlayer;
      const nd = dt - (switched ? 1 : 0);
      visit(t.state, cost + mateActionCost(a), firstKey, plan ? plan + ' → ' + actionKey(a) : actionKey(a), path, nd);
      path.delete(nk);
    }
  };

  const path = new Set<string>([stateKey(root)]);
  for (const a of generateLegalSearchActions(root, rules)) {
    const t = simulateSearchAction(root, a, rules);
    if (t.kind !== 'deterministic') continue;
    const nk = stateKey(t.state);
    if (path.has(nk)) continue;
    path.add(nk);
    const switched = root.currentPlayer !== t.state.currentPlayer;
    const nd = depth - (switched ? 1 : 0);
    visit(t.state, mateActionCost(a), actionKey(a), actionKey(a), path, nd);
    path.delete(nk);
  }

  const perFirst = new Map<string, { value: number; mate: string; completed: boolean; nodes: number }>();
  const boundaries = [...bounds.entries()].map(([k, b], idx) => {
    if (idx % 5 === 0) console.error(`  [frontier] evaluating boundary ${idx}/${bounds.size} cumCost=${b.cost} firsts=[${[...b.firsts].join(',')}]`);
    const ctx = createSearchContext(rules, budget, true, true, true);
    ctx.leafEvaluator = evaluateForCat;
    const switches = b.state.currentPlayer === PieceType.Cat ? 0 : 1;
    const inner = searchResult(b.state, depth - switches, ctx);
    const value = stepChildForParent(inner, b.cost);
    const entry = { value, mate: fmtMate(inner.mate), completed: inner.completed, nodes: ctx.diagnostics.nodes };
    for (const f of b.firsts) if (!perFirst.has(f)) perFirst.set(f, entry);
    return { key: k, cumCost: b.cost, firstActions: [...b.firsts], plans: b.plans, ...entry };
  });

  const perAction = generateLegalSearchActions(root, rules).map((a) => {
    const r = perFirst.get(actionKey(a));
    return r ? { action: actionKey(a), value: r.value, mate: r.mate, completed: r.completed } : { action: actionKey(a), value: NaN, mate: 'n/a', completed: false };
  });

  return { rawPlans, uniqueBoundaries: boundaries.length, boundaries, perAction };
}

/** canonical whole-root truth (per-action fresh ctx, production profile). */
function canonicalWholeRoot(root: GameEngineState, depth: number, budget: number) {
  const legal = generateLegalSearchActions(root, defaultRuleSet);
  const perAction = legal.map((a) => {
    const t = simulateSearchAction(root, a, defaultRuleSet);
    const cost = mateActionCost(a);
    if (t.kind !== 'deterministic') {
      return { action: actionKey(a), value: NaN, mate: null as MateSide, completed: false, nodes: -1 };
    }
    const switched = root.currentPlayer !== t.state.currentPlayer;
    const childDepth = depth - (switched ? 1 : 0);
    const actCtx = createSearchContext(defaultRuleSet, budget, true, true, true);
    actCtx.leafEvaluator = evaluateForCat;
    const r = searchResult(t.state, childDepth, actCtx);
    return {
      action: actionKey(a),
      value: stepChildForParent(r, cost),
      mate: fmtMate(r.mate),
      completed: r.completed,
      nodes: actCtx.diagnostics.nodes,
    };
  });
  const rootCtx = createSearchContext(defaultRuleSet, budget, true, true, true);
  rootCtx.leafEvaluator = evaluateForCat;
  const best = searchBestAction(root, depth, rootCtx);
  return { perAction, best: best.action, rootValue: best.value, mate: fmtMate(best.mate), nodes: rootCtx.diagnostics.nodes, budget };
}

function main() {
  const file =
    process.argv[2] ??
    (existsSync('real-hard-history-20260820.txt')
      ? 'real-hard-history-20260820.txt'
      : 'C:/Users/zheng/Downloads/hard-search-history-20260820.txt');
  const onlyTurn = process.argv[3] ? Number(process.argv[3]) : null;
  const depthArg = process.argv[4] ? Number(process.argv[4]) : 4;
  const mode = process.argv[5] ?? '--canonical';
  const budgetArg = process.argv[6] ? Number(process.argv[6]) : 30_000_000;

  const allTurns = parseTurns(readFileSync(file, 'utf8'));
  const turns = onlyTurn ? allTurns.filter((x) => x.turn === onlyTurn) : allTurns;
  console.log(`parsed ${allTurns.length} turns (scan ${onlyTurn ? '#' + onlyTurn : 'all'}, depth=${depthArg}, mode=${mode}, budget=${budgetArg})`);

  // exactness gate
  for (const t of turns) {
    const restored = restoreHardRoot(t.snapshot);
    if (stateKey(restored) !== t.stateKey) {
      console.error(`BLOCKED: turn #${t.turn} stateKey mismatch`);
      process.exit(3);
    }
    const replayed = t.planText ? replayPlan(restored, t.planText) : null;
    if (t.endStateKey !== null && (replayed === null || stateKey(replayed) !== t.endStateKey)) {
      console.error(`BLOCKED: turn #${t.turn} endState mismatch`);
      process.exit(3);
    }
  }
  console.log(`exactness gate: ALL OK (${turns.length})`);

  for (const t of turns) {
    const root = restoreHardRoot(t.snapshot);
    console.log(`\n== Turn #${t.turn} == prod cDepth=${t.cDepth} aDepth=${t.aDepth} root=${t.rootValue} mate=${t.mate}`);

    if (mode === '--canonical') {
      const canon = canonicalWholeRoot(root, depthArg, budgetArg);
      console.log(`  canonical d${depthArg}: rootValue=${canon.rootValue} mate=${canon.mate} bestAction=${canon.bestAction ? actionKey(canon.bestAction) : null} nodes=${canon.nodes}`);
      for (const p of canon.perAction) {
        console.log(`    ${String(p.action).padEnd(12)} value=${p.value} mate=${p.mate} completed=${p.completed} nodes=${p.nodes}`);
      }
    } else if (mode === '--per-action') {
      const legal = generateLegalSearchActions(root, defaultRuleSet);
      for (const a of legal) {
        const t0 = Date.now();
        const res = canonicalWholeRoot(root, depthArg, budgetArg);
        const mine = res.perAction.find((x) => x.action === actionKey(a));
        console.log(`    ${actionKey(a).padEnd(10)} => value=${mine?.value} mate=${mine?.mate} completed=${mine?.completed} nodes=${mine?.nodes} (${Date.now() - t0}ms)`);
      }
    } else if (mode === '--frontier') {
      const f = frontierTruth(root, depthArg, defaultRuleSet, budgetArg);
      console.log(`  frontier: rawPlans=${f.rawPlans} uniqueBoundaries=${f.uniqueBoundaries}`);
      for (const b of f.boundaries) {
        console.log(`    boundary key=${b.key.slice(0, 40)}... cumCost=${b.cumCost} firsts=[${b.firstActions.join(',')}] value=${b.value} mate=${b.mate} completed=${b.completed} nodes=${b.nodes}`);
      }
      console.log('  per-first-root-action:');
      for (const p of f.perAction) {
        console.log(`    ${p.action.padEnd(10)} value=${p.value} mate=${p.mate} completed=${p.completed}`);
      }
    }
  }
}

main();