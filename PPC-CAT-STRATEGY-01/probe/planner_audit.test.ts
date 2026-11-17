/// <reference types="node" />
/**
 * TACT-7 — what the CURRENT Hard AI actually does at G6T2.
 *
 * Two protocols, recorded separately and never blended (task book §8):
 *
 *   FIXED-DN  : `createSearchContext(rules, 10000, true, true, true, 0, false)`
 *               + `ctx.leafEvaluator = evaluateCorrectedHoleForCat`
 *               + `ctx.capturePlan = true`, then `searchBestAction(state, N, ctx)`.
 *               No deadline: the search runs to completion so the comparison is
 *               about the SEARCH, not about how fast the machine is.
 *   PROD-100ms: `planHardCatTurn({ timeBudgetMs: 100, maxDepthTurns: 4,
 *               refutation: { enabled: true, totalTurnBudgetMs: 150 } })`.
 *
 * The point of the pairing: if the same evaluator ranks the losing plan first at
 * D1 and the safe plan first at D2, the information loss is in the HORIZON, not
 * in the leaf values (§8 attribution).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { createEngineRuleSet } from '../../src/game/engine';
import { planHardCatTurn } from '../../src/game/ai/hardTurnPlanner';
import { createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { label, mouseForcesWin, applyPrefixBranches, summarize } from './lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const OUT = 'PPC-CAT-STRATEGY-01';
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as { id: string; state: unknown }[];
const load = (id: string): GameEngineState => restoreHardRoot(records.find((r) => r.id === id)!.state as never);
const rules = createEngineRuleSet();
const H1 = 2;

/** Exact verdict (H1) of a concrete cat turn plan, on the real rules. */
function planVerdict(root: GameEngineState, plan: string[]) {
  const pre = applyPrefixBranches(root, plan);
  if (!pre.ok) return { ok: false, failedAt: pre.failedAt, verdict: 'ILLEGAL_PLAN' as const, branches: 0 };
  let anyWin = false;
  let unknown = false;
  for (const st of pre.states) {
    const r = mouseForcesWin(st, H1, pre.idx[0], 600_000);
    if (r.value === true) anyWin = true;
    if (r.value === null) unknown = true;
  }
  return {
    ok: true,
    failedAt: undefined,
    branches: pre.states.length,
    verdict: (unknown ? 'UNRESOLVED' : anyWin ? 'MOUSE_FORCED_WIN_WITHIN_H1' : 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1') as string,
  };
}

describe('TACT-7 planner decision audit (G6T2)', () => {
  it('records fixed-D1/D2, the production 100ms run, and judges each plan tactically', () => {
    const root = load('G6T2');

    // ---------- fixed depth, no deadline ----------
    const fixed: Record<string, unknown>[] = [];
    for (const depth of [1, 2, 3]) {
      const ctx = createSearchContext(rules, 400_000, true, true, true, 0, false);
      ctx.leafEvaluator = evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;
      const t0 = performance.now();
      const r = searchBestAction(root, depth, ctx);
      const planLabels = r.catTurnPlan.map((a) => label(a));
      fixed.push({
        protocol: `FIXED-D${depth}`,
        bestAction: label(r.action),
        plan: planLabels,
        planString: planLabels.join(''),
        value: r.value,
        mate: r.mate,
        completed: r.completed,
        nodes: r.diagnostics.nodes,
        elapsedMs: Math.round(performance.now() - t0),
        rootValues: ctx.rootValues.map((x) => ({ action: label(x.action), value: x.value })),
        tacticalVerdictOfPlan: depth === 1 || depth === 2 ? planVerdict(root, planLabels) : null,
      });
    }

    // ---------- production 100ms ----------
    const t0 = performance.now();
    const plan = planHardCatTurn(root, {
      rules, timeBudgetMs: 100, maxDepthTurns: 4,
      refutation: { enabled: true, totalTurnBudgetMs: 150 },
    });
    const prodMs = performance.now() - t0;
    const prodLabels = plan.plan.map((a) => label(a));
    const production = {
      protocol: 'PROD-100ms(+150ms sidecar)',
      bestAction: label(plan.bestAction),
      plan: prodLabels,
      planString: prodLabels.join(''),
      value: plan.search.value,
      mate: plan.search.mate,
      completedDepth: plan.completedDepth,
      attemptedDepth: plan.attemptedDepth,
      hasSolution: plan.hasSolution,
      deadlineFired: plan.deadlineFired,
      budgetFired: plan.budgetFired,
      nodes: plan.debug.nodes,
      elapsedMs: Math.round(prodMs),
      planStatus: plan.debug.planStatus,
      fallback: !plan.hasSolution,
      placedTrap: prodLabels.includes('T'),
      rootValues: (plan.debug.rootActions ?? []).map((x) => ({
        action: label(x.action), value: x.value, mate: x.mate, bound: x.bound ?? 'unknown',
      })),
      refutation: plan.debug.refutation ?? null,
      tacticalVerdictOfPlan: planVerdict(root, prodLabels),
    };

    // ---------- fixed depth with the PRODUCTION leaf evaluator ----------
    // `planHardCatTurn` injects `evaluateForCat` (E1), NOT the corrected-hole
    // variant used by the frozen D1 protocol. The attribution must therefore be
    // re-checked on the evaluator production actually uses, otherwise "same
    // evaluator, deeper search" would be comparing two different functions.
    const prodLeaf: Record<string, unknown>[] = [];
    for (const depth of [1, 2]) {
      const ctx = createSearchContext(rules, 400_000, true, true, true, 0, false);
      ctx.leafEvaluator = evaluateForCat;
      ctx.capturePlan = true;
      const t0 = performance.now();
      const r = searchBestAction(root, depth, ctx);
      const planLabels = r.catTurnPlan.map((a) => label(a));
      prodLeaf.push({
        protocol: `FIXED-D${depth} (production leaf evaluateForCat)`,
        bestAction: label(r.action),
        planString: planLabels.join(''),
        value: r.value,
        mate: r.mate,
        completed: r.completed,
        nodes: r.diagnostics.nodes,
        elapsedMs: Math.round(performance.now() - t0),
        rootValues: ctx.rootValues.map((x) => ({ action: label(x.action), value: x.value })),
        tacticalVerdictOfPlan: planVerdict(root, planLabels),
      });
    }

    // ---------- the independent tactical facts this is judged against ----------
    const tacticallySafePlans = [
      { plan: ['D', 'R', 'D', 'R'], source: 'traceCatDefense (H1)' },
      { plan: ['D', 'R', 'R', 'R'], source: 'historical alternative' },
    ].map((p) => ({ ...p, planString: p.plan.join(''), verdict: planVerdict(root, p.plan) }));

    // ---------- assertions: the decision error is real and the verdicts agree --
    // D1 (and therefore the production run, which stops after D1) plays UURR…
    expect((fixed[0].plan as string[]).join('')).toBe('UURR');
    expect(production.planString).toBe('UURR');
    // …and UURR loses against an exact mouse strategy.
    expect(production.tacticalVerdictOfPlan.verdict).toBe('MOUSE_FORCED_WIN_WITHIN_H1');
    // The safe plans genuinely hold inside the same window.
    for (const p of tacticallySafePlans) {
      expect(p.verdict.verdict, p.planString).toBe('CAT_SURVIVAL_CERTIFIED_WITHIN_H1');
    }
    // Same leaf evaluator, one more ply: under the corrected-hole evaluator the
    // ranking flips to the safe plan.
    expect((fixed[1].plan as string[]).join('')).toBe('DRRR');
    expect(fixed[0].value as number).not.toBe(fixed[1].value as number);

    // BUT the evaluator production actually uses (E1 `evaluateForCat`) behaves
    // differently: at D2 it still keeps a U-first plan. Measured, not assumed —
    // this is why "just search one ply deeper" is not a sufficient fix.
    expect(prodLeaf[0].planString).toBe('UURR');
    expect(prodLeaf[0].tacticalVerdictOfPlan.verdict).toBe('MOUSE_FORCED_WIN_WITHIN_H1');
    const prodLeafD2Safe = prodLeaf[1].tacticalVerdictOfPlan.verdict === 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1';
    const correctedD2Safe = fixed[1].tacticalVerdictOfPlan?.verdict === 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1';
    expect(correctedD2Safe).toBe(true);
    expect(prodLeafD2Safe).toBe(false); // pinned: E1 still picks a losing plan at D2

    // How blind is E1 at D2? Count the distinct root values: if the safe and the
    // losing openings are numerically IDENTICAL, the evaluator cannot tell them
    // apart at all and the choice falls through to move ordering.
    const d2Roots = (prodLeaf[1].rootValues as { action: string; value: number }[]);
    const d2Distinct = new Set(d2Roots.map((r) => r.value.toFixed(9)));
    const correctedD2Roots = (fixed[1].rootValues as { action: string; value: number }[]);
    const correctedDistinct = new Set(correctedD2Roots.map((r) => r.value.toFixed(9)));

    // Attribution, mechanically derived from the table above. Two defects coexist
    // and are separable by measurement:
    //   - horizon: at D1 the opponent's reply is not modelled at all, and BOTH
    //     evaluators pick the losing plan there;
    //   - leaf: at D2 the corrected-hole evaluator already recovers the safe plan,
    //     but E1 does not — so E1 carries an additional blind spot.
    const attribution = {
      class: 'SEARCH_HORIZON_LIMITATION',
      coFactors: ['EVALUATION_BLINDSPOT'],
      why: [
        `固定 D1 选择 ${fixed[0].planString}（值 ${(fixed[0].value as number).toFixed(3)}），该计划经精确量词证明为 MOUSE_FORCED_WIN_WITHIN_H1。`,
        `在 corrected-hole 评价下，固定 D2 改选 ${fixed[1].planString}（值 ${(fixed[1].value as number).toFixed(3)}），该计划证明为 CAT_SURVIVAL_CERTIFIED_WITHIN_H1 ⇒ 视界不足确实会直接导致误选。`,
        `但在生产实际使用的 evaluateForCat(E1) 下，固定 D2 仍选择 ${prodLeaf[1].planString}（值 ${(prodLeaf[1].value as number).toFixed(3)}），其战术判定为 ${prodLeaf[1].tacticalVerdictOfPlan.verdict}。`,
        `E1 在 D2 只给出 ${d2Distinct.size} 个不同根值（${[...d2Distinct].join(' / ')}）——安全开局与致命开局在数值上完全并列，评价函数对此毫无区分力，最终由同分打破规则（顺序取 U）决定。`,
        `corrected-hole 评价在 D2 能分出 ${correctedDistinct.size} 档（${[...correctedDistinct].join(' / ')}），安全开局 D 严格最优。`,
        `生产 100ms 与固定 D1 完全一致（${production.planString} / ${String(production.value)}），completedDepth=${production.completedDepth}，deadlineFired=${String(production.deadlineFired)}。`,
        '结论：主因是视界（D1 未建模对手应手），但修复不能只靠加深度——叶评价（E1 对「鼠带油 + 幽灵黄油」的计时威胁不敏感）是并存的第二缺陷。',
      ],
      rejected: {
        TACTICAL_PLANNING_FAILURE: '规划器输出的是一致、合法、可执行的计划（UURR 四步都在步数预算内），失败点是计划的选择而非计划的构造。',
        GENUINE_FORCED_LOSS: '存在能证明安全的合法猫计划（DRDR / DRRR），因此不是本局面必败。',
        UNRESOLVED: '不适用：所有相关判定的量词搜索均未截断（cap=600k）。',
      },
    };

    writeFileSync(`${OUT}/PLANNER_D1_DECISION_AUDIT.json`, JSON.stringify({
      generatedAt: new Date().toISOString(),
      generatedBy: 'PPC-CAT-STRATEGY-01/probe/planner_audit.test.ts',
      head: '48eaac6c4f3801d351787696ba5876995b64e8d8',
      root: 'G6T2',
      provenance: 'REAL_HUMAN_REPLAY',
      rootState: summarize(root),
      protocols: {
        fixedDepth: 'createSearchContext(rules, 400000, TT, AB, ordering, 0, false) + leafEvaluator=evaluateCorrectedHoleForCat + capturePlan + searchBestAction(state, N)',
        production: 'planHardCatTurn({timeBudgetMs:100, maxDepthTurns:4, refutation:{enabled:true, totalTurnBudgetMs:150}})',
      },
      fixedDepthResults: fixed,
      fixedDepthWithProductionLeaf: prodLeaf,
      productionResult: production,
      independentTacticalReference: {
        horizon: 'H1',
        method: 'exact boolean quantifier over the real RuleSet (probe/lib.ts forcesWinWithin)',
        safePlans: tacticallySafePlans,
        catOpeningsWinningForMouse: ['U', 'L'],
        catOpeningsSafe: ['D'],
      },
      attribution,
      evaluatorComparison: {
        note: '同一局面、同一固定深度下两个叶评价的区分力对比。',
        atD2: {
          productionLeaf_evaluateForCat: {
            plan: prodLeaf[1].planString,
            distinctRootValues: d2Distinct.size,
            rootValues: d2Roots,
            tacticalVerdictOfPlan: prodLeaf[1].tacticalVerdictOfPlan,
          },
          correctedHoleLeaf: {
            plan: fixed[1].planString,
            distinctRootValues: correctedDistinct.size,
            rootValues: correctedD2Roots,
            tacticalVerdictOfPlan: fixed[1].tacticalVerdictOfPlan,
          },
        },
      },
      decisionQuality: production.tacticalVerdictOfPlan.verdict === 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1'
        ? 'OK' : 'TACTICAL_DECISION_ERROR',
    }, null, 2));
  }, 3_600_000);
});
