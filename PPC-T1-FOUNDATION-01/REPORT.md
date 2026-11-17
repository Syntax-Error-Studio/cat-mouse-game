# PPC-T1-FOUNDATION-01 — 多回合战术预判引擎：架构审计与正确性基础

**模式**: READ_ONLY_ARCHITECTURE_AUDIT
**仓库**: `F:\小猫小鼠`（唯一权威工作树）
**分支 / HEAD**: `ppc/p1-id-state-identity-fix` / `48eaac6c4f3801d351787696ba5876995b64e8d8`
**日期**: 2026-11-16
**生产源码改动**: 无
**规则改动**: 无
**搜索数学改动**: 无
**Sidecar / Guard / H1 / 100ms-150ms 改动**: 无

---

## 0. 结论摘要

1. **搜索引擎在结构上是完整的 MAX / MIN / CHANCE 期望搜索**，但不是“完整博弈求解器”。它按 actor 切换计深度、叶节点用静态评估、CHANCE 用期望、Alpha-Beta 只产生 bound、TT 只存完成的 exact 值。它可以返回**有界 mate**（终止节点真正到达时），但不能返回“猫存活”证明。
2. **深度的真实含义是“行动权切换次数”**，不是步数、不是回合数。`catPlaceTrap`、`mouseSkill`、同回合内多步都不减深度；隧道选择、踩陷阱、回合结束、CAT→MOUSE 幽灵边界各减 1（一次切换）。
3. **D1 = 完整猫回合**（含猫回合末的幽灵边界 CHANCE），叶在鼠行动；**D2 = 再加完整鼠回合**，叶在猫行动；**D3 = 再加猫回合**，叶在鼠；**D4 = 再加鼠回合**，叶在猫。终端判定先于深度截断。
4. **配置深度 ≠ 实际深度**。生产配置 `maxDepthTurns=4`；在冻结的 24 根 × 2 臂 × 5 轮 100ms 数据中：**37/48 组合只完成 D1，9/48 只完成 D2，2/48 在 D1/D2 之间波动；没有任何组合完成 D3 或 D4；最多只“尝试”到 D3；D4 从未被尝试**。主要截断原因是 100ms deadline（48/48 组合 5/5 轮触发），不是节点预算。
5. **量词视野与搜索视野不能直接等同**。在猫行动根（startIdx=0）上，量词 **H0 ↔ 搜索 D2**，**H1 ↔ 搜索 D4**；不是 H0=D1、H1=D2。在“猫计划已执行完、鼠行动”的前沿（startIdx=1）上，H0 = 前沿后 1 个 actor 切换、H1 = 前沿后 3 个 actor 切换；相对原始猫根仍是 D2 / D4 的边界，但猫第一回合被固定为已执行计划，不再参与搜索。
6. **量词证明很贵且可能不可判定**。同一冻结样本上，`catSurvive(H1)` 从 46 节点 / 1ms 到 215,922 节点 / 6.2s 不等；4 个根在 600k 节点 / 17–20s 处截断为 UNRESOLVED；G6T2 的独立重证总耗时 429,843ms（约 7 分钟）。**不能把 H1 量词证明假装塞进 100ms**。
7. **`bestAction` 不一定等于 `catTurnPlan[0]`**。`mate===null` 时 `extractBestCatTurnPlan` 会用等值主变替换计划；G5T1/E1 是明确反例：`bestAction=U`，D1 可执行计划与 100ms 实际计划都是 `DLUTR`。证书必须绑定**真实回放的执行前缀**，不能绑定根动作标签。
8. **当前生产没有任何“战术证明”**。Sidecar 是单边有界反驳探针（`PLAN_REFUTED` 是强正证据；`NO_REFUTATION_FOUND` / `INCOMPLETE` / `CHANCE_MIXED` 都是 UNKNOWN）；Guard 是默认关闭的根级救援；H1 叶没有可证明的 100ms 战术收益。唯一现实可行的新方向是**计划作用域的单边反线验证**（在已执行计划的前沿上做有界量词检查），且必须先做只读测量轮，不能直接生产接线。

---

## 1. 范围、方法与边界

本轮只做只读审计：

- 读取当前工作树 `F:\小猫小鼠` 的真实源码与既有 P1/P2/SEAL/ERRATUM 工件；
- 逐行核对搜索、模拟器、合法动作、规划器、Sidecar、Guard、量词内核；
- 从冻结工件中提取真实 100ms 深度分布、证书成本、量词分类；
- 不修改任何生产源码、规则、评估器、搜索数学、Sidecar、Guard、鼠 AI；
- 不运行完整回归、自对弈、穷举 oracle、METHOD_A、大搜索 benchmark、正式计时 benchmark；
- 不 commit / push / merge / reset / clean / stash。

**唯一权威**是当前本地工作树；GitHub HEAD 不能替代本地未提交候选。早期上传的 `GAMEPLAY.md` 不是当前权威；当前 `GAMEPLAY.md` 的 ruleset 2 才是。

---

## 2. 来源与资源核对

### 2.1 Git 状态

| 项目 | 值 |
|---|---|
| 分支 | `ppc/p1-id-state-identity-fix` |
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8` |
| 工作树（审计开始时） | 62 条未提交变更（15 个已跟踪源文件修改 + 1 个未跟踪生产模块 `preparedActions.ts` + 大量 PPC 工件目录）；本轮新增 `PPC-T1-FOUNDATION-01/` 工件目录 |
| 该状态是否为本轮新建 | 否；这是本轮之前已存在的 P1/P2 候选工作树 |

关键源码 SHA-256（本轮只读，未写入）：

| 文件 | SHA-256 |
|---|---|
| `src/game/ai/expectiminimax.ts` | `50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c` |
| `src/game/ai/hardTurnPlanner.ts` | `27b1ce6dc62234d0c822b2b0b6341205ac189b5f76d7662a5d29d9e17ded75ff` |
| `src/game/ai/simulator.ts` | `6d24d4f36d9f7e076fa36c9460ec51c674f1006f9cae00f7f5fb64771516df32` |
| `src/game/ai/preparedActions.ts` | `67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764` |
| `src/game/ai/legalActions.ts` | `27ae2f468d19043425326c2fc42923aeae894a5f84d2e0684ee374808b50eb22` |
| `src/game/engine.ts` | `099f9a7b6d97b838c664aa7186be58465e5b01b8052af4b4e4e19a5644d19f06` |
| `src/game/ai/deadlineContext.ts` | `ced449445d70d1ba88cb20d88415b3c641d670aa886536fcacefa36b4aa50235` |

### 2.2 规则身份

当前 `GAMEPLAY.md`：

`e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34`

该哈希与 `PPC-CAT-STRATEGY-01/SOURCE_MANIFEST.json`、`PPC-CAT-STRATEGY-SEAL-01/REPORT.md`、`PPC-MCTS-01/MANIFEST.json` 中冻结值一致。**未发现规则漂移**。

### 2.3 P2 Prepared Transition 身份

`PPC-P2-PREPARED-TRANSITION-01/SOURCE_MANIFEST.json` 记录 `preparedActions.ts` 的 post 哈希为
`67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764`，与当前文件完全一致；
`FINAL_DECISION.json` 的 PT-0 为 PASS，HEAD 未变、未提交。

### 2.4 证明工件身份

| 工件 | SHA-256 |
|---|---|
| `PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts` | `453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b` |
| `PPC-CAT-STRATEGY-SEAL-01/ROOT_CLASSIFICATION_V2.json` | `298c2c7018325a4639d4ef371a5a2ff1b5a829098636018235bf5905f262b0db` |
| `PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json` | `9d50560f107da52107cb68be94f4ac90214f8a50aabbc948f8f3114215278775` |
| `PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01/ERRATUM.md` | `1cf68d934e5061093aa4e708430aa2f755d1beaa88517e7fdad8af1f16d67b88` |
| `.../G1T3_E1_100MS_CERTIFICATE.json` | `2fc98a82f399be6232bd241bf4db565c4fdbecd1d838289788ef39c7cb4236fa` |
| fixture `ppcId01-human-roots.json` | `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09` |

ERRATUM 声明 48/48 组合的实际 100ms 计划均已被证书绑定；其 fixture 哈希与 P4/P5 一致。

### 2.5 已发现的两处工件级差异（可解释，不阻断本轮）

1. **G1T8 的类别标签**：`ROOT_CLASSIFICATION_V2.json` 标 `UNRESOLVED`（`h1MouseForcedWin=false`，但 `h1CatSurvive=null`），而 ERRATUM §8.5 说“G1T8 仍为 `CHANCE_DEPENDENT_OUTCOME`（P4 证据未改写）”。这是**同一根在不同内核/不同 cap 结果下的标签优先级差异**，不是规则冲突：V2 的 `survive` 搜索在 600,001 节点 / 17,006ms 处截断，因此 `survive=null` 必须压过 `mouseForce=false`。本报告对“安全性”一律采用 V2 的 `UNRESOLVED`，不把 P4 标签当作存活证据。
2. **G6T2 的根分类 vs 计划前缀证书**：`G6T2_RECERTIFICATION.json` 的根分类是 `UNRESOLVED`（H1 mouseForce 与 catSurvive 均在 600k 截断），但同一工件的 `DRRR` 前缀证书是 `PROVEN`（117,382 leaves / 31,236 branches / 549 chance nodes）。这**不是矛盾**：根证明要对所有猫第一回合动作做存在性搜索，昂贵的 D/L 兄弟分支先耗尽 cap，尚未走到 R；而 DRRR 是固定前缀，其子树本身可证。它恰好说明“根级量词”和“计划前缀量词”是两种不同问题，不能互相替代。

### 2.6 进程与资源

`tasklist` 显示 4 个 `node.exe` / 1 个 headless agent，命令行分别属于：

- `F:\docmap-studio` 的 Next dev server；
- `.local/ai-reliability-cont-20261115` 的评审/最终评估脚本；
- `@tencent-ai/agent-sdk` 的 headless agent。

**没有** `vitest.exe`，**没有**本仓库的 benchmark / self-play / 穷举 worker。上述进程是用户其他工作负载，本轮未启动、未终止、未干预。本轮没有运行任何 Node/Vitest 搜索 worker；所有统计均来自冻结 JSON/CSV 的文本读取。

---

## 3. Phase 1 — 真实搜索能力审计（10 问）

### Q1. 当前搜索是完整的 MAX / MIN / CHANCE 对抗搜索吗？

**结构上是；语义上要分三层看。**

- MAX / MIN：`searchActions` 以 `state.currentPlayer === PieceType.Cat` 决定 `maximizing`（`expectiminimax.ts:1254`），猫为 MAX、鼠为 MIN。
- CHANCE：`valueOfAction` 在 `transition.kind === 'chance'` 时对每个 outcome 以**满窗口** `_search`，返回 `Σ weight·value`（`expectiminimax.ts:1499-1542`）。
- 叶：`depthTurns <= 0` 时进入静态评估（`expectiminimax.ts:1605`），生产叶是 `evaluateForCat`（`hardTurnPlanner.ts:263`）。
- 终局：`CatWins` / `MouseWins` 在 `_search` 入口最先返回 ±`MATE_SCORE`（`expectiminimax.ts:1574-1581`），先于重复、深度、预算、TT。
- mate 分类：只有**所有** CHANCE outcome 都是同一方的 mate 时，CHANCE 才保留该 mate；混合则 `mate=null`（`expectiminimax.ts:1530-1537`）。

**因此**：它是对抗的、随机的、有限视野的期望搜索。它**不是**“对所有正概率分支做全称安全性证明”的求解器；`mate=null` 既可能是“没有强制胜”，也可能是“视野不够/被静态叶截断”。

### Q2. 猫和鼠分别在哪里做 MAX / MIN 决策？

同一个动作循环 `searchActions`，按 `state.currentPlayer` 切换 MAX / MIN（`expectiminimax.ts:1254`、`1316-1447`）。没有两套代码，也没有“猫搜索”和“鼠搜索”两个独立引擎。CHANCE 不是第三方玩家，不参与 MAX/MIN 选择，只是在 `valueOfAction` 中做期望聚合。

### Q3. 搜索深度以什么单位递减？

**只按 actor 切换递减，一次切换减 1。**

- 确定性转移：`switched = state.currentPlayer !== next.currentPlayer; nd = depthTurns - (switched ? 1 : 0)`（`expectiminimax.ts:1493`）。
- CHANCE 转移：所有 outcome 共享一次切换，`nd` 只减 1（`expectiminimax.ts:1512-1515`）。
- 配置注释明确：`maxDepthTurns` 以 TURNS（action-right changes）计，不是 steps（`searchTypes.ts:127-131`）。

同回合内的多个 `catStep` / `mouseStep`、零成本 `catPlaceTrap`、`mouseSkill` 都不减深度。

### Q4. 零成本陷阱、鼠技能、隧道选择、踩陷阱如何影响深度？

| 动作 | 真实代价 | 深度影响 | 证据 |
|---|---|---|---|
| `catPlaceTrap` | 0 步；不移动；不结束回合 | **不减**；可在一回合内多次出现（受 `1+floor(M/2)` 上界约束） | `simulator.ts:48-51`；`engine.ts:1010`；`planBound.ts:153-156` |
| `mouseSkill` | 消耗黄油，+3 步；不结束回合 | **不减**；同一鼠回合内的动作 | `simulator.ts:78-80`；`engine.ts:887-901` |
| `chooseTunnel` | 出口选择；鼠步数已为 0；由 `forceEndTurnIfNeeded` 交接 | **减 1**（鼠→猫） | `simulator.ts:83-86`；`engine.ts:698-710` |
| 踩陷阱 `mouseStep` | 移除陷阱，剩余步数清零，鼠回合立即结束 | **减 1**（鼠→猫） | `engine.ts:731`；`finalizeTurnAfterMouseStep` 走共享 `endTurn` |
| 猫推箱 `catStep` | 1 步；可能封住隧道口 | **不减**；同猫回合 | `engine.ts:908-1004`；`blockedTunnels` 记录 |
| 黄油拾取 `mouseStep` | 1 步；产生幽灵公告 CHANCE | **不减**（鼠→鼠）；若步数耗尽则回合结束减 1 | `simulator.ts:64-72` |
| CAT→MOUSE 幽灵边界 | 边界解析；鼠回合开始 | **减 1**（猫→鼠） | `simulator.ts:107-130`；`engine.ts:1101-1165` |

**要点**：`chooseTunnel` / `mouseSkill` 在 mate 距离上也是 0（`mateActionCost`，`expectiminimax.ts:295-307`），但 `chooseTunnel` 在**深度**上算一次切换。深度单位和 mate 距离单位不是同一个东西。

### Q5. 鼠吃黄油的 CHANCE 如何进入搜索？

`simulateSearchAction` 的 `mouseStep` 分支检测 `next.butterPositions.length === state.butterPositions.length - 1`，且 `phase` 仍为 `Playing`（`simulator.ts:62-72`）。若是，调用 `rules.buildButterChance(next)`（生产绑定 `enumerateGhostAnnouncementOutcomes`，`engine.ts:1213`），对每个合法幽灵公告格产生**等权 1/N** 的 outcome；没有合法候选时退化为 `placementDebt+1` 的确定性转移（`simulator.ts:160-180` 附近）。搜索内**不调用** `Math.random`。

### Q6. 猫回合末的 pending ghost 如何进入 CHANCE？

猫的最后一个动作经 `forceEndTurnIfNeeded`（`simulator.ts:107-130`）。若 CAT→MOUSE 边界存在 `pendingButterSpawns` 或 `pendingButterPlacementDebt`：

- 必须调用 `rules.resolveGhostBoundaryChance`（生产绑定 `enumerateGhostBoundaryOutcomes`，`engine.ts:1256`）；
- 先由 `resolveGhostBoundaryCore` 处理“鼠在幽灵点自动拾取 / 可实体化 / 首次阻挡 / 二次阻挡重掷”（`engine.ts:1101-1149`）；
- 再对剩余请求枚举**均匀 k-子集**（权重 `1/C(N,k)`）；候选不足时剩余请求变为债务，绝不丢弃（`engine.ts:1256-1305`、`1306-1355`）；
- 若 RuleSet 缺失或返回 null，模拟器直接抛错，**禁止**回退到 `endTurn` 的真实随机采样（`simulator.ts:124-129`）。

### Q7. 所有正概率 CHANCE 分支都被完整搜索了吗？

**在一个“已完成”的迭代内：是。** 每个 outcome 都以 `NEG_INF..POS_INF` 满窗口搜索（`expectiminimax.ts:1519`），Alpha-Beta 不剪 CHANCE；任一 outcome 未完成，父 CHANCE 的 `completed=false`，并沿路径上传，最终该迭代被丢弃（`expectiminimax.ts:2307-2320`）。

**但要区分三件事**：

1. “分支被丢弃” ≠ “分支在视野处用静态值截断”。深度到 0 时所有分支都走静态叶，这是正常的 horizon，不是随机剪枝。
2. 公告 CHANCE 只枚举“幽灵公告在哪个格”；后续实体化是另一次 CAT→MOUSE 边界 CHANCE。两次都由真实枚举器建模。
3. 若整体迭代被 deadline/节点预算截断，则该迭代的所有部分结果都不采用；生产只使用最深**完成**深度（见 Q10）。

### Q8. 终端判定是否先于深度截断？

**是。** `_search` 的顺序是：终局（`expectiminimax.ts:1574-1581`）→ 重复路径（`1586-1591`）→ 深度（`1605`）→ 节点预算（`1715`）→ 墙钟（`1729`）→ TT（`1753`）。根入口同样先终局（`1850-1859`）。量词内核也先终局再 horizon（`seal_lib.ts:96-101`）。

**边界说明**：终端判定依赖 `state.phase` 已为 `CatWins`/`MouseWins`。RULE-A 由引擎转移（`endTurn`、`catMove`、`mouseStep` 的 `settleNoMoveLoss`）和 `simulateSearchAction` 入口的 `applyNoMoveLoss` 结算（`simulator.ts:39-47`），所以正常的回合边界状态不会以“仍 Playing 的被困状态”进入叶。

### Q9. TT、Alpha-Beta、重复路径、计划提取是否有需要保护的特殊语义？

| 机制 | 语义 | 保护点 | 证据 |
|---|---|---|---|
| TT | 只存 `completed && cacheable && bound==='exact'`；探测要求 `depthTurns` 与 `extensionsRemaining` **精确匹配** | 截断/重复相关结果绝不入表；TT 命中返回数值，不返回 plan sidecar | `expectiminimax.ts:1054-1084`、`1035-1050`、`1753` |
| Alpha-Beta | MAX 用 lower、MIN 用 upper；cutoff 节点 `bound` 不是 `exact` | 非 exact 不写 TT；等值主变只从**已证明**的 anchor 建立 | `expectiminimax.ts:1418-1449`、`1463-1467` |
| 重复路径 | 当前递归路径上重复 → 静态评估、`cacheable=false` | 绝不当作和棋；绝不写入 TT | `expectiminimax.ts:1586-1591` |
| 计划提取 | `planBranches` 是**本次搜索**的 state→action 边，不是 TT | 只有 `capturePlan` 的搜索写；只沿猫行动的可执行边行走；上限是 `maxCatTurnPlanActions` | `expectiminimax.ts:1465-1470`、`1926-1965`、`planBound.ts:153-156` |
| 等值主变 | `mate===null` 且图非空时替换计划；只接受已证明的等值动作 | 可以改变 `plan[0]`，但不改变价值 | `expectiminimax.ts:2019-2023`、`1355-1400` |

### Q10. 生产 Hard 猫的真实搜索入口、时间预算、最大尝试深度、实际完成深度？

**入口**：`computeCatAiTrajectory` 在猫回合开始时 mint **一个** `TurnDeadlineIdentity`（主搜索 100ms、总回合 150ms），调用一次 `planHardCatTurn`（`engine.ts:4025-4110`）。`planHardCatTurn` 内部只做**一次** `searchBestActionIterative`（`hardTurnPlanner.ts:253-274`）。

**配置**：

| 参数 | 值 | 证据 |
|---|---|---|
| `maxDepthTurns` | 4（配置上限） | `hardTurnPlanner.ts:256` |
| `maxNodes` | 500,000 | `hardTurnPlanner.ts:257` |
| TT / Alpha-Beta / MoveOrdering | 开 / 开 / 开 | `hardTurnPlanner.ts:259-261` |
| ThreatOrdering | 关 | `hardTurnPlanner.ts:264` |
| ThreatExtensions | 0（G0.3B 回滚） | `hardTurnPlanner.ts:267-272` |
| 主搜索预算 | 100ms | `searchConfig.ts:16-22`；`engine.ts:4088-4090` |
| 总回合预算 | 150ms | `searchConfig.ts:37-40` |
| 叶 | `resolveHardLeaf()`，默认 `evaluateForCat` | `hardTurnPlanner.ts:263`；`searchConfig.ts:81-85` |
| Progress Guard | 默认关 | `searchConfig.ts:102-105` |

**实际深度（冻结 100ms 生产数据，24 根 × 2 叶臂 × 5 轮 = 48 组合 / 240 次运行）**：

| 指标 | 结果 |
|---|---|
| `MAX_DEPTH_CONFIGURED` | **4** |
| `MAX_DEPTH_ATTEMPTED` | **3**（只在 9 个完成 D2 的组合上尝试 D3；其余尝试 D2） |
| `MAX_DEPTH_COMPLETED` | **2** |
| D1-only 组合 | 37/48 |
| D2-only 组合 | 9/48 |
| D1/D2 波动组合 | 2/48（G2T6/E1、G1T4/E1） |
| 完成 D3 或 D4 的组合 | **0/48** |
| 尝试过 D4 的组合 | **0/48** |
| deadline 截断 | 48/48 组合均 5/5 轮触发 |
| 节点预算截断 | 0/48 |
| fallback / override | 0 / 0 |
| 观测到 >150ms 总回合计 | 182/240 轮；最大 `turnWallMs` 155.6ms |

> 这是**冻结样本上的确定性统计**，不是总体推断。`MAX_DEPTH_CONFIGURED=4` **不能**写成“实际完成 D4”；本轮实际完成最多 D2。

**为什么停在 D1/D2**：100ms 主搜索在 D2 迭代中途被 deadline 截断（attemptedDepth = completedDepth + 1 是 `searchBestActionIterative` 的定义，`expectiminimax.ts:2295-2320`），迭代结果被丢弃，返回最深完成深度。D1 的叶是鼠行动状态，D2 的叶是猫行动状态。

---

## 4. Phase 2 — D1–D4 搜索视界语义

完整逐阶段表见 `HORIZON_SEMANTICS.md`。这里给结论：

| 阶段 | 进入 actor | 搜索覆盖 | 叶子 actor | 是否静态叶 |
|---|---|---|---|---|
| D1 | 猫 | **完整猫回合**（步/推箱/零成本陷阱，直到预算耗尽或提前终止）+ 猫回合末幽灵边界 CHANCE | 鼠 | 是（边界 outcome 各自静态评估） |
| D2 | 猫 | D1 + **完整鼠回合**（步/技能/隧道/踩陷阱/黄油 CHANCE） | 猫 | 是 |
| D3 | 猫 | D2 + 再一个完整猫回合 | 鼠 | 是 |
| D4 | 猫 | D3 + 再一个完整鼠回合 | 猫 | 是 |

**关键澄清**：

- “完整”指**该 actor 的完整合法动作集与完整步数预算在同一深度层内可被搜索**，不是“每条分支都必须走满步数”。猫可以提前捕获、提前被 RULE-A 结算，或把回合交给鼠。
- **D1 已经包含猫回合末的幽灵边界 CHANCE**：如果猫的最后一步留下 pending ghost/debt，D1 的叶子不是单个鼠状态，而是所有边界 outcome；但**不包含任何鼠动作**。
- **D2 才包含鼠的反击**：鼠的隧道选择、技能、踩陷阱、黄油拾取都发生在这一层；黄油拾取 CHANCE 在鼠回合内，不减深度。
- **D3/D4 只是把同样的循环再走一遍**；生产 100ms 从未完成它们。

---

## 5. Phase 3 — 量词证明视野与搜索视野对齐

完整转换表与反例见 `PROOF_VS_EXPECTIMINIMAX.md`。核心结论：

### 5.1 H0 / H1 在量词搜索中的含义

`solve(game, root, H, startIdx, cap, mode)` 的截断条件是**猫节点 `idx >= 2*H`**（`seal_lib.ts:101`）。`idx` 只在 actor 切换时 +1（`seal_lib.ts:124-125`）。终端先于 horizon（`98-101`）。CHANCE 恒为 AND over 正概率 outcome（`132-139`）。`cap` 超出返回 `null` = UNRESOLVED，绝不冒充 PASS（`107-108`、`151`）。

### 5.2 深度单位是否等于 expectiminimax 的 depthTurns？

**切换计数相同，但视野端点和语义不同。**

- 两者都以 actor 切换为 1 单位；量词的 idx 与搜索的 depthTurns 在“从同一状态、同一动作集出发”时一一对应。
- 量词只在**猫节点**截断；搜索在 `depthTurns<=0` 时截断，不管 actor。因此从猫根出发，量词只能对齐**偶数**切换；D1/D3 没有对应的 H。
- 量词的 horizon 真值是 mode-specific（`catSurvive` 撑过视野即 true；其它为 false）；搜索的叶是静态评估。**相同边界、不同叶值**。

### 5.3 起始状态是否相同？

- `ROOT_CLASSIFICATION_V2` 的根是 fixture 的**猫行动**快照（`stateKey` 中 `#playing#cat#...`）。
- 证书（如 `G1T3_E1_100MS_CERTIFICATE`）先回放实际计划，得到**鼠行动**前沿（`postIdx=1`、`postPlayer=mouse`、`mouseMovesLeft=4`），再从前沿求解（`G1T3_E1_100MS_CERTIFICATE.json` 的 `replay.frontier` / `certification`）。
- 因此“根分类”和“计划证书”**起始状态不同**；不能把证书的 H1 当成根分类的 H1。

### 5.4 当前猫回合计划是否已经执行？

- 根分类：**没有**；它从猫回合开始处搜索所有猫动作。
- 计划证书：**是**；猫的第一回合被固定为已执行计划，量词只搜索其后的鼠/猫/鼠……分支。

### 5.5 猫/鼠剩余步数如何初始化？

- 根分类：直接读 fixture 状态的 `catMovesLeft` / `mouseMovesLeft`（G1T3 为 4 / 0，鼠尚未行动）。
- 证书前沿：猫 `catMovesLeft=0`，鼠 `mouseMovesLeft=4`（未携带黄油），由真实 `resolveGhostBoundaryCore` / `endTurn` 设置。
- 量词内核不重设预算，完全使用真实引擎转移；`settle` 先应用 RULE-A（`seal_lib.ts:180`）。

### 5.6 CHANCE 分支是否完整？

**量词要求完整且是 AND。** 每个转移的所有正概率 outcome 都必须为 true；`weight<=0` 被跳过；任一 outcome 为 false 即失败；任一为 `null` 且未决定则返回 `null`（`seal_lib.ts:132-151`）。这与期望搜索的 `Σ weight·value` 是**不同问题**：期望高 ≠ 全分支安全；一个坏 outcome 就能破坏生存。

### 5.7 终端检查顺序是否不同？

两者都是**终端先于 horizon/depth**。差异在 RULE-A：量词在每个节点先 `settle`（`applyNoMoveLoss`）再判终局（`seal_lib.ts:96-99`）；期望搜索依赖引擎转移结算 RULE-A，`_search` 直接读 `state.phase`。对正常的回合边界状态，两者一致；对“人为构造的、未结算的被困根”，量词会先判 RULE-A，搜索不会。**这是 UNKNOWN 级差异，不应假定完全等价**。

### 5.8 UNRESOLVED 是否会被误当成 SAFE？

**在正确使用下不会；在错误推导下会。** 直接证据：

- `G1T5`：`h1MouseForcedWin=false`，但 `h1CatSurvive=null` → 根分类 `UNRESOLVED`（`ROOT_CLASSIFICATION_V2.json`）。仅凭 `!mouseForce` 会误判为存活。
- `G1T8`：同样 `h1MouseForcedWin=false`、`h1CatSurvive=null` → `UNRESOLVED`；ERRATUM 的 P4 标签是 `CHANCE_DEPENDENT_OUTCOME`。两种标签都不能当 SAFE。
- `G6T2`：根分类 `UNRESOLVED`（H1 mouseForce 与 catSurvive 都 600k 截断），但 `DRRR` 前缀证书 `PROVEN`。前缀证明只覆盖该前缀，不覆盖根的全称问题。
- QUANTIFIER_AUDIT §2 已证明旧代码的 `!mouseForcesWin ⇒ CAT_SURVIVAL` 在两个量词上都错：否定式是 `∀σ_m ∃σ_c ∃chance`，存活是 `∃σ_c ∀σ_m ∀chance`；一个坏 chance outcome 就能破坏存活但不破坏否定式（`QUANTIFIER_AUDIT.md:43-70`）。

**因此**：`UNRESOLVED / CHANCE_DEPENDENT / NO_REFUTATION_FOUND / INCOMPLETE / CHANCE_MIXED` 一律是 UNKNOWN，不得升级为安全。

### 5.9 显式转换表（摘要）

| 量词对象 | 起始 actor / idx | 截断 | 从该起点的搜索等价深度 | 相对原始猫根 | 对应状态 |
|---|---|---|---|---|---|
| 根分类 H0 | 猫 / 0 | 猫 idx≥2 | 2 次切换 | **D2** | 对应边界相同；叶真值不同 |
| 根分类 H1 | 猫 / 0 | 猫 idx≥4 | 4 次切换 | **D4** | 同上 |
| 计划证书 H0 | 鼠 / 1 | 猫 idx≥2 | 1 次切换 | 原始根 D2（猫前缀固定） | 鼠回合完整反击 |
| 计划证书 H1 | 鼠 / 1 | 猫 idx≥4 | 3 次切换 | 原始根 D4（猫前缀固定） | 鼠+猫+鼠 |
| 任意 H | s∈{0,1} | 猫 idx≥2H | 2H−s 次切换 | — | 仅在 s≤2H 时成立 |

**禁止**：H0=D1、H1=D2。**禁止**：把 `!mouseForce` 推导成 `catSurvive`。

---

## 6. Phase 4 — 真实决策链路审计

### 6.1 六个量的关系

| 量 | 产生位置 | 语义 |
|---|---|---|
| `search.bestAction` | `searchBestAction` / 固定深度根比较 | 根动作；受根窗口与等值 tie-break 影响 |
| `search.catTurnPlan` | `buildCatTurnPlan` 从 `planBranches` 走猫行动边 | 完整猫回合可执行计划；可能被 `extractBestCatTurnPlan` 替换 |
| `baselinePlan` | `planHardCatTurn` 的 `search.catTurnPlan` | Sidecar 之前的基线 |
| Sidecar 最终计划 | `runRefutationSidecar` 的 `sidecar.plan` | 只有基线被真实反驳且存在干净候选时才覆盖 |
| Guard 最终计划 | `runProgressGuard` 的 `rescuePlan` | 默认关闭；触发后用 `previousCompletedPlan` |
| 实际执行动作 | `computeCatAiTrajectory` 的 `applyPlanCatAction` 逐步应用 | 逐步校验；非法/耗尽 → `SEARCH_FALLBACK` |

`planHardCatTurn` 的 `plan` 初值是 `search.catTurnPlan`（`hardTurnPlanner.ts:276`），Sidecar 可替换（`380-382`），Guard 可再替换（`400-402`）。`bestAction` 是独立字段，不随计划替换而更新。

### 6.2 为什么 `bestAction` 不一定等于 `catTurnPlan[0]`

`searchBestAction` 在 `mate===null` 且等值主变图非空时调用 `extractBestCatTurnPlan` 替换 `catTurnPlan`（`expectiminimax.ts:2019-2023`）。等值主变是另一条价值相同但首步不同的完整计划；因此 `plan[0] != bestAction` 完全可能，且**价值相等**。

**G5T1/E1 反例（ERRATUM §1.1）**：

```text
P4 bestAction        = U
P4 可执行计划        = DLUTR
P5 实际 100ms 计划   = DLUTR
P7 原比较            = U != D  -> 错误标记“未复现”
正确比较             = D == D  -> 已复现
```

P7 的错误是把 `bestAction` 当成计划。正确对象是 `catTurnPlan[0]` / 实际 `finalPlan[0]`。

### 6.3 证书必须绑定“真实回放的执行计划”

- ERRATUM 把 48/48 组合的实际 100ms 计划逐字回放，并为 6 个 `cert != actual` 的组合补证；H1/G1T3/RRRR 因身份完全一致而复用 P4 证书。
- 证书身份包括：fixture SHA、restored `stateKey`、计划字符串、post-state、证书 ID。
- 若 Sidecar 或 Guard 改变了计划，原证书**不自动适用**：必须对新前缀重新回放/重新证明；旧证书只覆盖旧前缀。
- 若执行过程中发生 `SEARCH_FALLBACK` / `plan_exhausted` / `plan_action_invalid`，实际执行轨迹不再等于被证明的计划前缀，证书立即失效。

### 6.4 G6T2 的启示

根分类 `UNRESOLVED` 不等于“没有可证明的计划”：`DRRR` 前缀有 PROVEN 证书。反过来，计划前缀 PROVEN 也不等于根级安全。**证明的作用域必须和决策绑定的对象一致**：决策执行的是哪个前缀，证书就必须覆盖哪个前缀；根级量词结果不能替代计划级证书，计划级证书也不能冒充根级结论。

---

## 7. Phase 5 — 架构路线比较与唯一推荐

完整矩阵见 `TACTICAL_ARCHITECTURE_OPTIONS.md`。摘要：

| 路线 | 能否解决 | 主要不能 | 数学/CHANCE 改动 | 100ms 风险 | 结论 |
|---|---|---|---|---|---|
| A. 在现有 Expectiminimax 上做选择性深度延伸 | 可能提高战术深度 | 不能产生安全性证明；G0.3B 已证明真实根上 `completedDepth 1→0`、10/20 空计划回退 | 改搜索数学/深度语义 | 高 | **禁止原样重启** |
| B. 根级独立量词验证层 | 能给出精确强制胜/存活（有 cap 时） | 根级搜索昂贵；G6T2/G1T5 600k/17–20s；H1 不能塞进 100ms | 不改主搜索，但需新预算 | 极高 | **不可作为根级在线层** |
| C. 叶评估加入时间战术特征 | 可能改善信号 | 不能产生证明；H1 无可证明 100ms 收益；新权重有回归风险 | 改评估器 | 中 | **不作为本轮目标** |
| D. 双通道：候选计划搜索 + 独立证明 + 反线验证 | 直接对应“最强反击/强制胜/可验证防守” | 证明仍可能 UNRESOLVED；必须严格分级 | 不改主搜索数学 | 中（若计划作用域+小 cap） | **推荐，但先做计划级只读测量** |
| E. 其他（如更深的静态/启发式） | 低成本信号 | 不能升级为证明 | 视实现 | 低 | 只能作 SIGNAL |

### 7.1 为什么推荐 D，而不是 A/B/C

- **A** 重复已被证伪的路线：`hardTurnPlanner.ts:267-272` 明确记录 G0.3B “REAL Turn5: completedDepth 1→0, empty-plan fallback 10/20”，生产回滚为 0 credits。当前 100ms 连 D2 都常常完不成，再加深只会更糟。
- **B** 根级量词的实测成本不可接受：H1 `catSurvive` 在 4/24 根上 600k 节点 / 17–20s；G6T2 重证总耗时 429,843ms。根级存在性搜索还会被昂贵的兄弟分支耗尽 cap（G6T2 的 D/L 分支）而错过真正安全的 DR。
- **C** 没有证明能力；H1 的 ERRATUM 结论是 `PROVEN_100MS_TACTICAL_GAIN=FALSE`，生产接线未授权。叶特征只能产生 SIGNAL。
- **D** 把问题缩小到“**一个已执行计划前缀**”上：候选集来自搜索自己的 principal line（而不是昂贵的 legacy 全回合枚举），量词只在前沿上跑一个小 H；这既保留真实规则/CHANCE 语义，又避免根级全称搜索的爆炸。它是唯一同时满足“可验证”“可绑定执行计划”“有机会在剩余预算内完成”的路线。

### 7.2 推荐的具体形态：计划作用域单边反线验证（PCV, Plan-scoped Counter-line Verification）

**不是**一个新的规划器，**不是**一个根级证明层，**不是**把期望值当安全证明。它是主搜索之后的**单边、计划作用域、可证明/不可证明明确分级**的验证通道：

1. **候选来源**：只用**实际选中的最终计划**（未发生 Sidecar/Guard 覆盖时即 `baselinePlan`；P5 冻结数据中为 `finalPlan`）；可选地加最多 2 个等值主变首步替代计划（从同一次 completed iteration 的 `planBranches` 走出）。**不**重新枚举 6 个 legacy 全回合计划——PPC-P1-TIME-02 在 G1T1/G1T5 上观测到仅候选枚举就要 36–49ms，且 0 个候选被探测（`SIDECAR_DIAG.json`）。
2. **前沿**：用真实规则回放该计划，得到 `postIdx=1`、鼠行动的 frontier；记录 `stateKey`、`catMovesLeft=0`、`mouseMovesLeft`、幽灵/债务、陷阱、隧道状态。
3. **反线模式（优先）**：`mouseForce(H0)` 从 frontier 出发，即“鼠在其完整下一回合内能否强制胜”。这是**单向**的：`true` + 独立 verifier PROVEN ⇒ `TACTICAL_PROOF`（鼠强制胜）；`false`/cap ⇒ UNKNOWN，**不是安全**。G1T3 的 frontier H0 只需 18 节点 / 3ms；G6T2 根 H0 只需 116 节点 / 4ms。这是最有希望在 20–30ms 内完成的检查。
4. **存活模式（仅当剩余预算足够）**：`catSurvive(H0)` 或 `H1` 从同一 frontier 出发。`true` + verifier PROVEN ⇒ `TACTICAL_PROOF`（猫在 H 内可存活）；cap ⇒ UNKNOWN。H1 的实测成本从 179 节点 / 13ms（G1T3）到 600k / 18s（G6T2），因此**必须有硬性 cap 和 wall 预算，且默认不启用 H1**。
5. **决策**：最终计划仍是主搜索结果。PCV 只能：
   - 在 `mouseForce(H0)=true` 且 verifier PROVEN 时，把该计划标为**被反驳**（`TACTICAL_PROOF` of loss），并在存在干净替代计划时建议替换；
   - 在 `catSurvive` PROVEN 时，把该计划标为**在 H 内可存活**（`TACTICAL_PROOF` of survival）；
   - 其余情况一律 `TACTICAL_SIGNAL` / `TACTICAL_CANDIDATE`，不得写成 safe。
6. **失效规则**：计划改变、执行回退、stateKey 不一致、verifier 失败、cap 命中、deadline 命中 → 证明失效，回到 UNKNOWN。

### 7.3 四级证据阶梯（必须写进实现）

| 级别 | 定义 | 允许的用途 | 禁止的用途 |
|---|---|---|---|
| `TACTICAL_SIGNAL` | 期望值、静态特征、Sidecar 的 `NO_REFUTATION_FOUND` / `CHANCE_MIXED` / `INCOMPLETE`、H0 mouseForce=false | 提示、排序、调试 | 安全/胜率/证书 |
| `TACTICAL_CANDIDATE` | 合法、完整、已在前沿做过有界搜索但未完成全称验证的计划 | 候选比较、下一步验证对象 | 安全证明 |
| `TACTICAL_PROOF` | cap 未命中 + 终端/horizon 明确 + 独立 verifier PROVEN + 绑定计划前缀/stateKey | 鼠强制胜、猫在 H 内存活、猫强制胜 | 无限期存活、根级全称结论 |
| `TACTICAL_DECISION` | 生产实际执行的计划 | 执行、记录、回放 | 把 SIGNAL/CANDIDATE 升级成 PROOF |

**核心纪律**：`NO_REFUTATION_FOUND` 永远不是 safe；`!mouseForce` 永远不是 `catSurvive`；`mate=null` 永远不是“和棋”；`UNRESOLVED` 永远不是 PASS。

---

## 8. Phase 6 — 下一轮唯一实现目标

**目标：PCV 的只读测量原型（PPC-T1-PCV-01）**，不是生产接线。

范围：

- 冻结 24 根 × 2 叶臂（E1 baseline / H1 corrected-hole）× 5 轮 = 48 组合；
- 主搜索保持生产配置（100ms / 150ms / D4 配置 / 500k 节点 / TT+AB+ordering）；
- 只取主搜索完成后的 `baselinePlan`，真实回放到 frontier；
- 在 frontier 上跑 `mouseForce(H0)`，cap 与 wall 预算预先登记；若预算允许，再跑 `catSurvive(H0)`；
- 每个结果记录：计划字符串、prefix stateKey、H、cap、是否截断、节点、chance 节点/outcome、耗时、verifier 结果、类别；
- 与既有根分类/证书做**作用域对齐**比较，不把根分类当同 horizon 的 oracle；
- 不修改生产源码，不改变主计划，不运行 self-play / 全回归 / 大 benchmark。

预先登记的 GO/NO-GO（详见 `NEXT_STAGE_PREREGISTRATION.json`）：

- **G0 身份**：fixture / 源码 / HEAD 不变；
- **G1 零假证明**：所有 `PROVEN` 必须被独立 verifier 复验，0 mismatch；
- **G2 覆盖**：至少 12/48 组合能在预留预算内得到 `PROOF` 或 `REFUTED`（否则 NO-GO，先改候选来源，不扩预算）；
- **G3 计划不变**：影子模式下 0 次计划改动；关闭时与基线 bit-identical；
- **G4 时间**：主搜索预算不变；总回合计不超过冻结样本观测包络（≤155.6ms）加预先登记容差；PCV 只能使用**预留**时间；
- **G5 绑定**：每个证明记录计划前缀 + post-prefix stateKey + 证书哈希；
- **G6 不升级**：`NO_REFUTATION_FOUND / INCOMPLETE / CHANCE_MIXED / UNRESOLVED` 不得出现在 `PROOF` 字段。

如果 G2 失败，下一轮结论是 **PCV-NO-GO**，回到“候选来源/预算分配”的设计，而不是直接生产化。

---

## 9. 机器状态

```text
CURRENT_SEARCH_CAPABILITY = expectiminimax MAX(cat)/MIN(mouse)/CHANCE(expectation), alpha-beta, TT, iterative deepening, mate-channel bounded forced-win detection; no survival proof; static leaves; 100ms production completes D1/D2 only
ACTUAL_DEPTH_DISTRIBUTION = configured D4 | attempted max D3 | completed max D2 | 48 combos: 37 D1-only, 9 D2-only, 2 variable D1/D2, 0 D3/D4 | 0 combos attempted D4 | deadline-cut 48/48 combos (5/5 rounds) | node-budget-cut 0/48 | fallback 0 | override 0
D1_D4_SEMANTICS = D1 complete cat turn + cat-end ghost CHANCE, leaf mouse-to-move; D2 + complete mouse turn, leaf cat-to-move; D3 + cat turn, leaf mouse-to-move; D4 + mouse turn, leaf cat-to-move; terminal before depth
QUANTIFIER_HORIZON_MAPPING = root(startIdx=0): H0=D2, H1=D4; plan-frontier(startIdx=1): H0=1 switch after plan (D2 boundary from original root), H1=3 switches (D4 boundary), with the cat first turn FIXED as the executed plan; no H counterpart for D1/D3; H0=D1 and H1=D2 are FORBIDDEN
CHANCE_SEMANTICS = expectiminimax: full-window expectation over all enumerated positive-probability outcomes, mate only if all outcomes mate for same side; quantifier: AND over all positive-probability outcomes; numerically incomparable; no Math.random in search
ACTUAL_PLAN_BINDING = bestAction != catTurnPlan[0] possible (equal-primary extraction; G5T1/E1 bestAction=U, plan=DLUTR); baselinePlan=search.catTurnPlan; final plan may be replaced by sidecar/guard; executed plan validated per action with SEARCH_FALLBACK; certificates must bind to the replayed executed prefix, not the root action tag; 48/48 actual 100ms plans certified in ERRATUM
TACTICAL_PROOF_CAPABILITY = production: none (sidecar is one-sided bounded probe, guard default-off, H1 no proven 100ms gain); offline quantified proofs exist but cost 46 nodes/1ms to 600k nodes/20s; plan-frontier H0 refute is the only measured candidate likely to fit a small reserved budget, still to be validated
TACTICAL_ARCHITECTURE_RECOMMENDATION = D-prime: plan-scoped one-sided counter-line verification (PCV) as a read-only measurement round first; TACTICAL_SIGNAL/CANDIDATE/PROOF/DECISION ladder; no root-level quantifier, no depth extension, no evaluator change, no production wiring this round
PRODUCTION_SOURCE_CHANGED = NO
GAME_RULES_CHANGED = NO
SEARCH_MATH_CHANGED = NO
H1_CHANGED = NO
SIDECAR_CHANGED = NO
100MS_150MS_CHANGED = NO
FULL_REGRESSION = NOT_PERFORMED
HEAVY_BENCHMARK = NOT_PERFORMED
SELF_PLAY = NOT_PERFORMED
COMMIT = NO
PUSH = NO
MERGE = NO
```

---

## 10. 限制与解释边界

1. 100ms / 150ms 是**名义生产预算**，不是物理延迟认证；本轮的 155.6ms 是冻结样本上的观测最大值，不是保证上界。
2. 24 根 × 2 臂是冻结样本，不是总体推断；37/48 与 9/48 的计数是确定性统计，不是显著性结论。
3. `H1` 的 `CAT_SURVIVAL_CERTIFIED_WITHIN_H1` 只表示在 H1 视野内、按所有正概率 CHANCE 的 AND 语义，猫有策略避免鼠胜；**不是无限期存活**。
4. `G1T5` / `G1T8` 的 `UNRESOLVED` 与 `G6T2` 的根 `UNRESOLVED` 是真实 cap 结果，不是“无胜负”；不得当作安全。
5. 本报告没有重新运行 24 根搜索、P5/P6、self-play 或任何 benchmark；全部深度/成本数字来自既有冻结工件。
6. 工作树中未提交的生产补丁是本轮之前已存在的 P1/P2 候选；本轮没有写入任何 `src/` 文件。

---

## 11. 交付物

- `REPORT.md`（本文件）
- `HORIZON_SEMANTICS.md`
- `PROOF_VS_EXPECTIMINIMAX.md`
- `TACTICAL_ARCHITECTURE_OPTIONS.md`
- `NEXT_STAGE_PREREGISTRATION.json`
- `SOURCE_MANIFEST.json`（不包含自身 SHA-256）
