# ITERATIVE_SOLVER_DESIGN.md — opening fairness DFS 显式栈改造

**轮次**：PPC-P1-OPENING-STACK-01
**唯一改动文件**：`src/game/openingFairness.ts`（+284 / −103，723 → 904 行，LF 保持不变）
**未改动**：`certifyOpening` 对外签名、`DEFAULT_OPENING_CAPS`、`generateFairOpening`、动作生成与排序、`simulateSearchAction`、引擎规则、任何 AI/Search/Sidecar/预算常量。

---

## 1. 为什么要改

`solve()` 是递归 DFS，递归深度 ∝ `catMovesLeft`（= 根状态 `catBaseMoves`）。`catBaseMoves` 是**合法输入**（`validateGameConfig` 只要求「非负安全整数且计划上界可精确表示」），所以下面这条链路在生产代码里是可达的：

```
certifyOpening(state)            openingFairness.ts:463  ← 递归帧
  └ generateLegalSearchActions   legalActions.ts:55
      └ isEffective              legalActions.ts:72
          └ simulateSearchAction simulator.ts:46
              └ catMove          engine.ts:908
```

修复前实测（`logs/01_baseline_witness_pre_fix.log`，`_raw/baseline_witness_pre.json`）：

| `catBaseMoves` | `validateGameConfig` | `certifyOpening` | `createGameState` |
|---|---|---|---|
| 4 | PASS | `CERTIFIED_NO_CERTAIN_CAT_LOSS` / 931 节点 / 47ms | `ok(state)` |
| 1000 | PASS | `UNKNOWN`/`NODE_CAP` / 20000 节点 / 12298ms | `ok(state:null)` |
| **100000** | **PASS** | **`RangeError: Maximum call stack size exceeded`** | **同样抛 `RangeError`** / 522ms |
| 6004799503160661 | FAIL | 未执行（配置层先拒绝） | `ok(state:null)` / `INVALID_CONFIG` |

栈顶阈值量化（`logs/02_stack_threshold_pre_fix.log`）：`M=500`、`M=1000` 可完成；**`M=1500` 起全部抛 `RangeError`**（1500/2000/2500/3000/4000/6000/20000/100000，每个 56–79ms 即崩）。

这不是「无法认证」，而是**用运行时异常冒充了一个不该存在的失败态**：宿主 `createGameState` 的 `try/catch` 无法区分「开局不安全」与「栈爆了」。

---

## 2. 改造形态

递归 → **显式栈驱动**，栈元素是两类帧：

```ts
interface NodeFrame {   // 一个 OR/AND 节点
  state; depthTurns;
  mouseActor;           // 聚合方式，入场时确定（按 actor，不按 phase）
  memoKey;              // 通过终局/时域检查后才写入
  actions; index; entered;
  winWitness; sawSafe; sawUnknown; unknownReason;
}
interface ChanceFrame { // 一个 CHANCE 节点
  outcomes; actionActor; depthTurns; index;
  validated;            // 概率分布是否已整批校验
  allWin; sawUnknown;
}
```

主循环（`solve`，openingFairness.ts:649）只有两种动作：

1. 栈顶帧「推进」（`advanceNode` / `advanceChance`）→ 返回 `{done, result}`（弹栈并把 result 交给下一帧）或 `{child, frame}`（压栈）；
2. 有一个已完成的子结果时，交给新的栈顶帧消费（`onNodeChild` / `onChanceChild`）。

原递归函数被原样拆成三段，**内容与顺序逐行保留**：

| 原递归位置 | 现形态 |
|---|---|
| `solve` 序言（节点计数 / 终局 / 时域 / memo / relaxed prune / 动作生成） | `enterNode(f, ctx)` |
| 动作循环里的 `applyAction` | `childFrame(...)`（跑真实 transition，决定子帧类型） |
| `solve` 尾声（WIN/SAFE/UNKNOWN 聚合 + memo 写回） | `finishNode(f, ctx)` |
| `solveChanceOutcomes` pass1 + pass2 | `advanceChance` 的 `validated` 分支 + `onChanceChild` |

---

## 3. 语义等价性论证

| 合同项 | 保持方式 |
|---|---|
| Mouse=OR / Cat=AND | 由 `state.currentPlayer` 决定 `mouseActor`，与 `phase` 解耦（`ChoosingTunnelExit` 仍属鼠）；`onNodeChild` 分支与原文一一对应 |
| OR 分支：首个 WIN 即返回 | `onNodeChild` 中 `r.tri==='WIN'` → 立刻 `finishNode` 并弹栈（等价原 `break`） |
| AND 分支：首个 SAFE 即返回 | `r.tri==='SAFE'` → 立刻 `finishNode` 并弹栈 |
| CHANCE：先整批校验再逐个解 | `validated` 惰性标志保证 pass 1 在任何 outcome 被解之前完成一次；空列表 / 非有限 / ≤0 权重 / 质量和非 1 → `INVALID_CHANCE` |
| CHANCE：SAFE 短路 | `onChanceChild` 首个 SAFE 立即返回 SAFE（与原文一致）；不在校验前短路 |
| UNKNOWN 不入 memo | `finishNode` 只写 WIN/SAFE；`enterNode` 的 memo 命中照旧 |
| `depthAfter` 鼠回合计数 | 调用点与参数完全不变（节点子与 CHANCE 子各一处） |
| 动作顺序 / 生成 / 短路顺序 | `orderActions(generateLegalSearchActions(...))` 原样，`index` 单调递增 |
| `maxNodes` / `horizonTurns` 语义 | `enterNode` 首两段与原文同序：先 `nodes >= maxNodes` → `capHit`+`NODE_CAP`（**不**自增），再 `nodes++` |
| `prunedNodes` / `exploredNodes` | 只在 `enterNode` 自增 `nodes`、只在 prune 分支自增 `prunedNodes`；帧本身从不计数 |
| `witnessAction` 选择 | `r.witness ?? f.actions[f.index]`，与原文 `r.witness ?? action` 同义 |
| 随机数消耗 | 迭代化不改变 `simulateSearchAction` 的调用次数与顺序（深度优先、同一 action 序列），因此 CHANCE 构造次数不变 |
| `generateFairOpening` / `maxAttempts` | 完全未改 |

### 内存

帧只持有**引用**（`state`、`outcomes`），不复制棋盘。峰值存活帧数 = 递归深度（≤ 深度上限，节点预算 20000 封顶），量级与原来的调用栈相同；没有「保存完整棋盘快照」的结构。实测 `M=100000` 全程 `heapUsed` ≈ 251MB（含 Vitest 自身），无 OOM、无需调 V8 heap。

---

## 4. 显式全局约束（本轮自我约束）

- 没有新增任何玩法上限（`config.ts` 本轮零改动）。
- 没有把 `100000` 静默降级。
- 没有 `try/catch RangeError` 兜底：溢出在结构上不再可能发生。
- UNKNOWN 不会被提升为 CERTIFIED：`NODE_CAP` / `HORIZON` / `INVALID_CHANCE` / `UNSUPPORTED_CONFIG` 语义与优先级完全不变。
- 节点预算 20000、时域 3、动作顺序、CHANCE 分支全部保留。
- H1 / Hard Cat Planner / Search Math / TT / Sidecar / 100ms / 150ms 零改动。

---

## 5. 已知且**未**处理的旁支

`catMove` 自身的 `catMovesLeft` 递减与 `catMove` 内部循环（`engine.ts:908`）没有被改造；栈安全只保证在 `catBaseMoves` 取合法值时 DFS 不再爆栈。若将来 `catMove` 内部出现与 `catBaseMoves` 线性相关的深递归，属于另一处修复，本轮未触碰。
