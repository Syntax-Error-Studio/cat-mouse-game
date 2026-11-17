/**
 * PPC-MCTS-01 — RACE-Search control arm.
 *
 * The frozen production configuration is used verbatim:
 *   maxDepthTurns=4, maxNodes=500000, useTT, useAlphaBeta, useMoveOrdering,
 *   useThreatOrdering=false, maxThreatExtensions=0,
 *   leafEvaluator=hybridEvaluateForCat.
 * The bounded-refutation sidecar and the Progress Guard are OFF. The main
 * search budget is the same 100 ms as every UCT arm; the full-turn wall is
 * 150 ms (measured, never enlarged).
 */
import type { GameEngineState } from '../../src/game/engine';
import { createEngineRuleSet } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import type { RuleSet } from '../../src/game/ai/searchTypes';
import { planHardCatTurn } from '../../src/game/ai/hardTurnPlanner';
import { hybridEvaluateForCat } from '../../src/game/ai/hybridLeaf';
import type { MateSide, SearchBoundType } from '../../src/game/ai/expectiminimax';

export interface RootActionValue {
  action: SearchAction;
  value: number;
  mate: MateSide;
  bound?: SearchBoundType;
}

export interface RaceResult {
  plan: SearchAction[];
  bestAction: SearchAction | null;
  completed: boolean;
  completedDepth: number;
  attemptedDepth: number;
  value: number;
  mate: MateSide;
  nodes: number;
  searchMs: number;
  planMs: number;
  totalMs: number;
  deadlineFired: boolean;
  budgetFired: boolean;
  rootActions: RootActionValue[];
  ttHits: number;
  alphaBetaCutoffs: number;
  iterations: { depthTurns: number; completed: boolean; nodesUsed: number; value: number; mate: MateSide }[];
}

export function runRace(
  root: GameEngineState,
  opts: { rules?: RuleSet; now?: () => number } = {},
): RaceResult {
  const rules = opts.rules ?? createEngineRuleSet();
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const hard = planHardCatTurn(structuredClone(root), {
    rules,
    timeBudgetMs: 100,
    maxNodes: 500_000,
    maxDepthTurns: 4,
    leafEvaluator: hybridEvaluateForCat,
    now,
  });
  const searchMs = now() - t0;
  const plan = hard.plan.slice();
  const planMs = now() - t0 - searchMs;
  return {
    plan,
    bestAction: hard.bestAction,
    completed: hard.search.completed,
    completedDepth: hard.completedDepth,
    attemptedDepth: hard.attemptedDepth,
    value: hard.search.value,
    mate: hard.search.mate,
    nodes: hard.search.diagnostics.totalNodes,
    searchMs,
    planMs,
    totalMs: now() - t0,
    deadlineFired: hard.deadlineFired,
    budgetFired: hard.budgetFired,
    rootActions: hard.search.rootActions.map((r) => ({
      action: r.action, value: r.value, mate: r.mate, bound: r.bound,
    })),
    ttHits: hard.search.diagnostics.ttHits,
    alphaBetaCutoffs: hard.search.diagnostics.alphaBetaCutoffs,
    iterations: hard.search.iterations.map((it) => ({
      depthTurns: it.depthTurns, completed: it.completed, nodesUsed: it.nodesUsed,
      value: it.value, mate: it.mate,
    })),
  };
}
