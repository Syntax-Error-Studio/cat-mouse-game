/// <reference types="node" />
/**
 * Step 1 — READ-ONLY identity/dedup audit and candidate freeze.
 * No H0/H1 solve is called here. Candidate identities are frozen before proof.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OUT, TAIL_SPECS, identityGate, buildTailArtifacts, writeTailArtifacts, sha256,
} from './tail_lib';

describe('PPC-T2 tail candidate identity and freeze', () => {
  it('audits identities then freezes before any proof', () => {
    const gate = identityGate();
    console.log('TAIL_IDENTITY_GATE', JSON.stringify(gate));
    expect(Object.values(gate).every(Boolean)).toBe(true);

    const built = buildTailArtifacts();
    console.log('TAIL_IDENTITY_AUDIT', JSON.stringify({
      expected: built.candidateDoc.expected,
      actual: {
        g2t8Shared: built.audit.actual.g2t8Shared,
        t4ReusesUddd: built.audit.actual.t4ReusesUddd,
        uniqueFrontiers: built.audit.actual.uniqueFrontiers,
        reusedCertificates: built.audit.actual.reusedCertificates,
        actualMatchesExpected: built.actualMatchesExpected,
      },
      records: built.candidateDoc.records.map((r) => ({
        recordId: r.recordId,
        root: `${r.rootId}/${r.arm}`,
        plan: r.planString,
        rootStateKey: r.rootStateKey,
        postStateKey: r.postStateKey,
        postSnapshotSha256: r.postSnapshotSha256,
        postKeyMatchesT2: r.postKeyMatchesT2,
        replay: r.replay.status,
        chance: r.chance,
        dedupGroupId: r.dedupGroupId,
      })),
    }));

    // If the observed identities differ from the expected dedup, remove the
    // auto-reuse/merge and stop for independent adjudication.
    if (!built.actualMatchesExpected) {
      writeTailArtifacts(built.candidateDoc, built.audit);
      throw new Error('TAIL_IDENTITY_EXPECTATION_MISMATCH');
    }

    const freeze = writeTailArtifacts(built.candidateDoc, built.audit);
    const cRaw = readFileSync(`${OUT}/TAIL_CANDIDATES.json`);
    const aRaw = readFileSync(`${OUT}/TAIL_DEDUP_AUDIT.json`);
    expect(sha256(cRaw)).toBe(freeze.candidates.sha256);
    expect(sha256(aRaw)).toBe(freeze.audit.sha256);
    expect(freeze.proofsRunBeforeFreeze).toBe(false);

    const c = JSON.parse(cRaw.toString('utf8'));
    expect(c.records.length).toBe(TAIL_SPECS.length);
    expect(c.proofsRunBeforeFreeze).toBe(false);
    expect(c.summary.uniqueFrontiers).toBe(2);
    expect(c.summary.reusedCertificates).toBe(1);
    expect(c.summary.actualMatchesExpected).toBe(true);
    expect(c.records.every((r: { postKeyMatchesT2: boolean; replay: { status: string } }) =>
      r.postKeyMatchesT2 && r.replay.status === 'VALID_MOUSE_FRONTIER')).toBe(true);
    const g2 = c.records.filter((r: { rootId: string }) => r.rootId === 'G2T8');
    expect(g2.length).toBe(2);
    expect(g2[0].dedupGroupId).toBe('G2T8_LDDR_SHARED');
    expect(g2[1].dedupGroupId).toBe('G2T8_LDDR_SHARED');
    expect(c.records.find((r: { recordId: string }) => r.recordId === 'T4').dedupGroupId)
      .toBe('G1T9_H1_RDLD_REUSES_UDDD');
    expect(c.records.find((r: { recordId: string }) => r.recordId === 'T3').dedupGroupId)
      .toBe('G1T9_E1_RLLL');

    const a = JSON.parse(aRaw.toString('utf8'));
    expect(a.comparisons.g2t8E1VsH1.matched).toBe(true);
    expect(a.comparisons.t4VsT2Uddd.matched).toBe(true);
    expect(a.comparisons.t4VsT2Uddd.differences.length).toBe(0);

    console.log('TAIL_FREEZE', JSON.stringify({
      candidatesSha256: freeze.candidates.sha256,
      candidatesBytes: freeze.candidates.bytes,
      auditSha256: freeze.audit.sha256,
      auditBytes: freeze.audit.bytes,
      proofsRunBeforeFreeze: freeze.proofsRunBeforeFreeze,
    }));
  });
});
