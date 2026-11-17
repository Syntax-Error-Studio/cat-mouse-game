/**
 * PPC-REPORT-01-SEAL — the two core figures of the competition chapter.
 *
 *   figures/transition-reuse-comparison.svg  mechanism: two-pass vs prepared reuse
 *   figures/rule-calls-comparison.svg        rule-kernel calls, Phase 1 / Phase 2
 *
 * Requirements this file implements (SEAL brief §4):
 *   - Chinese terminology throughout, so the figures can be embedded in the
 *     chapter without a translation layer;
 *   - the mechanism figure distinguishes SIMULATOR calls (simulateSearchAction)
 *     from KERNEL calls (RuleSet spatial-action kernels) — they are not the same
 *     quantity (RULE-A early return costs a simulator call and zero kernel calls);
 *   - the cost figure keeps two independent vertical scales and does NOT claim the
 *     counts are machine- or load-independent (only the fixed-workload panel is:
 *     the fixed-budget panel counts whatever fitted into 100 ms on that machine);
 *   - type sizes chosen for A4/Word embedding at ~15 cm width: body >= 13 px.
 *
 * Data inputs (read-only):
 *   PHASE1_ANALYSIS/summary.json   -> ruleCalls (fixed 200-simulation workload)
 *   data/phase2-formal/*.jsonl     -> ruleCalls summed per arm (fixed 100 ms)
 *
 * Usage: node PPC-MCTS-01B/scripts/makeReportFigures.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const round = resolve(here, '..');
const figDir = resolve(round, 'figures');

const ink = '#1f2328';
const muted = '#5b5b62';
const warm = '#a8473e';
const cool = '#2b7256';
const grid = '#e2e2e6';
// CJK-capable stack: Word renders the SVG with the host's fonts, so the first
// three entries cover Windows, macOS and Linux respectively.
const font = "'Microsoft YaHei','PingFang SC','Noto Sans SC','Source Han Sans SC',sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n0 = (x) => Number(x).toLocaleString('en-US');
const MINUS = '\u2212';

/** Rendered width estimate: CJK glyphs are ~1em, Latin ~0.55em. */
const textW = (s, size) => [...String(s)]
  .reduce((w, ch) => w + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.55), 0);

function svgOpen(w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#ffffff"/>` +
    `<defs><marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="${muted}"/></marker></defs>`;
}

// ---------------------------------------------------------------------------
// Figure 1 — mechanism, per rollout step
// ---------------------------------------------------------------------------
function mechanismFigure() {
  const W = 1120;
  const H = 700;
  const parts = [];
  const text = (x, y, s, size, fill, anchor = 'start', weight = 'normal') =>
    parts.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-size="${size}"` +
      ` font-weight="${weight}" fill="${fill}">${esc(s)}</text>`);
  /** `markup` is already-escaped SVG (used for real subscripts). */
  const raw = (x, y, markup, size, fill, weight = '600') =>
    parts.push(`<text x="${x}" y="${y}" font-family="${font}" font-size="${size}"` +
      ` font-weight="${weight}" fill="${fill}">${markup}</text>`);

  text(40, 42, '采样步内的候选转移：两遍式（上）与复用实现（下）', 21, ink, 'start', '600');
  text(40, 76, '模拟器调用 = 调用 simulateSearchAction（推进一次局面）；内核调用 = 进入 RuleSet 的五个空间动作内核。',
    14.5, muted);

  const xs = [40, 310, 580, 850];
  const BW = 220;
  const BH = 88;

  const row = (labelY, boxY, label, colour, boxes, badges, costMarkup, costColour) => {
    text(40, labelY, label, 17, colour, 'start', '600');
    boxes.forEach((b, i) => {
      const x = xs[i];
      parts.push(`<rect x="${x}" y="${boxY}" width="${BW}" height="${BH}" rx="8" fill="${b.fill}" stroke="${b.stroke}" stroke-width="1.4"/>`);
      text(x + BW / 2, boxY + 32, b.head, 16, ink, 'middle', '600');
      b.sub.forEach((s, j) => text(x + BW / 2, boxY + 56 + j * 20, s, 13.8, muted, 'middle'));
      if (i < boxes.length - 1) {
        parts.push(`<line x1="${x + BW + 4}" y1="${boxY + BH / 2}" x2="${xs[i + 1] - 5}" y2="${boxY + BH / 2}"` +
          ` stroke="${muted}" stroke-width="1.4" marker-end="url(#ar)"/>`);
      }
    });
    badges.forEach((b, i) => {
      const cx = xs[i] + BW / 2;
      const w = textW(b, 14) + 30;
      parts.push(`<rect x="${cx - w / 2}" y="${boxY + BH + 12}" width="${w}" height="26" rx="13" fill="${costColour}" opacity="0.12"/>`);
      text(cx, boxY + BH + 30, b, 14, costColour, 'middle');
    });
    raw(40, boxY + BH + 84, costMarkup, 15.5, costColour);
  };
  row(118, 132, 'A  两遍式（朴素实现）', warm, [
    { head: '枚举候选', sub: ['纯函数，不做任何转移'], fill: '#f5f5f7', stroke: '#c5c5cd' },
    { head: '合法性验证', sub: ['逐候选调用一次模拟器'], fill: '#fbf0ec', stroke: '#dfb3a8' },
    { head: '引导评价', sub: ['逐合法候选再调用一次', '取后继算叶值'], fill: '#fbf0ec', stroke: '#dfb3a8' },
    { head: '选定执行', sub: ['选中动作再调用一次', '推进局面'], fill: '#fbf0ec', stroke: '#dfb3a8' },
  ], ['0 次', 'N − E 次', 'k 次', '1 次'],
  `C<tspan dy="4" font-size="11.5">L</tspan><tspan dy="-4"> = (N − E) + 1[k ≥ 2]·k + 1[k ≥ 1]　（每步内核调用）</tspan>`, warm);

  row(330, 344, 'B  复用实现（Prepared）', cool, [
    { head: '枚举候选', sub: ['同一枚举源'], fill: '#f5f5f7', stroke: '#c5c5cd' },
    { head: '一次执行', sub: ['每候选恰好一次', '转移结果保留'], fill: '#eaf4ee', stroke: '#8ebfa8' },
    { head: '引导评价', sub: ['读已保留的转移', '不再调用模拟器'], fill: '#eaf4ee', stroke: '#8ebfa8' },
    { head: '选定执行', sub: ['读已保留的转移', '不再调用模拟器'], fill: '#eaf4ee', stroke: '#8ebfa8' },
  ], ['0 次', 'N 次', '0 次', '0 次'],
  `C<tspan dy="4" font-size="11.5">P</tspan><tspan dy="-4"> = N　（每步内核调用；E 为隧道出口等免验证候选）</tspan>`, cool);

  parts.push(`<line x1="40" y1="536" x2="${W - 40}" y2="536" stroke="${grid}" stroke-width="1"/>`);

  const notes = [
    '边界一（k = 0，零合法动作）：两臂都在枚举后直接结束本步，不进入引导与执行，内核调用次数相同。',
    '边界二（k = 1，单合法动作）：两臂都跳过引导扫描且不抽随机数；两遍式 N + 1 次，复用 N 次。',
    '边界三（隧道出口）：出口合法性由局面保证，两遍式不为它们做合法性模拟，只为其取引导值与执行各算一次；复用统一按每候选一次处理。',
    '边界四（机会转移）：复用对象既包括确定性后继，也包括确定构造的结果集 (o_i, w_i) 与其原顺序；抽样前仍做 |Σw − 1| ≤ 1e-9 校验，随机抽样次数不变。',
    '作用域：复用只作用于采样步；搜索树内扩张在两臂上逐行相同。图示次数为内核调用，不含 endTurn、奶油生成格枚举与结果集构造。',
  ];
  notes.forEach((s, i) => text(40, 558 + i * 23, s, 13.6, muted));

  return `${svgOpen(W, H)}${parts.join('')}</svg>\n`;
}

// ---------------------------------------------------------------------------
// Figure 2 — rule-kernel calls, measured
// ---------------------------------------------------------------------------
function ruleCallsFigure() {
  const p1 = JSON.parse(readFileSync(resolve(round, 'PHASE1_ANALYSIS/summary.json'), 'utf8'));
  const rows = [];
  for (const f of readdirSync(resolve(round, 'data/phase2-formal')).filter((n) => n.endsWith('.jsonl'))) {
    const body = readFileSync(resolve(round, 'data/phase2-formal', f), 'utf8').trim();
    if (!body) continue;
    for (const line of body.split('\n')) rows.push(JSON.parse(line));
  }
  const sum = (arm) => rows.filter((r) => r.arm === arm).reduce((s, r) => s + (Number(r.ruleCalls) || 0), 0);

  const panels = [
    { label: 'Phase 1　固定工作量', sub: '960 次调用，每次完成 200 条采样', base: p1.ruleCalls.baseline, prep: p1.ruleCalls.prepared, x: 96 },
    { label: 'Phase 2　固定 100 ms 预算', sub: '960 次调用，每个计划都由真实引擎回放校验', base: sum('baseline'), prep: sum('prepared'), x: 588 },
  ];

  const W = 1020;
  const H = 566;
  const plotTop = 208;
  const baseY = 388;
  const barW = 110;
  const gap = 70;
  const parts = [];

  const text = (x, y, s, size, fill, anchor = 'start', weight = 'normal') =>
    parts.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-size="${size}"` +
      ` font-weight="${weight}" fill="${fill}">${esc(s)}</text>`);

  text(40, 42, '规则内核调用次数：两遍式与复用实现对照', 21, ink, 'start', '600');
  text(40, 74, '两个面板各自独立标度：两组实验完成的工作量不同，只有同一面板内的比值可比。', 14.5, muted);
  text(40, 96, '计数单位是 RuleSet 的五个空间动作内核；固定工作量组的次数由种子与规则唯一确定，固定预算组的次数取决于该预算内做到了多少工作。',
    14.5, muted);

  for (const p of panels) {
    const hMax = baseY - plotTop - 48;
    const scale = hMax / p.base;
    const hBase = p.base * scale;
    const hPrep = Math.max(3, p.prep * scale);
    const cut = 1 - p.prep / p.base;

    text(p.x, plotTop - 34, p.label, 17, ink, 'start', '600');
    text(p.x, plotTop - 12, p.sub, 14, muted);

    const bx1 = p.x;
    const bx2 = p.x + barW + gap;
    const axisX = p.x - 18;
    parts.push(`<line x1="${axisX}" y1="${baseY}" x2="${bx2 + barW + 10}" y2="${baseY}" stroke="${ink}" stroke-width="1.3"/>`);
    parts.push(`<line x1="${axisX}" y1="${baseY}" x2="${axisX}" y2="${plotTop - 2}" stroke="${ink}" stroke-width="1.3"/>`);
    parts.push(`<text x="${axisX - 10}" y="${(plotTop + baseY) / 2}" text-anchor="middle" font-family="${font}"` +
      ` font-size="13.5" fill="${muted}" transform="rotate(-90 ${axisX - 10} ${(plotTop + baseY) / 2})">内核调用次数</text>`);

    parts.push(`<rect x="${bx1}" y="${(baseY - hBase).toFixed(1)}" width="${barW}" height="${hBase.toFixed(1)}" fill="#c5c5cd"/>`);
    parts.push(`<rect x="${bx2}" y="${(baseY - hPrep).toFixed(1)}" width="${barW}" height="${hPrep.toFixed(1)}" fill="#8ebfa8"/>`);
    text(bx1 + barW / 2, baseY - hBase - 12, n0(p.base), 15.5, ink, 'middle', '600');
    text(bx2 + barW / 2, baseY - hPrep - 12, n0(p.prep), 15.5, ink, 'middle', '600');
    text(bx1 + barW / 2, baseY + 26, '两遍式', 14.5, muted, 'middle');
    text(bx2 + barW / 2, baseY + 26, '复用', 14.5, muted, 'middle');

    const bw = 236;
    const cx = p.x + (barW * 2 + gap) / 2;
    parts.push(`<rect x="${cx - bw / 2}" y="${baseY + 44}" width="${bw}" height="30" rx="15" fill="${cool}" opacity="0.12"/>`);
    text(cx, baseY + 65, `内核调用 ${MINUS}${(cut * 100).toFixed(2)}%`, 15.5, cool, 'middle', '600');
  }

  text(40, H - 56, '这只是成本命题：同一份搜索付出了更少的规则计算，与棋力无关。两组的总量不同，故不给跨面板的百分比比较。',
    13.6, muted);
  text(40, H - 26, '数据来源：PHASE1_ANALYSIS/summary.json 的 ruleCalls；data/phase2-formal/*.jsonl 逐条记录的 ruleCalls 之和。',
    13.6, muted);

  return `${svgOpen(W, H)}${parts.join('')}</svg>\n`;
}

writeFileSync(resolve(figDir, 'transition-reuse-comparison.svg'), mechanismFigure(), 'utf8');
writeFileSync(resolve(figDir, 'rule-calls-comparison.svg'), ruleCallsFigure(), 'utf8');
console.log('wrote figures/transition-reuse-comparison.svg');
console.log('wrote figures/rule-calls-comparison.svg');
