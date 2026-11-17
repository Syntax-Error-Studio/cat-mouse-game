/**
 * PPC-MCTS-01B-IMPLEMENTATION — correctness test for ROLLOUT-ONLY prepared reuse.
 *
 * Everything is compared against the UNTOUCHED baseline kernels — never against
 * a re-implementation of them:
 *
 *   A. action set / order / originalIndex
 *         generateLegalSearchActions(state,rules)
 *      vs generatePreparedSearchActions(state,rules).map(p => p.action)
 *
 *   B. transition identity — for every action, the transition the prepared batch
 *      KEEPS vs one RECOMPUTED now: kind, stateKey, gameAffectingEqual,
 *      per-outcome stateKey, full canonical serialisation (logs included),
 *      CHANCE cardinality / order / bit-exact weights.
 *
 *   C. rollout guidance — `guidanceValue` (recompute + evaluate) vs
 *      `guidanceValueFromTransition` (reuse), bit-exact (`Object.is`), with every
 *      positive-probability CHANCE outcome contributing under its original weight.
 *
 *   D. RNG consumption — baseline selection rule (verbatim copy of
 *      uct.ts:222-245) vs prepared selection rule on identically seeded counting
 *      RNGs: same chosen action AND the same number of draws.
 *
 *   E. CHANCE sampling — same sampled outcome index from reference weights and
 *      from reused weights.
 *
 *   F. search-level parity — whole-tree fingerprint at fixed node budgets, plus
 *      the impure-path fail-closed carve-out under a deterministic Math.random
 *      stub (draw counts must match the baseline exactly).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEngineRuleSet, type GameEngineState } from '../../../src/game/engine';
import { restoreHardRoot } from '../../../src/game/ai/hardHistory';
import { stateKey } from '../../../src/game/ai/transposition';
import { gameAffectingEqual } from '../../../src/game/ai/stateCompare';
import { generateLegalSearchActions } from '../../../src/game/ai/legalActions';
import { generatePreparedSearchActions } from '../../../src/game/ai/preparedActions';
import { simulateSearchAction } from '../../../src/game/ai/simulator';
import { hybridEvaluateForCat } from '../../../src/game/ai/hybridLeaf';
import { normalizeLeafValue, terminalReward } from '../../../PPC-MCTS-01/proto/value';
import { validateChance, sampleChance } from '../../../PPC-MCTS-01/proto/chance';
import { mulberry32 } from '../../../PPC-MCTS-01/proto/seededRng';
import type { Rng } from '../../../PPC-MCTS-01/proto/seededRng';
import { UctSearch, uctSeed } from '../../../PPC-MCTS-01/proto/uct';
import { UctSearchPrepared, __internals } from '../../proto/uctPrepared';
import { comparable, treeFingerprint } from '../../drivers/lib/arms';
import type { RuleSet, SearchAction } from '../../../src/game/ai/searchTypes';
import { GamePhase, PieceType } from '../../../src/game/types';

const ROOT_FIXTURE = new URL('../../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', import.meta.url);
const ROOT_FIXTURE_SHA256 = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';

const rules: RuleSet = createEngineRuleSet();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function canon(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'undefined';
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

function label(a: SearchAction): string {
  switch (a.type) {
    case 'catPlaceTrap': return 'T';
    case 'mouseSkill': return 'S';
    case 'chooseTunnel': return `X${a.r},${a.c}`;
    case 'catStep': return `C${a.direction.key}`;
    case 'mouseStep': return `M${a.direction.key}`;
  }
}

function leaf(state: GameEngineState): number {
  const t = terminalReward(state);
  if (t !== null) return t;
  return normalizeLeafValue(hybridEvaluateForCat(state));
}

/** Reference guidance: identical arithmetic to uct.ts `guidanceValue`. */
function guidanceReference(state: GameEngineState, action: SearchAction, rs: RuleSet): number {
  const res = simulateSearchAction(state, action, rs);
  if (res.kind === 'deterministic') return leaf(res.state);
  const v = validateChance(res.outcomes);
  let acc = 0;
  for (let i = 0; i < v.outcomes.length; i++) acc += v.weights[i] * leaf(v.outcomes[i].state);
  return acc;
}

interface CountingRng extends Rng { ints: number; nexts: number }

function countingRng(seed: number): CountingRng {
  const base = mulberry32(seed >>> 0);
  const w: CountingRng = {
    ints: 0,
    nexts: 0,
    next(): number { w.nexts++; return base.next(); },
    int(n: number): number { w.ints++; return base.int(n); },
  };
  return w;
}

/**
 * VERBATIM copy of the baseline selection rule, `PPC-MCTS-01/proto/uct.ts`
 * lines 222-245 (file sha256 508a65bf…). Returns the chosen INDEX so it is
 * comparable with the prepared rule. It is not evidence on its own — the
 * whole-tree parity in test F is the authority — it only makes "same choice?
 * same number of draws?" answerable per state.
 */
function selectReference(
  state: GameEngineState, actions: SearchAction[], mode: 'random' | 'hybrid', rs: RuleSet, rng: Rng,
): number {
  if (actions.length === 1) return 0;
  if (mode === 'random') return rng.int(actions.length);
  const maximize = state.currentPlayer === PieceType.Cat;
  let bestVal = maximize ? -Infinity : Infinity;
  let best: number[] = [];
  for (let i = 0; i < actions.length; i++) {
    const val = guidanceReference(state, actions[i], rs);
    if (!Number.isFinite(val)) continue;
    const better = maximize ? val > bestVal + 1e-12 : val < bestVal - 1e-12;
    const equal = Math.abs(val - bestVal) <= 1e-12;
    if (better) { bestVal = val; best = [i]; }
    else if (equal) best.push(i);
  }
  if (best.length === 0) return rng.int(actions.length);
  return best[rng.int(best.length)];
}

// ---------------------------------------------------------------------------
// corpus: bounded BFS over the frozen roots
// ---------------------------------------------------------------------------
const MAX_STATES_PER_ROOT = 250;
const MAX_DEPTH = 6;

interface StateRec { state: GameEngineState; rootId: string; depth: number; repeated: boolean }
interface StateInfo {
  actions: SearchAction[];
  legalCount: number;
  hasDeterministic: boolean;
  hasButterChance: boolean;
  hasCatChance: boolean;
  hasTunnel: boolean;
  hasTrap: boolean;
}

function loadRoots(): { id: string; state: GameEngineState }[] {
  const raw = readFileSync(ROOT_FIXTURE);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(ROOT_FIXTURE_SHA256);
  return (JSON.parse(raw.toString('utf8')) as { id: string; state: unknown }[])
    .map((r) => ({ id: String(r.id), state: restoreHardRoot(r.state as never) }));
}

function bfs(seedState: GameEngineState, rootId: string): StateRec[] {
  const seen = new Set<string>([stateKey(seedState)]);
  const byKey = new Map<string, StateRec>();
  const out: StateRec[] = [{ state: seedState, rootId, depth: 0, repeated: false }];
  byKey.set(stateKey(seedState), out[0]);
  let frontier: { state: GameEngineState; depth: number }[] = [{ state: seedState, depth: 0 }];
  while (frontier.length > 0) {
    const next: { state: GameEngineState; depth: number }[] = [];
    for (const node of frontier) {
      if (node.depth >= MAX_DEPTH) continue;
      for (const p of generatePreparedSearchActions(node.state, rules)) {
        const tr = p.transition;
        const succs = tr.kind === 'deterministic' ? [tr.state] : tr.outcomes.map((o) => o.state);
        for (const succ of succs) {
          const k = stateKey(succ);
          if (seen.has(k)) {
            const hit = byKey.get(k);
            if (hit) hit.repeated = true;
            continue;
          }
          if (out.length >= MAX_STATES_PER_ROOT) continue;
          seen.add(k);
          const rec: StateRec = { state: succ, rootId, depth: node.depth + 1, repeated: false };
          out.push(rec);
          byKey.set(k, rec);
          next.push({ state: succ, depth: node.depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return out;
}

function infoOf(state: GameEngineState): StateInfo {
  const prep = generatePreparedSearchActions(state, rules);
  const actions = prep.map((p) => p.action);
  return {
    actions,
    legalCount: actions.length,
    hasDeterministic: prep.some((p) => p.transition.kind === 'deterministic'),
    hasButterChance: prep.some((p) => p.transition.kind === 'chance' && p.action.type === 'mouseStep'),
    hasCatChance: prep.some((p) => p.transition.kind === 'chance' && (p.action.type === 'catStep' || p.action.type === 'chooseTunnel')),
    hasTunnel: state.phase === GamePhase.ChoosingTunnelExit || actions.some((a) => a.type === 'chooseTunnel'),
    hasTrap: state.trapPosition !== null,
  };
}

interface Scenario { name: string; match: (rec: StateRec, info: StateInfo) => boolean }

const SCENARIOS: Scenario[] = [
  { name: 'plain-cat-move', match: (r, i) => r.state.phase === GamePhase.Playing && r.state.currentPlayer === PieceType.Cat && i.hasDeterministic && i.legalCount >= 2 },
  { name: 'multi-candidate-cat', match: (r, i) => r.state.phase === GamePhase.Playing && r.state.currentPlayer === PieceType.Cat && i.legalCount >= 4 },
  { name: 'mouse-action', match: (r, i) => r.state.phase === GamePhase.Playing && r.state.currentPlayer === PieceType.Mouse && i.legalCount >= 2 },
  { name: 'single-legal-action', match: (_r, i) => i.legalCount === 1 },
  { name: 'tunnel-exit', match: (_r, i) => i.hasTunnel },
  { name: 'butter-chance', match: (_r, i) => i.hasButterChance },
  { name: 'cat-to-mouse-chance', match: (_r, i) => i.hasCatChance },
  { name: 'placement-debt', match: (r) => (r.state.pendingButterPlacementDebt ?? 0) > 0 },
  { name: 'trap-present', match: (_r, i) => i.hasTrap },
  { name: 'terminal', match: (r) => r.state.phase === GamePhase.CatWins || r.state.phase === GamePhase.MouseWins },
  { name: 'repeated-state', match: (r) => r.repeated },
  { name: 'impure-guard', match: (r) => __internals.hitsNonPureItemOverlap(r.state) },
];

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------
describe('PPC-MCTS-01B — rollout-only prepared reuse', () => {
  const corpus: StateRec[] = [];
  const infos = new Map<number, StateInfo>();
  const idxOf = new Map<GameEngineState, number>();

  it('builds the corpus and covers all 12 mandated scenarios', () => {
    // RANDOM-STREAM ISOLATION (this is the correction).
    //
    // A synthetic CAT-turn state whose `trapPosition` sits on a butter makes
    // `engine.catMove` call `sanitizeItemOverlaps`, which relocates that butter
    // through `Math.random`. Such a state is not a function of its inputs, so
    // enumerating it twice can yield two different action sets and the global
    // Math.random stream is advanced as a side effect. Putting it in the shared
    // parity corpus therefore (a) consumed entropy the other suites never
    // accounted for and (b) made test A non-deterministic.
    //
    // It is removed from the corpus. The `impure-guard` coverage point is now
    // carried by a MOUSE-turn state instead: `mouseStep` does not sanitise, so
    // the overlap survives into the successor without ever touching
    // Math.random. The fail-closed fallback itself is verified by test F alone.
    const originalRandom = Math.random;
    let randomDraws = 0;
    Math.random = () => {
      randomDraws++;
      throw new Error('Math.random inside corpus construction / enumeration');
    };
    try {
    const roots = loadRoots();
    for (const r of roots) corpus.push(...bfs(r.state, r.id));

    const base = JSON.parse(JSON.stringify(roots[0].state)) as GameEngineState;
    const mk = (mut: (s: GameEngineState) => void): void => {
      const s = JSON.parse(JSON.stringify(base)) as GameEngineState;
      mut(s);
      corpus.push({ state: s, rootId: 'SYNTHETIC', depth: 0, repeated: false });
    };
    mk((s) => { s.phase = GamePhase.CatWins; s.currentPlayer = PieceType.Cat; });
    mk((s) => { s.phase = GamePhase.MouseWins; s.currentPlayer = PieceType.Mouse; });
    mk((s) => {
      s.phase = GamePhase.ChoosingTunnelExit;
      s.currentPlayer = PieceType.Mouse;
      s.tunnelExitChoices = [{ r: 0, c: 0, label: 'A' }];
    });
    mk((s) => {
      s.phase = GamePhase.Playing;
      s.currentPlayer = PieceType.Cat;
      s.catMovesLeft = 1;
      s.pendingButterSpawns = [];
      s.pendingButterPlacementDebt = 2;
    });
    if (base.butterPositions.length > 0) {
      // MOUSE turn on purpose — see the isolation note above.
      mk((s) => {
        s.phase = GamePhase.Playing;
        s.currentPlayer = PieceType.Mouse;
        s.mouseMovesLeft = 4;
        s.mouseHasButter = false;
        s.mouseSkillActive = false;
        s.catMovesLeft = 0;
        s.pendingButterSpawns = [];
        s.pendingButterPlacementDebt = 0;
        s.trapPosition = { r: s.butterPositions[0].r, c: s.butterPositions[0].c };
      });
    }

    corpus.forEach((rec, i) => {
      idxOf.set(rec.state, i);
      infos.set(i, infoOf(rec.state));
    });

    const coverage = SCENARIOS.map((sc) => ({
      name: sc.name,
      states: corpus.filter((r) => sc.match(r, infos.get(idxOf.get(r.state)!)!)).length,
    }));
    const lines = [`corpus=${corpus.length} states`];
    for (const c of coverage) lines.push(`  ${c.name.padEnd(22)} ${c.states}`);
    console.log(lines.join('\n'));
    for (const c of coverage) {
      expect(c.states, `scenario "${c.name}" has no states`).toBeGreaterThan(0);
    }
    expect(corpus.length).toBeGreaterThan(2000);
    } finally {
      Math.random = originalRandom;
    }
    expect(randomDraws, 'Math.random draws during corpus construction').toBe(0);

    // The overlap state must be present for coverage, and must be a MOUSE turn
    // (a CAT turn would have advanced the global stream above).
    const overlapStates = corpus.filter((r) => __internals.hitsNonPureItemOverlap(r.state));
    expect(overlapStates.length).toBeGreaterThan(0);
    for (const r of overlapStates) {
      expect(r.state.currentPlayer, 'overlap corpus state must be a mouse turn').toBe(PieceType.Mouse);
    }
  });

  /** The trap-on-butter states are NOT pure in the baseline either (engine.catMove
   *  relocates the overlapping butter through Math.random), so "reuse === recompute"
   *  is not a property of the baseline there. They are excluded from B/C/D and
   *  covered by test F (fail-closed) instead. */
  const pureCorpus = (): StateRec[] => corpus.filter((r) => !__internals.hitsNonPureItemOverlap(r.state));

  it('A: action set, order and originalIndex are identical', () => {
    // Same isolation gate as the corpus build: enumerating the WHOLE corpus
    // (including the mouse-turn overlap state) must be entropy-free. If this
    // ever fires, an impure state has leaked back into the enumeration path.
    const originalRandom = Math.random;
    let randomDraws = 0;
    Math.random = () => {
      randomDraws++;
      throw new Error('Math.random inside the A enumeration sweep');
    };
    let checked = 0;
    try {
      for (const rec of corpus) {
        const legacy = generateLegalSearchActions(rec.state, rules);
        const prep = generatePreparedSearchActions(rec.state, rules);
        expect(prep.length, `count @${stateKey(rec.state).slice(0, 12)}`).toBe(legacy.length);
        for (let i = 0; i < legacy.length; i++) {
          expect(label(prep[i].action), `action @${stateKey(rec.state).slice(0, 12)}`).toBe(label(legacy[i]));
          expect(prep[i].originalIndex).toBe(i);
        }
        checked++;
      }
    } finally {
      Math.random = originalRandom;
    }
    expect(randomDraws, 'Math.random draws during the A sweep').toBe(0);
    expect(checked).toBe(corpus.length);
  });

  it('B: reused transition === recomputed transition', () => {
    // G-5 in-line: the pure corpus must not touch Math.random at all.
    const originalRandom = Math.random;
    let randomCalls = 0;
    Math.random = () => { randomCalls++; throw new Error('Math.random inside the pure sweep'); };
    try {
    let deterministic = 0;
    let chance = 0;
    let outcomes = 0;
    for (const rec of pureCorpus()) {
      const s = rec.state;
      for (const p of generatePreparedSearchActions(s, rules)) {
        const ref = simulateSearchAction(s, p.action, rules);
        expect(p.transition.kind).toBe(ref.kind);
        if (ref.kind === 'deterministic' && p.transition.kind === 'deterministic') {
          expect(stateKey(p.transition.state)).toBe(stateKey(ref.state));
          expect(gameAffectingEqual(ref.state, p.transition.state)).toBe(true);
          expect(canon(p.transition.state)).toBe(canon(ref.state));
          if (p.action.type !== 'chooseTunnel') {
            expect(gameAffectingEqual(s, p.transition.state)).toBe(false);
          }
          deterministic++;
        } else if (ref.kind === 'chance' && p.transition.kind === 'chance') {
          expect(p.transition.outcomes.length).toBe(ref.outcomes.length);
          for (let i = 0; i < ref.outcomes.length; i++) {
            expect(Object.is(p.transition.outcomes[i].weight, ref.outcomes[i].weight)).toBe(true);
            expect(stateKey(p.transition.outcomes[i].state)).toBe(stateKey(ref.outcomes[i].state));
            expect(canon(p.transition.outcomes[i].state)).toBe(canon(ref.outcomes[i].state));
            outcomes++;
          }
          const sum = p.transition.outcomes.reduce((acc, o) => acc + o.weight, 0);
          expect(Math.abs(sum - 1)).toBeLessThanOrEqual(1e-9);
          chance++;
        }
      }
    }
    console.log(`  deterministic=${deterministic} chance=${chance} outcomes=${outcomes}`);
    expect(deterministic).toBeGreaterThan(1000);
    expect(chance).toBeGreaterThan(10);
    } finally {
      Math.random = originalRandom;
    }
    expect(randomCalls, 'Math.random calls on the pure corpus').toBe(0);
  });

  it('C: guidance from the reused transition === guidance from a recomputed one', () => {
    let compared = 0;
    let chanceWeighted = 0;
    for (const rec of pureCorpus()) {
      const s = rec.state;
      for (const p of generatePreparedSearchActions(s, rules)) {
        const reused = __internals.guidanceValueFromTransition(p.transition);
        const reference = guidanceReference(s, p.action, rules);
        expect(Object.is(reused, reference), `guidance @${stateKey(s).slice(0, 12)} ${label(p.action)}`).toBe(true);
        if (p.transition.kind === 'chance') chanceWeighted++;
        compared++;
      }
    }
    console.log(`  guidance comparisons=${compared} (chance-weighted=${chanceWeighted})`);
    expect(compared).toBeGreaterThan(1000);
    expect(chanceWeighted).toBeGreaterThan(0);
  });

  it('D: identical choice and identical RNG draw count', () => {
    let selections = 0;
    let ties = 0;
    let chanceSamples = 0;
    for (const rec of pureCorpus()) {
      const s = rec.state;
      const prep = generatePreparedSearchActions(s, rules);
      if (prep.length === 0) continue;
      const actions = prep.map((p) => p.action);

      for (const mode of ['random', 'hybrid'] as const) {
        const rngA = countingRng(0x9e3779b9);
        const rngB = countingRng(0x9e3779b9);
        const idxA = selectReference(s, actions, mode, rules, rngA);
        const idxB = prep.length === 1 ? 0 : __internals.selectPreparedRolloutIndex(s, prep, mode, rngB);
        expect(label(actions[idxB]), `choice @${stateKey(s).slice(0, 12)} ${mode}`).toBe(label(actions[idxA]));
        expect(rngB.ints, `rng.int draws @${stateKey(s).slice(0, 12)} ${mode}`).toBe(rngA.ints);
        expect(rngB.nexts).toBe(rngA.nexts);
        if (mode === 'hybrid') {
          const vals = prep.map((p) => __internals.guidanceValueFromTransition(p.transition)).filter(Number.isFinite);
          if (vals.length > 0) {
            const best = s.currentPlayer === PieceType.Cat ? Math.max(...vals) : Math.min(...vals);
            if (vals.filter((v) => Math.abs(v - best) <= 1e-12).length > 1) ties++;
          }
        }
        selections++;
      }

      for (const p of prep) {
        if (p.transition.kind !== 'chance') continue;
        const fresh = simulateSearchAction(s, p.action, rules);
        if (fresh.kind !== 'chance') continue;
        const ref = validateChance(fresh.outcomes);
        const reused = validateChance(p.transition.outcomes);
        for (let k = 0; k < 4; k++) {
          expect(sampleChance(reused, countingRng(1000 + k))).toBe(sampleChance(ref, countingRng(1000 + k)));
          chanceSamples++;
        }
      }
    }
    console.log(`  selections=${selections} hybrid-tie-breaks=${ties} chance-samples=${chanceSamples}`);
    expect(selections).toBeGreaterThan(1000);
    expect(ties).toBeGreaterThan(0);
    expect(chanceSamples).toBeGreaterThan(0);
  });

  it('E: whole-tree parity at a fixed node budget (both rollout modes)', () => {
    const roots = loadRoots().filter((r) => ['G1T1', 'G2T6', 'G5T4', 'G6T1'].includes(r.id));
    expect(roots.length).toBe(4);
    let cells = 0;
    for (const root of roots) {
      for (const mode of ['hybrid', 'random'] as const) {
        for (const budget of [4, 16, 64]) {
          const seed = uctSeed(root.id, 'UCT-H', 0);
          const opts = {
            rules, deadlineMs: 1, maxHandoffs: 4, maxNodes: budget, c: Math.SQRT2,
            seed, rollout: mode, now: () => 0,
          };
          const base = new UctSearch(root.state, opts).run();
          const prep = new UctSearchPrepared(root.state, opts).run();
          const a = comparable(base);
          const b = comparable(prep);
          const ctx = `${root.id}/${mode}/K=${budget}`;
          expect(b.digest, `tree digest ${ctx}`).toBe(a.digest);
          expect(b.plan, `plan ${ctx}`).toBe(a.plan);
          expect(b.extensionSteps, `extensionSteps ${ctx}`).toBe(a.extensionSteps);
          expect(b.treePlanLength, `treePlanLength ${ctx}`).toBe(a.treePlanLength);
          expect(b.planCost).toBe(a.planCost);
          expect(b.rootAction).toBe(a.rootAction);
          expect(b.rootVisits).toBe(a.rootVisits);
          expect(b.rootMeanReward).toBe(a.rootMeanReward);
          expect(b.rootActionStats).toEqual(a.rootActionStats);
          expect(b.diagnostics).toEqual(a.diagnostics);
          expect(b.chanceSamples).toBe(a.chanceSamples);
          if (prep.diagnostics.simulations > 0) {
            expect(prep.diagnostics.rolloutPreparedSteps, `prepared steps used ${ctx}`).toBeGreaterThan(0);
            expect(prep.diagnostics.rolloutImpureFallbacks, `impure fallbacks ${ctx}`).toBe(0);
          }
          cells++;
        }
      }
    }
    expect(cells).toBe(24);
  });

  it('F: fail-closed on the impure trap/butter overlap (Math.random stubbed deterministically)', () => {
    const roots = loadRoots();
    // A CAT-turn root cannot exercise the guard: `catMove` sanitises the overlap
    // before it produces any successor, so every rollout start state is already
    // clean. A MOUSE-turn root can — `mouseStep` does not sanitise — so the
    // overlap survives into the mouse successors the rollout starts from.
    // The construction below therefore uses a mouse turn.
    let s: GameEngineState | null = null;
    for (const r of roots) {
      if (r.state.butterPositions.length === 0) continue;
      const cand = JSON.parse(JSON.stringify(r.state)) as GameEngineState;
      cand.phase = GamePhase.Playing;
      cand.currentPlayer = PieceType.Mouse;
      cand.mouseMovesLeft = 4;
      cand.mouseHasButter = false;
      cand.mouseSkillActive = false;
      cand.catMovesLeft = 0;
      cand.pendingButterSpawns = [];
      cand.pendingButterPlacementDebt = 0;
      cand.trapPosition = { r: cand.butterPositions[0].r, c: cand.butterPositions[0].c };
      if (__internals.hitsNonPureItemOverlap(cand) && generateLegalSearchActions(cand, rules).length > 0) {
        s = cand;
        break;
      }
    }
    expect(s, 'no root yields a moveable mouse with a trap sitting on a butter').not.toBeNull();
    const impure = s!;
    expect(__internals.hitsNonPureItemOverlap(impure)).toBe(true);

    const original = Math.random;
    let draws = 0;
    let seed = 12345;
    Math.random = () => {
      draws++;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    try {
      const opts = {
        rules, deadlineMs: 1, maxHandoffs: 4, maxNodes: 24, c: Math.SQRT2,
        seed: uctSeed('IMPURE', 'UCT-H', 0), rollout: 'hybrid' as const, now: () => 0,
      };
      const resetStream = (): void => { draws = 0; seed = 12345; };
      resetStream();
      const base = new UctSearch(impure, opts).run();
      const drawsBase = draws;
      resetStream();
      const prep = new UctSearchPrepared(impure, opts).run();
      const drawsPrep = draws;

      expect(drawsBase, 'baseline must hit the impure path').toBeGreaterThan(0);
      expect(drawsPrep, 'prepared must consume the same number of draws').toBe(drawsBase);
      expect(treeFingerprint(prep.root)).toBe(treeFingerprint(base.root));
      // mixed path: impure steps fall back, clean steps use the batch
      expect(prep.diagnostics.rolloutImpureFallbacks).toBeGreaterThan(0);
      expect(prep.diagnostics.rolloutPreparedSteps).toBeGreaterThan(0);
      // the legacy path is taken for ONE reason only
      expect(prep.diagnostics.rolloutLegacySteps).toBe(prep.diagnostics.rolloutImpureFallbacks);
    } finally {
      Math.random = original;
    }
  });
});
