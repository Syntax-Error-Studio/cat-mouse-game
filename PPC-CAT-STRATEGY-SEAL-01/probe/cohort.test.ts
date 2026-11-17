/// <reference types="node" />
/**
 * Phase 5 — reclassify the full 24-root cohort with the CORRECTED quantifier
 * kernel. Same frozen fixture, same H0=1 / H1=2, same 600000 node cap. No root
 * deleted, no horizon reduced. The unsound reachability prune is DISABLED.
 *
 * Per root: four separate quantifier questions (h0/h1 mouseForce, h1 catSurvive,
 * h1 catForce) → five-class scheme. A definite mouse-forced-win or survival label
 * carries an INDEPENDENTLY verified strategy certificate. Any null (cap) ⇒
 * UNRESOLVED — never passed off as PASS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import {
  mouseForcesWinSeal, catSurvivesSeal, catForcesWinSeal, classifySeal,
  verifyCatCertificate, verifyMouseCertificate,
} from './seal_lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const FROZEN_FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const OUT = 'PPC-CAT-STRATEGY-SEAL-01';
const H0 = 1, H1 = 2, CAP = 600_000;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as { id: string; state: unknown; canonicalSnapshotSha256: string }[];
const load = (id: string): GameEngineState => restoreHardRoot(records.find((r) => r.id === id)!.state as never);

const PREV: Record<string, string> = {
  G6T1: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', G6T2: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
  G6T3: 'MOUSE_FORCED_WIN_WITHIN_H0', G5T1: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
  G5T2: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', G5T3: 'MOUSE_FORCED_WIN_WITHIN_H1',
  G5T4: 'MOUSE_FORCED_WIN_WITHIN_H0', G2T1: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
  G2T2: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', G2T3: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
  G2T4: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', G2T5: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
  G2T6: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', G2T7: 'MOUSE_FORCED_WIN_WITHIN_H1',
  G2T8: 'MOUSE_FORCED_WIN_WITHIN_H0', G1T1: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
  G1T2: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', G1T3: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
  G1T4: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', G1T5: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
  G1T6: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', G1T7: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
  G1T8: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', G1T9: 'MOUSE_FORCED_WIN_WITHIN_H1',
};

const st = (s: { nodes: number; truncated: boolean; elapsedMs: number; chanceNodes: number; chanceOutcomes: number }) =>
  ({ nodes: s.nodes, truncated: s.truncated, chanceNodes: s.chanceNodes, chanceOutcomes: s.chanceOutcomes, elapsedMs: Math.round(s.elapsedMs) });

describe('Phase 5 24-root cohort reclassification', () => {
  it('reclassifies all 24 roots with the corrected kernel', () => {
    expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);
    expect(records.length).toBe(24);
    const t0 = performance.now();
    const rows: unknown[] = [];
    const counts: Record<string, number> = {};

    for (const rec of records) {
      const root = load(rec.id);
      const rt0 = performance.now();
      const h0 = mouseForcesWinSeal(root, H0, 0, CAP);
      const h1 = mouseForcesWinSeal(root, H1, 0, CAP);
      const survive = catSurvivesSeal(root, H1, 0, CAP);
      const catForce = catForcesWinSeal(root, H1, 0, CAP);
      const cls = classifySeal(h0.value, h1.value, survive.value, catForce.value);
      counts[cls] = (counts[cls] ?? 0) + 1;

      // independent certificate for the decisive definite label
      let certificate: unknown = null;
      let proofStatus = 'UNRESOLVED';
      if (h0.value === true) {
        const v = verifyMouseCertificate(root, h0.policy, H0, 0, CAP);
        certificate = { side: 'mouse', question: 'mouseForce H0', verdict: v.verdict, ok: v.ok,
          leaves: v.leaves, branches: v.branches, chanceNodes: v.chanceNodes, policyMisses: v.policyMisses,
          policySize: h0.policy.size, reason: v.reason };
        proofStatus = v.ok ? 'PROVEN' : 'FAILED';
      } else if (h1.value === true) {
        const v = verifyMouseCertificate(root, h1.policy, H1, 0, CAP);
        certificate = { side: 'mouse', question: 'mouseForce H1', verdict: v.verdict, ok: v.ok,
          leaves: v.leaves, branches: v.branches, chanceNodes: v.chanceNodes, policyMisses: v.policyMisses,
          policySize: h1.policy.size, reason: v.reason };
        proofStatus = v.ok ? 'PROVEN' : 'FAILED';
      } else if (survive.value === true) {
        const v = verifyCatCertificate(root, survive.policy, H1, 0, CAP);
        certificate = { side: 'cat', question: 'catSurvive H1', verdict: v.verdict, ok: v.ok,
          leaves: v.leaves, branches: v.branches, chanceNodes: v.chanceNodes, policyMisses: v.policyMisses,
          policySize: survive.policy.size, reason: v.reason };
        proofStatus = v.ok ? 'PROVEN' : 'FAILED';
      } else if (cls === 'CHANCE_DEPENDENT_OUTCOME') {
        proofStatus = 'REFUTED_BOTH_FORCE';   // neither side forces; definite, no certificate needed
      }

      const changed = PREV[rec.id] !== cls;
      const row = {
        id: rec.id, provenance: 'REAL_HUMAN_REPLAY', canonicalSnapshotSha256: rec.canonicalSnapshotSha256,
        previousClass: PREV[rec.id], class: cls, changedFromPrevious: changed, proofStatus,
        h0MouseForcedWin: h0.value, h1MouseForcedWin: h1.value, h1CatSurvive: survive.value, h1CatForcedWin: catForce.value,
        stats: { h0: st(h0.stats), h1: st(h1.stats), survive: st(survive.stats), catForce: st(catForce.stats) },
        certificate,
        reason: cls === 'UNRESOLVED'
          ? 'node cap 600000 reached with prune disabled; cannot certify within frozen budget (honest UNRESOLVED, not PASS)'
          : cls === 'CHANCE_DEPENDENT_OUTCOME'
            ? 'mouseForcesWin=false AND catSurvive=false (both completed): neither side forces against all chance'
            : 'definite quantifier verdict with independent certificate',
        elapsedMs: Math.round(performance.now() - rt0),
      };
      rows.push(row);
      console.log(`[${rec.id}] ${cls} (prev ${PREV[rec.id]}) proof=${proofStatus} h0=${h0.value} h1=${h1.value} cs=${survive.value} cf=${catForce.value} ${row.elapsedMs}ms`);
    }

    const doc = {
      artifactId: 'ROOT_CLASSIFICATION_V2', round: 'PPC-CAT-STRATEGY-SEAL-01', phase: 5,
      generatedAt: new Date().toISOString(), generatedBy: 'PPC-CAT-STRATEGY-SEAL-01/probe/cohort.test.ts',
      fixtureSha256: FROZEN_FIXTURE_SHA, rootCount: 24,
      kernel: 'seal_lib.ts (prune DISABLED; separate catSurvive; CHANCE=AND; mode-dependent terminals)',
      horizon: { H0, H1, cut: 'cat node idx >= 2*H' }, cap: CAP,
      scheme: ['MOUSE_FORCED_WIN_WITHIN_H0', 'MOUSE_FORCED_WIN_WITHIN_H1', 'CAT_FORCED_WIN_WITHIN_H1',
        'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', 'CHANCE_DEPENDENT_OUTCOME', 'UNRESOLVED'],
      counts, rows,
      previousCounts: { CAT_SURVIVAL_CERTIFIED_WITHIN_H1: 18, MOUSE_FORCED_WIN_WITHIN_H0: 3, MOUSE_FORCED_WIN_WITHIN_H1: 3 },
      elapsedMs: Math.round(performance.now() - t0),
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/ROOT_CLASSIFICATION_V2.json`, JSON.stringify(doc, null, 2));
    expect(rows.length).toBe(24);
    console.log('COUNTS=', JSON.stringify(counts), 'totalMs=', doc.elapsedMs);
  }, 7_200_000);
});