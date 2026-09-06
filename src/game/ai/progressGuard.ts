/**
 * G0.4F-2B-1.6 — M3-lite Progress Guard production helper (feature-flagged, DEFAULT OFF).
 *
 * Production re-implementation of the F2B-1.5 frozen prototype semantics. It
 * does NOT import from ai-training/; the math/semantics are reproduced here and
 * verified by the P1 prototype-parity test.
 *
 * What this module is:
 *   - A ROOT-LEVEL rescue policy (like the bounded plan-refutation sidecar).
 *     It never modifies SearchValue / mate / TT / alpha-beta / ordering.
 *   - Guarded by a 7-condition trigger against the *executed* previous cat turn
 *     (HardProgressGuardMemory), so only a REAL repeated no-progress closed
 *     loop with a REAL mouse turn in between can fire.
 *   - Rescue candidate R1 = previousCompletedPlan (from the SAME iterative
 *     search) — never a second main search, never R2 enumeration.
 *
 * Conservative HAS_STRATEGIC_PROGRESS (frozen §17) — any of A..I true ⇒
 * HAS_PROGRESS=true (never a weighted score, never "chase +50" terms):
 *   A. cat wins / captures
 *   B. box layout changed
 *   C. trap state / resource changed
 *   D. blocked tunnel improves
 *   E. ghost denial (cat occupies a pending ghost OR blockedMaterializations++)
 *   F. mouseWinRouteDistance increases
 *   G. mouseReachableArea decreases
 *   H. catMouseDistance decreases
 *   I. corrected raw hole margin improves
 *
 * LoopSignature (frozen §18): (catStart, catEnd, plan, boxLayoutHash, trapState)
 * — deliberately EXCLUDES mouse position (Game5 authority: mouse moved
 * (9,3)→(9,4)→(9,1) while the cat repeated the same ULDR).
 *
 * First-version eligibility (§19): difficulty hard ∧ leafMode
 * 'baseline_hole_corrected' ∧ progressGuard.enabled ∧ mouseHasButter ∧
 * pendingButterSpawns[]==0 ∧ pendingButterPlacementDebt==0 ∧ search.mate==null
 * ∧ completedDepth>=2 ∧ previousCompletedPlan exists.
 */
import type { GameEngineState } from '../engine';
import { PieceType, GamePhase, CellType, Difficulty } from '../types';
import { createEngineRuleSet } from '../engine';
import { evaluateForCatDetailed } from './evaluation';

/** Corrected raw hole-gate margin (mouse−cat; >0 = cat closer to hole gates).
 *  Computed from the shared evaluation features — NOT from the (sign-buggy)
 *  heuristic contribution. */
function holeControlRawMargin(s: GameEngineState): number | null {
  const f = evaluateForCatDetailed(s).features;
  if (f.catHoleGateDistance !== null && f.mouseHoleGateDistance !== null) {
    return f.mouseHoleGateDistance - f.catHoleGateDistance;
  }
  return null;
}

/** Minimal policy memory — NOT a full history, NOT StrategicIntent. */
export interface HardProgressGuardMemory {
  version: 1;
  /** True iff the previous EXECUTED cat turn was a complete, matched
   *  NO_PROGRESS_LOOP (no fallback / plan_exhausted / invalid). */
  previousNoProgressLoop: boolean;
  /** LoopSignature fields of the previous executed turn (null when invalid). */
  previousSignature: LoopSignature | null;
  previousPlanLabel: string;
  previousCatStart: string;
  previousCatEnd: string;
  /** Set TRUE only by the REAL Mouse→Cat endTurn boundary. */
  mouseTurnObserved: boolean;
  /** Debug only (not policy input). */
  previousRootKey?: string;
  previousEndKey?: string;
}

export interface LoopSignature {
  catStart: string;
  catEnd: string;
  plan: string;
  boxHash: string;
  trap: string;
}

export interface ReplayFacts {
  valid: boolean;
  capture: boolean;
  fullTurnConsumed: boolean;
  closedLoop: boolean;
  hasProgress: boolean;
  progressReasons: string[];
  signature: LoopSignature | null;
  noProgressLoop: boolean;
  endState: GameEngineState | null;
}

const rules = createEngineRuleSet();

export function emptyProgressGuardMemory(): HardProgressGuardMemory {
  return {
    version: 1,
    previousNoProgressLoop: false,
    previousSignature: null,
    previousPlanLabel: '',
    previousCatStart: '',
    previousCatEnd: '',
    mouseTurnObserved: false,
  };
}

function boxLayoutHash(s: GameEngineState): string {
  return s.board.map(r => r.map(c => (c.type === CellType.Box ? 'X' : '.')).join('')).join('|');
}
function trapLabel(s: GameEngineState): string {
  return s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : 'none';
}

/** F2B-1.5 §20: iterate the plan's actions with the real search rules. */
export function replayCatPlanLabel(root: GameEngineState, planLabel: string): ReplayFacts {
  const deltas: Record<string, [number, number]> = { U: [-1, 0], D: [1, 0], L: [0, -1], R: [0, 1] };
  let cur = root;
  let capture = false;
  let success = true;
  const steps: { type: 'move' | 'trap'; cell: string }[] = [];
  for (const ch of planLabel) {
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) { success = false; break; }
    if (cur.catMovesLeft <= 0) { success = false; break; }
    if (ch === 'T') {
      const next = rules.catPlaceTrap(cur);
      if (JSON.stringify(next.trapPosition) === JSON.stringify(cur.trapPosition) && cur.trapPosition !== null) { success = false; break; }
      cur = next;
      steps.push({ type: 'trap', cell: `${cur.catPosition.r},${cur.catPosition.c}` });
      continue;
    }
    const d = deltas[ch];
    if (!d) { success = false; break; }
    const dir = { key: `Arrow${ch}`, dr: d[0], dc: d[1], label: ch };
    const next = rules.catMove(cur, dir);
    if (next.phase === GamePhase.CatWins) { capture = true; cur = next; success = true; break; }
    const same = JSON.stringify(next.catPosition) === JSON.stringify(cur.catPosition) && next.catMovesLeft === cur.catMovesLeft;
    if (same) { success = false; break; }
    cur = next;
    steps.push({ type: 'move', cell: `${cur.catPosition.r},${cur.catPosition.c}` });
  }
  const fullTurnConsumed = !capture && success && cur.currentPlayer === PieceType.Cat && cur.catMovesLeft <= 0;
  const startKey = `${root.catPosition.r},${root.catPosition.c}`;
  const endKey = `${cur.catPosition.r},${cur.catPosition.c}`;
  const closedLoop = fullTurnConsumed && endKey === startKey && cur.phase === GamePhase.Playing;
  const progress = analyzeProgress(root, cur, capture);
  return {
    valid: success, capture: capture,
    fullTurnConsumed, closedLoop,
    hasProgress: progress.hasProgress, progressReasons: progress.reasons,
    signature: success && cur.phase === GamePhase.Playing ? {
      catStart: startKey, catEnd: endKey, plan: planLabel,
      boxHash: boxLayoutHash(cur), trap: trapLabel(cur),
    } : null,
    noProgressLoop: closedLoop && !progress.hasProgress,
    endState: cur,
  };
}

/** Conservative strategic progress (frozen §17 A..I). */
export function analyzeProgress(before: GameEngineState, end: GameEngineState, capture: boolean): { hasProgress: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (capture) reasons.push('CAT_WIN');
  if (boxLayoutHash(before) !== boxLayoutHash(end)) reasons.push('BOX_LAYOUT_CHANGED');
  if (trapLabel(before) !== trapLabel(end)) reasons.push('TRAP_STATE_CHANGED');
  const fBefore = evaluateForCatDetailed(before).features;
  const fEnd = evaluateForCatDetailed(end).features;
  if (fEnd.blockedTunnelCount > fBefore.blockedTunnelCount) reasons.push('TUNNEL_BLOCKED');
  const catOnGhost = (end.pendingButterSpawns ?? []).some(g => g.r === end.catPosition.r && g.c === end.catPosition.c);
  const blockedBefore = (before.pendingButterSpawns ?? []).reduce((a, g) => a + g.blockedMaterializations, 0);
  const blockedEnd = (end.pendingButterSpawns ?? []).reduce((a, g) => a + g.blockedMaterializations, 0);
  if (catOnGhost || blockedEnd > blockedBefore) reasons.push('GHOST_DENIED');
  if (fEnd.mouseWinRouteDistance !== null && fBefore.mouseWinRouteDistance !== null && fEnd.mouseWinRouteDistance > fBefore.mouseWinRouteDistance) reasons.push('ROUTE_INCREASED');
  if (fEnd.mouseReachableArea < fBefore.mouseReachableArea) reasons.push('AREA_DECREASED');
  if (fEnd.catMouseDistance !== null && fBefore.catMouseDistance !== null && fEnd.catMouseDistance < fBefore.catMouseDistance) reasons.push('CATMOUSE_DECREASED');
  const hEnd = holeControlRawMargin(end);
  const hBefore = holeControlRawMargin(before);
  if (hEnd !== null && hBefore !== null && hEnd > hBefore) reasons.push('HOLE_MARGIN_IMPROVED');
  return { hasProgress: reasons.length > 0, reasons };
}

export interface ExecutedCatTurnFacts {
  /** True iff the executed turn was clean and complete (no fallback). */
  fullTurnConsumed: boolean;
  /** True iff the executed turn returned the cat to its start cell after
   *  consuming the full move budget while phase stays Playing. */
  closedLoop: boolean;
  hasProgress: boolean;
  progressReasons: string[];
  /** LoopSignature computed from ROOT (catStart) vs FINAL EXEC STATE (catEnd /
   *  box layout / trap) — the plan string is the EXECUTED plan. */
  signature: LoopSignature | null;
  noProgressLoop: boolean;
}

/**
 * G0.4F-2B-1.6R §2/§3: classify an ACTUALLY EXECUTED cat turn from the two
 * real endpoints — the cat-turn root (state at planHardCatTurn time) and the
 * FINAL EXEC state (last executed step). NO re-simulation / replay: every
 * progress metric compares root vs finalExecState directly, and catStart/
 * catEnd come from those two states (not from replaying the plan string).
 *
 * `matchedPlan` is the single execution-truth bit: SEARCH_FALLBACK /
 * plan_exhausted / plan_action_invalid / trajectory fallback → false.
 */
export function classifyExecutedCatTurn(
  root: GameEngineState,
  finalExecState: GameEngineState | null,
  executedPlanLabel: string,
  matchedPlan: boolean,
): ExecutedCatTurnFacts {
  if (!matchedPlan || !finalExecState) {
    return {
      fullTurnConsumed: false, closedLoop: false,
      hasProgress: false, progressReasons: ['NOT_MATCHED'],
      signature: null, noProgressLoop: false,
    };
  }
  const fullTurnConsumed =
    finalExecState.phase === GamePhase.Playing &&
    finalExecState.currentPlayer === PieceType.Cat &&
    finalExecState.catMovesLeft <= 0;
  const startKey = `${root.catPosition.r},${root.catPosition.c}`;
  const endKey = `${finalExecState.catPosition.r},${finalExecState.catPosition.c}`;
  const closedLoop = fullTurnConsumed && endKey === startKey &&
    finalExecState.phase === GamePhase.Playing;
  const progress = analyzeProgress(root, finalExecState, finalExecState.phase === GamePhase.CatWins);
  return {
    fullTurnConsumed, closedLoop,
    hasProgress: progress.hasProgress,
    progressReasons: progress.reasons,
    signature: (finalExecState.phase === GamePhase.Playing) ? {
      catStart: startKey, catEnd: endKey, plan: executedPlanLabel,
      boxHash: boxLayoutHash(finalExecState), trap: trapLabel(finalExecState),
    } : null,
    noProgressLoop: closedLoop && !progress.hasProgress,
  };
}

export function signaturesEqual(a: LoopSignature, b: LoopSignature): boolean {
  return a.catStart === b.catStart && a.catEnd === b.catEnd && a.plan === b.plan && a.boxHash === b.boxHash && a.trap === b.trap;
}

/** First-version eligibility scope (§19). Pure decision gate. */
export function progressGuardEligible(state: GameEngineState, leafMode: string, enabled: boolean, search: { completedDepth: number; mate: string | null; previousCompletedPlanLength: number }): boolean {
  if (!enabled) return false;
  if (String(state.config.difficulty) !== String(Difficulty.Hard)) return false;
  if (leafMode !== 'baseline_hole_corrected') return false;
  if (!state.mouseHasButter) return false;
  if ((state.pendingButterSpawns?.length ?? 0) > 0) return false;
  if ((state.pendingButterPlacementDebt ?? 0) > 0) return false;
  if (search.mate !== null) return false; // mate=cat or mate=mouse → no guard
  if (search.completedDepth < 2) return false;
  if (search.previousCompletedPlanLength <= 0) return false;
  return true;
}

/** §8 trigger: all 7 conditions. */
export function progressGuardTrigger(args: {
  previous: HardProgressGuardMemory | null;
  currentFacts: ReplayFacts;
  realMouseTurnElapsed: boolean;
}): { trigger: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const prev = args.previous;
  if (!prev) reasons.push('NO_PREVIOUS_MEMORY');
  else if (!prev.previousNoProgressLoop) reasons.push('PREV_NOT_NO_PROGRESS_LOOP');
  if (!args.currentFacts.noProgressLoop) reasons.push('CURRENT_NOT_NO_PROGRESS_LOOP');
  if (prev && prev.previousNoProgressLoop && prev.previousSignature && args.currentFacts.signature && !signaturesEqual(prev.previousSignature, args.currentFacts.signature)) reasons.push('SIGNATURE_DIFFERS');
  if (!args.realMouseTurnElapsed) reasons.push('MOUSE_TURN_NOT_OBSERVED');
  const trigger = !!prev && prev.previousNoProgressLoop && !!prev.previousSignature &&
    !!args.currentFacts.signature && signaturesEqual(prev.previousSignature, args.currentFacts.signature) &&
    args.currentFacts.noProgressLoop && args.realMouseTurnElapsed;
  return { trigger, reasons };
}

export interface ProgressGuardDiag {
  enabled: boolean;
  eligible: boolean;
  previousNoProgressLoop: boolean;
  currentNoProgressLoop: boolean;
  signatureMatch: boolean;
  mouseTurnObserved: boolean;
  triggered: boolean;
  previousCompletedDepth: number | null;
  previousCompletedPlan: string;
  originalPlan: string;
  rescuePlan: string;
  exactImmediateMouseWins: number;
  rescueProbeStatus: string | null;
  rescueApplied: boolean;
  abortReason: string;
  guardMs: number;
}

/** NOTE: the following are referenced from tests via these names (parity with
 *  f2b15 signatures). */
export function closedLoopFacts(f: ReplayFacts): boolean { return f.closedLoop; }
export function noProgressLoopFacts(f: ReplayFacts): boolean { return f.noProgressLoop; }