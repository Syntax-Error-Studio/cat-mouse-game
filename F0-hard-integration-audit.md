# F0.1 — Benchmark Validity Correction

**状态**：F0 报告**不签核**。本文档取代原 F0 结论。
**约束遵守**：本轮**未修改任何 production source**。`src/` 全程只读。
新增/修改文件全部是 benchmark / fixture / report（清单见 §8）。
**完成后停止，不进入 F1。**

---

## 0. 一句话结论

F0 的 10/10 通过率**不可采信**，但**不是因为搜索有问题**——是因为**尺子（oracle）和基线（Medium）都测错了**。
用修正后的 budget-fair oracle 重测，两套规则下 **Search Default 12/12、Search E1 12/12、真实路径 Medium 12/12**，
且 **evaluator-independent 错误数全为 0**。F0 报告里 3 处"E1/Medium 错误"经查全部是**测量假阳性**。

同时暴露 4 个此前未记录的结构性问题（§2.4、§3.4、§4），其中 2 个属于 F1 必须先处理的前置条件。

---

## 1. 第 1 项 — Temporary Retreat fixture 修正

### 1.1 原 fixture 无效（已确认）

原报告 fixture：`mouse=(4,4) cat=(4,6) hole=(4,8) best=ArrowLeft`。
在 F0.1 中保留为 `temporaryRetreat_v1_INVALID` 作为反例证据，实测：

```
[temporaryRetreat_v1_INVALID]  class=A-mateWin  oracle best=[step:ArrowLeft]
   step:ArrowLeft   v=999998  mate=cat  dDist=-1     ← 最佳动作让距离【减小】
   step:ArrowDown   v=999996  mate=cat  dDist=+1
   step:ArrowRight  v=999996  mate=cat  dDist=+1
   RETREAT ASSERTION: holds=false
```

`dDist=-1` 直接证实用户判断：**最佳动作是贪心逼近，不是 retreat**。
且该局面 `mate=cat`（猫必胜），根本不存在"必须暂时退让"的战术张力。原 fixture 名不副实。

### 1.2 新 fixture（几何重建，非改名）

用环形走廊族重建 `temporaryRetreat_v2`：

```
布局：  行 2 / 行 4 为走廊，列 2..6，(3,2) 与 (3,6) 连接两行 → 单环
        鼠洞 (2,1)，紧贴环左上出口
猫 (4,3)   鼠 (2,4)   鼠剩余步数 3   鼠持黄油
猫鼠 Manhattan distance = 3
```

几何要点：这是**环形**，贪心逼近会把猫送到环的错误一侧，鼠反手绕行直插 (2,1) 洞口；
向后退一格反而缩短猫到洞口关键格的距离——即"退一步是为了守门"。

### 1.3 断言验证（noTrap 套，budget-fair depth-6 oracle，全预算完成）

```
[temporaryRetreat_v2]  class=A-lossAvoid  commonCompletedDepth=6  budgetComplete=true
   step:ArrowLeft   v=     185  mate=null   dDist=+1   nodes= 6711   ← oracle 唯一最佳
   step:ArrowRight  v= -999993  mate=mouse  dDist=-1   nodes=44677   ← 贪心逼近 = 鼠【必胜】
   RETREAT ASSERTION: holds=true    allDecreasingStrictlyWorse=true
```

三条断言逐条兑现：

| 用户要求 | 实测 | 结论 |
|---|---|---|
| `distance(catAfterBest, mouse) > distance(catBefore, mouse)` | 最佳动作 `dDist=+1`（3→4） | ✅ 成立 |
| greedy 动作在 deeper oracle 下更差 | 贪心 `ArrowRight` = `mate=mouse`（**证明式必败**，非评估分差） | ✅ 成立，且是最强形式 |
| Search 必须愿意选 distance-increasing action | Default / E1 / Medium 全选 `ArrowLeft` | ✅ 成立 |

分类为 **A-lossAvoid**：被拒动作是**证明式败局**，所以"拒绝它"这一判断是 evaluator-independent 的
（在非败动作之间排序仍依赖叶评估，已如实标注）。

### 1.4 重新报告三方结果

**noTrap 套（`catPlaceTrap` 禁用，catTrapsRemaining=0）**

| 玩家 | 选择 | dDist | strict | evaluator-independent |
|---|---|---|---|---|
| Search Default (`defaultLeafEval`, d=3) | `step:ArrowLeft` | +1 | ✅ | ok |
| Search E1 (`evaluateForCat`, d=3) | `step:ArrowLeft` | +1 | ✅ | ok |
| Medium 裸 `catAiMove` | `step:ArrowLeft` | +1 | ✅ | ok |
| Medium 真实路径 `computeCatAiTrajectory`[0] | `step:ArrowLeft`（共 4 步，detail=移动） | +1 | ✅ | ok |

**production 套（`defaultRuleSet`，catTrapsRemaining=1）**

```
class=A-lossAvoid  commonCompletedDepth=5  budgetComplete=true
   step:ArrowLeft   v=     195  mate=null   dDist=+1
   step:ArrowRight  v= -999991  mate=mouse  dDist=-1   ← 贪心仍是证明式必败
   catPlaceTrap     v=     195  mate=null   dDist=n/a  ← 与 ArrowLeft 【并列最佳】
```

| 玩家 | 选择 | strict | evaluator-independent |
|---|---|---|---|
| Search Default | `step:ArrowLeft` | ✅ | ok |
| Search E1 | `catPlaceTrap` | ✅（在并列最佳集内） | ok |
| Medium 裸 | `step:ArrowLeft` | ✅ | ok |
| Medium 真实路径 | `step:ArrowLeft`（5 步） | ✅ | ok |

**诚实标注**：production 套里 `retreat.assertionHolds=false`，原因**不是**退让性质失效，而是
`catPlaceTrap`（`dDist=null`，不移动）与 `ArrowLeft` 并列最佳，导致"所有最佳动作都增加距离"这条更强的措辞无法成立。
此时能成立的最强 sound 命题是 `allDecreasingStrictlyWorse=true`：**所有缩短距离的动作都严格更差（且是证明式败局）**。
→ **退让 fixture 的严格形式在 noTrap 套成立；production 套成立其弱化形式。**

---

## 2. 第 2 项 — oracle 是否真的是 ground truth

### 2.1 发现：F0 的 oracle 从来不是 depth-6 搜索

审计 `f0bench.mts` 的 `oracleBestDirs` 时发现一个 F0 报告未记录的缺陷：

```
它用【一个共享的 500k-node SearchContext】按生成顺序遍历所有 root 子动作，
每个子动作调用 searchValue —— 而 searchValue 丢弃 completed 标志
（expectiminimax.ts:1006-1013 只返回 `.value`）。
```

后果：共享预算一旦耗尽，**排在后面的子动作静默坍缩为静态叶评估**，而调用方无法察觉。
所以 F0 所称的"depth-6 oracle"对多数动作根本不是 depth-6 —— 而且 F0 **在结构上不可能发现这一点**。
这超出了用户第 2 项的原始范围，但它使第 2 项的答案从"部分是 ground truth"变成"**尺子本身刻度不均**"。

### 2.2 三代 oracle 对照

| | F0 `f0bench.mts` | F0.1-a `f01bench.mts` | F0.1-b `f01oracle2.mts` ← **采信** |
|---|---|---|---|
| 每动作预算 | **共享 500k** | 独立 500k | 独立 60k |
| completed 标志 | **丢弃**（`searchValue`） | 保留（`searchResult`） | 保留 |
| 排名深度 | 固定 6，不管是否完成 | 固定 6，**不管是否完成** | 仅在 `commonCompletedDepth`（**全子动作均完成的最深层**） |
| budget-complete 排名 | 未知 | noTrap 11/12、prod **7/12** | **noTrap 12/12、prod 12/12** |

### 2.3 每 fixture oracle 审计（用户要求的 5 个字段 + A/B 分类）

**noTrap 套** — classA=10 / classB=2，`budgetComplete=12/12`

| fixture | class | mate | value | cCompletedDepth | nodes(最大子动作) |
|---|---|---|---|---|---|
| immediateCatch1 | A-mateWin | cat | 999999 | 6 | 61 |
| immediateCatch2 | A-mateWin | cat | 999998 | 6 | 164 |
| corridorMate2 | A-mateWin | cat | 999998 | 6 | 164 |
| openChase | A-mateWin | cat | 999996 | 5 | 6557 |
| emergencyHoleDefense | A-mateWin | cat | 999998 | 6 | 24 |
| temporaryRetreat_v1_INVALID | A-mateWin | cat | 999998 | 6 | 11222 |
| **temporaryRetreat_v2** | **A-lossAvoid** | null | 185 | 6 | 44677 |
| **boxBlock** | **B-horizon** | null | 140 | 6 | 2214 |
| skillThreat | A-mateWin | cat | 999998 | 6 | 53 |
| tunnelThreat | A-mateWin | cat | 999998 | 6 | 57 |
| **midgameOpen** | **B-horizon** | null | 170 | 5 | 34148 |
| trapValue | A-mateWin | cat | 999989 | 5 | 6024 |

**production 套** — classA=10 / classB=2，`budgetComplete=12/12`
分类与 noTrap 套逐项一致，但**可达深度因 `catPlaceTrap` 增加分支而下降**（这本身是重要事实）：

| fixture | noTrap cCD | production cCD |
|---|---|---|
| temporaryRetreat_v1_INVALID | 6 | 5 |
| **temporaryRetreat_v2** | 6 | 5 |
| **midgameOpen** (B) | 5 | **3** |
| **trapValue** | 5 | **3** |
| 其余 8 项 | 6（openChase 为 5） | 不变 |

分类判据（已实现为 `classify()`）：

- **A-mateWin** — 全部最佳动作 `mate==='cat'`。排名 evaluator-independent（终局证明）。
- **A-lossAvoid** — 存在被拒动作 `mate==='mouse'`。"拒绝败局"evaluator-independent；非败动作间排序仍依赖叶评估。
- **B-horizon** — root 处无任何终局证明，所有值来自 horizon 的 `defaultLeafEval`。
  **只能称 deep-default reference，不得作为 evaluator-independent truth。**

### 2.4 用 B 类 oracle 判 E1 错误 → 3 处假阳性，全部撤回

严格执行用户要求（无 terminal/mate 证明不得判 E1 错）后，F0.1-a 曾报出的错误全部消失：

| fixture (production) | 不公平/未完成 oracle 的判定 | budget-fair oracle 的事实 | 裁定 |
|---|---|---|---|
| `temporaryRetreat_v2` | best=[ArrowLeft]，E1 选 `catPlaceTrap` → **"E1 错误"** | 在**完成**的 d=5：`ArrowLeft 195 == catPlaceTrap 195` 并列最佳 | **假阳性，撤回** |
| `midgameOpen` | best=[ArrowRight] 于**未完成**的 d=4 → **"Def/E1/Med 三方全错"** | 在**完成**的 d=3：`ArrowDown 190 == ArrowRight 190 == catPlaceTrap 190` 三方并列 | **假阳性，撤回** |
| `boxBlock` | Medium 判 fail | 裸 `catAiMove` 返回 NULL，真实路径给出 `ArrowLeft`（见 §3.3） | **基线测错，撤回** |

**两个结构性盲区（比上面的假阳性更重要）**

1. **oracle 深度可能不比被测者深。** production 套 `midgameOpen` / `trapValue` 的 `commonCompletedDepth=3`，
   而被测搜索 `tacticDepth=3`。**尺子和被测者同深** → 该 fixture 上 oracle 对被测者**没有任何认证能力**，
   无论一致还是不一致都不能作为证据。production 套 12 个 fixture 中有 2 个处于这种状态。

2. **oracle 的叶评估对陷阱完全盲视。** `defaultLeafEval`（expectiminimax.ts:476-483）全文是：
   ```ts
   let score = 200 - manhattan(cat, mouse) * 5;
   if (state.mouseHasButter) score -= 60;
   ```
   （expectiminimax.ts:476-481）**无任何 trap 项**。而 E1 的 `evaluateForCat` 有 `trapControl: 600`（evaluation.ts:401）。
   → **用 `defaultLeafEval` oracle 审计 E1 的陷阱决策在原理上不可能有效**：尺子缺少被测特征。
   E1 在 `temporaryRetreat_v2` 选 `catPlaceTrap`，更可能是 **E1 看见了 oracle 看不见的东西**，而不是 E1 出错。

---

## 3. 第 3 项 — production-rule benchmark

### 3.1 两套并行，不混算

| | noTrap 套（保留） | production 套（新增） |
|---|---|---|
| RuleSet | `noTrapRuleSet`（`catPlaceTrap: st=>st`） | **`defaultRuleSet`（真实引擎绑定）** |
| catTrapsRemaining | 0 | **1** |
| root 动作集 | 仅 `catStep`×方向 | `catStep`×方向 **+ `catPlaceTrap`** |
| 推箱 | 经 `catStep` 自然发生 | 同 |
| 陷阱回收 | 不可能 | 猫踩自己陷阱即回收（引擎路径 engine.ts:759-772） |
| Medium 基线 | 同规则 | **同真实规则** |

已确认 `catPlaceTrap` 出现在 production 套**全部 12 个** fixture 的 oracle 动作列表中——真实动作集确实被覆盖，
不是"为了只比较 Direction 而禁用 trap"。

### 3.2 结果（budget-fair oracle，`f01oracle2.json`）

**noTrap 套** — classA=10 classB=2，budget-complete 12/12

```
STRICT (== oracle 最佳集) : Def=12/12  E1=12/12  Med裸=11/12  Med真实路径=12/12
SOUND errors (evaluator-independent) : Def=0  E1=0  Med裸=0（另有 1 处 `unknown`：boxBlock 上裸 `catAiMove` 返回 NULL，无法判定，见 §3.3）  Med真实路径=0
```

**production 套** — classA=10 classB=2，budget-complete 12/12

```
STRICT (== oracle 最佳集) : Def=12/12  E1=12/12  Med裸=11/12  Med真实路径=12/12
SOUND errors (evaluator-independent) : Def=0  E1=0  Med裸=0（另有 1 处 `unknown`：boxBlock 上裸 `catAiMove` 返回 NULL，无法判定，见 §3.3）  Med真实路径=0
```

**两套数字分开陈述，未合并。** 唯一残余错误是"裸 `catAiMove` 在 `boxBlock` 返回 NULL"，见 §3.3。

必需类别覆盖：Immediate Catch（3）/ Hole Defense（1）/ Box Block（1）/ **Trap Value（1，见 §3.4）** /
Temporary Retreat（v1 反例 + v2 有效）/ Tunnel Threat（1）/ Skill Threat（1）/ Midgame（2）。

### 3.3 Medium 基线此前测错（F0 的 9/10 是假阴性）

F0 测的是裸 `catAiMove`，而**游戏真实调用的是 `computeCatAiTrajectory`**
（`GamePage.tsx` → engine.ts:3304），后者内含 BFS 兜底层 `forceCatMoveTowardsMouse`（engine.ts:3333-3345）。

`boxBlock` 实测（两套规则均同）：

```
MedBare : NULL  (catAiMove returned NULL)
MedTraj : step:ArrowLeft  steps=4  detail="强制移动"   ← HARD_FALLBACK_MOVE 路径
```

→ **F0 的"Medium 9/10"是 harness 漏掉兜底层造成的假阴性。按游戏真实路径衡量，Medium 是 12/12。**
（这**不代表** Medium 启发式很强——它代表 `boxBlock` 上启发式确实失灵、由 BFS 兜底救回。
Medium 的真实弱点应当用"是否触发兜底"来度量，而不是用"是否选对动作"。建议 F1 把 `detail==='强制移动'`
作为独立指标统计。）

### 3.4 Trap Value：覆盖到了，但**无法用当前 oracle 判定** —— 诚实结论

用 `f01trapexplore.mts` 在两种专门几何（`twoLane` 2×7 双门洞口 / `ring12` 无可达洞）上穷举
所有满足 `bfsDist ≥ 5` 且 `catPlaceTrap` 合法的猫鼠组合，寻找"`catPlaceTrap` 唯一最优"的位置：

```
=== twoLane(2x7, 2-wide hole gate) — depth 3, minSeparation 5 ===
(no position where catPlaceTrap is uniquely best)
=== ring12(no reachable hole) — depth 3, minSeparation 5 ===
(no position where catPlaceTrap is uniquely best)
```

**这不是几何没找对，而是两个结构性原因决定了它不可能被找到：**

**原因 A — horizon 局面：oracle 叶评估无 trap 项**（§2.4-2）。
`catPlaceTrap` 不移动猫 → manhattan 不变 → 只要鼠在 horizon 内能绕开陷阱，值就**必然与"不放"打平**。
实测 `boxBlock`：`ArrowLeft 140 == catPlaceTrap 140`；`midgameOpen`：`190 == 190 == 190`。**只能并列，不可能唯一最优。**

**原因 B — mate 局面：自由动作被按边计入 mate 距离。**
`catPlaceTrap`（engine.ts:783-810）落在猫当前格，**不消耗 `catMovesLeft`、不切换行动权**。
搜索的深度记账正确地按回合走（`const nd = depthTurns - (switched ? 1 : 0);`，expectiminimax.ts:866/885），
但 mate 分数是**按树边**递减的（`stepScore`，expectiminimax.ts:153-157）。
→ 一个不消耗游戏 ply 的自由动作，仍会让经由它找到的 mate **看起来远一步**。

实测：production 套**全部 9 个** A-mateWin fixture，`catPlaceTrap` 相对最佳走步**恰好低 1 分**，零例外：

```
immediateCatch1  999999 / trap 999998      openChase              999996 / trap 999995
immediateCatch2  999998 / trap 999997      emergencyHoleDefense   999998 / trap 999997
corridorMate2    999998 / trap 999997      skillThreat            999998 / trap 999997
tunnelThreat     999998 / trap 999997      trapValue              999989 / trap 999988
temporaryRetreat_v1  999998 / trap 999997
```

**Trap Value 的正式结论**：
production 套已让 `catPlaceTrap` 成为真实合法动作并参与全部 12 个 fixture 的排名（覆盖达成），
但在当前 oracle 下 `catPlaceTrap` **只可能并列最佳或低 1 分，永远不可能唯一最优**。
因此**"Trap Value 战术能力"在 F0.1 中判定为不可测**，需要 F1 先修尺子（见 §6-4/§6-5）。
本文档**不**声称陷阱无价值，也**不**声称搜索的陷阱决策正确或错误。

---

## 4. 第 4 项 — 时间预算结论修正

### 4.1 撤回原结论

> ~~"E1 is never less deep than Default"~~ — **撤回。已被 F0 自己的数据证伪。**

`f0out.log` 原始记录（`f0summary.cjs` 重放）：

```
-- temporaryRetreat --
  D= 50ms  def: cd=2 ad=3 ms= 73.9 nodes=1000     e1: cd=2 ad=3 ms=113.9 nodes=1000
  D=100ms  def: cd=3 ad=4 ms=118.2 nodes=1662     e1: cd=2 ad=3 ms=133.1 nodes=1001   ← E1 更浅
  D=150ms  def: cd=3 ad=4 ms=136.2 nodes=2402     e1: cd=3 ad=4 ms=146.0 nodes=1480
```

`temporaryRetreat @100ms`：**Default cd=3、E1 cd=2**。反例存在，全称命题不成立。

### 4.2 基于事实的替代结论

1. **E1 vs Default 的深度关系是局面相关的、非单调的**，不存在全序。
   同一 fixture 换目标预算即可翻转（`temporaryRetreat` 在 100ms 处 E1 更浅，150ms 处持平）。
2. **原因是两个方向相反的效应叠加：**
   - E1 的 move ordering 更好 → 同深度**节点更少**。
     `midgameOpen d=4`：Default 41337 nodes / E1 **5883** nodes（约 1/7）。
   - E1 的每节点成本更高 → 同节点数**耗时更长**。
     `temporaryRetreat` 各档 E1 的 nodes ≤ Default，但 ms 一律 ≥ Default。
   → 谁更深取决于哪个效应在该局面占优。可以说 **E1 节点效率更高**，**不能**说 E1 一定更深。
3. **当前"50/100/150/250ms"不是 wall-clock budget，是 node 预算的近似换算**，超支普遍且幅度大：
   ```
   midgameOpen  D= 50ms → e1 实测 103.7ms （超 107%）
   midgameOpen  D=100ms → e1 实测 170.7ms （超  71%）
   midgameOpen  D=250ms → def 283.4ms / e1 306.6ms
   temporaryRetreat D=50ms → def 73.9ms / e1 113.9ms （均超）
   ```
4. **单次固定深度搜索可达秒级**：`midgameOpen d=4` Default 实测 **2376.2ms**。
   而 `DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn = 100`（searchConfig.ts）。
   → **没有真实 deadline 时，100ms/回合的配置在最坏情况下会失效约 24 倍。** 这是真实卡顿风险，不是理论问题。
5. **F0.1 只承认当前时间 sweep 为 approximate**，不据此对 E1/Default 做任何时间维度的优劣裁定。
   F0.1 **未实现** deadline（遵守"不改 production source"）。

### 4.3 F1 deadline 设计建议（仅建议，未实现）

**必须能中止正在进行的 depth，不能只在 iterative-deepening 外层检查**——
否则第 4.2-4 的 2376ms 单次搜索无法被任何外层检查打断。

建议接口（沿用现有 abort 通路）：

```ts
deadlineMs?: number;      // 绝对截止时刻
now?: () => number;       // 注入时钟，保证可测试、可确定性重放
```

复用现有 `search-abort / maxNodes` 机制：`maxNodes` 的检查点已遍布 `_search` 内层
（expectiminimax.ts:969-976 的 budget cutoff 会置 `completed=false`），
**把 deadline 检查挂在同一批检查点上即可**，不需要新的中止通路。
建议按每 N 个节点（如 N=1024）取一次时钟，避免 `now()` 成为热点。

超时行为（严格照办用户要求）：

| 要求 | 实现要点 |
|---|---|
| 当前 depth 标记 incomplete | 与 `maxNodes` 耗尽走同一路径，置 `completed=false` |
| 返回最后 fully completed depth | `searchBestActionIterative` 已有 `completedDepth`，返回该层缓存的 root 结果 |
| 不接受 partial root result | 丢弃 `attemptedDepth` 层的 root bestAction，即使已有部分子动作完成 |
| 不写污染后续搜索的 incomplete TT entry | 现有 `storeTT` 已受 `completed && cacheable` 约束（transposition.ts），deadline 中止**必须**走同一约束，不得旁路 |

**额外前置**：`searchValue`（expectiminimax.ts:1006-1013）丢弃 `completed`。
只要它还存在，任何调用方都可能重犯 §2.1 的错误。建议 F1 要么删除它，要么改为返回带 `completed` 的结构。
**这是 F0.1 的头号教训**——F0 的全部尺子问题都源于这一个 API。

---

## 5. 第 5 项 — per-turn plan 重新评估（只设计，不实现）

**前提修正（用户指出的关键点，确认成立）**：猫回合内**鼠不会行动**。
已核对 `computeCatAiTrajectory`（engine.ts:3304-3360）：循环条件 `current.catMovesLeft > 0`，
行动权切换即 `break`/push 后退出。因此猫回合内的连续 4 步之间**没有对手介入**，
"对手偏离 PV"**不是**同回合 replay 的主要风险。→ **不能因为 `SearchResult` 当前没有 PV 就否定 one-search-per-cat-turn。**

真实风险是另一类：**回合内的 CHANCE 节点**（黄油再生等随机事件）。
若某一步之后存在 chance 分叉，则"计划"在该点分裂为多个分支，单条线性 PV 不足以覆盖。

### 方案 A — 显式返回 current-turn PV / `catTurnPlan`

- 做法：`searchActions` 在 root 记录 bestAction 后，沿"行动权未切换"的子链继续记录，形成 `catTurnPlan: SearchAction[]`，遇行动权切换或 chance 节点即截断。
- 复杂度：中。需在 root 之外向下传递/回传计划片段，改动集中在 `searchActions` / `runFixedSearch` / `SearchResult` 类型。
- 性能：**最好**。整回合一次搜索，节点数≈单次搜索，不重复展开。
- 正确性：最强。计划来自实际被证明最优的那条线，与搜索结果自洽。
- 风险：`SearchResult` 需扩字段（对 TT 无影响，因为计划不入 TT）；chance 截断后需回退到逐步搜索。
- **推荐为 F1 主方案。**

### 方案 B — 沿同回合读 TT `bestAction`

- 做法：不改返回结构。搜完后从当前状态起，反复 `probeTT(stateKey(s))` 取 `bestAction`、模拟前进，直到行动权切换。
- 复杂度：**最低**。`TTEntry` 已存 `bestAction`，几乎不改搜索代码。
- 性能：好（无重复搜索）。
- 正确性：**脆弱**。三处硬依赖：
  1. `useTranspositionTable` 必须为 true（当前 `DEFAULT_SEARCH_CONFIG` 里是 **false**）；
  2. TT 必须未被后续写入覆盖/驱逐（现无锁定机制）；
  3. 探针要求 `entry.depthTurns === depthTurns` **精确匹配**（probeTT，expectiminimax.ts:538-548），
     而回合内后续步的剩余深度与 root 不同 → **多数探针会 miss 或退化为不同深度的计划**，计划质量无保证。
- 裁定：**作为快速原型可行，作为正式方案不可靠。** 且它把"计划正确性"绑到一个纯粹的性能缓存上，
  违反"TT 是可丢弃缓存"的设计假设。

### 方案 C — shared-deadline per-step re-search

- 做法：回合内每步各搜一次，四步共享**一个** deadline（而非每步各给 100ms）。
- 复杂度：低。不改搜索，只改调用侧预算分配。
- 性能：**最差**。同回合前缀被反复重新展开；若无 TT 复用，接近 4× 成本；即使有 TT，深度不匹配（同上）也难命中。
- 正确性：好（每步都是当前局面下的真实最优），且天然处理 chance 分叉——不需要计划截断逻辑。
- 附带价值：它是**唯一**能在"回合内出现随机事件"时保持严格正确的方案。
- 裁定：**作为 A 的 fallback 路径保留**（A 遇 chance 截断时降级为 C）。

### 对比结论

| | 复杂度 | 性能 | 正确性 | 裁定 |
|---|---|---|---|---|
| A 显式 PV | 中 | **最好** | 最强 | **主方案** |
| B TT bestAction | 最低 | 好 | 脆弱（依赖 TT 开启 + 深度精确匹配 + 未被覆盖） | 仅原型 |
| C 共享 deadline 重搜 | 低 | 最差 | 好，且天然处理 chance | **A 的 fallback** |

**建议 F1 采用 A + C 混合**：正常走 A 的线性计划；遇 chance 节点截断处降级为 C 重搜。
B 不进入正式设计。**F0.1 不实现任何一项。**

---

## 6. 修订后的 F0 结论台账

| # | F0 原结论 | F0.1 裁定 |
|---|---|---|
| 1 | Temporary Retreat fixture 有效 | **撤回**。原 fixture 最佳动作 `dDist=-1`，非退让，且是猫必胜局面。已用 `temporaryRetreat_v2` 替换并证明式验证（§1） |
| 2 | oracle = depth-6 ground truth | **撤回**。共享预算 + `searchValue` 丢 completed → 多数动作不是 depth-6（§2.1）。修正后 12/12 budget-complete |
| 3 | Default 10/10、E1 10/10 | **数字不再采信但结论方向成立**。budget-fair 重测：两套均 12/12 strict、0 sound error（§3.2） |
| 4 | Medium 9/10（boxBlock fail） | **撤回**。测的是裸 `catAiMove`，游戏真实走 `computeCatAiTrajectory`（含 BFS 兜底）→ 真实路径 12/12（§3.3） |
| 5 | "E1 is never less deep than Default" | **撤回**。`temporaryRetreat @100ms`：def cd=3 / e1 cd=2（§4.1） |
| 6 | 50/100/150/250ms 时间 sweep | **降级为 approximate**。超支最多 107%；单次 d=4 可达 2376ms vs 配置 100ms（§4.2） |
| 7 | （F0 未涉及）Trap Value 可测 | **新增否定结论**。当前 oracle 下 `catPlaceTrap` 只能并列或低 1 分，不可能唯一最优（§3.4） |
| 8 | （F0 未涉及）oracle 深度优势 | **新增警告**。production 套 2/12 fixture 的 oracle 深度 = 被测深度 3，无认证能力（§2.4-1） |

---

## 7. F1 前置条件（按优先级）

1. **P0 — `searchValue` 丢弃 `completed`**（expectiminimax.ts:1006-1013）。
   F0 全部尺子问题的单一根因。删除或改为返回带 `completed` 的结构。
2. **P0 — 真实 deadline 能中止进行中的 depth**（§4.3）。否则 100ms/回合配置最坏情况失效 24 倍。
3. **P1 — 自由动作的 mate 距离记账**：深度按回合（`switched`），mate 分数按树边（`stepScore`）。
   二者不一致导致 `catPlaceTrap` 在所有必胜局面被系统性降 1 分（§3.4 原因 B，9/9 实测）。
   需裁定：mate 距离应按游戏 ply 还是按树边。**这是设计裁定，不是 bug 修复，需人工决定。**
4. **P1 — oracle 叶评估需含 trap 项**，否则陷阱决策永远不可测（§3.4 原因 A）。
   或改用"oracle 用 E1 之外的第三种含 trap 评估"以避免自我认证。
5. **P2 — Medium 基线指标改为"兜底触发率"**，而非"动作是否匹配"（§3.3）。
6. **P2 — benchmark 必须断言 oracle 深度严格大于被测深度**，否则跳过该 fixture 并标注（§2.4-1）。

---

## 8. 文件清单与复现

**未修改任何 `src/` 文件。** 以下为本轮新增（全部是 benchmark/fixture/report）：

| 文件 | 作用 |
|---|---|
| `f01fixtures.mts` | 12 个共享 fixture + 环形走廊/双门洞口几何 + `noTrapRuleSet` |
| `f01oracle2.mts` | **采信的 oracle**：每动作独立预算 + `commonCompletedDepth` 排名 + 裸/轨迹双 Medium |
| `f01oracle2sum.cjs` | 上者的摘要器 |
| `f01bench.mts` | 过渡版（独立预算但固定 d=6 排名）；保留以佐证 §2.2 对照 |
| `f01summary.cjs` | 上者的摘要器 |
| `f01explore.mts` | 环形族退让局面探索器（定位 `cat(4,3) mouse(2,4) hole(2,1)`） |
| `f01trapexplore.mts` | Trap Value 几何穷举（结论：不存在唯一最优位置，§3.4） |
| `f01medprobe.mts` | 确认 `boxBlock` 上 `catAiMove` 返回 NULL |
| `F0-hard-integration-audit.md` | 本报告 |

复现命令：

```bash
# 采信数据
F01_ORACLE_DEPTH=6 F01_PER_ACTION_NODES=60000 F01_DEPTH=3 npx vite-node f01oracle2.mts > f01oracle2.json
node f01oracle2sum.cjs f01oracle2.json

# 对照数据（过渡版 oracle）
F01_DEPTH=3 F01_ORACLE_DEPTH=6 npx vite-node f01bench.mts > f01out.json
node f01summary.cjs f01out.json

# Trap 几何穷举
TRAP_DEPTH=3 TRAP_MIN_SEP=5 npx vite-node f01trapexplore.mts

# F0 原始数据重放（第 4 项依据）
node f0summary.cjs
```

---

## 9. 已知残留问题（如实登记，未处理）

1. `f01bench.mts` 与 `f01fixtures.mts` 的 `TRAP_MOUSE` 不一致（`(4,2)` vs `(4,3)`）。
   `f01bench.mts` 为自包含未引用 fixtures 模块。因 `f01bench.mts` 已降级为对照数据、
   且 §3.4 结论不依赖 trapValue 的具体坐标，未统一。若 F1 复用 `f01bench.mts` 必须先统一。
2. `f01trapexplore.mts` 内部仍用共享预算 oracle（与 §2.1 同型缺陷）。
   仅用于探索"是否存在唯一最优位置"，且结论是"不存在"——共享预算只会**低估**动作值、
   不会凭空造出唯一最优，故结论方向不受影响。若 F1 要正式判定 Trap Value，需先改为独立预算。
3. `trapValue` fixture 实测为 A-mateWin 局面，`catPlaceTrap` 低 1 分。
   它当前**不是**有效的 Trap Value fixture，只是"陷阱合法且参与排名"的覆盖样本。
   有效 fixture 需等 §7-3/§7-4 裁定后重建。

**F0.1 到此结束。不进入 F1。**
