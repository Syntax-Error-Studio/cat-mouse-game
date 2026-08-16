// ============================================================
// Core types and constants for 小猫小鼠 (Cat & Mouse!)
// 参考 C# 原型设计的玩法：步数制移动 + 技能系统 + 四角传送
// ============================================================

// --- Board size (now read from config, kept for backward compat) ---
export const BOARD_SIZE = 10;

// --- Cell types (terrain) ---
export const CellType = {
  Empty: 'empty',
  Box: 'box',
  Trap: 'trap',
  Tunnel: 'tunnel',        // 四角传送通道
  MouseHole: 'mouse_hole', // 鼠洞（胜利目标）
  ButterSpot: 'butter_spot',
  Pile: 'pile',           // 杂货堆 — 固定障碍物
  Wall: 'wall',           // 墙 — 固定障碍物（编辑器绘制，与 Pile 行为一致但视觉不同）
  Void: 'void',           // 虚空 / 地图之外 — 不可通行，编辑器可自由绘制
} as const;
export type CellType = (typeof CellType)[keyof typeof CellType];

// --- Pieces ---
export const PieceType = {
  Cat: 'cat',
  Mouse: 'mouse',
} as const;
export type PieceType = (typeof PieceType)[keyof typeof PieceType];

// --- Game phase ---
export const GamePhase = {
  Playing: 'playing',
  CatWins: 'cat_wins',
  MouseWins: 'mouse_wins',
  ChoosingTunnelExit: 'choosing_tunnel_exit',
} as const;
export type GamePhase = (typeof GamePhase)[keyof typeof GamePhase];

// --- Tunnel corners (4 corners of the board) ---
export type TunnelCorner = {
  r: number;
  c: number;
  label: string; // "左上" "右上" "左下" "右下"
};

/** Generate tunnel corners based on board size */
export function makeTunnelCorners(boardSize: number): TunnelCorner[] {
  return [
    { r: 0, c: 0, label: '左上' },
    { r: 0, c: boardSize - 1, label: '右上' },
    { r: boardSize - 1, c: 0, label: '左下' },
    { r: boardSize - 1, c: boardSize - 1, label: '右下' },
  ];
}

// Default tunnel corners for backward compatibility
export const TUNNEL_CORNERS = makeTunnelCorners(BOARD_SIZE);

// --- Mouse hole position (defaults, overridden by config at runtime) ---
export const MOUSE_HOLE = { r: 7, c: 8, size: 2 };

// --- Movement directions ---
export const DIRECTIONS = [
  { key: 'ArrowUp', dr: -1, dc: 0, label: '↑' },
  { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' },
  { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' },
  { key: 'ArrowRight', dr: 0, dc: 1, label: '→' },
];

export type Direction = (typeof DIRECTIONS)[number];

// --- Game mode ---
export const GameMode = {
  Single: 'single',       // Human mouse vs AI cat
  Dual: 'dual',           // Human mouse + Human cat (local co-op)
} as const;
export type GameMode = (typeof GameMode)[keyof typeof GameMode];

// --- AI Difficulty ---
export const Difficulty = {
  Easy: 'easy',           // BFS pathfinding, low aggression, avoids tunnels
  Medium: 'medium',       // BFS pathfinding, moderate aggression, blocks tunnels
  Hard: 'hard',           // BFS pathfinding, high aggression, predicts mouse behavior
} as const;
export type Difficulty = (typeof Difficulty)[keyof typeof Difficulty];

// --- Player stats (defaults, overridden by config at runtime) ---
export const MOUSE_BASE_MOVES = 4;   // 鼠每回合基础步数
export const MOUSE_CARRYING_MOVES = 3; // 鼠带黄油时每回合步数
export const MOUSE_SKILL_EXTRA_MOVES = 3; // 技能额外步数
export const CAT_BASE_MOVES = 4;     // 猫每回合基础步数
