# PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01 — 两鼠回合 oracle 正确性封口与成本消融

- 仓库：`F:\小猫小鼠`；HEAD `d533c8f`，分支 `ppc/p1-id-state-identity-fix`（本轮未提交、未推送、未合并）。
- 模式：`HEAVY_WORKER_CONCURRENCY=1`、`SERIAL_FRESH_REPETITIONS=TRUE`、`DUPLICATE_BENCHMARK_CHECK=REQUIRED`、`COMMIT=NO`、`PUSH=NO`、`MERGE=NO`、`PRODUCTION_WIRING=NO`、`STOP_FOR_CHATGPT_REVIEW=TRUE`。
- 性质：正确性封口 + 算法成本研究；**不是**排序器调参轮次。未改生产 `src/`、`GAMEPLAY.md`、E1、H0/H1、PCV、搜索数学、`stateKey`、100ms/150ms 常量。

## 0. 判定

**PASS**（附 3 项如实披露的“不可观测”缺口，见 §6.3），核心结论：

- `DUUD` 在“DUUD 计划执行后的鼠前沿、两个鼠回合”窗口内被独立证明为鼠强制胜：`INDEPENDENTLY_VERIFIED`。
- G1T9 的 H1 问题最终定性为**上一轮报告的中文注释命名错误 + 证据轨迹不同**，不是窗口矛盾、不是证明矛盾；根级证书在冻结 600k 帽下 `UNRESOLVED`，单独披露为 OPEN。
- 约 6 秒几乎全部是证明必需的 solve 成本；witness 行是毫秒级可选诊断；取证用的独立验证器另加 2.4–7.3 s；NO_WIN 情形影子工具的长尾是可选的存在性 witness 搜索。
- 唯一值得下一轮优化的具体瓶颈：每节点重建 `generatePreparedSearchActions`（约 93–230 µs/节点）。

## 1. 四个直接回答

**1. DUUD 是否被独立证明为鼠强制胜？**

是。证据链（`DUUD_INDEPENDENT_PROOF.json`、`INDEPENDENT_VERIFIER_RESULT.json`）：

- 起点：冻结根 `G6T2` 执行冻结计划 `DUUD` 后的鼠行棋前沿，frontier stateKey SHA256 `ef77515c…`，1 个正概率 CHANCE 结果（权重 1）。
- 量词：∃鼠策略 ∀猫走法 ∀正概率 CHANCE 结果 → MouseWins；`H=2, startIdx=1, cap=600000`，窗口 = 鼠(1) + 猫(2) + 鼠(3)，猫节点 `idx>=4` 出窗。
- 求解：`value=true`，`truncated=false`，**65,585 节点**（与影子工具完全一致）、193,117 转移、2,122 个 CHANCE 节点、53,766 个正概率结果样本、58,328 次 memo 命中、策略表 9,147 项、maxIdx=3。
- 独立验证：`verifyMouseCertificate`（不共享求解器 memo、逐 cat 走法与逐正概率 outcome 重枚举、无剪枝）**PROVEN**，110,921 叶、1,012 个分支、865 个 CHANCE 节点、最大深度 18、0 次策略缺失、无反例。
- 见证：14 步行棋线（SHA256 `ee306200…`），末态 `mouse_wins_by_reconstruction`。
- 判定：`INDEPENDENTLY_VERIFIED`。**作用域仅限该前沿的两个鼠回合**，不可移植到其他 root/frontier。

**2. G1T9 的 H1 问题：命名混淆、证据身份不同，还是证明矛盾？**

三者中命中前两项，**不是**证明矛盾：

- **命名混淆**：上一轮报告把根级 `H1` 注释成“一个猫回合 + 一个鼠回合”，而实际定义是 `startIdx=0, H=2` = 猫(0)+鼠(1)+猫(2)+鼠(3)，即**两个鼠回合**；“猫+鼠各一个回合”是 `H0`。冻结工件（分类结果、节点数）本身没有错，错的是报告文字。
- **证据身份不同**：同一根、同一窗口，用 SEAL 重解得到 `true`，但轨迹是 **229,158 节点**，而冻结 STRATEGY 工件记录 `h1Nodes=66,749`——STRATEGY 带 `cannotReachHoleInHorizon` 剪枝且是分值搜索，SEAL 是纯布尔量词。两者只共享布尔结论，不共享节点数，不能拿节点数相等当交叉复核。
- **证书下落**：根级 `verifyMouseCertificate` 在 600,001 叶处撞冻结 600k 帽 → `UNRESOLVED / NODE_CAP`（`policyMisses=0`），**没有降帽、没有换算法**。因此 G1T9 根标签只记为“来源已核对 + 布尔结论被第二内核复现”，**不计入**独立验证；同一 G1T9 的 `LLLD` 计划前沿证书则 **PROVEN**（24,075 节点 / 24,999 叶）。

**3. 那 ~6 秒里，多少是证明必需、多少是可选诊断？**

以最慢一轮（rep1，影子两回合总计 6,178 ms）为例：

| 项目 | 实测 | 性质 |
|---|---|---|
| 核心证明 `solve`（65,585 节点） | 5,783–6,280 ms | **证明必需**（≈94–97%） |
| witness 行 | 28–90 ms | 可选诊断（<1.5%） |
| 独立证书 `verifyMouseCertificate` | 另加 2,419–7,294 ms | 取证必需、非生产必需 |
| `staticReach` 静态可达诊断 | 568–1,704 ms | 可选诊断 |
| NO_WIN 时影子工具的存在性 witness 搜索 | 1,832–5,456 ms | 可选诊断（从不改变判定） |

结论：**主证明本身没有可剥的“诊断脂肪”**——6 秒就是 solve。真正可剥的是取证用的独立证书、witness 行、静态可达、以及 NO_WIN 情形的存在性搜索。同一主机三次新进程间 solve 时间从 2,095 到 6,280 ms（约 3× 波动），因此本报告只把“证明 vs 诊断”的比例写进结论，绝对毫秒数只进性能摘要、绝不进语义摘要。

**4. 有没有值得下一轮优化的具体算法瓶颈？**

有，且只有一个主导项：

1. **每节点重建 `generatePreparedSearchActions`**：约 93–230 µs/节点 × 65,585 节点 ≈ 整个 solve 时间。按 `stateKey` 缓存的“合法动作束”是最直接的低风险优化点。
2. 次级：`stateKey` 与 `` `${idx}|${key}` `` 字符串拼接在每次访问与 memo 命中（58,328 次）都发生；memo key 指针化/整数化可省常数。
3. 独立验证器无 memo，重走 ∀ 树（110,921 叶 vs 65,585 节点），根级 G1T9 直接撞帽；若需要根级证书，需另设“带独立 memo 的验证器”规则——**这必须先由 ChatGPT 裁定**，不得本轮自行改动。
4. NO_WIN 时分派另一个存在性 witness 搜索是 1.8–5.5 s 的长尾，纯诊断，可按需求开关。

以上均为建议，不构成本轮改动；不接入生产。

## 2. G0 — 身份、计数口径与准入

- HEAD `d533c8f`、分支 `ppc/p1-id-state-identity-fix`；受保护的未提交修改（`src/game/mapDefinition.ts`、`src/pages/EditorPage.tsx`、`src/pages/GamePage.tsx`、D2-PCV-02 三件）原样保留，未覆盖、未回滚、未暂存。
- 冻结依赖：fixture `ppcId01-human-roots.json` SHA256 `1a59787a…`；SEAL 内核 `seal_lib.ts` `453915d3…`；STRATEGY 内核 `lib.ts` `f8cae0ac…`；影子库 `dr_lib.ts` `e0780fff…`。
- 冻结 110 计划集合与 `DUUD` 成员确认（`logs/g0_plan_set.json`）。
- **计数口径严格分离**（`logs/g0_count_separation.json`）：
  - `src/` 源码闭包 = **36**（上一轮工件，drift 0，全部在 `src/`）；
  - 依赖闭包 = **39**（35 个 `src/` + 4 个研究 harness）；
  - “证书绑定文件 37” — **仓库中不存在任何声明 37 的工件**，记为 `THIRD_COUNT_SOURCE_NOT_FOUND`，本轮不使用该数字。
- 准入：可用物理内存 ≥ 1,200 MB、`vitestOutOfTree=0`、无重复 heavy worker；最终三次均 `LOCAL_ADMITTED`。未访问、未停止、未重启 8787/8788。

## 3. G1 — 窗口与标签血缘

完整表格见 [`WINDOW_AND_LABEL_LINEAGE.md`](./WINDOW_AND_LABEL_LINEAGE.md)（机器可读：`logs/g1_lineage.json`、`logs/g1_g1t9_artifact.json`、`logs/g2_g1t9_root_equiv.json`）。

| 系统 | 起点 | startIdx | H | 窗口 | 量词 | 独立验证器 |
|---|---|---|---|---|---|---|
| PCV H0 | post-plan 鼠前沿 | 1 | 1 | 鼠1 | ∃鼠∀CHANCE | 有 |
| PCV H1 | post-plan 鼠前沿 | 1 | 2 | 鼠1+猫2+鼠3 | ∃猫∀鼠∀CHANCE（catSurvive） | 有（独立帽 600k） |
| STRATEGY 根标签 | 猫行棋根 | 0 | 1/2 | H0=猫0+鼠1；H1=再加猫2+鼠3 | ∃鼠∀猫∀CHANCE | **无** |
| SHADOW 两回合 | post-plan 鼠前沿 | 1 | 2 | 鼠1+猫2+鼠3 | ∃鼠∀猫∀CHANCE | **无**（自证） |
| 本轮 oracle | 真实 RuleSet 重建前沿 | 1 | 2 | 同上 | ∃鼠∀猫∀CHANCE | `verifyMouseCertificate` |

裁决：**四个“两鼠回合”系统是同一个问题**（命名 H1/H2 不同）；三个内核切点一致（猫 `idx>=2H` 出窗），终局判定在切点之前。G1T9 定性见 §1.2，状态码 `ROOT_LABEL_SOLVE_CORROBORATED_CERT_UNRESOLVED_AT_CAP`。

## 4. G2 — 独立证明与三组对照

| 计划 | 窗口 | 求解 | 验证器 | 与影子节点数 | 结论 |
|---|---|---|---|---|---|
| **DUUD** | H=2 @idx1 | true / 65,585 | **PROVEN** 110,921 叶 | 完全一致 | `INDEPENDENTLY_VERIFIED` |
| UURR（正对照） | 同窗 | true / 78,839 | **PROVEN** 118,305 叶 | 完全一致 | 同一仪器、同一窗口复现 |
| DRRR（负对照） | 同窗 | **NO_WIN** / 3,513 | 无证书 | 完全一致 | `NO_WIN` 不外推为猫生存 |
| DRRR 对偶问题 | 同窗，另问 | `catSurvivesSeal` true / 92,963 | `verifyCatCertificate` **PROVEN** 117,382 叶 | — | 单独标记 `DUAL_QUESTION_ASKED_SEPARATELY` |
| G1T9 根 | H=2 @idx0 | true / 229,158 | `UNRESOLVED` @600,001 叶 | 非同一轨迹 | 只做同结论复现 |
| G1T9-LLLD 计划 | H=2 @idx1 | true / 24,075 | **PROVEN** 24,999 叶 | 与上一轮一致 | 计划级证书有效 |

影子工具在 DUUD 上的 `nodes` 与 SEAL 独立实现逐位一致（65,585），构成“影子复现”层；`INDEPENDENTLY_VERIFIED` 只由 SEAL 求解 + 独立验证器两层共同给出。`SHADOW_REPRODUCED` 与 `INDEPENDENTLY_VERIFIED` 在工件中分字段记录，互不冒用。

## 5. G4 — 成本消融（同一输入，`witnessOnly` 只加不删）

`WITNESS_COST_ABLATION.json`（rep3 数值；跨三次范围见括号）：

| 层 | 内容 | 节点 | 时间 | 峰值 RSS |
|---|---|---|---|---|
| L0 | 廉价 H1 检查（cap 5,000） | 118 | 8–20 ms | 110 MB |
| L1 | 主证明 solve | 65,585 | 2,121 ms（2.0–5.8 s） | 282 MB |
| L2 | L1 + 独立证书 | 65,585 | 4,428 ms（4.4–12.9 s） | 324 MB |
| L3 | L2 + witness 行 | 65,585 | +30 ms（28–90 ms） | 324 MB |
| D1 | 静态可达诊断 | 19,612 | 573 ms（0.57–1.70 s） | 334 MB |
| D2 | DRRR 的 NO_WIN + 存在性 witness | 3,513 | 1,946 ms（1.8–6.0 s） | — |

四个问题的回答：

1. **可选诊断还是核心成本？** witness 行、静态可达、存在性 witness 搜索均为可选诊断；主证明 = L1，证书 = L2，二者都不读诊断结果。
2. **PROVEN/NO_WIN/UNKNOWN 是否逐字节一致？** 是，`verdictsByteIdentical: true`；L1 与 L2 的证明字段逐字节相同（证书不改变证明）。
3. **是否仍远高于 100 ms？** 是（`costStillAbove100ms: true`）；最便宜 H1 检查 118 节点可到 100 ms 以下，但它**看不到**两回合胜利，不能用它冒充 H2 成本。
4. **具体重复热点？** 见 §1.4（动作生成 > stateKey 字符串 > 无 memo 验证器 > NO_WIN 存在性搜索）。

## 6. G3 — 量词反例与隔离机制

### 6.1 已观测（`QUANTIFIER_COUNTEREXAMPLES.json`、`logs/g3_*.json`）

- 40,000 状态扫描：632 个“所有结果都存活”的 CHANCE 节点；混合 live 节点中每个正概率 outcome 状态不同，求解器必须逐个继续。
- 拾取 CHANCE：22 个正概率结果、权重和 1、父节点 H1=false；只用一条分支构造的证书被验证器拒绝（`POLICY_MISSING`），证明“单分支不足以认证”。
- 截断：cap=10 → `truncated=true / UNKNOWN`；先求值后加密（cap=200 验证器帽）→ `UNRESOLVED / NODE_CAP` → 最终 `UNKNOWN`。真布尔不会因验证失败升级为 PROVEN。
- 同 stateKey 不同窗口：H1 false（118 节点）vs H2 true（65,585 节点）；两内核 memo key 均为 `idx|stateKey`，窗口上下文不会被 memo 吃掉。
- NO_WIN 不自动升级：DRRR 的 `mouseForce=false` 与单独的 `catSurvive=true` 分属两个量词、两份证书。

### 6.2 隔离机制测试（`probe/g3b_rule_isolation.test.ts`，11/11 通过，`logs/g3_rule_isolation.json`）

真实 RuleSet 驱动、真实 G6T2 地形（仅棋子/黄油/陷阱位置为测试设定）：

1. 黄油拾取：`mouseHasButter` 翻转、黄油离场、消耗 1 步；
2. 技能消耗（+3）：`mouseSkillExtraMoves=3`，黄油移除、技能激活；
3. 携带黄油不能进传送通道（原地不动、步数不变）；
4. 技能态（无黄油）可进通道 → `choosing_tunnel_exit`；
5. 技能态无黄油进入鼠洞**不获胜**（phase 仍 playing）；
6. 猫放陷阱**零步数消耗**（GAMEPLAY §4.3）；
7. 正常换手：鼠最后一步 → 猫获得 `catBaseMoves=4`、技能复位；
8. 幽灵公告：均匀 outcome、每个 +1 待生成；无合法候选 → 债务 +1；
9. 幽灵边界：可实体化 / 阻塞一次保留 `blockedMaterializations=1` / 第二次阻塞触发 reroll；
10. 无合法候选时放置债务**一对一保留**（不丢弃、不缩水）；
11. 写出隔离日志。

### 6.3 不可观测缺口（如实披露，未伪造）

- **零权重 CHANCE 分支**：40k 状态扫描 `zeroWeightOutcomesSeen=0`；规则内核按源过滤 `weight<=0`，但可达状态中未出现实例 → `NOT_OBSERVED`。
- **同节点混合终局**（一分支鼠胜、一分支猫胜）：`mixedTerminalChanceNodes=0` → `NOT_OBSERVED`；未构造合成状态冒充。
- **同节点混合判定**（正概率 outcome 的 H1 判定一真一假）：22 结果拾取节点全部同判 → `NOT_OBSERVED`；AND 语义改由“拒绝单分支证书”实测覆盖。

这三项不影响主证明（DUUD 的 53,766 个正概率 outcome 全部被独立验证器逐个复核），但按委托标准必须单列，不能算作“测试通过”。

## 7. G5 — 确定性与工件

- 三次严格串行、各自全新 vitest 进程（`logs/det_r{1,2,3}.log`，`logs/rep{1,2,3}/`）。
- **语义摘要**（状态身份、全部正概率 CHANCE、量词判定、终局、截断、确定性节点数、证书结构）三次一致：`a1812b9daa81f350c93ba9c89ec7ef41479711241775081cc3f0063169fb8c5c`，`DETERMINISTIC`，0 个漂移文件。
- **性能摘要**（wall time、RSS、主机、可用内存、`withinCheapBudget` 等 43 个键）单独记录、绝不混入语义摘要；同主机三次间有约 3× 的耗时波动，已在 §1.3 如实标注。
- 过程披露：本轮在定稿前做过两次整批重跑——第一次修正 `g2_g1t9_root_equiv.json` 中一句与自身字段矛盾的旧文案；第二次新增 §6.2 的 11 项隔离测试。最终台账只覆盖最终工件；被覆盖的旧批次工件不再保留，其数值不进入任何结论。

## 8. 证明身份清单

| 身份 | 值 |
|---|---|
| 语义摘要 | `a1812b9daa81f350c93ba9c89ec7ef41479711241775081cc3f0063169fb8c5c` |
| fixture | `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09` |
| SEAL 内核 | `453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b` |
| STRATEGY 内核 | `f8cae0ac4fca93330d170fa3fe2e072729b402fc18442016ce069f80f8ee0264` |
| 影子库 | `e0780fff270f45e17c32406261e51f55480feb4824af4112a902353bf6e7a654` |
| DUUD 前沿 stateKey | `ef77515c37252c64cbc6c36e42505807f13874ac0546c8c5a72b035a3fc15729` |
| DUUD witness 行 | `ee30620024e15ba0dd365ffb60f79d43db769372db97223e1ded1157f56542ee` |
| UURR 前沿 | `959fc4c3d5f106f51c8da314d682cbcc8fb60c5e4b923fa30d8b6202eedb80f3` |
| DRRR 前沿 | `efb0dab60e54a7dfaaefd3f2327d2fcc094b5a1149721f923a30d67bcbc3f263` |
| G1T9-LLLD 前沿 | `4edbffca89ce26392861a3812ca67899d6256816203a6caa4ec7e63418ea6b6e` |

工件逐文件 SHA256 与字节数见 `SOURCE_MANIFEST.json` 与三列 `SHA256SUMS.txt`（哈希、字节数、路径），可用 `scripts/verify_ledger.sh` 全量复算（结果 37/37）。

> 口径提醒：台账 37 行 = 36 个工件 + 清单自身，与 §2 的“证书绑定文件 37”**无关**；后者仍为 `THIRD_COUNT_SOURCE_NOT_FOUND`，任何场合都不得用台账行数冒充该口径。

## 9. 资源与安全记录

摘要（全文见 [`RESOURCE_SAFETY_LOG.md`](./RESOURCE_SAFETY_LOG.md)）：

- 16,087.8 MB 物理内存；每轮准入可用内存 2,517–3,904 MB，`LOCAL_ADMITTED`，重复 heavy worker = 0。
- 严格串行、每次全新进程；峰值 RSS 268–334 MB，无 V8 heap 扩大。
- 未接触云端 8787/8788；未执行 full-grid、self-play、排序器调权、实时 H2 接线、跨根/跨前沿证书移植。
- 时间/环境字段只进性能摘要。

## 10. 限制与未决（交给 ChatGPT 的 OPEN 项）

1. **G1T9 根级证书**在冻结 600k 叶帽下 `UNRESOLVED / NODE_CAP`；未降帽。是否允许一个“带独立 memo 的验证器”用于根窗口证书，需裁定。
2. §6.3 三项 `NOT_OBSERVED`：零权重分支、混合终局 CHANCE、混合判定 CHANCE。
3. 性能在同主机不同进程间有约 3× 波动（2.1–6.3 s solve）；任何“6 秒”结论只能按比例陈述，不能当作固定常数。
4. 所有证明都限定在各自前沿的两个鼠回合窗口内；不得跨 root/frontier 复用。

## 11. 下一轮建议（仅建议，未执行）

- **A（低风险）**：`generatePreparedSearchActions` 按 `stateKey` 的节点级缓存，预期直接削减 solve 的主导项；量词、帽、窗口全部不动。
- **B（取证向）**：为根窗口引入独立实现的带 memo 验证器（与 solver 不共享），解决 G1T9 根证书帽问题；需要规则裁定。
- **C（产品向）**：若影子工具要进生产，默认关闭存在性 witness 与静态可达诊断，只保留 solve + witness 行（毫秒级）。

## 12. 复现命令（在仓库根执行）

```bash
# 全部判定性测试（单进程）
npx vitest run --config PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/vitest.config.mts

# 一次完整串行重复（写入 logs/det_rN.log、logs/repN/）
bash PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/scripts/run_round.sh 1

# 三次语义摘要比对
node PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/scripts/summary.mjs

# 台账生成与复算
node PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/scripts/manifest.mjs
bash PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/scripts/verify_ledger.sh
```

## 13. 交付清单

`REPORT.md`、`WINDOW_AND_LABEL_LINEAGE.md`、`DUUD_INDEPENDENT_PROOF.json`、`INDEPENDENT_VERIFIER_RESULT.json`、`QUANTIFIER_COUNTEREXAMPLES.json`、`WITNESS_COST_ABLATION.json`、`SOURCE_MANIFEST.json`、`RESOURCE_SAFETY_LOG.md`、`SHA256SUMS.txt`、`logs/`（g0–g3 工件、`digest.json`、`determinism_summary.json`、`det_r{1,2,3}.log`、`rep{1,2,3}/`）、`probe/`（harness 与 6 个测试文件）、`scripts/`（`run_round.sh`、`summary.mjs`、`manifest.mjs`、`verify_ledger.sh`、`host_probe.ps1`）。

---

**本轮结束，停止，交由 ChatGPT 审核。未进入生产接线。**
