# PPC-G6T2-SELECTION-CAUSE-01 — G6T2 安全路线未被选择的机制定位

根 G6T2 / ARM E1 / 固定 D2（depthTurns=2）/ 只读生产源码 / 离线研究。
所有重型运行在云主机 `docmap` 上以单并发、串行 fresh process 完成；本地不做重型计算。

---

## 一、人读摘要（先看这里）

G6T2 在 D2 下三个根动作 U / D / L 的搜索值**逐位完全相同**（-658.2105263157898，mate=null，bound=exact），
不是“差一点没选中”，而是**精确算术平局**。选中 D 之后，D 节点的三个候选 U / L / R 在**同一 D2 上下文内同样逐位相等**，
按生产选择器的稳定规则（严格改进才获胜；精确平局保留更小的原始合法序号，此刻顺序为 U,L,R），
**R 是被平局裁决淘汰的，不是被价值淘汰的**——U 以 originalIndex 0 获胜。

再往下一层，R 就不再“平局”了：DR 节点上 R = D = -745.4473684210526，严格劣于 L 的 -658.2105263157898；
DRR 节点上 R = -854，严格劣于 L = -745.4473684210526（该节点最差的是 D = -900.7105263157896）。
四步全强制比较（同一 E1 叶评价器、同一剩余深度、所有正概率 CHANCE 后继、按权重条件期望）：
`DUUD = -658.2105263157898`（与原 D2 分叉值逐位吻合，基准可对齐），`DRRR = -854`，
**Δ(DRRR − DUUD) = -195.78947368421018**，即 DRRR 在 E1 下确实更差。

D2 发布的三条计划 UUDD / DUUD / LUDR 在**棋盘意义上**是闭合空转：猫回到 (3,3)，鼠仍在 (1,6)，
12 个箱子、陷阱 (1,1)、隧道阻塞全部不变；仅 5 个记账字段变化 + 一个挂起黄油刷出落地（5,1），
三条计划的终局**完整状态 SHA 完全相同**（51b3773e…）。严格按“与根完整状态逐字节相等”判据，它们不是“完全无变化”（判据值为 false），
但按游戏进程判据它们是**零进展闭环**——这一点在报告中如实分层，不混淆两种说法。

另有一处**独立**的计划发布层分歧（CASE C）：`searchBestAction()` 返回的 `catTurnPlan` 是 `ULDR`，
而从根动作逐层走 `planBranches`（上一轮 D2 发布候选的通道）得到的是 `UUDD`。两者都能真实回放，
且终局同为一个完整状态 51b3773e…。这是真实、可复现的分歧，但**不是** D→R 的原因；D→R 的原因是上面的精确平局。

H2 证书（600,000 上限内 DRRR 猫存活 PROVEN：117,382 叶子 / 31,236 分支 / 549 CHANCE / 0 策略漏判）
作为**冻结的正向控制标签**引用，未重跑；H1/5000 对所有计划为 **UNRESOLVED**。二者与 D2 数值比较**严格分开**，未参与任何期望值。

---

## 二、判定（PASS/FAIL）

| 门槛 | 结果 | 证据 |
|---|---|---|
| G0 身份与闭包 | **PASS** | 冻结工件摘要全部命中；39/39 生产源重算一致；fixture/kernel SHA 命中；观测副本与 `transform(生产源码)` 逐字节相等；本地↔云端 57/57 文件字节一致 |
| G0 历史证书绑定 | **PASS** | `G6T2_RECERTIFICATION` 冻结引用：UNRESOLVED、H1=2、cap 600000、safeFirstMoves UDL、safeTwoStepPrefixes [DR]、DRRR PROVEN；未重跑 |
| G1 真实规则回放 | **PASS** | 6 条计划（3 个 D2 + 3 个历史对照）全部回放到合法鼠前沿，无 CHANCE 概率缺口 |
| G2 插桩一致性（parity） | **PASS** | 14/14 检查为 true：nodes 1,283,054；leaf 2,600,863；chance 7,889；value 逐位相等；completed=true；所有 cutoff=0；计划仍为 UUDD/DUUD/LUDR |
| G2 确定性（3 次串行重复） | **PASS** | 三次投影 SHA 均为 `eecdfa47…`；nodes / 观测节点数 / catTurnPlan 全等 |
| G3 强制比较 | **PASS（COMPARABLE）** | 基准 `DUUD` 与冻结根动作 D 的 -658.2105263157898 逐位相等；`DRRR=-854` |
| G4 分类 | **PASS** | 支持 A/B/C 三层；D 不成立；E 不需要；主因 `A_D2_CHILD_VALUE_TIE`；评分可用（SCORES_ADMISSIBLE） |
| 生产源码不可变 | **PASS** | 39 源全部 `IDENTICAL_RAW`；`git status --porcelain` 对闭包 39 路径为空；脏文件均为闭包外既有改动 |
| 资源安全 | **PASS** | 7 次运行全部 RC=0、无 swap-out/OOM/PID 变更（详见 `RESOURCE_SAFETY_LOG.md`） |
| 禁改 / 禁提交 | **遵守** | 未 commit / push / merge；未改 src、GAMEPLAY.md、E1、搜索数学、Sidecar、Guard、预算 |

---

## 三、六个问题

### Q1. UUDD / DUUD / LUDR 是否真的“无进展”？还是仅仅猫回到原点？

按**游戏进程**判定：是零进展闭环；按**完整状态逐字节相等**判定：不是（严格判据返回 false）。
两者都写清楚，不用方向字符串冒充结论：

- 三条计划终局均为合法的鼠行动前沿（猫动作数 0，鼠 3 步）；
- 猫回到起点 (3,3)，鼠全程停在 (1,6)；
- 12 个箱子的位置集合完全不变；陷阱仍为 (1,1)；`blockedTunnels` 为空；`trapPosition`/`catTrapsRemaining` 不变；
- 与“结算后的根”相比，仅变化 5 个字段：`currentPlayer`、`catMovesLeft`、`mouseMovesLeft`、`butterPositions`、`pendingButterSpawns`；
  其中 `pendingButterSpawns` 的变化是挂起黄油 `5,1:0` 落地为 `5,1`；
- 三条计划的终局完整状态 SHA **完全一致**：`51b3773e6da58d7d101af76a65f3956b8eff585bda1e06db8f1797c9148a129b`；
- 4 步内没有重复状态（`repeatedStates=[]`），根状态也未被再次访问——所以它甚至不是“4 步循环回到同一状态”，
  而是**四步后回到同一个“棋盘无净变化”的鼠前沿**；
- 作为对照，UURR / DRRR / DRDR 的终局猫在 (4,6)，箱子虽不变，但鼠的自保位置被压缩，属于真实推进。

因此：**“猫位置回到原点”不是全部，但棋盘也确实没有有效改变；有效改变只发生在记账字段与挂起黄油落地。**
`PLAN_PROGRESS_AUDIT.verdicts.D2_PLANS_TRULY_NON_PROGRESSING=false` 只表示“不满足逐字节相等”，不代表它们有推进。

### Q2. 为什么 D 之后没有 R？R 是被价值淘汰，还是被平局裁决淘汰？

D 节点（ply=1，同一 D2 上下文、同一 E1、同一次根搜索内插桩捕获）：

| 候选 | value | mate | bound | 原始合法序号 |
|---|---|---|---|---|
| U | -658.2105263157898 | null | exact | 0 |
| L | -658.2105263157898 | null | exact | 1 |
| R | -658.2105263157898 | null | exact | 2 |

节点结果：choice=U，resultValue=-658.2105263157898，`distinctValueCount=1`，U−R 差 = 0。
生产选择器规则是“严格改进才替换”；精确平局保留更小的原始合法序号，并带“已证明优先于未证明”的升级规则。
于是 **R 在 D 节点不是被价值淘汰的，而是被平局裁决淘汰的**；U 因为序号最小而保留。
这不是“R 略差”，而是“R 与 U 逐位相等”。

### Q3. DRRR 在 D2 内部排第几？它是“差一点”，还是本来就输？

- DR 节点（ply=2）：D = -745.4473684210526，L = -658.2105263157898，R = -745.4473684210526 → 选中 L，R 严格劣于 L。
- DRR 节点（ply=3）：D = -900.7105263157896，L = -745.4473684210526，R = -854 → 选中 L；R 居中，严格劣于 L，但优于 D。
- 四步强制比较：`DRRR = -854` 对 `DUUD = -658.2105263157898`，Δ = **-195.78947368421018**。

即：R 在 D 之后**没有任何一个节点是严格最优**；DRRR 不是“差一点没被选中”，
而是在同一评价器与同一剩余深度下**明确更低**。平局只发生在 D 节点的第一步选择上。

### Q4. 为什么根 U/D/L 的搜索值会精确相等？

三条根动作各自进入一个**闭合的猫回合**，终局鼠前沿在 E1 下取值相同：
- 这些线路里的 CHANCE 步骤只有**一个正概率后继**（权重 1，概率和 1），因此期望就是该后继的值，没有加权误差；
- 叶评价器 E1 对三个（结构相同的）鼠前沿返回同一个数；
- mate=null，bound=exact，搜索 completed=true，预算/截止/扩展 cutoff 均为 0；
- 因此 -658.2105263157898 是**同一算术结果被重复计算三次**，不是巧合的浮点近似。
插桩一致性门槛（parity）在三次独立进程中复现同一数值与同一覆盖率，排除插桩引入偏差。

### Q5. 是评价器、视界、平局裁决，还是计划抽取有问题？

按证据分层（多层可同时成立）：

| 层 | 结论 | 关键证据 |
|---|---|---|
| A `D2_CHILD_VALUE_TIE` | **成立，主因** | D 节点 U=L=R 逐位相等；choice=U 由稳定平局规则决定 |
| B `D2_EVALUATOR_PREFERS_OTHER` | **成立** | DR/DRR 上 R 严格劣于 L；强制 DRRR 比 DUUD 低 195.79 |
| C `PLAN_EXTRACTION_MISMATCH` | **成立（独立缺陷）** | 生产 `catTurnPlan=ULDR`，直接走 `planBranches` 得 `UUDD`；两者均可回放，终局同一完整状态 |
| D `CHANCE_EXPECTATION_GAP` | **不成立** | 6 条计划中每个 CHANCE 步骤都只有一个正概率后继，概率和=1；强制基准与冻结值逐位相等 |
| E `UNRESOLVED` | 不需要 | 至少一层被测量支持 |

视界/预算：不是原因。搜索 completed=true，所有 cutoff 为 0，节点数 1,283,054 远低于 8,000,000 上限，重复状态为 0。
H1/5000 的 UNRESOLVED 也**不是**原因证据，不计入分层。

### Q6. 对 100ms / 150ms 预算，下一步值得做的战术机制是什么？

以下仅为**设计建议，未实现**，不触碰任何预算与生产源码：

1. **平局层的“进展裁决”**：当多个候选值精确相等时，不直接用合法序号，而是在等值集合上做一个廉价过滤
   （例如：拒绝“整回合后棋盘不变量不变”的自还原线路；优先压缩对手可行动集合/压缩鼠前沿），
   复杂度与现有等值集合同阶，不增加搜索节点。
2. **把 H2 存活证书当硬过滤器，而不是分数**：只在有证书的节点上用“猫必存活”筛除，不把证书折算进期望值；
   H1/5000 的 UNRESOLVED 不参与。
3. **计划发布单一真相源**：`catTurnPlan` 与 `planBranches` 两条通道并存会产生 ULDR/UUDD 式分歧，
   应统一为一个抽取器，并让一致性门槛绑定该抽取器；否则“选了什么”与“发布了什么”会再次脱节。

若只做一项，优先第 1 项：它直接消灭“精确平局 + 自还原闭环”这一类选择，且成本最低。

---

## 四、证据文件与复现

| 文件 | 内容 |
|---|---|
| `SOURCE_MANIFEST.json` | 39 源闭包（全部 IDENTICAL_RAW）+ 13 个本轮 harness + 8 个冻结输入；本地↔云端 57/57 |
| `logs/cloud_equivalence.txt` | 57 个文件的本地/云端 sha256 逐项一致 |
| `logs/g0_identity.json` | 冻结摘要、闭包重算、历史证书绑定、观测副本字节等价、parity 目标 |
| `PLAN_PROGRESS_AUDIT.json` | 6 条计划逐步真实规则回放（含箱子/陷阱/隧道/黄油/CHANCE 后继/终局完整 SHA） |
| `D2_CHILD_VALUE_AUDIT.json` | 一次根搜索内的 ply≤3 插桩：候选值、选择、平局集合、两条抽取通道 |
| `D2_INSTRUMENTATION_PARITY.json` | 14 项 parity 检查与六条冻结数字的对照 |
| `FORCED_PLAN_COMPARISON.json` | DUUD/DRRR 强制四步 + 全部正概率后继 + 条件期望 + 可比性校验 |
| `ROOT_CAUSE_VERDICT.json` | A/B/C/D/E 分层、主因、六问回答、禁令与 STOP 标记 |
| `logs/d2_instrumented_rep{1,2,3}.json` | 三次串行 fresh process 的原始观测与确定性投影 |
| `runs/03/*` | 七次运行的准入采样、逐秒监控、precheck 与原始 stdout |
| `RESOURCE_SAFETY_LOG.md` | 准入、内存/交换、事件与收尾再探测 |
| `SHA256SUMS.txt` | 本轮交付物账本 |

复现命令（与云端一致，单并发串行）：

```
bash PPC-G6T2-SELECTION-CAUSE-01/scripts/run_03.sh g0 PPC-G6T2-SELECTION-CAUSE-01/probe/g0_identity.test.ts
bash PPC-G6T2-SELECTION-CAUSE-01/scripts/run_03.sh g1 PPC-G6T2-SELECTION-CAUSE-01/probe/progress.test.ts
bash PPC-G6T2-SELECTION-CAUSE-01/scripts/run_03.sh g2_rep1 PPC-G6T2-SELECTION-CAUSE-01/probe/instrumented.test.ts PPC_INSTR_REP=1
bash PPC-G6T2-SELECTION-CAUSE-01/scripts/run_03.sh g2_rep2 PPC-G6T2-SELECTION-CAUSE-01/probe/instrumented.test.ts PPC_INSTR_REP=2
bash PPC-G6T2-SELECTION-CAUSE-01/scripts/run_03.sh g2_rep3 PPC-G6T2-SELECTION-CAUSE-01/probe/instrumented.test.ts PPC_INSTR_REP=3
bash PPC-G6T2-SELECTION-CAUSE-01/scripts/run_03.sh g3 PPC-G6T2-SELECTION-CAUSE-01/probe/forced.test.ts
bash PPC-G6T2-SELECTION-CAUSE-01/scripts/run_03.sh g4 PPC-G6T2-SELECTION-CAUSE-01/probe/verdict.test.ts
```

## 五、限制与未决

1. 结论只覆盖根 G6T2、ARM E1、固定 depthTurns=2；不外推到其他根、其他视界或其他评价器。
2. 插桩只记录 ply≤3（根、D 后、DR 后、DRR 后），更深层只看汇总诊断与强制回放。
3. 云端仓库无 git 历史，身份由哈希闭包 + 上一轮 57/57 字节等价共同承载；本轮逐字节复核成立。
4. 历史快照标签 `30a54a57…` 与本地重算的 `8ac26199…` 不同（既有标签口径差异，上轮已记录），本轮只以标签做绑定、以重算值做独立记录，不据此判缺陷。
5. 云端缺少上一轮交付账本 `PPC-D2-PCV-COUNTERLINE-02/SHA256SUMS.txt`，故改用冻结工件摘要逐项核验（全部命中）。
6. H2 证书为冻结正向控制标签（未重跑）；H1/5000 对所有计划仍 UNRESOLVED，不作为任何结论的正反证据。

---

`STOP_FOR_CHATGPT_REVIEW = TRUE`
COMMIT = NO / PUSH = NO / MERGE = NO / PRODUCTION_WIRING = NO