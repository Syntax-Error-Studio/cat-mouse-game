# PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01

**状态**: 完成，停止，等待 ChatGPT 最终架构裁决。

- **HEAD**: `48eaac6c4f3801d351787696ba5876995b64e8d8`
- **冻结 fixture**: `src/game/ai/__tests__/fixtures/ppcId01-human-roots.json`
- **fixture SHA-256**: `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`
- **执行**: `npx vitest run --config PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01/probe/vitest.config.mts`，单 worker，串行，退出码 0，2/2 tests passed，总耗时 2.58s。
- **范围**: 只读复核 P3/P4/P5/P7 工件；修正 P7 派生指标；对 6 个未被 P4 证书覆盖的实际 100ms 计划补证；复用身份完全一致的 P4 H1/G1T3/RRRR 证书。未修改生产源码/规则/搜索数学/H1/100ms-150ms；未重跑完整 24 根、P5/P6 或 self-play；未 commit/push/merge。

---

## 0. 结论摘要

1. **P7 指标错误已确认并修正**。P7 将 D1 `bestAction` 与 100ms 实际执行的 `finalPlan[0]` 直接比较；正确对象应是 D1 可执行计划 `catTurnPlan[0]`。逐根重算后：
   - E1：D1→100ms 首步复现 **23/24**（P7 原报 22/24）；
   - H1：D1→100ms 首步复现 **22/24**（与 P7 相同）；
   - 100ms 两臂首步改变仅 **3 根**：`G6T1`、`G5T1`、`G1T3`；
   - `G5T1/E1` 是明确反例：`bestAction=U`，D1 可执行计划 `DLUTR`，100ms 实际计划 `DLUTR`；P7 的 `U != D` 是把 `bestAction` 当成计划，正确比较是 `D == D`，已复现。
2. **G1T3/E1/UUUL 的独立量词结论不是鼠强制胜**，而是
   **`CAT_SURVIVAL_CERTIFIED_WITHIN_H1` / `PROVEN`**。
   - `h0MouseForcedWin=false`，`h1MouseForcedWin=false`；
   - `h1CatSurvive=true`（独立 verifier：0 failures，470 leaves，115 branches，无截断）；
   - `h1CatForcedWin=false`。
3. **H1/G1T3/RRRR**：P4 证书与本轮 fixture 身份、计划、post-state、证书 ID 全部一致，复用 P4 的
   **`CAT_SURVIVAL_CERTIFIED_WITHIN_H1` / `PROVEN`** 证据。
4. 因此 **`PROVEN_100MS_TACTICAL_GAIN = FALSE`**。
   E1 并非鼠强制胜；E1 与 H1 的实际 100ms 计划都在 H1 内被证明猫可存活。按预先登记判据，H1 没有产生“可证明的 100ms 战术收益”。这不表示 H1 更差，只表示没有满足强判据的收益证据。
5. 生产接线**未获授权**。性能仍须服从既有 A/A 校准门；本轮没有做任何性能认证。

---

## 1. 三个量的严格区分

| 量 | 来源 | 语义 |
|---|---|---|
| `bestAction` | `searchBestAction` 返回值 | 固定深度根比较选出的根动作 |
| `catTurnPlan[0]`（D1 可执行计划首步） | `planHardCatTurn.plan` / `search.catTurnPlan` | 实际可执行计划的首步；`plan` 可能被 `extractBestCatTurnPlan` 的等值主变提取替换，所以 `plan[0]` 可以与 `bestAction` 不同而等值 |
| 100ms 实际 `finalPlan[0]` | P5 `PRODUCTION_100MS_RESULTS.json` 的 `finalPlan` | 生产路径（含 sidecar/guard 后）真正执行的计划首步；P5 全部 240 行都满足 `executed.label.startsWith(finalPlan)` |

P7 的错误在于拿第 1 个量与第 3 个量比较；正确比较是第 2 个量与第 3 个量。`hardTurnPlanner.ts` 的
`plan` 与 `bestAction` 是两个独立字段；`expectiminimax.ts:2019-2023` 在 `mate===null` 且等值主变图非空时用
`extractBestCatTurnPlan` 替换 `catTurnPlan`，这正是 `plan[0] != bestAction` 而价值相等的来源。

### 1.1 G5T1/E1 明确反例（逐根重算得到，未硬编码）

```text
P4 bestAction        = U
P4 可执行计划        = DLUTR
P5 实际 100ms 计划   = DLUTR
P7 原比较            = U != D  -> 错误标记“未复现”
正确比较             = D == D  -> 已复现
```

P7 的 `unreproducedE1=[G5T1, G1T3]` 因此应修正为 `[G1T3]`；H1 仍为 `[G2T6, G1T4]`。

---

## 2. 24 根逐根重算结果

全部数值由 `_raw/erratum_metrics.json` 逐行重算，未使用硬编码预期值。`CORRECTED_ROOT_TABLE.csv` 给出每根明细。

### 2.1 计数

| 指标 | P7 原值 | 修正值 | 说明 |
|---|---:|---:|---|
| `bestAction` 改变根数 | 5 | **5** | `G6T1, G5T1, G2T6, G1T3, G1T4` |
| D1 可执行计划首步改变根数 | — | **5** | 恰好同一组 5 根，但这是不同量 |
| 100ms 可执行计划首步改变根数 | — | **3** | `G6T1, G5T1, G1T3` |
| E1 D1→100ms 首步复现 | 22/24 | **23/24** | 唯一未复现：`G1T3` |
| H1 D1→100ms 首步复现 | 22/24 | **22/24** | 未复现：`G2T6, G1T4` |
| E1 D1→100ms 全计划复现 | — | **21/24** | 未复现：`G5T3, G2T2, G1T3` |
| H1 D1→100ms 全计划复现 | — | **21/24** | 未复现：`G2T2, G2T6, G1T4` |
| D1 两臂全计划改变根数 | 10 | **10** | `G6T1, G5T1, G5T4, G2T6, G1T3, G1T4, G1T6, G1T7, G1T8, G1T9` |
| 100ms 两臂全计划改变根数 | — | **10** | `G6T1, G5T1, G5T3, G5T4, G2T2, G1T3, G1T6, G1T7, G1T8, G1T9` |

> 注意两个不同概念：
> - “D1→100ms 复现”是**同臂**的时间比较（21/24, 21/24）；
> - “两臂全计划改变”是**同一时刻 E1 vs H1** 的横比（D1 10 根，100ms 10 根，即 100ms 下 14/24 根全计划一致）。
> 二者不能混为一谈。

### 2.2 关键根明细

| root | E1 best | H1 best | E1 D1 计划 | H1 D1 计划 | E1 100ms | H1 100ms | E1 首步复现 | H1 首步复现 |
|---|---|---|---|---|---|---|---|---|
| G6T1 | U | T | UTRDL | TDRRD | UTRDL | TDRRD | 是 | 是 |
| G5T1 | U | T | DLUTR | TRRDD | DLUTR | TRRDD | 是（P7 误报） | 是 |
| G5T3 | L | L | LDDD | LDDD | LLDR | LDDD | 是（首步 L） | 是 |
| G2T2 | D | D | DDDR | DDDR | DLUL | DDDD | 是（首步 D） | 是 |
| G2T6 | L | D | LUUU | RURD | LUUU | LUUU | 是 | **否**（L vs R） |
| G1T3 | D | R | DRRR | RRRR | UUUL | RRRR | **否**（U vs D） | 是 |
| G1T4 | L | U | LLLL | ULDR | LLLL | LLLL | 是 | **否**（L vs U） |

`G5T3` 与 `G2T2` 的首步复现但全计划不复现，说明 100ms 的等值计划提取可能改变后续路径；`G2T6` 与
`G1T4` 则在 D1 两臂不同、100ms 两臂收敛。首步复现率不能替代全计划一致性。

### 2.3 P7 前后差异

| 项目 | P7 | 修正后 |
|---|---|---|
| E1 D1→100ms 复现 | 22/24 | **23/24**（+1，G5T1 修正为复现） |
| H1 D1→100ms 复现 | 22/24 | **22/24**（不变） |
| E1 未复现根 | G5T1, G1T3 | **G1T3** |
| H1 未复现根 | G2T6, G1T4 | **G2T6, G1T4** |
| bestAction 改变 | 5 | 5 |
| 全计划改变（D1） | 10 | 10 |
| 100ms 首步改变根 | — | **3**（G6T1, G5T1, G1T3） |

P7 的 `unresolvedCombos=2`（根 `G1T5` 两臂）保持不变；`G1T8` 仍为
`CHANCE_DEPENDENT_OUTCOME / REFUTED_BOTH_FORCE`。本轮没有改写这些 P4 结论。

---

## 3. 48 组合的“实际计划 ↔ 证书计划”映射

### 3.1 修正前覆盖

P4 证书计划与 P5 实际 100ms 计划逐字比较（真实规则回放，无搜索）：

- 覆盖：**42/48**
- 未覆盖：**6/48**

| root/arm | P4 证书计划 | 实际 100ms 计划 | 说明 |
|---|---|---|---|
| G5T3/E1 | LDDD | LLDR | 计划不同 |
| G2T2/E1 | DDDR | DLUL | 计划不同 |
| G2T2/H1 | DDDR | DDDD | 计划不同 |
| G2T6/H1 | RURD | LUUU | 计划不同 |
| G1T3/E1 | DRRR | UUUL | 计划不同 |
| G1T4/H1 | ULDR | LLLL | 计划不同 |

### 3.2 修正后覆盖

对上述 6 个实际计划分别建立证书；其中 H1/G1T3/RRRR 因与 P4 证书身份完全一致而复用，其余 5 个独立补证。
加上原有的 42 个，**48/48 组合的实际计划均被证书绑定**。

| root/arm | 实际计划 | 类别 | 证明 | 来源 |
|---|---|---|---|---|
| G1T3/E1 | UUUL | CAT_SURVIVAL_CERTIFIED_WITHIN_H1 | PROVEN | 本轮独立证书 |
| G1T3/H1 | RRRR | CAT_SURVIVAL_CERTIFIED_WITHIN_H1 | PROVEN | P4 复用（身份匹配） |
| G5T3/E1 | LLDR | MOUSE_FORCED_WIN_WITHIN_H1 | PROVEN | 本轮独立证书 |
| G2T2/E1 | DLUL | CAT_SURVIVAL_CERTIFIED_WITHIN_H1 | PROVEN | 本轮独立证书 |
| G2T2/H1 | DDDD | CAT_SURVIVAL_CERTIFIED_WITHIN_H1 | PROVEN | 本轮独立证书 |
| G2T6/H1 | LUUU | CAT_SURVIVAL_CERTIFIED_WITHIN_H1 | PROVEN | 本轮独立证书 |
| G1T4/H1 | LLLL | CAT_SURVIVAL_CERTIFIED_WITHIN_H1 | PROVEN | 本轮独立证书 |

补充证书的搜索均未截断；CHANCE 按“所有正概率后继 AND”展开：

| root/arm | 计划 | H1 搜索节点 | H1 chance 节点 | 截断 | 证书叶数 | 耗时 |
|---|---|---:|---:|---|---:|---:|
| G5T3/E1 | LLDR | — | 2 | 否 | 756（mouseForce） | 120ms |
| G2T2/E1 | DLUL | — | 1 | 否 | 328 | 20ms |
| G2T2/H1 | DDDD | — | 1 | 否 | 307 | 15ms |
| G2T6/H1 | LUUU | — | 7 | 否 | 11380 | 214ms |
| G1T4/H1 | LLLL | — | 23 | 否 | 32512 | 555ms |

> `CORRECTED_ROOT_TABLE.csv` 的 `e1_class/e1_proof/h1_class/h1_proof` 列沿用 P4 证书（对应
> `cert_plan_e1` / `cert_plan_h1`）。对上述 6 个 `cert != actual` 的组合，实际计划的类别以
> `ERRATUM_RESULTS.json` 的 `uncoveredNowCertified` 和 `ADDITIONAL_100MS_PLAN_CERTIFICATES.json` 为准。

---

## 4. G1T3/E1/UUUL 独立量词证书

文件：`G1T3_E1_100MS_CERTIFICATE.json`

### 4.1 根身份与执行

- fixture SHA-256：`1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`（匹配冻结值）
- G1T3 canonical snapshot SHA-256：`e15e6209f7d64337ac02675b9299b7599f06c9d33abfa41bdc84baea2f089439`
- P4 snapshot、P5 五轮 snapshot、ablation snapshot 全部相同；restored `stateKey` 与 ablation 完全相同。
- P5 五轮：`finalPlan=UUUL` 一致；`executed=UUUL` 一致；0 fallback，0 override；实际执行轨迹严格以 `finalPlan` 开头。
- 真实规则回放 `UUUL`：4 步全部成功；完整猫回合结束（`catTurnEnded=true`）；无 CHANCE 分支（0 chance nodes）；`applyPrefix` 交叉校验 stateKey 一致。
- 回合结束状态：cat `5,1`，mouse `9,6`，`catMovesLeft=0`，mouse 行动，phase `playing`；陷阱 `1,1`；黄油 `1,4` 与 `2,5`。

### 4.2 量词结果（H0=1, H1=2, cap=600000）

唯一分支（branchIdx 0）的四个量词分别独立求解：

| 量词 | 结果 | 搜索节点 | 截断 | maxIdx | 耗时 |
|---|---|---:|---|---:|---:|
| `mouseForce(H0)` | false | 18 | 否 | 1 | 3ms |
| `mouseForce(H1)` | false | 179 | 否 | 3 | 13ms |
| `catSurvive(H1)` | **true** | 179 | 否 | 3 | 8ms |
| `catForce(H1)` | false | 192 | 否 | 3 | 9ms |

- CHANCE 节点：0；若存在则按所有正概率后继 AND。
- 终端判定先于 horizon；cap=600000 未触及；cap 不会转成“存活”或“失败”，只会 UNRESOLVED。
- 独立 `verifyCatCertificate`：`verdict=PROVEN`，0 failures，470 leaves，115 branches，maxDepth 13，policySize 64，0 policy misses。
- 证书 ID：`2d98846d1b47a692`。
- **没有用 `!mouseForce` 推导猫存活**；存活来自 `catSurvive` 的独立 PROVEN 证书。

### 4.3 解释

在 H1=2 的证书视野内，G1T3/E1 的 UUUL 不是鼠强制胜，而是猫可存活。该结论是**局部 horizon 证明**，
不等于“猫可无限期存活”；但在本轮预先登记的判据下，它已经足以否定“E1 是鼠强制胜”的前提。
先前关于“E1 UUUL 可能为鼠强制胜”的假设**未获证据支持**。

---

## 5. H1/G1T3/RRRR 的 P4 证书复用审计

`auditH1G1T3Reuse()` 的结果（全部为 true 才允许复用）：

| 检查 | 结果 |
|---|---|
| fixture SHA-256 匹配 | true |
| P4 证书计划 = RRRR | true |
| P5 实际 100ms 计划 = RRRR | true |
| P4 snapshot = 本轮 fixture snapshot | true |
| P5 五轮 stateKey 一致 | true |
| 真实回放 post-state keys 与 P4 一致 | true |
| 重算证书 ID 与 P4 存储 ID 一致 | true（`1086e06cfdbef0ee`, catSurvive） |
| P4 class / proof | `CAT_SURVIVAL_CERTIFIED_WITHIN_H1` / `PROVEN` |
| 复用决定 | **`REUSED_P4_PROVEN`** |

因此没有重复求解 RRRR；直接复用 P4 的 PROVEN 证书，避免重复计算和证据漂移。

---

## 6. 最终裁决字段

| 项目 | 结果 |
|---|---|
| E1/G1T3/UUUL 量词类别 | **CAT_SURVIVAL_CERTIFIED_WITHIN_H1** |
| E1/G1T3/UUUL 证明状态 | **PROVEN** |
| E1/G1T3/UUUL 是否鼠强制胜 | **false** |
| H1/G1T3/RRRR 量词类别 | **CAT_SURVIVAL_CERTIFIED_WITHIN_H1** |
| H1/G1T3/RRRR 证明状态 | **PROVEN**（P4 复用） |
| H1 是否产生真实、100ms 可证明的战术收益 | **false** |
| `PROVEN_100MS_TACTICAL_GAIN` | **FALSE** |
| 生产接线授权 | **NO** |
| 性能门 | 既有 A/A 校准门仍然有效；本轮不做性能认证 |

理由：预先登记的 TRUE 条件是“E1 UUUL 被证明鼠强制胜 **且** H1 RRRR 被证明猫存活”。实际结果是
E1 UUUL 也属于猫存活类（H1 视野内），因此条件不成立。该结果既不证明 H1 更优，也不证明 H1 更差；
它只是说明在本轮冻结判据下没有可证明的差异收益。

---

## 7. 身份、保留与禁止项

### 7.1 原始工件

以下文件在测试前后 SHA-256 完全一致。其中属于 `PPC-CAT-EVALUATOR-ABLATION-01/SHA256SUMS.txt` 的 8 项已逐项匹配
（`allPriorSumsMatch=true`）；fixture 由冻结 SHA 校验；`seal_lib.ts` 与 `SEAL_VERIFICATION.json` 有前后身份记录，
但不在该 `SHA256SUMS.txt` 的 priorSums 列表中：

| 文件 | SHA-256 |
|---|---|
| `PPC-CAT-EVALUATOR-ABLATION-01/REPORT.md` | `579a0ccd5cdef5cbfe8208fad564d44ff21dde1d8d7f66ed2bb8d3aa8d231364` |
| `PPC-CAT-EVALUATOR-ABLATION-01/_raw/p7_decision.json` | `a0f13ec2f8cd5b61b1d634e702178fbda679680bdb882a54baed901f8731b7b1` |
| `PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json` | `9d50560f107da52107cb68be94f4ac90214f8a50aabbc948f8f3114215278775` |
| `PPC-CAT-EVALUATOR-ABLATION-01/QUANTIFIER_CERTIFICATES.json` | `2a0a807740bc1f6108958898ec0912d404b83e37224ff44110983ced7ceee4e9` |
| `PPC-CAT-EVALUATOR-ABLATION-01/PERFORMANCE_RESULTS.json` | `16e8f1d62d43f880b493aea0929c98c3d8d1e1e31aac393e2e63334204a2dd7e` |
| `PPC-CAT-EVALUATOR-ABLATION-01/SEAL_VERIFICATION.json` | `5c39d22d51bbbf87c45f1c70c2b9709f24823bda702ae6a3ea38fac7dd81e6d7` |
| `PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts` | `453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b` |
| `src/game/ai/__tests__/fixtures/ppcId01-human-roots.json` | `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09` |

- `SOURCE_AND_ARTIFACT_IDENTITY.json`：`originalsUnchanged=true`，`sourcesUnchanged=true`，
  `allPriorSumsMatch=true`，`sourcesPredateErratumStart=true`。
- seal archive `F:/ppc-checkpoints/PPC-CAT-EVALUATOR-ABLATION-01-candidate.tar.gz` SHA-256
  `d174a6a84c35fcf095179ccb4b05cd40cf530c09a50aaf669299d7d1e05ce4a4`，与封口记录一致。
- 生产源码 15 个文件的 SHA-256 测试前后一致；工作树中的未提交生产补丁是**本轮之前已存在**的，
  本轮没有写入任何 `src/` 文件。

### 7.2 本轮新增工件 SHA-256

| 文件 | SHA-256 |
|---|---|
| `ERRATUM_RESULTS.json` | `36b318414a7a2dfd4139abfdb89e4721ed3e640b44cf583f4b6fa501343354ed` |
| `G1T3_E1_100MS_CERTIFICATE.json` | `2fc98a82f399be6232bd241bf4db565c4fdbecd1d838289788ef39c7cb4236fa` |
| `ADDITIONAL_100MS_PLAN_CERTIFICATES.json` | `cad3241254afcca2f3fe0f20de13c79a88594074ced77fd387b1fe0012c0c6a6` |
| `CORRECTED_ROOT_TABLE.csv` | `c0c192384c4de5f44b0f084f2dbba562315ebc75dafb7549fbfd07797ed4db49` |
| `SOURCE_AND_ARTIFACT_IDENTITY.json` | `b991fb7ed18229cd183f7aea4f09e92071d3db04a9cd350c9465176c94948dbf` |
| `_raw/erratum_metrics.json` | `fb7d5480e32d56148d606c9b1e8646ade93e2908490a940ef7836aa5ceb9ded6` |
| `_raw/identity_before.json` | `93adbd61b198d61944154d29e06c2c569a9c88914271dc7538181f83ca1099fa` |
| `_raw/run_timing.json` | `9db7f39854780a20b4130a8e3fafae276a3600c7e27d51436d9072e9f5a9d48b` |
| `logs/erratum_run.log` | `a358d288a951b32addcf9b6ec7a12ce5d51e22b10a94c74c2944d62cebbe0d37` |

### 7.3 禁止项

- `PRODUCTION_SOURCE_CHANGE = NO`：遵守。
- `GAME_RULES_CHANGE = NO`：遵守。
- `SEARCH_MATH_CHANGE = NO`：遵守。
- `H1_CHANGE = NO`：遵守。
- `100MS_150MS_CHANGE = NO`：遵守。
- `FULL_24_ROOT_RERUN = NO`：遵守；只做 24 根指标重算（无搜索）和 6 个未覆盖计划补证。
- `P5_P6_RERUN = NO`：遵守；只读取既有 5 轮 P5 工件。
- `SELF_PLAY = NO`：遵守。
- `COMMIT/PUSH/MERGE = NO`：遵守。

---

## 8. 限制与解释边界

1. **H1=2 是局部 horizon**。所有 `CAT_SURVIVAL_CERTIFIED_WITHIN_H1` 只表示在 H1 视野内、按所有正概率
   CHANCE 后继的 AND 语义，猫有策略避免鼠胜；它不是无限期存活证明。
2. **100ms/150ms 是名义生产预算**，不是物理延迟认证；本轮没有重新测性能，也没有把证书结果外推为
   性能收益。
3. **24 根计数是冻结样本上的确定性统计**，不是总体推断；不能把 23/24 与 22/24 的差异解读为显著性结论。
4. **证书视野内的“猫存活”不等于“猫优”**。H1 的 RRRR 与 E1 的 UUUL 都在 H1 内猫存活；没有证据表明
   H1 产生额外的可证明战术收益。
5. `G1T5` 仍是 UNRESOLVED，`G1T8` 仍是 CHANCE_DEPENDENT（P4 证据未改写）；这两根本轮没有重新搜索。
6. `CORRECTED_ROOT_TABLE.csv` 的 class/proof 列是 P4 证书（对应 cert plan）的元数据；6 个
   cert≠actual 组合的实际计划类别见 `ERRATUM_RESULTS.json` 与 `ADDITIONAL_100MS_PLAN_CERTIFICATES.json`。
7. 工作树中存在**本轮之前已存在**的未提交生产补丁；`SOURCE_AND_ARTIFACT_IDENTITY.json` 如实披露了
   15 个修改文件与 14 个未跟踪文件。本轮没有新增或修改生产源码。

---

## 9. 复现命令

```bash
cd "F:\小猫小鼠"
npx vitest run --config PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01/probe/vitest.config.mts
```

预期：2 tests passed，串行单 worker；生成/覆盖本目录下的 JSON/CSV/log 工件，不触碰原始 P3/P4/P5/P7
工件、seal 包或 `src/`。

---

## 10. 交付物

- `ERRATUM.md`（本文件）
- `ERRATUM_RESULTS.json`
- `CORRECTED_ROOT_TABLE.csv`
- `G1T3_E1_100MS_CERTIFICATE.json`
- `SOURCE_AND_ARTIFACT_IDENTITY.json`
- `RESOURCE_SAFETY_LOG.md`
- 附加证据：`ADDITIONAL_100MS_PLAN_CERTIFICATES.json`、`_raw/erratum_metrics.json`、
  `_raw/identity_before.json`、`_raw/run_timing.json`、`logs/erratum_run.log`、`probe/*`

**最终结论：`PROVEN_100MS_TACTICAL_GAIN = FALSE`。停止，提交 ChatGPT 进行最终架构裁决。**
