# PPC-ARIMAA-01 — 多步回合博弈搜索、双阵营 AI 与动态规则适应性研究

**性质**：只读源码审查 + 历史证据复核 + 文献研究 + 架构设计。
**未修改**：GAMEPLAY.md 正式规则、生产 AI 代码、猫鼠移动语义、H1 权重、Sidecar、100ms/150ms 预算、历史权威、既有实验日志。
**未执行**：重型 Benchmark、自对弈、模型训练、生产接线。`HEAVY_BENCHMARK_RUN=FALSE`、`SELF_PLAY_RUN=FALSE`、`NEW_MODEL_TRAINING=FALSE`、`PRODUCTION_CHANGE=FALSE`。
**未 commit / push / reset / stash / clean**。

**证据分离声明**：本文与同目录 `PPC-ARIMAA-01_PREREGISTERED_EXPERIMENTS.json` 是**新生成的独立研究工件**，不与任何冻结权威（`contract_provenance.json`、`FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json`、`ai-training/**` 历史账本、G0.3*/G0.4F* 历史报告）合并、不覆盖、不改写。引用历史结论一律标注来源文件；引用外部论文标注核实等级。

---

## 0. 源码基线（P0）

| 项 | 实测值 |
|---|---|
| 工作树 | `F:\小猫小鼠` |
| 分支 | `ppc/2026-11-03-a0-trap-fix` |
| HEAD | `9ba04b53ff89370a3de6b7c1e318cb78e3c742b1` — `feat: add experimental A0 AI leaf for dev playtesting`（2026-11-03 17:40 +0800） |
| 工作区 | **79 项未提交改动**（23 修改 + 56 未跟踪；含 `engine.ts` / `expectiminimax.ts` / `evaluation.ts` / `searchConfig.ts` / `GAMEPLAY.md`） |
| 审计对象 | **工作树**（不是 HEAD 快照）。凡本文引用行为，均来自工作树当前文件 |
| `GAMEPLAY_RULESET_VERSION` | **2**（`src/game/config.ts:57`）— RULE-A 无路判负 + RULE-B 开局黄油公平性认证 |
| 上一版 | 1（无 RULE-A/B，静态距离撒黄油） |

> 重要区分：`FORMAL V2`（`FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json`）是**历史鼠策略评测协议**，与 `GAMEPLAY_RULESET_VERSION=2` 不是同一件事。本文所有"v2"均指后者。

**文件存在性核对**（任务书点名 16 个路径，逐个 `Read` 实测）：

| 路径 | 状态 | 行数 |
|---|---|---|
| `GAMEPLAY.md` | 存在 | 347 |
| `src/game/config.ts` | 存在 | 352 |
| `src/game/engine.ts` | 存在 | 4431 |
| `src/game/rules/` | 存在（`mobility.ts` 173 / `tunnelRules.ts` 151 / `tunnels.ts` 51） | — |
| `src/game/ai/expectiminimax.ts` | 存在 | 2401 |
| `src/game/ai/hardTurnPlanner.ts` | 存在 | 717 |
| `src/game/ai/legalActions.ts` | 存在 | 75 |
| `src/game/ai/simulator.ts` | 存在 | 182 |
| `src/game/ai/searchTypes.ts` | 存在 | 161 |
| `src/game/ai/transposition.ts` | 存在 | 124 |
| `src/game/ai/stateCompare.ts` | 存在 | 128 |
| `src/game/ai/evaluation.ts` | 存在 | 870 |
| `src/game/ai/planQuality.ts` | 存在 | 600 |
| `src/game/ai/turnBoundary.ts` | 存在 | 850 |
| `src/game/ai/searchConfig.ts` | 存在 | 105 |

额外实测存在但任务书未点名、对本轮结论关键的模块：`forcedLossTieBreak.ts`(112)、`hardHistory.ts`(299，调试快照非搜索 history)、`turnLazy.ts`(714)、`boundedPlanRefutation.ts`(1138)、`deadlineContext.ts`(206)、`hybridLeaf.ts`(260)、`gateRaceLeaf.ts`(448)、`a0ExpectedReturnLeaf.ts`(211)、`hybridWeights.ts`(11214 行 / 2.3MB，生成权重，未逐行阅读)、`rules/mobility.ts`(173)。

---

## 1. 通俗中文总结（先回答问题）

**① 我们现有猫 AI 是否已经使用 Arimaa 类似技术？**
**是，家族级相同，机制级落后一代。** 我们和 SHARP 用的是同一族架构：**逐原子步（stepwise）的迭代加深 α-β**，而不是"枚举整个回合再搜索"。随机（黄油再生）在我们这里额外多一层 CHANCE 期望。但 SHARP 2015 之所以能在"每回合 4 步、平均 17,000 个合法回合"下打赢人类，靠的不是这个骨架，而是三样我们**没有**或**试过但失败**的东西：
1. **静态目标检测**（数千行决策树；在叶子节点上直接判定"这一回合能否得分"，等于白送 4 步视界）；
2. **树内减速/剪枝**（Root 10% 之后的动作减 1 步、20% 之后减 2 步，带回搜验证 —— 这是它 2015 年最大的性能突破）；
3. **极小战术动作集上的静止搜索**（只生成"得分防守/吃子/少数特例"，不是"在叶子上再搜几层"）。

**② 猫步数改变后能否保持棋力？**
**机制上只需改配置，棋力上完全未证明。** 搜索内核没有 `=== 4` 之类硬编码；`catMovesLeft` 由 `endTurn` 统一按 `config.catBaseMoves` 重置；`stateKey` 把 `catBaseMoves` 纳入配置签名。所以 4→5 不会算错。但有三个真实约束：
- **计划长度硬上限 `maxLength = 8`**（`expectiminimax.ts:1887`、`planQuality.ts:245/:431`）：猫 8 步以上 + 放陷阱就会被截断，触发 `SEARCH_FALLBACK reason=plan_exhausted`；
- **没有 UI 入口**：设置页只暴露 `mouseBaseMoves`（`SettingsPage.tsx:71`），猫步数只能配置注入；
- **视界以"回合"为单位**：步数变多，一回合覆盖的棋盘距离变长、分支从 ~3.5⁴ 涨到 ~3.5⁵，D2 成本上升 50–100%，而 H1 权重（`capturePressure:900`、`mouseGoalThreat:1100` …）是在 4 步对 3 步下调的，速度竞赛的平衡会漂移。**不加规则对照的胜率变化不能当棋力证据。**

**③ 鼠 AI 应该继承什么，重新设计什么？**
**继承**：规则内核（`RuleSet`/`simulator`/`legalActions`）、`stateKey`、TT、迭代加深骨架、mate 词法比较、CHANCE 语义 —— 这些是双方对称的，`maximizing = (currentPlayer === Cat)` 一行就切换。
**必须重写**：计划层。现有 `buildCatTurnPlan` / `extractBestCatTurnPlan` / `planFullTurnCompleteness` / `applyPlanCatAction` / `computeCatAiTrajectory` **全部写死了"当前行动者是猫"**（`expectiminimax.ts:1894`、`planQuality.ts:477`）。
**必须新设计**：**鼠的计划不能是一条线性动作表**。鼠吃黄油会触发 CHANCE（幽灵位置未知），所以鼠的计划是**条件计划**（policy tree）：拿油前一段线性 + 揭示幽灵后按已知信息继续。M0（最小正确版）用"遇到 CHANCE 就重新规划"绕过，代价是最优性损失；M1 才做真正的条件计划。
**评价函数**：H1 作为零和标量对鼠**形式上合法**（鼠取 MIN），但它是"给猫报警"的语言（`capturePressure` 是猫距离、`holeControl` 是猫守门更近），鼠真正需要的"推进/安全"只被 `mouseWinRouteDistance` 部分覆盖 → M0 可直接用（正确但弱），M1 需要鼠侧特征。

**④ 新 Hybrid 算法是否真的有希望比旧算法更好？**
**按任务书定义的"以完整回合为树边"的 Hybrid：裁决 `NO_NEW_HYBRID_CANDIDATE`。** 理由是硬证据而非口味：
- 纯回合枚举的分支爆炸已被实测：猫回合 64–821 条原始序列 → 只有 14–214 个不同回合终态；鼠回合 5,125–12,288 条 → 只有 10–615 个终态，**重复率 95%**（G0.3J）；
- "精确回合 DAG + AB/TT" 已实现并测过：值逐位正确（G1T9 D2 value bit-identical），但**固定 D2 墙钟 15.5s vs LEGACY 628ms（24.7× 慢）**，100ms 下 D2 完成 0/20 → `EXACT_BUT_NO_SPEEDUP`（1.9N）；
- "Turn-Lazy" 更慢（**16.95×**）且**精确性 FAIL**（H-g5t4）（G0.3L）；
- "组合多步候选 + 静态/学习排序"这一族（Beam64、固定 reservoir、静态前缀流、分层静态流、学习型提案组合 W/X/Y/Z）覆盖率全部停在 3–4/8，达不到预注册门（1.9AB/AC/AD/AE/W/X/Y/Z）。

**真正还没被否掉的不是"Hybrid"，而是"叶子精确化 + 节点数削减"**（见 ④ 与第 8 节）。

**⑤ 下一轮到底应该先研究哪一项？**
**唯一推荐：PTB-1 =「精确战术边界（Exact Tactical Boundary）」。** 第一步只做 **静态"一回合内必胜/必败"判定**，把它接到叶子上。它**不增加任何搜索节点**（复用评估已算好的两张距离图，O(1) 判定），却把"代理分数"换成"证书"，直接命中两个已定案的失败类别中的至少一类（HORIZON）。这是 Arimaa 唯一被证明有效、而我们**从未实现**的迁移点（SHARP 的 static goal detection）。第二、三步才是精确 CHANCE 压缩（1.9D 已证明但从未接线）与 PVS/aspiration/LMR。

---

## A. 当前 AI 架构审计报告

### A.1 完整搜索调用链（生产 Hard）

```
GamePage.tsx:204  computeCatAiTrajectory(state)
  └─ engine.ts:3954  computeCatAiTrajectory              // 一整回合只规划一次
       └─ engine.ts:4004  planHardCatTurn(current, {timeBudgetMs:100, refutation:{150}, leaf:resolveHardLeaf()})
            └─ ai/hardTurnPlanner.ts:220  planHardCatTurn
                 ├─ searchBestActionIterative(state, {maxDepthTurns:4, maxNodes:500_000,
                 │     useTT:true, useAlphaBeta:true, useMoveOrdering:true,
                 │     useThreatOrdering:false, maxThreatExtensions:0, deadlineMs:t0+100})
                 │    └─ expectiminimax.ts:2198  searchBestActionIterative
                 │         ├─ createSearchContext(...)        // 新 TT、新 evalCache、新 diagnostics
                 │         └─ for d = 1..4: runFixedSearch(state, d, ctx, sharedNodeCount)
                 │              └─ searchActions(root, …) ──┐
                 │                    └─ valueOfAction ─→ _search ─→ _searchInner ─→ searchActions (递归)
                 ├─ runRefutationSidecar(...)   // G0.3W 有界反驳 sidecar（HARD_TRIAL 开启，150ms 内剩余时间）
                 └─ runProgressGuard(...)       // M3-lite，默认 OFF（HARD_PROGRESS_GUARD_DEFAULT=false）
       └─ 逐步执行 plan：applyPlanCatAction(current, action) → 失败则 logFallback + catAiMove(legacy)
```

`catAiMove`（`engine.ts:3859`，单步入口，测试/UI 另一路径）同样先跑 `planHardCatTurn`，只取 `plan[0]`。两条路径共用同一 planner，但**每步重搜**只发生在 `catAiMove` 路径；生产轨迹路径是"一次规划、逐步执行"。

### A.2 搜索的数学骨架（实测语义）

| 维度 | 实现 | 证据 |
|---|---|---|
| 值语义 | 猫 = MAX，鼠 = MIN，随机 = CHANCE（期望） | `expectiminimax.ts:1463-1519` |
| 分数结构 | `{value, mate}` 词法序：`cat-mate(2) > non-mate(1) > mouse-mate(0)` | `:206-236` |
| 深度单位 | **回合**（行动权切换才递减），原子步不递减 | `:1465-1466` |
| 0 代价动作 | `catPlaceTrap=0`、`mouseSkill=0`、`chooseTunnel=0` | `:294-307` |
| 终局 | `±MATE_SCORE`，node-local，逐边按 `mateActionCost` 步进 | `:1547-1554`、`:318-356` |
| 重复 | 当前递归路径集合命中 → 静态评估，`cacheable=false` | `:1561-1564` |
| α-β | MAX/MIN 上生效；子窗口用 `unstepBoundForChild` 反变换 | `:1303-1421` |
| **CHANCE** | **永不剪枝，每个 outcome 全窗搜索**，全 outcome 同侧 mate 才继承 mate | `:1475-1518` |
| TT | 只存 `completed && exact`，探针要求 `depthTurns` 与 `extensionsRemaining` 精确相等 | `:1032-1112`、`transposition.ts:87-101` |
| 迭代加深 | 1..4 层，共享一个 `maxNodes` 与一个绝对 deadline；截断层丢弃，回退到最深层完成结果 | `:2254-2313` |
| 计划提取 | `planBranches` 主变例游走 → `equalPrimaryGraph` 的 DP 重排 → 强制负 tie-break | `:1884-1950`、`planQuality.ts:426-580` |
| 时间契约 | 主搜索软预算 100ms（`searchConfig.ts:18`）；整回合硬墙 150ms（`HARD_TRIAL.totalTurnBudgetMs`）；1200→ 见 `deadlineContext.ts` | `searchConfig.ts:16-40` |

### A.3 逐项回答任务书 P2 的 12 个问题

**1) 同一玩家连续行动是否正确维护 —— 正确。**
`valueOfAction` 只在 `state.currentPlayer !== next.currentPlayer` 时 `nd = depthTurns - 1`（`:1465-1466`）。猫放陷阱、鼠放技能、推箱（仍是 catStep）、踩陷阱后的换手都由真实转移决定玩家，深度不会误扣。

**2) 回合切换时深度递减 —— 正确，但有一处隐式契约。**
`mouseStep` 在引擎内部就会在"步数耗尽/踩陷阱"时调用共享 `endTurn`（`engine.ts:766-777`），所以模拟器**不能**再补一次 `endTurn`（`simulator.ts:132-137` 明确写了这一点）；`chooseTunnel` 之后由 `forceEndTurnIfNeeded` 补一次（`:79-82`）。⇒ 若未来改引擎的 `mouseStep` 收尾逻辑，搜索会**静默错一层**。这是一个必须写进规则层契约的耦合点。

**3) 技能/陷阱/传送等零步数动作 —— 正确。**
`mateActionCost` 用穷尽 switch（`:294-307`），新增动作类型会编译期报错。不存在 0 代价死循环：放陷阱要求 `trapPosition===null`，回收是 1 代价的 `catStep`，技能只能激活一次（`mouseSkillActive`），传送后 `mouseMovesLeft=0` 立刻换手。

**4) 隐藏的固定四步假设 —— 搜索内核没有，计划层有。**
- 内核：无 `=== 4`；`catBaseMoves` 仅出现在 `endTurn` 预算重置、`stateKey` 配置签名、H1 `tempo` 归一化（`evaluation.ts:703`）。
- **计划层：`maxLength = 8` 硬上限 3 处**（`expectiminimax.ts:1887`、`planQuality.ts:245`、`:431`）。猫 ≤7 步时安全（7+1 陷阱=8）；**≥8 步必然截断**。
- 轨迹执行：`maxSafety = catBaseMoves*8+20`（自适应，安全）。

**⇒ "猫 4 步改 5 步是否只需改配置"：是（≤7 步）；但设置在 UI 上根本没有猫步数入口，且棋力未证明。**

**5) 猫回合计划提取能否推广为通用玩家回合计划 —— 不能直接推广。**
`buildCatTurnPlan` 在 `currentPlayer !== Cat` 时 `break`（`:1894`）；`extractDp` 在 `currentPlayer !== Cat` 时返回 `[]`（`planQuality.ts:477`）；`buildPlanForFirstAction` 只接受 `catStep`/`catPlaceTrap`（`:250`）。而且**鼠的多一层难点不是"换名字"，是"计划要分支"**（见 D.3）。

**6) α-β 与随机 CHANCE 是否能继续保证正确性 —— 是，且是保守正确。**
CHANCE 节点每个 outcome 都用 `NEG_INF..POS_INF` 全窗搜索（`:1508`），算出的期望是**精确值**，再交给父节点参与窗口比较与剪枝。因此不存在"用不完整期望去剪枝"的错误。代价是：**chance 子树永远吃不到父窗口**，这是 D2 成本的主要放大器之一（G0.3J：单根 chance 路径 177–1,724 条，最大扇出 27）。`*-minimax` 的 star1/star2 有界剪枝在理论上可用，但需要概率下界与单调性假设，本轮不建议动。

**7) TT 的配置遗漏 / 状态身份混淆 / 跨规则复用风险**
`stateKey` 实际包含 18 个分量（`transposition.ts:39-62`）：
`boardKey`（逐格 `type[0]+piece[0]+butter`）、`gameMode`、`phase`、`currentPlayer`、猫坐标、鼠坐标、`catMovesLeft`、`mouseMovesLeft`、`butterPositions`(集合规范化)、`pendingButterSpawns`(含 blocked 计数)、`pendingButterPlacementDebt`、`mouseHasButter`、`mouseSkillActive`、`trapPosition`、`catTrapsRemaining`、`blockedTunnels`、`tunnelExitChoices`、**配置签名 8 字段**（`boardSize:mouseBaseMoves:mouseCarryingMoves:mouseSkillExtraMoves:catBaseMoves:butterCount:gameMode:difficulty`）。

**风险清单（都真实存在，但今天都不致命）：**
| 风险 | 现状 | 触发条件 |
|---|---|---|
| **无 `GAMEPLAY_RULESET_VERSION`** | 键里没有 | 今天 TT 是 per-search（`transposition.ts:104-109`），**不可能**跨规则复用；一旦做持久 TT 就会污染 |
| **无 `mouseHole` / `tunnelCorners` / `customTerrain` / `boxCount` / `pileCount`** | 依赖"地形已体现在 `boardKey`" | 自定义地图里 `config.mouseHole` 与 `board` 的洞格不一致时（规则读 config：`evaluation.ts:44-47`、`mobility.ts:72`），会出现"同键不同规则" |
| `difficulty` 进键 | 多余 | 只造成缓存分割（难度不改变规则），非正确性问题 |
| 无 bound 型条目 | 只存 exact | 命中率偏低（保守，不是错误） |

**8) Move Ordering 对猫、鼠是否合理 —— 对猫勉强合理，对鼠基本无语义。**
`computeOrderingScore` = `10×(曼哈顿距离变化)`，加可选威胁路线 delta；MIN 节点翻转排序方向（`:1143-1169`、`:1263`）。TT bestAction 优先。鼠方没有任何"接近黄油/洞口/可用通道/技能解锁"的分量，等于随机顺序 + TT 惯性。**也没有 killer / history heuristic**（`hardHistory.ts` 是调试用的根快照，不是搜索 history）。

**9) H1 是否依赖默认地图规模 / 鼠洞数量 / 箱子布局**
- **规模**：主要项都做了归一化（`capturePressure/boardSize`、`confinement` 用面积比、`holeControl/boardSize`、`tempo/base`），5×5…20×20 不会数值爆掉（`evaluation.ts:636-723`）。但**成本是 O(N²)**：每叶 3 次 BFS + 一次全盘 Voronoi 扫描，15×15 时单叶成本约 2.25×（详见 E 组 S4）。
- **鼠洞数量**：`mouseHole` 是**单个矩形**（`evaluation.ts:58-64`），`holeControl` 只用 `getMouseHoleGateCells` 的单一 margin。⇒ **多洞完全没有建模**。
- **箱子布局**：`catCanEnter` 把箱子视为不可进入（不建模推箱）→ `catMouseDistance` 是**高估**（保守）。HV-6 专门做了 push-aware 版本（`buildCatPushDistanceMap`）但只给 Gate Race 用。
- **学习型叶子**：`hybridLeaf.ts:160-190` 与 `a0ExpectedReturnLeaf.ts:166-169` **硬绑定** 10×10/默认洞/12 箱/4 桩/2 油/默认步数，任一项不等就 fail-closed 回 baseline。⇒ 任何非 S0 配置下，ValueNet 路线**自动失效**。

**10) 多条动作序列到达同一状态时是否有去重 —— 节点层有，回合层没有。**
TT 做节点级精确去重（`stateKey#depth#ext`）；集合字段已 canonicalize。但 G0.3J 实测：**同一回合内** 64.5–95.0% 的原子序列汇聚到少量回合终态（鼠侧 95%），节点级 TT 无法利用"同回合前缀等价"—— 这正是 turn DAG 想解决的，而它的代价是 24.7× 慢（1.9N）。

**11) 是否在生成非法动作 / 重复模拟 / 重复评价上浪费 —— 有一处明确浪费。**
`generateLegalSearchActions` 为了判定"是否 no-op"，对**每个候选动作**调用一次 `simulateSearchAction`（`legalActions.ts:66-75`），随后 `searchActions` 又对同一批动作**再模拟一次**（`expectiminimax.ts:1228-1233`）→ **每节点每动作 2 次转移**。评估侧已有 `evalCache`（stateKey→值，`expectiminimax.ts:942-981`）去重，`stateKey` 每节点只算一次并向下传。

**12) 为什么容易停在 D1，D2 成本来自哪些结构性因素**
四个乘数叠在一起：

| 因素 | 实测/推论 |
|---|---|
| **深度量化过粗** | 深度以回合计：**D1 = 自己 1 个回合 + 对手 0 层**（首个换手后 depth→0，对手回合被静态评估，完全不展开）。D2 才等于"自己回合 + 对手回合 + 叶"。中间没有"半个回合"档位 |
| 回合内分支 | 每原子步 ~2.6–3.9 分支；一回合 3–5 步 → 理论 10²–10³；去重后 14–214 个不同终态（G0.3J） |
| 节点数 | D1 = 18–154；**D2 = 655–8,558**（G0.3M 实测 A 4,283 / E 8,558） |
| 单节点成本 | 1 次叶评 ≈ **0.22ms**（`expectiminimax.ts:55-67` 注释实测），3 次 BFS + 全盘 Voronoi |
| ⇒ D2 墙钟 | **400ms – 3.6s**（G0.3M，冷机）；100ms 只够 D1 |
| CHANCE 放大 | 全窗 chance + 扇出最高 27 → 鼠回合子树成本主导 |
| 微优化天花板 | **Amdahl 上界 5.94×**（把 evaluate+legalActions+stateKey+transition+ordering 全部理想化为 0），而 G1T9 类需要 **7.8×（median）/ 8.7×（90ms 余量）** ⇒ **只削成本不可能达标，必须削节点数**（1.9M） |

> 这一条是整份报告最重要的审计结论：**D1 不是"1 层搜索"，是"对手 0 层的搜索"**。它解释了为什么 D1 的棋力断层如此之大，也解释了为什么 1.9L 的 HORIZON 类只要 D2 就能修好。

### A.4 已定案的两类失败（不可混为一谈）

| 类别 | 机制 | 加深能否修 | 来源 |
|---|---|---|---|
| **HORIZON** | 100ms 只完成 D1；固定 D2 后同一 H1 自动改选安全线（G1T9：DLDL BAD → DRDD SAFE） | **能** | 1.9L |
| **REPRESENTATION** | 搜索已到完整 frontier，H1 仍把 BAD 排第一（G8T10：R 线 −1233.21 全 BAD > D 线 −1377.95 唯一 SAFE） | **不能**（加深不修） | 1.9L |

⇒ 只修深度只能修一半；只改权重被 1.9M 证否（R1/R2/R3 全 FALSE，R2 还在 G8T9 造成 SAFE→BAD 反转）。

### A.5 记录在案的两处"代码 vs 文档"差异（不修，只登记）

1. **传送出口集合**：`GAMEPLAY.md §9.1` 说"传送到对角线对面的角落"；代码 `getTunnelExits` 返回**所有未封锁的其他角**（`tunnelRules.ts:94-106`），且 `applyMouseStepCore` 额外 `unshift` 一个"↺ 原地"选项（`engine.ts:650-652`，注释自称 "Bug 2"）。⇒ 搜索的 `chooseTunnel` 动作集包含"原地"，与文档不一致。**这是 baseline 差异，不是回归，本轮不动，但它进入任何规则敏感基准前必须钉住。**
2. **RULE-A 与"原地传送"**：`mobility.ts:58-60` 明确"引擎总是提供原地选项，所以可用的开放角落即使其他角全被堵也可进入"。⇒ 通道封锁的战术价值被削弱，猫"推箱封通道"的收益低于文档直觉。

---

## B. Arimaa / Stockfish / AlphaZero 技术适配矩阵

**证据等级**：`[原文]` = 本轮通过检索读到论文/期刊正文摘要；`[标准]` = 领域标准定义，未逐页核实原文；`[实测]` = 本项目代码或历史工件。

### B.1 Arimaa / SHARP

来源：David J. Wu, *Designing a Winning Arimaa Program*, ICGA Journal 38(1), 2015（`icosahedral.net/downloads/djwu2015arimaa.pdf`）；*ICGA Journal* 38(1) 编者综述（`arimaa.com/arimaa/papers/150301ICGA/ICGA38-1.pdf`）。**两者本轮读到正文摘要级内容，标注 `[原文摘要]`；未逐页核对全部实验表格。**

| 技术 | SHARP 的做法 `[原文摘要]` | 我们的现状 `[实测]` | 适配裁决 |
|---|---|---|---|
| **Stepwise search** | 迭代加深 α-β，**以"步"为层** | 已实现，但**以"回合"为层** | **已同族，粒度落后** |
| **Turnwise（整回合为边）** | 不是主搜索 | 只有离线枚举器（`turnBoundary.ts`） | 只作正确性 oracle |
| **Hybrid step/turn** | 不是"枚举组合再搜"，而是"逐步搜 + 战术静止层" | 见 C 节失败史 | **`NO_NEW_HYBRID_CANDIDATE`** |
| **静态目标检测**（数千行决策树，叶子上判定 4 步内能否得分） | 核心武器：**白送 4 步视界**，叶子调用几乎零成本 | **完全没有**。我们只有"到达终局才判" + 距离代理 | **★最高优先级采纳**（= PTB-1 的 M1） |
| **静态吃子生成 / 可捕判定** | 用于静止搜索与排序 | 有合法动作生成，无"必捕/可捕"静态判定 | 中等（并入 M1） |
| **Move ordering**（TT move → killer 1-8 → 按被吃子大小 → 战术+history → 其余） | 树内；另有**只在根**用的专家排序（0.1s/次，太慢不能进树） | 只有 TT move + 曼哈顿 | 可补 killer/history（收益小：我们每节点 ≤5 动作） |
| **LMR**（root 10% 后 −1 步 / 20% 后 −2 步，带回搜） | **2015 年最大突破**，靠新排序才敢用 | **从未尝试** | **★高优先级**（唯一"减节点且可验证"的未试手段） |
| **Extensions**（得分威胁需 ≥2/≥3 步防守 → +1/+2 步） | 有用 | G0.3B 试过 → 真人 root 无收益、Turn5 completedDepth 1→0 → **回滚** | 不再重做（同一形态） |
| **Quiescence**（只生成"得分防守/吃子/特例"的极小战术集） | 有用 | G0.3S/T/U 试过"叶子扩展式" → 触发器密集、无稀疏信号 → 失败 | **形态必须换**：改成"终止等价判定"（M1），不是"再搜几层" |
| **Aspiration window** | 未在摘要中读到 | 代码明确"每个 root 全窗"（`:2002-2004`） | 可加（低成本） |
| **多线程 DTS** | 有 | 不适用（主线程 UI，100ms） | 排除 |
| **专家排序学习** | 根节点有效 | 1.9W/X/Y/Z 覆盖率 3–4/8 | 排除（见 C） |

**关键洞察（回答"为何 Arimaa 既不只枚举整回合、也不只是简单逐步搜索"）**：
Arimaa 的答案不是"换树骨架"，而是**在逐步搜索里同时做三件事**——(a) 用**静态判定**把"4 步战术"从搜索里拿掉（goal/capture detection），(b) 用**极小战术集**在 horizon 处做静止，(c) 用**排序 + 减速**把"价值很低的动作排列"直接从树上砍掉，只留真正关键的组合。
我们过去 18 个月反复尝试的其实是 (b) 的错误形态（"扩展"而非"判定"）与 (c) 的错误形态（"生成候选"而非"减速搜索"）。**这不是命名问题，是机制方向反了。**

### B.2 Stockfish / Pikafish

以下 `[标准]`（Chess Programming Wiki 定义级；本轮未逐页核实源码实现）。

| 技术 | 可否适配我们的 CHANCE | 裁决 |
|---|---|---|
| Alpha-Beta / fail-soft | 已实现（`bound` 三态 + 词法 mate） | 保留 |
| **PVS（零窗口 + 重搜）** | **可以**：我们已有 `ScoreBound` 与 `'lower'/'upper'` 记录，零窗口 = `beta = alpha+ε`。CHANCE 子树仍必须全窗 | **可加，值保持** |
| Iterative Deepening | 已实现（共享节点预算 + 共享 deadline） | 保留 |
| TT | 已实现，但只存 exact | 可加 bound 条目（需 depth 条件），提高命中 |
| **跨回合 TT 持久化** | 今天 per-search，每回合全新（`transposition.ts:104-109`） | **可加（需先修键：加 ruleset version）** |
| History / Killer | 可加，收益受限于 ≤5 动作/节点 | 低优先级 |
| **Aspiration windows** | 可加 | 低风险 |
| **LMR** | **可加但危险**：我们排序弱、叶评贵；必须"减深度 + 变好就回搜"，否则变成"另一个算法" | **中优先级，须预注册值保持门** |
| Quiescence | 我们已有事实上的静止：0 代价动作不递减深度（陷阱/技能/传送） | 保留，不再加 |
| **NNUE / 增量评估** | **不适用**：1.9BA 生产影子**时延预检直接 FAIL**；且 808 维 ValueNet 硬绑定 10×10 默认图 | 排除 |
| Endgame tablebase | 不适用（无子力兑换结构） | 排除 |

### B.3 AlphaZero / Leela Chess Zero

`[标准]`：Silver et al., *Mastering Chess and Shogi by Self-Play with a General Reinforcement Learning Algorithm*, arXiv:1712.01815（PUCT/MCTS + policy/value 双头 + 自对弈）。

| 技术 | 适配判断 |
|---|---|
| **MCTS/PUCT 作主搜索** | **不适用**。100ms ÷ 0.22ms/叶 ≈ 450 次评估；根分支 ~150 个猫回合候选 ⇒ 每个根候选 <3 次访问。PUCT 的统计优势需要每候选 ≥10–50 次访问，量级差一个数量级 |
| **Policy 网络做候选生成/排序** | **潜力已被测过且不足**：1.9W/X/Y/Z 覆盖率 3–4/8；Beam64 是唯一"有希望"的生成器（DEV 8/8、X-holdout 11/12、P50 2.65ms），但它是**规则语义前缀 beam**，不是神经网络。⇒ 结论：**可以保留"轻量策略模型只生成/排序候选、绝不替代规则计算"这个原则，但当前没有达到门槛的实现** |
| Value 网络 | 1.9AZ 泛化确证（+0.04923，CI 全正），但 **1.9BA 生产影子预检 FAIL**（时延）⇒ 不能进 100ms 关键路径 |
| 自对弈 | 只能作**验证手段**（配对对照），本轮不跑 |

### B.4 五子棋式威胁空间搜索 / 证明数搜索

`[标准]`：Allis, van der Meulen, van den Herik, *Proof-number search*, Artificial Intelligence 66(1), 1994；Allis, *Searching for Solutions in Games and AI*, PhD thesis, 1994（threat-space search）；Nagai, *df-pn* 2002。**本轮未读原文，仅标准定义。**

| 用途 | 在我们这里是否成立 |
|---|---|
| 鼠持黄油逼近洞口 | **不需要通用 PN 搜索**：这是**距离竞赛**，BFS 距离 ≤ 剩余步数就是精确判定（鼠回合内猫不动）。用距离判定比 PN 便宜几个数量级 |
| 猫的强制抓捕 | 同上（猫回合内鼠不动），`catMap` 距离 ≤ `catMovesLeft` 即精确（且因不建模推箱而**保守**） |
| 猫推箱封锁 | 需要"推箱后地形"的 AND/OR 推理，属于**双回合**结构 → 只能离线 H2 类，不可进 100ms |
| 无合法行动判负 | **已经是精确的**：`rules/mobility.ts` 纯函数，`simulateSearchAction` 每个转移都先 `applyNoMoveLoss` |
| 有限视界内强制胜负证明 | **只能离线**（1.9AK：H2 精确认证在 35/50ms 下 0/14、0/10 全 FALSE） |
| **红线** | 任何 `CERTIFIED_*` 都只是"该视界内"的结论，**不得**表述为整局最优；RULE-B 的 `UNKNOWN` 永不等于安全（`GAMEPLAY.md §10.2`） |

---

## C. 旧实验失败路线继承表

来源：`G0.4F-2B-1.9AO-hard-ai-architecture-consolidation.md`（§2/§3/§4/§5 逐条复核）+ G0.3J/K/L/M + 1.9D/L/M/N/AB~BA。下表所有"无效/超预算"均有对应报告或工件，不是印象。

### C.1 已验证有效（可复用，不得重做）

| 项 | 证据 |
|---|---|
| 真实规则模拟器 + 精确 `stateKey` + 精确回放（parity 恒 100%） | 1.9AO §2；191/191 … 845/845 |
| 迭代加深 + TT + α-β + 排序框架（D1 有效；D2 warm 节点比 cold 少 10–45%） | G0.3M |
| H1 corrected-hole 修复（`baseline_hole_corrected`，flag OFF，唯一确认的叶子修复） | F2B-1.1/1.2 |
| Beam64（规则语义前缀 beam）**作为候选生成源**（DEV 8/8、X-holdout 11/12、P50 2.65ms） | 1.9AB |
| `B_PLAN_REFUTED` 作为风险信号（无假反驳） | 1.9O / 1.9AF / 1.9AH |
| canonical-v1 自对弈/rollout 作为评估 harness（fingerprint 3917ce9c） | AL/AM 系列 |
| **1.9D ghost 宣告的 horizon-inert 等价性（bit-exact 复用已证明）** | 1.9D §2/§3 |

### C.2 已验证无效（禁止改名重做）

| 路线 | 否证证据 | 不得以何名义复活 |
|---|---|---|
| 威胁扩展 / 叶静止（G0.3S/T/U） | 触发器密集、无稀疏信号；真人 root 无收益 | "Quiescence Search"、"Tactical Extension" |
| 精确计划探针作运行时 / TURN_DAG 运行时 / Turn-Lazy | 1.9H/I/J/N：`EXACT_BUT_NO_SPEEDUP`，D2 15.5s vs 628ms（24.7×）；G0.3L：16.95× 且 exactness FAIL | "Arimaa Search"、"Turn-based Search" |
| 廉价表征修补 / 纯微优化（1.9E/F/M） | 标量特征无法表达结构性 forced loss；Amdahl 5.94× < 7.8× | "NNUE"、"增量评估" |
| 静态完成计划排序（固定 reservoir / 静态前缀流 / 分层静态流） | SAFE 沉在完成序 27–141 位 | "Move Ordering v2" |
| 正向补充（1.9AF，覆盖 2/8） | 因果价值有、覆盖率不足 | "Candidate Refill" |
| 战术前缀序（1.9AG）/ PATH8 对抗轨迹（1.9AH） | 因果增益 ≈ 0 | "Tactical Ordering" |
| 学习型提案组合 W/X/Y/Z | 覆盖率 3/8、4/8、3/8、3/8 | "Policy Network 候选生成" |
| 精确 H2 运行时认证（1.9AK） | 35/50ms 下 SAFE 0/14、BAD 0/10（strict FALSE） | "AND/OR 在线安全网" |
| H2-only 训练 / 当前 H2 辅助头（Q/R/S/S-R1/T/U） | 0.6348 退化、0.5135、0.7353<0.75、shadow 全失败 | "H2 蒸馏" |
| A0 冻结期望收益模型上生产 | **1.9BA：`PRODUCTION_SHADOW_PREFLIGHT_FAIL`**（时延预检未过，未进入全对局 A/B） | "Expected-Strength Consumer" |

### C.3 正确但超预算（只可离线）

- H2 AND/OR 安全 oracle（exact 227s / root；28 root 重认证 SAFE 9 / BAD 5 / UNRESOLVED 14）
- PN/df-pn 式有限视界证明
- 回合 DAG 精确枚举（`enumerateFullTurnLegacy` / `buildTurnDag`）
- METHOD_A 精确标签

### C.4 只适合离线（禁止进关键路径）

H2 oracle、H1 frozen oracle、Beam64、ValueNet/S-R1、A0_LINEAR、所有 `ai-training/**` 工件。

### C.5 有潜力但尚未完成（本轮新识别的空档）

| 空档 | 为何有潜力 | 为何此前没做 |
|---|---|---|
| **精确战术叶子判定**（一回合内必胜/必败证书） | 零新增节点；sound；直接命中 REPRESENTATION（"结构性强败无法用标量表达"）与 HORIZON 两类 | 历史所有尝试都是"多搜"或"改权重"，**从未把"证书"作为叶值** |
| **精确 CHANCE 压缩** | 1.9D 已给出 bit-exact 等价证明 | 从未接线（该阶段明令禁止 production 接线） |
| **PVS / aspiration / LMR** | 全部"减节点"，是 Amdahl 天花板之外的唯一空间 | 历史只做"增/扩/生成" |
| **跨回合 TT 持久化** | 每回合丢弃一整张表；warm 收益已在 G0.3M 量化（−10~−45%） | 担心跨规则污染（可先修键解决） |
| **鼠 AI** | 完全不存在 | 单人模式人玩鼠，从未需要 |
| 步粒度深度（step-counted depth） | 消除"回合量化"，可做半步视界 | 会改变叶语义，需重定义 |

### C.6 尚未研究

鼠方搜索；双鼠洞；多洞评价；15×15 实际时间行为；非默认步数下的 H1 分布与战术盲点；不规则 Void 图下的 RULE-B 认证成本；`chooseTunnel` 的"原地"选项对战术价值的定量影响。

---

## D. 猫鼠共享搜索架构设计

### D.1 目标形态

```
             ┌─────────────────── 一套规则内核 ───────────────────┐
             │  RuleSet (7 转移 + 2 chance 构造)  ← 唯一绑定点     │
             │  legalActions / simulator / stateKey / mobility   │
             └───────────────────────┬───────────────────────────┘
                                     │
             ┌───────────────────────┴───────────────────────────┐
             │   一套搜索基础设施（与阵营无关）                    │
             │   ID 循环 · α-β/词法 mate · TT · CHANCE 全窗       │
             │   deadlineContext · 诊断                          │
             └───────┬───────────────────────────────┬───────────┘
                     │                               │
        ┌────────────┴───────────┐      ┌────────────┴───────────┐
        │ CatPolicy (现状)        │      │ MousePolicy (待建)      │
        │ MAX · 线性计划 ·        │      │ MIN · **条件计划** ·    │
        │ 猫专用 tie-break ·      │      │ 鼠专用排序 · 鼠叶特征 · │
        │ 猫专用 fallback         │      │ 鼠专用 fallback         │
        └────────────────────────┘      └────────────────────────┘
```

### D.2 现状差距（逐条对应 P5 的 12 问）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 搜索以猫为 MAX、鼠为 MIN | 是；但只是 `maximizing = currentPlayer===Cat`（`:1223`），本身阵营无关 | `expectiminimax.ts:1223` |
| 2 | 从鼠根能否得到正确搜索值 | **能**。根的 `inRootCatTurn` 传 `currentPlayer===Cat`（`:1794`），鼠根直接为 `false`，无猫偏向；CHANCE 期望与 mate 词法都对称 | 同上 |
| 3 | `catTurnPlan` 是否有猫专用逻辑 | **有，且很多**：`buildCatTurnPlan` 停在非猫；`extractBestCatTurnPlan`/`extractDp` 猫边界；`buildPlanForFirstAction` 只收猫动作；`applyPlanCatAction` 只认猫；`computeCatAiTrajectory` 猫专用；`progressGuard`、`forcedLossTieBreak` 猫专用 | `:1884`、`planQuality.ts:250/426/477`、`engine.ts:4354` |
| 4 | 如何建立 `mouseTurnPlan` | 需要**抽象**：`TurnPlanExtractor{actorFilter, completeness, applyAction}`。鼠版还要处理 CHANCE 分支 | — |
| 5 | 鼠技能 / 拾油 / CHANCE 公告 | 技能已是 0 代价动作（可直接进计划）；拾油会把动作结果变成 CHANCE → **计划必须分支**（D.3） | `:75-78`、`legalActions.ts:48-51` |
| 6 | 公告后依已知信息继续行动 | 真实对局里幽灵揭示后鼠**还要走完本回合剩余步数**（`GAMEPLAY §3.2`：拾取只消耗 1 步）。搜索里这段已被 CHANCE 期望覆盖；但**执行层**需要一个"揭示后 replan"接口 | `engine.ts:619-700` |
| 7 | 鼠 AI 不得使用未来随机信息 | 天然满足：CHANCE 是**期望**不是抽样；执行时用真实已揭示的幽灵 replan ⇒ 信息集一致 | `simulator.ts:57-72` |
| 8 | `ChoosingTunnelExit` | 鼠专用分支：进入通道后 `mouseMovesLeft=0` 且回合立即结束（`tunnels.ts:41-45` 不 endTurn，模拟器补）。⇒ 鼠计划里 `chooseTunnel` **必然是本回合最后一个动作**，长度语义与猫不同 | `simulator.ts:79-82` |
| 9 | 计划合法/完整/可执行 | 需要鼠版 `planFullTurnCompleteness`（现有函数名与判据全部写死 `catMovesLeft`）；`applyPlanAction` 需支持 `mouseStep/mouseSkill/chooseTunnel` 并以**真实引擎**校验 | `planQuality.ts:174-219` |
| 10 | H1 作为零和对鼠是否够好 | **形式上够（MIN 即最小化猫效用），质量上不够**：H1 是"猫的警告语言"。鼠方最相关项只有 `mouseWinRouteDistance`/`mouseButterDistance`/`tunnelEscape`。M0 可用，M1 需鼠侧特征 | `evaluation.ts:636-723` |
| 11 | 是否需独立 Mouse Policy 与排序 | **需要**。现有排序对鼠无意义（A.3-8） | `:1143-1169` |
| 12 | 自对弈验证如何防共同弱点 | 三条：①冻结一侧为 H1-baseline，只让另一侧变；②held-out 用**真人日志 root**（`ai-training/human-logs/PPC-HV14` 五局）做回归；③裁判用离线 oracle（METHOD_A/H2）而非只看胜率 | HV14/HV18/HV20 仪器 |

### D.3 M0 / M1 两个候选

**M0（最小正确鼠 AI，第一阶段唯一实现目标）**
- 复用：`searchBestActionIterative`（鼠根）、TT、α-β、ID、CHANCE 全窗。
- 新增（纯新增文件，不动猫路径）：
  - `mousePlanExtract.ts`：从 `planBranches` 走主变例，**遇到 CHANCE 边（拾油）即停止**，返回"到拾油为止的前缀"；剩余步数交给执行层 replan。
  - `mousePlanExecute.ts`：逐步 `applyPlanAction`（含 `mouseStep/mouseSkill/chooseTunnel`），并在 CHANCE 揭示后**重新调用 M0 planner**（信息集更新）。
  - `mouseFallback.ts`：鼠没有 legacy 启发式可退，必须有**保底 BFS**（朝"最近可用黄油"/"洞口"走），否则空计划会卡死 UI。
- 排序：至少加入"鼠→黄油距离""鼠→洞口距离（携带图）""技能解锁传送"三项。
- 验收：合法行动覆盖 100%、回合完整性（步数用尽或合法换手）、CHANCE 概率守恒、与真实引擎逐步 parity。

**M1（在 M0 上加质量）**
- 真正的**条件计划**（policy tree，深度 = 拾油次数）：节点 = "已揭示幽灵集合"，边 = 动作；执行时按真实揭示走对应分支。
- 鼠侧叶特征（`mouseProgress`/`safety`/`trapRisk`/`tunnelUnlockValue`），与猫 H1 共享底层 BFS 内核，不复制规则。
- 鼠专用 tie-break（避免"原地抖动"，现有 `countRevisits` 只服务猫）。

### D.4 共享内核的硬约束（沿用用户已批准条款）

1. 通道不复制：`chooseTunnelExit` 单一实现（已是）。
2. 禁止 `engine → searchHard → simulator → engine` 环：`simulator.ts` 只 import 类型 + 规则层（已是）。
3. 禁止 monkey-patch `Math.random`：CHANCE 只用枚举（已是）。
4. `depthTurns` 以行动权变化为准（已是）。
5. 叶评估纯函数、只依赖棋局（已是；`hardProgressGuardMemory` 不在 `stateKey`）。
6. TT key 排除 message/log/debug（已是）。
7. 时间预算按完整回合（已是）。
8. 每阶段 build/lint/test + 汇报（本轮只读，未跑）。

---

## E. 规则变化适应性矩阵（S0–S9）

**共同前提**：每个配置必须先过 `validateGameConfig`（`config.ts:145`）与 RULE-B 认证（`openingFairness.ts`）；不过的直接 `UNSUPPORTED`，**不得制造非法状态比较棋力**。

| 组 | 变化 | 代码是否支持 | 主要风险 | 必须验证的门 |
|---|---|---|---|---|
| **S0** | 10×10 / 猫4 / 鼠4(携带3) / 2 油 / 12 箱 / 4 桩 | ✅ 默认 | 基准 | 全部既有 gates |
| **S1** | **猫 5 步** | ✅ 配置（`catBaseMoves=5`）；无 UI | 每回合分支 ×~3.5；D2 成本 +50~100%；计划 `maxLength=8` 仍够（5+1）；H1 速度平衡漂移 | 合法性 100%、回合完整性、同规则对照胜率（**不得**把胜率变化当棋力结论） |
| **S2** | 猫 3 步 | ✅ | 分支变小、D2 可能进 100ms；猫相对变弱（规则性变弱，非算法退步） | 同上 |
| **S3** | 6×6 | ✅（`BOARD_SIZE_MIN=5`、`deriveDefaultLayout`） | RULE-B 认证在 6×6 更易通过；H1 归一化正常 | 认证必须真跑，`UNKNOWN` 不接受 |
| **S4** | **15×15** | ✅ 结构上 | **叶评成本 O(N²)**：3 次 BFS + 225 格 Voronoi ⇒ 单叶 ≈2.25×；D1 即可能超 100ms | 单叶成本、D1 完成率、`P50/P95` 时间 |
| **S5** | Void 不规则图 | ✅（`customTerrain`、`CellType.Void`） | 学习型叶子全部 fail-closed（`hybridLeaf.ts:160-190`）；RULE-B §10.4 的乐观剪枝在 Void 下的前提 | 认证结论、评估器不把 Void 当可走 |
| **S6** | 黄油 1–10 | ✅（`butterCount` 进 stateKey） | CHANCE 候选格随油数变化；`butterRace` 单阶段假设 | 概率守恒、CHANCE 扇出分布 |
| **S7** | 箱子/杂物密度 | ✅ | 猫的推箱分支上升；`confinement`/`voronoi` 大幅变化；可能出现"猫被自己封死"（RULE-A） | RULE-A 双向判定、无非法推箱 |
| **S8** | 猫鼠起点 | ✅ | `isDerivedDefaultLayout` 会拒绝非默认（不影响搜索）；H1 的洞-相对位置假设弱 | 开局认证、首回合计划合法 |
| **S9** | 鼠技能步数 | ✅（`mouseSkillExtraMoves` 进 stateKey） | 技能是 0 代价动作 ⇒ 搜索会充分利用；RULE-A 的"技能解锁"判定必须同步 | `mouseSkillUnlocksSpatialMove` 与引擎一致 |
| **S10（未来）** | **双鼠洞** | ❌ **未实现** | 见下 | — |

### E.1 双鼠洞迁移成本（不假定已实现）

| 层 | 现状 | 需要的改动 | 成本 |
|---|---|---|---|
| 数据模型 | `config.mouseHole: {r,c,size}` 单矩形 | `mouseHoles: {r,c,size}[]`（保留单洞为长度 1 的特例） | 中（改类型 + 兼容层） |
| 终局 | 鼠携带进洞即胜（`engine` 内 `isMouseHole`） | 任一洞成立 | 小 |
| 寻路 | `buildMultiSourceDistanceMap(mouseHoleCells(...))` **已是多源** | sources 变为多洞并集 | **几乎为零**（设计已经对了） |
| `holeControl` | 单一 `catHoleGateDistance - mouseHoleGateDistance` | 需改为"最近洞的覆盖度/每洞 margin"，否则多洞会互相抵消 | 中 |
| `getMouseHoleGateCells` | 单洞邻格 | 多洞并集去重 | 小 |
| `stateKey` | 洞在地形里（`boardKey` 覆盖） | 若洞只存在于 config 则必须加入签名 | 小（但要钉住"以 board 为准"） |
| RULE-B 认证 | 单洞的鼠方线路枚举 | 多洞 ⇒ 鼠方线路数×洞数，认证成本上升；`H=3/20000` 可能不够 | **大**（可能需重新标定视界/节点上限） |
| 评价特征 | 全部围绕单洞 | 见上 | 中 |

⇒ **结论：数据模型与寻路已"意外地"接近多洞；真正的成本在评价的 `holeControl` 语义与 RULE-B 认证预算，不在搜索内核。**

---

## F. 预注册对照实验方案（本轮不执行）

完整机器可读版：`PPC-ARIMAA-01_PREREGISTERED_EXPERIMENTS.json`。此处为人类可读摘要。

### F.1 三臂定义

| 臂 | 定义 | 语义性质 | 用途 |
|---|---|---|---|
| **A · LEGACY** | 当前生产 Expectiminimax（原子步、MAX/MIN/CHANCE、α-β、TT、ID、H1、100ms/150ms） | **基线，语义冻结，不得修改** | 所有比较的参照 |
| **B · PURE TURNWISE** | 以"完整回合终态"为树边；回合内枚举用 `enumerateFullTurnLegacy`/`buildTurnDag`；CHANCE 在回合边界 | 仅作**正确性 oracle + 分支膨胀测量** | 不预设更适合生产 |
| **C · HYBRID** | 本报告裁决 `NO_NEW_HYBRID_CANDIDATE` | — | **不实现**；只在 B 上量"若混合，理论边界在哪" |

**C 的裁决依据**（三条硬否证，见 C.2）：纯回合枚举重复率 64.5–95%（G0.3J）；回合 DAG 精确但 24.7× 慢（1.9N）；Lazy 16.95× 慢且精确性 FAIL（G0.3L）。而"组合多步候选 + 排序"这一族覆盖率 3–4/8（1.9AB/AC/AD/AE/W/X/Y/Z）。⇒ 没有新机制能绕开这三条，**不为交付硬造名字**。

### F.2 指标（三类，缺一不可）

**Correctness（门，不是分数）**
合法行动覆盖 100% / 回合完整性（`COMPLETE_TURN_BOUNDARY|COMPLETE_CHANCE_BOUNDARY|GAME_ENDED|NO_LEGAL_ACTIONS`）/ 转移一致性（simulator vs engine 逐步 `gameAffectingEqual`）/ CHANCE 权重有限且总和 = 1（±1e-6）/ mate 与非 mate 不可互串（词法序）/ TT 只复用 `depth+ext` 精确匹配且 `completed && exact` / 截断与 UNKNOWN 传播 / 规则版本隔离。

**Performance**
节点数、唯一状态数、**完成深度（completedDepth 分布）**、完整回合候选覆盖、CPU/wall、P50/P95/P99、内存峰值、100ms/150ms 达标率、`search_incomplete`/fallback 率。

**Playing Strength（只用同规则对照）**
猫胜率、鼠胜率、**成对**对局结果（同一 root 双向各一局）、真实战术失误率（用 HV18 式"可避免败"判定）、避免已证明败局的能力、跨 S0–S9 的泛化。

### F.3 反作弊条款（预注册）

1. 所有臂 **同 ruleset、同预算、同随机流**（chance 用枚举，不用抽样 ⇒ 天然可复现）。
2. 开发集 / 未见验证集分离；**不得**只用旧失败局面证明新算法。
3. **不得**以减少已冻结 correctness gates 换取速度。
4. **不得**把"搜更多节点"当作棋力提升；**不得**扩大时间预算制造架构优势。
5. `HEAVY_WORKER_CONCURRENCY = 1`、`SERIAL_FRESH_REPETITIONS = TRUE`、重复载荷检查必做。
6. 任何 `UNKNOWN`/`INCOMPLETE` 不得计入"更安全"。

---

## G. 架构结论与唯一推荐路线

### G.1 十条裁决（按优先级）

| # | 问题 | 裁决 |
|---|---|---|
| 1 | 当前 Stepwise Expectiminimax 是否保留？ | **保留，作为唯一生产基线。** 它是 Arimaa 同族骨架，且已有精确规则模拟、精确 `stateKey`、词法 mate、CHANCE 全窗等正确性资产。**不要换骨架。** |
| 2 | 纯 Turnwise 是否有正式生产价值？ | **无。** 只作 oracle 与分支测量。 |
| 3 | Hybrid 是否存在值得验证的新机制？ | **`NO_NEW_HYBRID_CANDIDATE`。** 唯一有价值的"混合"其实不是混合，而是**叶子精确化**（见 4）。 |
| 4 | 鼠 AI 是否应复用同一搜索内核？ | **应复用内核，必须重写计划层。** M0 先行（线性前缀 + CHANCE 处 replan），M1 再做条件计划。 |
| 5 | H1 是否必须重构才能适应不同尺寸/多洞？ | **尺寸不必（已归一化）；多洞必须。** 多洞的真正成本在 `holeControl` 语义与 RULE-B 认证预算。 |
| 6 | TT 与状态键如何支持规则版本变化？ | **今天必须先补 `GAMEPLAY_RULESET_VERSION` + `mouseHole/tunnelCorners` 到键**，否则禁止任何持久化；然后才谈跨回合复用。 |
| 7 | 哪些优化可能提升搜索深度？ | ①精确战术叶子（等价于白送一回合视界）②精确 CHANCE 压缩 ③PVS/aspiration ④LMR（带回搜）⑤跨回合 TT ⑥消除每节点双次模拟。 |
| 8 | 哪些优化可能真正提高胜率？ | 只有**改变决策**的：①精确战术叶子（把代理值换成证书）②鼠 AI（现在根本不存在）③排序（对鼠）。其余都是"同决策更快"。 |
| 9 | 哪些路线有失败证据不该再投？ | C.2 全部 10 类。 |
| 10 | 下一代可扩展架构怎么规划？ | 见 G.2。 |

### G.2 唯一推荐：**PTB-1（Proven Tactical Boundary）**

三步，严格串行，每步独立 GO/NO-GO，**全部值保持或可证明不劣**：

#### M1 —— 精确战术叶子判定（第一步，唯一本轮建议立刻批准的研究项）

**机制**：在 `_search` 的 depth≤0 叶子处（以及 `evaluateLeaf` 之前）加一个**纯函数证书判定**：

```
exactTurnCertificate(state) -> {kind:'cat'|'mouse'|null, distance}
  if phase === Playing && currentPlayer === Mouse:
      if mouseHasButter && carryingHoleDist(mouse) <= mouseMovesLeft  → {mouse, carryingHoleDist}
  if phase === Playing && currentPlayer === Cat:
      if catWalkDist(cat→mouse) <= catMovesLeft                        → {cat, catWalkDist}
```

- `carryingHoleDist` = 已有 `carryHoleMap`（`evaluation.ts:453-455`，正交、禁传送、禁猫格）→ **精确且可行**。
- `catWalkDist` = 已有 `catMap`（不含推箱）→ **高估**，因此"≤ movesLeft"只会**少判**，不会误判 ⇒ **sound**。
- 值语义：返回 `mate='mouse'` 且 `value = -(MATE_SCORE - k)`（`k` = 距离），与现有 node-local 语义一致，`stepScore`/`stepChildForParent` 自动正确步进；TT 安全（`k` 是状态的函数）。
- **新增节点数 = 0**；新增成本 = O(1)（复用已建的距离图）。

**为什么这不是 G0.3B/S/T/U 的重做**（必须写清，否则会被正确驳回）：

| 维度 | 失败的那一族 | M1 |
|---|---|---|
| 方向 | 在 horizon **再多搜几层**（树变大） | 在 horizon **给结论**（树不变） |
| 触发 | 启发式触发器（威胁紧迫度 / 拦截几何比） | **精确判定**（距离 ≤ 剩余步数），无阈值 |
| 密度 | 密集触发 → 到处加节点 | 稀疏触发（真必胜/必败才触发） |
| 结果性质 | 近似值（可能更差） | **证书**（可被穷举搜索验证） |
| 失败模式 | Turn5 completedDepth 1→0 | 不改变节点预算，最坏情况是"没触发" |

**它同时命中 REPRESENTATION**：1.9M 的结论是"结构性 forced loss 无法用标量特征表达"——但 1.9M 试的是**权重**。一回合内的必胜/必败**根本不需要权重**，它是一条距离不等式。

**预注册限界（必须如实写）**：M1 只能表达"1 回合内"的强制胜负。G8T10 那类"2 回合结构性 BAD"**不会被修好**。预期收益是 HORIZON 类，不是全部。

**GO 门（M1）**：
- C1：全部既有 correctness gates 保持绿；
- C2：在 dev root 集上，凡 M1 判定为 mate 的叶子，用固定深度穷举搜索**必须**复核一致（0 反例）；
- C3：G1T9 类 dev root 在**固定 100ms** 下不得比 LEGACY 更差（同一 root 的 METHOD_A/H2 标签不得从 SAFE 变 BAD）；
- C4：`completedDepth` 分布不得下降。
- **NO-GO**：C1/C2 任一失败 → 立即回退（一个 flag 关掉）。

#### M2 —— 精确 CHANCE 压缩（第二步）

复用 1.9D 已证明的 `isGhostAnnouncementHorizonInert` 谓词（bit-exact 复用，不是近似）。前提：先补 `stateKey` 规则版本。**GO 门**：与 LEGACY 在同 depth 下 value+mate **逐位相等**（1.9D 的 parity 方法），且节点数下降 ≥ 1.4×。

#### M3 —— 节点数削减（第三步）

PVS + aspiration + 跨回合 TT（键修好后）。**GO 门**：同 depth 逐位相等；100ms 下 D2 完成率从基线提升到预注册阈值（建议 dev ≥60%、holdout ≥40%）。

**为什么这个顺序**：M1 是唯一"零成本、sound、直接改决策"的；M2 已被证明可行但只省常数；M3 风险最高（会改变搜索轨迹），必须放在正确性资产最稳的时候做。若 M1 单独就能把 HORIZON 类修好，M3 的优先级可以降。

### G.3 明确不做（本轮与下一轮）

不实现新搜索器；不开发鼠 AI（只出设计）；不启动 Benchmark；不训练模型；不改 GAMEPLAY；不改 100/150ms；不给猫加步数/陷阱/速度；不使用"读未来随机/改图/传送作弊"。

---

## 附录：主要代码锚点索引

| 主题 | 文件:行 |
|---|---|
| 深度只在换手时递减 | `ai/expectiminimax.ts:1465-1466` |
| CHANCE 全窗不剪枝 | `ai/expectiminimax.ts:1475-1518` |
| 零代价动作表 | `ai/expectiminimax.ts:294-307` |
| TT 精确匹配 | `ai/expectiminimax.ts:1032-1112`、`ai/transposition.ts:87-101` |
| 状态键 18 分量 | `ai/transposition.ts:39-62` |
| 计划长度 8 | `ai/expectiminimax.ts:1887`、`ai/planQuality.ts:245`、`:431` |
| 猫专用计划边界 | `ai/expectiminimax.ts:1894`、`ai/planQuality.ts:477` |
| 每节点双次模拟 | `ai/legalActions.ts:66-75` + `ai/expectiminimax.ts:1228-1233` |
| 评估缓存 | `ai/expectiminimax.ts:942-981` |
| 排序分（曼哈顿） | `ai/expectiminimax.ts:1143-1169` |
| 学习型叶子 10×10 门 | `ai/hybridLeaf.ts:160-190`、`ai/a0ExpectedReturnLeaf.ts:166-169` |
| 单洞假设 | `ai/evaluation.ts:44-64`、`ai/evaluation.ts:569-591` |
| 通道出口（含原地） | `rules/tunnelRules.ts:94-106`、`engine.ts:650-652` |
| RULE-A 纯内核 | `rules/mobility.ts:142-173` |
| 时间契约 | `ai/searchConfig.ts:16-40` |
| 生产入口 | `engine.ts:3954`、`engine.ts:4004`、`ai/hardTurnPlanner.ts:220` |

---

## 最终状态块

```text
PPC_ARIMAA01_STATUS = RESEARCH_COMPLETE_NO_PRODUCTION_CHANGE
SOURCE_BASELINE = branch ppc/2026-11-03-a0-trap-fix @ 9ba04b53ff89370a3de6b7c1e318cb78e3c742b1 (79 dirty entries; audited = working tree)
GAMEPLAY_RULESET_VERSION = 2
CURRENT_SEARCH_CLASSIFICATION = STEPWISE_EXPECTIMINIMAX_TURN_COUNTED_DEPTH
EXISTING_STEPWISE_CORRECTNESS = VERIFIED (frozen test gates: max/min continuity, zero-cost actions, chance expectation, mate lexicographic, TT exact-only, repetition, purity)
EXISTING_ALPHA_BETA_TT_ORDERING = AB_YES + CHANCE_FULL_WINDOW_NEVER_PRUNED + TT_EXACT_ONLY_PER_SEARCH + ORDERING_TT_THEN_MANHATTAN
CAT_STEP_VARIABILITY = CONFIG_ONLY_OK_BELOW_8_STEPS (plan maxLength=8); NO_UI_FOR_CAT_STEPS; STRENGTH_UNPROVEN
MOUSE_AI_SHARED_CORE_FEASIBILITY = FEASIBLE_REUSE_KERNEL_REWRITE_PLAN_LAYER
MOUSE_TURN_PLAN_GAP = ABSENT; MOUSE_PLAN_MUST_BE_CONDITIONAL (CHANCE branching), LINEAR EXTRACTION INSUFFICIENT
VARIABLE_BOARD_COMPATIBILITY = SUPPORTED_5_TO_20; EVAL_COST_O(N^2) IS THE REAL LIMIT
IRREGULAR_MAP_COMPATIBILITY = VOID_SUPPORTED; ALL_LEARNED_LEAVES_FAIL_CLOSED_OFF_DEFAULT_MAP
MULTI_HOLE_COMPATIBILITY = NOT_SUPPORTED (single rect hole; cost concentrated in holeControl + RULE-B certifier, not the search kernel)
EVALUATOR_GENERALIZATION_RISKS = SINGLE_HOLE_ASSUMPTION_IN_H1; LEARNED_LEAVES_HARD_BOUND_TO_10x10_DEFAULT
TT_RULESET_IDENTITY_RISKS = NO_RULESET_VERSION_IN_KEY; NO_mouseHole/tunnelCorners; NO_CROSS_TURN_REUSE (structural risk only if persisted)
ARIMAA_TECHNIQUE_REUSE = STEPWISE_ALREADY_PRESENT; MISSING_STATIC_GOAL_DETECTION + LMR + ASPIRATION + KILLER/HISTORY
PURE_TURNWISE_ASSESSMENT = ORACLE_ONLY (dup 64.5-95%; DAG 24.7x slower; lazy 16.95x slower + exactness FAIL)
HYBRID_SEARCH_NOVELTY = NO_NEW_HYBRID_CANDIDATE
HISTORICAL_FAILED_ROUTES_EXCLUDED = 10 (threat-extension/leaf-quiescence; exact-plan-probe; TURN_DAG runtime; turn-lazy; cheap-representation; micro-opt-only; static-completed-plan-orderings; positive-refill; tactical-prefix/path8; learned-proposal-portfolios; exact-H2-runtime; H2-only-training; A0-production-shadow)
PROPOSED_A_B_C_EXPERIMENT = PREREGISTERED_NOT_EXECUTED
RECOMMENDED_NEXT_STAGE = PTB-1_M1_EXACT_TURN_CERTIFICATE_LEAF (then M2 exact chance compression, then M3 PVS/aspiration/TT-persistence)
PRODUCTION_AI_CHANGED = NO
GAMEPLAY_RULES_CHANGED = NO
MAIN_SEARCH_BUDGET_MS = 100
TOTAL_TURN_BUDGET_MS = 150
HEAVY_WORKER_CONCURRENCY = 1
NEW_FORMAL_AUTHORITY = NONE
COMMIT_PUSH_STATUS = NONE
```
