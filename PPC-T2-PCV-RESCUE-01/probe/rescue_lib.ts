/// <reference types="node" />
/**
 * PPC-T2-PCV-RESCUE-01 — proof-guided tactical plan rescue (OFFLINE ONLY).
 *
 * Reuses, READ-ONLY:
 *   - the frozen SEAL-01 quantifier kernel (via T1 pcv_lib's runSolve/replayPlan)
 *   - the real production transition source generatePreparedSearchActions
 *   - the real search entry createSearchContext/searchBestAction for fixed D1
 *     candidate generation.
 *
 * No production source, rule, evaluator, Sidecar, Guard, H1 or budget is changed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { GamePhase, PieceType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import {
  rules, label, stateKey, replayPlan, runSolve, applyPrefix,
} from '../../PPC-T1-PCV-01/probe/pcv_lib';
import type { SolveRecord } from '../../PPC-T1-PCV-01/probe/pcv_lib';

export const ROUND = 'PPC-T2-PCV-RESCUE-01';
export const OUT = 'PPC-T2-PCV-RESCUE-01';
export const HEAD = '48eaac6c4f3801d351787696ba5876995b64e8d8';
export const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
export const P5_PATH = 'PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json';
export const P5_SHA = '9d50560f107da52107cb68be94f4ac90214f8a50aabbc948f8f3114215278775';
export const T1_REPORT = 'PPC-T1-PCV-01/REPORT.md';
export const T1_MANIFEST = 'PPC-T1-PCV-01/SOURCE_MANIFEST.json';
export const T1_OBS = 'PPC-T1-PCV-01/OBSERVATIONS_240.json';
export const T1_PROOF = 'PPC-T1-PCV-01/PROOF_RESULTS.json';
export const T1_CERT = 'PPC-T1-PCV-01/CERTIFICATE_VERIFICATION.json';
export const T1_AMENDMENT = 'PPC-T1-PCV-01/PREREGISTRATION_AMENDMENT.md';
export const PREREG = 'PPC-T1-FOUNDATION-01/NEXT_STAGE_PREREGISTRATION.json';
export const KERNEL = 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts';
export const D1_FROZEN = 'PPC-CAT-EVALUATOR-ABLATION-01/_raw/d1_rep1.json';
export const PREPARED = 'src/game/ai/preparedActions.ts';
export const EXPECTIMINIMAX = 'src/game/ai/expectiminimax.ts';
export const ENGINE = 'src/game/engine.ts';
export const GAMEPLAY = 'GAMEPLAY.md';

export const QCAP = 600_000;        // frozen H0 correctness cap
export const H1_CAP = 5_000;        // frozen phase1 cap for H1 catSurvive
export const EXACT_CAP = 8_000_000; // D1 exact full-window probe cap (same as P3)
export const CAND_MAX = 2;
export const TARGET_MS = 25;

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const hashFile = (p: string) => sha256(readFileSync(p));

export type Arm = 'E1' | 'H1';
export const leafFor = (arm: Arm) => (arm === 'E1' ? evaluateForCat : evaluateCorrectedHoleForCat);

/** The 8 frozen baseline strata and their original plans (from the brief). */
export const FROZEN_STRATA: { rootId: string; arm: Arm; plan: string }[] = [
  { rootId: 'G6T3', arm: 'E1', plan: 'RDDD' },
  { rootId: 'G6T3', arm: 'H1', plan: 'RDDD' },
  { rootId: 'G5T4', arm: 'E1', plan: 'RDLU' },
  { rootId: 'G5T4', arm: 'H1', plan: 'RDRR' },
  { rootId: 'G2T8', arm: 'E1', plan: 'DDDR' },
  { rootId: 'G2T8', arm: 'H1', plan: 'DDDR' },
  { rootId: 'G1T9', arm: 'E1', plan: 'LLLD' },
  { rootId: 'G1T9', arm: 'H1', plan: 'LLDL' },
];

export interface FixtureRecord { id: string; state: unknown; canonicalSnapshotSha256: string }
export const fixtureRecords = JSON.parse(readFileSync(FIXTURE, 'utf8')) as FixtureRecord[];
export const fixtureById = new Map(fixtureRecords.map((r) => [r.id, r]));
export const loadRoot = (id: string): GameEngineState => {
  const rec = fixtureById.get(id);
  if (!rec) throw new Error(`fixture root missing: ${id}`);
  return restoreHardRoot(rec.state as never);
};

export interface T1ProofStratum {
  rootId: string; arm: Arm; planString: string; rootStateKey: string;
  postStateKeys: string[]; class: string; boundary: unknown;
  certificates: Record<string, Record<string, {
    value: boolean | null; proofStatus: string; nodes: number; chanceNodes: number;
    chanceOutcomes: number; truncated: boolean; verifyVerdict: string | null;
    policyMisses: number | null; certHash: string; policyEntries: [string, string][] | null;
  }[]>>;
}
export const t1Proof = JSON.parse(readFileSync(T1_PROOF, 'utf8')) as unknown as {
  strata: T1ProofStratum[];
};

export interface ExactD1 {
  arm: Arm;
  planString: string;
  rootActionValues: { action: string; value: number; mate: string | null; bound: string; legalIndex: number }[];
  nodes: number; chanceNodes: number; elapsedMs: number; completed: boolean;
  allBoundsExact: boolean;
  planBranches: Map<string, SearchAction>;
}

/** Fixed D1 EXACT search: TT/AB/ordering OFF, full-window, real legal order. */
export function exactD1(root: GameEngineState, arm: Arm): ExactD1 {
  const ctx = createSearchContext(rules, EXACT_CAP, false, false, false, 0, false);
  ctx.leafEvaluator = leafFor(arm);
  ctx.capturePlan = true;
  const t0 = performance.now();
  const r = searchBestAction(root, 1, ctx);
  const elapsedMs = performance.now() - t0;
  const rootActionValues = ctx.rootValues.map((v, i) => ({
    action: label(v.action), value: v.value, mate: v.mate, bound: v.bound, legalIndex: i,
  }));
  return {
    arm,
    planString: r.catTurnPlan.map((a) => label(a)).join(''),
    rootActionValues,
    nodes: r.diagnostics.nodes,
    chanceNodes: r.diagnostics.chanceNodes,
    elapsedMs,
    completed: r.completed,
    allBoundsExact: rootActionValues.every((v) => v.bound === 'exact'),
    planBranches: ctx.planBranches,
  };
}

export interface WalkResult { labels: string[]; stopped: string }

/** Walk the same exact-D1 principal-line log from a state inside the cat turn. */
export function walkCatPlan(
  planBranches: Map<string, SearchAction>, start: GameEngineState, maxSteps = 16,
): WalkResult {
  let s = start;
  const labels: string[] = [];
  let stopped = 'max_steps';
  for (let i = 0; i < maxSteps; i++) {
    if (s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins) { stopped = 'terminal'; break; }
    if (s.currentPlayer !== PieceType.Cat) { stopped = 'mouse_to_move'; break; }
    const a = planBranches.get(stateKey(s));
    if (!a) { stopped = 'plan_branch_missing'; break; }
    const lab = label(a);
    labels.push(lab);
    const hit = generatePreparedSearchActions(s, rules).find((p) => label(p.action) === lab);
    if (!hit) { stopped = 'illegal_walk_action'; break; }
    const tr = hit.transition;
    if (tr.kind === 'chance') { stopped = 'boundary_chance'; break; }
    s = tr.state;
  }
  return { labels, stopped };
}

export interface AttemptedRootAction {
  rootAction: string;
  rootActionLegalIndex: number;
  rootValue: number;
  rootValueBound: string;
  rootValueMate: string | null;
  continuationSource: string;
  walkStopped: string;
  planString: string;
  planChars: string[];
  firstStepDifferent: boolean;
  replayOk: boolean;
  replayStatus: string;
  replayReason: string | null;
  bindingOk: boolean;
  postStateKeys: string[];
  boundaryKind: string;
  branches: number;
  eligible: boolean;
  rejectReason: string | null;
}

export interface Candidate {
  candidateId: string;
  rootId: string;
  arm: Arm;
  originalPlan: string;
  planString: string;
  planChars: string[];
  rootAction: string;
  rootActionLegalIndex: number;
  rootValue: number;
  rootValueBound: string;
  firstStepDifferent: boolean;
  continuationSource: string;
  walkStopped: string;
  postStateKeys: string[];
  boundary: { chance: boolean; kind: string; branches: number };
  snapshotSha256: string;
  rootStateKey: string;
  planHash: string;
  candidateHash: string;
  replayStatus: string;
  bindingOk: boolean;
  frontierSummary: Record<string, unknown> | null;
  replaySteps: { label: string; transitionKind: string; branches: number }[];
}

type CandidateCore = Omit<Candidate, 'candidateHash'>;

const candidateHash = (c: CandidateCore) => sha256(JSON.stringify({
  rootId: c.rootId, arm: c.arm, originalPlan: c.originalPlan, planString: c.planString,
  rootAction: c.rootAction, rootActionLegalIndex: c.rootActionLegalIndex,
  rootValue: c.rootValue, firstStepDifferent: c.firstStepDifferent,
  postStateKeys: c.postStateKeys, planHash: c.planHash,
}));

export interface CandidateDoc {
  round: string; phase: string; generatedAt: string; generatedBy: string;
  head: string; fixtureSha256: string;
  method: {
    source: 'OFFLINE_REGENERATED_D1';
    search: 'createSearchContext(rules, 8000000, TT=false, AB=false, ordering=false, 0, false) + arm leaf + capturePlan; searchBestAction(root, 1, ctx)';
    continuation: 'same exact-D1 planBranches walk from the post-root-action state; fresh exact-D1 fallback only when a branch key is missing';
    sortFrozenBeforeProofs: [
      'exclude the original finalPlan',
      'complete legal mouse-frontier plans only',
      'different first step first',
      'higher exact root branch value first',
      'tie -> raw legal action order',
      'keep at most 2 per stratum',
    ];
    perStratumMax: number;
    proofsRun: false;
  };
  exactD1: Record<string, { planString: string; nodes: number; elapsedMs: number; completed: boolean; allBoundsExact: boolean; rootActionValues: ExactD1['rootActionValues'] }>;
  strata: {
    rootId: string; arm: Arm; originalPlan: string; originalPlanHash: string;
    originalRootStateKey: string; originalPostStateKeys: string[];
    snapshotSha256: string;
    attempted: AttemptedRootAction[];
    candidates: Candidate[];
    candidateCount: number;
    insufficientReason: string | null;
  }[];
}

export function generateCandidateDoc(): CandidateDoc {
  const doc: CandidateDoc = {
    round: ROUND, phase: 'CANDIDATE_GENERATION_FROZEN', generatedAt: new Date().toISOString(),
    generatedBy: `${OUT}/probe/rescue_lib.ts`,
    head: HEAD, fixtureSha256: FIXTURE_SHA,
    method: {
      source: 'OFFLINE_REGENERATED_D1',
      search: 'createSearchContext(rules, 8000000, TT=false, AB=false, ordering=false, 0, false) + arm leaf + capturePlan; searchBestAction(root, 1, ctx)',
      continuation: 'same exact-D1 planBranches walk from the post-root-action state; fresh exact-D1 fallback only when a branch key is missing',
      sortFrozenBeforeProofs: [
        'exclude the original finalPlan',
        'complete legal mouse-frontier plans only',
        'different first step first',
        'higher exact root branch value first',
        'tie -> raw legal action order',
        'keep at most 2 per stratum',
      ],
      perStratumMax: CAND_MAX,
      proofsRun: false,
    },
    exactD1: {},
    strata: [],
  };

  for (const frozen of FROZEN_STRATA) {
    const t1 = t1Proof.strata.find((s) => s.rootId === frozen.rootId && s.arm === frozen.arm);
    if (!t1) throw new Error(`T1 stratum missing: ${frozen.rootId}/${frozen.arm}`);
    if (t1.planString !== frozen.plan) {
      throw new Error(`frozen baseline mismatch ${frozen.rootId}/${frozen.arm}: T1=${t1.planString} brief=${frozen.plan}`);
    }
    const root = loadRoot(frozen.rootId);
    const rec = fixtureById.get(frozen.rootId)!;
    const exact = exactD1(root, frozen.arm);
    doc.exactD1[`${frozen.rootId}/${frozen.arm}`] = {
      planString: exact.planString, nodes: exact.nodes, elapsedMs: Number(exact.elapsedMs.toFixed(3)),
      completed: exact.completed, allBoundsExact: exact.allBoundsExact,
      rootActionValues: exact.rootActionValues,
    };
    if (!exact.completed) throw new Error(`exact D1 incomplete ${frozen.rootId}/${frozen.arm}`);
    if (!exact.allBoundsExact) throw new Error(`exact D1 bound not exact ${frozen.rootId}/${frozen.arm}`);

    const prepared = generatePreparedSearchActions(root, rules);
    const attempted: AttemptedRootAction[] = [];
    const valid: Candidate[] = [];

    for (const rv of exact.rootActionValues) {
      const idx = prepared.findIndex((p) => label(p.action) === rv.action);
      if (idx < 0) throw new Error(`root action not prepared: ${rv.action}`);
      const hit = prepared[idx];
      const labels = [rv.action];
      let walkStopped = 'root_action_ends_turn';
      let continuationSource = 'root_only';
      if (hit.transition.kind === 'deterministic') {
        const post = hit.transition.state;
        if (post.phase === GamePhase.Playing && post.currentPlayer === PieceType.Cat) {
          const w = walkCatPlan(exact.planBranches, post);
          labels.push(...w.labels);
          walkStopped = w.stopped;
          continuationSource = 'same_exact_d1_plan_branches';
          if (w.stopped === 'plan_branch_missing') {
            const fb = exactD1(post, frozen.arm);
            labels.push(...fb.planString.split(''));
            walkStopped = 'fresh_exact_d1_fallback';
            continuationSource = 'fresh_exact_d1_fallback';
          }
        } else if (post.phase === GamePhase.Playing && post.currentPlayer === PieceType.Mouse) {
          walkStopped = 'mouse_to_move';
          continuationSource = 'root_only';
        } else {
          walkStopped = `terminal:${post.phase}`;
          continuationSource = 'root_only';
        }
      }

      const planString = labels.join('');
      const firstStepDifferent = labels[0] !== frozen.plan[0];
      const rep = replayPlan(root, labels);
      const pre = applyPrefix(root, labels, 0);
      const repKeys = rep.branches.map((b) => b.postStateKey).sort();
      const preKeys = pre.states.map((s) => stateKey(s)).sort();
      const bindingOk = pre.ok && pre.states.length === rep.branches.length
        && repKeys.every((k, i) => k === preKeys[i]);
      const postStateKeys = rep.branches.map((b) => b.postStateKey);
      const boundaryKind = !rep.boundaryChance
        ? 'DETERMINISTIC'
        : rep.branches.length > 1 ? 'MULTI_CHANCE_AND' : 'DEGENERATE_CHANCE_ONE_OUTCOME';
      let rejectReason: string | null = null;
      if (planString === frozen.plan) rejectReason = 'SAME_AS_ORIGINAL_PLAN';
      else if (!rep.ok) rejectReason = rep.reason ?? 'REPLAY_FAILED';
      else if (rep.status !== 'VALID_MOUSE_FRONTIER') rejectReason = `NOT_MOUSE_FRONTIER:${rep.status}`;
      else if (!bindingOk) rejectReason = 'BINDING_MISMATCH';
      else if (postStateKeys.length === 0) rejectReason = 'NO_POST_STATE';
      const eligible = rejectReason === null;

      attempted.push({
        rootAction: rv.action, rootActionLegalIndex: idx, rootValue: rv.value,
        rootValueBound: rv.bound, rootValueMate: rv.mate,
        continuationSource, walkStopped, planString, planChars: labels,
        firstStepDifferent, replayOk: rep.ok, replayStatus: rep.status,
        replayReason: rep.reason, bindingOk, postStateKeys, boundaryKind,
        branches: rep.branches.length, eligible, rejectReason,
      });

      if (eligible) {
        const core: CandidateCore = {
          candidateId: `${frozen.rootId}/${frozen.arm}/C${valid.length + 1}`,
          rootId: frozen.rootId, arm: frozen.arm, originalPlan: frozen.plan,
          planString, planChars: labels, rootAction: rv.action,
          rootActionLegalIndex: idx, rootValue: rv.value, rootValueBound: rv.bound,
          firstStepDifferent, continuationSource, walkStopped, postStateKeys,
          boundary: { chance: rep.boundaryChance, kind: boundaryKind, branches: rep.branches.length },
          snapshotSha256: rec.canonicalSnapshotSha256,
          rootStateKey: stateKey(root), planHash: sha256(planString),
          replayStatus: rep.status, bindingOk,
          frontierSummary: (rep.branches[0]?.summary ?? null) as Record<string, unknown> | null,
          replaySteps: rep.steps,
        };
        valid.push({ ...core, candidateHash: candidateHash(core) });
      }
    }

    valid.sort((a, b) => {
      if (a.firstStepDifferent !== b.firstStepDifferent) return a.firstStepDifferent ? -1 : 1;
      if (b.rootValue !== a.rootValue) return b.rootValue - a.rootValue;
      return a.rootActionLegalIndex - b.rootActionLegalIndex;
    });
    const candidates = valid.slice(0, CAND_MAX).map((c, i) => ({ ...c, candidateId: `${frozen.rootId}/${frozen.arm}/C${i + 1}` }));
    // Recompute hashes after the stable id assignment order (ids do not enter the hash).
    doc.strata.push({
      rootId: frozen.rootId, arm: frozen.arm,
      originalPlan: frozen.plan, originalPlanHash: sha256(frozen.plan),
      originalRootStateKey: t1.rootStateKey, originalPostStateKeys: t1.postStateKeys,
      snapshotSha256: rec.canonicalSnapshotSha256,
      attempted, candidates, candidateCount: candidates.length,
      insufficientReason: candidates.length === 0
        ? (valid.length === 0 ? 'NO_VALID_ALTERNATIVE' : 'UNEXPECTED')
        : candidates.length < CAND_MAX
          ? `ONLY_${candidates.length}_VALID_ALTERNATIVE`
          : null,
    });
  }
  return doc;
}

export function writeCandidateDoc(doc: CandidateDoc): { fileSha256: string; bytes: number } {
  mkdirSync(`${OUT}/_raw`, { recursive: true });
  const path = `${OUT}/CANDIDATE_PLANS.json`;
  const raw = JSON.stringify(doc, null, 1);
  writeFileSync(path, raw);
  const fileSha256 = sha256(raw);
  writeFileSync(`${OUT}/_raw/CANDIDATE_FREEZE.json`, JSON.stringify({
    round: ROUND, frozenAt: new Date().toISOString(),
    path, sha256: fileSha256, bytes: Buffer.byteLength(raw),
    proofsRunBeforeFreeze: false,
    note: 'Candidate list is frozen and hashed BEFORE any H0/H1 quantifier proof.',
  }, null, 1));
  return { fileSha256, bytes: Buffer.byteLength(raw) };
}

// ---------------------------------------------------------------------------
// Proof-side helpers
// ---------------------------------------------------------------------------

export function andOverBranches(recs: SolveRecord[]): boolean | null {
  if (recs.some((r) => r.value === false)) return false;
  if (recs.some((r) => r.value === null)) return null;
  return recs.every((r) => r.value === true) ? true : null;
}
export function allVerified(recs: SolveRecord[]): boolean {
  return recs.length > 0 && recs.every((r) => r.value === true && r.proofStatus === 'PROVEN');
}
export const brief = (r: SolveRecord) => ({
  value: r.value, proofStatus: r.proofStatus,
  nodes: r.nodes, solveMs: Number(r.solveElapsedMs.toFixed(3)),
  chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
  truncated: r.truncated,
  verifyVerdict: r.verifyVerdict, verifyLeaves: r.verify?.leaves ?? null,
  verifyMs: r.verify ? Number(r.verify.elapsedMs.toFixed(3)) : null,
  policyMisses: r.verify?.policyMisses ?? null,
  totalMs: Number((r.solveElapsedMs + (r.verify?.elapsedMs ?? 0)).toFixed(3)),
  within25ms: r.within25ms, withinPhase1: r.withinPhase1,
});

export { rules, label, stateKey, replayPlan, runSolve, applyPrefix };
