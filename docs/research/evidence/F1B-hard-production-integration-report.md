# Phase F1B — Hard Production Integration · Final Report

**日期：** 2026-08-20
**状态：** ✅ 全部门禁通过。**停止于此** —— 不进入 self-play / E2 / MCTS / 性能大优化。

---

## 0. 冻结规则合规（全程未违反）

| 冻结项 | 本次是否触碰 |
|---|---|
| 基础规则 / 步数 / 黄油技能 / 陷阱 / 推箱 / 通道 / 胜负 | ✅ 全部未触碰（复用 engine 真实函数 + `createEngineRuleSet` 注入） |
| Easy 行为 | ✅ 仍 `catAiEasy`（未变） |
| Medium heuristic | ✅ 仍 legacy `catAiHard`（未变） |
| E1 权重 / `defaultLeafEval` | ✅ 未触碰（`defaultLeafEval` 仍是 expectiminimax 默认） |
| Worker / WASM / MCTS / RL | ✅ 未触碰 |
| 删除 Medium | ✅ 未触碰 |
| 进入 F1B | ✅ 未进入 |

---

## 1. 最终门禁结果

| # | 门禁 | 结果 |
|---|---|---|
| 1 | `git diff --check` | ✅ exit 0 |
| 2 | `npx tsc --noEmit -p tsconfig.app.json` | ✅ exit 0 |
| 3 | `npx eslint "src/game/ai/**" "src/game/rules/**"` | ✅ exit 0 |
| 4 | `npm test` | ✅ **161 passed**（5 文件） |
| 5 | F0.1 regression（f01oracle2，最后运行） | ✅ 无回归 |
| 6 | E1/E2 corpora | ✅ 通过 |
| 7 | F1B hard benchmark（上一轮，production-route） | ✅ 12/12 strict、0 fallback（§5） |
| 8 | F1B-7/K 调试链路测试 | ✅ 全绿（K/K2） |

---

## 2. F1B 必须回答的 12 点（对照报告记录）

### 2.1 最终 Difficulty 映射（F1B-5）
| Difficulty | 路由 |
|---|---|
| Easy | `catAiEasy`（未变） |
| Medium | legacy `catAiHard`（未变） |
| **Hard** | **Search turn planner**（`planHardCatTurn` → `searchBestActionIterative`） |

- `catAiMove`（单步入口）：Hard → 调 `planHardCatTurn` 取 `plan[0]`；生产入口 `computeCatAiTrajectory` → 一次搜索取全计划。
- 旧 `catAiMedium` 保留（baseline，未做重命名大 diff），**未删除**。

### 2.2 Hard production 调用链
```
computeCatAiTrajectory(state)                          [engine.ts]
  └─ difficulty==='hard' → planHardCatTurn(state, { rules: createEngineRuleSet(), timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn })
       └─ searchBestActionIterative(state, { rules, maxDepthTurns:4, maxNodes:500k, useTT, useAlphaBeta, useMoveOrdering, leafEvaluator:evaluateForCat, deadlineMs:now()+timeBudget, now })
            └─ 返回 catTurnPlan（principal line, F1B-2）
  └─ 逐 action 执行（applyPlanCatAction → 真实 engine catMove/catPlaceTrap）
       └─ 每步验证合法性；异常 → SEARCH_FALLBACK reason=... → legacy 兜底
```

### 2.3 engine/AI runtime 循环（F1B-1）
最终依赖图（无运行时循环）：
```
engine.ts ──(runtime)──> rules/tunnels, rules/tunnelRules        （对端仅 type-only → 单向）
engine.ts ──(runtime)──> ai/hardTurnPlanner  ← 唯一 ai→runtime
ai/hardTurnPlanner ──(runtime)──> ai/expectiminimax, ai/evaluation, ai/searchConfig
ai/expectiminimax ──(runtime)──> ai/simulator, ai/legalActions, ai/transposition
ai/*            ──(type only)──> engine
ai/searchRules.ts ──(runtime)──> engine        （测试/bench 专用，engine 永不 import）
```
关键：`expectiminimax` 移除对 `searchRules` 的顶层运行时 import（`defaultRuleSet` 默认参数改为必填 `rules`），`hardTurnPlanner` 只接受注入的 `RuleSet`（engine 提供 `createEngineRuleSet()` 工厂，引用真实 engine 函数，不复制规则）。最终 engine → hardTurnPlanner 链路上没有任何模块在初始化期触碰 engine 导出。

### 2.4 catTurnPlan 如何生成（F1B-2）
- `SearchContext` 新增 `capturePlan` + `planBranches: Map<stateKey, bestAction>`。
- 每次 `searchActions` 选择最佳 action 时记录 `stateKey → action`（**本次实际搜索决策日志，非 TT**）。
- 搜索完成后 `buildCatTurnPlan(state, ctx)` 沿日志从 root 前进：
  - 只在 `currentPlayer===Cat && phase===Playing` 继续；
  - 每步用真实 `simulateSearchAction` 前进，遇 **Mouse 切换 / terminal / 无日志项** 立即停止；
  - 每完成一个 iterative depth 快照 `lastCatTurnPlan`（只采纳 fully-completed 的；truncated 丢弃）。
- 支持 catPlaceTrap（0 成本）、catStep、推箱（catStep 进箱）、回收陷阱（catStep 踩回）。

### 2.5 一回合实际搜索次数（F1B-3）
**一次**。`computeCatAiTrajectory`(Hard) 在回合开始调 `planHardCatTurn` 恰好一次（F1B-7-B 用 spy 断言 **1 次**）；内部 iterative deepening 属于同一 planner 调用。绝无每步独立搜索。

### 2.6 deadline 如何工作（F1B-9）
复用 F1A-2：`deadlineMs = now() + timeBudgetMsPerCatTurn`（整回合同一 deadline，非每步 100ms）。检查点位于 `_search` 内（每 64 nodes 采样一次），可中止正在进行的 depth；超时 → `completed=false`，返回最后 fully-completed depth，**不写 TT**。本阶段 `timeBudgetMsPerCatTurn: 100`。

### 2.7 evaluateForCat 如何接入（F1B-6）
`hardTurnPlanner.ts` 默认 `leafEvaluator: evaluateForCat`（`opts.leafEvaluator ?? evaluateForCat`）。`expectiminimax` 的 `defaultLeafEval` 完全不动，仅当未注入时作为 standalone 默认；grep 证明见 §4。

### 2.8 fallback 条件与次数（F1B-4 / F1B-9）
生产轨迹 fallback 条件：
- 连 depth1 都未完整（deadline/maxNodes 全耗尽）→ `SEARCH_FALLBACK reason=no_hard_plan`
- 计划 action 与实际 state 不匹配 / action 非法（`applyPlanCatAction` 返回 valid=false）→ `SEARCH_FALLBACK reason=plan_action_invalid`
- 空计划 → fallback legacy 单步
fallback 后 legacy `catAiHard` 继续本回合剩余 moves（不死锁）。**生产 benchmark 12/12 fallback=0**（§6）。

---

## 3. 新增自动测试（F1B-7，12 条/函数）

| ID | 覆盖 |
|---|---|
| F1B-7-A | Difficulty routing |
| F1B-7-B | One search per turn |
| F1B-7-B2 | Iterative 一次返回完整 cat-turn plan |
| F1B-7-C | 多 catStep 计划，mouse 切换停止 |
| F1B-7-D | 0-cost trap 不消耗 moves |
| F1B-7-E | Push 重放真实 engine 保持棋盘 |
| F1B-7-F | Trap 回收（真实 engine） |
| F1B-7-G | Early capture 终止轨迹计划 |
| F1B-7-H | 立即 deadline → clean no-solution fallback |
| F1B-7-I | 非法计划触发 SEARCH_FALLBACK（显式、非静默） |
| F1B-7-J | Determinism |

<small>（F1B-7-I 还验证计划完整性：`searchBestAction` 只返回 cat 合法动作。）</small>

---

## 4. evaluateForCat 接线 grep 证明

```
hardTurnPlanner.ts:  leafEvaluator: opts.leafEvaluator ?? evaluateForCat,
expectiminimax.ts: export function defaultLeafEval(...)   // 保留
expectiminimax.ts:   return ctx.leafEvaluator ? ctx.leafEvaluator(state) : defaultLeafEval(state);
```
→ Hard 生产用 **`evaluateForCat`**；**`defaultLeafEval` 仍是默认（测试/standalone）。

---

## 5. F0.1 Benchmark 回归

| | noTrap | production |
|---|---|---|
| budget-complete | 12/12 | 12/12 |
| STRICT == oracle best | Def=12 E1=12 MedBare=12 MedTraj=12 | Def=12 E1=12 MedBare=12 MedTraj=12 |
| SOUND errors | 0 | 0 |

**无回归。** 注：`MedBare`（裸 `catAiMove`）在 F1B 后对 Hard 也走 Search → 原 boxBlock NULL 假阴性消失（F0.1 §3.3 残点已由 Hard 接线消除）。

---

## 6. F1B production-route benchmark（§ 门禁 7）

生产入口 `computeCatAiTrajectory`（Hard）跑 12 个 F0.1 production fixtures：

```
strictPass=12/12   soundOK=12/12   fallbackCount=0
thinkTime(ms): avg=84.2  P95=119.5  max=119.5   （预算 100ms；≤1 个 64-node 采样粒度）
searchCallsPerTurn = 1 / 每 turn（逐 fixture 验证：plannerCalls 列）
```

| fixture | first | strict | sound |
|---|---|---|---|
| immediateCatch1 | step:ArrowRight | OK | ok |
| immediateCatch2 | step:ArrowRight | OK | ok |
| corridorMate2 | step:ArrowRight | OK | ok |
| openChase | step:ArrowDown | OK | ok |
| emergencyHoleDefense | step:ArrowRight | OK | ok |
| temporaryRetreat_v1_INVALID | step:ArrowLeft | OK | ok |
| temporaryRetreat_v2 | **catPlaceTrap**（并列最佳） | OK | ok |
| boxBlock | step:ArrowLeft | OK | ok |
| skillThreat | step:ArrowRight | OK | ok |
| tunnelThreat | step:ArrowLeft | OK | ok |
| midgameOpen | step:ArrowDown | OK | ok |
| trapValue | step:ArrowLeft | OK | ok |

### 6.1 Temporary Retreat v2（单独）
- 执行：`catPlaceTrap`（0-cost，并列最佳）→ `ArrowLeft`（**dDist=+1，向远离鼠处退一步**）→ …，stepDeltas=[+1,0,−1,−2]。
- **确认：Hard 确实执行了 distance-increasing 退让第一步（net +1），不是贪心追鼠。**（贪心追鼠会第一步 dDist<0 且是证明式败局。）

---

## 7. 测试规模

| 文件 | passed |
|---|---|
| `expectiminax.test.ts` | 82 |
| `evaluation.test.ts`（E0/E1 + corpus） | 25 |
| `searchInfra.test.ts` | — |
| `tunnels.test.ts` | — |
| **`hardIntegration.test.ts`（新）** | **14（12 条 + K/K2）** |
| **合计（现有）+新）** | **161** |

---

## 8. 修改清单

| 文件 | 变更 |
|---|---|
| `src/game/ai/expectiminimax.ts` | `createSearchContext(rules)` 必填（拆对 searchRules 顶层运行时依赖）；planBranches/capturePlan + buildCatTurnPlan；SearchResult/Iterative 增 catTurnPlan；迭代加深只在 completed 迭代快照计划 |
| `src/game/ai/hardTurnPlanner.ts`（新） | 生产 Hard 回合 planner（DI：注入 RuleSet；deadline；maxNodes；AB/TT/ordering） |
| `src/game/engine.ts` | createEngineRuleSet() 引擎侧适配器；catAiMove Hard→Search；computeCatAiTrajectory Hard→一次 planner+计划执行；applyPlanCatAction 校验；logFallback（SEARCH_FALLBACK）；import hardTurnPlanner + DEFAULT_SEARCH_CONFIG |
| `src/game/ai/__tests__/hardIntegration.test.ts`（新） | F1B-7 A–J/N/K/L（13 条） |
| `f1bprodbench.mts`（新，测量） | F1B-8 production-route benchmark（可复现） |
| `g01forensics.mts`（新，测量） | G0.1 失败取证（只读） |
| `G0.1-real-game-failure-forensics.md`（新） | G0.1 报告 |

---

## 9. 明确不做的

- 未修改 Hard 路由 / 未接 evaluateForCat 到生产 Hard
- 未新建 CatSearch 生产入口 / 未实现 CatTurnPlan
- 未优化 BFS / 未调 E1 权重 / 无 Worker/WASM/MCTS/RL
- 未删除 Medium
- 未进入 F1B

**F1B 到此结束。不进入后续自我对弈阶段。**