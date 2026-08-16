import { useNavigate } from 'react-router-dom';
import { MenuButton } from '../components/MenuButton';

export function ChallengesPage() {
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
      <div style={{ position: 'absolute', top: '1.5rem', left: '1.5rem' }}>
        <MenuButton
          src="/ui/关闭.png"
          alt="返回"
          onClick={() => navigate('/')}
          width="clamp(48px, 6vw, 72px)"
        />
      </div>

      <p style={{
        fontSize: '2rem',
        fontWeight: 'bold',
        color: '#FFD54F',
        WebkitTextStroke: '2px #3E2723',
      }}>
        🏆 挑战关卡
      </p>

      <p style={{
        fontSize: '1.3rem',
        color: '#8D6E63',
        textAlign: 'center',
      }}>
        挑战关卡开发中，敬请期待！
      </p>
    </div>
  );
}
