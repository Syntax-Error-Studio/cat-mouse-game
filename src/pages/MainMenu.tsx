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
      <MenuButton
        src="/ui/新手教程.png"
        alt="新手教程"
        to="/tutorial"
        width="clamp(240px, 32vw, 400px)"
      />

      {/* 玩 · Play */}
      <section style={SECTION_STYLE}>
        <h2 style={SECTION_TITLE_STYLE}>玩</h2>
        <hr style={DIVIDER_STYLE} />
        <MenuButton src="/ui/本地模式.png" alt="本地模式" to="/local" width="clamp(240px, 32vw, 400px)" />
        <MenuButton src="/ui/联机模式.png" alt="联机模式" to="/online" width="clamp(240px, 32vw, 400px)" />

        {/* 挑战关卡 */}
        <MenuButton src="/ui/挑战关卡.png" alt="挑战关卡" to="/challenges" width="clamp(240px, 32vw, 400px)" />
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
