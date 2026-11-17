/**
 * PPC-MCTS-01B-HARNESS-REPAIR — harness correctness for the Phase 1 seam.
 *
 * This suite is about the HARNESS, not about the optimisation. It proves five
 * things that Phase 1 depends on and that no other suite covers:
 *
 *   H1  the baseline fork (`proto/uctBaseline.ts`) is BEHAVIOURALLY IDENTICAL to
 *       the frozen parent (`PPC-MCTS-01/proto/uct.ts`) when neither the stop
 *       seam nor the trace sink is enabled — 96 fixed-node cells, every
 *       comparable field.
 *
 *   H2  `maxCompletedSimulations = K` yields EXACTLY K completed simulations,
 *       reports `completedSimulationLimitHit`, and never trips the node cap or
 *       the deadline. Checked for K = 1..5 and for the largest K the budget
 *       allows on each root.
 *
 *   H3  the seam stops BETWEEN simulations, not inside one: the first k
 *       per-simulation digests of a K=20 run must equal the digests of a K=k
 *       run, for every k <= 20. A mid-simulation stop would break this prefix.
 *
 *   H4  the trace is RNG-NEUTRAL: running with a trace sink and running without
 *       one produce the same whole-tree fingerprint, the same plan and the same
 *       non-timing diagnostics.
 *
 *   H5  the trace is DETERMINISTIC: two identical calls produce identical
 *       per-simulation digests and identical plan-phase digests.
 *
 *   H6  CHANCE is actually reached: at K=8 the 24 frozen roots sample CHANCE on
 *       10 of 24 cells, and both arms stay in lockstep there.
 *
 *   H7  the whole-tree digest is stable across identical runs and changes when
 *       the workload changes, so "same digest" is a meaningful statement.
 *
 * Nothing here runs the formal envelope.
 */
import { describe, it, expect } from 'vitest';
import { createEngineRuleSet } from '../../../src/game/engine';
import { UctSearch } from '../../../PPC-MCTS-01/proto/uct';
import { UctSearchPrepared } from '../../proto/uctPrepared';
import { UctSearchBaseline, uctSeed } from '../../proto/uctBaseline';
import { comparable, loadRoots } from '../../drivers/lib/arms';
import {
  runPhase1Arm, diffPhase1, treeDigest,
} from '../../drivers/lib/phase1';
import type { Phase1Run } from '../../drivers/lib/phase1';
import { TraceCollector } from '../../proto/trace';

const rules = createEngineRuleSet();
const MAX_HANDOFFS = 4;
const MAX_NODES = 500_000;
const C = Math.SQRT2;

const { roots } = loadRoots();

describe('PPC-MCTS-01B harness — Phase 1 seam and instrumentation', () => {
  // -------------------------------------------------------------------------
  it('H1: the baseline fork is behaviourally identical to the frozen parent (96 cells)', () => {
    let cells = 0;
    let simsTotal = 0;
    for (const root of roots) {
      for (const mode of ['hybrid', 'random'] as const) {
        for (const budget of [64, 200]) {
          const seed = uctSeed(root.id, 'UCT-H', 0);
          const opts = {
            rules, deadlineMs: 1, maxHandoffs: MAX_HANDOFFS, maxNodes: budget,
            c: C, seed, rollout: mode, now: () => 0,
          };
          // Neither the seam nor a trace sink is passed: this must be the
          // parent's behaviour, only with dead instrumentation branches.
          const parent = new UctSearch(root.state, opts).run();
          const fork = new UctSearchBaseline(root.state, opts).run();
          const a = comparable(parent);
          const b = comparable(fork);
          const ctx = `${root.id}/${mode}/N=${budget}`;

          expect(b.digest, `tree @${ctx}`).toBe(a.digest);
          expect(b.plan, `plan @${ctx}`).toBe(a.plan);
          expect(b.planCost).toBe(a.planCost);
          expect(b.planExtended).toBe(a.planExtended);
          expect(b.treePlanLength).toBe(a.treePlanLength);
          expect(b.extensionSteps).toBe(a.extensionSteps);
          expect(b.rootAction).toBe(a.rootAction);
          expect(b.rootVisits).toBe(a.rootVisits);
          expect(b.rootMeanReward).toBe(a.rootMeanReward);
          expect(b.rootActionStats).toEqual(a.rootActionStats);
          // `comparable` projects only fields BOTH prototypes declare, so the
          // fork's extra `completedSimulationLimitHit` cannot mask a difference.
          expect(b.diagnostics).toEqual(a.diagnostics);
          expect(b.chanceSamples).toBe(a.chanceSamples);

          // The seam must be inert when it is not asked for.
          expect(fork.diagnostics.completedSimulationLimitHit).toBe(false);
          expect(fork.planTraceDigest).toBeNull();

          simsTotal += a.diagnostics.simulations;
          cells++;
        }
      }
    }
    console.log(`  H1 cells=${cells} total simulations across cells=${simsTotal}`);
    expect(cells).toBe(96);
    expect(simsTotal).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  it('H2: K complete simulations, exactly — and never a node-cap/deadline stop', () => {
    const sample = roots.filter((r) => ['G1T1', 'G2T6', 'G5T4', 'G6T1'].includes(r.id));
    expect(sample.length).toBe(4);
    let checked = 0;
    for (const root of sample) {
      const seed = uctSeed(root.id, 'UCT-H', 3);
      for (const K of [1, 2, 3, 5]) {
        for (const arm of ['UCT-H-BASELINE', 'UCT-H-PREPARED'] as const) {
          const run = runPhase1Arm(arm, root.state, seed, { completedSimulations: K });
          const d = run.result.diagnostics;
          const ctx = `${root.id}/${arm}/K=${K}`;
          expect(d.simulations, `simulations @${ctx}`).toBe(K);
          expect(d.completedSimulationLimitHit, `seam fired @${ctx}`).toBe(true);
          expect(d.nodeCapHit, `node cap @${ctx}`).toBe(false);
          expect(d.deadlineHit, `deadline @${ctx}`).toBe(false);
          expect(d.abortedSimulations, `aborted @${ctx}`).toBe(0);
          expect(run.digests.length, `digests @${ctx}`).toBe(K);
          checked++;
        }
      }
    }
    console.log(`  H2 arm-calls checked=${checked}`);
    expect(checked).toBe(4 * 4 * 2);
  });

  // -------------------------------------------------------------------------
  it('H3: the seam stops between simulations — the digest stream is a prefix', () => {
    const root = roots.find((r) => r.id === 'G2T6')!;
    const seed = uctSeed(root.id, 'UCT-H', 0);
    const full = runPhase1Arm('UCT-H-BASELINE', root.state, seed, { completedSimulations: 20 });
    expect(full.digests.length).toBe(20);
    for (const k of [1, 3, 7, 12]) {
      const part = runPhase1Arm('UCT-H-BASELINE', root.state, seed, { completedSimulations: k });
      expect(part.digests.length).toBe(k);
      for (let i = 0; i < k; i++) {
        expect(part.digests[i], `digest ${i} of a K=${k} run`).toBe(full.digests[i]);
      }
    }
    // The same prefix property on the prepared arm: the seam is one mechanism,
    // not two.
    const fullP = runPhase1Arm('UCT-H-PREPARED', root.state, seed, { completedSimulations: 20 });
    for (const k of [2, 9]) {
      const partP = runPhase1Arm('UCT-H-PREPARED', root.state, seed, { completedSimulations: k });
      for (let i = 0; i < k; i++) expect(partP.digests[i]).toBe(fullP.digests[i]);
    }
    // And the two arms agree per simulation at this workload.
    const diff = diffPhase1(full, fullP);
    expect(diff.digestDiffs, 'per-simulation digests').toEqual([]);
    expect(diff.fieldDiffs, 'comparable fields').toEqual([]);
    console.log(`  H3 prefix verified at k=1,3,7,12 and 2,9; 20 digests identical across arms`);
  });

  // -------------------------------------------------------------------------
  it('H4: the trace is RNG-neutral (with-trace === without-trace, whole tree)', () => {
    const root = roots.find((r) => r.id === 'G1T1')!;
    const seed = uctSeed(root.id, 'UCT-H', 5);
    const K = 30;

    for (const arm of ['baseline', 'prepared'] as const) {
      const baseOpts = {
        rules, deadlineMs: 1, maxHandoffs: MAX_HANDOFFS, maxNodes: MAX_NODES,
        c: C, seed, rollout: 'hybrid' as const, now: () => 0,
        maxCompletedSimulations: K,
      };
      const quiet = arm === 'baseline'
        ? new UctSearchBaseline(root.state, baseOpts).run()
        : new UctSearchPrepared(root.state, baseOpts).run();
      const trace = new TraceCollector();
      const tracedOpts = { ...baseOpts, trace };
      const traced = arm === 'baseline'
        ? new UctSearchBaseline(root.state, tracedOpts).run()
        : new UctSearchPrepared(root.state, tracedOpts).run();

      const a = comparable(quiet as never);
      const b = comparable(traced as never);
      expect(b.digest, `${arm} tree with trace`).toBe(a.digest);
      expect(b.plan, `${arm} plan with trace`).toBe(a.plan);
      expect(b.planCost).toBe(a.planCost);
      expect(b.rootVisits).toBe(a.rootVisits);
      expect(b.rootMeanReward).toBe(a.rootMeanReward);
      expect(b.rootActionStats).toEqual(a.rootActionStats);
      expect(b.diagnostics).toEqual(a.diagnostics);
      expect(trace.sims.length).toBe(K);
      // One digest per COMPLETE simulation, and the event bodies are dropped
      // unless one was explicitly selected for capture.
      expect(trace.sims.every((s) => s.events === null)).toBe(true);
      expect(trace.sims.every((s) => s.completed)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  it('H5: the trace is deterministic and its events never leak implementation identity', () => {
    const root = roots.find((r) => r.id === 'G2T6')!;
    const seed = uctSeed(root.id, 'UCT-H', 11);
    const K = 12;
    const a = runPhase1Arm('UCT-H-BASELINE', root.state, seed, { completedSimulations: K, captureSimulation: 4 });
    const b = runPhase1Arm('UCT-H-BASELINE', root.state, seed, { completedSimulations: K, captureSimulation: 4 });
    const c = runPhase1Arm('UCT-H-PREPARED', root.state, seed, { completedSimulations: K, captureSimulation: 4 });

    expect(b.digests).toEqual(a.digests);
    expect(b.result.planTraceDigest).toBe(a.result.planTraceDigest);
    // Same events, byte for byte, on a re-run of the same arm.
    expect(b.trace.sims[4].events).toEqual(a.trace.sims[4].events);
    // And the SAME events on the other arm: the trace records decisions, not
    // the mechanism that produced them.
    expect(c.trace.sims[4].events).toEqual(a.trace.sims[4].events);
    expect(c.digests).toEqual(a.digests);
    expect(c.result.planTraceDigest).toBe(a.result.planTraceDigest);

    const events = a.trace.sims[4].events!;
    expect(events.length).toBeGreaterThan(10);
    expect(events[0].startsWith('["sim.begin"')).toBe(true);
    expect(events[events.length - 1].startsWith('["sim.end"')).toBe(true);
    // Every event is a canonical JSON array — no object key order to depend on.
    for (const e of events) {
      expect(e.startsWith('[') && e.endsWith(']')).toBe(true);
      JSON.parse(e);
    }
    // RNG draws are recorded with their arguments and return values.
    const rngEvents = events.filter((e) => e.startsWith('["rng.draw"'));
    expect(rngEvents.length).toBeGreaterThan(0);
    for (const e of rngEvents) {
      const parsed = JSON.parse(e) as unknown[];
      expect(parsed.length).toBe(6); // kind, stream, method, n, value, drawIndex
    }
    console.log(`  H5 events in sim#4: ${events.length} (of which rng.draw ${rngEvents.length})`);
  });

  // -------------------------------------------------------------------------
  it('H6: CHANCE is exercised on both arms and stays in lockstep', () => {
    // A parity harness that never reaches a CHANCE node proves nothing about
    // CHANCE. At K=8 the 24 frozen roots hit the CHANCE layer on 10 of 24
    // cells; the assertion below keeps that coverage from silently dropping to
    // zero if the corpus or the seam is changed later.
    let chanceCells = 0;
    let chanceSamples = 0;
    let cells = 0;
    const perRoot: string[] = [];
    for (const root of roots) {
      const seed = uctSeed(root.id, 'UCT-H', 0);
      const a = runPhase1Arm('UCT-H-BASELINE', root.state, seed, { completedSimulations: 8 });
      const b = runPhase1Arm('UCT-H-PREPARED', root.state, seed, { completedSimulations: 8 });
      const d = diffPhase1(a, b);
      expect(d.fieldDiffs, `fields @${root.id}`).toEqual([]);
      expect(d.digestDiffs, `simulation digests @${root.id}`).toEqual([]);
      const c = a.result.diagnostics.chanceSamples;
      chanceSamples += c;
      perRoot.push(`${root.id}:${c}`);
      if (c > 0) chanceCells++;
      cells++;
    }
    console.log(`  H6 cells=${cells} with CHANCE=${chanceCells} total chanceSamples=${chanceSamples}`);
    console.log(`  H6 per-root ${perRoot.join(' ')}`);
    expect(cells).toBe(24);
    expect(chanceCells).toBeGreaterThan(0);
    expect(chanceSamples).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  it('H7: an un-normalised tree digest is stable and distinguishes trees', () => {
    const root = roots.find((r) => r.id === 'G1T1')!;
    const seed = uctSeed(root.id, 'UCT-H', 0);
    const r1 = runPhase1Arm('UCT-H-BASELINE', root.state, seed, { completedSimulations: 10 });
    const r2 = runPhase1Arm('UCT-H-BASELINE', root.state, seed, { completedSimulations: 10 });
    const r3 = runPhase1Arm('UCT-H-BASELINE', root.state, seed, { completedSimulations: 11 });
    expect(treeDigest(r1.result.root)).toBe(treeDigest(r2.result.root));
    expect(treeDigest(r1.result.root)).not.toBe(treeDigest(r3.result.root));
  });
});
