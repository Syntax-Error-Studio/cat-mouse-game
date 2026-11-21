/// <reference types="node" />
/**
 * G2 — independent DUUD proof.
 *
 * The question is only: does the frozen, trusted SEAL quantifier + certificate
 * verifier, started at the post-plan MOUSE frontier with (H=2, startIdx=1),
 * prove that the mouse can force a win within two mouse turns? The shadow tool
 * is re-run as well, but only as SHADOW_REPRODUCED — it is not the authority.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  ROUND, QCAP, replayToFrontier, runProof, cheapOneTurn, shadowReference,
  witnessLine, summarizeState, hostResource, duplicateHeavyWorkers, resetPeakRss, peakRssMB,
  loadRoot,
} from './ttor_lib';
import { mouseForcesWinSeal, verifyMouseCertificate } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

const OUT = ROUND;
const LOG = `${ROUND}/logs`;

function admit() {
  const res = hostResource();
  const gate = { ...res, duplicates: duplicateHeavyWorkers(res), freeFloorMB: 1200 };
  expect(gate.freeMB, JSON.stringify(gate)).toBeGreaterThanOrEqual(1200);
  expect(gate.duplicates, JSON.stringify(gate)).toBe(0);
  return gate;
}

describe('G2 independent DUUD proof', () => {
  it('DUUD: exact two-mouse-turn forced win, independently verified', () => {
    const gate = admit();
    resetPeakRss();

    const f = replayToFrontier('G6T2', 'DUUD');
    expect(f.validMouseFrontier, f.ineligibleReason ?? '').toBe(true);
    expect(f.positiveOutcomes).toBe(1);

    const cheap = cheapOneTurn(f.states[0]);
    expect(cheap.value).toBe(false); // layer 1 alone cannot see it

    const proof = runProof(f.states[0], 'mouseForce', 2, 1, QCAP, QCAP);
    const peak1 = peakRssMB();
    expect(proof.truncated).toBe(false);
    expect(proof.value).toBe(true);
    expect(proof.verify?.verdict).toBe('PROVEN');
    expect(proof.verify?.policyMisses).toBe(0);
    expect(proof.verify?.counterexample).toBe(null);
    expect(proof.proofStatus).toBe('PROVEN');

    const wit = witnessLine(f.states[0], proof.policy, 2, 1);
    expect(wit.ok).toBe(true);

    const shadow = shadowReference(f.states[0]);
    expect(shadow.two.value).toBe(true);
    expect(shadow.one.forcedWinThisTurn).toBe(false);
    // Independent implementations must visit the same unique states.
    expect(proof.nodes).toBe(shadow.two.nodes);

    mkdirSync(LOG, { recursive: true });
    writeFileSync(`${OUT}/DUUD_INDEPENDENT_PROOF.json`, JSON.stringify({
      round: ROUND,
      question: 'Does DUUD (frozen G6T2 plan) leave the mouse a forced win within two mouse turns?',
      identity: {
        root: 'G6T2',
        plan: 'DUUD',
        fixture: 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json',
        rootSnapshotSha256: 'PER_ROOT_FIXTURE_FIELD',
        frontierStateKeys: f.frontierStateKeys,
        frontierState: summarizeState(f.states[0]),
        positiveChanceOutcomes: f.positiveOutcomes,
        totalChanceOutcomes: f.totalOutcomes,
        weights: f.weights,
      },
      quantifier: {
        meaning: '∃ mouse strategy ∀ cat play ∀ positive-probability CHANCE outcome → MouseWins',
        H: 2, startIdx: 1, cap: QCAP,
        window: 'mouse(1) + cat(2) + mouse(3); cat node idx>=4 is outside',
      },
      layer1: cheap,
      layer2: {
        value: proof.value, truncated: proof.truncated, nodes: proof.nodes,
        transitions: proof.transitions, chanceNodes: proof.chanceNodes,
        chanceOutcomes: proof.chanceOutcomes, memoHits: proof.memoHits,
        cutoffs: proof.cutoffs, maxIdx: proof.maxIdx,
        elapsedMs: Math.round(proof.elapsedMs), policySize: proof.policySize,
      },
      verifier: proof.verify && {
        verdict: proof.verify.verdict, ok: proof.verify.ok,
        leaves: proof.verify.leaves, branches: proof.verify.branches,
        chanceNodes: proof.verify.chanceNodes, maxDepth: proof.verify.maxDepth,
        policyMisses: proof.verify.policyMisses, counterexample: proof.verify.counterexample,
        elapsedMs: Math.round(proof.verify.elapsedMs),
      },
      witnessLine: wit,
      shadowReproduction: shadow,
      verdict: proof.proofStatus === 'PROVEN' && proof.verify?.verdict === 'PROVEN'
        ? 'INDEPENDENTLY_VERIFIED' : 'UNRESOLVED',
      peakRssMB: peak1,
      host: gate,
    }, null, 2));

    writeFileSync(`${OUT}/INDEPENDENT_VERIFIER_RESULT.json`, JSON.stringify({
      round: ROUND,
      verifier: 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts verifyMouseCertificate (frozen, read-only)',
      properties: {
        existentialSide: 'mouse: policy map `${idx}|${stateKey}` -> action label',
        universalSide: 'cat: every legal action is re-enumerated from the real RuleSet',
        chance: 'every positive-probability outcome is re-enumerated; zero-weight outcomes skipped',
        pruning: 'none',
        terminalAndCut: 'terminal before horizon; a cat node at idx>=2H is outside',
        policyMissTotal: proof.verify?.policyMisses,
        nodeCap: QCAP,
      },
      result: {
        verdict: proof.verify?.verdict, ok: proof.verify?.ok,
        leaves: proof.verify?.leaves, branches: proof.verify?.branches,
        chanceNodes: proof.verify?.chanceNodes, maxDepth: proof.verify?.maxDepth,
        counterexample: proof.verify?.counterexample, reason: proof.verify?.reason,
        elapsedMs: proof.verify && Math.round(proof.verify.elapsedMs),
      },
      witnessLine: { steps: wit.line.length, head: wit.line.slice(0, 8), ok: wit.ok },
      claimScope: 'Two mouse turns from the DUUD post-plan frontier. Never reusable on another root or frontier.',
    }, null, 2));

    expect(proof.proofStatus).toBe('PROVEN');
  }, 3_600_000);

  it('UURR positive control: same instrument, same window, independent certificate', () => {
    const gate = admit();
    const f = replayToFrontier('G6T2', 'UURR');
    expect(f.validMouseFrontier).toBe(true);
    const proof = runProof(f.states[0], 'mouseForce', 2, 1, QCAP, QCAP);
    expect(proof.value).toBe(true);
    expect(proof.verify?.verdict).toBe('PROVEN');
    const shadow = shadowReference(f.states[0]);
    expect(shadow.two.value).toBe(true);
    expect(proof.nodes).toBe(shadow.two.nodes);

    writeFileSync(`${LOG}/g2_control_uud.json`, JSON.stringify({
      control: 'UURR', identity: { frontierStateKeys: f.frontierStateKeys, state: summarizeState(f.states[0]) },
      proof: {
        value: proof.value, truncated: proof.truncated, nodes: proof.nodes,
        elapsedMs: Math.round(proof.elapsedMs), policySize: proof.policySize,
        verify: proof.verify && {
          verdict: proof.verify.verdict, leaves: proof.verify.leaves,
          policyMisses: proof.verify.policyMisses, counterexample: proof.verify.counterexample,
          elapsedMs: Math.round(proof.verify.elapsedMs),
        },
      },
      shadow, host: gate,
    }, null, 2));
  }, 3_600_000);

  it('DRRR negative control: no forced win inside the window, and it is NOT inverted into cat survival', () => {
    const gate = admit();
    const f = replayToFrontier('G6T2', 'DRRR');
    expect(f.validMouseFrontier).toBe(true);
    const proof = runProof(f.states[0], 'mouseForce', 2, 1, QCAP, QCAP);
    expect(proof.truncated).toBe(false);
    expect(proof.value).toBe(false);
    expect(proof.verify).toBe(null);
    expect(proof.proofStatus).toBe('NO_WIN');
    const shadow = shadowReference(f.states[0]);
    expect(shadow.two.value).toBe(false);
    expect(proof.nodes).toBe(shadow.two.nodes);

    writeFileSync(`${LOG}/g2_control_drrr.json`, JSON.stringify({
      control: 'DRRR', identity: { frontierStateKeys: f.frontierStateKeys, state: summarizeState(f.states[0]) },
      proof: { value: proof.value, truncated: proof.truncated, nodes: proof.nodes, elapsedMs: Math.round(proof.elapsedMs) },
      interpretation: 'NO_WIN is window-scoped (two mouse turns). It is NOT a cat-survival certificate and must never be reported as one.',
      shadow, host: gate,
    }, null, 2));
  }, 3_600_000);

  it('G1T9 root label: independently re-proved at the ROOT window and matched to the plan frontier', () => {
    const gate = admit();
    const root = loadRoot('G1T9');
    const t0 = performance.now();
    const rootSolve = mouseForcesWinSeal(root, 2, 0, QCAP);
    const rootMs = performance.now() - t0;
    expect(rootSolve.value).toBe(true);
    expect(rootSolve.stats.truncated).toBe(false);
    // Cross-kernel comparison (NOT an identity claim): the frozen STRATEGY-01
    // artifact recorded h1Nodes = 66749 for this root, while the boolean SEAL
    // kernel visits more states because it has no reachability prune and a
    // different OR ordering. Same boolean, different search trace.
    expect(rootSolve.stats.nodes).toBeGreaterThan(66_749);
    const rootVerify = verifyMouseCertificate(root, rootSolve.policy, 2, 0, QCAP);
    // The verifier has no memo and re-walks the whole ∀-tree: at the ROOT window
    // it exhausts the frozen 600k leaf cap. Reported, never papered over.
    expect(rootVerify.verdict).toBe('UNRESOLVED');
    expect(rootVerify.reason).toBe('NODE_CAP');
    expect(rootVerify.policyMisses).toBe(0);

    const f = replayToFrontier('G1T9', 'LLLD');
    expect(f.validMouseFrontier).toBe(true);
    const planProof = runProof(f.states[0], 'mouseForce', 2, 1, QCAP, QCAP);
    expect(planProof.value).toBe(true);
    expect(planProof.verify?.verdict).toBe('PROVEN');

    writeFileSync(`${LOG}/g2_g1t9_root_equiv.json`, JSON.stringify({
      purpose: 'test whether the root-level STRATEGY label and the post-plan frontier window are the same mouse question',
      rootWindow: {
        call: 'mouseForcesWinSeal(root, H=2, startIdx=0)',
        value: rootSolve.value, nodes: rootSolve.stats.nodes, truncated: rootSolve.stats.truncated,
        elapsedMs: Math.round(rootMs),
        frozenCrossKernelNodes: {
          source: 'PPC-CAT-STRATEGY-01/ROOT_CLASSIFICATION.json G1T9.evidence.h1Nodes',
          value: 66_749, sealValue: rootSolve.stats.nodes, identical: false,
          why: 'STRATEGY kernel prunes mouse nodes with cannotReachHoleInHorizon and evaluates a value search; SEAL is a plain boolean quantifier. Same verdict, different trace.',
        },
        verify: {
          verdict: rootVerify.verdict, reason: rootVerify.reason, leaves: rootVerify.leaves,
          policyMisses: rootVerify.policyMisses, cap: QCAP,
        },
      },
      planWindow: {
        plan: 'LLLD', frontierStateKeys: f.frontierStateKeys,
        call: 'mouseForcesWinSeal(frontier, H=2, startIdx=1)',
        value: planProof.value, nodes: planProof.nodes, truncated: planProof.truncated,
        verify: planProof.verify && { verdict: planProof.verify.verdict, leaves: planProof.verify.leaves },
      },
      conclusion: `The root label is SOLVE-corroborated by a second kernel: same boolean true, but the SEAL trace visits ${rootSolve.stats.nodes} nodes vs the frozen STRATEGY artifact 66749 (prune + value search), so node counts are NOT identical. The root certificate EXCEEDS the frozen 600k verifier leaf cap. It is therefore NOT counted as independently verified; the plan-window certificate (LLLD frontier) IS verified. The label is not a window contradiction with the plan-level layer-1 false.`,
      status: 'ROOT_LABEL_SOLVE_CORROBORATED_CERT_UNRESOLVED_AT_CAP',
      host: gate,
    }, null, 2));
  }, 3_600_000);
});