/// <reference types="node" />
/**
 * G1 — cache-contract final errata, recomputed from the frozen 110-plan set.
 *
 * Two implementations are compared on the SAME real plan:
 *   production  planQuality.countRevisits / planQualityForPaths (root + full
 *               action path + rules; final CHANCE hand-off cell INCLUDED;
 *               requires all positive-probability outcomes to agree on the
 *               final cat cell; boundary value = weighted expectation).
 *   research    css_lib.features (root + action path parsed until the CHANCE
 *               boundary; final cat cell EXCLUDED; end fields read
 *               outcomes[0]).
 */
import { describe, it, expect } from 'vitest';
import {
  ROUND, writeJson, enumerateRoot, countRevisits, features, endStatesOf,
  stateKey, rules, applyNoMoveLoss, generatePreparedSearchActions,
} from './dr_lib';
import { planLabel } from './dr_lib';
import type { GameEngineState } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { GamePhase, PieceType } from '../../src/game/types';

const cell = (s: GameEngineState) => `${s.catPosition.r},${s.catPosition.c}`;

/** Cells collected exactly as planQuality.countRevisits does. */
function productionCells(root: GameEngineState, plan: SearchAction[]): { cells: string[]; finalCatMoveIncluded: boolean } {
  const cells = [cell(root)];
  let cur = applyNoMoveLoss(root);
  let finalCatMoveIncluded = false;
  for (const a of plan) {
    const prepared = generatePreparedSearchActions(cur, rules);
    const hit = prepared.find((p) => planLabel([p.action]) === planLabel([a]));
    if (!hit) throw new Error('illegal plan');
    const t = hit.transition;
    if (t.kind === 'chance') {
      const outs = t.outcomes.filter((o) => o.weight > 0);
      const c = new Set(outs.map((o) => cell(o.state)));
      if (c.size === 1) {
        const only = [...c][0];
        if (only !== cells[cells.length - 1]) { cells.push(only); finalCatMoveIncluded = true; }
      }
      break;
    }
    cur = t.state;
    if (cell(cur) !== cells[cells.length - 1]) cells.push(cell(cur));
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return { cells, finalCatMoveIncluded };
}

/** Cells collected exactly as css_lib.features does. */
function researchCells(root: GameEngineState, plan: SearchAction[]): string[] {
  const cells = [cell(root)];
  let cur = applyNoMoveLoss(root);
  for (const a of plan) {
    const prepared = generatePreparedSearchActions(cur, rules);
    const hit = prepared.find((p) => planLabel([p.action]) === planLabel([a]));
    if (!hit) throw new Error('illegal plan');
    const t = hit.transition;
    if (t.kind === 'chance') break;
    cur = t.state;
    if (cell(cur) !== cells[cells.length - 1]) cells.push(cell(cur));
  }
  return cells;
}

const dup = (xs: string[]) => xs.length - new Set(xs).size;

describe('G1 cache contract final errata', () => {
  it('recomputes the frozen 110-plan agreement table bit-for-bit', () => {
    const { root, turns } = enumerateRoot('G6T2');
    expect(turns.length).toBe(110);

    let agree = 0;
    let chanceDiff = 0;
    const diffs: Record<string, unknown>[] = [];
    const endKindDist: Record<string, number> = {};
    const prodDist: Record<number, number> = {};
    const cssDist: Record<number, number> = {};
    let prodMax = 0;

    let uniqueDeltas: Record<string, number> = {};
    for (const t of turns) {
      const p = {
        revisit: countRevisits(root, t.plan, rules),
        endKind: t.endKind,
      };
      const f = features(root, t);
      const prodUnique = new Set(productionCells(root, t.plan).cells).size - 1;
      uniqueDeltas = { ...uniqueDeltas, [String(prodUnique - f.uniqueProgress)]: (uniqueDeltas[String(prodUnique - f.uniqueProgress)] ?? 0) + 1 };
      endKindDist[t.endKind] = (endKindDist[t.endKind] ?? 0) + 1;
      prodDist[p.revisit] = (prodDist[p.revisit] ?? 0) + 1;
      cssDist[f.revisitCount] = (cssDist[f.revisitCount] ?? 0) + 1;
      prodMax = Math.max(prodMax, p.revisit);
      const same = p.revisit === f.revisitCount && (new Set(researchCells(root, t.plan)).size - 1) === f.uniqueProgress;
      if (same) agree++;
      else {
        if (t.endKind === 'chance') chanceDiff++;
        diffs.push({
          plan: t.labels, endKind: t.endKind,
          productionRevisit: p.revisit, researchRevisit: f.revisitCount,
          delta: p.revisit - f.revisitCount,
        });
      }
    }

    const out = {
      round: ROUND,
      phase: 'G1_CACHE_CONTRACT_RECOMPUTE',
      plans: turns.length,
      agree,
      disagree: diffs.length,
      disagreeChanceEndKind: chanceDiff,
      endKindDistribution: endKindDist,
      productionRevisitDistribution: prodDist,
      researchRevisitDistribution: cssDist,
      productionRevisitMax: prodMax,
      uniqueProgressDeltaDistribution: uniqueDeltas,
      diffs,
      frozenReference: {
        agree: 67, disagree: 43, allChance: true, deltaPlusOne: true,
        productionDistribution: { 0: 36, 1: 44, 2: 27, 3: 3 },
        researchDistribution: { 0: 56, 1: 44, 2: 10 },
      },
      verdict: agree === 67 && diffs.length === 43 && chanceDiff === 43
        ? 'FROZEN_67_43_REPRODUCED'
        : 'MISMATCH_STOP',
    };
    writeJson(`${ROUND}/logs/g1_recompute.json`, out);

    expect(agree).toBe(67);
    expect(diffs.length).toBe(43);
    expect(chanceDiff).toBe(43);
    expect(diffs.every((d) => d.delta === 1)).toBe(true);
    expect(prodDist).toEqual({ 0: 36, 1: 44, 2: 27, 3: 3 });
    expect(cssDist).toEqual({ 0: 56, 1: 44, 2: 10 });
  });

  it('proves the final cat move inclusion/un-inclusion per implementation', () => {
    const { root, turns } = enumerateRoot('G6T2');
    let prodIncludes = 0;
    let researchIncludes = 0;
    let prodCellsEqualsResearchPlusFinal = 0;
    const samples: Record<string, unknown>[] = [];

    for (const t of turns) {
      const prod = productionCells(root, t.plan);
      const res = researchCells(root, t.plan);
      if (prod.finalCatMoveIncluded) prodIncludes++;
      const endStates = endStatesOf(root, t.plan).states;
      const finalCell = cell(endStates[0]);
      // Where the cat stood immediately BEFORE the final (chance) action.
      let cur = applyNoMoveLoss(root);
      for (let i = 0; i < t.plan.length - 1; i++) {
        const prepared = generatePreparedSearchActions(cur, rules);
        const hit = prepared.find((p) => planLabel([p.action]) === planLabel([t.plan[i]]));
        if (!hit) throw new Error('illegal');
        cur = hit.transition.state;
      }
      const lastDetCell = cell(cur);
      const resIncludesFinal = lastDetCell === finalCell;
      if (resIncludesFinal) researchIncludes++;
      const expected = prod.finalCatMoveIncluded ? [...res, finalCell] : res;
      if (JSON.stringify(prod.cells) === JSON.stringify(expected)) prodCellsEqualsResearchPlusFinal++;
      if (samples.length < 3 || ['UURR', 'DRRR', 'DUUD'].includes(t.labels)) {
        samples.push({
          plan: t.labels, endKind: t.endKind,
          productionCells: prod.cells, researchCells: res, finalCell,
          productionIncludesFinalCatMove: prod.finalCatMoveIncluded,
          researchIncludesFinalCatMove: resIncludesFinal,
        });
      }
    }

    const out = {
      plans: turns.length,
      productionIncludesFinalCatMove: prodIncludes,
      researchIncludesFinalCatMove: researchIncludes,
      productionCellsEqualResearchPlusFinal: prodCellsEqualsResearchPlusFinal,
      samplePlans: samples,
      semantics: {
        production: 'FINAL_CAT_MOVE_INCLUDED (chance hand-off cell appended when all outcomes agree)',
        research: 'FINAL_CAT_MOVE_EXCLUDED (loop stops before the chance hand-off cell)',
      },
    };
    writeJson(`${ROUND}/logs/g1_inclusion.json`, out);

    // Every G6T2 plan ends in a chance hand-off that moves the cat on the last
    // step, so production appends the final cell for all 110 plans. The cell is
    // NEW in 67 paths (revisit unchanged, uniqueProgress +1) and a DUPLICATE in
    // 43 paths (revisit +1) — which is exactly the frozen 67/43 table.
    expect(prodIncludes).toBe(110);
    expect(researchIncludes).toBe(0);
    expect(prodCellsEqualsResearchPlusFinal).toBe(110);
  });

  it('registers the CHANCE endpoint difference independently of the revisit diff', () => {
    const { root, turns } = enumerateRoot('G6T2');
    let multiOutcome = 0;
    let outcomeCellsDisagree = 0;
    let outcomeKeysDisagree = 0;
    const rows: Record<string, unknown>[] = [];
    for (const t of turns) {
      let cur = applyNoMoveLoss(root);
      let chance = null as null | { st: GameEngineState[]; w: number[] };
      for (let i = 0; i < t.plan.length; i++) {
        const prepared = generatePreparedSearchActions(cur, rules);
        const hit = prepared.find((p) => planLabel([p.action]) === planLabel([t.plan[i]]));
        if (!hit) throw new Error('illegal');
        const tr = hit.transition;
        if (tr.kind === 'chance') {
          chance = {
            st: tr.outcomes.filter((o) => o.weight > 0).map((o) => applyNoMoveLoss(o.state)),
            w: tr.outcomes.filter((o) => o.weight > 0).map((o) => o.weight),
          };
          break;
        }
        cur = tr.state;
      }
      if (!chance) { rows.push({ plan: t.labels, chance: false }); continue; }
      const cells = new Set(chance.st.map(cell));
      const keys = new Set(chance.st.map((s) => stateKey(s)));
      if (chance.st.length > 1) multiOutcome++;
      if (cells.size > 1) outcomeCellsDisagree++;
      if (keys.size > 1) outcomeKeysDisagree++;
      rows.push({
        plan: t.labels, chance: true, outcomes: chance.st.length,
        weights: chance.w, cellAgreement: cells.size === 1, keyAgreement: keys.size === 1,
        researchEndReads: 'outcomes[0]', productionEndReads: 'weighted expectation over all outcomes',
      });
    }
    const out = {
      plans: turns.length,
      plansEndingInChance: rows.filter((r) => r.chance).length,
      plansWithMultiplePositiveOutcomes: multiOutcome,
      plansWithDisagreeingOutcomeCells: outcomeCellsDisagree,
      plansWithDisagreeingOutcomeStateKeys: outcomeKeysDisagree,
      issue: 'CHANCE_ENDPOINT_SEMANTICS',
      registration: 'Independent of revisit/uniqueProgress: 43/110 plans differ only because the final hand-off cell is included in production and excluded in the research feature; endpoint fields must never read outcomes[0].',
      rows,
    };
    writeJson(`${ROUND}/logs/g1_chance_endpoint.json`, out);
    expect(out.plansEndingInChance).toBe(110);
    expect(outcomeCellsDisagree).toBe(0);
  });
});