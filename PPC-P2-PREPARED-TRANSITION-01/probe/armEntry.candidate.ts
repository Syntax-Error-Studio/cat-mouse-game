/// <reference types="node" />
/**
 * CANDIDATE arm for the PPC-P2-PREPARED-TRANSITION-01 performance comparison.
 *
 * Every import points into the live `../../src`, i.e. the current P1 production
 * code WITH the prepared-transition reuse. Its frozen BASELINE twin
 * (`armEntry.baseline.ts`) imports `../arm/src`, a copy that differs from `src`
 * in exactly three files:
 *   - `ai/expectiminimax.ts`  (pre-round sealed bytes, sha256 8ac26985…)
 *   - `ai/legalActions.ts`    (pre-round bytes, git HEAD)
 *   - `ai/preparedActions.ts` (absent)
 *
 * Nothing else differs; the bench probe asserts both arms return identical D1
 * results, so any timing delta is attributable to the reuse alone.
 */
import type { GameEngineState } from '../../src/game/engine';
import { createEngineRuleSet, computeCatAiTrajectory } from '../../src/game/engine';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { stateKey } from '../../src/game/ai/transposition';

export const ARM = 'candidate';

const ruleSet = createEngineRuleSet();

export function restore(snapshot: unknown): GameEngineState {
  return restoreHardRoot(snapshot as never);
}

/** FROZEN D1 protocol — identical in both arms. */
export function createCtx() {
  const ctx = createSearchContext(ruleSet, 10000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  return ctx;
}

const DIR: Record<string, string> = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' };

function label(a: { type: string; direction?: { key: string }; r?: number; c?: number } | null): string {
  if (!a) return '-';
  if (a.type === 'catPlaceTrap') return 'T';
  if (a.type === 'mouseSkill') return 'S';
  if (a.type === 'chooseTunnel') return `t${a.r},${a.c}`;
  return DIR[a.direction!.key] ?? '?';
}

export interface ArmRootResult {
  id: string;
  ms: number;
  value: number;
  mate: string | null;
  completed: boolean;
  action: string;
  plan: string[];
  nodes: number;
  chanceNodes: number;
  ttHits: number;
  cutoffs: number;
  key: string;
}

export function runRoot(id: string, state: GameEngineState): ArmRootResult {
  const key = stateKey(state);
  const t0 = performance.now();
  const ctx = createCtx();
  const res = searchBestAction(state, 1, ctx);
  const ms = performance.now() - t0;
  return {
    id,
    ms,
    value: res.value,
    mate: res.mate,
    completed: res.completed,
    action: label(res.action as never),
    plan: res.catTurnPlan.map((a) => label(a as never)),
    nodes: res.diagnostics.nodes,
    chanceNodes: res.diagnostics.chanceNodes,
    ttHits: res.diagnostics.ttHits,
    cutoffs: res.diagnostics.alphaBetaCutoffs,
    key,
  };
}

export interface ArmTurnResult {
  ok: boolean;
  wallMs: number;
  actions: number;
  finalPhase: string;
  catMovesLeft: number;
  completedDepth: number;
  attemptedDepth: number;
  nodes: number;
  searchMs: number;
  rootValue: number;
  mate: string | null;
  plan: string[];
  planStatus: string;
  fallbackLogged: boolean;
  finalKey: string;
}

/**
 * Run the FULL production cat turn (plan -> execute -> fallback) on this arm's
 * engine, i.e. the same code path the real game uses. Used only by the
 * deadline-integration diagnostic: `computeCatAiTrajectory` mints the turn's
 * absolute deadline identity itself, exactly as the game does.
 */
export function runTurn(state: GameEngineState): ArmTurnResult {
  const t0 = performance.now();
  const steps = computeCatAiTrajectory(state);
  const wallMs = performance.now() - t0;
  if (!steps || steps.length === 0) {
    return {
      ok: false, wallMs, actions: 0, finalPhase: String(state.phase), catMovesLeft: state.catMovesLeft,
      completedDepth: -1, attemptedDepth: -1, nodes: -1, searchMs: -1, rootValue: NaN, mate: null,
      plan: [], planStatus: 'no_trajectory', fallbackLogged: false, finalKey: '',
    };
  }
  const final = steps[steps.length - 1].state;
  const hist = final.hardSearchHistory ?? [];
  const last = hist[hist.length - 1];
  const log = final.catActionLog ?? [];
  return {
    ok: true,
    wallMs,
    actions: steps.length - 1,
    finalPhase: String(final.phase),
    catMovesLeft: final.catMovesLeft,
    completedDepth: last ? last.production.completedDepth : -1,
    attemptedDepth: last ? last.production.attemptedDepth : -1,
    nodes: last ? last.production.nodes : -1,
    searchMs: last ? last.production.elapsedMs : -1,
    rootValue: last ? last.production.rootValue : NaN,
    mate: last ? (last.production.mate ?? null) : null,
    plan: last ? last.production.plan.map((a) => label(a as never)) : [],
    planStatus: last?.production.planStatus ?? 'none',
    fallbackLogged: log.some((l) => typeof l === 'string' && l.includes('SEARCH_FALLBACK')),
    finalKey: stateKey(final),
  };
}
