import { describe, expect, it } from 'vitest';
import {
  catMove,
  catPlaceTrap,
  createEngineRuleSet,
  createInitialState,
  mouseSkill,
  type GameEngineState,
} from '../../src/game/engine';
import { DEFAULT_CONFIG, GAMEPLAY_RULESET_VERSION } from '../../src/game/config';
import { CellType, GamePhase, PieceType } from '../../src/game/types';
import type { Direction } from '../../src/game/types';
import type { RuleSet } from '../../src/game/ai/searchTypes';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { gameAffectingEqual } from '../../src/game/ai/stateCompare';
import { stateKey } from '../../src/game/ai/transposition';
import { isExplicitLayout } from '../../src/game/openingFairness';
import {
  applyNoMoveLoss,
  catHasLegalSpatialMove,
  mouseHasLegalSpatialMove,
  noMoveLossVerdict,
} from '../../src/game/rules/mobility';
import { validateChance, sampleChance } from '../proto/chance';
import { mulberry32 } from '../proto/seededRng';
import { UctSearch, evaluateLeaf, uctSeed, type UctOptions } from '../proto/uct';
import { replayPlanWithEngine } from '../proto/replay';
import { controlled, wallOff, LEFT, RIGHT, type Pt } from './fixtures';

const rules = createEngineRuleSet();

function uctOptions(state: GameEngineState, rollout: 'random' | 'hybrid', over: Partial<UctOptions> = {}): UctOptions {
  return {
    rules,
    deadlineMs: 100,
    maxHandoffs: 4,
    maxNodes: 500_000,
    c: Math.SQRT2,
    seed: uctSeed('correctness-test', rollout, 1),
    rollout,
    ...over,
  };
}

function withoutMathRandom<T>(fn: () => T): T {
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random must not be used by MCTS'); };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function chanceResult(res: ReturnType<typeof simulateSearchAction>) {
  if (res.kind !== 'chance') throw new Error(`expected chance, got ${res.kind}`);
  return res;
}

function deterministicState(res: ReturnType<typeof simulateSearchAction>): GameEngineState {
  if (res.kind !== 'deterministic') throw new Error(`expected deterministic, got ${res.kind}`);
  return res.state;
}

function hasCatStep(state: GameEngineState, key: string): boolean {
  return generateLegalSearchActions(state, rules).some(
    (a) => a.type === 'catStep' && a.direction.key === key,
  );
}

function manhattan(a: Pt, b: Pt): number {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

describe('PPC-MCTS-01 independent correctness (14 cases)', () => {
  it('01 normal cat move: real engine and legal-action kernel agree', () => {
    const s = controlled({ cat: { r: 4, c: 4 }, mouse: { r: 1, c: 1 } });
    const next = catMove(s, RIGHT);
    expect(next.catPosition).toEqual({ r: 4, c: 5 });
    expect(next.catMovesLeft).toBe(3);
    expect(next.board[4][4].piece).toBeUndefined();
    expect(next.board[4][5].piece).toBe(PieceType.Cat);
    expect(gameAffectingEqual(s, next)).toBe(false);
    expect(hasCatStep(s, 'ArrowRight')).toBe(true);
  });

  it('02 box push: box moves one cell, cat takes its place, budget decreases', () => {
    const s = controlled({
      cat: { r: 4, c: 4 },
      mouse: { r: 1, c: 1 },
      boxes: [{ r: 4, c: 5 }],
    });
    const next = catMove(s, RIGHT);
    expect(next.board[4][5].type).toBe(CellType.Empty);
    expect(next.board[4][5].piece).toBe(PieceType.Cat);
    expect(next.board[4][6].type).toBe(CellType.Box);
    expect(next.catPosition).toEqual({ r: 4, c: 5 });
    expect(next.catMovesLeft).toBe(3);
    expect(deterministicState(simulateSearchAction(s, { type: 'catStep', direction: RIGHT }, rules)).board[4][6].type)
      .toBe(CellType.Box);
  });

  it('03 trap place/reclaim: placement is free, reclaim clears the trap', () => {
    const s = controlled({ cat: { r: 4, c: 4 }, mouse: { r: 1, c: 1 }, catTrapsRemaining: 1 });
    const placed = catPlaceTrap(s);
    expect(placed.trapPosition).toEqual({ r: 4, c: 4 });
    expect(placed.catTrapsRemaining).toBe(0);
    expect(placed.catMovesLeft).toBe(4);
    expect(generateLegalSearchActions(s, rules).some((a) => a.type === 'catPlaceTrap')).toBe(true);

    const away = catMove(placed, RIGHT);
    const back = catMove(away, LEFT);
    expect(back.catPosition).toEqual({ r: 4, c: 4 });
    expect(back.trapPosition).toBeNull();
    expect(back.catTrapsRemaining).toBe(1); // reclaim returns the trap to hand
  });

  it('04 mouse skill: consumes carried butter and adds exactly the configured moves', () => {
    const s = controlled({
      cat: { r: 1, c: 1 },
      mouse: { r: 4, c: 4 },
      player: PieceType.Mouse,
      mouseMoves: 3,
      mouseHasButter: true,
    });
    const next = rules.mouseSkill(s);
    expect(next.mouseHasButter).toBe(false);
    expect(next.mouseSkillActive).toBe(true);
    expect(next.mouseMovesLeft).toBe(3 + s.config.mouseSkillExtraMoves);
    expect(generateLegalSearchActions(s, rules).some((a) => a.type === 'mouseSkill')).toBe(true);
    expect(mouseSkill(s).mouseMovesLeft).toBe(next.mouseMovesLeft);
  });

  it('05 tunnel exit: entering offers exits, choosing teleports and hands off', () => {
    const s = controlled({
      cat: { r: 4, c: 4 },
      mouse: { r: 0, c: 1 },
      player: PieceType.Mouse,
      mouseMoves: 3,
    });
    const entered = deterministicState(
      simulateSearchAction(s, { type: 'mouseStep', direction: LEFT }, rules),
    );
    expect(entered.phase).toBe(GamePhase.ChoosingTunnelExit);
    expect(entered.mousePosition).toEqual({ r: 0, c: 0 });
    const exits = entered.tunnelExitChoices ?? [];
    expect(exits.some((e) => e.r === 9 && e.c === 9)).toBe(true);

    const exited = deterministicState(
      simulateSearchAction(entered, { type: 'chooseTunnel', r: 9, c: 9 }, rules),
    );
    expect(exited.mousePosition).toEqual({ r: 9, c: 9 });
    expect(exited.phase).toBe(GamePhase.Playing);
    expect(exited.currentPlayer).toBe(PieceType.Cat);
  });

  it('06 mouse step on trap: trap is consumed, all moves lost, hand-off happens', () => {
    const s = controlled({
      cat: { r: 1, c: 1 },
      mouse: { r: 4, c: 4 },
      trap: { r: 4, c: 5 },
      player: PieceType.Mouse,
      mouseMoves: 3,
    });
    const next = deterministicState(
      simulateSearchAction(s, { type: 'mouseStep', direction: RIGHT }, rules),
    );
    expect(next.mousePosition).toEqual({ r: 4, c: 5 });
    expect(next.trapPosition).toBeNull();
    expect(next.currentPlayer).toBe(PieceType.Cat);
    expect(next.phase).toBe(GamePhase.Playing);
  });

  it('07 RULE-A: stranded mouse loses, stranded cat loses, verdict is idempotent', () => {
    const mouseStuck = wallOff(
      controlled({ cat: { r: 9, c: 5 }, mouse: { r: 4, c: 4 }, player: PieceType.Mouse, mouseMoves: 3 }),
      [{ r: 9, c: 5 }, { r: 4, c: 4 }],
    );
    expect(mouseHasLegalSpatialMove(mouseStuck)).toBe(false);
    const mouseVerdict = noMoveLossVerdict(mouseStuck);
    expect(mouseVerdict?.phase).toBe(GamePhase.CatWins);
    expect(mouseVerdict?.reason).toBe('mouse_no_legal_spatial_move');
    const settledMouse = applyNoMoveLoss(mouseStuck);
    expect(settledMouse.phase).toBe(GamePhase.CatWins);
    expect(applyNoMoveLoss(settledMouse)).toBe(settledMouse);
    expect(evaluateLeaf(settledMouse)).toBe(1);

    const catStuck = wallOff(
      controlled({ cat: { r: 4, c: 4 }, mouse: { r: 0, c: 1 }, catMoves: 4 }),
      [{ r: 4, c: 4 }, { r: 0, c: 1 }],
    );
    expect(catHasLegalSpatialMove(catStuck)).toBe(false);
    const catVerdict = noMoveLossVerdict(catStuck);
    expect(catVerdict?.phase).toBe(GamePhase.MouseWins);
    expect(catVerdict?.reason).toBe('cat_no_legal_spatial_move');
    expect(evaluateLeaf(applyNoMoveLoss(catStuck))).toBe(-1);
  });

  it('08 RULE-B initial layout: canonical auto opening has certified-layout invariants', () => {
    const s = createInitialState(DEFAULT_CONFIG);
    expect(GAMEPLAY_RULESET_VERSION).toBe(2);
    expect(isExplicitLayout(DEFAULT_CONFIG)).toBe(false);
    expect(s.phase).toBe(GamePhase.Playing);
    expect(s.butterPositions.length).toBe(DEFAULT_CONFIG.butterCount);
    expect(s.catPosition).toEqual(DEFAULT_CONFIG.catStart);
    expect(s.mousePosition).toEqual(DEFAULT_CONFIG.mouseStart);
    expect(s.catTrapsRemaining).toBe(1);
    expect(s.pendingButterSpawns).toHaveLength(0);
    expect(s.pendingButterPlacementDebt).toBe(0);

    const flat = s.board.flat();
    expect(flat.filter((c) => c.type === CellType.Tunnel)).toHaveLength(4);
    expect(flat.filter((c) => c.type === CellType.MouseHole)).toHaveLength(4);
    expect(flat.filter((c) => c.type === CellType.Box)).toHaveLength(DEFAULT_CONFIG.boxCount);
    expect(flat.filter((c) => c.type === CellType.Pile)).toHaveLength(DEFAULT_CONFIG.pileCount ?? 0);
    expect(flat.filter((c) => c.piece === PieceType.Cat)).toHaveLength(1);
    expect(flat.filter((c) => c.piece === PieceType.Mouse)).toHaveLength(1);

    for (const b of s.butterPositions) {
      expect(s.board[b.r][b.c].type).toBe(CellType.Empty);
      expect(manhattan(b, s.mousePosition)).toBeGreaterThanOrEqual(3);
      expect(manhattan(b, s.catPosition)).toBeGreaterThanOrEqual(3);
    }
  });

  it('09 butter pickup + ghost announcement: CHANCE is announced, uniform, never dropped', () => {
    const s = controlled({
      cat: { r: 1, c: 1 },
      mouse: { r: 4, c: 4 },
      butters: [{ r: 4, c: 5 }],
      player: PieceType.Mouse,
      mouseMoves: 3,
    });
    const res = chanceResult(simulateSearchAction(s, { type: 'mouseStep', direction: RIGHT }, rules));
    expect(res.outcomes.length).toBeGreaterThan(0);
    const v = validateChance(res.outcomes);
    expect(v.massError).toBeLessThanOrEqual(1e-9);
    for (const o of res.outcomes) {
      expect(o.weight).toBeCloseTo(1 / res.outcomes.length, 12);
      expect(o.state.mouseHasButter).toBe(true);
      expect(o.state.butterPositions).toHaveLength(0);
      expect(o.state.pendingButterSpawns).toHaveLength(1);
      expect(o.state.pendingButterPlacementDebt).toBe(0);
    }

    const noCandidate = wallOff(
      controlled({
        cat: { r: 1, c: 1 },
        mouse: { r: 4, c: 4 },
        butters: [{ r: 4, c: 5 }],
        player: PieceType.Mouse,
        mouseMoves: 3,
      }),
      [{ r: 1, c: 1 }, { r: 4, c: 4 }, { r: 4, c: 5 }],
    );
    const debt = chanceResult(
      simulateSearchAction(noCandidate, { type: 'mouseStep', direction: RIGHT }, rules),
    );
    expect(debt.outcomes).toHaveLength(1);
    expect(debt.outcomes[0].state.pendingButterSpawns).toHaveLength(0);
    expect(debt.outcomes[0].state.pendingButterPlacementDebt).toBe(1);
  });

  it('10 ghost boundary: materialize / delay / reroll / debt are all honest', () => {
    // Materialize: ghost cell is free at the CAT->MOUSE boundary.
    const mat = controlled({
      cat: { r: 4, c: 4 },
      mouse: { r: 1, c: 1 },
      pending: [{ r: 1, c: 5 }],
      catMoves: 1,
    });
    const matRes = chanceResult(
      simulateSearchAction(mat, { type: 'catStep', direction: RIGHT }, rules),
    );
    const matValid = validateChance(matRes.outcomes);
    expect(matValid.massError).toBeLessThanOrEqual(1e-9);
    for (const o of matRes.outcomes) {
      expect(o.state.butterPositions).toContainEqual({ r: 1, c: 5 });
      expect(o.state.pendingButterSpawns).toHaveLength(0);
      expect(o.state.currentPlayer).toBe(PieceType.Mouse);
    }

    // Delay: cat occupies the ghost cell on the first boundary.
    const delay = controlled({
      cat: { r: 4, c: 4 },
      mouse: { r: 1, c: 1 },
      pending: [{ r: 4, c: 5 }],
      catMoves: 1,
    });
    const delayRes = chanceResult(
      simulateSearchAction(delay, { type: 'catStep', direction: RIGHT }, rules),
    );
    expect(delayRes.outcomes).toHaveLength(1);
    expect(delayRes.outcomes[0].state.pendingButterSpawns).toEqual([
      { r: 4, c: 5, blockedMaterializations: 1 },
    ]);
    expect(delayRes.outcomes[0].state.butterPositions).toHaveLength(0);

    // Reroll: second consecutive block moves the ghost, blocked resets.
    const reroll = controlled({
      cat: { r: 4, c: 4 },
      mouse: { r: 1, c: 1 },
      pending: [{ r: 4, c: 5, blockedMaterializations: 1 }],
      catMoves: 1,
    });
    const rerollRes = chanceResult(
      simulateSearchAction(reroll, { type: 'catStep', direction: RIGHT }, rules),
    );
    validateChance(rerollRes.outcomes);
    expect(rerollRes.outcomes.length).toBeGreaterThan(0);
    for (const o of rerollRes.outcomes) {
      expect(o.state.pendingButterSpawns).toHaveLength(1);
      expect(o.state.pendingButterSpawns[0]).not.toEqual({ r: 4, c: 5, blockedMaterializations: 0 });
      expect(o.state.pendingButterSpawns[0].blockedMaterializations).toBe(0);
    }

    // Debt with no legal candidate is preserved, never dropped.
    const debtState = wallOff(
      controlled({ cat: { r: 4, c: 4 }, mouse: { r: 0, c: 1 }, catMoves: 0, debt: 1 }),
      [{ r: 4, c: 4 }, { r: 0, c: 1 }],
    );
    const debtOutcomes = rules.resolveGhostBoundaryChance?.(debtState) ?? [];
    expect(debtOutcomes.length).toBeGreaterThan(0);
    validateChance(debtOutcomes);
    for (const o of debtOutcomes) {
      expect(o.state.pendingButterPlacementDebt).toBe(1);
      expect(o.state.pendingButterSpawns).toHaveLength(0);
    }
  });

  it('11 probability mass + weighted sampling: invalid masses throw, seed is reproducible', () => {
    const s = controlled({ cat: { r: 4, c: 4 }, mouse: { r: 1, c: 1 } });
    expect(() => validateChance([])).toThrow(/CHANCE_INVALID/);
    expect(() => validateChance([{ state: s, weight: 0 }, { state: s, weight: 1 }])).toThrow(/CHANCE_INVALID/);
    expect(() => validateChance([{ state: s, weight: Number.NaN }])).toThrow(/CHANCE_INVALID/);
    expect(() => validateChance([{ state: s, weight: Number.POSITIVE_INFINITY }])).toThrow(/CHANCE_INVALID/);
    expect(() => validateChance([{ state: s, weight: 0.4 }, { state: s, weight: 0.5 }])).toThrow(/CHANCE_INVALID/);

    const v = validateChance([{ state: s, weight: 0.9 }, { state: s, weight: 0.1 }]);
    const rng = mulberry32(20261116);
    let first = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (sampleChance(v, rng) === 0) first++;
    expect(first / n).toBeGreaterThan(0.86);
    expect(first / n).toBeLessThan(0.94);

    const a = mulberry32(99);
    const b = mulberry32(99);
    const seqA = Array.from({ length: 32 }, () => sampleChance(v, a));
    const seqB = Array.from({ length: 32 }, () => sampleChance(v, b));
    expect(seqA).toEqual(seqB);
  });

  it('12 state cycles: full stateKey identity and oscillating state terminates under the node cap', () => {
    const s = controlled({ cat: { r: 4, c: 4 }, mouse: { r: 1, c: 1 } });
    const same = structuredClone(s);
    expect(stateKey(s)).toBe(stateKey(same));
    expect(stateKey({ ...same, catTrapsRemaining: 0 })).not.toBe(stateKey(s));
    expect(stateKey({ ...same, pendingButterPlacementDebt: 1 })).not.toBe(stateKey(s));
    expect(stateKey({ ...same, blockedTunnels: [{ r: 0, c: 0 }] })).not.toBe(stateKey(s));
    expect(gameAffectingEqual(s, { ...same, trapPosition: { r: 4, c: 5 } })).toBe(false);

    const osc = wallOff(
      controlled({ cat: { r: 4, c: 4 }, mouse: { r: 0, c: 1 } }),
      [{ r: 4, c: 4 }, { r: 4, c: 5 }, { r: 0, c: 1 }],
    );
    const base = createEngineRuleSet();
    const oscillating: RuleSet = {
      ...base,
      catMove: (state: GameEngineState, direction: Direction) => {
        const next = base.catMove(state, direction);
        return { ...next, currentPlayer: PieceType.Cat, catMovesLeft: 4 };
      },
    };
    const started = performance.now();
    const result = withoutMathRandom(() => new UctSearch(osc, {
      ...uctOptions(osc, 'random'),
      rules: oscillating,
      deadlineMs: 600,
      maxHandoffs: 1000,
      maxNodes: 40,
      maxRolloutActions: 1000,
    }).run());
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);
    expect(result.diagnostics.simulations).toBeGreaterThan(0);
    expect(result.diagnostics.nodeCapHit || result.diagnostics.deadlineHit).toBe(true);
  });

  it('13 full cat-turn plan: MCTS returns only cat actions, ends at hand-off, replay is executable', () => {
    const s = controlled({ cat: { r: 4, c: 4 }, mouse: { r: 1, c: 1 } });
    const result = withoutMathRandom(() => new UctSearch(s, uctOptions(s, 'random')).run());
    expect(result.plan.length).toBeGreaterThan(0);
    expect(result.plan.length).toBeLessThanOrEqual(12);
    for (const a of result.plan) {
      expect(['catStep', 'catPlaceTrap']).toContain(a.type);
    }
    expect(result.treePlanLength).toBeGreaterThan(0);
    expect(result.rootAction).not.toBeNull();

    const replay = replayPlanWithEngine(s, result.plan);
    expect(replay.ok).toBe(true);
    expect(replay.terminal || replay.endedTurn || replay.fullTurnConsumed).toBe(true);
    expect(replay.planLength).toBe(result.plan.length);
    for (const step of replay.steps) expect(step.effective).toBe(true);

    let viaSim = s;
    for (const a of result.plan) {
      const res = simulateSearchAction(viaSim, a, rules);
      if (res.kind === 'chance') break;
      viaSim = res.state;
    }
    expect(
      viaSim.phase !== GamePhase.Playing
      || viaSim.currentPlayer !== PieceType.Cat
      || viaSim.catMovesLeft <= 0,
    ).toBe(true);
  });

  it('14 real-engine step replay: UCT plan is validated by catMove/catPlaceTrap, not the simulator', () => {
    const s = controlled({ cat: { r: 5, c: 5 }, mouse: { r: 1, c: 1 } });
    const result = withoutMathRandom(() => new UctSearch(s, uctOptions(s, 'hybrid')).run());
    expect(result.plan.length).toBeGreaterThan(0);

    const replay = replayPlanWithEngine(s, result.plan);
    expect(replay.ok).toBe(true);
    expect(replay.rejectedAt).toBe(-1);
    expect(replay.steps.length).toBe(result.plan.length);
    for (const step of replay.steps) {
      expect(step.action.type === 'catStep' || step.action.type === 'catPlaceTrap').toBe(true);
      expect(step.effective).toBe(true);
    }
    expect(gameAffectingEqual(s, replay.finalState)).toBe(false);
    expect(replay.catMovesLeft).toBeLessThan(s.catMovesLeft);

    const rejected = replayPlanWithEngine(s, [
      { type: 'mouseStep', direction: RIGHT },
    ]);
    expect(rejected.ok).toBe(false);
    expect(rejected.rejectedReason).toMatch(/non-cat action/);
  });
});
