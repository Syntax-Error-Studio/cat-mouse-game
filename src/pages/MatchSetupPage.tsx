import { useNavigate, useParams } from 'react-router-dom';
import { MenuButton } from '../components/MenuButton';
import { useGame } from '../context/GameContext';
import { DEFAULT_CONFIG } from '../game/config';
import { GameMode } from '../game/types';

// 模式标识：后续扩展只需在这里加一项 + 实现对应控制器，
// 对局配置页与棋盘 GamePage 都不用改。
type ModeId = 'single' | 'dual' | 'online' | 'challenge' | 'custom';

interface ModeMeta {
  title: string;
  subtitle: string;
  gameMode?: GameMode; // 已实现的对局模式
  implemented: boolean;
}

const MODE_META: Record<ModeId, ModeMeta> = {
  single: { title: '单人模式', subtitle: '你操控鼠 · AI 操控猫', gameMode: GameMode.Single, implemented: true },
  dual: { title: '双人同屏', subtitle: '一人鼠 · 一人猫', gameMode: GameMode.Dual, implemented: true },
  online: { title: '联机双人', subtitle: '与好友远程对战', implemented: false },
  challenge: { title: '挑战关卡', subtitle: '预设谜题闯关', implemented: false },
  custom: { title: '自定义地图', subtitle: '使用你编辑的地图', implemented: false },
};

const COMING_SOON: Record<Exclude<ModeId, 'single' | 'dual'>, string> = {
  online: '联机功能开发中，敬请期待！',
  challenge: '挑战关卡开发中，敬请期待！',
  custom: '自定义地图对局开发中，敬请期待！',
};

const PAGE_BG: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-start',
  padding: '2rem 1rem',
  backgroundColor: '#fef3c7',
  fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  gap: '1.2rem',
};

const CARD_STYLE: React.CSSProperties = {
  width: 'min(440px, 92vw)',
  backgroundColor: '#FFF8E1',
  border: '3px solid #3E2723',
  borderRadius: '1.2rem',
  padding: '1.2rem 1.4rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
};

const PILL_STYLE: React.CSSProperties = {
  padding: '0.55rem 1.1rem',
  borderRadius: '2rem',
  border: '2px solid #3E2723',
  backgroundColor: '#FFD54F',
  color: '#3E2723',
  fontSize: '1rem',
  fontWeight: 'bold',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
      <span style={{ fontSize: '1.05rem', color: '#5D4037', fontWeight: 'bold' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <button onClick={() => onChange(clamp(value - 1))} style={{ ...PILL_STYLE, width: '2.4rem', padding: '0.4rem 0' }}>−</button>
        <span style={{ minWidth: '2.5rem', textAlign: 'center', fontSize: '1.2rem', fontWeight: 'bold', color: '#3E2723' }}>{value}</span>
        <button onClick={() => onChange(clamp(value + 1))} style={{ ...PILL_STYLE, width: '2.4rem', padding: '0.4rem 0' }}>+</button>
      </div>
    </div>
  );
}

export function MatchSetupPage() {
  const { mode } = useParams<{ mode: string }>();
  const navigate = useNavigate();
  const { config, updateConfigField, setFullConfig } = useGame();

  const modeId = (mode as ModeId) ?? 'single';
  const meta = MODE_META[modeId] ?? MODE_META.single;

  const startMatch = () => {
    if (!meta.gameMode) return;
    // 旧版本编辑器“试玩”曾把自定义地图配置（butterCount=0 / customTerrain 等）写入全局 config，
    // 若检测到此类残留则整体重置为默认对局参数（保留本页难度），
    // 保证本地模式开局有正常的随机地图，而不是空棋盘或编辑器地图。
    const hasEditorResidue = config.butterCount === 0 || Boolean(config.customTerrain);
    if (hasEditorResidue) {
      setFullConfig({ ...DEFAULT_CONFIG, gameMode: meta.gameMode, difficulty: config.difficulty });
    } else {
      setFullConfig({ ...config, gameMode: meta.gameMode });
    }
    navigate('/game');
  };

  return (
    <div style={PAGE_BG}>
      {/* 返回 */}
      <div style={{ position: 'absolute', top: '1.5rem', left: '1.5rem' }}>
        <MenuButton src="/ui/关闭.png" alt="返回" onClick={() => navigate(-1)} width="clamp(48px, 6vw, 72px)" />
      </div>

      <div style={{ textAlign: 'center', marginTop: '1rem' }}>
        <h1 style={{ fontSize: '1.8rem', color: '#3E2723', margin: 0 }}>{meta.title}</h1>
        <p style={{ fontSize: '1rem', color: '#8D6E63', margin: '0.3rem 0 0' }}>{meta.subtitle}</p>
      </div>

      {!meta.implemented ? (
        <div style={{ ...CARD_STYLE, alignItems: 'center', textAlign: 'center' }}>
          <p style={{ fontSize: '1.2rem', color: '#8D6E63' }}>
            {COMING_SOON[modeId as Exclude<ModeId, 'single' | 'dual'>] ?? '该功能开发中，敬请期待！'}
          </p>
        </div>
      ) : (
        <div style={CARD_STYLE}>
          {/* 难度（仅单人模式需要 AI）
              显示层难度命名：简单 → easy，困难 → medium，恐怖 → hard */}
          {modeId === 'single' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span style={{ fontSize: '1.05rem', color: '#5D4037', fontWeight: 'bold' }}>难度</span>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                {([
                  { id: 'easy', src: '/ui/简单.png' },
                  { id: 'medium', src: '/ui/困难.png' },
                  { id: 'hard', src: '/ui/恐怖.png' },
                ] as const).map(({ id, src }) => {
                  const active = config.difficulty === id;
                  return (
                    <div
                      key={id}
                      style={{
                        borderRadius: '1rem',
                        padding: '4px',
                        outline: active ? '3px solid #FF8F00' : '3px solid transparent',
                        boxShadow: active ? '0 4px 12px rgba(255,143,0,0.35)' : 'none',
                      }}
                    >
                      <MenuButton
                        src={src}
                        alt={id}
                        onClick={() => updateConfigField('difficulty', id)}
                        width="clamp(150px, 22vw, 260px)"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <hr style={{ border: 'none', borderTop: '2px dashed #E0C9A6', width: '100%' }} />

          <Stepper label="棋盘大小" value={config.boardSize} min={5} max={20} onChange={v => updateConfigField('boardSize', v)} />
          <Stepper label="箱子数量" value={config.boxCount} min={0} max={50} onChange={v => updateConfigField('boxCount', v)} />
          <Stepper label="黄油数量" value={config.butterCount} min={1} max={10} onChange={v => updateConfigField('butterCount', v)} />

          <button
            onClick={startMatch}
            style={{
              marginTop: '0.4rem',
              padding: '0.8rem 2rem',
              borderRadius: '2rem',
              border: '3px solid #3E2723',
              backgroundColor: '#66BB6A',
              color: '#FFF8E1',
              fontSize: '1.3rem',
              fontWeight: 'bold',
              cursor: 'pointer',
              fontFamily: 'inherit',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            }}
          >
            ▶ 开始对局
          </button>
        </div>
      )}
    </div>
  );
}
