/// <reference types="node" />
/**
 * PCV-01 step 1 — restore every frozen root, replay the P5 FINAL_SELECTED_PLAN
 * with the real RuleSet, and record the CAT->MOUSE frontier (including every
 * positive-probability ghost-boundary outcome). NO quantifier runs here.
 * RESEARCH ONLY; no production source or previous artifact is modified.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  p5, loadRoot, replayPlan, snapshotSha, stateKey,
  hashFile, P5_PATH, P5_SHA, FIXTURE, FIXTURE_SHA, KERNEL_PATH, KERNEL_SHA,
  GAMEPLAY_PATH, GAMEPLAY_SHA, PREPARED_PATH, PREPARED_SHA, HEAD,
} from './pcv_lib';
import type { ReplayResult } from './pcv_lib';

const OUT = 'PPC-T1-PCV-01/_raw/replay_all.json';

describe('PCV-01 identity + plan replay', () => {
  it('identity gate G0', () => {
    const checks = {
      fixture: hashFile(FIXTURE) === FIXTURE_SHA,
      p5: hashFile(P5_PATH) === P5_SHA,
      kernel: hashFile(KERNEL_PATH) === KERNEL_SHA,
      gameplay: hashFile(GAMEPLAY_PATH) === GAMEPLAY_SHA,
      prepared: hashFile(PREPARED_PATH) === PREPARED_SHA,
      p5Head: p5.head === HEAD,
      p5Fixture: p5.fixtureSha256 === FIXTURE_SHA,
    };
    console.log('IDENTITY', JSON.stringify(checks));
    expect(checks).toEqual({
      fixture: true, p5: true, kernel: true, gameplay: true,
      prepared: true, p5Head: true, p5Fixture: true,
    });
  });

  it('replays all 48 combos', () => {
    mkdirSync('PPC-T1-PCV-01/_raw', { recursive: true });
    expect(p5.combos.length).toBe(48);

    const rows: (ReplayResult & { rootId: string; arm: string })[] = [];
    for (const combo of p5.combos) {
      const plans = combo.finalPlans ?? [];
      const planConsistent = plans.length === p5.combos[0].finalPlans.length
        && new Set(plans).size === 1;
      const planString = plans[0] ?? '';
      const planChars = [...planString];
      const executedConsistent = (combo.executedLabels ?? []).every((x) => x === planString);
      const root = loadRoot(combo.rootId);
      const rep = replayPlan(root, planChars);
      rows.push({
        ...rep,
        planString,
        planChars,
        planConsistent,
        executedConsistent,
        rootStateKey: stateKey(root),
        snapshotSha256: snapshotSha(combo.rootId),
        rootId: combo.rootId,
        arm: combo.arm,
      });
    }

    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const branchCounts = rows.map((r) => r.branches.length);
    const chanceRows = rows.filter((r) => r.boundaryChance);
    console.log('REPLAY_STATUS', JSON.stringify(counts));
    console.log('BRANCHES', JSON.stringify({
      max: Math.max(...branchCounts), min: Math.min(...branchCounts),
      multi: rows.filter((r) => r.branches.length > 1).length,
      chance: chanceRows.length,
      crossCheckFailures: rows.filter((r) => !r.applyPrefixCrossCheck).map((r) => `${r.rootId}/${r.arm}`),
      planInconsistent: rows.filter((r) => !r.planConsistent).map((r) => `${r.rootId}/${r.arm}`),
      executedInconsistent: rows.filter((r) => !r.executedConsistent).map((r) => `${r.rootId}/${r.arm}`),
      notValid: rows.filter((r) => r.status !== 'VALID_MOUSE_FRONTIER').map((r) => `${r.rootId}/${r.arm}:${r.status}:${r.reason}`),
    }));

    writeFileSync(OUT, JSON.stringify({ head: HEAD, rows }, null, 1));
    expect(rows.every((r) => r.ok)).toBe(true);
    expect(rows.every((r) => r.applyPrefixCrossCheck)).toBe(true);
    expect(rows.every((r) => r.planConsistent && r.executedConsistent)).toBe(true);
  });
});
