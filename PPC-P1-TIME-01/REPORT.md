# PPC-P1-TIME-01 — Hard Cat 整回合共享绝对截止时间修复

> 结论：**IMPLEMENTED_WITH_BLOCKED_GATES**
> 代码修复与全部正确性门通过；唯一阻塞项是**缺少"整回合绝对时限权威清单"**，因此不宣称 150 ms 物理合规。

---

## 一、人话总结

**原来的错误是什么？**
`planHardCatTurn` 每次被调用时都在函数内部读一次时钟（`t0 = now()`），然后用 `t0 + 100` 当主搜索截止、`t0 + 150` 当整回合墙。所以这两个窗口是**每次调用**的窗口，不是**每个回合**的窗口。猫的一个回合里，如果计划为空/被截断/动作非法，`computeCatAiTrajectory` 会退到 `catAiMove`，而 `catAiMove` 的 Hard 分支**先重新进规划器**再谈启发式兜底 —— 于是每剩一步就重新领一份完整的 100ms / 150ms。默认 4 步的回合最多能领 `1+4 = 5` 份。修复前实测：完整计划 1 次规划、短计划 4 次、空计划 5 次、非法计划 5 次，而且每一次都拿到了**互不相同**的自铸截止时间。

**改了什么？**
把"预算所有权"从**单次规划调用**提升到**完整猫回合**。新增 `TurnDeadlineIdentity`：一个回合开始时由 `computeCatAiTrajectory` **只读一次时钟**，铸出 `T0` / `T0+100` / `T0+150` 三个绝对量，然后把**同一个对象按引用**传给它这一回合的每一次规划调用。`catAiMove` 多了一个可选参数承接它：主窗口一旦关闭，就直接走 `catAiHard` 启发式，**不再开启新的搜索**。

**真实反例是否关闭？**
关闭了。同样的 stub 构造、同样的 7×7 地图、同样的四种计划：调用阶梯**完全没变**（1/4/5/5），但每一次调用拿到的 `startedAt` / 主截止 / 总截止都**只剩 1 个不同值**（修复前是 1/4/5/5 个）。

**默认地图猫 AI 是否保持原样？**
保持。24 个真人根在固定 D1 下，**带不带身份**都与修复前现场捕获的基线工件**逐字段相同**（value / mate / 深度 / plan / bestAction / rootActions / 节点数 / TT 命中 / 剪枝数 / phase）。默认随机地图的状态键也没有任何变化。

**有无明显性能退化？**
没有。24 个真实回合里规划器**每回合只被调用 1 次**；一个真实根（G1T1）真的触发了修复：`no_hard_plan` 之后连打 4 次 `turn_main_window_closed`，规划 1 次而不是 5 次。

**有没有影响游戏规则？**
没有。移动 / 推箱 / 传送 / 夹子 / 黄油幽灵 / RULE-A / RULE-B / 评价 / 搜索数学 / 100·150ms 常量 / 鼠 AI 全未改动。**"AI 没时间搜"与"猫真的没路可走"依旧严格分开**：前者走 `forceCatMoveTowardsMouse` 的合法移动，后者才由 `applyNoMoveLoss` 判负。

---

## 二、正确性结果（TIME-0 … TIME-10）

| 门 | 结果 | 一句话证据 |
|---|---|---|
| TIME-0 来源与隔离 | **PASS** | P1-ID 候选 `7b4aa8eb…` 与两个冻结 fixture 哈希未变；D1 工件未重生成 |
| TIME-1 原缺陷可复现 | **PASS** | 修复前：1/4/5/5 次调用，15 次调用全部 `receivedAbsoluteDeadline=false`，自铸截止时间各不相同 |
| TIME-2 共享时间身份 | **PASS** | 闭窗（1100）→ 0 节点 0 计划；开窗（1070）→ 允许搜索；引擎级闭窗 → 规划器仅 1 次 |
| TIME-3 四种 fallback | **PASS** | 阶梯仍是 1/4/5/5，但每场景 `distinctInheritedMain/Total/Start = 1` → `NO_DEADLINE_REGRANT = TRUE` |
| TIME-4 正常路径 parity | **PASS** | 24 根 D1，带/不带身份，与修复前工件**逐字段相等** |
| TIME-5 真实规则回放 | **PASS** | 4 步 / 6 步 / 零步放夹 / 无瞬移 / 中途抓捕合法收尾（覆盖范围见表下注） |
| TIME-6 Sidecar 与 Guard | **PASS** | 两者 `deadlineAtMs` 相同，且是**同一个对象**（`toBe`），partialCommitCount=0 |
| TIME-7 状态隔离 | **PASS** | 输入不被污染；state 里查不到任何 deadline 字段；每回合新铸新窗口 |
| TIME-8 无截止时间路径 | **PASS** | 不传身份时仍自铸窗口（`budgetMs=100`），NO_DEADLINE 不多读一次时钟 |
| TIME-9 既有回归 | **PASS** | 19 文件 361 通过 / 4 跳过 / 1 失败，失败项为**基线可复现的预存** `T1E-B` 30s 超时 |
| TIME-10 构建 | **PASS** | `tsc -b` exit 0；`npm run build` exit 0（5.96s） |

**TIME-5 的覆盖边界（不夸大）**：本轮新测试直接验证了"正常 4 步 / `catBaseMoves=6` / 零步放夹 / 每步一次正交移动且恰好消耗一步 / 中途抓捕后停止消耗步数 / 回合结束仍是 Playing"。推箱、传送通道封锁、幽灵黄油时序、RULE-A 终局这四项由既有套件覆盖（`productionGhostRuleSet`、`ghostButter`、`ghostButterEdge`、`hardIntegration` 全部通过），本轮**没有**为它们新写断言——因为时间管道不可能改变这些规则分支，新增断言只会重复既有证据。

### 一个必须承认的测试改动

`catAiMove` 在闭窗分支会写一条 `SEARCH_FALLBACK reason=turn_main_window_closed`，但**如果 `catAiHard` 自己返回 `null`（这个位置它没找到移动），这条日志会随返回值一起丢掉**，轨迹层随后用 `forceCatMoveTowardsMouse` 兜底。这是**修复前就存在**的行为（空计划时 `catAiMove` 本来就返回 `null`），所以我没有为了"让日志好看"去改返回语义 —— 那会改变 `catAiMove` 对外"成功返回 = 动过"的含义。

因此在 **7×7 小图上**这条日志不可观测，测试改为断言**规划器调用次数 = 1**（这才是本质证据）。在**真实冻结根 G1T1** 上日志正常出现（见性能数据），说明这条路径在真实局面下是可见的。

---

## 三、实际改动

```
branch      ppc/p1-id-state-identity-fix   (HEAD 仍 48eaac6，未新增 commit)
HEAD        48eaac6c4f3801d351787696ba5876995b64e8d8
baseline    P1-ID 候选工作树（transposition.ts = 7b4aa8eb…）

生产源码（本轮，3 个文件 +231 / −15）：
  src/game/ai/deadlineContext.ts    +99 / −1   TurnDeadlineIdentity + makeTurnDeadlineIdentity
                                              + mainSearchWindowOpen + 导出单调时钟 monotonicNow
  src/game/ai/hardTurnPlanner.ts    +55 / −8   HardTurnPlanOptions.turnDeadline；继承绝对截止
  src/game/engine.ts                +77 / −6   computeCatAiTrajectory(state, now) 铸身份并贯穿；
                                              catAiMove(state, turnDeadline?) 闭窗即兜底

携带（未改动）：
  src/game/ai/transposition.ts                P1-ID 候选，字节不变

新增测试（2 个，24 用例）：
  src/game/ai/__tests__/hardTurnAbsoluteDeadline.test.ts        13
  src/game/ai/__tests__/hardTurnAbsoluteDeadlineEngine.test.ts  11

新增 fixture：
  src/game/ai/__tests__/fixtures/ppcTime01-baseline-planner.json   修复前 24 根 D1 工件
  PPC-P1-TIME-01/fixtures/ppcTime01-baseline-fallback-reentry.json 修复前 1/4/5/5
  PPC-P1-TIME-01/fixtures/ppcTime01-postfix-fallback-shared.json   修复后 1/4/5/5 + 唯一窗口

git diff --stat（含携带的 P1-ID）：
  src/game/ai/deadlineContext.ts |  99 +++++-
  src/game/ai/hardTurnPlanner.ts |  55 +++--
  src/game/ai/transposition.ts   |  44 +++-   ← P1-ID，本轮 0 改动
  src/game/engine.ts             |  77 +++--
  4 files changed, 260 insertions(+), 15 deletions(-)
```

`纸制版作业-…第二次.doc` 全程未打开、未移动、未提交。无 commit / push / merge / rebase / reset / clean / stash。

---

## 四、性能与时间证据

**这不是一次正式 benchmark，只是有界诊断**：24 个冻结根，每根跑**一个**真实回合，单进程串行，不重复、不并行。

```
turn wall (ms)   min 106.65 / p50 150.57 / p95 153.15 / p99 196.83 / max 196.83
planner calls    全部 24 回合均为 1 次
fallback 回合    1 个（G1T1）
search core      100.69 – 144.60 ms（同一批回合内）
```

**15/24 回合的物理墙超过 150ms**，超出量 0.36–3.15ms（G1T1 除外：196.83ms，因为它把 4 步启发式移动也走完了）。这必须如实报告：**截止时间是"软"停止**，每 64 个内部节点采样一次，同步区段不可抢占；移动执行、侧车探针、记账都在回合内发生且不可中断。**"预算不重复领取"不等于"物理时间永不超 150ms"**。

真实根 G1T1 是本次修复最好的现场证据：

```
SEARCH_FALLBACK reason=no_hard_plan completedDepth=0 attemptedDepth=1
SEARCH_FALLBACK reason=turn_main_window_closed …   ×4
planner invocations = 1        （修复前该形状为 5）
```

### 阻塞项

```
ABSOLUTE_DEADLINE_AUTHORITY = BLOCKED_MISSING_MANIFEST
ABSOLUTE_DEADLINE_GATE      = BLOCKED
```

仓库里只有两个**更窄**的测量域权威：`M1 = SEARCH_CORE_MS`（P95 120 / P99 125 / MAX 150）与 `M2 = PLANNER_CALL_WALL_MS`（P95 165 / P99 190 / MAX 225），来自 `r1_amend_timing_contract.json` / `r2_timing_thresholds.pre.json`。**没有**任何冻结清单定义"一个完整猫回合"的统计量、协议和门槛。本轮没有把 M2 的 225ms 借来当回合宽限，也没有加 5ms/10ms 人情宽限。

---

## 五、只登记、未修复（按任务要求）

1. `catTurnPlan maxLength=8` 导致的合法计划截断。
2. 反向评分漏边。
3. H1 对近洞黄油、传送与陷阱资源价值的潜在误判。
4. Prepared Transition 后继复用优化。
5. 全配置状态 identity 的独立证明。
6. 编辑器通道及鼠洞几何合同冲突。
7. 鼠 AI（PAUSED）。
8. 训练 / WASM / 新搜索架构。

本轮唯一用到 `maxLength=8` 的地方是"短计划触发 `plan_exhausted`"，上限本身未动。

---

## 六、机器状态块

```text
PPC_P1_TIME_STATUS = IMPLEMENTED_WITH_BLOCKED_GATES

P1_ID_CANDIDATE_PRESERVED = TRUE   (7b4aa8eb…, byte-identical)
SOURCE_IDENTITY            = 48eaac6c4f3801d351787696ba5876995b64e8d8 (+ P1-ID candidate worktree)
BASELINE_REGRANT_REPRODUCED = TRUE (1/4/5/5 calls, 0 absolute deadlines, distinct windows per call)

TURN_DEADLINE_SINGLE_OWNER        = TRUE
MAIN_SEARCH_DEADLINE_NOT_REBASED  = TRUE
TOTAL_TURN_DEADLINE_NOT_REBASED   = TRUE
FALLBACK_NO_NEW_FULL_BUDGET       = TRUE
SIDECAR_GUARD_DEADLINE_SHARED     = TRUE  (same object, asserted by identity)

NORMAL_PLAN_PARITY   = PASS  (24 roots, with and without identity, byte-identical)
REAL_ENGINE_REPLAY   = PASS  (4/6 moves, zero-cost trap, capture, no teleport)
NO_DEADLINE_PARITY   = PASS
STATE_IMMUTABILITY   = PASS
REGRESSION_TESTS     = PASS  (361 pass / 4 skip / 1 pre-existing failure: T1E-B timeout)
TYPESCRIPT_BUILD     = PASS
VITE_BUILD           = PASS

REAL_TURN_TIMING_EVIDENCE = DIAGNOSTIC_ONLY (n=24; p50 150.57 / p95 153.15 / max 196.83 ms; planner calls = 1)
ABSOLUTE_DEADLINE_GATE    = BLOCKED  (BLOCKED_MISSING_MANIFEST)

GAMEPLAY_CHANGE         = NO
H1_CHANGE               = NO
SEARCH_MATH_CHANGE      = NO
P1_ID_SOURCE_CHANGE     = NO
BUDGET_PARAMETER_CHANGE = NO
MOUSE_AI_CHANGE         = NO

HEAVY_WORKER_CONCURRENCY     = 1
SERIAL_FRESH_REPETITIONS     = TRUE
DUPLICATE_BENCHMARK_CHECK    = PASSED (no concurrent node/heavy job; only WorkBuddy infra processes)

COMMIT = NO
PUSH   = NO
MERGE  = NO

RECOMMENDED_VERDICT = IMPLEMENTED_WITH_BLOCKED_GATES
```

---

## 七、工件清单

```
PPC-P1-TIME-01/
  REPORT.md                    ← 本文件
  CALL_GRAPH.md                ← 修复前/修复后调用图 + §5.1 八问逐条回答
  DEADLINE_CONTRACT.md         ← 权威参数、合同正文、非保证项、权威缺失说明
  SOURCE_MANIFEST.json         ← 文件级身份（基线 blob / 候选 SHA-256 / fixture 哈希）
  CORRECTNESS_RESULTS.json     ← TIME-0..TIME-10 逐门证据
  TIMING_RESULTS.json          ← 24 回合真实耗时诊断（逐根原始数据）
  fixtures/
    ppcTime01-baseline-fallback-reentry.json   修复前 1/4/5/5，0 个绝对截止
    ppcTime01-postfix-fallback-shared.json     修复后 1/4/5/5，每场景 1 个绝对截止
  probe/
    vitest.config.mts          独立 vitest 配置（仓库 config 只收 src/**）
    capture_baseline.test.ts   修复前捕获（拒绝覆盖，需 PPC_P1_TIME_FORCE=1）
    capture_postfix.test.ts    修复后同构捕获
    timing_diagnostic.test.ts  24 回合耗时诊断
  logs/
    time_acceptance_v1/v2.log  规划器级验收（v1 4 失败 → v2 13/13）
    time_engine_v1/v2/v3.log   引擎级验收（v1 2 失败 → v3 11/11）
    time_new_tests_final.log   两组新测试 24/24
    time9_regression.log       TIME-9 既有回归
    time9_flt_hv14.log         FLT-HV14 预存失败复核
    time10_build.log           npm run build
```
