/// <reference types="node" />
/**
 * PPC-P1-QUALITY-01 — bounded extraction-cost check at larger legal move
 * budgets. DIAGNOSTIC ONLY: one pass, no repetitions, no efficacy authority.
 *
 * The question this answers is narrow: does the post-search DP cost grow in a
 * way that would matter once `catBaseMoves` is larger than the production
 * default of 4? It is measured on the same dead-end corridor the reversal
 * counterexample uses, so the only variable is the move budget.
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { GameEngineState } from '../../src/game/engine';
import { GamePhase, PieceType } from '../../src/game/types';
import { createEngineRuleSet } from '../../src/game/engine';
import { createInitialState } from '../../src/game/engine';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/game/config';
import { CellType } from '../../src/game/types';
import { buildCatTurnPlan, createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { extractBestCatTurnPlan, planFullTurnCompleteness } from '../../src/game/ai/planQuality';
import { maxCatTurnPlanActions } from '../../src/game/ai/planBound';

const OUT = resolve('PPC-P1-QUALITY-01/EXTRACTION_COST.json');
const rules = createEngineRuleSet();

function corridor(moves: number, size = 7): GameEngineState {
  const terrain = Array.from({ length: size }, () => Array(size).fill(CellType.Wall));
  for (let r = 0; r < size; r++) terrain[r][2] = CellType.Empty;
  for (let r = size - 3; r < size; r++) for (let c = size - 3; c < size; c++) terrain[r][c] = CellType.Empty;
  terrain[size - 2][size - 1] = CellType.MouseHole;
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    boardSize: size,
    mouseHole: { r: size - 2, c: size - 1, size: 1 },
    catStart: { r: 1, c: 2 },
    mouseStart: { r: size - 2, c: size - 2 },
    catBaseMoves: moves,
    boxCount: 0, pileCount: 0, butterCount: 0,
    boxPositions: [], pilePositions: [], butterPositions: [],
    customTerrain: terrain,
    tunnelCorners: [],
    difficulty: 'hard',
  };
  return { ...createInitialState(config), currentPlayer: PieceType.Cat };
}

describe('PPC-P1-QUALITY-01 extraction cost', () => {
  it('measures DP post-processing at move budgets 2..9', () => {
    const rows: unknown[] = [];

    for (const moves of [2, 3, 4, 6, 7, 9]) {
      const root = corridor(moves);
      const ctx = createSearchContext(rules, 200_000, true, false, false, 0, false);
      ctx.capturePlan = true;
      ctx.leafEvaluator = (s) => (s.trapPosition === null ? 0 : -1);

      const t0 = performance.now();
      const res = searchBestAction(root, 1, ctx);
      const searchMs = performance.now() - t0;

      const t1 = performance.now();
      const walk = buildCatTurnPlan(root, ctx);
      const walkMs = performance.now() - t1;

      const t2 = performance.now();
      const dp = extractBestCatTurnPlan(root, rules, ctx.equalPrimaryGraph ?? new Map(), ctx.planBranches);
      const dpMs = performance.now() - t2;

      const verdict = planFullTurnCompleteness(root, res.catTurnPlan, rules);

      rows.push({
        moves,
        bound: maxCatTurnPlanActions(root),
        completed: res.completed,
        nodes: res.diagnostics.nodes,
        graphNodes: ctx.equalPrimaryGraph?.size ?? 0,
        planBranches: ctx.planBranches.size,
        searchMs: +searchMs.toFixed(3),
        walkMs: +walkMs.toFixed(3),
        dpMs: +dpMs.toFixed(3),
        walkLen: walk.length,
        dpLen: dp.length,
        planLen: res.catTurnPlan.length,
        verdict: verdict.kind,
        dpOverSearchPct: +(100 * dpMs / Math.max(searchMs, 0.001)).toFixed(3),
      });

      expect(res.completed, `M=${moves} must complete for the cost to be meaningful`).toBe(true);
      expect(verdict.kind).toBe('COMPLETE_TURN_BOUNDARY');
    }

    writeFileSync(OUT, JSON.stringify({
      label: 'DIAGNOSTIC_ONLY',
      protocol: 'single pass, corridor root, diagnostic leaf, 200k node budget',
      note: 'not a formal benchmark; no efficacy authority',
      rows,
    }, null, 2), 'utf-8');

    console.log('PPC_QUALITY_COST', JSON.stringify(rows.map((r) => {
      const x = r as { moves: number; dpMs: number; searchMs: number; graphNodes: number; dpLen: number };
      return { M: x.moves, dpMs: x.dpMs, searchMs: x.searchMs, graphNodes: x.graphNodes, dpLen: x.dpLen };
    })));
  });
});
