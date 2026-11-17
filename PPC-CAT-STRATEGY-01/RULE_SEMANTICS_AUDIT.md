# RULE_SEMANTICS_AUDIT — 生产规则语义审计（TACT-1）

**审计对象**：`HEAD = 48eaac6c4f3801d351787696ba5876995b64e8d8`，分支 `ppc/p1-id-state-identity-fix`。
**审计方式**：只读。未修改 `src/` 任何一行（`git status` 与 P2 基线一致，见 `SOURCE_MANIFEST.json`）。
**行号基准**：工作树当前文件（`core.autocrlf=true`，LF/CRLF 差异不影响行号）。

> 结论摘要：**12 项规则语义全部与 `GAMEPLAY.md` 一致**，没有发现规则实现与文档的实质冲突。
> 有 3 处**文档粒度不足**（不是实现错，而是文档没写到实现那一级的细节），已在每项后标 `DOC-GRANULARITY`。
> 有 1 处**任务书前提与事实不符**（见 §2.2 的 `RULE_DOCUMENTATION_GAP` 更正）。

---

## 1. 鼠拾取黄油的真实状态更新

| 项 | 内容 |
|---|---|
| 位置 | `src/game/engine.ts:659` `applyMouseStepCore`（拾取块 `746-756`） |
| 行为 | 目标格在 `butterPositions` 中 → 从列表移除该格、`mouseHasButter = true`；**当场不再生** |
| 再生 | 延后到调用方：`mouseMove`（`engine.ts:842`）→ `generateSingleButterPosition` 抽一个公告位；搜索侧由 `simulator.ts:63` 转成 CHANCE |
| 步数 | 拾取本身不额外扣步，仍按一次 `mouseStep` 扣 1 |

**关键点**：拾取**不是**"取走+立刻补一个"，而是"取走 + 公告一个 pending ghost"。这决定了搜索里拾取必然是一个 CHANCE 节点。

---

## 2. 技能消耗与额外步数

| 项 | 内容 |
|---|---|
| 位置 | `src/game/engine.ts:887` `mouseSkill`（`894-905`） |
| 前置 | `mouseHasButter === true && mouseSkillActive === false`（否则返回带提示的原状态） |
| 效果 | `mouseHasButter = false`、`mouseSkillActive = true`、`mouseMovesLeft += config.mouseSkillExtraMoves` |
| 常量 | `mouseSkillExtraMoves = 3`（`src/game/config.ts:48`），`mouseCarryingMoves = 3` |
| 连带 | 消耗黄油后**才**允许进入传送通道（见 §7） |

**G6T2 实测**：鼠带油 3 步 → 放技能后 6 步（`probe/chance_enumeration.test.ts` 断言 `mouseMovesLeft === 6`）。

---

## 3. 黄油生成位置的候选集合与概率

| 项 | 内容 |
|---|---|
| 主内核 | `src/game/engine.ts:445` `enumerateButterSpawns` |
| 状态版 | `src/game/engine.ts:1193` `enumerateButterSpawnsForState`（补上 `pendingButterSpawns` 作为 reserved） |
| 扫描域 | `r, c ∈ [1, N-2]`（**只在最内圈**，最外圈永不参与） |
| 排除 | 鼠洞、四角通道、箱子、堆、`void`、已有黄油、陷阱格、`reserved`（pending ghost） |
| 距离 | 距**鼠洞锚点** `>= 3`；距鼠 `>= 3`；距猫 `>= 3`（曼哈顿） |
| 概率 | 均匀 `1/|S|`；`|S| == 0` 时不抛随机，返回**单个**确定性结果并 `pendingButterPlacementDebt += 1`（`engine.ts:1210-1215`） |

`DOC-GRANULARITY`：`GAMEPLAY.md` §2.2 写"远离鼠洞 ≥3"，实现只对 `config.mouseHole` 的**锚点格**测距，不对 2×2 洞块的其余 3 格测距。本轮不改规则，仅记录为 `IMPLEMENTATION_BEHAVIOR`；`probe/chance_enumeration.test.ts` 用锚点距离断言并在注释中标明。

`DOC-GRANULARITY`：初始布局用另一套口径 `distToHole < 5`（`engine.ts:401` `generateButterPositions`），与非初始的 `>= 3` **不同**。两处都合法，但不能互相引用。

---

## 4. CHANCE 分支如何产生

| 项 | 内容 |
|---|---|
| 拾取公告 | `engine.ts:1213` `enumerateGhostAnnouncementOutcomes` → 均匀 `1/N`，每个结果**只加 pending ghost**，不加实体黄油 |
| 边界物化 | `engine.ts:1256` `enumerateGhostBoundaryOutcomes` → 对 `resolveGhostBoundaryCore` 报出的 `ghostPlacements` 再做一次公告枚举（笛卡尔积） |
| 搜索接入 | `src/game/ai/simulator.ts`：拾取 → `buildButterChance`；猫回合最后一步 → `resolveGhostBoundaryChance`；键缺失会**抛异常**而不是静默回退 |
| 权重 | 两组枚举权重量和均为 1（`probe/_raw/chance-*.json` 实测 `|Σ-1| < 1e-12`） |
| 随机性 | 搜索期**零次** `Math.random`：`probe/chance_enumeration.test.ts` 用 stub 计数验证 `calls === 0` |

**重要**：猫的**最后一格移动**也会返回 CHANCE（因为跨 CAT→MOUSE 边界要物化）。任何假设"猫动作一定确定性"的代码都会在猫回合末步崩掉。

---

## 5. pending ghost butter 的物化条件

| 项 | 内容 |
|---|---|
| 内核 | `engine.ts:1061` `canMaterializeButter` / `engine.ts:1101` `resolveGhostBoundaryCore` |
| 时机 | 只在 CAT→MOUSE 回合边界（`currentPlayer` 由 Cat 转 Mouse 的那一次 `endTurn`） |
| 分支 | ①鼠正站在 ghost 格 → **自动拾取**（`hasButter=true`，并 +1 新公告请求）②格可放 → **物化为实体黄油** ③否则 → blocked |
| 可放条件 | 在界内、非箱/堆/墙/void/洞/通道角，且无猫、无陷阱、无实体黄油 |
| 顺序 | 对 pending 列表**逐项**处理，顺序确定（快照后按记录顺序），不依赖容器遍历顺序 |

---

## 6. 被占用格子的延迟与迁移行为

| 项 | 内容 |
|---|---|
| 首次被占 | `blockedMaterializations += 1`，ghost **原地保留**（`engine.ts:1130-1136`），不重抽 |
| 连续第二次 | `blocked >= 2` → **reroll**：丢弃该 ghost，并要求 +1 新公告（`engine.ts:1122-1127`） |
| 无候选可用 | `placementDebt += 1`，债务**永不丢失**，等后续回合优先偿还 |
| 实测 | `probe/fixtures/synthetic/S12_GHOST_CELL_OCCUPIED.json`：公告格被箱子占 → 边界后 `pendingButterSpawns=[5,1:1]`、`butters=[]`、`debt=0`（首次 blocked，非丢失） |

---

## 7. 传送入口与出口的合法性判断

| 项 | 内容 |
|---|---|
| 实现 | `src/game/rules/tunnelRules.ts:66` `isTunnelUsable`；`:94` `getTunnelExits`；`:82` `isMouseTunnelEntryAllowed` |
| 入口条件 | 该角非箱子且不在 `blockedTunnels` 中；**且鼠当前不携带黄油**（`mobility.ts:61-66` 明确"carrying butter forbids tunnel entry"） |
| 出口集合 | **其余所有可用角**（不是固定对角配对），由引擎额外 `unshift` 一个"原地"选项（`engine.ts:691`） |
| 无出口 | 引擎在 `unshift` 之后才判断 `exits.length === 0`，因此该分支**实际不可达**（死代码，非缺陷，仅记录） |

**G6T2 相关**：鼠带油时**不能**进通道；必须先放技能消耗黄油。这条直接解释了合成例 `S05/S06` 的合法集差异（`['L','R']` vs `['R']`）。

---

## 8. 传送后剩余步数如何处理

| 项 | 内容 |
|---|---|
| 内核 | `src/game/rules/tunnels.ts:22` `chooseTunnelExit` |
| 效果 | 落点改到出口、`mouseMovesLeft = 0`、`tunnelExitChoices = []`、`phase = Playing`、`currentPlayer` 仍为 **Mouse** |
| 交接 | `chooseTunnelExit` **不**调 `endTurn`；单出口时由 `mouseMove`（`engine.ts:830`）自动 `endTurn`，多出口时等选择后由调用方收尾 |

**推论（写进报告）**：传送通道是"整回合重新定位"，不是回合内的免费加速。用 1 步换一个角，但把剩余步数清零。

---

## 9. 鼠洞胜利判定

| 项 | 内容 |
|---|---|
| 位置 | `engine.ts:760-775`（`applyMouseStepCore` 内） |
| 条件 | 目标格 `type === MouseHole` **且** 拾取后 `mouseHasButter === true` |
| 效果 | `phase = MouseWins`，`mouseHasButter/skillActive` 归零，**不检查剩余步数**（进洞即胜） |
| 对手 | 猫无法踩洞格（`canCatStepTo` 首行排除洞块），因此不存在"守洞口"这一手 |

---

## 10. 猫推箱封锁通道的真实条件

| 项 | 内容 |
|---|---|
| 位置 | `engine.ts:946-966`（`catMove` 推箱分支）；镜像 `mobility.ts:89` |
| 可推条件 | 目标格有箱；箱后一格在界内、非洞、非鼠、非箱、非堆、非 void、无黄油、无陷阱 |
| 封锁 | 箱被推到**通道角** → 该角加入 `blockedTunnels`（永久，`engine.ts:959-963`） |
| 成本 | 推箱算 **1 步**（与普通移动同价） |
| 实测 | `probe/fixtures/synthetic/S08_CAT_PUSH_BOX_BLOCKS_TUNNEL.json`（箱在 (0,1)、猫在 (0,2)，可推入角 (0,0)） |

`DOC-GRANULARITY`：`GAMEPLAY.md` 写了"箱子可推入传送格封锁通道"，但没写封锁是**永久**的（不因箱被再次推开而解除——实现里 `blockedTunnels` 从不删除）。

---

## 11. 陷阱放置、触发、回收的完整时序

| 阶段 | 位置 | 语义 |
|---|---|---|
| 放置 | `engine.ts:1010` `catPlaceTrap` | **不消耗步数**；要求场上无陷阱、库存 `> 0`、所处格为 `Empty`、非洞/非通道角/非黄油/非鼠；放下后库存 `-1` |
| 触发 | `engine.ts:718-736` | 鼠踩上 → `trapPosition = null`、`mouseMovesLeft = 0`（剩余步数清零）、不直接判负；随后由 `finalizeTurnAfterMouseStep` 交接 |
| 回收 | `engine.ts:985-1000` | 猫**踩上自己的陷阱格** → `trapPosition = null`、`catTrapsRemaining += 1`，消耗 1 步 |
| 推论 | — | 同一格只能有一个陷阱；回收必须花 1 步走上去 ⇒ 两次放夹之间至少间隔 2 个猫步（`PPC-P1-PLAN-01` 已独立证明） |

---

## 12. Cat→Mouse 与 Mouse→Cat 的真实回合交接

| 项 | 内容 |
|---|---|
| 猫→鼠 | 猫步数耗尽 → `endTurn`（`engine.ts:1306`）；**在同一次交接上**做 ghost 物化（CHANCE） |
| 鼠→猫 | 鼠步数耗尽 / 踩陷阱 / 传送完成 → `finalizeTurnAfterMouseStep`（`engine.ts:806`）→ `endTurn` |
| 补步 | 进入方各自补满：猫 `catBaseMoves`、鼠 `mouseCarryingMoves` 或 `mouseBaseMoves`（`engine.ts:1369-1389`） |
| 搜索侧 | `endTurn` **不是** SearchAction；由 `simulator.ts` 的 `forceEndTurnIfNeeded` 强制施加，因此搜索树里不存在"故意不结束回合"的分支 |
| 特例 | `tunnelExitChoices` 非空时**不**交接（等出口选择） |

`DOC-GRANULARITY`：`GAMEPLAY.md` 未显式说明"回合交接上会同时发生 ghost 物化 CHANCE"，只在幽灵黄油章节描述物化时机。搜索实现把两件事放在同一个 `endTurn` 里，这是本报告所有 CHANCE 计数的来源。

---

## 附：规则调用图（只读推导，非生成物）

```
engine.createEngineRuleSet()
├── catMove            → checkCatWin / settleNoMoveLoss
├── catPlaceTrap
├── mouseMove          → applyMouseStepCore
│                        ├── 通道入口 → phase=ChoosingTunnelExit（movesLeft=0）
│                        ├── 陷阱触发 → movesLeft=0
│                        ├── 拾取黄油 → 移除 + hasButter=true（不生）
│                        └── 进洞+带油 → MouseWins
│                      → finalizeTurnAfterMouseStep → endTurn
│                      → 拾取时 buildButterChance（CHANCE）
├── endTurn            → resolveGhostBoundaryCore → resolveGhostBoundaryChance（CHANCE）
└── rules/mobility.ts  → noMoveLossVerdict / applyNoMoveLoss（RULE-A，双向判负）

ai/simulator.ts  → 把上表包装成 SearchTransitionResult（deterministic | chance）
ai/preparedActions.ts → 唯一候选枚举源（P2），合法性与后继一次算完
```

## 与 `GAMEPLAY.md` 的关系（诚实更正）

任务书 §2.2 假设"`GAMEPLAY.md` 未完整描述 pending ghost butter 的物化时序"。**复核结果：该假设不成立。**
`GAMEPLAY.md`（346 行）已包含 G0.4F-2A 的完整章节（§2.2 / §3.2 / §5.3 / §9.4 / §10），明确写了公告-物化-占用-重抽-债务五件事。
因此本轮不记 `RULE_DOCUMENTATION_GAP`，只记三处 `DOC-GRANULARITY`（文档没细到实现粒度），以及一处"实现只按洞锚点测距"的 `IMPLEMENTATION_BEHAVIOR`。
