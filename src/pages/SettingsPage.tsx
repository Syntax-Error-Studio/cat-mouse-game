import { useNavigate } from 'react-router-dom';
import { MenuButton } from '../components/MenuButton';
import { useGame } from '../context/GameContext';

export function SettingsPage() {
  const navigate = useNavigate();
  const { config, updateConfigField, resetConfig } = useGame();

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem 1rem',
      backgroundColor: '#fef3c7',
      fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
      gap: '1.5rem',
    }}>
      <div style={{ position: 'absolute', top: '1.5rem', left: '1.5rem' }}>
        <MenuButton
          src="/ui/关闭.png"
          alt="返回"
          onClick={() => navigate('/')}
          width="clamp(48px, 6vw, 72px)"
        />
      </div>

      <img
        src="/ui/设置.png"
        alt="设置"
        style={{ width: 'clamp(240px, 30vw, 400px)', height: 'auto' }}
      />

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
            onClick={() => resetConfig()}
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
    </div>
  );
}
