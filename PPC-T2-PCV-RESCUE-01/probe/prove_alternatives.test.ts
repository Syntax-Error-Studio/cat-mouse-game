/// <reference types="node" />
/**
 * Step 2 — quantifier proofs for the FROZEN candidate list.
 *
 * Reads CANDIDATE_PLANS.json (must match _raw/CANDIDATE_FREEZE.json) and runs,
 * strictly serially per candidate:
 *   H0 mouseForce  H=1 startIdx=1 cap=600000
 *   H1 catSurvive  H=2 startIdx=1 cap=5000   (only if H0 was NOT proven-refuted)
 * Every `true` is followed by the independent verifier. No target/timing is
 * optimized; no candidate is dropped.
 *
 * Also re-binds the 8 T1 baseline mouseForce certificates to the replayed
 * original plans and re-runs the independent verifier on them.
 *
 * Fresh process per repetition: RESCUE_REP=1|2 -> _raw/proof_repN.json.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  ROUND, OUT, HEAD, FIXTURE, FIXTURE_SHA, P5_PATH, P5_SHA, KERNEL, T1_PROOF,
  PREPARED, EXPECTIMINIMAX, ENGINE, GAMEPLAY, QCAP, H1_CAP,
  sha256, hashFile, loadRoot, t1Proof, FROZEN_STRATA,
  replayPlan, applyPrefix, runSolve, stateKey,
  andOverBranches, allVerified, brief,
} from './rescue_lib';
import type { SolveRecord } from '../../PPC-T1-PCV-01/probe/pcv_lib';
import { verifyMouseCertificate } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

const REP = Number(process.env.RESCUE_REP ?? '1');
const CAND_PATH = `${OUT}/CANDIDATE_PLANS.json`;
const FREEZE_PATH = `${OUT}/_raw/CANDIDATE_FREEZE.json`;
const RAW_PATH = `${OUT}/_raw/proof_rep${REP}.json`;

interface CertEntry {
  value: boolean | null; proofStatus: string; nodes: number; chanceNodes: number;
  chanceOutcomes: number; truncated: boolean; verifyVerdict: string | null;
  verifyLeaves: number | null; verifyMs: number | null; policyMisses: number | null;
  certHash: string; policyEntries: [string, string][] | null;
}

const certHashOf = (r: SolveRecord, postKeys: string[]) => sha256(JSON.stringify({
  mode: r.mode, H: r.H, startIdx: r.startIdx, cap: r.cap,
  value: r.value, proofStatus: r.proofStatus, nodes: r.nodes,
  chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
  postKeys, policy: r.policyEntries,
}));

const withCert = (r: SolveRecord, postKeys: string[]) => ({
  ...brief(r),
  mode: r.mode, H: r.H, startIdx: r.startIdx, cap: r.cap,
  policySize: r.policySize,
  policyEntries: r.policyEntries,
  certHash: r.value === true ? certHashOf(r, postKeys) : null,
});

describe(`PPC-T2 rescue proofs rep ${REP}`, () => {
  it('baseline re-verification + frozen candidate H0/H1', () => {
    // ---- identity gates -------------------------------------------------
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    const ident = {
      head: head === HEAD,
      branch: branch === 'ppc/p1-id-state-identity-fix',
      fixture: hashFile(FIXTURE) === FIXTURE_SHA,
      p5: hashFile(P5_PATH) === P5_SHA,
      kernel: hashFile(KERNEL) === '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b',
      prepared: hashFile(PREPARED) === '67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764',
      expectiminimax: hashFile(EXPECTIMINIMAX) === '50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c',
      engine: hashFile(ENGINE) === '099f9a7b6d97b838c664aa7186be58465e5b01b8052af4b4e4e19a5644d19f06',
      gameplay: hashFile(GAMEPLAY) === 'e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34',
      t1Proof: hashFile(T1_PROOF) === '3ccef93d914b4c1702078bcaafd612386bd5d953b70d729ccba3825ab1c272ca',
    };
    console.log(`REP${REP}_IDENTITY`, JSON.stringify(ident));
    expect(Object.values(ident).every(Boolean)).toBe(true);

    // ---- frozen candidate list -----------------------------------------
    const candRaw = readFileSync(CAND_PATH);
    const freeze = JSON.parse(readFileSync(FREEZE_PATH, 'utf8'));
    const candSha = sha256(candRaw);
    console.log(`REP${REP}_CANDIDATE_FREEZE`, JSON.stringify({
      sha256: candSha, expected: freeze.sha256, bytes: candRaw.length, same: candSha === freeze.sha256,
    }));
    expect(candSha).toBe(freeze.sha256);
    const candDoc = JSON.parse(candRaw.toString('utf8'));
    expect(candDoc.method.proofsRun).toBe(false);
    expect(candDoc.strata.length).toBe(8);

    mkdirSync(`${OUT}/_raw`, { recursive: true });
    const t0 = performance.now();
    let verifyFailures = 0;
    let falseProven = 0;
    let planIdentityFailures = 0;

    // ---- baseline: bind T1 certificates to replayed original plans ------
    const baseline: Record<string, unknown>[] = [];
    for (const frozen of FROZEN_STRATA) {
      const t1 = t1Proof.strata.find((s) => s.rootId === frozen.rootId && s.arm === frozen.arm);
      if (!t1) throw new Error(`T1 stratum missing: ${frozen.rootId}/${frozen.arm}`);
      const root = loadRoot(frozen.rootId);
      const chars = [...frozen.plan];
      const pre = applyPrefix(root, chars, 0);
      const rep = replayPlan(root, chars);
      const postKeys = pre.states.map((s) => stateKey(s));
      const keyBind = pre.ok && postKeys.slice().sort().every((k, i) => k === t1.postStateKeys.slice().sort()[i])
        && postKeys.length === t1.postStateKeys.length;
      if (!keyBind) planIdentityFailures++;
      const wrapped = (t1.certificates.mouseForce_H0 ?? {}) as Record<string, CertEntry[]>;
      const entries = Object.values(wrapped).flat();
      const branchChecks = pre.states.map((s, i) => {
        const e = entries[i];
        if (!e) {
          verifyFailures++;
          return { branch: i, present: false, verifyVerdict: 'MISSING_CERT', policyMisses: null, certHashMatch: false };
        }
        const policy = new Map(e.policyEntries ?? []);
        const v = verifyMouseCertificate(s, policy, 1, 1, QCAP);
        const recomputed = sha256(JSON.stringify({
          mode: 'mouseForce', H: 1, startIdx: 1, cap: QCAP,
          value: e.value, proofStatus: e.proofStatus, nodes: e.nodes,
          chanceNodes: e.chanceNodes, chanceOutcomes: e.chanceOutcomes,
          postKeys, policy: e.policyEntries,
        }));
        const certHashMatch = recomputed === e.certHash;
        if (v.verdict !== 'PROVEN' || (v.policyMisses ?? 0) > 0) verifyFailures++;
        if (e.proofStatus === 'PROVEN' && v.verdict !== 'PROVEN') falseProven++;
        if (!certHashMatch) planIdentityFailures++;
        return {
          branch: i, present: true,
          value: e.value, proofStatus: e.proofStatus, truncated: e.truncated,
          nodes: e.nodes, chanceNodes: e.chanceNodes, chanceOutcomes: e.chanceOutcomes,
          certHashRecorded: e.certHash, certHashRecomputed: recomputed, certHashMatch,
          verifyVerdict: v.verdict, verifyLeaves: v.leaves, verifyMs: Number(v.elapsedMs.toFixed(3)),
          policyMisses: v.policyMisses, policyEntries: e.policyEntries,
        };
      });
      const certified = branchChecks.every((b) => b.present && b.proofStatus === 'PROVEN'
        && b.verifyVerdict === 'PROVEN' && b.policyMisses === 0 && !b.truncated && b.certHashMatch);
      baseline.push({
        rootId: frozen.rootId, arm: frozen.arm, originalPlan: frozen.plan,
        rootStateKey: stateKey(root), postStateKeys: postKeys,
        t1RootStateKey: t1.rootStateKey, t1PostStateKeys: t1.postStateKeys,
        bindingOk: keyBind, replayStatus: rep.status, replayOk: rep.ok,
        certEntries: entries.length, branchChecks, certified,
      });
    }

    // ---- alternatives: frozen list, serial H0 then conditional H1 -------
    const candidateResults: Record<string, unknown>[] = [];
    for (const stratum of candDoc.strata) {
      const root = loadRoot(stratum.rootId);
      for (const c of stratum.candidates) {
        const chars = [...c.planChars];
        const pre = applyPrefix(root, chars, 0);
        const rep = replayPlan(root, chars);
        const postKeys = pre.states.map((s) => stateKey(s));
        const bindingOk = pre.ok && postKeys.length === c.postStateKeys.length
          && postKeys.slice().sort().every((k, i) => k === c.postStateKeys.slice().sort()[i]);
        const replayOk = rep.ok && rep.status === 'VALID_MOUSE_FRONTIER' && rep.applyPrefixCrossCheck;
        if (!bindingOk || !replayOk) planIdentityFailures++;

        const h0Recs: SolveRecord[] = pre.states.map((s) => runSolve(s, 'mouseForce', 1, 1, QCAP, QCAP));
        const h0Agg = andOverBranches(h0Recs);
        const h0Refuted = h0Agg === true && allVerified(h0Recs);
        for (const r of h0Recs) {
          if (r.proofStatus === 'PROVEN' && r.verifyVerdict !== 'PROVEN') falseProven++;
          if (r.verify && (r.verify.verdict !== 'PROVEN' || (r.verify.policyMisses ?? 0) > 0)) verifyFailures++;
        }
        const h0SolveMs = h0Recs.reduce((n, r) => n + r.solveElapsedMs, 0);
        const h0VerifyMs = h0Recs.reduce((n, r) => n + (r.verify?.elapsedMs ?? 0), 0);
        const h0 = {
          ran: true, mode: 'mouseForce', H: 1, startIdx: 1, cap: QCAP,
          branchCount: pre.states.length, aggregate: h0Agg, refuted: h0Refuted,
          status: h0Refuted ? 'ALTERNATIVE_REFUTED_H0'
            : h0Agg === false ? 'NO_H0_MOUSE_FORCE_PROVEN'
              : 'UNRESOLVED_H0',
          solveMs: Number(h0SolveMs.toFixed(3)), verifyMs: Number(h0VerifyMs.toFixed(3)),
          totalMs: Number((h0SolveMs + h0VerifyMs).toFixed(3)),
          within25ms: h0SolveMs + h0VerifyMs <= 25,
          phase1SolveCompliant: h0Recs.every((r) => r.nodes <= 5000 && r.solveElapsedMs <= 20),
          records: h0Recs.map((r) => withCert(r, postKeys)),
        };

        let h1: Record<string, unknown> | null = null;
        if (!h0Refuted) {
          const h1Recs: SolveRecord[] = pre.states.map((s) => runSolve(s, 'catSurvive', 2, 1, H1_CAP, QCAP));
          const h1Agg = andOverBranches(h1Recs);
          const h1Certified = h1Agg === true && allVerified(h1Recs);
          for (const r of h1Recs) {
            if (r.proofStatus === 'PROVEN' && r.verifyVerdict !== 'PROVEN') falseProven++;
            if (r.verify && (r.verify.verdict !== 'PROVEN' || (r.verify.policyMisses ?? 0) > 0)) verifyFailures++;
          }
          const h1SolveMs = h1Recs.reduce((n, r) => n + r.solveElapsedMs, 0);
          const h1VerifyMs = h1Recs.reduce((n, r) => n + (r.verify?.elapsedMs ?? 0), 0);
          h1 = {
            ran: true, mode: 'catSurvive', H: 2, startIdx: 1, cap: H1_CAP,
            branchCount: pre.states.length, aggregate: h1Agg, certified: h1Certified,
            status: h1Certified ? 'ALTERNATIVE_SURVIVAL_CERTIFIED_H1'
              : h1Agg === false ? 'H1_SURVIVAL_NOT_PROVEN'
                : 'UNRESOLVED_H1',
            solveMs: Number(h1SolveMs.toFixed(3)), verifyMs: Number(h1VerifyMs.toFixed(3)),
            totalMs: Number((h1SolveMs + h1VerifyMs).toFixed(3)),
            within25ms: h1SolveMs + h1VerifyMs <= 25,
            phase1SolveCompliant: h1Recs.every((r) => r.nodes <= 5000 && r.solveElapsedMs <= 20),
            records: h1Recs.map((r) => withCert(r, postKeys)),
          };
        }

        const rescueCandidate = !!h1 && (h1 as { certified: boolean }).certified === true;
        const classify = h0Refuted ? 'ALTERNATIVE_REFUTED_H0'
          : rescueCandidate ? 'ALTERNATIVE_SURVIVAL_CERTIFIED_H1'
            : (h1 as { status: string }).status;
        candidateResults.push({
          candidateId: c.candidateId, rootId: c.rootId, arm: c.arm,
          originalPlan: c.originalPlan, planString: c.planString, planChars: c.planChars,
          planHash: c.planHash, candidateHash: c.candidateHash,
          rootAction: c.rootAction, rootActionLegalIndex: c.rootActionLegalIndex,
          rootValue: c.rootValue, firstStepDifferent: c.firstStepDifferent,
          continuationSource: c.continuationSource,
          postStateKeys: postKeys, candidatePostStateKeys: c.postStateKeys,
          boundary: c.boundary, bindingOk, replayOk, replayStatus: rep.status,
          replayBranches: rep.branches.length, replaySteps: rep.steps,
          h0, h1, rescueCandidate, classify,
          totalMs: Number(((h0.totalMs as number) + ((h1?.totalMs as number) ?? 0)).toFixed(3)),
        });
        const h1LogRecs = h1 ? (h1.records as { proofStatus: string }[]) : [];
        console.log(`REP${REP}_CAND ${c.candidateId} plan=${c.planString} ` +
          `H0=${h0.status}(${h0.aggregate},${h0.records.map((r) => r.proofStatus).join('|')}) ` +
          `H1=${h1 ? `${h1.status}(${h1.aggregate},${h1LogRecs.map((r) => r.proofStatus).join('|')})` : 'SKIPPED'}`);
      }
    }

    const mem = process.memoryUsage();
    const raw = {
      round: ROUND, rep: REP, generatedAt: new Date().toISOString(),
      head: HEAD, fixtureSha256: FIXTURE_SHA, candidateFileSha256: candSha,
      protocol: {
        candidateSource: 'OFFLINE_REGENERATED_D1', candidateMaxPerStratum: 2,
        h0: { mode: 'mouseForce', H: 1, startIdx: 1, cap: QCAP },
        h1: { mode: 'catSurvive', H: 2, startIdx: 1, cap: H1_CAP, onlyIfNotH0Refuted: true },
        verifierCap: QCAP, independentVerifier: true, serial: true,
        phase1TimingDefinition: 'solve-only: nodes<=5000 && solveElapsedMs<=20; verifier excluded and recorded separately',
        noMainSearchRerun: true, noProductionChange: true,
      },
      baseline,
      candidates: candidateResults,
      summary: {
        candidatesProcessed: candidateResults.length,
        verifyFailures, falseProven, planIdentityFailures,
        h0Refuted: candidateResults.filter((r) => r.classify === 'ALTERNATIVE_REFUTED_H0').length,
        h1Certified: candidateResults.filter((r) => r.rescueCandidate).length,
        h1False: candidateResults.filter((r) => (r.h1 as { aggregate?: boolean | null } | null)?.aggregate === false).length,
        h1Unresolved: candidateResults.filter((r) => (r.h1 as { aggregate?: boolean | null } | null)?.aggregate === null).length,
      },
      resource: { rssMB: Number((mem.rss / 1048576).toFixed(1)), heapUsedMB: Number((mem.heapUsed / 1048576).toFixed(1)) },
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
    };
    writeFileSync(RAW_PATH, JSON.stringify(raw, null, 1));
    console.log(`REP${REP}_SUMMARY`, JSON.stringify(raw.summary));
    console.log(`REP${REP}_RESOURCE`, JSON.stringify(raw.resource), 'elapsedMs', raw.elapsedMs);

    expect(raw.baseline.length).toBe(8);
    expect(candidateResults.length).toBe(candDoc.strata.reduce((n: number, s: { candidates: unknown[] }) => n + s.candidates.length, 0));
    expect(verifyFailures).toBe(0);
    expect(falseProven).toBe(0);
    expect(planIdentityFailures).toBe(0);
    expect(raw.baseline.every((b) => (b as { certified: boolean }).certified)).toBe(true);
  }, 3_600_000);
});
