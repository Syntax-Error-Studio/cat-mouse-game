# 研究文档索引（根目录 156 份轮次记录该怎么读）

> 本文件由 P0 工程可信度整改新增（2026-10-13）。**它不改写任何一轮的结论，不重命名任何文件，不删除任何历史记录**——只做定位与性质说明，既有链接全部保持可用。

## 为什么要这份索引

仓库根目录积累了 156 份 AI 研究轮次的 markdown 记录。它们的**文件名和正文内容并不总是一致**：最典型的是 `D4-final-report.md`——标题写的是 Phase D4「最终报告」，正文其实是 **下一阶段（Phase E0）的实验任务书**，读者按名字去读会以为能在里面找到 D4 的结论。

这份索引解决三件事：

1. 说明命名约定，使读者能从文件名推断大致位置；
2. 点名**已确认的错位文档**（读之前必须知道性质）；
3. 给出全量清单，并说明哪些原始数据根本不在仓库里。

## 命名约定

| 前缀 | 主线内容 |
| --- | --- |
| `D1…D4` | 搜索基础设施（转置表、字典序 Alpha-Beta 等） |
| `E0 / E1` | 局势评价基础 + benchmark 语料、策略评价 v1 |
| `F0 / F1A / F1B` | 基准有效性与 Hard 生产集成 |
| `G0.1 … G0.3W` | 真实失败取证、精确不可逆点、平局破法、威胁感知、有界反驳等一条子轮次链（字母递增 = 时间递增） |
| `G0.4A … G0.4F-2B-1.9…` | ValueNet / Hybrid 叶子 / 幽灵黄油 / M3-lite / 运行时与形式化实验（当前最密集的一段） |

后缀不是严格约定，但含义相对稳定：

- `-report` / `-final-report`：收尾报告。
- `-audit` / `-forensics` / `-proof`：取证、审计或精确证明。
- `-preflight`：上线前的可行性检查。**这类轮次的结论经常是「不接线 / 不授权」，属于正常的停止条件被触发，不是失败**。
- `-repair` / `-hotfix` / `-R1` / `-R2`：缺陷修复或对同一轮的复核返工。
- `-stop-report`：因阻断条件（例如测量环境不可比）中途停止的一轮。

一个反复出现的结构：**很多轮次文档在结尾附上「下一阶段任务书 + STOP 条件」**，因此「文末出现祈使句」并不代表整篇是任务书。实测 156 份里有 13 份以 `禁止… / 然后 STOP / 不要自动 commit` 之类语句结尾，但只有下面 4 份是**通篇为下一轮下达的任务书**。

## 已确认的错位文档（读前必须知道）

这 5 份是逐份打开开头行核对过的，证据是文件自身的行内容。

| 文件 | 文件名暗示 | 正文实际是 | 证据 |
| --- | --- | --- | --- |
| `D4-final-report.md` | Phase D4 最终报告 | **Phase E0 的实验任务书** | 第 11 行 H1 即 `# Phase E0：Evaluation Foundation + Benchmark Corpus`；第 13 行只有一句「Phase D4 已验收通过。」，第 15 行起为「现在进入 **Phase E0**」「本阶段目标不是立刻把 Hard 接进游戏」「E0 完成后停止」；从该 H1 到底部的 728 行（现文件共 738 行 = 10 行说明 + 728 行原始记录）全是任务条款（`## 0. 规则绝对冻结`、`# 1. Phase E0 暂时不要"大调权重"`、`# 2. 建立 EvaluationBreakdown` …），没有 D4 的结果表。**E0 的真实结果在 `E0-final-report.md`**（其 H1 标注「最终报告」，状态「已完成并停止」）。仓库中不存在 `D3-*` 文件。行号以 2026-10-13 追加的 10 行「文档性质说明」引用块之后为准，原始正文未被改动。 |
| `G0.3G-hard-strength-root-cause.md` | G0.3G 根因报告 | **为 G0.3H 下达的任务书**（夹带 G0.3G 现场记录） | 无 H1 标题；第 1–4 行为「进入：／G0.3H — Carrying Evaluation Correctness／当前稳定基线：／HEAD = 89a5b36」；466 行内没有 `RESULT =` 汇总行，结尾是「不要自动 commit。／完成后停止。」。G0.3H 的结果请看 `G0.3H-carrying-evaluation-correctness.md`。 |
| `G0.4F-2B-1.9E-g8t10-value-ranking-gap.md` | 1.9E 的价值排序缺口报告 | **为 1.9F 下达的任务书** | 无 H1；开头 6 行为「继续 F:\\小猫小鼠。／开始：／G0.4F-2B-1.9F — Nonlocal Structural-Loss Sentinel & Root Rescue Feasibility」，并列出「禁止 production 接线／禁止训练／禁止 commit／禁止 reset / checkout / clean / stash」；958 行。该文件里出现的 `F2B19F_RESULT` 等字样是给下一轮**规定的输出名**，不是本轮结论。 |
| `G0.4F-2B-1.9F-structural-loss-sentinel-feasibility.md` | 1.9F 哨兵可行性报告 | **为 1.9G 下达的任务书**（引用 1.9F 裁定作为冻结权威） | 无 H1；开头为「继续 F:\\小猫小鼠。／开始：／G0.4F-2B-1.9G — Exact Structural Oracle Streaming …」；第 68 行附近以「Frozen 1.9F authority」的形式**引用**上一轮裁定（`PRIMARY_CLASS = MIXED_COST_AND_COVERAGE`、`F2B19F_RESULT = NO_BUDGET_FEASIBLE_EXACT_FIX`）；结尾（:1218 附近）规定 `F2B19G_RESULT` 的取值集合并要求「然后 STOP」。1.9F 自身的执行记录在 1.9E 之后的轮次链里，不能把这里的引用块当成本轮结果。 |
| `F0-hard-integration-audit.md` | F0 集成审计（结论） | **F0.1 更正声明，明确否决 F0 原结论** | H1 为 `# F0.1 — Benchmark Validity Correction`；紧随其后：**「状态：F0 报告不签核。本文档取代原 F0 结论。」**、「本轮未修改任何 production source，`src/` 全程只读」、「完成后停止，不进入 F1。」仓库里没有独立的 `F0-report`；引用 F0 时必须以这份更正为准。 |

另有 3 份文档没有 H1 标题（`G0.3G`、`1.9E`、`1.9F`，即上表后三份），这是它们性质异常的机械信号之一。除这 5 份以外，其余 151 份的首行 H1 与文件名前缀一致，可按「本轮记录」阅读。

## 四类内容分别在哪里

| 读者的问题 | 该看哪里 |
| --- | --- |
| **这轮做完没有得到结论？** | 各轮 `-report` / `-final-report` / `-audit` / `-forensics` 文档；判定字段通常写成 `XXX_RESULT = …` 或表格中的 `PASS / FAIL / BLOCKED`，**均为该轮作者自述，未经第三方独立复现**。 |
| **下一步要做什么（任务书）？** | 上面点名的 4 份纯任务书，以及多数报告文末的「下一阶段」小节。任务书描述的是*要求*，不是*事实*。 |
| **当前源码被冻结在哪个状态？** | `FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json`（20 个被摘要绑定的文件），逐文件校验结果见 [`REPRODUCIBILITY.md`](./REPRODUCIBILITY.md)。 |
| **原始数据 / 语料 / 训练脚本？** | 全部在 gitignore 的 `ai-training/`（本机实测 99 个顶层目录、59 280 个文件、约 8.9 GB），**GitHub 克隆不含其中任何一件**。测试所需的 10 个冻结局面快照 + 1 份 F0.3 裁定引用已抽成仓库内副本，见 `src/game/ai/__tests__/fixtures/` 与 `PROVENANCE.json`。另有一份从未入库的真实失败语料（`post-g03h-real-failure-5games.txt`）已丢失，对应 4 个测试处于 BLOCKED/SKIP，见 `fixtures/PROVENANCE.json → notPorted`。 |

## 阅读顺序建议

1. `GAMEPLAY.md`（玩法唯一基准，冻结）。
2. `D1-final-report.md` → `D2-final-report.md` → `E0-final-report.md` → `E1-final-report.md` → `F1A` → `F1B`（搜索与评价的主干，注意 `F0-hard-integration-audit.md` 是 F0 的更正）。
3. `G0.3B` → `G0.3V` → `G0.3W`（有界反驳与生产试用开关的由来）。
4. `G0.4A*` → `G0.4B*` → `G0.4C*` → `G0.4D*` → `G0.4E*` → `G0.4F*`（ValueNet / Hybrid V1 / V2 / H1 / M3-lite 的证据链，以及它们**为什么仍默认关闭**）。
5. 运行时与形式化实验段（`G0.4F-2B-1.9B…1.9…`、`1.9BE-*`、`1.9BE-R1-*`）里大量 `NOT_COMPARABLE / BLOCKED / STOP` 结论——这些是**方法论上的阻断记录**，读的时候把它们当阻断证据，不要当性能结论。

## 全量清单

生成方式见 `scripts/generate-reports-index.mjs`（只读文件名、行数与首个 H1）。

<!-- BEGIN GENERATED INVENTORY -->
共 156 份轮次文档（不含 `README.md`、`GAMEPLAY.md` 与被 gitignore 的 `CODELY.md`）。
本表由 `scripts/generate-reports-index.mjs` 从文件名与各文件的第一行 H1 生成，
**请勿手工编辑表格行**；要调整分类请改脚本里的清单并重跑。

#### D1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`D1-final-report.md`](../D1-final-report.md) | Phase D1 — EXACT Transposition Table · Final Acceptance Report | 102 | 本轮记录 |

#### D2


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`D2-final-report.md`](../D2-final-report.md) | Phase D2 — Lexicographic Alpha-Beta · Final Acceptance Report | 407 | 本轮记录 |

#### D4


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`D4-final-report.md`](../D4-final-report.md) | Phase E0：Evaluation Foundation + Benchmark Corpus | 738 | **下一阶段任务书（文件名是上一轮）** |

#### E0


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`E0-final-report.md`](../E0-final-report.md) | Phase E0 — Evaluation Foundation + Benchmark Corpus · 最终报告 | 180 | 本轮记录 |

#### E1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`E1-final-report.md`](../E1-final-report.md) | Phase E1 — Strategic Evaluation v1 · 最终验收报告 | 223 | 本轮记录 |

#### F0


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`F0-hard-integration-audit.md`](../F0-hard-integration-audit.md) | F0.1 — Benchmark Validity Correction | 495 | **更正声明（取代前一轮结论）** |

#### F1A


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`F1A-search-correctness-report.md`](../F1A-search-correctness-report.md) | Phase F1A — Search Correctness Prerequisites · 最终验收报告 | 232 | 本轮记录 |

#### F1B


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`F1B-hard-production-integration-report.md`](../F1B-hard-production-integration-report.md) | Phase F1B — Hard Production Integration · Final Report | 207 | 本轮记录 |

#### G0.1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.1-real-game-failure-forensics.md`](../G0.1-real-game-failure-forensics.md) | G0.1 — Real Game Failure Forensics · 第三局诊断报告 | 181 | 本轮记录 |

#### G0.2


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.2-exact-point-of-no-return.md`](../G0.2-exact-point-of-no-return.md) | G0.2 — Exact Point-of-No-Return（Turn-Boundary Frontier Proof，收口） | 106 | 本轮记录 |

#### G0.3A


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3A-forced-loss-tie-break.md`](../G0.3A-forced-loss-tie-break.md) | G0.3A — Forced-Loss Resistance Tie-Break | 144 | 本轮记录 |

#### G0.3B


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3B-threat-aware-search.md`](../G0.3B-threat-aware-search.md) | G0.3B — Threat-Aware Search Depth Efficiency（FINAL） | 254 | 本轮记录 |

#### G0.3C


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3C-exact-search-efficiency.md`](../G0.3C-exact-search-efficiency.md) | G0.3C — Exact Search Efficiency Profiling & Optimization | 219 | 本轮记录 |

#### G0.3D


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3D-real-game-decision-forensics.md`](../G0.3D-real-game-decision-forensics.md) | G0.3D — Post-G0.3C Real Failure Truth Scan | 359 | 本轮记录 |

#### G0.3E


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3E-general-exact-tie-plan-quality.md`](../G0.3E-general-exact-tie-plan-quality.md) | G0.3E — General Exact-Tie Cat-Turn Plan Quality (最终报告) | 202 | 本轮记录 |

#### G0.3F


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3F-real-failure-forensics.md`](../G0.3F-real-failure-forensics.md) | G0.3F — Closed-Loop & Last-Savable-Root Forensics（最终报告） | 180 | 本轮记录 |

#### G0.3G


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3G-hard-strength-root-cause.md`](../G0.3G-hard-strength-root-cause.md) | （无 H1 标题） | 466 | **下一阶段任务书（文件名是上一轮）** |

#### G0.3H


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3H-carrying-evaluation-correctness.md`](../G0.3H-carrying-evaluation-correctness.md) | G0.3H — Carrying Evaluation Correctness | 153 | 本轮记录 |

#### G0.3I


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3I-corrected.md`](../G0.3I-corrected.md) | G0.3I — Hard Think-Time Reality Check (Corrected & Sealed) | 68 | 本轮记录 |

#### G0.3J


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3J-search-tree-branching-autopsy.md`](../G0.3J-search-tree-branching-autopsy.md) | G0.3J — Search Tree Branching Autopsy | 322 | 本轮记录 |

#### G0.3K


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3K-exact-turn-boundary-prototype.md`](../G0.3K-exact-turn-boundary-prototype.md) | G0.3K — Exact Turn-Boundary Search Prototype | 248 | 本轮记录 |

#### G0.3L


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3L-lazy-turn-boundary-search.md`](../G0.3L-lazy-turn-boundary-search.md) | G0.3L — Lazy Exact Turn-Boundary Search | 325 | 本轮记录 |

#### G0.3M


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3M-legacy-iterative-efficiency.md`](../G0.3M-legacy-iterative-efficiency.md) | G0.3M — Legacy Iterative Search Efficiency | 213 | 本轮记录 |

#### G0.3N


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3N-exact-root-parallel-feasibility.md`](../G0.3N-exact-root-parallel-feasibility.md) | G0.3N — Exact Root-Parallel Feasibility | 182 | 本轮记录 |

#### G0.3O


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3O-real-game-solvability-separation.md`](../G0.3O-real-game-solvability-separation.md) | G0.3O — Real-Game Solvability Separation | 148 | 本轮记录 |

#### G0.3P


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3P-forced-region-escape-proof.md`](../G0.3P-forced-region-escape-proof.md) | G0.3P — Forced-Region Escape Proof | 621 | 本轮记录 |

#### G0.3Q


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3Q-selective-search-signal-discovery.md`](../G0.3Q-selective-search-signal-discovery.md) | G0.3Q — Selective Search Signal Discovery | 266 | 本轮记录 |

#### G0.3R


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3R-turn-aware-interception-geometry.md`](../G0.3R-turn-aware-interception-geometry.md) | G0.3R — Turn-Aware Interception Geometry | 193 | 本轮记录 |

#### G0.3S


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3S-interception-quiescence-prototype.md`](../G0.3S-interception-quiescence-prototype.md) | G0.3S — Interception Quiescence Search Prototype | 205 | 本轮记录 |

#### G0.3T


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3T-sparse-trigger-feasibility.md`](../G0.3T-sparse-trigger-feasibility.md) | G0.3T — Sparse Leaf Trigger Feasibility Audit | 170 | 本轮记录 |

#### G0.3U


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3U-plan-level-tactical-probe.md`](../G0.3U-plan-level-tactical-probe.md) | G0.3U — Root/Plan-Level Bounded Tactical Probe Feasibility | 146 | 本轮记录 |

#### G0.3V


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3V-bounded-plan-refutation.md`](../G0.3V-bounded-plan-refutation.md) | G0.3V — Bounded Adversarial Plan Refutation | 256 | 本轮记录 |

#### G0.3W


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.3W-bounded-refutation-production-trial.md`](../G0.3W-bounded-refutation-production-trial.md) | G0.3W — Feature-Flagged Hard Production Trial | 259 | 本轮记录 |

#### G0.4A-0


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4A-0-smoke.md`](../G0.4A-0-smoke.md) | G0.4A-0 — Self-Play Value Feasibility: Environment + End-to-End Smoke Test | 206 | 本轮记录 |

#### G0.4A-1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4A-1-dataset-forensic-hardening.md`](../G0.4A-1-dataset-forensic-hardening.md) | G0.4A-1 — Dataset & Forensic Hardening | 207 | 本轮记录 |

#### G0.4A-2


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4A-2-target-semantics-audit.md`](../G0.4A-2-target-semantics-audit.md) | G0.4A-2 - Target Semantics & Policy Confounding Audit | 146 | 本轮记录 |

#### G0.4B-0


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4B-0-canonical-selfplay-contract.md`](../G0.4B-0-canonical-selfplay-contract.md) | G0.4B-0 - Canonical Self-Play Dataset Contract & Policy Selection | 653 | 本轮记录 |

#### G0.4B-0P


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4B-0P-canonical-v1-pilot.md`](../G0.4B-0P-canonical-v1-pilot.md) | G0.4B-0P - Canonical-v1 Production-Parity Preflight + 200-Game Pilot | 255 | 本轮记录 |

#### G0.4B-1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4B-1-canonical-v1-10k-dataset.md`](../G0.4B-1-canonical-v1-10k-dataset.md) | G0.4B-1 — Canonical-v1 10K Generation & Dataset Acceptance | 236 | 本轮记录 |

#### G0.4B-2


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4B-2-canonical-valuenet-learning-audit.md`](../G0.4B-2-canonical-valuenet-learning-audit.md) | G0.4B-2 — Canonical-v1 ValueNet Learning Audit | 183 | 本轮记录 |

#### G0.4C-0


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4C-0-valuenet-search-readiness.md`](../G0.4C-0-valuenet-search-readiness.md) | G0.4C-0 — ValueNet Search-Readiness & Offline Shadow Preflight | 290 | 本轮记录 |

#### G0.4C-1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4C-1-paired-offline-strength-ab.md`](../G0.4C-1-paired-offline-strength-ab.md) | G0.4C-1 — Paired Offline Strength A/B: Baseline Hard vs ValueNet-Leaf Hard | 267 | 本轮记录 |

#### G0.4C-1.1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4C-1.1-valuenet-latency-isolation.md`](../G0.4C-1.1-valuenet-latency-isolation.md) | G0.4C-1.1 — ValueNet Inference Bottleneck Isolation: Numerically-Equivalent Optimization + Exact Paired Re-run | 224 | 本轮记录 |

#### G0.4D-0


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4D-0-search-aware-target-audit.md`](../G0.4D-0-search-aware-target-audit.md) | G0.4D-0 — Search-Aware Target Semantics & Teacher Oracle Audit | 226 | 本轮记录 |

#### G0.4D-0.1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4D-0.1-exact-teacher-forensics.md`](../G0.4D-0.1-exact-teacher-forensics.md) | G0.4D-0.1 — Exact Teacher Search Forensics & Audit Correction | 222 | 本轮记录 |

#### G0.4D-0.2


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4D-0.2-consensus-teacher-audit.md`](../G0.4D-0.2-consensus-teacher-audit.md) | G0.4D-0.2 — Consensus Top-Set / Abstention Teacher Audit | 183 | 本轮记录 |

#### G0.4D-0.3


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4D-0.3-fast-guidance-signal-check.md`](../G0.4D-0.3-fast-guidance-signal-check.md) | G0.4D-0.3 — Fast Guidance Signal Check | 121 | 本轮记录 |

#### G0.4D-0.3b


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4D-0.3b-hybrid-leaf-quick-gate.md`](../G0.4D-0.3b-hybrid-leaf-quick-gate.md) | G0.4D-0.3b — Hybrid Leaf Quick Gate (screening pilot) | 63 | 本轮记录 |

#### G0.4D-0.3c


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4D-0.3c-hybrid-independent-confirmation.md`](../G0.4D-0.3c-hybrid-independent-confirmation.md) | G0.4D-0.3c — Hybrid Leaf Independent Holdout Confirmation | 147 | 本轮记录 |

#### G0.4E-0


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4E-0-hybrid-production-preflight.md`](../G0.4E-0-hybrid-production-preflight.md) | G0.4E-0 — Hybrid Leaf Production Integration Preflight | 195 | 本轮记录 |

#### G0.4E-1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4E-1-feature-flagged-hybrid-integration.md`](../G0.4E-1-feature-flagged-hybrid-integration.md) | G0.4E-1 — Feature-Flagged Hybrid Leaf Integration | 186 | 本轮记录 |

#### G0.4E-1.1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4E-1.1-hybrid-integration-hardening.md`](../G0.4E-1.1-hybrid-integration-hardening.md) | G0.4E-1.1 — Hybrid Integration Wiring & Test Hardening | 123 | 本轮记录 |

#### G0.4E-2


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4E-2-human-validation-prep.md`](../G0.4E-2-human-validation-prep.md) | G0.4E-2 — Human Hard Validation: Dev-Only Leaf Switch (prep) | 50 | 本轮记录 |

#### G0.4F-0


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-0-human-hybrid-failure-mechanism-audit.md`](../G0.4F-0-human-hybrid-failure-mechanism-audit.md) | G0.4F-0 — Human Hybrid Failure Mechanism Audit | 319 | 本轮记录 |

#### G0.4F-0.1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-0.1-horizon-vs-leaf-audit.md`](../G0.4F-0.1-horizon-vs-leaf-audit.md) | G0.4F-0.1 — Horizon vs Leaf Disambiguation | 243 | 本轮记录 |

#### G0.4F-0.2


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-0.2-deeper-hybrid-action-utility.md`](../G0.4F-0.2-deeper-hybrid-action-utility.md) | G0.4F-0.2 — Deeper-Hybrid Action Utility Ceiling | 263 | 本轮记录 |

#### G0.4F-0.3


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-0.3-two-mouse-turn-threat-onset.md`](../G0.4F-0.3-two-mouse-turn-threat-onset.md) | G0.4F-0.3 — Two-Mouse-Turn Threat Onset Audit | 218 | 本轮记录 |

#### G0.4F-1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-1-pre-pickup-threat-leaf-prototype.md`](../G0.4F-1-pre-pickup-threat-leaf-prototype.md) | G0.4F-1 — Pre-Pickup Threat Leaf Prototype Gate | 158 | 本轮记录 |

#### G0.4F-1.1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-1.1-leaf-semantic-isolation.md`](../G0.4F-1.1-leaf-semantic-isolation.md) | G0.4F-1.1 — Leaf Semantic Isolation Gate | 159 | 本轮记录 |

#### G0.4F-1.1P


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-1.1P-candidate-runtime-deconfounding.md`](../G0.4F-1.1P-candidate-runtime-deconfounding.md) | G0.4F-1.1P — Candidate Runtime Deconfounding | 163 | 本轮记录 |

#### G0.4F-1.1R


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-1.1R-latent-route-isolation.md`](../G0.4F-1.1R-latent-route-isolation.md) | G0.4F-1.1R — Latent Route Signal Isolation | 142 | 本轮记录 |

#### G0.4F-1.2


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-1.2-independent-candidate-confirmation.md`](../G0.4F-1.2-independent-candidate-confirmation.md) | G0.4F-1.2 — Independent Candidate Confirmation | 164 | 本轮记录 |

#### G0.4F-1.3


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-1.3-hybrid-v2-production-preflight.md`](../G0.4F-1.3-hybrid-v2-production-preflight.md) | G0.4F-1.3 — Hybrid V2 Production Preflight | 168 | 本轮记录 |

#### G0.4F-2A


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-2A-ghost-butter-rule-integration.md`](../G0.4F-2A-ghost-butter-rule-integration.md) | G0.4F-2A — Ghost Butter Spawn Rule Integration | 191 | 本轮记录 |

#### G0.4F-2A.1


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-2A.1-ghost-edge-correctness.md`](../G0.4F-2A.1-ghost-edge-correctness.md) | G0.4F-2A.1 — Ghost Butter Edge Correctness Fix | 134 | 本轮记录 |

#### G0.4F-2A.2


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-2A.2-legacy-hybrid-ghost-domain-safety.md`](../G0.4F-2A.2-legacy-hybrid-ghost-domain-safety.md) | G0.4F-2A.2 — Legacy Hybrid Ghost-Domain Safety Gate | 123 | 本轮记录 |

#### G0.4F-2A.3


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-2A.3-production-ruleset-ghost-parity-hotfix.md`](../G0.4F-2A.3-production-ruleset-ghost-parity-hotfix.md) | G0.4F-2A.3 — Production RuleSet Ghost Parity Hotfix | 149 | 本轮记录 |

#### G0.4F-2A.4


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-2A.4-board-piece-alignment-hotfix.md`](../G0.4F-2A.4-board-piece-alignment-hotfix.md) | G0.4F-2A.4 — Board Piece Alignment UI Hotfix | 117 | 本轮记录 |

#### G0.4F-2B


| 文件 | 原文 H1 标题 | 行数 | 性质 |
| --- | --- | --- | --- |
| [`G0.4F-2B-0-strategic-fortification-audit.md`](../G0.4F-2B-0-strategic-fortification-audit.md) | G0.4F-2B-0 — Strategic Fortification Mechanism Audit | 304 | 本轮记录 |
| [`G0.4F-2B-1-strategic-leaf-candidate.md`](../G0.4F-2B-1-strategic-leaf-candidate.md) | G0.4F-2B-1 — Strategic Leaf Candidate Isolation | 291 | 本轮记录 |
| [`G0.4F-2B-1.1-gate-reconciliation.md`](../G0.4F-2B-1.1-gate-reconciliation.md) | G0.4F-2B-1.1 — Gate Reconciliation + Ghost Incremental Utility | 236 | 本轮记录 |
| [`G0.4F-2B-1.2-h1-production-preflight.md`](../G0.4F-2B-1.2-h1-production-preflight.md) | G0.4F-2B-1.2 — H1 Feature-Flagged Production Preflight Integration | 224 | 本轮记录 |
| [`G0.4F-2B-1.3-human-game1-box-defense-forensics.md`](../G0.4F-2B-1.3-human-game1-box-defense-forensics.md) | G0.4F-2B-1.3 — Human Game1 Box-Defense Exact Forensics | 223 | 本轮记录 |
| [`G0.4F-2B-1.4-human-game5-oscillation-forensics.md`](../G0.4F-2B-1.4-human-game5-oscillation-forensics.md) | G0.4F-2B-1.4 — Human Game5 Cross-Turn Oscillation Exact Forensics | 225 | 本轮记录 |
| [`G0.4F-2B-1.5-cross-turn-progress-guard-prototype.md`](../G0.4F-2B-1.5-cross-turn-progress-guard-prototype.md) | G0.4F-2B-1.5 — Minimal Cross-Turn Progress Guard Prototype | 248 | 本轮记录 |
| [`G0.4F-2B-1.6-m3lite-production-preflight.md`](../G0.4F-2B-1.6-m3lite-production-preflight.md) | G0.4F-2B-1.6 — M3-lite Feature-Flagged Production Preflight | 232 | 本轮记录 |
| [`G0.4F-2B-1.6R-m3lite-wiring-repair.md`](../G0.4F-2B-1.6R-m3lite-wiring-repair.md) | G0.4F-2B-1.6R — M3-lite Production Wiring & Gate Correctness Repair | 195 | 本轮记录 |
| [`G0.4F-2B-1.7-human-game3-chase-defense-forensics.md`](../G0.4F-2B-1.7-human-game3-chase-defense-forensics.md) | G0.4F-2B-1.7 — Human Game3 Chase-vs-Defense Exact Forensics | 247 | 本轮记录 |
| [`G0.4F-2B-1.7R-game3-t13-witness-completion.md`](../G0.4F-2B-1.7R-game3-t13-witness-completion.md) | G0.4F-2B-1.7R — Game3 T13 Exact Witness Completion | 255 | 本轮记录 |
| [`G0.4F-2B-1.8-m3lite-human-validation-logging.md`](../G0.4F-2B-1.8-m3lite-human-validation-logging.md) | G0.4F-2B-1.8 — M3-lite Human Validation Logging Only | 122 | 本轮记录 |
| [`G0.4F-2B-1.9A-four-game-human-regression-triage.md`](../G0.4F-2B-1.9A-four-game-human-regression-triage.md) | G0.4F-2B-1.9A — Four-Game Human Regression Triage | 172 | 本轮记录 |
| [`G0.4F-2B-1.9AA-R1-dual-domain-positive-evidence-gate.md`](../G0.4F-2B-1.9AA-R1-dual-domain-positive-evidence-gate.md) | G0.4F-2B-1.9AA-R1 — Dual-Domain Positive Evidence Gate: Exact Immediate Hazard + Bounded Structural Refutation, Conservative Anchor Rescue Repair | 131 | 本轮记录 |
| [`G0.4F-2B-1.9AA-R2-one-sided-reachability-kernel.md`](../G0.4F-2B-1.9AA-R2-one-sided-reachability-kernel.md) | G0.4F-2B-1.9AA-R2 — One-Sided Immediate Mouse-Win Reachability Kernel & Conservative Anchor Rescue Feasibility Repair | 132 | 本轮记录 |
| [`G0.4F-2B-1.9AA-conservative-d1-anchor-rescue.md`](../G0.4F-2B-1.9AA-conservative-d1-anchor-rescue.md) | G0.4F-2B-1.9AA — Conservative D1 Safety Anchor + Evidence-Gated Rescue Preflight | 141 | 本轮记录 |
| [`G0.4F-2B-1.9AB-rule-semantic-prefix-beam.md`](../G0.4F-2B-1.9AB-rule-semantic-prefix-beam.md) | G0.4F-2B-1.9AB — Rule-Semantic Incremental Cat Prefix Beam：Coverage & Generalization Preflight | 124 | 本轮记录 |
| [`G0.4F-2B-1.9AC-beam-completion-reservoir-consumer.md`](../G0.4F-2B-1.9AC-beam-completion-reservoir-consumer.md) | G0.4F-2B-1.9AC — Rule-Semantic Completion Reservoir + Frozen 1.9U Consumer：100ms Shadow Policy Preflight | 131 | 本轮记录 |
| [`G0.4F-2B-1.9AD-R1-dev-authority-repair-stream-resume.md`](../G0.4F-2B-1.9AD-R1-dev-authority-repair-stream-resume.md) | G0.4F-2B-1.9AD-R1 — Dev Authority Provenance Repair + Frozen Stratum-Complete Stream Resume | 125 | 本轮记录 |
| [`G0.4F-2B-1.9AD-stratum-complete-completion-stream-audit.md`](../G0.4F-2B-1.9AD-stratum-complete-completion-stream-audit.md) | G0.4F-2B-1.9AD — Stratum-Complete Beam Completion Stream Audit & Authority-Provenance Gate | 104 | 本轮记录 |
| [`G0.4F-2B-1.9AE-hierarchical-action-trie-fair-stream.md`](../G0.4F-2B-1.9AE-hierarchical-action-trie-fair-stream.md) | G0.4F-2B-1.9AE — Alias-Aware Hierarchical Action-Trie Fair Completion Stream & Early-Front Budget Feasibility Audit | 137 | 本轮记录 |
| [`G0.4F-2B-1.9AF-counterexample-guided-prefix-refill.md`](../G0.4F-2B-1.9AF-counterexample-guided-prefix-refill.md) | G0.4F-2B-1.9AF — Counterexample-Guided Recursive Prefix Refill：Positive-Evidence-Guided Cat-Turn Candidate Search | 101 | 本轮记录 |
| [`G0.4F-2B-1.9AG-production-tactical-prefix-guidance.md`](../G0.4F-2B-1.9AG-production-tactical-prefix-guidance.md) | G0.4F-2B-1.9AG — Frozen Production-Tactical Prefix-Guided Cat-Turn Beam：Early-Completion Accessibility Audit | 104 | 本轮记录 |
| [`G0.4F-2B-1.9AH-full-info-adversarial-completion-prefix-backup.md`](../G0.4F-2B-1.9AH-full-info-adversarial-completion-prefix-backup.md) | G0.4F-2B-1.9AH — Full-Information Adversarial Completion Envelope：Backpropagated Prefix Guidance Ceiling Test | 115 | 本轮记录 |
| [`G0.4F-2B-1.9AI-turn-level-and-or-safety-game.md`](../G0.4F-2B-1.9AI-turn-level-and-or-safety-game.md) | G0.4F-2B-1.9AI — Turn-Level AND-OR Safety Game | 200 | 本轮记录 |
| [`G0.4F-2B-1.9AJ-depth-horizon-recertification.md`](../G0.4F-2B-1.9AJ-depth-horizon-recertification.md) | G0.4F-2B-1.9AJ — Depth-Horizon Semantic Reconciliation & 28-Root Depth-2 Authority Recertification | 165 | 本轮记录 |
| [`G0.4F-2B-1.9AK-bounded-h2-certificate-polarity.md`](../G0.4F-2B-1.9AK-bounded-h2-certificate-polarity.md) | G0.4F-2B-1.9AK — Bounded H2 Certificate Polarity & Cheap-Domain Feasibility Audit | 139 | 本轮记录 |
| [`G0.4F-2B-1.9AL-h2-teacher-alignment-audit.md`](../G0.4F-2B-1.9AL-h2-teacher-alignment-audit.md) | G0.4F-2B-1.9AL — H2 Teacher Alignment & Expected-Strength Objective Audit | 124 | 本轮记录 |
| [`G0.4F-2B-1.9AM-matched-within-root-h2-contrast.md`](../G0.4F-2B-1.9AM-matched-within-root-h2-contrast.md) | G0.4F-2B-1.9AM — Matched Within-Root H2 Contrast Corpus & Objective Alignment Audit | 110 | 本轮记录 |
| [`G0.4F-2B-1.9AN-h1-matched-h2-flip-contrast.md`](../G0.4F-2B-1.9AN-h1-matched-h2-flip-contrast.md) | G0.4F-2B-1.9AN — H1-Matched H2 Horizon-Flip Contrast Expansion & Incremental-Value Audit | 91 | 本轮记录 |
| [`G0.4F-2B-1.9AO-hard-ai-architecture-consolidation.md`](../G0.4F-2B-1.9AO-hard-ai-architecture-consolidation.md) | G0.4F-2B-1.9AO — Hard AI Architecture Consolidation & Frozen Next-Phase Contract | 111 | 本轮记录 |
| [`G0.4F-2B-1.9AP-R1-runtime-tightening.md`](../G0.4F-2B-1.9AP-R1-runtime-tightening.md) | G0.4F-2B-1.9AP-R1 — Semantics-Preserving Runtime Tightening | 120 | 本轮记录 |
| [`G0.4F-2B-1.9AP-turn-compressed-expected-strength-consumer.md`](../G0.4F-2B-1.9AP-turn-compressed-expected-strength-consumer.md) | G0.4F-2B-1.9AP — Turn-Compressed Expected-Strength Candidate Consumer | 135 | 本轮记录 |
| [`G0.4F-2B-1.9AQ-streaming-e0-consumer.md`](../G0.4F-2B-1.9AQ-streaming-e0-consumer.md) | G0.4F-2B-1.9AQ — Complete Cat-Turn Streaming Enumeration + Streaming E0 + Top-4 + E1-on-4 Consumer | 126 | 本轮记录 |
| [`G0.4F-2B-1.9AR-fixed-horizon-expected-strength-value.md`](../G0.4F-2B-1.9AR-fixed-horizon-expected-strength-value.md) | G0.4F-2B-1.9AR — Fresh Fixed-Horizon Expected-Strength Value Audit | 115 | 本轮记录 |
| [`G0.4F-2B-1.9AT-sparse-evaluator-headroom-forensics.md`](../G0.4F-2B-1.9AT-sparse-evaluator-headroom-forensics.md) | G0.4F-2B-1.9AT — Sparse Expected-Return Headroom Error Anatomy & Conditional-Failure Audit | 131 | 本轮记录 |
| [`G0.4F-2B-1.9AU-trap-temporal-relevance-validation.md`](../G0.4F-2B-1.9AU-trap-temporal-relevance-validation.md) | G0.4F-2B-1.9AU — Fresh Trap-Relevance Evaluator Correction Validation | 96 | 本轮记录 |
| [`G0.4F-2B-1.9AV-single-component-decision-leverage.md`](../G0.4F-2B-1.9AV-single-component-decision-leverage.md) | G0.4F-2B-1.9AV — Single-Component Evaluator Decision-Leverage Ceiling & Causal Responsibility Audit | 100 | 本轮记录 |
| [`G0.4F-2B-1.9AW-R1-expected-return-corpus-topup.md`](../G0.4F-2B-1.9AW-R1-expected-return-corpus-topup.md) | G0.4F-2B-1.9AW-R1 — Fixed Expected-Return Corpus Top-Up for Representation Sufficiency | 131 | 本轮记录 |
| [`G0.4F-2B-1.9AW-expected-return-corpus-expansion.md`](../G0.4F-2B-1.9AW-expected-return-corpus-expansion.md) | G0.4F-2B-1.9AW — Fresh Expected-Return Corpus Expansion & Locked Generalization Split | 124 | 本轮记录 |
| [`G0.4F-2B-1.9AX-multivariate-expected-return-model.md`](../G0.4F-2B-1.9AX-multivariate-expected-return-model.md) | G0.4F-2B-1.9AX — Multivariate Expected-Return Model Training & DEV Selection | 188 | 本轮记录 |
| [`G0.4F-2B-1.9AY-one-shot-locked-test-generalization.md`](../G0.4F-2B-1.9AY-one-shot-locked-test-generalization.md) | G0.4F-2B-1.9AY — One-Shot LOCKED TEST: Expected-Return Model Generalization Audit | 209 | 本轮记录 |
| [`G0.4F-2B-1.9AZ-frozen-model-confirmatory-replication.md`](../G0.4F-2B-1.9AZ-frozen-model-confirmatory-replication.md) | G0.4F-2B-1.9AZ — Frozen A0 Expected-Return Model: Confirmatory Generalization Replication | 193 | 本轮记录 |
| [`G0.4F-2B-1.9B-plan-completion-execution-accounting-repair.md`](../G0.4F-2B-1.9B-plan-completion-execution-accounting-repair.md) | G0.4F-2B-1.9B — Hard Plan Completion & Per-Turn Execution Accounting Repair | 172 | 本轮记录 |
| [`G0.4F-2B-1.9BA-production-search-shadow-integration.md`](../G0.4F-2B-1.9BA-production-search-shadow-integration.md) | G0.4F-2B-1.9BA — Frozen Expected-Return Model: Production-Search Shadow Integration & Paired Full-Game Strength Audit | 188 | 本轮记录 |
| [`G0.4F-2B-1.9BB-deadline-granularity-audit.md`](../G0.4F-2B-1.9BB-deadline-granularity-audit.md) | G0.4F-2B-1.9BB — Hard Search Deadline Sampling Granularity Audit & Core100 Deadline Enforcement Repair | 174 | 本轮记录 |
| [`G0.4F-2B-1.9BC-R1-environment-qualified-runtime-confirmation.md`](../G0.4F-2B-1.9BC-R1-environment-qualified-runtime-confirmation.md) | G0.4F-2B-1.9BC-R1 — Environment-Qualified Frozen A0 Runtime Confirmation | 97 | 本轮记录 |
| [`G0.4F-2B-1.9BC-frozen-a0-runtime-optimization.md`](../G0.4F-2B-1.9BC-frozen-a0-runtime-optimization.md) | G0.4F-2B-1.9BC — Frozen A0 Runtime Cost Attribution & Semantics-Preserving Leaf Optimization | 160 | 本轮记录 |
| [`G0.4F-2B-1.9BD-exact-evaluator-kernel-acceleration.md`](../G0.4F-2B-1.9BD-exact-evaluator-kernel-acceleration.md) | G0.4F-2B-1.9BD — Exact Evaluator Kernel Acceleration (DENSE_INDEX_BFS) | 110 | 本轮记录 |
| [`G0.4F-2B-1.9BE-R1-CLOUD-MEMQUAL-stop-report.md`](../G0.4F-2B-1.9BE-R1-CLOUD-MEMQUAL-stop-report.md) | G0.4F-2B-1.9BE-R1-CLOUD-MEMQUAL — §7 阻断报告（STOP） | 287 | 本轮记录 |
| [`G0.4F-2B-1.9BE-R1-CONTRACT-FORENSICS-report.md`](../G0.4F-2B-1.9BE-R1-CONTRACT-FORENSICS-report.md) | G0.4F-2B-1.9BE-R1-CONTRACT-FORENSICS — Timing-Gate Provenance 与 Population 重建报告 | 350 | 本轮记录 |
| [`G0.4F-2B-1.9BE-R1-HOSTQUAL-report.md`](../G0.4F-2B-1.9BE-R1-HOSTQUAL-report.md) | G0.4F-2B-1.9BE-R1-HOSTQUAL / HOSTQUAL-R2 — DocMap 腾讯云 4C4G 执行机候选报告（R1 在线 + R2 dedicated） | 234 | 本轮记录 |
| [`G0.4F-2B-1.9BE-R1-MEMQUAL-AMEND-report.md`](../G0.4F-2B-1.9BE-R1-MEMQUAL-AMEND-report.md) | G0.4F-2B-1.9BE-R1-MEMQUAL-AMEND — §0–§20 完成报告（AMENDED_MEMQUAL 32-pair / 64-job） | 212 | 本轮记录 |
| [`G0.4F-2B-1.9BE-R1-METRIC-REBASE-PREFREEZE-report.md`](../G0.4F-2B-1.9BE-R1-METRIC-REBASE-PREFREEZE-report.md) | G0.4F-2B-1.9BE-R1-METRIC-REBASE-PREFREEZE | 454 | 本轮记录 |
| [`G0.4F-2B-1.9BE-R1-TIMING-CAL-R1-report.md`](../G0.4F-2B-1.9BE-R1-TIMING-CAL-R1-report.md) | G0.4F-2B-1.9BE-R1-TIMING-CAL-R1 — 消费数据度量校准 + 冻结 Holdout 验证 | 109 | 本轮记录 |
| [`G0.4F-2B-1.9BE-R1-TIMING-CAL-R1A-report.md`](../G0.4F-2B-1.9BE-R1-TIMING-CAL-R1A-report.md) | G0.4F-2B-1.9BE-R1-TIMING-CAL-R1A — Arm-B M2 尾部机制取证 | 142 | 本轮记录 |
| [`G0.4F-2B-1.9BE-R1-TIMING-CAL-R1B-report.md`](../G0.4F-2B-1.9BE-R1-TIMING-CAL-R1B-report.md) | G0.4F-2B-1.9BE-R1-TIMING-CAL-R1B — 反驳 sidecar 的 deadline 合规性与可中断性取证 | 156 | 本轮记录 |
| [`G0.4F-2B-1.9BE-R1-TIMING-CAL-R1G-report.md`](../G0.4F-2B-1.9BE-R1-TIMING-CAL-R1G-report.md) | G0.4F-2B-1.9BE-R1-TIMING-CAL-R1G — 官方续跑 ordinal 54..64 与 64-job 回归 population 定格 | 199 | 本轮记录 |
| [`G0.4F-2B-1.9BE-three-arm-full-game-strength.md`](../G0.4F-2B-1.9BE-three-arm-full-game-strength.md) | G0.4F-2B-1.9BE — Three-Arm Paired Full-Game Hard Strength Confirmation | 107 | 本轮记录 |
| [`G0.4F-2B-1.9C-human-revalidation-anticipation-forensics.md`](../G0.4F-2B-1.9C-human-revalidation-anticipation-forensics.md) | G0.4F-2B-1.9C — Human Revalidation: Anticipation Horizon & Ghost Chance Cost Forensics | 302 | 本轮记录 |
| [`G0.4F-2B-1.9CLOUD-migration-report.md`](../G0.4F-2B-1.9CLOUD-migration-report.md) | G0.4F-2B-1.9CLOUD — Windows → Ubuntu 云服务器迁移与完整性验证报告 | 428 | 本轮记录 |
| [`G0.4F-2B-1.9D-exact-chance-compression.md`](../G0.4F-2B-1.9D-exact-chance-compression.md) | G0.4F-2B-1.9D — Exact CHANCE Equivalence & Horizon-Inert Ghost Compression Prototype | 266 | 本轮记录 |
| [`G0.4F-2B-1.9E-g8t10-value-ranking-gap.md`](../G0.4F-2B-1.9E-g8t10-value-ranking-gap.md) | （无 H1 标题） | 958 | **下一阶段任务书（文件名是上一轮）** |
| [`G0.4F-2B-1.9F-structural-loss-sentinel-feasibility.md`](../G0.4F-2B-1.9F-structural-loss-sentinel-feasibility.md) | （无 H1 标题） | 1229 | **下一阶段任务书（文件名是上一轮）** |
| [`G0.4F-2B-1.9G-exact-structural-proof-acceleration.md`](../G0.4F-2B-1.9G-exact-structural-proof-acceleration.md) | G0.4F-2B-1.9G — Exact Structural Proof Acceleration | 180 | 本轮记录 |
| [`G0.4F-2B-1.9H-R1-authority-coverage-reconciliation.md`](../G0.4F-2B-1.9H-R1-authority-coverage-reconciliation.md) | G0.4F-2B-1.9H-R1 — Frozen Authority Reconciliation & Candidate-Coverage Denominator Repair | 166 | 本轮记录 |
| [`G0.4F-2B-1.9H-root-family-proof-preflight.md`](../G0.4F-2B-1.9H-root-family-proof-preflight.md) | G0.4F-2B-1.9H — Root-Family Exact Proof Reuse, Counterexample Certificates & Strict 150ms Preflight | 223 | 本轮记录 |
| [`G0.4F-2B-1.9I-projection-scope-repair.md`](../G0.4F-2B-1.9I-projection-scope-repair.md) | G0.4F-2B-1.9I — Projection-Scope Repair & Correct Exact Proof Performance Rebuild | 163 | 本轮记录 |
| [`G0.4F-2B-1.9J-batched-mwin-kernel.md`](../G0.4F-2B-1.9J-batched-mwin-kernel.md) | G0.4F-2B-1.9J — Batched Mouse-Turn Win Kernel & Structural Query Amortization | 156 | 本轮记录 |
| [`G0.4F-2B-1.9K-bounded-tactical-guard.md`](../G0.4F-2B-1.9K-bounded-tactical-guard.md) | G0.4F-2B-1.9K — Bounded Tactical Danger Guard & Defense-Certificate Coverage Ranking | 193 | 本轮记录 |
| [`G0.4F-2B-1.9L-production-search-boundary-audit.md`](../G0.4F-2B-1.9L-production-search-boundary-audit.md) | G0.4F-2B-1.9L — Production Main Search Information-Boundary Audit | 124 | 本轮记录 |
| [`G0.4F-2B-1.9M-dual-track-remedy-feasibility.md`](../G0.4F-2B-1.9M-dual-track-remedy-feasibility.md) | G0.4F-2B-1.9M — Dual-Track Remedy Feasibility | 144 | 本轮记录 |
| [`G0.4F-2B-1.9N-R1-hot-path-cost-validity-audit.md`](../G0.4F-2B-1.9N-R1-hot-path-cost-validity-audit.md) | G0.4F-2B-1.9N-R1 — TB_ABTT_V2 Hot-Path Cost Validity Audit | 126 | 本轮记录 |
| [`G0.4F-2B-1.9N-exact-turn-boundary-dag-architecture.md`](../G0.4F-2B-1.9N-exact-turn-boundary-dag-architecture.md) | G0.4F-2B-1.9N — Exact Turn-Boundary DAG Alpha-Beta / TT V2 & Production Horizon Feasibility | 152 | 本轮记录 |
| [`G0.4F-2B-1.9O-decision-critical-risk-signal-audit.md`](../G0.4F-2B-1.9O-decision-critical-risk-signal-audit.md) | G0.4F-2B-1.9O — Decision-Critical Root/Plan Risk Signal Audit | 144 | 本轮记录 |
| [`G0.4F-2B-1.9P-frozen-valuenet-plan-bridge.md`](../G0.4F-2B-1.9P-frozen-valuenet-plan-bridge.md) | G0.4F-2B-1.9P — Frozen ValueNet Plan-Level Bridge, Baseline-Free Candidate Recall & Dual-Signal Feasibility | 173 | 本轮记录 |
| [`G0.4F-2B-1.9Q-structural-risk-distillation-pilot.md`](../G0.4F-2B-1.9Q-structural-risk-distillation-pilot.md) | G0.4F-2B-1.9Q — METHOD_A Structural-Risk Distillation Pilot | 55 | 本轮记录 |
| [`G0.4F-2B-1.9R-adversarial-structural-distillation.md`](../G0.4F-2B-1.9R-adversarial-structural-distillation.md) | G0.4F-2B-1.9R — Adversarial Proof-Trace Structural Distillation & Q Failure Attribution | 120 | 本轮记录 |
| [`G0.4F-2B-1.9S-R1-mixed-family-recovery.md`](../G0.4F-2B-1.9S-R1-mixed-family-recovery.md) | G0.4F-2B-1.9S-R1 — Mixed-Family Data Sufficiency Recovery & Matched Pointwise-vs-Pairwise Objective Test | 119 | 本轮记录 |
| [`G0.4F-2B-1.9S-within-root-pairwise-ranking.md`](../G0.4F-2B-1.9S-within-root-pairwise-ranking.md) | G0.4F-2B-1.9S — Within-Root Pairwise Structural Ranking Objective Causal Test | 92 | 本轮记录 |
| [`G0.4F-2B-1.9T-dual-signal-shadow-policy.md`](../G0.4F-2B-1.9T-dual-signal-shadow-policy.md) | G0.4F-2B-1.9T — Dual-Signal Baseline-Free Primary Planner Shadow Policy Trial | 90 | 本轮记录 |
| [`G0.4F-2B-1.9U-probe-first-lazy-model-scheduler.md`](../G0.4F-2B-1.9U-probe-first-lazy-model-scheduler.md) | G0.4F-2B-1.9U — Probe-First Lazy-Model Scheduler Shadow Priority Benchmark | 100 | 本轮记录 |
| [`G0.4F-2B-1.9V-R1-semantic-boundary-recall.md`](../G0.4F-2B-1.9V-R1-semantic-boundary-recall.md) | G0.4F-2B-1.9V-R1 — Semantic Boundary Identity & Candidate Recall Reconciliation | 92 | 本轮记录 |
| [`G0.4F-2B-1.9V-candidate-recall-attribution.md`](../G0.4F-2B-1.9V-candidate-recall-attribution.md) | G0.4F-2B-1.9V — Counterfactual Candidate Recall & Safety Attribution Audit | 100 | 本轮记录 |
| [`G0.4F-2B-1.9W-semantic-diversity-portfolio.md`](../G0.4F-2B-1.9W-semantic-diversity-portfolio.md) | G0.4F-2B-1.9W — Semantic-Diversity Candidate Portfolio Shadow Architecture Trial | 127 | 本轮记录 |
| [`G0.4F-2B-1.9X-frozen-model-proposal-portfolio.md`](../G0.4F-2B-1.9X-frozen-model-proposal-portfolio.md) | G0.4F-2B-1.9X — Frozen Structural-Risk Proposal Portfolio & Independent Safe-Holdout Validation | 127 | 本轮记录 |
| [`G0.4F-2B-1.9Y-spatial-structural-risknet.md`](../G0.4F-2B-1.9Y-spatial-structural-risknet.md) | G0.4F-2B-1.9Y — Spatial Structural RiskNet Model-Family Causal Test & Frozen Safe-Holdout Proposal Audit | 130 | 本轮记录 |
| [`G0.4F-2B-1.9Z-prefix2-cnn-proposal.md`](../G0.4F-2B-1.9Z-prefix2-cnn-proposal.md) | G0.4F-2B-1.9Z — Prefix-Family-Constrained CNN Proposal (Selection-Mechanism Causal Test) | 126 | 本轮记录 |

<!-- END GENERATED INVENTORY -->

## 本索引没有做的事

- 没有修改任何一份轮次文档的正文或结论。唯一被编辑过的轮次文档是 `D4-final-report.md`：仅在**文件最前面**加了 10 行「文档性质说明」引用块（2026-10-13，不改动下文任何原始记录），原始 728 行逐字保留，现文件共 738 行；因此上表 D4 行给出的行号（H1 在第 11 行）已相对原始文件整体后移 10 行。
- 没有重命名、移动或删除任何文件，所有既有链接与相对路径保持有效。
- 没有根据摘要重建任何「看起来像原始数据」的逐对结果；缺失的原始语料按 BLOCKED 记录，不做合成替代。
- 没有宣称任何一轮的 `PASS` 已被独立复现。
