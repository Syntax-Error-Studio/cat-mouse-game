/// <reference types="node" />
/**
 * Phase 6 — E1 vs corrected-hole CAUSAL attribution at G6T2 (D1/D2).
 *
 * NO production source is modified. The production evaluator (evaluateForCat /
 * E1) and the feature-flagged corrected-hole leaf (evaluateCorrectedHoleForCat,
 * DEFAULT OFF) are used READ-ONLY. The only instrumented object is a per-search
 * leaf wrapper that records the explainable breakdown of every horizon leaf.
 *
 * Two protocols per evaluator, never blended:
 *   FAITHFUL    : createSearchContext(rules, 400000, TT, AB, ordering, 0, false)
 *                 + leafEvaluator + capturePlan  → reproduces the prior round's
 *                 rootValues / plan / nodes (the AB/TT/ordering production path).
 *   ATTRIBUTION : createSearchContext(rules, ATTR_CAP, false,false,false,0,false)
 *                 + evalCache=undefined + capturePlan + recording wrapper.
 *                 TT/AB/ordering OFF ⇒ every root value is the EXACT full-window
 *                 minimax (no fail-soft bound), and every horizon leaf is visited
 *                 so the decisive leaf behind each root value can be identified.
 *
 * The equality cause is MEASURED, not assumed:
 *   - correctedTotal === E1total − 2·holeControl_E1 (exact identity, both-reachable)
 *   - the D2 U=D=L tie under E1 is reproduced with EXACT (AB-off) values
 *   - the decisive horizon leaf behind each root action is dumped (10 features +
 *     10 contributions) and shared decisive keys across U/D/L are intersected
 *   - existing `tempo` (current-turn moves-left) is shown turn-phase-locked, and a
 *     SHADOW cross-turn tactical tempo is computed in isolation (never wired).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { createSearchContext, searchBestAction, type SearchContext } from '../../src/game/ai/expectiminimax';
import {
  evaluateForCatDetailed, evaluateForCat, DEFAULT_EVALUATION_WEIGHTS,
  type EvaluationBreakdown,
} from '../../src/game/ai/evaluation';
import {
  evaluateCorrectedHoleForCat, correctedHoleEvalTotal, correctedHoleControlValue,
} from '../../src/game/ai/correctedHoleLeaf';
import {
  rules, label, stateKey, summarize, applyPrefix,
  mouseForcesWinSeal, catSurvivesSeal,
} from './seal_lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const FROZEN_FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const OUT = 'PPC-CAT-STRATEGY-SEAL-01';
const HEAD = '48eaac6c4f3801d351787696ba5876995b64e8d8';
const FAITHFUL_CAP = 400_000;
const ATTR_CAP = 8_000_000; // probe-only full-tree cap; reported honestly (never the 600k quantifier cap)
const H1 = 2;
const QCAP = 600_000;
const EPS = 1e-6;

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as { id: string; state: unknown; canonicalSnapshotSha256: string }[];
const load = (id: string): GameEngineState => restoreHardRoot(records.find((r) => r.id === id)!.state as never);
const snap = (id: string) => records.find((r) => r.id === id)!.canonicalSnapshotSha256;

type Mode = 'E1' | 'corrected';

interface LeafInfo {
  key: string;
  roots: Set<number>;
  total: number;
  correctedTotal: number;
  clamped: boolean;
  holeControlE1: number;
  holeControlCorrected: number;
  holeControlMargin: number | null;
  catHoleGateDistance: number | null;
  mouseHoleGateDistance: number | null;
  mouseWinRouteDistance: number | null;
  cat: string; mouse: string;
  currentPlayer: string;
  catMovesLeft: number; mouseMovesLeft: number;
  catBaseMoves: number; mouseBaseMoves: number;
  bd: EvaluationBreakdown;
  summary: ReturnType<typeof summarize>;
}

/** Recording leaf wrapper: computes the breakdown ONCE per unique key, derives both totals. */
function makeWrapper(ctx: SearchContext, mode: Mode, leafInfo: Map<string, LeafInfo>) {
  return (state: GameEngineState): number => {
    const k = stateKey(state);
    const rootIndex = ctx.rootValues.length; // during root action k's subtree === k
    let info = leafInfo.get(k);
    if (info) {
      // evaluateForCatDetailed is pure → the stored breakdown is exact for this key.
      info.roots.add(rootIndex);
      return mode === 'E1' ? info.total : info.correctedTotal;
    }
    const bd = evaluateForCatDetailed(state);
    const bs = state.config.boardSize;
    const correctedTotal = correctedHoleEvalTotal(bd, bs);
    info = {
      key: k, roots: new Set<number>([rootIndex]),
      total: bd.total, correctedTotal, clamped: bd.clamped,
      holeControlE1: bd.contributions.holeControl,
      holeControlCorrected: correctedHoleControlValue(bd, bs),
      holeControlMargin: bd.features.holeControlMargin,
      catHoleGateDistance: bd.features.catHoleGateDistance,
      mouseHoleGateDistance: bd.features.mouseHoleGateDistance,
      mouseWinRouteDistance: bd.features.mouseWinRouteDistance,
      cat: `${state.catPosition.r},${state.catPosition.c}`,
      mouse: `${state.mousePosition.r},${state.mousePosition.c}`,
      currentPlayer: state.currentPlayer,
      catMovesLeft: state.catMovesLeft, mouseMovesLeft: state.mouseMovesLeft,
      catBaseMoves: state.config.catBaseMoves, mouseBaseMoves: state.config.mouseBaseMoves,
      bd, summary: summarize(state),
    };
    leafInfo.set(k, info);
    return mode === 'E1' ? bd.total : correctedTotal;
  };
}

function faithfulRun(root: GameEngineState, depth: number, mode: Mode) {
  const ctx = createSearchContext(rules, FAITHFUL_CAP, true, true, true, 0, false);
  ctx.leafEvaluator = mode === 'E1' ? evaluateForCat : evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const t0 = performance.now();
  const r = searchBestAction(root, depth, ctx);
  const planLabels = r.catTurnPlan.map((a) => label(a));
  return {
    protocol: `FAITHFUL-D${depth} (${mode === 'E1' ? 'evaluateForCat / E1' : 'evaluateCorrectedHoleForCat'})`,
    bestAction: label(r.action), plan: planLabels, planString: planLabels.join(''),
    value: r.value, mate: r.mate, completed: r.completed,
    nodes: r.diagnostics.nodes, chanceNodes: r.diagnostics.chanceNodes,
    leafNodes: r.diagnostics.leafNodes, elapsedMs: Math.round(performance.now() - t0),
    rootValues: ctx.rootValues.map((x) => ({ action: label(x.action), value: x.value, mate: x.mate, bound: x.bound })),
  };
}

function attributionRun(root: GameEngineState, depth: number, mode: Mode) {
  const ctx = createSearchContext(rules, ATTR_CAP, false, false, false, 0, false);
  ctx.evalCache = undefined; // disable memoization → wrapper sees EVERY leaf
  ctx.capturePlan = true;
  const leafInfo = new Map<string, LeafInfo>();
  ctx.leafEvaluator = makeWrapper(ctx, mode, leafInfo);
  const t0 = performance.now();
  const r = searchBestAction(root, depth, ctx);
  const elapsedMs = Math.round(performance.now() - t0);
  const rootValues = ctx.rootValues.map((x) => ({ action: label(x.action), value: x.value, mate: x.mate, bound: x.bound }));

  // group captured leaves by the root action index whose subtree visited them
  const valueOf = (info: LeafInfo) => (mode === 'E1' ? info.total : info.correctedTotal);
  const byRoot = new Map<number, LeafInfo[]>();
  for (const info of leafInfo.values()) {
    for (const ri of info.roots) {
      if (!byRoot.has(ri)) byRoot.set(ri, []);
      byRoot.get(ri)!.push(info);
    }
  }
  const decisiveByRoot = rootValues.map((rv, ri) => {
    const leaves = byRoot.get(ri) ?? [];
    let min = Infinity, max = -Infinity;
    for (const l of leaves) { const v = valueOf(l); if (v < min) min = v; if (v > max) max = v; }
    const decisiveKeys = [...new Set(leaves.filter((l) => Math.abs(valueOf(l) - rv.value) < EPS).map((l) => l.key))];
    return {
      action: rv.action, rootValue: rv.value, mate: rv.mate, bound: rv.bound,
      visitedLeafCount: leaves.length, minLeafValue: min, maxLeafValue: max,
      decisiveLeafFoundByValueEquality: decisiveKeys.length > 0,
      decisiveKeys,
    };
  });

  return {
    protocol: `ATTRIBUTION-D${depth} (${mode}; TT/AB/ordering OFF, evalCache OFF)`,
    bestAction: label(r.action), value: r.value, mate: r.mate, completed: r.completed,
    nodes: r.diagnostics.nodes, chanceNodes: r.diagnostics.chanceNodes,
    leafNodes: r.diagnostics.leafNodes, uniqueHorizonKeys: leafInfo.size,
    attrCap: ATTR_CAP, elapsedMs, rootValues, decisiveByRoot, leafInfo,
  };
}

/** Strip the non-serializable leafInfo Map for the published JSON. */
function pub(attr: ReturnType<typeof attributionRun>) {
  const { leafInfo, ...rest } = attr;
  void leafInfo;
  return rest;
}

/** Full breakdown dumps of the decisive horizon leaves behind each root action. */
function decisiveDumps(attr: ReturnType<typeof attributionRun>, mode: Mode) {
  const valueOf = (i: LeafInfo) => (mode === 'E1' ? i.total : i.correctedTotal);
  return attr.rootValues.map((rv, ri) => {
    const decisive: LeafInfo[] = [];
    for (const info of attr.leafInfo.values()) {
      if (info.roots.has(ri) && Math.abs(valueOf(info) - rv.value) < EPS) decisive.push(info);
    }
    return { action: rv.action, rootValue: rv.value, bound: rv.bound, decisiveLeafCount: decisive.length, decisiveLeaves: decisive.map(fullDump) };
  });
}

function fullDump(info: LeafInfo) {
  const c = info.bd.contributions;
  return {
    key: info.key, cat: info.cat, mouse: info.mouse,
    currentPlayer: info.currentPlayer, catMovesLeft: info.catMovesLeft, mouseMovesLeft: info.mouseMovesLeft,
    catBaseMoves: info.catBaseMoves, mouseBaseMoves: info.mouseBaseMoves,
    total_E1: info.total, total_corrected: info.correctedTotal, clamped: info.clamped,
    holeControlMargin: info.holeControlMargin,
    catHoleGateDistance: info.catHoleGateDistance, mouseHoleGateDistance: info.mouseHoleGateDistance,
    mouseWinRouteDistance: info.mouseWinRouteDistance,
    holeControl_E1: info.holeControlE1, holeControl_corrected: info.holeControlCorrected,
    features: info.bd.features,
    contributions_E1: c,
    contributions_corrected: { ...c, holeControl: info.holeControlCorrected },
    summary: info.summary,
  };
}

/** SHADOW cross-turn tactical tempo (PROPOSED, isolated — never wired to production). */
function proposedCrossTurnTempo(info: {
  mouseWinRouteDistance: number | null; catHoleGateDistance: number | null;
  catBaseMoves: number; mouseBaseMoves: number;
}) {
  const mwr = info.mouseWinRouteDistance;
  const cg = info.catHoleGateDistance;
  const mouseTurnsToGoal = mwr === null ? null : Math.ceil(mwr / Math.max(1, info.mouseBaseMoves));
  const catTurnsToGate = cg === null ? null : Math.ceil(cg / Math.max(1, info.catBaseMoves));
  const margin = (mouseTurnsToGoal === null || catTurnsToGate === null) ? null : catTurnsToGate - mouseTurnsToGoal;
  return { mouseWinRouteDistance: mwr, catHoleGateDistance: cg, mouseTurnsToGoal, catTurnsToGate, catTurnsToGate_minus_mouseTurnsToGoal: margin };
}

describe('Phase 6 E1 vs corrected-hole causal attribution (G6T2)', () => {
  it('reproduces D1/D2, proves the U=D=L equality cause, dumps features + tempo', () => {
    expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);
    const root = load('G6T2');
    const t0 = performance.now();
    const base = { catBaseMoves: root.config.catBaseMoves, mouseBaseMoves: root.config.mouseBaseMoves, boardSize: root.config.boardSize };

    // ---------- FAITHFUL reproduction (prior round protocol) ----------
    const faithful = {
      E1: { D1: faithfulRun(root, 1, 'E1'), D2: faithfulRun(root, 2, 'E1') },
      corrected: { D1: faithfulRun(root, 1, 'corrected'), D2: faithfulRun(root, 2, 'corrected') },
    };

    // ---------- ATTRIBUTION (exact full-window, every leaf recorded) ----------
    const attrE1D1 = attributionRun(root, 1, 'E1');
    const attrCorrD1 = attributionRun(root, 1, 'corrected');
    const attrE1D2 = attributionRun(root, 2, 'E1');
    const attrCorrD2 = attributionRun(root, 2, 'corrected');

    const e1Decisive = decisiveDumps(attrE1D2, 'E1');
    const corrDecisive = decisiveDumps(attrCorrD2, 'corrected');

    // ---------- exact identity: corrected = E1 − 2·holeControl_E1 ----------
    let identityMaxAbsError = 0, identityChecked = 0, identityBothReachable = 0;
    for (const info of attrE1D2.leafInfo.values()) {
      const both = info.catHoleGateDistance !== null && info.mouseHoleGateDistance !== null;
      const predicted = both ? info.total - 2 * info.holeControlE1 : info.total;
      const err = Math.abs(predicted - info.correctedTotal);
      if (err > identityMaxAbsError) identityMaxAbsError = err;
      identityChecked++; if (both) identityBothReachable++;
    }

    // ---------- equality cause across U / D / L at D2 ----------
    const rootOrder = attrE1D2.rootValues.map((r) => r.action); // original legal order
    const e1Vals = attrE1D2.rootValues.map((r) => r.value);
    const corrVals = attrCorrD2.rootValues.map((r) => r.value);
    const e1Distinct = new Set(e1Vals.map((v) => v.toFixed(9))).size;
    const corrDistinct = new Set(corrVals.map((v) => v.toFixed(9))).size;
    const e1Tie = e1Distinct === 1;
    // shared decisive keys across ALL root actions (convergence proof)
    const decisiveKeySets = e1Decisive.map((d) => new Set(d.decisiveLeaves.map((l) => l.key)));
    let sharedE1: string[] = [];
    if (decisiveKeySets.length > 0) {
      sharedE1 = [...decisiveKeySets[0]].filter((k) => decisiveKeySets.every((s) => s.has(k)));
    }
    const corrDecisiveKeySets = corrDecisive.map((d) => new Set(d.decisiveLeaves.map((l) => l.key)));
    let sharedCorr: string[] = [];
    if (corrDecisiveKeySets.length > 0) {
      sharedCorr = [...corrDecisiveKeySets[0]].filter((k) => corrDecisiveKeySets.every((s) => s.has(k)));
    }

    // ---------- existing tempo discriminative power at the D2 horizon ----------
    const tempoValues = new Set<string>();
    const tempoInputs = new Set<string>();
    for (const info of attrE1D2.leafInfo.values()) {
      tempoValues.add(info.bd.contributions.tempo.toFixed(9));
      tempoInputs.add(`${info.currentPlayer}|${info.catMovesLeft}|${info.mouseMovesLeft}`);
    }

    // ---------- SHADOW cross-turn tempo at the three full-turn end states ----------
    const endStateAnalysis = ['UURR', 'DRRR', 'DRDR'].map((name) => {
      const pre = applyPrefix(root, name.split(''), 0);
      const st = pre.states[0];
      const bd = evaluateForCatDetailed(st);
      const info = {
        mouseWinRouteDistance: bd.features.mouseWinRouteDistance,
        catHoleGateDistance: bd.features.catHoleGateDistance,
        catBaseMoves: st.config.catBaseMoves, mouseBaseMoves: st.config.mouseBaseMoves,
      };
      const sv = catSurvivesSeal(st, H1, pre.idx[0], QCAP);
      const mf = mouseForcesWinSeal(st, H1, pre.idx[0], QCAP);
      return {
        plan: name, endState: summarize(st),
        existingTempoContribution: bd.contributions.tempo,
        existingTempoInputs: { currentPlayer: bd.features.currentPlayer, catMovesLeft: bd.features.catMovesLeft, mouseMovesLeft: bd.features.mouseMovesLeft },
        proposedCrossTurnTempo: proposedCrossTurnTempo(info),
        holeControl_E1: bd.contributions.holeControl,
        holeControl_corrected: correctedHoleControlValue(bd, st.config.boardSize),
        holeControlMargin: bd.features.holeControlMargin,
        catHoleGateDistance: bd.features.catHoleGateDistance,
        mouseHoleGateDistance: bd.features.mouseHoleGateDistance,
        tactical: { catSurvive: sv.value, mouseForcedWin: mf.value,
          verdict: sv.value === true ? 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1'
            : mf.value === true ? 'MOUSE_FORCED_WIN_WITHIN_H1'
            : (sv.value === null || mf.value === null) ? 'UNRESOLVED' : 'CHANCE_DEPENDENT_OUTCOME' },
      };
    });

    // ---------- D1 holeControl confirmation (corrected − E1 = −2·holeControl) ----------
    const d1E1 = faithful.E1.D1.value, d1Corr = faithful.corrected.D1.value;
    const d1Delta = d1Corr - d1E1;
    // cross-check: the faithful D1 delta must equal −2·holeControl_E1 measured at
    // the D1 decisive horizon leaf behind the chosen (index 0) root action.
    const d1Decisive = decisiveDumps(attrE1D1, 'E1');
    const d1DecisiveHoleControl = d1Decisive[0]?.decisiveLeaves[0]?.holeControl_E1 ?? null;
    const d1IdentityHolds = d1DecisiveHoleControl !== null && Math.abs(d1Delta + 2 * d1DecisiveHoleControl) < EPS;

    const doc = {
      artifactId: 'E1_CORRECTED_HOLE_ATTRIBUTION', round: 'PPC-CAT-STRATEGY-SEAL-01', phase: 6,
      generatedAt: new Date().toISOString(), generatedBy: 'PPC-CAT-STRATEGY-SEAL-01/probe/attribution.test.ts',
      head: HEAD, root: 'G6T2', provenance: 'REAL_HUMAN_REPLAY', canonicalSnapshotSha256: snap('G6T2'),
      fixtureSha256: FROZEN_FIXTURE_SHA, rootState: summarize(root), config: base,
      productionSourceChanged: false,
      note: 'E1 = evaluateForCat (production). corrected = evaluateCorrectedHoleForCat (feature-flagged, DEFAULT OFF). Both used read-only; the only difference is the holeControl sign.',
      weights: DEFAULT_EVALUATION_WEIGHTS,
      protocols: {
        faithful: 'createSearchContext(rules,400000,TT,AB,ordering,0,false)+leafEvaluator+capturePlan',
        attribution: 'createSearchContext(rules,8000000,false,false,false,0,false)+evalCache=undefined+capturePlan+recording wrapper (exact full-window minimax, every horizon leaf visited)',
      },
      faithful,
      attribution: {
        E1: { D1: pub(attrE1D1), D2: pub(attrE1D2) },
        corrected: { D1: pub(attrCorrD1), D2: pub(attrCorrD2) },
      },
      faithfulVsAttributionRootValues: {
        E1_D2: { faithful: faithful.E1.D2.rootValues, attribution: attrE1D2.rootValues,
          match: faithful.E1.D2.rootValues.every((f, i) => Math.abs(f.value - attrE1D2.rootValues[i].value) < EPS) },
        corrected_D2: { faithful: faithful.corrected.D2.rootValues, attribution: attrCorrD2.rootValues,
          match: faithful.corrected.D2.rootValues.every((f, i) => Math.abs(f.value - attrCorrD2.rootValues[i].value) < EPS) },
      },
      holeControlIdentity: {
        statement: 'correctedTotal === E1total − 2·holeControl_E1 when both gate distances non-null; else correctedTotal === E1total',
        leavesChecked: identityChecked, bothReachableLeaves: identityBothReachable, maxAbsError: identityMaxAbsError,
        verified: identityMaxAbsError < EPS,
      },
      equalityCause: {
        rootOrder, E1_D2_rootValues: e1Vals, corrected_D2_rootValues: corrVals,
        E1_D2_distinctRootValues: e1Distinct, corrected_D2_distinctRootValues: corrDistinct,
        E1_D2_tie: e1Tie,
        E1_sharedDecisiveKeysAcrossAllRoots: sharedE1,
        corrected_sharedDecisiveKeysAcrossAllRoots: sharedCorr,
        E1_decisiveLeavesByRoot: e1Decisive,
        corrected_decisiveLeavesByRoot: corrDecisive,
        D1: { E1_value: d1E1, corrected_value: d1Corr, delta: d1Delta, impliedHoleControlE1: -d1Delta / 2,
          decisiveLeafHoleControlE1: d1DecisiveHoleControl, identityHolds: d1IdentityHolds },
      },
      tempoAnalysis: {
        existing: {
          formula: 'cat to move: ((catMovesLeft−mouseMovesLeft)/base)*200; else −((mouseMovesLeft−catMovesLeft)/base)*200; base=max(1,min(catBaseMoves,mouseBaseMoves))',
          scope: 'CURRENT-TURN moves-left difference only (turn-phase-locked)',
          distinctTempoValuesAtD2Horizon: [...tempoValues],
          distinctTempoInputPhasesAtD2Horizon: [...tempoInputs],
          discriminativePowerAtD2Horizon: tempoValues.size === 1 ? 'NONE (constant across every horizon leaf)' : `partial (${tempoValues.size} distinct values)`,
        },
        proposed: {
          name: 'cross-turn tactical tempo (SHADOW / PROPOSED — isolated, never wired to production Hard Cat)',
          definition: 'mouseTurnsToGoal=ceil(mouseWinRouteDistance/mouseBaseMoves); catTurnsToGate=ceil(catHoleGateDistance/catBaseMoves); margin=catTurnsToGate−mouseTurnsToGoal (in TURNS; negative=cat guards the gate before the mouse arrives)',
          distinctionFromExisting: 'existing tempo sees only the current-turn moves-left difference (identical at a turn boundary); the proposed signal measures the multi-turn butter-to-hole race vs the cat gate-interception race, which DOES differ between cat endpoints.',
          endStates: endStateAnalysis,
        },
      },
      elapsedMs: Math.round(performance.now() - t0),
    };
    writeFileSync(`${OUT}/E1_CORRECTED_HOLE_ATTRIBUTION.json`, JSON.stringify(doc, null, 2));

    // ---------- assertions (measured facts, honest) ----------
    // faithful reproduces the prior round's E1 D2 tie and corrected D2 D-win
    expect(faithful.E1.D2.completed).toBe(true);
    expect(faithful.corrected.D2.completed).toBe(true);
    expect(e1Tie, 'E1 D2 must reproduce the U=D=L tie').toBe(true);
    expect(corrDistinct, 'corrected D2 must distinguish the safe opening').toBeGreaterThan(1);
    // exact identity holds at every captured leaf
    expect(identityMaxAbsError).toBeLessThan(EPS);
    // attribution (AB off) agrees with faithful (AB on) → tie is genuine, not a bound artifact
    expect(doc.faithfulVsAttributionRootValues.E1_D2.match).toBe(true);
    expect(doc.faithfulVsAttributionRootValues.corrected_D2.match).toBe(true);
    // attribution runs completed within the probe cap (no truncation)
    expect(attrE1D2.completed, `E1 D2 attribution truncated at ${attrE1D2.nodes} nodes`).toBe(true);
    expect(attrCorrD2.completed, `corrected D2 attribution truncated at ${attrCorrD2.nodes} nodes`).toBe(true);
    // D1 delta cross-checks against the measured decisive-leaf holeControl
    expect(d1IdentityHolds, `D1 delta ${d1Delta} vs −2·holeControl ${d1DecisiveHoleControl}`).toBe(true);

    console.log('E1 D2 rootValues=', JSON.stringify(e1Vals), 'distinct=', e1Distinct);
    console.log('corrected D2 rootValues=', JSON.stringify(corrVals), 'distinct=', corrDistinct);
    console.log('E1 shared decisive keys=', JSON.stringify(sharedE1), 'identityMaxAbsError=', identityMaxAbsError);
    console.log('existing tempo distinct at D2 horizon=', [...tempoValues], 'phases=', [...tempoInputs]);
    console.log('D1 delta=', d1Delta, 'impliedHoleControlE1=', -d1Delta / 2);
    console.log('attr nodes E1/corr D2=', attrE1D2.nodes, attrCorrD2.nodes, 'uniqueKeys=', attrE1D2.uniqueHorizonKeys, attrCorrD2.uniqueHorizonKeys);
    for (const e of endStateAnalysis) console.log('endState', e.plan, 'existingTempo=', e.existingTempoContribution, 'proposed=', JSON.stringify(e.proposedCrossTurnTempo), 'verdict=', e.tactical.verdict);
  }, 3_600_000);
});