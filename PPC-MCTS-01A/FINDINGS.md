# PPC-MCTS-01A — FINDINGS

**审计对象**：PPC-MCTS-01 的 UCT-H（及 UCT-R 对照），未修改任何算法/预算/规则。  
**固定基线**：HEAD `48eaac6c4f3801d351787696ba5876995b64e8d8`，`GAMEPLAY_RULESET_VERSION=2`，主搜索 100ms，全回合 150ms，H=4，maxNodes=500000，c=√2。  
**权威数据**：`PPC-MCTS-01/out/smoke-final.jsonl` 的 72 条 smoke（24 根 × 3 算法，repetition=1）。诊断复跑只用于调用计数与成本结构，不替代 smoke。  
**证据标签**：**[源码]** / **[日志]** / **[统计]** / **[假设]**。

---

## 0. 一句话结论

UCT-H 不是“树搜索写得慢”，而是**每一步 rollout 都先为全部合法动作做一次 Hybrid 评价，选中后再模拟一次；每次 Hybrid 评价通常做 3 张 BFS 加一次 ValueNet（ineligible 时退化为 3 张 BFS）**。在 100ms 内这只够约 25 次完整 simulation（中位数 12），于是树只能铺开根层、猫回合计划平均只有 **2.50 步**有树内证据，其余 **1.67 步靠 rollout 补全**。根层动作覆盖并不差（3.79 个动作全被访问，归一化熵 0.979），真正丢失的是**深度和每步证据量**。

本轮**没有发现规则错误、UCB 符号错误、CHANCE 权重错误或回放错误**；发现的是计算结构导致的搜索浅层化。

---

## 1. A. Hybrid Evaluation Cost

### 1.1 直接确认

- **[源码]** 每次非终局 `evaluateLeaf` 调用一次 `hybridEvaluateForCat`；后者在 eligible 状态下调用一次 `evaluateForCat` + 一次 `productionValueNet`，ineligible 时只调用 baseline。
- **[源码]** `evaluateForCat` 每次 `buildContext` 固定构建 3 张 BFS：mouse、cat、carrying-hole；Voronoi 扫描全部战略格；单次调用内部不重复 BFS。
- **[源码]** Hybrid 没有跨状态/跨 simulation 的评价缓存；`stateKey` 只用于树路径和循环检测。
- **[源码]** `generateLegalSearchActions` 对每个候选动作执行一次 `simulateSearchAction` 做有效性验证；这层模拟本身不做 Hybrid 评价，但会为吃黄油候选枚举全部 spawn outcome。
- **[源码]** `guidanceValue` 对 deterministic 后继评价 1 次；对 chance 的**每个 outcome** 各评价 1 次，再按权重求期望。
- **[源码]** 选定动作后 rollout 再模拟一次；候选动作的 transition 没有被复用。

### 1.2 量化

| 指标 | UCT-R | UCT-H | 说明 |
| --- | ---: | ---: | --- |
| smoke simulations 均值 | 233.6 | **25.0** | 权威数据 |
| smoke simulations 中位数 | 130 | **12** | 均值被少数根拉高 |
| 诊断 evaluations / simulation | 0.935 | **33.8** | 未插桩 |
| coverage hybrid 调用 / simulation | 0.951 | **44.2** | 插桩口径 |
| 单次 Hybrid 墙钟 | — | **92.0µs**（P50 85.8 / P95 131.1 / P99 193.2） | 外部负载下 |
| 单次 baseline 墙钟 | — | 64.6µs | 3 BFS |
| 单次 ValueNet 墙钟 | — | 20.8µs | 808→128→64→1 |
| 诊断 CPU / simulation | 0.345ms | **3.161ms** | **9.16×** |
| smoke simulation 数比 | — | **9.34×** 少 | 与 CPU 比一致 |

- **[统计]** coverage 精确分解：UCT-H 的 `evaluateLeaf` 4,595 = guidance 候选 4,019 + chance outcome 额外 473 + 最终叶 103；其中 43 个终局叶不调用 Hybrid，故 `hybridEvaluateForCat=4,552`。
- **[统计]** 约 **97.8%** 的叶评价发生在 rollout 的候选评价里，树内最终叶只占 2.2%。
- **[统计]** UCT-H 的 ValueNet 调用占 Hybrid 的 76.2%（3,471/4,552），其余为 ineligible fallback；24 根中 8 根带 `pendingButterSpawns`（1–2 个），与 `rootEligible=false` 的根完全对应。

### 1.3 结论

**计算结构是主因，不是循环开销。** UCT-H 每 simulation 比 UCT-R 多约 34–45 次 Hybrid 评价；每次约 3 张 BFS，直接导致 simulation 数少约 9 倍。重复模拟与无缓存进一步放大了成本，但没有跨状态重复率计数，无法给出“可节省百分之多少”的精确值。

---

## 2. B. UCT Tree Expansion

### 2.1 直接确认

- **[源码]** UCB1 使用 `Q`（猫视角）与 `c*sqrt(ln N/n)`；猫节点最大、鼠节点最小；未访问边优先。
- **[源码]** 未访问边按合法动作枚举顺序返回，导致**宽度优先**展开；每次 simulation 最多新增约 1 个决策节点。
- **[源码]** CHANCE 在树内每访问只采样 1 个 outcome；权重均匀；chance 节点按同一猫视角 reward 回传样本均值，不是解析期望。
- **[源码]** 循环检测只在单条 simulation 内有效；keys 不跨 simulation 共享。
- **[源码]** `maxHandoffs=4` 同时截断树下降与 rollout；deadline 只提交完整 simulation，aborted 不回传、不计数。**[统计]** 诊断中 24 根 `postDeadlineNodeCreations=0`。
- **[统计]** smoke 中 24/24 UCT-H 根 `deadlineFired=true`，`budgetFired=false`；诊断中 UCT-H 20/24 根出现过 aborted simulation。

### 2.2 为什么树计划只有 2.50 步

| `planTreeLength` | 根数 | 平均 simulations |
| ---: | ---: | ---: |
| 2 | 14 | 8.21 |
| 3 | 8 | 25.13 |
| 4 | 2 | 142.00 |

- **[统计]** `sims ~ treePlanLength` Pearson **0.724**；`sims ~ extensionSteps` **-0.660**；`treePlanLength ~ extensionSteps` **-0.866**。
- **[统计]** 根平均 3.79 个合法动作，前约 4 个 simulation 才铺满根层；25 个 simulation 不足以既铺宽又挖深。
- **[统计]** 2.50 是 14 个 2 步根、8 个 3 步根、2 个 4 步根的混合；均值被 G5T4（214 sims）与 G6T3（70 sims）抬高。
- **[源码]** 树计划只沿“每层最访问 child”走，且遇到 handoff/chance 即停；它不是所有访问节点的并集。

### 2.3 结论

2.50 步不是硬编码，而是**宽度优先 + 每 sim 昂贵 + H=4 截断 + principal line 只取最访问链**的联合结果。增加预算会先增加宽度覆盖（根层已接近饱和），再逐步增加深度；当前预算下深度证据不足是结构性的。

---

## 3. C. Rollout Policy

### 3.1 直接确认

- **[源码]** UCT-H 对除“单动作”外的全部合法动作做 Hybrid 引导评价；猫取最大、鼠取最小；并列时用 seeded `policyRng` 均匀选择。
- **[源码]** 多动作状态下每个候选至少被模拟两次（合法验证 + 引导），选定动作再模拟一次；单动作状态跳过引导，只模拟两次。吃黄油候选的引导会展开 24–34 个 outcome 并逐一评价。
- **[源码]** 合法动作列表与有效性验证没有缓存；同一状态在不同 simulation 中会重新生成、重新模拟。
- **[源码]** rollout 循环有重复状态检测，单条路径内不会无限振荡；跨 simulation 不去重。
- **[统计]** coverage：UCT-H 每步 3.46 个候选评价、8.74 次 simulate、3.96 次 leaf 评价；UCT-R 每步 5.32 次 simulate、0.073 次 leaf 评价。
- **[统计]** 每 simulation CPU 比 9.16×，每 rollout 步 CPU 约 12.5×（统计推导）。

### 3.2 结论

UCT-H 的 rollout 是“**每步做一次小规模 expectimax 引导**”，不是普通随机 rollout。它的成本主要来自候选评价的数量和 Hybrid 评价的单价，而不是循环次数。鼠方 MIN、种子化 tie-break、循环终止均按设计工作；未发现策略性错误。

---

## 4. D. Root Visit Distribution

### 4.1 直接确认（smoke，24 根 UCT-H）

| 指标 | UCT-H | UCT-R |
| --- | ---: | ---: |
| 平均合法根动作 | 3.79 | 3.79 |
| 平均被访问根动作 | 3.79 | 3.79 |
| 平均根访问数 | 25.0 | 233.6 |
| 归一化访问熵 | **0.979** | 0.989 |
| 平均 top share | **0.332** | 0.324 |
| 最大 top share | 0.667 | 0.656 |
| top 与第二名访问差为 0 的根 | **16/24** | 4/24 |
| chosen = top visited | 24/24 | 24/24 |
| chosen 按 Q 排名第 1 | **13/24** | 21/24 |
| 根边为 CHANCE | 0 | 0 |
| 平均 chance 采样/根 | 10.4 | 105.0 |
| chance 采样/sim | 0.742 | 0.541 |

- **[源码]** `bestRootEdge` 按访问数选，平局按动作 key 字典序；因此 **“chosen = top visited” 是定义使然，不是质量证据**。
- **[统计]** UCT-H 的根层覆盖与 UCT-R 接近（熵 0.979 vs 0.989），但访问数少 9.3×；宽度没有明显丢失，深度和每条边的样本量丢失。
- **[统计]** 16/24 根出现 top 访问并列，说明 25 次访问不足以稳定区分根动作；chosen 按 Q 只有 13/24 是最优，不能据此断言选招质量差（Q 本身只有很少访问，噪声大）。
- **[统计]** chance 采样越多的根，归一化熵越低（r=-0.541）、top share 越高（r=+0.588）、被访问动作越少（r=-0.425）；这是关联，不是因果。
- **[假设]** 根动作访问分布看似“均匀”，部分原因是未访问边优先 + 访问数少；不能把它解读为 UCT 已充分探索。

### 4.2 结论

**不能用“根动作一致率”判断 UCT-H 质量。** 根层覆盖接近饱和；真正的问题是每个根动作的后续证据只有个位数访问，导致 Q 估计不稳定、principal line 难以延伸。评估应看每根访问预算、Q 置信区间、树深与最终计划证据，而不是只看首选动作是否相同。

---

## 5. E. Plan Extraction

### 5.1 直接确认

| 指标（smoke） | UCT-H | UCT-R | RACE |
| --- | ---: | ---: | ---: |
| `planTreeLength` 均值 | **2.50** | 4.08 | 0 |
| `extensionSteps` 均值 | **1.67** | 0.042 | 0 |
| 最终 `planLength` 均值 | 4.17 | 4.125 | 4.17 |
| `planActionCost` 均值 | 4 | 4 | 4 |
| 发生补全的根 | **22/24** | 1/24 | — |
| 树内动作占比（按根平均） | **60.4%** | 99.2% | 0% |
| 补全动作占比（按根平均） | **39.6%** | 0.8% | 0% |
| 真实引擎回放成功 | 24/24 | 24/24 | 24/24 |
| 全回合消耗 | 24/24 | 24/24 | 24/24 |
| 150ms 预算内 | 24/24 | 24/24 | 24/24 |

- **[源码]** `extractPlan` 先走 principal line；若在 handoff 前结束，则用同一 rollout 策略补全猫动作，并单独计 `extensionSteps`。
- **[源码]** `planActionCost` 是 `mateActionCost` 之和；`catPlaceTrap` 成本为 0，因此 5 个动作的计划成本仍可能是 4，**动作数 ≠ 行动成本**。24 个根的 `catMovesLeft` 全为 4，2.50 不是剩余步数不足造成的。
- **[统计]** 补全总评价 99 次、27 步、0.384ms/根（诊断），相对搜索很小，但证据意义大：最终计划约 40% 的动作没有树内访问支持。
- **[统计]** `searchCompleted` 在 harness 里只是 `simulations > 0`，`completedDepth` 为 null；**不能把它解读为“搜索完成到终局”**。

### 5.2 结论

最终 4.17 步计划看起来完整，但 UCT-H 的计划质量是“**2.50 步树证据 + 1.67 步启发式补全**”。回放全部成功只证明计划合法、可执行，**不证明计划最优或搜索充分**。

---

## 6. 严重度矩阵

| 严重度 | 发现 | 性质 | 证据 |
| --- | --- | --- | --- |
| **高（效率）** | 每步引导评价全部合法动作，单次 Hybrid 3 BFS + ValueNet，100ms 只够约 25 次 simulation | 结构成本 | [源码] + [统计] |
| **高（证据）** | 树计划平均 2.50 步，39.6% 最终动作来自 rollout 补全 | 搜索浅层化 | [统计] + [源码] |
| **中** | 候选动作被模拟 2–3 次，合法动作与评价无跨状态缓存；工作树已有 `generatePreparedSearchActions` 可复用合法验证的 transition，但 `uct.ts` 仍调用旧的 `generateLegalSearchActions` | 可复用性缺失 | [源码] + [统计] |
| **中** | chance 候选引导展开 24–34 个 outcome，方差与成本同时放大 | 成本/估计噪声 | [统计] |
| **中** | 25 次根访问下 16/24 根 top 并列，chosen 按 Q 仅 13/24 最优 | 估计不稳定 | [统计] |
| **低** | `policyRng` 同时服务树内 tie-break、rollout 与计划补全；补全发生在 RNG 推进之后 | 可复现但非独立流 | [源码] |
| **低** | `searchCompleted` 语义仅为 “sims>0”，`completedDepth=null` | 指标误读风险 | [源码] |
| **无** | UCB 符号、猫/鼠视角、CHANCE 权重、回放合法性 | 未发现正确性缺陷 | [源码] + 原有 14/14 测试复跑通过（1.78s，`logs/tests-rerun.txt`） |

---

## 7. 明确未证明的内容

- **未证明 UCT-H 的棋力弱于/强于 UCT-R**：本轮没有对弈强度实验，也没有 20-process pilot。
- **未证明 2.50 步树计划就是棋力瓶颈**：只能证明树内证据少；因果需要对照实验。
- **未证明缓存一定能带来等比例加速**：没有测跨状态重复率，也没有实现缓存。
- **未证明绝对计时可跨机器复现**：外部 heavy 负载（`reliability-final-run.mjs`、docmap-studio）仍在运行；本报告的微秒/毫秒只作结构诊断。
- **未证明 chance 基数 24–34 覆盖所有局面**：探针只有 21 个吃黄油状态，是样本估计。
- **未证明根 Q 排名差异具有统计显著性**：每根访问数太少，未做置信区间/重复实验。

---

## 8. 若进入下一阶段，建议的“轻量”诊断（本轮未执行）

1. 给 rollout 加**只读计数器**：统计相同 `stateKey` 在多少次 evaluation 中被重复评价（不改算法，只计数）。
2. 记录每个根动作的 Q 与访问数、bootstrap 置信区间，判断“chosen 非最优”是否只是噪声。
3. 在固定根集合上做 simulation 数–树深–计划证据曲线（例如 10/25/50/100 次），确认边际深度收益。
4. 对 chance 候选做更大样本的 outcome 基数分布（仅统计，不跑对局）。
5. 若要优化，优先考虑**减少重复模拟/复用候选 transition**，而不是降低 Hybrid 评价质量或改预算；任何改动都必须另立合同并重新做正确性/强度验证。

---

## 9. 合规声明

- 未修改 `src/`、`GAMEPLAY.md`、UCT-R/UCT-H、RACE、100/150ms 预算、原始 72 条 smoke。
- **工作树披露**：HEAD 为 `48eaac6...`，但审计开始时工作树已存在 15 个未提交的 `src/game/` 修改与若干未跟踪文件（含 `preparedActions.ts`、根 fixture）。这些修改早于本轮审计和 smoke，不是本轮产生的；本报告读取的是该工作树。完整清单与关键文件 SHA256 见 `data/SOURCE_PROVENANCE.txt`。
- 未运行 20-process pilot、大规模 self-play、大规模 exhaustive oracle、1700 组正式实验。
- 复跑了原有 14 项 PPC 正确性测试：14/14 通过（1.78s，`logs/tests-rerun.txt`）；没有减少或跳过原测试。
- 未 commit/push/merge。
- 所有新增诊断均包裹**未修改**的 `UctSearch`，只读计数器或 coverage，不改变算法语义。
- 外部 heavy 负载仍在；本轮结论以源码结构与 smoke 统计为主，绝对计时只作辅助。
