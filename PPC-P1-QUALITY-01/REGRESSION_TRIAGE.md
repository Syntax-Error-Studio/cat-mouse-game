# PPC-P1-QUALITY-01｜回归分诊

- 协议：`npx vitest run --fileParallelism=false`（单 worker 串行），与修复前同条件
- 修复前权威（P1-PLAN-01）：973 tests，7 failed / 961 passed / 5 skipped，79 files
- 本轮第一遍（修复已落地、断言尚未复核）：982 tests，6 failed / 972 passed / 4 skipped，80 files
- **本轮最终**：982 tests，**976 passed / 2 failed / 4 skipped**，80 files，1713s（`logs/regression_full.log`）

测试总数从 973 增到 982：**+9** 全部来自新增的 `planReversalAccounting.test.ts`。

`HV2-C1` 由 `test.skip` 转为正式门**不改变总数**（用例本来就在计数里），只让"跳过"减 1、"通过"加 1。

账目对齐：`976 通过 + 2 失败 + 4 跳过 = 982`；相对修复前 `961 + 7 + 5 = 973`，通过 +15、失败 −5、跳过 −1。

那 +15 的构成是：**+9** 新测试全部通过、**+5** 是 P1-PLAN-01 登记的吞吐敏感项（`HV10-E1/E4`、`HV8-C2`、`TIME-6 ×2`）在本次串行运行下转绿、**+1** 是 `HV2-C1` 解锁。第一遍出现的 4 个计划字符串失败（D7、P4、P8、P26）是修复引入又被复核修正的，在最终态净贡献为 0，见 §2。

---

## 1. 最终失败项（2 个，均为既有）

| 测试 | 本轮 | 修复前（P1-PLAN-01） | 判定 |
|---|---|---|---|
| `T1E-B`（`expectiminimax.test.ts`，30s 超时） | FAIL | FAIL | **既有**，与本轮无关 |
| `FLT-HV14-4`（`forcedLossTieBreakHv14Reachability.test.ts`） | FAIL | FAIL | **既有**，与本轮无关 |

**为什么判定与本轮无关（两条独立理由）**

1. 两条断言读的都是**搜索**输出，不是计划：`T1E-B` 是 `searchBestAction` 的 A/B 超时；`FLT-HV14-4` 是 `res.value`（`999996` vs `-1052.947…`）。本轮唯一的生产改动在 `extractDp`，它只在搜索**之后**读取 `equalPrimaryGraph` / `planBranches`，从不写回 `SearchValue`。
2. P1-PLAN-01 已有 A/B 反证：`PPC-P1-PLAN-01/logs/ab_flt_hv14_legacy_cap.log` 显示**旧常量 8 下 `FLT-HV14-4` 同样失败**；`T1E-B` 在 P1-PLAN-01 修复前就是唯一另一个既有失败。

---

## 2. 第一遍出现的 4 个新失败：全部是计划字符串断言，已逐项复核

这 4 个不是回归，而是**本轮修复的直接目标**（改变错误的计划选择）。任务书要求：不能为了通过测试直接更新断言，必须先判断变化是否属于预期结果。

| 测试 | 旧断言 | 实际 | 处理 |
|---|---|---|---|
| `m3liteHumanValidationLogging D7` | `ULDR` | `DRUL` | 改断言 + 证据注释 |
| `progressGuard P4` | `ULDR` | `DRUL` | 改断言 + 证据注释 |
| `progressGuard P26` | `ULDR` | `DRUL` | 改断言 + 证据注释 |
| `progressGuard P8` | 救回 `DDLD`，`originalPlan=ULDR` | 未触发，`DRUL` | **重建记忆来源**，见 §3 |
| `hv14FiveGameForensics HV14-5/6` | `LURD` | `ULDR` | 改断言 + 证据注释（第一遍之前已复核） |
| `hv2PlanTieQuality HV2-C1` | `test.skip` | 通过 | 按文件原注释解锁 |

### 2.1 判定依据（不是"跑绿就算"）

对每个变化都满足任务书四条：

| 条件 | GAME2 T7 | Game5 T15 |
|---|---|---|
| 主搜索价值相同 | 四个根动作全部 `-914.5263157894738(exact)` | 全部 exact 相等 |
| 反向次数不增加 | 0 → 0 | 0 → 0 |
| 符合原有稳定排序规则 | `U` 是首位记录动作，`ULDR` 由"首位胜出"得到 | `D` 是首位记录动作，`DRUL` 由"首位胜出"得到 |
| 动作完全合法、回合完整 | 1 次回访、净位移 0、终点 (6,6) | 深度 2 完成、`previousCompletedPlan=DDLD` 不变 |

**决定性证据**在 `OLD_VS_NEW_DP.json` / `OLD_VS_NEW_DP_T15.json`：一个参考 DP 把**旧公式**和**新公式**跑在**同一张真实图**上，逐分支打印。

**GAME2 T7**（根顺序 `U,L,D,R`）

| 首动作 | 旧公式 | 旧分 | 新公式 | 新分 |
|---|---|---|---|---|
| U | `UUDD`（真实 1 反向） | **1** | `ULDR`（0） | **0** |
| L | `LURD`（0） | 0 | `LURD`（0） | 0 |
| D | `DLUR`（0） | 0 | `DLUR`（0） | 0 |
| R | `RDLU`（0） | 0 | `RDLU`（0） | 0 |

旧：`U` 被记 1 → 在 0 分组里取首位 `L` → `LURD`。
新：四支都是 0 → 取首位 `U` → `ULDR`。
**旧结果 `LURD` 恰恰违反了"首位胜出"**，因为它是在被污染的分数上做的比较。

**Game5 T15**（根顺序 `D,L,U,R`）

| 首动作 | 旧公式 | 旧分 | 新公式 | 新分 |
|---|---|---|---|---|
| D | `DDUU`（真实 1 反向） | **1** | `DRUL`（0） | **0** |
| L | `LLRR`（真实 1 反向） | **1** | `LURD`（0） | **0** |
| U | `ULDR`（0） | 0 | `ULDR`（0） | 0 |
| R | `RDLU`（0） | 0 | `RDLU`（0） | 0 |

旧：只有两支是 0，首位是 `U` → `ULDR`。
新：四支都是 0，首位是 `D` → `DRUL`。

两个根呈现的是**同一个机制**：旧公式在子树里漏算连接边，使某些分支返回"看起来更差"的次优计划，从而把根比较的 0 分组缩小、把胜者推到非首位。修复后 0 分组恢复完整，稳定排序规则才真正起作用。

---

## 3. `progressGuard P8` 的特殊处理（唯一一处改了测试前提）

P8 原断言：guard 触发 → 计划被替换成上一深度计划 `DDLD`，`originalPlan=ULDR`。

修复后 `T15_GUARD_PROBE.json` 记录：

```
depth1Plan=DDLD  depth2Plan=DRUL  previousCompletedPlan=DDLD
guard(旧记忆 ULDR):  triggered=false  abortReason=no_trigger  reasons=[SIGNATURE_DIFFERS]  plan=DRUL
guard(真实记忆 DRUL): triggered=true   rescueApplied=true      originalPlan=DRUL  rescuePlan=DDLD
```

根因：`LoopSignature` **包含计划标签**（`previousPlanLabel: prev.sig?.plan`）。计划从 `ULDR` 变成 `DRUL`，签名自然不同，于是用旧标签构造的记忆无法匹配。

**这是测试的前提过期，不是守卫退步。** 实测 T14 与 T15 现在都产出 `DRUL`，且两者签名**完全相同**：

```
plans: {14: "DRUL", 15: "DRUL"}   sig14plan=DRUL  sig15plan=DRUL  sameSig=true
```

所以真实对局里 T14 的记忆本来就是 `DRUL`，T15 的守卫**照常触发并救回 `DDLD`**（`rescueApplied=true`）。原测试把修复前的标签当成权威硬编码，修复后它测的就不再是守卫，而是"记忆是否恰好等于旧计划"。

处理方式：**把记忆来源改成规划器实际产出的循环**（先无守卫跑一次拿到 `DRUL`，再用它构造 T14 记忆），保持 P8 仍然端到端验证"触发 → 合法替换 → `DDLD`"。没有删断言、没有放宽条件；`rescueApplied` 与 `originalPlan` 仍然被严格断言。

---

## 4. 并发敏感性未出现

P1-PLAN-01 登记的 5 个吞吐敏感项（`HV10-E1`、`HV10-E4`、`HV8-C2`、`TIME-6` ×2）在本次**串行**运行中全部通过——与登记的"仅在并发套件下失败"一致。本轮没有放宽它们，也没有重跑到绿；串行是本轮规定的协议。

---

## 5. 结论

- 新增失败：**0**
- 断言被删除或放宽：**0**
- 断言被更新的：6 处，全部附证据注释，且都指向"主值不变 + 反向不增加 + 稳定排序"三条可核验事实
- 残留失败：2 个既有项，与本轮改动无代码路径交集
