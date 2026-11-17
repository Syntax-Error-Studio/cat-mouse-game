# PPC-MCTS-01 — Stepwise Stochastic UCT 外部算法基线

**状态：实现完成、正确性验证完成、固定预算 pilot 因外部 heavy 负载阻塞，未产生正式对抗强度证据。**

- 报告生成时间：2026-11-16
- 代码基线 HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`
- `GAMEPLAY.md` SHA256：`e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34`
- 24 根 fixture SHA256：`1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`
- 规则集：引擎 `RuleSet`（GAMEPLAY_RULESET_VERSION = 2），未复制或简化任何游戏规则
- 隔离：本轮未修改 `src/`、`GAMEPLAY.md`、生产 H1、Sidecar、鼠 AI、100/150ms 生产预算、Formal V2 权威或旧 PPC 归档；未 commit / push / merge。`src/` 工作区中的改动是更早轮次遗留，本轮未触碰；MANIFEST 固定的是实际参与运行的源码内容。

---

## 1. 人话总结

UCT 搜索内核、RACE 对照臂、真实引擎回放、14 类正确性测试都已完成并通过。单进程 72 次调用（24 根 × 3 算法）的集成 smoke 全部完成：0 错误、0 次 `Math.random`、0 次回放失败、72/72 生成完整猫回合计划，且每个计划都被真实引擎 `catMove` / `catPlaceTrap` 回放通过。

约定的 **20 个全新 Node 进程 × 24 根 × 3 算法 = 1440 次搜索** pilot **没有启动**。原因是启动前的资源预检发现另一项无关的 `ai-reliability` 最终评测仍在持续占用 CPU，同时 docmap-studio 开发服务器仍在运行；此时运行固定 100ms/150ms 计时会被污染。按任务的安全规则，停止扩张、保存证据与 checkpoint，不降低重复数/根数/预算/测试门槛来“凑”结果。

因此：

- 可以说的：算法基线已实现，规则与计划生成正确性已验证，集成链路可运行。
- 不能说的：UCT-R / UCT-H 与 RACE 的强度高低、胜率、稳定性、正式计时结论。
- 当前没有 `data/summary.json`、`data/summary.csv` 或 20 份 `out/raw/rep-*.jsonl`，因为这些只能由被阻塞的 pilot 产生；本报告拒绝用 smoke 冒充 pilot。

---

## 2. 交付物与实现

### 2.1 目录

```
PPC-MCTS-01/
  proto/            UCT 内核、RACE 臂、真实引擎回放、CHANCE/种子随机、harness
  tests/            14 类独立正确性测试与受控 fixture
  scripts/          build / runPilot / analyze / manifest
  out/              bench.mjs（生成物）与 smoke-final.jsonl
  logs/             预检证据、checkpoint、最终测试日志
  data/             空（pilot 未运行，不伪造汇总）
  REPORT.md
  MANIFEST.json
```

### 2.2 内核与规则复用

`proto/uct.ts` 直接 import 并调用生产搜索内核，没有复制规则：

| 要求 | 实现位置 |
| --- | --- |
| 合法动作枚举 | `generateLegalSearchActions`（`src/game/ai/legalActions`） |
| 动作结果模拟 | `simulateSearchAction`（`src/game/ai/simulator`） |
| 状态完整键 | `stateKey`（`src/game/ai/transposition`） |
| 状态影响等价 | `gameAffectingEqual`（`src/game/ai/stateCompare`），用于拒绝到达树的非法 no-op 边 |
| 真实动作成本 | `mateActionCost`（`src/game/ai/expectiminimax`），用于计划成本 |
| 冻结叶评估 | `hybridEvaluateForCat`（`src/game/ai/hybridLeaf`） |
| RACE 生产搜索 | `planHardCatTurn`（`src/game/ai/hardTurnPlanner`） |

节点字段包含任务要求的 `state`、`currentPlayer`、`visitCount`、`totalReward`、`meanReward`、`legalActions`、`childNodes`、`actionTransition`、`parent`；CHANCE 节点另有经校验的 `chanceOutcomes`、`chanceMassError`。

### 2.3 UCB1 与零和视角

```text
score(edge) = (cat ? Q : -Q) + c * sqrt(ln N / N_a)
c = sqrt(2)
Q = child.meanReward  // 始终是猫视角 [-1, 1]
```

猫节点最大化、鼠节点最小化；同分边由 seeded policy RNG 选择，不使用 `Math.random`。主搜索结果按根动作访问次数选择（平局按动作键确定），与 UCB 选择分离。

### 2.4 CHANCE 处理

- 所有 CHANCE 层先经 `validateChance`：非空、权重有限且严格 > 0、总和与 1 的偏差 ≤ 1e-9。
- 采样使用独立 seeded PRNG（mulberry32 + FNV-1a 派生），覆盖：
  - 黄油拾取后的幽灵公告；
  - 猫→鼠边界实体化、延迟、重掷；
  - `pendingButterPlacementDebt`；
  - 多幽灵组合。
- 树内 CHANCE 结果按权重采样展开；rollout 内同样采样并计数。
- MCTS 全流程由 `withMathRandomGuard` 包裹：一旦调用 `Math.random` 即抛错，记录 `mathRandomCalls`。

### 2.5 深度、预算、rollout、终局

- 深度按真实行动权交接计数，`maxHandoffs = 4`。
- 主搜索 `deadlineMs = 100`；完整回合外部墙钟门槛 `150ms`（只测量，不放大）。
- 节点上限 `500000`。
- 终局：猫胜 `+1`、鼠胜 `-1`；非终局叶值 `0.8 * tanh(hybridEvaluateForCat(state) / 2)`，落在 `(-0.8, 0.8)`，与终局值域分离。
- UCT-R：均匀随机合法动作；UCT-H：在同一冻结 Hybrid evaluator 上取猫最大 / 鼠最小，同分 seeded 随机。
- 只有完整模拟才回传统计；deadline / 节点上限 / 深度边界均按未完成处理并计入诊断。
- 循环检测使用完整 `stateKey`，rollout 遇到重复状态即停止。
- 零步动作不计交接。

### 2.6 完整猫回合计划

- 树内主路径沿“访问最多且仍为猫行动”的边前进，遇到确定性交给鼠、终局或 CHANCE 边界停止。
- 关键修正：猫回合最后一步可能直接触发 CAT→MOUSE 的 CHANCE 边界，该动作必须保留在计划中，然后停止，不得丢弃。
- 若树未展开到交接，用同算法 rollout 策略补齐到交接，并单独记录 `treePlanLength`、`planExtended`、`extensionSteps`，避免把补全步骤冒充树证据。
- 计划绝不包含鼠动作；`planCost` 由 `mateActionCost` 求和。
- `proto/replay.ts` 使用真实引擎 `catMove` / `catPlaceTrap` 逐步回放；拒绝非猫动作、非法动作和无效动作，并记录 `fullTurnConsumed`、`endedTurn`、`terminal`、`rejectedAt`、`rejectedReason`。模拟器内部回放不作为验收依据。

### 2.7 RACE 对照臂

`proto/race.ts` 固定调用生产 `planHardCatTurn`：

```text
timeBudgetMs = 100
maxNodes = 500000
maxDepthTurns = 4
leafEvaluator = hybridEvaluateForCat
useTT / useAlphaBeta / useMoveOrdering = production defaults (true)
useThreatOrdering = false
maxThreatExtensions = 0
```

refutation sidecar 与 Progress Guard 关闭；与 UCT 臂共享同根、同引擎规则、同快照、同 100ms 主预算和 150ms 全回合门槛。

### 2.8 种子与进程隔离

- 每根每算法每重复的种子：`PPC-MCTS-01|<rootId>|<algorithm>|rep=<n>|h=<hash>`。
- CHANCE 与策略各自使用从该种子派生的独立流，且与游戏 WORLD、鼠策略 RNG 独立。
- `runPilot.mjs` 用 `spawnSync` 串行启动 20 个独立 `node` 进程；前一个进程退出后才启动下一个；无 `Promise.all`、无 worker pool、无后台并发。
- 每个进程内算法顺序按重复编号轮换：rep 1 `RACE,UCT-R,UCT-H`，rep 2 `UCT-R,UCT-H,RACE`，rep 3 `UCT-H,RACE,UCT-R`，循环。
- 打印 `TOTAL_JOBS=20`、`HEAVY_WORKER_CONCURRENCY=1`、`CURRENT_JOB=x/20`；每进程输出 JSONL 与原始日志。

---

## 3. 正确性验证

测试文件：`tests/mctsCorrectness.test.ts`，最终运行：

```bash
npx vitest run -c PPC-MCTS-01/vitest.config.mts
```

结果：**1 个测试文件、14 个测试全部通过，耗时 1.86s**（日志：`logs/tests-final.txt`）。

| # | 类别 | 验证内容 |
| --- | --- | --- |
| 01 | 普通猫移动 | 合法移动、步数递减、交接 |
| 02 | 推箱 | 引擎推箱结果与非法推箱拒绝 |
| 03 | 陷阱放置/回收 | 剩余陷阱数、回收语义（引擎返还为 1） |
| 04 | 鼠技能 | 技能消耗、移动预算与交接 |
| 05 | 传送出口 | 入口/出口选择与落点 |
| 06 | 鼠踩陷阱 | 捕获/终局语义 |
| 07 | RULE-A 双方 | 双方无合法空间移动均判负；幂等 |
| 08 | RULE-B 初始布局 | 24 根同源布局不变量、通道/鼠洞/箱子/杂物堆/角色/黄油距离 |
| 09 | 黄油拾取 | 幽灵公告、无候选时的 placement debt |
| 10 | 边界实体化 | materialize / delay / reroll / debt 组合 |
| 11 | 概率质量 | 非空、有限 >0、和为 1；加权采样；同种子可重现 |
| 12 | 状态循环 | 完整 stateKey；振荡状态在节点上限/截止时间内终止 |
| 13 | 完整猫回合计划 | 非空、成本正确、不含鼠动作 |
| 14 | 真实引擎回放 | UCT-H 计划逐步 `catMove`/`catPlaceTrap` 通过，鼠动作被拒绝 |

测试期间 UCT 运行同样处于 `withoutMathRandom()` 抛错守卫中。

---

## 4. 单进程集成 smoke（非正式结果）

`out/smoke-final.jsonl`：24 根 × 3 算法 = **72 次调用**。

- errors = 0
- mathRandomCalls = 0
- replayOk = 72/72
- replayFullTurnConsumed = 72/72
- planNonEmpty = 72/72
- planActionCost = 4（全部 72 个计划）
- withinFullTurnBudget（total ≤ 150ms）= 72/72

| 算法 | n | searchMs P50/P95/P99/MAX | planMs P50/P95/P99/MAX | totalMs P50/P95/P99/MAX | mean sims | mean chance | mean nodes | mean plan length |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RACE | 24 | 103.04 / 112.44 / 119.53 / 119.53 | 0.00 / 0.00 / 0.00 / 0.00 | 103.31 / 112.72 / 119.82 / 119.82 | — | 0 | 893.4 | 4.17 |
| UCT-R | 24 | 100.03 / 100.52 / 101.84 / 101.84 | 0.35 / 0.49 / 0.57 / 0.57 | 100.39 / 100.89 / 102.30 / 102.30 | 233.6 | 105.0 | 249.6 | 4.13 |
| UCT-H | 24 | 100.30 / 100.98 / 102.68 / 102.68 | 1.24 / 2.98 / 3.72 / 3.72 | 101.84 / 104.12 / 104.41 / 104.41 | 25.0 | 10.4 | 28.2 | 4.17 |

跨算法一致性（仅 smoke，不可作强度结论）：

- RACE vs UCT-R 根动作一致 9/24；RACE vs UCT-H 6/24；UCT-R vs UCT-H 9/24。
- 三算法根动作完全相同 4/24；三者互不相同 8/24。
- 任意两算法完整计划一致 0/24（计划包含同回合后续步骤，差异被放大）。

**计时警告**：该 smoke 不是正式计时实验，且运行环境存在外部 heavy 负载；RACE 的 `searchMs` 超过名义 100ms 是生产搜索检查粒度导致的，本轮未修改预算。上表只能证明链路可运行与预算门槛在当前实现下未被突破，不能用于算法速度或强度比较。

---

## 5. Pilot 阻塞记录

### 5.1 阻塞状态

```text
status   = PILOT_BLOCKED_BY_EXTERNAL_LOAD
decision = DO_NOT_START_HEAVY_PILOT
```

### 5.2 2026-11-16 13:05（UTC 05:05）复核证据

仍在运行的外部进程：

| PID | 进程 | 说明 |
| --- | --- | --- |
| 19772 | `node tools/ai-eval/reliability-final-run.mjs --confirmed-free ...` | 无关的 AI reliability 最终评测；CPU 15.03s → 16.42s，确认仍在推进 |
| 38904 | `node .local/ai-reliability-cont-20261115/review/run-v21.mjs` | 上述评测的父驱动 |
| 12576 | `next dev --hostname 127.0.0.1 --port 3255` | docmap-studio 开发服务器 |
| 25972 | `next start-server` | docmap-studio 服务进程 |
| 29808 | `codebuddy-headless.js` | docmap-studio 子进程 |

资源快照：

```text
FREE_PHYSICAL_MB = 2815
COMMIT_FREE_MB   = 8533
C:\pagefile.sys  allocated 2048 MB, current 1354 MB
E:\pagefile.sys  allocated 16087 MB, current 1457 MB
```

证据文件：`logs/preflight-process.txt`、`logs/preflight-memory.txt`、`logs/preflight-tasks.txt`、`logs/preflight-checkpoint.json`。

### 5.3 为什么不能启动

- 固定 100ms 主搜索与 150ms 全回合是计时敏感的；外部评测持续占用 CPU 会使 M1/M2 和分位数不可信。
- 任务明确要求在 heavy 任务前确认没有其他 heavy 任务同时运行；发现资源异常应停止扩张。
- 不允许通过降低 20 次重复、24 根、100/150ms 预算、14 项测试门槛或扩大 V8 heap 来绕过。

### 5.4 未产生的内容

- 未启动 `scripts/runPilot.mjs`。
- 未生成 `out/raw/rep-01.jsonl` … `rep-20.jsonl`。
- 未运行 `scripts/analyze.mjs`，因此没有 `data/per-root.json`、`data/summary.json`、`data/summary.csv`。
- 没有所谓“部分 pilot”或“降配 pilot”。

---

## 6. 复现与恢复流程

环境清空后按顺序执行，参数不得改动：

```bash
# 0) 预检：确认无外部 heavy 任务、无遗留 PPC 进程、RAM/pagefile 正常
#    记录 FREE_MB、commit、外部 PID CPU 是否仍在增长

# 1) 可选：重建 bundle（源码已变更时）
node PPC-MCTS-01/scripts/build.mjs

# 2) 串行 fresh-process pilot：20 进程 × 72 调用 = 1440 次
node PPC-MCTS-01/scripts/runPilot.mjs

# 3) 聚合分析：生成 per-root/summary JSON 与 CSV
node PPC-MCTS-01/scripts/analyze.mjs

# 4) 重新生成 SHA256 manifest（在全部产物落盘后）
node PPC-MCTS-01/scripts/manifest.mjs
```

验收检查：

- `runPilot.mjs` 日志出现 `TOTAL_JOBS=20`、`HEAVY_WORKER_CONCURRENCY=1`、`CURRENT_JOB=1/20 … 20/20`、`PILOT_ALL_JOBS_DONE=TRUE`。
- `out/raw/` 恰好 20 个 JSONL，共 1440 条记录，每 rep 24 根 × 3 算法。
- `analyze.mjs` 校验 error=0、mathRandom=0、replay 全通过、150ms 门槛统计完整。
- manifest 覆盖全部原始 JSONL、日志、summary 与报告。

---

## 7. 已知限制

1. **无正式强度证据**：24 根 pilot 本身只用于开发验证，不是正式胜率结论；当前连 pilot 都未运行。
2. **无跨重复稳定性数据**：只有单进程 smoke，不能评估 seed/进程间波动。
3. **RACE 与 UCT 的搜索形态不同**：RACE 是迭代加深 expectiminimax，UCT 是逐步随机树；根动作/计划一致率只作描述，不作优劣裁决。
4. **计划补全**：树未展开到交接时使用 rollout 策略补齐；已用 `planExtended` / `extensionSteps` 显式标记，分析时应分层报告“纯树计划”和“补全计划”。
5. **外部条件**：任何重新运行都必须重新做资源预检；本轮外部负载的具体结束时间未知。
6. **工作区状态**：HEAD 为 `48eaac6c`，工作区存在更早轮次遗留的 `src/` 修改；本轮未修改 `src/`，MANIFEST 固定实际运行内容，正式报告应同时披露这一状态。

---

## 8. 下一阶段 1700 组独立正式对抗实验预注册建议

> 以下是**建议稿**，不是已生效合同；实验语义、预算、门槛与 PASS/FAIL 由 ChatGPT 裁决。

### 8.1 独立性

- 必须使用**全新独立样本**，不得复用 Formal V2 历史 1700 组，也不得把本轮 24 根 pilot 根计入正式样本。
- 正式 cohort 在运行前冻结为单一 JSON/JSONL，记录来源、筛选规则、SHA256；运行后不得增删或替换根。
- 若根状态来自人类对局重建，必须保留来源文件、行号、重建脚本与 SHA；排除规则在见到结果前锁定。

### 8.2 设计选项（待裁决）

**方案 A：单回合配对根基准（与当前 harness 最接近）**

- 1700 个猫行动根，每根 3 臂（RACE / UCT-R / UCT-H）配对。
- 每臂每根固定重复次数 R（建议 5 或 10，需合同确认），每重复使用预注册种子。
- 主要终点：计划合法率、完整回合率、真实引擎回放通过率、根动作跨重复众数稳定率、150ms 内完成率；次要终点：P50/P95/P99 时间、节点/模拟数、计划成本分布。
- 若要做“对抗”胜负，需要额外定义固定鼠策略与续局规则；当前 harness 不含完整对局，必须新建独立 harness，不能拿单回合计划冒充胜率。

**方案 B：完整对局对抗**

- 1700 组新开局/新种子，每组 3 臂分别对冻结鼠 AI 完整对局；配对共享开局与随机流。
- 主要终点：猫胜率（配对差）、对局长度、非法动作/超时率；次要终点：搜索时间分位数、计划质量。
- 需要新的对局驱动、鼠 AI 固定版本、终局/和棋规则与重赛规则；成本显著高于方案 A。

### 8.3 运行隔离与顺序

- 继续使用独立 fresh Node 进程；建议按块串行，块大小与重复数写入合同。
- 臂顺序按块轮换；禁止并发；每块前后记录资源快照。
- 任何资源异常：整块作废并记录，不允许只补跑“看起来慢”的样本。
- 固定 `HEAVY_WORKER_CONCURRENCY=1`，打印 job 编号与算法顺序。

### 8.4 预注册分析

- 固定样本量，不做 optional stopping；失败重跑规则仅在运行前定义。
- 配对比较：根动作一致率用 McNemar；连续指标用配对 bootstrap 置信区间；三组两两比较做 Holm 校正。
- 稳定性：按重复计算众数率、跨重复标准差、进程间离群块。
- 分层报告：纯树计划 vs 补全计划；含 CHANCE 根 vs 确定性根；不同根来源分层。
- 同时报告效应量与置信区间，不只报 p 值。

### 8.5 强制披露

- 历史 1700 组仅作为历史结果引用，不得与新样本合并。
- 新 cohort SHA、代码 HEAD、`GAMEPLAY.md` SHA、fixture SHA、臂配置 SHA、种子派生规则、预算、排除清单、失败清单全部进入 manifest。
- 若正式实验前代码或规则有任何变更，必须重新冻结并重新预注册。

---

## 9. 最终裁决（本轮）

| 层级 | 状态 |
| --- | --- |
| 已实现 | UCT-R / UCT-H、显式 CHANCE、UCB1、计划提取、RACE 臂、真实引擎回放、串行 pilot 驱动、分析脚本、manifest |
| 已通过正确性验证 | 14/14 测试通过（最终 1.86s） |
| 已完成固定预算测试 | 仅单进程 72 次集成 smoke；正式 20 进程 × 1440 次 pilot **未运行** |
| 已获得正式对抗强度证据 | **没有**；不得从 smoke 或 24 根开发样本推断算法强弱 |

**阻塞原因**：外部 `ai-reliability` 最终评测与 docmap-studio 服务持续运行，固定 100/150ms 计时会被污染。按安全规则停止，已保存证据与 checkpoint；环境清空后按第 6 节原参数恢复。
