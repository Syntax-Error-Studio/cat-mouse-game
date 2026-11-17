# 四轮集成 diff 审计

本轮**不修改任何生产源码**。本文只做三件事：锁定四轮各自的准确边界、给出累积影响面、列出交叉处看到的缺口（只记录，不修）。

---

## 1. 来源锁定

仓库 `F:\小猫小鼠`，分支 `ppc/p1-id-state-identity-fix`，HEAD `48eaac6c4f3801d351787696ba5876995b64e8d8`（自 P1-ID 起未变，本轮 0 commit）。

### 1.1 七个冻结候选（磁盘实测 = 任务书预期前缀）

| 文件 | 实测 SHA256 | 字节 | 归属轮次 |
|---|---|---|---|
| `transposition.ts` | `7b4aa8eb3fab994a4abc77fdf38800ab2a5f9da57d5eb33a1b37075e106c2d64` | 6784 | P1-ID-01 |
| `deadlineContext.ts` | `ced449445d70d1ba88cb20d88415b3c641d670aa886536fcacefa36b4aa50235` | 14411 | P1-TIME-01 |
| `hardTurnPlanner.ts` | `27b1ce6dc62234d0c822b2b0b6341205ac189b5f76d7662a5d29d9e17ded75ff` | 36060 | P1-TIME-01 |
| `engine.ts` | `dbb5377af22a6471e31c899f9debe896e9e74a629f4fb50a47753bd492810f3e` | 188461 | P1-TIME-01 |
| `planBound.ts` | `99c269f90e3d7a10abaf389d95ad25d14f586a05dc1899d439834064ae3bfcfd` | 4193 | P1-PLAN-01（新文件） |
| `expectiminimax.ts` | `42b6e71f0cf784c7072a4e11abb3408b7c922d9e8a746a787ddf0046b3917d1c` | 107383 | P1-PLAN-01 |
| `planQuality.ts` | `f97dd2045733e1aa70abe6750299c00aff70f8152d6157d88acdec813c7b4cd2` | 28873 | P1-PLAN-01 → P1-QUALITY-01 |

七个前缀与任务书**全部一致**。

### 1.2 manifest 交叉核对（30 条 path+sha 声明）

把四份 `SOURCE_MANIFEST.json` 里所有 `path`/`sha256`（含 `p1IdCandidate`）逐条与磁盘比对：

```
MATCH 28 / 30；DIVERGE 0；SUPERSEDED 2
```

两条 SUPERSEDED 都是**时序覆盖**，不是不一致：

| 文件 | 旧声明 | 现磁盘 | 解释 |
|---|---|---|---|
| `planQuality.ts` | `c777b1bc…`（PLAN-01） | `f97dd204…` | QUALITY-01 在其上继续修改，符合预期 |
| `expectiminimax.ts` | `9b976ec9…`（TIME-02，标注 "UNMODIFIED since baseline"） | `42b6e71f…` | PLAN-01 之后才修改，TIME-02 当时确实未改 |

### 1.3 一个 manifest 缺口（登记）

**`PPC-P1-ID-01/` 没有 `SOURCE_MANIFEST.json`**，只有 `REPORT.md` + `logs/` + `perf/`。该轮的 `transposition.ts` 指纹只能从两处互相印证：

- `PPC-P1-ID-01/REPORT.md` 第 27 行：候选 `7b4aa8eb…`，baseline `2eea65ff…`（`git show HEAD:`）= 实测一致；
- `PPC-P1-TIME-01/SOURCE_MANIFEST.json` 的 `p1IdCandidate.sha256` = `7b4aa8eb…` = 实测一致。

⇒ 结论不受影响，但**四轮里唯一缺 manifest 的正是第一轮**，后续若要打包 checkpoint，应补一份。

### 1.4 历史工件保全

| 工件 | SHA256 | 状态 |
|---|---|---|
| `fixtures/ppcId01-human-roots.json` | `1a59787a…`（264328 B） | 未被本轮触碰 |
| `fixtures/ppcId01-baseline-d1.json` | `80635906…`（42327 B） | 未变 |
| `fixtures/ppcTime01-baseline-planner.json` | `2c1bab71…` | 未变 |
| `PPC-P1-TIME-01/TIMING_RESULTS.json` | `74ff5aff…` | 未被覆盖 |
| `ai-training/human-logs/PPC-HV14/*_H1.txt`（5 份） | 与测试内 `LOG_SHA256` 表逐份相同 | 未变 |
| `纸制版作业-…-第二次.doc` | `505bd083d753adde9c0e41362a175f0aec8dd806444601e9951526350006b626`，89600 B，mtime `2026-10-16 20:50:04` | **未触碰** |

### 1.5 工作树状态（不得表述为 clean）

`git status --porcelain` 实测：**10 个已跟踪文件 M + 17 条未跟踪条目**。

```
M  src/game/ai/deadlineContext.ts                    +97  -2
M  src/game/ai/expectiminimax.ts                      +5  -1
M  src/game/ai/hardTurnPlanner.ts                    +48  -7
M  src/game/ai/planQuality.ts                        +89 -17
M  src/game/ai/transposition.ts                      +43  -1
M  src/game/engine.ts                                +72  -5
M  src/game/ai/__tests__/hv14FiveGameForensics.test.ts        +22  -3
M  src/game/ai/__tests__/hv2PlanTieQuality.test.ts            +24 -20
M  src/game/ai/__tests__/m3liteHumanValidationLogging.test.ts   +8  -3
M  src/game/ai/__tests__/progressGuard.test.ts                +29  -5
?? PPC-P1-ID-01/ PPC-P1-TIME-01/ PPC-P1-TIME-02/ PPC-P1-PLAN-01/ PPC-P1-QUALITY-01/ PPC-P1-CLOSURE-01/
?? src/game/ai/__tests__/{hardTurnAbsoluteDeadline,hardTurnAbsoluteDeadlineEngine,planReversalAccounting,planTurnActionBound,stateIdentityCollision}.test.ts
?? src/game/ai/__tests__/planActionBoundFixtures.ts
?? src/game/ai/planBound.ts
?? src/game/ai/__tests__/fixtures/{ppcId01-baseline-d1,ppcId01-human-roots,ppcTime01-baseline-planner}.json
?? 纸制版作业-先打印好-后在纸上做作业-第二次.doc
```

全部 17 条都在 P1-ID 时已存在或被后续轮次追加，`PPC-P1-CLOSURE-01/` 是本轮新增，无其他意外条目。

---

## 2. 逐文件 HEAD → 当前 归因

`git show HEAD:<file>` 的 blob sha256 与当前值对照，确认每个文件的改动归属：

| 文件 | HEAD blob | 现在 | 改它的轮次 |
|---|---|---|---|
| `transposition.ts` | `2eea65ff` | `7b4aa8eb` | **P1-ID-01** |
| `deadlineContext.ts` | `dfab888b` | `ced44944` | **P1-TIME-01** |
| `hardTurnPlanner.ts` | `71c845b6` | `27b1ce6d` | **P1-TIME-01** |
| `engine.ts` | `ed72d0c9` | `dbb5377a` | **P1-TIME-01** |
| `expectiminimax.ts` | `9b976ec9` | `42b6e71f` | **P1-PLAN-01**（仅 `buildCatTurnPlan` 默认 cap，+5/−1） |
| `planQuality.ts` | `16a9894d` | `c777b1bc` → `f97dd204` | **P1-PLAN-01** 然后 **P1-QUALITY-01** |
| `planBound.ts` | （HEAD 无此文件） | `99c269f9` | **P1-PLAN-01**（新增 4193 B） |

每个生产文件**只有一个（planQuality 两个）责任轮次**，没有"同一处被两轮各改一半"的情况。

### 2.1 累积改动的真实规模

```
6 个生产文件（已跟踪）+ 1 个新生产文件 = 7 个生产工件
已跟踪生产改动：+354 / -33 行；另有 planBound.ts 全新 4193 B（~81 行）
测试：4 个既有文件改动 + 6 个新测试文件 + 3 个 fixture
```

其中注释占相当比例（`planBound.ts` 43 行里有 53 行注释段落、`planQuality.ts` 的新增块大半是合同说明）。**实际算法改动只有四处**：

1. `transposition.ts`：`cell.type[0]` → `terrainKeyCode(cell.type)`（穷尽 switch，9 个字符码）；
2. `planQuality.ts`：反向总数改为唯一出处 `countPlanReversals(prefix, plan)`；
3. `planBound.ts`：`M + 1 + floor(M/2)` 唯一上界，四处默认值改用它；
4. `deadlineContext/hardTurnPlanner/engine`：一个 cat 回合只铸造一次绝对时限身份，并贯穿全部 fallback。

---

## 3. 交叉边界复核（七项，逐项给结论）

### 3.1 新状态身份是否贯穿计划提取

**是。** `planQuality.ts` 的 plan 提取用 `stateKey(state)` 作 memo key 与 path guard，`stateKey` 来自 `transposition.ts`，P1-ID 只换了地形编码字符、**没有改 key 的分量集合**（18 分量不变）。

实测校验：HV14 全 45 根 `stateKey(restored) === loggedStateKey` **全部成立**（`_raw/hv14_all_roots.json` 的 `identityOk=true`），key 长度 379，与 HEAD 版在默认地图上逐字节相同（`_raw/statekey_micro.json` 两臂 `keyLength` 均 379）。

**边界（登记，非缺陷）**：编码只在 `trap`（`t`→`r`）和 `butter_spot`（`b`→`u`）两种地形上与原实现不同。默认随机地图不含这两种地形，所以默认地图 key 不变；但**若某个历史工件里嵌着一张含 `trap`/`butter_spot` 地形的 `stateKey` 字符串，它与新实现不再相等**。本轮在 45 个 HV14 根与 24 个人类根中未发现此类工件（全部匹配）。这条限制应写进 P1-ID 的结论边界。

### 3.2 共享 deadline 是否覆盖全部 fallback 路径

**是（限于 `computeCatAiTrajectory` 这条生产入口）。**

生产调用图（排除测试）：

```
src/pages/GamePage.tsx:204   computeCatAiTrajectory(catState)
  └─ engine.ts:4047          makeTurnDeadlineIdentity(...)        ← 唯一铸造点
      ├─ engine.ts:4062      首次 planHardCatTurn({ turnDeadline })  ✔
      └─ 循环内三处 fallback
          ├─ engine.ts:4150  plan_action_invalid  → catAiMove(current, hardTurnDeadline)
          ├─ engine.ts:4167  plan_exhausted       → catAiMove(current, hardTurnDeadline)
          └─ engine.ts:4169  其他                 → catAiMove(current, hardTurnDeadline)
                                    └─ engine.ts:3906  planHardCatTurn({ turnDeadline })  ✔
                                    └─ engine.ts:3894  窗口已关 → 直接 catAiHard（不搜索）  ✔
```

三处 fallback **全部**传了身份，`catAiMove` 在窗口关闭后**不再启动搜索**。

**边界（登记）**：`catAiMove(state)` 是导出 API，省略第二参数时由 `planHardCatTurn` 自铸 `t0 + budget`。这是**设计上的契约**（独立调用＝拥有自己整个回合），但它意味着「一个回合只有一条时限」这条保证**只对走 `computeCatAiTrajectory` 的调用者成立**。生产侧已全覆盖；若将来有新入口直接调 `catAiMove`，必须显式传身份，否则会重新出现"每次 fallback 重新给 100ms"的老问题。建议后续在类型层把该参数改为必填的 `TurnDeadlineIdentity | undefined` 显式双态，或加一条 lint/测试守卫。

### 3.3 计划长度扩大是否引入未受控后处理

**否。** 新上界 `M + 1 + floor(M/2)`，默认地图 `M=4` ⇒ **7**，比旧的常量 8 **更小**。所以：
- 默认地图上计划长度实际是**收紧**的；
- 后处理（`buildCandidate` / `planFullTurnCompleteness` / `countPlanReversals`）都是对 plan 数组的线性扫描，上界 19（`M=12`）时也只多几次迭代，不构成未受控开销。

实测：DP 提取 p50 `0.058ms`（前轮 0.059ms），`M=2→9` 时 `0.139→1.767ms` 近似线性（`PPC-P1-QUALITY-01/EXTRACTION_COST.json`）。

### 3.4 新反向评分是否保持同主值与稳定排序

**是。**
- 主值：24 个人类根 `value/mate/completed/action/ttSize` **24/24 全同**（`PPC-P1-QUALITY-01/PARITY_RESULTS.json`）。
- 排序：同分时仍是 `totalReversal < bestReversal` 才替换 ⇒ **首位记录者胜出**，未引入新排序键（QA-7）。
- memo key 未变（`graphKey#prevCatStepKey`），前缀本来就在 key 里。
- 每边恰好计一次：`countPlanReversals` 只有两个来源（`prefix→plan[0]`、`plan[i-1]→plan[i]`），结构上不可能重复（QA-4）。

### 3.5 Progress Guard 的历史记忆与新计划是否一致

**存在级联，但真实对局行为未退步。** `LoopSignature` 含 `previousPlanLabel`，QUALITY-01 改了计划文本 ⇒ 签名随之改变。前轮已用 guard 探针实测（`PPC-P1-QUALITY-01/T15_GUARD_PROBE.json`）：

```
T14 与 T15 现在都产出 DRUL，两者签名相同
真实记忆 DRUL → guardedPlan = DDLD，rescueApplied = true，abortReason = none
旧记忆 ULDR → 不触发（SIGNATURE_DIFFERS），但那是过期记忆
```

即：守卫在真实对局里照常触发并救回。**这是本轮复核确认的唯一处"跨轮耦合"**——QUALITY-01 的计划变化会改写 guard 的签名空间。若后续再改计划选择，必须重跑这条探针，不能只看 `progressGuard.test.ts` 是否绿。

### 3.6 P1-PLAN 上界对"非负整数移动预算"的证明范围

**代码成立，文档表述不精确。**

- 代码：`catTurnMoveBudget` 显式 `!Number.isFinite(raw) || raw <= 0 → 0`，否则 `Math.floor(raw)`；`maxCatTurnPlanActions = M + 1 + floor(M/2)`。定义域在代码里是收敛的。
- 文档：`PPC-P1-PLAN-01/PLAN_ACTION_BOUND_PROOF.md §3` 只写 "the move budget is a free integer"，**没有**限定"非负整数"，也没有讨论小数 `catMovesLeft`；§4 只覆盖 `NaN / ±∞ / -3 / 0`。
- 小数情形是否安全：是的，但理由未写下来。若 `catMovesLeft = 2.5`，真实可花的步数至多 `floor(2.5)=2`，而未取整的上界 `2.5+1+floor(1.25)=4.5`；取整后 `2+1+1=4 ≤ 4.5`。**取整只会收紧上界，不会截断合法计划**（因为上界本身是"可花的整数步数"的函数）。这一句应补进 §3。
- 结论：属**文档精度缺口**，不是正确性缺口。按任务要求只记录，不顺手改。

### 3.7 异常输入是否还有独立未认证的边界

逐一检查后，仍有三处**未被任何门覆盖**的异常输入路径（登记，不修）：

| # | 输入 | 当前行为 | 是否有门 |
|---|---|---|---|
| a | `catMovesLeft` 为小数 | `floor` 收紧上界；完备性判定沿用原逻辑 | 无（PLAN-0 只测 `0..12` 整数 + `NaN/±∞/-3`） |
| b | `catMovesLeft` 极大（如 `1e6`） | 上界 `1.5M+1`，DP memo key 不含剩余容量 ⇒ 仍正确，但 `pathGuard` 可能提前收割 | 无 |
| c | `catAiMove(state)` 不传身份 | 自铸 `t0+100` 窗口 | 有测试覆盖该契约（`hardTurnAbsoluteDeadline.test.ts`），但**无守卫阻止生产新入口忘记传** |

a/b 只影响未认证的非法/退化状态，正常对局不可达（`validateGameConfig` + 引擎写路径保证 `catMovesLeft` 为 0..`catBaseMoves` 的整数）。c 是真实的架构风险点，建议后续用类型或测试守卫关掉。

---

## 4. 本轮未做的事（明确声明）

- 未修改任何生产源码（`src/` 除本轮新增 `PPC-P1-CLOSURE-01/` 目录外 0 改动）；
- 未 commit / push / merge / rebase / reset / clean / stash；
- 未重跑 1713s 全量回归；
- 未跑 self-play / oracle / 3400-job primary / METHOD_A / 正式 timing benchmark；
- 未修改 `100ms` / `150ms` 常量或 `vitest.config.ts` 的 `testTimeout`；
- 未修改任何历史冻结的门槛与 fixture；
- 唯一为测量目的创建的非交付物是 `PPC-P1-CLOSURE-01/arm-head/`（HEAD 源码冻结副本，逐文件 SHA 与 `git show HEAD:` 全等，见 `ARM_MANIFEST.json`），它与 `src/` 完全隔离，不参与构建（`tsconfig` 只包含 `src/`）。
