/// <reference types="node" />
/**
 * PPC-HV-2 §4B — holeControl sign impact, measured on the four fixed human roots.
 *
 * No new formula: the baseline numbers come from `evaluateForCatDetailed`
 * (evaluation.ts) and the control from the ALREADY EXISTING H1 production leaf
 * `evaluateCorrectedHoleForCat` / `correctedHoleControlValue`
 * (correctedHoleLeaf.ts). We only READ what those two say.
 *
 * Printed, not asserted — this is the audit table the §5 arms comparison cites.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import type { GameEngineState } from '../../engine';
import { createEngineRuleSet } from '../../engine';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { evaluateForCatDetailed, DEFAULT_EVALUATION_WEIGHTS } from '../evaluation';
import { correctedHoleControlValue } from '../correctedHoleLeaf';
import { generateLegalSearchActions } from '../legalActions';
import { simulateSearchAction } from '../simulator';

interface PinnedRoot { id: string; stateKey: string; snapshot: HardRootSnapshot }

function loadPinned(): PinnedRoot[] {
  const raw = readFileSync(
    new URL('../../../../ai-training/human-logs/PPC-HV2/roots.json', import.meta.url),
    'utf8',
  ) as string;
  return JSON.parse(raw) as PinnedRoot[];
}

const actionLabel = (a: { type: string; direction?: { label?: string } }): string =>
  a.type === 'catStep' ? `Step ${a.direction?.label ?? '?'}` : a.type;

test('HV2-B1. holeControl term contribution at the four roots and their 1-ply successors', () => {
  const rules = createEngineRuleSet();
  for (const r of loadPinned()) {
    const root = restoreHardRoot(r.snapshot) as GameEngineState;
    const lines: string[] = [`\n===== ${r.id}  weight.holeControl=${DEFAULT_EVALUATION_WEIGHTS.holeControl}`];

    const probe = (label: string, state: GameEngineState): void => {
      const bd = evaluateForCatDetailed(state);
      const f = bd.features;
      const both = f.catHoleGateDistance !== null && f.mouseHoleGateDistance !== null;
      const corrected = correctedHoleControlValue(bd, state.config.boardSize);
      lines.push(
        `${label.padEnd(22)} reach=${both ? 'BOTH' : f.catHoleGateDistance !== null ? 'CAT-ONLY' : f.mouseHoleGateDistance !== null ? 'MOUSE-ONLY' : 'NONE'}`
        + ` catGate=${f.catHoleGateDistance} mouseGate=${f.mouseHoleGateDistance} margin=${f.holeControlMargin}`
        + ` | baseHole=${bd.contributions.holeControl.toFixed(1)} h1Hole=${corrected.toFixed(1)}`
        + ` delta=${(corrected - bd.contributions.holeControl).toFixed(1)}`
        + ` | total=${bd.total.toFixed(1)} h1Total=${(bd.total - bd.contributions.holeControl + corrected).toFixed(1)}`,
      );
    };

    probe('ROOT', root);

    // One-ply cat successors (deterministic transitions only; a chance node here
    // would be the final-step ghost boundary and is reported as such).
    const ranked: Array<{ label: string; base: number; h1: number }> = [];
    for (const a of generateLegalSearchActions(root, rules)) {
      const trans = simulateSearchAction(root, a, rules);
      if (trans.kind !== 'deterministic') {
        lines.push(`${actionLabel(a).padEnd(22)} CHANCE node (${trans.kind}) — skipped in this table`);
        continue;
      }
      const label = actionLabel(a);
      probe(label, trans.state);
      const bd = evaluateForCatDetailed(trans.state);
      const corrected = correctedHoleControlValue(bd, trans.state.config.boardSize);
      ranked.push({
        label,
        base: bd.total,
        h1: bd.total - bd.contributions.holeControl + corrected,
      });
    }

    const baseOrder = [...ranked].sort((x, y) => y.base - x.base).map((x) => x.label);
    const h1Order = [...ranked].sort((x, y) => y.h1 - x.h1).map((x) => x.label);
    lines.push(`rank baseline : ${baseOrder.join(' > ')}`);
    lines.push(`rank H1       : ${h1Order.join(' > ')}`);
    lines.push(
      ranked.map((x) => `${x.label} base=${x.base.toFixed(1)} h1=${x.h1.toFixed(1)}`).join('\n'),
    );
    console.log(lines.join('\n'));
  }
  expect(loadPinned().length).toBe(4);
});

// ===========================================================================
// HV2-B2 — why does a STEP lose score at all? Full contribution vector per
// 1-ply successor, so the loop can be attributed to a named term instead of a
// feeling. tempo = ((catMovesLeft − mouseMovesLeft)/base) * 200 is consumed by
// every step and by NO trap placement (catPlaceTrap is move-free), so the leaf
// structurally prefers the free action.
// ===========================================================================
test('HV2-B2. full contribution vector at the roots and their 1-ply successors', () => {
  const rules = createEngineRuleSet();
  const keys = [
    'capturePressure', 'mouseGoalThreat', 'butterRace', 'confinement', 'mobility',
    'trapControl', 'tunnelControl', 'holeControl', 'voronoiBalance', 'tempo',
  ] as const;
  for (const r of loadPinned()) {
    const root = restoreHardRoot(r.snapshot) as GameEngineState;
    const rows: string[] = [`\n===== ${r.id}  weights=${JSON.stringify(DEFAULT_EVALUATION_WEIGHTS)}`];
    rows.push(`${'action'.padEnd(14)}${keys.map((k) => k.slice(0, 7).padStart(9)).join('')}${''.padStart(9)}total`);
    const row = (label: string, state: GameEngineState): void => {
      const bd = evaluateForCatDetailed(state);
      rows.push(
        label.padEnd(14)
        + keys.map((k) => bd.contributions[k].toFixed(1).padStart(9)).join('')
        + bd.total.toFixed(1).padStart(10),
      );
    };
    row('ROOT', root);
    for (const a of generateLegalSearchActions(root, rules)) {
      const trans = simulateSearchAction(root, a, rules);
      if (trans.kind !== 'deterministic') continue;
      row(actionLabel(a), trans.state);
    }
    console.log(rows.join('\n'));
  }
  expect(loadPinned().length).toBe(4);
});

// ===========================================================================
// HV2-B3 — raw features behind those contributions. capturePressure prints
// −900.0 both when catMouseDistance is null AND when it equals boardSize, so
// the feature itself has to be read before the term can be interpreted.
// ===========================================================================
test('HV2-B3. raw evaluation features at the roots and their 1-ply successors', () => {
  const rules = createEngineRuleSet();
  for (const r of loadPinned()) {
    const root = restoreHardRoot(r.snapshot) as GameEngineState;
    const rows: string[] = [`\n===== ${r.id}`];
    const show = (label: string, state: GameEngineState): void => {
      const f = evaluateForCatDetailed(state).features;
      rows.push(
        label.padEnd(14)
        + `cat@${state.catPosition.r},${state.catPosition.c}(${state.board[state.catPosition.r][state.catPosition.c].type})`
        + ` mouse@${state.mousePosition.r},${state.mousePosition.c}(${state.board[state.mousePosition.r][state.mousePosition.c].type})`
        + `\n${''.padEnd(14)}catMouseDist=${f.catMouseDistance} mouseGoal=${f.mouseGoalDistance}`
        + ` winRoute=${f.mouseWinRouteDistance} butterDist=${f.mouseButterDistance}`
        + `\n${''.padEnd(14)}mobility(m/c)=${f.mouseMobility}/${f.catMobility}`
        + ` area(m/c)=${f.mouseReachableArea}/${f.catReachableArea}`
        + ` openTunnel=${f.openTunnelCount} tunnelAllowed=${f.mouseTunnelAllowed}`
        + ` mouseTunnelDist=${f.mouseTunnelAccessDistance} canReachTunnel=${f.mouseCanReachTunnel}`
        + ` trapActive=${f.trapActive} mouseTrapDist=${f.mouseTrapDistance} catHasTrap=${f.catHasTrapAvailable}`
        + ` voronoi(c/m/contested)=${f.catControlledArea}/${f.mouseControlledArea}/${f.contestedArea}`,
      );
    };
    show('ROOT', root);
    for (const a of generateLegalSearchActions(root, rules)) {
      const trans = simulateSearchAction(root, a, rules);
      if (trans.kind !== 'deterministic') continue;
      show(actionLabel(a), trans.state);
    }
    console.log(rows.join('\n'));
  }
  expect(loadPinned().length).toBe(4);
});
