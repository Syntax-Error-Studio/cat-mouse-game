# 缓存契约最终勘误（隔离研究契约，不接生产缓存）

Round: `PPC-G6T2-DECISION-RISK-CAUSAL-01` · Phase: G1
数据来源: `logs/g1_recompute.json`、`logs/g1_inclusion.json`、`logs/g1_chance_endpoint.json`（由 `probe/g1_cache_errata.test.ts` 从冻结的 G6T2 110 条完整猫回合计划重算）
本轮**没有**新增任何生产缓存，也没有改动 `src/`。

---

## 1. 被比较的两份实现（同一真实计划）

| 实现 | 位置 | 单元格收集范围 | 末端读法 |
|---|---|---|---|
| production | `src/game/ai/planQuality.ts` → `countRevisits` / `planQualityForPaths` | 根 + 完整动作路径 + 规则；**包含**最终交接单元格（当所有正概率 outcome 的猫位置一致时追加） | 边界值 = 全部 outcome 的**加权期望** |
| research | `PPC-CAT-STRATEGY-SEAL-01/probe/css_lib.ts` → `features` | 根 + 动作路径，**在 CHANCE 边界前停止**；**排除**最终交接单元格 | `end` 系列字段读 `outcomes[0]` |

## 2. 重算结果（与冻结证据逐位一致）

- 110 条计划：`agree = 67`，`disagree = 43`。
- 43 条不一致**全部**是 `endKind === 'chance'`；`delta = productionRevisit − researchRevisit = +1`，无一例外。
- 分布复现：production `{0:36, 1:44, 2:27, 3:3}`，research `{0:56, 1:44, 2:10}`。
- `uniqueProgress` 差值分布 `{0:43, 1:67}`。
- 结论：67/43 不是"两套代码算法不同"，而是**同一算法在"是否包含最终交接单元格"上的定义差异**：最终单元格在 67 条路径里是新格子（uniqueProgress +1，revisit 不变），在 43 条路径里与更早的格子重复（revisit +1，uniqueProgress 不变）。

## 3. 最终猫动作的包含性（逐计划证明）

- production：`finalCatMoveIncluded = 110 / 110`。
- research：`finalCatMoveIncluded = 0 / 110`。
- `productionCells === researchCells + [finalCell]`：`110 / 110`。
- 判定：**"是否包含最终猫动作"是两实现的结构性差异，必须显式定义**，不能靠"它们大体一致"含糊过去。

**未来定义（本契约采用）**：缓存/特征语义以 **production 定义**为准 ——

1. 计划末端的交接单元格**计入**路径（因为它是对手下一回合真正面对的猫位置）；
2. 当且仅当 CHANCE 全部正概率 outcome 给出**同一**猫位置时才追加；否则**不**追加单个单元格，边界值改用全部 outcome 的加权期望；
3. `revisitCount` 与 `uniqueProgress` 必须使用**同一套**单元格序列计算。

## 4. 特征的缓存键作用域（关键勘误）

| 特征 | 计算作用域 | 能否仅凭 `endStateKey` 判定 |
|---|---|---|
| `revisitCount` | **根 + 完整动作路径 + 规则集** | **否**——同一末端可由不同路径到达，重访次数不同 |
| `uniqueProgress` | **根 + 完整动作路径 + 规则集** | **否**——同上 |
| `reversalCount` | **动作序列**（可选：序列前缀） | **否**——只依赖动作序列，与状态无关 |
| `boxesMovedVsRoot` | **根 + 末端** | 仅当根已固定 |
| `distanceDelta` | **根 + 末端** | 仅当根已固定 |
| `frontierCount` / `endKind` | **实际转移类型与 CHANCE frontier** | **否**——取决于最后一步转移的 kind，不是末端键本身 |
| CHANCE 相关末端字段 | 全部**正概率** outcome + 权重 + 规则上下文 | **否**——读 `outcomes[0]` 会丢失其余分支 |

**勘误结论**：任何"`endStateKey` 相同即可复用这些特征"的说法都是错误的。只有在 (根, 完整路径, 规则集) 三者都相同的情况下，`revisitCount` / `uniqueProgress` 才可缓存；`reversalCount` 只可以与动作序列绑定；末端类特征至少需要 (根, 末端) 二元组；CHANCE 末端必须保留全部正概率 outcome 与权重。

## 5. 独立登记的语义问题：CHANCE 端点

- G6T2 的 110 条计划**全部**以 CHANCE 交接结束。
- 本语料中每条计划的正概率 outcome 数为 1（`plansWithMultiplePositiveOutcomes = 0`），outcome 的猫位置一致数 `= 110`，`stateKey` 一致数 `= 110` —— 因此本轮**没有观测到** `outcomes[0]` 与加权期望给出不同数值的实例。
- 但两份实现的**读法不同**（production：全部 outcome 一致才追加 + 加权期望；research：`outcomes[0]`）。这是与 67/43 相互独立的语义问题：即使把 67/43 修好，若 CHANCE 出现多 outcome，`outcomes[0]` 仍可能给出错误末端。
- 登记为 **`CHANCE_ENDPOINT_SEMANTICS`**，规则：末端字段一律遍历全部 `weight > 0` outcome；只有全部一致时才允许压缩为单一端点值，否则保留分布并以权重求和为 1 的加权值参与评分。

## 6. 不做的事

- 不重新调试已被裁定的 NO-GO 多特征 ranker；
- 不在本轮引入生产缓存；
- 不把这份勘误当作生产代码变更（`PRODUCTION_WIRING = NO`）。