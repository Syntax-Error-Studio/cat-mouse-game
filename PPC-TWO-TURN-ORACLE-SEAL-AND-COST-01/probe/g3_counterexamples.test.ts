/// <reference types="node" />
/**
 * G3 — minimal quantifier counterexamples on REAL states.
 *
 * Every case is built from the frozen engine and the real RuleSet. No synthetic
 * GameEngineState is fabricated, no rule is bent to make a case work, and cases
 * that cannot be reached from the frozen roots are reported as such instead of
 * being faked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  ROUND, QCAP, rules, label, stateKey, applyNoMoveLoss,
  replayToFrontier, runProof, loadRoot,
} from './ttor_lib';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { GamePhase, PieceType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';
import {
  mouseForcesWinSeal, catSurvivesSeal, verifyCatCertificate, verifyMouseCertificate,
} from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

const OUT = ROUND;
const LOG = `${ROUND}/logs`;
const root = loadRoot('G6T2');
const frontier = replayToFrontier('G6T2', 'DUUD').states[0];

interface ChanceHit {
  state: GameEngineState;
  idx: number;
  action: string;
  positive: { key: string; terminal: 'mouse' | 'cat' | null; weight: number }[];
  zeroWeight: number;
}

/** BFS over the real DUUD window looking for a chance transition with a mixed outcome set. */
function scanChance(start: GameEngineState, startIdx: number, budget: number): {
  visited: number; zeroWeightSeen: number; mixedTerminal: ChanceHit[]; mixedNonTerminal: ChanceHit[];
} {
  const seen = new Set<string>();
  const queue: { s: GameEngineState; idx: number }[] = [{ s: start, idx: startIdx }];
  const mixedTerminal: ChanceHit[] = [];
  const mixedNonTerminal: ChanceHit[] = [];
  let zeroWeightSeen = 0;
  let visited = 0;

  while (queue.length > 0 && visited < budget) {
    const { s: s0, idx } = queue.shift()!;
    const s = applyNoMoveLoss(s0);
    const key = `${idx}|${stateKey(s)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    visited++;
    if (s.phase !== GamePhase.Playing) continue;
    if (s.currentPlayer === PieceType.Cat && idx >= 4) continue;

    for (const p of generatePreparedSearchActions(s, rules)) {
      const tr = p.transition;
      if (tr.kind !== 'chance') {
        const ci = tr.state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
        queue.push({ s: tr.state, idx: ci });
        continue;
      }
      const pos = tr.outcomes.filter((o) => o.weight > 0);
      zeroWeightSeen += tr.outcomes.length - pos.length;
      if (pos.length < 2) {
        for (const o of pos) {
          const ci = o.state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
          queue.push({ s: o.state, idx: ci });
        }
        continue;
      }
      const ci = pos[0].state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
      const hit: ChanceHit = {
        state: s, idx, action: label(p.action),
        positive: pos.map((o) => ({
          key: stateKey(o.state),
          weight: o.weight,
          terminal: o.state.phase === GamePhase.MouseWins ? 'mouse'
            : o.state.phase === GamePhase.CatWins ? 'cat' : null,
        })),
        zeroWeight: tr.outcomes.length - pos.length,
      };
      const terminals = new Set(hit.positive.map((o) => o.terminal));
      if (terminals.size > 1 && !terminals.has(null)) mixedTerminal.push(hit);
      else mixedNonTerminal.push(hit);
      if (mixedTerminal.length >= 3 && mixedNonTerminal.length >= 3) return { visited, zeroWeightSeen, mixedTerminal, mixedNonTerminal };
      for (const o of pos) queue.push({ s: o.state, idx: ci });
    }
  }
  return { visited, zeroWeightSeen, mixedTerminal, mixedNonTerminal };
}

describe('G3 quantifier counterexamples', () => {
  it('mixed CHANCE outcomes are AND: one winning branch never certifies a forced win', () => {
    mkdirSync(LOG, { recursive: true });
    const scan = scanChance(frontier, 1, 40_000);

    const cases: Record<string, unknown> = {
      scanVisitedStates: scan.visited,
      mixedTerminalChanceNodes: scan.mixedTerminal.length,
      mixedLiveChanceNodes: scan.mixedNonTerminal.length,
      zeroWeightOutcomesSeen: scan.zeroWeightSeen,
    };

    if (scan.mixedTerminal.length > 0) {
      const hit = scan.mixedTerminal[0];
      // At this state one announced outcome is a mouse win and another is a cat
      // win. A single-outcome reading would say "mouse wins"; the quantifier must
      // deny the action (its CHANCE node is AND over positive outcomes).
      const r = mouseForcesWinSeal(hit.state, 2, hit.idx, QCAP);
      cases.mixedTerminalCase = {
        stateKey: stateKey(hit.state),
        idx: hit.idx,
        action: hit.action,
        outcomes: hit.positive,
        zeroWeightOutcomes: hit.zeroWeight,
        solverValue: r.value,
        solverTruncated: r.stats.truncated,
        expectation: 'ONE_ACTION_DENIED; the state verdict comes from the OTHER actions and must not treat this action as winning',
        verdict: 'AND_ENFORCED_OBSERVED',
      };
      // A fabricated certificate that claims a win through this exact action must
      // be rejected: build the smallest possible bad policy and let the verifier
      // report the counterexample instead of trusting the claim.
      const badPolicy = new Map<string, string>();
      badPolicy.set(`${hit.idx}|${stateKey(hit.state)}`, hit.action);
      const bad = verifyMouseCertificate(hit.state, badPolicy, 2, hit.idx, 50_000);
      cases.fabricatedSingleOutcomeCertificate = {
        policySize: badPolicy.size,
        verdict: bad.verdict,
        reason: bad.reason,
        counterexampleHead: bad.counterexample?.slice(0, 6) ?? null,
        expectation: 'FAILED (or UNRESOLVED at cap) — NEVER PROVEN',
      };
      expect(bad.verdict).not.toBe('PROVEN');
    } else {
      cases.mixedTerminalCase = {
        status: 'NOT_OBSERVED',
        note: 'No chance node with terminal outcomes of both colors was reached inside the DUUD window; no synthetic state was fabricated.',
      };
    }

    if (scan.mixedNonTerminal.length > 0) {
      const hit = scan.mixedNonTerminal[0];
      cases.mixedLiveCase = {
        stateKey: stateKey(hit.state), idx: hit.idx, action: hit.action,
        outcomes: hit.positive.map((o) => ({ key: o.key.slice(0, 16), weight: o.weight })),
        note: 'Outcome states differ while both stay live — the solver must continue under EVERY one of them.',
      };
    }

    writeFileSync(`${OUT}/QUANTIFIER_COUNTEREXAMPLES.json`, JSON.stringify({
      round: ROUND,
      instrument: 'seal_lib.solve / verifyMouseCertificate over the real RuleSet',
      cases,
    }, null, 2));

    expect(scan.visited).toBeGreaterThan(0);
  }, 3_600_000);

  it('pickup CHANCE: branches can disagree in verdict, and ONE winning branch is not certified', () => {
    // The terminal-mix scan above found no chance node that itself ends the game
    // in both colours; the observable version of the same question is whether the
    // outcome SUBTREES disagree. Measure it on the real pickup announcement.
    const action = generatePreparedSearchActions(frontier, rules).find((p) => {
      const tr = p.transition;
      return tr.kind === 'chance' && tr.outcomes.filter((o) => o.weight > 0).length > 1;
    });
    expect(action).toBeTruthy();
    const tr = action!.transition;
    if (tr.kind !== 'chance') throw new Error('unreachable');
    const pos = tr.outcomes.filter((o) => o.weight > 0);
    expect(pos.length).toBeGreaterThan(1);
    const sum = pos.reduce((a, o) => a + o.weight, 0);
    expect(sum).toBeCloseTo(1, 12);

    const rows = pos.map((o, i) => {
      const childIdx = o.state.currentPlayer !== frontier.currentPlayer ? 2 : 1;
      const r = mouseForcesWinSeal(o.state, 1, childIdx, 5_000);
      return {
        outcome: i + 1,
        weight: o.weight,
        childIdx,
        childStateKey: stateKey(o.state).slice(0, 24),
        oneTurnForcedWin: r.value,
        truncated: r.stats.truncated,
      };
    });

    const parent = mouseForcesWinSeal(frontier, 1, 1, 5_000);
    expect(parent.value).toBe(false);
    const distinct = new Set(rows.map((r) => r.oneTurnForcedWin));
    const mix = distinct.size > 1;

    // A certificate that names ONLY the parent action cannot survive the
    // verifier: every outcome branch must be covered, not just the convenient one.
    const partialPolicy = new Map<string, string>();
    partialPolicy.set(`1|${stateKey(frontier)}`, label(action!.action));
    const partial = verifyMouseCertificate(frontier, partialPolicy, 2, 1, 50_000);

    mkdirSync(LOG, { recursive: true });
    const file = `${OUT}/QUANTIFIER_COUNTEREXAMPLES.json`;
    const prev = JSON.parse(readFileSync(file, 'utf8'));
    prev.cases.pickupChanceVerdictMix = {
      action: label(action!.action),
      parentH1Value: parent.value,
      outcomes: rows.length,
      outcomeVerdicts: rows,
      verdictsDisagree: mix,
      reading: mix
        ? 'At least one announced outcome forces a win in the one-turn window and at least one does not. The parent CHANCE node is AND, so the parent verdict stays false — a single favourable branch is never enough.'
        : 'All outcome subtrees share the same one-turn verdict; the AND/OR difference is then unobservable on this node, which is reported as measured rather than assumed.',
      partialCertificate: {
        policySize: partialPolicy.size,
        verdict: partial.verdict,
        reason: partial.reason,
        policyMisses: partial.policyMisses,
        counterexampleHead: partial.counterexample?.slice(0, 6) ?? null,
        reading: 'A one-branch certificate is rejected by the verifier — it must cover every positive-probability outcome and every cat reply.',
      },
    };
    writeFileSync(file, JSON.stringify(prev, null, 2));
    expect(rows.some((r) => r.oneTurnForcedWin !== null)).toBe(true);
    expect(partial.verdict).not.toBe('PROVEN');
  }, 3_600_000);

  it('node cap yields UNKNOWN, never a silent verdict', () => {
    const tiny = runProof(frontier, 'mouseForce', 2, 1, 10, QCAP);
    expect(tiny.value).toBe(null);
    expect(tiny.truncated).toBe(true);
    expect(tiny.proofStatus).toBe('UNKNOWN');

    const full = runProof(frontier, 'mouseForce', 2, 1, QCAP, 200);
    expect(full.value).toBe(true);
    expect(full.verify?.verdict).toBe('UNRESOLVED');
    expect(full.proofStatus).toBe('UNKNOWN'); // a claimed win without a certificate is never PROVEN

    writeFileSync(`${LOG}/g3_truncation.json`, JSON.stringify({
      solveCap10: { value: tiny.value, truncated: tiny.truncated, nodes: tiny.nodes, proofStatus: tiny.proofStatus },
      verifierCap200: {
        value: full.value, nodes: full.nodes, verify: full.verify && {
          verdict: full.verify.verdict, reason: full.verify.reason, leaves: full.verify.leaves,
        },
        proofStatus: full.proofStatus,
      },
      rule: 'UNKNOWN on truncation; a true boolean with UNRESOLVED verifier never becomes PROVEN.',
    }, null, 2));
  }, 3_600_000);

  it('H=1 at the same state is false while H=2 is true: the window is part of the question', () => {
    const one = runProof(frontier, 'mouseForce', 1, 1, QCAP, QCAP);
    const two = runProof(frontier, 'mouseForce', 2, 1, QCAP, QCAP);
    expect(one.value).toBe(false);
    expect(two.value).toBe(true);
    // Both kernels key their memo by `${idx}|${stateKey}`; the source is quoted
    // so a future refactor that drops idx fails this check.
    const sealSrc = readFileSync('PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts', 'utf8');
    expect(sealSrc.includes('`${idx}|${game.key(s)}`')).toBe(true);
    const shadowSrc = readFileSync('PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.ts', 'utf8');
    expect(shadowSrc.includes('`${idx}|${stateKey(s)}`')).toBe(true);

    writeFileSync(`${LOG}/g3_window_isolation.json`, JSON.stringify({
      sameFrontierStateKey: stateKey(frontier),
      H1: { value: one.value, nodes: one.nodes },
      H2: { value: two.value, nodes: two.nodes },
      memoKeyContract: 'idx|stateKey in both kernels (quoted from source)',
      reading: 'The base stateKey is identical; only H/startIdx differ. Window context must never be memoized away.',
    }, null, 2));
  }, 3_600_000);

  it('NO_WIN is not auto-upgraded; the dual cat-survival question is asked separately and gets its own certificate', () => {
    const f = replayToFrontier('G6T2', 'DRRR');
    const mouse = runProof(f.states[0], 'mouseForce', 2, 1, QCAP, QCAP);
    expect(mouse.value).toBe(false);
    expect(mouse.verify).toBe(null);

    // Separate, explicit dual run — NOT derived from the NO_WIN verdict by the tool.
    const t0 = performance.now();
    const dual = catSurvivesSeal(f.states[0], 2, 1, QCAP);
    const dualMs = performance.now() - t0;
    const dualVerify = dual.value === true
      ? verifyCatCertificate(f.states[0], dual.policy, 2, 1, QCAP)
      : null;

    writeFileSync(`${LOG}/g3_no_win_dual.json`, JSON.stringify({
      mouseForce: { value: mouse.value, truncated: mouse.truncated, nodes: mouse.nodes, certificate: mouse.verify },
      dualCatSurvive: {
        call: 'catSurvivesSeal(frontier, H=2, startIdx=1)',
        value: dual.value, truncated: dual.stats.truncated, nodes: dual.stats.nodes,
        elapsedMs: Math.round(dualMs),
        verify: dualVerify && {
          verdict: dualVerify.verdict, leaves: dualVerify.leaves, policyMisses: dualVerify.policyMisses,
          counterexample: dualVerify.counterexample,
        },
        labelled: 'DUAL_QUESTION_ASKED_SEPARATELY',
      },
      rule: 'The shadow tool must not turn NO_WIN into survival; the survival claim shown here (if proven) comes from a separate cat quantifier and a separate certificate.',
    }, null, 2));

    if (dual.value === true) expect(dualVerify?.verdict).toBe('PROVEN');
  }, 3_600_000);
});