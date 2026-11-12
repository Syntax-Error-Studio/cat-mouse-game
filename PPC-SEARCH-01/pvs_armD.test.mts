/**
 * PPC-SEARCH-01 — ARM D: the bound-contract fix, tested against the blocker it
 * was written for.
 *
 * Arm B (as pre-registered) let a null-window node inherit `best.bound`. Because
 * a leaf reports 'exact', a scout that had only proved "no better than X" was
 * certified `completed && bound==='exact'`, entered the EXACT-only TT and the
 * certified-tie graph. Arm D states the missing fact (a node that entered with a
 * degenerate window is an unresolved bound in both directions) and therefore
 * can neither store nor certify a scout result.
 *
 * Two questions only:
 *   1. does arm D restore bestAction/catTurnPlan identity with production where
 *      arm B lost it (G1T10 root, C_PUSH control)?
 *   2. does the G1T10 node explosion survive the fix?
 *
 * Memory is reported as a heap/RSS delta around the search plus the live TT
 * entry count — not as a claim about the whole process.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { corpus, controls, runFixed, labelAction, labelPlan, LEAF, RULES, type ArmResult } from './pvs_lib.mts';
import {
  createSearchContext as createForkContext,
  searchBestAction as searchFork,
  setPvsEnabled,
  setPvsChanceExempt,
  setPvsStrictBounds,
  resetPvsCounters,
  pvsCounters,
} from './proto/expectiminimaxPvs';
import type { GameEngineState } from '../src/game/engine';

const OUT = 'PPC-SEARCH-01/out';
const FIELDS = ['value', 'mate', 'completed', 'bestAction', 'plan'] as const;

function diff(a: ArmResult, b: ArmResult): string[] {
  const out: string[] = [];
  for (const f of FIELDS) if (a[f] !== b[f]) out.push(`${f}: ${String(a[f])} != ${String(b[f])}`);
  return out;
}

function runD(
  state: GameEngineState,
  depth: number,
): ArmResult & { ttSize: number; heapDeltaMiB: number; rssDeltaMiB: number } {
  setPvsEnabled(true);
  setPvsChanceExempt(false);
  setPvsStrictBounds(true);
  resetPvsCounters();
  const ctx = createForkContext(RULES, 2_000_000, true, true, true, 0, false);
  ctx.capturePlan = true;
  ctx.leafEvaluator = LEAF;
  ctx.now = () => 0;
  const m0 = process.memoryUsage();
  const t0 = performance.now();
  const r = searchFork(state, depth, ctx);
  const wall = performance.now() - t0;
  const m1 = process.memoryUsage();
  const d = r.diagnostics;
  return {
    arm: 'B',
    rootId: '',
    depth,
    value: r.value,
    mate: r.mate,
    completed: r.completed,
    bestAction: labelAction(r.action),
    plan: labelPlan(r.catTurnPlan ?? []),
    nodes: d.nodes,
    chanceNodes: d.chanceNodes,
    cutoffs: d.alphaBetaCutoffs,
    maxCutoffs: d.alphaBetaMaxCutoffs,
    minCutoffs: d.alphaBetaMinCutoffs,
    ttExactHits: d.ttExactHits,
    ttHits: d.ttHits,
    ttStores: d.ttStores,
    ttSize: ctx.tt.size,
    leafNodes: d.leafNodes,
    terminalNodes: d.terminalNodes,
    firstMoveCutoffs: d.firstMoveCutoffCount,
    orderedNodes: d.orderedNodes,
    fullWindowChanceSearches: d.fullWindowChanceSearches,
    budgetCutoffs: d.budgetCutoffs,
    deadlineCutoffs: d.deadlineCutoffs,
    wallMs: +wall.toFixed(3),
    pvs: { ...pvsCounters },
    heapDeltaMiB: +((m1.heapUsed - m0.heapUsed) / 1048576).toFixed(1),
    rssDeltaMiB: +((m1.rss - m0.rss) / 1048576).toFixed(1),
  };
}

describe('PPC-SEARCH-01 arm D (bound-contract fix)', () => {
  it('D-vs-A and D-vs-B on the affordable roots + the diverging control', () => {
    writeFileSync(`${OUT}/s7_armD.jsonl`, '');
    const cases: Array<{ id: string; state: GameEngineState }> = [
      ...['G1T10', 'G1T1', 'G4T2', 'G1T5'].map((id) => ({
        id,
        state: corpus().find((c) => c.id === id)!.root,
      })),
      { id: 'C_PUSH', state: controls().find((c) => c.id === 'C_PUSH')!.state },
    ];
    for (const c of cases) {
      for (const d of [1, 2]) {
        const a = runFixed('A', c.state, d);
        const b = runFixed('B', c.state, d);
        const x = runD(c.state, d);
        const row = {
          id: c.id,
          d,
          diffBA: diff(a, b),
          diffDA: diff(a, x),
          nodes: { a: a.nodes, b: b.nodes, d: x.nodes },
          ms: { a: a.wallMs, b: b.wallMs, d: x.wallMs },
          chance: { a: a.chanceNodes, b: b.chanceNodes, d: x.chanceNodes },
          stores: { a: a.ttStores, b: b.ttStores, d: x.ttStores },
          exactHits: { a: a.ttExactHits, b: b.ttExactHits, d: x.ttExactHits },
          ttSize: { a: a.ttSize, b: b.ttSize, d: x.ttSize },
          memD: { heapDeltaMiB: x.heapDeltaMiB, rssDeltaMiB: x.rssDeltaMiB },
          pvsD: x.pvs,
          plan: { a: a.plan, b: b.plan, d: x.plan },
        };
        appendFileSync(`${OUT}/s7_armD.jsonl`, JSON.stringify(row) + '\n');
        console.log(
          `[D] ${c.id} D${d} Bdiff=${row.diffBA.length} Ddiff=${row.diffDA.length} nodes A${a.nodes}/B${b.nodes}/D${x.nodes} ms ${a.wallMs}/${b.wallMs}/${x.wallMs}`,
        );
      }
    }
    expect(true).toBe(true);
  }, 3_600_000);
});
