/**
 * PPC-SEARCH-01 — performance comparison (only meaningful AFTER T1/T2 pass).
 *
 * Three lanes, kept strictly apart:
 *   1. FIXED DEPTH  — no deadline, frozen clock. Node counts are deterministic;
 *                     wall-clock is the median of N fresh repetitions.
 *   2. 100 ms MAIN  — the production call shape (iterative deepening, 100 ms
 *                     wall, 500k node valve).
 *   3. PLAN         — what the plan actually becomes at those budgets.
 *
 * Every root is reported. No "best root", no average-of-best.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { corpus, runFixed, runDeadline, writeOut, type Arm, type ArmResult, type DeadlineResult } from './pvs_lib.mts';

const OUT = 'PPC-SEARCH-01/out';
const ARMS: Arm[] = ['A', 'B', 'C'];
const REPEATS = 3;
const DEADLINE_REPS = 5;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function warmup(): void {
  // One throwaway search per arm so JIT/IC settle before any measurement.
  const root = corpus()[0].root;
  for (const arm of ARMS) {
    runFixed(arm, root, 1);
    runFixed(arm, root, 2);
  }
}

interface FixedRow {
  id: string;
  d: number;
  perArm: Record<string, { nodes: number; wallMs: number; wallSamples: number[]; chanceNodes: number; cutoffs: number; ttExactHits: number; ttSize: number }>;
  nodeRatioBA: number;
  wallRatioBA: number;
  nodeRatioCA: number;
  wallRatioCA: number;
}

const fixed: FixedRow[] = [];
const deadline: { id: string; perArm: Record<string, DeadlineResult[]> }[] = [];

describe('PPC-SEARCH-01 performance', () => {
  beforeAll(() => {
    warmup();
    for (const e of corpus()) {
      for (const d of [1, 2]) {
        const perArm: FixedRow['perArm'] = {};
        const first: Record<string, ArmResult> = {};
        for (const arm of ARMS) {
          const samples: number[] = [];
          let r: ArmResult | null = null;
          for (let i = 0; i < REPEATS; i++) {
            const cur = runFixed(arm, e.root, d);
            samples.push(cur.wallMs);
            if (i === 0) {
              r = cur;
              first[arm] = cur;
            }
          }
          perArm[arm] = {
            nodes: r!.nodes,
            wallMs: +median(samples).toFixed(3),
            wallSamples: samples,
            chanceNodes: r!.chanceNodes,
            cutoffs: r!.cutoffs,
            ttExactHits: r!.ttExactHits,
            ttSize: r!.ttSize,
          };
        }
        fixed.push({
          id: e.id,
          d,
          perArm,
          nodeRatioBA: perArm.B.nodes / perArm.A.nodes,
          wallRatioBA: perArm.B.wallMs / perArm.A.wallMs,
          nodeRatioCA: perArm.C.nodes / perArm.A.nodes,
          wallRatioCA: perArm.C.wallMs / perArm.A.wallMs,
        });
      }
    }
    writeOut(OUT, 'p1_fixed_depth.json', {
      lane: 'fixed depth, frozen clock, maxNodes=2e6, median of ' + REPEATS,
      repeats: REPEATS,
      rows: fixed,
    });

    for (const e of corpus()) {
      const perArm: Record<string, DeadlineResult[]> = {};
      for (const arm of ARMS) {
        perArm[arm] = [];
        for (let i = 0; i < DEADLINE_REPS; i++) perArm[arm].push(runDeadline(arm, e.root, 100));
      }
      deadline.push({ id: e.id, perArm });
    }
    writeOut(OUT, 'p2_deadline_100ms.json', { lane: '100 ms main search, iterative deepening', repeats: DEADLINE_REPS, rows: deadline });
  }, 3_600_000);

  it('P1 fixed-depth node and wall comparison (per root, D1 and D2)', () => {
    const summary = { d1: { nodeRatioBA: [] as number[], wallRatioBA: [] as number[], nodeRatioCA: [] as number[], wallRatioCA: [] as number[] }, d2: { nodeRatioBA: [] as number[], wallRatioBA: [] as number[], nodeRatioCA: [] as number[], wallRatioCA: [] as number[] } };
    for (const r of fixed) {
      const k = r.d === 1 ? summary.d1 : summary.d2;
      k.nodeRatioBA.push(r.nodeRatioBA);
      k.wallRatioBA.push(r.wallRatioBA);
      k.nodeRatioCA.push(r.nodeRatioCA);
      k.wallRatioCA.push(r.wallRatioCA);
    }
    const pack = (xs: number[]) => ({
      median: +median(xs).toFixed(3),
      min: +Math.min(...xs).toFixed(3),
      max: +Math.max(...xs).toFixed(3),
      improvedCount: xs.filter((x) => x < 1).length,
      worseCount: xs.filter((x) => x > 1).length,
      n: xs.length,
    });
    const out = {
      lane: 'fixed depth',
      note: 'ratio = arm / production. <1 means the arm used FEWER nodes / LESS wall time.',
      D1: { nodes_B_over_A: pack(summary.d1.nodeRatioBA), wall_B_over_A: pack(summary.d1.wallRatioBA), nodes_C_over_A: pack(summary.d1.nodeRatioCA), wall_C_over_A: pack(summary.d1.wallRatioCA) },
      D2: { nodes_B_over_A: pack(summary.d2.nodeRatioBA), wall_B_over_A: pack(summary.d2.wallRatioBA), nodes_C_over_A: pack(summary.d2.nodeRatioCA), wall_C_over_A: pack(summary.d2.wallRatioCA) },
    };
    writeOut(OUT, 'p1_summary.json', out);
    console.log(JSON.stringify(out, null, 1));
    expect(fixed.length).toBe(50);
  });

  it('P2 100 ms main-search comparison (completed depth, fallback, wall)', () => {
    const agg = (arm: Arm) => {
      const rows = deadline.map((r) => {
        const ds = r.perArm[arm];
        return {
          id: r.id,
          depths: ds.map((x) => x.completedDepth),
          medianDepth: median(ds.map((x) => x.completedDepth)),
          fallbacks: ds.filter((x) => x.fallback).length,
          wallMedian: +median(ds.map((x) => x.wallMs)).toFixed(1),
          wallMax: +Math.max(...ds.map((x) => x.wallMs)).toFixed(1),
          deadlineHits: ds.filter((x) => x.deadlineExceeded).length,
          nodesMedian: median(ds.map((x) => x.nodes)),
          plans: ds.map((x) => x.plan),
        };
      });
      return {
        rows,
        depthOneOrLess: rows.filter((r) => r.medianDepth <= 1).length,
        depthTwoPlus: rows.filter((r) => r.medianDepth >= 2).length,
        totalFallbacks: rows.reduce((a, b) => a + b.fallbacks, 0),
        wallMedianOfMedians: +median(rows.map((r) => r.wallMedian)).toFixed(1),
      };
    };
    const out = { lane: '100 ms main search', roots: 25, repeats: DEADLINE_REPS, A: agg('A'), B: agg('B'), C: agg('C') };
    writeOut(OUT, 'p2_summary.json', out);
    console.log(JSON.stringify({ A: { d2plus: out.A.depthTwoPlus, fb: out.A.totalFallbacks }, B: { d2plus: out.B.depthTwoPlus, fb: out.B.totalFallbacks }, C: { d2plus: out.C.depthTwoPlus, fb: out.C.totalFallbacks } }));
    expect(deadline.length).toBe(25);
  });

  it('P3 memory: TT footprint and process RSS delta', () => {
    const before = process.memoryUsage();
    const sizes: Record<string, number[]> = { A: [], B: [], C: [] };
    for (const e of corpus()) {
      for (const arm of ARMS) sizes[arm].push(runFixed(arm, e.root, 2).ttSize);
    }
    const after = process.memoryUsage();
    const out = {
      gate: 'TT entry counts (a proxy for unique-state working set) + process RSS delta',
      ttEntries: {
        A: { median: median(sizes.A), max: Math.max(...sizes.A) },
        B: { median: median(sizes.B), max: Math.max(...sizes.B) },
        C: { median: median(sizes.C), max: Math.max(...sizes.C) },
      },
      rssDeltaMiB: +((after.rss - before.rss) / 1048576).toFixed(1),
      heapUsedDeltaMiB: +((after.heapUsed - before.heapUsed) / 1048576).toFixed(1),
      note: 'process-level measurement; the harness itself allocates between the two samples',
    };
    writeOut(OUT, 'p3_memory.json', out);
    console.log(JSON.stringify(out));
  });
});
