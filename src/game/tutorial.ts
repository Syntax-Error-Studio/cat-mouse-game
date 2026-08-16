// ============================================================
// 新手教程：脚本化步骤 + 预设地图 + 固定猫路线
// 教程完全脱离 AI：猫按写死的路线行动，玩家按步骤被引导操作。
// ============================================================
import type { GameConfig } from './config';
import { createInitialState } from './engine';
import { CellType, GamePhase } from './types';
import type { Direction } from './types';

export type TutorialGameData = ReturnType<typeof createInitialState>;

export type TutorialStepKind = 'intro' | 'action' | 'observe';

export interface CatOp {
  t: 'move' | 'trap' | 'endTurn';
  dir?: Direction;
}

export interface TutorialStep {
  id: string;
  kind: TutorialStepKind;
  text: string;
  /** action 步：满足条件即视为完成，自动进入下一步 */
  done?: (s: TutorialGameData) => boolean;
  /** observe 步：猫的固定行动脚本 */
  catScript?: CatOp[];
  /** 该步需要的操作提示（显示在面板底部） */
  hint?: string;
  /** 该 action 步鼠是否无限步（显示 +∞，不切猫回合，直到满足条件才进入下一步）。
   *  用于“自由探索/达成条件”的步骤，避免步数耗尽误切猫回合造成割裂感。 */
  infiniteMoves?: boolean;
}

// ---- 地图布局（8x8）----
// 字符: . 空地  B 黄油  H 鼠洞  T 快速通道  X 箱子  P 杂物堆
const LAYOUT_A = [
  '........',
  '..B.....',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........',
];

const LAYOUT_B = [
  '..T.....',
  '..B.....',
  '.X......',
  '........',
  '....P...',
  '........',
  '........',
  '..T....H',
];

const CHAR_MAP: Record<string, CellType> = {
  '.': CellType.Empty,
  B: CellType.ButterSpot,
  H: CellType.MouseHole,
  T: CellType.Tunnel,
  X: CellType.Box,
  P: CellType.Pile,
};

function parseLayout(layout: string[]): CellType[][] {
  return layout.map((row) =>
    row.split('').map((ch) => CHAR_MAP[ch] ?? CellType.Empty),
  );
}

const TUNNEL_CORNERS = [
  { r: 0, c: 2 },
  { r: 7, c: 2 },
];

// 阶段 A：仅地板 + 黄油，无猫/箱/洞/通道（讲解基础）
export const PHASE_A_CONFIG: GameConfig = {
  boardSize: 8,
  mouseHole: { r: 7, c: 7, size: 1 },
  boxCount: 0,
  butterCount: 1,
  mouseStart: { r: 2, c: 3 },
  catStart: { r: 0, c: 0 },
  mouseBaseMoves: 4,
  mouseCarryingMoves: 3,
  mouseSkillExtraMoves: 3,
  catBaseMoves: 3,
  gameMode: 'single',
  difficulty: 'easy',
  customTerrain: parseLayout(LAYOUT_A),
  tunnelCorners: TUNNEL_CORNERS,
};

// 阶段 B：加入猫/箱/杂物堆/通道/鼠洞，进入实战
export const PHASE_B_CONFIG: GameConfig = {
  boardSize: 8,
  mouseHole: { r: 7, c: 7, size: 1 },
  boxCount: 0,
  boxPositions: [{ r: 2, c: 1 }],
  pileCount: 0,
  pilePositions: [{ r: 4, c: 4 }],
  butterCount: 1,
  mouseStart: { r: 2, c: 3 },
  catStart: { r: 2, c: 0 },
  mouseBaseMoves: 4,
  mouseCarryingMoves: 3,
  mouseSkillExtraMoves: 3,
  catBaseMoves: 3,
  gameMode: 'single',
  difficulty: 'easy',
  customTerrain: parseLayout(LAYOUT_B),
  tunnelCorners: TUNNEL_CORNERS,
};

// 黄油刷新点（步骤 11 强制把黄油放到这里，保证脚本可复现）
export const REFRESH_BUTTER_POS = { r: 6, c: 5 };

// 方向常量
const RIGHT: Direction = { key: 'ArrowRight', dr: 0, dc: 1, label: '→' };
const DOWN: Direction = { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' };

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    kind: 'intro',
    text: '欢迎来到猫鼠挑战！🐭 你的目标：捡起 🧈黄油，带着它钻进 🕳️鼠洞就能获胜。先用 ↑↓←→ 方向键自由移动几格热热身吧（步数无限，走一步就继续）！',
    hint: '点击下方「继续」开始',
  },
  {
    id: 'move_practice',
    kind: 'action',
    text: '用方向键移动 🐭（步数无限），随便走几格熟悉手感——动一下就自动进入下一段。',
    hint: '用 ↑ ↓ ← → 移动，走一步即进入下一段',
    done: (s) => !(s.mousePosition.r === 2 && s.mousePosition.c === 3),
    infiniteMoves: true,
  },
  {
    id: 'eat_butter',
    kind: 'action',
    text: '看到 🧈黄油 了吗？走到它身上即可拾取。带着黄油时移动会变慢（每回合仅 3 步），但它正是获胜的关键道具。',
    hint: '走到 🧈黄油 格子上把它捡起来',
    done: (s) => s.mouseHasButter,
    infiniteMoves: true,
  },
  {
    id: 'skill_intro',
    kind: 'intro',
    text: '捡到黄油后，按 空格 可以释放 🔥技能：消耗黄油、立刻获得 +3 步数，并解锁 🌀快速通道 的传送能力——这是你甩开猫的救命招！',
    hint: '点击下方「继续」',
  },
  {
    id: 'use_skill',
    kind: 'action',
    text: '现在试试：按 空格 释放 🔥技能。你会看到步数变多、快速通道被解锁（注意：释放后黄油被消耗，但你能传送了）。',
    hint: '按 空格 键释放技能',
    done: (s) => s.mouseSkillActive,
    infiniteMoves: true,
  },
  {
    id: 'items_intro',
    kind: 'intro',
    text: '认一认道具：📦箱子（猫能推开）、▦杂物堆（固定障碍，谁都过不去）、🪤捕鼠夹（猫会放置来封路）、🌀快速通道（技能激活后才能传送）、🕳️鼠洞（终点）。记住：🐱猫会追你，被抓到就输；带黄油进洞就赢！',
    hint: '点击下方「继续」进入实战',
  },
  {
    id: 'phaseB',
    kind: 'action',
    text: '实战开始！🐱猫登场了，它走固定路线不会乱跑。第一步：去把脚边的 🧈黄油 吃掉，带着它才有胜算。',
    hint: '走到 🧈黄油 格子上把它捡起来',
    done: (s) => s.mouseHasButter,
    infiniteMoves: true,
  },
  {
    id: 'cat_attack',
    kind: 'observe',
    text: '看好了 🐱：猫先推开 📦箱子 逼近你，再在下方布下 🪤捕鼠夹 封路——它离你只差一步！（这一步由猫自动演示，你看着就行）',
    catScript: [
      { t: 'move', dir: RIGHT }, // 推箱 (2,0)->(2,1)，箱到 (2,2)
      { t: 'move', dir: DOWN }, // (2,1)->(3,1)
      { t: 'move', dir: RIGHT }, // (3,1)->(3,2)
      { t: 'trap' }, // 在 (3,2) 放夹
      { t: 'endTurn' },
    ],
  },
  {
    id: 'escape',
    kind: 'action',
    text: '危险！先按 空格 放 🔥技能（消耗黄油、+3 步、解锁通道），再走上左上角的 🌀快速通道 (0,2)，瞬间传送到另一端逃命！注意步数有限，别乱走哦。',
    hint: '先按 空格放技能（+3步），再走上 🌀快速通道 (0,2)（站上即自动传送）',
    done: (s) => s.mousePosition.r === 7 && s.mousePosition.c === 2,
  },
  {
    id: 'cat_return',
    kind: 'observe',
    text: '🐱猫发现你逃了，赶紧往鼠洞方向赶路。它每回合只有 3 步，比你慢，抓紧时间！（自动演示）',
    catScript: [
      { t: 'move', dir: DOWN }, // (3,2)->(4,2)
      { t: 'move', dir: DOWN }, // (4,2)->(5,2)
      { t: 'move', dir: DOWN }, // (5,2)->(6,2)
      { t: 'endTurn' },
    ],
  },
  {
    id: 'eat_again',
    kind: 'action',
    text: '黄油会自动刷新！🧈 新的一块出现在 (6,5)。带着技能冲过去再吃一块——这次我们直接回家！',
    hint: '走到 (6,5) 的 🧈黄油 上再吃一块',
    done: (s) => s.mouseHasButter && s.mousePosition.r === 6 && s.mousePosition.c === 5,
    infiniteMoves: true,
  },
  {
    id: 'cat_chase',
    kind: 'observe',
    text: '🐱猫继续追赶，但它慢了半拍，你已经在鼠洞门口了！（自动演示）',
    catScript: [
      { t: 'move', dir: RIGHT }, // (6,2)->(6,3)
      { t: 'move', dir: RIGHT }, // (6,3)->(6,4)
      { t: 'move', dir: DOWN }, // (6,4)->(7,4)
      { t: 'endTurn' },
    ],
  },
  {
    id: 'win',
    kind: 'action',
    text: '最后一步！带着 🧈黄油 走进 🕳️鼠洞 (7,7)，胜利属于你！🎉',
    hint: '走到 🕳️鼠洞 (7,7) 即可获胜',
    done: (s) => s.phase === GamePhase.MouseWins,
    infiniteMoves: true,
  },
];
