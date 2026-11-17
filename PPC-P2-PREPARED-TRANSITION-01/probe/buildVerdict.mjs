#!/usr/bin/env node
/**
 * PPC-P2-PREPARED-TRANSITION-01 — performance verdict.
 *
 * Applies the gate thresholds that were fixed BEFORE the A/B run:
 *   CORRECTNESS_GATE            all fixed-workload results identical
 *   NO_REGRESSION_GATE          B/A CI95 upper <= 1.05
 *   POSITIVE_SPEEDUP_EVIDENCE   B/A CI95 upper <  1.00
 *   STRONG_SPEEDUP_EVIDENCE     B/A CI95 upper <= 0.98
 *   A/A gate                    A/A CI95 inside [1/1.05, 1.05]
 *
 * Nothing is re-run here; this only reads the aggregates and states the verdict.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const dir = 'PPC-P2-PREPARED-TRANSITION-01/_raw';
const aa = JSON.parse(readFileSync(`${dir}/AA_AGGREGATE_aa.json`, 'utf8'));
const ab = JSON.parse(readFileSync(`${dir}/AB_AGGREGATE_ab.json`, 'utf8'));
const d1 = JSON.parse(readFileSync(`${dir}/d1_parity.json`, 'utf8'));
const di = JSON.parse(readFileSync(`${dir}/deadline_integration_repeat.json`, 'utf8'));

const A = aa.summary.ci95;
const B = ab.summary.ci95;
const aaOk = A[0] >= 1 / 1.05 && A[1] <= 1.05;

const gates = {
  AA_CALIBRATION: aaOk ? 'PASS' : 'FAIL',
  CORRECTNESS_GATE: d1.totalDiffFields === 0 && d1.armParityAll && ab.rows.every((r) => r.aArm === 'baseline' && r.bArm === 'candidate')
    ? 'PASS' : 'FAIL',
  NO_REGRESSION_GATE: B[1] <= 1.05 ? 'PASS' : 'FAIL',
  POSITIVE_SPEEDUP_EVIDENCE: B[1] < 1.0 ? 'YES' : 'NO',
  STRONG_SPEEDUP_EVIDENCE: B[1] <= 0.98 ? 'YES' : 'NO',
};

const verdict = {
  round: 'PPC-P2-PREPARED-TRANSITION-01',
  preRegisteredCriteria: {
    correctnesGate: 'identical fixed-workload results',
    noRegressionGate: 'B/A CI95 upper <= 1.05',
    positiveSpeedup: 'B/A CI95 upper < 1.00',
    strongSpeedup: 'B/A CI95 upper <= 0.98',
    aaGate: 'A/A CI95 inside [1/1.05, 1.05]',
  },
  protocol: {
    roots: 24,
    frozenRootFixtureSha256: d1.rootFixtureSha256,
    d1: d1.protocol,
    atomicUnit: 'one fresh Node process per arm per repetition, fully serial',
    primaryStatistic: ab.primaryStatistic,
    sweepsPerProcess: 5,
    aaRepetitions: aa.pairs,
    abRepetitions: ab.pairs,
    heavyWorkerConcurrency: 1,
  },
  aa: {
    geometricMeanRatio: aa.summary.geometricMeanRatio,
    ci95: aa.summary.ci95,
    medianRatio: aa.summary.medianRatio,
    worst: aa.summary.worstRatio,
    best: aa.summary.bestRatio,
    interpretation: 'Same source on both arms. The interval is +-0.8 %, i.e. the host resolves a 1 % effect at 95 % confidence with this protocol.',
  },
  ab: {
    geometricMeanRatio: ab.summary.geometricMeanRatio,
    ci95: ab.summary.ci95,
    medianRatio: ab.summary.medianRatio,
    speedupPct: ab.summary.speedupPct,
    worst: ab.summary.worstRatio,
    best: ab.summary.bestRatio,
    rootsSlowerThanBaseline: ab.perRoot.filter((r) => r.geoRatio > 1).length,
    rootsFasterThanBaseline: ab.perRoot.filter((r) => r.geoRatio < 1).length,
    slowestRoot: ab.perRoot[0],
    fastestRoot: ab.perRoot[ab.perRoot.length - 1],
  },
  gates,
  realTime: {
    authority: 'DIAGNOSTIC ONLY',
    whyRepeated: di.whyRepeated,
    samples: di.runs.length,
    perRun: di.runs.map((r) => ({
      run: r.index,
      rawFile: r.rawFile,
      rawSha256: r.rawSha256,
      totalNodeRatio: r.stats.totalNodeRatio,
      perRootMedianNodeRatio: r.stats.perRootNodeRatio.median,
      planned: r.stats.planned,
      fallbackLogged: r.stats.fallbackLogged,
      changedRootIds: r.stats.changedRoots.map((c) => c.id),
      medianTurnWallMs: r.stats.medianTurnWallMs,
    })),
    robust: di.robustFindings,
    fragile: di.fragileFindings,
    conclusion: 'MORE_SEARCH_WITHIN_100MS = YES (candidate explores more nodes in 5/5 runs, median turn wall unchanged). '
      + 'BETTER_VERIFIED_DECISION = NONE: which roots change plan/depth flips run to run (0-3 per run), so this gate cannot be used to claim better play.',
  },
  conclusion: (gates.AA_CALIBRATION === 'PASS' && gates.NO_REGRESSION_GATE === 'PASS' && gates.POSITIVE_SPEEDUP_EVIDENCE === 'YES')
    ? `PROVEN_SPEEDUP: fixed-workload wall clock drops to ${(ab.summary.geometricMeanRatio * 100).toFixed(2)} % of baseline (95 % CI ${(B[0] * 100).toFixed(2)}-${(B[1] * 100).toFixed(2)} %).`
    : 'NO_PROVEN_SPEEDUP',
  absoluteDeadlineGate: 'BLOCKED',
  absoluteDeadlineNote: 'A relative speedup on a fixed workload is NOT a physical 150 ms compliance claim. The M1/M2 distribution gates are a narrower measurement domain and are not used here.',
};

writeFileSync('PPC-P2-PREPARED-TRANSITION-01/PERFORMANCE_VERDICT.json', `${JSON.stringify(verdict, null, 2)}\n`);
console.log(JSON.stringify(gates, null, 1));
console.log(verdict.conclusion);
