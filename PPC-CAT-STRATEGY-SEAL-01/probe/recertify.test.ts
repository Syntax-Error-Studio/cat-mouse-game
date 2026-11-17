/// <reference types="node" />
/**
 * Phase 4 — independent recertification of G6T2 / G6T3 with the CORRECTED
 * quantifier kernel (seal_lib). No production source is modified; the previous
 * round's artifacts are left untouched. Corrected results are written here under
 * *_RECERTIFICATION.json / STRATEGY_CERTIFICATE_VERIFICATION.json.
 *
 * Every safety claim is carried by a SEPARATE catSurvive search (CHANCE = AND in
 * the success direction) plus an INDEPENDENT certificate verifier that shares no
 * boolean combinator with the prover and uses no prune.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import {
  mouseForcesWinSeal, catSurvivesSeal, catForcesWinSeal, classifySeal,
  verifyCatCertificate, verifyMouseCertificate, applyPrefix, prefixVerdict,
  legalLabels, summarize, canonicalJson,
} from './seal_lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const FROZEN_FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const OUT = 'PPC-CAT-STRATEGY-SEAL-01';
const H0 = 1, H1 = 2, CAP = 600_000;

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as { id: string; state: unknown; canonicalSnapshotSha256: string }[];
const load = (id: string): GameEngineState => restoreHardRoot(records.find((r) => r.id === id)!.state as never);
const snap = (id: string) => records.find((r) => r.id === id)!.canonicalSnapshotSha256;

const policyEntries = (p: Map<string, string>) => [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
const stat = (s: { nodes: number; transitions: number; chanceNodes: number; chanceOutcomes: number; memoHits: number; cutoffs: number; truncated: boolean; maxIdx: number; elapsedMs: number }) =>
  ({ ...s, elapsedMs: Math.round(s.elapsedMs) });

describe('Phase 4 G6T2/G6T3 recertification', () => {
  it('G6T2 root + openings + UURR/DRRR/DRDR + DR uniqueness', () => {
    expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);
    const root = load('G6T2');
    const t0 = performance.now();

    // --- root classification (four separate quantifier questions) ---
    const h0 = mouseForcesWinSeal(root, H0, 0, CAP);
    const h1 = mouseForcesWinSeal(root, H1, 0, CAP);
    const survive = catSurvivesSeal(root, H1, 0, CAP);
    const catForce = catForcesWinSeal(root, H1, 0, CAP);
    const rootClass = classifySeal(h0.value, h1.value, survive.value, catForce.value);

    // independent verification of the root survival certificate (if proven)
    let rootSurvivalVerify: unknown = null;
    if (survive.value === true) {
      const v = verifyCatCertificate(root, survive.policy, H1, 0, CAP);
      rootSurvivalVerify = { verdict: v.verdict, ok: v.ok, leaves: v.leaves, branches: v.branches,
        chanceNodes: v.chanceNodes, maxDepth: v.maxDepth, policyMisses: v.policyMisses,
        reason: v.reason, counterexample: v.counterexample, elapsedMs: Math.round(v.elapsedMs) };
      expect(v.ok, `G6T2 root survival certificate: ${v.reason}`).toBe(true);
    }

    // --- first steps U / D / L ---
    const firstSteps = ['U', 'D', 'L'].map((step) => {
      const sv = prefixVerdict(root, [step], H1, 0, CAP, catSurvivesSeal);
      const mf = prefixVerdict(root, [step], H1, 0, CAP, mouseForcesWinSeal);
      return { step, branches: sv.branches, catSurvive: sv.value, catSurvivePerBranch: sv.perBranch,
        mouseForcedWin: mf.value, mouseForcedWinPerBranch: mf.perBranch,
        safe: sv.value === true, losing: mf.value === true };
    });

    // --- full-turn prefixes UURR / DRRR / DRDR ---
    const prefixes = ['UURR', 'DRRR', 'DRDR'].map((name) => {
      const plan = name.split('');
      const sv = prefixVerdict(root, plan, H1, 0, CAP, catSurvivesSeal);
      const mf = prefixVerdict(root, plan, H1, 0, CAP, mouseForcesWinSeal);
      // independent certificate per boundary outcome (survival side)
      const pre = applyPrefix(root, plan, 0);
      const certs = pre.states.map((st, i) => {
        const r = catSurvivesSeal(st, H1, pre.idx[i], CAP);
        if (r.value !== true) return { branch: i, value: r.value, verified: null };
        const v = verifyCatCertificate(st, r.policy, H1, pre.idx[i], CAP);
        return { branch: i, value: r.value, policySize: r.policy.size,
          verified: { verdict: v.verdict, ok: v.ok, leaves: v.leaves, branches: v.branches,
            chanceNodes: v.chanceNodes, policyMisses: v.policyMisses, reason: v.reason,
            counterexample: v.counterexample } };
      });
      return { name, plan, branches: sv.branches, catSurvive: sv.value, catSurvivePerBranch: sv.perBranch,
        mouseForcedWin: mf.value, mouseForcedWinPerBranch: mf.perBranch, certificates: certs,
        endState: pre.ok ? summarize(pre.states[0]) : null };
    });

    // --- DR uniqueness: enumerate every legal 2-step cat prefix ---
    const level1 = legalLabels(root).map((l) => l.replace(/\*$/, ''));
    const twoStep: { prefix: string; ok: boolean; catSurvive: boolean | null; mouseForcedWin: boolean | null; branches: number }[] = [];
    for (const a of level1) {
      const p1 = applyPrefix(root, [a], 0);
      if (!p1.ok) continue;
      for (const st of p1.states) {
        for (const b of legalLabels(st).map((l) => l.replace(/\*$/, ''))) {
          const name = a + b;
          const sv = prefixVerdict(root, [a, b], H1, 0, CAP, catSurvivesSeal);
          const mf = prefixVerdict(root, [a, b], H1, 0, CAP, mouseForcesWinSeal);
          twoStep.push({ prefix: name, ok: sv.ok, catSurvive: sv.value, mouseForcedWin: mf.value, branches: sv.branches });
        }
      }
    }
    const safeTwoStep = twoStep.filter((r) => r.catSurvive === true).map((r) => r.prefix);

    const doc = {
      artifactId: 'G6T2_RECERTIFICATION', round: 'PPC-CAT-STRATEGY-SEAL-01', phase: 4,
      generatedAt: new Date().toISOString(), generatedBy: 'PPC-CAT-STRATEGY-SEAL-01/probe/recertify.test.ts',
      root: 'G6T2', provenance: 'REAL_HUMAN_REPLAY', canonicalSnapshotSha256: snap('G6T2'),
      fixtureSha256: FROZEN_FIXTURE_SHA,
      kernel: 'seal_lib.ts (prune DISABLED; catSurvive is a separate search; CHANCE=AND)',
      horizon: { H0, H1, cut: 'cat node idx >= 2*H' }, cap: CAP,
      previousRound: { classification: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', h1Nodes: 105544,
        defect: 'F1 (!mouseForcesWin⇒survival) + F3/F4 prune; re-derived here independently' },
      rootClassification: {
        class: rootClass,
        h0MouseForcedWin: h0.value, h1MouseForcedWin: h1.value,
        h1CatSurvive: survive.value, h1CatForcedWin: catForce.value,
        stats: { h0: stat(h0.stats), h1: stat(h1.stats), survive: stat(survive.stats), catForce: stat(catForce.stats) },
        rootSurvivalPolicySize: survive.policy.size,
        rootSurvivalCertificate: rootSurvivalVerify,
      },
      firstSteps,
      fullTurnPrefixes: prefixes,
      drUniqueness: {
        legalFirstSteps: level1, twoStepPrefixes: twoStep,
        safeTwoStepPrefixes: safeTwoStep,
        drIsUniqueSafeTwoStep: safeTwoStep.length === 1 && safeTwoStep[0] === 'DR',
        note: 'safe = catSurvive TRUE on every positive-probability boundary outcome (independent search, no prune)',
      },
      elapsedMs: Math.round(performance.now() - t0),
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/G6T2_RECERTIFICATION.json`, JSON.stringify(doc, null, 2));

    // assertions reflecting the corrected contract (honest: may be UNRESOLVED)
    expect(['CAT_SURVIVAL_CERTIFIED_WITHIN_H1', 'CHANCE_DEPENDENT_OUTCOME', 'UNRESOLVED',
      'MOUSE_FORCED_WIN_WITHIN_H0', 'MOUSE_FORCED_WIN_WITHIN_H1', 'CAT_FORCED_WIN_WITHIN_H1']).toContain(rootClass);
    console.log('G6T2 rootClass=', rootClass, 'safeTwoStep=', JSON.stringify(safeTwoStep),
      'UURR.mf=', prefixes[0].mouseForcedWin, 'DRRR.cs=', prefixes[1].catSurvive, 'DRDR.cs=', prefixes[2].catSurvive);
  }, 3_600_000);

  it('G6T3 H0 mouse forced win + independent certificate', () => {
    const root = load('G6T3');
    const t0 = performance.now();
    const h0 = mouseForcesWinSeal(root, H0, 0, CAP);
    const h1 = mouseForcesWinSeal(root, H1, 0, CAP);
    const survive = catSurvivesSeal(root, H1, 0, CAP);
    const catForce = catForcesWinSeal(root, H1, 0, CAP);
    const rootClass = classifySeal(h0.value, h1.value, survive.value, catForce.value);

    let cert: unknown = null;
    if (h0.value === true) {
      const v = verifyMouseCertificate(root, h0.policy, H0, 0, CAP);
      cert = { verdict: v.verdict, ok: v.ok, leaves: v.leaves, branches: v.branches,
        chanceNodes: v.chanceNodes, maxDepth: v.maxDepth, policyMisses: v.policyMisses,
        reason: v.reason, counterexample: v.counterexample, elapsedMs: Math.round(v.elapsedMs),
        policySize: h0.policy.size, policy: policyEntries(h0.policy) };
      expect(v.ok, `G6T3 H0 mouse certificate: ${v.reason}`).toBe(true);
    }
    const doc = {
      artifactId: 'G6T3_RECERTIFICATION', round: 'PPC-CAT-STRATEGY-SEAL-01', phase: 4,
      generatedAt: new Date().toISOString(), generatedBy: 'PPC-CAT-STRATEGY-SEAL-01/probe/recertify.test.ts',
      root: 'G6T3', provenance: 'REAL_HUMAN_REPLAY', canonicalSnapshotSha256: snap('G6T3'),
      fixtureSha256: FROZEN_FIXTURE_SHA, horizon: { H0, H1 }, cap: CAP,
      previousRound: { classification: 'MOUSE_FORCED_WIN_WITHIN_H0', h1Nodes: 32918 },
      rootClassification: { class: rootClass, h0MouseForcedWin: h0.value, h1MouseForcedWin: h1.value,
        h1CatSurvive: survive.value, h1CatForcedWin: catForce.value,
        stats: { h0: stat(h0.stats), h1: stat(h1.stats), survive: stat(survive.stats), catForce: stat(catForce.stats) } },
      h0MouseCertificate: cert,
      elapsedMs: Math.round(performance.now() - t0),
    };
    writeFileSync(`${OUT}/G6T3_RECERTIFICATION.json`, JSON.stringify(doc, null, 2));
    expect(rootClass).toBe('MOUSE_FORCED_WIN_WITHIN_H0');
    console.log('G6T3 rootClass=', rootClass, 'h0.cert=', cert ? (cert as { verdict: string }).verdict : null);
  }, 3_600_000);

  it('aggregates STRATEGY_CERTIFICATE_VERIFICATION.json', () => {
    const g6t2 = JSON.parse(readFileSync(`${OUT}/G6T2_RECERTIFICATION.json`, 'utf8'));
    const g6t3 = JSON.parse(readFileSync(`${OUT}/G6T3_RECERTIFICATION.json`, 'utf8'));
    const certs: unknown[] = [];
    if (g6t2.rootClassification.rootSurvivalCertificate) {
      certs.push({ root: 'G6T2', question: 'catSurvive H1 (root)', side: 'cat',
        ...(g6t2.rootClassification.rootSurvivalCertificate as object) });
    }
    for (const p of g6t2.fullTurnPrefixes) {
      for (const c of p.certificates) {
        if (c.verified) certs.push({ root: 'G6T2', prefix: p.name, branch: c.branch, question: 'catSurvive H1', side: 'cat', ...c.verified });
      }
    }
    if (g6t3.h0MouseCertificate) {
      const { policy, ...rest } = g6t3.h0MouseCertificate;
      certs.push({ root: 'G6T3', question: 'mouseForce H0', side: 'mouse', ...rest });
    }
    const allProven = certs.every((c) => (c as { ok?: boolean; verdict?: string }).ok === true
      || (c as { verdict?: string }).verdict === 'PROVEN');
    const doc = {
      artifactId: 'STRATEGY_CERTIFICATE_VERIFICATION', round: 'PPC-CAT-STRATEGY-SEAL-01', phase: 4,
      generatedAt: new Date().toISOString(),
      verifier: 'seal_lib.ts verifyCatCertificate / verifyMouseCertificate (independent DFS, no shared boolean combinator, no prune)',
      contract: 'every universal node re-enumerates ALL legal opponent actions and ALL positive-probability CHANCE outcomes; every existential node follows the extracted policy; missing policy = hard fail',
      proverVerifierIndependence: 'prover=solve(); verifier=standalone walk(); they share NO boolean-negation function',
      certificates: certs, count: certs.length, allProven,
    };
    writeFileSync(`${OUT}/STRATEGY_CERTIFICATE_VERIFICATION.json`, JSON.stringify(doc, null, 2));
    expect(certs.length).toBeGreaterThan(0);
    console.log('certificates=', certs.length, 'allProven=', allProven);
  }, 600_000);
});