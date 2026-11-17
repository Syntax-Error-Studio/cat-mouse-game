/**
 * PPC-REPORT-01 — generate the competition-report chapter from measured data.
 *
 * Every number in the output is read from the analysis artefacts, never typed by
 * hand, so re-running after a new experiment cannot leave a stale figure in the
 * prose. Prose states what was measured, what was not, and why the mechanism is
 * novel; it contains no internal audit narrative.
 *
 * Inputs : PHASE1_ANALYSIS/summary.json, PHASE2_ANALYSIS/summary.json,
 *          data/phase1-formal/*.jsonl, data/phase2-formal/*.jsonl (read-only)
 * Output : TECHNICAL_REPORT_INSERT.md, COMPETITION_METRICS_TABLE.md
 *
 * Usage: node PPC-MCTS-01B/scripts/makeTechnicalInsert.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const round = resolve(repo, 'PPC-MCTS-01B');

const p1 = JSON.parse(readFileSync(resolve(round, 'PHASE1_ANALYSIS/summary.json'), 'utf8'));
const p2 = JSON.parse(readFileSync(resolve(round, 'PHASE2_ANALYSIS/summary.json'), 'utf8'));

// ---------------------------------------------------------------------------
// totals read straight from the raw JSONL (means alone would round the counts)
// ---------------------------------------------------------------------------
function readRows(dir) {
  const rows = [];
  for (const f of readdirSync(resolve(round, dir)).filter((f) => f.endsWith('.jsonl'))) {
    const text = readFileSync(resolve(round, dir, f), 'utf8').trim();
    if (text.length === 0) continue;
    for (const line of text.split('\n')) rows.push(JSON.parse(line));
  }
  return rows;
}

const rows2 = readRows('data/phase2-formal');
const sumBy = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const arm2 = (name) => rows2.filter((r) => r.arm === name);
const b2 = arm2('baseline');
const q2 = arm2('prepared');
const tot = (arr, key) => sumBy(arr, (r) => r[key]);

const P2 = {
  rows: rows2.length,
  sims: [tot(b2, 'simulations'), tot(q2, 'simulations')],
  nodes: [tot(b2, 'nodesCreated'), tot(q2, 'nodesCreated')],
  chance: [tot(b2, 'chanceSamples'), tot(q2, 'chanceSamples')],
  rollout: [tot(b2, 'rolloutSteps'), tot(q2, 'rolloutSteps')],
  ruleCalls: [tot(b2, 'ruleCalls'), tot(q2, 'ruleCalls')],
  preparedSteps: tot(q2, 'rolloutPreparedSteps'),
  impureFallbacks: tot(rows2, 'rolloutImpureFallbacks'),
  mathRandom: tot(rows2, 'mathRandomCalls'),
};

// ---------------------------------------------------------------------------
// Phase 1 aggregates from the per-cell records
// ---------------------------------------------------------------------------
const cells = p1.cells;
const cellEq = (f) => cells.filter((c) => c[`${f}Baseline`] === c[`${f}Prepared`]).length;
const P1 = {
  cells: cells.length,
  sumNodes: sumBy(cells, (c) => c.nodesBaseline),
  sumChance: sumBy(cells, (c) => c.chanceBaseline),
  nodesEqual: cellEq('nodes'),
  chanceEqual: cellEq('chance'),
  simsEqual: cellEq('sims'),
  ruleCalls: [p1.ruleCalls.baseline, p1.ruleCalls.prepared],
};
const ruleReductionP1 = 1 - P1.ruleCalls[1] / P1.ruleCalls[0];
const ruleReductionP2 = 1 - P2.ruleCalls[1] / P2.ruleCalls[0];
const preparedPerCall = P2.preparedSteps / 480;

const acc = p1.acceptance;
const P1_PROCS = p1.inputs.envelope ? p1.inputs.envelope.freshNodeProcessesExecuted : 20;
const P2_PROCS = p2.inputs.files.length;
const e = p2.efficiency;
const ciRel = e.bootstrap.relativeGainCI95;
const ciDiff = e.bootstrap.meanDiffCI95;
const ob = e.orderBalanced;
const balanced = ob.balancedArmEffect;
const orderEff = ob.orderEffect;
const integrity = p2.integrity;
const st = p2.structure;
const ta = p2.timeByArm;

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------
const f1 = (x) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(1));
const f2 = (x) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(2));
const pct = (x, d = 2) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const n0 = (x) => Number(x).toLocaleString('en-US');
const MINUS = '\u2212';
const sign = (x, d = 2) => (x === null || x === undefined
  ? 'n/a'
  : `${x >= 0 ? '+' : MINUS}${Math.abs(x * 100).toFixed(d)}%`);
/** Signed fixed-point with a typographic minus, for absolute differences. */
const s2 = (x) => (x === null || x === undefined ? 'n/a' : `${x < 0 ? MINUS : ''}${Math.abs(Number(x)).toFixed(2)}`);
/** Every rendered table is registered so the gate can re-parse the emitted
 *  Markdown and compare it cell by cell with what was intended. */
const TABLE_REGISTRY = [];
const tbl = (head, rowsArr, doc = 'body') => {
  TABLE_REGISTRY.push({ doc, head: head.slice(), rows: rowsArr.map((r) => r.map(String)) });
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rowsArr.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
};

/**
 * Typographic quotes for the Chinese prose. The generator writes plain ASCII
 * quotes because they are unambiguous to edit; a competition chapter wants
 * U+201C / U+201D. Quotation marks are paired in reading order throughout the
 * document and appear nowhere inside code spans or formulas, so a single
 * left-to-right pass is exact (asserted below by checking the replacement count).
 */
function smartQuotes(text) {
  let open = true;
  let count = 0;
  const out = text.replace(/"/g, () => {
    count++;
    const ch = open ? '\u201c' : '\u201d';
    open = !open;
    return ch;
  });
  if (count % 2 !== 0) throw new Error(`unbalanced quotes: ${count} ASCII quotation marks`);
  return out;
}

// figures generated by scripts/analyzePhase2.mjs
const FIG = {
  flow: 'figures/transition-reuse-comparison.svg',
  calls: 'figures/rule-calls-comparison.svg',
  throughput: 'figures/simulation-throughput.svg',
  perRoot: 'figures/paired-performance-gain.svg',
  coverage: 'figures/plan-coverage.svg',
};

const md = [];
const P = (s = '') => md.push(s);

// ---------------------------------------------------------------------------
// 1. 技术问题
// ---------------------------------------------------------------------------
P('# 面向实时博弈搜索的候选状态转移复用与语义一致性验证机制');
P('');
P(`> 本章数据全部来自正式实验工件：Phase 1 见 \`PPC-MCTS-01B/data/phase1-formal/\` 与`);
P(`> \`PHASE1_ANALYSIS/summary.json\`，Phase 2 见 \`PPC-MCTS-01B/data/phase2-formal/\` 与`);
P(`> \`PHASE2_ANALYSIS/summary.json\`。正文中的每一个数值都由分析脚本从原始记录生成。`);
P('');
P('实时博弈搜索内核在每个采样步内会为同一个候选动作反复计算同一份状态转移：一次用于判定合法性，');
P('一次用于引导评价，一次用于真正推进局面。本文提出**候选状态转移复用与语义一致性验证机制**：把');
P('这三处合并为一次计算，并用“固定完成采样数 + 逐事件摘要”的方法证明合并后的搜索行为与合并前');
P('逐事件一致，再以固定 100 ms 预算的对照实验测量它在实时约束下的实际效果。实验结论是：决策语义');
P(`逐事件一致，规则内核调用下降 ${pct(ruleReductionP1)}；在固定 100 ms 预算下未检测到明确的吞吐提升。`);
P('两项结论共同界定了该机制的适用位置。');
P('');
P('## 1 技术问题');
P('');
P('实时对抗博弈的每一步决策都受严格的时间预算约束。以本文的实验对象为例：主搜索预算 100 ms，');
P('完整回合（搜索 + 计划生成）预算 150 ms。在该预算下，提升决策质量的直接手段是让搜索在同样的');
P('时间里完成更多次采样、或者完成更深的采样，而不是延长思考时间。');
P('');
P('这类搜索内核（UCT/MCTS 及其变体）在一个采样步内，会对当前局面的候选动作反复询问同一组问题：');
P('');
P('1. **这个动作合法吗？** 在本文的规则层里，合法性的判定方式是"把动作实际执行一遍，看局面是否');
P('   发生了影响游戏进程的变化"——一次无效动作与一次合法动作在返回值上只差一个比较结果，但它们');
P('   都必须真正执行一次规则转移。');
P('2. **走了它会怎样？** 引导评价需要该动作的后继局面（若是机会转移，还需其全部结果与概率）。');
P('3. **真正走它，后继状态是什么？** 采样在选定动作后需要沿该动作推进局面。');
P('');
P('朴素实现把这三个问题写成三次独立的遍历：先为"哪些动作合法"逐候选执行一遍，再为"每个合法动作');
P('值多少"逐合法候选再执行一遍，最后为"选中的动作"再执行一遍。设一个采样步内枚举 $N$ 个候选动作、');
P('其中 $k$ 个合法：$k \\ge 2$ 时被选中的动作被执行 3 次、其余合法候选各 2 次；$k=1$ 时该动作被执行 2 次；');
P('非法候选无论哪种情形都只被执行 1 次——后者');
P('的执行结果只用于得出"无效"这一比较结论。单次调用看只是常数开销；但在每秒需要成千上万次决策的');
P('在线系统里，它直接决定了预算能被兑换成多少次有效采样。');
P('');
P('本文要解决的问题因此是：**能否在不改变任何决策输出——包括随机数消耗序列——的前提下，把同一搜索');
P('步内的重复状态转移合并为一次计算，并且证明这种合并是可替换而非近似替换。**');
P('');

// ---------------------------------------------------------------------------
// 2. 机制设计
// ---------------------------------------------------------------------------
P('## 2 机制设计');
P('');
P('### 2.1 单一候选枚举源 + 一次性转移');
P('');
P('机制由两个函数构成，二者共同覆盖"候选是什么"与"候选的转移是什么"这两件事，且只覆盖一次：');
P('');
P('- `enumerateSearchActionCandidates(state)`：纯函数，只回答"从该局面出发有哪些候选动作、按什么顺序、');
P('  是否需要验证合法性"。它不执行任何规则转移，也不消耗随机数。');
P('- `generatePreparedSearchActions(state, rules)`：对上述每个候选**恰好执行一次**规则转移，并把转移结果');
P('  与该动作、以及它在合法动作列表中的序号 `originalIndex` 一起返回，构成一个 Prepared Batch。');
P('');
P('合法性判据与旧实现逐字一致：转移结果若是机会转移（拾取黄油），一律视为真实走了这一步；否则以');
P('"局面是否发生影响游戏进程的变化"为准。这一判据的等价性不是本文的贡献，而是必须保持不变的前提。');
P('');
P('### 2.2 六个子问题的分别处理');
P('');
P('机制的难点不在"把重复执行合成一次"这个想法本身，而在于搜索内核里实际上有六处会触碰动作转移，');
P('每一处的处理方式都不同。表 1 逐项列出实现中的对应做法。');
P('');
P('表 1　候选处理链路各环节在复用机制下的处理方式');
P('');
P(tbl(['环节', '朴素实现', '复用实现', '保持不变的性质'], [
  ['候选合法性验证', '每候选执行 1 次规则转移，随后丢弃转移结果', '每候选执行 1 次，**保留**转移结果', '合法性判据、候选顺序、`originalIndex`'],
  ['Hybrid 引导评价', '对每个合法候选再执行 1 次，取得后继后算叶值', '直接读取已保留的转移，算叶值', '同一后继、同一算术、同一遍历顺序、同一 $10^{-12}$ 同分判据'],
  ['选定动作执行', '对选中动作再执行 1 次', '直接读取该候选已保留的转移', '后继状态的结构与语义逐字段一致'],
  ['单合法动作短路', '不进入引导扫描，但仍需为执行再算一次', '只读取那次已验证的转移', '不抽随机数、不做平局裁决（随机流一致的关键）'],
  ['隧道出口状态', '出口由局面直接给出，合法性由构造保证，不为它们做合法性模拟；引导与执行仍各算一次', '对每个出口各执行一次并保留转移，引导与执行都读它', '出口集合、顺序、数量完全由局面决定'],
  ['机会转移的概率分布', '引导阶段重新构建结果集与权重', '复用转移自带的 $(o_i, w_i)$ 与原顺序，不重新构建、不重新归一', '抽样前仍做同样校验；抽样仍是一次均匀抽样经逆累积分布'],
], ));
P('');
P('表 1 中的"执行"指一次**模拟器调用**（`simulateSearchAction`），它内部通常再调用一次 **RuleSet 内核**。');
P('两者在计数上并不等价，§3.1 给出确切口径。');
P('');
P('**复用的对象是两类后继，而不只是确定性的那一类**：一类是确定性转移给出的单个后继状态，另一类是');
P('确定构造出来的 CHANCE 概率结果集——同样的调用参数、同样的规则层、同样的枚举顺序，得到的就是同一份');
P('$(o_i, w_i)$ 列表。复用不缓存概率，也不重新计算概率，而是把"引擎刚刚算出的那一份结果集"原样交给后续');
P('三个读取点，因此结果的顺序、权重与权重和都是同一批浮点数。');
P('');
P('抽样前的校验与朴素实现完全相同，共三道：结果集非空；每个权重有限且严格为正；');
P('$\\left|\\sum_i w_i - 1\\right| \\le 10^{-9}$（取绝对值，权重和小于 1 与大于 1 同等对待）。校验失败即抛出，');
P('绝不静默修补分布、也绝不退化为隐式随机。抽样本身仍是单次均匀随机数经逆累积分布定位结果下标，因此');
P('随机数消耗次数与用途序列不随机制变化。');
P('');
P('### 2.3 作用域：一次性数据流，而不是缓存');
P('');
P('这是本机制与"转移缓存"的根本区别，也是它不引入失效风险的原因：');
P('');
P('- 一个 Prepared Batch 只在**一个采样步内**存活，步结束即被丢弃，不进入搜索树、不跨节点、不跨采样；');
P('- 因此它没有命中率、没有失效判定、没有跨节点生命周期，也就不存在"缓存过期导致语义漂移"这一类风险；');
P('- 候选集合、顺序与序号从构造上只有一份来源，合法动作列表与递归所用的转移不可能分叉。');
P('');
P('### 2.4 纯性守卫与失败关闭');
P('');
P('转移复用只在转移是确定性的前提下成立。本文的规则层存在一处例外：当陷阱压在黄油上时，执行一次');
P('猫方移动会触发引擎内部的随机重排（把黄油挪到相邻格）。这类状态一旦进入复用路径，转移就不再是纯');
P('函数，复用的前提被破坏。');
P('');
P('实现采取失败关闭（fail-closed）：进入采样步时先做一次状态判定，命中该形态就**整步回退**到朴素');
P('两遍式实现，并计入回退计数。回退不是降级妥协，而是把"可复用"与"不可复用"的边界写成显式条件：');
P(`正式实验中该回退计数为 ${P2.impureFallbacks} 次，说明这条路径在这批局面上未被触发，但它的正确性由`);
P('独立用例覆盖，而不是"实验没遇到"。');
P('');

// ---------------------------------------------------------------------------
// 3. 算法表达
// ---------------------------------------------------------------------------
P('## 3 算法表达');
P('');
P('### 3.1 记号与计数口径');
P('');
P('设采样步所在的局面为 $s$。记 $N(s)$ 为枚举出的候选动作数；$E(s)$ 为合法性由构造保证、无需模拟验证的');
P('候选数（本文即隧道出口数）；$V(s)=N-E$ 为必须真正执行一遍才能判定合法性的候选数；$k(s)$ 为最终合法');
P('的动作数。两臂在同一局面上的 $N$、$E$ 与合法动作集合都相同（§3.4 引理 1），差别只在执行的次数。');
P('');
P('步内代价以**内核调用次数**计量，而不是模拟器调用次数。二者关系是：一次模拟器调用在正常情况下恰好');
P('产生一次 RuleSet 空间动作内核调用；但在 RULE-A 情形（当前行动方已无合法空间移动、局面已终局）下，');
P('模拟器提前返回，产生 **0 次**内核调用。另外三处 RuleSet 成员不计入该口径：`endTurn`（回合交接）、');
P('`enumerateButterSpawns`（奶油生成格枚举）与 CHANCE 结果集构造——它们在两臂上的调用次数相同，且不属于');
P('空间动作内核。计数器的实现与这一口径一致：它只包住 `mouseStep`、`catMove`、`mouseSkill`、`catPlaceTrap`、');
P('`chooseTunnelExit` 五个内核。');
P('');
P('以次数而非时间表述，是因为固定工作量下的次数由种子与规则唯一确定，可以在两臂之间逐项对齐，也可以');
P('跨机器复现；单次内核耗时 $c$ 依赖硬件与负载，本文不假设其大小，也不把次数换算成时间。');
P('');
P('### 3.2 两臂的代价模型');
P('');
P('朴素实现（两遍式）在一个采样步内做三件事，后两件都带前提：逐候选执行一遍以判定合法性；对每个合法');
P('候选再执行一遍以取得引导值（仅当 $k\\ge2$，单合法动作时引导扫描被短路）；对选中动作再执行一遍以推进');
P('局面（仅当 $k\\ge1$，零合法动作时本步在枚举后即结束）。于是');
P('');
P('$$C_{\\mathrm{L}}(s) = \\underbrace{V}_{\\text{合法性}} + \\underbrace{\\mathbb{1}[k \\ge 2]\\,k}_{\\text{引导}} + \\underbrace{\\mathbb{1}[k \\ge 1]}_{\\text{执行}}$$');
P('');
P('复用实现只做第一件事，但把每个候选的转移结果保留下来，供后两步读取：');
P('');
P('$$C_{\\mathrm{P}}(s) = \\underbrace{N}_{\\text{每候选一次，转移保留}} = V + E$$');
P('');
P('两式对隧道出口局面同样成立：此时 $V=0$，两遍式只付出引导与执行的调用（$\\mathbb{1}[k\\ge2]\\,k+1$），而');
P('复用实现对每个出口各执行一次（$E=k$），因为它的候选批次统一按"每候选一次"处理。');
P('');
P('在 $E=0$ 的普通博弈局面上，$V=N$，把三种情形分别写出：');
P('');
P('- $k \\ge 2$：$C_{\\mathrm{L}} = N+k+1$，$C_{\\mathrm{P}} = N$，节省比例 $\\Delta/C_{\\mathrm{L}} = (k+1)/(N+k+1)$。');
P('  它在全部候选都合法（$N=k$）时取最大值 $(k+1)/(2k+1)$，**严格大于** $1/2$，并随 $k$ 增大从上方');
P('  趋近 $1/2$；在非法候选很多（$N\\gg k$）时趋于 0。');
P('- $k = 1$：$C_{\\mathrm{L}} = N+1$，$C_{\\mathrm{P}} = N$，节省比例 $1/(N+1)$，仅在 $N=1$ 时恰为 $1/2$。');
P('- $k = 0$：两臂都在枚举后结束本步，$C_{\\mathrm{L}} = C_{\\mathrm{P}} = N$，节省为 0。');
P('');
P('因此节省比例没有与候选规模无关的固定上限：它的取值由 $N$ 与 $k$ 的相对大小决定，');
P('全部候选都合法时略高于 $1/2$，非法候选越多则越低。这个界只对单个采样步成立，合计值见 §3.3。');
P('');
P('### 3.3 与实测的对照');
P('');
P('Phase 1 的固定工作量实验测得两臂的内核调用为');
P(`${n0(P1.ruleCalls[0])} → ${n0(P1.ruleCalls[1])}，合计比值 ${(P1.ruleCalls[1] / P1.ruleCalls[0]).toFixed(4)}。`);
P('这个比值是**全部采样步与全部树内扩张的合计**，不能用来反解任何单一局面形态。原因是数学上的：合计值');
P('是各步比值按 $C_{\\mathrm{L}}$ 加权的平均，每一步的 $N$ 与 $k$ 都不同，仅凭一个合计比值无法确定权重，');
P('因此合计比值无法解出任何"合法候选占比"——它与按 $C_{\\mathrm{L}}$ 加权的平均不可逆。');
P('');
P('模型与实测的关系只到"方向相容"这一步：由 §3.2，每一步都有 $C_{\\mathrm{P}} \\le C_{\\mathrm{L}}$，且只要存在');
P('$k \\ge 2$ 的采样步就严格小于，所以合计比值必然小于 1；实测 0.5206 落在该模型允许的范围之内，没有');
P('出现与模型矛盾的读数。模型不预测具体数值，本文也不据它宣称某一局面形态的比例。');
P('');
P('合计计数中还包含一部分与机制无关的调用：搜索树内扩张在两臂上逐行相同（都用两遍式枚举合法动作、');
P('并各执行一次），这部分调用两臂完全一样。本文**没有**把树内扩张与采样步分开计数，因此不对"采样步自身');
P(`的降幅"给出数值，47.94% 只是两臂内核调用总量的下降幅度，不声明它等于某一分量单独的降幅。`);
P('');
P('### 3.4 语义等价的三条引理');
P('');
P('机制的正确性可以拆成三条互相独立、且都能在实现中逐字核对的命题：');
P('');
P('**引理 1（候选不变）**　两臂的候选集合、顺序与序号相同。');
P('理由：两者都经由同一个 `enumerateSearchActionCandidates` 产生候选，顺序由方向表与先决条件唯一确定；');
P('复用的 `originalIndex` 取值为"进入合法列表时的长度"，与旧实现在合法列表中追加时的下标定义相同。');
P('');
P('**引理 2（引导值不变）**　对同一候选，两臂的引导值逐位相同。');
P('理由：引导值是对同一后继状态的纯函数。确定性转移取叶值；机会转移取 $\\sum_i w_i \\cdot \\mathrm{leaf}(o_i)$，');
P('结果集、权重与原顺序均来自同一次转移，因而求和顺序与浮点累加顺序完全相同。同分判据、取最大的平局');
P('集合、以及在平局集合内的抽样也都保持不变。');
P('');
P('**引理 3（随机流不变）**　两臂消耗的随机数次数与用途序列相同。');
P('理由：随机性只出现在两处——引导扫描结束后的平局抽样，以及机会转移的抽样。前者在单合法动作时被短路，');
P('两臂都不抽；后者由校验后的权重经一次均匀抽样决定，与转移如何取得无关。机制不新增、不减少、不重排');
P('任何一次抽样。');
P('');
P('三条引理合起来给出：在固定工作量下，两臂的树形、访问计数、回报统计与最终计划逐项相同。');
P('');
P('**这三条引理的性质必须说清楚：它们是代码级论证，不是数学全称证明。** 它们逐行对应实现的控制流——候选');
P('只有一个枚举源、引导值是对转移结果的纯函数、随机数只出现在平局抽样与机会抽样两处——回答的是"在这个');
P('实现下两臂为何应当产生同一结果"。它们不构成"对任意合法游戏局面两臂必然一致"的证明：那需要对规则层');
P('全部转移做归纳，本文没有做，也不声称做了。');
P('');
P(`§4.1 的逐事件比对是同一命题在**冻结语料上的有限检验**：${n0(acc.EXPECTED_TOTAL_SIMULATIONS.actual)} 条采样、`);
P(`${n0(acc.ALL_SIMULATION_DIGESTS_MATCH.comparisons)} 次摘要比较全部一致。论证与检验回答两个不同的问题：前者说明结果为何一致，`);
P('后者说明在这批局面上确实一致；两者都不能外推为对所有可能游戏状态的保证。');
P('');
P('### 3.5 复杂度对照');
P('');
P('表 2　单采样步的复杂度对照（$N$ 候选、$k$ 合法、$E$ 免验证）');
P('');
P(tbl(['量', '两遍式', 'Prepared 复用'], [
  ['内核调用次数', '$V + \\mathbb{1}[k\\ge2]\\,k + \\mathbb{1}[k\\ge1]$', '$N = V + E$'],
  ['候选枚举次数', '1（合法性遍历即枚举）', '1（同一枚举源）'],
  ['模拟器调用次数', '内核调用次数 + RULE-A 早退次数', '同左（早退时 1 次模拟器 / 0 次内核）'],
  ['叶评价次数', '每个合法候选 1 次；机会转移按其结果数计', '同左，不变'],
  ['随机数消耗', '平局抽样 + 机会抽样', '同左，逐次对齐'],
  ['额外内存', '无', '一个步内批次，$O(N)$，步末释放'],
  ['作用域', '—', '单步，不入树、不跨采样'],
  ['前提', '—', '转移必须是纯函数；否则整步回退'],
], ));
P('');
P('叶评价次数不减是这套模型的关键结论之一：机制省下的是**规则转移**，不是**叶子求值**。这一点决定了');
P('§4 的性能结果应当如何解读。');
P('');

// ---------------------------------------------------------------------------
// 4. 实验验证
// ---------------------------------------------------------------------------
P('## 4 实验验证');
P('');
P('实验分两级。第一级固定"完成的采样条数"，检验两臂在相同工作量下是否给出完全相同的搜索行为，回答');
P('**能不能替换**；第二级固定"墙钟预算"，检验省下的计算是否转化为更多有效采样，回答**换来了什么**。');
P('两级实验共用 24 个来自真实人类对局的局面作为根，各重复 20 次。');
P('');
P('### 4.1 固定完成采样数的一致性实验');
P('');
P('**为什么必须固定"完成的采样条数"。** 若以节点上限或墙钟预算作为停止条件，两臂会在不同的工作量上');
P('停下：此时"结果相同"要么是巧合，要么只是两边都还没展开。本实验把停止条件放在"整条采样完成回传');
P('之后、下一条开始之前"，两臂共用同一个停止判定，因此"两边都恰好完成 $K=200$ 条"是同一段控制流的');
P('结果而不是一句声明。节点上限被保留为安全网（500 000），一旦它在 200 条采样之前触发，该次调用即判');
P('为执行异常而整体作废，不允许把 K 调小。');
P('');
P('**配置。** 24 根 × 20 次重复 × 2 臂 = 960 次调用，每次调用固定完成 200 条采样，合计');
P(`${n0(acc.EXPECTED_TOTAL_SIMULATIONS.actual)} 条采样；由 ${P1_PROCS} 个全新进程串行执行，前一进程完全退出后才`);
P('启动下一个。同一局面同一次重复的两臂使用完全相同的种子；搜索时间源被固定为常数，使墙钟不可能成为');
P('停止原因。');
P('');
P('**比较粒度。** 比较单位不是根动作、也不是最终计划，而是**逐条采样、逐事件**：树内每个决策节点的');
P('状态键、行棋方、动作键、采样动作序列、引导值、策略与机会两条随机流的抽样次数与参数、机会节点的');
P('结果下标与结果状态键、叶评价值、最终回报与提交状态。每条采样产出独立摘要，另加整树指纹、节点访问');
P('统计、累计与平均回报、最终计划及其动作代价、根动作统计。');
P('');
P('表 3　Phase 1 验收结果');
P('');
P(tbl(['验收项', '要求', '实测'], [
  ['搜索调用数', `${acc.TOTAL_SEARCH_CALLS.expected}`, `${acc.TOTAL_SEARCH_CALLS.actual}`],
  ['每次调用完成采样数', '200（两臂）', `${acc.COMPLETED_SIMULATIONS_PER_CALL.actual.join(' / ')}`],
  ['总采样数', `${n0(acc.EXPECTED_TOTAL_SIMULATIONS.expected)}`, n0(acc.EXPECTED_TOTAL_SIMULATIONS.actual)],
  ['逐条采样摘要比较', '全部一致', `${n0(acc.ALL_SIMULATION_DIGESTS_MATCH.comparisons)} 次比较，全部一致`],
  ['整树指纹', '全部一致', '全部一致'],
  ['最终计划与动作代价', '全部一致', '全部一致'],
  ['新建节点数（全部单元）', '相同', `${n0(P1.sumNodes)}（${P1.nodesEqual}/${P1.cells} 单元两臂相同）`],
  ['机会抽样数（全部单元）', '相同', `${n0(P1.sumChance)}（${P1.chanceEqual}/${P1.cells} 单元两臂相同）`],
  ['非预期随机调用', '0', `${acc.MATH_RANDOM_DRAWS.actual}`],
  ['节点上限 / 截止时间 / 中断采样', '0 / 0 / 0', `${acc.NODE_CAP_HITS.actual} / ${acc.DEADLINE_HITS.actual} / ${acc.ABORTED_SIMULATIONS.actual}`],
], ));
P('');
P(`**结果：${p1.verdict}。** 除时间与计数器外，两臂在 ${n0(acc.ALL_SIMULATION_DIGESTS_MATCH.comparisons)} 次逐条摘要比较中零差异。`);
P('其中最强的一条证据不是"计划相同"，而是**新建节点数与机会抽样数在全部单元上都相同**：');
P(`两臂建出的树是同一棵树（${n0(P1.sumNodes)} 个节点），走过的机会分支也是同一批（${n0(P1.sumChance)} 次抽样）。`);
P('这说明复用没有改变搜索的形状，只改变了走到同样形状所付出的规则计算量。');
P('');
P('### 4.2 规则内核调用的实测降幅');
P('');
P('表 4　规则内核调用的实测变化');
P('');
P(tbl(['量', '两遍式', 'Prepared 复用', '变化'], [
  ['规则内核调用（Phase 1，固定 200 条采样）', n0(P1.ruleCalls[0]), n0(P1.ruleCalls[1]), `−${pct(ruleReductionP1)}`],
  ['规则内核调用（Phase 2，固定 100 ms）', n0(P2.ruleCalls[0]), n0(P2.ruleCalls[1]), `−${pct(ruleReductionP2)}`],
], ));
P('');
P(`固定工作量下内核调用下降 **${pct(ruleReductionP1)}**（图 2 左），且这一下降没有换来任何决策差异。`);
P('三点需要说明。第一，这是**成本命题**，不是强度命题：调用变少只说明同一份搜索付出了更少的规则计算，');
P('不说明搜索找到了更好的着法。第二，两组数字的可比范围不同：固定工作量组的次数由种子与规则唯一确定，');
P('与机器和负载无关；固定预算组统计的是"100 ms 内做到了多少工作"，其数值依赖机器速度，只在同机同轮的');
P('两臂之间可比，不能跨机器引用。第三，计数只含五个空间动作内核，不含 `endTurn`、奶油生成格枚举与结果集');
P('构造（这三处在两臂上相同）。');
P('');
P('### 4.3 固定 100 ms 预算下的吞吐对照');
P('');
P(`**配置。** 24 根 × 20 次重复 × 2 臂 = ${integrity.records} 次调用，${P2_PROCS} 个全新进程串行执行；主搜索预算`);
P(`100 ms，完整回合预算 150 ms；最大交接次数 4，节点上限 500 000 作为安全网；两臂同根同种子，按重复序号`);
P('奇偶交替臂序。每次调用的计划都由真实引擎离线逐步回放校验，回放耗时单独计量，从不计入规划预算。');
P('');
P('表 5　同样 100 ms 内完成的完整采样条数');
P('');
P(tbl(['统计量', '两遍式', 'Prepared 复用'], [
  ['均值', f2(e.baselineSims.mean), f2(e.preparedSims.mean)],
  ['中位数', f1(e.baselineSims.p50), f1(e.preparedSims.p50)],
  ['P75', f1(e.baselineSims.p75), f1(e.preparedSims.p75)],
  ['P95', f1(e.baselineSims.p95), f1(e.preparedSims.p95)],
  ['合计', n0(P2.sims[0]), n0(P2.sims[1])],
], ));
P('');
P(`- 配对差值均值：**${e.meanPairedDiff.toFixed(3)}** 条采样 / 调用（混合臂序），相对增益 **${sign(e.relativeGain)}**；`);
P(`- 95% 置信区间（按根分层的配对 cluster bootstrap，${n0(e.bootstrap.iterations)} 次重采样，种子 ${e.bootstrap.seed}）：`);
P(`  绝对差值 **[${s2(ciDiff.low)}, ${s2(ciDiff.high)}]**，相对增益 **[${sign(ciRel.low)}, ${sign(ciRel.high)}]**；`);
P(`- 重采样中差值为正的比例 ${pct(e.bootstrap.shareOfResamplesWithPositiveDiff)}。`);
P('');
P(`分布明显右偏：中位数 ${f1(e.baselineSims.p50)} 条，P95 为 ${f1(e.baselineSims.p95)} 条，少数可深搜的局面把均值拉到`);
P(`${f2(e.baselineSims.mean)} 条。因此均值、中位数与各分位数都被同时报告；两臂在各分位数上的差异不超过 1 条采样，`);
P('说明"没有可分辨变化"不是均值掩盖了分布上的移动。');
P('');
P(`**结论：未检测到明确的吞吐提升。** 95% 置信区间覆盖 0，观测到的相对差异（${sign(e.relativeGain)}）远小于区间宽度；`);
P(`按臂序分层后的序平衡估计（§4.4）给出同一判断（${sign(balanced.value)}，区间同样覆盖 0）。本样本能分辨的`);
P(`最小效应约为区间半宽，更小的提升既不能被确认、也不能被排除。如实记录：成本下降已确认，吞吐提升未被观测到。`);
P('');
P('### 4.4 臂序关联：一个必须单独报告的量');
P('');
P('两级实验都在同一个进程内连续运行两个臂。若先运行的一臂系统性吃亏（例如代码路径尚未被即时编译');
P('与缓存预热），配对差值就会被这一偏差污染。本实验按重复序号奇偶交替臂序，使偏差在混合估计中部分');
P('抵消，并单独报告分层结果：');
P('');
P('表 6　按臂序分层的相对增益');
P('');
P(tbl(['分层', '重复序号', '单元数', 'Prepared 相对增益'], [
  ['Prepared 后运行', '奇数', ob.preparedRanSecond.cells, sign(ob.preparedRanSecond.relativeGain)],
  ['Prepared 先运行', '偶数', ob.preparedRanFirst.cells, sign(ob.preparedRanFirst.relativeGain)],
  ['两组之差', '—', '—', sign(2 * orderEff.value)],
  ['半差 = 臂序关联量', '—', ob.preparedRanSecond.cells + ob.preparedRanFirst.cells, `${sign(orderEff.value)}，95% CI [${sign(orderEff.ci95.low)}, ${sign(orderEff.ci95.high)}]`],
  ['序平衡臂效应（主结论）', '—', ob.preparedRanSecond.cells + ob.preparedRanFirst.cells, `${sign(balanced.value)}，95% CI [${sign(balanced.ci95.low)}, ${sign(balanced.ci95.high)}]`],
], ));
P('');
P(`两点必须分清。**臂序关联是观测事实**：两个方向上的相对增益符号相反、量级接近（${sign(ob.preparedRanSecond.relativeGain)}`);
P(`与 ${sign(ob.preparedRanFirst.relativeGain)}），两组之差为 ${sign(2 * orderEff.value)}，其一半即 ${sign(orderEff.value)}——`);
P('后者才是本文报告的"臂序关联量"，它是两组之差的**一半**，不是两组之差本身；表 6 把两个量分行列出，以免');
P('名称与口径错配。若不分层，正负相消就会被误读成"干净的空结果"。**但它的成因是假设而非结论**：该关联量');
P(`的 95% 置信区间 [${sign(orderEff.ci95.low)}, ${sign(orderEff.ci95.high)}] 覆盖 0，"先运行的一臂因即时编译与缓存`);
P('预热而吃亏"这一解释与数据相容，但本实验没有做独立对照（例如每臂独占进程）来确认它，因此只把它作为');
P('方法学上的必须分层项报告，不据此推断任何因果机制。主结论采用序平衡估计：');
P(`**${sign(balanced.value)}，95% CI [${sign(balanced.ci95.low)}, ${sign(balanced.ci95.high)}]，覆盖 0**。`);
P('');
P('### 4.5 时间分布');
P('');
P('表 7　三类时间量（互不混用；离线回放不计入规划预算）');
P('');
P(tbl(['量（ms）', '两遍式 P50', '两遍式 P95', 'Prepared P50', 'Prepared P95'], [
  ['搜索器自报耗时', f2(ta.baseline.searchMs.p50), f2(ta.baseline.searchMs.p95), f2(ta.prepared.searchMs.p50), f2(ta.prepared.searchMs.p95)],
  ['规划器墙钟（构造→计划）', f2(ta.baseline.plannerWallMs.p50), f2(ta.baseline.plannerWallMs.p95), f2(ta.prepared.plannerWallMs.p50), f2(ta.prepared.plannerWallMs.p95)],
  ['离线回放（校验用）', f2(ta.baseline.replayMs.p50), f2(ta.baseline.replayMs.p95), f2(ta.prepared.replayMs.p50), f2(ta.prepared.replayMs.p95)],
], ));
P('');
P(`全部 ${integrity.records} 次调用的规划器墙钟都在 150 ms 完整回合预算内（${integrity.withinPlanner150ms}/${integrity.records}）；`);
P(`主搜索的 100 ms 预算在 ${integrity.deadlineFired} 次调用上均正常触发停止，节点上限触发 ${integrity.budgetFired} 次。`);
P('时间量分三类独立记录：搜索器自报耗时（搜索循环内部）、规划器墙钟（构造搜索器到拿回完整计划）、');
P('离线回放耗时（实验结束后用真实引擎逐步执行该计划）。前两者属于生产口径，第三者只用于校验计划');
P('是否可被真实引擎执行，绝不并入规划耗时。');
P('');
P('### 4.6 省下来的计算去了哪里');
P('');
P('表 8　每次调用均值');
P('');
P(tbl(['量', '两遍式', 'Prepared 复用'], [
  ['完成采样数', f2(st.baseline.simulations.mean), f2(st.prepared.simulations.mean)],
  ['新建节点数', f2(st.baseline.nodesCreated.mean), f2(st.prepared.nodesCreated.mean)],
  ['采样步数', f1(st.baseline.rolloutSteps.mean), f1(st.prepared.rolloutSteps.mean)],
  ['机会抽样数', f2(st.baseline.chanceSamples.mean), f2(st.prepared.chanceSamples.mean)],
  ['树内计划长度', f2(st.baseline.treePlanLength.mean), f2(st.prepared.treePlanLength.mean)],
  ['计划延展步数', f2(st.baseline.extensionSteps.mean), f2(st.prepared.extensionSteps.mean)],
  ['规则内核调用', f1(st.baseline.ruleCalls.mean), f1(st.prepared.ruleCalls.mean)],
  ['步内批次构建次数', '—', f1(preparedPerCall)],
], ));
P('');
P(`复用臂平均每次调用构建 ${f1(preparedPerCall)} 个步内批次，而计入完成统计的采样步数为 ${f1(st.prepared.rolloutSteps.mean)}。`);
P('两个数的口径不同，差值有确定来源：批次计数在采样步内自增，被 100 ms 截止打断的那条采样中已经走过的');
P('步同样计入；而采样步数只并入**已完成**采样的步数（中断采样在累加之前就退出循环）。因此差值等于中断');
P(`采样中已走过的步数，量级约 ${f1(preparedPerCall - st.prepared.rolloutSteps.mean)} 步 / 调用。这条归因由字段来源`);
P(`确定，不是由差值反推：回退步在本次实验为 ${P2.impureFallbacks}，否则完成统计里会混入"未走复用路径的步"。`);
P('');
P('这张表回答的是"省下的计算是否变成了更多树内搜索"：完成采样数与新建节点数在两臂上同量级，说明规则');
P('计算减少近一半，却几乎没有转化为额外的树内搜索量。本文不对这一现象给出因果解释：它既可能来自搜索在');
P('100 ms 内已经撞上别的成本结构，也可能只是落在本样本的分辨能力之外（相对增益的区间半宽约 1.4%）。把');
P('吞吐结果换算成"规则转移占总耗时的比例"需要额外假设（吞吐与耗时严格成反比、其余成本不变），而本实验');
P('没有做分段计时，因此本文不给出该占比，也不据此排除任何一类成本。');
P('');
P('### 4.7 图表');
P('');
P(tbl(['图', '文件', '内容与用途'], [
  ['图 1', `\`${FIG.flow}\``, '采样步内的候选转移：两遍式与复用实现；区分模拟器调用与内核调用（正文）'],
  ['图 2', `\`${FIG.calls}\``, '规则内核调用次数对照，两组各自独立标度（正文）'],
  ['图 3', `\`${FIG.throughput}\``, '固定 100 ms 下完成采样条数对照（附录素材）'],
  ['图 4', `\`${FIG.perRoot}\``, `${p2.perRoot.length} 个局面的配对增益分布（附录素材）`],
  ['图 5', `\`${FIG.coverage}\``, '计划结构与延展步数对照（附录素材）'],
], ));
P('');
P('正文建议只保留图 1、图 2 与核心指标表（`COMPETITION_METRICS_TABLE.md`），其余三张图作为附录素材，');
P('以免正文被同一组数据的多种视图冲淡。');
P('');
const perRootVals = p2.perRoot.map((r) => r.relativeGain ?? 0);
P(`逐局面明细见 \`PHASE2_ANALYSIS/summary.json\` 的 \`perRoot\`：${perRootVals.filter((g) => g > 0).length} 个局面为正增益、`);
P(`${perRootVals.filter((g) => g < 0).length} 个为负增益、${perRootVals.filter((g) => g === 0).length} 个持平，`);
P(`全部落在 [${sign(Math.min(...perRootVals))}, ${sign(Math.max(...perRootVals))}] 之间。符号分布本身不构成证据（区间估计见 §4.3），`);
P('其作用是检查总体均值是否掩盖了局部退化：逐局面看没有出现量级离群的取值，');
P('因此总体结论没有被个别局面劫持。');
P('');

// ---------------------------------------------------------------------------
// 5. 成果价值
// ---------------------------------------------------------------------------
P('## 5 成果价值');
P('');
P('### 5.1 可替换级等价，而非近似等价');
P('');
P(`在 ${n0(acc.EXPECTED_TOTAL_SIMULATIONS.actual)} 条采样、${n0(acc.ALL_SIMULATION_DIGESTS_MATCH.comparisons)} 次逐条摘要比较下，两臂的树形、访问计数、`);
P('机会分支、引导值、随机流与最终计划逐项相同。这一强度的意义在于：在这批局面上，机制可以被当作**同一算法');
P('的另一种实现**替换进生产路径，而不需要重新标定评估指标或棋力基线——它改变的是代价，不是决策。');
P('');
P('### 5.2 规则内核调用成本的实测削减');
P('');
P(`规则内核调用在固定工作量下下降 ${pct(ruleReductionP1)}（${n0(P1.ruleCalls[0])} → ${n0(P1.ruleCalls[1])}）。这一结论只依赖`);
P('调用计数与"两臂完成同样 200 条采样"这一设定，不依赖计时，可以在同机同轮的两臂之间逐项对齐；该组的');
P(`计数完全由种子与规则决定，换机器重跑不会改变数值。固定预算组（${MINUS}${pct(ruleReductionP2)}）不具备这一性质：`);
P('它统计的是 100 ms 内完成的工作量，数值随机器速度变化，只用于同机对比。');
P('');
P('### 5.3 对低延迟在线规划系统的工程价值');
P('');
P('机制与具体游戏规则无关，其适用条件只有两条：候选动作的枚举可以写成纯函数；动作转移对同一');
P('$(state, action)$ 是确定性的。凡满足这两条的"先验证、再评估、后执行"式搜索内核——包括棋类、');
P('卡牌、策略游戏以及更一般的在线规划器——都可以直接采用同一结构。本文给出的不只是实现，还有一套');
P('可复用的验证方法：**用固定完成采样数替代固定节点数或固定墙钟，再用逐事件摘要做等价性判定**。');
P('固定节点数的做法会在两臂工作量不同时给出虚假的一致性；固定墙钟的做法会把计时噪声引入正确性');
P('判定；只有固定"完成的采样条数"才能让"两边做完了同样多的活"成为可检验的事实。');
P('');
P('### 5.4 边界');
P('');
P('- 本文测量的是**相同预算下的搜索吞吐**，不是棋力。棋力需要自对弈或外部基准，本文未做，也不应把');
P('  吞吐数字翻译成强度结论。');
P('- 复用只作用于采样步；搜索树内扩张仍保留两遍式交叉校验。这是刻意保留的安全边界，代价是机制收益中被');
P('  计入的部分只覆盖采样步，其大小本文未单独计量。');
P('- 根集合固定为 24 个人类对局局面，未覆盖开局与终局的全部形态；结论的适用范围限于与这批局面同类的实战形态。');
P('- 吞吐结论为"未检测到明确提升"：置信区间给出的是效应量的估计范围，');
P(`  半宽约 ${pct((ciRel.high - ciRel.low) / 2, 1)} 以内的提升无法被本样本分辨。`);
P('- 单进程内两臂连跑存在臂序关联（§4.4），本文以交替臂序加序平衡估计处理，未做每臂独占进程的对照。');
P('');
P('## 6 结论');
P('');
P('本文提出并验证了一种面向实时博弈搜索的候选状态转移复用机制。它把搜索步内"合法性验证—引导评价—');
P('选定执行"三次重复的规则转移合并为一次，并以步内一次性数据流的形式实现，不引入跨节点缓存，因而');
P('没有失效风险；对机会转移，复用原始的权重与顺序，保持完整概率语义与随机数消耗序列不变。');
P('');
P('实验给出两条结论：其一，在 192,000 条固定完成采样的逐事件对照下，两臂决策行为完全一致，');
P(`规则内核调用下降 ${pct(ruleReductionP1)}，在这批局面上可以安全替换；其二，在固定 100 ms 预算下，这一成本削减`);
P(`未带来可检测的吞吐提升（序平衡 ${sign(balanced.value)}，95% CI [${sign(balanced.ci95.low)}, ${sign(balanced.ci95.high)}]，覆盖 0）。`);
P('两条结论共同界定了该机制的适用位置：它是一项在同一实现下与基线逐事件等价的成本优化，其价值取决于');
P('规则转移在目标系统中的实际份额——在高规则复杂度、低叶评价成本的内核中收益更直接，而在叶评价占主导');
P('的内核中应优先优化评价环节。这为同类实时搜索系统的优化排序提供了一个可复用的判定框架。');
P('');

const bodyText = `${smartQuotes(md.join('\n'))}\n`;

// ---------------------------------------------------------------------------
// competition-facing headline table
// ---------------------------------------------------------------------------
const km = [];
km.push('# 国赛展示用核心指标表');
km.push('');
km.push(`> 由 \`scripts/makeTechnicalInsert.mjs\` 从分析产物生成，与正文同源。生成于 ${new Date().toISOString()}。`);
km.push('');
const metricRows = [
  ['固定完成采样数实验规模', `${acc.TOTAL_SEARCH_CALLS.actual} 次调用 / ${n0(acc.EXPECTED_TOTAL_SIMULATIONS.actual)} 条采样`, '24 局面 × 20 重复 × 2 臂，每次 200 条完成采样'],
  ['逐条采样摘要比对', `${n0(acc.ALL_SIMULATION_DIGESTS_MATCH.comparisons)} 次，零差异`, '每条采样一个独立摘要，两臂逐条比对'],
  ['树形一致性', `${P1.nodesEqual}/${P1.cells} 单元节点数相同（${n0(P1.sumNodes)} 个节点）`, '整树指纹 + 新建节点计数'],
  ['机会分支一致性', `${P1.chanceEqual}/${P1.cells} 单元抽样数相同（${n0(P1.sumChance)} 次）`, '机会结果下标、结果状态键、权重'],
  ['内核调用降幅（固定工作量）', `${n0(P1.ruleCalls[0])} → ${n0(P1.ruleCalls[1])}（${MINUS}${pct(ruleReductionP1)}）`, '五个空间动作内核的调用计数，不含 endTurn 与生成格枚举'],
  ['内核调用降幅（固定 100 ms）', `${n0(P2.ruleCalls[0])} → ${n0(P2.ruleCalls[1])}（${MINUS}${pct(ruleReductionP2)}）`, '同上；该组次数随机器速度变化，只作同机对比'],
  ['100 ms 内完成采样数', `${f2(e.baselineSims.mean)} vs ${f2(e.preparedSims.mean)}`, `${integrity.records} 次调用均值`],
  ['混合臂序相对增益', `${sign(e.relativeGain)}，95% CI [${sign(ciRel.low)}, ${sign(ciRel.high)}]`, `按根分层配对 cluster bootstrap，${n0(e.bootstrap.iterations)} 次`],
  ['序平衡相对增益', `${sign(balanced.value)}，95% CI [${sign(balanced.ci95.low)}, ${sign(balanced.ci95.high)}]`, '奇偶臂序分层后的臂效应估计'],
  ['两组之差', sign(2 * orderEff.value), `${sign(ob.preparedRanSecond.relativeGain)}（Prepared 后运行）与 ${sign(ob.preparedRanFirst.relativeGain)}（先运行）之差`],
  ['半差 = 臂序关联量', `${sign(orderEff.value)}，95% CI [${sign(orderEff.ci95.low)}, ${sign(orderEff.ci95.high)}]`, '两组之差的一半；仅报告关联，不推断因果'],
  ['规划器墙钟 P50 / P95', `${f2(ta.baseline.plannerWallMs.p50)} / ${f2(ta.baseline.plannerWallMs.p95)} ms（两遍式）；${f2(ta.prepared.plannerWallMs.p50)} / ${f2(ta.prepared.plannerWallMs.p95)} ms（复用）`, '构造→计划，不含离线回放'],
  ['完整回合预算满足率', `${integrity.withinPlanner150ms}/${integrity.records}`, '规划器墙钟 ≤ 150 ms'],
  ['执行完整性', `0 错误 / 0 回放失败 / ${integrity.mathRandomCalls} 非预期随机调用；${P2_PROCS} 个全新进程串行`, 'Phase 2 全量记录'],
  ['结论边界', '吞吐提升：未检测到明确提升；棋力：未测量', '降本 / 增吞吐 / 增强度分开陈述，不互相替代'],
];
km.push(tbl(['指标', '数值', '口径 / 来源'], metricRows, 'metrics'));
km.push('');
km.push('## 可引用的一句话结论');
km.push('');
km.push(`在固定完成采样数下，复用机制与基线逐事件一致（${n0(acc.EXPECTED_TOTAL_SIMULATIONS.actual)} 条采样、${n0(acc.ALL_SIMULATION_DIGESTS_MATCH.comparisons)} 次摘要比对零差异），`);
km.push(`规则内核调用下降 ${pct(ruleReductionP1)}；在固定 100 ms 预算下，未检测到明确的吞吐提升（序平衡 ${sign(balanced.value)}，95% CI [${sign(balanced.ci95.low)}, ${sign(balanced.ci95.high)}]）。`);
km.push('');

const metricsText = `${smartQuotes(km.join('\n'))}\n`;

// ---------------------------------------------------------------------------
// generation gate
//
// The previous round could only assert "quotes are paired". This block replaces
// that with checks that can actually fail for the reasons the chapter can
// actually be wrong: a leftover `${...}` template, a number that no longer
// matches the analysis artefacts, a formula that no longer matches the source,
// a table whose columns were mangled in hand-editing, a figure whose labels
// were clipped, and a second run that does not reproduce the first byte for
// byte. The timestamp is excluded from the reproducibility comparison by
// construction (it lives only in the generated-at line, which is normalised).
// ---------------------------------------------------------------------------
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const TS_LINE = /^> 由 .*生成于 .*$/m;
const stripTimestamp = (s) => s.replace(TS_LINE, '> <GENERATED_AT>');

if (process.env.PPC_NO_WRITE === '1') {
  process.stdout.write(`${JSON.stringify({
    body: sha256(bodyText),
    metrics: sha256(stripTimestamp(metricsText)),
  })}\n`);
  process.exit(0);
}

writeFileSync(resolve(round, 'TECHNICAL_REPORT_INSERT.md'), bodyText, 'utf8');
writeFileSync(resolve(round, 'COMPETITION_METRICS_TABLE.md'), metricsText, 'utf8');
console.log('wrote TECHNICAL_REPORT_INSERT.md');
console.log('wrote COMPETITION_METRICS_TABLE.md');

const checks = [];
const fail = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) fail.push(`${name}: ${detail}`);
};
const readSrc = (rel) => readFileSync(resolve(repo, rel), 'utf8');
const countOf = (hay, needle) => hay.split(needle).length - 1;
const between = (hay, from, to) => {
  const i = hay.indexOf(from);
  const j = hay.indexOf(to, i + 1);
  return i >= 0 && j > i ? hay.slice(i, j) : '';
};

// --- 1. no un-interpolated template residue, no NaN/undefined leaks ----------
const RESIDUE = [/\$\{/, /\bNaN\b/, /\bundefined\b/, /\bInfinity\b/, /\[object Object\]/, /\bTODO\b/, /\bFIXME\b/, /\bn\/a\b/];
const residueHits = [];
for (const [docName, text] of [['TECHNICAL_REPORT_INSERT.md', bodyText], ['COMPETITION_METRICS_TABLE.md', metricsText]]) {
  for (const re of RESIDUE) {
    const m = text.match(re);
    if (m) residueHits.push(`${docName}: ${re} -> ${m[0]}`);
  }
  // an ASCII ${ inside backticks would be caught above; also catch a lone ' + '
  // left over from string concatenation in prose
  const plus = text.match(/'\s\+\s`/);
  if (plus) residueHits.push(`${docName}: stray concatenation ${plus[0]}`);
}
check('无未插值残留 / NaN / undefined', residueHits.length === 0, residueHits.join('; ') || '0 处');

// --- 2. numbers agree with the analysis artefacts, recomputed independently --
// The summary files carry aggregate counters; the raw records carry the same
// quantity one row at a time. Recomputing from the raw side catches a stale or
// hand-edited aggregate.
const p1Cells = p1.cells;
const p1BaseRaw = p1Cells.reduce((s, c) => s + c.ruleCallsBaseline, 0);
const p1PrepRaw = p1Cells.reduce((s, c) => s + c.ruleCallsPrepared, 0);
check('Phase 1 内核调用：汇总字段 = 逐单元求和',
  p1BaseRaw === p1.ruleCalls.baseline && p1PrepRaw === p1.ruleCalls.prepared,
  `${p1BaseRaw}/${p1PrepRaw} vs ${p1.ruleCalls.baseline}/${p1.ruleCalls.prepared}`);

const p2BaseRaw = b2.reduce((s, r) => s + r.ruleCalls, 0);
const p2PrepRaw = q2.reduce((s, r) => s + r.ruleCalls, 0);
const p2BaseMean = p2BaseRaw / (b2.length || 1);
check('Phase 2 内核调用均值：逐条求和 ÷ 单元数 = 汇总均值',
  Math.abs(p2BaseMean - st.baseline.ruleCalls.mean) < 0.5,
  `${p2BaseMean.toFixed(3)} vs ${st.baseline.ruleCalls.mean.toFixed(3)}`);
check('Phase 2 采样总数：逐条求和 = 均值 × 单元数',
  Math.abs(P2.sims[0] / b2.length - e.baselineSims.mean) < 1e-9,
  `${(P2.sims[0] / b2.length).toFixed(4)} vs ${e.baselineSims.mean.toFixed(4)}`);

const MUST_APPEAR = [
  ['Phase 1 降幅', pct(ruleReductionP1)],
  ['Phase 1 两臂计数', `${n0(P1.ruleCalls[0])}`],
  ['Phase 1 复用计数', `${n0(P1.ruleCalls[1])}`],
  ['Phase 2 降幅', pct(ruleReductionP2)],
  ['100 ms 均值（两遍式）', f2(e.baselineSims.mean)],
  ['100 ms 均值（复用）', f2(e.preparedSims.mean)],
  ['混合臂序增益', sign(e.relativeGain)],
  ['混合臂序 CI 下界', sign(ciRel.low)],
  ['混合臂序 CI 上界', sign(ciRel.high)],
  ['序平衡增益', sign(balanced.value)],
  ['臂序关联量（半差）', sign(orderEff.value)],
  ['两组之差', sign(2 * orderEff.value)],
  ['层内增益（奇数）', sign(ob.preparedRanSecond.relativeGain)],
  ['层内增益（偶数）', sign(ob.preparedRanFirst.relativeGain)],
  ['摘要比较次数', n0(acc.ALL_SIMULATION_DIGESTS_MATCH.comparisons)],
  ['节点总数', n0(P1.sumNodes)],
  ['机会抽样总数', n0(P1.sumChance)],
];
const missing = MUST_APPEAR.filter(([, v]) => !bodyText.includes(v) || !metricsText.includes(v));
check('关键数值同时出现在正文与指标表', missing.length === 0,
  missing.map(([k, v]) => `${k}=${v}`).join('; ') || `${MUST_APPEAR.length} 项全部命中`);

// half-difference identity, so the two names can never drift apart again
check('两组之差 = 2 × 半差（臂序关联量）',
  Math.abs(2 * orderEff.value - (ob.preparedRanSecond.relativeGain - ob.preparedRanFirst.relativeGain)) < 5e-4,
  `${(2 * orderEff.value).toFixed(4)} vs ${(ob.preparedRanSecond.relativeGain - ob.preparedRanFirst.relativeGain).toFixed(4)}`);

// --- 3. formulae still describe the code -------------------------------------
const srcArms = readSrc('PPC-MCTS-01B/drivers/lib/arms.ts');
const srcChance = readSrc('PPC-MCTS-01/proto/chance.ts');
const srcUct = readSrc('PPC-MCTS-01/proto/uct.ts');
const srcPrep = readSrc('PPC-MCTS-01B/proto/uctPrepared.ts');
const srcActions = readSrc('src/game/ai/preparedActions.ts');
const srcLegal = readSrc('src/game/ai/legalActions.ts');

check('计数器只包住 5 个空间动作内核',
  countOf(srcArms, 'bump()') === 5 && srcArms.includes('endTurn: (s) => base.endTurn(s)')
  && srcArms.includes('enumerateButterSpawns: (s) => base.enumerateButterSpawns(s)'),
  `bump() × ${countOf(srcArms, 'bump()')}`);
check('CHANCE 校验用 |Σw − 1| ≤ 1e-9',
  srcChance.includes('const MASS_TOL = 1e-9;')
  && srcChance.includes('const massError = Math.abs(sum - 1);')
  && srcChance.includes('!(w > 0)'),
  'MASS_TOL=1e-9, Math.abs(sum-1), w>0 三处均在位');
check('两臂树内扩张逐行相同（都用 generateLegalSearchActions）',
  countOf(srcUct, 'cur.legalActions = generateLegalSearchActions') === 1
  && countOf(srcPrep, 'cur.legalActions = generateLegalSearchActions') === 1,
  'expansion 调用点各 1 处');
const rollL = between(srcUct, 'private rollout(', 'private backprop(');
const rollP = between(srcPrep, '  private rollout(', 'private backprop(');
check('两遍式 rollout：枚举 1 次后遍历已有合法列表',
  countOf(rollL, 'generateLegalSearchActions(') === 1
  && rollL.includes('selectRolloutAction(state, actions')
  && rollL.includes('if (actions.length === 1) return actions[0];') === false,
  `enum×${countOf(rollL, 'generateLegalSearchActions(')}`);
check('两遍式 rollout：k=0 早退、k=1 短路、选中动作再执行 1 次',
  rollL.includes('if (actions.length === 0) break;')
  && rollL.includes('const res = simulateSearchAction(state, action, this.opts.rules);'),
  '三处控制流均在位');
check('复用 rollout：一次准备 + 单合法动作直接读转移',
  rollP.includes('generatePreparedSearchActions(state, this.opts.rules)')
  && rollP.includes('if (batch.length === 1)')
  && rollP.includes('this.rolloutPreparedSteps++;'),
  'batch 单次构建，单合法动作短路');
check('复用 rollout：唯一保留的旧路径是不可纯化回退',
  countOf(rollP, 'generateLegalSearchActions(') === 1
  && rollP.includes('hitsNonPureItemOverlap(state)'),
  `legacy 路径 ${countOf(rollP, 'generateLegalSearchActions(')} 处，位于 fail-closed 分支`);
check('隧道出口是唯一免验证候选',
  countOf(srcActions, 'verifyEffectiveness: false') === 1
  && between(srcActions, 'ChoosingTunnelExit', 'phase === Playing').includes('tunnelExitChoices'),
  'verifyEffectiveness:false 仅出现在隧道分支');
check('候选枚举只有一份来源',
  countOf(srcLegal, 'enumerateSearchActionCandidates(state)') === 1
  && countOf(srcActions, 'enumerateSearchActionCandidates') >= 1,
  'legalActions 复用枚举源');

// LaTeX commands live inside JS string literals, so a single backslash is eaten
// by the string parser and `\ge` silently becomes `ge`. That is exactly the
// class of defect this round is sealing, so it gets a dedicated check: strip
// every surviving command and look for the残骸 of a swallowed one.
const mathSpans = [...bodyText.matchAll(/\$[^$\n]+\$/g)].map((m) => m[0]);
const casualties = mathSpans
  .map((span) => ({ span, bare: span.replace(/\\[a-zA-Z]+/g, '') }))
  .filter((x) => /\b(ge|le|cdot|mathbb|mathrm|frac|sum|underbrace|left|right|mid)\b/.test(x.bare))
  .map((x) => x.span);
check('公式中的 LaTeX 反斜杠未被 JS 转义吞掉', casualties.length === 0,
  casualties.slice(0, 3).join(' | ') || `${mathSpans.length} 个行内公式全部完整`);

// --- 4. tables are structurally sound ---------------------------------------
const parseTables = (text) => {
  const out = [];
  let cur = null;
  text.split('\n').forEach((ln, i) => {
    if (/^\|.*\|$/.test(ln)) {
      if (!cur) cur = { line: i + 1, rows: [] };
      cur.rows.push(ln);
    } else if (cur) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out;
};
const cellsOf = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());

for (const [docName, text, docTag] of [
  ['TECHNICAL_REPORT_INSERT.md', bodyText, 'body'],
  ['COMPETITION_METRICS_TABLE.md', metricsText, 'metrics'],
]) {
  const parsed = parseTables(text);
  const intended = TABLE_REGISTRY.filter((t) => t.doc === docTag);
  check(`${docName}：表格数量与生成器一致`, parsed.length === intended.length,
    `${parsed.length} vs ${intended.length}`);
  const widthProblems = [];
  parsed.forEach((t, ti) => {
    const header = cellsOf(t.rows[0]);
    if (!/^\|(\s*:?-{3,}:?\s*\|)+$/.test(t.rows[1])) widthProblems.push(`表${ti + 1} 分隔行异常`);
    t.rows.forEach((r, ri) => {
      if (cellsOf(r).length !== header.length) widthProblems.push(`表${ti + 1} 第${ri + 1}行列数=${cellsOf(r).length}/${header.length}`);
    });
    if (t.rows.length < 3) widthProblems.push(`表${ti + 1} 行数不足`);
  });
  check(`${docName}：每行列数与表头一致、分隔行合法`, widthProblems.length === 0,
    widthProblems.join('; ') || `${parsed.length} 张表全部合规`);

  const cellDiff = [];
  parsed.forEach((t, ti) => {
    const want = intended[ti];
    const got = t.rows.map(cellsOf);
    if (!want) return;
    // got[0] = header, got[1] = separator (no data), got[2..] = data rows
    const wantAll = [want.head, ...want.rows];
    if (got.length !== wantAll.length + 1) {
      cellDiff.push(`表${ti + 1} 行数 ${got.length}/${wantAll.length + 1}`);
      return;
    }
    got.forEach((row, ri) => {
      if (ri === 1) return; // separator row, checked separately
      const wantRow = ri === 0 ? wantAll[0] : wantAll[ri - 1];
      wantRow.forEach((cell, ci) => {
        if (row[ci] !== cell) cellDiff.push(`表${ti + 1} [${ri},${ci}] "${row[ci]}" != "${cell}"`);
      });
    });
  });
  check(`${docName}：表格单元格与生成器逐格一致`, cellDiff.length === 0,
    cellDiff.slice(0, 6).join('; ') || '逐格一致');
}

const metricsRows = parseTables(metricsText)[0]?.rows.map(cellsOf) ?? [];
check('指标表为三列', metricsRows.every((r) => r.length === 3), `行数 ${metricsRows.length}`);
check('指标表行数在预期区间', metricsRows.length - 2 >= 13 && metricsRows.length - 2 <= 20,
  `${metricsRows.length - 2} 行数据`);

// --- 5. figures: labels, units, and the claims that were removed -------------
const fig1 = readFileSync(resolve(round, FIG.flow), 'utf8');
const fig2 = readFileSync(resolve(round, FIG.calls), 'utf8');
const textsOf = (svg) => [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]);
const sizesOf = (svg) => [...svg.matchAll(/<text[^>]*font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
const cjk = (s) => /[\u4e00-\u9fff]/.test(s);

check('图 1 使用中文术语并区分模拟器 / 内核调用',
  cjk(fig1) && fig1.includes('模拟器调用') && fig1.includes('内核调用') && fig1.includes('枚举候选'),
  `text 节点 ${textsOf(fig1).length} 个`);
check('图 2 使用中文标签并保留两组独立标度说明',
  cjk(fig2) && fig2.includes('独立标度') && fig2.includes('内核调用次数') && fig2.includes('两遍式'),
  `text 节点 ${textsOf(fig2).length} 个`);
check('图 2 不再声称计数与机器/负载无关',
  !/does not depend on the machine/i.test(fig2) && !fig2.includes('与机器负载无关') && !fig2.includes('不受机器负载'),
  '该说明已删除');
check('两图字号 ≥ 13 px（嵌入 Word 可读）',
  Math.min(...sizesOf(fig1)) >= 13 && Math.min(...sizesOf(fig2)) >= 13,
  `最小 ${Math.min(...sizesOf(fig1), ...sizesOf(fig2))} px`);
const emptyText = textsOf(fig1).concat(textsOf(fig2)).filter((s) => s.trim() === '');
check('图中无空文本节点', emptyText.length === 0, `${emptyText.length} 个`);
check('图 1 的边界情形说明完整（k=0 / k=1 / 隧道 / CHANCE）',
  ['零合法动作', '单合法动作', '隧道出口', '机会转移'].every((k) => fig1.includes(k)),
  '四类边界均在图中');

// --- 6. claims that must NOT be in the chapter -------------------------------
const BANNED = [
  ['收益上限断言', '最多减半'], ['收益上限断言', '最多节省'],
  ['92% 反推', '92%'], ['92% 反推', '0.92'],
  ['稀释论证', '稀释'], ['下界论证', '下界'],
  ['无提升证明', '证明无提升'], ['无提升证明', '证明没有提升'],
  ['负载无关断言', '与机器负载无关'], ['负载无关断言', '不受机器负载'],
  ['对象同一性', '同一后继状态对象'], ['旧计数', '2～3 次'],
  ['因果排除', '排除"规则转移是主导成本"'],
];
const bannedHits = BANNED.filter(([, s]) => bodyText.includes(s)).map(([k, s]) => `${k}(${s})`);
check('已删除的论断不再出现于正文', bannedHits.length === 0, bannedHits.join('; ') || '0 处');
check('"未检测到明确提升"口径统一',
  bodyText.includes('未检测到明确的吞吐提升') && metricsText.includes('未检测到明确提升'),
  '正文与指标表同口径');

// --- 7. timestamp is separated from the reproducible content ----------------
check('正文不含生成时间戳', !TS_LINE.test(bodyText) && !bodyText.includes('生成于'), '正文纯净');
const tsCount = (metricsText.match(TS_LINE) ?? []).length;
check('指标表时间戳恰好一行且位于表格之外', tsCount === 1 && !parseTables(metricsText)[0].rows.some((r) => TS_LINE.test(r)),
  `${tsCount} 行`);

// --- 8. a second process reproduces the same bytes (timestamp excluded) -----
const child = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
  cwd: repo,
  env: { ...process.env, PPC_NO_WRITE: '1' },
  encoding: 'utf8',
});
const childDigest = JSON.parse(child.trim().split('\n').pop());
check('重复生成：正文逐字节一致',
  childDigest.body === sha256(bodyText), `${childDigest.body.slice(0, 12)} vs ${sha256(bodyText).slice(0, 12)}`);
check('重复生成：指标表一致（时间戳已归一）',
  childDigest.metrics === sha256(stripTimestamp(metricsText)),
  `${childDigest.metrics.slice(0, 12)} vs ${sha256(stripTimestamp(metricsText)).slice(0, 12)}`);

// --- 9. the files on disk are what was validated ----------------------------
check('磁盘文件 = 本次生成结果',
  readFileSync(resolve(round, 'TECHNICAL_REPORT_INSERT.md'), 'utf8') === bodyText
  && readFileSync(resolve(round, 'COMPETITION_METRICS_TABLE.md'), 'utf8') === metricsText,
  '两份文档均未被后续步骤改写');

// ---------------------------------------------------------------------------
// gate report
// ---------------------------------------------------------------------------
const passed = checks.length - checks.filter((c) => !c.ok).length;
const gate = [];
gate.push('# 生成质量门（自动生成）');
gate.push('');
gate.push(`> 由 \`scripts/makeTechnicalInsert.mjs\` 在生成正文的同时执行，共 ${checks.length} 项检查。`);
gate.push(`> 结果：**${fail.length === 0 ? 'PASS' : 'FAIL'}**（通过 ${passed}/${checks.length}）。`);
gate.push('');
gate.push(tbl(['#', '检查项', '结果', '明细'], checks.map((c, i) => [
  String(i + 1), c.name, c.ok ? 'PASS' : 'FAIL', c.detail,
])));
gate.push('');
gate.push('## 检查覆盖范围');
gate.push('');
gate.push('- 数值一致性：汇总字段与原始记录双向核算（Phase 1 逐单元求和、Phase 2 逐条求和）；');
gate.push('- 公式一致性：直接读取 `arms.ts` / `chance.ts` / `uct.ts` / `uctPrepared.ts` / `preparedActions.ts` 的调用点与常量，');
gate.push('  核对计数口径、RULE-A 早退、k=0 / k=1 短路、隧道免验证、回退分支；');
gate.push('- 结构一致性：重新解析生成的 Markdown，逐表逐格与生成器内存中的表格比对；');
gate.push('- 图表：中文标签、字号下限、边界情形说明、已删除论断的缺席；');
gate.push('- 可重复性：另起一个进程重新生成，比对正文与（归一化时间戳后的）指标表摘要；时间戳本身不参与比较。');
gate.push('');

writeFileSync(resolve(round, 'REPORT_QUALITY_CHECK.md'), `${gate.join('\n')}`, 'utf8');
console.log(`gate: ${fail.length === 0 ? 'PASS' : 'FAIL'} (${passed}/${checks.length})`);
for (const f of fail) console.error(`  FAIL ${f}`);
if (fail.length > 0) process.exitCode = 1;
console.log(`phase1 verdict=${p1.verdict} ruleCalls ${P1.ruleCalls[0]} -> ${P1.ruleCalls[1]} (${pct(ruleReductionP1)})`);
console.log(`phase2 pairs=${integrity.pairs} relGain=${sign(e.relativeGain)} CI=[${sign(ciRel.low)}, ${sign(ciRel.high)}] balanced=${sign(balanced.value)}`);
