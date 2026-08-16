// ============================================================
// 自定义地图的本地持久化：localStorage 存储 + JSON 导入/导出
// ============================================================

import { CellType, type GameMode } from './types';
import { mapDefinitionToGameConfig, type MapDefinition } from './mapDefinition';

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

export function listMaps(): MapDefinition[] {
  return readAll().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
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

/** 从 JSON 字符串导入并做基本校验。 */
export function importMapFromString(json: string): MapDefinition {
  const obj = JSON.parse(json);
  if (!obj || !Array.isArray(obj.grid) || typeof obj.rows !== 'number' || typeof obj.cols !== 'number') {
    throw new Error('文件格式不正确：缺少 grid / rows / cols。');
  }
  // 基础字段补全
  const now = new Date().toISOString();
  const safeGrid: CellType[][] = obj.grid.map((row: string[]) =>
    row.map((t: string) => (Object.values(CellType).includes(t as CellType) ? (t as CellType) : CellType.Empty)),
  );
  return {
    id: typeof obj.id === 'string' ? obj.id : crypto.randomUUID(),
    version: typeof obj.version === 'number' ? obj.version : 1,
    name: typeof obj.name === 'string' ? obj.name : '导入的地图',
    createdAt: obj.createdAt ?? now,
    updatedAt: now,
    rows: obj.rows,
    cols: obj.cols,
    grid: safeGrid,
    catStart: obj.catStart ?? { r: Math.floor(obj.rows / 2), c: 1 },
    mouseStart: obj.mouseStart ?? { r: Math.floor(obj.rows / 2), c: obj.cols - 2 },
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

/** 读取草稿；没有则返回 null。 */
export function loadDraft(): MapDefinition | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (!m || !Array.isArray(m.grid) || typeof m.rows !== 'number' || typeof m.cols !== 'number') return null;
    return m as MapDefinition;
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
