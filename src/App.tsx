import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  createInitialState,
  mouseMove,
  mouseSkill,
  catMove,
  catPlaceTrap,
  endTurn,
  computeCatAiTrajectory,
  getDirectionByKey,
} from './game/engine';
import { PieceType, GamePhase, GameMode, Difficulty } from './game/types';
import type { GameConfig } from './game/config';
import { DEFAULT_CONFIG } from './game/config';
import { Board } from './components/Board';
import { DebugInfo } from './components/DebugInfo';

type GameData = ReturnType<typeof createInitialState>;

// Smooth transition duration for cat AI animation (ms per step)
const CAT_AI_STEP_DELAY = 250;

function App() {
  const [config, setConfig] = useState<GameConfig>({ ...DEFAULT_CONFIG });
  const [showConfig, setShowConfig] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [gameOverDismissed, setGameOverDismissed] = useState(false);

  const state = useMemo(() => createInitialState(config), [config]);
  const [gameState, setGameState] = useState<GameData>(state);

  // Ref to prevent re-entrant animations (clicking while AI is animating)
  const isAnimatingRef = useRef(false);

  // Freeze debug info when game ends so it doesn't refresh after game over
  const frozenDebugRef = useRef<GameData | null>(null);
  const prevPhaseRef = useRef<GamePhase>(GamePhase.Playing);
  if (gameState.phase !== prevPhaseRef.current && gameState.phase !== GamePhase.Playing) {
    frozenDebugRef.current = { ...gameState };
  }
  prevPhaseRef.current = gameState.phase;
  const debugState = (gameState.phase !== GamePhase.Playing && frozenDebugRef.current) || gameState;

  // Global: ensure game-over overlay is visible regardless of how the game ended
  // (runCatAi sets it for cat-wins, but mouseMove triggers mouse-wins directly)
  useEffect(() => {
    if (
      gameState.phase === GamePhase.CatWins ||
      gameState.phase === GamePhase.MouseWins
    ) {
      setGameOverDismissed(false);
    }
  }, [gameState.phase]);

  /**
   * Run cat AI step-by-step with animation.
   * Computes the full trajectory, then plays each step with a delay.
   * This allows CSS transitions to animate each individual move.
   */
  const runCatAi = useCallback((initialState: GameData): GameData => {
    // Ignore if already animating
    if (isAnimatingRef.current) return initialState;

    let catState = initialState;

    // If still mouse turn, end mouse turn first to switch to cat
    if (catState.currentPlayer === PieceType.Mouse && catState.phase === GamePhase.Playing) {
      catState = endTurn(catState);
    }
    if (catState.currentPlayer !== PieceType.Cat || catState.phase !== GamePhase.Playing) {
      // Can't switch to cat — return the state after endTurn so the turn actually changes
      return catState !== initialState ? catState : initialState;
    }

    // Ensure cat has full moves
    if (catState.catMovesLeft <= 0) {
      catState = { ...catState, catMovesLeft: catState.config.catBaseMoves };
    }

    // Compute the full trajectory
    const trajectory = computeCatAiTrajectory(catState);

    if (!trajectory || trajectory.length === 0) {
      // No moves available — cat is stuck, end turn anyway
      const ended = endTurn(catState);
      setGameState(ended);
      return ended;
    }

    const steps = trajectory;

    // Play steps one by one with animation delay
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

        // If AI already ended the turn (e.g. HARD_EMERGENCY_HOLD_ENTRY or
        // HARD_EMERGENCY_TRAP_ENTRY), currentPlayer is Mouse — don't call
        // endTurn again, that would switch back to Cat.
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
      // Always apply state first, even for no-op steps
      setGameState(step.state);
      // If this step ended the game, stop animating immediately
      if (step.state.phase === GamePhase.CatWins || step.state.phase === GamePhase.MouseWins) {
        setGameOverDismissed(false);
        isAnimatingRef.current = false;
        return;
      }
      // No-op step (cat didn't move, e.g. placed trap or held entry) —
      // state already applied above, skip animation delay
      if (step.from.r === step.to.r && step.from.c === step.to.c) {
        playNext();
        return;
      }
      setTimeout(playNext, CAT_AI_STEP_DELAY);
    }

    playNext();
    // Return the cat-state so React shows cat's turn during animation
    return catState;
  }, []);

  const handleMove = useCallback((key: string) => {
    setGameState(prev => {
      if (prev.phase !== GamePhase.Playing) return prev;
      // Ignore ALL input while AI is animating
      if (isAnimatingRef.current) return prev;

      const dir = getDirectionByKey(key);
      if (!dir) return prev;

      if (prev.currentPlayer === PieceType.Mouse) {
        const result = mouseMove(prev, dir);

        if (result.mouseMovesLeft <= 0 && result.phase === GamePhase.Playing) {
          // Single mode: AI takes over. Dual mode: switch to cat directly.
          if (prev.gameMode === GameMode.Single) {
            return runCatAi(result);
          }
          // Dual mode: switch to cat, keep result's message (already set by endTurn)
          return {
            ...result,
            phase: GamePhase.Playing,
            currentPlayer: PieceType.Cat,
            catMovesLeft: prev.config.catBaseMoves,
          };
        }
        return result;
      }

      // Cat movement only allowed in Dual mode (human cat player)
      if (prev.currentPlayer === PieceType.Cat && prev.gameMode === GameMode.Dual) {
        const result = catMove(prev, dir);

        if (result.catMovesLeft <= 0 && result.phase === GamePhase.Playing) {
          return endTurn(result);
        }
        return result;
      }

      return prev;
    });
  }, [runCatAi]);

  const handleSkill = useCallback(() => {
    setGameState(prev => {
      if (isAnimatingRef.current) return prev;
      if (prev.phase !== GamePhase.Playing) return prev;
      if (prev.currentPlayer !== PieceType.Mouse) return prev;
      return mouseSkill(prev);
    });
  }, []);

  const handleTrap = useCallback(() => {
    setGameState(prev => {
      if (isAnimatingRef.current) return prev;
      if (prev.phase !== GamePhase.Playing) return prev;
      // Only allow trap in Dual mode with human cat player
      if (prev.currentPlayer !== PieceType.Cat || prev.gameMode !== GameMode.Dual) return prev;
      return catPlaceTrap(prev);
    });
  }, []);

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

      // Single mode: end mouse turn then AI cat takes over. Dual mode: end turn to switch to cat.
      if (prev.gameMode === GameMode.Single) {
        return runCatAi(endTurn(afterTeleport));
      }
      return endTurn(afterTeleport);
    });
  }, [runCatAi]);

  const handleRestart = useCallback(() => {
    setGameState(createInitialState(config));
    setGameOverDismissed(false);
  }, [config]);

  const updateConfigField = useCallback(<K extends keyof GameConfig>(key: K, value: GameConfig[K]) => {
    setConfig(prev => {
      const next = { ...prev, [key]: value };
      setGameState(createInitialState(next));
      return next;
    });
  }, []);

  const toggleMode = useCallback(() => {
    setConfig(prev => {
      const newMode = prev.gameMode === GameMode.Single ? GameMode.Dual : GameMode.Single;
      setGameState({ ...createInitialState({ ...prev, gameMode: newMode }) });
      return { ...prev, gameMode: newMode };
    });
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem',
      backgroundColor: '#fef3c7',
      fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
      gap: '1rem',
    }}>
      {/* Logo */}
      <img src="/logo.png" alt="小猫小鼠" style={{ width: 'clamp(220px, 30vw, 420px)', height: 'auto', objectFit: 'contain', marginBottom: '0.5rem' }} />

      {/* Mode toggle button */}
      <button
        onClick={toggleMode}
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
        {config.gameMode === GameMode.Single ? '🤖 单人模式' : '👥 双人模式'}
      </button>

      {/* Difficulty toggle button */}
      <button
        onClick={() => {
          setConfig(prev => {
            const diffs: Difficulty[] = ['easy', 'medium', 'hard'];
            const idx = (diffs.indexOf(prev.difficulty) + 1) % diffs.length;
            setGameState(createInitialState({ ...prev, difficulty: diffs[idx] }));
            return { ...prev, difficulty: diffs[idx] };
          });
        }}
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

      {/* Config toggle button */}
      <button
        onClick={() => setShowConfig(!showConfig)}
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
        ⚙️ {showConfig ? '隐藏设置' : '游戏设置'}
      </button>

      {/* Debug toggle button */}
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
        🔧 {showDebug ? '隐藏调试' : '调试信息'}
      </button>

      {/* Config panel */}
      {showConfig && (
        <div style={{
          backgroundColor: '#fff',
          borderRadius: '1rem',
          padding: '1.5rem',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '1rem 2rem',
          maxWidth: '520px',
          width: '100%',
          fontSize: '0.9rem',
        }}>
          <label>
            棋盘大小
            <input type="number" min={5} max={20} value={config.boardSize}
              onChange={e => updateConfigField('boardSize', Number(e.target.value))}
              style={{ display: 'block', width: '100%', marginTop: '0.3rem', padding: '0.4rem', borderRadius: '0.5rem', border: '1px solid #d1d5db' }} />
          </label>
          <label>
            箱子数量
            <input type="number" min={0} max={50} value={config.boxCount}
              onChange={e => updateConfigField('boxCount', Number(e.target.value))}
              style={{ display: 'block', width: '100%', marginTop: '0.3rem', padding: '0.4rem', borderRadius: '0.5rem', border: '1px solid #d1d5db' }} />
          </label>
          <label>
            黄油数量
            <input type="number" min={1} max={10} value={config.butterCount}
              onChange={e => updateConfigField('butterCount', Number(e.target.value))}
              style={{ display: 'block', width: '100%', marginTop: '0.3rem', padding: '0.4rem', borderRadius: '0.5rem', border: '1px solid #d1d5db' }} />
          </label>
          <label>
            鼠基础步数
            <input type="number" min={1} max={10} value={config.mouseBaseMoves}
              onChange={e => updateConfigField('mouseBaseMoves', Number(e.target.value))}
              style={{ display: 'block', width: '100%', marginTop: '0.3rem', padding: '0.4rem', borderRadius: '0.5rem', border: '1px solid #d1d5db' }} />
          </label>
          <label>
            鼠洞行
            <input type="number" min={0} max={19} value={config.mouseHole.r}
              onChange={e => updateConfigField('mouseHole', { ...config.mouseHole, r: Number(e.target.value) })}
              style={{ display: 'block', width: '100%', marginTop: '0.3rem', padding: '0.4rem', borderRadius: '0.5rem', border: '1px solid #d1d5db' }} />
          </label>
          <label>
            鼠洞列
            <input type="number" min={0} max={19} value={config.mouseHole.c}
              onChange={e => updateConfigField('mouseHole', { ...config.mouseHole, c: Number(e.target.value) })}
              style={{ display: 'block', width: '100%', marginTop: '0.3rem', padding: '0.4rem', borderRadius: '0.5rem', border: '1px solid #d1d5db' }} />
          </label>
          <div style={{ gridColumn: '1 / -1', textAlign: 'center' }}>
            <button
              onClick={() => {
                setConfig(DEFAULT_CONFIG);
                setGameState(createInitialState(DEFAULT_CONFIG));
              }}
              style={{
                padding: '0.5rem 1.5rem',
                borderRadius: '0.75rem',
                border: 'none',
                backgroundColor: '#6b7280',
                color: '#fff',
                cursor: 'pointer',
                fontWeight: 'bold',
                fontSize: '0.9rem',
              }}
            >
              🔄 恢复默认
            </button>
          </div>
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
          boardSize: config.boardSize,
          difficulty: config.difficulty,
          gameMode: config.gameMode,
          boxCount: config.boxCount,
          butterCount: config.butterCount,
        }}
        catActionLog={gameState.catActionLog}
        gameEventLog={gameState.gameEventLog}
      />

      {/* Debug info panel */}
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

export default App;
