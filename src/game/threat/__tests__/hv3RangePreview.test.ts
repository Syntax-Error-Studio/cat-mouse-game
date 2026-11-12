/**
 * PPC-HV-3 P0 — 「查看猫可达范围」预览的行为契约。
 *
 * 要守住的是四条容易被后来改动悄悄破坏的前提：
 *   1) 单机里人永远执鼠，鼠回合上 `catMovesLeft` 常常是 0。预览必须按猫整回合的
 *      合法预算来算，不能拿剩余步数算出一个空范围。
 *   2) 红格就是「猫用合法步数走得到的格子」：把 witnessPath 用真实 `catMove` 重放，
 *      落点必须正好是那一格。禁入格（洞/通道/墙/箱/堆/虚空/黄油）一律不许亮。
 *   3) 预览只读局面：不改真实 GameEngineState、不消耗或放置陷阱、不触发回合交接、
 *      不生成随机黄油。这里把输入深冻结，让任何「写」直接抛错，而不是靠肉眼审。
 *   4) 它是范围，不是 AI 的预测路线：整条路径上不许出现 Expectiminimax / hard 规划器。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { catMove, createInitialState } from '../../engine';
import type { GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GameMode, GamePhase, PieceType } from '../../types';
import type { GameConfig } from '../../config';
import { DEFAULT_CONFIG } from '../../config';
import { stateKey } from '../../ai/transposition';
import { getCatThreatMap, buildCatTurnRoot } from '../catThreatMap';

type Point = { r: number; c: number };

/** 自定义地形：只有空格 + marks 里点名的格子，完全可控、无随机。 */
function makeState(opts: {
  size?: number;
  cat: Point;
  mouse?: Point;
  marks?: Record<string, CellType>;
  budget?: number;
  trap?: Point;
  butter?: Point[];
}): GameEngineState {
  const size = opts.size ?? 9;
  const hole = { r: size - 3, c: size - 2, size: 2 };
  const tunnels = [[0, 0], [0, size - 1], [size - 1, 0], [size - 1, size - 1]].map(([r, c]) => ({ r, c }));
  const grid: CellType[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => CellType.Empty as CellType),
  );
  for (const [key, type] of Object.entries(opts.marks ?? {})) {
    const [r, c] = key.split(',').map(Number);
    grid[r][c] = type;
  }
  // 地形与 config.tunnelCorners 必须来自同一份事实，否则又变成两套规则。
  for (const t of tunnels) grid[t.r][t.c] = CellType.Tunnel;
  for (let dr = 0; dr < hole.size; dr++) {
    for (let dc = 0; dc < hole.size; dc++) grid[hole.r + dr][hole.c + dc] = CellType.MouseHole;
  }

  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    boardSize: size,
    mouseHole: hole,
    customTerrain: grid,
    tunnelCorners: tunnels,
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: opts.mouse ?? { r: size - 3, c: 1 },
    catStart: opts.cat,
    catBaseMoves: opts.budget ?? 4,
    gameMode: GameMode.Single,
  };
  const state: GameEngineState = createInitialState(config);
  return {
    ...(opts.trap ? { ...state, trapPosition: opts.trap, catTrapsRemaining: 0 } : state),
    butterPositions: opts.butter ?? [],
  };
}

/** 人执鼠、刚走完自己那四步：这是按钮要能打开的真实时机，也是最容易算空的时机。 */
function mouseTurn(state: GameEngineState, catMovesLeft = 0): GameEngineState {
  return { ...state, phase: GamePhase.Playing, currentPlayer: PieceType.Mouse, catMovesLeft };
}

const cellsOf = (map: ReturnType<typeof getCatThreatMap>) =>
  map.dangerousCells.map(d => `${d.r},${d.c}`).sort();
const manhattan = (a: Point, b: Point) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c);

function deepFreeze<T>(o: T): T {
  for (const v of Object.values(o as Record<string, unknown>)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(o);
}

describe('危险区域辅助 — 鼠回合的合法预算', () => {
  it('猫剩余 0 步时范围依然非空，预算取整回合的 catBaseMoves', () => {
    const s = mouseTurn(makeState({ cat: { r: 4, c: 4 }, budget: 4 }));
    expect(s.catMovesLeft).toBe(0);
    const map = getCatThreatMap(s);
    expect(map.budget).toBe(s.config.catBaseMoves);
    expect(map.budget).toBe(4);
    expect(map.dangerousCells.length).toBeGreaterThan(0);
    expect(map.incomplete).toBe(false);
  });

  it('同一份地形的范围只跟预算有关，跟「现在轮到谁」无关', () => {
    const base = makeState({ cat: { r: 4, c: 4 }, budget: 4 });
    const onMouseTurn = getCatThreatMap(mouseTurn(base, 0));
    const onCatTurn = getCatThreatMap({ ...base, currentPlayer: PieceType.Cat, catMovesLeft: base.config.catBaseMoves });
    expect(cellsOf(onMouseTurn)).toEqual(cellsOf(onCatTurn));
  });

  it('猫回合中途收窄到剩余步数，且仍是整回合范围的子集', () => {
    const base = makeState({ cat: { r: 4, c: 4 }, budget: 4 });
    const full = getCatThreatMap(mouseTurn(base, 0));
    const mid = getCatThreatMap({ ...base, currentPlayer: PieceType.Cat, catMovesLeft: 2 });
    expect(mid.budget).toBe(2);
    expect(mid.dangerousCells.length).toBeLessThan(full.dangerousCells.length);
    for (const cell of cellsOf(mid)) expect(cellsOf(full)).toContain(cell);
  });

  it('预览的是范围不是路线：每个红格都不超出预算，也没有上一局的远格残留', () => {
    const map = getCatThreatMap(mouseTurn(makeState({ cat: { r: 4, c: 4 }, budget: 4 })));
    for (const cell of map.dangerousCells) {
      expect(manhattan(map.catPosition, cell)).toBeLessThanOrEqual(map.budget);
      expect(cell.minimumSteps).toBeLessThanOrEqual(map.budget);
    }
  });
});

describe('危险区域辅助 — 红格等于合法可达，禁入格不误亮', () => {
  const blocked = makeState({
    cat: { r: 4, c: 4 },
    budget: 4,
    marks: { '2,2': CellType.Wall, '3,6': CellType.Box, '5,5': CellType.Pile, '6,1': CellType.Void },
    butter: [{ r: 3, c: 3 }],
  });
  const map = getCatThreatMap(mouseTurn(blocked));

  it('墙/箱/堆/虚空/黄油/通道/鼠洞都不在红格里', () => {
    const red = cellsOf(map);
    const forbidden: Point[] = [
      { r: 2, c: 2 },   // 墙
      { r: 3, c: 6 },   // 箱
      { r: 5, c: 5 },   // 杂货堆
      { r: 6, c: 1 },   // 虚空
      { r: 3, c: 3 },   // 实体黄油
      { r: 0, c: 0 }, { r: 0, c: 8 }, { r: 8, c: 0 }, { r: 8, c: 8 },               // 四角通道
      { r: 6, c: 7 }, { r: 6, c: 8 }, { r: 7, c: 7 }, { r: 7, c: 8 },               // 鼠洞 2x2
    ];
    for (const p of forbidden) expect(red, `(${p.r},${p.c}) must never light up`).not.toContain(`${p.r},${p.c}`);
  });

  it('紧邻空格仍然亮红：上面那条断言不是空转', () => {
    expect(cellsOf(map)).toContain('4,5');
    expect(map.dangerousCells.length).toBeGreaterThan(0);
  });

  it('红格 = 猫真能走到的格子：witnessPath 逐格重放后正好落在那一格', () => {
    for (const cell of map.dangerousCells) {
      let s = buildCatTurnRoot(mouseTurn(blocked), { r: cell.r, c: cell.c });
      for (const key of cell.witnessPath) {
        const dir = DIRECTIONS.find(d => d.key === key)!;
        const next = catMove(s, dir);
        expect(next === s, `witness step ${key} was rejected by the engine`).toBe(false);
        s = next;
      }
      expect(s.phase).toBe(GamePhase.CatWins);
      expect(s.catPosition).toEqual({ r: cell.r, c: cell.c });
    }
  });

  it('带陷阱的局面里，红格依然可重放（收回陷阱不中断追捕）', () => {
    const withTrap = makeState({ cat: { r: 4, c: 4 }, budget: 4, trap: { r: 4, c: 5 } });
    const m = getCatThreatMap(mouseTurn(withTrap));
    expect(m.incomplete).toBe(false);
    const onTrap = m.dangerousCells.find(d => d.r === 4 && d.c === 5);
    expect(onTrap).toBeTruthy();
  });
});

describe('危险区域辅助 — 只读，不改真实局面', () => {
  it('深冻结输入也算得完：陷阱、回合、步数、黄油、棋盘一字不差', () => {
    const s = deepFreeze({
      ...makeState({ cat: { r: 4, c: 4 }, budget: 4, trap: { r: 2, c: 4 } }),
      currentPlayer: PieceType.Mouse,
      catMovesLeft: 0,
      pendingButterSpawns: [{ r: 1, c: 1, blockedMaterializations: 0 }],
    } as GameEngineState);
    const before = {
      key: stateKey(s as GameEngineState),
      trapPosition: s.trapPosition,
      catTrapsRemaining: s.catTrapsRemaining,
      currentPlayer: s.currentPlayer,
      catMovesLeft: s.catMovesLeft,
      mouseMovesLeft: s.mouseMovesLeft,
      phase: s.phase,
      pendingButterSpawns: s.pendingButterSpawns.length,
      board: JSON.stringify(s.board),
    };
    const map = getCatThreatMap(s);
    expect(map.dangerousCells.length).toBeGreaterThan(0);
    expect(stateKey(s as GameEngineState)).toBe(before.key);
    expect(s.trapPosition).toBe(before.trapPosition);          // 陷阱没被消耗，也没被重新放置
    expect(s.catTrapsRemaining).toBe(before.catTrapsRemaining);
    expect(s.currentPlayer).toBe(before.currentPlayer);        // 没有回合交接
    expect(s.catMovesLeft).toBe(before.catMovesLeft);
    expect(s.mouseMovesLeft).toBe(before.mouseMovesLeft);
    expect(s.phase).toBe(GamePhase.Playing);                   // 没有分出胜负
    expect(s.pendingButterSpawns.length).toBe(before.pendingButterSpawns);
    expect(JSON.stringify(s.board)).toBe(before.board);        // 箱子/猫/鼠都没有被挪动
  });

  it('同一局面重复计算结果一致（无内部缓存或随机残留）', () => {
    const s = mouseTurn(makeState({ cat: { r: 4, c: 4 }, budget: 4 }));
    expect(getCatThreatMap(s)).toEqual(getCatThreatMap(s));
  });

  it('整条预览路径上没有 AI：不导入搜索、不规划整回合、不用随机数或时钟', () => {
    const aiTokens = /expectiminimax|hardTurnPlanner|planHardCatTurn|catAiMove|searchBestAction|resolveHardLeaf|HARD_LEAF/;
    for (const file of ['src/game/threat/catThreatMap.ts', 'src/components/dangerAssist.ts', 'src/components/Board.tsx']) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must not reach the AI`).not.toMatch(aiTokens);
    }
    expect(readFileSync('src/game/threat/catThreatMap.ts', 'utf8')).not.toMatch(/Math\.random|Date\.now|performance\.now/);
    // 开关本身也只是呈现状态：它连引擎都不碰。
    const aid = readFileSync('src/components/dangerAssist.ts', 'utf8');
    expect(aid).not.toMatch(/from '\.\.\/game\/engine'/);
    // Board 只画上游算好的地图，绝不自己算第二套规则。
    const board = readFileSync('src/components/Board.tsx', 'utf8');
    expect(board).not.toContain('getCatThreatMap');
    expect(board).not.toMatch(/Math\.abs\([^)]*\.[rc]Position/);
  });

  it('开关在桌面与移动两套布局里都存在，且不是引擎动作按钮', () => {
    const board = readFileSync('src/components/Board.tsx', 'utf8');
    expect(board).toMatch(/if \(!isDesktop\)/);                     // 移动端分支
    expect((board.match(/controls\.map/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(board).toMatch(/onClick: toggleDangerAssist/);
    expect(board).toMatch(/showDangerToggle \? \[\{/);
    // 教程不给地图，所以也不给这个按钮（否则会出现一个按下去没反应的开关）。
    expect(readFileSync('src/pages/TutorialPage.tsx', 'utf8')).toContain('showDangerToggle={false}');
  });

  it('GamePage 把真实 gameState 交给唯一的地图来源，且没有旁路', () => {
    const game = readFileSync('src/pages/GamePage.tsx', 'utf8');
    expect(game).toContain('useCatThreatMap(gameState)');
    expect(game.match(/threatMap/g)).toHaveLength(3);               // 声明 + prop 名 + 传值
  });
});
