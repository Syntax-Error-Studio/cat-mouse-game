import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createInitialState,
  mouseMove,
  mouseSkill,
  catMove,
  catPlaceTrap,
  endTurn,
  getDirectionByKey,
} from '../game/engine';
import { PieceType, GamePhase, CellType } from '../game/types';
import { chooseTunnelExit as chooseTunnelExitRule } from '../game/rules/tunnels';
import {
  PHASE_A_CONFIG,
  PHASE_B_CONFIG,
  TUTORIAL_STEPS,
  REFRESH_BUTTER_POS,
  type TutorialGameData,
} from '../game/tutorial';
import { Board } from '../components/Board';

type GameData = TutorialGameData;

export function TutorialPage() {
  const navigate = useNavigate();
  // 教程全程：欢迎页起就把鼠步数显示为 +∞（输入锁定时不影响，仅保证状态栏一致）
  const [gameState, setGameState] = useState<GameData>(() => ({
    ...createInitialState(PHASE_A_CONFIG),
    mouseMovesLeft: Infinity,
  }));
  const [stepIndex, setStepIndex] = useState(0);
  const animatingRef = useRef(false);
  // 记录每步进入时的棋盘起点，供「重来这一步」无损回退（容错核心）
  const stepEntrySnapshotRef = useRef<GameData | null>(null);

  const step = TUTORIAL_STEPS[stepIndex];

  // ---- 步骤进入时的副作用（切换配置 / 强制黄油点 / 确保鼠回合 / 记录本步起点快照）----
  useEffect(() => {
    const s = TUTORIAL_STEPS[stepIndex];
    if (!s) return;
    let entry: GameData;
    if (s.id === 'phaseB') {
      entry = createInitialState(PHASE_B_CONFIG);
    } else if (s.id === 'eat_again') {
      entry = { ...gameState, butterPositions: [REFRESH_BUTTER_POS] };
    } else if (s.kind === 'action') {
      entry = gameState.currentPlayer === PieceType.Mouse ? gameState : endTurn(gameState);
    } else {
      entry = gameState; // intro / observe：沿用当前棋盘
    }
    // 无限步步骤：鼠步数置为 +∞，玩家可自由探索直到满足条件，不会因步数耗尽误切猫回合。
    // 注意：放到分支外面统一处理，确保 phaseB / eat_again 这类「专属分支」也能正确生效。
    if (s.infiniteMoves) {
      entry = { ...entry, currentPlayer: PieceType.Mouse, mouseMovesLeft: Infinity };
    }
    // 记录本步起点，供「重来这一步」无损回退
    stepEntrySnapshotRef.current = entry;
    setGameState(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // ---- 观察步：按固定脚本自动演示猫的行动 ----
  useEffect(() => {
    const s = TUTORIAL_STEPS[stepIndex];
    if (!s || s.kind !== 'observe') return;
    if (animatingRef.current) return;
    animatingRef.current = true;

    // 确保轮到猫且步数充足
    setGameState((prev) => {
      let st = prev;
      if (st.currentPlayer !== PieceType.Cat) st = endTurn(st);
      if (st.catMovesLeft <= 0) st = { ...st, catMovesLeft: st.config.catBaseMoves };
      return st;
    });

    const ops = s.catScript || [];
    let i = 0;
    const tick = () => {
      if (i >= ops.length) {
        setTimeout(() => {
          animatingRef.current = false;
          setStepIndex((idx) => (idx < TUTORIAL_STEPS.length - 1 ? idx + 1 : idx));
        }, 450);
        return;
      }
      const op = ops[i++];
      setGameState((prev) => {
        if (op.t === 'move' && op.dir) return catMove(prev, op.dir);
        if (op.t === 'trap') return catPlaceTrap(prev);
        if (op.t === 'endTurn') return endTurn(prev);
        return prev;
      });
      setTimeout(tick, 450);
    };
    const t0 = setTimeout(tick, 650);
    return () => clearTimeout(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // ---- 容错①：操作步里若鼠用尽步数却没达成目标，让猫快速「轮空」把回合交还鼠，避免卡死 ----
  // 这正是你提到的情况：鼠没按规定走 → 轮到猫 → 猫只是过一下手就还给你，而不是卡住。
  useEffect(() => {
    const s = TUTORIAL_STEPS[stepIndex];
    if (!s || s.kind !== 'action') return;
    if (gameState.phase !== GamePhase.Playing) return;
    if (gameState.currentPlayer !== PieceType.Cat) return;
    if (s.done && s.done(gameState)) return; // 已满足完成条件，交给推进逻辑，不轮空
    const t = setTimeout(() => {
      setGameState((prev) => {
        if (prev.currentPlayer !== PieceType.Cat || prev.phase !== GamePhase.Playing) return prev;
        const passed = endTurn(prev); // 猫不移动、不抓人，仅把回合交还鼠
        return { ...passed, message: '🐱 猫回合（教学演示：猫只是过一下手）→ 轮到你了' };
      });
    }, 450);
    return () => clearTimeout(t);
  }, [gameState, stepIndex]);

  // ---- 容错②：非胜利步如果误把黄油送进鼠洞（提前赢）或意外被抓（猫胜），回退到本步起点 ----
  // 不让玩家因为乱按而跳过/卡掉教学流程。
  useEffect(() => {
    const s = TUTORIAL_STEPS[stepIndex];
    if (!s || s.kind !== 'action' || s.id === 'win') return;
    if (gameState.phase !== GamePhase.MouseWins && gameState.phase !== GamePhase.CatWins) return;
    const snap = stepEntrySnapshotRef.current;
    if (snap) {
      setGameState({
        ...snap,
        message:
          gameState.phase === GamePhase.MouseWins
            ? '🚫 这一步还不能把黄油送进鼠洞，先按提示操作~ 已回到本步起点'
            : '🚫 别急，这一步猫不会抓你~ 已回到本步起点',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, stepIndex]);

  // ---- 操作步：完成后自动进入下一步 ----
  useEffect(() => {
    const s = TUTORIAL_STEPS[stepIndex];
    if (!s || s.kind !== 'action' || !s.done) return;
    if (gameState.phase === GamePhase.MouseWins) return; // 胜利单独处理
    if (s.done(gameState)) {
      const t = setTimeout(() => {
        setStepIndex((idx) => (idx < TUTORIAL_STEPS.length - 1 ? idx + 1 : idx));
      }, 600);
      return () => clearTimeout(t);
    }
  }, [gameState, stepIndex]);

  // ---- 快速通道：选择出口时自动传送（教程引导，无需手动选）----
  const chooseTunnelExit = useCallback((r: number, c: number) => {
    setGameState((prev) => {
      if (prev.phase !== GamePhase.ChoosingTunnelExit) return prev;
      // Delegate to the shared rule kernel — single source of truth for tunnel
      // exit landing (used by GamePage, TutorialPage and the future Search Simulator).
      const afterExit = chooseTunnelExitRule(prev, r, c);
      if (afterExit === prev) return prev; // invalid choice → no-op
      // 传送完毕后必须正式结束回合，把行动权交给猫，否则会出现“鼠回合 0 步”卡死。
      return endTurn(afterExit);
    });
  }, []);

  useEffect(() => {
    if (gameState.phase !== GamePhase.ChoosingTunnelExit) return;
    const choices = gameState.tunnelExitChoices || [];
    // 教程里永远自动选“真正的另一端出口”，不要“原地停留”那个占位选项。
    // 注意：引擎给四角通道的 label 可能是空字符串，所以不能只判断 c.label。
    const exit = choices.find(
      (c) =>
        (!c.label || !c.label.includes('原地')) &&
        (c.r !== gameState.mousePosition.r || c.c !== gameState.mousePosition.c),
    );
    if (!exit) return;
    // 立刻自动传送，避免玩家停在“选出口”状态不知所措
    const t = setTimeout(() => chooseTunnelExit(exit.r, exit.c), 0);
    return () => clearTimeout(t);
  }, [gameState.phase, gameState.tunnelExitChoices, gameState.mousePosition, chooseTunnelExit]);

  // ---- 玩家输入（仅操作步接收）----
  const onMove = useCallback((key: string) => {
    if (animatingRef.current) return;
    const s = TUTORIAL_STEPS[stepIndex];
    if (!s || s.kind !== 'action') return; // 非操作步：锁定输入
    const dir = getDirectionByKey(key);
    if (!dir) return;
    setGameState((prev) => {
      if (prev.phase !== GamePhase.Playing) return prev;
      // 容错：玩家若“带着黄油就想冲进快速通道”，先自动帮他放技能再走进去，
      // 避免引擎直接阻挡并让玩家误以为卡死。
      const nr = prev.mousePosition.r + dir.dr;
      const nc = prev.mousePosition.c + dir.dc;
      const target = prev.board[nr]?.[nc];
      if (
        target &&
        target.type === CellType.Tunnel &&
        prev.mouseHasButter &&
        !prev.mouseSkillActive
      ) {
        const afterSkill = mouseSkill(prev);
        if (afterSkill !== prev) {
          return mouseMove(afterSkill, dir);
        }
      }
      return mouseMove(prev, dir);
    });
  }, [stepIndex]);

  const onSkill = useCallback(() => {
    if (animatingRef.current) return;
    const s = TUTORIAL_STEPS[stepIndex];
    if (!s || s.kind !== 'action') return;
    setGameState((prev) => {
      if (prev.phase !== GamePhase.Playing) return prev;
      if (prev.currentPlayer !== PieceType.Mouse) return prev;
      return mouseSkill(prev);
    });
  }, [stepIndex]);

  const restartTutorial = useCallback(() => {
    animatingRef.current = false;
    setStepIndex(0);
    setGameState({ ...createInitialState(PHASE_A_CONFIG), mouseMovesLeft: Infinity });
  }, []);

  // 重来当前这一步：回退到本步进入时的棋盘起点（容错逃生口）
  const resetStep = useCallback(() => {
    animatingRef.current = false;
    const snap = stepEntrySnapshotRef.current;
    if (snap) setGameState(snap);
  }, []);

  const isWin = gameState.phase === GamePhase.MouseWins;
  const isLose = gameState.phase === GamePhase.CatWins;
  const showWin = isWin || isLose;

  // ---- 响应式：宽屏左右分栏，窄屏上下叠 ----
  const [isWide, setIsWide] = useState(typeof window !== 'undefined' && window.innerWidth >= 900);
  useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ---- 渲染当前步骤的引导面板 ----
  const renderGuideCard = () => (
    <div style={{
      width: '100%',
      backgroundColor: '#fff',
      borderRadius: '0.9rem',
      padding: '0.9rem 1.1rem',
      boxShadow: '0 6px 20px rgba(0,0,0,0.1)',
      border: `3px solid ${step.kind === 'intro' ? '#60a5fa' : step.kind === 'observe' ? '#f87171' : '#4ade80'}`,
      display: 'flex',
      flexDirection: 'column',
      gap: '0.6rem',
      textAlign: 'center',
      animation: 'tutorialPop 0.3s ease-out',
      boxSizing: 'border-box',
    }}>
      {/* 大标签 + 步骤 */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', flexShrink: 0 }}>
        <span style={{
          fontSize: '0.82rem', fontWeight: 'bold',
          padding: '0.2rem 0.75rem', borderRadius: '999px',
          backgroundColor: step.kind === 'intro' ? '#dbeafe' : step.kind === 'observe' ? '#fee2e2' : '#dcfce7',
          color: step.kind === 'intro' ? '#1d4ed8' : step.kind === 'observe' ? '#b91c1c' : '#15803d',
          boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
        }}>
          {step.kind === 'intro' ? '💡 讲解' : step.kind === 'observe' ? '▶ 演示中' : '👆 请操作'}
        </span>
        <span style={{ fontSize: '0.82rem', color: '#92400e', fontWeight: 600 }}>
          步骤 {stepIndex + 1}/{TUTORIAL_STEPS.length}
        </span>
      </div>

      {/* 正文 */}
      <p style={{
        margin: 0,
        lineHeight: 1.6,
        fontSize: '1rem',
        color: '#1f2937',
        whiteSpace: 'pre-line',
      }}>
        {step.text}
      </p>

      {/* 操作提示 / 按钮 */}
      {step.kind === 'intro' && (
        <button
          onClick={() => setStepIndex((i) => Math.min(i + 1, TUTORIAL_STEPS.length - 1))}
          style={{
            alignSelf: 'center',
            flexShrink: 0,
            padding: '0.5rem 1.8rem',
            borderRadius: '0.7rem',
            border: 'none',
            backgroundColor: '#7c2d12',
            color: '#fff',
            fontWeight: 'bold',
            fontSize: '0.95rem',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(124,45,18,0.3)',
          }}
        >
          知道了，继续 →
        </button>
      )}

      {step.kind === 'action' && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '0.45rem',
          flexShrink: 0,
        }}>
          <div style={{
            fontSize: '0.9rem',
            color: '#92400e',
            backgroundColor: '#fffbeb',
            padding: '0.4rem 1rem',
            borderRadius: '0.6rem',
            border: '1px dashed #f59e0b',
            fontWeight: 'bold',
          }}>
            💡 {step.hint || '按方向键操作'}
          </div>
          <button
            onClick={resetStep}
            style={{
              padding: '0.35rem 1rem',
              borderRadius: '0.6rem',
              border: '2px solid #f59e0b',
              backgroundColor: '#fff',
              color: '#b45309',
              fontWeight: 'bold',
              fontSize: '0.82rem',
              cursor: 'pointer',
            }}
          >
            ↺ 没按对？重来这一步
          </button>
        </div>
      )}

      {step.kind === 'observe' && (
        <div style={{
          alignSelf: 'center',
          flexShrink: 0,
          fontSize: '0.9rem',
          color: '#b91c1c',
          backgroundColor: '#fef2f2',
          padding: '0.4rem 1rem',
          borderRadius: '0.6rem',
          border: '1px dashed #ef4444',
          fontWeight: 'bold',
        }}>
          ⏳ 正在演示，请认真观察…
        </div>
      )}
    </div>
  );

  // ---- 右侧信息面板（宽屏）/ 底部信息区（窄屏）----
  const renderInfoPanel = () => (
    <div style={{
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.55rem',
    }}>
      {/* 状态栏 */}
      <div style={{
        width: '100%',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.4rem 0.9rem',
        padding: '0.45rem 0.75rem',
        borderRadius: '0.6rem',
        backgroundColor: '#fff7ed',
        border: '2px solid #fed7aa',
        fontSize: '0.85rem',
        fontWeight: 600,
        boxSizing: 'border-box',
      }}>
        <span style={{ color: gameState.currentPlayer === PieceType.Mouse ? '#1e40af' : '#991b1b' }}>
          {gameState.currentPlayer === PieceType.Mouse ? '🐭 鼠回合' : '🐱 猫回合'}
        </span>
        <span style={{ color: '#2563eb' }}>🐭 {gameState.mouseMovesLeft === Infinity ? '+∞' : gameState.mouseMovesLeft}步</span>
        <span style={{ color: '#dc2626' }}>🐱 {gameState.catMovesLeft}步</span>
        {gameState.mouseHasButter && !gameState.mouseSkillActive && (
          <span style={{ color: '#d97706', backgroundColor: '#fef3c7', padding: '0.1rem 0.45rem', borderRadius: '0.45rem' }}>
            🧈 携带黄油
          </span>
        )}
        {gameState.mouseSkillActive && (
          <span style={{ color: '#dc2626', backgroundColor: '#fef2f2', padding: '0.1rem 0.45rem', borderRadius: '0.45rem' }}>
            🔥 技能激活
          </span>
        )}
      </div>

      {/* 引导卡片 */}
      {renderGuideCard()}
    </div>
  );

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      padding: isWide ? '1rem' : '0.75rem',
      backgroundColor: '#fef3c7',
      fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
      gap: isWide ? '1rem' : '0.55rem',
      position: 'relative',
      boxSizing: 'border-box',
    }}>
      <style>{`
        @keyframes tutorialPop {
          0% { transform: translateY(8px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes pulseBadge {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }
      `}</style>

      {/* 顶部栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', maxWidth: isWide ? '1000px' : '520px', gap: '0.6rem', flexShrink: 0,
      }}>
        <div style={{ fontWeight: 'bold', fontSize: isWide ? '1.15rem' : '1rem', color: '#7c2d12' }}>
          🐭 新手教程
        </div>
        <div style={{ fontSize: isWide ? '0.95rem' : '0.8rem', color: '#92400e', fontWeight: 600 }}>
          {stepIndex + 1} / {TUTORIAL_STEPS.length}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={restartTutorial}
            style={{
              padding: isWide ? '0.45rem 1rem' : '0.35rem 0.75rem', borderRadius: '0.6rem', border: '2px solid #7c2d12',
              backgroundColor: '#fff7ed', cursor: 'pointer', fontWeight: 'bold', color: '#7c2d12', fontSize: isWide ? '0.9rem' : '0.8rem',
            }}
          >
            🔄 重玩
          </button>
          <button
            onClick={() => navigate('/')}
            style={{
              padding: isWide ? '0.45rem 1rem' : '0.35rem 0.75rem', borderRadius: '0.6rem', border: '2px solid #7c2d12',
              backgroundColor: '#fff7ed', cursor: 'pointer', fontWeight: 'bold', color: '#7c2d12', fontSize: isWide ? '0.9rem' : '0.8rem',
            }}
          >
            退出
          </button>
        </div>
      </div>

      {/* 主内容区：宽屏左右分栏，窄屏上下叠 */}
      <div style={{
        width: '100%',
        maxWidth: isWide ? '1000px' : '520px',
        display: 'flex',
        flexDirection: isWide ? 'row' : 'column',
        alignItems: isWide ? 'center' : 'center',
        justifyContent: 'center',
        gap: isWide ? '1.25rem' : '0.55rem',
        flex: isWide ? 1 : undefined,
        minHeight: 0,
      }}>
        {/* 左侧：棋盘 */}
        <div style={{
          position: 'relative',
          flex: isWide ? '1 1 0' : undefined,
          minWidth: 0,
          width: '100%',
          maxWidth: isWide ? '560px' : '480px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
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
            onMove={onMove}
            onSkill={onSkill}
            onTrap={() => {}}
            onRestart={restartTutorial}
            onChooseExit={chooseTunnelExit}
            tunnelExitChoices={gameState.tunnelExitChoices}
            gameOverDismissed={true}
            config={{ boardSize: 8, difficulty: 'easy', gameMode: 'single', boxCount: 0, butterCount: 1 }}
            showSidePanel={false}
            showRestartButton={false}
            showKeyboardHint={false}
          />

          {/* 讲解/演示：棋盘轻微变暗 + 角落小提示 */}
          {(step.kind === 'intro' || step.kind === 'observe') && !showWin && (
            <div style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(0,0,0,0.25)',
              borderRadius: '0.6rem',
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
              paddingTop: '0.6rem',
              zIndex: 10,
              pointerEvents: 'none',
            }}>
              <span style={{
                fontSize: '0.85rem', fontWeight: 'bold',
                padding: '0.35rem 1rem', borderRadius: '999px',
                backgroundColor: step.kind === 'intro' ? '#1d4ed8' : '#b91c1c',
                color: '#fff',
                boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
              }}>
                {step.kind === 'intro' ? '🔒 请先阅读右方讲解' : '▶ 猫正在演示'}
              </span>
            </div>
          )}

          {/* 操作步：棋盘角落提示 */}
          {step.kind === 'action' && !showWin && (
            <div style={{
              position: 'absolute',
              top: '0.55rem',
              right: '0.55rem',
              zIndex: 10,
              pointerEvents: 'none',
            }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                fontSize: '0.85rem', fontWeight: 'bold',
                padding: '0.35rem 0.8rem', borderRadius: '999px',
                backgroundColor: '#15803d',
                color: '#fff',
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                animation: 'pulseBadge 1.6s ease-in-out infinite',
              }}>
                👆 现在轮到你操作
              </span>
            </div>
          )}
        </div>

        {/* 右侧/下方：信息面板 */}
        {!showWin && (
          <div style={{
            width: isWide ? '340px' : '100%',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: isWide ? 'center' : 'flex-start',
            maxHeight: isWide ? 'calc(100vh - 120px)' : undefined,
            overflowY: isWide ? 'auto' : undefined,
          }}>
            {renderInfoPanel()}
          </div>
        )}
      </div>

      {/* 胜利 / 失败面板 */}
      {showWin && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(2px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        }}>
          <div style={{
            backgroundColor: '#fff', borderRadius: '1rem', padding: '2rem', maxWidth: '420px',
            textAlign: 'center', boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
          }}>
            {isWin ? (
              <>
                <div style={{ fontSize: '3rem' }}>🎉</div>
                <h2 style={{ color: '#15803d', margin: '0.5rem 0' }}>教程完成！</h2>
                <p style={{ color: '#374151', lineHeight: 1.6 }}>
                  你已经掌握了基本玩法：捡黄油、放技能、用快速通道甩开猫、带黄油进洞获胜。
                  现在去主菜单挑战真正的对局吧！
                </p>
              </>
            ) : (
              <>
                <div style={{ fontSize: '3rem' }}>😿</div>
                <h2 style={{ color: '#b91c1c', margin: '0.5rem 0' }}>被猫抓住了</h2>
                <p style={{ color: '#374151', lineHeight: 1.6 }}>
                  没关系，教程猫只是演示。再试一次，熟悉操作就好！
                </p>
              </>
            )}
            <div style={{ display: 'flex', gap: '0.8rem', justifyContent: 'center', marginTop: '1.2rem' }}>
              <button
                onClick={restartTutorial}
                style={{
                  padding: '0.6rem 1.4rem', borderRadius: '0.7rem', border: '2px solid #7c2d12',
                  backgroundColor: '#fff7ed', color: '#7c2d12', fontWeight: 'bold', cursor: 'pointer',
                }}
              >
                重玩教程
              </button>
              <button
                onClick={() => navigate('/')}
                style={{
                  padding: '0.6rem 1.4rem', borderRadius: '0.7rem', border: 'none',
                  backgroundColor: '#7c2d12', color: '#fff', fontWeight: 'bold', cursor: 'pointer',
                }}
              >
                返回主菜单
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
