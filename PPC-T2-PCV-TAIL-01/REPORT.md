# PPC-T2-PCV-TAIL-01 — Tail Candidate Certification

- 类型：`READ_ONLY_TAIL_CERTIFICATION`
- 结论：**`NO_PROVEN_TACTICAL_RESCUE_H1`**
- 4 条 tail 记录全部被 H0 `mouseForce` 证书反驳；没有运行 H1；0/4 救援；0 unresolved。
- 本结论只覆盖这 4 条冻结 tail 记录，**不是**对全部合法猫动作的穷举否定。

## 1. 范围与冻结

HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`  
分支：`ppc/p1-id-state-identity-fix`  
fixture：`1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`

四条记录直接读取 `PPC-T2-PCV-RESCUE-01/CANDIDATE_PLANS.json` 的 `strata[].attempted`，未重新生成候选。

工作树在 preflight 时已有 15 个 tracked 修改和 51 个未跟踪条目（共 66 条），其中包括 `src/game/ai/expectiminimax.ts` 和 `src/game/engine.ts` 的既有改动。这些改动属于本轮开始前的工作状态，已原样保留；本轮没有新增任何生产源码修改，冻结的生产文件哈希与预检一致。本轮唯一的 Git 增量是新的 `PPC-T2-PCV-TAIL-01/` 未跟踪目录。

| ID | Root | Arm | Plan | 处理 |
|---|---|---|---|---|
| T1 | G2T8 | E1 | LDDR | 新前沿 |
| T2 | G2T8 | H1 | LDDR | 与 T1 全状态去重 |
| T3 | G1T9 | E1 | RLLL | 独立新前沿 |
| T4 | G1T9 | H1 | RDLD | 与既有 UDDD 证书比较/复用 |

冻结文件：

- `TAIL_CANDIDATES.json` — SHA256 `39cc3569fbe2a9e7955b37e91ef203b07486ff7a02f3998dd32bc8004fcae8b8`，24,338 bytes
- `TAIL_DEDUP_AUDIT.json` — SHA256 `09a860761c31dac40236e70c91d8847a1911a3428174f2be633fcdb087621caa`，99,600 bytes
- `_raw/TAIL_CANDIDATE_FREEZE.json` — `proofsRunBeforeFreeze=false`

证明运行前已完成冻结；证明后没有重排、删除或重组候选。

## 2. 身份与去重审计

四条候选均经真实 RuleSet `generatePreparedSearchActions` 重放，重放判定均为 `VALID_MOUSE_FRONTIER`。比较内容包括根/后置 `stateKey`、完整 canonical state JSON、canonical snapshot SHA256、玩家/阶段/步数、黄油字段、隧道/陷阱/箱子，以及所有正概率 CHANCE 后继。去重只依据完整状态，不依据 plan 字符串或坐标。

| 记录 | dedup group | 后置 snapshot SHA256 | 证据来源 |
|---|---|---|---|
| T1 | `G2T8_LDDR_SHARED` | `cf5d70d7a2077cadbf15fb8cb2d103f00af2bbdefda47c43a1c25d965580b872` | T1 代表新 H0 |
| T2 | `G2T8_LDDR_SHARED` | `cf5d70d7a2077cadbf15fb8cb2d103f00af2bbdefda47c43a1c25d965580b872` | 共享 T1 证明 |
| T3 | `G1T9_E1_RLLL` | `580665cbd9afc4c190109aac488206bc7e992331b9df148cb5ef7163e3dfb67e` | T3 新 H0 |
| T4 | `G1T9_H1_RDLD_REUSES_UDDD` | `6ce748d9157b92783cf175e311a944a6698ca9bff57e173d6cbdfddc570d703f` | 复用 T2 UDDD 证书 + RDLD 独立 verifier |

- T1/T2：G2T8 E1/H1 的根 `stateKey`、后置 `stateKey` 与完整 canonical 状态完全一致，差异字段数 0，因此合并为一个证明组。
- T3：G1T9/E1/RLLL 后置状态独立，保留独立证明。
- T4：G1T9/H1/RDLD 后置完整状态与 T2 `G1T9/H1/C2` 的 UDDD 后置状态一致，canonical SHA 同为 `6ce748d9…`，差异 0；满足复用条件。
- 全部记录根边界 CHANCE 均为 `DEGENERATE_CHANCE_ONE_OUTCOME`：`branchCount=1`，概率 `[1]`，权重和 1。`chanceComplete=true`。
- 身份不匹配数：**0**。

## 3. H0 证明

H0 固定为 `mouseForce`、`H=1`、`startIdx=1`、`cap=600000`。`mouseForce=true` 表示存在老鼠强制策略，因此该候选的猫替代方案被反驳。

| 组 | value | nodes | chance nodes/outcomes | truncated | solve ms | verify ms | total ms | verifier leaves | policy size | cert SHA256 |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|
| `G2T8_LDDR_SHARED`（T1/T2） | true | 32 | 0 / 0 | false | 3.213 | 0.156 | 3.368 | 4 | 3 | `44403ed56fb997a7a25bab7f5e91629aa51429d2c328f654658acc7d1c4d13dc` |
| `G1T9_E1_RLLL`（T3） | true | 728 | 39 / 1096 | false | 48.976 | 4.059 | 53.035 | 115 | 87 | `db8ddef141f8e9be669733d25bd6b768b864983b001a32e37631c1574f48bb4a` |

两条新证书均满足：solve 值为 true、未截断、证书哈希正确、独立 verifier `PROVEN`、`policyMisses=0`。因此 T1、T2、T3 均分类为 `ALTERNATIVE_REFUTED_H0`。

T3 的 solve 为 48.976 ms（Rep2 为 43.926 ms），超过 25 ms；但 H0 没有 25 ms 门限，也没有降低 600,000 节点 cap。该时间仅作为观察记录，不影响 H0 判定。

## 4. T4 证书复用

- 复用来源：`PPC-T2-PCV-RESCUE-01/ALTERNATIVE_PROOF_RESULTS.json`，候选 `G1T9/H1/C2`，plan `UDDD`。
- 源证书：value `true`，PROVEN，未截断，682 nodes，37 chance nodes / 1020 outcomes，81 条 policy，107 verifier leaves，0 policy misses。
- 源 cert SHA256：`14b106d703bd5b7977a6e6aee3acaaf92e275296f6273ec16c9552f64eb510f0`。
- 在 RDLD 后置状态上重算证书材料（使用 RDLD post key）得到相同哈希。
- 未重新 solve；直接以 81 条 UDDD policy 在 RDLD 状态运行独立 `verifyMouseCertificate`：`PROVEN`，107 leaves，`policyMisses=0`，5.423 ms。
- 完整状态差异 0，post key 匹配，证书哈希匹配，独立验证通过。T4 分类为 `ALTERNATIVE_REFUTED_H0_REUSED_CERTIFICATE`。

复用失败时不会被标记为 PROVEN；本轮没有复用失败。

## 5. H1 与救援裁决

四条记录的 H0 均已被严格证明为 true，因此按预注册规则 H1 不运行：

- H1 运行记录：**0**
- H1 证明记录：**0**
- 救援记录：**0**
- 未运行原因：`H0` 已被证明反驳，不满足“仅当 H0 未被证明”才进入 H1 的条件。
- 最终状态：`NO_PROVEN_TACTICAL_RESCUE_H1`

没有发现任何真实的、经独立验证的 H1 猫存活证书。

## 6. 两次重复与确定性

两次均为全新进程、串行执行，`HEAVY_WORKER_CONCURRENCY=1`、`fileParallelism=false`、`maxWorkers=1`、`minWorkers=1`；Rep1 完全退出后才启动 Rep2。

| Rep | 文件 SHA256 | bytes | RSS MB | heap MB | elapsed ms | 结论 |
|---|---|---:|---:|---:|---:|---|
| 1 | `ddc661a84160f3669042d97aff0eacc23e1485c380695dd9d7127193d9244d1a` | 171040 | 141.4 | 78.6 | 237.94 | 同结论 |
| 2 | `1c3ddeba13bef6117e642edd6955ac618d1886e3683d952aff838d826f5a0dd6` | 171032 | 148.0 | 63.6 | 154.38 | 同结论 |

去除时间、资源与时间戳字段后，两次投影 SHA256 均为：

`fbfc10ec2c13bd4c82635bea2894a3f91d2995d72784e36945b1dc6056a8184c`

证明节点数、证书哈希、policy、record 分类、复用验证和 summary 完全一致。

## 7. 语义边界

- `H0_REFUTED != CAT_SURVIVAL`。H0 `mouseForce=true` 只说明老鼠存在强制策略，不构成猫存活证明。
- `H1_NOT_PROVEN != MOUSE_FORCED_WIN`。本轮 H1 未运行，不能据此声称所有线路都被老鼠强制获胜。
- 唯一可以计为战术救援的是：真实的 H1 独立猫存活证书。本轮不存在。
- 负向结论的范围：仅这 4 条冻结 tail 候选，不是全部合法猫动作序列的穷举。
- 未修改生产源码、`src/`、`GAMEPLAY.md`、`evaluateForCat`/corrected-hole、H1、Alpha-Beta/TT/Expectiminimax、Sidecar、Guard，也未改动 100ms/150ms 预算。这里指本轮没有新增修改；preflight 已存在的 15 个 tracked 修改和 51 个未跟踪条目被完整保留，未回滚、覆盖或清理。
- 未运行 24-root 全搜索、P5/P6、self-play 或 exhaustive oracle；未 commit/push/merge；未进入 D2；未接生产。

## 8. 交付物

`TAIL_CANDIDATES.json`、`TAIL_DEDUP_AUDIT.json`、`TAIL_PROOF_REP1.json`、`TAIL_PROOF_REP2.json`、`TAIL_CERTIFICATE_VERIFICATION.json`、`TAIL_MATRIX.csv`、`SOURCE_MANIFEST.json`、`SHA256SUMS.txt`、`RESOURCE_SAFETY_LOG.md`，以及 `logs/generate.log`、`logs/rep1.log`、`logs/rep2.log`、`logs/aggregate.log`。原始两次 repetition 均保留。

## 9. Machine State

```text
ROUND=PPC-T2-PCV-TAIL-01
TYPE=READ_ONLY_TAIL_CERTIFICATION
HEAD=48eaac6c4f3801d351787696ba5876995b64e8d8
BRANCH=ppc/p1-id-state-identity-fix
RESULT=NO_PROVEN_TACTICAL_RESCUE_H1
ORIGINAL_RECORDS=4
EXPECTED_UNIQUE_FRONTIERS=2
ACTUAL_UNIQUE_FRONTIERS=2
UNIQUE_H0_PROOFS=2
H0_PROVEN_RECORDS=4
H0_REFUTED_RECORDS=4
H0_NOT_PROVEN_RECORDS=0
REUSED_CERTIFICATES=1
H1_RUN_RECORDS=0
H1_PROVEN_RECORDS=0
RESCUE_RECORDS=0
UNRESOLVED_RECORDS=0
VERIFY_FAILURES=0
FALSE_PROVEN=0
IDENTITY_MISMATCHES=0
CHANCE_COMPLETE=TRUE
REPETITIONS=2
REPETITION_DETERMINISTIC=TRUE
PROOFS_RUN_BEFORE_FREEZE=FALSE
PRODUCTION_SOURCE_MODIFIED_BY_THIS_ROUND=FALSE
PREEXISTING_WORKTREE_CHANGES_PRESERVED=TRUE
PREEXISTING_TRACKED_MODIFICATIONS=15
PREEXISTING_UNTRACKED_ENTRIES=51
NEW_UNTRACKED_DIRECTORIES=1
D2_ENTERED=FALSE
PRODUCTION_WIRING=FALSE
COMMIT_PUSH_MERGE=FALSE
STOP_FOR_CHATGPT_REVIEW=TRUE
```
