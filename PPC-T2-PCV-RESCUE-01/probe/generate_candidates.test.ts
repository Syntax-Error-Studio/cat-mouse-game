/// <reference types="node" />
/**
 * Step 1 — generate and FREEZE candidate plans BEFORE any quantifier proof.
 *
 * Source: OFFLINE_REGENERATED_D1 (P5 rows carry no planBranches/alternative
 * plans). One fixed D1 EXACT search per frozen stratum (TT/AB/ordering OFF,
 * full window, real legal order). For every root action, the continuation is
 * walked from the SAME search's planBranches; a fresh exact-D1 search is used
 * only when a branch key is missing. Plans are replay-validated, then sorted by
 * the frozen pre-declared order and at most 2 per stratum are kept.
 *
 * No H0/H1 proof is run here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  ROUND, OUT, HEAD, FIXTURE, FIXTURE_SHA, P5_PATH, P5_SHA, KERNEL, T1_PROOF,
  T1_OBS, T1_REPORT, T1_MANIFEST, T1_CERT, T1_AMENDMENT, PREREG, D1_FROZEN,
  PREPARED, EXPECTIMINIMAX, ENGINE, GAMEPLAY, CAND_MAX,
  hashFile, sha256, generateCandidateDoc, writeCandidateDoc,
} from './rescue_lib';
import { execFileSync } from 'node:child_process';

describe('PPC-T2 candidate generation (frozen before proofs)', () => {
  it('identity gate + frozen D1 candidate list', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    const checks = {
      head: head === HEAD,
      branch: branch === 'ppc/p1-id-state-identity-fix',
      fixture: hashFile(FIXTURE) === FIXTURE_SHA,
      p5: hashFile(P5_PATH) === P5_SHA,
      kernel: hashFile(KERNEL) === '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b',
      prepared: hashFile(PREPARED) === '67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764',
      expectiminimax: hashFile(EXPECTIMINIMAX) === '50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c',
      engine: hashFile(ENGINE) === '099f9a7b6d97b838c664aa7186be58465e5b01b8052af4b4e4e19a5644d19f06',
      gameplay: hashFile(GAMEPLAY) === 'e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34',
      preregPresent: hashFile(PREREG) === '3dd79a40fda42af91056c3662fbb92ae0ad0da2c9fa9e50670eea139f3b06bfc',
      t1ProofPresent: hashFile(T1_PROOF) === '3ccef93d914b4c1702078bcaafd612386bd5d953b70d729ccba3825ab1c272ca',
      t1ObsPresent: hashFile(T1_OBS) === '2a7c44f73e86a6cb663f4018a8b573b73f17bffe500e9c04e3d823df8510ebc3',
      t1ManifestPresent: hashFile(T1_MANIFEST) === '01f39e30be90b422f3cc6108a1373f85eed981a31b482b5df2a89797cf84f133',
      t1CertPresent: hashFile(T1_CERT) === 'd1c9dd49e3d889b06a0a148e82a3d6303628b19a9a084d005c08d1eeaf476f4e',
      t1ReportPresent: hashFile(T1_REPORT) === '6b5702f779663b5086f5340ea5ed7e6508a7a666a3399b2dc6d68774a675776b',
      t1AmendmentPresent: hashFile(T1_AMENDMENT) === 'a7fccf0c0020751f6b5bb67b869345c604ac4b970baee47a0c1a13523b473f7a',
    };
    console.log('T2_IDENTITY', JSON.stringify(checks));
    // d1 frozen hash is verified by the frozen P5 manifest chain; report it rather than hardcode a guess.
    const d1Sha = hashFile(D1_FROZEN);
    console.log('D1_FROZEN_SHA', d1Sha);
    expect(checks.head && checks.branch && checks.fixture && checks.p5 && checks.kernel
      && checks.prepared && checks.expectiminimax && checks.engine && checks.gameplay
      && checks.preregPresent && checks.t1ProofPresent && checks.t1ObsPresent
      && checks.t1ManifestPresent && checks.t1CertPresent && checks.t1ReportPresent
      && checks.t1AmendmentPresent).toBe(true);

    const t0 = performance.now();
    const doc = generateCandidateDoc();
    const frozen = writeCandidateDoc(doc);
    mkdirSync(`${OUT}/_raw`, { recursive: true });
    writeFileSync(`${OUT}/_raw/candidate_generation_summary.json`, JSON.stringify({
      round: ROUND, frozen, elapsedMs: Number((performance.now() - t0).toFixed(2)),
      strata: doc.strata.map((s) => ({
        rootId: s.rootId, arm: s.arm, originalPlan: s.originalPlan,
        candidateCount: s.candidateCount, insufficientReason: s.insufficientReason,
        candidates: s.candidates.map((c) => ({
          plan: c.planString, rootAction: c.rootAction, value: c.rootValue,
          firstStepDifferent: c.firstStepDifferent, source: c.continuationSource,
          postStateKeys: c.postStateKeys, boundary: c.boundary, replayStatus: c.replayStatus,
        })),
        attempted: s.attempted.map((a) => ({
          rootAction: a.rootAction, plan: a.planString, eligible: a.eligible,
          rejectReason: a.rejectReason, replayStatus: a.replayStatus, walkStopped: a.walkStopped,
        })),
      })),
    }, null, 1));

    const raw = readFileSync(`${OUT}/CANDIDATE_PLANS.json`);
    expect(sha256(raw)).toBe(frozen.fileSha256);
    const reread = JSON.parse(raw.toString('utf8'));
    expect(reread.method.proofsRun).toBe(false);
    expect(reread.strata.length).toBe(8);
    for (const s of reread.strata) {
      expect(s.candidates.length).toBeLessThanOrEqual(CAND_MAX);
      for (const c of s.candidates) {
        expect(c.planString).not.toBe(s.originalPlan);
        expect(c.bindingOk).toBe(true);
        expect(c.replayStatus).toBe('VALID_MOUSE_FRONTIER');
        expect(c.postStateKeys.length).toBeGreaterThan(0);
      }
      if (s.candidates.length > 1) {
        // Frozen order: distinct-first-step candidates must precede same-first-step ones.
        const firstDiff = s.candidates.map((c: { firstStepDifferent: boolean }) => c.firstStepDifferent);
        expect(firstDiff[0]).toBe(true);
      }
    }
    console.log('CANDIDATE_FREEZE', JSON.stringify({
      sha256: frozen.fileSha256, bytes: frozen.bytes,
      counts: reread.strata.map((s: { rootId: string; arm: string; candidateCount: number }) => `${s.rootId}/${s.arm}=${s.candidateCount}`),
    }));
    expect(doc.strata.reduce((n, s) => n + s.candidateCount, 0)).toBeGreaterThan(0);
  }, 1_800_000);
});
