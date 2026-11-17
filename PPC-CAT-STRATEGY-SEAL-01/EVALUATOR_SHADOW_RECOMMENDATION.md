# EVALUATOR_SHADOW_RECOMMENDATION — PPC-CAT-STRATEGY-SEAL-01

Phase 6：E1 与 corrected-hole 的因果拆解 + 下一代战术特征架构建议（影子，不接线）。

- 轮次：PPC-CAT-STRATEGY-SEAL-01（对 PPC-CAT-STRATEGY-01 的独立正确性封口）
- 根：G6T2（冻结 24 根之一，REAL_HUMAN_REPLAY）
- HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`
- 冻结 fixture SHA256：`1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`（264328 字节）
- 探针：`PPC-CAT-STRATEGY-SEAL-01/probe/attribution.test.ts`
- 机器结果：`PPC-CAT-STRATEGY-SEAL-01/E1_CORRECTED_HOLE_ATTRIBUTION.json`
- 运行日志：`PPC-CAT-STRATEGY-SEAL-01/logs/attribution_run.log`（1 passed，147.82s，EXIT=0）
- 证据等级：A=代码级/可复核测量（给出 file:line 或工件字段）；B=逻辑推导＋测量实证；C=推测/次要。

**禁止事项核验：** `PRODUCTION_SOURCE_CHANGED=NO`、`GAME_RULES_CHANGED=NO`、
`SEARCH_MATH_CHANGED=NO`、`H1_CHANGED=NO`、`SIDECAR_CHANGED=NO`。本探针只读调用
生产评价器，未改任何生产源；提议特征仅在隔离探针内计算，**绝不接线到生产 Hard Cat**。

---

## 0. 前置门禁：量词门已修复，允许对正确安全标签评价新特征

任务规定「若量词门未通过且未修复，禁止用错误安全标签评价新特征」。本轮 P2–P5 已
修复量词门（F1 否定推导、F2 终局极性、F3/F4 prune），并产出 **20 个独立验证 PROVEN
证书**（0 FAILED / 0 policyMisses，见 `STRATEGY_CERTIFICATE_VERIFICATION.json`、
`ROOT_CLASSIFICATION_V2.json`）。因此本阶段使用的安全标签来自**独立重验**而非旧的
`!mouseForcesWin` 推导：

| 根动作前缀 | 末态猫位 | 独立量词裁决（H1=2，cap 600000） | 证书 |
|---|---|---|---|
| UURR | 1,5 | `MOUSE_FORCED_WIN_WITHIN_H1`（鼠强制胜，猫不安全） | mouseForce PROVEN |
| DRRR | 4,6 | `CAT_SURVIVAL_CERTIFIED_WITHIN_H1`（猫存活，安全） | catSurvive PROVEN（117382 叶/31236 分支/549 chance） |
| DRDR | 5,5 | `CHANCE_DEPENDENT_OUTCOME`（依赖吃黄油 chance） | 双方均不认证 |

这些标签与 Phase 4 `G6T2_RECERTIFICATION.json` 一致（DRRR 唯一安全 2 步前缀）。

---

## 1. 测量协议与可复现性（A 级）

两套搜索协议，**根值逐位相同**（`faithfulVsAttributionRootValues.*.match=true`，
所有 `bound="exact"`）：

| 协议 | 配置 | 用途 |
|---|---|---|
| faithful | `createSearchContext(rules,400000,TT,AB,ordering,0,false)` + leafEvaluator + capturePlan | 复现生产搜索的精确根值/计划 |
| attribution | `createSearchContext(rules,8000000,false,false,false,0,false)` + `evalCache=undefined` + 记录式 wrapper | 全窗口精确 minimax，访问**每个**视界叶，逐叶 dump 特征 |

- attribution 关闭 TT/AB/排序与 evalCache，cap=8_000_000（**探针专用全树 cap，不是
  量词搜索的 600000 cap**）；实测展开 1_283_054 节点 < 8M，**未截断**，
  `completed=true`，唯一视界键 25_214。
- faithful 与 attribution 的 E1/corrected × D2 根值完全一致 ⇒ 逐叶 dump 来自与生产
  搜索**同一批**决定叶，归因不是另一套搜索的产物。
- 评价器：E1=`evaluateForCat`（生产），corrected=`evaluateCorrectedHoleForCat`
  （feature-flag，**DEFAULT OFF**）。两者只读；唯一差异是 holeControl 符号。

---

## 2. E1 在 D2 的 U=D=L 平局：因果证明（A＋B 级）

**测量事实（`equalityCause`）：**

```
rootOrder            = ["U","D","L"]
E1_D2_rootValues     = [-658.2105263157898, -658.2105263157898, -658.2105263157898]
E1_D2_distinct       = 1   (E1_D2_tie = true)
每根决定叶数          = 22 / 22 / 22
三根共享决定叶交集    = 22   ← 三棵子树绑定到同一组 22 个视界叶
```

**因果结论（B 级，由 A 级测量支撑）：** E1 的 U=D=L 平局**不是**「不同叶恰好数值
相等」的巧合，而是**收敛**：U/D/L 三棵根子树的最优线都绑定到**同一组 22 个决定
视界叶**（交集=22，且每根恰好 22 ⇒ 三集合相同）。平局由共享决定叶集结构性地造成。

**决定叶特征级核验（A 级，样本 = E1 根 U 的第 1 个决定叶）：**

```
cat=3,3  mouse=7,6  currentPlayer=cat  catMovesLeft=4  mouseMovesLeft=0
catHoleGateDistance=8  mouseHoleGateDistance=1  holeControlMargin=7  mouseWinRouteDistance=2
holeControl_E1=+350   tempo=+200
contributions_E1 = {capturePressure:-630, mouseGoalThreat:-550, butterRace:0,
  confinement:-44, mobility:0, trapControl:0, tunnelControl:0,
  holeControl:+350, voronoiBalance:+15.789473684210526, tempo:+200}
Σ contributions_E1 = -658.2105263157895 === total_E1   (逐位相等，已断言)
```

即根值 === 决定叶值（`stepScore` 对非终局启发式叶**原样保留**，故根值等于其绑定
决定叶的值；chance 线则为其期望）。**holeControl_E1=+350 是符号缺陷的直接体现**：
猫离洞门远（catHoleGateDistance=8）反而被 E1 奖励 +350（margin=cat−mouse=7>0）。

---

## 3. corrected-hole 与 E1 的唯一差异：holeControl 符号（A 级）

**恒等式（`holeControlIdentity`，全 25_214 叶逐叶核验）：**

```
correctedTotal === E1total − 2·holeControl_E1   （当两侧门距均非 null）
leavesChecked=25214  bothReachableLeaves=25214  maxAbsError=0  verified=true
```

- 代码证据：`src/game/ai/correctedHoleLeaf.ts` 的 `correctedHoleControlValue` 用
  margin = `mouseHoleGateDistance − catHoleGateDistance`（与 E1 **反号**）；
  `correctedHoleEvalTotal = total − contributions.holeControl + correctedHoleControlValue`。
  E1 的 `holeControl`（`evaluation.ts:692-695`）= `clamp(holeControlMargin/boardSize,-1,1)*500`，
  margin = `catHoleGateDistance − mouseHoleGateDistance`。
- 因 `correctedHoleControl = −holeControl_E1`（同 |margin|、反号），故
  `corrected = E1 − holeControl_E1 + (−holeControl_E1) = E1 − 2·holeControl_E1`。
  实测 maxAbsError=0 ⇒ 该恒等式在**每个**视界叶精确成立，不是近似。
- **D1 交叉核验（`equalityCause.D1`）：** E1 U=−247.23684210526318，
  corrected U=−447.2368421052632，delta=−200=−2×100 ⇒ 决定叶 holeControl_E1=100，
  `decisiveLeafHoleControlE1=100`，`identityHolds=true`。与上一轮
  `PLANNER_D1_DECISION_AUDIT.json` 的 D1 数值逐位一致。

---

## 4. corrected 如何打破平局：特征级分解（A＋B 级）

**测量事实（`equalityCause.corrected_*`）：**

```
corrected_D2_rootValues = [-1145.4473684210525(U), -1054(D), -1145.4473684210525(L)]
corrected_D2_distinct   = 2     ← D 与 U/L 分离
每根决定叶数             = 1 / 1 / 1
三根共享决定叶交集       = 0     ← 收敛被打破：三根绑定到不同叶
```

**三根 corrected 决定叶（A 级，逐叶 dump）：**

| 根 | 决定叶 cat/mouse | catHoleGateDist | mouseHoleGateDist | mouseWinRouteDist | holeControl_corr | mobility | voronoi | total_corr |
|---|---|---|---|---|---|---|---|---|
| U | 4,4 / 9,0 | 6 | 2 | 13 | −200 | 62.5 | −78.947 | −1145.447 |
| D | 4,6 / 9,0 | **4** | 2 | 13 | **−100** | **125** | −150 | **−1054** |
| L | 4,4 / 9,0 | 6 | 2 | 13 | −200 | 62.5 | −78.947 | −1145.447 |

**因果结论（B 级）：**
1. corrected 把 holeControl 反号后，**绑定叶发生迁移**：E1 的共享决定叶
   （cat 3,3 / mouse 7,6，mouseWinRouteDistance=2）不再是 corrected 的绑定叶；
   corrected 的绑定叶变为 cat 4,4 / 4,6 / mouse 9,0（mouseWinRouteDistance=13）。
   符号缺陷此前**掩盖了洞门距离信号**，使搜索收敛到共享叶集；修正后洞门拦截
   差异得以 surfaced。
2. **D 优于 U/L 共 91.447**（−1054 vs −1145.447），特征级来源：
   - D 的猫更靠近洞门（catHoleGateDistance=4 vs 6）⇒ corrected holeControl 惩罚更小
     （−100 vs −200，差 +100）；
   - D 的猫机动性更高（mobility=125 vs 62.5，差 +62.5）；
   - D 的 voronoi 更差（−150 vs −78.947，差 −71.05）；
   - 净差 = +100 +62.5 −71.05 ≈ +91.45 ⇒ D 绑定叶值更高。
3. U 与 L 在 corrected 下**仍收敛**（同一叶 cat 4,4），只有 D 分离 ⇒ 三向平局被
   打破为「D 安全、U/L 不安全」，与 §0 的独立量词裁决（DRRR 存活 / UURR 鼠强制胜）
   **方向一致**。

**这正是任务要求证明的「根值相等之因」：** E1 平局 = holeControl 符号缺陷导致的
决定叶收敛；corrected 通过反号恢复洞门距离信号，使 D 的更优拦截位置分离出来。

---

## 5. 现有 tempo vs 提议跨回合战术 tempo（A 级测量 + B 级区分）

### 5.1 现有 `tempo`（生产，`evaluation.ts:703-709`）

```
base = max(1, min(catBaseMoves, mouseBaseMoves))
cat to move:  ((catMovesLeft − mouseMovesLeft)/base)*200
else:        −((mouseMovesLeft − catMovesLeft)/base)*200
```

- **语义：仅当前回合剩余步数差**，被回合相位锁定（turn-phase-locked）。
- **D2 视界判别力 = 无（A 级测量）：** 全 25_214 个视界叶的 tempo 贡献恒为
  `+200.000000000`，唯一输入相位 `cat|4|0`（catMovesLeft=4, mouseMovesLeft=0）。
  在回合边界上它是**常数**，对 U/D/L **零判别力**。
- **三末态判别力 = 无（A 级测量）：** UURR / DRRR / DRDR 的现有 tempo 贡献**全部
  = −150**（输入均为 mouse to move, catMovesLeft=0, mouseMovesLeft=3）。三个末态
  战术裁决截然不同（鼠强制胜 / 猫存活 / chance 依赖），现有 tempo 却完全相同。

### 5.2 提议跨回合战术 tempo（SHADOW / PROPOSED，仅探针，不接线）

```
mouseTurnsToGoal = ceil(mouseWinRouteDistance / mouseBaseMoves)
catTurnsToGate   = ceil(catHoleGateDistance   / catBaseMoves)
margin           = catTurnsToGate − mouseTurnsToGoal   （单位：回合；负=猫先于鼠到门）
```

- **语义：多回合「鼠带黄油入洞」竞速 vs「猫到洞门拦截」竞速**，跨回合，不被单回合
  相位锁定。与现有 tempo 的本质区别：现有 tempo 只看**本回合**剩余步数差（边界上
  恒定）；提议信号看**未来数回合**的到达时间差，**在不同猫末态之间确实变化**。

**三末态测量（A 级，`tempoAnalysis.proposed.endStates`）：**

| 前缀 | mouseWinRouteDist | catHoleGateDist | mouseTurnsToGoal | catTurnsToGate | margin | 独立量词裁决 |
|---|---|---|---|---|---|---|
| UURR | 8 | 9 | 2 | 3 | **+1** | MOUSE_FORCED_WIN_WITHIN_H1（不安全） |
| DRRR | 8 | 4 | 2 | 1 | **−1** | CAT_SURVIVAL_CERTIFIED_WITHIN_H1（安全） |
| DRDR | 8 | 4 | 2 | 1 | **−1** | CHANCE_DEPENDENT_OUTCOME |

- **判别力（B 级）：** 提议 margin 把 UURR(+1，猫慢于鼠 ⇒ 鼠胜) 与 DRRR/DRDR(−1，
  猫快于鼠 ⇒ 安全/chance) **分开**，方向与独立量词裁决一致；现有 tempo(−150 常数)
  做不到。
- **诚实局限（B 级，必须记录）：** 提议 margin **不能**区分 DRRR(存活) 与 DRDR
  (chance 依赖)——两者同为 −1。DRDR 的 chance 依赖来自**吃黄油 CHANCE 分支**，
  任何确定性竞速特征都无法捕获。⇒ 提议跨回合 tempo 是**方向性必要信号，不是完整
  战术分类器**；它必须与量词证书**联合**使用，绝不能替代证书去「认证」存活。

---

## 6. 下一代战术特征架构建议（影子，C 级建议 / 不接线）

基于以上 A/B 级测量，提出**隔离影子**架构建议（仅供 ChatGPT 裁决，本轮不实现、
不接线、不改生产评价器/H1/搜索/规则）：

1. **修复 holeControl 符号（最高优先，A 级证据）。** E1 的
   `margin=catHoleGateDistance−mouseHoleGateDistance` 奖励猫**远离**洞门，与战术
   语义相反；corrected 的反号在 25_214 叶上精确成立且打破 D2 平局、使 D 分离。
   建议把 corrected-hole 作为**候选**纳入下一代评价器消融，但**须先经过量词门 +
   独立证书重验**，不得仅凭启发式根值变化就接线。

2. **引入跨回合战术 tempo 作为影子特征（B 级证据）。** 现有 tempo 在回合边界恒定
   （+200/−150），对根动作零判别力；提议 `catTurnsToGate − mouseTurnsToGoal` 能
   方向性区分安全/不安全末态。建议作为**独立影子列**与现有 10 特征并列评估，
   **不替换**现有 tempo（两者语义不同：本回合步数差 vs 跨回合到达竞速）。

3. **特征必须与量词证书联合，而非替代（B 级，硬约束）。** 提议 tempo 无法区分
   存活与 chance 依赖（DRRR/DRDR 同 −1）。任何「猫存活」认证仍须由独立
   `catSurvive` 搜索 + 证书验证给出；启发式特征只做**排序/剪枝提示**，不做安全
   判定。禁止用 `!mouseForcesWin` 推导存活（F1 已修复，不得回退）。

4. **chance 依赖单独建模（B 级）。** DRDR 的 `CHANCE_DEPENDENT_OUTCOME` 来自吃黄油
   的均匀 ghost/debt CHANCE。下一代架构应把「∀ 正概率 outcome」的量词语义显式纳入
   战术评估，而不是用单一确定性竞速标量掩盖 chance 分支。

5. **评价器消融的验收门（A 级流程）。** 任何新特征/符号修正进入生产前，必须：
   (a) 通过修复后的量词门（五类＋UNRESOLVED，terminal-before-horizon，cap→UNRESOLVED）；
   (b) 对 24 根重跑独立证书验证（0 policyMisses）；
   (c) 在冻结 fixture（SHA `1a59787a…`）上逐位复现根值；
   (d) 不降低 600000 量词 cap、不删根、不缩减 H0/H1。

---

## 7. 交付物与禁止事项核验

- 本文件 + `E1_CORRECTED_HOLE_ATTRIBUTION.json`（315964 字节）+ `logs/attribution_run.log`。
- 所有数值均为**本轮 live 测量**（147.82s，EXIT=0），非沿用上一轮快照；faithful 与
  attribution 双协议根值逐位一致，identity maxAbsError=0。
- `PRODUCTION_SOURCE_CHANGED=NO`、`GAME_RULES_CHANGED=NO`、`SEARCH_MATH_CHANGED=NO`、
  `H1_CHANGED=NO`、`SIDECAR_CHANGED=NO`、`NEW_EFFICACY_AUTHORITY=NONE`。
- 提议特征**仅影子**，未接线生产 Hard Cat；未修改生产评价器。
- `COMMIT=NO`、`PUSH=NO`、`MERGE=NO`。本轮完成后停止，等待 ChatGPT 最终裁决。