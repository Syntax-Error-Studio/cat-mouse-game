/// <reference types="node" />
/**
 * PPC-D2-PCV-COUNTERLINE-01 / G2 — D2 single-root pilot harness (RESEARCH ONLY).
 *
 * Fixed-depth D2, strict config:
 *   createSearchContext(rules, 8_000_000, TT=false, AB=false, ordering=false, 0, false)
 *   + ctx.capturePlan = true
 *   + ctx.leafEvaluator = evaluateForCat          (E1; NOT the default leaf)
 *   + searchBestAction(root, depthTurns=2, ctx)   (non-iterative: one fixed call)
 *
 * NO production source is modified. Everything read from src/ is read-only;
 * candidate extraction / replay / counterline walking / freezing lives here.
 *
 * Reused read-only (by import, never modified):
 *   PPC-T1-PCV-01/probe/pcv_lib.ts            (replayPlan, runSolve, loadRoot, rules, label, stateKey)
 *   PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts (canonicalJson, quantifier kernel)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  createSearchContext, searchBestAction, type SearchContext,
} from '../../src/game/ai/expectiminimax';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import {
  buildCandidate, buildPlanForFirstAction, planFullTurnCompleteness,
  type CandidatePlan, type PlanCompletionVerdict,
} from '../../src/game/ai/planQuality';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { isNoOpAction } from '../../src/game/ai/simulator';
import { hasCertifiableCatMoveBudget, maxCatTurnPlanActions } from '../../src/game/ai/planBound';
import type { GameEngineState } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/expectiminimax';
import { GamePhase, PieceType } from '../../src/game/types';

import {
  rules, label, stateKey, replayPlan, runSolve, loadRoot, summarizeState, fixtureRecords,
} from '../../PPC-T1-PCV-01/probe/pcv_lib';
import { canonicalJson } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

export const ROUND = 'PPC-D2-PCV-COUNTERLINE-01';
export const OUT = 'PPC-D2-PCV-COUNTERLINE-01';
export const ROOT_ID = 'G1T9';
export const ARM: 'E1' | 'H1' = 'E1';
export const DEPTH_TURNS = 2;

export const MAX_NODES = 8_000_000;
export const H0_CAP = 600_000;
export const H1_CAP = 5_000;
export const H0_H = 1;
export const H1_H = 1;
export const START_IDX = 1;

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const stateSha = (s: GameEngineState) => sha256(canonicalJson(s));

/* ------------------------------------------------------------------ */
/* context                                                             */
/* ------------------------------------------------------------------ */

export function makeContext(): SearchContext {
  // 4.1 裁决：唯一正确的 D2 固定深度入口。四个开关全部显式关闭。
  const ctx = createSearchContext(rules, MAX_NODES, false, false, false, 0, false);
  // 铁律：不注入 leafEvaluator 会静默落到 defaultLeafEval（200−5·曼哈顿−60·黄油）。
  ctx.leafEvaluator = evaluateForCat;
  ctx.capturePlan = true;
  return ctx;
}

export function rootPrepared(state: GameEngineState) {
  return generatePreparedSearchActions(state, rules);
}

/* ------------------------------------------------------------------ */
/* rejection classification (task book §6: never silently drop a root) */
/* ------------------------------------------------------------------ */

export type RejectionClass =
  | 'NOT_CAT_TURN_ACTION'
  | 'NO_OP'
  | 'BUDGET_NOT_CERTIFIABLE'
  | 'EMPTY_PLAN'
  | 'INCOMPLETE_PLAN'
  | 'CANDIDATE_NULL_OTHER';

export function classifyRejection(
  root: GameEngineState, action: SearchAction,
): RejectionClass | null {
  const t = (action as { type: string }).type;
  if (t !== 'catStep' && t !== 'catPlaceTrap') return 'NOT_CAT_TURN_ACTION';
  if (isNoOpAction(root, action, rules)) return 'NO_OP';
  if (!hasCertifiableCatMoveBudget(root)) return 'BUDGET_NOT_CERTIFIABLE';
  return null;
}

export function verdictKind(v: PlanCompletionVerdict | null): string {
  return v ? v.kind : 'NOT_EVALUATED';
}

export function isCompleteVerdictKind(kind: string): boolean {
  return kind === 'COMPLETE_TURN_BOUNDARY' || kind === 'COMPLETE_CHANCE_BOUNDARY'
    || kind === 'GAME_ENDED' || kind === 'NO_LEGAL_ACTIONS';
}

/* ------------------------------------------------------------------ */
/* D2 search                                                           */
/* ------------------------------------------------------------------ */

export interface D2Run {
  rootId: string;
  arm: 'E1' | 'H1';
  depthTurns: number;
  config: Record<string, unknown>;
  rootStateKey: string;
  rootSnapshotSha256: string;
  value: number;
  mate: string | null;
  completed: boolean;
  nodes: number;
  leafNodes: number;
  chanceNodes: number;
  elapsedMs: number;
  diagnostics: Record<string, unknown>;
  legalRootActionCount: number;
  rootValuesLength: number;
  rootValues: {
    index: number; action: string; legalIndex: number | null;
    value: number; mate: string | null; bound: string;
  }[];
  rootOrderAligned: boolean;
  rootOrderMismatch: { index: number; searchLabel: string; legalLabel: string }[];
  planBranchEntries: number;
  gates: Record<string, boolean | string>;
}

export function runD2Search(): { root: GameEngineState; ctx: SearchContext; run: D2Run; prepared: ReturnType<typeof rootPrepared> } {
  const root = loadRoot(ROOT_ID);
  const prepared = rootPrepared(root);
  const ctx = makeContext();
  const t0 = performance.now();
  const r = searchBestAction(root, DEPTH_TURNS, ctx);
  const elapsedMs = Number((performance.now() - t0).toFixed(3));

  const legalLabels = prepared.map((p) => label(p.action));
  const legalIndexByLabel = new Map<string, number[]>();
  legalLabels.forEach((l, i) => {
    const arr = legalIndexByLabel.get(l) ?? [];
    arr.push(i);
    legalIndexByLabel.set(l, arr);
  });

  const rootValues = ctx.rootValues.map((x, i) => {
    const lab = label(x.action);
    const hits = legalIndexByLabel.get(lab) ?? [];
    return {
      index: i, action: lab, legalIndex: hits.length === 1 ? hits[0] : (hits[0] ?? null),
      value: x.value, mate: x.mate, bound: x.bound,
    };
  });

  const mismatch: { index: number; searchLabel: string; legalLabel: string }[] = [];
  const n = Math.min(rootValues.length, legalLabels.length);
  for (let i = 0; i < n; i++) {
    if (rootValues[i].action !== legalLabels[i]) {
      mismatch.push({ index: i, searchLabel: rootValues[i].action, legalLabel: legalLabels[i] });
    }
  }

  const d = r.diagnostics as unknown as Record<string, number>;
  const gates: Record<string, boolean | string> = {
    SEARCH_COMPLETED: r.completed === true,
    NO_BUDGET_TRUNCATION: (d.budgetCutoffs ?? -1) === 0,
    NO_DEADLINE_TRUNCATION: (d.deadlineCutoffs ?? -1) === 0,
    NO_EXTENSION_ABORT: (d.extensionAbortCount ?? -1) === 0,
    ROOT_ACTION_COUNT_MATCH: ctx.rootValues.length === prepared.length,
    ROOT_ORDER_ALIGNED: mismatch.length === 0,
    ALL_ROOT_BOUNDS_EXACT: ctx.rootValues.every((x) => x.bound === 'exact'),
    // §4.3 需实测的两条前提
    ZERO_REPETITIONS: (d.repetitions ?? -1) === 0,
    NODE_CAP_NOT_HIT: (d.nodes ?? 0) <= MAX_NODES,
  };

  const run: D2Run = {
    rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS,
    config: {
      searchMode: 'FIXED_DEPTH_D2', useTT: false, useAlphaBeta: false,
      useMoveOrdering: false, useThreatOrdering: false, maxThreatExtensions: 0,
      interceptionQuiescence: 'DISABLED', wallClockDeadline: 'NONE',
      leafEvaluator: 'evaluateForCat (E1)', capturePlan: true,
      maxNodes: MAX_NODES, capPolicy: 'STOP_AND_MARK_UNRESOLVED',
    },
    rootStateKey: stateKey(root),
    rootSnapshotSha256: stateSha(root),
    value: r.value, mate: r.mate, completed: r.completed,
    nodes: d.nodes ?? 0, leafNodes: d.leafNodes ?? 0, chanceNodes: d.chanceNodes ?? 0,
    elapsedMs,
    diagnostics: d,
    legalRootActionCount: prepared.length,
    rootValuesLength: ctx.rootValues.length,
    rootValues,
    rootOrderAligned: mismatch.length === 0,
    rootOrderMismatch: mismatch,
    planBranchEntries: ctx.planBranches.size,
    gates,
  };
  return { root, ctx, run, prepared };
}

/* ------------------------------------------------------------------ */
/* per-root-action candidate extraction                                */
/* ------------------------------------------------------------------ */

export interface CandidateRecord {
  rootId: string;
  arm: 'E1' | 'H1';
  legalIndex: number;
  rootAction: string;
  rootActionValue: number | null;
  rootActionMate: string | null;
  rootActionBound: string | null;

  extracted: boolean;
  rejection: RejectionClass | null;
  planEmptyReason: string | null;

  catTurnPlan: string[];
  planString: string;
  planHash: string;
  planActions: SearchAction[];
  planLength: number;
  planMaxLength: number;

  completenessKind: string;
  completenessOk: boolean;
  planCompleteness: unknown;

  replayOk: boolean;
  replayStatus: string;
  replayReason: string | null;
  replayCrossCheck: boolean;
  replaySteps: { label: string; transitionKind: string; branches: number }[];

  postPrefixStateKey: string;
  postPrefixStateKeys: string[];
  postPrefixCanonicalSnapshot: string;
  postPrefixSnapshotSha256: string;

  chanceBranchCount: number;
  chanceOutcomes: { branchIdx: number; weight: number | null; stateKey: string; terminal: string | null }[];
  chanceProbabilitySum: number | null;
  chanceAllPositive: boolean;

  boundaryEval: number | null;
  reversalCount: number | null;
  revisitCount: number | null;
  uniqueProgress: number | null;

  candidateSource: 'OFFLINE_REGENERATED_D2';
}

export interface ExtractionSummary {
  rootId: string;
  legalRootActions: number;
  extracted: number;
  rejected: number;
  rejectionByClass: Record<string, number>;
  identityFailures: number;
  candidates: CandidateRecord[];
}

export function extractCandidates(
  root: GameEngineState, ctx: SearchContext, prepared: ReturnType<typeof rootPrepared>,
  rootValues: D2Run['rootValues'],
): ExtractionSummary {
  const candidates: CandidateRecord[] = [];
  const rejectionByClass: Record<string, number> = {};
  const maxLength = maxCatTurnPlanActions(root);
  const valueByLabel = new Map<string, D2Run['rootValues'][number]>();
  // 一个 label 可能对应多个合法索引（同格重复），按序取用
  for (const rv of rootValues) if (!valueByLabel.has(rv.action)) valueByLabel.set(rv.action, rv);

  prepared.forEach((p, i) => {
    const lab = label(p.action);
    const rv = valueByLabel.get(lab) ?? null;
    const pre = classifyRejection(root, p.action);

    const base: CandidateRecord = {
      rootId: ROOT_ID, arm: ARM, legalIndex: i, rootAction: lab,
      rootActionValue: rv ? rv.value : null,
      rootActionMate: rv ? rv.mate : null,
      rootActionBound: rv ? rv.bound : null,
      extracted: false, rejection: pre, planEmptyReason: null,
      catTurnPlan: [], planString: '', planHash: '', planActions: [], planLength: 0, planMaxLength: maxLength,
      completenessKind: 'NOT_EVALUATED', completenessOk: false, planCompleteness: null,
      replayOk: false, replayStatus: 'NOT_PERFORMED', replayReason: null, replayCrossCheck: false, replaySteps: [],
      postPrefixStateKey: '', postPrefixStateKeys: [], postPrefixCanonicalSnapshot: '', postPrefixSnapshotSha256: '',
      chanceBranchCount: 0, chanceOutcomes: [], chanceProbabilitySum: null, chanceAllPositive: false,
      boundaryEval: null, reversalCount: null, revisitCount: null, uniqueProgress: null,
      candidateSource: 'OFFLINE_REGENERATED_D2',
    };

    if (pre !== null) {
      rejectionByClass[pre] = (rejectionByClass[pre] ?? 0) + 1;
      candidates.push(base);
      return;
    }

    // 直接走一次 buildPlanForFirstAction，以便区分"空计划"与"不完整计划"
    const planDirect = buildPlanForFirstAction(root, p.action, ctx, maxLength);
    const verdict = planDirect.length > 0 ? planFullTurnCompleteness(root, planDirect, rules) : null;
    const cand: CandidatePlan | null = buildCandidate(root, p.action, ctx, p.originalIndex);

    if (planDirect.length === 0) {
      base.rejection = 'EMPTY_PLAN';
      base.planEmptyReason = 'buildPlanForFirstAction returned []';
      base.completenessKind = verdictKind(verdict);
      rejectionByClass.EMPTY_PLAN = (rejectionByClass.EMPTY_PLAN ?? 0) + 1;
      candidates.push(base);
      return;
    }
    if (verdict && !isCompleteVerdictKind(verdict.kind)) {
      base.rejection = 'INCOMPLETE_PLAN';
      base.completenessKind = verdict.kind;
      base.planCompleteness = verdict;
      rejectionByClass.INCOMPLETE_PLAN = (rejectionByClass.INCOMPLETE_PLAN ?? 0) + 1;
      candidates.push(base);
      return;
    }
    if (cand === null) {
      base.rejection = 'CANDIDATE_NULL_OTHER';
      base.completenessKind = verdictKind(verdict);
      rejectionByClass.CANDIDATE_NULL_OTHER = (rejectionByClass.CANDIDATE_NULL_OTHER ?? 0) + 1;
      candidates.push(base);
      return;
    }

    const planLabels = cand.plan.map((a) => label(a));
    const planString = planLabels.join('');
    const rep = replayPlan(root, planLabels);
    const postKeys = rep.branches.map((b) => b.postStateKey);
    const mainPost = rep.branches[0];

    const weights = rep.branches.map((b) => b.weight);
    const sum = weights.every((w): w is number => typeof w === 'number')
      ? Number(weights.reduce((n, w) => n + w, 0).toFixed(12)) : null;

    candidates.push({
      ...base,
      extracted: true,
      rejection: null,
      catTurnPlan: planLabels,
      planString,
      planHash: sha256(planString),
      planActions: cand.plan,
      planLength: cand.plan.length,
      completenessKind: verdict!.kind,
      completenessOk: true,
      planCompleteness: verdict,
      replayOk: rep.ok,
      replayStatus: rep.status,
      replayReason: rep.reason,
      replayCrossCheck: rep.applyPrefixCrossCheck,
      replaySteps: rep.steps,
      postPrefixStateKey: mainPost ? mainPost.postStateKey : '',
      postPrefixStateKeys: postKeys,
      postPrefixCanonicalSnapshot: mainPost ? canonicalJson(mainPost.summary) : '',
      postPrefixSnapshotSha256: mainPost
        ? sha256(canonicalJson(rep.branches.map((b) => ({ w: b.weight, k: b.postStateKey, s: b.summary }))))
        : '',
      chanceBranchCount: rep.branches.length,
      chanceOutcomes: rep.branches.map((b, bi) => ({
        branchIdx: bi, weight: b.weight, stateKey: b.postStateKey, terminal: b.terminal,
      })),
      chanceProbabilitySum: sum,
      chanceAllPositive: weights.every((w): w is number => typeof w === 'number' && w > 0),
      boundaryEval: cand.boundaryEval,
      reversalCount: cand.reversalCount,
      revisitCount: cand.revisitCount,
      uniqueProgress: cand.uniqueProgress,
    });
  });

  const extracted = candidates.filter((c) => c.extracted).length;
  return {
    rootId: ROOT_ID,
    legalRootActions: prepared.length,
    extracted,
    rejected: candidates.length - extracted,
    rejectionByClass,
    identityFailures: candidates.length - extracted,
    candidates,
  };
}

/* ------------------------------------------------------------------ */
/* principal mouse counterline (source has no mouse walker; new here)   */
/* ------------------------------------------------------------------ */

export interface CounterlineStep {
  step: number;
  fromStateKey: string;
  player: string;
  action: string | null;
  branchOfState: 'DETERMINISTIC' | 'CHANCE';
  outcomes: { weight: number | null; stateKey: string; player: string; catMovesLeft: number; mouseMovesLeft: number; terminal: string | null }[];
  stopReason: string | null;
}

export interface CounterlineResult {
  marker: 'PRINCIPAL_COUNTERLINE_NOT_EXHAUSTIVE_PROOF';
  frontierIndex: number;
  frontierStateKey: string;
  line: string[];
  lineString: string;
  steps: CounterlineStep[];
  reachedCatTurn: boolean;
  terminal: string | null;
  complete: boolean;
  stopReason: string | null;
  missingBranchEntries: string[];
  chanceForkCount: number;
}

export function walkMouseCounterline(
  frontier: GameEngineState, ctx: SearchContext, frontierIndex: number, maxSteps = 16,
): CounterlineResult {
  const line: string[] = [];
  const steps: CounterlineStep[] = [];
  const missing: string[] = [];
  let forks = 0;
  let cur = frontier;
  let complete = false;
  let terminal: string | null = null;
  let stop: string | null = null;

  const termOf = (s: GameEngineState) =>
    s.phase === GamePhase.CatWins ? 'cat' : s.phase === GamePhase.MouseWins ? 'mouse' : null;

  for (let step = 0; step < maxSteps; step++) {
    const t0 = termOf(cur);
    if (t0 !== null) { terminal = t0; complete = true; stop = `TERMINAL_${t0.toUpperCase()}`; break; }
    if (cur.currentPlayer !== PieceType.Mouse) {
      complete = true;
      stop = 'REACHED_CAT_TURN';
      break;
    }
    const key = stateKey(cur);
    const act = ctx.planBranches.get(key);
    if (!act) {
      missing.push(key);
      stop = 'NO_PLAN_BRANCH_ENTRY';
      break;
    }
    const hit = generatePreparedSearchActions(cur, rules).find((p) => label(p.action) === label(act));
    if (!hit) { stop = 'BRANCH_ACTION_ILLEGAL'; break; }
    const tr = hit.transition;
    const isChance = tr.kind === 'chance';
    if (isChance) forks++;
    const outs = isChance
      ? tr.outcomes.map((o) => ({ state: o.state, weight: o.weight as number | null }))
      : [{ state: tr.state, weight: 1 as number | null }];
    line.push(label(act));
    steps.push({
      step,
      fromStateKey: key,
      player: 'mouse',
      action: label(act),
      branchOfState: isChance ? 'CHANCE' : 'DETERMINISTIC',
      outcomes: outs.map((o) => ({
        weight: o.weight,
        stateKey: stateKey(o.state),
        player: String(o.state.currentPlayer),
        catMovesLeft: o.state.catMovesLeft,
        mouseMovesLeft: o.state.mouseMovesLeft,
        terminal: termOf(o.state),
      })),
      stopReason: null,
    });
    // 单结果确定分支继续走；CHANCE 分叉时只沿权重最大的结果继续代表线
    if (outs.length === 1) {
      cur = outs[0].state;
    } else {
      const best = outs.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a), outs[0]);
      cur = best.state;
    }
  }

  return {
    marker: 'PRINCIPAL_COUNTERLINE_NOT_EXHAUSTIVE_PROOF',
    frontierIndex,
    frontierStateKey: stateKey(frontier),
    line,
    lineString: line.join(''),
    steps,
    reachedCatTurn: stop === 'REACHED_CAT_TURN',
    terminal,
    complete,
    stopReason: stop,
    missingBranchEntries: missing,
    chanceForkCount: forks,
  };
}

/* ------------------------------------------------------------------ */
/* PCV proofs (H0 / H1) over ALL positive-probability frontier branches */
/* ------------------------------------------------------------------ */

export interface ProofBranchResult {
  branchIdx: number;
  stateKey: string;
  weight: number | null;
  mode: 'mouseForce' | 'catSurvive';
  value: boolean | null;
  proofStatus: string;
  truncated: boolean;
  nodes: number;
  solveMs: number;
  verifyVerdict: string | null;
  policyMisses: number | null;
  withinPhase1: boolean;
  cap: number;
  H: number;
  startIdx: number;
}

export interface ProofResult {
  mode: 'mouseForce' | 'catSurvive';
  branches: ProofBranchResult[];
  allProven: boolean;
  anyTruncated: boolean;
  anyPolicyMiss: boolean;
  branchCount: number;
  chanceProbSum: number | null;
}

export function runH0(branches: { state: GameEngineState; weight: number | null }[]): ProofResult {
  const out: ProofBranchResult[] = branches.map((b, i) => {
    const rec = runSolve(b.state, 'mouseForce', H0_H, START_IDX, H0_CAP, H0_CAP);
    return {
      branchIdx: i, stateKey: stateKey(b.state), weight: b.weight, mode: 'mouseForce',
      value: rec.value, proofStatus: rec.proofStatus, truncated: rec.truncated,
      nodes: rec.nodes, solveMs: Number(rec.solveElapsedMs.toFixed(3)),
      verifyVerdict: rec.verifyVerdict, policyMisses: rec.verify ? rec.verify.policyMisses : null,
      withinPhase1: rec.withinPhase1, cap: H0_CAP, H: H0_H, startIdx: START_IDX,
    };
  });
  return {
    mode: 'mouseForce',
    branches: out,
    allProven: out.length > 0 && out.every((b) =>
      b.value === true && b.proofStatus === 'PROVEN' && b.truncated === false
      && b.verifyVerdict === 'PROVEN' && (b.policyMisses ?? 1) === 0),
    anyTruncated: out.some((b) => b.truncated),
    anyPolicyMiss: out.some((b) => (b.policyMisses ?? 0) > 0),
    branchCount: out.length,
    chanceProbSum: out.every((b) => typeof b.weight === 'number')
      ? Number(out.reduce((n, b) => n + (b.weight as number), 0).toFixed(12)) : null,
  };
}

export function runH1(branches: { state: GameEngineState; weight: number | null }[]): ProofResult {
  const out: ProofBranchResult[] = branches.map((b, i) => {
    const rec = runSolve(b.state, 'catSurvive', H1_H, START_IDX, H1_CAP, H1_CAP);
    return {
      branchIdx: i, stateKey: stateKey(b.state), weight: b.weight, mode: 'catSurvive',
      value: rec.value, proofStatus: rec.proofStatus, truncated: rec.truncated,
      nodes: rec.nodes, solveMs: Number(rec.solveElapsedMs.toFixed(3)),
      verifyVerdict: rec.verifyVerdict, policyMisses: rec.verify ? rec.verify.policyMisses : null,
      withinPhase1: rec.withinPhase1, cap: H1_CAP, H: H1_H, startIdx: START_IDX,
    };
  });
  return {
    mode: 'catSurvive',
    branches: out,
    allProven: out.length > 0 && out.every((b) =>
      b.value === true && b.proofStatus === 'PROVEN' && b.truncated === false
      && b.verifyVerdict === 'PROVEN' && (b.policyMisses ?? 1) === 0),
    anyTruncated: out.some((b) => b.truncated),
    anyPolicyMiss: out.some((b) => (b.policyMisses ?? 1) > 0),
    branchCount: out.length,
    chanceProbSum: out.every((b) => typeof b.weight === 'number')
      ? Number(out.reduce((n, b) => n + (b.weight as number), 0).toFixed(12)) : null,
  };
}

/* ------------------------------------------------------------------ */
/* deterministic projection (for the two fresh-process repetitions)    */
/* ------------------------------------------------------------------ */

export function determinismProjection(payload: Record<string, unknown>): string {
  const p = payload as {
    run: D2Run; extraction: ExtractionSummary;
  };
  return canonicalJson({
    value: p.run.value, mate: p.run.mate, completed: p.run.completed, nodes: p.run.nodes,
    leafNodes: p.run.leafNodes, chanceNodes: p.run.chanceNodes,
    rootValues: p.run.rootValues.map((r) => [r.index, r.action, r.value, r.mate, r.bound]),
    legalRootActions: p.run.legalRootActionCount,
    planBranchEntries: p.run.planBranchEntries,
    candidates: p.extraction.candidates.map((c) => [
      c.legalIndex, c.rootAction, c.extracted, c.rejection, c.planString,
      c.completenessKind, c.replayStatus, c.postPrefixStateKey, c.chanceBranchCount,
    ]),
  });
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(`${OUT}/logs`, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export { rules, label, stateKey, loadRoot, summarizeState, fixtureRecords, canonicalJson, replayPlan };
