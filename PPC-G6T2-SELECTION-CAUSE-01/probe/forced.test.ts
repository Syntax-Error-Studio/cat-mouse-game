/// <reference types="node" />
/**
 * PPC-G6T2-SELECTION-CAUSE-01 / G3 — forced DRRR vs D2-chosen DUUD.
 *
 * For each plan: force the four cat steps through the REAL transition, keep ALL
 * positive-probability CHANCE successors, then evaluate every mouse frontier
 * with the SAME E1 leaf evaluator and the SAME remaining depth (1 turn — the
 * depth the D2 search itself uses at that boundary). The conditional
 * expectation is compared only after the DUUD baseline is shown comparable to
 * the frozen D2 branch score. H2 (600000) is a frozen label and H1/5000 stays
 * UNRESOLVED; neither is mixed into this expectation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  OUT, ROOT_ID, ARM, DEPTH_TURNS, FROZEN_D2,
  loadRoot, detail, makeCtx, writeJson, ensureDirs, label, generatePreparedSearchActions,
} from './sc_lib';
import { searchBestAction } from '../../src/game/ai/expectiminimax';
import { rules } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import { stateKey } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import type { GameEngineState } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';

const REM_DEPTH = 1; // depthTurns at the mouse node inside a root-depth-2 search
const REL_TOL = 1e-9;

interface StepView {
  step: number; label: string; type: string; kind: string;
  branchCount: number; probabilitySum: number;
  branches: { fromKey: string; weightIn: number; cat: string; mouse: string; outcomes: { weight: number; key: string; player: string; cat: string; mouse: string; catMovesLeft: number; mouseMovesLeft: number }[] }[];
}
interface ForcedResult {
  plan: string;
  ok: boolean;
  failure: string | null;
  steps: StepView[];
  frontier: { key: string; weight: number; player: string; catMovesLeft: number; detailReturned: ReturnType<typeof detail> }[];
  valuePerFrontier: { key: string; weight: number; value: number; mate: string | null; completed: boolean; nodes: number }[];
  conditionalExpectation: number | null;
  completed: boolean;
}

function forcePlan(planLabels: string[]): ForcedResult {
  const root = loadRoot();
  let frontier: { state: GameEngineState; weight: number }[] = [{ state: root, weight: 1 }];
  const steps: StepView[] = [];
  for (let i = 0; i < planLabels.length; i++) {
    const lab = planLabels[i];
    const next: { state: GameEngineState; weight: number }[] = [];
    const branches: StepView['branches'] = [];
    let probSum = 0;
    let kind = '';
    let type = '';
    for (const f of frontier) {
      const prepared = generatePreparedSearchActions(f.state, rules);
      const hits = prepared.filter((p) => label(p.action) === lab);
      if (hits.length !== 1) {
        return { plan: planLabels.join(''), ok: false, failure: `step ${i} ${lab}: ${hits.length} matches`, steps, frontier: [], valuePerFrontier: [], conditionalExpectation: null, completed: false };
      }
      const hit = hits[0];
      const tr = hit.transition;
      kind = tr.kind;
      type = hit.action.type;
      const kids = tr.kind === 'chance'
        ? tr.outcomes.map((o) => ({ state: o.state, weight: o.weight as number }))
        : [{ state: tr.state, weight: 1 }];
      const outcomes: StepView['branches'][number]['outcomes'] = [];
      for (const k of kids) {
        probSum += k.weight;
        next.push({ state: k.state, weight: f.weight * k.weight });
        outcomes.push({
          weight: k.weight, key: stateKey(k.state), player: String(k.state.currentPlayer),
          cat: `${k.state.catPosition.r},${k.state.catPosition.c}`,
          mouse: `${k.state.mousePosition.r},${k.state.mousePosition.c}`,
          catMovesLeft: k.state.catMovesLeft, mouseMovesLeft: k.state.mouseMovesLeft,
        });
      }
      branches.push({
        fromKey: stateKey(f.state), weightIn: f.weight,
        cat: `${f.state.catPosition.r},${f.state.catPosition.c}`,
        mouse: `${f.state.mousePosition.r},${f.state.mousePosition.c}`,
        outcomes,
      });
    }
    frontier = next;
    steps.push({
      step: i, label: lab, type, kind, branchCount: next.length,
      probabilitySum: Number(probSum.toFixed(12)), branches,
    });
  }

  // Every frontier must be the real mouse boundary of a completed cat turn.
  for (const f of frontier) {
    if (f.state.currentPlayer !== 'mouse' || f.state.catMovesLeft > 0) {
      return { plan: planLabels.join(''), ok: false, failure: 'frontier is not a mouse turn after a full cat turn', steps, frontier: [], valuePerFrontier: [], conditionalExpectation: null, completed: false };
    }
  }

  const valuePerFrontier = frontier.map((f) => {
    const res = searchBestAction(f.state, REM_DEPTH, makeCtx(true));
    return {
      key: stateKey(f.state), weight: f.weight,
      value: res.value, mate: res.mate, completed: res.completed,
      nodes: res.diagnostics.nodes,
    };
  });
  const completed = valuePerFrontier.every((v) => v.completed);
  const expectation = valuePerFrontier.reduce((acc, v) => acc + v.weight * v.value, 0);
  return {
    plan: planLabels.join(''), ok: true, failure: null, steps,
    frontier: frontier.map((f) => ({ key: stateKey(f.state), weight: f.weight, player: String(f.state.currentPlayer), catMovesLeft: f.state.catMovesLeft, detailReturned: detail(f.state) })),
    valuePerFrontier, conditionalExpectation: completed ? expectation : null, completed,
  };
}

describe('G3 forced plan comparison', () => {
  it('compares forced DUUD and DRRR at the same remaining depth', () => {
    ensureDirs();
    const duud = forcePlan(['D', 'U', 'U', 'D']);
    const drrr = forcePlan(['D', 'R', 'R', 'R']);
    expect(duud.ok).toBe(true);
    expect(drrr.ok).toBe(true);
    expect(duud.completed).toBe(true);
    expect(drrr.completed).toBe(true);

    // D2 frozen branch score for the shared first step D.
    const priorPath = `${OUT}/D2_CHILD_VALUE_AUDIT.json`;
    const audit = existsSync(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf8')) : null;
    const dNodeU = audit?.childValueEvidence?.afterD?.U ?? null;
    const dNodeR = audit?.childValueEvidence?.afterD?.R ?? null;
    const d2RootD = audit?.search?.rootValues?.find((r: { label: string }) => r.label === 'D')?.value
      ?? FROZEN_D2.value;

    const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
    const baseline = {
      forcedDuud: duud.conditionalExpectation,
      frozenRootActionD: d2RootD,
      relativeDifference: duud.conditionalExpectation === null ? null : rel(duud.conditionalExpectation, d2RootD),
      exactEquality: duud.conditionalExpectation === d2RootD,
    };
    const comparable = duud.conditionalExpectation !== null
      && rel(duud.conditionalExpectation, d2RootD) <= REL_TOL;

    const sameContext = {
      source: 'D2_CHILD_VALUE_AUDIT (values inside the single root search)',
      afterD_U: dNodeU, afterD_R: dNodeR,
      deltaUminusR: dNodeU && dNodeR ? dNodeU.value - dNodeR.value : null,
      uEqualsRExactly: dNodeU !== null && dNodeR !== null && dNodeU.value === dNodeR.value,
    };

    const valueComparison = comparable
      ? {
        status: 'COMPARABLE',
        forcedDuud: duud.conditionalExpectation,
        forcedDrrr: drrr.conditionalExpectation,
        deltaDrrrMinusDuud: drrr.conditionalExpectation! - duud.conditionalExpectation!,
        drrrBetterUnderE1: drrr.conditionalExpectation! > duud.conditionalExpectation! + REL_TOL * Math.max(1, Math.abs(duud.conditionalExpectation!)),
        drrrWorseUnderE1: drrr.conditionalExpectation! < duud.conditionalExpectation! - REL_TOL * Math.max(1, Math.abs(duud.conditionalExpectation!)),
      }
      : {
        status: 'NOT_COMPARABLE',
        reason: 'forced DUUD baseline does not align with the frozen D2 branch score; per the round rules the value comparison stops here',
      };

    const payload = {
      round: OUT,
      phase: 'G3_FORCED_PLAN_COMPARISON',
      generatedAt: new Date().toISOString(),
      rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS,
      method: {
        forcedPrefix: 'real rules, all four cat steps, all positive-probability CHANCE successors retained',
        frontierEvaluation: 'searchBestAction(mouseState, 1, ctx) with the SAME E1 leaf evaluator (evaluateForCat) and no TT/ordering/alpha-beta, matching the boundary depth used inside the D2 root search',
        depthRationale: 'the D2 search switches to the mouse at depthTurns 2 -> 1 after the cat turn; the frontier node is searched there, not at depth 2',
        remainingDepth: REM_DEPTH,
        relativeTolerance: REL_TOL,
      },
      baselineCheck: baseline,
      comparable,
      sameContextSelectionEvidence: sameContext,
      valueComparison,
      duud,
      drrr,
      labelSeparation: {
        d2ExpectedValue: 'valueComparison.forced* (this file)',
        h2CatSurvivalCertificate: {
          source: 'PPC-CAT-STRATEGY-SEAL-01/G6T2_RECERTIFICATION.json (frozen positive control, NOT re-run)',
          horizon: 'H2', cap: 600000, status: 'PROVEN for DRRR', note: 'a survival proof, not a numeric score, and never mixed into the expectation',
        },
        h1Status: { horizon: 'H1', cap: 5000, status: 'UNRESOLVED for every plan', note: 'not evidence of anything and not mixed in' },
      },
    };
    writeJson(`${OUT}/FORCED_PLAN_COMPARISON.json`, payload);

    console.log('--- G3 FORCED COMPARISON ---');
    console.log('forced DUUD =', duud.conditionalExpectation, 'frontier=', duud.frontier.map((f) => f.key.slice(0, 16)));
    console.log('forced DRRR =', drrr.conditionalExpectation, 'frontier=', drrr.frontier.map((f) => f.key.slice(0, 16)));
    console.log('frozen root D =', d2RootD, 'relDiff =', baseline.relativeDifference, 'comparable =', comparable);
    console.log('same-context D-node U =', dNodeU?.value, 'R =', dNodeR?.value, 'delta =', sameContext.deltaUminusR);
    console.log('comparison:', JSON.stringify(valueComparison));
    console.log('--- END ---');

    expect(comparable).toBe(true);
  });
});