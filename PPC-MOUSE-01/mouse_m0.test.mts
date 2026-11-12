/**
 * PPC-MOUSE-01 / P2 + P3 — the M0 mouse controller.
 *
 * M0 = single-step decision on the SHARED search core, execute through the REAL
 * engine, observe, replan — with ONE main-search budget for the whole turn
 * (never "one 100 ms per step").
 *
 * Part A runs with a generous per-step grant so CORRECTNESS can be observed
 * independently of the budget. Part B is the real 100 ms question.
 */
import { describe, expect, it } from 'vitest';
import {
  fixtures, runMouseTurnM0, RULES, MOUSE_TURN_BUDGET_MS, MIN_STEP_BUDGET_MS,
  applyNoMoveLoss, generateLegalSearchActions, GamePhase, PieceType,
  writeOut, appendJsonl, labelAction,
} from './mouse_lib.mts';

const GENEROUS = 600;

function brief(r: ReturnType<typeof runMouseTurnM0>) {
  return {
    id: r.fixtureId, policy: r.policy, D: r.maxDepthTurns, budget: r.budgetMs,
    steps: r.steps.length,
    actions: r.steps.map((s) => s.action),
    depths: r.steps.map((s) => `${s.completedDepth}/${s.attemptedDepth}`),
    stepWall: r.steps.map((s) => s.searchMs),
    end: `${r.endPhase}/${r.endPlayer}`,
    terminal: r.terminal,
    fullTurn: r.fullTurnExecuted,
    wall: r.totalWallMs,
    overrun: r.turnOverrunMs,
    parities: r.steps.map((s) => s.parity),
    rejects: r.rejects, mismatches: r.mismatches, random: r.randomCallsDuringPlanning,
    abort: r.abortReason,
  };
}

describe('PPC-MOUSE-01 / P2-P3 M0 controller', () => {
  it('P2-A: every fixture, generous budget — legal, engine-verified, deterministic-info', () => {
    const runs: any[] = [];
    for (const f of fixtures()) {
      const r = runMouseTurnM0(f.id, f.state, {
        budgetMs: GENEROUS, policy: 'SHARED_GREEDY', maxDepthTurns: 1,
      });
      runs.push(brief(r));
      appendJsonl('p2a_m0_generous.jsonl', brief(r));
      console.log(
        f.id.padEnd(15), 'steps=' + r.steps.length, '[' + r.steps.map((s) => s.action).join(' ') + ']',
        'end=' + r.endPhase + '/' + r.endPlayer, 'terminal=' + r.terminal,
        'wall=' + r.totalWallMs + 'ms', 'parity=' + r.steps.map((s) => s.parity).join(','),
        'rand=' + r.randomCallsDuringPlanning, 'abort=' + String(r.abortReason),
      );

      // universal invariants
      expect(r.mismatches).toBe(0);
      expect(r.rejects).toBe(0);
      expect(r.randomCallsDuringPlanning).toBe(0);
      for (const s of r.steps) {
        expect(s.parity === 'exact' || s.parity === 'chance_masked').toBe(true);
        expect(s.completed).toBe(true);
        expect(s.completedDepth).toBeGreaterThanOrEqual(1);
      }
    }
    writeOut('p2a_m0_generous_all.json', {
      section: 'P2-A M0 with a generous budget (correctness isolated from cost)',
      perStepBudgetCapMs: GENEROUS, maxDepthTurns: 1, runs,
    });
    expect(runs.length).toBe(fixtures().length);
  }, 1_800_000);

  it('P2-B: named behaviours — win, skill, trap, tunnel, RULE-A, cat adjacency', () => {
    const get = (id: string) => fixtures().find((x) => x.id === id)!;

    const win = runMouseTurnM0('M_CARRY_HOME', get('M_CARRY_HOME').state, {
      budgetMs: GENEROUS, maxDepthTurns: 1,
    });
    console.log('M_CARRY_HOME ->', win.terminal, win.steps.map((s) => s.action).join(' '));
    expect(win.terminal).toBe('MouseWins');
    expect(win.steps.length).toBe(2);

    const skill = runMouseTurnM0('M_SKILL_ONLY', get('M_SKILL_ONLY').state, {
      budgetMs: GENEROUS, maxDepthTurns: 1,
    });
    console.log('M_SKILL_ONLY ->', skill.steps.map((s) => `${s.action}(${s.rootActionCount})`).join(' '),
      'end=' + skill.endPhase + '/' + skill.endPlayer);
    expect(skill.steps[0].action).toBe('skill');
    expect(skill.steps[0].rootActionCount).toBe(1);

    const trap = runMouseTurnM0('M_TRAP_ONLY', get('M_TRAP_ONLY').state, {
      budgetMs: GENEROUS, maxDepthTurns: 1,
    });
    console.log('M_TRAP_ONLY ->', trap.steps.map((s) => s.action).join(' '),
      'end=' + trap.endPhase + '/' + trap.endPlayer, 'movesAfter=?');
    expect(trap.steps.length).toBe(1);
    expect(trap.steps[0].action).toBe('mouse↓');
    expect(trap.endPlayer).toBe(PieceType.Cat);

    const tunnel = runMouseTurnM0('M_TUNNEL', get('M_TUNNEL').state, {
      budgetMs: GENEROUS, maxDepthTurns: 1,
    });
    console.log('M_TUNNEL ->', tunnel.steps.map((s) => `${s.action}@${s.phaseIn}`).join(' '),
      'end=' + tunnel.endPhase + '/' + tunnel.endPlayer);
    // the tunnel produces a sub-phase: enter, then a chooseTunnel exit
    const entered = tunnel.steps.some((s) => s.action === 'mouse←');
    const chose = tunnel.steps.some((s) => s.action.startsWith('exit('));
    expect(entered || chose).toBe(true);
    if (chose) expect(tunnel.endPlayer).toBe(PieceType.Cat);

    const stranded = runMouseTurnM0('M_STRANDED', get('M_STRANDED').state, {
      budgetMs: GENEROUS, maxDepthTurns: 1,
    });
    console.log('M_STRANDED ->', 'steps=' + stranded.steps.length, 'abort=' + stranded.abortReason,
      'terminal=' + stranded.terminal);
    expect(stranded.steps.length).toBe(0);
    expect(stranded.abortReason).toBe('rule_a_terminal_before_planning');
    expect(stranded.terminal).toBe('CatWins');

    writeOut('p2b_named_behaviours.json', {
      section: 'P2-B named behaviours',
      win: brief(win), skill: brief(skill), trap: brief(trap),
      tunnel: brief(tunnel), stranded: brief(stranded),
    });
  }, 1_800_000);

  it('P2-C: the mouse never reads a future random outcome while planning', () => {
    // Same planner, same state, two different injected Math.random draws.
    // If the decision depended on a draw, these would differ.
    const root = fixtures().find((x) => x.id === 'M_BUTTER_PICKUP')!.state;
    const chosen: string[] = [];
    const values: number[] = [];
    for (const draw of [0, 0.5, 0.999999]) {
      const real = Math.random;
      Math.random = () => draw;
      try {
        const r = runMouseTurnM0('M_BUTTER_PICKUP', root, { budgetMs: 300, maxDepthTurns: 1 });
        chosen.push(r.steps.map((s) => s.action).join(' '));
        values.push(r.steps.length ? r.steps[0].value : NaN);
        expect(r.mismatches).toBe(0);
      } finally {
        Math.random = real;
      }
    }
    writeOut('p2c_random_independence.json', {
      fixture: 'M_BUTTER_PICKUP',
      draws: [0, 0.5, 0.999999],
      chosenPlans: chosen,
      firstStepValues: values,
      identical: chosen.every((c) => c === chosen[0]),
      note: 'the planner enumerates the spawn distribution; a draw can only affect the REAL engine execution afterwards',
    });
    console.log('draw-independence:', chosen.join(' | '), '| values', values.join(','));
    expect(new Set(chosen).size).toBe(1);
  }, 1_800_000);

  it('P3-A: the real 100 ms question — one shared budget for the WHOLE mouse turn', () => {
    const runs: any[] = [];
    for (const f of fixtures()) {
      for (const D of [4, 1]) {
        for (const policy of ['SHARED_GREEDY', 'SHARED_EVEN'] as const) {
          const r = runMouseTurnM0(f.id, f.state, {
            budgetMs: MOUSE_TURN_BUDGET_MS, policy, maxDepthTurns: D,
          });
          const b = brief(r);
          runs.push(b);
          appendJsonl('p3a_m0_100ms.jsonl', b);
          console.log(
            f.id.padEnd(15), 'D' + D, policy.padEnd(14),
            'steps=' + r.steps.length,
            'depths=[' + r.steps.map((s) => s.completedDepth).join(',') + ']',
            'wall=' + r.totalWallMs.toFixed(0) + 'ms',
            'over=' + r.turnOverrunMs.toFixed(0),
            'full=' + r.fullTurnExecuted,
            'abort=' + String(r.abortReason),
          );
        }
      }
    }
    writeOut('p3a_m0_100ms_all.json', {
      section: 'P3-A M0 under ONE shared 100 ms main-search budget for the whole turn',
      budgetMs: MOUSE_TURN_BUDGET_MS,
      hardWallMs: 150,
      minStepBudgetMs: MIN_STEP_BUDGET_MS,
      runs,
      note: 'per-step grants reported in each step record; a naive per-step 100 ms model would spend steps*100 ms',
    });
    // no run may execute an unverified action
    expect(runs.every((r) => r.rejects === 0 && r.mismatches === 0 && r.random === 0)).toBe(true);
  }, 1_800_000);

  it('P3-B: budget accounting — the pool is shared, not re-granted per step', () => {
    const root = fixtures().find((x) => x.id === 'M_CARRY_HOME')!.state;
    const r = runMouseTurnM0('M_CARRY_HOME', root, {
      budgetMs: MOUSE_TURN_BUDGET_MS, policy: 'SHARED_GREEDY', maxDepthTurns: 4,
    });
    const sumBudget = r.steps.reduce((a, s) => a + s.budgetMs, 0);
    const naive = r.steps.length * MOUSE_TURN_BUDGET_MS;
    writeOut('p3b_budget_accounting.json', {
      fixture: 'M_CARRY_HOME',
      turnBudgetMs: MOUSE_TURN_BUDGET_MS,
      grantsMs: r.steps.map((s) => s.budgetMs),
      searchMs: r.steps.map((s) => s.searchMs),
      cumulativeGranted: +sumBudget.toFixed(2),
      naivePerStepModel: naive,
      totalWallMs: r.totalWallMs,
      overrunMs: r.turnOverrunMs,
      hardWallMs: 150,
      note: 'cumulative grants never exceed the turn budget by construction; the naive model would be steps x 100 ms',
    });
    console.log('grants=' + r.steps.map((s) => s.budgetMs).join(','), 'cum=' + sumBudget,
      'naive=' + naive, 'wall=' + r.totalWallMs);
    // the grant pool is shared: every step's grant is <= what the turn had left
    expect(sumBudget).toBeLessThanOrEqual(MOUSE_TURN_BUDGET_MS + 1e-6);
  }, 1_800_000);

  it('P3-C: every executed action is a real action of the searched root', () => {
    // Two independent legality signals, deliberately kept separate:
    //   (a) ENGINE ACCEPTANCE — `executeReal` runs every step through the real
    //       engine and reports `rejects` / `mismatches`. That covers ALL steps
    //       (26 at D1/100ms, 26 at the generous budget) and is the strong one.
    //   (b) LEGAL-SET MEMBERSHIP — here we re-derive the legal set at the very
    //       FIRST root of each fixture and check the executed action is in it.
    //       This is an independent enumeration (it does not reuse the search),
    //       so it catches "the search invented an action the rules never had".
    //       Only step 0 is re-derived on purpose: replaying later steps would
    //       need to re-run the CHANCE draw, which is exactly what M0 refuses to
    //       do inside a plan.
    const rows: any[] = [];
    for (const f of fixtures()) {
      const r = runMouseTurnM0(f.id, f.state, { budgetMs: 120, policy: 'SHARED_EVEN', maxDepthTurns: 1 });
      if (r.steps.length === 0) {
        appendJsonl('p3c_action_legality.jsonl', { fixture: f.id, checked: 0, why: 'no step executed (RULE-A terminal before planning)' });
        continue;
      }
      const first = r.steps[0];
      const legal = generateLegalSearchActions(f.state, RULES).map(labelAction);
      const ok = legal.includes(first.action);
      rows.push({
        fixture: f.id, step: first.index, action: first.action,
        inLegalSet: ok, phase: first.phaseIn,
        engineVerdict: first.parity,
        legalSetSize: legal.length,
      });
      expect(ok).toBe(true);
      // the engine agreeing is a SECOND, independent acceptance of the same action
      expect(['exact', 'chance_masked']).toContain(first.parity);
      appendJsonl('p3c_action_legality.jsonl', { fixture: f.id, checked: 1 });
    }
    writeOut('p3c_action_legality_all.json', {
      rows,
      engineAcceptance: {
        steps: rows.length,
        rejects: rows.length - rows.filter((x) => x.engineVerdict !== 'reject').length,
        note: 'full-turn step coverage comes from the M0 runs themselves (rejects=0 over every executed step at both budgets)',
      },
    });
    // M_STRANDED executes nothing (RULE-A), so it contributes no row: 11 - 1
    expect(rows.length).toBe(fixtures().length - 1);
  }, 1_800_000);
});
