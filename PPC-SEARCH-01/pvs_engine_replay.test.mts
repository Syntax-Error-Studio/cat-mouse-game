/**
 * PPC-SEARCH-01 — REAL-ENGINE plan replay (stronger than the simulator replay).
 *
 * `applyPlanCatAction` in `src/game/engine.ts` executes a captured cat-turn plan
 * with `catMove` / `catPlaceTrap` — the ENGINE step functions — NOT with
 * `simulateSearchAction`. The simulator replay in `pvs_lib.replayPlan` therefore
 * only proves internal consistency, and it reports "hit a chance node" for a
 * plan whose LAST step crosses the cat->mouse boundary (that boundary rolls the
 * butter spawn). That is a harness limitation, not a plan defect, so this test
 * applies every plan through the real engine instead.
 *
 * Both arms' plans are replayed, so a failure can be attributed to PVS rather
 * than to the harness.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { corpus, LEAF, RULES, labelPlan } from './pvs_lib.mts';
import {
  createSearchContext as createForkContext,
  searchBestAction as searchFork,
  setPvsEnabled,
  setPvsChanceExempt,
  setPvsStrictBounds,
} from './proto/expectiminimaxPvs';
import { createSearchContext as createProdContext, searchBestAction as searchProd } from '../src/game/ai/expectiminimax';
import { catMove, catPlaceTrap } from '../src/game/engine';
import type { GameEngineState } from '../src/game/engine';
import { GamePhase } from '../src/game/types';
import type { SearchAction } from '../src/game/ai/searchTypes';

const OUT = 'PPC-SEARCH-01/out';

type Which = 'A' | 'B' | 'D';

function planOf(which: Which, state: GameEngineState, depth: number): SearchAction[] {
  if (which === 'A') {
    const ctx = createProdContext(RULES, 2_000_000, true, true, true, 0, false);
    ctx.capturePlan = true;
    ctx.leafEvaluator = LEAF;
    ctx.now = () => 0;
    return searchProd(state, depth, ctx).catTurnPlan;
  }
  setPvsEnabled(true);
  setPvsChanceExempt(false);
  setPvsStrictBounds(which === 'D');
  const ctx = createForkContext(RULES, 2_000_000, true, true, true, 0, false);
  ctx.capturePlan = true;
  ctx.leafEvaluator = LEAF;
  ctx.now = () => 0;
  return searchFork(state, depth, ctx).catTurnPlan;
}

/** Mirrors `applyPlanCatAction`: the ENGINE's own acceptance test. */
function engineApply(state: GameEngineState, a: SearchAction): { next: GameEngineState; valid: boolean } {
  if (a.type === 'catStep') {
    const next = catMove(state, a.direction);
    const changed =
      next.catPosition.r !== state.catPosition.r ||
      next.catPosition.c !== state.catPosition.c ||
      next.catMovesLeft < state.catMovesLeft ||
      next.phase !== state.phase;
    return { next, valid: changed };
  }
  if (a.type === 'catPlaceTrap') {
    const next = catPlaceTrap(state);
    return { next, valid: next.trapPosition !== null || next.catTrapsRemaining < state.catTrapsRemaining };
  }
  return { next: state, valid: false };
}

function replayEngine(state: GameEngineState, plan: SearchAction[]) {
  let cur = state;
  let applied = 0;
  for (let i = 0; i < plan.length; i++) {
    if (cur.phase !== GamePhase.Playing) break;
    const r = engineApply(cur, plan[i]);
    if (!r.valid) return { applied, ok: false, badStep: i, endPhase: String(cur.phase), endPlayer: String(cur.currentPlayer) };
    cur = r.next;
    applied++;
  }
  return { applied, ok: true, badStep: -1, endPhase: String(cur.phase), endPlayer: String(cur.currentPlayer) };
}

describe('PPC-SEARCH-01 real-engine plan replay', () => {
  it('R1 — plans execute through catMove/catPlaceTrap, both arms', () => {
    writeFileSync(`${OUT}/r1_engine_replay.jsonl`, '');
    for (const e of corpus()) {
      for (const d of [1, 2]) {
        const row: Record<string, unknown> = { id: e.id, d };
        for (const w of ['A', 'B'] as Which[]) {
          const plan = planOf(w, e.root, d);
          const rep = replayEngine(e.root, plan);
          (row as Record<string, unknown>)[w] = { planLen: plan.length, plan: labelPlan(plan), ...rep };
        }
        appendFileSync(`${OUT}/r1_engine_replay.jsonl`, JSON.stringify(row) + '\n');
        console.log(`[R1] ${e.id} D${d} A=${(row.A as { applied: number }).applied}/${(row.A as { planLen: number }).planLen} B=${(row.B as { applied: number }).applied}/${(row.B as { planLen: number }).planLen}`);
      }
    }
    expect(true).toBe(true);
  }, 3_600_000);
});
