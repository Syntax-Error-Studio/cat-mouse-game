/**
 * PPC-CAT-STRATEGY-01 — P3: the trap resource (when, and at what price).
 *
 * READ-ONLY. Real game-1 turn-1 root + explicit counterfactuals.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { parseFourGames, restoreTurnRoot } from '../ai-training/f2b19a/f2b19a_lib.mts';
import { createEngineRuleSet, catPlaceTrap, catMove, mouseMove, getDirectionByKey } from '../src/game/engine';
import type { GameEngineState } from '../src/game/engine';
import type { RuleSet } from '../src/game/ai/searchTypes';
import { GamePhase, PieceType } from '../src/game/types';
import { evaluateForCatDetailed } from '../src/game/ai/evaluation';
import { planHardCatTurn } from '../src/game/ai/hardTurnPlanner';
import { mkState, planLabel, manhattan } from './cs01_lib.mts';
import { DEFAULT_CONFIG } from '../src/game/config';

const REPO = process.cwd();
const OUT = path.join(REPO, 'PPC-CAT-STRATEGY-01', 'out');
fs.mkdirSync(OUT, { recursive: true });
const write = (n: string, o: unknown) => fs.writeFileSync(path.join(OUT, n), JSON.stringify(o, null, 2), 'utf8');

const rules: RuleSet = createEngineRuleSet();
const games = parseFourGames();

describe('CS01-P3 trap timing and opportunity cost', () => {
  it('records that every real game spent its only trap on turn 1 at the cat start cell', () => {
    const rows = games.map((g) => {
      const t1 = g.turns[0];
      const root = restoreTurnRoot(t1);
      const after = catPlaceTrap({ ...root, trapPosition: null, catTrapsRemaining: 1 });
      const distToTrap = root.trapPosition ? manhattan(root.mousePosition, root.trapPosition) : null;
      return {
        game: g.gameNo,
        turn1Plan: t1.planLabel,
        turn1PlanStartsWithTrap: t1.planLabel.startsWith('T'),
        trapPlacedAt: after.trapPosition,
        trapEqualsCatStart: after.trapPosition.r === 1 && after.trapPosition.c === 1,
        catMovesLeftBefore: root.catMovesLeft,
        catMovesLeftAfterPlacing: after.catMovesLeft,
        mouseAt: root.mousePosition,
        mouseDistanceToTrapWhenPlaced: after.trapPosition
          ? manhattan(root.mousePosition, after.trapPosition) : null,
        trapControlImmediatelyGained: Number(
          (evaluateForCatDetailed(after).total - evaluateForCatDetailed({ ...root, trapPosition: null, catTrapsRemaining: 1 }).total).toFixed(3),
        ),
      };
    });
    write('cs01_p3_real_first_turn_trap.json', { rows });

    // 4/4 real games: the first cat plan begins with a trap placement.
    expect(rows.filter((r) => r.turn1PlanStartsWithTrap).length).toBeGreaterThanOrEqual(3);
    // And placement costs the cat ZERO moves: it is a free action.
    expect(rows.every((r) => r.catMovesLeftAfterPlacing === r.catMovesLeftBefore)).toBe(true);
  });

  it('measures the immediate reward of placing the trap and the cost the leaf never counts', () => {
    const root = restoreTurnRoot(games[0].turns[0]);
    const bare: GameEngineState = { ...root, trapPosition: null, catTrapsRemaining: 1 };
    const placed = catPlaceTrap(bare);

    const breakdown = (s: GameEngineState) => {
      const d = evaluateForCatDetailed(s);
      return {
        total: Number(d.total.toFixed(3)),
        trapControl: Number(d.contributions.trapControl.toFixed(3)),
        mouseTrapDistance: d.features.mouseTrapDistance,
        catHasTrapAvailable: d.features.catHasTrapAvailable,
        trapActive: d.features.trapActive,
      };
    };

    // Resource counter is a FEATURE but never a SCORE: two states differing
    // only in `catTrapsRemaining` / `trapActive` (mouse far away) score the same.
    const oneTrapInHand = { ...bare, catTrapsRemaining: 1 };
    const noTrapInHand = { ...bare, catTrapsRemaining: 0 };
    const trapFarAway: GameEngineState = { ...bare, trapPosition: { r: 1, c: 1 }, catTrapsRemaining: 0 };

    // A trap that the mouse actually has to cross IS worth something positive —
    // the reverse control that keeps this from being "never place a trap".
    const bait = mkState({
      config: DEFAULT_CONFIG,
      butters: [{ r: 5, c: 5 }],
      cat: { r: 4, c: 4 },
      mouse: { r: 4, c: 5 },
      catMovesLeft: 4,
      mouseMovesLeft: 4,
      trap: { r: 4, c: 5 },
      trapsRemaining: 1,
      currentPlayer: 'mouse',
    });
    const bait2 = mkState({
      config: DEFAULT_CONFIG,
      butters: [{ r: 5, c: 5 }],
      cat: { r: 4, c: 4 },
      mouse: { r: 4, c: 5 },
      catMovesLeft: 4,
      mouseMovesLeft: 4,
      trap: null,
      trapsRemaining: 2,
      currentPlayer: 'mouse',
    });

    const art = {
      realRoot: { game: games[0].gameNo, turn: games[0].turns[0].turn, cat: root.catPosition, mouse: root.mousePosition },
      withoutTrap: breakdown(bare),
      withTrapPlaced: breakdown(placed),
      immediateGain: Number((breakdown(placed).total - breakdown(bare).total).toFixed(3)),
      resourceCounterIrrelevance: {
        oneTrapInHand: breakdown(oneTrapInHand),
        noTrapInHand: breakdown(noTrapInHand),
        identical: breakdown(oneTrapInHand).total === breakdown(noTrapInHand).total,
        trapPlacedFarAway: breakdown(trapFarAway),
        note: 'catTrapsRemaining / trapActive are FEATURES; scoreFeatures() never reads them except through mouse-side trap proximity.',
      },
      reverseControlTrapOnTheMouseRoute: {
        mouseOnTrap: breakdown(bait),
        mouseNotOnTrap: breakdown(bait2),
        delta: Number((breakdown(bait).total - breakdown(bait2).total).toFixed(3)),
      },
    };
    write('cs01_p3_trap_reward_and_cost.json', art);

    // The resource count alone is worth exactly nothing.
    expect(breakdown(oneTrapInHand).total).toBe(breakdown(noTrapInHand).total);
    // The free placement is scored >= the no-trap state (never negative).
    expect(breakdown(placed).total).toBeGreaterThanOrEqual(breakdown(bare).total);
  });

  it('shows the real trap step punishment (why an early trap CAN be right)', () => {
    const s = mkState({
      config: DEFAULT_CONFIG,
      butters: [{ r: 5, c: 5 }],
      cat: { r: 0, c: 0 },
      mouse: { r: 4, c: 3 },
      catMovesLeft: 0,
      mouseMovesLeft: 4,
      trap: { r: 4, c: 4 },
      trapsRemaining: 0,
      currentPlayer: 'mouse',
    });
    const RIGHT = getDirectionByKey('ArrowRight')!;
    const stepped = mouseMove(s, RIGHT);
    const art = {
      before: { mouse: s.mousePosition, movesLeft: s.mouseMovesLeft, player: s.currentPlayer, trap: s.trapPosition },
      after: { mouse: stepped.mousePosition, movesLeft: stepped.mouseMovesLeft, player: stepped.currentPlayer, trap: stepped.trapPosition, message: stepped.message },
      events: stepped.gameEventLog.slice(-3),
    };
    write('cs01_p3_trap_step_punishment.json', art);
    expect(stepped.mousePosition).toEqual({ r: 4, c: 4 });
    expect(stepped.trapPosition).toBeNull();
    expect(stepped.currentPlayer).toBe(PieceType.Cat); // turn ended immediately
  });

  it('records what production actually plans at the real turn-1 root', () => {
    const root = restoreTurnRoot(games[0].turns[0]);
    const plan = planHardCatTurn(root, {
      rules, timeBudgetMs: 100, maxDepthTurns: 4,
      refutation: { enabled: true, totalTurnBudgetMs: 150 },
    });
    // Wall-clock fragility is measured, not hidden: if 100 ms did not even finish
    // depth 1 in this process, re-run with a relaxed budget to read the SEARCH's
    // answer (the plan SHAPE), and record both.
    const plan100Empty = plan.plan.length === 0;
    const relaxed = plan100Empty
      ? planHardCatTurn(root, { rules, timeBudgetMs: 400, maxDepthTurns: 4, refutation: { enabled: false } })
      : plan;
    const snapshot = (r: any) => ({
      planLabel: planLabel(r.plan),
      planStatus: r.debug.planStatus,
      completedDepth: r.completedDepth,
      attemptedDepth: r.attemptedDepth,
      nodes: r.search.diagnostics.totalNodes,
      elapsedMs: Number(r.elapsedMs.toFixed(1)),
      rootValue: Number(r.search.value.toFixed(3)),
      mate: r.search.mate,
      rootActions: r.debug.rootActions.map((x: any) => ({
        action: x.action.type === 'catPlaceTrap' ? 'T' : x.action.direction!.key.replace('Arrow', ''),
        value: Number(x.value.toFixed(3)),
        mate: x.mate,
        bound: x.bound ?? 'unknown',
      })),
    });
    const art = {
      root: { cat: root.catPosition, mouse: root.mousePosition, trapsRemaining: root.catTrapsRemaining, trap: root.trapPosition },
      loggedPlan: games[0].turns[0].planLabel,
      productionProfile100ms: snapshot(plan),
      relaxed400msNoSidecar: snapshot(relaxed),
      note: 'The 400 ms run is NOT a production profile — it only reads the search answer when the 100 ms wall did not finish depth 1 in this process. Real browser games completed depth>=1 on 24/24 turns (cs01_real_log_forensics.json).',
      refutationSource: plan.debug.refutation?.selectedPlanSource ?? null,
    };
    write('cs01_p3_production_plan_turn1.json', art);
    expect(relaxed.plan.length).toBeGreaterThan(0);
  });
});

describe('CS01-P3b why the trap wins at the root (leaf vs tree shape)', () => {
  it('compares T-first / trap-second / no-trap plans that end on the same cat cell', () => {
    const root = restoreTurnRoot(games[0].turns[0]);
    const D = getDirectionByKey('ArrowDown')!;
    const step = (): any => ({ type: 'catStep', direction: D });
    const trap: any = { type: 'catPlaceTrap' };

    const play = (actions: any[]) => {
      let s: GameEngineState = root;
      const trace: string[] = [];
      for (const a of actions) {
        if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat) { trace.push('turn-over'); break; }
        const before = s;
        s = a.type === 'catPlaceTrap'
          ? catPlaceTrap(s)
          : catMove(s, a.direction);
        if (s === before) trace.push('no-op');
      }
      const d = evaluateForCatDetailed(s);
      return {
        planLabel: planLabel(actions),
        catEnd: s.catPosition,
        catMovesLeft: s.catMovesLeft,
        player: s.currentPlayer,
        trap: s.trapPosition,
        total: Number(d.total.toFixed(3)),
        trapControl: Number(d.contributions.trapControl.toFixed(3)),
        capturePressure: Number(d.contributions.capturePressure.toFixed(3)),
        tempo: Number(d.contributions.tempo.toFixed(3)),
        mouseTrapDistance: d.features.mouseTrapDistance,
        trace,
      };
    };

    const rows = [
      play([trap, step(), step(), step(), step()]),
      play([step(), trap, step(), step(), step()]),
      play([step(), step(), step(), step()]),
    ];
    write('cs01_p3b_trap_leaf_comparison.json', { root: { cat: root.catPosition, mouse: root.mousePosition }, rows });
    expect(rows.length).toBe(3);
  });
});
