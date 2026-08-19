# Phase E0 — Evaluation Foundation + Benchmark Corpus · 最终报告

> 状态：**已完成并停止**（按 spec #24，未进入权重调优 / Voronoi 计分 / Legacy Hard 权重迁移 / Hard 接线 / wall-clock·Worker）。
> 所有新增代码位于 `src/game/ai/evaluation.ts`，语料与测试位于 `src/game/ai/__tests__/evaluationCorpus.ts` 与 `evaluation.test.ts`。

---

## 1. 当前 baseline evaluator 到底在算什么

项目里**同时存在两个 evaluator**，必须区分清楚：

| 名称 | 位置 | 角色 | E0 是否改动 |
|---|---|---|---|
| `defaultLeafEval` | `expectiminimax.ts` | **线上搜索真正使用的叶节点估值**（猫 = MAX） | 未碰（spec #22） |
| `evaluateForCat` / `evaluateForCatDetailed` | `evaluation.ts` | **E0 新建的可解释估值基础**（未来 Phase F 才接线） | 新建 |

线上 `defaultLeafEval` 的公式（未变）：

```
score = 200 − manhattan(cat, mouse) × 5 − (mouseHasButter ? 60 : 0)
```

它**只**用「猫鼠曼哈顿距离 + 是否持黄油」两个量，纯 O(1)、无规则感知（不区分隧道/陷阱/盒堆/洞口通道），也无法解释「为什么这个分数」。

Phase B 的 `evaluateForCat` 桩（非终局一律返回 `0`）已在 E0 被**整文件重写**为规则感知、纯函数、可解释的特征提取 + 贡献拆解。

> **关键结论（spec #22）**：E0 **没有**改变 AI 的任何行为——搜索在 E0 期间仍调用 `defaultLeafEval`。新的 `evaluateForCat` 是并行建设的地基，仅在 E1 / Phase F 才被接线采纳。性能基线测量时曾临时把新估值器注入 `leafEvaluator`（仅测速，不进生产路径）。

---

## 2. 新 EvaluationFeatures 字段（`extractEvaluationFeatures`）

| 字段 | 含义 | 来源 |
|---|---|---|
| `catMouseDistance` | 猫→鼠规则感知最短距（不可达=`null`） | 猫图 BFS |
| `mouseGoalDistance` | 持黄油时 鼠→洞口 最短距；不持=`null`（非胜，不造假） | 鼠图 BFS |
| `mouseButterDistance` | 不持黄油时 鼠→最近黄油 最短距 | 鼠图 BFS |
| `mouseMobility` / `catMobility` | 合法步数 | 邻居枚举 |
| `mouseReachableArea` / `catReachableArea` | 可达格数（含起点） | 距离图尺寸 |
| `openTunnelCount` / `blockedTunnelCount` | 开放/封锁隧道角数 | 配置+封锁集 |
| `mouseCanUseTunnel` | 开放隧道>0 且 (!持黄油 ∥ 技能激活) | GAMEPLAY 规则 |
| `mouseHasButter` / `mouseSkillActive` | 状态位 | 直接读取 |
| `catHasTrapAvailable` / `trapActive` / `trapDistanceToMouse` | 猫陷阱库存 / 场上陷阱 / 陷阱→鼠距 | 状态+鼠图 BFS |
| `currentPlayer` / `catMovesLeft` / `mouseMovesLeft` | 轮次与剩余步数 | 直接读取 |

返回结构 `EvaluationBreakdown = { total, features, contributions, clamped }`。
外部入口 `evaluateForCat(state): number` 直接返回 `evaluateForCatDetailed(state).total`；测试/语料用 detailed 版做可解释性断言。

---

## 3. Rule-aware distance 语义（spec #5/#6/#9）

两套独立 BFS 图，统一用 `number | null`（可达距 / 不可达=**`null`**，绝不填 999999）：

- **鼠图**：正交四邻 + 隧道传送边（仅未封锁角）；尊重盒/堆/猫不可入、洞口可入、隧道条件可达；**持黄油且未激活技能 ⇒ 隧道传送边不可用**。
- **猫图**：仅正交四邻（不含传送）；洞口/隧道/黄油/堆/虚空/墙/盒均不可入；**猫可踏上鼠所在格（即抓捕/胜）**——这是 E0 修复的一个真实 bug（原 `catCanEnter` 排除了鼠格，导致猫永远“够不到”鼠、捕获压力恒为 `null`）。

导出内核：`buildMouseDistanceMap` / `buildCatDistanceMap` / `bfsMouseDistance` / `bfsCatDistance`（供 E0-C/E0-D 直接测试）。

**`mouseGoalDistance` 语义（spec #8）**：仅当持黄油时返回「鼠→洞口」距离；不持黄油时返回 `null`（到达洞口≠胜利，不做语义造假）。E1 再加「不持黄油时的两阶段 planner」。

---

## 4. 已实现 / 仅预留 的 feature（spec #7/#12/#5）

**已实现并计分（7 项贡献）**：
`capturePressure`（猫鼠距）、`mouseGoalThreat`（持黄油→洞口，方向已修正，见 §6）、`butterRace`（鼠→黄油距）、`confinement`（可达面积比，按棋盘规格归一化 spec #18）、`mobility`（合法步差）、`trapControl`（陷阱靠近鼠）、`tunnelControl`（鼠可用隧道则扣猫分）。

**仅预留 / 本期未实现**：
- **Voronoi 领地划分**（spec #12）——E0 只做距离图，接口预留。
- **猫 vs 盒/堆的 `pushOpportunity` / `tunnelBlock`**（spec #5 v1 约定：盒/堆在猫图里暂作障碍，不做推箱收益计算）。
- **不持黄油时的两阶段 planner**（spec #8，E1）。
- **CHANCE 节点对黄油再生的期望加权**（spec #14）——语料只记录 `CHANCE` 类局面，估值器保持确定性，不预测未来随机。

---

## 5. 语料（corpus）局面数量与类别（spec #13/#14）

`EVALUATION_CORPUS` 共 **23** 个手工局面（`{ name, state, tags, expectations }`），覆盖 9 类：

1. 捕获压力（near / far）
2. 黄油·携带（near hole / far hole）
3. 黄油竞速（鼠近黄油 / 鼠远黄油）
4. 隧道（open / blocked / carry-forbidden / skill-active）
5. 陷阱（near / far / 有库存 / 无库存）
6. 盒/隧道封堵
7. 机动性（开阔 / 被困）
8. 节奏（猫回合 / 鼠回合）
9. CHANCE（可拾黄油 / 无黄油可拾）

**期望三类（spec #16）**：
- `RULE`：必须满足的硬不变量（断言）。
- `STRATEGIC`：相对关系（betterThan / worseThan），供 E1 调权，**非门禁**。
- `OBSERVATION`：仅记录分数，无对错。

**结果**：`RULE 31/31 全过` · `STRATEGIC 11/12` · `OBSERVATION 2`。
唯一未过的 STRATEGIC 是 `butter_not_carry_same`：被**全局 `mouseCanUseTunnel` 标志**连累——只要棋盘任意角有开放隧道，即使鼠所在口袋根本到不了，也会对猫扣分。这是 E1 的真实设计提示（隧道特征应按「可达性/包含关系」而非全局布尔），不是阻断项。

其余 11/12 STRATEGIC 通过，说明特征方向整体正确（含 E0 修复的黄油威胁方向，见 §6）。

---

## 6. 修复的一个语义 bug（方向修正）

原 `mouseGoalThreat = -mouseGoalDistance × W` 把「**离洞口越远**」判得**更糟**——方向反了。正确语义：鼠持黄油离洞口越**近**，对猫威胁越大（`-W / dist`，随距离缩小惩罚增大；与 `capturePressure` 用同一「高=对猫好」约定但方向相反，符合直觉）。

修复后 STRATEGIC 从 9/12 → 11/12，且 `butter_carry_near_hole < butter_carry_far_hole` 这类「近洞口更危险」的关系现在方向正确。这是**语义正确性修复，非权重调优**（权重值未动，spec #7）。

---

## 7. 当前 evaluator 是否真正改了行为？

**没有。** 搜索在 E0 全程仍调用 `defaultLeafEval`（`expectiminimax.ts` 内 `evaluateLeaf`）。新的 `evaluateForCat` 是隔离的新地基，E0 未接线（spec #22）。因此：
- 现有的 110 个搜索/转置/AB/排序/迭代深化测试全绿（本次总测试 **123 passed**）。
- 无 AI 决策回归。

---

## 8. Legacy Hard 特征盘点（spec #21，仅登记，不抄魔法数）

读取 `catAiHard`（`engine.ts` ~2225）后登记其有价值思路（**不**复制其魔法数计分）：

- 即时抓捕：猫→鼠 BFS 距离 1 ⇒ 抓（已对应 `capturePressure`）。
- 鼠计划 `buildMousePlansForHard`：carry_to_hole / go_to_butter / skill_chain_butter（对应 `mouseGoalThreat` / `butterRace`，但 E0 未做两阶段 planner，留 E1）。
- 洞口门控 `getMouseHoleGateCells` + 洞口防守（角/边/开阔三态）——E1 可沉淀为 `holeControl` 特征或并入 Voronoi。
- 紧急封洞、陷阱驻守 + 绕箱代价（`boxPushBfs`）、路径上拦截 `findBestReachableInterceptOnMousePath`——对应 `trapControl` / `mobility` 的更细粒度版本，预留。
- 隧道限制（持黄油禁用）——**已在 `mouseCanUseTunnel` 实现**。
- 机动性比较——已在 `mobility` 实现。

> 结论：Legacy Hard 的“思路”已被新特征覆盖或预留；其硬编码权重不在 E0 迁移范围（spec #21 / #24）。

---

## 9. Evaluation 性能 baseline（spec #19，仅记录）

测量环境：vite-node（dev，未优化编译），故**绝对毫秒数偏高是正常的**；重点看**相对关系**与**架构成本**。

| 项目 | 数值 |
|---|---|
| 基准局面 | 开阔 10×10，猫(4,4) 鼠(6,6)，moves 2/2，depthTurns=3，TT+AB+Order |
| 线上 `defaultLeafEval` | 2455 节点 · 完成深度 3 · **104 ms** |
| 新 `evaluateForCat`（仅测速注入） | 4694 次叶估值 · 完成深度 3 · **753 ms** · ~160 µs/叶估值 |
| **相对减速** | **≈ 7.2×** |
| 独立微基准 | 36000 次估值 / 7858 ms → **≈ 218 µs/次** |

**核心发现（Phase F 接线决策的关键）**：新估值器每次调用会**构建 2 张全棋盘 BFS 距离图**（猫图 + 鼠图），本质是 O(棋盘面积)，远高于线上 O(1) 曼哈顿叶估值。这是 7× 减速的根源。

> 缓解方向（**不在 E0 实现**，仅登记供 E1/Phase F）：距离图增量更新/缓存（不要每个叶节点从零重建）、惰性特征提取、按深度/采样估值、每个搜索节点算一次距离图而非每个叶节点。

**元数据计数器（spec #20）**：`resetEvaluationCalls()` / `getEvaluationCalls()` 记录估值调用次数，纯元数据、**不影响返回值**，已通过 E0-A 断言验证。

---

## 10. 验证（tests / typecheck / lint）

| 检查 | 命令 | 结果 |
|---|---|---|
| E0 专项测试 | `vitest run evaluation.test.ts` | **12/12 passed**（E0-A…E0-L） |
| 全流程测试 | `vitest run` | **123 passed（110 旧 + 13 新）** |
| 类型检查 | `tsc --noEmit -p tsconfig.app.json` | **clean（exit 0）** |
| 模块 lint | `eslint 'src/game/ai/**'` | **clean（exit 0）** |

E0-A…E0-L 覆盖：纯函数/确定性/冻结输入/无 RNG·时钟（A）、`HEURISTIC_LIMIT < MATE_SCORE` 与钳制（B）、鼠图可达/不可达=`null`/隧道路由（C）、猫图排除洞口/隧道/黄油（D）、`mouseCanUseTunnel` 黄油规则（E）、开放/封锁隧道计数（F）、`mouseGoalDistance` 仅持黄油有效（G）、机动性/可达面积（H）、棋盘规格 5×5~20×20 归一化（I）、message/log/debug 不变性（J）、语料有效性 + RULE 硬门禁（K）、搜索仍用 `defaultLeafEval` 且 TT/AB/排序在 3×3 竞技场返回 `completed:true, mate:'cat'`（L）。

---

## 11. 冻结规则合规（spec #0）

估值器**只读取**合法的 `GameEngineState`，**不发明任何规则**：不改合法动作、回合规则、步数、黄油规则、黄油随机再生概率、鼠技能、隧道、陷阱、推箱、胜负条件、搜索深度语义、Expectiminimax / TT / Alpha-Beta / Move Ordering / Iterative Deepening。不可达统一用 `null`，不伪造大数。

---

## 下一步（不在 E0 范围，留待 E1 / Phase F）

1. 权重调优（基于 12 条 STRATEGIC 关系 + 11/12 已对齐的方向）。
2. 修复 `mouseCanUseTunnel` 的全局标志连累（改为可达性/包含感知）——解 `butter_not_carry_same` 残留。
3. Voronoi 领地特征（spec #12）。
4. 不持黄油的两阶段 planner（spec #8）。
5. 距离图缓存/增量，消除 7× 估值成本（Phase F 接线前必做）。
6. 将 `evaluateForCatDetailed` 接线为搜索叶估值（spec #22），并回归比对 `defaultLeafEval` 行为。
