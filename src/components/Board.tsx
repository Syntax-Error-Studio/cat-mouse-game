import { CellType, GamePhase, PieceType, GameMode } from '../game/types';
import React, { useEffect, useState, useRef, useCallback } from 'react';

type BoardCell = { type: CellType; piece?: PieceType; hasButter: boolean };

interface BoardProps {
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
  gameMode: GameMode;
  blockedTunnels: { r: number; c: number }[];
  message: string;
  onMove: (key: string) => void;
  onSkill: () => void;
  onTrap: () => void;
  onRestart: () => void;
  onChooseExit: (r: number, c: number) => void;
  tunnelExitChoices: { r: number; c: number; label: string }[];
  catActionLog?: string[]; // Debug: AI action log
  gameEventLog?: string[]; // Debug: mouse game event log
  gameOverDismissed: boolean; // Whether game over overlay is dismissed
  onGameOverDismiss?: () => void; // Called when user clicks "关闭" on game over overlay
  config: { boardSize: number; difficulty: string; gameMode: string; boxCount: number; butterCount: number }; // Config snapshot for feedback
  hideCat?: boolean; // 教程基础阶段：隐藏猫
  showSidePanel?: boolean;   // 是否显示右侧信息栏（教程模式关闭）
  showRestartButton?: boolean; // 是否显示「重新开始」按钮（教程模式关闭）
  showKeyboardHint?: boolean;  // 是否显示键盘提示（教程模式关闭）
}

const SPRITE: Record<string, string> = {
  cat: '/cat.png',
  mouse: '/mouse.png',
  cheese: '/cheese.png',
  box: '/box.png',
  trap: '/trap.png',
  pile: '/pile.png',
  tunnel: '/tunnel.png',
};

/** Smooth transition duration for piece movement (ms) */
const MOVE_DURATION = 200;

export const Board: React.FC<BoardProps> = ({
  board, catPosition, mousePosition, butterPositions,
  mouseHasButter, mouseSkillActive, catMovesLeft, mouseMovesLeft,
  trapPosition, catTrapsRemaining, currentPlayer, phase, gameMode, blockedTunnels, message,
  onMove, onSkill, onTrap, onRestart, onChooseExit, tunnelExitChoices,
  catActionLog = [], gameEventLog = [], onGameOverDismiss, gameOverDismissed, config, hideCat = false,
  showSidePanel = true, showRestartButton = true, showKeyboardHint = true,
}) => {
  const isMouseTurn = phase === GamePhase.Playing && currentPlayer === PieceType.Mouse;
  const isCatTurn = phase === GamePhase.Playing && currentPlayer === PieceType.Cat;
  const isDual = gameMode === GameMode.Dual;
  const isChoosingTunnel = phase === GamePhase.ChoosingTunnelExit;
  const isGameOver = phase === GamePhase.CatWins || phase === GamePhase.MouseWins;
  const boardRows = board.length;
  const boardCols = board.length > 0 ? board[0].length : boardRows;
  // 隧道位置直接从棋盘读取（支持自定义地图把通道画在任意位置），四角通道保留方向箭头标签
  const tunnelCorners = (() => {
    const corners: { r: number; c: number; label: string }[] = [];
    const dirLabel: Record<string, string> = {
      '0,0': '左上',
      [`0,${boardCols - 1}`]: '右上',
      [`${boardRows - 1},0`]: '左下',
      [`${boardRows - 1},${boardCols - 1}`]: '右下',
    };
    for (let r = 0; r < boardRows; r++) {
      for (let c = 0; c < boardCols; c++) {
        if (board[r]?.[c]?.type === CellType.Tunnel) {
          corners.push({ r, c, label: dirLabel[`${r},${c}`] ?? `通道${corners.length + 1}` });
        }
      }
    }
    return corners;
  })();
  const isTunnelBlocked = (r: number, c: number) => (blockedTunnels || []).some(t => t.r === r && t.c === c);

  // ---- Feedback modal state ----
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackTitle, setFeedbackTitle] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [reportText, setReportText] = useState('');

  // ---- Keyboard event listener ----
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Tunnel exit selection
      if (isChoosingTunnel && tunnelExitChoices.length > 0) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= tunnelExitChoices.length) {
          const choice = tunnelExitChoices[num - 1];
          onChooseExit(choice.r, choice.c);
          return;
        }
        return;
      }

      const isMouseTurn = phase === GamePhase.Playing && currentPlayer === PieceType.Mouse;
      const isCatTurn = phase === GamePhase.Playing && currentPlayer === PieceType.Cat;

      if (isMouseTurn) {
        if (e.key === ' ') {
          e.preventDefault();
          onSkill();
          return;
        }
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
          e.preventDefault();
          onMove(e.key);
        }
      } else if (isCatTurn && gameMode === GameMode.Dual) {
        const catKeyMap: Record<string, string> = {
          w: 'ArrowUp', W: 'ArrowUp',
          s: 'ArrowDown', S: 'ArrowDown',
          a: 'ArrowLeft', A: 'ArrowLeft',
          d: 'ArrowRight', D: 'ArrowRight',
        };
        if (e.key === ' ') {
          e.preventDefault();
          onTrap();
          return;
        }
        const mapped = catKeyMap[e.key];
        if (mapped) {
          e.preventDefault();
          onMove(mapped);
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [phase, currentPlayer, gameMode, isChoosingTunnel, tunnelExitChoices, onMove, onSkill, onTrap, onChooseExit]);

  // ---- Feedback handler: generate formatted report ----
  const generateReport = useCallback(() => {
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

    const winner = phase === GamePhase.MouseWins ? '鼠获胜 🎉' : '猫获胜 😺';
    const configStr = `棋盘:${config.boardSize}x${config.boardSize} | 难度:${config.difficulty} | 模式:${config.gameMode} | 箱子:${config.boxCount} | 黄油:${config.butterCount}`;

    let text = `# 游戏反馈\n`;
    text += `标题: ${feedbackTitle || '未命名'}\n`;
    text += `时间: ${new Date().toLocaleString('zh-CN')}\n`;
    text += `结果: ${winner}\n`;
    text += `配置: ${configStr}\n\n`;

    text += `## 棋盘快照\n\`\`\`\n${boardSnapshot}\n\`\`\`\n`;
    text += `图例: C=猫 M=鼠 X=箱 #=桩 T=通道 H=洞 B=黄油 R=陷阱 .=空地\n\n`;

    text += `## 关键状态\n`;
    text += `- 猫位置: (${catPosition.r},${catPosition.c}) 剩余步数: ${catMovesLeft}\n`;
    text += `- 鼠位置: (${mousePosition.r},${mousePosition.c}) 剩余步数: ${mouseMovesLeft}\n`;
    text += `- 鼠携带黄油: ${mouseHasButter ? '是' : '否'}\n`;
    text += `- 鼠技能激活: ${mouseSkillActive ? '是' : '否'}\n`;
    text += `- 陷阱位置: ${trapPosition ? `(${trapPosition.r},${trapPosition.c})` : '无'}\n`;
    text += `- 猫剩余陷阱: ${catTrapsRemaining}\n`;
    text += `- 封锁隧道: ${blockedTunnels.length > 0 ? blockedTunnels.map(t => `(${t.r},${t.c})`).join(', ') : '无'}\n`;
    text += `- 当前阶段: ${phase}\n`;
    text += `- 当前玩家: ${currentPlayer}\n`;
    text += `- 最新消息: ${message}\n\n`;

    if (catActionLog.length > 0) {
      text += `## AI行动日志 (最近30条)\n\`\`\`\n`;
      text += catActionLog.slice(-30).join('\n');
      text += `\n\`\`\`\n`;
    }

    if (gameEventLog.length > 0) {
      text += `## GAME_EVENT_LOG (最近80条)\n\`\`\`\n`;
      text += gameEventLog.slice(-80).join('\n');
      text += `\n\`\`\`\n`;
    }

    setReportText(text);
    setShowReport(true);
  }, [board, catPosition, mousePosition, butterPositions, trapPosition, phase, currentPlayer, message,
    catMovesLeft, mouseMovesLeft, mouseHasButter, mouseSkillActive, config, catActionLog, gameEventLog, blockedTunnels, feedbackTitle]);

  // ---- Desktop / responsive detection ----
  const [isDesktop, setIsDesktop] = useState(typeof window !== 'undefined' && window.innerWidth >= 768);
  useEffect(() => {
    const handleResize = () => setIsDesktop(window.innerWidth >= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ---- Board sizing ----
  const boardRef = useRef<HTMLDivElement>(null);
  const [boardPx, setBoardPx] = useState(480);

  useEffect(() => {
    const measure = () => {
      if (boardRef.current) setBoardPx(Math.round(boardRef.current.getBoundingClientRect().width));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isDesktop]);

  // ---- Animated piece overlays ----
  // Pieces are rendered as absolutely-positioned divs on top of the board grid.
  // They use CSS transform + transition for smooth sliding between cells.
  const pieceStyle = (r: number, c: number): React.CSSProperties => ({
    position: 'absolute',
    width: `${100 / boardCols}%`,
    height: `${100 / boardRows}%`,
    left: `${(c / boardCols) * 100}%`,
    top: `${(r / boardRows) * 100}%`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: `left ${MOVE_DURATION}ms cubic-bezier(0.25,0.1,0.25,1), top ${MOVE_DURATION}ms cubic-bezier(0.25,0.1,0.25,1)`,
    zIndex: 10,
    pointerEvents: 'none',
  });

  const cellImgStyle: React.CSSProperties = {
    width: '90%',
    height: '90%',
    objectFit: 'contain',
    pointerEvents: 'none',
  };

  // ---- Render helpers ----

  const renderCell = (cell: BoardCell, r: number, c: number) => {
    // Check what entity is on this cell (used for bg + icons)
    const isButter = butterPositions.some(b => b.r === r && b.c === c);
    const isTrap = trapPosition?.r === r && trapPosition?.c === c;

    let bg = '#f0e6d3';

    // Cell type background
    if (cell.type === CellType.Box) { bg = '#8B6914'; }
    else if (cell.type === CellType.MouseHole) { bg = '#7c2d12'; }
    else if (cell.type === CellType.Trap) { bg = '#cc4444'; }
    else if (cell.type === CellType.ButterSpot) { bg = isButter ? '#fef08a' : '#f0e6d3'; }
    else if (cell.type === CellType.Tunnel) {
      bg = mouseHasButter && !mouseSkillActive ? '#86efac' : '#22c55e';
      if (isTunnelBlocked(r, c)) bg = '#555555';
    }
    else if (trapPosition?.r === r && trapPosition?.c === c) { bg = '#fecaca'; }
    else if (cell.type === CellType.Pile) { bg = '#6b4226'; }
    else if (cell.type === CellType.Wall) { bg = '#4b5563'; }   // 墙：灰砖色，固定障碍
    else if (cell.type === CellType.Void) { bg = '#111827'; }   // 虚空：深色，表示地图之外

    // Tunnel arrow label
    const tunnelLabel = tunnelCorners.find(t => t.r === r && t.c === c);
    const tunnelArrow = tunnelLabel ? { '左上': '↘', '右上': '↙', '左下': '↗', '右下': '↖' }[tunnelLabel.label] : '';

    return (
      <div
        key={`${r}-${c}`}
        style={{
          backgroundColor: bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '1.3em',
          cursor: isChoosingTunnel && tunnelExitChoices.some(t => t.r === r && t.c === c) ? 'pointer' : 'default',
          border: '1px solid rgba(0,0,0,0.1)',
          transition: 'background-color 0.15s ease',
          position: 'relative',
        }}
        onClick={() => {
          if (isChoosingTunnel && tunnelExitChoices.some(t => t.r === r && t.c === c)) {
            onChooseExit(r, c);
          }
        }}
      >
        {cell.type === CellType.Box && <img src={SPRITE.box} alt="箱" style={cellImgStyle} />}
        {cell.type === CellType.Pile && <img src={SPRITE.pile} alt="杂货堆" style={cellImgStyle} />}
        {isButter && <img src={SPRITE.cheese} alt="奶酪" style={cellImgStyle} />}
        {isTrap && <img src={SPRITE.trap} alt="陷阱" style={cellImgStyle} />}
        {cell.type === CellType.Tunnel && !tunnelArrow && <img src={SPRITE.tunnel} alt="快速通道" style={cellImgStyle} />}
        {cell.type === CellType.Tunnel && tunnelArrow && <img src={SPRITE.tunnel} alt="快速通道" style={cellImgStyle} />}
        {cell.type === CellType.MouseHole && <span style={{ fontSize: '1.3em' }}>🕳️</span>}
        {cell.type === CellType.Wall && <span style={{ fontSize: '1.3em' }}>🧱</span>}
        {cell.type === CellType.Void && <span style={{ fontSize: '1.05em', opacity: 0.35 }}>🌫️</span>}
        {cell.type === CellType.Empty && tunnelArrow && <span style={{ opacity: 0.4 }}>{tunnelArrow}</span>}
      </div>
    );
  };

  // ---- Turn indicator ----
  const turnText = isDual
    ? (isCatTurn ? '🐱 猫操控' : '🐭 鼠操控')
    : (isCatTurn ? '🐱 猫(AI)' : '🐭 鼠的回合');

  // ---- Keyboard hint ----
  const keyHint = isDual
    ? (isCatTurn
      ? '🐱 猫: WASD 移动 | 空格 = 放置陷阱'
      : '🐭 鼠: ↑↓←→ 移动 | 空格 = 技能')
    : (isCatTurn
      ? '🤖 猫由 AI 自动操控'
      : '🐭 鼠: ↑↓←→ 移动 | 空格 = 技能');

  // ---- Operation hints ----
  const hints = isMouseTurn ? [
    !mouseHasButter && { text: '💡 目标：走到奶酪捡起黄油 → 带回鼠洞！按空格消耗黄油获得额外步数和传送权限', color: '#854d0e', bg: '#fefce8' },
    mouseHasButter && !mouseSkillActive && { text: '⚠️ 带黄油移速慢！按空格消耗黄油激活技能解锁传送+额外步数！别走绿色通道！', color: '#991b1b', bg: '#fef2f2' },
    mouseHasButter && mouseSkillActive && { text: '🔥 技能已激活！可以走传送通道了！直奔鼠洞！', color: '#7c2d12', bg: '#fef3c7' },
  ].filter(Boolean) as { text: string; color: string; bg: string }[] : [];

  // ---- Controls ----
  const controls = [
    ...(showRestartButton ? [{ label: '🔄 重新开始', onClick: onRestart, bg: '#374151' }] : []),
    ...(isMouseTurn && mouseHasButter && !mouseSkillActive ? [{
      label: '🔥 消耗黄油激活技能（空格）', onClick: onSkill, bg: '#dc2626',
    }] : []),
    ...(isCatTurn && catTrapsRemaining > 0 ? [{
      label: `🪤 放置陷阱（空格）[${catTrapsRemaining}]`, onClick: onTrap, bg: '#ea580c',
    }] : []),
  ];

  // ========== MOBILE LAYOUT ==========
  if (!isDesktop) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', width: '100%' }}>
        {/* HUD */}
        <div style={{ width: '100%', maxWidth: '480px', backgroundColor: '#fff', borderRadius: '0.75rem', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', padding: '1rem', fontSize: '0.875rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '1.125rem', fontWeight: 'bold' }}>{turnText}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div style={{ color: '#2563eb', fontWeight: 'bold', fontSize: '0.85rem' }}>
              🐭 鼠剩余: {mouseMovesLeft} 步
              {mouseHasButter && !mouseSkillActive && <span style={{ color: '#d97706', marginLeft: '0.5rem' }}>🧈 携带黄油（空格=消耗+技能）</span>}
              {mouseSkillActive && <span style={{ color: '#dc2626', marginLeft: '0.5rem' }}>🔥 技能激活中！(+步数+传送)</span>}
            </div>
            <div style={{ color: '#dc2626', fontWeight: 'bold', fontSize: '0.85rem' }}>
              🐱 猫剩余: {catMovesLeft} 步
              {catTrapsRemaining > 0 ? <span style={{ color: '#ea580c', marginLeft: '0.5rem' }}>🪤 可放陷阱({catTrapsRemaining})</span> : <span style={{ color: '#9ca3af', marginLeft: '0.5rem' }}>🪤 陷阱已用完</span>}
            </div>
          </div>
          <div style={{
            padding: '0.5rem', backgroundColor: isMouseTurn ? '#eff6ff' : isCatTurn ? '#fef2f2' : '#f0fdf4',
            borderRadius: '0.375rem', fontSize: '0.8rem',
            color: isMouseTurn ? '#1e40af' : isCatTurn ? '#991b1b' : '#166534',
            minHeight: '2.5rem',
          }}>
            {message}
          </div>
          {hints.map((h, i) => (
            <div key={i} style={{ marginTop: '0.375rem', fontSize: '0.7rem', color: h!.color, backgroundColor: h!.bg, padding: '0.375rem', borderRadius: '0.25rem' }}>
              {h!.text}
            </div>
          ))}
        </div>

        {/* Board */}
        <div
          ref={boardRef}
          style={{
            position: 'relative',
            width: `${boardPx}px`,
            height: `${boardPx}px`,
            border: '2px solid #374151',
            borderRadius: '0.5rem',
            overflow: 'hidden',
            boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
          }}
        >
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${boardCols}, 1fr)`,
            gridTemplateRows: `repeat(${boardRows}, 1fr)`,
            width: '100%',
            height: '100%',
          }}>
            {board.map((row, r) => row.map((cell, c) => renderCell(cell, r, c)))}
          </div>

          {/* Mouse piece overlay */}
          <div style={pieceStyle(mousePosition.r, mousePosition.c)}>
            <img src={SPRITE.mouse} alt="鼠" style={cellImgStyle} />
          </div>

          {/* Cat piece overlay */}
          {!hideCat && (
            <div style={pieceStyle(catPosition.r, catPosition.c)}>
              <img src={SPRITE.cat} alt="猫" style={cellImgStyle} />
            </div>
          )}
        </div>

        {/* Tunnel exit choices */}
        {isChoosingTunnel && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center', width: '100%', maxWidth: '480px' }}>
            <div style={{ fontSize: '0.875rem', fontWeight: 'bold', color: '#7c2d12', width: '100%', textAlign: 'center' }}>
              选择传送出口（点击格子）：
            </div>
            {tunnelExitChoices.map((exit, i) => (
              <button key={i} onClick={() => onChooseExit(exit.r, exit.c)} style={{
                padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '2px solid #22c55e',
                backgroundColor: '#f0fdf4', color: '#166534', fontWeight: 'bold', cursor: 'pointer',
              }}>
                {exit.label} ({exit.r},{exit.c})
              </button>
            ))}
          </div>
        )}

        {/* Controls */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {controls.map((ctrl, i) => (
            <button key={i} onClick={ctrl.onClick} style={{
              padding: '0.5rem 1rem', borderRadius: '0.5rem', border: 'none',
              backgroundColor: ctrl.bg, color: '#fff', fontWeight: 'bold', cursor: 'pointer',
            }}>
              {ctrl.label}
            </button>
          ))}
        </div>

        {/* Keyboard hints */}
        {showKeyboardHint && (
          <div style={{ fontSize: '0.7rem', color: '#6b7280', textAlign: 'center' }}>
            <div>{keyHint}</div>
          </div>
        )}

        {/* Game Over Overlay */}
        {isGameOver && !gameOverDismissed && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
            <div style={{ backgroundColor: '#fff', borderRadius: '1rem', padding: '2rem', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', textAlign: 'center', maxWidth: '20rem', margin: '1rem' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>{phase === GamePhase.MouseWins ? '🎉' : '😺'}</div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                {phase === GamePhase.MouseWins ? '鼠获胜！' : '猫获胜！'}
              </h2>
              <p style={{ color: '#4b5563', marginBottom: '1.5rem' }}>
                {phase === GamePhase.MouseWins ? '小老鼠成功把黄油带回了家！' : '猫咪抓住了小老鼠！'}
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button onClick={onRestart} style={{
                  padding: '0.75rem 1.5rem', borderRadius: '0.5rem', border: 'none',
                  backgroundColor: '#16a34a', color: '#fff', fontWeight: 'bold', fontSize: '1.125rem', cursor: 'pointer',
                }}>
                  🔄 再来一局
                </button>
                <button onClick={() => setShowFeedback(true)} style={{
                  padding: '0.75rem 1.5rem', borderRadius: '0.5rem', border: '2px solid #2563eb',
                  backgroundColor: '#eff6ff', color: '#1e40af', fontWeight: 'bold', fontSize: '1.125rem', cursor: 'pointer',
                }}>
                  🐛 问题反馈
                </button>
                <button onClick={() => onGameOverDismiss?.()} style={{
                  padding: '0.75rem 1.5rem', borderRadius: '0.5rem', border: '2px solid #6b7280',
                  backgroundColor: '#fff', color: '#374151', fontWeight: 'bold', fontSize: '1.125rem', cursor: 'pointer',
                }}>
                  ✖ 关闭
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Feedback Modal */}
        {showFeedback && !showReport && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
            onClick={() => setShowFeedback(false)}>
            <div style={{ backgroundColor: '#fff', borderRadius: '1rem', padding: '2rem', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', textAlign: 'center', maxWidth: '22rem', width: '90%', margin: '1rem' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🐛</div>
              <h2 style={{ fontSize: '1.375rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>问题反馈</h2>
              <p style={{ color: '#6b7280', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
                生成这局游戏的调试报告，复制后发给我（AI）来分析问题。
              </p>
              <input
                type="text"
                placeholder="给这个问题起个名字（可选）"
                value={feedbackTitle}
                onChange={e => setFeedbackTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') generateReport(); }}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '0.6rem 0.75rem',
                  borderRadius: '0.5rem',
                  border: '1px solid #d1d5db',
                  fontSize: '0.95rem',
                  marginBottom: '1.25rem',
                  outline: 'none',
                }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                <button onClick={generateReport} style={{
                  padding: '0.6rem 2rem', borderRadius: '0.5rem', border: 'none',
                  backgroundColor: '#2563eb', color: '#fff', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer',
                }}>
                  📋 生成报告
                </button>
                <button onClick={() => setShowFeedback(false)} style={{
                  padding: '0.6rem 1.5rem', borderRadius: '0.5rem', border: '2px solid #6b7280',
                  backgroundColor: '#fff', color: '#374151', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer',
                }}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Report View Modal */}
        {showReport && reportText && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
            onClick={() => setShowReport(false)}>
            <div style={{ backgroundColor: '#1e1e1e', borderRadius: '1rem', padding: '1.5rem', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', textAlign: 'left', maxWidth: '36rem', width: '95%', maxHeight: '85vh', margin: '1rem', display: 'flex', flexDirection: 'column' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 'bold', color: '#4ec9b0', margin: 0 }}>📋 调试报告</h2>
                <button onClick={() => { navigator.clipboard.writeText(reportText); }} style={{
                  padding: '0.4rem 1rem', borderRadius: '0.5rem', border: 'none',
                  backgroundColor: '#2563eb', color: '#fff', fontWeight: 'bold', fontSize: '0.875rem', cursor: 'pointer',
                }}>
                  📄 复制到剪贴板
                </button>
              </div>
              <pre style={{
                margin: 0,
                flex: 1,
                overflow: 'auto',
                fontSize: '0.7rem',
                lineHeight: '1.4',
                color: '#d4d4d4',
                whiteSpace: 'pre',
                fontFamily: 'monospace',
                padding: '0.75rem',
                backgroundColor: '#252526',
                borderRadius: '0.5rem',
              }}>{reportText}</pre>
              <p style={{ color: '#858585', fontSize: '0.75rem', marginTop: '0.75rem', marginBottom: 0, textAlign: 'center' }}>
                点击"复制到剪贴板"后粘贴给我，我来帮你分析问题
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ========== DESKTOP LAYOUT ==========
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      gap: '2.5rem',
      padding: '1.5rem 2rem',
      maxWidth: '1400px',
      width: '100%',
    }}>
      {/* Left: Game Board Area */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem', flexShrink: 0 }}>
        {/* Board */}
        <div
          ref={boardRef}
          style={{
            position: 'relative',
            width: `${boardPx}px`,
            height: `${boardPx}px`,
            border: '3px solid #374151',
            borderRadius: '0.75rem',
            overflow: 'hidden',
            boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
          }}
        >
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${boardCols}, 1fr)`,
            gridTemplateRows: `repeat(${boardRows}, 1fr)`,
            width: '100%',
            height: '100%',
          }}>
            {board.map((row, r) => row.map((cell, c) => renderCell(cell, r, c)))}
          </div>

          {/* Mouse piece overlay */}
          <div style={pieceStyle(mousePosition.r, mousePosition.c)}>
            <img src={SPRITE.mouse} alt="鼠" style={cellImgStyle} />
          </div>

          {/* Cat piece overlay */}
          {!hideCat && (
            <div style={pieceStyle(catPosition.r, catPosition.c)}>
              <img src={SPRITE.cat} alt="猫" style={cellImgStyle} />
            </div>
          )}
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {controls.map((ctrl, i) => (
            <button key={i} onClick={ctrl.onClick} style={{
              padding: '0.6rem 1.5rem', borderRadius: '0.75rem', border: 'none',
              backgroundColor: ctrl.bg, color: '#fff', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.95rem',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            }}>
              {ctrl.label}
            </button>
          ))}
        </div>

        {/* Keyboard hints */}
        {showKeyboardHint && (
          <div style={{ fontSize: '0.8rem', color: '#6b7280', textAlign: 'center', lineHeight: '1.6' }}>
            <div>{keyHint}</div>
          </div>
        )}
      </div>

      {/* Right: Side Panel (HUD + Info) */}
      {showSidePanel && (
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '1.25rem',
        minWidth: '320px', maxWidth: '380px',
      }}>
        {/* Turn indicator */}
        <div style={{
          backgroundColor: '#fff', borderRadius: '1rem', padding: '1.25rem',
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        }}>
          <div style={{
            fontSize: '1.25rem', fontWeight: 'bold', marginBottom: '0.75rem',
            color: isMouseTurn ? '#1e40af' : isCatTurn ? '#991b1b' : '#166534',
          }}>
            {turnText}
          </div>

          {/* Step counters */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: '#2563eb', fontWeight: 'bold', fontSize: '0.9rem' }}>
                🐭 鼠剩余: {mouseMovesLeft} 步
              </span>
              {mouseHasButter && !mouseSkillActive && (
                <span style={{ fontSize: '0.75rem', color: '#d97706', backgroundColor: '#fef3c7', padding: '0.15rem 0.5rem', borderRadius: '0.5rem' }}>
                  🧈 携带黄油（空格=技能）
                </span>
              )}
              {mouseSkillActive && (
                <span style={{ fontSize: '0.75rem', color: '#dc2626', backgroundColor: '#fef2f2', padding: '0.15rem 0.5rem', borderRadius: '0.5rem' }}>
                  🔥 技能激活中！
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: '#dc2626', fontWeight: 'bold', fontSize: '0.9rem' }}>
                🐱 猫剩余: {catMovesLeft} 步
              </span>
              {catTrapsRemaining > 0 && (
                <span style={{ fontSize: '0.75rem', color: '#ea580c', backgroundColor: '#fff7ed', padding: '0.15rem 0.5rem', borderRadius: '0.5rem' }}>
                  🪤 可放陷阱({catTrapsRemaining})
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Message */}
        <div style={{
          backgroundColor: '#fff', borderRadius: '1rem', padding: '1.25rem',
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        }}>
          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.375rem', fontWeight: 'bold' }}>📢 游戏消息</div>
          <div style={{
            padding: '0.75rem', backgroundColor: isMouseTurn ? '#eff6ff' : isCatTurn ? '#fef2f2' : '#f0fdf4',
            borderRadius: '0.5rem', fontSize: '0.875rem', lineHeight: '1.5',
            color: isMouseTurn ? '#1e40af' : isCatTurn ? '#991b1b' : '#166534',
            minHeight: '3rem',
          }}>
            {message}
          </div>
        </div>

        {/* Operation hints */}
        {hints.length > 0 && (
          <div style={{
            backgroundColor: '#fff', borderRadius: '1rem', padding: '1.25rem',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}>
            <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.5rem', fontWeight: 'bold' }}>💡 提示</div>
            {hints.map((h, i) => (
              <div key={i} style={{
                fontSize: '0.8rem', color: h!.color, backgroundColor: h!.bg,
                padding: '0.6rem 0.75rem', borderRadius: '0.5rem', marginBottom: i < hints.length - 1 ? '0.5rem' : 0,
                lineHeight: '1.4',
              }}>
                {h!.text}
              </div>
            ))}
          </div>
        )}

        {/* Tunnel exit choices */}
        {isChoosingTunnel && (
          <div style={{
            backgroundColor: '#fff', borderRadius: '1rem', padding: '1.25rem',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}>
            <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.5rem', fontWeight: 'bold' }}>🚇 传送出口</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {tunnelExitChoices.map((exit, i) => (
                <button
                  key={i}
                  onClick={() => onChooseExit(exit.r, exit.c)}
                  style={{
                    padding: '0.6rem 1rem', borderRadius: '0.5rem',
                    border: '2px solid #22c55e', backgroundColor: '#f0fdf4',
                    color: '#166534', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.875rem',
                  }}
                >
                  {exit.label} — ({exit.r},{exit.c})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Game Over Overlay */}
        {isGameOver && !gameOverDismissed && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
            <div style={{ backgroundColor: '#fff', borderRadius: '1rem', padding: '2.5rem', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', textAlign: 'center', maxWidth: '24rem', margin: '1rem' }}>
              <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>{phase === GamePhase.MouseWins ? '🎉' : '😺'}</div>
              <h2 style={{ fontSize: '1.75rem', fontWeight: 'bold', marginBottom: '0.75rem' }}>
                {phase === GamePhase.MouseWins ? '鼠获胜！' : '猫获胜！'}
              </h2>
              <p style={{ color: '#4b5563', marginBottom: '2rem', fontSize: '1rem', lineHeight: '1.6' }}>
                {phase === GamePhase.MouseWins ? '小老鼠成功把黄油带回了家！' : '猫咪抓住了小老鼠！'}
              </p>
              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button onClick={onRestart} style={{
                  padding: '0.75rem 2rem', borderRadius: '0.75rem', border: 'none',
                  backgroundColor: '#16a34a', color: '#fff', fontWeight: 'bold', fontSize: '1.125rem', cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(22,163,74,0.3)',
                }}>
                  🔄 再来一局
                </button>
                <button onClick={() => setShowFeedback(true)} style={{
                  padding: '0.75rem 2rem', borderRadius: '0.75rem', border: '2px solid #2563eb',
                  backgroundColor: '#eff6ff', color: '#1e40af', fontWeight: 'bold', fontSize: '1.125rem', cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(37,99,235,0.2)',
                }}>
                  🐛 问题反馈
                </button>
                <button onClick={() => onGameOverDismiss?.()} style={{
                  padding: '0.75rem 2rem', borderRadius: '0.75rem', border: '2px solid #6b7280',
                  backgroundColor: '#fff', color: '#374151', fontWeight: 'bold', fontSize: '1.125rem', cursor: 'pointer',
                }}>
                  ✖ 关闭
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Feedback Modal */}
        {showFeedback && !showReport && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
            onClick={() => setShowFeedback(false)}>
            <div style={{ backgroundColor: '#fff', borderRadius: '1rem', padding: '2rem', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', textAlign: 'center', maxWidth: '22rem', width: '90%', margin: '1rem' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🐛</div>
              <h2 style={{ fontSize: '1.375rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>问题反馈</h2>
              <p style={{ color: '#6b7280', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
                生成这局游戏的调试报告，复制后发给我（AI）来分析问题。
              </p>
              <input
                type="text"
                placeholder="给这个问题起个名字（可选）"
                value={feedbackTitle}
                onChange={e => setFeedbackTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') generateReport(); }}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '0.6rem 0.75rem',
                  borderRadius: '0.5rem',
                  border: '1px solid #d1d5db',
                  fontSize: '0.95rem',
                  marginBottom: '1.25rem',
                  outline: 'none',
                }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                <button onClick={generateReport} style={{
                  padding: '0.6rem 2rem', borderRadius: '0.5rem', border: 'none',
                  backgroundColor: '#2563eb', color: '#fff', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer',
                }}>
                  📋 生成报告
                </button>
                <button onClick={() => setShowFeedback(false)} style={{
                  padding: '0.6rem 1.5rem', borderRadius: '0.5rem', border: '2px solid #6b7280',
                  backgroundColor: '#fff', color: '#374151', fontWeight: 'bold', fontSize: '1rem', cursor: 'pointer',
                }}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Report View Modal */}
        {showReport && reportText && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
            onClick={() => setShowReport(false)}>
            <div style={{ backgroundColor: '#1e1e1e', borderRadius: '1rem', padding: '1.5rem', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', textAlign: 'left', maxWidth: '36rem', width: '95%', maxHeight: '85vh', margin: '1rem', display: 'flex', flexDirection: 'column' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 'bold', color: '#4ec9b0', margin: 0 }}>📋 调试报告</h2>
                <button onClick={() => { navigator.clipboard.writeText(reportText); }} style={{
                  padding: '0.4rem 1rem', borderRadius: '0.5rem', border: 'none',
                  backgroundColor: '#2563eb', color: '#fff', fontWeight: 'bold', fontSize: '0.875rem', cursor: 'pointer',
                }}>
                  📄 复制到剪贴板
                </button>
              </div>
              <pre style={{
                margin: 0,
                flex: 1,
                overflow: 'auto',
                fontSize: '0.7rem',
                lineHeight: '1.4',
                color: '#d4d4d4',
                whiteSpace: 'pre',
                fontFamily: 'monospace',
                padding: '0.75rem',
                backgroundColor: '#252526',
                borderRadius: '0.5rem',
              }}>{reportText}</pre>
              <p style={{ color: '#858585', fontSize: '0.75rem', marginTop: '0.75rem', marginBottom: 0, textAlign: 'center' }}>
                点击"复制到剪贴板"后粘贴给我，我来帮你分析问题
              </p>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
};
