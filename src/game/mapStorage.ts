// ============================================================
// 自定义地图的本地持久化：localStorage 存储 + JSON 导入/导出
// ============================================================

import { CellType, type GameMode } from './types';
import {
  MAP_MAX_SIZE,
  MAP_MIN_SIZE,
  mapDefinitionToGameConfig,
  type MapDefinition,
  type MapPoint,
} from './mapDefinition';

const STORAGE_KEY = 'catmouse_maps_v1';
const DRAFT_KEY = 'catmouse_map_draft_v1';

function readAll(): MapDefinition[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as MapDefinition[];
  } catch {
    return [];
  }
}

function writeAll(maps: MapDefinition[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(maps));
  } catch (e) {
    console.error('保存地图失败', e);
    throw new Error('保存地图失败：本地存储不可用或已满。');
  }
}

/**
 * 能否安全渲染 / 载入：尺寸在编辑器范围内、grid 与尺寸一致、起点是合法坐标。
 * 只用于“读取时筛掉坏数据”，不会删除存储里的任何东西。
 */
function isRenderableMap(m: unknown): m is MapDefinition {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  const rows = o.rows;
  const cols = o.cols;
  const grid = o.grid;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return false;
  const R = rows as number;
  const C = cols as number;
  if (R < MAP_MIN_SIZE || R > MAP_MAX_SIZE || C < MAP_MIN_SIZE || C > MAP_MAX_SIZE) return false;
  if (!Array.isArray(grid) || grid.length !== R) return false;
  if (!grid.every((row) => Array.isArray(row) && row.length === C)) return false;
  const isPoint = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    const p = v as { r?: unknown; c?: unknown };
    return Number.isInteger(p.r) && Number.isInteger(p.c);
  };
  return isPoint(o.catStart) && isPoint(o.mouseStart);
}

export function listMaps(): MapDefinition[] {
  return readAll().filter(isRenderableMap).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getMap(id: string): MapDefinition | undefined {
  return readAll().find(m => m.id === id);
}

export function saveMap(map: MapDefinition): MapDefinition {
  const maps = readAll();
  const idx = maps.findIndex(m => m.id === map.id);
  const toSave: MapDefinition = { ...map, updatedAt: new Date().toISOString() };
  if (idx >= 0) maps[idx] = toSave;
  else maps.push(toSave);
  writeAll(maps);
  return toSave;
}

export function deleteMap(id: string): void {
  writeAll(readAll().filter(m => m.id !== id));
}

/** 导出为可分享的 JSON 字符串。 */
export function exportMapToString(map: MapDefinition): string {
  return JSON.stringify(map, null, 2);
}

/**
 * 从 JSON 字符串导入一份地图。
 *
 * 结构性问题（不是 JSON / 缺 grid / 行不是数组 / 尺寸超出编辑器范围 /
 * 起点越界）会抛出**明确的中文错误**，由编辑器显示，绝不把半坏的网格塞进
 * 渲染层。轻微问题（未知单元格字符、行长度不一致）就地补成可安全渲染的
 * 地形：未知 → 地板，缺失 → 虚空，不猜测作者的意图。
 */
export function importMapFromString(json: string): MapDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('文件不是有效的 JSON。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('文件格式不正确：顶层必须是一个地图对象。');
  }
  const obj = parsed as Record<string, unknown>;
  const rawGrid = obj.grid;
  if (!Array.isArray(rawGrid) || rawGrid.length === 0) {
    throw new Error('文件格式不正确：缺少 grid 或 grid 为空。');
  }

  const rows = rawGrid.length;
  let cols = 0;
  for (let r = 0; r < rows; r++) {
    const row = rawGrid[r];
    if (!Array.isArray(row)) {
      throw new Error(`文件格式不正确：第 ${r} 行不是数组。`);
    }
    cols = Math.max(cols, row.length);
  }
  if (cols === 0) {
    throw new Error('文件格式不正确：grid 没有任何列。');
  }
  if (rows < MAP_MIN_SIZE || rows > MAP_MAX_SIZE || cols < MAP_MIN_SIZE || cols > MAP_MAX_SIZE) {
    throw new Error(
      `地图尺寸超出编辑器范围：${rows} × ${cols}，`
      + `编辑器只支持 ${MAP_MIN_SIZE}～${MAP_MAX_SIZE} 行/列。`,
    );
  }

  const grid: CellType[][] = [];
  for (let r = 0; r < rows; r++) {
    const src = rawGrid[r] as unknown[];
    const row: CellType[] = [];
    for (let c = 0; c < cols; c++) {
      const t = src[c];
      if (typeof t === 'string' && (Object.values(CellType) as string[]).includes(t)) {
        row.push(t as CellType);
      } else {
        // 短行 = 该位置没有绘制 → 虚空；无法识别的值 → 地板（保持旧行为）。
        row.push(t === undefined ? CellType.Void : CellType.Empty);
      }
    }
    grid.push(row);
  }

  const now = new Date().toISOString();
  const readStart = (key: 'catStart' | 'mouseStart', fallback: MapPoint): MapPoint => {
    const raw = obj[key];
    if (raw === undefined || raw === null) return fallback;
    const p = raw as { r?: unknown; c?: unknown };
    const r = p.r;
    const c = p.c;
    if (!Number.isInteger(r) || !Number.isInteger(c)) {
      throw new Error(`文件格式不正确：${key} 的行/列必须是整数。`);
    }
    if ((r as number) < 0 || (r as number) >= rows || (c as number) < 0 || (c as number) >= cols) {
      throw new Error(
        `文件格式不正确：${key} 越界（行 ${String(r)}，列 ${String(c)}），地图为 ${rows} × ${cols}。`,
      );
    }
    return { r: r as number, c: c as number };
  };

  return {
    id: typeof obj.id === 'string' ? obj.id : crypto.randomUUID(),
    version: typeof obj.version === 'number' ? obj.version : 1,
    name: typeof obj.name === 'string' ? obj.name : '导入的地图',
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
    updatedAt: now,
    rows,
    cols,
    grid,
    catStart: readStart('catStart', { r: Math.floor(rows / 2), c: 1 }),
    mouseStart: readStart('mouseStart', { r: Math.floor(rows / 2), c: cols - 2 }),
  };
}

/** 试玩：把地图转为 GameConfig（默认单人模式）。 */
export function mapToGameConfig(map: MapDefinition, mode: GameMode) {
  return mapDefinitionToGameConfig(map, mode);
}

// ============================================================
// 草稿（自动暂存）：退出编辑器/试玩后仍能找回未保存的编辑成果
// ============================================================

/** 暂存当前编辑中的地图（覆盖式，不计入“已保存列表”）。 */
export function saveDraft(map: MapDefinition): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(map));
  } catch {
    /* 忽略：草稿丢失不应阻断编辑 */
  }
}

/** 读取草稿；没有或草稿已经不可渲染时返回 null。 */
export function loadDraft(): MapDefinition | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    return isRenderableMap(m) ? m : null;
  } catch {
    return null;
  }
}

/** 清空草稿（新建地图或主动放弃时调用）。 */
export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 忽略 */
  }
}
