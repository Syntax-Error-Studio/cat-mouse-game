/**
 * PPC-HV-3 P0 — 「危险区域辅助」UI 图层的结构性契约（本分支无组件测试基建，沿用源码断言）。
 *
 * 从 feat/web-v1 的 dangerUi 契约移植，只保留这条分支还成立的四件事：
 *   1) 遮罩必须在最底层，不能盖住角色/黄油/箱子/陷阱/通道，也不许吃掉点击；
 *   2) 危险与否只能来自 game/threat 的存在性证明，UI 不许自己算距离；
 *   3) 红格只有一种样式：没有步数角标、没有第二颜色、没有图例、没有动画；
 *   4) 开关默认关闭，选择记在本地，桌面与手机共用同一个 store。
 * web-v1 那套「开启时整块棋盘收缩进视口」的尺寸契约依赖 boardMetrics / 联机快照，
 * 本分支没有这两个前提，所以不移植 —— 少一条断言比假装守住一条要诚实。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const board = readFileSync('src/components/Board.tsx', 'utf8');
const aid = readFileSync('src/components/dangerAssist.ts', 'utf8');
const css = readFileSync('src/index.css', 'utf8');

function rule(selector: string): string {
  const m = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  expect(m, `${selector} 必须存在`).toBeTruthy();
  return m![1];
}

describe('危险区域图层 — 只染色，不遮挡', () => {
  it('遮罩在 zIndex 0，低于实体层(1)与角色(10)，并且不吃点击', () => {
    expect(rule('.danger-fill')).toMatch(/z-index:\s*0/);
    expect(rule('.danger-fill')).toMatch(/position:\s*absolute/);
    expect(rule('.danger-fill')).toMatch(/inset:\s*0/);
    expect(rule('.danger-fill')).toMatch(/pointer-events:\s*none/);
    // 半透明：不许变成整块不透明红，否则棋子和地形就看不清了。
    const bg = rule('.danger-fill').match(/background:\s*rgba\(([^)]*)\)/);
    expect(bg, '.danger-fill 必须是 rgba 半透明底色').toBeTruthy();
    expect(Number(bg![1].split(',')[3].trim())).toBeLessThan(0.5);
    expect(board).toMatch(/zIndex:\s*1,/);   // cellItemStyle 实体层
    expect(board).toMatch(/zIndex:\s*10,/);  // 角色层
  });

  it('遮罩是格子里的第一个子节点，实体与角色都排在它后面', () => {
    const fill = board.indexOf('<div className="danger-fill" />');
    const items = board.indexOf('<div style={cellItemStyle}>');
    expect(fill).toBeGreaterThan(-1);
    expect(items).toBeGreaterThan(fill);
  });

  it('全部危险格只有一种样式：没有角标、没有必死格、没有动画', () => {
    expect(css).not.toContain('.danger-steps');
    expect(css).not.toContain('.danger-fill-forced');
    expect(css).not.toContain('.danger-legend');
    expect(css).not.toContain('danger-pulse');
    expect(rule('.danger-fill')).not.toMatch(/animation/);
    expect(board).not.toContain('danger-steps');
    expect(board).not.toContain('danger-fill-forced');
    expect(board).not.toContain('isForcedLoss');
    // 步数与 witnessPath 是算法内部的证据，棋盘渲染层不许读它们。
    expect(board).not.toMatch(/minimumSteps|witnessPath/);
  });
});

describe('危险区域数据来源 — UI 不重新实现规则', () => {
  it('Board 只接地图，不调用分析器也不自己算距离', () => {
    expect(board).toContain('threatMap?: CatThreatMap | null');
    expect(board).not.toContain('getCatThreatMap');
    expect(board).not.toMatch(/Math\.abs\([^)]*\.[rc]Position/);
  });

  it('地图只有 game/threat/catThreatMap 一个来源', () => {
    expect(aid).toContain("from '../game/threat/catThreatMap'");
    expect(aid).toMatch(/export function useCatThreatMap\(state: ThreatInputState \| null\)/);
    // 快照类型缺的只有调试字段，规则字段仍来自同一份 GameEngineState
    expect(aid).not.toMatch(/catMove|mouseMove/);
  });

  it('游戏已结束时不再画范围', () => {
    expect(aid).toMatch(/GamePhase\.CatWins\s*\|\|\s*settled\.phase === GamePhase\.MouseWins/);
  });

  it('开关是可选开启、默认关闭，并且 PC/手机共用一个 store', () => {
    expect(aid).toMatch(/if \(typeof window === 'undefined'\) return false/);
    expect(aid).toMatch(/getItem\(STORE_KEY\) === '1'/);
    expect(aid).toContain('useSyncExternalStore');
    expect(board).toContain('toggleDangerAssist');
  });
});
