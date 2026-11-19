import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, validateCustomMapConfig, validateGameConfig } from '../config';
import type { GameConfig } from '../config';
import { createInitialState, catMove, computeCatAiTrajectory, endTurn, mouseMove, enumerateButterSpawns } from '../engine';
import type { GameEngineState } from '../engine';
import { createEmptyMap, mapDefinitionToGameConfig, validateMap } from '../mapDefinition';
import type { MapDefinition } from '../mapDefinition';
import { createGameState } from '../newGame';
import { getMouseHoleCells, getTunnelCorners, isMouseHoleCell, mouseHoleDistance } from '../rules/tunnelRules';
import { chooseTunnelExit } from '../rules/tunnels';
import { CellType, DIRECTIONS, Difficulty, GameMode, GamePhase, PieceType } from '../types';
import {
  clearDraft,
  deleteMap,
  exportMapToString,
  importMapFromString,
  listMaps,
  loadDraft,
  saveDraft,
  saveMap,
} from '../mapStorage';

/**
 * 地图编辑器「自由试玩」兼容性（EDITOR-FREEPLAY）。
 *
 * 验收口径：编辑器是自由创作工具，**只有结构损坏**才允许拦截保存 / 试玩；
 * 缺鼠洞、缺黄油、没有通道、奇数通道、非矩形鼠洞、全封闭、猫鼠同格等
 * 一律可以进入对局。这些测试校验的是**真实初始化状态与规则行为**，
 * 不是“按钮能不能跳转”。
 */

const UP = DIRECTIONS[0];
const DOWN = DIRECTIONS[1];
const LEFT = DIRECTIONS[2];
const RIGHT = DIRECTIONS[3];

function blankMap(rows: number, cols: number): MapDefinition {
  return createEmptyMap('测试地图', rows, cols);
}

/** 走真实开局入口；被拦截时带着原因失败。 */
function playable(cfg: GameConfig): GameEngineState {
  const opening = createGameState(cfg);
  if (opening.state === null) {
    throw new Error(`map rejected: ${opening.status.kind} ${JSON.stringify(opening.status)}`);
  }
  return opening.state;
}

function boardHoleCells(state: GameEngineState): { r: number; c: number }[] {
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < state.board.length; r++) {
    for (let c = 0; c < state.board[r].length; c++) {
      if (state.board[r][c].type === CellType.MouseHole) out.push({ r, c });
    }
  }
  return out;
}

function boardCellsOfType(state: GameEngineState, type: CellType): { r: number; c: number }[] {
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < state.board.length; r++) {
    for (let c = 0; c < state.board[r].length; c++) {
      if (state.board[r][c].type === type) out.push({ r, c });
    }
  }
  return out;
}

// ===========================================================================
// 1. 校验分层：结构错误 vs 玩法提示
// ===========================================================================
describe('validateMap — 结构 vs 玩法', () => {
  it('没有鼠洞 / 黄油 / 通道只是提示，不阻止保存或试玩', () => {
    const m = blankMap(6, 6);
    const v = validateMap(m);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join('\n')).toContain('没有绘制鼠洞');
    expect(v.warnings.join('\n')).toContain('尚未放置黄油');
  });

  it('结构问题才阻止：网格行数与 rows 不一致', () => {
    const m = blankMap(6, 6);
    m.rows = 7;
    const v = validateMap(m);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain('网格与行/列数不一致');
  });

  it('结构问题才阻止：无法识别的单元格', () => {
    const m = blankMap(6, 6);
    (m.grid[2] as unknown as string[])[2] = 'lava';
    const v = validateMap(m);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain('无法识别的单元格');
  });

  it('结构问题才阻止：起点坐标越界', () => {
    const m = blankMap(6, 6);
    m.mouseStart = { r: 9, c: 0 };
    const v = validateMap(m);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain('鼠起点坐标无效');
  });

  it('玩法提示覆盖：单通道 / 奇数通道 / 起点被围 / 起点重合', () => {
    const m = blankMap(8, 8);
    m.grid[0][0] = CellType.Tunnel;
    let v = validateMap(m);
    expect(v.ok).toBe(true);
    expect(v.warnings.join('\n')).toContain('只有 1 个');

    m.grid[0][7] = CellType.Tunnel;
    m.grid[7][7] = CellType.Tunnel;
    v = validateMap(m);
    expect(v.ok).toBe(true);
    expect(v.warnings.join('\n')).toContain('奇数');

    const boxed = blankMap(6, 6);
    boxed.catStart = { r: 2, c: 2 };
    boxed.mouseStart = { r: 2, c: 2 };
    for (const [r, c] of [[1, 2], [3, 2], [2, 1], [2, 3]]) boxed.grid[r][c] = CellType.Wall;
    v = validateMap(boxed);
    expect(v.ok).toBe(true);
    expect(v.warnings.join('\n')).toContain('四周没有可通行格子');
    expect(v.warnings.join('\n')).toContain('猫鼠起点重合');
  });

  it('标准地图的转换结果仍然通过正式对局校验（未被放宽污染）', () => {
    const m = blankMap(10, 10);
    for (let r = 7; r < 9; r++) for (let c = 8; c < 10; c++) m.grid[r][c] = CellType.MouseHole;
    m.grid[0][0] = CellType.Tunnel;
    m.grid[0][9] = CellType.Tunnel;
    m.grid[9][0] = CellType.Tunnel;
    m.grid[9][9] = CellType.Tunnel;
    m.catStart = { r: 1, c: 1 };
    m.mouseStart = { r: 6, c: 7 };

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(validateGameConfig(cfg).ok).toBe(true);
    // 2×2 方形鼠洞保持历史上的正方形语义（不带 cells）
    expect(cfg.mouseHole).toEqual({ r: 7, c: 8, size: 2 });
    expect(getMouseHoleCells(cfg)).toHaveLength(4);
  });
});

// ===========================================================================
// 2. 各种“非常规但结构合法”的地图都能进入对局
// ===========================================================================
describe('自由地图 — 可以保存并试玩', () => {
  it('全地板，只有猫鼠起点：可试玩、可移动', () => {
    const m = blankMap(5, 5);
    m.catStart = { r: 2, c: 1 };
    m.mouseStart = { r: 2, c: 3 };
    expect(validateMap(m).ok).toBe(true);

    const state = playable(mapDefinitionToGameConfig(m, GameMode.Single));
    expect(state.phase).toBe(GamePhase.Playing);
    expect(state.mousePosition).toEqual({ r: 2, c: 3 });
    expect(state.catPosition).toEqual({ r: 2, c: 1 });

    const moved = mouseMove(state, RIGHT);
    expect(moved.mousePosition).toEqual({ r: 2, c: 4 });
    expect(moved.phase).toBe(GamePhase.Playing);
  });

  it('没有鼠洞但有黄油：可试玩，且不产生任何虚假鼠洞', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 0, c: 0 };
    m.mouseStart = { r: 3, c: 4 };
    m.grid[3][3] = CellType.ButterSpot;

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(cfg.mouseHole.size).toBe(0);
    expect(cfg.mouseHole.cells).toEqual([]);
    expect(getMouseHoleCells(cfg)).toEqual([]);

    const state = playable(cfg);
    expect(boardHoleCells(state)).toEqual([]);

    // 捡起黄油后继续走：没有洞，所以永远不会触发胜利
    let s = mouseMove(state, LEFT);
    expect(s.mouseHasButter).toBe(true);
    s = mouseMove(s, RIGHT);
    s = mouseMove(s, UP);
    expect(s.phase).toBe(GamePhase.Playing);
    expect(boardHoleCells(s)).toEqual([]);
  });

  it('有鼠洞但没有黄油：可试玩（走到洞里也不会赢）', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 0, c: 0 };
    m.mouseStart = { r: 5, c: 4 };
    m.grid[5][5] = CellType.MouseHole;

    const state = playable(mapDefinitionToGameConfig(m, GameMode.Single));
    expect(boardHoleCells(state)).toEqual([{ r: 5, c: 5 }]);

    const moved = mouseMove(state, RIGHT);
    expect(moved.mousePosition).toEqual({ r: 5, c: 5 });
    expect(moved.phase).toBe(GamePhase.Playing); // 没有黄油 → 不算获胜
  });

  it('没有任何通道：四角不会冒出虚假通道', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 0, c: 0 };
    m.mouseStart = { r: 3, c: 3 };

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(cfg.tunnelCorners).toEqual([]);
    expect(getTunnelCorners(cfg)).toEqual([]);

    const state = playable(cfg);
    expect(boardCellsOfType(state, CellType.Tunnel)).toEqual([]);
  });

  it('只有一个通道：进入后只有“原地”一个出口，不会凭空多出出口', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 5, c: 5 };
    m.mouseStart = { r: 0, c: 1 };
    m.grid[0][0] = CellType.Tunnel;

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(getTunnelCorners(cfg)).toHaveLength(1);

    const state = playable(cfg);
    const entering = mouseMove(state, LEFT);
    // 单出口由现有规则自动结算：留在原地（不会被传送到不存在的出口）
    expect(entering.phase).toBe(GamePhase.Playing);
    expect(entering.mousePosition).toEqual({ r: 0, c: 0 });
    expect(entering.currentPlayer).toBe(PieceType.Cat);
    expect(boardCellsOfType(entering, CellType.Tunnel)).toEqual([{ r: 0, c: 0 }]);
  });

  it('三个通道：行为沿用真实通道规则（其余通道 + 原地）', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 5, c: 3 };
    m.mouseStart = { r: 0, c: 1 };
    m.grid[0][0] = CellType.Tunnel;
    m.grid[0][5] = CellType.Tunnel;
    m.grid[5][0] = CellType.Tunnel;

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(getTunnelCorners(cfg)).toHaveLength(3);

    const state = playable(cfg);
    const entering = mouseMove(state, LEFT);
    expect(entering.phase).toBe(GamePhase.ChoosingTunnelExit);
    expect(entering.tunnelExitChoices).toHaveLength(3);

    const landed = chooseTunnelExit(entering, 0, 5);
    expect(landed).not.toBe(entering);
    expect(landed.mousePosition).toEqual({ r: 0, c: 5 });
    expect(landed.phase).toBe(GamePhase.Playing);
  });

  it('非矩形鼠洞：只有真正画出来的格子是鼠洞', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 0, c: 0 };
    m.mouseStart = { r: 4, c: 4 };
    // L 形鼠洞：(5,5) (5,4) (4,5)；包围盒里的 (4,4) 是普通地板
    m.grid[5][5] = CellType.MouseHole;
    m.grid[5][4] = CellType.MouseHole;
    m.grid[4][5] = CellType.MouseHole;
    m.grid[4][3] = CellType.ButterSpot;

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(cfg.mouseHole.size).toBe(2);
    expect(cfg.mouseHole.cells).toHaveLength(3);
    expect(getMouseHoleCells(cfg)).toEqual(
      expect.arrayContaining([{ r: 5, c: 5 }, { r: 5, c: 4 }, { r: 4, c: 5 }]),
    );
    expect(getMouseHoleCells(cfg)).toHaveLength(3);
    // 包围盒内的普通地板不是鼠洞
    expect(isMouseHoleCell(4, 4, cfg.mouseHole)).toBe(false);
    expect(isMouseHoleCell(4, 5, cfg.mouseHole)).toBe(true);

    const state = playable(cfg);
    expect(boardHoleCells(state)).toHaveLength(3);

    // 猫：可以走到包围盒内的普通地板 (4,4)，但不能走进真实鼠洞 (4,5)
    const catState: GameEngineState = {
      ...state,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 2,
      catPosition: { r: 4, c: 3 },
      mousePosition: { r: 0, c: 1 },
    };
    const catOnFloor = catMove(catState, RIGHT);
    expect(catOnFloor.catPosition).toEqual({ r: 4, c: 4 });
    const catIntoHole = catMove({ ...catOnFloor, catMovesLeft: 2 }, RIGHT);
    expect(catIntoHole.catPosition).toEqual({ r: 4, c: 4 }); // 真实鼠洞仍然拦猫

    // 鼠：在包围盒地板 (4,4) 上带黄油不会赢，进真实鼠洞 (5,4) 才赢
    let s = mouseMove(state, LEFT); // 捡黄油 (4,3)
    expect(s.mouseHasButter).toBe(true);
    s = mouseMove(s, RIGHT); // 回到 (4,4)：普通地板
    expect(s.phase).toBe(GamePhase.Playing);
    s = mouseMove(s, DOWN); // (5,4)：真实鼠洞
    expect(s.phase).toBe(GamePhase.MouseWins);
  });

  it('全部被墙包围：仍可进入对局，不崩溃（按既有规则立刻结算）', () => {
    const m = blankMap(5, 5);
    m.catStart = { r: 2, c: 1 };
    m.mouseStart = { r: 2, c: 3 };
    for (const [r, c] of [[1, 3], [3, 3], [2, 2], [2, 4]]) m.grid[r][c] = CellType.Wall;

    expect(validateMap(m).ok).toBe(true);
    const state = playable(mapDefinitionToGameConfig(m, GameMode.Single));
    expect(state.phase).toBe(GamePhase.CatWins);
    expect(state.message).toContain('无路可走');
    // 墙没有被偷偷改成地板
    expect(state.board[1][3].type).toBe(CellType.Wall);
  });

  it('大量虚空、只留少量地板：边界行为正确', () => {
    const m = blankMap(24, 24);
    for (let r = 0; r < 24; r++) for (let c = 0; c < 24; c++) m.grid[r][c] = CellType.Void;
    m.grid[10][10] = CellType.Empty;
    m.grid[10][11] = CellType.Empty;
    m.grid[11][10] = CellType.Empty;
    m.catStart = { r: 11, c: 10 };
    m.mouseStart = { r: 10, c: 11 };

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(cfg.boardSize).toBe(24);
    const state = playable(cfg);
    expect(state.board[0][0].type).toBe(CellType.Void);
    expect(state.board[10][10].type).toBe(CellType.Empty);
    // 走进虚空被拦下（位置不变、不崩溃），只剩的那块地板仍然可走
    const blocked = mouseMove(state, UP);
    expect(blocked.mousePosition).toEqual({ r: 10, c: 11 });
    expect(blocked.phase).toBe(GamePhase.Playing);
    const stepped = mouseMove(state, LEFT);
    expect(stepped.mousePosition).toEqual({ r: 10, c: 10 });
  });

  it('猫鼠起点重合：安全处理并沿用“同格 = 猫获胜”语义', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 2, c: 2 };
    m.mouseStart = { r: 2, c: 2 };

    expect(validateMap(m).ok).toBe(true);
    const state = playable(mapDefinitionToGameConfig(m, GameMode.Single));
    expect(state.phase).toBe(GamePhase.CatWins);
    expect(state.message).toContain('猫获胜');
    expect(state.catPosition).toEqual(state.mousePosition);
  });

  it('起点重合：同格判猫胜，且不会额外记一条“无路可走”结算', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 2, c: 2 };
    m.mouseStart = { r: 2, c: 2 };
    // 猫不能进鼠洞，鼠能进 —— 用这格确保“无路可走”判定真的有可能被触发
    m.grid[1][2] = CellType.MouseHole;
    m.grid[3][2] = CellType.Wall;
    m.grid[2][1] = CellType.Wall;
    m.grid[2][3] = CellType.Wall;

    const state = playable(mapDefinitionToGameConfig(m, GameMode.Single));
    expect(state.phase).toBe(GamePhase.CatWins);
    // 同格是被抓住，不是困死：开局日志里不应出现无路可走结算
    const log = state.gameEventLog.join('\n');
    expect(log).not.toContain('NO_LEGAL_MOVE_LOSS');
  });

  it('起点与地形冲突：地形不被改写，棋子可以走出该格', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 1, c: 1 };
    m.mouseStart = { r: 3, c: 3 };
    m.grid[1][1] = CellType.Wall;
    m.grid[3][3] = CellType.Void;

    const before = JSON.stringify(m);
    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(JSON.stringify(m)).toBe(before); // 保存的原始布局没有被偷偷改写

    // 地形保持编辑器画的样子
    expect(cfg.customTerrain?.[1][1]).toBe(CellType.Wall);
    expect(cfg.customTerrain?.[3][3]).toBe(CellType.Void);

    const state = playable(cfg);
    expect(state.catPosition).toEqual({ r: 1, c: 1 });
    expect(state.mousePosition).toEqual({ r: 3, c: 3 });
    expect(state.board[1][1].type).toBe(CellType.Wall);

    // 猫虽然站在墙上，但可以走到相邻地板
    const catTurn: GameEngineState = { ...state, currentPlayer: PieceType.Cat, catMovesLeft: 2 };
    expect(catMove(catTurn, RIGHT).catPosition).toEqual({ r: 1, c: 2 });
  });

  it('非正方形 4×24 / 24×4：Void 补齐不越界，可渲染可移动', () => {
    const wide = blankMap(4, 24);
    wide.catStart = { r: 2, c: 1 };
    wide.mouseStart = { r: 2, c: 22 };
    const wideCfg = mapDefinitionToGameConfig(wide, GameMode.Single);
    expect(wideCfg.boardSize).toBe(24);
    expect(wideCfg.customTerrain).toHaveLength(24);
    expect(wideCfg.customTerrain?.every((row) => row.length === 24)).toBe(true);
    for (let r = 4; r < 24; r++) {
      expect(wideCfg.customTerrain?.[r].every((t) => t === CellType.Void)).toBe(true);
    }
    const wideState = playable(wideCfg);
    expect(wideState.mousePosition).toEqual({ r: 2, c: 22 });
    expect(wideState.board[10][0].type).toBe(CellType.Void);
    expect(mouseMove(wideState, LEFT).mousePosition).toEqual({ r: 2, c: 21 });

    const tall = blankMap(24, 4);
    tall.catStart = { r: 2, c: 1 };
    tall.mouseStart = { r: 2, c: 2 };
    const tallCfg = mapDefinitionToGameConfig(tall, GameMode.Single);
    expect(tallCfg.boardSize).toBe(24);
    for (let r = 0; r < 24; r++) {
      expect(tallCfg.customTerrain?.[r].slice(4).every((t) => t === CellType.Void)).toBe(true);
    }
    const tallState = playable(tallCfg);
    expect(tallState.board[0][10].type).toBe(CellType.Void);
  });

  it('双人模式同样可以进入对局', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 0, c: 0 };
    m.mouseStart = { r: 5, c: 5 };
    const state = playable(mapDefinitionToGameConfig(m, GameMode.Dual));
    expect(state.gameMode).toBe(GameMode.Dual);
    expect(state.phase).toBe(GamePhase.Playing);
  });

  it('重复试玩仍是同一张自定义地图（重开不换成随机开局）', () => {
    const m = blankMap(6, 6);
    m.catStart = { r: 1, c: 1 };
    m.mouseStart = { r: 4, c: 4 };
    m.grid[0][0] = CellType.Tunnel;
    m.grid[0][5] = CellType.Tunnel;
    m.grid[4][4] = CellType.ButterSpot;

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    const a = playable(cfg);
    const b = playable(cfg);
    expect(JSON.stringify(a.board)).toBe(JSON.stringify(b.board));
    expect(b.catPosition).toEqual({ r: 1, c: 1 });
    expect(b.mousePosition).toEqual({ r: 4, c: 4 });
  });

  it('单人自定义地图在 hard 难度下 AI 不崩、不死循环', () => {
    const m = blankMap(10, 10);
    m.catStart = { r: 1, c: 1 };
    m.mouseStart = { r: 8, c: 8 };
    // 没有任何鼠洞 —— AI 需要在“不存在获胜目标”的拓扑上安全决策
    const cfg: GameConfig = {
      ...mapDefinitionToGameConfig(m, GameMode.Single),
      difficulty: Difficulty.Hard,
    };
    const state = playable(cfg);
    const catTurn = endTurn(state);
    expect(catTurn.currentPlayer).toBe(PieceType.Cat);

    const trajectory = computeCatAiTrajectory(catTurn);
    expect(trajectory).not.toBeNull();
    expect(trajectory!.length).toBeGreaterThan(0);
    expect(trajectory![0].state.phase).not.toBe(undefined);
  });
});

// ===========================================================================
// 3. 损坏输入与持久化
// ===========================================================================
describe('导入 / 导出 / 保存', () => {
  it('损坏的 JSON 有明确错误，不会把半坏网格塞进渲染层', () => {
    expect(() => importMapFromString('{not json')).toThrow(/不是有效的 JSON/);
    expect(() => importMapFromString('[]')).toThrow(/顶层必须是一个地图对象/);
    expect(() => importMapFromString('{"rows":4,"cols":4}')).toThrow(/缺少 grid/);
    expect(() => importMapFromString(JSON.stringify({
      grid: [
        ['empty', 'empty', 'empty', 'empty'],
        42,
        ['empty', 'empty', 'empty', 'empty'],
        ['empty', 'empty', 'empty', 'empty'],
      ],
    }))).toThrow(/不是数组/);
    expect(() => importMapFromString(JSON.stringify({
      grid: Array.from({ length: 30 }, () => Array.from({ length: 30 }, () => 'empty')),
    }))).toThrow(/超出编辑器范围/);
    expect(() => importMapFromString(JSON.stringify({
      grid: Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => 'empty')),
      catStart: { r: 9, c: 0 },
    }))).toThrow(/越界/);
  });

  it('导出再导入保持一致，未知格子/短行被安全修复', () => {
    const m = blankMap(6, 6);
    m.grid[0][0] = CellType.Wall;
    m.grid[5][5] = CellType.MouseHole;
    const round = importMapFromString(exportMapToString(m));
    expect(round.rows).toBe(6);
    expect(round.cols).toBe(6);
    expect(round.grid[0][0]).toBe(CellType.Wall);
    expect(round.grid[5][5]).toBe(CellType.MouseHole);
    expect(validateMap(round).ok).toBe(true);

    const patched = importMapFromString(JSON.stringify({
      rows: 5,
      cols: 5,
      grid: [
        ['empty', 'lava', 'empty', 'empty', 'empty'],
        ['empty'],
        ['empty', 'empty', 'empty', 'empty', 'empty'],
        ['empty', 'empty', 'empty', 'empty', 'empty'],
        ['empty', 'empty', 'empty', 'empty', 'mouse_hole'],
      ],
    }));
    expect(patched.grid[0][1]).toBe(CellType.Empty); // 未知 → 地板
    expect(patched.grid[1][1]).toBe(CellType.Void);  // 缺失 → 虚空
    expect(validateMap(patched).ok).toBe(true);
  });

  it('保存 / 读取不含鼠洞的自定义地图（不再被玩法要素拦截）', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });

    const m = blankMap(6, 6);
    m.name = '无鼠洞地图';
    expect(validateMap(m).ok).toBe(true);
    saveMap(m);
    const listed = listMaps();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('无鼠洞地图');
    expect(validateMap(listed[0]).ok).toBe(true);

    deleteMap(m.id);
    expect(listMaps()).toHaveLength(0);

    // 试玩草稿：返回编辑器后原图完整保留（含没有鼠洞这种“不标准”内容）
    saveDraft(m);
    const draft = loadDraft();
    expect(draft).not.toBeNull();
    expect(JSON.stringify(draft!.grid)).toBe(JSON.stringify(m.grid));
    expect(draft!.catStart).toEqual(m.catStart);
    expect(draft!.mouseStart).toEqual(m.mouseStart);
    clearDraft();
    expect(loadDraft()).toBeNull();

    // 坏草稿（尺寸越界）不会被当成可渲染地图塞回编辑器
    store.set('catmouse_map_draft_v1', JSON.stringify({ rows: 99, cols: 99, grid: [[]] }));
    expect(loadDraft()).toBeNull();

    vi.unstubAllGlobals();
  });
});

// ===========================================================================
// 4. 正式对局 / 默认配置未被放宽
// ===========================================================================
describe('正式路径不受影响', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('默认配置仍然是四角通道与 2×2 鼠洞', () => {
    expect(getTunnelCorners(DEFAULT_CONFIG)).toHaveLength(4);
    expect(getMouseHoleCells(DEFAULT_CONFIG)).toHaveLength(4);
    expect(isMouseHoleCell(7, 8, DEFAULT_CONFIG.mouseHole)).toBe(true);
    expect(isMouseHoleCell(6, 8, DEFAULT_CONFIG.mouseHole)).toBe(false);
  });

  it('正式校验仍然拒绝越界 / 同格起点 / 认证范围外的尺寸', () => {
    expect(validateGameConfig({ ...DEFAULT_CONFIG, boardSize: 24 }).ok).toBe(false);
    expect(validateGameConfig({ ...DEFAULT_CONFIG, catStart: { ...DEFAULT_CONFIG.mouseStart } }).ok).toBe(false);
    expect(validateGameConfig({ ...DEFAULT_CONFIG, mouseHole: { r: -1, c: -1, size: 0 } }).ok).toBe(false);
  });

  it('createInitialState 对正式配置保持原样（不追加同格结算）', () => {
    const state = createInitialState(DEFAULT_CONFIG);
    expect(state.phase).toBe(GamePhase.Playing);
    expect(state.currentPlayer).toBe(PieceType.Mouse);
  });

  it('编辑器配置走的是结构校验，正式配置仍走开局契约', () => {
    const m = blankMap(6, 6);
    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(cfg.customMapPlaytest).toBe(true);
    expect(validateCustomMapConfig(cfg).ok).toBe(true);
    // 同一个 config 若不带编辑器标记，正式校验会拒绝（说明两条路确实分开）
    const asFormal: GameConfig = { ...cfg, customMapPlaytest: undefined };
    expect(validateGameConfig(asFormal).ok).toBe(false);
  });
});

/**
 * ACCEPTANCE-1 — 「开始试玩」到对局初始化的整链路。
 *
 * 编辑器只做一件事：buildMap → validateMap（结构）→ mapDefinitionToGameConfig
 * → navigate('/game', { state: { from:'editor', config } })。对局页拿这份 config
 * 走 createGameState；失败不抛异常（返回 unverified + state:null），所以不会白屏。
 * 这里校验初始化 / 操作 / 重开 / 原始地图未被改写，三张代表性地图各来一遍。
 */
describe('试玩链路 — 进入 / 操作 / 重开 / 原图保留', () => {
  function standardEditorMap(): MapDefinition {
    const m = blankMap(10, 10);
    m.catStart = { r: 2, c: 2 };
    m.mouseStart = { r: 7, c: 7 };
    // 2×2 鼠洞
    for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) m.grid[4 + dr][4 + dc] = CellType.MouseHole;
    // 四角通道
    m.grid[0][0] = CellType.Tunnel;
    m.grid[0][9] = CellType.Tunnel;
    m.grid[9][0] = CellType.Tunnel;
    m.grid[9][9] = CellType.Tunnel;
    m.grid[3][6] = CellType.ButterSpot;
    return m;
  }

  const cases: { name: string; make: () => MapDefinition }[] = [
    {
      name: '无鼠洞全地板',
      make: () => {
        const m = blankMap(10, 10);
        m.catStart = { r: 5, c: 5 };
        m.mouseStart = { r: 5, c: 6 };
        return m;
      },
    },
    { name: '普通标准布局', make: standardEditorMap },
    {
      name: '4×24 非正方形',
      make: () => {
        const m = blankMap(4, 24);
        m.catStart = { r: 1, c: 1 };
        m.mouseStart = { r: 2, c: 22 };
        m.grid[1][2] = CellType.ButterSpot;
        return m;
      },
    },
  ];

  for (const { name, make } of cases) {
    it(`${name}：能进入、能操作、重开后与原图一致`, () => {
      const map = make();
      const snapshot = JSON.stringify(map);

      const cfg = mapDefinitionToGameConfig(map, GameMode.Single);
      const opening = createGameState(cfg);
      expect(opening.status.kind).not.toBe('unverified');
      expect(opening.state).not.toBeNull();
      const state = opening.state!;

      // 棋盘尺寸自洽（渲染层假设 board[r].length === board.length）
      expect(state.board).toHaveLength(cfg.boardSize);
      expect(state.board.every((row) => row.length === cfg.boardSize)).toBe(true);
      expect(state.phase).toBe(GamePhase.Playing);
      expect(state.currentPlayer).toBe(PieceType.Mouse);
      expect(state.board[state.mousePosition.r][state.mousePosition.c].piece).toBe(PieceType.Mouse);

      // 一步真实操作 + 交给猫方
      const dir = cfg.boardSize > 4 ? RIGHT : DOWN;
      const moved = mouseMove(state, dir);
      expect(moved.phase === GamePhase.Playing || moved.phase === GamePhase.ChoosingTunnelExit
        || moved.phase === GamePhase.CatWins || moved.phase === GamePhase.MouseWins).toBe(true);
      const afterTurn = endTurn(moved);
      expect(afterTurn.currentPlayer).toBe(PieceType.Cat);

      // 重开：同一份 config 再初始化一次，必须是同一局面（不是随机新局）
      const again = createGameState(cfg).state!;
      expect(again.board).toEqual(state.board);
      expect(again.mousePosition).toEqual(state.mousePosition);
      expect(again.catPosition).toEqual(state.catPosition);
      expect(again.butterPositions).toEqual(state.butterPositions);

      // 返回编辑器：转换过程没有偷偷改写原始地图
      expect(JSON.stringify(map)).toBe(snapshot);
    });
  }

  it('结构损坏的 config 返回 unverified（对局页显示原因，不抛异常）', () => {
    const m = blankMap(6, 6);
    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    const broken: GameConfig = { ...cfg, catStart: { r: 99, c: 0 } };
    expect(() => createGameState(broken)).not.toThrow();
    const opening = createGameState(broken);
    expect(opening.status.kind).toBe('unverified');
    expect(opening.state).toBeNull();
  });
});

/**
 * ACCEPTANCE-2 — 黄油再生几何必须按「真实鼠洞格」计算。
 *
 * 回归的缺陷：`enumerateButterSpawns` 用 `config.mouseHole.r/c` 算到洞距离。
 * 对非矩形 / 分散鼠洞，那是**包围盒左上角**，不是最近的洞格；对没有鼠洞的
 * 地图，那是一个虚拟坐标。两个方向都会错：既可能把洞格旁的格子判为合法
 * （紧贴鼠洞生黄油），也可能把远离鼠洞的格子误排除。
 */
describe('黄油再生 — 洞几何按真实格子', () => {
  it('标准地图：距离与历史公式逐格一致（零行为变化）', () => {
    const hole = DEFAULT_CONFIG.mouseHole;
    for (let r = 0; r < DEFAULT_CONFIG.boardSize; r++) {
      for (let c = 0; c < DEFAULT_CONFIG.boardSize; c++) {
        expect(mouseHoleDistance(hole, r, c)).toBe(Math.abs(r - hole.r) + Math.abs(c - hole.c));
      }
    }
  });

  it('没有鼠洞：任何地板都不会因为“靠近洞”被排除', () => {
    const m = blankMap(10, 10);
    m.catStart = { r: 5, c: 5 };
    m.mouseStart = { r: 5, c: 6 };
    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    expect(cfg.mouseHole.cells).toEqual([]);

    const st = createInitialState(cfg);
    const cells = enumerateButterSpawns(st.config, st.board, [], st.mousePosition, st.catPosition, [], null);
    const has = (r: number, c: number) => cells.some((p) => p.r === r && p.c === c);
    // 贴近棋盘左上角的内圈格全部仍是合法候选
    expect(has(1, 1)).toBe(true);
    expect(has(1, 2)).toBe(true);
    expect(has(2, 1)).toBe(true);
    expect(mouseHoleDistance(cfg.mouseHole, 1, 1)).toBe(Infinity);
  });

  it('L 形鼠洞：洞旁的 (11,12) 必须被排除（包围盒左上角算法会放进来）', () => {
    const m = blankMap(20, 20);
    m.catStart = { r: 0, c: 0 };
    m.mouseStart = { r: 1, c: 1 };
    m.grid[10][10] = CellType.MouseHole;
    m.grid[11][10] = CellType.MouseHole;
    m.grid[12][10] = CellType.MouseHole;
    m.grid[12][11] = CellType.MouseHole;

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    // 非矩形 ⇒ 必须带精确格子集合
    expect(cfg.mouseHole.cells).toHaveLength(4);
    expect(isMouseHoleCell(10, 11, cfg.mouseHole)).toBe(false);

    // 历史式（到包围盒左上角）算出 3，恰好通过 <3 判定；真实最近洞格是 (12,11)，距离 2。
    expect(Math.abs(11 - cfg.mouseHole.r) + Math.abs(12 - cfg.mouseHole.c)).toBe(3);
    expect(mouseHoleDistance(cfg.mouseHole, 11, 12)).toBe(2);

    const st = createInitialState(cfg);
    const cells = enumerateButterSpawns(st.config, st.board, [], st.mousePosition, st.catPosition, [], null);
    expect(cells.some((p) => p.r === 11 && p.c === 12)).toBe(false);
    // 距离恰好 3 的格子仍然合法（阈值本身没有被改动）
    expect(mouseHoleDistance(cfg.mouseHole, 8, 11)).toBe(3);
    expect(cells.some((p) => p.r === 8 && p.c === 11)).toBe(true);
  });

  it('鼠洞格本身永远不是黄油候选（精确集合权威）', () => {
    const m = blankMap(20, 20);
    m.catStart = { r: 0, c: 0 };
    m.mouseStart = { r: 1, c: 1 };
    m.grid[15][15] = CellType.MouseHole;
    m.grid[15][18] = CellType.MouseHole;

    const cfg = mapDefinitionToGameConfig(m, GameMode.Single);
    const st = createInitialState(cfg);
    const cells = enumerateButterSpawns(st.config, st.board, [], st.mousePosition, st.catPosition, [], null);
    expect(cells.some((p) => p.r === 15 && p.c === 15)).toBe(false);
    expect(cells.some((p) => p.r === 15 && p.c === 18)).toBe(false);
    // 包围盒内部的普通地板不是洞
    expect(isMouseHoleCell(15, 16, cfg.mouseHole)).toBe(false);
  });
});
