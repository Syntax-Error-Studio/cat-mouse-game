/// <reference types="node" />
/**
 * PPC-CAT-EVALUATOR-ABLATION-01 — shared probe helpers (RESEARCH ONLY).
 *
 * Reuses the previous round's corrected quantifier kernel + independent
 * certificate verifiers BY IMPORT (read-only; never modified):
 *   PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts
 * and the faithful search protocol validated in
 *   PPC-CAT-STRATEGY-SEAL-01/probe/attribution.test.ts
 *
 * NO production source is modified. E1 = evaluateForCat, H1 =
 * evaluateCorrectedHoleForCat are used READ-ONLY. The only instrumented objects
 * are per-search leaf wrappers / counters.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { createSearchContext, searchBestAction, type SearchContext } from '../../src/game/ai/expectiminimax';
import {
  evaluateForCat, evaluateForCatDetailed,
  resetEvaluationCalls, getEvaluationCalls, getMouseBfsCalls, getCatBfsCalls, getCarryMouseBfsCalls,
} from '../../src/game/ai/evaluation';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import type { GameEngineState } from '../../src/game/engine';

// Re-export the reused seal kernel (read-only import; previous round untouched).
export {
  rules, label, stateKey, summarize, renderBoard, canonicalJson, applyNoMoveLoss,
  solve, mouseForcesWinSeal, catSurvivesSeal, catForcesWinSeal,
  verifyCatCertificate, verifyMouseCertificate, classifySeal,
  applyPrefix, prefixVerdict, legalLabels,
  type Mode, type SolveResult, type SolveStats, type CertVerifyResult, type SealClass,
} from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import { rules, label, stateKey, canonicalJson } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

export const ROUND = 'PPC-CAT-EVALUATOR-ABLATION-01';
export const OUT = 'PPC-CAT-EVALUATOR-ABLATION-01';
export const HEAD = '48eaac6c4f3801d351787696ba5876995b64e8d8';
export const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const FROZEN_FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';

// Faithful protocol cap (production AB/TT/ordering path) — NOT the quantifier cap.
export const FAITHFUL_CAP = 400_000;
// Frozen quantifier contract (carried unchanged from the previous round).
export const QCAP = 600_000;
export const H0 = 1;
export const H1 = 2;
export const EPS = 1e-6;

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export interface FixtureRecord { id: string; state: unknown; canonicalSnapshotSha256: string }
export const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as FixtureRecord[];
export const rootIds = records.map((r) => r.id);
export const loadRoot = (id: string): GameEngineState =>
  restoreHardRoot(records.find((r) => r.id === id)!.state as never);
export const snapshotSha = (id: string) => records.find((r) => r.id === id)!.canonicalSnapshotSha256;
export const stateSha = (s: GameEngineState) => sha256(canonicalJson(s));

export type Arm = 'E1' | 'H1';
export const leafFor = (arm: Arm) => (arm === 'E1' ? evaluateForCat : evaluateCorrectedHoleForCat);

export interface FaithfulResult {
  rootId: string; stateKey: string; evaluator: Arm; depth: number;
  rootActionValues: { action: string; value: number; mate: string | null; bound: string }[];
  selectedAction: string; catTurnPlan: string[]; planString: string;
  value: number; mate: string | null; completed: boolean;
  totalNodes: number; leafNodes: number; chanceNodes: number;
  evaluationCalls: number; mouseBfsCalls: number; catBfsCalls: number; carryMouseBfsCalls: number;
  ttHits: number; alphaBetaCutoffs: number; elapsedMs: number;
  allRootBoundsExact: boolean;
}

/**
 * FAITHFUL run — EXACTLY the protocol validated in attribution.test.ts:
 *   createSearchContext(rules, 400000, TT=true, AB=true, ordering=true, 0, false)
 *   + leafEvaluator(E1|H1) + capturePlan, searchBestAction(root, depth, ctx).
 * Fresh SearchContext per call (no cross-arm TT / evalCache sharing). No wall clock.
 */
export function faithfulRun(rootId: string, root: GameEngineState, depth: number, arm: Arm): FaithfulResult {
  const ctx: SearchContext = createSearchContext(rules, FAITHFUL_CAP, true, true, true, 0, false);
  ctx.leafEvaluator = leafFor(arm);
  ctx.capturePlan = true;
  resetEvaluationCalls();
  const t0 = performance.now();
  const r = searchBestAction(root, depth, ctx);
  const elapsedMs = Math.round(performance.now() - t0);
  const planLabels = r.catTurnPlan.map((a) => label(a));
  const rootActionValues = ctx.rootValues.map((x) => ({ action: label(x.action), value: x.value, mate: x.mate, bound: x.bound }));
  return {
    rootId, stateKey: stateKey(root), evaluator: arm, depth,
    rootActionValues,
    selectedAction: label(r.action), catTurnPlan: planLabels, planString: planLabels.join(''),
    value: r.value, mate: r.mate, completed: r.completed,
    totalNodes: r.diagnostics.nodes, leafNodes: r.diagnostics.leafNodes, chanceNodes: r.diagnostics.chanceNodes,
    evaluationCalls: getEvaluationCalls(), mouseBfsCalls: getMouseBfsCalls(),
    catBfsCalls: getCatBfsCalls(), carryMouseBfsCalls: getCarryMouseBfsCalls(),
    ttHits: r.diagnostics.ttHits, alphaBetaCutoffs: r.diagnostics.alphaBetaCutoffs, elapsedMs,
    allRootBoundsExact: rootActionValues.every((x) => x.bound === 'exact'),
  };
}

export { evaluateForCat, evaluateForCatDetailed, evaluateCorrectedHoleForCat,
  resetEvaluationCalls, getEvaluationCalls, getMouseBfsCalls, getCatBfsCalls, getCarryMouseBfsCalls };