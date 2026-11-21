/// <reference types="node" />
/**
 * G4 — proof cost vs optional diagnostics, measured on identical inputs.
 *
 * The main proof result may not depend on any optional layer. Every paired
 * measurement re-runs the same quantifier on the same frontier with the same
 * cap; only the diagnostic work is switched.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  ROUND, QCAP, replayToFrontier, runProof, cheapOneTurn, witnessLine,
  resetPeakRss, peakRssMB, hostResource, duplicateHeavyWorkers,
} from './ttor_lib';
import { mouseStaticGoalReach, mouseTwoTurnRisk as shadowTwoTurn } from '../../PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib';

const OUT = ROUND;
const LOG = `${ROUND}/logs`;

function ms(x: number) { return Math.round(x); }

describe('G4 witness cost ablation', () => {
  it('splits proof-necessary cost from optional witness diagnostics', () => {
    const res = hostResource();
    expect(res.freeMB).toBeGreaterThanOrEqual(1200);
    expect(duplicateHeavyWorkers(res)).toBe(0);

    const f = replayToFrontier('G6T2', 'DUUD');
    const st = f.states[0];

    // L0 — cheapest mouse-one-turn check.
    resetPeakRss();
    const l0 = cheapOneTurn(st);
    const l0Peak = peakRssMB();

    // L1 — core proof only, no certificate, no witness.
    resetPeakRss();
    const t1 = performance.now();
    const l1 = runProof(st, 'mouseForce', 2, 1, QCAP, 1); // verifier cap 1 disables the certificate
    const l1Ms = performance.now() - t1;
    const l1Peak = peakRssMB();
    expect(l1.value).toBe(true);
    expect(l1.verify?.verdict).toBe('UNRESOLVED');

    // L2 — same proof plus the independent certificate.
    resetPeakRss();
    const t2 = performance.now();
    const l2 = runProof(st, 'mouseForce', 2, 1, QCAP, QCAP);
    const l2Ms = performance.now() - t2;
    const l2Peak = peakRssMB();

    // L3 — L2 plus the optional human-readable witness line.
    resetPeakRss();
    const t3 = performance.now();
    const wit = witnessLine(st, l2.policy, 2, 1);
    const witMs = performance.now() - t3;
    const l3Peak = peakRssMB();
    expect(wit.ok).toBe(true);

    // Optional static reachability diagnostic (shadow layer 0).
    resetPeakRss();
    const t4 = performance.now();
    const reach = mouseStaticGoalReach(st, 2);
    const reachMs = performance.now() - t4;
    const reachPeak = peakRssMB();

    // Optional existential witness search fires only on NO_WIN cases.
    const neg = replayToFrontier('G6T2', 'DRRR');
    resetPeakRss();
    const t5 = performance.now();
    const negProof = runProof(neg.states[0], 'mouseForce', 2, 1, QCAP, QCAP);
    const negProofMs = performance.now() - t5;
    expect(negProof.value).toBe(false);

    // Live measurement of the shadow's optional tail (proof + existential search).
    const t6 = performance.now();
    const negShadow = shadowTwoTurn(neg.states[0]);
    const negShadowMs = performance.now() - t6;
    expect(negShadow.value).toBe(false);

    // Proof fields must be byte-identical between L1 and L2.
    const proofFields = (r: typeof l1) => ({
      value: r.value, truncated: r.truncated, nodes: r.nodes,
      transitions: r.transitions, chanceNodes: r.chanceNodes, chanceOutcomes: r.chanceOutcomes,
      memoHits: r.memoHits, cutoffs: r.cutoffs, maxIdx: r.maxIdx, policySize: r.policySize,
    });
    expect(proofFields(l1)).toEqual(proofFields(l2));

    const data = {
      round: ROUND,
      input: { plan: 'DUUD', frontierStateKeys: f.frontierStateKeys, sameInputForAllLayers: true },
      layers: {
        L0_cheapOneTurn: { ...l0, peakRssMB: l0Peak, role: 'fast H1 check only; cannot see the two-turn win' },
        L1_coreProofOnly: {
          value: l1.value, truncated: l1.truncated, nodes: l1.nodes, chanceNodes: l1.chanceNodes,
          chanceOutcomes: l1.chanceOutcomes, policySize: l1.policySize,
          elapsedMs: ms(l1Ms), peakRssMB: l1Peak, verified: false,
        },
        L2_corePlusVerifier: {
          value: l2.value, nodes: l2.nodes, policySize: l2.policySize,
          verify: l2.verify && {
            verdict: l2.verify.verdict, leaves: l2.verify.leaves, branches: l2.verify.branches,
            chanceNodes: l2.verify.chanceNodes, maxDepth: l2.verify.maxDepth,
            elapsedMs: ms(l2.verify.elapsedMs),
          },
          elapsedMs: ms(l2Ms), peakRssMB: l2Peak,
        },
        L3_plusWitnessLine: { witnessSteps: wit.line.length, elapsedMs: ms(witMs), peakRssMB: l3Peak },
        D1_staticReach: { nodes: reach.nodes, truncated: reach.truncated, elapsedMs: ms(reachMs), peakRssMB: reachPeak },
        D2_witnessSearchOnNoWin: {
          plan: 'DRRR', value: negProof.value, nodes: negProof.nodes,
          proofElapsedMs: ms(negProofMs),
          shadowTotalMs: ms(negShadowMs), shadowWitnessMs: ms(negShadow.witnessMs),
          note: 'On NO_WIN the shadow tool additionally runs an existential witness search. That search is diagnostic only and never changes the verdict.',
        },
      },
      answers: {
        isReductionCoreOrOptional: 'The witness line, static reach and existential witness search are OPTIONAL diagnostics. The proof is L1 and the certificate is L2; neither reads any of them.',
        verdictsByteIdentical: JSON.stringify(proofFields(l1)) === JSON.stringify(proofFields(l2)),
        costStillAbove100ms: l1Ms > 100,
        proofNecessaryMs: ms(l1Ms),
        certificateMs: ms(l2Ms),
        optionalDiagnosticsMs: { witnessLine: ms(witMs), staticReach: ms(reachMs), noWinWitnessSearchPriorRound: 5868 },
        hotspots: [
          'generatePreparedSearchActions is rebuilt at every node: ~93-230 microseconds per node, which is the dominant term (65585 nodes => ~6 s).',
          'stateKey + `${idx}|${key}` string building happens for every visited and memo-hit state (58328 memo hits).',
          'The independent verifier has no memo and re-walks the ∀-tree: 110921 leaves for 65585 unique nodes; at the G1T9 root this exceeds the 600k leaf cap.',
          'The shadow witness search is an independent second traversal (only when NO_WIN); it is the ~5.9 s tail in the prior round.',
        ],
      },
      host: res,
    };
    mkdirSync(LOG, { recursive: true });
    writeFileSync(`${OUT}/WITNESS_COST_ABLATION.json`, JSON.stringify(data, null, 2));
    expect(data.answers.costStillAbove100ms).toBe(true);
  }, 3_600_000);
});