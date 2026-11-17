/// <reference types="node" />
/**
 * PPC-CAT-EVALUATOR-ABLATION-01 §7.2/§7.3 — fixed-D1 search-cost runner (P6).
 * ONE fresh process per run, ONE arm, all 24 roots, faithful D1 protocol
 * (createSearchContext(rules,400000,TT,AB,ordering) + leafFor(arm), NO wall-clock
 * deadline). RESEARCH ONLY; no production source modified.
 *
 * env: ABLATION_ARM = E1|H1 ; ABLATION_RUN_ID = e.g. aa_a_01 / ab_b_07.
 * Writes _raw/p6_search_{runId}.json with per-root elapsedMs/nodes/decision +
 * a host snapshot. The aggregate pairs these runs:
 *   A/A: aa_a_NN vs aa_b_NN (both E1)  → measurement-noise calibration
 *   A/B: ab_a_NN (E1) vs ab_b_NN (H1)  → the H1 search-cost effect
 * GATED wall-clock experiment: run only on a quiescent host, serial, one worker.
 */
import { test, expect } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import {
  OUT, HEAD, FIXTURE, FROZEN_FIXTURE_SHA, rootIds, loadRoot, sha256, faithfulRun, type Arm,
} from './ablation_lib';

const ARM = (process.env.ABLATION_ARM ?? 'E1') as Arm;
const RUN_ID = process.env.ABLATION_RUN_ID ?? 'adhoc';
const DEPTH = 1;

test(`P6 search-cost run ${RUN_ID} arm=${ARM} (24 roots, faithful D1)`, () => {
  expect(ARM === 'E1' || ARM === 'H1').toBe(true);
  expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);
  expect(rootIds.length).toBe(24);
  const t0 = performance.now();
  const rows = rootIds.map((id) => {
    const root = loadRoot(id);
    const f = faithfulRun(id, root, DEPTH, ARM);
    return {
      rootId: id, evaluator: ARM, depth: DEPTH,
      elapsedMs: f.elapsedMs, totalNodes: f.totalNodes, leafNodes: f.leafNodes, chanceNodes: f.chanceNodes,
      evaluationCalls: f.evaluationCalls, mouseBfsCalls: f.mouseBfsCalls, catBfsCalls: f.catBfsCalls,
      ttHits: f.ttHits, alphaBetaCutoffs: f.alphaBetaCutoffs,
      selectedAction: f.selectedAction, planString: f.planString, completed: f.completed,
      value: f.value, mate: f.mate,
    };
  });
  const runWallMs = performance.now() - t0;
  mkdirSync(`${OUT}/_raw`, { recursive: true });
  writeFileSync(`${OUT}/_raw/p6_search_${RUN_ID}.json`, JSON.stringify({
    runId: RUN_ID, arm: ARM, depth: DEPTH, head: HEAD, fixtureSha256: FROZEN_FIXTURE_SHA,
    generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p6_search_run.test.ts`,
    host: { freeMemMB: Math.round(os.freemem() / 1048576), totalMemMB: Math.round(os.totalmem() / 1048576), loadavg: os.loadavg(), platform: process.platform, node: process.version },
    runWallMs, rows,
  }, null, 2));
  const sum = rows.reduce((a, r) => a + r.elapsedMs, 0);
  console.log(`[P6 run ${RUN_ID}/${ARM}] roots=${rows.length} searchSumMs=${sum} runWallMs=${runWallMs.toFixed(0)} freeMemMB=${Math.round(os.freemem() / 1048576)}`);
  expect(rows.length).toBe(24);
  expect(rows.every((r) => r.completed)).toBe(true);
}, 600_000);