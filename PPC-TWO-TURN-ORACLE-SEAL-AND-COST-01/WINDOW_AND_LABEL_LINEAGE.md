# 窗口与标签血缘表（WINDOW_AND_LABEL_LINEAGE）

本轮只做核对，不修改任何冻结工件。下表每行都能在源码或冻结工件中定位；机器可读版本是
`logs/g1_lineage.json`、`logs/g1_g1t9_artifact.json`、`logs/g2_g1t9_root_equiv.json`。

## 1. 五个标签系统

| 系统 | 调用点（已核对） | 起点 | startIdx | 窗口 | 量词 | 独立验证器 |
|---|---|---|---|---|---|---|
| PCV H0 | `PPC-T1-PCV-01/probe/pcv.test.ts:103` → `runSolve(st,"mouseForce",1,1,600000,600000)` | finalPlan 之后的**鼠**前沿 | 1 | 鼠第 1 回合（1 个鼠回合） | ∃鼠 ∀CHANCE→MouseWins | `verifyMouseCertificate` |
| PCV H1 | `pcv.test.ts:105` → `runSolve(st,"catSurvive",2,1,5000,600000)` | 同一鼠前沿 | 1 | 鼠1→猫1→鼠2，猫节点 idx≥4 出窗 | ∃猫 ∀鼠 ∀CHANCE→¬MouseWins | `verifyCatCertificate`（验证帽 600000） |
| STRATEGY-01 根标签 | `PPC-CAT-STRATEGY-01/probe/tactical_tree.test.ts:93-95` → `mouseForcesWin(root,H,0,600000)` | 冻结人类根（**猫**行棋） | 0 | H0=猫(0)+鼠(1)；H1=再加猫(2)+鼠(3)；切点 `idx≥2H` | ∃鼠 ∀猫 ∀CHANCE | **无**（分类只读布尔值） |
| SHADOW 两鼠回合 | `PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.ts:243` `mouseTwoTurnRisk` | post-plan 鼠前沿 | 1 | 鼠(1)+猫(2)+鼠(3)，猫 idx≥4 出窗 | ∃鼠 ∀猫 ∀CHANCE（true）；false 另跑存在性 witness | **无**（自证） |
| 本轮独立 oracle | `ttor_lib.ts runProof` → `mouseForcesWinSeal(frontier,2,1,600000)` | 用真实 RuleSet 重建的 post-plan 鼠前沿 | 1 | 同上：鼠(1)+猫(2)+鼠(3) | ∃鼠 ∀猫 ∀CHANCE→MouseWins | `verifyMouseCertificate`（无剪枝、逐 outcome 重枚举） |

结论：**四个“两层鼠回合”系统其实是同一个问题**——PCV H1、STRATEGY H1、shadow 两回合、本轮 H=2 都表示
“当前局面之后鼠拥有的两个回合”，只是命名写作 H1/H2。STRATEGY H0 与 PCV H0 同为“一个鼠回合”。
三个内核的切点规则一致：猫节点 `idx >= 2H` 视作视窗外；终局判定都在切点**之前**。
`seal` 与 `strategy` 的差别只在搜索轨迹：strategy 在鼠节点有 `cannotReachHoleInHorizon` 剪枝且是分值极小极大，
seal 是纯布尔量词、无剪枝。

## 2. 上一轮报告的 H1 注释错误（只纠正文字，不改冻结工件）

- 错误表述：`PPC-G6T2-DECISION-RISK-CAUSAL-01/REPORT.md` 与 `CROSS_ROOT_SHADOW_RESULTS.json`
  的 `frozenRootLabels.note` 把根级 H1 写成“一个猫回合 + 一个鼠回合”。
- 正确定义：H1 = **两个鼠回合 + 两个猫回合**（从猫行棋的根开始，猫(0)、鼠(1)、猫(2)、鼠(3)）；
  “一个猫回合 + 一个鼠回合”是 H0。
- 影响：G1T9“层1 false、层2 true”不是窗口矛盾，而是层1只有 1 个鼠回合、标签要看第 2 个鼠回合。
  冻结工件本身（分类结果、节点数）没有错，错的只是上一轮报告里的中文注释。
- 处置：冻结工件原样保留；本轮 `logs/g1_lineage.json.correctionOfPriorRound` 记录纠正内容。

## 3. G1T9 的独立核对（能核到的与核不到的）

- 标签来源已核对：`tactical_tree.test.ts` 用 `PPC-CAT-STRATEGY-01/probe/lib.ts`
  （SHA `f8cae0ac…`）在猫行棋根上 `startIdx=0, H=2, cap=600000` 求得 true；
  该 kernel **没有**独立证书验证器，分类只读布尔值。
- 本轮用 seal 在同一根、同一窗口重解：`value=true`，`truncated=false`，**229,158 节点 / 20.8 s**。
  strategy 工件记录的 `h1Nodes=66749` 明显更小——原因是有剪枝、且是分值搜索；两者**不是同一条搜索轨迹**，
  只共享同一个布尔结论。不能拿节点数相等当作交叉复核证据，这里如实记录为“同结论、不同轨迹”。
- 对根窗口跑冻结验证器：`verifyMouseCertificate` 在 **600,001 叶**处撞上 600,000 帽，
  结果 `UNRESOLVED / NODE_CAP`，`policyMisses=0`。**没有降低帽、没有换算法**。
- 同一 G1T9 的冻结计划 `LLLD` 之后的鼠前沿：`mouseForcesWinSeal(frontier,2,1,600000)`
  `value=true`、24,075 节点（与上一轮 shadow 的 24,075 完全一致），验证器 **PROVEN**
  （24,999 叶，0 次策略缺失，无反例）。
- 因此 G1T9 标签的状态是：**来源已核对 + 同窗口布尔结论被第二内核复现 + 计划级证书已验证；
  根级证书在冻结帽下无法完成**。按委托要求，它**不计入**“正确性验证通过”，但它也不是窗口矛盾。

## 4. 36 / 37 / 39 三个口径

| 口径 | 数值 | 证据 |
|---|---|---|
| `src/` 源码闭包（上一轮） | **36** | `PPC-G6T2-DECISION-RISK-CAUSAL-01/logs/g0_src_closure.json`：`entries=36`、`drift=[]`、全部在 `src/` 下 |
| 依赖闭包（D2-PCV-02 `productionSources`） | **39** | 35 个 `src/` + 4 个研究 harness：`seal_lib.ts`、`seal_util.ts`、`g0_replay.test.ts`、`pcv_lib.ts` |
| “证书绑定文件” | **37** | **仓库中不存在任何声明 37 的工件**（`logs/g0_count_separation.json`，`THIRD_COUNT_SOURCE_NOT_FOUND`） |

37 可以由 39−2 或 36+1 凑出，但**没有任何工件支持其中任一种拆法**，本轮不得把任何一个当作口径。
后续引用请只用 36 或 39，并注明来源文件。

## 5. 判定

`WINDOW_LINEAGE_RESOLVED`：标签生成点、输入状态、量词、切点、验证器有无均已核对；
上一轮的中文注释错误已定位并纠正；G1T9 的根级证书帽溢出单独披露为 OPEN，未用任何方式绕过。