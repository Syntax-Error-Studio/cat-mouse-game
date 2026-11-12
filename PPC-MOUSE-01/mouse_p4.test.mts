/**
 * PPC-MOUSE-01 / P4 — what is MISSING for a mouse controller, measured rather
 * than asserted. Every check here is a read of production behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  fixtures, planMouseSearch, RULES, LEAF, labelAction, writeOut,
  generateLegalSearchActions, applyNoMoveLoss, stateKey,
} from './mouse_lib.mts';
import { createSearchContext, searchBestAction, searchBestActionIterative } from '../src/game/ai/expectiminimax';
import { forcedLossTieBreak } from '../src/game/ai/forcedLossTieBreak';
import { buildCatTurnPlan } from '../src/game/ai/expectiminimax';

describe('PPC-MOUSE-01 / P4 integration gaps', () => {
  it('P4-1: catTurnPlan is EMPTY at every mouse root (the walker is cat-gated)', () => {
    const rows: any[] = [];
    for (const f of fixtures()) {
      const r = searchBestActionIterative(f.state, {
        rules: RULES, maxDepthTurns: 1, maxNodes: 200_000,
        useTT: true, useAlphaBeta: true, useMoveOrdering: true,
        leafEvaluator: LEAF,
      });
      rows.push({
        id: f.id,
        bestAction: labelAction(r.bestAction),
        catTurnPlanLen: r.catTurnPlan.length,
        previousCompletedPlanLen: r.previousCompletedPlan.length,
        completedDepth: r.completedDepth,
      });
      expect(r.catTurnPlan.length).toBe(0);
      // a mouse root has no cat plan, but it DOES have an action
      if (r.mate !== 'mouse' || r.bestAction) expect(r.bestAction).not.toBeNull();
    }
    writeOut('p4_plan_gap.json', {
      section: 'P4-1 the search returns an ACTION at a mouse root but NO turn plan',
      rows,
      cause: 'buildCatTurnPlan (expectiminimax.ts:1894) and planQuality.fallbackPlanWalk (:582) both break on `currentPlayer !== PieceType.Cat`',
      note: 'M0 only needs the action, so this is not a blocker for M0 — it IS a blocker for any whole-turn mouse plan',
    });
    console.log(rows.map((r) => `${r.id.padEnd(15)} action=${r.bestAction.padEnd(12)} catPlan=${r.catTurnPlanLen}`).join('\n'));
  }, 900_000);

  it('P4-2: forcedLossTieBreak still runs at a mouse root, on CAT plans (dead weight)', () => {
    const root = fixtures().find((x) => x.id === 'M_CARRY_HOME')!.state;
    const ctx = createSearchContext(RULES, 200_000, true, true, true, 0, false);
    ctx.capturePlan = true; // the plan log is what forcedLossTieBreak consumes
    const r = searchBestAction(root, 1, ctx);
    expect(r.mate).toBe('mouse');
    const rootValues = (ctx as any).rootValues ?? [];
    const t0 = performance.now();
    const tied = forcedLossTieBreak(root, ctx, rootValues);
    const ms = performance.now() - t0;
    const plan = buildCatTurnPlan(root, ctx);
    writeOut('p4_forced_loss_tiebreak_at_mouse_root.json', {
      fixture: 'M_CARRY_HOME',
      searchMate: r.mate,
      rootValueCount: rootValues.length,
      mouseMateRootActions: rootValues.filter((a: any) => a.mate === 'mouse').length,
      exactBounds: rootValues.filter((a: any) => a.bound === 'exact').length,
      tieBreakResult: tied === null ? null : tied.map(labelAction),
      tieBreakMs: +ms.toFixed(3),
      catPlanAtMouseRoot: plan.map(labelAction),
      note: 'the forced-loss tie-break is a CAT-plan selector; at a mouse root it either returns null (fail closed) or, worse, a plan nobody can use. Its output never reaches M0.',
    });
    console.log('forcedLossTieBreak at mouse root ->', tied === null ? 'null' : tied.map(labelAction), ms.toFixed(3) + 'ms',
      '| rootValues=' + rootValues.length, 'mouseMate=' + rootValues.filter((a: any) => a.mate === 'mouse').length);
    expect(plan.length).toBe(0);
  }, 900_000);

  it('P4-3: a RULE-A-stranded root still advertises legal actions', () => {
    const f = fixtures().find((x) => x.id === 'M_STRANDED')!;
    const settled = applyNoMoveLoss(f.state);
    const legal = generateLegalSearchActions(f.state, RULES);
    const call = planMouseSearch(f.state, { budgetMs: 400, maxDepthTurns: 1 });
    writeOut('p4_rule_a_sink.json', {
      fixture: 'M_STRANDED',
      ruleAVerdict: settled === f.state ? 'none' : settled.phase,
      legalActionsAdvertised: legal.map(labelAction),
      searchAction: labelAction(call.result.bestAction),
      searchValue: call.result.value,
      searchMate: call.result.mate,
      nodes: call.result.diagnostics.totalNodes,
      note: 'simulateSearchAction settles RULE-A first, so every candidate maps to the SAME terminal and none of them is a no-op -> the legal set is non-empty in a position that is already decided',
    });
    console.log('M_STRANDED: RULE-A ->', settled.phase, '| advertised legal =', legal.map(labelAction).join(','),
      '| search says', call.result.value, call.result.mate, 'action=' + labelAction(call.result.bestAction),
      'nodes=' + call.result.diagnostics.totalNodes);
    expect(settled.phase).toBe('cat_wins');
    expect(legal.length).toBe(4);
  }, 900_000);

  it('P4-4: what a whole-turn mouse plan would have to do (not implemented)', async () => {
    // The tunnel fixture is the cheapest demonstration of why a LINEAR mouse
    // plan is wrong: entering a tunnel yields a sub-phase whose action set is
    // only the exit choices, and the real engine may auto-resolve it.
    const f = fixtures().find((x) => x.id === 'M_TUNNEL')!;
    const step = generateLegalSearchActions(f.state, RULES).find((a) => a.type === 'mouseStep' && labelAction(a) === 'mouse←')!;
    const after = (await import('../src/game/engine')).mouseMove(f.state, (step as any).direction);
    writeOut('p4_mouse_plan_requirements.json', {
      fixture: 'M_TUNNEL',
      enteredPhase: after.phase,
      exitChoices: after.tunnelExitChoices.length,
      exitChoiceSample: after.tunnelExitChoices.map((c: any) => `(${c.r},${c.c}) ${c.label ?? ''}`.trim()),
      requirements: [
        'the plan must be CONDITIONAL, not a linear action list: a butter pickup forks into a CHANCE node whose revealed ghost changes the next decision',
        'tunnel entry leaves the mouse in phase choosing_tunnel_exit, whose legal set is only the exits (and the engine auto-resolves a single exit)',
        'a trap step zeroes the remaining moves, so plan length is state-dependent, not config-dependent',
        'RULE-A can end the turn (and the game) at any hand-off, so any planner must re-check it before executing the next planned action',
        'the shared search gives (bestAction, value, mate) per REPLAN; a whole-turn plan needs a mouse-side equivalent of buildCatTurnPlan + extractBestCatTurnPlan + forcedLossTieBreak',
      ],
      note: 'M0 sidesteps all five by construction: it commits to ONE action, executes it through the real engine, and replans from the OBSERVED state',
    });
    console.log('M_TUNNEL entry ->', after.phase, 'choices=' + after.tunnelExitChoices.length);
    expect(after.phase).toBe('choosing_tunnel_exit');
  }, 900_000);
});
