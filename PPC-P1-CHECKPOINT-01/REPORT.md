# PPC-P1-CHECKPOINT-01 · 最终候选快照、数值边界认证与完整回归

日期：2026-11-13　分支：`ppc/p1-id-state-identity-fix`　HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`（未变）
基线：PPC-P1-CLOSURE-FIX-01 候选（未 commit / 未 push / 未 merge）

---

## 0. 最终状态

```
ROUND = PPC-P1-CHECKPOINT-01

SOURCE_INTEGRITY      = PASS
BOUND_NUMERIC_SAFETY  = PASS          （修复前为 FAIL —— 见 §2.3 最小失败见证）
DEFAULT_D1_PARITY     = PASS

CHECKPOINT_CREATED    = YES
CHECKPOINT_RESTORABILITY = PASS       （429/429 成员逐字节一致）

FULL_REGRESSION       = PASS          （81 文件 / 996 passed / 4 skipped / 1000 枚举 / 1724.06s）
TYPESCRIPT_BUILD      = PASS          （tsc -b exit 0，无输出）
VITE_BUILD            = PASS          （96 modules，6.73s，exit 0）

SEARCH_MATH_CHANGED   = NO
H1_CHANGED            = NO
SIDECAR_CHANGED       = NO
GAME_RULES_CHANGED    = NO

ABSOLUTE_DEADLINE_GATE   = BLOCKED
NEW_EFFICACY_AUTHORITY   = NONE

HEAVY_WORKER_CONCURRENCY = 1
SERIAL_FRESH_REPETITIONS = TRUE

COMMIT = NO    PUSH = NO    MERGE = NO
```

本轮的净改动：**4 个生产文件 + 1 个测试文件**，全部属于「计划上界数值可表示性」这一件事。
其余 9 个已修改文件、11 个未跟踪源文件、3 个 fixture **一个字节都没动**（§1.3 逐文件哈希为证）。

---

## 1. 阶段一 · 工作区与来源复核

### 1.1 Git 身份

| 项 | 值 |
|---|---|
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8` |
| 提交 | `research(ppc): archive ARIMAA-01 / PTB-1A / SEARCH-01 / MOUSE-01 / CAT-STRATEGY-01`（2026-11-12 18:43:10 +0800） |
| 分支 | `ppc/p1-id-state-identity-fix`（无 upstream） |
| `core.autocrlf` | `true` |
| tracked M | 13 |
| untracked | 20（8 个 `PPC-P1-*` 目录 + 11 个 src 文件 + 1 个无关 `.doc`） |
| 回合开始前的 vitest 进程 | 0（`ps -W` 计 4 个 node 全部是 WorkBuddy 自身/内置 MCP，非测试负载） |

那个 `.doc`（`纸制版作业-先打印好-后在纸上做作业-第二次.doc`）**没有打开、没有读取、没有修改**。

### 1.2 八个关键文件（brief 给的 8 个前缀）

brief 给的 8 个前缀描述的是**回合开始时**的候选。它们在 CP-0 全部命中（当时 24/24 MATCH）。
其中 4 个在本轮被授权修复，因此**现在**的前缀已经变了 —— 这不是"无法解释的变化"，而是本轮唯一的工作内容：

| 文件 | brief 前缀（= 回合开始） | 现在 | 是否本轮改动 |
|---|---|---|---|
| `src/game/ai/transposition.ts` | `7b4aa8eb` | `7b4aa8eb` | 否 |
| `src/game/ai/deadlineContext.ts` | `ced44944` | `ced44944` | 否 |
| `src/game/ai/hardTurnPlanner.ts` | `27b1ce6d` | `27b1ce6d` | 否 |
| `src/game/ai/expectiminimax.ts` | `8ac26985` | `8ac26985` | 否 |
| `src/game/engine.ts` | `5a51e837` | `099f9a7b` | **是**（+1060 B，仍 CRLF） |
| `src/game/ai/planBound.ts` | `f1427ae1` | `4a212b75` | **是**（+2397 B） |
| `src/game/ai/planQuality.ts` | `d8ecdd26` | `46979485` | **是**（+91 B） |
| `src/game/config.ts` | `978c6c9f` | `60e38c49` | **是**（+1073 B） |

完整 SHA-256、字节数、行尾、`git hash-object` blob 见 `SOURCE_MANIFEST.json` 的 `eightKeyFilesFromBrief`。

### 1.3 全量来源交叉校验

对 6 份历史 `SOURCE_MANIFEST.json` 的 31 条路径声明做自动比对（`logs/01_source_integrity.log`，原始表 `_raw/source_integrity.json`）：

```
filesMeasured           = 24
MATCH                   = 19
SUPERSEDED_BY_THIS_ROUND= 5     （config / engine / planBound / planQuality / catMoveBudgetInputDomain.test.ts）
NEVER_CLAIMED_BEFORE    = 0
UNEXPLAINED_DIVERGENCE  = 0
```

**来源完整性 = PASS。** 5 条 SUPERSEDED 每一条都带 `preRoundSha256`（取最近一份清单，即 CLOSURE-FIX-01），可与 brief 前缀逐一对照。

### 1.4 一处本轮自身的方法学瑕疵（主动登记）

CP-0 的**首次**探针运行（当时 24/24 MATCH，含 8/8 前缀）把结果写进了 `logs/01_source_integrity.log`；
随后我在修复完成后重跑同一个探针，**覆盖了那份日志**。
原始 CP-0 输出因此只剩终端记录，没有落盘。

影响与补救：
- 8 个前缀的"回合开始值"仍然可独立核对 —— 它们等于 CLOSURE-FIX-01 `SOURCE_MANIFEST.json` 里登记的 `candidateSha256`，而那份清单的另外 19 条本轮已经被重新逐字节验证为仍然一致（即该清单与磁盘的对应关系未失效）。
- `BOUNDARY_RESULTS.json` 的 `preFixState.witnessLog` 指向的 `02_boundary_pre_fix.log` 是在**修复前**跑出来的，它记录的是行为证据（4 条失败），不受影响。
- **正确做法**：CP-0 探针应当写成 `01a_cp0_*.log` 并在修复后另起文件名。本轮未做到，登记为流程缺陷。

---

## 2. 阶段二 · 极大整数边界

### 2.1 命题

`B(M) = M + 1 + floor(M/2)`，`M = catMovesLeft`。因为 `B` 是 `M` 的 1.5 倍，
**M 是安全整数不代表 B 是安全整数**：

| M | M 安全？ | B（精确） | B 安全？ |
|---|---|---|---|
| 6004799503160660 | 是 | 9007199254740991 = `MAX_SAFE_INTEGER` | 是 |
| 6004799503160661 | 是 | 9007199254740992 = 2^53 | **否** |
| 6004799503160663 | 是 | 9007199254740995 | 否（float 结果被"四舍六入五成双"抬成 …996，比精确值**大 1**，即上界比证明允许的更松） |

用 BigInt 独立核对，两处（探针组 A、CF-9）。

### 2.2 修复前的防护状况

`hasCertifiableCatMoveBudget(state)` 只检查 `Number.isSafeInteger(catMovesLeft) && >= 0` —— 它验证**输入**，从不验证**推导出来的容量**。
`maxCatTurnPlanActions` 直接返回浮点结果，没有任何检查。
配置层与构造函数层同样只看整数性。
⇒ **没有可靠防护，属于 brief 允许实施最小修复的情形。**

### 2.3 最小失败见证（修复前，`logs/02_boundary_pre_fix.log`）

11 项断言，7 通过 / **4 失败**，4 条恰好是缺失合同：

1. `hasCertifiableCatMoveBudget(M=6004799503160661)` → `true`（应为 `false`）
2. 同一输入下 4 个提取器全部不拒绝：`buildCatTurnPlan` / `buildPlanForFirstAction` / `extractBestCatTurnPlan` / `buildCandidate` 照常工作（应全部失败关闭）
3. `validateGameConfig({catBaseMoves: 6004799503160661}).ok` → `true`（应为 `false`）
4. `createGameState` 同一配置 → **`RangeError: Maximum call stack size exceeded`**（应返回 `state: null`）

第 4 条值得单独记：失败不是来自任何预算检查，而是来自 `openingFairness.solve` ——
它的递归深度由"这个回合有多长"决定，而超大预算使回合永不结束。
也就是说，未经修复时该输入会以**栈溢出**的形式炸在开局公平性求解器里，而不是以诊断的形式失败。

> 未为了测试这个边界而执行任何大规模搜索。全部是函数级验证，单次运行 250ms 量级。

### 2.4 修复：限界来自可表示性证明，不是玩法常量

```
M + 1 + floor(M/2) <= MAX_SAFE_INTEGER    （偶数分支）
⇒ M <= (MAX_SAFE_INTEGER − 1) / 3 × 2 = 6004799503160660
```

源码里就是这个表达式（`MAX_CERTIFIABLE_CAT_MOVE_BUDGET = ((Number.MAX_SAFE_INTEGER - 1) / 3) * 2`），不是字面量。

**被否掉的做法**（写进 `BOUNDARY_RESULTS.json`）：
- 加一个玩法上限（10 / 100 / 1000…）—— brief 禁止，且本项目规矩是数字只能来自规则或来自证明；
- `Math.min(bound, MAX_SAFE_INTEGER)` —— 等于把合法计划截断，正是 brief 禁止的"通过截断上界制造合法计划缺失"；
- 用 `Infinity` 当替代上界 —— 会毁掉 `planBound.ts` 头部 `TERMINATION` 段说明的那个 DP memo 唯一依据；
- 接受状态、让提取器自己乱跑 —— 不安全上界不是"很大的上界"，而是"没有精确值的上界"。

**三层失败关闭**（沿用 CLOSURE-FIX-01 已建立的三层，不新增第四层）：

| 层 | 文件 | 行为 |
|---|---|---|
| 配置 | `config.ts` | `validateGameConfig` 追加一条 `invalid` 问题（含 `基础步数`），⇒ `createGameState` 给 `state: null` / `unverified` / `INVALID_CONFIG` |
| 原始构造器 | `engine.ts` | `createInitialState` 前置 `RangeError`，消息点名 `catBaseMoves`（**不 floor、不 clamp**） |
| 计划谓词 | `planBound.ts` | `hasCertifiableCatMoveBudget` 现在同时要求推导出的 B 可精确表示；`catMoveBudgetRejectionReason` 区分两类失败 |
| 诊断 | `planQuality.ts` | `TRUNCATED` 的原因串引用真实原因，不再把"超出可表示范围"说成"不是非负安全整数" |

四层的效果：4 个提取器 + 完整性判定**共用同一个既有闸门**，不需要改调用点。

### 2.5 修复后验证（`logs/04_boundary_post_fix.log`，11/11 通过）

- `M = 6004799503160660`：可认证，`maxCatTurnPlanActions` = `9007199254740991`（精确 `MAX_SAFE_INTEGER`）。
- `M = 6004799503160661` 及其以上所有安全整数：不可认证，`catTurnMoveBudget` = 0，`maxCatTurnPlanActions` = 1，4 个提取器返回空/null，完整性判定 `TRUNCATED` 且原因含 `invalid cat move budget`。
- 配置层拒绝、`createGameState` 给 `state: null`、`createInitialState` 抛**自己的** `RangeError`（不再是栈溢出）。
- 边界值本身仍然可以真正建局（`catMovesLeft` 原样写入）—— 闸门不是"一刀切拒绝"。
- 边界值上的空计划是**普通截断**（还有步数、还有合法动作），不是预算闸门拒绝 —— 两种情形在日志里不再混淆。

### 2.6 正常预算零变化（CP-3）

`M = 0,1,2,3,4,5,6,7,9,12 → 1,2,4,5,7,8,10,11,14,19`；生产默认 `M=4 → 7`（仍小于旧常量 8）；`M=1e6 → 1500001`。
默认 10×10 开局 `catMovesLeft=4`、`maxCatTurnPlanActions=7`，`validateGameConfig(DEFAULT_CONFIG).ok = true`。
历史 D1 冻结基线由 `stateIdentityCollision.test.ts` 在**全量回归**中比对（通过）：fixture `ppcId01-baseline-d1.json` 逐字段一致 ⇒ **DEFAULT_D1_PARITY = PASS**。

### 2.7 旁见：一个与本轮无关、但必须登记的问题

`openingFairness.solve` 的递归深度随 `catBaseMoves` 增长（预算没花完，回合就不交接）。
因此**一个完全合法的预算**就能把栈打穿：

| catBaseMoves | validateGameConfig | createGameState |
|---|---|---|
| 4 | ok | ok |
| 1000 | ok | ok |
| 100000 | **ok** | **`RangeError: Maximum call stack size exceeded`** |

- 为什么本轮不修：100000 完全可精确表示，任何数值论证都排不掉它；给它设上限就是 brief 明令禁止的"任意玩法常量"；真正的修法是改公平性求解器的递归（算法改动，超出本轮授权）。
- 与上一节的边界问题**互相独立**：它在修复前就存在，本轮的修复既没有造成它、也没有掩盖它。
- 证据：`logs/03_recursion_origin.log`（一次性诊断，源码保留在 `_raw/oneShotOrigins.test.ts.txt`）。

---

## 3. 阶段三 · checkpoint

### 3.1 内容

`PPC-P1-CHECKPOINT-01/checkpoint/` → 打包为 **`F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz`**（仓库外）。

| 类别 | 数量 | 说明 |
|---|---|---|
| `source/` 已修改生产与测试源码 | 13 | 逐字节，不是补丁引用 |
| `source/` 未跟踪新增源码/fixture | 11 | 含 3 个 fixture JSON、6 个新测试、`planBound.ts`、`planActionBoundFixtures.ts` |
| `evidence/` 历次取证 | 396 | ID-01 / TIME-01 / TIME-02 / PLAN-01 / QUALITY-01 / CLOSURE-01 / CLOSURE-FIX-01 原样 |
| `git/` 快照 | 8 | HEAD、提交身份、分支、`core.autocrlf`、porcelain、diffstat、name-status、`git diff --binary` |
| `RESTORE.md` + `CHECKPOINT_MANIFEST.json` | 2 | 恢复说明 + 429 条成员清单（sha256/bytes/EOL） |

清单本身是第 430 个文件：它不能把自己列进自己的哈希表，因此恢复校验把 `CHECKPOINT_MANIFEST.json` 排除在"成员"之外单独处理（`extras` 检查已扣除它）。

`CHECKPOINT_MANIFEST.json` 的 sha256 = `12ed3fc6d577efb5d8e24a799590f79361df70b47cbf7513d00269124154f216`。
压缩包 sha256 = `5cd732828856f2b3cd903cc20c584bbb0fec7906d283ec08415bd2653a9425d5`，4,051,823 B。

### 3.2 是否离线自包含：**否**，如实声明

档案只含**相对基线的差异 + 证据**，不含整棵树。
从基线重建候选还需要 `git checkout 48eaac6c…` 提供的未被本线触碰的文件。
除此之外不需要网络、不需要生成物、不需要打补丁。`RESTORE.md` 把这条依赖写在第一条。

### 3.3 独立恢复验证（`logs/08_restore_verification.log`）

在仓库外新建 `mkdtemp` 目录解包（`tar -xzf`，**不使用 `git apply`**，不对真实工作树做任何写操作）：

```
manifestMembers     = 429
byte-exact matches  = 429 / 429
failures            = 0
extras              = 0
missing             = 0
archive == worktree = 420 matched / 0 mismatched
CRLF 成员           = 28（含 src/game/engine.ts、expectiminimax.test.ts）
VERDICT             = PASS
```

六项要求逐条对应：解包（是）／逐文件 SHA-256（429/429）／必要未跟踪文件与 fixture（`missing=0`，11 个新增源码全部在）／行尾（28 个 CRLF 成员原样，`engine.ts` 仍是 CRLF）／文件列表双向一致（`extras=0`、`missing=0`）／原始日志（已保留）。**不依赖 `git apply` 退出码。**

---

## 4. 阶段四 · 完整串行回归

### 4.1 执行条件

```
HEAVY_WORKER_CONCURRENCY = 1
npx vitest run --maxWorkers=1 --no-file-parallelism --reporter=verbose
全局 testTimeout = 30000（未动）
未提高并发 / 未加 --max-old-space-size / 未缩小范围 / 未降深度 / 未降节点上限 / 未改正确性断言
跑之前 vitest 进程数 = 0，运行期间无任何其它 heavy Node / self-play / oracle / benchmark
```

### 4.2 结果

| 项 | 值 |
|---|---|
| 测试文件 | **81 passed (81)** |
| 用例 | **996 passed** / 0 failed / 4 skipped（共 **1000** 枚举） |
| 用时 | **1724.06s**（tests 1694.40s） |
| 退出码 | 0 |
| 失败项 | 无 |
| 本轮引入的失败 | **0** |

**预期对齐**：上一轮全量枚举 982，CLOSURE-FIX-01 新增 13 → 995；本轮新增 5（CF-9）→ **1000**。运行器枚举正好 1000，**没有为了凑数字删任何用例**。

4 个 skipped 全部是 `boundedPlanRefutation.test.ts` 的 `G0.3W-4..7`，机制是 `ctx.skip()`：该文件的 G4/G1 语料根在本机不存在（文件第 344 行有说明），因此**在任何机器上都会跳过**。分类 `PRE_EXISTING_ENVIRONMENT_CONDITIONAL_SKIP`，与本轮无关。

### 4.3 吞吐敏感项（真实存在的风险）

| 用例 | 今天 | 参照 |
|---|---|---|
| T1E-B E/F/G（`expectiminimax.test.ts`） | **70.5s** | CLOSURE-FIX-01 同期 17.2–18.9s → **慢 3.7×** |
| HV18-7 GAME4 T7 bounded survival (h=3) | **780.0s** | 自带 `WALL_CLOCK_CAP`（`overflow=WALL_CLOCK_CAP`，heap 980MB） |
| HV14-10 GAME4 T7/T8 deeper search | 206.5s | — |
| HV14-16 GAME1 T1-T3 depth-3 mate probe | 94.5s | — |

**T1E-B 这一条是关键**：同一份源码三轮前 17–19s，今天 70.5s。
上一轮批准的 `120_000ms` 单测预算今天是**唯一**让它通过的原因；若仍是全局 `30s`，它会以 2.3× 超时。
这印证了上一轮的定性：这不是"修必现失败"，而是"去掉机器速度依赖"。
（这些是单机单次串行的墙钟数字，**不是**性能测量，不可跨机比较。）

### 4.4 构建

```
npx tsc -b        → exit 0，零输出（logs/10_tsc.log，0 字节）
npm run build     → exit 0，96 modules transformed，built in 6.73s（logs/11_build.log）
```

`dist/` 在 `.gitignore` 中，构建不污染工作树。

### 4.5 冻结校验：测的就是归档里的那一份

回归 + 构建之后重新逐字节比对（`logs/12_post_regression_freeze.log`，`_raw/freeze_check.json`）：

```
source members     = 24 / identical 24
evidence members   = 396
changed or missing = 0
VERDICT            = PASS
```

HEAD 仍为 `48eaac6c…`。tracked 修改 13、untracked 20（新增的只有本轮的 `PPC-P1-CHECKPOINT-01/`）。

---

## 5. 验收门

| Gate | 结论 | 证据 |
|---|---|---|
| CP-0 | **PASS**（含 §1.4 登记的日志覆盖瑕疵） | `logs/01_source_integrity.log`、`_raw/source_integrity.json`、`SOURCE_MANIFEST.json` |
| CP-1 | **PASS** | `logs/04_boundary_post_fix.log` 组 A；CF-9 组 `pins the exact edge…` |
| CP-2 | **PASS** | 同日志组 B、C；`BOUNDARY_RESULTS.json` `fix.layers` |
| CP-3 | **PASS** | 全量回归中 `stateIdentityCollision.test.ts`（D1 冻结 fixture）；`planTurnActionBound.test.ts` 24 根；`logs/04` 组 D |
| CP-4 | **PASS** | `checkpoint/`（429 成员，13.0 MB 实体字节） |
| CP-5 | **PASS** | `RESTORE_VERIFICATION.json`、`logs/08_restore_verification.log` |
| CP-6 | **PASS** | 解包在仓库外 `mkdtemp`；无 `git apply`、无 reset/clean/stash/checkout |
| CP-7 | **PASS** | `REGRESSION_RESULTS.json`、`logs/09_full_regression.log` |
| CP-8 | **PASS** | `logs/10_tsc.log`（空）、`logs/11_build.log` |
| CP-9 | **PASS** | `evidence/` 396 文件原样归档 + `freeze_check` 396/396 一致；HV14 GAME3 T4 例外仍在 `forcedLossTieBreakHv14Reachability.test.ts` 中生效 |
| CP-10 | **PASS** | 996 passed / 0 failed；无新增未解释正确性失败 |

没有任何一门被写成 PASS 却只有 `NOT_PERFORMED` / `BLOCKED` / `DIAGNOSTIC_ONLY` 支撑。

---

## 6. 未关闭事项

1. **`ABSOLUTE_DEADLINE_GATE = BLOCKED`** —— 本轮未触碰 100ms/150ms 契约，也未做绝对截止门认证。
2. **`NEW_EFFICACY_AUTHORITY = NONE`** —— 全量回归只证明"没坏"，不证明"更强"。本轮任何数字都不得被引用为棋力提升。
3. **`openingFairness` 递归深度随 `catBaseMoves` 增长**（§2.7）—— 合法的 `catBaseMoves=100000` 会栈溢出。属于预存缺陷，需算法层修复，超出本轮授权。
4. **`mouseBaseMoves` 仍无同类输入域校验**（沿用 CLOSURE-FIX-01 的遗留）。
5. **`PLAN_ACTION_BOUND_PROOF.md §3` 的定义域表述**仍只写了"非负安全整数"，未写入本轮的"上界本身也必须可表示"。代码已闭合，冻结文档未改（不在本轮授权内）。
6. **HV14 语料 44/45**：GAME3 T4 是登记例外，后续引用必须扣除该根。
7. **`catAiMove(state)` 省略身份时自铸窗口** —— 唯一未认证的 deadline 铸造点，未变。
8. **行尾双重约定**：`engine.ts` 与 `expectiminimax.test.ts` 工作区是 CRLF、`git diff` 是 LF 归一补丁。任何 sha256 比对必须先声明行尾。
9. **§1.4 的 CP-0 日志覆盖** —— 已在本报告内显式登记，未掩盖。

---

## 7. 明确未做

未改 H1 权重、未改 Search Math / αβ / TT / Move Ordering、未调 Sidecar 与 Progress Guard、未调陷阱策略、未改 `GAMEPLAY.md` 实际规则、未开始鼠 AI、未跑 efficacy A/B、未跑 3400-job primary、未跑大型 self-play / oracle / METHOD_A、未改任何历史冻结门槛、未 commit / push / merge / reset / clean / stash。

---

## 8. 证据索引

| 文件 | 内容 |
|---|---|
| `logs/01_source_integrity.log` | 24 文件 × 6 份历史清单交叉校验 |
| `logs/02_boundary_pre_fix.log` | 修复前最小失败见证（4 失败） |
| `logs/03_recursion_origin.log` | `openingFairness` 栈溢出来源（一次性诊断） |
| `logs/04_boundary_post_fix.log` | 修复后 11/11 通过 |
| `logs/05_input_domain.log` | 常驻测试 18 项通过（13 旧 + 5 新 CF-9） |
| `logs/06_tsc_precheck.log` | 回归前类型检查 exit 0 |
| `logs/07_checkpoint_build.log` | 429 成员 / 12.41 MiB 构建记录 |
| `logs/08_restore_verification.log` | 独立解包 429/429 逐字节一致 |
| `logs/09_full_regression.log` | 全量串行回归原始输出（996+4 / 1724.06s） |
| `logs/10_tsc.log` | 空（exit 0） |
| `logs/11_build.log` | Vite 96 modules / 6.73s |
| `logs/12_post_regression_freeze.log` | 回归后 24/24 源码仍与档案一致 |
| `probe/boundary_witness.test.ts` + `probe/vitest.config.mts` | 边界探针（独立配置，不污染 `src/**` 计数） |
| `probe/source_integrity.mjs` / `build_checkpoint.mjs` / `verify_restore.mjs` / `verify_frozen.mjs` / `parse_regression.mjs` | 五个只读/只写报告的探针脚本 |
| `_raw/source_integrity.json`、`_raw/freeze_check.json`、`_raw/oneShotOrigins.test.ts.txt` | 原始结构化数据与一次性诊断源码 |
| `F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz` | 可独立恢复的 checkpoint |
