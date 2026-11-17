# PPC-MCTS-01A — SOURCE_AUDIT

**范围**：只读审计 PPC-MCTS-01 当前 UCT-H 实现。未修改 `src/`、`GAMEPLAY.md`、UCT-R / UCT-H、RACE、100/150ms 预算或 72 条 smoke 数据；未 commit / push / merge。

**基线**

- HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`
- 规则：`GAMEPLAY_RULESET_VERSION = 2`
- 主搜索：100ms；完整回合：150ms；`maxHandoffs = 4`；`maxNodes = 500000`；`c = sqrt(2)`
- 72 条 smoke：`PPC-MCTS-01/out/smoke-final.jsonl`，repetition = 1
- fixture SHA256：`1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`
- 证据标签：
  - **[源码]** 直接由当前源码确认
  - **[日志]** 直接由冻结的 72 条 smoke 确认
  - **[统计]** 对日志/诊断数据的统计推导
  - **[假设]** 尚未验证的推断

### 0.1 工作树状态（必须披露）

`git rev-parse HEAD` 确认为 `48eaac6c4f3801d351787696ba5876995b64e8d8`，但工作树**并非干净**：审计开始前已存在 15 个未提交的 `src/game/` 修改（包括 `legalActions.ts`、`engine.ts`、`expectiminimax.ts` 等），以及大量未跟踪的 PPC 目录。这些修改的时间戳早于本轮审计与 smoke，**不是本轮产生的**；本轮没有编辑任何 `src/` 文件。

本报告中的“当前源码”指上述工作树，而不是 `git show HEAD` 的版本；72 条 smoke 与诊断都读取同一工作树。若需要完全可复现的 HEAD 版本差异，应以 `data/SOURCE_PROVENANCE.txt`（随附）中的 `git status` 与关键文件 SHA256 为准。

---

## 1. 调用链（源码事实）

```text
UctSearch.run()
  ├─ for each simulation (deadline checked before submit)
  │   ├─ simulate()
  │   │   ├─ decision node: UCB1 selectEdge() → applyEdge() → simulateSearchAction()
  │   │   ├─ chance node: weighted sampleChance() → lazily create outcome child
  │   │   ├─ cycle check with full stateKey()
  │   │   └─ rollout()
  │   │       ├─ generateLegalSearchActions()   // itself simulates candidate actions
  │   │       ├─ selectRolloutAction()
  │   │       │   ├─ UCT-R: uniform seeded choice
  │   │       │   └─ UCT-H: guidanceValue() for EVERY legal action
  │   │       │       ├─ simulate candidate
  │   │       │       └─ evaluateLeaf(): deterministic successor OR all chance outcomes
  │   │       ├─ simulate selected action AGAIN
  │   │       └─ repeat until terminal / handoff H / cycle / action cap
  │   └─ backprop only completed simulations
  ├─ extractPlan()  // principal line + rollout-policy completion
  └─ return diagnostics
```

关键源码位置：

| 行为 | 位置 |
| --- | --- |
| UCB1 与 MAX/MIN | `PPC-MCTS-01/proto/uct.ts:499-516` |
| 未访问边优先 | `uct.ts:505-508` |
| 决策节点展开 | `uct.ts:409-419` |
| 机会节点采样与回传 | `uct.ts:380-405` |
| 深度交接 | `uct.ts:192-194`, `uct.ts:554-555`, `uct.ts:378` |
| deadline / 仅完整 simulation 提交 | `uct.ts:298-314`, `uct.ts:368-373`, `uct.ts:536-539` |
| rollout 主体 | `uct.ts:519-564` |
| guidanceValue | `uct.ts:208-220` |
| selectRolloutAction | `uct.ts:222-245` |
| 根动作选择（访问数最大） | `uct.ts:576-584` |
| 计划提取与补全 | `uct.ts:598-647` |
| Hybrid 评估 | `src/game/ai/hybridLeaf.ts:214-224` |
| 3 张 BFS 地图/Voronoi | `src/game/ai/evaluation.ts:448-483` |
| evaluateForCat 入口 | `src/game/ai/evaluation.ts:729-757` |
| ValueNet 前向 | `src/game/ai/hybridLeaf.ts:124-142` |
| 合法动作的有效性验证 | `src/game/ai/legalActions.ts:32-56` |
| CHANCE 结果构造 | `src/game/ai/simulator.ts:53-73`, `simulator.ts:107-137`, `simulator.ts:166-182` |
| RACE 固定臂 | `PPC-MCTS-01/proto/race.ts:47-61` |

---

## 2. 对本轮重点问题的源码结论

### A. Hybrid Evaluation Cost

- **[源码]** UCT-H 的每次“叶评价”只调用一次 `hybridEvaluateForCat`；`evaluateLeaf` 先判终局，终局直接返回 ±1，不调用 Hybrid。
- **[源码]** `hybridEvaluateForCat` 在 eligible 状态下执行：
  1. `isHybridEligibleState`（配置/阶段/pending/debt/整盘 wall-void 扫描）；
  2. `evaluateForCat`：一次 `buildContext` 内做 3 张 BFS（mouse、cat、carrying-hole）+ 10×10 Voronoi 扫描；
  3. `productionValueNet`：808 维特征、稀疏第一层 128、第二层 64、输出层 64。
- **[源码]** ineligible 状态（非标准配置、非 Playing、pending ghost、placement debt、wall/void）只执行一次 `evaluateForCat`；异常路径会再调用一次 `evaluateForCat` fallback。
- **[源码]** 单次 `evaluateForCat` 内部的 BFS 只构建一次，features / Voronoi / contributions 复用同一 context；不是“每个特征各跑一次 BFS”。
- **[源码]** 跨调用没有评价缓存：相同 `stateKey` 的叶子/滚动状态会重新执行完整评估。
- **[源码]** `generateLegalSearchActions` 对每个需要验证的候选动作先 `simulateSearchAction` 再比较状态；该成本发生在树展开、rollout 每一步、计划补全每一步，且没有按状态缓存。
- **[源码]** UCT-R 的 rollout 不调用 `guidanceValue`，只在 simulation 的最终叶调用一次 `evaluateLeaf`。

### B. UCT Tree Expansion

- **[源码]** UCB1：

```text
score = (cat ? Q : -Q) + c * sqrt(ln N / N_a),  c = sqrt(2)
```

  `Q` 始终是猫视角；猫节点取最大，鼠节点取最小。子节点 `meanReward` 在回传时统一为猫视角。
- **[源码]** 未访问边直接返回；同分边用 seeded `policyRng` 选择，不使用 `Math.random`。
- **[源码]** 决策节点首次访问时一次性展开全部合法动作；不采用 progressive widening。因此每个新决策节点的前 B 次访问会先覆盖 B 条未访问边。
- **[源码]** CHANCE 节点按权重采样；每个 outcome 懒创建自己的 decision child；CHANCE 节点本身参与回传，但不在 CHANCE 层做 UCB 选择。
- **[源码]** 循环检测使用完整 `stateKey`：树内路径 `keys` 在每个 simulation 开始时只含根；rollout 也维护自己的 `keys`。没有跨 simulation 的全局 visited/transposition 去重。
- **[源码]** 深度只在 `currentPlayer` 改变时 +1；`maxHandoffs = 4`。零步动作不增加交接。
- **[源码]** deadline 在每次 simulation 前和 rollout 循环内检查；只有 `completed` 的 simulation 才回传并计入 `sims`。第一次 simulation 允许越过 deadline 完成（`allowOverrunForFirst`）。
- **[源码]** `extractPlan` 只沿“访问最多的已存在子边”前进；遇到 CHANCE 边界或交接停止；树未覆盖到交接时，用同一 rollout 策略补全，并单独记录 `extensionSteps`。

### C. Rollout Policy

- **[源码]** UCT-H 对**全部**合法动作调用 `guidanceValue`，不是抽样动作。
- **[源码]** `guidanceValue` 对候选动作先模拟；确定性结果评价一次；CHANCE 结果对**每个 outcome** 评价一次，再按权重求期望。
- **[源码]** 选定动作随后被再次 `simulateSearchAction`，用于真正推进状态；候选模拟结果没有复用。
- **[源码]** 猫方取最大、鼠方取最小；同分用 seeded policy RNG 选择。
- **[源码]** UCT-R 用均匀 seeded 随机，不做候选评价。
- **[源码]** rollout 终止条件：终局、`handoffs >= maxHandoffs`、重复 `stateKey`、`steps >= maxRolloutActions`（默认 40）、deadline（非第一次 simulation）。
- **[源码]** 机会采样使用单独的 `chanceRng`，策略随机使用 `policyRng`，两者均从 call seed 派生，与 WORLD / 鼠策略 RNG 独立。

### D. Root Visit Distribution

- **[源码]** 根动作由访问次数最大者选择；平局按动作 key 字典序，不按 Q 值。
- **[源码]** 根动作的 visits 是其子节点 `visitCount`；根 `rootVisits` 等于完整 simulation 数。
- **[日志]** 72 条 smoke 中，UCT-H 的合法根动作均值为 3.79，全部根动作都有访问；根访问分布接近均匀（见 §3 与 `ROOT_VISIT_ANALYSIS.json`）。
- **[源码]** 根动作的 `transitionKind` 为 CHANCE 时，根边仍按 UCB 访问；CHANCE 只影响后续 outcome 与回传值。smoke 中 UCT-H 的 chance 根边数为 0。
- **[统计]** 机会采样与根访问集中度存在中等相关，但这是下游关联，不是因果；详见 `ROOT_VISIT_ANALYSIS.json` 与 `FINDINGS.md`。

### E. Plan Extraction

- **[源码]** `treePlanLength` 是主路径中实际存在于树的动作数；`extensionSteps` 是 rollout 策略补全的动作数；二者在 `UctResult` 中分开。
- **[源码]** 树内计划在 CAT→MOUSE 的 CHANCE 边界保留最后一步猫动作，然后停止。
- **[源码]** `planActionCost` 使用真实 `mateActionCost`：`catStep = 1`，`catPlaceTrap = 0`。因此“动作数”和“行动成本”不是同一个量。
- **[日志]** UCT-H 的 smoke 结果：`treePlanLength` 均值 2.50，`extensionSteps` 均值 1.67，22/24 根发生了补全；最终 plan 长度均值 4.17、planActionCost 全为 4。
- **[日志]** 72/72 计划经真实引擎 `catMove` / `catPlaceTrap` 回放通过，且完整消费猫回合；但真实回放只证明可执行性，不证明计划质量。
- **[统计]** UCT-H 的树证据只覆盖约 60.4% 的最终动作数，约 39.6% 来自 rollout 补全；不能把补全动作当成树搜索结果。

---

## 3. 原始 72 条 smoke 的直接统计

### 3.1 根访问与选择

| 指标 | UCT-H | UCT-R |
| --- | --- | --- |
| 根数 | 24 | 24 |
| 平均合法根动作 | 3.79 | 3.79 |
| 平均根访问（= simulations） | 25.0（中位数 12） | 233.6（中位数 130） |
| 归一化访问熵（0…1） | 0.979 | 0.989 |
| 平均有效动作数 `exp(H)` | 3.70 | 3.75 |
| 最高访问占比 | 0.332 | 0.324 |
| 选中动作 = 访问最高 | 24/24 | 24/24 |
| 最高与第二访问差 = 0 | 16/24 | 4/24 |
| 选中动作 = 平均回报最高 | 13/24 | 21/24 |

**[统计]** UCT-H 的根访问几乎均匀：3.79 个根动作、平均 25 次访问，最高动作也只占 33.2%；16/24 根的最高访问存在并列。选中动作“是访问最高”并不等于“是 Q 最高”。不能只用根动作一致率判断搜索质量。

### 3.2 Plan coverage

| 指标 | UCT-H | UCT-R | RACE |
| --- | --- | --- | --- |
| treePlanLength 均值 | 2.50 | 4.08 | n/a |
| treePlanLength 分布 | 2:14, 3:8, 4:2 | 4:22, 5:2 | n/a |
| extensionSteps 均值 | 1.67 | 0.04 | n/a |
| planExtended | 22/24 | 1/24 | n/a |
| 最终 plan 长度均值 | 4.17 | 4.13 | 4.17 |
| planActionCost 均值 | 4 | 4 | 4 |
| 真实引擎 replay 通过 | 24/24 | 24/24 | 24/24 |
| 完整回合 | 24/24 | 24/24 | 24/24 |

**[日志]** UCT-H 的 2.50 步树内计划不是“计划总长度只有 2.5”：最终计划仍是 4.17 个动作；缺少的约 1.67 步由 rollout 补全。树内搜索证据只覆盖 60.4%。

---

## 4. 诊断复跑说明

`PPC-MCTS-01A/diagnostics/entry.ts` 使用**未修改**的 `UctSearch` 与 harness 常量复跑 24 根 × 2 臂，读取 `UctDiagnostics` 中 smoke 未持久化的 `rolloutSteps`、`chanceNodes`，并读取 `evaluation.ts` 自带的评估/BFS 计数器。该复跑不是新的正式 benchmark，原因是：

- 外部 `ai-reliability` 最终评测与 docmap-studio 服务仍在运行；墙钟受污染。
- deadline-bound 搜索的 simulation 数会随机器负载变化：复跑 UCT-H 均值 34.6、smoke 25；复跑 UCT-R 均值 351、smoke 233.6。
- 因此本报告以 smoke 的 24 根分布回答“为什么是 2.50”，以复跑的调用计数/比率解释成本结构，不把复跑的绝对次数当成正式结果。

**[统计]** 复跑的调用比率与 smoke 的 simulation 比率一致：UCT-H / UCT-R 的每 simulation CPU 成本约 9.16×，smoke 的 simulation 数约 9.34×；两者相互印证。

---

## 5. 变更与隔离声明

- 本轮只新增 `PPC-MCTS-01A/` 下的审计文档、只读诊断入口、分析脚本与 JSON；没有编辑 PPC-MCTS-01 的源码、smoke 或 RACE。
- 诊断入口只实例化原类并读取既有计数器；没有 patch evaluator、没有替换规则、没有改变 UCB/rollout/plan 逻辑。
- 复跑了原有 14 项 PPC 正确性测试：14/14 通过（1.78s，`logs/tests-rerun.txt`），没有减少原覆盖。
- 所有结论按 [源码] / [日志] / [统计] / [假设] 标注；未把 smoke 或 24 根诊断冒充正式对抗强度实验。
