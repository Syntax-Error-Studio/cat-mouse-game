// ============================================================================
// 捕鼠夹回合交接修复 — 定向回归
//
// The bug: the trap branch of `applyMouseStepCore` flipped `currentPlayer` to
// Cat without granting the cat a turn budget, and `finalizeTurnAfterMouseStep`
// then skipped the hand-off because the actor was already Cat. A mouse that
// triggered a trap while the cat's stale budget was 0 (which is ALWAYS the case
// during a mouse turn) landed in Playing with BOTH budgets at 0 — nothing could
// act.
//
// Scope: rule-kernel turn hand-off + the anti-freeze guard. NOT a search /
// strength / benchmark suite.
// ============================================================================
import { describe, it, expect } from 'vitest';
import {
  catAiMove,
  catMove,
  computeCatAiTrajectory,
  createInitialState,
  endTurn,
  guardStalledTurnBudgets,
  mouseMove,
  mouseStepDeterministic,
} from '../../engine';
import type { GameEngineState } from '../../engine';
import { chooseTunnelExit } from '../../rules/tunnels';
import { DEFAULT_CONFIG } from '../../config';
import { CellType, Difficulty, DIRECTIONS, GamePhase, PieceType } from '../../types';
import type { Direction } from '../../types';
import { simulateSearchAction } from '../../ai/simulator';
import { generateLegalSearchActions } from '../../ai/legalActions';
import { defaultRuleSet } from '../../ai/searchRules';
import { gameAffectingEqual } from '../../ai/stateCompare';
import type { HardProgressGuardMemory } from '../../ai/progressGuard';

// ---------------------------------------------------------------- helpers
function dir(key: string): Direction {
  const d = DIRECTIONS.find((x) => x.key === key);
  if (!d) throw new Error(`no direction ${key}`);
  return d;
}

function setCell(s: GameEngineState, r: number, c: number, type: CellType, piece?: PieceType) {
  s.board[r][c] = { ...s.board[r][c], type, piece: piece ?? undefined, hasButter: false };
}
function clearCell(s: GameEngineState, r: number, c: number) {
  setCell(s, r, c, CellType.Empty);
}

/** A mouse one step away from a trap the cat planted on an otherwise free cell. */
function trapAheadState(over: Partial<GameEngineState> = {}): GameEngineState {
  const s = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Easy });
  s.butterPositions = [];
  s.pendingButterSpawns = [];
  s.pendingButterPlacementDebt = 0;
  s.mouseHasButter = false;
  s.mouseSkillActive = false;
  s.phase = GamePhase.Playing;
  s.currentPlayer = PieceType.Mouse;
  s.mouseMovesLeft = 3;
  s.catMovesLeft = 0; // the cat spent its last turn — the real mid-game shape
  s.mousePosition = { r: 5, c: 5 };
  clearCell(s, 5, 5);
  setCell(s, 5, 5, CellType.Empty, PieceType.Mouse);
  clearCell(s, 5, 6);
  s.trapPosition = { r: 5, c: 6 };
  return { ...s, ...over };
}

function countEvents(state: GameEngineState, prefix: string): number {
  return (state.gameEventLog ?? []).filter((line) => line.startsWith(prefix)).length;
}
function lastEvent(state: GameEngineState, prefix: string): string {
  const log = (state.gameEventLog ?? []).filter((line) => line.startsWith(prefix));
  return log[log.length - 1] ?? '';
}

/** Make `cell` a legal ghost-materialisation target: free terrain, no piece, no
 *  butter, no trap — and park the cat far away so its own cell can't collide.
 *  (Ghost materialisation uses the real movement predicates, so the fixture has
 *  to satisfy them rather than assume a board layout.) */
function ghostReadyCell(s: GameEngineState, r: number, c: number): GameEngineState {
  const next = { ...s, board: s.board.map((row) => row.map((cell) => ({ ...cell }))) };
  next.board[next.catPosition.r][next.catPosition.c] = {
    ...next.board[next.catPosition.r][next.catPosition.c], piece: undefined,
  };
  next.catPosition = { r: 1, c: 1 };
  next.board[1][1] = { ...next.board[1][1], type: CellType.Empty, piece: PieceType.Cat, hasButter: false };
  next.board[r][c] = { ...next.board[r][c], type: CellType.Empty, piece: undefined, hasButter: false };
  next.trapPosition = null;
  next.butterPositions = [];
  return next;
}

// ============================================================================
// §四(1)(2)(3)(4) — the trap hand-off
// ============================================================================
describe('T1 — 鼠踩陷阱的回合交接（根因）', () => {
  it('T1a: 猫上回合步数已耗尽时踩陷阱 → Playing + Cat + catMovesLeft=catBaseMoves + mouseMovesLeft=0', () => {
    const before = trapAheadState();
    expect(before.catMovesLeft).toBe(0);
    const after = mouseMove(before, dir('ArrowRight'));

    expect(after.phase).toBe(GamePhase.Playing);
    expect(after.currentPlayer).toBe(PieceType.Cat);
    expect(after.catMovesLeft).toBe(after.config.catBaseMoves);
    expect(after.catMovesLeft).toBeGreaterThan(0);
    expect(after.mouseMovesLeft).toBe(0);
    expect(after.tunnelExitChoices).toHaveLength(0);
  });

  it('T1b: 陷阱消失、鼠位置更新、交接事件恰好一次、捕鼠夹提示保留', () => {
    const before = trapAheadState();
    const after = mouseMove(before, dir('ArrowRight'));

    expect(after.trapPosition).toBeNull();
    expect(after.mousePosition).toEqual({ r: 5, c: 6 });
    expect(countEvents(after, 'TURN_END') - countEvents(before, 'TURN_END')).toBe(1);
    expect(countEvents(after, 'TURN_START') - countEvents(before, 'TURN_START')).toBe(1);
    expect(after.message).toContain('捕鼠夹');
    // the trap turn is a real mouse turn end: skill state resets too
    expect(after.mouseSkillActive).toBe(false);
  });

  it('T1c: 带黄油+技能激活时踩陷阱也走同一交接（技能重置、Progress Guard 观测置位）', () => {
    const guardMemory: HardProgressGuardMemory = {
      version: 1,
      previousNoProgressLoop: false,
      previousSignature: null,
      previousPlanLabel: '',
      previousCatStart: '',
      previousCatEnd: '',
      mouseTurnObserved: false,
    };
    const before = trapAheadState({ mouseSkillActive: true, mouseHasButter: true, hardProgressGuardMemory: guardMemory });
    const after = mouseMove(before, dir('ArrowRight'));
    expect(after.currentPlayer).toBe(PieceType.Cat);
    expect(after.mouseSkillActive).toBe(false);
    expect(after.hardProgressGuardMemory?.mouseTurnObserved).toBe(true);
    expect(after.mouseMovesLeft).toBe(0);
    // carrying butter: the NEXT mouse turn is the carrying-turn budget
    const handedToMouse = endTurn({ ...after, catMovesLeft: 1 });
    expect(handedToMouse.mouseMovesLeft).toBe(handedToMouse.config.mouseCarryingMoves);
  });

  it('T1d: mouseMove / mouseStepDeterministic / simulateSearchAction 终态一致', () => {
    const before = trapAheadState();
    const real = mouseMove(before, dir('ArrowRight'));
    const deterministic = mouseStepDeterministic(before, dir('ArrowRight'));
    const sim = simulateSearchAction(before, { type: 'mouseStep', direction: dir('ArrowRight') }, defaultRuleSet);

    expect(sim.kind).toBe('deterministic'); // a trap step is not a chance node
    if (sim.kind !== 'deterministic') return;
    expect(gameAffectingEqual(real, deterministic)).toBe(true);
    expect(gameAffectingEqual(real, sim.state)).toBe(true);
    expect(sim.state.catMovesLeft).toBe(real.config.catBaseMoves);
  });

  it('T1e: 交接后的猫回合真的可行动（搜索与猫 AI 都不再面对 0 步死局）', () => {
    const after = mouseMove(trapAheadState(), dir('ArrowRight'));

    const legal = generateLegalSearchActions(after, defaultRuleSet);
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.every((a) => a.type === 'catStep' || a.type === 'catPlaceTrap')).toBe(true);

    const aiStep = catAiMove(after);
    expect(aiStep).not.toBeNull();
    const trajectory = computeCatAiTrajectory(after);
    expect(trajectory).not.toBeNull();
    expect((trajectory ?? []).length).toBeGreaterThan(0);
  });

  it('T1f: 搜索内的猫回合边界把行动权交回鼠（不会误切回猫连续两回合）', () => {
    const after = mouseMove(trapAheadState(), dir('ArrowRight'));
    // the cat's last step of its own turn, hand-off still pending
    const catSpent = { ...after, catMovesLeft: 0, mouseMovesLeft: 0 };
    const handed = endTurn(catSpent);
    expect(handed.currentPlayer).toBe(PieceType.Mouse);
    expect(handed.catMovesLeft).toBe(0); // never topped up by the hand-off itself
    expect(handed.mouseMovesLeft).toBe(handed.config.mouseBaseMoves);
    // …and the guard does not fire on it (the actor has moves again)
    expect(Object.is(guardStalledTurnBudgets(handed, 'test'), handed)).toBe(true);
  });

  it('T1g: 双人模式下猫接手后能立刻继续操作（合法猫步进存在且消耗步数）', () => {
    const after = mouseMove(trapAheadState(), dir('ArrowRight'));
    expect(after.catMovesLeft).toBeGreaterThan(0);

    const steps = generateLegalSearchActions(after, defaultRuleSet).filter((a) => a.type === 'catStep');
    expect(steps.length).toBeGreaterThan(0);
    const first = steps[0];
    if (first.type !== 'catStep') throw new Error('unexpected action type');
    const moved = catMove(after, first.direction);
    expect(moved.catMovesLeft).toBe(after.catMovesLeft - 1);
  });
});

// ============================================================================
// §四(5) — every other turn boundary keeps its original semantics
// ============================================================================
describe('T2 — 其它回合边界按原规则', () => {
  it('T2a: 正常鼠步数耗尽 → 猫获得完整回合', () => {
    const s = trapAheadState({ trapPosition: null });
    s.mousePosition = { r: 5, c: 5 };
    clearCell(s, 5, 5);
    setCell(s, 5, 5, CellType.Empty, PieceType.Mouse);
    clearCell(s, 5, 6);
    s.mouseMovesLeft = 1;
    const after = mouseMove(s, dir('ArrowRight'));
    expect(after.currentPlayer).toBe(PieceType.Cat);
    expect(after.mouseMovesLeft).toBe(0);
    expect(after.catMovesLeft).toBe(after.config.catBaseMoves);
  });

  it('T2b: 传送落地不自己交接，endTurn 才把回合交给猫', () => {
    const s = trapAheadState({ trapPosition: null, mouseHasButter: false, mouseSkillActive: false });
    s.blockedTunnels = [];
    // walk onto the (0,0) tunnel corner from its right-hand neighbour
    s.board[0][1] = { ...s.board[0][1], type: CellType.Empty, piece: undefined };
    s.board[0][0] = { ...s.board[0][0], type: CellType.Tunnel, piece: undefined };
    s.mousePosition = { r: 0, c: 1 };
    setCell(s, 0, 1, CellType.Empty, PieceType.Mouse);
    s.mouseMovesLeft = 4;

    const entering = mouseStepDeterministic(s, dir('ArrowLeft'));
    expect(entering.phase).toBe(GamePhase.ChoosingTunnelExit);
    expect(entering.tunnelExitChoices.length).toBeGreaterThan(0);

    const exit = entering.tunnelExitChoices[entering.tunnelExitChoices.length - 1];
    const landed = chooseTunnelExit(entering, exit.r, exit.c);
    expect(landed.currentPlayer).toBe(PieceType.Mouse); // kernel teleports, no hand-off
    expect(landed.mouseMovesLeft).toBe(0);

    const after = endTurn(landed);
    expect(after.currentPlayer).toBe(PieceType.Cat);
    expect(after.catMovesLeft).toBe(after.config.catBaseMoves);
  });

  it('T2c: 猫回合耗尽 → 交还鼠（正常路径，非防御层）', () => {
    const s = trapAheadState();
    const catTurn = endTurn(s);
    expect(catTurn.currentPlayer).toBe(PieceType.Cat);
    const catSpent = { ...catTurn, catMovesLeft: 0, mouseMovesLeft: 0 };
    const back = endTurn(catSpent);
    expect(back.currentPlayer).toBe(PieceType.Mouse);
    expect(back.mouseMovesLeft).toBe(back.config.mouseBaseMoves);
  });

  it('T2d: 幽灵黄油仍在 Cat→Mouse 边界实体化', () => {
    const ghostCell = { r: 3, c: 3 };
    const base = ghostReadyCell(trapAheadState(), ghostCell.r, ghostCell.c);
    const catSpent = {
      ...base,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 0,
      mouseMovesLeft: 0,
      pendingButterSpawns: [{ r: ghostCell.r, c: ghostCell.c, blockedMaterializations: 0 }],
    };
    const back = endTurn(catSpent);
    expect(back.currentPlayer).toBe(PieceType.Mouse);
    expect(back.butterPositions.some((b) => b.r === ghostCell.r && b.c === ghostCell.c)).toBe(true);
    expect(lastEvent(back, 'GHOST_BUTTER_MATERIALIZED')).not.toBe('');
  });

  it('T2e: 正常终局与等待选出口的状态不被防御层改写', () => {
    const stalled = { ...trapAheadState(), mouseMovesLeft: 0, catMovesLeft: 0, gameEventLog: [] };
    for (const phase of [GamePhase.CatWins, GamePhase.MouseWins, GamePhase.ChoosingTunnelExit]) {
      const s = { ...stalled, phase } as GameEngineState;
      expect(Object.is(guardStalledTurnBudgets(s, 'test'), s)).toBe(true);
    }
  });
});

// ============================================================================
// §三 — 防御层：只在可归属的交接上做修复
// ============================================================================
describe('T3 — 双方 0 步防御（guardStalledTurnBudgets）', () => {
  it('T3a: 猫已走完本回合（有 TURN_START 授予记录）→ 恰好一次 Cat→Mouse，不给猫加步', () => {
    const s = trapAheadState();
    const catTurn = { ...endTurn(s), catMovesLeft: 0, mouseMovesLeft: 0 };
    const guarded = guardStalledTurnBudgets(catTurn, 'test');
    expect(guarded.currentPlayer).toBe(PieceType.Mouse);
    expect(guarded.catMovesLeft).toBe(0); // never topped up
    expect(guarded.mouseMovesLeft).toBe(guarded.config.mouseBaseMoves);
    expect(lastEvent(guarded, 'TURN_BUDGET_STALL')).toContain('action=handoff');
    // and it is a one-shot: re-running it on the result does nothing
    expect(Object.is(guardStalledTurnBudgets(guarded, 'test'), guarded)).toBe(true);
  });

  it('T3b: 猫侧 0 步带幽灵黄油/放置债 → 修复时一并结算', () => {
    const ghostCell = { r: 2, c: 2 };
    const base = ghostReadyCell(trapAheadState(), ghostCell.r, ghostCell.c);
    const catTurn = {
      ...endTurn(base),
      catMovesLeft: 0,
      mouseMovesLeft: 0,
      pendingButterSpawns: [{ r: ghostCell.r, c: ghostCell.c, blockedMaterializations: 0 }],
    };
    const guarded = guardStalledTurnBudgets(catTurn, 'test');
    expect(guarded.currentPlayer).toBe(PieceType.Mouse);
    expect(guarded.butterPositions.some((b) => b.r === ghostCell.r && b.c === ghostCell.c)).toBe(true);
  });

  it('T3c: 无任何 TURN_START 记录 → 只记诊断，不猜玩家、不加行动', () => {
    const s = { ...trapAheadState(), mouseMovesLeft: 0, catMovesLeft: 0, gameEventLog: [] };
    const guarded = guardStalledTurnBudgets(s, 'test');
    expect(guarded.currentPlayer).toBe(s.currentPlayer);
    expect(guarded.catMovesLeft).toBe(0);
    expect(guarded.mouseMovesLeft).toBe(0);
    expect(gameAffectingEqual(s, guarded)).toBe(true);
    expect(lastEvent(guarded, 'TURN_BUDGET_STALL')).toContain('action=record reason=no_turn_start_record');
  });

  it('T3d: 行动者被外部翻转而无交接（旧 bug 形态）→ 只记诊断', () => {
    const s = trapAheadState();
    const catTurn = endTurn(s); // logs TURN_START player=cat
    const forged = {
      ...catTurn,
      currentPlayer: PieceType.Mouse,
      catMovesLeft: 0,
      mouseMovesLeft: 0,
    } as GameEngineState;
    const guarded = guardStalledTurnBudgets(forged, 'test');
    expect(guarded.currentPlayer).toBe(PieceType.Mouse);
    expect(gameAffectingEqual(forged, guarded)).toBe(true);
    expect(lastEvent(guarded, 'TURN_BUDGET_STALL')).toContain('action=record reason=actor_changed_without_handoff');
  });

  it('T3e: 交接本身就授予 0 步 → 只记诊断（绝不无条件加 4 步）', () => {
    const s = trapAheadState();
    const zeroGrant = {
      ...s,
      gameEventLog: [...(s.gameEventLog ?? []), 'TURN_START player=cat catMoves=0 mouseMoves=0 butter=false skill=false'],
      currentPlayer: PieceType.Cat,
      catMovesLeft: 0,
      mouseMovesLeft: 0,
    } as GameEngineState;
    const guarded = guardStalledTurnBudgets(zeroGrant, 'test');
    expect(guarded.currentPlayer).toBe(PieceType.Cat);
    expect(guarded.catMovesLeft).toBe(0);
    expect(gameAffectingEqual(zeroGrant, guarded)).toBe(true);
    expect(lastEvent(guarded, 'TURN_BUDGET_STALL')).toContain('action=record reason=turn_started_without_budget');
  });

  it('T3f: 已完成交接的正常局面原样返回（同一引用，不加步数）', () => {
    const cases: GameEngineState[] = [
      trapAheadState(), // Mouse to move with 3 left
      endTurn(trapAheadState()), // Cat to move with a fresh budget
      { ...trapAheadState(), mouseMovesLeft: 0, catMovesLeft: 3 }, // mouse turn spent, cat mid-turn
      { ...trapAheadState(), mouseMovesLeft: 0, catMovesLeft: 0, gameEventLog: [] }, // unattributable → record only
    ];
    for (const s of cases) {
      const guarded = guardStalledTurnBudgets(s, 'test');
      expect(guarded.catMovesLeft).toBe(s.catMovesLeft);
      expect(guarded.mouseMovesLeft).toBe(s.mouseMovesLeft);
      expect(guarded.currentPlayer).toBe(s.currentPlayer);
    }
    // the first three are byte-identical pass-throughs (same reference)
    for (const s of cases.slice(0, 3)) {
      expect(Object.is(guardStalledTurnBudgets(s, 'test'), s)).toBe(true);
    }
    // the fourth is repaired by hand-off only when it IS attributable
    const attributed = { ...endTurn(trapAheadState()), catMovesLeft: 0, mouseMovesLeft: 0 };
    expect(guardStalledTurnBudgets(attributed, 'test').currentPlayer).toBe(PieceType.Mouse);
  });
});
