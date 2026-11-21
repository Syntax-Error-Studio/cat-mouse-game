# PPC-G6T2-DECISION-RISK-CAUSAL-01 — 报告

猫 AI 决策失误因果定位 + 轻量战术风险影子原型
Round 状态：分析完成，**未接生产**，等待 ChatGPT 裁定
`COMMIT=NO / PUSH=NO / MERGE=NO / PRODUCTION_WIRING=NO / STOP_FOR_CHATGPT_REVIEW=TRUE`

---

## 一、先回答三个问题（白话）

### 1. 猫究竟为什么选错？

G6T2 上猫走 `UURR`（已冻结证明：鼠强制胜），100ms 生产搜索是这样走到这一步的：

- 100ms 只够完成**深度 1**（deadline 触发，`completedDepth=1`，`hasSolution=true`，无 fallback）。深度 1 下 E1 给根动作打分：`U = −247.24`、`D = −345`、`L = −345`，于是选 `U`。
- **E1 看不见鼠的胜法**：`UURR` 的鼠胜出现在鼠的第二个动作回合；E1 只看猫的静态局面。
- 就算把深度提到 2，根值变成 `U = D = L = −658.2105…` **逐位精确相等**，稳定合法序仍然保留 `U`。所以"加深度"本身也修不好，缺的是一个"鼠的战术威胁"量。
- 而 E1 评价下更差的 `DRRR`（−854，比被强制的 `DUUD` 差 195.79）**根本不在生产候选池**（池里只有 `UUDD/DUUD/LUDR` 三个主计划），重排候选也无法产生它。

结论：**不是执行 bug，不是历史污染**（P0-02 已裁定 D 层历史依赖是有意设计、执行无 bug）。主因是 **E1 视野盲区**在"100ms 限深"和"精确平局 + 稳定序"这两个放大镜下变成了错误动作。五个候选原因都有各自的作用面：`DRRR` 未生成（原因1）、`R` 步评分低（原因2）、根/节点精确平局导致提取分歧（原因3）、深度看不见鼠胜（原因4）、deadline 限深（原因5，属于限深不是 fallback）。

### 2. 有没有找到能提前识别坏路线的低成本信号？

**没有找到可用的低成本信号。** 具体：

- **层 1（鼠下一回合内判胜，最便宜）**：单计划 1–200 ms，在 G6T2 四条计划 + 三个对照根共 **10 行上全部为 false**。它区分不出坏计划与未证坏计划。
- **层 0（静态可达性启发式）**：`UURR` 在 20k 节点处触顶给 `null`，其余三计划给 `true`，完全不区分；且它是"猫永不移动"的上界，不可作为信号。
- **层 2（两鼠回合量词证明）**：唯一能分开的组合 —— `UURR`、`DUUD` 为 `PROVEN_FORCED_WIN`，`DRRR`、`DRDR` 为 `NO_WIN`。但单计划 1.0–6.9 s，比 100ms 预算高 10–70 倍；且"未发现鼠胜"的裁判成本（存在性见证搜索 5–6 s）比"发现鼠胜"还高。

所以：**能识别的信号存在（而且方向很刺眼，见下），但代价不在 100ms 预算量级。** 值得注意的是：生产 D2 首选的 `DUUD` 家族本身就是鼠强制胜，而 E1 评价差 195.79 的 `DRRR` 反而是未证坏的——E1 的偏好在这里与安全**反相关**。

### 3. 它在其他局面上是否仍有效？

**方向一致，但样本只有 3 个根，不能称"通用有效"。**

- `G1T9`（根级冻结标签 = H1 内鼠强制胜）：生产计划 `LLLD` 与首回合 `UDUD` 都被层 2 判 `PROVEN_FORCED_WIN` —— 方向一致。
- `G1T8`、`G1T4`（根级冻结标签 = H1 内猫存活）：两个计划都是 `NO_WIN_WITHIN_TESTED_HORIZON` —— 不矛盾，但这只是"在本窗口找不到鼠胜"，**不是**安全证明。
- 层 1 在 `G1T9` 上**也不触发**（尽管其根级标签是 H1 鼠强制胜）：根级标签的 H1 定义与本原型"计划接交面之后的两鼠回合"不是同一个窗口，本轮**不做互推**，登记为 `WINDOW_SEMANTICS_OPEN`。

---

## 二、身份与前置复核（G0，PASS）

- HEAD = `d533c8fb1e9c8b1822e84e737253f7ea73d3dbb1`，分支 `ppc/p1-id-state-identity-fix`。
- `src/` 36 个源文件对 G6T2 冻结 `SOURCE_MANIFEST` 逐文件 SHA256 复核：**drift = 0**。
- 既有轮次 ledger 复核：P0-02 65/65、SELECTION-CAUSE 61/61、PLAN-CANDIDATE-FEASIBILITY 48/48、D2-PCV-COUNTERLINE-02 160/160、CANDIDATE-SELECTOR-SCOPING 157/157、CAT-STRATEGY-SEAL 25/25 全通过；`PPC-D2-PCV-COUNTERLINE-01/REPORT.md` 为**先前已提交的已知漂移**（列为 KNOWN_DRIFT，未修复、未改写）。
- 工作区里 `mapDefinition.ts`、`EditorPage.tsx`、`GamePage.tsx` 及 D2-PCV-02 的三个文件是**上一轮已披露的未提交修改**：本轮未覆盖、未回滚、未暂存。
- G6T2 根与冻结证据逐位一致（`stateKey` 前 48 位、快照 SHA、110 条完整猫回合）；无重复 node/vitest 进程。

## 三、缓存契约最终勘误（G1，PASS）

从冻结的 110 条完整猫回合计划重算，**与冻结证据逐位一致**：

- `agree = 67`，`disagree = 43`，43 条**全部**以 CHANCE 结束，差值恒为 `+1`。
- 分布：生产 `{0:36, 1:44, 2:27, 3:3}`，研究 `{0:56, 1:44, 2:10}`；`uniqueProgress` 差值 `{0:43, 1:67}`。
- **最终猫动作包含性**：生产包含 110/110，研究排除 110/110，`生产单元格 = 研究单元格 + 最终单元格` 110/110。67/43 的差别就是"最终交接单元格是新格子还是重复格子"。
- **作用域勘误**：`revisitCount` / `uniqueProgress` 必须绑定 (根, 完整动作路径, 规则集)；`reversalCount` 只依赖动作序列；`boxesMovedVsRoot` / `distanceDelta` 至少需要 (根, 末端)；`frontierCount` / `endKind` 取决于实际转移类型而非末端键。**"endStateKey 相同即可复用"不成立。**
- **独立登记 `CHANCE_ENDPOINT_SEMANTICS`**：生产要求全部正概率 outcome 一致 + 加权期望；研究读 `outcomes[0]`。本轮语料每条计划只有 1 个正概率 outcome，所以没有观测到数值分歧，但两份实现的读法差异是独立问题，规则定为"末端一律遍历全部正概率 outcome"。

详见 `CACHE_CONTRACT_FINAL_ERRATA.md`。

## 四、G6T2 因果链（G2，PASS）

- 本机 3 次全新进程 100ms 复跑：**全部 `UURR`，`completedDepth=1`，`deadlineFired=true`，`hasSolution=true`，无 fallback**；节点数 201–250 有波动（timing），但动作与深度稳定。冻结证据同协议（`UURR`、深度1、deadline）。
- 冻结 D2 反事实：根值 `U=D=L=−658.2105…` 精确平局 → 稳定序保留 `U`；`DR` 节点 `L=−658.21 > R=−745.45`；`DRR` 节点 `L=−745.45 > R=−854 > D=−900.71` → 主计划始终沿 `U`/`L` 走；`DRRR` 与强制 `DUUD` 的差为 `−195.78947368421018`。
- 决策链（实际）：根 → 深度1（deadline）→ E1 根分 → 主计划 `UURR` → 执行 `UURR` → 鼠技能 + 6 步 → 猫 `RDDD` → 鼠入洞。
- 五因逐项有证据（见 `G6T2_DECISION_CAUSAL_TRACE.json`），其中原因 5 的类型是 **DEADLINE_LIMITED_DEPTH**，不是 fallback、不是非法动作。
- 裁定：`E1_HORIZON_BLINDNESS_EXPRESSED_AS_TIE_AND_TIE_BREAK`；`TACTICAL_THREAT_NOT_REPRESENTED`；历史污染作为主假设被排除。**未**重新执行百万节点 D2，也未重跑 H2/600000。

## 五、影子原型与校准（G3，PASS）

原型 `TURN_AWARE_MOUSE_GOAL_RISK`（`probe/dr_lib.ts`，`wiredToDecision=false`），规格见 `TURN_AWARE_MOUSE_GOAL_RISK_SPEC.md`。

| 计划 | E1 末值 | 层1（鼠单回合） | 层2（两鼠回合） | 层2 节点 | 冻结标签 | 一致？ |
|---|---|---|---|---|---|---|
| UURR | −247.2368 | false | **PROVEN_FORCED_WIN** | 78 839 | 鼠强制胜 | 是 |
| DRRR | −917.2368 | false | NO_WIN_WITHIN_TESTED_HORIZON | 3 513 | H2 猫存活（window=2, cap=600000） | 是 |
| DUUD | −561.8421 | false | **PROVEN_FORCED_WIN** | 65 585 | 无证书 | — |
| DRDR | −1 027.1053 | false | NO_WIN_WITHIN_TESTED_HORIZON | 6 369 | 无证书 | — |

- `UURR` 见证：`m:S, m:D(chance), m:D×5, c:U, c:D, c:U, c:D, m:R, m:D, m:R`（14 步）；`DUUD` 同为 14 步（猫 `U,U,U,D` 应答）。
- `DUUD` 被证为鼠强制胜是**本轮最重要的负面发现**：生产在深度2下首选的就是 `DUUD` 家族。
- 层1 在四计划全部 false（鼠一回合内赢不了，胜法需要猫应答）；层0 静态启发式不区分（UURR 触顶 null，其余 true）。
- 忠实性约束：单条随机分支不升级为确定；`NO_WIN` 不升级为安全；存在性见证（`witnessOnly`）全为 null，未发现"某条猫应答下鼠能赢"的反例线。

## 六、跨根结构对照（G4，PASS，样本 3 根）

| 根 | 根级冻结标签（PPC-CAT-STRATEGY-01，H1 窗口） | 计划 | 层2 | 层2 一致性 |
|---|---|---|---|---|
| G1T9 | MOUSE_FORCED_WIN_WITHIN_H1 | LLLD / UDUD | PROVEN / PROVEN | 方向一致（根已输，工具同样发火） |
| G1T8 | CAT_SURVIVAL_CERTIFIED_WITHIN_H1 | LDRL / UUDU | NO_WIN / NO_WIN | 不矛盾（H1 窗口短于本工具窗口，不能互推） |
| G1T4 | CAT_SURVIVAL_CERTIFIED_WITHIN_H1 | LLLL / UDUD | NO_WIN / NO_WIN | 同上 |

- 根级标签**只作结构对照**，标注了来源、窗口（猫回合+鼠回合）与"不能移植到逐计划判定"；`safeClaim` 恒为 `null`。
- 开放问题 `WINDOW_SEMANTICS_OPEN`：`G1T9` 根级是 H1 鼠强制胜，但层1 在其计划接交面上为 false（鼠需要猫应答后才能赢）。两个窗口定义不同，本轮不互推、也不据此修改任一侧。

## 七、成本与测量来源（G5，PASS）

- 本机 Windows 工作站（win32 x64, i7-14650HX, Node v24.13.0, 16 GB）。**不是云端；这些数字不能证明可塞进 Windows 100ms 预算。**
- 10 条计划总风险计算 61 967 ms；层2 单计划最大 6 944 ms；峰值 RSS 393.9 MB；无截断层2、无截断层1；UURR 的层0 触顶表现为 `null`。
- 无共享搜索状态：根枚举每根一次；计划间无共享记忆；无新增跨搜索/跨回合全局 TT。
- 并发 = 1；三次重复严格串行。

## 八、三次全新进程确定性（PASS）

`scripts/determinism.sh 3`：每轮依次启动 **3 个全新 vitest 进程**（G1/G3/G4），轮内、轮间均不重叠；每轮后对三份产物做归一化摘要（剔除墙钟/节点数/RSS/`generatedAt` 等易变字段，G2 的 100ms 实跑记录折叠为"计划+深度"语义）。

```
round 1: 5ceafd4c811a2e10a431feeaa3ef9510e58c22df8791b93c8ecf332511734233
round 2: 5ceafd4c811a2e10a431feeaa3ef9510e58c22df8791b93c8ecf332511734233
round 3: 5ceafd4c811a2e10a431feeaa3ef9510e58c22df8791b93c8ecf332511734233
verdict: DETERMINISTIC
```

（首次尝试曾读到 DRIFT，诊断后确认是摘要过滤器漏了 `enumerationMs` 这个键名，不是计算漂移；修正过滤器后三次一致，过程全部保留在 `logs/snap_r*/` 与 `logs/digest_r*.json`。）

---

## 九、PASS / FAIL 逐项

| 项 | 结果 | 依据 |
|---|---|---|
| G0 身份 / 来源 / 资源门 | **PASS** | src drift 0；ledger 全通过（1 条已知旧漂移披露）；无重复进程 |
| G1 缓存契约最终勘误 | **PASS** | 67/43 逐位复现；包含性 110/0/110；CHANCE 端点独立登记 |
| G2 因果链 | **PASS** | 3 次本机实测 + 冻结 D2 证据；五因分型；无 fallback；无百万节点重跑 |
| G3 影子原型校准 | **PASS** | UURR=PROVEN、DRRR=NO_WIN 与冻结标签一致；DUUD 反例发现 |
| G4 跨根区分 | **PASS（样本 3 根）** | 方向一致；根级标签窗口差异如实标注；无安全外推 |
| G5 成本 / 来源 / 3 次确定性 | **PASS** | 3/3 归一化摘要一致；成本与来源如实记录 |
| **"低成本可提前识别信号"** | **FAIL（未找到）** | 层1 全 false，层0 不区分，层2 超预算 10–70 倍 |
| 生产接线 | **未做（按约束）** | `PRODUCTION_WIRING=NO` |

## 十、约束执行情况

- 未修改 `GAMEPLAY.md`、`src/`、SearchMath、E1、H0/H1、PCV、`stateKey`；未改任何预算；未新增全局 TT。
- 未重跑 H2/600000、未重跑百万节点 D2、未做 full-grid / 自对弈 / 多特征调权。
- 未跨根移植 H0/H1 证书；未硬编码 G6T2 坐标/方向作为策略（`UURR/DRRR/DUUD/DRDR` 只作为**证据对象**的计划标签出现在测试常量与报告中）。
- 未通过修改 Guard/门槛让任何测试通过。
- 上一轮披露的 `mapDefinition.ts`、`EditorPage.tsx`、`GamePage.tsx` 未提交改动保持原样。

## 十一、待 ChatGPT 裁定 / 下一步（不自行启动）

1. `DUUD` 被证鼠强制胜、而生产 D2 首选 `DUUD` 家族 —— 这是比单局选错更系统的风险点，是否作为下一轮独立课题。
2. `WINDOW_SEMANTICS_OPEN`：根级 H1 标签与本工具两鼠回合窗口的对应关系。
3. 层2 成本（1–7 s/计划）决定它只能离线/影子运行；是否接受"离线审计 + 生产保持 100ms"的分工。
4. 是否有必要把"末端必须遍历全部正概率 outcome"写入研究侧契约（`CHANCE_ENDPOINT_SEMANTICS`）。

**STOP_FOR_CHATGPT_REVIEW = TRUE**