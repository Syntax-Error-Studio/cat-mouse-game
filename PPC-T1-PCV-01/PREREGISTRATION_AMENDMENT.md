# PPC-T1-PCV-01 — 预注册修订记录（追加式）

**轮次**: PPC-T1-PCV-01 — Plan-scoped Counter-line Verification（计划作用域反线验证）
**类型**: READ_ONLY_POSTHOC_MEASUREMENT
**日期**: 2026-11-16
**状态**: 追加式修订；不修改、不覆盖、不重建任何历史预注册参数或历史工件。

---

## 0. 修订原则

本轮严格保留 `PPC-T1-FOUNDATION-01/NEXT_STAGE_PREREGISTRATION.json` 的历史参数与门槛。以下内容只记录：

1. 任务书与冻结预注册之间的参数冲突；
2. 本轮实际执行口径及理由；
3. 未执行或未升级的项目；
4. 事后分类与预注册指标的对齐方式。

所有原始测量、失败、UNRESOLVED 和证书均保留在 `_raw/` 与 `logs/`，未做删除或重算。

---

## 1. 参数冲突与解决

### 1.1 冲突

| 项目 | 冻结预注册（FOUNDATION-01） | 本轮任务书（PCV-01） |
|---|---|---|
| 主量词节点上限 | phase1 `5000`；单次升级 `20000` | `mouseForce H=1 startIdx=1 cap=600000` |
| 主量词墙钟上限 | phase1 `20ms`；升级 `40ms` | 离线目标 `25ms`，允许超出但标 `WITHIN_25MS=FALSE` |
| 证明覆盖 G2 | `12/48`，只计 REFUTED 或 SURVIVES_WITHIN_H1，且需 phase1 合规 | 保留 `12/48`；只计独立 verifier 证明 |
| 预算可行性 G3 | 75% 组合有 ≥40ms 余量 | 保留 75% 余量门槛 |
| H1 范围 | 预注册列出 `catSurvive_H1` 为强模式；升级上限 20000/40ms | 默认不做 240 观测的强制 H1；不得把未执行 H1 写成通过 |

任务书同时要求“不得降低 600000 节点上限”“不得降低正确性阈值”“不得把 48 组合误当 240 独立根”。预注册的 phase1 是**预算口径**，任务书的 600000 是**正确性口径**；两者不能同时作为同一个 solve 的节点上限。

### 1.2 本轮执行口径

| 查询 | H | startIdx | 节点上限 | 墙钟 | 用途 |
|---|---:|---:|---:|---|---|
| `mouseForce_H0` | 1 | 1 | `600000` | 无硬墙钟；事后记录 | 任务书主实验；H0 反证 |
| `catSurvive_H0` | 1 | 1 | `600000` | 无硬墙钟；事后记录 | 任务书要求的独立小猫存活；弱保证 |
| `catSurvive_H1_phase1` | 2 | 1 | `5000` | 无硬墙钟；事后记录 | 预注册 G2 强覆盖的唯一 H1 输入 |

说明：

- **没有降低任何上限**。H0 查询使用任务书的 600000；H1 查询使用预注册 phase1 的 5000。
- **H0 的 600000 不用于 G2 的 phase1 合规判定**。G2 的 phase1 合规只由决定性查询的 `nodes <= 5000 && solveElapsedMs <= 20` 判定；H0 证明的 phase1 状态单独记录，不改变证明真值。
- **H1 查询只做 `catSurvive`，不做 `mouseForce`**。原因见 §2。
- **25ms 是事后可行性标签，不是求解上限**。冻结量词内核没有墙钟 deadline，只有节点上限；墙钟由 `performance.now()` 事后测量，包含独立 verifier。超过 25ms 不截断、不改证明，只标 `WITHIN_25MS=FALSE`。
- **未触发升级**。预注册允许一次 `20000/40ms` 升级，条件是 phase1 强覆盖 `<12/48` 且 75% 组合有 ≥40ms 余量。本轮 G2 已通过（min 20/48），且 ≥40ms 余量只有 1/48，两个条件都不满足，因此不升级。

---

## 2. H1 范围与任务书 §7 的对齐

任务书 §7 要求：默认不要把 plan-frontier H1 做成 240 观测的强制搜索；除非冻结预注册明确要求，否则不要扩展 H1。

冻结预注册的 G2 强覆盖定义明确包含 `SURVIVES_WITHIN_H1`。如果不运行 H1 `catSurvive`，G2 的 `12/48` 无法按预注册口径计算。为避免用 H0 存活冒充 H1 强覆盖，本轮采取**最小必要执行**：

1. 只运行 `catSurvive_H1`，不运行 `mouseForce_H1`；
2. 只使用预注册 phase1 上限（5000 节点），不使用 20000 升级；
3. 对全部 48 个 root-arm strata 统一运行，不做选择性挑选、不做 easy-sample cherry-pick；
4. H1 结果只用于 G2 强覆盖和风险标注，不把 `catSurvive=false` 当作 forced-win 证明（见 §4）；
5. 未执行的 H1 内容（`mouseForce_H1`、H2、跨回合安全）一律保持 NOT_RUN，不写成通过。

如果评审认为“全量 H1 catSurvive”仍超出任务书 §7 的默认范围，可以只采用本轮 H0 反证通道与 H0 存活通道重算一个更窄的覆盖指标；原始 H1 结果保留，不影响 H0 结论。但按预注册 G2 的原始定义，H1 强覆盖必须被测量，因此本轮选择执行最小 H1 查询。

---

## 3. CHANCE 边界处理

任务书允许两种方式：

- **A**：把所有正概率边界结果放入同一个量词 AND；
- **B**：只证明一个已实现结果，并标 `CONDITIONAL_ON_REALIZED_BOUNDARY`，不计入无条件覆盖。

本轮采用 **A**：

- 48 个 frontier 中，32 个是确定性边界（`DETERMINISTIC`），16 个是 CAT→MOUSE 幽灵/黄油 CHANCE 边界；
- 16 个 CHANCE 边界在真实 enumerator 下都只有 **1 个正概率结果**（`DEGENERATE_CHANCE_ONE_OUTCOME`）；
- 因此 AND 退化为单分支，但仍按“所有正概率结果”执行，没有挑选有利结果，没有使用 `Math.random`；
- 未使用方式 B，未产生任何 `CONDITIONAL_ON_REALIZED_BOUNDARY`，`CHANCE_DEPENDENT_RISK` 分类为 0。

限制：本样本的 CHANCE 边界全部退化，不能据此推断一般棋盘上的多结果 CHANCE 也便宜或可忽略；下一阶段如遇到多结果边界，必须重新按 A 执行。

---

## 4. 分类口径与 G2 对齐

### 4.1 官方分类（预注册口径）

| 分类 | 判定 | 计入 G2 强覆盖 |
|---|---|---|
| `REFUTED` | `mouseForce_H0=true` 且独立 verifier PROVEN | 是 |
| `SURVIVES_WITHIN_H1` | `catSurvive_H1=true` 且独立 verifier PROVEN | 是 |
| `SURVIVES_WITHIN_H0` | `catSurvive_H0=true` 且 verifier PROVEN；H1 未证明 | 否 |
| `CHANCE_DEPENDENT_RISK` | H0 两个方向都 false | 否 |
| `UNKNOWN` | 其他未决 | 否 |

### 4.2 G2 数值

- 官方强覆盖（full class）：`REFUTED 8 + SURVIVES_WITHIN_H1 20 = 28/48`。
- phase1 合规强覆盖（决定性 solve `<=5000` 节点且 `<=20ms`）：5 次新进程重复的**最小值** `20/48`，范围 `20–22/48`。
- 门槛 `12/48`：通过。
- 参考值（不计入 G2）：`catSurvive` 任意 horizon 已验证 `40/48`；任意已验证证明 `48/48`。这些参考值不能替代强覆盖。

### 4.3 H1 catSurvive=false 的处理

任务书明确规定：`catSurvive=false` 记为 `POSSIBLE_MOUSE_WIN` 或 `CHANCE_DEPENDENT_RISK`，**不得当作 forced-win 证明**。

本轮严格遵守：

- `catSurvive_H1=false` 的 8 个 strata 不进入 `MOUSE_FORCE_PROVEN`；
- 其中 6 个已经被 H0 `mouseForce` 独立反证（G5T4、G2T8、G1T9 各两臂），分类仍为 `REFUTED`；
- 另外 2 个（G5T3/E1、G5T3/H1）H0 存活为 true、H1 存活为 false，分类仍为 `SURVIVES_WITHIN_H0`，但额外标 `h1Refuted=true` / `refutationLevel=H1_CAT_SURVIVE_REFUTED`；
- 因此 `ROOT_ARM_SUMMARY.csv` 同时保留官方 class 和 `refutationLevel`，避免把“H0 存活”误读为“H1 安全”。

### 4.4 历史 P4 证据的只读标注

本轮不修改历史工件，只读取 `PPC-CAT-EVALUATOR-ABLATION-01/QUANTIFIER_CERTIFICATES.json`，对 42/48 个与 P5 finalPlan 相同且 post-frontier stateKey 相同的 strata 增加只读标注：

- `priorP4PlanSame`、`priorP4PostStateSame`；
- `priorP4H1MouseForcedWin`、`priorP4H1CatSurvive`、`priorP4H1Nodes`。

该标注只用于暴露“H0 存活不等于 H1 安全”，不改变官方分类，不把历史 H1 结果算作本轮新证明。5 个 H0 存活 strata 在**完全相同的 plan 与 frontier** 上已有 P4 独立验证的 H1 mouse forced win（G6T2/E1、G6T2/H1、G5T3/H1、G2T7/E1、G2T7/H1）。这是本轮最重要的负向限制之一。

---

## 5. G3 余量口径

`G3` 沿用预注册的预算可行性检查：

- 每个 combo 的 P5 `turnWallMs.max`（5 轮真实 100ms 规划的最大墙钟）；
- `slackMax = 150 - turnWallMs.max - 5ms`（5ms 为测量/调度缓冲）；
- 要求至少 75% 的 combos 有 `slackMax >= 40ms`。

实际：

- `slackMax >= 40ms`：`1/48`；
- `slackMax >= 20ms`：`6/48`；
- 其余 `42/48` 的可用余量 `<20ms`；
- P5 已有 `182/240` 次运行超过 150ms。

因此 G3 失败。该失败是生产预算现实，不是本轮代码造成的；本轮未改动 100ms/150ms 预算或 deadline。

---

## 6. 重复与资源口径

- `OBSERVATIONS = 48 strata × 5 fresh processes = 240`，全部保留；
- 每个 repetition 是独立 Node 进程，串行启动；`logs/run_log.txt` 的 START/END 时间戳无重叠；
- 未使用 `Promise.all`、worker pool、V8 heap 扩展、`--max-old-space-size`；
- `HEAVY_WORKER_CONCURRENCY = 1`；
- 未降低 240 观测、未替换 24 个人类根、未把 48 组合当作 240 独立根；
- 单次重复内部对 48 个 strata 串行执行，未并行化。

---

## 7. 未执行 / 未升级 / 未接线

| 项目 | 状态 |
|---|---|
| `mouseForce_H1` | NOT_RUN |
| H2 / 跨两回合以上安全 | NOT_RUN |
| 20000/40ms 升级 | NOT_TRIGGERED（G2 已过，G3 余量条件不满足） |
| 多结果 CHANCE 边界 | 本样本不存在；未人为构造 |
| 自对弈 | NOT_PERFORMED |
| 完整回归 | NOT_PERFORMED |
| 生产 planner / evaluator / rules / Sidecar / Guard / 鼠 AI 改动 | NONE |
| 100ms/150ms 预算改动 | NONE |
| commit / push / merge / reset / clean / stash | NONE |

---

## 8. 结论边界

本轮是**离线、事后、计划作用域**测量，不是生产接入，不是新搜索器，不是完整博弈求解器。`REFUTED` 只说明该生产 finalPlan 在小鼠下一回合内存在可验证的强制胜利；`SURVIVES_WITHIN_H1` 只说明该计划在 H1（鼠标→猫→鼠标）内存活；`SURVIVES_WITHIN_H0` 只覆盖小鼠下一回合，**不是跨回合安全**；`NO_REFUTATION_FOUND` 不是 SAFE；`UNRESOLVED` 不是 PASS。任何生产接线都必须另行立项、另行预注册。
