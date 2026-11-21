/// <reference types="node" />
/**
 * PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01 / G4 — evaluation explanation.
 *
 * Keeps three quantities STRICTLY separate and never folds them into one score:
 *   1. spatial progress of the complete cat turn (state-visible features);
 *   2. D2 expected value after the mouse's full next turn (fresh depth-1
 *      production search from each frontier, checked against the frozen forced
 *      comparison DUUD = -658.2105263157898 / DRRR = -854);
 *   3. the H2 finite-window cat-survival label (historical certificate, offline).
 *
 * E1 is decomposable non-invasively: the production search exposes
 * `ctx.leafEvaluator`, so a recording wrapper collects `evaluateForCatDetailed`
 * contributions at every evaluated leaf. E1 itself is never modified.
 * Aggregate leaf statistics cover VISITED leaves of a pruned search, not an exact
 * expectation decomposition — recorded as a stated limit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OUT, ROOT_ID, FROZEN_FORCED,
  loadRoot, enumerateCompleteCatTurns, endStatesOf, planFeatures,
  evaluateForCatDetailed, searchBestAction, makeCtx, canonicalJson, fullStateSha,
  writeJson, ensureDirs,
} from './pcfe_lib';
import type { GameEngineState } from '../../src/game/engine';

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

interface Detail { total: number; contributions: Record<string, number>; clamped: boolean }

describe('G4 evaluation decomposition', () => {
  it('separates spatial progress, D2 expectation and the H2 label', () => {
    ensureDirs();
    const root = loadRoot();
    const { turns } = enumerateCompleteCatTurns(root);

    const pick = (labels: string) => {
      const t = turns.find((x) => x.labels === labels);
      if (!t) throw new Error(`plan ${labels} not enumerated`);
      const { states, endKind } = endStatesOf(root, t.plan);
      if (states.length !== 1) throw new Error(`${labels} has ${states.length} end states`);
      return { turn: t, state: states[0], endKind };
    };

    const duud = pick('DUUD');
    const drrr = pick('DRRR');
    const uudd = pick('UUDD');

    // ---- 1. spatial progress of the complete cat turn ----------------------
    const spatial: Record<string, unknown> = {};
    for (const [name, p] of [['UUDD', uudd], ['DUUD', duud], ['DRRR', drrr]] as const) {
      const f = planFeatures(root, p.turn);
      spatial[name] = {
        planLabels: name,
        uniqueProgress: f.uniqueProgress,
        revisitCount: f.revisitCount,
        zeroCostActions: f.zeroCostActions,
        boardChangedVsRoot: f.boardChangedVsRoot,
        boxesMovedVsRoot: f.boxesMovedVsRoot,
        distanceStart: f.distanceStart,
        distanceEnd: f.distanceEnd,
        distanceDelta: f.distanceDelta,
        finalCat: f.finalCat,
        finalMouse: f.finalMouse,
        endKind: p.endKind,
        endFullStateSha256: fullStateSha(p.state),
      };
    }

    // ---- 2a. static E1 at each frontier (non-invasive, read only) ----------
    const staticEval = (s: GameEngineState) => {
      const d = evaluateForCatDetailed(s);
      const rawSum = Object.values(d.contributions).reduce((a, b) => a + b, 0);
      return { total: d.total, rawSum, clamped: d.clamped, contributions: d.contributions } as Detail & { rawSum: number };
    };
    const e1u = staticEval(uudd.state);
    const e1d = staticEval(duud.state);
    const e1r = staticEval(drrr.state);
    const featureKeys = Object.keys(e1d.contributions);
    const e1GapDuudMinusDrrr = Object.fromEntries(featureKeys.map((k) => [k, e1d.contributions[k] - e1r.contributions[k]]));

    // ---- 2b. D2 expectation: fresh depth-1 search from each frontier -------
    const runFrontier = (s: GameEngineState, expected: number, name: string) => {
      const calls: Detail[] = [];
      const ctx = makeCtx(false);
      ctx.leafEvaluator = (st: GameEngineState) => {
        const d = evaluateForCatDetailed(st);
        calls.push({ total: d.total, clamped: d.clamped, contributions: d.contributions });
        return d.total;
      };
      const res = searchBestAction(s, 1, ctx);
      const diag = res.diagnostics;
      const sum: Record<string, number> = {};
      for (const k of featureKeys) sum[k] = 0;
      for (const c of calls) for (const k of featureKeys) sum[k] += c.contributions[k];
      const mean = calls.length ? Object.fromEntries(featureKeys.map((k) => [k, sum[k] / calls.length])) : null;
      const totals = calls.map((c) => c.total);
      const out = {
        frontier: name,
        frontierFullStateSha256: fullStateSha(s),
        value: res.value,
        expectedFrozenValue: expected,
        matchesFrozen: Math.abs(res.value - expected) < 1e-9,
        absoluteDifference: Math.abs(res.value - expected),
        mate: res.mate,
        completed: res.completed,
        nodesVisited: diag.nodes,
        leafNodes: diag.leafNodes,
        chanceNodes: diag.chanceNodes,
        leafCalls: calls.length,
        leafTotals: {
          min: totals.length ? Math.min(...totals) : null,
          max: totals.length ? Math.max(...totals) : null,
          mean: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null,
        },
        leafMeanContributions: mean,
        clampedLeafCalls: calls.filter((c) => c.clamped).length,
      };
      expect(out.matchesFrozen).toBe(true);
      return out;
    };
    const d2duud = runFrontier(duud.state, FROZEN_FORCED.duud, 'DUUD');
    const d2drrr = runFrontier(drrr.state, FROZEN_FORCED.drrr, 'DRRR');

    // ---- 3. H2 label (offline certificate, not recomputed) -----------------
    const recert = readJson('PPC-CAT-STRATEGY-SEAL-01/G6T2_RECERTIFICATION.json');
    const drrrLabel = recert.fullTurnPrefixes.find((p: { name: string }) => p.name === 'DRRR');
    const uerrLabel = recert.fullTurnPrefixes.find((p: { name: string }) => p.name === 'UURR');

    const out = {
      round: OUT, phase: 'G4_EVALUATION_DECOMPOSITION', generatedAt: new Date().toISOString(),
      rootId: ROOT_ID,
      e1Source: 'src/game/ai/evaluation.ts evaluateForCatDetailed (unmodified, read-only)',
      separation: {
        spatialProgressOfCompleteCatTurn: spatial,
        d2ExpectationAfterMouseTurn: {
          DUUD: d2duud,
          DRRR: d2drrr,
          frozenReference: {
            duud: FROZEN_FORCED.duud,
            drrr: FROZEN_FORCED.drrr,
            delta: FROZEN_FORCED.delta,
            source: 'round-01 forced-DUUD vs forced-DRRR comparison (not re-run)',
          },
        },
        h2SurvivalWindow: {
          // The frozen certificate document names its windows {H0: 1, H1: 2}:
          // the "H2" window of the round brief is `horizon.H1` (value 2).
          DRRR: { catSurvive: drrrLabel?.catSurvive ?? null, window: recert.horizon?.H1 ?? null, horizonField: recert.horizon ?? null, cap: recert.cap ?? null, certificate: drrrLabel?.certificates?.[0]?.verified ?? null, recomputed: false },
          UURR: { mouseForcedWin: uerrLabel?.mouseForcedWin ?? null, recomputed: false },
          status: 'FROZEN_HISTORICAL_CERTIFICATE_OFFLINE_LABEL_ONLY',
        },
      },
      e1StaticAtFrontier: {
        UUDD: e1u, DUUD: e1d, DRRR: e1r,
        gapDuudMinusDrrr: e1GapDuudMinusDrrr,
        totalGapDuudMinusDrrr: e1d.total - e1r.total,
      },
      e1LeafAggregateGapAfterMouseTurn: d2duud.leafMeanContributions && d2drrr.leafMeanContributions
        ? Object.fromEntries(featureKeys.map((k) => [k, (d2duud.leafMeanContributions as Record<string, number>)[k] - (d2drrr.leafMeanContributions as Record<string, number>)[k]]))
        : null,
      limits: [
        'leafMeanContributions aggregate the VISITED leaves of a pruned alpha-beta tree with transposition lookups; they are not an exact expectation decomposition of the D2 value.',
        'static E1 at the frontier is a cat-perspective static score of a mouse-to-move state; it is not the D2 value and must not be merged with it.',
        'the H2 survival proof is a frozen finite-window certificate; it is not recomputed and not converted into any numeric input.',
        'no composite safety score is formed: spatial features, D2 expectation and the H2 label are reported side by side.',
      ],
      projectionSha256: null as string | null,
    };
    out.projectionSha256 = canonicalJson({ ...out, generatedAt: undefined, projectionSha256: undefined });

    writeJson(`${OUT}/EVALUATION_DECOMPOSITION.json`, out);
    console.log(`DUUD depth-1 value = ${d2duud.value} (frozen ${FROZEN_FORCED.duud}); DRRR = ${d2drrr.value} (frozen ${FROZEN_FORCED.drrr})`);
    console.log(`static E1 at frontier: DUUD ${e1d.total} DRRR ${e1r.total}`);
  });
});
