/// <reference types="node" />
/**
 * PPC-CAT-EVALUATOR-ABLATION-01 §7.1 — evaluator SELF cost on the SAME frozen
 * corpus (P6, wall-clock). RESEARCH ONLY; no production source modified.
 *
 * Isolates the pure evaluator cost (NO search): the 1517 dedup'd both-reachable
 * states frozen by P2 (_raw/eval_corpus.json, corpusKeysSha256 bound) are each
 * restored via restoreHardRoot and evaluated by E1=evaluateForCat and
 * H1=evaluateCorrectedHoleForCat. P2 proved H1 makes the SAME single
 * evaluateForCatDetailed call (no extra BFS), so the self-cost ratio is expected
 * ~1; this MEASURES it honestly rather than assuming it.
 *
 * Method: R corpus-pass reps, arm order INTERLEAVED (even rep E1-first, odd rep
 * H1-first) to cancel thermal/drift bias. Each pass times 1517 calls as a BATCH
 * (well above timer resolution); per-call cost = passMs/1517. Ratio_r =
 * H1pass/E1pass; report geometric mean + 95% CI (log-ratio, normal approx R>=30)
 * + the raw per-rep ratios. A VALUE determinism check guards against timing
 * masking a semantic change. Host snapshot recorded for provenance.
 *
 * GATED: this is a wall-clock experiment — run only on a quiescent host (re-probe
 * census first). NO heap enlargement, NO rep reduction to manufacture a result.
 */
import { test, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import {
  OUT, HEAD, sha256, evaluateForCat, evaluateCorrectedHoleForCat,
} from './ablation_lib';
import type { GameEngineState } from '../../src/game/engine';

const CORPUS_PATH = `${OUT}/_raw/eval_corpus.json`;
const REPS = Number(process.env.ABLATION_EVAL_REPS ?? '40');
const corpusDoc = JSON.parse(readFileSync(CORPUS_PATH).toString('utf8')) as {
  corpusSize: number; corpusKeysSha256: string; states: { key: string; state: GameEngineState }[];
};

const geomean = (xs: number[]) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };

test('P6 §7.1 evaluator self-cost on the frozen corpus (E1 vs H1)', () => {
  expect(corpusDoc.corpusSize).toBe(1517);
  expect(corpusDoc.states.length).toBe(1517);
  const states = corpusDoc.states.map((s) => restoreHardRoot(s.state as never));
  const n = states.length;

  // value determinism guard (timing must not mask a semantic change)
  for (let i = 0; i < n; i += 97) {
    const a = evaluateForCat(states[i]);
    const b = evaluateForCat(states[i]);
    expect(a).toBe(b);
    expect(Number.isFinite(evaluateCorrectedHoleForCat(states[i]))).toBe(true);
  }

  // warmup (JIT) — discard
  for (const s of states) { evaluateForCat(s); evaluateCorrectedHoleForCat(s); }

  const e1Ms: number[] = [], h1Ms: number[] = [], ratios: number[] = [];
  for (let r = 0; r < REPS; r++) {
    const e1First = r % 2 === 0;
    let e1 = 0, h1 = 0;
    const timeE1 = () => { const t = performance.now(); for (const s of states) evaluateForCat(s); return performance.now() - t; };
    const timeH1 = () => { const t = performance.now(); for (const s of states) evaluateCorrectedHoleForCat(s); return performance.now() - t; };
    if (e1First) { e1 = timeE1(); h1 = timeH1(); } else { h1 = timeH1(); e1 = timeE1(); }
    e1Ms.push(e1); h1Ms.push(h1); ratios.push(h1 / e1);
  }

  const lr = ratios.map((x) => Math.log(x));
  const gm = geomean(ratios);
  const se = sd(lr) / Math.sqrt(REPS);
  const ciLo = Math.exp(mean(lr) - 1.96 * se), ciHi = Math.exp(mean(lr) + 1.96 * se);
  const e1PerCallNs = (mean(e1Ms) / n) * 1e6;
  const h1PerCallNs = (mean(h1Ms) / n) * 1e6;

  const doc = {
    artifactId: 'P6_EVAL_SELF_COST', round: OUT, phase: '7.1',
    generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p6_eval_cost.test.ts`,
    head: HEAD, productionSourceChanged: false,
    corpus: { path: CORPUS_PATH, corpusSize: n, corpusKeysSha256: corpusDoc.corpusKeysSha256 },
    method: { reps: REPS, interleave: 'even rep E1-first, odd rep H1-first', timing: 'batch corpus-pass (1517 calls)', ci: '95% log-ratio normal approx' },
    host: { freeMemMB: Math.round(os.freemem() / 1048576), totalMemMB: Math.round(os.totalmem() / 1048576), loadavg: os.loadavg(), platform: process.platform, node: process.version },
    result: {
      e1PassMs: { mean: mean(e1Ms), sd: sd(e1Ms), min: Math.min(...e1Ms), max: Math.max(...e1Ms) },
      h1PassMs: { mean: mean(h1Ms), sd: sd(h1Ms), min: Math.min(...h1Ms), max: Math.max(...h1Ms) },
      e1PerCallNs, h1PerCallNs,
      ratioH1overE1: { geometricMean: gm, ci95: [ciLo, ciHi], raw: ratios },
      h1SlowerReps: ratios.filter((x) => x > 1).length,
    },
  };
  mkdirSync(`${OUT}/_raw`, { recursive: true });
  writeFileSync(`${OUT}/_raw/p6_eval_cost.json`, JSON.stringify(doc, null, 2));
  console.log(`[P6/7.1] reps=${REPS} n=${n} E1=${e1PerCallNs.toFixed(1)}ns/call H1=${h1PerCallNs.toFixed(1)}ns/call ratioGM=${gm.toFixed(4)} CI95=[${ciLo.toFixed(4)},${ciHi.toFixed(4)}] h1SlowerReps=${doc.result.h1SlowerReps}/${REPS}`);

  // structural gates only — the ratio is MEASURED, never asserted to 1.
  expect(ratios.length).toBe(REPS);
  expect(ratios.every((x) => x > 0 && Number.isFinite(x))).toBe(true);
  expect(Number.isFinite(gm)).toBe(true);
}, 600_000);