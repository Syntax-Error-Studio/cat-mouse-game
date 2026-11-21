/// <reference types="node" />
/**
 * G1 — window and label lineage. Structural only: it records WHERE every label
 * comes from, with which kernel, at which startIdx/H/cap, and whether an
 * independent verifier ever checked it. No heavy solve runs here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ROUND, loadRoot, replayToFrontier, summarizeState, hashFile } from './ttor_lib';

const OUT = ROUND;
const LOG = `${ROUND}/logs`;

describe('G1 window and label lineage', () => {
  it('records the verified provenance of every label system', () => {
    mkdirSync(LOG, { recursive: true });

    const root = loadRoot('G6T2');
    const duud = replayToFrontier('G6T2', 'DUUD');
    const uud = replayToFrontier('G6T2', 'UURR');

    const table = {
      round: ROUND,
      verifiedAt: 'source read + runtime state, no heavy solve in this phase',
      kernel: {
        seal: { path: 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts', sha256: hashFile('PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts'), hasIndependentVerifier: true },
        strategy: { path: 'PPC-CAT-STRATEGY-01/probe/lib.ts', sha256: hashFile('PPC-CAT-STRATEGY-01/probe/lib.ts'), hasIndependentVerifier: false },
        shadow: { path: 'PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.ts', sha256: hashFile('PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.ts'), hasIndependentVerifier: false },
        oracle: { path: 'PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/ttor_lib.ts', underlying: 'seal', hasIndependentVerifier: true },
      },
      rows: [
        {
          system: 'PCV H0',
          artifact: 'PPC-T1-PCV-01/probe/pcv.test.ts:103',
          call: 'runSolve(st, "mouseForce", 1, 1, 600000, 600000)',
          start: 'post-finalPlan MOUSE frontier (mouse to move, catMovesLeft<=0)',
          startIdx: 1, H: 1, cap: 600_000,
          window: 'mouse turn #1 only (1 mouse turn, 0 further cat turns)',
          quantifier: '∃mouse ∀chance → MouseWins',
          verifier: 'verifyMouseCertificate (re-enumerates all CHANCE outcomes)',
          labelMeaning: 'H0 forced mouse win == G6T3-type immediate escape',
        },
        {
          system: 'PCV H1',
          artifact: 'PPC-T1-PCV-01/probe/pcv.test.ts:105',
          call: 'runSolve(st, "catSurvive", 2, 1, 5000, 600000)',
          start: 'post-finalPlan MOUSE frontier',
          startIdx: 1, H: 2, cap: 5_000,
          window: 'mouse turn #1, cat reply, mouse turn #2; cat node idx>=4 cut ⇒ 2 mouse turns + 1 cat turn',
          quantifier: '∃cat ∀mouse ∀chance → ¬MouseWins',
          verifier: 'verifyCatCertificate (separate cap 600000)',
          labelMeaning: 'H1 survival == mouse cannot force a win inside two of its turns',
        },
        {
          system: 'STRATEGY-01 root labels (G1T9 / G1T8 / G1T4 / G6T2)',
          artifact: 'PPC-CAT-STRATEGY-01/probe/tactical_tree.test.ts:93-95',
          call: 'mouseForcesWin(root, H0|H1, 0, 600000)',
          start: 'frozen human root (CAT to move)',
          startIdx: 0, H0: 1, H1: 2, cap: 600_000,
          window: 'H0 = cat turn cat(0)+mouse(1); H1 = cat(0)+mouse(1)+cat(2)+mouse(3); cut at cat idx>=2H',
          quantifier: '∃mouse ∀cat ∀chance (mouse side); catForcesWin mirror',
          verifier: 'NONE at label time (classification reads only the boolean)',
          labelMeaning: 'G1T9 H1 label means: mouse forces a win within two mouse turns after this root, not within one',
        },
        {
          system: 'SHADOW mouseTwoTurnRisk',
          artifact: 'PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.ts:243',
          call: 'mouseTwoTurnRisk(frontier) cap=300000 (+witnessOnly cap=120000)',
          start: 'post-plan MOUSE frontier',
          startIdx: 1, H: 2, cap: 300_000,
          window: 'mouse(1)+cat(2)+mouse(3); cat idx>=4 cut',
          quantifier: '∃mouse ∀cat ∀chance, proven for true; false paired with an existential witness search',
          verifier: 'NONE independent of itself',
          labelMeaning: 'PROVEN / NO_WIN_WITHIN_TESTED_HORIZON / UNKNOWN',
        },
        {
          system: 'THIS ROUND independent oracle',
          artifact: 'PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/ttor_lib.ts runProof',
          call: 'mouseForcesWinSeal(frontier, 2, 1, 600000) + verifyMouseCertificate',
          start: 'post-plan MOUSE frontier rebuilt from the real RuleSet',
          startIdx: 1, H: 2, cap: 600_000,
          window: 'mouse(1)+cat(2)+mouse(3); cat idx>=4 cut',
          quantifier: '∃mouse ∀cat ∀chance → MouseWins',
          verifier: 'independent re-enumeration, no prune, cap 600000',
          labelMeaning: 'PROVEN only after verifyMouseCertificate returns PROVEN; NO_WIN is window-scoped, never "cat survives forever"',
        },
      ],
      windowEquivalence: {
        'STRATEGY_H1 == PCV_H1 == shadow H2 == oracle H2': 'all four mean "two mouse turns after the current position", despite H1/H2 naming',
        'STRATEGY_H0 == PCV_H0': 'one mouse turn',
        cutRule: 'a cat node with idx >= 2H is outside the window; terminal wins are checked BEFORE the cut in both seal and strategy kernels',
      },
      correctionOfPriorRound: {
        artifact: 'PPC-G6T2-DECISION-RISK-CAUSAL-01/REPORT.md and CROSS_ROOT_SHADOW_RESULTS.json frozenRootLabels.note',
        wrongGloss: 'root-level H1 = "一个猫回合 + 一个鼠回合" (one cat turn + one mouse turn)',
        correctGloss: 'root-level H1 = two mouse turns and two cat turns starting with cat (H0 is the one-cat-one-mouse window); PCV H1 is likewise two mouse turns from a mouse frontier',
        impact: 'the G1T9 "layer-1 false, layer-2 true" pattern is NOT a window contradiction; layer 1 covers one mouse turn, the label covers two',
        frozenArtifactsUntouched: true,
      },
      rootFacts: {
        g6t2RootStateKeySource: 'G6T2 fixture root',
        g6t2: summarizeState(root),
        duudFrontier: {
          validMouseFrontier: duud.validMouseFrontier,
          positiveOutcomes: duud.positiveOutcomes,
          totalOutcomes: duud.totalOutcomes,
          weights: duud.weights,
          state: summarizeState(duud.states[0]),
        },
        uudFrontier: {
          validMouseFrontier: uud.validMouseFrontier,
          positiveOutcomes: uud.positiveOutcomes,
          totalOutcomes: uud.totalOutcomes,
          weights: uud.weights,
        },
      },
      verdict: 'WINDOW_LINEAGE_RESOLVED',
    };

    writeFileSync(`${LOG}/g1_lineage.json`, JSON.stringify(table, null, 2));

    // The two structural claims this phase is allowed to make.
    expect(duud.validMouseFrontier).toBe(true);
    expect(duud.positiveOutcomes).toBe(1);
    expect(duud.weights).toEqual([1]);
    expect(table.rows.find((r) => r.system === 'PCV H1')!.H).toBe(2);
    expect(table.rows.find((r) => r.system.startsWith('STRATEGY'))!.verifier).toBe('NONE at label time (classification reads only the boolean)');
  });

  it('shows the G1T9 label artifact and its own window claim', () => {
    const rc = JSON.parse(readFileSync('PPC-CAT-STRATEGY-01/ROOT_CLASSIFICATION.json', 'utf8'));
    const g1t9 = rc.roots.find((r: { id: string }) => r.id === 'G1T9');
    const counts = rc.counts as Record<string, number>;
    expect(g1t9.classification).toBe('MOUSE_FORCED_WIN_WITHIN_H1');
    expect(g1t9.evidence.h0MouseForcedWin).toBe(false);
    expect(g1t9.evidence.h1MouseForcedWin).toBe(true);
    expect(g1t9.evidence.h1CatForcedWin).toBe(false);
    expect(counts.MOUSE_FORCED_WIN_WITHIN_H1).toBe(3);

    const out = {
      artifact: 'PPC-CAT-STRATEGY-01/ROOT_CLASSIFICATION.json',
      sha256: hashFile('PPC-CAT-STRATEGY-01/ROOT_CLASSIFICATION.json'),
      schemeSource: 'PPC-CAT-STRATEGY-01/probe/tactical_tree.test.ts lines 14-20 (horizon naming) and 86-112 (classification)',
      g1t9: { classification: g1t9.classification, evidence: g1t9.evidence },
      reading: 'H0 (one mouse turn) is false and H1 (two mouse turns) is true at the ROOT — consistent with the plan-level layer-1 false / layer-2 true pattern once the prior report\'s gloss is corrected.',
    };
    writeFileSync(`${LOG}/g1_g1t9_artifact.json`, JSON.stringify(out, null, 2));
    expect(out.reading.length).toBeGreaterThan(0);
  });
});