# PPC-MCTS-01A — EVALUATION_COST_AUDIT

**问题**：UCT-H 每次 simulation 评价多少次？评价多贵？重复评价在哪里？为什么 100ms 内只能跑约 25 次 simulation？

证据标签：**[源码]** / **[日志]** / **[统计]** / **[假设]**。

---

## 1. 评价单位

一次 `evaluateLeaf` 不一定等于一次 Hybrid 调用：

- **[源码]** 终局：`terminalReward` 直接返回 ±1，不调用 Hybrid。
- **[源码]** 非终局：调用一次 `hybridEvaluateForCat`。
- **[源码]** Hybrid eligible：内部 `evaluateForCat` 一次 + `productionValueNet` 一次。
- **[源码]** Hybrid ineligible：只调用 `evaluateForCat` 一次（fallback）。
- **[源码]** `evaluateForCat` 一次 = 3 张 BFS（mouse / cat / carrying-hole）+ 10×10 Voronoi 扫描 + 特征/贡献计算；不是每个特征重复 BFS。
- **[源码]** `productionValueNet` = 808 维特征构建 + 稀疏第一层 128 + 第二层 64 + 输出 64。

因此本审计把“评价”分成三层：`hybrid calls`、`baseline evaluateForCat calls`、`BFS maps`。一次 Hybrid 通常对应 **3 张 BFS**，ineligible 时仍是 3 张 BFS（只是没有 ValueNet）。

---

## 2. 函数级精确计数（V8 precise coverage）

方法：`Profiler.startPreciseCoverage({ callCount: true })` 包住**未修改**的 `UctSearch.run()`；每根每臂单独采集。coverage 会拖慢执行，因此这里的 simulation 数小于 smoke；调用次数/比率才是本表重点。

| 计数 | UCT-R | UCT-H | 说明 |
| --- | ---: | ---: | --- |
| 完成的 simulations | 1,888 | 103 | coverage 下 |
| `selectRolloutAction`（rollout + extension 步数） | 24,723 | 1,161 | 每步一次 |
| `guidanceValue`（候选动作评价次数） | **0** | **4,019** | UCT-H 每步遍历全部合法动作 |
| `evaluateLeaf` | 1,796 | 4,595 | 含终局判断 |
| `hybridEvaluateForCat` | 1,796 | 4,552 | `evaluateLeaf - 终局` |
| `evaluateForCatDetailed`（baseline） | 1,796 | 4,552 | 每次 Hybrid 恰好一次 baseline |
| `productionValueNet` | 1,711 | 3,471 | UCT-H 中 76.2% Hybrid 调用实际进入 ValueNet |
| `simulateSearchAction` | 131,668 | 10,151 | 含合法动作有效性验证 |
| `buildContext` | 1,796 | 4,552 | 每次 baseline 一次 |
| `extractPlan` | 24 | 24 | 每根一次 |

### 2.1 精确分解（UCT-H coverage 总量）

```text
guidanceValue 候选动作数                  = 4,019
由候选机会结果额外产生的 evaluateLeaf     =   473
最终 simulation 叶检查                    =   103
evaluateLeaf 总数 4,019 + 473 + 103       = 4,595
其中终局叶（不调用 Hybrid）               =    43
hybridEvaluateForCat = 4,595 - 43         = 4,552
```

**[统计]** 这说明：

- 每个 UCT-H simulation 平均有 `4,019 / 103 = 39.0` 次候选动作评价；
- 每个候选动作平均触发的 leaf 评价还被 CHANCE outcome 放大：`(4,019 + 473) / 4,019 = 1.118`；
- 树内最终叶仅 `103` 次，约占总 `evaluateLeaf` 的 `2.2%`；
- 其余约 `97.8%` 的评价发生在 rollout（含少量计划补全）的候选评价中。

### 2.2 UCT-R 的对照

- **[源码]** UCT-R rollout 不调用 `guidanceValue`。
- **[统计]** coverage 中 `evaluateLeaf = 1,796`，`hybrid = 1,796`，每 simulation 约 `0.951` 次叶评价（少数 simulation 以终局结束）。
- **[统计]** UCT-H / UCT-R 的每 simulation Hybrid 调用比约为 `4,552/103 : 1,796/1,888` = `44.2 : 0.95`，约 **46×**（coverage 口径）。
- **[统计]** 未插桩诊断（100ms 实际运行）中，UCT-H 为 `28,033 / 830 = 33.8` 次评价/simulation，UCT-R 为 `7,880 / 8,428 = 0.935`，约 **36×**。两者数量级一致，差异来自 chance/终局组合与负载。

---

## 3. 单次评价耗时（微基准）

方法：从 24 根局面出发，用共享 simulator 随机走 6 个不同后继，共 143 个状态（117 个 eligible，81.8%）；每个函数调用 3 轮，共 429 次。外部 heavy 负载仍在运行，绝对墙钟只作近似。

| 函数 | 调用 | 墙钟均值 | P50 | P95 | P99 | 最大 | BFS/调用 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `hybridEvaluateForCat` | 429 | 92.0µs | 85.8µs | 131.1µs | 193.2µs | 1023.7µs | 3.000 |
| `evaluateForCat` (baseline) | 429 | 64.6µs | 60.3µs | 73.0µs | 145.5µs | 769.8µs | 3.000 |
| `productionValueNet` | 429 | 20.8µs | 19.7µs | 23.6µs | 35.3µs | 59.4µs | 0 |

**[统计]**

- `baseline + ValueNet ≈ 85.4µs`，与 `hybrid ≈ 92.0µs` 同量级；说明 Hybrid 的主要成本仍是 3 张 BFS 的 baseline 部分，ValueNet 约占 20–25%。
- BFS 计数精确为每评价 3 张；`carryRouteBfs` / `catPushBfs` 为 0（Gate Race 专用路径未使用）。
- 平均值受外部负载与 GC 影响；P50/P95 更适合看常态。不要把绝对微秒数当作正式性能基准。

### 3.1 为什么 3 张 BFS 很贵

- **[源码]** `buildDistanceMap` 使用 `Map<string, number>` 与字符串 cell key；10×10 棋盘每张 BFS 都做一次全可达区域遍历和字符串哈希。
- **[源码]** Voronoi 扫描 10×10 全部战略格；每个格做两次 Map 查询。
- **[源码]** ValueNet 每调用一次要清空 808 维 Float32 数组、扫描 808 维、做 128 宽稀疏第一层、64×128 第二层、64 输出。
- **[统计]** 这些常数叠加后，单次 Hybrid 约 90µs；一个 UCT-H simulation 需要 30–45 次，单 simulation 成本约 3ms。

---

## 4. 每 simulation 成本与 100ms 预算

### 4.1 未插桩诊断（deadline-bound）

| 指标 | UCT-R | UCT-H | 比值 |
| --- | ---: | ---: | ---: |
| 平均 simulations / 根 | 351.2 | 34.6 | 10.16× |
| 平均 CPU ms / simulation | 0.345 | 3.161 | **9.16×** |
| 平均评价 / 根 | 328.3 | 1,168.0 | 3.56× |
| 平均评价 / simulation | 0.935 | 33.8 | 36.1× |
| 平均 rollout steps / 根 | 4,092.7 | 294.8 | 13.9× |
| 平均节点数 / 根 | 408.7 | 37.9 | 10.8× |

### 4.2 原始 72 条 smoke（正式冻结的 24 根分布）

| 指标 | UCT-R | UCT-H |
| --- | ---: | ---: |
| simulations 均值 | 233.6 | 25.0 |
| simulations 中位数 | 130 | 12 |
| simulations P25 / P75 | 113 / 325 | 7 / 26.25 |
| 树计划长度均值 | 4.08 | 2.50 |
| 搜索时间 P50 | 100.03ms | 100.30ms |

**[日志]** 两者都在 100ms 预算内结束；UTC-H 的 simulation 数少约 `9.34×`，与诊断的 CPU 成本比 `9.16×` 一致。**[统计]** 这不是“搜索循环写得慢”，而是每次 simulation 内做了约 34–45 次 Hybrid 评价，且每次评价约 3 张 BFS。

---

## 5. 重复评价与可复用性

### 5.1 已确认的重复结构

- **[源码]** UCT 没有按 `stateKey` 缓存 `hybridEvaluateForCat` / `evaluateForCat` / BFS / ValueNet。
- **[源码]** 同一状态可以在不同 simulation 的 rollout 中再次出现；每个 simulation 的 `keys` 只防止单条路径内循环，不跨 simulation 去重。
- **[源码]** `generateLegalSearchActions` 每次调用都重新枚举候选并对其做 `isEffective` 模拟；树展开、每步 rollout、每步计划补全都会调用，且没有按状态缓存。
- **[源码]** `guidanceValue` 对选定动作先模拟一次，选定后 `rollout`/extension 又模拟一次；候选模拟结果没有被复用。
- **[源码]** 计划补全使用同一 rollout 策略，可能对已经评价过的树内状态再次评价。

### 5.2 可复用但当前未复用的东西

| 可复用对象 | 当前状态 | 说明 |
| --- | --- | --- |
| 单状态 Hybrid 值 | 无缓存 | `stateKey` 已存在，但 UCT 不把它用于叶值 memo |
| `evaluateForCat` 的 3 张 BFS / Voronoi | 每次重建 | `evaluateForCatDetailed` 支持 `prebuiltCtx`，Hybrid 入口没有跨调用复用 |
| 合法动作列表 + 有效性验证 | 每次重建 | `generateLegalSearchActions` 没有 memo |
| 候选动作的 transition | 评价后丢弃 | 选定动作再次模拟 |
| CHANCE outcome 叶子值 | 每个候选重新评价 | 同一 chance 层在后续 simulation 中可能重复展开 |

**[源码]** 当前工作树已经存在 `generatePreparedSearchActions`：它把合法验证时算出的 transition 一并返回，调用方可以直接复用、不必再次模拟。但 `uct.ts` 仍调用旧的 `generateLegalSearchActions`（`uct.ts:410`, `540`, `631`），因此这项“合法验证 + transition”复用**没有进入 UCT 原型**；rollout 仍然对选定动作重复模拟。

**[假设]** 由于树节点数只有 37.9/根，而评价数 1,168/根，绝大多数评价发生在未入树的 rollout 状态；相同 rollout 状态跨 simulation 重复的概率不低，但没有逐状态计数，不能给出精确重复率。任何缓存都必须保持语义（尤其 CHANCE 与状态完整键），本轮未实现。

---

## 6. 四类成本的边界

| 阶段 | 评价调用 | 证据 |
| --- | --- | --- |
| 树内选择/展开 | **0**；UCB、`simulateSearchAction`、CHANCE 构造不做 Hybrid 评价 | [源码] `uct.ts:499-516`, `uct.ts:380-480` |
| 树内终叶 | 每个完整 simulation 最多 1 次 `evaluateLeaf`；终局不调用 Hybrid | [源码] + [统计] coverage `evaluateLeaf 4,595` vs `sims 103` |
| Rollout | 主导成本：`guidanceValue` 4,019 次候选评价，展开为约 4,492 次 leaf 评价 | [统计] coverage 精确分解 |
| 计划补全 | 诊断为 27 个 extension steps、99 次评价；均值 0.384ms/根 | [统计] `diagnostics.json` |
| 最终计划提取 | 主路径遍历 + 根动作统计；不调用 Hybrid | [源码] `uct.ts:598-647` |
| 真实引擎回放 | **0** 次评价；均值约 0.097ms/根 | [统计] `diagnostics.json` |

> smoke 的 `planMs` 是 `totalMs - searchMs`，包含构造函数、计划提取、rootActionStats 与真实回放，**不是纯评价时间**；本轮用诊断把 extension 与 replay 分开测量。

---

## 7. 回答重点问题

1. **UCT-H 每次 simulation 评价多少次？**
   - **[统计]** 约 34–45 次 Hybrid 评价/simulation（未插桩 33.8，coverage 44.2）；UCT-R 约 0.93–0.95 次。
2. **平均耗时及分布？**
   - **[统计]** Hybrid ≈ 92µs（P50 85.8，P95 131.1，P99 193.2）；单 simulation 约 3.16ms CPU。
3. **是否存在相同状态重复评价？**
   - **[源码]** 没有任何跨 simulation 缓存，结构上允许且很可能发生；**[假设]** 精确重复率未计数。
4. **是否存在可复用结果？**
   - **[源码]** 有：`stateKey`、`prebuiltCtx`、合法动作列表、候选 transition、chance 叶子值；当前都未在 UCT 内复用。
5. **Hybrid 是否包含多次 BFS？**
   - **[源码]** 每次 baseline 恰好 3 张 BFS；单次调用内部不重复，但每次评价都重新构建。
6. **UCT-R 与 UCT-H 单次 simulation 成本差异？**
   - **[统计]** 约 9.2× CPU；smoke 中 simulation 数约 9.3× 差距；核心原因是 UCT-H 每步评价全部候选动作及全部 chance outcome。
