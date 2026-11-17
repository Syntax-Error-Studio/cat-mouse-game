/// <reference types="node" />
/**
 * PPC-P2-PREPARED-TRANSITION-01 — Stage 1: duplicate-simulation witness.
 *
 * READ ONLY. This probe never modifies the source it measures; it wraps the
 * injected `RuleSet` with a counting proxy, so every REAL engine transition the
 * Search Simulator executes is recorded together with
 *
 *   - the identity of the input state  (`stateKey`),
 *   - the identity of the action        (function name + direction/tunnel cell),
 *   - the identity of the produced state(s) (`stateKey`, or every CHANCE outcome
 *     state with its weight).
 *
 * That is enough to answer the round's Stage-1 questions without touching a
 * single production line:
 *
 *   - Is the same (state, action) simulated more than once?  (group count >= 2)
 *   - Do the repeated simulations agree?                       (outKeys equal)
 *   - Is there real input-state pollution?                     (inKey re-keying)
 *   - Do CHANCE lists keep order / weights / cardinality?
 *
 * The expected shape BEFORE the optimisation, given the current code path:
 *
 *   interior node: every CANDIDATE is simulated once for legality
 *                  (`generateLegalSearchActions` -> `isEffective`), and every
 *                  LEGAL action is simulated a second time to build the
 *                  `PreparedAction.transition` in `searchActions`.
 *                  => legal actions: 2 calls, illegal actions: 1 call.
 *
 *   root node:     `runFixedSearch` additionally calls
 *                  `generateLegalSearchActions` only to test for emptiness, so
 *                  legal actions are simulated 3 times and illegal ones twice.
 *
 * After the optimisation every candidate that survives legality must be
 * simulated exactly once. `PHASE=pre|post` selects the output file name so a
 * post-fix run can never overwrite the frozen pre-fix evidence.
 */
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createEngineRuleSet,
  type GameEngineState,
} from '../../src/game/engine';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../src/game/types';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { stateKey } from '../../src/game/ai/transposition';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import {
  createSearchContext,
  searchBestAction,
  type SearchProfiler,
} from '../../src/game/ai/expectiminimax';
import type { RuleSet, SearchAction } from '../../src/game/ai/searchTypes';

const PHASE = process.env.PHASE ?? 'pre';
const OUT = `PPC-P2-PREPARED-TRANSITION-01/_raw/duplicate_witness_${PHASE}.json`;
const ROOT_FIXTURE = new URL(
  '../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json',
  import.meta.url,
);
const ROOT_FIXTURE_SHA256 = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';

const DIR_TOKEN: Record<string, string> = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' };
const token = (d: Direction): string => DIR_TOKEN[d.key] ?? d.key;

interface RootRecord {
  id: string;
  file: string;
  line: number;
  state: unknown;
}

interface RuleCall {
  fn: string;
  action: string;
  inKey: string;
  outKind: 'state' | 'points' | 'outcomes' | 'none';
  outKeys: string[];
  outWeights?: number[];
}

/** Counting proxy. Behaviour is delegated 1:1 to the real RuleSet. */
function instrument(base: RuleSet, sink: RuleCall[]): RuleSet {
  const stateCall = (fn: string, action: string, input: GameEngineState, out: GameEngineState): GameEngineState => {
    sink.push({
      fn,
      action,
      inKey: stateKey(input),
      outKind: 'state',
      outKeys: [stateKey(out)],
    });
    return out;
  };

  const wrapped: RuleSet = {
    mouseStep: (s, d) => stateCall('mouseStep', token(d), s, base.mouseStep(s, d)),
    catMove: (s, d) => stateCall('catMove', token(d), s, base.catMove(s, d)),
    mouseSkill: (s) => stateCall('mouseSkill', 'skill', s, base.mouseSkill(s)),
    catPlaceTrap: (s) => stateCall('catPlaceTrap', 'trap', s, base.catPlaceTrap(s)),
    chooseTunnelExit: (s, r, c) => stateCall('chooseTunnelExit', `t${r},${c}`, s, base.chooseTunnelExit(s, r, c)),
    enumerateButterSpawns: (s) => {
      const pts = base.enumerateButterSpawns(s);
      sink.push({
        fn: 'enumerateButterSpawns',
        action: '-',
        inKey: stateKey(s),
        outKind: 'points',
        outKeys: pts.map((p) => `${p.r},${p.c}`),
      });
      return pts;
    },
    endTurn: (s) => stateCall('endTurn', '-', s, base.endTurn(s)),
  };

  if (base.buildButterChance) {
    const inner = base.buildButterChance;
    wrapped.buildButterChance = (s) => {
      const res = inner(s);
      sink.push({
        fn: 'buildButterChance',
        action: '-',
        inKey: stateKey(s),
        outKind: res ? 'outcomes' : 'none',
        outKeys: (res ?? []).map((o) => stateKey(o.state)),
        outWeights: (res ?? []).map((o) => o.weight),
      });
      return res;
    };
  }
  if (base.resolveGhostBoundaryChance) {
    const inner = base.resolveGhostBoundaryChance;
    wrapped.resolveGhostBoundaryChance = (s) => {
      const res = inner(s);
      sink.push({
        fn: 'resolveGhostBoundaryChance',
        action: '-',
        inKey: stateKey(s),
        outKind: res ? 'outcomes' : 'none',
        outKeys: (res ?? []).map((o) => stateKey(o.state)),
        outWeights: (res ?? []).map((o) => o.weight),
      });
      return res;
    };
  }
  return wrapped;
}

function newProfiler(): SearchProfiler {
  return {
    stateKeyCalls: 0,
    stateKeyMs: 0,
    legalActionsCalls: 0,
    legalActionsMs: 0,
    transitionCalls: 0,
    transitionMs: 0,
    evaluateCalls: 0,
    evaluateMs: 0,
    ttProbeCalls: 0,
    ttStoreCalls: 0,
    orderingSortCalls: 0,
    orderingSortMs: 0,
    leafStateKeys: new Set<string>(),
    repeatedLeafEvals: 0,
  };
}

const ACTION_LABEL = (a: SearchAction | null): string => {
  if (!a) return '-';
  if (a.type === 'catPlaceTrap') return 'T';
  if (a.type === 'mouseSkill') return 'S';
  if (a.type === 'chooseTunnel') return `t${a.r},${a.c}`;
  return token(a.direction);
};

const short = (k: string): string => (k.length <= 24 ? k : `${k.slice(0, 10)}…${k.slice(-10)}`);

/** FROZEN D1 protocol (identical to `runFixedD1` in stateIdentityCollision.test.ts). */
function makeCtx(rules: RuleSet) {
  const ctx = createSearchContext(rules, 10000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  ctx.profiler = newProfiler();
  return ctx;
}

interface GroupSummary {
  fn: string;
  action: string;
  inKey: string;
  count: number;
  identical: boolean;
  outKinds: string[];
  outSizes: number[];
  weights?: number[][];
}

function summarise(calls: RuleCall[]): {
  groups: GroupSummary[];
  histogram: Record<string, number>;
  totalCalls: number;
  duplicateGroups: number;
  duplicateCalls: number;
  nonIdenticalDuplicateGroups: number;
} {
  const map = new Map<string, RuleCall[]>();
  for (const c of calls) {
    const k = `${c.fn}\u0000${c.action}\u0000${c.inKey}`;
    const arr = map.get(k);
    if (arr) arr.push(c);
    else map.set(k, [c]);
  }
  const groups: GroupSummary[] = [];
  const histogram: Record<string, number> = {};
  let duplicateGroups = 0;
  let duplicateCalls = 0;
  let nonIdenticalDuplicateGroups = 0;
  for (const arr of map.values()) {
    const first = arr[0];
    const sig = (c: RuleCall) => `${c.outKind}:${c.outKeys.join('|')}`;
    const identical = arr.every((c) => sig(c) === sig(first));
    groups.push({
      fn: first.fn,
      action: first.action,
      inKey: first.inKey,
      count: arr.length,
      identical,
      outKinds: arr.map((c) => c.outKind),
      outSizes: arr.map((c) => c.outKeys.length),
      weights: first.outWeights ? arr.map((c) => c.outWeights!) : undefined,
    });
    histogram[String(arr.length)] = (histogram[String(arr.length)] ?? 0) + 1;
    if (arr.length > 1) {
      duplicateGroups++;
      duplicateCalls += arr.length - 1;
      if (!identical) nonIdenticalDuplicateGroups++;
    }
  }
  return {
    groups,
    histogram,
    totalCalls: calls.length,
    duplicateGroups,
    duplicateCalls,
    nonIdenticalDuplicateGroups,
  };
}

interface RootResult {
  id: string;
  rootKeyShort: string;
  ms: number;
  value: number;
  mate: string | null;
  action: string;
  plan: string[];
  completed: boolean;
  nodes: number;
  chanceNodes: number;
  profilerLegalActionsCalls: number;
  profilerTransitionCalls: number;
  ruleCalls: number;
  actionTransitionCalls: number;
  duplicateGroups: number;
  duplicateCalls: number;
  nonIdenticalDuplicateGroups: number;
  histogram: Record<string, number>;
  chanceGroups: number;
  chanceDuplicateGroups: number;
  chanceNonIdentical: number;
  rootActionCounts: Record<string, number>;
  rootCandidateCount: number;
  searchOnly: ReturnType<typeof runSearchOnly>;
  samples: GroupSummary[];
  allIdenticalDuplicates: boolean;
}

const ACTION_FNS = new Set(['mouseStep', 'catMove', 'mouseSkill', 'catPlaceTrap', 'chooseTunnelExit']);

/**
 * Pure-search-only pass: `capturePlan=false` removes the POST-search plan
 * extraction (`buildCatTurnPlan` / `extractBestCatTurnPlan`), which legitimately
 * re-simulates a few root actions once, outside the search tree. What remains
 * is exactly the node loop, so any count>=2 here is genuine in-search
 * duplication.
 */
function runSearchOnly(rec: RootRecord): {
  ruleCalls: number;
  duplicateGroups: number;
  duplicateCalls: number;
  nonIdenticalDuplicateGroups: number;
  histogram: Record<string, number>;
  rootActionCounts: Record<string, number>;
  nodes: number;
} {
  const state = restoreHardRoot(rec.state as never);
  const sink: RuleCall[] = [];
  const rules = instrument(createEngineRuleSet(), sink);
  const ctx = makeCtx(rules);
  ctx.capturePlan = false;
  const rootKey = stateKey(state);
  const res = searchBestAction(state, 1, ctx);
  const s = summarise(sink);
  const rootActionCounts: Record<string, number> = {};
  for (const g of s.groups) {
    if (g.inKey === rootKey && ACTION_FNS.has(g.fn)) rootActionCounts[`${g.fn}:${g.action}`] = g.count;
  }
  return {
    ruleCalls: s.totalCalls,
    duplicateGroups: s.duplicateGroups,
    duplicateCalls: s.duplicateCalls,
    nonIdenticalDuplicateGroups: s.nonIdenticalDuplicateGroups,
    histogram: s.histogram,
    rootActionCounts,
    nodes: res.diagnostics.nodes,
  };
}

function runRoot(rec: RootRecord): RootResult {
  const state = restoreHardRoot(rec.state as never);
  const sink: RuleCall[] = [];
  const rules = instrument(createEngineRuleSet(), sink);
  const ctx = makeCtx(rules);
  const rootKey = stateKey(state);
  const t0 = performance.now();
  const res = searchBestAction(state, 1, ctx);
  const ms = performance.now() - t0;

  const s = summarise(sink);
  const rootActionCounts: Record<string, number> = {};
  let rootCandidateCount = 0;
  for (const g of s.groups) {
    if (g.inKey === rootKey && ACTION_FNS.has(g.fn)) {
      rootActionCounts[`${g.fn}:${g.action}`] = g.count;
      rootCandidateCount++;
    }
  }
  const chanceGroups = s.groups.filter((g) => g.fn === 'buildButterChance' || g.fn === 'resolveGhostBoundaryChance');
  const chanceDuplicateGroups = chanceGroups.filter((g) => g.count > 1).length;
  const chanceNonIdentical = chanceGroups.filter((g) => g.count > 1 && !g.identical).length;
  const samples = s.groups
    .filter((g) => g.count > 1)
    .sort((a, b) => b.count - a.count || a.fn.localeCompare(b.fn))
    .slice(0, 6)
    .map((g) => ({ ...g, inKey: short(g.inKey) }));

  return {
    id: rec.id,
    rootKeyShort: short(rootKey),
    ms: Number(ms.toFixed(3)),
    value: res.value,
    mate: res.mate,
    action: ACTION_LABEL(res.action),
    plan: res.catTurnPlan.map(ACTION_LABEL),
    completed: res.completed,
    nodes: res.diagnostics.nodes,
    chanceNodes: res.diagnostics.chanceNodes,
    profilerLegalActionsCalls: ctx.profiler!.legalActionsCalls,
    profilerTransitionCalls: ctx.profiler!.transitionCalls,
    ruleCalls: s.totalCalls,
    actionTransitionCalls: sink.filter((c) => ACTION_FNS.has(c.fn)).length,
    duplicateGroups: s.duplicateGroups,
    duplicateCalls: s.duplicateCalls,
    nonIdenticalDuplicateGroups: s.nonIdenticalDuplicateGroups,
    histogram: s.histogram,
    chanceGroups: chanceGroups.length,
    chanceDuplicateGroups,
    chanceNonIdentical,
    rootActionCounts,
    rootCandidateCount,
    searchOnly: runSearchOnly(rec),
    samples,
    allIdenticalDuplicates: s.nonIdenticalDuplicateGroups === 0,
  };
}

/**
 * A synthetic CHANCE root built ON TOP of a frozen root: a butter is placed on
 * a cell the mouse can step into immediately, so the first mouse move is a
 * butter pickup and the transition MUST become a CHANCE node. Used to check
 * chance order / weights / cardinality independent of the frozen corpus.
 */
function synthChanceRoot(base: GameEngineState): { state: GameEngineState; note: string } {
  const st: GameEngineState = JSON.parse(JSON.stringify(base));
  // Force a mouse turn with moves available.
  st.phase = GamePhase.Playing;
  st.currentPlayer = PieceType.Mouse;
  st.mouseMovesLeft = Math.max(1, st.mouseMovesLeft);
  st.mouseHasButter = false;
  st.mouseSkillActive = false;
  st.pendingButterSpawns = [];
  st.pendingButterPlacementDebt = 0;
  st.trapPosition = null;
  const m = st.mousePosition;
  const tunnel = new Set<string>();
  for (const d of DIRECTIONS) {
    const r = m.r + d.dr;
    const c = m.c + d.dc;
    const cell = st.board[r]?.[c];
    if (!cell) continue;
    if (cell.type !== CellType.Empty) continue;
    if (r === st.catPosition.r && c === st.catPosition.c) continue;
    tunnel.add(`${r},${c}`);
    st.butterPositions = [{ r, c }];
    return { state: st, note: `butter injected at (${r},${c}) adjacent to mouse (${m.r},${m.c})` };
  }
  return { state: st, note: 'no free adjacent cell — chance root not constructed' };
}

it('duplicate-simulation witness over the 24 frozen human roots (fixed D1)', () => {
  const raw = readFileSync(ROOT_FIXTURE);
  const sha = createHash('sha256').update(raw).digest('hex');
  if (sha !== ROOT_FIXTURE_SHA256) throw new Error(`root fixture sha mismatch: ${sha}`);
  const roots = JSON.parse(raw.toString('utf8')) as RootRecord[];

  const results = roots.map(runRoot);

  // Synthetic CHANCE root on top of G6T2 (a real default-map root whose D1 run
  // already contains CHANCE nodes).
  const g6t2 = roots.find((r) => r.id === 'G6T2')!;
  const synth = synthChanceRoot(restoreHardRoot(g6t2.state as never));
  const synthSink: RuleCall[] = [];
  const synthCtx = makeCtx(instrument(createEngineRuleSet(), synthSink));
  const synthKey = stateKey(synth.state);
  const t0 = performance.now();
  const synthRes = searchBestAction(synth.state, 1, synthCtx);
  const synthMs = performance.now() - t0;
  const synthSummary = summarise(synthSink);
  const synthChance = synthSummary.groups.filter(
    (g) => g.fn === 'buildButterChance' || g.fn === 'resolveGhostBoundaryChance',
  );

  const totals = results.reduce(
    (acc, r) => ({
      ruleCalls: acc.ruleCalls + r.ruleCalls,
      actionTransitionCalls: acc.actionTransitionCalls + r.actionTransitionCalls,
      duplicateGroups: acc.duplicateGroups + r.duplicateGroups,
      duplicateCalls: acc.duplicateCalls + r.duplicateCalls,
      nonIdentical: acc.nonIdentical + r.nonIdenticalDuplicateGroups,
      ms: acc.ms + r.ms,
    }),
    { ruleCalls: 0, actionTransitionCalls: 0, duplicateGroups: 0, duplicateCalls: 0, nonIdentical: 0, ms: 0 },
  );

  const out = {
    round: 'PPC-P2-PREPARED-TRANSITION-01',
    phase: PHASE,
    capturedAt: new Date().toISOString(),
    source: {
      rootFixtureSha256: sha,
      d1Protocol: {
        depthTurns: 1,
        maxNodes: 10000,
        tt: true,
        alphaBeta: true,
        moveOrdering: true,
        maxThreatExtensions: 0,
        leaf: 'explicit evaluateCorrectedHoleForCat',
        capturePlan: true,
        deadline: null,
      },
    },
    semantics:
      'Each group = (rule function, action identity, input stateKey). "count" is the number of times the REAL engine transition for that exact (state, action) pair was executed during one fixed-D1 search. count>=2 means the same transition was recomputed; "identical" compares every produced stateKey (and CHANCE weights) across the repeats.',
    expectedPreFixShape:
      'interior legal action: 2 (legality pass + prepared pass); interior illegal candidate: 1; root legal action: 3 (empty-check + legality + prepared).',
    totals,
    roots: results,
    syntheticChanceRoot: {
      base: 'G6T2',
      note: synth.note,
      rootKeyShort: short(synthKey),
      ms: Number(synthMs.toFixed(3)),
      value: synthRes.value,
      mate: synthRes.mate,
      action: ACTION_LABEL(synthRes.action),
      completed: synthRes.completed,
      nodes: synthRes.diagnostics.nodes,
      chanceNodes: synthRes.diagnostics.chanceNodes,
      chanceGroups: synthChance.map((g) => ({
        fn: g.fn,
        inKey: short(g.inKey),
        count: g.count,
        identical: g.identical,
        outSizes: g.outSizes,
        weights: g.weights,
      })),
      ruleCalls: synthSummary.totalCalls,
      duplicateGroups: synthSummary.duplicateGroups,
      nonIdenticalDuplicateGroups: synthSummary.nonIdenticalDuplicateGroups,
    },
  };

  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(`[${PHASE}] wrote ${OUT}`);
  console.log(
    `[${PHASE}] roots=${results.length} ruleCalls=${totals.ruleCalls} dupGroups=${totals.duplicateGroups}`
      + ` dupCalls=${totals.duplicateCalls} nonIdentical=${totals.nonIdentical} sumMs=${totals.ms.toFixed(1)}`,
  );
});
