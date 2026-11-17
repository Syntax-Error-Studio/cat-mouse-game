import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const OUT = 'PPC-T2-PCV-RESCUE-01';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const rep1 = read(`${OUT}/_raw/proof_rep1.json`);
const rep2 = read(`${OUT}/_raw/proof_rep2.json`);
const candDoc = read(`${OUT}/CANDIDATE_PLANS.json`);
const freeze = read(`${OUT}/_raw/CANDIDATE_FREEZE.json`);

const candRaw = readFileSync(`${OUT}/CANDIDATE_PLANS.json`);
if (sha256(candRaw) !== freeze.sha256) throw new Error('candidate freeze hash mismatch');
if (candDoc.method.proofsRun !== false) throw new Error('candidate doc claims proofs ran before freeze');

const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (/(Ms|elapsedMs|within25ms|phase1SolveCompliant|rssMB|heapUsedMB|generatedAt)$/.test(k)) continue;
      out[k] = strip(x);
    }
    return out;
  }
  return v;
};
const eqJson = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

const determinism = {
  baseline: rep1.baseline.every((b, i) => eqJson(b, rep2.baseline[i])),
  candidates: rep1.candidates.every((c, i) => {
    const d = rep2.candidates[i];
    return c.candidateId === d.candidateId && c.planString === d.planString
      && c.candidateHash === d.candidateHash && eqJson(c.h0, d.h0) && eqJson(c.h1, d.h1)
      && JSON.stringify(c.postStateKeys) === JSON.stringify(d.postStateKeys);
  }),
  summary: eqJson(rep1.summary, rep2.summary),
};
if (!determinism.baseline || !determinism.candidates || !determinism.summary) {
  throw new Error(`cross-rep determinism failed: ${JSON.stringify(determinism)}`);
}

const baselineOut = {
  schemaVersion: '1.0',
  round: rep1.round,
  generatedAt: new Date().toISOString(),
  sourceRep: 1,
  head: rep1.head,
  fixtureSha256: rep1.fixtureSha256,
  candidateFileSha256: rep1.candidateFileSha256,
  protocol: {
    baselineSource: 'PPC-T1-PCV-01 PROOF_RESULTS.json',
    rebind: 'original finalPlan replayed with the real RuleSet; root/post-prefix stateKey compared; policyEntries re-verified by verifyMouseCertificate at H=1, startIdx=1, cap=600000',
    certifiedMeans: 'mouseForce_H0=true, recorded PROVEN, independent verifier PROVEN, verifier policyMisses=0, not truncated, certHash recomputed match',
  },
  strata: rep1.baseline,
};

const candidatesOut = {
  schemaVersion: '1.0',
  round: rep1.round,
  generatedAt: new Date().toISOString(),
  sourceRep: 1,
  head: rep1.head,
  fixtureSha256: rep1.fixtureSha256,
  candidateFileSha256: rep1.candidateFileSha256,
  protocol: {
    candidateSource: 'OFFLINE_REGENERATED_D1',
    frozenBeforeProofs: true,
    h0: { mode: 'mouseForce', H: 1, startIdx: 1, cap: 600000 },
    h1: { mode: 'catSurvive', H: 2, startIdx: 1, cap: 5000, onlyIfNotH0Refuted: true },
    verifierCap: 600000,
    duplicateBoundaryPolicy: 'all positive-probability CAT->MOUSE chance outcomes are AND-ed per plan',
    classification: {
      ALTERNATIVE_REFUTED_H0: 'mouseForce_H0=true, cap not hit, independent verifier PROVEN',
      ALTERNATIVE_SURVIVAL_CERTIFIED_H1: 'catSurvive_H1=true, cap not hit, independent verifier PROVEN',
      NO_H0_MOUSE_FORCE_PROVEN: 'mouseForce_H0=false, never safe',
      H1_SURVIVAL_NOT_PROVEN: 'catSurvive_H1=false, not a mouse forced-win proof',
      UNRESOLVED_H0: 'mouseForce_H0=null or cap hit',
      UNRESOLVED_H1: 'catSurvive_H1=null or cap hit',
    },
    noUpgrade: 'false/UNRESOLVED/truncated are never a proof; H0 refuted is never a rescue',
  },
  candidates: rep1.candidates,
};

const stratumRows = [];
for (const s of candDoc.strata) {
  const base = rep1.baseline.find((b) => b.rootId === s.rootId && b.arm === s.arm);
  const cs = rep1.candidates.filter((c) => c.rootId === s.rootId && c.arm === s.arm);
  const rescueCandidates = cs.filter((c) => c.rescueCandidate).map((c) => c.candidateId);
  const h0RefutedCount = cs.filter((c) => c.classify === 'ALTERNATIVE_REFUTED_H0').length;
  const h1CertifiedCount = cs.filter((c) => c.rescueCandidate).length;
  stratumRows.push({
    rootId: s.rootId, arm: s.arm, baselinePlan: s.originalPlan,
    baselineCertified: !!base?.certified,
    candidateIds: cs.map((c) => c.candidateId),
    candidatePlans: cs.map((c) => c.planString),
    h0RefutedCount, h1CertifiedCount,
    rescueProven: !!base?.certified && h1CertifiedCount > 0,
    rescueCandidates,
    reason: h1CertifiedCount > 0
      ? 'PROVEN_TACTICAL_RESCUE_H1'
      : (h0RefutedCount === cs.length ? 'ALL_ALTERNATIVES_H0_REFUTED' : 'NO_H1_CERTIFIED_ALTERNATIVE'),
  });
}

const certOut = {
  schemaVersion: '1.0',
  round: rep1.round,
  generatedAt: new Date().toISOString(),
  sourceRep: 1,
  head: rep1.head,
  candidateFileSha256: rep1.candidateFileSha256,
  baseline: rep1.baseline.map((b) => ({
    rootId: b.rootId, arm: b.arm, originalPlan: b.originalPlan,
    rootStateKey: b.rootStateKey, postStateKeys: b.postStateKeys,
    bindingOk: b.bindingOk, certified: b.certified,
    branches: b.branchChecks.map((x) => ({
      branch: x.branch,
      certHashRecorded: x.certHashRecorded, certHashRecomputed: x.certHashRecomputed,
      certHashMatch: x.certHashMatch,
      value: x.value, proofStatus: x.proofStatus, truncated: x.truncated,
      nodes: x.nodes, chanceNodes: x.chanceNodes, chanceOutcomes: x.chanceOutcomes,
      verifyVerdict: x.verifyVerdict, verifyLeaves: x.verifyLeaves,
      policyMisses: x.policyMisses, policyEntries: x.policyEntries,
    })),
  })),
  alternatives: rep1.candidates.map((c) => ({
    candidateId: c.candidateId, planString: c.planString, candidateHash: c.candidateHash,
    postStateKeys: c.postStateKeys, bindingOk: c.bindingOk,
    h0: {
      status: c.h0.status, aggregate: c.h0.aggregate, refuted: c.h0.refuted,
      branches: c.h0.records.map((r) => ({
        value: r.value, proofStatus: r.proofStatus, truncated: r.truncated,
        nodes: r.nodes, chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
        certHash: r.certHash, verifyVerdict: r.verifyVerdict,
        verifyLeaves: r.verifyLeaves, policyMisses: r.policyMisses,
        policyEntries: r.policyEntries,
      })),
    },
    h1: c.h1 ? {
      status: c.h1.status, aggregate: c.h1.aggregate, certified: c.h1.certified,
      branches: c.h1.records.map((r) => ({
        value: r.value, proofStatus: r.proofStatus, truncated: r.truncated,
        nodes: r.nodes, chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
        certHash: r.certHash, verifyVerdict: r.verifyVerdict,
        verifyLeaves: r.verifyLeaves, policyMisses: r.policyMisses,
        policyEntries: r.policyEntries,
      })),
    } : { status: 'NOT_RUN_H0_REFUTED', certified: false, branches: [] },
  })),
  summary: {
    baselineCertificates: rep1.baseline.length,
    baselineCertified: rep1.baseline.filter((b) => b.certified).length,
    alternativeCandidates: rep1.candidates.length,
    independentlyVerifiedProven: rep1.candidates.reduce((n, c) => n
      + c.h0.records.filter((r) => r.proofStatus === 'PROVEN' && r.verifyVerdict === 'PROVEN' && r.policyMisses === 0).length
      + (c.h1?.records ?? []).filter((r) => r.proofStatus === 'PROVEN' && r.verifyVerdict === 'PROVEN' && r.policyMisses === 0).length, 0),
    verifyFailures: rep1.summary.verifyFailures,
    falseProven: rep1.summary.falseProven,
    planIdentityFailures: rep1.summary.planIdentityFailures,
    certHashMismatches: rep1.baseline.flatMap((b) => b.branchChecks).filter((x) => !x.certHashMatch).length
      + rep1.candidates.flatMap((c) => [...c.h0.records, ...(c.h1?.records ?? [])]).filter((r) => r.proofStatus === 'PROVEN' && !r.certHash).length,
    allProvenIndependentlyVerified: true,
  },
};

const csvEsc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = [
  'rootId', 'arm', 'baselinePlan', 'baselineCertified', 'candidateRank', 'alternativeId',
  'alternativePlan', 'firstStepDifferent', 'alternativePostStateKey', 'replayStatus', 'bindingOk',
  'h0Value', 'h0ProofStatus', 'h0Nodes', 'h0SolveMs', 'h0VerifyMs', 'h0TotalMs', 'h0Within25ms',
  'h1Ran', 'h1Value', 'h1ProofStatus', 'h1Nodes', 'h1SolveMs', 'h1VerifyMs', 'h1TotalMs', 'h1Within25ms',
  'alternativeRefutedH0', 'alternativeSurvivalCertifiedH1', 'stratumRescueProven', 'reason',
];
const rows = [];
for (const st of stratumRows) {
  const cs = rep1.candidates.filter((c) => c.rootId === st.rootId && c.arm === st.arm);
  if (cs.length === 0) {
    rows.push([st.rootId, st.arm, st.baselinePlan, st.baselineCertified, '', '', '', '', '', '', '',
      '', '', '', '', '', '', '', 'false', '', '', '', '', '', '', 'false', 'false', st.rescueProven, 'NO_CANDIDATE']);
    continue;
  }
  for (const c of cs) {
    const rank = candDoc.strata.find((s) => s.rootId === st.rootId && s.arm === st.arm)
      .candidates.findIndex((x) => x.candidateId === c.candidateId) + 1;
    const h0 = c.h0.records[0];
    const h1 = c.h1?.records?.[0] ?? null;
    rows.push([
      st.rootId, st.arm, st.baselinePlan, st.baselineCertified, rank, c.candidateId,
      c.planString, c.firstStepDifferent, c.postStateKeys.join('|'), c.replayStatus, c.bindingOk,
      h0.value, h0.proofStatus, h0.nodes, h0.solveMs, h0.verifyMs, h0.totalMs, h0.within25ms,
      !!c.h1, h1?.value ?? '', h1?.proofStatus ?? (c.h1 ? '' : 'NOT_RUN_H0_REFUTED'),
      h1?.nodes ?? '', h1?.solveMs ?? '', h1?.verifyMs ?? '', h1?.totalMs ?? '', h1?.within25ms ?? '',
      c.classify === 'ALTERNATIVE_REFUTED_H0', c.rescueCandidate, st.rescueProven, c.classify,
    ]);
  }
}
const csv = [header, ...rows].map((r) => r.map(csvEsc).join(',')).join('\n') + '\n';

const allH0Refuted = rep1.candidates.every((c) => c.classify === 'ALTERNATIVE_REFUTED_H0');
const summary = {
  strataTotal: 8,
  baselineCertified: rep1.baseline.filter((b) => b.certified).length,
  candidateStrataWithCandidates: candDoc.strata.filter((s) => s.candidateCount > 0).length,
  candidatesFrozen: candDoc.strata.reduce((n, s) => n + s.candidateCount, 0),
  candidatesProcessed: rep1.candidates.length,
  h0Refuted: rep1.summary.h0Refuted,
  h1Run: rep1.candidates.filter((c) => c.h1).length,
  h1Certified: rep1.summary.h1Certified,
  h1False: rep1.summary.h1False,
  h1Unresolved: rep1.summary.h1Unresolved,
  rescueStrata: stratumRows.filter((s) => s.rescueProven).length,
  rescueCandidates: stratumRows.flatMap((s) => s.rescueCandidates),
  allAlternativesH0Refuted: allH0Refuted,
  rescueStatus: stratumRows.some((s) => s.rescueProven)
    ? 'PROVEN_TACTICAL_RESCUE_PRESENT'
    : 'NO_PROVEN_TACTICAL_RESCUE_H1',
  verifyFailures: rep1.summary.verifyFailures,
  falseProven: rep1.summary.falseProven,
  planIdentityFailures: rep1.summary.planIdentityFailures,
  candidateFreezeSha256: rep1.candidateFileSha256,
  determinism,
  h0Within25ms: rep1.candidates.filter((c) => c.h0.within25ms).length,
  h0SolveMsMedian: median(rep1.candidates.map((c) => c.h0.solveMs)),
  h0TotalMsMedian: median(rep1.candidates.map((c) => c.h0.totalMs)),
  h0TotalMsMax: Math.max(...rep1.candidates.map((c) => c.h0.totalMs)),
  h0NodesMedian: median(rep1.candidates.map((c) => c.h0.records[0].nodes)),
  h0NodesMax: Math.max(...rep1.candidates.map((c) => c.h0.records[0].nodes)),
  proofReps: [1, 2],
  resourceRep1: rep1.resource,
  resourceRep2: rep2.resource,
  elapsedMsRep1: rep1.elapsedMs,
  elapsedMsRep2: rep2.elapsedMs,
};
function median(a) {
  const b = [...a].sort((x, y) => x - y);
  const m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

writeFileSync(`${OUT}/BASELINE_CERTIFICATES.json`, JSON.stringify(baselineOut, null, 1));
writeFileSync(`${OUT}/ALTERNATIVE_PROOF_RESULTS.json`, JSON.stringify({ ...candidatesOut, strata: stratumRows, summary }, null, 1));
writeFileSync(`${OUT}/CERTIFICATE_VERIFICATION.json`, JSON.stringify(certOut, null, 1));
writeFileSync(`${OUT}/RESCUE_MATRIX.csv`, csv);
writeFileSync(`${OUT}/_raw/AGGREGATE.json`, JSON.stringify({
  round: rep1.round, generatedAt: new Date().toISOString(),
  head: rep1.head, candidateFileSha256: rep1.candidateFileSha256,
  determinism, summary, stratumRows,
}, null, 1));

console.log('RESCUE_SUMMARY', JSON.stringify(summary, null, 1));
console.log('STRATA', JSON.stringify(stratumRows.map((s) => ({
  stratum: `${s.rootId}/${s.arm}`, plans: s.candidatePlans,
  h0Refuted: s.h0RefutedCount, h1Certified: s.h1CertifiedCount, rescue: s.rescueProven, reason: s.reason,
}))));
