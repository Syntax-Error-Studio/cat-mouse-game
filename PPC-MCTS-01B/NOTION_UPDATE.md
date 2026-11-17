# NOTION_UPDATE — 《小猫小鼠｜Project Perfect Cat 总档案》

**状态：未自动更新。** 本会话没有连接 Notion 连接器，因此内容以本文件形式交付，需人工粘贴或由后续带连接器的会话写入。不声称已更新。

写入建议位置：总档案 → 实验 authority → 新增「PPC-MCTS-01B 最终执行」条目；同时在「技术成果」页引用 `TECHNICAL_REPORT_INSERT.md`。

---

## 条目正文（可直接粘贴）

### PPC-MCTS-01B 最终执行（2026-11-17）

**一句话**：Prepared Transition 的决策等价性已用 960 次固定完整仿真调用证明（192 000 条仿真逐事件一致）；规则调用减少 47.94%，但在 100 ms 固定预算下未观测到吞吐提升（序平衡 +0.04%，95% CI −1.16%…+1.67%）。

**架构变化**

- 新增 `scripts/runPhase1.mjs`：20 个全新 Node 进程串行驱动 Phase 1，每进程 24 根 × 2 臂，进程退出后才起下一个；每 repetition 校验 24 条记录 / 2 臂 / K=200 / 接缝命中 / 0 随机调用 / 200 条摘要逐条相等。
- `scripts/runPhase2.mjs` 正式输出迁到 `data/phase2-formal/`，加目录占用预检与 `--resume`。
- `verify-baseline-fork.mjs` 由「符号级分类」升级为**交叉引用式分类**：每条 fork 新增行必须指明被替换的父文件行，`UNCLASSIFIED_DIFF_LINES = 0` 且计数守恒（+195 / −39）。
- `drivers/perfBudget100.ts` 计时段落定稿：`withinPlanner150ms`（权威）、`legacyPilotComparable150ms`（原始 Pilot 含回放口径）、`validationEndToEndMs`、`planFullTurnConsumed`。

**实验 authority**

| 项 | 值 |
|---|---|
| Phase 1 | 24 roots × 20 reps × 2 arms，K=200 完成仿真，960 调用 / 192 000 仿真，20 进程，envelope 938.5 s |
| Phase 2 | 24 × 20 × 2，100 ms 主预算 / 150 ms 回合预算，960 调用，20 进程，~101 s |
| 种子 | `uctSeed(root,'UCT-H',rep)`，两臂完全相同 |
| 臂序 | 奇 rep 基线先跑，偶 rep Prepared 先跑（用于识别预热偏差） |

**性能结果**

- 完成仿真/调用：27.67（基线）vs 27.68（Prepared）
- 规则内核调用/调用：2 069.5 → 1 092.7（−47.2%）
- 序平衡臂效应 +0.04%，CI [−1.16%, +1.67%]
- 实测臂序（冷进程预热）效应 +1.34%：**比机制效应还大**，是这类单进程 A/B 的隐藏陷阱
- 新建节点/调用 30.30 vs 30.27（树形状未变）；`withinPlanner150ms` 960/960

**技术裁决**

1. 决策语义等价 —— PASS（可安全替换级别）
2. 规则调用减少 —— PASS
3. 固定预算吞吐提升 —— NOT SUPPORTED
4. 棋力提升 —— NOT MEASURED

**关键文件**

- `PPC-MCTS-01B/FINAL_EXECUTION_REPORT.md`（总报告）
- `PPC-MCTS-01B/FINAL_GATE_REPORT.md`（GATE A/B/C）
- `PPC-MCTS-01B/PHASE1_FINAL_REPORT.md` / `PHASE2_FINAL_REPORT.md`
- `PPC-MCTS-01B/STATISTICAL_ANALYSIS.md`
- `PPC-MCTS-01B/TECHNICAL_REPORT_INSERT.md`（国赛章节，PPC-REPORT-01 修订版）
- `PPC-MCTS-01B/COMPETITION_METRICS_TABLE.md`（国赛展示用核心指标表）
- `PPC-MCTS-01B/figures/*.svg`（5 张图）
- `PPC-MCTS-01B/SHA256SUMS.txt`（权威摘要）

**下一阶段建议**

1. 叶评价更可能是当前热点：一次仿真平均约 3.6 ms，而近乎一半的规则转移被去掉后吞吐仍无可分辨变化（序平衡 +0.04%，95% CI [−1.16%, +1.67%]）。若规则转移占主导份额，减半必带来远超区间宽度的变化，因此可排除"规则转移是主导成本"；但**不给占比数值**（反推需要"吞吐∝1/耗时"与"其余成本不变"两个未验证假设）。优化方向应转向 `evaluateForCat` / rollout 策略。
2. 若仍要做 A/B 吞吐实验，改为**每臂独占一个全新进程**，或先做一次预热仿真再计时，消除 1.3% 量级的臂序偏差。
3. 吞吐不等于棋力：需要自对弈或外部基准才能谈强度，本轮未做，不得在任何对外材料中混用。
