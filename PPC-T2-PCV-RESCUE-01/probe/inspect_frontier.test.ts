/// <reference types="node" />
/** Read-only frontier inspection for representative candidates (no new proof). */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { GamePhase } from '../../src/game/types';
import { label, rules, stateKey, applyPrefix } from './rescue_lib';
import { applyNoMoveLoss } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

describe('frontier inspection', () => {
  it('inspects representative refuted frontiers', () => {
    const doc = JSON.parse(readFileSync('PPC-T2-PCV-RESCUE-01/CANDIDATE_PLANS.json', 'utf8'));
    const fixtures = JSON.parse(readFileSync('src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', 'utf8'));
    const out: unknown[] = [];
    for (const id of ['G5T4/E1/C1', 'G6T3/E1/C1']) {
      const s = doc.strata.find((x: { candidates: { candidateId: string }[] }) =>
        x.candidates.some((c) => c.candidateId === id));
      const c = s.candidates.find((x: { candidateId: string }) => x.candidateId === id);
      const rec = fixtures.find((r: { id: string }) => r.id === s.rootId);
      const root = restoreHardRoot(rec.state);
      const pre = applyPrefix(root, [...c.planChars], 0);
      const f = pre.states[0];
      const actions = generatePreparedSearchActions(f, rules).map((p) => {
        const st = p.transition.kind === 'deterministic' ? p.transition.state : p.transition.outcomes[0].state;
        return {
          label: label(p.action), kind: p.transition.kind,
          phaseAfter: st.phase, mouseWins: applyNoMoveLoss(st).phase === GamePhase.MouseWins,
        };
      });
      out.push({
        candidateId: id, plan: c.planString, frontierStateKey: stateKey(f),
        frontierPhase: f.phase, frontierPlayer: f.currentPlayer,
        mouseMovesLeft: f.mouseMovesLeft, mouseHasButter: f.mouseHasButter,
        actions,
      });
    }
    writeFileSync('PPC-T2-PCV-RESCUE-01/_raw/FRONTIER_INSPECTION.json', JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
    expect(out.length).toBe(2);
    expect((out as { frontierPlayer: string; mouseMovesLeft: number }[])
      .every((x) => x.frontierPlayer === 'mouse' && x.mouseMovesLeft === 3)).toBe(true);
  });
});
