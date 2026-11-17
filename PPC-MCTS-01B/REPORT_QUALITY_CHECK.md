# 生成质量门（自动生成）

> 由 `scripts/makeTechnicalInsert.mjs` 在生成正文的同时执行，共 37 项检查。
> 结果：**PASS**（通过 37/37）。

| # | 检查项 | 结果 | 明细 |
|---|---|---|---|
| 1 | 无未插值残留 / NaN / undefined | PASS | 0 处 |
| 2 | Phase 1 内核调用：汇总字段 = 逐单元求和 | PASS | 8679624/4518541 vs 8679624/4518541 |
| 3 | Phase 2 内核调用均值：逐条求和 ÷ 单元数 = 汇总均值 | PASS | 2069.529 vs 2069.529 |
| 4 | Phase 2 采样总数：逐条求和 = 均值 × 单元数 | PASS | 27.6667 vs 27.6667 |
| 5 | 关键数值同时出现在正文与指标表 | PASS | 17 项全部命中 |
| 6 | 两组之差 = 2 × 半差（臂序关联量） | PASS | 0.0268 vs 0.0268 |
| 7 | 计数器只包住 5 个空间动作内核 | PASS | bump() × 5 |
| 8 | CHANCE 校验用 |Σw − 1| ≤ 1e-9 | PASS | MASS_TOL=1e-9, Math.abs(sum-1), w>0 三处均在位 |
| 9 | 两臂树内扩张逐行相同（都用 generateLegalSearchActions） | PASS | expansion 调用点各 1 处 |
| 10 | 两遍式 rollout：枚举 1 次后遍历已有合法列表 | PASS | enum×1 |
| 11 | 两遍式 rollout：k=0 早退、k=1 短路、选中动作再执行 1 次 | PASS | 三处控制流均在位 |
| 12 | 复用 rollout：一次准备 + 单合法动作直接读转移 | PASS | batch 单次构建，单合法动作短路 |
| 13 | 复用 rollout：唯一保留的旧路径是不可纯化回退 | PASS | legacy 路径 1 处，位于 fail-closed 分支 |
| 14 | 隧道出口是唯一免验证候选 | PASS | verifyEffectiveness:false 仅出现在隧道分支 |
| 15 | 候选枚举只有一份来源 | PASS | legalActions 复用枚举源 |
| 16 | 公式中的 LaTeX 反斜杠未被 JS 转义吞掉 | PASS | 61 个行内公式全部完整 |
| 17 | TECHNICAL_REPORT_INSERT.md：表格数量与生成器一致 | PASS | 9 vs 9 |
| 18 | TECHNICAL_REPORT_INSERT.md：每行列数与表头一致、分隔行合法 | PASS | 9 张表全部合规 |
| 19 | TECHNICAL_REPORT_INSERT.md：表格单元格与生成器逐格一致 | PASS | 逐格一致 |
| 20 | COMPETITION_METRICS_TABLE.md：表格数量与生成器一致 | PASS | 1 vs 1 |
| 21 | COMPETITION_METRICS_TABLE.md：每行列数与表头一致、分隔行合法 | PASS | 1 张表全部合规 |
| 22 | COMPETITION_METRICS_TABLE.md：表格单元格与生成器逐格一致 | PASS | 逐格一致 |
| 23 | 指标表为三列 | PASS | 行数 17 |
| 24 | 指标表行数在预期区间 | PASS | 15 行数据 |
| 25 | 图 1 使用中文术语并区分模拟器 / 内核调用 | PASS | text 节点 40 个 |
| 26 | 图 2 使用中文标签并保留两组独立标度说明 | PASS | text 节点 21 个 |
| 27 | 图 2 不再声称计数与机器/负载无关 | PASS | 该说明已删除 |
| 28 | 两图字号 ≥ 13 px（嵌入 Word 可读） | PASS | 最小 13.5 px |
| 29 | 图中无空文本节点 | PASS | 0 个 |
| 30 | 图 1 的边界情形说明完整（k=0 / k=1 / 隧道 / CHANCE） | PASS | 四类边界均在图中 |
| 31 | 已删除的论断不再出现于正文 | PASS | 0 处 |
| 32 | "未检测到明确提升"口径统一 | PASS | 正文与指标表同口径 |
| 33 | 正文不含生成时间戳 | PASS | 正文纯净 |
| 34 | 指标表时间戳恰好一行且位于表格之外 | PASS | 1 行 |
| 35 | 重复生成：正文逐字节一致 | PASS | e034ef5c517c vs e034ef5c517c |
| 36 | 重复生成：指标表一致（时间戳已归一） | PASS | dd6099b8561a vs dd6099b8561a |
| 37 | 磁盘文件 = 本次生成结果 | PASS | 两份文档均未被后续步骤改写 |

## 检查覆盖范围

- 数值一致性：汇总字段与原始记录双向核算（Phase 1 逐单元求和、Phase 2 逐条求和）；
- 公式一致性：直接读取 `arms.ts` / `chance.ts` / `uct.ts` / `uctPrepared.ts` / `preparedActions.ts` 的调用点与常量，
  核对计数口径、RULE-A 早退、k=0 / k=1 短路、隧道免验证、回退分支；
- 结构一致性：重新解析生成的 Markdown，逐表逐格与生成器内存中的表格比对；
- 图表：中文标签、字号下限、边界情形说明、已删除论断的缺席；
- 可重复性：另起一个进程重新生成，比对正文与（归一化时间戳后的）指标表摘要；时间戳本身不参与比较。
