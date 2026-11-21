# REPORT — PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01

**结论：PASS（研究轮闭合）**。G0 身份/准入、G1 只读来源审计、G2 完整猫回合枚举、G3 两种机制对照、
G4 评价分解、G5 三次 fresh-process 串行重复均完成；`STOP_FOR_CHATGPT_REVIEW = TRUE`，
未进入生产开发，未 commit / push / merge。

- 根：`G6T2`，ARM E1，D2 固定深度 2；CLOUD OFFLINE / SINGLE ROOT / PRODUCTION READ-ONLY。
- 冻结输入：fixture SHA `1a59787a…`、kernel SHA `453915d3…`（39 个生产源文件与第 1 轮闭包逐字节一致）。
- 云主机 `docmap`，`runs/04` 六个阶段全部 PRECHECK=PASS、RC=0、ABORT=NONE，串行、并发=1。

工件：`PRODUCTION_PLAN_SOURCE_AUDIT.md`、`CANDIDATE_ENUMERATION.json`、`MECHANISM_COMPARISON.json`、
`EVALUATION_DECOMPOSITION.json`、`logs/`（G0 + 三次枚举投影）、`runs/04/`（六阶段原始件）、
`reference/`（第 1 轮闭包只读副本）。

---

## 一、G1：生产计划来源（只读审计，详见 PRODUCTION_PLAN_SOURCE_AUDIT.md）

- `planBranches` 记录每个猫方 MAX 节点搜索**实际选出的单一动作**（`expectiminimax.ts:1471–1472`）；
  `buildCatTurnPlan` 沿该日志走主变着（`expectiminimax.ts:1926`），得到 `UUDD`。
- `equalPrimaryGraph` 仅在**完全解析且并列最优动作 >1** 的根猫回合节点记录（`expectiminimax.ts:1463–1465`）；
  `extractBestCatTurnPlan` 在其上做 DP，按**最少折返**选计划、平局取图内稳定顺序
  （`planQuality.ts:513/557/658`），得到 `LUDR`。
- 覆盖只发生在 `mate === null && graph.size > 0`（`expectiminimax.ts:2020–2022`），且不改变搜索值；
  这不是“修 bug”，而是同值计划的表示选择。
- HardTurnPlanner 消费替换后的 `search.catTurnPlan`（`hardTurnPlanner.ts:276`），可再被 sidecar
  （`:381`）或上一深度救援（`:609`）覆盖；执行层以 `applyPlanCatAction`（`engine.ts:4488`）逐步执行，
  合法性按单步效果判定，“回到起点”不被视为非法。
- **ULDR ≠ UUDD 不构成修改生产代码的理由。**

## 二、G2：完整猫回合候选（真实规则，无搜索/无估值）

从冻结根出发，用生产 `generatePreparedSearchActions` + simulator 穷举，无 Top-K、无价值排序：

| 指标 | 数值 |
| --- | --- |
| 合法完整猫回合 | **110** |
| 展开状态 | 46 |
| 步数分布 | 全部 4 步（`{“4”:110}`） |
| 回合结束方式 | 全部为 CAT→MOUSE 幽灵边界 CHANCE，各 1 个正概率结果（probabilitySum=1） |
| 零移动代价动作 | **0**（本轮根陷阱已在 (1,1) 且 `catTrapsRemaining=0`，生产枚举在 `preparedActions.ts:82` 即不再产出 `catPlaceTrap`；通用零代价分支已实现但本根无触发） |
| 计划回放 | **110/110 成功**，0 条前线不一致 |
| 去重（完整 canonical state） | 110（动作历史使 UUDD/DUUD 等区分） |
| 去重（游戏可见 snapshot，不含历史） | **18** 个唯一后继前线 |
| 循环剪枝 | 0 |

六条固定控制计划均出现（生成顺序 0-based 下标）：
`UUDD`(4)、`DUUD`(34)、`LUDR`(70)、`UURR`(8)、**`DRRR`(63)**、`DRDR`(57)。
六条与第 1 轮 `PLAN_PROGRESS_AUDIT` 的 `final.fullStateSha256` **逐一相等**
（`eddd776e… / 51b3773e… / d9ba7799… / e954daae… / 253033ff… / ad15efec…`），
说明本轮枚举与历史重放使用同一生产语义。

## 三、G3：两种机制对照

### 机制 A — 只重排三条主候选

- 候选池 = 生产自然搜索的三条 principal：`{UUDD, DUUD, LUDR}`（size 3），`DRRR ∉ 池`。
- 结论：`CANNOT_DISCOVER_DRRR_BY_REORDERING_PRINCIPALS`。纯重排固定 3 元池不可能产生池外计划；
  生产内唯一的“重排”通道（equal-primary DP）也只作用于**已证明同值**的动作集合，结构上不扩大候选。

### 机制 B — 完整枚举 + 离线比较（标签盲）

- 全部 110 条计划均有状态可见特征（`uniqueProgress / revisitCount / zeroCostActions /
  boardChangedVsRoot / boxesMovedVsRoot / distanceStart/End/Delta / frontierCount`）；
  这些特征计算不调用搜索、不读取任何历史标签。
- 唯一前线 18 个；最大同前线组 20 条计划、次大 19 条、16 条……
- 控制计划特征（离线注释，不参与排序）：

| 计划 | uniqueProgress | revisit | distanceΔ | 生成顺序位置 | 历史标签（仅离线） |
| --- | --- | --- | --- | --- | --- |
| UUDD | 2 | 1 | 0 | 4/109 | — |
| DUUD | 2 | 1 | 0 | 34/109 | — |
| LUDR | 2 | 1 | 0 | 70/109 | — |
| UURR | 3 | 0 | **4（99.1 分位）** | 8/109 | 鼠方强制胜（PROVEN） |
| **DRRR** | 3 | 0 | 2（87.3 分位） | 63/109 | 猫方生存（PROVEN，窗口 2） |
| DRDR | 3 | 0 | 0 | 57/109 | — |

- 标签政策：`DRRR`/`UURR` 的历史证书只作**离线裁决注释**；枚举顺序为生产生成顺序，任何排序均未读取标签。

## 四、G4：评价解释（严格三分，不合并为单一“安全分数”）

1. **完整猫回合的空间推进**：DUUD `distanceΔ=0`、uniqueProgress 2、revisit 1；DRRR `distanceΔ=2`、
   uniqueProgress 3、revisit 0。两者均未移动箱子。
2. **鼠方完整下一回合后的 D2 期望值**（fresh depth-1 生产搜索，从各自前线）：
   - DUUD = **-658.2105263157898**（冻结值逐位一致），10,964 节点 / 22,270 叶 / 71 chance；
   - DRRR = **-854**（冻结值逐位一致），9,615 节点 / 18,113 叶 / 71 chance；
   - 差 -195.78947368421018（DUUD 更优）。
3. **H2 有限窗口猫生存证明**（冻结证书，未重跑）：DRRR `catSurvive=true`，
   window=2（冻结文档字段 `horizon.H1=2`），cap=600000，证书 `PROVEN`：
   117,382 leaves / 31,236 branches / 549 chance / 0 policy misses。

E1 非侵入式分解（只读 `ctx.leafEvaluator` 注入点）：

- 前线静态 E1：DUUD **-561.8421052631579**，DRRR **-917.2368421052631**，差 +355.3947368421052。
  分项差（DUUD−DRRR）：capturePressure +360、holeControl +200、mobility -62.5、
  voronoiBalance -142.105…，其余 0。
- 鼠回合后访问叶子的平均贡献差（DUUD−DRRR）：holeControl **+201.60**、tunnelControl +25.68、
  capturePressure -96.87、voronoiBalance -107.83、mobility -67.65、butterRace -30.63、其余小量。

**限制（如实记录）**：叶聚合只覆盖剪枝搜索的**访问叶子**，不是 D2 值的精确期望分解；
前线静态 E1 是“鼠方行棋前”的静态分，不能与 D2 期望值混算；H2 是冻结有限窗口证书，不是数值输入；
本报告不构造任何复合安全分数。

---

## 五、七个必答问题

**1. 仅用 principal-only 候选源，是否本质上无法发现 DRRR？**
是。生产自然搜索的候选池由搜索自身路径与 equal-primary 重排组成（G1）；重排不扩大池（机制 A）。
DRRR 在池外，因此“只重排主候选”结构上不可能发现它。

**2. 完整猫回合枚举是否包含 DRRR？**
包含。`DRRR` 恰出现 1 次，位于生成顺序第 63/109（0-based），4 步，结束于合法鼠方幽灵边界 CHANCE
（单结果），其前线 full-state SHA 与第 1 轮重放 `253033ff…` 完全一致。

**3. 候选总数与唯一后继前线数？**
110 条合法完整回合；按完整 canonical state 去重为 110，按游戏可见 snapshot（不含动作历史）去重为 **18**。
唯一足迹的“归并”主要来自不同走序抵达同一游戏局面（如三条 principal 共享同一 snapshot 前线）。

**4. 加入候选后，是否存在有意义的低成本筛选特征？**
特征本身廉价且可算（每候选 O(1) 状态读取，无需搜索），并且能表达推进/折返/箱子变化等结构；
但**单特征不足以筛选安全性**：本轮证据中，`distanceΔ` 最高的 `UURR`（4，99.1 分位）反而是历史证明的
鼠方强制胜，而安全的 `DRRR` 只有 2；D2 实际主变着所在的 `DUUD` 一族 distanceΔ=0。
因此“有意义的低成本特征”存在，但只能作为候选排序/剪枝的输入，必须与鼠方威胁类特征组合并离线验证。

**5. 仅“禁止循环”是否足以选出安全路线？**
否。`UURR` 与 `DRRR` 都 revisit=0、uniqueProgress=3（无循环），`UURR` 甚至更接近鼠方，
却是强制败局。禁止循环（或“鼓励净推进”）在本根上会把 `UURR` 排在 `DRRR` 之前。

**6. 是否值得构建不依赖昂贵在线证书的战术候选选择器？**
值得做**原型可行性**研究，但不应当现在接入生产：
- 枚举本身很便宜（110 条 / 46 次展开 / 单次 ~55 ms / job RSS < 0.8 GB），完整候选集完全可在线获得；
- 但 E1 静态分在前线上把 DRRR 评得更差（-917 vs -562），单靠 E1 或空间特征会误导；
- 一个可用的选择器必须估计“鼠方下一回合的即时威胁/强制线”（例如一层鼠方威胁探测或战术模式），
  其成本与误报率需要单独一轮可行性实验，本轮的 G6T2 单根数据不足以证明泛化。

**7. 哪些结论只对 G6T2 成立、需要其他局面检验？**
- 结构性结论（principal-only 不扩池；equal-primary 只重排同值；执行层可逐步回放）来自代码路径，**不依赖根**。
- 数值性结论仅对 G6T2：110 条 / 18 个唯一前线 / 46 次展开 / 全部 4 步 / 全部幽灵边界结束 /
  零代价动作 0（因陷阱已放置）/ 各特征分位与控制计划下标。
- “特征无法区分安全”的证据在本根由 `UURR vs DRRR` 给出；其他根（含陷阱可用、不同幽灵债务、
  终局/捕获分支）可能改变候选结构与特征分布，必须另测。

---

## 六、G5：重复性与资源

三次 fresh-process 串行枚举，投影 SHA 完全一致：
`8903626d32ef43d0eefce9c616bde4dafec7535101e901e2e402777a76837673`（rep1/2/3）。
枚举体耗时 55 / 54 / 53 ms；G4 分解两次 depth-1 搜索合计 < 1 s 测试体时间。
资源准入、逐阶段记录与报告时点复查见 `RESOURCE_SAFETY_LOG.md`：全程无新 swap-out / OOM，
受保护服务 MainPID 不变，运行期 MemAvailable 最低 2.11 GiB（高于 1 GiB 中止线）。

## 七、边界与停止

- 未重跑百万节点 D2、未重跑 H2 证明、未运行 self-play / 全 8 根实验、未接生产。
- 未降低冻结正确性门槛、未改规则、未提高并发、未扩 V8 heap、未 commit / push / merge。
- **STOP_FOR_CHATGPT_REVIEW = TRUE**：等待裁决后再决定是否进入战术选择器研究方向或生产开发。
