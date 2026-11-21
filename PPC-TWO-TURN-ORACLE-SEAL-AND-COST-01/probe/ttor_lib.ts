/// <reference types="node" />
/**
 * PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01 — shared harness (RESEARCH ONLY).
 *
 * Reuses read-only:
 *   - the frozen SEAL quantifier kernel   PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts
 *   - the frozen shadow tool              PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.ts
 *   - the real production transitions     generatePreparedSearchActions + createEngineRuleSet
 *
 * No production source, no previous artifact and no frozen contract is modified.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { stateKey } from '../../src/game/ai/transposition';
import { GamePhase, PieceType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';
import {
  rules, label, applyNoMoveLoss,
  mouseForcesWinSeal, catSurvivesSeal,
  verifyMouseCertificate, verifyCatCertificate,
  type CertVerifyResult, type SolveResult,
} from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import { mouseTwoTurnRisk, mouseOneTurnRisk } from '../../PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib';

export const ROUND = 'PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01';
export const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
export const SEAL_KERNEL = 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts';
export const SEAL_KERNEL_SHA = '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b';
export const STRATEGY_KERNEL = 'PPC-CAT-STRATEGY-01/probe/lib.ts';
export const STRATEGY_KERNEL_SHA = 'f8cae0ac4fca93330d170fa3fe2e072729b402fc18442016ce069f80f8ee0264';
export const SHADOW_LIB = 'PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.ts';
export const SHADOW_LIB_SHA = 'e0780fff270f45e17c32406261e51f55480feb4824af4112a902353bf6e7a654';

/** Frozen correctness cap for the H2 offline proof (never lowered). */
export const QCAP = 600_000;
/** Fast H1 layer (PCV phase-1 contract): a diagnostic, never a certificate. */
export const CHEAP_NODE_CAP = 5_000;
export const CHEAP_WALL_MS = 20;

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const hashFile = (p: string) => sha256(readFileSync(p));

interface RootRecord { id: string; state: unknown; canonicalSnapshotSha256: string }
const records = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RootRecord[];
const byId = new Map(records.map((r) => [r.id, r]));
export function loadRoot(id: string): GameEngineState {
  const rec = byId.get(id);
  if (!rec) throw new Error(`fixture root missing: ${id}`);
  return restoreHardRoot(rec.state as never);
}
export function rootSnapshotSha(id: string): string {
  const rec = byId.get(id);
  if (!rec) throw new Error(`fixture root missing: ${id}`);
  return rec.canonicalSnapshotSha256;
}

export interface Frontier {
  planString: string;
  planLabels: string[];
  states: GameEngineState[];
  weights: number[];
  chanceSteps: number;
  positiveOutcomes: number;
  totalOutcomes: number;
  frontierStateKeys: string[];
  validMouseFrontier: boolean;
  ineligibleReason: string | null;
}

/**
 * Replay a plan from a frozen root with the real RuleSet and return every
 * positive-probability successor of the final transition.
 * A frontier is valid only if EVERY branch is a live mouse hand-off
 * (playing, mouse to move, cat budget exhausted).
 */
export function replayToFrontier(rootId: string, plan: string): Frontier {
  const root = loadRoot(rootId);
  let states = [applyNoMoveLoss(root)];
  let weights = [1];
  let chanceSteps = 0;
  let positiveOutcomes = 0;
  let totalOutcomes = 0;

  for (const ch of plan) {
    const next: GameEngineState[] = [];
    const nw: number[] = [];
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (s.phase !== GamePhase.Playing) throw new Error(`plan ${plan}: continues after terminal`);
      const hit = generatePreparedSearchActions(s, rules).find((p) => label(p.action) === ch);
      if (!hit) throw new Error(`plan ${plan}: illegal action ${ch}`);
      const tr = hit.transition;
      if (tr.kind === 'deterministic') {
        next.push(applyNoMoveLoss(tr.state));
        nw.push(weights[i]);
      } else {
        chanceSteps++;
        totalOutcomes += tr.outcomes.length;
        for (const o of tr.outcomes) {
          if (o.weight <= 0) continue;
          positiveOutcomes++;
          next.push(applyNoMoveLoss(o.state));
          nw.push(weights[i] * o.weight);
        }
      }
    }
    states = next;
    weights = nw;
  }

  let reason: string | null = null;
  for (const s of states) {
    if (s.phase !== GamePhase.Playing) { reason = `phase=${s.phase}`; break; }
    if (s.currentPlayer !== PieceType.Mouse) { reason = `player=${s.currentPlayer}`; break; }
    if (s.catMovesLeft > 0) { reason = `catMovesLeft=${s.catMovesLeft}`; break; }
  }
  if (states.length === 0) reason = 'NO_POSITIVE_SUCCESSOR';

  return {
    planString: plan,
    planLabels: plan.split(''),
    states,
    weights,
    chanceSteps,
    positiveOutcomes,
    totalOutcomes,
    frontierStateKeys: states.map((s) => stateKey(s)),
    validMouseFrontier: reason === null,
    ineligibleReason: reason,
  };
}

export function summarizeState(s: GameEngineState) {
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

export interface ProofRun {
  mode: 'mouseForce' | 'catSurvive';
  H: number;
  startIdx: number;
  cap: number;
  value: boolean | null;
  truncated: boolean;
  nodes: number;
  transitions: number;
  chanceNodes: number;
  chanceOutcomes: number;
  memoHits: number;
  cutoffs: number;
  maxIdx: number;
  elapsedMs: number;
  verify: CertVerifyResult | null;
  proofStatus: 'PROVEN' | 'NO_WIN' | 'UNKNOWN';
  policySize: number;
  /** Raw certificate map; kept in memory only, never serialized. */
  policy: Map<string, string>;
}

/**
 * One independent proof run: exact quantifier over the real RuleSet, then (only
 * when a forced win is claimed) the independent certificate verifier, which
 * re-enumerates every opponent action and every positive-probability CHANCE
 * outcome and never prunes.
 */
export function runProof(
  frontier: GameEngineState,
  mode: 'mouseForce' | 'catSurvive',
  H: number,
  startIdx: number,
  cap: number,
  verifyCap = QCAP,
): ProofRun {
  const t0 = performance.now();
  const r: SolveResult = mode === 'mouseForce'
    ? mouseForcesWinSeal(frontier, H, startIdx, cap)
    : catSurvivesSeal(frontier, H, startIdx, cap);
  const solveMs = performance.now() - t0;

  let verify: CertVerifyResult | null = null;
  if (r.value === true) {
    verify = mode === 'mouseForce'
      ? verifyMouseCertificate(frontier, r.policy, H, startIdx, verifyCap)
      : verifyCatCertificate(frontier, r.policy, H, startIdx, verifyCap);
  }

  let proofStatus: ProofRun['proofStatus'];
  if (r.value === null || r.stats.truncated) proofStatus = 'UNKNOWN';
  else if (r.value === false) proofStatus = 'NO_WIN';
  else if (verify && verify.verdict === 'PROVEN') proofStatus = 'PROVEN';
  else proofStatus = 'UNKNOWN'; // FAILED / UNRESOLVED never upgrade a claim

  return {
    mode, H, startIdx, cap,
    value: r.value,
    truncated: r.stats.truncated,
    nodes: r.stats.nodes,
    transitions: r.stats.transitions,
    chanceNodes: r.stats.chanceNodes,
    chanceOutcomes: r.stats.chanceOutcomes,
    memoHits: r.stats.memoHits,
    cutoffs: r.stats.cutoffs,
    maxIdx: r.stats.maxIdx,
    elapsedMs: solveMs,
    verify,
    proofStatus,
    policySize: r.policy.size,
    policy: r.policy,
  };
}

/** Cheapest layer: one mouse turn, phase-1 cap. Timing is environment-sensitive. */
export function cheapOneTurn(frontier: GameEngineState) {
  const t0 = performance.now();
  const r = mouseForcesWinSeal(frontier, 1, 1, CHEAP_NODE_CAP);
  const ms = performance.now() - t0;
  return {
    H: 1, startIdx: 1, cap: CHEAP_NODE_CAP,
    value: r.value, truncated: r.stats.truncated, nodes: r.stats.nodes,
    elapsedMs: ms, withinCheapBudget: r.stats.nodes <= CHEAP_NODE_CAP && ms <= CHEAP_WALL_MS,
  };
}

/**
 * Example winning line produced from a proven mouse-force certificate.
 * At mouse (∃) nodes it follows the policy; at cat and CHANCE nodes it walks the
 * first child that still verifies. This is an existential witness for a reader,
 * NOT a proof — the proof is the verifier's re-enumeration.
 */
export function witnessLine(
  frontier: GameEngineState, policy: Map<string, string>, H: number, startIdx: number,
): { line: string[]; finalPhase: string; ok: boolean; reason: string | null } {
  const key = (s: GameEngineState, idx: number) => `${idx}|${stateKey(s)}`;
  type Walk = { v: 'win' | 'lose' | 'open'; path: string[] };

  // Functional: every CHANCE outcome is verified, but only ONE path is kept,
  // so the printed line is a real single variation.
  const walk = (s0: GameEngineState, idx: number, depth: number): Walk => {
    if (depth > 256) return { v: 'open', path: [] };
    const s = applyNoMoveLoss(s0);
    if (s.phase === GamePhase.MouseWins) return { v: 'win', path: [] };
    if (s.phase === GamePhase.CatWins) return { v: 'lose', path: [] };
    if (s.currentPlayer === PieceType.Cat && idx >= 2 * H) return { v: 'open', path: [] };

    const prepared = generatePreparedSearchActions(s, rules);
    const isMouse = s.currentPlayer === PieceType.Mouse;
    const chosen = isMouse ? policy.get(key(s, idx)) : null;
    const ordered = chosen ? prepared.filter((p) => label(p.action) === chosen) : prepared;
    if (ordered.length === 0) return { v: 'open', path: [] };

    for (const p of ordered) {
      const tr = p.transition;
      const kids = tr.kind === 'deterministic'
        ? [{ state: tr.state }]
        : tr.outcomes.filter((o) => o.weight > 0).map((o) => ({ state: o.state }));
      if (kids.length === 0) continue;
      const ci = kids[0].state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
      const results = kids.map((k) => walk(k.state, ci, depth + 1));
      if (results.every((r) => r.v === 'win')) {
        const step = `${isMouse ? 'm:' : 'c:'}${label(p.action)}${tr.kind === 'chance' ? '(chance)' : ''}`;
        return { v: 'win', path: [step, ...results[0].path] };
      }
    }
    return { v: 'open', path: [] };
  };

  const res = walk(frontier, startIdx, 0);
  return {
    line: res.path,
    finalPhase: res.v === 'win' ? 'mouse_wins_by_reconstruction' : res.v,
    ok: res.v === 'win',
    reason: res.v === 'win' ? null : `WITNESS_NOT_CLOSED:${res.v}`,
  };
}

export interface LayerCost {
  label: string;
  nodes: number;
  elapsedMs: number;
  peakRssMB: number;
  truncated: boolean;
  value: boolean | null;
  proofStatus: string | null;
}

export interface HostResource {
  totalMB: number; freeMB: number;
  vitestProcesses: number; vitestOutOfTree: number; foreignNodeProcesses: number;
}
export function hostResource(): HostResource {
  try {
    const raw = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/scripts/host_probe.ps1 -SelfPid ${process.pid}`,
      { encoding: 'utf8', timeout: 60_000 },
    ).trim().split(/\r?\n/).map((x) => Number(x.trim()));
    return { totalMB: raw[0], freeMB: raw[1], vitestProcesses: raw[2], vitestOutOfTree: raw[3], foreignNodeProcesses: raw[4] };
  } catch {
    return { totalMB: -1, freeMB: -1, vitestProcesses: -1, vitestOutOfTree: -1, foreignNodeProcesses: -1 };
  }
}

/** Duplicate heavy runner = a vitest process outside this run's own process tree. */
export function duplicateHeavyWorkers(r: HostResource): number {
  return Math.max(0, r.vitestOutOfTree);
}

let peak = 0;
export function resetPeakRss() { peak = process.memoryUsage().rss; }
export function peakRssMB() { return Math.round((Math.max(peak, process.memoryUsage().rss) / 1048576) * 10) / 10; }

/** Shadow (non-authoritative) re-run, used only to check reproduction. */
export function shadowReference(frontier: GameEngineState) {
  const t0 = performance.now();
  const two = mouseTwoTurnRisk(frontier);
  const twoMs = performance.now() - t0;
  const t1 = performance.now();
  const one = mouseOneTurnRisk(frontier);
  const oneMs = performance.now() - t1;
  return {
    two: { value: two.value, nodes: two.nodes, truncated: two.truncated, witnessMs: two.witnessMs, elapsedMs: twoMs },
    one: {
      forcedWinThisTurn: one.forcedWinThisTurn,
      existsWinningChanceOutcome: one.existsWinningChanceOutcome,
      nodes: one.nodes, truncated: one.truncated, elapsedMs: oneMs,
    },
  };
}

export { rules, label, applyNoMoveLoss, stateKey };