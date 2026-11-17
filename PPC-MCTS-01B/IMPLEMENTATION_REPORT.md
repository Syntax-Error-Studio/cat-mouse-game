# PPC-MCTS-01B-IMPLEMENTATION｜Rollout-only Prepared Reuse

**范围**：只实现 UCT-H **主 Rollout 路径**的 Prepared Transition 复用。全部代码位于 `PPC-MCTS-01B/`。
**未改**：`src/**`、`GAMEPLAY.md`、`PPC-MCTS-01/**`、`PPC-MCTS-01A/**`。无 commit / push / merge。
**未启动**：960 次 Phase 1、960 次 Phase 2、self-play、fresh-process 大跑。

证据分级（全文一致使用）：
`[源码]` 直接读源码确认 ｜ `[测试]` 本轮的自动化测试直接确认 ｜ `[统计]` 由实测数据计算 ｜ `[假设]` 尚未验证

---

## 1. 裁决

| 项目 | 裁决 | 依据 |
| --- | --- | --- |
| 实现是否只动 Rollout | **PASS** | 与原文件比 10 个 hunk，逐 hunk 已列（§3）；Tree Expansion / `applyEdge` / `extractPlan` / Hybrid 评价 / UCT-R 一行未改 `[源码]` |
| 语义是否不变（固定仿真数） | **PASS** | 96/96 单元全等，整树指纹 0 差异（§5）`[测试]` |
| 合法动作集合/顺序 | **PASS** | 5 643 状态逐状态比对 `[测试]` |
| transition / `stateKey` / `gameAffectingEqual` / 全序列化 | **PASS** | 18 920 条转移逐字段，0 差异 `[测试]` |
| guidanceValue（含 CHANCE 全 outcome + 原权重） | **PASS** | 18 920 次比较 **bit-exact**（`Object.is`）`[测试]` |
| RNG 消费顺序与次数 | **PASS** | 11 206 次选择，draw 次数与选择结果全等（含 593 次 hybrid 并列）`[测试]` |
| CHANCE 抽样结果 | **PASS** | 3 884 次同种子抽样，索引全等 `[测试]` |
| 规则调用减少 | **−35.06 %**（878 625 → 570 561）`[统计]` | 24 根 × 2 模式 × 2 固定预算 |
| 100 ms 墙钟收益 | **未测，不构成证据** | 仅 16 次驱动的功能性 smoke（§7） |
| 是否可进入 Phase 1 / Phase 2 | **可以，但必须先按 §9 的两条前置修正 harness** | — |

**一句话**：复用本身在固定工作量下被证明"化学反应不变"，只把第三次模拟的钱省掉；但在 vite-node 里跑会让叶评价慢 7 倍，因此两阶段实验必须像 Pilot 一样走 **esbuild bundle**。

---

## 2. 交付物与文件级变更

### 2.1 新增（全部在 `PPC-MCTS-01B/` 内）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `proto/uctPrepared.ts` | 783 | **完整隔离原型**：`uct.ts` 的逐行 fork，仅 rollout 区改动 |
| `probe/impl/rolloutReuseParity.test.ts` | 513 | 正确性测试（A–F 六组，12 场景覆盖门槛） |
| `probe/impl/vitest.config.mts` | 20 | 单文件、单 fork、串行（`fileParallelism:false`, `maxWorkers:1`） |
| `drivers/lib/arms.ts` | 266 | 两臂并列加载、规则调用计数、整树指纹、逐字段 diff |
| `drivers/parityFixedSims.ts` | 148 | **固定 simulation parity 驱动器** |
| `drivers/perfBudget100.ts` | 189 | **100 ms 性能实验驱动器**（支持 `--rep` 单次进程） |
| `drivers/lib/calibrate.ts` | 35 | harness 校准（vite-node vs bundle），§7 的数据来源 |
| `scripts/build-drivers.mjs` | 31 | esbuild 打包两个驱动器到 `build/` |
| `build/parityFixedSims.mjs`、`build/perfBudget100.mjs` | — | 打包产物（**派生**，每个约 2.8 MB，由 `scripts/build-drivers.mjs` 重建；重建后 sha256 会变） |
| `DIFF_uct_to_uctPrepared.patch` | 272 | **实现前后代码差异**（`diff -u`） |
| `data/impl-parity-smoke.json` | — | 4 单元驱动自检 |
| `data/impl-parity-breadth.json` | — | 96 单元固定仿真 parity 结果 |
| `data/perf-smoke.json` | — | 16 次调用的性能驱动 smoke |
| `logs/impl-test-run.log` | — | 最终测试运行日志 |

`PPC-MCTS-01B/` 下 Phase 0 的六份交付物**未被覆盖或修改**（`SHA256SUMS.txt` 重新生成，内容只增）。

### 2.2 未改（逐项核验）

Phase 0 的 `SOURCE_PROVENANCE.json` 记录了 20 个源文件 + 全部工件的 sha256；本轮结束时**逐个重算，20/20 未变**，工件亦未变 `[统计]`。关键锚点：

| 文件 | sha256 |
| --- | --- |
| `PPC-MCTS-01/proto/uct.ts`（基线臂） | `508a65bf…f2c53a` |
| `src/game/ai/preparedActions.ts`（共享、untracked） | `67b76ad3…11ad764` |
| `GAMEPLAY.md` | `e000778b…2afd34` |

`git status --porcelain` 仍为 **69** 行，与 Phase 0 结束时一致（本轮新增文件全在已存在的未跟踪目录 `PPC-MCTS-01B/` 内）。

---

## 3. 实现：改了哪 6 处，为什么只改这 6 处

`diff -u PPC-MCTS-01/proto/uct.ts PPC-MCTS-01B/proto/uctPrepared.ts` = **10 hunk / 272 行**。逐 hunk：

| # | 位置 | 内容 | 性质 |
| --- | --- | --- | --- |
| 1 | 文件头 + import | 说明文档重写；新增 `generatePreparedSearchActions` / `PreparedSearchAction`；`chance/seededRng/value` 改为从 `PPC-MCTS-01/proto` 直接引用（**同一模块实例**，保证算术完全相同） | 注释/依赖 |
| 2 | `UctDiagnostics` | 新增 3 个仅供 prepared 臂的计数器 | 诊断 |
| 3 | 类字段 | `rolloutPreparedSteps` / `rolloutLegacySteps` / `rolloutImpureFallbacks` | 诊断 |
| 4 | `run()` 返回值 | 输出上述 3 个计数器 | 诊断 |
| 5 | `rollout()` 步体 | **唯一的行为改动**（见下） | **实现** |
| 6 | `extractPlan()` 注释 | 缩短为"本轮未改，仍走 legacy 两步" | 注释 |
| 7 | 类名 | `UctSearch` → `UctSearchPrepared` | 隔离 |
| 8 | 新增 3 个自由函数 | `guidanceValueFromTransition` / `selectPreparedRolloutIndex` / `hitsNonPureItemOverlap` | **实现** |
| 9 | 文件尾 `__internals` | 供驱动器/测试读取三个纯函数 | 测试接缝 |

### 3.1 新的 rollout 步体（原文第 5 hunk）

```ts
let res: SearchTransitionResult;
if (hitsNonPureItemOverlap(state)) {          // §三.4 fail-closed
  const actions = generateLegalSearchActions(state, this.opts.rules);
  if (actions.length === 0) break;
  const action = selectRolloutAction(state, actions, this.opts.rollout, this.opts.rules, this.policyRng);
  res = simulateSearchAction(state, action, this.opts.rules);   // 与基线逐字相同
  this.rolloutImpureFallbacks++; this.rolloutLegacySteps++;
} else {
  const batch = generatePreparedSearchActions(state, this.opts.rules);  // 一次生成，转移一并带回
  if (batch.length === 0) break;
  if (batch.length === 1) {
    res = batch[0].transition;                 // 单合法动作：直接执行，不评价、不掷骰
  } else {
    const idx = selectPreparedRolloutIndex(state, batch, this.opts.rollout, this.policyRng);
    res = batch[idx].transition;               // 选定动作直接消费自己的转移
  }
  this.rolloutPreparedSteps++;
}
```

对应任务书 §一 的 6 条：①一次生成 ✅ ②guidance 读对应转移 ✅ ③多候选全部评价（`selectPreparedRolloutIndex` 遍历 `0..L-1`，无 top-k、无抽样、无权重改动）✅ ④单合法动作保持直接执行 ✅ ⑤选定动作消费转移 ✅ ⑥`batch` 是 while 迭代内的 `const`，步末即释放，不挂节点、不跨 simulation、不跨 worker ✅

### 3.2 为什么 Tree Expansion 一行都不能动

基线在树展开处对每个动作模拟 **两次**（`generateLegalSearchActions` 判合法 + `applyEdge` 拿后继）。`applyEdge` 里那句

```ts
if (gameAffectingEqual(parent.state, res.state)) throw new Error(`illegal no-op edge reached the tree: …`);
```

本质是**用第二次模拟交叉验证第一次**。只要展开处仍自己模拟，这条断言就**依然可达**，安全性网没被拆掉 `[源码]`。所以本轮刻意只动 rollout：收益小一些，但 R4 要求的"安全性净损失"没有发生。

---

## 4. 强制保持的语义——逐条对应

| 任务书要求 | 实现方式 | 证据 |
| --- | --- | --- |
| 合法动作集合与顺序 | 复用 `generatePreparedSearchActions`，其枚举与 `generateLegalSearchActions` 同源（Phase 0 已证） | 5 643 状态逐状态 `[测试]` |
| UCB1 / 猫 MAX / 鼠 MIN | `selectEdge` 未改；`selectPreparedRolloutIndex` 的 `maximize` 分支与基线逐字相同 | `[源码]` + 整树指纹 `[测试]` |
| Hybrid 评价数值逐项一致 | 只把 `simulate → evaluateLeaf` 换成 `transition → evaluateLeaf`，算术表达式一字不差 | 18 920 次 `Object.is` 全等 `[测试]` |
| CHANCE 全部正概率 outcome 参与 | `for (i=0; i<v.outcomes.length; i++) acc += v.weights[i]*evaluateLeaf(...)` 未改 | 971 条 CHANCE 转移、13 390 outcome `[测试]` |
| CHANCE 权重和顺序不变 | 直接复用同一个 `outcomes` 数组，不重排、不归一化 | 权重 `Object.is` 全等 `[测试]` |
| `policyRng` / `chanceRng` 消费顺序 | 单动作 0 次；random 1 次 `int(L)`；hybrid 1 次 `int(|best|)`（全非有限时 1 次 `int(L)`） | 11 206 次 draw 计数全等 `[测试]` |
| 终局与重复状态 | `terminalReward` 提前返回、`keys` 环检测均未改 | 39 个终局态 + 1 122 个多路径可达态 `[测试]` |
| `maxHandoffs=4` / `maxNodes=500000` / 100 ms / 150 ms | 不在此文件内，由调用方传；驱动器按原值传 | `[源码]` |

### 4.1 RNG 消费的等价性论证（关键）

基线 `selectRolloutAction` 的掷骰结构是：

- `actions.length === 1` → 返回 `actions[0]`，**零掷骰**；
- `random` → 恰好 1 次 `int(L)`；
- `hybrid` → 恰好 1 次 `int(|best|)`；若所有候选值非有限，则 1 次 `int(L)`。

`selectPreparedRolloutIndex` 把"单动作"提到调用方（同样零掷骰），其余三分支的表达式逐字保留。所以**不只是"抽到同一个"，而是"抽取次数、抽取时机、抽取参数都一样"**——这才是搜索路径不漂移的充分条件 `[源码]`+`[测试]`。

---

## 5. 正确性证据

### 5.1 语料

24 个冻结根（fixture sha256 `1a59787a…db09`）× 有界 BFS（深 6、每根 250 状态、全部 CHANCE outcome 展开不抽样）+ 5 个手构状态 = **5 643 状态**。

| 场景（任务书 §四） | 命中状态数 |
| --- | --- |
| 普通猫移动 | 991 |
| 多候选猫行动（≥4） | 570 |
| 鼠行动 | 4 349 |
| 单合法动作短路 | 8 |
| 隧道出口 | 89 |
| 吃黄油 CHANCE | 346 |
| CAT→MOUSE CHANCE | 177 |
| placement debt | 1（手构：`pendingButterPlacementDebt=2`） |
| 陷阱 | 5 140 |
| 终局 | 39 |
| 循环/重复状态 | 1 122 |
| 特殊非纯函数路径（陷阱压黄油） | 1（手构） |

覆盖门槛写进测试：任一桶为 0 即 FAIL，防止"静默空桶"。

### 5.2 六组断言

| 组 | 内容 | 规模 | 结果 |
| --- | --- | --- | --- |
| A | 动作集合 / 顺序 / `originalIndex` | 5 643 状态 | 0 差异 |
| B | 复用转移 vs 现算转移：kind、`stateKey`、`gameAffectingEqual`、逐 outcome 状态、**全序列化（含日志）**、CHANCE 基数/顺序/权重、`|Σw−1|≤1e-9` | 17 949 确定性 + 971 CHANCE（13 390 outcome） | 0 差异；整段扫描期 `Math.random` 调用 **0 次** |
| C | `guidanceValueFromTransition` vs `guidanceValue` | 18 920 次 | `Object.is` **全等** |
| D | `selectPreparedRolloutIndex` vs 基线选择规则（逐字副本）＋ draw 计数 | 11 206 次（593 次 hybrid 并列） | 选择与 draw 次数全等 |
| E | 整树指纹：节点 kind/交接深度/`stateKey`/访问数/total+mean reward/边 key+kind/CHANCE 权重+outcome 抽样计数 | 4 根 × 2 模式 × K∈{4,16,64} = 24 单元 | 0 差异；`rolloutPreparedSteps>0`、`impureFallbacks=0` |
| F | 陷阱压黄油：`Math.random` 换成确定性 LCG，两臂必须消耗**同样次数**的抽样 | 1 手构鼠回合根 | draw 次数相等、整树指纹相等、`fallbacks>0`、`legacySteps==fallbacks` |

> B 组对"陷阱压黄油"状态**排除**：基线在那里本身就不是纯函数（`catMove` 会随机重放黄油），"复用==重算"不是基线的性质。它们由 F 组按 fail-closed 语义覆盖。

### 5.3 固定仿真 parity 驱动器（96 单元）

| 维度 | 值 |
| --- | --- |
| 单元数 | 24 根 × 2 模式 × K∈{64,200} = **96** |
| 通过 | **96/96** |
| 仿真总数 | 11 101 |
| 整树指纹唯一数 | 96（每单元一棵不同的树） |
| `impureFallbacks` | 0 |
| 两次独立运行 | JSON 逐字节相同（忽略 `generatedAt`/`wallMs`） |

判据是**整树指纹相等**：任一 rollout 决策不同 → 至少一个 reward 不同 → 至少一个 `totalReward` 不同 → 摘要不同。加上 `meanReward` 的浮点精确串比较，这比"根动作一致"强得多。

---

## 6. 收益（只计规则调用，不计墙钟）

| 分组 | 基线 | 复用后 | 减少 |
| --- | ---: | ---: | ---: |
| 全部（96 单元） | 878 625 | 570 561 | **−35.06 %** |
| hybrid（48 单元） | 509 200 | 264 765 | **−48.00 %** |
| random（48 单元） | 369 425 | 305 796 | **−17.22 %** |
| K=64（48 单元） | 243 521 | 157 622 | −35.27 % |
| K=200（48 单元） | 635 104 | 412 939 | −34.98 % |

**这三条不能从这里读出来**：

1. **不能读成"快 35 %"**。被删掉的是转移重算，叶评价一次没少；Phase 0 与 01A 都已写明墙钟不可外推。
2. **不能与 Phase 0 的 −38.77 % / −53.91 % 直接相减**。Phase 0 计的是"三个调用点全复用"，且工作负载（300 节点 × 8 次运行）与本轮（64/200 节点 × 96 单元）不同。本轮只拿下 rollout，少的那部分正是刻意没动的 Tree Expansion。
3. **random 臂的隧道态是净亏**：`ChoosingTunnelExit` 下基线生成器 0 次模拟、guidance 才补 L 次；prepared 在生成阶段就 L 次。所以 random 臂在隧道态会多付 `L−1` 次。整体仍是 −17.22 %，但这是"平均"，不是"每步都省"。

---

## 7. 性能：为什么本轮**不**给结论，以及一个必须写进下一轮的前置条件

### 7.1 smoke（不构成证据）

`build/perfBudget100.mjs --roots=G1T1,G2T6,G5T4,G6T1 --reps=1,2`：**16 次调用**，8 次/臂。

| 臂 | sims 中位 | searchMs P50 | searchMs P95 | 回放成功 | Math.random |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 28.5 | 100.2 ms | 100.5 ms | 8/8 | 0 |
| prepared | 30.5 | 100.2 ms | 100.4 ms | 8/8 | 0 |

**这不是 Phase 2。** 没有 20 次重复、没有 20 个 fresh process、样本量 16，且出现过 G5T4 一次 170 sims 的离群（该根 rollout 短、单 sim 便宜）。**不得据此说"快多少"或"多搜多少"**。

### 7.2 一个必须修正的 harness 事实：vite-node 让叶评价慢 7 倍

| 度量 | `vite-node`（TS 直跑） | esbuild bundle + node |
| --- | ---: | ---: |
| `hybridEvaluateForCat` | **690.9 µs/次** | **96.8 µs/次** |
| K=32 固定工作量 | 16.9 ms/sim | **3.1 ms/sim** |

bundle 后的 `3.1 ms/sim` 与 PPC-MCTS-01A 的 `3.161 ms/sim` 吻合；`vite-node` 下同一 workload 只有 ~2 sims/100 ms，会把固定预算实验压成噪声。

**结论**：两阶段实验必须 `node build/*.mjs`（与 Pilot 的 `bench.mjs` 同构），**不得**用 `vite-node`/`vitest` 计时。本轮的 `scripts/build-drivers.mjs` 就是为此存在 `[统计]`。

---

## 8. 三个必须带走的发现

### 8.1 fail-closed 守卫在"猫回合根"上结构不可达，在"鼠回合根"上可达

- 唯一不纯路径：`catMove` 首行 `sanitizeItemOverlaps`（`engine.ts:909`）→ 仅当 `trapPosition` 与某黄油重合 → `generateSingleButterPosition` → `Math.random`。
- 因此**任何 catStep 的后继都已净化**，猫回合根的 rollout 起点永远不重叠 → 守卫不触发。
- 但 `mouseStep` 走 `mouseStepDeterministic`，**不净化**，重叠会带进鼠方后继 → 守卫在鼠回合根上真实触发（F 组实测 `fallbacks>0` 且 `legacySteps==fallbacks`）。

这条对下一轮的意义：**守卫是防御性的，不是热路径**；它的成本是每步一次 `O(butterPositions)` 的坐标比较（≤2 项），可忽略。

### 8.2 单合法动作的"省"是 1 次转移，不是 1 次决策

基线在单动作态：`generateLegalSearchActions` 1 次 + 执行 `simulateSearchAction` 1 次 = 2 次。prepared：1 次。**动作、顺序、RNG（0 次）完全不变**，少的只是第二次模拟。语料中 8 个状态命中，另有 89 个隧道态（1 个出口时）。

### 8.3 `applyEdge` 的 no-op 断言仍然活着

因为 Tree Expansion 未被优化，`applyEdge` 仍自己模拟，`illegal no-op edge reached the tree` 仍可能被真实触发。**R4 要求的"交叉验证降级为测试期 gate"在本轮不需要执行**——这条网没被拆。若下一轮要顺手优化 Tree Expansion，则必须先按 R4 补 parity gate，并明确写出"交叉验证从运行时降级为测试期"。

---

## 9. 进入两阶段实验前必须做的事（**不做就不许启动**）

| # | 事项 | 理由 |
| --- | --- | --- |
| P-1 | 用 `build/*.mjs`（esbuild bundle）跑，禁用 `vite-node`/`vitest` 计时 | §7.2：否则 100 ms 只剩 ~2 sims，噪声吞掉一切 |
| P-2 | 每个 repetition 一个 fresh process（`--rep=k --out=rep-k.json`），进程退出后再起下一个 | 预注册 `FRESH_NODE_PROCESSES=40`、`HEAVY_WORKER_CONCURRENCY=1` |
| P-3 | 启动前查进程表 + 查 `data/` 是否已有部分结果 | `DUPLICATE_BENCHMARK_CHECK=REQUIRED` |
| P-4 | 记录启动前可用内存/已提交/pagefile | `RESOURCE_SAFETY=REQUIRED` |
| P-5 | 两臂同根同种子：`uctSeed(rootId,'UCT-H',rep)`，臂序按 rep 奇偶交替（驱动器已实现并记录 `order`） | 消除冷启动偏置 |

阶段 1（固定仿真 parity）**已经用 96 单元跑过**，但按预注册它仍需在 960 次规模上重跑一遍；本轮的 96 单元只能证明"实现是对的"，不能替代预注册证据。

---

## 10. 终止状态

| 项 | 状态 |
| --- | --- |
| 实现（隔离原型 + 差异 + 测试 + 两个驱动器 + manifest + 本报告） | **完成** |
| `src/` / `GAMEPLAY.md` / `PPC-MCTS-01` / `PPC-MCTS-01A` | **0 改动**（20/20 sha256 未变） |
| commit / push / merge | **未执行** |
| Phase 1（960 次）/ Phase 2（960 次） | **未启动** |
| 其他 benchmark 并发 | 预检时刻无；本轮驱动器全部 `maxWorkers=1`、串行、单进程 |

**等 ChatGPT 复核。复核前不开始任何两阶段实验。**

---

## 11. 附：如何复现

```bash
# 类型检查（0 错误）
npx tsc --ignoreConfig --noEmit --strict --target ES2022 --module ESNext \
  --moduleResolution bundler --skipLibCheck --types node --lib ES2022,DOM \
  PPC-MCTS-01B/proto/uctPrepared.ts PPC-MCTS-01B/drivers/lib/arms.ts \
  PPC-MCTS-01B/drivers/parityFixedSims.ts PPC-MCTS-01B/drivers/perfBudget100.ts \
  PPC-MCTS-01B/probe/impl/rolloutReuseParity.test.ts

# 正确性测试（7 passed / 59 s）
npx vitest run --config PPC-MCTS-01B/probe/impl/vitest.config.mts

# 打包（与 Pilot 同构）
node PPC-MCTS-01B/scripts/build-drivers.mjs

# 固定仿真 parity（96 单元 / 2 m 42 s）
node PPC-MCTS-01B/build/parityFixedSims.mjs --roots=all --budgets=64,200 \
  --out=PPC-MCTS-01B/data/impl-parity-breadth.json

# 100 ms 驱动（smoke；正式实验按 §9 拆 20 个 fresh process）
node PPC-MCTS-01B/build/perfBudget100.mjs --smoke
```

`SHA256SUMS.txt` 覆盖本目录全部文件（不含自身），`sha256sum -c SHA256SUMS.txt` 全绿。
