/// <reference types="node" />
/**
 * PCV-01 pilot — cost probe on a small, explicitly listed set of frontiers.
 * NOT part of the 240-observation result set. RESEARCH ONLY.
 *   PILOT="G6T1/E1,G6T2/E1,..." npx vitest run ...
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import {
  p5, loadRoot, replayPlan, runSolve, stateKey, applyPrefix,
  QCAP, PCV_TARGET_MS,
} from './pcv_lib';

const PILOT = (process.env.PILOT ?? 'G6T1/E1,G6T2/E1,G1T5/E1')
  .split(',').map((x) => x.trim()).filter(Boolean);

describe('PCV-01 pilot cost probe', () => {
  it('runs H0 mouseForce + catSurvive at cap 600000', () => {
    const rows: unknown[] = [];
    for (const key of PILOT) {
      const [rootId, arm] = key.split('/');
      const combo = p5.combos.find((c) => c.rootId === rootId && c.arm === arm);
      if (!combo) throw new Error(`combo missing ${key}`);
      const plan = combo.finalPlans[0];
      const root = loadRoot(rootId);
      const rep = replayPlan(root, [...plan]);
      if (rep.status !== 'VALID_MOUSE_FRONTIER') throw new Error(`not a frontier ${key}: ${rep.status}`);
      if (rep.branches.length !== 1) throw new Error(`pilot expects a single frontier branch ${key}`);
      const ap = applyPrefix(root, [...plan], 0);
      if (!ap.ok || ap.states.length !== 1) throw new Error(`frontier replay not unique ${key}`);
      const state = ap.states[0];
      const postKey = stateKey(state);
      if (postKey !== rep.branches[0].postStateKey) throw new Error(`stateKey mismatch ${key}`);

      const t0 = performance.now();
      const mf = runSolve(state, 'mouseForce', 1, 1, QCAP, QCAP);
      const cs = runSolve(state, 'catSurvive', 1, 1, QCAP, QCAP);
      const cs1 = runSolve(state, 'catSurvive', 2, 1, 5000, QCAP);
      const totalMs = performance.now() - t0;
      const rssMB = process.memoryUsage().rss / (1024 * 1024);

      rows.push({
        rootId, arm, plan, postKey, frontier: rep.branches[0].summary,
        mouseForce_H0: mf, catSurvive_H0: cs, catSurvive_H1_phase1: cs1,
        totalMs, rssMB, within25: totalMs <= PCV_TARGET_MS,
      });
      console.log('PILOT_ROW', JSON.stringify({
        id: key, plan,
        mf: { nodes: mf.nodes, ms: Math.round(mf.solveElapsedMs), value: mf.value, verify: mf.verifyVerdict, leaves: mf.verify?.leaves ?? 0, vms: Math.round(mf.verify?.elapsedMs ?? 0) },
        cs: { nodes: cs.nodes, ms: Math.round(cs.solveElapsedMs), value: cs.value, verify: cs.verifyVerdict, leaves: cs.verify?.leaves ?? 0, vms: Math.round(cs.verify?.elapsedMs ?? 0) },
        cs1: { nodes: cs1.nodes, ms: Math.round(cs1.solveElapsedMs), value: cs1.value, trunc: cs1.truncated, verify: cs1.verifyVerdict, leaves: cs1.verify?.leaves ?? 0, vms: Math.round(cs1.verify?.elapsedMs ?? 0), p1: cs1.withinPhase1 },
        totalMs: Math.round(totalMs), rssMB: Math.round(rssMB),
      }));
    }
    writeFileSync('PPC-T1-PCV-01/_raw/pilot.json', JSON.stringify(rows, null, 1));
    expect(rows.length).toBe(PILOT.length);
  });
});
