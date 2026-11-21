/// <reference types="node" />
/**
 * PPC-ORACLE-HOTPATH-ATTRIBUTION-01 — shared harness (RESEARCH ONLY).
 *
 * Read-only reuse of the frozen SEAL kernel, its real-rule adapter, the frozen
 * G6T2/G1T9 roots and the research rules. No production file is modified.
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  ROUND as PRIOR_ROUND, QCAP, replayToFrontier, hostResource, duplicateHeavyWorkers,
  peakRssMB, resetPeakRss,
} from '../../PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/ttor_lib';
import type { HotCounters, HotResult } from './seal_instrumented';
import type { GameEngineState } from '../../src/game/engine';

export const ROUND = 'PPC-ORACLE-HOTPATH-ATTRIBUTION-01';
export const LOG = `${ROUND}/logs`;
export const QCAP_LOCAL = QCAP;
export { PRIOR_ROUND, replayToFrontier, hostResource, duplicateHeavyWorkers, peakRssMB, resetPeakRss };

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Serialize counters without the heavy solve-local Maps/Sets. */
export function serializeCounters(h: HotCounters): Record<string, number | boolean | string | null> {
  const {
    expansionKeyCounts: _k, lastIdxByKey: _l, successorKeys: _s,
    ...rest
  } = h;
  return rest;
}

export function digestPolicy(policy: Map<string, string>): string {
  const entries = [...policy.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify(entries));
}

export function hotResultSummary(r: HotResult) {
  return {
    value: r.value,
    policySize: r.policy.size,
    policyDigest: digestPolicy(r.policy),
    stats: r.stats,
  };
}

export function planFrontier(plan: 'DUUD' | 'UURR' | 'DRRR' | 'LLLD'): { rootId: string; plan: string; state: GameEngineState; frontierStateKeys: string[] } {
  const rootId = plan === 'LLLD' ? 'G1T9' : 'G6T2';
  const f = replayToFrontier(rootId, plan);
  if (!f.validMouseFrontier) throw new Error(`${plan}: ${f.ineligibleReason}`);
  if (f.states.length !== 1) throw new Error(`${plan}: expected one frontier state, got ${f.states.length}`);
  return { rootId, plan, state: f.states[0], frontierStateKeys: f.frontierStateKeys };
}

export interface AdmissionRecord {
  probe: number;
  totalMB: number;
  freeMB: number;
  vitestProcesses: number;
  vitestOutOfTree: number;
  foreignNodeProcesses: number;
  duplicates: number;
  at: string;
}

/**
 * Brief: at least FIVE consecutive physical-memory probes before heavy work;
 * floor = conservative 2.5 GiB; also no duplicate heavy worker.
 */
export function fiveConsecutiveAdmission(minFreeMB = 2560): { records: AdmissionRecord[]; admitted: boolean } {
  const records: AdmissionRecord[] = [];
  for (let i = 1; i <= 5; i++) {
    const r = hostResource();
    records.push({
      probe: i,
      totalMB: r.totalMB,
      freeMB: r.freeMB,
      vitestProcesses: r.vitestProcesses,
      vitestOutOfTree: r.vitestOutOfTree,
      foreignNodeProcesses: r.foreignNodeProcesses,
      duplicates: duplicateHeavyWorkers(r),
      at: new Date().toISOString(),
    });
    // Consecutive, but let the OS settle between samples; not a load generator.
    const until = performance.now() + 900;
    while (performance.now() < until) { /* short wait */ }
  }
  const admitted = records.every((r) => r.freeMB >= minFreeMB && r.duplicates === 0);
  return { records, admitted };
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(LOG, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}