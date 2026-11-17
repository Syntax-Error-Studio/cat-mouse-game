# PPC-D2-PCV-COUNTERLINE-01 — 报告

- 轮次类型：`OFFLINE RESEARCH / SOURCE AUDIT / D2 PILOT`
- 实际完成：**G0 + G1（只读）**
- 实际未进入：G2 / G3 / G4 / G5
- 原因：资源准入 `FAIL`，且同工作区存在**他人轮次的并发 vitest 重基准**
- 生产隔离：`src/`、`GAMEPLAY.md`、H1、100ms/150ms 全部未动

---

## 一、人话总结

这轮没能跑 D2。

不是因为代码不行，是因为**这台机器现在不够用**：开跑前要求空闲物理内存 ≥ 4096 MB、
空闲提交内存 ≥ 8192 MB，实测分别是 **755 MB** 和 **4957 MB**，五次采样没有一次达标。
任务书写得很清楚——不达标就只做只读审计然后停，不许扩 pagefile、不许加 V8 heap、
不许靠提并发硬闯。我照做了。

（做完审计再测一次时，提交内存回升到 8298 MB 越过了门槛，但**物理内存只有 1815 MB**，
仍是门槛的 44%；五项采样里物理内存最高只到 2094，从没接近过 4096。
所以真正的绑定约束是物理内存，不是等一会儿就能过的事。原始数据在 `logs/` 里。）

还有一件事必须先说：工作区里**现在正跑着一个不是我发起的 vitest 重基准**
（`PPC-MCTS-01B`，三个进程，worker 从 155 MB 涨到 315 MB，跑完一轮又换了新 PID 继续）。
它不是本轮的东西——今天的工作记忆里记着 `PPC-MCTS-01` 已完成、"下一步等复核进 01B"，
所以这是**兄弟轮在推进**，不是僵尸。我没有动它——任务书禁止杀无关进程。
但它同时意味着：就算内存侥幸达标，任务书 §8 也禁止"同时跑多个后台重型任务"。
所以这是两道独立的红线，不是一道。

在停之前我把该读的源码读完了，结论对新一轮有用：
**D2 固定深度这个入口本身是干净的**（`searchBestAction(state, 2, ctx)`，不迭代、不回滚、
`completed`/`mate`/`rootValues` 都留得住）。但有两个**必须先知道**的陷阱：

1. **`rootValues` 里没有 `completed` 字段，而且被预算截断的节点 `bound` 仍然写 `'exact'`。**
   所以任务书要求的 `ALL_ROOT_BOUNDS_EXACT = TRUE` **单独不能证明精确**。
   在关闭 Alpha-Beta 的配置下，`bound` 恒等于 `'exact'`，是个常量，不是判据。
   真正的判据是 `result.completed === true` 且 `budgetCutoffs === 0` 且 `deadlineCutoffs === 0`。

2. **`planBranches` 只用 `stateKey` 做键，没有深度、没有"属于哪个根动作"的标记。**
   同一个文件里 `equalPrimaryGraph` 用的是 `stateKey + "\x00" + depthTurns`——说明作者知道要
   加深度判别，但计划表没加。后果是：根节点那条记录只是**全局唯一最佳首着**，
   拿它当每个根动作的计划用，正是任务书点名禁止的那种冒充。

好消息是：我论证清楚了在**严格配置**（无 TT/无 AB/无排序/无扩展）下，
D2 的猫回合与鼠回合内部**任何状态都不可能重复**（步数/黄油/trap 这些身份分量在回合内单调），
所以重复守卫打不到，节点值与路径无关，同键多次写入必然写同一个动作 ⇒ 分支日志实际上是规范的。
**这个论证是源码级的，但没有实测**——而任务书的 §4.3 停止条款要求先测再说。
本轮因为资源不合格没测，所以我把分支提取可靠性标成 `PROVISIONAL / BLOCKED`，
按规程交给你和 ChatGPT 裁决，而不是自己往下推。

一句话：**本轮 = 身份全绿、资源全红、合同审计完成、D2 一个节点都没跑。**

---

## 二、技术裁决（逐条回答 §12 的 11 个问题）

**1. D2 固定深度是否真正完整完成？**
`NOT_PERFORMED`。没有启动任何 D2 搜索。源码层面确认存在正确入口
（`searchBestAction(state, 2, ctx)`，`expectiminimax.ts:2001`），且它不是迭代包装器；
但"完成了"这件事本轮**没有任何运行证据**，不写 `TRUE`。

**2. 是否覆盖全部合法根动作？**
`NOT_PERFORMED`。审计了覆盖机制：`rootValues` 只在 `ply === 0` 写（`:1342`），
遍历全部 `prepared`（排序关闭时 = 合法动作原始顺序），所以**结构上覆盖全部根动作**。
但没有任何一次运行验证。

**3. 是否成功提取每个根动作对应的完整猫回合计划？**
`NOT_PERFORMED`。机制存在：`buildPlanForFirstAction`（`planQuality.ts:306`）+
`buildCandidate`（`:365`）+ `planFullTurnCompleteness`（`:225`）。
但审计发现 **4 个静默拒绝分支**会返回空计划/`null`（`:320` `:323` `:324` `:342`），
调用方若只收非 null 就会**无声丢掉合法根动作**——任务书 §6 明令禁止。
新一轮必须把这些单独计成 `PLAN_IDENTITY_FAILURES`，不能一句 `buildCandidate === null` 带过。

**4. D2 principal mouse counterline 是否完整？**
`NOT_PERFORMED`。且审计出一条**能力缺口**：
源码里只有 `buildCatTurnPlan`（`:1926`）与猫侧提取器，**没有鼠回合的走链器**。
鼠侧必须在新目录里新写，不能改生产文件。
另外 `planFullTurnCompleteness` 是猫专用的，鼠回合没有对等的完整性认证器。
所以"完整"这个词本轮无法建立，且下一轮也不是开箱即得。

**5. 是否发现多结果 CHANCE？**
`NOT_PERFORMED`（无运行）。但源码给出**结构性保证**：
CHANCE 节点把每个 outcome 都用**全窗口**独立搜索（`:1533–1541`），
每个 outcome 状态各自落分支条目 ⇒ 多结果分支**天然可枚举**，不会被折叠成单结果。
`buildCandidate` 还强制校验权重和 = 1（容差 `1e-6`，`:363` `:420`）。
这正好支撑任务书"不得只保留一个结果"的要求——机制上做得到。

**6. 候选是否全部真实回放成功？**
`NOT_PERFORMED`。`CANDIDATES_FROZEN = 0`。

**7. H0 有多少有效反证？**
`NOT_PERFORMED` / 0。未运行 H0。

**8. H1 有多少有效猫存活证明？**
`NOT_PERFORMED` / 0。未运行 H1。

**9. 是否出现真正的战术救援？**
**无证据，不得声称。** 本轮既没有反证也没有救援，任何方向的结论都无依据。

**10. 成本、节点、RSS、heap 和重复结果如何？**
- `D2_NODES`：无（未搜索）。
- 本轮进程开销：python 单进程 < 30 MB，PowerShell 采样 < 80 MB，秒级退出。
- 无 OOM、无页面文件耗尽、无重试、无 Rep1/Rep2（未进入证明阶段）。
- 机器侧：已提交 29.3 / 33.4 GB（87%），页面文件已用 3044 MB，进程 349 个。

**11. 当前试点是否值得扩展剩余 7 个 strata？**
**现在不能回答，也不该回答。** 本轮连 1 个 stratum 都没跑；
在没有任何 D2 节点数、没有一次 H0/H1 运行的情况下谈"扩不扩"，等于凭空决策。
顺序应该是：先解资源 → 再跑 G1T9/E1 单根 → 拿到 `D2_NODES` 与 `CHANCE` 实况 →
才谈扩展。任务书本身也把 `FULL_8_STRATA_BATCH` 标成 `NOT_AUTHORIZED`。

---

## 三、本轮真正的产出：三条可执行的源码结论

### 结论 A — `ALL_ROOT_BOUNDS_EXACT` 这个判据是坏的，必须换
`expectiminimax.ts:1726` / `:1749` 在预算/deadline 截断时返回 `bound:'exact'` + `completed:false`；
而 `useAlphaBeta === false` 时 `cutOff` 恒 `false`（`:1418`/`:1449`），`bound` 恒 `'exact'`。
⇒ 关闭 AB 的配置里，`bound` **不携带信息**。
替换判据：

```text
SEARCH_COMPLETED        = result.completed === true
NO_BUDGET_TRUNCATION    = diagnostics.budgetCutoffs === 0
NO_DEADLINE_TRUNCATION  = diagnostics.deadlineCutoffs === 0
NO_EXTENSION_ABORT      = diagnostics.extensionAbortCount === 0
ROOT_ACTION_COUNT_MATCH = ctx.rootValues.length === legalRootActionCount
```

### 结论 B — `planBranches` 可证，但需要两条实测前提，缺一不可
1. `diagnostics.repetitions === 0`（证明回合内无重复，值对路径无关）；
2. `TrackedBranches` 观测到"同键多次写入冲突数 = 0"（证明后写胜无害）。

现成手法已经存在，不必重新发明：
`forcedLossTieBreakContract.test.ts:690–729`（冲突计数）
与 `hv14FiveGameForensics.test.ts:594–628`（冲突 + `firstWins` vs 后写胜是否改变最终计划）。
**但那两组是 D1 规模（或 3 个根）的证据，不能外推到 D2。**
这两条没测 ⇒ 分支提取可靠性 `PROVISIONAL` ⇒ 按 §4.3 停下来等裁决。

### 结论 C — 一个配置陷阱
`createSearchContext` 不会设 `capturePlan`（`:829`），也**不会**自动设 `leafEvaluator`：
不显式注入就静默用 `defaultLeafEval`（`:924`，200−5·曼哈顿−60·黄油）。
所以 E1 臂必须**在调用搜索前**手工做两件事：

```ts
ctx.capturePlan = true;
ctx.leafEvaluator = evaluateForCat;
```

少任何一条，都会得到"看起来跑完了但拿错东西"的结果。

---

## 四、下一步（需要用户 / ChatGPT 决策，本轮不做）

三件事，按顺序：

1. **解资源**。当前 `FREE_PHYS` 需要从 ~0.75 GB 提到 ≥ 4 GB，
   `FREE_COMMIT` 从 ~4.9 GB 提到 ≥ 8 GB。本机 16 GB 物理内存 + 已提交 29.3 GB，
   靠关掉几个浏览器标签未必够。这一步的决策权在你。
2. **处置 `PPC-MCTS-01B` 的并发 vitest**。要么等它跑完再开本轮，要么确认它是废弃进程。
   我没有动它。
3. **重跑 preflight**，达标后才有资格谈 G2。

若 ChatGPT 认为"结论 A/B/C 已足够、可以放宽资源门"或"允许串行化在另一个会话里跑"，
那是新指令，本轮不擅自解释为许可。

---

## 五、交付物清单（本轮实际产出）

```text
PPC-D2-PCV-COUNTERLINE-01/
  SOURCE_AND_IDENTITY_AUDIT.md   G0：身份 / 资源 / 重复任务 / 并发 worker
  D2_SEARCH_CONTRACT.md          G1：4.1–4.4 逐项源码合同审计（含行号）
  PHASE_STATUS.json              机器可读闸门状态（null = NOT_PERFORMED）
  REPORT.md                      本文件
  RESOURCE_SAFETY_LOG.md         资源与只读边界
  SOURCE_MANIFEST.json           身份 + 输入 + 产出登记（不含自身哈希）
  SHA256SUMS.txt                 本目录摘要（不含自身）
  probe/d2_pilot_preflight.py    G0 身份核验脚本（只读、可复跑）
  probe/resource_snapshot.ps1    G0 资源与并发快照脚本（只读、可复跑）
  probe/emit_manifest.py         清单与校验和生成器（含两条自指排除规则）
  logs/preflight_identity.json   身份核验原始输出
  logs/postflight_identity.json  完成时身份复核（证明生产源码未变）
  logs/resource_preflight.txt    资源与并发快照原始输出
  logs/resource_postflight.txt   完成时资源快照
```

任务书 §10 建议的 `D2_PILOT_CANDIDATES.json`、`D2_PILOT_PROOF_REP1/2.json`、
`CANDIDATE_FREEZE.json`、`D2_PILOT_MATRIX.csv` **一律未创建**——
它们对应的阶段没有执行，凭空建空文件会让后续读者误判"跑过但没结果"。

```text
COMMIT = NO      PUSH = NO      MERGE = NO
PRODUCTION_WIRING = NO
STOP_FOR_CHATGPT_REVIEW = TRUE
```
