// ============================================================
// 自定义地图定义（编辑器产出）与 GameConfig 的相互转换
// ============================================================

import {
  CellType,
  GameMode,
  type TunnelCorner,
} from './types';
import {
  DEFAULT_CONFIG,
  EDITOR_MAP_MAX_SIZE,
  EDITOR_MAP_MIN_SIZE,
  type GameConfig,
  type MouseHole,
} from './config';

export interface MapPoint {
  r: number;
  c: number;
}

/** 编辑器保存的地图；grid 为地形（不含棋子），起点单独存为字段。 */
export interface MapDefinition {
  id: string;
  version: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  rows: number;
  cols: number;
  /** 地形网格 [r][c]；长度 = rows，每行长度 = cols */
  grid: CellType[][];
  catStart: MapPoint;
  mouseStart: MapPoint;
}

const CURRENT_VERSION = 1;

/** 编辑器可绘制的边长范围（与引擎的正式认证范围无关）。 */
export const MAP_MIN_SIZE = EDITOR_MAP_MIN_SIZE;
export const MAP_MAX_SIZE = EDITOR_MAP_MAX_SIZE;

const VALID_CELL_TYPES: ReadonlySet<string> = new Set<string>(Object.values(CellType));

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 新建一张空地图（全部为地板），默认尺寸 10x10。 */
export function createEmptyMap(name = '未命名地图', rows = 10, cols = 10): MapDefinition {
  const now = new Date().toISOString();
  const grid: CellType[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => CellType.Empty),
  );
  return {
    id: crypto.randomUUID(),
    version: CURRENT_VERSION,
    name,
    createdAt: now,
    updatedAt: now,
    rows,
    cols,
    grid,
    catStart: { r: Math.floor(rows / 2), c: 1 },
    mouseStart: { r: Math.floor(rows / 2), c: cols - 2 },
  };
}

/** 把二维网格补齐为正方形（右侧/底部以 Void 填充），引擎保持正方形棋盘。 */
function padGridToSquare(grid: CellType[][]): CellType[][] {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const S = Math.max(rows, cols);
  const result: CellType[][] = [];
  for (let r = 0; r < S; r++) {
    const row: CellType[] = [];
    for (let c = 0; c < S; c++) {
      row.push(grid[r]?.[c] ?? CellType.Void);
    }
    result.push(row);
  }
  return result;
}

function findCellsOfType(grid: CellType[][], type: CellType): MapPoint[] {
  const out: MapPoint[] = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      if (grid[r][c] === type) out.push({ r, c });
    }
  }
  return out;
}

/**
 * 把编辑器状态读成“确定能用的” rows × cols 地形副本。
 *
 * 只在**结构层面**兜底（缺行/缺列/未知单元格 → 地板），不改变任何已绘制的
 * 地形类型；保存的地图对象本身永不被写回。非法输入由 `validateMap` /
 * `validateCustomMapConfig` 报告并阻止进入游戏。
 */
function readTerrain(map: MapDefinition): { grid: CellType[][]; rows: number; cols: number } {
  const raw = Array.isArray(map.grid) ? map.grid : [];
  const declaredRows = Number.isInteger(map.rows) ? map.rows : raw.length;
  const widest = raw.reduce(
    (m, row) => Math.max(m, Array.isArray(row) ? row.length : 0),
    0,
  );
  const declaredCols = Number.isInteger(map.cols) ? map.cols : widest;
  const rows = Math.max(1, declaredRows);
  const cols = Math.max(1, declaredCols);

  const grid: CellType[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: CellType[] = [];
    const src = raw[r];
    for (let c = 0; c < cols; c++) {
      const t = Array.isArray(src) ? src[c] : undefined;
      row.push(VALID_CELL_TYPES.has(t as string) ? (t as CellType) : CellType.Empty);
    }
    grid.push(row);
  }
  return { grid, rows, cols };
}

function inGrid(p: MapPoint | undefined, rows: number, cols: number): boolean {
  return !!p && Number.isInteger(p.r) && Number.isInteger(p.c)
    && p.r >= 0 && p.r < rows && p.c >= 0 && p.c < cols;
}

function clampPoint(p: MapPoint | undefined, rows: number, cols: number, fallback: MapPoint): MapPoint {
  if (!p || !Number.isFinite(p.r) || !Number.isFinite(p.c)) return { ...fallback };
  return {
    r: clamp(Math.trunc(p.r), 0, rows - 1),
    c: clamp(Math.trunc(p.c), 0, cols - 1),
  };
}

function isBlockingTerrain(t: CellType): boolean {
  return t === CellType.Wall || t === CellType.Pile || t === CellType.Void || t === CellType.Box;
}

const TERRAIN_LABEL: Partial<Record<CellType, string>> = {
  [CellType.Wall]: '墙',
  [CellType.Pile]: '杂物堆',
  [CellType.Void]: '虚空',
  [CellType.Box]: '箱子',
};

// ============================================================
// 校验：结构错误（阻止） / 玩法提示（只提示）
// ============================================================

export interface MapValidation {
  /** true = 结构合法，可以保存与试玩。玩法合理性不影响此值。 */
  ok: boolean;
  /** 结构性问题：数据无法安全解析成棋盘时才会出现。 */
  errors: string[];
  /** 玩法合理性提示：缺鼠洞 / 缺黄油 / 通道未成对 / 起点被围住等，只提示。 */
  warnings: string[];
}

/**
 * 校验一份编辑器地图。
 *
 * 地图编辑器是**自由创作工具**：没有鼠洞、没有黄油、没有通道、全封闭、
 * 无法获胜、形状不规则……都是合法作品，只能提示，不能拦截保存或试玩。
 * 只有“这份数据可能让程序崩溃”的结构问题才返回 ok=false。
 */
export function validateMap(map: MapDefinition): MapValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ---------- 1. 结构：尺寸、网格、单元格、坐标 ----------
  const rows = map.rows;
  const cols = map.cols;
  const sizeOk = Number.isInteger(rows) && Number.isInteger(cols)
    && rows >= MAP_MIN_SIZE && rows <= MAP_MAX_SIZE
    && cols >= MAP_MIN_SIZE && cols <= MAP_MAX_SIZE;
  if (!sizeOk) {
    errors.push(
      `地图尺寸必须是 ${MAP_MIN_SIZE}～${MAP_MAX_SIZE} 之间的整数（当前 ${String(rows)} × ${String(cols)}）。`,
    );
  }

  const gridOk = Array.isArray(map.grid) && Number.isInteger(rows) && Number.isInteger(cols)
    && map.grid.length === rows
    && map.grid.every((row) => Array.isArray(row) && row.length === cols);
  if (!gridOk) {
    errors.push('地图网格与行/列数不一致：请重新打开或重新导入这份地图。');
  }

  if (gridOk) {
    let badCells = 0;
    const samples: string[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!VALID_CELL_TYPES.has(map.grid[r][c] as string)) {
          badCells++;
          if (samples.length < 3) samples.push(`（行 ${r}，列 ${c}：${String(map.grid[r][c])}）`);
        }
      }
    }
    if (badCells > 0) {
      errors.push(`地图中有 ${badCells} 个无法识别的单元格${samples.join('')}。`);
    }
  }

  const startChecks: { label: string; pos: MapPoint | undefined }[] = [
    { label: '猫', pos: map.catStart },
    { label: '鼠', pos: map.mouseStart },
  ];
  for (const { label, pos } of startChecks) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols)) continue;
    if (!inGrid(pos, rows, cols)) {
      errors.push(
        `${label}起点坐标无效：（行 ${pos?.r}，列 ${pos?.c}），`
        + `地图范围是行 0～${rows - 1}、列 0～${cols - 1}。请用「${label}起点」工具重新点一格。`,
      );
    }
  }

  if (errors.length > 0) {
    // 结构已经坏了，再谈“玩法”没有意义。
    return { ok: false, errors, warnings };
  }

  // ---------- 2. 玩法：全部只提示 ----------
  const holes = findCellsOfType(map.grid, CellType.MouseHole);
  const butters = findCellsOfType(map.grid, CellType.ButterSpot);
  const tunnels = findCellsOfType(map.grid, CellType.Tunnel);

  if (holes.length === 0) {
    warnings.push('没有绘制鼠洞：本局鼠无法获胜（不会凭空生成鼠洞），但可以正常试玩。');
  }
  if (butters.length === 0) {
    warnings.push('尚未放置黄油：鼠没有可携带的黄油，通常无法获胜。');
  }

  if (tunnels.length === 1) {
    warnings.push('快速通道只有 1 个：进入后只能留在原地，不会传送到别处。');
  } else if (tunnels.length > 1 && tunnels.length % 2 !== 0) {
    warnings.push('快速通道数量为奇数：部分通道的传送目标会不对称（沿用现有通道规则）。');
  }

  const starts: { label: string; pos: MapPoint }[] = [
    { label: '猫', pos: map.catStart },
    { label: '鼠', pos: map.mouseStart },
  ];
  for (const { label, pos } of starts) {
    const terrain = map.grid[pos.r][pos.c];
    if (isBlockingTerrain(terrain)) {
      warnings.push(
        `${label}起点画在${TERRAIN_LABEL[terrain] ?? '不可通行地形'}上：角色可以走出这一格，但这一格本身仍然不可通行。`,
      );
    }
    const neighbours: MapPoint[] = [
      { r: pos.r - 1, c: pos.c }, { r: pos.r + 1, c: pos.c },
      { r: pos.r, c: pos.c - 1 }, { r: pos.r, c: pos.c + 1 },
    ];
    const canLeave = neighbours.some((n) =>
      inGrid(n, rows, cols) && !isBlockingTerrain(map.grid[n.r][n.c]));
    if (!canLeave) {
      warnings.push(`${label}起点四周没有可通行格子：开局可能立刻判定${label === '猫' ? '猫' : '鼠'}无路可走。`);
    }
  }

  if (map.catStart.r === map.mouseStart.r && map.catStart.c === map.mouseStart.c) {
    warnings.push('猫鼠起点重合：开局即按既有规则“猫鼠同格 = 猫获胜”结算。');
  }

  return { ok: true, errors, warnings };
}

// ============================================================
// 转换：编辑器地图 → 引擎配置
// ============================================================

/**
 * 构建鼠洞区域。
 *
 * - 没有鼠洞 → `size 0` + 空集合，引擎不会凭空生成任何洞格；
 * - 矩形（正方形）鼠洞 → 沿用引擎历史上的 `(r, c, size)` 正方形；
 * - 不规则鼠洞 → 附带**实际绘制**的格子集合（`cells` 为权威判定），
 *   包围盒里的普通地板不会被当成鼠洞。
 */
function buildMouseHole(grid: CellType[][]): MouseHole {
  const cells = findCellsOfType(grid, CellType.MouseHole);
  if (cells.length === 0) {
    return { r: -1, c: -1, size: 0, cells: [] };
  }
  const minR = Math.min(...cells.map((p) => p.r));
  const minC = Math.min(...cells.map((p) => p.c));
  const maxR = Math.max(...cells.map((p) => p.r));
  const maxC = Math.max(...cells.map((p) => p.c));
  const h = maxR - minR + 1;
  const w = maxC - minC + 1;
  const size = Math.max(h, w);
  // 填满自身包围盒的方形鼠洞：与历史语义完全等价，不需要格子集合。
  if (h === w && cells.length === h * w) return { r: minR, c: minC, size };
  return { r: minR, c: minC, size, cells };
}

/**
 * 将地图转换为可直接交给引擎的 GameConfig。
 *
 * 原则：**忠实转换**。不凭空造鼠洞、不造通道、不把起点所在格改写为地板，
 * 也不移动任何棋子；非正方形地图用 Void 补齐（补齐区不可通行且不越界）。
 */
export function mapDefinitionToGameConfig(map: MapDefinition, mode: GameMode): GameConfig {
  const { grid, rows, cols } = readTerrain(map);
  const S = Math.max(rows, cols);
  const customTerrain = padGridToSquare(grid);

  // 通道：地形里画了几个就是几个。一个都没有 → 空数组（明确"没有通道"），
  // 不会回退到四角默认通道。
  const tunnelCells = findCellsOfType(grid, CellType.Tunnel);
  const tunnelCorners: TunnelCorner[] = tunnelCells.map((p, i) => ({
    r: p.r,
    c: p.c,
    label: `通道${i + 1}`,
  }));

  const mouseHole = buildMouseHole(grid);

  const catStart = clampPoint(map.catStart, rows, cols, { r: 0, c: 0 });
  const mouseStart = clampPoint(map.mouseStart, rows, cols, { r: rows - 1, c: cols - 1 });

  return {
    boardSize: S,
    mouseHole,
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart,
    catStart,
    mouseBaseMoves: DEFAULT_CONFIG.mouseBaseMoves,
    mouseCarryingMoves: DEFAULT_CONFIG.mouseCarryingMoves,
    mouseSkillExtraMoves: DEFAULT_CONFIG.mouseSkillExtraMoves,
    catBaseMoves: DEFAULT_CONFIG.catBaseMoves,
    gameMode: mode,
    difficulty: 'easy',
    customTerrain,
    tunnelCorners,
    // 让开局入口只做结构校验：自由地图不参与正式对局的开局契约。
    customMapPlaytest: true,
  };
}
