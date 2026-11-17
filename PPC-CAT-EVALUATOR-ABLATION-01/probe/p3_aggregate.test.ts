/// <reference types="node" />
/**
 * Phase 3 aggregator — verifies the 3 fresh-process D1 ablation reps are
 * bit-identical on EVERY decision field (only wall-clock elapsedMs / generatedAt
 * may differ), then emits the consolidated ABLATION_RESULTS.json and the
 * spec-field ROOT_DECISION_TABLE.csv. RESEARCH ONLY; no production edit; reads
 * the rep artifacts produced by p3_d1_ablation.test.ts (never overwrites them).
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import {
  ROUND, OUT, HEAD, FIXTURE, FROZEN_FIXTURE_SHA, rootIds, sha256, canonicalJson,
} from './ablation_lib';

const REPS = [1, 2, 3];
const repPath = (n: number) => `${OUT}/_raw/d1_rep${n}.json`;

interface RepDoc {
  rep: number; generatedAt: string; elapsedMs: number; rowCount: number;
  allCrossChecksPass: boolean; rows: any[];
}

/** Decision fingerprint: the row with all wall-clock fields removed. */
function fingerprint(row: any): string {
  const c = JSON.parse(JSON.stringify(row));
  delete c.faithful?.elapsedMs;
  delete c.exact?.elapsedMs;
  return canonicalJson(c);
}

function csvCell(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

describe('Phase 3 aggregate + reproducibility', () => {
  it('3 fresh-process reps are decision-identical; emit ABLATION_RESULTS + CSV', () => {
    expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);
    const docs = REPS.map((n) => JSON.parse(readFileSync(repPath(n)).toString('utf8')) as RepDoc);
    for (const d of docs) {
      expect(d.allCrossChecksPass, `rep ${d.rep} cross-checks`).toBe(true);
      expect(d.rowCount).toBe(rootIds.length * 2 + 2);
      expect(d.rows.length).toBe(d.rowCount);
    }

    // ---- cross-rep identity on every decision field ----
    const fpArrays = docs.map((d) => d.rows.map(fingerprint));
    const reference = fpArrays[0];
    const mismatches: { rep: number; rowIndex: number; rootId: string }[] = [];
    for (let r = 1; r < fpArrays.length; r++) {
      expect(fpArrays[r].length).toBe(reference.length);
      for (let i = 0; i < reference.length; i++) {
        if (fpArrays[r][i] !== reference[i]) mismatches.push({ rep: docs[r].rep, rowIndex: i, rootId: docs[r].rows[i].rootId });
      }
    }
    const decisionIdentical = mismatches.length === 0;
    const fingerprintSha256 = sha256(reference.join('\n'));

    // ---- consolidate (rep 1 is authoritative; identity proven across all 3) ----
    const base = docs[0];
    const byKey = new Map<string, any>();
    for (const row of base.rows) byKey.set(`${row.rootId}|${row.evaluator}|${row.depth}`, row);

    const roots = rootIds.map((id) => {
      const e1 = byKey.get(`${id}|E1|1`)!;
      const h1 = byKey.get(`${id}|H1|1`)!;
      const comparison = {
        actionChanged: e1.faithful.selectedAction !== h1.faithful.selectedAction,
        exactActionChanged: e1.exact.engineSelected !== h1.exact.engineSelected,
        planChanged: e1.faithful.planString !== h1.faithful.planString,
        e1ExactValue: e1.exact.maxValue, h1ExactValue: h1.exact.maxValue,
        valueDelta: h1.exact.maxValue - e1.exact.maxValue,
        e1Selected: e1.faithful.selectedAction, h1Selected: h1.faithful.selectedAction,
        e1Plan: e1.faithful.planString, h1Plan: h1.faithful.planString,
        e1ArgmaxSet: e1.exact.argmaxSet, h1ArgmaxSet: h1.exact.argmaxSet,
      };
      const entry: any = { rootId: id, stateKey: e1.stateKey, snapshotSha256: e1.snapshotSha256, D1: { E1: e1, H1: h1, comparison } };
      if (id === 'G6T2') {
        const e1d2 = byKey.get(`${id}|E1|2`)!;
        const h1d2 = byKey.get(`${id}|H1|2`)!;
        entry.D2_explanationOnly = {
          E1: e1d2, H1: h1d2,
          comparison: {
            actionChanged: e1d2.faithful.selectedAction !== h1d2.faithful.selectedAction,
            planChanged: e1d2.faithful.planString !== h1d2.faithful.planString,
            e1ExactValue: e1d2.exact.maxValue, h1ExactValue: h1d2.exact.maxValue,
            e1Selected: e1d2.faithful.selectedAction, h1Selected: h1d2.faithful.selectedAction,
            e1Plan: e1d2.faithful.planString, h1Plan: h1d2.faithful.planString,
            e1RootValues: e1d2.exact.rootActionValues, h1RootValues: h1d2.exact.rootActionValues,
            e1DistinctValues: new Set(e1d2.exact.rootActionValues.map((x: any) => x.value.toFixed(9))).size,
            h1DistinctValues: new Set(h1d2.exact.rootActionValues.map((x: any) => x.value.toFixed(9))).size,
          },
          note: 'D2 is EXPLANATION ONLY (carried from the previous round U=D=L tie analysis). It never grounds a real-time / 100ms claim.',
        };
      }
      return entry;
    });

    const d1Comparisons = roots.map((r) => r.D1.comparison);
    const changedRoots = roots.filter((r) => r.D1.comparison.actionChanged).map((r) => r.rootId);
    const planChangedRoots = roots.filter((r) => r.D1.comparison.planChanged).map((r) => r.rootId);

    const doc = {
      artifactId: 'ABLATION_RESULTS', round: ROUND, phase: 3,
      generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p3_aggregate.test.ts`,
      head: HEAD, fixtureSha256: FROZEN_FIXTURE_SHA, productionSourceChanged: false,
      protocol: base.protocol,
      reproducibility: {
        reps: REPS.length, freshProcessPerRep: true, strictlySerial: true,
        decisionFieldsIdenticalAcrossReps: decisionIdentical,
        excludedFromIdentity: ['faithful.elapsedMs', 'exact.elapsedMs', 'generatedAt', 'rep', 'elapsedMs'],
        perRepElapsedMs: docs.map((d) => d.elapsedMs),
        perRepGeneratedAt: docs.map((d) => d.generatedAt),
        decisionFingerprintSha256: fingerprintSha256,
        mismatches,
      },
      summary: {
        roots: rootIds.length, d1Rows: base.d1RowCount, g6t2D2ExplanationRows: base.g6t2D2ExplanationRows,
        d1ActionChanges: changedRoots.length, changedRoots,
        d1PlanChanges: planChangedRoots.length, planChangedRoots,
        allCrossChecksPass: base.allCrossChecksPass,
      },
      roots,
    };
    writeFileSync(`${OUT}/ABLATION_RESULTS.json`, JSON.stringify(doc, null, 2));

    // ---- ROOT_DECISION_TABLE.csv: LONG format, one row per (root, arm, depth), spec fields ----
    const header = [
      'ROOT_ID', 'STATE_KEY', 'EVALUATOR', 'DEPTH', 'ROOT_ACTIONS', 'ROOT_ACTION_VALUES',
      'ROOT_ACTION_MATES', 'ROOT_ACTION_BOUNDS', 'SELECTED_ACTION', 'CAT_TURN_PLAN', 'COMPLETED',
      'TOTAL_NODES', 'EVALUATION_CALLS', 'TT_HITS', 'ALPHA_BETA_CUTOFFS', 'ELAPSED_MS',
      'ALL_ROOT_BOUNDS_EXACT', 'EXACT_MAX_VALUE', 'EXACT_ARGMAX_SET', 'CROSS_CHECKS_PASS', 'REP_ELAPSED_MS_ALL',
    ];
    const lines = [header.join(',')];
    for (const row of base.rows) {
      const f = row.faithful; const e = row.exact;
      const allRepElapsed = docs.map((d) => {
        const rr = d.rows.find((x: any) => x.rootId === row.rootId && x.evaluator === row.evaluator && x.depth === row.depth);
        return rr.faithful.elapsedMs;
      });
      const cells = [
        row.rootId, row.stateKey, row.evaluator, row.depth,
        f.rootActionValues.map((x: any) => x.action),
        f.rootActionValues.map((x: any) => x.value),
        f.rootActionValues.map((x: any) => x.mate),
        f.rootActionValues.map((x: any) => x.bound),
        f.selectedAction, f.planString, f.completed,
        f.totalNodes, f.evaluationCalls, f.ttHits, f.alphaBetaCutoffs, f.elapsedMs,
        f.allRootBoundsExact, e.maxValue, e.argmaxSet,
        Object.values(row.crossCheck).every((v) => v === true), allRepElapsed,
      ];
      lines.push(cells.map(csvCell).join(','));
    }
    writeFileSync(`${OUT}/ROOT_DECISION_TABLE.csv`, lines.join('\n') + '\n');

    console.log('decisionIdenticalAcrossReps=', decisionIdentical, 'mismatches=', mismatches.length, 'fingerprintSha256=', fingerprintSha256);
    console.log('D1_actionChanges=', changedRoots.length, 'changedRoots=', JSON.stringify(changedRoots));
    console.log('D1_planChanges=', planChangedRoots.length, 'planChangedRoots=', JSON.stringify(planChangedRoots));
    console.log('perRepElapsedMs=', JSON.stringify(docs.map((d) => d.elapsedMs)));
    console.log('csvRows=', lines.length - 1, 'jsonRoots=', roots.length);

    expect(decisionIdentical, `cross-rep decision mismatches: ${JSON.stringify(mismatches.slice(0, 10))}`).toBe(true);
    expect(changedRoots.length).toBe(5); // measured in all 3 reps; locked here as a regression anchor
    expect(lines.length - 1).toBe(base.rowCount);
  }, 600_000);
});