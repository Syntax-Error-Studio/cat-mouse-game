/// <reference types="node" />
/**
 * Phase 3 — 24-root fixed-depth D1 ablation: E1 (evaluateForCat) vs H1
 * (evaluateCorrectedHoleForCat). RESEARCH ONLY; no production source is modified.
 *
 * Protocol reuse (never reinvented): the FAITHFUL production path validated in
 * PPC-CAT-STRATEGY-SEAL-01/probe/attribution.test.ts —
 *   createSearchContext(rules, 400000, TT=true, AB=true, ordering=true, 0, false)
 *   + leafEvaluator(E1|H1) + capturePlan, searchBestAction(root, depth, ctx).
 * No wall-clock deadline (fixed depth + node cap only). Fresh SearchContext per
 * call => fresh TT + fresh evalCache (verified in createSearchContext L825/L833),
 * so NO cross-arm TT / evalCache sharing. Eval counters reset per search.
 *
 * "Values must be exact (no bound-as-exact)": alongside every FAITHFUL run we
 * also run an EXACT full-window protocol (TT/AB/ordering OFF, per-search
 * evalCache ON, 8M full-tree cap) which yields the EXACT full-window minimax
 * value + bound 'exact' for every root action, in REAL legal order. We then verify:
 *   - both runs completed (no incomplete-as-valid),
 *   - every exact root bound === 'exact',
 *   - the engine's exact choice is the FIRST legal-order argmax (ties preserve
 *     real order),
 *   - the FAITHFUL selected action is the exact selected action (AB soundness +
 *     ordering-independence, guaranteed by expectiminimax L1346-1347),
 *   - |faithful.value - exact.maxValue| < EPS.
 * The faithful root values are recorded WITH their honest per-action bound; the
 * exact values are recorded as the authoritative comparison basis.
 *
 * Fresh-process repeats: REP comes from env ABLATION_REP (1|2|3). Each invocation
 * is a separate vitest process (strictly serial, maxWorkers=1). The aggregator
 * (p3_aggregate.test.ts) checks cross-rep identity on every decision field.
 *
 * G6T2 special: D1 AND D2 for both arms (D2 is explanation-only, carried from the
 * previous round's U=D=L tie analysis; it never grounds a real-time claim).
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import {
  ROUND, OUT, HEAD, FIXTURE, FROZEN_FIXTURE_SHA, FAITHFUL_CAP, EPS,
  rootIds, loadRoot, snapshotSha, rules, label, stateKey, sha256, leafFor, faithfulRun,
  resetEvaluationCalls, getEvaluationCalls, getMouseBfsCalls, getCatBfsCalls, getCarryMouseBfsCalls,
  type Arm, type FaithfulResult,
} from './ablation_lib';
import type { GameEngineState } from '../../src/game/engine';

const EXACT_CAP = 8_000_000; // attribution-protocol full-tree cap (probe-only; NEVER the 600k quantifier cap)
const REP = process.env.ABLATION_REP ?? '1';
const REP_PATH = `${OUT}/_raw/d1_rep${REP}.json`;

interface ExactResult {
  rootId: string; stateKey: string; evaluator: Arm; depth: number;
  rootActionValues: { action: string; value: number; mate: string | null; bound: string }[];
  engineSelected: string;        // label(r.action) from the EXACT search
  firstLegalArgmax: string;      // first action attaining the exact max, in real legal order
  argmaxSet: string[];           // all actions tied at the exact max (real legal order)
  maxValue: number;
  catTurnPlan: string[]; planString: string;
  value: number; mate: string | null; completed: boolean;
  totalNodes: number; leafNodes: number; chanceNodes: number;
  evaluationCalls: number; mouseBfsCalls: number; catBfsCalls: number; carryMouseBfsCalls: number;
  ttHits: number; alphaBetaCutoffs: number; elapsedMs: number;
  allBoundsExact: boolean;
}

/** EXACT full-window minimax (TT/AB/ordering OFF, evalCache OFF) — authoritative values. */
function exactRun(rootId: string, root: GameEngineState, depth: number, arm: Arm): ExactResult {
  const ctx = createSearchContext(rules, EXACT_CAP, false, false, false, 0, false);
  // evalCache stays ON (fresh per-search Map from createSearchContext). It
  // memoizes the PURE evaluator (P2 proved determinism), so it cannot change any
  // exact value — it only avoids re-evaluating the ~25k unique horizon keys
  // across the ~1.28M-node full tree. Exactness comes from TT/AB/ordering OFF
  // (full window, no fail-soft bound), NOT from evalCache OFF. The previous
  // round's attribution protocol disabled evalCache only so its RECORDING
  // WRAPPER could observe every leaf; we need values, not leaf visits.
  ctx.leafEvaluator = leafFor(arm);
  ctx.capturePlan = true;
  resetEvaluationCalls();
  const t0 = performance.now();
  const r = searchBestAction(root, depth, ctx);
  const elapsedMs = Math.round(performance.now() - t0);
  // ordering OFF => ctx.rootValues is in REAL legal order.
  const rootActionValues = ctx.rootValues.map((x) => ({ action: label(x.action), value: x.value, mate: x.mate, bound: x.bound }));
  const planLabels = r.catTurnPlan.map((a) => label(a));
  const maxValue = rootActionValues.length > 0 ? Math.max(...rootActionValues.map((x) => x.value)) : r.value;
  const argmaxSet = rootActionValues.filter((x) => Math.abs(x.value - maxValue) < EPS).map((x) => x.action);
  const engineSelected = label(r.action);
  return {
    rootId, stateKey: stateKey(root), evaluator: arm, depth,
    rootActionValues, engineSelected,
    firstLegalArgmax: argmaxSet.length > 0 ? argmaxSet[0] : engineSelected,
    argmaxSet, maxValue,
    catTurnPlan: planLabels, planString: planLabels.join(''),
    value: r.value, mate: r.mate, completed: r.completed,
    totalNodes: r.diagnostics.nodes, leafNodes: r.diagnostics.leafNodes, chanceNodes: r.diagnostics.chanceNodes,
    evaluationCalls: getEvaluationCalls(), mouseBfsCalls: getMouseBfsCalls(),
    catBfsCalls: getCatBfsCalls(), carryMouseBfsCalls: getCarryMouseBfsCalls(),
    ttHits: r.diagnostics.ttHits, alphaBetaCutoffs: r.diagnostics.alphaBetaCutoffs, elapsedMs,
    allBoundsExact: rootActionValues.every((x) => x.bound === 'exact'),
  };
}

interface Row {
  rootId: string; stateKey: string; snapshotSha256: string; evaluator: Arm; depth: number;
  isG6T2D2Explanation: boolean;
  faithful: FaithfulResult; exact: ExactResult;
  crossCheck: {
    faithfulCompleted: boolean; exactCompleted: boolean; allExactBoundsExact: boolean;
    exactTiePreservesRealOrder: boolean; faithfulSelectedInExactArgmaxSet: boolean;
    faithfulSelectedEqualsExactSelected: boolean; faithfulValueMatchesExactMax: boolean;
    faithfulAllRootBoundsExact: boolean;
  };
}

describe('Phase 3 D1 ablation (E1 vs H1)', () => {
  it(`rep ${REP}: 24 roots x {E1,H1} x D1 (+ G6T2 D2), faithful + exact cross-check`, () => {
    expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);
    const t0 = performance.now();
    const rows: Row[] = [];
    for (const id of rootIds) {
      const root = loadRoot(id);
      const depths = id === 'G6T2' ? [1, 2] : [1];
      for (const depth of depths) {
        for (const arm of ['E1', 'H1'] as Arm[]) {
          const f = faithfulRun(id, root, depth, arm);
          const e = exactRun(id, root, depth, arm);
          rows.push({
            rootId: id, stateKey: f.stateKey, snapshotSha256: snapshotSha(id), evaluator: arm, depth,
            isG6T2D2Explanation: id === 'G6T2' && depth === 2,
            faithful: f, exact: e,
            crossCheck: {
              faithfulCompleted: f.completed, exactCompleted: e.completed, allExactBoundsExact: e.allBoundsExact,
              exactTiePreservesRealOrder: e.engineSelected === e.firstLegalArgmax,
              faithfulSelectedInExactArgmaxSet: e.argmaxSet.includes(f.selectedAction),
              faithfulSelectedEqualsExactSelected: f.selectedAction === e.engineSelected,
              faithfulValueMatchesExactMax: Math.abs(f.value - e.maxValue) < EPS,
              faithfulAllRootBoundsExact: f.allRootBoundsExact,
            },
          });
        }
      }
    }

    // ---- hard gates: completeness + exactness + tie-order + AB soundness ----
    for (const r of rows) {
      const tag = `${r.rootId}/${r.evaluator}/D${r.depth}`;
      expect(r.crossCheck.faithfulCompleted, `${tag} faithful incomplete`).toBe(true);
      expect(r.crossCheck.exactCompleted, `${tag} exact incomplete (truncated at ${r.exact.totalNodes} nodes)`).toBe(true);
      expect(r.crossCheck.allExactBoundsExact, `${tag} exact root bound not 'exact'`).toBe(true);
      expect(r.crossCheck.exactTiePreservesRealOrder, `${tag} exact tie did not preserve real legal order`).toBe(true);
      expect(r.crossCheck.faithfulSelectedInExactArgmaxSet, `${tag} faithful choice ${r.faithful.selectedAction} not an exact optimum ${JSON.stringify(r.exact.argmaxSet)}`).toBe(true);
      expect(r.crossCheck.faithfulSelectedEqualsExactSelected, `${tag} faithful ${r.faithful.selectedAction} != exact ${r.exact.engineSelected}`).toBe(true);
      expect(r.crossCheck.faithfulValueMatchesExactMax, `${tag} faithful value ${r.faithful.value} != exact max ${r.exact.maxValue}`).toBe(true);
    }

    const doc = {
      artifactId: 'D1_ABLATION_REP', round: ROUND, phase: 3, rep: Number(REP),
      generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p3_d1_ablation.test.ts`,
      head: HEAD, fixtureSha256: FROZEN_FIXTURE_SHA, productionSourceChanged: false,
      protocol: {
        faithful: `createSearchContext(rules,${FAITHFUL_CAP},TT=true,AB=true,ordering=true,0,false)+leafEvaluator+capturePlan; searchBestAction(root,depth,ctx); no wall clock`,
        exact: `createSearchContext(rules,${EXACT_CAP},TT=false,AB=false,ordering=false,0,false)+leafEvaluator+capturePlan; per-search evalCache ON (pure-eval memoization, value-preserving); exact full-window minimax, real legal order`,
        isolation: 'fresh SearchContext per call => fresh TT + fresh evalCache; eval counters reset per search; no cross-arm sharing',
        repeats: 'fresh vitest process per rep (env ABLATION_REP), strictly serial maxWorkers=1',
      },
      rowCount: rows.length,
      d1RowCount: rows.filter((r) => r.depth === 1).length,
      g6t2D2ExplanationRows: rows.filter((r) => r.isG6T2D2Explanation).length,
      allCrossChecksPass: rows.every((r) => Object.values(r.crossCheck).every((v) => v === true)),
      rows,
      elapsedMs: Math.round(performance.now() - t0),
    };
    writeFileSync(REP_PATH, JSON.stringify(doc, null, 2));

    // ---- console summary: per-root D1 E1 vs H1 selected action ----
    const d1 = rows.filter((r) => r.depth === 1);
    let changes = 0;
    for (const id of rootIds) {
      const e1 = d1.find((r) => r.rootId === id && r.evaluator === 'E1')!;
      const h1 = d1.find((r) => r.rootId === id && r.evaluator === 'H1')!;
      const changed = e1.faithful.selectedAction !== h1.faithful.selectedAction;
      if (changed) changes++;
      console.log(`D1 ${id}: E1=${e1.faithful.selectedAction} (v=${e1.exact.maxValue.toFixed(4)}) H1=${h1.faithful.selectedAction} (v=${h1.exact.maxValue.toFixed(4)}) ${changed ? 'CHANGED' : 'same'} planE1=${e1.faithful.planString} planH1=${h1.faithful.planString}`);
    }
    console.log(`REP=${REP} rows=${rows.length} d1=${d1.length} D1_action_changes=${changes} allCrossChecksPass=${doc.allCrossChecksPass} elapsedMs=${doc.elapsedMs}`);
    expect(doc.allCrossChecksPass, 'every faithful/exact cross-check must pass').toBe(true);
    expect(rows.length).toBe(rootIds.length * 2 + 2); // 24 roots x 2 arms D1 + G6T2 x 2 arms D2
  }, 3_600_000);
});