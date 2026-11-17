/// <reference types="node" />
/**
 * PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01 — shared helpers (RESEARCH ONLY).
 *
 * Read-only over the frozen P3/P4/P5/P7 artifacts and the frozen fixture.
 * The quantifier kernel + independent verifiers are imported READ-ONLY from
 * PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts (the same kernel P4 reused).
 * NO production source is modified; NO prior artifact is overwritten.
 *
 * Core erratum distinction:
 *   hardTurnPlanner.planHardCatTurn returns BOTH
 *     - bestAction : root action chosen by the fixed-depth root comparison
 *     - plan       : catTurnPlan, built from planBranches but possibly REPLACED by
 *                    the equal-primary plan extraction (expectiminimax.ts:2019-2023),
 *                    so plan[0] may differ from bestAction while being equal-valued.
 *   The executable / production decision is plan[0] (and, at 100 ms, finalPlan[0]),
 *   NOT bestAction. P7 compared bestAction to the 100 ms executed first action.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { GamePhase, PieceType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';
import {
  rules, label, stateKey, summarize, canonicalJson, applyNoMoveLoss,
  mouseForcesWinSeal, catSurvivesSeal, catForcesWinSeal,
  verifyCatCertificate, verifyMouseCertificate, classifySeal, applyPrefix,
  type CertVerifyResult, type SealClass, type SolveStats, type SolveResult,
} from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

export const ROUND = 'PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01';
export const PREV_ROUND = 'PPC-CAT-EVALUATOR-ABLATION-01';
export const OUT = ROUND;
export const PREV_OUT = PREV_ROUND;
export const HEAD = '48eaac6c4f3801d351787696ba5876995b64e8d8';
export const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const FROZEN_FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
export const QCAP = 600_000;
export const H0 = 1;
export const H1 = 2;

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const ensureOut = () => {
  mkdirSync(`${OUT}/_raw`, { recursive: true });
  mkdirSync(`${OUT}/logs`, { recursive: true });
};
export const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

export interface FixtureRecord {
  id: string; file?: string; line?: number; state: unknown;
  sourceSha256?: string; canonicalSnapshotSha256: string;
}
export const fixtureBytes = readFileSync(FIXTURE);
export const fixtureSha256 = sha256(fixtureBytes);
export const records = JSON.parse(fixtureBytes.toString('utf8')) as FixtureRecord[];
export const rootIds = records.map((r) => r.id);
export const fixtureSnapshotSha = (id: string) => records.find((r) => r.id === id)!.canonicalSnapshotSha256;
/** Exact frozen-root restore (same loader used by P4/P5). */
export const loadRoot = (id: string): GameEngineState =>
  restoreHardRoot(records.find((r) => r.id === id)!.state as never);
export const stateSha = (s: GameEngineState) => sha256(canonicalJson(s));
export const playerName = (s: GameEngineState) => (s.currentPlayer === PieceType.Cat ? 'cat' : 'mouse');

export const ablation = readJson(`${PREV_OUT}/ABLATION_RESULTS.json`);
export const certs = readJson(`${PREV_OUT}/QUANTIFIER_CERTIFICATES.json`);
export const prod = readJson(`${PREV_OUT}/PRODUCTION_100MS_RESULTS.json`);

// ---------------------------------------------------------------------------
// P5 raw rounds → modal real 100 ms plan per root×arm.
// `finalPlan` is the production plan (post sidecar/guard); `executed.label` is
// the ground-truth step trace. The erratum compares finalPlan[0] and also proves
// it equals the first really executed step on every row.
// ---------------------------------------------------------------------------
export interface P5RoundDoc {
  round: number; head: string; fixtureSha256: string;
  rows: {
    rootId: string; arm: 'E1' | 'H1'; stateKey: string; snapshotSha256: string;
    mainSearch: { baselinePlan: string };
    finalPlan: string; finalPlanDebug: string;
    executed: { label: string; fallbackOccurred: boolean | null };
    sidecar: { overrideUsed: boolean } | null;
  }[];
}

export interface P5ComboView {
  rootId: string; arm: 'E1' | 'H1';
  rounds: number;
  plansByRound: string[]; executedByRound: string[];
  stateKeysByRound: string[]; snapshotsByRound: string[];
  modalFinalPlan: string; modalExecuted: string;
  finalPlanConsistent: boolean; executedConsistent: boolean;
  finalPlanEqualsExecutedPrefix: boolean; finalPlanDebugMatches: boolean;
  fallbackRows: number; overrideRows: number;
  rootIdentityConsistent: boolean;
}

export function loadP5Rounds(): { files: string[]; rounds: P5RoundDoc[] } {
  const files = readdirSync(`${PREV_OUT}/_raw`)
    .filter((f) => /^p5_round\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const rounds = files.map((f) => readJson(`${PREV_OUT}/_raw/${f}`) as P5RoundDoc);
  return { files, rounds };
}

const uniq = (xs: string[]) => Array.from(new Set(xs));
const modal = (xs: string[]) => {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return Array.from(c.entries()).sort((a, b) => b[1] - a[1])[0][0];
};

export function p5ModalByCombo(): Map<string, P5ComboView> {
  const { rounds } = loadP5Rounds();
  const out = new Map<string, P5ComboView>();
  for (const id of rootIds) {
    for (const arm of ['E1', 'H1'] as const) {
      const rows = rounds.map((r) => r.rows.find((x) => x.rootId === id && x.arm === arm)!);
      const plans = rows.map((x) => x.finalPlan);
      const execs = rows.map((x) => x.executed.label);
      const stateKeys = rows.map((x) => x.stateKey);
      const snapshots = rows.map((x) => x.snapshotSha256);
      const view: P5ComboView = {
        rootId: id, arm, rounds: rows.length,
        plansByRound: plans, executedByRound: execs,
        stateKeysByRound: stateKeys, snapshotsByRound: snapshots,
        modalFinalPlan: modal(plans), modalExecuted: modal(execs),
        finalPlanConsistent: uniq(plans).length === 1,
        executedConsistent: uniq(execs).length === 1,
        finalPlanEqualsExecutedPrefix: rows.every((x) => x.executed.label.startsWith(x.finalPlan)),
        finalPlanDebugMatches: rows.every((x) => x.finalPlan === x.finalPlanDebug),
        fallbackRows: rows.filter((x) => x.executed.fallbackOccurred === true).length,
        overrideRows: rows.filter((x) => x.sidecar?.overrideUsed === true).length,
        rootIdentityConsistent:
          uniq(stateKeys).length === 1 && uniq(snapshots).length === 1 &&
          snapshots.every((s) => s === fixtureSnapshotSha(id)),
      };
      out.set(`${id}/${arm}`, view);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corrected 24-root table (executable-plan semantics).
// ---------------------------------------------------------------------------
export interface CorrectedRow {
  rootId: string;
  bestActionE1: string; bestActionH1: string; bestActionChanged: boolean;
  d1PlanE1: string; d1PlanH1: string;
  d1FirstE1: string; d1FirstH1: string; d1ExecutableFirstChanged: boolean;
  msPlanE1: string; msPlanH1: string;
  msFirstE1: string; msFirstH1: string; msExecutableFirstChanged: boolean;
  e1D1ToMsFirstReproduced: boolean; h1D1ToMsFirstReproduced: boolean;
  e1FullPlanReproduced: boolean; h1FullPlanReproduced: boolean;
  d1FullPlanChanged: boolean; msFullPlanChanged: boolean;
  certPlanE1: string; certPlanH1: string;
  e1CertCoversActual: boolean; h1CertCoversActual: boolean;
  e1Class: string; e1Proof: string; h1Class: string; h1Proof: string;
  e1ActionChanged: boolean; h1ActionChanged: boolean; planChangedP4: boolean;
}

export function buildCorrectedRows(): CorrectedRow[] {
  const p5 = p5ModalByCombo();
  return rootIds.map((id) => {
    const ab = ablation.roots.find((r: any) => r.rootId === id);
    const e1 = ab.D1.E1.faithful, h1 = ab.D1.H1.faithful;
    const pr = certs.perRoot.find((r: any) => r.rootId === id);
    const p4e = certs.combos.find((c: any) => c.rootId === id && c.arm === 'E1');
    const p4h = certs.combos.find((c: any) => c.rootId === id && c.arm === 'H1');
    const pv = p5.get(`${id}/E1`)!;
    const pvh = p5.get(`${id}/H1`)!;
    const msE1 = pv.modalFinalPlan, msH1 = pvh.modalFinalPlan;
    return {
      rootId: id,
      bestActionE1: e1.selectedAction, bestActionH1: h1.selectedAction,
      bestActionChanged: e1.selectedAction !== h1.selectedAction,
      d1PlanE1: e1.planString, d1PlanH1: h1.planString,
      d1FirstE1: e1.planString[0] ?? '', d1FirstH1: h1.planString[0] ?? '',
      d1ExecutableFirstChanged: (e1.planString[0] ?? '') !== (h1.planString[0] ?? ''),
      msPlanE1: msE1, msPlanH1: msH1,
      msFirstE1: msE1.slice(0, 1), msFirstH1: msH1.slice(0, 1),
      msExecutableFirstChanged: msE1.slice(0, 1) !== msH1.slice(0, 1),
      e1D1ToMsFirstReproduced: (e1.planString[0] ?? '') === msE1.slice(0, 1),
      h1D1ToMsFirstReproduced: (h1.planString[0] ?? '') === msH1.slice(0, 1),
      e1FullPlanReproduced: e1.planString === msE1,
      h1FullPlanReproduced: h1.planString === msH1,
      d1FullPlanChanged: e1.planString !== h1.planString,
      msFullPlanChanged: msE1 !== msH1,
      certPlanE1: p4e.planString, certPlanH1: p4h.planString,
      e1CertCoversActual: p4e.planString === msE1,
      h1CertCoversActual: p4h.planString === msH1,
      e1Class: pr.e1Class, e1Proof: pr.e1Proof,
      h1Class: pr.h1Class, h1Proof: pr.h1Proof,
      e1ActionChanged: pr.actionChanged, h1ActionChanged: pr.actionChanged,
      planChangedP4: pr.planChanged,
    };
  });
}

export interface CorrectedCounts {
  roots: number;
  bestActionChanges: number;
  d1ExecutableFirstChanges: number;
  msExecutableFirstChanges: number;
  msFirstChangeRoots: string[];
  d1ToMsFirstReproducedE1: number;
  d1ToMsFirstReproducedH1: number;
  d1ToMsFirstUnreproducedE1: string[];
  d1ToMsFirstUnreproducedH1: string[];
  d1FullPlanReproducedE1: number;
  d1FullPlanReproducedH1: number;
  d1FullPlanChanged: number;
  msFullPlanChanged: number;
  p7ReportedE1: number;
  p7ReportedH1: number;
}

export function correctedCounts(rows: CorrectedRow[]): CorrectedCounts {
  const n = (k: keyof CorrectedRow) => rows.filter((r) => r[k] === true).length;
  return {
    roots: rows.length,
    bestActionChanges: n('bestActionChanged'),
    d1ExecutableFirstChanges: n('d1ExecutableFirstChanged'),
    msExecutableFirstChanges: n('msExecutableFirstChanged'),
    msFirstChangeRoots: rows.filter((r) => r.msExecutableFirstChanged).map((r) => r.rootId),
    d1ToMsFirstReproducedE1: n('e1D1ToMsFirstReproduced'),
    d1ToMsFirstReproducedH1: n('h1D1ToMsFirstReproduced'),
    d1ToMsFirstUnreproducedE1: rows.filter((r) => !r.e1D1ToMsFirstReproduced).map((r) => r.rootId),
    d1ToMsFirstUnreproducedH1: rows.filter((r) => !r.h1D1ToMsFirstReproduced).map((r) => r.rootId),
    d1FullPlanReproducedE1: n('e1FullPlanReproduced'),
    d1FullPlanReproducedH1: n('h1FullPlanReproduced'),
    d1FullPlanChanged: n('d1FullPlanChanged'),
    msFullPlanChanged: n('msFullPlanChanged'),
    // P7 (_raw/p7_decision.json) compared D1 bestAction to the 100 ms first action.
    p7ReportedE1: 22,
    p7ReportedH1: 22,
  };
}

// ---------------------------------------------------------------------------
// P4/P5 plan↔certificate coverage (all 48 combos, replay-only, no search).
// ---------------------------------------------------------------------------
export interface CoverageRow {
  rootId: string; arm: 'E1' | 'H1';
  certPlan: string; actualPlan: string;
  covered: boolean;
  selectedAction: string;
  rootIdentity: {
    fixtureShaMatchesFrozen: boolean;
    fixtureSnapshotEqualsAblation: boolean;
    fixtureSnapshotEqualsP4: boolean;
    stateKeyEqualsAblation: boolean;
    p5StateKeyConsistent: boolean;
    p5SnapshotConsistent: boolean;
  };
  p4Replay: {
    ok: boolean; branchCount: number; postIdx: number[];
    replayMatchesP4Branches: boolean; branchPostKeys: string[];
  };
  certBindsActualPlan: boolean;
}

export function buildCoverage(): CoverageRow[] {
  const p5 = p5ModalByCombo();
  const out: CoverageRow[] = [];
  for (const id of rootIds) {
    const ab = ablation.roots.find((r: any) => r.rootId === id);
    for (const arm of ['E1', 'H1'] as const) {
      const root = loadRoot(id);
      const p4c = certs.combos.find((c: any) => c.rootId === id && c.arm === arm);
      const pv = p5.get(`${id}/${arm}`)!;
      const pre = applyPrefix(root, p4c.plan as string[], 0);
      const keys = pre.states.map((s) => stateKey(s));
      const wantKeys = p4c.branches.map((b: any) => b.postStateKey);
      const replayMatches =
        pre.ok && pre.states.length === p4c.replay.branchCount &&
        JSON.stringify(keys) === JSON.stringify(wantKeys) &&
        JSON.stringify(pre.idx) === JSON.stringify(p4c.replay.postIdx);
      const covered = p4c.planString === pv.modalFinalPlan;
      const stateKeyNow = stateKey(root);
      out.push({
        rootId: id, arm, certPlan: p4c.planString, actualPlan: pv.modalFinalPlan,
        covered, selectedAction: p4c.selectedAction,
        rootIdentity: {
          fixtureShaMatchesFrozen: fixtureSha256 === FROZEN_FIXTURE_SHA,
          fixtureSnapshotEqualsAblation: fixtureSnapshotSha(id) === ab.snapshotSha256,
          fixtureSnapshotEqualsP4: fixtureSnapshotSha(id) === p4c.snapshotSha256,
          stateKeyEqualsAblation: stateKeyNow === ab.stateKey,
          p5StateKeyConsistent: pv.stateKeysByRound.every((k) => k === ab.stateKey),
          p5SnapshotConsistent: pv.snapshotsByRound.every((s) => s === fixtureSnapshotSha(id)),
        },
        p4Replay: {
          ok: pre.ok, branchCount: pre.states.length, postIdx: pre.idx,
          replayMatchesP4Branches: replayMatches, branchPostKeys: keys,
        },
        certBindsActualPlan: covered && replayMatches,
      });
    }
  }
  return out;
}

export function uncoveredCoverage(cov: CoverageRow[]): CoverageRow[] {
  return cov.filter((c) => !c.certBindsActualPlan);
}

// ---------------------------------------------------------------------------
// Independent CAT-FORCED-WIN verifier (copied from P4's independent probe; no
// production call, no shared combinator with solve). Success = CatWins, never
// derived from ¬MouseWins.
// ---------------------------------------------------------------------------
function realTransitions(s: GameEngineState) {
  return generatePreparedSearchActions(s, rules).map((p) => {
    const tr = p.transition;
    const outcomes = tr.kind === 'deterministic'
      ? [{ state: tr.state, weight: 1 }]
      : tr.outcomes.map((o) => ({ state: o.state, weight: o.weight }));
    return { label: label(p.action), outcomes };
  });
}

export function verifyCatForceCertificate(
  root: GameEngineState, policy: Map<string, string>, H: number, startIdx: number, cap: number,
): CertVerifyResult {
  const t0 = performance.now();
  let leaves = 0, branches = 0, chanceNodes = 0, maxDepth = 0, policyMisses = 0;
  let counterexample: string[] | null = null;
  let reason: string | null = null;
  let exhausted = false;
  const okMemo = new Set<string>();

  const walk = (state: GameEngineState, idx: number, path: string[]): boolean => {
    if (exhausted) return false;
    leaves++;
    if (leaves > cap) { exhausted = true; reason = reason ?? 'NODE_CAP'; return false; }
    if (path.length > maxDepth) maxDepth = path.length;
    const s = applyNoMoveLoss(state);
    if (s.phase === GamePhase.CatWins) return true;
    if (s.phase === GamePhase.MouseWins) {
      if (!counterexample) { counterexample = [...path, 'END:mouse_wins']; reason = 'MOUSE_WINS'; }
      return false;
    }
    const isCat = s.currentPlayer === PieceType.Cat;
    if (isCat && idx >= 2 * H) {
      if (!counterexample) { counterexample = [...path, 'HORIZON']; reason = 'HORIZON_REACHED'; }
      return false;
    }
    const key = `${idx}|${stateKey(s)}`;
    if (isCat) {
      const want = policy.get(key);
      if (want === undefined) {
        policyMisses++;
        if (!counterexample) { counterexample = [...path, `POLICY_MISSING:${key.slice(0, 24)}`]; reason = 'POLICY_MISSING'; }
        return false;
      }
      const trs = realTransitions(s);
      const hit = trs.find((t) => t.label === want);
      if (!hit) {
        policyMisses++;
        if (!counterexample) { counterexample = [...path, `POLICY_ILLEGAL:${want}`]; reason = 'POLICY_ILLEGAL'; }
        return false;
      }
      if (hit.outcomes.length > 1 || hit.outcomes[0].weight !== 1) chanceNodes++;
      const cp = applyNoMoveLoss(hit.outcomes[0].state).currentPlayer;
      const ci = cp !== s.currentPlayer ? idx + 1 : idx;
      for (let i = 0; i < hit.outcomes.length; i++) {
        const o = hit.outcomes[i];
        if (o.weight <= 0) continue;
        if (!walk(o.state, ci, [...path, `c:${want}~chance#${i + 1}`])) return false;
      }
      return true;
    }
    if (okMemo.has(key)) return true;
    branches++;
    const trs = realTransitions(s);
    for (const t of trs) {
      if (t.outcomes.length > 1 || t.outcomes[0].weight !== 1) chanceNodes++;
      const cp = applyNoMoveLoss(t.outcomes[0].state).currentPlayer;
      const ci = cp !== s.currentPlayer ? idx + 1 : idx;
      for (let i = 0; i < t.outcomes.length; i++) {
        const o = t.outcomes[i];
        if (o.weight <= 0) continue;
        if (!walk(o.state, ci, [...path, `m:${t.label}~chance#${i + 1}`])) return false;
      }
    }
    okMemo.add(key);
    return true;
  };

  const ok = walk(root, startIdx, []);
  const verdict = exhausted ? 'UNRESOLVED' : ok ? 'PROVEN' : 'FAILED';
  return { ok, verdict, leaves, branches, chanceNodes, maxDepth, elapsedMs: performance.now() - t0,
    counterexample, reason, policyMisses };
}

// ---------------------------------------------------------------------------
// Detailed real-rule replay of a COMPLETE cat-turn plan.
// ---------------------------------------------------------------------------
export interface FrontierItem { state: GameEngineState; idx: number }
export interface DetailedReplay {
  ok: boolean; failedAt: string | null; plan: string[];
  steps: { index: number; label: string; frontierBefore: number; frontierAfter: number; chance: boolean }[];
  frontier: { postIdx: number; postPlayer: string; postPhase: string; postStateKey: string; postSummary: ReturnType<typeof summarize> }[];
  chanceNodes: number;
  catTurnEnded: boolean;
  catMovesLeftValues: number[];
}

export function replayPlanDetailed(root: GameEngineState, plan: string[]): DetailedReplay {
  let frontier: FrontierItem[] = [{ state: applyNoMoveLoss(root), idx: 0 }];
  const steps: DetailedReplay['steps'] = [];
  let chanceNodes = 0;
  let failedAt: string | null = null;
  for (let i = 0; i < plan.length; i++) {
    const want = plan[i];
    const next: FrontierItem[] = [];
    let stepChance = false;
    for (const f of frontier) {
      const s = f.state;
      if (s.phase !== GamePhase.Playing) { failedAt = `step ${i} ${want}: phase ${s.phase}`; break; }
      if (s.currentPlayer !== PieceType.Cat) { failedAt = `step ${i} ${want}: not cat turn (${playerName(s)})`; break; }
      const hit = generatePreparedSearchActions(s, rules).find((p) => label(p.action) === want);
      if (!hit) { failedAt = `step ${i} ${want}: illegal`; break; }
      const tr = hit.transition;
      if (tr.kind === 'chance') {
        chanceNodes++;
        stepChance = true;
        const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? f.idx + 1 : f.idx;
        for (const o of tr.outcomes) {
          if (o.weight <= 0) continue;
          next.push({ state: applyNoMoveLoss(o.state), idx: ci });
        }
      } else {
        const ci = tr.state.currentPlayer !== s.currentPlayer ? f.idx + 1 : f.idx;
        next.push({ state: applyNoMoveLoss(tr.state), idx: ci });
      }
    }
    if (failedAt) break;
    steps.push({ index: i, label: want, frontierBefore: frontier.length, frontierAfter: next.length,
      chance: stepChance });
    frontier = next;
  }
  if (failedAt) {
    return { ok: false, failedAt, plan, steps, frontier: [], chanceNodes, catTurnEnded: false, catMovesLeftValues: [] };
  }
  const catTurnEnded = frontier.every((f) =>
    f.state.phase !== GamePhase.Playing || f.state.currentPlayer !== PieceType.Cat);
  return {
    ok: true, failedAt: null, plan, steps,
    frontier: frontier.map((f) => ({
      postIdx: f.idx, postPlayer: playerName(f.state), postPhase: String(f.state.phase),
      postStateKey: stateKey(f.state), postSummary: summarize(f.state),
    })),
    chanceNodes, catTurnEnded,
    catMovesLeftValues: frontier.map((f) => f.state.catMovesLeft),
  };
}

// ---------------------------------------------------------------------------
// Independent quantifier certification of an ACTUAL 100 ms plan.
// Four SEPARATE solves per replay branch; definite TRUE labels independently
// verified; CHANCE = AND; terminal before horizon; cap → UNRESOLVED.
// ---------------------------------------------------------------------------
export interface CertRecord {
  certId: string; question: string; horizon: number; side: 'cat' | 'mouse';
  solveNodes: number; solveTruncated: boolean; policySize: number;
  verdict: string; ok: boolean; leaves: number; branches: number; chanceNodes: number;
  maxDepth: number; policyMisses: number; reason: string | null; counterexample: string[] | null;
  verifyElapsedMs: number;
}

export interface PlanCertification {
  rootId: string; arm: 'E1' | 'H1'; planString: string;
  source: string;
  fixtureSha256: string; fixtureSnapshotSha256: string;
  restoredStateKey: string; stateSha: string;
  replay: DetailedReplay;
  applyPrefixCrossCheck: { ok: boolean; branchCount: number; idx: number[]; stateKeysEqual: boolean };
  branches: {
    branchIdx: number; postStateKey: string; postIdx: number; postPlayer: string; postPhase: string;
    postSummary: ReturnType<typeof summarize>;
    h0MouseForcedWin: boolean | null; h1MouseForcedWin: boolean | null;
    h1CatSurvive: boolean | null; h1CatForcedWin: boolean | null;
    stats: Record<string, { nodes: number; truncated: boolean; chanceNodes: number; chanceOutcomes: number; memoHits: number; cutoffs: number; maxIdx: number; elapsedMs: number }>;
    class: SealClass; certificates: CertRecord[];
  }[];
  aggregated: { h0: boolean | null; h1: boolean | null; survive: boolean | null; catForce: boolean | null };
  aggregatedClass: SealClass;
  proofStatus: 'PROVEN' | 'UNRESOLVED' | 'FAILED' | 'REFUTED_BOTH_FORCE';
  certificateCount: number;
  verifier: { verifyFailures: number; certUnresolved: number; definiteTrueLabels: number };
  contract: { H0: number; H1: number; cap: number; chance: string; terminalBeforeHorizon: boolean; capToUnresolved: boolean; noSurvivalFromNegation: boolean };
  elapsedMs: number;
}

const st = (s: SolveStats) => ({
  nodes: s.nodes, truncated: s.truncated, chanceNodes: s.chanceNodes, chanceOutcomes: s.chanceOutcomes,
  memoHits: s.memoHits, cutoffs: s.cutoffs, maxIdx: s.maxIdx, elapsedMs: Math.round(s.elapsedMs),
});

function makeCert(rootId: string, arm: string, planString: string, branchIdx: number, postKey: string,
  question: string, horizon: number, side: 'cat' | 'mouse', solveNodes: number, solveTruncated: boolean,
  policySize: number, v: CertVerifyResult): CertRecord {
  return {
    certId: sha256(`${rootId}|${arm}|${planString}|${branchIdx}|${question}|H${horizon}|${postKey}`).slice(0, 16),
    question, horizon, side, solveNodes, solveTruncated, policySize,
    verdict: v.verdict, ok: v.ok, leaves: v.leaves, branches: v.branches, chanceNodes: v.chanceNodes,
    maxDepth: v.maxDepth, policyMisses: v.policyMisses, reason: v.reason, counterexample: v.counterexample,
    verifyElapsedMs: Math.round(v.elapsedMs),
  };
}

export function certifyPlan(rootId: string, arm: 'E1' | 'H1', planString: string, source: string): PlanCertification {
  const t0 = performance.now();
  const root = loadRoot(rootId);
  const plan = planString.split('');
  const replay = replayPlanDetailed(root, plan);
  if (!replay.ok) throw new Error(`replay failed ${rootId}/${arm} ${planString}: ${replay.failedAt}`);
  const pre = applyPrefix(root, plan, 0);
  const applyPrefixCrossCheck = {
    ok: pre.ok, branchCount: pre.states.length, idx: pre.idx,
    stateKeysEqual: JSON.stringify(pre.states.map((s) => stateKey(s))) ===
      JSON.stringify(replay.frontier.map((f) => f.postStateKey)),
  };

  const branches: PlanCertification['branches'] = [];
  const agg = { h0: true as boolean | null, h1: true as boolean | null, survive: true as boolean | null, catForce: true as boolean | null };
  const andAgg = (cur: boolean | null, v: boolean | null): boolean | null => (cur === null || v === null) ? null : (cur && v);
  let verifyFailures = 0, certUnresolved = 0, definiteTrueLabels = 0;

  replay.frontier.forEach((f, b) => {
    const s = loadPostState(rootId, plan, b);
    if (stateKey(s) !== f.postStateKey) throw new Error(`post-state re-materialization mismatch at branch ${b}`);
    const idx = f.postIdx;
    const postKey = f.postStateKey;
    const h0 = mouseForcesWinSeal(s, H0, idx, QCAP);
    const h1 = mouseForcesWinSeal(s, H1, idx, QCAP);
    const survive = catSurvivesSeal(s, H1, idx, QCAP);
    const catForce = catForcesWinSeal(s, H1, idx, QCAP);
    const certsHere: CertRecord[] = [];
    if (h0.value === true) {
      definiteTrueLabels++;
      const v = verifyMouseCertificate(s, h0.policy, H0, idx, QCAP);
      certsHere.push(makeCert(rootId, arm, planString, b, postKey, 'mouseForce', H0, 'mouse', h0.stats.nodes, h0.stats.truncated, h0.policy.size, v));
    } else if (h1.value === true) {
      definiteTrueLabels++;
      const v = verifyMouseCertificate(s, h1.policy, H1, idx, QCAP);
      certsHere.push(makeCert(rootId, arm, planString, b, postKey, 'mouseForce', H1, 'mouse', h1.stats.nodes, h1.stats.truncated, h1.policy.size, v));
    }
    if (survive.value === true) {
      definiteTrueLabels++;
      const v = verifyCatCertificate(s, survive.policy, H1, idx, QCAP);
      certsHere.push(makeCert(rootId, arm, planString, b, postKey, 'catSurvive', H1, 'cat', survive.stats.nodes, survive.stats.truncated, survive.policy.size, v));
    }
    if (catForce.value === true) {
      definiteTrueLabels++;
      const v = verifyCatForceCertificate(s, catForce.policy, H1, idx, QCAP);
      certsHere.push(makeCert(rootId, arm, planString, b, postKey, 'catForce', H1, 'cat', catForce.stats.nodes, catForce.stats.truncated, catForce.policy.size, v));
    }
    for (const c of certsHere) {
      if (c.verdict === 'FAILED') verifyFailures++;
      else if (c.verdict === 'UNRESOLVED') certUnresolved++;
    }
    agg.h0 = andAgg(agg.h0, h0.value); agg.h1 = andAgg(agg.h1, h1.value);
    agg.survive = andAgg(agg.survive, survive.value); agg.catForce = andAgg(agg.catForce, catForce.value);
    branches.push({
      branchIdx: b, postStateKey: postKey, postIdx: idx, postPlayer: f.postPlayer, postPhase: f.postPhase,
      postSummary: f.postSummary,
      h0MouseForcedWin: h0.value, h1MouseForcedWin: h1.value, h1CatSurvive: survive.value, h1CatForcedWin: catForce.value,
      stats: { h0: st(h0.stats), h1: st(h1.stats), survive: st(survive.stats), catForce: st(catForce.stats) },
      class: classifySeal(h0.value, h1.value, survive.value, catForce.value),
      certificates: certsHere,
    });
  });

  const aggregatedClass = classifySeal(agg.h0, agg.h1, agg.survive, agg.catForce);
  const allCerts = branches.flatMap((b) => b.certificates);
  const hasFailed = allCerts.some((c) => c.verdict === 'FAILED');
  const hasUnresolved = allCerts.some((c) => c.verdict === 'UNRESOLVED');
  let proofStatus: PlanCertification['proofStatus'];
  if (aggregatedClass === 'UNRESOLVED') proofStatus = 'UNRESOLVED';
  else if (hasFailed) proofStatus = 'FAILED';
  else if (hasUnresolved) proofStatus = 'UNRESOLVED';
  else if (aggregatedClass === 'CHANCE_DEPENDENT_OUTCOME') proofStatus = 'REFUTED_BOTH_FORCE';
  else proofStatus = 'PROVEN';

  return {
    rootId, arm, planString, source,
    fixtureSha256: fixtureSha256, fixtureSnapshotSha256: fixtureSnapshotSha(rootId),
    restoredStateKey: stateKey(root), stateSha: stateSha(root),
    replay,
    applyPrefixCrossCheck,
    branches, aggregated: agg, aggregatedClass, proofStatus,
    certificateCount: allCerts.length,
    verifier: { verifyFailures, certUnresolved, definiteTrueLabels },
    contract: {
      H0, H1, cap: QCAP, chance: 'ALL positive-probability outcomes, AND',
      terminalBeforeHorizon: true, capToUnresolved: true, noSurvivalFromNegation: true,
    },
    elapsedMs: Math.round(performance.now() - t0),
  };
}

/** Re-materialize the post-state of branch b through the real rules (same order as replay). */
function loadPostState(rootId: string, plan: string[], branchIdx: number): GameEngineState {
  let frontier: FrontierItem[] = [{ state: applyNoMoveLoss(loadRoot(rootId)), idx: 0 }];
  for (const want of plan) {
    const next: FrontierItem[] = [];
    for (const f of frontier) {
      const s = f.state;
      const hit = generatePreparedSearchActions(s, rules).find((p) => label(p.action) === want)!;
      const tr = hit.transition;
      if (tr.kind === 'chance') {
        const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? f.idx + 1 : f.idx;
        for (const o of tr.outcomes) if (o.weight > 0) next.push({ state: applyNoMoveLoss(o.state), idx: ci });
      } else {
        const ci = tr.state.currentPlayer !== s.currentPlayer ? f.idx + 1 : f.idx;
        next.push({ state: applyNoMoveLoss(tr.state), idx: ci });
      }
    }
    frontier = next;
  }
  return frontier[branchIdx].state;
}

// ---------------------------------------------------------------------------
// H1/G1T3 RRRR reuse audit: exact identity against P4's existing PROVEN cert.
// ---------------------------------------------------------------------------
export interface ReuseAudit {
  rootId: string; arm: 'H1'; planString: string;
  fixtureSha256Matches: boolean;
  p4PlanMatches: boolean;
  p5ActualPlanMatches: boolean;
  p4SnapshotMatches: boolean;
  p5StateKeyMatches: boolean;
  replayPostKeysMatchP4: boolean;
  certIdsMatchP4: boolean;
  p4Class: string;
  p4Proof: string;
  certificateIdsRecomputed: { branchIdx: number; question: string; stored: string; recomputed: string; match: boolean }[];
  reuseEligible: boolean;
  reuseDecision: 'REUSED_P4_PROVEN' | 'REVERIFY_REQUIRED';
}

export function auditH1G1T3Reuse(): ReuseAudit {
  const id = 'G1T3';
  const p4c = certs.combos.find((c: any) => c.rootId === id && c.arm === 'H1');
  const pv = p5ModalByCombo().get(`${id}/H1`)!;
  const ab = ablation.roots.find((r: any) => r.rootId === id);
  const root = loadRoot(id);
  const replay = replayPlanDetailed(root, ['R', 'R', 'R', 'R']);
  const postKeysMatch = replay.ok &&
    JSON.stringify(replay.frontier.map((f) => f.postStateKey)) ===
    JSON.stringify(p4c.branches.map((b: any) => b.postStateKey));
  const certChecks: ReuseAudit['certificateIdsRecomputed'] = [];
  for (const b of p4c.branches) {
    for (const c of b.certificates) {
      const recomputed = sha256(`${id}|H1|${p4c.planString}|${b.branchIdx}|${c.question}|H${c.horizon}|${b.postStateKey}`).slice(0, 16);
      certChecks.push({ branchIdx: b.branchIdx, question: c.question, stored: c.certId, recomputed, match: recomputed === c.certId });
    }
  }
  const checks = {
    fixtureSha256Matches: fixtureSha256 === FROZEN_FIXTURE_SHA,
    p4PlanMatches: p4c.planString === 'RRRR',
    p5ActualPlanMatches: pv.modalFinalPlan === 'RRRR',
    p4SnapshotMatches: p4c.snapshotSha256 === fixtureSnapshotSha(id),
    p5StateKeyMatches: pv.stateKeysByRound.every((k) => k === ab.stateKey) && stateKey(root) === ab.stateKey,
    replayPostKeysMatchP4: postKeysMatch,
    certIdsMatchP4: certChecks.length > 0 && certChecks.every((c) => c.match),
  };
  const reuseEligible = Object.values(checks).every(Boolean);
  return {
    rootId: id, arm: 'H1', planString: 'RRRR',
    ...checks,
    p4Class: p4c.aggregatedClass, p4Proof: p4c.proofStatus,
    certificateIdsRecomputed: certChecks,
    reuseEligible,
    reuseDecision: reuseEligible ? 'REUSED_P4_PROVEN' : 'REVERIFY_REQUIRED',
  };
}

// ---------------------------------------------------------------------------
// Identity snapshots (originals + source). Captured before/after the run to
// prove no prior artifact and no production source changed.
// ---------------------------------------------------------------------------
export const ORIGINAL_ARTIFACTS = [
  `${PREV_OUT}/REPORT.md`,
  `${PREV_OUT}/ABLATION_RESULTS.json`,
  `${PREV_OUT}/QUANTIFIER_CERTIFICATES.json`,
  `${PREV_OUT}/PRODUCTION_100MS_RESULTS.json`,
  `${PREV_OUT}/PERFORMANCE_RESULTS.json`,
  `${PREV_OUT}/ROOT_DECISION_TABLE.csv`,
  `${PREV_OUT}/_raw/p7_decision.json`,
  `${PREV_OUT}/SHA256SUMS.txt`,
  `${PREV_OUT}/SOURCE_MANIFEST.json`,
  `${PREV_OUT}/SEAL_VERIFICATION.json`,
  `PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts`,
  FIXTURE,
];

export const SOURCE_FILES = [
  'src/game/engine.ts',
  'src/game/types.ts',
  'src/game/rules/mobility.ts',
  'src/game/ai/preparedActions.ts',
  'src/game/ai/legalActions.ts',
  'src/game/ai/transposition.ts',
  'src/game/ai/hardTurnPlanner.ts',
  'src/game/ai/expectiminimax.ts',
  'src/game/ai/hardHistory.ts',
  'src/game/ai/planQuality.ts',
  'src/game/ai/searchConfig.ts',
  'src/game/ai/evaluation.ts',
  'src/game/ai/correctedHoleLeaf.ts',
  'src/game/ai/hybridLeaf.ts',
  'src/game/ai/deadlineContext.ts',
];

export interface FileIdentity { path: string; sha256: string; bytes: number; mtimeIso: string }

export function fileIdentity(path: string): FileIdentity {
  const b = readFileSync(path);
  const st = statSync(path);
  return { path, sha256: sha256(b), bytes: b.length, mtimeIso: st.mtime.toISOString() };
}

export function snapshotIdentity() {
  return {
    capturedAt: new Date().toISOString(),
    head: HEAD,
    fixtureSha256,
    originals: ORIGINAL_ARTIFACTS.map(fileIdentity),
    sources: SOURCE_FILES.map(fileIdentity),
  };
}

export function writeCsv(path: string, rows: Record<string, unknown>[], header: string[]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(','), ...rows.map((r) => header.map((h) => esc(r[h])).join(','))];
  writeFileSync(path, lines.join('\n') + '\n');
}
