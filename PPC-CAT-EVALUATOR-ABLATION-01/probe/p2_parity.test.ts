/// <reference types="node" />
/**
 * Phase 2 — H1 mathematical correctness audit (RESEARCH ONLY, no production edit).
 *
 * Proves H1 (evaluateCorrectedHoleForCat) introduces NO extra rule / feature / BFS.
 *
 * IMPORTANT FP honesty: the implementation is
 *     H1 = (total - oldHoleControl) + correctedHoleControlValue(bd, bs)
 * which is BIT-EXACT against itself. The algebraically REARRANGED forms
 *     both-reachable : H1 = E1 - 2*holeControl_E1
 *     single-sided   : H1 = E1
 * are exact in REAL arithmetic but can differ by <=1 ulp in IEEE754 because
 * `(total - h) - h` / `(total - h) + h` round differently from `total - 2h` /
 * `total`. This probe measures BOTH the implementation-exact identity (asserted
 * === 0) and the rearranged-form error (reported honestly, asserted only to be at
 * the ulp scale, never claimed bit-exact). The CONTRIBUTION-level sign flip is
 * asserted bit-exact (corrected === -old both-reachable; corrected === old single).
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { correctedHoleControlValue, correctedHoleEvalTotal } from '../../src/game/ai/correctedHoleLeaf';
import {
  ROUND, OUT, HEAD, FIXTURE, FROZEN_FIXTURE_SHA, rootIds, loadRoot,
  rules, stateKey, canonicalJson, sha256, evaluateForCat, evaluateForCatDetailed,
  evaluateCorrectedHoleForCat, resetEvaluationCalls, getEvaluationCalls,
  getMouseBfsCalls, getCatBfsCalls, getCarryMouseBfsCalls, type Arm,
} from './ablation_lib';
import type { GameEngineState } from '../../src/game/engine';
import type { EvaluationBreakdown } from '../../src/game/ai/evaluation';

const CORPUS_CAP = 8_000_000; // probe-only deterministic collection cap (never the 600k quantifier cap)
const CORPUS_PATH = `${OUT}/_raw/eval_corpus.json`;
const ULP_SCALE = 1e-9; // sanity bound: rearranged-form error must be FP rounding, not a semantic deviation

interface CorpusEntry { key: string; state: GameEngineState }

function collectCorpus() {
  const map = new Map<string, GameEngineState>();
  const perRoot: Record<string, { nodes: number; completed: boolean; uniqueLeaves: number }> = {};
  for (const id of rootIds) {
    const root = loadRoot(id);
    map.set(stateKey(root), root);
    const before = map.size;
    const ctx = createSearchContext(rules, CORPUS_CAP, false, false, false, 0, false);
    ctx.evalCache = undefined;
    ctx.leafEvaluator = (s: GameEngineState) => { const k = stateKey(s); if (!map.has(k)) map.set(k, s); return evaluateForCat(s); };
    const r = searchBestAction(root, 1, ctx);
    perRoot[id] = { nodes: r.diagnostics.nodes, completed: r.completed, uniqueLeaves: map.size - before };
    if (!r.completed) throw new Error(`corpus collection truncated at ${id} (nodes=${r.diagnostics.nodes})`);
  }
  const entries = [...map.entries()].map(([key, state]) => ({ key, state }));
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { entries, perRoot };
}

describe('Phase 2 H1 math parity', () => {
  it('frozen corpus: implementation-exact identity, sign-flip, no-extra-BFS, immutability, single-sided helper contract', () => {
    expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);
    const t0 = performance.now();
    const { entries, perRoot } = collectCorpus();

    let bothCount = 0, singleCount = 0;
    let implExactMaxErr = 0;          // H1 vs (total - old) + corrected  -> must be 0
    let signFlipMismatch = 0;          // corrected vs -old (both)         -> must be 0
    let rearrangedBothMaxErr = 0;      // H1 vs total - 2*old (both)       -> FP ulp, reported
    let nonFinite = 0, mutated = 0, nonDeterministic = 0, helperMismatch = 0;
    const failures: { key: string; reason: string }[] = [];
    const rearrangedExamples: { key: string; e1: number; h: number; h1: number; rearranged: number; err: number }[] = [];

    for (const { key, state } of entries) {
      const before = canonicalJson(state);
      const bd = evaluateForCatDetailed(state);
      const e1 = bd.total;
      const h = bd.contributions.holeControl;
      const h1 = evaluateCorrectedHoleForCat(state);
      const after = canonicalJson(state);
      if (before !== after) { mutated++; failures.push({ key, reason: 'STATE_MUTATED' }); }
      if (!Number.isFinite(e1) || !Number.isFinite(h1)) { nonFinite++; failures.push({ key, reason: 'NON_FINITE' }); }
      if (evaluateForCat(state) !== e1 || evaluateCorrectedHoleForCat(state) !== h1) { nonDeterministic++; failures.push({ key, reason: 'NON_DETERMINISTIC' }); }
      const bs = state.config.boardSize;
      const corrected = correctedHoleControlValue(bd, bs);
      // implementation-exact total (this IS the production formula)
      const implExact = (e1 - h) + corrected;
      if (h1 !== implExact) { helperMismatch++; failures.push({ key, reason: 'IMPL_EXACT_MISMATCH' }); }
      const ie = Math.abs(h1 - implExact); if (ie > implExactMaxErr) implExactMaxErr = ie;
      if (h1 !== correctedHoleEvalTotal(bd, bs)) { helperMismatch++; failures.push({ key, reason: 'HELPER_MISMATCH' }); }

      const both = bd.features.catHoleGateDistance !== null && bd.features.mouseHoleGateDistance !== null;
      if (both) {
        bothCount++;
        if (corrected !== -h) { signFlipMismatch++; failures.push({ key, reason: 'SIGN_FLIP_NOT_EXACT_NEGATION' }); }
        const rearranged = e1 - 2 * h;
        const err = Math.abs(h1 - rearranged);
        if (err > rearrangedBothMaxErr) rearrangedBothMaxErr = err;
        if (err !== 0 && rearrangedExamples.length < 12) rearrangedExamples.push({ key, e1, h, h1, rearranged, err });
      } else {
        singleCount++;
        if (corrected !== h) { signFlipMismatch++; failures.push({ key, reason: 'SINGLE_CONTRIBUTION_CHANGED' }); }
        if (h1 !== e1) failures.push({ key, reason: `SINGLE_TOTAL err=${Math.abs(h1 - e1)}` });
      }
    }

    // ---- single-sided branch contract on REAL breakdowns (pure-helper unit test) ----
    // The natural D1 corpus may contain 0 single-sided states; exercise the branch
    // by nullifying one gate distance on a COPY of a real breakdown (the helper is
    // a pure function of (breakdown, boardSize)). This verifies the documented
    // single-sided semantics: contribution unchanged; total may round by <=1 ulp.
    let singleHelperChecked = 0, singleContributionChanged = 0, singleTotalMaxErr = 0, singleTotalBitExact = 0;
    const sample = entries.slice(0, 400);
    for (const { state } of sample) {
      const bd = evaluateForCatDetailed(state);
      const bs = state.config.boardSize;
      for (const side of ['cat', 'mouse'] as const) {
        const copy: EvaluationBreakdown = JSON.parse(JSON.stringify(bd));
        if (side === 'cat') copy.features.catHoleGateDistance = null; else copy.features.mouseHoleGateDistance = null;
        const corrected = correctedHoleControlValue(copy, bs);
        const total = correctedHoleEvalTotal(copy, bs);
        singleHelperChecked++;
        if (corrected !== copy.contributions.holeControl) singleContributionChanged++;
        const err = Math.abs(total - copy.total);
        if (err > singleTotalMaxErr) singleTotalMaxErr = err;
        if (total === copy.total) singleTotalBitExact++;
      }
    }

    // ---- BFS / evaluation call counts: E1 vs H1 on the SAME corpus ----
    const countArm = (arm: Arm) => {
      resetEvaluationCalls();
      const fn = arm === 'E1' ? evaluateForCat : evaluateCorrectedHoleForCat;
      for (const { state } of entries) fn(state);
      return { evaluationCalls: getEvaluationCalls(), mouseBfsCalls: getMouseBfsCalls(), catBfsCalls: getCatBfsCalls(), carryMouseBfsCalls: getCarryMouseBfsCalls() };
    };
    const e1Counts = countArm('E1');
    const h1Counts = countArm('H1');
    const noExtraBfs = e1Counts.evaluationCalls === h1Counts.evaluationCalls
      && e1Counts.mouseBfsCalls === h1Counts.mouseBfsCalls
      && e1Counts.catBfsCalls === h1Counts.catBfsCalls
      && e1Counts.carryMouseBfsCalls === h1Counts.carryMouseBfsCalls;

    // ---- freeze corpus ----
    const serialized = entries.map(({ key, state }) => ({ key, state: JSON.parse(JSON.stringify(state)) }));
    const corpusKeysSha = sha256(entries.map((e) => e.key).join('\n'));
    writeFileSync(CORPUS_PATH, JSON.stringify({
      artifactId: 'EVAL_CORPUS', round: ROUND, generatedBy: `${OUT}/probe/p2_parity.test.ts`, head: HEAD,
      fixtureSha256: FROZEN_FIXTURE_SHA, protocol: 'deterministic AB-off D1 over 24 roots + roots, dedup by stateKey, sorted',
      corpusSize: entries.length, bothReachableCount: bothCount, singleSidedCount: singleCount,
      corpusKeysSha256: corpusKeysSha, perRoot, states: serialized,
    }));
    const restored = JSON.parse(readFileSync(CORPUS_PATH).toString('utf8')) as { states: { key: string; state: GameEngineState }[] };
    let roundTripMismatch = 0;
    for (let i = 0; i < restored.states.length; i++) {
      const rs = restoreHardRoot(restored.states[i].state as never);
      if (evaluateForCat(rs) !== evaluateForCat(entries[i].state) || evaluateCorrectedHoleForCat(rs) !== evaluateCorrectedHoleForCat(entries[i].state)) roundTripMismatch++;
    }

    const semanticParity = implExactMaxErr === 0 && signFlipMismatch === 0 && helperMismatch === 0
      && nonFinite === 0 && mutated === 0 && nonDeterministic === 0 && noExtraBfs && roundTripMismatch === 0
      && singleContributionChanged === 0 && failures.length === 0;

    const doc = {
      artifactId: 'H1_MATH_PARITY', round: ROUND, phase: 2,
      generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p2_parity.test.ts`, head: HEAD,
      fixtureSha256: FROZEN_FIXTURE_SHA, productionSourceChanged: false,
      definition: {
        E1: 'evaluateForCat(state) = evaluateForCatDetailed(state).total',
        H1: 'evaluateCorrectedHoleForCat(state) = correctedHoleEvalTotal(evaluateForCatDetailed(state), boardSize) = (total - oldHoleControl) + correctedHoleControlValue',
        noExtraFeature: 'H1 calls the SAME evaluateForCatDetailed once; only the both-reachable holeControl sign is flipped. No ghost/box/trap/tunnel/history/ValueNet term; no extra BFS.',
      },
      corpus: { path: CORPUS_PATH, corpusSize: entries.length, bothReachableCount: bothCount, singleSidedCount: singleCount, corpusKeysSha256: corpusKeysSha, collectionCap: CORPUS_CAP, perRoot },
      identity: {
        implementationExact: { statement: 'H1 === (E1 - holeControl_E1) + correctedHoleControlValue(bd,bs)', maxAbsError: implExactMaxErr, bitExact: implExactMaxErr === 0 },
        signFlip: { statement: 'both-reachable: correctedHoleControlValue === -holeControl_E1 ; single-sided: === holeControl_E1', mismatches: signFlipMismatch, bitExact: signFlipMismatch === 0 },
        rearrangedBothReachable: { statement: 'H1 = E1 - 2*holeControl_E1 (real-arithmetic identity)', maxAbsError: rearrangedBothMaxErr, bitExact: rearrangedBothMaxErr === 0, atUlpScale: rearrangedBothMaxErr < ULP_SCALE, examples: rearrangedExamples,
          explanation: 'IEEE754 operation order: implementation does (total - h) + (-h) = (total - h) - h (two roundings); the rearranged total - 2h does one rounding. Difference <= 1 ulp; NOT a semantic deviation, NOT a weight/feature change.' },
        singleSidedHelperContract: { statement: 'nullify one gate distance on a real breakdown copy => correctedHoleControlValue returns the UNCHANGED old contribution; total = (total - h) + h', checked: singleHelperChecked, contributionChanged: singleContributionChanged, contributionUnchangedBitExact: singleContributionChanged === 0, totalMaxAbsError: singleTotalMaxErr, totalBitExactCount: singleTotalBitExact, totalRearrangedAtUlpScale: singleTotalMaxErr < ULP_SCALE,
          explanation: 'Contribution is unchanged bit-exact (task requirement). The total can round by <=1 ulp because (total - h) + h != total in IEEE754 when h != 0 (single-sided h = +/-500).' },
      },
      callCounts: { E1: e1Counts, H1: h1Counts, noExtraBfs },
      invariants: { nonFinite, stateMutations: mutated, nonDeterministic, helperMismatch, roundTripMismatch, failureCount: failures.length, failures: failures.slice(0, 50) },
      staticSideEffectScan: {
        evaluationTs: 'no Math.random / Date.now / performance.now / console.* (counters write-only; L25 comment: never depends on search-path info)',
        correctedHoleLeafTs: 'pure arithmetic over the breakdown; no random / time / logging / fs / fetch',
        determinismEmpirical: nonDeterministic === 0,
      },
      verdict: {
        H1_MATH_PARITY: semanticParity ? 'PASS' : 'FAIL',
        SINGLE_SIDED_PARITY: singleContributionChanged === 0 ? 'PASS' : 'FAIL',
        NO_EXTRA_BFS: noExtraBfs ? 'PASS' : 'FAIL',
        STATE_IMMUTABILITY: mutated === 0 ? 'PASS' : 'FAIL',
        rearrangedIdentitiesBitExact: rearrangedBothMaxErr === 0 && singleTotalMaxErr === 0,
        fpRoundingCaveat: 'The literal rearranged identities (E1-2h / E1) are NOT guaranteed bit-exact in IEEE754; the implementation-exact identity and the contribution-level sign flip ARE bit-exact. Max rearranged error reported above (ulp scale).',
        naturalSingleSidedCoverage: singleCount > 0 ? 'PRESENT' : 'ABSENT_IN_D1_CORPUS (branch verified by pure-helper contract test on real breakdowns + source)',
      },
      elapsedMs: Math.round(performance.now() - t0),
    };
    writeFileSync(`${OUT}/H1_MATH_PARITY.json`, JSON.stringify(doc, null, 2));

    console.log('CORPUS size=', entries.length, 'both=', bothCount, 'single=', singleCount);
    console.log('implExactMaxErr=', implExactMaxErr, 'signFlipMismatch=', signFlipMismatch, 'helperMismatch=', helperMismatch);
    console.log('rearrangedBothMaxErr=', rearrangedBothMaxErr, 'bitExact=', rearrangedBothMaxErr === 0, 'examples=', rearrangedExamples.length);
    console.log('singleHelper checked=', singleHelperChecked, 'contributionChanged=', singleContributionChanged, 'totalMaxErr=', singleTotalMaxErr, 'totalBitExact=', singleTotalBitExact);
    console.log('E1 counts=', JSON.stringify(e1Counts), 'H1 counts=', JSON.stringify(h1Counts), 'noExtraBfs=', noExtraBfs);
    console.log('mutated=', mutated, 'nonFinite=', nonFinite, 'nonDeterministic=', nonDeterministic, 'roundTripMismatch=', roundTripMismatch, 'failures=', failures.length);
    console.log('VERDICT=', JSON.stringify(doc.verdict));

    // bit-exact assertions on the IMPLEMENTATION-EXACT identity + contribution sign flip
    expect(implExactMaxErr, 'implementation-exact identity must be bit-exact').toBe(0);
    expect(signFlipMismatch, 'contribution sign flip must be bit-exact').toBe(0);
    expect(helperMismatch).toBe(0);
    expect(noExtraBfs, 'H1 must not add any BFS / evaluation call').toBe(true);
    expect(mutated).toBe(0);
    expect(nonFinite).toBe(0);
    expect(nonDeterministic).toBe(0);
    expect(roundTripMismatch).toBe(0);
    expect(singleContributionChanged, 'single-sided contribution must be unchanged').toBe(0);
    expect(bothCount).toBeGreaterThan(0);
    expect(failures.length, JSON.stringify(failures.slice(0, 10))).toBe(0);
    // rearranged forms: only assert ulp-scale (honest FP rounding), never claim bit-exact
    expect(rearrangedBothMaxErr).toBeLessThan(ULP_SCALE);
    expect(singleTotalMaxErr).toBeLessThan(ULP_SCALE);
  }, 3_600_000);
});