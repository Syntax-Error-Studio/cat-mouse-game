/// <reference types="node" />
/**
 * PPC-CAT-EVALUATOR-ABLATION-01 §7 — P6 performance aggregate. RESEARCH ONLY.
 *
 * Reads _raw/p6_eval_cost.json (§7.1) and every _raw/p6_search_{runId}.json
 * (§7.2/§7.3). Pre-registered design: 20 A/A pairs (aa_a_NN vs aa_b_NN, BOTH E1)
 * + 20 A/B pairs (ab_a_NN=E1 vs ab_b_NN=H1), each run a fresh process, serial.
 *
 *   §7.2 descriptive D1 search cost: all E1 runs vs all H1 runs, per-root mean.
 *   §7.3 A/A calibration: paired same-arm ratio → geometric mean + 95% CI. The
 *        CI MUST contain 1 (no systematic two-process bias); else the measurement
 *        noise floor is too high → PERFORMANCE BLOCKED (correctness evidence is
 *        NEVER fabricated or deleted to compensate).
 *   §7.3 A/B effect: paired H1/E1 ratio → geometric mean + 95% CI + per-root
 *        distribution.
 *
 * Ratios are elapsedMs(H1)/elapsedMs(E1) (>1 ⇒ H1 slower). NO production source
 * modified. NO gate relaxed; an A/A failure is reported as BLOCKED, not hidden.
 */
import { test, expect } from 'vitest';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { OUT, HEAD, rootIds } from './ablation_lib';

interface SearchRow { rootId: string; evaluator: string; elapsedMs: number; totalNodes: number; selectedAction: string; planString: string; completed: boolean }
interface SearchRun { runId: string; arm: string; depth: number; host: unknown; runWallMs: number; rows: SearchRow[] }

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const geomean = (xs: number[]) => Math.exp(mean(xs.map((x) => Math.log(x))));
const ci95 = (xs: number[]) => { const lr = xs.map((x) => Math.log(x)); const se = sd(lr) / Math.sqrt(xs.length); return [Math.exp(mean(lr) - 1.96 * se), Math.exp(mean(lr) + 1.96 * se)]; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pad = (i: number) => String(i).padStart(2, '0');

test('P6 §7 aggregate: eval self-cost + D1 search cost + A/A calibration + A/B effect', () => {
  const evalCost = JSON.parse(readFileSync(`${OUT}/_raw/p6_eval_cost.json`).toString('utf8'));
  const files = readdirSync(`${OUT}/_raw`).filter((f) => /^p6_search_.+\.json$/.test(f));
  const runs = new Map<string, SearchRun>();
  for (const f of files) {
    const r = JSON.parse(readFileSync(`${OUT}/_raw/${f}`).toString('utf8')) as SearchRun;
    runs.set(r.runId, r);
  }

  // ---- pre-registered pair set must be complete ----
  const PAIRS = 20;
  const missing: string[] = [];
  for (let i = 1; i <= PAIRS; i++) {
    for (const id of [`aa_a_${pad(i)}`, `aa_b_${pad(i)}`, `ab_a_${pad(i)}`, `ab_b_${pad(i)}`]) if (!runs.has(id)) missing.push(id);
  }
  expect(missing, `all ${PAIRS * 4} pre-registered runs must exist (missing: ${missing.join(',')})`).toHaveLength(0);

  const rowOf = (runId: string, rootId: string) => runs.get(runId)!.rows.find((r) => r.rootId === rootId)!;
  // arm integrity of the pair design
  for (let i = 1; i <= PAIRS; i++) {
    expect(runs.get(`aa_a_${pad(i)}`)!.arm).toBe('E1');
    expect(runs.get(`aa_b_${pad(i)}`)!.arm).toBe('E1');
    expect(runs.get(`ab_a_${pad(i)}`)!.arm).toBe('E1');
    expect(runs.get(`ab_b_${pad(i)}`)!.arm).toBe('H1');
  }

  // ---- §7.3 A/A calibration (both E1) ----
  const aaRatios: number[] = [];
  const aaPerRoot: Record<string, number[]> = {};
  for (const id of rootIds) aaPerRoot[id] = [];
  for (let i = 1; i <= PAIRS; i++) {
    for (const id of rootIds) {
      const a = rowOf(`aa_a_${pad(i)}`, id).elapsedMs;
      const b = rowOf(`aa_b_${pad(i)}`, id).elapsedMs;
      const ratio = b / a;
      aaRatios.push(ratio); aaPerRoot[id].push(ratio);
    }
  }
  const aaGM = geomean(aaRatios), aaCI = ci95(aaRatios);
  const aaCalibrationPass = aaCI[0] <= 1 && aaCI[1] >= 1;   // CI contains 1 ⇒ no systematic bias
  const aaNoiseSdLog = sd(aaRatios.map((x) => Math.log(x)));

  // ---- §7.3 A/B effect (E1 → H1) ----
  const abRatios: number[] = [];
  const abPerRoot: Record<string, number[]> = {};
  for (const id of rootIds) abPerRoot[id] = [];
  for (let i = 1; i <= PAIRS; i++) {
    for (const id of rootIds) {
      const a = rowOf(`ab_a_${pad(i)}`, id).elapsedMs;
      const b = rowOf(`ab_b_${pad(i)}`, id).elapsedMs;
      const ratio = b / a;
      abRatios.push(ratio); abPerRoot[id].push(ratio);
    }
  }
  const abGM = geomean(abRatios), abCI = ci95(abRatios);

  // ---- §7.2 descriptive search cost (all E1 runs vs all H1 runs) ----
  const e1Runs = [...runs.values()].filter((r) => r.arm === 'E1');
  const h1Runs = [...runs.values()].filter((r) => r.arm === 'H1');
  const descPerRoot = rootIds.map((id) => {
    const e1 = e1Runs.map((r) => r.rows.find((x) => x.rootId === id)!.elapsedMs);
    const h1 = h1Runs.map((r) => r.rows.find((x) => x.rootId === id)!.elapsedMs);
    return { rootId: id, e1MeanMs: mean(e1), h1MeanMs: mean(h1), e1Reps: e1.length, h1Reps: h1.length, ratioH1overE1: mean(h1) / mean(e1) };
  });
  const descGM = geomean(descPerRoot.map((d) => d.ratioH1overE1));

  // per-root A/B distribution
  const abPerRootDist = rootIds.map((id) => {
    const xs = abPerRoot[id];
    return { rootId: id, geometricMean: geomean(xs), median: median(xs), min: Math.min(...xs), max: Math.max(...xs), reps: xs.length };
  });

  const performanceVerdict = aaCalibrationPass ? 'CALIBRATED' : 'BLOCKED_AA_CALIBRATION';
  const doc = {
    artifactId: 'PERFORMANCE_RESULTS', round: OUT, phase: 7,
    generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p6_perf_aggregate.test.ts`,
    head: HEAD, productionSourceChanged: false,
    design: { aaPairs: PAIRS, abPairs: PAIRS, freshProcessPerRun: true, serial: true, depth: 1, protocol: 'faithful createSearchContext(rules,400000,TT,AB,ordering)+leafFor(arm), no wall-clock deadline' },
    evalSelfCost_7_1: evalCost.result,
    searchCost_7_2: { e1RunCount: e1Runs.length, h1RunCount: h1Runs.length, perRoot: descPerRoot, geometricMeanRatioH1overE1: descGM },
    aaCalibration_7_3: {
      ratios: aaRatios.length, geometricMean: aaGM, ci95: aaCI, noiseSdLog: aaNoiseSdLog,
      calibrationPass: aaCalibrationPass, verdict: aaCalibrationPass ? 'PASS (CI contains 1)' : 'FAIL (systematic two-process bias)',
      perRootGeometricMean: rootIds.map((id) => ({ rootId: id, gm: geomean(aaPerRoot[id]) })),
    },
    abEffect_7_3: {
      ratios: abRatios.length, geometricMean: abGM, ci95: abCI,
      h1Slower: abGM > 1, perRoot: abPerRootDist,
    },
    performanceVerdict,
    note: 'A/A FAIL ⇒ PERFORMANCE BLOCKED; correctness evidence (P2/P3/P4) is preserved unchanged, never fabricated or deleted. Ratios >1 ⇒ H1 slower.',
  };
  writeFileSync(`${OUT}/PERFORMANCE_RESULTS.json`, JSON.stringify(doc, null, 2));

  console.log(`[P6/7.1] eval self-cost ratioGM=${evalCost.result.ratioH1overE1.geometricMean.toFixed(4)} CI=[${evalCost.result.ratioH1overE1.ci95.map((x: number) => x.toFixed(4)).join(',')}]`);
  console.log(`[P6/7.2] descriptive search-cost ratioGM=${descGM.toFixed(4)} (E1 runs=${e1Runs.length}, H1 runs=${h1Runs.length})`);
  console.log(`[P6/7.3 A/A] GM=${aaGM.toFixed(4)} CI=[${aaCI.map((x) => x.toFixed(4)).join(',')}] noiseSdLog=${aaNoiseSdLog.toFixed(4)} calibration=${aaCalibrationPass ? 'PASS' : 'FAIL'}`);
  console.log(`[P6/7.3 A/B] GM=${abGM.toFixed(4)} CI=[${abCI.map((x) => x.toFixed(4)).join(',')}] h1Slower=${abGM > 1}`);
  console.log(`[P6] performanceVerdict=${performanceVerdict}`);

  // structural gates; calibration is REPORTED (a FAIL is a real BLOCKED verdict,
  // not a test failure that would delete the evidence).
  expect(aaRatios.length).toBe(PAIRS * 24);
  expect(abRatios.length).toBe(PAIRS * 24);
  expect(aaRatios.every((x) => x > 0 && Number.isFinite(x))).toBe(true);
  expect(abRatios.every((x) => x > 0 && Number.isFinite(x))).toBe(true);
}, 600_000);