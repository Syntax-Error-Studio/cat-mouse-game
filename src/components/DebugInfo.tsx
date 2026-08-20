// ============================================================
// DebugInfo — 调试信息面板（给 AI 看的，方便定位问题）
// 格式结构化，分层展示关键信息
// ============================================================

import { CellType, GamePhase, PieceType, GameMode } from '../game/types';
import { makeTunnelCorners } from '../game/types';
import { useMemo, useState } from 'react';
import type { HardSearchDebug } from '../game/ai/hardTurnPlanner';
import type { SearchAction } from '../game/ai/searchTypes';
import type { Direction } from '../game/types';

type BoardCell = { type: CellType; piece?: PieceType; hasButter: boolean };

interface DebugInfoProps {
  board: BoardCell[][];
  catPosition: { r: number; c: number };
  mousePosition: { r: number; c: number };
  butterPositions: { r: number; c: number }[];
  mouseHasButter: boolean;
  mouseSkillActive: boolean;
  catMovesLeft: number;
  mouseMovesLeft: number;
  trapPosition: { r: number; c: number } | null;
  catTrapsRemaining: number;
  currentPlayer: PieceType;
  phase: GamePhase;
  message: string;
  gameMode: GameMode;
  blockedTunnels: { r: number; c: number }[];
  tunnelExitChoices: { r: number; c: number; label: string }[];
  catActionLog: string[];
  gameEventLog: string[];
  difficulty: string;
  /** HARD_SEARCH debug record produced by the Search AI's last Hard turn. */
  hardSearch: HardSearchDebug | null | undefined;
}

/** One-line label for a SearchAction (e.g. "catStep →", "catPlaceTrap"). */
function actionLabel(a: SearchAction): string {
  if (a.type === 'catStep') return `catStep ${(a.direction as Direction).key}`;
  return a.type;
}

/** Format the [HARD_SEARCH] debug block as plain text (copyable). */
function formatHardSearch(h: HardSearchDebug): string {
  const planLines = h.plan.length
    ? h.plan.map((a) => `  ${actionLabel(a)}`).join('\n')
    : '  (empty plan)';
  const rootActions = (h.rootActions ?? [])
    .slice()
    .sort((a, b) => b.value - a.value)
    .map((ra, i) => `  ${i + 1}. ${actionLabel(ra.action).replace('catStep ', '')} value=${ra.value.toFixed(1)} mate=${ra.mate ?? 'null'}`)
    .join('\n');
  return [
    `cat=(${h.cat.r},${h.cat.c})`,
    `mouse=(${h.mouse.r},${h.mouse.c})`,
    `mouseHasButter=${h.mouseHasButter}`,
    '',
    `completedDepth=${h.completedDepth}`,
    `attemptedDepth=${h.attemptedDepth}`,
    `nodes=${h.nodes}`,
    `elapsedMs=${h.elapsedMs.toFixed(1)}`,
    '',
    `rootValue=${h.rootValue}`,
    `mate=${h.mate ?? 'null'}`,
    '',
    'PLAN:',
    planLines,
    '',
    'TOP ROOT ACTIONS:',
    rootActions || '  (none)',
    '',
    'EVAL ROOT:',
    `  mouseGoalThreat=${h.evalRoot.mouseGoalThreat}`,
    `  mouseWinRoute=${h.evalRoot.mouseWinRoute}`,
    `  holeControl=${h.evalRoot.holeControl}`,
    `  captureDistance=${h.evalRoot.captureDistance}`,
    `  voronoi=${h.evalRoot.voronoi}`,
    `  trapControl=${h.evalRoot.trapControl}`,
    `  tunnelControl=${h.evalRoot.tunnelControl}`,
    `  tempo=${h.evalRoot.tempo}`,
    `  total=${h.evalRoot.total}`,
  ].join('\n');
}

export const DebugInfo: React.FC<DebugInfoProps> = ({
  board, catPosition, mousePosition, butterPositions,
  mouseHasButter, mouseSkillActive, catMovesLeft, mouseMovesLeft,
  trapPosition, catTrapsRemaining, currentPlayer, phase, message,
  gameMode, blockedTunnels, tunnelExitChoices, catActionLog, gameEventLog, difficulty,
  hardSearch,
}) => {
  const [copied, setCopied] = useState(false);

  // ---- Build the full plain-text dump (for the copy button) ----
  const boardDump = board.map((row, r) =>
    row.map((cell, c) => {
      if (r === catPosition.r && c === catPosition.c) return 'C';
      if (r === mousePosition.r && c === mousePosition.c) return 'M';
      if (cell.type === CellType.Box) return 'X';
      if (cell.type === CellType.Pile) return '#';
      if (cell.type === CellType.Tunnel) return 'T';
      if (cell.type === CellType.MouseHole) return 'H';
      if (butterPositions.some(b => b.r === r && b.c === c)) return 'B';
      if (trapPosition?.r === r && trapPosition?.c === c) return 'R';
      return '.';
    }).join('')
  ).join('\n');

  const hardSearchText = hardSearch ? formatHardSearch(hardSearch) : '[HARD_SEARCH] none';

  const fullDebugText =
    '[HARD_SEARCH]\n' + hardSearchText +
    '\n\n[STATE]\n' +
    `cat=(${catPosition.r},${catPosition.c}) mouse=(${mousePosition.r},${mousePosition.c})\n` +
    `catMoves=${catMovesLeft} mouseMoves=${mouseMovesLeft}\n` +
    `butter=${mouseHasButter} skill=${mouseSkillActive} trap=${trapPosition ? `(${trapPosition.r},${trapPosition.c})` : 'none'}\n` +
    `trapRemain=${catTrapsRemaining} phase=${phase} difficulty=${difficulty}\n` +
    `msg="${message}"\n\n[BOARD]\n${boardDump}\n\n[AI_LOG]\n` +
    (catActionLog.length ? catActionLog.join('\n') : '(empty)') +
    '\n\n[GAME_EVENT_LOG]\n' +
    (gameEventLog.length ? gameEventLog.join('\n') : '(empty)');

  const copyAll = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(fullDebugText).then(() => setCopied(true)).catch(() => setCopied(false));
    } else {
      setCopied(false);
    }
    setTimeout(() => setCopied(false), 1500);
  };

  const copyHardSearch = () => {
    if (navigator.clipboard?.writeText && hardSearch) {
      navigator.clipboard.writeText('[HARD_SEARCH]\n' + hardSearchText).then(() => setCopied(true)).catch(() => setCopied(false));
    }
    setTimeout(() => setCopied(false), 1500);
  };

  const boardSize = board.length;
  const tunnelCorners = makeTunnelCorners(boardSize);

  // ---- Core diagnostic: turn transition check ----
  const turnTransitionOk = (() => {
    if (phase !== GamePhase.Playing) return 'N/A (game over)';
    if (currentPlayer === PieceType.Mouse) {
      if (mouseMovesLeft > 0) return 'OK (mouse can move)';
      return 'FAIL (mouseMovesLeft=0 but still mouse turn — should trigger cat AI)';
    }
    if (currentPlayer === PieceType.Cat) {
      if (catMovesLeft > 0) return 'OK (cat can move)';
      return 'FAIL (catMovesLeft=0 but still cat turn)';
    }
    return 'UNKNOWN';
  })();

  // ---- Core diagnostic: cat-mouse proximity ----
  const distToMouse = Math.abs(catPosition.r - mousePosition.r) + Math.abs(catPosition.c - mousePosition.c);
  const catCanReachMouse = (() => {
    if (distToMouse > 1) return 'NO (too far)';
    // Check if cat can move to mouse cell
    const cell = board[catPosition.r + (mousePosition.r - catPosition.r)][catPosition.c + (mousePosition.c - catPosition.c)];
    return `CHECK: cell type=${cell?.type} piece=${cell?.piece}`;
  })();

  // ---- Core diagnostic: animation state ----
  const animating = catMovesLeft < (boardSize > 0 ? board[0]?.length : 10) && currentPlayer === PieceType.Cat;

  // ---- AI log analysis ----
  const analyzeLog = () => {
    const entries = catActionLog.slice(-30);
    if (entries.length === 0) return { count: 0, moves: 0, traps: 0, oscillation: false, lastPositions: [] };

    const moves = entries.filter(l => l.includes('移动') || l.includes('推箱') || l.includes('抓鼠'));
    const traps = entries.filter(l => l.includes('陷阱'));
    const positions: { from: [number,number]; to: [number,number] }[] = [];
    // Only parse actual cat move logs (🐱 [CAT]), not HARD_EVAL / HARD_TRAP / HARD_CHOOSE diagnostics
    for (const l of entries) {
      if (!l.startsWith('🐱 [CAT]')) continue;
      const m = l.match(/\((\d+),(\d+)\)→\((\d+),(\d+)\)/);
      if (m) positions.push({ from: [parseInt(m[1]), parseInt(m[2])], to: [parseInt(m[3]), parseInt(m[4])] });
    }

    // Detect oscillation: A→B, B→A pattern
    let oscillation = false;
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i-1], curr = positions[i];
      if (prev && curr && curr.from[0]===prev.to[0] && curr.from[1]===prev.to[1] &&
          curr.to[0]===prev.from[0] && curr.to[1]===prev.from[1]) {
        oscillation = true;
        break;
      }
    }

    // Detect repeating pattern (same sequence of positions)
    let repeatingPattern = '';
    if (positions.length >= 6) {
      const half = positions.slice(-6);
      const isRepeat = half.slice(0,3).every((p,i) =>
        p.from[0]===half[3+i].from[0] && p.from[1]===half[3+i].from[1] &&
        p.to[0]===half[3+i].to[0] && p.to[1]===half[3+i].to[1]
      );
      if (isRepeat) repeatingPattern = 'YES — last 3 moves repeated (AI stuck in loop)';
    }

    // Detect long loops: same "to" position repeats with gap >= 4 steps
    const recentToPositions = positions.slice(-20).map(p => `${p.to[0]},${p.to[1]}`);
    const seen = new Map<string, number>();
    let longLoop = false;
    for (let i = 0; i < recentToPositions.length; i++) {
      const key = recentToPositions[i];
      if (seen.has(key) && i - seen.get(key)! >= 4) {
        longLoop = true;
        break;
      }
      seen.set(key, i);
    }

    return { count: entries.length, moves: moves.length, traps: traps.length, oscillation, longLoop, lastPositions: positions.slice(-10), repeatingPattern };
  };

  const logAnalysis = analyzeLog();

  // ---- Board snapshot for reproduction ----
  const boardSnapshot = board.map((row, r) =>
    row.map((cell, c) => {
      if (r === catPosition.r && c === catPosition.c) return 'C';
      if (r === mousePosition.r && c === mousePosition.c) return 'M';
      if (cell.type === CellType.Box) return 'X';
      if (cell.type === CellType.Pile) return '#';
      if (cell.type === CellType.Tunnel) return 'T';
      if (cell.type === CellType.MouseHole) return 'H';
      if (butterPositions.some(b => b.r === r && b.c === c)) return 'B';
      if (trapPosition?.r === r && trapPosition?.c === c) return 'R';
      return '.';
    }).join('')
  ).join('\n');

  // ---- Comprehensive board entity listing ----
  const boardEntities = useMemo(() => {
    const entities: string[] = [];
    const boardSize = board.length;
    // Boxes
    const boxes: string[] = [];
    const piles: string[] = [];
    const butterSpots: string[] = [];
    for (let r = 0; r < boardSize; r++) {
      for (let c = 0; c < boardSize; c++) {
        if (board[r][c].type === CellType.Box) boxes.push(`(${r},${c})`);
        if (board[r][c].type === CellType.Pile) piles.push(`(${r},${c})`);
        if (butterPositions.some(b => b.r === r && b.c === c)) butterSpots.push(`(${r},${c})`);
      }
    }
    if (boxes.length) entities.push(`📦 箱子[${boxes.length}]: ${boxes.join(', ')}`);
    if (piles.length) entities.push(`🪵 桩子[${piles.length}]: ${piles.join(', ')}`);
    if (butterSpots.length) entities.push(`🧀 黄油[${butterSpots.length}]: ${butterSpots.join(', ')}`);
    if (trapPosition) entities.push(`🪤 陷阱: (${trapPosition.r},${trapPosition.c})`);
    if (blockedTunnels.length) entities.push(`🔒 封锁隧道: ${blockedTunnels.map(t => `(${t.r},${t.c})`).join(', ')}`);
    return entities;
  }, [board, butterPositions, trapPosition, blockedTunnels]);

  // ---- Key cells around cat and mouse ----
  const nearbyCells = (() => {
    const info: string[] = [];
    for (const [label, pr, pc] of [
      ['cat', catPosition.r, catPosition.c],
      ['mouse', mousePosition.r, mousePosition.c],
    ] as const) {
      for (const d of [{key:'↑',dr:-1,dc:0},{key:'↓',dr:1,dc:0},{key:'←',dr:0,dc:-1},{key:'→',dr:0,dc:1}] as const) {
        const nr = pr + d.dr, nc = pc + d.dc;
        if (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize) {
          const cell = board[nr][nc];
          info.push(`${label}${d.key}(${nr},${nc}): type=${cell.type}${cell.piece ? ' piece='+cell.piece : ''}`);
        }
      }
    }
    return info.join(' | ');
  })();

  return (
    <details style={{
      backgroundColor: '#1e1e1e',
      borderRadius: '0.75rem',
      padding: '1rem',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      fontFamily: 'monospace',
      fontSize: '0.7rem',
      color: '#d4d4d4',
      maxHeight: '800px',
      overflow: 'auto',
      width: '100%',
      maxWidth: '700px',
    }}>
      <summary style={{
        cursor: 'pointer',
        fontWeight: 'bold',
        color: '#4ec9b0',
        fontSize: '0.85rem',
        marginBottom: '0.5rem',
      }}>
        🔧 Debug (AI diagnostic)
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyAll(); }}
          style={{
            marginLeft: '0.75rem',
            fontSize: '0.7rem',
            padding: '0.1rem 0.5rem',
            borderRadius: '0.4rem',
            border: '1px solid #4ec9b0',
            background: 'transparent',
            color: '#4ec9b0',
            cursor: 'pointer',
          }}
        >
          {copied ? '✅ 已复制' : '📋 一键复制全部调试信息'}
        </button>
      </summary>

      {/* === HARD_SEARCH DEBUG (Search AI last turn) === */}
      <div style={{ border: '1px solid #3b3b3b', borderRadius: '0.5rem', padding: '0.5rem', marginTop: '0.5rem', background: '#161616' }}>
        <div style={{ color: '#c586c0', fontWeight: 'bold', fontSize: '0.75rem' }}>
          [HARD_SEARCH]
          {hardSearch && (
            <button
              onClick={(e) => { e.stopPropagation(); copyHardSearch(); }}
              style={{
                float: 'right',
                fontSize: '0.65rem',
                padding: '0 0.4rem',
                borderRadius: '0.3rem',
                border: '1px solid #c586c0',
                background: 'transparent',
                color: '#c586c0',
                cursor: 'pointer',
              }}
            >
              📋 复制
            </button>
          )}
        </div>
        {hardSearch ? (
          <pre style={{ margin: '0.3rem 0 0', fontSize: '0.65rem', lineHeight: '1.4', color: '#d4d4d4', whiteSpace: 'pre-wrap' }}>
            {formatHardSearch(hardSearch)}
          </pre>
        ) : (
          <div style={{ color: '#666', fontSize: '0.65rem', marginTop: '0.2rem' }}>no Hard search this turn (Easy/Medium or not yet run)</div>
        )}
      </div>

      {/* === SECTION 1: CRITICAL DIAGNOSTICS === */}
      <div style={{ color: '#569cd6', fontWeight: 'bold', marginTop: '0.5rem' }}>【CRITICAL】</div>
      <div style={{ color: '#ce9178' }}>
        <div>turnTransition: {turnTransitionOk}</div>
        <div>distToMouse: {distToMouse} | {catCanReachMouse}</div>
        <div>animating: {animating ? 'YES' : 'NO'} | currentPlayer: {currentPlayer} | phase: {phase}</div>
        <div>nearby: {nearbyCells}</div>
      </div>

      {/* === SECTION 2: STATE SNAPSHOT === */}
      <div style={{ color: '#569cd6', fontWeight: 'bold', marginTop: '0.5rem' }}>【STATE】</div>
      <div style={{ color: '#ce9178' }}>
        <div>cat:({catPosition.r},{catPosition.c}) mouse:({mousePosition.r},{mousePosition.c})</div>
        <div>catMoves:{catMovesLeft} mouseMoves:{mouseMovesLeft}</div>
        <div>butter:{mouseHasButter} skill:{mouseSkillActive} trap:{trapPosition ? `(${trapPosition.r},${trapPosition.c})` : 'none'}</div>
        <div>trapRemain:{catTrapsRemaining} blockedTunnels:{blockedTunnels.length} choices:{tunnelExitChoices.length}</div>
        <div>mode:{gameMode} difficulty:{difficulty} phase:{phase}</div>
      </div>

      {/* === SECTION 3: BOARD SNAPSHOT === */}
      <div style={{ color: '#569cd6', fontWeight: 'bold', marginTop: '0.5rem' }}>【BOARD】</div>
      <pre style={{ margin: '0.3rem 0', fontSize: '0.65rem', lineHeight: '1.1', color: '#6a9955' }}>
        {boardSnapshot}
      </pre>
      <div style={{ color: '#666', fontSize: '0.6rem' }}>
        C=cat M=mouse X=box #=pile T=tunnel H=hole B=butter R=trap .=empty
      </div>

      {/* === SECTION 3b: ENTITY LISTING === */}
      <div style={{ color: '#569cd6', fontWeight: 'bold', marginTop: '0.5rem' }}>【ENTITIES】</div>
      <div style={{ color: '#ce9178', fontSize: '0.7rem', lineHeight: '1.6' }}>
        {boardEntities.length === 0 ? 'none' :
          boardEntities.map((e, i) => <div key={i}>{e}</div>)
        }
      </div>

      {/* === SECTION 4: AI LOG ANALYSIS === */}
      <div style={{ color: '#569cd6', fontWeight: 'bold', marginTop: '0.5rem' }}>【AI_LOG】</div>
      <div style={{ color: '#ce9178' }}>
        <div>total:{logAnalysis.count} moves:{logAnalysis.moves} traps:{logAnalysis.traps}</div>
        <div>oscillation:{logAnalysis.oscillation ? '⚠️ YES' : 'no'}</div>
        <div>longLoop:{logAnalysis.longLoop ? '⚠️ YES' : 'no'}</div>
        <div>repeatingPattern:{logAnalysis.repeatingPattern || 'none'}</div>
        {logAnalysis.lastPositions.length > 0 && (
          <div style={{ marginTop: '0.3rem' }}>
            last_moves:
            {logAnalysis.lastPositions.map((p, i) => (
              <span key={i} style={{ color: '#dcdcaa', marginRight: '0.5rem' }}>
                ({p.from[0]},{p.from[1]})→({p.to[0]},{p.to[1]})
              </span>
            ))}
          </div>
        )}
      </div>

      {/* === SECTION 5: FULL ACTION LOG === */}
      <details style={{ marginTop: '0.3rem' }}>
        <summary style={{ cursor: 'pointer', color: '#dcdcaa' }}>【FULL_LOG】expand</summary>
        <div style={{ maxHeight: '200px', overflow: 'auto', marginTop: '0.3rem' }}>
          {catActionLog.length === 0 ? (
            <div style={{ color: '#666' }}>empty</div>
          ) : (
            catActionLog.map((log, i) => (
              <div key={i} style={{
                color: log.includes('陷阱') ? '#ce9178' : log.includes('推箱') ? '#dcdcaa' : '#d4d4d4',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {log}
              </div>
            ))
          )}
        </div>
      </details>

      {/* === SECTION 6: BUTTER POSITIONS === */}
      <div style={{ color: '#569cd6', fontWeight: 'bold', marginTop: '0.5rem' }}>【BUTTER】</div>
      <div style={{ color: '#ce9178' }}>
        {butterPositions.length === 0 ? 'none' :
          butterPositions.map((b, i) => (
            <span key={i} style={{ marginRight: '0.5rem' }}>
              [{i}]:({b.r},{b.c}) distToMouse:{Math.abs(b.r-mousePosition.r)+Math.abs(b.c-mousePosition.c)}
            </span>
          ))
        }
      </div>

      {/* === SECTION 7: TUNNEL INFO === */}
      <div style={{ color: '#569cd6', fontWeight: 'bold', marginTop: '0.5rem' }}>【TUNNELS】</div>
      <div style={{ color: '#ce9178' }}>
        corners:[
          {tunnelCorners.map((t, i) => (
            <span key={i} style={{ marginRight: '0.3rem' }}>
              ({t.r},{t.c}){blockedTunnels.some(b => b.r===t.r && b.c===t.c) ? '🔒' : '·'}
            </span>
          ))}
        ]
        {tunnelExitChoices.length > 0 && (
          <span style={{ marginLeft: '0.5rem', color: '#dcdcaa' }}>
            choices:{tunnelExitChoices.map(t => `(${t.r},${t.c})${t.label}`).join(',')}
          </span>
        )}
      </div>

      {/* === SECTION 8: MESSAGE === */}
      <div style={{ color: '#569cd6', fontWeight: 'bold', marginTop: '0.5rem' }}>【MSG】</div>
      <div style={{ color: '#dcdcaa' }}>"{message}"</div>

      {/* === SECTION 9: GAME EVENT LOG === */}
      <details style={{ marginTop: '0.5rem' }}>
        <summary style={{ cursor: 'pointer', color: '#dcdcaa' }}>【GAME_EVENT_LOG】expand (last 80)</summary>
        <div style={{ maxHeight: '300px', overflow: 'auto', marginTop: '0.3rem' }}>
          {gameEventLog.length === 0 ? (
            <div style={{ color: '#666' }}>empty</div>
          ) : (
            gameEventLog.slice(-80).map((log, i) => (
              <div key={i} style={{
                color: log.includes('SKILL') ? '#c586c0' : log.includes('BUTTER') ? '#dcdcaa' : log.includes('WIN') ? '#4ec9b0' : log.includes('TRAP') ? '#ce9178' : log.includes('TUNNEL') ? '#569cd6' : log.includes('TURN') ? '#6a9955' : '#d4d4d4',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {log}
              </div>
            ))
          )}
        </div>
      </details>
    </details>
  );
};
