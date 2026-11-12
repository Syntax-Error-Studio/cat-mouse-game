# PPC 研究入口 · Perfect Cat Research Index

本文件是《小猫小鼠 / cat-mouse-game》全部 **PPC（Perfect Cat Program）** 研究轮次的统一入口。
面向后续 Pro 深度架构研究：每一轮给出**路径 / 状态 / 结论 / 局限 / 内容 SHA / 本地未入库工件**。

> 纪律前提：所有 PPC 轮次均为**只读研究**，不修改生产 AI、不改 `GAMEPLAY` 语义、不改
> `MAIN_SEARCH_SEMANTIC_BUDGET=100ms` / `TOTAL_TURN_HARD_WALL=150ms`、不改鼠 AI。
> 各轮 `COMMIT_PUSH_STATUS` 在当时均为 `NONE`；本基线的提交只是**归档**，不改变该结论。

---

## 0. 基线身份

| 项 | 值 |
| --- | --- |
| 基线分支 | `ppc/perfect-cat-research-baseline-20261112` |
| 基线父提交 | `9ba04b53ff89370a3de6b7c1e318cb78e3c742b1`（`feat: add experimental A0 AI leaf for dev playtesting`） |
| GAMEPLAY ruleset | `v2`（`GAMEPLAY_RULESET_VERSION = 2`） |
| 生产搜索预算 | `MAIN_SEARCH_SEMANTIC_BUDGET = 100ms` / `TOTAL_TURN_HARD_WALL = 150ms` |
| 难度映射 | Easy=`catAiEasy`；Medium=`catAiHard`；Hard=`catAiSearch`（失败回退 `catAiHard`） |
| 研究工件存放 | 每个轮次一个独立顶层目录 `PPC-*`，与冻结权威分离 |

**SHA 说明**：下文"内容 SHA"是**文件级 SHA-256 前 16 位**，用于确认 Pro 读到的是同一份报告；
它不是 commit SHA（各轮报告在生成时均未提交）。

---

## 1. PPC-ARIMAA-01 · 架构研究与预注册

| 项 | 值 |
| --- | --- |
| 目录 | `PPC-ARIMAA-01/` |
| 报告 | `PPC-ARIMAA-01_ARCH_RESEARCH.md` — SHA `1a7748f3ac24a834`（55,689 B） |
| 预注册 | `PPC-ARIMAA-01_PREREGISTERED_EXPERIMENTS.json` — SHA `19d2fc610502e0b0`（13,834 B） |
| 预注册状态 | **`PREREGISTERED_NOT_EXECUTED`（实验未运行）** |

**结论（架构层，非实测）**
- 完整审计生产 Hard 的搜索调用链与数学骨架（`hardTurnPlanner` → `expectiminimax` → `buildCatTurnPlan`）。
- 明确"两类失败不可混为一谈"：一类是**规则必败**（该根必然输），一类是**AI 可避免的失误**。
- 登记两处**代码 ↔ 文档差异**（只登记不修）：通道出口存在"原地"选项；出口集合是"所有未堵角落"
  而非 GAMEPLAY 描述的"对角线对面"。
- 输出 Arimaa / SHARP、Stockfish / Pikafish、AlphaZero / Leela 三族技术的**适配矩阵**。

**局限**
- 预注册实验**一个都没有运行**，因此本目录不含任何新的性能或正确性数据；报告中的架构判断全部来自代码阅读。
- 适配矩阵是方案评估，不是可行性证明。

**本地未入库工件**：无（本目录全部入库）。

---

## 2. PPC-PTB-1A · 单回合胜利证书预审

| 项 | 值 |
| --- | --- |
| 目录 | `PPC-PTB-1A/` |
| 报告 | `PPC-PTB-1A_CERTIFICATE_PREAUDIT.md` — SHA `480b561a60c410e4`（23,262 B） |
| 预注册修订 | `PPC-PTB-1A_PREREG_AMENDMENT_V1.json`（AM-1..AM-5）— SHA `cf8e2393f04e0dcf` |
| 探针 | `ptb1a_probe.test.mts` + 隔离 `vitest.config.mts` |
| 证据 | `out/p1a…p5a` 共 9 份 JSON |
| 最终状态 | `PPC_PTB1A_STATUS = COMPLETE__CERTIFICATE_DEFINED_BUT_NOT_MATE_READY` |

**结论**
- **鼠方单回合 `PROVEN` 的正确形式**（后续轮次直接引用）：必须同时满足
  `phase=Playing` ∧ `currentPlayer=Mouse` ∧ `movesLeft>0` ∧ `hasButter` ∧
  `trapAwareCarryingDist(...) <= movesLeft`，且认洞必须用 `board[r][c].type === 'mouse_hole'`。
  **必须减去陷阱格**——踩陷阱 = 剩余步数清零 + 回合结束，且陷阱判定**先于**入洞判定。
  修正后 400/400 与真实引擎一致，可称为"回合内精确"。
- **猫方 `catWalkDist <= catMovesLeft` 只是充分条件**（walk-only，不含推箱），**永远不能用来反证**。
- 结构事实：D1 叶子**全部是鼠方回合**（冻结 453/453、复算 1044/1044 mouse）；D2 墙钟约 1.4s
  ⇒ **猫方证书在 100ms 内 0 个触发点**。
- 顺序修订：原 M1→M2→M3 改为 **M3（让 D2 可完成）→ M1 鼠方标注 → 猫方证书**。

**局限**
- 证书**定义完成、未接入 mate-distance**；`NOT_MATE_READY` 是字面含义。
- 只覆盖**单回合**；深度 ≥2 未涉及。
- 成本口径：`carryHoleMap` 查表 0.00007ms/叶；带陷阱三门 BFS 0.0127ms/叶（≈ H1 的 12.4%）；
  单跑携带 BFS 0.025ms/叶（24.5%，**禁止这样写**）。

**明确禁止**：仅凭距离报 `PROVEN`；把 `NOT_PROVEN` 当"赢不了"；把 `UNKNOWN` 当安全；
在 mate-distance / 深度 / TT EXACT / CHANCE 四合同完成前把证书注入叶子值。

**本地未入库工件**：无。

---

## 3. PPC-SEARCH-01 · PVS 否证

| 项 | 值 |
| --- | --- |
| 目录 | `PPC-SEARCH-01/` |
| 报告 | `PPC-SEARCH-01_PVS_REPORT.md` — SHA `47a6672cd51d3895`（30,932 B） |
| 预注册 | `PPC-SEARCH-01_PREREGISTRATION.json` — SHA `c5344cbba8626f1a` |
| 探针 | `pvs_*.test.mts`（11 个）+ `pvs_lib.mts` + `proto/expectiminimaxPvs.ts` + 隔离 `vitest.config.mts` |
| 证据 | `out/s1…s7`、`out/diag1…diag4`、`out/fork.diff` 等 |
| 最终状态 | `PPC_SEARCH01_STATUS = COMPLETE__NO_GO_PVS` |

**结论：`NO_GO_PVS`（不要迁移 PVS）**
- D2 25 个冻结根：节点 **+19.2%**（中位 1.127×）、墙钟 **+15.9%**、逐根加速中位 **0.938**
  （预注册门槛 1.25）。
- 三条独立根因（任一条足以否决）：
  1. 生产排序已让 **93.7% 的剪枝发生在第一着**，PVS 没有"废树"可省，只剩 scout + 回搜；
  2. CHANCE 节点按 D2 不变式**全窗口求和**，窄窗口在那里不可能更便宜（arm C 豁免与 B 的节点数完全相同）；
  3. 这套搜索是 **EXACT-only TT 撑起的 DAG 走查**——PVS 让 61% 节点走窄窗口 ⇒ 给缓存断粮
     （关 TT 时 A 8.2×；G1T10 22.35×）。
- **附带发现（架构级缺口）**：`expectiminimax.ts` 的 `boundType` 只表达**cutoff 轴**，不表达**window 轴**。
  全窗口下"不剪枝⇒精确"成立，窄窗口下不成立（`(X,X)` 未剪枝的 MAX 只证 `value ≤ X`，叶子却返回 `'exact'`）
  ⇒ scout 被 `isCertifiedResult` 判真、写进 EXACT TT、进入等分图、改变 `catTurnPlan`。
  arm D 实测修好后**更糟**（G1T10 12,225 → 365,612 节点），证明不是"改个小 bug 就能用"。

**局限（重要：不得当成性能基准引用）**
- **正确性门槛未全过**，故 P4 性能对照"仅作机制说明，不构成 GO 依据"。
- 100ms 实测：两臂都只到 **D1**（8/8，fallback 0），**D2 完成率 0/8**。PVS 不改变"D2 不可完成"。
- 计划回放必须用引擎 `catMove`/`catPlaceTrap`；`simulateSearchAction` 会把猫→鼠边界报成
  "hit a chance node"（harness 限制）。
- 亚秒级根的**单次墙钟有 2.3× 噪声**，**节点数才是主证据**（跨进程确定性）。

**本地未入库工件（`*.log` 被 `.gitignore` 排除，需手动提供）**
- `PPC-SEARCH-01/out/correctness_run.log`（81 B）
- `PPC-SEARCH-01/out/engine_replay.log`（1,839 B）
- `PPC-SEARCH-01/out/rootcost.log`（1,588 B）
- `PPC-SEARCH-01/out/sweep.log`（9,273 B）
- 说明：这 4 份是**可由探针重跑得到**的原始 stdout，不含唯一信息；重跑命令见 §6。

---

## 4. PPC-MOUSE-01 · 鼠 AI「M0」与共享内核

| 项 | 值 |
| --- | --- |
| 目录 | `PPC-MOUSE-01/` |
| 报告 | `PPC-MOUSE-01_MOUSE_M0_REPORT.md` — SHA `9ed66705b8c120e4`（31,774 B） |
| Claim 范围 | `PPC-MOUSE-01_CLAIM_SCOPE.json` — SHA `5e8fa7d6892de632` |
| 勘误 | `E0_PPC_SEARCH_01_ARM_D_ERRATUM.json` — SHA `d689518e4533bca1` |
| 共享内核 | `mouse_lib.mts` + `mouse_{m0,p1,p4,smoke}.test.mts`（4 文件 / 24 项） |
| 证据 | `out/` 21 份 JSON/JSONL + `out/SUMMARY.json` + `summarize.py` |
| 最终状态 | `PPC_MOUSE01_STATUS = COMPLETE__M0_FEASIBLE_WITH_SHARED_CORE` |

**结论**
- **鼠根搜索是正确的**：14 个根-深度对与无剪枝预言机**逐位相同**（`maxAbsValueDiff=0`，选招 == argmin）。
  预言机与搜索共用 `simulateSearchAction` / `mateActionCost` / `evaluateForCat`，因此这**只证明搜索组合学**，
  规则正确性另靠真实引擎（26/26 接受）。
- **铁律**：`createSearchContext` **不设** `leafEvaluator` 时静默使用 `defaultLeafEval`
  （`200 - 5·曼哈顿 - 60·黄油`），与 `evaluateForCat` **不同值**。任何比较前必须**显式注入**。
  （指纹：`135 = 200 - 5·1 - 60`。）
- **禁止再写第二套 Expectiminimax**。共享内核 + 显式叶子注入是唯一正确路径。
- 预算：一个鼠回合一个共享池（`grantsMs [100]`，Σgrant ≤ 100）。
- RULE-A 坑：已判负的位置**仍会宣告 4 个合法动作**，控制器必须**先查** `applyNoMoveLoss`。

**局限**
- **鼠 AI 已 PAUSED**；M0 是原型，**未接入生产**。
- **整回合鼠计划缺 5 项（计划层）**：`catTurnPlan` 在鼠根恒为 0（`buildCatTurnPlan` / `fallbackPlanWalk`
  有硬门 `currentPlayer !== Cat`）；`forcedLossTieBreak` 在鼠根为 `null`；条件化 / 传送子相位 /
  陷阱变长 / 交接重查 均未实现。
- `CLAIM_SCOPE` 标注 `post_hoc = true`（与 SEARCH-01 不同，MOUSE-01 无预注册）。

**本地未入库工件**：无。

---

## 5. PPC-CAT-STRATEGY-01 · 猫战略能力只读诊断

| 项 | 值 |
| --- | --- |
| 目录 | `PPC-CAT-STRATEGY-01/` |
| 报告 | `PPC-CAT-STRATEGY-01_REPORT.md` — SHA `c82ef4ba5672b230`（26,500 B） |
| Claim 范围 | `PPC-CAT-STRATEGY-01_CLAIM_SCOPE.json` — SHA `184c5cf8d0403efd`（`post_hoc=true`，无预注册） |
| 探针 | `cs01_lib.mts` + `cs01_real` / `cs02_ghost` / `cs03_push` / `cs04_trap` / `cs05_config`（5 文件 / 17 项） |
| 证据 | `out/` 17 份 JSON + `out/MANIFEST.json`（26 文件 sha256 清单，26/26 复算一致） |
| 最终状态 | `PPC_CAT_STRATEGY01_STATUS = COMPLETE_READ_ONLY` |

**结论（四问）**
1. **黄油诱敌**：不是"被骗"，是**看不见**。真实 game1 T9 逐帧复现：幽灵黄油实体化后鼠用 5 步
   （烧油 → 走新油 → 捡 → 进洞，witness `rSrrrr`）**一回合获胜**；删掉该幽灵则同回合 93 态穷举**无胜**。
   H1 **双重盲区**：pending 幽灵恒 0 分（原样/删掉/移到洞口三种情形总分**完全相同** −1172.4）；
   鼠携带黄油时**任何**黄油（含洞口门口的实体油）也恒 0 分——`butterRace` 被强制清零，
   而 `mouseWinRouteDistance` 算了却**从不计分**。
2. **推箱堵通道**：规则层完全合法且效果显著（`blockedTunnels` 正确生成、鼠到洞 BFS 4→9、
   可用角 4→3），搜索也会生成并评估——但 **24/24 真实猫回合 `boxesAdjacentToCorners = 0`**：
   箱子生成器只采样内圈 `[1, S-2]`，箱子**永不在最外圈**，而四角相邻格全在最外圈 ⇒ 堵一个角
   **≥2 回合**施工，而实际深度 D1 14/24 · D2 8/24 · D3 2/24。
3. **早放夹**：`catPlaceTrap` **不消耗 `catMovesLeft`**（免费动作）；`trapControl` **无条件正分**；
   库存 / 回收 / 机会成本**一项不计**；距离用含传送边的鼠 BFS（(1,1) 仅算 8 步 < 曼哈顿 11）。
   叶节点对照（同一终点）：先放夹 **409.947** > 第二手 **349.947** > 不放 **289.947**。
   4/4 真人局首回合计划均以 `T` 开头，夹子全落 (1,1)，此后 `trapsRemaining = 0` 且**从未生效**。
4. **归因层**：**评价层**（规则层 / 动作生成层 / 搜索层 / 计划层 / Sidecar 层均已排除）。

**重要边界（不得误引）**
- 输掉的这一根**猫躲不掉**：33/33 合法猫整回合仍在一回合内输 ⇒ `NO_SAFE_ALTERNATIVE_PROVEN`，
  与冻结 `safeAlt = NONE_ROOT_FORCED` **独立吻合**。**规则必败不得归咎于 AI。**
- 真实**可避免**的失败在**别处**：G6T2 `safeAlt = "DRRR (ALL_OUTCOMES_SAFE)"`（2-ply 结构判据，继承不重做）。
- 本报告是 `post_hoc`，**无预注册**；"推荐 C"是**下一轮待预注册的假设**，不是已验证改进。
- `CLAIM_SCOPE` 明确列出 5 条 **NOT supported**，引用前请先读。

**唯一推荐候选（本轮未实施）**：`C_TRAP_TIMING_AND_OPPORTUNITY_COST` ——
用 feature-flagged 叶子项替换无条件 `trapControl`，含 `onMouseRoute` / `routeCredit` /
`resourceCost` / `reclaimCost` / `offRoutePenalty`；**0 次新 BFS**，**TT 安全**
（`trapPosition` / `catTrapsRemaining` 已在 `stateKey`）。反例：鼠已在洞口门口时不应放夹。
`NEXT_STAGE_GO_GATE = PRE_REGISTERED_A_B_REQUIRED`。

**本地未入库工件**：无（`out/` 17 份 JSON + MANIFEST 全部入库）。

---

## 6. 复现命令

所有 PPC 轮次都用**独立 vitest 配置**串行运行，互不干扰：

```bash
# PPC-ARIMAA-01 无探针（纯架构研究轮，0 个可执行实验），下无条目
npx vitest run --config PPC-PTB-1A/vitest.config.mts
npx vitest run --config PPC-SEARCH-01/vitest.config.mts
npx vitest run --config PPC-MOUSE-01/vitest.config.mts    # 4 文件 / 24 项，约 27s
npx vitest run --config PPC-CAT-STRATEGY-01/vitest.config.mts  # 5 文件 / 17 项，约 6s
python PPC-MOUSE-01/summarize.py                          # digest 必须仍是 b506de77335118fa
```

按 `HEAVY_WORKER_CONCURRENCY = 1` 要求：**串行**运行，不要并行多个配置；不要在这些配置外
并发启动重型 benchmark。

**本轮（归档）执行的验证**
```bash
npx tsc -b                       # 通过
npx vite build --config <emptyOutDir:false 的临时配置>   # 通过（沙箱 safe-delete 限制，见下）
npx vitest run src/game/__tests__/gameplayBaseline.test.ts \
               src/game/rules/__tests__/noMoveLoss.test.ts \
               src/game/__tests__/smallBoardConfig.test.ts \
               src/game/__tests__/newGameEntry.test.ts \
               src/game/__tests__/openingFairness.test.ts    # 5 文件 / 59 项通过
```

> 环境注意：本机沙箱下 `npm run build` 的 `vite build` 会被 safe-delete 外壳拦截
> （`emptyOutDir` 清理 `dist/` 时批量中止）。用临时 `vite.config.build-tmp.ts` 设
> `emptyOutDir: false` 可跑通，跑完删除该临时文件。`tsc -b` 本身正常。

---

## 7. 未运行的实验（**明确标记，不得视为通过**）

| 轮次 | 项目 | 状态 |
| --- | --- | --- |
| PPC-ARIMAA-01 | 全部预注册实验（`_PREREGISTERED_EXPERIMENTS.json`） | **NOT EXECUTED** |
| PPC-PTB-1A | 猫方证书接入 mate-distance | **NOT IMPLEMENTED**（`NOT_MATE_READY`） |
| PPC-SEARCH-01 | D2 完整完成率（100ms 下 0/8） | **NOT ACHIEVED**（非"通过"） |
| PPC-SEARCH-01 | 正确性门槛 | **NOT FULLY PASSED**（故 P4 性能仅机制说明） |
| PPC-MOUSE-01 | 鼠 AI 生产接入（M0 原型） | **NOT INTEGRATED**（鼠 AI 已 PAUSED） |
| PPC-CAT-STRATEGY-01 | 推荐候选 C 的 A/B | **NOT RUN**（需下一轮预注册） |
| PPC-CAT-STRATEGY-01 | 推箱堵通道的实战触发 | **0 OCCURRENCES**（非"失败"，是无决策点） |

---

## 8. Git 忽略、但 Pro 必须阅读的资料（**需手动提供**）

以下内容被 `.gitignore` 排除（体积或策略原因），**不在本基线提交内**。
Pro 需要在本地环境读取，或由人工单独传送：

| 路径 | 体积 | 为什么需要 | 处理建议 |
| --- | --- | --- | --- |
| `ai-training/**` | **8.9 GB** | 冻结权威语料；HV14–HV20 与 PPC 各轮的输入数据 | **不可入库**；按需提供子目录 |
| `ai-training/f2b19a/log_game{A,B,C,D}.txt` | 183 KB（4 份） | **唯一真人 4 局对局日志**；HV14–HV20 / CAT-STRATEGY-01 的真身证据源 | **必须单独提供这 4 份**（`23,866 / 30,483 / 60,450 / 68,232` B） |
| `ai-training/f2b19a/`（其余） | 20 MB | 该轮 fixtures 与 authority | 按需 |
| `ai-training.zip` | **≈2.99 GB** | 历史归档快照 | 仅供追溯，通常不需要 |
| `scratch/` | 见本地 | 前序轮次取证临时区 | 按需 |
| `.workbuddy/memory/MEMORY.md` | 8.5 KB | **跨轮硬约束总账**（时间契约、量词分层、禁止事项、踩坑教训） | **强烈建议提供**，价值密度最高 |
| `.workbuddy/memory/*.md`（按日期） | 各 <20 KB | 每轮工作日志与排查过程 | 按需 |
| `PPC-SEARCH-01/out/*.log`（4 份） | 12.8 KB | 原始 stdout | 可重跑生成，见 §6 |
| `dist/` `node_modules/` `test-results/` | — | 构建产物 | **不需要** |

> 若只允许提供**一个**额外文件，请给 `ai-training/f2b19a/log_game{A,B,C,D}.txt` ——
> 没有它，CAT-STRATEGY-01 的 `REAL_REPLAY_VERIFIED` 与 HV14–HV20 的全部真人对局结论
> 都只能读结论、无法复算。

---

## 9. 给 Pro 的阅读顺序建议

1. `GAMEPLAY.md` —— 规则权威（注意 §1 登记的两处代码 ↔ 文档差异，**以运行代码为准**）。
2. `PPC-ARIMAA-01/PPC-ARIMAA-01_ARCH_RESEARCH.md` —— 现状架构与失败分类。
3. `PPC-PTB-1A/PPC-PTB-1A_CERTIFICATE_PREAUDIT.md` §2 三值接口与安全定义 —— 证书语义基线。
4. `PPC-SEARCH-01/PPC-SEARCH-01_PVS_REPORT.md` §八 —— 已否决方向（**避免重复尝试**）。
5. `PPC-MOUSE-01/PPC-MOUSE-01_MOUSE_M0_REPORT.md` §铁律 + `CLAIM_SCOPE` —— 共享内核契约。
6. `PPC-CAT-STRATEGY-01/PPC-CAT-STRATEGY-01_REPORT.md` —— 当前最高优先级诊断与唯一候选。

**已被证据否决、不要重做的方向**：PVS / 任何"窄窗口"变体；给猫加步数 / 陷阱 / 速度；
偷看或改图；`chance` 一律按 OR 处理的通用论证；把 `NOT_PROVEN` 当"赢不了"。
