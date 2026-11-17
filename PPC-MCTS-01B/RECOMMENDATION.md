# PPC-MCTS-01B-PHASE0｜建议与预注册

**本文件不执行任何实验。** 全部内容为"若复核通过则可以做什么"与"做的时候必须守住什么"。

---

## 1. 裁决

| 项目 | 裁决 | 依据 |
| --- | --- | --- |
| Prepared Transition **语义等价性** | **PASS** | 9 523 状态 / 41 566 候选 / 31 391 确定性转移 / 1 032 CHANCE 转移（14 953 outcome）逐字段零差异（`PREPARED_TRANSITION_CONTRACT_AUDIT.md` §4） |
| Prepared Transition **复用安全性** | **PASS（有条件）** | 转移与输入共享可变对象，安全依赖 copy-on-write 纪律而非机制；`sanitizeItemOverlaps` 是唯一可破坏纯性的路径（`STATE_IMMUTABILITY_AND_CHANCE_AUDIT.md` §1、§5） |
| **随机数语义** | **PASS** | `policyRng`/`chanceRng` 的消费点与消费次数由"值"和"顺序"决定，两者复用后不变；采样域内 `Math.random` 触发 0 次 |
| **CHANCE 语义（全 outcome + 原权重）** | **PASS** | 基数/顺序/权重/逐 outcome 状态全等；引导加权遍历全部正概率结果 |
| **收益规模** | 规则调用 **−38.77 %**（hybrid −53.91 % / random −20.92 %）；**墙钟收益未测、不得外推** | `CALLSITE_REUSE_MATRIX.md` §3 |
| **是否可进入 01B-IMPLEMENTATION** | **建议 GO**，但受 R1–R7 与 §2 的验收 gate 约束 | — |

**一句话**：可以改，但改法必须是"只搬家、不变化学反应"——把已经付过钱的转移搬过去用，不许为了省钱删掉 Hybrid 评价、CHANCE 分支或计划补全。

---

## 2. 落地必须满足的 7 条（R1–R7）

| 编号 | 约束 | 违反后果 | 验收方式 |
| --- | --- | --- | --- |
| **R1** | 转移保持 `(state, action) → transition` 纯函数；复用只在单线程同步搜索内进行（不得跨 worker，不得在评价内部重入） | `hybridLeaf` 模块级 scratch 被踩；转移不再可复现 | 搜索期 `Math.random` 计数必须仍为 0；`hybridLeaf.ts:54-57` 的前提不得放宽 |
| **R2** | prepared 批次**节点局部、用完即弃**，不得挂到 `UctNode` 上跨 simulation 留存 | 每节点多保活 `C` 个后继状态（10×10 棋盘约 5 KB/状态），500 000 节点上限下不可接受；且引入跨节点别名 | 实现后检查 `UctNode` 上**没有**新增持有批次的字段 |
| **R3** | 批次与转移一律**只读**。`samples`/`visitCount`/`child` 只能写在包装对象上 | 记账污染会穿透所有共享该转移的消费者 | 保留 `makeChanceNode` 现有写法；不得在 outcome 上写字段 |
| **R4** | 把 `applyEdge:462-465` 的 `illegal no-op edge reached the tree` 断言的**交叉验证能力**降级为测试期 gate，不得直接删除 | 失去"两次模拟互相复核"这一安全性网；`sanitizeItemOverlaps` 若真被触发将无人发现 | 新增 parity gate：固定根集合上比较"复用转移"与"现算转移"的 `gameAffectingEqual` + 全序列化 |
| **R5** | `guidanceValue` 的 CHANCE 分支必须遍历**全部正概率 outcome**、保留**原有权重**；不得抽样、不得 top-k 截断、不得改权重 | 直接改变引导值 → 改变并列集合 → 改变 `policyRng` 消费 → 搜索路径漂移 | 复用前后 `guidanceValue` 逐状态逐动作数值完全相同 |
| **R6** | 计划补全的 `extensionSteps`/`planExtended` 计量、以及"CHANCE 结果保留该动作并在交接处结束计划"的语义原样保留 | 混淆"树证据"与"启发式补全"（Pilot 的核心发现就是 92.1 % 靠补全） | 固定 root + 固定 seed 下 `treePlanLength`/`extensionSteps` 不变 |
| **R7** | 隧道出口继续模拟可以接受（PT-B-1），但必须改正 `preparedActions.ts:29-30` 的措辞 | 下一轮会把"legacy 也从不模拟隧道出口"当成既有事实引用，误判成本 | 注释与实测一致 |

### 2.1 固定的验收 gate（实现轮必须全绿才算完成）

| Gate | 内容 | 判据 |
| --- | --- | --- |
| G-1 枚举 | 24 根 + 手构特例上，`prepared` 与 `legacy two-step` 的**动作集合、顺序、`originalIndex`** 全等 | 0 差异 |
| G-2 转移 | 确定性转移的 `stateKey` + `gameAffectingEqual` + **全序列化（含日志）** 全等 | 0 差异 |
| G-3 CHANCE | 基数、**顺序**、**权重**、逐 outcome 状态全等；`|Σw−1| ≤ 1e-9` | 0 差异 |
| G-4 不变性 | 生成+消费后输入状态逐字节不变；转移的重复读稳定 | 0 差异 |
| G-5 确定性 | 搜索期 `Math.random` 调用数 = 0；`trapPosition ∈ butterPositions` 状态数 = 0 | 必须为 0 |
| G-6 固定 simulation parity | 固定 simulation 数下，两臂的**搜索路径、随机事件序列、逐节点动作、叶评价值**逐项相同 | 出现非预期差异即**停止** |
| G-7 预算语义 | 100 ms 主搜索 / 150 ms 全回合 / `maxHandoffs=4` / `maxNodes` / UCB1 / c=√2 **一个都不许改** | 配置 diff 为空 |

---

## 3. 收益的诚实表述

| 命题 | 状态 |
| --- | --- |
| 规则内核调用减少 **38.77 %**（148 275 → 90 784，固定节点 300 × 8 次运行） | **实测** |
| UCT-H 单独减少 **53.91 %**；UCT-R 单独减少 **20.92 %** | **实测** |
| 树展开组减少 **33.93 %**；Rollout 组减少 **39.01 %** | **实测** |
| 墙钟同步减少 38.77 % | **不成立，且不得这样写**。[01A] 测得 UCT-H 每 simulation ≈3.161 ms CPU、其中 ≈33.8 次叶评价（≈93 µs/次），叶评价几乎吃掉全部 CPU；被删掉的是转移重算，不是叶评价 |
| 固定 100 ms 内 simulation 数上升 **10 %–30 %** | **[假设]**。锚点：P2 轮在 Expectiminimax 固定 D1 上"规则转移约占墙钟 18–19 %，去掉其中 46 % ⇒ 快 8.5 %"；UCT-H 每 rollout 步 ≈8.5 次转移 vs ≈3.96 次叶评价，比例结构不同，**必须实测** |
| 决策会变好 | **未证明，也不该由 01B 证明**。Pilot 已写死：不能拿根动作一致率、节点数、计划差异当强度证据 |

---

## 4. 预注册实验（PPC-MCTS-01B-IMPLEMENTATION，**不执行**）

> 本节仅为登记。**必须先经 ChatGPT 复核**，复核通过后才可启动。

### 4.1 对照臂

| 臂 | 定义 |
| --- | --- |
| `UCT-H-BASELINE` | `PPC-MCTS-01/proto/uct.ts` 原样（`generateLegalSearchActions` + 逐步重模拟） |
| `UCT-H-PREPARED` | 唯一差异：三个调用点改为复用 prepared 转移。算法/预算/评价/CHANCE/计划提取**一字不改** |

### 4.2 规模（预注册，不许缩水也不许放大）

```text
ROOTS                       = 24（沿 PPC-MCTS-01 冻结 fixture，SHA256 1a59787a…）
REPETITIONS                 = 20
ARMS                        = 2
SEARCH_CALLS                = 24 × 20 × 2 = 960
FRESH_NODE_PROCESSES        = 20
HEAVY_WORKER_CONCURRENCY    = 1
SERIAL_FRESH_REPETITIONS    = TRUE
DUPLICATE_BENCHMARK_CHECK   = REQUIRED（启动前查进程表 + 查 out/raw 是否已有部分结果）
RESOURCE_SAFETY             = REQUIRED（启动前记录可用内存/已提交/pagefile/CPU 采样）
```

两臂**必须**使用相同的 root 与对应的相同 seed（`uctSeed(rootId, 'UCT-H', repetition)`）。

### 4.3 两阶段，顺序不可交换

**阶段 1：固定 simulation 数下的语义 parity（先做）**

- 用 `maxNodes` / 固定 simulation 上限替代墙钟（`now: () => 0`），两臂跑同一个固定工作量。
- 记录并逐项比对：每次 simulation 的节点路径、`chanceRng` 抽样序列、`policyRng` 抽样序列、逐节点选中的动作、逐叶评价值。
- **判据**：全部逐项相同 ⇒ 进入阶段 2。**任一非预期差异 ⇒ 立即停止**，按"correctness failure"处理，不得继续。
- 允许的差异只有：`elapsedMs` 等纯计时字段。

**阶段 2：100 ms 固定预算下的性能比较（后做）**

- 恢复生产语义：`deadlineMs=100`、`maxHandoffs=4`、`maxNodes=500000`、`c=√2`。
- 记录：`simulations`、`nodesCreated`、`rolloutSteps`、`treePlanLength`、`extensionSteps`、`planLength`、`rootAction`、`rootActionStats`、`searchMs`、`totalMs`、`withinFullTurnBudget`、`replayOk`。
- **判据**：
  - 正确性维度：回放 960/960 成功、`error=0`、`Math.random=0`、全部计划可被真实引擎执行。
  - 性能维度：报告 `simulations` 的中位数与分布变化、`searchMs` 的 P50/P95/P99。
  - **`simulations` 数变化、`rootAction` 变化、计划长度变化，都属性能实验结果，不得判为 correctness failure**（任务书 §8 明确要求）。

### 4.4 明确不做的

- 不做 self-play，不做胜率，不做强度裁决。
- 不做 1700 组 Formal V2。
- 不改 100 ms / 150 ms / `maxHandoffs` / `maxNodes` / UCB1 / c。
- 不改 `GAMEPLAY.md`、不改合法动作集合与顺序、不改 Hybrid 评价函数。
- 不接入生产 Hard AI（`hardTurnPlanner` / `expectiminimax` 的现有 prepared 用法保持原样）。
- 不 commit / push / merge。

---

## 5. 停止条件

| 触发 | 动作 |
| --- | --- |
| 阶段 1 出现任何**非预期**路径/随机/动作/评价差异 | 立即停止，冻结现场，按 correctness failure 报告 |
| 阶段 2 出现 `replayOk=false` / `error>0` / `Math.random>0` | 立即停止，同上 |
| 阶段 2 出现超时/内存压力（可用内存 < 1 GB、`Pages Output/sec > 0` 持续） | 暂停，记录为环境离群，不删样本、不重跑"看起来慢"的那一条 |
| 发现 `trapPosition ∈ butterPositions` 状态进入搜索 | 立即停止（G-5 违约），转规则层处置 |
| 任何需要"为了收益而降低 Hybrid 评价或 CHANCE 分支"的改动 | 直接否决，不进实验 |

---

## 6. 若复核想缩小范围：最小可行版本

若认为 960 次调用过重，最小可行替代（**仍需复核**）：

```text
ROOTS = 6（G6T1, G1T1, G2T6, G5T4 + 2 个带幽灵/债务的根）
REPETITIONS = 10
ARMS = 2
SEARCH_CALLS = 120
FRESH_NODE_PROCESSES = 10
```

但阶段 1（固定 simulation parity）**不可省**，也不可缩到 1 个根——它才是复用正确性的唯一直接证据。

---

## 7. 本轮结束状态

- 只读审计完成，六份交付物齐备。
- 未修改 `src/`、`GAMEPLAY.md`、`PPC-MCTS-01/`、UCT-R/UCT-H。
- 未 commit / push / merge。
- **未启动任何 benchmark、self-play、1700 组实验、fresh-process 大跑。**
- 等待 ChatGPT 复核后才考虑 `PPC-MCTS-01B-IMPLEMENTATION`。
