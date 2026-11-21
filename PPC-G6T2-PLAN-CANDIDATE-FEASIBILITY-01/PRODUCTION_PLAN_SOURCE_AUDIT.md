# PRODUCTION_PLAN_SOURCE_AUDIT — G6T2 生产猫回合计划来源审计（只读）

- 轮次：`PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01`
- 根：`G6T2`，ARM E1，D2 固定深度 2（猫回合 + 鼠回合）
- 性质：静态源码追踪 + 历史工件交叉核对；**本文件不修改任何生产文件**，也不以任何生产数值重跑为前提。
- 关键约束：`ULDR` 与 `UUDD` 不同，**不构成**修改生产代码的理由。本审计只解释差异的来源。

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| `searchBestAction().catTurnPlan` 如何形成 `ULDR` | 当且仅当 `mate === null` 且 `equalPrimaryGraph` 非空时，`searchBestAction` 用 `extractBestCatTurnPlan` 覆盖由 `planBranches` 走出的计划；后者在“等价最优动作图”上做 DP，按**最少折返次数**（`countPlanReversals`）选择，平局取图内稳定顺序。`LUDR` 是这一规则下的结果。 |
| `planBranches` 为什么给出 `UUDD` | `planBranches` 记录的是每个猫方 MAX 节点上搜索**实际选出的单一动作**（严格改进、平局取更小 `originalIndex`）。从根沿 state→action 逐节点行走即得到主变着；它在等价兄弟间不做任何“最少折返”偏好，因此保持搜索自选的 `UUDD`。 |
| `equalPrimaryGraph`/`extractBestCatTurnPlan` 是否**有意**替换主计划 | 是，但仅在“无 mate 且存在等价最优兄弟”时。替换的是**计划表示**（在同值计划中选折返更少者），不是评分，也不是搜索决策；替换后 D2 根值不变。 |
| HardTurnPlanner 实际消费哪个结果 | `hardTurnPlanner.ts:276` 起 `let plan = search.catTurnPlan;`，即**已替换后**的计划；`hardTurnPlanner.ts:381` 可被 refutation sidecar 覆盖；`hardTurnPlanner.ts:609` 可用上一深度 `previousCompletedPlan` 救援。 |
| 执行层能否逐动作回放并确认来源 | 能。`engine.ts:4129` 调 `planHardCatTurn` 一次，`engine.ts:4204–4237` 用 `applyPlanCatAction`（`engine.ts:4488`）逐步执行；非法/耗尽给出显式 `SEARCH_FALLBACK`。回放合法性按“单步是否产生效果”判定，**不要求**整回合净位移。 |

---

## 1. `catTurnPlan` 的两条生成通道

### 1.1 通道 P（principal walk）：`planBranches`

- 记录点：`expectiminimax.ts:1471–1472` — 在每个猫方 MAX 节点、计划捕获开启时
  `ctx.planBranches.set(stateKey(state), bestAction)`。
- 行走：`expectiminimax.ts:1926` `buildCatTurnPlan`
  - 从根开始按 `stateKey` 查 `planBranches`，逐节点追加动作；
  - 遇到 chance、移交鼠方、终局或日志缺失即停止（`expectiminimax.ts:1942–1956`）。
- 语义：这是**搜索自身选出的主变着**（严格改进才换；精确平局取更小 `originalIndex`），
  因此对应 `UUDD`。它没有任何“折返最少”偏好。

### 1.2 通道 E（equal-primary DP）：`equalPrimaryGraph` + `extractBestCatTurnPlan`

- 记录点：`expectiminimax.ts:1463–1465` — 仅在**根猫回合内**、猫方 MAX、节点完全解析
  （`allCompleted`）且存在 **>1 个等价最优动作** 时，按 `${stateKey}\x00${depthTurns}`
  记录 `{ state, equalActions }`。
- 抽取：`planQuality.ts:513` `extractBestCatTurnPlan`
  - 找到根的图键；若根无图条目 → `planQuality.ts:544` 回退 `fallbackPlanWalk`
    （即单动作 `planBranches` 走法，与通道 P 同源）；
  - 否则跑 DP：`planQuality.ts:557` `extractDp`
    - 每节点候选 = 图中 `equalActions`（>1 时），否则回退 `planBranches` 单动作
      （`planQuality.ts:596–611`）；
    - 对每个候选拼接后的**完整计划**计折返：`planQuality.ts:658`
      `countPlanReversals(prefix.prevCatStepKey, fullPlan)`，
      `countPlanReversals` 定义于 `planQuality.ts:137`；
    - 选择规则：折返数更小者胜；相等时保留 `actionsToTry` 中先出现者
      （`planQuality.ts:660–664`）；
    - 有 `pathGuard`（`planQuality.ts:591–593`）与 memo（`planQuality.ts:585–589`）。
  - CHANCE 终步：猫动作本身保留进计划，chance 结果不写入计划
    （`planQuality.ts:625–636`），与执行层一致。
- 语义：在**同值**计划集合内改变表示，选择“更少原地折返”的一条；`LUDR` 由此而来。

### 1.3 覆盖点（唯一的一处）

`expectiminimax.ts:2015–2025`：

```
const { result, bestAction } = runFixedSearch(...);
let catTurnPlan = [];
if (ctx.capturePlan) {
  catTurnPlan = buildCatTurnPlan(state, ctx);              // 通道 P
  if (result.mate === null && ctx.equalPrimaryGraph && ctx.equalPrimaryGraph.size > 0) {
    const extracted = extractBestCatTurnPlan(...);         // 通道 E
    if (extracted.length > 0) catTurnPlan = extracted;
  }
}
return { action, value, mate, completed, diagnostics, catTurnPlan };
```

- 条件三重：计划捕获开、`mate === null`、图非空；任一不满足则保留通道 P。
- `mate === 'mouse'` 时另有 `finalizeCompletedIterationPlan`（`expectiminimax.ts:1973`）
  与 forced-loss tie-break（`expectiminimax.ts:1985–1993`）路径，不在本轮根上触发。
- **替换发生在搜索完成之后，不改变 `result.value`；D2 根值 -658.2105263157898 与计划表示无关。**

---

## 2. `UUDD` 与 `LUDR` 为何不同、为何不是缺陷

1. 两者在 D2 深度模型下**同值**：`equalPrimaryGraph` 只在“同一节点上动作值完全相等”时记录
   （`expectiminimax.ts:1463`），因此 DP 的候选池按定义不改变任何节点值。
2. 差异只在**表示偏好**：通道 P 保留搜索的逐节点首选（`UUDD`，净位移为零或近零）；
   通道 E 在等价集合中偏好最少折返（`LUDR`）。两者都是合法完整猫回合。
3. 执行层按单步效果判定合法性（`engine.ts:4492–4506`：位移、步数、阶段或陷阱变化即合法），
   不把“回到起点”视为非法；因此两条计划都可被 `applyPlanCatAction` 逐步执行。
4. 第 1 轮实测（`PPC-G6T2-SELECTION-CAUSE-01/PLAN_PROGRESS_AUDIT.json`）：
   `UUDD`/`DUUD`/`LUDR`/`UURR`/`DRRR`/`DRDR` 六条计划均 4/4 步回放成功并停在合法鼠方前线。
5. 结论：**ULDR ≠ UUDD 不构成生产缺陷证据，不得据此修改生产代码。**

---

## 3. HardTurnPlanner 消费路径

| 行 | 行为 |
| --- | --- |
| `hardTurnPlanner.ts:276` | `let plan = search.catTurnPlan;`（已含通道 E 覆盖） |
| `hardTurnPlanner.ts:375–381` | refutation sidecar 触发时 `plan = sidecar.plan`（可再次覆盖） |
| `hardTurnPlanner.ts:609` | 无进展循环救援：可用 `search.previousCompletedPlan` 替换当前计划 |

即：执行层最终消费的计划可能来自 (a) 通道 E、(b) 通道 P、(c) sidecar、(d) 上一深度救援；
四者都经过同一执行器与同一合法性判定。

## 4. 执行层回放与来源证据

- 计划获取：`engine.ts:4129–4138`，每猫回合调用一次 `planHardCatTurn`。
- 逐步执行：`engine.ts:4204–4237`：
  - `applyPlanCatAction`（`engine.ts:4488`）返回 `{ state, valid }`；
  - 非法 → `SEARCH_FALLBACK reason=plan_action_invalid`；
  - 计划先耗尽而回合未结束 → `SEARCH_FALLBACK reason=plan_exhausted`；
  - 均显式记录，随后本回合余下部分走 legacy 启发式。
- 记录：`execFacts.plannedPlan / appliedPlanActions / fallbackOccurred`，以及
  `engine.ts:4151–4161` 写入 `hardSearchHistory` 的 `plan`、`rootValues`、`value`、`mate`。
- 因为每步合法性与状态效果可独立重放（第 1 轮已用同一生产函数逐步回放六条控制计划），
  **执行层具备逐动作回放并核对来源的能力**；本轮候选枚举沿用同一生产生成器
  （`generatePreparedSearchActions`），不引入第二套规则。

## 5. 与本轮候选发现的关系（约束声明）

- 通道 E 只能重排 `equalPrimaryGraph` 中已记录的**等价**动作；它在设计上不产生
  “非主候选但更安全”的计划。要发现此类别之外的完整猫回合（如 `DRRR`），
  必须**穷举**合法完整回合，而不是重排三条主候选 —— 这正是 G2/G3 的验证对象。
- 本审计未改动 `src/`、GAMEPLAY.md、E1、搜索数学、Sidecar、Guard 或任何预算常量；
  所有结论只读自生产源码与第 1 轮冻结工件。
