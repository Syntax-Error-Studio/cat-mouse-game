/// <reference types="node" />
/**
 * PPC-CAT-EVALUATOR-ABLATION-01 §8 — P7 final decision. RESEARCH ONLY.
 *
 * Consumes the frozen artifacts (never recomputes a search):
 *   ABLATION_RESULTS.json         (P3 D1 decisions, 3-rep identical)
 *   QUANTIFIER_CERTIFICATES.json  (P4 per-root E1/H1 class + independent proofStatus)
 *   PRODUCTION_100MS_RESULTS.json (P5 real-100ms modal executed trajectory)
 *   PERFORMANCE_RESULTS.json      (P6 eval/search cost + A/A calibration)
 *
 * Computes the §8 acceptance quantities and applies the verdict rules:
 *   rescued proven mouse wins / introduced proven mouse wins / lost proven cat
 *   survival / cert-supported action changes / D1→100ms reproducibility.
 *   new proven mouse win → FAIL ; safe→unsafe → FAIL ;
 *   cert missing/verify fail/root inconsistent → BLOCKED ;
 *   only-D2 improvement → no real-time claim ; action change without proof → no
 *   strength claim ; reproducible proven-safe improvement + no regression →
 *   eligible ; even all-pass → NO auto production wiring.
 *
 * A PROVEN-safe class requires proofStatus==='PROVEN' (an UNRESOLVED independent
 * certificate is NEVER treated as proven). G1T5 (no-change, UNRESOLVED both arms)
 * is reported, not hidden.
 */
import { test, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { OUT, HEAD, rootIds } from './ablation_lib';

const MOUSE_WIN = new Set(['MOUSE_FORCED_WIN_WITHIN_H0', 'MOUSE_FORCED_WIN_WITHIN_H1']);
const CAT_SAFE = new Set(['CAT_SURVIVAL_CERTIFIED_WITHIN_H1', 'CAT_FORCED_WIN_WITHIN_H1']);
const isMouseWin = (c: string) => MOUSE_WIN.has(c);
const isCatSafe = (c: string) => CAT_SAFE.has(c);
const proven = (p: string) => p === 'PROVEN';

test('P7 §8 decision: E1 vs H1 tactical safety + reproducibility + verdict', () => {
  const ablation = JSON.parse(readFileSync(`${OUT}/ABLATION_RESULTS.json`).toString('utf8'));
  const certs = JSON.parse(readFileSync(`${OUT}/QUANTIFIER_CERTIFICATES.json`).toString('utf8'));
  const prod = JSON.parse(readFileSync(`${OUT}/PRODUCTION_100MS_RESULTS.json`).toString('utf8'));
  const perf = JSON.parse(readFileSync(`${OUT}/PERFORMANCE_RESULTS.json`).toString('utf8'));
  expect(ablation.reproducibility.decisionFieldsIdenticalAcrossReps).toBe(true);
  expect(certs.summary.combos).toBe(48);
  // §8 BLOCKED triggers are captured as verdict INPUTS (not pre-write throws), so
  // the decision doc is preserved even when a cert verify / replay / root-consistency
  // failure occurs. A real failure surfaces as actionSafety=BLOCKED below.
  const replayFailures = certs.summary.replayFailures;
  const verifyFailures = certs.summary.verifyFailures;   // independent refutations
  const executedInconsistent = prod.summary.executedInconsistent;

  const rows = rootIds.map((id) => {
    const pr = certs.perRoot.find((r: any) => r.rootId === id);
    const ab = ablation.roots.find((r: any) => r.rootId === id);
    const pp = prod.perRoot.find((r: any) => r.rootId === id);
    const e1Class = pr.e1Class, h1Class = pr.h1Class, e1Proof = pr.e1Proof, h1Proof = pr.h1Proof;
    const actionChanged = pr.actionChanged, planChanged = pr.planChanged;

    const rescued = isMouseWin(e1Class) && proven(e1Proof) && isCatSafe(h1Class) && proven(h1Proof);
    const introduced = !isMouseWin(e1Class) && isMouseWin(h1Class) && proven(h1Proof);
    const lostSurvival = e1Class === 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1' && proven(e1Proof) && !isCatSafe(h1Class);
    const survivalGain = !isCatSafe(e1Class) && isCatSafe(h1Class) && proven(h1Proof);
    const certSupportedChange = actionChanged && proven(e1Proof) && proven(h1Proof);
    const changeMissingProof = actionChanged && (!proven(e1Proof) || !proven(h1Proof));

    // D1 → real-100ms reproducibility (first executed action), per arm
    const d1E1 = ab.D1.E1.faithful.selectedAction, d1H1 = ab.D1.H1.faithful.selectedAction;
    const msE1 = pp.e1FirstAction, msH1 = pp.h1FirstAction;
    return {
      rootId: id, actionChanged, planChanged,
      e1Selected: pr.e1Selected, h1Selected: pr.h1Selected, e1Plan: pr.e1Plan, h1Plan: pr.h1Plan,
      e1Class, h1Class, e1Proof, h1Proof,
      rescuedProvenMouseWin: rescued, introducedProvenMouseWin: introduced,
      lostProvenCatSurvival: lostSurvival, provenSurvivalGain: survivalGain,
      certSupportedActionChange: certSupportedChange, actionChangeMissingProof: changeMissingProof,
      d1E1FirstAction: d1E1, d1H1FirstAction: d1H1, ms100E1FirstAction: msE1, ms100H1FirstAction: msH1,
      d1To100msE1Reproduced: d1E1 === msE1, d1To100msH1Reproduced: d1H1 === msH1,
      e1ExecutedConsistent: pp.e1ExecutedConsistent, h1ExecutedConsistent: pp.h1ExecutedConsistent,
      actionChangedAt100ms: pp.actionChangedAt100ms,
    };
  });

  const sum = (k: string) => rows.filter((r: any) => r[k]).length;
  const rescued = sum('rescuedProvenMouseWin');
  const introduced = sum('introducedProvenMouseWin');
  const lostSurvival = sum('lostProvenCatSurvival');
  const survivalGain = sum('provenSurvivalGain');
  const certSupportedChanges = sum('certSupportedActionChange');
  const changesMissingProof = sum('actionChangeMissingProof');
  const actionChanges = rows.filter((r) => r.actionChanged).length;
  const planChanges = rows.filter((r) => r.planChanged).length;
  const unresolvedCombos = certs.summary.unresolvedCount;
  const unresolvedRoots = certs.perRoot.filter((r: any) => r.e1Proof === 'UNRESOLVED' || r.h1Proof === 'UNRESOLVED').map((r: any) => r.rootId);
  const d1To100E1 = rows.filter((r) => r.d1To100msE1Reproduced).length;
  const d1To100H1 = rows.filter((r) => r.d1To100msH1Reproduced).length;

  // ---- verdict rules ----
  const certVerifyBlocked = verifyFailures > 0 || replayFailures > 0;
  const rootInconsistentBlocked = executedInconsistent > 0;
  let actionSafety: string;
  if (introduced > 0 || lostSurvival > 0) actionSafety = 'FAIL';
  else if (changesMissingProof > 0 || certVerifyBlocked || rootInconsistentBlocked) actionSafety = 'BLOCKED';
  else actionSafety = 'NO_PROVEN_REGRESSION';

  const provenImprovement = rescued > 0 || survivalGain > 0;
  const aaPass = perf.aaCalibration_7_3.calibrationPass;
  const performanceVerdict = perf.performanceVerdict;

  let eligibility: string;
  if (actionSafety === 'FAIL') eligibility = 'REJECT_UNSAFE';
  else if (actionSafety === 'BLOCKED') eligibility = 'BLOCKED_MISSING_PROOF';
  else if (!provenImprovement) eligibility = 'NOT_ELIGIBLE_NO_PROVEN_BENEFIT';
  else if (!aaPass) eligibility = 'BLOCKED_PERFORMANCE';
  else eligibility = 'ELIGIBLE_PROVEN_SAFE_IMPROVEMENT';

  const doc = {
    artifactId: 'P7_DECISION', round: OUT, phase: 8,
    generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p7_decision.test.ts`,
    head: HEAD, productionSourceChanged: false,
    inputs: {
      ablationFingerprint: ablation.reproducibility.decisionFingerprintSha256,
      certSummary: certs.summary, prodRoundsUsed: prod.roundsUsed, prodSummary: prod.summary,
      perfVerdict: performanceVerdict, aaCalibrationPass: aaPass,
    },
    counts: {
      actionChanges, planChanges, rescuedProvenMouseWins: rescued, introducedProvenMouseWins: introduced,
      lostProvenCatSurvival: lostSurvival, provenSurvivalGains: survivalGain,
      certSupportedActionChanges: certSupportedChanges, actionChangesMissingProof: changesMissingProof,
      unresolvedCombos, unresolvedRoots,
      d1To100msReproducedE1: d1To100E1, d1To100msReproducedH1: d1To100H1, roots: rows.length,
    },
    verdict: {
      actionSafety, provenImprovement, eligibility,
      performanceBlocked: !aaPass, performanceVerdict,
      blockedTriggers: { certVerifyBlocked, rootInconsistentBlocked, changesMissingProof: changesMissingProof > 0, verifyFailures, replayFailures, executedInconsistent },
      productionEvaluatorChange: 'NOT_AUTHORIZED', newEfficacyAuthority: 'NONE',
      eligibilityPrecedence: 'no-proven-benefit precedes performance-block: a change with no proven tactical benefit is not eligible regardless of whether its performance could be cleanly measured; performance-block only gates a change that DOES have a proven benefit',
      rule: 'even an all-pass round does NOT auto-wire H1 into production; ChatGPT architectural ruling required',
    },
    rows,
  };
  writeFileSync(`${OUT}/_raw/p7_decision.json`, JSON.stringify(doc, null, 2));

  console.log('[P7] counts=', JSON.stringify(doc.counts));
  console.log('[P7] verdict=', JSON.stringify(doc.verdict));
  console.log('[P7] action-changed roots:', rows.filter((r) => r.actionChanged).map((r) => `${r.rootId}(${r.e1Selected}->${r.h1Selected} ${r.e1Class}/${r.e1Proof}=>${r.h1Class}/${r.h1Proof})`).join(' '));
  console.log('[P7] D1->100ms reproduced E1=', d1To100E1, '/24 H1=', d1To100H1, '/24');

  // structural gates (the verdict is REPORTED, not asserted to a desired value)
  expect(rows.length).toBe(24);
  expect(introduced).toBe(0);          // a real introduced proven mouse win would be a FAIL, surfaced above
  expect(doc.verdict.productionEvaluatorChange).toBe('NOT_AUTHORIZED');
}, 600_000);