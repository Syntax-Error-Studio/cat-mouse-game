# PPC-D2-PCV-COUNTERLINE-01 — 单根试点报告（G2–G5）

**轮次**：PPC-D2-PCV-COUNTERLINE-01  
**阶段**：`D2_SINGLE_ROOT_PILOT`（G2 试点 → G3 冻结 → G4 证明 → G5 重复）  
**范围**：仅 `G1T9 / E1`。未扩展任何其他根、未跑 8 个 strata、未接生产。  
**时间**：2026-11-16 19:19 – 19:43 (GMT+8)  
**身份**：HEAD `48eaac6c…`、分支 `ppc/p1-id-state-identity-fix`（全程未变）

> 本文件是本轮的**最终报告**。G0/G1 只读审计阶段的原始记录（含资源准入两次 FAIL  
> 的完整证据）已原样移存为 `REPORT_G0G1_PHASE_RECORD.md`，未删除、未改写。



---

## 一、人话总结

**D2 跑通了，结论是"没有救援"。**

固定深度 D2 在 G1T9 上完整跑完（272.8 万节点、约 3 分钟、无截断），  
把猫的**全部 4 个合法根动作**（U/D/L/R）都提取出了完整猫回合计划，  
计划全部用真实规则重放成功、全部落到合法鼠行动前沿。

然后对这 4 条冻结候选跑量词证明：**4/4 都被 H0（鼠强制胜）证伪**，  
每条只用 774 个节点、50–80 毫秒。H1 因为 H0 已经成立而全部跳过——  
按任务书 §7.2，这是正确顺序，不是漏做。

**所以：D2 没有发现 D1 漏掉的防守路线。** 这和此前 T1/T2/TAIL 的结论一致：  
G1T9 这个局面猫确实是输的，不是搜索不够深的问题。

一个值得注意的结构事实：**4 条不同的猫计划（UDDR / DUDR / LDRR / RUDD）  
最后汇合到同一个前沿状态**（4 条候选 → 1 个唯一前沿）。  
换句话说，猫在这 4 条路上绕了一圈回到同一个地方，鼠从那里照样赢。

---

## 二、§12 十一个问题逐条回答

### 1. D2 固定深度是否真正完整完成？

**是。**

```text
SEARCH_COMPLETED        = TRUE
NO_BUDGET_TRUNCATION    = TRUE   (budgetCutoffs = 0)
NO_DEADLINE_TRUNCATION  = TRUE   (deadlineCutoffs = 0)
NO_EXTENSION_ABORT      = TRUE   (extensionAbortCount = 0)
NODE_CAP_NOT_HIT        = TRUE   (2,727,890 ≈ 34% of 8,000,000)
```

判据用的是审计阶段确定的联合条件（`D2_SEARCH_CONTRACT.md` §4.2），  
**没有**用 `ALL_ROOT_BOUNDS_EXACT` 单独冒充精确性——那个字段在 `useAlphaBeta=false`  
时恒为 `'exact'`，是常量不是判据（4 个根动作确实都是 `exact`，但不作为证据）。

补充实测：`diagnostics.repetitions = 0`，这正是 §4.3 推理链所依赖的那条前提，  
现在从"原则上成立"变成"实测成立"。

### 2. 是否覆盖全部合法根动作？

**是，4/4。**

```text
ROOT_ACTIONS_TOTAL      = 4        (U / D / L / R)
ROOT_ACTIONS_EXACT      = 4
ROOT_ACTION_COUNT_MATCH = TRUE
ROOT_ORDER_ALIGNED      = TRUE     (rootValues[i] 与合法列表逐位对齐，0 处错位)
```

G1T9 根状态没有可用的放夹动作（`preparedActions` 未产出 `catPlaceTrap`），  
所以合法根动作只有 4 个方向步。这是局面事实，不是遗漏。

### 3. 是否成功提取每个根动作对应的完整猫回合计划？

**是，4/4，0 个身份失败。**

|  # | 根动作 | 计划     | 长度 | 完整性判定                    | 重放状态                   |
| -: | --- | ------ | -: | ------------------------ | ---------------------- |
|  0 | U   | `UDDR` |  4 | `COMPLETE_TURN_BOUNDARY` | `VALID_MOUSE_FRONTIER` |
|  1 | D   | `DUDR` |  4 | `COMPLETE_TURN_BOUNDARY` | `VALID_MOUSE_FRONTIER` |
|  2 | L   | `LDRR` |  4 | `COMPLETE_TURN_BOUNDARY` | `VALID_MOUSE_FRONTIER` |
|  3 | R   | `RUDD` |  4 | `COMPLETE_TURN_BOUNDARY` | `VALID_MOUSE_FRONTIER` |

```text
PLAN_IDENTITY_FAILURES = 0
CANDIDATE_COUNT_REDUCED = FALSE
TOP_K_FILTER = NONE
```

提取用的是 `buildPlanForFirstAction` + `buildCandidate`（`planQuality.ts:306/:365`），  
**没有**把根键上那条"全局最佳首着"当计划用。反向证据：4 条计划彼此不同；  
若 `planBranches` 存在跨根动作污染，四条会全部退化成同一条。

§4.3 列出的 4 个静默拒绝分支全部单独计数（`classifyRejection` + `EMPTY_PLAN` /  
`INCOMPLETE_PLAN` / `CANDIDATE_NULL_OTHER`），本次计数均为 0——是"没触发"，  
不是"没统计"。

### 4. D2 principal mouse counterline 是否完整？

**单条线是完整的；但它只代表一条线，不是全部鼠策略的证明。**

4 条候选的前沿各走出一条主变线，**内容完全相同**：`RSRRRR`（6 步，含 1 次技能）。

```text
marker = PRINCIPAL_COUNTERLINE_NOT_EXHAUSTIVE_PROOF
stopReason = TERMINAL_MOUSE
missingBranchEntries = 0     (每一跳都在 planBranches 里查到了条目)
chanceForkCount = 1          (鼠回合内含 1 次 CHANCE 转移，全部结果已枚举)
```

`missingBranchEntries = 0` 说明前沿状态与搜索记录键**精确吻合**——  
这是"分支身份可靠"的第一条经验证据（不是推理）。

### 5. 是否发现多结果 CHANCE？

**边界上没有；鼠回合内部有 1 次。**

- 4 条候选的边界 `chanceBranchCount = 1`、`chanceProbabilitySum = 1`、  
  `chanceAllPositive = true` ⇒ 边界是**确定性交接**；
- 主变线内部有 1 次 CHANCE 分叉，`steps[].outcomes` 把每个结果的权重与  
  `stateKey` 都记录下来了，没有只取 `outcomes[0]`。

所以本轮**没有**真正触发任务书 §7.3 的"多分支 AND 前沿"路径。  
该逻辑已在 `runH0`/`runH1` 中实现（对每个前沿分支 AND），但 G1T9 上  
只走到单分支。**必须如实记录**：`MULTI_CHANCE_PROOF` 本轮为 `NOT_EXERCISED`，  
不能声称已验证。

### 6. 候选是否全部真实回放成功？

**是，4/4。**

每条候选都用真实 `generatePreparedSearchActions` 重放 4 步，  
并用 `applyPrefix`（独立实现）交叉核对：

```text
replayStatus        = VALID_MOUSE_FRONTIER   (4/4)
replayCrossCheck    = TRUE                   (4/4)
```

### 7. H0 有多少有效反证？

**4/4。**

|  # | 根动作 | H0 value | proofStatus | nodes | solveMs | verifier | policyMisses | truncated |
| -: | --- | -------- | ----------- | ----: | ------: | -------- | -----------: | --------- |
|  0 | U   | true     | PROVEN      |   774 |  78.705 | PROVEN   |            0 | false     |
|  1 | D   | true     | PROVEN      |   774 |  63.267 | PROVEN   |            0 | false     |
|  2 | L   | true     | PROVEN      |   774 |  51.134 | PROVEN   |            0 | false     |
|  3 | R   | true     | PROVEN      |   774 |  47.598 | PROVEN   |            0 | false     |

五项条件（VALUE / TRUNCATED / PROOF_STATUS / INDEPENDENT_VERIFIER / POLICY_MISSES）  
全部满足。**独立 verifier 对每条候选都真的执行了一遍**，  
即便 4 条候选共用同一个前沿（§7.4 允许共用证书，但要求仍执行 verifier）。

### 8. H1 有多少有效猫存活证明？

**0，但全部是 SKIPPED 而不是失败。**

按 §7.2，只有 H0 未取得有效 PROVEN 证书的候选才跑 H1。本轮 4 条全部 H0 成立，  
所以 `h1Required = false` 4/4，`H1_SURVIVAL_PROVEN = 0`、`H1_UNRESOLVED = 0`。

如果读成"H1 证明猫活不下来"就错了：本轮**没有运行** H1。

### 9. 是否出现真正的战术救援？

**没有。**

```text
PROVEN_TACTICAL_RESCUE = 0
```

4 条候选全部 `NO_RESCUE_H0_REFUTED`。结合主变线 `RSRRRR` 直接走到  
`MouseWins` 终局，G1T9 在 D2 视野内是**猫必输**，与 D1 结论一致。

口径提醒：D2 只搜"猫回合 + 鼠回合"一层。H0 的 `H=1` 窗口在鼠行动后即止。  
**结论是"这一回合没有救援"，不是"整局没有救援"。**

### 10. 成本、节点、RSS、heap 和重复结果如何？

**搜索成本**

| 指标                |                           值 |
| ----------------- | --------------------------: |
| nodes             |                   2,727,890 |
| leafNodes         |                   8,213,463 |
| chanceNodes       |                      83,263 |
| planBranchEntries |                      64,428 |
| 吞吐                |            ≈ 16,782 nodes/s |
| 搜索耗时（3 次独立进程）     | 162.6 s / 204.6 s / 217.1 s |
| 节点上限占用            |         34.1%（上限 8,000,000） |

**三次运行节点数完全相同（2,727,890），耗时相差 33%**——  
说明节点数是稳定量、墙钟受机器负载影响。与此前"墙钟不可当证据"的结论一致，  
本轮只把节点数当主要成本证据。

**内存（第三次运行实测）**

```text
rssBefore      103.9 MB
rssAfter       288.6 MB
heapUsedAfter  104.3 MB
heapTotalAfter 197.0 MB
resourceUsage.maxRSS  297,444 KB (≈290 MB)
V8_HEAP_EXPANDED = NO
```

**重复结果**

| 重复对象   | 方式      | 结果                              |
| ------ | ------- | ------------------------------- |
| D2 搜索  | 2 个全新进程 | projection SHA 相同、节点数相同、4 条计划相同 |
| PCV 证明 | 2 个全新进程 | projection SHA 相同、774 节点 ×4 相同  |

```text
SEARCH_REP_MATCH = TRUE
PROOF_REP_MATCH  = TRUE
SERIAL_FRESH_REPETITIONS = TRUE
```

### 11. 当前试点是否值得扩展剩余 7 个 strata？

**技术上可以扩，但本轮不扩，且从信息量看收益有限。**

支持扩的事实：

- 机制全部跑通：4/4 提取、4/4 重放、4/4 证伪、0 验证失败；
- 单根成本约 3 分钟搜索 + 1 秒证明，8 个根量级约 25–30 分钟，工程上可行；
- 内存峰值 ~290 MB，离资源门限很远，不会重演准入失败。

不支持（至少该谨慎）的事实：

- G1T9 上 D2 与 D1 结论完全一致，**D2 没有带来新信息**；
- 4 条猫计划汇合到同一前沿，说明该局面猫没有真实选择空间，  
  D2 的深度优势无处发挥；
- 边界 CHANCE 是单结果，多分支 AND 前沿逻辑没被真正压测过——  
  扩到别的根之前，应先确认是否存在多结果边界，否则扩 8 个根  
  可能仍然一次都没触发多分支路径。

建议（供裁决，不自行执行）：先做一次**针对性探测**——扫其余 7 个根的边界  
`chanceBranchCount > 1` 是否存在（只需重放，不跑搜索，秒级）。  
若存在，再决定扩哪些根。这比盲目扩 8 个 strata 更能回答"D2 到底有没有用"。

---

## 三、技术裁决

```text
D2_FIXED_DEPTH_COMPLETE      = TRUE
ALL_ROOT_ACTIONS_COVERED     = TRUE   (4/4)
COMPLETE_CAT_PLAN_PER_ROOT   = TRUE   (4/4, identity failures 0)
COUNTERLINE_COMPLETE         = TRUE   (per line; NOT a strategy proof)
MULTI_CHANCE_AT_BOUNDARY     = FALSE  (single branch on this root)
MULTI_CHANCE_PROOF_EXERCISED = FALSE  -> must not be claimed as verified
CANDIDATES_REPLAYED          = 4/4    VALID_MOUSE_FRONTIER
H0_VALID_REFUTATION          = 4/4
H1_EXECUTED                  = 0      (all skipped: H0 already valid)
PROVEN_TACTICAL_RESCUE       = 0
FALSE_PROVEN                 = 0
VERIFY_FAILURES              = 0
UNIQUE_FRONTIERS             = 1      (4 candidates share one frontier)
BRANCH_IDENTITY_EVIDENCE     = repetitions=0, missingBranchEntries=0, 4 distinct plans
```

### 3.1 分支身份：从 PROVISIONAL 升级到什么程度

上一轮 `D2_SEARCH_CONTRACT.md` 把 `BRANCH_EXTRACTION_RELIABILITY` 标为 `PROVISIONAL`，  
缺两条实测。本轮补齐了主要一条：

| 前提                              | 上轮 | 本轮                                       |
| ------------------------------- | -- | ---------------------------------------- |
| `diagnostics.repetitions === 0` | 未测 | **已测 = 0**（3 次独立运行一致）                    |
| 同一键多次写入无冲突                      | 未测 | 间接证据：4 条计划互不相同 + 每跳都能查到条目（`missing = 0`） |

仍未做的：没有对 `planBranches` 做首写胜/后写胜的逐键比对  
（需包装 Map，属于额外插桩）。准确表述：

```text
BRANCH_EXTRACTION_RELIABILITY = STRONGLY_SUPPORTED (not formally proven)
```

足以支撑"本试点结果可信"，不足以支撑"该机制在任意配置下都可信"。

### 3.2 与历史工件的关系

- **没有**复用任何 T1/T2/TAIL 的证书。4 条 H0 都是本轮重新求解 + 重新验证。
- 4 条候选共用 1 个前沿，属 §7.4 允许的复用场景，  
  但每条候选仍各自执行独立 verifier  
  （`certificateReuse.independentVerifierExecutedPerCandidate = true`）。
- 未覆盖任何历史工件（`PPC-T1-*` / `PPC-T2-*` / `PPC-CAT-STRATEGY-SEAL-01` 均只读引用）。

---

## 四、机器状态

```text
ROUND = PPC-D2-PCV-COUNTERLINE-01
PHASE = D2_SINGLE_ROOT_PILOT
PILOT_ROOT = G1T9
PILOT_ARM = E1
DEPTH_TURNS = 2
SEARCH_MODE = FIXED_DEPTH_D2

D2_SEARCH_COMPLETED = TRUE
D2_NODES = 2727890
D2_LEAF_NODES = 8213463
D2_CHANCE_NODES = 83263
D2_SEARCH_MS = 217108.023
D2_VALUE = -999990.9999999992
D2_MATE = mouse

ROOT_ACTIONS_TOTAL = 4
ROOT_ACTIONS_EXACT = 4
COMPLETE_CAT_PLANS = 4
PLAN_IDENTITY_FAILURES = 0

CANDIDATES_FROZEN = 4
UNIQUE_FRONTIERS = 1

H0_REFUTED = 4
H0_UNRESOLVED = 0
H1_SURVIVAL_PROVEN = 0
H1_UNRESOLVED = 0
PROVEN_TACTICAL_RESCUE = 0

CHANCE_COMPLETE = TRUE
VERIFY_FAILURES = 0
FALSE_PROVEN = 0

ZERO_REPETITIONS_IN_SEARCH = TRUE
PROOF_REP_MATCH = TRUE
SEARCH_REP_MATCH = TRUE
RSS_AFTER_MB = 288.6
HEAP_USED_AFTER_MB = 104.3
V8_HEAP_EXPANDED = NO

PRODUCTION_SOURCE_CHANGED = NO
GAME_RULES_CHANGED = NO
SEARCH_MATH_CHANGED = NO
H1_CHANGED = NO
100MS_150MS_CHANGED = NO

HEAVY_WORKER_CONCURRENCY = 1
SERIAL_FRESH_REPETITIONS = TRUE
SELF_PLAY = NOT_PERFORMED
FULL_REGRESSION = NOT_PERFORMED

COMMIT = NO
PUSH = NO
MERGE = NO

FULL_8_STRATA_BATCH = NOT_AUTHORIZED
PRODUCTION_WIRING = NO
STOP_FOR_CHATGPT_REVIEW = TRUE
```

---

## 五、交付物

```text
D2_PILOT_ROOT_VALUES.json                  4 个根动作的 exact 值 + 全量 diagnostics
D2_PILOT_CANDIDATES.json                   4 条候选全字段 + 前沿 canonical 快照
D2_PILOT_PLAN_REPLAYS.json                 逐条重放步骤与交叉核对
D2_PILOT_COUNTERLINES.json                 4 条鼠主变线（含 CHANCE 分支展开）
CANDIDATE_FREEZE.json                      冻结件（PROOFS_RUN_BEFORE_FREEZE=false）
D2_PILOT_PROOF_REP1.json                   H0/H1 证明（进程 1）
D2_PILOT_PROOF_REP2.json                   H0/H1 证明（进程 2）
D2_PILOT_CERTIFICATE_VERIFICATION.json     证书复用、重复一致性、真/假 PROVEN 审计
D2_PILOT_MATRIX.csv                        4 行 × 36 列，逐候选
D2_MACHINE_STATE.json                      机器状态块
REPORT.md                                  本文件
REPORT_G0G1_PHASE_RECORD.md                G0/G1 只读审计与两次资源准入 FAIL 的原始记录
logs/d2_smoke.json                         冒烟运行原始输出
logs/d2_search_rep2.json                   搜索确定性重复
logs/d2_cost.json                          内存与吞吐核算
logs/proof_rep1_projection.json            证明投影（rep1）
logs/proof_rep2_projection.json            证明投影（rep2）
logs/cost_run.txt                          vitest 原始输出
probe/d2_lib.ts                            试点 harness（新写）
probe/smoke.test.ts / freeze.test.ts / prove.test.ts / determinism.test.ts / cost.test.ts
probe/postprocess.py                       矩阵与机器状态生成
probe/vitest.config.mts                    串行配置（maxWorkers=1, fileParallelism=false）
```

### 5.1 生产隔离复核

```text
src/**                未改动
GAMEPLAY.md           未改动（e000778b…）
evaluation.ts         未改动
correctedHoleLeaf.ts  未改动
expectiminimax.ts     未改动（50d27da5…）
hardTurnPlanner.ts    未改动（27b1ce6d…）
Sidecar / Progress Guard / H1 / 100ms budget / 150ms wall   未接触
```



所有新增内容只写入 `PPC-D2-PCV-COUNTERLINE-01/`。
`COMMIT = NO`，`PUSH = NO`，`MERGE = NO`。

**完成后停止，交 ChatGPT 独立审查。**
