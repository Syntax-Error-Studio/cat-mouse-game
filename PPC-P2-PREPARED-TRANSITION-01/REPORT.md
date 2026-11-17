# PPC-P2-PREPARED-TRANSITION-01 — 搜索后继状态复用

日期：2026-11-14 ｜ 分支：`ppc/p1-id-state-identity-fix` ｜ HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`（未变）

---

## 一、人话总结（500 字以内）

**1. 到底减少了哪一类重复计算？**  
搜索每展开一个节点，先把每个候选动作模拟一遍判断合不合法，合法动作留下来；然后为每个留下来的动作**再模拟一遍**，只为拿到递归时要用的后继状态。根节点更糟：为了判断"有没有合法动作"，整份候选被模拟了三遍。本轮让合法性判定时算出的那次转移**直接被搜索复用**，一个候选动作每个节点只模拟一次。24 个冻结真人根实测：真实引擎转移调用 13 960 → 7 511（−46.2%），根节点每个合法动作的模拟次数 3 → 1。

**2. 游戏规则和 AI 数学有没有变化？**  
没有。规则、`evaluateForCat`/H1 权重、mate 传播、Alpha-Beta、TT 准入、`stateKey`、计划上界、100ms/150ms 常量、Sidecar、Guard、鼠 AI 全部未改。24 根固定 D1 结果与冻结基线**逐字段零差异**（含 value/mate/plan/ttSize 与全部 diagnostics 计数器）。

**3. 快了多少？有统计证据吗？**  
有。20 次 fresh A/B（每臂独立 Node 进程，严格串行）：B/A 几何均值 **0.9150**，95% CI **[0.9027, 0.9274]**，即固定工作量下**快 8.50%**，置信上界 0.927 ≤ 预注册的 0.98 门槛 → `STRONG_SPEEDUP_EVIDENCE`。24/24 根都不慢，最慢的一根仍有 0.990。A/A 校准 CI [0.988, 1.003]，噪声远小于效应。

**4. 100ms 下是否真的搜得更多？**  
是，但**只有“节点更多”这一项是稳的**。同一协议重复 5 次：候选每一轮都比基线搜到更多节点（总量比 1.081–1.170，逐根中位比 1.136–1.216），中位回合墙钟仍 151.0ms（未变）。而“完成计划的回合 22→23”“回退 2→1”“哪几根计划变了”这三项**每轮都在跳**（第 1 轮只有 G1T1 变，第 2 轮只有 G1T3 变，第 5 轮一根都没变）。所以本轮只写 `MORE_SEARCH_WITHIN_100MS`，不写“决策更好”。

**5. 有没有新的正确性问题或性能退化？**  
没有。20 类特殊规则路径 20/20 通过（含推箱堵通道、踩夹回收、幽灵实体化延迟、自动拾取、双 RULE-A、抓捕/入洞终局）；CHANCE 结果顺序、权重、基数、pending 语义全部一致；搜索期 `Math.random` 调用 0 次；0/24 根变慢；无新增 fallback；5 轮里无任一根丢掉已完成的计划。全量回归 83 文件 / 1041 passed / 4 skipped（预存）/ exit 0；`tsc -b` 与 `vite build` 均 exit 0。

**6. 建议采用吗？**  
建议采用为 P2 的正式候选。它只碰了 3 个搜索文件，语义零漂移，收益有配对统计证据。**但**：这**不是** 150ms 物理时限认证（`ABSOLUTE_DEADLINE_GATE` 仍 `BLOCKED`），也**不是**棋力提升证明。

---

## 二、完整技术报告

### 1. 基线身份（PT-0）

| 项            | 值                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| HEAD         | `48eaac6c4f3801d351787696ba5876995b64e8d8`（本轮结束仍是它）                                                        |
| 工作树          | 14 个已跟踪修改 + 13 个未跟踪文件 + 10 个未跟踪目录（P1 遗留），本轮未动                                                              |
| 三份冻结归档       | `5cd73282…`（CHECKPOINT-01）/ `a6a7795c…`（OPENING-STACK-01）/ `27dbc3c2…`（OPENING-SEAL-01），与任务书逐位相同，未重命名、未重打包 |
| 26 个 P1 源码文件 | sha256 / 字节 / 行尾 **26/26 与 SEAL-01 `SOURCE_MANIFEST.json` 一致**                                             |

本轮真正基线是**当前工作树**（P1 全部修复在位），不是裸 HEAD。

### 2. 重复模拟的真实形态（PT-1）

探针 `probe/duplicateWitness.test.ts` 在**未改动任何生产源码**时捕获  
`BASELINE_DUPLICATE_SIMULATION.json`：把注入的 `RuleSet` 包一层计数代理，记录每一次**真实引擎转移**的  
`(规则函数, 动作身份, 输入 stateKey)`。

| 量                      | 值              |
| ---------------------- | -------------- |
| 真实引擎转移执行次数             | **13 960**     |
| 不同的 `(函数, 动作, 输入状态)` 组 | **6 253**      |
| 被执行 >1 次的组             | **5 474**      |
| 冗余执行（Σ(count−1)）       | **7 707（55%）** |
| 重复执行结果**不一致**的组        | **0**          |

最后一行是复用之所以安全的关键：重复计算是纯的，没有输入状态污染，也没有随机数。

逐节点形态与调用图预测完全一致：

| 位置   | 每个合法动作的模拟次数              | 证据                       |
| ---- | ------------------------ | ------------------------ |
| 内部节点 | 2（合法性 + prepared）        | 直方图众数为 2                 |
| 根节点  | 3（空集检查 + 合法性 + prepared） | 根组 `catMove:U/D/L/R → 3` |

修复后同一探针：13 960 → **7 511**，冗余执行 → **1 258**，组数仍为 **6 253**（覆盖不变）。  
剩余 672 个重复组是**同一状态被不同路径再次展开**（DAG 再展开），不是同一节点模拟两次 —— 那属于另一种机制（TT 复用 / DAG 搜索），本轮按"只做一个机制"的授权不做。

**"根节点 3 → 1"是数出来的，不是推的。**&#x63A2;针对同一批根另跑 `capturePlan=false`（纯搜索，剔掉搜索后  
计划回放的那部分调用），逐根累计每个根动作的模拟次数：

| 动作                            | 修复前（纯搜索）          | 修复后（纯搜索）              |
| ----------------------------- | ----------------- | --------------------- |
| `catMove:U` / `D` / `L` / `R` | 70 / 68 / 71 / 70 | **24 / 24 / 24 / 24** |
| `catPlaceTrap`                | 12                | 4（只有 4 根的根状态还有夹可放）    |

24 根求和恰好 24，即每根根节点每个合法动作只模拟 1 次。顺带一条独立旁证：**计划提取部分的调用数  
修复前后都是 374（一位不差）**，说明搜索之外的路径确实一行没动。纯搜索口径总量 13 586 → 7 137（−47.5%）。  
成本归因（为什么减 46% 只快 8.5%）见 `RUNTIME_COST_ATTRIBUTION.md`：约 18–19% 的固定 D1 墙钟花在规则转移上。

### 3. 实现（PT-2）

新增 `src/game/ai/preparedActions.ts`（唯一候选枚举源）：

```ts
enumerateSearchActionCandidates(state)  →  { action, verifyEffectiveness }[]
generatePreparedSearchActions(state, rules)  →  { action, transition, originalIndex }[]
```

- `generateLegalSearchActions`（公共 API）改为复用同一枚举，**输出与语义零变化**：仍返回 `SearchAction[]`，  
  仍逐个模拟，隧道出口仍**不做**合法性模拟（`verifyEffectiveness: false`）。
- `searchActions` 使用 prepared 批次；`runFixedSearch` 把根批次**下传**，不再为"空集检查"重复生成。
- 下游（排序、TT 提示、Alpha-Beta、MAX/MIN 选择、同分规则、equal-primary 图、计划提取）一行未改，  
  读到的仍是同一个 `transition` 对象，只是它来自那一次合法性判定。

改动规模：`expectiminimax.ts` 净 +30 行左右，`legalActions.ts` 结构重组（-26/+9），新增 1 个模块、1 个测试文件。  
`engine.ts` / `config.ts` / `openingFairness.ts` / `evaluation.ts` / `transposition.ts` / `hardTurnPlanner.ts` /  
`planQuality.ts` / `simulator.ts` / `searchTypes.ts` **未触碰**。

详见 `IMPLEMENTATION_DESIGN.md`（含为什么选 B 方案 + 共享枚举，以及为什么不动另外 13 个调用点）。

### 4. 正确性（PT-3 ~ PT-10）

| 门              | 证据                                                                                                                                    | 结果            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 转移语义           | 24 根每个 prepared 动作再做一次独立模拟：91/91 动作 kind 一致、`stateKey` 一致、**整状态 JSON 一致**（91 确定性 + 0 根级 CHANCE，CHANCE 见下）                             | 0 mismatch    |
| 特殊规则 20 条      | 真实引擎回放（推箱、推箱堵通道、放夹不耗步、踩夹回收、鼠踩夹结束回合、携油、技能换步、隧道出口、黄油 CHANCE、幽灵公告、交接实体化、延迟实体化、自动拾取、双 RULE-A、抓捕、catBaseMoves 4/6/9、Void/Wall、陷阱地形身份）      | **20/20**     |
| CHANCE 合同      | 结果数 = `enumerateButterSpawns` 细胞数、**顺序逐一相同**、权重均一且 Σ=1、每个 outcome 只 +1 pending ghost、鼠站在实体化格上自动拾取、被占则 `blockedMaterializations>=1` 延迟 | PASS          |
| 随机副作用          | 24 根固定 D1 搜索期 `Math.random` 调用 **0 次**（包装计数，`finally` 还原并断言 `Math.random===native`）                                                   | PASS          |
| 24 根全字段 parity | 对冻结 `ppcId01-baseline-d1.json`：value/mate/completed/action/plan/ttSize/**每个 diagnostics 计数器** 逐字段比较                                   | **24/24 零差异** |
| 两臂一致性          | baseline 臂 vs 候选臂同协议：value/mate/action/plan/nodes/chanceNodes/ttHits/cutoffs **24/24 相同**                                             | PASS          |
| 完整回合           | `computeCatAiTrajectory` 全生产路径 24 根，两臂 `ok` 一致，0 新增 fallback                                                                          | PASS          |
| 输入不变性          | 搜索后根状态整对象与搜索前**逐字节相同**                                                                                                                | PASS          |

### 5. 实时预算诊断（PT-9/PT-10，**非权威**）

固定 100ms 主搜索 / 150ms 整回合，24 个真实根，两臂各跑一次完整猫回合。

**这一节单跑一次是不够的，所以跑了 5 次。**&#x7B2C;一次跑出的表（节点 6 161 → 6 662、完整计划 22 → 23、  
回退 2 → 1、唯一变化根 G1T1）第二次跑就不成立了（23 → 23、1 → 1、变化根换成 G1T3）。  
100ms 是一道硬悬崖，一次采样分不清“优化改变了结果”和“这台机器这一秒恰好快一点”。  
两份样本都没丢，另补 3 次，共 5 次同协议重复（`_raw/deadline_integration_run{1..5}.json`）：

| 轮次 | 节点总量 基线 → 候选  | 总量比   | 逐根中位比 | 完整计划    | 回退    | 变化根              | 中位墙钟 基线/候选    |
| -- | ------------- | ----- | ----- | ------- | ----- | ---------------- | ------------- |
| 1  | 6 161 → 6 662 | 1.081 | 1.136 | 22 → 23 | 2 → 1 | G1T1             | 151.0 / 151.1 |
| 2  | 6 695 → 7 412 | 1.107 | 1.156 | 23 → 23 | 1 → 1 | G2T6, G1T3       | 150.9 / 150.9 |
| 3  | 6 179 → 7 229 | 1.170 | 1.196 | 22 → 23 | 2 → 1 | G2T6, G1T1, G1T3 | 151.0 / 151.1 |
| 4  | 6 101 → 7 058 | 1.157 | 1.216 | 23 → 23 | 1 → 1 | G1T3             | 151.0 / 151.0 |
| 5  | 6 137 → 7 135 | 1.163 | 1.158 | 23 → 23 | 1 → 1 | （无）              | 151.0 / 151.0 |

|                                                       |   |            |
| ----------------------------------------------------- | - | ---------- |
| **稳的（5/5 一致）**：候选每轮都搜到更多节点（总量比 1.081–1.170）；中位回合墙钟不变（ | Δ | ≤ 0.15ms）； |
| 没有任何一根丢掉已完成的计划；没有新增任何 fallback。                       |   |            |

**不稳的（0–3 根/轮）**：哪几根计划或深度变化。并集只有三根，且方向总是“候选更深或相等、从不更浅”：

| 根    | 基线                             | 候选                        | 出现在     |
| ---- | ------------------------------ | ------------------------- | ------- |
| G1T1 | depth 0，`search_incomplete`，回退 | depth 1，`TDDDD`，值 209.947 | 轮 1、轮 3 |
| G1T3 | depth 1，`DRRR`，值 +32.97        | depth 2，`UUUL`，值 −536.11  | 轮 2、3、4 |
| G2T6 | depth 1，`LUUU`，值 −918.21       | depth 2，`LUUU`，值 −905.71  | 轮 2、轮 3 |

G1T3 这一根值得单独说：候选把深度从 1 做到 2，值从 +32.97 掉到 −536.11。这**不是**“找到更好的计划”，  
而是**多搜一层后发现这个局面比深度 1 以为的糟得多**——恰恰说明 D1 视野不足以判优。

**结论只有一句**：`MORE_SEARCH_WITHIN_100MS = YES`（稳），`BETTER_VERIFIED_DECISION = NONE`（不稳，且本轮  
没有任何对抗验证支持任何一根的改选更优）。本节不构成时限认证，`ABSOLUTE_DEADLINE_GATE` 保持 `BLOCKED`。

**G6T2 具名观察（5/5 稳定）**：即 CAT-STRATEGY-01 里"幽灵黄油诱敌"的那根。两臂都是 depth 1、计划 `UURR`、  
根值 −247.237、mate null。本轮**没有**让 G6T2 改选 `DRRR`。未调 H1。

### 6. 性能实验（PT-11 / PT-12）

协议（预先固定，事后不调）：24 个冻结真人根，D1（depthTurns=1、maxNodes=10000、TT+AB+排序开、  
`evaluateCorrectedHoleForCat`、capturePlan），每臂一个全新 Node 进程，进程间串行，进程内跑 5 趟取**中位数**，  
每 rep 计算 B/A，20 个 rep 取几何均值 + 配对 t 的 95% CI。

| 实验                               | 配对数 | 几何均值        | 95% CI                 | 结论                   |
| -------------------------------- | --- | ----------- | ---------------------- | -------------------- |
| A/A（两臂都是 baseline）               | 20  | 0.99545     | [0.98796, 1.00300]     | 通过（远窄于 ±5%）          |
| A/A 独立复本（`run1_*`）               | 20  | 1.00065     | [0.99278, 1.00858]     | 与上一致                 |
| **A/B（A=baseline, B=candidate）** | 20  | **0.91496** | **[0.90269, 0.92739]** | **快 8.50%，上界 0.927** |

预注册判据：`NO_REGRESSION_GATE`（上界 ≤1.05）PASS；`POSITIVE_SPEEDUP_EVIDENCE`（上界 <1.00）YES；  
`STRONG_SPEEDUP_EVIDENCE`（上界 ≤0.98）**YES**。

逐根：**0/24 慢于 baseline**；最慢的 5 根 G1T9 0.946、G2T4 0.934、G1T7 0.932、G2T1 0.932、G2T5 0.930；  
最快的 G1T4 0.869、G6T2 0.877。逐根 CI 与逐 rep 原始数据见 `AB_PERFORMANCE_RESULTS.json`。

资源：每进程 RSS ≈135MB，80 个基准进程严格串行，峰值并发内存 ≈135MB，无 OOM、无换页  
（`RESOURCE_SAFETY_LOG.md`）。

**这不是时限认证**：`ABSOLUTE_DEADLINE_GATE` 保持 `BLOCKED`。相对加速不等于整猫回合 150ms 物理合规；  
M1/M2 分布门是更窄的测量域，不能拿来冒充。

### 7. 回归与构建（PT-14 / PT-15）

**全量串行回归（第一遍即绿，未重跑到绿）**

```
npx vitest run --maxWorkers=1 --no-file-parallelism
Test Files  83 passed (83)
     Tests  1041 passed | 4 skipped (1045)
  Duration  1621.10s (tests 1588.86s)
    ExitCode 0
```

日志：`logs/full_regression.log`（291 726 B，单文件，未截断，未重跑）。

**用例数增量可完全解释**（每次归档都有具名日志，逐级对得上）：

| 轮次                      | 文件     | 枚举用例                     | 与上一轮差           | 来源                                                                       |
| ----------------------- | ------ | ------------------------ | --------------- | ------------------------------------------------------------------------ |
| PPC-P1-CHECKPOINT-01    | 81     | 1 000（996 过 + 4 跳）       | —               | `PPC-P1-CHECKPOINT-01/logs/*`                                            |
| PPC-P1-OPENING-STACK-01 | 82     | 1 026（1 022 过 + 4 跳）     | +1 文件 / +26     | 新增 `openingFairnessStackSafety`，`logs/11_promoted_tests.log` = 26 passed |
| PPC-P1-OPENING-SEAL-01  | 82     | 1 027                    | +1              | 同一文件 27 passed（`logs/01_sealed_test_file.log`），该轮只单跑此文件                  |
| **本轮**                  | **83** | **1 045（1 041 过 + 4 跳）** | **+1 文件 / +18** | 新增 `preparedTransition.test.ts`，单跑 18 passed                             |

1 027 + 18 = 1 045，**逐位闭合**，没有第 19 条来历不明的用例。

**4 个 skip 是预存的，与本轮无关**。默认 reporter 只印数量不印名字，故另跑一次定向确认：

```
npx vitest run src/game/ai/__tests__/boundedPlanRefutation.test.ts --reporter=verbose -t "G0.3W"
Tests  9 passed | 4 skipped (13)
  ↓ G0.3W-4 … G0.3W-7  (describe "G0.3W real-corpus regression (G4 / G1)")
```

即 `ctx.skip()`，语料缺失；P1 的 1 000 / 1 026 两次全量也是同样这 4 条，换机器一样跳。

**构建**

| 门          | 命令                                      | 结果                       | 证据                  |
| ---------- | --------------------------------------- | ------------------------ | ------------------- |
| TypeScript | `npx tsc -b`                            | exit 0，无输出               | `logs/tsc.log`（0 B） |
| 生产构建       | `npm run build`（`tsc -b && vite build`） | exit 0，97 modules，7.29 s | `logs/build.log`    |

模块数 96 → 97，增的就是新文件 `preparedActions.ts`；`dist/assets/index-*.js` 2 716.73 kB（gzip 1 164.73 kB）。  
本轮**没有**出现 P1 记录过的 safe-delete 外壳拦截 `emptyOutDir`，`npm run build` 一次通过。

**回归期间源码未漂移**：回归结束与 `tsc`/`build` 结束后各校验一次，三个生产文件 sha256 仍为  
`67b76ad3…`（preparedActions）/ `27ae2f46…`（legalActions）/ `50d27da5…`（expectiminimax），与  
`SOURCE_MANIFEST.json` 逐位相同。

### 8. 归档（PT-16）

```
F:/ppc-checkpoints/PPC-P2-PREPARED-TRANSITION-01-candidate.tar.gz
digest + 字节数：见同目录 ARCHIVE_SHA256.txt（构建后生成）
182 个清单成员 + 1 个不可自哈希的清单文件 = 解包后 183 个文件
```

> **为什么报告里不印摘要本身**：归档里装着这份 `REPORT.md`，一旦把 tarball 的 sha256 写进正文，  
> 改一个字就换一个摘要、摘要又写回正文，永远自相矛盾。同样的道理适用于 `ARCHIVE_SHA256.txt`  
> （它记的是"这次 tar 完成后"的摘要，打包时还不存在）——所以这两个文件都被登记为  
> `ARCHIVE_MANIFEST.json` 里的 `selfExcluded`，由 tarball 旁边的 `ARCHIVE_SHA256.txt` 作为权威。  
> 第一次构建时 `ARCHIVE_SHA256.txt` 被当作普通成员打进去，结果包里装的是**上一次**构建的摘要，  
> 看上去权威、实际是旧值——这是本轮抓到的第二个自引用缺陷，已按上述方式消除。

内含：本轮 4 个实际改动文件的**原始字节**、12 个具名结果 JSON、5 份文档、全部逐 rep 原始数据  
（`_raw/bench/` 122 份 + 5 轮 deadline 诊断）、5 个日志、14 个探针脚本、`ARCHIVE_MANIFEST.json`。

`RESTORE_VERIFICATION.json`（`probe/verify_restore.mjs` 生成）：**verdict = PASS**

| 检查            | 结果                                                            |
| ------------- | ------------------------------------------------------------- |
| 解包位置          | 仓库外 `mkdtemp`（`%TEMP%/ppc-p2-restore-*`），未碰工作树，未用 `git apply` |
| 逐成员 sha256    | 182/182 相同，`shaMismatch = 0`                                  |
| 逐成员字节数        | `sizeMismatch = 0`                                            |
| 清单双向          | `missing = 0`，`extra = 0`（唯一"非成员"是清单自身，见下）                    |
| 4 个源文件 vs 工作树 | 4/4 逐字节相同                                                     |
| baseline 臂溯源  | 165/165 resolved，`unresolved = []`                            |


**两条设计取舍要写明**（都是自引用，都是第一次跑就撞上的）：

1. `ARCHIVE_MANIFEST.json` **不能**把自己算进成员（清单无法携带自身哈希）。它在清单里登记为
   `selfExcluded`，验证脚本把它当成**唯一**允许的额外文件。
2. `ARCHIVE_SHA256.txt` 记的是"这次 tar 完成后"的摘要，打包时**还不存在**。第一次构建把它当普通成员
   塞了进去，于是包里躺的是**上一次**构建的摘要——数值看起来权威、其实是旧值。现在它同样登记为
   `selfExcluded`，权威副本只放 tarball 旁边。

第一次跑验证时脚本按"双向清单"严格要求，把清单报成 `EXTRA` → `FAIL`；处理是让**清单、构建脚本和
验证器同时**承认这两条例外并写进 JSON，**不是**放宽 sha 或字节检查。

三份 P1 归档未被覆盖、未被修改、未被重新生成：

| 归档 | sha256（本轮开始 = 结束） |
|---|---|
| `PPC-P1-CHECKPOINT-01-candidate.tar.gz` | `5cd732828856f2b3cd903cc20c584bbb0fec7906d283ec08415bd2653a9425d5` |
| `PPC-P1-OPENING-STACK-01-candidate.tar.gz` | `a6a7795c4f31533a8127ec9e8594a4974aad019b73f69a1421a5c04930c2d015` |
| `PPC-P1-OPENING-SEAL-01-candidate.tar.gz` | `27dbc3c2f4ad183f75808ab3394f0ff3675505ea6781591000b5a5594706dd2f` |

三者与任务书给出的前缀逐位一致。复原配方见 `RESTORE.md`（4 步逐层覆盖，**禁止 `git apply`**）。

### 9. 越权检查（PT-17）

| 项 | 状态 |
|---|---|
| 游戏规则 | 未改 |
| H1 权重 / `evaluateForCat` | 未改 |
| 搜索数学（mate/AB/TT/stateKey） | 未改 |
| 100ms / 150ms 常量 | 未改 |
| Sidecar 策略与预算 | 未改 |
| Progress Guard 策略 | 未改 |
| 鼠 AI | 未改 |
| commit / push / merge | 全部 NO |
| 第二项独立优化 | 未做 |

### 10. 过程自曝

1. **A/A 首轮驱动被沙箱中断**：第一遍 `runBench.mjs aa 20` 已完整跑完（日志记 `driver done`，196.1s）但
   退出时锁文件未清，导致下一次调用直接 ABORT。处理：40 份数据完整保留为 `run1_*` 作独立复本、确认 pid 已死后清锁、
   驱动加 pid 存活检查、A/A 从零重跑后作为权威数据。两份 A/A 互相印证（0.9955 / 1.0007）。
2. **`duplicate_witness_pre.json` 在改码前重写过一次**：为加入 `searchOnly`（`capturePlan=false` 的纯搜索
   子集）字段，在**任何生产改动之前**重跑了一次 `PHASE=pre`。文件 mtime 12:35:40，`expectiminimax.ts`
   首次修改 mtime 12:36:42，故两份捕获都在修复前；修复后一律写 `_post.json`，pre 文件此后未再生成。
3. **回归运行期间的一次无效编辑**：修 `expectiminimax.ts` 一个多余空行时先删后补，约 40 秒窗口内文件
   与基准版本仅差一个空行（编译产物相同），随后已还原；回归结束时该文件 sha256 与 `SOURCE_MANIFEST.json`
   记录的 `50d27da5…` **完全一致**（即与基准/回归所用字节相同）。
4. **`process.resourceUsage().maxRSS` 在 Windows 恒为 0**：故峰值内存只能记 RSS，不能记"峰值 RSS"，已在资源日志注明。
5. **本机吞吐波动依旧**：HV18-7 单测本轮约 13 分钟、heap 峰值 ≈1.07GB，与 P1 期间同量级；这是墙钟不是性能测量。
6. **本节最重要的一条：我曾用单次采样写过 §5，然后发现自己错了。**第一版 §5 只有一张表（节点 6 161→6 662、
   完整计划 22→23、回退 2→1、唯一变化根 G1T1），读起来像"优化让更多根拿到计划、少一次回退"。收尾复跑同一
   探针（同代码同命令）得到 23→23、1→1、变化根换成 G1T3，两版冲突。原因：这道门卡在 100ms 硬悬崖上，
   机器吞吐的百分级抖动就足以让某根跨过/退回深度边界。处理：**两份样本都保留**（`run1` / `run2`），
   再补 3 次共 5 次同协议重复，把"稳的"和"跳的"分开写（§5），并把 G1T1 那一格从结论里降级为个案。
   教训：凡是贴着预算边界的诊断，单次结果不可作为断言，必须重复并报方差。
7. **`parseRegression.mjs` 首版解析失败**：vitest 的汇总行带 ANSI 颜色码（`ESC[2m Test Files ESC[22m`），
   `^\s*Test Files` 匹配不上，脚本诚实输出 `verdict: NOT_PERFORMED` 而不是猜数字。修法：先剥 ANSI 再匹配。
   另补两条：reporter 在 0 failed 时**整行不印** "N failed"，故 null 必须解释为 0（这个解释写进了 JSON 的
   `nullSemantics` 字段，没有偷偷改判定）；4 个 skip 的名字 reporter 也不印，另跑定向 verbose 才拿到。
8. **归档清单的自指问题**：第一次 `verify_restore` 报 `FAIL`，原因是 `ARCHIVE_MANIFEST.json` 把自己列成
   成员却给不出自身哈希（旧脚本 `members.push` 那行其实被序列化时机吃掉了）。修法是把它登记为
   `selfExcluded` 并在验证器里承认这一条**唯一**例外，同时保留全部 sha/字节/双向检查（§8）。
9. **清理过一次重复证据**：`_raw/_prev/`（重跑前的 4 份旧副本）与 `_raw/deadline_integration.json`
   （= `run5`，sha 相同）在归档前删除，避免同一份数据以两个名字出现。删前已用结构化对比确认
   `d1_parity` / `transition_semantics` / `special_rule_replay` 三次重跑结果与旧副本**除时间戳外完全相同**，
   `deadline_integration` 的差异是 100ms 悬崖（已按 5 轮处理，见 §5）。

### 11. 下一阶段（P2 战略研究入口，本轮不实施）

按本轮新数据，给后续架构裁决的具名问题（均**未**在本轮改动）：

1. **"放夹开头"这件事现在是间歇性的**：5 轮里 G1T1 有 2 轮从"深度 0 + 回退"变成"深度 1、计划 `TDDDD` 以放夹
   开头"，另外 3 轮 G1T1 本来就完成了深度 1。放夹免费 + `trapControl` 无条件正分的已知偏差（CAT-STRATEGY-01 §6）
   会在候选更快时**更容易**表现出来——但这需要专门实验（相同根、固定深度、关掉时钟）才能定量，不能用这份
   100ms 诊断当证据。是否给放夹加时序项？
2. **深度边界恰好是计划不稳定源**：G1T3 在 3 轮里从 depth 1（`DRRR`，+32.97）跳到 depth 2（`UUUL`，−536.11）。
   跨一层深度就换计划、且估值差 569 分，说明 D1 视野判优不可靠；这也解释了为什么"计划稳定度"不能当棋力指标。
   23/24 根在 100ms 下仍只到 depth 1，鼠方一回合多步战术（幽灵诱敌）仍在视野外。是否把"鼠油+幽灵"纳入
   D1 的显式威胁项？
3. **推箱堵通道**：`generateBoxPositions` 只采样内圈导致箱子永不在最外圈（24/24 真实回合
   `boxesAdjacentToCorners=0`）——这是**地图生成**问题，不是搜索问题，需单独裁决。
4. **计划稳定性**：本轮 1/24 根计划变化且无法证明优劣；后续应建立"计划稳定度 vs 时间预算"的观测量，
   而不是用单盘结果判断强弱。

---

## 三、验收门汇总（PT-0 ~ PT-17）

| 门 | 检查内容 | 结论 |
|---|---|---|
| PT-0 | 基线身份：HEAD 未变、三份 P1 归档 sha256 与任务书逐位相同、26 个 P1 源文件与 SEAL-01 清单一致 | **PASS** |
| PT-1 | 改码**之前**复现并冻结重复模拟，逐调用记录身份与输出等价性 | **PASS** |
| PT-2 | 最小生产实现：每候选每节点只模拟 1 次、单一枚举源、下游一行未改 | **PASS** |
| PT-3 | 转移语义 parity：prepared vs 独立重算（kind / stateKey / 整状态 JSON） | **PASS**（91/91，0 mismatch） |
| PT-4 | CHANCE 合同：基数/顺序/权重/Σ=1/pending/debt/自动拾取/无随机采样 | **PASS**（搜索期 `Math.random` 0 次） |
| PT-5 | 搜索数学未变：mate 传播、Alpha-Beta、TT 准入、`stateKey`、计划上界 | **PASS** |
| PT-6 | 排序、`originalIndex`、隧道出口、终止相空批、放夹/技能前置 | **PASS** |
| PT-7 | 20 类特殊规则真实引擎回放 | **PASS**（20/20） |
| PT-8 | `catBaseMoves` 4/6/9、不规则 Void/Wall、陷阱/黄油地形身份 | **PASS** |
| PT-9 | 100ms/150ms 实时行为（**诊断，非权威**） | **PASS**（5 轮重复，方差已报） |
| PT-10 | 同一墙钟预算内是否搜得更多 | **PASS**（节点更多 5/5；计划变化不稳，已降级） |
| PT-11 | A/A 校准：20 次 fresh、严格串行 | **PASS**（CI [0.9880, 1.0030]） |
| PT-12 | A/B：20 次 fresh、每臂独立进程、严格串行 | **PASS**（0.9150，CI [0.9027, 0.9274]） |
| PT-13 | 预注册判据原样应用、未调门槛 | **PASS**（5 门全绿） |
| PT-14 | 全量串行回归（第一遍即绿，未重跑到绿） | **PASS**（83 文件 / 1041 passed / 4 预存 skip / exit 0） |
| PT-15 | `tsc -b` 与 `vite build` | **PASS**（均 exit 0，97 modules） |
| PT-16 | 新候选单独归档、仓库外可复原、三份 P1 归档未动 | **PASS**（184 成员，165/165 臂溯源） |
| PT-17 | 越权检查：规则/H1/搜索数学/TT/stateKey/上界/常量/Sidecar/Guard/鼠 AI 全未改；无 commit/push/merge；未做第二项优化 | **PASS** |

**18/18 PASS，0 FAIL，0 BLOCKED，0 NOT_PERFORMED。**
`ABSOLUTE_DEADLINE_GATE` 单独计，保持 **BLOCKED**（相对加速 ≠ 150ms 物理合规）。

机器可读版：`FINAL_DECISION.json`（含每门的 `measured` 与 `evidence`）。

---

## 四、机器状态块

```text
ROUND = PPC-P2-PREPARED-TRANSITION-01

SOURCE_INTEGRITY = PASS

DUPLICATE_SIMULATION_REPRODUCED = YES
PREPARED_TRANSITION_IMPLEMENTED = YES

RULE_TRANSITION_PARITY = PASS
CHANCE_PARITY = PASS
SEARCH_MATH_PARITY = PASS
PLAN_PARITY = PASS
D1_24_ROOT_PARITY = PASS

MAIN_SEARCH_BUDGET_MS = 100
TOTAL_HARD_TURN_BUDGET_MS = 150

AA_FRESH_REPETITIONS = 20
AB_FRESH_REPETITIONS = 20

AA_CALIBRATION = PASS
AB_NO_REGRESSION = PASS
POSITIVE_SPEEDUP_EVIDENCE = YES

MORE_SEARCH_WITHIN_100MS = YES
BETTER_VERIFIED_DECISION = NONE
NEW_EFFICACY_AUTHORITY = NONE

DEADLINE_DIAGNOSTIC_SAMPLES = 5
DEADLINE_DIAGNOSTIC_NODE_RATIO_RANGE = 1.081-1.170
DEADLINE_DIAGNOSTIC_PLAN_CHANGES_PER_RUN = 0-3

FULL_REGRESSION = PASS
FULL_REGRESSION_FILES = 83
FULL_REGRESSION_TESTS = 1041 passed / 4 skipped / 1045
FULL_REGRESSION_EXIT = 0
FULL_REGRESSION_DURATION_S = 1621.10
TYPESCRIPT_BUILD = PASS
VITE_BUILD = PASS

ABSOLUTE_DEADLINE_GATE = BLOCKED

GAME_RULES_CHANGED = NO
H1_WEIGHTS_CHANGED = NO
SEARCH_MATH_CHANGED = NO
SIDECAR_POLICY_CHANGED = NO
PROGRESS_GUARD_POLICY_CHANGED = NO
MOUSE_AI_CHANGED = NO

HEAVY_WORKER_CONCURRENCY = 1
SERIAL_FRESH_REPETITIONS = TRUE
DUPLICATE_BENCHMARK_CHECK = PASS

CHECKPOINT_CREATED = YES
CHECKPOINT_PATH = F:/ppc-checkpoints/PPC-P2-PREPARED-TRANSITION-01-candidate.tar.gz
CHECKPOINT_SHA256 = see ARCHIVE_SHA256.txt
CHECKPOINT_RESTORABILITY = PASS
CHECKPOINT_MEMBERS = 182
CHECKPOINT_ARM_PROVENANCE = 165/165
P1_ARCHIVES_UNTOUCHED = YES

COMMIT = NO
PUSH = NO
MERGE = NO
```
