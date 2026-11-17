# PPC-T2-PCV-RESCUE-01 候选来源审计

## 1. 结论

冻结 P5 生产工件 **不包含** `planBranches` 或任何替代计划清单，因此本轮按预注册允许的回退路径，仅对 8 个冻结 strata 执行固定 D1 的离线候选生成，标记为 `OFFLINE_REGENERATED_D1`。

- 候选生成方法：每个 stratum 一次固定 D1 **精确**搜索（TT/AB/ordering 全关，全窗口，真实合法顺序，8,000,000 节点上限），用同一搜索的 `planBranches` 从每个根动作继续走完整猫回合。
- 16/16 候选的续写来源均为 `same_exact_d1_plan_branches`，未使用 `fresh_exact_d1_fallback`。
- 候选清单在**任何量词证明之前**冻结并哈希：`8f5a3f9d99ac2f61c895255e72650b3761418cb58ff5152b7d5e94619f8fc3ed`（87,474 bytes），`proofsRunBeforeFreeze=false`。
- 与冻结的 P3 D1 工件 `d1_rep1.json` 交叉核对：8/8 strata 的精确根值、选中计划字符串、节点数完全一致，`mismatches=0`。

## 2. P5 工件为何不足

`PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json`（SHA256 `9d50560f...`）的每个 combo 只有以下字段：

```
rootId, arm, roundsUsed, executedLabels, firstActions, baselinePlans,
finalPlans, executedConsistent, firstActionConsistent, baselineConsistent,
finalConsistent, completedDepth, attemptedDepth, nodes, mainElapsedMs,
turnWallMs, deadlineFiredCount, budgetFiredCount, fallbackCount, overrideCount,
matchedPlanCount, overTurnBudgetCount, plannerCalls, finalPhases
```

没有 `planBranches`、没有逐动作候选、没有同一次搜索的替代路线。因此无法从 P5 直接取出“真实搜索分支导出的替代计划”。

本轮**没有**重跑 100ms 主搜索，**没有**使用 6 条 legacy 全回合计划重新枚举，**没有**扩大至 24 根。

## 3. 固定 D1 候选生成协议

对 8 个冻结 strata（`G6T3/E1,H1`、`G5T4/E1,H1`、`G2T8/E1,H1`、`G1T9/E1,H1`）：

1. 从冻结 fixture 恢复人类根。
2. 运行一次固定 D1 精确搜索：
   - `createSearchContext(rules, 8_000_000, TT=false, AB=false, ordering=false, 0, false)`
   - 注入对应臂的叶评价器（E1=`evaluateForCat`，H1=`evaluateCorrectedHoleForCat`）
   - `capturePlan=true`，`searchBestAction(root, 1, ctx)`
3. 记录真实合法顺序下的全部根动作、精确根值、节点数、`planBranches`。
4. 对每个根动作：
   - 若是确定性转移，则从转移后状态沿**同一搜索**的 `planBranches` 继续走，直到猫→鼠边界；
   - 根动作本身结束回合时，计划只含该动作；
   - 只有 `planBranches` 键缺失时才允许 fresh exact-D1 回退（本轮 0 次）。
5. 用真实 RuleSet 回放完整计划（`generatePreparedSearchActions` + 真实转移），要求：
   - 全部动作合法；
   - 猫步数完整消费；
   - 到达 `phase=playing, currentPlayer=mouse, catMovesLeft=0`；
   - `applyPrefix` 与 replay 的 post-prefix stateKey 完全一致。
6. 排除与原始 `finalPlan` 相同的计划；按预声明顺序排序；每 strata 最多 2 条。

**排序规则（在证明前冻结）**：

1. 排除原始 finalPlan；
2. 完整合法鼠边界计划；
3. 不同首步优先；
4. 同一搜索迭代的精确根分支值高者优先；
5. 同值按真实合法动作顺序；
6. 最多 2 条。

## 4. 与冻结 D1 工件的交叉核对

来源：`PPC-CAT-EVALUATOR-ABLATION-01/_raw/d1_rep1.json`，SHA256 `148a2fda5e37ca9f180ca6916f37a43717cff4b176548491375411f1091f80fb`。

| Stratum | 选中计划（本轮=冻结） | 根值一致 | 节点（本轮=冻结） |
|---|---|---|---|
| G6T3/E1 | RDDD | 是 | 44 = 44 |
| G6T3/H1 | RDDD | 是 | 44 = 44 |
| G5T4/E1 | RDLU | 是 | 40 = 40 |
| G5T4/H1 | RDRR | 是 | 40 = 40 |
| G2T8/E1 | DDDR | 是 | 87 = 87 |
| G2T8/H1 | DDDR | 是 | 87 = 87 |
| G1T9/E1 | LLLD | 是 | 65 = 65 |
| G1T9/H1 | LLDL | 是 | 65 = 65 |

全部 8/8 的完整根值向量（含每个合法根动作的 `value/bound/mate`）逐项一致，`mismatches=0`。详细记录：`_raw/D1_CROSSCHECK.json`。

## 5. 冻结候选清单

| Stratum | 候选 | 计划 | 首步 | 精确根值 | 不同首步 | 续写来源 | 边界 | post 状态数 |
|---|---|---|---|---|---|---|---|---|
| G6T3/E1 | C1 | UDRD | U | -1001.71 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G6T3/E1 | C2 | LRRD | L | -1001.71 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G6T3/H1 | C1 | UDRD | U | -1501.71 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G6T3/H1 | C2 | LRRD | L | -1501.71 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G5T4/E1 | C1 | UULR | U | -1350.53 | 是 | same_exact_d1_plan_branches | DETERMINISTIC | 1 |
| G5T4/E1 | C2 | LUUR | L | -1350.53 | 是 | same_exact_d1_plan_branches | DETERMINISTIC | 1 |
| G5T4/H1 | C1 | UDRD | U | -1973.42 | 是 | same_exact_d1_plan_branches | DETERMINISTIC | 1 |
| G5T4/H1 | C2 | LRRD | L | -1973.42 | 是 | same_exact_d1_plan_branches | DETERMINISTIC | 1 |
| G2T8/E1 | C1 | RDDD | R | -614.82 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G2T8/E1 | C2 | UDDD | U | -711.27 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G2T8/H1 | C1 | RDDD | R | -1314.82 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G2T8/H1 | C2 | URRR | U | -1551.67 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G1T9/E1 | C1 | DDRL | D | -1052.21 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G1T9/E1 | C2 | ULLL | U | -1278.42 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G1T9/H1 | C1 | DLLD | D | -1588.55 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |
| G1T9/H1 | C2 | UDDD | U | -1684.34 | 是 | same_exact_d1_plan_branches | DEGENERATE_CHANCE_ONE_OUTCOME | 1 |

- 16/16 候选回放状态为 `VALID_MOUSE_FRONTIER`，`bindingOk=true`。
- 16/16 候选的 post-prefix 状态与其原始计划不同，说明不是同一前沿换标签。
- 12 条 chance 边界全部只有 **1 个正概率结果**；4 条确定性边界。没有多结果 CHANCE，没有选择单一有利结果。

## 6. 被拒绝与因上限未入选的候选

- 原始 finalPlan 全部被排除（每 strata 1 条，共 8 条）。
- 因“每 strata 最多 2 条”而未入选、且**未运行证明**的合法候选：
  - `G2T8/E1`：`LDDR`（根值 -711.27）
  - `G2T8/H1`：`LDDR`（根值 -1611.27）
  - `G1T9/E1`：`RLLL`（根值 -1300.13）
  - `G1T9/H1`：`RDLD`（根值 -1684.34）

这些计划的状态是 **NOT_PROVEN / UNKNOWN**，不得视为安全，也不得视为失败；本轮没有对它们运行量词证明。详细 attempted 记录见 `CANDIDATE_PLANS.json` 的 `attempted` 字段。

## 7. 范围限制

1. 候选只来自固定 D1，不代表生产 100ms 搜索在更深的迭代中会走这些路线。
2. 只保留每个 strata 根值排序最高的 2 条合法替代；负结果只覆盖这 16 条，不是“所有合法替代计划都不存在救援”的穷举结论。
3. P5 的生产 finalPlan 与本轮 D1 候选不是同一搜索深度；本轮没有重跑主搜索，也没有把 D1 候选冒充 P5 计划。
4. 所有证明都绑定到实际回放的计划前缀与 post-prefix stateKey，而不是 `search.bestAction` 或 `baselinePlan`。
