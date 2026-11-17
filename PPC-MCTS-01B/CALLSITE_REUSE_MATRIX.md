# PPC-MCTS-01B-PHASE0｜UCT 调用点复用矩阵

审计对象：`PPC-MCTS-01/proto/uct.ts`（**只读，未改动**，SHA256 `508a65bf53b63555bc4d3f8de7199b8607a8544572bb0e55850445cdffa2c53a`）。

**归一化口径**：`C` = 某状态的候选动作数（= 枚举长度）；`L` = 其中合法数（`L ≤ C`）。所有计数都是**规则内核调用次数**（`mouseStep`/`catMove`/`mouseSkill`/`catPlaceTrap`/`chooseTunnelExit`），不含 `endTurn`/`enumerateButterSpawns`。

---

## 1. 五个调用点逐个审计

### A. 树展开（`uct.ts:409-418` + `applyEdge:456-481`）

```ts
// 409-418  一个 decision 节点第一次被访问
if (!cur.expanded) {
  cur.legalActions = generateLegalSearchActions(cur.state, this.opts.rules); // C 次模拟
  cur.childNodes  = cur.legalActions.map(...);                                // 边，无模拟
  cur.expanded = true; continue;
}
// 456-481  每条边第一次被选中时
const res = simulateSearchAction(parent.state, edge.action, this.opts.rules);  // 1 次模拟
```

| 维度 | 现状 | 复用后 |
| --- | --- | --- |
| 模拟次数 | `C`（合法性）+ 每条已materialize的边 1 次 = `C + E` | `C`（批次同时产出转移） |
| 可否复用 | **可以**，且这是收益最确定的一处 | — |
| 需不需要 clone | **不需要**。转移状态本来就是这条边的子节点状态；今天 `applyEdge` 产出的状态与复用产出的状态逐字段相同（Q3，31 391/31 391） | — |
| 生命周期风险 | **有，且是新增的**：批次把 `C` 个后继状态同时保活，而今天只有被 materialize 的子节点保活。**批次必须节点局部、用完即弃**，不得挂在节点上跨 simulation 留存 | 见 R2 |
| 随机数消费顺序 | **不影响**。`generateLegalSearchActions` / `simulateSearchAction` / `applyEdge` 都不碰 `policyRng`/`chanceRng`（`uct.ts:260-261` 两个流只在 `selectEdge:515`、`selectRolloutAction:230/244`、`sampleChance:382/548` 被消费） | 相同 |
| CHANCE outcome 顺序 | **不影响**。`validateChance` 做 `outcomes.slice()`（`chance.ts:47`），保序；`makeChanceNode:179` 按数组顺序建 `chanceOutcomes` | 相同 |
| 结果能否完全一致 | **能**，前提是 R1（转移纯函数）+ R4（保留交叉验证 gate） | — |

> **注意 A 的一个副作用**：`applyEdge:462-465` 的 `illegal no-op edge reached the tree` 断言，今天的实际作用是"用第二次模拟复核第一次"。复用后它恒不可达。这是**安全性净损失**，必须用测试期 gate 补回来（R4）。

### B. Rollout 的合法动作生成（`uct.ts:540-543`）

```ts
const actions = generateLegalSearchActions(state, this.opts.rules);              // C
const action  = selectRolloutAction(state, actions, this.opts.rollout, ...);     // hybrid: L（见 C）
const res     = simulateSearchAction(state, action, this.opts.rules);           // 1
```

| 维度 | 现状 | 复用后 |
| --- | --- | --- |
| 每步模拟次数 | `C + (hybrid ? L : 0) + 1` | `C` |
| 可否复用 | **可以**。这是全部重复的大头（占本轮实测规则调用的 58 %） | — |
| 需不需要 clone | **不需要** | — |
| 生命周期风险 | 低。批次只在这一次 rollout 步内需要；`actions` 数组本身今天也是临时的 | — |
| 随机数消费顺序 | **不影响**。执行时刻的 `chanceRng` 抽取（`548`）发生在同一次循环迭代的同一点；复用只改变"转移从哪来"，不改变"何时抽、抽几次" | 相同 |
| CHANCE outcome 顺序 | **不影响**，但**必须**用被选中动作自己的转移去抽样（复用后该转移与今天 `543` 行现算的转移逐字段相同） | 相同 |
| 结果能否完全一致 | **能** | — |

### C. `guidanceValue`（`uct.ts:209-220`，被 `selectRolloutAction:236` 调用）

```ts
const res = simulateSearchAction(state, action, rules);        // 1
if (res.kind === 'deterministic') return evaluateLeaf(res.state);
const v = validateChance(res.outcomes);                        // 保序 slice
let acc = 0;
for (...) acc += v.weights[i] * evaluateLeaf(v.outcomes[i].state);   // 全部正概率 outcome
```

| 维度 | 现状 | 复用后 |
| --- | --- | --- |
| 模拟次数 | 每个**合法候选** 1 次 | **0**（读批次里的转移） |
| 可否复用 | **可以**，这是第二个大头 | — |
| 需不需要 clone | **不需要** | — |
| 生命周期风险 | 无（只读） | — |
| 随机数消费顺序 | **不影响**。`guidanceValue` 自身**不消费任何 RNG**；它只产出数值，`selectRolloutAction` 的 `rng.int` 调用次数与位置由"并列最优集合的大小"决定 | 相同（值相同 ⇒ 并列集合相同） |
| CHANCE outcome 顺序 | **不影响，但合同要求写死**：必须遍历**全部**正概率 outcome、按**原有权重**加权。复用保持同一数组（序与权重已逐项验证全等），因此加权期望**逐位相同** | 相同 |
| 结果能否完全一致 | **能**。注意 `selectRolloutAction:229` 的单动作短路（`actions.length === 1` 时根本不调 guidance）必须保留——它决定 `L` 的实际值 | — |

> **不能做的事**：为了省成本而"只取 top-k outcome"或"按权重抽样代替全加权"。那会改变 `guidanceValue` 的数值，进而改变并列集合、进而改变 `policyRng` 的消费，属于**语义变更**，不在本轮允许范围。

### D. 选定动作的实际执行（三处）

| 位置 | 代码 | 现状 | 复用后 |
| --- | --- | --- | --- |
| Rollout 执行 | `543` | 现算 1 次 | 用 B 的批次里被选中那一项 |
| 计划补全执行 | `634` | 现算 1 次 | 用 E 的批次里被选中那一项 |
| 树边兑现 | `461` | 现算 1 次 | 用 A 的批次里那一项 |

- 需不需要 clone：**不需要**。
- 生命周期风险：低。但 **CHANCE 分支**要注意：`makeChanceNode` 会新建 `{state, weight, samples, child}` 包装对象（`169-189`），`samples++`/`child=` 写在**包装**上，不写在转移上。所以转移可以被多个消费者共享而不会被"记账"污染。
- 随机数消费顺序：
  - 确定性转移动不消费 RNG；
  - CHANCE 转移在 `548`（rollout）与 `382`（树内 chance 节点）各消费一次 `chanceRng`，位置与次数与复用无关；
  - `sampleWeighted`（`seededRng.ts:74-83`）按数组顺序累加权重，故**只要 outcome 顺序不变、权重不变，抽到的下标就不变**（已证）。
- 结果能否完全一致：**能**。

### E. 计划提取 / 补全（`uct.ts:598-647`）

两段，性质完全不同：

| 段 | 代码 | 是否模拟 | 复用结论 |
| --- | --- | --- | --- |
| principal line 走向 | `603-624` | **完全不模拟**，只沿"最访问子节点"走 | **无需改动**，也不该改（改了就是改计划提取语义） |
| 补全循环 | `629-645` | `generateLegalSearchActions`(C) + `selectRolloutAction`(hybrid L) + `simulateSearchAction`(1) | 与 B/C/D 完全同构，可整段复用 |

- 需不需要 clone：**不需要**。
- 生命周期风险：低。补全循环里 `state` 是逐步前进的局部变量；复用后仍然要靠"被选中动作的转移"前进，链条不变。
- 随机数消费顺序：**不影响**。`this.policyRng` 在 `selectRolloutAction` 内消费；值相同 ⇒ 消费相同。
- CHANCE outcome 顺序：**不影响**。`res.kind === 'chance'` 时"保留该动作、在交接处结束计划"（`637-641`）的逻辑必须保留。
- **必须原样保留的计量**：`extensionSteps`（`640`、`643`）与 `planExtended`（`646`）。`PILOT_COMPLETION_REPORT.md` §6 明确 UCT-H 有 92.1 % 的回合靠补全，这个计数是区分"树证据"与"启发式补全"的唯一凭据，**不能因为复用而改变**。
- 结果能否完全一致：**能**。

---

## 2. 复用矩阵（总表）

| # | 调用点 | 位置 | 当前每次成本 | 复用后 | 可复用 | 需 clone | 生命周期风险 | 影响 RNG 顺序 | 影响 CHANCE 顺序 | 结果完全一致 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 树展开-合法性 | `uct.ts:410` | `C` | `C`（保留） | 不适用（是来源） | 否 | **中**：批次保活 C 个后继 | 否 | 否 | 是 |
| A' | 树展开-边兑现 | `uct.ts:461` | `1/边` | **0** | ✅ | 否 | 中（同上） | 否 | 否 | 是 |
| B | Rollout-合法性 | `uct.ts:540` | `C` | `C`（保留） | 不适用（是来源） | 否 | 低 | 否 | 否 | 是 |
| C | Rollout-Hybrid 引导 | `uct.ts:236→209` | `L`（hybrid）/ `0`（random） | **0** | ✅ | 否 | 低 | 否（引导不碰 RNG） | **必须保全部 outcome + 原权重** | 是 |
| D1 | Rollout-执行 | `uct.ts:543` | `1/步` | **0** | ✅ | 否 | 低 | 否 | 否（抽样仍消费一次） | 是 |
| D2 | 树边执行 | = A' | 见 A' | **0** | ✅ | 否 | 中 | 否 | 否 | 是 |
| D3 | 补全-执行 | `uct.ts:634` | `1/步` | **0** | ✅ | 否 | 低 | 否 | 否 | 是 |
| E1 | 计划走向 | `uct.ts:603-624` | 0 | 0 | 不适用 | 否 | 无 | 否 | 否 | 是（不动） |
| E2 | 补全-合法性 | `uct.ts:631` | `C` | `C`（保留） | 不适用（是来源） | 否 | 低 | 否 | 否 | 是 |
| E3 | 补全-引导 | `uct.ts:633→209` | `L`（hybrid） | **0** | ✅ | 否 | 低 | 否 | 同 C | 是 |

**结论：没有任何一个调用点需要 clone。** 需要的不是复制，而是**只读纪律**（R1/R2/R3）。

---

## 3. 实测：每类调用点各占多少

固定节点上限 `maxNodes=300`、`now: () => 0`（完全不看墙钟），4 个根 × 2 模式 = 8 次运行。归因方式：给 `RuleSet` 套一层计数器，从 `new Error().stack` 读出调用链并归档到具体调用点（**未归因 = 0**，说明矩阵没有漏掉任何一个产生规则调用的位置）。

| 调用点 | 规则调用数 | 占总量 | 复用后可省 |
| --- | ---: | ---: | ---: |
| `TREE_LEGALITY`（A） | 4 657 | 3.14 % | 保留 |
| `TREE_TRANSITION`（A'） | 2 392 | 1.61 % | **2 392** |
| `ROLLOUT_LEGALITY`（B） | 86 127 | 58.09 % | 保留 |
| `ROLLOUT_GUIDANCE`（C） | 32 435 | 21.87 % | **32 435** |
| `ROLLOUT_EXEC`（D1） | 22 664 | 15.28 % | **22 664** |
| `EXT_LEGALITY`（E2） | **0** | — | 未触发 |
| `EXT_GUIDANCE`（E3） | **0** | — | 未触发 |
| `EXT_EXEC`（D3） | **0** | — | 未触发 |
| `UNKNOWN` | **0** | — | — |
| **合计** | **148 275** | 100 % | **57 491** |

**总计：148 275 → 90 784（−38.77 %）。**

分模式：

| 模式 | 现状 | 复用后 | 相对节省 |
| --- | ---: | ---: | ---: |
| UCT-H（hybrid） | 80 243 | 36 987 | **−53.91 %** |
| UCT-R（random） | 68 032 | 53 797 | **−20.92 %** |

分调用点组：

| 组 | 现状 | 复用后 | 相对节省 |
| --- | ---: | ---: | ---: |
| 树展开（A + A'） | 7 049 | 4 657 | **−33.93 %** |
| Rollout（B + C + D1） | 141 226 | 86 127 | **−39.01 %** |

### 3.1 重复是"结构性的"，不是"偶然重复"

同一 `(state, action, fn)` 三元组在一轮搜索中被应用 **3.65 次**（148 275 ÷ 40 573 个互异三元组）。按"被哪些调用点碰过"分桶（同一三元组可能跨多次访问命中多个调用点）：

| 调用点组合 | 互异三元组数 | 复用后 |
| --- | ---: | --- |
| 仅 `ROLLOUT_LEGALITY` | 22 461 | 1（非法候选或未被选中，本就只模拟一次） |
| `ROLLOUT_EXEC + ROLLOUT_LEGALITY` | 9 106 | 1 |
| `ROLLOUT_GUIDANCE + ROLLOUT_LEGALITY` | 3 774 | 1 |
| `ROLLOUT_EXEC + ROLLOUT_GUIDANCE + ROLLOUT_LEGALITY` | 1 657 | 1 |
| 含 `TREE_LEGALITY + TREE_TRANSITION` 的组合 | 1 357 | 1 |
| 仅 `TREE_LEGALITY` | 4 | 1 |
| 其它混合 | 2 214 | 1 |

`ROLLOUT_EXEC + ROLLOUT_LEGALITY = 9 106` 就是"随机模式下被选中的动作被模拟两次"的直接证据；`+GUIDANCE` 的 1 657 是"hybrid 模式下被模拟三次"的证据。**这两组不需要任何推导，是实测出来的重复。**

---

## 4. 落地时必须同时满足的 7 条（摘要，理由见 `RECOMMENDATION.md`）

| 编号 | 约束 |
| --- | --- |
| R1 | 转移必须保持 `(state, action) → transition` 纯函数；复用不得跨越"状态被写过"的边界 |
| R2 | prepared 批次**节点局部、用完即弃**；不得挂到 `UctNode` 上跨 simulation 留存（内存与别名双重原因） |
| R3 | 批次与其转移一律**只读**。禁止在转移或 outcome 上写任何 per-visit 记账（`samples`/`visitCount`/`child` 必须写在包装对象上，如 `makeChanceNode` 现在所做） |
| R4 | 把 `applyEdge` 的 no-op 断言降级为**测试期交叉验证 gate**（复用版 vs 现算版逐字段对拍），不能直接删除 |
| R5 | `guidanceValue` 的 CHANCE 分支必须遍历**全部正概率 outcome**并保留**原有权重**；不得抽样、不得截断 top-k |
| R6 | 计划补全的 `extensionSteps`/`planExtended` 计量、以及"CHANCE 结果保留该动作并在交接处结束"的语义，原样保留 |
| R7 | 隧道出口可以继续模拟（PT-B-1），但要在注释里改正"legacy 也从不模拟"的措辞，避免下一轮把它当既有事实引用 |

---

## 5. 本轮不覆盖的部分（不要当成已验证）

- **树内 CHANCE**：8 次运行 `chanceNodes = 0`。A 组的 CHANCE 分支只有源码结论。
- **计划补全（E2/E3/D3）**：计数全为 0，只有源码结论。
- **墙钟收益**：−38.77 % 是"规则调用次数"，不是"时间"。省下来的调用能不能换成 simulation 数，必须下一轮实测（`RECOMMENDATION.md` §3）。
- **其它消费者**：`boundedPlanRefutation`、`forcedLossTieBreak`、`planQuality`、`turnBoundary`、`turnLazy`、`openingFairness` 仍调用 legacy generator，本轮不涉及。
