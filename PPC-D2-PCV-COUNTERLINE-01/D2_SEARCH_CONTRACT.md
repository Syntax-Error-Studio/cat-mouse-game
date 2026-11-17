# D2 搜索源码合同审计

- 轮次：`PPC-D2-PCV-COUNTERLINE-01`
- 阶段：G1（只读源码审计）
- 审计对象：本地工作树 `F:\小猫小鼠`，HEAD `48eaac6c4f3801d351787696ba5876995b64e8d8`，分支 `ppc/p1-id-state-identity-fix`
- 被审计文件（当前 live SHA256 见 `SOURCE_MANIFEST.json`）：
  - `src/game/ai/expectiminimax.ts` = `50d27da5…`（109352 B）
  - `src/game/ai/planQuality.ts` = `46979485…`（30693 B）
  - `src/game/ai/preparedActions.ts` = `67b76ad3…`（5405 B）
  - `src/game/ai/transposition.ts` = `7b4aa8eb…`（6784 B）
  - `src/game/ai/planBound.ts` = `4a212b75…`（8012 B）
  - `src/game/ai/simulator.ts` = `6d24d4f3…`（8365 B）
- 结论口径：只读；未运行任何 D2 搜索；未修改 `src/`、`GAMEPLAY.md`。

> 说明：本文件是**源码事实审计**，不是 D2 搜索结果。凡标注 `NOT_PERFORMED` 的门槛，
> 都是因为资源准入未通过（见 `RESOURCE_SAFETY_LOG.md`）而**没有执行**，不是失败。

---

## 4.1 固定深度搜索接口的四条语义

### `createSearchContext(rules, maxNodes, useTT, useAlphaBeta, useMoveOrdering, maxThreatExtensions, useThreatOrdering)`
`expectiminimax.ts:813`

- 构造**一次搜索**的私有上下文：自带 `tt`（`TranspositionTable`）、`planBranches`（空 Map）、
  `rootValues`（空数组）、`evalCache`（空 Map）、`equalPrimaryGraph`（空 Map）、`diagnostics` 全零。
- 默认值：`maxNodes = 200_000`、`useTT = false`、`useAlphaBeta = false`、
  `useMoveOrdering = false`、`maxThreatExtensions = 0`、`useThreatOrdering = true`。
- **`capturePlan` 不在这里置位。** 上下文创建后 `capturePlan === undefined`。
- 与本轮配置的对应：`createSearchContext(rules, 8_000_000, false, false, false, 0, false)`
  即可得到"无 TT / 无 AB / 无排序 / 无扩展 / 无威胁排序"的裸搜索。
  `useThreatOrdering` 必须显式传 `false`：它只在 `useMoveOrdering === true` 时才被读取
  （`expectiminimax.ts:1266`：`ctx.useMoveOrdering && ctx.useThreatOrdering`），所以传 `true`
  也不会改变行为；但本轮按"不引入任何非必要自由度"的要求显式关掉。
- **铁律提醒**：`createSearchContext` 不设 `leafEvaluator` 时会静默落到 `defaultLeafEval`
  （`expectiminimax.ts:924`）。E1 臂必须在调用搜索**之前**显式
  `ctx.leafEvaluator = evaluateForCat`，否则拿到的不是 E1。

### `searchResult(state, depthTurns, ctx) -> InternalSearchResult`
`expectiminimax.ts:1813`

- 返回 `{ value, mate, bound, completed, cacheable }`。**没有 bestAction，没有 diagnostics 重置。**
- 内部：`_search(state, depthTurns, ctx, new Set(), {count:0}, 0, NEG_INF, POS_INF, seed, state.currentPlayer === Cat)`。
- 会**重置 `planBranches`/`rootValues` 吗？不会。** 它不碰这两个字段。
- 深度语义：`depthTurns` 只在**行动权切换**时减 1
  （`expectiminimax.ts:1493` 确定性转移、`:1512–1514` CHANCE 转移），不按单步减。
- 适用性：可以做真正的固定 D2 数值搜索，但**不产出任何计划、不产出根动作明细**，
  且 `diagnostics` 是调用方自己负责清零的。作为候选提取入口**不合格**。

### `searchBestAction(state, depthTurns, ctx) -> SearchBestActionResult`
`expectiminimax.ts:2001`

- 依次做四件事：
  1. `resetDiagnostics(ctx.diagnostics)`（`:2006`）——调用前后 diagnostics 是本调用专属。
  2. 若 `ctx.capturePlan` 为真：`planBranches` / `rootValues` / `equalPrimaryGraph` 全部换新
     （`:2010–2014`）。**若 `capturePlan` 为假，三者一个都不换** ⇒ 计划与根动作明细为空。
  3. `runFixedSearch(state, depthTurns, ctx, nodeCount)`（`:2015`）。
  4. `capturePlan` 为真时 `buildCatTurnPlan`（`:2019`）；`mate === null` 且
     `equalPrimaryGraph.size > 0` 时改用 `extractBestCatTurnPlan`（`:2020–2023`）。
- 返回 `{ action, value, mate, completed, diagnostics, catTurnPlan }`。
  **`bound` 不在返回对象里**；根动作级 `bound` 只存在于 `ctx.rootValues[i].bound`。
  `rootValues` 也不在返回对象里，必须从 `ctx` 上读。
- 这是**唯一正确的 D2 固定深度入口**：不迭代、不做深度回滚，一次调用就是一次
  `depthTurns` 固定搜索，且 `completed` / `mate` / `diagnostics` / `rootValues` 全部保留。

### `searchBestActionIterative(opts) -> IterativeSearchResult`
`expectiminimax.ts:2247`

- 迭代加深**包装器**：`for (d = 1..maxDepthTurns)`，每轮 `runFixedSearch(state, d, ctx, nodeCount)`
  （`:2303–2312`），**同一个 `nodeCount` 与同一个 `ctx`**（预算与 TT 跨轮共享）。
- 每轮开头重置 `planBranches` / `rootValues` / `equalPrimaryGraph`（`:2309–2311`），
  所以**不存在跨迭代的计划残留**（这一点是干净的）。
- 只有 `result.completed` 的迭代才会覆盖 `last*`；被截断的深轮**整轮丢弃**（`:2352–2361`）。
- 因此：**如果 `maxDepthTurns=2` 而深层被截断，返回的 `value/mate/bestAction` 是 D1 的答案**，
  但 `attemptedDepth=2`、`completedDepth=1`。把这种结果当 D2 用，就是本轮任务书
  §4.1 明令禁止的"D1 结果误认为 D2"。
- 判定：本轮**不使用**该入口。若将来要用，必须硬性断言
  `completedDepth === 2 && attemptedDepth === 2 && !budgetExhausted && !deadlineExceeded`。

### 4.1 裁决

```text
D2_ENTRY_POINT = searchBestAction(root, 2, ctx)
D2_ENTRY_PRE_PATCH = ctx.capturePlan = true; ctx.leafEvaluator = evaluateForCat
D2_ENTRY_POST_READ = ctx.rootValues (all root actions) + ctx.planBranches + result.completed
ITERATIVE_ENTRY_USABLE_FOR_D2 = FALSE (D1 fallback indistinguishable without completedDepth gate)
PLAIN_NUMBER_API_EXISTS = FALSE  (module has no searchValue; see expectiminimax.ts:1777-1795)
```

"不得使用隐藏 incomplete 状态的 plain-number API"这一条**已满足**：模块刻意移除了
number-only 入口，注释 `:1777–1795` 记录了原因（历史 f0bench 误排序）。

---

## 4.2 rootValues 完整性

### 写入点与覆盖范围
`expectiminimax.ts:1342–1344`（`searchActions` 内，唯一写入点）：

```ts
if (ctx.capturePlan && ply === 0) {
  ctx.rootValues.push({ action: pa.action, value: candidate.value, mate: candidate.mate, bound: candidate.bound });
}
```

- `ply === 0` 只可能在根节点成立（根调用 `searchActions(..., ply = 0, ...)`，`runFixedSearch:1904`），
  子节点一律 `ply + 1`（`:1334`）。所以写入范围**恰好是根动作集合**。
- 循环遍历 `prepared`（`:1330`），`prepared` 在 `useMoveOrdering === false` 时
  **保持 `generatePreparedSearchActions` 的原始顺序**（排序块 `:1269–1302` 被 `orderingOn` 短路）。
  原始顺序 = `enumerateSearchActionCandidates` 的顺序（`preparedActions.ts:51–88`）：
  猫回合 = `DIRECTIONS` 四方向 `catStep`，然后 `catPlaceTrap`（仅当
  `trapPosition === null && catTrapsRemaining > 0`，`:82–84`）。
- 因此 `rootValues` 的索引**可以**与"合法根动作列表"一一对齐，但这需要调用方自己
  另生成一次合法列表来核对（源码不提供对齐信息）。

### 三个必须记录的缺陷

**（a）`RootActionRecord` 没有 `completed` 字段。**
`expectiminimax.ts:773–778` 只有 `{ action, value, mate, bound }`。

**（b）`bound` 在截断时仍然是 `'exact'`。**
预算截断与 deadline 截断都返回 `bound: 'exact'` + `completed: false`：

```ts
// :1726  预算
return { value: budgetLeaf, completed: false, cacheable: false, mate: null, bound: 'exact' };
// :1749  deadline
return { value: dlLeaf, completed: false, cacheable: false, mate: null, bound: 'exact' };
```

后果：任务书 §4.2 的 `ALL_ROOT_BOUNDS_EXACT = TRUE` **单独不足以**证明精确性。
`bound` 只反映 Alpha-Beta 断言的**方向性**（`cutOff` 才会产生 `lower`/`upper`，`:1449`），
而 `useAlphaBeta === false` 时 `cutOff` 恒为 `false`（`:1418` 整个 AB 块被跳过的前提），
所以本轮配置下 `bound` **恒为 `'exact'`，不携带任何信息量**。

**（c）根动作级"完整"只能由聚合量推断。**
`searchActions` 把 `allCompleted = AND over children`（`:1416`）写成节点的 `completed`（`:1454`），
再被 `runFixedSearch` 原样返回。所以：
- 每个根动作的 `completed` **没有单独落盘**；
- 只有 `result.completed`（全体根动作的 AND）与
  `diagnostics.budgetCutoffs` / `diagnostics.deadlineCutoffs` 两个计数器可用。

### 4.2 裁决 —— 正确的判定式

```text
ALL_ROOT_ACTIONS_ACCOUNTED = (ctx.rootValues.length === rootPrepared.length)
                          ∧ (no early return in runFixedSearch)

ALL_ROOT_BOUNDS_EXACT       = 不可单独采信（见缺陷 b）
```

必须**替换**为下面这组联合条件，才等价于"每个根动作拿到 exact 值"：

```text
SEARCH_COMPLETED        = result.completed === true
NO_BUDGET_TRUNCATION    = diagnostics.budgetCutoffs === 0
NO_DEADLINE_TRUNCATION  = diagnostics.deadlineCutoffs === 0
NO_EXTENSION_ABORT      = diagnostics.extensionAbortCount === 0
ROOT_ACTION_COUNT_MATCH = ctx.rootValues.length === legalRootActionCount
ALL_ROOT_BOUNDS_EXACT   = (上述四项全真) ∧ (rootValues 每项 bound === 'exact')
```

补充说明（必须写进冻结件，否则复现者会以为 `bound` 有意义）：
`useAlphaBeta === false` ⇒ `bound` 恒 `'exact'`，此字段在本轮**是常量，不是判据**。

### 会破坏"全覆盖"的三条早退路径
`runFixedSearch`（`:1844`）在到达 `searchActions` 之前有三个早退：
1. 根为 `CatWins`/`MouseWins`（`:1850`、`:1856`）——G1T9 是 Playing，不触发。
2. `rootPrepared.length === 0`（`:1880`）——会返回 `cacheable:false` 的静态评估，`rootValues` 为空。
3. **TT 根命中且带 bestAction**（`:1896`）——直接返回，`rootValues` 为空。
   本轮 `useTT === false` ⇒ `probeTT` 恒 `null`（`:1757` 调用、`transposition.ts` 侧无表），不触发。
   **但这是"配置救了我们"，不是"代码保证了"。** 冻结件必须同时记录 `useTT=false`。

### 缺失/重复
源码不做去重。`rootValues` 是否出现同一 action 两次，取决于
`enumerateSearchActionCandidates` 是否产出重复——该函数按 `DIRECTIONS` 顺序生成，
`catPlaceTrap` 至多一个，因此结构上不产生重复；但**必须由调用方断言**，不能假设。

---

## 4.3 planBranches 的分支身份（本轮最重要审计项）

### 事实链

**1. 唯一写入点，键只有 `stateKey`。**
`expectiminimax.ts:1471–1473`：

```ts
if (ctx.capturePlan && bestAction !== null) {
  ctx.planBranches.set(stateKey(state), bestAction);
}
```

字段类型是 `Map<string, SearchAction>`（`:583`）。注释 `:568–575` 明确写
"keyed by stateKey"。

**2. 键里没有深度、没有扩展信用、没有根动作身份。**
对比同一文件里另一个键的写法：`equalPrimaryGraph` 用的是
`` `${key}\x00${depthTurns}` ``（`:1464`）——**同一个文件里已经证明作者知道需要加深度判别**，
但 `planBranches` 没有加。

**3. 覆盖语义是"后写胜"。**
`Map.set` 覆盖；无冲突检测、无首写保留、无告警。

**4. `stateKey` 的 18 个分量。**
`transposition.ts:81–104`：`boardKey`、`gameMode`、`phase`、`currentPlayer`、
`catPosition`、`mousePosition`、`catMovesLeft`、`mouseMovesLeft`、
`butterPositions`、`pendingButterSpawns`、`pendingButterPlacementDebt`、
`mouseHasButter`、`mouseSkillActive`、`trapPosition`、`catTrapsRemaining`、
`blockedTunnels`、`tunnelExitChoices`、config 七元组（boardSize/mouseBaseMoves/
mouseCarryingMoves/mouseSkillExtraMoves/catBaseMoves/butterCount/gameMode/difficulty）。

**5. 深度语义在 D2 下是可恢复的。**
`depthTurns` 只在行动权切换时递减（`:1493`、`:1512–1514`）。从猫根出发的固定 D2：

| 状态 | `depthTurns` | 会写 `planBranches` 吗 |
|---|---:|---|
| 根猫回合内的猫待动 | 2 | 会 |
| 鼠待动 | 1 | 会 |
| 鼠回合结束后的猫待动 | 0 | **不会**（`depthTurns <= 0` 在 `:1605` 直接走叶评估） |

结论：**本轮所有写入只属于 depth 2（猫）或 depth 1（鼠），且深度可由"轮到谁"反推。**
不存在"同一 stateKey 在多个深度各写一次"的污染——**但这是被 `maxThreatExtensions=0`
与 interception 关闭共同保证的**：一旦开扩展，`_searchInner(..., 1, ...)` 会以
`depthTurns=1` 重新进入一个原本是 depth 2 的状态（`:1624`），深度就不再由 actor 决定。
这一点必须写进冻结件。

**6. 值是否与路径无关？——这是"能不能证明"的关键。**
一般不成立：重复守卫 `:1588–1591` 会返回**依赖当前路径**的静态评估：

```ts
if (path.has(key)) {
  ctx.diagnostics.repetitions++;
  return { value: evaluateLeaf(state, ctx, key), completed: true, cacheable: false, ... };
}
```

若同一 (状态, 深度) 被两条不同路径访问，二者 `path` 祖先集合不同，值可能不同 ⇒
`bestAction` 可能不同 ⇒ 后写胜的那一份可能**不属于**你要提取的那条分支。

**7. 但在 D2 里重复守卫打不到。**（本轮的关键推理，需在试点中实测确认）
猫回合内身份分量单调：`catStep` 令 `catMovesLeft` 严格减 1（`mateActionCost`，`:295–308`）；
`catPlaceTrap` 代价 0、但要求 `trapPosition === null` 且置为非空（`preparedActions.ts:82`），
唯一回退是"踩上陷阱回收"，而回收本身消耗一次 `catStep` ⇒ `catMovesLeft` 仍严格减 1。
鼠回合同理：`mouseStep` 减 1；`mouseSkill` 消耗黄油并把 `mouseSkillActive` 置真（一次性）；
`chooseTunnel` 走 `GamePhase.ChoosingTunnelExit` 这个独立 phase 且会移动鼠。
⇒ **单个回合内任何状态都不可能重复出现，`path.has(key)` 恒假。**

所以：在本轮严格配置下，节点值对路径**无关**，同一键的多次写入**必然写同一个 action**
（排序关闭 ⇒ `prepared` 顺序相同 ⇒ 平分时 `originalIndex` 稳定破平，`:1400`、`:1408`）。

**8. 由此可以恢复"每个根动作的 principal continuation"——但不在根键上。**
根自身也写了一条：`planBranches[rootKey] = 全局唯一最佳首着`。
**把这条当每个根动作的计划用，就是任务书点名禁止的"全局 bestAction 冒充每个根动作"。**
正确做法是**从每个根动作的后继状态起走**，源码里已经有现成实现：

- `buildPlanForFirstAction(root, firstAction, ctx, maxLength)` —— `planQuality.ts:306`
  先 `simulateSearchAction(root, firstAction)`，再沿 `planBranches` 走到猫回合结束。
- `buildCandidate(root, firstAction, ctx, originalIndex)` —— `planQuality.ts:365`
  在其上加 `planFullTurnCompleteness` 完整性认证与边界评估。
- `maxLength` 默认 `maxCatTurnPlanActions(root)` —— `planBound.ts:153`，
  `M + 1 + floor(M/2)`（`:155`）。

### 4.3 会"悄悄丢弃根动作"的三处静默拒绝

`buildPlanForFirstAction` 有三个提前返回**空计划**的分支，`buildCandidate` 会把它们
变成 `null`（`planQuality.ts:374–381`），调用方若只收集非 null，就会**无声丢掉合法根动作**：

| 位置 | 条件 | 返回 |
|---|---|---|
| `planQuality.ts:323` | 首着不是 `catStep`/`catPlaceTrap` | `[]` |
| `planQuality.ts:324` | `isNoOpAction(root, firstAction, rules)`（`simulator.ts:144`） | `[]` |
| `planQuality.ts:342` | 走链时遇到的 branch action 不是猫动作 | 截断 |
| `planQuality.ts:320` | `hasCertifiableCatMoveBudget(root)` 为假 | `[]` |

任务书 §6 明确："如果某个合法根动作无法恢复完整计划，候选生成完整性不通过，
**不得悄悄丢弃该根动作**。" 源码**不提供**区分"确实没有计划"与"提取器拒绝"的返回值，
所以试点必须自己分类计数（`PLAN_IDENTITY_FAILURES`），不能靠 `buildCandidate === null` 一句带过。

### 4.4 鼠反击线路提取

**能做到的部分（源码已具备）：**
- `planBranches` 的写入点（`:1471`）**与行动方无关**，鼠节点也会写。
  因此鼠回合的每个决策都在同一张表里。
- CHANCE 转移不产生自己的 `stateKey` 条目（它不是一个 `state`），而是
  在 `valueOfAction:1500–1545` 里把**每个 outcome 都当独立子节点搜索**：
  ```ts
  for (const o of outcomes) {
    const cr = _search(o.state, nd, ctx, path, nodeCount, ply, NEG_INF, POS_INF, extensionsRemaining, childInRootCatTurn);
    total += o.weight * cr.value;
  }
  ```
  每个 `o.state` 都会走 `searchActions` 并落自己的分支条目。
  ⇒ **多结果 CHANCE 天然可枚举**，且轮盘权重 `o.weight` 与状态一一对应。

**做不到的部分（必须标记）：**
- 源码里**只有** `buildCatTurnPlan`（`:1926`）与 planQuality 的猫侧提取器，
  **没有 `buildMouseTurnPlan`**。鼠侧走链必须在新目录里新写，不能改生产文件。
- 一条"principal mouse counterline"在遇到 CHANCE 时**必然分叉**，不是单条线。
  所以任务书要求的标记是**结构性正确**的：
  `PRINCIPAL_COUNTERLINE_NOT_EXHAUSTIVE_PROOF`。
- 踩陷阱提前交接、鼠技能、黄油拾取、隧道出口，都是**状态转移**而非分支类型，
  走链时会被 `simulateSearchAction` 自然覆盖；但没有现成的"鼠回合完整性"判定器
  （`planFullTurnCompleteness` 是猫专用的，`planQuality.ts:225`）。

### 4.3 / 4.4 裁决

```text
PLAN_BRANCH_LOG_EXISTS               = TRUE
PLAN_BRANCH_KEY                      = stateKey only (no depth, no root-action id)
PER_ROOT_ACTION_BRANCH_LOG_EXISTS    = FALSE
ROOT_KEY_HOLDS_GLOBAL_BEST_ONLY      = TRUE   -> must NOT be reused as per-root plan
EXTRACTION_MECHANISM                 = buildPlanForFirstAction / buildCandidate (already in planQuality.ts)
DEPTH_AMBIGUITY_IN_D2                = NO     (depth implied by actor; conditional on maxThreatExtensions=0)
PATH_DEPENDENCE_WITHIN_TURN          = NO     (monotone identity components; see 4.3 item 7)
CROSS_PATH_OVERWRITE_RISK            = THEORETICALLY ZERO, EMPIRICALLY UNVERIFIED THIS ROUND
MOUSE_COUNTERLINE_EXTRACTOR_EXISTS   = FALSE  (must be written in the research dir)
MULTI_CHANCE_FORK                    = TRUE by construction (every outcome searched, full window)
```

**结论：分支提取在机制上可行、在严格配置下原则上可证，但"可证"依赖两条必须先测的事实**
——`diagnostics.repetitions === 0` 与"同一键的多次写入无冲突"。
上一轮已经提供了现成的量测手法（`forcedLossTieBreakContract.test.ts:690–729` 的
`TrackedBranches`，统计 `keys.size > 1` 的冲突键；`hv14FiveGameForensics.test.ts:594–628`
的同款诊断，并额外比较 `firstWins` 与后写胜是否改变最终计划）。**但那两组证据都是 D1 规模
（或 3 个根）的实测，不能直接外推到 D2。**

本轮因为资源准入未通过（`RESOURCE_SAFETY_LOG.md`），这两条**没有测**。
因此按任务书 §4.3 的停止条款：

```text
BRANCH_EXTRACTION_RELIABILITY = PROVISIONAL (source-level argument complete, empirical gate NOT_PERFORMED)
D2_PCV_EFFECT_PROOF           = NOT_PERFORMED
SUBMIT_FOR_CHATGPT_ARBITRATION = TRUE
```

---

## 附：本轮配置与源码事实的逐项对齐表

| 任务书配置 | 源码落点 | 是否被源码保证 |
|---|---|---|
| `SEARCH_MODE = FIXED_DEPTH_D2` | `searchBestAction(state, 2, ctx)` `:2001` | 是（非迭代） |
| `USE_TT = FALSE` | `ctx.useTT=false` ⇒ `probeTT` 恒 null `:1757` | 是 |
| `USE_ALPHA_BETA = FALSE` | `:1418` 整块跳过 ⇒ `cutOff` 恒 false `:1449` | 是 |
| `USE_MOVE_ORDERING = FALSE` | `orderingOn = false` `:1268` | 是 |
| `MAX_THREAT_EXTENSIONS = 0` | `:1606` 与 `initialExtensions` `:1803` | 是 |
| `INTERCEPTION_QUIESCENCE = DISABLED` | `ctx.interceptionQuiescence` undefined `:1648` | 是 |
| `WALL_CLOCK_DEADLINE = NONE` | `deadlineReached` 直接 false `:88` | 是 |
| `LEAF_EVALUATOR = E1` | **必须手工注入** `ctx.leafEvaluator`，否则静默用 `defaultLeafEval` `:924` | **否——调用方责任** |
| `MAX_NODES = 8000000` | `ctx.maxNodes` `:1715` | 是 |
| `CAP_POLICY = STOP_AND_MARK_UNRESOLVED` | `budgetCutoffs++` + `completed:false` `:1716–1726` | 是（但见 4.2 缺陷 b） |
