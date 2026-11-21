/// <reference types="node" />
/**
 * PPC-G6T2-DECISION-RISK-CAUSAL-01 — shared research harness (OFFLINE, read-only).
 *
 * Layers reused READ-ONLY:
 *   PPC-CANDIDATE-SELECTOR-SCOPING-01/probe/css_lib.ts   (enumerator/features)
 *   PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts           (real-rule quantifier)
 *
 * Nothing here is wired into production. `planHardCatTurn` is called with the
 * same options production uses; no production file is modified.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { DIRECTIONS, GamePhase, PieceType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { planHardCatTurn, type HardTurnPlan } from '../../src/game/ai/hardTurnPlanner';
import { countRevisits } from '../../src/game/ai/planQuality';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';

import { realGame, label as sealLabel, mouseForcesWinSeal } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import {
  rules, label as actionLabel, stateKey, canonicalJson, applyNoMoveLoss,
  loadRoot, fixtureRecords, fixtureById, endStatesOf, enumerateCompleteCatTurns,
  features, FEATURE_RULES, fullStateSha, snapshotSha, summarize, auditState,
} from '../../PPC-CANDIDATE-SELECTOR-SCOPING-01/probe/css_lib';

export const ROUND = 'PPC-G6T2-DECISION-RISK-CAUSAL-01';
export const OUT = ROUND;
export const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
export const KERNEL = 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts';
export const KERNEL_SHA = '453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b';

export const CONTROL_PLANS = ['UUDD', 'DUUD', 'LUDR', 'UURR', 'DRRR', 'DRDR'] as const;

/** Horizon contract of the shadow prototype (never production). */
export const RISK = {
  windowLabel: 'TWO_MOUSE_TURNS',
  twoTurnCap: 300_000,
  oneTurnCap: 50_000,
  witnessCap: 120_000,
} as const;

/* In-search RSS sampler: timers cannot fire inside a synchronous walk. */
let peakRssMB = 0;
export function resetPeakRss() {
  peakRssMB = process.memoryUsage().rss / 1048576;
}
export function peakRss() {
  return peakRssMB;
}
function sampleMem() {
  const m = process.memoryUsage().rss / 1048576;
  if (m > peakRssMB) peakRssMB = m;
}

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const fileSha = (p: string) => (existsSync(p) ? sha256(readFileSync(p)) : null);
export const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

export function ensureDirs() {
  mkdirSync(`${OUT}/logs`, { recursive: true });
}
export function writeJson(path: string, value: unknown) {
  ensureDirs();
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/* ------------------------------------------------------------------ */
/* plan parsing (full Direction — a key-only direction is a no-op)     */
/* ------------------------------------------------------------------ */

const KEY_BY_LETTER: Record<string, string> = {
  U: 'ArrowUp', D: 'ArrowDown', L: 'ArrowLeft', R: 'ArrowRight',
};

export function catStep(letter: string): SearchAction {
  const key = KEY_BY_LETTER[letter];
  const d = DIRECTIONS.find((x) => x.key === key);
  if (!d) throw new Error(`unsupported direction letter: ${letter}`);
  return { type: 'catStep', direction: { ...d } } as unknown as SearchAction;
}

export function parsePlan(planString: string): SearchAction[] {
  return [...planString].map((ch) => {
    if (ch === 'T') return { type: 'catPlaceTrap' } as unknown as SearchAction;
    return catStep(ch);
  });
}

export const planLabel = (plan: SearchAction[]) => plan.map((a) => sealLabel(a as never)).join('');

/* ------------------------------------------------------------------ */
/* enumeration (real rules, no search, no evaluation)                  */
/* ------------------------------------------------------------------ */

export function enumerateRoot(rootId: string) {
  const root = loadRoot(rootId);
  const t0 = performance.now();
  const en = enumerateCompleteCatTurns(root);
  const elapsedMs = performance.now() - t0;
  if (en.incomplete) throw new Error(`enumeration incomplete for ${rootId}: ${JSON.stringify(en.incomplete)}`);
  return { root, turns: en.turns, expandedStates: en.expandedStates, elapsedMs };
}

export function turnOf(turns: ReturnType<typeof enumerateRoot>['turns'], planString: string) {
  const hits = turns.filter((t) => t.labels === planString);
  if (hits.length !== 1) throw new Error(`plan ${planString} found ${hits.length} times (expected exactly 1)`);
  return hits[0];
}

/* ------------------------------------------------------------------ */
/* Layer 1 — mouse wins within its own next action turn                */
/* ------------------------------------------------------------------ */

export interface OneTurnRisk {
  /** Mouse forces a win this turn under EVERY positive-probability CHANCE outcome. */
  forcedWinThisTurn: boolean | null;
  /** SOME positive-probability CHANCE outcome lets the mouse win this turn. */
  existsWinningChanceOutcome: boolean | null;
  forcedWinningActions: string[];
  existentialWinningActions: string[];
  chanceOutcomesVisited: number;
  nodes: number;
  truncated: boolean;
}

/**
 * Exhaustive mouse-turn walk. No cat action can occur inside this window, so
 * CHANCE is the only branching node. The forced verdict ANDs all positive-
 * probability outcomes; the existential verdict ORs them. A single favorable
 * branch is never reported as certainty.
 */
export function mouseOneTurnRisk(root: GameEngineState, cap = RISK.oneTurnCap): OneTurnRisk {
  let nodes = 0;
  let truncated = false;
  let chanceOutcomesVisited = 0;

  const run = (forced: boolean): { value: boolean | null; actions: string[] } => {
    const memo = new Map<string, boolean | null>();
    const walk = (s0: GameEngineState): boolean | null => {
      if (truncated) return null;
      const s = applyNoMoveLoss(s0);
      if (s.phase === GamePhase.MouseWins) return true;
      if (s.phase === GamePhase.CatWins) return false;
      if (s.currentPlayer !== PieceType.Mouse) return false; // cat turn = outside this window
      const key = stateKey(s);
      if (memo.has(key)) return memo.get(key) ?? null;
      if (++nodes > cap) { truncated = true; return null; }
      if ((nodes & 4095) === 0) sampleMem();
      let sawNull = false;
      let result = forced ? true : false;
      for (const tr of realGame.transitions(s)) {
        let val: boolean | null;
        if (tr.outcomes.length === 1 && tr.outcomes[0].weight === 1) {
          val = walk(tr.outcomes[0].state);
        } else {
          let all = true; let any = false; let nul = false;
          for (const o of tr.outcomes) {
            if (o.weight <= 0) continue;
            chanceOutcomesVisited++;
            const v = walk(o.state);
            if (v === null) nul = true;
            else if (v) any = true;
            else all = false;
          }
          val = nul ? null : forced ? all : any;
        }
        if (val === null) { sawNull = true; continue; }
        if (forced && val === false) { result = false; break; }
        if (!forced && val === true) { result = true; break; }
      }
      if (sawNull && (forced ? result === true : result === false)) {
        const out = null as boolean | null;
        memo.set(key, out);
        return out;
      }
      memo.set(key, result);
      return result;
    };
    const value = walk(root);
    const actions: string[] = [];
    if (value === true) {
      for (const tr of realGame.transitions(applyNoMoveLoss(root))) {
        const val = tr.outcomes.length === 1 && tr.outcomes[0].weight === 1
          ? walk(tr.outcomes[0].state)
          : (() => {
              let all = true; let any = false; let nul = false;
              for (const o of tr.outcomes) {
                if (o.weight <= 0) continue;
                const v = walk(o.state);
                if (v === null) nul = true; else if (v) any = true; else all = false;
              }
              return nul ? null : forced ? all : any;
            })();
        if (val === true) actions.push(tr.label);
      }
    }
    return { value, actions: actions.sort() };
  };

  const forcedRun = run(true);
  const existsRun = run(false);
  return {
    forcedWinThisTurn: truncated ? null : forcedRun.value,
    existsWinningChanceOutcome: truncated ? null : existsRun.value,
    forcedWinningActions: forcedRun.actions,
    existentialWinningActions: existsRun.actions,
    chanceOutcomesVisited,
    nodes, truncated,
  };
}

/* ------------------------------------------------------------------ */
/* Layer 2 — two-mouse-turn window quantifier + witness                */
/* ------------------------------------------------------------------ */

export interface TwoTurnResult {
  label: 'PROVEN_FORCED_WIN' | 'NO_WIN_WITHIN_TESTED_HORIZON' | 'UNKNOWN';
  value: boolean | null;
  nodes: number;
  truncated: boolean;
  elapsedMs: number;
  /** Time inside the existential witness search (0 when no win was found). */
  witnessMs: number;
  /** One concrete winning variation (m: mouse, c: cat reply). */
  witness: string[] | null;
  /** Existential witness under SOME cat reply — never a certificate. */
  witnessOnly: string[] | null;
}

interface WNode { v: boolean | null; line: string[] | null }

/**
 * TWO_MOUSE_TURNS from a mouse-to-move frontier: mouse turn, cat reply, mouse
 * turn. Mouse = OR, cat = AND, CHANCE = AND over every positive-probability
 * outcome. A cat node at idx >= 4 is outside the window (false).
 */
export function mouseTwoTurnRisk(root: GameEngineState, cap = RISK.twoTurnCap): TwoTurnResult {
  const t0 = performance.now();
  let nodes = 0;
  let truncated = false;
  const memo = new Map<string, WNode>();

  const walk = (s0: GameEngineState, idx: number): WNode => {
    if (truncated) return { v: null, line: null };
    const s = applyNoMoveLoss(s0);
    if (s.phase === GamePhase.MouseWins) return { v: true, line: [] };
    if (s.phase === GamePhase.CatWins) return { v: false, line: null };
    const mouse = s.currentPlayer === PieceType.Mouse;
    if (!mouse && idx >= 4) return { v: false, line: null };
    const key = `${idx}|${stateKey(s)}`;
    const hit = memo.get(key);
    if (hit) return hit;
    if (++nodes > cap) { truncated = true; return { v: null, line: null }; }
    if ((nodes & 4095) === 0) sampleMem();

    let sawNull = false;
    let result: WNode | null = null;
    for (const tr of realGame.transitions(s)) {
      const childPlayer = applyNoMoveLoss(tr.outcomes[0].state).currentPlayer;
      const ci = childPlayer === s.currentPlayer ? idx : idx + 1;
      let child: WNode;
      if (tr.outcomes.length === 1 && tr.outcomes[0].weight === 1) {
        const r = walk(tr.outcomes[0].state, ci);
        child = r.v === null ? r : { v: r.v, line: r.line === null ? null : [`${mouse ? 'm' : 'c'}:${tr.label}`, ...r.line] };
      } else {
        let all = true; let nul = false; let firstLine: string[] | null = null;
        for (const o of tr.outcomes) {
          if (o.weight <= 0) continue;
          const r = walk(o.state, ci);
          if (r.v === null) nul = true;
          else if (!r.v) { all = false; break; }
          else if (firstLine === null) firstLine = r.line;
        }
        child = nul ? { v: null, line: null } : all
          ? { v: true, line: [`${mouse ? 'm' : 'c'}:${tr.label}(chance)`, ...(firstLine ?? [])] }
          : { v: false, line: null };
      }
      if (child.v === null) { sawNull = true; continue; }
      if (mouse) {
        if (child.v) { result = child; break; }
      } else {
        if (!child.v) { result = child; break; }
        if (result === null) result = child;
      }
    }
    let out: WNode;
    if (result === null) out = sawNull ? { v: null, line: null } : { v: !mouse, line: null };
    else out = result;
    if (out.v !== null) memo.set(key, out);
    return out;
  };

  const full = walk(root, 1);
  const value = truncated ? null : full.v;
  let witnessOnly: string[] | null = null;
  let witnessMs = 0;
  if (value === false) {
    const tw = performance.now();
    witnessOnly = existsWitness(root, RISK.witnessCap);
    witnessMs = performance.now() - tw;
  }
  const elapsedMs = performance.now() - t0;
  return {
    label: value === true ? 'PROVEN_FORCED_WIN' : value === false ? 'NO_WIN_WITHIN_TESTED_HORIZON' : 'UNKNOWN',
    value, nodes, truncated, elapsedMs, witnessMs,
    witness: value === true ? full.line : null,
    witnessOnly,
  };
}

/** Existential witness (SOME cat reply, one chance branch) — never a certificate. */
function existsWitness(root: GameEngineState, cap: number): string[] | null {
  let nodes = 0;
  const memo = new Map<string, string[] | null>();
  const walk = (s0: GameEngineState, idx: number): string[] | null => {
    const s = applyNoMoveLoss(s0);
    if (s.phase === GamePhase.MouseWins) return [];
    if (s.phase === GamePhase.CatWins) return null;
    const mouse = s.currentPlayer === PieceType.Mouse;
    if (!mouse && idx >= 4) return null;
    if (++nodes > cap) return null;
    if ((nodes & 4095) === 0) sampleMem();
    const key = `${idx}|${stateKey(s)}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    memo.set(key, null);
    for (const tr of realGame.transitions(s)) {
      const childPlayer = applyNoMoveLoss(tr.outcomes[0].state).currentPlayer;
      const ci = childPlayer === s.currentPlayer ? idx : idx + 1;
      const outs = tr.outcomes.filter((o) => o.weight > 0);
      for (const o of outs) {
        const sub = walk(o.state, ci);
        if (sub !== null) {
          const line = [`${mouse ? 'm' : 'c'}:${tr.label}${outs.length > 1 ? '(one chance branch)' : ''}`, ...sub];
          memo.set(key, line);
          return line;
        }
      }
    }
    return null;
  };
  return walk(root, 1);
}

/* ------------------------------------------------------------------ */
/* Heuristic layer 0 — mouse-only goal reachability (cat frozen)       */
/* ------------------------------------------------------------------ */

export interface StaticReach {
  reachable: boolean | null;
  nodes: number;
  truncated: boolean;
  elapsedMs: number;
  line: string[] | null;
  caveat: 'HEURISTIC: the cat never moves and no cat reply is quantified';
}

/**
 * Cheap over-approximation: can the mouse reach a winning hole entry within
 * `mouseTurns` of its own turns if the cat never moves? Cat turns are skipped
 * by resetting the mouse actor (ghost materialisation is skipped too). This is
 * a screening heuristic only — it can only over-report risk.
 */
export function mouseStaticGoalReach(root: GameEngineState, mouseTurns = 2): StaticReach {
  const t0 = performance.now();
  let nodes = 0;
  let truncated = false;
  const seen = new Set<string>();
  const walk = (s0: GameEngineState, turnsLeft: number): string[] | null => {
    let s = applyNoMoveLoss(s0);
    if (s.phase === GamePhase.MouseWins) return [];
    if (s.phase === GamePhase.CatWins) return null;
    if (s.currentPlayer === PieceType.Cat) {
      if (turnsLeft <= 0) return null;
      const reset = {
        ...s,
        phase: GamePhase.Playing,
        currentPlayer: PieceType.Mouse,
        mouseMovesLeft: s.mouseHasButter ? s.config.mouseCarryingMoves : s.config.mouseBaseMoves,
        mouseSkillActive: false,
        tunnelExitChoices: [],
      } as GameEngineState;
      s = reset;
    }
    const key = `${turnsLeft}|${stateKey(s)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (++nodes > 20_000) { truncated = true; return null; }
    if ((nodes & 4095) === 0) sampleMem();
    for (const tr of realGame.transitions(s)) {
      const outs = tr.outcomes.filter((o) => o.weight > 0);
      for (const o of outs) {
        const child = applyNoMoveLoss(o.state);
        const nextTurns = child.currentPlayer === PieceType.Mouse || child.phase !== GamePhase.Playing ? turnsLeft : turnsLeft - 1;
        const sub = walk(child, Math.max(0, nextTurns));
        if (sub !== null) return [`m:${tr.label}`, ...sub];
      }
    }
    return null;
  };
  const line = walk(root, mouseTurns);
  return {
    reachable: truncated ? null : line !== null,
    nodes, truncated,
    elapsedMs: performance.now() - t0, line: truncated ? null : line,
    caveat: 'HEURISTIC: the cat never moves and no cat reply is quantified',
  };
}

/* ------------------------------------------------------------------ */
/* frozen labels (research annotations, never inputs to any sort)      */
/* ------------------------------------------------------------------ */

export const FROZEN_LABELS: Record<string, { label: string; source: string }> = {
  UURR: { label: 'MOUSE_FORCED_WIN (frozen certificate)', source: 'PPC-CAT-STRATEGY-01 Q5 / Q3; PPC-D2-PCV-COUNTERLINE-02 HISTORICAL_CERT_BINDING' },
  DRRR: { label: 'CAT_SURVIVES (frozen H2 certificate, window=2, cap=600000)', source: 'PPC-D2-PCV-COUNTERLINE-02 HISTORICAL_CERT_BINDING; PPC-G6T2-SELECTION-CAUSE-01' },
  DRDR: { label: 'NO_CERTIFICATE', source: 'PPC-CAT-STRATEGY-01 (no proof label)' },
  DUUD: { label: 'NO_CERTIFICATE', source: 'PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01' },
  UUDD: { label: 'NO_CERTIFICATE', source: 'PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01' },
  LUDR: { label: 'NO_CERTIFICATE', source: 'PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01' },
};

/* ------------------------------------------------------------------ */
/* plan-level shadow evaluation                                        */
/* ------------------------------------------------------------------ */

export interface ShadowEval {
  rootId: string;
  plan: string;
  legal: boolean;
  endKind: string;
  frontierCount: number;
  chanceWeights: number[];
  e1Frontier: number | number[];
  oneTurn: OneTurnRisk;
  twoTurn: TwoTurnResult;
  staticReach: StaticReach;
  frozenLabel: { label: string; source: string } | null;
  cost: {
    enumerateMs: number | null;
    oneTurnMs: number;
    staticReachMs: number;
    twoTurnMs: number;
    riskMs: number;
    rssBeforeMB: number;
    rssAfterMB: number;
    peakRssMB: number;
  };
}

export function evaluatePlanRisk(
  root: GameEngineState,
  planString: string,
  rootId: string,
  opts: { enumerateMs?: number } = {},
): ShadowEval {
  const plan = parsePlan(planString);
  let endKind = 'illegal';
  let states: GameEngineState[] = [];
  try {
    const r = endStatesOf(root, plan);
    states = r.states; endKind = r.endKind;
  } catch {
    throw new Error(`plan ${planString} illegal on ${rootId}`);
  }
  const chanceWeights = chanceWeightsOf(root, plan);
  const rssBefore = process.memoryUsage().rss / 1048576;
  resetPeakRss();
  const t0 = performance.now();
  const oneTurn = mouseOneTurnRisk(states[0]);
  const t1 = performance.now();
  const staticReach = mouseStaticGoalReach(states[0]);
  const t2 = performance.now();
  const twoTurn = mouseTwoTurnRisk(states[0]);
  const riskMs = performance.now() - t0;
  const rssAfter = process.memoryUsage().rss / 1048576;
  const e1 = states.map((s) => evaluateForCat(s));
  return {
    rootId, plan: planString, legal: true, endKind,
    frontierCount: states.length,
    chanceWeights,
    e1Frontier: e1.length === 1 ? e1[0] : e1,
    oneTurn, twoTurn, staticReach,
    frozenLabel: FROZEN_LABELS[planString] ?? null,
    cost: {
      enumerateMs: opts.enumerateMs ?? null,
      oneTurnMs: t1 - t0, staticReachMs: t2 - t1, twoTurnMs: twoTurn.elapsedMs,
      riskMs, rssBeforeMB: rssBefore, rssAfterMB: rssAfter, peakRssMB: peakRss(),
    },
  };
}

/** Positive-probability CHANCE outcome weights of the plan's final transition. */
export function chanceWeightsOf(root: GameEngineState, plan: SearchAction[]): number[] {
  let cur = applyNoMoveLoss(root);
  for (let i = 0; i < plan.length; i++) {
    const prepared = generatePreparedSearchActions(cur, rules);
    const hit = prepared.find((p) => planLabel([p.action]) === planLabel([plan[i]]));
    if (!hit) throw new Error(`chanceWeightsOf illegal at ${i}`);
    const t = hit.transition;
    if (t.kind === 'chance') {
      if (i !== plan.length - 1) throw new Error('chance before final action');
      return t.outcomes.filter((o) => o.weight > 0).map((o) => o.weight);
    }
    cur = t.state;
  }
  return [1];
}

/* ------------------------------------------------------------------ */
/* production 100ms capture (exactly the production call shape)        */
/* ------------------------------------------------------------------ */

export interface ProdRun {
  rootId: string;
  planString: string;
  bestAction: string | null;
  value: number;
  mate: string | null;
  completedDepth: number;
  attemptedDepth: number;
  hasSolution: boolean;
  deadlineFired: boolean;
  budgetFired: boolean;
  nodes: number;
  elapsedMs: number;
  planStatus: string;
  fallbackOccurred: boolean;
  rootActions: { action: string; value: number; mate: string | null; bound: string | null }[];
  refutationTriggered: boolean | null;
  refutationSelectedPlanSource: string | null;
}

export function runProduction100(root: GameEngineState, rootId: string): ProdRun {
  const t0 = performance.now();
  const plan: HardTurnPlan = planHardCatTurn(root, {
    rules, timeBudgetMs: 100, maxDepthTurns: 4,
    refutation: { enabled: true, totalTurnBudgetMs: 150 },
  });
  const elapsedMs = performance.now() - t0;
  const labels = plan.plan.map((a) => sealLabel(a as never)).join('');
  return {
    rootId,
    planString: labels,
    bestAction: plan.bestAction ? sealLabel(plan.bestAction as never) : null,
    value: plan.search.value,
    mate: plan.search.mate,
    completedDepth: plan.completedDepth,
    attemptedDepth: plan.attemptedDepth,
    hasSolution: plan.hasSolution,
    deadlineFired: plan.deadlineFired,
    budgetFired: plan.budgetFired,
    nodes: plan.debug.nodes,
    elapsedMs,
    planStatus: String((plan.debug as unknown as { planStatus?: string }).planStatus ?? ''),
    fallbackOccurred: !plan.hasSolution,
    rootActions: (plan.debug.rootActions ?? []).map((x) => ({
      action: sealLabel(x.action as never), value: x.value,
      mate: (x.mate ?? null) as string | null, bound: (x.bound ?? null) as string | null,
    })),
    refutationTriggered: (plan.debug as unknown as { refutation?: { refutationTriggered?: boolean } }).refutation?.refutationTriggered ?? null,
    refutationSelectedPlanSource: (plan.debug as unknown as { refutation?: { selectedPlanSource?: string } }).refutation?.selectedPlanSource ?? null,
  };
}

export {
  rules, actionLabel, stateKey, canonicalJson, applyNoMoveLoss,
  loadRoot, fixtureRecords, fixtureById, endStatesOf, features, FEATURE_RULES,
  fullStateSha, snapshotSha, summarize, auditState, countRevisits,
  evaluateForCat, planHardCatTurn, mouseForcesWinSeal, realGame,
  generatePreparedSearchActions,
  GamePhase, PieceType,
};