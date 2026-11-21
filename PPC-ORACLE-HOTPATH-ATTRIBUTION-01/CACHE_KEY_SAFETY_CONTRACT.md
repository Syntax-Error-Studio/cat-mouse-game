# 缓存键安全契约（CACHE_KEY_SAFETY_CONTRACT）

- 轮次：`PPC-ORACLE-HOTPATH-ATTRIBUTION-01`（研究轮，不接生产）
- 对象：SEAL 内核 `solve()` 内、同一 solve 生命周期内的“动作生成缓存”原型
- 状态：**静态审计完成；影子等价门（shadow gate）待重型准入后执行**

本文件回答一个问题：**若把 `generatePreparedSearchActions(s, rules)` 的结果按 `stateKey(s)` 缓存并在同一 `solve()` 内复用，是否可能改变搜索语义？** 结论分三层：

1. **规则与量化器层面：安全**。`solve()` 的 `transitions(s)` 只依赖状态 `s`（不读 `idx`、`H`、`mode`），`idx` 只用于窗口截断判断，`mode` 只用于真值映射；一次 solve 内 RuleSet 是模块单例，不会变化。
2. **状态字段层面：stateKey 覆盖全部影响对局转移的字段**；未覆盖的字段均为调试/历史字段，搜索转移函数不读取。**唯一必须加保护的是 `hardProgressGuardMemory`**（`endTurn` 会读写它做透传），原型对非空值直接绕过缓存。
3. **残余风险：集合型字段的数组顺序与 tunnel 出口标签**。`stateKey` 对 `butterPositions` / `blockedTunnels` / `tunnelExitChoices` / `pendingButterSpawns` 做了规范化排序（丢顺序），而 `tunnelExitChoices` 还丢掉了 `label`。静态上这些顺序在“同一 solve + 固定 config”内由棋盘与 config 确定（见 §3），但**必须由影子门在每一处缓存命中上逐项确认**；任何一处不一致 → 该 solve 内缓存作废、回退原生成（fail-closed）。

---

## 1. 缓存对象的定义

```
cache: Map<stateKey(s) → Transition[]>[solve-local]
缓存写入点：expansions（memo miss 且通过 cap 检查后，真正调用动作生成的那一次）
缓存读取点：同一 solve 内后续 expansion，若 stateKey 相同则复用 Transition[]
不缓存：memo 命中不触发转移生成，因此缓存与 memo 不重叠
不跨：solve 调用 / 根 / 计划 / 回合 / RuleSet / 模式(H, mode, idx 序列)
```

`Transition` 来自 `realGame.transitions`：`{ label, outcomes:[{state, weight}] }`，由
`generatePreparedSearchActions`（`src/game/ai/preparedActions.ts:118`）一次模拟生成。

## 2. 字段覆盖审计

`GameEngineState`（`src/game/engine.ts:140-186`）× `stateKey`（`src/game/ai/transposition.ts:81-104`）×
搜索转移读取面（`src/game/ai/simulator.ts` + `searchRules.ts:45` 绑定的 engine 函数）。

| 字段 | 在 stateKey？ | 被转移函数读取？ | 结论 |
|---|---|---|---|
| `board`（terrain/piece/hasButter，`boardKey`） | 是 | 是（全部移动/陷阱/传送/黄油） | 安全 |
| `config`（子集：boardSize/mouseBaseMoves/mouseCarryingMoves/mouseSkillExtraMoves/catBaseMoves/butterCount/gameMode/difficulty） | 部分 | 是 | 一次 solve 内 config 引用恒定（转移只 spread 复制，不替换）；子集外字段（tunnelCorners/mouseHole/customTerrain…）决定的地形与通道已烘进 `board`，出口**顺序**见 §3 |
| `gameMode` / `phase` / `currentPlayer` | 是 | 是 | 安全 |
| `catPosition` / `mousePosition` | 是 | 是 | 安全 |
| `catMovesLeft` / `mouseMovesLeft` | 是 | 是 | 安全 |
| `butterPositions`（点集） | 是（排序后） | 是 | 顺序不影响规则（集合语义）；见 §3 顺序风险 |
| `mouseHasButter` / `mouseSkillActive` | 是 | 是 | 安全 |
| `pendingButterSpawns`（含 `blockedMaterializations`，多重集） | 是（排序后） | 是（边界解析逐个遍历） | 每项命运只依赖自身格子与棋盘/鼠位，彼此独立；顺序风险见 §3 |
| `pendingButterPlacementDebt` | 是 | 是 | 安全 |
| `trapPosition` / `catTrapsRemaining` | 是 | 是 | 安全 |
| `blockedTunnels`（点集） | 是（排序后） | 是 | 集合语义；顺序风险见 §3 |
| `tunnelExitChoices`（点集 r,c） | 是（**丢 label**） | 仅 r,c（`chooseTunnel`）；label 为 UI 文案 | label 不参与转移；顺序风险见 §3 |
| `message` | 否 | **否**（engine 内无 `state.message` 读取，只有写入） | 安全（调试字段） |
| `catActionLog` / `gameEventLog` | 否 | **否**（只追加；搜索路径不读） | 安全（调试历史） |
| `lastHardSearch` / `hardSearchHistory` | 否 | **否**（只在 `catAiMove` 根管线写入，搜索转移从不读取） | 安全（调试历史） |
| `hardProgressGuardMemory` | 否 | **是**：`endTurn` 在 `src/game/engine.ts:1394` 读取、`:1425` 写回 `mouseTurnObserved` | **需要保护**：原型对非空 guardMemory 的状态不读也不写缓存（见 §4） |

补充静态事实：

- `endTurn` 的 guardMemory 写入只改变“同一对象 + mouseTurnObserved 标记”的透传，不改变任何对局规则字段；真正消费它的是 `catAiMove` 根级救援策略（`engine.ts:4413-4431`），在 `solve()` 之外。
- `simulateSearchAction`（`src/game/ai/simulator.ts`）只调用 RuleSet 的 9 个绑定，全部是 engine 的纯函数；没有 `Math.random`、没有时间、没有全局可变状态。
- `forceEndTurnIfNeeded` 的 CHANCE 分支只依赖 `pendingButterSpawns/debt/board/mousePosition/...`，均在 stateKey 内。

## 3. 顺序/标签风险的静态定性

- **tunnel 出口顺序**：`getTunnelExits`（`src/game/rules/tunnelRules.ts:135-147`）按 `getTunnelCorners(state.config)` 的顺序产出，并在最前面插入“原地”。同一 solve 中 config 是同一个对象（状态只 spread 复制引用），同一 `board` ⇒ 同一出口顺序。`stateKey` 虽丢顺序，但同 key 状态的出口**列表顺序由相同输入确定**。
- **pendingButterSpawns 顺序**：不同历史可以构造出同一多重集但不同数组顺序。父结点的 CHANCE 结果按候选格（棋盘序）追加，子状态 key 相同；因此“同 key、不同 spawn 数组顺序”的状态**理论可达**。其后果仅是：a) 子转移对象的非对局字段（日志/历史）可能不同；b) 若 CHANCE 结果的数组顺序参与 AND 短路次序，节点计数可能不同。
- **处理**：这正是 G3 要求“先做键等价检查”的原因。原型带 `shadowCompare`：**每次缓存命中都仍重新生成一次基线转移**，逐动作/逐结果比较 `label`、`weight`、`stateKey`、`gameAffectingEqual`；任何不一致写入 `shadowFirstMismatch` 并判定缓存对该 solve 不可用。只有 0 mismatch 的 solve 才进入性能测量。

## 4. 原型必须遵守的约束（实现层）

1. 缓存仅在 `solveInstrumented(..., { actionCache })` 内启用；默认关闭。
2. 键 = `stateKey(s)`（settle 之后）；**不含** `idx/H/mode`（转移不依赖它们）。
3. 规则依赖 = 模块级 `rules` 单例 + 单次 solve；不提供跨 solve 复用入口。
4. `hardProgressGuardMemory !== null` ⇒ 该结点既不查也不写缓存。
5. 缓存容量有上限（默认 20,000 条，FIFO 淘汰；每次淘汰计数）。达到上限不改变语义，只降低命中率。
6. 命中时**只读**缓存对象：不修改 `Transition`、`outcomes`、`state`、`action`；搜索本身也不可变。
7. 不缓存 `revisitCount` / `uniqueProgress` —— 它们不属于 `GameEngineState`，也不在 stateKey；原型根本不接触它们。
8. 影子门失败或资源不足时回退到原生成，并记录 `CACHE_REJECTED`。

## 5. 什么不算“同一状态”（必须区分）

- 不同 `config`（含 tunnelCorners 顺序/mouseHole 形状）——即使棋盘字节相同；
- 不同游戏模式/难度/步数预算；
- 不同 RuleSet（本轮只有模块单例，但契约禁止跨 RuleSet 复用）；
- 不同 `H` 或 `startIdx` 下同一状态（因为缓存值不含 H/idx；转移本身与它们无关，但策略/证书语义不同，不得跨 solve 迁移）。

## 6. 通过/拒绝判据（将由 G3/G4 实测填写）

- 键等价：`shadowMismatches === 0` 且 `shadowChecks > 0` 对所有实根成立 → 进入 G4；
- 任一 mismatch → 缓存拒绝，verdict ≥ B；
- 即使通过，也只证明“在本轮冻结根与 RuleSet 上不改变语义”，不构成生产接线许可。

### 6.1 实测结果（已填）

- **签名门**（`logs/g3_key_equivalence.json`）：475 次“同键再次展开”全部生成与首次完全相同的转移签名（label + 每条结果的 weight/后继 stateKey），`signatureMismatches=0`；其中 475 = `repeatDiffIdx`（同键不同 idx），`repeatSameIdx=0`。
- **CHANCE 见证**（`logs/g3_chance_witness.json`）：预置一个 CHANCE 状态的缓存条目后求解，`shadowChecks=1`、`shadowChanceChecks=1`、`shadowMismatches=0` —— 强制比对路径确实覆盖到 CHANCE 分支，不是空跑。
- **全量一致**（`BASELINE_VS_PROTOTYPE_PARITY.json`）：3 个新进程 × 5 个目标，全部计数器与策略摘要相等、证书 5/5 `PROVEN`。
- **但收益为零**：潜在命中 0–0.26%（`CACHE_HIT_UPPER_BOUND.json`），实测配对全部 ≥1.0，且保活 1.1 GB 堆（`RESOURCE` 见 `REPORT.md` §3）。键是安全的，只是不值得用 —— 判据 8 的“回退”在结论层面生效：**不实施**。