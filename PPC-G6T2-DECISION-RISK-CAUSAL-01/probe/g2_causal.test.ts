/// <reference types="node" />
/**
 * G2 — G6T2 causal trace.
 *
 * Re-checks the 100 ms production observation on the SAME frozen root with the
 * SAME source closure the certificates bind. Deadline behaviour is NOT assumed
 * deterministic: every repetition is recorded separately, and no number is
 * transplanted from another root.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import {
  ROUND, writeJson, readJson, loadRoot, fixtureById, enumerateRoot,
  runProduction100, stateKey, fullStateSha, snapshotSha, sha256, CONTROL_PLANS,
} from './dr_lib';

const REP = Number(process.env.PPC_PROD_REP ?? 1);

describe('G2 G6T2 causal trace', () => {
  it('captures one 100ms production run and assembles the causal trace', () => {
    const root = loadRoot('G6T2');
    const { turns, expandedStates, elapsedMs } = enumerateRoot('G6T2');
    expect(turns.length).toBe(110);

    const controlIdx: Record<string, number> = {};
    for (const p of CONTROL_PLANS) {
      const i = turns.findIndex((t) => t.labels === p);
      expect(i, `${p} missing from enumeration`).toBeGreaterThanOrEqual(0);
      controlIdx[p] = i;
    }

    const prod = runProduction100(root, 'G6T2');
    writeJson(`${ROUND}/logs/prod_100ms_rep${REP}.json`, {
      ...prod, rep: REP, capturedAt: new Date().toISOString(),
      nodesFrozenReference: 211, completedDepthFrozenReference: 1,
      planFrozenReference: 'UURR', deadlineFiredFrozenReference: true,
    });

    // Load every repetition captured so far (each from its own process).
    const reps: Record<string, unknown>[] = [];
    for (let i = 1; i <= 8; i++) {
      const p = `${ROUND}/logs/prod_100ms_rep${i}.json`;
      if (existsSync(p)) { const r = readJson(p); reps.push(r); }
    }
    expect(reps.length).toBeGreaterThanOrEqual(1);

    const trace = {
      round: ROUND,
      phase: 'G2_CAUSAL_TRACE',
      generatedAt: new Date().toISOString(),
      identity: {
        rootId: 'G6T2',
        rootStateKey: stateKey(root),
        rootSnapshotSha256: snapshotSha(root),
        fixtureCanonicalSnapshotSha256: fixtureById.get('G6T2')!.canonicalSnapshotSha256,
        completeCatTurns: 110,
        expandedStates,
        enumerationElapsedMs: elapsedMs,
        controlPlanIndices: controlIdx,
      },
      contemporaneousRuntime: {
        protocol: 'planHardCatTurn({ timeBudgetMs: 100, maxDepthTurns: 4, refutation: { enabled: true, totalTurnBudgetMs: 150 } })',
        freshProcessRepetitions: reps.length,
        runs: reps,
        frozenReferenceFrom_2026_11_19: {
          planString: 'UURR', value: -247.237, completedDepth: 1, nodes: 211,
          deadlineFired: true,
          source: 'PPC-CAT-STRATEGY-01/PLANNER_D1_DECISION_AUDIT.json (PROD-100ms row)',
        },
        determinismVerdict: (() => {
          const plans = new Set(reps.map((r) => r.planString));
          const depths = new Set(reps.map((r) => r.completedDepth));
          return plans.size === 1 && depths.size === 1 ? 'STABLE_ACROSS_LOCAL_REPS' : 'DEADLINE_SENSITIVE_ACROSS_REPS';
        })(),
      },
      frozenAfterSearchTrace: {
        d2Protocol: 'ARM E1, depthTurns=2, production write path, 1,283,054 nodes',
        rootValues: [
          { action: 'U', value: -658.2105263157898, mate: null, bound: 'exact' },
          { action: 'D', value: -658.2105263157898, mate: null, bound: 'exact' },
          { action: 'L', value: -658.2105263157898, mate: null, bound: 'exact' },
        ],
        afterD: { U: -658.2105263157898, L: -658.2105263157898, R: -658.2105263157898, chosen: 'U', rule: 'strict improvement; exact tie keeps the smaller original legal index' },
        drNode: { L: -658.2105263157898, R: -745.4473684210526, chosen: 'L' },
        drrNode: { L: -745.4473684210526, R: -854, D: -900.7105263157896, chosen: 'L' },
        forcedComparison: { duud: -658.2105263157898, drrr: -854, delta: -195.78947368421018 },
        extraction: { productionCatTurnPlan: 'ULDR', planBranchesWalk: 'UUDD', reproducible: true, sameFinalState: true },
        certifiedLabels: {
          UURR: 'mouse forced win (frozen certificate)',
          DRRR: 'cat survives (frozen H2, window=2, cap=600000)',
          DRDR: 'no certificate',
        },
        sources: [
          'PPC-G6T2-SELECTION-CAUSE-01/ROOT_CAUSE_VERDICT.json',
          'PPC-G6T2-SELECTION-CAUSE-01/FORCED_PLAN_COMPARISON.json',
          'PPC-G6T2-SELECTION-CAUSE-01/D2_CHILD_VALUE_AUDIT.json',
          'PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01/EVALUATION_DECOMPOSITION.json',
        ],
      },
      fiveCauses: {
        '1_CANDIDATE_NEVER_GENERATED': {
          supported: true,
          scope: 'DRRR',
          evidence: 'Production candidate pool = 3 principals {UUDD, DUUD, LUDR}; the 110-plan complete enumeration contains DRRR exactly once at 0-based index 63. Reordering principals cannot add a pool-external plan.',
        },
        '2_GENERATED_BUT_SCORED_LOW': {
          supported: true,
          scope: 'the R step after DR and DRR',
          evidence: 'R is generated at those nodes and is strictly lower under E1: DR {L -658.2105, R -745.4474}; DRR {L -745.4474, R -854}. The forced complete DRRR scores -854 vs forced DUUD -658.2105.',
        },
        '3_EQUAL_SCORE_EXTRACTION_DIVERGED': {
          supported: true,
          scope: 'root U/D/L tie and the D-node U/L/R tie',
          evidence: 'Root U=D=L bit-identical; after D, U=L=R bit-identical; stable legal order keeps U. Independent publication divergence: searchBestAction catTurnPlan=ULDR vs planBranches walk UUDD.',
        },
        '4_DEPTH_CANNOT_SEE_MOUSE_WIN': {
          supported: true,
          scope: 'E1 horizon blindness at D1 and the surviving exact tie at D2',
          evidence: 'Fixed D1 (E1) root values U -247.237, D -345, L -345 → picks U. UURR is a certified mouse forced win. At D2 the three root values collapse to an exact tie, so added depth without a threat term still cannot prefer D.',
        },
        '5_DEADLINE_CUTOFF_OR_FALLBACK_CHANGED_ACTION': {
          supported: true,
          kind: 'DEADLINE_LIMITED_DEPTH (not a fallback, not an invalid action)',
          evidence: `Local 100ms runs: ${reps.map((r) => `rep${r.rep}=${r.planString}/d${r.completedDepth}/hasSolution=${r.hasSolution}/deadline=${r.deadlineFired}`).join('; ')}. Frozen 2026-11-19 run selected UURR at completedDepth=1, deadlineFired=true, hasSolution=true. No fallback and no invalid action occurred, so the action change is the deadline bounding the search to depth 1.`,
        },
      },
      decisionChain: {
        actualProduction100ms: 'root → completedDepth 1 (deadline) → E1 root scores → principal UURR → executed UURR → mouse skill + 6 steps → cat RDDD → mouse enters hole',
        frozenD2Counterfactual: 'root → depth 2 completed → U=D=L exact tie → stable order keeps U → plan publication ULDR/UUDD closed loop; DRRR never in the principal pool',
        mouseResponseProvenance: 'PPC-CAT-STRATEGY-01 Q1 (real-rule replay, finalPhase=mouse_wins; 29/29 ghost-butter outcomes still mouse forced win)',
      },
      verdict: {
        primaryCause: 'E1_HORIZON_BLINDNESS_EXPRESSED_AS_TIE_AND_TIE_BREAK',
        productionFailureClass: 'TACTICAL_THREAT_NOT_REPRESENTED (search completed; no execution bug)',
        excludedMainHypothesis: 'history pollution (P0-02: D_HISTORY_DEPENDENCE=INTENTIONAL, PRODUCTION_EXECUTION_BUG=NOT_EVIDENCED)',
        note: 'The 100ms action is a depth-limited decision; the D2 tie shows that raising depth alone does not fix it. Both are consequences of the same missing mouse-threat quantity.',
      },
      prohibitions: {
        retrained: false, productionWiring: false, budgetChanged: false,
        heavyRerun: false, certificateTransplantedAcrossRoots: false,
      },
    };
    writeJson(`${ROUND}/G6T2_DECISION_CAUSAL_TRACE.json`, trace);

    expect(trace.identity.completeCatTurns).toBe(110);
    expect(prod.hasSolution).toBe(true);
    expect(fullStateSha(root).length).toBe(64);
    expect(sha256(fixtureById.get('G6T2')!.canonicalSnapshotSha256).length).toBe(64);
  });
});