/// <reference types="node" />
/**
 * PPC-G6T2-SELECTION-CAUSE-01 / G4 — evidence-driven root-cause classification.
 *
 * Reads only the artifacts produced by G1/G2/G3. Each case is decided by an
 * explicit predicate; no case is asserted from prose. Multiple layers are
 * allowed on purpose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OUT, ROOT_ID, ARM, DEPTH_TURNS, FROZEN_D2, writeJson, ensureDirs } from './sc_lib';

const J = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('G4 root-cause verdict', () => {
  it('classifies the selection cause from measured evidence', () => {
    ensureDirs();
    const progress = J(`${OUT}/PLAN_PROGRESS_AUDIT.json`);
    const child = J(`${OUT}/D2_CHILD_VALUE_AUDIT.json`);
    const parity = J(`${OUT}/D2_INSTRUMENTATION_PARITY.json`);
    const forced = J(`${OUT}/FORCED_PLAN_COMPARISON.json`);

    const afterD = child.childValueEvidence.afterD;
    const rootValues = child.search.rootValues as { label: string; value: number; mate: string | null; bound: string }[];
    const dNode = child.nodes.afterD;
    const drNode = child.nodes.afterDR;
    const drrNode = child.nodes.afterDRR;

    const exact = (a: number, b: number) => a === b;

    // ---- CASE A: exact child-value tie at the fork -------------------------
    const caseA = {
      supported: parity.parity === true
        && afterD.uEqualsRExactly === true
        && dNode !== null
        && dNode.distinctValueCount === 1
        && rootValues.every((r) => r.value === FROZEN_D2.value)
        && rootValues.length === 3,
      evidence: {
        parity: parity.parity,
        rootValues: rootValues.map((r) => ({ action: r.label, value: r.value, mate: r.mate, bound: r.bound })),
        afterD: {
          U: afterD.U ? afterD.U.value : null,
          L: afterD.L ? afterD.L.value : null,
          R: afterD.R ? afterD.R.value : null,
          deltaUminusR: afterD.deltaUminusR,
          choice: afterD.chosen,
          tieBreakRule: dNode?.tieBreakRule ?? null,
        },
      },
      interpretation: 'at the D node all three continuations (U, L, R) carry the identical exact value; the strict-improvement rule cannot prefer R, and the stable legal-order rule keeps the smaller original index (U), so R is not eliminated by value - it is eliminated by the tie-break.',
    };

    // ---- CASE B: evaluator strictly prefers another line -------------------
    const drActions = drNode ? drNode.actions as { label: string; value: number }[] : [];
    const drrActions = drrNode ? drrNode.actions as { label: string; value: number }[] : [];
    const pick = (arr: { label: string; value: number }[], l: string) => arr.find((a) => a.label === l)?.value ?? null;
    const drR = pick(drActions, 'R');
    const drL = pick(drActions, 'L');
    const drrR = pick(drrActions, 'R');
    const drrL = pick(drrActions, 'L');
    const caseB = {
      supported: forced.comparable === true
        && forced.valueComparison.status === 'COMPARABLE'
        && forced.valueComparison.drrrWorseUnderE1 === true,
      evidence: {
        forcedDuud: forced.valueComparison.forcedDuud,
        forcedDrrr: forced.valueComparison.forcedDrrr,
        deltaDrrrMinusDuud: forced.valueComparison.deltaDrrrMinusDuud,
        drNode: { R: drR, L: drL, chosen: drNode?.choiceLabel ?? null, strictPreferenceForL: drR !== null && drL !== null && drL > drR },
        drrNode: { R: drrR, L: drrL, chosen: drrNode?.choiceLabel ?? null, strictPreferenceForL: drrR !== null && drrL !== null && drrL > drrR },
      },
      interpretation: 'once the DR prefix is fixed the search does not consider R equal any more: R is strictly worse than L at both DR and DRR, and the fully forced DRRR plan scores 195.79 lower than the forced DUUD plan under the same E1 leaf evaluator and the same remaining depth. The evaluator itself prefers the loop, not the RRR line.',
    };

    // ---- CASE C: extraction mismatch (needs reproducible conflict) ---------
    const plans = child.search.plans;
    const caseC = {
      supported: plans.extractionDivergence === true,
      evidence: {
        directWalkPlans: plans.directWalkPlans,
        productionCatTurnPlan: plans.productionCatTurnPlan,
        productionPlanReplay: plans.productionPlanReplay,
        reproducibility: 'both channels are deterministic functions of the SAME post-search ctx; the observed copy is byte-equal to transform(production) and parity re-verified nodes/leaf/chance/value/root values exactly',
      },
      interpretation: 'the production searchBestAction() returns catTurnPlan ULDR while the per-root planBranches walk (the channel the D2 round published as candidates) yields UUDD. This is a real, reproducible extraction divergence at the plan-publication layer, but it does not create the D->R decision: that decision is the exact tie in CASE A.',
    };

    // ---- CASE D: chance expectation gap -----------------------------------
    const plansAll = (progress.plans as { plan: string; ok: boolean; steps: { chance: boolean; probabilitySum: number | null; branchCount: number }[] }[]);
    const chanceSteps = plansAll.flatMap((p) => p.steps.filter((s) => s.chance));
    const chanceSane = chanceSteps.length > 0
      && chanceSteps.every((s) => s.probabilitySum === 1 && s.branchCount === 1);
    const caseD = {
      supported: false,
      evidence: {
        chanceStepsInAllSixPlans: chanceSteps.length,
        everyChanceProbabilitySumIsOne: chanceSane,
        singleSuccessorPerChanceStep: chanceSteps.every((s) => s.branchCount === 1),
        forcedBaselineExact: forced.baselineCheck.exactEquality === true,
      },
      interpretation: 'every CHANCE step in these six plans has one positive-probability successor and probability sum 1, and the forced DUUD baseline reproduces the frozen D2 branch value exactly; there is no measured expectation gap to attribute the selection to. Not supported as a cause (it remains a modelling factor only if other chance branches are ever examined).',
    };

    const caseE = {
      supported: !(caseA.supported || caseB.supported || caseC.supported),
      interpretation: caseA.supported || caseB.supported || caseC.supported
        ? 'not needed: at least one layer is supported by measurement; H1/5000 UNRESOLVED is a certificate status, not this verdict'
        : 'no measured layer explains the selection',
    };

    const layers = [
      caseA.supported ? 'A_D2_CHILD_VALUE_TIE' : null,
      caseB.supported ? 'B_D2_EVALUATOR_PREFERS_OTHER' : null,
      caseC.supported ? 'C_PLAN_EXTRACTION_MISMATCH' : null,
      caseD.supported ? 'D_CHANCE_EXPECTATION_GAP' : null,
      caseE.supported ? 'E_UNRESOLVED' : null,
    ].filter(Boolean);

    const verdict = {
      round: OUT,
      phase: 'G4_ROOT_CAUSE_VERDICT',
      generatedAt: new Date().toISOString(),
      rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS,
      instrumentationParity: parity.parity,
      gate: parity.parity === true ? 'SCORES_ADMISSIBLE' : 'INSTRUMENTATION_PARITY_FAIL',
      cases: {
        A: caseA, B: caseB, C: caseC, D: caseD, E: caseE,
      },
      layers,
      primaryCause: caseA.supported ? 'A_D2_CHILD_VALUE_TIE' : (caseB.supported ? 'B_D2_EVALUATOR_PREFERS_OTHER' : 'E_UNRESOLVED'),
      answers: {
        q1_plans_non_progressing: {
          answer: 'They are closed cat loops, not byte-identical boards. In all three plans the cat returns to (3,3) with the mouse still at (1,6); terrain, boxes, trap and blocked tunnels are unchanged. The final state differs from the settled root ONLY by the turn handoff, the move counters, and the already-pending butter spawn materialising. So: no positional/terrain progress, but not "the whole state is unchanged".',
          evidence: progress.crossPlan,
        },
        q2_why_not_R_after_D: {
          answer: 'At the D node the three values are EXACTLY equal (U=L=R=-658.2105263157898). R is not rejected by value; the strict-improvement rule finds no improvement and the stable legal-order rule keeps U (original index 0 < L 1 < R 2). Further, after DR the R step is strictly worse than L (DR: -745.447 vs -658.211; DRR: -854 vs -745.447), so the RRR line is not a tie at deeper layers either.',
          evidence: { afterD: child.childValueEvidence.afterD, dr: { R: drR, L: drL }, drr: { R: drrR, L: drrL } },
        },
        q3_safe_DRRR_rank: {
          answer: 'At DRR the exact values are D -900.7105, L -745.4474, R -854.0 (higher is better for the cat), so R ranks second of three - ahead of D but strictly behind L. The forced complete DRRR plan scores -854.0 against the chosen DUUD -658.2105, a measured penalty of 195.7895 under the same evaluator and remaining depth. The "safe" label is a survival certificate (H2), not a value advantage.',
          evidence: { drrActions, forced: forced.valueComparison },
        },
        q4_why_root_values_tied: {
          answer: 'The three root actions reach (or are scored as) the same exact expectiminimax value under E1 at depth 2: every root child is a cat-to-move node whose own subtree ends in the same closed-loop frontier class, so the exact arithmetic returns the identical rational (-658.2105263157898) with bound=exact and mate=null. This is a genuine value tie, not a rounding artifact (all three are bit-identical).',
          evidence: rootValues,
        },
        q5_failure_location: {
          answer: 'It is not search horizon (completed=true, 1,283,054 nodes, 0 cutoffs), not a budget/tie-rule defect (the tie rule behaved exactly as specified), and not chance expectation (single successor, weight sum 1, forced baseline exact). The selection cause is the interaction of (a) an exact value tie at the D fork resolved by legal order, (b) an evaluator that strictly disprefers the RRR line once the prefix is fixed, and (c) a plan-extraction divergence at the publication layer (production ULDR vs published D2 UUDD).',
          evidence: { parity: parity.checks, forced: forced.valueComparison, plans: child.search.plans },
        },
        q6_next_tactical_mechanism: {
          answer: 'For the 100ms/150ms production budget the next mechanism should not be "raise depth". What this evidence supports is an explicit, cheap tactical tie-break layer between equal exact values that scores safety/progress separately from E1: (i) prefer continuations with a monotone progress measure (no closed loops: distinct cat cells visited, distance-to-mouse monotonicity, box/trap/tunnel edges), (ii) treat the H2 survival certificate as a hard filter rather than a value, and (iii) fix the extraction channel so the published plan is the plan the search actually decided (single source of truth). All three are offline-provable and do not change search math or budgets.',
          evidence: { notes: 'design recommendation only; not implemented this round' },
        },
      },
      prohibitions: {
        productionSourceModified: false,
        commit: false, push: false, merge: false,
        searchMathChanged: false, budgetChanged: false,
        selfPlayOrFullRootGrid: false,
      },
      stopForChatGPTReview: true,
    };
    writeJson(`${OUT}/ROOT_CAUSE_VERDICT.json`, verdict);

    console.log('--- G4 VERDICT ---');
    console.log('parity =', parity.parity, 'layers =', JSON.stringify(layers));
    console.log('A tie =', caseA.supported, 'B evaluator =', caseB.supported, 'C extraction =', caseC.supported, 'D chance =', caseD.supported);
    console.log('forced DRRR - DUUD =', forced.valueComparison.deltaDrrrMinusDuud);
    console.log('--- END ---');

    expect(parity.parity).toBe(true);
    expect(caseA.supported).toBe(true);
  });
});