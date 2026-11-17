# PPC-P1-QUALITY-01｜Hard Cat 完整回合计划反向评分漏边修复

- 轮次：`PPC-P1-QUALITY-01`
- 日期：2026-11-13
- 分支：`ppc/p1-id-state-identity-fix`，HEAD `48eaac6c4f3801d351787696ba5876995b64e8d8`
- 缺陷登记：`PPC-PLAN-001`（来源 `PPC-NEXTGEN-01/CORRECTNESS_REGISTER.md`）
- 授权：只读审计 + 最小生产修复 + 验证取证；**未** commit / push / merge / stash / reset / clean
- 裁决：待 ChatGPT 复核，本轮不自我宣告 PASS

---

## 1. 一句话结论

计划提取的二级比较**漏了一条边**。旧代码把一条分支的分数算成"两半之和"：

```ts
const totalReversal = actionReversal + countReversals(childPlan);
```

`actionReversal` 管前缀→当前动作，`countReversals(childPlan)` 只管子计划**内部**。两者之间那条 `action → childPlan[0]` 的连接边，谁也不管。于是两条主值完全相同的合法线路，可以用**一个少算一条边的数**来比大小，提取器就会挑中真实掉头更多的那条。

改成对**拼接后的整条计划**算一次：

```ts
const totalReversal = countPlanReversals(prefix.prevCatStepKey, fullPlan);
```

六个反例形状（竖走廊 / 横走廊 × M=2/3/4）修复前 **6/6 全错**，修复后 **6/6 全对**，而 `value / mate / completed / nodes / ttSize` 一个都没变。

---

## 2. 这条边为什么会被漏掉

递归 DP 的每个节点返回"从我这个状态出发的最优剩余计划" `childPlan`。父节点把它拼成 `[action, ...childPlan]`。

- 父节点自己的 `actionReversal` 只看 `prefix → action`。
- `countReversals(childPlan)` 从 `i = 1` 开始遍历，只看 `childPlan` **内部**相邻对。
- 于是 `action`（下标 0）与 `childPlan[0]`（下标 1）这一对，落在两个数组的交界上，**两边都不遍历**。

`countReversals` 本身没错——它是"一个数组内部的批计数"。错的是把两个批计数的和当成拼接后的批计数。这个错误在 `planQuality.ts` 里只出现一次，但它影响每一次二级比较。

顺带一提：`buildCandidate`（强制失败 tie-break 的候选构造）用的是另一条路径——它对**整条 plan** 逐个相邻对循环，所以它的 `reversalCount` **一直是对的**。也就是说，修复前生产里存在两个口径不一致的反向计数器，而 DP 那个是错的。

---

## 3. 复现（`BASELINE_REVERSAL_WITNESS.json`）

诊断口径：等值主搜索 + 常量叶（无夹终点 0 分、留下夹子 −1 分），使次级比较成为唯一决策者。这不是棋力实验，不对 H1 说任何话。

| 形状 | M | 修复前选择 | 反向 | 参考直线 | 反向 | 主值 |
|---|---|---|---|---|---|---|
| 竖走廊 | 2 | `UD` | **1** | `DD` | 0 | 0 / mate=null / completed=true |
| 竖走廊 | 3 | `UDD` | **1** | `DDD` | 0 | 同上，nodes 16 |
| 竖走廊 | 4 | `UDDD` | **1** | `DDDD` | 0 | 同上，nodes 30 |
| 横走廊 | 2 | `LR` | **1** | `RR` | 0 | 同上 |
| 横走廊 | 3 | `LRR` | **1** | `RRR` | 0 | 同上 |
| 横走廊 | 4 | `LRRR` | **1** | `RRRR` | 0 | 同上 |

竖走廊 M=2 就是登记见证 `reversal_boundary_counterexample.json` 的原样复现：7×7、`catBaseMoves=2`、猫 (1,2)、鼠 (5,5)、洞 (5,6)，`plan=UD`、`reversals=1`、`alternative=DD`。

横走廊是把同一几何**旋转 90°**（反向轴变成 左/右），用来排除"只对某个样例硬编码"的可能；M=3/4 用来排除"只对两步成立"。**三种步数 × 两个轴，6/6 全部复现。**

修复后（`POSTFIX_REVERSAL_WITNESS.json`）：

| 形状 | 修复后 | 反向 | 主值是否变化 |
|---|---|---|---|
| 竖 M=2 | `DD` | 0 | 否 |
| 竖 M=3 | `DDD` | 0 | 否 |
| 竖 M=4 | `DDDD` | 0 | 否 |
| 横 M=2 | `RR` | 0 | 否 |
| 横 M=3 | `RRR` | 0 | 否 |
| 横 M=4 | `RRRR` | 0 | 否 |

`primaryFieldsIdenticalToBaseline: true`（value / mate / completed / nodes / ttSize 全一致），`allNowPickFewerReversals: true`。

---

## 4. 修复（只改 `src/game/ai/planQuality.ts`）

三处改动，全部在同一个文件内：

1. **抽出方向对立表**：新增 `OPPOSITE_DIRECTION` 与 `isOppositeDirection(aKey, bKey)`，让"只以方向键形式存在的 prefix"可以直接参与比较，不必再伪造一个 `SearchAction`。`isImmediateReversal` 改为委托给它，语义不变（外部调用方无需改）。
2. **新增 `countPlanReversals(prefixCatStepKey, plan)`**：唯一的反向总数出处。
3. **`extractDp` 改用该函数**：删掉 `actionReversal` 与那个 `dummyPrev` 拼装，一行算总账。

```ts
const fullPlan = [action, ...childPlan];
const totalReversal = countPlanReversals(prefix.prevCatStepKey, fullPlan);
```

### 4.1 记账合同（每条边恰好一次）

给定 prefix 方向键与**整条** plan，`countPlanReversals` 只做两件事：

1. `prefix → plan[0]`（仅当 prefix 存在且两端都是 `catStep`）；
2. `plan[i-1] → plan[i]`，`i = 1..n-1`。

没有第三个来源，所以**结构上不可能重复计数**；而 `plan[0]` 就是当前动作、`plan[1]` 就是子计划首动作，所以**结构上不可能漏算**。这三点正好对应用户要求的三条边。

`catPlaceTrap` 不是方向，`isImmediateReversal` 对任何含非 `catStep` 的相邻对返回 false，所以放夹在**两侧都不会**凭空制造反向——它只会打断链条。

### 4.2 未改动的部分

- `memo` key 仍是 `(graphKey | prevCatStepKey)`，**未改**。前缀本来就在 key 里，这正是子问题能按前缀分别最优的前提。
- `pathGuard`、`maxLength` 上界（P1-PLAN-01 的 `planBound.ts`）、完整回合裁决 `planFullTurnCompleteness`、候选构造 `buildCandidate` 与 `compareCatTurnPlanQuality` 全部未改。
- 同分仍走"`<` 才替换"⇒ **首位记录者胜出**，未引入新排序键。
- 没有新增 tie-break 策略、没有动 H1 权重、没有动搜索深度。

---

## 5. 两个真实游戏根的计划变化（附决定性证据）

修完跑回归，出现 4 个计划字符串断言失败，涉及两个真实根。任务书要求"不能为了通过测试直接更新断言"，所以先做归因。

方法是写一个**参考 DP**（`probe/old_vs_new_dp.test.ts`）：把 `extractDp` 复刻两份，唯一的差别是打分函数用旧公式还是新公式，其余（边界、memo、pathGuard、动作顺序、同分规则）**完全一致**，跑在**同一张真实图上**，逐分支打印。

### 5.1 GAME2 T7（`OLD_VS_NEW_DP.json`）

根顺序 `U, L, D, R`，四个根动作主值全部 `-914.5263157894738(exact)`。

| 首动作 | 旧公式返回 | 旧分 | 新公式返回 | 新分 |
|---|---|---|---|---|
| U | `UUDD`（真实 1 反向） | **1** | `ULDR`（0） | **0** |
| L | `LURD`（0） | 0 | `LURD`（0） | 0 |
| D | `DLUR`（0） | 0 | `DLUR`（0） | 0 |
| R | `RDLU`（0） | 0 | `RDLU`（0） | 0 |

- **旧**：`U` 这一支的**子树**自己先算错了——它返回的 `UUDD` 真实有 1 个反向，但子树内的比较漏了边，于是看起来是 0；到了根上又被正确记为 1。根比较于是变成"`L/D/R` = 0，`U` = 1"，在 0 组里取首位 `L` → `LURD`。
- **新**：`U` 支的子树现在返回 `ULDR`（0 反向）；四支全 0，取首位 `U` → `ULDR`。

注意旧结果 `LURD` 本身**违反**了"首位胜出"：它是在被污染的分数上做比较才侥幸胜出的。

### 5.2 Game5 T15（`OLD_VS_NEW_DP_T15.json`）

根顺序 `D, L, U, R`。

| 首动作 | 旧公式返回 | 旧分 | 新公式返回 | 新分 |
|---|---|---|---|---|
| D | `DDUU`（真实 1 反向） | **1** | `DRUL`（0） | **0** |
| L | `LLRR`（真实 1 反向） | **1** | `LURD`（0） | **0** |
| U | `ULDR`（0） | 0 | `ULDR`（0） | 0 |
| R | `RDLU`（0） | 0 | `RDLU`（0） | 0 |

- **旧**：`D`、`L` 两支的子树各返回了一个真实 1 反向的次优计划，把 0 分组缩成 `{U, R}`，首位 `U` → `ULDR`。
- **新**：四支全 0，首位 `D` → `DRUL`。

两个根是**同一个机制**：漏边让子树返回次优计划，从而缩小根上的 0 分组，把胜者推到非首位。修复后 0 分组恢复完整，**既有的稳定排序规则才真正生效**。

### 5.3 变化是否可接受（逐条核对任务书四条件）

| 条件 | T7（LURD→ULDR） | T15（ULDR→DRUL） |
|---|---|---|
| 主搜索价值相同 | 四个根动作全部 exact 相等 | 同样 exact 相等 |
| 新计划反向次数不增加 | 0 → 0 | 0 → 0 |
| 符合原有后续稳定排序 | `U` 是首位，`ULDR` 由首位胜出 | `D` 是首位，`DRUL` 由首位胜出 |
| 动作完全合法 | 1 次回访、净位移 0、终点 (6,6) | 深度 2 完成、上一深度计划 `DDLD` 不变 |

四条全满足 ⇒ 判定为本轮**预期结果**，按此更新断言，并保留全部更强不变量（主值、反向数、回访数、净位移、终点）。

---

## 6. Progress Guard 的影响（唯一一处需要解释的级联）

`progressGuard P8` 不是简单的字符串变化：修复后该根**根本不触发守卫**。

`T15_GUARD_PROBE.json`：

```
depth1Plan=DDLD   depth2Plan=DRUL   previousCompletedPlan=DDLD
guard(旧记忆 ULDR)：triggered=false  abortReason=no_trigger  reasons=[SIGNATURE_DIFFERS]  plan=DRUL
guard(真实记忆 DRUL)：triggered=true  rescueApplied=true     originalPlan=DRUL  rescuePlan=DDLD
```

原因：`LoopSignature` **包含计划标签**（`previousPlanLabel: prev.sig?.plan`）。计划从 `ULDR` 变成 `DRUL`，签名自然不同。

**但守卫在真实对局里没有退步。** 实测 T14 与 T15 现在都产出 `DRUL`，且两者签名完全相同：

```
plans: {14: "DRUL", 15: "DRUL"}   sig14plan=DRUL  sig15plan=DRUL  sameSig=true
```

即真实对局中 T14 的记忆本来就是 `DRUL`，T15 照常触发并救回 `DDLD`（`rescueApplied=true`）。失败的只是**测试里硬编码的旧标签**。

因此 P8 的处理是**改记忆来源**（用规划器实际产出的循环构造上一回合记忆），而不是删断言：`rescueApplied`、`rescuePlan === 'DDLD'`、`originalPlan` 仍然被严格断言，端到端救回路径仍被真实覆盖。守卫触发策略本身**零改动**。

---

## 7. 24 个真人根（`PARITY_RESULTS.json`）

冻结协议（10k 节点、无 deadline、`evaluateCorrectedHoleForCat`、TT+AB+ordering、capturePlan），基线是 P1-PLAN-01 复现过 24/24 的同一份冻结工件。

| 项 | 结果 |
|---|---|
| `key / completed / value / mate / action / ttSize` 逐字段一致 | **24/24** |
| 计划发生变化 | **0 个** |
| 全根反向总数 | 1 → 1 |

24 个真人根没有一个发生计划变动——与 `PPC-HV-2 §5` 的旧结论一致（4 个人类根里 2 个有唯一 exact 最优、2 个本来就是零反向绕圈，漏边在那里不改变选择）。本轮的变化只出现在**真正存在等值平局且子树被误算**的根上（T7、T15）。

---

## 8. 性能（`EXTRACTION_COST.json`，DIAGNOSTIC_ONLY）

单遍、走廊根、诊断叶、200k 节点预算：

| M | 图节点 | search ms | walk ms | DP ms | DP 计划长 | 裁决 |
|---|---|---|---|---|---|---|
| 2 | 4 | 3.816 | — | 0.139 | 2 | COMPLETE |
| 3 | 10 | 1.453 | — | 0.264 | 3 | COMPLETE |
| 4 | 17 | 1.955 | — | 0.413 | 4 | COMPLETE |
| 6 | 40 | 4.773 | — | 1.059 | 6 | COMPLETE |
| 7 | 59 | 5.436 | — | 1.249 | 7 | COMPLETE |
| 9 | 94 | 7.166 | — | 1.767 | 10 | COMPLETE |

DP 成本随图规模**近似线性**增长（4 → 94 节点，0.139 → 1.767 ms），M=9 时绝对成本 1.77 ms、约为该根搜索耗时的 25%。**没有观察到指数级或异常的后处理耗时。** 24 根 D1 上 DP 中位数仍是 0.058 ms（`PARITY_RESULTS.json`），修复前是 0.059 ms——同量级。

新增的计算量是每次比较多一次 `isOppositeDirection` 判断（一次对象属性查表），在真实根上不可测量。

`ABSOLUTE_DEADLINE_GATE` 保持 **BLOCKED**：本轮完全没有触碰 100ms/150ms 预算、`TurnDeadlineIdentity`、sidecar 或 Progress Guard 策略，不主张任何时限合规或棋力提升。

---

## 9. 验收门（13 门，明细见 `CORRECTNESS_RESULTS.json`）

| 门 | 内容 | 状态 |
|---|---|---|
| QA-0 | 来源身份 / 工作区 / 前轮保全 | PASS |
| QA-1 | 登记反例复现并关闭（6 形状 × 2 轴 × M=2..4） | PASS |
| QA-2 | 外部前缀 → 当前动作 的边 | PASS |
| QA-3 | 当前动作 → 子计划首动作 的边 | PASS |
| QA-4 | 每条相邻边恰好一次 | PASS |
| QA-5 | 放夹不制造反向 | PASS |
| QA-6 | memo 按前缀隔离 | PASS |
| QA-7 | 等分同反向保持既有稳定排序 | PASS |
| QA-8 | 全部候选合法且完整认证 | PASS |
| QA-9 | D1 搜索数学不变（value/mate/completed/TT） | PASS |
| QA-10 | P1-PLAN-01 的 6 步 9 动作 / 9 步长计划仍合法完整 | PASS |
| QA-11 | 24 真人根新旧对照已记录 | PASS |
| QA-12 | TypeScript / Vite 构建 / 既有回归 | PASS_WITH_2_PREEXISTING_FAILURES |

新增测试 `planReversalAccounting.test.ts` **9/9 通过**，覆盖 QA-1…QA-8（含穷举预言机：在 V-M2/M3、H-M2/M3 上枚举**全部**合法完整回合线，取等值组内真实反向最小值，断言提取器达到该最小值）。

---

## 10. 回归（`REGRESSION_TRIAGE.md`，`logs/regression_full.log`）

单 worker 串行，与修复前同条件：

| 项 | 修复前（P1-PLAN-01） | 本轮 |
|---|---|---|
| 测试总数 | 973 | **982**（+9 新测试，+1 解锁 HV2-C1，−1 跳过项） |
| 通过 | 961 | **976** |
| 失败 | 7 | **2** |
| 跳过 | 5 | 4 |
| 文件 | 79 | 80 |
| 耗时 | 815s | 1713s（串行） |

剩下 2 个失败均为既有项：

- `T1E-B`：`searchBestAction` 的 A/B 30s 超时。
- `FLT-HV14-4`：`res.value` 复现失败（`999996` vs `-1052.947…`）。

两者读的都是**搜索**输出，而本轮唯一的生产改动只在搜索之后读图；且 P1-PLAN-01 的 A/B 已证 `FLT-HV14-4` 在旧常量下同样失败。

**没有删除或放宽任何断言**；更新的 6 处计划字符串全部附证据注释，并保留主值/反向/回访/净位移/终点等更强不变量。

---

## 11. 第一阶段发现的既有文档缺口（记录，未修改）

任务要求检查 P1-PLAN-01 上界证明是否明确限定"非负整数移动预算"。

**结论：存在一处表述缺口，属文档精度问题，不是代码缺陷。**

- `PLAN_ACTION_BOUND_PROOF.md §3` 只说 `catBaseMoves` 在 `validateGameConfig` 中无校验、因此移动预算是 "a free integer"，**没有**把定义域写成"非负整数"，也没有讨论**小数** `catMovesLeft`。
- 代码实际处理了：`catTurnMoveBudget` 对非有限值或 ≤0 夹到 0，对其余值取 `Math.floor`（`planBound.ts:65-69`）。所以真实定义域是 `M = floor(max(0, margo)) ∈ ℕ`，推导（步数为整数）只在整数字段上成立。
- 由于 `catMovesLeft` 在引擎里始终是整数计数器，"小数"是理论情形；`NaN/±∞/负` 已有显式夹取与测试（PLAN-0）。
- §4 已覆盖异常值夹取。缺的只是 `§3` 里一句"域为非负整数（小数一律向下取整）"。

**按任务要求只记录、不顺手修改**（一是不在本轮授权范围，二是改动证明文档会牵动 P1-PLAN-01 已冻结的工件）。

---

## 12. 最终状态块

```
PPC_P1_QUALITY_STATUS            = IMPLEMENTED_AND_VERIFIED_PENDING_ADJUDICATION
SOURCE_BASELINE                  = branch ppc/p1-id-state-identity-fix @ 48eaac6c4f3801d351787696ba5876995b64e8d8
P1_ID_PRESERVED                  = YES (transposition.ts 7b4aa8eb unchanged)
P1_TIME_01_PRESERVED             = YES (deadlineContext/hardTurnPlanner/engine untouched this round)
P1_TIME_02_PRESERVED             = YES (PPC-P1-TIME-02/ untouched)
P1_PLAN_01_PRESERVED             = YES (planBound.ts 99c269f9, expectiminimax.ts 42b6e71f unchanged)
DEFECT_ID                        = PPC-PLAN-001
JOIN_EDGE_ACCOUNTING             = FIXED (countPlanReversals over the concatenated plan)
ALL_EDGES_COUNTED_ONCE           = YES (prefix→first, first→second, interior; single source)
TRAP_NO_FAKE_REVERSAL            = YES (QA-5)
MEMO_PREFIX_CONTEXT              = UNCHANGED (key still graphKey + prevCatStepKey)
STABLE_ORDER                     = PRESERVED (first recorded wins a full tie; no new sort key)
PLAN_COMPLETENESS                = PRESERVED (planFullTurnCompleteness untouched)
SEARCH_MATH_UNCHANGED            = YES
TT_SEMANTICS_UNCHANGED           = YES
DEADLINE_IDENTITY_UNCHANGED      = YES
DEFAULT_D1_PARITY                = 24/24 primary fields identical; 0 plan changes
LONG_PLAN_REGRESSION             = NONE (P1-PLAN-01 length gates 19/19 PASS; M=9 -> 10-action COMPLETE)
REAL_ROOT_PLAN_CHANGES           = 2 (GAME2 T7 LURD->ULDR; Game5 T15 ULDR->DRUL), both same exact value, 0 reversals before and after, both now obey the stable-order rule
PROGRESS_GUARD_POLICY_CHANGE     = NO (only the test's memory fixture was rebuilt from the real plan; real play still triggers and rescues)
REGRESSION_TESTS                 = 982 total: 976 PASS / 2 FAIL / 4 SKIP; both failures PREEXISTING (T1E-B, FLT-HV14-4)
ASSERTIONS_RELAXED_OR_DELETED    = NONE
TYPESCRIPT_BUILD                 = PASS (tsc -b exit 0)
VITE_BUILD                       = PASS (npm run build exit 0, 96 modules, 7.91s)
PERFORMANCE_GATE                 = DIAGNOSTIC_ONLY (DP p50 0.058ms on 24 roots; M=9 1.77ms, near-linear)
ABSOLUTE_DEADLINE_GATE           = BLOCKED
NEW_EFFICACY_AUTHORITY           = NONE
GAMEPLAY_CHANGE                  = NO
H1_CHANGE                        = NO
SIDECAR_POLICY_CHANGE            = NO
BUDGET_CHANGE                    = NO
MOUSE_AI_CHANGE                  = NO
HEAVY_WORKER_CONCURRENCY         = 1
SERIAL_FRESH_REPETITIONS         = TRUE
DUPLICATE_BENCHMARK_CHECK        = PERFORMED (no historical benchmark re-run; single-pass diagnostics only)
COMMIT/PUSH/MERGE                = NO
```

---

## 13. 本轮做了什么 / 没做什么

**做了**

1. 复现并关闭登记缺陷 `PPC-PLAN-001`，在 6 个形状上（竖/横 × M=2/3/4），而不只是登记的那一个样例。
2. 把"两半之和"换成"整条计划算一次"，并用 `countPlanReversals` 作为唯一出处；抽出 `isOppositeDirection` 消除伪造 `SearchAction` 的写法。
3. 解锁 `HV2-C1`（文件原注释明确要求随此修复一起解锁）。
4. 新增 9 个验收测试，其中含**穷举预言机**（枚举全部合法完整回合线，取等值组内真实反向最小值）。
5. 写了一个参考 DP，把旧/新公式跑在同一张真实图上，**逐分支**给出 T7 与 T15 的计划变化原因。
6. 24 根 parity + 提取成本有界对照 + Progress Guard 级联影响的实测澄清。

**没做（刻意）**

- 没动 H1、评价函数、搜索深度、TT、alpha-beta、Move Ordering、Sidecar、Progress Guard 策略、100ms/150ms 预算、鼠 AI。
- 没动 `planBound.ts`（P1-PLAN-01 的上界）。
- 没新增 tie-break 策略：同分仍然"首位记录者胜出"。
- 没删除或放宽任何断言；没把失败重跑到绿。
- 没 commit / push / merge。
- 没进入下一阶段，没启动大规模 self-play / oracle / 正式 efficacy primary。

**明确不主张**

- 不主张棋力提升。本轮修复的是"主值相同时选哪条路线"，对搜索结果没有任何影响（24/24 逐字段一致）。
- 不主张 150ms 平台改善。`ABSOLUTE_DEADLINE_GATE` 保持 BLOCKED。
- 不主张"所有根的平局都已被修正"——只主张**被比较的那条边现在被计入**，且 24 个真人根里没有受影响者。
- 不主张 P1-PLAN-01 上界证明的域表述已经完整（见 §11，只记录未修）。

---

## 14. 交付物清单

| 文件 | 内容 |
|---|---|
| `REPORT.md` | 本文 |
| `SOURCE_MANIFEST.json` | 改动文件与前轮保全项的 sha256 |
| `BASELINE_REVERSAL_WITNESS.json` | 修复前 6 形状观测 |
| `POSTFIX_REVERSAL_WITNESS.json` | 修复后同协议复测 |
| `CORRECTNESS_RESULTS.json` | 13 门 + 计划变化归因 + 断言复核判定 |
| `PARITY_RESULTS.json` | 24 真人根新旧对照 + 成本诊断 |
| `REGRESSION_TRIAGE.md` | 回归分诊：2 既有失败 + 6 处断言复核 |
| `OLD_VS_NEW_DP.json` | GAME2 T7 旧/新公式逐分支差分（决定性证据） |
| `OLD_VS_NEW_DP_T15.json` | Game5 T15 同款差分 |
| `T15_GUARD_PROBE.json` | Progress Guard 触发/救回实测 |
| `EXTRACTION_COST.json` | 提取成本随步数的有界对照（DIAGNOSTIC_ONLY） |
| `logs/regression_full.log` | 982 tests 全量串行 |
| `logs/guard_suites.log` | progressGuard + m3lite 41/41 |
| `logs/hv14.log` | HV14 16/16 |
| `logs/plan_suites.log` | 计划相关套件（含 2 处待复核失败） |
| `logs/tsc.log` / `logs/build.log` | 类型检查与构建 |
| `probe/` | 取证工程（独立 vitest config，不进仓库主套件） |
