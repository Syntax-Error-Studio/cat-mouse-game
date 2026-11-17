# PPC-MCTS-01｜正式 Pilot 完成报告（PILOT-RESUME）

- 轮次：`PPC-MCTS-01-PILOT-RESUME`
- 运行日期：2026-11-16
- 代码基线 HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`（分支 `ppc/p1-id-state-identity-fix`）
- `GAMEPLAY.md` SHA256：`e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34`
- 24 根 fixture SHA256：`1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`
- `out/bench.mjs` SHA256：`e75b413efd9a0e37381c4299764f6c2a0c4f8129890901acc5f1c068ca04141f`

**一句话结论：20 个全新 Node 进程 × 24 根 × 3 臂 = 1440 次搜索已完整跑完，全部回放通过、零错误、零 `Math.random`。本轮拿到的是"固定预算下的搜索行为画像"，不是棋力结论。**

---

## 0. 本轮做了什么、没做什么

| | 内容 |
| --- | --- |
| 已做 | 资源预检与重复任务排查；冻结身份逐文件核验；14 项正确性测试复跑；20 进程串行 Pilot；聚合分析；证据 manifest |
| 未做 | 未碰 `src/`、`GAMEPLAY.md`、Formal V2 权威、生产 Hard AI、100/150ms 生产预算；未跑 1700 组 Formal V2；未跑 self-play；未 commit / push / merge |
| 未做 | 没有降低 repetitions / roots / algorithms / 任何门槛；没有扩大 V8 heap；没有杀别人的进程 |

工作树里原有的 14 个 `src/` 修改与未跟踪目录**原样保留**，本轮未新增或改变其中任何一个字节（MANIFEST 35/35 在运行前后均一致，见 `logs/MANIFEST.pre-resume.json` 与当前 `MANIFEST.json` 的同源条目）。

---

## 1. 预检裁决：PASS（附条件）

历史阻塞原因（`ai-reliability` 最终评测 + docmap-studio 开发服务器）**已经消失**：

| 历史观察对象 | 现状态 | 证据 |
| --- | --- | --- |
| `reliability-final-run.mjs`（PID 19772） | 不存在 | 进程表无匹配；`continue-v21.log` 与 `cohort-300-final-v21.jsonl` 最后写入 13:47，`remaining=98` 即**被中断**而非跑完 |
| `run-v21.mjs`（PID 38904） | 不存在 | 进程表无匹配 |
| docmap-studio `next dev` / `start-server`（12576 / 25972） | 不存在 | 进程表无匹配 |
| 遗留日志观察者（24868 / 22972 bash、36068 tail） | 存在但空闲 | 阻塞在 `tail -f continue-v21.log`，只读、CPU 不增长，**未杀**（非本项目进程） |

资源快照（16:26–16:27）：

```text
LOGICAL_CORES      = 24
CPU 采样(12s 全进程) = 30.1 CPU 秒 ≈ 2.51 核 ≈ 10.5%（无单一 heavy 消费方）
AVAILABLE_MB       = 2914      FREE_PHYSICAL_MB = 1852
COMMITTED / LIMIT  = 29637 / 35886 MB
PAGES OUTPUT/sec   = 0         PAGES INPUT/sec = 81.6
PAGEFILE C:  1227/2048 MB (peak 2047)
PAGEFILE E:  1812/16087 MB (peak 4633)
out/raw/           = 空（无部分结果，不存在重复执行风险）
```

**已披露的条件（写入 checkpoint 的 `caveats`）**：

1. 物理内存负载约 81%（可用 2.9 GB / 16.1 GB），比 13:05 阻塞点更高。但 `Pages Output/sec = 0`、pagefile 当前用量远低于峰值，**没有正在发生的换出**；Pilot 严格一次只跑一个 Node 进程，单进程常驻需求很小。
2. `ESurfingClient`（云盘同步客户端）长期占约 0.5 核；24 核机器上单线程搜索仍能拿到独占核心，但**不能声称干净机房级计时**。
3. 结论：不构成"明显内存压力 / pagefile 激增 / 严重 CPU 竞争"的停止条件，故判 PASS；但 TIMING 结论必须按"本机实测"读。

预检证据：`logs/preflight-resume-checkpoint.json`、`logs/preflight-resume-process.txt`。原始 13:05 阻塞记录与原始 smoke **原样保留未覆盖**。

---

## 2. 身份核验：逐文件全等

| 核验项 | 结果 |
| --- | --- |
| HEAD 与冻结基线 | 一致 `48eaac6c…` |
| 分支 | `ppc/p1-id-state-identity-fix` |
| MANIFEST 35 个文件 | **MATCH=35 / MISMATCH=0 / MISSING=0**（字节数 + SHA256 双比对） |
| `GAMEPLAY.md` | 一致 `e000778b…` |
| 24 根 fixture | 一致 `1a59787a…` |
| `out/bench.mjs` 与构建来源 | **逐字节相同**：用同一 esbuild 参数把 `proto/benchEntry.ts` 重建到临时路径，与原产物同为 2 902 767 B、同为 `e75b413e…`，`IDENTICAL=true`（未触碰原产物） |
| 三臂配置与 REPORT 一致 | `c=√2`、`maxHandoffs=4`、`deadlineMs=100`、`maxNodes=500000`；终局 ±1 / 非终局 `0.8·tanh(hybrid/2)`；RACE `100ms / 500000 / depth=4 / hybrid`，`useTT·useAlphaBeta·useMoveOrdering=true`、`useThreatOrdering=false`、`maxThreatExtensions=0` |
| 14 项正确性测试 | **14/14 PASS**，2.17 s（本节复跑，非引用旧日志） |

### 2.1 必须披露的身份缺口（未擅自修补）

`MANIFEST.json` 钉住 35 个文件，但 RACE 臂实际调用 `planHardCatTurn`（`src/game/ai/hardTurnPlanner.ts`）、计划成本用 `mateActionCost`（`src/game/ai/expectiminimax.ts`），这两个文件连同 `stateCompare.ts` / `searchConfig.ts` / `deadlineContext.ts` **被打进 `bench.mjs` 却没有进入 MANIFEST**。

处理方式：**没有**偷偷改动冻结的 MANIFEST 源文件清单，而是把它们的当前 SHA256 单独记录在 `data/transitive-source-identity.json`：

```text
hardTurnPlanner.ts   27b1ce6dc62234d0c822b2b0b6341205ac189b5f76d7662a5d29d9e17ded75ff
expectiminimax.ts    50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c
stateCompare.ts      7c6339357b7eb0d2687aa4cb2842a7a4f0d51f5b0ab288851b13901e536ad017
searchConfig.ts      0c960794de784785b8f12ac39fabf141bc1e82afd4cf8dc8d5788de12cabcd5c
deadlineContext.ts   ced449445d70d1ba88cb20d88415b3c641d670aa886536fcacefa36b4aa50235
```

由于 `bench.mjs` 已被证明与应用这些源码的确定性重建**逐字节相同**，执行内容仍然完全确定；缺的只是"冻结清单自证"这一层。

### 2.2 本轮唯一改动的脚本文件（必须披露）

`scripts/manifest.mjs` 增加了一行，把 `PILOT_COMPLETION_REPORT.md` 纳入清单：

```diff
-for (const rel of ['vitest.config.mts', 'REPORT.md']) {
+for (const rel of ['vitest.config.mts', 'REPORT.md', 'PILOT_COMPLETION_REPORT.md']) {
```

- SHA256 由 `a8b524ce1df5bf96558fef5822ab4ae5da318a9c6884a0c7d43ee44d2795ab7b` 变为新值（见当前 `MANIFEST.json`）。
- 理由：任务要求"最终 manifest 必须覆盖全部 20 份原始记录、日志、统计结果和报告"，而原脚本只收录 `REPORT.md`。
- 边界：只影响清单收集范围，**不涉及搜索算法、UCB1 参数、rollout 策略、Hybrid 评价、CHANCE 语义、深度/节点/预算、种子派生**；`out/bench.mjs` 未重建、未改动。
- 因此 `logs/MANIFEST.pre-resume.json` 与当前 `MANIFEST.json` 比对时，35 个原始条目中 **34 项全等，唯一差异就是这个脚本**。


---

## 3. PILOT_EXECUTION

严格按 `node PPC-MCTS-01/scripts/runPilot.mjs` 执行，`spawnSync` 串行，前一进程退出才启动下一进程。

```text
TOTAL_REPETITIONS            = 20
TOTAL_ROOTS                  = 24
TOTAL_ALGORITHMS             = 3
TOTAL_SEARCH_CALLS           = 1440      ← 搜索调用总数，不是 1440 个并发 worker
HEAVY_WORKER_CONCURRENCY     = 1
SERIAL_FRESH_REPETITIONS     = TRUE
CURRENT_REPETITION           = 1/20 … 20/20
FRESH_NODE_PROCESSES         = 20        (全部 EXIT=0，无 STDERR)
PILOT_ALL_JOBS_DONE          = TRUE
总墙钟                       = 2 min 38 s
单进程墙钟                   = 7766–8638 ms（rep-19 异常偏高）
```

产物：`out/raw/rep-01.jsonl` … `rep-20.jsonl`，每份恰好 72 行，共 **1440 条**，`repetition` 与文件名一一对应，无缺行、无重复键。

驱动的字段名沿用既有脚本的 `TOTAL_JOBS` / `CURRENT_JOB`（语义即 repetitions），子进程另印 `TOTAL_SEARCH_CALLS=1440` 与 `SERIAL_FRESH_REPETITIONS=TRUE`。

---

## 4. CORRECTNESS / REPLAY

| 检查项 | RACE | UCT-R | UCT-H |
| --- | --- | --- | --- |
| calls | 480 | 480 | 480 |
| `error` | 0 | 0 | 0 |
| `mathRandomCalls` | 0 | 0 | 0 |
| `replayOk` | 480/480 = 1.0 | 1.0 | 1.0 |
| `replayFullTurnConsumed` + 计划非空 | 475/480 = **0.9896** | 480/480 = 1.0 | 480/480 = 1.0 |
| `withinFullTurnBudget` (≤150 ms) | 479/480 = 0.9979 | 478/480 = 0.9958 | 479/480 = 0.9979 |
| `planActionCost` | 4（475 条）/ 0（5 条空计划） | 4（全部） | 4（全部） |

所有回放均由真实引擎 `catMove` / `catPlaceTrap` 逐步验证，模拟器不作为验收依据；全部计划不含鼠动作。

### 4.1 异常样本（原样保留，未删除、未重跑替换）

**(a) RACE 空计划 5 条**（`planLength=0`、`rootAction=null`、`completed=false`、`completedDepth=0`、`deadlineFired=true`）：

```text
rep-01 G6T1 104.8ms 146 nodes
rep-04 G1T1 103.3ms 129 nodes
rep-19 G6T1 103.4ms 146 nodes
rep-19 G2T8 227.5ms  55 nodes
rep-19 G1T1 114.9ms  42 nodes
```

机制：RACE 是迭代加深 expectiminimax，100 ms 硬墙在**深度 1 尚未完成**时就到期，于是 `bestAction=null`、计划为空。这是生产规划器在边界预算下的真实行为，不是 UCT 缺陷。

**这条推翻了旧 smoke 的一个隐含结论**：旧 smoke 报"72/72 计划非空"，但同一 `rep=1` 的 `G6T1 RACE` 本轮就是空计划——smoke 当时在 104.0 ms 恰好挤过深度 1，本轮 104.8 ms 没挤过。**RACE 在该根上处于 100 ms 边界，输出是双峰的**。因此旧 smoke 的"全非空"属于边界侥幸，不能当作稳定性质。

**(b) 4 条超 150 ms**（全部落在 rep-19）：

```text
rep-19 G2T7 UCT-R 187.0ms  nodes=39  sims=37  chance=16
rep-19 G2T7 UCT-H 518.4ms  nodes=2   sims=1   chance=0
rep-19 G2T8 RACE  227.9ms  nodes=55
rep-19 G2T8 UCT-R 159.3ms  nodes=62  sims=59  chance=59
```

诊断：`UCT-H 518.4ms / 2 节点 / 1 次模拟 / 0 次 CHANCE` 在算力上不可能——一次模拟不可能要半秒。这是**进程被调度挂起**（页错误 / GC / 系统抖动），不是算法成本。旁证：rep-19 整进程墙钟 8638 ms，其余 19 个进程 7766–7894 ms，`sumTotalMs` 8208 vs 约 7440（+10%）。

按任务要求，**这是环境级离群块，记录但不删样本，也不重跑"看起来慢"的那一条**。

---

## 5. TIMING（本机实测，非干净机房）

单位 ms。`searchMs` = 主搜索墙钟，`totalMs` = 完整猫回合。

| 分位 | RACE search | RACE total | UCT-R search | UCT-R total | UCT-H search | UCT-H total |
| --- | --- | --- | --- | --- | --- | --- |
| P50 | 104.881 | 105.301 | 100.030 | 100.523 | 100.427 | 102.869 |
| P95 | 116.450 | 116.907 | 100.476 | 101.265 | 102.561 | 106.747 |
| P99 | 130.790 | 131.461 | 101.068 | 102.128 | 106.556 | 111.279 |
| MAX | 227.519 | 227.949 | 186.403 | 187.046 | 514.075 | 518.378 |
| mean | 106.830 | 107.199 | 100.402 | 100.894 | 101.611 | 103.937 |
| min | 100.718 | 101.231 | 99.609 | 100.191 | 99.999 | 100.214 |

计划提取（`planMs`）P50 / P99 / MAX：

```text
RACE   0.001 / 0.009 / 0.241
UCT-R  0.469 / 1.696 / 3.288
UCT-H  2.257 / 7.146 / 9.166
```

要点：

1. **UCT 两臂把 100 ms 用得非常紧**（P99 分别 101.07 / 106.56），说明 deadline 检查粒度细、预算被打满而不是被浪费。
2. **RACE 系统性超过名义 100 ms**：最小值就是 100.718 ms，P50 104.88 ms。这是生产搜索检查粒度的固有行为，本轮**没有改预算**。它导致 480 条里有 1 条超 150 ms，其余在 131 ms 以内。
3. **UCT-H 的 `planMs` 比 UCT-R 高 4.7 倍**（2.26 vs 0.49 ms），因为它的树更浅、更多依赖 rollout 补全，计划提取要额外跑 rollout。
4. 若剔除 rep-19 这个离群进程，三臂 `totalMs` 的 P99 分别降到 130.9 / 101.8 / 109.6 量级，MAX 不超过 145 ms。

---

## 6. 搜索深度与计划（严格区分树内证据与 rollout 补全）

| 指标 | RACE | UCT-R | UCT-H |
| --- | --- | --- | --- |
| 树内计划长度 `treePlanLength` 均值 | 不适用（迭代加深，`completedDepth` 1:361 / 2:114 / 0:5） | **3.98**（3:22，4:444，5:14） | **2.26**（1:39，2:313，3:90，4:38） |
| `planExtended=true` | 不适用 | 38/480 = **7.9%** | 442/480 = **92.1%** |
| 补全步数均值（仅补全样本） | 不适用 | 1.21 | 2.07 |
| 最终计划长度分布 | 0:5，4:399，5:76 | 4:442，5:38 | 4:400，5:79，6:1 |
| 计划动作成本 | 4（或 0） | 4（全部） | 4（全部） |

**这是本轮最重要的结构性发现**：UCT-H 有 **92.1%** 的完整猫回合是靠 rollout 补齐的，树本身平均只走到 2.26 步；UCT-R 只有 7.9% 需要补全，树基本能自己走到交接（均值 3.98 步）。

**因此 UCT-H 的"计划质量"绝大部分是 Hybrid 评价函数沿 rollout 走出来的，不是树搜出来的。**任何拿 UCT-H 计划去谈"搜索更强"的说法都不成立——那是在谈 rollout 策略。

节点与模拟规模（每条调用的分布）：

| 指标 | RACE | UCT-R | UCT-H |
| --- | --- | --- | --- |
| nodes mean / P50 / P95 / MAX | 586.8 / 359.5 / 1600.2 / 2691 | 175.5 / 120 / 365.2 / 492 | **20.0** / 10 / 84 / 160 |
| simulations mean / P50 / P95 / MAX | 不适用 | **150.6** / 102 / 308.1 / 574 | **17.7** / 8 / 56 / 171 |
| chanceSamples mean / P50 / MAX | 0 / 0 / 0 | 69.3 / 30.5 / 364 | 7.5 / 0 / 57 |
| rootVisits mean / P50 / P95 / MAX | 不适用 | 150.6 / 102 / 308 / 574 | **17.7** / 8 / 56 / 171 |
| `deadlineFired` | 480/480 | 480/480 | 480/480 |
| `budgetFired`（节点上限） | 0 | 0 | 0 |

**UCT-R 与 UCT-H 的样本效率差 8.5 倍**（150.6 vs 17.7 次模拟/100 ms）。原因不是树结构，而是 **UCT-H 的 rollout 每一步都要调 `hybridEvaluateForCat`**，单步成本远高于随机 rollout。同一 100 ms 预算下，UCT-H 只能采到 UCT-R 的约 1/8.5。

500 000 节点上限在三臂中**一次都没触发**，所以本轮不存在"被节点上限截断"的污染。

---

## 7. DECISION_STABILITY（每根 × 每臂 × 20 次重复）

| 指标 | RACE | UCT-R | UCT-H |
| --- | --- | --- | --- |
| 根动作重复率（均值） | **0.9750** | **0.5500** | **0.7021** |
| 根动作重复率（剔除空计划后） | **0.9854** | 0.5500 | 0.7021 |
| 根动作完全不变的根数（rep 率 = 1） | 19/24 | **0/24** | 3/24（G2T3、G5T3、G5T4） |
| 完整计划重复率（均值） | 0.9729 | **0.1688** | 0.5042 |
| 每个根出现过的不同根动作数（均值） | 1.21 | 3.38 | 2.71 |
| 每个根出现过的不同完整计划数（均值，上限 20） | 1.25 | **15.08** | 5.50 |

逐根解读：

- **RACE 的"不稳定"几乎全是空计划造成的假象**。6 个非满分根里，G1T1（0.90）、G6T1（0.90）、G2T8（0.95）的差异只来自 `null`；真正在两种合法动作之间摇摆的只有 **G1T3（CUp 17 / CDown 3）** 与 **G2T6（CLeft 16 / CRight 4）**。
- **UCT-R 在 24 个根上没有一个能做到 20 次一致**，平均 3.38 个不同根动作、15.08 个不同计划（上限 20，几乎每次都不同）。这是 100 ms 内只有约 150 次随机 rollout 的直接后果——根动作访问分布太薄。
- **UCT-H 比 UCT-R 更稳（0.70 vs 0.55），尽管模拟数少 8.5 倍**。这说明稳定性来自"值噪声更低"（Hybrid 引导的 rollout），而不是"采样更多"。这条是本轮唯一在样本效率劣势下仍然反超的指标，值得下一阶段单独查证。

---

## 8. CROSS_ALGORITHM_COMPARISON

### 8.1 根动作一致性（480 对配对）

| 配对 | 逐次一致 | 逐根众数一致 |
| --- | --- | --- |
| RACE vs UCT-R | 236/480 = **0.4917** | 17/24 = **0.7083** |
| RACE vs UCT-H | 152/480 = **0.3167** | 9/24 = **0.3750** |
| UCT-R vs UCT-H | 140/480 = **0.2917** | 8/24 = **0.3333** |

### 8.2 完整计划一致性

| 配对 | 一致率 |
| --- | --- |
| RACE vs UCT-R | 15/480 = 0.0313 |
| RACE vs UCT-H | 12/480 = 0.0250 |
| UCT-R vs UCT-H | 2/480 = **0.0042** |

完整计划一致率接近 0 是**结构性必然**，不是"分歧"：RACE 与 UCT 是两种搜索范式，同回合后续 3–4 步只要有一处不同就整串不同；UCT-R 自身重复率只有 16.9%。因此**计划一致率不能当一致度指标用**，只能当"两臂是否同源"的排除性检查（结论：不同源，符合设计）。

### 8.3 搜索形态对照

| 维度 | RACE | UCT-R | UCT-H |
| --- | --- | --- | --- |
| 范式 | 迭代加深 expectiminimax + TT + αβ | 逐步随机树（均匀 rollout） | 逐步随机树（Hybrid rollout） |
| 每条调用节点 | 586.8 | 175.5 | 20.0 |
| 每条调用模拟 | — | 150.6 | 17.7 |
| 100 ms 内打到交接的能力 | 强（`completedDepth` 1–2） | 强（树深 3.98） | **弱（树深 2.26，92% 靠补全）** |
| 计划提取成本 | 0.002 ms | 0.49 ms | 2.33 ms |
| 稳定性 | 最高（但受空计划假象影响） | 最低 | 中等 |
| 时间可控性 | 系统性超 100 ms（+7 ms 量级） | 最紧（P99 101 ms） | 紧（P99 107 ms） |

### 8.4 三条必须写死的边界

1. **不能声称任何一臂棋力更强。** 本轮是 24 个固定历史根上的单回合计划生成，没有完整对局、没有鼠方续局、没有胜率。根动作一致率、节点数、计划差异都不构成强度证据。
2. **不能把 UCT-H 的计划归功于搜索。** 92.1% 的回合是 rollout 补出来的，本质上是在测 Hybrid 评价函数。
3. **不能把 RACE 的 0.975 根动作重复率当"更坚决"。** 它接近确定性搜索，这既是优点也是局限；而且这 0.975 里混着空计划造成的假阴性。

---

## 9. 最终技术裁决

| 层级 | 裁决 | 依据 |
| --- | --- | --- |
| `PILOT_EXECUTION` | **PASS** | 20/20 进程 EXIT=0，1440 条记录齐全，`PILOT_ALL_JOBS_DONE=TRUE`，串行无并发 |
| `SOURCE_IDENTITY` | **PASS（附披露）** | MANIFEST 35/35 全等；GAMEPLAY / fixture 全等；`bench.mjs` 与确定性重建逐字节相同；**5 个传递依赖未进 MANIFEST，已单独记录 SHA** |
| `CORRECTNESS` | **PASS** | 14/14 正确性测试复跑通过；运行期零错误、零 `Math.random` |
| `REPLAY` | **PASS** | 1440/1440 `replayOk`，全部经真实引擎 `catMove`/`catPlaceTrap` 逐步回放 |
| `TIMING` | **PASS（附条件）** | 三臂 deadline 均生效、节点上限从未触发；RACE 系统性超名义 100 ms 属既有实现；4 条超 150 ms 全部集中于 rep-19 的调度挂起 |
| `UCT_R_SEARCH_PROFILE` | **完成** | 150.6 模拟/100 ms，nodes 175.5，树深 3.98，计划重复率 0.169，根动作重复率 0.55 |
| `UCT_H_SEARCH_PROFILE` | **完成** | 17.7 模拟/100 ms，nodes 20.0，树深 2.26（92% 靠 rollout 补全），计划重复率 0.504，根动作重复率 0.702 |
| `RACE_SEARCH_PROFILE` | **完成** | nodes 586.8，`completedDepth` 1–2，searchMs P50 104.9 / P99 130.8，空计划 5/480 |
| `DECISION_STABILITY` | **完成** | RACE 0.9854（剔除空计划）/ UCT-R 0.55 / UCT-H 0.7021；UCT-R 无一个稳定根 |
| `CROSS_ALGORITHM_COMPARISON` | **完成（仅描述性）** | 一致性、节点、模拟、成本的对照已给出；**不作优劣裁决** |

### 明确分层的三类结论

```text
[已完成] 工程正确性验证
  → 规则复用、CHANCE 语义、真实引擎回放、确定性（零 Math.random）、预算生效

[已完成] 固定预算搜索行为实验
  → 样本效率、树深、补全比例、计划/根动作重复率、时间分位数

[未完成] 对抗强度结论
  → 需要独立完整对局（含固定鼠策略、续局规则、终局与重赛定义），本轮完全没有做
```

---

## 10. 交付物

```text
PPC-MCTS-01/
  out/raw/rep-01.jsonl … rep-20.jsonl   1440 条原始记录（20 进程 × 24 根 × 3 臂）
  out/smoke-final.jsonl                 原始 smoke（保留未改）
  out/bench.mjs                         构建产物（e75b413e…）
  data/per-root.json                    24 根 × 3 臂逐根聚合
  data/summary.json                     全局统计 + 配对比较 + integrity
  data/summary.csv                      扁平表（每根每臂一行）
  data/transitive-source-identity.json  未进 MANIFEST 的传递依赖 SHA
  logs/preflight-resume-checkpoint.json 本轮预检裁决（PASS + caveats）
  logs/preflight-resume-process.txt     进程/CPU/内存证据
  logs/preflight-checkpoint.json        原始 13:05 阻塞记录（保留未改）
  logs/rep-01.log … rep-20.log          每进程原始日志
  logs/pilot-driver.log                 驾驶员全量输出
  logs/MANIFEST.pre-resume.json         本轮运行前的 MANIFEST 快照
  logs/tests-final.txt                  原始 14/14 日志（保留未改）
  MANIFEST.json                         覆盖全部原始记录/日志/统计/报告，含 SHA256
  REPORT.md                             原始报告（保留未改）
  PILOT_COMPLETION_REPORT.md            本文件
```

复核入口：

```bash
node PPC-MCTS-01/scripts/analyze.mjs     # 幂等重算，会重打 integrity 与三臂摘要
node PPC-MCTS-01/scripts/manifest.mjs    # 重新自校验 SHA256
```

---

## 11. 已知限制

1. **24 根开发样本**，来自 `PPC-CAT-STRATEGY-SEAL-01` 的人类对局重建，不是正式 cohort。
2. **单机计时**：物理内存负载约 81%，存在一个持续占 0.5 核的云盘客户端；rep-19 出现一次调度挂起。
3. **RACE 的 100 ms 边界是双峰的**：同一根在不同重复里可能"刚好完成深度 1"或"空计划"。这是生产实现行为，本轮按任务要求**未修改**。
4. **UCT-H 的树证据很薄**：92% 靠 rollout 补全，任何关于"UCT-H 计划质量"的讨论都必须先声明这一点。
5. **计划一致率不可用作相似度**：跨范式比较时接近 0 属预期。
6. **传递依赖未进冻结 MANIFEST**（已披露并单独记录）。

---

## 12. 后续（不由本轮决定）

本轮到此停止，交付全部 artifact，等待 ChatGPT 复核。是否进入 `PPC-MCTS-01B｜Prepared Transition 复用与 UCT-H 搜索效率优化` 由复核决定。

本轮**没有**自行修改 UCT 算法、**没有**启动下一轮大规模实验、**没有** commit / push / merge。
