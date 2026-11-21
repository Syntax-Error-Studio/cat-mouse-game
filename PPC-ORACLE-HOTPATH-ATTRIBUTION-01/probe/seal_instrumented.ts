/// <reference types="node" />
/**
 * PPC-ORACLE-HOTPATH-ATTRIBUTION-01 — instrumented RESEARCH copy of the frozen
 * SEAL kernel (RESEARCH ONLY).
 *
 * The frozen kernel `PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts` is imported
 * read-only and is NEVER edited. This file re-implements its `walk` verbatim
 * (same statements, same order, same early returns) with:
 *
 *   - per-component timers (settle / terminal / player / key / memo / transitions)
 *   - per-component self-time accounting (each call subtracts its children)
 *   - expansion bookkeeping (which stateKeys expand, how often, at which idx)
 *   - an OPTIONAL solve-local action cache keyed by stateKey (prototype only)
 *   - an OPTIONAL shadow mode that regenerates the baseline transitions on a
 *     cache hit and compares them item by item (correctness gate, not perf)
 *
 * Every timer wraps an existing statement; no search semantics, ordering,
 * quantifier, memo semantics, cap or horizon is changed.
 */
import {
  rules,
  label,
} from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import type { GameAdapter, Mode, Transition } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import { generatePreparedSearchActions, enumerateSearchActionCandidates } from '../../src/game/ai/preparedActions';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { stateKey } from '../../src/game/ai/transposition';
import { gameAffectingEqual } from '../../src/game/ai/stateCompare';
import { applyNoMoveLoss } from '../../src/game/rules/mobility';
import { GamePhase, PieceType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';

export const now = (): number => performance.now();

export interface HotCounters {
  // --- frozen parity counters (same semantics as SolveStats) ---
  nodes: number;
  transitions: number;
  chanceNodes: number;
  chanceOutcomes: number;
  memoHits: number;
  cutoffs: number;
  truncated: boolean;
  maxIdx: number;
  elapsedMs: number;

  // --- per-component wall time (inclusive, nested calls counted once each) ---
  settleCalls: number; settleMs: number;
  terminalCalls: number; terminalMs: number;
  playerCalls: number; playerMs: number;
  keyCalls: number; keyMs: number; keyChars: number;
  memoGetCalls: number; memoGetMs: number;
  transitionsCalls: number; transitionsMs: number;
  genCalls: number; genMs: number; // real generatePreparedSearchActions
  mapLabelMs: number;
  memoSetCalls: number; memoSetMs: number;
  policySetMs: number;

  /** Sum over walk() calls of (own elapsed − Σ child walk elapsed): pure self time. */
  selfMs: number;
  /** Recursion time is the rest of elapsedMs. */
  childWalkMs: number;

  // --- expansion bookkeeping ---
  expansions: number;                 // memo misses that passed the cap check
  distinctExpansionKeys: number;      // unique stateKey among expansions (this solve)
  repeatExpansionsSameIdx: number;    // same key expanded again at the SAME idx
  repeatExpansionsDiffIdx: number;    // same key expanded again at a DIFFERENT idx
  /** stateKey → expansion count, solve-local (for cross-root statistics). */
  expansionKeyCounts: Map<string, number>;
  lastIdxByKey: Map<string, number>;
  successorKeys: Set<string>;

  // --- optional outcome bookkeeping (trackOutcomeKeys) ---
  outcomeKeyCalls: number; outcomeKeyMs: number;
  duplicateSuccessorKeys: number;     // successor states whose key was produced before
  distinctSuccessorKeys: number;

  // --- prototype cache ---
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
  cacheSize: number;

  // --- shadow comparison (cache-hit regeneration) ---
  shadowChecks: number;
  shadowChanceChecks: number;
  shadowMismatches: number;
  shadowFirstMismatch: string | null;
  /** Repeat-key signature check: same stateKey ⇒ same transition signature? */
  repeatSigChecks: number;
  repeatSigMismatches: number;
  repeatSigFirstMismatch: string | null;

  // --- profiled generator (profileGen) ---
  profEnumMs: number; profEnumCandidates: number;
  profSimMs: number; profSimCalls: number;
  profCompareMs: number; profCompareCalls: number;
  profLegalActions: number;
  profValidateChecks: number;
  profValidateMismatches: number;
  profFirstMismatch: string | null;
}

export function emptyCounters(): HotCounters {
  return {
    nodes: 0, transitions: 0, chanceNodes: 0, chanceOutcomes: 0,
    memoHits: 0, cutoffs: 0, truncated: false, maxIdx: 0, elapsedMs: 0,
    settleCalls: 0, settleMs: 0,
    terminalCalls: 0, terminalMs: 0,
    playerCalls: 0, playerMs: 0,
    keyCalls: 0, keyMs: 0, keyChars: 0,
    memoGetCalls: 0, memoGetMs: 0,
    transitionsCalls: 0, transitionsMs: 0,
    genCalls: 0, genMs: 0, mapLabelMs: 0,
    memoSetCalls: 0, memoSetMs: 0, policySetMs: 0,
    selfMs: 0, childWalkMs: 0,
    expansions: 0, distinctExpansionKeys: 0,
    repeatExpansionsSameIdx: 0, repeatExpansionsDiffIdx: 0,
    expansionKeyCounts: new Map(),
    lastIdxByKey: new Map(),
    successorKeys: new Set(),
    outcomeKeyCalls: 0, outcomeKeyMs: 0,
    duplicateSuccessorKeys: 0, distinctSuccessorKeys: 0,
    cacheHits: 0, cacheMisses: 0, cacheEvictions: 0, cacheSize: 0,
    shadowChecks: 0, shadowChanceChecks: 0, shadowMismatches: 0, shadowFirstMismatch: null,
    repeatSigChecks: 0, repeatSigMismatches: 0, repeatSigFirstMismatch: null,
    profEnumMs: 0, profEnumCandidates: 0,
    profSimMs: 0, profSimCalls: 0,
    profCompareMs: 0, profCompareCalls: 0,
    profLegalActions: 0,
    profValidateChecks: 0, profValidateMismatches: 0, profFirstMismatch: null,
  };
}

export interface HotOptions {
  /**
   * Solve-local prototype cache: stateKey → transitions produced while that
   * state was expanded. Lives only for one solve() call. Rules / H / mode are
   * fixed for the lifetime of the map, so the key is the state identity alone.
   */
  actionCache?: Map<string, Transition<GameEngineState>[]>;
  cacheCap?: number;
  /** On a cache hit, regenerate baseline transitions and compare (slow, gate only). */
  shadowCompare?: boolean;
  /** Compute stateKey for every successor to measure cross-node duplication (slow). */
  trackOutcomeKeys?: boolean;
  /** Build the transition list with the instrumented re-implementation (timed split). */
  profileGen?: boolean;
  /** In profileGen mode, verify the re-implementation against the real generator. */
  profileValidateFirst?: number;
  /** Retain every Nth expanded state for an OUT-OF-SOLVE microbenchmark. */
  sampleStatesEvery?: number;
}

export interface HotResult<S = unknown> {
  value: boolean | null;
  policy: Map<string, string>;
  counters: HotCounters;
  /** Sampled expansion states (empty unless sampleStatesEvery was set). */
  sampledStates: S[];
  /** Frozen-compatible stats projection (for parity). */
  stats: {
    nodes: number; transitions: number; chanceNodes: number; chanceOutcomes: number;
    memoHits: number; cutoffs: number; truncated: boolean; maxIdx: number; elapsedMs: number;
  };
}

function mapTransition(action: { type: string; direction?: { key: string }; r?: number; c?: number }, tr: ReturnType<typeof simulateSearchAction>): Transition<GameEngineState> {
  if (tr.kind === 'deterministic') {
    return { label: label(action), outcomes: [{ state: tr.state, weight: 1 }] };
  }
  return { label: label(action), outcomes: tr.outcomes.map((o) => ({ state: o.state, weight: o.weight })) };
}

/**
 * Timed re-implementation of `generatePreparedSearchActions` (same candidates,
 * same order, same legality predicate). Used ONLY to split the transition cost
 * into enumeration / simulation / comparison / mapping.
 */
export function genProfiled(s: GameEngineState, h: HotCounters): Transition<GameEngineState>[] {
  const t0 = now();
  const cands = enumerateSearchActionCandidates(s);
  h.profEnumMs += now() - t0;
  h.profEnumCandidates += cands.length;
  const out: Transition<GameEngineState>[] = [];
  for (const cand of cands) {
    const t1 = now();
    const trans = simulateSearchAction(s, cand.action, rules);
    h.profSimMs += now() - t1;
    h.profSimCalls++;
    const t2 = now();
    const legal = !cand.verifyEffectiveness
      || trans.kind === 'chance'
      || !gameAffectingEqual(s, trans.state);
    h.profCompareMs += now() - t2;
    h.profCompareCalls++;
    if (!legal) continue;
    const t3 = now();
    out.push(mapTransition(cand.action, trans));
    h.mapLabelMs += now() - t3;
    h.profLegalActions++;
  }
  return out;
}

function transitionSignature(trs: Transition<GameEngineState>[], keyOf: (s: GameEngineState) => string): string {
  return trs.map((tr) => `${tr.label}[${tr.outcomes.map((o) => `${o.weight}:${keyOf(o.state)}`).join(',')}]`).join(';');
}

function compareTransitions(
  a: Transition<GameEngineState>[], b: Transition<GameEngineState>[],
  keyOf: (s: GameEngineState) => string,
): string | null {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i].label !== b[i].label) return `label[${i}] ${a[i].label} vs ${b[i].label}`;
    const ao = a[i].outcomes, bo = b[i].outcomes;
    if (ao.length !== bo.length) return `outcomes[${i}] length ${ao.length} vs ${bo.length}`;
    for (let j = 0; j < ao.length; j++) {
      if (ao[j].weight !== bo[j].weight) return `weight[${i}][${j}] ${ao[j].weight} vs ${bo[j].weight}`;
      if (!gameAffectingEqual(ao[j].state, bo[j].state)) return `state[${i}][${j}] not game-affecting-equal`;
      const ka = keyOf(ao[j].state), kb = keyOf(bo[j].state);
      if (ka !== kb) return `key[${i}][${j}] differs`;
    }
  }
  return null;
}

/**
 * `solve()` with instrumentation. The statements of the frozen `walk` are
 * reproduced in the same order; the only additions are timers, counters and the
 * opt-in prototype cache / shadow check.
 */
export function solveInstrumented<S>(
  game: GameAdapter<S>, root: S, H: number, startIdx: number, cap: number, mode: Mode,
  opts: HotOptions = {},
): HotResult {
  const h = emptyCounters();
  const t0 = now();
  const memo = new Map<string, boolean>();
  const policy = new Map<string, string>();

  const terminalMouse = mode === 'mouseForce';
  const terminalCat = mode !== 'mouseForce';
  const horizonVal = mode === 'catSurvive';
  const existential: 'cat' | 'mouse' = mode === 'mouseForce' ? 'mouse' : 'cat';

  const keyOf = (s: S): string => {
    const t = now();
    const k = game.key(s);
    h.keyMs += now() - t;
    h.keyCalls++;
    h.keyChars += k.length;
    return k;
  };

  const timedSettle = (s: S): S => {
    const t = now();
    const out = game.settle(s);
    h.settleMs += now() - t;
    h.settleCalls++;
    return out;
  };
  const timedTerminal = (s: S): 'mouse' | 'cat' | null => {
    const t = now();
    const v = game.terminal(s);
    h.terminalMs += now() - t;
    h.terminalCalls++;
    return v;
  };
  const timedPlayer = (s: S): 'cat' | 'mouse' => {
    const t = now();
    const v = game.player(s);
    h.playerMs += now() - t;
    h.playerCalls++;
    return v;
  };

  /** Build the transition list for an expansion (real generator or profiled). */
  const timedTransitions = (s: S): Transition<S>[] => {
    const t = now();
    let out: Transition<S>[];
    if (opts.profileGen) {
      out = genProfiled(s as unknown as GameEngineState, h) as unknown as Transition<S>[];
      if (opts.profileValidateFirst && h.profValidateChecks < opts.profileValidateFirst) {
        h.profValidateChecks++;
        const ref = generatePreparedSearchActions(s as unknown as GameEngineState, rules)
          .map((p) => mapTransition(p.action, p.transition)) as unknown as Transition<S>[];
        const diff = compareTransitions(
          ref as unknown as Transition<GameEngineState>[],
          out as unknown as Transition<GameEngineState>[],
          (st) => stateKey(st),
        );
        if (diff) {
          h.profValidateMismatches++;
          if (!h.profFirstMismatch) h.profFirstMismatch = diff;
        }
      }
      h.transitionsMs += now() - t;
      h.transitionsCalls++;
      return out;
    }
    const prepared = generatePreparedSearchActions(s as unknown as GameEngineState, rules);
    h.genCalls++;
    h.genMs += now() - t;
    const t2 = now();
    out = prepared.map((p) => {
      const tr = p.transition;
      if (tr.kind === 'deterministic') {
        return { label: label(p.action), outcomes: [{ state: tr.state, weight: 1 }] } as unknown as Transition<S>;
      }
      return { label: label(p.action), outcomes: tr.outcomes.map((o) => ({ state: o.state, weight: o.weight })) } as unknown as Transition<S>;
    });
    h.mapLabelMs += now() - t2;
    h.transitionsMs += now() - t;
    h.transitionsCalls++;
    return out;
  };

  const cache = opts.actionCache;
  const cacheCap = opts.cacheCap ?? Number.POSITIVE_INFINITY;
  const sampledStates: S[] = [];
  const signatureByKey = new Map<string, string>();
  const shadowKeyOf = (s: S) => keyOf(s);

  const walk = (state: S, idx: number): boolean | null => {
    const tw0 = now();
    let childMs = 0;
    const finish = (v: boolean | null): boolean | null => {
      const own = now() - tw0;
      h.selfMs += own - childMs;
      h.childWalkMs += childMs;
      return v;
    };
    const rec = (st: S, i: number): boolean | null => {
      const t = now();
      const v = walk(st, i);
      childMs += now() - t;
      return v;
    };

    if (h.truncated) return finish(null);
    const s = timedSettle(state);
    const term = timedTerminal(s);
    if (term === 'mouse') return finish(terminalMouse);
    if (term === 'cat') return finish(terminalCat);
    const player = timedPlayer(s);
    if (player === 'cat' && idx >= 2 * H) return finish(horizonVal);

    const rawKey = keyOf(s);
    const key = `${idx}|${rawKey}`;
    const tm = now();
    const hit = memo.get(key);
    h.memoGetMs += now() - tm;
    h.memoGetCalls++;
    if (hit !== undefined) { h.memoHits++; return finish(hit); }

    h.nodes++;
    if (h.nodes > cap) { h.truncated = true; return finish(null); }
    if (idx > h.maxIdx) h.maxIdx = idx;

    // ---- expansion bookkeeping (identical state, observed) ----
    const rec0 = h.expansionKeyCounts.get(rawKey);
    if (rec0 === undefined) {
      h.expansionKeyCounts.set(rawKey, 1);
      h.distinctExpansionKeys = h.expansionKeyCounts.size;
    } else {
      h.expansionKeyCounts.set(rawKey, rec0 + 1);
      const prev = h.lastIdxByKey.get(rawKey);
      if (prev === idx) h.repeatExpansionsSameIdx++;
      else h.repeatExpansionsDiffIdx++;
    }
    h.lastIdxByKey.set(rawKey, idx);
    h.expansions++;

    let trs: Transition<S>[];
    if (cache && cache.has(rawKey)) {
      h.cacheHits++;
      const cached = cache.get(rawKey)!;
      if (opts.shadowCompare) {
        const fresh = timedTransitions(s);
        h.shadowChecks++;
        const hasChance = cached.some((t) => t.outcomes.length > 1 || t.outcomes[0].weight !== 1);
        if (hasChance) h.shadowChanceChecks++;
        const diff = compareTransitions(
          cached as unknown as Transition<GameEngineState>[],
          fresh as unknown as Transition<GameEngineState>[],
          (st) => stateKey(st),
        );
        if (diff) {
          h.shadowMismatches++;
          if (!h.shadowFirstMismatch) h.shadowFirstMismatch = `${rawKey.slice(0, 40)}: ${diff}`;
        }
        trs = fresh;
      } else {
        trs = cached as unknown as Transition<S>[];
      }
    } else {
      if (cache) h.cacheMisses++;
      trs = timedTransitions(s);
      if (cache) {
        if (cache.size >= cacheCap) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) { cache.delete(oldest); h.cacheEvictions++; }
        }
        cache.set(rawKey, trs as unknown as Transition<GameEngineState>[]);
        h.cacheSize = cache.size;
      }
    }

    if (trs.length === 0) {
      throw new Error(`no legal action at live node ${key.slice(0, 48)} (mode=${mode})`);
    }
    if (opts.sampleStatesEvery && h.expansions % opts.sampleStatesEvery === 0) {
      sampledStates.push(s);
    }
    if (opts.repeatSignatureCheck) {
      const sig = trs.map((t) => `${t.label}[${t.outcomes.map((o) => `${o.weight}:${keyOf(o.state)}`).join(',')}]`).join(';');
      const prevSig = signatureByKey.get(rawKey);
      if (prevSig === undefined) {
        signatureByKey.set(rawKey, sig);
      } else {
        h.repeatSigChecks++;
        if (prevSig !== sig) {
          h.repeatSigMismatches++;
          if (!h.repeatSigFirstMismatch) h.repeatSigFirstMismatch = `${rawKey.slice(0, 40)}: signature differs`;
        }
      }
    }
    const isOr = player === existential;
    let result: boolean | null = isOr ? false : true;
    let sawNull = false;
    let decided = false;
    let chosen: string | null = null;

    for (const tr of trs) {
      h.transitions++;
      const childPlayer = timedPlayer(timedSettle(tr.outcomes[0].state));
      const ci = childPlayer !== player ? idx + 1 : idx;
      let childVal: boolean | null;
      if (tr.outcomes.length === 1 && tr.outcomes[0].weight === 1) {
        childVal = rec(tr.outcomes[0].state, ci);
      } else {
        h.chanceNodes++;
        h.chanceOutcomes += tr.outcomes.length;
        let all = true;
        for (const o of tr.outcomes) {
          if (o.weight <= 0) continue;
          const v = rec(o.state, ci);
          if (v === null) { all = false; sawNull = true; break; }
          if (v === false) { all = false; break; }
        }
        childVal = all;
      }
      if (opts.trackOutcomeKeys) {
        const tk = now();
        for (const o of tr.outcomes) {
          const ok = keyOf(o.state);
          h.outcomeKeyCalls++;
          if (h.successorKeys.has(ok)) h.duplicateSuccessorKeys++;
          else h.successorKeys.add(ok);
        }
        h.outcomeKeyMs += now() - tk;
      }
      if (childVal === null) { sawNull = true; continue; }
      if (isOr) {
        if (childVal === true) { result = true; chosen = tr.label; h.cutoffs++; decided = true; break; }
        result = false;
      } else {
        if (childVal === false) { result = false; h.cutoffs++; decided = true; break; }
        result = true;
      }
    }

    if (sawNull && !decided) return finish(null);
    const val = result as boolean;
    const ts = now();
    memo.set(key, val);
    h.memoSetMs += now() - ts;
    h.memoSetCalls++;
    if (isOr && val === true && chosen !== null) {
      const tp = now();
      policy.set(key, chosen);
      h.policySetMs += now() - tp;
    }
    return finish(val);
  };

  const value = walk(root, startIdx);
  h.elapsedMs = now() - t0;
  h.distinctSuccessorKeys = h.successorKeys.size;

  return {
    value,
    policy,
    counters: h,
    sampledStates,
    stats: {
      nodes: h.nodes, transitions: h.transitions, chanceNodes: h.chanceNodes,
      chanceOutcomes: h.chanceOutcomes, memoHits: h.memoHits, cutoffs: h.cutoffs,
      truncated: h.truncated, maxIdx: h.maxIdx, elapsedMs: h.elapsedMs,
    },
  };
}

/** Instrumented real-rule adapter (identical lambdas to the frozen realGame). */
export const instrumentedRealGame: GameAdapter<GameEngineState> = {
  settle: (s) => applyNoMoveLoss(s),
  player: (s) => (s.currentPlayer === PieceType.Cat ? 'cat' : 'mouse'),
  terminal: (s) => {
    if (s.phase === GamePhase.MouseWins) return 'mouse';
    if (s.phase === GamePhase.CatWins) return 'cat';
    return null;
  },
  transitions: (s) => generatePreparedSearchActions(s, rules).map((p) => mapTransition(p.action, p.transition)),
  key: (s) => stateKey(s),
};

export function solveInstrumentedReal(
  root: GameEngineState, H: number, startIdx: number, cap: number, mode: Mode, opts: HotOptions = {},
): HotResult {
  return solveInstrumented(instrumentedRealGame, root, H, startIdx, cap, mode, opts);
}

export { transitionSignature };