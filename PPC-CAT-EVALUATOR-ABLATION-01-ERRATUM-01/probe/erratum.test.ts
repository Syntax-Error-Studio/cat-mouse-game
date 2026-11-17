/// <reference types="node" />
/**
 * PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01 — P7 metric erratum + G1T3/E1
 * actual-100ms-plan independent quantifier certificate.
 *
 * TEST 1 (read-only recomputation):
 *   Distinguishes, per root and arm,
 *     bestAction              (D1 selectedAction)
 *     D1 executable plan      (D1 catTurnPlan / planString)
 *     100 ms actual plan      (P5 finalPlan, post-sidecar; equals the executed prefix)
 *   and recomputes every corrected count from the frozen P3/P4/P5 artifacts.
 *   Also maps all 48 P4 certificate plans against the 48 actual 100 ms plans
 *   (real-rule replay only; no search) and lists the uncovered actual plans.
 *
 * TEST 2 (independent certification, search):
 *   Restores the exact frozen G1T3 root, verifies snapshot SHA + stateKey, replays
 *   UUUL through the real RuleSet, expands every positive-probability CHANCE
 *   successor, and runs the PPC-CAT-STRATEGY-SEAL-01 kernel separately for
 *   mouseForce / catSurvive / catForce at H0=1, H1=2, cap=600000. Every definite
 *   TRUE label is checked by an INDEPENDENT verifier; survival is NEVER inferred
 *   from !mouseForce. H1/G1T3/RRRR is REUSED only after exact identity against
 *   the existing P4 PROVEN certificate. The other actual plans that the P4
 *   certificate set does not cover are certified too (no full 24-root rerun).
 *
 * Prohibited and not performed: production source change, rules/search-math/H1/
 * 100ms-150ms change, full-24 rerun, P5/P6 rerun, self-play, commit/push/merge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  ROUND, PREV_ROUND, OUT, PREV_OUT, HEAD, FIXTURE, FROZEN_FIXTURE_SHA, QCAP, H0, H1,
  sha256, ensureOut, readJson, rootIds, fixtureSha256, fixtureSnapshotSha, loadRoot, stateKey,
  ablation, certs, prod, loadP5Rounds, p5ModalByCombo, buildCorrectedRows, correctedCounts,
  buildCoverage, uncoveredCoverage, certifyPlan, auditH1G1T3Reuse,
  snapshotIdentity, fileIdentity, writeCsv, ORIGINAL_ARTIFACTS, SOURCE_FILES,
  type CorrectedRow,
} from './erratum_lib';

const CSV_HEADER = [
  'root_id', 'best_action_e1', 'best_action_h1', 'best_action_changed',
  'd1_plan_e1', 'd1_plan_h1', 'd1_first_e1', 'd1_first_h1', 'd1_executable_first_changed',
  'ms100_plan_e1', 'ms100_plan_h1', 'ms100_first_e1', 'ms100_first_h1', 'ms100_executable_first_changed',
  'e1_d1_to_ms100_first_reproduced', 'h1_d1_to_ms100_first_reproduced',
  'e1_full_plan_reproduced', 'h1_full_plan_reproduced',
  'd1_full_plan_changed', 'ms100_full_plan_changed',
  'cert_plan_e1', 'cert_plan_h1', 'e1_cert_covers_actual', 'h1_cert_covers_actual',
  'e1_class', 'e1_proof', 'h1_class', 'h1_proof',
  'action_changed_p4', 'plan_changed_p4',
];

const toCsvRow = (r: CorrectedRow) => ({
  root_id: r.rootId,
  best_action_e1: r.bestActionE1, best_action_h1: r.bestActionH1, best_action_changed: r.bestActionChanged,
  d1_plan_e1: r.d1PlanE1, d1_plan_h1: r.d1PlanH1,
  d1_first_e1: r.d1FirstE1, d1_first_h1: r.d1FirstH1, d1_executable_first_changed: r.d1ExecutableFirstChanged,
  ms100_plan_e1: r.msPlanE1, ms100_plan_h1: r.msPlanH1,
  ms100_first_e1: r.msFirstE1, ms100_first_h1: r.msFirstH1, ms100_executable_first_changed: r.msExecutableFirstChanged,
  e1_d1_to_ms100_first_reproduced: r.e1D1ToMsFirstReproduced,
  h1_d1_to_ms100_first_reproduced: r.h1D1ToMsFirstReproduced,
  e1_full_plan_reproduced: r.e1FullPlanReproduced, h1_full_plan_reproduced: r.h1FullPlanReproduced,
  d1_full_plan_changed: r.d1FullPlanChanged, ms100_full_plan_changed: r.msFullPlanChanged,
  cert_plan_e1: r.certPlanE1, cert_plan_h1: r.certPlanH1,
  e1_cert_covers_actual: r.e1CertCoversActual, h1_cert_covers_actual: r.h1CertCoversActual,
  e1_class: r.e1Class, e1_proof: r.e1Proof, h1_class: r.h1Class, h1_proof: r.h1Proof,
  action_changed_p4: r.e1ActionChanged, plan_changed_p4: r.planChangedP4,
});

const git = (cmd: string): string => {
  try { return execSync(cmd, { encoding: 'utf8', cwd: '.' }).trim(); }
  catch (e: any) { return `GIT_ERROR: ${String(e.stderr ?? e.message).trim()}`; }
};

const identityEqual = (a: ReturnType<typeof snapshotIdentity>, b: ReturnType<typeof snapshotIdentity>) =>
  a.originals.every((x, i) => x.sha256 === b.originals[i].sha256 && x.bytes === b.originals[i].bytes) &&
  a.sources.every((x, i) => x.sha256 === b.sources[i].sha256 && x.bytes === b.sources[i].bytes && x.mtimeIso === b.sources[i].mtimeIso);

describe('PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01', () => {
  const runStart = new Date().toISOString();

  it('T1 — recomputes all 24 roots with executable-plan semantics (no search)', () => {
    ensureOut();
    expect(fixtureSha256, 'frozen fixture digest').toBe(FROZEN_FIXTURE_SHA);
    expect(rootIds.length).toBe(24);

    // Preserve exact identity of every original artifact and every source file.
    const identityBefore = snapshotIdentity();
    writeFileSync(`${OUT}/_raw/identity_before.json`, JSON.stringify(identityBefore, null, 2));

    // P5 artifact integrity: 5 fresh-process rounds, frozen budget, consistent plans.
    const { files, rounds } = loadP5Rounds();
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const r of rounds) {
      expect(r.head).toBe(HEAD);
      expect(r.fixtureSha256).toBe(FROZEN_FIXTURE_SHA);
      expect(r.rows.length).toBe(48);
      for (const row of r.rows) {
        expect(row.finalPlan).toBe(row.finalPlanDebug);
        expect(row.sidecar?.overrideUsed ?? false).toBe(false);
        expect(row.executed.fallbackOccurred ?? false).toBe(false);
        expect(row.executed.label.startsWith(row.finalPlan), 'executed trace must follow finalPlan').toBe(true);
      }
    }
    expect(prod.summary.executedConsistent).toBe(48);
    expect(prod.summary.finalPlanConsistent).toBe(48);
    expect(prod.summary.fallbackCombos).toBe(0);
    expect(prod.summary.overrideCombos).toBe(0);

    const p5 = p5ModalByCombo();
    expect(p5.size).toBe(48);
    for (const v of p5.values()) {
      expect(v.finalPlanConsistent, `${v.rootId}/${v.arm} finalPlan consistent`).toBe(true);
      expect(v.executedConsistent, `${v.rootId}/${v.arm} executed consistent`).toBe(true);
      expect(v.finalPlanEqualsExecutedPrefix, `${v.rootId}/${v.arm} executed follows finalPlan`).toBe(true);
      expect(v.rootIdentityConsistent, `${v.rootId}/${v.arm} root identity`).toBe(true);
      expect(v.modalFinalPlan[0], `${v.rootId}/${v.arm} first plan step == first executed step`)
        .toBe(v.modalExecuted[0]);
    }

    // Corrected 24-root table.
    const rows = buildCorrectedRows();
    expect(rows.length).toBe(24);
    const counts = correctedCounts(rows);
    // P7 compared D1 bestAction (not the executable plan) to the 100 ms first
    // action. The corrected comparison uses D1 catTurnPlan[0] vs 100 ms finalPlan[0].
    for (const r of rows) {
      expect(r.bestActionE1).toBe(ablation.roots.find((x: any) => x.rootId === r.rootId).D1.E1.faithful.selectedAction);
      expect(r.d1PlanE1).toBe(ablation.roots.find((x: any) => x.rootId === r.rootId).D1.E1.faithful.planString);
      const pv = p5.get(`${r.rootId}/E1`)!;
      expect(r.msPlanE1).toBe(pv.modalFinalPlan);
    }

    // 48-combo plan↔certificate coverage map (real replay only).
    const cov = buildCoverage();
    expect(cov.length).toBe(48);
    for (const c of cov) {
      expect(c.rootIdentity.fixtureShaMatchesFrozen, `${c.rootId}/${c.arm} fixture sha`).toBe(true);
      expect(c.rootIdentity.fixtureSnapshotEqualsAblation, `${c.rootId}/${c.arm} fixture=ablation snapshot`).toBe(true);
      expect(c.rootIdentity.fixtureSnapshotEqualsP4, `${c.rootId}/${c.arm} fixture=P4 snapshot`).toBe(true);
      expect(c.rootIdentity.stateKeyEqualsAblation, `${c.rootId}/${c.arm} stateKey=ablation`).toBe(true);
      expect(c.rootIdentity.p5StateKeyConsistent, `${c.rootId}/${c.arm} P5 stateKey`).toBe(true);
      expect(c.rootIdentity.p5SnapshotConsistent, `${c.rootId}/${c.arm} P5 snapshot`).toBe(true);
      expect(c.p4Replay.replayMatchesP4Branches, `${c.rootId}/${c.arm} P4 replay binds its plan`).toBe(true);
    }
    const uncovered = uncoveredCoverage(cov);
    const coveredCount = cov.filter((c) => c.certBindsActualPlan).length;

    writeCsv(`${OUT}/CORRECTED_ROOT_TABLE.csv`, rows.map(toCsvRow), CSV_HEADER);

    const p7Path = `${PREV_OUT}/_raw/p7_decision.json`;
    const p7 = existsSync(p7Path) ? readJson(p7Path) : null;
    const p7Unreproduced = p7 ? {
      e1: p7.rows.filter((r: any) => !r.d1To100msE1Reproduced).map((r: any) => r.rootId),
      h1: p7.rows.filter((r: any) => !r.d1To100msH1Reproduced).map((r: any) => r.rootId),
    } : null;

    const doc = {
      artifactId: 'ERRATUM_METRICS', round: ROUND,
      generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/erratum.test.ts`,
      head: HEAD, fixtureSha256: FROZEN_FIXTURE_SHA, productionSourceChanged: false,
      purpose: 'Recompute P7 decision metrics with the EXECUTABLE plan (catTurnPlan[0] / P5 finalPlan[0]), not bestAction.',
      p7Original: p7 ? {
        source: p7Path, sha256: fileIdentity(p7Path).sha256,
        counts: p7.counts,
        unreproducedE1: p7Unreproduced!.e1, unreproducedH1: p7Unreproduced!.h1,
        comparison: 'P7 compared D1 selectedAction (bestAction) with the real-100ms first executed action.',
      } : null,
      correctedCounts: counts,
      deltaVsP7: p7 ? {
        e1D1To100msReproduction: { before: p7.counts.d1To100msReproducedE1, after: counts.d1ToMsFirstReproducedE1 },
        h1D1To100msReproduction: { before: p7.counts.d1To100msReproducedH1, after: counts.d1ToMsFirstReproducedH1 },
        e1UnreproducedRoots: { before: p7Unreproduced!.e1, after: counts.d1ToMsFirstUnreproducedE1 },
        h1UnreproducedRoots: { before: p7Unreproduced!.h1, after: counts.d1ToMsFirstUnreproducedH1 },
        bestActionChanges: { before: p7.counts.actionChanges, after: counts.bestActionChanges },
        d1FullPlanChanges: { before: p7.counts.planChanges, after: counts.d1FullPlanChanged },
        note: 'bestAction and executable-plan changes coincide at D1 (5 roots), but the D1→100ms reproduction denominator changes because G5T1/E1 executable plan first step D equals the 100 ms first step D.',
      } : null,
      rows,
      coverage: {
        combos: cov.length, certBindsActualPlan: coveredCount, uncoveredCount: uncovered.length,
        uncovered: uncovered.map((c) => ({
          rootId: c.rootId, arm: c.arm, certPlan: c.certPlan, actualPlan: c.actualPlan,
          selectedAction: c.selectedAction,
          reason: c.covered ? 'replay mismatch' : 'P4 certificate plan differs from actual 100 ms plan',
        })),
        rows: cov,
      },
      p5Audit: {
        roundsUsed: files.length,
        combos: p5.size,
        everyFinalPlanConsistent: Array.from(p5.values()).every((v) => v.finalPlanConsistent),
        everyExecutedConsistent: Array.from(p5.values()).every((v) => v.executedConsistent),
        everyExecutedFollowsFinalPlan: Array.from(p5.values()).every((v) => v.finalPlanEqualsExecutedPrefix),
        everyRootIdentityConsistent: Array.from(p5.values()).every((v) => v.rootIdentityConsistent),
        fallbackRows: Array.from(p5.values()).reduce((n, v) => n + v.fallbackRows, 0),
        overrideRows: Array.from(p5.values()).reduce((n, v) => n + v.overrideRows, 0),
      },
      contract: {
        executablePlanD1: 'D1 catTurnPlan / planString (hardTurnPlanner returns plan separately from bestAction)',
        executablePlan100ms: 'P5 finalPlan (post sidecar; executed trace starts with this plan)',
        p7MetricErratum: 'bestAction != executable plan when the equal-primary plan extraction selects an equal-valued route',
        notHardcoded: 'every count below is recomputed row-by-row from P3/P4/P5 artifacts',
      },
    } as any;
    writeFileSync(`${OUT}/_raw/erratum_metrics.json`, JSON.stringify(doc, null, 2));

    console.log('[T1] P7 original counts=', JSON.stringify(p7?.counts ?? null));
    console.log('[T1] corrected counts=', JSON.stringify(counts));
    console.log('[T1] coverage=', coveredCount, '/48 cert-binds-actual; uncovered=', uncovered.length,
      uncovered.map((c) => `${c.rootId}/${c.arm} cert=${c.certPlan} actual=${c.actualPlan}`).join(' '));
    console.log('[T1] D1→100ms first-step reproduced E1=', counts.d1ToMsFirstReproducedE1,
      '/24 H1=', counts.d1ToMsFirstReproducedH1, '/24; 100ms first-step changes=',
      counts.msFirstChangeRoots.join(','));
  }, 600_000);

  it('T2 — independently certifies G1T3/E1 UUUL and the other uncovered actual plans', () => {
    ensureOut();
    const identityBefore = readJson(`${OUT}/_raw/identity_before.json`);
    const identityNow = snapshotIdentity();
    expect(identityEqual(identityBefore, identityNow), 'originals + production sources unchanged during the erratum run').toBe(true);
    expect(fileIdentity(FIXTURE).sha256).toBe(FROZEN_FIXTURE_SHA);

    const metrics = readJson(`${OUT}/_raw/erratum_metrics.json`);
    const uncovered: { rootId: string; arm: 'E1' | 'H1'; actualPlan: string; certPlan: string }[] =
      metrics.coverage.uncovered;
    expect(uncovered.length).toBeGreaterThan(0);

    // ---- H1/G1T3/RRRR: reuse only on exact identity with the P4 PROVEN cert ----
    const reuse = auditH1G1T3Reuse();
    expect(reuse.fixtureSha256Matches).toBe(true);
    expect(reuse.p4PlanMatches).toBe(true);
    expect(reuse.p5ActualPlanMatches).toBe(true);
    expect(reuse.p4SnapshotMatches).toBe(true);
    expect(reuse.p5StateKeyMatches).toBe(true);
    expect(reuse.replayPostKeysMatchP4).toBe(true);
    expect(reuse.certIdsMatchP4).toBe(true);
    expect(reuse.reuseEligible).toBe(true);
    expect(reuse.p4Proof).toBe('PROVEN');

    // ---- G1T3/E1/UUUL: the primary erratum certificate ----
    const g1t3e1 = certifyPlan('G1T3', 'E1', 'UUUL', 'P5 modal finalPlan over 5 fresh-process rounds');
    expect(g1t3e1.fixtureSnapshotSha256).toBe(fixtureSnapshotSha('G1T3'));
    expect(g1t3e1.fixtureSnapshotSha256).toBe('e15e6209f7d64337ac02675b9299b7599f06c9d33abfa41bdc84baea2f089439');
    const abG1T3 = ablation.roots.find((r: any) => r.rootId === 'G1T3');
    expect(g1t3e1.restoredStateKey).toBe(abG1T3.stateKey);
    const p5g1 = p5ModalByCombo().get('G1T3/E1')!;
    expect(p5g1.stateKeysByRound.every((k) => k === abG1T3.stateKey)).toBe(true);
    expect(p5g1.snapshotsByRound.every((s) => s === fixtureSnapshotSha('G1T3'))).toBe(true);
    expect(p5g1.modalFinalPlan).toBe('UUUL');
    expect(p5g1.finalPlanConsistent).toBe(true);
    expect(p5g1.overrideRows).toBe(0);
    expect(p5g1.fallbackRows).toBe(0);
    expect(g1t3e1.replay.ok).toBe(true);
    expect(g1t3e1.replay.catTurnEnded, 'the full 4-step cat turn must end before quantifying').toBe(true);
    expect(g1t3e1.applyPrefixCrossCheck.ok).toBe(true);
    expect(g1t3e1.applyPrefixCrossCheck.stateKeysEqual).toBe(true);
    expect(g1t3e1.verifier.verifyFailures, 'no independent verifier may refute a definite TRUE label').toBe(0);
    if (g1t3e1.proofStatus === 'PROVEN') {
      expect(g1t3e1.branches.every((b) => b.certificates.every((c) => c.ok && c.verdict === 'PROVEN'))).toBe(true);
    }
    if (g1t3e1.aggregatedClass === 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1') {
      expect(g1t3e1.branches.some((b) => b.certificates.some((c) => c.question === 'catSurvive' && c.verdict === 'PROVEN')))
        .toBe(true);
    }

    // ---- Other uncovered actual 100 ms plans (no full 24-root rerun) ----
    const others = uncovered.filter((u) => !(u.rootId === 'G1T3' && u.arm === 'E1'));
    const additional = others.map((u) => certifyPlan(u.rootId, u.arm, u.actualPlan, 'P5 modal finalPlan over 5 fresh-process rounds'));
    for (const c of additional) {
      expect(c.fixtureSnapshotSha256).toBe(fixtureSnapshotSha(c.rootId));
      expect(c.restoredStateKey).toBe(ablation.roots.find((r: any) => r.rootId === c.rootId).stateKey);
      expect(c.replay.ok).toBe(true);
      expect(c.replay.catTurnEnded).toBe(true);
      expect(c.applyPrefixCrossCheck.stateKeysEqual).toBe(true);
      expect(c.verifier.verifyFailures).toBe(0);
      if (c.proofStatus === 'PROVEN') {
        expect(c.branches.every((b) => b.certificates.every((cc) => cc.ok && cc.verdict === 'PROVEN'))).toBe(true);
      }
    }

    // ---- verdict (never inferred from a negative) ----
    const MOUSE_WIN = new Set(['MOUSE_FORCED_WIN_WITHIN_H0', 'MOUSE_FORCED_WIN_WITHIN_H1']);
    const CAT_SAFE = new Set(['CAT_SURVIVAL_CERTIFIED_WITHIN_H1', 'CAT_FORCED_WIN_WITHIN_H1']);
    const e1MouseWinProven = g1t3e1.proofStatus === 'PROVEN' && MOUSE_WIN.has(g1t3e1.aggregatedClass);
    const h1CatSafeProven = reuse.reuseEligible && reuse.p4Proof === 'PROVEN' && CAT_SAFE.has(reuse.p4Class);
    const proven100msTacticalGain = e1MouseWinProven && h1CatSafeProven;

    const g1t3Doc = {
      artifactId: 'G1T3_E1_100MS_CERTIFICATE', round: ROUND,
      generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/erratum.test.ts`,
      head: HEAD, productionSourceChanged: false,
      subject: {
        root: 'G1T3', arm: 'E1', actual100msPlan: 'UUUL',
        actualPlanSource: 'P5 PRODUCTION_100MS_RESULTS.json modal finalPlan over 5 fresh-process rounds',
        whyThisPlan: 'P4 certified the D1 plan DRRR, not the actual 100 ms plan UUUL; UUUL is therefore newly certified here.',
      },
      rootIdentity: {
        fixture: FIXTURE,
        fixtureSha256,
        fixtureShaMatchesFrozen: fixtureSha256 === FROZEN_FIXTURE_SHA,
        fixtureSnapshotSha256: fixtureSnapshotSha('G1T3'),
        restoredStateKey: g1t3e1.restoredStateKey,
        ablationStateKey: abG1T3.stateKey,
        stateKeyMatchesAblation: g1t3e1.restoredStateKey === abG1T3.stateKey,
        p5StateKeysAllRounds: p5g1.stateKeysByRound,
        p5SnapshotsAllRounds: p5g1.snapshotsByRound,
        p5StateKeyConsistent: p5g1.stateKeysByRound.every((k) => k === abG1T3.stateKey),
        p5SnapshotConsistent: p5g1.snapshotsByRound.every((s) => s === fixtureSnapshotSha('G1T3')),
        p5FinalPlanConsistent: p5g1.finalPlanConsistent,
        p5ModalFinalPlan: p5g1.modalFinalPlan,
        p5ModalExecuted: p5g1.modalExecuted,
        p5ExecutedFollowsFinalPlan: p5g1.finalPlanEqualsExecutedPrefix,
        p5FallbackRows: p5g1.fallbackRows,
        p5OverrideRows: p5g1.overrideRows,
      },
      replay: {
        realRuleSet: 'src/game/engine.ts createEngineRuleSet + preparedActions.generatePreparedSearchActions',
        plan: 'UUUL',
        ...g1t3e1.replay,
        applyPrefixCrossCheck: g1t3e1.applyPrefixCrossCheck,
      },
      certification: g1t3e1,
      quantifierContract: g1t3e1.contract,
      independentVerifier: {
        ...g1t3e1.verifier,
        noSurvivalFromNegation: true,
        note: 'mouseForce, catSurvive and catForce are three separate solves; survival requires a PROVEN catSurvive certificate, never !mouseForce.',
      },
      h1RrrrReuse: {
        ...reuse,
        note: 'H1 actual 100 ms plan RRRR is byte-identical in root identity and plan to the existing P4 certificate; P4 PROVEN evidence is reused, not recomputed.',
      },
      verdict: {
        e1UuulClass: g1t3e1.aggregatedClass,
        e1UuulProof: g1t3e1.proofStatus,
        e1UuulProvenMouseWin: e1MouseWinProven,
        h1RrrrClass: reuse.p4Class,
        h1RrrrProof: reuse.p4Proof,
        h1RrrrProvenCatSafe: h1CatSafeProven,
        PROVEN_100MS_TACTICAL_GAIN: proven100msTacticalGain,
        rule: 'TRUE only when E1 UUUL is a proven mouse forced win AND H1 RRRR is a proven cat-safe (survival or cat win) class; UNRESOLVED/CHANCE_DEPENDENT/CAT_SURVIVAL on E1 does not qualify.',
      },
    };
    writeFileSync(`${OUT}/G1T3_E1_100MS_CERTIFICATE.json`, JSON.stringify(g1t3Doc, null, 2));

    const additionalDoc = {
      artifactId: 'ADDITIONAL_100MS_PLAN_CERTIFICATES', round: ROUND,
      generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/erratum.test.ts`,
      head: HEAD, productionSourceChanged: false,
      purpose: 'Every actual 100 ms plan not already bound by a P4 certificate gets an independent quantifier certification. No 24-root search rerun.',
      contract: g1t3e1.contract,
      plans: additional,
    };
    writeFileSync(`${OUT}/ADDITIONAL_100MS_PLAN_CERTIFICATES.json`, JSON.stringify(additionalDoc, null, 2));

    // ---- final erratum results ----
    const correctedCountsData = metrics.correctedCounts;
    const allCertifiedPlans = [
      { rootId: 'G1T3', arm: 'E1', plan: 'UUUL', class: g1t3e1.aggregatedClass, proof: g1t3e1.proofStatus },
      { rootId: 'G1T3', arm: 'H1', plan: 'RRRR', class: reuse.p4Class, proof: reuse.p4Proof, reusedFromP4: true },
      ...additional.map((c) => ({ rootId: c.rootId, arm: c.arm, plan: c.planString, class: c.aggregatedClass, proof: c.proofStatus })),
    ];
    const results = {
      artifactId: 'ERRATUM_RESULTS', round: ROUND,
      generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/erratum.test.ts`,
      head: HEAD, fixtureSha256: FROZEN_FIXTURE_SHA,
      authorizations: {
        productionSourceChange: 'NO', gameRulesChange: 'NO', searchMathChange: 'NO',
        h1Change: 'NO', budgetChange: 'NO', full24RootRerun: 'NO', p5P6Rerun: 'NO', selfPlay: 'NO',
        commit: 'NO', push: 'NO', merge: 'NO',
      },
      p7Erratum: {
        p7Original: metrics.p7Original,
        correctedCounts: correctedCountsData,
        deltaVsP7: metrics.deltaVsP7,
        explanation: {
          bestAction: 'D1 selectedAction (root action selected by the fixed-depth comparison).',
          d1ExecutablePlan: 'D1 catTurnPlan[0]; plan comes from planBranches and may be replaced by the equal-primary extraction, so plan[0] can differ from bestAction.',
          actual100msPlan: 'P5 finalPlan[0] (post sidecar/guard); every P5 round executes a prefix identical to finalPlan.',
          error: 'P7 compared bestAction with the 100 ms executed first action. G5T1/E1 is the explicit counterexample: bestAction U, executable plan DLUTR, 100 ms actual plan DLUTR.',
          G5T1E1: { bestAction: 'U', d1ExecutablePlan: 'DLUTR', actual100msPlan: 'DLUTR', p7Comparison: 'U != D -> reported unreproduced', correctedComparison: 'D == D -> reproduced' },
        },
      },
      planCoverage: {
        combos: metrics.coverage.combos,
        certBindsActualPlanBeforeErratum: metrics.coverage.certBindsActualPlan,
        uncoveredBeforeErratum: metrics.coverage.uncovered,
        uncoveredNowCertified: allCertifiedPlans,
        afterErratumAll48Bound: true,
      },
      g1t3: {
        e1: { plan: 'UUUL', class: g1t3e1.aggregatedClass, proof: g1t3e1.proofStatus, certificate: `${OUT}/G1T3_E1_100MS_CERTIFICATE.json` },
        h1: { plan: 'RRRR', class: reuse.p4Class, proof: reuse.p4Proof, reused: true, reuseEligible: reuse.reuseEligible },
        e1UuulProvenMouseWin: e1MouseWinProven,
        h1RrrrProvenCatSafe: h1CatSafeProven,
        PROVEN_100MS_TACTICAL_GAIN: proven100msTacticalGain,
      },
      verdicts: {
        E1_G1T3_UUUL_quantifier: { class: g1t3e1.aggregatedClass, proof: g1t3e1.proofStatus },
        H1_G1T3_RRRR_quantifier: { class: reuse.p4Class, proof: reuse.p4Proof, source: 'P4 reused after identity match' },
        H1_real100msProvenTacticalBenefit: proven100msTacticalGain,
        PROVEN_100MS_TACTICAL_GAIN: proven100msTacticalGain,
        productionWiringAuthorized: false,
        performanceGate: 'Existing A/A calibration gate remains authoritative; no production wiring follows from a local tactical finding.',
      },
      identity: {
        fixtureSha256, head: HEAD,
        allOriginalsUnchanged: identityEqual(identityBefore, identityNow),
        allSourcesUnchanged: identityNow.sources.every((s, i) => s.sha256 === identityBefore.sources[i].sha256 && s.mtimeIso === identityBefore.sources[i].mtimeIso),
        sourceIdentityFile: `${OUT}/SOURCE_AND_ARTIFACT_IDENTITY.json`,
      },
    };
    writeFileSync(`${OUT}/ERRATUM_RESULTS.json`, JSON.stringify(results, null, 2));

    // ---- source & artifact identity (before/after, git, prior-seal anchors) ----
    const shaSumsText = readFileSync(`${PREV_OUT}/SHA256SUMS.txt`, 'utf8');
    const shaSums = new Map<string, string>();
    for (const line of shaSumsText.split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]{64})\s+(\d+)\s+(.+)$/);
      if (m) shaSums.set(m[3].replace(/\\/g, '/'), m[1]);
    }
    const priorSums = ORIGINAL_ARTIFACTS
      .map((p) => ({ path: p, relToPrev: p.startsWith(`${PREV_OUT}/`) ? p.slice(PREV_OUT.length + 1) : null }))
      .filter((x) => x.relToPrev && shaSums.has(x.relToPrev))
      .map((x) => {
        const now = fileIdentity(x.path).sha256;
        const recorded = shaSums.get(x.relToPrev!)!;
        return { path: x.path, recorded, now, matches: now === recorded };
      });
    const archivePath = 'F:/ppc-checkpoints/PPC-CAT-EVALUATOR-ABLATION-01-candidate.tar.gz';
    const archive = existsSync(archivePath) ? fileIdentity(archivePath) : null;
    const identityDoc = {
      artifactId: 'SOURCE_AND_ARTIFACT_IDENTITY', round: ROUND,
      generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/erratum.test.ts`,
      headFrozen: HEAD,
      headLive: git('git rev-parse HEAD'),
      gitSrcStatusPorcelain: git('git status --porcelain=v1 -- src'),
      gitSrcStatusLineCount: git('git status --porcelain=v1 -- src').split(/\r?\n/).filter(Boolean).length,
      gitSrcDiffStat: git('git diff --stat -- src'),
      workingTreeDiffersFromHead: git('git diff --quiet -- src; echo $?') !== '0' || git('git status --porcelain=v1 -- src').length > 0,
      preExistingPatchDisclosure: 'The working tree carries pre-existing uncommitted production patches that predate this erratum (same substrate as PPC-CAT-EVALUATOR-ABLATION-01). This erratum wrote no production source.',
      erratumStart: runStart,
      erratumEnd: new Date().toISOString(),
      productionSourceChanged: false,
      priorArtifactsOverwritten: false,
      fixture: {
        path: FIXTURE, sha256: fixtureSha256, frozenSha256: FROZEN_FIXTURE_SHA,
        matchesFrozen: fixtureSha256 === FROZEN_FIXTURE_SHA,
      },
      originalsBefore: identityBefore.originals,
      originalsAfter: identityNow.originals,
      originalsUnchanged: identityEqual(identityBefore, identityNow),
      originalsAgainstPriorSha256Sums: priorSums,
      allPriorSumsMatch: priorSums.every((x) => x.matches),
      sourcesBefore: identityBefore.sources,
      sourcesAfter: identityNow.sources,
      sourcesUnchanged: identityNow.sources.every((s, i) =>
        s.sha256 === identityBefore.sources[i].sha256 && s.bytes === identityBefore.sources[i].bytes && s.mtimeIso === identityBefore.sources[i].mtimeIso),
      sourcesPredateErratumStart: identityBefore.sources.every((s) => new Date(s.mtimeIso) < new Date(runStart)),
      archive: archive ? { path: archivePath, sha256: archive.sha256, bytes: archive.bytes, matchesSealRecord: archive.sha256 === 'd174a6a84c35fcf095179ccb4b05cd40cf530c09a50aaf669299d7d1e05ce4a4' } : null,
      crossArtifactG1T3: {
        fixtureSnapshotSha256: fixtureSnapshotSha('G1T3'),
        ablationSnapshotSha256: ablation.roots.find((r: any) => r.rootId === 'G1T3').snapshotSha256,
        p4E1SnapshotSha256: certs.combos.find((c: any) => c.rootId === 'G1T3' && c.arm === 'E1').snapshotSha256,
        p4H1SnapshotSha256: certs.combos.find((c: any) => c.rootId === 'G1T3' && c.arm === 'H1').snapshotSha256,
        p5Snapshots: p5ModalByCombo().get('G1T3/H1')!.snapshotsByRound,
        ablationStateKey: ablation.roots.find((r: any) => r.rootId === 'G1T3').stateKey,
        p5StateKeys: p5ModalByCombo().get('G1T3/H1')!.stateKeysByRound,
        allEqual: ablation.roots.find((r: any) => r.rootId === 'G1T3').snapshotSha256 === fixtureSnapshotSha('G1T3') &&
          certs.combos.find((c: any) => c.rootId === 'G1T3' && c.arm === 'H1').snapshotSha256 === fixtureSnapshotSha('G1T3'),
      },
      deliverables: ['ERRATUM.md', 'ERRATUM_RESULTS.json', 'CORRECTED_ROOT_TABLE.csv', 'G1T3_E1_100MS_CERTIFICATE.json', 'SOURCE_AND_ARTIFACT_IDENTITY.json', 'RESOURCE_SAFETY_LOG.md'],
    };
    writeFileSync(`${OUT}/SOURCE_AND_ARTIFACT_IDENTITY.json`, JSON.stringify(identityDoc, null, 2));

    writeFileSync(`${OUT}/_raw/run_timing.json`, JSON.stringify({
      runStart, runEnd: new Date().toISOString(),
      g1t3CertElapsedMs: g1t3e1.elapsedMs,
      additionalCertElapsedMs: additional.map((c) => ({ rootId: c.rootId, arm: c.arm, plan: c.planString, elapsedMs: c.elapsedMs })),
      totalCertElapsedMs: g1t3e1.elapsedMs + additional.reduce((n, c) => n + c.elapsedMs, 0),
    }, null, 2));

    console.log('[T2] G1T3/E1 UUUL =', g1t3e1.aggregatedClass, g1t3e1.proofStatus,
      'branches=', g1t3e1.branches.length, 'certs=', g1t3e1.certificateCount, `elapsed=${g1t3e1.elapsedMs}ms`);
    console.log('[T2] H1/G1T3 RRRR reuse =', reuse.reuseDecision, reuse.p4Class, reuse.p4Proof);
    console.log('[T2] additional certified:', additional.map((c) => `${c.rootId}/${c.arm}:${c.planString}=${c.aggregatedClass}/${c.proofStatus}`).join(' '));
    console.log('[T2] PROVEN_100MS_TACTICAL_GAIN =', proven100msTacticalGain);

    expect(g1t3e1.branches.length).toBeGreaterThan(0);
    expect(additional.length).toBe(uncovered.length - 1);
    expect(identityDoc.originalsUnchanged).toBe(true);
    expect(identityDoc.sourcesUnchanged).toBe(true);
  }, 3_600_000);
});
