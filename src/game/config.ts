// ============================================================
// Game configuration — all tunable parameters
// 可配置的游戏参数：棋盘大小、箱子数、黄油数、起点位置等
// ============================================================

import type { GameMode, Difficulty, CellType } from './types';

export interface GameConfig {
  boardSize: number;
  mouseHole: { r: number; c: number; size: number };
  boxCount: number;
  boxPositions?: { r: number; c: number }[]; // 若提供则忽略 boxCount
  pileCount?: number;                         // 杂货堆数量
  pilePositions?: { r: number; c: number }[]; // 若提供则忽略 pileCount
  butterCount: number;
  butterPositions?: { r: number; c: number }[]; // 若提供则使用固定黄油位置
  mouseStart: { r: number; c: number };
  catStart: { r: number; c: number };
  mouseBaseMoves: number;
  mouseCarryingMoves: number;
  mouseSkillExtraMoves: number;
  catBaseMoves: number;
  gameMode: GameMode;
  difficulty: Difficulty;
  // --- 自定义地图（编辑器产出）---
  customTerrain?: CellType[][];               // 若提供，直接作为棋盘（已含 箱/桩/通道/鼠洞/虚空），跳过随机生成
  tunnelCorners?: { r: number; c: number; label?: string }[]; // 自定义通道位置；空数组=无通道
}

export const DEFAULT_CONFIG: GameConfig = {
  boardSize: 10,
  mouseHole: { r: 7, c: 8, size: 2 },
  boxCount: 12,
  pileCount: 4,
  butterCount: 2,
  mouseStart: { r: 7, c: 8 }, // 鼠洞左上角
  catStart: { r: 1, c: 1 },
  mouseBaseMoves: 4,
  mouseCarryingMoves: 3,
  mouseSkillExtraMoves: 3,
  catBaseMoves: 4,
  gameMode: 'single',
  difficulty: 'easy',
};

/** Generate box positions randomly, avoiding special cells */
export function generateBoxPositions(
  count: number,
  boardSize: number,
  tunnelCorners: { r: number; c: number }[],
  mouseHole: { r: number; c: number; size: number },
  mouseStart: { r: number; c: number },
  catStart: { r: number; c: number },
  pilePositions?: { r: number; c: number }[],
): { r: number; c: number }[] {
  const positions: { r: number; c: number }[] = [];
  const occupied = new Set<string>();

  // Mark excluded cells
  for (const tc of tunnelCorners) occupied.add(`${tc.r},${tc.c}`);
  for (let dr = 0; dr < mouseHole.size; dr++) {
    for (let dc = 0; dc < mouseHole.size; dc++) {
      occupied.add(`${mouseHole.r + dr},${mouseHole.c + dc}`);
    }
  }
  occupied.add(`${mouseStart.r},${mouseStart.c}`);
  occupied.add(`${catStart.r},${catStart.c}`);
  if (pilePositions) {
    for (const p of pilePositions) occupied.add(`${p.r},${p.c}`);
  }

  const rand = () => Math.floor(Math.random() * (boardSize - 2)) + 1;

  let attempts = 0;
  while (positions.length < count && attempts++ < count * 50) {
    const r = rand();
    const c = rand();
    const key = `${r},${c}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    positions.push({ r, c });
  }

  return positions;
}
