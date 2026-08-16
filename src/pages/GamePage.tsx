import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  createInitialState,
  mouseMove,
  mouseSkill,
  catMove,
  catPlaceTrap,
  endTurn,
  computeCatAiTrajectory,
  getDirectionByKey,
} from '../game/engine';
import { PieceType, GamePhase, GameMode, Difficulty } from '../game/types';
import type { GameConfig } from '../game/config';
import { Board } from '../components/Board';
import { DebugInfo } from '../components/DebugInfo';
import { MenuButton } from '../components/MenuButton';
import { useGame } from '../context/GameContext';

type GameData = ReturnType<typeof createInitialState>;

const CAT_AI_STEP_DELAY = 250;

export function GamePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { config, setDifficulty } = useGame();
  // 若本次对局是从「地图编辑器」点试玩进入的，则提供返回编辑器的入口
  const fromEditor = (location.state as { from?: string } | null)?.from === 'editor';

  // GamePage 是"模式无关"的棋盘壳：对局参数（含 gameMode）全部来自 context，
  // 由对局配置页 /setup/:mode 在进入前写入。新增模式只需扩展配置，不必改动此处。
  const effectiveConfig: GameConfig = config;

  const [gameState, setGameState] = useState<GameData>(() => createInitialState(effectiveConfig));
  const [showDebug, setShowDebug] = useState(false);
  const [gameOverDismissed, setGameOverDismissed] = useState(false);
  const [paused, setPaused] = useState(false);

  const isAnimatingRef = useRef(false);
  const frozenDebugRef = useRef<GameData | null>(null);
  const prevPhaseRef = useRef<GamePhase>(GamePhase.Playing);

  if (gameState.phase !== prevPhaseRef.current && gameState.phase !== GamePhase.Playing) {
    frozenDebugRef.current = { ...gameState };
  }
  prevPhaseRef.current = gameState.phase;
  const debugState = (gameState.phase !== GamePhase.Playing && frozenDebugRef.current) || gameState;

  useEffect(() => {
    if (gameState.phase === GamePhase.CatWins || gameState.phase === GamePhase.MouseWins) {
      setGameOverDismissed(false);
    }
  }, [gameState.phase]);

  const runCatAi = useCallback((initialState: GameData): GameData => {
    if (isAnimatingRef.current) return initialState;

    let catState = initialState;

    if (catState.currentPlayer === PieceType.Mouse && catState.phase === GamePhase.Playing) {
      catState = endTurn(catState);
    }
    if (catState.currentPlayer !== PieceType.Cat || catState.phase !== GamePhase.Playing) {
      return catState !== initialState ? catState : initialState;
    }

    if (catState.catMovesLeft <= 0) {
      catState = { ...catState, catMovesLeft: catState.config.catBaseMoves };
    }

    const trajectory = computeCatAiTrajectory(catState);

    if (!trajectory || trajectory.length === 0) {
      const ended = endTurn(catState);
      setGameState(ended);
      return ended;
    }

    const steps = trajectory;
    isAnimatingRef.current = true;
    let idx = 0;

    function playNext() {
      if (idx >= steps.length) {
        const lastState = steps[steps.length - 1].state;

        if (lastState.phase === GamePhase.CatWins || lastState.phase === GamePhase.MouseWins) {
          setGameState(lastState);
          setGameOverDismissed(false);
          isAnimatingRef.current = false;
          return;
        }

        if (lastState.currentPlayer !== PieceType.Cat) {
          setGameState(lastState);
          isAnimatingRef.current = false;
          return;
        }

        if (lastState.phase === GamePhase.Playing && lastState.catMovesLeft > 0) {
          console.warn('AI trajectory ended early with catMovesLeft > 0. Do not end turn.', lastState);
          setGameState(lastState);
          isAnimatingRef.current = false;
          return;
        }

        const finalState = endTurn(lastState);
        setGameState(finalState);
        isAnimatingRef.current = false;
        return;
      }

      const step = steps[idx];
      idx++;
      setGameState(step.state);
      if (step.state.phase === GamePhase.CatWins || step.state.phase === GamePhase.MouseWins) {
        setGameOverDismissed(false);
        isAnimatingRef.current = false;
        return;
      }
      if (step.from.r === step.to.r && step.from.c === step.to.c) {
        playNext();
        return;
      }
      setTimeout(playNext, CAT_AI_STEP_DELAY);
    }

    playNext();
    return catState;
  }, []);

  const handleMove = useCallback((key: string) => {
    if (paused) return;
    setGameState(prev => {
      if (prev.phase !== GamePhase.Playing) return prev;
      if (isAnimatingRef.current) return prev;

      const dir = getDirectionByKey(key);
      if (!dir) return prev;

      if (prev.currentPlayer === PieceType.Mouse) {
        const result = mouseMove(prev, dir);

        if (result.mouseMovesLeft <= 0 && result.phase === GamePhase.Playing) {
          if (prev.gameMode === GameMode.Single) {
            return runCatAi(result);
          }
          return {
            ...result,
            phase: GamePhase.Playing,
            currentPlayer: PieceType.Cat,
            catMovesLeft: prev.config.catBaseMoves,
          };
        }
        return result;
      }

      if (prev.currentPlayer === PieceType.Cat && prev.gameMode === GameMode.Dual) {
        const result = catMove(prev, dir);

        if (result.catMovesLeft <= 0 && result.phase === GamePhase.Playing) {
          return endTurn(result);
        }
        return result;
      }

      return prev;
    });
  }, [runCatAi, paused]);

  const handleSkill = useCallback(() => {
    if (paused) return;
    setGameState(prev => {
      if (isAnimatingRef.current) return prev;
      if (prev.phase !== GamePhase.Playing) return prev;
      if (prev.currentPlayer !== PieceType.Mouse) return prev;
      return mouseSkill(prev);
    });
  }, [paused]);

  const handleTrap = useCallback(() => {
    if (paused) return;
    setGameState(prev => {
      if (isAnimatingRef.current) return prev;
      if (prev.phase !== GamePhase.Playing) return prev;
      if (prev.currentPlayer !== PieceType.Cat || prev.gameMode !== GameMode.Dual) return prev;
      return catPlaceTrap(prev);
    });
  }, [paused]);

  const handleChooseTunnelExit = useCallback((r: number, c: number) => {
    setGameState(prev => {
      if (prev.phase !== GamePhase.ChoosingTunnelExit) return prev;
      const isValidChoice = (prev.tunnelExitChoices || []).some(t => t.r === r && t.c === c);
      if (!isValidChoice) return prev;

      const newBoard = prev.board.map(row => row.map(cell => ({ ...cell })));
      newBoard[prev.mousePosition.r][prev.mousePosition.c] = {
        ...newBoard[prev.mousePosition.r][prev.mousePosition.c],
        piece: undefined,
      };
      newBoard[r][c] = { ...newBoard[r][c], piece: PieceType.Mouse };

      const afterTeleport: GameData = {
        ...prev,
        board: newBoard,
        blockedTunnels: prev.blockedTunnels,
        mousePosition: { r, c },
        mouseMovesLeft: 0,
        phase: GamePhase.Playing,
        currentPlayer: PieceType.Mouse,
        message: `🧀 鼠通过快速通道传送到 (${r},${c})，轮到猫行动。`,
        tunnelExitChoices: [],
      };

      if (prev.gameMode === GameMode.Single) {
        return runCatAi(endTurn(afterTeleport));
      }
      return endTurn(afterTeleport);
    });
  }, [runCatAi]);

  const handleRestart = useCallback(() => {
    setGameState(createInitialState(effectiveConfig));
    setGameOverDismissed(false);
    setPaused(false);
  }, [effectiveConfig]);

  const cycleDifficulty = useCallback(() => {
    const diffs: Difficulty[] = ['easy', 'medium', 'hard'];
    const idx = (diffs.indexOf(config.difficulty) + 1) % diffs.length;
    setDifficulty(diffs[idx]);
    setGameState(createInitialState({ ...effectiveConfig, difficulty: diffs[idx] }));
  }, [config.difficulty, effectiveConfig, setDifficulty]);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      padding: '1rem',
      backgroundColor: '#fef3c7',
      fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
      gap: '0.8rem',
    }}>
      {/* 顶部控制栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.8rem',
        flexWrap: 'wrap',
        width: '100%',
        maxWidth: '600px',
      }}>
        <MenuButton
          src="/ui/关闭.png"
          alt={fromEditor ? '返回编辑器' : '返回主菜单'}
          onClick={() => navigate(fromEditor ? '/editor' : '/')}
          width="clamp(40px, 5vw, 56px)"
        />

        {fromEditor && (
          <button
            onClick={() => navigate('/editor')}
            style={{
              padding: '0.5rem 1.5rem',
              borderRadius: '0.75rem',
              border: '2px solid #7c2d12',
              backgroundColor: '#fff7ed',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '0.95rem',
              color: '#7c2d12',
              boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            }}
          >
            ✏️ 返回编辑器
          </button>
        )}

        <button
          onClick={cycleDifficulty}
          style={{
            padding: '0.5rem 1.5rem',
            borderRadius: '0.75rem',
            border: '2px solid #374151',
            backgroundColor: '#fff',
            cursor: 'pointer',
            fontWeight: 'bold',
            fontSize: '0.95rem',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          }}
        >
          {config.difficulty === 'easy' ? '🟢 简单' : config.difficulty === 'medium' ? '🟡 中等' : '🔴 困难'}
        </button>

        <button
          onClick={() => setShowDebug(!showDebug)}
          style={{
            padding: '0.5rem 1.5rem',
            borderRadius: '0.75rem',
            border: '2px solid #374151',
            backgroundColor: '#fff',
            cursor: 'pointer',
            fontWeight: 'bold',
            fontSize: '0.95rem',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          }}
        >
          🔧 {showDebug ? '隐藏' : '调试'}
        </button>
      </div>

      {/* 游戏控制按钮 */}
      <div style={{
        display: 'flex',
        gap: '0.6rem',
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}>
        <MenuButton
          src="/ui/开始游戏.png"
          alt="开始游戏"
          onClick={handleRestart}
          width="clamp(48px, 6vw, 64px)"
        />
        <MenuButton
          src="/ui/暂停游戏.png"
          alt="暂停游戏"
          onClick={() => setPaused(p => !p)}
          width="clamp(48px, 6vw, 64px)"
        />
        <MenuButton
          src="/ui/重新开始游戏.png"
          alt="重新开始"
          onClick={handleRestart}
          width="clamp(48px, 6vw, 64px)"
        />
      </div>

      {paused && (
        <div style={{
          padding: '0.5rem 1.5rem',
          backgroundColor: '#FFE0B2',
          borderRadius: '0.5rem',
          border: '2px solid #FF9800',
          fontWeight: 'bold',
          color: '#E65100',
        }}>
          ⏸️ 已暂停 — 点击暂停按钮继续
        </div>
      )}

      <Board
        board={gameState.board}
        catPosition={gameState.catPosition}
        mousePosition={gameState.mousePosition}
        butterPositions={gameState.butterPositions}
        mouseHasButter={gameState.mouseHasButter}
        mouseSkillActive={gameState.mouseSkillActive}
        catMovesLeft={gameState.catMovesLeft}
        mouseMovesLeft={gameState.mouseMovesLeft}
        trapPosition={gameState.trapPosition}
        catTrapsRemaining={gameState.catTrapsRemaining}
        currentPlayer={gameState.currentPlayer}
        phase={gameState.phase}
        message={gameState.message}
        gameMode={gameState.gameMode}
        blockedTunnels={gameState.blockedTunnels}
        onMove={handleMove}
        onSkill={handleSkill}
        onTrap={handleTrap}
        onRestart={handleRestart}
        onChooseExit={handleChooseTunnelExit}
        tunnelExitChoices={gameState.tunnelExitChoices}
        onGameOverDismiss={() => setGameOverDismissed(true)}
        gameOverDismissed={gameOverDismissed}
        config={{
          boardSize: effectiveConfig.boardSize,
          difficulty: effectiveConfig.difficulty,
          gameMode: effectiveConfig.gameMode,
          boxCount: effectiveConfig.boxCount,
          butterCount: effectiveConfig.butterCount,
        }}
        catActionLog={gameState.catActionLog}
        gameEventLog={gameState.gameEventLog}
      />

      {showDebug && (
        <DebugInfo
          board={debugState.board}
          catPosition={debugState.catPosition}
          mousePosition={debugState.mousePosition}
          butterPositions={debugState.butterPositions}
          mouseHasButter={debugState.mouseHasButter}
          mouseSkillActive={debugState.mouseSkillActive}
          catMovesLeft={debugState.catMovesLeft}
          mouseMovesLeft={debugState.mouseMovesLeft}
          trapPosition={debugState.trapPosition}
          catTrapsRemaining={debugState.catTrapsRemaining}
          currentPlayer={debugState.currentPlayer}
          phase={debugState.phase}
          message={debugState.message}
          gameMode={debugState.gameMode}
          blockedTunnels={debugState.blockedTunnels}
          tunnelExitChoices={debugState.tunnelExitChoices}
          catActionLog={debugState.catActionLog}
          gameEventLog={debugState.gameEventLog}
          difficulty={debugState.config.difficulty}
        />
      )}
    </div>
  );
}
