/// <reference types="node" />
/**
 * PPC-T1-PCV-01 — plan-scoped counter-line verification (RESEARCH ONLY).
 *
 * Reuses the frozen SEAL-01 quantifier kernel READ-ONLY:
 *   PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts
 * and the real production transition source through
 *   generatePreparedSearchActions + createEngineRuleSet
 * exactly as the seal kernel already does.
 *
 * This file modifies NO production source and NO previous-round artifact.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { GamePhase, PieceType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';
import {
  rules, label, stateKey, applyNoMoveLoss, applyPrefix,
  mouseForcesWinSeal, catSurvivesSeal,
  verifyMouseCertificate, verifyCatCertificate,
  type SolveResult, type CertVerifyResult,
} from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

export const ROUND = 'PPC-T1-PCV-01';
export const REPO = 'F:\\小猫小鼠';
export const HEAD = '48eaac6c4f3801d351787696ba5876995b64e8d8';
export const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
export const P5_PATH = 'PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json';
export const P5_SHA = '9d50560f107da52107cb68be94f4ac90214f8a50aabbc948f8f3114215278775';
export const KERNEL_PATH = 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts';
export const KERNEL_SHA = '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b';
export const GAMEPLAY_PATH = 'GAMEPLAY.md';
export const GAMEPLAY_SHA = 'e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34';
export const PREPARED_PATH = 'src/game/ai/preparedActions.ts';
export const PREPARED_SHA = '67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764';

export const QCAP = 600_000;      // frozen correctness cap (NOT to be lowered)
export const PCV_TARGET_MS = 25;  // offline feasibility target only
export const PHASE1_NODE_CAP = 5_000;
export const PHASE1_WALL_MS = 20;

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const hashFile = (p: string) => sha256(readFileSync(p));

export interface FixtureRecord { id: string; state: unknown; canonicalSnapshotSha256: string }
export const fixtureRecords = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown as FixtureRecord[];
export const fixtureById = new Map(fixtureRecords.map((r) => [r.id, r]));
export const loadRoot = (id: string): GameEngineState => {
  const rec = fixtureById.get(id);
  if (!rec) throw new Error(`fixture root missing: ${id}`);
  return restoreHardRoot(rec.state as never);
};
export const snapshotSha = (id: string) => {
  const rec = fixtureById.get(id);
  if (!rec) throw new Error(`fixture root missing: ${id}`);
  return rec.canonicalSnapshotSha256;
};

export interface P5Combo {
  rootId: string; arm: string; roundsUsed: number;
  executedLabels: string[]; finalPlans: string[]; baselinePlans: string[];
  finalConsistent: boolean; executedConsistent: boolean;
  completedDepth: { min: number; max: number };
  attemptedDepth: { min: number; max: number };
  turnWallMs: { min: number; max: number };
  mainElapsedMs: { min: number; max: number };
  fallbackCount: number; overrideCount: number; matchedPlanCount: number;
}
export const p5 = JSON.parse(readFileSync(P5_PATH, 'utf8')) as unknown as {
  combos: P5Combo[];
  fixtureSha256: string;
  head: string;
  summary: Record<string, unknown>;
};

export type FrontierStatus =
  | 'VALID_MOUSE_FRONTIER'
  | 'TERMINAL_CAT_WIN'
  | 'TERMINAL_MOUSE_WIN'
  | 'MIXED_TERMINAL'
  | 'INELIGIBLE'
  | 'INCONSISTENT';

export interface FrontierBranch {
  branchIdx: number;
  weight: number;
  postStateKey: string;
  phase: string;
  player: string | null;
  catMovesLeft: number | null;
  mouseMovesLeft: number | null;
  summary: Record<string, unknown>;
  terminal: 'cat' | 'mouse' | null;
}

export interface ReplayResult {
  ok: boolean;
  failedAt: string | null;
  planString: string;
  planChars: string[];
  planConsistent: boolean;
  executedConsistent: boolean;
  rootStateKey: string;
  snapshotSha256: string;
  status: FrontierStatus;
  lastTransitionKind: string;
  boundaryChance: boolean;
  branches: FrontierBranch[];
  steps: { label: string; transitionKind: string; branches: number }[];
  applyPrefixCrossCheck: boolean;
  reason: string | null;
}

export function summarizeState(s: GameEngineState): Record<string, unknown> {
  return {
    phase: s.phase,
    currentPlayer: s.currentPlayer,
    cat: `${s.catPosition.r},${s.catPosition.c}`,
    mouse: `${s.mousePosition.r},${s.mousePosition.c}`,
    catMovesLeft: s.catMovesLeft,
    mouseMovesLeft: s.mouseMovesLeft,
    mouseHasButter: s.mouseHasButter,
    mouseSkillActive: s.mouseSkillActive,
    butterPositions: s.butterPositions.map((p) => `${p.r},${p.c}`),
    pendingButterSpawns: (s.pendingButterSpawns ?? []).map((p) => `${p.r},${p.c}`),
    pendingButterPlacementDebt: s.pendingButterPlacementDebt ?? 0,
    trapPosition: s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : null,
    catTrapsRemaining: s.catTrapsRemaining,
    blockedTunnels: s.blockedTunnels.map((p) => `${p.r},${p.c}`),
  };
}

function terminalOf(s: GameEngineState): 'cat' | 'mouse' | null {
  if (s.phase === GamePhase.CatWins) return 'cat';
  if (s.phase === GamePhase.MouseWins) return 'mouse';
  return null;
}

/**
 * Replay the FINAL_SELECTED_PLAN from the restored root with the real RuleSet.
 * The transition source is the same `generatePreparedSearchActions` used by the
 * quantifier and by production search, so a plan that production executes is
 * replayed through the same legality and end-turn semantics.
 */
export function replayPlan(root: GameEngineState, planChars: string[]): Omit<ReplayResult,
  'planConsistent' | 'executedConsistent' | 'planString' | 'snapshotSha256' | 'rootStateKey'> {
  const rootKey = stateKey(root);
  let frontier: { state: GameEngineState; idx: number; weight: number }[] = [
    { state: applyNoMoveLoss(root), idx: 0, weight: 1 },
  ];
  const steps: { label: string; transitionKind: string; branches: number }[] = [];
  let lastKind = 'none';

  for (const lab of planChars) {
    const next: { state: GameEngineState; idx: number; weight: number }[] = [];
    let stepKind = 'deterministic';
    for (const f of frontier) {
      if (f.state.phase !== GamePhase.Playing) {
        return { ok: false, failedAt: `${lab} (phase ${f.state.phase})`, status: 'INELIGIBLE',
          lastTransitionKind: lastKind, boundaryChance: false, branches: [], steps,
          applyPrefixCrossCheck: false, reason: 'PLAN_CONTINUES_AFTER_TERMINAL' };
      }
      const hit = generatePreparedSearchActions(f.state, rules).find((p) => label(p.action) === lab);
      if (!hit) {
        return { ok: false, failedAt: `${lab} (illegal)`, status: 'INELIGIBLE',
          lastTransitionKind: lastKind, boundaryChance: false, branches: [], steps,
          applyPrefixCrossCheck: false, reason: 'ILLEGAL_PLAN_ACTION' };
      }
      const tr = hit.transition;
      const kids = tr.kind === 'chance'
        ? tr.outcomes.map((o) => ({ state: applyNoMoveLoss(o.state), weight: o.weight }))
        : [{ state: applyNoMoveLoss(tr.state), weight: 1 }];
      if (tr.kind === 'chance') stepKind = 'chance';
      const childPlayer = kids[0].state.currentPlayer;
      const ci = childPlayer !== f.state.currentPlayer ? f.idx + 1 : f.idx;
      for (const k of kids) next.push({ state: k.state, idx: ci, weight: f.weight * k.weight });
    }
    frontier = next;
    lastKind = stepKind;
    steps.push({ label: lab, transitionKind: stepKind, branches: next.length });
  }

  const terminals = frontier.map((f) => terminalOf(f.state));
  const allTerminal = terminals.length > 0 && terminals.every((t) => t !== null);
  const anyTerminal = terminals.some((t) => t !== null);
  const allMouse = frontier.every((f) =>
    f.state.phase === GamePhase.Playing
    && f.state.currentPlayer === PieceType.Mouse
    && f.state.catMovesLeft <= 0);
  const allCatWins = allTerminal && terminals.every((t) => t === 'cat');
  const allMouseWins = allTerminal && terminals.every((t) => t === 'mouse');

  let status: FrontierStatus;
  let reason: string | null = null;
  if (allMouse) status = 'VALID_MOUSE_FRONTIER';
  else if (allCatWins) status = 'TERMINAL_CAT_WIN';
  else if (allMouseWins) status = 'TERMINAL_MOUSE_WIN';
  else if (anyTerminal) { status = 'MIXED_TERMINAL'; reason = 'MIXED_TERMINAL_BRANCHES'; }
  else {
    status = 'INELIGIBLE';
    reason = `NOT_MOUSE_FRONTIER phase=${frontier.map((f) => f.state.phase).join('|')} player=${frontier.map((f) => f.state.currentPlayer).join('|')}`;
  }

  const branches: FrontierBranch[] = frontier.map((f, i) => ({
    branchIdx: i,
    weight: f.weight,
    postStateKey: stateKey(f.state),
    phase: f.state.phase,
    player: f.state.currentPlayer ?? null,
    catMovesLeft: f.state.catMovesLeft ?? null,
    mouseMovesLeft: f.state.mouseMovesLeft ?? null,
    summary: summarizeState(f.state),
    terminal: terminalOf(f.state),
  }));

  // Cross-check against the frozen applyPrefix implementation (same plan, same
  // startIdx=0). The result must agree on number and stateKey of every branch.
  const pre = applyPrefix(root, planChars, 0);
  const preKeys = pre.states.map((s) => stateKey(s)).sort();
  const ownKeys = frontier.map((f) => stateKey(f.state)).sort();
  const crossCheck = pre.ok && preKeys.length === ownKeys.length
    && preKeys.every((k, i) => k === ownKeys[i]);

  return {
    ok: true, failedAt: null, status, lastTransitionKind: lastKind,
    boundaryChance: steps[steps.length - 1]?.transitionKind === 'chance' || frontier.length > 1,
    branches, steps, applyPrefixCrossCheck: crossCheck, reason,
  };
}

export interface SolveRecord {
  mode: string;
  H: number;
  startIdx: number;
  cap: number;
  value: boolean | null;
  nodes: number;
  transitions: number;
  chanceNodes: number;
  chanceOutcomes: number;
  memoHits: number;
  cutoffs: number;
  truncated: boolean;
  maxIdx: number;
  solveElapsedMs: number;
  verify: CertVerifyResult | null;
  verifyOk: boolean | null;
  verifyVerdict: string | null;
  policySize: number;
  policyEntries: [string, string][] | null;
  proofStatus: string;
  within25ms: boolean;
  withinPhase1: boolean;
}

export function runSolve(
  frontier: GameEngineState,
  mode: 'mouseForce' | 'catSurvive',
  H: number,
  startIdx: number,
  cap: number,
  verifierCap: number,
): SolveRecord {
  const t0 = performance.now();
  const r: SolveResult = mode === 'mouseForce'
    ? mouseForcesWinSeal(frontier, H, startIdx, cap)
    : catSurvivesSeal(frontier, H, startIdx, cap);
  const solveElapsedMs = performance.now() - t0;

  let verify: CertVerifyResult | null = null;
  let verifyOk: boolean | null = null;
  let verifyVerdict: string | null = null;
  if (r.value === true) {
    verify = mode === 'mouseForce'
      ? verifyMouseCertificate(frontier, r.policy, H, startIdx, verifierCap)
      : verifyCatCertificate(frontier, r.policy, H, startIdx, verifierCap);
    verifyOk = verify.ok;
    verifyVerdict = verify.verdict;
  }

  let proofStatus: string;
  if (r.value === null || r.stats.truncated) proofStatus = 'UNRESOLVED_CAP';
  else if (r.value === false) proofStatus = 'NOT_PROVEN';
  else if (verify && verify.verdict === 'PROVEN') proofStatus = 'PROVEN';
  else if (verify && verify.verdict === 'FAILED') proofStatus = 'VERIFY_FAILED';
  else proofStatus = 'UNRESOLVED_VERIFIER';

  const totalMs = solveElapsedMs + (verify?.elapsedMs ?? 0);
  return {
    mode, H, startIdx, cap,
    value: r.value,
    nodes: r.stats.nodes, transitions: r.stats.transitions,
    chanceNodes: r.stats.chanceNodes, chanceOutcomes: r.stats.chanceOutcomes,
    memoHits: r.stats.memoHits, cutoffs: r.stats.cutoffs,
    truncated: r.stats.truncated, maxIdx: r.stats.maxIdx,
    solveElapsedMs,
    verify, verifyOk, verifyVerdict,
    policySize: r.policy.size,
    policyEntries: r.value === true ? [...r.policy.entries()] : null,
    proofStatus,
    within25ms: totalMs <= PCV_TARGET_MS,
    // Prereg phase1 cap applies to the SOLVE (node cap + wall cap); the
    // independent verifier is a separate offline audit cost.
    withinPhase1: r.stats.nodes <= PHASE1_NODE_CAP && solveElapsedMs <= PHASE1_WALL_MS,
  };
}

export { rules, label, stateKey, applyNoMoveLoss, applyPrefix };
