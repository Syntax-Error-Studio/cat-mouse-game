/// <reference types="node" />
/**
 * Step 2 — H0 tail proofs and T4 certificate reuse.
 *
 * Unique frontiers only:
 *   G2T8/LDDR (T1+T2 full-state shared) -> one H0 proof
 *   G1T9/E1/RLLL (T3)                   -> one H0 proof
 * T4/G1T9/H1/RDLD matches the already-proven T2 UDDD state -> no re-solve;
 * independent verifier is re-run on the RDLD state with the UDDD policy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { verifyMouseCertificate } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import {
  ROUND, OUT, HEAD, BRANCH, T2_CANDIDATES, T2_CANDIDATES_SHA, T2_ALT, T2_ALT_SHA,
  QCAP, H1_CAP, PHASE1_NODE_CAP, PHASE1_SOLVE_MS,
  sha256, hashFile, identityGate, loadRoot, replayIdentity, stateKey, runSolve,
  stateIdentity, compareStates, withCert, allTrueVerified, certHashOf,
} from './tail_lib';
import type { GameEngineState } from '../../src/game/engine';
import type { SolveRecord } from '../../PPC-T1-PCV-01/probe/pcv_lib';

const REP = Number(process.env.TAIL_REP ?? '1');
const CAND_PATH = `${OUT}/TAIL_CANDIDATES.json`;
const AUDIT_PATH = `${OUT}/TAIL_DEDUP_AUDIT.json`;
const FREEZE_PATH = `${OUT}/_raw/TAIL_CANDIDATE_FREEZE.json`;
const RAW_PATH = `${OUT}/TAIL_PROOF_REP${REP}.json`;

interface TailRecord {
  recordId: string; rootId: string; arm: 'E1' | 'H1'; planString: string;
  planHash: string; rootStateKey: string; postStateKey: string; postStateKeys: string[];
  postSnapshotSha256: string; dedupGroupId: string;
  replay: { status: string; bindingOk: boolean; applyPrefixCrossCheck: boolean };
  chance: { chance: boolean; kind: string; branchCount: number; probabilities: number[]; allPositive: boolean; sumWeights: number };
  reuse: Record<string, unknown> | null;
}
interface CandidateDoc {
  records: TailRecord[];
  groups: Record<string, unknown>;
  summary: { uniqueFrontiers: number; reusedCertificates: number; actualMatchesExpected: boolean };
  proofsRunBeforeFreeze: boolean;
}
interface Freeze {
  candidates: { sha256: string; bytes: number };
  audit: { sha256: string; bytes: number };
  proofsRunBeforeFreeze: boolean;
}
interface H0Group {
  groupId: string; mode: 'mouseForce'; H: number; startIdx: number; cap: number;
  branchCount: number; postStateKeys: string[];
  records: ReturnType<typeof withCert>[];
  aggregate: boolean | null; refuted: boolean;
  status: string; solveMs: number; verifyMs: number; totalMs: number;
  within25ms: boolean;
}
interface H1Group {
  groupId: string; mode: 'catSurvive'; H: number; startIdx: number; cap: number;
  branchCount: number; postStateKeys: string[];
  records: ReturnType<typeof withCert>[];
  aggregate: boolean | null; certified: boolean;
  status: string; solveMs: number; verifyMs: number; totalMs: number;
  within25ms: boolean;
  phase1Gate: { solveOnly: true; nodesAtMost5000: boolean; solveAtMost20ms: boolean; passed: boolean };
}

function proveH0(groupId: string, states: GameEngineState[], postKeys: string[]): H0Group {
  const recs: SolveRecord[] = states.map((s) => runSolve(s, 'mouseForce', 1, 1, QCAP, QCAP));
  const certs = recs.map((r) => withCert(r, postKeys));
  const aggregate = recs.some((r) => r.value === false) ? false
    : recs.some((r) => r.value === null) ? null
      : true;
  const refuted = aggregate === true && allTrueVerified(recs);
  const solveMs = recs.reduce((n, r) => n + r.solveElapsedMs, 0);
  const verifyMs = recs.reduce((n, r) => n + (r.verify?.elapsedMs ?? 0), 0);
  return {
    groupId, mode: 'mouseForce', H: 1, startIdx: 1, cap: QCAP,
    branchCount: states.length, postStateKeys: postKeys, records: certs,
    aggregate, refuted,
    status: refuted ? 'ALTERNATIVE_REFUTED_H0'
      : aggregate === false ? 'NO_H0_MOUSE_FORCE_PROVEN' : 'UNRESOLVED_H0',
    solveMs: Number(solveMs.toFixed(3)), verifyMs: Number(verifyMs.toFixed(3)),
    totalMs: Number((solveMs + verifyMs).toFixed(3)), within25ms: solveMs + verifyMs <= 25,
  };
}

function proveH1(groupId: string, states: GameEngineState[], postKeys: string[]): H1Group {
  const recs: SolveRecord[] = states.map((s) => runSolve(s, 'catSurvive', 2, 1, H1_CAP, QCAP));
  const certs = recs.map((r) => withCert(r, postKeys));
  const aggregate = recs.some((r) => r.value === false) ? false
    : recs.some((r) => r.value === null) ? null
      : true;
  const nodesAtMost5000 = recs.every((r) => r.nodes <= PHASE1_NODE_CAP);
  const solveAtMost20ms = recs.every((r) => r.solveElapsedMs <= PHASE1_SOLVE_MS);
  const phase1Passed = recs.every((r) => r.withinPhase1) && nodesAtMost5000 && solveAtMost20ms;
  const certified = aggregate === true && allTrueVerified(recs) && phase1Passed;
  const solveMs = recs.reduce((n, r) => n + r.solveElapsedMs, 0);
  const verifyMs = recs.reduce((n, r) => n + (r.verify?.elapsedMs ?? 0), 0);
  return {
    groupId, mode: 'catSurvive', H: 2, startIdx: 1, cap: H1_CAP,
    branchCount: states.length, postStateKeys: postKeys, records: certs,
    aggregate, certified,
    status: certified ? 'ALTERNATIVE_SURVIVAL_CERTIFIED_H1'
      : aggregate === false ? 'H1_SURVIVAL_NOT_PROVEN' : 'UNRESOLVED_H1',
    solveMs: Number(solveMs.toFixed(3)), verifyMs: Number(verifyMs.toFixed(3)),
    totalMs: Number((solveMs + verifyMs).toFixed(3)), within25ms: solveMs + verifyMs <= 25,
    phase1Gate: {
      solveOnly: true, nodesAtMost5000, solveAtMost20ms, passed: phase1Passed,
    },
  };
}

describe(`PPC-T2 tail proofs rep ${REP}`, () => {
  it('H0 unique frontiers + T4 UDDD reuse verification, serial', () => {
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    const gate = identityGate();
    console.log(`TAIL_REP${REP}_IDENTITY`, JSON.stringify(gate));
    expect(Object.values(gate).every(Boolean)).toBe(true);

    const cRaw = readFileSync(CAND_PATH);
    const aRaw = readFileSync(AUDIT_PATH);
    const freeze = JSON.parse(readFileSync(FREEZE_PATH, 'utf8')) as Freeze;
    const cSha = sha256(cRaw);
    const aSha = sha256(aRaw);
    const freezeOk = cSha === freeze.candidates.sha256 && aSha === freeze.audit.sha256
      && freeze.proofsRunBeforeFreeze === false && cRaw.length === freeze.candidates.bytes
      && aRaw.length === freeze.audit.bytes;
    console.log(`TAIL_REP${REP}_FREEZE`, JSON.stringify({
      candidatesSha256: cSha, expected: freeze.candidates.sha256, bytes: cRaw.length,
      auditSha256: aSha, auditExpected: freeze.audit.sha256, auditBytes: aRaw.length,
      proofsRunBeforeFreeze: freeze.proofsRunBeforeFreeze, freezeOk,
    }));
    expect(freezeOk).toBe(true);

    const doc = JSON.parse(cRaw.toString('utf8')) as CandidateDoc;
    expect(doc.records.length).toBe(4);
    expect(doc.summary.uniqueFrontiers).toBe(2);
    expect(doc.summary.reusedCertificates).toBe(1);
    expect(doc.summary.actualMatchesExpected).toBe(true);
    expect(doc.proofsRunBeforeFreeze).toBe(false);

    const audit = JSON.parse(aRaw.toString('utf8'));
    let identityMismatches = 0;
    let verifyFailures = 0;
    let falseProven = 0;

    // ---- identity re-audit on fresh states --------------------------------
    const replayed: Record<string, { state: GameEngineState; postKeys: string[]; canonicalSha: string }> = {};
    const identityRecords: Record<string, unknown>[] = [];
    for (const r of doc.records) {
      const root = loadRoot(r.rootId);
      const rep = replayIdentity(root, r.planString);
      const state = rep.branches[0]?.state;
      const postKeys = rep.postStateKeys;
      const keyMatch = postKeys.length === r.postStateKeys.length
        && postKeys.slice().sort().every((k, i) => k === r.postStateKeys.slice().sort()[i]);
      const shaMatch = !!state && stateIdentity(state).canonicalSha256 === r.postSnapshotSha256;
      const replayMatch = rep.ok && rep.status === 'VALID_MOUSE_FRONTIER'
        && rep.bindingOk && rep.applyPrefixCrossCheck;
      if (!keyMatch || !shaMatch || !replayMatch || postKeys.length !== 1) identityMismatches++;
      if (!state) throw new Error(`missing replayed state ${r.recordId}`);
      if (!rep.chance.allPositive || rep.chance.sumWeights !== 1) identityMismatches++;
      replayed[r.recordId] = { state, postKeys, canonicalSha: stateIdentity(state).canonicalSha256 };
      identityRecords.push({
        recordId: r.recordId, rootId: r.rootId, arm: r.arm, plan: r.planString,
        replayStatus: rep.status, keyMatch, canonicalHashMatch: shaMatch,
        canonicalSha256: stateIdentity(state).canonicalSha256,
        postStateKey: stateKey(state), postKeys, chance: rep.chance,
        dedupGroupId: r.dedupGroupId,
      });
    }

    const g2 = compareStates(replayed.T1.state, replayed.T2.state);
    const g2Root = compareStates(loadRoot('G2T8'), loadRoot('G2T8'));
    if (!g2.equal || !g2.stateKeyEqual || g2.differences.length > 0) identityMismatches++;
    if (!g2Root.equal || g2Root.differences.length > 0) identityMismatches++;
    console.log(`TAIL_REP${REP}_G2T8_IDENTITY`, JSON.stringify({
      postEqual: g2.equal, postStateKeyEqual: g2.stateKeyEqual,
      postDifferences: g2.differences.length, rootEqual: g2Root.equal,
      canonicalSha256: [g2.aSha256, g2.bSha256],
    }));

    // ---- T4 vs T2 UDDD identity and certificate reuse ---------------------
    const t2Alt = JSON.parse(readFileSync(T2_ALT, 'utf8'));
    const source = t2Alt.candidates.find((c: { candidateId: string }) => c.candidateId === 'G1T9/H1/C2');
    if (!source || source.planString !== 'UDDD') throw new Error('T2 UDDD source missing');
    const sourceCert = source.h0.records[0];
    if (!sourceCert) throw new Error('T2 UDDD certificate missing');
    const uddd = replayIdentity(loadRoot('G1T9'), 'UDDD');
    const t4Compare = compareStates(replayed.T4.state, uddd.branches[0].state);
    const sourcePostKeyMatch = source.postStateKeys.length === 1
      && source.postStateKeys[0] === replayed.T4.postKeys[0]
      && source.postStateKeys[0] === uddd.postStateKey;
    if (!t4Compare.equal || !t4Compare.stateKeyEqual || t4Compare.differences.length > 0 || !sourcePostKeyMatch) {
      identityMismatches++;
    }
    const policy = new Map<string, string>(sourceCert.policyEntries ?? []);
    if (!sourceCert.policyEntries || sourceCert.policyEntries.length === 0) {
      throw new Error('T2 UDDD certificate has no policy entries');
    }
    const verify = verifyMouseCertificate(replayed.T4.state, policy, 1, 1, QCAP);
    const certHashRecomputed = sha256(JSON.stringify({
      mode: 'mouseForce', H: 1, startIdx: 1, cap: QCAP,
      value: sourceCert.value, proofStatus: sourceCert.proofStatus, nodes: sourceCert.nodes,
      chanceNodes: sourceCert.chanceNodes, chanceOutcomes: sourceCert.chanceOutcomes,
      postKeys: replayed.T4.postKeys, policy: sourceCert.policyEntries,
    }));
    const certHashMatch = certHashRecomputed === sourceCert.certHash;
    const sourceCertificateOk = sourceCert.value === true && sourceCert.proofStatus === 'PROVEN'
      && sourceCert.truncated === false && sourceCert.verifyVerdict === 'PROVEN'
      && (sourceCert.policyMisses ?? 1) === 0;
    const reuseOk = t4Compare.equal && t4Compare.stateKeyEqual && t4Compare.differences.length === 0
      && sourcePostKeyMatch && certHashMatch && sourceCertificateOk
      && verify.verdict === 'PROVEN' && verify.policyMisses === 0;
    if (verify.verdict !== 'PROVEN' || verify.policyMisses > 0) verifyFailures++;
    if (sourceCert.proofStatus === 'PROVEN' && verify.verdict !== 'PROVEN') falseProven++;
    if (!certHashMatch || !sourcePostKeyMatch || !t4Compare.equal) identityMismatches++;

    const t4H0 = {
      groupId: 'G1T9_H1_RDLD_REUSES_UDDD',
      mode: 'mouseForce', H: 1, startIdx: 1, cap: QCAP,
      branchCount: 1, postStateKeys: replayed.T4.postKeys,
      ran: false, reused: true,
      source: {
        path: T2_ALT, sha256: T2_ALT_SHA,
        candidateId: source.candidateId, plan: source.planString,
        sourcePostStateKey: source.postStateKeys[0],
        sourceCertHash: sourceCert.certHash,
        sourceProofStatus: sourceCert.proofStatus,
        sourceValue: sourceCert.value,
        sourceTruncated: sourceCert.truncated,
        sourceVerifyVerdict: sourceCert.verifyVerdict,
        sourceVerifyLeaves: sourceCert.verifyLeaves,
        sourceVerifyMs: sourceCert.verifyMs,
        sourcePolicyMisses: sourceCert.policyMisses,
        sourceNodes: sourceCert.nodes,
        sourceChanceNodes: sourceCert.chanceNodes,
        sourceChanceOutcomes: sourceCert.chanceOutcomes,
      },
      identity: {
        equal: t4Compare.equal,
        stateKeyEqual: t4Compare.stateKeyEqual,
        postStateKey: replayed.T4.postKeys[0],
        canonicalSha256: t4Compare.aSha256,
        udddCanonicalSha256: t4Compare.bSha256,
        sourcePostKeyMatch,
        differences: t4Compare.differences,
      },
      certificateHash: {
        recorded: sourceCert.certHash, recomputed: certHashRecomputed, match: certHashMatch,
      },
      policy: {
        size: sourceCert.policySize,
        entries: sourceCert.policyEntries,
        entriesUsedForVerification: policy.size,
      },
      independentVerifier: {
        verdict: verify.verdict, ok: verify.ok, leaves: verify.leaves,
        branches: verify.branches, chanceNodes: verify.chanceNodes,
        maxDepth: verify.maxDepth, policyMisses: verify.policyMisses,
        elapsedMs: Number(verify.elapsedMs.toFixed(3)),
        counterexample: verify.counterexample, reason: verify.reason,
      },
      aggregate: reuseOk ? true : null,
      refuted: reuseOk,
      status: reuseOk ? 'ALTERNATIVE_REFUTED_H0_REUSED_CERTIFICATE'
        : 'REUSE_FAILED',
      solveMs: 0, verifyMs: Number(verify.elapsedMs.toFixed(3)),
      totalMs: Number(verify.elapsedMs.toFixed(3)),
      within25ms: verify.elapsedMs <= 25,
    };
    console.log(`TAIL_REP${REP}_T4_REUSE`, JSON.stringify({
      identityEqual: t4Compare.equal, differences: t4Compare.differences.length,
      sourcePostKeyMatch, certHashMatch, sourceCertificateOk,
      verifyVerdict: verify.verdict, policyMisses: verify.policyMisses,
      leaves: verify.leaves, reuseOk,
    }));
    expect(identityMismatches).toBe(0);

    // ---- H0 for the two unique frontiers --------------------------------
    const h0G2 = proveH0('G2T8_LDDR_SHARED', [replayed.T1.state], replayed.T1.postKeys);
    const h0T3 = proveH0('G1T9_E1_RLLL', [replayed.T3.state], replayed.T3.postKeys);
    for (const h of [h0G2, h0T3]) {
      for (const r of h.records) {
        if (r.proofStatus === 'PROVEN' && r.verifyVerdict !== 'PROVEN') falseProven++;
        if (r.verifyVerdict !== 'PROVEN' || (r.policyMisses ?? 1) > 0) verifyFailures++;
        if (!r.certHashMatch) verifyFailures++;
      }
    }

    // ---- H1 only if H0 was not refuted ----------------------------------
    const h1G2 = h0G2.refuted ? null : proveH1('G2T8_LDDR_SHARED', [replayed.T1.state], replayed.T1.postKeys);
    const h1T3 = h0T3.refuted ? null : proveH1('G1T9_E1_RLLL', [replayed.T3.state], replayed.T3.postKeys);
    for (const h of [h1G2, h1T3]) {
      if (!h) continue;
      for (const r of h.records) {
        if (r.proofStatus === 'PROVEN' && r.verifyVerdict !== 'PROVEN') falseProven++;
        if (r.verifyVerdict !== 'PROVEN' || (r.policyMisses ?? 1) > 0) verifyFailures++;
        if (!r.certHashMatch) verifyFailures++;
      }
    }

    // T4 is H0-refuted by reuse; it never enters H1.
    const h1T4 = reuseOk ? {
      ran: false, reason: 'H0_REFUTED_BY_REUSED_CERTIFICATE',
      status: 'NOT_RUN_H0_REFUTED', certified: false,
    } : {
      ran: false, reason: 'REUSE_FAILED_NO_H1_RUN',
      status: 'NOT_RUN_REUSE_FAILED', certified: false,
    };

    const recordResults = doc.records.map((r) => {
      let h0: unknown;
      let h1: unknown;
      let evidenceSource: string;
      let countedAsNewProof = false;
      if (r.recordId === 'T1' || r.recordId === 'T2') {
        h0 = h0G2; h1 = h1G2;
        evidenceSource = 'T1_REPRESENTATIVE_NEW_H0' + (r.recordId === 'T2' ? '_SHARED_FULL_STATE' : '');
        countedAsNewProof = r.recordId === 'T1';
      } else if (r.recordId === 'T3') {
        h0 = h0T3; h1 = h1T3;
        evidenceSource = 'T3_NEW_H0';
        countedAsNewProof = true;
      } else {
        h0 = t4H0; h1 = h1T4;
        evidenceSource = 'T4_REUSED_T2_UDDD_CERTIFICATE_PLUS_INDEPENDENT_VERIFIER';
        countedAsNewProof = false;
      }
      const h0Rec = h0 as { refuted: boolean; status: string };
      const h1Rec = h1 as { certified?: boolean; status?: string } | null;
      const rescueCandidate = h1Rec?.certified === true;
      return {
        recordId: r.recordId, rootId: r.rootId, arm: r.arm, planString: r.planString,
        dedupGroupId: r.dedupGroupId, postStateKey: r.postStateKey,
        postSnapshotSha256: r.postSnapshotSha256,
        countedAsNewProof, evidenceSource,
        h0: h0Rec, h1: h1Rec,
        classify: h0Rec.refuted
          ? (r.recordId === 'T4' ? 'ALTERNATIVE_REFUTED_H0_REUSED_CERTIFICATE' : 'ALTERNATIVE_REFUTED_H0')
          : rescueCandidate ? 'ALTERNATIVE_SURVIVAL_CERTIFIED_H1'
            : (h1Rec?.status ?? h0Rec.status),
        rescueCandidate,
      };
    });

    const h0ProvenRecords = recordResults.filter((r) => (r.h0 as { refuted: boolean }).refuted).length;
    const h1RunRecords = recordResults.filter((r) => {
      const h1 = r.h1 as { ran?: boolean } | null;
      return h1?.ran === true;
    }).length;
    const h1ProvenRecords = recordResults.filter((r) => r.rescueCandidate).length;
    const unresolvedRecords = recordResults.filter((r) =>
      (r.h0 as { status: string }).status === 'UNRESOLVED_H0'
      || (r.h1 as { status?: string } | null)?.status === 'UNRESOLVED_H1').length;
    const rescueRecords = recordResults.filter((r) => r.rescueCandidate).length;
    const chanceComplete = doc.records.every((r) =>
      r.chance.branchCount >= 1 && r.chance.allPositive && r.chance.sumWeights === 1);
    const elapsedMs = performance.now() - t0;
    const mem = process.memoryUsage();

    const summary = {
      originalRecords: 4,
      uniqueFrontiers: 2,
      h0UniqueProofs: 2,
      h0ProvenRecords,
      h0RefutedRecords: h0ProvenRecords,
      h0NotProvenRecords: 4 - h0ProvenRecords,
      h0ReusedCertificates: reuseOk ? 1 : 0,
      h1RunRecords,
      h1ProvenRecords,
      rescueRecords,
      unresolvedRecords,
      verifyFailures,
      falseProven,
      identityMismatches,
      chanceComplete,
      rescueStatus: rescueRecords > 0 ? 'PROVEN_TACTICAL_RESCUE_H1' : 'NO_PROVEN_TACTICAL_RESCUE_H1',
    };
    console.log(`TAIL_REP${REP}_SUMMARY`, JSON.stringify(summary));
    expect(identityMismatches).toBe(0);
    expect(verifyFailures).toBe(0);
    expect(falseProven).toBe(0);
    expect(chanceComplete).toBe(true);

    const raw = {
      round: ROUND, rep: REP, startedAt, finishedAt: new Date().toISOString(),
      head: HEAD, branch: BRANCH,
      identityGate: gate,
      freeze: {
        candidatesSha256: cSha, candidatesBytes: cRaw.length,
        auditSha256: aSha, auditBytes: aRaw.length,
        candidateFreezeSha256: hashFile(FREEZE_PATH), proofsRunBeforeFreeze: freeze.proofsRunBeforeFreeze,
      },
      identityAudit: {
        records: identityRecords,
        g2t8: {
          postCanonicalEqual: g2.equal, postStateKeyEqual: g2.stateKeyEqual,
          postDifferences: g2.differences, rootCanonicalEqual: g2Root.equal,
          canonicalSha256: [g2.aSha256, g2.bSha256],
        },
        t4VsT2Uddd: {
          equal: t4Compare.equal, stateKeyEqual: t4Compare.stateKeyEqual,
          differences: t4Compare.differences, sourcePostKeyMatch,
          canonicalSha256: [t4Compare.aSha256, t4Compare.bSha256],
        },
        mismatches: identityMismatches,
      },
      candidateSummary: doc.summary,
      dedupAuditSummary: audit.summary,
      proofs: {
        h0G2, h0T3, h0T4Reused: t4H0,
        h1G2, h1T3, h1T4,
      },
      recordResults,
      summary,
      resource: {
        rssMB: Number((mem.rss / 1024 / 1024).toFixed(1)),
        heapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
        elapsedMs: Number(elapsedMs.toFixed(2)),
      },
    };
    mkdirSync(`${OUT}/logs`, { recursive: true });
    writeFileSync(RAW_PATH, JSON.stringify(raw, null, 1));

    expect(recordResults.length).toBe(4);
    expect(h0ProvenRecords).toBe(4);
    expect(h1RunRecords).toBe(0);
    expect(h1ProvenRecords).toBe(0);
    expect(rescueRecords).toBe(0);
    expect(summary.rescueStatus).toBe('NO_PROVEN_TACTICAL_RESCUE_H1');
    expect(reuseOk).toBe(true);
    console.log(`TAIL_REP${REP}_RESOURCE`, JSON.stringify(raw.resource));
    console.log(`TAIL_REP${REP}_WROTE`, RAW_PATH);
  });
});
