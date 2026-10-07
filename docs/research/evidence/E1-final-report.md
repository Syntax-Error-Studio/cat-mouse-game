# Phase E1 — Strategic Evaluation v1 · 最终验收报告

**日期：** 2026-08-19
**状态：** ✅ 全部 Final Verification 门禁通过。**停止于此**——不进入 E2 / Phase F，不“顺手优化”。

---

## 0. 冻结规则合规（全程未违反）

| 冻结项 | 本次是否触碰 |
|---|---|
| 不修改任何基础玩法 | ✅ 未触碰 |
| 不接 Hard 正式生产路径 | ✅ 未触碰（`defaultLeafEval` 仍是生产叶估值） |
| 不修改 Expectiminimax / Alpha-Beta / TT / Move Ordering | ✅ 未触碰 |
| 不继续重构 `engine.ts` | ✅ 未触碰 |
| 不清理无关代码 | ✅ 仅修 E1 自身代码 3 个 lint 错误（见 §1.4） |
| 不删除任何文件，直到最终验收完成 | ✅ 保留 `e1debug*.mts`；新增临时 `e1bench.mts`（验证用，非生产） |

---

## 1. Final Verification 门禁结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `git diff --check` | ✅ exit 0（无 whitespace 错误；仅有预存跟踪文件的 CRLF 警告，非阻塞） |
| 2 | `npx tsc --noEmit -p tsconfig.app.json` | ✅ exit 0（clean） |
| 3 | `npm test`（即 `vitest run`） | ✅ **136 passed (136)**，4 个测试文件，exit 0 |
| 4 | `npx eslint "src/game/ai/**" "src/game/rules/**"` | ✅ exit 0（clean） |

### 1.1 E1-N 澄清（审计第一步结论）
- **E1-N = “all existing 123 tests” 全量历史回归门禁**，不是新增的独立 `evaluation.test.ts` 测试函数。
- 因此 `evaluation.test.ts` 当前只显式编号 **E1-A ~ E1-M（13 条）是正确的**，无需为凑 E1-N 再增加重复单测。
- **验收方式 = 运行全量 `npm test` / `vitest run`，确认 E1 开始前已存在的 123 个测试无回归。** E1 新增后总测试数可以 >123（本次 = 136，恰为 123 基线 + 13 条 E1 测试）。
- 结论：**无缺口**，只是编号口径差异（原 N 落为全量回归门禁，由 E0-L + 冻结的搜索代码覆盖）。

### 1.2 全量回归（E1-N）
`vitest run` → **136 passed**。其中 E1 阶段新增 13 条（E1-A…E1-M）全部通过；原有 123 基线无回归。

### 1.3 测试文件规模
`evaluation.test.ts`：**25 passed**（E0-A…E0-L = 12；E1-A…E1-M = 13）。

### 1.4 eslint 修复说明（透明记录）
初始 `eslint` 在 **E1 代码内**报 3 个错误（非预存 UI 无关错误）：
- `evaluation.test.ts:430,448` — 未使用变量 `strategicChecks` / `strategicPass`；
- `evaluation.ts:684` — `let tempo = 0` 的无效初始化（两个分支都覆写）。

均为**纯 lint 修复、零行为变化**，仅为使步骤 4 门禁变绿。修复后 `eslint` exit 0。

---

## 2. E1-A ~ E1-N 对应测试

| ID | 覆盖的 E1 能力 | 测试函数（evaluation.test.ts） |
|---|---|---|
| E1-A | 隧道可达性语义（可达才算） | `E1-A. reachable tunnel semantics` |
| E1-B | 不可达隧道不给猫虚假收益 | `E1-B. unreachable tunnel gives NO false benefit` |
| E1-C | 携黄油 / 技能 隧道门控转移 | `E1-C. carry / skill tunnel transition` |
| E1-D | 两阶段胜路线（butter→hole，携黄油模式） | `E1-D. two-stage mouse win route` |
| E1-E | 两个黄油取更短胜路线 | `E1-E. two butter choices select the shorter winning route` |
| E1-F | 封死 butter/hole 路线 → null | `E1-F. blocked butter / hole route yields null win route` |
| E1-G | 洞口门控控制方向 | `E1-G. hole gate control margin direction` |
| E1-H | Voronoi 归一化（困住 vs 开阔，跨棋盘） | `E1-H. Voronoi normalization` |
| E1-I | Trap 改为鼠侧可达性 | `E1-I. trap reachable vs isolated (mouse-side)` |
| E1-J | Tempo 配对（同几何不同行动权） | `E1-J. tempo pair` |
| E1-K | corpus hard strategic 门禁 = 100% | `E1-K. hard strategic corpus gate = 100%` |
| E1-L | E1 特征集 purity / deepFreeze 回归 | `E1-L. purity / deepFreeze regression` |
| E1-M | 棋盘 5/10/20 边界与归一化 | `E1-M. board sizes 5 / 10 / 20 stay bounded` |
| **E1-N** | **全量历史回归门禁（123 基线）** | 由 `npm test` 全量 136 passed 覆盖（非单测函数） |

---

## 3. 37-case Corpus 结果

`EVALUATION_CORPUS` 现共 **37 个 case**（E0 阶段 23 → E1 扩展至 37）。

| 指标 | 结果 |
|---|---|
| corpus 总 case 数 | **37** |
| RULE pass / total | **48 / 48（100%）** |
| strategic **hard** pass / total | **11 / 11（100%）** |
| strategic **soft** pass / total | **7 / 12**（5 条 mismatch，仅报告，非门禁） |
| OBSERVATION | **2** |
| 是否存在 ignored / skipped case | **无**（全部 37 个均被求值） |

**confidence 分布（共 73 条 expectation）：** RULE 48 · hard 11 · soft 12 · observation 2。

**soft 5 条 mismatch（均为几何混淆，设计上仅记录）：**
`gate_cat_controls`、`gate_mouse_controls`（位置不同，被 capture/tunnel 因素混淆）、
`trap_isolated`、`trap_reachable`（pocket vs corridor 几何混淆 capture pressure）、
`voronoi_open_even`（开阔棋盘居中猫 vs 困住鼠，关系本身弱化）。
这些在 case 描述中已自注明“confounded”，不计入门禁。

---

## 4. 各 Feature 定义与贡献方向

`evaluateForCatDetailed` 返回 `{ total, features, contributions, clamped }`。
`total = Σ contributions`，钳制到 `[-HEURISTIC_LIMIT, +HEURISTIC_LIMIT]`（=±10 000）。

| 贡献 | 方向（高分=对猫有利） | 公式要点 |
|---|---|---|
| `capturePressure` | 猫越近鼠越高 | `-(catMouseDistance/boardSize)·w`；不可达 = `-w` |
| `mouseGoalThreat` | 鼠携黄油离洞越近越负（对猫越糟） | 携黄油：`-(w / dist)`；不携 = 0 |
| `butterRace` | 鼠离黄油越远越高（对猫越好） | `(mouseButterDistance/boardSize)·w` |
| `confinement` | 猫控面积比鼠大则高 | `(catRatio − mouseRatio)·w` |
| `mobility` | 猫机动性高于鼠则高 | `((catMob − mouseMob)/4)·w` |
| `trapControl` | 陷阱在鼠可达范围内且越近越高 | `max(0, 1 − dist/boardSize)·w`（仅 trap 激活且可达） |
| `tunnelControl` | 鼠有**可达**隧道则负（对猫糟）；不可达/无 = 0 | `-(tunnelEscape / max(1, accessDist))` |
| `holeControl` | 猫比鼠更先控门则高 | `clamp(holeControlMargin/boardSize, −1, 1)·w` |
| `voronoiBalance` | 猫控战略格多于鼠则高 | `(catArea − mouseArea)/strategicArea·w` |
| `tempo` | 猫回合且步数多则正；鼠回合则负 | `±((movesLeft差)/base)·w` |

所有特征在乘权重前已归一化到稳定区间（距离/棋盘规格、面积比、[-1,1]），故 5×5~20×20 不漂移。

关键原始特征（节选）：`catMouseDistance`、`mouseGoalDistance`（仅携黄油有效）、
`mouseButterDistance`、`mouseWinRouteDistance`（两阶段，不预测未来黄油）、
`mouseReachableArea`/`catReachableArea`、`openTunnelCount`/`blockedTunnelCount`、
`mouseCanReachTunnel`/`mouseTunnelAccessDistance`（可达性感知，非全局布尔）、
`holeControlMargin`、`voronoiBalance` 等。

---

## 5. Weights（集中化，无魔法数）

`DEFAULT_EVALUATION_WEIGHTS`（唯一来源，所有贡献只引用 `weights.*`）：

| 权重 | 值 |
|---|---|
| capturePressure | 900 |
| mouseGoalThreat | 1100 |
| butterRace | 700 |
| confinement | 1100 |
| mobility | 250 |
| trapControl | 600 |
| tunnelEscape（→ tunnelControl） | 900 |
| holeControl | 500 |
| voronoiBalance | 600 |
| tempo | 200 |

---

## 6. Hard / Soft / Confidence 规则

- **RULE（硬不变量）**：必须满足，corpus 断言 `rulePass === ruleChecks`，失败即 suite 失败。例：携黄油后隧道不可用、封死路线返回 null、cat 图排除洞口/隧道/黄油。
- **STRATEGIC hard（近无争议战略关系）**：corpus 断言 `hardStrategicPass === hardStrategicChecks`（11/11）。例：猫离鼠越近越利猫、可达隧道比不可达更利鼠、困住鼠利猫、携黄油近洞利鼠。
- **STRATEGIC soft（合理但受几何混淆）**：仅 `console.warn` 记录，**不进门禁**（7/12）。用于后续调权参考，不锁死 AI。
- **OBSERVATION**：仅记录分数，无对错（2 条）。

---

## 7. 双口径 Benchmark（§16）

> 仅测量，不接线。B2 把 `evaluateForCat` 注入为搜索叶估值仅为测成本。

| 口径 | 配置 | 结果 |
|---|---|---|
| **B1  evaluator-only / feature extraction** | 37 case × 100 iters = 3700 次 `evaluateForCatDetailed` | wall 235 ms → **≈0.064 ms/eval** |
| **B2  search-leaf / representative search** | openArena（猫4,4 / 鼠6,6 / moves 2,2 / depthTurns 3），TT+AB+ORDER ON，注入 `evaluateForCat` 为 `leafEvaluator` | completed=true，**506 leaf-evals**，nodes=1865，wall=150 ms，value=−1157（受 ±10 000 量程影响） |
| **B2 baseline（生产 `defaultLeafEval`）** | 同 fixture，不注入 | completed=true，nodes=994，wall=**29 ms**，value=190 |

**解读：** 新估值器在代表性搜索上约 **5× 慢于**生产叶估值（150 ms vs 29 ms），主因每次叶估值构建 3 张 O(棋盘) BFS 图（见 §8）。这是 Phase F 接线**前必须解决**的成本信号（距离图缓存/增量），**不是本阶段要修的项**。两口径值不可直接比较（量程不同），仅结构成本（leaf-evals / wall / nodes）有信息量。

---

## 8. BFS Diagnostics（§17 / §18）

| 指标 | 数值 |
|---|---|
| 每次 `evaluateForCatDetailed` 的 BFS 数量 | **固定 3 张**：mouse 图 1 + cat 图 1 + carrying-hole 多源图 1 |
| 平均 BFS / evaluate | mouse 1.00 · cat 1.00 · carry 1.00 |
| P95 BFS / evaluate | **3（恒定，无方差）** |
| 每次 evaluate 的 BFS delta 模式 | 唯一模式 `1,1,1`（37 case 全部一致） |
| 是否存在明显重复 BFS | **否** |

**机制（spec #17）：** `buildContext` 在一次求值内构建 3 张距离图，**仅一次**，随后特征提取、Voronoi、贡献计分全部复用同一 `EvaluationContext`，不在每个特征上重算 BFS。故无重复 BFS、无冗余图重建。

---

## 9. 当前未接 production 的证明（§19）

1. **代码层：** `expectiminimax.ts` **未 import** `evaluateForCat` / `evaluateForCatDetailed`（grep 确认）。活叶估值走 `ctx.leafEvaluator ? ctx.leafEvaluator(state) : defaultLeafEval(state)`（line 486），而生产路径**从不**传入 `leafEvaluator` → 始终 `defaultLeafEval`。
2. **测试层：** `E0-L` 证明搜索在 E1 后仍返回 `defaultLeafEval` 的值（180）且用 `defaultLeafEval`；110+ 旧搜索/转置/AB/排序/迭代深化测试全绿，无 AI 决策回归。
3. **模块注释：** `evaluation.ts` 顶部明确 `STILL NOT WIRED (spec #19)`：`evaluateForCat*` 仅用于测试/benchmark，不进生产搜索。
4. **行为层：** `npm test` 136 passed，确认无任何 AI 行为变化。

---

## 10. 各独立验收项小结

| 项 | 结论 |
|---|---|
| §11 EvaluationWeights 集中化 | ✅ `scoreFeatures` 仅引用 `weights.*`；仅出现归一化字面量（boardSize、/4、clamp），**无魔法计分常数** |
| §16 双口径 benchmark | ✅ 见 §7 |
| §17 / §18 BFS diagnostics | ✅ 见 §8（每 eval 恰好 3 BFS，无重复） |
| §19 production wiring isolation | ✅ 见 §9 |
| shared tunnel kernel | ✅ 见 §11 |

### 11. Shared Tunnel Kernel（§shared）
- **唯一** `chooseTunnelExit` 实现位于 `src/game/rules/tunnels.ts:26`，被以下**全部**共用：`engine.ts`、`evaluation.ts`、`GamePage.tsx`、`TutorialPage.tsx`、`simulator.ts`、`defaultRuleSet`（`searchRules.ts`）。
- engine 与 evaluator **共用同一份** `rules/tunnelRules` 助手：`getTunnelCorners` / `isTunnelUsable` / `isMouseTunnelEntryAllowed` / `getMouseHoleGateCells`。
- **无第三份隧道规则复制**（grep 确认仅 `tunnels.ts` 一处定义）。

---

## 12. 已知限制（明确记录，不在本阶段修）

1. **接线成本：** 若接入正式搜索，新估值器约 5× 慢（BFS O(棋盘) 每叶）。Phase F 前需距离图缓存/增量。
2. **soft 5 条 mismatch：** 几何混淆导致，设计上仅记录，不锁 AI。
3. **Voronoi v1：** 仅战略格“谁先到”面积比，未做可达性加权领地细化。
4. **两阶段 planner：** 只用当前 `butterPositions`，**不预测未来黄油刷新**（设计使然，符合确定性要求）。
5. **tunnelControl：** 已用可达性感知的 `mouseCanReachTunnel` 驱动贡献（修复了 E0 的全局布尔连累），但 `mouseTunnelAllowed` 本身仍含全局标志语义；不可达情形现已正确归零。
6. **未接 Hard 生产路径：** `defaultLeafEval` 仍是线上叶估值，新估值器是并行地基。

---

## 13. 下一阶段建议（**仅建议，禁止直接开始**）

1. **Phase F 接线决策**：将 `evaluateForCatDetailed` 注入为搜索叶估值前，**必须先做距离图缓存/增量**（消除 §12.1 的 5× 成本），否则会拖慢搜索。
2. **权重调优**：基于 11 条 hard + 12 条 soft 关系（尤其 5 条 soft mismatch）做有依据的权重校准。
3. **Voronoi 细化**、**两阶段 planner 边界 case**、**洞口门控更细粒度**（角落/边/开阔三态，源自 Legacy Hard 盘点）。
4. **回归比对**：接线后用相同 corpus 对比新估值器与 `defaultLeafEval` 的行为差异。

> **停止点：** E1 Final Verification 完成。不进入 E2，不开始 Phase F，不“顺手优化”。等待用户显式批准下一阶段。
