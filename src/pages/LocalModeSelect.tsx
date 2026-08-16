import { useNavigate } from 'react-router-dom';
import { MenuButton } from '../components/MenuButton';

export function LocalModeSelect() {
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
      gap: '2rem',
    }}>
      {/* 返回按钮 */}
      <div style={{ position: 'absolute', top: '1.5rem', left: '1.5rem' }}>
        <MenuButton
          src="/ui/关闭.png"
          alt="返回"
          onClick={() => navigate('/')}
          width="clamp(48px, 6vw, 72px)"
        />
      </div>

      <div style={{
        display: 'flex',
        gap: '1.5rem',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'stretch',
      }}>
        <MenuButton
          src="/ui/单人模式竖.png"
          alt="单人模式"
          to="/setup/single"
          width="clamp(220px, 26vw, 340px)"
        />
        <MenuButton
          src="/ui/双人模式竖.png"
          alt="双人模式"
          to="/setup/dual"
          width="clamp(220px, 26vw, 340px)"
        />
        <MenuButton
          src="/ui/多人模式竖.png"
          alt="多人模式"
          onClick={() => {
            // 多人模式尚未实现，暂时提示
            alert('多人模式开发中，敬请期待！');
          }}
          width="clamp(220px, 26vw, 340px)"
        />
      </div>
    </div>
  );
}
