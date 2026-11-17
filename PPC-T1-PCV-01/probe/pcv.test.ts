/// <reference types="node" />
/**
 * PCV-01 main measurement — one fresh process per repetition.
 *
 * For every one of the 48 frozen root-arm strata:
 *   1. restore the frozen human root;
 *   2. replay the P5 FINAL_SELECTED_PLAN with the real RuleSet;
 *   3. enumerate every positive-probability CAT->MOUSE boundary outcome
 *      (degenerate here: all 48 have exactly one positive-prob outcome);
 *   4. solve mouseForce H0 (cap 600000) + catSurvive H0 (cap 600000)
 *      + catSurvive H1 (phase1 cap 5000);
 *   5. independently verify every definite TRUE with the SEAL verifiers.
 *
 * NO production source, no prior artifact, no main-search rerun.
 *   REP=1..5 npx vitest run --config PPC-T1-PCV-01/probe/vitest.config.mts ...
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import {
  p5, loadRoot, replayPlan, runSolve, applyPrefix, stateKey, sha256,
  snapshotSha, hashFile, summarizeState,
  QCAP, PHASE1_NODE_CAP, PCV_TARGET_MS,
  FIXTURE, FIXTURE_SHA, P5_PATH, P5_SHA, KERNEL_PATH, KERNEL_SHA,
  GAMEPLAY_PATH, GAMEPLAY_SHA, PREPARED_PATH, PREPARED_SHA, HEAD,
} from './pcv_lib';
import type { SolveRecord } from './pcv_lib';

const REP = Number(process.env.REP ?? '1');
const OUT = `PPC-T1-PCV-01/_raw/rep${REP}.json`;
const LOG = 'PPC-T1-PCV-01/logs/run_log.txt';

function andOverBranches(recs: SolveRecord[]): boolean | null {
  if (recs.some((r) => r.value === false)) return false;
  if (recs.some((r) => r.value === null)) return null;
  return recs.every((r) => r.value === true) ? true : null;
}
function allVerified(recs: SolveRecord[]): boolean {
  return recs.every((r) => r.value === true && r.proofStatus === 'PROVEN');
}
const brief = (r: SolveRecord) => ({
  value: r.value, proofStatus: r.proofStatus,
  nodes: r.nodes, solveMs: Number(r.solveElapsedMs.toFixed(3)),
  chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
  truncated: r.truncated,
  verifyVerdict: r.verifyVerdict, verifyLeaves: r.verify?.leaves ?? null,
  verifyMs: r.verify ? Number(r.verify.elapsedMs.toFixed(3)) : null,
  policyMisses: r.verify?.policyMisses ?? null,
  within25ms: r.within25ms, withinPhase1: r.withinPhase1,
});

describe(`PCV-01 measurement rep ${REP}`, () => {
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
    console.log(`REP${REP}_IDENTITY`, JSON.stringify(checks));
    expect(checks).toEqual({
      fixture: true, p5: true, kernel: true, gameplay: true,
      prepared: true, p5Head: true, p5Fixture: true,
    });
  });

  it('measures 48 strata', () => {
    mkdirSync('PPC-T1-PCV-01/_raw', { recursive: true });
    mkdirSync('PPC-T1-PCV-01/logs', { recursive: true });
    appendFileSync(LOG, `START rep=${REP} at=${new Date().toISOString()}\n`);
    const tRep = performance.now();
    const rows: unknown[] = [];
    let contradictions = 0;

    for (const combo of p5.combos) {
      const plans = combo.finalPlans ?? [];
      const planConsistent = new Set(plans).size === 1;
      const planString = plans[0] ?? '';
      const executedConsistent = (combo.executedLabels ?? []).every((x) => x === planString);
      const chars = [...planString];
      const root = loadRoot(combo.rootId);
      const rep = replayPlan(root, chars);

      const pre = applyPrefix(root, chars, 0);
      const branchKeys = rep.branches.map((b) => b.postStateKey).sort();
      const preKeys = pre.states.map((s) => stateKey(s)).sort();
      const bindingOk = pre.ok && pre.states.length === rep.branches.length
        && branchKeys.every((k, i) => k === preKeys[i]);

      let mf: SolveRecord[] = [];
      let cs0: SolveRecord[] = [];
      let cs1: SolveRecord[] = [];
      let status: string = rep.status;
      let cls = 'NOT_APPLICABLE';
      let reason: string | null = rep.reason;
      let pcvTotalMs = 0;

      if (rep.ok && rep.status === 'VALID_MOUSE_FRONTIER' && bindingOk && planConsistent && executedConsistent) {
        for (let i = 0; i < pre.states.length; i++) {
          const st = pre.states[i];
          const a = runSolve(st, 'mouseForce', 1, 1, QCAP, QCAP);
          const b = runSolve(st, 'catSurvive', 1, 1, QCAP, QCAP);
          const c = runSolve(st, 'catSurvive', 2, 1, PHASE1_NODE_CAP, QCAP);
          mf.push(a); cs0.push(b); cs1.push(c);
          pcvTotalMs += (a.solveElapsedMs + (a.verify?.elapsedMs ?? 0))
            + (b.solveElapsedMs + (b.verify?.elapsedMs ?? 0))
            + (c.solveElapsedMs + (c.verify?.elapsedMs ?? 0));
        }
        const mfAgg = andOverBranches(mf);
        const cs0Agg = andOverBranches(cs0);
        const cs1Agg = andOverBranches(cs1);
        const mfProven = mfAgg === true && allVerified(mf);
        const cs0Proven = cs0Agg === true && allVerified(cs0);
        const cs1Proven = cs1Agg === true && allVerified(cs1);
        if (mfProven && (cs0Proven || cs1Proven)) {
          contradictions++;
          cls = 'CONTRADICTION';
          reason = 'MOUSE_FORCED_WIN_AND_CAT_SURVIVAL_BOTH_PROVEN';
        } else if (mfProven) {
          cls = 'REFUTED';
        } else if (cs1Proven) {
          cls = 'SURVIVES_WITHIN_H1';
        } else if (cs0Proven) {
          cls = 'SURVIVES_WITHIN_H0';
        } else if (mfAgg === false && cs0Agg === false) {
          cls = 'CHANCE_DEPENDENT_RISK';
        } else {
          cls = 'UNKNOWN';
        }
      } else {
        status = planConsistent && executedConsistent
          ? (bindingOk ? status : 'INELIGIBLE')
          : 'INCONSISTENT';
        if (!planConsistent || !executedConsistent) reason = 'PLAN_INCONSISTENT';
        else if (!bindingOk) reason = 'BINDING_MISMATCH';
      }

      const postKeys = rep.branches.map((b) => b.postStateKey);
      const boundaryKind = !rep.boundaryChance
        ? 'DETERMINISTIC'
        : rep.branches.length > 1 ? 'MULTI_CHANCE_AND' : 'DEGENERATE_CHANCE_ONE_OUTCOME';
      const planHash = sha256(planString);
      const certHash = (r: SolveRecord) => sha256(JSON.stringify({
        mode: r.mode, H: r.H, startIdx: r.startIdx, cap: r.cap,
        value: r.value, proofStatus: r.proofStatus, nodes: r.nodes,
        chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
        postKeys, policy: r.policyEntries,
      }));

      const row = {
        observationId: `${combo.rootId}/${combo.arm}/rep${REP}`,
        rep: REP, rootId: combo.rootId, arm: combo.arm,
        planString, planHash, planConsistent, executedConsistent,
        snapshotSha256: snapshotSha(combo.rootId),
        rootStateKey: stateKey(root),
        postStateKeys: postKeys,
        boundary: { chance: rep.boundaryChance, kind: boundaryKind, branches: rep.branches.length },
        replayStatus: status, bindingOk,
        frontier: rep.branches[0]?.summary ?? null,
        p5Timing: { turnWallMs: combo.turnWallMs, mainElapsedMs: combo.mainElapsedMs },
        completedDepth: combo.completedDepth, attemptedDepth: combo.attemptedDepth,
        class: cls, strongCoverage: cls === 'REFUTED' || cls === 'SURVIVES_WITHIN_H1',
        reason,
        mouseForce_H0: mf.length ? mf.map(brief) : null,
        catSurvive_H0: cs0.length ? cs0.map(brief) : null,
        catSurvive_H1_phase1: cs1.length ? cs1.map(brief) : null,
        certificates: mf.length ? {
          mouseForce_H0: mf.map((r) => ({
            ...brief(r), certHash: certHash(r),
            policyEntries: r.policyEntries,
            counterexample: r.verify?.counterexample ?? null,
            verifyReason: r.verify?.reason ?? null,
          })),
          catSurvive_H0: cs0.map((r) => ({
            ...brief(r), certHash: certHash(r),
            policyEntries: r.policyEntries,
            counterexample: r.verify?.counterexample ?? null,
            verifyReason: r.verify?.reason ?? null,
          })),
          catSurvive_H1_phase1: cs1.map((r) => ({
            ...brief(r), certHash: certHash(r),
            policyEntries: r.policyEntries,
            counterexample: r.verify?.counterexample ?? null,
            verifyReason: r.verify?.reason ?? null,
          })),
        } : null,
        pcvTotalMs: Number(pcvTotalMs.toFixed(3)),
        within25ms: pcvTotalMs <= PCV_TARGET_MS,
      };
      rows.push(row);
    }

    const counts: Record<string, number> = {};
    for (const r of rows as { class: string }[]) counts[r.class] = (counts[r.class] ?? 0) + 1;
    const repMs = performance.now() - tRep;
    const mem = process.memoryUsage();
    const summary = {
      rep: REP, rows: rows.length, classCounts: counts,
      strongCoverage: (rows as { strongCoverage: boolean }[]).filter((r) => r.strongCoverage).length,
      contradictions, repMs: Number(repMs.toFixed(2)),
      rssMB: Number((mem.rss / 1048576).toFixed(1)),
      heapUsedMB: Number((mem.heapUsed / 1048576).toFixed(1)),
    };
    console.log(`REP${REP}_SUMMARY`, JSON.stringify(summary));
    writeFileSync(OUT, JSON.stringify({
      round: 'PPC-T1-PCV-01', rep: REP, generatedAt: new Date().toISOString(),
      head: HEAD, fixtureSha256: FIXTURE_SHA, p5Sha256: P5_SHA, kernelSha256: KERNEL_SHA,
      protocol: {
        mainSearchRerun: false,
        mouseForce_H0: { H: 1, startIdx: 1, cap: QCAP },
        catSurvive_H0: { H: 1, startIdx: 1, cap: QCAP },
        catSurvive_H1_phase1: { H: 2, startIdx: 1, cap: PHASE1_NODE_CAP },
        verifierCap: QCAP,
        targetMs: PCV_TARGET_MS,
      },
      summary, resource: { rssMB: summary.rssMB, heapUsedMB: summary.heapUsedMB },
      rows,
    }, null, 1));
    appendFileSync(LOG, `END rep=${REP} rows=${rows.length} ms=${repMs.toFixed(0)} rssMB=${summary.rssMB}\n`);

    expect(rows.length).toBe(48);
    expect(contradictions).toBe(0);
    expect((rows as { bindingOk: boolean }[]).every((r) => r.bindingOk)).toBe(true);
  });
});
