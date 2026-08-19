# Phase E0：Evaluation Foundation + Benchmark Corpus

Phase D4 已验收通过。

现在进入 **Phase E0**。

本阶段目标不是立刻把 Hard 接进游戏，而是：

```
建立一个可解释、可测试、符合 GAMEPLAY 的局势评价基础+建立固定 benchmark corpus
```

后续 E1 才根据 corpus 正式调整评价权重。

---

## 0. 规则绝对冻结

`GAMEPLAY.md` 是唯一玩法基准。

本阶段禁止修改：

```
合法动作回合规则步数黄油规则黄油随机再生概率鼠技能tunneltrapbox push胜负条件Search depth 语义ExpectiminimaxTTAlpha-BetaMove OrderingIterative Deepening
```

**Evaluation 只能评价一个合法 GameEngineState，不能创造新规则。**

GAMEPLAY 当前要求包括：

```
鼠携黄油进鼠洞 -> MouseWins鼠用技能会消耗黄油并 +3 当前步数携黄油且技能未激活不能使用 tunneltunnel 后剩余步数归零鼠踩 trap 立即结束回合猫 trap 放置不消耗步数猫可以推箱并封锁 tunnel猫不能进入 mouse hole / tunnel / butter
```

所有评价逻辑必须尊重这些规则。

---

# 1. Phase E0 暂时不要“大调权重”

先审计当前：

```
evaluateForCat(...)
```

明确报告：

```
当前有哪些 feature当前权重当前是否只靠 Manhattan distance是否理解 butter是否理解 mouse hole是否理解 tunnel是否理解 trap是否理解 box是否理解 currentPlayer / movesLeft
```

**先记录 baseline，不要马上重写。**

---

# 2. 建立 EvaluationBreakdown

将评价器变成可解释结构。

建议：

```
interface EvaluationBreakdown{    total: number;    features: EvaluationFeatures;    contributions: EvaluationContributions;}
```

外部搜索仍然只需要：

```
evaluateForCat(state): number
```

但它内部可以：

```
return evaluateForCatDetailed(state).total;
```

测试和 benchmark 使用 detailed 版本。

这样以后看到：

```
state A = +620
```

我们可以知道到底是：

```
+300 capture pressure+180 confinement-250 mouse hole threat+90 tunnel control...
```

而不是面对一个神秘总分。

---

# 3. Evaluation 必须保持纯函数

自动证明：

```
同 state-> 同 evaluation
```

不允许：

```
Math.randomDate.nowmutable global history搜索路径信息真实未来 RNG
```

输入 state 搜索前后不得被 mutation。

deepFreeze 测试继续使用。

---

# 4. Terminal 不属于 heuristic

当前 Expectiminimax 已经单独处理：

```
CatWinsMouseWins
```

Phase E0 不要重新在 heuristic 里造另一套 mate score。

`evaluateForCat()` 只负责：

```
non-terminal state
```

最终 heuristic 数值必须保持远小于：

```
MATE_SCORE
```

建议增加：

```
HEURISTIC_LIMIT
```

并 clamp：

```
-HEURISTIC_LIMIT<= value <=+HEURISTIC_LIMIT
```

即使以后权重改坏，也绝不能冲进 mate 数值区。

---

# 5. 先建立 Rule-aware Distance Kernel

不要直接拿：

```
Manhattan distance
```

当作主要战略距离。

建立纯 helper，例如：

```
buildMouseDistanceMap(...)buildCatDistanceMap(...)
```

或等价接口。

## Mouse graph 必须尊重

```
box / pile / cat 不可进入hole 可进入tunnel 条件blocked tunnelcarrying butter 时 tunnel 限制skill 状态
```

注意：

tunnel 是特殊图边，  
不能当普通相邻格。

## Cat graph 必须尊重

```
hole 不可进入tunnel 不可进入butter 不可进入pile 不可进入
```

第一版 distance map 可以把：

```
box
```

当成障碍，

因为“推箱”属于更复杂动态动作。  
但必须另外提供：

```
pushOpportunity / tunnelBlock
```

feature，  
不要谎称这个 BFS 已完整模拟推箱。

---

# 6. 距离必须返回 unreachable

不允许用：

```
999999
```

假装距离。

使用：

```
number | null
```

或：

```
Infinity
```

并统一定义。

Benchmark 必须覆盖：

```
reachableblockedtunnel routecarrying butter tunnel forbidden
```

---

# 7. 建立 EvaluationFeatures，但 E0 先不大规模调权重

第一版建议抽出这些**原始 feature**：

```
interface EvaluationFeatures{    catMouseDistance: number | null;    mouseGoalDistance: number | null;    mouseButterDistance: number | null;    mouseMobility: number;    catMobility: number;    mouseReachableArea: number;    catReachableArea: number;    openTunnelCount: number;    blockedTunnelCount: number;    mouseCanUseTunnel: boolean;    mouseHasButter: boolean;    mouseSkillActive: boolean;    catHasTrapAvailable: boolean;    trapActive: boolean;    trapDistanceToMouse: number | null;    currentPlayer: 'cat' | 'mouse';    catMovesLeft: number;    mouseMovesLeft: number;    // 后续可增加    // interceptionMargin    // voronoiControl    // pushBlockPotential}
```

不要求字段名字完全一致，  
但语义必须清楚。

---

# 8. mouseGoalDistance 必须根据真实状态解释

不允许无论什么状态都简单算：

```
mouse -> hole
```

因为鼠没有黄油时，  
到洞并不能获胜。

至少区分：

### Mouse carries butter

```
mouseGoalDistance =当前鼠 -> mouse hole
```

这是直接胜利威胁。

### Mouse no butter

可以记录：

```
mouseButterDistance
```

以及未来 E1 再组合：

```
mouse -> butter -> hole
```

E0 不必马上实现完美两阶段 planner，  
但字段不能语义造假。

---

# 9. Tunnel feature 必须尊重 GAMEPLAY

鼠：

```
carrying butter && !skillActive
```

时 tunnel 不可用。

所以不能只看：

```
openTunnelCount
```

就认为鼠一定有逃生能力。

必须同时有：

```
mouseCanUseTunnel
```

并测试：

```
无黄油携黄油技能激活blocked tunnel
```

四类状态。

---

# 10. Trap feature 暂时保持朴素

GAMEPLAY 中：

```
场上最多一个 traptrap 放置不耗步鼠踩中后立即结束回合猫可以回收
```

E0 暂时不要直接写：

```
trapActive = +5000
```

只提取客观信息：

```
trap existscat inventorytrap -> mouse distance
```

E1 再判断它到底价值多少。

---

# 11. Confinement / Mobility

建立：

```
legal immediate movesreachable area
```

鼠可活动空间越小，  
通常对猫越有利。

但：

**“mouse has no legal moves” 不得直接返回 CatWins。**

搜索 terminal 规则已经锁定。

Evaluation 中只能把它视为：

```
strong positional advantage
```

不能创造新的胜负状态。

---

# 12. 为未来 Voronoi 留接口，但 E0 不必实现完整版

最终 Phase E 我希望有：

```
Rule-aware Voronoi / territory control
```

即比较每个重要格：

```
cat 到达时间vsmouse 到达时间
```

但 E0 先把：

```
distance maps
```

做正确。

Voronoi 留到 E1。

不要一次塞太多。

---

# 13. 建立 Benchmark Corpus

新建类似：

```
src/game/ai/__tests__/evaluationCorpus.ts
```

不一定必须这个文件名。

每个 corpus case 包含：

```
{    name: string;    state: GameEngineState;    tags: string[];    expectation: ...}
```

不要只准备 canonical openArena。

至少覆盖约 **20 个局面**。

---

# 14. Corpus 类别

至少覆盖：

### Capture pressure

```
猫离鼠近vs猫离鼠远
```

### Mouse carrying butter

```
鼠携黄油离洞 1 turn鼠携黄油离洞很远
```

### Butter race

```
鼠离 butter 近鼠离 butter 远
```

### Tunnel

```
open tunnelblocked tunnel鼠可使用 tunnel携黄油不可用 tunnel
```

### Trap

```
trap 在鼠附近trap 很远cat 有库存cat 无库存
```

### Box / tunnel block

```
tunnel 已被箱子封未封
```

### Mobility

```
鼠开放空间鼠被压在狭窄区域
```

### Tempo

```
同一位置Cat turnvsMouse turn
```

### CHANCE-related

```
butter 拾取前后合法状态
```

Corpus 本身不运行未来随机结果。

---

# 15. Corpus 以“相对关系”为主

不要现在写：

```
state X 必须 = 725 分
```

权重以后会调。

优先写：

```
A 应比 B 更利于猫
```

例如：

```
mouse carrying butter,离洞 1 格
```

应比：

```
mouse carrying butter,离洞 8 格
```

**对猫评价更低。**

这种关系比绝对数字稳定。

---

# 16. 但不要把主观战略偏好全写成硬测试

分三类：

```
RULE invariantSTRATEGIC expectationOBSERVATION only
```

### RULE invariant

必须自动测试通过。

例如：

```
carrying butter 后 tunnel 不可用
```

### STRATEGIC expectation

是我们认为好的 AI 应满足的方向。

后续用于调 evaluator。

### OBSERVATION

记录分数，  
但暂时不 pass/fail。

这样不会因为一条未经证明的“战略直觉”把未来 AI 锁死。

---

# 17. Evaluation symmetry / invariants

自动测试：

```
message 改变log 改变debug 字段改变
```

Evaluation 不得变化。

与 game-affecting 无关字段不能影响分数。

同一 state 重复 evaluate：

```
必须相同
```

---

# 18. Board-size normalization

GAMEPLAY 支持：

```
5x5 ~ 20x20
```

所以 feature 不要天然假设 10x10。

Distance / area feature 至少做：

```
boardSize normalization
```

或明确保持 raw feature、由 scoring 层 normalize。

不能：

```
distance=8 永远固定同一个意义
```

因为在 5x5 与 20x20 上完全不同。

---

# 19. E0 Performance Baseline

Evaluation 即将成为大量 leaf 的热点。

暂时不要优化，  
但必须测。

对 canonical fixture：

```
TT ONAB ONORDER ONiterative
```

记录当前 evaluator 下：

```
maxNodescompletedDepthelapsed time（只 benchmark，不进入搜索决策）evaluationCalls
```

`elapsed time` 可以测试/报告用，  
**不能用于 D4 搜索行为。**

这是为了以后判断 Rule-aware BFS 是否把搜索拖慢。

---

# 20. 建议 diagnostics 增加 evaluationCalls

如果实现成本很低：

```
evaluationCalls
```

记录静态 evaluator 被调用多少次。

不影响搜索行为。

如果需要大改 SearchContext，  
E0 可以先不做。

---

# 21. E0 不接 Legacy Hard

旧 Hard 可以读取，  
但只做：

```
feature inventory
```

例如旧 Hard 是否考虑：

```
距离hole defensetunnel blockingtrapconfinement
```

把有价值思想登记下来。

**不要复制旧的巨大 magic-number scoring。**

E1 再决定哪些思想保留。

---

# 22. E0 不改变正式 evaluateForCat 的行为也可以

最稳方案是：

```
先建立新 feature extractor+ breakdown+ corpus
```

但：

```
search 仍然调用当前 baseline evaluator
```

直到 E0 验收。

这样 E0 不会突然改变 AI 答案。

我更推荐这个方案。

---

# 23. E0 自动测试

至少：

```
E0-A evaluator purityE0-B heuristic bounded below mate regionE0-C mouse distance respects obstaclesE0-D cat distance respects forbidden cellsE0-E carrying butter tunnel restrictionE0-F blocked tunnelE0-G mouse-hole goal semanticsE0-H mobility/reachable-areaE0-I board-size normalizationE0-J non-game fields invariantE0-K corpus fixture validityE0-L all existing 110 tests regression
```

Corpus 所有 state 必须先经过：

```
state validity / game-affecting consistency
```

不要拿非法棋盘调 AI。

---

# 24. E0 最终报告

只汇报：

```
当前 baseline evaluator 到底在算什么新 EvaluationFeatures 字段Rule-aware distance 语义哪些 feature 已实现哪些只预留corpus 局面数量与类别RULE / STRATEGIC / OBSERVATION 数量当前 evaluator 是否真正改了行为evaluation 性能 baselinetests / typecheck / lint
```

**E0 完成后停止。**

不进入：

```

权重大规模调参Voronoi 正式计分Legacy Hard 权重迁移Hard integrationwall-clock / Worker
```
