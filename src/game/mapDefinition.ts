// ============================================================
// 自定义地图定义（编辑器产出）与 GameConfig 的相互转换
// ============================================================

import {
  CellType,
  GameMode,
  makeTunnelCorners,
  type TunnelCorner,
} from './types';
import { DEFAULT_CONFIG, type GameConfig } from './config';

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

export interface MapValidation {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

/** 校验地图是否可玩（最少需要一个鼠洞、猫和鼠起点）。 */
export function validateMap(map: MapDefinition): MapValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const holes = findCellsOfType(map.grid, CellType.MouseHole);
  if (holes.length === 0) errors.push('缺少鼠洞：请至少绘制一个鼠洞格子。');

  const butters = findCellsOfType(map.grid, CellType.ButterSpot);
  if (butters.length === 0) warnings.push('尚未放置黄油：鼠需要把黄油送回鼠洞才能获胜，建议至少放 1 个。');

  if (!map.catStart) errors.push('缺少猫的起始位置。');
  if (!map.mouseStart) errors.push('缺少鼠的起始位置。');

  const tunnels = findCellsOfType(map.grid, CellType.Tunnel);
  if (tunnels.length === 1) warnings.push('快速通道只有 1 个，传送需要至少 2 个才能生效。');
  if (tunnels.length > 0 && tunnels.length % 2 !== 0) {
    warnings.push('快速通道数量为奇数，部分通道可能无法成对传送。');
  }

  return { ok: errors.length === 0, warnings, errors };
}

/** 将地图转换为可直接交给引擎的 GameConfig。 */
export function mapDefinitionToGameConfig(map: MapDefinition, mode: GameMode): GameConfig {
  const { rows, cols, grid } = map;
  const S = Math.max(rows, cols);
  const customTerrain = padGridToSquare(grid);

  // 通道：从地形中读取所有 Tunnel 单元格
  const tunnelCells = findCellsOfType(grid, CellType.Tunnel);
  const tunnelCorners: TunnelCorner[] = tunnelCells.map((p, i) => ({
    r: p.r,
    c: p.c,
    label: `通道${i + 1}`,
  }));

  // 鼠洞：取所有 MouseHole 单元格的包围盒
  const holeCells = findCellsOfType(grid, CellType.MouseHole);
  let mouseHole: GameConfig['mouseHole'];
  if (holeCells.length > 0) {
    const minR = Math.min(...holeCells.map(p => p.r));
    const minC = Math.min(...holeCells.map(p => p.c));
    const maxR = Math.max(...holeCells.map(p => p.r));
    const maxC = Math.max(...holeCells.map(p => p.c));
    mouseHole = { r: minR, c: minC, size: Math.max(maxR - minR + 1, maxC - minC + 1) };
  } else {
    // 兜底（理论上 validateMap 已经拦截）
    const corners = makeTunnelCorners(S);
    mouseHole = { r: corners[2].r, c: corners[2].c, size: 2 };
  }

  const catStart = {
    r: clamp(map.catStart.r, 0, rows - 1),
    c: clamp(map.catStart.c, 0, cols - 1),
  };
  const mouseStart = {
    r: clamp(map.mouseStart.r, 0, rows - 1),
    c: clamp(map.mouseStart.c, 0, cols - 1),
  };

  // 起点所在格强制为地板，避免起点落在墙/虚空上
  customTerrain[catStart.r][catStart.c] = CellType.Empty;
  customTerrain[mouseStart.r][mouseStart.c] = CellType.Empty;

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
  };
}
