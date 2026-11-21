/// <reference types="node" />
/**
 * PPC-G6T2-SELECTION-CAUSE-01 — shared harness (RESEARCH ONLY).
 *
 * Root G6T2, ARM E1, fixed-depth D2, read-only on production source.
 *
 * - replayDetailed(): real-rule replay of one cat-turn plan with full per-step
 *   state/transition detail (no search).
 * - makeCtx()/makeObservedCtx(): production search and the isolated observed
 *   copy (probe/expectiminimax_observed.ts) with E1 + capturePlan.
 * - identity/digest helpers shared by every probe.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { generatePreparedSearchActions, type PreparedSearchAction } from '../../src/game/ai/preparedActions';
import { createSearchContext, type SearchContext } from '../../src/game/ai/expectiminimax';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { GamePhase, PieceType, CellType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';

import {
  createSearchContext as createObservedContext,
  searchBestAction as observedSearchBestAction,
} from './expectiminimax_observed';

import { rules, label, stateKey, applyNoMoveLoss, canonicalJson } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

export const ROUND = 'PPC-G6T2-SELECTION-CAUSE-01';
export const OUT = ROUND;
export const PREV_ROUND = 'PPC-D2-PCV-COUNTERLINE-02';
export const ROOT_ID = 'G6T2';
export const ARM = 'E1';
export const DEPTH_TURNS = 2;
export const MAX_NODES = 8_000_000;

export const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
export const KERNEL = 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts';
export const KERNEL_SHA = '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b';

/** Frozen D2 facts from PPC-D2-PCV-COUNTERLINE-02 (the parity target). */
export const FROZEN_D2 = {
  nodes: 1_283_054,
  leafNodes: 2_600_863,
  chanceNodes: 7_889,
  value: -658.2105263157898,
  planBranchEntries: 39_462,
  plans: ['UUDD', 'DUUD', 'LUDR'] as string[],
  rootValues: { U: -658.2105263157898, D: -658.2105263157898, L: -658.2105263157898 },
};

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const fileSha = (p: string) => (existsSync(p) ? sha256(readFileSync(p)) : null);
export const fullStateJson = (s: GameEngineState) => canonicalJson(s);
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

/** Terrain cells of a given type, as "r,c" strings (boxes are terrain). */
export function cellsOfType(s: GameEngineState, type: string): string[] {
  const out: string[] = [];
  s.board.forEach((row, r) => row.forEach((cell, c) => {
    if (cell.type === type) out.push(`${r},${c}`);
  }));
  return out;
}
export const boxesOf = (s: GameEngineState) => cellsOfType(s, CellType.Box);

export interface ActionInfo {
  label: string; type: string; direction: string | null; r: number | null; c: number | null;
}
export function actionInfo(a: SearchAction): ActionInfo {
  return {
    label: label(a),
    type: a.type,
    direction: (a as { direction?: { key: string } }).direction?.key ?? null,
    r: (a as { r?: number }).r ?? null,
    c: (a as { c?: number }).c ?? null,
  };
}

export interface StateDetail {
  stateKey: string;
  fullStateSha256: string;
  snapshotSha256: string;
  player: string;
  summary: Snapshot;
  boxes: string[];
}

export function detail(s: GameEngineState): StateDetail {
  return {
    stateKey: stateKey(s),
    fullStateSha256: fullStateSha(s),
    snapshotSha256: snapshotSha(s),
    player: String(s.currentPlayer),
    summary: summarize(s),
    boxes: boxesOf(s),
  };
}

/* ------------------------------------------------------------------ */
/* real-rule replay (no search)                                        */
/* ------------------------------------------------------------------ */

export interface ReplayOutcome {
  weight: number;
  stateKey: string;
  fullStateSha256: string;
  snapshotSha256: string;
  player: string;
  playerChanged: boolean;
  cat: string;
  mouse: string;
  catMovesLeft: number;
  mouseMovesLeft: number;
  boxesAfter: string[];
  boxesMoved: boolean;
  boxesRemoved: string[];
  boxesAdded: string[];
  trapBefore: string | null;
  trapAfter: string | null;
  butterBefore: string[];
  butterAfter: string[];
  summary: Snapshot;
}

export interface ReplayBranch {
  fromStateKey: string;
  from: StateDetail;
  action: ActionInfo;
  actionIndexInPrepared: number;
  preparedLabels: string[];
  transitionKind: string;
  weightIn: number;
  boxesBefore: string[];
  outcomes: ReplayOutcome[];
}

export interface ReplayStep {
  step: number;
  label: string;
  actionTypes: string[];
  chance: boolean;
  probabilitySum: number | null;
  branchCount: number;
  branches: ReplayBranch[];
}

export interface PlanReplay {
  ok: boolean;
  failedAt: string | null;
  reason: string | null;
  steps: ReplayStep[];
  frontier: { weight: number; detail: StateDetail }[];
  finalFullSha256: string[];
  finalSnapshotSha256: string[];
  frontierStatus: string;
  probeScope: string[];
  stateHistoryKeys: string[];
  repeatedStates: { key: string; firstStep: number; againStep: number }[];
  finalEqualsRoot: boolean;
  finalEqualsRootSettled: boolean;
  catReturnedButStateChanged: boolean;
  changedFieldsVsRoot: string[];
}

const terminalOf = (s: GameEngineState): string | null =>
  s.phase === GamePhase.CatWins ? 'cat' : s.phase === GamePhase.MouseWins ? 'mouse' : null;

export function replayDetailed(root: GameEngineState, planLabels: string[]): PlanReplay {
  const rootDetail = detail(applyNoMoveLoss(root));
  let frontier: { state: GameEngineState; weight: number; key: string }[] = [
    { state: applyNoMoveLoss(root), weight: 1, key: rootDetail.stateKey },
  ];
  const steps: ReplayStep[] = [];
  const history: { key: string; step: number }[] = [{ key: rootDetail.stateKey, step: -1 }];

  for (let i = 0; i < planLabels.length; i++) {
    const lab = planLabels[i];
    const next: { state: GameEngineState; weight: number; key: string }[] = [];
    const branches: ReplayBranch[] = [];
    let chance = false;
    let probSum = 0;
    for (const f of frontier) {
      if (f.state.phase !== GamePhase.Playing) {
        return fail(`step ${i} ${lab}: phase ${f.state.phase}`);
      }
      const prepared: PreparedSearchAction[] = generatePreparedSearchActions(f.state, rules);
      const hitIdx = prepared.findIndex((p) => label(p.action) === lab);
      if (hitIdx < 0) return fail(`step ${i} ${lab}: illegal (legal: ${prepared.map((p) => label(p.action)).join(',')})`);
      const hit = prepared[hitIdx];
      const tr = hit.transition;
      if (tr.kind === 'chance') chance = true;
      const rawKids = tr.kind === 'chance'
        ? tr.outcomes.map((o) => ({ state: applyNoMoveLoss(o.state), weight: o.weight as number }))
        : [{ state: applyNoMoveLoss(tr.state), weight: 1 }];
      const boxesBefore = boxesOf(f.state);
      const trapBefore = f.state.trapPosition ? `${f.state.trapPosition.r},${f.state.trapPosition.c}` : null;
      const butterBefore = f.state.butterPositions.map((p) => `${p.r},${p.c}`);
      const outcomes: ReplayOutcome[] = rawKids.map((k) => {
        const boxesAfter = boxesOf(k.state);
        probSum += k.weight;
        history.push({ key: stateKey(k.state), step: i });
        next.push({ state: k.state, weight: f.weight * k.weight, key: stateKey(k.state) });
        return {
          weight: k.weight,
          stateKey: stateKey(k.state),
          fullStateSha256: fullStateSha(k.state),
          snapshotSha256: snapshotSha(k.state),
          player: String(k.state.currentPlayer),
          playerChanged: String(k.state.currentPlayer) !== String(f.state.currentPlayer),
          cat: `${k.state.catPosition.r},${k.state.catPosition.c}`,
          mouse: `${k.state.mousePosition.r},${k.state.mousePosition.c}`,
          catMovesLeft: k.state.catMovesLeft,
          mouseMovesLeft: k.state.mouseMovesLeft,
          boxesAfter,
          boxesMoved: boxesAfter.join('|') !== boxesBefore.join('|'),
          boxesRemoved: boxesBefore.filter((b) => !boxesAfter.includes(b)),
          boxesAdded: boxesAfter.filter((b) => !boxesBefore.includes(b)),
          trapBefore,
          trapAfter: k.state.trapPosition ? `${k.state.trapPosition.r},${k.state.trapPosition.c}` : null,
          butterBefore,
          butterAfter: k.state.butterPositions.map((p) => `${p.r},${p.c}`),
          summary: summarize(k.state),
        };
      });
      branches.push({
        fromStateKey: f.key,
        from: detail(f.state),
        action: actionInfo(hit.action),
        actionIndexInPrepared: hitIdx,
        preparedLabels: prepared.map((p) => label(p.action)),
        transitionKind: tr.kind,
        weightIn: f.weight,
        boxesBefore,
        outcomes,
      });
    }
    frontier = next;
    steps.push({
      step: i, label: lab,
      actionTypes: [...new Set(branches.map((b) => b.action.type))],
      chance, probabilitySum: Number(probSum.toFixed(12)),
      branchCount: next.length,
      branches,
    });
  }

  const rep = findRepeats(history);
  const finalKeys = frontier.map((f) => f.key);
  const finalShas = frontier.map((f) => fullStateSha(f.state));
  const rootSettled = detail(applyNoMoveLoss(root));
  const finalEqualsRoot = finalShas.every((x) => x === rootDetail.fullStateSha256);
  const finalEqualsRootSettled = finalShas.every((x) => x === rootSettled.fullStateSha256);
  const catReturned = frontier.every((f) =>
    `${f.state.catPosition.r},${f.state.catPosition.c}` === rootDetail.summary.cat);
  const changedFields = frontier.length === 1
    ? diffFields(rootSettled.summary as Record<string, unknown>, summarize(frontier[0].state))
    : ['(multiple frontier branches)'];
  const terminals = frontier.map((f) => terminalOf(f.state));
  const frontierStatus = terminals.every((t) => t !== null)
    ? `TERMINAL:${terminals.join('|')}`
    : frontier.every((f) => f.state.phase === GamePhase.Playing && f.state.currentPlayer === PieceType.Mouse && f.state.catMovesLeft <= 0)
      ? 'VALID_MOUSE_FRONTIER'
      : 'NOT_MOUSE_FRONTIER';

  return {
    ok: true, failedAt: null, reason: null,
    steps,
    frontier: frontier.map((f) => ({ weight: f.weight, detail: detail(f.state) })),
    finalFullSha256: finalShas,
    finalSnapshotSha256: frontier.map((f) => snapshotSha(f.state)),
    frontierStatus,
    probeScope: finalKeys,
    stateHistoryKeys: history.map((h) => h.key),
    repeatedStates: rep,
    finalEqualsRoot,
    finalEqualsRootSettled,
    catReturnedButStateChanged: catReturned && !finalEqualsRoot && !finalEqualsRootSettled,
    changedFieldsVsRoot: changedFields,
  };

  function fail(reason: string): PlanReplay {
    return {
      ok: false, failedAt: reason, reason, steps, frontier: [], finalFullSha256: [], finalSnapshotSha256: [],
      frontierStatus: 'REPLAY_FAILED', probeScope: [], stateHistoryKeys: history.map((h) => h.key),
      repeatedStates: [], finalEqualsRoot: false, finalEqualsRootSettled: false,
      catReturnedButStateChanged: false, changedFieldsVsRoot: [],
    };
  }
}

function diffFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function findRepeats(history: { key: string; step: number }[]): { key: string; firstStep: number; againStep: number }[] {
  const first = new Map<string, number>();
  const out: { key: string; firstStep: number; againStep: number }[] = [];
  const seenAgain = new Set<string>();
  for (const h of history) {
    const f = first.get(h.key);
    if (f === undefined) first.set(h.key, h.step);
    else if (!seenAgain.has(h.key)) { seenAgain.add(h.key); out.push({ key: h.key, firstStep: f, againStep: h.step }); }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* search contexts (production + observed copy)                        */
/* ------------------------------------------------------------------ */

export function makeCtx(capturePlan = true): SearchContext {
  const ctx = createSearchContext(rules, MAX_NODES, false, false, false, 0, false);
  ctx.leafEvaluator = evaluateForCat;
  ctx.capturePlan = capturePlan;
  return ctx;
}

export function makeObservedCtx(capturePlan = true): SearchContext {
  const ctx = createObservedContext(rules, MAX_NODES, false, false, false, 0, false);
  ctx.leafEvaluator = evaluateForCat;
  ctx.capturePlan = capturePlan;
  return ctx;
}

export { observedSearchBestAction, generatePreparedSearchActions };

/* ------------------------------------------------------------------ */
/* io                                                                  */
/* ------------------------------------------------------------------ */

export function ensureDirs() {
  mkdirSync(`${OUT}/logs`, { recursive: true });
  mkdirSync(`${OUT}/probe`, { recursive: true });
}

export function writeJson(path: string, value: unknown) {
  ensureDirs();
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** deterministic projection over observed nodes (visit-independent). */
export function observedProjection(nodes: { key: string; depthTurns: number; ply: number; actions: { label: string; originalIndex: number; value: number; mate: string | null; bound: string }[]; choiceLabel: string | null; resultValue: number | null }[]): string {
  const sorted = [...nodes].sort((a, b) => (a.key + '|' + a.depthTurns + '|' + a.ply).localeCompare(b.key + '|' + b.depthTurns + '|' + b.ply));
  return canonicalJson(sorted.map((n) => [n.key, n.depthTurns, n.ply, n.choiceLabel,
    [...n.actions].sort((x, y) => x.originalIndex - y.originalIndex).map((a) => [a.label, a.value, a.mate, a.bound])]));
}

export { rules, label, stateKey, applyNoMoveLoss, canonicalJson };