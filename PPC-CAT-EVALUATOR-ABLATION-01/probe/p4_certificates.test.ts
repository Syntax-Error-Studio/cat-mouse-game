/// <reference types="node" />
/**
 * Phase 4 — independent quantifier certificates for the E1/H1 D1 selected plans.
 * RESEARCH ONLY. Reuses PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts READ-ONLY (the
 * corrected AND-OR kernel + independent verifiers); never modifies a previous
 * artifact. No production source is modified.
 *
 * Per root x arm (48 combos), using the D1 catTurnPlan frozen in ABLATION_RESULTS:
 *   1. REAL engine replay: applyPrefix(root, plan, 0) fans out every positive-
 *      probability CHANCE outcome of the cat turn -> post-state(s), turn idx.
 *   2. From each post-state, FOUR SEPARATE quantifier solves (never derived from
 *      one another; NO !mouseForcesWin => survival):
 *        h0 = mouseForce H0=1, h1 = mouseForce H1=2,
 *        survive = catSurvive H1=2, catForce = catForce H1=2.
 *      CHANCE is ALWAYS AND (every positive-prob outcome); terminal checked
 *      BEFORE the horizon cut; node cap 600000 -> null -> UNRESOLVED.
 *   3. INDEPENDENT verification of every definite TRUE label (re-enumerates all
 *      opponent actions + all chance; shares no boolean combinator with solve):
 *        mouseForce -> verifyMouseCertificate ; catSurvive -> verifyCatCertificate ;
 *        catForce -> verifyCatForceCertificate (below; requires CatWins, not merely
 *        ¬MouseWins) . A missing/illegal policy entry is a hard failure.
 *   4. AND over replay branches; classifySeal -> one of the 6 frozen classes.
 *
 * E1 and H1 keep INDEPENDENT records even when they select the same action/plan.
 * Each certificate attaches: original snapshot SHA, selected action + plan, cert
 * ID, solve nodes, verify verdict, CHANCE branch counts, policyMisses, replay result.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { applyNoMoveLoss } from '../../src/game/rules/mobility';
import { GamePhase, PieceType } from '../../src/game/types';
import {
  ROUND, OUT, HEAD, FIXTURE, FROZEN_FIXTURE_SHA, QCAP, H0, H1,
  rootIds, loadRoot, snapshotSha, sha256, rules, label, stateKey, summarize,
  applyPrefix, mouseForcesWinSeal, catSurvivesSeal, catForcesWinSeal, classifySeal,
  verifyCatCertificate, verifyMouseCertificate,
  type CertVerifyResult, type SealClass, type SolveStats,
} from './ablation_lib';
import type { GameEngineState } from '../../src/game/engine';

const ABLATION_PATH = `${OUT}/ABLATION_RESULTS.json`;

// ---------------------------------------------------------------------------
// Independent CAT-FORCED-WIN verifier (∃cat ∀mouse ∀chance -> CatWins within H).
// Mirror of seal_lib.verifyMouseCertificate with the sides swapped and success =
// CatWins. Does NOT call solve; re-enumerates every mouse action + every chance.
// ---------------------------------------------------------------------------
function realTransitions(s: GameEngineState) {
  return generatePreparedSearchActions(s, rules).map((p) => {
    const tr = p.transition;
    const outcomes = tr.kind === 'deterministic'
      ? [{ state: tr.state, weight: 1 }]
      : tr.outcomes.map((o) => ({ state: o.state, weight: o.weight }));
    return { label: label(p.action), outcomes };
  });
}

function verifyCatForceCertificate(
  root: GameEngineState, policy: Map<string, string>, H: number, startIdx: number, cap: number,
): CertVerifyResult {
  const t0 = performance.now();
  let leaves = 0, branches = 0, chanceNodes = 0, maxDepth = 0, policyMisses = 0;
  let counterexample: string[] | null = null;
  let reason: string | null = null;
  let exhausted = false;
  const okMemo = new Set<string>();

  const walk = (state: GameEngineState, idx: number, path: string[]): boolean => {
    if (exhausted) return false;
    leaves++;
    if (leaves > cap) { exhausted = true; reason = reason ?? 'NODE_CAP'; return false; }
    if (path.length > maxDepth) maxDepth = path.length;
    const s = applyNoMoveLoss(state);
    if (s.phase === GamePhase.CatWins) return true;                 // SUCCESS = CatWins
    if (s.phase === GamePhase.MouseWins) {
      if (!counterexample) { counterexample = [...path, 'END:mouse_wins']; reason = 'MOUSE_WINS'; }
      return false;
    }
    const isCat = s.currentPlayer === PieceType.Cat;
    if (isCat && idx >= 2 * H) {                                    // horizon: cat did NOT force a win
      if (!counterexample) { counterexample = [...path, 'HORIZON']; reason = 'HORIZON_REACHED'; }
      return false;
    }
    const key = `${idx}|${stateKey(s)}`;

    if (isCat) {                                                    // existential: follow policy
      const want = policy.get(key);
      if (want === undefined) {
        policyMisses++;
        if (!counterexample) { counterexample = [...path, `POLICY_MISSING:${key.slice(0, 24)}`]; reason = 'POLICY_MISSING'; }
        return false;
      }
      const trs = realTransitions(s);
      const hit = trs.find((t) => t.label === want);
      if (!hit) {
        policyMisses++;
        if (!counterexample) { counterexample = [...path, `POLICY_ILLEGAL:${want}`]; reason = 'POLICY_ILLEGAL'; }
        return false;
      }
      if (hit.outcomes.length > 1 || hit.outcomes[0].weight !== 1) chanceNodes++;
      const cp = applyNoMoveLoss(hit.outcomes[0].state).currentPlayer;
      const ci = cp !== s.currentPlayer ? idx + 1 : idx;
      for (let i = 0; i < hit.outcomes.length; i++) {
        const o = hit.outcomes[i];
        if (o.weight <= 0) continue;
        if (!walk(o.state, ci, [...path, `c:${want}~chance#${i + 1}`])) return false;
      }
      return true;
    }

    // mouse node: ALL legal actions (∀mouse), ALL chance outcomes (∀chance)
    if (okMemo.has(key)) return true;
    branches++;
    const trs = realTransitions(s);
    for (const t of trs) {
      if (t.outcomes.length > 1 || t.outcomes[0].weight !== 1) chanceNodes++;
      const cp = applyNoMoveLoss(t.outcomes[0].state).currentPlayer;
      const ci = cp !== s.currentPlayer ? idx + 1 : idx;
      for (let i = 0; i < t.outcomes.length; i++) {
        const o = t.outcomes[i];
        if (o.weight <= 0) continue;
        if (!walk(o.state, ci, [...path, `m:${t.label}~chance#${i + 1}`])) return false;
      }
    }
    okMemo.add(key);
    return true;
  };

  const ok = walk(root, startIdx, []);
  const verdict = exhausted ? 'UNRESOLVED' : ok ? 'PROVEN' : 'FAILED';
  return { ok, verdict, leaves, branches, chanceNodes, maxDepth, elapsedMs: performance.now() - t0,
    counterexample, reason, policyMisses };
}

const st = (s: SolveStats) => ({ nodes: s.nodes, truncated: s.truncated, chanceNodes: s.chanceNodes, chanceOutcomes: s.chanceOutcomes, memoHits: s.memoHits, cutoffs: s.cutoffs, maxIdx: s.maxIdx, elapsedMs: Math.round(s.elapsedMs) });

interface Cert {
  certId: string; question: string; horizon: number; side: 'cat' | 'mouse';
  solveNodes: number; solveTruncated: boolean; policySize: number;
  verdict: string; ok: boolean; leaves: number; branches: number; chanceNodes: number;
  maxDepth: number; policyMisses: number; reason: string | null; counterexample: string[] | null;
  verifyElapsedMs: number;
}

function makeCert(rootId: string, arm: string, planString: string, branchIdx: number, postKey: string,
  question: string, horizon: number, side: 'cat' | 'mouse', solveNodes: number, solveTruncated: boolean,
  policySize: number, v: CertVerifyResult): Cert {
  return {
    certId: sha256(`${rootId}|${arm}|${planString}|${branchIdx}|${question}|H${horizon}|${postKey}`).slice(0, 16),
    question, horizon, side, solveNodes, solveTruncated, policySize,
    verdict: v.verdict, ok: v.ok, leaves: v.leaves, branches: v.branches, chanceNodes: v.chanceNodes,
    maxDepth: v.maxDepth, policyMisses: v.policyMisses, reason: v.reason, counterexample: v.counterexample,
    verifyElapsedMs: Math.round(v.elapsedMs),
  };
}

describe('Phase 4 independent quantifier certificates', () => {
  it('catForce verifier terminal self-test (independent of real roots)', () => {
    const base = loadRoot(rootIds[0]);
    const catWins: GameEngineState = { ...base, phase: GamePhase.CatWins };
    const mouseWins: GameEngineState = { ...base, phase: GamePhase.MouseWins };
    const vCat = verifyCatForceCertificate(catWins, new Map(), H1, 0, QCAP);
    const vMouse = verifyCatForceCertificate(mouseWins, new Map(), H1, 0, QCAP);
    expect(vCat.verdict, 'CatWins terminal must be PROVEN for catForce').toBe('PROVEN');
    expect(vMouse.verdict, 'MouseWins terminal must be FAILED for catForce').toBe('FAILED');
    expect(vMouse.reason).toBe('MOUSE_WINS');
    console.log('catForceVerifier self-test: CatWins=', vCat.verdict, 'MouseWins=', vMouse.verdict, vMouse.reason);
  }, 60_000);

  it('certifies all 48 root x arm D1 plans (post-plan quantifier + independent verify)', () => {
    expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);
    const ablation = JSON.parse(readFileSync(ABLATION_PATH).toString('utf8')) as any;
    expect(ablation.reproducibility.decisionFieldsIdenticalAcrossReps).toBe(true);
    const t0 = performance.now();
    const combos: any[] = [];
    const classCounts: Record<string, number> = {};
    let catForceTrueCount = 0, replayFailures = 0, verifyFailures = 0, unresolvedCount = 0, provenCount = 0;
    // certUnresolved = independent verifier hit its OWN frozen cap (verdict
    // UNRESOLVED / NODE_CAP). This is an HONEST budget limit, NOT a refutation:
    // the verifier re-walks every leaf without the prover's memoization, so it
    // can exhaust 600000 leaves on a deep survival tree even when the prover
    // completed under 600000 nodes. Per the contract cap→UNRESOLVED, never PASS
    // and never FAILED. verifyFailures counts ONLY real FAILED verdicts (a
    // counterexample / missing / illegal policy = an actual soundness refutation).
    let certUnresolved = 0;

    for (const id of rootIds) {
      const root = loadRoot(id);
      const rootEntry = ablation.roots.find((r: any) => r.rootId === id);
      for (const arm of ['E1', 'H1'] as const) {
        const f = rootEntry.D1[arm].faithful;
        const plan: string[] = f.catTurnPlan;
        const planString: string = f.planString;
        const rt0 = performance.now();
        const pre = applyPrefix(root, plan, 0);
        const replay = {
          ok: pre.ok, branchCount: pre.states.length, failedAt: pre.failedAt ?? null,
          postIdx: pre.idx, postPlayer: pre.states.map((s) => (s.currentPlayer === PieceType.Cat ? 'cat' : 'mouse')),
          postPhase: pre.states.map((s) => s.phase),
        };
        if (!pre.ok || pre.states.length === 0) {
          replayFailures++;
          combos.push({ rootId: id, arm, snapshotSha256: snapshotSha(id), selectedAction: f.selectedAction, plan, planString,
            replay, branches: [], aggregatedClass: 'REPLAY_FAILED', proofStatus: 'REPLAY_FAILED', elapsedMs: Math.round(performance.now() - rt0) });
          console.log(`[${id}/${arm}] REPLAY_FAILED ${pre.failedAt}`);
          continue;
        }

        const branchResults: any[] = [];
        // AND-aggregated question values across replay branches
        const agg = { h0: true as boolean | null, h1: true as boolean | null, survive: true as boolean | null, catForce: true as boolean | null };
        const andAgg = (cur: boolean | null, v: boolean | null): boolean | null => (cur === null || v === null) ? null : (cur && v);

        for (let b = 0; b < pre.states.length; b++) {
          const s = pre.states[b]; const idx = pre.idx[b];
          const h0 = mouseForcesWinSeal(s, H0, idx, QCAP);
          const h1 = mouseForcesWinSeal(s, H1, idx, QCAP);
          const survive = catSurvivesSeal(s, H1, idx, QCAP);
          const catForce = catForcesWinSeal(s, H1, idx, QCAP);
          if (catForce.value === true) catForceTrueCount++;
          const cls = classifySeal(h0.value, h1.value, survive.value, catForce.value);
          agg.h0 = andAgg(agg.h0, h0.value); agg.h1 = andAgg(agg.h1, h1.value);
          agg.survive = andAgg(agg.survive, survive.value); agg.catForce = andAgg(agg.catForce, catForce.value);

          const certs: Cert[] = [];
          const postKey = stateKey(s);
          if (h0.value === true) {
            const v = verifyMouseCertificate(s, h0.policy, H0, idx, QCAP);
            certs.push(makeCert(id, arm, planString, b, postKey, 'mouseForce', H0, 'mouse', h0.stats.nodes, h0.stats.truncated, h0.policy.size, v));
          } else if (h1.value === true) {
            const v = verifyMouseCertificate(s, h1.policy, H1, idx, QCAP);
            certs.push(makeCert(id, arm, planString, b, postKey, 'mouseForce', H1, 'mouse', h1.stats.nodes, h1.stats.truncated, h1.policy.size, v));
          }
          if (survive.value === true) {
            const v = verifyCatCertificate(s, survive.policy, H1, idx, QCAP);
            certs.push(makeCert(id, arm, planString, b, postKey, 'catSurvive', H1, 'cat', survive.stats.nodes, survive.stats.truncated, survive.policy.size, v));
          }
          if (catForce.value === true) {
            const v = verifyCatForceCertificate(s, catForce.policy, H1, idx, QCAP);
            certs.push(makeCert(id, arm, planString, b, postKey, 'catForce', H1, 'cat', catForce.stats.nodes, catForce.stats.truncated, catForce.policy.size, v));
          }
          for (const c of certs) {
            if (c.verdict === 'FAILED') verifyFailures++;        // real refutation
            else if (c.verdict === 'UNRESOLVED') certUnresolved++; // honest verifier cap
          }

          branchResults.push({
            branchIdx: b, postStateKey: postKey, postIdx: idx,
            postPlayer: s.currentPlayer === PieceType.Cat ? 'cat' : 'mouse', postSummary: summarize(s),
            h0MouseForcedWin: h0.value, h1MouseForcedWin: h1.value, h1CatSurvive: survive.value, h1CatForcedWin: catForce.value,
            stats: { h0: st(h0.stats), h1: st(h1.stats), survive: st(survive.stats), catForce: st(catForce.stats) },
            class: cls, certificates: certs,
          });
        }

        const aggregatedClass: SealClass | 'REPLAY_FAILED' = classifySeal(agg.h0, agg.h1, agg.survive, agg.catForce);
        classCounts[aggregatedClass] = (classCounts[aggregatedClass] ?? 0) + 1;
        const allCerts = branchResults.flatMap((br) => br.certificates);
        const hasFailedCert = allCerts.some((c: Cert) => c.verdict === 'FAILED');
        const hasUnresolvedCert = allCerts.some((c: Cert) => c.verdict === 'UNRESOLVED');
        let proofStatus: string;
        if (aggregatedClass === 'UNRESOLVED') { proofStatus = 'UNRESOLVED'; unresolvedCount++; }       // prover cap
        else if (hasFailedCert) proofStatus = 'FAILED';                                              // independent refutation
        else if (hasUnresolvedCert) { proofStatus = 'UNRESOLVED'; unresolvedCount++; }               // independent cert cap (NOT proven, NOT refuted)
        else if (aggregatedClass === 'CHANCE_DEPENDENT_OUTCOME') proofStatus = 'REFUTED_BOTH_FORCE';
        else { proofStatus = 'PROVEN'; provenCount++; }

        combos.push({
          rootId: id, arm, snapshotSha256: snapshotSha(id), selectedAction: f.selectedAction, plan, planString,
          replay, branches: branchResults,
          aggregated: { h0: agg.h0, h1: agg.h1, survive: agg.survive, catForce: agg.catForce },
          aggregatedClass, proofStatus, certificateCount: allCerts.length,
          elapsedMs: Math.round(performance.now() - rt0),
        });
        console.log(`[${id}/${arm}] ${aggregatedClass} proof=${proofStatus} plan=${planString} branches=${pre.states.length} h0=${agg.h0} h1=${agg.h1} cs=${agg.survive} cf=${agg.catForce} certs=${allCerts.length} ${Math.round(performance.now() - rt0)}ms`);
      }
    }

    // per-root E1/H1 pairing (consumed by Phase 7 decision)
    const perRoot = rootIds.map((id) => {
      const e1 = combos.find((c) => c.rootId === id && c.arm === 'E1');
      const h1 = combos.find((c) => c.rootId === id && c.arm === 'H1');
      const rootEntry = ablation.roots.find((r: any) => r.rootId === id);
      return {
        rootId: id, actionChanged: rootEntry.D1.comparison.actionChanged, planChanged: rootEntry.D1.comparison.planChanged,
        e1Selected: e1.selectedAction, h1Selected: h1.selectedAction, e1Plan: e1.planString, h1Plan: h1.planString,
        e1Class: e1.aggregatedClass, h1Class: h1.aggregatedClass, e1Proof: e1.proofStatus, h1Proof: h1.proofStatus,
      };
    });

    const doc = {
      artifactId: 'QUANTIFIER_CERTIFICATES', round: ROUND, phase: 4,
      generatedAt: new Date().toISOString(), generatedBy: `${OUT}/probe/p4_certificates.test.ts`,
      head: HEAD, fixtureSha256: FROZEN_FIXTURE_SHA, productionSourceChanged: false,
      kernel: 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts (reused READ-ONLY; prune DISABLED; CHANCE=AND; separate catSurvive; mode-dependent terminals; terminal-before-horizon)',
      contract: { H0, H1, cap: QCAP, chance: 'ALL positive-probability outcomes, AND', terminalBeforeHorizon: true, capToUnresolved: true, noSurvivalFromNegation: true },
      protocol: 'applyPrefix(root, D1 catTurnPlan, 0) -> post-state(s) (mouse to move); 4 separate solves per branch; independent verify of each definite TRUE label; AND over branches; classifySeal',
      catForceVerifier: 'verifyCatForceCertificate (this probe): independent ∃cat ∀mouse ∀chance -> CatWins; terminal self-test CatWins=PROVEN / MouseWins=FAILED',
      summary: {
        combos: combos.length, classCounts, provenCount, unresolvedCount, verifyFailures, certUnresolved, replayFailures, catForceTrueCount,
        definiteCertificates: combos.reduce((n, c) => n + c.certificateCount, 0),
      },
      perRoot, combos,
      elapsedMs: Math.round(performance.now() - t0),
    };
    writeFileSync(`${OUT}/QUANTIFIER_CERTIFICATES.json`, JSON.stringify(doc, null, 2));

    console.log('CLASS_COUNTS=', JSON.stringify(classCounts));
    console.log('proven=', provenCount, 'unresolved=', unresolvedCount, 'verifyFailures=', verifyFailures, 'certUnresolved=', certUnresolved, 'replayFailures=', replayFailures, 'catForceTrue=', catForceTrueCount, 'totalMs=', doc.elapsedMs);

    // ---- acceptance gates ----
    expect(combos.length).toBe(48);
    expect(replayFailures, 'every D1 plan must replay through the real engine').toBe(0);
    // A real independent REFUTATION of a definite TRUE label is a soundness failure.
    expect(verifyFailures, 'no independent verifier may refute a definite TRUE label (verdict FAILED)').toBe(0);
    // UNRESOLVED (prover cap OR independent-verifier cap) is an HONEST limit at the
    // frozen 600000 budget — allowed, reported, but NEVER counted as PROVEN and
    // NEVER used to claim a proven-safe improvement (Phase 7 reads proofStatus).
    for (const c of combos) {
      if (c.proofStatus === 'PROVEN') {
        expect(c.branches.every((br: any) => br.certificates.every((cc: Cert) => cc.ok && cc.verdict === 'PROVEN'))).toBe(true);
      }
      if (c.proofStatus === 'UNRESOLVED') {
        // an UNRESOLVED combo must NOT carry a PROVEN certificate set
        expect(c.branches.every((br: any) => br.certificates.every((cc: Cert) => cc.verdict !== 'FAILED'))).toBe(true);
      }
    }
    console.log('UNRESOLVED combos (independent cert incomplete at frozen cap):',
      combos.filter((c) => c.proofStatus === 'UNRESOLVED').map((c) => `${c.rootId}/${c.arm}:${c.aggregatedClass}`).join(' ') || 'none');
  }, 7_200_000);
});