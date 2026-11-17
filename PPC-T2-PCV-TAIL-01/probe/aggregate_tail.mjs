/// <reference types="node" />
/**
 * Aggregate two fresh-process repetitions. Writes certificate verification,
 * rescue matrix, and the deterministic projection audit. READ-ONLY.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const OUT = 'PPC-T2-PCV-TAIL-01';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const read = (p) => readFileSync(p);
const parse = (p) => JSON.parse(read(p).toString('utf8'));

const candidateRaw = read(`${OUT}/TAIL_CANDIDATES.json`);
const auditRaw = read(`${OUT}/TAIL_DEDUP_AUDIT.json`);
const freeze = parse(`${OUT}/_raw/TAIL_CANDIDATE_FREEZE.json`);
const cSha = sha256(candidateRaw);
const aSha = sha256(auditRaw);
if (cSha !== freeze.candidates.sha256 || aSha !== freeze.audit.sha256) {
  throw new Error('TAIL_FREEZE_HASH_MISMATCH');
}
if (freeze.proofsRunBeforeFreeze !== false) throw new Error('TAIL_FREEZE_PROOFS_RAN');

const reps = [1, 2].map((n) => {
  const path = `${OUT}/TAIL_PROOF_REP${n}.json`;
  const raw = read(path);
  return { n, path, sha256: sha256(raw), bytes: raw.length, data: JSON.parse(raw.toString('utf8')) };
});

const IGNORE = new Set([
  'startedAt', 'finishedAt', 'resource',
  'solveMs', 'verifyMs', 'totalMs', 'solvePlusVerifyMs', 'elapsedMs',
  'sourceVerifyMs', 'within25ms',
]);
const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (!IGNORE.has(k)) out[k] = strip(v[k]);
    return out;
  }
  return v;
};
const projection = (rep) => strip({
  head: rep.head,
  branch: rep.branch,
  identityGate: rep.identityGate,
  freeze: rep.freeze,
  identityAudit: rep.identityAudit,
  candidateSummary: rep.candidateSummary,
  dedupAuditSummary: rep.dedupAuditSummary,
  proofs: rep.proofs,
  recordResults: rep.recordResults,
  summary: rep.summary,
});
const p1 = JSON.stringify(projection(reps[0].data));
const p2 = JSON.stringify(projection(reps[1].data));
const deterministic = p1 === p2;
const projectionSha256 = [sha256(p1), sha256(p2)];

if (!deterministic) throw new Error('TAIL_REP_DETERMINISM_MISMATCH');
for (const r of reps) {
  const s = r.data.summary;
  if (s.identityMismatches !== 0 || s.verifyFailures !== 0 || s.falseProven !== 0) {
    throw new Error(`TAIL_REP_GATE_FAILED ${r.n}`);
  }
}

const r1 = reps[0].data;
const summary = r1.summary;
const cert = {
  round: 'PPC-T2-PCV-TAIL-01',
  generatedAt: new Date().toISOString(),
  status: summary.rescueStatus,
  decision: 'NEGATIVE_TAIL_CANDIDATES__STOP_FOR_REVIEW',
  identity: {
    head: r1.head,
    branch: r1.branch,
    identityGate: r1.identityGate,
    fixtureSha256: '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09',
    t2CandidatesSha256: '8f5a3f9d99ac2f61c895255e72650b3761418cb58ff5152b7d5e94619f8fc3ed',
    t2AltSha256: '3351036f445e843c876d3629ea7698abd1e56c704aaffadeca74151cd7ef050a',
  },
  freeze: {
    candidates: { path: `${OUT}/TAIL_CANDIDATES.json`, sha256: cSha, bytes: candidateRaw.length },
    audit: { path: `${OUT}/TAIL_DEDUP_AUDIT.json`, sha256: aSha, bytes: auditRaw.length },
    proofsRunBeforeFreeze: freeze.proofsRunBeforeFreeze,
  },
  repetitions: reps.map((r) => ({
    rep: r.n, path: r.path, sha256: r.sha256, bytes: r.bytes,
    resource: r.data.resource,
    summary: r.data.summary,
  })),
  determinism: {
    equal: deterministic,
    ignoredTimingAndResourceFields: [...IGNORE],
    projectionSha256,
  },
  counts: {
    originalRecords: 4,
    uniqueFrontiers: 2,
    uniqueH0Proofs: 2,
    reusedCertificates: summary.h0ReusedCertificates,
    h0ProvenRecords: summary.h0ProvenRecords,
    h0RefutedRecords: summary.h0RefutedRecords,
    h0NotProvenRecords: summary.h0NotProvenRecords,
    h1RunRecords: summary.h1RunRecords,
    h1ProvenRecords: summary.h1ProvenRecords,
    rescueRecords: summary.rescueRecords,
    unresolvedRecords: summary.unresolvedRecords,
    verifyFailures: summary.verifyFailures,
    falseProven: summary.falseProven,
    identityMismatches: summary.identityMismatches,
    chanceComplete: summary.chanceComplete,
  },
  verification: {
    newH0Proofs: [r1.proofs.h0G2, r1.proofs.h0T3],
    reusedCertificate: r1.proofs.h0T4Reused,
    h1Proofs: [r1.proofs.h1G2, r1.proofs.h1T3].filter(Boolean),
    h1NotRun: {
      G1T9_H1_RDLD_REUSES_UDDD: r1.proofs.h1T4,
      reason: 'H0 refuted all four records; H1 is only run when H0 is NOT proven.',
    },
    records: r1.recordResults,
    exactlyOneBranchPerFrontier: r1.identityAudit.records.every((x) => x.postKeys.length === 1),
    allPositiveChanceAndSumOne: r1.identityAudit.records.every((x) => x.chance.allPositive && x.chance.sumWeights === 1),
    g2t8FullStateIdentical: r1.identityAudit.g2t8.postCanonicalEqual
      && r1.identityAudit.g2t8.postDifferences.length === 0,
    t4FullStateMatchesUddd: r1.identityAudit.t4VsT2Uddd.equal
      && r1.identityAudit.t4VsT2Uddd.differences.length === 0,
    reusedPolicyReverifiedOnRdld: r1.proofs.h0T4Reused.independentVerifier.verdict === 'PROVEN'
      && r1.proofs.h0T4Reused.independentVerifier.policyMisses === 0,
  },
  interpretation: {
    h0RefutedIsNotCatSurvival: true,
    h1NotProvenIsNotMouseForcedWin: true,
    negativeScope: 'Only the four frozen tail records. This is not an exhaustive claim over all legal cat action sequences.',
  },
};
writeFileSync(`${OUT}/TAIL_CERTIFICATE_VERIFICATION.json`, JSON.stringify(cert, null, 1));

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const h0Cols = (h0) => {
  if (h0.records && h0.records[0]) {
    const r = h0.records[0];
    return {
      nodes: r.nodes, solveMs: h0.solveMs, verifyMs: h0.verifyMs, totalMs: h0.totalMs,
      verifier: r.verifyVerdict, misses: r.policyMisses, certHash: r.certHash,
      certMatch: r.certHashMatch, source: h0.reused ? 'REUSED' : 'NEW_H0',
      solveOnlyGate: '',
    };
  }
  return {
    nodes: h0.source?.sourceNodes ?? '',
    solveMs: 0,
    verifyMs: h0.verifyMs,
    totalMs: h0.totalMs,
    verifier: h0.independentVerifier?.verdict ?? '',
    misses: h0.independentVerifier?.policyMisses ?? '',
    certHash: h0.certificateHash?.recorded ?? '',
    certMatch: h0.certificateHash?.match ?? false,
    source: 'REUSED_T2_UDDD',
    solveOnlyGate: h0.certificateHash?.match ? 'REUSE_NO_RE_SOLVE' : 'REUSE_FAILED',
  };
};
const h1Cols = (h1) => {
  if (!h1) return { run: false, status: 'NOT_RUN_H0_REFUTED', nodes: '', solveMs: '', verifyMs: '', totalMs: '', verifier: '', phase1: '' };
  if (h1.records && h1.records[0]) {
    const r = h1.records[0];
    return {
      run: true, status: h1.status, nodes: r.nodes, solveMs: h1.solveMs,
      verifyMs: h1.verifyMs, totalMs: h1.totalMs, verifier: r.verifyVerdict,
      phase1: h1.phase1Gate?.passed ?? '',
    };
  }
  return {
    run: false, status: h1.status ?? 'NOT_RUN', nodes: '', solveMs: '', verifyMs: '',
    totalMs: '', verifier: '', phase1: '',
  };
};

const header = [
  'recordId', 'rootId', 'arm', 'plan', 'dedupGroupId', 'countedAsNewProof', 'evidenceSource',
  'postStateKey', 'postSnapshotSha256',
  'h0Status', 'h0Source', 'h0Mode', 'h0Horizon', 'h0Cap', 'h0Nodes', 'h0SolveMs', 'h0VerifyMs',
  'h0TotalMs', 'h0Verifier', 'h0PolicyMisses', 'h0CertHash', 'h0CertHashMatch',
  'h1Ran', 'h1Status', 'h1Nodes', 'h1SolveMs', 'h1VerifyMs', 'h1TotalMs', 'h1Verifier', 'h1Phase1Pass',
  'rescueCandidate', 'classification',
];
const rows = [header];
for (const rec of r1.recordResults) {
  const h0 = h0Cols(rec.h0);
  const h1 = h1Cols(rec.h1);
  rows.push([
    rec.recordId, rec.rootId, rec.arm, rec.planString, rec.dedupGroupId,
    rec.countedAsNewProof, rec.evidenceSource, rec.postStateKey, rec.postSnapshotSha256,
    rec.h0.status, h0.source, rec.h0.mode, rec.h0.H, rec.h0.cap,
    h0.nodes, h0.solveMs, h0.verifyMs, h0.totalMs, h0.verifier, h0.misses, h0.certHash, h0.certMatch,
    h1.run, h1.status, h1.nodes, h1.solveMs, h1.verifyMs, h1.totalMs, h1.verifier, h1.phase1,
    rec.rescueCandidate, rec.classify,
  ]);
}
writeFileSync(`${OUT}/TAIL_MATRIX.csv`, rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n');

console.log(JSON.stringify({
  status: summary.rescueStatus,
  counts: cert.counts,
  determinism: cert.determinism,
  repetitions: cert.repetitions,
  csvRows: rows.length - 1,
}, null, 2));
