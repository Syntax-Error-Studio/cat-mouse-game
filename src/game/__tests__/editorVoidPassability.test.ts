import { describe, expect, it } from 'vitest';
import type { GameConfig } from '../config';
import { catAiMove, catMove, computeCatAiTrajectory, createInitialState } from '../engine';
import type { GameEngineState } from '../engine';
import { createEmptyMap, mapDefinitionToGameConfig } from '../mapDefinition';
import type { MapDefinition } from '../mapDefinition';
import { getMouseHoleGateCells } from '../rules/tunnelRules';
import { CellType, Difficulty, DIRECTIONS, GameMode, GamePhase, PieceType } from '../types';

const DOWN = DIRECTIONS[1];

/**
 * EDITOR-VOID — 自定义地图里「虚空不可通行」的一致性。
 *
 * 背景：`catMove` 明确禁止进入 `Void`，但一批 AI 辅助函数当时只排除了
 * 墙/杂物堆（`isFixedObstacle`）。结果是 AI 会把虚空当走廊：寻路穿过补齐区、
 * 评分给走进虚空的动作加分、守洞候选落在虚空上。因为 `catMove` 最后会拒绝
 * 这些动作，表现就是「猫原地不动」而不是崩溃 —— 所以只能靠对**结果位置**的
 * 断言来回归，不能只看函数是否返回 null。
 *
 * 标准地图不产生 Void，因此这些用例全部走编辑器自定义地图。
 */

function blank(rows: number, cols: number): MapDefinition {
  return createEmptyMap('void-probe', rows, cols);
}

function stateOf(map: MapDefinition, difficulty: Difficulty = Difficulty.Easy): GameEngineState {
  const cfg: GameConfig = {
    ...mapDefinitionToGameConfig(map, GameMode.Single),
    difficulty,
  };
  return createInitialState(cfg);
}

/**
 * 猫回合开始。这里刻意**不走 endTurn**：endTurn 会跑 RULE-A「无路可走」结算，
 * 把“猫被围住”直接判成猫负（phase 变成 MouseWins），于是 AI 根本不会被调用。
 * 本文件要测的是“AI 拿到一个还在进行中的猫回合时怎么选方向”，所以只切换
 * 行动方与步数，保持 phase=Playing。
 */
function catTurnOf(state: GameEngineState): GameEngineState {
  return {
    ...state,
    currentPlayer: PieceType.Cat,
    catMovesLeft: state.config.catBaseMoves,
  };
}

function terrainAt(state: GameEngineState, p: { r: number; c: number }): CellType {
  return state.board[p.r][p.c].type;
}

describe('虚空不可通行 — 守洞候选', () => {
  it('4×24 地图：鼠洞贴着补齐边界时，Void 邻居不能成为守洞位', () => {
    const m = blank(4, 24);
    m.catStart = { r: 0, c: 0 };
    m.mouseStart = { r: 1, c: 1 };
    // 洞放在最后一行最后一列：向下的邻居 (4,23) 正好是补齐出来的虚空
    m.grid[3][23] = CellType.MouseHole;

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(cfg.boardSize).toBe(24);
    const state = createInitialState(cfg);
    expect(state.board[4][23].type).toBe(CellType.Void);

    const gates = getMouseHoleGateCells(state);
    expect(gates.length).toBeGreaterThan(0);
    for (const g of gates) {
      expect(state.board[g.r][g.c].type).not.toBe(CellType.Void);
    }
    expect(gates.some((g) => g.r === 4 && g.c === 23)).toBe(false);
  });

  it('洞边同时有地板与 Void：只保留地板', () => {
    const m = blank(4, 24);
    m.catStart = { r: 0, c: 0 };
    m.mouseStart = { r: 3, c: 5 };
    m.grid[3][23] = CellType.MouseHole;

    const state = createInitialState(mapDefinitionToGameConfig(m, GameMode.Single));
    const gates = getMouseHoleGateCells(state);
    const kinds = gates.map((g) => state.board[g.r][g.c].type);
    expect(kinds).not.toContain(CellType.Void);
    expect(kinds).toContain(CellType.Empty);
  });
});

describe('虚空不可通行 — 猫 AI 的落点', () => {
  const difficulties = [Difficulty.Easy, Difficulty.Medium, Difficulty.Hard] as const;

  it('4×24：被墙隔断时 AI 不能把补齐区当绕行通道（Easy 必须真的移动）', () => {
    const m = blank(4, 24);
    m.catStart = { r: 3, c: 5 };
    m.mouseStart = { r: 3, c: 20 };
    // 行 3 从列 6 到列 19 全墙，行 2 只留 (2,0) 一个口子。
    // 于是“穿过行 4 的虚空”是曼哈顿最短路径（17 步），绕行要 27 步 ——
    // 未修复时 BFS 会选虚空那条，catMove 拒绝后猫原地不动。
    for (let c = 6; c <= 19; c++) m.grid[3][c] = CellType.Wall;
    for (let c = 1; c <= 23; c++) m.grid[2][c] = CellType.Wall;

    const state = catTurnOf(stateOf(m, Difficulty.Easy));
    expect(state.board[4][5].type).toBe(CellType.Void);
    expect(state.catMovesLeft).toBeGreaterThan(0);
    expect(state.phase).toBe(GamePhase.Playing);

    const moved = catAiMove(state);
    expect(moved).not.toBeNull();
    expect(moved!.catPosition).not.toEqual(state.catPosition);
    expect(terrainAt(moved!, moved!.catPosition)).not.toBe(CellType.Void);
  });

  it('三面墙 + 一面虚空：Easy 判定“无路可走”，而不是假装能穿出去', () => {
    const m = blank(4, 24);
    m.catStart = { r: 3, c: 5 };
    m.mouseStart = { r: 0, c: 10 };
    m.grid[2][5] = CellType.Wall;
    m.grid[3][4] = CellType.Wall;
    m.grid[3][6] = CellType.Wall;
    // 唯一没被墙挡住的方向是下方的虚空

    const state = catTurnOf(stateOf(m, Difficulty.Easy));
    expect(state.board[4][5].type).toBe(CellType.Void);
    // 未修复时会“走”进虚空并在 catMove 处被拒，返回一个没有移动的状态
    expect(catAiMove(state)).toBeNull();
  });

  it('猫邻接 Void：四个方向中只有 Void 时，AI 不崩且不越界到虚空', () => {
    for (const d of difficulties) {
      const m = blank(4, 24);
      m.catStart = { r: 3, c: 5 };
      m.mouseStart = { r: 0, c: 10 };
      // 左、右、上全封死，只剩向下的虚空
      m.grid[2][5] = CellType.Wall;
      m.grid[3][4] = CellType.Wall;
      m.grid[3][6] = CellType.Wall;

      const state = catTurnOf(stateOf(m, d));
      const moved = catAiMove(state);
      expect(moved === null || terrainAt(moved, moved.catPosition) !== CellType.Void).toBe(true);
      if (moved) expect(moved.catPosition).toEqual({ r: 3, c: 5 });
    }
  });

  it('仅部分方向合法：AI 选中的方向必须是 catMove 认可的那几个', () => {
    const m = blank(4, 24);
    m.catStart = { r: 3, c: 5 };
    m.mouseStart = { r: 0, c: 5 };
    // 上可走；左、右是墙；下是虚空 ⇒ 唯一合法方向是“上”
    m.grid[3][4] = CellType.Wall;
    m.grid[3][6] = CellType.Wall;

    const state = catTurnOf(stateOf(m, Difficulty.Easy));
    const moved = catAiMove(state);
    expect(moved).not.toBeNull();
    expect(moved!.catPosition).toEqual({ r: 2, c: 5 });
  });

  it('完全被 Void 与墙包围：返回“无移动”而不是假装能走', () => {
    const m = blank(4, 24);
    m.catStart = { r: 3, c: 5 };
    m.mouseStart = { r: 0, c: 10 };
    m.grid[2][5] = CellType.Wall;
    m.grid[3][4] = CellType.Wall;
    m.grid[3][6] = CellType.Wall;

    const state = catTurnOf(stateOf(m, Difficulty.Easy));
    // 真实规则：猫没有任何合法空间移动
    expect(() => catAiMove(state)).not.toThrow();
    const moved = catAiMove(state);
    expect(moved === null || moved.catPosition.r < 4).toBe(true);
  });
});

describe('虚空不可通行 — 推箱与轨迹', () => {
  it('4×24：不能把箱子推进补齐区', () => {
    const m = blank(4, 24);
    m.catStart = { r: 2, c: 5 };
    m.mouseStart = { r: 0, c: 10 };
    // 箱子在 (3,5)，向下推的落点 (4,5) 正好是补齐出来的虚空
    m.grid[3][5] = CellType.Box;
    const state = catTurnOf(stateOf(m, Difficulty.Easy));
    expect(state.board[4][5].type).toBe(CellType.Void);

    const pushed = catMove(state, DOWN);
    expect(pushed).toBe(state); // catMove 拒绝：猫没有移动、箱子没有移动
    expect(pushed.catPosition).toEqual({ r: 2, c: 5 });
    expect(pushed.board[3][5].type).toBe(CellType.Box);
    expect(pushed.board[4][5].type).toBe(CellType.Void);
  });

  it('轨迹动画的每一步都不落在虚空上', () => {
    const m = blank(4, 24);
    m.catStart = { r: 3, c: 5 };
    m.mouseStart = { r: 3, c: 20 };
    for (let c = 6; c <= 19; c++) m.grid[3][c] = CellType.Wall;

    const state = catTurnOf(stateOf(m, Difficulty.Easy));
    const traj = computeCatAiTrajectory(state);
    expect(traj).not.toBeNull();
    expect(traj!.length).toBeGreaterThan(0);
    for (const step of traj!) {
      expect(step.to.r).toBeLessThan(4);
      expect(step.state.board[step.to.r][step.to.c].type).not.toBe(CellType.Void);
    }
  });
});

describe('虚空不可通行 — 标准地图零影响', () => {
  it('标准地图没有 Void，补齐区以外的一切保持原样', () => {
    const m = blank(10, 10);
    m.catStart = { r: 2, c: 2 };
    m.mouseStart = { r: 7, c: 7 };
    m.grid[4][4] = CellType.MouseHole;
    m.grid[5][4] = CellType.MouseHole;
    m.grid[4][5] = CellType.MouseHole;
    m.grid[5][5] = CellType.MouseHole;

    const state = createInitialState(mapDefinitionToGameConfig(m, GameMode.Single));
    const voids: string[] = [];
    for (let r = 0; r < state.board.length; r++) {
      for (let c = 0; c < state.board[r].length; c++) {
        if (state.board[r][c].type === CellType.Void) voids.push(`${r},${c}`);
      }
    }
    expect(voids).toEqual([]);
    expect(state.phase).toBe(GamePhase.Playing);
    expect(state.currentPlayer).toBe(PieceType.Mouse);
  });
});
