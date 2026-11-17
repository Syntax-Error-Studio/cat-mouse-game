# HORIZON_SEMANTICS — D1/D2/D3/D4 的精确含义

本文件只回答一件事：**在猫为根 actor 的
Expectiminimax 中，“D1/D2/D3/D4”各自到底搜了什么、没搜什么。**

所有行号对应当前工作树（HEAD `48eaac6…`）。`src/` 本轮未修改。

---

## 1. 深度单位：actor 切换，不是步，也不是回合

```ts
// src/game/ai/expectiminimax.ts:1493
const switched = state.currentPlayer !== next.currentPlayer;
const nd = depthTurns - (switched ? 1 : 0);
```

- 同一个 actor 的连续动作（猫走 1～4 步、鼠走 1～4 步、放陷阱、放技能）**不减** `depthTurns`。
- 只有**行动权改变**才减 1：猫→鼠、鼠→猫。
- CHANCE 转移共享子节点的 `nd`，不会因为“有多个随机结果”而多减（`expectiminimax.ts:1512-1515`）。
- 配置注释与实现一致：`maxDepthTurns` 以 TURNS（action-right changes）计，不是 steps
  （`searchTypes.ts:127-131`）。

**因此 Dk 的严格定义是**：

> **Dk = 一次迭代，其根 `depthTurns = k`，即从根状态起最多允许 k 次 actor 切换。**

不是“k 个完整回合”（一个完整回合并不会总是换 actor，例如猫放陷阱后继续走），
也不是“k 步”。

---

## 2. 根与叶

- **根**：猫行动、`phase=Playing`、`catMovesLeft` 为根状态值（默认 4；重新接续的回合可能更少）。
  生产入口 `computeCatAiTrajectory` 只在猫回合开始处调用一次搜索（`engine.ts:4025-4110`）。
- **叶**：`depthTurns <= 0` 的节点，进入 `leafEvaluator`（生产为 `resolveHardLeaf()`
  → 默认 `evaluateForCat`，`hardTurnPlanner.ts:263`；`searchConfig.ts:81-85`）。
- **终局**：`state.phase` 为 `CatWins` / `MouseWins` 时，在 `_search` 入口直接返回 ±`MATE_SCORE`
  （`expectiminimax.ts:1574-1581`），**先于**重复、深度、预算、TT。
  根入口同样先判终局（`expectiminimax.ts:1850-1859`）。

---

## 3. D1–D4 总表（猫根，默认预算）

下表描述“该迭代允许搜索到的最大层数”。实际搜索可能因捕获、RULE-A、提前交接而更早到达叶，
但**不会**越过该层的 actor 边界。

| 属性 | D1 | D2 | D3 | D4 |
|---|---|---|---|---|
| 迭代根 `depthTurns` | 1 | 2 | 3 | 4 |
| 搜索的 actor 层（依次） | 猫 | 猫 → 鼠 | 猫 → 鼠 → 猫 | 猫 → 鼠 → 猫 → 鼠 |
| actor 切换次数 | 1 | 2 | 3 | 4 |
| 叶 actor | **鼠** | **猫** | **鼠** | **猫** |
| 叶 `depthTurns` | 0 | 0 | 0 | 0 |
| 根猫步预算 | `catMovesLeft`（默认 4） | 同左 | 同左 | 同左 |
| 鼠步预算（进入鼠回合时） | 边界重置：携带 3 / 未携带 4（`engine.ts:1139`、`1368-1370`） | 同左 | 同左 | 同左 |
| 猫完整合法动作 | 4 向 `catStep` + 条件 `catPlaceTrap`（`preparedActions.ts:79-84`） | 同左 | 同左 | 同左 |
| 鼠完整合法动作 | 不搜索 | 4 向 `mouseStep` + 条件 `mouseSkill`；隧道态为 `tunnelExitChoices` 的 `chooseTunnel`（`preparedActions.ts:60-77`） | 同 D2 | 同 D2 |
| CHANCE | 猫末幽灵边界（仅当有 ghost/debt） | D1 的 + 鼠吃黄油 CHANCE | 同 D2（每层各自可能产生） | 同 D2 |
| 静态叶评估 | 是（每个边界 outcome 一个叶） | 是 | 是 | 是 |
| 终局可能触发 | 任意节点 | 任意节点 | 任意节点 | 任意节点 |
| 是否完整猫回合 | **是**（预算可被完整消费） | 是 | 是 | 是 |
| 是否完整鼠反击 | 否 | **是**（预算可被完整消费） | 是 | 是 |
| 是否完整猫再反击 | 否 | 否 | **是** | 是 |
| 是否完整鼠再应对 | 否 | 否 | 否 | **是** |

> “完整”= **该 actor 的完整步数预算与完整合法动作集在同一层内可被搜索**，
> 不是“每条分支都必须走满”。猫可以提前捕获；鼠可以踩陷阱 / 选隧道 / 耗尽步数提前交接。

---

## 4. D1 逐层展开（完整猫回合）

```text
depth=1  [cat]   4 向 catStep（每步 −1 步，nd 保持 1）
                 条件 catPlaceTrap（0 步，nd 保持 1）
                 猫可在同一层内走满全部步数
   │
   ├─ 猫步耗尽（catMovesLeft=0）
   │    └─ forceEndTurnIfNeeded：
   │         ├─ 有幽灵/债务 → resolveGhostBoundaryChance（CHANCE）
   │         └─ 否则 → endTurn（确定性）
   │       nd: 1 → 0
   │
   ├─ 猫走到鼠格 → checkCatWin → CatWins（终端，不再交接）
   ├─ 猫行动前/后 RULE-A → MouseWins / CatWins（终端）
   └─ 无步可走且预算>0 → RULE-A（终端）
   │
depth=0  每个 outcome 的 state：
         ├─ 鼠行动、phase=Playing → 静态叶
         └─ 或终端 → ±MATE_SCORE
```

**D1 包含**：

- 猫的完整回合（所有步、所有推箱、所有零成本陷阱）；
- 猫回合末的幽灵边界 CHANCE（`simulator.ts:107-130`、`engine.ts:1101-1165`、`1256-1305`）；
- 终局与 RULE-A。

**D1 不包含**：

- **任何鼠动作**（鼠步、鼠技能、鼠隧道选择、鼠踩陷阱、鼠吃黄油）；
- 鼠回合内部的 CHANCE；
- 鼠的入洞获胜。

**D1 的叶是“鼠即将行动”的状态**，不是“鼠已经反击后”的状态。这一点是后续所有讨论的前提。

---

## 5. D2 逐层展开（+ 完整鼠反击）

```text
depth=2  [cat]   完整猫回合（同上）
   │
   ├─ CAT→MOUSE：nd 2 → 1
   │    ├─ 有 ghost/debt → 边界 CHANCE，每个 outcome 进入 depth=1 的鼠节点
   │    └─ 否则 endTurn，进入 depth=1 的鼠节点
   │
depth=1  [mouse] 4 向 mouseStep（每步 −1 步，nd 保持 1）
                 条件 mouseSkill（消耗黄油，+3 步，nd 保持 1；engine.ts:887-901）
                 若进入隧道 → phase=ChoosingTunnelExit，mouseMovesLeft=0（engine.ts:698-714），
                   下一步只能是 chooseTunnel
   │
   ├─ 普通 mouseStep 且步数>0 → 仍 mouse，nd 保持 1
   ├─ 吃黄油 → CHANCE（1/N 幽灵公告）
   │    ├─ 仍有步数：outcome 仍是鼠行动，nd 保持 1
   │    └─ 拾取用尽最后一步：内部 endTurn，outcome 已是猫行动，nd 1 → 0
   ├─ 鼠最后一步耗尽步数 → 共享 endTurn（发生在 rules.mouseStep 内部）→ nd 1 → 0
   ├─ 鼠踩陷阱 → 陷阱移除、mouseMovesLeft=0、共享 endTurn → nd 1 → 0（engine.ts:722-736）
   ├─ 鼠进隧道后 chooseTunnel → forceEndTurnIfNeeded → nd 1 → 0（simulator.ts:79-82）
   ├─ 鼠带黄油进洞 → MouseWins（终端，不交接）（engine.ts:762-773）
   └─ RULE-A → 终端
   │
depth=0  叶：猫行动、phase=Playing → 静态评估；或终端
```

**D2 包含**：猫完整回合 + 鼠完整反击（含鼠技能、隧道、踩陷阱、黄油 CHANCE）。

**D2 不包含**：猫对鼠反击的再回应。**D2 的叶是“猫即将行动”的状态。**

---

## 6. D3 逐层展开（+ 完整猫再反击）

```text
depth=3  [cat]   完整猫回合
   └─ CAT→MOUSE，nd 3 → 2
depth=2  [mouse] 完整鼠回合
   └─ MOUSE→CAT，nd 2 → 1
depth=1  [cat]   完整猫回合
   └─ CAT→MOUSE，nd 1 → 0
depth=0  叶：鼠行动 → 静态评估 / 终端
```

**D3 = 两轮猫 + 一轮鼠，叶在鼠。** 它对“猫的第一次行动是否会被鼠反击后又被猫惩罚”给出
一个两回合视野，但**仍然没有鼠对第二次猫行动的反应**。

---

## 7. D4 逐层展开（+ 完整鼠再应对）

```text
depth=4  [cat]   完整猫回合
   └─ nd 4 → 3
depth=3  [mouse] 完整鼠回合
   └─ nd 3 → 2
depth=2  [cat]   完整猫回合
   └─ nd 2 → 1
depth=1  [mouse] 完整鼠回合
   └─ nd 1 → 0
depth=0  叶：猫行动 → 静态评估 / 终端
```

**D4 = 两轮猫 + 两轮鼠，叶在猫。** 它是配置允许的最深迭代，但见 §11：生产 100ms
**从未尝试、也从未完成 D4**。

---

## 8. 特殊机制逐项核对

| 机制 | 发生在哪层 | 是否换 actor | 深度影响 | 回合影响 | 证据 |
|---|---|---|---|---|---|
| 猫放陷阱 `catPlaceTrap` | 猫层 | 否 | 0 | **不结束**猫回合；0 步 | `preparedActions.ts:82-84`；`simulator.ts:49-52`；`engine.ts:1010-1036` |
| 猫推箱 `catStep` | 猫层 | 否 | 0（1 步） | 若推入隧道口，记录 `blockedTunnels`；可能使某出口不可用 | `engine.ts:943-979` |
| 猫踩回自己的陷阱 | 猫层 | 否 | 0（1 步） | 陷阱回到 `catTrapsRemaining` | `engine.ts:986-1003` |
| 猫捕获 | 猫层 | — | — | **CatWins**，终端 | `engine.ts:1039-1045` |
| 鼠技能 `mouseSkill` | 鼠层 | 否 | 0 | 消耗黄油，`mouseSkillActive=true`，+3 步；不结束回合 | `preparedActions.ts:75-77`；`simulator.ts:75-78`；`engine.ts:887-901` |
| 鼠踩陷阱 | 鼠层 | **是**（鼠→猫） | −1 | 陷阱移除，剩余步数清零，共享 `endTurn` | `engine.ts:722-736`；`simulator.ts:53-56` + 注释 `97-105` |
| 鼠进隧道（入口步） | 鼠层 | 否（先进入选择态） | 0 | `phase=ChoosingTunnelExit`、`mouseMovesLeft=0`；出口列表含“原地” | `engine.ts:680-714` |
| 鼠选隧道出口 `chooseTunnel` | 鼠层 | **是**（鼠→猫） | −1 | `chooseTunnelExit` 不交接；由 `forceEndTurnIfNeeded` 交接 | `simulator.ts:79-82`、`97-99` |
| 鼠吃黄油 | 鼠层 | 通常否（鼠→鼠）；**若拾取用尽最后一步则内部 `endTurn`（鼠→猫）** | 0；若用尽最后一步则 −1 | `mouseStep` 内部移除黄油并置 `mouseHasButter`；步数 −1；若耗尽则内部 `endTurn` | `engine.ts:743-786`；`simulator.ts:62-72` |
| 黄油幽灵公告 CHANCE | 鼠层 | 继承拾取动作的切换状态 | 继承拾取动作：通常 0；用尽最后一步则 −1 | 对每个合法公告格等权 1/N；无候选 → 债务 +1 的确定性转移 | `simulator.ts:65-72`、`166-182`；`expectiminimax.ts:1510-1516`；`engine.ts:1213-1255` |
| CAT→MOUSE 幽灵边界 CHANCE | 猫层末 | **是**（猫→鼠） | −1 | 先解析自动拾取/实体化/阻挡，再对剩余请求做均匀 k-子集 | `simulator.ts:107-130`；`engine.ts:1101-1165`、`1256-1305` |
| 鼠入洞 | 鼠层 | — | — | **仅当带黄油** → MouseWins；否则只是普通格 | `engine.ts:762-773` |
| RULE-A 鼠无路 | 可能任意层 | — | — | **CatWins**；要求 `movesLeft>0` | `mobility.ts`；`engine.ts:219-227`；`simulator.ts:41-42` |
| RULE-A 猫无路 | 可能任意层 | — | — | **MouseWins**；要求 `movesLeft>0` | 同上 |

**注意两个容易混淆的“踩陷阱”**：

1. **鼠踩陷阱**会立即结束鼠回合（`engine.ts:722-736`），深度 −1。
2. **猫踩回自己的陷阱**只是收回陷阱，不结束猫回合（`engine.ts:986-1003`），深度不变。

---

## 9. 每个 D 明确“不含什么”

| 迭代 | 明确不包含 |
|---|---|
| D1 | 鼠步、鼠技能、鼠隧道选择、鼠踩陷阱、鼠吃黄油、鼠入洞获胜、鼠回合内 CHANCE |
| D2 | 猫对鼠反击的再回应、第二次猫回合、第二次鼠回合 |
| D3 | 鼠对第二次猫行动的再回应、第二次鼠回合的完整行动 |
| D4 | 第三次猫回合及其后的一切；D4 的叶是猫行动状态，静态评估截断 |

**推论**：

- 说“D2 能看见鼠的最强反击”只在**一步鼠回合**的意义上成立；鼠的反击可能把局面带到
  “猫即将被将死”的状态，但 D2 不会搜索猫的应对。
- 说“D4 能看见两轮攻防”成立，但生产从未完成 D4；且 D4 的叶仍是静态评估，不是证明。
- **任何 D 都不产生“猫可存活”或“鼠强制胜”的证明**；它们只产生期望值与可能的有界 mate。

---

## 10. 为什么生产实际停在 D1/D2

`searchBestActionIterative` 每次迭代以 `d` 为根 `depthTurns`，只有**完整完成**才记录
`completedDepth = d`；deadline/节点预算中断时保留上一个完成深度
（`expectiminimax.ts:2295-2320`）。

在 100ms 主预算下，D2 迭代经常无法完成；D3 只是“尝试”，D4 从未开始。这不是配置错误，
而是真实成本：每个猫层的分支数约为 `5 × 鼠层 5 × CHANCE 分支`，D2 已包含鼠的完整回合。

---

## 11. 生产实测（冻结 100ms 数据）

来源：`PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json`（24 根 × 2 臂 × 5 轮）。

| 指标 | 值 |
|---|---|
| `MAX_DEPTH_CONFIGURED` | 4 |
| `MAX_DEPTH_ATTEMPTED` | 3 |
| `MAX_DEPTH_COMPLETED` | 2 |
| 完成 D1 的组合 | 37/48（attempted D2） |
| 完成 D2 的组合 | 9/48（attempted D3） |
| D1/D2 波动 | 2/48（G2T6/E1、G1T4/E1） |
| 完成 D3/D4 | 0/48 |
| 尝试 D4 | 0/48 |
| deadline 截断 | 48/48 组合 × 5/5 轮 |
| 节点预算截断 | 0/48 |
| fallback / override | 0 / 0 |
| 总回合 >150ms | 182/240 轮；最大 155.6ms |

**必须避免的写法**：“配置 D4，所以完成了 D4”。事实是**配置 4、尝试 3、完成 2**。

---

## 12. 与量词视野的对应（只给结论，证明见 PROOF_VS_EXPECTIMINIMAX.md）

- 从**猫根**（startIdx=0）：
  - 量词 H0 在猫 idx≥2 截断 → 覆盖猫+鼠 → **等价于 D2**；
  - 量词 H1 在猫 idx≥4 截断 → 覆盖猫+鼠+猫+鼠 → **等价于 D4**；
  - **没有**对应 D1/D3 的量词视野（它们要求猫节点截断，只会得到偶数切换）。
- 从**计划前沿**（startIdx=1，鼠行动，猫第一回合已固定为执行计划）：
  - H0 → 1 次切换（鼠回合完整反击）；
  - H1 → 3 次切换（鼠+猫+鼠）；
  - 相对原始猫根，它们仍落在 D2 / D4 的边界上，但第一只猫已被替换成已执行计划，不再参与搜索。

因此：

```text
H0 ≠ D1
H1 ≠ D2
猫根 H0 = D2
猫根 H1 = D4
计划前沿 H0 = 鼠回合完整反击（不是 D1）
计划前沿 H1 = 鼠+猫+鼠（不是 D2）
```

---

## 13. 常见误读清单

| 误读 | 正确说法 |
|---|---|
| “深度 4 = 4 个完整回合” | 深度 4 = 4 次 actor 切换 = 猫、鼠、猫、鼠四个半回合层 |
| “配置 D4 = 完成 D4” | 配置 4、实测完成最多 2 |
| “D1 已经看到鼠的反击” | D1 的叶是鼠行动状态，鼠一步都没搜 |
| “放陷阱会消耗一步/一层” | 0 步、0 深度；由后续步数耗尽结束回合 |
| “鼠技能会换回合” | 不换；+3 步，鼠继续行动 |
| “鼠进隧道就换回合” | 入口步不换；`chooseTunnel` 才换 |
| “鼠踩陷阱和猫踩陷阱一样” | 鼠踩陷阱结束鼠回合；猫踩回陷阱只收回，不结束 |
| “CHANCE 分支多就多减深度” | CHANCE 只减一次（如果同时换 actor）；多 outcome 共享 nd |
| “D2 的猫叶说明猫安全” | 静态评估不是安全证明；它只是启发值 |
| “H1 量词能塞进 100ms” | 实测 46 节点/1ms 到 600k 节点/20s；不能假设 |

---

## 14. 本文件的证据边界

- 行号对应当前工作树；本轮无 `src/` 修改。
- 深度分布来自冻结 JSON 的文本读取，未重新运行搜索。
- “完整回合”是**可搜索性**陈述，不是“每条路径都走满步数”的陈述。
- 终端与 RULE-A 的具体胜负判定以引擎/共享内核为准；本文件只描述它们在 horizon 中的位置。
