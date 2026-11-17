# 未关闭的门与遗留缺口

**Round:** PPC-P1-CLOSURE-FIX-01
**说明:** 本文件只登记，不在本轮修复。

---

## 1. 仍然 BLOCKED 的正式门

### 1.1 `ABSOLUTE_DEADLINE_GATE = BLOCKED`

- **缺什么:** 一份"原始绝对 deadline 门槛清单"（`must_freeze_before_execution` 里的 *original absolute deadline gate manifest*）。
- **为什么本轮不能解:** 解它需要一次预注册的正式 timing 实验，本轮明确禁止（不跑正式 timing benchmark）。
- **现状:** `MAIN_SEARCH_SEMANTIC_BUDGET = 100ms`、`TOTAL_TURN_HARD_WALL = 150ms` 两个常量本轮**未改动**；也没有宣称 150ms 整回合合同已合规。
- **影响:** 不阻塞"建立本地 checkpoint"，阻塞的是"宣称时限合同 PASS"。

### 1.2 `NEW_EFFICACY_AUTHORITY = NONE`

本轮 0 生产搜索逻辑改动（改的是输入校验与失败关闭门），没有新的棋力证据，也**不宣称**棋力提升。P1-TIME-02 的时间对照仍为 `DIAGNOSTIC_ONLY`。

---

## 2. NOT_PERFORMED（明确未执行，不得写成 PASS）

| 项 | 原因 |
|---|---|
| 982 项全量回归（1713s 套件）| 任务书第七节明令禁止 |
| 3400-job primary / self-play / exhaustive oracle / METHOD_A | 同上 |
| 正式 timing benchmark / efficacy A/B | 同上 |
| `hv2PlanTieQuality` / `m3liteHumanValidationLogging` 复跑 | 本轮未改其被测路径；历史通过记录来自 P1-QUALITY-01 |

⇒ 因此 `CF-15 = PASS_WITH_DECLARED_SCOPE`，范围 = 8 文件 / 128 项 + `tsc` + `vite build`。

---

## 3. 代码层面已登记、未修的缺口

### 3.1 `mouseBaseMoves` 没有同类校验

本轮授权范围只到**猫**预算。鼠基础步数若为小数/NaN，会走 `mouseMovesLeft` 的同一类路径。它不影响猫计划上界推导（`M` 只来自 `catMovesLeft`），且鼠 AI 处于 PAUSED，所以本轮不扩范围。**登记为独立后续项。**

### 3.2 `PLAN_ACTION_BOUND_PROOF.md §3` 的定义域表述

证明文档仍写 "a free integer"，未限定**非负整数**、未讨论小数 `catMovesLeft`。

本轮在**代码**里把定义域写清楚了（`planBound.ts` 的 `hasCertifiableCatMoveBudget`，且 `catTurnMoveBudget` 不再 floor 猜测），但**证明文档本身未改**（属冻结文档，改它需要授权）。

### 3.3 `catAiMove(state)` 省略身份时仍自铸窗口

生产唯一入口 `GamePage.tsx` 已传身份；`catAiMove(state)` 这种单参数调用仍会 mint 自己的窗口。这是 P1-TIME-01 的既有设计（"独立一次调用"就是拥有整回合），本轮不改。

### 3.4 HV14 语料不再是完全可复现基线

`HV14_EXACT_REPRODUCTION = 44/45`。后续任何引用 HV14 根值的结论（CAT-STRATEGY-01 G 系列、M3-lite 记忆对照）**必须显式扣除 GAME3 T4**，否则会把"引擎变强"误读成"回归"。本轮已把这条写进测试常量、`HV14_REPRODUCTION_GAP.json` 与测试注释。

---

## 4. 工程层面新暴露的风险（本轮发现，未修）

### 4.1 工作树行尾不一致（真实、可复现）

| 文件 | 行尾 |
|---|---|
| `src/game/engine.ts` | **CRLF** |
| `src/game/ai/__tests__/expectiminimax.test.ts` | **CRLF** |
| 其余被触碰的文件（config / planBound / planQuality / expectiminimax / transposition / deadlineContext / hardTurnPlanner / 新测试）| LF |

`core.autocrlf = true`，所以 `git diff` 输出 LF 归一的补丁。后果：

- 用 `git diff` 补丁恢复 CRLF 文件，只能得到 **内容相同、字节不同** 的结果；
- 任何跨工具/跨机器的 sha256 比对都必须先声明行尾约定，否则会出现"假分歧"（本轮就遇到：`engine.ts` 的 pre-fix 在 LF 下是 `a750f860`，在 CRLF 下才是 `dbb5377a`）。

**没有修改任何行尾**（改行尾会让全部历史指纹失效）。已在 `CHECKPOINT_MANIFEST.json → preFixSnapshot.lineEndingCaveat` 中完整登记。

### 4.2 `git apply` 在本仓库拒绝这些补丁路径

同样的 `tracked.diff.bin`，`git apply` 输出 10 行 `Skipped patch '…'` 并 exit 0（**静默什么都没做**），`patch -p1` 才正常应用。

→ **这是个陷阱**：如果只看退出码，会误以为恢复成功。恢复流程必须用 `git hash-object` 或 sha256 复核，不能只看 exit code。

### 4.3 重用例的墙钟仍在漂移

`hv14FiveGameForensics` 本轮耗时 **5 分 31 秒**（16 项），`T1E-B A/B/K` 在 17.2s–43.4s 之间波动。前者没有单测级超时，未来若机器再慢一档，可能撞上默认 30s 单测上限。

**登记为吞吐敏感风险，本轮未给 `hv14FiveGameForensics` 加预算**（不在授权范围内，且它当前能过）。

---

## 5. 结论

阻塞**建立本地 checkpoint** 的项：**无**（技术层面）。
阻塞**合并**的项：**无**（但需先决定 §6 的两条）。

需由裁决方决定的两条：

1. **GAME3 T4 历史黄金值**：本轮已按"登记例外 + 真实引擎证明"处理，未改历史日志。若裁决方认为语料应整体换个形态保存，那是下一轮的事。
2. **T1E-B 的 120s 预算**：本轮已加。若裁决方要求回到全局 30s，则该用例在本机的通过与否将取决于机器负载（同日实测跨 17.2–43.4s）。

`ABSOLUTE_DEADLINE_GATE` 仍 `BLOCKED`，属"可留到独立后续阶段"的项。
