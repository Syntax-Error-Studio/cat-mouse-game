import { describe, expect, it } from 'vitest';
import {
  fixtures, RULES, planMouseSearch, labelAction,
  generateLegalSearchActions, applyNoMoveLoss, GamePhase, PieceType,
} from './mouse_lib.mts';

describe('PPC-MOUSE-01 smoke', () => {
  it('fixtures build, are legal, and expose their legal action sets', () => {
    const fs = fixtures();
    for (const f of fs) {
      const legal = generateLegalSearchActions(f.state, RULES);
      const settled = applyNoMoveLoss(f.state);
      console.log(
        f.id.padEnd(16),
        'phase=' + f.state.phase,
        'player=' + f.state.currentPlayer,
        'moves=' + f.state.mouseMovesLeft,
        'butter=' + f.state.mouseHasButter,
        'legal=[' + legal.map((a) => labelAction(a)).join(',') + ']',
        settled === f.state ? '' : 'RULE_A->' + settled.phase,
        '|', f.note,
      );
      expect(legal.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it('one mouse root search returns an action at depth 1', () => {
    const root = fixtures().find((f) => f.id === 'M_CARRY_HOME')!.state;
    const call = planMouseSearch(root, { budgetMs: 200 });
    console.log('M_CARRY_HOME', 'action=' + labelAction(call.result.bestAction),
      'value=' + call.result.value, 'mate=' + call.result.mate,
      'depth=' + call.result.completedDepth, 'nodes=' + call.result.diagnostics.totalNodes,
      'wall=' + call.wallMs.toFixed(0) + 'ms');
    expect(call.result.bestAction).not.toBeNull();
    expect(call.result.completedDepth).toBeGreaterThanOrEqual(1);
    // sanity: the chosen action must be a MOUSE action, not a cat one
    expect(['mouseStep', 'mouseSkill', 'chooseTunnel']).toContain(call.result.bestAction!.type);
  }, 120_000);
});
