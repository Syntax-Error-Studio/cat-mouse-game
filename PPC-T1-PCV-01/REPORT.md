# PPC-T1-PCV-01 — 计划作用域反线验证（Plan-scoped Counter-line Verification）

**模式**: READ_ONLY_POSTHOC_MEASUREMENT
**仓库**: `F:\小猫小鼠`（唯一权威工作树）
**分支 / HEAD**: `ppc/p1-id-state-identity-fix` / `48eaac6c4f3801d351787696ba5876995b64e8d8`
**日期**: 2026-11-16
**生产源码改动**: 无
**生产接线**: 无
**规则 / 搜索数学改动**: 无
**Sidecar / Guard / H1 / 100ms-150ms 改动**: 无
**自对弈 / 完整回归**: 未执行
**commit / push / merge**: 无

---

## 0. 结论摘要

1. **48 个真实生产 finalPlan 全部可恢复到合法的猫→鼠决策前沿**，240 个观测全部有效；0 个计划身份失败、0 个 `INELIGIBLE`、0 个终端提前结束、0 个 CHANCE 边界不可绑定。48/48 的 finalPlan 与 baselinePlan 相同，但证书只绑定 finalPlan，不绑定 baseline，也不使用 `search.bestAction`。
2. **在“小鼠下一回合”范围内，8/48 个 root-arm strata（4 个根 × 2 臂，40/240 观测）的生产计划被独立验证的小鼠强制胜利反证。** 这 8 个是：G6T3（RDDD）、G5T4（RDLU / RDRR）、G2T8（DDDR）、G1T9（LLLD / LLDL）。全部 `mouseForce_H0=true` 且独立 verifier PROVEN，0 失败。
3. **40/48 个 strata 的 H0 小猫存活被独立验证**（200/240 观测），但这是**弱保证**，只覆盖小鼠下一回合。它不是跨回合安全，也不是 H1 安全。**其中 8/20 个 H0 存活 strata 已有 H1 非存活证据**：2 个本轮 H1 `catSurvive=false`（G5T3 两臂；其中 H1 臂同时有 P4 同 frontier H1 强制胜利），4 个额外的 P4 同 frontier H1 强制胜利（G6T2 两臂、G2T7 两臂），2 个 P4 同 frontier H1 chance-dependent 非存活（G1T8 两臂）。剩余 12/20 的 H1 状态在 5000 节点处截断，仍未决。
4. **只有 20/48 个 strata 有 H1 小猫存活证书**（100/240 观测，独立 verifier PROVEN）。H1 `catSurvive=false` 另有 8 个 strata（其中 2 个属于 H0 存活类），但这些 false **不当作 forced-win 证明**，只记为“H1 存活主张被否定 / 小鼠可能获胜 / chance-dependent risk”。
5. **成本不满足 25ms 生产目标。** 720 次查询：中位数 3.35ms，p95 383.66ms，最大 1318.17ms；只有 474/720 `<=25ms`。按完整 3 查询 PCV 路径：观测中位数 153.37ms，p95 620.35ms，最大 1756.13ms；只有 68/240 观测 `<=25ms`。按“决定性查询”只算一次（5 次重复 × 48 strata = 240）：中位数 20.03ms，p95 422.98ms，最大 1318.17ms，只有 129/240 `<=25ms`。
6. **`mouseForce_H0` 单查询很便宜**（中位数 1.13ms，p95 6.63ms，234/240 `<=25ms`），但它是**单边反证器**：false 不推出安全，且 G1T9 在 5 次重复中有 3 次（两臂共 6/10 个查询）达到 56–85ms（节点数仍为 659），说明 25ms 目标不稳定。
7. **`catSurvive_H0` 单查询中位数便宜（2.31ms），但长尾严重**（p95 230.2ms，最大 1318.17ms，G1T5 6978 节点）；并且它只覆盖下一小鼠回合，不能作为安全门。
8. **`catSurvive_H1` 在 5000 节点预算下只有 70/240 `<=25ms`，100/240 直接截断。** 证明 H1 存活可以很便宜（14/20 个 H1 证明 `<=25ms`），但不是普遍便宜；G2T6、G1T6、G1T7 的 H1 证明为 31–180ms。
9. **门禁：G0/G1/G2/G4/G5/G6 通过，G3 失败；决策 = AMBER。** G2 强覆盖 full-class 28/48，phase1 合规最小值 20/48（范围 20–22/48），高于 12/48。G3 只有 6/48 有 ≥20ms 余量、1/48 有 ≥40ms 余量，远低于 75% 门槛。升级未触发（G2 已过；G3 余量条件也不满足）。
10. **结论：PCV 是一个可离线工作的“计划反证 + 短期存活证明”测量工具，但不是 25ms 生产门。** 不应接入生产；下一阶段若要继续，只能研究更便宜的单边反证哨兵、选择性 H1 审计，或增量/剪枝后的 H1 存活搜索。`NO_REFUTATION_FOUND` 不是 SAFE，`UNRESOLVED` 不是 PASS。

---

## 1. 本轮四个问题

### Q1：多少实际猫计划能在小鼠下一回合内被强制反证？

**8/48 个 strata，40/240 个观测。** 4 个根 × 2 臂：

| 根 | 臂 | finalPlan | H0 mouseForce 节点 | 根节点小鼠制胜动作 | CHANCE 节点/结果 | solve ms（rep1） | 独立 verifier |
|---|---|---|---:|---|---:|---:|---|
| G6T3 | E1 | RDDD | 67 | R | 7 / 140 | 1.97 | PROVEN |
| G6T3 | H1 | RDDD | 67 | R | 7 / 140 | 1.83 | PROVEN |
| G5T4 | E1 | RDLU | 1 | U | 0 / 0 | 0.02 | PROVEN |
| G5T4 | H1 | RDRR | 1 | U | 0 / 0 | 0.02 | PROVEN |
| G2T8 | E1 | DDDR | 32 | D | 0 / 0 | 0.76 | PROVEN |
| G2T8 | H1 | DDDR | 32 | D | 0 / 0 | 0.76 | PROVEN |
| G1T9 | E1 | LLLD | 659 | R | 36 / 930 | 19.08 | PROVEN |
| G1T9 | H1 | LLDL | 659 | R | 36 / 930 | 19.99 | PROVEN |

这 8 个都是**在真实 post-prefix frontier 上**、以真实 RuleSet 重放、独立 verifier 重新枚举所有小鼠动作与所有正概率 CHANCE 结果后确认的。证书保留在 `_raw/rep*/` 与 `PROOF_RESULTS.json`。

### Q2：多少计划能被独立证明至少存活小鼠下一回合？

- **H0 存活：40/48 个 strata，200/240 观测**（H0 `catSurvive=true` + verifier PROVEN）。这是任务书要求的弱保证。
- **H1 存活：20/48 个 strata，100/240 观测**（H1 `catSurvive=true` + verifier PROVEN）。这是两回合（鼠标→猫→鼠标）的存活证明。
- **H1 明确 false：8/48 个 strata**，其中 6 个已被 H0 反证，2 个（G5T3/E1、G5T3/H1）H0 存活但 H1 不存活。按任务书，false 不当作 forced-win 证明，只记为风险。
- **H1 未决：20/48 个 strata**（18 个 H0 存活 strata + 2 个 H0 已反证但 H1 截断的 G6T3 strata）。因此“H0 存活 40/48”**不能**升级为“跨回合安全 40/48”。

### Q3：节点与时间成本？

见 §6。核心数字：

- `mouseForce_H0`：240 查询，中位数 1.13ms，p95 6.63ms，最大 93.16ms；234/240 `<=25ms`；0 截断。
- `catSurvive_H0`：240 查询，中位数 2.31ms，p95 230.2ms，最大 1318.17ms；170/240 `<=25ms`；0 截断。
- `catSurvive_H1_phase1`：240 查询，中位数 133.48ms，p95 475.46ms，最大 550.42ms；70/240 `<=25ms`；100/240 截断。
- 完整 3 查询 + verifier 的 PCV 观测：中位数 153.37ms，p95 620.35ms，最大 1756.13ms；68/240 `<=25ms`。
- 决定性查询（每 strata 只取一个，5 次重复共 240 个）：中位数 20.03ms，p95 422.98ms，最大 1318.17ms；129/240 `<=25ms`。

### Q4：是否存在适合未来生产决策的低成本证明路径？

**在当前冻结内核 + 25ms 目标下，没有普遍可行的生产证明门。**

- 单边 `mouseForce_H0` 是最便宜的，但它只能反证，不能证明安全；它漏掉 H1-only 风险（例如 G5T3），而且 G1T9 的 93ms 离群说明 25ms 不稳定。
- `catSurvive_H0` 的中位数便宜，但长尾到 1.3s，且只覆盖一回合；8/20 个 H0 存活 strata 已有 H1 非存活证据。
- `catSurvive_H1` 只有 20/48 得到证明，100/240 截断，成本中位数 133ms；不能作为 25ms 门。
- 因此本轮**不建议生产接线**。可行的下一阶段方向是：把 PCV 作为离线审计/选择性 H1 抽查；或研究严格节点上限下的单边反证哨兵，并把所有超时显式标为 UNKNOWN，而不是安全。

---

## 2. 范围与边界

本轮只做只读、事后、计划作用域测量：

- 读取冻结 fixture、P5 生产观测、SEAL 量词内核、P4 历史证书；
- 重放每个观测的真实 finalPlan，恢复到猫→鼠边界；
- 在边界上运行 H0 `mouseForce`、H0 `catSurvive`、H1 `catSurvive`；
- 用独立 verifier 复核每个 true；
- 不修改生产源码、规则、评估器、搜索数学、Sidecar、Guard、鼠 AI、H1 逻辑、100ms/150ms 预算；
- 不运行自对弈、完整回归、METHOD_A、大搜索 benchmark、正式计时 benchmark；
- 不 commit / push / merge / reset / clean / stash。

本轮唯一新增目录是 `PPC-T1-PCV-01/`。

---

## 3. 来源、身份与资源核对

### 3.1 权威性

| 项目 | 值 |
|---|---|
| 分支 | `ppc/p1-id-state-identity-fix` |
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8` |
| `GAMEPLAY.md` SHA256 | `e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34` |
| fixture SHA256 | `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09` |
| P5 `PRODUCTION_100MS_RESULTS.json` SHA256 | `9d50560f107da52107cb68be94f4ac90214f8a50aabbc948f8f3114215278775` |
| SEAL 内核 `seal_lib.ts` SHA256 | `453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b` |
| `preparedActions.ts` SHA256 | `67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764` |
| `expectiminimax.ts` SHA256 | `50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c` |
| `engine.ts` SHA256 | `099f9a7b6d97b838c664aa7186be58465e5b01b8052af4b4e4e19a5644d19f06` |
| FOUNDATION 预注册 SHA256 | `3dd79a40fda42af91056c3662fbb92ae0ad0da2c9fa9e50670eea139f3b06bfc` |

P2、SEAL、ERRATUM、FOUNDATION 的历史工件均只读引用；关键 manfest 哈希记录在 `SOURCE_MANIFEST.json`。

### 3.2 Git 状态

- 本轮开始与结束时：分支与 HEAD 不变；
- 工作树有 **15 个已跟踪源码修改 + 50 个未跟踪条目**（共 65 条 porcelain）；这些已跟踪修改是**本轮之前已存在**的 P1/P2 工作树状态，本轮没有触碰；
- 本轮新增的未跟踪目录是 `PPC-T1-PCV-01/`；
- 冻结的 4 个关键源码/规则哈希与任务书给定值一致；
- 未执行任何 git 写操作。

### 3.3 资源与重复检查

- 开始前检查：无重复 PCV benchmark、无遗留 PCV Node/worker/shell；未终止任何用户进程；
- 系统中存在无关的 `docmap-studio` Next dev 进程（PIDs 2500/11644/40300/14184）以及一个 review `resume-run.mjs` 进程（PID 10492，13:49 启动，测量期间仍在运行，低 CPU）；未终止它们；
- RAM 15.71GB total，空闲 2.25GB；commit limit 33.42GB，空闲 6.69GB；
- 5 次重复串行、每次独立进程；`logs/run_log.txt` 的 START/END 时间戳无重叠；
- 每次重复 RSS 300–322MB，heap 143–173MB；未使用 worker pool / `Promise.all` / V8 heap 扩展；
- 未降低 600000 正确性上限，未减少 240 观测，未替换 24 个人类根。

---

## 4. 协议与执行

### 4.1 冻结输入

- 24 个人类根，fixture SHA 冻结；
- E1 基线 / H1 corrected-hole 两臂；
- P5 每个 root-arm 5 轮生产观测，`finalPlan` 唯一且与 `executedLabels` 一致；
- 48 个 root-arm strata × 5 次新进程重复 = 240 个观测。

### 4.2 前沿恢复

对每个 observation：

1. 从 `hardRoot` 恢复根状态；
2. 用真实 `generatePreparedSearchActions` / `simulateSearchAction` / `createEngineRuleSet` 重放 `finalPlan`；
3. 对 CAT→MOUSE 边界 CHANCE 做真实枚举，不做 RNG；
4. 检查每个 branch 的 `phase=playing`、`currentPlayer=mouse`、`catMovesLeft=0`；
5. 与冻结 SEAL `applyPrefix` 的 post-prefix stateKey 交叉核对；
6. 记录完整 post-prefix stateKey、边界类型、分支数、butter/ghost/debt/trap/moves。

结果：

- 240/240 观测 `VALID_MOUSE_FRONTIER`；
- 48/48 strata `bindingOk=true`，0 个 `INELIGIBLE`、0 个 `INCONSISTENT`；
- 所有 frontier 都是 `playing/mouse/catMovesLeft=0`；
- 48/48 都是单 branch；32 个确定性边界，16 个退化 CHANCE（1 个正概率结果）；
- 22/48 个 frontier 的鼠有黄油；48/48 有陷阱位置；0 个 pending butter spawn / placement debt；
- `baselinePlan == finalPlan` 48/48，`fallbackCount=0`，`overrideCount=0`，但证书绑定的是 finalPlan，不是 baseline。

### 4.3 查询

| 查询 | 参数 | 用途 |
|---|---|---|
| `mouseForce_H0` | H=1, startIdx=1, cap=600000 | 小鼠下一回合强制胜利反证 |
| `catSurvive_H0` | H=1, startIdx=1, cap=600000 | 小猫下一回合存活（弱） |
| `catSurvive_H1_phase1` | H=2, startIdx=1, cap=5000 | 两回合小猫存活（G2 强覆盖） |

每个 true 都调用对应的独立 verifier（`verifyMouseCertificate` / `verifyCatCertificate`），verifier 重新枚举所有对手动作和所有正概率 CHANCE 结果，不共享 solve 的布尔组合器；缺失/非法 policy 条目视为硬失败。

未运行 `mouseForce_H1`；未做 20000/40ms 升级；未做 H2；未做自对弈/完整回归。

---

## 5. 结果：48 个 strata

### 5.1 分类总表

| 分类 | strata | 观测 | 含义 |
|---|---:|---:|---|
| `REFUTED` | 8 | 40 | H0 小鼠强制胜利 + verifier PROVEN |
| `SURVIVES_WITHIN_H1` | 20 | 100 | H0 存活 + H1 存活 + verifier PROVEN |
| `SURVIVES_WITHIN_H0` | 20 | 100 | H0 存活；H1 未证明（18 截断，2 false） |
| `CHANCE_DEPENDENT_RISK` | 0 | 0 | H0 两个方向都 false；本样本无 |
| `UNKNOWN` | 0 | 0 | 本样本无 |
| **合计** | **48** | **240** | |

### 5.2 H0 反证（8/48）

见 §1 Q1。补充：

- G5T4 是 1 节点终局反证：计划执行完后，小鼠根动作 U 立即进入小鼠胜利；
- G2T8 是 32 节点、无 CHANCE 的反证，根动作 D；
- G6T3 是 67 节点、7 个 CHANCE 节点 / 140 个结果的反证，根动作 R；
- G1T9 是 659 节点、36 个 CHANCE 节点 / 930 个结果的反证，根动作 R；节点数稳定，但墙钟在 5 次重复中呈双峰（19–22ms vs 56–85ms），说明墙钟受环境扰动。

这 8 个分类在 5 次重复中完全一致，节点数、value、proof status、verifier leaves 完全一致。

### 5.3 H1 存活（20/48）

10 个根 × 2 臂：

| 根 | 臂 | finalPlan | H1 节点 | H1 solve ms（rep1） | verifier leaves | 查询总 ms（solve+verify） | `<=25ms` |
|---|---|---|---:|---:|---:|---:|---|
| G5T2 | E1 | DDLL | 291 | 9.2 | 845 | 20.9 | 是 |
| G5T2 | H1 | DDLL | 291 | 7.8 | 845 | 19.0 | 是 |
| G2T1 | E1 | TRRRR | 180 | 4.8 | 519 | 10.7 | 是 |
| G2T1 | H1 | TRRRR | 180 | 4.5 | 519 | 10.2 | 是 |
| G2T2 | E1 | DLUL | 122 | 3.3 | 328 | 7.4 | 是 |
| G2T2 | H1 | DDDD | 114 | 2.9 | 307 | 6.4 | 是 |
| G2T5 | E1 | DDDL | 228 | 6.1 | 623 | 13.4 | 是 |
| G2T5 | H1 | DDDL | 228 | 6.3 | 623 | 14.4 | 是 |
| G2T6 | E1 | LUUU | 3349 | 89.7 | 11380 | 180.4 | 否 |
| G2T6 | H1 | LUUU | 3349 | 87.6 | 11380 | 176.2 | 否 |
| G1T1 | E1 | TDDDD | 146 | 4.4 | 431 | 11.3 | 是 |
| G1T1 | H1 | TDDDD | 146 | 4.4 | 431 | 11.1 | 是 |
| G1T2 | E1 | DRRD | 120 | 3.8 | 340 | 8.7 | 是 |
| G1T2 | H1 | DRRD | 120 | 3.7 | 340 | 8.6 | 是 |
| G1T3 | E1 | UUUL | 179 | 6.1 | 470 | 12.4 | 是 |
| G1T3 | H1 | RRRR | 170 | 4.5 | 423 | 10.4 | 是 |
| G1T6 | E1 | UURD | 2164 | 61.7 | 6952 | 125.6 | 否 |
| G1T6 | H1 | URRD | 1078 | 31.0 | 3609 | 65.5 | 否 |
| G1T7 | E1 | RRRU | 1105 | 32.3 | 3756 | 66.0 | 否 |
| G1T7 | H1 | RRRL | 990 | 29.2 | 3394 | 60.7 | 否 |

14/20 个 H1 证明 `<=25ms`；6/20 超过。H1 `catSurvive` 的 5000 节点上限使 100/240 查询截断；这些截断全部记为 `UNRESOLVED_CAP`，没有当成 false 或 true。

### 5.4 H0 存活但 H1 未证明（20/48）

10 个根 × 2 臂：

| 根 | 臂 | finalPlan | H1 状态 | 备注 |
|---|---|---|---|---|
| G6T1 | E1 | UTRDL | 5001 截断 | H1 未知 |
| G6T1 | H1 | TDRRD | 5001 截断 | H1 未知 |
| G6T2 | E1 | UURR | 5001 截断 | **P4 同 frontier H1 强制胜利 78,839 节点** |
| G6T2 | H1 | UURR | 5001 截断 | **P4 同 frontier H1 强制胜利 78,839 节点** |
| G5T1 | E1 | DLUTR | 5001 截断 | H1 未知 |
| G5T1 | H1 | TRRDD | 5001 截断 | H1 未知 |
| G5T3 | E1 | LLDR | **H1 false，1543 节点** | H1 存活被否定；不是 forced-win 证明 |
| G5T3 | H1 | LDDD | **H1 false，729 节点** | P4 同 frontier H1 强制胜利 729 节点 |
| G2T3 | E1 | LDLD | 5001 截断 | H1 未知 |
| G2T3 | H1 | LDLD | 5001 截断 | H1 未知 |
| G2T4 | E1 | DLLL | 5001 截断 | H1 未知 |
| G2T4 | H1 | DLLL | 5001 截断 | H1 未知 |
| G2T7 | E1 | URUU | 5001 截断 | **P4 同 frontier H1 强制胜利 318,940 节点** |
| G2T7 | H1 | URUU | 5001 截断 | **P4 同 frontier H1 强制胜利 318,940 节点** |
| G1T4 | E1 | LLLL | 5001 截断 | H1 未知 |
| G1T4 | H1 | LLLL | 5001 截断 | H1 未知 |
| G1T5 | E1 | ULUL | 5001 截断 | H1 未知；H0 存活本身 424.7ms |
| G1T5 | H1 | ULUL | 5001 截断 | H1 未知；H0 存活本身 418.4ms |
| G1T8 | E1 | LDRL | 5001 截断 | **P4 同 frontier H1 catSurvive=false，但 mouseForce=false（548 节点，chance-dependent）** |
| G1T8 | H1 | LLUR | 5001 截断 | **P4 同 frontier H1 catSurvive=false，但 mouseForce=false（548 节点，chance-dependent）** |

关键负向结论：

- **H0 存活不是 H1 安全。** 20 个 H0 存活 strata 中，8 个已有 H1 非存活证据（2 个本轮 H1 false；4 个 P4 同 frontier H1 强制胜利；2 个 P4 同 frontier H1 chance-dependent 非存活）。
- 5 个 P4 同 frontier H1 强制胜利的 strata 是：G6T2/E1、G6T2/H1、G5T3/H1、G2T7/E1、G2T7/H1。它们的 P4 plan、postStateKey 与 P5 **完全相同**，P4 证书独立验证，节点数分别为 78,839、78,839、729、318,940、318,940。
- G5T3/H1 是一个强一致性校验：本轮 H1 `catSurvive` 在 729 节点得到 false，P4 H1 `mouseForce` 在同样 729 节点得到 true；两个独立方向、同一 frontier、同一 plan，互相印证。
- 剩余 12 个 H0 存活 strata 的 H1 状态仍是未知；不能写成“安全”。

---

## 6. 成本

### 6.1 单查询

| 查询 | n | 中位数 | p95 | 最大 | `<=25ms` | 截断 |
|---|---:|---:|---:|---:|---:|---:|
| `mouseForce_H0` | 240 | 1.13ms | 6.63ms | 93.16ms | 234/240 | 0 |
| `catSurvive_H0` | 240 | 2.31ms | 230.20ms | 1318.17ms | 170/240 | 0 |
| `catSurvive_H1_phase1` | 240 | 133.48ms | 475.46ms | 550.42ms | 70/240 | 100/240 |
| 全部查询 | 720 | 3.35ms | 383.66ms | 1318.17ms | 474/720 | 100/720 |

### 6.2 组合路径

| 指标 | 中位数 | p95 | 最大 | `<=25ms` |
|---|---:|---:|---:|---:|
| 单观测完整 PCV（3 查询 + verifier） | 153.37ms | 620.35ms | 1756.13ms | 68/240 |
| 决定性查询（每 strata 1 个，5 reps） | 20.03ms | 422.98ms | 1318.17ms | 129/240 |

### 6.3 观察

- `mouseForce_H0` 是最便宜的；但其 25ms 命中不是 100%：G1T9 在两臂、5 次重复中共 10 次查询，只有 4 次 `<=25ms`，其余 6 次 56–85ms。节点数始终是 659，差异来自环境/调度/GC，而非搜索规模。
- `catSurvive_H0` 的中位数很低，但长尾由 G1T5（6978 节点，solve+verify 约 425ms/次）和 G6T2/G2T7 等支撑；最大 1318ms。
- `catSurvive_H1` 在 5000 节点上限下最大 550ms，但 100/240 截断；这说明预注册 phase1 的 5000 节点并不能保证 25ms，只保证一个粗略上界。
- 完整 PCV 路径在 68/240 观测 `<=25ms`；即使只跑决定性查询，也只有 129/240（53.8%）。**因此 `WITHIN_25MS=FALSE`。**
- 没有为了满足 25ms 而降低 600000 节点上限、没有截断 H0 证明、没有把超时当成 false/true。

### 6.4 资源

- 5 次重复的测量循环耗时：5.91s / 9.77s / 6.88s / 13.84s / 13.27s；
- RSS：320.8 / 300.1 / 318.7 / 299.6 / 321.7 MB；heapUsed：143.4 / 172.8 / 144.8 / 172.9 / 144.1 MB；
- 峰值 RSS 321.7MB；无 OOM、无 swap 异常；
- 串行进程，无并行 worker；无重复 benchmark。

---

## 7. CHANCE 边界

- 48 个 frontier：32 个 `DETERMINISTIC`，16 个 `DEGENERATE_CHANCE_ONE_OUTCOME`；
- 16 个 CHANCE 边界对应 8 个根 × 2 臂：G6T2、G6T3、G5T2、G2T4、G2T5、G2T8、G1T6、G1T9；
- 每个 CHANCE 边界在真实 enumerator 下只有 1 个正概率结果；
- 量词按“所有正概率结果 AND”执行，未使用 `Math.random`，未选择有利结果；
- 没有 `CONDITIONAL_ON_REALIZED_BOUNDARY`，没有 `CHANCE_DEPENDENT_RISK` 分类；
- 该退化性是本样本的性质，不是一般保证；多结果 CHANCE 在下一阶段必须重新验证。

---

## 8. 门禁与决策

### G0 — 来源身份：PASS

- 分支/HEAD 与任务书一致；
- fixture、P5、SEAL kernel、GAMEPLAY、preparedActions 哈希一致；
- P5 的 `head` 与 `fixtureSha256` 一致；
- 15 个已跟踪源文件修改是预先存在的，本轮未触碰；未覆盖/重建任何冻结源。

### G1 — 零假证明：PASS

- 720 个查询结果中，340 个 true，全部独立 verifier PROVEN；
- `VERIFY_FAILURES=0`；
- `FALSE_PROVEN=0`；
- `capAsProof=0`（100 个截断全部是 UNRESOLVED，不是 PROVEN）；
- `contradictions=0`（没有同时 PROVEN 的 `mouseForce` 与 `catSurvive`）；
- `policyMisses=0`；
- 所有 false 都没有被 verifier 当成 true；
- 没有从 `!mouseForce` 推导 `catSurvive`。

### G2 — 证明覆盖：PASS

- full-class 强覆盖：`8 REFUTED + 20 SURVIVES_WITHIN_H1 = 28/48`；
- phase1 合规强覆盖（决定性 solve `<=5000` 节点且 `<=20ms`）：最小 `20/48`，范围 `20–22/48`；
- 门槛 `12/48`：通过；
- 参考值：任意 `catSurvive` 已验证 40/48；任意已验证证明 48/48；这些不计入 G2。

### G3 — 预算可行性：FAIL

- P5 `turnWallMs.max` 对应余量：
  - `slackMax >= 40ms`：1/48（仅 G5T4/E1，41.3ms）；
  - `slackMax >= 20ms`：6/48（G6T3 两臂、G5T3 两臂、G5T4 两臂）；
  - 其余 42/48 `<20ms`；
- P5 已有 182/240 次运行超过 150ms；
- 要求 75% 组合有 ≥40ms 余量，实际 1/48；FAIL。

### G4 — 生产隔离：PASS

- 生产 finalPlan 未改动；48/48 重放一致；
- 0 fallback、0 override；
- 生产源码/规则/评估器/搜索数学/Sidecar/Guard/鼠 AI/H1/100ms-150ms 均未改动；
- 本轮是离线测量，不接线。

### G5 — 计划身份绑定：PASS

- fixture SHA、P5 SHA、kernel SHA、preparedActions SHA、GAMEPLAY SHA 一致；
- 240/240 root stateKey、finalPlan、planHash、post-prefix stateKey、boundary identity 完整；
- 240/240 `bindingOk`；
- 240/240 与 SEAL `applyPrefix` 的 post-state 一致；
- 证书绑定的是 finalPlan + post-prefix frontier，不是 `search.bestAction`，不是 baseline；
- `PLAN_IDENTITY_FAILURES=0`。

### G6 — 证据阶梯：PASS

- `TACTICAL_SIGNAL`：H0 `mouseForce=false` / H0 存活 true；
- `TACTICAL_CANDIDATE`：H0 存活（弱，不升级）；
- `TACTICAL_PROOF`：H0 `mouseForce=true`；H1 `catSurvive=true`；
- `TACTICAL_DECISION`：未达到（G3 fail，离线 only）；
- `NO_REFUTATION_FOUND` 没有被升级为 SAFE；
- `UNRESOLVED` 没有被当成 PASS；
- `catSurvive=false` 没有被当成 forced-win 证明；
- 没有任何 conditional chance 被当成无条件覆盖。

### 决策

**AMBER。** G0/G1/G2/G4/G5/G6 通过，G3 失败。不是 GREEN；不是 RED/INVALID（没有假证明、身份失败或覆盖不足）。

**升级：NOT_TRIGGERED。** 预注册升级条件为“G2 <12/48 且 75% 组合有 ≥40ms 余量”；G2 已通过，G3 余量只有 1/48，两个条件都不满足。未运行 20000/40ms 升级。

---

## 9. 重要案例与限制

### 9.1 H0 存活不能当安全门

最强的反例是 G6T2/UURR 与 G2T7/URUU：本轮 H0 存活为 true（G6T2 H0 存活 1893 节点；G2T7 H0 存活 1460 节点），但 **P4 在完全相同的 finalPlan 和 postStateKey 上**已经独立验证了 H1 小鼠强制胜利（78,839 / 318,940 节点）。这不是“可能风险”，而是已有证书的 H1 失败。G5T3/LDDD 更直接：本轮 H1 `catSurvive` 与 P4 H1 `mouseForce` 都在 729 节点给出“小鼠获胜”一侧的结果。

因此：

- `SURVIVES_WITHIN_H0` 只能读作“下一小鼠回合存活”，不能读作“计划安全”；
- 不能把 H0 存活数量 40/48 作为生产安全覆盖率；
- 不能把 `NO_REFUTATION_FOUND` 升级为 SAFE。

### 9.2 H1 证明也不等于全局安全

20/48 的 H1 存活证明只覆盖鼠标→猫→鼠标一个窗口，不覆盖更长回合、后续黄油/幽灵、或猫的下一计划。H1 证明是**局部战术证明**，不是全局必胜/必不败。

### 9.3 墙钟噪声

同一节点数、同一机器、同一进程外串行重复，G1T9 的 `mouseForce` 墙钟从 19ms 变到 85ms；G1T5 的 H0 存活最大 1318ms。测量期间存在无关的 Node 进程（docmap-studio dev server 和 review runner），未终止。25ms 结论是**离线可行性**，不是生产实时保证；生产还必须考虑 GC、调度、机器负载、UI 线程。

### 9.4 CHANCE 退化

本样本 16 个 CHANCE 边界全部只有一个正概率结果；这使 AND 退化为单分支。不能据此认为多结果 CHANCE 也便宜；多结果边界会同时放大 solve 和 verifier 成本。

### 9.5 分类层级

官方分类 `SURVIVES_WITHIN_H0` 不包含 H1 信息。为避免误读，`ROOT_ARM_SUMMARY.csv` 额外给出：

- `refutationLevel`：`H0_MOUSE_FORCE_PROVEN` / `H1_CAT_SURVIVE_REFUTED` / `NONE`；
- `h0Refuted` / `h1Refuted`；
- `priorP4H1MouseForcedWin` / `priorP4H1CatSurvive` / `priorP4H1Nodes`。

任何使用本报告的下游，必须同时看 `class` 和 `refutationLevel`，不能只看 `class`。

### 9.6 未执行项

- `mouseForce_H1` 未执行；
- H2 及以上未执行；
- 20000/40ms 升级未触发；
- 自对弈、完整回归、METHOD_A、大 benchmark、正式计时 benchmark 未执行；
- 生产接线未做。

---

## 10. 建议（仅供下一阶段评审，不是生产指令）

1. **不要接入生产。** 本轮 AMBER + G3 fail，25ms 目标不成立。
2. 若继续 PCV，优先研究**单边反证哨兵**：只跑 `mouseForce_H0`，严格节点/墙钟上限，超时/截断一律 UNKNOWN，false 不推出安全；用于“发现坏计划”，不用于“证明好计划”。
3. 若需要存活保证，必须解决 H1 成本：当前 20/48 覆盖、100/240 截断、中位数 133ms；可研究选择性 H1（只对高风险/高价值计划）、增量缓存、或更强的剪枝，但必须先只读测量，不得直接接线。
4. 任何下一阶段提案都必须把 **H0 存活 ≠ H1 安全** 写进门禁；至少要把 P4 已有的 5 个同 frontier H1 反例作为负样本保留。
5. 不因本轮 G2 通过而提高生产搜索预算；G2 通过只说明“离线证明能力存在”，不说明“100ms 内可用”。

---

## 11. 机器状态（最终）

```
CURRENT_PCV_CAPABILITY = H0_REFUTATION_AND_H1_SURVIVAL_PROOF_OFFLINE_ONLY
OBSERVATIONS_TOTAL = 240
OBSERVATIONS_VALID = 240
ROOT_ARM_STRATA_TOTAL = 48
ROOT_ARM_STRATA_WITH_PROOF = 28/48 (strong full-class: 8 REFUTED + 20 SURVIVES_WITHIN_H1)
ROOT_ARM_STRATA_WITH_PROOF_PHASE1_MIN = 20/48 (range 20-22/48)
ROOT_ARM_STRATA_WITH_ANY_VERIFIED_PROOF = 48/48 (not a safety metric)
MOUSE_FORCE_PROVEN = 8/48
CAT_SURVIVE_PROVEN = 40/48 (H0); H1 = 20/48
H0_SURVIVAL_ONLY = 20/48
H0_SURVIVAL_WITH_H1_NON_SURVIVAL_EVIDENCE = 8/20
H0_SURVIVAL_H1_QUERY_UNRESOLVED = 18/20
H0_SURVIVAL_H1_NO_EVIDENCE = 12/20
H1_SURVIVAL_REFUTED = 8/48 (catSurvive=false; NOT a forced-win proof)
H1_SURVIVAL_UNRESOLVED = 20/48 (18 H0-survival + 2 G6T3)
CHANCE_DEPENDENT_RISK = 0/48
UNRESOLVED = 0/48 (official class); H1 survival unresolved = 20/48
WITHIN_25MS = FALSE
PCV_MEDIAN_MS = 153.37
PCV_P95_MS = 620.35
PCV_MAX_MS = 1756.13
DECISIVE_QUERY_MEDIAN_MS = 20.03
DECISIVE_QUERY_P95_MS = 422.98
DECISIVE_QUERY_WITHIN_25MS = 129/240
VERIFY_FAILURES = 0
FALSE_PROVEN = 0
PLAN_IDENTITY_FAILURES = 0
G2_STRONG_COVERAGE = PASS (28/48 full; 20/48 phase1 min)
G3_BUDGET_FEASIBILITY = FAIL (6/48 >=20ms; 1/48 >=40ms)
DECISION = AMBER
ESCALATION = NOT_TRIGGERED
PRODUCTION_SOURCE_CHANGED = NO
PRODUCTION_WIRING = NO
GAME_RULES_CHANGED = NO
SEARCH_MATH_CHANGED = NO
100MS_150MS_CHANGED = NO
SELF_PLAY = NOT_PERFORMED
FULL_REGRESSION = NOT_PERFORMED
COMMIT = NO
PUSH = NO
MERGE = NO
```

---

## 12. 工件索引

| 文件 | 内容 |
|---|---|
| `REPORT.md` | 本报告 |
| `PREREGISTRATION_AMENDMENT.md` | 参数冲突、H1 范围、CHANCE 口径、G2/G3 对齐 |
| `OBSERVATIONS_240.json` | 240 个观测，每个含 plan/baseline、postStateKey、边界、三查询结果、certHash |
| `ROOT_ARM_SUMMARY.csv` | 48 个 strata 的平面表，含 class、refutationLevel、P4 只读标注、成本、余量 |
| `PROOF_RESULTS.json` | 每个 strata 的代表性证书与 policy entries |
| `CERTIFICATE_VERIFICATION.json` | 独立 verifier 汇总与每个 strata 的验证结果 |
| `RESOURCE_SAFETY_LOG.md` | 资源、进程、串行重复、噪声与未终止工作负载 |
| `SOURCE_MANIFEST.json` | 输入/方法/输出哈希（不含自身哈希） |
| `SHA256SUMS.txt` | 所有交付物与原始 rep 的哈希与字节数 |
| `_raw/rep1.json` … `rep5.json` | 5 次新进程重复的原始输出 |
| `_raw/AGGREGATE.json` | 聚合、门禁、决策、成本、确定性 |
| `_raw/replay_all.json` | 48 个计划的无搜索重放验证 |
| `_raw/pilot.json` | 试点成本探针（仅探针，不进入 240 观测） |
| `logs/run_log.txt` | 5 次重复的 START/END 时间戳 |
