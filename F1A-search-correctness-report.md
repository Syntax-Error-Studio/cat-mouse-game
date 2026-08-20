# Phase F1A — Search Correctness Prerequisites · 最终验收报告

**日期：** 2026-08-20
**状态：** ✅ 三项 P0/P1 修复 + Trap oracle 探索 + 全部验证门禁通过。**停止于此**——不进入 F1B，不触碰 Hard 路由。

---

## 0. 冻结规则合规（全程未违反）

| 冻结项 | 本次是否触碰 |
|---|---|
| 修改 Hard 路由 / 生产行为 | ✅ 未触碰（未接 evaluateForCat 到生产、未新建 catAiSearch 入口、未实现 catTurnPlan） |
| 修改基础游戏规则 | ✅ 未触碰 |
| 优化 BFS | ✅ 未触碰 |
| 调 E1 weights | ✅ 未触碰 |
| Worker / WASM / MCTS / RL | ✅ 未触碰 |
| 删除 Medium | ✅ 未触碰 |
| 进入 F1B | ✅ 未进入 |

Easy / Medium / Hard 的生产行为保持现状。所有修改集中在 `src/game/ai/expectiminimax.ts` + 测试 + 测量脚本。

---

## 1. Final Verification 门禁结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `git diff --check` | ✅ exit 0（仅预存文件的 CRLF 警告，非阻塞） |
| 2 | `npx tsc --noEmit -p tsconfig.app.json` | ✅ exit 0（clean） |
| 3 | `npx eslint "src/game/ai/**" "src/game/rules/**"` | ✅ exit 0（clean） |
| 4 | `npm test`（vitest run） | ✅ **147 passed (147)**，4 个测试文件，exit 0 |
| 5 | F0.1 regression benchmark（f01oracle2.mts） | ✅ 两套 12/12 budget-complete、0 sound error（详见 §5） |

---

## 2. F1A-1 — 消灭 `searchValue` completion footgun（P0）

### 2.1 问题（F0.1 §2.1 单一根因）
`searchValue(state, depth, ctx): number` 返回纯 number，**静默丢弃 `completed`**。一旦共享预算耗尽，剩余子动作坍缩为静态叶评估，调用方无法察觉。F0 全部尺子问题源于此。

### 2.2 最终处理：**删除**（非保留 + 改返回类型）
审计结果显示 `searchValue` 无 production 必要性（`src/` 内仅测试引用；生产 Hard 路径未接线）。按用户给定优先方案：**删除 API，迁移所有调用者到保留 `completed` 的 API**。

| 迁移点 | 数量 | 迁移后 |
|---|---|---|
| `expectiminimax.ts` | 1 | 删除 `searchValue`；新增文档注释禁止以纯 number 返回搜索值 |
| `expectiminimax.test.ts` | 20 | `searchValue(...)` → `searchResult(...).value`（保留 completed/mate 可读） |
| `f0bench.mts`（oracle） | 1 | 改用 `searchResult` 并显式检查 `sv.completed`（不符合时 console.warn） |

现在模块唯一的值入口均暴露 `completed`：
- `searchResult(...)` → `InternalSearchResult`（含 `completed` / `cacheable` / `mate`）
- `searchBestAction(...)` → `SearchBestActionResult`（含 `completed`）
- `searchBestActionIterative(...)` → `IterativeSearchResult`（含 `completed` / `completedDepth`）

### 2.3 新增测试（2 条）
- **F1A-1.** no bare-number public search entry point remains —— 运行时断言模块不再导出 `searchValue`（`vi.importActual` + `typeof === 'undefined'`），类型层 import 也会直接编译失败。
- **F1A-1.** incomplete search cannot masquerade as complete —— `searchResult` / `searchBestAction` / `searchBestActionIterative` 三者在预算截断时都必须如实报 `completed=false`（含 `bestAction=null`、`completedDepth=0`）。

---

## 3. F1A-2 — 真实 wall-clock deadline（P0）

### 3.1 API
```ts
interface SearchContext {
  deadlineMs?: number;   // 绝对单调时钟截止时刻（与 `now` 同时间基准）
  now?: () => number;    // 时钟注入；生产默认 performance.now()（无则 Date.now()）
}
```
迭代加深入口同步透传：
```ts
interface IterativeSearchOptions { deadlineMs?: number; now?: () => number; }
```
结果新增 `deadlineExceeded: boolean`（区别于 `budgetExhausted`），`IterativeSearchDiagnostics.deadlineExceeded` 同步暴露。

### 3.2 实现要点
- 检查点位于 `_search` 内部（`expectiminimax.ts` 第 4b 步），**能中止正在运行的 depth**，不是只在迭代加深层间检查。
- 复用现有 `maxNodes` abort 通路：`{ value: evaluateLeaf(...), completed: false, cacheable: false, mate: null, bound: 'exact' }`。
- 时钟采样频率 `DEADLINE_CHECK_INTERVAL = 64` 节点（导出常量），避免每节点 `now()` 热点；不做性能调参。
- 超时行为：
  - 当前 attempted depth → `completed=false`；
  - 丢弃该 depth 的 partial root result；
  - 返回最后一个 fully-completed depth 的结果；
  - 若 depth1 都未完成 → 明确的 incomplete/fallback（`completedDepth=0`、`bestAction=null`、`completed=false`）；
  - **不写入当前 incomplete node 的 TT entry**（`storeTT` 的 `completed && cacheable` gate 天然拦截；deadline 不退道）；
  - 已完整搜索完的独立 subtree TT entry 保留（有效结果不受影响）。

### 3.3 fake-clock 测试（A–F，5 条测试函数，全绿）
| 需求 | 测试 | 验证点 |
|---|---|---|
| A. deadline 在 depth 中途触发 | `F1A-2-A` | 时钟已越限 → 首个节点即中止，`deadlineCutoffs>0`、`completed=false`、值为 static-eval |
| B. attemptedDepth > completedDepth | `F1A-2-B/C` | deadline=2（第 2 次采样）→ depth-2 中途被杀，`attempted=2 > completed=1` |
| C. 返回结果来自最后完整 depth | `F1A-2-B/C` | 返回值/动作 == 直接 depth-1 搜索，绝不取 depth-2 partial |
| D. partial root best 不泄漏 | `F1A-2-D` | `bestAction`/`value`/`mate` 全部等于 depth-1 直搜 |
| E. incomplete node 不进入 TT | `F1A-2-E` | `tt.get(stateKey(root)) === undefined`，且 `ttStores === 0` |
| F. maxNodes 与 deadline 语义一致 | `F1A-2-F` | 两路径 `completed=false`、`cacheable=false`、static-eval 值；distinct abort cause 标志 |

`deadlineCutoffs`（新增诊断计数器）使测试可区分两种 abort 来源。

---

## 4. F1A-3 — 修正 mate distance 的游戏语义（P1）

### 4.1 mateActionCost 语义表（新增 `mateActionCost(action)`，唯一计费来源）
| SearchAction | mateActionCost | 依据（GAMEPLAY） |
|---|---|---|
| `catStep` | **1** | 猫走一步消耗 1 move |
| `mouseStep` | **1** | 鼠走一步消耗 1 move |
| `catPlaceTrap` | **0** | §4.3 放陷阱不消耗步数 |
| `mouseSkill` | **0** | §3.3 技能消耗黄油，不消耗 move |
| `chooseTunnel` | **0** | §3.4 传送出口选择本身免费（鼠已经为到达隧道付过步数） |
| chance node | **0**（不额外计费） | 期望值展开不加额外层；底层触发它的 mouseStep 已在父边按 1 计费 |

### 4.2 重构
- `stepScore(score, cost=1)` / `unstepScore(score, cost=1)`：以动作真实成本加减 mate 距离。
- `stepChildForParent(child, cost)` / `stepBoundForParent(bound, cost)` / `unstepBoundForChild(bound, cost)`：同接口，默认 1 保持 D2-B 往返证明不变。
- `searchActions` 循环内：`edgeCost = mateActionCost(pa.action)`，**每边缘取各自成本**（不再统一 ±1）。

### 4.3 新增测试（4 条）
- mateActionCost 映射表（5 类动作精确值）。
- stepChild/stepBound 在 cost=0/1 的往返；cat/mouse 双方向 0 成本不改变 mate 距离。
- **production trap fixtures regression**：3 个 A-mateWin 走廊 fixture 中 `catPlaceTrap` 值**等于**最佳 catStep（不再 best-1）。
- 真实移动计费回归（更快赢优先 / 更晚输更可拖延仍成立）。

### 4.4 9/9 trap mate 偏差修复前后
F0.1 §3.4 实测 9 个 A-mateWin fixture：`catPlaceTrap` 相对最佳走步**恰好低 1 分**（零例外）。修复后复跑：

| fixture | 修复前 trap | 修复后 best / trap | diff |
|---|---|---|---|
| immediateCatch1 | 999998 | 999999 / 999999 | **0** |
| immediateCatch2 | 999997 | 999998 / 999998 | **0** |
| corridorMate2 | 999997 | 999998 / 999998 | **0** |
| openChase | 999995 | 999996 / 999996 | **0** |
| emergencyHoleDefense | 999997 | 999998 / 999998 | **0** |
| skillThreat | 999997 | 999998 / 999998 | **0** |
| tunnelThreat | 999997 | 999998 / 999998 | **0** |
| trapValue | 999988 | 999989 / 999989 | **0** |
| temporaryRetreat_v1_INVALID | 999997 | 999998 / 999998 | **0** |

**结论：catPlaceTrap 不再因零消耗动作凭空把 mate 推迟 1。零例外。**

---

## 5. F1A-4 — Trap oracle：terminal-proof fixture 搜索

### 5.1 目标（evaluator-independent）
- (A) `catPlaceTrap` 是唯一 forced-win root action；或
- (B) `catPlaceTrap` 是唯一避免 forced-loss 的 root action。
必须由真实 terminal/mate 证明（`mate` 分类），**不得**用 `evaluateForCat` 的 trapControl 自证。

### 5.2 探索方法与范围
- 复用 F0.1 几何族：**two-lane**（双门洞口）与 **corridor**（死胡同 + 洞口）两个族；
- depth-6、**per-action 独立预算**（100k nodes/action）、**仅采信 fully-completed（allComplete=true）深度**；
- 对 two-lane：猫在 4 个位置 × 鼠标在 lanes（行 3–4、列 1–7）内全部非重叠位置穷举（2×7 全覆盖 ×4 猫位）。

### 5.3 结果（诚实结论）
**在当前已搜索的 two-lane / corridor 几何族，depth-6 且 fully-completed 范围内，尚未找到 terminal-proof trap fixture。**

- 全部 `allComplete=true` 样本中，`catPlaceTrap` 均与至少一个移动动作并列最优（multi-best=cat），从未形成唯一 forced-win；
- 未观察到任何「trap 唯一避免 forced-loss」样本（B=false 全样本）；
- 结构性原因仍在：陷阱必须放在猫当前格（否则只烧掉鼠一回合，不直接捕获）→ 「猫身体 + 陷阱双封」在实际上必须猫站在某格再离开，而该位置若已被身体封锁，身体本身即可同样封锁 → 陷阱难以成为「唯一」决定性动作。

**该结果只表示「本次已搜索范围内尚未找到证明样本」。不得推出**：陷阱无战略价值 / terminal-proof fixture 不存在 / `catPlaceTrap` 永远与身体封锁等价。**未为制造 fixture 修改权重、规则或人工构造 oracle。**

保留 regression：修复 zero-cost mate accounting 后，`catPlaceTrap` 不再因免费动作本身机械性落后最佳移动 1 分（§4.4）。

### 5.4 产物
- `f1a4trapsearch.mts`：可复现的探索脚本（`npx vite-node f1a4trapsearch.mts`）。

---

## 6. 测试规模

| 文件 | 数量 |
|---|---|
| `expectiminimax.test.ts` | 82（D0–D4 71 + F1A-3 ×4 + F1A-1 ×2 + F1A-2 ×5） |
| `evaluation.test.ts` | 25（E0/E1，未触） |
| `searchInfra.test.ts` | 未变 |
| `tunnels.test.ts` | 未变 |
| **总计** | **147 passed (147)**，4 文件 |

新增测试 11 条：F1A-1 ×2、F1A-2 ×5、F1A-3 ×4。全部包含在 147 内。

---

## 7. F0.1 Benchmark 回归（§ 门禁 5）

复用「采信的 oracle」`f01oracle2.mts`（每动作独立预算 + commonCompletedD+ + budget-fair 排名）：

| | noTrap | production |
|---|---|---|
| budget-complete rankings | **12/12** | **12/12** |
| classA / classB | 10 / 2 | 10 / 2 |
| STRICT == oracle best set | Def=12 E1=12 MedBare=11 MedTraj=12 | Def=12 E1=12 MedBare=11 MedTraj=12 |
| SOUND errors (evaluator-indep) | **0 / 0 / 1(known) / 0** | **0 / 0 / 1(known) / 0** |

与 F0.1 基线完全一致（唯一「MedBare=1」仍是 `boxBlock` 上裸 `carMove` 返回 NULL 的已知 pre-existing 假阴性，F0.1 §3.3 已文档化）。**无回归。**

复现命令：
```bash
F01_ORACLE_DEPTH=6 F01_PER_ACTION_NODES=60000 F01_DEPTH=3 npx vite-node f01oracle2.mts > f1a-oracle2.json
node f01oracle2sum.cjs f1a-oracle2.json
# 9 个 trap fixture 修复前后对照（production）
node -e "const d=require('./f1a-oracle2.json');…"
```

---

## 8. 修改清单

| 文件 | 类型 | 变更 |
|---|---|---|
| `src/game/ai/expectiminimax.ts` | production | 删除 searchValue；新增 mateActionCost + cost 参数；deadlineMs/now + deadline 中止；iterative deadline 透传 + deadlineExceeded；新增 DEADLINE_CHECK_INTERVAL 常量 |
| `src/game/ai/__tests__/expectiminimax.test.ts` | test | 20 处 searchValue→searchResult().value；新增 11 条 F1A 测试；D1-Purity 测试改搜 completed |
| `f0bench.mts` | benchmark | searchValue→searchResult + completed 显式检查 |
| `f01oracle2.mts` | benchmark（oracle） | stepMath action成本（stepChildForParent 传 cost） |
| `f1a4trapsearch.mts` | 测量脚本（新增） | trap fixture 探索（复现 §5.2/§5.3 结论） |

`f1a-oracle2.json`/`.err` 为本轮 F0.1 回归输出（可复现）。

---

## 9. 明确不做的（重申）

- 未修改 Hard 路由
- 未接 `evaluateForCat` 到生产 Hard
- 未新建 catAiSearch 生产入口 / 未实现 catTurnPlan
- 未优化 BFS / 未调 E1 weights / 无 Worker/WASM/MCTS/RL
- 未删除 Medium
- 未进入 F1B

**F1A 到此结束。不进入 F1B。**