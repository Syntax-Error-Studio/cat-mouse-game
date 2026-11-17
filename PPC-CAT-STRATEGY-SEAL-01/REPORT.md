# REPORT — PPC-CAT-STRATEGY-SEAL-01｜战术量词证明封口与评价差异归因

独立正确性封口轮（对 PPC-CAT-STRATEGY-01 的战术证明）。**研究 only，零生产改动。**
本轮完成后停止，提交人话总结、机器结果、失败证据与下一代战术特征架构建议，
等待 ChatGPT 最终裁决。

- HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`
- 分支：`ppc/p1-id-state-identity-fix`
- 冻结 fixture：`src/game/ai/__tests__/fixtures/ppcId01-human-roots.json`
  SHA256 `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`（264328 字节，24 根）
- 规则权威：`GAMEPLAY.md` SHA256 `e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34`（21128 字节）
- 内核：`PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts`（隔离探针，**不修改任何生产源**）

---

## 0. 最终裁决字段（机器可读副本见 REGRESSION_RESULTS.json）

| 字段 | 值 |
|---|---|
| ROUND | PPC-CAT-STRATEGY-SEAL-01 |
| SOURCE_INTEGRITY | PASS（29 modified + 16 deps，0 mismatch） |
| QUANTIFIER_DUALITY_CORRECT | YES（F1 修复，独立 catSurvive，反例 A–E PASS） |
| CHANCE_ALL_OUTCOMES_VALIDATED | YES（CHANCE=AND ∀ 正概率 outcome；反例 A/B/C/D PASS） |
| HORIZON_TERMINAL_ORDER | CORRECT（terminal-before-horizon PASS） |
| STRATEGY_CERTIFICATE_VERIFICATION | PASS（recertify 2/2 PROVEN；cohort 20/20 PROVEN；0 policyMisses） |
| G6T2_ROOT_CLASS | UNRESOLVED（根级全搜索超 cap 600000） |
| G6T2_DRRR_CATSURVIVE | PROVEN（前缀级，117382 叶/31236 分支/549 chance） |
| G6T2_UURR_MOUSEFORCEDWIN | PROVEN（前缀级） |
| G6T2_DRDR | CHANCE_DEPENDENT_OUTCOME |
| G6T2_DR_UNIQUE_SAFE_TWOSTEP | TRUE |
| G6T3_ROOT_CLASS | MOUSE_FORCED_WIN_WITHIN_H0 |
| G6T3_CERTIFICATE | PROVEN（457 叶/45 分支/0 chance/policySize 66/maxDepth 7） |
| ROOTS_RECLASSIFIED | 24/24 |
| UNRESOLVED_ROOTS | 4（G6T2, G2T7, G1T5, G1T8） |
| E1_D2_EQUALITY_CAUSE | 22 个共享决定叶上的收敛 + holeControl 符号缺陷 |
| CORRECTED_HOLE_CAUSAL_DIFFERENCE | holeControl 反号（corrected=E1−2·holeControl_E1，25214 叶 maxAbsError=0）；打破收敛（0 共享），D 分离 |
| NEW_TEMPO_FEATURE_JUSTIFIED | YES（方向性影子；非完整分类器，chance 依赖须靠证书） |
| PRODUCTION_SOURCE_CHANGED | NO |
| GAME_RULES_CHANGED | NO |
| SEARCH_MATH_CHANGED | NO |
| H1_CHANGED | NO |
| SIDECAR_CHANGED | NO |
| ABSOLUTE_DEADLINE_GATE | BLOCKED |
| NEW_EFFICACY_AUTHORITY | NONE |
| HEAVY_WORKER_CONCURRENCY | 1 |
| SERIAL_FRESH_REPETITIONS | TRUE |
| DUPLICATE_BENCHMARK_CHECK | REQUIRED（结果：本仓库无 benchmark；外部 docmap-studio 留停） |
| COMMIT / PUSH / MERGE | NO / NO / NO |

---

## 1. 人话总结（一段话）

上一轮用「鼠不能强制胜」(`!mouseForcesWin`) 直接推导「猫存活」，这在量词上是错的
（否定式是 `∀σ_m ∃σ_c ∃chance`，存活要 `∃σ_c ∀σ_m ∀chance`，猫/鼠顺序与 chance 量词
都不同），再加上猫强制胜终局极性写反、prune 漏掉 RULE-A 猫被困鼠胜路径。本轮在
**隔离探针**里修复了这些（生产源一字未改），用 7 个最小反例证明修复正确，对 G6T2/G6T3
重新生成**独立可验证**的策略证书（验证者重新枚举全部对手动作与全部 chance outcome，
与证明者不共享任何布尔否定函数），并把 24 根全部重分类：15 猫存活、4 鼠 H0 强制胜、
1 鼠 H1 强制胜、4 诚实 UNRESOLVED（资源不足绝不冒充 PASS），其中 5 根相对上一轮改变。
评价差异方面，**测量证明** E1 在 D2 的 U=D=L 平局是「三棵子树收敛到同一组 22 个决定叶」
＋「holeControl 符号奖励猫远离洞门」共同造成；corrected-hole 仅反号这一个差异
（corrected=E1−2·holeControl_E1，逐叶误差 0）就打破收敛、让安全的 D 分离出来。现有
tempo 在回合边界是常数（+200/−150），对根动作零判别力；提议的跨回合战术 tempo 能方向性
区分安全/不安全末态，但**不能**区分存活与 chance 依赖，故只能做影子排序信号，不能替代
量词证书。所有结论 live 测量、双协议根值逐位一致、0 失败。

---

## 2. Phase 1 — 源码身份与证据保全（A 级）

详见 `RESOURCE_SAFETY_LOG.md`、`_raw/source_integrity.json`。

- 29 个 modified/untracked `src/` 行 + 16 个只读依赖与冻结
  `PPC-CAT-STRATEGY-01/SOURCE_MANIFEST.json` **逐字节相同**（0 mismatch）。
  ⇒ `PRODUCTION_SOURCE_CHANGED=NO`、`GAME_RULES_CHANGED=NO`、`SEARCH_MATH_CHANGED=NO`、
  `H1_CHANGED=NO`、`SIDECAR_CHANGED=NO`。
- 15 个 `src/` 文件的 git ` M` 标记是**真实的未提交上一轮生产改动**（P1-ID / P2 /
  P1-CLOSURE-FIX），**不是 CRLF 行尾产物**：`git diff --stat -- src` = 15 文件 /
  1015 插入 / 219 删除，`git diff --ignore-cr-at-eol --stat -- src` 仍为同样的
  1015+/219-（证明是真实内容，例如 `config.ts` 新增 PPC-P1-CLOSURE-FIX-01 猫步预算校验，
  从 `./ai/planBound` 引入 `MAX_CERTIFIABLE_CAT_MOVE_BUDGET`）。这 15 个文件与冻结
  `PPC-CAT-STRATEGY-01/SOURCE_MANIFEST.json` 基线**逐字节相同**（`_raw/source_integrity.json`
  0 mismatch）。**非本轮改动**：本轮只写入 `PPC-CAT-STRATEGY-SEAL-01/`（untracked）与
  `F:/ppc-checkpoints/`（仓库外），HEAD 仍为 `48eaac6c`。上一轮改动原样保留（不扰动他人工作），
  故相对本轮所封口的冻结基线 `PRODUCTION_SOURCE_CHANGED=NO` 成立。
- 4 个归档（P1-CHECKPOINT / P1-OPENING-STACK / P1-OPENING-SEAL / P2-PREPARED-TRANSITION）
  二进制 SHA256 + 字节长度与上一轮 manifest 全部一致（0 mismatch）。
- 24 根冻结 fixture 完整，无删根；H0=1 / H1=2 与 600000 节点 cap 原样 carried。
- 进程普查：所有大 node 进程（Next.js 5348/36308、reliability-final-run.mjs 42484、
  watch.mjs 28624）属**外部** `F:\docmap-studio`（端口 3255），**非本仓库**；本仓库无
  vitest 残留 worker ⇒ `HEAVY_WORKER_CONCURRENCY=1` 可满足。外部进程留停（杀外部进程
  = 未授权破坏性动作）。`DUPLICATE_BENCHMARK_CHECK=REQUIRED → 本仓库无 benchmark`。
- 上一轮 `PPC-CAT-STRATEGY-01/` 本轮**只读**，未覆盖任何文件；修正结果以 `_V2` /
  `RECERTIFICATION` 命名写在 `PPC-CAT-STRATEGY-SEAL-01/`。

---

## 3. Phase 2 — 独立审查量词搜索实现（A＋B 级）

详见 `QUANTIFIER_AUDIT.md`。审查对象：上一轮 `probe/lib.ts`、`tactical_tree.test.ts`、
`cat_defense_probe.test.ts`、`chance_enumeration.test.ts` 及真实规则源。发现 4 个缺陷：

| 缺陷 | 等级 | 代码证据 | 内容 | 修复 |
|---|---|---|---|---|
| **F1** | A＋B（核心） | lib.ts:890-892；tactical_tree.test.ts:77-84 | 用 `!mouseForcesWin()` 推导猫存活。否定式 `∀σ_m ∃σ_c ∃chance ¬Win` ≠ 存活 `∃σ_c ∀σ_m ∀chance ¬Win`（猫/鼠顺序 + chance 量词均不同） | 独立 `catSurvive` 搜索，不再用否定推导 |
| **F2** | A | lib.ts:931-932 | `catForcesWin` 终局极性硬编码与 side 无关 ⇒ 实际算「猫强制鼠胜」 | 终局极性随 mode 翻转（seal_lib.ts:89-91） |
| **F3** | A | lib.ts:133-146；mobility.ts:158-162 | prune 仅按「带黄油入洞步数」剪枝，漏掉 RULE-A 猫被困鼠胜（不需入洞） | 整体禁用 reachability prune |
| **F4** | C（次要） | lib.ts:143-144 | prune 每回合预算 6 对非携带回合（4+3=7）偏紧；方向 fail-open | 随 F3 一并禁用 |

**方向性结论：** F3/F4 只能把「真鼠胜」剪成「无胜」（假阴性）→ 经 F1 变假存活；
**绝不会**把「无胜」造成「鼠强制胜」。故 6 个鼠强制胜 TRUE 结果不受 F3/F4 污染。

**修正后契约（seal_lib.ts，五类＋UNRESOLVED）：**

| mode | 量词 | 终局成功 | 视界成功 |
|---|---|---|---|
| mouseForce | ∃mouse ∀cat ∀chance → MouseWins | MouseWins | false |
| catSurvive | ∃cat ∀mouse ∀chance → ¬MouseWins | CatWins | **true**（撑过视界即存活） |
| catForce | ∃cat ∀mouse ∀chance → CatWins | CatWins | false |

CHANCE 恒为 AND（∀ 正概率 outcome）；终局判定**先于**视界截断；cap 超出 ⇒ `null` ⇒
UNRESOLVED，绝不冒充 PASS。`classifySeal` 任一 null ⇒ UNRESOLVED；`h1&&survive` 抛矛盾；
`CAT_SURVIVAL` 与 `CHANCE_DEPENDENT` 由**独立 catSurvive 搜索**区分。

**sound 部分（仍可信）：** 6 个鼠强制胜根（H0:G6T3/G5T4/G2T8；H1:G5T3/G2T7/G1T9）的 TRUE
来自真实胜树；CHANCE 枚举（29 分支吃黄油审计）对鼠强制胜用 ∀chance 方向正确；stateKey
单射性（P1-ID 修复）⇒ memo/TT 不串味。**待重验：** 18 个存活标签 + DRRR/DRDR 猫防证书。

---

## 4. Phase 3 — 最小逻辑反例测试（A＋B 级，7/7 PASS）

详见 `CHANCE_LOGIC_COUNTEREXAMPLES.json`、`logs/counterexamples_run.log`（1.03s）。
内核 `seal_lib.ts` solve combinator，与真实规则搜索共享。

| 测试 | 见证缺陷 | 场景 | 结果 |
|---|---|---|---|
| A | F1 | 一个 CHANCE outcome 鼠胜、另一个不输 ⇒ 双方都不认证（CHANCE_DEPENDENT） | PASS |
| B | F1 正控 | 每个 CHANCE outcome 都鼠胜 ⇒ 鼠强制、猫不存活 | PASS |
| C | F1 正控 | 每个 CHANCE outcome 都不输（无其他分支）⇒ 猫存活认证 | PASS |
| D | F1（∃ 只在猫动作） | 猫单一动作挡住全部鼠回应＋全部 chance ⇒ 存活；猫**不可**选 chance outcome | PASS |
| E | F1（自适应 ∃σ_m） | 每条猫防被自适应鼠策略（MA→p、MB→q，非固定串）破 ⇒ 鼠强制 | PASS |
| F | 资源耗尽 vs 裁决 | cap=4 截断 ⇒ UNRESOLVED，与真无胜区分 | PASS |
| TERMINAL_BEFORE_HORIZON | F2/视界顺序 | 最后一步鼠胜先于视界截断判定（RULE-A 猫被困） | PASS |

旧缺陷行为：A 中 `!mouseForcesWin()===true` 会误认证 CAT_SURVIVAL；正确类别是
CHANCE_DEPENDENT_OUTCOME。7/7 全 PASS，0 失败。

---

## 5. Phase 4 — 重验 G6T2/G6T3 并生成独立可验策略证书（A 级）

详见 `G6T2_RECERTIFICATION.json`、`G6T3_RECERTIFICATION.json`、
`STRATEGY_CERTIFICATE_VERIFICATION.json`、`logs/recertify_g6t3_smoke.log`（3/3 PASS，446.02s）。

**验证者独立性（硬约束）：** `verifyCatCertificate`/`verifyMouseCertificate`
（seal_lib.ts:235-382）是独立 DFS，**不调用 solve、不共享布尔组合子、不用 prune**；
在每个全称节点重新枚举**全部**合法对手动作与**全部**正概率 CHANCE outcome，在存在
节点按提取策略走；策略缺失=硬失败。证明者与验证者**不共享**未验证的布尔否定函数。

**G6T2（根级 UNRESOLVED；前缀级可证）：**
- 根全搜索（所有猫动作 × 所有鼠回应 × 所有 chance）在 cap 600000 截断
  （h1 nodes=600001 truncated，survive nodes=600001 truncated）⇒ 诚实 UNRESOLVED。
- **DRRR**：catSurvive H1 = **PROVEN**（117382 叶 / 31236 分支 / 549 chance / policySize 3250 /
  0 policyMisses），末态猫 4,6。唯一安全 2 步前缀 = **DR**。
- **UURR**：mouseForcedWin = **PROVEN**（鼠强制胜，猫不安全），末态猫 1,5 / 鼠 1,6。
- **DRDR**：catSurvive=false / mouseForcedWin=false ⇒ **CHANCE_DEPENDENT_OUTCOME**，末态猫 5,5。
- 根级 UNRESOLVED ≠ 前缀级未决：特定 4 步前缀可在 cap 内独立认证。

**G6T3：**
- 根类 = **MOUSE_FORCED_WIN_WITHIN_H0**（h0=true, h1=true, cs=false, cf=false）。
- mouseForce H0 证书 = **PROVEN**（457 叶 / 45 分支 / 0 chance / maxDepth 7 / policySize 66 /
  0 policyMisses）。上一轮 h1Nodes=32918，本轮 h0 nodes=1568 / h1 nodes=263038（prune 禁用后
  全枚举，节点数上升属预期，cap 未降）。

`STRATEGY_CERTIFICATE_VERIFICATION.json`：2 证书 allProven=true。

---

## 6. Phase 5 — 24 根分类收口（A 级，1/1 PASS）

详见 `ROOT_CLASSIFICATION_V2.json`、`logs/cohort_run.log`（167.56s）。同 cap 600000、
无删根、H0/H1 未缩减、prune 禁用、每根 fresh 重搜（无跨根 memo 复用）。

**本轮 counts（24 根）：**

| 类别 | 本轮 | 上一轮 |
|---|---|---|
| CAT_SURVIVAL_CERTIFIED_WITHIN_H1 | 15 | 18 |
| MOUSE_FORCED_WIN_WITHIN_H0 | 4 | 3 |
| MOUSE_FORCED_WIN_WITHIN_H1 | 1 | 3 |
| CAT_FORCED_WIN_WITHIN_H1 | 0 | 0 |
| CHANCE_DEPENDENT_OUTCOME | 0 | 0 |
| UNRESOLVED | 4 | 0 |

**20 个 PROVEN 证书，0 FAILED，0 policyMisses。** 4 个 UNRESOLVED 均因 cap 600000 截断
（honest UNRESOLVED，绝不冒充 PASS）。

**5 根相对上一轮改变：**

| 根 | 上一轮 | 本轮 | 原因 |
|---|---|---|---|
| G6T2 | CAT_SURVIVAL | UNRESOLVED | F1：survive 搜索超 cap（h1=null, cs=null） |
| G2T7 | MOUSE_FORCED_WIN_H1 | UNRESOLVED | F1/F3：h1 与 survive 超 cap；旧鼠-H1 标签在修正内核下不可复现 |
| G1T5 | CAT_SURVIVAL | UNRESOLVED | F1：h0=false h1=false 但 survive=null（截断）；**最干净 F1 演示** |
| G1T8 | CAT_SURVIVAL | UNRESOLVED | F1：同上；**最干净 F1 演示** |
| G1T9 | MOUSE_FORCED_WIN_H1 | MOUSE_FORCED_WIN_H0 | F2/F3 修正：鼠在 H0 即强制胜（h0=true），比旧 H1 更强 |

G1T5/G1T8 是 F1 的最干净演示：旧代码 `!mouseForcesWin`（h0=false,h1=false）会误认证
存活，修正后独立 catSurvive 搜索超 cap ⇒ 诚实 UNRESOLVED。

---

## 7. Phase 6 — E1 与 corrected-hole 因果拆解（A＋B 级，1/1 PASS）

详见 `E1_CORRECTED_HOLE_ATTRIBUTION.json`（315964 字节）、
`EVALUATOR_SHADOW_RECOMMENDATION.md`、`logs/attribution_run.log`（148.84s）。
**前置门禁：** 量词门已修复（P2–P5，20 PROVEN 证书），故允许对正确安全标签评价影子特征。

**双协议根值逐位一致**（faithful TT/AB/ordering cap400k vs attribution 全窗口 cap8M，
`match=true`，`bound="exact"`）；attribution 展开 1283054 节点 < 8M，未截断，唯一视界键 25214。

**(1) E1 D2 U=D=L 平局之因（测量证明，非假设）：**
- E1 D2 根值 = [−658.2105263157898 ×3]，distinct=1，tie=true。
- 每根恰好 22 个决定叶，三根**共享决定叶交集=22** ⇒ 三棵子树收敛到**同一组** 22 个
  绑定视界叶。平局是**结构性收敛**，不是不同叶恰好数值相等的巧合。
- 决定叶特征级核验：Σ contributions_E1 = −658.2105263157895 === total_E1（逐位相等）。
  样本决定叶 holeControl_E1=**+350**（catHoleGateDistance=8 > mouseHoleGateDistance=1，
  margin=7 ⇒ E1 奖励猫**远离**洞门，符号缺陷）。

**(2) corrected 与 E1 的唯一差异 = holeControl 反号：**
- 恒等式 `correctedTotal === E1total − 2·holeControl_E1`，全 25214 叶逐叶核验
  **maxAbsError=0**，verified=true。
- 代码：`correctedHoleLeaf.ts` margin=`mouseHoleGateDistance−catHoleGateDistance`（反号）；
  `evaluation.ts:692-695` E1 margin=`catHoleGateDistance−mouseHoleGateDistance`。
- D1 交叉核验：E1 U=−247.23684210526318，corrected U=−447.2368421052632，delta=−200=−2×100
  ⇒ 决定叶 holeControl_E1=100，identityHolds=true（与上一轮 D1 数值逐位一致）。

**(3) corrected 打破平局：**
- corrected D2 根值 = [−1145.447(U), −1054(D), −1145.447(L)]，distinct=2。
- 每根 1 个决定叶，三根共享交集=**0** ⇒ 收敛被打破，D 分离。
- 特征级：D 绑定叶 cat 4,6（catHoleGateDistance=4，mobility=125，holeControl_corr=−100）
  vs U/L 绑定叶 cat 4,4（catHoleGateDistance=6，mobility=62.5，holeControl_corr=−200）；
  D 优 91.447（+100 holeControl +62.5 mobility −71.05 voronoi）。
- 方向与独立量词裁决一致：DRRR 存活（安全）/ UURR 鼠强制胜（不安全）。

**(4) 现有 tempo vs 提议跨回合战术 tempo：**
- 现有 `tempo`（evaluation.ts:703-709）= 当前回合剩余步数差，回合相位锁定。
  D2 全 25214 视界叶恒为 **+200**（唯一相位 cat|4|0）；三末态恒为 **−150** ⇒
  对 U/D/L **零判别力**。
- 提议跨回合 tempo（**SHADOW，仅探针，不接线**）：
  `margin = ceil(catHoleGateDistance/catBaseMoves) − ceil(mouseWinRouteDistance/mouseBaseMoves)`。
  三末态 margin = UURR **+1**（鼠强制胜）/ DRRR **−1**（猫存活）/ DRDR **−1**（chance 依赖）。
  能方向性区分 UURR 与 DRRR/DRDR，但**不能**区分存活与 chance 依赖（DRRR/DRDR 同 −1）。
- **诚实局限：** 提议 tempo 是方向性必要信号，**不是完整战术分类器**；chance 依赖来自
  吃黄油 CHANCE 分支，确定性竞速标量无法捕获 ⇒ 必须与量词证书联合，绝不替代证书认证存活。

---

## 8. Phase 7 — 证据与哈希封口（A 级）

详见 `SOURCE_MANIFEST.json`、`SHA256SUMS.txt`、`SEAL_VERIFICATION.json`
（由 `probe/seal.mjs` 在本报告定稿后生成；其摘要记录于这些工件内，**不嵌入本报告**
以避免自指循环）。

**自指循环打破：** content → SOURCE_MANIFEST（`selfExcluded:true`，`selfSha256:null`，
不含自身摘要）→ SHA256SUMS（锚定 manifest 摘要，不列自身）→ SEAL_VERIFICATION
（锚定 SHA256SUMS + 归档摘要）。

- 所有结果文件按**原始字节** SHA256 + 字节长度记录（CRLF/LF 无关，杜绝行尾假证明）。
- 不覆盖上一轮原件；新归档命名 `PPC-CAT-STRATEGY-SEAL-01-deliverables.tar.gz`，
  在**仓库外** `F:/ppc-checkpoints/` 创建并解压到 `_restore_seal01/` 逐成员重哈希比对。
- 机器验证结果（filesChecked / mismatches / allByteIdentical / selfReferenceCycleBroken /
  crlfLfFalseProof / previousRoundOverwritten）见 `SEAL_VERIFICATION.json`。

---

## 9. Phase 8 — 交付物清单

| 工件 | 内容 |
|---|---|
| REPORT.md | 本报告（人话总结 + 机器结果 + 失败证据 + 架构建议 + 裁决字段） |
| REGRESSION_RESULTS.json | 4 套件 12 测试聚合 + cohort + 证书 + 归因 + 裁决字段 |
| SOURCE_MANIFEST.json | 自排除清单（selfExcluded），逐文件字节 SHA256 + 长度 |
| SHA256SUMS.txt | 外部摘要锚（含 manifest 摘要，不列自身） |
| SEAL_VERIFICATION.json | 归档 + 仓库外 restore 逐字节验证 |
| QUANTIFIER_AUDIT.md | F1–F4 缺陷 + 修正契约 + sound/待重验划分 |
| CHANCE_LOGIC_COUNTEREXAMPLES.json | 7/7 反例（A–F + terminal-before-horizon） |
| STRATEGY_CERTIFICATE_VERIFICATION.json | 2 证书独立验证（allProven） |
| G6T2_RECERTIFICATION.json | G6T2 根 UNRESOLVED + DRRR/UURR/DRDR 前缀证书 |
| G6T3_RECERTIFICATION.json | G6T3 鼠 H0 强制胜 + 独立证书（含完整 policy） |
| ROOT_CLASSIFICATION_V2.json | 24 根重分类（15/4/1/4，20 PROVEN，5 改变） |
| E1_CORRECTED_HOLE_ATTRIBUTION.json | Phase 6 逐叶归因（315964 字节） |
| EVALUATOR_SHADOW_RECOMMENDATION.md | 因果拆解 + 下一代战术特征架构建议 |
| RESOURCE_SAFETY_LOG.md | 源码身份 + 归档 + 进程普查 + 并发纪律 |
| probe/ | seal_lib.ts, seal_util.ts, counterexamples/recertify/cohort/attribution.test.ts, seal.mjs, vitest.config.mts |
| logs/ | counterexamples_run, recertify_g6t3_smoke, cohort_run, attribution_run |
| _raw/ | source_integrity.json |

**回归总计：4 测试文件，12 测试 PASS，0 失败。**
（counterexamples 7 + recertify 3 + cohort 1 + attribution 1）

---

## 10. 下一代战术特征架构建议（影子，供 ChatGPT 裁决，本轮不实现/不接线）

1. **修复 holeControl 符号（最高优先，A 级）。** E1 奖励猫远离洞门，与战术语义相反；
   corrected 反号在 25214 叶精确成立、打破 D2 平局、使 D 分离。建议把 corrected-hole
   作为候选纳入下一代评价器消融，但**须先过量词门 + 独立证书重验**，不得仅凭启发式
   根值变化就接线。
2. **引入跨回合战术 tempo 作为独立影子列（B 级）。** 现有 tempo 回合边界恒定、零判别力；
   提议 `catTurnsToGate − mouseTurnsToGoal` 能方向性区分安全/不安全末态。与现有 10 特征
   并列评估，**不替换**现有 tempo（语义不同）。
3. **特征与量词证书联合，而非替代（B 级硬约束）。** 提议 tempo 无法区分存活与 chance
   依赖；任何「猫存活」认证仍须独立 catSurvive 搜索 + 证书验证。启发式特征只做排序/剪枝
   提示，不做安全判定。禁止用 `!mouseForcesWin` 推导存活（F1 已修复，不得回退）。
4. **chance 依赖单独建模（B 级）。** 把「∀ 正概率 outcome」量词语义显式纳入战术评估，
   不用单一确定性竞速标量掩盖吃黄油 CHANCE 分支。
5. **评价器消融验收门（A 级流程）。** 新特征/符号修正进生产前必须：(a) 过修复后量词门
   （五类＋UNRESOLVED，terminal-before-horizon，cap→UNRESOLVED）；(b) 24 根重跑独立证书
   （0 policyMisses）；(c) 冻结 fixture 上逐位复现根值；(d) 不降 600000 cap、不删根、
   不缩减 H0/H1。

---

## 11. 失败证据与诚实局限

- **4 个 UNRESOLVED 根**（G6T2/G2T7/G1T5/G1T8）：cap 600000 截断，prune 禁用后全枚举
  超预算。**绝不**冒充 PASS，**绝不**降 cap/删根/缩 H 来凑 PASS。这是资源不足的诚实
  裁决，不是「真无胜」。
- **G6T2 根级 UNRESOLVED**：根全搜索超 cap；但前缀级 DRRR/UURR 可在 cap 内独立认证。
  根级与前缀级须区分，不可混淆。
- **提议 tempo 非完整分类器**：DRRR(存活) 与 DRDR(chance 依赖) 同 margin=−1，无法区分；
  chance 依赖须靠量词证书，不能靠启发式标量。
- **ABSOLUTE_DEADLINE_GATE=BLOCKED**：外部 docmap-studio benchmark 增加 CPU 竞争，但
  本轮裁决是**正确性**树搜索（布尔量词证明），非计时门；elapsedMs 仅信息性，不作封口判据。
- **F4 为 C 级次要**：prune 预算 6 对非携带回合偏紧，方向 fail-open；随 F3 整体禁用 prune
  后一并消除，非主缺陷。
- **无伪造**：所有数值 live 测量（4 套件 12 测试 0 失败），双协议根值逐位一致，
  identity maxAbsError=0；未沿用上一轮快照冒充本轮 PASS。

---

## 12. 禁止事项核验

`PRODUCTION_SOURCE_CHANGED=NO`、`GAME_RULES_CHANGED=NO`、`SEARCH_MATH_CHANGED=NO`、
`H1_CHANGED=NO`、`SIDECAR_CHANGED=NO`、`NEW_EFFICACY_AUTHORITY=NONE`。
未改生产 H1/搜索算法/规则；未覆盖上一轮工件；未为凑 PASS 改验收标准/删失败见证/调冻结
语义；未降 600000 cap/删根/缩 H0/H1。提议特征仅影子，未接线生产 Hard Cat。
`HEAVY_WORKER_CONCURRENCY=1`、`SERIAL_FRESH_REPETITIONS=TRUE`、
`DUPLICATE_BENCHMARK_CHECK=REQUIRED`、`COMMIT=NO`、`PUSH=NO`、`MERGE=NO`。

**本轮完成后停止，等待 ChatGPT 最终裁决。**