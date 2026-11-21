# TURN_AWARE_MOUSE_GOAL_RISK — 影子原型规格（隔离研究件，不接生产）

Round: `PPC-G6T2-DECISION-RISK-CAUSAL-01`
Status: **SHADOW PROTOTYPE — `wiredToDecision: false`**
代码: `probe/dr_lib.ts`（`mouseOneTurnRisk` / `mouseTwoTurnRisk` / `mouseStaticGoalReach` / `evaluatePlanRisk`）

本文件定义"给定猫的一条完整计划（4 个猫动作），影子工具如何计算随后老鼠一回合 / 两回合内的可观测获胜风险"。
它不是生产策略，不产生任何接线的选择，也不会在任何地方修改 `src/`。

---

## 0. 术语与输入

- **根（root）**：轮到的状态，`currentPlayer = Cat`，鼠标位于 `mouseMovesLeft` 初始值。
- **完整猫计划**：4 个合法猫动作组成的序列（如 `UURR`），由 `generatePreparedSearchActions` + `createEngineRuleSet` 逐步真实转移。
- **frontier（接交面）**：计划执行结束后、交给对手 / 掷骰的状态集合。猫回合结束时有三类：
  - `terminal`（猫胜 / 鼠胜）；
  - `deterministic`（无随机地交接到老鼠或继续猫）；
  - `chance`（鬼鼠显形、黄油拾取等随机转移，可能有多个正概率 outcome）。
- **TWO_MOUSE_TURNS 窗口**：从 frontier 起，老鼠自己 2 个完整动作回合（中间夹猫的应答回合）。
- 所有规则语义只来自真实 `RuleSet`：技能激活 / 重置、黄油预算（无黄油 `mouseBaseMoves`，携带黄油 `mouseCarryingMoves`，消费黄油 +3 且解锁隧道）、黄油拾取、鬼鼠、待偿债务（pending debt）、整段鼠洞区域、隧道、陷阱、障碍，全部由 `realGame.transitions()` 产生，本原型**不手写**任何地形 / 技能规则。

## 1. 窗口与量词

### Layer 1 — `mouseOneTurnRisk(frontier)`

只覆盖"老鼠自己的下一个动作回合"（此窗口内**不存在**猫节点；猫回合即窗口外，返回 `false`）。

- 分支节点仅有 CHANCE。对每个 CHANCE 转移，**只取 `weight > 0` 的 outcome**。
- `forcedWinThisTurn`：老鼠 OR、CHANCE AND —— 全部正概率 outcome 下都能赢，才为 `true`。
- `existsWinningChanceOutcome`：老鼠 OR、CHANCE OR —— 存在一条有利随机分支。
- 单条有利分支**永远**不能报为"确定"；两者分别记录 `forcedWinningActions` / `existentialWinningActions`。
- 只有 `phase === MouseWins` 算赢；**进入鼠洞本身不判赢**（带黄油入洞、技能入洞均按真实规则）。
- 上限 `RISK.oneTurnCap = 50_000` 节点；触顶 → `forcedWinThisTurn = null`, `truncated = true`。

### Layer 2 — `mouseTwoTurnRisk(frontier)`

窗口：老鼠回合 → 猫应答回合 → 老鼠回合（第二个老鼠回合内判胜）。

- 节点量词：**老鼠 = OR，猫 = AND**（猫的每个合法应答都必须被老鼠攻破），**CHANCE = 对全部正概率 outcome 的 AND**。
- 猫节点在 `idx >= 4`（已越过猫应答回合）视作窗口外 → `false`（不会因为窗口外的猫失误而记胜）。
- 记忆化键 `idx|stateKey`；`stateKey` 只作为搜索记忆，不写成跨根 / 跨回合的全局 TT（每次调用新建 Map）。
- 结果标签：
  - `PROVEN_FORCED_WIN`：完整量词证明（无截断）为 `true`。
  - `NO_WIN_WITHIN_TESTED_HORIZON`：完整搜索完成（无截断）为 `false` —— **不是**猫安全证明，只是"在 2 个鼠回合内找不到强制胜"。
  - `UNKNOWN`：触顶 `RISK.twoTurnCap = 300_000` 节点。
- `witness`：`PROVEN_FORCED_WIN` 时给出的一条具体取胜线（`m:` 鼠动作 / `c:` 猫应答，`(chance)` 标记随机步）。
- `witnessOnly`：`NO_WIN` 时额外做一次**存在性**搜索（`SOME` 猫应答 / 一条随机分支）；它只是"某条变化线里鼠能赢"，**绝不**升级为强制胜或安全结论。

### Layer 0 — `mouseStaticGoalReach(frontier)`（启发式筛查，仅参考）

假设猫永不走棋（跳过猫回合并重置鼠的 action 预算），判断鼠能否在 2 个鼠回合内入洞。
`caveat = HEURISTIC: the cat never moves and no cat reply is quantified`；上限 20 000 节点，触顶 → `reachable = null`（**不是** `false`）。
G3 实测：`UURR` 触顶为 `null`，`DRRR/DUUD/DRDR` 为 `true` —— 与真实风险不区分，**不可**用作风险信号。

## 2. 成本与超预算行为

- 单计划分析成本按层记录：`oneTurnMs`、`staticReachMs`、`twoTurnMs`（含 `witnessMs`）、总 `riskMs`、`enumerateMs`，以及进程 RSS 的 `rssBeforeMB / rssAfterMB / peakRssMB`（在搜索内部每 4096 个节点采样，因为同步搜索中定时器无法触发）。
- 超预算行为统一为**显式截断**：`truncated = true` 且结果降级为 `null` / `UNKNOWN`，绝不返回"部分搜索的胜利/安全"。
- 真实数字见 `RESOURCE_SAFETY_LOG.md` 与 `logs/g5_env.json`（本地 Windows 进程实测，非云端，**不能**作为 100ms 生产预算的证明）。

## 3. 输出契约（每条计划）

`ShadowEval = { rootId, plan, legal, endKind, frontierCount, chanceWeights, e1Frontier, oneTurn, twoTurn, staticReach, frozenLabel, cost }`

- `frozenLabel` 只从冻结证据表按**计划/根**查表（`FROZEN_LABELS`），不跨根移植证书。
- `safeClaim` 恒为 `null`：没有逐计划冻结证明时，任何 `NO_WIN` 都不等于"安全"。

## 4. 明确的非目标

1. 不接入生产选择（`wiredToDecision = false`）；不覆盖 E1 / D2 / H0-H2 / PCV / `stateKey`。
2. 不做参数搜索、不调阈值、不反向拟合让 `DRRR` 排名第一。
3. 不把"找到一条鼠取胜变化线"表述为"猫所有应答均失败"。
4. 不因为一次反例而要求实时接线；成本高或 UNKNOWN 多时如实报告。
5. 根级冻结标签（如 `CAT_SURVIVAL_CERTIFIED_WITHIN_H1`）窗口是"一个猫回合 + 一个鼠回合"，**短于**本原型的 TWO_MOUSE_TURNS 窗口，不能互推。

## 5. 已知边界

- Layer 2 的"鼠赢"只通过 `GamePhase.MouseWins` 与入洞判胜路径体现，不额外发明胜利条件。
- CHANCE 权重在读入时取 `> 0`；权重归一性依赖真实引擎（G3 实测 G6T2 四个控制计划权重和均为 1，且均只有 1 个正概率 outcome）。
- `existsWitness` 的记忆化在**存在性**语义下会剪掉部分分支（认为该状态已失败），这只会让 `witnessOnly` 更保守，不影响 layer 2 的 AND/OR 结论。
- 搜索节点计数不含 `existsWitness` 的节点（单独计时 `witnessMs`），总量上限仍是 300 000（layer 2 主证）。