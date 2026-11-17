# PPC-P1-CLOSURE-FIX-01 · 输入域正确性修复与历史测试权威收口

- **项目:** Project Perfect Cat
- **日期:** 2026-11-13
- **分支:** `ppc/p1-id-state-identity-fix`
- **基线 HEAD:** `48eaac6c4f3801d351787696ba5876995b64e8d8`（未新增 commit）
- **类型:** 最小生产修复 + 测试权威修复 + 取证归档
- **裁决:** 15 门全 PASS，其中 CF-15 为 `PASS_WITH_DECLARED_SCOPE`

---

## 第一部分 · 人话总结

### 1. 这一轮究竟修好了什么？

**修好了一个"非法输入能变成合法对局"的洞。**

猫的每回合步数（`catBaseMoves`）在类型上只是 `number`。校验函数不检查它，原始构造器直接把它拷进 `catMovesLeft`。于是 `2.5`、`NaN`、`Infinity`、`-1`、`0` 全都能造出一个"能跑的对局状态"。它们各自坏在不同地方：

- `2.5` —— 引擎允许猫走**三步**（2.5 → 1.5 → 0.5 → −0.5），但计划上界按 `floor(2.5)=2` 只预算两步，两边对不上；
- `NaN` —— `NaN <= 0` 是假，回合**永不交接**；更糟的是完整性检查的残差判断 `catMovesLeft > 0` 也是假，于是一个被截断的单动作计划会被认证成 **COMPLETE**；
- `±Infinity` —— 无界回合；
- `0` / 负数 —— 回合一开始猫就不能动。

现在三层都关上：配置校验拒绝（`createGameState` 返回 `state: null` / `unverified`）、原始构造器 `createInitialState` 直接抛 `RangeError`、四个计划提取器对非法运行时预算一律失败关闭。

### 2. 猫步数输入域是否已经真正闭合？

**是，但要分清"闭合到什么程度"。**

`catBaseMoves` 必须是**有限安全正整数**（`Number.isSafeInteger && >= 1`）。`0` 不合法。

三个必须说清的边界：

- **`catMovesLeft === 0` 不非法。** 它是回合边界（预算花完），只产生"0 步预算"，与损坏预算分开判定。
- **没有加"最大步数"上限。** 代码库本来没有这个规则上限，我不发明一个。只保证上界计算出来仍是安全整数（`M = 1,000,000 ⇒ 1,500,001`，`Number.isSafeInteger = true`）。
- **没有把 `floor` 改成 `ceil`。** 那是错方向：小数预算本身不符合离散移动合同，`ceil` 只修好上界，引擎的交接条件与完整性判断仍会打架。

### 3. 正常四步猫回合是否完全不变？

**完全不变，有硬证据。**

- 24 个真人根，新旧 `stateKey` **逐字节相同（24/24）**，固定 D1 输出与**修复前现场捕获的冻结工件** `ppcId01-baseline-d1.json` 逐字段相等（value / mate / action / catTurnPlan / 全部诊断 / ttSize）。这一套 35 项 1.43 秒全绿。
- `maxCatTurnPlanActions(M=4) = 7`，仍**小于**旧常量 8 ⇒ 默认地图根本碰不到这个上界。
- 默认配置 `validateGameConfig(...).ok === true`，issues 为空。

### 4. GAME3 T4 是否已经形成明确的历史例外？

**是，而且这个例外比它替换掉的那条断言更强。**

现在的处理不是"把旧数字改掉"，而是：

1. 断言**日志值确实是** `-1052.947…` 且 `mate=null`（证明这一根真的是登记的那一根）；
2. 断言**当前值确实是** `999996` 且 `mate=cat`（精确 `toBe`，无容差）；
3. 用**真实引擎**（`catMove` → `applyNoMoveLoss` → `endTurn`）重放 `下下下左`，必须落到 `cat_wins`，且猫 (8,0)、鼠 (9,0)；
4. 重放日志当年的 `下右右右`，必须**仍在进行中**——证明当年那份日志确实放掉了一个胜利。

历史日志 `GAME3_H1.txt` 的 SHA-256（`a7598bf6…`）由测试自身的 `LOG_SHA256` 表断言，文件从未被写入。例外同时登记进独立工件 `HV14_REPRODUCTION_GAP.json`，classification = `STALE_ENGINE_BLINDSPOT`。

**其余 44 根继续逐值、逐 mate 精确比对，没有容差，没有改成"不劣于历史值"。**

### 5. T1E-B 是否只是测试预算问题？

**是预算问题，但有一个必须说清的细节。**

这个用例跑**两次**无剪枝、深度 4、100 万节点的穷举搜索。同一台机器、字节相同的源码，实测耗时跨 **17.2s 到 43.4s**——2.4 倍波动，横跨 30s 默认线两侧：

| 时点 | 源码 | 预算 | 结果 |
|---|---|---:|---|
| 11-12 | HEAD | 30s | 18.51s 通过 |
| 11-13 上午 | 四轮候选 | 30s | 超时 43.41s |
| 11-13 上午 | **冻结 HEAD 臂** | 30s | 超时 42.37s |
| 11-13 上午 | 冻结 HEAD 臂 | 240s | PASS 39.73s |
| 11-13 上午 | 四轮候选 | 240s | PASS 41.88s |
| 11-13 下午 | 五轮候选 | 30s | 超时 43.41s |
| 11-13 下午 | 五轮候选 | **120s** | PASS 17.24s / 18.89s |

**关键诚实点：加了预算之后它跑出 17–19 秒，也就是说今天用 30s 也会过。** 所以这次放宽不是"修一个当前必现的失败"，而是**去掉一个机器速度依赖**——这个用例今天已经两次在 30s 下超时。

处理方式：只给这一个用例加 `}, 120_000);`（与同文件同量级的 E/F/G、L 一致）。全局 `testTimeout` 未动，`vitest.config.ts` 未动，节点数/深度/TT/αβ/ordering 未动，**六条断言一条没改**。

### 6. 四轮代码是否仍然保持原有边界？

**保持。** 本轮只碰 `catBaseMoves` 的输入域与"非法预算下的失败关闭"，没有碰：

```text
SEARCH_MATH_CHANGED          = NO   （value / mate / depth / TT 全未变，24 根 D1 逐字段相等）
H1_WEIGHTS_CHANGED           = NO
TT_SEMANTICS_CHANGED         = NO
SIDECAR_POLICY_CHANGED       = NO
GAMEPLAY_RULES_CHANGED       = NO
100MS_BUDGET_CHANGED         = NO
150MS_BUDGET_CHANGED         = NO
GLOBAL_TEST_TIMEOUT_CHANGED  = NO
VITEST_CONFIG_CHANGED        = NO
```

### 7. 现在是否具备正式建立 checkpoint 的条件？

**具备。**

- 技术上无阻塞项；128 项定点测试全绿、`tsc -b` exit 0、`npm run build` exit 0。
- checkpoint 形态 = **按 SHA 钉住的未提交快照**（不是 git commit，本轮禁止 commit）。pre-fix 字节流已被实际复原验证过（`git hash-object` 与补丁头部 blob id 全等）。
- 两条需裁决方拍板：① 是否认可 GAME3 T4 作为登记例外（本轮已按此处理，可回退）；② 是否认可 T1E-B 的 120s 预算。

`ABSOLUTE_DEADLINE_GATE` 仍 `BLOCKED`，属"留到独立后续阶段"的项，不阻塞 checkpoint。

---

## 第二部分 · 16 道验收门

| Gate | 目标 | 结果 | 一票证据 |
|---|---|---|---|
| **CF-0** | 分支、HEAD、历史四轮保全 | **PASS** | HEAD 未变；pre-fix 快照在任何编辑前落盘（45,099 B diff + 19,577 B status）；`.doc` sha256 `505bd083…` 未变；6 个交付目录完整 |
| **CF-1** | 输入域明确 | **PASS** | `INPUT_DOMAIN_DECISION.md` + `config.ts` / `planBound.ts` 实现 |
| **CF-2** | 非整数/非有限/负数/零被拒 | **PASS** | 8 个非法值全部 `state: null` + `unverified` + `INVALID_CONFIG` |
| **CF-3** | 原始构造器不能绕过 | **PASS** | 8/8 抛 `RangeError`，不静默规整；合法值构造结果不变 |
| **CF-4** | 非法运行时预算不能生成已认证完整计划 | **PASS** | 四个提取器全部失败关闭；完整性恒 `TRUNCATED`；`catMovesLeft=0` 仍 `COMPLETE_TURN_BOUNDARY` |
| **CF-5** | 正常整数配置与默认地图完全不变 | **PASS** | 24/24 key 逐字节同；固定 D1 与冻结工件逐字段同；35 项 1.43s |
| **CF-6** | P1-PLAN-01 原 19 项 | **PASS** | `02_plan_bound.log` 19/19 |
| **CF-7** | P1-QUALITY-01 新 9 项 | **PASS** | `03_plan_reversal.log` 9/9 |
| **CF-8** | T1E-B A/B/K 120s 通过 | **PASS** | `07_t1eb.log` 1 passed / 88 skipped, 18.89s |
| **CF-9** | GAME3 T4 例外精确登记，原始日志不变 | **PASS** | 测试断言日志 SHA + 双值精确断言 + `HV14_REPRODUCTION_GAP.json` |
| **CF-10** | HV14 其余 44 根逐值匹配 | **PASS** | `reproduced=44 staleBlindspots=1`，无容差 |
| **CF-11** | 494 行之后所有断言真实执行并通过 | **PASS** | 见下方"被解锁的断言" |
| **CF-12** | P1-ID manifest 补档 | **PASS** | `RECONSTRUCTED_PROVENANCE_MANIFEST = true`，四项一致性检查全 true |
| **CF-13** | 四轮来源 SHA 无未解释差异 | **PASS** | 31 条声明：26 直接命中 + 5 本轮改动 + **未解释 0** |
| **CF-14** | TS 与 Vite 构建 | **PASS** | `tsc -b` exit 0（空日志）；`build` exit 0，96 modules，7.09s |
| **CF-15** | 无新正确性失败，已知失败有归因 | **PASS_WITH_DECLARED_SCOPE** | 128/128；范围仅 8 文件 + 编译构建，全量 982 未跑 |

### CF-11：那些以前从未被执行过的断言

修前测试在第 494 行首次不符就抛错，**后面的代码一行都没跑过**。修后实际读到的数：

```text
reruns=45  reproduced=44  staleBlindspots=1
boundMismatchEntries=12          (> 0，合同要求)
planBranchesConflictKeys=2  conflictTurns=1   (> 0)
overwrittenPlanChanges=0
forcedLossFiringRoots=1 [GAME1T4]   (精确等于原断言)
missingSuccessorBranches=0
truncatedRootCandidates=0
selectorPlanChanges=0  totalNodes=12706
```

⇒ 这些历史断言**都成立**，只是以前没有机会被执行。这是本轮最实质的进展。

---

## 第三部分 · 改了什么

```text
13 tracked files changed, +627 / −71（累计 5 轮，相对 HEAD）
其中本轮新增改动集中在 8 个文件 + 1 个新文件
```

### 生产文件（5 个）

| 文件 | 本轮 SHA-256 | 本轮增删 | 改了什么 |
|---|---|---|---|
| `src/game/config.ts` | `978c6c9f35553cad…` | **+21 / −0** | `validateGameConfig` 拒绝非法 `catBaseMoves` |
| `src/game/engine.ts` | `5a51e837b2c56516…` | **+17 / −0** | `createInitialState` 前置 `RangeError` 断言 |
| `src/game/ai/planBound.ts` | `f1427ae19dd6f87d…` | 净增（未量化，见下）| 新增 `hasCertifiableCatMoveBudget`；`catTurnMoveBudget` 不再 floor 猜测 |
| `src/game/ai/planQuality.ts` | `d8ecdd26afc9e790…` | **+28 / −1** | 4 处失败关闭门（完整性 / 单动作计划 / DP 提取 / DP 每节点）|
| `src/game/ai/expectiminimax.ts` | `8ac2698587b426df…` | **+5 / −1** | `buildCatTurnPlan` 日志走查失败关闭 |

> `planBound.ts` 在第一轮清理后是**未跟踪文件**，`git diff` 不含它，pre-fix 只留下 sha256（`99c269f9`），本仓库没有保留其文件副本 ⇒ 本轮增删行数**不量化**，只声明改动内容。其余 4 个文件的数字由 pre-fix 复原目录逐行比对得出（`engine.ts` 先做 LF 归一，否则 CRLF 会让每一行都算"改动"）。

### 测试文件（3 改 + 1 新）

| 文件 | 本轮 SHA-256 | 改了什么 |
|---|---|---|
| `src/game/__tests__/catMoveBudgetInputDomain.test.ts` | `854a601ccc2955dd…` | **新文件**，13 项，5 组 describe |
| `src/game/ai/__tests__/planActionBoundFixtures.ts` | `9e6357cdde151d83…` | `catTurnRoot` 真正吃 `opts.catBaseMoves`（原来硬钉 4）|
| `src/game/ai/__tests__/forcedLossTieBreakHv14Reachability.test.ts` | `d0ebb25e5f5927c2…` | GAME3 T4 登记例外 + 真实引擎见证重放（+107 / −6）|
| `src/game/ai/__tests__/expectiminimax.test.ts` | `521340c59689a6d4…` | T1E-B A/B/K 加 `120_000` 预算 + 记录测量（+14 / −1）|

### 补档（1 个）

`PPC-P1-ID-01/SOURCE_MANIFEST.json` —— 第一轮缺失的来源清单，**显式标注为事后重建**。

---

## 第四部分 · 回归状态

```text
本轮新增测试              13 项（catMoveBudgetInputDomain）
本轮修复的既有测试         2 项（T1E-B A/B/K、FLT-HV14-4）
历史已知失败（范围内）      0
本轮新出现的失败            0
吞吐敏感                    1（T1E-B，已按预算处理并记录波动区间）

01_input_domain        13 / 13
02_plan_bound          19 / 19
03_plan_reversal        9 /  9
04_progress_guard      31 / 31
05_hv14_forensics      16 / 16   (5m31s)
06_hv14_flt             4 /  4
07_t1eb                 1 /  1   (88 skipped by filter)
10_default_map_parity  35 / 35
                      --------
                      128 / 128, 0 failed

tsc -b        exit 0（日志 0 字节）
npm run build exit 0，96 modules，built in 7.09s，index-BX1JG_L4.js 2,713.67 kB
```

**未执行（不得写成 PASS）:** 982 项全量回归、3400-job primary、self-play、exhaustive oracle、METHOD_A、正式 timing benchmark、efficacy A/B。

---

## 第五部分 · 所有未关闭问题

| # | 项 | 状态 |
|---|---|---|
| 1 | `ABSOLUTE_DEADLINE_GATE` | **BLOCKED**（缺权威门槛清单，需一次预注册 timing 实验）|
| 2 | `NEW_EFFICACY_AUTHORITY` | **NONE**（本轮 0 搜索逻辑改动，不宣称棋力）|
| 3 | 982 项全量回归 | **NOT_PERFORMED**（明令禁止）|
| 4 | `mouseBaseMoves` 无同类校验 | 登记，未修（超授权范围）|
| 5 | `PLAN_ACTION_BOUND_PROOF.md §3` 定义域表述 | 代码已闭合，**冻结文档未改**（需授权）|
| 6 | `catAiMove(state)` 省略身份仍自铸窗口 | 既有设计，未改 |
| 7 | HV14 语料 44/45 | 后续引用必须扣除 GAME3 T4 |
| 8 | 工作树行尾不一致（engine.ts / expectiminimax.test.ts 为 CRLF）| 已登记，未改（改则历史指纹全失效）|
| 9 | `git apply` 在本仓库静默 skip 补丁（exit 0）| 已登记为陷阱，恢复须用 `patch -p1` + 哈希复核 |
| 10 | `hv14FiveGameForensics` 无单测级超时（本轮 5m31s）| 吞吐敏感风险，未加预算 |

---

## 第六部分 · Git 工作区状态

```text
branch      = ppc/p1-id-state-identity-fix
HEAD        = 48eaac6c4f3801d351787696ba5876995b64e8d8   (未变)
tracked M   = 13
untracked   = 新增 src/game/__tests__/catMoveBudgetInputDomain.test.ts
                  PPC-P1-CLOSURE-FIX-01/
                  PPC-P1-ID-01/SOURCE_MANIFEST.json
保护文件     = 纸制版作业-…-第二次.doc  sha256 505bd083…  未触碰（mtime 仍 2026-10-16 20:50:04）

COMMIT = NO   PUSH = NO   MERGE = NO   RESET = NO   CLEAN = NO   STASH = NO   REBASE = NO
```

---

## 第七部分 · 最终状态

```text
ROUND = PPC-P1-CLOSURE-FIX-01

INPUT_DOMAIN_CONTRACT      = VERIFIED_INTEGER_ONLY
PLAN_BOUND_INTEGER_PROOF   = PRESERVED
FRACTIONAL_CONFIG          = REJECTED
NONFINITE_CONFIG           = REJECTED
ZERO_CONFIG                = REJECTED

T1EB_TIMEOUT               = 120000
GLOBAL_TEST_TIMEOUT        = UNCHANGED

HV14_ROOTS                 = 45
HV14_EXACT_REPRODUCTION    = 44
HV14_STALE_ENGINE_BLINDSPOT = 1
HV14_POST_494_ASSERTIONS   = EXECUTED_AND_REPORTED

P1_ID_MANIFEST             = RECONSTRUCTED_AND_VERIFIED
UNEXPLAINED_DIVERGENCE     = 0

SEARCH_MATH_CHANGED        = NO
H1_WEIGHTS_CHANGED         = NO
TT_SEMANTICS_CHANGED       = NO
SIDECAR_POLICY_CHANGED     = NO
GAMEPLAY_INTEGER_RULES_CHANGED = NO
100MS_BUDGET_CHANGED       = NO
150MS_BUDGET_CHANGED       = NO

HEAVY_WORKER_CONCURRENCY   = 1
SERIAL_FRESH_REPETITIONS   = TRUE

FULL_REGRESSION            = NOT_PERFORMED
NEW_EFFICACY_AUTHORITY     = NONE
ABSOLUTE_DEADLINE_GATE     = BLOCKED

COMMIT = NO   PUSH = NO   MERGE = NO   RESET = NO   CLEAN = NO   STASH = NO
```

---

## 第八部分 · 交付物索引

| 文件 | 内容 |
|---|---|
| `REPORT.md` | 本文件 |
| `INPUT_DOMAIN_DECISION.md` | 猫步数输入合同 + 逐源码入口依据 + 明确拒绝的错修法 + 未覆盖边界 |
| `CORRECTNESS_RESULTS.json` | CF-0 ~ CF-15 逐门裁决、执行清单、冻结指纹状态、不变式 |
| `HV14_REPRODUCTION_GAP.json` | GAME3 T4 完整台账（日志值/当前值/见证/真实引擎重放/鼠无合法步证据/45 根复算）|
| `REGRESSION_TRIAGE.md` | 5 类失败归因 + T1E-B 八次实测表 + 未执行范围 |
| `SOURCE_MANIFEST.json` | 本轮全部文件 SHA + 5 处非命中的逐条解释 |
| `P1_ID_MANIFEST_RECONSTRUCTION.md` | 第一轮来源补档说明与方法 |
| `CHECKPOINT_MANIFEST.json` | 修复前后快照、恢复依据、行尾陷阱、认证命令 |
| `REMAINING_GATES.md` | 10 项未关闭问题 |
| `logs/` | 10 份原始执行日志 |
| `probe/` | （本轮无新增探针；沿用 `PPC-P1-CLOSURE-01/probe/` 的五支取证脚本）|
| `_raw/` | 交叉校验表、改动指纹表、pre-fix 复原目录 |
| `pre_fix_snapshot/` | 编辑前的 `git diff --binary HEAD` 与完整 status |
