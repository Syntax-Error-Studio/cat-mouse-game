/// <reference types="node" />
/**
 * G3 — isolated shadow prototype TURN_AWARE_MOUSE_GOAL_RISK.
 *
 * For a complete cat-turn plan it takes the real successor frontier (all
 * positive-probability CHANCE outcomes) and asks two bounded questions with the
 * REAL RuleSet:
 *   Layer 1  can the mouse win inside its own next action turn? (exhaustive)
 *   Layer 2  can the mouse force a win inside TWO_MOUSE_TURNS (mouse, cat
 *            reply, mouse)? (bounded quantifier + one witness line)
 *
 * The prototype never feeds a decision. Labels:
 *   PROVEN_FORCED_WIN        full quantifier true inside the tested window
 *   WITNESS_ONLY             the quantifier is false, but ONE cat reply /
 *                            chance branch admits a mouse win — never safety
 *   NO_WIN_WITHIN_TESTED_HORIZON  quantifier false (NOT "cat is safe")
 *   UNKNOWN                  node cap reached; nothing claimed
 */
import { describe, it, expect } from 'vitest';
import {
  ROUND, writeJson, enumerateRoot, turnOf, endStatesOf, evaluatePlanRisk,
  mouseOneTurnRisk, mouseTwoTurnRisk, stateKey, snapshotSha, fullStateSha,
  FROZEN_LABELS, evaluateForCat, type ShadowEval,
} from './dr_lib';

const PLANS = ['UURR', 'DRRR', 'DUUD', 'DRDR'];
const FROZEN_FRONTIER_SHA: Record<string, string> = {
  UURR: 'e954daae154e2b017bdf2e00c8c274353fdeb1c435d9fa2c8252d408de5d9aed',
  DRRR: '253033ff26cd72033a9dcd33c5553cea2baabe3bee81c20138a01a88d40cd94b',
  DUUD: '51b3773e6da58d7d101af76a65f3956b8eff585bda1e06db8f1797c9148a129b',
  DRDR: 'ad15efecfaf42215fc094b4548b12ad9e08c503c3470c012280ac4714652f613',
};

describe('G3 turn-aware mouse goal risk (shadow only)', () => {
  it('evaluates the four G6T2 control plans without touching any decision', () => {
    const { root, turns, expandedStates, elapsedMs } = enumerateRoot('G6T2');
    const rows: ShadowEval[] = [];
    const frontierCheck: Record<string, string> = {};
    for (const p of PLANS) {
      const turn = turnOf(turns, p);
      const states = endStatesOf(root, turn.plan).states;
      frontierCheck[p] = fullStateSha(states[0]);
      expect(frontierCheck[p], `${p} frontier drifted from the frozen replay`).toBe(FROZEN_FRONTIER_SHA[p]);
      rows.push(evaluatePlanRisk(root, p, 'G6T2', { enumerateMs: elapsedMs }));
    }

    const out = {
      round: ROUND,
      phase: 'G3_TACTICAL_RISK_WITNESSES',
      generatedAt: new Date().toISOString(),
      root: {
        rootId: 'G6T2',
        stateKeySha256: stateKey(root).length ? snapshotSha(root) : '',
        snapshotSha256: snapshotSha(root),
        completeCatTurns: turns.length,
        expandedStates,
        enumerationMs: elapsedMs,
      },
      prototype: {
        name: 'TURN_AWARE_MOUSE_GOAL_RISK',
        wiredToDecision: false,
        horizon: 'TWO_MOUSE_TURNS (mouse, cat reply, mouse)',
        layer1: 'exhaustive mouse-turn win (all legal actions incl. skill; CHANCE forced=AND, exists=OR)',
        layer2: 'bounded quantifier over real RuleSet transitions; one witness recorded',
      },
      plans: rows,
      frozenLabelCrossCheck: Object.fromEntries(PLANS.map((p) => [p, FROZEN_LABELS[p] ?? null])),
      calibration: {
        expected: {
          UURR_twoTurn: 'PROVEN_FORCED_WIN (matches frozen mouse-forced-win certificate)',
          DRRR_twoTurn: 'NO_WIN_WITHIN_TESTED_HORIZON (matches frozen cat-survives H2 label)',
        },
        observed: Object.fromEntries(rows.map((r) => [r.plan, r.twoTurn.label])),
      },
      honesty: {
        noWinIsNotSafety: 'NO_WIN_WITHIN_TESTED_HORIZON is not a cat-safety certificate; only the frozen H2 label says DRRR survives that specific window.',
        witnessIsNotProof: 'WITNESS_ONLY is one concrete line under one cat reply / one chance branch.',
        unknownIsReported: 'A node-cap hit yields UNKNOWN with no claim.',
      },
    };
    writeJson(`${ROUND}/TACTICAL_RISK_WITNESSES.json`, out);

    // Calibration against frozen labels (same root, same plans).
    const by = Object.fromEntries(rows.map((r) => [r.plan, r]));
    expect(by.UURR.twoTurn.label).toBe('PROVEN_FORCED_WIN');
    expect(by.DRRR.twoTurn.label).toBe('NO_WIN_WITHIN_TESTED_HORIZON');
    // Layer 1 must not pretend to see a two-turn win.
    expect(by.UURR.oneTurn.forcedWinThisTurn).toBe(false);
    // Every G6T2 plan ends at a single positive-probability CHANCE outcome.
    for (const r of rows) {
      expect(r.frontierCount).toBe(1);
      expect(r.chanceWeights).toEqual([1]);
    }
  });
});