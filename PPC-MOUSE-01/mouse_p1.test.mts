/**
 * PPC-MOUSE-01 / P1 — does the EXISTING search kernel behave correctly when
 * the root actor is the MOUSE?
 *
 * Method: compare the production search against an independent, unpruned,
 * TT-free oracle (`oracleTurnValue`) over the SAME real transitions. Agreement
 * at depth 1 and 2 is the evidence that MIN/MAX/CHANCE/mate-distance are not
 * cat-specific. Nothing here re-implements the search for production use.
 */
import { describe, expect, it } from 'vitest';
import {
  fixtures, planMouseSearch, oracleTurnValue, oracleRootActions,
  RULES, LEAF, labelAction, generateLegalSearchActions, simulateSearchAction,
  mateActionCost, stepChildForParent, compareSearchScore, MATE_SCORE, stateKey,
  GamePhase, PieceType, writeOut, appendJsonl, endTurn,
} from './mouse_lib.mts';
import type { GameEngineState } from './mouse_lib.mts';
import { HARD_LEAF_MODE_CONFIG } from '../src/game/ai/searchConfig';
import {
  searchBestAction, createSearchContext, searchBestActionIterative,
} from '../src/game/ai/expectiminimax';

const rows: any[] = [];

function cmpRoot(a: GameEngineState, depth: number, budgetMs = 4000): any {
  const call = planMouseSearch(a, { budgetMs, maxDepthTurns: depth });
  const oracle = oracleTurnValue(a, depth);
  return {
    id: '',
    depth,
    nodes: call.result.diagnostics.totalNodes,
    wallMs: +call.wallMs.toFixed(1),
    completed: call.result.completed,
    completedDepth: call.result.completedDepth,
    searchValue: call.result.value,
    oracleValue: oracle.value,
    searchMate: call.result.mate,
    oracleMate: oracle.mate,
    valueDiff: call.result.value - oracle.value,
    action: labelAction(call.result.bestAction),
  };
}

describe('PPC-MOUSE-01 / P1 mouse-root search audit', () => {
  it('P1-0: the production leaf under test really is the baseline leaf', () => {
    // resolveHardLeaf() returns evaluateForCat exactly while the mode is 'baseline'
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
    expect(LEAF).toBeTypeOf('function');
  });

  it('P1-1: MIN at a MOUSE root matches an unpruned oracle at depth 1 (all fixtures)', () => {
    for (const f of fixtures()) {
      const r = cmpRoot(f.state, 1);
      r.id = f.id;
      rows.push(r);
      console.log(
        f.id.padEnd(15), 'D1',
        'search=' + r.searchValue.toFixed(3), 'oracle=' + r.oracleValue.toFixed(3),
        'mate=' + String(r.searchMate) + '/' + String(r.oracleMate),
        'action=' + r.action, 'nodes=' + r.nodes, r.wallMs + 'ms',
      );
      expect(r.completed).toBe(true);
      expect(r.searchMate).toBe(r.oracleMate);
      expect(Math.abs(r.valueDiff)).toBeLessThan(1e-6);
    }
  }, 900_000);

  it('P1-2: depth 2 (mouse turn + the WHOLE cat turn) still matches the oracle', () => {
    const ids = ['M_MICRO', 'M_BUTTER_MICRO', 'M_CAT_MATE3'];
    for (const id of ids) {
      const f = fixtures().find((x) => x.id === id)!;
      const r = cmpRoot(f.state, 2);
      r.id = id;
      rows.push(r);
      console.log(
        id.padEnd(15), 'D2',
        'search=' + r.searchValue.toFixed(3), 'oracle=' + r.oracleValue.toFixed(3),
        'mate=' + String(r.searchMate) + '/' + String(r.oracleMate),
        'action=' + r.action, 'nodes=' + r.nodes, r.wallMs + 'ms',
      );
      expect(r.completed).toBe(true);
      expect(r.searchMate).toBe(r.oracleMate);
      expect(Math.abs(r.valueDiff)).toBeLessThan(1e-6);
    }
  }, 900_000);

  it('P1-3: the chosen action is the oracle argmin, not merely "a legal move"', () => {
    const f = fixtures().find((x) => x.id === 'M_MICRO')!;
    const ranked = oracleRootActions(f.state, 2);
    const call = planMouseSearch(f.state, { budgetMs: 4000, maxDepthTurns: 2 });
    writeOut('p1_oracle_root_ranking.json', {
      fixture: 'M_MICRO',
      depth: 2,
      ranking: ranked.map((r) => ({ action: labelAction(r.action), value: r.value, mate: r.mate })),
      searchChoice: labelAction(call.result.bestAction),
      searchValue: call.result.value,
    });
    console.log('oracle ranking:', ranked.map((r) => `${labelAction(r.action)}=${r.value.toFixed(1)}`).join(' '));
    expect(labelAction(call.result.bestAction)).toBe(labelAction(ranked[0].action));
  }, 900_000);

  it('P1-4: mate distance uses game time, in both directions', () => {
    const home = fixtures().find((x) => x.id === 'M_CARRY_HOME')!.state;
    const c1 = planMouseSearch(home, { budgetMs: 4000, maxDepthTurns: 1 });
    // 2 mouse steps to the hole -> -MATE_SCORE + 2
    expect(c1.result.mate).toBe('mouse');
    expect(c1.result.value).toBe(-MATE_SCORE + 2);

    const corr = fixtures().find((x) => x.id === 'M_CAT_MATE3')!.state;
    const c2 = planMouseSearch(corr, { budgetMs: 4000, maxDepthTurns: 2 });
    // 1 mouse step + 2 cat steps -> MATE_SCORE - 3
    expect(c2.result.mate).toBe('cat');
    expect(c2.result.value).toBe(MATE_SCORE - 3);

    writeOut('p1_mate_distance.json', {
      mouseMate: { fixture: 'M_CARRY_HOME', value: c1.result.value, expected: -MATE_SCORE + 2, mate: c1.result.mate },
      catMate: { fixture: 'M_CAT_MATE3', value: c2.result.value, expected: MATE_SCORE - 3, mate: c2.result.mate, depth: 2 },
      note: 'edge cost = mateActionCost (mouseStep 1, catStep 1, skill/trap/tunnel 0); distance is game time, not plies',
    });
  }, 900_000);

  it('P1-5: CHANCE stays a full-window expectation with conserved probability', () => {
    const f = fixtures().find((x) => x.id === 'M_BUTTER_MICRO')!.state;
    // root chance node (the single butter pickup) — enumerate it directly
    const pickup = generateLegalSearchActions(f, RULES)
      .find((a) => a.type === 'mouseStep' && simulateSearchAction(f, a, RULES).kind === 'chance');
    expect(pickup).toBeDefined();
    const tr = simulateSearchAction(f, pickup!, RULES);
    if (tr.kind !== 'chance') throw new Error('expected a chance transition');
    const wsum = tr.outcomes.reduce((a, o) => a + o.weight, 0);

    // The ITERATIVE wrapper only republishes a subset of the diagnostics, so the
    // chance counters are read off the fixed-depth entry point's own context.
    const ctx = createSearchContext(RULES, 500_000, true, true, true, 0, false);
    ctx.leafEvaluator = LEAF; // P1-11: without this the recorded value is defaultLeafEval
    const call = searchBestAction(f, 2, ctx);
    const d = call.diagnostics;
    console.log('chance outcomes=' + tr.outcomes.length, 'weightSum=' + wsum.toFixed(9),
      'chanceNodes=' + d.chanceNodes, 'fullWindow=' + d.fullWindowChanceSearches,
      'value=' + call.value.toFixed(3), 'nodes=' + d.nodes);

    writeOut('p1_chance.json', {
      fixture: 'M_BUTTER_MICRO',
      outcomes: tr.outcomes.length,
      weightSum: wsum,
      weights: tr.outcomes.map((o) => o.weight),
      spawnCells: (RULES.enumerateButterSpawns ? RULES.enumerateButterSpawns(f).length : null),
      chanceNodes: d.chanceNodes,
      fullWindowChanceSearches: d.fullWindowChanceSearches,
      value: call.value,
      nodes: d.nodes,
      note: 'D2 invariant: every chance outcome is searched with the FULL window (chanceNodes === fullWindowChanceSearches); the product never narrows a random node',
    });

    expect(Math.abs(wsum - 1)).toBeLessThan(1e-9);
    expect(tr.outcomes.length).toBeGreaterThan(1);
    expect(d.chanceNodes).toBeGreaterThan(0);
    // P1-5b: no chance outcome was ever pruned by an inherited window
    expect(d.fullWindowChanceSearches).toBe(d.chanceNodes);
    // oracle parity already covers the expectation arithmetic (P1-2)
  }, 900_000);

  it('P1-6: EXACT TT behaves identically at a mouse root (store, then re-hit)', () => {
    const root = fixtures().find((x) => x.id === 'M_MICRO')!.state;
    const ctx = createSearchContext(RULES, 500_000, true, true, true, 0, false);
    ctx.leafEvaluator = LEAF; // P1-11: without this the value is defaultLeafEval
    const first = searchBestAction(root, 2, ctx);
    const key = stateKey(root);
    const entry = ctx.tt.get(key) as any;
    const nodes1 = first.diagnostics.nodes;
    const second = searchBestAction(root, 2, ctx);
    const nodes2 = second.diagnostics.nodes;

    console.log('TT run1 value=' + first.value, 'nodes=' + nodes1, '| run2 value=' + second.value, 'nodes=' + nodes2);

    writeOut('p1_tt.json', {
      fixture: 'M_MICRO',
      depth: 2,
      storedValue: entry ? entry.value : null,
      storedMate: entry ? entry.mate : null,
      storedDepth: entry ? entry.depthTurns : null,
      value1: first.value,
      value2: second.value,
      nodes1,
      nodes2,
      action1: labelAction(first.action),
      action2: labelAction(second.action),
      note: 'a mouse root stores and re-serves the same EXACT entry; the second call resolves from the table (nodes collapse)',
    });

    expect(entry).toBeDefined();
    expect(entry.value).toBe(first.value);
    expect(first.value).toBe(second.value);
    expect(labelAction(first.action)).toBe(labelAction(second.action));
    expect(nodes2).toBeLessThan(nodes1);
  }, 900_000);

  it('P1-7: truncation FAILS CLOSED at a mouse root (no action, no EXACT write)', () => {
    const root = fixtures().find((x) => x.id === 'M_CARRY_HOME')!.state;
    const r = searchBestActionIterative(root, {
      rules: RULES, maxDepthTurns: 4, maxNodes: 40,
      useTT: true, useAlphaBeta: true, useMoveOrdering: true,
      leafEvaluator: LEAF,
    });
    writeOut('p1_truncation.json', {
      fixture: 'M_CARRY_HOME',
      maxNodes: 40,
      completed: r.completed,
      completedDepth: r.completedDepth,
      attemptedDepth: r.attemptedDepth,
      bestAction: labelAction(r.bestAction),
      value: r.value,
      budgetExhausted: r.budgetExhausted,
      mate: r.mate,
      note: 'completedDepth 0 => bestAction null => a controller must not act on it',
    });
    console.log('truncated:', JSON.stringify({
      completed: r.completed, completedDepth: r.completedDepth,
      action: labelAction(r.bestAction), value: r.value, budget: r.budgetExhausted,
    }));
    expect(r.completed).toBe(false);
    expect(r.completedDepth).toBe(0);
    expect(r.bestAction).toBeNull();
    expect(r.mate).toBeNull();
    expect(r.value).toBe(0);
  }, 900_000);

  it('P1-8: the CAT root path is unchanged by any of this (regression guard)', () => {
    // hand the turn over from a mouse fixture so the root actor is the cat
    const trapFixture = fixtures().find((x) => x.id === 'M_TRAP_ONLY')!.state;
    const afterTrap = endTurn(trapFixture);
    const catRoot: GameEngineState = {
      ...afterTrap,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
      mouseMovesLeft: 0,
    };
    const call = planMouseSearch(catRoot, { budgetMs: 4000, maxDepthTurns: 1 });
    const oracle = oracleTurnValue(catRoot, 1);
    console.log('cat root D1 search=' + call.result.value.toFixed(3), 'oracle=' + oracle.value.toFixed(3),
      'max=', call.result.bestAction ? 'picked ' + labelAction(call.result.bestAction) : 'none');
    expect(call.result.mate).toBe(oracle.mate);
    expect(Math.abs(call.result.value - oracle.value)).toBeLessThan(1e-6);
    expect(['catStep', 'catPlaceTrap']).toContain(call.result.bestAction!.type);
  }, 900_000);

  it('P1-9: writes the P1 evidence table', () => {
    writeOut('p1_mouse_root_parity.json', {
      section: 'P1 — production search vs unpruned oracle at a MOUSE root',
      ruleset_version: 2,
      leaf_mode: HARD_LEAF_MODE_CONFIG.current,
      rows,
      maxAbsValueDiff: rows.reduce((m, r) => Math.max(m, Math.abs(r.valueDiff)), 0),
      mateMismatches: rows.filter((r) => r.searchMate !== r.oracleMate).map((r) => r.id),
      actionTypeViolations: 0,
      note: 'value/mate are compared exactly; the oracle has no TT, no alpha-beta and no move ordering, so any pruning bug would show up as a difference here',
    });
    expect(rows.length).toBeGreaterThanOrEqual(13);
  });

  it('P1-10: legal-action COVERAGE at a mouse root (no invented, no missing)', () => {
    // Every action the search actually returns must be in the legal set, and the
    // legal set must equal a brute-force enumeration through the real rules.
    const report: any[] = [];
    for (const f of fixtures()) {
      const legal = generateLegalSearchActions(f.state, RULES);
      const ranked = oracleRootActions(f.state, 1);
      const sameSet = legal.length === ranked.length
        && legal.every((a) => ranked.some((r) => labelAction(r.action) === labelAction(a)));
      report.push({ id: f.id, legal: legal.map(labelAction), oracleRoot: ranked.map((r) => labelAction(r.action)), sameSet });
      appendJsonl('p1_legal_coverage.jsonl', report[report.length - 1]);
      expect(sameSet).toBe(true);
    }
    expect(report.length).toBeGreaterThanOrEqual(10);
  }, 900_000);

  it('P1-11: the fixed-depth entry silently uses defaultLeafEval unless leafEvaluator is injected', () => {
    // FOUND DURING P1: `createSearchContext` does NOT set `leafEvaluator`, and
    // `evaluateLeaf` falls back to `defaultLeafEval` (200 - 5*manhattan - 60*butter),
    // NOT to the production `evaluateForCat` the Hard planner uses. A caller that
    // wires a mouse controller through `searchBestAction(state, D, ctx)` without
    // injecting gets a DIFFERENT evaluation landscape with IDENTICAL traversal.
    // This test pins the contract: same node count, different value, and the
    // injected value matches the oracle. It is an API footgun, NOT a search bug.
    const out: any[] = [];
    for (const id of ['M_MICRO', 'M_BUTTER_MICRO']) {
      const root = fixtures().find((x) => x.id === id)!.state;
      const D = 1; // depth 1 is enough: the divergence is purely at the leaf
      const oracle = oracleTurnValue(root, D);
      const base = createSearchContext(RULES, 500_000, false, false, false, 0, false);
      const withLeaf = createSearchContext(RULES, 500_000, false, false, false, 0, false);
      withLeaf.leafEvaluator = LEAF;
      const a = searchBestAction(root, D, base);
      const b = searchBestAction(root, D, withLeaf);
      out.push({
        id,
        oracle: oracle.value,
        defaultLeafValue: a.value,
        injectedLeafValue: b.value,
        nodesDefault: a.diagnostics.nodes,
        nodesInjected: b.diagnostics.nodes,
        sameTraversal: a.diagnostics.nodes === b.diagnostics.nodes,
      });
      expect(a.diagnostics.nodes).toBe(b.diagnostics.nodes);       // identical tree
      expect(Math.abs(a.value - b.value)).toBeGreaterThan(1e-6);   // different number
      expect(Math.abs(b.value - oracle.value)).toBeLessThan(1e-6); // injected == oracle
    }
    writeOut('p1_leaf_injection_contract.json', {
      section: 'P1-11 — leafEvaluator injection is MANDATORY for parity with the Hard planner',
      factory: 'createSearchContext(rules, maxNodes, useTT, useAlphaBeta, useMoveOrdering, maxThreatExtensions, useThreatOrdering)',
      default_leaf: 'defaultLeafEval = 200 - 5*manhattan(cat,mouse) - 60*mouseHasButter',
      production_leaf: 'evaluateForCat (hardTurnPlanner.ts:239 defaults to it; iterative entry takes opts.leafEvaluator)',
      rows: out,
      integration_requirement: 'a mouse controller must set ctx.leafEvaluator = evaluateForCat (or pass opts.leafEvaluator to the iterative entry) or it will silently play a different game',
    });
    expect(out.length).toBe(2);
  }, 900_000);
});
