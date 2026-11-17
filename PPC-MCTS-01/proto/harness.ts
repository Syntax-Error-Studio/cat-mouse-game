/**
 * PPC-MCTS-01 — one-call harness and fresh-process pilot entry helpers.
 *
 * Determinism / isolation rules:
 *   - every search is wrapped in a Math.random guard that THROWS on any call,
 *     so a hidden random source in the UCT path cannot pass silently;
 *   - UCT chance and rollout randomness come only from per-call seeded PRNGs;
 *   - each algorithm receives a fresh structured clone of the frozen root;
 *   - plans are replayed only through the real engine (catMove / catPlaceTrap).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { GameEngineState } from '../../src/game/engine';
import { createEngineRuleSet } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { stateKey } from '../../src/game/ai/transposition';
import { hybridEvaluateForCat } from '../../src/game/ai/hybridLeaf';
import { mateActionCost } from '../../src/game/ai/expectiminimax';
import { UctSearch, uctSeed } from './uct';
import type { RootActionStat } from './uct';
import { runRace } from './race';
import type { RaceResult } from './race';
import { replayPlanWithEngine, planLabel, actionLabel } from './replay';
import type { ReplayResult } from './replay';

export type Algorithm = 'RACE' | 'UCT-R' | 'UCT-H';

export const TOTAL_ROOTS = 24;
export const TOTAL_FRESH_PROCESS_REPETITIONS = 20;
export const TOTAL_ALGORITHMS = 3;
export const TOTAL_SEARCH_CALLS = TOTAL_ROOTS * TOTAL_ALGORITHMS * TOTAL_FRESH_PROCESS_REPETITIONS;
export const HEAVY_WORKER_CONCURRENCY = 1;
export const MAIN_SEARCH_BUDGET_MS = 100;
export const FULL_TURN_BUDGET_MS = 150;
export const MAX_HANDOFFS = 4;
export const MAX_NODES = 500_000;
export const UCB_C = Math.SQRT2;

export interface RootFixture {
  id: string;
  file: string;
  line: number;
  state: GameEngineState;
  sourceSha256: string;
  canonicalSnapshotSha256: string;
}

export interface RootRecord extends RootFixture {
  stateKey: string;
  fixtureSha256: string;
  provenance: 'REAL-HUMAN-REPLAY';
}

export interface CallRecord {
  round: 'PPC-MCTS-01';
  repetition: number;
  algorithm: Algorithm;
  rootId: string;
  provenance: 'REAL-HUMAN-REPLAY';
  sourceFile: string;
  sourceLine: number;
  fixtureSha256: string;
  rootStateKey: string;
  seed: string | null;
  searchMs: number;
  planMs: number;
  totalMs: number;
  withinFullTurnBudget: boolean;
  nodes: number;
  simulations: number | null;
  chanceSamples: number;
  rootAction: string | null;
  rootActionJson: SearchAction | null;
  rootVisits: number;
  rootMeanReward: number | null;
  rootActions: {
    action: string;
    visits: number | null;
    meanReward: number | null;
    value: number | null;
    mate?: string | null;
    bound?: string | null;
    transitionKind?: string;
  }[];
  plan: string;
  planJson: SearchAction[];
  planLength: number;
  planActionCost: number;
  planNonEmpty: boolean;
  planTreeLength: number | null;
  planExtended: boolean | null;
  planExtensionSteps: number | null;
  replayOk: boolean;
  replayFullTurnConsumed: boolean;
  replayEndedTurn: boolean;
  replayTerminal: boolean;
  replayRejectedAt: number;
  replayRejectedReason: string | null;
  replaySteps: { label: string; effective: boolean; catMovesLeft: number; phase: string; currentPlayer: string }[];
  searchCompleted: boolean | null;
  completedDepth: number | null;
  searchValue: number | null;
  searchMate: string | null;
  deadlineFired: boolean | null;
  budgetFired: boolean | null;
  mathRandomCalls: number;
  error: string | null;
}

const FIXTURE_REL = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';

function hydrate(raw: unknown): GameEngineState {
  const s = structuredClone(raw) as GameEngineState;
  s.message = s.message ?? '';
  s.catActionLog = s.catActionLog ?? [];
  s.gameEventLog = s.gameEventLog ?? [];
  s.pendingButterSpawns = s.pendingButterSpawns ?? [];
  s.pendingButterPlacementDebt = s.pendingButterPlacementDebt ?? 0;
  s.blockedTunnels = s.blockedTunnels ?? [];
  s.tunnelExitChoices = s.tunnelExitChoices ?? [];
  s.hardProgressGuardMemory = s.hardProgressGuardMemory ?? null;
  s.lastHardSearch = s.lastHardSearch ?? null;
  s.hardSearchHistory = s.hardSearchHistory ?? [];
  return s;
}

export function loadRoots(repoRoot: string): { roots: RootRecord[]; fixtureSha256: string } {
  const abs = path.join(repoRoot, FIXTURE_REL);
  const bytes = fs.readFileSync(abs);
  const fixtureSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const arr = JSON.parse(bytes.toString('utf8')) as any[];
  if (arr.length !== TOTAL_ROOTS) throw new Error(`expected ${TOTAL_ROOTS} roots, got ${arr.length}`);
  const roots = arr.map((r) => {
    const state = hydrate(r.state);
    return {
      id: String(r.id),
      file: String(r.file),
      line: Number(r.line),
      state,
      sourceSha256: String(r.sourceSha256),
      canonicalSnapshotSha256: String(r.canonicalSnapshotSha256),
      stateKey: stateKey(state),
      fixtureSha256,
      provenance: 'REAL-HUMAN-REPLAY' as const,
    };
  });
  return { roots, fixtureSha256 };
}

/** Throw-on-call Math.random guard. Returns the number of calls observed (0 or throw). */
export function withMathRandomGuard<T>(fn: () => T): { value: T; calls: number } {
  const original = Math.random;
  let calls = 0;
  Math.random = () => {
    calls++;
    throw new Error('Math.random called inside a search that must be deterministic');
  };
  try {
    const value = fn();
    return { value, calls };
  } finally {
    Math.random = original;
  }
}

export interface RootActionResult {
  action: SearchAction | null;
  label: string | null;
}

function commonRecord(
  root: RootRecord,
  rep: number,
  algo: Algorithm,
  base: {
    seed: string | null; searchMs: number; planMs: number; totalMs: number;
    nodes: number; simulations: number | null; chanceSamples: number;
    rootAction: SearchAction | null; rootVisits: number; rootMeanReward: number | null;
    rootActions: CallRecord['rootActions'];
    plan: SearchAction[]; replay: ReplayResult;
    planActionCost: number;
    planTreeLength: number | null; planExtended: boolean | null; planExtensionSteps: number | null;
    searchCompleted: boolean | null; completedDepth: number | null;
    searchValue: number | null; searchMate: string | null;
    deadlineFired: boolean | null; budgetFired: boolean | null;
    mathRandomCalls: number;
  },
): CallRecord {
  return {
    round: 'PPC-MCTS-01',
    repetition: rep,
    algorithm: algo,
    rootId: root.id,
    provenance: root.provenance,
    sourceFile: root.file,
    sourceLine: root.line,
    fixtureSha256: root.fixtureSha256,
    rootStateKey: root.stateKey,
    seed: base.seed,
    searchMs: base.searchMs,
    planMs: base.planMs,
    totalMs: base.totalMs,
    withinFullTurnBudget: base.totalMs <= FULL_TURN_BUDGET_MS,
    nodes: base.nodes,
    simulations: base.simulations,
    chanceSamples: base.chanceSamples,
    rootAction: base.rootAction ? actionLabel(base.rootAction) : null,
    rootActionJson: base.rootAction,
    rootVisits: base.rootVisits,
    rootMeanReward: base.rootMeanReward,
    rootActions: base.rootActions,
    plan: planLabel(base.plan),
    planJson: base.plan,
    planLength: base.plan.length,
    planActionCost: base.planActionCost,
    planNonEmpty: base.plan.length > 0,
    planTreeLength: base.planTreeLength,
    planExtended: base.planExtended,
    planExtensionSteps: base.planExtensionSteps,
    replayOk: base.replay.ok,
    replayFullTurnConsumed: base.replay.fullTurnConsumed,
    replayEndedTurn: base.replay.endedTurn,
    replayTerminal: base.replay.terminal,
    replayRejectedAt: base.replay.rejectedAt,
    replayRejectedReason: base.replay.rejectedReason,
    replaySteps: base.replay.steps.map((s) => ({
      label: s.label, effective: s.effective, catMovesLeft: s.catMovesLeft,
      phase: s.phase, currentPlayer: s.currentPlayer,
    })),
    searchCompleted: base.searchCompleted,
    completedDepth: base.completedDepth,
    searchValue: base.searchValue,
    searchMate: base.searchMate,
    deadlineFired: base.deadlineFired,
    budgetFired: base.budgetFired,
    mathRandomCalls: base.mathRandomCalls,
    error: null,
  };
}

export function runRaceCall(root: RootRecord, rep: number): CallRecord {
  const t0 = performance.now();
  let guard: { value: RaceResult; calls: number };
  try {
    guard = withMathRandomGuard(() => runRace(root.state));
  } catch (e) {
    throw e;
  }
  const race = guard.value;
  const replay = replayPlanWithEngine(root.state, race.plan);
  const totalMs = performance.now() - t0;
  return commonRecord(root, rep, 'RACE', {
    seed: null,
    searchMs: race.searchMs,
    planMs: race.planMs,
    totalMs,
    nodes: race.nodes,
    simulations: null,
    chanceSamples: 0,
    rootAction: race.bestAction ?? race.plan[0] ?? null,
    rootVisits: 0,
    rootMeanReward: race.value,
    rootActions: race.rootActions.map((r) => ({
      action: actionLabel(r.action),
      visits: null,
      meanReward: null,
      value: r.value,
      mate: r.mate,
      bound: r.bound ?? null,
    })),
    plan: race.plan,
    replay,
    planActionCost: race.plan.reduce((sum, a) => sum + mateActionCost(a), 0),
    planTreeLength: null,
    planExtended: null,
    planExtensionSteps: null,
    searchCompleted: race.completed,
    completedDepth: race.completedDepth,
    searchValue: race.value,
    searchMate: race.mate,
    deadlineFired: race.deadlineFired,
    budgetFired: race.budgetFired,
    mathRandomCalls: guard.calls,
  });
}

export function runUctCall(root: RootRecord, rep: number, algo: 'UCT-R' | 'UCT-H'): CallRecord {
  const seed = uctSeed(root.id, algo, rep);
  const t0 = performance.now();
  let guard: { value: ReturnType<UctSearch['run']>; calls: number };
  try {
    guard = withMathRandomGuard(() => {
      const search = new UctSearch(root.state, {
        rules: createEngineRuleSet(),
        deadlineMs: MAIN_SEARCH_BUDGET_MS,
        maxHandoffs: MAX_HANDOFFS,
        maxNodes: MAX_NODES,
        c: UCB_C,
        seed,
        rollout: algo === 'UCT-R' ? 'random' : 'hybrid',
      });
      return search.run();
    });
  } catch (e) {
    throw e;
  }
  const result = guard.value;
  const replay = replayPlanWithEngine(root.state, result.plan);
  const totalMs = performance.now() - t0;
  const searchMs = result.diagnostics.elapsedMs;
  return commonRecord(root, rep, algo, {
    seed,
    searchMs,
    planMs: Math.max(0, totalMs - searchMs),
    totalMs,
    nodes: result.diagnostics.nodesCreated,
    simulations: result.diagnostics.simulations,
    chanceSamples: result.chanceSamples,
    rootAction: result.rootAction,
    rootVisits: result.rootVisits,
    rootMeanReward: result.rootMeanReward,
    rootActions: result.rootActionStats.map((s: RootActionStat) => ({
      action: actionLabel(s.action),
      visits: s.visits,
      meanReward: s.meanReward,
      value: null,
      transitionKind: s.transitionKind,
    })),
    plan: result.plan,
    replay,
    planActionCost: result.planCost,
    planTreeLength: result.treePlanLength,
    planExtended: result.planExtended,
    planExtensionSteps: result.extensionSteps,
    searchCompleted: result.diagnostics.simulations > 0,
    completedDepth: null,
    searchValue: result.rootMeanReward,
    searchMate: null,
    deadlineFired: result.diagnostics.deadlineHit,
    budgetFired: result.diagnostics.nodeCapHit,
    mathRandomCalls: guard.calls,
  });
}

export function rotatedAlgorithms(rep: number): Algorithm[] {
  const base: Algorithm[] = ['RACE', 'UCT-R', 'UCT-H'];
  const shift = ((rep - 1) % 3 + 3) % 3;
  return [...base.slice(shift), ...base.slice(0, shift)];
}

export function runOneCall(root: RootRecord, rep: number, algo: Algorithm): CallRecord {
  if (algo === 'RACE') return runRaceCall(root, rep);
  return runUctCall(root, rep, algo);
}

export { hybridEvaluateForCat };
