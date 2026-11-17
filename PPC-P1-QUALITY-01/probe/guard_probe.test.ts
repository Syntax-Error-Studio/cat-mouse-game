/// <reference types="node" />
/**
 * PPC-P1-QUALITY-01 — what the Game5 T15 progress-guard gates actually produce
 * after the accounting fix. Diagnostic only: it prints the fields the P4/P8/P26
 * and m3lite D7 assertions pin, so the re-judgement is based on numbers.
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';

import { createEngineRuleSet, type GameEngineState } from '../../src/game/engine';
import { planHardCatTurn } from '../../src/game/ai/hardTurnPlanner';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { resolveHardLeaf, setHardLeafMode } from '../../src/game/ai/hybridLeaf';
import { HARD_PROGRESS_GUARD_CONFIG } from '../../src/game/ai/searchConfig';
import {
  replayCatPlanLabel, progressGuardTrigger, type LoopSignature,
} from '../../src/game/ai/progressGuard';
import type { HardProgressGuardMemory } from '../../src/game/ai/progressGuard';
import { game5TurnRoot } from '../../src/game/ai/__tests__/fixtures/frozenFixtures';
import { countReversals } from '../../src/game/ai/planQuality';
import type { SearchAction } from '../../src/game/ai/searchTypes';

const rules = createEngineRuleSet();
const H1Leaf = (s: GameEngineState): number => evaluateCorrectedHoleForCat(s);

function label(a: SearchAction): string {
  return a.type === 'catPlaceTrap' ? 'T' : a.type === 'catStep' ? a.direction!.key.slice(5)[0]! : '?';
}

function mem(prev: { noProgressLoop: boolean; sig: LoopSignature | null; mouseObserved?: boolean }): HardProgressGuardMemory {
  return {
    version: 1,
    previousNoProgressLoop: prev.noProgressLoop,
    previousSignature: prev.sig ?? null,
    previousPlanLabel: prev.sig?.plan ?? '',
    previousCatStart: prev.sig?.catStart ?? '',
    previousCatEnd: prev.sig?.catEnd ?? '',
    mouseTurnObserved: prev.mouseObserved ?? true,
  };
}

describe('PPC-P1-QUALITY-01 T15 guard probe', () => {
  it('records the plans the guard gates pin', () => {
    setHardLeafMode('baseline_hole_corrected');
    expect(typeof resolveHardLeaf).toBe('function');
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;

    const t15 = game5TurnRoot(15);

    const depth1 = planHardCatTurn(t15, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 1, maxNodes: 2_000_000,
      leafEvaluator: H1Leaf, refutation: { enabled: false },
    });
    const depth2 = planHardCatTurn(t15, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000,
      leafEvaluator: H1Leaf, refutation: { enabled: false },
    });

    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    const prevSig = replayCatPlanLabel(game5TurnRoot(14), 'ULDR').signature;
    const memory = mem({ noProgressLoop: true, sig: prevSig, mouseObserved: true });
    const guarded = planHardCatTurn(t15, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000,
      leafEvaluator: H1Leaf, refutation: { enabled: false },
      progressGuard: { passMemory: memory, totalTurnBudgetMs: 600000 },
    });
    // Second arm: memory built from the loop the planner ACTUALLY produces now,
    // which is what "the same no-progress loop happened last turn" means.
    const actualLabel = depth2.search.catTurnPlan.map(label).join('');
    const actualSig = replayCatPlanLabel(game5TurnRoot(14), actualLabel).signature;
    const memoryActual = mem({ noProgressLoop: true, sig: actualSig, mouseObserved: true });
    const guardedActual = planHardCatTurn(t15, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000,
      leafEvaluator: H1Leaf, refutation: { enabled: false },
      progressGuard: { passMemory: memoryActual, totalTurnBudgetMs: 600000 },
    });
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;

    const cur = replayCatPlanLabel(t15, depth2.search.catTurnPlan.map(label).join(''));
    const trigger = progressGuardTrigger({ previous: memory, currentFacts: cur, realMouseTurnElapsed: true });

    const record = {
      round: 'PPC-P1-QUALITY-01',
      root: 'Game5 T15',
      depth1Plan: depth1.plan.map(label).join(''),
      depth2Plan: depth2.search.catTurnPlan.map(label).join(''),
      depth2CompletedDepth: depth2.search.completedDepth,
      previousCompletedPlan: depth2.search.previousCompletedPlan.map(label).join(''),
      previousCompletedDepth: depth2.search.previousCompletedDepth,
      guardedPlan: guarded.plan.map(label).join(''),
      guardDebug: {
        rescueApplied: guarded.debug.progressGuard?.rescueApplied,
        originalPlan: guarded.debug.progressGuard?.originalPlan,
        rescuePlan: guarded.debug.progressGuard?.rescuePlan,
        triggered: guarded.debug.progressGuard?.triggered,
        abortReason: guarded.debug.progressGuard?.abortReason,
      },
      guardedActualPlan: guardedActual.plan.map(label).join(''),
      guardedActualDebug: {
        rescueApplied: guardedActual.debug.progressGuard?.rescueApplied,
        originalPlan: guardedActual.debug.progressGuard?.originalPlan,
        rescuePlan: guardedActual.debug.progressGuard?.rescuePlan,
        triggered: guardedActual.debug.progressGuard?.triggered,
        abortReason: guardedActual.debug.progressGuard?.abortReason,
      },
      trigger,
      reversals: {
        depth1Plan: countReversals(depth1.plan),
        depth2Plan: countReversals(depth2.search.catTurnPlan),
        previousCompletedPlan: countReversals(depth2.search.previousCompletedPlan),
        guardedPlan: countReversals(guarded.plan),
      },
      oldExpectations: {
        depth2Plan: 'ULDR',
        previousCompletedPlan: 'DDLD',
        guardedPlan: 'DDLD',
        guardedOriginalPlan: 'ULDR',
      },
    };

    writeFileSync('PPC-P1-QUALITY-01/T15_GUARD_PROBE.json', JSON.stringify(record, null, 2), 'utf-8');
    console.log('T15_GUARD_PROBE', JSON.stringify(record));
    expect(record.depth2CompletedDepth).toBe(2);
  });
});
