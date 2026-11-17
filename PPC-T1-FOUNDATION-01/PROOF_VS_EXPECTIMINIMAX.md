# PROOF_VS_EXPECTIMINIMAX — 两个问题、两种语义、一张必须显式的转换表

本文件回答三个问题：

1. 离线量词证明（`seal_lib.ts`）到底在证什么？
2. 它和 Expectiminimax 的深度/叶/CHANCE 语义如何对应？
3. 哪些对应是**不可证**的，必须标 `UNKNOWN`？

**一句话**：两者共用同一套真实转移与 actor 切换计数，但**问的是不同的问题**：
Expectiminimax 问“在静态叶与有限深度下，期望值哪个高”；
量词证明问“在一个明确 horizon 内，某个玩家是否存在一个策略，使得对**所有**对手策略和
**所有**正概率随机结果都满足目标”。期望高不等于全分支安全；`!mouseForce` 不等于 `catSurvive`。

---

## 1. 量词内核的四个 mode

`solve(game, root, H, startIdx, cap, mode)`（`seal_lib.ts:77-161`）支持：

| mode | 量词 | 终局成功条件 | horizon 处成功条件 | 存在策略的一侧 |
|---|---|---|---|---|
| `mouseForce` | `∃σ_m ∀σ_c ∀chance → MouseWins` | `MouseWins` | `false`（撑过 horizon 不算鼠胜） | 鼠 |
| `catSurvive` | `∃σ_c ∀σ_m ∀chance → ¬MouseWins` | `CatWins` | **`true`**（撑过 horizon 即存活） | 猫 |
| `catForce` | `∃σ_c ∀σ_m ∀chance → CatWins` | `CatWins` | `false` | 猫 |

节点语义：

- 存在侧（鼠 in `mouseForce`，猫 in `catSurvive/catForce`）= **OR**；
- 全称侧 = **AND**；
- CHANCE = **AND over 所有正概率 outcome**（`weight>0`），在三个 mode 中都不变；
- 截断：猫节点 `idx >= 2*H`（`seal_lib.ts:101`）；`idx` 只在 actor 切换时 +1（`124-125`）；
- 终端**先于** horizon（`96-101`）；
- 节点数超过 `cap` → `null` = **UNRESOLVED**；任何未决分支上的 null 都会上传，
  除非 OR 已找到 true / AND 已找到 false（`132-151`）；
- memo 键 `${idx}|${stateKey}`，`stateKey` 是注入式单射地形编码，不含时间/浮点。

> **H 的命名**：工件里的标签 H0 对应参数 `H=1`，H1 对应 `H=2`。
> 截断是 `idx >= 2H`，所以 H0 在猫 idx≥2 截断、H1 在猫 idx≥4 截断。
> （若调用 `H=0`，猫根 `idx=0>=0` 会立即截断，因此 H0=1 才是最小非平凡视野。）

---

## 2. 证书验证器证什么

`verifyCatCertificate` / `verifyMouseCertificate`（`seal_lib.ts:235-382`）：

- **不调用** `solve`；
- **不共享**证明器的布尔组合子；
- **不使用**任何 reachability prune；
- 在每个全称节点重新枚举**全部**合法对手动作；
- 在每个 CHANCE 节点重新枚举**全部**正概率 outcome；
- 在存在节点按证书提取的策略走；
- 策略缺失 = 硬失败；
- cap 命中 = UNRESOLVED。

这使“证明者”和“验证者”不共享未验证的否定函数。QUANTIFIER_AUDIT §7 明确要求这一点，
因为旧代码的 `!mouseForcesWin ⇒ 猫存活` 是错的（见 §6）。

---

## 3. 与 Expectiminimax 的逐项对照

| 维度 | Expectiminimax | 量词证明 |
|---|---|---|
| 问题 | 期望值最大化的动作 | 有界强制胜 / 有界存活 |
| 深度单位 | actor 切换（`expectiminimax.ts:1493`） | actor 切换（`seal_lib.ts:124-125`） |
| 截断位置 | `depthTurns<=0`，不论 actor | 只在猫节点 `idx>=2H` |
| 叶值 | 静态评估 `evaluateForCat` | horizon 真值（`catSurvive=true`，其它 `false`） |
| CHANCE | `Σ weight·value`（`1499-1542`） | `AND over outcomes`（`132-139`） |
| mate | 所有 outcome 同侧才保留（`1530-1537`） | 不存在“mate 距离”，只有布尔 |
| 对手选择 | MIN 选最小期望 | AND：所有动作都必须成立 |
| 失败/未知 | `completed=false` → 丢弃该迭代 | `null` → UNRESOLVED |
| 策略 | 隐式（bestAction/plan） | 显式提取，独立 verifier 校验 |
| 随机性 | 枚举，无 `Math.random` | 枚举，无 `Math.random` |
| 结果用途 | 选计划 | 证明/反驳一个计划前缀 |

**共同点**：真实规则、真实 CHANCE 枚举、真实 actor 切换、终端优先。
**不同点**：叶值、CHANCE 聚合、失败语义、以及对“策略”的显式要求。

因此**不能**把一次 Expectiminimax 的 `mate=null` 当作“量词问题不可判定”，
也**不能**把一次量词的 `catSurvive=true` 当作“期望值更高”。

---

## 4. 显式转换表（禁止 H0=D1、H1=D2）

设根状态的 actor 索引为 `s`（猫根 s=0，猫计划执行完后的鼠前沿 s=1），
一次 actor 切换 +1。量词 H 覆盖的切换数是 `2H − s`（当 `s ≤ 2H`）。

| 量词对象 | s | 截断 | 覆盖的 actor 层 | 切换数 | 从原始猫根的搜索等价 | 备注 |
|---|---:|---|---|---:|---|---|
| 根分类 H0（H=1） | 0 | 猫 idx≥2 | 猫 → 鼠 | 2 | **D2** | 叶是猫行动 |
| 根分类 H1（H=2） | 0 | 猫 idx≥4 | 猫 → 鼠 → 猫 → 鼠 | 4 | **D4** | 叶是猫行动 |
| 计划前沿 H0（H=1） | 1 | 猫 idx≥2 | 鼠 | 1 | 原始根 D2 的**后半**（猫前缀固定） | 鼠完整反击 |
| 计划前沿 H1（H=2） | 1 | 猫 idx≥4 | 鼠 → 猫 → 鼠 | 3 | 原始根 D4 的**后半**（猫前缀固定） | 鼠+猫+鼠 |

**不存在**（从猫根出发）与 D1/D3 对应的量词视野：量词只在猫节点截断，猫根出发的截断
只会落在偶数切换上。D1/D3 是 Expectiminimax 的迭代深度，不是量词的 horizon。

**也不存在**“计划前沿 H0 = D1”的对应：D1 是“猫回合 + 边界”，计划前沿 H0 是“鼠回合”，
两者 actor 层不同。

---

## 5. 起始状态、预算、计划执行

| 项目 | 根分类 | 计划证书 |
|---|---|---|
| 起始状态 | fixture 的猫行动快照 | 回放实际计划后的鼠行动前沿 |
| 猫预算 | 根 `catMovesLeft` | `catMovesLeft=0`（猫回合已结束） |
| 鼠预算 | 根 `mouseMovesLeft`（鼠尚未行动，常为 0） | 边界重置后的 `mouseCarry/Base`（3 或 4） |
| 猫第一回合 | 参与搜索（所有猫动作） | **固定为已执行计划**，不参与搜索 |
| 计划合法性 | 不适用 | 真实规则逐步回放；每步必须有效 |
| `stateKey` | fixture 快照 | 回放后的 post-prefix `stateKey` |

**结论**：根分类和计划证书不能互相替代。根 `UNRESOLVED` 可以同时存在一个 `PROVEN` 的
计划前缀证书（G6T2 的 DRRR 就是如此）；反过来，前缀 `PROVEN` 也不证明根级全称问题。

---

## 6. 禁止的推导：`!mouseForcesWin ⇒ catSurvive`

这是上一轮的核心缺陷（`QUANTIFIER_AUDIT.md:43-70`）。

```text
mouseForce  = ∃σ_m ∀σ_c ∀chance → MouseWins
其否定      = ∀σ_m ∃σ_c ∃chance → ¬MouseWins
catSurvive  = ∃σ_c ∀σ_m ∀chance → ¬MouseWins
```

两处不同：

1. **猫/鼠量词顺序**：否定式是 `∀σ_m ∃σ_c`（猫可以针对每条鼠策略自适应），
   存活是 `∃σ_c ∀σ_m`（猫先承诺一个策略，对全部鼠策略成立）。否定式更弱。
2. **CHANCE 量词**：否定式是 `∃chance`（存在一个不输的随机结果即可），
   存活是 `∀chance`（每个随机结果都不能输）。

一个“鼠胜 / 不输”混合的 CHANCE 节点就能让 `mouseForce=false` 而 `catSurvive=false`。
`QUANTIFIER_AUDIT` 的反例测试 A 已实证。

**正确做法**：`catSurvive` 必须是**独立的 solve + 独立的 verifier**；
`!mouseForce` 只是“鼠没有强制胜”的 UNKNOWN，不是猫存活。

---

## 7. UNRESOLVED 的真实样本

| 根 | `mouseForce(H1)` | `catSurvive(H1)` | 根分类 | 说明 |
|---|---|---|---|---|
| G1T5 | false | **null**（600,001 节点 / 20,056ms） | **UNRESOLVED** | 仅凭 `!mouseForce` 会误判存活 |
| G1T8 | false | **null**（600,001 / 17,006ms） | **UNRESOLVED**（V2） | P4 ERRATUM 标 `CHANCE_DEPENDENT`；两种标签都不是 SAFE |
| G6T2 | null（600,001 节点，约 18s） | null（600,001 节点，约 18s） | **UNRESOLVED** | 但 DRRR 前缀证书 `PROVEN` |

**G6T2 的 DRRR 证书**：`catSurvive(H1)` 从 DRRR 前沿出发，117,382 leaves / 31,236 branches /
549 chance nodes / 0 policy misses，`PROVEN`。这证明的是“若执行 DRRR，则其后 H1 内猫可存活”，
不是“根上所有猫第一回合都安全”。根上 D/L 兄弟分支先耗尽 cap，所以根仍 `UNRESOLVED`。

**标签差异**：G1T8 在 V2 是 `UNRESOLVED`，在 ERRATUM §8.5 被描述为 P4 的
`CHANCE_DEPENDENT_OUTCOME`。原因是不同内核/cap 下 `survive=null` 的优先级不同；
本报告对“安全”的判断一律采用 V2 的 `UNRESOLVED`。

---

## 8. 成本现实（冻结工件）

### 8.1 根级量词

| 类别 | 节点 | 耗时 |
|---|---|---|
| 最小 `catSurvive` | 46（G5T4） | 1ms |
| 典型小根 | 125–2,000 | 3–74ms |
| 大根 | 22k–83k | 0.6–2.4s |
| 最大已证 | 215,922（G6T3） | 6,223ms |
| UNRESOLVED | 600,001 | 17–20s（4 个根的相应查询；并非每个根都同时截断两个问题） |

### 8.2 计划前缀证书

| 组合 | 计划 | 叶数 | 耗时 |
|---|---|---:|---:|
| G6T3 `mouseForce(H0)` | — | 457 | 10ms |
| G5T3/E1 `mouseForce(H1)` | LLDR | 756 | 120ms |
| G2T2/E1 `catSurvive(H1)` | DLUL | 328 | 20ms |
| G2T2/H1 `catSurvive(H1)` | DDDD | 307 | 15ms |
| G2T6/H1 `catSurvive(H1)` | LUUU | 11,380 | 214ms |
| G1T4/H1 `catSurvive(H1)` | LLLL | 32,512 | 555ms |
| G6T2 `catSurvive(H1)` | DRRR | 117,382 | （包含在 429,843ms 的独立重证总耗时中，未单列） |

### 8.3 前沿 H0 的可行性线索

G1T3 的计划前沿（鼠行动、已执行 UUUL）：

| 量词 | 结果 | 节点 | 耗时 |
|---|---|---:|---:|
| `mouseForce(H0)` | false | 18 | 3ms |
| `mouseForce(H1)` | false | 179 | 13ms |
| `catSurvive(H1)` | true | 179 | 8ms |
| `catForce(H1)` | false | 192 | 9ms |

G6T2 根 H0 `mouseForce` 也只要 116 节点 / 4ms。**这提示“前沿 H0 反线”有希望在
20–30ms 内完成**；但 G1T3 是简单实例，不能外推到所有根。DRRR 子树的 117k leaves
说明前沿 H1 仍可能爆炸。

**结论**：

- 根级 H1 不可能塞进 100ms；
- 根级 H0 便宜，但它只覆盖“猫+鼠”且仍可能被兄弟分支拖垮；
- 计划前沿 H0 是最有希望的小预算检查，但必须实测分布，不能假设；
- 计划前沿 H1 只能作为“剩余预算允许时”的可选模式，且必须有硬 cap。

---

## 9. 证书有效性清单（必须逐项绑定）

一个 `PROVEN` 结果只有在下列全部成立时才可用于决策：

1. fixture SHA-256 与冻结值一致；
2. 起始 canonical `stateKey` 与冻结值一致；
3. 计划字符串与真实回放一致；
4. post-prefix `stateKey` 一致（含黄油位置、陷阱、隧道、幽灵/债务、双方预算）；
5. cap 未命中（`truncated=false`）；
6. 独立 verifier 返回 `PROVEN`，`policyMisses=0`；
7. 所有 CHANCE outcome 都是 AND 展开，没有 `weight<=0` 漏项；
8. **CAT→MOUSE 边界是确定性的，或边界 CHANCE 已被纳入同一个 AND 证明**；
9. 没有用 `!mouseForce` 推导过 `catSurvive`；
10. 实际执行没有发生 `SEARCH_FALLBACK` / `plan_exhausted` / `plan_action_invalid`。

**第 8 条是容易被忽略的结构性限制**：

- 计划回放只固定猫动作；猫回合末的幽灵边界可能仍有 pending ghost/debt。
- 若边界随机，回放会得到一个具体的随机实现；证书只对这个实现的 `stateKey` 成立。
- 真实游戏在**决策之后**才掷边界结果，因此“对一个随机实现成立”的证书**不能**作为
  决策前的安全证明。
- 现有证书（G1T3、G6T2 DRRR 等）的边界是确定性的（或证书只覆盖具体前沿），所以它们对
  **该前沿**有效；但这不能外推为“任意边界都有效”。
- 下一阶段若要做决策前证明，必须：
  - 只选择边界确定性的回合，或
  - 新增“固定前缀 + 边界 CHANCE”入口，把边界 outcome 纳入 AND，或
  - 明确把结果标为**条件性**（conditional on the realized boundary），不升级为决策证明。

---

## 10. 两个问题不能互相“代替”的清单

| 错误用法 | 为什么错 |
|---|---|
| 用 `mate=null` 说“猫安全” | 静态叶/深度截断也会 `mate=null` |
| 用 `!mouseForce` 说“猫存活” | 量词顺序与 CHANCE 量词都不同 |
| 用 `catSurvive=true` 说“期望值更高” | 量词是布尔，不比较幅度 |
| 用根 `UNRESOLVED` 说“计划不安全” | 根可能被兄弟分支拖垮，前缀仍可证 |
| 用前缀 `PROVEN` 说“根级安全” | 前缀固定了猫第一回合，不覆盖其它猫动作 |
| 用一次 `PROVEN` 说“无限期存活” | 只是 H 内 |
| 用 Sidecar `NO_REFUTATION_FOUND` 说“已证明” | 单边有界探针，不是全称证明 |
| 用 `CHANCE_MIXED` 说“鼠会赢” | 只表示存在鼠胜 outcome，不是鼠强制胜 |
| 用 `INCOMPLETE` 说“安全” | 未完成 = UNKNOWN |

---

## 11. 对下一阶段的直接约束

1. **PCV 只能用 `mouseForce` 的 true 作为“计划被反驳”的证明**；
   `false` 只是“在该 H 内没有强制胜”，不是安全。
2. **PCV 的 `catSurvive` 必须是独立 solve + 独立 verifier**，不能从 `!mouseForce` 推导。
3. **每个证明必须绑定计划前缀 + post-prefix `stateKey`**；计划或边界改变即失效。
4. **边界随机性必须显式处理**：要么只选确定性边界，要么把边界 CHANCE 纳入 AND，
   要么把结果标为条件性。
5. **cap 与 deadline 命中一律 UNRESOLVED**，不得写进 `PROOF` 字段。
6. **`G1T8` 的标签差异**在报告中保留；不要把 P4 的 `CHANCE_DEPENDENT` 当成安全。

---

## 12. 证据边界

- 所有数字来自冻结 JSON/CSV 的文本读取；本轮未重跑搜索。
- `H0=1 / H1=2` 的命名来自工件字段与 `seal_lib.ts:101` 的 `2*H` 截断；不是推测。
- “计划前沿 H0 = 鼠完整反击”来自 `startIdx=1` 与截断条件的组合；G1T3 证书的
  `postIdx=1`、`postPlayer=mouse` 是直接证据。
- 边界随机性限制是从“回放 + 具体 `stateKey` 绑定”直接推出的结构性事实；
  现有证书没有声称覆盖未实现的边界 outcome。
