// 无头模拟器：复刻 TutorialPage 的步骤进入逻辑 + 真实引擎驱动一个"自动玩家"
// 目的：验证每一步进入时的鼠步数，以及整条教程能否走通不卡死。
import { createInitialState, mouseMove, mouseSkill, catMove, catPlaceTrap, endTurn } from '../src/game/engine';
import { PieceType, GamePhase, CellType } from '../src/game/types';
import { TUTORIAL_STEPS, PHASE_A_CONFIG, PHASE_B_CONFIG, REFRESH_BUTTER_POS } from '../src/game/tutorial';

type AnyState = any;

const fmtMoves = (m: number) => (m === Infinity ? '+∞' : String(m));

// 复刻 TutorialPage 步骤进入逻辑（必须与 src/pages/TutorialPage.tsx 保持一致）
function entryFor(stepIndex: number, gameState: AnyState) {
  const s: any = TUTORIAL_STEPS[stepIndex];
  let entry: AnyState;
  if (s.id === 'phaseB') entry = createInitialState(PHASE_B_CONFIG);
  else if (s.id === 'eat_again') entry = { ...gameState, butterPositions: [REFRESH_BUTTER_POS] };
  else if (s.kind === 'action') entry = gameState.currentPlayer === PieceType.Mouse ? gameState : endTurn(gameState);
  else entry = gameState;
  if (s.infiniteMoves) entry = { ...entry, currentPlayer: PieceType.Mouse, mouseMovesLeft: Infinity };
  return { s, entry };
}

// 复刻 TutorialPage.chooseTunnelExit
function chooseTunnelExit(state: AnyState, r: number, c: number): AnyState {
  if (state.phase !== GamePhase.ChoosingTunnelExit) return state;
  const valid = (state.tunnelExitChoices || []).some((t: any) => t.r === r && t.c === c);
  if (!valid) return state;
  const nb = state.board.map((row: any[]) => row.map((cell: any) => ({ ...cell })));
  nb[state.mousePosition.r][state.mousePosition.c] = { ...nb[state.mousePosition.r][state.mousePosition.c], piece: undefined };
  nb[r][c] = { ...nb[r][c], piece: PieceType.Mouse };
  const afterExit = { ...state, board: nb, mousePosition: { r, c }, mouseMovesLeft: 0, phase: GamePhase.Playing, currentPlayer: PieceType.Mouse, tunnelExitChoices: [] };
  return endTurn(afterExit);
}

// BFS：返回从当前鼠位置朝 goal 走的第一步方向
function stepToward(state: AnyState, goal: { r: number; c: number }): { dr: number; dc: number } | null {
  const board = state.board;
  const N = board.length;
  const start = state.mousePosition;
  if (start.r === goal.r && start.c === goal.c) return null;
  const blocked = (r: number, c: number) => {
    const t = board[r][c].type;
    if (t === CellType.Wall || t === CellType.Pile || t === CellType.Void || t === CellType.Box) return true;
    if (state.catPosition && state.catPosition.r === r && state.catPosition.c === c) return true;
    return false;
  };
  const q: any[] = [{ r: start.r, c: start.c }];
  const prev: any = {};
  const seen = new Set([start.r + ',' + start.c]);
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  while (q.length) {
    const cur = q.shift();
    if (cur.r === goal.r && cur.c === goal.c) {
      let node = cur;
      while (prev[node.r + ',' + node.c] && !(prev[node.r + ',' + node.c].r === start.r && prev[node.r + ',' + node.c].c === start.c)) {
        node = prev[node.r + ',' + node.c];
      }
      return { dr: node.r - start.r, dc: node.c - start.c };
    }
    for (const [dr, dc] of dirs) {
      const nr = cur.r + dr, nc = cur.c + dc;
      if (nr < 0 || nc < 0 || nr >= N || nc >= N) continue;
      if (seen.has(nr + ',' + nc)) continue;
      if (blocked(nr, nc) && !(nr === goal.r && nc === goal.c)) continue;
      seen.add(nr + ',' + nc);
      prev[nr + ',' + nc] = cur;
      q.push({ r: nr, c: nc });
    }
  }
  return null;
}

function targetFor(s: any, state: AnyState): { r: number; c: number } | null {
  switch (s.id) {
    case 'eat_butter':
    case 'phaseB':
      return state.butterPositions?.[0] ?? null;
    case 'eat_again':
      return REFRESH_BUTTER_POS;
    case 'escape':
      return { r: 0, c: 2 };
    case 'win':
      return { r: 7, c: 7 };
    default:
      return null; // move_practice 无目标
  }
}

function anyMove(state: AnyState): { dr: number; dc: number } | null {
  const board = state.board;
  const N = board.length;
  const { r, c } = state.mousePosition;
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nc < 0 || nr >= N || nc >= N) continue;
    const t = board[nr][nc].type;
    if (t === CellType.Wall || t === CellType.Pile || t === CellType.Void || t === CellType.Box) continue;
    if (state.catPosition && state.catPosition.r === nr && state.catPosition.c === nc) continue;
    return { dr, dc };
  }
  return null;
}

function playerAct(s: any, state: AnyState): AnyState {
  if (state.phase !== GamePhase.Playing) return state;
  if (state.currentPlayer !== PieceType.Mouse) return state;
  if (state.mouseMovesLeft <= 0) return state;
  // 需要放技能的步骤
  if ((s.id === 'use_skill' || s.id === 'escape') && !state.mouseSkillActive && state.mouseHasButter) {
    return mouseSkill(state);
  }
  const goal = targetFor(s, state);
  let d = goal ? stepToward(state, goal) : anyMove(state);
  if (!d) return state;
  const dir = { key: 'sim', dr: d.dr, dc: d.dc, label: '' };
  return mouseMove(state, dir);
}

function run() {
  let gameState: AnyState = createInitialState(PHASE_A_CONFIG);
  let stepIndex = 0;
  const log: string[] = [];
  while (stepIndex < TUTORIAL_STEPS.length) {
    const { s, entry } = entryFor(stepIndex, gameState);
    gameState = entry;
    log.push(
      `STEP ${String(stepIndex).padStart(2)} [${s.id.padEnd(11)}] kind=${s.kind.padEnd(7)} | 进入时鼠步数=${fmtMoves(gameState.mouseMovesLeft).padStart(3)}  回合=${gameState.currentPlayer === PieceType.Mouse ? '鼠' : '猫'}`,
    );
    if (s.kind === 'observe') {
      for (const op of s.catScript || []) {
        if (op.t === 'move' && op.dir) gameState = catMove(gameState, op.dir);
        else if (op.t === 'trap') gameState = catPlaceTrap(gameState);
        else if (op.t === 'endTurn') gameState = endTurn(gameState);
      }
      stepIndex++;
      continue;
    }
    if (s.kind === 'intro') { stepIndex++; continue; }
    // action：自动玩家驱动
    let guard = 0;
    while (!(s.done && s.done(gameState)) && guard < 400) {
      guard++;
      const before = JSON.stringify({ p: gameState.mousePosition, c: gameState.currentPlayer, m: gameState.mouseMovesLeft, ph: gameState.phase });
      gameState = playerAct(s, gameState);
      if (gameState.phase === GamePhase.ChoosingTunnelExit) {
        const choices = gameState.tunnelExitChoices || [];
        const exit = choices.find((c: any) => (!c.label || !c.label.includes('原地')) && (c.r !== gameState.mousePosition.r || c.c !== gameState.mousePosition.c));
        if (exit) gameState = chooseTunnelExit(gameState, exit.r, exit.c);
      }
      // 容错①：action 步鼠步数耗尽切猫且未完成 → 猫轮空还回合
      if (gameState.currentPlayer === PieceType.Cat && !(s.done && s.done(gameState))) {
        gameState = endTurn(gameState);
      }
      const after = JSON.stringify({ p: gameState.mousePosition, c: gameState.currentPlayer, m: gameState.mouseMovesLeft, ph: gameState.phase });
      if (before === after && guard > 1) { log.push(`  ⚠ 第 ${stepIndex} 步状态无变化（可能卡死）`); break; }
    }
    if (s.done && s.done(gameState)) { log.push(`  ✓ 完成 -> 下一步`); stepIndex++; }
    else { log.push(`  ✗ 第 ${stepIndex} 步未完成（卡住）`); break; }
  }
  console.log(log.join('\n'));
  console.log(stepIndex >= TUTORIAL_STEPS.length ? '\n=== 全流程走通，无卡死 ===' : '\n=== 流程中断 ===');
}

run();
