/// <reference types="node" />
/**
 * Phase 3 — minimal logical counterexamples for the quantifier contract.
 *
 * These run the SAME `solve` combinator used on the real rules, but over tiny
 * synthetic trees so each quantifier subtlety is isolated. A separate mock
 * verifier (independent DFS, no shared boolean function) checks the extracted
 * certificates for D and E.
 *
 * Nodes: { id, player, terminal?, actions? }. idx increments on player change;
 * H=1 ⇒ a cat node at idx>=2 is outside the window.
 */
import { describe, it, expect } from 'vitest';
import { solve, classifySeal } from './seal_lib';
import type { GameAdapter } from './seal_lib';

interface MState {
  id: string;
  player: 'cat' | 'mouse';
  terminal?: 'mouse' | 'cat';
  actions?: { label: string; outcomes: { to: string; weight: number }[] }[];
}

function mockGame(states: MState[]): GameAdapter<MState> {
  const map = new Map(states.map((s) => [s.id, s]));
  const get = (id: string) => {
    const s = map.get(id);
    if (!s) throw new Error(`unknown mock state ${id}`);
    return s;
  };
  return {
    settle: (s) => s,
    player: (s) => s.player,
    terminal: (s) => s.terminal ?? null,
    key: (s) => s.id,
    transitions: (s) => (s.actions ?? []).map((a) => ({
      label: a.label,
      outcomes: a.outcomes.map((o) => ({ state: get(o.to), weight: o.weight })),
    })),
  };
}

const root = (states: MState[]) => states.find((s) => s.id === 'C0')!;

/** Independent mock certificate verifier (does NOT call solve). */
function mockVerify(
  states: MState[], policy: Map<string, string>, side: 'cat' | 'mouse', H: number,
): { ok: boolean; reason: string | null } {
  const map = new Map(states.map((s) => [s.id, s]));
  const target = side === 'cat' ? 'no-mouse-win' : 'mouse-win';
  const walk = (s: MState, idx: number): boolean => {
    if (s.terminal === 'mouse') return target === 'mouse-win';
    if (s.terminal === 'cat') return target === 'no-mouse-win';
    if (s.player === 'cat' && idx >= 2 * H) return target === 'no-mouse-win';
    const acts = s.actions ?? [];
    if (s.player === side) {
      const want = policy.get(`${idx}|${s.id}`);
      if (want === undefined) return false;
      const a = acts.find((x) => x.label === want);
      if (!a) return false;
      const cp = map.get(a.outcomes[0].to)!.player;
      const ci = cp !== s.player ? idx + 1 : idx;
      return a.outcomes.every((o) => walk(map.get(o.to)!, ci));   // ∀chance
    }
    const cp0 = acts.length ? map.get(acts[0].outcomes[0].to)!.player : s.player;
    void cp0;
    return acts.every((a) => {                                    // ∀opponent
      const cp = map.get(a.outcomes[0].to)!.player;
      const ci = cp !== s.player ? idx + 1 : idx;
      return a.outcomes.every((o) => walk(map.get(o.to)!, ci));   // ∀chance
    });
  };
  const ok = walk(root(states), 0);
  return { ok, reason: ok ? null : 'counterexample' };
}

describe('Phase 3 quantifier counterexamples', () => {
  it('A: one CHANCE outcome wins, one does not ⇒ neither side certified', () => {
    // C0 --a(chance)--> { MW (mouse win), MN --pass--> CN (horizon survive) }
    const states: MState[] = [
      { id: 'C0', player: 'cat', actions: [{ label: 'a', outcomes: [{ to: 'MW', weight: 0.5 }, { to: 'MN', weight: 0.5 }] }] },
      { id: 'MW', player: 'mouse', terminal: 'mouse' },
      { id: 'MN', player: 'mouse', actions: [{ label: 'pass', outcomes: [{ to: 'CN', weight: 1 }] }] },
      { id: 'CN', player: 'cat' },
    ];
    const g = mockGame(states);
    const mf = solve(g, root(states), 1, 0, 1000, 'mouseForce');
    const cs = solve(g, root(states), 1, 0, 1000, 'catSurvive');
    expect(mf.value).toBe(false);          // MouseForcedWin = false
    expect(cs.value).toBe(false);          // CatSurvivalCertified = false
    // The OLD defect: !mouseForcesWin() === true would have certified survival.
    expect(!mf.value).toBe(true);          // documents the invalid negation
    expect(classifySeal(false, false, cs.value, false)).toBe('CHANCE_DEPENDENT_OUTCOME');
  });

  it('B: every CHANCE outcome is a mouse win ⇒ mouse forced, cat not surviving', () => {
    const states: MState[] = [
      { id: 'C0', player: 'cat', actions: [{ label: 'a', outcomes: [{ to: 'MW1', weight: 0.5 }, { to: 'MW2', weight: 0.5 }] }] },
      { id: 'MW1', player: 'mouse', terminal: 'mouse' },
      { id: 'MW2', player: 'mouse', terminal: 'mouse' },
    ];
    const g = mockGame(states);
    const mf = solve(g, root(states), 1, 0, 1000, 'mouseForce');
    const cs = solve(g, root(states), 1, 0, 1000, 'catSurvive');
    expect(mf.value).toBe(true);
    expect(cs.value).toBe(false);
    const v = mockVerify(states, mf.policy, 'mouse', 1);
    expect(v.ok).toBe(true);
  });

  it('C: every CHANCE outcome avoids mouse win (no other branch) ⇒ cat survival certified', () => {
    const states: MState[] = [
      { id: 'C0', player: 'cat', actions: [{ label: 'a', outcomes: [{ to: 'CW1', weight: 0.5 }, { to: 'CW2', weight: 0.5 }] }] },
      { id: 'CW1', player: 'cat', terminal: 'cat' },
      { id: 'CW2', player: 'cat', terminal: 'cat' },
    ];
    const g = mockGame(states);
    const mf = solve(g, root(states), 1, 0, 1000, 'mouseForce');
    const cs = solve(g, root(states), 1, 0, 1000, 'catSurvive');
    expect(mf.value).toBe(false);
    expect(cs.value).toBe(true);
    const v = mockVerify(states, cs.policy, 'cat', 1);
    expect(v.ok).toBe(true);
  });

  it('D: cat has ONE action denying all mouse replies and all chance ⇒ survival, ∃ only over cat actions', () => {
    // C0: 'bad' loses; 'good' → M2 where every mouse reply survives, including a
    //     2-outcome CHANCE reply (cat may NOT choose the chance outcome).
    const states: MState[] = [
      { id: 'C0', player: 'cat', actions: [
        { label: 'bad', outcomes: [{ to: 'M1', weight: 1 }] },
        { label: 'good', outcomes: [{ to: 'M2', weight: 1 }] },
      ] },
      { id: 'M1', player: 'mouse', actions: [{ label: 'win', outcomes: [{ to: 'MW', weight: 1 }] }] },
      { id: 'MW', player: 'mouse', terminal: 'mouse' },
      { id: 'M2', player: 'mouse', actions: [
        { label: 'x', outcomes: [{ to: 'CX1', weight: 0.5 }, { to: 'CX2', weight: 0.5 }] },  // CHANCE
        { label: 'y', outcomes: [{ to: 'CY', weight: 1 }] },
      ] },
      { id: 'CX1', player: 'cat' }, { id: 'CX2', player: 'cat' }, { id: 'CY', player: 'cat' },
    ];
    const g = mockGame(states);
    const cs = solve(g, root(states), 1, 0, 1000, 'catSurvive');
    const mf = solve(g, root(states), 1, 0, 1000, 'mouseForce');
    expect(cs.value).toBe(true);
    expect(mf.value).toBe(false);
    expect(cs.policy.get('0|C0')).toBe('good');     // ∃ chooses a cat ACTION, not a chance outcome
    const v = mockVerify(states, cs.policy, 'cat', 1);
    expect(v.ok).toBe(true);
  });

  it('E: every cat defense is broken by an ADAPTIVE mouse strategy (not a fixed string)', () => {
    // After 'a' the mouse must play 'p'; after 'b' it must play 'q'. No single
    // fixed mouse action wins both branches.
    const states: MState[] = [
      { id: 'C0', player: 'cat', actions: [
        { label: 'a', outcomes: [{ to: 'MA', weight: 1 }] },
        { label: 'b', outcomes: [{ to: 'MB', weight: 1 }] },
      ] },
      { id: 'MA', player: 'mouse', actions: [
        { label: 'p', outcomes: [{ to: 'MW', weight: 1 }] },
        { label: 'q', outcomes: [{ to: 'CA', weight: 1 }] },
      ] },
      { id: 'MB', player: 'mouse', actions: [
        { label: 'p', outcomes: [{ to: 'CB', weight: 1 }] },
        { label: 'q', outcomes: [{ to: 'MW', weight: 1 }] },
      ] },
      { id: 'MW', player: 'mouse', terminal: 'mouse' },
      { id: 'CA', player: 'cat' }, { id: 'CB', player: 'cat' },
    ];
    const g = mockGame(states);
    const mf = solve(g, root(states), 1, 0, 1000, 'mouseForce');
    const cs = solve(g, root(states), 1, 0, 1000, 'catSurvive');
    expect(mf.value).toBe(true);
    expect(cs.value).toBe(false);
    expect(mf.policy.get('1|MA')).toBe('p');
    expect(mf.policy.get('1|MB')).toBe('q');
    expect(mf.policy.get('1|MA')).not.toBe(mf.policy.get('1|MB'));   // adaptive
    const v = mockVerify(states, mf.policy, 'mouse', 1);
    expect(v.ok).toBe(true);
  });

  it('F: node cap ⇒ UNRESOLVED, distinct from a genuine within-horizon non-win', () => {
    // C0 (cat, OR) has 6 actions. The first FIVE lose (mouse win ⇒ false), so the
    // OR must keep searching; only the SIXTH survives. Under a small cap the
    // search truncates before reaching it (UNRESOLVED); under a large cap it
    // completes with a definite TRUE. Terminal leaves are not counted as nodes,
    // so the live decision nodes C0,M0,M1,M2,M3 exceed cap=4 on the fifth branch.
    const wide: MState[] = [{ id: 'C0', player: 'cat', actions: [] }];
    for (let i = 0; i < 5; i++) {
      const mid = `M${i}`;
      wide[0].actions!.push({ label: `a${i}`, outcomes: [{ to: mid, weight: 1 }] });
      wide.push({ id: mid, player: 'mouse', actions: [{ label: 'win', outcomes: [{ to: `MW${i}`, weight: 1 }] }] });
      wide.push({ id: `MW${i}`, player: 'mouse', terminal: 'mouse' });
    }
    wide[0].actions!.push({ label: 'a5', outcomes: [{ to: 'M5', weight: 1 }] });
    wide.push({ id: 'M5', player: 'mouse', actions: [{ label: 'pass', outcomes: [{ to: 'C5', weight: 1 }] }] });
    wide.push({ id: 'C5', player: 'cat' });   // horizon survive

    const g = mockGame(wide);
    const capped = solve(g, root(wide), 1, 0, 4, 'catSurvive');
    expect(capped.value).toBeNull();
    expect(capped.stats.truncated).toBe(true);
    expect(classifySeal(null, null, null, null)).toBe('UNRESOLVED');

    // The SAME tree with a sufficient cap completes and gives a definite answer.
    const full = solve(g, root(wide), 1, 0, 100000, 'catSurvive');
    expect(full.value).toBe(true);          // the sixth branch survives the horizon
    expect(full.stats.truncated).toBe(false);
    expect(full.value).not.toBeNull();      // genuine non-win ≠ resource exhaustion
  });

  it('terminal MouseWins on the last mouse step is judged BEFORE the horizon cut', () => {
    // C0 --a--> M1(mouse,idx1) --last--> CS(cat,idx2, terminal mouse via stranding).
    // CS sits at idx2 (>=2H) but is a MouseWins terminal: it must count as a win.
    const states: MState[] = [
      { id: 'C0', player: 'cat', actions: [{ label: 'a', outcomes: [{ to: 'M1', weight: 1 }] }] },
      { id: 'M1', player: 'mouse', actions: [{ label: 'last', outcomes: [{ to: 'CS', weight: 1 }] }] },
      { id: 'CS', player: 'cat', terminal: 'mouse' },
    ];
    const g = mockGame(states);
    const mf = solve(g, root(states), 1, 0, 1000, 'mouseForce');
    expect(mf.value).toBe(true);            // horizon-first would wrongly give false
    const cs = solve(g, root(states), 1, 0, 1000, 'catSurvive');
    expect(cs.value).toBe(false);
  });
});