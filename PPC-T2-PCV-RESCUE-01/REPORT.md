# PPC-T2-PCV-RESCUE-01 报告

## 0. 一句话结论

8 条基线全部重新绑定并通过独立复验；16 条在证明前冻结的 D1 替代计划全部在 H0 内被独立证明为**鼠强制胜**，因此没有候选进入 H1，`PROVEN_TACTICAL_RESCUE_H1 = FALSE`（0/8 strata）。

这是一个明确的**负向救援结果**：在冻结的 D1 前两名候选范围内，现有搜索候选没有提供可被独立证书验证的替代防守路线。不得接入生产，也不得把“未被反驳”升级为“安全”。

## 1. 研究问题与答案

| 问题 | 答案 |
|---|---|
| 冻结 P5 是否保留可用的替代计划分支？ | 否。P5 combo 无 `planBranches`、无替代计划清单。 |
| 是否按预注册允许的方式生成替代计划？ | 是。仅 8 个冻结 strata，固定 D1，标记 `OFFLINE_REGENERATED_D1`。 |
| 替代计划是否真实合法？ | 16/16 回放为 `VALID_MOUSE_FRONTIER`，`bindingOk=true`，post-prefix stateKey 完整记录。 |
| 鼠是否能在 H0 内强制获胜？ | 16/16 `mouseForce_H0=true` 且独立 verifier `PROVEN`，policy misses 0。 |
| 猫是否能在 H1 内存活？ | 0 条进入 H1：全部候选已被 H0 反驳；因此没有 H1 存活证书，也没有救援。 |
| 是否存在真正获得量词证明的战术救援？ | 否。0/8 strata。 |

## 2. 身份、范围与预检

- worktree：`F:\小猫小鼠`
- branch：`ppc/p1-id-state-identity-fix`
- HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`
- fixture SHA256：`1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`
- GAMEPLAY SHA256：`e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34`
- P5 SHA256：`9d50560f107da52107cb68be94f4ac90214f8a50aabbc948f8f3114215278775`
- SEAL kernel SHA256：`453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b`
- 生产 `preparedActions.ts` / `expectiminimax.ts` / `engine.ts` 哈希与冻结基线一致。
- 开工前 git 状态为 65 个条目（15 个既有 tracked 修改 + 50 个未跟踪条目）；本轮只新增 `PPC-T2-PCV-RESCUE-01/`，未修改任何生产源码、规则、评价器、Sidecar、Guard、H1 或 100ms/150ms 预算。

### 2.1 上一轮计时口径审计

`PPC-T1-PCV-01` 的 `withinPhase1` 定义是：

```
nodes <= 5000 && solveElapsedMs <= 20
```

即**只覆盖 solve**，不包含独立 verifier 的时间；verifier 的 `verifyMs` 单独记录，总量另算 `solve+verify`。G2 的 20ms 门槛因此是 **solve-only**，不是 solve+verifier。

本轮所有 H1 相关时间仍按这个口径记录；报告同时给出 solve-only 与 solve+verify 两个数字，不能把 solve-only 冒充完整验证时间。

## 3. 基线证书重新绑定

8 个冻结 strata 的原始计划全部从 fixture 根重新回放，post-prefix stateKey 与 T1 记录一致；T1 证书中的 `policyEntries` 重新装载，并用 `verifyMouseCertificate(frontier, policy, H=1, startIdx=1, cap=600000)` 独立复验。

| Root/Arm | 原始计划 | T1 记录 | certHash 重算 | 独立复验 | verifier leaves | policy misses | 绑定 |
|---|---|---|---|---|---|---|---|
| G6T3/E1 | RDDD | PROVEN | 匹配 | PROVEN | 4 | 0 | 是 |
| G6T3/H1 | RDDD | PROVEN | 匹配 | PROVEN | 4 | 0 | 是 |
| G5T4/E1 | RDLU | PROVEN | 匹配 | PROVEN | 2 | 0 | 是 |
| G5T4/H1 | RDRR | PROVEN | 匹配 | PROVEN | 2 | 0 | 是 |
| G2T8/E1 | DDDR | PROVEN | 匹配 | PROVEN | 4 | 0 | 是 |
| G2T8/H1 | DDDR | PROVEN | 匹配 | PROVEN | 4 | 0 | 是 |
| G1T9/E1 | LLLD | PROVEN | 匹配 | PROVEN | 103 | 0 | 是 |
| G1T9/H1 | LLDL | PROVEN | 匹配 | PROVEN | 103 | 0 | 是 |

- 基线认证：**8/8**。
- certHash：**8/8 重算匹配**。
- 独立 verifier：**8/8 PROVEN**，0 policy misses。
- 详细记录：`BASELINE_CERTIFICATES.json`、`CERTIFICATE_VERIFICATION.json`。

## 4. 替代候选的来源与冻结

P5 只有 `finalPlans` / `executedLabels` / `baselinePlans` 等字段，没有 `planBranches`，无法直接取替代分支。因此按预注册回退到固定 D1：

- 每个 stratum 一次精确 D1 搜索（TT/AB/ordering 全关，8M 节点上限，真实合法顺序）。
- 续写来自**同一搜索**的 `planBranches`；16/16 均为 `same_exact_d1_plan_branches`，0 次 fresh fallback。
- 与冻结的 `PPC-CAT-EVALUATOR-ABLATION-01/_raw/d1_rep1.json` 交叉核对：8/8 选中计划、根值向量、节点数完全一致，`mismatches=0`。
- 候选在证明前冻结，SHA256 = `8f5a3f9d99ac2f61c895255e72650b3761418cb58ff5152b7d5e94619f8fc3ed`，`proofsRunBeforeFreeze=false`。

16 条候选全部与原始 finalPlan 不同，且全部采用不同首步：

| Root/Arm | C1 计划（根值） | C2 计划（根值） | 边界 |
|---|---|---|---|
| G6T3/E1 | UDRD (-1001.71) | LRRD (-1001.71) | 12 条 chance 中 2 条 |
| G6T3/H1 | UDRD (-1501.71) | LRRD (-1501.71) | 12 条 chance 中 2 条 |
| G5T4/E1 | UULR (-1350.53) | LUUR (-1350.53) | 确定性 |
| G5T4/H1 | UDRD (-1973.42) | LRRD (-1973.42) | 确定性 |
| G2T8/E1 | RDDD (-614.82) | UDDD (-711.27) | 12 条 chance 中 2 条 |
| G2T8/H1 | RDDD (-1314.82) | URRR (-1551.67) | 12 条 chance 中 2 条 |
| G1T9/E1 | DDRL (-1052.21) | ULLL (-1278.42) | 12 条 chance 中 2 条 |
| G1T9/H1 | DLLD (-1588.55) | UDDD (-1684.34) | 12 条 chance 中 2 条 |

- 16/16 回放状态 `VALID_MOUSE_FRONTIER`，所有动作合法，猫步数完整消费。
- 16/16 的 post-prefix 状态与原始计划不同，说明替代计划确实到达了不同前沿。
- CHANCE 边界：12 条 `DEGENERATE_CHANCE_ONE_OUTCOME`（均只有 1 个正概率结果）+ 4 条 `DETERMINISTIC`。没有多结果 CHANCE，不存在挑选单一有利结果的问题。
- 候选来源与被上限排除的合法计划详见 `CANDIDATE_SOURCE_AUDIT.md`。

## 5. H0 mouseForce 结果

对每条候选的每一个 post-prefix 分支运行：

```
mouseForce, H=1, startIdx=1, cap=600000
```

只有 `value=true` 且独立 verifier `PROVEN` 才标记 `ALTERNATIVE_REFUTED_H0`。

| 候选 | 计划 | 结果 | 节点 | solve ms | verify ms | 总 ms | verifier leaves | misses |
|---|---|---|---|---|---|---|---|---|
| G6T3/E1/C1 | UDRD | REFUTED_H0 | 70 | 5.289 | 0.266 | 5.556 | 4 | 0 |
| G6T3/E1/C2 | LRRD | REFUTED_H0 | 70 | 3.719 | 0.125 | 3.844 | 4 | 0 |
| G6T3/H1/C1 | UDRD | REFUTED_H0 | 70 | 3.585 | 0.111 | 3.695 | 4 | 0 |
| G6T3/H1/C2 | LRRD | REFUTED_H0 | 70 | 3.101 | 0.113 | 3.214 | 4 | 0 |
| G5T4/E1/C1 | UULR | REFUTED_H0 | 1 | 0.048 | 0.026 | 0.074 | 2 | 0 |
| G5T4/E1/C2 | LUUR | REFUTED_H0 | 1 | 0.040 | 0.035 | 0.075 | 2 | 0 |
| G5T4/H1/C1 | UDRD | REFUTED_H0 | 1 | 0.045 | 0.037 | 0.081 | 2 | 0 |
| G5T4/H1/C2 | LRRD | REFUTED_H0 | 1 | 0.041 | 0.033 | 0.074 | 2 | 0 |
| G2T8/E1/C1 | RDDD | REFUTED_H0 | 32 | 1.870 | 0.099 | 1.968 | 4 | 0 |
| G2T8/E1/C2 | UDDD | REFUTED_H0 | 32 | 1.526 | 0.158 | 1.683 | 4 | 0 |
| G2T8/H1/C1 | RDDD | REFUTED_H0 | 32 | 1.309 | 0.109 | 1.418 | 4 | 0 |
| G2T8/H1/C2 | URRR | REFUTED_H0 | 32 | 1.372 | 0.122 | 1.494 | 4 | 0 |
| G1T9/E1/C1 | DDRL | REFUTED_H0 | 682 | 28.385 | 2.534 | 30.918 | 107 | 0 |
| G1T9/E1/C2 | ULLL | REFUTED_H0 | 820 | 26.255 | 2.587 | 28.842 | 131 | 0 |
| G1T9/H1/C1 | DLLD | REFUTED_H0 | 682 | 21.963 | 2.150 | 24.113 | 107 | 0 |
| G1T9/H1/C2 | UDDD | REFUTED_H0 | 682 | 24.067 | 2.226 | 26.292 | 107 | 0 |

- `mouseForce_H0 = true`：**16/16**。
- 独立 verifier `PROVEN`：**16/16**，policy misses 0。
- H0 节点：中位数 51，最大 820。
- H0 solve-only：中位数 **2.49ms**。
- H0 solve+verify：中位数 **2.59ms**，最大 **30.918ms**；`<=25ms` 为 **13/16**。
- 超过 25ms 的 3 条全部在 G1T9（最长 30.918ms），不影响正确性，但说明长尾不能忽略。

代表性前沿检查（`_raw/FRONTIER_INSPECTION.json`）：

- G5T4/E1/C1 的鼠前沿存在立即获胜动作 U（走完后 `phase=mouse_wins`）。
- G6T3/E1/C1 的鼠前沿需要在完整鼠回合内取胜；H0 以 70 节点、4 个 verifier 叶节点给出证书。

这些只是解释性证据；真正的结论以独立 verifier 为准。

## 6. H1 catSurvive 结果

按预注册：只有“未被 H0 证明反驳”的候选才运行 H1。

本轮 16/16 候选全部被 H0 证明反驳，因此：

- H1 运行数：**0**。
- H1 证书数：**0**。
- 状态统一记录为 `NOT_RUN_H0_REFUTED`。
- 这**不**说明这些替代计划在 H1 一定失败；它只说明它们连下一个鼠回合都无法存活，已经不能作为救援路线。

没有把 `false`、`UNRESOLVED`、截断或未运行的 H1 写成任何形式的存活证明。

## 7. 救援判据与矩阵

预注册的救援判据同时要求：

1. BASELINE：`mouseForce_H0 = true` 且独立 verifier `PROVEN`；
2. ALTERNATIVE：`catSurvive_H1 = true` 且独立 verifier `PROVEN`。

本轮：

- 基线满足：8/8。
- 替代计划满足 H1 存活：0/16。
- `PROVEN_TACTICAL_RESCUE_H1`：**0/8 strata**。

`RESCUE_MATRIX.csv` 为每条候选一行，完整保留 H0/H1 的 `value`、`proofStatus`、节点、solve/verify 时间、`truncated`、绑定状态和救援结论；没有删除失败候选。

## 8. 成本与资源

- 2 次 fresh-process 证明重复（rep1、rep2），严格串行，单 worker；判定、节点数、策略和证书完全一致。
- rep1：RSS 166.7MB，heap 84.9MB，测量段 161.74ms。
- rep2：RSS 166.3MB，heap 84.8MB，测量段 163.40ms。
- 基线独立复验共 226 个 verifier 叶节点；替代 H0 共 492 个 verifier 叶节点。
- 没有重跑 100ms 主搜索，没有 self-play，没有完整回归，没有大规模 oracle。
- 没有 Promise.all，没有 worker pool，没有扩大 V8 heap，没有降低 600000 节点正确性上限。

## 9. 门禁

| 门禁 | 结果 |
|---|---|
| T2-G0 身份（HEAD/branch/fixture/P5/kernel/生产源哈希） | PASS |
| T2-G1 零假证明（PROVEN 全部独立复验、0 policy miss） | PASS |
| T2-G2 候选生成完整性（8/8 strata 有候选，16/16 处理） | PASS |
| T2-G3 绑定（root/post-prefix stateKey、计划哈希、证书哈希、冻结哈希） | PASS |
| T2-G4 CHANCE（12 条 chance 全部为正概率结果的 AND，无有利结果挑选） | PASS |
| T2-G5 生产隔离（无源码/规则/搜索数学/H1/Sidecar/Guard/预算改动） | PASS |
| 救援结论 | **NEGATIVE：0/8 strata** |

本轮没有“为了达到成功率”而删除候选，也没有把任何失败或未运行结果升级。

## 10. 限制

1. 候选只来自固定 D1，且每个 strata 只保留根值前 2 条；这不是对所有合法替代计划的穷举。
2. P5 不含 `planBranches`，因此不能声称这些候选就是生产 100ms 搜索在同一迭代中会考虑的路线。
3. 所有候选已被 H0 反驳，所以本轮没有产生任何 H1 存活证据；负结果只覆盖这 16 条计划。
4. 8 个 strata 本身是上一轮已证明会在 H0 内失败的根臂组合；本轮的负结果与“这些根非常危险”一致，但不能外推到其他 40 个 strata 或更深搜索。
5. 没有验证“更低根值排序的第 3/4 条候选”是否存在救援；它们的状态是 UNKNOWN，不是安全也不是失败。

## 11. 建议（仅研究，不接入生产）

1. 若继续研究救援，应先扩大候选来源（例如 D2 或保留每个根动作的完整分支），再按同样“证明前冻结、最多 N 条”的规则运行；不要在看到结果后筛候选。
2. 只在候选未被 H0 反驳时才运行 H1，避免把 H0 已经拒绝的路线误当成 H1 救援。
3. 免证明的“叶值更高”或“动作不同”不能替代战术证书；本轮 16 条不同首步、不同前沿的候选全部被 H0 反驳，正说明这一点。
4. 任何生产接入都需要新的预算裁决；本轮的 25ms 只是离线观测，不是生产门。

## 12. 机器状态

```
T2_RESCUE_STATUS = NO_PROVEN_TACTICAL_RESCUE_H1
STRATA_TOTAL = 8
BASELINE_CERTIFIED = 8/8
BASELINE_CERT_HASH_MATCH = 8/8
CANDIDATES_FROZEN = 16
CANDIDATES_PROCESSED = 16
CANDIDATES_REFUTED_H0 = 16/16
CANDIDATES_H1_RUN = 0
CANDIDATES_H1_CERTIFIED = 0
PROVEN_TACTICAL_RESCUE_STRATA = 0/8
CHANCE_BOUNDARIES = 12 (all one positive-probability outcome)
DETERMINISTIC_BOUNDARIES = 4
CANDIDATE_FREEZE_SHA256 = 8f5a3f9d99ac2f61c895255e72650b3761418cb58ff5152b7d5e94619f8fc3ed
H0_SOLVE_MEDIAN_MS = 2.49
H0_TOTAL_MEDIAN_MS = 2.59
H0_TOTAL_MAX_MS = 30.918
H0_WITHIN_25MS = 13/16
VERIFY_FAILURES = 0
FALSE_PROVEN = 0
PLAN_IDENTITY_FAILURES = 0
PRODUCTION_SOURCE_CHANGED = NO
PRODUCTION_WIRING = NO
GAME_RULES_CHANGED = NO
SEARCH_MATH_CHANGED = NO
H1_CHANGED = NO
SIDECAR_CHANGED = NO
GUARD_CHANGED = NO
100MS_150MS_CHANGED = NO
SELF_PLAY = NOT_PERFORMED
FULL_REGRESSION = NOT_PERFORMED
COMMIT = NO
PUSH = NO
MERGE = NO
DECISION = NEGATIVE_RESCUE__STOP_FOR_REVIEW
```

本轮到此停止，等待 ChatGPT 独立裁决。不得自行接入生产。
