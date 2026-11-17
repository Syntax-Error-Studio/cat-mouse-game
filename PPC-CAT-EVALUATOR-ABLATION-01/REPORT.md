# PPC-CAT-EVALUATOR-ABLATION-01 — 隔离评价器消融 + 真人局面战术正确性验证

- 授权状态：`AUTHORIZED_FOR_ISOLATED_RESEARCH`；生产代码修改：**禁止**（本轮全程未改任何生产源）。
- 基线 HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`，分支 `ppc/p1-id-state-identity-fix`。
- 冻结局面 fixture：`src/game/ai/__tests__/fixtures/ppcId01-human-roots.json`，SHA256 `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`（24 个真人根）。
- 对照臂：**E1 = `evaluateForCat`**（生产基线）；**H1 = `evaluateCorrectedHoleForCat`**（feature-flag，默认 OFF，仅翻转 both-reachable holeControl 符号）。
- 本轮目标（ verbatim ）：「不要为了证明 H1 正确而开展实验……如果它不能改善真实玩家面对的战术决策，就如实否决它，并保留所有证据。完成后停止，交由 ChatGPT 进行架构裁决。」

---

## 一、人类摘要（结论先行）

**H1 在这 24 个真人局面上是「战术中性」的：没有任何被独立证明的收益，也没有任何被独立证明的回归。据此如实否决其采用资格。**

1. **它没有挽救任何一个已被证明的鼠必胜。** 7 个「鼠强制胜」根（G6T2/G6T3/G5T3/G5T4/G2T7/G2T8/G1T9）在 E1 与 H1 下类别完全相同，H1 选的行动依旧落在已证明的鼠必胜里。`RESCUED_PROVEN_MOUSE_WINS = 0`。
2. **它没有引入任何新的鼠必胜，也没有丢失任何已证明的猫生存。** `INTRODUCED_PROVEN_MOUSE_WINS = 0`，`LOST_PROVEN_CAT_SURVIVAL = 0`。
3. **它确实改变了 5 个根的 D1 首选行动**（G6T1 U→T、G5T1 U→T、G2T6 L→D、G1T3 D→R、G1T4 L→U），但这 5 个根在两个臂下都是「猫生存已证明（CAT_SURVIVAL_CERTIFIED_WITHIN_H1 / PROVEN）」——**安全类别一模一样**。改变行动 ≠ 改善战术；这些改变有证书支持，却不带来任何可证明的更可靠结果。
4. **真实 100ms 生产路径**：48/48 组合跨 5 轮 fresh-process 完全可复现，0 fallback、0 sidecar override、预算契约（100ms 主搜索 / 150ms 回合名义墙 / refutation ON / guard OFF）逐行注入正确。100ms 下只有 3 个根改变行动（G6T1/G5T1/G1T3），D1 的另外 2 个改变（G2T6/G1T4）在更深搜索下收敛回同一行动。
5. **性能**：评价器自身开销 E1 vs H1 无显著差异（几何均值比 0.9785，95% CI [0.9462, 1.0119] **包含 1**），与 P2「H1 只做同一次 `evaluateForCatDetailed`、无额外 BFS」一致。但搜索成本的 **A/A 校准边际失败**（GM 0.9869，CI [0.9744, **0.9997**] 不含 1，存在系统性的「第二进程偏快」顺序偏差），按预注册规则 **性能判定 = BLOCKED_AA_CALIBRATION**。A/B 观测比 1.0296（H1 约慢 3%）被同一顺序偏差污染，**不能**作为干净的 H1 效应宣称。未放宽门槛、未重跑挑拣、未伪造/删除任何正确性证据。

**最终资格：`NOT_ELIGIBLE_NO_PROVEN_BENEFIT`（无证明收益，不予采用）；性能维度另为 `BLOCKED_AA_CALIBRATION`。生产评价器变更 = NOT_AUTHORIZED，新效力授权 = NONE。交 ChatGPT 架构裁决。**

> ⚠️ **重大基线分歧（详见下节）**：本轮工作树**并非纯净 HEAD**——它携带**先于本轮存在**的未提交生产补丁（用户在制的 PPC-P2-PREPARED-TRANSITION-01 候选枚举重构 + 时序修复，mtime 11-12..11-14）。**本轮自身未修改任何生产源**（全部被改 src 文件的 mtime 都早于本轮首个工件 11-15 20:16）；**E1/H1 叶子源（evaluation.ts、correctedHoleLeaf.ts）与 HEAD 逐字节一致**。两臂跑在**同一稳定 substrate** 上，故 **E1-vs-H1 相对比较内部有效**；但**绝对基线 = HEAD+既有补丁，非纯净 HEAD**。此分歧如实披露，交 ChatGPT 裁决，未编辑任何门槛、未删除任何证据。

---

## 一之补、基线分歧披露（SOURCE_INTEGRITY，裁决前必读）

**事实清单（全部可复核，见 `SEAL_VERIFICATION.json.workingTree` 与 `SOURCE_MANIFEST.json.sourceIntegrity`）：**

1. `git diff -- src GAMEPLAY.md` **非空**：15 个文件、+1015/−219。其中 9 个生产 `.ts`（deadlineContext +97、expectiminimax +65/−16、hardTurnPlanner +48/−7、legalActions +11/−30、planQuality +118/−17、transposition +43/−1、config +37、engine +108/−5、openingFairness +284/−103）+ 6 个测试 `.ts`。
2. **全部被改文件 mtime ∈ [2026-11-12 21:11, 2026-11-14 13:07]**，本轮首个工件 `probe/vitest.config.mts` mtime = **2026-11-15 20:16:23**。每个被改 src 文件都**早于本轮起点 ≥1 天** ⇒ `changedDuringRound = []`，`roundModifiedProduction = FALSE`（本轮未写任何生产源，禁令遵守）。
3. **E1/H1 叶子源未改**：`git diff -- src/game/ai/evaluation.ts src/game/ai/correctedHoleLeaf.ts` **为空** ⇒ `leafSourcesMatchHead = TRUE`。消融的核心评价器数学是纯净 HEAD。
4. 补丁性质：`legalActions.ts` 把候选枚举迁入 `preparedActions.ts`（PPC-P2-PREPARED-TRANSITION-01，自称契约不变），其余为时序/规划 plumbing。属**用户在制的另一任务**的生产优化，非本轮产物。
5. HEAD = `48eaac6…`（与冻结一致），fixture SHA 与冻结一致（fixture 未被改）。

**影响评估（ priced ）：**
- **相对比较有效**：E1 与 H1 两臂在 P2/P3/P4/P5/P6 全程跑在**同一、稳定**（mtime 证明本轮期间无 src 变动）的 substrate 上。契约的 5 个问题全是**相对**问题（H1 相对 E1 是否改善/引入/丢失），故「H1 战术中性、无证明收益、无证明回归」的结论**对 substrate 分歧稳健**。
- **绝对语义依赖补丁**：P4 证书的 replay 用的是工作树 `engine.ts`（已打补丁），量词搜索用 `seal_lib` 独立核。证书的**绝对**类别建立在 HEAD+补丁的规则/搜索语义上，而非纯净 HEAD。`legalActions` 重构自称语义保持，但其语义保持性正是**另一任务**在验证的对象，本轮未授权去审计它。
- **性能 A/A 边际失败**可能与该 substrate 的时序 plumbing 有关，但本轮按预注册判 BLOCKED，未归因、未校正。

**合法路线（交 ChatGPT 裁决，本轮不擅自执行）：**
- **路线 A（建议）**：接受本轮为「HEAD+既有补丁 substrate 上的隔离相对比较」。本轮遵守了「不修改生产」禁令，E1/H1 叶子数学纯净，相对结论有效。SOURCE_INTEGRITY 记为 `PASS_WITH_DISCLOSED_BASELINE_DIVERGENCE`。战术否决结论成立。
- **路线 B**：要求纯净 HEAD 重跑。**需扰动用户未提交工作**（stash/clean/独立 checkout），本轮 `STASH=NO / CLEAN=NO / RESET=NO` 且属用户在制工作，**未经授权不可执行**。需用户显式授权 + 独立隔离检出，另起一轮。
- **路线 C**：将分歧视为 BLOCKER，暂缓最终效力裁定，待 ChatGPT 明确 substrate 权威后再定。

**本轮采取**：完整保全证据 + 如实披露分歧（路线 A 的记录方式），**不**伪造纯净-HEAD PASS，**不**扰动用户工作，**不**编辑门槛。最终架构裁决（含是否需路线 B 重跑）交 ChatGPT。

---

## 二、逐阶段技术结论

### P1 — 基线保全与查重（§2）
HEAD/fixture SHA 冻结一致；无重复 benchmark、无残留 ablation worker；外部重型任务（`resume-run`/`watch-v5`）在墙钟阶段前已退出。全程未 kill 任何外部进程。证据：`RESOURCE_SAFETY_LOG.md`。**注**：工作树相对 HEAD 携带先于本轮的未提交生产补丁，于 P8 封口时经 `git diff` + mtime 取证检出并如实披露（见「一之补」）；本轮自身未修改任何生产源。

### P2 — H1 数学正确性审计（§3）→ `H1_MATH_PARITY.json`
- `H1_MATH_PARITY = PASS`，`SINGLE_SIDED_PARITY = PASS`，`NO_EXTRA_BFS = PASS`，`STATE_IMMUTABILITY = PASS`。
- 实现精确恒等式 `H1 === (E1 - holeControl_E1) + correctedHoleControlValue` **bit-exact**（maxAbsError = 0）；符号翻转 both-reachable `corrected === -holeControl_E1`、single-sided `=== holeControl_E1`，0 mismatch。
- 调用计数：E1 与 H1 在 1517 态语料上 evaluationCalls / mouseBfs / catBfs / carryMouseBfs **均为 1517**，`noExtraBfs = true`。
- 不变量：nonFinite = 0、stateMutations = 0、nonDeterministic = 0、failureCount = 0；静态扫描无 `Math.random`/`Date.now`/`performance.now`/`console.*`/fs/fetch。
- **诚实限定**：(a) 重排恒等式 `H1 = E1 - 2*holeControl_E1` 在 IEEE754 下**非** bit-exact（maxAbsError ≈ 2.27e-13，ulp 量级）；bit-exact 的是实现精确式与贡献级符号翻转。(b) 语料 1517 态**全部 both-reachable**（singleSidedCount = 0），single-sided 分支由纯 helper 契约测试在真实 breakdown + 源码上验证，而非语料覆盖。

### P3 — 24 根固定 D1 消融（§4）→ `ABLATION_RESULTS.json` / `ROOT_DECISION_TABLE.csv`
- 忠实协议：`createSearchContext(rules,400000,TT,AB,ordering)+leafEvaluator+capturePlan`，无墙钟 deadline；每次调用 fresh SearchContext（fresh TT + evalCache），无跨臂共享。
- 3 次 fresh-process 重复、严格串行：`decisionFieldsIdenticalAcrossReps = true`，mismatches = []，决策指纹 `9517262ced391380763f7730deec5d541fb1944ed2faa23c91aa67f106663290`。
- `d1ActionChanges = 5`（G6T1/G5T1/G2T6/G1T3/G1T4），`d1PlanChanges = 10`，`allCrossChecksPass = true`（忠实 vs exact 全窗口 minimax 交叉校验）。G6T2 附 D2 仅解释用。

### P4 — 独立量词证书（§5，核心验收）→ `QUANTIFIER_CERTIFICATES.json`
- 复用上一轮 `seal_lib.ts` 量词核 + **独立** verifier（不共享组合子，逐叶计数）。每根每臂：真实引擎 replay → 后态 → replay 完整猫回合计划 → 展开全部正概率 CHANCE → 独立量词搜索 → 独立 verify。mouseForce / catSurvive / catForce 分别验证，**绝不**用 `!mouseForcesWin ⇒ CAT_SURVIVAL`。
- 48 组合：**44 PROVEN / 2 UNRESOLVED / 0 REFUTED**；`verifyFailures = 0`、`replayFailures = 0`、`catForceTrueCount = 0`、definiteCertificates = 46。
- 类别分布：CAT_SURVIVAL 32、MOUSE_H1 6、MOUSE_H0 8、CHANCE_DEPENDENT 2。
- **2 个 UNRESOLVED = G1T5/E1 与 G1T5/H1**（无行动改变根）：prover `catSurvivesSeal` 完成（nodes 406933，truncated=false）返回 TRUE，但独立 verifier 在冻结 cap 600000 处 leaves=600001 → `NODE_CAP / UNRESOLVED`。这是 prover/verifier 节点计数不对称导致的**诚实未决**，**不是**反驳，也**不**当作 PROVEN。G1T5 无行动改变，不影响任何行动改变安全裁定。
- 仪器修正留痕：首轮分类缺陷把 verifier UNRESOLVED 误折成 FAILED，已修正为区分 `FAILED`（真反驳）与 `UNRESOLVED`（诚实 cap）；缺陷工件原样保留于 `_raw/p4_certificates_v1_misclassified.json` + `logs/p4_certificates_v1_misclassified.log`。

### P5 — 真实 100ms 生产路径（§6）→ `PRODUCTION_100MS_RESULTS.json`
- 经 `computeCatAiTrajectory` 真实入口；spy **包裹**（绝不替换）`planHardCatTurn` 捕获**首次**调用；`setHardLeafMode` 切臂，`resolveHardLeaf()` 注入对应 leaf。
- 契约逐行断言通过：timeBudgetMs=100、refutationEnabled=true、totalTurnBudgetMs=150、leafIsArm、guardEnabled=false、rootAtPlanTimeMatches；finalPlan === finalPlanDebug。
- 5 轮 paired fresh-process（臂序 `(round+rootIndex)%2`）：**executedConsistent 48/48**、firstAction/baseline/final 均 48/48 一致，fallbackCombos=0、overrideCombos=0，`needsExtension=false`（未触发预注册的扩到 10 轮）。
- 100ms 下行动改变根 = **G6T1/G5T1/G1T3**（3 个）；主搜索 completedDepth 1–3、attemptedDepth 2–4，比固定 D1 更深。
- **名义墙说明**：150ms 是名义回合墙、**非物理认证**；观测到 182/240 臂-轮超 150ms（OS 调度不保证），主搜索 elapsed ~100–138ms（100ms 语义预算 + 单节点过冲），deadlineFired 全部触发、budgetFired=0。深度/节点/耗时以**区间**记录，绝不钉死。

### P6 — 性能与稳定性（§7）→ `PERFORMANCE_RESULTS.json`
- **§7.1 评价器自身开销**（同一冻结 1517 态语料，单进程内交错臂序，40 rep）：ratioGM = 0.9785，CI95 = [0.9462, 1.0119] **包含 1** → 无显著差异；E1 ≈ 235.4µs/call、H1 ≈ 231.4µs/call，h1SlowerReps 21/40。
- **§7.2 描述性 D1 搜索成本**：E1 60 run vs H1 20 run，per-root 均值比 GM = 1.0376（描述性、非配对、不等重复）。
- **§7.3 A/A 校准**（20 对，均 E1，480 比）：GM = 0.9869，CI = [0.9744, 0.9997] **不含 1** → `calibrationPass=false`，存在系统性「第二进程偏快」顺序偏差（noiseSdLog 0.1433）。
- **§7.3 A/B 效应**（20 对，E1→H1，480 比）：GM = 1.0296，CI = [1.0126, 1.0469]，h1Slower=true，但**被 A/A 顺序偏差污染**。
- **performanceVerdict = `BLOCKED_AA_CALIBRATION`**。按预注册：A/A 失败 ⇒ 性能 BLOCKED；正确性证据（P2/P3/P4/P5）原样保留，未伪造/删除。**未**做后验偏差校正来制造干净效应，**未**重跑挑拣。

### P7 — 最终决策（§8）→ `_raw/p7_decision.json`
- `actionSafety = NO_PROVEN_REGRESSION`；`provenImprovement = false`；`eligibility = NOT_ELIGIBLE_NO_PROVEN_BENEFIT`；`performanceBlocked = true`。
- 计数：actionChanges=5、planChanges=10、rescued=0、introduced=0、lostSurvival=0、survivalGain=0、certSupportedActionChanges=5、actionChangesMissingProof=0、unresolvedCombos=2（G1T5）。
- D1→100ms 首选行动复现：E1 **22/24**、H1 **22/24**。未复现：E1 = G5T1(D1 U→100 D)、G1T3(D1 D→100 U)；H1 = G2T6(D1 D→100 L)、G1T4(D1 U→100 L)。
- 资格优先级：无证明收益先于性能阻塞——没有战术收益的变更无论性能能否干净测量都不予采用；性能阻塞只对「确有证明收益」的变更构成额外门槛。

---

## 三、24 根决策表（D1 证书类别 + 真实 100ms 首选行动）

> 类别缩写：CAT_SURV = CAT_SURVIVAL_CERTIFIED_WITHIN_H1；MOUSE_H0/H1 = MOUSE_FORCED_WIN_WITHIN_H0/H1；CHANCE = CHANCE_DEPENDENT_OUTCOME。**每一根 e1Class === h1Class**。

| 根 | D1 E1→H1 | E1 类别/证明 | H1 类别/证明 | 100ms E1/H1 | 100ms 行动改变 | D1→100 复现 E1/H1 |
|----|----------|--------------|--------------|-------------|----------------|--------------------|
| G6T1 | U→T | CAT_SURV/PROVEN | CAT_SURV/PROVEN | U/T | 是 | Y/Y |
| G6T2 | U→U | MOUSE_H1/PROVEN | MOUSE_H1/PROVEN | U/U | 否 | Y/Y |
| G6T3 | R→R | MOUSE_H0/PROVEN | MOUSE_H0/PROVEN | R/R | 否 | Y/Y |
| G5T1 | U→T | CAT_SURV/PROVEN | CAT_SURV/PROVEN | D/T | 是 | N/Y |
| G5T2 | D→D | CAT_SURV/PROVEN | CAT_SURV/PROVEN | D/D | 否 | Y/Y |
| G5T3 | L→L | MOUSE_H1/PROVEN | MOUSE_H1/PROVEN | L/L | 否 | Y/Y |
| G5T4 | R→R | MOUSE_H0/PROVEN | MOUSE_H0/PROVEN | R/R | 否 | Y/Y |
| G2T1 | T→T | CAT_SURV/PROVEN | CAT_SURV/PROVEN | T/T | 否 | Y/Y |
| G2T2 | D→D | CAT_SURV/PROVEN | CAT_SURV/PROVEN | D/D | 否 | Y/Y |
| G2T3 | L→L | CAT_SURV/PROVEN | CAT_SURV/PROVEN | L/L | 否 | Y/Y |
| G2T4 | D→D | CAT_SURV/PROVEN | CAT_SURV/PROVEN | D/D | 否 | Y/Y |
| G2T5 | D→D | CAT_SURV/PROVEN | CAT_SURV/PROVEN | D/D | 否 | Y/Y |
| G2T6 | L→D | CAT_SURV/PROVEN | CAT_SURV/PROVEN | L/L | 否 | Y/N |
| G2T7 | U→U | MOUSE_H1/PROVEN | MOUSE_H1/PROVEN | U/U | 否 | Y/Y |
| G2T8 | D→D | MOUSE_H0/PROVEN | MOUSE_H0/PROVEN | D/D | 否 | Y/Y |
| G1T1 | T→T | CAT_SURV/PROVEN | CAT_SURV/PROVEN | T/T | 否 | Y/Y |
| G1T2 | D→D | CAT_SURV/PROVEN | CAT_SURV/PROVEN | D/D | 否 | Y/Y |
| G1T3 | D→R | CAT_SURV/PROVEN | CAT_SURV/PROVEN | U/R | 是 | N/Y |
| G1T4 | L→U | CAT_SURV/PROVEN | CAT_SURV/PROVEN | L/L | 否 | Y/N |
| G1T5 | U→U | CAT_SURV/**UNRESOLVED** | CAT_SURV/**UNRESOLVED** | U/U | 否 | Y/Y |
| G1T6 | U→U | CAT_SURV/PROVEN | CAT_SURV/PROVEN | U/U | 否 | Y/Y |
| G1T7 | R→R | CAT_SURV/PROVEN | CAT_SURV/PROVEN | R/R | 否 | Y/Y |
| G1T8 | L→L | CHANCE/REFUTED_BOTH_FORCE | CHANCE/REFUTED_BOTH_FORCE | L/L | 否 | Y/Y |
| G1T9 | L→L | MOUSE_H0/PROVEN | MOUSE_H0/PROVEN | L/L | 否 | Y/Y |

---

## 四、关键诚实限定（裁决前必读）

1. **证书绑定的是 D1 首选行动的后态，不是 100ms 实际行动。** P4 按契约对「D1 消融首选行动」做独立量词证书。真实 100ms 路径搜索更深，E1 有 2 根（G5T1/G1T3）、H1 有 2 根（G2T6/G1T4）的 100ms 首选行动不同于 D1，这些**具体 100ms 行动的后态本轮未再独立认证**。安全裁定（NO_PROVEN_REGRESSION）建立在 D1 证书基上；100ms  divergence 作为复现性发现如实报告，未扩范围去重认证（契约未授权）。
2. **G1T5 两臂 UNRESOLVED**：独立 verifier 在冻结 cap 处 NODE_CAP，未决≠反驳≠PROVEN；该根无行动改变，不影响安全裁定。未提高 cap、未删根来制造 PASS。
3. **重排恒等式 ulp 级非 bit-exact**：`E1-2h` 形式有 ~2.27e-13 误差；bit-exact 的是实现精确式。已在 P2 披露。
4. **single-sided 语料缺失**：1517 态全 both-reachable，single-sided 平价由纯 helper 契约测试覆盖，非语料覆盖。
5. **A/A 边际失败 ⇒ 性能 BLOCKED**：CI 上界 0.9997 仅差 0.0003 不含 1，是真实系统性顺序偏差，按预注册判 BLOCKED；A/B 的「H1 慢 3%」被污染，既不宣称回归也不宣称干净。
6. **150ms/100ms 为语义/名义预算，非物理认证**：超墙观测如实记录为区间，未钉死、未伪装成物理保证。
7. **战术中性 ≠ 评价分数不变**：H1 确实改变根值与 5 个 D1 行动，但「改变」未转化为任何可证明的更可靠战术结果。本轮不追求更高评价分数，只验证据是否值得采用——答案是否。

---

## 五、§11 裁决块（verbatim）

```
ROUND=PPC-CAT-EVALUATOR-ABLATION-01
SOURCE_INTEGRITY=PASS_WITH_DISCLOSED_BASELINE_DIVERGENCE
ROUND_PRODUCTION_MODIFICATION=NO
WORKING_TREE_MATCHES_HEAD=NO (PRE-EXISTING uncommitted patches, mtimes 11-12..11-14, ALL predating round start 11-15 20:16; disclosed, not a round violation)
LEAF_SOURCES_MATCH_HEAD=YES (evaluation.ts + correctedHoleLeaf.ts byte-identical to HEAD)
H1_MATH_PARITY=PASS
D1_ABLATION=PASS
QUANTIFIER_CERTIFICATES=PASS (44 PROVEN / 2 UNRESOLVED / 0 REFUTED; 0 independent verify failures; 0 replay failures)
ACTION_SAFETY=NO_PROVEN_REGRESSION
REAL_100MS_PATH=PASS (48/48 executed-consistent over 5 fresh-process rounds; 0 fallback; 0 override; budget contract honored; needsExtension=false)
PERFORMANCE=BLOCKED_AA_CALIBRATION
RESCUED_PROVEN_MOUSE_WINS=0
INTRODUCED_PROVEN_MOUSE_WINS=0
LOST_PROVEN_CAT_SURVIVAL=0
UNRESOLVED=2
ACTION_CHANGES=5 (D1; at real 100ms = 3: G6T1/G5T1/G1T3)
ELIGIBILITY=NOT_ELIGIBLE_NO_PROVEN_BENEFIT
PRODUCTION_EVALUATOR_CHANGE=NOT_AUTHORIZED
NEW_EFFICACY_AUTHORITY=NONE
HEAVY_WORKER_CONCURRENCY=1
SERIAL_FRESH_REPETITIONS=TRUE
COMMIT=NO
PUSH=NO
MERGE=NO
```

**整体结论：H1 无证明收益、无证明回归（战术中性），性能维度 BLOCKED；不予采用。生产评价器不接线，新效力授权 NONE。本轮未修改任何生产源；工作树携带先于本轮的未提交补丁（已披露，E1/H1 叶子数学纯净，相对比较有效）。全部证据保留，停止，交 ChatGPT 架构裁决（含是否需纯净-HEAD 重跑）。**

---

## 六、交付物与复现

交付物（本目录）：`REPORT.md`、`ABLATION_RESULTS.json`、`ROOT_DECISION_TABLE.csv`、`QUANTIFIER_CERTIFICATES.json`、`PRODUCTION_100MS_RESULTS.json`、`PERFORMANCE_RESULTS.json`、`H1_MATH_PARITY.json`、`SOURCE_MANIFEST.json`、`RESOURCE_SAFETY_LOG.md`、`RESTORE.md`、`SHA256SUMS.txt`、`SEAL_VERIFICATION.json`、`probe/`、`logs/`、`_raw/`。

复现（repo 根，串行，单 worker）：
```sh
CFG=PPC-CAT-EVALUATOR-ABLATION-01/probe/vitest.config.mts
npx vitest run --config $CFG PPC-CAT-EVALUATOR-ABLATION-01/probe/p2_parity.test.ts
ABLATION_REP=1 npx vitest run --config $CFG PPC-CAT-EVALUATOR-ABLATION-01/probe/p3_d1_ablation.test.ts   # rep 1..3
npx vitest run --config $CFG PPC-CAT-EVALUATOR-ABLATION-01/probe/p3_aggregate.test.ts
npx vitest run --config $CFG PPC-CAT-EVALUATOR-ABLATION-01/probe/p4_certificates.test.ts
bash PPC-CAT-EVALUATOR-ABLATION-01/probe/run_p5_rounds.sh 5        # 墙钟，先重探 census
bash PPC-CAT-EVALUATOR-ABLATION-01/probe/run_p6_pairs.sh           # 墙钟，先重探 census
npx vitest run --config $CFG PPC-CAT-EVALUATOR-ABLATION-01/probe/p7_decision.test.ts
node PPC-CAT-EVALUATOR-ABLATION-01/probe/seal.mjs                  # 封口 + 外置 restore 验证
node F:/ppc-checkpoints/verify_seal_ablation.mjs                   # 独立外部复核
```

归档（repo 外）：`F:/ppc-checkpoints/PPC-CAT-EVALUATOR-ABLATION-01-candidate.tar.gz`。封口与逐文件 SHA256/bytes/line-ending、missing 0 / extra 0、工作树未改的证明见 `SEAL_VERIFICATION.json` 与 `RESTORE.md`。