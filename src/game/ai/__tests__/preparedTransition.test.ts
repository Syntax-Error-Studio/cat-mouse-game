/**
 * PPC-P2-PREPARED-TRANSITION-01 — prepared-transition reuse: contract tests.
 *
 * The optimisation under test: the search hot path used to simulate every
 * candidate once for legality (`generateLegalSearchActions` → `isEffective`)
 * and then simulate every SURVIVING action a second time to obtain the very
 * transition it recursed on. `generatePreparedSearchActions` performs the
 * legality pass once and hands the transition forward.
 *
 * What this file pins down:
 *
 *   PT-2  every legal action is simulated exactly once per node (root: 1, was 3)
 *   PT-3  the reused transition equals a fresh independent simulation, for
 *         deterministic AND chance transitions, on the frozen human roots and
 *         on hand-built special states
 *   PT-4  CHANCE keeps its cardinality, order and weights; a butter pickup is
 *         never collapsed into a deterministic successor
 *   PT-6  the legal action ORDER, the preconditions and `originalIndex` are
 *         unchanged, and tunnel exits are still emitted without a legality
 *         simulation
 *   PT-8  special terrain (Void/Wall/trap/butter) and catBaseMoves 4/6/9 are
 *         handled identically by both generators
 *   +     the search never mutates its input state
 *
 * The heavy 24-root fixed-D1 full-field parity against the frozen pre-fix
 * artifact lives in `stateIdentityCollision.test.ts` (ID-5) and is re-run by
 * this round; this file does not duplicate that oracle.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createEngineRuleSet,
  type GameEngineState,
} from '../../engine';
import { restoreHardRoot } from '../hardHistory';
import { stateKey } from '../transposition';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import {
  generateLegalSearchActions,
} from '../legalActions';
import {
  enumerateSearchActionCandidates,
  generatePreparedSearchActions,
} from '../preparedActions';
import {
  createSearchContext,
  searchBestAction,
} from '../expectiminimax';
import { simulateSearchAction } from '../simulator';
import { gameAffectingEqual } from '../stateCompare';
import type { RuleSet, SearchAction } from '../searchTypes';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../types';

const ROOT_FIXTURE = new URL('./fixtures/ppcId01-human-roots.json', import.meta.url);
const ROOT_FIXTURE_SHA256 = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';

interface RootRecord { id: string; state: unknown }

function loadRoots(): { id: string; state: GameEngineState }[] {
  const raw = readFileSync(ROOT_FIXTURE);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(ROOT_FIXTURE_SHA256);
  return (JSON.parse(raw.toString('utf8')) as RootRecord[]).map((r) => ({
    id: r.id,
    state: restoreHardRoot(r.state as never),
  }));
}

const ruleSet = createEngineRuleSet();

/** Counting proxy — delegates 1:1, records every REAL transition execution. */
function countingRules(base: RuleSet): {
  rules: RuleSet;
  calls: Map<string, number>;
  total: () => number;
  chanceCalls: number;
} {
  const calls = new Map<string, number>();
  const state = { chanceCalls: 0 };
  const bump = (fn: string, action: string, input: GameEngineState): void => {
    // '\u0000' cannot appear in a stateKey (which uses '|' internally).
    const key = `${fn}\u0000${action}\u0000${stateKey(input)}`;
    calls.set(key, (calls.get(key) ?? 0) + 1);
  };
  const dir = (d: Direction): string => ({ ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' } as Record<string, string>)[d.key] ?? d.key;

  const rules: RuleSet = {
    mouseStep: (s, d) => { bump('mouseStep', dir(d), s); return base.mouseStep(s, d); },
    catMove: (s, d) => { bump('catMove', dir(d), s); return base.catMove(s, d); },
    mouseSkill: (s) => { bump('mouseSkill', 'skill', s); return base.mouseSkill(s); },
    catPlaceTrap: (s) => { bump('catPlaceTrap', 'trap', s); return base.catPlaceTrap(s); },
    chooseTunnelExit: (s, r, c) => { bump('chooseTunnelExit', `t${r},${c}`, s); return base.chooseTunnelExit(s, r, c); },
    enumerateButterSpawns: (s) => base.enumerateButterSpawns(s),
    endTurn: (s) => base.endTurn(s),
  };
  if (base.buildButterChance) {
    const inner = base.buildButterChance;
    rules.buildButterChance = (s) => { state.chanceCalls++; bump('buildButterChance', '-', s); return inner(s); };
  }
  if (base.resolveGhostBoundaryChance) {
    const inner = base.resolveGhostBoundaryChance;
    rules.resolveGhostBoundaryChance = (s) => { state.chanceCalls++; bump('resolveGhostBoundaryChance', '-', s); return inner(s); };
  }
  let total = 0;
  return {
    rules,
    calls,
    total: () => { total = 0; for (const v of calls.values()) total += v; return total; },
    get chanceCalls() { return state.chanceCalls; },
  };
}

const ACTION_FNS = new Set(['mouseStep', 'catMove', 'mouseSkill', 'catPlaceTrap', 'chooseTunnelExit']);

function label(a: SearchAction | null): string {
  if (!a) return '-';
  if (a.type === 'catPlaceTrap') return 'T';
  if (a.type === 'mouseSkill') return 'S';
  if (a.type === 'chooseTunnel') return `t${a.r},${a.c}`;
  return ({ ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' } as Record<string, string>)[a.direction.key] ?? '?';
}

/** Clone a state without dragging the (unused) log arrays into comparisons. */
function clone(s: GameEngineState): GameEngineState {
  return JSON.parse(JSON.stringify(s)) as GameEngineState;
}

/** A state where the mouse is one step from a butter (CHANCE transition root). */
function withButterNextToMouse(base: GameEngineState): GameEngineState | null {
  const st = clone(base);
  st.phase = GamePhase.Playing;
  st.currentPlayer = PieceType.Mouse;
  st.mouseMovesLeft = Math.max(1, st.mouseMovesLeft);
  st.mouseHasButter = false;
  st.mouseSkillActive = false;
  st.pendingButterSpawns = [];
  st.pendingButterPlacementDebt = 0;
  st.trapPosition = null;
  const m = st.mousePosition;
  for (const d of DIRECTIONS) {
    const r = m.r + d.dr;
    const c = m.c + d.dc;
    const cell = st.board[r]?.[c];
    if (!cell || cell.type !== CellType.Empty) continue;
    if (r === st.catPosition.r && c === st.catPosition.c) continue;
    st.butterPositions = [{ r, c }];
    return st;
  }
  return null;
}

describe('PT-2 · one simulation per legal action per node', () => {
  it('simulates each root action exactly once (was three: empty-check + legality + prepared)', () => {
    const { id, state } = loadRoots().find((r) => r.id === 'G6T1')!;
    const rootKey = stateKey(state);
    const counting = countingRules(ruleSet);
    const ctx = createSearchContext(counting.rules, 10000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = false;

    const res = searchBestAction(state, 1, ctx);

    const rootCounts: Record<string, number> = {};
    for (const [key, n] of counting.calls) {
      const [fn, action, inKey] = key.split('\u0000');
      if (inKey === rootKey && ACTION_FNS.has(fn)) rootCounts[`${fn}:${action}`] = n;
    }
    expect(res.diagnostics.nodes, `${id} searched nodes`).toBeGreaterThan(0);
    expect(Object.keys(rootCounts).length).toBeGreaterThan(1);
    for (const [actionKey, n] of Object.entries(rootCounts)) {
      expect(n, `root action ${actionKey} simulations`).toBe(1);
    }
  });

  it('never simulates the same (state, action) twice inside one node', () => {
    // A node that is NOT re-entered: depth 1 from a mouse actor. Its own
    // expansion may only apply each candidate once.
    const base = loadRoots().find((r) => r.id === 'G6T2')!.state;
    const st = withButterNextToMouse(base);
    expect(st).not.toBeNull();
    const rootKey = stateKey(st!);
    const counting = countingRules(ruleSet);
    const ctx = createSearchContext(counting.rules, 10000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = false;
    searchBestAction(st!, 1, ctx);

    const candidateCount = enumerateSearchActionCandidates(st!).length;
    let rootCalls = 0;
    for (const [key, n] of counting.calls) {
      const [fn, , inKey] = key.split('\u0000');
      if (inKey === rootKey && ACTION_FNS.has(fn)) rootCalls += n;
    }
    // Exactly the candidate list, each applied once (legal or not).
    expect(rootCalls).toBe(candidateCount);
  });

  it('a legal root action that picks up butter is still simulated once', () => {
    const base = loadRoots().find((r) => r.id === 'G6T2')!.state;
    const st = withButterNextToMouse(base)!;
    const rootKey = stateKey(st);
    const counting = countingRules(ruleSet);
    const ctx = createSearchContext(counting.rules, 10000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = false;
    searchBestAction(st, 1, ctx);
    let mouseStepCalls = 0;
    for (const [key, n] of counting.calls) {
      const [fn, , inKey] = key.split('\u0000');
      if (inKey === rootKey && fn === 'mouseStep') mouseStepCalls += n;
    }
    expect(mouseStepCalls).toBe(4); // four candidates, one application each
    expect(counting.chanceCalls).toBeGreaterThan(0); // CHANCE really happened
  });
});

describe('PT-3 · the reused transition equals a fresh simulation', () => {
  const frozen = loadRoots();
  const synth = withButterNextToMouse(frozen.find((r) => r.id === 'G6T2')!.state)!;
  const roots = [...frozen, { id: 'SYNTH-CHANCE', state: synth }];

  it('agrees on every action of every frozen human root plus a constructed CHANCE root', () => {
    let deterministic = 0;
    let chance = 0;
    for (const { id, state } of roots) {
      const prepared = generatePreparedSearchActions(state, ruleSet);
      expect(prepared.length, `${id} non-empty legal set`).toBeGreaterThan(0);
      for (const p of prepared) {
        const fresh = simulateSearchAction(state, p.action, ruleSet);
        expect(fresh.kind, `${id} ${label(p.action)} kind`).toBe(p.transition.kind);
        if (p.transition.kind === 'deterministic' && fresh.kind === 'deterministic') {
          deterministic++;
          expect(stateKey(fresh.state), `${id} ${label(p.action)} successor`).toBe(stateKey(p.transition.state));
          expect(gameAffectingEqual(fresh.state, p.transition.state), `${id} ${label(p.action)} game-affecting`).toBe(true);
          // Full structural equality (logs included): the transition must be
          // the SAME state a second independent application would produce.
          expect(fresh.state, `${id} ${label(p.action)} full state`).toEqual(p.transition.state);
        } else if (p.transition.kind === 'chance' && fresh.kind === 'chance') {
          chance++;
          expect(fresh.outcomes.length).toBe(p.transition.outcomes.length);
          expect(fresh.outcomes.map((o) => stateKey(o.state))).toEqual(p.transition.outcomes.map((o) => stateKey(o.state)));
          expect(fresh.outcomes.map((o) => o.weight)).toEqual(p.transition.outcomes.map((o) => o.weight));
        }
      }
      // The input state itself must not be touched by generating/using the batch.
      expect(stateKey(state), `${id} input key stable`).toBe(stateKey(clone(state)));
    }
    expect(deterministic).toBeGreaterThan(0);
    expect(chance).toBeGreaterThan(0);
  });

  it('a chance transition is never reported as deterministic', () => {
    const base = roots.find((r) => r.id === 'G6T2')!.state;
    const st = withButterNextToMouse(base)!;
    const prepared = generatePreparedSearchActions(st, ruleSet);
    const picking = prepared.filter((p) => p.transition.kind === 'chance');
    expect(picking.length).toBeGreaterThan(0);
    for (const p of picking) {
      const tr = p.transition;
      if (tr.kind !== 'chance') continue;
      // Every outcome adds exactly one PENDING GHOST (an obligation), never an
      // entity butter, and the weights are a uniform distribution.
      for (const o of tr.outcomes) {
        const ghosts = o.state.pendingButterSpawns ?? [];
        expect(ghosts.length).toBe((st.pendingButterSpawns ?? []).length + 1);
        expect(o.state.butterPositions.length).toBe(st.butterPositions.length - 1);
      }
      const sum = tr.outcomes.reduce((acc, o) => acc + o.weight, 0);
      expect(sum).toBeCloseTo(1, 12);
      expect(new Set(tr.outcomes.map((o) => o.weight)).size).toBe(1);
    }
  });
});

describe('PT-4 · ghost-boundary CHANCE keeps its outcomes, order and weights', () => {
  it('a CAT→MOUSE hand-off with a pending ghost stays a CHANCE node when reused', () => {
    const base = clone(loadRoots().find((r) => r.id === 'G5T2')!.state);
    base.phase = GamePhase.Playing;
    base.currentPlayer = PieceType.Cat;
    base.catMovesLeft = 1; // the next cat step ends the turn
    base.pendingButterSpawns = [{ r: 0, c: 1, blockedMaterializations: 0 }];
    base.pendingButterPlacementDebt = 0;

    const prepared = generatePreparedSearchActions(base, ruleSet);
    const chanceActions = prepared.filter((p) => p.transition.kind === 'chance');
    expect(chanceActions.length).toBeGreaterThan(0);

    for (const p of chanceActions) {
      expect(p.transition.kind).toBe('chance');
      if (p.transition.kind !== 'chance') continue;
      const fresh = simulateSearchAction(base, p.action, ruleSet);
      expect(fresh.kind).toBe('chance');
      if (fresh.kind !== 'chance') continue;
      // Cardinality, ORDER and weights must all survive the reuse.
      expect(fresh.outcomes.map((o) => stateKey(o.state))).toEqual(p.transition.outcomes.map((o) => stateKey(o.state)));
      expect(fresh.outcomes.map((o) => o.weight)).toEqual(p.transition.outcomes.map((o) => o.weight));
      const sum = p.transition.outcomes.reduce((acc, o) => acc + o.weight, 0);
      expect(sum).toBeCloseTo(1, 12);
      // Every outcome is a CAT→MOUSE hand-off (the ghost boundary, not a turn
      // that has already been played out).
      for (const o of p.transition.outcomes) {
        expect(o.weight).toBeGreaterThan(0);
        expect(o.state.currentPlayer).toBe(PieceType.Mouse);
      }
    }
  });

  it('takes its ghost cells from the RuleSet enumeration, one outcome per cell, in order', () => {
    const base = clone(loadRoots().find((r) => r.id === 'G6T2')!.state);
    const st = withButterNextToMouse(base)!;
    const prepared = generatePreparedSearchActions(st, ruleSet);
    const picking = prepared.filter((p) => p.transition.kind === 'chance');
    expect(picking.length).toBe(1);

    for (const p of picking) {
      if (p.transition.kind !== 'chance' || p.action.type !== 'mouseStep') continue;
      // The simulator builds the CHANCE node from the deterministic post-pickup
      // state, so the same intermediate state must produce the same cell list.
      const next = ruleSet.mouseStep(st, p.action.direction);
      const enumerated = ruleSet.enumerateButterSpawns(next);
      expect(p.transition.outcomes.length).toBe(enumerated.length);
      const prev = new Set((st.pendingButterSpawns ?? []).map((g) => `${g.r},${g.c}`));
      const added = p.transition.outcomes.map((o) => {
        const ghosts = o.state.pendingButterSpawns ?? [];
        const fresh = ghosts.filter((g) => !prev.has(`${g.r},${g.c}`));
        expect(fresh.length).toBe(1);
        return `${fresh[0].r},${fresh[0].c}`;
      });
      // Exactly one outcome per enumerated cell, in the SAME order.
      expect(added).toEqual(enumerated.map((c) => `${c.r},${c.c}`));
      expect(new Set(added).size).toBe(added.length);
    }
  });
});

describe('PT-6 · order, preconditions and originalIndex are unchanged', () => {
  const roots = loadRoots();

  it('returns the identical action list and order as generateLegalSearchActions', () => {
    for (const { id, state } of roots) {
      const legal = generateLegalSearchActions(state, ruleSet);
      const prepared = generatePreparedSearchActions(state, ruleSet);
      expect(prepared.map((p) => p.action), `${id} order`).toEqual(legal);
      expect(prepared.map((p) => p.originalIndex), `${id} originalIndex`).toEqual(legal.map((_, i) => i));
    }
  });

  it('emits tunnel exits without a legality simulation and keeps their order', () => {
    const base = roots[0].state;
    const st = clone(base);
    st.phase = GamePhase.ChoosingTunnelExit;
    st.tunnelExitChoices = [{ r: 0, c: 0, label: 'A' }, { r: 8, c: 8, label: 'B' }];

    const counting = countingRules(ruleSet);
    const legal = generateLegalSearchActions(st, counting.rules);
    expect(legal).toEqual([
      { type: 'chooseTunnel', r: 0, c: 0 },
      { type: 'chooseTunnel', r: 8, c: 8 },
    ]);
    expect(counting.calls.has(`chooseTunnelExit\u0000t0,0\u0000${stateKey(st)}`)).toBe(false);

    const prepared = generatePreparedSearchActions(st, ruleSet);
    expect(prepared.map((p) => p.action)).toEqual(legal);
    for (const p of prepared) {
      expect(p.transition.kind).toBe('deterministic');
      const fresh = simulateSearchAction(st, p.action, ruleSet);
      if (fresh.kind === 'deterministic' && p.transition.kind === 'deterministic') {
        expect(stateKey(fresh.state)).toBe(stateKey(p.transition.state));
      }
    }
  });

  it('returns an empty batch for terminal phases without simulating anything', () => {
    for (const phase of [GamePhase.CatWins, GamePhase.MouseWins]) {
      const st = clone(roots[0].state);
      st.phase = phase;
      const counting = countingRules(ruleSet);
      expect(generatePreparedSearchActions(st, counting.rules)).toEqual([]);
      expect(generateLegalSearchActions(st, counting.rules)).toEqual([]);
      expect(counting.total()).toBe(0);
    }
  });

  it('keeps the cat trap precondition (no trap slot / no traps left => no action)', () => {
    const base = roots.find((r) => r.id === 'G6T1')!.state;
    const withTrap = clone(base);
    withTrap.currentPlayer = PieceType.Cat;
    withTrap.trapPosition = { r: 0, c: 0 };
    expect(generatePreparedSearchActions(withTrap, ruleSet).some((p) => p.action.type === 'catPlaceTrap')).toBe(false);

    const noTraps = clone(base);
    noTraps.currentPlayer = PieceType.Cat;
    noTraps.trapPosition = null;
    noTraps.catTrapsRemaining = 0;
    expect(generatePreparedSearchActions(noTraps, ruleSet).some((p) => p.action.type === 'catPlaceTrap')).toBe(false);

    const free = clone(base);
    free.currentPlayer = PieceType.Cat;
    free.trapPosition = null;
    free.catTrapsRemaining = 1;
    expect(generatePreparedSearchActions(free, ruleSet).some((p) => p.action.type === 'catPlaceTrap')).toBe(true);
  });

  it('keeps the mouse skill precondition', () => {
    const base = roots[0].state;
    const st = clone(base);
    st.phase = GamePhase.Playing;
    st.currentPlayer = PieceType.Mouse;
    st.mouseMovesLeft = 3;
    st.mouseHasButter = true;
    st.mouseSkillActive = false;
    expect(generatePreparedSearchActions(st, ruleSet).some((p) => p.action.type === 'mouseSkill')).toBe(true);
    st.mouseSkillActive = true;
    expect(generatePreparedSearchActions(st, ruleSet).some((p) => p.action.type === 'mouseSkill')).toBe(false);
  });
});

describe('PT-8 · special terrain and variable cat move budgets', () => {
  it('agrees with the legacy generator on a hand-built irregular map', () => {
    const base = clone(loadRoots()[0].state);
    // Carve a void pocket, a wall and a butter spot, and drop a trap.
    base.board[2][2] = { ...base.board[2][2], type: CellType.Void, piece: undefined };
    base.board[3][3] = { ...base.board[3][3], type: CellType.Wall, piece: undefined };
    base.board[4][4] = { ...base.board[4][4], type: CellType.ButterSpot, piece: undefined };
    base.butterPositions = [{ r: 4, c: 4 }];
    base.trapPosition = { r: 6, c: 2 };
    base.blockedTunnels = [{ r: 0, c: 0 }];
    const legal = generateLegalSearchActions(base, ruleSet);
    const prepared = generatePreparedSearchActions(base, ruleSet);
    expect(prepared.map((p) => p.action)).toEqual(legal);
  });

  for (const catBaseMoves of [4, 6, 9]) {
    it(`agrees for catBaseMoves=${catBaseMoves} (long plan budget)`, () => {
      const st = clone(loadRoots().find((r) => r.id === 'G5T1')!.state);
      st.config = { ...st.config, catBaseMoves };
      st.currentPlayer = PieceType.Cat;
      st.catMovesLeft = catBaseMoves;
      const legal = generateLegalSearchActions(st, ruleSet);
      const prepared = generatePreparedSearchActions(st, ruleSet);
      expect(prepared.map((p) => p.action)).toEqual(legal);
      for (const p of prepared) {
        const fresh = simulateSearchAction(st, p.action, ruleSet);
        if (fresh.kind === 'deterministic' && p.transition.kind === 'deterministic') {
          expect(stateKey(fresh.state)).toBe(stateKey(p.transition.state));
        }
      }
    });
  }
});

describe('PT-5/PT-10 · search still does not mutate its input, and results are order-independent', () => {
  it('leaves the root state byte-identical', () => {
    const { id, state } = loadRoots().find((r) => r.id === 'G2T5')!;
    const before = clone(state);
    const ctx = createSearchContext(ruleSet, 10000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = true;
    const a = searchBestAction(state, 1, ctx);
    expect(stateKey(state), `${id} key`).toBe(stateKey(before));
    expect(state, `${id} full state`).toEqual(before);

    // Same state, ordering disabled: the VALUE must not depend on the order the
    // actions are searched in (ties are the only thing ordering may affect, and
    // the stable original-index rule keeps even that fixed).
    const ctx2 = createSearchContext(ruleSet, 10000, true, true, false, 0, false);
    ctx2.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx2.capturePlan = true;
    const b = searchBestAction(state, 1, ctx2);
    expect(b.value).toBe(a.value);
    expect(b.mate).toBe(a.mate);
  });

  it('takes the same decision on the same fixed workload with and without the TT', () => {
    const { state } = loadRoots().find((r) => r.id === 'G1T3')!;
    const mk = (tt: boolean) => {
      const ctx = createSearchContext(ruleSet, 10000, tt, true, true, 0, false);
      ctx.leafEvaluator = evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;
      return searchBestAction(state, 1, ctx);
    };
    const withTT = mk(true);
    const withoutTT = mk(false);
    expect(withTT.value).toBe(withoutTT.value);
    expect(label(withTT.action)).toBe(label(withoutTT.action));
  });
});
