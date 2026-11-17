/// <reference types="node" />
/**
 * PPC-P1-PLAN-01 — empirical bound table (diagnostic only).
 *
 * Exhaustive DFS over the real cat-action graph, compared against
 * `maxCatTurnPlanActions`. Neither side consults the other, so agreement is
 * evidence rather than a tautology.
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GameEngineState } from '../../src/game/engine';
import { maxCatTurnPlanActions } from '../../src/game/ai/planBound';
import { catTurnRoot, dfsLongestPlan, TUNNELS } from '../../src/game/ai/__tests__/planActionBoundFixtures';

const OUT = resolve(process.env.PPC_BOUND_OUT ?? 'PPC-P1-PLAN-01/BOUND_DFS_TABLE.json');

function corridorWalls(col: number, r0: number, r1: number): { r: number; c: number }[] {
  const hole = { r: 7, c: 8, size: 2 };
  const inHole = (r: number, c: number): boolean =>
    r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;
  const isTunnel = (r: number, c: number): boolean => TUNNELS.some((t) => t.r === r && t.c === c);
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (c === col && r >= r0 && r <= r1) continue;
      if (inHole(r, c) || isTunnel(r, c)) continue;
      out.push({ r, c });
    }
  }
  return out;
}

describe('PPC-P1-PLAN-01 bound table', () => {
  it('records DFS max vs bound', () => {
    const rows: unknown[] = [];
    const push = (name: string, root: GameEngineState) => {
      const bound = maxCatTurnPlanActions(root);
      const dfs = dfsLongestPlan(root, bound);
      rows.push({
        board: name,
        catMovesLeft: root.catMovesLeft,
        catTrapsRemaining: root.catTrapsRemaining,
        bound,
        longestLegalSequence: dfs.maxLen,
        exceeded: dfs.exceeded,
        dfsTruncated: dfs.truncated,
        visits: dfs.visits,
      });
    };

    for (const m of [1, 2, 3, 4, 5]) {
      push(`corridor M=${m}`, catTurnRoot({
        cat: { r: 1, c: 3 }, mouse: { r: 8, c: 8 }, catBaseMoves: m, traps: 1,
        walls: corridorWalls(3, 1, 6),
      }));
    }
    for (const m of [6, 9]) {
      push(`corridor M=${m}`, catTurnRoot({
        cat: { r: 1, c: 3 }, mouse: { r: 8, c: 8 }, catBaseMoves: m, traps: 1,
        walls: corridorWalls(3, 1, 6),
      }));
    }
    for (const m of [2, 3, 4, 6]) {
      push(`open M=${m}`, catTurnRoot({
        cat: { r: 2, c: 2 }, mouse: { r: 8, c: 8 }, catBaseMoves: m, traps: 1,
      }));
    }
    push('open M=6, no trap stock', catTurnRoot({
      cat: { r: 2, c: 2 }, mouse: { r: 8, c: 8 }, catBaseMoves: 6, traps: 0,
    }));

    writeFileSync(OUT, JSON.stringify({ rows }, null, 2), 'utf-8');
    for (const r of rows as { board: string; bound: number; longestLegalSequence: number; exceeded: boolean; dfsTruncated: boolean }[]) {
      console.log(`BOUND ${r.board.padEnd(24)} bound=${String(r.bound).padStart(3)} dfsMax=${String(r.longestLegalSequence).padStart(3)} exceeded=${r.exceeded} dfsTruncated=${r.dfsTruncated}`);
    }
    expect((rows as { exceeded: boolean }[]).some((r) => r.exceeded)).toBe(false);
  });
});
