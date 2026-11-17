/// <reference types="node" />
/**
 * PPC-P1-QUALITY-01 — OLD formula vs NEW formula, run side by side over the SAME
 * real equal-primary graph.
 *
 * Why a reference DP: the production function can only exhibit one behaviour at
 * a time. To say *why* the extractor used to pick the loop, the two scoring
 * functions have to be evaluated on identical inputs under identical traversal,
 * memo and tie-break rules. This file re-implements `extractDp` twice — once
 * with the historical
 *
 *     actionReversal + countReversals(childPlan)
 *
 * and once with the shipped
 *
 *     countPlanReversals(prefix, [action, ...childPlan])
 *
 * — and diffs the results. It is diagnostic evidence, not production code.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { GameEngineState } from '../../src/game/engine';
import { createEngineRuleSet } from '../../src/game/engine';
import { GamePhase, PieceType } from '../../src/game/types';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { stateKey } from '../../src/game/ai/transposition';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import {
  countPlanReversals, countReversals, isImmediateReversal, type EqualPrimaryGraph,
} from '../../src/game/ai/planQuality';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import type { RuleSet } from '../../src/game/ai/searchTypes';
import { game5TurnRoot } from '../../src/game/ai/__tests__/fixtures/frozenFixtures';

const rules: RuleSet = createEngineRuleSet();
const OUT = resolve('PPC-P1-QUALITY-01/OLD_VS_NEW_DP.json');

type Scorer = 'old' | 'new';

function label(a: SearchAction | null | undefined): string {
  if (!a) return '?';
  if (a.type === 'catPlaceTrap') return 'T';
  if (a.type === 'catStep') return a.direction!.key.slice(5)[0]!;
  return '?';
}

function planText(plan: SearchAction[]): string {
  return plan.map((a) => label(a)).join('');
}

/**
 * One DP, two scorers. Mirrors `extractDp` exactly: same boundary checks, same
 * graphKey, same memo key (graphKey + prefix), same path guard, same action
 * order, same stable tie-break (`<` only).
 */
function referenceDp(
  state: GameEngineState,
  graph: EqualPrimaryGraph,
  planBranches: Map<string, SearchAction>,
  depthTurns: number,
  prefixKey: string | null,
  memo: Map<string, SearchAction[]>,
  maxLength: number,
  guard: Set<string>,
  scorer: Scorer,
): SearchAction[] {
  if (state.phase !== GamePhase.Playing || state.currentPlayer !== PieceType.Cat) return [];
  if (maxLength <= 0) return [];

  const sk = stateKey(state);
  const graphKey = `${sk}\x00${depthTurns}`;
  const memoKey = `${graphKey}#${prefixKey ?? 'null'}`;
  const cached = memo.get(memoKey);
  if (cached) return cached;
  if (guard.has(sk)) return [];
  guard.add(sk);

  const node = graph.get(graphKey);
  let actionsToTry: SearchAction[];
  if (node && node.equalActions.length > 1) actionsToTry = node.equalActions;
  else {
    const single = planBranches.get(sk);
    if (!single) { guard.delete(sk); return []; }
    actionsToTry = [single];
  }

  let bestPlan: SearchAction[] = [];
  let bestScore = Infinity;

  for (const action of actionsToTry) {
    const trans = simulateSearchAction(state, action, rules);

    let actionReversal = 0;
    if (action.type === 'catStep' && prefixKey !== null) {
      const dummy: SearchAction = { type: 'catStep', direction: { key: prefixKey, dr: 0, dc: 0, label: '' } };
      if (isImmediateReversal(dummy, action)) actionReversal = 1;
    }
    const childPrefixKey = action.type === 'catStep' ? action.direction!.key : null;

    let childPlan: SearchAction[];
    if (trans.kind === 'chance') childPlan = [];
    else {
      const childState = trans.state;
      const switched = state.currentPlayer !== childState.currentPlayer;
      if (switched || childState.phase !== GamePhase.Playing || childState.currentPlayer !== PieceType.Cat) childPlan = [];
      else childPlan = referenceDp(childState, graph, planBranches, depthTurns - (switched ? 1 : 0), childPrefixKey, memo, maxLength - 1, guard, scorer);
    }

    const fullPlan = [action, ...childPlan];
    const score = scorer === 'old'
      ? actionReversal + countReversals(childPlan)
      : countPlanReversals(prefixKey, fullPlan);

    if (score < bestScore || (score === bestScore && bestPlan.length === 0)) {
      bestPlan = fullPlan;
      bestScore = score;
    }
  }

  guard.delete(sk);
  memo.set(memoKey, bestPlan);
  return bestPlan;
}

function extractBoth(root: GameEngineState, graph: EqualPrimaryGraph, planBranches: Map<string, SearchAction>) {
  const rootKey = stateKey(root);
  let rootGraphKey: string | null = null;
  let rootDepth = 0;
  for (const gk of graph.keys()) {
    const sep = gk.lastIndexOf('\x00');
    if (sep >= 0 && gk.slice(0, sep) === rootKey) { rootGraphKey = gk; rootDepth = Number(gk.slice(sep + 1)); break; }
  }
  const result: Record<string, unknown> = {};
  if (!rootGraphKey) {
    result.error = 'no root graph entry (fallback walk would be used; not exercising the DP)';
    return result;
  }
  const node = graph.get(rootGraphKey)!;
  result.rootActions = node.equalActions.map((a) => label(a));
  result.rootEqualCount = node.equalActions.length;
  result.graphSize = graph.size;

  for (const scorer of ['old', 'new'] as Scorer[]) {
    const plan = referenceDp(root, graph, planBranches, rootDepth, null, new Map(), 24, new Set(), scorer);
    result[scorer] = {
      plan: planText(plan),
      length: plan.length,
      trueReversals: countReversals(plan),
    };
  }

  // Per-root-action best under each scorer, to expose WHERE the difference is
  // born (the root tie or a subtree).
  const perBranch: Record<string, unknown>[] = [];
  for (const action of node.equalActions) {
    const t = simulateSearchAction(root, action, rules);
    if (t.kind !== 'deterministic') { perBranch.push({ first: label(action), kind: t.kind }); continue; }
    const childPrefixKey = action.type === 'catStep' ? action.direction!.key : null;
    const switched = root.currentPlayer !== t.state.currentPlayer;
    const row: Record<string, unknown> = { first: label(action) };
    for (const scorer of ['old', 'new'] as Scorer[]) {
      const childPlan = (switched || t.state.currentPlayer !== PieceType.Cat)
        ? []
        : referenceDp(t.state, graph, planBranches, rootDepth, childPrefixKey, new Map(), 23, new Set(), scorer);
      const full = [action, ...childPlan];
      row[scorer] = {
        plan: planText(full),
        trueReversals: countReversals(full),
        // The number each scorer would charge at the ROOT for this branch:
        score: scorer === 'old'
          ? (action.type === 'catStep' ? 0 : 0) + countReversals(childPlan)
          : countPlanReversals(null, full),
      };
    }
    perBranch.push(row);
  }
  result.perBranch = perBranch;
  return result;
}

describe('PPC-P1-QUALITY-01 old vs new DP', () => {
  it('explains the LURD -> ULDR change on the real GAME2 T7 graph', () => {
    // Same source the HV14 gate uses: the recorded H1 log, not the frozen roots.
    const logPath = resolve('ai-training/human-logs/PPC-HV14/GAME2_H1.txt');
    const text = readFileSync(logPath, 'utf8');
    const lines = text.split(/\r?\n/);
    const starts: number[] = [];
    lines.forEach((l, i) => { if (/^Turn #\d+$/.test(l.trim())) starts.push(i); });
    const blocks = starts.map((s, k) => ({
      turn: Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]),
      lines: lines.slice(s + 1, k + 1 < starts.length ? starts[k + 1] : lines.length),
    }));
    const block = blocks.find((b) => b.turn === 7);
    expect(block, 'GAME2 Turn #7 must exist in the recorded log').toBeDefined();
    const snapLine = block!.lines.find((l) => l.startsWith('SNAPSHOT_JSON='))!;
    const snapshot = JSON.parse(snapLine.slice('SNAPSHOT_JSON='.length));

    const state = restoreHardRoot(snapshot);
    const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = true;
    const res = searchBestAction(state, 2, ctx);
    expect(res.completed).toBe(true);

    const graph = ctx.equalPrimaryGraph ?? new Map();
    const diff = extractBoth(state, graph, ctx.planBranches);

    writeFileSync(OUT, JSON.stringify({
      round: 'PPC-P1-QUALITY-01',
      kind: 'reference-DP differential (diagnostic, not production code)',
      root: 'ai-training/human-logs/PPC-HV14/GAME2_H1.txt Turn #7',
      protocol: 'depth 2, 500k nodes, evaluateCorrectedHoleForCat, TT+AB+ordering',
      primaryValue: res.value,
      primaryMate: res.mate,
      productionPlan: planText(res.catTurnPlan),
      differential: diff,
    }, null, 2), 'utf-8');

    console.log('OLD_VS_NEW_DP', JSON.stringify(diff));
    expect(diff.old).toBeDefined();
  });

  it('explains the ULDR -> DRUL change on the Game5 T15 progress-guard root', () => {
    // Same root the progressGuard P4/P8/P26 and m3lite D7 gates use.
    const t15 = game5TurnRoot(15);
    const ctx = createSearchContext(rules, 2_000_000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = true;
    const res = searchBestAction(t15, 2, ctx);
    expect(res.completed).toBe(true);

    const graph = ctx.equalPrimaryGraph ?? new Map();
    const diff = extractBoth(t15, graph, ctx.planBranches);

    writeFileSync(resolve('PPC-P1-QUALITY-01/OLD_VS_NEW_DP_T15.json'), JSON.stringify({
      round: 'PPC-P1-QUALITY-01',
      kind: 'reference-DP differential (diagnostic, not production code)',
      root: 'Game5 T15 (frozenFixtures.game5TurnRoot(15)), depth 2, 2M nodes, H1 leaf',
      primaryValue: res.value,
      primaryMate: res.mate,
      productionPlan: planText(res.catTurnPlan),
      differential: diff,
    }, null, 2), 'utf-8');

    console.log('OLD_VS_NEW_DP_T15', JSON.stringify(diff));
    expect(diff.old).toBeDefined();
  });
});
