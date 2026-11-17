/// <reference types="node" />
/**
 * G5 — cost accounting run. Same search, third fresh process, with memory
 * sampling before/after. On Windows `process.resourceUsage().maxRSS` is 0, so
 * only current RSS / heap are trustworthy — recorded as such.
 */
import { describe, it } from 'vitest';
import { runD2Search, writeJson, OUT } from './d2_lib';

describe('G5 cost', () => {
  it('G1T9/E1 memory + timing', () => {
    const before = process.memoryUsage();
    const ruBefore = process.resourceUsage();
    const t0 = performance.now();
    const { run } = runD2Search();
    const wallMs = Number((performance.now() - t0).toFixed(1));
    const after = process.memoryUsage();
    const ruAfter = process.resourceUsage();

    const payload = {
      round: 'PPC-D2-PCV-COUNTERLINE-01',
      phase: 'G5_COST',
      searchMs: run.elapsedMs,
      wallMs,
      nodes: run.nodes,
      leafNodes: run.leafNodes,
      chanceNodes: run.chanceNodes,
      nodesPerSecond: Math.round(run.nodes / (run.elapsedMs / 1000)),
      planBranchEntries: run.planBranchEntries,
      rssBeforeMb: Number((before.rss / 1048576).toFixed(1)),
      rssAfterMb: Number((after.rss / 1048576).toFixed(1)),
      heapUsedBeforeMb: Number((before.heapUsed / 1048576).toFixed(1)),
      heapUsedAfterMb: Number((after.heapUsed / 1048576).toFixed(1)),
      heapTotalAfterMb: Number((after.heapTotal / 1048576).toFixed(1)),
      externalAfterMb: Number((after.external / 1048576).toFixed(1)),
      v8HeapExpanded: false,
      resourceUsageMaxRssKb: ruAfter.maxRSS,
      resourceUsageMaxRssNote: 'Windows reports 0 for maxRSS; only current rss is meaningful',
      userCpuSeconds: Number((ruAfter.userCPUTime / 1e6).toFixed(2)),
      systemCpuSeconds: Number((ruAfter.systemCPUTime / 1e6).toFixed(2)),
      ruBeforeUser: Number((ruBefore.userCPUTime / 1e6).toFixed(2)),
      nodeCountMatchWithRep1: run.nodes === 2727890,
    };
    writeJson(`${OUT}/logs/d2_cost.json`, payload);
    console.log('--- COST ---');
    console.log(JSON.stringify(payload, null, 2));
    console.log('--- END ---');
  });
});
