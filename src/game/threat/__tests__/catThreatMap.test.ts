/**
 * G1 — 危险区域正确性契约。
 *
 * 这里证明的不是「实现和昨天一样」，而是「实现就是规则本身」：
 *   1) 每个被标成危险的格子，把它的 witnessPath 用真实 catMove 重放一遍，必须真的走到 CatWins；
 *   2) 每个被标成安全的格子，用一个刻意朴素的暴力枚举（无 visited、无剪枝、无节点上限）
 *      在本回合内找不到任何击杀序列。
 * 两条一起成立，才敢说危险区是规则上的存在性证明，而不是距离启发式。
 */
import { describe, it, expect } from 'vitest';
import { catMove, createInitialState } from '../../engine';
import type { GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GameMode, GamePhase, PieceType } from '../../types';
import type { GameConfig } from '../../config';
import { DEFAULT_CONFIG } from '../../config';
import { getCatThreatMap, buildCatTurnRoot, threatCellAt } from '../catThreatMap';

type Point = { r: number; c: number };

/** 自定义地形：只有空格 + marks 里点名的格子，完全可控、无随机。 */
function makeState(opts: {
  size?: number;
  cat: Point;
  mouse?: Point;
  marks?: Record<string, CellType>;
  budget?: number;
  trap?: Point;
  /** 通道位置；不给就是四角（与 getTunnelCorners 的默认解析一致）。 */
  tunnels?: Point[];
}): GameEngineState {
  const size = opts.size ?? 9;
  const hole = { r: size - 3, c: size - 2, size: 2 };
  const tunnels = opts.tunnels ?? [[0, 0], [0, size - 1], [size - 1, 0], [size - 1, size - 1]]
    .map(([r, c]) => ({ r, c }));
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
  const state = createInitialState(config);
  if (opts.trap) {
    // 等价于猫在自己脚下放过一次陷阱：trapPosition 是唯一事实，地形不变。
    return { ...state, trapPosition: opts.trap, catTrapsRemaining: 0 };
  }
  return state;
}

/** 真实重放：witnessPath 必须一格一格由 catMove 走到 CatWins。 */
function replay(state: GameEngineState, target: Point, path: string[]): GameEngineState {
  let s = buildCatTurnRoot(state, target);
  for (const key of path) {
    const dir = DIRECTIONS.find(d => d.key === key);
    expect(dir, `unknown direction key ${key}`).toBeTruthy();
    const before = s;
    s = catMove(s, dir!);
    expect(s === before, `witness step ${key} was rejected by the engine`).toBe(false);
    if (s.phase === GamePhase.CatWins) return s;
  }
  return s;
}

/**
 * 独立暴力判定：不做任何剪枝、不去重、不设节点上限，只信 catMove。
 * 它是危险区实现的「对照组」——如果两者不一致，错的一定是带优化的那一个。
 */
function oracleCanKill(state: GameEngineState, target: Point): boolean {
  const dfs = (s: GameEngineState): boolean => {
    if (s.catMovesLeft <= 0) return false;
    for (const d of DIRECTIONS) {
      const next = catMove(s, d);
      if (next === s || next.catMovesLeft >= s.catMovesLeft) continue;
      if (next.phase === GamePhase.CatWins) return true;
      if (dfs(next)) return true;
    }
    return false;
  };
  return dfs(buildCatTurnRoot(state, target));
}

const manhattan = (a: Point, b: Point) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c);

/** 通用门禁：危险可重放、安全可反证、unknown 必须为空。 */
function assertMapIsExact(state: GameEngineState, map = getCatThreatMap(state)) {
  expect(map.incomplete).toBe(false);
  expect(map.unknownCells).toEqual([]);

  for (const cell of map.dangerousCells) {
    expect(replay(state, { r: cell.r, c: cell.c }, cell.witnessPath).phase).toBe(GamePhase.CatWins);
    expect(cell.minimumSteps).toBeLessThanOrEqual(map.budget);
    // BFS 逐层推进 ⇒ 第一个目击就是最短击杀
    expect(replay(state, { r: cell.r, c: cell.c }, cell.witnessPath.slice(0, cell.minimumSteps - 1)).phase)
      .not.toBe(GamePhase.CatWins);
  }

  for (const cell of map.safeCells) {
    if (manhattan(state.catPosition, cell) > map.budget) continue; // 距离就已经出局，无需暴搜
    expect(oracleCanKill(state, cell), `safe cell (${cell.r},${cell.c}) is actually killable`).toBe(false);
  }
}

describe('危险区域 — 空棋盘', () => {
  const state = makeState({ cat: { r: 4, c: 4 }, budget: 4 });
  const map = getCatThreatMap(state);

  it('把猫周围可达的格子全部标为危险', () => {
    expect(threatCellAt(map, 4, 5)).toMatchObject({ minimumSteps: 1, witnessPath: ['ArrowRight'] });
    expect(threatCellAt(map, 4, 6)?.minimumSteps).toBe(2);
    expect(threatCellAt(map, 2, 4)?.minimumSteps).toBe(2);
    expect(threatCellAt(map, 4, 8)?.minimumSteps).toBe(4);
  });

  it('超出整回合步数预算的格子安全', () => {
    // (0,4) 距猫正好 4 步 = 预算 ⇒ 危险；(0,2) 是 6 步 > 预算 ⇒ 不搜索也为安全。
    expect(threatCellAt(map, 0, 4)?.minimumSteps).toBe(4);
    expect(threatCellAt(map, 0, 2)).toBeNull();
    expect(map.safeCells).toContainEqual({ r: 0, c: 2 });
  });

  it('每一格都被判定过，且没有一格被预算卡成 unknown', () => {
    expect(map.dangerousCells.length + map.safeCells.length).toBe(
      // 9x9 = 81，扣掉猫自己那一格
      80,
    );
    assertMapIsExact(state, map);
  });
});

describe('危险区域 — 阻挡物', () => {
  it('墙改变最短击杀，而不是曼哈顿距离', () => {
    // 第 6 列被墙截断，只能从上下两端绕。
    const marks = { '3,6': CellType.Wall, '4,6': CellType.Wall, '5,6': CellType.Wall };
    const state = makeState({ cat: { r: 4, c: 4 }, marks, budget: 8 });
    const map = getCatThreatMap(state);
    // (4,8) 的曼哈顿距离是 4，真实最短路是 8。
    expect(manhattan(state.catPosition, { r: 4, c: 8 })).toBe(4);
    expect(threatCellAt(map, 4, 8)?.minimumSteps).toBe(8);
    assertMapIsExact(state, map);

    const tight = getCatThreatMap({ ...state, config: { ...state.config, catBaseMoves: 7 } });
    expect(threatCellAt(tight, 4, 8)).toBeNull();
  });

  it('杂物堆不可推动，猫只能绕行', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, marks: { '4,5': CellType.Pile }, budget: 2 });
    const map = getCatThreatMap(state);
    expect(threatCellAt(map, 4, 6)).toBeNull(); // 曼哈顿 2，但被桩子堵死
    const wide = getCatThreatMap({ ...state, config: { ...state.config, catBaseMoves: 4 } });
    expect(threatCellAt(wide, 4, 6)?.minimumSteps).toBe(4);
    assertMapIsExact(state, map);
    assertMapIsExact({ ...state, config: { ...state.config, catBaseMoves: 4 } }, wide);
  });

  it('箱子挡路，但可以推开后继续追', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, marks: { '4,5': CellType.Box }, budget: 4 });
    const short = getCatThreatMap(state);
    expect(threatCellAt(short, 4, 7)).toBeNull(); // 推+绕最短是 5 步
    const long = getCatThreatMap({ ...state, config: { ...state.config, catBaseMoves: 5 } });
    expect(threatCellAt(long, 4, 7)?.minimumSteps).toBe(5);
    assertMapIsExact(state, short);
    assertMapIsExact({ ...state, config: { ...state.config, catBaseMoves: 5 } }, long);
  });

  it('绝不把箱子推到老鼠身上 — 走廊里箱子就是死墙', () => {
    const marks: Record<string, CellType> = { '4,4': CellType.Box };
    for (let c = 3; c <= 8; c++) {
      marks[`3,${c}`] = CellType.Wall;
      marks[`5,${c}`] = CellType.Wall;
    }
    const state = makeState({ cat: { r: 4, c: 2 }, marks, budget: 8 });
    const map = getCatThreatMap(state);
    // 唯一的通路是走廊本身：想把箱子推进 (4,5) 就等于推到老鼠身上，规则禁止。
    expect(threatCellAt(map, 4, 5)).toBeNull();
    expect(threatCellAt(map, 4, 6)).toBeNull();
    expect(oracleCanKill(state, { r: 4, c: 5 })).toBe(false);
    // 同一张图上，箱子之前的格子照旧危险 —— 安全结论不是「全都算不出来」。
    expect(threatCellAt(map, 4, 3)?.minimumSteps).toBe(1);
    assertMapIsExact(state, map);
  });

  it('黄油不可穿越，但可绕过', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, marks: { '4,5': CellType.ButterSpot }, budget: 2 });
    const short = getCatThreatMap(state);
    expect(threatCellAt(short, 4, 6)).toBeNull();
    const long = getCatThreatMap({ ...state, config: { ...state.config, catBaseMoves: 4 } });
    expect(threatCellAt(long, 4, 6)?.minimumSteps).toBe(4);
    assertMapIsExact(state, short);
    assertMapIsExact({ ...state, config: { ...state.config, catBaseMoves: 4 } }, long);
  });
});

describe('危险区域 — 猫不能进的格子', () => {
  it('鼠洞保护老鼠', () => {
    const state = makeState({ cat: { r: 6, c: 6 }, budget: 2 });
    const map = getCatThreatMap(state);
    // 洞口 (6,7) 与猫只差一步，猫依然进不去。
    expect(manhattan(state.catPosition, { r: 6, c: 7 })).toBe(1);
    expect(threatCellAt(map, 6, 7)).toBeNull();
    expect(threatCellAt(map, 7, 8)).toBeNull();
    // 洞外的格子照旧危险。
    expect(threatCellAt(map, 5, 7)?.minimumSteps).toBe(2);
    assertMapIsExact(state, map);
  });

  it('四角快速通道对猫是禁地', () => {
    const state = makeState({ cat: { r: 1, c: 1 }, budget: 4 });
    const map = getCatThreatMap(state);
    expect(manhattan(state.catPosition, { r: 0, c: 0 })).toBe(2);
    expect(threatCellAt(map, 0, 0)).toBeNull();
    expect(threatCellAt(map, 0, 1)?.minimumSteps).toBe(1);
    assertMapIsExact(state, map);
  });

  it('虚空同样封路（编辑器地图）', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, marks: { '4,5': CellType.Void }, budget: 2 });
    const map = getCatThreatMap(state);
    expect(threatCellAt(map, 4, 6)).toBeNull();
    assertMapIsExact(state, map);
  });
});

describe('危险区域 — 陷阱与边界', () => {
  it('猫踩过自己的陷阱把它收回来，追捕不中断', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, trap: { r: 4, c: 5 }, budget: 2 });
    const map = getCatThreatMap(state);
    const cell = threatCellAt(map, 4, 6);
    expect(cell?.minimumSteps).toBe(2);
    // 重放 witnessPath 后陷阱真的被收回来了。
    const after = replay(state, { r: 4, c: 6 }, cell!.witnessPath);
    expect(after.trapPosition).toBeNull();
    expect(after.catTrapsRemaining).toBe(1);
    assertMapIsExact(state, map);
  });

  it('陷阱不会替猫开门', () => {
    // 陷阱本身不挡猫，但堆在通道上的箱子仍然挡。
    const state = makeState({
      cat: { r: 1, c: 1 },
      trap: { r: 0, c: 1 },
      budget: 4,
    });
    const map = getCatThreatMap(state);
    expect(threatCellAt(map, 0, 0)).toBeNull(); // 通道
    expect(threatCellAt(map, 0, 1)?.minimumSteps).toBe(1); // 陷阱格可以踩过去
    assertMapIsExact(state, map);
  });

  it('边界上的猫只有三个方向，判定依然精确', () => {
    const state = makeState({ cat: { r: 0, c: 4 }, budget: 3 });
    const map = getCatThreatMap(state);
    expect(threatCellAt(map, 0, 6)?.minimumSteps).toBe(2);
    expect(threatCellAt(map, 0, 8)).toBeNull(); // 右上角通道
    for (const cell of map.dangerousCells) {
      expect(cell.r).toBeGreaterThanOrEqual(0);
      expect(cell.r).toBeLessThan(9);
      expect(cell.c).toBeGreaterThanOrEqual(0);
      expect(cell.c).toBeLessThan(9);
    }
    assertMapIsExact(state, map);
  });

  it('角落里的猫被边角与鼠洞限制', () => {
    // 真·右下角放猫：把唯一的通道挪到左上角，地形与 config 同步改。
    const state = makeState({ cat: { r: 8, c: 8 }, budget: 3, tunnels: [{ r: 0, c: 0 }] });
    const map = getCatThreatMap(state);
    expect(threatCellAt(map, 8, 6)?.minimumSteps).toBe(2); // 沿边线追击
    expect(threatCellAt(map, 6, 8)).toBeNull();            // 鼠洞格：距猫 2 步也进不去
    expect(threatCellAt(map, 5, 8)).toBeNull();            // 直线 3 步，但鼠洞逼出长绕路
    assertMapIsExact(state, map);

    const wideState = { ...state, config: { ...state.config, catBaseMoves: 7 } };
    const wide = getCatThreatMap(wideState);
    expect(threatCellAt(wide, 5, 8)?.minimumSteps).toBe(7); // 绕开鼠洞的最短击杀
    for (const cell of wide.dangerousCells) {
      expect(replay(wideState, { r: cell.r, c: cell.c }, cell.witnessPath).phase).toBe(GamePhase.CatWins);
    }
  });
});

describe('危险区域 — 不同棋盘尺寸', () => {
  /**
   * 取距猫恰好 d 步、且不是通道/鼠洞的一格。小棋盘上未必存在（5x5 里离中心最远
   * 也只有 4 步），所以 d=5 时可能返回 null —— 那是几何事实，不是漏判。
   */
  function cellAtDistance(state: GameEngineState, from: Point, d: number): Point | null {
    for (let dr = -d; dr <= d; dr++) {
      const dc = d - Math.abs(dr);
      for (const c of dc === 0 ? [from.c] : [from.c - dc, from.c + dc]) {
        const r = from.r + dr;
        const cell = state.board[r]?.[c];
        if (!cell) continue;
        if (cell.type === CellType.Tunnel || cell.type === CellType.MouseHole) continue;
        return { r, c };
      }
    }
    return null;
  }

  it.each([5, 7, 9, 13, 20])('%i 见方的棋盘都能算完且没有 unknown', size => {
    const mid = { r: Math.floor(size / 2), c: Math.floor(size / 2) };
    const state = makeState({ size, cat: mid, budget: 4 });
    const map = getCatThreatMap(state);
    expect(map.budget).toBe(4);
    expect(map.incomplete).toBe(false);
    expect(map.unknownCells).toEqual([]);

    const near = cellAtDistance(state, mid, 2);
    expect(near, `${size}x${size} 上应有距猫 2 步的空格`).not.toBeNull();
    expect(threatCellAt(map, near!.r, near!.c)?.minimumSteps).toBe(2);

    const far = cellAtDistance(state, mid, 5);
    if (far) expect(threatCellAt(map, far.r, far.c), `距猫 5 步 > 预算 4`).toBeNull();

    assertMapIsExact(state, map);
  });

  it('13x13 以上不会因为格子多而漏判', () => {
    const state = makeState({ size: 16, cat: { r: 8, c: 8 }, budget: 4 });
    const map = getCatThreatMap(state);
    const total = map.dangerousCells.length + map.safeCells.length + map.unknownCells.length;
    // 16x16 = 256，扣掉猫自己那一格
    expect(total).toBe(255);
    assertMapIsExact(state, map);
  });
});

describe('危险区域 — 真实对局状态', () => {
  /**
   * 前面用的是自己拼的地形；这里换成 engine 真实生成的随机开局（有箱子、杂物堆、
   * 黄油、四角通道、鼠洞），确认危险区吃的是同一份 GameEngineState，
   * 而不是只对测试地形成立。随机不影响门禁：门禁本身就是「对任意状态都为真」的命题。
   */
  it.each([10, 12, 15])('%i 见方随机开局满足同一门禁', size => {
    const state = createInitialState({
      ...DEFAULT_CONFIG,
      boardSize: size,
      mouseHole: { r: size - 3, c: size - 2, size: 2 },
      mouseStart: { r: size - 3, c: size - 2 },
      gameMode: GameMode.Dual,
    });
    const map = getCatThreatMap(state);
    expect(map.dangerousCells.length + map.safeCells.length + map.unknownCells.length)
      .toBeGreaterThan(0);
    assertMapIsExact(state, map);
  });

  it('黄油格对猫是禁地，随机地图上也一样', () => {
    const state = createInitialState({ ...DEFAULT_CONFIG, gameMode: GameMode.Dual });
    expect(state.butterPositions.length).toBeGreaterThan(0);
    const map = getCatThreatMap(state);
    // 黄油不可被猫穿越；幽灵黄油要到猫的回合结束才落地，所以这份黄油集合是冻结的。
    for (const b of state.butterPositions) {
      expect(threatCellAt(map, b.r, b.c), `(${b.r},${b.c}) 上有黄油，猫进不去`).toBeNull();
    }
    assertMapIsExact(state, map);
  });
});

describe('危险区域 — 节点上限与契约字段', () => {
  it('预算极小时只有紧邻格危险，且仍然可重放', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, budget: 1 });
    const map = getCatThreatMap(state);
    expect(map.dangerousCells).toHaveLength(4); // 上下左右
    assertMapIsExact(state, map);
  });

  it('node 上限被打满时如实报告 unknown，而不是偷偷说安全', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, budget: 8 });
    const map = getCatThreatMap(state, { maxNodesPerCell: 1 });
    expect(map.incomplete).toBe(true);
    expect(map.unknownCells.length).toBeGreaterThan(0);
    // 允许误报危险（目击仍要能重放），但绝不把没算完的格子塞进 safeCells。
    const far = { r: 0, c: 4 };
    expect(map.safeCells).not.toContainEqual(far);
    for (const cell of map.dangerousCells) {
      expect(replay(state, { r: cell.r, c: cell.c }, cell.witnessPath).phase).toBe(GamePhase.CatWins);
    }
  });

  it('纯函数：同一状态两次结果一致，且不改动输入状态', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, marks: { '4,5': CellType.Box }, budget: 4 });
    const before = JSON.stringify(state);
    const a = getCatThreatMap(state);
    const b = getCatThreatMap(state);
    expect(a).toEqual(b);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('区分普通危险格与老鼠当前所在的必死格', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, mouse: { r: 4, c: 6 }, budget: 4 });
    const map = getCatThreatMap(state);
    expect(map.mouseCell).toMatchObject({ r: 4, c: 6, minimumSteps: 2 });
    const safeMouse = makeState({ cat: { r: 4, c: 4 }, mouse: { r: 0, c: 4 }, budget: 2 });
    expect(getCatThreatMap(safeMouse).mouseCell).toBeNull();
  });

  it('猫的回合中途按剩余步数计算', () => {
    const state = makeState({ cat: { r: 4, c: 4 }, budget: 4 });
    const midTurn = { ...state, currentPlayer: PieceType.Cat, phase: GamePhase.Playing, catMovesLeft: 1 };
    const map = getCatThreatMap(midTurn);
    expect(map.budget).toBe(1);
    expect(threatCellAt(map, 4, 5)?.minimumSteps).toBe(1);
    expect(threatCellAt(map, 4, 6)).toBeNull();
  });
});
