import { useNavigate } from 'react-router-dom';

interface MenuButtonProps {
  src: string;
  alt: string;
  to?: string;
  onClick?: () => void;
  width?: string;
}

export function MenuButton({ src, alt, to, onClick, width }: MenuButtonProps) {
  const navigate = useNavigate();

  return (
    <img
      src={src}
      alt={alt}
      onClick={() => {
        if (to) navigate(to);
        onClick?.();
      }}
      style={{
        width: width ?? 'clamp(180px, 22vw, 300px)',
        height: 'auto',
        cursor: 'pointer',
        transition: 'transform 0.15s ease, filter 0.15s ease',
        userSelect: 'none',
        borderRadius: '1rem',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'scale(1.05)';
        e.currentTarget.style.filter = 'brightness(1.08)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'scale(1)';
        e.currentTarget.style.filter = 'brightness(1)';
      }}
      onMouseDown={e => {
        e.currentTarget.style.transform = 'scale(0.97)';
      }}
      onMouseUp={e => {
        e.currentTarget.style.transform = 'scale(1.05)';
      }}
    />
  );
}
