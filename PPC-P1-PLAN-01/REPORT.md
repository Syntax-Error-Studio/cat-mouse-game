# PPC-P1-PLAN-01｜Hard Cat 完整回合计划长度修复与正确性认证

- 轮次：`PPC-P1-PLAN-01`
- 日期：2026-11-13
- 分支：`ppc/p1-id-state-identity-fix`，HEAD `48eaac6c4f3801d351787696ba5876995b64e8d8`
- 基线：P1-ID-01 / P1-TIME-01 / P1-TIME-02 全部保留，未覆盖、未回退
- 授权：只读审计 + 最小生产修复 + 验证取证；**未** commit / push / merge / reset / clean / stash / rebase
- 裁决：待 ChatGPT 复核，本轮不自我宣告 PASS

---

## 1. 一句话结论

计划提取器里那个写死的 `maxLength = 8` 不是"够用的大数"，而是一条**会静默砍掉合法回合**的截断线：默认地图 4 步时最大合法计划是 7 个动作，所以它从未被发现；一旦 `catBaseMoves ≥ 6`，它就开始吃动作，把完整回合截成"猫还有步数没走"的半截计划，并连带让 `buildCandidate` 以 `null` 收场（fail-closed）。

本轮把它换成**一条可证明的上界推导** `M + 1 + floor(M/2)`（M = 根状态剩余 `catMovesLeft`），并用真实引擎复现、关闭两个已登记反例，`src/` 内不再有任何一处硬编码计划长度。

---

## 2. 问题在人话层面是什么

一回合里猫能做两类事：

- **走一步**（含推箱子）：花 1 步。
- **放夹子**：**不花步**（`catPlaceTrap` 不动 `catMovesLeft`）。

所以"猫这一回合能走几步"和"这只手能出几个动作"是**两个不同的数**。老代码把后者当成常量 8。默认 4 步时，一回合最多 4 走 + 1 放夹 = 5，个别线路能到 7（来回踩自己刚放的夹子回收，再放、再回收），刚好卡在 8 以下——这是缺陷长期隐身的原因。

到了 6 步、9 步的局面，合法计划真的有 9、10、14 个动作，而提取器在第 8 个动作后 `while (plan.length < maxLength)` 直接退出。后果不是"少显示一步"，而是：

1. 计划的完整性裁决变成 `TRUNCATED`（末态 `catMovesLeft > 0` 且还有合法动作）；
2. 下游 `buildCandidate` 认为"这不是一个完整回合"，返回 `null` → 该根节点拿不到候选计划；
3. 因为发生在**搜索之后**，搜索本身的值、mate、最佳动作全是对的，只有交付给人/UI 的计划是错的——所以没有任何评分指标会发现它。

---

## 3. 根因

**根因唯一**：五处计划提取入口各自硬编码 `maxLength = 8`，把"动作数上界"错误地等于了一个历史常量，而真实上界取决于根状态的剩余步数。

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `expectiminimax.ts` `buildCatTurnPlan` | `maxLength = 8` | `maxLength = maxCatTurnPlanActions(state)` |
| `planQuality.ts` `buildPlanForFirstAction` | `maxLength = 8` | `maxLength = maxCatTurnPlanActions(root)` |
| `planQuality.ts` `extractBestCatTurnPlan` | `maxLength = 8` | `maxLength = maxCatTurnPlanActions(root)` |
| └ `extractDp`（内部） | 继承形参 | 继承形参（同一数值） |
| └ `fallbackPlanWalk`（内部） | 继承形参 | 继承形参（同一数值） |
| `planQuality.ts` `buildCandidate` | 走上述入口 | 走上述入口（无自有常量） |
| `planQuality.ts` `finalizeCompletedIterationPlan` | 走上述入口 | 走上述入口（无自有常量） |

"改五处"本身是错的解法——五个数字迟早会分叉。因此本轮**不产生五个数字，只产生一个**：`src/game/ai/planBound.ts` 是本轮唯一新增的生产模块，五处全部默认到它。完整调用图与逐条判定见 `PLAN_EXTRACTION_CALL_GRAPH.md`。

---

## 4. 上界证明（摘要，全文见 `PLAN_ACTION_BOUND_PROOF.md`）

设 M = 提取根状态的 `catMovesLeft`。

**事实 1**：`catStep` 恒消耗 1 步。`catMove`（`engine.ts:872`）四个出口中，非法步返回原状态（被 `legalActions` 过滤掉），RULE-A settle 结束回合，推箱分支（`:938`）与普通移动分支（`:961`）都返回 `catMovesLeft - 1`。⇒ 一回合最多 M 次走步。

**事实 2**：`catPlaceTrap` 不耗步，但要求 `trapPosition === null`，放完陷阱就在盘上。⇒ 两次放夹之间**必须**先回收。

**事实 3**：回收的唯一途径是**踩上**陷阱格（`catMove` 的 `steppedOnTrap` 分支，耗 1 步）。而放夹后猫正站在陷阱格上，所以回收步不能紧跟放夹步。⇒ 两次放夹之间至少 2 步。

⇒ **动作数 ≤ M + 1 + floor(M/2)**。

| M | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 9 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|
| 上界 | 1 | 2 | 4 | 5 | **7** | 8 | 10 | 11 | 14 | 19 |

M=4 时上界 7 < 8 —— 这就是缺陷在默认地图上不可见的**定量解释**，不是"运气好"。

**为什么不用 `config.catBaseMoves`**：猫回合可以被中途接续（搜索从非回合起点展开、计划从任意中间态重建），此时剩余步数小于配置值。用配置值会**放大**上界（安全但浪费），用 0 会**截断**。必须用根状态自己的 `catMovesLeft`。

**终止性不由 cap 负责**：一回合的状态空间本身有限，因为 `stateKey` 含 `catMovesLeft` / `catTrapsRemaining` / `trapPosition`，三者回合内单调变化 ⇒ 同一回合两个不同前缀不可能共享 `stateKey` ⇒ 提取器现有的 `pathGuard` / `seen` 集合就是终止依据。cap 是**叠加在其上的、可证明不生效的松弛量**——这正是 DP memo 合法的前提（下节）。因此**没有**使用 `maxLength = Infinity`。

---

## 5. 修复前真实反例（`BASELINE_TRUNCATION_WITNESS.json`）

两份取证都由真实 `createSearchContext` + 真实 `searchBestAction` 产出，不是手搓状态。

### 5.1 PLAN-1：`catBaseMoves = 9`，纯移动 9 动作被截成 8

- 棋盘：10×10，除第 3 列 1..6 行、2×2 洞、4 条隧道外全是 `Pile`（不可推，避免引入推箱分支）；鼠在洞内。
- 根：`catMovesLeft = 9`，`catTrapsRemaining = 1`，根合法动作 2 个。
- 搜索：`value = -972`、`mate = null`、`completed = true`、`nodes = 111`、`bestAction = ArrowDown`。
- **修复前返回**：8 个动作 `DDDDDTUU`，裁决 `TRUNCATED`（`catMovesLeft = 2`）。
- **同 ctx 只把 cap 抬到 1000**（`uncappedReference`）：9 个动作 `DUDUDUDUD`，`COMPLETE_TURN_BOUNDARY`。
- **独立构造的合法满回合线**：10 个动作 `DDDDDTUUUU`，逐步重放 `replayOk = true`、`allEffective = true`、末态 `catMovesLeft = 0`、`endActor = mouse`。

⇒ 两个结论同时成立：
1. 存在**确实被截断**的合法计划（9 动作被砍成 8）；
2. 存在比 9 更长的合法计划（10 动作），所以 **`catBaseMoves + 1` 不是充分上界**——任务书预设的那个候选答案被实测否证。10 ≤ 本轮的 14，上界容得下。

### 5.2 PLAN-2：`catBaseMoves = 6`，`TUDTUDTDD`（6 走 + 3 放夹 = 9 动作）

- 棋盘：10×10 全开放（无箱、无 pile、无黄油），鼠在洞内。
- 重放（真实 `catMove` / `catPlaceTrap`）：

| i | 动作 | effective | catMovesLeft | traps | trap | cat |
|---|---|---|---|---|---|---|
| 0 | T | ✓ | 6 | 0 | (3,3) | (3,3) |
| 1 | U | ✓ | 5 | 0 | (3,3) | (2,3) |
| 2 | D | ✓ | 4 | **1** | **null** | (3,3) |
| 3 | T | ✓ | 4 | 0 | (3,3) | (3,3) |
| 4 | U | ✓ | 3 | 0 | (3,3) | (2,3) |
| 5 | D | ✓ | 2 | **1** | **null** | (3,3) |
| 6 | T | ✓ | 2 | 0 | (3,3) | (3,3) |
| 7 | D | ✓ | 1 | 0 | (3,3) | (4,3) |
| 8 | D | ✓ | **0** | 0 | (3,3) | (5,3) → **mouse** |

这张表同时验证了本轮的三个规则前提：放夹不耗步（i=0→i=1 前 `catMovesLeft` 仍是 6）、放夹后必须离开再回来才能回收（i=1 U 离开、i=2 D 踩回收，`traps` 回 1、`trap` 变 null）、末步交接给鼠。

- **修复前**：`buildCatTurnPlan` / `buildPlanForFirstAction` / `extractBestCatTurnPlan(fallbackWalk)` **全部**返回 8 动作 `TUDTUDTD`，`buildCandidate = null`。
- **同 ctx 抬 cap 到 1000**：9 动作 `TUDTUDTDD`。
- 裁决对照：8 动作前缀 = `TRUNCATED`（`catMovesLeft = 1`），完整 9 动作 = `COMPLETE_TURN_BOUNDARY`（`catMovesLeft = 0`）。

⇒ `catBaseMoves = 6` 的情况下 `catBaseMoves + 1 = 7`、`catBaseMoves + 2 = 8` **都不够**，第二次否证"配置值 + 常数"这类猜测。

### 5.3 PLAN-3：四个入口在同一次真实搜索上的横向对照（修复前）

`value = -972`、`mate = null`、`bestAction = ArrowDown`、`completed = true`、`equalPrimaryGraphNodes = 79`、`planBranchesEntries = 112`。

| 入口 | 修复前 | 修复后 |
|---|---|---|
| `buildCatTurnPlan` | 8 `DUDUDUDU` TRUNCATED | 9 `DUDUDUDUD` COMPLETE |
| `buildPlanForFirstAction` | 8 `DUDUDUDU` TRUNCATED | 9 `DUDUDUDUD` COMPLETE |
| `extractBestCatTurnPlan`（DP） | 8 `DDDDDTUU` TRUNCATED | 10 `DDDDDTUUUU` COMPLETE |
| `extractBestCatTurnPlan`（walk） | 8 `DUDUDUDU` TRUNCATED | 9 `DUDUDUDUD` COMPLETE |
| `buildCandidate` | **null** | 9 `DUDUDUDUD` |

注意 DP 修复后给出 10 动作、walk 给出 9 动作：两者不同是**既有的设计差异**（DP 在等值图中找最深目标，walk 走 `planBranches` 单链），不是本轮引入的分歧；两者都被判为 `COMPLETE_TURN_BOUNDARY`，与各自 `maxLength = 1000` 的结果**逐字相同**（`POSTFIX_PLAN_WITNESS.json`）。

---

## 6. 修复后（`POSTFIX_PLAN_WITNESS.json`）

- PLAN-1：返回 **10** 动作 `DDDDDTUUUU`，`COMPLETE_TURN_BOUNDARY`，`catMovesLeft = 0`；搜索侧 `value / mate / bestAction / completed / nodes` 与修复前**完全一致**（-972 / null / ArrowDown / true / 111）。
- PLAN-2：四个入口**全部 9** 动作 `TUDTUDTDD`，`buildCandidate` 返回 9 动作，不再 `null`。
- PLAN-3：全部入口 `COMPLETE` 且与 `maxLength = 1000` 的参考结果一致。

搜索侧数值一个都没动，计划侧全部被修好——这正是"修复应该在搜索之后、且只在搜索之后"的实证。

---

## 7. 全链路覆盖（`PLAN_EXTRACTION_CALL_GRAPH.md`）

**5 个提取器、全部调用点已逐一列出并覆盖**。除上述入口外，还逐条裁定了 `src/game` 内其余所有"长度类"限制，结论：**没有第二处会截断合法计划**。特别地：

- `engine.ts:4124` 的 `maxSafety = catBaseMoves * 8 + 20` 曾被视为潜在新风险。已证明 `1.5·M + 1 < 8·M + 20` 对任意 `M ≥ 0` 恒成立，故本上界永远落在其内部，无需改动（改动它反而会扩大本轮范围）。
- 消费端不变量（`planFullTurnCompleteness` 的五类裁决、`forcedLossTieBreak` 的候选构造、UI/Tutorial 展示）**全部未改**。

---

## 8. 搜索语义未变（§5.4 逐项）

| 项 | 状态 | 证据 |
|---|---|---|
| value / mate | 不变 | 24 根逐字段一致（`PARITY_RESULTS.json`）；PLAN-1 修复前后 -972 / null |
| bound / completed / cacheable | 不变 | 同样逐字段一致 |
| TT 语义 | 不变 | `transposition.ts` sha256 仍为 `7b4aa8eb…`，未触碰 |
| alpha-beta 剪枝 | 不变 | 计划的 cap 位于搜索之外，`extractDp` 只在搜索产物上做 DP |
| 深度定义 / `depthTurns` | 不变 | 无改动 |
| Move Ordering | 不变 | 无改动 |
| H1 评价 / `evaluateForCat` | 不变 | `evaluation.ts` sha256 未变 |
| Sidecar 策略 | 不变 | `boundedPlanRefutation.ts` sha256 未变 |
| Progress Guard 策略 | 不变 | `progressGuard.ts` sha256 未变 |

**为什么"只是把 cap 变大"不会改变搜索**：`maxLength` 只出现在三个提取器的 `while (plan.length < maxLength)` 与 `extractDp` 的递归参数里，**没有任何一条搜索路径读它**。计划是搜索结果的后处理投影。

---

## 9. DP memo 身份审查（§5.3）

`extractDp` 的 memo key 只含 `graphKey + prevCatStepKey`，而 `maxLength` 沿递归递减，不同深度的路径到达同一状态时"剩余容量"不同——表面上是 memo 身份缺陷。

**证明它不构成缺陷**：`maxCatTurnPlanActions(root)` 是**从 root 出发任意合法序列长度的上界**。一条已花 k 个动作的路径，剩余容量是 `bound − k`；而 `k + (从此处往后的动作数) ≤ bound`，故 `bound − k ≥ 后续动作数`。⇒ 默认 cap 在**每条路径上都不绑定**，`if (maxLength <= 0) return []` 这行只可能被**非法序列**触发，永远不会污染合法路径上的 memo 条目；memo 因此仍是 `(state, prefix)` 的函数，无需把容量纳入 key。

参数语义照样保留：显式传短 cap 的调用方仍然得到更短的输出。默认值只是"永远不绑定的松弛量"。

---

## 10. 性能（`PERFORMANCE_RESULTS.json`，`label: DIAGNOSTIC_ONLY`）

单遍、24 个真实根、固定 D1、同进程：

| 阶段 | min | p50 | max |
|---|---|---|---|
| search | 3.631 ms | 7.561 ms | 75.605 ms |
| 提取（walk） | 0.044 ms | **0.049 ms** | 0.148 ms |
| 提取（DP） | 0.049 ms | **0.059 ms** | 0.608 ms |

提取比搜索便宜约 **3 个数量级**。计划长度上界从 8 抬到 7（默认 M=4 时实际**变小**了，8 → 7）到 14（M=9），对搜索预算没有可测量的影响。

**这不是正式 benchmark**：单遍、无重复、不构成 efficacy 权威。`MAIN_SEARCH_SEMANTIC_BUDGET = 100ms`、`TOTAL_TURN_HARD_WALL = 150ms`、`TurnDeadlineIdentity` 全部原样，本轮的改动不铸新窗口、不二次主搜索、不重领 Sidecar 预算。

---

## 11. 验收门（13 门，明细见 `CORRECTNESS_RESULTS.json`）

| 门 | 内容 | 状态 |
|---|---|---|
| PLAN-0 | 源码身份 / 工作区 / P1-ID + P1-TIME-01 保留 | PASS |
| PLAN-1 | 9 移动回合：8 动作截断复现并关闭 | PASS |
| PLAN-2 | 6 移动 / 9 动作 `TUDTUDTDD` 修复 | PASS |
| PLAN-3 | 全部提取入口共用同一上界 | PASS |
| PLAN-4 | 完整回合与 CHANCE 边界 | PASS |
| PLAN-5 | 零步放夹、回收、终止 | PASS |
| PLAN-6 | DP memo / 路径环 / 前缀上下文 | PASS |
| PLAN-7 | 默认 4 步地图 + 24 真人根 parity | PASS |
| PLAN-8 | 搜索数学与输入状态不变 | PASS |
| PLAN-9 | 共享 deadline 与 fail-closed 后处理 | PASS |
| PLAN-10 | 既有回归套件 | PASS_WITH_2_PREEXISTING_FAILURES |
| PLAN-11 | TypeScript 与 Vite 构建 | PASS |
| PLAN-12 | 资源 / 性能非回归（口径已声明） | PASS_DIAGNOSTIC_ONLY |

### 11.1 新增测试（`planTurnActionBound.test.ts`，19 tests 全通过）

- **PLAN-0（3）**：`M = 0,1,2,3,4,5,6,7,9,12` → `1,2,4,5,7,8,10,11,14,19`；异常预算 `NaN / +∞ / -3 / 0` 一律夹到 0 → 上界 1（**不**把坏状态变成看似合理的计划）；默认 4 步上界 7 < 8（定量解释缺陷为何隐藏）。
- **PLAN-1（2）**：9 移动回合返回 10 动作 COMPLETE；同一 ctx 下 `maxLength = 8` 得 8 动作 TRUNCATED、`maxLength = 1000` 得 9 动作 COMPLETE（cap 与结果的因果被隔离）。
- **PLAN-2（3）**：`TUDTUDTDD` 真规则重放全 `effective`；所有入口 9 动作；`buildCandidate` 非 null；人为删掉倒数第二条边 → 7 动作 TRUNCATED 且 `buildCandidate === null`（**fail-closed 语义未被顺手改掉**）。
- **PLAN-3（2）**：四个入口全部 COMPLETE 且与 `maxLength = 1000` 逐字相同；`previousCompletedPlan` 也超过 8。
- **PLAN-4（1）**：末步触发 CAT→MOUSE CHANCE，计划保留该 cat 动作且裁决为 `COMPLETE_CHANCE_BOUNDARY`。
- **PLAN-5（3）**：穷举 DFS 不越过上界（5 个根）；放夹不耗步、不可连放、踩回可回收；棋盘上已有陷阱可被踩回。
- **PLAN-6（3）**：确定性 + 与 cap 无关；前缀方向被区分（`DUDU` vs `DDDD`）；提取耗时 < 2s（DIAGNOSTIC_ONLY）。
- **PLAN-9（2）**：deadline 已过期时 `buildCandidate` 返回 null；同协议两次搜索 value/mate/nodes/action 完全一致。

### 11.2 穷举 DFS 上界实测（`BOUND_DFS_TABLE.json`）

12 个根形状，`exceeded` 全为 `false`，`dfsTruncated` 全为 `false`：

| 根 | M | 上界 | 实测最长合法序列 |
|---|---|---|---|
| corridor | 1 | 2 | 2 |
| corridor | 2 | 4 | 3 |
| corridor | 3 | 5 | **5**（贴界） |
| corridor | 4 | 7 | 6 |
| corridor | 5 | 8 | **8**（贴界） |
| corridor | 6 | 10 | 9 |
| corridor | 9 | 14 | **14**（贴界，7898 次访问） |
| open | 2 | 4 | 3 |
| open | 3 | 5 | **5**（贴界） |
| open | 4 | 7 | 6 |
| open | 6 | 10 | 9 |
| open（无夹库存） | 6 | 10 | 6 |

贴界出现在 M=3、5、9 —— 说明上界不是虚高的松散值，而是**紧的**（至少在若干形状上可达）。这也是"`catBaseMoves + 1` 不够"的第三个独立证据。

### 11.3 默认地图与人根 parity（`PARITY_RESULTS.json`）

24/24 根与冻结基线 `ppcId01-baseline-d1.json` **逐字段一致**（key / completed / value / mate / action / plan / ttSize），`parityAllMatch: true`。默认 4 步地图的计划行为**零变化**——因为 7 < 8，旧常量在默认地图上本来就从未绑定。

> 排查记录：首版 parity 全红（`value: -1691.76 → 175`、`action: T → U`），根因是测试从 `evaluation` 导入 `evaluateCorrectedHoleForCat`，而它实际定义在 `correctedHoleLeaf.ts`，导致叶评价静默回落（MOUSE-01 铁律）。改正导入后 24/24 一致，并补了断言防止再次静默回落。

### 11.4 回归与分诊（`logs/`）

- `regression_full.log`：**973 tests，7 failed / 961 passed / 5 skipped，79 files**，815s。
- 7 个失败全部隔离复跑（`regression_isolated.log` + 附录）：**5 个在隔离下通过**，只剩 2 个既有失败。

| 测试 | 全套 | 隔离 | 分类 |
|---|---|---|---|
| `T1E-B`（30s timeout） | FAIL | FAIL | **既有**，本轮未触碰 |
| `FLT-HV14-4`（999996 vs -1052.947） | FAIL | FAIL | **既有**（A/B 已证） |
| `HV10-E1` / `HV10-E4` | FAIL | PASS | 吞吐敏感（213.2ms vs 151.5ms 的活钟比较） |
| `HV8-C2` | FAIL | PASS | 吞吐敏感（对 100ms 预算的活钟比较） |
| `TIME-6` a / b | FAIL | PASS | 并发下主搜索提前收敛 → sidecar 未触发（`refutationTriggered=false`），**不是** deadline 身份违约；隔离 24/24 |

`FLT-HV14-4` 的"既有"有 A/B 反证：`logs/ab_flt_hv14_legacy_cap.log` 显示**旧常量 8 下同样失败**，与本轮改动无关。同理 `prefix_ab_legacy_cap.log` 记录反向 A/B：把 `maxTurnPlanActions` 临时改回 `return 8` 后，19 个新测试中 **10 个失败**（含 DFS 越界、以及与 cap 无关的断言）——证明新测试真的在测这条上界，而不是"怎么写都过"。

### 11.5 构建

- `npx tsc -b` exit 0。
- `npx vite build` exit 0（`logs/vite_build.log`，96 modules，3.89s，`dist/assets/index-BFXKA4D2.js 2,713.01 kB`）。因沙箱的 safe-delete 会拦截 `emptyOutDir` 清空 `dist/`，使用了临时 `vite.config.build-tmp.ts`（`emptyOutDir: false`），构建后已删除。

---

## 12. 最终状态块

```
PPC_P1_PLAN_STATUS              = IMPLEMENTED_AND_VERIFIED_PENDING_ADJUDICATION
SOURCE_BASELINE                 = branch ppc/p1-id-state-identity-fix @ 48eaac6c4f3801d351787696ba5876995b64e8d8
P1_ID_PRESERVED                 = YES (transposition.ts sha256 7b4aa8eb… unchanged; ID suite 35/35)
P1_TIME_01_PRESERVED            = YES (deadlineContext/hardTurnPlanner/engine untouched by this round; 24/24)
P1_TIME_02_PRESERVED            = YES (PPC-P1-TIME-02/ untouched)
LEGAL_ACTION_BOUND_PROVEN       = YES (M + 1 + floor(M/2); proof in PLAN_ACTION_BOUND_PROOF.md; DFS-consistent on 12 shapes)
NINE_STEP_PLAN_FIXED            = YES (8 "DDDDDTUU" TRUNCATED -> 10 "DDDDTUUUU" COMPLETE at M=9)
SIX_MOVE_NINE_ACTION_PLAN_FIXED = YES (4 extractors 8 "TUDTUDTD" -> 9 "TUDTUDTDD"; buildCandidate null -> 9)
ALL_EXTRACTION_PATHS_COVERED    = YES (5 extractors + all call sites; no second length cap exists in src/game)
PLAN_COMPLETENESS               = UNCHANGED (planFullTurnCompleteness untouched; 5 verdicts intact)
CHANCE_BOUNDARY_CORRECTNESS     = PASS (PLAN-4)
ZERO_COST_TRAP_CORRECTNESS      = PASS (replay table + PLAN-5; no double placement, collection costs 1 step)
DP_MEMO_CONTEXT_CORRECTNESS     = PROVEN_SAFE (bound is non-binding on every path -> memo is f(state,prefix))
DEFAULT_D1_PARITY               = 24/24 MATCH (key/completed/value/mate/action/plan/ttSize)
SEARCH_MATH_UNCHANGED           = YES
TT_SEMANTICS_UNCHANGED          = YES
DEADLINE_IDENTITY_UNCHANGED     = YES (100ms / 150ms / TurnDeadlineIdentity untouched; no new window, no re-search)
FALLBACK_BEHAVIOR               = UNCHANGED (missing successor => TRUNCATED + buildCandidate null, still fail-closed)
REGRESSION_TESTS                = 973 total, 961 PASS / 7 FAIL in full suite; 5 PASS in isolation; 2 PREEXISTING (T1E-B, FLT-HV14-4)
TYPESCRIPT_BUILD                = PASS (tsc -b exit 0)
VITE_BUILD                      = PASS (exit 0, 96 modules, 3.89s)
PERFORMANCE_GATE                = DIAGNOSTIC_ONLY (extraction p50 0.049/0.059ms vs search p50 7.561ms)
ABSOLUTE_DEADLINE_GATE          = BLOCKED (1.5x M1 gate not attempted; no efficiency authority claimed)
NEW_EFFICACY_AUTHORITY          = NONE
GAMEPLAY_CHANGE                 = NO
H1_CHANGE                       = NO
SIDECAR_POLICY_CHANGE           = NO
BUDGET_CHANGE                   = NO
MOUSE_AI_CHANGE                 = NO
HEAVY_WORKER_CONCURRENCY        = 1
SERIAL_FRESH_REPETITIONS        = TRUE
DUPLICATE_BENCHMARK_CHECK       = PERFORMED (no historical benchmark re-run; single-pass diagnostics only)
COMMIT/PUSH/MERGE               = NO
```

---

## 13. 本轮做了什么 / 没做什么

**做了**

1. 新增 `src/game/ai/planBound.ts`（唯一新生产模块，4193 bytes），承载唯一的合法上界推导。
2. 把 5 处硬编码 `maxLength = 8` 全部默认到该推导，`src/` 内不再存在计划长度常量。
3. 给出数学证明（上界紧性、5 个边界情形、终止性、memo 非绑定）。
4. 用真实引擎复现两个登记反例并关闭，附带独立构造的 10 动作合法满回合线（否证 `catBaseMoves + 1`）。
5. 新增 19 个验收测试 + 共享 fixtures（`planActionBoundFixtures.ts`）；穷举 DFS 上界表；24 根 parity；单遍性能诊断。
6. 反向 A/B 反证（临时恢复 8 → 10/19 失败），正向 A/B 反证（旧常量下 `FLT-HV14-4` 同样失败）。
7. 全套回归 + 逐项隔离分诊。

**没做（刻意）**

- 没做 Sidecar 全局预算优化（§10 明确不在授权内）。
- 没做反向评分修复、H1 改权重。
- 没改 `engine.ts:4124` 的 `maxSafety`（已证明本上界恒在其内）。
- 没动 `T1E-B` / `FLT-HV14-4` 这两个既有失败。
- 没有 commit / push / merge / reset / clean / stash。
- 没有进入 P1-QUALITY，没有跑正式重型 benchmark（20 次重复协议），没有宣告 efficacy 权威。

**明确不主张**

- 不主张"上界在所有形状上都可达"——只在 M=3、5、9 的三种形状上实测贴界。
- 不主张 150ms 平台被改善——本轮不触碰预算层，`ABSOLUTE_DEADLINE_GATE` 保持 `BLOCKED`。
- 不主张默认地图的着法有任何变化——24/24 parity 证明它**没有**变化，这也是预期结论。

---

## 14. 交付物清单

| 文件 | 内容 |
|---|---|
| `REPORT.md` | 本文 |
| `SOURCE_MANIFEST.json` | 18 个文件 sha256 + `transposition_ok: true` |
| `PLAN_ACTION_BOUND_PROOF.md` | 8 节数学证明 |
| `PLAN_EXTRACTION_CALL_GRAPH.md` | 6 节调用图 + memo 证明 + 其他长度限制裁定 |
| `BASELINE_TRUNCATION_WITNESS.json` | 修复前真实反例（PLAN-1/2/3） |
| `POSTFIX_PLAN_WITNESS.json` | 修复后同协议复测 |
| `BOUND_DFS_TABLE.json` | 12 个根形状穷举上界表 |
| `CORRECTNESS_RESULTS.json` | 13 门 + 10 条额外覆盖 + 7 条失败分诊 |
| `PARITY_RESULTS.json` | 24 根逐字段 parity |
| `PERFORMANCE_RESULTS.json` | 单遍诊断成本（DIAGNOSTIC_ONLY） |
| `logs/regression_full.log` | 973 tests 全套 |
| `logs/regression_isolated.log` | 隔离复跑 + TIME-01 附录（24/24） |
| `logs/prefix_ab_legacy_cap.log` | 反向 A/B（恢复 8 → 10 failed） |
| `logs/ab_flt_hv14_legacy_cap.log` | `FLT-HV14-4` 在旧常量下同样失败 |
| `logs/vite_build.log` | 构建 exit 0 |
| `probe/` | 取证用临时 vitest 工程（独立 config，不进仓库主套件） |
