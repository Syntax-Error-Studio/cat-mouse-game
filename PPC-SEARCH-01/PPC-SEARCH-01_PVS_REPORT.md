# Project Perfect Cat｜PPC-SEARCH-01
## PVS 单因素搜索加速原型与 D2 可行性验证

**性质**：独立实验报告。与冻结权威分离。未修改 `src/`、未修改 H1、未修改 100ms/150ms 预算、未 commit/push/reset/stash/clean。
**复现**：`npx vitest run --config PPC-SEARCH-01/vitest.config.mts`（隔离配置，产品 `vitest.config.ts` 未动）；汇总 `python PPC-SEARCH-01/analyze.py`。

---

## 一、通俗中文总结（六问直答）

### 1. PVS 能否在当前 Expectiminimax 中正确工作？

**值层面能，选招层面不能——而且原因是当前的分值边界合同缺一条语义，不是实现疏忽。**

25 个冻结根 × D1/D2（50 次搜索）+ 9 个 ruleset v2 控制 × D1/D2（18 次）：`value`、`mate`、`completed` **全部逐位相同**，无假 mate、无非法动作、无概率质量错误、无截断泄漏。但 **bestAction / catTurnPlan 在 G1T10 上不同**（值相同，计划 `↓↓↓→` vs `↑↑↑↑`），`C_PUSH` 控制 D2 同样出现计划分歧（值相同）。

根因已定位到代码：

```ts
// src/game/ai/expectiminimax.ts:1570
const boundType = cutOff ? (maximizing ? 'lower' : 'upper') : best!.bound;
```

`bound` 记录的是**是否发生剪枝**（cutoff 轴），从来不是**窗口是否被收窄**（window 轴）。这条规则在"全窗口搜索"下是定理：不剪枝 ⇒ 全部候选都被完整展开 ⇒ 值精确。PVS 恰好打破了这个前提：一个在 `(X,X)` 窗口中**没有剪枝**的 MAX 节点只证明了 `value ≤ X`，而它的子节点若是叶子会返回 `'exact'`，于是 `best.bound === 'exact'` → `isCertifiedResult()` 判真 → 写进 **EXACT-only TT** → 再被 `firstEqualAction` / `equalActionsList` 当成"已证明同分的着法"参与等分图构建。

也就是说：**这版 PVS 的 scout 结果会被当成精确值缓存，并按"已证同分"参与计划抽取。** 这不是 PVS 的数学错误，是 `ScoreBound` 表示力不足。按本轮 P1 第 6、7 条与第五节的要求，这属于**必须先行报告的设计阻碍**，不是可以用数值 epsilon 绕过的问题（本实现也没有用 epsilon：窄窗口是结构性表达的）。

我还把这个阻碍真的修了一版（arm D）来验证：修好后 **G1T10 的计划与生产恢复一致**（证明分歧确由缓存污染造成），但节点数从 12,225 涨到 **365,612**（对生产 547 是 **668 倍**），墙钟从 7.6s 涨到 **95s**。原因是 scout 结果一旦按规定不能入库，这套搜索赖以生存的 EXACT 缓存就被断粮了。也就是说：**"坏语义"其实一直掩盖着一个更严重的问题——PVS 与这套引擎的缓存经济不兼容。**

### 2. 它是否实际减少搜索节点？

**没有，净增。** D2 全部 25 根：节点总数 451,999 → 538,765（**+19.2%**），逐根中位比值 **1.127**；D1：中位比值 1.077。仅 2/25 个根节点数下降（G4T2 −19%、G8T7 −11%），其余上升。

原因不是"PVS 有额外开销"，而是**它要省的那棵树本来就不存在**：生产排序已经让 **93.7% 的剪枝发生在第一着**（`firstMoveCutoffs / alphaBetaCutoffs`）。PVS 的前提是"后面的候选多半更差，可以廉价否证"；本引擎里这个前提早已被走法排序吃掉，于是第 2 个候选之后，PVS 把"一次完整搜索"变成"一次 scout + 一次回搜"，纯加成本。

### 3. D2 是否更接近 100ms 可完成？

**没有，两个臂都停在 D1。** 8 个代表根 × 3 次串行重复：A 与 B 的 `completedDepth` 中位数都是 1，`fallback` 都是 0，实测墙钟 102–120ms（预算是 100ms，超出部分属于既有 deadline 检测粒度，两臂一致）。D2 的墙钟中位是 0.15–70 秒量级，与 100ms 差 1–3 个数量级，PVS 的 ±16% 完全不改变这件事。

### 4. 它是否影响正常的猫完整回合计划？

**影响了，而且这正是被门禁抓到的地方。** 23/25 个根的计划逐字相同；1 个根（G1T10）不同；1 个控制（C_PUSH D2）不同。两处都是**同分不同招**，不是"更差的招"。但对引擎而言这是实质差异：`extractBestCatTurnPlan` 依赖 `planBranches` / 等分图，等分图成员资格变了，计划就变了。**"值一样"不能替代"计划一样"**，预注册 T2 门因此判 FAIL。

### 5. 哪些类型的局面加速明显，哪些没有？

没有一类明显加速。分层看（D2，逐根中位）：

| 分组 | 根数 | 墙钟加速中位 | 节点比值中位 |
|---|---|---|---|
| 全部 | 25 | **0.938** | 1.127 |
| 无 CHANCE 节点 | 6 | 0.960 | 1.066 |
| 含 CHANCE 节点 | 19 | 0.938 | 1.133 |

个别根有 −19% 节点的收益（G4T2、G8T7），但墙钟没跟上（分别为 0.98× / 0.94×）——说明这里节点数已不是墙钟的主项。反向的极端是 **G1T10：547 → 12,225 节点（22.35×）、457ms → 11,958ms（26×）**，以及 **G8T1：2.14× 节点、0.50× 墙钟**。两者都是 CHANCE 主导、且生产臂**零剪枝或近零剪枝**的根。

### 6. 是否值得进一步正式验证？

**不值得，NO_GO_PVS。** 三条独立理由，任一条都足以否决：

1. **性能门 FAIL**：预注册门槛是 D2 墙钟逐根加速中位 ≥ 1.25，实测 **0.938**（PVS 慢 6.6%）；节点中位 +12.7%；最坏根慢 26 倍。不是"接近门槛"，是方向相反。
2. **计划同一性门 FAIL**：1/25 根 + 1/9 控制出现同分不同招。其中 G1T10 由 `bound` 语义缺口造成，修好后消失（但代价是 668 倍节点）；`C_PUSH` 那处**修不好**，它来自 PVS 与既有"认证平局"机制（PPC-RB1）的语义冲突。
3. **修好也不是出路**：arm D 表明"正确实现的 PVS"在本引擎里比"错误实现的 PVS"慢 30 倍以上。

按预注册的反作弊条款，本轮**不得**叠加 aspiration window / LMR / 跨回合 TT / 战术证书来救这次结果，也没有这么做。

---

## 二、状态块

```text
PPC_SEARCH01_STATUS = COMPLETE__NO_GO_PVS
SOURCE_BASELINE = branch ppc/2026-11-03-a0-trap-fix @ 9ba04b5, worktree DIRTY
RULESET_VERSION = 2
PVS_CORRECTNESS = VALUE_MATE_COMPLETED_PASS_50_OF_50__PLAN_IDENTITY_FAIL_1_OF_25
D1_PARITY = PASS (25/25 roots: value, mate, completed, bestAction, catTurnPlan)
D2_PARITY = FAIL (24/25 roots; G1T10 bestAction+plan differ, value/mate/completed equal)
MATE_DISTANCE_PARITY = PASS (mate field identical on 50 root-depth pairs + 18 control runs)
CHANCE_PARITY = PASS (chanceNodes == fullWindowChanceSearches on every run, all arms)
TT_EXACT_PARITY = FAIL_BY_CONSTRUCTION (bound states the cutoff axis, not the window axis; a scout can be stored as EXACT)
PLAN_REPLAY_PARITY = PASS (50/50 plans applied through catMove/catPlaceTrap, 0 rejected steps, both arms)
PVS_RESEARCH_CALLS = G1T10-D2: 11,754 scouts / 3,154 re-searches / 8,600 skips
NODE_REDUCTION = NEGATIVE (+19.2% total at D2, median root ratio 1.127; D1 +7.7%)
D2_WALL_SPEEDUP = 0.938 median (gate 1.25) FAIL; total wall +15.9%
D1_COMPLETION_100MS = PASS, depth 1 on 8/8 probed roots, fallback 0, both arms
D2_COMPLETION_100MS = 0 of 8 probed roots, BOTH arms
TOTAL_TURN_150MS = NOT_EXERCISED (main search only, per pre-registration)
MEMORY_PEAK = NOT_MEASURED as RSS; TT writes A 441,761 vs B 456,341 over 25 roots; arm D heap delta 0.3-7.4 MiB per search
REGRESSION_ROOTS = G1T10 (plan identity + 22.35x nodes), C_PUSH@D2 (plan identity, survives the bound fix), G8T1 (2.14x nodes)
ARM_D_BOUND_FIX = PLAN_IDENTITY_RESTORED_ON_G1T10__NODES_668x__CACHE_DEFUNDED
NEXT_STAGE_GATE = CLOSE_PVS / no production integration
PRODUCTION_AI_CHANGED = NO
GAMEPLAY_RULES_CHANGED = NO
H1_CHANGED = NO
SIDECAR_CHANGED = NO
MAIN_SEARCH_BUDGET_MS = 100
TOTAL_TURN_BUDGET_MS = 150
HEAVY_WORKER_CONCURRENCY = 1
NEW_FORMAL_AUTHORITY = NONE
COMMIT_PUSH_STATUS = NONE
```

---

## 三、P0 真实工程基线

| 项 | 实测值 |
|---|---|
| 分支 | `ppc/2026-11-03-a0-trap-fix` |
| HEAD | `9ba04b5` |
| 工作区 | **dirty，82 项**（79 项旧改动 + 上一轮 `PPC-ARIMAA-01/` / `PPC-PTB-1A/` 两个未跟踪目录 + 本轮目录） |
| `src/` 差异 | 23 文件 / +1376 / −163，**本轮前后逐字一致**（全部是本轮之前就存在的未提交修改） |
| 规则版本 | `GAMEPLAY_RULESET_VERSION = 2` |
| 审计对象 | **工作树**，不是 HEAD |
| 叶子模式 | `HARD_LEAF_MODE = baseline`（H1 = `evaluateForCat`），未改 |
| 生产调用链 | `planHardCatTurn` → `searchBestActionIterative(state, {maxDepthTurns:4, maxNodes:500_000, useTT:true, useAlphaBeta:true, useMoveOrdering:true, useThreatOrdering:false, maxThreatExtensions:0, deadlineMs})` |
| 计划执行 | `computeCatAiTrajectory` → `applyPlanCatAction` → **`catMove` / `catPlaceTrap`**（不是 `simulateSearchAction`） |

最后一行对本轮很重要：搜索内部的 plan replay 用的是 `simulateSearchAction`，而**引擎真正执行计划用 `catMove`**。两者不是同一个函数，因此额外做了 `pvs_engine_replay.test.mts` 用引擎函数复验（见 P3-V）。

---

## 四、P1 PVS 能否安全迁移：逐条对照

| # | 要求 | 本实现 | 结论 |
|---|---|---|---|
| 1 | 保留 MAX/MIN/CHANCE 数学定义 | 只改候选循环，MAX/MIN/CHANCE 语义未动 | PASS |
| 2 | 第一候选正常窗口 | `if (pvsActive && searchedAny)` —— 第一候选必走全窗口 | PASS |
| 3 | 后续候选窄窗口探测 | 以**退化为 `(X,X)` 的窗口**表达，`X` = **当前最优值**（不是继承的 alpha/beta 边界） | PASS（且这一点是必须的，见下） |
| 4 | 回搜必须全窗口 | `beats` 为真时用 `childAlpha/childBeta` 重搜 | PASS |
| 5 | CHANCE 仍正式概率处理 | CHANCE 节点无视继承窗口，全部结果全窗口求和（未动） | PASS |
| 6 | 区分 completed/cacheable/exact/lower/upper | **FAIL** —— `bound` 只表达 cutoff，不表达窗口收窄 | **设计阻碍** |
| 7 | 保留 mate 词法优先级与距离 | `stepChildForParent` / `mateActionCost` 未动 | PASS（词法未动） |
| 8 | 不完整结果不得写 EXACT TT | `storeTT` 门未动；但 scout 被误判为 exact 而入库 | **FAIL**（同 #6） |
| 9 | deadline 中止不得泄漏部分结果 | `scoutRes.completed === false` 时原样保留、**不再回搜**（`abortScouts`），该结果已标记 incomplete + 非 cacheable | PASS |
| 10 | 完整回合计划仍可被真实引擎执行 | 用 `catMove`/`catPlaceTrap` 复验 50 个计划 | PASS（见 P3-V） |

### 4.1 为什么 scout 阈值取"当前最优值"而不是继承边界

初版取继承的 `beta`（MIN 节点）与 `alpha`（MAX 节点），冒烟测试立即暴露反例：fail-soft 子节点可能返回一个已经越过继承窗口的值，此时"窗口边界"并不等于"我已有的最好值"，用边界做阈值会**跳过一个真正能改进当前最优的候选**，导致节点返回值与 Alpha-Beta 不同。

改为以 `best` 为阈值后：MAX 问"是否严格优于我已有的"，MIN 问"是否严格劣于我已有的"——这正是 PVS 想知道的唯一问题。

### 4.2 没有用数值 epsilon

`SearchScore` 是 `(mate 类别, 数值)` 的**字典序**对，`mouse-mate | 非 mate | cat-mate` 三个区间之间不存在"下一个可表示的值"。所以窄窗口用**结构性表达**：进入时的窗口若 `alpha === beta`，该节点进入 STRICT 模式，剪枝条件从 `compareBound(alpha,beta) >= 0` 改为 `> 0`（"严格优于 X"）。对非退化窗口是恒等变换——这正是生产代码唯一会产生的形状。

### 4.3 剩余的设计阻碍（本轮结论之一）

`InternalSearchResult.bound` 需要第四个状态："以收窄窗口搜索、未解析"。当前三值 `'exact' | 'lower' | 'upper'` 加 `cutOff` 布尔量**无法表达**它，因为 `lower/upper` 已被"剪枝方向"占用。在补齐之前：

- scout 结果会被 `isCertifiedResult()` 判为已证明；
- 会被写入 EXACT-only TT（`storeTT` 只看 `bound !== 'exact'`）；
- 会参与等分图，从而改变 `catTurnPlan`。

这解释了 G1T10 与 C_PUSH 的两处计划分歧——**不是 PVS 选错了更好的招，是缓存与认证语义被 scout 污染了**。

---

## 五、P2 原型隔离

| 文件 | 角色 |
|---|---|
| `src/game/ai/expectiminimax.ts` | **arm A**，生产权威，未改 |
| `PPC-SEARCH-01/proto/expectiminimaxPvs.ts` | 分支：逐字复制 + 重写导入路径；`PVS_ENABLED=false` = **arm A_FORK** |
| 同上 + `PVS_ENABLED=true` | **arm B**（预注册臂，唯一算法变量 = PVS） |
| 同上 + `PVS_CHANCE_EXEMPT=true` | **arm C**（次级机制，单独报告，不得用于把失败的 B 救成 GO） |
| 同上 + `PVS_STRICT_BOUNDS=true` | **arm D**（bound 合同修复，事后追加，见 §7.4） |

实质改动量（剥离注释与 import 后逐行比对）：**新增 64 行、删改 3 行**。三处删改是：
1. `const childRes = valueOfAction(...)` → `let childRes` + 三分支（scout / 回搜 / 跳过）；
2. 两处 `compareBound(alpha,beta) >= 0` → `degenerateWindow ? > 0 : >= 0`。

其余全部是模块开关、计数器与说明。`PVS_ENABLED=false` 时对 25 根 × D1/D2 **零差异、零节点差**（见 P3-I），因此"唯一变量是 PVS"这一条成立。

---

## 六、P3 正确性门槛

### I. 分支控制（arm A_FORK vs arm A）

| 门 | 范围 | 结果 |
|---|---|---|
| 字段 + 节点数逐位相等 | 25 根 × D1 | **25/25 PASS**，`forkDiff` 全空，`forkNodeDelta` 全 0 |
| 同上 | 25 根 × D2 | 早期独立门 `out/t1_fork_control.json`：50 次搜索，mismatches 0，absNodeDelta 0 |

### II. arm B vs arm A（D1，25 根）

`value` / `mate` / `completed` / `bestAction` / `plan`：**0 处差异**（25/25）。

### III. arm B vs arm A（D2，25 根）

| 字段 | 差异数 |
|---|---|
| `value`（精确浮点） | 0 |
| `mate` | 0 |
| `completed` | 0 |
| `bestAction` | **1**（G1T10：`S:ArrowDown` vs `S:ArrowUp`） |
| `catTurnPlan` | **1**（`↓↓↓→` vs `↑↑↑↑`） |
| 预算截断（`budgetCutoffs > 0`） | 0（全部完整搜索，无截断污染） |

**门禁判决：FAIL**（预注册 T2 要求五字段全等）。价值层面 25/25 相等，选招层面 24/25 相等。

### IV. ruleset v2 控制（9 个控制 × D1/D2 = 18 次）

| 控制 | legal | D1 值 | D2 值 | 差异 |
|---|---|---|---|---|
| C_TRAP | 4 | 139.4883 | −647.6842 | 无 |
| C_TRAP_RECLAIM | 3 | −220.5117 | −787.6842 | 无 |
| C_NO_LEGAL | 4（墙内 0 合法） | −999999 | −999999 | 无（节点 0，终局在转移内判定） |
| C_TUNNEL | 3 | −1257.3158 | −1533.6316 | 无 |
| C_GHOST | 4 | −231.5117 | −828.1579 | 无 |
| C_BUTTER_PICKUP | 3 | −1134.4474 | −1274.4474 | 无 |
| C_PUSH | 4 | −358.9105 | −897.6364 | **D2 计划不同** |
| C_CAT3 | 4 | −447.2368 | −849.2632 | 无 |
| C_CAT5 | 4 | −212.6316 | −799.2632 | 无 |

**17/18 一致，1 处计划分歧**（C_PUSH @ D2，值相同）。陷阱、无路判负、传送、幽灵公告、黄油拾取、推箱、3/5 步猫在**值**上全部与生产一致。

### V. 真实引擎计划回放（`catMove` / `catPlaceTrap`，不是模拟器）

`applyPlanCatAction` 用引擎步进函数执行计划，而搜索内部用的是 `simulateSearchAction`。两者必须分别验证。

| 项 | arm A | arm B |
|---|---|---|
| 回放计划数（25 根 × D1/D2） | 50 | 50 |
| 被引擎拒绝的步（`valid === false`） | **0** | **0** |
| 完整应用（`applied === planLen`） | 50/50 | 50/50 |
| 计划结束后 `phase` | `playing`（全部） | `playing`（全部） |
| 计划结束后 `currentPlayer` | `cat`（全部） | `cat`（全部） |

**PASS。** 两臂的每个计划都能被真实引擎逐步执行完；`currentPlayer` 仍为 `cat` 说明计划在猫回合内部结束（回合切换与黄油结算在 `endTurn`，不在 `catMove` 内），这与 `computeCatAiTrajectory` 的实际用法一致。

附带更正一条上一轮的观测口径：`pvs_lib.replayPlan` 报的 "action hit a chance node"（9 个根）**不是计划缺陷**，而是模拟器把"跨过猫→鼠边界"建模成 chance 边、而引擎把它留给 `endTurn`。用引擎函数复验后这 9 个根全部通过。此项已从 FAIL 改判为 **harness 限制**。

### VI. CHANCE 全窗口不变式

所有运行、所有臂：`chanceNodes === fullWindowChanceSearches`（逐行相等，0 违反）。CHANCE 没有被窗口剪枝。

### VII. TT 健全性（TT ON vs OFF，D1，25 根 × 2 臂）

`value`/`plan` 差异 0；节点 ON/OFF 比值 A 2.16×、B 2.12×。

**注意这条的含义**：TT 是这套搜索的主要节点削减器（关掉就涨 2 倍以上）。而 arm B 让 **61% 的节点**（G1T10-D2：7,460 / 12,225）运行在 STRICT 模式，这些节点在 `bound` 语义修好之前会被错误认证、修好之后则**不能入库**——两头都不利于缓存。

---

## 七、P4 性能对照（正确性未全过，故仅作机制说明，不构成 GO 依据）

### 7.1 D2 逐根原始结果（25 根全部列出，无挑选）

| 根 | 节点A | 节点B | B/A | 剪枝A | 剪枝B | CHANCE A | CHANCE B | 墙钟A(ms) | 墙钟B(ms) | 加速 |
|---|---|---|---|---|---|---|---|---|---|---|
| G1T1 | 1452 | 1665 | 1.15 | 1,052 | 1060 | 0 | 0 | 255 | 273 | 0.93 |
| G1T2 | 501 | 501 | 1.00 | 420 | 420 | 0 | 0 | 86 | 72 | 1.19 |
| G1T3 | 64531 | 76713 | 1.19 | 328 | 12510 | 829 | 903 | 27485 | 33386 | 0.82 |
| G1T4 | 2315 | 2753 | 1.19 | **0** | 438 | 72 | 72 | 935 | 932 | 1.00 |
| G1T5 | 969 | 990 | 1.02 | 241 | 239 | 20 | 21 | 646 | 669 | 0.97 |
| G1T6 | 866 | 976 | 1.13 | 672 | 737 | 0 | 0 | 207 | 247 | 0.84 |
| G1T7 | 1024 | 1064 | 1.04 | 472 | 512 | 10 | 10 | 389 | 389 | 1.00 |
| G1T8 | 2562 | 2574 | 1.00 | 139 | 151 | 28 | 28 | 1194 | 1238 | 0.96 |
| G1T9 | 4522 | 5011 | 1.11 | **0** | 489 | 174 | 175 | 2571 | 2677 | 0.96 |
| **G1T10** | 547 | 12225 | **22.35** | 165 | 1837 | 57 | 2248 | 457 | 11958 | **0.04** |
| G4T1 | 3616 | 3632 | 1.00 | 3,184 | 3200 | 0 | 0 | 710 | 720 | 0.99 |
| G4T2 | 642 | 517 | **0.81** | 495 | 344 | 0 | 0 | 139 | 142 | 0.98 |
| G4T3 | 86291 | 100519 | 1.16 | 256 | 14486 | 3457 | 4099 | 56784 | 66580 | 0.85 |
| G4T4 | 107450 | 118073 | 1.10 | **0** | 10623 | 770 | 774 | 50634 | 50957 | 0.99 |
| G4T5 | 137997 | 163623 | 1.19 | **0** | 25626 | 746 | 1087 | 64132 | 68669 | 0.93 |
| G8T1 | 5101 | 10926 | **2.14** | 899 | 2741 | 233 | 465 | 1972 | 3933 | **0.50** |
| G8T2 | 2407 | 2472 | 1.03 | **0** | 65 | 77 | 84 | 941 | 932 | 1.01 |
| G8T3 | 1920 | 2144 | 1.12 | 425 | 649 | 12 | 12 | 739 | 724 | 1.02 |
| G8T4 | 829 | 944 | 1.14 | **0** | 115 | 38 | 45 | 281 | 310 | 0.90 |
| G8T5 | 3474 | 3940 | 1.13 | **0** | 466 | 53 | 53 | 1069 | 1050 | 1.02 |
| G8T6 | 426 | 485 | 1.14 | 158 | 179 | 0 | 0 | 131 | 146 | 0.90 |
| G8T7 | 431 | 382 | 0.89 | 236 | 162 | 4 | 5 | 156 | 167 | 0.94 |
| G8T8 | 467 | 529 | 1.13 | 147 | 138 | 4 | 5 | 229 | 307 | 0.75 |
| G8T9 | 12497 | 14035 | 1.12 | **0** | 1538 | 115 | 152 | 6243 | 6780 | 0.92 |
| G8T10 | 9162 | 12072 | 1.32 | **0** | 2910 | 172 | 269 | 4710 | 5360 | 0.88 |

合计：节点 451,999 → 538,765（+19.2%）；墙钟 223,096ms → 258,615ms（+15.9%）；**逐根加速中位 0.938**。

### 7.2 机制归因（有证据的部分）

**(a) 排序已经把 PVS 的"省"吃掉了。**
生产臂 25 根的剪枝里 **93.7% 发生在第一着**（`firstMoveCutoffs / alphaBetaCutoffs`）；G1T10 是 165/165 = 100%，G4T1 是 3,184/3,184 = 100%。PVS 的收益来源是"后续候选的子树可以廉价否证"，而这里后续候选的子树**本来就在第一着被否证**。于是 PVS 把已有的"一次搜索"变成"scout + 回搜"，净增成本，中位 +12.7% 节点。这条也解释了为什么**无 CHANCE 的 6 个根同样没有加速**（0.960）。

**(b) CHANCE 节点按设计无视窗口，所以 scout 在那里不可能更便宜。**
`valueOfAction` 的 CHANCE 分支对每个结果都用 `NEG_INF..POS_INF` 搜（D2 不变式，禁止随机剪枝）。因此"窄窗口 scout"在 CHANCE 子节点上与全窗口搜索**等价开销**。
证据：**arm C（chance 豁免）与 arm B 在 G1T10 上节点数完全相同**——12,225 节点 / 2,248 CHANCE（`out/diag2_pvs_counters.jsonl`），豁免只触发 527 次，墙钟差异（11.7–12.0s）在噪声内。所以"scout 与回搜重复支付 CHANCE 子树"这个假设**被否证**；放大发生在别处。

**(c) 真正的放大器是缓存，而不是重复搜索。**
G1T10-D2 对照（`out/diag1_tt_on_off.jsonl`）：

| 臂 | TT ON | TT OFF | 倍数 |
|---|---|---|---|
| A | 547 节点 / 457ms | 4,478 节点 / 522ms | 8.2× 节点 |
| B | 12,225 节点 / 11,958ms | **400,000 节点（撞 40 万上限）/ 100,860ms** | >32× 节点 |

即：这套搜索的节点经济由 **EXACT-only TT** 支撑；而 arm B 让 61% 的节点走 STRICT 模式，这些节点的结果按 `bound` 语义既不该入库（修好后）或会被错误入库（未修时）。**PVS 在结构上是在给缓存断粮**，在状态重复率高的根上（G1T10/G8T1）表现为 2–22 倍膨胀。

**(d) 与运气/局部异常无关。** 25 个根全部报告完毕，没有挑选。正面数字只有：节点数下降 2 根（G4T2 −19%、G8T7 −11%，墙钟均未跟上）；墙钟略快 5 根，其中最快的 1.19× 出现在 86ms 的 G1T2 上（属噪声），其余 4 根在 1.00–1.02。**没有任何一个根达到 1.25×。** 反向则有 G1T10（0.04×）与 G8T1（0.50×）两根实质性退化，均为 CHANCE 主导且生产臂近零剪枝。

### 7.3 100ms / 150ms 车道

8 根 × 3 次串行重复，A / B 各 24 次（`out/s5_live_100ms.jsonl`）：

| 根 | 臂 | completedDepth 中位 | 墙钟中位 | fallback | 计划长度中位 |
|---|---|---|---|---|---|
| G1T1 | A / B | 1 / 1 | 102.1 / 102.0 | 0 / 0 | 5 / 5 |
| G1T2 | A / B | 1 / 1 | 101.3 / 100.8 | 0 / 0 | 4 / 4 |
| G1T5 | A / B | 1 / 1 | 106.6 / 105.3 | 0 / 0 | 4 / 4 |
| G1T7 | A / B | 1 / 1 | 103.2 / 102.4 | 0 / 0 | 4 / 4 |
| G1T10 | A / B | 1 / 1 | 118.1 / 119.6 | 0 / 0 | 4 / 4 |
| G4T2 | A / B | 1 / 1 | 102.2 / 102.1 | 0 / 0 | 4 / 4 |
| G4T4 | A / B | 1 / 1 | 112.7 / 113.4 | 0 / 0 | 4 / 4 |
| G1T9 | A / B | 1 / 1 | 112.0 / 110.6 | 0 / 0 | 4 / 4 |

- D1 完成率：**8/8，两臂相同，零退化**。
- D2 完成率：**0/8，两臂相同**。100ms 下两臂都只能到 D1，PVS 不改变这个事实。
- 150ms 整回合预算本轮未启用（预注册：只测主搜索，sidecar / 进度守卫在范围外）。

### 7.4 arm D（bound 合同修复）——事后追加的机制验证

§4.3 指出 `bound` 缺一个状态。为了确认"是这一条造成计划分歧、并解释节点膨胀"，追加了 **arm D**：进入窗口为退化窗口（`alpha === beta`）的节点，无论是否剪枝，一律返回未解析边界（MAX→`lower`，MIN→`upper`），因此 scout 结果**既不能入库、也不能被认证**。改动仅在 `boundType` 一处，开关 `PVS_STRICT_BOUNDS` 默认关闭（A/B/C 三臂不受影响，已用 `setPvsStrictBounds(false)` 在臂切换处强制隔离）。

| 根 | 深度 | A 节点 | B 节点（原 bound） | D 节点（修好 bound） | A 墙钟 | B 墙钟 | D 墙钟 | A-vs-B 计划 | A-vs-D 计划 |
|---|---|---|---|---|---|---|---|---|---|
| G1T10 | D1 | 29 | 29 | 67 | 29ms | 25ms | 23ms | 同 | 同 |
| **G1T10** | **D2** | **547** | **12,225** | **365,612** | **199ms** | **7,588ms** | **95,296ms** | **异** | **同** |
| G1T1 | D1 | 79 | 99 | 224 | 68ms | 69ms | 88ms | 同 | 同 |
| G1T1 | D2 | 1,452 | 1,665 | 3,264 | 435ms | 497ms | 839ms | 同 | 同 |
| G4T2 | D1 | 44 | 49 | 72 | 43ms | 49ms | 43ms | 同 | 同 |
| G4T2 | D2 | 642 | 517 | 1,152 | 161ms | 155ms | 284ms | 同 | 同 |
| G1T5 | D1 | 28 | 32 | 73 | 18ms | 19ms | 31ms | 同 | 同 |
| G1T5 | D2 | 969 | 990 | 27,152 | 587ms | 570ms | 6,226ms | 同 | **异** |
| C_PUSH | D1 | 38 | 44 | 81 | 45ms | 36ms | 37ms | 同 | 同 |
| C_PUSH | D2 | 759 | 867 | 16,918 | 358ms | 429ms | 3,647ms | **异** | **异** |

三条结论，全部有直接读数支撑：

**(1) 修好 bound 语义确实消除了 G1T10 的计划分歧。** B 的计划是 `↑↑↑↑`，D 的计划与生产一致（`↓↓↓→`）。所以 G1T10 那处分歧**确实是 scout 被误认证 + 被写入 EXACT TT** 造成的，不是 PVS 的搜索数学。

**(2) 但代价是缓存被彻底断粮。** G1T10-D2：12,225 → **365,612** 节点（对生产 547 是 **668×**），墙钟 7,588ms → **95,296ms**（对生产 199ms 是 **479×**）。其余根 2×–27×。这与 §7.2(c) 的 TT 关断实验（B 关 TT 直接撞 40 万节点上限）方向完全一致：**scout 结果一旦不能入库，这套 DAG 走查就退化成逐状态重算**。也就是说，之前那个"未解析边界被当成 exact 存起来"的缺陷，恰好是让 PVS 仅膨胀 22 倍而不是 668 倍的唯一原因——这是一个缺陷掩盖了另一个更严重的问题。

**(3) 仍有一处计划分歧不随 bound 修复消失。** `C_PUSH@D2` 在 B 和 D 下都与生产不同（B：`→↑←←`，D：`↑→←←`）。这条来自 `preferResult` 的**认证门**（PPC-RB1）：被 scout 跳过/只有边界的候选永远不能成为"已证同分"的锚，于是等分图成员资格与生产不同，`extractBestCatTurnPlan` 走出另一条等价路线。**这是 PVS 与既有认证平局机制的语义冲突，不是实现 bug**，任何"只在数值上对齐"的 PVS 变体都无法消除。

**arm D 的结论**：修好 bound 后 PVS 的表现不是变好而是变差（指数级），并且仍不能保证计划同一性。因此不再是"PVS 因为实现瑕疵才失败"，而是 **PVS 与这套引擎的成本结构/认证语义根本不兼容**。

---

## 八、P5 裁决

| 门槛 | 结果 |
|---|---|
| 全部 correctness gates PASS | **FAIL**（T2 计划同一性 1/25；TT EXACT 语义缺口） |
| D2 有实质节点或墙钟收益 | **FAIL**（节点 +19.2%，墙钟 +15.9%） |
| D1 在 100ms 不退化 | PASS |
| 不新增非法 fallback | PASS（fallback 全 0） |
| 不明显恶化内存 | 未正式测（TT 条目 A 441,761 / B 456,341 写入；进程 RSS 峰值未测） |
| 不修改生产预算 | PASS |
| 不靠个别成功局面掩盖退化 | PASS（25 根全部列出，无挑选） |
| **价值门槛：D2 墙钟逐根加速中位 ≥ 1.25** | **FAIL：0.938** |

**裁决：`NO_GO_PVS`。** PVS 在本项目当前架构下不产生加速，且在 CHANCE 主导的根上造成数量级退化；同时暴露出 `ScoreBound` 表示力不足这一必须先修的基础合同问题。按预注册条款，不叠加 aspiration / LMR / 跨回合 TT / 战术证书来挽救本轮结果。

---

## 九、与预注册的偏离申报（全部为缩减范围，无扩大）

| 项 | 预注册 | 实际 | 原因 |
|---|---|---|---|
| D2 重复次数 | "墙钟取 3 次全新重复的中位" | **每根 1 次**（全量 25 根），另在 100ms 车道做 3 次重复 | D2 单次 0.15–70s，3 次全覆盖需额外约 25 分钟串行；单次已足以判定方向（最坏根差 26 倍，非噪声可翻转） |
| T3 TT 健全性 | 25 根 × D1/D2 × {B,C} | **25 根 × D1 × {A,B}** | D2 × TT-OFF 在大根上不收敛（B 撞 40 万节点上限 100s），且该对照不改变结论 |
| T2b arm C | 25 根全量 | **5 根探针（D1/D2）** | C 是机制研究臂，不是可采纳结果；其结论是"与 B 同数"，5 根已足够 |
| 控制数量 | 文献写 9 个 | 实际 9 个（列表一致，`C_NO_LEGAL` 合法动作数为 4 而非 0 —— 见下） | — |
| 未参与 | — | `TOTAL_TURN_150MS` 未测 | 预注册已声明 sidecar 在范围外 |
| arm D | 未预注册 | **事后追加**，单独报告 | 由 §4.3 的语义缺口触发；明确不作为"救 B"的臂 |
| arm D 首轮 | — | **作废重跑** | 首次实现忘记在臂切换处复位 `PVS_STRICT_BOUNDS`，导致后续 "arm B" 实际跑的是 arm D（B 与 D 读数完全相同）。已加 `setPvsStrictBounds(false)` 强制隔离并重跑；重跑后 arm B 的节点数与主扫描逐位一致（G1T10 12,225 / G1T1 1,665 / G1T5 990 / C_PUSH 867），证明主扫描工件未受影响 |

**单次墙钟的噪声有多大**：同一个状态、同一份代码，G1T10-D2 的 arm A 在主扫描里是 457ms、在 arm D 复跑里是 199ms（2.3× 波动，亚秒级根的常态）。因此**墙钟判据不能单独引用来下结论**。本轮的稳健判据是**节点数**——它是确定性的：`rootcost` 与主扫描两次独立运行在 14 个重叠根上节点数逐位一致（G1T10 547、G1T1 1,452、G4T3 86,291…），arm D 复跑又独立复现了 arm A/B 的 5 组节点数（547/12,225、1,452/1,665、642/517、969/990、759/867）。25 根中位比值 1.127、总量 +19.2%，方向明确。墙钟 0.938 与节点 +12.7% 指向同一结论，只是幅度不可当真。

一处事实更正：`C_NO_LEGAL` 的 `legalActions` 实测为 **4**，不是 0 —— `generateLegalSearchActions` 在"猫被墙围死"时仍返回 4 条动作（因为 `RULE-A` 无路判负在**转移内部**结算，动作本身仍生成）。该控制的 `value` 两臂同为 −999999、节点同为 0，说明终局确实在转移内生效。原始预注册描述"cat walled in -> no legal action"与代码不符，此处记录，不修改历史文件。

---

## 十、证据索引

| 文件 | 内容 |
|---|---|
| `out/s1_d1_parity.jsonl` | D1，25 根 × {A, A_FORK, B}，逐根一行 |
| `out/s2_d2_parity.jsonl` | D2，25 根 × {A, B}，含节点/剪枝/CHANCE/TT/墙钟/回放 |
| `out/s3_controls.jsonl` | 9 控制 × D1/D2 |
| `out/s4_tt_soundness.jsonl` | TT ON vs OFF，D1 |
| `out/s5_live_100ms.jsonl` | 100ms 车道，8 根 × 3 重复 × 2 臂 |
| `out/diag1_tt_on_off.jsonl` | TT 开关对照（含大根 TT-OFF 不收敛的证据） |
| `out/diag2_pvs_counters.jsonl` | scout / 回搜 / 跳过 / STRICT 节点计数 |
| `out/diag3_chance_share.jsonl` | CHANCE 占比、首着剪枝占比 |
| `out/diag4_ghost_control.json` | 幽灵控制成本（CHANCE 枚举扇出是枚举器属性） |
| `out/r1_engine_replay.jsonl` | 真实引擎（`catMove`/`catPlaceTrap`）计划回放，两臂 |
| `out/s7_armD.jsonl` | arm D 对照 |
| `out/rootcost.log` | 逐根 D2 三臂成本（arm C 与 B 同数） |
| `out/fork.diff` | 分支与生产代码的完整差异 |
| `PPC-SEARCH-01_PREREGISTRATION.json` | 预注册（写于性能车道执行之前，**未修改**） |

外部文献本轮未新增引用；结论全部来自本地实测。
