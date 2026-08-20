// ============================================================
// Game engine — pure logic, no UI
// 参考 C# 原型：步数制移动 + 技能系统 + 四角传送 + 陷阱
// ============================================================

import type { Direction } from './types';
import { GameMode } from './types';
import {
  CellType,
  GamePhase,
  Difficulty as DifficultyConst,
  PieceType,
  DIRECTIONS,
} from './types';
import type { GameConfig } from './config';
import { DEFAULT_CONFIG, generateBoxPositions } from './config';
// Single-source tunnel kernel: the engine's single-exit path reuses the same
// chooseTunnelExit implementation as the UI, tutorial, and Search Simulator.
// rules/tunnels.ts imports engine only as `import type` (erased at runtime), so
// this is a one-way engine -> rules edge with no runtime cycle.
import { chooseTunnelExit } from './rules/tunnels';
// Shared tunnel-geometry kernel (Phase E1): corner resolution, blocked/usable
// predicates, exit-set computation and mouse-hole gate cells live in ONE place
// (rules/tunnelRules.ts) used by the runtime, the Search Simulator and the
// evaluator. It imports engine only as `import type` (erased at runtime), so
// this is a one-way engine -> rules edge with no runtime cycle.
import {
  getTunnelCorners,
  isTunnelCornerCell,
  isTunnelUsable,
  getTunnelExits,
  getMouseHoleGateCells,
  getMouseHoleCells,
} from './rules/tunnelRules';
// F1B-1: the ONLY ai runtime import in the engine is the tiny Hard turn-planner
// strategy. The planner tree (expectiminimax / evaluation / simulator) imports
// engine ONLY as `import type` (erased), so no engine -> searchHard ->
// searchRules -> engine runtime cycle can form. `searchRules.ts` (the test-side
// binding) is deliberately NEVER imported by engine.
import { planHardCatTurn } from './ai/hardTurnPlanner';
import type { HardSearchDebug } from './ai/hardTurnPlanner';
import type { HardSearchHistoryEntry } from './ai/hardHistory';
import { pushHardHistory, makeHardHistoryEntry } from './ai/hardHistory';
import { stateKey } from './ai/transposition';
import type { RuleSet, SearchAction } from './ai/searchTypes';
import { DEFAULT_SEARCH_CONFIG } from './ai/searchConfig';

// --- Local types ---

type CellData = {
  type: CellType;
  piece?: PieceType;
  hasButter: boolean;
};

type Board = CellData[][];

// Exported so the shared rule kernel (src/game/rules/*) and the test suite can
// reference the exact engine state shape without copying it. Structure/semantics
// are unchanged — this is purely a visibility change for the AI refactor.
export type GameEngineState = {
  board: Board;
  config: GameConfig;
  gameMode: GameMode;
  phase: GamePhase;
  currentPlayer: PieceType;
  catPosition: { r: number; c: number };
  mousePosition: { r: number; c: number };
  catMovesLeft: number;
  mouseMovesLeft: number;
  // Butter system
  butterPositions: { r: number; c: number }[];
  mouseHasButter: boolean;
  mouseSkillActive: boolean; // 是否已释放技能（额外步数+解锁传送）
  // TrapPosition: where the trap is placed
  trapPosition: { r: number; c: number } | null;
  catTrapsRemaining: number; // 猫当前可用的陷阱数量
  // Blocked tunnel corners (boxes pushed onto tunnel entrances/exits)
  blockedTunnels: { r: number; c: number }[];
  message: string;
  tunnelExitChoices: { r: number; c: number; label: string }[]; // 可选的传送出口
  // Debug: AI action log
  catActionLog: string[];
  // Debug: mouse game event log
  gameEventLog: string[];
  /** HARD_SEARCH debug record from the most recent Hard turn planner call
   *  (rendered by the UI debug panel with a copy button). Debug-only; EXCLUDED
   *  from gameAffectingEqual/stateKey so it never affects search or TT. */
  lastHardSearch: HardSearchDebug | null;
  /** G0.2: bounded debug history of recent Hard cat-turn roots (exact deep
   *  snapshots) for offline point-of-no-return forensics. Debug-only; EXCLUDED
   *  from gameAffectingEqual/stateKey/TT — never affects AI decisions. */
  hardSearchHistory: HardSearchHistoryEntry[];
};

// --- Helpers ---

/** Append a message to the cat action log (max 150 entries) */
function logAction(state: GameEngineState, msg: string): GameEngineState {
  const log = [...(state.catActionLog || []), msg];
  if (log.length > 150) log.shift();
  return { ...state, catActionLog: log };
}

/**
 * F1B-4: explicit, non-silent record of a Search-to-legacy fallback.
 * Returns the (unchanged) state with the message appended to the cat log so
 * production/benchmark can audit that a fallback happened and why.
 */
function logFallback(state: GameEngineState, msg: string): GameEngineState {
  return logAction({ ...state, message: msg }, msg);
}

/** Append a game event to the mouse event log (max 200 entries) */
function logEvent(state: GameEngineState, msg: string): GameEngineState {
  const log = [...(state.gameEventLog || []), msg];
  if (log.length > 200) log.shift();
  return { ...state, gameEventLog: log };
}

/** Log a cat AI decision step */
function logCatMove(state: GameEngineState, from: { r: number; c: number }, to: { r: number; c: number }, detail: string): GameEngineState {
  return logAction(state, `🐱 [CAT] (${from.r},${from.c})→(${to.r},${to.c}) ${detail} | 剩余:${state.catMovesLeft}`);
}

/** Log hard AI decision diagnostics */
function logHardDecision(
  state: GameEngineState,
  strategy: string,
  topCandidates: { score: number; dir: string; to: { r: number; c: number }; bfsMouse: number | null; bfsIntercept: number | null; isBoxPush: boolean; notes: string }[],
  predPath?: string,
  trapInfo?: string,
): GameEngineState {
  const mouseButter = state.mouseHasButter ? 'yes' : 'no';
  const skillActive = state.mouseSkillActive ? 'yes' : 'no';
  const topStr = topCandidates.slice(0, 3).map(c => {
    const parts = [`dir=${c.dir} to=(${c.to.r},${c.to.c}) s=${c.score}`];
    if (c.bfsMouse != null) parts.push(`bfsMouse=${c.bfsMouse}`);
    else parts.push('bfsMouse=null');
    if (c.bfsIntercept != null) parts.push(`bfsIntcpt=${c.bfsIntercept}`);
    else parts.push('bfsIntcpt=n/a');
    if (c.isBoxPush) parts.push('push');
    if (c.notes) parts.push(c.notes);
    return parts.join('; ');
  }).join(' | ');
  const pathStr = predPath ? ` path:${predPath}` : '';
  const trapStr = trapInfo ? ` ${trapInfo}` : '';
  const msg = `HARD_EVAL mouseButter:${mouseButter} skill:${skillActive} strategy:${strategy}${pathStr} top:[${topStr}]${trapStr}`;
  return logAction(state, msg);
}

function makeCell(type: CellType = CellType.Empty, piece?: PieceType): CellData {
  return { type, piece, hasButter: false };
}

function isTunnelCorner(r: number, c: number, tunnelCorners: { r: number; c: number }[]): boolean {
  return isTunnelCornerCell(r, c, tunnelCorners);
}

function isMouseHole(r: number, c: number, mouseHole: { r: number; c: number; size: number }): boolean {
  return (
    r >= mouseHole.r && r < mouseHole.r + mouseHole.size &&
    c >= mouseHole.c && c < mouseHole.c + mouseHole.size
  );
}

function isInBounds(r: number, c: number, boardSize: number): boolean {
  return r >= 0 && r < boardSize && c >= 0 && c < boardSize;
}

function hasBox(r: number, c: number, board: Board): boolean {
  return board[r][c].type === CellType.Box;
}

function hasPile(r: number, c: number, board: Board): boolean {
  const t = board[r][c].type;
  return t === CellType.Pile || t === CellType.Wall;
}

/** 固定障碍物：墙与杂物堆，均不可通行、不可被推动（与箱子不同）。 */
function isFixedObstacle(type: CellType): boolean {
  return type === CellType.Pile || type === CellType.Wall;
}

function hasButterAt(r: number, c: number, butterPositions: { r: number; c: number }[]): boolean {
  return butterPositions.some(b => b.r === r && b.c === c);
}

function cloneBoard(board: Board): Board {
  return board.map(row => row.map(cell => ({ ...cell })));
}

/**
 * 解析通道位置：优先使用自定义地图提供的 tunnelCorners；
 * 未提供时回落到棋盘四角（原默认行为，保证现有玩法不变）。
 * 空数组表示"无通道"。
 * (Phase E1: re-export of the shared rules/tunnelRules kernel — the runtime,
 *  Search Simulator and evaluator all resolve corners identically.)
 */
export { getTunnelCorners };
// --- Board generation ---

/** Generate pile positions randomly, avoiding special cells */
function generatePilePositions(
  count: number,
  boardSize: number,
  tunnelCorners: { r: number; c: number }[],
  mouseHole: { r: number; c: number; size: number },
  mouseStart: { r: number; c: number },
  catStart: { r: number; c: number },
  boxPositions: { r: number; c: number }[],
): { r: number; c: number }[] {
  const positions: { r: number; c: number }[] = [];
  const occupied = new Set<string>();

  const add = (r: number, c: number) => occupied.add(`${r},${c}`);
  for (const tc of tunnelCorners) add(tc.r, tc.c);
  for (let dr = 0; dr < mouseHole.size; dr++)
    for (let dc = 0; dc < mouseHole.size; dc++) add(mouseHole.r + dr, mouseHole.c + dc);
  add(mouseStart.r, mouseStart.c);
  add(catStart.r, catStart.c);
  for (const bp of boxPositions) add(bp.r, bp.c);

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

function createInitialBoard(config: GameConfig, tunnelCorners: { r: number; c: number }[]): Board {
  // 自定义地图：地形已由编辑器绘制，直接克隆使用（跳过随机生成）
  if (config.customTerrain && config.customTerrain.length > 0) {
    return config.customTerrain.map(row =>
      row.map(t => ({ type: t, piece: undefined, hasButter: t === CellType.ButterSpot } as CellData)),
    );
  }

  const board: Board = Array.from({ length: config.boardSize }, () =>
    Array.from({ length: config.boardSize }, () => makeCell())
  );

  // Mouse hole
  for (let dr = 0; dr < config.mouseHole.size; dr++) {
    for (let dc = 0; dc < config.mouseHole.size; dc++) {
      board[config.mouseHole.r + dr][config.mouseHole.c + dc] = { ...makeCell(CellType.MouseHole) };
    }
  }

  // 4 tunnel corners
  for (const corner of tunnelCorners) {
    board[corner.r][corner.c] = { ...makeCell(CellType.Tunnel) };
  }

  // Boxes — either fixed positions or random scatter
  const boxPositions = config.boxPositions || generateBoxPositions(
    config.boxCount,
    config.boardSize,
    tunnelCorners,
    config.mouseHole,
    config.mouseStart,
    config.catStart,
    config.pilePositions,
  );
  for (const pos of boxPositions) {
    board[pos.r][pos.c] = { ...makeCell(CellType.Box) };
  }

  // Piles — fixed obstacles, placed after boxes so boxes don't overlap them
  const pileCount = config.pileCount ?? 4;
  const pilePositions = config.pilePositions || generatePilePositions(
    pileCount,
    config.boardSize,
    tunnelCorners,
    config.mouseHole,
    config.mouseStart,
    config.catStart,
    boxPositions,
  );
  for (const pos of pilePositions) {
    board[pos.r][pos.c] = { ...makeCell(CellType.Pile) };
  }

  return board;
}

function generateButterPositions(
  config: GameConfig,
  board: Board,
  tunnelCorners: { r: number; c: number }[],
  mousePos: { r: number; c: number },
  catPos: { r: number; c: number },
  trapPos: { r: number; c: number } | null,
): { r: number; c: number }[] {
  const positions: { r: number; c: number }[] = [];
  const rand = () => Math.floor(Math.random() * (config.boardSize - 2)) + 1;

  for (let i = 0; i < config.butterCount; i++) {
    let attempts = 0;
    while (attempts++ < 100) {
      const r = rand();
      const c = rand();
      if (isMouseHole(r, c, config.mouseHole) || isTunnelCorner(r, c, tunnelCorners) || hasBox(r, c, board) || hasPile(r, c, board) || board[r][c].type === CellType.Void) continue;
      if (trapPos && r === trapPos.r && c === trapPos.c) continue;
      if (hasButterAt(r, c, positions)) continue;
      // Distance from mouse and cat
      if (Math.abs(r - mousePos.r) + Math.abs(c - mousePos.c) < 3) continue;
      if (Math.abs(r - catPos.r) + Math.abs(c - catPos.c) < 3) continue;
      // Keep butter away from mouse hole
      const distToHole = Math.abs(r - config.mouseHole.r) + Math.abs(c - config.mouseHole.c);
      if (distToHole < 5) continue;
      positions.push({ r, c });
      break;
    }
  }
  return positions;
}

/**
 * Enumerate EVERY legal butter spawn cell for a one-for-one regeneration.
 *
 * Pure / deterministic: NO Math.random. Returns the full candidate set so the
 * Search Simulator can model butter regeneration as an honest CHANCE node
 * (one outcome per candidate, equal weight) instead of a single hidden random
 * draw. The real game samples ONE of these via `generateSingleButterPosition`.
 */
export function enumerateButterSpawns(
  config: GameConfig,
  board: Board,
  tunnelCorners: { r: number; c: number }[],
  mousePos: { r: number; c: number },
  catPos: { r: number; c: number },
  existingButters: { r: number; c: number }[],
  trapPos: { r: number; c: number } | null,
): { r: number; c: number }[] {
  const valid: { r: number; c: number }[] = [];
  for (let r = 1; r <= config.boardSize - 2; r++) {
    for (let c = 1; c <= config.boardSize - 2; c++) {
      if (isMouseHole(r, c, config.mouseHole)) continue;
      if (isTunnelCorner(r, c, tunnelCorners)) continue;
      if (hasBox(r, c, board)) continue;
      if (hasPile(r, c, board)) continue;
      if (board[r][c].type === CellType.Void) continue;
      if (existingButters.some(b => b.r === r && b.c === c)) continue;
      if (trapPos && r === trapPos.r && c === trapPos.c) continue;
      // Non-initial: closer to hole is OK
      const distToHole = Math.abs(r - config.mouseHole.r) + Math.abs(c - config.mouseHole.c);
      if (distToHole < 3) continue;
      // Keep away from pieces
      if (Math.abs(r - mousePos.r) + Math.abs(c - mousePos.c) < 3) continue;
      if (Math.abs(r - catPos.r) + Math.abs(c - catPos.c) < 3) continue;
      valid.push({ r, c });
    }
  }
  return valid;
}

/** Sample ONE legal butter spawn cell (real game uses this; random draw). */
function generateSingleButterPosition(
  config: GameConfig,
  board: Board,
  tunnelCorners: { r: number; c: number }[],
  mousePos: { r: number; c: number },
  catPos: { r: number; c: number },
  existingButters: { r: number; c: number }[],
  trapPos: { r: number; c: number } | null,
): { r: number; c: number } | null {
  const valid = enumerateButterSpawns(
    config, board, tunnelCorners, mousePos, catPos, existingButters, trapPos,
  );
  if (valid.length === 0) return null;
  return valid[Math.floor(Math.random() * valid.length)];
}

/**
 * Sanitize item overlaps: if trapPosition coincides with any butter,
 * remove that butter and regenerate it at a legal position.
 * This prevents the impossible state where mouse steps on a trap+butter cell
 * and triggers the trap without eating the butter.
 */
function sanitizeItemOverlaps(state: GameEngineState): GameEngineState {
  if (!state.trapPosition || state.trapPosition.r === undefined) return state;
  const trapIdx = state.butterPositions.findIndex(
    b => b.r === state.trapPosition!.r && b.c === state.trapPosition!.c,
  );
  if (trapIdx < 0) return state;

  const { config, board } = state;
  const tc = getTunnelCorners(config);
  // Remove overlapping butter
  const newButters = [...state.butterPositions];
  newButters.splice(trapIdx, 1);

  // Regenerate at a safe position
  const safePos = generateSingleButterPosition(
    config, board, tc, state.mousePosition, state.catPosition, newButters, state.trapPosition,
  );
  if (safePos) newButters.push(safePos);

  return { ...state, butterPositions: newButters };
}

// --- Public API ---

export function createInitialState(config: GameConfig = DEFAULT_CONFIG): GameEngineState {
  const tunnelCorners = getTunnelCorners(config);
  const board = createInitialBoard(config, tunnelCorners);

  const mouseStart = config.mouseStart;
  const catStart = config.catStart;

  board[mouseStart.r][mouseStart.c] = { ...board[mouseStart.r][mouseStart.c], piece: PieceType.Mouse };
  board[catStart.r][catStart.c] = { ...board[catStart.r][catStart.c], piece: PieceType.Cat };

  // 黄油：自定义地图从地形中的黄油点（ButterSpot）直接读取；否则按数量随机生成
  let butterPositions: { r: number; c: number }[];
  if (config.customTerrain && config.customTerrain.length > 0) {
    butterPositions = [];
    for (let r = 0; r < board.length; r++) {
      for (let c = 0; c < board[r].length; c++) {
        if (board[r][c].hasButter) butterPositions.push({ r, c });
      }
    }
  } else if (config.butterPositions && config.butterPositions.length > 0) {
    butterPositions = config.butterPositions.filter(p => board[p.r]?.[p.c]?.type === CellType.Empty);
  } else {
    butterPositions = generateButterPositions(config, board, tunnelCorners, mouseStart, catStart, null);
  }

  return {
    board,
    config,
    gameMode: config.gameMode,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Mouse,
    catPosition: catStart,
    mousePosition: mouseStart,
    catMovesLeft: config.catBaseMoves,
    mouseMovesLeft: config.mouseBaseMoves,
    butterPositions,
    mouseHasButter: false,
    mouseSkillActive: false,
    trapPosition: null,
    catTrapsRemaining: 1,
    blockedTunnels: [],
    message: `鼠的回合 — 按方向键移动（剩余${config.mouseBaseMoves}步）`,
    tunnelExitChoices: [],
    catActionLog: [],
    gameEventLog: [],
    lastHardSearch: null,
    hardSearchHistory: [],
  };
}

// --- Mouse move ---

/**
 * Result of the deterministic mouse-step core (see `applyMouseStepCore`).
 * `moved` is false when the step is illegal/blocked (the returned `state` is
 * the unchanged input, possibly with a "blocked" message). `pickedButter`
 * means a butter was consumed and removed (but NOT yet regenerated — that is
 * deferred to the caller). `tunnelPending` means the mouse entered a tunnel
 * and is now awaiting an exit choice (phase === ChoosingTunnelExit).
 * `trapFlipped` means stepping on the trap already handed the turn to the cat.
 * `won` means the mouse reached the hole carrying butter.
 */
export interface MouseStepCore {
  state: GameEngineState;
  moved: boolean;
  pickedButter: boolean;
  trapFlipped: boolean;
  tunnelPending: boolean;
  won: boolean;
}

function noStep(state: GameEngineState, message?: string): MouseStepCore {
  return {
    state: message ? { ...state, message } : state,
    moved: false,
    pickedButter: false,
    trapFlipped: false,
    tunnelPending: false,
    won: false,
  };
}

/**
 * Deterministic core of a mouse step.
 *
 * Performs the move, tunnel entry, trap, win, and butter PICKUP (removal) —
 * but does NOT regenerate butter, does NOT call `endTurn`, and does NOT run
 * the `sanitizeItemOverlaps` pass. This is the single source of truth for the
 * mouse's transition. The real `mouseMove` and the Search Simulator's
 * `mouseStep` both build on it, so they can never silently diverge.
 */
function applyMouseStepCore(state: GameEngineState, direction: Direction): MouseStepCore {
  if (state.phase !== GamePhase.Playing || state.currentPlayer !== PieceType.Mouse) {
    return noStep(state);
  }
  if (state.mouseMovesLeft <= 0) return noStep(state);

  const pos = state.mousePosition;
  const nr = pos.r + direction.dr;
  const nc = pos.c + direction.dc;
  const { config } = state;

  if (!isInBounds(nr, nc, config.boardSize)) return noStep(state);

  const targetCell = state.board[nr][nc];

  // Can't move into box / pile / void / cat
  if (targetCell.type === CellType.Box) return noStep(state);
  if (isFixedObstacle(targetCell.type)) return noStep(state);
  if (targetCell.type === CellType.Void) return noStep(state);
  if (state.catPosition.r === nr && state.catPosition.c === nc) return noStep(state);

  // Tunnel: can only enter if NOT carrying butter
  if (targetCell.type === CellType.Tunnel) {
    if (!isTunnelUsable(state, nr, nc)) {
      return noStep(state, '🚫 这个快速通道被箱子堵住了！');
    }
    if (state.mouseHasButter) {
      return noStep(state, '🚫 携带黄油不能进传送通道！先放技能或放下黄油');
    }
    // Exit set computed by the shared tunnel-geometry kernel (same list the
    // evaluator and Search Simulator see — never a third copy).
    const exits = getTunnelExits(state, nr, nc);
    // Bug 2: also offer "stay here" — teleport back to the current tunnel cell
    exits.unshift({ r: nr, c: nc, label: '↺ 原地' });

    if (exits.length === 0) {
      return noStep(state, '🚫 所有传送出口都被箱子堵住了！');
    }

    // Set up the ChoosingTunnelExit state on the entrance cell. The actual
    // teleport is performed by the shared chooseTunnelExit kernel (used by the
    // real game's single-exit path below, the UI, and the Search Simulator).
    const choiceBoard = cloneBoard(state.board);
    choiceBoard[pos.r][pos.c] = { ...choiceBoard[pos.r][pos.c], piece: undefined };
    choiceBoard[nr][nc] = { ...choiceBoard[nr][nc], piece: PieceType.Mouse };
    const choosingState: GameEngineState = {
      ...state,
      board: choiceBoard,
      blockedTunnels: state.blockedTunnels,
      mousePosition: { r: nr, c: nc },
      mouseMovesLeft: 0,
      phase: GamePhase.ChoosingTunnelExit,
      tunnelExitChoices: exits,
      message: '🚇 选择传送出口（点击格子或按键 1/2/3...）',
    };
    return { state: choosingState, moved: true, pickedButter: false, trapFlipped: false, tunnelPending: true, won: false };
  }

  // Trap: stepping on the trap ends the mouse turn immediately (currentPlayer flips to Cat)
  if (state.trapPosition?.r === nr && state.trapPosition?.c === nc) {
    const newBoard = cloneBoard(state.board);
    newBoard[pos.r][pos.c] = { ...newBoard[pos.r][pos.c], piece: undefined };
    newBoard[nr][nc] = { ...newBoard[nr][nc], piece: PieceType.Mouse };
    const trapState: GameEngineState = {
      ...state,
      board: newBoard,
      mousePosition: { r: nr, c: nc },
      trapPosition: null,
      mouseMovesLeft: 0, // 踩陷阱直接损失全部剩余步数
      phase: GamePhase.Playing,
      currentPlayer: PieceType.Cat,
      message: '💀 踩到捕鼠夹！损失全部剩余步数并结束本回合！',
    };
    return { state: trapState, moved: true, pickedButter: false, trapFlipped: true, tunnelPending: false, won: false };
  }

  // Normal move
  const newBoard = cloneBoard(state.board);
  newBoard[pos.r][pos.c] = { ...newBoard[pos.r][pos.c], piece: undefined };
  newBoard[nr][nc] = { ...newBoard[nr][nc], piece: PieceType.Mouse };

  // Pick up butter (removal only — regeneration is deferred to the caller)
  let newButterPositions = state.butterPositions;
  let newHasButter = state.mouseHasButter;
  let pickedButter = false;
  let pickedIndex = -1;
  for (let i = 0; i < newButterPositions.length; i++) {
    if (newButterPositions[i].r === nr && newButterPositions[i].c === nc) {
      pickedButter = true;
      pickedIndex = i;
      break;
    }
  }
  if (pickedButter) {
    newButterPositions = [...newButterPositions];
    newButterPositions.splice(pickedIndex, 1);
    newHasButter = true;
  }

  // Win: mouse hole + has butter (any skill state — skill+pick-up also counts)
  if (targetCell.type === CellType.MouseHole && newHasButter) {
    const winState: GameEngineState = {
      ...state,
      board: newBoard,
      mousePosition: { r: nr, c: nc },
      butterPositions: newButterPositions,
      mouseHasButter: false,
      mouseSkillActive: false,
      phase: GamePhase.MouseWins,
      message: '🎉 鼠获胜！成功把黄油带回鼠洞！',
    };
    return { state: winState, moved: true, pickedButter, trapFlipped: false, tunnelPending: false, won: true };
  }

  const movesLeft = state.mouseMovesLeft - 1;
  const normalState: GameEngineState = {
    ...state,
    board: newBoard,
    mousePosition: { r: nr, c: nc },
    butterPositions: newButterPositions,
    mouseHasButter: newHasButter,
    mouseMovesLeft: movesLeft,
    message: movesLeft > 0 ? `鼠移动 — 剩余 ${movesLeft} 步` : `鼠步数用完，轮到猫`,
  };
  return { state: normalState, moved: true, pickedButter, trapFlipped: false, tunnelPending: false, won: false };
}

/**
 * Finish a mouse step: auto-end the turn when the mouse runs out of moves.
 * The trap case already flipped `currentPlayer` to Cat inside the core, so it
 * is left untouched. Shared by the real `mouseMove` and the Search Simulator,
 * so the turn-finalization rule is defined exactly once.
 */
function finalizeTurnAfterMouseStep(state: GameEngineState): GameEngineState {
  if (state.phase !== GamePhase.Playing) return state; // MouseWins / ChoosingTunnelExit
  if (state.currentPlayer === PieceType.Cat) return state; // trap flipped the actor
  if (state.mouseMovesLeft <= 0 && state.tunnelExitChoices.length === 0) {
    return endTurn(state);
  }
  return state;
}

export function mouseMove(state: GameEngineState, direction: Direction): GameEngineState {
  state = sanitizeItemOverlaps(state);
  const core = applyMouseStepCore(state, direction);
  if (!core.moved) return core.state;
  if (core.won) return core.state;

  let s = core.state;

  // Single-source tunnel: the shared kernel performs the teleport. The real
  // game auto-resolves a single exit (no player choice) and then ends the turn.
  if (core.tunnelPending) {
    if (s.tunnelExitChoices.length === 1) {
      const exit = s.tunnelExitChoices[0];
      return endTurn(chooseTunnelExit(s, exit.r, exit.c));
    }
    return s; // multi-exit: wait for the player's choice
  }

  // One-for-one butter regeneration (C# prototype behavior) — real game draws
  // ONE random spawn via Math.random. The Search Simulator defers this and
  // enumerates ALL spawns as a chance node (see mouseStepDeterministic).
  if (core.pickedButter) {
    const tunnelCorners = getTunnelCorners(s.config);
    const newButter = generateSingleButterPosition(
      s.config, s.board, tunnelCorners, s.mousePosition, s.catPosition, s.butterPositions, s.trapPosition,
    );
    if (newButter) s = { ...s, butterPositions: [...s.butterPositions, newButter] };
  }

  return finalizeTurnAfterMouseStep(s);
}

/**
 * Deterministic mouse step used by the Search Simulator.
 *
 * Identical to `mouseMove` EXCEPT butter regeneration is DEFERRED: the mouse
 * still picks up the butter (removed from the board, `mouseHasButter = true`)
 * but no new butter is spawned here. The simulator enumerates the possible
 * spawns via `enumerateButterSpawns` and models them as a CHANCE node — so the
 * search never calls Math.random and never sees a single hidden random draw.
 * Turn finalization (trap / moves-exhausted) is identical to the real game.
 */
export function mouseStepDeterministic(state: GameEngineState, direction: Direction): GameEngineState {
  const core = applyMouseStepCore(state, direction);
  if (!core.moved) return core.state;
  if (core.won) return core.state;
  if (core.tunnelPending) return core.state; // single-exit teleport is handled by chooseTunnelExit in the search
  return finalizeTurnAfterMouseStep(core.state);
}

// --- Mouse skill (spacebar) ---
// --- Mouse skill (spacebar) ---

export function mouseSkill(state: GameEngineState): GameEngineState {
  if (state.phase !== GamePhase.Playing || state.currentPlayer !== PieceType.Mouse) return state;
  if (!state.mouseHasButter || state.mouseSkillActive) return state;

  const beforeButter = state.mouseHasButter;
  const beforeMoves = state.mouseMovesLeft;

  let s = logEvent(state, `MOUSE_SKILL before butter=${beforeButter} moves=${beforeMoves} after butter=false skill=true moves=${state.mouseMovesLeft + state.config.mouseSkillExtraMoves}`);

  return {
    ...s,
    blockedTunnels: s.blockedTunnels,
    mouseHasButter: false,
    mouseSkillActive: true,
    mouseMovesLeft: s.mouseMovesLeft + s.config.mouseSkillExtraMoves,
    message: '🔥 技能激活！获得额外步数，传送通道已解锁！',
  };
}

// --- Cat move ---

export function catMove(state: GameEngineState, direction: Direction): GameEngineState {
  state = sanitizeItemOverlaps(state);
  if (state.phase !== GamePhase.Playing || state.currentPlayer !== PieceType.Cat) return state;
  if (state.catMovesLeft <= 0) return state;

  const pos = state.catPosition;
  const nr = pos.r + direction.dr;
  const nc = pos.c + direction.dc;
  const { config } = state;
  const tunnelCorners = getTunnelCorners(config);

  if (!isInBounds(nr, nc, config.boardSize)) return state;

  // Cat can't enter mouse hole
  if (isMouseHole(nr, nc, config.mouseHole)) return state;

  // Cat can't enter tunnel
  if (isTunnelCorner(nr, nc, tunnelCorners)) return state;

  // Cat can't enter butter spot
  if (hasButterAt(nr, nc, state.butterPositions)) return state;

  // Cat can't move into pile
  if (isFixedObstacle(state.board[nr][nc].type)) return state;

  // Cat can't move into void (地图之外)
  if (state.board[nr][nc].type === CellType.Void) return state;

  // Check if there's a box to push
  if (hasBox(nr, nc, state.board)) {
    const pushDr = nr - pos.r;
    const pushDc = nc - pos.c;
    const destR = nr + pushDr;
    const destC = nc + pushDc;

    if (!isInBounds(destR, destC, config.boardSize)) return state;
    if (isMouseHole(destR, destC, config.mouseHole)) return state;
    if (state.mousePosition.r === destR && state.mousePosition.c === destC) return state;
    if (hasBox(destR, destC, state.board)) return state;
    if (hasPile(destR, destC, state.board)) return state;
    if (state.board[destR][destC].type === CellType.Void) return state;
    if (hasButterAt(destR, destC, state.butterPositions)) return state;
    if (state.trapPosition?.r === destR && state.trapPosition?.c === destC) return state;

    // Push box
    const pushedToTunnel = isTunnelCorner(destR, destC, tunnelCorners);
    const newBlockedTunnels = pushedToTunnel &&
      !state.blockedTunnels.some(t => t.r === destR && t.c === destC)
        ? [...state.blockedTunnels, { r: destR, c: destC }]
        : state.blockedTunnels;

    const newBoard = cloneBoard(state.board);
    newBoard[pos.r][pos.c] = { ...newBoard[pos.r][pos.c], piece: undefined };
    newBoard[nr][nc] = { ...newBoard[nr][nc], type: CellType.Empty, piece: PieceType.Cat };
    newBoard[destR][destC] = { ...newBoard[destR][destC], type: CellType.Box };

    const result: GameEngineState = logCatMove({
      ...state,
      board: newBoard,
      catPosition: { r: nr, c: nc },
      catMovesLeft: state.catMovesLeft - 1,
      blockedTunnels: newBlockedTunnels,
      message: `猫推动箱子到 (${destR},${destC}) — 剩余 ${state.catMovesLeft - 1} 步`,
    }, pos, { r: nr, c: nc }, pushedToTunnel ? '推箱堵通道' : '推箱');
    return checkCatWin(result);
  }

  // Normal move
  const newBoard = cloneBoard(state.board);
  newBoard[pos.r][pos.c] = { ...newBoard[pos.r][pos.c], piece: undefined };
  newBoard[nr][nc] = { ...newBoard[nr][nc], piece: PieceType.Cat };

  const steppedOnTrap = state.trapPosition?.r === nr && state.trapPosition?.c === nc;
  // Cat steps on its own trap — pick it back up
  if (steppedOnTrap) {
    newBoard[nr][nc] = { ...newBoard[nr][nc], type: CellType.Empty };
  }

  const detail = steppedOnTrap ? '收回陷阱' : '移动';
  const result: GameEngineState = logCatMove({
    ...state,
    board: newBoard,
    catPosition: { r: nr, c: nc },
    catMovesLeft: state.catMovesLeft - 1,
    trapPosition: steppedOnTrap ? null : state.trapPosition,
    catTrapsRemaining: steppedOnTrap ? state.catTrapsRemaining + 1 : state.catTrapsRemaining,
    message: steppedOnTrap
      ? '🪤 猫收回了捕鼠夹！'
      : `猫移动 — 剩余 ${state.catMovesLeft - 1} 步`,
  }, pos, { r: nr, c: nc }, detail);
  return checkCatWin(result);
}

// --- Cat place trap ---


export function catPlaceTrap(state: GameEngineState): GameEngineState {
  if (state.phase !== GamePhase.Playing || state.currentPlayer !== PieceType.Cat) return state;
  // 场上已有陷阱时不能直接放新的，必须先回收
  if (state.trapPosition !== null) return { ...state, message: '🪤 场上已有捕鼠夹！先到陷阱格子上收回才能放新的。' };
  if (state.catTrapsRemaining <= 0) return state;

  const { r, c } = state.catPosition;
  const { board, config } = state;

  if (!isInBounds(r, c, config.boardSize)) return state;
  if (isMouseHole(r, c, config.mouseHole)) return state;
  if (isTunnelCorner(r, c, getTunnelCorners(config))) return state;
  if (state.blockedTunnels.some(t => t.r === r && t.c === c)) return state;
  if (board[r][c].type !== CellType.Empty) return state;
  if (hasButterAt(r, c, state.butterPositions)) return state;
  if (state.mousePosition.r === r && state.mousePosition.c === c) return state;

  const next: GameEngineState = {
    ...state,
    trapPosition: { r, c },
    catTrapsRemaining: state.catTrapsRemaining - 1,
  };

  return logAction(
    next,
    `🪤 [CAT] 在当前位置(${r},${c})放置陷阱 | 剩余:${next.catTrapsRemaining}`,
  );
}

function checkCatWin(state: GameEngineState): GameEngineState {
  if (state.catPosition.r === state.mousePosition.r &&
      state.catPosition.c === state.mousePosition.c) {
    return { ...state, phase: GamePhase.CatWins, message: '😺 猫获胜！猫抓住了老鼠！' };
  }
  return state;
}

// --- End turn ---

export function endTurn(state: GameEngineState): GameEngineState {
  if (state.phase !== GamePhase.Playing) return state;

  const nextPlayer = state.currentPlayer === PieceType.Cat ? PieceType.Mouse : PieceType.Cat;
  const { config } = state;

  // Reset mouse skill when mouse turn ends (cat's turn starts)
  const resetMouseSkill = state.currentPlayer === PieceType.Mouse;

  // Calculate mouse moves for the new turn
  const newMouseMoves = nextPlayer === PieceType.Mouse
    ? (state.mouseHasButter ? config.mouseCarryingMoves : config.mouseBaseMoves)
    : config.catBaseMoves;

  state = logEvent(state, `TURN_END from=${state.currentPlayer} to=${nextPlayer} reason=normal`);

  let result: GameEngineState = {
    ...state,
    board: state.board,
    gameMode: state.gameMode,
    blockedTunnels: state.blockedTunnels,
    phase: GamePhase.Playing,
    currentPlayer: nextPlayer,
    catMovesLeft: nextPlayer === PieceType.Cat ? config.catBaseMoves : state.catMovesLeft,
    mouseMovesLeft: nextPlayer === PieceType.Mouse ? newMouseMoves : state.mouseMovesLeft,
    mouseHasButter: state.mouseHasButter, // always preserve butter status across turns
    mouseSkillActive: resetMouseSkill ? false : state.mouseSkillActive,
    catTrapsRemaining: state.catTrapsRemaining,
    message: nextPlayer === PieceType.Mouse
      ? (state.mouseHasButter
        ? `鼠的回合 — 携带黄油移速减慢（剩余${config.mouseCarryingMoves}步），按空格释放技能`
        : `鼠的回合 — 按方向键移动（剩余${config.mouseBaseMoves}步）`)
      : (config.gameMode === GameMode.Dual
        ? '鼠回合结束，轮到猫行动。'
        : '鼠回合结束，猫开始行动。'),
    tunnelExitChoices: [],
  };

  result = logEvent(result, `TURN_START player=${result.currentPlayer} catMoves=${result.catMovesLeft} mouseMoves=${result.mouseMovesLeft} butter=${result.mouseHasButter} skill=${result.mouseSkillActive}`);
  return result;
}

// ============================================================
// Cat AI — Strategic intelligence with lookahead, area control,
// resource management, and adaptive tactics
// ============================================================

type Point = { r: number; c: number };

// --- Strategic evaluation result ---
type EvalResult = {
  score: number;
  bfsDistToMouse: number | null;
  bfsDistToIntercept: number | null;
  mouseEscapeRoutes: number;
  catMobility: number;
  mouseMobility: number;
  isBoxPush: boolean;
  pushedBoxToTunnel: boolean;
  trapProximity: number; // steps to optimal trap position
  scoreNotes: string[]; // key scoring factors for debugging
};

// ============================================================
// Hard AI tactical types and helpers
// ============================================================

type MousePlanKind = 'carry_to_hole' | 'go_to_butter' | 'skill_chain_butter';

type MousePlan = {
  kind: MousePlanKind;
  target: Point;
  path: Point[];
  weight: number;
  nextTurnBudget: number;
  note: string;
};

type HardTrapStandDecision = {
  stand: Point;
  path: Point[];
  nextStep: Point | null;
  score: number;
  reason: string;
  stepsAhead: number;
};

/** BFS path from cat start to target, respecting all cat movement rules. */
function bfsCatPathToStand(
  start: Point,
  target: Point,
  state: GameEngineState,
): Point[] | null {
  const boardSize = state.config.boardSize;
  const tunnelCorners = getTunnelCorners(state.config);
  const visited = new Set<string>();
  const queue: { p: Point; path: Point[] }[] = [{ p: start, path: [start] }];
  visited.add(pointKey(start));

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.p.r === target.r && cur.p.c === target.c) return cur.path;

    for (const d of DIRECTIONS) {
      const nr = cur.p.r + d.dr;
      const nc = cur.p.c + d.dc;
      if (!isInBounds(nr, nc, boardSize)) continue;

      const key = `${nr},${nc}`;
      if (visited.has(key)) continue;

      if (isMouseHole(nr, nc, state.config.mouseHole)) continue;
      if (isTunnelCorner(nr, nc, tunnelCorners)) continue;
      if (state.blockedTunnels.some(t => t.r === nr && t.c === nc)) continue;
      if (state.board[nr][nc].type === CellType.Box) continue;
      if (isFixedObstacle(state.board[nr][nc].type)) continue;
      if (hasButterAt(nr, nc, state.butterPositions)) continue;
      if (state.mousePosition.r === nr && state.mousePosition.c === nc) continue;

      // Cannot walk through own active trap.
      if (
        state.trapPosition &&
        state.trapPosition.r === nr &&
        state.trapPosition.c === nc
      ) {
        continue;
      }

      const next = { r: nr, c: nc };
      visited.add(key);
      queue.push({ p: next, path: [...cur.path, next] });
    }
  }

  return null;
}

/** Decide whether the cat should commit to a trap stand plan or abandon it. */
function shouldCommitTrapPlan(
  state: GameEngineState,
  decision: HardTrapStandDecision | null,
  mousePlans: MousePlan[],
): boolean {
  if (!decision) return false;

  const catDistToStand = decision.path.length - 1;

  const mouseHasUrgentPlan = mousePlans.some(p =>
    (p.kind === 'carry_to_hole' && p.path.length - 1 <= state.config.mouseCarryingMoves + 3) ||
    (p.kind === 'skill_chain_butter' && p.path.length - 1 <= state.config.mouseBaseMoves + 3)
  );

  // Trap point too far, not worth the detour.
  if (catDistToStand > state.catMovesLeft + 3) return false;

  // Mouse plan is already urgent and trap point can't be reached soon enough.
  if (mouseHasUrgentPlan && catDistToStand > state.catMovesLeft + 1) return false;

  // Score too low to justify forcing the trap plan.
  if (decision.score < 4500) return false;

  return true;
}

/** Choose a cell the cat should move to, then place a trap underneath. */
function chooseHardTrapStandCell(
  state: GameEngineState,
  mousePlans: MousePlan[],
  holeGateCells: Point[],
): HardTrapStandDecision | null {
  if (state.trapPosition !== null || state.catTrapsRemaining <= 0) return null;

  // Collect candidate cells: all reachable non-obstacle cells on the board.
  const boardSize = state.config.boardSize;
  const tunnelCorners = getTunnelCorners(state.config);
  const candidates: { r: number; c: number; catDist: number; catPath: Point[] }[] = [];
  const seen = new Set<string>();

  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c < boardSize; c++) {
      const k = `${r},${c}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // Must not be an obstacle the cat cannot occupy.
      if (isMouseHole(r, c, state.config.mouseHole)) continue;
      if (isTunnelCorner(r, c, tunnelCorners)) continue;
      if (state.board[r][c].type === CellType.Box) continue;
      if (isFixedObstacle(state.board[r][c].type)) continue;
      if (hasButterAt(r, c, state.butterPositions)) continue;
      if (r === state.mousePosition.r && c === state.mousePosition.c) continue;
      if (state.blockedTunnels.some(t => t.r === r && t.c === c)) continue;
      // Must be reachable by BFS from cat position (real path, not Manhattan).
      const catPath = bfsCatPathToStand(state.catPosition, { r, c }, state);
      if (!catPath) continue;
      const catDist = catPath.length - 1;
      candidates.push({ r, c, catDist, catPath });
    }
  }

  if (candidates.length === 0) return null;

  const urgentHole = mousePlans.some(
    p => p.kind === 'carry_to_hole' && p.path.length - 1 <= state.config.mouseCarryingMoves + 2,
  );

  let best: HardTrapStandDecision | null = null;

  for (const cell of candidates) {
    let score = 0;
    const reasons: string[] = [];

    // Prefer cells closer to the cat (cheaper to reach).
    const catDist = cell.catDist;
    score += 120 - catDist * 18;

    // Bonus if this is the cat's current cell — ready to place immediately.
    const isCurrentCell =
      cell.r === state.catPosition.r &&
      cell.c === state.catPosition.c;
    if (isCurrentCell) {
      score += 350;
      reasons.push('current_cell_ready');
    }

    for (const plan of mousePlans) {
      const idx = pathIndexOf(plan.path, cell);

      if (idx > 0) {
        const directHitBonus =
          idx <= plan.nextTurnBudget ? 950 :
          idx <= plan.nextTurnBudget + 3 ? 560 :
          220;

        const bypassCost = estimateTrapBypassCost(plan, cell, state);

        score += plan.weight * directHitBonus;
        score += plan.weight * bypassCost * 140;

        reasons.push(`${plan.kind}@${idx}+bypass${bypassCost}`);
      } else {
        const nearIdx = plan.path.findIndex((p, i) => i > 0 && manhattan(p, cell) === 1);
        if (nearIdx > 0 && nearIdx <= plan.nextTurnBudget + 2) {
          score += plan.weight * 180;
          reasons.push(`${plan.kind}:near@${nearIdx}`);
        }
      }
    }

    // Gate trap: when mouse carries butter, hole gate cells are high-value ambush cells.
    const isHoleGate = holeGateCells.some(g => samePoint(g, cell));
    if (isHoleGate && state.mouseHasButter && !state.mouseSkillActive) {
      score += urgentHole ? 1100 : 650;
      reasons.push('hole_gate');
    }

    // Avoid wasting trap too far away from all known mouse plans.
    if (reasons.length === 0) {
      score -= 500;
      reasons.push('low_relevance');
    }

    if (!best || score > best.score) {
      best = {
        stand: cell,
        path: cell.catPath,
        nextStep: cell.catPath.length >= 2 ? cell.catPath[1] : null,
        score: Math.round(score),
        reason: reasons.join('|'),
        stepsAhead: (() => {
          const indices = mousePlans
            .map(p => pathIndexOf(p.path, cell))
            .filter(i => i > 0);
          return indices.length > 0 ? Math.min(...indices) : 0;
        })(),
      };
    }
  }

  const hasDirectPathHit = best?.reason.includes('@') && !best.reason.includes('near@');
  const threshold = urgentHole ? 420 : hasDirectPathHit ? 680 : 560;

  if (best && best.score >= threshold) return best;
  return null;
}

function pointKey(p: Point): string {
  return `${p.r},${p.c}`;
}

function samePoint(a: Point | null | undefined, b: Point | null | undefined): boolean {
  return !!a && !!b && a.r === b.r && a.c === b.c;
}

function manhattan(a: Point, b: Point): number {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

function pathIndexOf(path: Point[], cell: Point): number {
  return path.findIndex(p => p.r === cell.r && p.c === cell.c);
}

function lastPoint(path: Point[]): Point | null {
  return path.length > 0 ? path[path.length - 1] : null;
}

/** Find BFS path from start to the nearest mouse hole cell. */
function findNearestHolePathForHard(
  start: Point,
  state: GameEngineState,
  butterPositions: Point[] = state.butterPositions,
): Point[] | null {
  const holeCells = getMouseHoleCells(state.config);
  let bestPath: Point[] | null = null;
  let bestLen = Infinity;

  for (const hc of holeCells) {
    const path = bfsPath(
      start, hc, state.board, state.config,
      state.blockedTunnels, null, butterPositions,
    );
    if (!path) continue;
    const len = path.length - 1;
    if (len < bestLen) {
      bestLen = len;
      bestPath = path;
    }
  }

  return bestPath;
}

/** Build a ranked list of mouse tactical plans. */
function buildMousePlansForHard(state: GameEngineState): MousePlan[] {
  const plans: MousePlan[] = [];
  const { config } = state;
  const mousePos = state.mousePosition;
  const catPos = state.catPosition;

  // Plan A: mouse already has butter, most dangerous plan is going to hole.
  if (state.mouseHasButter && !state.mouseSkillActive) {
    const holePath = findNearestHolePathForHard(mousePos, state);
    if (holePath && holePath.length >= 2) {
      const dist = holePath.length - 1;
      const urgent = dist <= config.mouseCarryingMoves + 2;
      plans.push({
        kind: 'carry_to_hole',
        target: lastPoint(holePath)!,
        path: holePath,
        weight: urgent ? 4.2 : 2.8,
        nextTurnBudget: config.mouseCarryingMoves,
        note: urgent ? 'urgent_hole' : 'carry_hole',
      });
    }

    // Plan B: mouse may spend butter for extra moves, then re-pick another butter.
    const skillBudget = config.mouseCarryingMoves + config.mouseSkillExtraMoves;
    for (const bp of state.butterPositions) {
      const pathToButter = bfsPath(
        mousePos, bp, state.board, config,
        state.blockedTunnels, null, state.butterPositions,
      );
      if (!pathToButter || pathToButter.length < 2) continue;

      const dMouse = pathToButter.length - 1;
      if (dMouse > skillBudget + 2) continue;

      const buttersAfterPick = state.butterPositions.filter(b => !samePoint(b, bp));
      const holeAfter = findNearestHolePathForHard(bp, state, buttersAfterPick);
      const holeAfterDist = holeAfter ? holeAfter.length - 1 : 99;
      const catDist = manhattan(catPos, bp);

      const weight =
        1.5 +
        Math.max(0, skillBudget + 1 - dMouse) * 0.22 +
        Math.max(0, catDist - dMouse) * 0.12 -
        Math.min(holeAfterDist, 12) * 0.03;

      plans.push({
        kind: 'skill_chain_butter',
        target: bp,
        path: pathToButter,
        weight,
        nextTurnBudget: skillBudget,
        note: 'skill_chain_butter',
      });
    }
  }

  // Plan C: mouse does not have butter, go to best butter.
  if (!state.mouseHasButter || state.mouseSkillActive) {
    const budget = state.mouseSkillActive
      ? config.mouseCarryingMoves + config.mouseSkillExtraMoves
      : config.mouseBaseMoves;

    for (const bp of state.butterPositions) {
      const pathToButter = bfsPath(
        mousePos, bp, state.board, config,
        state.blockedTunnels, null, state.butterPositions,
      );
      if (!pathToButter || pathToButter.length < 2) continue;

      const dMouse = pathToButter.length - 1;
      const catDist = manhattan(catPos, bp);
      const buttersAfterPick = state.butterPositions.filter(b => !samePoint(b, bp));
      const holeAfter = findNearestHolePathForHard(bp, state, buttersAfterPick);
      const holeAfterDist = holeAfter ? holeAfter.length - 1 : 99;

      const weight =
        2.0 +
        Math.max(0, 8 - dMouse) * 0.25 +
        Math.max(0, catDist - dMouse) * 0.12 -
        Math.min(holeAfterDist, 12) * 0.04;

      plans.push({
        kind: 'go_to_butter',
        target: bp,
        path: pathToButter,
        weight,
        nextTurnBudget: budget,
        note: 'go_to_butter',
      });
    }
  }

  plans.sort((a, b) => b.weight - a.weight);
  return plans.slice(0, 4);
}

/** BFS distance that avoids a specific cell (for bypass cost estimation). */
function bfsDistanceAvoidPoint(
  start: Point,
  target: Point,
  board: Board,
  config: GameConfig,
  blockedTunnels: Point[],
  butterPositions: Point[],
  avoid: Point,
): number | null {
  const boardSize = config.boardSize;
  const tunnelCorners = getTunnelCorners(config);
  const startKey = pointKey(start);
  const targetKey = pointKey(target);

  if (startKey === targetKey) return 0;

  const visited = new Set<string>([startKey]);
  const distMap = new Map<string, number>();
  distMap.set(startKey, 0);

  let queue: Point[] = [start];

  while (queue.length > 0) {
    const next: Point[] = [];

    for (const cur of queue) {
      const curDist = distMap.get(pointKey(cur))!;

      for (const d of DIRECTIONS) {
        const nr = cur.r + d.dr;
        const nc = cur.c + d.dc;
        if (!isInBounds(nr, nc, boardSize)) continue;
        if (nr === avoid.r && nc === avoid.c) continue;

        const nk = `${nr},${nc}`;
        if (visited.has(nk)) continue;

        const isTarget = nr === target.r && nc === target.c;
        const cell = board[nr][nc];

        if (isMouseHole(nr, nc, config.mouseHole) && !isTarget) continue;
        if (isTunnelCorner(nr, nc, tunnelCorners)) continue;
        if (hasButterAt(nr, nc, butterPositions) && !isTarget) continue;
        if (cell.type === CellType.Box) continue;
        if (isFixedObstacle(cell.type)) continue;
        if (blockedTunnels.some(t => t.r === nr && t.c === nc)) continue;

        visited.add(nk);
        const nd = curDist + 1;
        distMap.set(nk, nd);

        if (nk === targetKey) return nd;
        next.push({ r: nr, c: nc });
      }
    }

    queue = next;
  }

  return null;
}

/** Estimate how much a trap at `trap` delays a mouse plan. */
function estimateTrapBypassCost(
  plan: MousePlan,
  trap: Point,
  state: GameEngineState,
): number {
  if (!plan.path || plan.path.length < 2) return 0;

  const original = plan.path.length - 1;
  const alt = bfsDistanceAvoidPoint(
    plan.path[0], plan.target, state.board, state.config,
    state.blockedTunnels, state.butterPositions, trap,
  );

  if (alt === null) return 6;
  return Math.max(0, Math.min(6, alt - original));
}

/** Decision about which hole entry gate to emergency-block. */
type EmergencyHoleBlockDecision = {
  entryGate: Point;
  mouseEta: number;
  kind: string;
  path: Point[];
};

/** Unified emergency hole-block finder.
 *  Considers both normal carry_to_hole and skill_chain_butter plans,
 *  returning the earliest entry gate the mouse can threaten. */
function findEmergencyHoleBlockDecision(
  state: GameEngineState,
  mousePlans: MousePlan[],
): EmergencyHoleBlockDecision | null {
  const candidates: EmergencyHoleBlockDecision[] = [];

  for (const plan of mousePlans) {
    // 1. Normal carrying butter to hole
    if (plan.kind === 'carry_to_hole') {
      const entryGate = findMouseHoleEntryGateFromPlan(plan, state);
      if (!entryGate) continue;

      candidates.push({
        entryGate,
        mouseEta: plan.path.length - 1,
        kind: 'carry_to_hole',
        path: plan.path,
      });

      continue;
    }

    // 2. Skill chain: mouse uses skill to pick up new butter, then heads to hole
    if (plan.kind === 'skill_chain_butter') {
      if (!plan.path || plan.path.length < 2) continue;

      const pickupPoint = plan.path[plan.path.length - 1];

      // pickupPoint must actually be a butter position
      if (!hasButterAt(pickupPoint.r, pickupPoint.c, state.butterPositions)) {
        continue;
      }

      // From the new butter position, find the path to the hole carrying butter.
      // Remove the picked-up butter from the list so BFS treats it as occupied.
      const buttersAfterPick = state.butterPositions.filter(
        b => !(b.r === pickupPoint.r && b.c === pickupPoint.c),
      );
      const holeAfter = findNearestHolePathForHard(pickupPoint, state, buttersAfterPick);
      if (!holeAfter || holeAfter.length < 2) continue;

      // Combine: skill chain path + hole path (skip duplicate pickup point)
      const combinedPath = [...plan.path, ...holeAfter.slice(1)];

      // Build a synthetic carry plan from the combined path
      const fakePlan: MousePlan = {
        ...plan,
        kind: 'carry_to_hole',
        target: pickupPoint,
        path: combinedPath,
      };

      const entryGate = findMouseHoleEntryGateFromPlan(fakePlan, state);
      if (!entryGate) continue;

      candidates.push({
        entryGate,
        mouseEta: combinedPath.length - 1,
        kind: 'skill_chain_butter_to_hole',
        path: combinedPath,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Prefer the earliest mouse entry
  candidates.sort((a, b) => a.mouseEta - b.mouseEta);
  return candidates[0];
}

/** Get the real entry gate cell — the last non-hole cell before the mouse hole on a carry plan. */
function findMouseHoleEntryGateFromPlan(plan: MousePlan, state: GameEngineState): Point | null {
  if (plan.kind !== 'carry_to_hole') return null;
  if (!plan.path || plan.path.length < 2) return null;

  for (let i = 1; i < plan.path.length; i++) {
    const prev = plan.path[i - 1];
    const cur = plan.path[i];

    if (isMouseHole(cur.r, cur.c, state.config.mouseHole)) {
      // prev is the cell just before entering the hole — the real entry gate.
      if (isMouseHole(prev.r, prev.c, state.config.mouseHole)) return null;
      if (isTunnelCorner(prev.r, prev.c, getTunnelCorners(state.config))) return null;
      if (state.blockedTunnels.some(t => t.r === prev.r && t.c === prev.c)) return null;
      if (state.board[prev.r][prev.c].type === CellType.Box) return null;
      if (isFixedObstacle(state.board[prev.r][prev.c].type)) return null;
      if (hasButterAt(prev.r, prev.c, state.butterPositions)) return null;
      return prev;
    }
  }

  return null;
}

/** Choose the cat's strategic intercept target (gate cell for butter, path point otherwise). */
type HoleDefenseMode = 'corner' | 'edge' | 'open';

function chooseHardStrategicTarget(
  state: GameEngineState,
  mousePlans: MousePlan[],
  holeGateCells: Point[],
  holeDefenseMode: HoleDefenseMode,
  mouseEtaToHole: number,
): Point | null {
  const primary = mousePlans[0] || null;
  if (!primary) return state.mousePosition;

  // If mouse is carrying butter, block a gate outside the hole instead of chasing the hole cell.
  // But only in corner/edge modes, or when mouse is very close in open mode.
  const allowHoleGateDefense =
    holeDefenseMode === 'corner' ||
    (holeDefenseMode === 'edge' && mouseEtaToHole <= state.config.mouseCarryingMoves + 2);

  if (state.mouseHasButter && !state.mouseSkillActive && holeGateCells.length > 0 && allowHoleGateDefense) {
    const carryPlan = mousePlans.find(p => p.kind === 'carry_to_hole') || primary;
    let bestGate: { cell: Point; score: number } | null = null;
    const urgent = carryPlan.path.length - 1 <= state.config.mouseCarryingMoves + 2;

    for (const gate of holeGateCells) {
      const catDist = bfsDistance(
        state.catPosition, gate, state.board, state.config,
        state.blockedTunnels, null, state.butterPositions,
      );
      if (catDist === null) continue;

      const gateIdx = pathIndexOf(carryPlan.path, gate);
      const mouseEta = gateIdx > 0 ? gateIdx : manhattan(state.mousePosition, gate);

      let score = 1000;
      score -= catDist * 80;
      score -= Math.abs(catDist - Math.max(1, mouseEta - 1)) * 20;
      if (gateIdx > 0) score += 650;
      if (urgent) score += 700;
      if (catDist <= state.catMovesLeft) score += 450;

      // Lower attractiveness of gates already covered by a trap
      const gateCovered =
        !!state.trapPosition &&
        state.trapPosition.r === gate.r &&
        state.trapPosition.c === gate.c;
      if (gateCovered) {
        score -= 3000;
      } else {
        score += 1000;
      }

      if (!bestGate || score > bestGate.score) {
        bestGate = { cell: gate, score };
      }
    }

    if (bestGate) return bestGate.cell;
  }

  // Otherwise choose a reachable intercept point on the highest-weight mouse plan.
  let bestIntercept: { cell: Point; score: number } | null = null;
  const maxIdx = Math.min(primary.path.length - 1, primary.nextTurnBudget + 4);

  for (let i = 1; i <= maxIdx; i++) {
    const p = primary.path[i];
    const catDist = bfsDistance(
      state.catPosition, p, state.board, state.config,
      state.blockedTunnels, null, state.butterPositions,
    );
    if (catDist === null) continue;

    let score = 600;
    score -= Math.abs(catDist - i) * 70;
    score -= catDist * 25;
    if (catDist <= state.catMovesLeft + 1) score += 300;
    if (i <= primary.nextTurnBudget) score += 180;

    if (!bestIntercept || score > bestIntercept.score) {
      bestIntercept = { cell: p, score };
    }
  }

  if (bestIntercept) return bestIntercept.cell;

  if (primary.path.length >= 3) {
    return primary.path[Math.max(1, Math.floor(primary.path.length / 3))];
  }

  return primary.target;
}

/** BFS shortest path on the board (avoids boxes, mouse hole, tunnels, butter). Returns path nodes including start and end. */
function bfsPath(
  start: Point,
  target: Point,
  board: Board,
  config: GameConfig,
  blockedTunnels: { r: number; c: number }[],
  _catTrapPos: { r: number; c: number } | null,
  butterPositions: { r: number; c: number }[],
): Point[] | null {
  const boardSize = config.boardSize;
  const tunnelCorners = getTunnelCorners(config);
  const key = (p: Point) => `${p.r},${p.c}`;

  if (start.r === target.r && start.c === target.c) return [start];

  const visited = new Set<string>();
  visited.add(key(start));
  const parent = new Map<string, Point>();

  let queue: Point[] = [start];

  while (queue.length > 0) {
    const next: Point[] = [];
    for (const cur of queue) {
      for (const d of DIRECTIONS) {
        const nr = cur.r + d.dr;
        const nc = cur.c + d.dc;
        if (!isInBounds(nr, nc, boardSize)) continue;
        const nk = `${nr},${nc}`;
        if (visited.has(nk)) continue;

        const cell = board[nr][nc];
        // Allow stepping onto mouse hole only if it's the target (mouse hiding there)
        if (isMouseHole(nr, nc, config.mouseHole) && !(nr === target.r && nc === target.c)) continue;
        if (isTunnelCorner(nr, nc, tunnelCorners)) continue;
        const isTarget = nr === target.r && nc === target.c;
        if (hasButterAt(nr, nc, butterPositions) && !isTarget) continue;
        if (cell.type === CellType.Box) continue;
        if (isFixedObstacle(cell.type)) continue;
        // Void = 地图之外，不可通行（自定义地图编辑器可自由绘制）
        if (cell.type === CellType.Void) continue;
        // Traps are passable (cat can walk onto them to pick up)
        if (blockedTunnels.some(t => t.r === nr && t.c === nc)) continue;

        visited.add(nk);
        parent.set(nk, cur);
        if (nr === target.r && nc === target.c) {
          const path: Point[] = [target];
          let p: Point | undefined = cur;
          while (p && (p.r !== start.r || p.c !== start.c)) {
            path.push(p);
            const pk = `${p.r},${p.c}`;
            p = parent.get(pk);
          }
          path.push(start);
          path.reverse();
          return path;
        }
        next.push({ r: nr, c: nc });
      }
    }
    queue = next;
  }
  return null;
}

/** BFS distance (returns null if unreachable). Optimized for repeated calls. */
function bfsDistance(
  start: Point,
  target: Point,
  board: Board,
  config: GameConfig,
  blockedTunnels: { r: number; c: number }[],
  _catTrapPos: { r: number; c: number } | null,
  butterPositions: { r: number; c: number }[],
): number | null {
  const boardSize = config.boardSize;
  const tunnelCorners = getTunnelCorners(config);
  const startKey = `${start.r},${start.c}`;
  const targetKey = `${target.r},${target.c}`;

  if (startKey === targetKey) return 0;

  const visited = new Set<string>();
  visited.add(startKey);
  const distMap = new Map<string, number>();
  distMap.set(startKey, 0);

  let queue: Point[] = [start];

  while (queue.length > 0) {
    const next: Point[] = [];
    for (const cur of queue) {
      const curDist = distMap.get(`${cur.r},${cur.c}`)!;
      for (const d of DIRECTIONS) {
        const nr = cur.r + d.dr;
        const nc = cur.c + d.dc;
        if (!isInBounds(nr, nc, boardSize)) continue;
        const nk = `${nr},${nc}`;
        if (visited.has(nk)) continue;

        const cell = board[nr][nc];
        // Allow stepping onto mouse hole only if it's the target (mouse hiding there)
        if (isMouseHole(nr, nc, config.mouseHole) && !(nr === target.r && nc === target.c)) continue;
        if (isTunnelCorner(nr, nc, tunnelCorners)) continue;
        const isTarget = nr === target.r && nc === target.c;
        if (hasButterAt(nr, nc, butterPositions) && !isTarget) continue;
        if (cell.type === CellType.Box) continue;
        if (isFixedObstacle(cell.type)) continue;
        // Void = 地图之外，不可通行（自定义地图编辑器可自由绘制）
        if (cell.type === CellType.Void) continue;
        // Traps are passable (cat can walk onto them to pick up)
        if (blockedTunnels.some(t => t.r === nr && t.c === nc)) continue;

        visited.add(nk);
        const nd = curDist + 1;
        distMap.set(nk, nd);
        if (nk === targetKey) return nd;
        next.push({ r: nr, c: nc });
      }
    }
    queue = next;
  }
  return null;
}

/** Count how many open corridors (adjacent empty cells) a point has. Higher = more mobility. */
function countOpenCorridors(r: number, c: number, board: Board, config: GameConfig): number {
  let count = 0;
  for (const d of DIRECTIONS) {
    const nr = r + d.dr;
    const nc = c + d.dc;
    if (!isInBounds(nr, nc, config.boardSize)) continue;
    if (board[nr][nc].type === CellType.Box) continue;
    if (isFixedObstacle(board[nr][nc].type)) continue;
    count++;
  }
  return count;
}

/** Count escape routes for the mouse (open corridors on the board, excluding cat position). */
function countMouseEscapeRoutes(mousePos: Point, board: Board, config: GameConfig, catPos: Point): number {
  let count = 0;
  for (const d of DIRECTIONS) {
    const nr = mousePos.r + d.dr;
    const nc = mousePos.c + d.dc;
    if (!isInBounds(nr, nc, config.boardSize)) continue;
    if (board[nr][nc].type === CellType.Box) continue;
    if (nr === catPos.r && nc === catPos.c) continue;
    count++;
  }
  return count;
}

/** Get the direction that moves from `from` toward `to` (Manhattan shortest). */
function bestDirection(from: Point, to: Point): Direction | null {
  let bestDr = 0;
  let bestDc = 0;
  let bestDist = Math.abs(from.r - to.r) + Math.abs(from.c - to.c);
  for (const d of DIRECTIONS) {
    const nr = from.r + d.dr;
    const nc = from.c + d.dc;
    const dist = Math.abs(nr - to.r) + Math.abs(nc - to.c);
    if (dist < bestDist) {
      bestDist = dist;
      bestDr = d.dr;
      bestDc = d.dc;
    }
  }
  return DIRECTIONS.find(d => d.dr === bestDr && d.dc === bestDc) || null;
}

/**
 * Simulate cat moving to (nr, nc) — potentially pushing a box.
 * Only clones the board if a box is actually pushed.
 */
function simulateCatMove(
  catPos: Point,
  nr: number,
  nc: number,
  board: Board,
  config: GameConfig,
  mousePos: Point,
  butterPositions: { r: number; c: number }[],
  trapPosition: Point | null = null,
): { catPos: Point; virtualBoard: Board | null; pushedBoxTo: Point | null } | null {
  const boardSize = config.boardSize;
  if (!isInBounds(nr, nc, boardSize)) return null;

  const targetCell = board[nr][nc];

  if (targetCell.type !== CellType.Box) {
    return { catPos: { r: nr, c: nc }, virtualBoard: null, pushedBoxTo: null };
  }

  const pushDr = nr - catPos.r;
  const pushDc = nc - catPos.c;
  const destR = nr + pushDr;
  const destC = nc + pushDc;

  if (!isInBounds(destR, destC, boardSize)) return null;
  if (isMouseHole(destR, destC, config.mouseHole)) return null;
  // Must match catMove exactly: cat cannot push a box onto mouse.
  if (mousePos.r === destR && mousePos.c === destC) return null;
  // Must match catMove exactly: cannot push into another box / pile / butter / trap.
  if (board[destR][destC].type === CellType.Box) return null;
  if (isFixedObstacle(board[destR][destC].type)) return null;
  if (hasButterAt(destR, destC, butterPositions)) return null;
  if (trapPosition && trapPosition.r === destR && trapPosition.c === destC) return null;

  const virtualBoard = cloneBoard(board);
  virtualBoard[catPos.r][catPos.c] = { ...virtualBoard[catPos.r][catPos.c], piece: undefined };
  virtualBoard[nr][nc] = { ...virtualBoard[nr][nc], type: CellType.Empty, piece: PieceType.Cat };
  virtualBoard[destR][destC] = { ...virtualBoard[destR][destC], type: CellType.Box, piece: undefined };

  return { catPos: { r: nr, c: nc }, virtualBoard, pushedBoxTo: { r: destR, c: destC } };
}

/**
 * Precompute adjacency info for the cat: which boxes are adjacent and can be pushed where.
 */
function computeCatBoxAdjacency(
  catPos: Point,
  board: Board,
  config: GameConfig,
  butterPositions: { r: number; c: number }[],
): { boxes: Point[]; pushable: { boxR: number; boxC: number; pushDir: Direction; destR: number; destC: number }[] } {
  const boxes: Point[] = [];
  const pushable: { boxR: number; boxC: number; pushDir: Direction; destR: number; destC: number }[] = [];

  for (const d of DIRECTIONS) {
    const br = catPos.r + d.dr;
    const bc = catPos.c + d.dc;
    if (!isInBounds(br, bc, config.boardSize)) continue;
    if (board[br][bc].type !== CellType.Box) continue;

    boxes.push({ r: br, c: bc });

    const destR = br + d.dr;
    const destC = bc + d.dc;
    if (!isInBounds(destR, destC, config.boardSize)) continue;
    if (isMouseHole(destR, destC, config.mouseHole)) continue;
    if (board[destR][destC].type === CellType.Box) continue;
    if (isFixedObstacle(board[destR][destC].type)) continue;
    if (hasButterAt(destR, destC, butterPositions)) continue;

    pushable.push({ boxR: br, boxC: bc, pushDir: d, destR, destC });
  }

  return { boxes, pushable };
}

// --- EASY AI ---

function catAiEasy(state: GameEngineState): GameEngineState | null {
  const catPos = state.catPosition;
  const mousePos = state.mousePosition;
  const { config } = state;
  const tunnelCorners = getTunnelCorners(config);

  // Collect truly valid move directions (must match catMove filters)
  const validDirs = DIRECTIONS.filter(d => {
    const nr = catPos.r + d.dr;
    const nc = catPos.c + d.dc;
    if (!isInBounds(nr, nc, config.boardSize)) return false;
    if (isMouseHole(nr, nc, config.mouseHole)) return false;
    if (isTunnelCorner(nr, nc, tunnelCorners)) return false;
    if (hasButterAt(nr, nc, state.butterPositions)) return false;
    if (isFixedObstacle(state.board[nr][nc].type)) return false;
    return true;
  });

  if (validDirs.length === 0) return null;

  const path = bfsPath(catPos, mousePos, state.board, config, state.blockedTunnels, state.trapPosition, state.butterPositions);

  let dir: Direction | null = null;

  if (path && path.length >= 2) {
    const next = path[1];
    dir = bestDirection(catPos, next);
    // Ensure chosen direction is actually valid and not a box
    if (!dir || !validDirs.includes(dir)) {
      dir = null;
    }
    if (dir && state.board[catPos.r + dir.dr][catPos.c + dir.dc].type === CellType.Box) {
      dir = null;
    }
  }

  if (!dir) {
    dir = bestDirection(catPos, mousePos);
    if (!dir || !validDirs.includes(dir)) dir = null;
    if (dir && state.board[catPos.r + dir.dr][catPos.c + dir.dc].type === CellType.Box) {
      dir = null;
    }
  }

  if (!dir) {
    // Fallback: pick valid direction closest to mouse, prefer non-reverse
    // Also exclude box directions (pushing is handled separately below)
    const nonBoxDirs = validDirs.filter(
      d => state.board[catPos.r + d.dr][catPos.c + d.dc].type !== CellType.Box,
    );
    dir = nonBoxDirs.length > 0
      ? nonBoxDirs.sort((a, b) => {
          const da = Math.abs(catPos.r + a.dr - mousePos.r) + Math.abs(catPos.c + a.dc - mousePos.c);
          const db = Math.abs(catPos.r + b.dr - mousePos.r) + Math.abs(catPos.c + b.dc - mousePos.c);
          return da - db;
        })[0]
      : validDirs[0]; // all neighbors are boxes — let catMove decide
  }

  // Prefer pushing a box toward the mouse over wandering in valid directions
  // This catches cases where the mouse is behind a box
  let bestPushDir: Direction | null = null;
  let bestPushDist = Infinity;
  for (const d of DIRECTIONS) {
    const nr = catPos.r + d.dr;
    const nc = catPos.c + d.dc;
    if (!isInBounds(nr, nc, config.boardSize)) continue;
    if (state.board[nr][nc].type !== CellType.Box) continue;
    // Check if pushing this box is valid (same checks as catMove simulateCatMove)
    const pushDr = d.dr, pushDc = d.dc;
    const destR = nr + pushDr, destC = nc + pushDc;
    if (!isInBounds(destR, destC, config.boardSize)) continue;
    if (isMouseHole(destR, destC, config.mouseHole)) continue;
    if (state.mousePosition.r === destR && state.mousePosition.c === destC) continue;
    if (state.board[destR][destC].type === CellType.Box &&
        !(state.mousePosition.r === destR && state.mousePosition.c === destC)) continue;
    if (isFixedObstacle(state.board[destR][destC].type)) continue;
    if (hasButterAt(destR, destC, state.butterPositions)) continue;
    if (state.trapPosition?.r === destR && state.trapPosition?.c === destC) continue;
    // Only consider pushes that get the cat closer to the mouse
    const mouseDist = Math.abs(nr - mousePos.r) + Math.abs(nc - mousePos.c);
    if (mouseDist < bestPushDist) {
      bestPushDist = mouseDist;
      bestPushDir = d;
    }
  }
  // Use push direction only if it's strictly better than the wandering direction
  if (bestPushDir) {
    const wanderDist = dir ? (Math.abs(catPos.r + dir.dr - mousePos.r) + Math.abs(catPos.c + dir.dc - mousePos.c)) : Infinity;
    if (bestPushDist < wanderDist) {
      dir = bestPushDir;
    }
  }

  // 10% randomness — pick a different valid direction
  if (validDirs.length > 1 && Math.random() < 0.1) {
    const otherDirs = validDirs.filter(d => !(d.dr === dir!.dr && d.dc === dir!.dc));
    if (otherDirs.length > 0) {
      dir = otherDirs[Math.floor(Math.random() * otherDirs.length)];
    }
  }

  return catMove(state, dir);
}

// --- MEDIUM AI ---

// Preserved as a historical baseline for the AI refactor. No longer wired into the
// difficulty switch (Medium now uses catAiHard); kept exported so it remains a
// reference/regression baseline and is not flagged as unused.
export function catAiMedium(state: GameEngineState): GameEngineState | null {
  const catPos = state.catPosition;
  const mousePos = state.mousePosition;
  const { config } = state;
  const boardSize = config.boardSize;
  const tunnelCorners = getTunnelCorners(config);

  // Detect last move direction to prevent oscillation
  const lastLog = state.catActionLog?.[state.catActionLog.length - 1] || '';
  const lastMoveMatch = lastLog.match(/\((\d+),(\d+)\)→\((\d+),(\d+)\)/);
  let lastDir: { dr: number; dc: number } | null = null;
  if (lastMoveMatch) {
    lastDir = {
      dr: parseInt(lastMoveMatch[3]) - parseInt(lastMoveMatch[1]),
      dc: parseInt(lastMoveMatch[4]) - parseInt(lastMoveMatch[2]),
    };
  }

  type MoveScore = { d: Direction; score: number; eval: EvalResult };
  const candidates: MoveScore[] = [];

  // --- Pre-compute strategic info ---
  let interceptTarget: Point | null = null;
  let mousePredictedPath: Point[] = [];

  if (!state.mouseHasButter) {
    // EARLY: intercept halfway to nearest butter
    let bestButterDist = Infinity;
    let bestButterPos: { r: number; c: number } | null = null;
    for (const bp of state.butterPositions) {
      const d = Math.abs(bp.r - mousePos.r) + Math.abs(bp.c - mousePos.c);
      if (d < bestButterDist) { bestButterDist = d; bestButterPos = bp; }
    }
    if (bestButterPos) {
      interceptTarget = {
        r: Math.round((mousePos.r + bestButterPos.r) / 2),
        c: Math.round((mousePos.c + bestButterPos.c) / 2),
      };
      mousePredictedPath = bfsPath(mousePos, bestButterPos, state.board, config, state.blockedTunnels, null, state.butterPositions) || [];
    }
  } else if (!state.mouseSkillActive) {
    // MID: intercept on mouse's path to hole
    const path = bfsPath(mousePos, config.mouseHole, state.board, config, state.blockedTunnels, null, state.butterPositions);
    if (path && path.length > 2) {
      mousePredictedPath = path;
      const idx = Math.max(1, Math.floor(path.length / 3));
      interceptTarget = path[idx];
    }
  } else {
    // LATE: just chase
    interceptTarget = mousePos;
  }

  // Precompute box adjacencies
  const boxAdj = computeCatBoxAdjacency(catPos, state.board, config, state.butterPositions);

  // Trap decision
  let shouldPlaceTrap = false;
  if (state.trapPosition === null && state.catTrapsRemaining > 0) {
    const distToMouse = Math.abs(catPos.r - mousePos.r) + Math.abs(catPos.c - mousePos.c);
    if (distToMouse <= 4) shouldPlaceTrap = true;
    if (interceptTarget) {
      const distToIntercept = Math.abs(catPos.r - interceptTarget.r) + Math.abs(catPos.c - interceptTarget.c);
      if (distToIntercept <= 3) shouldPlaceTrap = true;
    }
  }

  // Evaluate each direction
  for (const d of DIRECTIONS) {
    const nr = catPos.r + d.dr;
    const nc = catPos.c + d.dc;
    if (!isInBounds(nr, nc, boardSize)) continue;
    if (isMouseHole(nr, nc, config.mouseHole)) continue;
    if (isTunnelCorner(nr, nc, tunnelCorners)) continue;
    if (hasButterAt(nr, nc, state.butterPositions)) continue;
    if (isFixedObstacle(state.board[nr][nc].type)) continue;

    const sim = simulateCatMove(catPos, nr, nc, state.board, config, mousePos, state.butterPositions, state.trapPosition);
    if (!sim) continue;

    // Use virtual board if box pushed, otherwise original
    const evalBoard = sim.virtualBoard || state.board;
    const simCatPos = sim.catPos;

    let score = 0;

    // 0. Anti-oscillation: penalize reversing last direction
    if (lastDir && (d.dr === -lastDir.dr && d.dc === -lastDir.dc)) {
      score -= 200; // Strong penalty for going back the way we came
    }

    // BFS to mouse on correct board
    const bfsDistToMouse = bfsDistance(simCatPos, mousePos, evalBoard, config, state.blockedTunnels, null, state.butterPositions);
    // Don't discard candidates when BFS can't reach the mouse — boxes may be blocking.
    // Give a large penalty instead so the AI still considers the direction.
    if (bfsDistToMouse === null) {
      score -= 5000;
    } else {
      // 1. Distance to mouse (primary)
      score += (boardSize * 10 - bfsDistToMouse) * 3;

      // 3. Adjacency bonus
      if (bfsDistToMouse === 1) score += 500;
      if (bfsDistToMouse === 0) score += 10000;
    }

    // 2. Intercept scoring
    if (interceptTarget) {
      const bfsDistToIntercept = bfsDistance(simCatPos, interceptTarget, evalBoard, config, state.blockedTunnels, null, state.butterPositions);
      if (bfsDistToIntercept !== null) {
        score += (boardSize * 10 - bfsDistToIntercept) * 2;
      }
    }

    // 4. Tunnel blocking
    if (sim.pushedBoxTo) {
      const tb = sim.pushedBoxTo;
      if (tunnelCorners.some(t => t.r === tb.r && t.c === tb.c) &&
          !state.blockedTunnels.some(bt => bt.r === tb.r && bt.c === tb.c)) {
        const distToHole = Math.abs(tb.r - config.mouseHole.r) + Math.abs(tb.c - config.mouseHole.c);
        score += 300 + Math.max(0, 40 - distToHole) * 15;
      }
    }

    // 5. Near a pushable box for tunnel blocking
    if (!sim.pushedBoxTo && boxAdj.pushable.length > 0) {
      for (const pb of boxAdj.pushable) {
        const tunnel = tunnelCorners.find(t => t.r === pb.destR && t.c === pb.destC);
        if (tunnel && !state.blockedTunnels.some(bt => bt.r === pb.destR && bt.c === pb.destC)) {
          score += 200;
        }
      }
    }

    // 6. Proximity to mouse's predicted path
    if (mousePredictedPath.length > 0) {
      for (const pn of mousePredictedPath) {
        const pd = Math.abs(simCatPos.r - pn.r) + Math.abs(simCatPos.c - pn.c);
        if (pd === 0) score += 100;
        else if (pd === 1) score += 50;
        else if (pd === 2) score += 20;
      }
    }

    // 7. Close to mouse hole when mouse has butter (cut off escape)
    if (state.mouseHasButter && !state.mouseSkillActive) {
      const distToHole = Math.abs(simCatPos.r - config.mouseHole.r) + Math.abs(simCatPos.c - config.mouseHole.c);
      score += Math.max(0, (boardSize - distToHole)) * 2;
    }

    candidates.push({ d, score, eval: {
      score, bfsDistToMouse, bfsDistToIntercept: null,
      mouseEscapeRoutes: countMouseEscapeRoutes(mousePos, evalBoard, config, simCatPos),
      catMobility: countOpenCorridors(simCatPos.r, simCatPos.c, evalBoard, config),
      mouseMobility: countOpenCorridors(mousePos.r, mousePos.c, evalBoard, config),
      isBoxPush: sim.pushedBoxTo !== null,
      pushedBoxToTunnel: false,
      trapProximity: Infinity,
      scoreNotes: [],
    }});
  }

  if (candidates.length === 0) {
    // No valid moves found (BFS can't reach mouse through obstacles).
    // Walk toward mouse while avoiding reversing last direction (prevent oscillation).
    let fallbackDir: Direction | null = null;
    let fallbackBestDist = Infinity;

    for (const d of DIRECTIONS) {
      const nr = catPos.r + d.dr;
      const nc = catPos.c + d.dc;
      if (!isInBounds(nr, nc, boardSize)) continue;
      if (isMouseHole(nr, nc, config.mouseHole)) continue;
      if (isTunnelCorner(nr, nc, tunnelCorners)) continue;
      if (hasButterAt(nr, nc, state.butterPositions)) continue;
      if (isFixedObstacle(state.board[nr][nc].type)) continue;

      // Penalize reversing last direction to prevent oscillation
      if (lastDir && (d.dr === -lastDir.dr && d.dc === -lastDir.dc)) continue;

      const dist = Math.abs(nr - mousePos.r) + Math.abs(nc - mousePos.c);
      if (dist < fallbackBestDist) {
        fallbackBestDist = dist;
        fallbackDir = d;
      }
    }

    if (fallbackDir) {
      return catMove(state, fallbackDir);
    }

    // Truly stuck — place trap if available
    if (state.trapPosition === null && state.catTrapsRemaining > 0) return catPlaceTrap(state);
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // 5% randomness
  if (candidates.length > 1 && Math.random() < 0.05) {
    return catMove(state, candidates[1].d);
  }

  // Trap placement override
  if (shouldPlaceTrap && state.catTrapsRemaining > 0 && best.score < 500) {
    return catPlaceTrap(state);
  }

  return catMove(state, best.d);
}

// --- HARD AI: Full strategic intelligence ---

/**
 * Hard AI: Complete strategic cat with:
 * - Multi-dimensional scoring (chase, intercept, tunnel block, trap, squeeze)
 * - Area control (compress mouse mobility)
 * - Resource management (optimal trap timing)
 * - Adaptive tactics (different strategy per game phase)
 * - Lookahead simulation (evaluates consequences of box pushes)
 */

/** Find the best reachable intercept point on the mouse's path when the
 *  real entry gate is unreachable. Picks the point where the cat can
 *  arrive earliest relative to the mouse. Skips entryGate, mouse hole,
 *  and active trap cell. Uses two-layer selection: strict (cat arrives
 *  first or same time) then pressure (closest reachable). */
function findBestReachableInterceptOnMousePath(
  state: GameEngineState,
  path: Point[],
  entryGate: Point | null,
): Point | null {
  let bestStrict: { point: Point; catDist: number; slack: number } | null = null;
  let bestPressure: { point: Point; catDist: number; slack: number } | null = null;

  for (let i = 1; i < path.length; i++) {
    const p = path[i];
    if (isMouseHole(p.r, p.c, state.config.mouseHole)) continue;

    if (
      entryGate &&
      p.r === entryGate.r &&
      p.c === entryGate.c
    ) {
      continue;
    }

    if (
      state.trapPosition &&
      p.r === state.trapPosition.r &&
      p.c === state.trapPosition.c
    ) {
      continue;
    }

    const catPath = bfsCatPathToStand(state.catPosition, p, state);
    if (!catPath) continue;

    const catDist = catPath.length - 1;
    const mouseStep = i;
    const slack = mouseStep - catDist;

    if (slack >= 0) {
      if (
        !bestStrict ||
        catDist < bestStrict.catDist ||
        (catDist === bestStrict.catDist && slack > bestStrict.slack)
      ) {
        bestStrict = { point: p, catDist, slack };
      }
    }

    if (
      !bestPressure ||
      catDist < bestPressure.catDist ||
      (catDist === bestPressure.catDist && slack > bestPressure.slack)
    ) {
      bestPressure = { point: p, catDist, slack };
    }
  }

  return bestStrict?.point ?? bestPressure?.point ?? null;
}

function catAiHard(state: GameEngineState): GameEngineState | null {
  const catPos = state.catPosition;
  const mousePos = state.mousePosition;
  const { config } = state;
  const boardSize = config.boardSize;
  const tunnelCorners = getTunnelCorners(config);

  // === IMMEDIATE CATCH: if cat can reach mouse within remaining moves, do it ===
  {
    const catchPath = bfsPath(catPos, mousePos, state.board, config, state.blockedTunnels, null, state.butterPositions);
    // catchPath format: [start, step1, step2, ..., target] — index 0 = catPos
    const stepsToMouse = catchPath ? catchPath.length - 1 : 0;
    if (catchPath && stepsToMouse > 0 && stepsToMouse <= state.catMovesLeft) {
      const next = catchPath[1]; // first step toward mouse
      const dir = DIRECTIONS.find(d => d.dr === next.r - catPos.r && d.dc === next.c - catPos.c) || null;
      if (dir) {
        state = logAction(state, `HARD_CATCH stepsToMouse=${stepsToMouse} next=(${next.r},${next.c})`);
        return catMove(state, dir);
      }
    }
  }

  // Helper: check if a gate cell is already covered by the cat's active trap
  const isGateCoveredByTrap = (gate: Point): boolean =>
    !!state.trapPosition &&
    state.trapPosition.r === gate.r &&
    state.trapPosition.c === gate.c;

  // Detect last move direction to prevent oscillation
  const lastLog = state.catActionLog?.[state.catActionLog.length - 1] || '';
  const lastMoveMatch = lastLog.match(/\((\d+),(\d+)\)→\((\d+),(\d+)\)/);
  let lastDir: { dr: number; dc: number } | null = null;
  if (lastMoveMatch) {
    lastDir = {
      dr: parseInt(lastMoveMatch[3]) - parseInt(lastMoveMatch[1]),
      dc: parseInt(lastMoveMatch[4]) - parseInt(lastMoveMatch[2]),
    };
  }

  type MoveScore = { d: Direction; score: number; eval: EvalResult };
  const candidates: MoveScore[] = [];

  // ================================================================
  // PHASE 1: Pre-compute strategic information (ONCE per turn)
  // ================================================================

  // 1a. Build tactical mouse plans.
  // Hard AI should not assume a single mouse path. It should consider:
  // - carrying butter -> nearest hole
  // - no butter -> best butter
  // - carrying butter but may use skill -> another butter chain
  const mousePlans = buildMousePlansForHard(state);
  const primaryPlan = mousePlans[0] || null;

  let mousePredictedPath: Point[] = primaryPlan?.path || [];

  const holeGateCells = getMouseHoleGateCells(state);

  // Determine hole defense mode based on hole position and gate count
  const hole = state.config.mouseHole;
  const touchesTop = hole.r <= 0;
  const touchesLeft = hole.c <= 0;
  const touchesBottom = hole.r + hole.size >= boardSize;
  const touchesRight = hole.c + hole.size >= boardSize;
  const edgeTouchCount = [touchesTop, touchesBottom, touchesLeft, touchesRight].filter(Boolean).length;

  let holeDefenseMode: HoleDefenseMode;
  if (edgeTouchCount >= 2 || holeGateCells.length <= 3) {
    holeDefenseMode = 'corner';
  } else if (edgeTouchCount === 1 || holeGateCells.length <= 5) {
    holeDefenseMode = 'edge';
  } else {
    holeDefenseMode = 'open';
  }

  // 1b. Emergency hole block detection — highest priority after direct catch.
  // When mouse carries butter (or can chain skill+butters) and is about to enter the hole,
  // find the real entry gate and block it. This overrides generic gate scoring.
  const emergencyDecision = findEmergencyHoleBlockDecision(state, mousePlans);

  const entryGate = emergencyDecision?.entryGate ?? null;
  const mouseEtaToHole = emergencyDecision?.mouseEta ?? Infinity;

  // Adjust emergency eta limit by defense mode
  const emergencyEtaLimit =
    holeDefenseMode === 'corner'
      ? state.config.mouseBaseMoves + 3
      : holeDefenseMode === 'edge'
        ? state.config.mouseCarryingMoves + 2
        : state.config.mouseCarryingMoves + 1;

  const emergencyHoleBlock =
    !!emergencyDecision &&
    !!entryGate &&
    state.mouseHasButter &&
    !state.mouseSkillActive &&
    mouseEtaToHole <= emergencyEtaLimit;

  // Reachability check: can the cat actually reach the entry gate in time?
  let canBlockEntryInTime = false;
  let catEtaToEntry = Infinity;
  if (emergencyHoleBlock && entryGate) {
    const catPathToEntry = bfsCatPathToStand(state.catPosition, entryGate, state);
    catEtaToEntry = catPathToEntry ? catPathToEntry.length - 1 : Infinity;
    canBlockEntryInTime =
      catEtaToEntry <= state.catMovesLeft + 1 ||
      catEtaToEntry <= mouseEtaToHole + 1;
  }
  const emergencyBlockActive = emergencyHoleBlock && canBlockEntryInTime;
  const emergencyFallbackActive = emergencyHoleBlock && !canBlockEntryInTime;

  // 1c. Compute strategic target.
  // Important: if mouse has butter, target a gate outside the hole, not the hole cell itself.
  let interceptTarget: Point | null = chooseHardStrategicTarget(state, mousePlans, holeGateCells, holeDefenseMode, mouseEtaToHole);
  let optimalTrapPos: Point | null = interceptTarget;

  if (!interceptTarget && mousePredictedPath.length >= 3) {
    const idx = Math.max(1, Math.floor(mousePredictedPath.length / 3));
    interceptTarget = mousePredictedPath[idx];
  }

  // Override: emergency hole block takes priority over everything.
  if (emergencyBlockActive && entryGate) {
    interceptTarget = entryGate;
    optimalTrapPos = entryGate;
    state = logAction(
      state,
      `HARD_EMERGENCY_BLOCK kind=${emergencyDecision!.kind} entry=(${entryGate.r},${entryGate.c}) mouseEta=${mouseEtaToHole} catEta=${catEtaToEntry} path=${emergencyDecision!.path.map(p => `${p.r},${p.c}`).join('|')}`,
    );
  }

  // Emergency entry is unreachable — fall back to intercepting mouse path.
  if (emergencyFallbackActive && entryGate) {
    state = logAction(
      state,
      `HARD_EMERGENCY_BLOCK_UNREACHABLE entry=(${entryGate.r},${entryGate.c}) mouseEta=${mouseEtaToHole} catEta=${catEtaToEntry}`,
    );
    if (emergencyDecision && emergencyDecision.path.length >= 2) {
      const fallbackIntercept = findBestReachableInterceptOnMousePath(
        state,
        emergencyDecision.path,
        entryGate,
      );
      if (fallbackIntercept) {
        interceptTarget = fallbackIntercept;
        optimalTrapPos = fallbackIntercept;
        state = logAction(
          state,
          `HARD_EMERGENCY_FALLBACK_INTERCEPT target=(${fallbackIntercept.r},${fallbackIntercept.c}) entry=(${entryGate.r},${entryGate.c}) mouseEta=${mouseEtaToHole} catEta=${catEtaToEntry}`,
        );
      } else {
        state = logAction(
          state,
          `HARD_EMERGENCY_FALLBACK_NONE entry=(${entryGate.r},${entryGate.c}) mouseEta=${mouseEtaToHole} catEta=${catEtaToEntry}`,
        );
        // Do not keep entryGate-like target when fallback failed.
        // Prefer direct pressure on mouse.
        interceptTarget = state.mousePosition;
        optimalTrapPos = state.mousePosition;
      }
    }
  }

  // === Phase 1.5: Cat already on real entry gate ===
  // If cat is standing on the real entry gate with a trap, place it immediately,
  // then end the turn — do not continue to candidate scoring.
  if (
    emergencyBlockActive &&
    entryGate &&
    state.catPosition.r === entryGate.r &&
    state.catPosition.c === entryGate.c &&
    state.trapPosition === null &&
    state.catTrapsRemaining > 0
  ) {
    state = logAction(
      state,
      `HARD_EMERGENCY_TRAP_ENTRY at=(${entryGate.r},${entryGate.c}) kind=${emergencyDecision.kind}`,
    );
    const trapped = catPlaceTrap(state);
    return trapped;
  }

  // Cat standing on any hole gate cell with a trap available and mouse
  // carrying butter near the hole — place trap immediately.
  const catOnAnyHoleGate = holeGateCells.some(
    gate =>
      gate.r === state.catPosition.r &&
      gate.c === state.catPosition.c,
  );

  const shouldTrapCurrentHoleGate =
    state.trapPosition === null &&
    state.catTrapsRemaining > 0 &&
    state.mouseHasButter &&
    mouseEtaToHole !== Infinity &&
    mouseEtaToHole <= state.config.mouseCarryingMoves + 1 &&
    catOnAnyHoleGate;

  if (shouldTrapCurrentHoleGate) {
    state = logAction(
      state,
      `HARD_HOLE_GATE_TRAP place_gate at=(${state.catPosition.r},${state.catPosition.c}) mouseEta=${mouseEtaToHole}`,
    );
    return catPlaceTrap(state);
  }

  // If cat is standing on the real entry gate but has no trap to place,
  // and the mouse is very close to the hole, hold position.
  // Otherwise, cat should continue moving to intercept or pressure.
  const trapAtEntry =
    !!entryGate &&
    !!state.trapPosition &&
    state.trapPosition.r === entryGate.r &&
    state.trapPosition.c === entryGate.c;

  if (
    emergencyBlockActive &&
    entryGate &&
    state.catPosition.r === entryGate.r &&
    state.catPosition.c === entryGate.c &&
    !trapAtEntry &&
    state.catTrapsRemaining <= 0 &&
    mouseEtaToHole <= state.config.mouseCarryingMoves
  ) {
    state = logAction(
      state,
      `HARD_EMERGENCY_HOLD_ENTRY at=(${entryGate.r},${entryGate.c}) kind=${emergencyDecision.kind}`,
    );
    return endTurn({ ...state, catMovesLeft: 0 });
  }

  // 1c. Tunnel priority remains as secondary tactic.
  const tunnelPriority: { r: number; c: number; value: number }[] = tunnelCorners
    .filter(tc => !state.blockedTunnels.some(b => b.r === tc.r && b.c === tc.c))
    .map(tc => ({
      r: tc.r,
      c: tc.c,
      value: Math.max(0, 60 - (Math.abs(tc.r - config.mouseHole.r) + Math.abs(tc.c - config.mouseHole.c)) * 8),
    }))
    .sort((a, b) => b.value - a.value);

  // 1d. Optimal trap position follows intercept target (may be overridden by emergency block).

  // 1e. Precompute box adjacencies for tunnel blocking analysis.
  const boxAdj = computeCatBoxAdjacency(catPos, state.board, config, state.butterPositions);

  // 1f. Extract recent cat positions from action log for loop detection.
  const recentPositions: { r: number; c: number }[] = [];
  const recentEdges: { from: Point; to: Point }[] = [];
  const lastLogs = state.catActionLog?.slice(-30) || [];

  for (const log of lastLogs) {
    const m = log.match(/\((\d+),(\d+)\)→\((\d+),(\d+)\)/);
    if (m) {
      const from: Point = { r: parseInt(m[1]), c: parseInt(m[2]) };
      const to: Point = { r: parseInt(m[3]), c: parseInt(m[4]) };
      recentPositions.push(to);
      recentEdges.push({ from, to });
    }
  }

  const recentToPositions = recentPositions.slice(-12);
  const recentToEdges = recentEdges.slice(-12);

  // 1g. Trap placement decision.
  // New rule: choose a stand cell the cat should move to, then place trap underneath.
  // Do NOT place remotely — the cat must walk to the cell first.

  const planStr = mousePlans
    .map(p => `${p.kind}:${p.path.length - 1}:w${p.weight.toFixed(1)}`)
    .join(',');

  state = logAction(
    state,
    `HARD_PLAN target=${interceptTarget ? `(${interceptTarget.r},${interceptTarget.c})` : 'none'} gates=${holeGateCells.length} mode=${holeDefenseMode} trap=${state.trapPosition ? `(${state.trapPosition.r},${state.trapPosition.c})` : 'none'} trapsLeft=${state.catTrapsRemaining} plans=[${planStr || 'none'}]`,
  );

  const rawTrapStandDecision =
    !emergencyBlockActive &&
    !emergencyFallbackActive &&
    state.trapPosition === null &&
    state.catTrapsRemaining > 0
      ? chooseHardTrapStandCell(state, mousePlans, holeGateCells)
      : null;

  const trapStandDecision =
    shouldCommitTrapPlan(state, rawTrapStandDecision, mousePlans)
      ? rawTrapStandDecision
      : null;

  if (rawTrapStandDecision && !trapStandDecision) {
    state = logAction(
      state,
      `HARD_TRAP_PLAN skip_commit stand=(${rawTrapStandDecision.stand.r},${rawTrapStandDecision.stand.c}) score=${rawTrapStandDecision.score} pathLen=${rawTrapStandDecision.path.length - 1}`,
    );
  }

  if (trapStandDecision) {
    state = logAction(
      state,
      `HARD_TRAP_PLAN stand=(${trapStandDecision.stand.r},${trapStandDecision.stand.c}) score=${trapStandDecision.score} reason=${trapStandDecision.reason}`,
    );
  }

  // If cat is already on the stand cell, place trap here.
  if (
    trapStandDecision &&
    state.catPosition.r === trapStandDecision.stand.r &&
    state.catPosition.c === trapStandDecision.stand.c
  ) {
    state = logAction(
      state,
      `HARD_TRAP place_current reason=${trapStandDecision.reason} at=(${state.catPosition.r},${state.catPosition.c}) score=${trapStandDecision.score}`,
    );
    return catPlaceTrap(state);
  }

  // If cat is not yet on the stand cell, steer movement toward it.
  if (trapStandDecision) {
    interceptTarget = trapStandDecision.stand;
    optimalTrapPos = trapStandDecision.stand;
  }

  // ================================================================
  // PHASE 2: Evaluate each possible direction
  // ================================================================

  for (const d of DIRECTIONS) {
    const nr = catPos.r + d.dr;
    const nc = catPos.c + d.dc;
    if (!isInBounds(nr, nc, boardSize)) continue;
    if (isMouseHole(nr, nc, config.mouseHole)) continue;
    if (isTunnelCorner(nr, nc, tunnelCorners)) continue;
    if (hasButterAt(nr, nc, state.butterPositions)) continue;
    if (isFixedObstacle(state.board[nr][nc].type)) continue;

    const sim = simulateCatMove(catPos, nr, nc, state.board, config, mousePos, state.butterPositions, state.trapPosition);
    if (!sim) continue;

    const simCatPos = sim.catPos;
    const evalBoard = sim.virtualBoard || state.board;
    const isBoxPush = sim.pushedBoxTo !== null;

    let score = 0;
    let evalResult: EvalResult;
    let scoreNotes: string[] = [];

    // 0. Anti-oscillation: soft penalty for reversing last direction.
    // Don't hard-block — the cat may need to reverse to intercept the mouse carrying butter.
    const isReverse = lastDir && (d.dr === -lastDir.dr && d.dc === -lastDir.dc);
    if (isReverse) {
      const canCatch = simCatPos.r === mousePos.r && simCatPos.c === mousePos.c;
      if (canCatch) {
        // Allowed: reversing to catch the mouse
      } else {
        // Soft penalty: 0 when mouse has butter (cat must be able to reverse to block hole)
        // Otherwise small penalty to discourage immediate reversal without purpose
        const reversePenalty = 500;
        score -= reversePenalty;
        scoreNotes.push(`anti-osc-reverse:-${reversePenalty}`);
      }
    }

    // 0b. Long-loop prevention: penalize visiting recently-visited positions
    const isRecentPos = recentToPositions.some(p => p.r === simCatPos.r && p.c === simCatPos.c);
    if (isRecentPos) {
      score -= 600;
      scoreNotes.push('recent-pos:-600');
    }

    // 0c. Edge repetition: penalize traversing recently-used edges or reverse edges
    const isRecentEdge = recentToEdges.some(e => e.from.r === catPos.r && e.from.c === catPos.c && e.to.r === simCatPos.r && e.to.c === simCatPos.c);
    const isReverseEdge = recentToEdges.some(e => e.to.r === catPos.r && e.to.c === catPos.c && e.from.r === simCatPos.r && e.from.c === simCatPos.c);
    if (isReverseEdge) {
      score -= 800;
      scoreNotes.push('reverse-edge:-800');
    } else if (isRecentEdge) {
      score -= 400;
      scoreNotes.push('recent-edge:-400');
    }

    // Avoid walking onto our own active trap (don't self-reclaim unnecessarily).
    if (
      state.trapPosition &&
      simCatPos.r === state.trapPosition.r &&
      simCatPos.c === state.trapPosition.c
    ) {
      const trapOnAnyPlan = mousePlans.some(plan => {
        const idx = pathIndexOf(plan.path, state.trapPosition!);
        return idx > 0 && idx <= plan.nextTurnBudget + 8;
      });

      const trapNearAnyPlan = mousePlans.some(plan =>
        plan.path.some((p, i) =>
          i > 0 &&
          i <= plan.nextTurnBudget + 8 &&
          manhattan(p, state.trapPosition!) <= 1
        )
      );

      const trapIsHoleGate = holeGateCells.some(g =>
        g.r === state.trapPosition!.r &&
        g.c === state.trapPosition!.c
      );

      const mouseThreateningHole =
        state.mouseHasButter &&
        !state.mouseSkillActive &&
        mousePlans.some(p =>
          p.kind === 'carry_to_hole' &&
          p.path.length - 1 <= state.config.mouseCarryingMoves + 4
        );

      const trapStillRelevant =
        trapOnAnyPlan ||
        trapNearAnyPlan ||
        (trapIsHoleGate && mouseThreateningHole);

      if (trapStillRelevant) {
        score -= 50000;
        scoreNotes.push('forbid-reclaim-active-trap:-50000');
      } else {
        score -= 8000;
        scoreNotes.push('avoid-reclaim-expired-trap:-8000');
      }
    }

    // If we committed to a trap stand cell, strongly encourage following the path.
    if (
      trapStandDecision &&
      trapStandDecision.nextStep &&
      state.trapPosition === null &&
      !emergencyBlockActive &&
      !emergencyFallbackActive
    ) {
      const isTrapNextStep =
        simCatPos.r === trapStandDecision.nextStep.r &&
        simCatPos.c === trapStandDecision.nextStep.c;

      if (isTrapNextStep) {
        score += 6500;
        scoreNotes.push('follow-trap-stand-next:+6500');
      } else if (trapStandDecision.score >= 3000) {
        score -= 800;
        scoreNotes.push('not-following-trap-stand:-800');
      }
    }

    // BFS distances on the correct board
    const bfsDistToMouse = bfsDistance(simCatPos, mousePos, evalBoard, config, state.blockedTunnels, null, state.butterPositions);
    // Don't discard candidates when BFS can't reach the mouse — boxes may be blocking the path.
    // Instead, give a heavy penalty so the AI still considers the direction but deprioritizes it.
    if (bfsDistToMouse === null) {
      score -= 5000; // Large penalty for being unable to reach the mouse
    } else {
      // ----------------------------------------------------------
      // SCORE 1: CORE CHASE — BFS distance to mouse
      // When mouse has butter, de-emphasize direct chase in favor of intercept
      // ----------------------------------------------------------
      if (state.mouseHasButter && !state.mouseSkillActive) {
        score += (boardSize * 8 - bfsDistToMouse) * 2;
        if (bfsDistToMouse === 1) score += 2000;
        if (bfsDistToMouse === 0) score += 50000;

        // Carrying chase pressure — scale by hole defense mode
        const chasePressure =
          holeDefenseMode === 'corner'
            ? Math.max(0, 4000 - bfsDistToMouse * 450)
            : holeDefenseMode === 'edge'
              ? Math.max(0, 8000 - bfsDistToMouse * 800)
              : Math.max(0, 12000 - bfsDistToMouse * 1000);
        score += chasePressure;
        scoreNotes.push(`carrying-chase-pressure:+${chasePressure}`);
        scoreNotes.push(`mouse-carrying-dist-to-mouse=${bfsDistToMouse}`);
      } else {
        score += (boardSize * 12 - bfsDistToMouse) * 5;
        if (bfsDistToMouse === 1) score += 5000;
        if (bfsDistToMouse === 0) score += 100000;
      }
    }

    // ----------------------------------------------------------
    // SCORE 2: INTERCEPT — distance to intercept target
    if (interceptTarget) {
      const bfsDistToIntercept = bfsDistance(
        simCatPos, interceptTarget, evalBoard, config,
        state.blockedTunnels, null, state.butterPositions,
      );

      if (bfsDistToIntercept !== null && bfsDistToIntercept < 30) {
        const targetWeight = state.mouseHasButter && !state.mouseSkillActive ? 12 : 8;
        score += (boardSize * 12 - bfsDistToIntercept) * targetWeight;
        scoreNotes.push(`targetDist=${bfsDistToIntercept}`);
      }
    }

    // SCORE 2b: When mouse has butter, strongly reward guarding legal gate cells outside the hole.
    // Scale all gate scores by holeDefenseMode.
    if (state.mouseHasButter && !state.mouseSkillActive) {
      // Mode-scaled constants
      const entryGateOnBonus =
        holeDefenseMode === 'corner' ? 50000 :
        holeDefenseMode === 'edge' ? 18000 : 6000;
      const entryGateBaseBonus =
        holeDefenseMode === 'corner' ? 30000 :
        holeDefenseMode === 'edge' ? 12000 : 4000;
      const entryGateDistPenalty =
        holeDefenseMode === 'corner' ? 2500 :
        holeDefenseMode === 'edge' ? 1500 : 800;
      const uncoveredGateBaseBonus =
        holeDefenseMode === 'corner' ? 18000 :
        holeDefenseMode === 'edge' ? 6000 : 2500;
      const uncoveredGateDistPenalty =
        holeDefenseMode === 'corner' ? 2000 :
        holeDefenseMode === 'edge' ? 1000 : 500;

      const isOwnTrapCell =
        state.trapPosition &&
        simCatPos.r === state.trapPosition.r &&
        simCatPos.c === state.trapPosition.c;
      if (!isOwnTrapCell) {
        // During emergency, prioritise the real entry gate if not yet covered by trap,
        // AND give uncovered holeGateCells secondary defense scores.
        if (emergencyBlockActive && entryGate) {
          const entryCovered = isGateCoveredByTrap(entryGate);

          if (!entryCovered) {
            const distToEntry = bfsDistance(
              simCatPos, entryGate, evalBoard, config,
              state.blockedTunnels, null, state.butterPositions,
            );
            if (simCatPos.r === entryGate.r && simCatPos.c === entryGate.c) {
              score += entryGateOnBonus;
              scoreNotes.push(`on-real-entry-gate:+${entryGateOnBonus} mode=${holeDefenseMode}`);
            } else if (distToEntry !== null) {
              score += Math.max(0, entryGateBaseBonus - distToEntry * entryGateDistPenalty);
              scoreNotes.push(`real-entry-gate-dist=${distToEntry} mode=${holeDefenseMode}`);
            }
          } else {
            scoreNotes.push('entry-gate-covered-by-trap');
          }

          // Score best uncovered holeGate for multi-entrance defense (single best, not cumulative)
          let bestUncoveredGate:
            | { gate: Point; dist: number; bonus: number }
            | null = null;

          for (const gate of holeGateCells) {
            if (isGateCoveredByTrap(gate)) {
              scoreNotes.push('gate-trap-covered');
              continue;
            }
            // Skip entryGate here — it's already scored above (or skipped if covered)
            if (gate.r === entryGate.r && gate.c === entryGate.c && !entryCovered) continue;

            const distToGate = bfsDistance(
              simCatPos, gate, evalBoard, config,
              state.blockedTunnels, null, state.butterPositions,
            );
            if (distToGate === null) continue;

            const bonus = Math.max(0, uncoveredGateBaseBonus - distToGate * uncoveredGateDistPenalty);

            if (
              !bestUncoveredGate ||
              bonus > bestUncoveredGate.bonus ||
              (bonus === bestUncoveredGate.bonus && distToGate < bestUncoveredGate.dist)
            ) {
              bestUncoveredGate = { gate, dist: distToGate, bonus };
            }
          }

          if (bestUncoveredGate) {
            score += bestUncoveredGate.bonus;

            scoreNotes.push(
              `best-uncovered-hole-gate=(${bestUncoveredGate.gate.r},${bestUncoveredGate.gate.c}) mode=${holeDefenseMode}`,
            );

            if (bestUncoveredGate.dist === 0) {
              scoreNotes.push(`on-best-uncovered-hole-gate:+${bestUncoveredGate.bonus}`);
            } else {
              scoreNotes.push(`best-uncovered-hole-gate-dist=${bestUncoveredGate.dist}`);
            }
          }
        } else if (!emergencyFallbackActive) {
          const normalHoleGateBonus =
            holeDefenseMode === 'corner' ? 2200 :
            holeDefenseMode === 'edge' ? 1200 : 300;
          const uncoveredNormalGateBonus =
            holeDefenseMode === 'corner' ? 1000 :
            holeDefenseMode === 'edge' ? 500 : 0;

          for (const gate of holeGateCells) {
            if (isGateCoveredByTrap(gate)) {
              score -= 1000;
              scoreNotes.push('gate-trap-covered:-1000');
              continue;
            }

            const dist = manhattan(simCatPos, gate);
            if (dist === 0) {
              score += normalHoleGateBonus + uncoveredNormalGateBonus;
              scoreNotes.push(`on-hole-gate:+${normalHoleGateBonus}`);
              if (uncoveredNormalGateBonus > 0) {
                scoreNotes.push(`uncovered-hole-gate:+${uncoveredNormalGateBonus}`);
              }
            } else if (dist === 1) {
              score += 700;
            } else if (dist === 2) {
              score += 200;
            }
          }
        }
      }
    }

    // SCORE 2c: Fallback intercept — when the real entry gate is unreachable,
    // give the fallback target a high score so the cat prioritises it.
    if (emergencyFallbackActive && interceptTarget) {
      if (
        simCatPos.r === interceptTarget.r &&
        simCatPos.c === interceptTarget.c
      ) {
        score += 18000;
        scoreNotes.push('on-emergency-fallback:+18000');
      } else {
        const distToFallback = bfsDistance(
          simCatPos, interceptTarget, evalBoard, config,
          state.blockedTunnels, null, state.butterPositions,
        );
        if (distToFallback !== null) {
          const bonus = Math.max(0, 12000 - distToFallback * 1500);
          score += bonus;
          scoreNotes.push(`emergency-fallback-dist=${distToFallback}`);
        }
      }
    }

    // ----------------------------------------------------------
    // SCORE 3: TUNNEL BLOCKING — strategic box pushing
    // ----------------------------------------------------------

    // 3a. Actual box push onto tunnel (just happened)
    if (sim.pushedBoxTo) {
      const pushedToTunnel = tunnelCorners.some(t => t.r === sim.pushedBoxTo!.r && t.c === sim.pushedBoxTo!.c) &&
        !state.blockedTunnels.some(bt => bt.r === sim.pushedBoxTo!.r && bt.c === sim.pushedBoxTo!.c);
      if (pushedToTunnel) {
        // Only bonus if push actually helps: cat closer to mouse or blocking tunnel near hole
        score += 600;
      } else {
        // Pushing a box that doesn't block a tunnel — slight penalty (wastes a move)
        score -= 50;
      }
    }

    // 3b. Near a pushable box that leads to a high-value tunnel
    if (boxAdj.pushable) {
      for (const pb of boxAdj.pushable) {
        const isTunnelDest = tunnelCorners.some(t => t.r === pb.destR && t.c === pb.destC);
        if (isTunnelDest && !state.blockedTunnels.some(bt => bt.r === pb.destR && bt.c === pb.destC)) {
          // Find the tunnel value
          const tunnel = tunnelCorners.find(t => t.r === pb.destR && t.c === pb.destC);
          if (tunnel) {
            const distToHole = Math.abs(pb.destR - config.mouseHole.r) + Math.abs(pb.destC - config.mouseHole.c);
            const tunnelVal = Math.max(0, 60 - distToHole * 8);
            score += tunnelVal + 400;
          }
        }
      }
    }

    // 3c. Proximity to high-priority tunnels (can reach in future turns)
    for (const tunnel of tunnelPriority) {
      const distToTunnel = Math.abs(simCatPos.r - tunnel.r) + Math.abs(simCatPos.c - tunnel.c);
      if (distToTunnel <= 2) {
        score += tunnel.value * 0.5; // approaching tunnel is valuable
      }
    }

    // ----------------------------------------------------------
    // SCORE 3d: PUSH SHORTCUT — reward pushes that open a shorter
    // path to the strategic target (interceptTarget / entryGate)
    // ----------------------------------------------------------
    if (isBoxPush && sim.pushedBoxTo && interceptTarget) {
      const beforeDist = bfsDistance(
        catPos, interceptTarget, state.board, config,
        state.blockedTunnels, null, state.butterPositions,
      );
      const afterBlockedTunnels =
        isTunnelCorner(sim.pushedBoxTo.r, sim.pushedBoxTo.c, tunnelCorners) &&
        !state.blockedTunnels.some(bt => bt.r === sim.pushedBoxTo!.r && bt.c === sim.pushedBoxTo!.c)
          ? [...state.blockedTunnels, { r: sim.pushedBoxTo.r, c: sim.pushedBoxTo.c }]
          : state.blockedTunnels;
      const afterDist = bfsDistance(
        simCatPos, interceptTarget, evalBoard, config,
        afterBlockedTunnels, null, state.butterPositions,
      );

      if (beforeDist !== null && afterDist !== null) {
        const gain = beforeDist - afterDist;
        if (gain > 0) {
          score += gain * 900;
          scoreNotes.push(`push-shortcut:+${gain * 900}`);
        }
      }

      if (afterDist === null && beforeDist !== null) {
        // When mouse carries butter, blocking cat's intercept path may actually
        // be blocking the mouse's hole path — check before penalizing
        if (!(state.mouseHasButter && !state.mouseSkillActive)) {
          score -= 3000;
          scoreNotes.push('push-blocks-path:-3000');
        }
      }
    }

    // ----------------------------------------------------------
    // SCORE 3e: PUSH BLOCKS HOLE PATH — reward pushes that extend
    // or block the mouse's path to the hole when mouse carries butter
    // ----------------------------------------------------------
    if (isBoxPush && sim.pushedBoxTo && state.mouseHasButter && !state.mouseSkillActive) {
      const pushBlockEtaLimit =
        holeDefenseMode === 'corner'
          ? state.config.mouseCarryingMoves + 3
          : holeDefenseMode === 'edge'
            ? state.config.mouseCarryingMoves + 2
            : state.config.mouseCarryingMoves + 1;

      if (mouseEtaToHole !== Infinity && mouseEtaToHole <= pushBlockEtaLimit) {
        // Simulate mouse-to-hole distance on the post-push board
        const holeCells = getMouseHoleCells(config);
        let newMouseEta: number | null = null;

        for (const hc of holeCells) {
          const mousePath = bfsPath(
            mousePos, hc, evalBoard, config,
            state.blockedTunnels, null, state.butterPositions,
          );
          if (mousePath) {
            const dist = mousePath.length - 1;
            if (newMouseEta === null || dist < newMouseEta) {
              newMouseEta = dist;
            }
          }
        }

        const oldEta = mouseEtaToHole;
        const newEta = newMouseEta ?? Infinity;

        if (newEta === Infinity) {
          // Mouse can no longer reach the hole at all
          score += 45000;
          scoreNotes.push('push-blocks-hole-path:+45000');
          scoreNotes.push(`push-hole-path-oldEta=${oldEta}`);
          scoreNotes.push('push-hole-path-newEta=Infinity');
        } else if (newEta > oldEta) {
          const delta = newEta - oldEta;
          const bonus = Math.min(30000, 9000 + delta * 7000);
          score += bonus;
          scoreNotes.push(`push-blocks-hole-path:+${bonus}`);
          scoreNotes.push(`push-hole-path-oldEta=${oldEta}`);
          scoreNotes.push(`push-hole-path-newEta=${newEta}`);
          scoreNotes.push(`push-hole-path-delta=${delta}`);
        }

        // Extra bonus if push target seals entry gate or hole path
        const pushTarget = sim.pushedBoxTo;
        const sealsEntryGate =
          !!entryGate &&
          pushTarget.r === entryGate.r &&
          pushTarget.c === entryGate.c;
        const sealsHoleGate = holeGateCells.some(
          g => g.r === pushTarget.r && g.c === pushTarget.c,
        );
        const sealsMousePath =
          emergencyDecision &&
          emergencyDecision.path.some(
            p => p.r === pushTarget.r && p.c === pushTarget.c,
          );

        if (sealsEntryGate || sealsHoleGate || sealsMousePath) {
          score += 12000;
          scoreNotes.push('push-seals-entry-or-gate:+12000');
        }
      }
    }

    // ----------------------------------------------------------
    // SCORE 4: AREA CONTROL — squeeze mouse, reduce mobility
    // ----------------------------------------------------------

    // 4a. Reduce mouse escape routes
    const mouseEscapeRoutes = countMouseEscapeRoutes(mousePos, evalBoard, config, simCatPos);
    const originalEscapeRoutes = countMouseEscapeRoutes(mousePos, state.board, config, catPos);
    const escapeReduction = originalEscapeRoutes - mouseEscapeRoutes;
    score += escapeReduction * 150; // each corridor closed = big bonus

    // 4b. Cat should be on or adjacent to mouse's predicted path
    if (mousePredictedPath.length > 0) {
      for (const pn of mousePredictedPath) {
        const pd = Math.abs(simCatPos.r - pn.r) + Math.abs(simCatPos.c - pn.c);
        if (pd === 0) score += 80;
        else if (pd === 1) score += 40;
        else if (pd === 2) score += 15;
      }
    }

    // 4c. Cut off mouse from hole (when mouse has butter)
    if (state.mouseHasButter && !state.mouseSkillActive) {
      const distToHole = Math.abs(simCatPos.r - config.mouseHole.r) + Math.abs(simCatPos.c - config.mouseHole.c);
      score += Math.max(0, (boardSize - distToHole)) * 3;

      // Emergency: if mouse is close to hole via path, prioritize gate cells.
      const carryPlan = mousePlans.find(p => p.kind === 'carry_to_hole');
      const mouseDistToHoleByPath = carryPlan ? carryPlan.path.length - 1 : Infinity;

      if (mouseDistToHoleByPath <= state.config.mouseCarryingMoves + 1) {
        const isOwnTrapCell =
          state.trapPosition &&
          simCatPos.r === state.trapPosition.r &&
          simCatPos.c === state.trapPosition.c;
        if (!isOwnTrapCell) {
          // During emergency, only score the real entry gate (handled in SCORE 2b above).
          if (!emergencyBlockActive && !emergencyFallbackActive) {
            const gate4cOnBonus =
              holeDefenseMode === 'corner' ? 6500 :
              holeDefenseMode === 'edge' ? 3500 : 800;
            const gate4cAdj1Bonus =
              holeDefenseMode === 'corner' ? 2600 :
              holeDefenseMode === 'edge' ? 1400 : 300;
            const gate4cAdj2Bonus =
              holeDefenseMode === 'corner' ? 900 :
              holeDefenseMode === 'edge' ? 500 : 100;

            for (const gate of holeGateCells) {
              if (isGateCoveredByTrap(gate)) continue;

              const d = manhattan(simCatPos, gate);
              if (d === 0) score += gate4cOnBonus;
              else if (d === 1) score += gate4cAdj1Bonus;
              else if (d === 2) score += gate4cAdj2Bonus;
            }
          }
        }

        if (!emergencyFallbackActive) {
          for (const pn of mousePredictedPath) {
            const pd = manhattan(simCatPos, pn);
            if (pd === 0) score += 2200;
            else if (pd === 1) score += 1100;
          }

          scoreNotes.push('urgent-hole-block');
        }
      }
    }

    // 4d. Corner/wall pressure: prefer positions that limit mouse movement options
    // Mouse near edges has fewer escapes — cat should herd toward edges
    const mouseEdgeProximity = Math.min(mousePos.r, boardSize - 1 - mousePos.r) +
                                Math.min(mousePos.c, boardSize - 1 - mousePos.c);
    // If mouse is already near edge, cat should block the remaining escape direction
    if (mouseEdgeProximity <= 2) {
      score += (3 - mouseEdgeProximity) * 30;
    }

    // ----------------------------------------------------------
    // SCORE 4e: MOVE-TO-PATH — light fallback for butter chase
    // Only a small bonus for closing distance to the mouse path.
    // The primary trap strategy now uses range placement, so this
    // is just a secondary nudge, not the main approach.
    // ----------------------------------------------------------
    if (state.mouseHasButter && !state.mouseSkillActive && mousePredictedPath.length > 0) {
      for (const pn of mousePredictedPath) {
        const pd = Math.abs(simCatPos.r - pn.r) + Math.abs(simCatPos.c - pn.c);
        if (pd === 0) score += 30;
        else if (pd === 1) score += 15;
      }
    }

    // ----------------------------------------------------------
    // SCORE 5: TRAP PLACEMENT VALUE
    // ----------------------------------------------------------
    if (optimalTrapPos) {
      const distToTrap = Math.abs(simCatPos.r - optimalTrapPos.r) + Math.abs(simCatPos.c - optimalTrapPos.c);
      if (distToTrap <= 1) score += 200;
      else if (distToTrap === 2) score += 80;
      else if (distToTrap === 3) score += 20;
    }

    // ----------------------------------------------------------
    // SCORE 6: LOOKAHEAD — simulate mouse's response
    // ----------------------------------------------------------
    // If cat moves here, how many moves does mouse get before cat catches?
    // Quick heuristic: if cat is closer to mouse than mouse is to target, good
    if (interceptTarget && bfsDistToMouse !== null) {
      const mouseDistToIntercept = Math.abs(mousePos.r - interceptTarget.r) + Math.abs(mousePos.c - interceptTarget.c);
      if (bfsDistToMouse < mouseDistToIntercept) {
        score += 100; // cat is faster to intercept point
      }
    }

    // Store evaluation
    evalResult = {
      score,
      bfsDistToMouse,
      bfsDistToIntercept: interceptTarget ?
        bfsDistance(simCatPos, interceptTarget, evalBoard, config, state.blockedTunnels, null, state.butterPositions) : null,
      mouseEscapeRoutes,
      catMobility: countOpenCorridors(simCatPos.r, simCatPos.c, evalBoard, config),
      mouseMobility: countOpenCorridors(mousePos.r, mousePos.c, evalBoard, config),
      isBoxPush,
      pushedBoxToTunnel: isBoxPush && sim.pushedBoxTo !== null &&
        tunnelCorners.some(t => t.r === sim.pushedBoxTo!.r && t.c === sim.pushedBoxTo!.c),
      trapProximity: optimalTrapPos ?
        Math.abs(simCatPos.r - optimalTrapPos.r) + Math.abs(simCatPos.c - optimalTrapPos.c) : Infinity,
      scoreNotes,
    };

    candidates.push({ d, score, eval: evalResult });
  }

  // ================================================================
  // PHASE 3: Select best move with strategic overrides
  // ================================================================

  if (candidates.length === 0) {
    // No valid moves found (BFS can't reach mouse through obstacles).
    // Walk toward mouse while avoiding reversing last direction (prevent oscillation).
    let fallbackDir: Direction | null = null;
    let fallbackBestDist = Infinity;

    for (const d of DIRECTIONS) {
      const nr = catPos.r + d.dr;
      const nc = catPos.c + d.dc;
      if (!isInBounds(nr, nc, boardSize)) continue;
      if (isMouseHole(nr, nc, config.mouseHole)) continue;
      if (isTunnelCorner(nr, nc, tunnelCorners)) continue;
      if (hasButterAt(nr, nc, state.butterPositions)) continue;
      if (isFixedObstacle(state.board[nr][nc].type)) continue;

      // Penalize reversing last direction to prevent oscillation
      if (lastDir && (d.dr === -lastDir.dr && d.dc === -lastDir.dc)) continue;

      const dist = Math.abs(nr - mousePos.r) + Math.abs(nc - mousePos.c);
      if (dist < fallbackBestDist) {
        fallbackBestDist = dist;
        fallbackDir = d;
      }
    }

    if (fallbackDir) {
      const fr = catPos.r + fallbackDir.dr;
      const fc = catPos.c + fallbackDir.dc;
      state = logAction(state, `HARD_FALLBACK_MOVE from=(${catPos.r},${catPos.c}) to=(${fr},${fc}) reason=no_valid_candidates`);
      return catMove(state, fallbackDir);
    }

    // Truly stuck — place trap if available
    if (state.trapPosition === null && state.catTrapsRemaining > 0) {
      state = logAction(state, `HARD_FALLBACK_MOVE from=(${catPos.r},${catPos.c}) to=(${catPos.r},${catPos.c}) reason=place_trap`);
      return catPlaceTrap(state);
    }
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Guard: if all candidates are terrible (BFS unreachable), fall back to force-move
  if (best.score <= -4000) {
    state = logAction(state, `HARD_FALLBACK reason=all_candidates_bad bestScore=${best.score}`);
    return null;
  }

  // ================================================================
  // PHASE 4: Enhanced logging — HARD_EVAL / HARD_CHOOSE
  // (Trap placement was moved to Phase 1.5)
  // ================================================================
  const strategy = state.mouseHasButter && !state.mouseSkillActive
    ? 'interceptHole'
    : state.mouseHasButter && state.mouseSkillActive
      ? 'chase'
      : state.butterPositions.length > 0
        ? 'interceptButter'
        : 'chase';
  const predPathStr = mousePredictedPath.length > 0
    ? mousePredictedPath.slice(0, 6).map(p => `${p.r},${p.c}`).join('|') + (mousePredictedPath.length > 6 ? '…' : '')
    : 'none';

  // Log top 3 candidates
  const topCandidates = candidates.slice(0, 3).map(c => ({
    score: c.score,
    dir: c.d.key,
    to: { r: catPos.r + c.d.dr, c: catPos.c + c.d.dc },
    bfsMouse: c.eval.bfsDistToMouse,
    bfsIntercept: c.eval.bfsDistToIntercept,
    isBoxPush: c.eval.isBoxPush,
    notes: [
      c.eval.trapProximity < Infinity ? `trapDist=${c.eval.trapProximity}` : '',
      ...c.eval.scoreNotes,
    ].filter(Boolean).join(','),
  }));
  state = logHardDecision(state, strategy, topCandidates, predPathStr);

  // --- Box push override: sometimes pushing a box toward tunnel is better than chasing ---
  // If the best move scores low but there's a tunnel-blocking opportunity
  if (tunnelPriority.length > 0 && boxAdj.pushable) {
    for (const pb of boxAdj.pushable) {
      const tunnel = tunnelCorners.find(t => t.r === pb.destR && t.c === pb.destC);
      if (tunnel && !state.blockedTunnels.some(bt => bt.r === pb.destR && bt.c === pb.destC)) {
        // This push blocks a high-value tunnel
        // Check if this push direction is among candidates
        const pushDir = DIRECTIONS.find(dir => dir.dr === (pb.destR - pb.boxR) && dir.dc === (pb.destC - pb.boxC));
        if (pushDir) {
          const pushCandidate = candidates.find(c => c.d.key === pushDir.key);
          if (pushCandidate && pushCandidate.score < 300) {
            // Tunnel blocking is more important than marginal chase improvement
            const simPush = simulateCatMove(catPos, pb.boxR, pb.boxC, state.board, config, mousePos, state.butterPositions, state.trapPosition);
            if (simPush && simPush.pushedBoxTo) {
              return catMove(state, pushDir);
            }
          }
        }
      }
    }
  }

  if (candidates.length === 0) {
    return {
      ...state,
      catMovesLeft: 0,
      message: '🐱 猫没有可行动作，回合结束',
    };
  }

  // --- Randomness disabled for Hard difficulty ---
  let chosenDir: Direction = best.d;
  let chooseReason = `best-score=${best.score}`;

  state = logAction(state, `HARD_CHOOSE dir=(${chosenDir.dr},${chosenDir.dc}) reason=${chooseReason}`);

  return catMove(state, chosenDir);
}

// --- Main entry point ---

/**
 * F1B-1/3: engine-side RuleSet factory — the depedency-injected adapter for
 * the Search AI. It references (by closure) the REAL engine transition
 * functions; NO rules are copied. This is what the Hard turn planner consumes
 * (`planHardCatTurn(state, { rules: createEngineRuleSet(), ... })`).
 *
 * Kept OUTSIDE ai/searchRules.ts on purpose: engine must not import that
 * module (its `defaultRuleSet` top-level reads engine functions at module
 * init, which would form a runtime cycle once engine imports the planner).
 */
export function createEngineRuleSet(): RuleSet {
  return {
    mouseStep: mouseStepDeterministic,
    catMove,
    mouseSkill,
    catPlaceTrap,
    chooseTunnelExit,
    endTurn,
    enumerateButterSpawns: (state) => enumerateButterSpawns(
      state.config,
      state.board,
      getTunnelCorners(state.config),
      state.mousePosition,
      state.catPosition,
      state.butterPositions,
      state.trapPosition,
    ),
    buildButterChance: (state) => {
      const cells = enumerateButterSpawns(
        state.config,
        state.board,
        getTunnelCorners(state.config),
        state.mousePosition,
        state.catPosition,
        state.butterPositions,
        state.trapPosition,
      );
      if (cells.length === 0) return null;
      const weight = 1 / cells.length;
      return cells.map((c) => ({
        state: { ...state, butterPositions: [...state.butterPositions, c] },
        weight,
      }));
    },
  };
}

export function catAiMove(state: GameEngineState): GameEngineState | null {
  state = sanitizeItemOverlaps(state);
  if (state.currentPlayer !== PieceType.Cat || state.phase !== GamePhase.Playing) return null;
  if (state.catMovesLeft <= 0) return null;

  const difficulty = state.config.difficulty || DifficultyConst.Easy;

  // Difficulty routing (F1B-5): Easy → catAiEasy, Medium → legacy catAiHard,
  // Hard → Expectiminimax Search planner (step 0 of the plan; the trajectory
  // uses the full plan in one search — see computeCatAiTrajectory).
  // Old catAiMedium is preserved as a baseline (exported, no longer called).
  if (difficulty === DifficultyConst.Easy) {
    return catAiEasy(state);
  }
  if (difficulty === DifficultyConst.Hard) {
    const plan = planHardCatTurn(state, { rules: createEngineRuleSet(), timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn });
    state = { ...state, lastHardSearch: plan.debug };
    const first = plan.plan[0] ?? plan.bestAction;
    if (first) {
      if (first.type === 'catStep') return catMove(state, first.direction);
      if (first.type === 'catPlaceTrap') return catPlaceTrap(state);
      // chooseTunnel / mouseStep / mouseSkill are not valid cat actions.
    }
    // No plan / fallback: log explicitly, then legacy heuristic step.
    logFallback(state, `SEARCH_FALLBACK reason=no_hard_plan (plan len ${plan.plan.length}, completedDepth ${plan.completedDepth})`);
  }
  return catAiHard(state);
}

export function getDirectionByKey(key: string): Direction | null {
  return DIRECTIONS.find(d => d.key === key) || null;
}

/** Check if a direction is a legal cat move (matches catMove filters exactly). */
function isLegalCatDirection(state: GameEngineState, d: Direction): boolean {
  const catPos = state.catPosition;
  const nr = catPos.r + d.dr;
  const nc = catPos.c + d.dc;
  const { config } = state;
  const tunnelCorners = getTunnelCorners(config);
  if (!isInBounds(nr, nc, config.boardSize)) return false;
  if (isMouseHole(nr, nc, config.mouseHole)) return false;
  if (isTunnelCorner(nr, nc, tunnelCorners)) return false;
  if (hasButterAt(nr, nc, state.butterPositions)) return false;
  if (isFixedObstacle(state.board[nr][nc].type)) return false;

  // If target is a box, check push destination is legal (mirrors catMove box-push logic)
  if (state.board[nr][nc].type === CellType.Box) {
    const pushDr = nr - catPos.r;
    const pushDc = nc - catPos.c;
    const destR = nr + pushDr;
    const destC = nc + pushDc;
    if (!isInBounds(destR, destC, config.boardSize)) return false;
    if (isMouseHole(destR, destC, config.mouseHole)) return false;
    if (state.mousePosition.r === destR && state.mousePosition.c === destC) return false;
    if (hasBox(destR, destC, state.board)) return false;
    if (hasPile(destR, destC, state.board)) return false;
    if (hasButterAt(destR, destC, state.butterPositions)) return false;
    if (state.trapPosition?.r === destR && state.trapPosition?.c === destC) return false;
  }

  return true;
}

/** Return all legal cat move directions for the current state. */
function getLegalCatDirections(state: GameEngineState): Direction[] {
  return DIRECTIONS.filter(d => isLegalCatDirection(state, d));
}

// ============================================================
// Cat AI Trajectory — pre-compute all steps for animation
// Returns an array of states representing each intermediate step
// of the cat's AI turn, including the starting state.
// ============================================================

export type CatAiStep = {
  state: GameEngineState;
  from: { r: number; c: number };
  to: { r: number; c: number };
  detail: string;
};

/**
 * Simulate the full cat AI turn and return all intermediate steps.
 * Each step represents one cat move. The array includes the starting state.
 * Returns null if cat is not currently moving.
 */
export function computeCatAiTrajectory(state: GameEngineState): CatAiStep[] | null {
  if (state.currentPlayer !== PieceType.Cat || state.phase !== GamePhase.Playing) return null;
  if (state.catMovesLeft <= 0) return null;

  const steps: CatAiStep[] = [];
  let current = state;

  // If cat has no moves left for this turn, give it the base moves
  if (current.catMovesLeft <= 0) {
    current = { ...current, catMovesLeft: current.config.catBaseMoves };
  }

  // F1B-3/4: Hard difficulty plans ONE main search for the WHOLE turn, then
  // executes the principal-line plan step-by-step (with per-action validation;
  // invalid/empty plan -> explicit SEARCH_FALLBACK to the legacy heuristic).
  const isHardTurn = (current.config.difficulty || DifficultyConst.Easy) === DifficultyConst.Hard;
  let hardPlanIdx = 0;
  let hardPlanActions: SearchAction[] | null = null;
  let pendingHistoryEntry: HardSearchHistoryEntry | null = null;
  // G0.2: 1-based turn index kept on the state (debug only).
  const hardTurnNo = (current.hardSearchHistory?.length ?? 0) + 1;
  if (isHardTurn) {
    const planned = planHardCatTurn(current, {
      rules: createEngineRuleSet(),
      timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
    });
    // F1B (HARD_SEARCH debug): persist the debug record onto the state so the
    // UI debug panel can render it (with copy). Debug-only — excluded from
    // gameAffectingEqual / stateKey.
    current = { ...current, lastHardSearch: planned.debug };
    if (planned.hasSolution && planned.plan.length > 0) {
      hardPlanActions = planned.plan;
      // G0.2: record the EXACT root snapshot + production diagnostics into
      // the bounded history (deep copy; never affects the search). Defensive:
      // only when a real iterative-search result exists (tests may inject a
      // minimal HardTurnPlan without the search object).
      if (planned.search) {
        pendingHistoryEntry = makeHardHistoryEntry(current, hardTurnNo, {
          completedDepth: planned.completedDepth,
          attemptedDepth: planned.attemptedDepth,
          nodes: planned.search.diagnostics ? planned.search.diagnostics.totalNodes : 0,
          elapsedMs: planned.elapsedMs ?? 0,
          rootValue: planned.search.value,
          mate: planned.search.mate,
          plan: planned.plan,
          rootValues: planned.search.rootActions ?? [],
        });
      }
    } else {
      current = logFallback(
        current,
        `SEARCH_FALLBACK reason=no_hard_plan completedDepth=${planned.completedDepth} attemptedDepth=${planned.attemptedDepth}`,
      );
    }
  }

  let stuckCount = 0; // Track consecutive no-move iterations to prevent infinite loops
  const maxStuck = 5;
  let safety = 0;
  const maxSafety = state.config.catBaseMoves * 8 + 20;

  while (current.catMovesLeft > 0 && current.phase === GamePhase.Playing && stuckCount < maxStuck) {
    safety++;
    if (safety > maxSafety) {
      console.warn('[Trajectory] Safety limit exceeded, breaking to prevent infinite loop');
      break;
    }
    const from = { ...current.catPosition };
    const catMovesLeftBefore = current.catMovesLeft;

    // Plan-driven step (Hard) OR legacy single step (Easy/Medium/Hard-fallback).
    let nextState: GameEngineState | null;
    if (hardPlanActions && hardPlanIdx < hardPlanActions.length) {
      const action = hardPlanActions[hardPlanIdx++];
      const applied = applyPlanCatAction(current, action);
      if (!applied.valid) {
        // F1B-4: plan/state mismatch → explicit, non-silent fallback: the rest
        // of this turn uses the legacy heuristic (no deadlock).
        current = logFallback(
          current,
          `SEARCH_FALLBACK reason=plan_action_invalid action=${action.type}`,
        );
        hardPlanActions = null; // fall back to legacy for the rest of the turn
        nextState = catAiMove(current);
      } else {
        nextState = applied.state;
      }
    } else if (hardPlanActions && hardPlanIdx >= hardPlanActions.length) {
      // F1B-4: the plan ran out BEFORE the cat turn ended (the plan was shorter
      // than the remaining cat moves, e.g. a truncated principal line). This is
      // an EXPLICIT, non-silent fallback: log it, then let the legacy AI finish
      // the rest of the turn without deadlock. Behavior is identical to the
      // other fallback paths — only the reason differs (audit requirement).
      current = logFallback(
        current,
        `SEARCH_FALLBACK reason=plan_exhausted plan_len=${hardPlanActions.length} remaining_moves=${current.catMovesLeft}`,
      );
      hardPlanActions = null; // fall back to legacy for the rest of the turn
      nextState = catAiMove(current);
    } else {
      nextState = catAiMove(current);
    }

    // AI returned null — cat is truly stuck (no valid moves at all).
    // Force a move toward the mouse using BFS as last resort.
    if (!nextState) {
      const forced = forceCatMoveTowardsMouse(current);
      if (!forced) {
        // Absolutely no valid move anywhere — consume remaining moves and end turn
        current = { ...current, catMovesLeft: 0 };
        break;
      }
      const to = forced.catPosition;
      state = logAction(forced, `HARD_FALLBACK_MOVE from=(${from.r},${from.c}) to=(${to.r},${to.c}) reason=trajectory_fallback`);
      steps.push({ state: forced, from, to, detail: '强制移动' });
      stuckCount = 0; // Reset stuck counter on forced move
      current = forced;
      continue;
    }

    if (nextState.phase !== GamePhase.Playing) {
      // Game ended — record the winning move
      const to = nextState.catPosition;
      steps.push({ state: nextState, from, to, detail: nextState.phase === GamePhase.CatWins ? '抓鼠' : '结束' });
      break;
    }
    if (nextState.currentPlayer !== PieceType.Cat) {
      steps.push({
        state: nextState,
        from,
        to: from,
        detail: '守入口结束回合',
      });
      break;
    }

    const catStayed =
      nextState.catPosition.r === from.r &&
      nextState.catPosition.c === from.c;

    const movesUnchanged = nextState.catMovesLeft === catMovesLeftBefore;

    const trapChanged =
      (current.trapPosition === null && nextState.trapPosition !== null) ||
      (current.trapPosition !== null && nextState.trapPosition === null) ||
      (current.trapPosition !== null &&
        nextState.trapPosition !== null &&
        (current.trapPosition.r !== nextState.trapPosition.r ||
         current.trapPosition.c !== nextState.trapPosition.c)) ||
      current.catTrapsRemaining !== nextState.catTrapsRemaining;

    // Cat stayed and did not consume a move, but state changed by placing / collecting trap.
    // This is a valid zero-cost action and must NOT be overwritten by forced movement.
    if (catStayed && movesUnchanged && trapChanged) {
      steps.push({ state: nextState, from, to: from, detail: '放置陷阱' });
      stuckCount = 0;
      current = nextState;
      continue;
    }

    // Cat didn't move and didn't consume a move, and no meaningful state changed.
    // Now it is truly stuck / invalid, so fallback is allowed.
    if (catStayed && movesUnchanged) {
      const forced = forceCatMoveTowardsMouse(current);
      if (!forced) {
        stuckCount++;
        if (stuckCount >= maxStuck) break;
        current = nextState;
        continue;
      }
      const to = forced.catPosition;
      state = logAction(forced, `HARD_FALLBACK_MOVE from=(${from.r},${from.c}) to=(${to.r},${to.c}) reason=trajectory_fallback`);
      steps.push({ state: forced, from, to, detail: '强制移动' });
      stuckCount = 0;
      current = forced;
      continue;
    }

    // Cat moved (possibly placed trap and moved) — record normally
    if (nextState.catPosition.r === from.r && nextState.catPosition.c === from.c) {
      // Cat stayed but consumed a move (e.g. trap placement counted as action)
      // This shouldn't normally happen, but handle gracefully
      stuckCount++;
      if (stuckCount >= maxStuck) break;
      current = nextState;
      continue;
    }

    stuckCount = 0; // Reset on successful move
    const to = nextState.catPosition;
    let detail = '移动';

    const dr = to.r - from.r;
    const dc = to.c - from.c;
    const wasPushingBox =
      isInBounds(to.r, to.c, current.config.boardSize) &&
      current.board[to.r][to.c].type === CellType.Box;

    if (wasPushingBox) {
      const boxDest = { r: to.r + dr, c: to.c + dc };
      const tunnelCorners = getTunnelCorners(current.config);
      const pushedToTunnel = tunnelCorners.some(t => t.r === boxDest.r && t.c === boxDest.c);
      detail = pushedToTunnel ? '推箱堵通道' : '推箱';
    }

    const collectedTrap =
      current.trapPosition !== null &&
      nextState.trapPosition === null &&
      nextState.catTrapsRemaining > current.catTrapsRemaining;

    if (collectedTrap) {
      detail = '收回陷阱';
    }

    steps.push({ state: nextState, from, to, detail });
    current = nextState;
  }

  // G0.2: fill the execution link of the pending history entry with the actual
  // end-of-cat-turn stateKey (post-plan, before the separate endTurn), and
  // attach the bounded history onto the returned final state.
  if (pendingHistoryEntry) {
    const finalExecState = steps.length > 0 ? steps[steps.length - 1].state : current;
    pendingHistoryEntry.execution = {
      plan: pendingHistoryEntry.production.plan,
      endStateKey: stateKey(finalExecState),
      matchedPlan: !steps.some((st) =>
        st.state.catActionLog.some((m) => m.includes('SEARCH_FALLBACK')),
      ),
    };
    const history = pushHardHistory(
      (current.hardSearchHistory ?? []).filter((e) => e.turn !== pendingHistoryEntry!.turn),
      pendingHistoryEntry,
    );
    current = { ...current, hardSearchHistory: history };
    if (steps.length > 0) {
      steps[steps.length - 1] = { ...steps[steps.length - 1], state: { ...steps[steps.length - 1].state, hardSearchHistory: history } };
    }
  }

  return steps;
}

/**
 * F1B-4: apply ONE planned cat action through the REAL engine transition
 * (catMove / catPlaceTrap), validating it against the CURRENT state.
 *
 * Returns `{ state, valid }`:
 *   - catStep      → engine `catMove`; valid iff the move really produced a
 *                    game-affecting change (legal direction, no-op rejected).
 *   - catPlaceTrap → engine `catPlaceTrap`; valid iff the trap was really
 *                    placed (trap added / count decremented).
 *   - any other action type → invalid (not a cat action; plan corruption).
 *
 * This is the "before state consistent with plan expectation" check: applying
 * the plan action through the REAL engine on the CURRENT actual state either
 * succeeds (state matched the plan) or is a no-op (mismatch → fallback).
 */
function applyPlanCatAction(
  state: GameEngineState,
  action: SearchAction,
): { state: GameEngineState; valid: boolean } {
  if (action.type === 'catStep') {
    const next = catMove(state, action.direction);
    const changed =
      next.catPosition.r !== state.catPosition.r ||
      next.catPosition.c !== state.catPosition.c ||
      next.catMovesLeft < state.catMovesLeft ||
      next.phase !== state.phase;
    return { state: next, valid: changed };
  }
  if (action.type === 'catPlaceTrap') {
    const next = catPlaceTrap(state);
    const placed =
      next.trapPosition !== null ||
      next.catTrapsRemaining < state.catTrapsRemaining;
    return { state: next, valid: placed };
  }
  // mouseStep / mouseSkill / chooseTunnel are NOT legal cat actions.
  return { state, valid: false };
}

/**
 * Last-resort forced move: when AI returns null (completely stuck),
 * try each legal direction sorted by Manhattan distance to mouse.
 * Only accept a direction if catMove actually produces a change
 * (position moved, moves consumed, or game ended).
 * Returns null when no direction yields a real move.
 */
function forceCatMoveTowardsMouse(state: GameEngineState): GameEngineState | null {
  const legal = getLegalCatDirections(state);
  if (legal.length === 0) return null;

  const catPos = state.catPosition;
  const mousePos = state.mousePosition;
  const { config } = state;

  // Prefer BFS to mouse (avoids Manhattan ties in obstacle-heavy boards)
  // catchPath format: [start, step1, ..., target] — index 0 = catPos
  const catchPath = bfsPath(catPos, mousePos, state.board, config, state.blockedTunnels, null, state.butterPositions);
  const stepsToMouse = catchPath ? catchPath.length - 1 : 0;
  if (catchPath && stepsToMouse > 0) {
    const next = catchPath[1]; // first step toward mouse
    const dir = DIRECTIONS.find(d => d.dr === next.r - catPos.r && d.dc === next.c - catPos.c) || null;
    if (dir) {
      const moved = catMove(state, dir);
      if (moved.catPosition.r !== catPos.r || moved.catPosition.c !== catPos.c) {
        state = logAction(state, `HARD_FALLBACK_MOVE from=(${catPos.r},${catPos.c}) to=(${moved.catPosition.r},${moved.catPosition.c}) reason=bfs_to_mouse`);
        return moved;
      }
    }
  }

  // Fallback: Manhattan distance
  const sorted = legal.slice().sort((a, b) => {
    const da = Math.abs(catPos.r + a.dr - mousePos.r) + Math.abs(catPos.c + a.dc - mousePos.c);
    const db = Math.abs(catPos.r + b.dr - mousePos.r) + Math.abs(catPos.c + b.dc - mousePos.c);
    return da - db;
  });

  for (const d of sorted) {
    const moved = catMove(state, d);
    const changed =
      moved.phase !== state.phase ||
      moved.catMovesLeft < state.catMovesLeft ||
      moved.catPosition.r !== catPos.r ||
      moved.catPosition.c !== catPos.c;

    if (changed) {
      state = logAction(state, `HARD_FALLBACK_MOVE from=(${catPos.r},${catPos.c}) to=(${moved.catPosition.r},${moved.catPosition.c}) reason=manhattan`);
      return moved;
    }
  }

  return null;
}
