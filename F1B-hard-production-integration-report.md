# Phase F1B — Hard Production Integration · 最终验收报告

**日期：** 2026-08-20
**状态：** ✅ Hard 已通过 Search turn planner 正式接入生产路由；全部门禁通过。**停止于此**——不进入 self-play / E2 / MCTS / 性能大优化。

---

## 0. 冻结规则合规

| 冻结项 | 本次是否触碰 |
|---|---|
| 基础步数 / 黄油技能 / 陷阱 / 推箱 / 通道 / 胜负规则 | ✅ 未触碰（全部复用 engine 真实函数） |
| Easy 行为 | ✅ 未触碰（仍 `catAiEasy`） |
| Medium heuristic | ✅ 未触碰（仍 legacy `catAiHard`） |
| E1 weights / defaultLeafEval | ✅ 未触碰（`defaultLeafEval` 仍是 expectiminimax 默认） |
| Worker / WASM / MCTS / RL | ✅ 未触碰 |

---

## 1. 最终门禁结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `git diff --check` | ✅ exit 0 |
| 2 | `npx tsc --noEmit -p tsconfig.app.json` | ✅ exit 0 |
| 3 | `npx eslint "src/game/ai/**" "src/game/rules/**"` | ✅ exit 0 |
| 4 | `npm test` | ✅ **159 passed**（5 文件：+12 条 F1B-7） |
| 5 | E0 corpus + E1 37-case | ✅ 通过（evaluation.test.ts 25 passed） |
| 6 | F0.1 benchmark | ✅ 无回归（两套 12/12） |
| 7 | F1B production-route benchmark | ✅ 12/12 strict、0 fallback（§6） |

---

## 2. 报告必须回答的 12 点

### 2.1 最终 Difficulty 映射（F1B-5）
| Difficulty | 路由 |
|---|---|
| Easy | `catAiEasy`（未变）|
| Medium | legacy `catAiHard`（未变）|
| **Hard** | **Search turn planner**（`planHardCatTurn` → `searchBestActionIterative`）|

- `catAiMove`（单步入口）：Hard 分支调用 planner 取 `plan[0]`；生产回合入口 `computeCatAiTrajectory` 则一次搜索拿全计划。
- 旧 `catAiMedium` 保留未删（baseline），未做大重命名 diff。

### 2.2 Hard production 调用链
```
computeCatAiTrajectory(state)                      [engine.ts]
  └─ difficulty==='hard' → planHardCatTurn(state, { rules: createEngineRuleSet(), timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn })
       └─ searchBestActionIterative(state, { rules, maxDepthTurns:4, maxNodes:500k, useTT, useAlphaBeta, useMoveOrdering, leafEvaluator:evaluateForCat, deadlineMs:now()+timeBudget, now })
       └─ 返回 catTurnPlan（principal line, F1B-2）
  └─ 逐 action 执行（applyPlanCatAction → 真实 engine catMove/catPlaceTrap）
       └─ 每步验证合法性；异常 → SEARCH_FALLBACK reason=... → legacy 兜底
```

### 2.3 engine/ai runtime 循环（F1B-1）
最终依赖图（无运行时循环）：
```
engine.ts ──(runtime)──> rules/tunnels, rules/tunnelRules        （对端 type-only → 单向）
engine.ts ──(runtime)──> ai/hardTurnPlanner  ← 唯一 ai→runtime
ai/hardTurnPlanner ──(runtime)──> ai/expectiminimax, ai/evaluation, ai/searchConfig
ai/expectimiminax ──(runtime)──> ai/simulator, ai/legalActions, ai/transposition
ai/*            ──(type only)──> engine
ai/searchRules.ts ──(runtime)──> engine             （测试/bench 专用，engine 永不 import）
```
关键动作：`expectiminimax` 移除对 `searchRules` 的**顶层运行时 import**（`defaultRuleSet` 默认参数改为必填 `rules`），`hardTurnPlanner` 只接受注入的 `RuleSet`（engine 提供 `createEngineRuleSet()` 工厂，引用真实 engine 函数，不复制规则）。最终 engine → hardTurnPlanner 链路上没有任何模块在初始化期触碰 engine 导出。

### 2.4 catTurnPlan 如何生成（F1B-2）
- `SearchContext` 新增 `capturePlan` + `planBranches: Map<stateKey, bestAction>`。
- 每次 `searchActions` 选择最佳 action 时记录 `stateKey → action`（**本次实际搜索的决策日志，非 TT**）。
- 搜索结束后 `buildCatTurnPlan(state, ctx)` 沿日志从 root 前进：
  - 只在 `currentPlayer===Cat && phase===Playing` 时继续；
  - 每一步用真实 `simulateSearchAction` 前进，遇 **Mouse 切换 / terminal / 无日志项** 立即停止；
  - 每完成一个 iterative depth 就快照 `lastCatTurnPlan`（只采纳 fully-completed 的 ；truncated 的丢弃）。
- 支持 catPlaceTrap（0 成本，不消耗 moves）、catStep、推箱（catStep 进箱）、回收陷阱（catStep 踩回）。

### 2.5 一回合实际搜索次数（F1B-3）
**一次**。`computeCatAiTrajectory`(Hard) 在回合开始调用 `planHardCatTurn` 恰好一次（F1B-7-B 用 spy 断言 **1 次**）；内部 iterative deepening 属同一 planner 调用。绝无 per-step 独立搜索。

### 2.6 deadline 如何工作（F1B-9）
复用 F1A-2：`deadlineMs = now() + timeBudgetMsPerCatTurn`（整回合同一 deadline，非每步 100ms）。检查点在 `_search` 内（每 64 nodes 采样一次），能中止正在进行的 depth；超时 → `completed=false`，返回最后 fully-completed depth，**不写 TT**。本阶段配置 `timeBudgetMsPerCatTurn: 100`。

### 2.7 evaluateForCat 如何接入（F1B-6）
`hardTurnPlanner.ts` 默认 `leafEvaluator: evaluateForCat`（`opts.leafEvaluator ?? evaluateForCat`）。`expectiminax` 的 `defaultLeafEval` 完全不动，仅当未注入时作为 standalone 默认。grep 证明见 §4。

### 2.8 fallback 条件与次数（F1B-4/F1B-9）
生产轨迹 fallback 条件（全部显式记录，禁止静默）：
- 搜索连 depth1 都没完整完成（deadline/maxNodes 全耗尽）→ `SEARCH_FALLBACK reason=no_hard_plan`
- 计划 action 与实际 state 不匹配 / action 非法（`applyPlanCatAction` 返回 valid=false）→ `SEARCH_FALLBACK reason=plan_action_invalid`
- 计划提前耗尽（计划 action 用尽但猫回合未结束）→ `SEARCH_FALLBACK reason=plan_exhausted`（F1B-7-I2 覆盖）
- 空计划 → fallback legacy 单步
- fallback 后 legacy `catAiHard` 继续本回合剩余 moves（不死锁）。**生产 benchmark 12/12 fallback=0**（§6）。

其余 4 点（#9–#12）：
- **2.9 Temporary Retreat v2 结果** → §6.1（执行 trap→退让，dDist=+1，退让成立）
- **2.10 production tactical benchmark** → §6（12/12 strict、0 sound error）
- **2.11 平均/P95/最大整回合思考时间** → §6（avg=84.2 / P95=119.5 / max=119.5 ms，预算 100ms，≤1 个 64-node 采样粒度）
- **2.12 已知限制（如实登记）**
  - deadline 是每 64 nodes 采样一次的软停，单次场景下最大实际思考可比预算多约一个采样窗口（≤约 20ms，此处 max=119.5ms 对 100ms 预算即此效应）；
  - 若时间不够完成较浅 depth，如实返回较浅结果（本阶段未提高正式预算）；
  - **plan 提前耗尽**（计划 action 全部执行完但猫回合仍未结束，例如计划比 catMovesLeft 短）：已改为**显式** `SEARCH_FALLBACK reason=plan_exhausted`（日志含 plan_len / remaining_moves），随后 legacy AI 安全完成剩余猫回合 —— 不再静默 fallback（新增 F1B-7-I2 regression：不 crash、不 freeze、回合完成、reason 精确匹配）；
  - F1B 未做 self-play / MCTS / 更深的性能调优（按冻结要求）。

---

## 3. 新增自动测试（F1B-7，12 条）

| ID | 覆盖 | 验证 |
|---|---|---|
| F1B-7-A | Difficulty routing | Easy/Medium/Hard 均合法；Hard 为 Search |
| F1B-7-B | One search per turn | spy `planHardCatTurn` → 恰好 1 次 |
| F1B-7-B2 | iterative 一次返回全 cat-turn plan | plan 全为 catStep/catPlaceTrap |
| F1B-7-C | 多 catStep 计划，Mouse 切换即停 | 逐 action 重放，切换点在最后 |
| F1B-7-D | 0-cost trap 不消耗 moves | engine+重放+计划语义三重检查 |
| F1B-7-E | Push：重放真实 engine board | box count 守恒 |
| F1B-7-F | 陷阱回收（真实 engine）| `catMove` 踩回 → trap+1 |
| F1B-7-G | Early capture 终止轨迹 | capture 后无多余 step |
| F1B-7-H | 立即 deadline → clean no-solution | fallback，不 null/crash/freeze |
| F1B-7-I | 非法计划触发 SEARCH_FALLBACK | 注入 mouseStep 计划 → 日志含 SEARCH_FALLBACK |
| F1B-7-I2 | plan 提前耗尽 → 显式 fallback | 注入短计划 → `reason=plan_exhausted`，legacy 安全完成剩余回合 |
| F1B-7-J | Determinism | 同 state+同 budget → 同 plan/best/value |

<small>（F1B-7-I 还验证了 plan integrity：`searchBestAction` 只返回 cat 合法动作。）</small>

---

## 4. evaluateForCat 接线 grep 证明

```
hardTurnPlanner.ts: import { evaluateForCat } from './evaluation';
hardTurnPlanner.ts: leafEvaluator: opts.leafEvaluator ?? evaluateForCat,
expectiminimax.ts:   export function defaultLeafEval(...)   // 保留
expectiminimax.ts:   return ctx.leafEvaluator ? ctx.leafEvaluator(state) : defaultLeafEval(state);
```
→ Hard production 用 `evaluateForCat`；`defaultLeafEval` 仍是默认（测试/standalone）。

---

## 5. F0.1 Benchmark 回归

| | noTrap | production |
|---|---|---|
| budget-complete | 12/12 | 12/12 |
| STRICT == oracle best | Def=12 E1=12 MedBare=12 MedTraj=12 | Def=12 E1=12 MedBare=12 MedTraj=12 |
| SOUND errors | 0 | 0 |

**无回归。** 注：`MedBare`（裸 `catAiMove`）在 F1B 后对 Hard 也走 Search planner → 原 boxBlock NULL 假阴性消失（F0.1 §3.3 的残留点已由 Hard 接线消除）。

---

## 6. F1B production-route benchmark（§ 门禁 7）

生产入口 `computeCatAiTrajectory`（Hard）跑 12 个 F0.1 production fixtures：

```
strictPass=12/12   soundOK=12/12   fallbackCount=0
thinkTime(ms): avg=84.2  P95=119.5  max=119.5   （预算=100ms；≤1 个 64-node 采样粒度）
searchCallsPerTurn = 1 / 每 turn
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
| trapValue | **catPlaceTrap**（并列最佳） | OK | ok |

### 6.1 Temporary Retreat v2（单独）
- 执行路径：`catPlaceTrap`（0-cost，并列最佳）→ `ArrowLeft`（**dDist=+1，向远离鼠方向退一步**）→ …，stepDeltas=[+1,0,−1,−2]。
- **确认：Hard 确实执行了 distance-increasing 的退让移动（第一步 net +1），不是贪心追鼠。**（贪心会第一步 dDist<0 且是证明式败局。）

---

## 7. 测试规模

| 文件 | passed |
|---|---|
| `expectiminax.test.ts` | 82 |
| `evaluation.test.ts`（E0/E1 + corpus） | 25 |
| `searchInfra.test.ts` | — |
| `tunnels.test.ts` | — |
| **`hardIntegration.test.ts`（新）** | **12** |
| **合计** | **159** |

---

## 8. 修改清单

| 文件 | 变更 |
|---|---|
| `src/game/ai/expectiminimax.ts` | `createSearchContext(rules)` 必填（拆对 searchRules 顶层运行时依赖）；planBranches/capturePlan + buildCatTurnPlan；SearchResult/Iterative 增 catTurnPlan；迭代加深只在 completed 迭代快照计划 |
| `src/game/ai/hardTurnPlanner.ts`（新）| 生产 Hard 回合 planner（DI：注入 RuleSet；evaluateForCat；deadline；maxNodes；AB/TT/ordering） |
| `src/game/engine.ts` | createEngineRuleSet() 引擎侧适配器；catAiMove Hard→Search；computeCatAiTrajectory Hard→一次 planner+计划执行；applyPlanCatAction 校验；logFallback（SEARCH_FALLBACK）；import hardTurnPlanner + DEFAULT_SEARCH_CONFIG |
| `src/game/ai/__tests__/hardIntegration.test.ts`（新） | F1B-7 A–J（12 条，含 I2 plan_exhausted） |
| `f1bprodbench.mts`（新，测量） | F1B-8 production-route benchmark（可复现） |

## 9. 明确不做的
- 未进入 self-play / MCTS / 性能大优化；
- 未调 E1 weights / 未改 defaultLeafEval / 未改基础规则；
- 未在 engine 中 import `searchRules`（依赖注入保持无循环）；
- 未删除 Medium / 未做大重命名。

**F1B 到此结束。不进入后续自我对弈阶段。**