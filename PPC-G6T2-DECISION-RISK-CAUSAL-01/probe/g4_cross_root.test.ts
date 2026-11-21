/// <reference types="node" />
/**
 * G4 — cross-root structural controls (G1T9 / G1T8 / G1T4).
 *
 * For each independent root the same shadow instrument is applied to
 *   (a) the plan the 100 ms production planner returns, and
 *   (b) the FIRST complete cat turn in generation order (label-blind).
 * No parameter search, no label fitting, no safety claim for uncertified roots.
 */
import { describe, it, expect } from 'vitest';
import {
  ROUND, writeJson, enumerateRoot, evaluatePlanRisk, runProduction100,
  planLabel, parsePlan, endStatesOf, stateKey, snapshotSha, FROZEN_LABELS,
} from './dr_lib';

const CONTROLS = ['G1T9', 'G1T8', 'G1T4'];

/**
 * Frozen root-level classifications from PPC-CAT-STRATEGY-01/ROOT_CLASSIFICATION.json.
 * Their H1 window is one cat turn + one mouse turn — SHORTER than this round's
 * TWO_MOUSE_TURNS window, so a CAT_SURVIVAL label there does not bound this window.
 */
const ROOT_LABEL: Record<string, { classification: string; h1Window: string; source: string }> = {
  G1T9: { classification: 'MOUSE_FORCED_WIN_WITHIN_H1', h1Window: 'cat turn + mouse turn', source: 'PPC-CAT-STRATEGY-01/ROOT_CLASSIFICATION.json' },
  G1T8: { classification: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', h1Window: 'cat turn + mouse turn', source: 'PPC-CAT-STRATEGY-01/ROOT_CLASSIFICATION.json' },
  G1T4: { classification: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1', h1Window: 'cat turn + mouse turn', source: 'PPC-CAT-STRATEGY-01/ROOT_CLASSIFICATION.json' },
};

describe('G4 cross-root shadow results', () => {
  it('runs the shadow instrument on three independent roots', () => {
    const rows: Record<string, unknown>[] = [];
    const summaries: Record<string, unknown> = {};

    for (const id of CONTROLS) {
      const { root, turns, expandedStates, elapsedMs } = enumerateRoot(id);
      const prod = runProduction100(root, id);
      const prodLegal = (() => {
        try { endStatesOf(root, parsePlan(prod.planString)); return true; } catch { return false; }
      })();

      const pick = new Map<string, 'production_100ms' | 'first_complete_turn'>();
      if (prodLegal && prod.planString.length > 0) pick.set(prod.planString, 'production_100ms');
      const first = turns[0]?.labels;
      if (first && !pick.has(first)) pick.set(first, 'first_complete_turn');

      const local: Record<string, unknown>[] = [];
      for (const [planString, source] of pick) {
        if (prod.planString === planString && !prodLegal && source === 'production_100ms') continue;
        const ev = evaluatePlanRisk(root, planString, id, { enumerateMs: elapsedMs });
        const row = {
          rootId: id,
          source,
          plan: planString,
          legal: ev.legal,
          completePlanInEnumeration: turns.some((t) => t.labels === planString),
          endKind: ev.endKind,
          chanceSuccessorCount: ev.frontierCount,
          chanceWeights: ev.chanceWeights,
          chanceProbabilitySum: ev.chanceWeights.reduce((a, b) => a + b, 0),
          nextMouseTurnRisk: {
            forcedWinThisTurn: ev.oneTurn.forcedWinThisTurn,
            existsWinningChanceOutcome: ev.oneTurn.existsWinningChanceOutcome,
            chanceOutcomesVisited: ev.oneTurn.chanceOutcomesVisited,
          },
          twoTurn: {
            label: ev.twoTurn.label,
            value: ev.twoTurn.value,
            truncated: ev.twoTurn.truncated,
            nodes: ev.twoTurn.nodes,
            elapsedMs: ev.twoTurn.elapsedMs,
            witnessMs: ev.twoTurn.witnessMs,
            witness: ev.twoTurn.witness,
            witnessOnly: ev.twoTurn.witnessOnly,
          },
          staticReach: ev.staticReach,
          e1Frontier: ev.e1Frontier,
          frozenLabel: ev.frozenLabel,
          frozenLabelScope: 'per-plan; no per-plan frozen label exists for these control roots',
          rootFrozenLabel: ROOT_LABEL[id]?.classification ?? null,
          rootFrozenLabelWindow: ROOT_LABEL[id]?.h1Window ?? null,
          rootFrozenLabelSource: ROOT_LABEL[id]?.source ?? null,
          windowComparison: 'rootFrozenLabelWindow (cat+mouse) is SHORTER than this instrument horizon (2 mouse turns); a CAT_SURVIVAL label at H1 does not bound this window and a NO_WIN here does not contradict it',
          safeClaim: null,
          safeClaimNote: 'Root-level frozen label is window-scoped (PPC-CAT-STRATEGY-01 H1) and is NOT a per-plan safety certificate; NO_WIN within the tested horizon is not cat safety either.',
          cost: { ...ev.cost, twoTurnMs: ev.twoTurn.elapsedMs, oneTurnNodes: ev.oneTurn.nodes },
        };
        local.push(row);
        rows.push(row);
      }
      summaries[id] = {
        completeCatTurns: turns.length,
        expandedStates,
        enumerationMs: elapsedMs,
        production100ms: {
          planString: prod.planString,
          legalCompleteTurn: prodLegal,
          completedDepth: prod.completedDepth,
          deadlineFired: prod.deadlineFired,
          hasSolution: prod.hasSolution,
          refutationSelectedPlanSource: prod.refutationSelectedPlanSource,
        },
        rootSnapshotSha256: snapshotSha(root),
        rootStateKeyHead: stateKey(root).slice(0, 48),
        labels: Object.fromEntries(local.map((r) => [r.plan, r.twoTurn.label])),
        rootFrozenLabel: ROOT_LABEL[id] ?? null,
      };
    }

    const out = {
      round: ROUND,
      phase: 'G4_CROSS_ROOT_SHADOW_RESULTS',
      generatedAt: new Date().toISOString(),
      instrument: {
        name: 'TURN_AWARE_MOUSE_GOAL_RISK',
        wiredToDecision: false,
        horizon: 'TWO_MOUSE_TURNS',
        caps: { twoTurn: 300_000, oneTurn: 50_000 },
      },
      roots: CONTROLS,
      summaries,
      rows,
      g6t2Reference: {
        source: 'TACTICAL_RISK_WITNESSES.json',
        UURR: 'PROVEN_FORCED_WIN',
        DRRR: 'NO_WIN_WITHIN_TESTED_HORIZON (frozen cat-survives H2)',
        DUUD: 'PROVEN_FORCED_WIN (production D2 preferred family)',
        DRDR: 'NO_WIN_WITHIN_TESTED_HORIZON',
      },
      frozenRootLabels: {
        source: 'PPC-CAT-STRATEGY-01/ROOT_CLASSIFICATION.json',
        note: 'Root-level labels use the H1 window (cat turn + mouse turn). They are structural controls, not per-plan certificates, and are NOT transplanted onto this round\'s plan verdicts.',
        consistency: CONTROLS.map((id) => {
          const lab = ROOT_LABEL[id];
          const planLabels = Object.values((summaries[id] as { labels: Record<string, string> }).labels);
          const anyProven = planLabels.includes('PROVEN_FORCED_WIN');
          let relation: string;
          if (lab.classification === 'MOUSE_FORCED_WIN_WITHIN_H1') {
            relation = anyProven
              ? 'CONSISTENT_DIRECTION: root already lost at H1; the stronger two-mouse-turn instrument also fires'
              : 'INCONSISTENT: root is frozen mouse-forced-win but this instrument found no win within 2 mouse turns';
          } else {
            relation = anyProven
              ? 'ROOT_LABEL_IS_WINDOW_SCOPED: survival held only for H1 (cat+mouse); the longer 2-mouse-turn window is outside that label'
              : 'CONSISTENT_NO_CONTRADICTION: longer-window instrument also found no forced win (still not a proof at this window)';
          }
          return { rootId: id, classification: lab.classification, planLabels, relation };
        }),
      },
      verdictPolicy: {
        discrimination: 'A signal is usable only if it separates the certified-bad UURR from the certified-safe DRRR and does not fire on frozen-safe labels.',
        noFitting: 'No threshold, weight or parameter was tuned on these roots.',
        noSafetyFromSilence: 'Uncertified roots are reported as UNKNOWN_SAFETY regardless of the shadow verdict.',
      },
    };
    writeJson(`${ROUND}/CROSS_ROOT_SHADOW_RESULTS.json`, out);

    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.legal).toBe(true);
    // No safety claim is ever produced for a root without a frozen label.
    for (const r of rows) expect(r.safeClaim).toBeNull();
  });
});