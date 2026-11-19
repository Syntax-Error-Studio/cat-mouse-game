// ============================================================
// Game configuration — all tunable parameters
// 可配置的游戏参数：棋盘大小、箱子数、黄油数、起点位置等
// ============================================================

import type { GameMode, Difficulty, CellType } from './types';
import { CellType as Cell, makeTunnelCorners } from './types';
// `ai/planBound` has no runtime imports (its only import is a type), so this
// edge does not create a module cycle: config is still loadable on its own.
import { MAX_CERTIFIABLE_CAT_MOVE_BUDGET } from './ai/planBound';

/** Board sizes the formal opening path supports (RULE-B certifier range). */
export const BOARD_SIZE_MIN = 5;
export const BOARD_SIZE_MAX = 20;

/**
 * Board sizes the MAP EDITOR can produce. A free-form editor map is not a
 * formal generated opening, so it is not bound by the certified range above;
 * these bounds are the editor's own drawing surface (one non-square side is
 * padded with Void up to `max(rows, cols)`).
 */
export const EDITOR_MAP_MIN_SIZE = 4;
export const EDITOR_MAP_MAX_SIZE = 24;

/**
 * Mouse-hole region.
 *
 * Formal configs describe the hole with the axis-aligned SQUARE `(r, c, size)`
 * the engine has always used. Editor maps may draw ANY shape, so they may also
 * carry the exact cell list; when `cells` is present it is AUTHORITATIVE and
 * `r/c/size` are only the bounding box (kept for heuristics and logs).
 *
 * `size === 0` together with `cells: []` means "this map has NO mouse hole":
 * the mouse then simply has no way to win. Such a map must never be given a
 * fabricated hole — that would change movement/victory semantics.
 */
export interface MouseHole {
  r: number;
  c: number;
  size: number;
  cells?: { r: number; c: number }[];
}

export interface GameConfig {
  boardSize: number;
  mouseHole: MouseHole;
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
  /**
   * 编辑器「试玩」专用标记。它只切换**开局结构校验**（见
   * `validateCustomMapConfig`）：自由地图不要求“标准对局布局”，但仍然必须是
   * 可安全解析的结构。正式对局 / 教程 / 关卡永远不会携带此标记，因此
   * `validateGameConfig` 的冻结契约逐字不变。
   */
  customMapPlaytest?: boolean;
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

/**
 * Gameplay ruleset version (not an AI strength version).
 *  - 1: before RULE-A/RULE-B (no no-move loss, static-distance initial butter).
 *  - 2: RULE-A no-legal-spatial-move loss + RULE-B bounded initial-butter
 *       fairness certification (finite horizon, see GAMEPLAY.md §10).
 */
export const GAMEPLAY_RULESET_VERSION = 2;

export interface DefaultLayout {
  mouseHole: { r: number; c: number; size: number };
  mouseStart: { r: number; c: number };
  catStart: { r: number; c: number };
}

/**
 * The ONE deterministic default layout for a board size. At size 10 it is
 * exactly `DEFAULT_CONFIG`'s hole/start block, so existing 10×10 behaviour is
 * unchanged. The hole keeps its 2×2 size (never shrinks) and its full region
 * stays inside the board for every supported size 5…20.
 */
export function deriveDefaultLayout(boardSize: number): DefaultLayout {
  const hole = { r: boardSize - 3, c: boardSize - 2, size: 2 };
  return {
    mouseHole: hole,
    mouseStart: { r: hole.r, c: hole.c },
    catStart: { r: 1, c: 1 },
  };
}

function samePoint(a: { r: number; c: number }, b: { r: number; c: number }): boolean {
  return a.r === b.r && a.c === b.c;
}

/** True only when hole and starts are still untouched derived defaults. */
export function isDerivedDefaultLayout(
  config: Pick<GameConfig, 'boardSize' | 'mouseHole' | 'mouseStart' | 'catStart'>,
): boolean {
  const d = deriveDefaultLayout(config.boardSize);
  return samePoint(config.mouseHole, d.mouseHole)
    && config.mouseHole.size === d.mouseHole.size
    && samePoint(config.mouseStart, d.mouseStart)
    && samePoint(config.catStart, d.catStart);
}

/**
 * Change board size, re-deriving hole/starts ONLY when the layout is still the
 * previous size's untouched default. Player-explicit coordinates are never
 * rewritten; an invalid result is rejected later by `validateGameConfig`.
 */
export function withBoardSize(config: GameConfig, boardSize: number): GameConfig {
  const next: GameConfig = { ...config, boardSize };
  const supported = Number.isInteger(boardSize)
    && boardSize >= BOARD_SIZE_MIN
    && boardSize <= BOARD_SIZE_MAX;
  if (!supported || !isDerivedDefaultLayout(config)) return next;
  const d = deriveDefaultLayout(boardSize);
  return { ...next, ...d };
}

/**
 * Change the hole. A mouse start still sitting on the old hole top-left is the
 * derived default and follows the hole; any other start is left untouched.
 */
export function withMouseHole(
  config: GameConfig,
  mouseHole: GameConfig['mouseHole'],
): GameConfig {
  const next: GameConfig = { ...config, mouseHole };
  if (samePoint(config.mouseStart, config.mouseHole)) {
    next.mouseStart = { r: mouseHole.r, c: mouseHole.c };
  }
  return next;
}

export type ConfigIssueKind = 'unsupported' | 'invalid';

export interface ConfigIssue {
  /** `unsupported`: outside the certified range; `invalid`: malformed layout. */
  kind: ConfigIssueKind;
  message: string;
}

export interface GameConfigValidation {
  ok: boolean;
  issues: ConfigIssue[];
}

const BLOCKING_TERRAIN: CellType[] = [Cell.Void, Cell.Wall, Cell.Box, Cell.Pile];

/**
 * Structural validation of a config BEFORE any state is built. Every error is
 * actionable and in player-facing Chinese; validation never mutates the config
 * (explicit coordinates are rejected, not silently moved).
 */
export function validateGameConfig(config: GameConfig): GameConfigValidation {
  const issues: ConfigIssue[] = [];
  const S = config.boardSize;

  if (!Number.isInteger(S) || S < BOARD_SIZE_MIN || S > BOARD_SIZE_MAX) {
    // Bounds messages would be meaningless noise here; one clear size message.
    issues.push({
      kind: 'unsupported',
      message: `棋盘大小必须是 ${BOARD_SIZE_MIN}～${BOARD_SIZE_MAX} 之间的整数（当前 ${String(S)}）。`,
    });
    return { ok: false, issues };
  }

  // PPC-P1-CLOSURE-FIX-01 — cat move budget input domain.
  //
  // A cat turn is a discrete sequence of unit-cost moves, so `catBaseMoves` is a
  // count, not a quantity: it seeds `catMovesLeft`, which `catMove` only ever
  // decrements by 1 and compares against 0. A fractional / non-finite / negative
  // value therefore cannot represent a legal turn (2.5 lets a third step through
  // and then hands off with a negative budget; NaN never compares <= 0, so the
  // turn never ends), and 0 would start a turn the cat can never act in.
  //
  // It is validated here, in the ONE structural gate `createGameState` already
  // runs before any state exists, so a formal match fails closed
  // (`state: null`, `status.kind === 'unverified'`) instead of playing a state
  // whose budget no extractor can certify.
  //
  // PPC-P1-CHECKPOINT-01 — representability upper end. A safe integer is still
  // not automatically usable: the plan bound `M + 1 + floor(M/2)` must also be an
  // exact integer, which stops at `MAX_CERTIFIABLE_CAT_MOVE_BUDGET`. That number
  // is derived from `Number.MAX_SAFE_INTEGER` (see `ai/planBound.ts`), never a
  // gameplay constant, and the gate lives here for the same reason as the rest of
  // the domain: a config that cannot be represented must not become a match.
  const catBaseMoves = config.catBaseMoves as number;
  if (!Number.isSafeInteger(catBaseMoves) || catBaseMoves < 1) {
    issues.push({
      kind: 'invalid',
      message: `猫每回合的基础步数必须是不小于 1 的整数（当前 ${String(catBaseMoves)}）。`,
    });
  } else if (catBaseMoves > MAX_CERTIFIABLE_CAT_MOVE_BUDGET) {
    issues.push({
      kind: 'invalid',
      message: `猫每回合的基础步数过大：计划上界 catBaseMoves + 1 + floor(catBaseMoves/2) 必须是可精确表示的整数，`
        + `因此上限为 ${MAX_CERTIFIABLE_CAT_MOVE_BUDGET}（当前 ${String(catBaseMoves)}）。`,
    });
  }

  const inBounds = (p: { r: number; c: number } | undefined): boolean =>
    !!p && Number.isInteger(p.r) && Number.isInteger(p.c)
    && p.r >= 0 && p.r < S && p.c >= 0 && p.c < S;

  const hole = config.mouseHole;
  let holeOk = false;
  if (!hole || !Number.isInteger(hole.r) || !Number.isInteger(hole.c)
    || !Number.isInteger(hole.size) || hole.size < 1) {
    issues.push({
      kind: 'invalid',
      message: '鼠洞配置无效：行、列、大小都必须是整数，且大小至少为 1。',
    });
  } else {
    holeOk = true;
    if (hole.r < 0 || hole.c < 0
      || hole.r + hole.size > S || hole.c + hole.size > S) {
      holeOk = false;
      issues.push({
        kind: 'invalid',
        message: `鼠洞区域越界：左上角为（行 ${hole.r}，列 ${hole.c}），大小 ${hole.size}，`
          + `完整区域需要行 ${hole.r}～${hole.r + hole.size - 1}、列 ${hole.c}～${hole.c + hole.size - 1}，`
          + `但棋盘只有 ${S}×${S}。请调小鼠洞行/列或增大棋盘。`,
      });
    }
  }
  const insideHole = (p: { r: number; c: number }): boolean =>
    holeOk && p.r >= hole.r && p.r < hole.r + hole.size
    && p.c >= hole.c && p.c < hole.c + hole.size;

  const starts = [
    { label: '鼠', pos: config.mouseStart, insideHoleOk: true },
    { label: '猫', pos: config.catStart, insideHoleOk: false },
  ] as const;
  for (const { label, pos, insideHoleOk } of starts) {
    if (!inBounds(pos)) {
      issues.push({
        kind: 'invalid',
        message: `${label}的初始位置越界：（行 ${pos?.r}，列 ${pos?.c}），`
          + `棋盘范围是 0～${S - 1}。请重新选择起点。`,
      });
    } else if (!insideHoleOk && insideHole(pos)) {
      issues.push({
        kind: 'invalid',
        message: `${label}的初始位置落在鼠洞区域内，猫不能从鼠洞出发。`,
      });
    }
  }
  if (inBounds(config.mouseStart) && inBounds(config.catStart)
    && samePoint(config.mouseStart, config.catStart)) {
    issues.push({
      kind: 'invalid',
      message: `猫和鼠不能从同一格出发（行 ${config.catStart.r}，列 ${config.catStart.c}）。`,
    });
  }

  const corners = config.tunnelCorners && config.tunnelCorners.length > 0
    ? config.tunnelCorners
    : makeTunnelCorners(S);
  corners.forEach((corner, i) => {
    if (!inBounds(corner)) {
      issues.push({
        kind: 'invalid',
        message: `传送通道位置越界：第 ${i + 1} 个通道（行 ${corner.r}，列 ${corner.c}）`
          + `不在 ${S}×${S} 棋盘内。`,
      });
    } else if (insideHole(corner)) {
      issues.push({
        kind: 'invalid',
        message: `传送通道与鼠洞区域重叠：（行 ${corner.r}，列 ${corner.c}）。请移动通道或鼠洞。`,
      });
    }
  });

  const fixedLists: { label: string; list?: { r: number; c: number }[] }[] = [
    { label: '箱子', list: config.boxPositions },
    { label: '杂物堆', list: config.pilePositions },
    { label: '黄油', list: config.butterPositions },
  ];
  for (const { label, list } of fixedLists) {
    if (!list) continue;
    const seen = new Set<string>();
    list.forEach((pos, i) => {
      if (!inBounds(pos)) {
        issues.push({
          kind: 'invalid',
          message: `固定的${label}位置越界：第 ${i + 1} 个（行 ${pos?.r}，列 ${pos?.c}）`
            + `不在 ${S}×${S} 棋盘内。`,
        });
        return;
      }
      const key = `${pos.r},${pos.c}`;
      if (seen.has(key)) {
        issues.push({ kind: 'invalid', message: `固定的${label}位置重复：（行 ${pos.r}，列 ${pos.c}）。` });
      }
      seen.add(key);
      if (insideHole(pos)) {
        issues.push({
          kind: 'invalid',
          message: `固定的${label}位置与鼠洞区域重叠：（行 ${pos.r}，列 ${pos.c}）。`,
        });
      } else if (corners.some((t) => samePoint(t, pos))) {
        issues.push({
          kind: 'invalid',
          message: `固定的${label}位置与传送通道重叠：（行 ${pos.r}，列 ${pos.c}）。`,
        });
      } else if (samePoint(pos, config.mouseStart) || samePoint(pos, config.catStart)) {
        issues.push({
          kind: 'invalid',
          message: `固定的${label}位置与猫/鼠初始位置重叠：（行 ${pos.r}，列 ${pos.c}）。`,
        });
      }
    });
  }

  if (config.customTerrain) {
    const grid = config.customTerrain;
    const flatWidth = grid.reduce((m, row) => Math.max(m, row.length), 0);
    if (grid.length !== S || flatWidth !== S || grid.some((row) => row.length !== S)) {
      issues.push({
        kind: 'invalid',
        message: `自定义地图尺寸与棋盘大小不一致：棋盘 ${S}×${S}，`
          + `地图 ${grid.length} 行 × ${flatWidth} 列。`,
      });
    } else {
      for (const { label, pos } of starts) {
        if (!inBounds(pos)) continue;
        const type = grid[pos.r][pos.c];
        if (BLOCKING_TERRAIN.includes(type)) {
          issues.push({
            kind: 'invalid',
            message: `${label}的初始位置落在不可通行地形（${type}）上：（行 ${pos.r}，列 ${pos.c}）。`,
          });
        }
      }
      if (holeOk) {
        for (let r = hole.r; r < hole.r + hole.size; r++) {
          for (let c = hole.c; c < hole.c + hole.size; c++) {
            const type = grid[r][c];
            if (BLOCKING_TERRAIN.includes(type)) {
              issues.push({
                kind: 'invalid',
                message: `鼠洞区域包含不可通行地形（${type}）：（行 ${r}，列 ${c}）。`,
              });
              r = hole.r + hole.size; // one message is enough
              break;
            }
          }
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

const VALID_CELL_TYPES: ReadonlySet<string> = new Set<string>(Object.values(Cell));

/**
 * 编辑器自由地图的**结构**校验（`customMapPlaytest` 专用）。
 *
 * 与 `validateGameConfig` 的分工：
 *  - `validateGameConfig` 是**正式对局**的开局契约（认证棋盘尺寸、不重叠的
 *    标准布局等），一字不改；
 *  - 本函数只回答“这份编辑结果能否被安全地解析成一张棋盘”：尺寸/地形数据/
 *    单元格取值/坐标是否合法。缺鼠洞、缺黄油、通道未成对、角色被围住等
 *    **玩法合理性**问题一律不在这里拒绝，它们只在编辑器里作为提示出现。
 *
 * 不修改入参，也不做任何“猜测式修补”。
 */
export function validateCustomMapConfig(config: GameConfig): GameConfigValidation {
  const issues: ConfigIssue[] = [];
  const S = config.boardSize;

  if (!Number.isInteger(S) || S < EDITOR_MAP_MIN_SIZE || S > EDITOR_MAP_MAX_SIZE) {
    issues.push({
      kind: 'unsupported',
      message: `编辑器地图的棋盘边长必须是 ${EDITOR_MAP_MIN_SIZE}～${EDITOR_MAP_MAX_SIZE} 之间的整数`
        + `（当前 ${String(S)}）。`,
    });
    return { ok: false, issues };
  }

  // 同一个可精确表示的猫回合预算契约（与正式对局一致）。
  const catBaseMoves = config.catBaseMoves as number;
  if (!Number.isSafeInteger(catBaseMoves) || catBaseMoves < 1) {
    issues.push({
      kind: 'invalid',
      message: `猫每回合的基础步数必须是不小于 1 的整数（当前 ${String(catBaseMoves)}）。`,
    });
  } else if (catBaseMoves > MAX_CERTIFIABLE_CAT_MOVE_BUDGET) {
    issues.push({
      kind: 'invalid',
      message: `猫每回合的基础步数过大：计划上界必须是可精确表示的整数，`
        + `因此上限为 ${MAX_CERTIFIABLE_CAT_MOVE_BUDGET}（当前 ${String(catBaseMoves)}）。`,
    });
  }

  const inBounds = (p: { r: number; c: number } | undefined): boolean =>
    !!p && Number.isInteger(p.r) && Number.isInteger(p.c)
    && p.r >= 0 && p.r < S && p.c >= 0 && p.c < S;

  // 地形：必须是 S×S 的合法单元格矩阵（编辑器已用 Void 补齐非正方形地图）。
  const grid = config.customTerrain;
  if (!grid || grid.length === 0) {
    issues.push({ kind: 'invalid', message: '自定义地图缺少地形数据。' });
  } else if (grid.length !== S) {
    issues.push({
      kind: 'invalid',
      message: `自定义地图尺寸与棋盘大小不一致：棋盘 ${S}×${S}，地图 ${grid.length} 行。`,
    });
  } else {
    let badCellReported = 0;
    for (let r = 0; r < S; r++) {
      const row = grid[r];
      if (!Array.isArray(row) || row.length !== S) {
        issues.push({
          kind: 'invalid',
          message: `自定义地图第 ${r} 行的列数与棋盘大小不一致（应为 ${S} 列）。`,
        });
        break;
      }
      for (let c = 0; c < S; c++) {
        if (!VALID_CELL_TYPES.has(row[c] as string)) {
          if (badCellReported < 3) {
            issues.push({
              kind: 'invalid',
              message: `自定义地图存在无法识别的单元格类型（行 ${r}，列 ${c}：${String(row[c])}）。`,
            });
          }
          badCellReported++;
        }
      }
      if (badCellReported >= 3) break;
    }
    if (badCellReported > 3) {
      issues.push({
        kind: 'invalid',
        message: `自定义地图共有 ${badCellReported} 个无法识别的单元格，仅列出前 3 个。`,
      });
    }
  }

  // 起点：只要求坐标本身合法（落在墙/虚空上属于玩法取舍，由编辑器提示）。
  const starts = [
    { label: '鼠', pos: config.mouseStart },
    { label: '猫', pos: config.catStart },
  ] as const;
  for (const { label, pos } of starts) {
    if (!inBounds(pos)) {
      issues.push({
        kind: 'invalid',
        message: `${label}的初始位置无效：（行 ${pos?.r}，列 ${pos?.c}），棋盘范围是 0～${S - 1}。`,
      });
    }
  }

  // 鼠洞：允许“没有鼠洞”（size 0 / 空 cells），但坐标必须可解析。
  const hole = config.mouseHole;
  if (!hole) {
    issues.push({ kind: 'invalid', message: '鼠洞配置缺失（没有鼠洞时请使用 size 0）。' });
  } else if (hole.cells) {
    if (!Array.isArray(hole.cells)) {
      issues.push({ kind: 'invalid', message: '鼠洞格集合格式无效。' });
    } else {
      const bad = hole.cells.filter((p) => !inBounds(p));
      if (bad.length > 0) {
        issues.push({
          kind: 'invalid',
          message: `鼠洞格越界：${bad.length} 个格子不在 ${S}×${S} 棋盘内`
            + `（例如 行 ${bad[0]?.r}，列 ${bad[0]?.c}）。`,
        });
      }
    }
  } else if (!Number.isInteger(hole.size) || hole.size < 0) {
    issues.push({ kind: 'invalid', message: '鼠洞大小必须是不小于 0 的整数（0 表示没有鼠洞）。' });
  } else if (hole.size > 0
    && (!Number.isInteger(hole.r) || !Number.isInteger(hole.c)
      || hole.r < 0 || hole.c < 0 || hole.r + hole.size > S || hole.c + hole.size > S)) {
    issues.push({
      kind: 'invalid',
      message: `鼠洞区域越界：左上角（行 ${hole.r}，列 ${hole.c}），大小 ${hole.size}，棋盘 ${S}×${S}。`,
    });
  }

  // 传送通道：允许空数组（= 没有通道）、允许奇数个/单个；只要求坐标合法。
  for (const [i, corner] of (config.tunnelCorners ?? []).entries()) {
    if (!inBounds(corner)) {
      issues.push({
        kind: 'invalid',
        message: `传送通道位置越界：第 ${i + 1} 个通道（行 ${corner.r}，列 ${corner.c}）不在 ${S}×${S} 棋盘内。`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

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
