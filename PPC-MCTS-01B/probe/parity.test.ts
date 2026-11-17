/**
 * PPC-MCTS-01B-PHASE0 — prepared-transition contract parity probe (read-only).
 *
 * Compares, on a real corpus, the two candidate-enumeration contracts:
 *
 *   LEGACY  : generateLegalSearchActions(state)             [N simulations]
 *             + simulateSearchAction(state, a) per survivor  [L simulations]
 *             = the exact two-step dance uct.ts performs at tree expansion.
 *
 *   PREPARED: generatePreparedSearchActions(state)           [N simulations]
 *             (transition carried forward, no second simulation)
 *
 * For every state the probe checks: action set, action ORDER, transition kind,
 * successor identity (stateKey + gameAffectingEqual + full structural equality),
 * CHANCE cardinality / order / weights / per-outcome identity, mateActionCost,
 * originalIndex, input immutability, reference aliasing, evaluation stability
 * and repeated-read stability.
 *
 * Nothing in src/ is modified. Output: PPC-MCTS-01B/data/parity.json
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEngineRuleSet, type GameEngineState } from '../../src/game/engine';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { stateKey } from '../../src/game/ai/transposition';
import { gameAffectingEqual } from '../../src/game/ai/stateCompare';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import {
  enumerateSearchActionCandidates,
  generatePreparedSearchActions,
} from '../../src/game/ai/preparedActions';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { mateActionCost } from '../../src/game/ai/expectiminimax';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { hybridEvaluateForCat } from '../../src/game/ai/hybridLeaf';
import type { RuleSet, SearchAction } from '../../src/game/ai/searchTypes';
import { GamePhase, PieceType } from '../../src/game/types';

const ROOT_FIXTURE = new URL('../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', import.meta.url);
const ROOT_FIXTURE_SHA256 = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const OUT_DIR = new URL('../data/', import.meta.url);

const rules = createEngineRuleSet();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function stable(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'undefined';
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
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

function actionFns(): string[] {
  return ['mouseStep', 'catMove', 'mouseSkill', 'catPlaceTrap', 'chooseTunnelExit'];
}

/** Rule-call counter (delegates 1:1; records nothing about state content). */
function countingRules(base: RuleSet): { rules: RuleSet; total: () => number; reset: () => void } {
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
  return { rules: r, total: () => n, reset: () => { n = 0; } };
}

interface RootRecord { id: string; state: unknown }

function loadRoots(): { id: string; state: GameEngineState }[] {
  const raw = readFileSync(ROOT_FIXTURE);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(ROOT_FIXTURE_SHA256);
  return (JSON.parse(raw.toString('utf8')) as RootRecord[]).map((r) => ({
    id: r.id,
    state: restoreHardRoot(r.state as never),
  }));
}

// ---------------------------------------------------------------------------
// corpus
// ---------------------------------------------------------------------------
interface CorpusEntry { tag: string; state: GameEngineState }

const MAX_STATES_PER_ROOT = 400;
const MAX_DEPTH = 8;

/**
 * Deterministic bounded BFS: every successor (all CHANCE outcomes, not a
 * sample) is enqueued; dedupe by stateKey; stop at the per-root cap.
 */
function bfs(seedState: GameEngineState, tag: string): { entries: CorpusEntry[]; dropped: number; multiPathHits: number } {
  const seen = new Set<string>([stateKey(seedState)]);
  const entries: CorpusEntry[] = [{ tag: `${tag}|d0`, state: seedState }];
  let frontier: { state: GameEngineState; depth: number }[] = [{ state: seedState, depth: 0 }];
  let dropped = 0;
  let multiPathHits = 0;
  while (frontier.length > 0) {
    const next: { state: GameEngineState; depth: number }[] = [];
    for (const node of frontier) {
      if (node.depth >= MAX_DEPTH) continue;
      for (const p of generatePreparedSearchActions(node.state, rules)) {
        const tr = p.transition;
        const succs = tr.kind === 'deterministic' ? [tr.state] : tr.outcomes.map((o) => o.state);
        for (const succ of succs) {
          const k = stateKey(succ);
          if (seen.has(k)) { multiPathHits++; continue; }
          if (entries.length >= MAX_STATES_PER_ROOT) { dropped++; continue; }
          seen.add(k);
          entries.push({ tag: `${tag}|d${node.depth + 1}`, state: succ });
          next.push({ state: succ, depth: node.depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return { entries, dropped, multiPathHits };
}

/** Hand-built special states that the frozen roots do not necessarily cover. */
function specialStates(base: GameEngineState): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  const b = clone(base);

  const push = (tag: string, mut: (s: GameEngineState) => void): void => {
    const s = clone(b);
    mut(s);
    out.push({ tag, state: s });
  };

  // terminal phases
  push('special|terminal-catwins', (s) => { s.phase = GamePhase.CatWins; s.currentPlayer = PieceType.Cat; });
  push('special|terminal-mousewins', (s) => { s.phase = GamePhase.MouseWins; s.currentPlayer = PieceType.Mouse; });

  // tunnel-exit choice (legacy: zero simulation; prepared: one per exit)
  push('special|tunnel-1', (s) => {
    s.phase = GamePhase.ChoosingTunnelExit;
    s.currentPlayer = PieceType.Mouse;
    s.tunnelExitChoices = [{ r: 0, c: 0, label: 'A' }];
  });
  push('special|tunnel-3', (s) => {
    s.phase = GamePhase.ChoosingTunnelExit;
    s.currentPlayer = PieceType.Mouse;
    s.tunnelExitChoices = [
      { r: 0, c: 0, label: 'A' }, { r: 0, c: 9, label: 'B' }, { r: 9, c: 9, label: 'C' },
    ];
  });

  // cat with a free trap slot (catPlaceTrap: 0 move cost)
  push('special|cat-trap-free', (s) => {
    s.phase = GamePhase.Playing; s.currentPlayer = PieceType.Cat;
    s.catMovesLeft = 4; s.trapPosition = null; s.catTrapsRemaining = 1;
  });
  push('special|cat-trap-present', (s) => {
    s.phase = GamePhase.Playing; s.currentPlayer = PieceType.Cat;
    s.catMovesLeft = 4; s.trapPosition = { r: 5, c: 5 }; s.catTrapsRemaining = 0;
  });

  // CAT→MOUSE ghost boundary as a CHANCE successor of the last cat step
  push('special|ghost-boundary', (s) => {
    s.phase = GamePhase.Playing; s.currentPlayer = PieceType.Cat;
    s.catMovesLeft = 1;
    s.pendingButterSpawns = [{ r: 0, c: 1, blockedMaterializations: 0 }];
    s.pendingButterPlacementDebt = 0;
  });

  // placement debt at the CAT→MOUSE boundary
  push('special|placement-debt', (s) => {
    s.phase = GamePhase.Playing; s.currentPlayer = PieceType.Cat;
    s.catMovesLeft = 1;
    s.pendingButterSpawns = [];
    s.pendingButterPlacementDebt = 2;
  });

  // mouse carrying butter, skill not yet used (mouseSkill: 0 move cost)
  push('special|mouse-skill-available', (s) => {
    s.phase = GamePhase.Playing; s.currentPlayer = PieceType.Mouse;
    s.mouseMovesLeft = 3; s.mouseHasButter = true; s.mouseSkillActive = false;
    s.pendingButterSpawns = []; s.pendingButterPlacementDebt = 0; s.trapPosition = null;
  });

  // mouse moving onto a butter → butter-pickup CHANCE
  push('special|butter-pickup', (s) => {
    s.phase = GamePhase.Playing; s.currentPlayer = PieceType.Mouse;
    s.mouseMovesLeft = 4; s.mouseHasButter = false; s.mouseSkillActive = false;
    s.pendingButterSpawns = []; s.pendingButterPlacementDebt = 0; s.trapPosition = null;
    const m = s.mousePosition;
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dr, dc] of dirs) {
      const r = m.r + dr, c = m.c + dc;
      const cell = s.board[r]?.[c];
      if (!cell || cell.type !== 'empty') continue;
      if (r === s.catPosition.r && c === s.catPosition.c) continue;
      s.butterPositions = [{ r, c }];
      break;
    }
  });

  // zero legal actions but still Playing (all four cat directions blocked)
  push('special|cat-wedged', (s) => {
    s.phase = GamePhase.Playing; s.currentPlayer = PieceType.Cat;
    s.catMovesLeft = 4; s.trapPosition = { r: 5, c: 5 }; s.catTrapsRemaining = 0;
    const p = s.catPosition;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const r = p.r + dr, c = p.c + dc;
      if (s.board[r]?.[c]) s.board[r][c] = { ...s.board[r][c], type: 'wall' as never, piece: undefined };
    }
  });

  // variable cat move budget (plan-bound domain)
  for (const m of [1, 4, 6, 9]) {
    push(`special|catmoves-${m}`, (s) => {
      s.phase = GamePhase.Playing; s.currentPlayer = PieceType.Cat;
      s.config = { ...s.config, catBaseMoves: m };
      s.catMovesLeft = m;
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// per-state parity
// ---------------------------------------------------------------------------
interface Mismatch { tag: string; what: string; detail: string }

interface Acc {
  states: number;
  statesWithActions: number;
  candidates: number;
  legal: number;
  illegalCandidates: number;
  deterministic: number;
  chance: number;
  chanceOutcomes: number;
  chanceByAction: Record<string, number>;
  legacyTwoStepRuleCalls: number;
  legacyGeneratorOnlyCalls: number;
  preparedRuleCalls: number;
  shortCircuitStates: Array<{ tag: string; candidates: number; ruleCalls: number }>;
  preparedExtraRuleCalls: number;
  emptyLegalWhilePlaying: Array<{ tag: string; phase: string; player: string }>;
  trapButterOverlap: string[];
  mismatches: Mismatch[];
  aliasFields: Record<string, number>;
  aliasStates: number;
  aliasExamples: Array<{ tag: string; fields: string[] }>;
  evalStable: number;
  evalUnstable: string[];
  reuseStable: number;
  reuseUnstable: string[];
  tunnelStates: Array<{ tag: string; exits: number; legacy: number; prepared: number }>;
}

function newAcc(): Acc {
  return {
    states: 0,
    statesWithActions: 0,
    candidates: 0,
    legal: 0,
    illegalCandidates: 0,
    deterministic: 0,
    chance: 0,
    chanceOutcomes: 0,
    chanceByAction: {},
    legacyTwoStepRuleCalls: 0,
    legacyGeneratorOnlyCalls: 0,
    preparedRuleCalls: 0,
    shortCircuitStates: [],
    preparedExtraRuleCalls: 0,
    emptyLegalWhilePlaying: [],
    trapButterOverlap: [],
    mismatches: [],
    aliasFields: {},
    aliasStates: 0,
    aliasExamples: [],
    evalStable: 0,
    evalUnstable: [],
    reuseStable: 0,
    reuseUnstable: [],
    tunnelStates: [],
  };
}

const ALIAS_FIELDS: (keyof GameEngineState)[] = [
  'board', 'config', 'catPosition', 'mousePosition', 'butterPositions',
  'pendingButterSpawns', 'blockedTunnels', 'tunnelExitChoices',
  'trapPosition', 'catActionLog', 'gameEventLog',
];

function aliasFieldsOf(a: GameEngineState, b: GameEngineState): string[] {
  const fields: string[] = [];
  for (const f of ALIAS_FIELDS) {
    if ((a as never as Record<string, unknown>)[f as string] === (b as never as Record<string, unknown>)[f as string]) {
      const v = (a as never as Record<string, unknown>)[f as string];
      // primitives compare by value: only report reference-typed sharing
      if (v !== null && typeof v === 'object') fields.push(String(f));
    }
  }
  // element-level sharing inside the reference-typed fields that matter
  if (Array.isArray(a.butterPositions) && Array.isArray(b.butterPositions)) {
    if (a.butterPositions.length > 0 && a.butterPositions[0] === b.butterPositions[0]) fields.push('butterPositions[]');
  }
  if (Array.isArray(a.pendingButterSpawns) && Array.isArray(b.pendingButterSpawns)) {
    if (a.pendingButterSpawns.length > 0 && a.pendingButterSpawns[0] === b.pendingButterSpawns[0]) fields.push('pendingButterSpawns[]');
  }
  if (Array.isArray(a.board) && Array.isArray(b.board)) {
    if (a.board.length > 0 && a.board[0] === b.board[0]) fields.push('board[]');
    else if (a.board.length > 0 && a.board[0][0] === b.board[0][0]) fields.push('board[][]');
  }
  return fields;
}

function checkState(entry: CorpusEntry, acc: Acc): void {
  const { tag, state } = entry;
  acc.states++;

  // Q11 precondition: trap∧butter overlap would make catMove consume one
  // WORLD random draw (sanitizeItemOverlaps). Record if it ever occurs.
  if (state.trapPosition && state.butterPositions.some(
    (bp) => bp.r === state.trapPosition!.r && bp.c === state.trapPosition!.c,
  )) acc.trapButterOverlap.push(tag);

  const before = stable(state);

  // ---- legacy two-step ----
  const counter = countingRules(rules);
  counter.reset();
  const legal = generateLegalSearchActions(state, counter.rules);
  const generatorOnlyCalls = counter.total();
  for (const a of legal) simulateSearchAction(state, a, counter.rules);
  const legacyCalls = counter.total();

  // ---- prepared one-step ----
  const counter2 = countingRules(rules);
  counter2.reset();
  const prepared = generatePreparedSearchActions(state, counter2.rules);
  const preparedCalls = counter2.total();

  acc.legacyTwoStepRuleCalls += legacyCalls;
  acc.legacyGeneratorOnlyCalls += generatorOnlyCalls;

  const candCount = enumerateSearchActionCandidates(state).length;
  if (candCount > 0 && preparedCalls < candCount) {
    acc.shortCircuitStates.push({ tag, candidates: candCount, ruleCalls: preparedCalls });
  }
  acc.preparedRuleCalls += preparedCalls;
  acc.preparedExtraRuleCalls += preparedCalls - legacyCalls;

  if (prepared.length > 0) acc.statesWithActions++;
  acc.candidates += enumerateSearchActionCandidates(state).length;
  acc.legal += legal.length;
  acc.illegalCandidates += enumerateSearchActionCandidates(state).length - legal.length;

  if (state.phase === GamePhase.Playing && legal.length === 0) {
    acc.emptyLegalWhilePlaying.push({ tag, phase: state.phase, player: String(state.currentPlayer) });
  }

  if (state.phase === GamePhase.ChoosingTunnelExit) {
    acc.tunnelStates.push({ tag, exits: state.tunnelExitChoices.length, legacy: legacyCalls, prepared: preparedCalls });
  }

  // Q1 / Q2 — same set, same order
  const pActions = prepared.map((p) => p.action);
  if (pActions.length !== legal.length) {
    acc.mismatches.push({ tag, what: 'set-size', detail: `prepared=${pActions.length} legacy=${legal.length}` });
  }
  for (let i = 0; i < Math.min(pActions.length, legal.length); i++) {
    if (stable(pActions[i]) !== stable(legal[i])) {
      acc.mismatches.push({ tag, what: 'order', detail: `i=${i} prepared=${label(pActions[i])} legacy=${label(legal[i])}` });
    }
    if (prepared[i].originalIndex !== i) {
      acc.mismatches.push({ tag, what: 'originalIndex', detail: `i=${i} got=${prepared[i].originalIndex}` });
    }
    // Q6 — plan cost is a pure function of the action type
    if (mateActionCost(prepared[i].action) !== mateActionCost(legal[i])) {
      acc.mismatches.push({ tag, what: 'mateActionCost', detail: `${label(legal[i])}` });
    }
  }

  // Q3 / Q4 / Q5 / Q7 — transition identity against a fresh simulation
  for (const p of prepared) {
    const fresh = simulateSearchAction(state, p.action, rules);
    if (p.transition.kind !== fresh.kind) {
      acc.mismatches.push({ tag, what: 'kind', detail: `${label(p.action)} prepared=${p.transition.kind} fresh=${fresh.kind}` });
      continue;
    }
    if (p.transition.kind === 'deterministic' && fresh.kind === 'deterministic') {
      acc.deterministic++;
      if (stateKey(p.transition.state) !== stateKey(fresh.state)) {
        acc.mismatches.push({ tag, what: 'stateKey', detail: label(p.action) });
      }
      if (!gameAffectingEqual(p.transition.state, fresh.state)) {
        acc.mismatches.push({ tag, what: 'gameAffectingEqual', detail: label(p.action) });
      }
      if (stable(p.transition.state) !== stable(fresh.state)) {
        acc.mismatches.push({ tag, what: 'full-state', detail: label(p.action) });
      }
      // Q8 — reference sharing between input and successor
      const fields = aliasFieldsOf(state, p.transition.state);
      if (fields.length > 0) {
        acc.aliasStates++;
        for (const f of fields) acc.aliasFields[f] = (acc.aliasFields[f] ?? 0) + 1;
        if (acc.aliasExamples.length < 20) acc.aliasExamples.push({ tag, fields });
      }
      // Q9 — nothing downstream may mutate the transition state
      const snap = stable(p.transition.state);
      evaluateForCat(p.transition.state);
      hybridEvaluateForCat(p.transition.state);
      stateKey(p.transition.state);
      gameAffectingEqual(p.transition.state, p.transition.state);
      if (stable(p.transition.state) === snap) acc.evalStable++;
      else acc.evalUnstable.push(`${tag}|${label(p.action)}`);
      // Q10 — repeated reads of the same prepared transition are stable
      const k1 = stateKey(p.transition.state);
      const k2 = stateKey(p.transition.state);
      const k3 = stateKey(p.transition.state);
      if (k1 === k2 && k2 === k3) acc.reuseStable++;
      else acc.reuseUnstable.push(`${tag}|${label(p.action)}`);
    } else if (p.transition.kind === 'chance' && fresh.kind === 'chance') {
      acc.chance++;
      acc.chanceOutcomes += p.transition.outcomes.length;
      const kind = `${p.action.type}`;
      acc.chanceByAction[kind] = (acc.chanceByAction[kind] ?? 0) + 1;
      if (p.transition.outcomes.length !== fresh.outcomes.length) {
        acc.mismatches.push({ tag, what: 'chance-cardinality', detail: `${label(p.action)} ${p.transition.outcomes.length} vs ${fresh.outcomes.length}` });
        continue;
      }
      const wA = p.transition.outcomes.map((o) => o.weight);
      const wB = fresh.outcomes.map((o) => o.weight);
      if (stable(wA) !== stable(wB)) {
        acc.mismatches.push({ tag, what: 'chance-weights', detail: label(p.action) });
      }
      const kA = p.transition.outcomes.map((o) => stateKey(o.state));
      const kB = fresh.outcomes.map((o) => stateKey(o.state));
      if (stable(kA) !== stable(kB)) {
        acc.mismatches.push({ tag, what: 'chance-order', detail: label(p.action) });
      }
      const sum = wA.reduce((x, y) => x + y, 0);
      if (Math.abs(sum - 1) > 1e-9) {
        acc.mismatches.push({ tag, what: 'chance-mass', detail: `${label(p.action)} sum=${sum}` });
      }
      if (wA.some((w) => !Number.isFinite(w) || w <= 0)) {
        acc.mismatches.push({ tag, what: 'chance-nonpositive', detail: label(p.action) });
      }
      for (let i = 0; i < p.transition.outcomes.length; i++) {
        if (!gameAffectingEqual(p.transition.outcomes[i].state, fresh.outcomes[i].state)) {
          acc.mismatches.push({ tag, what: 'chance-outcome-gameAffecting', detail: `${label(p.action)}#${i}` });
        }
        if (stable(p.transition.outcomes[i].state) !== stable(fresh.outcomes[i].state)) {
          acc.mismatches.push({ tag, what: 'chance-outcome-full', detail: `${label(p.action)}#${i}` });
        }
      }
      const snap = stable(p.transition.outcomes);
      for (const o of p.transition.outcomes) { hybridEvaluateForCat(o.state); evaluateForCat(o.state); }
      if (stable(p.transition.outcomes) === snap) acc.evalStable++;
      else acc.evalUnstable.push(`${tag}|${label(p.action)}|chance`);
    }
  }

  // Q-Q9/Q10 — the INPUT state must survive both generators untouched
  if (stable(state) !== before) {
    acc.mismatches.push({ tag, what: 'input-mutated', detail: 'generator mutated its input state' });
  }
}

// ---------------------------------------------------------------------------
// the probe
// ---------------------------------------------------------------------------
describe('PPC-MCTS-01B-PHASE0 · prepared vs legacy transition parity', () => {
  it('is identical on every state of the derived corpus', () => {
    const roots = loadRoots();
    const acc = newAcc();
    const perRoot: Record<string, { states: number; dropped: number; mismatches: number }> = {};
    let droppedTotal = 0;
    let multiPathHitsTotal = 0;

    for (const root of roots) {
      const { entries, dropped, multiPathHits } = bfs(root.state, root.id);
      droppedTotal += dropped;
      multiPathHitsTotal += multiPathHits;
      const before = acc.mismatches.length;
      for (const e of entries) checkState(e, acc);
      perRoot[root.id] = { states: entries.length, dropped, mismatches: acc.mismatches.length - before };
    }

    // hand-built special states (from the first root, cloned per case)
    for (const e of specialStates(roots[0].state)) checkState(e, acc);

    const summary = {
      provenance: {
        generatedBy: 'PPC-MCTS-01B/probe/parity.test.ts',
        head: '48eaac6c4f3801d351787696ba5876995b64e8d8',
        rootFixtureSha256: ROOT_FIXTURE_SHA256,
        bfsMaxDepth: MAX_DEPTH,
        bfsMaxStatesPerRoot: MAX_STATES_PER_ROOT,
        note: 'corpus states are produced by prepared transitions from the 24 frozen roots plus hand-built specials; CHANCE outcomes are expanded exhaustively (never sampled)',
      },
      totals: {
        roots: roots.length,
        states: acc.states,
        statesWithActions: acc.statesWithActions,
        candidates: acc.candidates,
        legal: acc.legal,
        illegalCandidates: acc.illegalCandidates,
        deterministicTransitions: acc.deterministic,
        chanceTransitions: acc.chance,
        chanceOutcomes: acc.chanceOutcomes,
        droppedStates: droppedTotal,
        multiPathHits: multiPathHitsTotal,
        chanceByAction: acc.chanceByAction,
      },
      ruleCalls: {
        legacyTwoStep: acc.legacyTwoStepRuleCalls,
        legacyGeneratorOnly: acc.legacyGeneratorOnlyCalls,
        preparedOneStep: acc.preparedRuleCalls,
        deltaVsTwoStep: acc.preparedRuleCalls - acc.legacyTwoStepRuleCalls,
        deltaVsGenerator: acc.preparedRuleCalls - acc.legacyGeneratorOnlyCalls,
        note: 'legacyTwoStep = generateLegalSearchActions(N sims) + one simulateSearchAction per survivor(L sims), i.e. the exact pair uct.ts performs at tree expansion. preparedOneStep = generatePreparedSearchActions(N sims). deltaVsGenerator > 0 because prepared simulates tunnel exits that the legacy GENERATOR never simulated (legacy paid for them in its second step instead).',
      },
      ruleACShortCircuitStates: acc.shortCircuitStates,
      tunnelStates: acc.tunnelStates,
      emptyLegalWhilePlaying: acc.emptyLegalWhilePlaying,
      trapButterOverlapStates: acc.trapButterOverlap,
      aliasing: {
        statesWithSharedReferences: acc.aliasStates,
        byField: acc.aliasFields,
        examples: acc.aliasExamples,
      },
      evaluationStability: { stable: acc.evalStable, unstable: acc.evalUnstable },
      reuseReadStability: { stable: acc.reuseStable, unstable: acc.reuseUnstable },
      mismatches: acc.mismatches,
      perRoot,
    };

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(new URL('parity.json', OUT_DIR), `${JSON.stringify(summary, null, 2)}\n`);

    // hard gates
    expect(acc.mismatches, `mismatches: ${JSON.stringify(acc.mismatches.slice(0, 8))}`).toEqual([]);
    expect(acc.evalUnstable).toEqual([]);
    expect(acc.reuseUnstable).toEqual([]);
    expect(acc.states).toBeGreaterThan(1500);
    expect(acc.deterministic).toBeGreaterThan(1000);
    expect(acc.chance).toBeGreaterThan(0);
  });
});
