/// <reference types="node" />
/**
 * PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01 — shared harness (RESEARCH ONLY).
 *
 * Root G6T2, ARM E1. Real rules only for the candidate layer:
 *   - enumerateCompleteCatTurns(): every legal complete CAT turn from the root,
 *     via generatePreparedSearchActions (production enumeration + simulator);
 *   - replayTurn(): independent re-application of a plan from the root with the
 *     same real-rule generator (no search, no evaluator);
 *   - frontierState(): canonical full state of the single mouse-boundary state
 *     (or of every positive-probability CHANCE successor).
 * Production source is read only.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { evaluateForCat, evaluateForCatDetailed } from '../../src/game/ai/evaluation';
import { GamePhase, PieceType, CellType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';
import type { SearchAction, RuleSet } from '../../src/game/ai/searchTypes';

import { rules, label, stateKey, canonicalJson, applyNoMoveLoss } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

export const ROUND = 'PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01';
export const OUT = ROUND;
export const PREV_ROUND = 'PPC-G6T2-SELECTION-CAUSE-01';
export const ROOT_ID = 'G6T2';
export const ARM = 'E1';

export const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
export const KERNEL = 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts';
export const KERNEL_SHA = '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b';

export const FROZEN_D2 = {
  nodes: 1_283_054,
  leafNodes: 2_600_863,
  chanceNodes: 7_889,
  value: -658.2105263157898,
  plans: ['UUDD', 'DUUD', 'LUDR'] as string[],
};
export const FROZEN_FORCED = {
  duud: -658.2105263157898,
  drrr: -854,
  delta: -195.78947368421018,
};

export const CONTROL_PLANS = ['UUDD', 'DUUD', 'LUDR', 'UURR', 'DRRR', 'DRDR'] as const;

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const fileSha = (p: string) => (existsSync(p) ? sha256(readFileSync(p)) : null);
export const fullStateSha = (s: GameEngineState) => sha256(canonicalJson(s));

export interface FixtureRecord { id: string; state: unknown; canonicalSnapshotSha256: string }
export const fixtureRecords = JSON.parse(readFileSync(FIXTURE, 'utf8')) as FixtureRecord[];
export const fixtureById = new Map(fixtureRecords.map((r) => [r.id, r]));
export function loadRoot(id: string = ROOT_ID): GameEngineState {
  const rec = fixtureById.get(id);
  if (!rec) throw new Error(`fixture root missing: ${id}`);
  return restoreHardRoot(rec.state as never);
}

export interface Snapshot { [k: string]: unknown }
export function summarize(s: GameEngineState): Snapshot {
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
    pendingButterSpawns: (s.pendingButterSpawns ?? []).map((p) => `${p.r},${p.c}:${p.blockedMaterializations}`),
    pendingButterPlacementDebt: s.pendingButterPlacementDebt ?? 0,
    trapPosition: s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : null,
    catTrapsRemaining: s.catTrapsRemaining,
    blockedTunnels: s.blockedTunnels.map((p) => `${p.r},${p.c}`),
  };
}
export const snapshotSha = (s: GameEngineState) => sha256(canonicalJson(summarize(s)));

export function boxesOf(s: GameEngineState): string[] {
  const out: string[] = [];
  s.board.forEach((row, r) => row.forEach((cell, c) => {
    if (cell.type === CellType.Box) out.push(`${r},${c}`);
  }));
  return out;
}

/** Board identity for "did the cat turn change the board at all" (generic, no coords). */
export function boardSignature(s: GameEngineState): string {
  return canonicalJson({
    cells: s.board.map((row) => row.map((cell) => cell.type)),
    cat: [s.catPosition.r, s.catPosition.c],
    mouse: [s.mousePosition.r, s.mousePosition.c],
    butter: s.butterPositions.map((p) => [p.r, p.c]).sort(),
    trap: s.trapPosition ? [s.trapPosition.r, s.trapPosition.c] : null,
    trapsLeft: s.catTrapsRemaining,
    tunnels: s.blockedTunnels.map((p) => [p.r, p.c]).sort(),
    mouseHasButter: s.mouseHasButter,
    mouseSkillActive: s.mouseSkillActive,
  });
}

/* ------------------------------------------------------------------ */
/* action identity                                                     */
/* ------------------------------------------------------------------ */

export function actionKey(a: SearchAction): string {
  switch (a.type) {
    case 'catStep': return `catStep:${a.direction.key}`;
    case 'catPlaceTrap': return 'catPlaceTrap';
    case 'mouseStep': return `mouseStep:${a.direction.key}`;
    case 'mouseSkill': return 'mouseSkill';
    case 'chooseTunnel': return `chooseTunnel:${a.r},${a.c}`;
  }
}
export const planKey = (p: SearchAction[]) => p.map(actionKey).join('>');
export const planLabel = (p: SearchAction[]) => p.map((a) => label(a as never)).join('');

/* ------------------------------------------------------------------ */
/* complete-turn enumeration (real rules, no search)                   */
/* ------------------------------------------------------------------ */

export interface FrontierRecord {
  key: string;
  fullStateSha256: string;
  snapshotSha256: string;
  player: string;
  phase: string;
  summary: Snapshot;
}

export type EndKind = 'chance' | 'handoff' | 'terminal';

export interface EnumTurn {
  plan: SearchAction[];
  key: string;
  labels: string;
  steps: number;
  endKind: EndKind;
  frontier: FrontierRecord[];
  probabilitySum: number;
  zeroCostActions: number;
}

function frontierOf(states: { state: GameEngineState; weight: number }[]): { frontier: FrontierRecord[]; probabilitySum: number } {
  const frontier = states.map((o) => {
    const s = applyNoMoveLoss(o.state);
    return {
      key: stateKey(s),
      fullStateSha256: fullStateSha(s),
      snapshotSha256: snapshotSha(s),
      player: String(s.currentPlayer),
      phase: String(s.phase),
      summary: summarize(s),
    };
  });
  return { frontier, probabilitySum: Number(states.reduce((acc, o) => acc + o.weight, 0).toFixed(12)) };
}

/**
 * Enumerate EVERY legal complete cat turn from `root`, in generator order.
 * No Top-K, no value ordering, no pruning. A turn ends on:
 *   - a CHANCE hand-off (all positive-probability outcomes kept), or
 *   - a deterministic hand-off to the mouse, or
 *   - a terminal phase.
 * Zero-cost actions (catPlaceTrap keeps the move budget) are handled by the
 * same recursion; `zeroCostActions` counts them per plan.
 */
export function enumerateCompleteCatTurns(root: GameEngineState, maxActions = 12): {
  turns: EnumTurn[];
  skippedNonCat: string[];
  expandedStates: number;
  cyclePruned: string[];
} {
  const turns: EnumTurn[] = [];
  const skippedNonCat = new Set<string>();
  const cyclePruned: string[] = [];
  let expandedStates = 0;

  const walk = (state: GameEngineState, actions: SearchAction[], zeroCost: number, seen: Set<string>) => {
    if (actions.length >= maxActions) throw new Error(`cat turn exceeded ${maxActions} actions at ${planKey(actions)}`);
    expandedStates++;
    // Canonical full-state identity (stateKey does not cover butter bookkeeping;
    // the round-01 audit showed equal keys with different full states).
    const sk = fullStateSha(state);
    // An exact full-state revisit inside one turn has identical successors and
    // identical budget, so its subtree is what the earlier visit already
    // walked. Prune the cycle (recorded), never the legal move itself.
    if (seen.has(sk)) { cyclePruned.push(planKey(actions)); return; }
    const nextSeen = new Set(seen).add(sk);
    const prepared = generatePreparedSearchActions(state, rules);
    for (const p of prepared) {
      const a = p.action;
      if (a.type !== 'catStep' && a.type !== 'catPlaceTrap') { skippedNonCat.add(a.type); continue; }
      const acts = [...actions, a];
      const t = p.transition;
      const cost = a.type === 'catPlaceTrap' ? 1 : 0;
      if (t.kind === 'chance') {
        const pos = t.outcomes.filter((o) => o.weight > 0);
        const { frontier, probabilitySum } = frontierOf(pos);
        turns.push({ plan: acts, key: planKey(acts), labels: planLabel(acts), steps: acts.length, endKind: 'chance', frontier, probabilitySum, zeroCostActions: zeroCost + cost });
        continue;
      }
      const ns = t.state;
      if (ns.phase !== GamePhase.Playing) {
        const { frontier, probabilitySum } = frontierOf([{ state: ns, weight: 1 }]);
        turns.push({ plan: acts, key: planKey(acts), labels: planLabel(acts), steps: acts.length, endKind: 'terminal', frontier, probabilitySum, zeroCostActions: zeroCost + cost });
      } else if (ns.currentPlayer !== PieceType.Cat) {
        const { frontier, probabilitySum } = frontierOf([{ state: ns, weight: 1 }]);
        turns.push({ plan: acts, key: planKey(acts), labels: planLabel(acts), steps: acts.length, endKind: 'handoff', frontier, probabilitySum, zeroCostActions: zeroCost + cost });
      } else {
        walk(ns, acts, zeroCost + cost, nextSeen);
      }
    }
  };

  walk(root, [], 0, new Set());
  return { turns, skippedNonCat: [...skippedNonCat], expandedStates, cyclePruned };
}

/* ------------------------------------------------------------------ */
/* independent replay of one plan (real rules)                         */
/* ------------------------------------------------------------------ */

export interface ReplayTurnResult {
  ok: boolean;
  failedAt: string | null;
  perStep: { step: number; action: string; endKind: string; states: { key: string; fullStateSha256: string }[] }[];
  frontier: FrontierRecord[];
  probabilitySum: number;
  endKind: EndKind | null;
}

export function replayTurn(root: GameEngineState, plan: SearchAction[]): ReplayTurnResult {
  const perStep: ReplayTurnResult['perStep'] = [];
  let cur = applyNoMoveLoss(root);
  let zeroCost = 0;
  for (let i = 0; i < plan.length; i++) {
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) {
      return { ok: false, failedAt: `step ${i}: actor ${cur.currentPlayer} phase ${cur.phase}`, perStep, frontier: [], probabilitySum: 0, endKind: null };
    }
    const prepared = generatePreparedSearchActions(cur, rules);
    const hit = prepared.find((p) => actionKey(p.action) === actionKey(plan[i]));
    if (!hit) {
      return { ok: false, failedAt: `step ${i}: ${actionKey(plan[i])} not legal (legal: ${prepared.map((p) => actionKey(p.action)).join(',')})`, perStep, frontier: [], probabilitySum: 0, endKind: null };
    }
    if (hit.action.type === 'catPlaceTrap') zeroCost++;
    const t = hit.transition;
    if (t.kind === 'chance') {
      if (i !== plan.length - 1) return { ok: false, failedAt: `step ${i}: chance before the final action`, perStep, frontier: [], probabilitySum: 0, endKind: null };
      const pos = t.outcomes.filter((o) => o.weight > 0);
      const { frontier, probabilitySum } = frontierOf(pos);
      perStep.push({ step: i, action: actionKey(hit.action), endKind: 'chance', states: frontier.map((f) => ({ key: f.key, fullStateSha256: f.fullStateSha256 })) });
      return { ok: true, failedAt: null, perStep, frontier, probabilitySum, endKind: 'chance' };
    }
    const ns = t.state;
    perStep.push({ step: i, action: actionKey(hit.action), endKind: String(ns.phase) === String(GamePhase.Playing) ? (ns.currentPlayer === PieceType.Cat ? 'continue' : 'handoff') : 'terminal', states: [{ key: stateKey(ns), fullStateSha256: fullStateSha(ns) }] });
    if (i === plan.length - 1) {
      if (ns.phase !== GamePhase.Playing) {
        const { frontier, probabilitySum } = frontierOf([{ state: ns, weight: 1 }]);
        return { ok: true, failedAt: null, perStep, frontier, probabilitySum, endKind: 'terminal' };
      }
      if (ns.currentPlayer !== PieceType.Cat) {
        const { frontier, probabilitySum } = frontierOf([{ state: ns, weight: 1 }]);
        return { ok: true, failedAt: null, perStep, frontier, probabilitySum, endKind: 'handoff' };
      }
      return { ok: false, failedAt: `plan ended with the cat still to move (moves left ${ns.catMovesLeft})`, perStep, frontier: [], probabilitySum: 0, endKind: null };
    }
    cur = ns;
  }
  return { ok: false, failedAt: 'empty plan', perStep, frontier: [], probabilitySum: 0, endKind: null };
}

/* ------------------------------------------------------------------ */
/* label-blind lightweight features (state-visible only)               */
/* ------------------------------------------------------------------ */

export interface PlanFeatures {
  uniqueProgress: number;
  revisitCount: number;
  zeroCostActions: number;
  boardChangedVsRoot: boolean;
  boxesMovedVsRoot: number | null;
  distanceStart: number;
  distanceEnd: number | null;
  distanceDelta: number | null;
  frontierCount: number;
  chanceOutcomes: number;
  probabilitySum: number;
  endKind: EndKind;
  finalCat: string | null;
  finalMouse: string | null;
  terminal: string | null;
}

function manhattan(a: { r: number; c: number }, b: { r: number; c: number }): number {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

export function planFeatures(root: GameEngineState, turn: EnumTurn): PlanFeatures {
  const cells: string[] = [`${root.catPosition.r},${root.catPosition.c}`];
  let cur = applyNoMoveLoss(root);
  for (const a of turn.plan) {
    const prepared = generatePreparedSearchActions(cur, rules);
    const hit = prepared.find((p) => actionKey(p.action) === actionKey(a));
    if (!hit) throw new Error(`feature replay illegal: ${actionKey(a)}`);
    const t = hit.transition;
    if (t.kind === 'chance') { cur = t.outcomes[0].state; break; }
    cur = t.state;
    const cell = `${cur.catPosition.r},${cur.catPosition.c}`;
    if (cell !== cells[cells.length - 1]) cells.push(cell);
  }
  const final = turn.frontier[0]?.summary as { cat: string; mouse: string } | undefined;
  const rootState = applyNoMoveLoss(root);
  // For CHANCE plans the features describe the FIRST positive-probability
  // successor; `frontierCount` records that other successors exist.
  const endState = turn.plan.length ? lastStateOf(root, turn.plan) : rootState;
  const rootBoxes = boxesOf(rootState);
  const endBoxes = boxesOf(endState);
  const uniqueCells = new Set(cells);
  const endCat = final ? final.cat : null;
  const endMouse = final ? final.mouse : null;
  const catP = (s: string) => { const [r, c] = s.split(',').map(Number); return { r, c }; };
  const dStart = manhattan(root.catPosition, root.mousePosition);
  const dEnd = endCat && endMouse ? manhattan(catP(endCat), catP(endMouse)) : null;
  const rootSig = boardSignature(rootState);
  const endSig = boardSignature(endState);
  return {
    uniqueProgress: uniqueCells.size - 1,
    revisitCount: cells.length - uniqueCells.size,
    zeroCostActions: turn.zeroCostActions,
    boardChangedVsRoot: endSig !== rootSig,
    boxesMovedVsRoot: countDiff(rootBoxes, endBoxes),
    distanceStart: dStart,
    distanceEnd: dEnd,
    distanceDelta: dEnd === null ? null : dStart - dEnd,
    frontierCount: turn.frontier.length,
    chanceOutcomes: turn.endKind === 'chance' ? turn.frontier.length : 0,
    probabilitySum: turn.probabilitySum,
    endKind: turn.endKind,
    finalCat: endCat,
    finalMouse: endMouse,
    terminal: turn.frontier.every((f) => f.phase !== String(GamePhase.Playing)) ? turn.frontier.map((f) => f.phase).join('|') : null,
  };
}

/** Re-apply the plan once more to get its terminal/handoff state (features only). */
function lastStateOf(root: GameEngineState, plan: SearchAction[]): GameEngineState {
  return endStatesOf(root, plan).states[0];
}

/** Apply a complete cat-turn plan; returns every positive-probability end state. */
export function endStatesOf(root: GameEngineState, plan: SearchAction[]): { states: GameEngineState[]; endKind: EndKind } {
  let cur = applyNoMoveLoss(root);
  if (plan.length === 0) throw new Error('empty plan');
  for (let i = 0; i < plan.length; i++) {
    const prepared = generatePreparedSearchActions(cur, rules);
    const hit = prepared.find((p) => actionKey(p.action) === actionKey(plan[i]));
    if (!hit) throw new Error(`endStatesOf illegal: ${actionKey(plan[i])}`);
    const t = hit.transition;
    if (t.kind === 'chance') {
      if (i !== plan.length - 1) throw new Error(`endStatesOf: chance before the final action at ${actionKey(plan[i])}`);
      return { states: t.outcomes.filter((o) => o.weight > 0).map((o) => applyNoMoveLoss(o.state)), endKind: 'chance' };
    }
    const ns = t.state;
    if (i === plan.length - 1) {
      if (ns.phase !== GamePhase.Playing) return { states: [applyNoMoveLoss(ns)], endKind: 'terminal' };
      if (ns.currentPlayer !== PieceType.Cat) return { states: [applyNoMoveLoss(ns)], endKind: 'handoff' };
      throw new Error(`plan ended with the cat still to move (moves left ${ns.catMovesLeft})`);
    }
    cur = ns;
  }
  throw new Error('unreachable');
}

function countDiff(a: string[], b: string[]): number {
  const A = new Set(a); const B = new Set(b);
  let n = 0;
  for (const x of A) if (!B.has(x)) n++;
  for (const x of B) if (!A.has(x)) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* search context (production search, read only)                       */
/* ------------------------------------------------------------------ */

export function makeCtx(capturePlan = true) {
  const ctx = createSearchContext(rules, 8_000_000, false, false, false, 0, false);
  ctx.leafEvaluator = evaluateForCat;
  ctx.capturePlan = capturePlan;
  return ctx;
}
export { createSearchContext, searchBestAction, evaluateForCat, evaluateForCatDetailed };

/* ------------------------------------------------------------------ */
/* io                                                                  */
/* ------------------------------------------------------------------ */

export function ensureDirs() {
  mkdirSync(`${OUT}/logs`, { recursive: true });
}

export function writeJson(path: string, value: unknown) {
  ensureDirs();
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export { rules, label, stateKey, canonicalJson, applyNoMoveLoss };
export type { RuleSet, SearchAction };
