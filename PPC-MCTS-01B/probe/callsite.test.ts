/**
 * PPC-MCTS-01B-PHASE0 — UCT callsite attribution probe (read-only).
 *
 * The frozen prototype (`PPC-MCTS-01/proto/uct.ts`) is NOT modified. Instead the
 * `RuleSet` handed to `UctSearch` is a counting wrapper that reads its own
 * caller chain from `new Error().stack` and files every real rule transition
 * under the callsite that asked for it:
 *
 *   TREE_LEGALITY      generateLegalSearchActions  <- UctSearch.simulate (expansion)
 *   TREE_TRANSITION    simulateSearchAction        <- UctSearch.applyEdge
 *   ROLLOUT_LEGALITY   generateLegalSearchActions  <- UctSearch.rollout
 *   ROLLOUT_GUIDANCE   simulateSearchAction        <- guidanceValue <- selectRolloutAction
 *   ROLLOUT_EXEC       simulateSearchAction        <- UctSearch.rollout (selected action)
 *   EXT_LEGALITY       generateLegalSearchActions  <- UctSearch.extractPlan
 *   EXT_GUIDANCE       simulateSearchAction        <- guidanceValue <- selectRolloutAction <- extractPlan
 *   EXT_EXEC           simulateSearchAction        <- UctSearch.extractPlan
 *
 * Termination is by NODE CAP (maxNodes) with the wall clock set out of reach,
 * so each run is a fixed, reproducible workload — no timing measurement, no
 * benchmark, no fresh-process spawning.
 *
 * Output: PPC-MCTS-01B/data/callsites.json
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEngineRuleSet, type GameEngineState } from '../../src/game/engine';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import type { RuleSet } from '../../src/game/ai/searchTypes';
import { stateKey as stateKeyOf } from '../../src/game/ai/transposition';
import { UctSearch, uctSeed, type UctNode } from '../../PPC-MCTS-01/proto/uct';

const ROOT_FIXTURE = new URL('../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', import.meta.url);
const OUT_DIR = new URL('../data/', import.meta.url);
const baseRules = createEngineRuleSet();

const CATEGORIES = [
  'TREE_LEGALITY', 'TREE_TRANSITION',
  'ROLLOUT_LEGALITY', 'ROLLOUT_GUIDANCE', 'ROLLOUT_EXEC',
  'EXT_LEGALITY', 'EXT_GUIDANCE', 'EXT_EXEC',
  'UNKNOWN',
] as const;
type Category = typeof CATEGORIES[number];

interface RootRecord { id: string; state: unknown }

function loadRoots(): { id: string; state: GameEngineState }[] {
  const raw = readFileSync(ROOT_FIXTURE);
  expect(createHash('sha256').update(raw).digest('hex'))
    .toBe('1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09');
  return (JSON.parse(raw.toString('utf8')) as RootRecord[]).map((r) => ({
    id: r.id,
    state: restoreHardRoot(r.state as never),
  }));
}

function tagFromStack(): Category {
  const st = new Error().stack ?? '';
  const has = (s: string): boolean => st.includes(s);
  if (has('applyEdge')) return 'TREE_TRANSITION';
  if (has('guidanceValue')) return has('extractPlan') ? 'EXT_GUIDANCE' : 'ROLLOUT_GUIDANCE';
  if (has('generateLegalSearchActions')) {
    if (has('extractPlan')) return 'EXT_LEGALITY';
    if (has('rollout')) return 'ROLLOUT_LEGALITY';
    return 'TREE_LEGALITY';
  }
  if (has('extractPlan')) return 'EXT_EXEC';
  if (has('rollout')) return 'ROLLOUT_EXEC';
  return 'UNKNOWN';
}

interface Attribution {
  rules: RuleSet;
  byCategory: Record<Category, number>;
  byFn: Record<Category, Record<string, number>>;
  pairs: Map<string, Set<Category>>;
  unknownStacks: string[];
  total: () => number;
}

function attributingRules(): Attribution {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const byFn = Object.fromEntries(CATEGORIES.map((c) => [c, {}])) as Record<Category, Record<string, number>>;
  const pairs = new Map<string, Set<Category>>();
  const unknownStacks: string[] = [];
  let total = 0;

  const record = (fn: string, state: GameEngineState, action: string): void => {
    const cat = tagFromStack();
    total++;
    byCategory[cat]++;
    byFn[cat][fn] = (byFn[cat][fn] ?? 0) + 1;
    if (cat === 'UNKNOWN' && unknownStacks.length < 5) unknownStacks.push(new Error().stack ?? '');
    const key = `${stateKeyOf(state)}\u0000${fn}\u0000${action}`;
    let set = pairs.get(key);
    if (!set) { set = new Set(); pairs.set(key, set); }
    set.add(cat);
  };

  const rules: RuleSet = {
    mouseStep: (s, d) => { record('mouseStep', s, d.key); return baseRules.mouseStep(s, d); },
    catMove: (s, d) => { record('catMove', s, d.key); return baseRules.catMove(s, d); },
    mouseSkill: (s) => { record('mouseSkill', s, '-'); return baseRules.mouseSkill(s); },
    catPlaceTrap: (s) => { record('catPlaceTrap', s, '-'); return baseRules.catPlaceTrap(s); },
    chooseTunnelExit: (s, r, c) => { record('chooseTunnelExit', s, `t${r},${c}`); return baseRules.chooseTunnelExit(s, r, c); },
    endTurn: (s) => baseRules.endTurn(s),
    enumerateButterSpawns: (s) => baseRules.enumerateButterSpawns(s),
  };
  if (baseRules.buildButterChance) rules.buildButterChance = (s) => baseRules.buildButterChance!(s);
  if (baseRules.resolveGhostBoundaryChance) {
    rules.resolveGhostBoundaryChance = (s) => baseRules.resolveGhostBoundaryChance!(s);
  }
  return { rules, byCategory, byFn, pairs, unknownStacks, total: () => total };
}

// stateKey is imported at the top of this file (`stateKeyOf`).

function walkTree(node: UctNode, visit: (n: UctNode, edges: number) => void): number {
  let edges = 0;
  const stack: UctNode[] = [node];
  const seenNodes = new Set<UctNode>();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seenNodes.has(n)) continue;
    seenNodes.add(n);
    let nEdges = 0;
    for (const e of n.childNodes) if (e.child) { nEdges++; edges++; stack.push(e.child); }
    for (const o of n.chanceOutcomes) if (o.child) { edges++; nEdges++; stack.push(o.child); }
    visit(n, nEdges);
  }
  return edges;
}

describe('PPC-MCTS-01B-PHASE0 · UCT callsite rule-call attribution', () => {
  it('attributes every rule transition to a callsite at a fixed node cap', () => {
    const roots = loadRoots();
    const picked = roots.filter((r) => ['G6T1', 'G1T1', 'G2T6', 'G5T4'].includes(r.id));
    expect(picked.length).toBe(4);

    const NODE_CAP = 300;
    const perRun: unknown[] = [];
    const aggregate = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
    const aggFn = Object.fromEntries(CATEGORIES.map((c) => [c, {}])) as Record<Category, Record<string, number>>;
    let aggTotal = 0;
    let aggPrepared = 0;
    let unknownTotal = 0;
    const pairCategorySets: Record<string, number> = {};
    const multiCategoryPairs: { pair: string; cats: string[] }[] = [];

    for (const mode of ['hybrid', 'random'] as const) {
      for (const root of picked) {
        const attribution = attributingRules();
        const search = new UctSearch(root.state, {
          rules: attribution.rules,
          deadlineMs: 1e9,          // out of reach: termination is the node cap
          maxHandoffs: 4,
          maxNodes: NODE_CAP,
          c: Math.SQRT2,
          seed: uctSeed(root.id, mode === 'hybrid' ? 'UCT-H' : 'UCT-R', 1),
          rollout: mode,
          now: () => 0,             // fixed clock: no wall-clock dependence at all
          maxRolloutActions: 40,
        });
        const res = search.run();

        // tree-side bookkeeping from the returned tree itself
        let expandedNodes = 0;
        const treeKeys = new Set<string>();
        const treeEdges = walkTree(res.root, (n) => { expandedNodes++; treeKeys.add(stateKeyOf(n.state)); });

        const total = attribution.total();
        aggTotal += total;
        for (const c of CATEGORIES) {
          aggregate[c] += attribution.byCategory[c];
          for (const [fn, n] of Object.entries(attribution.byFn[c])) {
            aggFn[c][fn] = (aggFn[c][fn] ?? 0) + n;
          }
        }
        unknownTotal += attribution.byCategory.UNKNOWN;

        // prepared counterfactual: legality sims survive, transition re-sims die
        const removable =
          attribution.byCategory.TREE_TRANSITION +
          attribution.byCategory.ROLLOUT_GUIDANCE +
          attribution.byCategory.ROLLOUT_EXEC +
          attribution.byCategory.EXT_GUIDANCE +
          attribution.byCategory.EXT_EXEC;
        aggPrepared += total - removable;

        for (const [pair, cats] of attribution.pairs) {
          const tag = [...cats].sort().join('+');
          pairCategorySets[tag] = (pairCategorySets[tag] ?? 0) + 1;
          if (cats.size > 1 && multiCategoryPairs.length < 10) {
            multiCategoryPairs.push({ pair: pair.replace(/\u0000/g, ' :: ').slice(0, 120), cats: [...cats] });
          }
        }

        perRun.push({
          root: root.id,
          mode,
          simulations: res.diagnostics.simulations,
          nodesCreated: res.diagnostics.nodesCreated,
          chanceNodes: res.diagnostics.chanceNodes,
          rolloutSteps: res.diagnostics.rolloutSteps,
          chanceSamples: res.diagnostics.chanceSamples,
          nodeCapHit: res.diagnostics.nodeCapHit,
          treeDecisionNodes: expandedNodes,
          treeEdgesMaterialized: treeEdges,
          ruleCalls: total,
          byCategory: { ...attribution.byCategory },
          removableByReuse: removable,
          preparedRuleCalls: total - removable,
          distinctStateActionPairs: attribution.pairs.size,
          unknownStacks: attribution.unknownStacks,
        });
      }
    }

    const summary = {
      provenance: {
        generatedBy: 'PPC-MCTS-01B/probe/callsite.test.ts',
        head: '48eaac6c4f3801d351787696ba5876995b64e8d8',
        uctSource: 'PPC-MCTS-01/proto/uct.ts (read-only, unmodified)',
        termination: `node cap ${NODE_CAP} with now() === 0 (no wall clock, no timing)`,
        roots: picked.map((r) => r.id),
        modes: ['hybrid', 'random'],
      },
      categoryTotals: aggregate,
      categoryFn: aggFn,
      totalRuleCalls: aggTotal,
      unknownTotal,
      removableByReuse: aggTotal - aggPrepared,
      preparedRuleCalls: aggPrepared,
      savingFraction: (aggTotal - aggPrepared) / aggTotal,
      pairCategorySets,
      multiCategoryPairs,
      perRun,
    };

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(new URL('callsites.json', OUT_DIR), `${JSON.stringify(summary, null, 2)}\n`);

    // The attribution must be complete: an unattributed rule call would mean a
    // callsite this audit did not model.
    expect(unknownTotal, `unattributed: ${JSON.stringify(perRun)}`).toBe(0);
    expect(aggregate.TREE_LEGALITY).toBeGreaterThan(0);
    expect(aggregate.TREE_TRANSITION).toBeGreaterThan(0);
    expect(aggregate.ROLLOUT_LEGALITY).toBeGreaterThan(0);
    expect(aggregate.ROLLOUT_GUIDANCE).toBeGreaterThan(0);
    expect(aggregate.ROLLOUT_EXEC).toBeGreaterThan(0);
  });
});
