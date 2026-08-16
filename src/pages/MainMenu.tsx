import { useNavigate } from 'react-router-dom';
import { MenuButton } from '../components/MenuButton';

// 按"玩家意图"分类的主菜单：玩 / 造 / 系统
// 后续新增模式（联机多人、每日挑战、地图分享…）只往对应分组里加按钮，
// 主菜单永远只有 3 个大分区，不会随功能增多而无序膨胀。
const SECTION_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1rem',
  width: '100%',
};

const SECTION_TITLE_STYLE: React.CSSProperties = {
  fontSize: '1.15rem',
  fontWeight: 'bold',
  color: '#8D6E63',
  letterSpacing: '0.3em',
  marginTop: '0.5rem',
  marginBottom: '0.2rem',
};

const DIVIDER_STYLE: React.CSSProperties = {
  width: 'clamp(200px, 30vw, 360px)',
  height: '2px',
  backgroundColor: '#E0C9A6',
  border: 'none',
  margin: '0.2rem 0',
};

export function MainMenu() {
  const navigate = useNavigate();

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
      gap: '0.4rem',
    }}>
      <img
        src="/logo.png"
        alt="小猫小鼠"
        style={{
          width: 'clamp(220px, 30vw, 420px)',
          height: 'auto',
          objectFit: 'contain',
          marginBottom: '0.5rem',
        }}
      />

      {/* 新手教程 — 醒目入口 */}
      <button
        onClick={() => navigate('/tutorial')}
        style={{
          width: 'clamp(240px, 32vw, 400px)',
          padding: '0.75rem 2rem',
          borderRadius: '3rem',
          border: '4px solid #2E7D32',
          backgroundColor: '#66BB6A',
          color: '#FFFFFF',
          fontSize: '1.6rem',
          fontWeight: 'bold',
          cursor: 'pointer',
          fontFamily: 'inherit',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          transition: 'transform 0.15s ease, filter 0.15s ease',
          marginBottom: '0.4rem',
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.05)'; e.currentTarget.style.filter = 'brightness(1.08)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.filter = 'brightness(1)'; }}
      >
        🎓 新手教程
      </button>

      {/* 玩 · Play */}
      <section style={SECTION_STYLE}>
        <h2 style={SECTION_TITLE_STYLE}>玩</h2>
        <hr style={DIVIDER_STYLE} />
        <MenuButton src="/ui/本地模式.png" alt="本地模式" to="/local" width="clamp(240px, 32vw, 400px)" />
        <MenuButton src="/ui/联机模式.png" alt="联机模式" to="/online" width="clamp(240px, 32vw, 400px)" />

        {/* 挑战关卡 — 暂用文字按钮，后续替换为图片素材 */}
        <button
          onClick={() => navigate('/challenges')}
          style={{
            width: 'clamp(240px, 32vw, 400px)',
            padding: '0.75rem 2rem',
            borderRadius: '3rem',
            border: '4px solid #3E2723',
            backgroundColor: '#FFD54F',
            color: '#FFF8E1',
            fontSize: '1.6rem',
            fontWeight: 'bold',
            cursor: 'pointer',
            fontFamily: 'inherit',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            transition: 'transform 0.15s ease, filter 0.15s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.05)'; e.currentTarget.style.filter = 'brightness(1.08)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.filter = 'brightness(1)'; }}
        >
          🏆 挑战关卡
        </button>
      </section>

      {/* 造 · Workshop */}
      <section style={SECTION_STYLE}>
        <h2 style={SECTION_TITLE_STYLE}>造</h2>
        <hr style={DIVIDER_STYLE} />
        <MenuButton src="/ui/地图编辑.png" alt="地图编辑" to="/editor" width="clamp(240px, 32vw, 400px)" />
      </section>

      {/* 系统 · System */}
      <section style={SECTION_STYLE}>
        <h2 style={SECTION_TITLE_STYLE}>系统</h2>
        <hr style={DIVIDER_STYLE} />
        <MenuButton src="/ui/设置.png" alt="设置" to="/settings" width="clamp(240px, 32vw, 400px)" />
      </section>
    </div>
  );
}
