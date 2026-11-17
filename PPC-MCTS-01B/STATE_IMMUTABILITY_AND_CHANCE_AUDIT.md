# PPC-MCTS-01B-PHASE0｜状态不变性与 CHANCE 审计

对应任务书 §3 的 Q8 / Q9 / Q10 / Q7，以及 §4 中"CHANCE outcome 顺序"一列的全部依据。

**结论先行**：prepared 转移**确实**与其输入状态共享可变对象（Q8 = 是），但当前**没有**任何代码在复用路径上写它（Q9 = 否，Q10 = 否）。安全性来自引擎的 copy-on-write 纪律，**不是**来自类型系统或运行时保护。这是本轮最重要的"条件性通过"。

---

## 1. Q8：prepared transition 持有可变对象引用（是）

### 1.1 实测

对 31 391 个确定性转移，逐个比较"输入状态"与"prepared 转移状态"的**引用同一性**（`a === b`，只统计引用类型字段）：

| 字段 | 共享引用的转移数 | 占比 | 含义 |
| --- | ---: | ---: | --- |
| `config` | 31 391 | 100.0 % | 配置对象从不复制 |
| `butterPositions`（数组本身） | 31 391 | 100.0 % | 未发生黄油变化的转移共享同一数组 |
| `pendingButterSpawns`（数组本身） | 31 391 | 100.0 % | 同上 |
| `blockedTunnels` | 31 389 | 99.99 % | 同上 |
| `butterPositions[]`（元素） | 31 337 | 99.83 % | 元素 `{r,c}` 对象也被共享 |
| `trapPosition`（非 null 时） | 27 968 | 89.1 % | 陷阱位置对象被共享 |
| `catPosition` / `mousePosition` | 26 215 / 8 911 | 83.5 % / 28.4 % | 未移动的一方共享位置对象 |
| `catActionLog` | 26 080 | 83.1 % | 调试日志数组被共享 |
| `tunnelExitChoices` | 24 231 | 77.2 % | 出口候选数组被共享 |
| `gameEventLog` | 21 079 | 67.2 % | 同上 |
| `pendingButterSpawns[]`（元素） | 5 336 | 17.0 % | 幽灵对象被共享 |
| **`board` 与 `board[]`（行数组）** | **3 735** | **11.9 %** | 棋盘**整块**被共享（转移没动地形） |

（数据：`data/parity.json` → `aliasing.byField`；样例见 `aliasing.examples`。）

### 1.2 这意味着什么

- prepared 转移**不是**自包含快照。它是一份"差量状态"，其余部分指回输入对象。
- 因此 `PreparedSearchAction.transition` 的注释（`preparedActions.ts:93-99`："this object is a private snapshot of this node: it may be read by the subtree, **never written**"）**在事实层面是准确的免责声明，但不是强制约束**。
- 3 735 例连 `board` 和行数组都共享，是最危险的一档：任何一个 `state.board[r][c].piece = …` 都会**同时**改写输入状态和其它所有共享同一 board 的转移。

### 1.3 为什么当前是安全的（copy-on-write 纪律）

| 保护 | 证据 |
| --- | --- |
| 棋盘写入一律先深拷贝 | `engine.ts:297-299` `cloneBoard` = `board.map(row => row.map(cell => ({...cell})))`；调用点 `701`、`723`、`739`、`965`、`982`、`2355` —— **每一处改地形的转移都先 clone** |
| 没有原地写 cell 属性 | `grep -n "\.hasButter = \|\.type = \|\.piece = " src/game/engine.ts` → **0 命中** |
| 没有原地改状态数组 | `grep` 状态字段上的 `push/splice/pop/shift/sort/reverse` → `src/game` 内 **0 命中**（唯一命中在测试文件对自身 clone 的操作） |
| 日志是复制后追加 | `engine.ts:205-209` `logEvent` 用 `[...(state.gameEventLog||[]), msg]`，200 条上限的 `shift()` 作用在**副本**上 |
| 集合字段一律新建数组 | `mouseSkill:891` 显式重挂 `blockedTunnels: s.blockedTunnels`（共享而非新建，但从不写）；`sanitizeItemOverlaps:517` `[...state.butterPositions]` 后 `splice` |

**结论**：共享是"不可变数据的结构性共享"，与持久化数据结构的做法一致。安全性成立，但**是约定，不是机制**。

---

## 2. Q9：评价不会改 transition 状态（否）

### 2.1 源码

| 函数 | 是否写状态 | 依据 |
| --- | --- | --- |
| `evaluateForCat`（`evaluation.ts`） | **否**。构造**新的**特征对象字面量（`evaluation.ts:600-640`，`mouseHasButter: state.mouseHasButter` 等均为读取后赋值给新对象） | 全文无 `state.x = …` 形态赋值（grep 0 命中） |
| `hybridEvaluateForCat`（`hybridLeaf.ts:214-225`） | **否**。写入的是**模块级 scratch**：`feat`/`nz`/`h1`/`h2`（`hybridLeaf.ts:58-62`）、`buildProductionFeatures` 里的 `feat.fill(0)` | 只读 state，只写 scratch |
| `productionValueNet` | **否**，同上 | — |
| `stateKey`（`transposition.ts:81-104`） | **否**，纯读字符串拼接 | — |
| `gameAffectingEqual`（`stateCompare.ts:98-128`） | **否**，纯读比较 | — |
| `terminalReward`（`proto/value.ts`） | **否** | — |

### 2.2 实测

对每个转移（确定性 31 391 + CHANCE 1 032，后者逐 outcome 评价），先做全序列化快照，再依次执行 `evaluateForCat` → `hybridEvaluateForCat` → 3×`stateKey` → `gameAffectingEqual`，再比快照：

```
evaluationStability.stable   = 32 423
evaluationStability.unstable = []          （0 例）
```

### 2.3 一条必须写下来的隐含约束

`hybridLeaf.ts` 的 scratch 是**模块级全局**，注释明说"PRODUCTION search is synchronous, single-threaded (no workers / no nested evaluator), so this is safe"（`hybridLeaf.ts:54-57`）。

- 一旦将来出现**并发**（worker）或**重入**（在评价内部再次触发评价），scratch 会被踩。
- 这与 prepared 转移无关，但**如果实现轮为了省成本把 prepared 批次跨线程共享**，就会同时踩到这个坑。故 R1 明确要求：复用只在单线程同步搜索内。

---

## 3. Q10：重复使用同一 prepared 转移不影响后续模拟（否）

三条子命题，逐条实测：

| 子命题 | 方法 | 结果 |
| --- | --- | --- |
| 重复读取稳定 | 同一转移连续 `stateKey` 3 次 | 31 391 / 31 391 全同（`reuseReadStability.unstable = []`） |
| 使用后输入不被污染 | 生成批次 → 逐动作现算 fresh 转移 → 全部评价与序列化 → **最后**再比对输入状态 | 9 523 / 9 523 逐字节相同（`mismatches` 中无 `input-mutated`） |
| 再次模拟结果不变 | 同一 `(state, action)` 的 fresh 模拟 vs 批次里的转移 | 31 391 确定性 + 1 032 CHANCE 全等（Q3/Q7） |

**顺序很重要**：第三条的 fresh 模拟是在 prepared 批次**已经被生产、被评价、被序列化之后**才做的。所以它证明的是"批次的存在与消费都不会让后续模拟漂移"，而不是"两次模拟刚好都一样"。

### 3.1 复用**不**等于自由

允许：多个消费者**读**同一转移（guidance 读、执行读、序列化读）。

不允许（会立刻破坏上面的结论）：

1. 在转移或 `outcomes` 元素上写 per-visit 记账（`samples`、`visitCount`、`child`）。必须写在包装对象上——`makeChanceNode:179-184` 现在就是这么做的，`oc.samples++`（`uct.ts:388`）改的是包装。
2. 把批次当缓存跨节点共享。那会引入"同一 `stateKey` 不同来源"的别名问题，且与 `uct.ts` 现有的"keys 只在单条 simulation 内有效"（`uct.ts:361`、`530`）不一致。
3. 在批次上做排序/过滤后**原地**留下修改（`sort`/`splice` 会改数组本身）。

---

## 4. CHANCE 全链路不变性

任务书特别点名："UCT-H guidance 对 CHANCE 候选会对全部 outcome 进行 Hybrid 评价。任何优化都必须保留全部正概率结果及原有概率权重。" 逐环节核对：

| 环节 | 位置 | 语义 | 复用会改变吗 |
| --- | --- | --- | --- |
| 1. 吃黄油 → 枚举 spawn | `simulator.ts:63-72` → `simulator.ts:166-182`（默认）或 `searchRules.buildButterChance` | 对 `enumerateButterSpawns` 的**枚举顺序**赋均匀 `1/N`；候选为空时退化为 `debt+1` 的**单个确定性 outcome**（权重 1），义务不丢失 | **不会**。复用不改构造，只改"谁持有" |
| 2. CAT→MOUSE 幽灵/债务边界 | `simulator.ts:121-130` → `rules.resolveGhostBoundaryChance` | 共享纯核 `resolveGhostBoundaryCore`；随机部分对"合法格的不重复指派"全枚举，均匀 `1/C(n,k)`；返回空/缺失**直接抛错**，绝不回落 `Math.random` | **不会** |
| 3. 校验 | `chance.ts:34-56` | 非空、每个权重有限且 `>0`、`|Σw−1| ≤ 1e-9`；违规**硬抛**，不修复、不回落 | **不会**。`validateChance` 做 `outcomes.slice()`（浅拷贝、保序、保元素引用） |
| 4. 抽样 | `chance.ts:66-68` → `seededRng.ts:74-83` | 按数组顺序累加权重，第一个 `u < acc` 的落下 | **不会**。序与权重不变 ⇒ 同 `u` 得同下标 |
| 5. 建树内 CHANCE 节点 | `uct.ts:168-190` | 按顺序把 outcome 包成 `{state, weight, samples:0, child:null}` | **不会**（前提：传入同一数组、同一顺序） |
| 6. 引导加权期望 | `uct.ts:216-219` | `Σ w_i · evaluateLeaf(outcome_i)`，**遍历全部**，不截断 | **不会**（前提：R5） |

### 4.1 实测

| 检查 | 规模 | 结果 |
| --- | --- | --- |
| CHANCE 转移数 | **1 032** | — |
| outcome 总数 | **14 953** | — |
| 基数一致 | 1 032 对 | 0 失配 |
| 顺序一致（`stateKey` 序列） | 1 032 对 | 0 失配 |
| 权重序列一致 | 1 032 对 | 0 失配 |
| `|Σw − 1| > 1e-9` | 1 032 | 0 例 |
| 存在 `w ≤ 0` 或非有限 | 14 953 | 0 例 |
| 逐 outcome `gameAffectingEqual` | 14 953 | 0 失配 |
| 逐 outcome 全序列化 | 14 953 | 0 失配 |
| 按动作类型 | `catStep` 597（幽灵/债务边界）+ `mouseStep` 435（吃黄油） | 两类覆盖齐 |

---

## 5. 唯一的随机源风险：`sanitizeItemOverlaps` → `worldRuntimeRandom`

这是本轮**唯一**找到的、能让"转移不是纯函数"的路径，必须单独记录。

### 5.1 链路

```
rules.catMove(state, dir)                       simulator.ts:46
  └─ engine.catMove(state, dir)                 engine.ts:908
       └─ state = sanitizeItemOverlaps(state)   engine.ts:909
            └─ if (trapPosition 与某个 butter 同格)   engine.ts:508-512
                 └─ generateSingleButterPosition(...)  engine.ts:521
                      └─ worldRuntimeRandom(context)   engine.ts:498
                           └─ worldEntropySource === null ? Math.random() : source(context)   engine.ts:97-99
```

### 5.2 影响面

| 结论 | 依据 |
| --- | --- |
| 只有 `catMove` 受影响（搜索用到的 5 个动作里） | `sanitizeItemOverlaps` 仅出现在 `engine.ts:820`（`mouseMove`，搜索不走它）、`909`（`catMove`）、`3913`（`catAiMove`）。`mouseStepDeterministic`（`876`）走 `applyMouseStepCore`，**不经过** sanitize |
| 触发条件极窄 | 必须 `trapPosition` 恰好与某个 `butterPositions` 元素同格 |
| 采样域内**未触发** | 9 523 个语料状态中 **0** 例（`parity.json.trapButterOverlapStates = []`） |
| 结构上基本不可达 | 猫不能走上黄油格（`GAMEPLAY.md` §4.1），陷阱放在猫自己的格子上；黄油生成把 `trapPos` 作为排除项传给 `enumerateButterSpawns`；幽灵实体化遇陷阱占用会延迟/换位而非占格（`GAMEPLAY.md` §9.4） |

### 5.3 但如果它真的触发了

- 现状：同一个 `catMove` 被模拟两次会得到**不同**结果（各消费一次 `Math.random`）。uct 的 `applyEdge:462-465` 的 `illegal no-op edge reached the tree` 断言正是这种情况的兜底。
- 复用后：只模拟一次，"两次一致"从**被检验的性质**变成**被假设的性质**。
- 也就是说：**复用不是引入风险，而是把一个隐性检查拿掉了。**

### 5.4 处置建议（写入 R4）

1. 实现轮不得删除 `applyEdge` 的 no-op 断言，而是把它移进**测试期**的 parity gate：对固定根集合，比较"复用转移"与"现算转移"的 `gameAffectingEqual` + 全序列化。
2. 另加一条更根本的**搜索域不变量**：搜索路径上出现 `trapPosition ∈ butterPositions` 的状态即视为**规则层违约**，显式抛错（fail-closed），而不是让它静默抽一次 `Math.random`。这一条超出 01B 授权范围，仅登记。

---

## 6. 残留风险清单

| 编号 | 风险 | 当前状态 | 触发条件 | 处置 |
| --- | --- | --- | --- | --- |
| **IM-1** | 转移与输入共享 `board`/行数组（3 735 例） | 安全，靠 copy-on-write | 任何新增的原地 cell 写入 | 保持 `cloneBoard` 纪律；不要新增原地写 |
| **IM-2** | 共享 `butterPositions`/`blockedTunnels`/`tunnelExitChoices` 数组 | 安全，从不原地改 | 任何 `push/splice/sort` 原地调用 | 同上 |
| **IM-3** | `hybridLeaf` 模块级 scratch 不可重入 | 安全，单线程同步 | worker / 嵌套评价 | 复用只在单线程内（R1） |
| **IM-4** | `sanitizeItemOverlaps` 可消费 `Math.random` | 采样域内未触发（0/9 523） | trap 与 butter 同格 | 测试期 parity gate + 域内不变量（R4） |
| **IM-5** | 批次跨节点留存会导致内存与别名双风险 | 尚未实现，未发生 | 把批次挂到 `UctNode` 上 | R2：节点局部、用完即弃 |

---

## 7. 数据出处

| 数字 | 文件 | 字段 |
| --- | --- | --- |
| 31 391 / 1 032 / 14 953 / 9 523 / 41 566 | `data/parity.json` | `totals` |
| 别名分字段计数 | `data/parity.json` | `aliasing.byField` |
| 评价稳定性 32 423 / 0 | `data/parity.json` | `evaluationStability` |
| 复用读稳定性 31 391 / 0 | `data/parity.json` | `reuseReadStability` |
| trap∧butter 重叠 0 例 | `data/parity.json` | `trapButterOverlapStates` |
| CHANCE 分布（597 / 435） | `data/parity.json` | `totals.chanceByAction` |
