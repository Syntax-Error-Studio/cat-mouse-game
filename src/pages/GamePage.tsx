import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  mouseMove,
  mouseSkill,
  catMove,
  catPlaceTrap,
  endTurn,
  guardStalledTurnBudgets,
  computeCatAiTrajectory,
  getDirectionByKey,
} from '../game/engine';
import type { GameEngineState } from '../game/engine';
import { PieceType, GamePhase, GameMode, Difficulty } from '../game/types';
import type { GameConfig } from '../game/config';
import type { NewGameOpening, OpeningUnverifiedReason } from '../game/newGame';
import { createGameState } from '../game/newGame';
import { chooseTunnelExit } from '../game/rules/tunnels';
import { Board } from '../components/Board';
import { useCatThreatMap } from '../components/dangerAssist';
import { DebugInfo } from '../components/DebugInfo';
import { MenuButton } from '../components/MenuButton';
import { useGame } from '../context/GameContext';

type GameData = GameEngineState;

type OpeningBlock = { reason: OpeningUnverifiedReason; detail?: string };

const CAT_AI_STEP_DELAY = 250;

/**
 * Why an auto opening failed RULE-B certification. Shown on the BLOCKING
 * failure screen — such an opening never reaches the board, so it is never
 * presented as a playable (let alone certified) match.
 */
const OPENING_UNVERIFIED_TEXT: Record<OpeningUnverifiedReason, string> = {
  EXPLICIT_LAYOUT: '显式布局不参与自动认证',
  UNSUPPORTED_CONFIG: '当前配置不在认证支持范围内',
  INVALID_CONFIG: '当前配置不合法，存在越界或冲突的位置',
  NO_CERTIFIED_OPENING: '限定预算内无法证明任何候选开局公平',
  UNDER_GENERATED: '无法放置配置要求的全部黄油',
  NO_LEGAL_OPENING: '生成的初始局面存在无合法行动的一方',
};

/**
 * Blocking screen for an auto opening that failed certification: no Board, no
 * move handlers, only regenerate (a fresh auto draw) and leave.
 */
function OpeningBlockedScreen(props: {
  reason: OpeningUnverifiedReason;
  detail?: string;
  onRegenerate: () => void;
  onBack: () => void;
}) {
  const invalidConfig = props.reason === 'INVALID_CONFIG';
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '1rem',
      padding: '1rem',
      backgroundColor: '#fef3c7',
      fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    }}>
      <div style={{
        padding: '1.5rem 2rem',
        maxWidth: '560px',
        textAlign: 'center',
        backgroundColor: '#FFF3CD',
        borderRadius: '0.75rem',
        border: '2px solid #F0AD4E',
        color: '#8A6D3B',
      }}>
        <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.75rem' }}>
          {invalidConfig ? '当前配置无法开始对局' : '开局未通过公平性认证'}
        </h1>
        <p style={{ margin: '0 0 0.5rem', fontWeight: 'bold' }}>
          {OPENING_UNVERIFIED_TEXT[props.reason]}。
        </p>
        {props.detail && (
          <ul style={{
            margin: '0 0 0.5rem',
            paddingLeft: '1.2rem',
            textAlign: 'left',
            fontSize: '0.9rem',
            lineHeight: 1.5,
            whiteSpace: 'pre-line',
          }}>
            {props.detail.split('\n').map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
        <p style={{ margin: 0 }}>
          {invalidConfig
            ? '本局尚未开始。请返回上一页调整上面的配置后重试。'
            : '本局尚未开始，不会进入正式对局。请重新生成开局，或返回主菜单。'}
        </p>
      </div>
      <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        {!invalidConfig && (
          <button
            onClick={props.onRegenerate}
            style={{
              padding: '0.6rem 1.6rem',
              borderRadius: '0.75rem',
              border: '2px solid #374151',
              backgroundColor: '#fff',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '1rem',
            }}
          >
            重新生成开局
          </button>
        )}
        <button
          onClick={props.onBack}
          style={{
            padding: '0.6rem 1.6rem',
            borderRadius: '0.75rem',
            border: '2px solid #374151',
            backgroundColor: '#fff',
            cursor: 'pointer',
            fontWeight: 'bold',
            fontSize: '1rem',
          }}
        >
          {invalidConfig ? '返回调整配置' : '返回主菜单'}
        </button>
      </div>
    </div>
  );
}

export function GamePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { config, setDifficulty } = useGame();
  // 若本次对局是从「地图编辑器」点试玩进入的，则提供返回编辑器的入口；
  // 试玩地图配置通过路由 state 传入（不再写全局 config，避免污染本地模式开局）。
  const routeState = (location.state as { from?: string; config?: GameConfig } | null) ?? null;
  const fromEditor = routeState?.from === 'editor';
  const editorConfig = routeState?.config;

  // GamePage 是"模式无关"的棋盘壳：对局参数（含 gameMode）来自 context 或编辑器试玩 state。
  const effectiveConfig: GameConfig = editorConfig ?? config;

  // Every new match (mount / restart / difficulty switch) goes through the ONE
  // RULE-B factory; explicit editor/tutorial layouts bypass generation there.
  // A failed auto opening carries no state, so the board cannot be operated.
  const [initialOpening] = useState<NewGameOpening>(() => createGameState(effectiveConfig));
  const [gameState, setGameState] = useState<GameData | null>(
    initialOpening.status.kind === 'unverified' ? null : initialOpening.state,
  );
  const [openingBlocked, setOpeningBlocked] = useState<OpeningBlock | null>(
    initialOpening.status.kind === 'unverified'
      ? { reason: initialOpening.status.reason, detail: initialOpening.status.detail }
      : null,
  );
  // 危险区域辅助：开着才算，算的是这一份真实 gameState（单机/本地双人同一条路径）。
  const threatMap = useCatThreatMap(gameState);
  const [showDebug, setShowDebug] = useState(false);
  const [gameOverDismissed, setGameOverDismissed] = useState(false);
  const [paused, setPaused] = useState(false);

  // G0.3X — Human Hard Validation: 1-based game counter. Increments each time a
  // new game starts (restart), so the debug log can mark GAME 1 … GAME 10.
  const [gameNo, setGameNo] = useState(1);

  const isAnimatingRef = useRef(false);
  const frozenDebugRef = useRef<GameData | null>(null);
  const prevPhaseRef = useRef<GamePhase>(GamePhase.Playing);

  if (gameState && gameState.phase !== prevPhaseRef.current && gameState.phase !== GamePhase.Playing) {
    frozenDebugRef.current = { ...gameState };
  }
  if (gameState) prevPhaseRef.current = gameState.phase;

  useEffect(() => {
    if (gameState?.phase === GamePhase.CatWins || gameState?.phase === GamePhase.MouseWins) {
      setGameOverDismissed(false);
    }
  }, [gameState?.phase]);

  const runCatAi = useCallback((initialState: GameData): GameData => {
    if (isAnimatingRef.current) return initialState;

    let catState = initialState;

    if (catState.currentPlayer === PieceType.Mouse && catState.phase === GamePhase.Playing) {
      catState = endTurn(catState);
    }
    if (catState.currentPlayer !== PieceType.Cat || catState.phase !== GamePhase.Playing) {
      return catState !== initialState ? catState : initialState;
    }

    // The cat's budget comes from the rule kernel (`endTurn` grants
    // config.catBaseMoves when the Mouse→Cat hand-off runs). The UI must NOT
    // top it up here: that masked the trap hand-off bug and could hand the cat
    // a second turn. A cat turn with 0 moves yields no trajectory, and the
    // empty-trajectory branch below performs the kernel's own hand-off.
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
      if (prev === null) return prev;
      if (prev.phase !== GamePhase.Playing) return prev;
      if (isAnimatingRef.current) return prev;

      const dir = getDirectionByKey(key);
      if (!dir) return prev;

      let next: GameData;
      if (prev.currentPlayer === PieceType.Mouse) {
        // The rule kernel owns the Mouse→Cat hand-off — both for "moves
        // exhausted" and for the trap step — so `mouseMove` already returns a
        // cat turn with a fresh budget. The UI only decides who acts next;
        // it must not re-flip the actor or write move budgets of its own.
        const result = mouseMove(prev, dir);
        if (result.phase === GamePhase.Playing && result.currentPlayer === PieceType.Cat) {
          next = prev.gameMode === GameMode.Single ? runCatAi(result) : result;
        } else {
          next = result;
        }
      } else if (prev.currentPlayer === PieceType.Cat && prev.gameMode === GameMode.Dual) {
        const result = catMove(prev, dir);
        next = result.catMovesLeft <= 0 && result.phase === GamePhase.Playing ? endTurn(result) : result;
      } else {
        return prev;
      }

      // Anti-freeze backstop at the commit boundary (repairs only what the
      // kernel's own turn record can attribute; see engine.ts).
      return guardStalledTurnBudgets(next, 'ui:key_move');
    });
  }, [runCatAi, paused]);

  const handleSkill = useCallback(() => {
    if (paused) return;
    setGameState(prev => {
      if (prev === null) return prev;
      if (isAnimatingRef.current) return prev;
      if (prev.phase !== GamePhase.Playing) return prev;
      if (prev.currentPlayer !== PieceType.Mouse) return prev;
      return mouseSkill(prev);
    });
  }, [paused]);

  const handleTrap = useCallback(() => {
    if (paused) return;
    setGameState(prev => {
      if (prev === null) return prev;
      if (isAnimatingRef.current) return prev;
      if (prev.phase !== GamePhase.Playing) return prev;
      if (prev.currentPlayer !== PieceType.Cat || prev.gameMode !== GameMode.Dual) return prev;
      return catPlaceTrap(prev);
    });
  }, [paused]);

  const handleChooseTunnelExit = useCallback((r: number, c: number) => {
    setGameState(prev => {
      if (prev === null) return prev;
      // Delegate to the shared rule kernel — single source of truth for tunnel
      // exit landing (used by GamePage, TutorialPage and the future Search Simulator).
      const afterTeleport = chooseTunnelExit(prev, r, c);
      if (afterTeleport === prev) return prev; // invalid choice / wrong phase → no-op
      if (prev.gameMode === GameMode.Single) {
        return guardStalledTurnBudgets(runCatAi(endTurn(afterTeleport)), 'ui:tunnel_exit');
      }
      return guardStalledTurnBudgets(endTurn(afterTeleport), 'ui:tunnel_exit');
    });
  }, [runCatAi]);

  /** Returns false when certification failed and the match did not start. */
  const startOpening = useCallback((cfg: GameConfig): boolean => {
    const opening = createGameState(cfg);
    if (opening.status.kind === 'unverified') {
      setGameState(null);
      setOpeningBlocked({ reason: opening.status.reason, detail: opening.status.detail });
      return false;
    }
    setGameState(opening.state);
    setOpeningBlocked(null);
    return true;
  }, []);

  const handleRestart = useCallback(() => {
    if (!startOpening(effectiveConfig)) return;
    setGameOverDismissed(false);
    setPaused(false);
    setGameNo(n => n + 1); // G0.3X: next game begins
  }, [effectiveConfig, startOpening]);

  const cycleDifficulty = useCallback(() => {
    const diffs: Difficulty[] = ['easy', 'medium', 'hard'];
    const idx = (diffs.indexOf(config.difficulty) + 1) % diffs.length;
    setDifficulty(diffs[idx]);
    if (startOpening({ ...effectiveConfig, difficulty: diffs[idx] })) {
      setGameNo(n => n + 1); // G0.3X: difficulty change starts a new game
    }
  }, [config.difficulty, effectiveConfig, setDifficulty, startOpening]);

  // Blocked openings stop here, after every hook: the board below is the only
  // operable surface, so an unverified auto layout can never start a match.
  if (openingBlocked !== null || gameState === null) {
    return (
      <OpeningBlockedScreen
        reason={openingBlocked?.reason ?? 'NO_CERTIFIED_OPENING'}
        detail={openingBlocked?.detail}
        onRegenerate={handleRestart}
        onBack={() => {
          if (openingBlocked?.reason === 'INVALID_CONFIG') navigate(-1);
          else navigate('/');
        }}
      />
    );
  }

  const debugState = (gameState.phase !== GamePhase.Playing && frozenDebugRef.current) || gameState;

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
          <MenuButton
            src="/ui/返回编辑器.png"
            alt="返回编辑器"
            onClick={() => navigate('/editor')}
            width="clamp(120px, 16vw, 200px)"
          />
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
          {config.difficulty === 'easy' ? '🟢 简单' : config.difficulty === 'medium' ? '🟠 困难' : '🔴 恐怖'}
        </button>

        <MenuButton
          src="/ui/调试.png"
          alt="调试"
          onClick={() => setShowDebug(!showDebug)}
          width="clamp(120px, 16vw, 200px)"
        />
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
        pendingButterSpawns={gameState.pendingButterSpawns}
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
        threatMap={threatMap}
      />

      {showDebug && (
        <DebugInfo
          board={debugState.board}
          catPosition={debugState.catPosition}
          mousePosition={debugState.mousePosition}
          butterPositions={debugState.butterPositions}
          pendingButterSpawns={debugState.pendingButterSpawns}
          pendingButterPlacementDebt={debugState.pendingButterPlacementDebt ?? 0}
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
          hardSearch={debugState.lastHardSearch}
          hardSearchHistory={debugState.hardSearchHistory}
          gameNo={gameNo}
          hardProgressGuardMemory={debugState.hardProgressGuardMemory}
        />
      )}
    </div>
  );
}
