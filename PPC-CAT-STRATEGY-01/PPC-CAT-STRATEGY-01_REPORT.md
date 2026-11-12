# PPC-CAT-STRATEGY-01 · 猫 AI 战略能力强化（只读研究轮）

**日期** 2026-11-12 · **性质** 只读证据轮，**生产 AI 0 行改动**，未 commit / push / reset / stash / clean
**交付目录** `PPC-CAT-STRATEGY-01/`（探针 5 文件 + 17 项测试 + 22 份工件 + MANIFEST）
**复现** `npx vitest run --config PPC-CAT-STRATEGY-01/vitest.config.mts` → 5 files / 17 tests / 全绿

---

## 0. 先用通俗中文回答四个问题

### 0.1 猫为什么会被"诱敌 + 传送"骗？

因为**规则真的允许一次转身就翻盘，而评价函数在那个瞬间是闭眼的**。

一次真实的、被完整复现的流程（不是构造局面，是 2026-09-03 的真人局 game 1 第 9 回合）：

1. 鼠先吃掉一块黄油 → 系统在**离鼠洞只有 3 步**的 (8,5) 公告一块"幽灵黄油"，但那只是一块预告，还没落地；
2. 猫这一回合走了 LLDL，猫在 (2,4)，离 (8,5) 有 9 步——**物理上够不到**；
3. 猫回合结束的那一瞬，幽灵黄油实体化；
4. 鼠的回合开始：它身上带着旧黄油（只有 3 步），先按技能把旧黄油**烧掉**（步数变 6、传送解锁），走到 (8,5) 捡起刚落地的新黄油，再走 3 步进洞 —— 总共 5 步，刚好够。**鼠赢了。**

我把这条线用真实引擎逐帧跑通了（witness `rSrrrr` = 右、技能、右、右、右、右）。并且做了反事实：**如果那块幽灵黄油不存在，同一个回合鼠一步都赢不了**（穷举 93 个局面，无胜）。也就是说那一局的胜负就是这块"猫看见了公告、但评分模型当作不存在"的黄油决定的。

更糟的是评价函数的盲区比"幽灵"更大：**只要鼠身上已经带着黄油，H1 对棋盘上任何位置、任何形态的黄油给的分都完全相同（实测四种情形都是 −1172.4 分，一分不差）。** 因为 `butterRace` 在携带时被整个清零，而真正描述"取油→进洞"两段路的特征 `mouseWinRouteDistance` **算出来了却从来没有进过分**。

### 0.2 猫到底有没有能力推箱堵通道？

**有能力，而且规则层完全支持；但在正式地图上这个选项几乎从不出现。**

我实测：猫站在箱子背后、把箱子推进角落的传送格——合法，掉 1 步，`blockedTunnels` 正确记录，可用通道 4→3，鼠绕路距离从 4 步变成 9 步，鼠到最近通道的距离从 2 步变成 7 步。猫的搜索也**确实会生成并评估**这个动作。

问题是：**24 个真实猫回合里，没有一个回合存在"紧贴墙角"的箱子**（0/24）。原因在生成器：`generateBoxPositions` 只在 `[1, S-2]` 的内圈采样，箱子永远不会出现在最外一圈；而四个墙角的所有相邻格**全部**在最外一圈。所以要堵一个角，猫必须先花一回合把箱子推到贴着角的位置，下一回合再绕到箱子背后推第二下——**至少两回合的连续施工**，而生产 AI 在 100ms 里几乎只能算完 1 回合（真实对局 24 回合：D1=14、D2=8、D3=2）。

结论：不是"评价没想到"，而是**这个决策点根本进不了猫的决策范围**。真实对局 24 回合里 `blockedTunnels` 一次都没被写过。

### 0.3 猫为什么倾向开局就放捕鼠夹？

因为**放夹子是免费的，而评分函数对"棋盘上有一个夹子"给的是无条件的正分，而且越早放分越高**。

我把同一回合的三种走法摆在一起，三种走法**终点完全相同**（猫都到 (5,1)，鼠都不动）：

| 走法 | 夹子位置 | 鼠到夹子的 BFS 步数 | `trapControl` 得分 | 叶节点总分 |
|---|---|---|---|---|
| TDDDD（先放夹） | (1,1) 猫起点 | 8 | **+120** | **409.947** |
| DTDDD（走一步再放） | (2,1) | 9 | +60 | 349.947 |
| DDDD（不放） | — | — | 0 | 289.947 |

于是根节点的五个候选动作值就是：**T=209.947 > 上/左=174.158 > 下=149.947 > 右=114.158**，放夹严格最优。四个真人局**全部**在第一回合的 plan 里第一个动作就是 T，夹子落在 (1,1)，之后再也没被踩中、没被回收、没被移动，`catTrapsRemaining` 在整个剩余对局里恒为 0。

荒诞的地方在于那个 8 步：鼠在 (8,5)，(1,1) 的曼哈顿距离是 11，BFS 却是 8——**因为鼠的 BFS 图里包含传送边**，鼠可以走到 (9,9) 传送到 (0,0) 再走到 (1,1)。也就是说：**评分函数认为"猫老家那个夹子离鼠更近"，因为鼠可以传送过去——而鼠根本不会往那儿走。** 越早放，夹子越靠近这些"传送近路"，分就越高。

### 0.4 这些错误到底在哪一层？

| 战术 | 规则层 | 动作生成层 | 搜索层 | 评价层 | 计划层 |
|---|---|---|---|---|---|
| 幽灵黄油诱敌 | ✅ 完全合法（已逐帧验证） | ✅ 技能/进通道/选出口都在合法动作里 | ⚠️ 幽灵公告是 ~60 分叉的 CHANCE 节点，D1 叶看不到它；猫方 1 回合内根本够不到 | ❌ **幽灵=0 分；携带时连实体黄油也是 0 分** | — |
| 推箱堵通道 | ✅ 合法 | ✅ 会生成、会评估 | ❌ 需要 ≥2 回合施工，超出实际搜索深度 | ⚠️ 有梯度但非单调（堵 0→1 是 +415，1→2 是 −53） | — |
| 开局放夹 | ✅ 合法、0 步成本 | ✅ 生成 | ✅ 忠实最大化 | ❌ **无条件 + 资源不计代价 + 传送感知的距离** | ⚠️ 计划层把免费动作前置 |

**优先解决哪一个：捕鼠夹（方向 C）。** 理由：它是三者中唯一"证据链完整 + 触发频率 100% + 修复面最小（一个叶子项）+ 不需要动搜索深度"的。幽灵黄油的问题真实且致命，但**在那一局里猫物理上够不到**，要救必须在**公告那一回合**就提前布防，这需要 2 回合视界，是下一阶段更大的工程。推箱在当前地图族里根本没有决策点。

---

## 1. P0 · 基线继承与冻结权威核对

- 工作树未提交状态保持原样；`src/` **0 行改动**（本目录所有工件都在 `PPC-CAT-STRATEGY-01/` 内）。
- 生产 leaf 已按代码核实：`planHardCatTurn` 默认 `leafEvaluator = evaluateForCat`（`hardTurnPlanner.ts:239`），`HARD_LEAF_MODE_CONFIG.current = 'baseline'`，即 **H1 = `evaluateForCat` + `DEFAULT_EVALUATION_WEIGHTS`**；`defaultLeafEval` 只在测试/独立路径出现（与 PPC-MOUSE-01 记录的"不注入即静默降级"一致，本轮所有探针都显式走生产入口）。
- 时间契约沿用：`MAIN_SEARCH_SEMANTIC_BUDGET=100ms`、`TOTAL_TURN_HARD_WALL=150ms`；本轮所有生产口径测量都用 `timeBudgetMs:100 + refutation:{enabled:true,totalTurnBudgetMs:150}`。
- 继承且未重做：Turn-Lazy（G0.3K 原型）、PVS（PPC-SEARCH-01 `NO_GO_PVS`）、密集战术延伸（G0.3B `maxThreatExtensions=0`）。本轮**没有**运行任何自对弈、训练、穷举 benchmark 或历史实验。
- 权威来源（全部只读）：`ai-training/f2b19a/log_game{A,B,C,D}.txt`（4 局真人，每回合一个 `SNAPSHOT_JSON`）+ `key_root_fixtures.json` + `earliest_avoidable_raw.json`。

---

## 2. P1 · 黄油刷新 / 诱敌 / 传送

### 2.1 时序（规则层，已核对代码 + 实测）

```
鼠吃到实体黄油 → 立刻从 butterPositions 移除（不生成新的）
              → 同时公告一块 GHOST（pendingButterSpawns，随机合法格）
              → 幽灵不阻挡猫移动/推箱/放夹/鼠拾取（它是"预告"，不是实体）
猫回合         → 幽灵仍是 pending，猫能看到它的坐标（状态里有），但拿不到它
猫回合结束（CAT→MOUSE 边界）
              → 幽灵实体化（成为 entity butter）；若鼠正好站在上面则自动拾取；
                 若该格被占则延迟一次，连续两次被占则改随机位置
鼠回合         → 鼠此时可能"不带油"（因为它刚用技能烧掉了旧油）
```

关键点：**"能看到"不等于"能被评分"**。幽灵坐标在 `GameEngineState` 里、在 `stateKey` 里、在 TT 里，唯独不在 H1 的任何一项里。

### 2.2 传送路线（规则层，`TUNNEL_ESCAPE_RULE_PARITY`）

- 携带黄油**禁止**进通道（`applyMouseStepCore`）；技能 = 烧掉黄油（`mouseHasButter=false`）+ `+3` 步 + 解锁通道；
- 进通道后 `mouseMovesLeft` 立刻归零、`phase=ChoosingTunnelExit`、**当回合结束**（`chooseTunnelExit` 本身不 endTurn，但出口选完就交给猫）；
- 出口集合 = 所有"未被堵"的其它角（`isTunnelUsable`：格子不是箱子 且 不在 `blockedTunnels`）；引擎额外插入一个"原地"选项（`engine.ts` 注释 Bug 2），评价/搜索的传送图**不建这条边**（与 PPC-PTB-1A 记录一致）。
- 真实对局里确实发生了 **3 次真传送**（单回合曼哈顿位移 12/16/16 步，远超鼠的 3~6 步预算）。

### 2.3 猫的防守选择（`AVOIDABLE_LOSS` 判定）

在 game 1 第 9 回合这个**真实根**上，我把猫一整个回合的**全部**合法走法枚举出来（4 步、可以去重后有 33 个互不相同的边界局面），对每个边界用真实引擎穷举"鼠下一回合是否必胜"：

- **33 / 33 个边界，鼠都能在自己下一回合内赢**；0 个未知、0 个截断。
- 判定：`NO_SAFE_ALTERNATIVE_PROVEN`（**限界 = 紧接的那一个鼠回合**）。这与冻结轮次 `earliest_avoidable_raw.json` 里该根记录的 `safeAlt = NONE_ROOT_FORCED` **独立吻合**。

同时必须诚实标注：**在真实数据里确实存在"可避免的失败"**，但它不是这一回合——game 6 第 2 回合的冻结结论是 `safeAlt = "DRRR (ALL_OUTCOMES_SAFE)"`，即生产 plan（UURR）放走了一个全部结果都安全的替代方案。那是 2-ply 结构判据，不是必胜证明，本轮**继承不重做**。

### 2.4 H1 特征检查（`H1_FEATURE_FINDINGS`）

锚点 = game 1 第 9 回合真实根（鼠携带黄油、幽灵在 (8,5)）：

| 变体 | H1 总分 | `mouseButterDistance` | `mouseWinRouteDistance` | `butterRace` |
|---|---|---|---|---|
| A1 原样（幽灵 pending） | −1172.4 | 5 | 5 | 0 |
| A2 删掉幽灵 | −1172.4 | 5 | 5 | 0 |
| A3 幽灵搬到洞口门口 | −1172.4 | 5 | 5 | 0 |
| A4 幽灵换成**实体**黄油在洞口门口 | −1172.4 | 5 | 5 | 0 |
| B1 鼠不携带·无幽灵 | −814.6 | 5 | 11 | 350 |
| B2 鼠不携带·幽灵在洞口 | −814.6 | 5 | 11 | 350 |
| B4 鼠不携带·实体黄油贴着鼠 | −1105.6 | 1 | 5 | 70 |

三条口径结论：

1. **幽灵黄油在任何状态下都恰好值 0 分**（A1=A2=A3，B1=B2）——`pendingButterSpawns` 根本没有进入 `scoreFeatures`。
2. **鼠携带黄油时，H1 把"洞口门口有一块黄油"和"什么都没有"评为完全同分**（A1=A4）。因为 `butterRace` 在携带时被强制清零（G0.3H 的修正），而唯一描述两段路的 `mouseWinRouteDistance` **算了但不计分**。
3. `mouseButterDistance` 是**所有黄油的最小值**，所以"第二块油出现在洞口"天然不可见（B3=B1），只有当它比现有最近那块更近时才动分（B4，且方向是"鼠离油越近猫越差"，−291）。

**这解释了用户报告的全部现象**：鼠把油烧掉、靠传送绕到洞口、捡起一块猫"看过公告但从未计价"的油进洞。

---

## 3. P2 · 推箱封锁传送通道

### 3.1 规则层逐项验证（`BOX_TUNNEL_BLOCK_LEGALITY = LEGAL_CONFIRMED`）

构造局面：猫 (2,0)、箱 (1,0)、左上角通道 (0,0)，`catMove(Up)`：

| 检查项 | 结果 |
|---|---|
| 猫真的能到箱子背后 | ✅ `bfsCatDistance` 可达 |
| 推箱动作合法 | ✅ 掉 1 步，`catActionLog` 记 `推箱堵通道` |
| 箱子真的进了通道格 | ✅ `board[0][0].type = 'box'` |
| `blockedTunnels` 正确更新 | ✅ `[{0,0}]` |
| 鼠可选出口变化 | ✅ 可用通道 4→3，该角不再作为入口/出口 |
| 鼠路线真的变长 | ✅ 到洞 4→9 步；到最近可用通道 2→7 步 |
| 该动作出现在搜索候选里 | ✅ `generateLegalSearchActions` 含 `Up` |
| 是否被选中 | 在"猫本来就能抓死"的局面里选过（mate 分支），但见 3.3 |

### 3.2 评价层梯度（`ceteris paribus`：只有"堵了几个角"不同）

| 堵住角数 | 总分 | `tunnelControl` | `confinement` | `holeControl` | `voronoi` | 鼠可达通道距离 |
|---|---|---|---|---|---|---|
| 0 | 443.6 | −450.0 | −88 | +300 | +39.1 | 2 |
| 1 | 858.7 | −128.6 | −77 | +50 | +371.7 | 7 |
| 2 | 805.6 | −81.8 | −66 | −100 | +410.9 | 11 |
| 3 | 848.6 | −56.3 | −55 | −100 | +417.4 | 16 |
| 4 | 915.9 | 0.0 | −44 | −100 | +417.4 | 全封 |

Δ(0→1) = **+415.0**（其中 `tunnelControl` +321.4，voronoi +332.6，`holeControl` −250），Δ(1→2) = **−53.1**。

结论要说得准确：**H1 对"堵掉鼠唯一快路"是有正梯度的（不是零），但这个梯度不单调、且完全由"鼠到最近可用通道的距离"这一步跳变驱动**——堵掉第 2、3 个角几乎没有收益（−53 / +43），因为鼠最近的通道早就换成了别的角。所以它奖励"堵掉那条捷径"，不奖励"战略封锁"。

### 3.3 搜索覆盖与真实发生率（`BOX_BLOCK_SEARCH_COVERAGE`）

- **动作层**：会生成。**搜索层**：会被评估（根候选里带 `bound`）。
- **真实地图可达性（决定性）**：24 个真实猫回合中，**"有箱子紧贴任一角"的回合数 = 0**；因此"一回合内可执行的堵通道推箱" = **0 / 24**。
- **结构性原因**：`generateBoxPositions` 采样范围 `[1, S-2]`，箱子永远落在内圈；四个角的所有相邻格都在最外一圈 → 要堵角必须先"内圈→贴角"再"贴角→角"，**≥2 个猫回合**。
- **真实使用率**：24 个回合 `blockedTunnels` 全程为空（0 次）。
- 反向控制：在"鼠已在洞口门口、猫有一步杀"的局面，搜索选的是抓（mate），不是推箱——**没有把堵塞当万能加分**。

---

## 4. P3 · 捕鼠夹时机与机会成本

### 4.1 真实比例（`TRAP_EARLY_PLACEMENT_CAUSE`）

4 局真人，24 个猫回合：

| 局 | 回合数 | 第一回合 plan | 放夹位置 | 之后是否还有夹子 | 夹子被踩/回收/移动 |
|---|---|---|---|---|---|
| game 1 | 9 | `TDDDD` | (1,1) 起点 | 否（`trapsRemaining=0` 全程） | 0 / 0 / 0 |
| game 2 | 8 | `TRRRR` | (1,1) | 否 | 0 / 0 / 0 |
| game 5 | 4 | `TRRDD` | (1,1) | 否 | 0 / 0 / 0 |
| game 6 | 3 | `TDRRD` | (1,1) | 否 | 0 / 0 / 0 |

**开局放夹比例 = 4/4 局 = 100%；plan 含 T 的回合 = 4/24（全部是各自的第 1 回合）。** 夹子平均在盘上"占位" 5 个回合、0 次生效。

合成对照（7 个固定配置，生产口径）：plan 含 T = **6/7**（唯一例外是 7×7 那盘已经 1 步杀）。放夹位置都在**当回合中段**（`DRTRD` / `RRDTD` / `DDRTR` / `DDDTD` / `DDTR` / `RRDRTR`），即"猫一边靠近鼠一边顺手放下"。

### 4.2 机会成本是否被建模（`TRAP_RESOURCE_OPPORTUNITY_COST = NOT_MODELLED`）

- `catTrapsRemaining` / `catHasTrapAvailable` / `trapActive` **都是 feature，`scoreFeatures` 从不给它们打分**（实测：`catTrapsRemaining` 1 vs 0，总分完全相同；夹子在远处 vs 没有夹子，总分也完全相同）。
- 唯一的打分入口是 `trapControl = max(0, 1 − mouseBfsDist(trap)/boardSize) × 600`：
  - **无条件**：不要求鼠的路线经过夹子；
  - **免费**：`catPlaceTrap` 不消耗 `catMovesLeft`（实测 4→4），所以每回合都能"顺手放"；
  - **无回收代价**：要重放新夹必须先走回旧夹格（`catMove` 踩到才 +1 库存），这个步行成本在叶子上完全没有体现；
  - **距离用"鼠的可达 BFS"而不是"鼠会不会走"**，且该图含传送边 → 猫老家 (1,1) 被算成"离鼠 8 步"（曼哈顿 11 步），比走一步之后的 (2,1)（9 步）更"近"。
- 三者叠加 = **"越早放、越靠传送近路、分越高"**，这正是观测到的行为。

### 4.3 反向控制（早放**确实**可能是对的）

- 鼠踩夹的真实后果已实测：`mouseMovesLeft → 0`、当回合立即结束、夹子消耗（`trapPosition → null`），这是真实收益，所以**不能禁止早放**。
- 反过来，把夹子放在鼠必经之路上，H1 也给正分（实测鼠站在夹上 `trapControl = +600`）。
- 所以问题不是"放不放"，是**"在哪、什么时候、值不值这个唯一库存"**。

---

## 5. P5 · 配置覆盖

7 个固定局面（全部通过 `validateGameConfig`），生产口径 100ms + 150ms：

| 配置 | 棋盘 | 猫步 | 黄油 | 合法动作 | 完成深度 | plan | 含 T | 可堵通道推箱 | 鼠到洞 |
|---|---|---|---|---|---|---|---|---|---|
| 10×10 默认 | 10 | 4 | 2 | 5 | 1 (尝试 2) | `DRTRD` | ✅ | ❌ | 5 |
| 8×8 | 8 | 4 | 2 | 5 | 1 | `RRDTD` | ✅ | ❌ | 3 |
| 15×15 | 15 | 4 | 2 | 5 | 1 | `DDRTR` | ✅ | ❌ | 11 |
| 7×7 单黄油 | 7 | 4 | 1 | 5 | 1 | `DDRR` | ❌（1 步杀） | ❌ | 3 |
| 10×10 + Void 墙 | 10 | 4 | 2 | 5 | 1 | `DDDTD` | ✅ | ❌ | 4 |
| 10×10 猫 3 步 | 10 | 3 | 2 | 5 | **2** | `DDTR` | ✅ | ❌ | 5 |
| 10×10 猫 5 步 | 10 | 5 | 2 | 5 | 1 | `RRDRTR` | ✅ | ❌ | 5 |

结论：**D1 全部完成（7/7），D2 只在"猫步数少→分支小"时完成（1/7）**。与真实对局一致（D2 10/24、D3 2/24），也解释了为什么需要 ≥2 回合施工的战术（推箱堵通道）永远进不了 plan。

---

## 6. P4 · 逐层归因汇总

| 层 | 幽灵诱敌 | 推箱堵通道 | 开局放夹 |
|---|---|---|---|
| 规则 | 合法（逐帧验证 + 3 次真实传送） | 合法（推箱/`blockedTunnels`/出口收缩全对） | 合法（0 步成本、踩中即失去整回合） |
| 动作生成 | 技能/进通道/出口都在 `generateLegalSearchActions` | `catStep` 覆盖推箱，根候选含该步 | `catPlaceTrap` 常驻候选 |
| 搜索 | 幽灵公告 = ~60 分量 CHANCE（无 `Math.random`），D1 叶看不到 pending；猫方 1 回合内够不到（距离 9） | 需要 ≥2 回合施工；100ms 只到 D1 | 忠实最大化，rootValue 排序与叶子一致 |
| 评价 | 幽灵恒 0；携带时黄油恒 0；`mouseWinRouteDistance` 不计分 | 有梯度但非单调（+415 / −53 / +43 / +67） | `trapControl` 无条件 + 无资源项 + 传送感知距离 |
| 计划 | `plan` = 单次搜索主线；观测回合 `selectedPlanSource=baseline` | — | 免费动作被前置（T 成为首动作） |
| Sidecar | 真实日志：`NO_REFUTATION_FOUND` / `CHANCE_MIXED`，**未产生决策改变** | 同 | 同 |

**明确否定的归因**：不是"搜索不够深"一句能解释的。推箱确实是深度问题（需要 2 回合）；放夹**不是**深度问题（D1 就足以稳定选择，而且越深越会选它，因为每层叶子都收一次 +120）；幽灵诱敌是**评价 + 视界双重**问题（评价闭眼，且即使睁眼，在那一回合猫也够不到）。

---

## 7. P6 · 唯一推荐候选

### 三方向打分（用本轮实测数）

| | A 幽灵/近洞黄油威胁 | B 战略推箱封锁 | **C 捕鼠夹时机与机会成本** |
|---|---|---|---|
| 触发频率 | 8/24 真实回合有幽灵；其中 5/8 距洞 ≤4；但"能翻盘"的只有 1/24 | **0/24** 回合存在可执行决策点 | **4/4 局首回合**，且每次回收后重现 |
| 可避免错误 | 未证明：那一局猫距幽灵 9 步，1 回合内无解；要救需在公告回合布防（2 回合视界） | 未证明（无样本） | **机制已证明**（分差 +120/+60/0 直接决定 plan）；是否改变胜负未证明 |
| 计算成本 | 需要 2 回合视界或额外 chance 预算，代价高 | 需要动作序列规划（跨回合），高中 | **≈0**（复用已有 `mouseMap` / `carryHoleMap`，不需新 BFS） |
| 规则适应性 | 与地图无关（幽灵机制通用） | 生成器结构性排除（箱子永在最外一圈之外） | 与地图/棋盘/通道数无关 |
| 重复风险 | 无人做过 | 无人做过，但 3 次尝试都受深度限制 | HV14–HV20 只动过 holeControl / gate race / hybrid / A0；**A0 的 30 个输入里原封不动包含 `trapControl`**，若走 A0 会静默继承这个坏特征——必须在预注册里显式声明 |

### 推荐：**C（捕鼠夹时机 / 资源机会成本）**，独立 feature flag，只改叶子

**新状态定义（建议，精确形式下一轮预注册时冻结）**

设 `trap = state.trapPosition`，`mouseMap` / `carryHoleMap` 为 H1 已构建的两张图（不新增 BFS）：

```
onMouseRoute(trap) :=
     mouseMap.has(trap)  ^  (存在 butter b : mouseMap[trap] < mouseMap[b])           // 在"去取油"那段最短路上
  || (carryHoleMap.has(trap) ^ 存在 butter b : carryHoleMap[trap] < carryHoleMap[b])  // 或在"带油回洞"那段上
routeCredit        := onMouseRoute ? 600 * (1 - minDistToHole(trap)/boardSize) : 0    // 只对真正挡路的夹子给分
resourceCost       := 30 * (state.catTrapsRemaining <= 0 ? 1 : 0)                     // 库存已耗尽 = 未来无夹可用
reclaimCost        := 8 * (state.catPosition 到 trap 的猫步 BFS)                       // 想重放必须走回去
offRoutePenalty    := onMouseRoute ? 0 : 120                                           // 不挡路的夹子纯粹是沉没成本
trapTerm           := routeCredit - resourceCost - reclaimCost - offRoutePenalty
```

- **适用条件**：`phase=Playing`、`trapPosition != null`；无幽灵/债状态也照常（不依赖 chance）。
- **成本**：0 次新 BFS（两张图 H1 已经建好），每叶 O(#butters) 次查表（黄油数 ≤ 3）。
- **状态同一性**：`trapPosition` / `catTrapsRemaining` **已经在 `stateKey` 与 `gameAffectingEqual` 里**（`transposition.ts:56-57`、`stateCompare.ts:117-119`），因此该特征 TT 安全，**不需要改 stateKey**。
- **可能反例（必须写进预注册）**：
  1. 鼠被逼到"必须踩夹"的地形，此时不挡路也该放 → `offRoutePenalty` 会误罚。缓解：当"鼠到洞的可用路线数 == 1"时把 `onMouseRoute` 视为真（单通道局面）。
  2. 猫正在追一个近在眼前的鼠（1 步杀），放夹是浪费但无害；`resourceCost` 会让它不再放——**这正是期望行为**，但要在 A/B 里确认不会损失必胜手的执行。
  3. 夹子放在"鼠可能绕开"的位置时，H1 现有 `trapControl` 已经给分；新项必须**替换**而不是叠加，否则双重计分。
- **Feature flag 设计**：新增 `HARD_TRAP_TIMING_CONFIG = { enabled: false }`（默认 OFF，一个单词回滚）；只在 `HARD_LEAF_MODE_CONFIG.current === 'baseline'` 且 `trapPosition !== null` 时生效；不改 evaluator 的任何既有权重、不改 `DEFAULT_EVALUATION_WEIGHTS`、不改 planner / sidecar / 100ms / 150ms。
- **下一轮预注册 A/B**：同一批 24 个真实猫回合 + 7 个固定配置根，arm A = 现状 leaf，arm B = C 特征 ON；判据（预注册时冻结）：①首回合放夹率从 4/4 降到 ≤1/4；②`blockedTunnels`/踩夹次数不下降；③24 根上 `rootActions` 的首选动作变化必须**只发生在 trap 相关候选**上；④节点数 & 墙钟不超现有分布（D1 完成率不得下降）。

**为什么不是另外两个**（一句话各）：A 需要 2 回合视界（超出 100ms 能完成的 D2 之外），且本轮唯一一次真实翻盘里猫物理够不到；B 在正式地图上 24/24 回合没有决策点。

---

## 8. 纪律与边界

- `HEAVY_WORKER_CONCURRENCY=1`、单进程串行、无并发、无自对弈、无训练、无历史 benchmark 复跑；所有搜索都是单根、有界、带 `cap` 与 `capped` 标记。
- 未改：`GAMEPLAY`、H1 权重、Hard Planner、Sidecar、100ms/150ms 常量、鼠 AI、`src/` 任何一行。
- 未做：commit / push / reset / stash / clean。
- 已知不确定性：`enumerateCatTurnBoundaries` 与 `mouseWinInOneTurn` 都有显式 node cap（本轮全部未触发，`capped=false`），但"限界 = 1 个鼠回合"是硬边界，**不能**外推成多回合结论。100ms 墙钟在 Node 进程里首根偶发只走 60 节点（浏览器真实对局 24/24 都完成 D1），已在工件里如实记录。

---

## 9. 状态块

```text
PPC_CAT_STRATEGY01_STATUS = COMPLETE_READ_ONLY
SOURCE_BASELINE = worktree 2026-11-12 (uncommitted state preserved); src/game/* 0 lines changed
GAMEPLAY_RULESET_VERSION = 2
REAL_HUMAN_LOG_AVAILABLE = YES (4 games / 24 cat turns / all mouse_wins, frozen 2026-09-03)
GHOST_BUTTER_BAIT_REPLAY = REAL_REPLAY_VERIFIED (game1 T9; witness rSrrrr; counterfactual without ghost butter = NO_WIN)
TUNNEL_ESCAPE_RULE_PARITY = ENGINE_CONFIRMED (skill -> tunnel -> exit -> turn-end -> pickup -> hole; 3 real teleports)
AVOIDABLE_CAT_LOSS_PROVEN = PARTIAL: INHERITED_YES_OTHER_ROOT (G6T2 safeAlt=DRRR, 2-ply structural); THIS_ROOT_NO (33/33 legal cat turns still lose in 1 mouse turn)
BOX_TUNNEL_BLOCK_LEGALITY = LEGAL_CONFIRMED (push lands on corner, blockedTunnels updated, exits 4->3, mouse route 4->9)
BOX_BLOCK_SEARCH_COVERAGE = GENERATED+SEARCHED / 0 OCCURRENCES (0 of 24 real turns had a box adjacent to any corner; requires >=2-turn chained pushes; generator never places boxes on the border ring)
TRAP_EARLY_PLACEMENT_CAUSE = EVALUATION_LAYER (trapControl = max(0,1-mouseBfsDist/boardSize)*600, unconditional, no resource/reclaim cost, tunnel-aware BFS; +120 vs +60 vs 0 on identical end states)
TRAP_RESOURCE_OPPORTUNITY_COST = NOT_MODELLED (catTrapsRemaining/trapActive are features, never scored)
H1_FEATURE_FINDINGS = PENDING_GHOST_ALWAYS_0; BUTTER_ALWAYS_0_WHILE_CARRYING (incl. entity butter at hole doorstep); mouseWinRouteDistance computed but unscored; single-tunnel block gradient +415/-53/+43/+67 (non-monotone)
SEARCH_HORIZON_FINDINGS = real turns D1 14/24, D2 8/24, D3 2/24 (mean 1.50); fixed-config probe D1 7/7, D2 1/7
PLAN_EXECUTION_FINDINGS = plan = single-search principal line; selectedPlanSource=baseline on all observed turns; no plan-layer loss found for the three tactics
CONFIGURATION_COVERAGE = 7 fixed roots (10x10 / 8x8 / 15x15 / 7x7+1butter / 10x10+void / cat3 / cat5), all configs valid, all planned
RECOMMENDED_SINGLE_CANDIDATE = C_TRAP_TIMING_AND_OPPORTUNITY_COST (feature-flagged leaf term, 0 new BFS, TT-safe)
NEXT_STAGE_GO_GATE = PRE_REGISTERED_A_B_REQUIRED (production unchanged this round)
MOUSE_AI_DEVELOPMENT = PAUSED
PRODUCTION_AI_CHANGED = NO
GAMEPLAY_RULES_CHANGED = NO
MAIN_SEARCH_BUDGET_MS = 100
TOTAL_TURN_BUDGET_MS = 150
HEAVY_WORKER_CONCURRENCY = 1
NEW_FORMAL_AUTHORITY = NONE
COMMIT_PUSH_STATUS = NONE
```
