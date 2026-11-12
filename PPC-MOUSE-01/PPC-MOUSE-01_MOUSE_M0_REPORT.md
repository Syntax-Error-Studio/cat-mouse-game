# PPC-MOUSE-01｜共享搜索内核与鼠 AI M0 独立原型

测试文件：`PPC-MOUSE-01/`（4 个测试文件 / 24 项 / 全通过）· 汇总：`PPC-MOUSE-01/out/SUMMARY.json` · 确定性 digest `b506de77335118fa`
生产代码改动：**0 行**（`src/` 本轮前后逐字一致）· 未 commit / 未 push / 未 reset / 未 stash / 未 clean

---

## 零、通俗中文总结（六问直答）

**1. 现有搜索器在鼠方根状态下是对的吗？**
是。11 个夹具 × {D1 全量, D2 抽 3 个} = **14 个根-深度对**，与一个**无剪枝、无 TT、无排序、无预算**的独立预言机**逐位相同**：值差 `maxAbsValueDiff = 0`，mate 分类 0 处不一致，选招与 oracle 的 argmin（鼠方取最小）**完全一致**。CHANCE 权重和 = 1 且**每个随机子节点都用全窗口搜索**（`chanceNodes === fullWindowChanceSearches`，本次 423 = 423）。mate 距离双向正确（鼠胜 `-MATE+2`、猫胜 `MATE-3`）。

**2. 需要复制一套新的 Expectiminimax 吗？**
不需要，而且没做。M0 的全部决策都走生产的 `searchBestActionIterative` → `runFixedSearch` → `searchActions`（同一份 MAX/MIN/CHANCE 循环、同一份 stateKey、同一份 TT、同一份 mate 步进）。本轮的"预言机"只存在于**测试文件里**，且故意写成最笨的版本（无剪枝无缓存），它是**对照组**，不是第二条产品路径。

**3. M0 能只靠共享核心实现吗？**
能。11 个夹具、26 步动作全部由**真实引擎**（`mouseMove` / `mouseSkill` / `chooseTunnelExit` + `endTurn`）接受，`rejects = 0`、模型与引擎 `mismatches = 0`，规划期间 `Math.random` 被调用 **0 次**。

**4. 整个鼠回合 100ms 够用吗？哪个深度？**
**D1 够，D4 不够。**
- D1：10/11 回合完整执行，**最大回合墙钟 11ms**，单步最大 5.73ms、均值 1.20ms。
- D4：**55%（GREEDY）/ 27%（EVEN）的回合在中途被预算掐断**；`completedDepth` 大多是 `1/2`、`2/3`，即 100ms 里真正"完成"的只有 1–2 层，剩下时间烧在一个**被丢弃**的深迭代上。最大回合墙钟 102ms。

**5. 还缺哪些鼠方计划功能？**
**5 项，全部是"计划的组织方式"，不是搜索能力**：①整回合计划提取器（`buildCatTurnPlan` / `fallbackPlanWalk` / `forcedLossTieBreak` 三处都硬编码了 `actor === Cat`，在 11 个鼠根上返回值恒为 0 / null）；②条件化计划（黄油揭示是分叉，线性动作表表达不了）；③传送子相位；④陷阱导致的变长计划；⑤交接点重查 RULE-A。详见 §6。

**6. 有性能或正确性问题吗？**
有 3 个，都可定位、都不需要改生产代码：
- **API 脚枪（本轮新发现）**：`createSearchContext(...)` **不会**设置 `leafEvaluator`，`searchBestAction` 于是静默回退到 `defaultLeafEval`（`200 - 5·曼哈顿 - 60·带黄油`），**不是**生产 Hard 用的 `evaluateForCat`。后果：**同一棵树、同一个节点数，值完全不同**。本轮 P1 一度把这个当成"鼠根搜索缺陷"，定位后确认是**测试端误用**，已固化为 P1-11 回归守卫。
- **搜索语义坑**：RULE-A 已判负（无路可走）的根仍宣告 4 个"合法动作"，搜索返回 `value=MATE_SCORE / mate=cat` 却同时给出一个动作。M0 因为**先查 RULE-A** 所以不受影响；任何直接接线的控制器必须有这一道检查。
- **性能事实**：100ms 内 D4 不可完成（与 PPC-SEARCH-01 对猫方的结论同构）。

---

## 一、状态块

```text
PPC_MOUSE01_STATUS = COMPLETE__M0_FEASIBLE_WITH_SHARED_CORE
SOURCE_BASELINE = branch ppc/2026-11-03-a0-trap-fix @ 9ba04b5, worktree DIRTY (pre-existing)
RULESET_VERSION = 2
PRODUCTION_CODE_CHANGED = NO (0 lines; only new files under PPC-MOUSE-01/)
NEW_EXPECTIMINIMAX_COPY = NONE
MOUSE_ROOT_PARITY = PASS (14/14 root-depth pairs, maxAbsValueDiff = 0, mate mismatches = 0)
MOUSE_ARGMIN = PASS (chosen action == oracle argmin on every probed root)
CAT_MAX_AT_MOUSE_ROOT = PASS (P1-8 cat root unchanged: 205.556 == oracle)
CHANCE_PARITY = PASS (weightSum = 1.000000000; chanceNodes == fullWindowChanceSearches, 423/423)
MATE_DISTANCE_PARITY = PASS (mouse -MATE+2, cat MATE-3, both directions)
TT_EXACT_PARITY = PASS (mouse root stores an EXACT entry at depth 2, second call 1262 -> 0 nodes)
TRUNCATION = FAIL_CLOSED (maxNodes 40 => completedDepth 0, bestAction null, value 0)
ENGINE_ACCEPTANCE = PASS (26/26 steps at generous budget, 26/26 at D1/100ms, 0 rejects, 0 mismatches)
RANDOM_VISIBILITY = PASS (0 Math.random calls during planning; 3 different draws => identical plan)
TURN_BUDGET_MODEL = ONE_SHARED_POOL (grants never exceed 100ms cumulatively; naive per-step model would be steps x 100)
D1_COMPLETION_100MS = 10 of 11 turns complete, max wall 11ms, mean step 1.20ms, max step 5.73ms
D4_COMPLETION_100MS = 4 of 11 (GREEDY) / 7 of 11 (EVEN); completedDepth mostly 1/2 or 2/3
TOTAL_TURN_150MS = NOT_EXCEEDED (max observed turn wall 103ms; 0 runs over 150ms)
MOUSE_TURN_PLAN_EXTRACTOR = MISSING (catTurnPlan length 0 on all 11 mouse roots)
FORCED_LOSS_TIEBREAK_AT_MOUSE_ROOT = returns null, 0.03ms (fail-closed dead weight)
RULE_A_PRE_CHECK = MANDATORY (a decided position still advertises 4 legal actions)
LEAF_EVALUATOR_INJECTION = MANDATORY (defaultLeafEval != evaluateForCat; same nodes, different value)
MAIN_SEARCH_BUDGET_MS = 100 (frozen, unchanged)
TOTAL_TURN_BUDGET_MS = 150 (frozen, unchanged)
H1 = evaluateForCat baseline (frozen, unchanged)
SIDECAR = unchanged
NEW_FORMAL_AUTHORITY = NONE
DETERMINISTIC_DIGEST = b506de77335118fa
HEAVY_WORKER_CONCURRENCY = 1
COMMIT_PUSH_STATUS = NONE
```

---

## 二、P0｜工程基线

| 项 | 实测值 |
|---|---|
| 分支 / HEAD | `ppc/2026-11-03-a0-trap-fix` @ `9ba04b5` |
| 工作区 | dirty（本轮之前已存在的未提交修改 + 4 个研究目录未跟踪） |
| `src/` 本轮改动 | **无**（`git status` 的 `M` 项全部早于本轮；`src/game/ai/expectiminimax.ts` mtime 2026-11-03，`engine.ts` 2026-11-11） |
| 规则版本 | `GAMEPLAY_RULESET_VERSION = 2` |
| 审计对象 | **工作树**（不是 HEAD） |
| 生产调用链（复用对象） | `planHardCatTurn` → `searchBestActionIterative(state, {maxDepthTurns:4, maxNodes:500_000, useTT:true, useAlphaBeta:true, useMoveOrdering:true, useThreatOrdering:false, maxThreatExtensions:0, leafEvaluator: evaluateForCat, deadlineMs})` |
| 叶子 | `HARD_LEAF_MODE = baseline`，H1 = `evaluateForCat`，未改 |
| 鼠方动作入口 | `mouseMove` / `mouseSkill` / `chooseTunnelExit` / `endTurn`（引擎），**不是** `simulateSearchAction` |
| 隔离 | 独立 `PPC-MOUSE-01/vitest.config.mts`（`pool: forks`, `maxWorkers: 1`, `fileParallelism: false`），不触碰生产 `vitest.config.ts` |

### 2.1 E0｜PPC-SEARCH-01 arm D 的追加勘误（已写入独立文件，原报告未动）

`PPC-MOUSE-01/E0_PPC_SEARCH_01_ARM_D_ERRATUM.json`

**冻结件复算（本轮重新核对，三份哈希与 E0 内记录一致，未被覆盖）**

| 文件 | 大小 | sha256 |
|---|---|---|
| `PPC-SEARCH-01/PPC-SEARCH-01_PVS_REPORT.md` | 30932 B | `47a6672cd51d3895…4de3dab3` |
| `PPC-SEARCH-01/PPC-SEARCH-01_PREREGISTRATION.json` | 4973 B | `c5344cbba8626f1a…6afbcc5f` |
| `PPC-SEARCH-01/proto/expectiminimaxPvs.ts` | 119463 B | `4999417063d2afbb…cc49f4d4` |

**勘误内容**：arm D 在"窄窗口未剪枝"时的取值标签**方向颠倒**了。正确映射（`X` 为搜索返回值）：

| 情形 | 已证明的命题 | 正确标签 | arm D 实际 |
|---|---|---|---|
| MAX 节点，未剪枝，窗口被收窄 | `true <= X` | **upper** | lower ❌ |
| MIN 节点，未剪枝，窗口被收窄 | `true >= X` | **lower** | upper ❌ |
| MAX 节点，发生 beta 剪枝 | `true >= X` | lower | lower ✓ |
| MIN 节点，发生 alpha 剪枝 | `true <= X` | upper | upper ✓ |

**影响面审计（`blast_radius_audit`，逐个消费者枚举）**：`isCertifiedResult`(`expectiminimax.ts:272`)、`storeTT`(`:1066`)、`forcedLossTieBreak.ts:54`、`:1316` rootValues、`turnLazy.ts:350` —— **全部只做 `bound === 'exact'` 的相等判断**。因此交换 lower/upper 在这份代码库里是**惰性**的：不改变任何过滤结果，不改变任何读数。

`affected_conclusions: NONE`。668× 节点、计划同一性、D2 +19.2% 等结论**全部不变**。E0 同时收紧了一条表述：arm D **不应**再被称为 "the bound fix"，它只是"一次保守的非 EXACT 标注，且两个标签互换了"。按任务书要求，**没有重跑 PVS Benchmark**。

---

## 三、P1｜鼠方根搜索审计

### 3.1 方法：一份故意写笨的对照预言机

`mouse_lib.mts: oracleTurnValue / oracleRootActions` —— **无剪枝、无 TT、无排序、无预算、无截断**，但**共用**同一份 `RULES`（`createEngineRuleSet()`）、同一份 `simulateSearchAction`、同一份 `mateActionCost` / `stepChildForParent` / `LEAF`。

这个设计决定了它**能证什么、不能证什么**：

- ✅ 能证：MAX/MIN 的方向、CHANCE 期望的算术、深度递减（以行动权变化计）、mate 距离的步进、剪枝是否切掉了不该切的东西、TT 是否返回了不该返回的值。
- ❌ 不能证：转移规则本身对不对（两者共用 `simulateSearchAction`）。规则正确性是 P2 用**真实引擎**做的，不是这里。

夹具矩阵（11 个，全部经 `validateGameConfig` + `createInitialState`，`customTerrain` 保证零 RNG 启动）：

| 夹具 | 板 | 覆盖什么 |
|---|---|---|
| `M_CARRY_HOME` | 6×6 | 携油回洞 → `MouseWins`，最短 mate 距离 |
| `M_BUTTER_PICKUP` | 6×6 | 黄油拾取（本图无合法再生格 → 走 `pendingButterPlacementDebt`） |
| `M_BUTTER_MICRO` | 6×6 | 单步必经拾取 → 根动作**本身就是 CHANCE** |
| `M10_BUTTER` | 10×10 | **真正多结果的 CHANCE**（候选格存在，权重 0.5/0.5） |
| `M_SKILL_ONLY` | 6×6 | 技能激活（零步长） |
| `M_TUNNEL` | 6×6 | 传送入口 → `choosing_tunnel_exit` 子相位 |
| `M_TRAP_ONLY` | 6×6 | 踩陷阱（剩余步数清零 + 回合立即交接） |
| `M_STRANDED` | 6×6 | RULE-A 无路判负（无黄油、三面墙） |
| `M_CAT_ADJACENT` | 6×6 | 猫贴身拦截 |
| `M_MICRO` | 6×6 | 1 步 + 黄油 + 技能，D2 = 一鼠步 + 整猫回合 |
| `M_CAT_MATE3` | 6×6 | 强制 mate in 3，验证距离而非仅符号 |

### 3.2 结果：14 个根-深度对逐位一致

| 夹具 | 深度 | 节点 | 生产搜索值 | 预言机值 | 差 | mate | 选招 | completedDepth |
|---|---|---|---|---|---|---|---|---|
| M_CARRY_HOME | 1 | 74 | -999998 | -999998 | 0 | mouse / mouse | mouse→ | 1 |
| M_BUTTER_PICKUP | 1 | 61 | -1731.746 | -1731.746 | 0 | null | mouse→ | 1 |
| M_SKILL_ONLY | 1 | 2 | -1696.368 | -1696.368 | 0 | null | skill | 1 |
| M_TUNNEL | 1 | 3 | -1750.794 | -1750.794 | 0 | null | mouse← | 1 |
| M_TRAP_ONLY | 1 | 0 | -705.000 | -705.000 | 0 | null | mouse↓ | 1 |
| M_STRANDED | 1 | 0 | 999999 | 999999 | 0 | cat / cat | mouse↑ | 1 |
| M_CAT_ADJACENT | 1 | 3 | -1254.365 | -1254.365 | 0 | null | mouse→ | 1 |
| M_MICRO | 1 | 29 | -1731.746 | -1731.746 | 0 | null | skill | 1 |
| M_BUTTER_MICRO | 1 | 0 | -1532.143 | -1532.143 | 0 | null | mouse→ | 1 |
| M_CAT_MATE3 | 1 | 0 | -508.586 | -508.586 | 0 | null | mouse→ | 1 |
| M10_BUTTER | 1 | 0 | -1061.043 | -1061.043 | 0 | null | mouse→ | 1 |
| M_MICRO | 2 | 1183 | -1596.627 | -1596.627 | 0 | null | skill | 2 |
| M_BUTTER_MICRO | 2 | 226 | -676.389 | -676.389 | 0 | null | mouse→ | 2 |
| M_CAT_MATE3 | 2 | 35 | 999997.000 | 999997.000 | 0 | cat / cat | mouse→ | 2 |

`maxAbsValueDiff = 0`，`mateMismatches = []`。

### 3.3 鼠确实在做 MIN（不是"碰巧选对"）

`M_MICRO @ D2` 的**全部**根动作值（预言机，`skill` 为 argmin）：

```text
skill   = -1596.6   <-- chosen (production AND oracle)
mouse→  =  -603.0
mouse↑  =  -126.8
mouse↓  = 999996.0
mouse←  = 999996.0
```

鼠取最小值、且两个"送死"方向拿到接近 `MATE_SCORE` 的猫胜值 —— 方向正确，不是排序侥幸。

### 3.4 CHANCE 保持真实概率且从不被窄窗口剪

`M_BUTTER_MICRO @ D2`：`outcomes = 2`、`weightSum = 1.000000000`、权重 `[0.5, 0.5]`、`chanceNodes = 423`、`fullWindowChanceSearches = 423`。
`M10_BUTTER` 提供另一组多结果 CHANCE（默认 10×10、`boxPositions: []` / `pilePositions: []` 的确定性无箱世界）。

`chanceNodes === fullWindowChanceSearches` 在**每一个**运行里成立 —— 这正是 D2 不变式（随机节点永不被继承窗口剪枝）在鼠根上的直接证据。

### 3.5 mate 距离以"真实游戏时间"计，不是层数

| 方向 | 期望 | 实测 |
|---|---|---|
| 鼠胜（`M_CARRY_HOME`） | `-MATE_SCORE + 2`（两步到位） | `-999998` ✓ |
| 猫胜（`M_CAT_MATE3 @ D2`） | `+MATE_SCORE - 3` | `999997` ✓ |

零步长动作（`mouseSkill` / `catPlaceTrap` / `chooseTunnelExit`）不推进距离 —— 与 `mateActionCost` 一致。

### 3.6 TT EXACT 语义不变

`M_MICRO @ D2`：首次调用写入 EXACT 条目（`value = -1596.6269841269843`、`depthTurns = 2`、`mate = null`），第二次调用 **1262 → 0 节点**，值、mate、动作三者一致。鼠根与猫根在 TT 上的行为没有区别。

### 3.7 截断 fail-closed

`M_CARRY_HOME`，`maxNodes = 40`：`completed = false`、`completedDepth = 0`、`bestAction = null`、`value = 0`、`mate = null`、`budgetExhausted = true`。**调用方拿不到动作**，这正是 M0 需要的语义（宁可不动，不可乱动）。

### 3.8 猫根未被污染（回归守卫）

把 `M_TRAP_ONLY` 交接给猫后作根：`planMouseSearch` 得 `205.556`，预言机 `205.556`，猫选 `cat↑`（`catStep` / `catPlaceTrap`）。**鼠根的改动没有反向影响猫根。**

### 3.9 合法动作覆盖（无凭空、无遗漏）

11 个夹具的 `generateLegalSearchActions` 与预言机独立枚举**集合相等**（`sameSet = true` 全部成立）。

---

## 四、P1-11｜本轮发现的 API 脚枪（"先定位并报告"的落地）

### 4.1 现象

P1 期间出现一个刺眼的读数：**同一状态、同一深度，定深入口与迭代入口给出不同的根值**。

```text
== M_MICRO D2      oracle = -1596.627
   fixed   value = 135.000   (tt=false ab=false ord=false, nodes = 79069)
   fixed   value = 135.000   (tt=true  ab=true  ord=true,  nodes =  1105)
   iterative value = -1596.627
```

`135` 恰好是 `200 - 5·1 - 60`。先排除的假设（都有读数）：不是 PVS 类窗口污染（**全关也算 135**）、不是 CHANCE 期望（同数字在无 CHANCE 的根上也出现）、不是预算截断（79069 < 500000）。

### 4.2 根因

`createSearchContext()` **不设置 `leafEvaluator`**，`evaluateLeaf` 于是走 `defaultLeafEval`：

```ts
// expectiminimax.ts:923
export function defaultLeafEval(state) {
  let score = 200 - manhattan(cat, mouse) * 5;
  if (state.mouseHasButter) score -= 60;
  return score;
}
```

而生产 Hard 用的是 `evaluateForCat`（`hardTurnPlanner.ts:239`：`leafEvaluator: opts.leafEvaluator ?? evaluateForCat`；迭代入口另有 `opts.leafEvaluator`）。**定深入口 `searchBestAction(state, D, ctx)` 没有任何默认**，静默使用另一个评估函数。

### 4.3 定点验证（同一棵树，只换叶子）

| 夹具 | 深度 | 不注入 | 注入 `evaluateForCat` | 预言机 | 节点数 |
|---|---|---|---|---|---|
| M_MICRO | 1 | **115** | -1731.746 | -1731.746 | 89 / 89 |
| M_BUTTER_MICRO | 1 | **115** | -1532.143 | -1532.143 | 0 / 0 |

**节点数完全相同** ⇒ 遍历、MAX/MIN/CHANCE、剪枝、TT 全部无变化；只有叶子数字变了。**这不是搜索缺陷，是调用契约缺陷。**

### 4.4 处置

- 已固化为 **P1-11** 回归守卫（`out/p1_leaf_injection_contract.json`）：断言"同节点数 / 不同值 / 注入后等于预言机"。
- 已回填 P1-5 与 P1-6 的 ctx（此前它们的 `value` 列是 `defaultLeafEval` 的产物，虽然各自被测的不变量不受影响）。
- **未改生产代码**（任务书禁止用改生产代码"绕过"）。正确处置是把它写进 §7 的接入清单第 1 条：**必须注入**。

> 结论口径：本项属 **`HARNESS_MISUSE_RESOLVED`**，不计为生产搜索缺陷。但它是一个**真实的接线风险**——任何按"直接 `createSearchContext` + `searchBestAction`"接入鼠 AI 的代码，都会静默地玩另一个游戏。

---

## 五、P2｜M0 鼠方控制器

### 5.1 结构（`mouse_lib.mts: runMouseTurnM0`）

```text
1. RULE-A 预检：applyNoMoveLoss(state)；若已判负 → 记 rule_a_terminal_before_planning，0 步退出
2. 循环（最多 MAX_TURN_STEPS = 12）：
   a. 判"还是不是鼠的行动权"（Playing+Mouse 或 ChoosingTunnelExit），不是就结束
   b. 从【回合共享池】领到本步预算；剩余 < 2ms 就停下并记 turn_budget_exhausted
   c. 规划：planMouseSearch → 生产 searchBestActionIterative（一次调用，无 per-step 重授权）
      规划期间把 Math.random 替换为计数器，结束后还原
   d. 拿不到动作 → 记 no_completed_depth / no_legal_action 并停（fail-closed）
   e. 执行：executeReal 走【真实引擎】；引擎拒绝 → 记 engine_rejected_action 并停
   f. 用引擎返回的【真实新状态】作为下一轮起点（不重放、不猜测、不预读随机）
```

### 5.2 时间预算：一个鼠回合 = 一个池（这是任务书的硬要求）

```ts
const remaining = budgetMs - (clock() - turnStart);
if (remaining < MIN_STEP_BUDGET_MS) { abortReason = 'turn_budget_exhausted'; break; }
const share = policy === 'SHARED_EVEN'
  ? Math.max(MIN_STEP_BUDGET_MS, remaining / Math.max(1, state.mouseMovesLeft))
  : remaining;
const stepBudget = Math.max(MIN_STEP_BUDGET_MS, Math.min(share, remaining));
```

`SHARED_GREEDY` 把剩余全部给当前步（后面自然没钱），`SHARED_EVEN` 按剩余步数均分。两种策略**都从同一个 `turnStart` 扣款**，因此 `Σ grant ≤ 100ms` 是构造性成立的：

```json
{"turnBudgetMs":100,"grantsMs":[100],"cumulativeGranted":100,
 "naivePerStepModel":100,"totalWallMs":100.69,"overrunMs":0.69,"hardWallMs":150}
```

> `naivePerStepModel = steps × 100` 就是任务书点名禁止的那种"每一步各得 100ms"。M0 没有那样做。

### 5.3 六类鼠方动作全部正确处理（宽松预算，每步都由引擎复核）

| 夹具 | 步数 | 动作序列 | 终局 | 墙钟 |
|---|---|---|---|---|
| M_CARRY_HOME | 2 | `mouse→, mouse→` | **MouseWins** | 25.23ms |
| M_BUTTER_PICKUP | 7 | `mouse→, mouse↑, skill, mouse↑, mouse←, mouse←, exit(5,0)` | playing/cat | 26.25ms |
| M_SKILL_ONLY | 3 | `skill, mouse↑, exit(5,0)` | playing/cat | 1.56ms |
| M_TUNNEL | 2 | `mouse←, exit(0,0)` | playing/cat | 1.19ms |
| M_TRAP_ONLY | 1 | `mouse↓`（踩陷阱，步数清零） | playing/cat | 0.18ms |
| M_STRANDED | 0 | —（RULE-A 判负，不行动） | **CatWins** | 0.01ms |
| M_CAT_ADJACENT | 2 | `mouse→, mouse↓` | playing/cat | 1.54ms |
| M_MICRO | 6 | `skill, mouse↑, mouse↑, mouse→, mouse→, exit(5,0)` | playing/cat | 8.06ms |
| M_BUTTER_MICRO | 1 | `mouse→`（必经 CHANCE 拾取） | playing/cat | 0.65ms |
| M_CAT_MATE3 | 1 | `mouse→` | playing/cat | 0.15ms |
| M10_BUTTER | 1 | `mouse→` | playing/cat | 11.31ms |

合计 **26 步**：`parity` = 23 次 `exact` + 3 次 `chance_masked`，**0 reject / 0 mismatch**。

### 5.4 随机信息可见性

- 规划期间 `Math.random` 调用 **0 次**（11 个夹具 × 全部回合）。
- 把同一个根分别用 `draw ∈ {0, 0.5, 0.999999}` 跑：**计划逐字相同**、首步值相同（`-1731.746`）。
- `chance_masked` 的判据是刻意保守的：只要求"引擎公告的形态（幽灵数量 + 债务）能对应到某个枚举结果，且所有**确定性**字段一致"，**故意不比较幽灵落在哪一格**——因为那正是"未来随机结果"，规划阶段不该知道。

---

## 六、P3｜正确性与性能

### 6.1 真实 100ms 墙钟（11 夹具 × {D4, D1} × {GREEDY, EVEN}）

| 组合 | 运行 | 步数 | 均步 | 完整回合 | 预算中止率 | 最大回合墙钟 | 超 150ms | reject | mismatch | random |
|---|---|---|---|---|---|---|---|---|---|---|
| D1 / SHARED_EVEN | 11 | 26 | 2.36 | **10/11** | 0.00 | **11ms** | 0 | 0 | 0 | 0 |
| D1 / SHARED_GREEDY | 11 | 26 | 2.36 | **10/11** | 0.00 | **11ms** | 0 | 0 | 0 | 0 |
| D4 / SHARED_EVEN | 11 | 15 | 1.36 | 7/11 | **0.27** | 102ms | 0 | 0 | 0 | 0 |
| D4 / SHARED_GREEDY | 11 | 10 | 0.91 | 4/11 | **0.55** | 102ms | 0 | 0 | 0 | 0 |

单步分布：**D1** 52 步，均值 1.20ms / 最大 5.73ms / **全部 `1/1` 完成**；**D4** 25 步，均值 70.63ms / 最大 102.38ms。

### 6.2 D4 在 100ms 里到底发生了什么（逐夹具）

```text
GREEDY M_CARRY_HOME    steps=1 depths=['1/2'] wall=101 abort=turn_budget_exhausted
GREEDY M_BUTTER_PICKUP steps=1 depths=['1/2'] wall=101 abort=turn_budget_exhausted
EVEN   M_BUTTER_PICKUP steps=3 depths=['1/2','1/2','1/2'] wall=101 abort=turn_budget_exhausted
GREEDY M_SKILL_ONLY    steps=1 depths=['2/3'] wall=101 abort=turn_budget_exhausted
GREEDY M_MICRO         steps=1 depths=['2/3'] wall=101 abort=turn_budget_exhausted
GREEDY M_CAT_ADJACENT  steps=1 depths=['3/4'] wall=102 abort=turn_budget_exhausted
GREEDY M_CAT_MATE3     steps=1 depths=['4/4'] wall= 25 abort=None
```

口径很关键：`depths=['1/2']` 意为"完成了 D1、正在试 D2、没完成"。所以 D4 的 100ms 读数**不是**"搜到了第 4 层"，而是"完成 1–2 层，剩下的时间烧在一个被丢弃的深迭代上"。唯一真正到 D4 的 `M_CAT_MATE3` 只花 25ms —— 因为它 35 个节点就穷尽了。

这与 PPC-SEARCH-01 对猫方的结论（100ms 内 D2 完成率 0/8）**同构**：在这套 DAG 走查 + EXACT-only TT 的成本结构下，100ms 的现实视界是 **D1–D2**。

### 6.3 终局一致性

| 检查 | 结果 |
|---|---|
| 每步动作是否在根合法集内（独立重枚举） | 10/10 夹具的首步全部 `inLegalSet = true` |
| 引擎是否接受每一个动作 | **26/26 接受，0 reject**（D1/100ms 与宽松预算两组独立复现） |
| 模型与引擎是否一致 | **0 mismatch**（23 `exact` + 3 `chance_masked`） |
| 计划回放（用引擎函数而非模拟器） | 全部动作都由 `mouseMove` / `mouseSkill` / `chooseTunnelExit` 实际执行 |

### 6.4 完整的正确性门槛表

| 门槛（任务书 P3） | 结果 | 证据 |
|---|---|---|
| 普通路径 | PASS | 11 夹具 D1 全对；`M_CARRY_HOME`/`M_MICRO` 多步抵达 |
| 携油回洞 | PASS | `M_CARRY_HOME`：2 步 `MouseWins`，`-999998` |
| 猫拦路 | PASS | `M_CAT_ADJACENT`、`M_CAT_MATE3` |
| 技能 | PASS | `M_SKILL_ONLY`、`M_MICRO`（`skill` 为 argmin） |
| 传送 | PASS | `M_TUNNEL` → `choosing_tunnel_exit` → `exit(0,0)` |
| 陷阱 | PASS | `M_TRAP_ONLY`（1 步，回合立即交接） |
| 随机公告 | PASS | `M10_BUTTER`（权重 0.5/0.5）、`chanceNodes == fullWindowChanceSearches` |
| 失败关闭 | PASS | `maxNodes=40 → bestAction null`；`M_STRANDED → 0 步`；引擎拒绝即停 |
| 合法动作率 | **100%** | 26/26 引擎接受 |
| 完整回合执行率 | D1 **10/11**；D4 4–7/11 | §6.1 |
| 终局一致性 | PASS | 0 mismatch |
| 搜索完成深度 | D1 全部 1/1；D4 多为 1/2、2/3 | §6.2 |
| 实际墙钟 | 最大 103ms（< 150ms 硬墙） | §6.1 |
| 截断回退 | fail-closed，无"假装有解" | §3.7 |
| 随机信息可见性 | 规划期 0 次 `Math.random` | §5.4 |

> **不使用对局胜率做任何声明**。本轮没有跑整局，也没有把 M0 与 Hard 对比。26 步是**夹具上的动作级**证据，不是棋力结论。

---

## 七、P4｜验收与下一步

### 7.1 结论：M0 可以仅靠共享核心实现

**GO（仅限 M0 形态）**。因为在 11 个夹具上，一次 `searchBestActionIterative` 调用 + 一次真实引擎执行，就足以驱动整个鼠回合，不需要任何新的搜索代码。差异全在**回合的组织层**，不在搜索层。

### 7.2 还缺什么：5 项鼠方计划功能（全部实测，不是推测）

| # | 缺口 | 实测证据 | 属于 |
|---|---|---|---|
| 1 | **整回合计划提取器** | `catTurnPlan.length = 0` 在**全部 11 个鼠根**（`out/p4_plan_gap.json`）；`buildCatTurnPlan`(`:1894`) 与 `planQuality.fallbackPlanWalk`(`:582`) 都 `break` 在 `currentPlayer !== PieceType.Cat` | 计划层 |
| 2 | **条件化计划** | 黄油拾取分叉成 CHANCE，揭示的幽灵改变下一步决策 ⇒ 线性动作表表达不了 | 计划层 |
| 3 | **传送子相位** | `mouseMove` 后进入 `choosing_tunnel_exit`，合法集只剩出口（本例 4 个，含引擎自己 `unshift` 的 "↺ 原地"） | 计划层 |
| 4 | **变长计划** | 踩陷阱使 `mouseMovesLeft = 0`，计划长度取决于状态而非配置 | 计划层 |
| 5 | **交接点重查 RULE-A** | RULE-A 可在任意交接点判负（`M_STRANDED`） | 控制器 |

附带发现（`out/p4_forced_loss_tiebreak_at_mouse_root.json`）：`forcedLossTieBreak` 在鼠根**仍然会被执行**（0.03ms，`rootValues = 5` 其中 2 个 mouse-mate），返回 `null`（fail-closed）。它是个**猫方计划选择器**，对鼠方是死重；不能直接复用。

### 7.3 生产接入的最小改动清单（**仅清单，本轮未接线**）

按"最小手术"排序，每一步都可独立验证：

1. **新增 `src/game/ai/mouseTurnPlanner.ts`**（对齐 `hardTurnPlanner.ts:226`）
   - 一次 `searchBestActionIterative`，**必须**显式 `leafEvaluator: evaluateForCat`（§4）；
   - `maxDepthTurns` 默认 **1**（100ms 实测视界），而不是照抄猫的 4；
   - 不做任何 `currentPlayer` 门控。
2. **`searchConfig.ts` 增加鼠方预算常量**：`MOUSE_TURN_BUDGET_MS = 100` + 明确"这是**整回合共享池**，不是每步"。不得复用 `MAIN_SEARCH_SEMANTIC_BUDGET` 的名字与语义（那 100ms 是猫方单次主搜索）。
3. **控制器落地 `src/game/ai/mouseTrajectory.ts`**（对齐 `computeCatAiTrajectory`）
   - 规划前 `applyNoMoveLoss`，判定已终局则不动作；
   - `completedDepth === 0` 或 `bestAction === null` 时**不动作**（fail-closed）；
   - 执行只走 `mouseMove` / `mouseSkill` / `chooseTunnelExit`（**禁止** `simulateSearchAction`）；
   - 每步从**同一个 `turnStart`** 扣预算（§5.2）；
   - 规划期不得触碰 `Math.random`。
4. **（可选，仅为整回合计划）**：把 `buildCatTurnPlan` 的 actor 门控参数化为 `buildTurnPlan(state, ctx, actor)`，并给鼠方一个等价的 `forcedLossTieBreak`。**M0 不需要这一项**。
5. **门禁**：新增一条回归，断言"任何鼠方 planning 调用都必须带 `leafEvaluator`"，防止 §4 的脚枪回潮。

**不需要改的**：`expectiminimax.ts` 的搜索数学、`ScoreBound`、TT、CHANCE、mate 步进、H1、Sidecar、100ms/150ms 常量。

### 7.4 明确**不**成立的声明

- ❌ 不声明"鼠 AI 已达 Hard 水平"（本轮没跑整局）。
- ❌ 不声明"D4 在 100ms 内可用"（§6.2 反驳）。
- ❌ 不声明"鼠方搜索已实现回合级计划"（`catTurnPlan` 恒 0）。
- ❌ 不声明"`defaultLeafEval` 是缺陷"（它是刻意保留的简单叶子；缺陷在**调用方不注入**）。
- ❌ 不把 `M_STRANDED` 的 4 个合法动作说成"bug"（`simulateSearchAction` 内部先结算 RULE-A，动作本身确实生成；是**控制器**必须先查 RULE-A）。

---

## 八、与预注册的偏离申报（本轮**没有**预注册文件）

本轮执行前**未**冻结预注册。为避免污染后续轮次的"预注册"权威性，`PPC-MOUSE-01_CLAIM_SCOPE.json` 被明确标注为 `post_hoc = true` 的**声明范围文件**，而不是预注册。偏离/事后追加项如实列出：

| 项 | 任务书要求 | 实际 | 性质 |
|---|---|---|---|
| PVS 勘误 | 追加式保存、不重跑 | 已按追加式写入 E0，**未重跑** Benchmark | 符合 |
| 鼠根验证 | 完整深度与截断语义一致 | D1 全量 11 根 + D2 抽 3 根（不是全部 11 根 D2） | **缩减**（D2 在大板上非平凡时间成本；3 根已覆盖 mate / CHANCE / 普通三类） |
| 合法动作率 | 逐动作核对 | 首步独立重枚举 10/10；**其余步**靠引擎接受（26/26） | **缩减并说明**（重放后续步需重跑 CHANCE 抽样，正是 M0 拒绝做的事） |
| 性能对照 | — | 新增 `D1 vs D4 × {GREEDY, EVEN}` 四组合 | **事后追加**（由 §6.2 的发现驱动） |
| P1-11 | 无 | **事后追加**的回归守卫 | 由一次**误报**触发的止损；已如实记录为 harness 误用（§4） |
| 整局对局 | 收尾要求 | **未做** | 任务书明确"不使用对局胜率宣布鼠 AI 已达 Hard 水平"，本轮不引入 |
| 生产接线 | "给出清单，不自动接线" | 只给清单，未改 `src/` | 符合 |

---

## 九、证据索引

| 文件 | 内容 |
|---|---|
| `E0_PPC_SEARCH_01_ARM_D_ERRATUM.json` | arm D bound 方向勘误 + 影响面审计（冻结件哈希） |
| `mouse_lib.mts` | 夹具 / 无剪枝预言机 / 单次生产搜索封装 / 真实引擎执行 / M0 控制器 |
| `mouse_smoke.test.mts` | 夹具合法 + 一次鼠根搜索（2 项） |
| `mouse_p1.test.mts` | P1-0…P1-11（12 项） |
| `mouse_m0.test.mts` | P2-A/B/C + P3-A/B/C（6 项） |
| `mouse_p4.test.mts` | P4-1…P4-4（4 项） |
| `out/p1_mouse_root_parity.json` | 14 个根-深度对的逐行对照表 |
| `out/p1_oracle_root_ranking.json` | `M_MICRO` 全根动作值排序（argmin 证据） |
| `out/p1_chance.json` | CHANCE 权重和、`chanceNodes == fullWindowChanceSearches` |
| `out/p1_tt.json` | 鼠根 EXACT 存取与节点塌缩 |
| `out/p1_truncation.json` | 截断 fail-closed |
| `out/p1_mate_distance.json` | mate 距离双向 |
| `out/p1_leaf_injection_contract.json` | **P1-11** 叶子注入契约（同节点数 / 不同值） |
| `out/p1_legal_coverage.jsonl` | 11 夹具合法集与预言机一致 |
| `out/p2a_m0_generous.jsonl` / `_all.json` | 宽松预算下 26 步逐动作记录 |
| `out/p2b_named_behaviours.json` | 赢 / 技能 / 陷阱 / 传送 / 判负 五种命名行为 |
| `out/p2c_random_independence.json` | 三种 draw → 同一计划 |
| `out/p3a_m0_100ms.jsonl` / `_all.json` | 四组合 × 11 夹具真实墙钟 |
| `out/p3b_budget_accounting.json` | 共享池账目 |
| `out/p3c_action_legality_all.json` | 首步合法集成员 + 引擎裁决 |
| `out/p4_plan_gap.json` | `catTurnPlan` 在 11 个鼠根恒为 0 |
| `out/p4_forced_loss_tiebreak_at_mouse_root.json` | 鼠根上的猫方选择器（死重） |
| `out/p4_rule_a_sink.json` | 已判负仍宣告 4 个动作 |
| `out/p4_mouse_plan_requirements.json` | 5 项计划要求 |
| `out/SUMMARY.json` | 全部汇总 + 确定性 digest（墙钟不入 digest） |
| `summarize.py` | 从原始工件**复算**汇总（与报告不一致即为脚本 bug） |

外部文献本轮未新增引用；全部结论来自本地实测。

---

## 十、复现

```bash
# 全量（4 文件 / 24 项，串行，约 30s）
npx vitest run --config PPC-MOUSE-01/vitest.config.mts

# 单阶段
npx vitest run --config PPC-MOUSE-01/vitest.config.mts PPC-MOUSE-01/mouse_p1.test.mts
npx vitest run --config PPC-MOUSE-01/vitest.config.mts PPC-MOUSE-01/mouse_m0.test.mts
npx vitest run --config PPC-MOUSE-01/vitest.config.mts PPC-MOUSE-01/mouse_p4.test.mts

# 从原始工件复算汇总（确定性 digest 必须仍是 b506de77335118fa）
python PPC-MOUSE-01/summarize.py
```

隔离保证：独立 `vitest.config.mts`（`pool: forks`、`maxWorkers: 1`、`fileParallelism: false`），重型作业并发 1，全部 fresh process 串行，不触碰生产 `vitest.config.ts`。

---

**本轮到此停止，等待下一阶段裁决。**
