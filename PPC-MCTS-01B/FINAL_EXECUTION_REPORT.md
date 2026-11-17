# FINAL EXECUTION REPORT — PPC-MCTS-01B

**Round:** PPC-MCTS-01B final execution (FINAL GATE → Phase 1 → Phase 2 → statistics → report integration)
**Repository:** `F:\小猫小鼠` · branch `ppc/p1-id-state-identity-fix` · HEAD `48eaac6c4f3801d351787696ba5876995b64e8d8` (unchanged)
**Writable scope used:** `PPC-MCTS-01B/` only. No commit, no push, no merge. `src/`, `GAMEPLAY.md`, `PPC-MCTS-01/`, `PPC-MCTS-01A/` untouched.

---

## 1. 人话总结

这一轮把「Prepared Transition」从一个"看起来能省计算"的原型，做成了有两份正式实验背书的成果，结论比预期更清醒：

1. **决策语义完全一致，是整个实验里最硬的结论。** 960 次固定 200 条完整仿真的调用、192 000 条仿真、96 000 次逐条摘要比对，两臂在树内每个决策节点、每次随机抽样、每个机会分支、最终计划上都逐事件一致。这不是"结果碰巧相同"，是"两条控制流做了同一件事"。
2. **规则计算确实少了一半**（−47.94%），但**在 100 ms 预算内并没有换来更多仿真**（序平衡增益 +0.04%，95% CI −1.16%…+1.67%）。
3. **而且我们抓到了一个会骗人的测量偏差**：同一进程里先跑的那一臂，会因预热少完成约 1.3% 的仿真——比要测的机制效应还大。逐 repetition 的增益因此呈严格正负交替（+1.8/−0.5/+2.1/−1.3…）。如果不按臂序分层，任何一方都能"证明"自己想证明的结论。
4. 于是本轮的技术贡献变成两句话：**机制可证等价、成本减半；但当前瓶颈不在规则转移。** 这两句都有数据支撑，也都写进了国赛章节。

诚实的代价：Phase 2 没有拿到正向性能收益。按任务书要求，如实保留，不虚构。

---

## 2. 技术裁决

| 命题 | 裁决 | 证据 |
|---|---|---|
| Prepared Transition 两臂在固定完整仿真数下决策语义一致 | **PASS** | `PHASE1_ANALYSIS/summary.json`：13 项预注册验收全 PASS，480 cell / 96 000 digest 对 / 0 差异 |
| Prepared 减少规则内核调用 | **PASS**（−47.94%） | 8 679 624 → 4 518 541 |
| Prepared 在 100 ms 预算内完成更多仿真 | **NOT SUPPORTED** | 序平衡效应 +0.04%，CI 覆盖 0 |
| Prepared 提高棋力 | **NOT MEASURED** | 未跑自对弈/oracle/天梯，禁止从吞吐推棋力 |
| 实验执行完整性 | **PASS** | 960 + 960 条调用，40 个全新进程，0 error / 0 replay failure / 0 Math.random |

---

## 3. 正式实验参数（与预注册逐项一致）

| 参数 | Phase 1 | Phase 2 |
|---|---|---|
| roots | 24 | 24 |
| repetitions | 20（1 个全新进程/次） | 20（1 个全新进程/次） |
| arms | 2（UCT-H-BASELINE / UCT-H-PREPARED） | 2（同左） |
| rollout | hybrid（两臂相同） | hybrid（两臂相同） |
| 停止条件 | 完整完成 200 条仿真后于下一条开始前判定 | 主搜索 100 ms 墙钟截止 |
| 时钟 | `now() => 0`（冻结，截止永不触发） | `performance.now()` |
| maxHandoffs / maxNodes / c | 4 / 500 000 / √2 | 4 / 500 000 / √2 |
| seed | `uctSeed(root,'UCT-H',rep)`，两臂相同 | 同左 |
| 调用数 | 960 | 960 |

---

## 4. 960 + 960 调用完整性

**Phase 1**（`data/phase1-formal/`，20 个进程，envelope 938.5 s）

| 项 | 值 |
|---|---|
| 记录数 | 480（24 root × 20 rep，每条记录含两臂） |
| 臂调用 | 960 / 960 |
| 完成仿真 | 192 000 / 192 000 |
| 每条调用仿真数 | 200（两臂全部由接缝命中，非节点上限） |
| node cap / deadline / aborted | 0 / 0 / 0 |
| Math.random draws | 0 |
| 每进程退出码 | 全 0 |

**Phase 2**（`data/phase2-formal/`，20 个进程，每进程 5.0–5.1 s）

| 项 | 值 |
|---|---|
| 记录数 | 960（24 root × 2 arm × 20 rep） |
| 配对 cell | 480（每 cell 两臂齐全） |
| error / replay failure | 0 / 0 |
| deadline 正常触发 | 960（搜索按自己的 100 ms 截止停下） |
| node cap 触发 | 0 |
| 计划消耗完整猫回合 | 960 / 960 |
| Math.random calls | 0 |

---

## 5. 正确性与 parity 结果

13 项预注册验收（`PHASE1_ANALYSIS/summary.json → acceptance`）全部 PASS：

- `TOTAL_SEARCH_CALLS` 960/960，`COMPLETED_SIMULATIONS_PER_CALL` 200，`EXPECTED_TOTAL_SIMULATIONS` 192 000
- `ALL_SIMULATION_DIGESTS_MATCH`：96 000 次逐条比对（每条比对覆盖两臂）全一致
- `ALL_TREE_FINGERPRINTS_MATCH`：整树指纹（节点 kind、handoff、stateKey、访问数、总/均奖励、边 key 与 transition kind、CHANCE 权重与各 outcome stateKey、massError）全一致
- `ALL_PLANS_MATCH`：最终计划、`planCost`、`treePlanLength`、`extensionSteps`、`rootAction`、逐根动作统计全一致
- `MATH_RANDOM_DRAWS` 0，`NODE_CAP_HITS` 0，`DEADLINE_HITS` 0，`ABORTED_SIMULATIONS` 0

注意：`nodesCreated` 与 `chanceSamples` 也在比对之列并且相同 —— 说明复用没有改变树的形状，只改变了到达同形状的代价。

---

## 6. 性能分析

| 量 | 基线 | Prepared |
|---|---|---|
| 完成仿真 / 调用（均值） | 27.67 | 27.68 |
| P25 / P50 / P75 / P95 | 15.0 / 18.0 / 21.3 / 58.0 | 15.0 / 18.0 / 22.0 / 58.0 |
| 新建节点 / 调用 | 30.30 | 30.27 |
| rollout 步 / 调用 | 229.5 | 231.8 |
| 规则内核调用 / 调用 | 2 069.5 | 1 092.7（−47.2%） |
| 复用转移 / 调用 | 0 | 236.8 |
| 非纯回退 / 调用 | 0 | 0 |
| plannerWallMs P50 / P95 | 100.77 / 102.56 | 100.80 / 102.69 |
| searchMs P50 / P95 | 100.22 / 101.49 | 100.22 / 101.12 |
| replayMs P50 / P95 | 0.13 / 0.22 | 0.13 / 0.22 |

`withinPlanner150ms` = 960/960（权威口径）；`legacyPilotComparable150ms` = 960/960（含离线回放的原始 Pilot 口径）。两者同为满分属预期：预算把 planner 钉在 100 ms，回放只有 0.1–0.2 ms。

---

## 7. 统计置信区间

| 估计量 | 值 | 95% CI |
|---|---|---|
| 配对差值均值（混合臂序） | +0.01 条仿真/调用 | — |
| 混合相对增益 | +0.03% | [−1.2%, +1.7%] |
| prepared 跑第二（奇 rep） | +1.38% | — |
| prepared 跑第一（偶 rep） | −1.30% | — |
| **臂序（预热）效应** | **+1.34%** | [−0.42%, +4.23%] |
| **序平衡臂效应（应引用这个）** | **+0.04%** | [−1.16%, +1.67%] |

方法：按 root 分层的配对 cluster bootstrap，10 000 次重采样，固定种子 `20261117`，24 个 cluster。未剔除任何环境离群样本。

**为什么必须分层**：逐 repetition 的相对增益严格正负交替（+1.8, −0.5, +2.1, −1.3, +1.4, −0.9, …），与臂序完全同相。同一进程内先跑的一臂承付 JIT 预热，少完成约 1.3% 的仿真。把它混进总体均值会让正负相消，看起来"毫无差异"，从而把一个方向性偏差误读成"干净的空结果"。

---

## 8. 原始数据位置

```
PPC-MCTS-01B/data/phase1-formal/   rep-01..20.jsonl / .summary.json / .checkpoint.json / ENVELOPE.json
PPC-MCTS-01B/data/phase2-formal/   rep-01..20.jsonl / .summary.json / .checkpoint.json / orchestrator.log.json
PPC-MCTS-01B/PHASE1_ANALYSIS/      summary.json / cells.csv
PPC-MCTS-01B/PHASE2_ANALYSIS/      summary.json / paired.json
PPC-MCTS-01B/figures/              transition-reuse-comparison.svg / simulation-throughput.svg /
                                   paired-performance-gain.svg / plan-coverage.svg
```

原始 JSONL 均为**追加写、从不截断**；进程异常也不会删除已有结果。

---

## 9. SHA256

权威清单见 `PPC-MCTS-01B/SHA256SUMS.txt`（覆盖除自身外全部文件，含两份 manifest）。`FINAL_BUILD_MANIFEST.json` 与 `BUILD_MANIFEST.json` 逐文件登记 path / bucket / bytes / sha256。

关键源文件（本轮定稿）：

| 文件 | SHA256 |
|---|---|
| `PPC-MCTS-01/proto/uct.ts`（冻结未改） | `508a65bf53b63555bc4d3f8de7199b8607a8544572bb0e55850445cdffa2c53a` |
| `proto/uctBaseline.ts` | `7df9d8d1bb42f984f5f866c8444b40f7133b1aa84d43f8229e5b731f38eff068` |
| `proto/uctPrepared.ts` | `0e6f105088b8df98e3d4a3e45a2ac6ab55f4231c837bdb1f861e4f701c27e3b2` |
| `drivers/phase1Parity.ts` | `e713115f0ed22b43793deece0b5c138d0dbbb7f6adb9e360b899fb1985e7caa6` |
| `scripts/runPhase1.mjs` | 见 `SHA256SUMS.txt` |
| `scripts/runPhase2.mjs` | 见 `SHA256SUMS.txt` |
| `drivers/perfBudget100.ts` | 见 `SHA256SUMS.txt`（GATE C 新增 4 字段后重算） |

---

## 10. 工作树状态

| 项 | 状态 |
|---|---|
| HEAD / 分支 | 未变 |
| `git status` | 15 个 `M` + 55 个 `??`，与开工时逐条一致（15 个 `M` 为开工前既有修改，本轮未触碰） |
| 破坏性 git 操作 | 无（无 reset / clean / stash / checkout） |
| `src/`、`GAMEPLAY.md`、`PPC-MCTS-01/`、`PPC-MCTS-01A/` | 逐字节未变 |
| commit / push / merge | 无 |

---

## 11. 未解决事项

1. **`data/impl-parity-breadth.json` 的历史字节不可恢复**（上一轮误覆盖，已在 `HARNESS_REPAIR_REPORT.md §7.1` 登记）。内容已重建为 96/96 PASS，仅 `generatedAt` / `wallMs` / `node` 等执行时字段不同。
2. **臂序效应未彻底消除**，只是被建模。更彻底的做法是每臂独占一个全新进程（进程数 40→80），本轮未做，因为会改变预注册的进程拓扑。
3. **`rolloutImpureFallbacks` 在 24 根语料中恒为 0**，即 fail-closed 路径在本轮正式数据里没有被触发（它由 `probe/impl/rolloutReuseParity.test.ts` 的 F 用例单独验证）。
4. **国赛技术报告 Word 文档不存在**：仓库内没有找到权威的技术报告文档（只有一个无关的课程作业 `.doc`）。因此只生成可插入章节 `TECHNICAL_REPORT_INSERT.md`，未改动任何现有文档。
5. **Notion 未连接**：无法直接更新总档案，已生成 `NOTION_UPDATE.md`，不声称已更新。

---

## 12. 对技术报告的具体增补内容

`TECHNICAL_REPORT_INSERT.md` 为可直接插入的完整章节，包含：技术问题、两遍式流程与代价、Prepared Transition 机制与三条设计约束、复杂度分析、固定仿真数正确性证明（含 13 项验收表）、100 ms 固定预算性能实验（含臂序偏差的发现与处理）、省下的计算去了哪里、4 张图、结论边界。

建议插入位置：算法创新章节之后、系统实现章节之前。

图文件：`figures/transition-reuse-comparison.svg`、`simulation-throughput.svg`、`paired-performance-gain.svg`、`plan-coverage.svg`。

---

## 13. 执行时间线

| 阶段 | 实际耗时 | 说明 |
|---|---|---|
| 预检 + 资源采样 | ~6 min | 两轮 36 s 采样 + 进程/身份核对 |
| GATE A/B/C | ~40 min | 新增 `runPhase1.mjs`、重写分类器（含 2 个分类器 bug 修复）、GATE C 计时字段 |
| 重建 + 类型检查 + 正确性套件 | ~3 min | 14/14 PASS |
| **Phase 1** | **938.5 s** | 20 进程 × 24 根 × 2 臂 × 200 仿真 |
| **Phase 2** | **~101 s** | 20 进程 × 48 调用 × 100 ms |
| 统计 + 图表 + 报告 | ~10 min | 全部由脚本从数据生成 |
