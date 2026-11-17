/**
 * PPC-MCTS-01B-IMPLEMENTATION — shared arm runner.
 *
 * Both arms are imported SIDE BY SIDE:
 *   BASELINE = PPC-MCTS-01/proto/uct.ts          (untouched, sha in MANIFEST)
 *   PREPARED = PPC-MCTS-01B/proto/uctPrepared.ts (rollout-only fork)
 *
 * Everything the two arms could disagree about and everything they must agree
 * about is captured by `runArm()` + `fingerprint()`. Nothing here mutates
 * either prototype.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GameEngineState } from '../../../src/game/engine';
import { createEngineRuleSet } from '../../../src/game/engine';
import type { RuleSet, SearchAction } from '../../../src/game/ai/searchTypes';
import { stateKey } from '../../../src/game/ai/transposition';
import { restoreHardRoot } from '../../../src/game/ai/hardHistory';
import { UctSearch, uctSeed } from '../../../PPC-MCTS-01/proto/uct';
import type { UctNode, UctOptions, UctResult } from '../../../PPC-MCTS-01/proto/uct';
import { UctSearchPrepared } from '../../proto/uctPrepared';
import type { UctResult as UctResultPrepared } from '../../proto/uctPrepared';
import { actionLabel } from '../../../PPC-MCTS-01/proto/replay';

/**
 * Resolved from the process working directory on purpose: the drivers are meant
 * to be run as an esbuild BUNDLE (see scripts/build-drivers.mjs), because
 * vite-node executes this workload ~7x slower than the Pilot's `bench.mjs`
 * (measured: 691 us vs 97 us per hybrid leaf evaluation). A bundled ESM has no
 * meaningful `import.meta.url`, so the repo root must come from cwd.
 */
export const FIXTURE_REL = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
export const ROOT_FIXTURE = resolve(process.cwd(), FIXTURE_REL);
export const ROOT_FIXTURE_SHA256 = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
export const ROOT_FIXTURE_COUNT = 24;

export const MAIN_SEARCH_BUDGET_MS = 100;
export const FULL_TURN_BUDGET_MS = 150;
export const MAX_HANDOFFS = 4;
export const MAX_NODES = 500_000;
export const UCB_C = Math.SQRT2;

export type Arm = 'baseline' | 'prepared';
export type Mode = 'hybrid' | 'random';

export interface RootRecord {
  id: string;
  state: GameEngineState;
  stateKey: string;
  fixtureSha256: string;
}

export function loadRoots(): { roots: RootRecord[]; fixtureSha256: string } {
  if (!existsSync(ROOT_FIXTURE)) {
    throw new Error(`root fixture not found at ${ROOT_FIXTURE} — run the driver from the repo root`);
  }
  const bytes = readFileSync(ROOT_FIXTURE);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== ROOT_FIXTURE_SHA256) {
    throw new Error(`root fixture sha256 ${sha} != frozen ${ROOT_FIXTURE_SHA256}`);
  }
  const arr = JSON.parse(bytes.toString('utf8')) as { id: string; state: unknown }[];
  if (arr.length !== ROOT_FIXTURE_COUNT) throw new Error(`expected ${ROOT_FIXTURE_COUNT} roots, got ${arr.length}`);
  const roots = arr.map((r) => {
    const state = restoreHardRoot(r.state as never);
    return { id: String(r.id), state, stateKey: stateKey(state), fixtureSha256: sha };
  });
  return { roots, fixtureSha256: sha };
}

/** Counting RuleSet: delegates 1:1 and counts only. Never alters a transition. */
export function countingRules(base: RuleSet): { rules: RuleSet; calls: () => number; reset: () => void } {
  let n = 0;
  const bump = (): void => { n++; };
  const r: RuleSet = {
    mouseStep: (s, d) => { bump(); return base.mouseStep(s, d); },
    catMove: (s, d) => { bump(); return base.catMove(s, d); },
    mouseSkill: (s) => { bump(); return base.mouseSkill(s); },
    catPlaceTrap: (s) => { bump(); return base.catPlaceTrap(s); },
    chooseTunnelExit: (s, rr, cc) => { bump(); return base.chooseTunnelExit(s, rr, cc); },
    endTurn: (s) => base.endTurn(s),
    enumerateButterSpawns: (s) => base.enumerateButterSpawns(s),
  };
  if (base.buildButterChance) r.buildButterChance = (s) => base.buildButterChance!(s);
  if (base.resolveGhostBoundaryChance) r.resolveGhostBoundaryChance = (s) => base.resolveGhostBoundaryChance!(s);
  return { rules: r, calls: () => n, reset: () => { n = 0; } };
}

/** Throw-on-call Math.random guard (same contract as the Pilot harness). */
export function withMathRandomGuard<T>(fn: () => T): { value: T; calls: number } {
  const original = Math.random;
  let calls = 0;
  Math.random = () => { calls++; throw new Error('Math.random called inside a deterministic search'); };
  try {
    return { value: fn(), calls };
  } finally {
    Math.random = original;
  }
}

/**
 * COUNT-only Math.random tap: records every draw and delegates to the real
 * generator. Needed by the Phase 2 performance driver, where the
 * trap-on-butter impurity must be survivable — the production engine really
 * does relocate that butter through `Math.random`, so a throw guard would abort
 * the call instead of measuring it. Determinism is NOT required there: Phase 2
 * measures wall time, and Phase 1 uses its own fixed-seed stub instead.
 */
export function withMathRandomCounter<T>(fn: () => T): { value: T; calls: number } {
  const original = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return original(); };
  try {
    return { value: fn(), calls };
  } finally {
    Math.random = original;
  }
}

export interface ArmOptions {
  mode: Mode;
  seed: string;
  /** Fixed-workload mode: `now` returns a constant and the node cap decides the stop. */
  fixedNodes?: number;
  /** Wall-clock mode. */
  deadlineMs?: number;
}

export interface ArmRun {
  arm: Arm;
  result: UctResult | UctResultPrepared;
  ruleCalls: number;
  wallMs: number;
  mathRandomCalls: number;
}

function makeSearch(arm: Arm, state: GameEngineState, o: ArmOptions, rules: RuleSet) {
  const fixed = o.fixedNodes !== undefined;
  const base: UctOptions = {
    rules,
    // Fixed-workload mode never consults the clock: deadlineAt = 1 and now() = 0.
    deadlineMs: fixed ? 1 : (o.deadlineMs ?? MAIN_SEARCH_BUDGET_MS),
    maxHandoffs: MAX_HANDOFFS,
    maxNodes: fixed ? o.fixedNodes! : MAX_NODES,
    c: UCB_C,
    seed: o.seed,
    rollout: o.mode,
    ...(fixed ? { now: () => 0 } : {}),
  };
  return arm === 'baseline' ? new UctSearch(state, base) : new UctSearchPrepared(state, base);
}

export function runArm(
  arm: Arm,
  state: GameEngineState,
  o: ArmOptions,
  guardMode: 'throw' | 'count' = 'throw',
): ArmRun {
  const counter = countingRules(createEngineRuleSet());
  const t0 = performance.now();
  const guard = (guardMode === 'count' ? withMathRandomCounter : withMathRandomGuard)(() => {
    const search = makeSearch(arm, state, o, counter.rules);
    return search.run();
  });
  const wallMs = performance.now() - t0;
  return { arm, result: guard.value, ruleCalls: counter.calls(), wallMs, mathRandomCalls: guard.calls };
}

// ---------------------------------------------------------------------------
// fingerprints
// ---------------------------------------------------------------------------
function num(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Inf';
  if (x === -Infinity) return '-Inf';
  return String(x);
}

/**
 * Structural digest of the whole search tree: node kind, hand-off depth,
 * stateKey, visit statistics, edge keys/kinds, and — for CHANCE nodes — the
 * outcome weights, per-outcome draw counters and the outcome states.
 *
 * Any rollout divergence changes at least one reward, hence at least one
 * `totalReward`, hence this digest.
 */
export function treeFingerprint(root: UctNode): string {
  const parts: string[] = [];
  const walk = (node: UctNode): void => {
    parts.push(
      node.kind, String(node.handoffs), stateKey(node.state), String(node.visitCount),
      num(node.totalReward), num(node.meanReward), String(node.childNodes.length),
      String(node.chanceOutcomes.length),
    );
    for (const e of node.childNodes) {
      parts.push(e.key, e.transitionKind);
    }
    for (const o of node.chanceOutcomes) {
      parts.push(num(o.weight), String(o.samples), stateKey(o.state));
    }
    for (const e of node.childNodes) if (e.child) walk(e.child);
    for (const o of node.chanceOutcomes) if (o.child) walk(o.child);
  };
  walk(root);
  return createHash('sha256').update(parts.join('\u0001')).digest('hex');
}

export interface ComparableCell {
  digest: string;
  plan: string;
  planCost: number;
  planExtended: boolean;
  treePlanLength: number;
  extensionSteps: number;
  rootAction: string | null;
  rootVisits: number;
  rootMeanReward: string;
  rootActionStats: {
    key: string; transitionKind: string; visits: number;
    meanReward: string; totalReward: string; childStateKey: string | null;
  }[];
  diagnostics: {
    simulations: number; abortedSimulations: number; nodesCreated: number;
    chanceNodes: number; chanceSamples: number; maxChanceMassError: string;
    rolloutSteps: number; maxHandoffsReached: number;
    deadlineHit: boolean; nodeCapHit: boolean; postDeadlineNodeCreations: number;
  };
  chanceSamples: number;
}

export function comparable(r: UctResult | UctResultPrepared): ComparableCell {
  const d = r.diagnostics;
  return {
    digest: treeFingerprint(r.root),
    plan: r.plan.map(actionLabel).join(' '),
    planCost: r.planCost,
    planExtended: r.planExtended,
    treePlanLength: r.treePlanLength,
    extensionSteps: r.extensionSteps,
    rootAction: r.rootAction ? actionLabel(r.rootAction) : null,
    rootVisits: r.rootVisits,
    rootMeanReward: num(r.rootMeanReward),
    rootActionStats: r.rootActionStats.map((s) => ({
      key: s.key,
      transitionKind: s.transitionKind,
      visits: s.visits,
      meanReward: num(s.meanReward),
      totalReward: num(s.totalReward),
      childStateKey: s.childStateKey,
    })),
    diagnostics: {
      simulations: d.simulations,
      abortedSimulations: d.abortedSimulations,
      nodesCreated: d.nodesCreated,
      chanceNodes: d.chanceNodes,
      chanceSamples: d.chanceSamples,
      maxChanceMassError: num(d.maxChanceMassError),
      rolloutSteps: d.rolloutSteps,
      maxHandoffsReached: d.maxHandoffsReached,
      deadlineHit: d.deadlineHit,
      nodeCapHit: d.nodeCapHit,
      postDeadlineNodeCreations: d.postDeadlineNodeCreations,
    },
    chanceSamples: r.chanceSamples,
  };
}

/** Field-by-field diff of two comparable cells (empty array = parity). */
export function diffCell(a: ComparableCell, b: ComparableCell): string[] {
  const tmpA: Record<string, unknown> = {};
  const tmpB: Record<string, unknown> = {};
  const collect = (o: unknown, prefix: string, into: Record<string, unknown>): void => {
    if (o === null || typeof o !== 'object') { into[prefix] = o; return; }
    if (Array.isArray(o)) { o.forEach((v, i) => collect(v, `${prefix}[${i}]`, into)); return; }
    for (const k of Object.keys(o as object).sort()) collect((o as Record<string, unknown>)[k], `${prefix}.${k}`, into);
  };
  collect(a, '', tmpA);
  collect(b, '', tmpB);
  const keys = [...new Set([...Object.keys(tmpA), ...Object.keys(tmpB)])].sort();
  const out: string[] = [];
  for (const k of keys) {
    if (tmpA[k] !== tmpB[k]) out.push(`${k}: baseline=${String(tmpA[k])} prepared=${String(tmpB[k])}`);
  }
  return out;
}

export { actionLabel, stateKey };
export type { SearchAction, GameEngineState };
