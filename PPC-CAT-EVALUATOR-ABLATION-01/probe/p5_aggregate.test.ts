/// <reference types="node" />
/**
 * PPC-CAT-EVALUATOR-ABLATION-01 §5 — P5 aggregate over fresh-process rounds.
 *
 * Reads every _raw/p5_round{N}.json produced by p5_production.test.ts (one fresh
 * process per round, arm order alternating by (round+rootIndex)%2). Computes the
 * REAL-100ms decision reproducibility HONESTLY:
 *   - executedConsistent : the REAL step trajectory label is identical across all
 *                          rounds for a root×arm (ground-truth decision).
 *   - firstActionConsistent : the first executed action is identical across rounds.
 *   - baselinePlanConsistent / finalPlanConsistent : main-search vs post-sidecar.
 * Depth/nodes/elapsed are RECORDED as ranges, never pinned (a wall-clock deadline
 * legitimately flips completedDepth — Hard deadline nondeterminism record).
 *
 * PRE-REGISTERED extension (no cherry-pick): if ANY combo is executed-inconsistent
 * after 5 rounds, extend to 10. This probe REPORTS needsExtension; the operator
 * then runs rounds 6..10 (fresh processes) and re-aggregates. 150ms is a NOMINAL
 * wall, NOT a physical certification — over-budget turns are recorded, not hidden.
 *
 * NO production source modified. NO gate is relaxed to manufacture consistency.
 */
import { test, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { OUT, HEAD, FROZEN_FIXTURE_SHA, rootIds, canonicalJson, sha256 } from './ablation_lib';

interface P5Row {
  rootId: string; arm: 'E1' | 'H1'; orderIdx: number; stateKey: string; snapshotSha256: string;
  plannerCalls: number;
  budget: { timeBudgetMs: number; refutationEnabled: boolean; totalTurnBudgetMs: number; leafIsArm: boolean; leafMode: string; guardEnabled: boolean; rootAtPlanTimeMatches: boolean };
  mainSearch: { completedDepth: number; attemptedDepth: number; deadlineFired: boolean; budgetFired: boolean; nodes: number | null; elapsedMs: number; rootValue: number; mate: string | null; baselinePlan: string; rootActions: unknown[] };
  sidecar: { refutationEnabled: boolean; refutationTriggered: boolean; overrideUsed: boolean; selectedPlanSource: string; sidecarAbortReason: string | null } | null;
  finalPlan: string; finalPlanDebug: string; hasSolution: boolean;
  executed: { label: string; details: string[]; path: string[]; stepCount: number; matchedPlan: boolean | null; planCompleted: boolean | null; fallbackOccurred: boolean | null; invalidActionOccurred: boolean | null; reachedLegalBoundary: boolean | null };
  fallbackMarkers: string[]; turnWallMs: number; overMainBudget: boolean; overTurnBudget: boolean;
  finalPhase: string; finalCurrentPlayer: string; finalCatMovesLeft: number;
}
interface RoundDoc { round: number; head: string; fixtureSha256: string; contract: { mainSearchBudgetMs: number; totalTurnBudgetMs: number; refutationEnabled: boolean; progressGuardEnabled: boolean }; rows: P5Row[] }

const uniq = (xs: string[]) => Array.from(new Set(xs));
const range = (xs: number[]) => ({ min: Math.min(...xs), max: Math.max(...xs) });

test('P5 aggregate: real-100ms decision reproducibility across fresh-process rounds', () => {
  const files = readdirSync(`${OUT}/_raw`).filter((f) => /^p5_round\d+\.json$/.test(f));
  const rounds: RoundDoc[] = files
    .map((f) => JSON.parse(readFileSync(`${OUT}/_raw/${f}`).toString('utf8')) as RoundDoc)
    .sort((a, b) => a.round - b.round);
  const N = rounds.length;
  expect(N, 'at least the 5 pre-registered rounds must exist').toBeGreaterThanOrEqual(5);

  // every round: frozen contract + 48 rows + per-row budget proof
  for (const r of rounds) {
    expect(r.head).toBe(HEAD);
    expect(r.fixtureSha256).toBe(FROZEN_FIXTURE_SHA);
    expect(r.contract.mainSearchBudgetMs).toBe(100);
    expect(r.contract.totalTurnBudgetMs).toBe(150);
    expect(r.contract.refutationEnabled).toBe(true);
    expect(r.contract.progressGuardEnabled).toBe(false);
    expect(r.rows.length).toBe(48);
    for (const row of r.rows) {
      expect(row.budget.timeBudgetMs).toBe(100);
      expect(row.budget.refutationEnabled).toBe(true);
      expect(row.budget.totalTurnBudgetMs).toBe(150);
      expect(row.budget.leafIsArm).toBe(true);
      expect(row.budget.guardEnabled).toBe(false);
      expect(row.budget.rootAtPlanTimeMatches).toBe(true);
    }
  }

  const combos: unknown[] = [];
  let executedConsistentCount = 0, firstActionConsistentCount = 0, baselineConsistentCount = 0, finalConsistentCount = 0;
  let fallbackCombos = 0, overrideCombos = 0, overTurnBudgetObserved = 0;
  const inconsistentExecuted: string[] = [];

  for (const id of rootIds) {
    for (const arm of ['E1', 'H1'] as const) {
      const rows = rounds.map((r) => r.rows.find((x) => x.rootId === id && x.arm === arm)!);
      expect(rows.every((x) => x !== undefined)).toBe(true);
      const executedLabels = rows.map((x) => x.executed.label);
      const firstActions = executedLabels.map((s) => s.slice(0, 1));
      const baselinePlans = rows.map((x) => x.mainSearch.baselinePlan);
      const finalPlans = rows.map((x) => x.finalPlan);
      const executedConsistent = uniq(executedLabels).length === 1;
      const firstActionConsistent = uniq(firstActions).length === 1;
      const baselineConsistent = uniq(baselinePlans).length === 1;
      const finalConsistent = uniq(finalPlans).length === 1;
      if (executedConsistent) executedConsistentCount++; else inconsistentExecuted.push(`${id}/${arm}`);
      if (firstActionConsistent) firstActionConsistentCount++;
      if (baselineConsistent) baselineConsistentCount++;
      if (finalConsistent) finalConsistentCount++;
      const fallbackCount = rows.filter((x) => x.executed.fallbackOccurred === true).length;
      const overrideCount = rows.filter((x) => x.sidecar?.overrideUsed === true).length;
      const matchedCount = rows.filter((x) => x.executed.matchedPlan === true).length;
      if (fallbackCount > 0) fallbackCombos++;
      if (overrideCount > 0) overrideCombos++;
      overTurnBudgetObserved += rows.filter((x) => x.overTurnBudget).length;
      combos.push({
        rootId: id, arm, roundsUsed: N,
        executedLabels, firstActions, baselinePlans, finalPlans,
        executedConsistent, firstActionConsistent, baselineConsistent, finalConsistent,
        completedDepth: range(rows.map((x) => x.mainSearch.completedDepth)),
        attemptedDepth: range(rows.map((x) => x.mainSearch.attemptedDepth)),
        nodes: range(rows.map((x) => x.mainSearch.nodes ?? 0)),
        mainElapsedMs: range(rows.map((x) => x.mainSearch.elapsedMs)),
        turnWallMs: range(rows.map((x) => x.turnWallMs)),
        deadlineFiredCount: rows.filter((x) => x.mainSearch.deadlineFired).length,
        budgetFiredCount: rows.filter((x) => x.mainSearch.budgetFired).length,
        fallbackCount, overrideCount, matchedPlanCount: matchedCount,
        overTurnBudgetCount: rows.filter((x) => x.overTurnBudget).length,
        plannerCalls: range(rows.map((x) => x.plannerCalls)),
        finalPhases: uniq(rows.map((x) => x.finalPhase)),
      });
    }
  }

  // per-root E1 vs H1 pairing at the real 100ms path (modal executed trajectory)
  const modal = (xs: string[]) => {
    const c = new Map<string, number>();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    return Array.from(c.entries()).sort((a, b) => b[1] - a[1])[0][0];
  };
  const perRoot = rootIds.map((id) => {
    const e1 = combos.find((c: any) => c.rootId === id && c.arm === 'E1') as any;
    const h1 = combos.find((c: any) => c.rootId === id && c.arm === 'H1') as any;
    const e1Exec = modal(e1.executedLabels), h1Exec = modal(h1.executedLabels);
    return {
      rootId: id,
      e1ModalExecuted: e1Exec, h1ModalExecuted: h1Exec,
      e1FirstAction: e1Exec.slice(0, 1), h1FirstAction: h1Exec.slice(0, 1),
      actionChangedAt100ms: e1Exec.slice(0, 1) !== h1Exec.slice(0, 1),
      trajectoryChangedAt100ms: e1Exec !== h1Exec,
      e1ExecutedConsistent: e1.executedConsistent, h1ExecutedConsistent: h1.executedConsistent,
    };
  });

  const needsExtension = N < 10 && inconsistentExecuted.length > 0;
  const doc = {
    artifactId: 'PRODUCTION_100MS_RESULTS', round: OUT, phase: 5,
    generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p5_aggregate.test.ts`,
    head: HEAD, fixtureSha256: FROZEN_FIXTURE_SHA, productionSourceChanged: false,
    contract: { mainSearchBudgetMs: 100, totalTurnBudgetMs: 150, refutationEnabled: true, progressGuardEnabled: false, sidecarDisabled: false },
    protocol: 'computeCatAiTrajectory (real entry) → planHardCatTurn (spy WRAPS, never replaces) → resolveHardLeaf() per arm; 5 paired fresh-process rounds, arm order (round+rootIndex)%2; extend to 10 if executed-inconsistent',
    nominalWallNote: '150ms is a NOMINAL total-turn wall, NOT a physical certification; depth/nodes/elapsed recorded as ranges, never pinned',
    roundsUsed: N, roundNumbers: rounds.map((r) => r.round),
    summary: {
      combos: combos.length,
      executedConsistent: executedConsistentCount, executedInconsistent: inconsistentExecuted.length,
      firstActionConsistent: firstActionConsistentCount,
      baselinePlanConsistent: baselineConsistentCount, finalPlanConsistent: finalConsistentCount,
      fallbackCombos, overrideCombos, overTurnBudgetObserved,
      needsExtension, extendTo: needsExtension ? 10 : null,
      inconsistentExecutedCombos: inconsistentExecuted,
    },
    perRoot, combos,
  };
  mkdirSync(`${OUT}/_raw`, { recursive: true });
  writeFileSync(`${OUT}/_raw/p5_aggregate_N${N}.json`, JSON.stringify(doc, null, 2));
  writeFileSync(`${OUT}/PRODUCTION_100MS_RESULTS.json`, JSON.stringify(doc, null, 2));

  console.log(`[P5] roundsUsed=${N} combos=${combos.length}`);
  console.log(`[P5] executedConsistent=${executedConsistentCount}/${combos.length} firstActionConsistent=${firstActionConsistentCount} baselineConsistent=${baselineConsistentCount} finalConsistent=${finalConsistentCount}`);
  console.log(`[P5] fallbackCombos=${fallbackCombos} overrideCombos=${overrideCombos} overTurnBudgetObserved=${overTurnBudgetObserved}`);
  console.log(`[P5] needsExtension=${needsExtension}${needsExtension ? ' → RUN rounds 6..10 then re-aggregate' : ''} inconsistent=[${inconsistentExecuted.join(' ')}]`);
  console.log(`[P5] actionChangedAt100ms roots=[${perRoot.filter((r) => r.actionChangedAt100ms).map((r) => r.rootId).join(' ')}]`);

  // gates: structural integrity only. Consistency is REPORTED, never asserted to
  // 100% (the deadline legitimately flips decisions); extension is pre-registered.
  expect(combos.length).toBe(48);
  expect(doc.summary.executedConsistent + doc.summary.executedInconsistent).toBe(48);
  if (N >= 10) expect(needsExtension).toBe(false);   // no extension beyond the pre-registered 10
}, 600_000);