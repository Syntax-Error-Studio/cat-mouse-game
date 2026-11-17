# PPC-MCTS-01B-PHASE0｜Prepared Transition 合同审计

| 项 | 值 |
| --- | --- |
| 轮次 | `PPC-MCTS-01B-PHASE0`（只读审计，无实现、无 benchmark） |
| 日期 | 2026-11-16 |
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8` |
| 分支 | `ppc/p1-id-state-identity-fix` |
| 规则权威 | `GAMEPLAY.md` SHA256 `e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34` |
| 审计对象 | `src/game/ai/preparedActions.ts`、`src/game/ai/legalActions.ts`、`src/game/ai/simulator.ts`、`PPC-MCTS-01/proto/uct.ts` |
| 改动 | **零**。`src/`、`GAMEPLAY.md`、`PPC-MCTS-01/` 一字未改；新增文件全部在 `PPC-MCTS-01B/` 内 |

---

## 0. 一句话结论

**`generatePreparedSearchActions` 与 `generateLegalSearchActions` + 二次模拟这一对"两步舞"在 9 523 个真实状态、41 566 个候选动作、31 391 个确定性转移、1 032 个 CHANCE 转移（14 953 个 outcome）上逐字段全等，0 处差异；复用语义在"只读"前提下安全。但有三条必须写进实现合同的偏差/风险：隧道出口会被多模拟一次、RULE-A 会让"候选数 ≠ 模拟数"、以及 prepared 转移与输入状态共享可变对象引用（当前依赖 copy-on-write 纪律，无代码级强制）。**

在固定节点数（300）而不是墙钟的确定性工作负载下，`uct.ts` 的规则调用有 **38.77 %** 是同一 `(state, action)` 的重复模拟，且 **100 % 可归因到具体调用点**（未归因 = 0）。

---

## 1. 证据分级

本轮沿用任务的四类标签，并把本轮新增的只读探针单列：

| 标签 | 含义 |
| --- | --- |
| **[源码]** | 直接读代码确认（给出行号） |
| **[测试]** | 仓库内既有测试确认（本轮复跑，给出日志） |
| **[探针]** | 本轮新增只读探针确认（`PPC-MCTS-01B/probe/`，可复现、确定性、三次运行逐字节一致）。归入"测试直接确认"一档 |
| **[推导]** | 由源码 + 数值统计推出的结论，非直接观测 |
| **[假设]** | 尚未验证，明确标注 |

---

## 2. 基线核对（任务书 §2 要求的六项）

| 核对项 | 结果 | 证据 |
| --- | --- | --- |
| HEAD | `48eaac6c…` ✅ 与任务书一致 | `git rev-parse HEAD` |
| 分支 | `ppc/p1-id-state-identity-fix` ✅ | `git rev-parse --abbrev-ref HEAD` |
| 工作树既有修改 | **15 个已跟踪文件被修改，全部在 `src/game/**` 下**；审计开始时另有 **52 条未跟踪条目**（含 `preparedActions.ts`、24 根 fixture、21 个既有 PPC 目录）。**本轮未 stash / reset / checkout / cleanup 任何一项** | `git status --porcelain=v1`：审计开始 **67** 行 → 结束 **69** 行 |
| `preparedActions.ts` 的 git 身份 | **未跟踪**（`git ls-files` 不认）。它属于 `PPC-P2-PREPARED-TRANSITION-01` 的产物，不在 HEAD 里 | `git ls-files --error-unmatch` → `did not match any file(s) known to git` |
| 原始 Pilot 的 20 个 repetition | 齐全：`PPC-MCTS-01/out/raw/rep-01..20.jsonl`，`MANIFEST.json`/`PILOT_COMPLETION_REPORT.md` 均在，未被本轮触碰 | `ls PPC-MCTS-01/out/raw` |
| 其他 PPC benchmark 是否在跑 | **预检时刻没有**。node 进程 6 个，常驻 10–20 MB、CPU < 2 s，全部是编辑器/助手侧进程；无 `runPilot.mjs` / `bench.mjs` / 长跑 vitest | `Get-Process node` |
| 是否已存在重复的 01B 任务 | **没有**。`git status` 的未跟踪清单里没有 `PPC-MCTS-01B/`；本目录由本轮新建 | `git status` + `ls -d PPC-*` |

### 2.1 必须披露：审计窗口内工作树多了两条未跟踪条目

| 条目 | 来源 | 处置 |
| --- | --- | --- |
| `PPC-MCTS-01B/` | **本轮创建**（交付目录、探针、数据） | 预期内 |
| `PPC-D2-PCV-COUNTERLINE-01/`（`D2_SEARCH_CONTRACT.md`、`PHASE_STATUS.json`，mtime 17:11–17:13） | **不是本轮产物**，是同一工作区的**兄弟轮**（D2 方向）写入的。同日工作日志（`.workbuddy/memory/2026-11-16.md`）记载：该轮按其资源准入规则**停跑**，并把本轮的 `probe/vitest` 进程记为并发观察对象 | **未读、未改、未删、未杀**。它不触及 `src/`、`GAMEPLAY.md`、`PPC-MCTS-01/`，不影响本轮结论。本轮的两个探针是单进程、`maxWorkers=1`、分 6 次一次性运行、累计约 8 分钟，属 `HEAVY_WORKER_CONCURRENCY=1` 范围，但**确实与兄弟轮的时间窗重叠**，此处如实记录 |

因此"审计前后工作树一一对应"这一说法**只对本轮自己的写入成立**：15 个已跟踪修改的 sha256 一个没变（见 `SOURCE_PROVENANCE.json.sourceRead[].sha256` 与 `git` 段）。

审计期间唯一执行的算力动作：两次跑了**本轮自己写的**两个只读探针（单进程、`maxWorkers=1`、`fileParallelism=false`，符合 `HEAVY_WORKER_CONCURRENCY=1`），以及一次仓库自带的 `preparedTransition.test.ts`（1.28 s）。**没有**跑 Pilot、没有跑 1700 组、没有 spawn 20 个 fresh Node。

---

## 3. 两个生成器的实现差异（源码级）

### 3.1 枚举：唯一来源

`legalActions.ts:38` 与 `preparedActions.ts:124` **都只从 `enumerateSearchActionCandidates` 取候选**：

```
preparedActions.ts:51-88   enumerateSearchActionCandidates(state)
  ├─ CatWins / MouseWins        → []                              （line 56-58）
  ├─ ChoosingTunnelExit         → 每个 tunnelExitChoices 一项，verifyEffectiveness=false（line 60-68）
  ├─ Playing + Mouse            → DIRECTIONS 顺序 4 个 mouseStep；若 mouseHasButter && !mouseSkillActive 追加 mouseSkill（line 71-77）
  └─ Playing + Cat              → DIRECTIONS 顺序 4 个 catStep；若 trapPosition===null && catTrapsRemaining>0 追加 catPlaceTrap（line 78-85）
```

动作顺序、前置守卫、`endTurn` 不是动作——**只有这一份实现**，不存在两份拷贝。**[源码]**

### 3.2 合法性谓词：同一个表达式

```ts
// preparedActions.ts:126-129
const legal = !cand.verifyEffectiveness
  || transition.kind === 'chance'
  || !gameAffectingEqual(state, transition.state);

// legalActions.ts:39 + 48-56
if (!cand.verifyEffectiveness || isEffective(cand.action, state, rules)) ...
function isEffective(...) {
  const res = simulateSearchAction(state, cand, rules);
  if (res.kind === 'chance') return true;
  return !gameAffectingEqual(state, res.state);
}
```

两者在逻辑上等价（`chance` 优先短路，其余按 `gameAffectingEqual` 取反）。**[源码]**

### 3.3 唯一的实质差异：模拟次数

| | 候选枚举 | 合法性模拟 | 返回内容 |
| --- | --- | --- | --- |
| `generateLegalSearchActions` | ✅ 共用 | **仅 `verifyEffectiveness=true` 的候选**（隧道出口**不模拟**） | `SearchAction[]` |
| `generatePreparedSearchActions` | ✅ 共用 | **全部候选，无例外**（隧道出口**也模拟**） | `{action, transition, originalIndex}[]` |

`prepareActions.ts:124-132` 的循环体第一行就是无条件 `simulateSearchAction`，`verifyEffectiveness` 只在**判定**时短路，不会跳过**模拟**。

> **偏差 PT-B-1（必须记录）**：模块文档 `preparedActions.ts:29-30` 写"the legacy generator never simulated them, and it still doesn't"。对 **generator** 成立；但对 `generatePreparedSearchActions` **不成立**——它为每个隧道出口多做一次 `chooseTunnelExit` 模拟。本轮实测：语料中 118 个 `ChoosingTunnelExit` 状态、467 个出口 → prepared 比 legacy **generator** 多 467 次规则调用（`parity.json.ruleCalls.deltaVsGenerator = +467`）。相对 uct 的"两步舞"没有回归（legacy 第二步同样要为这 467 个出口各模拟一次），但若将来有调用方**只用** generator 且不想付这层成本，这是一处新开销。

### 3.4 一处容易漏掉的短路：RULE-A

`simulator.ts:41-42` 在进入 `switch (action.type)` **之前**先跑 `applyNoMoveLoss(state)`；若该状态已被判负，直接返回终局，**一次 RuleSet 调用都不发生**。

后果：**`候选数 ≠ 规则调用数`**。本轮唯一实例是手构的 `special|cat-wedged`（猫四向被封、且无陷阱可放）：4 个候选、**0 次**规则调用、4 个"合法"动作（因为目标状态变成了终局，`gameAffectingEqual` 为 false → 判为有实效）。两个生成器在这里行为完全一致。**[源码]+[探针]**（`parity.json.ruleACShortCircuitStates`）

这解释了本报告所有"候选数 41 566 / prepared 41 562"的 4 之差，也解释了 `legacyGeneratorOnly 41 095 = 41 562 − 467`。**数值闭合，无残差。**

---

## 4. 十一项合同问题逐条回答

先给总表，再给逐条依据。

| # | 问题 | 裁决 | 主证据 |
| --- | --- | --- | --- |
| 1 | 合法动作集合完全相同？ | **是**（9 523 状态 / 41 566 候选，0 差异） | [源码] + [探针] |
| 2 | 动作顺序完全一致？ | **是**（`originalIndex` 恒等于合法表下标） | [源码] + [探针] |
| 3 | transition 状态内容完全相同？ | **是**（31 391 确定性转移，含日志字段逐字节相等） | [探针] |
| 4 | `stateKey` 一致？ | **是**（31 391 + 14 953 个 outcome 全等） | [探针] |
| 5 | `gameAffectingEqual` 一致？ | **是**（逐动作 + 逐 outcome） | [探针] |
| 6 | `mateActionCost` 一致？ | **是**（纯 `action.type` 函数，动作对象相同） | [源码] |
| 7 | CHANCE 的 kind / outcomes / weights 完全一致？ | **是**（1 032 个转移、14 953 outcome，序与权重全等） | [源码] + [探针] |
| 8 | prepared transition 是否持有可变对象引用？ | **是**，结构性共享（见 §5.1） | [探针] |
| 9 | evaluation 是否可能改 transition 状态？ | **否**（32 423 次评价后结构零变化） | [源码] + [探针] |
| 10 | 重复使用同一 prepared transition 是否影响后续模拟？ | **否**（读取稳定；输入不被污染；重算结果相同） | [探针] |
| 11 | 异常 / 终局 / 空合法集边界一致？ | **是**（语义一致；成本有一处偏差 PT-B-1） | [源码] + [探针] |

### 4.1 Q1 集合相同

**[源码]** 候选集合与守卫只有一份（§3.1）；合法性谓词等价（§3.2）。
**[探针]** 9 523 个状态上，`prepared.map(p=>p.action)` 与 `generateLegalSearchActions(state)` 长度与逐项内容全等；0 处 `set-size` 失配。
语料构成：24 个冻结人类根 + 手构特例，BFS 到 8 层（按 `stateKey` 去重）。其中 **9 143 个候选被判为非法并被两侧同样丢弃**——这正是"不能只比普通确定性移动"的关键：过滤行为也被对齐验证了。

### 4.2 Q2 顺序一致

**[源码]** 顺序由 `enumerateSearchActionCandidates` 的 push 顺序唯一决定；`originalIndex = out.length`（`preparedActions.ts:130`）即合法表下标。
**[探针]** 41 566 个位置逐项比对 `stable(action)`，0 处乱序；`originalIndex` 恒等于 `i`，0 处例外。
注：UCT 的边 tie-break 用 `actionKey` 字典序（`uct.ts:581`），不依赖枚举顺序；但 Expectiminimax 的"稳定同分优先"依赖 `originalIndex`，因此这一项不能省。

### 4.3 Q3 transition 内容相同

**[探针]** 对每个 `prepared` 项，用**完全独立**的一次 `simulateSearchAction(state, action)` 对照：

- `kind` 相同：31 391 + 1 032，0 处不一致；
- 确定性：`stateKey` / `gameAffectingEqual` / **排序键全序列化（`stable()`，含 `message`、`catActionLog`、`gameEventLog`）**三项全等，0 处差异。

含日志字段的全等是有意义的：`stateKey`/`gameAffectingEqual` 都**排除** `message`/log（`stateCompare.ts:89-97`、`transposition.ts:66-80`），所以只看这两项会漏掉"日志被多写一条"这类偏差。全序列化把这一层堵上了。

**前提条件（必须写进合同）**：RuleSet 的每个转移必须是 `(state, action)` 的纯函数。见 §5.4 的唯一例外。

### 4.4 Q4 `stateKey` 一致

**[探针]** 确定性：31 391/31 391 相同。CHANCE：1 032 个转移各自的 `outcomes.map(stateKey)` 序列逐项相同（14 953 个 outcome）。
**[源码]** `stateKey` 是纯读函数（`transposition.ts:81-104`），不写任何字段。

### 4.5 Q5 `gameAffectingEqual` 一致

**[探针]** 逐动作 `gameAffectingEqual(prepared.state, fresh.state) === true`，31 391/31 391；逐 outcome 亦全为 true，14 953/14 953。
**[源码]** 该函数只读（`stateCompare.ts:98-128`），且其字段集是本节 §5.1 引用共享检查的依据。

### 4.6 Q6 `mateActionCost` 一致

**[源码]** `mateActionCost` 是 `action.type` 的纯 switch（`expectiminimax.ts:295-308`）：`catStep`/`mouseStep` = 1，`catPlaceTrap`/`mouseSkill`/`chooseTunnel` = **0**。动作对象本身相同（Q2 已证），故成本必然相同。**[探针]** 逐候选 `mateActionCost` 比对，0 处差异。

> 值得写进报告的一句：**动作数 ≠ 行动成本**。5 个动作的计划成本仍是 4，因为 `catPlaceTrap` 计 0（`PILOT_COMPLETION_REPORT.md` §6 已有同结论）。

### 4.7 Q7 CHANCE 三类字段完全一致

**[源码]** 三个 CHANCE 产生点全部走同一条构造路径，prepared 不复制：

| 产生点 | 源码 | 构造 |
| --- | --- | --- |
| 吃黄油后的随机生成 | `simulator.ts:63-72` | `rules.buildButterChance(next)` 或 `defaultBuildButterChance`（`simulator.ts:166-182`），对 `enumerateButterSpawns` 的**枚举顺序**赋均匀权重 1/N |
| CAT→MOUSE 幽灵实体化 / placement debt | `simulator.ts:121-130` | `rules.resolveGhostBoundaryChance(state)`，先校验非空否则**抛错**（不回落随机） |
| 隧道出口 | `preparedActions.ts:60-68` | 非 CHANCE，按构造直接合法 |

**[探针]** 1 032 个 CHANCE 转移、14 953 个 outcome：

- 基数相同（0 处失配）；
- **outcome 顺序**相同（`stateKey` 序列逐项相等，0 处 `chance-order`）；
- **权重序列**相同（0 处 `chance-weights`）；
- 权重和 `|Σw−1| ≤ 1e-9`，且每个 `w > 0`（0 处违规）；
- 逐 outcome 的 `gameAffectingEqual` 与全序列化均相同。

按动作类型分布：`catStep` 597（= CAT→MOUSE 幽灵/债务边界）、`mouseStep` 435（= 吃黄油）。**任务书要求的两类 CHANCE 都被直接覆盖。**

### 4.8 Q8 可变对象引用

**是持有的。** 详见 `STATE_IMMUTABILITY_AND_CHANCE_AUDIT.md` §1。一句话：prepared 转移与其输入状态**结构性共享** `config`、`butterPositions`、`blockedTunnels`、`tunnelExitChoices`、`trapPosition`、`catPosition`/`mousePosition`、日志数组，在 12 % 的情形下连 `board` 与行数组都共享。当前安全，因为引擎是 copy-on-write。

### 4.9 Q9 evaluation 不改状态

**否。** 详见同文件 §2。`evaluateForCat` 构造**新的**特征对象字面量（`evaluation.ts:620-640`）；`hybridEvaluateForCat` 只写模块级 scratch（`hybridLeaf.ts:58-62` 的 `feat`/`nz`/`h1`/`h2`）；`stateKey`/`gameAffectingEqual` 纯读。

**[探针]** 对每个转移状态各跑一次 `evaluateForCat` + `hybridEvaluateForCat` + 3 次 `stateKey` + `gameAffectingEqual`，再比全序列化：32 423 次评价，**0 处变化**。

### 4.10 Q10 重复使用不影响后续

**否。** 三个子命题全部成立：

1. 同一 prepared 转移被连续读 3 次，`stateKey` 三次相同（31 391/31 391）。
2. prepared 转移被"消费"（评价、序列化、比较）之后，**输入状态**仍与生成前逐字节相同（9 523/9 523）。
3. 同一输入、同一动作再次模拟，结果与 prepared 转移逐字段相同（Q3 已证；且 Q3 的 fresh 模拟发生在 prepared 批次**之后**，说明批次的存在没有污染后续模拟）。

### 4.11 Q11 边界一致

| 边界 | 两侧行为 | 证据 |
| --- | --- | --- |
| `CatWins` / `MouseWins` | 均返回空数组，**0 次模拟** | [源码] `preparedActions.ts:56-58` / [探针] 2 个终局状态，`total()===0` |
| `ChoosingTunnelExit`，出口数 1/3/4 | 两侧动作集合与顺序一致；**prepared 多付 K 次模拟**（PT-B-1） | [探针] 118 状态 / 467 出口 |
| Playing 但**零合法动作** | 9 523 个状态里出现 **0 次**。原因是 RULE-A 先把"无路可走"改判为终局（`mobility.ts` + `simulator.ts:41`），所以 `Playing` 且空合法集在真实语料中不可达 | [探针] `emptyLegalWhilePlaying = []` |
| 全候选被过滤（"只能放陷阱"类） | 两侧同样保留 `catPlaceTrap`（0 步成本），不放宽 | [探针] 特例 `cat-trap-free` |
| 异常 | 两侧抛的是**同一个**异常、同一个候选下标处；差别仅在抛出点（legacy 在 `isEffective` 内，prepared 在 `preparedActions.ts:125`）。在 uct 的两步舞语境下，legacy 的第二步同样会抛，故**可观察行为相同**。对"只用 generator"的调用方，prepared 多了一个异常面（PT-B-1 的连带影响） | [源码] |

---

## 5. 场景覆盖矩阵（任务书 §3 强制清单）

| 场景 | 覆盖方式 | 规模 | 结果 |
| --- | --- | --- | --- |
| 普通猫移动 | 语料 BFS + 手构 | 确定性转移主体；`catMove` 规则调用 37 428（rollout）+ 2 624（tree） | 一致 |
| 放置陷阱 | `cat-trap-free` / `cat-trap-present` + 语料 | 2 141 次 `catPlaceTrap` 调用；成本 0 已验证 | 一致 |
| 鼠移动 | 语料 BFS | `mouseStep` 46 128（rollout）+ 1 608（tree） | 一致 |
| 吃黄油后的随机生成 | `butter-pickup` 特例 + 语料 | **435 个 CHANCE 转移** | 一致（基数/序/权重/outcome 全等） |
| CAT→MOUSE 幽灵实体化 | `ghost-boundary` 特例 + 语料 | **597 个 CHANCE 转移**（`catStep` 触发） | 一致 |
| Placement debt | `placement-debt` 特例（debt=2）+ 语料 | 同上 597 中的一部分 | 一致 |
| 隧道 | `tunnel-1` / `tunnel-3` + 语料 | 118 个 `ChoosingTunnelExit` 状态 / 467 出口；rollout 侧 `chooseTunnelExit` 4 726（guidance）+ 1 775（exec） | 一致（成本偏差见 PT-B-1） |
| 终局 | `terminal-catwins` / `terminal-mousewins` | 2 状态，0 模拟 | 一致 |
| 零行动成本动作 | `catPlaceTrap` / `mouseSkill` / `chooseTunnel` | `mateActionCost=0` 逐项验证 | 一致 |
| 重复状态与循环路径 | BFS 按 `stateKey` 去重；**3 897 次**后继落在已见状态 | 9 523 个互异状态 | 一致（prepared 批次是节点局部的，不做跨节点缓存，故不引入新的循环语义） |

---

## 6. 本轮发现的偏差（不多，但都要写进合同）

| 编号 | 内容 | 严重度 | 处置 |
| --- | --- | --- | --- |
| **PT-B-1** | `generatePreparedSearchActions` 为**每个隧道出口**多做一次 `chooseTunnelExit` 模拟（`preparedActions.ts:125` 无条件模拟），与模块文档"legacy 从不模拟、现在也不模拟"的措辞冲突。实测 +467 次调用（118 状态 / 467 出口） | 低（相对两步舞无回归） | 实现轮：可保留（相对现状仍是大赚），或在 `verifyEffectiveness === false` 时跳过模拟并把转移标记为"按构造合法、无转移对象"。**后者会改变 `PreparedSearchAction.transition` 的类型契约，需另立合同** |
| **PT-B-2** | RULE-A 短路使"候选数 ≠ 规则调用数"（`simulator.ts:41`）。任何以"候选数"估算成本的诊断都会偏差 | 低（可解释、可预测） | 成本模型必须按"实际规则调用"计数，不能按候选数外推 |
| **PT-B-3** | 现有 `uct.ts:461-465` 的 `illegal no-op edge reached the tree` 断言，本质上是**用第二次模拟去交叉验证第一次**。改用复用后该断言恒不可达，交叉验证能力**消失** | 中（是安全性净损失，不是正确性缺陷） | 实现轮必须把这条交叉验证**降级为测试期 gate**（见 `RECOMMENDATION.md` R4），不能默默删掉 |

---

## 7. 明确未验证的内容

1. **未在 100 ms 墙钟下测量任何东西。** 本轮全部计数都在"固定节点上限 + `now: () => 0`"下取得，不构成性能结论。
2. **树内 CHANCE 未被触发。** callsite 探针 8 次运行的 `chanceNodes` 全为 0——这 4 个根在 300 节点内没有出现幽灵边界/吃黄油。CHANCE 的等价性来自 parity 语料（1 032 个转移），**不是**来自 UCT 树内路径。
3. **计划补全路径未被执行。** `EXT_LEGALITY` / `EXT_GUIDANCE` / `EXT_EXEC` 三项计数均为 **0**：这 4 个根在 300 节点内树都走到了交接，`extractPlan` 没有进入补全循环。该调用点目前**只有源码级结论**。
4. **语料是宽度优先偏置的。** 每根上限 400 状态，24 根中 23 根撞顶，共丢弃 29 677 个后继。深而窄的局面代表不足。
5. **只有 24 个冻结根 + 手构特例。** 不覆盖 20×20 棋盘、`boxCount=12` 的完整阻塞图景、以及真实对局中的长尾。
6. **未做任何强度/胜率验证**，本轮也不允许做。

---

## 8. 复现方式

```bash
# 全部只读；不产生 src/ 改动
cd F:/小猫小鼠
npx vitest run --config PPC-MCTS-01B/probe/vitest.config.mts
# 产出 PPC-MCTS-01B/data/parity.json、PPC-MCTS-01B/data/callsites.json
```

**同一份探针代码的两次独立运行产出逐字节相同的 JSON**（parity：17:15 与 17:17；callsite：17:14 与 17:17），因此结论与机器负载、与运行时长（44 s vs 71 s）无关。

`logs/run1/` 保留的是**探针代码早期版本**（BFS 深度 4）的快照，与 `data/` 不同属预期，不参与任何结论——见 `logs/run1/README.txt`。
