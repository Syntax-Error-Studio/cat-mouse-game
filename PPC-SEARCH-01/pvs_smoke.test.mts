import { describe, expect, it } from 'vitest';
import { corpus, controls, runFixed, LEAF_MODE, RULES, labelAction } from './pvs_lib.mts';
import { stateKey } from '../src/game/ai/transposition';
import { generateLegalSearchActions } from '../src/game/ai/legalActions';
import { simulateSearchAction } from '../src/game/ai/simulator';
import { GamePhase } from '../src/game/types';

describe('PPC-SEARCH-01 smoke', () => {
  it('corpus is the 25 frozen 1.9D roots and the leaf mode is production default', () => {
    const c = corpus();
    expect(c.length).toBe(25);
    expect(LEAF_MODE).toBe('baseline');
    // every root must be a live Playing state with the cat to move where expected
    for (const e of c) {
      expect(typeof stateKey(e.root)).toBe('string');
      expect(e.root.config.boardSize).toBe(10);
      expect(e.root.config.catBaseMoves).toBe(4);
    }
    console.log('roots:', c.map((e) => e.id).join(' '));
  });

  it('controls build; the walled-in cat is a RULE-A immediate loss, not an empty action set', () => {
    const cs = controls();
    for (const c of cs) console.log(c.id.padEnd(16), 'legal=', String(c.legalActions).padStart(2), '|', c.note);
    // RULE-A settles the loss INSIDE the transition (settleNoMoveLoss), so a
    // walled-in actor still exposes one action per direction — each of which is
    // already terminal. The `actions.length === 0` static-eval branch is not
    // reachable this way; this control proves WHICH branch actually fires.
    const noLegal = cs.find((c) => c.id === 'C_NO_LEGAL')!;
    const acts = generateLegalSearchActions(noLegal.state, RULES);
    const terminals = acts.map((a) => {
      const r = simulateSearchAction(noLegal.state, a, RULES);
      return r.kind === 'deterministic' ? r.state.phase : 'chance';
    });
    console.log('C_NO_LEGAL actions ->', acts.map((a) => labelAction(a)).join(','), '=>', terminals.join(','));
    expect(acts.length).toBeGreaterThan(0);
    expect(terminals.every((t) => t !== GamePhase.Playing)).toBe(true);
    for (const c of cs.filter((c) => c.id !== 'C_NO_LEGAL')) expect(c.legalActions).toBeGreaterThan(0);
  });

  it('one root at D1: fork-off reproduces production, fork-on runs', () => {
    const root = corpus()[0].root;
    const a = runFixed('A', root, 1);
    const aFork = runFixed('A_FORK', root, 1);
    const b = runFixed('B', root, 1);
    for (const r of [a, aFork, b]) {
      console.log(r.arm.padEnd(7), 'v=', r.value, 'nodes=', r.nodes, 'plan=', r.plan, 'wall=', r.wallMs, 'pvs=', JSON.stringify(r.pvs));
    }
    expect(aFork.value).toBe(a.value);
    expect(aFork.nodes).toBe(a.nodes);
    expect(aFork.plan).toBe(a.plan);
    expect(b.value).toBe(a.value);
  });
});
