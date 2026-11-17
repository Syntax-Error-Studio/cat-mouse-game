/// <reference types="node" />
/**
 * G2/G3 — D2 candidate extraction + freeze (task book §5.3 / §5.4 / §6).
 *
 * ORDER IS PART OF THE CONTRACT:
 *   search -> per-root-action extraction -> real-RuleSet replay -> counterline
 *   -> WRITE FREEZE -> only then may proofs run (separate process).
 * This file never touches a quantifier result.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  runD2Search, extractCandidates, walkMouseCounterline, determinismProjection,
  writeJson, OUT, ROOT_ID, ARM, DEPTH_TURNS, MAX_NODES, H0_CAP, H1_CAP, H0_H, H1_H, START_IDX,
  sha256, label, stateKey, summarizeState, canonicalJson,
} from './d2_lib';
import { applyPrefix } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import type { GameEngineState } from '../../src/game/engine';

describe('G2/G3 freeze', () => {
  it('G1T9/E1 D2 candidates', () => {
    const { root, ctx, run, prepared } = runD2Search();
    const extraction = extractCandidates(root, ctx, prepared, run.rootValues);

    // --- frontier states (real GameEngineState) + principal mouse counterline
    const frontierByCandidate: Record<number, { states: GameEngineState[]; idx: number[] }> = {};
    const counterlines = extraction.candidates.map((c) => {
      if (!c.extracted) {
        return { legalIndex: c.legalIndex, rootAction: c.rootAction, extracted: false, counterlines: [] };
      }
      const pre = applyPrefix(root, c.catTurnPlan, 0);
      frontierByCandidate[c.legalIndex] = { states: pre.states, idx: pre.idx };
      const lines = pre.states.map((s, i) => walkMouseCounterline(s, ctx, i));
      return {
        legalIndex: c.legalIndex,
        rootAction: c.rootAction,
        planString: c.planString,
        extracted: true,
        frontierOk: pre.ok,
        frontierCount: pre.states.length,
        frontierIdx: pre.idx,
        counterlines: lines,
      };
    });

    // --- artifacts
    writeJson(`${OUT}/D2_PILOT_ROOT_VALUES.json`, {
      round: 'PPC-D2-PCV-COUNTERLINE-01',
      phase: 'G2_ROOT_VALUES',
      rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS,
      searchMode: 'FIXED_DEPTH_D2',
      maxNodes: MAX_NODES,
      completed: run.completed,
      value: run.value, mate: run.mate,
      nodes: run.nodes, leafNodes: run.leafNodes, chanceNodes: run.chanceNodes,
      elapsedMs: run.elapsedMs,
      legalRootActionCount: run.legalRootActionCount,
      rootValuesLength: run.rootValuesLength,
      rootOrderAligned: run.rootOrderAligned,
      rootOrderMismatch: run.rootOrderMismatch,
      diagnostics: run.diagnostics,
      gates: run.gates,
      rootValues: run.rootValues,
      note: 'bound is a CONSTANT (exact) when useAlphaBeta=false; it is not a criterion here.',
    });

    writeJson(`${OUT}/D2_PILOT_PLAN_REPLAYS.json`, {
      round: 'PPC-D2-PCV-COUNTERLINE-01',
      phase: 'G2_PLAN_REPLAYS',
      rootId: ROOT_ID,
      replayDriver: 'replayPlan (PPC-T1-PCV-01/probe/pcv_lib.ts, real generatePreparedSearchActions)',
      crossCheckDriver: 'applyPrefix (PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts)',
      candidates: extraction.candidates.map((c) => ({
        legalIndex: c.legalIndex,
        rootAction: c.rootAction,
        extracted: c.extracted,
        rejection: c.rejection,
        planString: c.planString,
        replayOk: c.replayOk,
        replayStatus: c.replayStatus,
        replayReason: c.replayReason,
        replayCrossCheck: c.replayCrossCheck,
        replaySteps: c.replaySteps,
        postPrefixStateKey: c.postPrefixStateKey,
        postPrefixStateKeys: c.postPrefixStateKeys,
        chanceBranchCount: c.chanceBranchCount,
        chanceProbabilitySum: c.chanceProbabilitySum,
        chanceAllPositive: c.chanceAllPositive,
      })),
    });

    writeJson(`${OUT}/D2_PILOT_COUNTERLINES.json`, {
      round: 'PPC-D2-PCV-COUNTERLINE-01',
      phase: 'G2_COUNTERLINES',
      rootId: ROOT_ID,
      marker: 'PRINCIPAL_COUNTERLINE_NOT_EXHAUSTIVE_PROOF',
      note: 'One principal mouse line per frontier branch, taken from ctx.planBranches. '
        + 'A single principal line is NOT a proof over all mouse strategies, and a CHANCE '
        + 'fork is not collapsed: every outcome is recorded in steps[].outcomes.',
      candidates: counterlines,
    });

    writeJson(`${OUT}/D2_PILOT_CANDIDATES.json`, {
      round: 'PPC-D2-PCV-COUNTERLINE-01',
      phase: 'G2_CANDIDATES',
      rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS,
      candidateSource: 'OFFLINE_REGENERATED_D2',
      search: {
        completed: run.completed, value: run.value, mate: run.mate,
        nodes: run.nodes, leafNodes: run.leafNodes, chanceNodes: run.chanceNodes,
        elapsedMs: run.elapsedMs, planBranchEntries: run.planBranchEntries,
        diagnostics: run.diagnostics, gates: run.gates,
      },
      extraction: {
        legalRootActions: extraction.legalRootActions,
        extracted: extraction.extracted,
        rejected: extraction.rejected,
        rejectionByClass: extraction.rejectionByClass,
        identityFailures: extraction.identityFailures,
      },
      candidates: extraction.candidates.map((c) => {
        const fr = frontierByCandidate[c.legalIndex];
        return {
          ...c,
          planActions: undefined,
          postPrefixCanonicalSnapshot: fr
            ? canonicalJson(fr.states.map((s) => summarizeState(s)))
            : c.postPrefixCanonicalSnapshot,
          postPrefixSnapshotSha256V2: fr
            ? sha256(canonicalJson(fr.states.map((s) => ({
              key: stateKey(s), summary: summarizeState(s),
            })))) : null,
        };
      }),
    });

    // --- G3 freeze
    const frozenAt = new Date().toISOString();
    const freezeBasis = {
      rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS,
      candidateCount: extraction.extracted,
      plans: extraction.candidates.map((c) => ({
        legalIndex: c.legalIndex, rootAction: c.rootAction, planString: c.planString,
        planHash: c.planHash, postPrefixStateKey: c.postPrefixStateKey,
        postPrefixStateKeys: c.postPrefixStateKeys,
        chanceBranchCount: c.chanceBranchCount, chanceProbabilitySum: c.chanceProbabilitySum,
      })),
    };
    const freeze = {
      round: 'PPC-D2-PCV-COUNTERLINE-01',
      phase: 'G3_CANDIDATE_FREEZE',
      frozenAt,
      rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS,
      PROOFS_RUN_BEFORE_FREEZE: false,
      CANDIDATE_COUNT_REDUCED: false,
      TOP_K_FILTER: 'NONE',
      candidateCount: extraction.extracted,
      legalRootActionCount: extraction.legalRootActions,
      identityFailureCount: extraction.identityFailures,
      rejectionByClass: extraction.rejectionByClass,
      contentSha256: sha256(canonicalJson(freezeBasis)),
      basis: freezeBasis,
      proofContract: {
        h0: { mode: 'mouseForce', H: H0_H, startIdx: START_IDX, cap: H0_CAP },
        h1: { mode: 'catSurvive', H: H1_H, startIdx: START_IDX, cap: H1_CAP },
        chanceHandling: 'AND over every positive-probability frontier branch',
        verifier: 'independent (verifyMouseCertificate / verifyCatCertificate)',
      },
      determinismProjectionSha256: sha256(determinismProjection({ run, extraction })),
      searchDiagnostics: run.diagnostics,
    };
    writeJson(`${OUT}/CANDIDATE_FREEZE.json`, freeze);

    console.log('--- FREEZE ---');
    console.log('legalRootActions =', extraction.legalRootActions);
    console.log('extracted        =', extraction.extracted);
    console.log('rejected         =', extraction.rejected, JSON.stringify(extraction.rejectionByClass));
    console.log('contentSha256    =', freeze.contentSha256);
    for (const c of extraction.candidates) {
      console.log(`  #${c.legalIndex} ${c.rootAction} plan=${c.planString || '(none)'} `
        + `status=${c.replayStatus} chance=${c.chanceBranchCount} rej=${c.rejection ?? '-'}`);
    }
    console.log('--- END FREEZE ---');

    expect(extraction.legalRootActions).toBe(4);
    expect(run.completed).toBe(true);
    expect(run.gates.ZERO_REPETITIONS).toBe(true);
  });
});
