/// <reference types="node" />
/**
 * PPC-CAT-EVALUATOR-ABLATION-01 §5 — REAL 100ms production path (P5), one round.
 *
 * Drives every frozen human root through the REAL production entry point
 *   computeCatAiTrajectory → planHardCatTurn → searchBestActionIterative
 *     → applyPlanCatAction (per-action, real rules)
 * with the leaf mode flipped between the two arms:
 *   E1 = setHardLeafMode('baseline')                → resolveHardLeaf()=evaluateForCat
 *   H1 = setHardLeafMode('baseline_hole_corrected') → resolveHardLeaf()=evaluateCorrectedHoleForCat
 *
 * The frozen production contract is NEVER touched:
 *   MAIN_SEARCH_SEMANTIC_BUDGET = DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn = 100ms
 *   TOTAL_TURN_HARD_WALL        = HARD_TRIAL.totalTurnBudgetMs                 = 150ms
 *   HARD_TRIAL.refutationEnabled = TRUE   (sidecar NOT disabled)
 *   HARD_PROGRESS_GUARD_CONFIG.enabled = FALSE
 * A spy WRAPS (never replaces) planHardCatTurn so the SAME single main call the
 * engine makes is observed for both the injected OPTIONS (proving the production
 * path + frozen budget + correct arm leaf) and the RESULT. The FIRST call is the
 * main turn-root search; any later call is a fallback re-plan (counted, not
 * mistaken for the main search).
 *
 * Three result layers are recorded DISTINCTLY (never conflated):
 *   mainSearch.baselinePlan = debug.baselinePlan  (primary search, pre-override)
 *   finalPlan               = planned.plan        (post sidecar/guard)
 *   executed.label          = the REAL step trajectory (ground truth)
 *
 * 150ms is a NOMINAL wall, NOT a physical certification: depth/nodes/elapsed are
 * RECORDED, never pinned (a wall-clock deadline legitimately flips completedDepth
 * between runs — see the Hard deadline nondeterminism record). One fresh process
 * per round (env ABLATION_ROUND); arm order alternates by (round+rootIndex)%2.
 */
import { test, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  computeCatAiTrajectory, type CatAiStep, type GameEngineState,
} from '../../src/game/engine';
import * as hardTurnPlannerModule from '../../src/game/ai/hardTurnPlanner';
import type { HardTurnPlan, HardTurnPlanOptions } from '../../src/game/ai/hardTurnPlanner';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { setHardLeafMode, resolveHardLeaf } from '../../src/game/ai/hybridLeaf';
import {
  DEFAULT_SEARCH_CONFIG, HARD_TRIAL, HARD_LEAF_MODE_CONFIG, HARD_PROGRESS_GUARD_CONFIG,
} from '../../src/game/ai/searchConfig';
import {
  OUT, HEAD, FIXTURE, FROZEN_FIXTURE_SHA, rootIds, loadRoot, snapshotSha,
  sha256, label, stateKey, leafFor, type Arm,
} from './ablation_lib';

const ROUND_N = Number(process.env.ABLATION_ROUND ?? '1');
const ROUND_PATH = `${OUT}/_raw/p5_round${ROUND_N}.json`;

const planLabel = (plan: SearchAction[]): string => plan.map((a) => label(a)).join('');

const dirLetter = (from: { r: number; c: number }, to: { r: number; c: number }): string => {
  const dr = to.r - from.r, dc = to.c - from.c;
  if (dr === -1 && dc === 0) return 'U';
  if (dr === 1 && dc === 0) return 'D';
  if (dc === -1 && dr === 0) return 'L';
  if (dc === 1 && dr === 0) return 'R';
  return '?';
};
/** The REAL executed trajectory, one letter per engine step (ground truth). */
const executedLabel = (steps: CatAiStep[]): string => steps.map((s) => {
  switch (s.detail) {
    case '放置陷阱': return 'T';
    case '收回陷阱': return 'C';
    case '守入口结束回合': return 'E';
    case '抓鼠': return 'W';
    case '结束': return 'X';
    case '强制移动': return 'F';
    default: return dirLetter(s.from, s.to);
  }
}).join('');

interface Observed {
  plan: HardTurnPlan; options: HardTurnPlanOptions; rootAtPlanTime: GameEngineState; calls: number;
}

/** Run ONE production cat turn for one arm, observing (not replacing) the planner. */
function runArm(root: GameEngineState, arm: Arm): { obs: Observed; steps: CatAiStep[]; turnWallMs: number } {
  const mode = arm === 'E1' ? 'baseline' : 'baseline_hole_corrected';
  setHardLeafMode(mode);
  expect(HARD_LEAF_MODE_CONFIG.current).toBe(mode);
  expect(resolveHardLeaf()).toBe(leafFor(arm));

  const captured: Partial<Observed> = { calls: 0 };
  const original = hardTurnPlannerModule.planHardCatTurn;
  const spy = vi.spyOn(hardTurnPlannerModule, 'planHardCatTurn').mockImplementation(
    ((state: GameEngineState, options: HardTurnPlanOptions): HardTurnPlan => {
      captured.calls = (captured.calls ?? 0) + 1;
      const result = original(state, options);
      if (captured.calls === 1) {            // FIRST call = the main turn-root search
        captured.rootAtPlanTime = state;
        captured.options = options;
        captured.plan = result;
      }
      return result;
    }) as typeof hardTurnPlannerModule.planHardCatTurn,
  );
  let steps: CatAiStep[] | null = null;
  const t0 = performance.now();
  try {
    steps = computeCatAiTrajectory(root);
  } finally {
    spy.mockRestore();
    setHardLeafMode('baseline');             // restore default; no leakage to next arm
  }
  const turnWallMs = performance.now() - t0;
  expect(steps).not.toBeNull();              // a cat-to-move playing root must produce a turn
  return { obs: captured as Observed, steps: steps!, turnWallMs };
}

function recordRoot(rootId: string, arm: Arm, orderIdx: number) {
  const root = loadRoot(rootId);
  const { obs, steps, turnWallMs } = runArm(root, arm);
  const planned = obs.plan;
  const debug = planned.debug;
  const finalState = steps[steps.length - 1].state;
  const hist = finalState.hardSearchHistory ?? [];
  const entry = hist[hist.length - 1];
  const fallbackMarkers = finalState.catActionLog.filter(
    (l) => l.includes('SEARCH_FALLBACK') || l.includes('HARD_FALLBACK_MOVE'),
  );
  const ref = debug.refutation;
  return {
    rootId, arm, orderIdx, stateKey: stateKey(root), snapshotSha256: snapshotSha(rootId),
    plannerCalls: obs.calls,
    budget: {
      timeBudgetMs: obs.options.timeBudgetMs,
      refutationEnabled: obs.options.refutation?.enabled ?? null,
      totalTurnBudgetMs: obs.options.refutation?.totalTurnBudgetMs ?? null,
      leafIsArm: obs.options.leafEvaluator === leafFor(arm),
      leafMode: arm === 'E1' ? 'baseline' : 'baseline_hole_corrected',
      guardEnabled: HARD_PROGRESS_GUARD_CONFIG.enabled,
      rootAtPlanTimeMatches: stateKey(obs.rootAtPlanTime) === stateKey(root),
    },
    mainSearch: {
      completedDepth: planned.completedDepth,
      attemptedDepth: planned.attemptedDepth,
      deadlineFired: planned.deadlineFired,
      budgetFired: planned.budgetFired,
      nodes: planned.search.diagnostics?.totalNodes ?? null,
      elapsedMs: planned.elapsedMs,
      rootValue: planned.search.value,
      mate: planned.search.mate,
      baselinePlan: planLabel(debug.baselinePlan),
      rootActions: (planned.search.rootActions ?? []).map((r) => ({
        action: planLabel([r.action]), value: r.value, mate: r.mate, bound: r.bound ?? 'unknown',
      })),
    },
    sidecar: ref ? {
      refutationEnabled: ref.refutationEnabled,
      refutationTriggered: ref.refutationTriggered,
      overrideUsed: ref.overrideUsed,
      selectedPlanSource: ref.selectedPlanSource,
      sidecarAbortReason: ref.sidecarAbortReason ?? null,
    } : null,
    finalPlan: planLabel(planned.plan),
    finalPlanDebug: planLabel(debug.plan),
    hasSolution: planned.hasSolution,
    executed: {
      label: executedLabel(steps),
      details: steps.map((s) => s.detail),
      path: steps.map((s) => `${s.from.r},${s.from.c}->${s.to.r},${s.to.c}`),
      stepCount: steps.length,
      matchedPlan: entry?.execution.matchedPlan ?? null,
      planCompleted: entry?.execution.planCompleted ?? null,
      fallbackOccurred: entry?.execution.fallbackOccurred ?? null,
      invalidActionOccurred: entry?.execution.invalidActionOccurred ?? null,
      reachedLegalBoundary: entry?.execution.reachedLegalBoundary ?? null,
    },
    fallbackMarkers,
    turnWallMs,
    overMainBudget: planned.elapsedMs > obs.options.timeBudgetMs,
    overTurnBudget: turnWallMs > (obs.options.refutation?.totalTurnBudgetMs ?? Infinity),
    finalPhase: finalState.phase,
    finalCurrentPlayer: finalState.currentPlayer,
    finalCatMovesLeft: finalState.catMovesLeft,
  };
}

test(`P5 round ${ROUND_N}: 24 roots × E1/H1 through the real 100ms production path`, () => {
  // provenance + frozen production contract (assert once per round)
  expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);
  expect(DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn).toBe(100);
  expect(HARD_TRIAL.refutationEnabled).toBe(true);
  expect(HARD_TRIAL.totalTurnBudgetMs).toBe(150);
  expect(HARD_PROGRESS_GUARD_CONFIG.enabled).toBe(false);
  expect(rootIds.length).toBe(24);

  const rows: ReturnType<typeof recordRoot>[] = [];
  rootIds.forEach((rootId, i) => {
    const order: Arm[] = ((ROUND_N + i) % 2 === 0) ? ['E1', 'H1'] : ['H1', 'E1'];
    order.forEach((arm, k) => {
      const rec = recordRoot(rootId, arm, k);
      // per-row proof: the production path was reached with the frozen budget + arm leaf
      expect(rec.budget.timeBudgetMs).toBe(100);
      expect(rec.budget.refutationEnabled).toBe(true);
      expect(rec.budget.totalTurnBudgetMs).toBe(150);
      expect(rec.budget.leafIsArm).toBe(true);
      expect(rec.budget.guardEnabled).toBe(false);
      expect(rec.budget.rootAtPlanTimeMatches).toBe(true);
      expect(rec.plannerCalls).toBeGreaterThanOrEqual(1);
      expect(rec.finalPlan).toBe(rec.finalPlanDebug);
      rows.push(rec);
      console.log(
        `[R${ROUND_N} ${rootId} ${arm}] depth=${rec.mainSearch.completedDepth}/${rec.mainSearch.attemptedDepth}` +
        ` baseline=${rec.mainSearch.baselinePlan} final=${rec.finalPlan} exec=${rec.executed.label}` +
        ` matched=${rec.executed.matchedPlan} fallback=${rec.executed.fallbackOccurred}` +
        ` override=${rec.sidecar?.overrideUsed ?? '-'} calls=${rec.plannerCalls}` +
        ` main=${rec.mainSearch.elapsedMs.toFixed(1)}ms turn=${rec.turnWallMs.toFixed(1)}ms`,
      );
    });
  });

  expect(rows.length).toBe(rootIds.length * 2);   // 48
  mkdirSync(`${OUT}/_raw`, { recursive: true });
  writeFileSync(ROUND_PATH, JSON.stringify({
    round: ROUND_N, head: HEAD, fixtureSha256: FROZEN_FIXTURE_SHA,
    generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p5_production.test.ts`,
    armOrderScheme: '(round+rootIndex)%2 === 0 ? [E1,H1] : [H1,E1]',
    contract: {
      mainSearchBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
      totalTurnBudgetMs: HARD_TRIAL.totalTurnBudgetMs,
      refutationEnabled: HARD_TRIAL.refutationEnabled,
      progressGuardEnabled: HARD_PROGRESS_GUARD_CONFIG.enabled,
    },
    rows,
  }, null, 2));
  console.log(`[R${ROUND_N}] wrote ${ROUND_PATH} rows=${rows.length}`);
}, 600_000);