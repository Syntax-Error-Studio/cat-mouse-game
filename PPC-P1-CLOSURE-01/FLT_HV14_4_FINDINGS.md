# FLT-HV14-4 归因报告

测试：`src/game/ai/__tests__/forcedLossTieBreakHv14Reachability.test.ts > FLT-HV14-4`
报错：`GAME3 T4 root value reproduces: expected 999996 to be -1052.9473684210527`
裁决：**`TEST_EXPECTATION_OR_HARNESS_ISSUE`**（黄金值是过期值；引擎侧数值**经独立验证为正确**）

---

## 0. 结论先行

1. 该失败在 **HEAD（四轮之前）就已存在且完全一致**，不是本轮引入。
2. 当前引擎给出的 `999996` **不是一个误导性的估值，而是一个真实的"猫本回合将死"**：`999996 = MATE_SCORE(1e6) − 4`，即距终端 4 个游戏时间单位。
3. 这个将死用**真实引擎**穷举 212 条合法猫动作序列验证过，**唯一**杀法 `下 下 下 左`，且用**真实老鼠走子规则**独立复核：老鼠四个方向都走不动。
4. 当前生产规划器在这个根上**就会走这条杀法**并结束对局；而日志里的旧构建走了 `下 右 右 右`，**放掉了这个胜利**。
5. 因此该测试的断言 `res.value === t.rootValue` 是在"用一条正确的新答案去比一个旧构建写下的错误答案"——按项目约定 8 个分类，落入 `TEST_EXPECTATION_OR_HARNESS_ISSUE`。

---

## 1. 被比较的两个数分别是什么

日志 `ai-training/human-logs/PPC-HV14/GAME3_H1.txt`，`Turn #4`：

```
cat=(5,1)  mouse=(9,0)  butter=false skill=false
catMoves=4 mouseMoves=0  trap=(1,1) remain=0
SEARCH: cDepth=2 aDepth=3 nodes=1025 elapsedMs=101.5
DEADLINE: deadlineFired=true budgetFired=false elapsedMs=101.5 budgetMs=100 overNominalBudget=true
ROOT_VALUE=-1052.9473684210527 mate=null
ROOT_ACTIONS:
  ArrowDown : value=-1052.9473684210527 mate=null bound=exact
  ArrowRight: value=-1052.9473684210527 mate=null bound=exact
  ArrowLeft : value=-1127.289473684211 mate=null bound=upper
  ArrowUp   : value=-1127.289473684211 mate=null bound=upper
PLAN: catStep ArrowDown → ArrowRight → ArrowRight → ArrowRight
```

测试用的是 `searchResult(t.state, t.completedDepth /* =2 */, ctx)`，`ctx` 的 flags 与生产**逐项相同**（`maxNodes 500k, TT/AB/ordering ON, maxThreatExtensions 0, useThreatOrdering false`），leaf 注入 `evaluateCorrectedHoleForCat`（= 日志头的 `HARD_LEAF=H1`）。

因此这不是"测试用了不同配置"，而是同一配置在同一状态上给出两个不同答案。

---

## 2. 状态恢复是否忠实 —— 是

`P3-A`（`_raw/hv14_t4_probe.json`）：

```
restoredStateKey === loggedStateKey   →  true
key = t__e__…__#single#playing#cat#5,1#9,0#4#0#4,8|8,3##0#0#0#1,1#0###10:4:3:3:4:2:single:hard
fingerprint: phase=playing currentPlayer=cat cat=(5,1) mouse=(9,0) catMovesLeft=4
             mouseMovesLeft=0 trap=(1,1) catTrapsRemaining=0 mouseHasButter=false
             pendingButterSpawns=[] pendingButterPlacementDebt=0 blockedTunnels=[]
             noMoveLossAtRoot=false
```

`stateKey` 逐字相同（379 字符，含 P1-ID 加固后的 18 个分量），根上也没有 RULE-A 判负。⇒ **"状态恢复不忠实"这条假设被排除。**

---

## 3. 当前引擎在任何深度都给同一个答案

`P3-A` 深度扫描（每次都新建 ctx，flags 同上）：

| 入口 | depth | value | mate | completed | nodes | terminalNodes | maxDepthReached |
|---|---|---|---|---|---|---|---|
| `searchResult` | 1 | 999996 | cat | true | — | — | — |
| `searchBestAction` | 1 | 999996 | cat | true | **22** | **1** | 4 |
| `searchResult` | 2 | 999996 | cat | true | — | — | — |
| `searchBestAction` | 2 | 999996 | cat | true | 554 | 1 | 8 |
| `searchResult` | 3 | 999996 | cat | true | — | — | — |
| `searchBestAction` | 3 | 999996 | cat | true | 794 | 1 | 13 |
| `searchResult` | 4 | 999996 | cat | true | — | — | — |
| `searchBestAction` | 4 | 999996 | cat | true | 66,922 | 1 | 17 |

迭代入口（生产路径，无 deadline）`maxDepthTurns=1/2/3` 也全是 `999996 mate=cat`，`bestAction=ArrowDown`。

`capturePlan=false/true` 都试过，值不变（23 / 555 节点）。⇒ 不是 plan 捕获导致的副作用。

**深度 1 = 22 个节点就触到唯一的终端节点**，`terminalNodes=1`，`maxDepthReached=4`：即在**猫自己的这一个回合的 4 步之内**到达终局。

---

## 4. 这个"将死"是真的吗 —— 三条独立验证

### 4.1 真实引擎穷举（`P3-B`，`_raw/hv14_t4_winsearch.json`）

对根做 1..4 步的**全部**猫动作序列穷举，两条臂各自独立：

| 臂 | 转移函数 | 回合交接 | 判负 | 探索序列数 | 找到的杀法 |
|---|---|---|---|---|---|
| ARM-REAL | `createEngineRuleSet().catMove` | `endTurn` | `applyNoMoveLoss` | 212 | **1** |
| ARM-SIM | `simulateSearchAction`（AI 自己相信的转移） | 同左 | 同左 | 212 | **1** |

两臂找到的是**同一条**：

```
seq = 下 下 下 左
cat  = (8,0)   mouse = (9,0)   phase = cat_wins   catMovesLeft = 0   mouseMovesLeft = 4
```

两臂 212 条序列结果完全一致 ⇒ **不存在「模拟器与真实引擎分歧」**。

### 4.2 独立于判负内核（`P3-D`，`_raw/hv14_t4_terminal.json`）

`applyNoMoveLoss` 是引擎侧判负内核，用它充当"猫赢"的裁判有循环论证嫌疑。所以再拆一层：直接看棋盘邻域 + 直接调**真实老鼠走子** `rules.mouseStep`。

```
老鼠在 (9,0)
  上 (8,0)  = 猫所在格
  下 (10,0) = 出界
  左 (9,-1) = 出界
  右 (9,1)  = box（老鼠不能推箱子）
真实 mouseStep 四个方向：mouseMoved 全为 false
独立裁决 = MOUSE_HAS_NO_LEGAL_STEP
```

> 判据用的是"**老鼠坐标有没有变**"，不是"stateKey 有没有变"——非法方向上引擎会原地不动并把局面结算成 `cat_wins`，key 变了但老鼠没动。这一点在探针第一版里踩到过，已修正。

⇒ 老鼠被卡死在左下角（上是猫、右是箱子、下左是边界），**这是"送死"规则的真实触发，不是估值错觉**。

### 4.3 当前生产规划器的实际决策（`P3-C`，`_raw/hv14_t4_planner.json`）

`planHardCatTurn(root, { timeBudgetMs: 100, maxDepthTurns: 4, maxNodes: 500k, leafEvaluator: H1 })`：

```
currentPlan        = 下 下 下 左
currentValue       = 999996   currentMate = cat
currentCompletedDepth = 1     currentAttemptedDepth = 2
deadlineFired      = true     elapsedMs = 101.9ms
用真实引擎重放该计划 → phase 走到 cat_wins（把 8,0 站住，老鼠死）
```

对照——用真实引擎重放日志里的旧计划 `下 右 右 右`：

```
下 → cat(6,1)  …  右 → cat(6,2)  …  右 → cat(6,3)  …  右 → cat(6,4)
末态 phase=playing player=mouse mouseMovesLeft=4     ← 没有赢
```

⇒ **旧构建在这一回合放掉了一个必杀，当前引擎会走杀法。** 99.8ms 内（深度 1，22 节点）就证完了。

---

## 5. 为什么只在这一根失败

45 个真实根里，日志自身记录的 mate 根有 4 个：

| 根 | 日志 ROOT_VALUE | mate |
|---|---|---|
| GAME1 T4 | -999995 | mouse |
| GAME3 T8 | 999999 | cat（距终端 1） |
| GAME4 T9 | -999995 | mouse |
| GAME5 T12 | 999996 | cat（距终端 4） |

其中 GAME5 T12 的 `999996` 与 GAME3 T4 当前引擎的 `999996` **数值完全相同**——说明旧构建**确实会**报这种 cost=4 的猫将死。所以差异不是"旧构建不会报将死"，而是"旧构建在 GAME3 T4 这一个位置上没看见"。

结合 FLT-HV14-4 只在这一根失败、其余 **44 根逐值复现**，可以定位为**单点盲区**，而不是系统性口径差。

> **这 44 这个数字不是从 FLT-HV14-4 的日志里读出来的。** 该测试在第 494 行首次不符就 `throw`，因此它自己只验证到第 20 个根（GAME1 4 + GAME2 12 + GAME3 T1–T3 3），其后的 25 个根**从未被执行到**。为此本轮另写了 `P3-E`（`_raw/hv14_all_roots.json`）做**全 45 根复算**，用与 `rerunRoot` 相同的配置重跑每一个根，不提前中止：
>
> ```
> P3-E roots=45  identityOk=true  valueMatches=44  mateMatches=44  deviations=1
>   DEVIATION GAME3 T4 depth=2  log=-1052.9473684210527/null  now=999996/cat
> ```
>
> 即：45 个根的身份全部对上，**值与 mate 各 44 个逐位相同，偏差恰为 1 个，且就是 GAME3 T4**。
旧构建源码不在本仓库内（历史被压成 `57a15e4 baseline(research)` 一个快照提交，无法用 git 回溯到 2026-11-10 的那次构建），因此**具体是哪一处差异造成的盲区属于推断，本轮不给结论**；本轮只给可证事实：

- 事实 A：当前引擎在这个位置给出的 **999996 是真的将死**（§4 三重验证）。
- 事实 B：日志给的 **-1052.9473 在当前引擎的任何深度 1..4 都取不到**。
- 事实 C：该失败在 **HEAD 就存在且逐字相同**（`PPC-P1-ID-01/logs/baseline_flt_hv14.log`），与本轮四轮补丁无关。

---

## 6. 裁决、影响面与后续

**裁决：`TEST_EXPECTATION_OR_HARNESS_ISSUE`**

理由：断言的期望值 `t.rootValue` 来自一份 **无法被正确引擎复现**的记录；而当前引擎的值经真实引擎穷举 + 独立走子规则双重证实为真。**错误在期望值一侧，不在引擎一侧。**

**这不是"以前就失败所以无害"的结论**——恰恰相反：如果只因为"它一直是红的"就忽略，会漏掉这里真正发生的事，即**引擎能力相对 HV14 语料已经前进了一步**。这一点才是需要登记的：

> **HV14 语料不再是当前引擎的完全可复现基线：45 个根里 44 个复现，GAME3 T4 已因引擎变强而不可复现。**
> 任何以 HV14 根值为前提的后续实验（含 CAT-STRATEGY-01 的 G 系列结论、M3-lite 记忆对照）都必须显式扣除这一根，否则会把"引擎变强"误读成"回归"。

**影响面**

| 项 | 是否受影响 |
|---|---|
| FLT-HV14-1 / -2 / -3 | 否（均通过；-1 只断言 `stateKey === loggedKey`，未动） |
| FLT-HV14-4 的其余断言（bound 剖面、conflict 计数、`firingRoots=['GAME1T4']`、`truncatedRootCandidates`） | 否：它们在 `expect(res.value)` 之后，本轮失败在第 494 行就中止，**尚未被验证到**。这一点必须如实登记：修好期望值之后要重新确认其余断言仍成立 |
| 四轮补丁 | 无关（HEAD 同样失败） |
| 棋盘规则 / 判负规则 | 未改动（`mobility.ts` 与 HEAD 字节相同） |

**给后续阶段的选项**（本轮不实施，需要单独授权，因为它动的是冻结取证的黄金值）：

1. 把 `GAME3_H1.txt` 的 T4 这一根标注为 `STALE_ENGINE_BLINDSPOT`，让 FLT-HV14-4 对这一根只断言"当前值为真实杀法"，不对齐旧值；
2. 或者用当前引擎重新生成一份 HV14 基线语料（会改变 44 个根的可比性与全部下游结论，代价大）；
3. 或者把 FLT-HV14-4 的断言从"逐值复现"改为"主值不劣于日志值"，并单独保留一份 `HV14_REPRODUCTION_GAP.json` 记录这一个例外。

三条路都需要评审，本轮**只记录，不改**。
