# PPC-MCTS-01A — TREE_EXPANSION_AUDIT

**问题**：UCT-H 的树为什么平均只长出 2.50 步的猫回合计划？UCB1、CHANCE、循环检测、深度交接和 deadline 提交规则各自贡献了什么？

证据标签：**[源码]** / **[日志]** / **[统计]** / **[假设]**。

---

## 1. 树结构与选择公式

### 1.1 节点/边

- **[源码]** 决策节点保存 `state`、`currentPlayer`、`handoffs`、`expanded`、`legalActions`、`childNodes`（`uct.ts:100-160`）。
- **[源码]** 边保存 `action`、`key`、`transitionKind`、`child`；CHANCE 节点是独立节点类型，每个 outcome 有一条带权边和自己的 `samples` 计数（`uct.ts:120-180`, `409-480`）。
- **[源码]** 第一次访问某决策节点时，`generateLegalSearchActions` 枚举全部合法动作并一次性建立所有边；`expanded=true`（`uct.ts:409-419`）。边本身不会“按需逐个生成”，只会按需创建 child。

### 1.2 UCB1 与视角

```text
maximize = node.currentPlayer === Cat
score    = (maximize ? Q : -Q) + c * sqrt(ln(max(1,N)) / n)
```

- **[源码]** `uct.ts:499-516`；`c = sqrt(2)`；`Q = child.meanReward`（根视角，猫收益）。
- **[源码]** 猫节点取 `Q` 最大，鼠节点取 `-Q` 最大，即鼠最小化猫收益；这是零和视角，不是两套独立价值。
- **[源码]** 回传：`backprop` 对路径上每个节点 `visitCount++`、`totalReward += reward`，`meanReward = totalReward / visitCount`（`uct.ts:566-573`）。CHANCE 节点也按同一 reward 回传，因此 chance 边的均值是“被采样 outcome 的经验均值”，不是解析期望。
- **[源码]** 未访问边优先：`if (!edge.child) return edge; if (n === 0) return edge;`（`uct.ts:505-508`）。这决定了展开顺序：**按合法动作枚举顺序，宽度优先**。

### 1.3 为什么展开是宽度优先（关键）

每次 simulation 最多创建一个新的决策 child（以及可能的 chance 节点）。由于“未访问边优先”且按枚举顺序返回：

- sim 1：展开根，创建第 1 个根动作 child，rollout；
- sim 2：根的第 2 条边仍无 child，创建第 2 个 child；
- …
- 根有 3.79 个合法动作，因此前约 4 个完整 simulation 才把根层铺满；
- 之后才按 UCB 下探，再花若干 simulation 把下一层铺开。

**[源码]** 该行为直接来自 `selectEdge` 的未访问优先分支和 `applyEdge` 的单 child 创建；不是实现 bug，但意味着**固定 100ms 下 simulation 数越少，树越倾向于“宽而浅”**。

---

## 2. CHANCE 节点

- **[源码]** 只有两类 transition 产生 CHANCE：鼠步吃黄油（`simulator.ts:53-73`）和 CAT→MOUSE 边界存在 pending ghost/debt（`simulator.ts:107-130`）。
- **[源码]** chance outcome 权重均匀（1/N，N=合法 spawn 格数），`validateChance` 检查加权和；根动作的 transitionKind 在 smoke 中从未是 chance（`rootsWithChanceRootEdge=0`，[统计]），chance 均在根以下。
- **[源码]** 树内 chance 节点每次被经过时只采样 **1 个 outcome**，`chanceSamples++`，该 outcome 的 child 若不存在则创建；随后继续从该 outcome 下探（`uct.ts:380-405`）。
- **[源码]** rollout 内的 chance 同样只采样 1 个 outcome，`chanceSamples++`；不会枚举所有 outcome 求期望（`uct.ts:545-550`）。
- **[源码]** chance 节点的 `meanReward` 是样本均值，访问数等于被采样次数，不是所有 outcome 的访问数；这会让 chance 边的高方差直接进入 UCB。

### 2.1 基数

- **[统计]** 随机游走探针的 21 个吃黄油状态：outcome 数 min 24 / P50 28 / P95 34 / max 34 / mean 28.1（`data/chance-cardinality.json`）。
- **[统计]** 诊断中 UCT-H 平均每根 1.17 个 chance 节点、16.1 次 chance 采样，约 `0.742` 次/simulation；UCT-R 为 50.8 个 chance 节点、170.5 次采样，约 `0.541` 次/simulation。
- **[统计]** 每个 chance 采样增加一次树内节点创建或 rollout 跳转；在 UCT-H 中，一个被选中的吃黄油候选会在 guidance 阶段展开约 24–34 个 outcome 叶评价（见 EVALUATION_COST_AUDIT），但树内只采样 1 个。
- **[假设]** 由于每个 chance 节点只采样 1 个 outcome，若某 outcome 一直不被采到，它的子树不会被建立；根层 `chanceSamples` 与访问分布的负相关（`-0.541`）与此一致，但不能单独证明因果。

---

## 3. 循环检测、深度交接与终止

### 3.1 循环检测

- **[源码]** 每次 simulation 维护 `keys: Set<stateKey>`，初始含根；树下降时遇到已在集合中的 child，就把该 child 加入 path 并 `break`，从该状态开始 rollout（`uct.ts:393-399`, `435-443`）。
- **[源码]** rollout 内同样维护 `keys`；`steps++` 后若后继 key 已存在，则把该状态设为当前状态并 `break`（`uct.ts:558-561`），最后仍以一次 `evaluateLeaf` 结束。
- **[源码]** keys 是**单条 simulation 路径内**的去重，不是跨 simulation 的 transposition table；同一状态在后续 simulation 中会再次被展开/评价。

### 3.2 深度交接

- **[源码]** 节点记录 `handoffs`，每次 `currentPlayer` 改变 +1；`maxHandoffs=4` 时树下降和 rollout 都停止（`uct.ts:378`, `535`）。
- **[源码]** 这意味着一次 simulation 最多跨 4 次回合交接；从猫回合中段出发，通常只能覆盖“猫剩余步 + 鼠回合 + 下一次猫回合”的一部分。
- **[统计]** 诊断中 UCT-H `maxHandoffsReached` 均值 3.96（24 根中 23 根为 4，G6T3 为 3）；UCT-R 全部为 4。smoke 记录没有持久化 `maxHandoffsReached`，因此不对 smoke 作同类断言。
- **[源码]** `extractPlan` 只沿“当前 actor 仍是猫且边为 deterministic”的最访问 child 下走，遇到 handoff / chance / 终局即停；因此树计划长度天然 ≤ 猫在本次回合剩余的动作数，也 ≤ 树实际展开的猫层数。

### 3.3 deadline 提交

- **[源码]** 外层循环每次开始检查 deadline；第一次 simulation 允许超时（`allowOverrunForFirst`），之后只要 `now() >= deadlineAt` 就停止（`uct.ts:298-314`, `368-373`）。
- **[源码]** simulation 内部在树下降和 rollout 的每一步都检查 deadline；一旦触发返回 `completed=false`，该 simulation **不回传、不计数**（`uct.ts:449`, `536-539`）。
- **[源码]** `postDeadlineNodeCreations` 记录 deadline 之后仍创建的节点；诊断 24 根中为 0，说明没有“超时后继续扩张”的提交污染。smoke 记录没有持久化该字段，不作同类断言。
- **[统计]** smoke 24/24 UCT-H 根 `deadlineFired=true`，`budgetFired=false`；诊断中同样 24/24 deadline、0 node cap。搜索的停止原因是时间，不是节点上限。
- **[统计]** 诊断中 UCT-H 20/24 根出现过被丢弃的 aborted simulation，UCT-R 11/24；被丢弃的 simulation 不进入访问统计，因此最终树只包含已完成搜索的证据。

---

## 4. 2.50 步的直接解释

### 4.1 原始 72 条 smoke 的分布

| 指标 | UCT-H |
| --- | ---: |
| `planTreeLength` 均值 | **2.50** |
| 分布 | 2 步：14 根；3 步：8 根；4 步：2 根 |
| `planExtensionSteps` 均值 | 1.67 |
| 分布 | 0 步：2；1 步：6；2 步：14；3 步：2 |
| 最终 `planLength` 均值 | 4.17 |
| 根动作数均值 | 3.79 |

**[统计]** 树计划 2.50 + 补全 1.67 ≈ 4.17，且 22/24 根发生补全。也就是说，最终 4 步左右的完整猫回合计划里，**约 60.4% 的动作有树内访问证据，39.6% 来自 rollout 策略补全**。

### 4.2 与 simulation 数的关系

| `planTreeLength` | 根数 | 平均 simulations |
| ---: | ---: | ---: |
| 2 | 14 | **8.21** |
| 3 | 8 | **25.13** |
| 4 | 2 | **142.00** |

- **[统计]** `simulations` 与 `planTreeLength` 的 Pearson 相关为 **0.724**；`simulations` 与 `extensionSteps` 为 **-0.660**；`planTreeLength` 与 `extensionSteps` 为 **-0.866**。
- **[统计]** 14 个 2 步根中，simulation 数范围 3–16，均值 8.2；这正是“根层 3–4 条边尚未全部铺满、更深的猫层还没轮到”的区域。
- **[统计]** 2 个 4 步根（G5T4 214 sims、G6T3 70 sims）把均值从个位数拉到 142；G5T4 单根贡献了 UCT-H 总 simulation 的约 35.7%（214/600）。因此 **25.0 的均值被少数高预算根显著抬高，中位数只有 12**。
- **[统计]** 反过来，`extensionSteps` 与 `simulations` 负相关；树越浅、补全越多。最终计划长度稳定在 4–5，掩盖了树内证据深浅的巨大差异。

### 4.3 结构性原因（不是单一“参数太小”）

1. **宽度优先展开**：根有 3.79 个动作，至少约 4 个 simulation 才铺完根层；每个新深度还要再铺一层。[源码]
2. **每 simulation 只新增约 1 个决策节点**（加 chance 节点），25 个 simulation 无法同时深且宽。[源码 + 统计]
3. **每次 simulation 的叶评价约 34–45 次**，100ms 只够 25 次完整 simulation（smoke）——预算被 rollout 的候选评价吃掉，而不是被树展开吃掉。[统计，详见 EVALUATION_COST_AUDIT]
4. **H=4 的交接上限**截断深度；即使预算充足，一次 simulation 也不会无限深入。[源码]
5. **根动作几乎全被访问**（97.8% 归一化熵，top share 0.332），UCB 的探索项把访问摊薄到所有根边，而不是集中深挖一条线。[统计，详见 ROOT_VISIT_ANALYSIS.json]
6. **树计划是 principal line 的最访问链**，不是所有访问的并集；即使某个深层节点被访问过，只要不是每层的最访问 child，也不会进入计划。[源码 `uct.ts:598-625`]

**[统计]** 24 个根 fixture 的 `catMovesLeft` 全部为 4，因此 2.50 步**不是**“猫本来只剩 2–3 步”造成的；猫回合本身有 4 个行动成本可用。部分根最终计划有 5 个动作，是因为 `catPlaceTrap` 成本为 0、不消耗步数，动作数与行动成本不能混为一谈。

### 4.4 不能从现有数据推出的结论

- **[假设]** “增加 simulation 数就一定会让树计划变长”只在当前展开策略下成立；若同时增加分支/CHANCE 采样，边际深度可能很低。
- **[假设]** 2.50 是否导致棋力下降，本轮没有对弈强度证据；只能确认树内证据覆盖不足，不能确认这是 UCT-H 弱于 UCT-R 的原因。
- **[统计]** `simulations` 与 `planTreeLength` 的相关不等于因果；高 simulation 根可能本身分支更少、chance 更少、单 sim 更便宜。

---

## 5. 结论摘要

- UCB1 与猫/鼠零和视角实现正确；未访问边优先导致**宽度优先展开**。[源码]
- CHANCE 在树内每访问采样 1 个 outcome，权重均匀，回传为样本均值；一个吃黄油机会的基数约 24–34。[源码 + 统计]
- 循环检测仅在单条 simulation 内生效；没有跨 simulation 去重。[源码]
- deadline 只提交完整 simulation，超时节点创建为 0；所有根均因 100ms 截止而停止。[源码 + 统计]
- 2.50 步是“根层宽、预算浅、每 sim 贵、H=4 截断、principal line 只取最访问链”共同作用的结果，而不是某一行代码把深度硬编码为 2。[源码 + 统计]
- 最终 4.17 步计划中约 39.6% 来自 rollout 补全，不能把最终计划长度当作树搜索深度。[统计]
