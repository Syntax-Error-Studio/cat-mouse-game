/// <reference types="node" />
/**
 * G4 — PCV quantifier proofs over the FROZEN candidates (task book §7).
 *
 * Reads CANDIDATE_FREEZE.json only. Never re-runs the D2 search, never
 * regenerates candidates, never filters them. H0 (mouseForce) on every frozen
 * candidate; H1 (catSurvive) only where H0 did not yield a valid PROVEN cert.
 *
 * Every positive-probability frontier branch is ANDed. Repetition is by fresh
 * process: PPC_REP selects the output file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runH0, runH1, writeJson, OUT, sha256, canonicalJson, loadRoot, stateKey, summarizeState } from './d2_lib';
import { applyPrefix } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import type { GameEngineState } from '../../src/game/engine';

const REP = process.env.PPC_REP ?? '1';
const FREEZE = `${OUT}/CANDIDATE_FREEZE.json`;

describe(`G4 proofs rep${REP}`, () => {
  it('G1T9/E1 frozen candidates', () => {
    const freeze = JSON.parse(readFileSync(FREEZE, 'utf8')) as {
      contentSha256: string; rootId: string; arm: string; candidateCount: number;
      proofContract: unknown;
      basis: { plans: { legalIndex: number; rootAction: string; planString: string; planHash: string; postPrefixStateKey: string }[] };
    };

    expect(freeze.candidateCount).toBe(4);
    const root = loadRoot(freeze.rootId);

    const records = freeze.basis.plans.map((p) => {
      const pre = applyPrefix(root, [...p.planString], 0);
      if (!pre.ok) throw new Error(`frozen plan no longer replays: ${p.planString}`);
      const branches = pre.states.map((s: GameEngineState) => ({
        state: s,
        weight: 1, // deterministic boundary (single branch) — see freeze basis chanceBranchCount
      }));

      const h0 = runH0(branches);
      const h1 = h0.allProven ? null : runH1(branches);

      return {
        legalIndex: p.legalIndex,
        rootAction: p.rootAction,
        planString: p.planString,
        planHash: p.planHash,
        frozenPostStateKey: p.postPrefixStateKey,
        replayPostStateKey: pre.states.map((s: GameEngineState) => stateKey(s)),
        stateIdentityMatch: pre.states.length === 1 && stateKey(pre.states[0]) === p.postPrefixStateKey,
        frontierCanonicalSha256: sha256(canonicalJson(pre.states.map((s: GameEngineState) => summarizeState(s)))),
        frontierIdx: pre.idx,
        h0,
        h1,
        H0_VALID_REFUTATION: h0.allProven,
        H1_VALID_SURVIVAL: h1 !== null && h1.allProven,
        ALL_CHANCE_BRANCHES_VERIFIED: h0.branches.length === pre.states.length && h0.allProven,
      };
    });

    const h0Refuted = records.filter((r) => r.H0_VALID_REFUTATION).length;
    const h1Proven = records.filter((r) => r.H1_VALID_SURVIVAL).length;

    const payload = {
      round: 'PPC-D2-PCV-COUNTERLINE-01',
      phase: 'G4_PCV_PROOF',
      rep: Number(REP),
      processStartedAt: new Date().toISOString(),
      freezeContentSha256: freeze.contentSha256,
      candidateCount: freeze.candidateCount,
      proofContract: freeze.proofContract,
      uniqueFrontierCount: new Set(records.map((r) => r.frontierCanonicalSha256)).size,
      h0Refuted,
      h0Unresolved: records.length - h0Refuted,
      h1SurvivalProven: h1Proven,
      h1Unresolved: records.filter((r) => !r.H0_VALID_REFUTATION && !r.H1_VALID_SURVIVAL).length,
      PROVEN_TACTICAL_RESCUE: h1Proven,
      records,
    };
    writeJson(`${OUT}/D2_PILOT_PROOF_REP${REP}.json`, payload);
    writeJson(`${OUT}/logs/proof_rep${REP}_projection.json`, {
      rep: Number(REP),
      projectionSha256: sha256(canonicalJson({
        h0: records.map((r) => [r.legalIndex, r.h0.allProven, r.h0.branches.map((b) => [b.value, b.proofStatus, b.nodes, b.verifyVerdict, b.policyMisses])]),
        h1: records.map((r) => (r.h1 ? [r.legalIndex, r.h1.allProven, r.h1.branches.map((b) => [b.value, b.proofStatus, b.nodes, b.verifyVerdict])] : null)),
        postKeys: records.map((r) => r.replayPostStateKey),
      })),
    });

    console.log(`--- PROOF REP${REP} ---`);
    for (const r of records) {
      console.log(`#${r.legalIndex} ${r.rootAction} ${r.planString} `
        + `H0=${r.h0.branches.map((b) => `${b.proofStatus}/${b.nodes}n/${b.solveMs}ms`).join(',')} `
        + `H1=${r.h1 ? r.h1.branches.map((b) => `${b.proofStatus}/${b.nodes}n`).join(',') : 'SKIPPED(H0_PROVEN)'}`);
    }
    console.log(`H0_REFUTED=${h0Refuted}/${records.length} H1_PROVEN=${h1Proven} uniqueFrontiers=${payload.uniqueFrontierCount}`);
    console.log('--- END ---');

    expect(payload.uniqueFrontierCount).toBeGreaterThan(0);
  });
});
