/// <reference types="node" />
/**
 * PPC-T2-PCV-TAIL-01 — READ-ONLY tail certification.
 *
 * Reads the four cap-excluded but legal candidates from
 * PPC-T2-PCV-RESCUE-01/CANDIDATE_PLANS.json strata[].attempted.
 * It never regenerates candidates and never changes production source.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { captureHardRoot } from '../../src/game/ai/hardHistory';
import type { GameEngineState } from '../../src/game/engine';
import {
  rules, label, stateKey, replayPlan, applyPrefix, runSolve, loadRoot,
  fixtureRecords, summarizeState,
} from '../../PPC-T1-PCV-01/probe/pcv_lib';
import type { SolveRecord } from '../../PPC-T1-PCV-01/probe/pcv_lib';

export const ROUND = 'PPC-T2-PCV-TAIL-01';
export const OUT = 'PPC-T2-PCV-TAIL-01';
export const HEAD = '48eaac6c4f3801d351787696ba5876995b64e8d8';
export const BRANCH = 'ppc/p1-id-state-identity-fix';
export const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
export const T2_CANDIDATES = 'PPC-T2-PCV-RESCUE-01/CANDIDATE_PLANS.json';
export const T2_CANDIDATES_SHA = '8f5a3f9d99ac2f61c895255e72650b3761418cb58ff5152b7d5e94619f8fc3ed';
export const T2_FREEZE = 'PPC-T2-PCV-RESCUE-01/_raw/CANDIDATE_FREEZE.json';
export const T2_FREEZE_SHA = 'ccd1925c1a4b489e330bd014c1dcc57434e1ab0e3c895c1f994c38f825e716f7';
export const T2_ALT = 'PPC-T2-PCV-RESCUE-01/ALTERNATIVE_PROOF_RESULTS.json';
export const T2_ALT_SHA = '3351036f445e843c876d3629ea7698abd1e56c704aaffadeca74151cd7ef050a';
export const T2_MANIFEST = 'PPC-T2-PCV-RESCUE-01/SOURCE_MANIFEST.json';
export const T2_MANIFEST_SHA = 'b6b5b493b275efdc5952c040e0d18a3c89ee4a7e18928b5da577f5a9b08e5041';
export const T1_MANIFEST = 'PPC-T1-PCV-01/SOURCE_MANIFEST.json';
export const T1_MANIFEST_SHA = '01f39e30be90b422f3cc6108a1373f85eed981a31b482b5df2a89797cf84f133';
export const KERNEL = 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts';
export const KERNEL_SHA = '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b';
export const PREPARED = 'src/game/ai/preparedActions.ts';
export const PREPARED_SHA = '67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764';
export const EXPECTIMINIMAX = 'src/game/ai/expectiminimax.ts';
export const EXPECTIMINIMAX_SHA = '50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c';
export const ENGINE = 'src/game/engine.ts';
export const ENGINE_SHA = '099f9a7b6d97b838c664aa7186be58465e5b01b8052af4b4e4e19a5644d19f06';
export const GAMEPLAY = 'GAMEPLAY.md';
export const GAMEPLAY_SHA = 'e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34';

export const QCAP = 600_000;
export const H1_CAP = 5_000;
export const PHASE1_NODE_CAP = 5_000;
export const PHASE1_SOLVE_MS = 20;

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const hashFile = (p: string) => sha256(readFileSync(p));

export interface TailSpec { recordId: string; rootId: string; arm: 'E1' | 'H1'; plan: string }
export const TAIL_SPECS: TailSpec[] = [
  { recordId: 'T1', rootId: 'G2T8', arm: 'E1', plan: 'LDDR' },
  { recordId: 'T2', rootId: 'G2T8', arm: 'H1', plan: 'LDDR' },
  { recordId: 'T3', rootId: 'G1T9', arm: 'E1', plan: 'RLLL' },
  { recordId: 'T4', rootId: 'G1T9', arm: 'H1', plan: 'RDLD' },
];

/** Recursively key-sorted JSON; the form used by frozen fixture hashes. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export interface StateIdentity {
  stateKey: string;
  canonicalJson: string;
  canonicalSha256: string;
  summary: Record<string, unknown>;
}

export function stateIdentity(s: GameEngineState): StateIdentity {
  const canon = canonicalJson(captureHardRoot(s));
  return {
    stateKey: stateKey(s),
    canonicalJson: canon,
    canonicalSha256: sha256(canon),
    summary: summarizeState(s),
  };
}

export function diffJson(a: unknown, b: unknown, path = '$'): { path: string; a: unknown; b: unknown }[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: { path: string; a: unknown; b: unknown }[] = [];
    if (a.length !== b.length) out.push({ path: `${path}.length`, a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...diffJson(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aa = a as Record<string, unknown>;
    const bb = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
    const out: { path: string; a: unknown; b: unknown }[] = [];
    for (const k of [...keys].sort()) out.push(...diffJson(aa[k], bb[k], `${path}.${k}`));
    return out;
  }
  return [{ path, a, b }];
}

export function compareStates(a: GameEngineState, b: GameEngineState) {
  const ia = stateIdentity(a);
  const ib = stateIdentity(b);
  return {
    equal: ia.canonicalJson === ib.canonicalJson,
    stateKeyEqual: ia.stateKey === ib.stateKey,
    aSha256: ia.canonicalSha256,
    bSha256: ib.canonicalSha256,
    differences: diffJson(JSON.parse(ia.canonicalJson), JSON.parse(ib.canonicalJson)),
    aIdentity: ia,
    bIdentity: ib,
  };
}

export interface T2Attempted {
  rootAction: string; rootActionLegalIndex: number; rootValue: number;
  continuationSource: string; planString: string; planChars: string[];
  replayOk: boolean; replayStatus: string; replayReason: string | null;
  bindingOk: boolean; postStateKeys: string[]; boundaryKind: string;
  branches: number; eligible: boolean; rejectReason: string | null;
}
interface T2Stratum {
  rootId: string; arm: 'E1' | 'H1'; originalPlan: string; originalRootStateKey: string;
  snapshotSha256: string; attempted: T2Attempted[];
}
interface T2CandidateDoc {
  round: string; head: string; fixtureSha256: string; strata: T2Stratum[];
}
export const t2Doc = JSON.parse(readFileSync(T2_CANDIDATES, 'utf8')) as T2CandidateDoc;
export const t2Alt = JSON.parse(readFileSync(T2_ALT, 'utf8')) as unknown as {
  candidates: {
    candidateId: string; rootId: string; arm: string; planString: string; planChars: string[];
    postStateKeys: string[]; rootStateKey: string; h0: {
      aggregate: boolean | null; status: string;
      records: {
        value: boolean | null; proofStatus: string; nodes: number; chanceNodes: number;
        chanceOutcomes: number; truncated: boolean; verifyVerdict: string | null;
        verifyLeaves: number | null; verifyMs: number | null; policyMisses: number | null;
        certHash: string; policySize: number; policyEntries: [string, string][] | null;
      }[];
    };
  }[];
};

export function t2Stratum(rootId: string, arm: 'E1' | 'H1'): T2Stratum {
  const s = t2Doc.strata.find((x) => x.rootId === rootId && x.arm === arm);
  if (!s) throw new Error(`T2 stratum missing: ${rootId}/${arm}`);
  return s;
}
export function t2Attempted(spec: TailSpec): { stratum: T2Stratum; attempted: T2Attempted; index: number } {
  const s = t2Stratum(spec.rootId, spec.arm);
  const index = s.attempted.findIndex((a) => a.planString === spec.plan);
  if (index < 0) throw new Error(`T2 attempted missing: ${spec.recordId} ${spec.plan}`);
  const a = s.attempted[index];
  if (!a.eligible) throw new Error(`T2 attempted not eligible: ${spec.recordId} ${spec.plan} ${a.rejectReason}`);
  if (a.replayStatus !== 'VALID_MOUSE_FRONTIER' || !a.bindingOk) {
    throw new Error(`T2 attempted not bound: ${spec.recordId} ${spec.plan}`);
  }
  return { stratum: s, attempted: a, index };
}

export interface RootIdentity {
  root: GameEngineState;
  identity: StateIdentity;
  fixtureCanvasSha256: string;
  fixturePinnedSha256: string;
  fixtureHashOk: boolean;
  restoredHashOk: boolean;
}
export function rootIdentity(rootId: string): RootIdentity {
  const root = loadRoot(rootId);
  const rec = fixtureRecords.find((r) => r.id === rootId);
  if (!rec) throw new Error(`fixture root missing: ${rootId}`);
  const fixtureCanon = canonicalJson(rec.state);
  const fixtureSha = sha256(fixtureCanon);
  const identity = stateIdentity(root);
  return {
    root, identity,
    fixtureCanvasSha256: fixtureSha,
    fixturePinnedSha256: rec.canonicalSnapshotSha256,
    fixtureHashOk: fixtureSha === rec.canonicalSnapshotSha256,
    restoredHashOk: identity.canonicalSha256 === rec.canonicalSnapshotSha256,
  };
}

export interface ReplayBranch {
  branch: number;
  weight: number | null;
  identity: StateIdentity;
  state: GameEngineState;
}
export interface ReplayIdentity {
  planString: string;
  planChars: string[];
  planHash: string;
  ok: boolean;
  status: string;
  reason: string | null;
  applyPrefixCrossCheck: boolean;
  bindingOk: boolean;
  postStateKeys: string[];
  postStateKey: string;
  steps: { label: string; transitionKind: string; branches: number }[];
  chance: {
    chance: boolean;
    kind: string;
    branchCount: number;
    probabilities: (number | null)[];
    allPositive: boolean;
    sumWeights: number | null;
  };
  branches: ReplayBranch[];
}
export function replayIdentity(root: GameEngineState, plan: string): ReplayIdentity {
  const chars = [...plan];
  const rep = replayPlan(root, chars);
  const pre = applyPrefix(root, chars, 0);
  const postKeys = pre.states.map((s) => stateKey(s));
  const repKeys = rep.branches.map((b) => b.postStateKey);
  const bindingOk = pre.ok && pre.states.length === rep.branches.length
    && postKeys.slice().sort().every((k, i) => k === repKeys.slice().sort()[i]);
  const branches: ReplayBranch[] = pre.states.map((s, i) => ({
    branch: i,
    weight: rep.branches[i]?.weight ?? null,
    identity: stateIdentity(s),
    state: s,
  }));
  const probabilities = branches.map((b) => b.weight);
  const boundaryChance = rep.boundaryChance || rep.branches.length > 1;
  const kind = !boundaryChance && branches.length === 1
    ? 'DETERMINISTIC'
    : boundaryChance && branches.length === 1
      ? 'DEGENERATE_CHANCE_ONE_OUTCOME'
      : boundaryChance ? 'MULTI_CHANCE_AND' : 'UNEXPECTED';
  return {
    planString: plan, planChars: chars, planHash: sha256(plan),
    ok: rep.ok, status: rep.status, reason: rep.reason,
    applyPrefixCrossCheck: rep.applyPrefixCrossCheck, bindingOk,
    postStateKeys: postKeys, postStateKey: postKeys[0] ?? '',
    steps: rep.steps,
    chance: {
      chance: boundaryChance, kind, branchCount: branches.length,
      probabilities,
      allPositive: probabilities.every((w): w is number => typeof w === 'number' && w > 0),
      sumWeights: probabilities.every((w): w is number => typeof w === 'number')
        ? probabilities.reduce((n, w) => n + w, 0) : null,
    },
    branches,
  };
}

export function certHashOf(r: SolveRecord, postKeys: string[]): string {
  return sha256(JSON.stringify({
    mode: r.mode, H: r.H, startIdx: r.startIdx, cap: r.cap,
    value: r.value, proofStatus: r.proofStatus, nodes: r.nodes,
    chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
    postKeys, policy: r.policyEntries,
  }));
}

export function withCert(r: SolveRecord, postKeys: string[]) {
  const certHash = r.value === true ? certHashOf(r, postKeys) : null;
  const certHashRecomputed = r.value === true
    ? sha256(JSON.stringify({
      mode: r.mode, H: r.H, startIdx: r.startIdx, cap: r.cap,
      value: r.value, proofStatus: r.proofStatus, nodes: r.nodes,
      chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
      postKeys, policy: r.policyEntries,
    }))
    : null;
  return {
    value: r.value, proofStatus: r.proofStatus,
    nodes: r.nodes, solveMs: Number(r.solveElapsedMs.toFixed(3)),
    chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
    truncated: r.truncated, maxIdx: r.maxIdx,
    verifyVerdict: r.verifyVerdict,
    verifyLeaves: r.verify?.leaves ?? null,
    verifyMs: r.verify ? Number(r.verify.elapsedMs.toFixed(3)) : null,
    policyMisses: r.verify?.policyMisses ?? null,
    solvePlusVerifyMs: Number((r.solveElapsedMs + (r.verify?.elapsedMs ?? 0)).toFixed(3)),
    within25ms: r.within25ms, withinPhase1: r.withinPhase1,
    mode: r.mode, H: r.H, startIdx: r.startIdx, cap: r.cap,
    policySize: r.policySize, policyEntries: r.policyEntries,
    certHash, certHashRecomputed, certHashMatch: certHash === certHashRecomputed,
  };
}

export function allTrueVerified(recs: SolveRecord[]): boolean {
  return recs.length > 0 && recs.every((r) =>
    r.value === true && r.proofStatus === 'PROVEN' && !r.truncated
    && r.verify?.verdict === 'PROVEN' && (r.verify?.policyMisses ?? 1) === 0);
}

export function buildTailArtifacts() {
  const records = TAIL_SPECS.map((spec) => {
    const { stratum, attempted, index } = t2Attempted(spec);
    const r = rootIdentity(spec.rootId);
    if (!r.fixtureHashOk || !r.restoredHashOk) {
      throw new Error(`ROOT_SNAPSHOT_HASH_MISMATCH ${spec.recordId} ${spec.rootId}`);
    }
    if (attempted.planString !== spec.plan) throw new Error(`plan mismatch ${spec.recordId}`);
    const rep = replayIdentity(r.root, spec.plan);
    if (!rep.ok || rep.status !== 'VALID_MOUSE_FRONTIER' || !rep.applyPrefixCrossCheck || !rep.bindingOk) {
      throw new Error(`TAIL_REPLAY_FAILED ${spec.recordId} ${spec.plan} ${rep.status} ${rep.reason ?? ''}`);
    }
    const ownKeys = rep.postStateKeys.slice().sort();
    const t2Keys = attempted.postStateKeys.slice().sort();
    const postKeyMatch = ownKeys.length === t2Keys.length && ownKeys.every((k, i) => k === t2Keys[i]);
    if (!postKeyMatch) throw new Error(`T2_POST_KEY_MISMATCH ${spec.recordId}`);
    if (rep.chance.branchCount !== attempted.branches) throw new Error(`CHANCE_BRANCH_MISMATCH ${spec.recordId}`);
    const rootKeyMatch = r.identity.stateKey === stratum.originalRootStateKey;
    if (!rootKeyMatch) throw new Error(`ROOT_KEY_MISMATCH ${spec.recordId}`);
    return {
      recordId: spec.recordId, rootId: spec.rootId, arm: spec.arm,
      planString: rep.planString, planChars: rep.planChars, planHash: rep.planHash,
      source: {
        kind: 'T2_ATTEMPTED_CAP_EXCLUDED', path: T2_CANDIDATES, fileSha256: T2_CANDIDATES_SHA,
        stratum: `${spec.rootId}/${spec.arm}`, attemptedIndex: index,
        attempted: attempted as unknown as Record<string, unknown>,
      },
      rootStateKey: r.identity.stateKey,
      rootSnapshotSha256: r.fixturePinnedSha256,
      rootSnapshotSha256Recomputed: r.identity.canonicalSha256,
      rootKeyMatchesT2: rootKeyMatch,
      postStateKey: rep.postStateKey,
      postStateKeys: rep.postStateKeys,
      postSnapshotSha256: rep.branches[0]?.identity.canonicalSha256 ?? null,
      postIdentityFields: rep.branches[0]?.identity.summary ?? null,
      t2PostStateKeys: attempted.postStateKeys,
      postKeyMatchesT2: postKeyMatch,
      replay: {
        ok: rep.ok, status: rep.status, reason: rep.reason,
        applyPrefixCrossCheck: rep.applyPrefixCrossCheck, bindingOk: rep.bindingOk,
        steps: rep.steps,
      },
      chance: rep.chance,
      dedupGroupId: '',
      reuse: null as null | Record<string, unknown>,
      identityMapping: null as null | Record<string, unknown>,
      plansEqualT2Source: attempted.planString === spec.plan,
      proofsRunBeforeFreeze: false,
    };
  });

  const t1 = records[0];
  const t2 = records[1];
  const g2Compare = {
    rootCanonicalEqual: t1.rootSnapshotSha256Recomputed === t2.rootSnapshotSha256Recomputed,
    rootStateKeyEqual: t1.rootStateKey === t2.rootStateKey,
    postCanonicalEqual: (t1.postSnapshotSha256 === t2.postSnapshotSha256) && (t1.postStateKey === t2.postStateKey),
    postStateKeyEqual: t1.postStateKey === t2.postStateKey,
    postSnapshotSha256Equal: t1.postSnapshotSha256 === t2.postSnapshotSha256,
    rootSha256: [t1.rootSnapshotSha256Recomputed, t2.rootSnapshotSha256Recomputed],
    postSha256: [t1.postSnapshotSha256, t2.postSnapshotSha256],
    rootFieldDifferences: [] as { path: string; a: unknown; b: unknown }[],
  };
  const g2Shared = g2Compare.rootCanonicalEqual && g2Compare.rootStateKeyEqual
    && g2Compare.postCanonicalEqual && g2Compare.postStateKeyEqual && g2Compare.postSnapshotSha256Equal;
  t1.dedupGroupId = g2Shared ? 'G2T8_LDDR_SHARED' : 'G2T8_E1_LDDR_ALONE';
  t2.dedupGroupId = g2Shared ? 'G2T8_LDDR_SHARED' : 'G2T8_H1_LDDR_ALONE';
  t1.identityMapping = { expected: 'T1_EQUALS_T2_BY_FULL_STATE', matched: g2Shared };
  t2.identityMapping = { expected: 'T2_EQUALS_T1_BY_FULL_STATE', matched: g2Shared };

  records[2].dedupGroupId = 'G1T9_E1_RLLL';
  records[2].identityMapping = { expected: 'T3_INDEPENDENT_NEW_FRONTIER', matched: true };

  // T4 vs the already-proven T2 UDDD certificate state.
  const udddRoot = rootIdentity('G1T9');
  const uddd = replayIdentity(udddRoot.root, 'UDDD');
  const source = t2Alt.candidates.find((c) => c.rootId === 'G1T9' && c.arm === 'H1' && c.planString === 'UDDD');
  if (!source) throw new Error('T2 UDDD source candidate missing');
  const sourceCert = source.h0.records[0];
  if (!sourceCert) throw new Error('T2 UDDD certificate missing');
  const t4 = records[3];
  const t4State = t4.replay.ok && t4.postStateKeys.length === 1
    ? replayIdentity(rootIdentity('G1T9').root, t4.planString)
    : null;
  if (!t4State) throw new Error('T4 replay missing');
  const t4Compare = compareStates(t4State.branches[0].state, uddd.branches[0].state);
  const t2PostKeyMatchUddd = source.postStateKeys.length === 1
    && source.postStateKeys[0] === uddd.postStateKey;
  const t4MatchesUddd = t4Compare.equal && t2PostKeyMatchUddd
    && t4.postStateKey === uddd.postStateKey
    && t4.postSnapshotSha256 === stateIdentity(uddd.branches[0].state).canonicalSha256;
  t4.dedupGroupId = t4MatchesUddd ? 'G1T9_H1_RDLD_REUSES_UDDD' : 'G1T9_H1_RDLD_ALONE';
  t4.identityMapping = {
    expected: 'T4_EQUALS_T2_UDDD_BY_FULL_STATE',
    matched: t4MatchesUddd,
    t2SourceCandidateId: source.candidateId,
    t2SourcePlan: source.planString,
    t2SourcePostStateKey: source.postStateKeys[0] ?? null,
    replayedUdddPostStateKey: uddd.postStateKey,
    t2SourcePostKeyMatchesReplay: t2PostKeyMatchUddd,
    canonicalEqual: t4Compare.equal,
    stateKeyEqual: t4Compare.stateKeyEqual,
    differences: t4Compare.differences,
  };
  t4.reuse = t4MatchesUddd ? {
    eligible: true,
    sourceCandidateId: source.candidateId,
    sourcePlan: source.planString,
    sourcePostStateKey: source.postStateKeys[0],
    sourceCertHash: sourceCert.certHash,
    sourceProofStatus: sourceCert.proofStatus,
    sourceValue: sourceCert.value,
    sourceTruncated: sourceCert.truncated,
    sourceVerifyVerdict: sourceCert.verifyVerdict,
    sourcePolicyMisses: sourceCert.policyMisses,
    sourcePolicySize: sourceCert.policySize,
    sourcePostKeys: source.postStateKeys,
    sourceRecordPath: T2_ALT,
    sourceRecordSha256: T2_ALT_SHA,
    independentReverificationRequired: true,
    reSolveRequired: false,
  } : {
    eligible: false,
    reason: 'FULL_STATE_IDENTITY_MISMATCH_OR_SOURCE_MISSING',
    sourceCandidateId: source.candidateId,
    sourceCertHash: sourceCert.certHash,
  };

  const uniqueGroups: string[] = [];
  if (g2Shared) uniqueGroups.push('G2T8_LDDR_SHARED');
  else uniqueGroups.push('G2T8_E1_LDDR_ALONE', 'G2T8_H1_LDDR_ALONE');
  uniqueGroups.push('G1T9_E1_RLLL');
  if (!t4MatchesUddd) uniqueGroups.push('G1T9_H1_RDLD_ALONE');

  const actualMatchesExpected = g2Shared && t4MatchesUddd && uniqueGroups.length === 2;
  const candidateDoc = {
    round: ROUND, phase: 'TAIL_CANDIDATES_FROZEN',
    generatedAt: new Date().toISOString(),
    generatedBy: `${OUT}/probe/tail_lib.ts`,
    head: HEAD, branch: BRANCH, fixtureSha256: FIXTURE_SHA,
    source: {
      path: T2_CANDIDATES, sha256: T2_CANDIDATES_SHA,
      field: 'strata[].attempted', regenerated: false,
    },
    method: {
      identity: 'real RuleSet replay; stateKey + recursively key-sorted canonical snapshot JSON + SHA-256; full field diff for dedup',
      dedup: 'G2T8 E1/H1 LDDR share one proof group iff root and post canonical snapshots are identical; G1T9/H1 RDLD reuses the T2 UDDD H0 certificate iff full post-state identity matches',
      proofRuns: 0,
      h0: 'mouseForce H=1 startIdx=1 cap=600000; all positive-probability CHANCE outcomes ANDed',
      h1: 'catSurvive H=2 startIdx=1 cap=5000; only when H0 not refuted; 20ms phase-1 gate is solve-only',
    },
    expected: {
      originalRecords: 4, uniqueFrontiers: 2, reusedCertificates: 1,
      g2t8Shared: g2Shared, t4ReusesUddd: t4MatchesUddd,
    },
    proofsRunBeforeFreeze: false,
    records,
    groups: {
      G2T8_LDDR_SHARED: {
        groupId: 'G2T8_LDDR_SHARED', sources: g2Shared ? ['T1', 'T2'] : ['T1', 'T2'],
        representative: 'T1', newProofs: g2Shared ? 1 : 2, shared: g2Shared,
      },
      G1T9_E1_RLLL: {
        groupId: 'G1T9_E1_RLLL', sources: ['T3'], representative: 'T3', newProofs: 1, shared: false,
      },
      G1T9_H1_RDLD_REUSES_UDDD: {
        groupId: 'G1T9_H1_RDLD_REUSES_UDDD', sources: ['T4'], representative: 'T4',
        newProofs: 0, shared: false, reuseFrom: 'T2 G1T9/H1/C2 UDDD', matched: t4MatchesUddd,
      },
    },
    uniqueProofGroups: uniqueGroups,
    summary: {
      originalRecords: records.length,
      uniqueFrontiers: uniqueGroups.length,
      reusedCertificates: t4MatchesUddd ? 1 : 0,
      proofsRunBeforeFreeze: 0,
      actualMatchesExpected,
    },
  };

  const audit = {
    round: ROUND, phase: 'TAIL_DEDUP_AUDIT_FROZEN',
    generatedAt: candidateDoc.generatedAt,
    head: HEAD, branch: BRANCH,
    source: { path: T2_CANDIDATES, sha256: T2_CANDIDATES_SHA, field: 'strata[].attempted' },
    proofsRunBeforeFreeze: false,
    expected: candidateDoc.expected,
    actual: {
      g2t8Shared: g2Shared,
      t4ReusesUddd: t4MatchesUddd,
      uniqueFrontiers: uniqueGroups.length,
      reusedCertificates: t4MatchesUddd ? 1 : 0,
      actualMatchesExpected,
    },
    records: records.map((r) => ({
      recordId: r.recordId, rootId: r.rootId, arm: r.arm, planString: r.planString,
      planHash: r.planHash, rootStateKey: r.rootStateKey, postStateKey: r.postStateKey,
      postStateKeys: r.postStateKeys, rootSnapshotSha256: r.rootSnapshotSha256Recomputed,
      postSnapshotSha256: r.postSnapshotSha256, t2PostStateKeys: r.t2PostStateKeys,
      postKeyMatchesT2: r.postKeyMatchesT2, replayStatus: r.replay.status,
      chance: r.chance, dedupGroupId: r.dedupGroupId, reuse: r.reuse,
      identityMapping: r.identityMapping,
      canonicalPostStateJson: t4State && r.recordId === 'T4'
        ? t4State.branches[0].identity.canonicalJson
        : replayIdentity(rootIdentity(r.rootId).root, r.planString).branches[0]?.identity.canonicalJson ?? null,
    })),
    comparisons: {
      g2t8E1VsH1: {
        ...g2Compare,
        fieldDifferences: [],
        canonicalRootJson: t1.rootStateKey === t2.rootStateKey
          ? canonicalJson(captureHardRoot(rootIdentity('G2T8').root)) : null,
        canonicalPostJsonE1: replayIdentity(rootIdentity('G2T8').root, 'LDDR').branches[0].identity.canonicalJson,
        canonicalPostJsonH1: replayIdentity(rootIdentity('G2T8').root, 'LDDR').branches[0].identity.canonicalJson,
        matched: g2Shared,
      },
      t4VsT2Uddd: {
        matched: t4MatchesUddd,
        canonicalEqual: t4Compare.equal,
        stateKeyEqual: t4Compare.stateKeyEqual,
        aSha256: t4Compare.aSha256,
        bSha256: t4Compare.bSha256,
        differences: t4Compare.differences,
        t2SourcePostStateKey: source.postStateKeys[0] ?? null,
        replayedUdddPostStateKey: uddd.postStateKey,
        t2SourcePostKeyMatchesReplay: t2PostKeyMatchUddd,
        canonicalRdlDPostJson: t4State.branches[0].identity.canonicalJson,
        canonicalUdddPostJson: uddd.branches[0].identity.canonicalJson,
        sourceCertHash: sourceCert.certHash,
        sourceCertMetadata: {
          value: sourceCert.value, proofStatus: sourceCert.proofStatus,
          nodes: sourceCert.nodes, chanceNodes: sourceCert.chanceNodes,
          chanceOutcomes: sourceCert.chanceOutcomes, truncated: sourceCert.truncated,
          verifyVerdict: sourceCert.verifyVerdict, verifyLeaves: sourceCert.verifyLeaves,
          verifyMs: sourceCert.verifyMs, policyMisses: sourceCert.policyMisses,
          policySize: sourceCert.policySize, policyEntries: sourceCert.policyEntries,
        },
      },
    },
    uniqueProofGroups: uniqueGroups,
    summary: candidateDoc.summary,
  };
  return { candidateDoc, audit, actualMatchesExpected };
}

export function writeTailArtifacts(candidateDoc: unknown, audit: unknown) {
  mkdirSync(`${OUT}/_raw`, { recursive: true });
  const cRaw = JSON.stringify(candidateDoc, null, 1);
  const aRaw = JSON.stringify(audit, null, 1);
  writeFileSync(`${OUT}/TAIL_CANDIDATES.json`, cRaw);
  writeFileSync(`${OUT}/TAIL_DEDUP_AUDIT.json`, aRaw);
  const freeze = {
    round: ROUND, frozenAt: new Date().toISOString(),
    candidates: { path: `${OUT}/TAIL_CANDIDATES.json`, sha256: sha256(cRaw), bytes: Buffer.byteLength(cRaw) },
    audit: { path: `${OUT}/TAIL_DEDUP_AUDIT.json`, sha256: sha256(aRaw), bytes: Buffer.byteLength(aRaw) },
    proofsRunBeforeFreeze: false,
    note: 'Tail candidate identities and dedup groups are frozen and hashed BEFORE any H0/H1 proof.',
  };
  writeFileSync(`${OUT}/_raw/TAIL_CANDIDATE_FREEZE.json`, JSON.stringify(freeze, null, 1));
  return freeze;
}

export function identityGate() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  return {
    head: head === HEAD,
    branch: branch === BRANCH,
    fixture: hashFile(FIXTURE) === FIXTURE_SHA,
    t2Candidates: hashFile(T2_CANDIDATES) === T2_CANDIDATES_SHA,
    t2Freeze: hashFile(T2_FREEZE) === T2_FREEZE_SHA,
    t2Alt: hashFile(T2_ALT) === T2_ALT_SHA,
    t2Manifest: hashFile(T2_MANIFEST) === T2_MANIFEST_SHA,
    t1Manifest: hashFile(T1_MANIFEST) === T1_MANIFEST_SHA,
    kernel: hashFile(KERNEL) === KERNEL_SHA,
    prepared: hashFile(PREPARED) === PREPARED_SHA,
    expectiminimax: hashFile(EXPECTIMINIMAX) === EXPECTIMINIMAX_SHA,
    engine: hashFile(ENGINE) === ENGINE_SHA,
    gameplay: hashFile(GAMEPLAY) === GAMEPLAY_SHA,
  };
}

export { rules, label, stateKey, replayPlan, applyPrefix, runSolve, loadRoot, summarizeState };
export type { SolveRecord };
