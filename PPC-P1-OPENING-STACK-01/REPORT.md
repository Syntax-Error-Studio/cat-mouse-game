# PPC-P1-OPENING-STACK-01｜开局公平性求解器栈安全修复

**基线**：`PPC-P1-CHECKPOINT-01` 最终候选，HEAD `48eaac6c4f3801d351787696ba5876995b64e8d8`（本轮未 commit）
**唯一改动的生产文件**：`src/game/openingFairness.ts`
**新增测试**：`src/game/__tests__/openingFairnessStackSafety.test.ts`（26 项）

---

## 0. 一句话结论

`catBaseMoves=100000` 这个**合法**配置原本会以 `RangeError: Maximum call stack size exceeded` 崩掉 `certifyOpening` 与 `createGameState`。递归 DFS 已改写为显式栈迭代 DFS：50/50 语义对拍逐字段一致（含节点数、剪枝数、witness、随机消耗次数、stateKey），所有合法预算现在都以 `UNKNOWN`/`NODE_CAP` 有界终止，全量回归 1026 项 0 失败。

---

## 1. 来源与候选保全（SOURCE_INTEGRITY）

| 项 | 值 |
|---|---|
| HEAD | `48eaac6c…`（与 CHECKPOINT-01 相同，未变） |
| 工作区 | 14 个 tracked 被修改（上轮 13 + 本轮 `openingFairness.ts`）、22 个未跟踪（上轮 20 + 本轮交付目录与新测试） |
| 旧归档 | `F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz`，sha256 `5cd73282…` **未变**（本轮只读） |
| 本轮归档 | 另建 `PPC-P1-OPENING-STACK-01-candidate.tar.gz`，**不覆盖**旧包 |
| 那个无关的 `.doc` | 未触碰 |
| 冻结校验 | 回归+构建后复测：清单 26 个文件 **26/26 哈希一致**，HEAD 未变（`logs/18_post_regression_freeze.log`、`_raw/freeze_check.json`） |

### 1.1 八个关键前缀与 brief 的差异（已完全解释）

brief 给出 8 个 8 位前缀。其中 **4 个匹配、4 个不匹配**，不匹配的正是 CHECKPOINT-01 自己改过的 4 个文件，brief 里写的是它们**修复前**（即 `PPC-P1-CLOSURE-FIX-01`）的值：

| 文件 | brief | 实际 | 判定 |
|---|---|---|---|
| `transposition.ts` | `7b4aa8eb` | `7b4aa8eb` | MATCH |
| `deadlineContext.ts` | `ced44944` | `ced44944` | MATCH |
| `hardTurnPlanner.ts` | `27b1ce6d` | `27b1ce6d` | MATCH |
| `expectiminimax.ts` | `8ac26985` | `8ac26985` | MATCH |
| `engine.ts` | `5a51e837` | `099f9a7b` | brief 值是 CHECKPOINT-01 修复前值 |
| `planBound.ts` | `f1427ae1` | `4a212b75` | 同上 |
| `planQuality.ts` | `d8ecdd26` | `46979485` | 同上 |
| `config.ts` | `978c6c9f` | `60e38c49` | 同上 |

两侧值都记录在 `PPC-P1-CHECKPOINT-01/SOURCE_MANIFEST.json` 的 `preRoundSha256` / `postSha256` 中，**未解释分歧 = 0**（`SOURCE_MANIFEST.json → briefPrefixReconciliation`）。

---

## 2. 修复前的错误见证（PRE_FIX_STACK_FAILURE = REPRODUCED）

`_raw/baseline_witness_pre.json`、`logs/01_baseline_witness_pre_fix.log`：

| `catBaseMoves` | 配置校验 | `certifyOpening` | `createGameState` |
|---|---|---|---|
| 4 | PASS | CERTIFIED / 931 节点 / 47ms | `ok(state)` |
| 1000 | PASS | UNKNOWN / NODE_CAP / 20000 节点 / 12298ms | `ok(state:null)` |
| **100000** | **PASS** | **THROW `RangeError: Maximum call stack size exceeded`** | **同样 THROW** / 522ms |
| 6004799503160661 | FAIL | 未执行 | `ok(state:null)` / `INVALID_CONFIG` |

栈溢出帧链（原始日志逐字保留）：

```
RangeError: Maximum call stack size exceeded
  at catMove (engine.ts:908:17)
  at simulateSearchAction (ai/simulator.ts:46:26)
  at isEffective (ai/legalActions.ts:72:15)
  at generateLegalSearchActions (ai/legalActions.ts:55:11)
  at solve (openingFairness.ts:463:39)
```

递归上限量化（`_raw/stack_threshold_pre.json`）：`M=500`、`M=1000` 可完成；**`M≥1500` 全部抛 `RangeError`**，且每个都在 56–79ms 内立刻死掉——说明崩在帧耗尽，而不是搜索判定。

**分类**：`LEGAL_INPUT_TRIGGERED_RUNTIME_EXCEPTION`。它既不是 `UNKNOWN` 也不是 `NO_CERTIFIED_OPENING`：失败根本没有任何判定产出，宿主无法区分「开局不安全」与「运行时崩溃」。数值非法路径（`6004799503160661`）不受影响，仍由配置层拒绝。

---

## 3. 改造形态（ITERATIVE_SOLVER = IMPLEMENTED）

`openingFairness.ts`：**+284 / −103**，723 → 904 行，29272 → 35834 B，行尾保持 **LF**，sha256 `27c97202…` → `9d19279c…`。

递归函数被拆成 `enterNode`（序言）、`childFrame`（真实 transition）、`finishNode`（尾声）、`advanceChance` / `onChanceChild`（CHANCE 两段），由 `solve()` 的显式栈循环驱动。帧只持有状态**引用**，不复制棋盘，峰值存活帧数 = 递归深度。详细逐项等价性论证见 `ITERATIVE_SOLVER_DESIGN.md`。

---

## 4. 正常配置 parity（NORMAL_OPENING_PARITY = PASS）

**方法**：同一份探针 `probe/parity_capture.test.ts`，在改写前后各跑一次，记录证书的**每一个**可观测字段（`verdict`/`reason`/`horizonTurns`/`maxNodes`/`exploredNodes`/`prunedNodes`/`witnessAction`）外加生成计数、`stateKey`、以及 `Math.random` 的**精确消耗次数**；比较是整个记录的 JSON 深等，不是只看 verdict。

**结果：50 / 50 逐字段一致，0 差异**（`SEMANTIC_PARITY_RESULTS.json`、`logs/03_parity_pre.log`、`logs/04_parity_post.log`）。

覆盖：普通追击 / 推箱 / 绕路 / 推箱堵路 / 传送通道 / 鼠用技能 / 6 类黄油 CHANCE（含 4 种非法权重 + 质量和非 1 + SAFE 优先控制组）/ 4 类 pending ghost / 巡逻上界三型 / 节点预算 1 与 200000 / `relaxedPrune` 开与关 / 深预算 500 与 1000 / 自动生成 4 型。

最硬的三个证据：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| `default_seeded`（固定种子 10×10 开局） | `CERTIFIED` / 1161 节点 / 84 剪枝 / `randomDraws` 相同 / `stateKey` 相同 | 完全相同 |
| `deepM1000` | `UNKNOWN`/`NODE_CAP` / 20000 节点 / 27 剪枝 / `randomDraws=54` | 完全相同 |
| `rush_h1_cap1`（`maxNodes=1`） | `UNKNOWN`/`NODE_CAP` / 1 节点 | 完全相同 |

**探针自身确定性**：修复前连跑两次字节相同（`parity_pre.json` vs `parity_pre_run1.json`，50/50）。

**修正一处我自己的测量瑕疵（已披露）**：`baseline_witness` 探针里 M=4 的记录在修复前后是 931 vs 1862 节点，看起来像分歧。经查该探针直接调 `createInitialState(DEFAULT_CONFIG)`，而箱子/杂物/黄油的随机摆放没有固定种子（`engine.ts:332/410` 使用 `Math.random`）。同一份**修复后**源码连跑三次得 1862 / 1011 / 2935，判定恒为 `CERTIFIED_NO_CERTAIN_CAT_LOSS`（`logs/10_baseline_repeat1.log`、`repeat2`）——差异来自该探针的随机性，不是语义变化。权威 parity 是上面带种子的 `default_seeded`。

**既有生产测试**：`openingFairness.test.ts` + `smallBoardConfig.test.ts` 共 **31 项全通过**（`logs/08_targeted_production_tests.log`）。

**把计数钉进常规测试**：`openingFairnessStackSafety.test.ts` 里 16 条用例把修复前捕获的 `exploredNodes`/`prunedNodes` 写成断言，未来任何漂移都会红。

---

## 5. 深层合法配置（DEEP_STACK_TERMINATION = PASS）

同一输入 `catBaseMoves = 100000`：

| 项 | 修复前 | 修复后 |
|---|---|---|
| `validateGameConfig` | PASS | PASS |
| `createInitialState` | ok（`catMovesLeft=100000`） | ok |
| `certifyOpening` | **THROW** | `UNKNOWN` / `NODE_CAP` / 20000 节点 / 0 剪枝 |
| `createGameState` | **THROW** | `state=null`、`status=unverified:NO_CERTIFIED_OPENING`（既有语义） |
| `FALSE_CERTIFICATION` | — | **0** |

预算扫描（同夹具，两版对比）：

| M | 修复前 | 修复后 |
|---|---|---|
| 500 / 1000 | COMPLETED / UNKNOWN / 20000 | COMPLETED / UNKNOWN / 20000 |
| 1500 / 2000 / 2500 / 3000 / 4000 / 6000 / 20000 / 100000 | **THROW RangeError（8 个全崩）** | 全部 COMPLETED / UNKNOWN / 20000 |

修复后 10/10 全部有界终止，且每次都在节点预算 20000 处停下——**栈深由节点预算封顶，不由输入决定**。`M=100000` 全程 `heapUsed` ≈ 251MB，无 OOM，未调 V8 heap。

---

## 6. CHANCE 与节点预算语义（CHANCE_SEMANTICS / NODE_CAP_SEMANTICS = PASS）

| 断言 | 结果 |
|---|---|
| `maxNodes=1` → `UNKNOWN`/`NODE_CAP`、`exploredNodes=1` | PASS |
| `maxNodes=50` → `exploredNodes ≤ 50`，若 UNKNOWN 则恰为 50 | PASS |
| 时域耗尽（`horizonTurns=1`，猫被箱/堆围死）→ 两档 `relaxedPrune` 均 `UNKNOWN`/`HORIZON` 且节点数相同 | PASS |
| 非法权重 `0` / `-0.5` / `NaN` / `Infinity`（**SAFE 结果排在第一**）→ 全部 `INVALID_CHANCE`，不被短路成证书 | PASS |
| 质量和非 1（0.5+0.4）→ `INVALID_CHANCE` | PASS |
| 同一 SAFE 优先列表 + 合法质量 → `CERTIFIED_NO_CERTAIN_CAT_LOSS`（控制组，证明失败来自权重而非夹具） | PASS |
| 正常结算仍产出 witness（`rush_h1` → `PROVEN_EARLY_FORCED_LOSS`，19 节点，`witnessAction.type='mouseStep'`） | PASS |
| 同输入重复运行结果字节相同（`maxNodes` 50/500/5000） | PASS |
| 完整回归期间无死循环（1026 项在 1705.9s 内全部结束） | PASS |

---

## 7. 全量回归与构建

```
HEAVY_WORKER_CONCURRENCY=1 npx vitest run --maxWorkers=1 --no-file-parallelism
Test Files  82 passed (82)
     Tests  1022 passed | 4 skipped (1026)
  Duration  1705.90s
```

| 项 | 上轮（CHECKPOINT-01） | 本轮 |
|---|---|---|
| 测试文件 | 81 | **82**（+1：新栈安全测试） |
| 通过 | 996 | **1022**（+26） |
| 失败 | 0 | **0** |
| 跳过 | 4 | **4**（同一批） |
| 枚举总数 | 1000 | **1026** |
| 墙钟 | 1724.06s | 1705.90s |

- 4 个跳过仍是 `boundedPlanRefutation.test.ts > G0.3W-4..7`，`ctx.skip()` 语料缺失，**预存在于任何机器**，与本轮无关。
- 新增的 26 项全部在 passed 里，没有为了凑数删/跳过任何用例，没有降低深度、节点上限、断言或 timeout。
- 未提高并发、未扩 heap、未改 100ms/150ms。
- `npx tsc -b` → **exit 0**（0 字节输出）；`npm run build` → **exit 0**，96 modules，7.30s。

**吞吐敏感项（如实列出，不作为性能结论）**：HV18-7 单测 780.07s 撞自身 `WALL_CLOCK_CAP`（与上轮一致）；HV14-10 191.30s；HV14-16 90.36s；HV18-6 71.67s；T1E-B E/F/G 66.62s、A/B/K 44.35s。这些都是本机一次串行运行的绝对墙钟，不可跨机器比较；T1E-B 仍靠上轮批准的 120s 单测预算才不红。

---

## 8. 未做 / 未变

- 未 commit / push / merge / reset / clean / stash / checkout 覆盖；未用 `git apply`；未覆盖旧归档。
- `config.ts` 本轮**零改动**：没有新增 100 / 1000 / 10000 之类玩法上限，`100000` 未被静默降级。
- 没有 `try/catch RangeError` 兜底；溢出在结构上不再可能发生。
- UNKNOWN 不会被提升为 CERTIFIED；`NODE_CAP` / `HORIZON` / `INVALID_CHANCE` / `UNSUPPORTED_CONFIG` 含义与优先级不变。
- H1 / Hard Cat Planner / Search Math / TT / Move Ordering / Sidecar / 陷阱策略 / GAMEPLAY 规则 / 100ms / 150ms：**全部未改**。
- 未开始鼠 AI，未跑 efficacy A/B、3400-job、self-play、oracle、METHOD_A。
- `ABSOLUTE_DEADLINE_GATE` 仍为 `BLOCKED`；`NEW_EFFICACY_AUTHORITY` 仍为 `NONE`。

---

## 9. 流程瑕疵（自曝）

1. **第一次全量回归被中断**（仅跑完 1 个测试文件）。日志保留为 `logs/09_full_regression_INTERRUPTED_partial.log`，并**改名为显式标注**，权威运行是 `logs/13_full_regression.log`。没有并发重试、没有缩小范围。
2. **新测试第一次 4 项失败**：我把 parity 探针的 horizon 参数抄错（ghost 用 H(1) 应为 H(2)、patrol 用 H(2) 应为 H(1)），并用了一个在 h=1 就能判定的夹具去做 HORIZON 断言。修的是**我的转录**，不是生产代码，也没有改断言去迁就实现；改完 26/26 通过。
3. `_raw/baseline_witness.json` 是后缀命名之前的同名产物，内容与 `baseline_witness_pre.json` 相同，保留未删以免丢证据。

---

## 10. 交付物

| 文件 | 内容 |
|---|---|
| `REPORT.md` | 本文件 |
| `BASELINE_FAILURE_WITNESS.json` | 修复前四处参照点、栈溢出帧、递归上限扫描 |
| `ITERATIVE_SOLVER_DESIGN.md` | 显式栈设计、逐项语义等价性论证、内存量级 |
| `SEMANTIC_PARITY_RESULTS.json` | 50 用例逐字段对拍 + 覆盖清单 + 探针确定性 |
| `DEEP_STACK_RESULTS.json` | OS-2 深层预算、10 档阈值扫描、有界性 |
| `REGRESSION_RESULTS.json` | 全量回归统计、跳过分类、与上轮对比、资源安全 |
| `SOURCE_MANIFEST.json` | 26 个文件字节级指纹 + brief 前缀和解 + 不变式 |
| `logs/` 21 份 | 全部原始运行日志（含被中断的那次，文件名已标注） |
| `_raw/` | 结构化原始数据 + 修复前快照（`pre_fix/`：diff.bin、status_pre.txt、sha256_pre.txt） |
| `probe/` | 6 个可重跑探针 + 结果装配/清单/归档/恢复校验脚本 |
| `F:/ppc-checkpoints/PPC-P1-OPENING-STACK-01-candidate.tar.gz` | 版本化增量归档（不覆盖 CHECKPOINT-01） |
| `ARCHIVE_RESTORE_VERIFICATION.json` | 该归档的独立解包核验记录（含最终 sha256） |

### 10.1 归档与恢复核验

- 归档 **29 个成员**：本轮两个源码文件（`openingFairness.ts` + 新测试）+ 6 份结果 JSON + `REPORT.md` + `ITERATIVE_SOLVER_DESIGN.md` + 修复前 Git 快照（`status_pre.txt` / `tracked.diff.bin` / `sha256_pre.txt`）+ 7 份 `_raw` 结构化数据 + 8 个探针脚本 + `RESTORE.md` + `CHECKPOINT_MANIFEST.json`。
- **不是离线自包含**：`RESTORE.md` 明确写出它只含本轮改动字节，完整重建需要基线 commit `48eaac6c` 与 `PPC-P1-CHECKPOINT-01-candidate.tar.gz`（该包 sha256 仍为 `5cd73282…`，本轮只读未改）。
- 恢复核验：在**仓库外** `mkdtemp` 解包，逐文件比 sha256 / 字节数 / 行尾，文件清单双向比对——**29/29 全等，0 缺 0 多，31/31 清单一致**，两个源码文件与当前工作区逐字节相同，**未触碰真实工作树**，全程未使用 `git apply`（本仓库上它会静默 Skipped 且 exit 0）。
- 一个 Windows 坑：GNU tar 把 `F:/...` 当作远端主机（`Cannot connect to F:`），必须加 `--force-local`。已写进脚本注释。
