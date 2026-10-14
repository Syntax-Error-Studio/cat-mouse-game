// Regenerates the inventory table inside docs/REPORTS_INDEX.md.
// Run from the repository root:  node scripts/generate-reports-index.mjs
//
// It only reads filenames, line counts and each file's first H1; it never
// rewrites any report's content or conclusions. The generated block is
// delimited by the MARKER comments below — everything outside them is prose.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOC = path.join(ROOT, 'docs', 'REPORTS_INDEX.md');
const MARKER_BEGIN = '<!-- BEGIN GENERATED INVENTORY -->';
const MARKER_END = '<!-- END GENERATED INVENTORY -->';

// Documents whose FILENAME does not describe what the file actually contains.
// Verified by hand on 2026-10-13 by reading each file's opening lines; see the
// "已确认的错位文档" section of the index for the evidence.
const TASK_BRIEFS = new Set([
  'D4-final-report.md',
  'G0.3G-hard-strength-root-cause.md',
  'G0.4F-2B-1.9E-g8t10-value-ranking-gap.md',
  'G0.4F-2B-1.9F-structural-loss-sentinel-feasibility.md',
]);
const CORRECTIONS = new Set(['F0-hard-integration-audit.md']);

const kindOf = f => CORRECTIONS.has(f) ? '更正声明（取代前一轮结论）'
  : TASK_BRIEFS.has(f) ? '下一阶段任务书（文件名是上一轮）'
    : '本轮记录';

const groupOf = f => {
  const seg = f.replace(/\.md$/, '').split('-');
  return seg.length > 1 && /^[0-9]/.test(seg[1]) ? `${seg[0]}-${seg[1]}` : seg[0];
};

const files = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.md') && !['README.md', 'GAMEPLAY.md', 'CODELY.md'].includes(f))
  .sort();

const rows = [];
let prev = null;
for (const f of files) {
  const all = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const g = groupOf(f);
  if (g !== prev) {
    if (prev !== null) rows.push('');
    rows.push(`#### ${g}\n`, '', '| 文件 | 原文 H1 标题 | 行数 | 性质 |', '| --- | --- | --- | --- |');
    prev = g;
  }
  const titleRaw = all.match(/^#\s+(.+)$/m);
  const title = (titleRaw ? titleRaw[1].trim() : '（无 H1 标题）').replace(/\|/g, '\\|');
  // same definition as `wc -l` (newline count, +1 when the file lacks a final newline)
  const lines = all.endsWith('\n') ? all.slice(0, -1).split('\n').length : all.split('\n').length;
  const kind = kindOf(f);
  rows.push(`| [\`${f}\`](../${f}) | ${title} | ${lines} | ${kind === '本轮记录' ? '本轮记录' : `**${kind}**`} |`);
}

const table = [
  `共 ${files.length} 份轮次文档（不含 \`README.md\`、\`GAMEPLAY.md\` 与被 gitignore 的 \`CODELY.md\`）。`,
  '本表由 `scripts/generate-reports-index.mjs` 从文件名与各文件的第一行 H1 生成，',
  '**请勿手工编辑表格行**；要调整分类请改脚本里的清单并重跑。',
  '',
  ...rows,
].join('\n');

const doc = fs.readFileSync(DOC, 'utf8');
const b = doc.indexOf(MARKER_BEGIN);
const e = doc.indexOf(MARKER_END);
if (b < 0 || e < 0 || e < b) throw new Error('markers missing or out of order in docs/REPORTS_INDEX.md');
const next = doc.slice(0, b + MARKER_BEGIN.length) + '\n' + table + '\n\n' + doc.slice(e);
fs.writeFileSync(DOC, next, 'utf8');
console.log(`generated ${files.length} rows into docs/REPORTS_INDEX.md`);
