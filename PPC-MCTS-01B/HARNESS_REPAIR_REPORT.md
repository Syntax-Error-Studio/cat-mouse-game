# HARNESS_REPAIR_REPORT

`PPC-MCTS-01B-HARNESS-REPAIR` — 正式实验基础设施修正（Phase 1 / Phase 2 驱动器）

结论：**harness 已修正并通过轻量验证；96/96 既有固定节点上限 parity 未被破坏；正式 960 + 960 未启动。**

---

## 1. 预检（第一步，全部实测）

| 项 | 值 |
|---|---|
| branch | `ppc/p1-id-state-identity-fix` |
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8`（`research(ppc): archive ARIMAA-01 / PTB-1A / SEARCH-01 / MOUSE-01 / CAT-STRATEGY-01`） |
| 工作树 | 69 项（14 modified + 55 untracked），**未做任何 reset / clean / stash / checkout / restore** |
| 本轮新增 git 状态 | 0（`PPC-MCTS-01B/` 原本就是未跟踪目录） |
| commit / push / merge | 0 |
| 其他 heavy 进程 | 无。node 进程仅 WorkBuddy 自身 daemon（edge-sync / ima / baas / sheetagent / weixinpay / ardot）与 Codex 运行时，均为空闲壳，无 vitest / node 计算任务 |
| 重复 benchmark | 无。`PPC-MCTS-01`（Pilot，已冻结）、`PPC-MCTS-01A`（诊断，只读）、`PPC-MCTS-01B`（本轮）三者职责不重叠；`data/` 下无同名并行产物 |
| CPU | i7-14650HX，24 逻辑核，预检瞬时负载 5% |
| 物理内存 | 总 15.7 GB，**可用 1.85 GB** |
| 提交内存 | 总 33.4 GB，可用 5.38 GB |
| pagefile | `C:` 2048 MB（当前 1388 MB，**历史峰值 2047 MB ≈ 已打满**）；`E:` 16087 MB（当前 1907 MB） |
| 并发约束 | `HEAVY_WORKER_CONCURRENCY=1`、`SERIAL_FRESH_REPETITIONS=TRUE`，全程遵守 |

> 内存要点：`C:` pagefile 峰值已达上限，可用物理内存不足 2 GB。本轮所有验证均为串行单进程，未提高并发、未扩 V8 heap。正式 960 次实验启动前建议复核这一项（见 §8）。

---

## 2. 代码修改清单（逐项）

只改 `PPC-MCTS-01B/`。`src/`、`GAMEPLAY.md`、`PPC-MCTS-01/`、`PPC-MCTS-01A/` 全部 0 改动。

### 2.1 新增

| 文件 | 作用 |
|---|---|
| `proto/trace.ts` | 只读、无 RNG 副作用的 trace 模型：规范序列化 + 增量 SHA256、每次 simulation 一个 digest、`captureSimulation` 按需保留完整事件 |
| `proto/uctBaseline.ts` | `PPC-MCTS-01/proto/uct.ts` 的 fork，唯一新增 = 测试接缝 `maxCompletedSimulations` + 诊断插桩 |
| `drivers/lib/phase1.ts` | Phase 1 臂运行器、整棵搜索树 digest、可比投影、逐 simulation diff、执行异常闸门 |
| `drivers/phase1Parity.ts` | Phase 1 驱动器（一 repetition 一进程），JSONL 追加 + 首差异取证 |
| `probe/impl/phase1Seam.test.ts` | H1–H7 harness 正确性测试 |
| `scripts/runPhase2.mjs` | Phase 2 串行编排器（`spawnSync`，进程退出后才起下一个） |
| `scripts/verify-baseline-fork.mjs` | 生成 `BASELINE_FORK_PROVENANCE.json` 与 `DIFF_uct_to_uctBaseline.patch` |
| `scripts/gen-build-manifest.mjs` | 生成 `BUILD_MANIFEST.json` 与 `SHA256SUMS.txt`（自指排除规则） |

### 2.2 修改

| 文件 | 修改内容 |
|---|---|
| `proto/uctPrepared.ts` | 加入**与 baseline fork 完全相同**的接缝与 trace 事件点；`diagnostics` 增加 `completedSimulationLimitHit`，`UctResult` 增加 `planTraceDigest`。无接缝无 sink 时行为不变（H1/H4 证明） |
| `drivers/lib/arms.ts` | 新增 `withMathRandomCounter`（计数不抛）；`runArm` 增加 `guardMode`，默认仍为 `'throw'`，因此既有 A–F 与 96 单元的语义 0 变化 |
| `drivers/parityFixedSims.ts` | **修正核心缺陷**：默认工作负载由 `maxNodes` 改为 `maxCompletedSimulations`；保留 `--legacy-nodes` 以复现 96 单元回归 |
| `drivers/perfBudget100.ts` | 计时三分离（`searchMs` / `plannerWallMs` / `replayMs`）；补齐任务要求的全部字段；JSONL 逐条追加 + checkpoint + resume；150 ms 主口径沿用 Pilot（replay-inclusive），并列记录 planner-only 参考口径 |
| `scripts/build-drivers.mjs` | 增加 `phase1Parity` 入口；输出 `build/BUILD_OUTPUTS.json`（含每个 bundle 的 sha256 与字节数） |
| `probe/impl/rolloutReuseParity.test.ts` | 修正 trap/butter overlap 合成状态的随机流隔离（详见 §4） |

### 2.3 关键设计决定

**(a) 接缝位置。** `maxCompletedSimulations` 只在 simulation 循环**顶部**判定，即在 `backprop` 返回、`sims++` 之后。因此「达到 K」永远是 K 条**完整** simulation，不存在中途停止；生产 `maxNodes=500000` 保留为安全网，一旦先触发即判 `HARNESS_EXECUTION_ANOMALY`，不降 K。

**(b) 两臂共用同一接缝。** `uctBaseline.ts` 与 `uctPrepared.ts` 的接缝代码逐行同构（字段、判定、上报标志），而不是两套各自实现的「停 K 条」。H2 在 32 个 arm-call 上验证了两臂都精确停在 K。

**(c) trace 的两条硬约束如何被结构性保证，而非靠承诺。**
- 不消费随机数：collector 里没有任何 RNG 调用，记录的全是搜索**已经算出**的值。
- 不改变 RNG 顺序：`countingTraceRng` 把 `next()` / `int(n)` 直通委托；`mulberry32` 的 `int` 调用的是其闭包内私有 `next`，因此 `int` 只推进一次状态、只产生一条记录。
- H4 用「有 sink ≡ 无 sink，整棵树 fingerprint 相同」直接证明。

**(d) 首次差异的完整明细。** 不缓存全部事件（960 × 200 条 sim 会爆内存）。改为：每个 sim 只有 digest 留在内存；一旦某个 sim digest 不同，驱动器以 `captureSimulation = i` 重跑该 (root, repetition, arm)，捕获两臂该 sim 的完整事件与两侧 plan digest。因为整条 call 是确定性的（时钟冻结、种子固定、K 固定、Math.random 固定种子 stub），重跑可复现同一事件流。

**(e) 关于 Math.random。** 全代码只有一个非纯路径：`engine.catMove → sanitizeItemOverlaps` 在「陷阱压在黄油上」时用 `Math.random` 搬走黄油。Phase 1 因此安装**固定种子 LCG stub** 并在每条 call 前重置，记录 `mathRandomDraws`。实测 **24 根全部为 0**（`data/phase1-chance-probe`、`data/phase1-smoke`），即该 stub 在本实验语料上从未被用到——这是比「用了 stub」更强的结论。

---

## 3. Phase 1 修正

### 3.1 旧驱动器为什么不可能成立

`parityFixedSims.ts` 用 `maxNodes` 停止。节点由决策产生，所以「两臂跑同样多条 simulation」在节点上限下**等价于**「两臂已经决策相同」——它把待检验的性质当成了前提。同时它只在最后比较整树 fingerprint，无法定位是哪一条 simulation 分叉。

### 3.2 现在的固定合同

```
PHASE1_ROOTS = 24
PHASE1_REPETITIONS = 20
PHASE1_ARMS = 2
COMPLETED_SIMULATIONS_PER_CALL = 200
TOTAL_SEARCH_CALLS = 960
FRESH_NODE_PROCESSES = 20
MAX_HANDOFFS = 4        MAX_NODES = 500000        c = sqrt(2)
rollout = hybrid（两臂相同）      now() = 0，deadlineMs = 1 ⇒ deadlineAt = 1（永不触发）
seed = uctSeed(rootId, 'UCT-H', repetition)（两臂同 seed）
```

`--sims` 在非 `--smoke` 下被**拒绝**；`--roots` 非 `all` 在非 `--smoke` 下被拒绝。K 不能悄悄降低。

### 3.3 必须一致的轴（全部实现并比较）

200 条 simulation 的数量 / 每条 simulation 的事件序列（逐条 SHA256）/ 每条 digest / 整棵树（节点 kind、handoff 深度、stateKey、访问数、总奖励与均值、边 key 与 transition kind、CHANCE 权重与逐 outcome 采样计数与 stateKey、massError）/ 节点访问统计 / 累计 reward / 平均 reward / CHANCE 采样数 / 最终计划（含 planCost、treePlanLength、extensionSteps、rootAction、逐 root 动作统计）/ plan 阶段 digest。

允许不同：`elapsedMs`、`wallMs`、`ruleCalls`。

---

## 4. 正确性测试修正（trap/butter overlap 的随机流隔离）

### 4.1 缺陷

共享语料里放了一个**猫回合**的合成状态，`trapPosition` 压在黄油上。该状态不是其输入的函数：`catMove → sanitizeItemOverlaps` 会用 `Math.random` 把黄油搬走。后果两条：

1. 测试 A 对同一状态枚举两次（legacy + prepared），两次各抽新熵搬黄油，合法动作集可能不同 ⇒ A 可能间歇性失败；
2. 在**任何守卫之外**推进了全局 `Math.random`，污染后续所有测试的熵账。

### 4.2 修法

- overlap 覆盖点改由**鼠回合**合成状态承担：`mouseStep` 不做 sanitize，overlap 会原样进入后继，但全程不触碰 `Math.random`；
- 语料构建、`infoOf(...)`、测试 A 的整段枚举全部套上 **throw-on-call** 守卫并断言 `draws === 0`；
- 新增结构断言：语料中每个 overlap 状态必须是鼠回合，防止将来被悄悄改回猫回合；
- fail-closed fallback 由 **F 专项测试独立验证**（确定性 LCG stub + 重置流），这是唯一允许发生该 impurity 的地方。

### 4.3 影响面

只改测试**输入**，不改断言语义。A–F 全部重跑通过（最终一轮 `Tests 14 passed (14)`，含新增 H6，见 §5）。

---

## 5. 测试结果

### 5.1 harness 正确性（`probe/impl/phase1Seam.test.ts`）

| 用例 | 内容 | 结果 |
|---|---|---|
| H1 | baseline fork vs 原始 `uct.ts`，96 单元（24 根 × 2 rollout 模式 × {64, 200} 节点上限），整树 fingerprint / plan / planCost / root 统计 / 全部可比 diagnostics / chanceSamples 全等 | **PASS**，96/96 单元，11 101 条 simulation 逐字段一致 |
| H2 | K ∈ {1,2,3,5} × 2 臂 × 4 根 = 32 arm-call：`simulations === K`、`completedSimulationLimitHit === true`、`nodeCapHit/deadlineHit === false`、`aborted === 0` | **PASS** |
| H3 | digest 前缀性质：K=20 的前 k 条 digest 必须等于 K=k 的 digest（baseline k∈{1,3,7,12}，prepared k∈{2,9}）；且 K=20 两臂 20/20 digest 相同 | **PASS** |
| H4 | 有 trace ≡ 无 trace：整树 fingerprint、plan、root 统计、全部可比 diagnostics 相同（两臂各 K=30） | **PASS** |
| H5 | trace 确定性 + 不泄漏实现身份：同一 call 跑两次 digest 与 plan digest 相同；sim#4 事件体在两臂之间逐字节相同（68 事件，含 9 条 `rng.draw`） | **PASS** |
| H6 | CHANCE 确实被走到：K=8（`repetition=0` 的 seed）时 24 根中 10 根触发 CHANCE（**144** 次采样），两臂全字段一致 | **PASS** |
| H7 | 整树 digest 稳定且可区分（K=10 两次相同、K=11 不同） | **PASS** |

> 说明：H1 在 vitest 下需约 285 s（实测 284.8 s），因为 vitest 的 SSR shim 让 leaf evaluator 慢约 7×。这不是性能结论，只是正确性测试的运行成本。

### 5.2 既有 A–F（`probe/impl/rolloutReuseParity.test.ts`）

| 用例 | 关键计数 | 结果 |
|---|---|---|
| 语料构建 | 5643 状态；12 个场景全部 > 0；`impure-guard = 1`（鼠回合）；守卫下 `Math.random` draws = 0；overlap 状态全为鼠回合 | **PASS** |
| A 动作集/顺序/originalIndex | 全语料，守卫下 draws = 0 | **PASS** |
| B 复用 transition ≡ 重算 | deterministic 17 949 / chance 971 / outcomes 13 390；纯语料 Math.random draws = 0 | **PASS** |
| C guidance 位精确 | 18 920 次比较（chance 加权 971） | **PASS** |
| D 选择与 RNG 抽样次数 | 11 206 次选择，hybrid tie-break 593，chance 抽样 3 884 | **PASS** |
| E 固定节点上限整树 parity | 24 单元 | **PASS** |
| F fail-closed（确定性 stub） | 两臂 draw 数相同、整树相同、`rolloutLegacySteps === rolloutImpureFallbacks` | **PASS** |

汇总（最终定稿轮，`data/vitest-final-verify.log`）：`Test Files 2 passed (2) · Tests 14 passed (14) · 417.42 s · exit 0`。

### 5.3 96/96 固定节点上限 parity 回归（未被破坏）

```
node build/parityFixedSims.mjs --legacy-nodes=64,200 --roots=all \
  --modes=hybrid,random --out=data/impl-parity-breadth.json
→ PASS 96/96 cells | rule calls 878 625 → 570 561 (35.06% fewer) | 2 m 47 s
```

与上一轮 `impl-parity-breadth.json` 的 `cells=96 / passed=96 / ruleCalls 878625→570561` **完全一致**。

### 5.4 固定 completed-simulation parity（新工作负载）

```
node build/parityFixedSims.mjs --smoke                       → 2/2 cells, K=20
node build/phase1Parity.mjs --smoke --roots=all --sims=8     → 24/24 cells, 0 anomalies
node build/phase1Parity.mjs --smoke                          → 2/2 calls, K=20
```

24/24 单元全部：`sims === K`、逐条 digest 相同、`mathRandomDraws` 两臂均为 0。

### 5.5 Phase 2 驱动器 smoke（bundle + node）

```
node build/perfBudget100.mjs --smoke
baseline G2T6 planner=101.1ms search=100.2ms replay=2.4ms sims=19  plan=ok
prepared G2T6 planner=101.4ms search=100.2ms replay=0.1ms sims=33  plan=ok
baseline G1T1 planner=105.1ms search=100.7ms replay=0.3ms sims=13  plan=ok
prepared G1T1 planner=102.4ms search=100.5ms replay=0.1ms sims=14  plan=ok
→ PASS, 4/4 calls, 34 fields per record, math.random draws = 0
```

三种耗时被明确分离；`deadlineFired=true`、`budgetFired=false`；`replayOk=true`。**这是 smoke，不是性能证据。**

### 5.6 类型检查

`tsc --noEmit --strict` 覆盖 trace / uctBaseline / uctPrepared / arms / phase1 / phase1Parity / parityFixedSims / perfBudget100 / 两个测试文件：**0 error**。

---

## 6. 源文件与构建产物 SHA256

以 `SHA256SUMS.txt` 为权威（本轮结束时全量重算）。下表为本报告定稿时点：

| 文件 | 状态 | SHA256 |
|---|---|---|
| `PPC-MCTS-01/proto/uct.ts`（对照，未改） | frozen | `508a65bf53b63555bc4d3f8de7199b8607a8544572bb0e55850445cdffa2c53a` |
| `proto/trace.ts` | 新增 | `ad5538cbfe52b87bfbb10e77eec2b07a84ad311f6201c4c9c53b39af9bb5ec05` |
| `proto/uctBaseline.ts` | 新增 | `7df9d8d1bb42f984f5f866c8444b40f7133b1aa84d43f8229e5b731f38eff068` |
| `proto/uctPrepared.ts` | 修改 | `0e6f105088b8df98e3d4a3e45a2ac6ab55f4231c837bdb1f861e4f701c27e3b2` |
| `drivers/lib/arms.ts` | 修改 | `643879fcfe4d372de8371a2d2a25e98c7ed21e45ee828a56a934d8bcc92a870d` |
| `drivers/lib/phase1.ts` | 新增 | `ed25fce284ccca699fe13a811c7ca55e6d3c56f26857956944e416e9af5b12f4` |
| `drivers/parityFixedSims.ts` | 重写 | `e9bd57a68933646c09071313c019505bb4e454bc8f405defb33776326799f14c` |
| `drivers/perfBudget100.ts` | 重写 | `91c458079f048f2eee4447079f65846ccc6f4a7f0010118cb79dcff2f69094e5` |
| `drivers/phase1Parity.ts` | 新增 | `e713115f0ed22b43793deece0b5c138d0dbbb7f6adb9e360b899fb1985e7caa6` |
| `scripts/build-drivers.mjs` | 修改 | `fb036efa32a13079cb8ecf5ee2bac161423622c40bcf8e6d4345f6a769db55a2` |
| `scripts/runPhase2.mjs` | 新增 | `f60fc6a93fd73aa2759bf472ca569b22856238113f21638ac5cf6b44d8c7a65a` |
| `scripts/verify-baseline-fork.mjs` | 新增 | `a1df693553c78220a55e7d78dee39a48e042be0c38a203b2abca590419ac5138` |
| `scripts/gen-build-manifest.mjs` | 新增 | `37d17cc581b2290d93f65a73c5b9add51deba55132340bd841ac419b2e1ad7eb` |
| `probe/impl/rolloutReuseParity.test.ts` | 修改 | `5352a59c7e0bf0790b35e1eb908102a39304bbf078c8bde544463374f0aa1bf5` |
| `probe/impl/phase1Seam.test.ts` | 新增 | `9c572aea3dd2c9b6fa5898d1562bd976a227bc98b81189ed346d9080556aa238` |

**驱动器构建产物**（esbuild bundle + node，正式计时唯一入口）：

| bundle | 字节 | SHA256 |
|---|---|---|
| `build/parityFixedSims.mjs` | 2 850 570 | `1cef6942d1e1c9623ab9326ddf0070da3b8f44c1e5a5023c3327002ccddf6c75` |
| `build/perfBudget100.mjs` | 2 821 314 | `3e56c3791b317d7ac24e8d9e733ac6f5ed0ac4df26e37233307a61f0b348b72b` |
| `build/phase1Parity.mjs` | 2 830 536 | `26f4c66c24c5983818605f8428c756c017291694925d547dfd0d9dd10253b186` |

---

## 7. 偏差与未决项（必须复核）

### 7.1 我在过程中犯的一个错，已修复并登记

第一次跑 `--legacy-nodes=64` smoke 时，legacy 模式的**默认输出路径**指向了历史证据文件 `data/impl-parity-breadth.json`，把 96 单元的结果覆盖成 4 单元。

- 处置：立即把 legacy 默认输出改为 `data/impl-parity-breadth.legacy-rerun.json`；随后用完整 `--legacy-nodes=64,200 --modes=hybrid,random` 重建原文件。
- 重建结果：`96/96 PASS`，`ruleCalls 878 625 → 570 561`，与覆盖前一致。
- **不可恢复的部分**：原文件字节（`c37562d50d06e627aa97503f85241cf7a9ef27470b5cd24c75610fc4fd0d831c`）已被新文件字节取代，差异仅在 `generatedAt` / `wallMs` / `node` 等执行时字段。
- 请复核该项是否可接受；若需要「原字节」级别的不变性，只能重跑并使用固定时间戳写入。

### 7.2 150 ms 口径：任务要求与 Pilot 实现之间存在张力

任务 §4.2 要求「不得把离线回放耗时混入线上规划预算」，同时要求「150 ms 判断依据必须与原始 Pilot 的预算口径一致；如无法证明一致，先停止并报告」。

实测结论：**Pilot 的 150 ms 判定是 replay-inclusive**。
- `PPC-MCTS-01/proto/harness.ts:35` — `FULL_TURN_BUDGET_MS = 150`
- `PPC-MCTS-01/proto/harness.ts:204` — `withinFullTurnBudget: base.totalMs <= FULL_TURN_BUDGET_MS`
- `runUctCall`（290–310）— `t0` 在构造搜索器之前，`totalMs` 在 `replayPlanWithEngine(...)` **之后**才取

我的处理，不做口径替换：
- **字段分离**：`searchMs` / `plannerWallMs` / `replayMs` / `replayInclusiveTotalMs` / `planOverheadMs` 各自独立，回放耗时绝不混入 `plannerWallMs`；
- **主判定沿用 Pilot**：`withinFullTurnBudget = replayInclusiveTotalMs <= 150`；
- **并列参考**：`plannerWithinFullTurnBudget = plannerWallMs <= 150`，明确标注「不得替代主口径」。

如果复核认为主判定必须改为 planner-only（即与 Pilot 不一致），请明确指示——本轮**没有**自行更换。

### 7.3 Phase 2 两臂的实现不对称（对假设不利，故保留）

- baseline 臂用**原始** `PPC-MCTS-01/proto/uct.ts`（零插桩、零新增分支），保证性能基线就是生产路径；
- prepared 臂用 `proto/uctPrepared.ts`，它带有 Phase 1 的接缝与 trace 点，在本实验中 `trace` 为 undefined，代价是每个记录点一次 null 检查。

即 prepared 臂承担了额外的常数开销，方向对「prepared 更快」这一假设是保守的。若复核要求完全对称，可把 baseline 换成 `proto/uctBaseline.ts`（两臂同为惰性插桩），但这会使 baseline 偏离生产路径。

### 7.4 「baseline 与原始 uct.ts 对照」的证明形式

任务要求「证明除测试接缝与诊断 instrumentation 外没有其他变化」。

本轮**没有**采用「剥掉插桩后与原文逐字节相同」的文本证明，理由：这类证明不可靠也不可审计（一个删错括号的剥离器同样能得到空 diff）。

改用双证据：
1. **运行时全字段等价**（H1）：96 单元、11 101 条 simulation，接缝与 sink 都不启用时，fork 与原文在整树 fingerprint、plan、root 统计、全部可比 diagnostics 上完全相同；H4 进一步证明 sink 本身不扰动搜索。
2. **完整 diff + 逐行分类**（`BASELINE_FORK_PROVENANCE.json` + `DIFF_uct_to_uctBaseline.patch`）：`+195 / -39`，14 个已声明类别覆盖大部分行；**仍有 17 个未分类行模板**（多行 `this.tr(...)` 的参数续行、被拆分的 `if (t !== null) {` / `return {` / `if (keys.has(k))` 等结构行、`export { ROOT_TRANSITION }`）。这些模板已逐条列出，供人工核对——我没有把它们硬塞进某个类别来把计数压到 0。

### 7.5 覆盖范围的诚实边界

- Phase 1 目前只做了 **K=8 全 24 根** + **K=20 双根**；K=200 的完整一遍属于正式实验，未跑。
- CHANCE 在 K=8 时覆盖 10/24 根；采样数与 seed 绑定：`repetition=0`（H6 用的 seed）为 144 次，`repetition=1`（smoke 驱动默认 `--rep=1`）为 139 次。两者逐根向量都不同（`G5T1: 8 vs 6`、`G2T4: 24 vs 25`、`G1T5: 24 vs 20`），差异**全部来自 seed**，与运行环境无关（见 §7.6）。K=200 会更充分，但那属于正式实验。
- `MaxHandoffsReached` 在 smoke 中到 4（上限），`chanceSamples` 在部分根为 0，说明不同根的工作负载差异较大——正式实验按 24 根全量统计，不做挑选。

### 7.6 vitest 144 vs bundle 139：一次自洽性疑点的闭合

现象：H6（vitest）在 K=8 下报 `total chanceSamples=144`，而 `node build/phase1Parity.mjs --smoke --roots=all --sims=8` 报 `139`，两次运行都稳定。这类"同代码同参数不同数字"必须先排除环境差异（vitest 走 SSR transform，驱动器走 esbuild bundle），否则 trace 的确定性主张就站不住。

处置：在**仓库外**临时目录写探针（用后即删），把同一份 `runPhase1Arm` 代码 **esbuild 打包后用 plain node 跑**，一次跑两个 repetition：

| seed | cells with CHANCE | total chanceSamples | 逐根向量 |
|---|---|---|---|
| `uctSeed(root,'UCT-H',0)` | 10/24 | **144** | 与 vitest H6 逐根完全相同 |
| `uctSeed(root,'UCT-H',1)` | 10/24 | **139** | 与 bundle smoke 逐根完全相同 |

结论：**144 与 139 的差别 100% 来自 seed**，不是运行环境。H6 用 `repetition=0`；`phase1Parity --smoke` 未带 `--rep` 时默认 `rep=1`。同一环境下 rep0→144、rep1→139 与两个"表面上矛盾"的数字一一对应，且逐根向量双向吻合。`mathRandomDraws` 两侧恒为 0，impurity 也被排除。

因此：仓库内没有任何两处代码走了不同的随机流；报告的 144 / 139 分属两个不同 seed 的合法观测值，现已分别标注，不再混用。

---

## 8. 资源与实验安全

| 项 | 状态 |
|---|---|
| Phase 1 正式 960 次 | **未启动** |
| Phase 2 正式 960 次 | **未启动** |
| Self-play / Formal V2 1700 组 / Exhaustive oracle / 其他大规模 benchmark | **未启动** |
| 并发 | 全程单进程串行；`HEAVY_WORKER_CONCURRENCY=1`、`SERIAL_FRESH_REPETITIONS=TRUE` |
| V8 heap | 未扩大，未传任何 `--max-old-space-size` |
| 其他项目进程 | 未终止、未干扰 |
| 本轮重活 | 96 单元 legacy 重跑（2 m 47 s）、H1–H7（约 6 min）、若干 smoke（各 < 30 s） |

启动正式实验前的建议复核项：
1. `C:` pagefile 峰值已打满、可用物理内存 < 2 GB —— 20 个 fresh process 的串行序列建议在每个进程退出后检查一次可用内存；
2. `data/phase1/` 与 `data/phase2/` 目前不存在（正式实验才创建），启动前应确认没有被其他 Agent 占用；
3. Phase 2 每进程约 48 次调用 × 约 100–150 ms + 回放，单进程量级可控，但请以实测第一条 call 的 `plannerWallMs` 复核预算假设。

---

## 9. 交付物

| 文件 | 内容 |
|---|---|
| `HARNESS_REPAIR_REPORT.md` | 本文件 |
| `PHASE1_PREREGISTRATION.json` | Phase 1 常量、停止机制、比较轴、异常定义、失败处理 |
| `PHASE2_PREREGISTRATION.json` | Phase 2 常量、计时三分离、150 ms 口径证据链、串行 runner、字段清单 |
| `SIMULATION_TRACE_SCHEMA.md` | 事件模型、编码规则、内存模型、失败模式 |
| `BASELINE_FORK_PROVENANCE.json` | 双文件 sha256、diff 统计、逐类计数、未分类模板、运行时证据索引 |
| `HARNESS_CORRECTNESS_REPORT.md` | H1–H7 + A–F + 96/96 的完整证据表与复现命令 |
| `BUILD_MANIFEST.json` | 全目录文件清单（路径 / 分类 / 字节 / sha256）、构建产物、自指排除说明 |
| `SHA256SUMS.txt` | 全量摘要（排除自身，含 manifest） |
| `DIFF_uct_to_uctBaseline.patch` | 完整 unified diff（附加工件） |

---

## 10. 停止状态

harness 修正完成，**就此停止**。

- 正式 Phase 1 / Phase 2 均未启动；
- 未修改生产 AI（`src/game/ai/*`）、`GAMEPLAY.md`、`PPC-MCTS-01/`、`PPC-MCTS-01A/`；
- 未 commit、未 push、未 merge；
- 等 ChatGPT 复核与用户授权后，再按 `PHASE1_PREREGISTRATION.json` / `PHASE2_PREREGISTRATION.json` 执行。
