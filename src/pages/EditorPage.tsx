import { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MenuButton } from '../components/MenuButton';
import { CellType, GameMode } from '../game/types';
import {
  createEmptyMap,
  validateMap,
  mapDefinitionToGameConfig,
  type MapDefinition,
  type MapPoint,
} from '../game/mapDefinition';
import {
  listMaps,
  saveMap,
  deleteMap,
  exportMapToString,
  importMapFromString,
  saveDraft,
  loadDraft,
  clearDraft,
} from '../game/mapStorage';
import { useGame } from '../context/GameContext';

const MIN = 4;
const MAX = 24;

type Tool = CellType | 'cat' | 'mouse';

interface ToolDef {
  id: Tool;
  label: string;
  emoji: string;
  color: string;
  textColor?: string;
}

const TOOLS: ToolDef[] = [
  { id: CellType.Empty, label: '地板', emoji: '⬜', color: '#fde9c8' },
  { id: CellType.Wall, label: '墙', emoji: '🧱', color: '#5b4636', textColor: '#fff' },
  { id: CellType.Void, label: '虚空', emoji: '🌫️', color: 'repeating-linear-gradient(45deg,#eee,#eee 6px,#e0e0e0 6px,#e0e0e0 12px)' },
  { id: CellType.Box, label: '箱子', emoji: '📦', color: '#c08552' },
  { id: CellType.Pile, label: '杂物堆', emoji: '🪨', color: '#9e9e9e' },
  { id: CellType.ButterSpot, label: '黄油', emoji: '🧈', color: '#ffe082' },
  { id: CellType.Tunnel, label: '快速通道', emoji: '🌀', color: '#b39ddb' },
  { id: CellType.MouseHole, label: '鼠洞', emoji: '🕳️', color: '#37474f', textColor: '#fff' },
  { id: 'cat', label: '猫起点', emoji: '🐱', color: '#ffd1dc' },
  { id: 'mouse', label: '鼠起点', emoji: '🐭', color: '#d1f0ff' },
];

const PANEL_BG = 'rgba(255,255,255,0.85)';
const CARD_STYLE: React.CSSProperties = {
  backgroundColor: PANEL_BG,
  borderRadius: 14,
  padding: '0.75rem',
  boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
};

export function EditorPage() {
  const navigate = useNavigate();
  const { setFullConfig } = useGame();

  const [mapId, setMapId] = useState<string>(() => crypto.randomUUID());
  const [name, setName] = useState('未命名地图');
  const [rows, setRows] = useState(10);
  const [cols, setCols] = useState(10);
  const [grid, setGrid] = useState<CellType[][]>(() =>
    Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => CellType.Empty)),
  );
  const [catStart, setCatStart] = useState<MapPoint>({ r: 5, c: 1 });
  const [mouseStart, setMouseStart] = useState<MapPoint>({ r: 5, c: 8 });

  const [tool, setTool] = useState<Tool>(CellType.Wall);
  const [playMode, setPlayMode] = useState<GameMode>(GameMode.Single);
  const [randomBox, setRandomBox] = useState(8);
  const [randomButter, setRandomButter] = useState(3);

  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [showLoad, setShowLoad] = useState(false);
  const [savedList, setSavedList] = useState<MapDefinition[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function flash(kind: 'ok' | 'err' | 'warn', text: string) {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 4000);
  }

  function buildMap(): MapDefinition {
    return {
      id: mapId,
      version: 1,
      name: name.trim() || '未命名地图',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rows,
      cols,
      grid: grid.map(row => row.slice()),
      catStart,
      mouseStart,
    };
  }

  /** 把一份地图（草稿/已保存/导入）应用到当前编辑状态。 */
  function applyMap(m: MapDefinition) {
    setMapId(m.id);
    setName(m.name);
    setRows(m.rows);
    setCols(m.cols);
    setGrid(m.grid.map(row => row.slice()));
    setCatStart(m.catStart ?? { r: Math.floor(m.rows / 2), c: 1 });
    setMouseStart(m.mouseStart ?? { r: Math.floor(m.rows / 2), c: m.cols - 2 });
  }

  function setCell(r: number, c: number, t: CellType) {
    setGrid(prev => {
      const next = prev.map(row => row.slice());
      next[r][c] = t;
      return next;
    });
  }

  function paint(r: number, c: number) {
    if (tool === 'cat') {
      setCatStart({ r, c });
      setCell(r, c, CellType.Empty);
      return;
    }
    if (tool === 'mouse') {
      setMouseStart({ r, c });
      setCell(r, c, CellType.Empty);
      return;
    }
    setCell(r, c, tool);
  }

  // ---------- 缩放：四边界 +/- ----------
  function addRowTop() {
    if (rows >= MAX) return;
    setGrid(prev => [Array.from({ length: cols }, () => CellType.Empty), ...prev]);
    setRows(rows + 1);
    setCatStart(s => ({ r: s.r + 1, c: s.c }));
    setMouseStart(s => ({ r: s.r + 1, c: s.c }));
  }
  function addRowBottom() {
    if (rows >= MAX) return;
    setGrid(prev => [...prev, Array.from({ length: cols }, () => CellType.Empty)]);
    setRows(rows + 1);
  }
  function removeRowTop() {
    if (rows <= MIN) return;
    setGrid(prev => prev.slice(1));
    setRows(rows - 1);
    setCatStart(s => ({ r: Math.max(0, s.r - 1), c: s.c }));
    setMouseStart(s => ({ r: Math.max(0, s.r - 1), c: s.c }));
  }
  function removeRowBottom() {
    if (rows <= MIN) return;
    setGrid(prev => prev.slice(0, -1));
    setRows(rows - 1);
  }
  function addColLeft() {
    if (cols >= MAX) return;
    setGrid(prev => prev.map(row => [CellType.Empty, ...row]));
    setCols(cols + 1);
    setCatStart(s => ({ r: s.r, c: s.c + 1 }));
    setMouseStart(s => ({ r: s.r, c: s.c + 1 }));
  }
  function addColRight() {
    if (cols >= MAX) return;
    setGrid(prev => prev.map(row => [...row, CellType.Empty]));
    setCols(cols + 1);
  }
  function removeColLeft() {
    if (cols <= MIN) return;
    setGrid(prev => prev.map(row => row.slice(1)));
    setCols(cols - 1);
    setCatStart(s => ({ r: s.r, c: Math.max(0, s.c - 1) }));
    setMouseStart(s => ({ r: s.r, c: Math.max(0, s.c - 1) }));
  }
  function removeColRight() {
    if (cols <= MIN) return;
    setGrid(prev => prev.map(row => row.slice(0, -1)));
    setCols(cols - 1);
  }

  function clearGrid() {
    setGrid(Array.from({ length: rows }, () => Array.from({ length: cols }, () => CellType.Empty)));
    flash('ok', '已清空为地板。');
  }

  function randomPlace(type: CellType, count: number) {
    setGrid(prev => {
      const next = prev.map(row => row.slice());
      const empties: MapPoint[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const isStart = (r === catStart.r && c === catStart.c) || (r === mouseStart.r && c === mouseStart.c);
          if (next[r][c] === CellType.Empty && !isStart) empties.push({ r, c });
        }
      }
      // 洗牌
      for (let i = empties.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [empties[i], empties[j]] = [empties[j], empties[i]];
      }
      const n = Math.min(count, empties.length);
      for (let i = 0; i < n; i++) next[empties[i].r][empties[i].c] = type;
      if (n < count) flash('warn', `${type === CellType.Box ? '箱子' : '黄油'}空间不足，仅放置 ${n} 个。`);
      return next;
    });
  }

  // ---------- 保存 / 读取 / 导出 / 导入 ----------
  function handleSave() {
    const map = buildMap();
    const v = validateMap(map);
    if (!v.ok) {
      flash('err', '无法保存：' + v.errors[0]);
      return;
    }
    saveMap(map);
    flash('ok', `已保存「${map.name}」。`);
  }

  function openLoad() {
    setSavedList(listMaps());
    setShowLoad(true);
  }

  function loadSelected(id: string) {
    const all = listMaps();
    const m = all.find(x => x.id === id);
    if (!m) return;
    applyMap(m);
    setShowLoad(false);
    flash('ok', `已载入「${m.name}」。`);
  }

  function handleDelete(id: string) {
    deleteMap(id);
    setSavedList(listMaps());
  }

  function handleExport() {
    const map = buildMap();
    const json = exportMapToString(map);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${map.name || 'map'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const map = importMapFromString(String(reader.result));
        applyMap(map);
        flash('ok', `已导入「${map.name}」。`);
      } catch (err) {
        flash('err', '导入失败：' + (err as Error).message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleNew() {
    clearDraft();
    const m = createEmptyMap('未命名地图', 10, 10);
    applyMap(m);
    flash('ok', '已新建空白地图。');
  }

  function handleTestPlay() {
    const map = buildMap();
    const v = validateMap(map);
    if (!v.ok) {
      flash('err', '无法试玩：' + v.errors[0]);
      return;
    }
    if (v.warnings.length) flash('warn', v.warnings[0]);
    // 试玩前先把当前编辑暂存为草稿，退出后即可回到编辑器继续改
    saveDraft(map);
    const cfg = mapDefinitionToGameConfig(map, playMode);
    setFullConfig(cfg);
    navigate('/game', { state: { from: 'editor' } });
  }

  // ---------- 草稿：挂载时恢复 + 编辑时自动暂存 ----------
  // 进入编辑器时，若存在上次未保存的草稿则自动恢复，避免编辑成果丢失。
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const draft = loadDraft();
    if (draft) {
      applyMap(draft);
      flash('ok', '已恢复上次未保存的草稿，可继续编辑。');
    }
    // 仅首次挂载恢复一次；后续编辑由下方自动暂存接管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 任意编辑变化后防抖暂存草稿（约 600ms）
  useEffect(() => {
    const t = window.setTimeout(() => {
      saveDraft(buildMap());
    }, 600);
    return () => window.clearTimeout(t);
  }, [name, rows, cols, grid, catStart, mouseStart, mapId]);

  // ---------- 渲染 ----------
  const borderBtn = (label: string, onClick: () => void, disabled: boolean) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 34, height: 34, borderRadius: 8, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        background: disabled ? '#ddd' : '#8D6E63', color: '#fff', fontSize: 18, lineHeight: '34px',
      }}
    >{label}</button>
  );

  const cellPx = Math.max(18, Math.min(40, Math.floor(560 / Math.max(rows, cols))));

  return (
    <div style={{
      minHeight: '100vh',
      boxSizing: 'border-box',
      padding: '1rem',
      backgroundColor: '#fef3c7',
      fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
      color: '#4e342e',
    }}>
      {/* 顶部栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <MenuButton src="/ui/关闭.png" alt="返回" onClick={() => navigate('/')} width="clamp(44px, 5vw, 60px)" />
        <h1 style={{ fontSize: '1.6rem', margin: 0 }}>🗺️ 地图编辑器</h1>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="地图名称"
          style={{ fontSize: '1rem', padding: '0.4rem 0.6rem', borderRadius: 8, border: '1px solid #d7ccc8', minWidth: 160 }}
        />
        <div style={{ flex: 1 }} />
        <button style={btnStyle('#8D6E63')} onClick={handleNew}>新建</button>
        <button style={btnStyle('#6d4c41')} onClick={handleSave}>保存</button>
        <button style={btnStyle('#6d4c41')} onClick={openLoad}>读取</button>
        <button style={btnStyle('#5d4037')} onClick={handleExport}>导出</button>
        <button style={btnStyle('#5d4037')} onClick={() => fileInputRef.current?.click()}>导入</button>
        <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={handleImportFile} />
        <button style={{ ...btnStyle('#2e7d32'), fontSize: '1.05rem', fontWeight: 700 }} onClick={handleTestPlay}>▶ 试玩</button>
      </div>

      {msg && (
        <div style={{
          marginBottom: '0.75rem', padding: '0.5rem 0.8rem', borderRadius: 8, fontSize: '0.95rem',
          background: msg.kind === 'ok' ? '#c8e6c9' : msg.kind === 'warn' ? '#fff3cd' : '#ffcdd2',
          color: msg.kind === 'err' ? '#b71c1c' : '#333',
        }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* 编辑区 */}
        <div style={{ ...CARD_STYLE, flex: '1 1 560px' }}>
          {/* 上边界 */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 6 }}>
            {borderBtn('+', addRowTop, rows >= MAX)}
            {borderBtn('−', removeRowTop, rows <= MIN)}
          </div>

          <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
            {/* 左边界 */}
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
              {borderBtn('+', addColLeft, cols >= MAX)}
              {borderBtn('−', removeColLeft, cols <= MIN)}
            </div>

            {/* 网格 */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, ${cellPx}px)`,
              gridTemplateRows: `repeat(${rows}, ${cellPx}px)`,
              gap: 2,
              background: '#3e2723',
              padding: 2,
              borderRadius: 8,
            }}>
              {grid.map((row, r) =>
                row.map((t, c) => {
                  const isCat = catStart.r === r && catStart.c === c;
                  const isMouse = mouseStart.r === r && mouseStart.c === c;
                  const def = TOOLS.find(x => x.id === t) ?? TOOLS[0];
                  return (
                    <div
                      key={`${r}-${c}`}
                      onClick={() => paint(r, c)}
                      title={`(${r},${c})`}
                      style={{
                        width: cellPx, height: cellPx, background: def.color,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: cellPx * 0.6, cursor: 'pointer', userSelect: 'none',
                        border: (isCat || isMouse) ? '2px solid #e65100' : '1px solid rgba(0,0,0,0.15)',
                        color: def.textColor ?? '#3e2723',
                      }}
                    >
                      {isCat ? '🐱' : isMouse ? '🐭' : (t === CellType.Empty || t === CellType.Void ? '' : def.emoji)}
                    </div>
                  );
                }),
              )}
            </div>

            {/* 右边界 */}
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
              {borderBtn('+', addColRight, cols >= MAX)}
              {borderBtn('−', removeColRight, cols <= MIN)}
            </div>
          </div>

          {/* 下边界 */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 6 }}>
            {borderBtn('+', addRowBottom, rows >= MAX)}
            {borderBtn('−', removeRowBottom, rows <= MIN)}
          </div>

          <div style={{ marginTop: '0.6rem', fontSize: '0.85rem', color: '#6d4c41' }}>
            棋盘尺寸：{rows} × {cols}（点击四周边界 +/− 增加或删除一行/一列）
          </div>
        </div>

        {/* 工具与设置 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', flex: '1 1 280px', maxWidth: 360 }}>
          <div style={CARD_STYLE}>
            <div style={{ fontWeight: 700, marginBottom: '0.5rem' }}>🎨 绘制工具</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {TOOLS.map(t => (
                <button
                  key={String(t.id)}
                  onClick={() => setTool(t.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '0.45rem 0.5rem',
                    borderRadius: 8, border: tool === t.id ? '3px solid #e65100' : '1px solid #d7ccc8',
                    background: t.color, cursor: 'pointer', fontSize: '0.9rem', color: t.textColor ?? '#3e2723',
                  }}
                >
                  <span style={{ fontSize: '1.1rem' }}>{t.emoji}</span>{t.label}
                </button>
              ))}
            </div>
            <button style={{ ...btnStyle('#8d6e63'), marginTop: 10, width: '100%' }} onClick={clearGrid}>清空为地板</button>
          </div>

          <div style={CARD_STYLE}>
            <div style={{ fontWeight: 700, marginBottom: '0.5rem' }}>🎲 随机布置</div>
            <label style={labelStyle}>箱子数量：{randomBox}
              <input type="range" min={0} max={40} value={randomBox} onChange={e => setRandomBox(Number(e.target.value))} style={{ width: '100%' }} />
            </label>
            <button style={{ ...btnStyle('#6d4c41'), width: '100%', marginTop: 4 }} onClick={() => randomPlace(CellType.Box, randomBox)}>随机撒箱子</button>
            <label style={{ ...labelStyle, marginTop: 10 }}>黄油数量：{randomButter}
              <input type="range" min={0} max={20} value={randomButter} onChange={e => setRandomButter(Number(e.target.value))} style={{ width: '100%' }} />
            </label>
            <button style={{ ...btnStyle('#6d4c41'), width: '100%', marginTop: 4 }} onClick={() => randomPlace(CellType.ButterSpot, randomButter)}>随机撒黄油</button>
          </div>

          <div style={CARD_STYLE}>
            <div style={{ fontWeight: 700, marginBottom: '0.5rem' }}>▶ 试玩设置</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setPlayMode(GameMode.Single)}
                style={{ ...btnStyle(playMode === GameMode.Single ? '#2e7d32' : '#a1887f'), flex: 1 }}
              >单人（你 vs AI 猫）</button>
              <button
                onClick={() => setPlayMode(GameMode.Dual)}
                style={{ ...btnStyle(playMode === GameMode.Dual ? '#2e7d32' : '#a1887f'), flex: 1 }}
              >双人同屏</button>
            </div>
            <button style={{ ...btnStyle('#2e7d32'), width: '100%', marginTop: 10, fontSize: '1.05rem', fontWeight: 700 }} onClick={handleTestPlay}>▶ 开始试玩</button>
            <div style={{ fontSize: '0.8rem', color: '#6d4c41', marginTop: 6 }}>
              提示：至少绘制一个鼠洞，并设置猫/鼠起点。快速通道成对放置才能传送。
            </div>
          </div>
        </div>
      </div>

      {/* 读取弹窗 */}
      {showLoad && (
        <div onClick={() => setShowLoad(false)} style={overlayStyle}>
          <div onClick={e => e.stopPropagation()} style={{ ...CARD_STYLE, width: 'min(520px, 92vw)', maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.2rem' }}>读取已保存地图</h2>
              <button style={btnStyle('#8d6e63')} onClick={() => setShowLoad(false)}>关闭</button>
            </div>
            {savedList.length === 0 && <div style={{ color: '#6d4c41' }}>暂无保存的地图。</div>}
            {savedList.map(m => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{m.name}</div>
                  <div style={{ fontSize: '0.8rem', color: '#6d4c41' }}>{m.rows}×{m.cols} · {new Date(m.updatedAt).toLocaleString()}</div>
                </div>
                <button style={btnStyle('#2e7d32')} onClick={() => loadSelected(m.id)}>载入</button>
                <button style={btnStyle('#c62828')} onClick={() => handleDelete(m.id)}>删除</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: '0.5rem 0.9rem', borderRadius: 8, border: 'none', cursor: 'pointer',
    background: bg, color: '#fff', fontSize: '0.95rem',
  };
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '0.9rem', marginTop: 4 };

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
};
