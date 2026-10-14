# 小猫小鼠 (Cat & Mouse)

一个用 React + TypeScript 编写的 10×10 回合制追逃游戏：玩家扮演需要把黄油搬回鼠洞的**鼠**，**猫**由 AI（单人模式）或第二名玩家（双人模式）控制。

- 玩法唯一基准：[`GAMEPLAY.md`](./GAMEPLAY.md)。本 README 与任何研究文档若与 `GAMEPLAY.md` 冲突，以 `GAMEPLAY.md` 为准。
- 当前仓库性质：**可玩的前端游戏 + 一份很长的 AI 研究记录**。研究候选技术（ValueNet / Hybrid 叶子 / Progress Guard）**默认没有启用**，详见 [AI 现状](#ai-现状必须看清的边界)。
- 无后端、无账号、无联网对战实现；全部逻辑在浏览器本地运行。

---

## 快速开始

```bash
npm install
npm run dev        # Vite 开发服务器
npm run build      # tsc -b && vite build（产物在 dist/）
npm run preview    # 预览构建产物
npm run lint       # ESLint 全仓（现在能跑完；但正式源码有 58 项既有 error，见「已知限制」）
npm run test       # Vitest 全量
```

跑 AI 回归套件时建议串行、单 worker（这些用例是精确复算型，并行会互相抢 CPU 造成超时假失败）：

```bash
npx vitest run --maxWorkers=1 --no-file-parallelism
```

测试可在**只含仓库内容**的机器上运行：所需 frozen 局面已抽成仓库内副本，见 `src/game/ai/__tests__/fixtures/`（含 [`PROVENANCE.json`](./src/game/ai/__tests__/fixtures/PROVENANCE.json)）。唯一例外是 4 个 G0.3W 真实语料回归，其原始语料已从本机丢失，会显式 SKIP，记录见下文与 `PROVENANCE.json → notPorted`。

---

## 玩法要点（完整规则读 `GAMEPLAY.md`）

| 项目 | 规则 |
| --- | --- |
| 棋盘 | 默认 10×10（可在设置中 5~20），元素：空地 / 箱子 / 桩子 / 鼠洞 / 四角传送通道 / 黄油格 / 陷阱 |
| 回合 | 鼠、猫轮流行动，每回合各自固定步数（默认 4） |
| 鼠 | 每回合 4 步；**携带黄油时 3 步**；技能（空格）消耗黄油 → +3 步并解锁传送使用权；踩陷阱立即结束回合；传送后步数归零 |
| 鼠胜利 | **携带黄油走进鼠洞**；技能激活状态（黄油已消耗）进洞不算胜利 |
| 猫 | 每回合 4 步；可推箱（不能把箱推到鼠/鼠洞/黄油/陷阱/桩子上）；推箱封住传送口即封锁通道；可放置/回收陷阱，**放置不消耗步数** |
| 猫胜利 | 与鼠同格（或把鼠逼到无路可走） |
| 猫禁入 | 鼠洞、传送通道、黄油格、桩子 |
| 黄油再生 | 拾取实体黄油后**不立即再生**：先在远处显示「幽灵黄油」，猫回合结束后实体化；无合法位置时进入待生成队列（placement debt），一对一再生义务不会丢失 |

操作：鼠 = 方向键，技能 = 空格；双人模式猫 = WASD，猫陷阱 = 空格。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| UI | React 19 + react-router-dom 7（`src/pages`、`src/components`） |
| 语言 / 构建 | TypeScript ~6.0，Vite 5（`npm run build` = `tsc -b && vite build`） |
| 测试 | Vitest 4，`environment: 'node'`，`include: ['src/**/*.test.ts']`，`testTimeout: 30000`（见 `vitest.config.ts`） |
| Lint | ESLint 10（flat config，`eslint.config.js`）+ typescript-eslint |
| 游戏内核 | 纯 TypeScript 不可变状态机（`src/game/engine.ts`），无第三方游戏库 |

目录：

```
src/game/engine.ts        规则内核 + 猫 AI 路由（4265 行）
src/game/config.ts        默认配置（棋盘/步数/陷阱数…）
src/game/types.ts         PieceType / GamePhase / CellType / Direction 等
src/game/rules/           传送通道规则
src/game/ai/              Hard 搜索、评价函数、叶子变体、冻结权重、守卫
src/game/ai/__tests__/    AI 回归套件（含 fixtures/ 便携副本）
src/components/           Board / DebugInfo / 菜单
src/pages/                主菜单、模式选择、对局、编辑器、教程、挑战、设置
GAMEPLAY.md               玩法唯一基准
docs/                     文档索引与可复现性说明
ai-training/              （gitignore，未公开）研究轮次的原始数据与工具
```

---

## 三档 AI 的真实实现

路由点在 `src/game/engine.ts:3718` 的 `catAiMove()`：

| 难度 | 实现 | 说明 |
| --- | --- | --- |
| Easy | `catAiEasy()`（`engine.ts:2218`） | 贪心/BFS 接近鼠，偶尔随机走动；会尝试推箱但不系统封锁通道 |
| Medium | `catAiHard()`（`engine.ts:2613`） | 历史启发式：拦截预测路线、按距离放陷阱、封锁传送通道、综合评分。**Medium 用的就是这个函数，Hard 无计划时也回落到它** |
| Hard | `planHardCatTurn()`（`src/game/ai/hardTurnPlanner.ts`） | 搜索型「Perfect Cat」规划器，见下节 |

> 命名注意：`catAiHard` 这个历史函数名指的是**启发式** AI，Hard 难度实际走的是搜索规划器；`catAiMedium` 保留导出但已不再被调用。

### Hard 搜索机制

全部在 `src/game/ai/`：

| 机制 | 位置 | 现状 |
| --- | --- | --- |
| Expectiminimax（含黄油 CHANCE 节点） | `expectiminimax.ts` | 默认深度语义 = **回合数**，`maxDepthTurns: 4`（`searchConfig.ts:17`） |
| 时间预算 | `searchConfig.ts:18` | `timeBudgetMsPerCatTurn: 100`，按**整个猫回合**计，不按单步 |
| Alpha-Beta / 转置表 / 迭代加深 / 动作排序 | `expectiminimax.ts`、`transposition.ts`、`legalActions.ts` | `DEFAULT_SEARCH_CONFIG` 里 `useTranspositionTable` / `enableIterativeDeepening` 为 `false`（那只是基础配置默认值）；实际 Hard 规划器调用 `searchBestActionIterative`，固定传入 `useTT / useAlphaBeta / useMoveOrdering = true`（`hardTurnPlanner.ts:217-219`）、`maxNodes = 500_000`（`hardTurnPlanner.ts:216`） |
| 选择性威胁扩展 | `expectiminimax.ts` | 机制在代码里，但生产值是 `maxThreatExtensions: 0`（`hardTurnPlanner.ts:227`）：G0.3B 真实快照验证失败后已回滚，仅留作实验/取证 |
| 叶评价 | `evaluation.ts` 的 `evaluateForCat()` | **当前默认叶子**（距离/拦截/封锁/陷阱/挤压等启发式） |
| 回合边界与合法动作 | `turnBoundary.ts`、`simulator.ts`、`searchRules.ts` | 搜索与真实引擎复用同一规则内核；搜索路径内**绝不调用 `Math.random`**，随机黄油建模为诚实 CHANCE 节点：搜索把幽灵黄油的候选位置**枚举**成等权分支（`simulator.ts:82`），而不是抽样。`DEFAULT_SEARCH_CONFIG.rng` 虽然写着 `Math.random`（`searchConfig.ts:21`），但 `src/game/ai/` 与 `engine.ts` 里没有任何调用点消费它（只有类型声明 `searchTypes.ts:138` 与「reserved for later phases」注释）|
| 有界反驳 sidecar | `boundedPlanRefutation.ts` | 由 `HARD_TRIAL`（`searchConfig.ts:37-40`）控制：`refutationEnabled: true`，整回合总预算 `150 ms`，其中 100 ms 给主搜索、剩余时间给 sidecar。这是**随源码发布的试用开关（G0.3X），不是 DEV-only** |
| M3-lite Progress Guard | `progressGuard.ts` + `searchConfig.ts:84-87` | `HARD_PROGRESS_GUARD_DEFAULT = false`，**默认关闭**；且第一版资格极窄（只在 H1 叶子模式下可触发），baseline / V1 / V2 免疫 |
| 强制负局破平 | `forcedLossTieBreak.ts` | 属冻结语义，被 checkpoint 摘要绑定 |

两个生产调用点（`engine.ts:3733` 与 `engine.ts:3853`）都用 `leafEvaluator: resolveHardLeaf()`（`engine.ts:3740`、`engine.ts:3859`）注入当前叶子。注意 `hardTurnPlanner.ts:220` 的默认值是 `opts.leafEvaluator ?? evaluateForCat`，因此「忘记传参」和「传了 baseline」在结果上无法区分——这正是 `src/game/ai/__tests__/hybridLeafCallObservation.test.ts` 用行为观测（记录真实被调用的叶函数及其输出）而不是函数身份比较来把关的原因。

---

## 叶子评价器与实验开关

单一真值来源是 `HARD_LEAF_MODE_CONFIG.current`（`src/game/ai/searchConfig.ts:65`），**默认且发布值 = `'baseline'`**（`HARD_LEAF_MODE_DEFAULT`，`searchConfig.ts:63`）。

| 模式 | 叶子 | 数学 | 启用方式 |
| --- | --- | --- | --- |
| `baseline`（默认） | `evaluateForCat()` | 纯启发式评分 | 出厂即此 |
| `baseline_hole_corrected` | H1（`correctedHoleLeaf.ts`） | 仅修正「双方都可达鼠洞」的 holeControl 符号，其余贡献不变 | 需手动切换 |
| `hybrid_standard_only` | Hybrid V1（公式注释 `hybridLeaf.ts:5`，实际计算 `hybridLeaf.ts:201`） | `0.5*tanh(evaluateForCat/S) + 0.5*ValueNet`，`S = 1016.1052856445312`（`hybridWeights.ts:11214`） | 需手动切换 |
| `hybrid_route_v2_standard_only` | Hybrid V2（`hybridRouteLeaf.ts:82`） | 在 V1 形式上改用修正评价并 `+ 0.05*routeContribution` | 需手动切换 |

- Hybrid V1/V2 只在**规范标准图 Hard 局面**上生效：`isHybridEligibleState()`（`hybridLeaf.ts`）是 fail-closed 门（非标准地图、非 Playing、含墙/空洞、`pendingButterSpawns`、`pendingButterPlacementDebt`、任何 config 覆盖 → 一律退回 `evaluateForCat`）。
- ValueNet 是固定的 808→128→64→1 tanh MLP，权重以字面量形式提交在 `src/game/ai/hybridWeights.ts`（2 391 157 字节，`HYBRID_WEIGHTS_FINGERPRINT = b9f00caec359…`）。**没有推理库依赖，也没有运行时下载**。
- 切换入口只有一个：`src/components/DebugInfo.tsx:479` 的 DEV-only 按钮（`baseline → H1 → V1 → V2 → baseline`，直接改写 `HARD_LEAF_MODE_CONFIG.current`，并且设计上要求「两局之间切换，不要在局中切」）。因为 `import.meta.env.DEV` 在生产构建为 `false`，**该开关整段 JSX 被折叠掉，打包后的游戏没有任何途径离开 `baseline`**（本轮实测：`dist/assets/index-CwsTdLRG.js` 中已不含按钮文案 `Hard Leaf =`；叶子模式的字符串常量与 `leafLabel` 计算仍留在 bundle 里，但不可达）。除该按钮和测试之外，`src/` 内没有任何代码调用 `setHardLeafMode()`。

---

## AI 现状：必须看清的边界

**玩家现在实际遇到的 Hard 猫 = Expectiminimax 搜索 + `evaluateForCat` 启发式叶子 + 有界反驳 sidecar（150 ms 整回合预算），Progress Guard 关闭。**

以下结论属于**研究记录**，不是已上线功能：

- **已「冻结为基线」而非「证明更强」**：`FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json` 自述 T1G 主结果为 `PASS`（1700 配对、若干门与裁定字段见该文件）。该结论由本项目作者侧产出，**未经第三方独立复现**，同一文件也明确写了 `NOT_A_PERFECT_PLAY_PROOF`、`HEAVY_BENCHMARK_RUN: false`、`PRIMARY_RERUN: false`；其重放与分析工具链全部位于 gitignore 的 `ai-training/`，从 GitHub 克隆**无法重跑**。计数口径（由 `node scripts/verify-source-checkpoint.mjs` 自己产出）：该 checkpoint 共 **21 条文件引用**，指向 **20 个不同文件**——6 条生产源码 + 14 条形式化工具/产物 + 1 条对最终产物的**重复**引用，那份 1700 配对权威文件本来就在 14 条里，不是第 21 个文件。详见 [`docs/REPRODUCIBILITY.md`](./docs/REPRODUCIBILITY.md)。
- **Hybrid V1/V2、H1、M3-lite 都还是实验分支**：V1/V2 的历史轮次里有正例（例如 G19/G17/G4 的排序回归，已固化为仓库内测试），也有明确记录「在真实对局语料上不足以证明整盘更强」的轮次（`G0.4F-*` 系列）。默认开关保持 `baseline` 就是这个原因。
- **训练与 self-play 不在仓库里跑**：数据集（canonical-v1 10k 等）、训练脚本与逐对原始结果都在 `ai-training/`，未公开。本仓库只提交冻结后的权重常量与其指纹。
- **不要把这些当成缺陷**：本项目的研究记录大量是「否定性结论 + 停止条件」，读法见 [`docs/REPORTS_INDEX.md`](./docs/REPORTS_INDEX.md)。

---

## 测试

```bash
npx vitest run --maxWorkers=1 --no-file-parallelism   # 推荐（串行、单 worker）
npm run test                                         # 默认并发
```

规模（本 README 更新时实测）：26 个测试文件、414 个用例；其中 4 个为 G0.3W 真实语料回归，在当前机器上显式 SKIP（原因见下）。

值得知道的几处：

- `src/game/ai/__tests__/fixtures/` 是从 gitignore 的 `ai-training/` 权威文件里抽出的**可移植副本**：只保留影响局面的快照字段，逐条带 `stateKey` 与 sha256，`frozenFixtures.ts` 在加载时校验，不一致就抛错（不做静默降级）。`hybridLeaf.test.ts` 的 S6 组直接调用真实的 `hybridEvaluateForCat()`/`productionValueNet()`，并用 `hybridLeafG4Falsification.test.ts` 证明「扰动权重会反转排序」——也就是说这两条断言真的会随模型输出变化而失败。
- `frozenFixtureIntegrity.test.ts` 是一道自检门：任何测试文件重新出现 `readFileSync('ai-training…`、作者本机绝对路径或跨出 `src/` 的相对 import，就会失败。
- 已知 4 个 SKIP：`boundedPlanRefutation.test.ts` 的 §10–§12 需要真实失败语料 `post-g03h-real-failure-5games.txt`，该文件已不在本机且从未入库。按证据纪律**没有**用合成局面替代，也没有删改这些用例，状态记录在该文件注释与 `fixtures/PROVENANCE.json`。

实测记录（2026-10-13 至 10-14）：

- **本机全量串行套件**：7 次真实运行记录 —— 22:33 改动前基线 `23 files / 398 passed / 4 skipped`，64.59 s（`scratch/baseline-suite.txt`）、23:41 改动后 `26 files / 410 passed / 4 skipped`，exit 0，55.19 s（`scratch/final-suite.txt`）、23:13 放宽 timeout 的那次是 P25 翻转失败，131.72 s（`scratch/suite-extended-timeout.txt`）、00:22 与 00:29 两次默认配置运行都是 `1 failed / 409 passed / 4 skipped`，exit 1，失败项始终是 T1E-B E/F/G 的 30 s 超时，129.43 s / 133.17 s（`scratch/final-suite-2.txt`、`scratch/final-suite-3.txt`）。**失败的共同点是整轮耗时 129～134 s，而两次全绿的轮次是 55 s 与 65 s**：失败发生在机器被其它任务占满时（00:22 与 00:29 的空闲内存只有 2.2 GB 与 1.55 GB / 16 GB），不是新增测试引入的。收尾轮 01:13 与 01:14 两次独立全量运行均为 `26 files / 410 passed / 4 skipped`，Duration 52.34 s / 52.27 s，exit 0（`scratch/p0d-full-suite-1.txt`、`scratch/p0d-full-suite-2.txt`；运行前空闲内存 2 662 MB / 2 450 MB，每轮只跑一次不重试）。**上面 00:22 / 00:29 的失败记录按原样保留，没有被改写。**

- **便携性**（2026-10-14 复测）：把「会被提交的仓库内容」复制到临时目录（`git ls-files --cached --others --exclude-standard` 去掉本机 `scratch/` 与 `ai-training.zip` 后的 401 个文件；该目录里没有 `ai-training/`、`g03o_lib.mts`、`dist/`，`node_modules` 单独复制一份）后运行：
  - 10 个关键 AI 套件（120 个用例）→ `10 files passed`，`116 passed / 4 skipped`，exit 0（4 个 SKIP 即上面那份缺失语料的回归）→ `scratch/portability-clean-10.log`。
  - 全量 26 套件（414 个用例）→ `1 failed | 25 passed`，`409 passed / 4 skipped`，唯一失败是 `expectiminimax.test.ts` T1E-B E/F/G 的 30 s 计时超时（该轮整轮 133.93 s，本机 55.19 s）→ `scratch/portability-clean-full.log`。**没有任何用例因为夹具缺失而失败。**
  - 上面引用的 `scratch/*.log` 位于被 gitignore 的目录，只在本机可读；读者请自行运行同样的命令复现（本仓库的 GitHub 内容里本来就没有 `ai-training/`）。
- **夹具保真**：10 份快照夹具与 `ai-training/` 里的权威记录逐条比对为**字节一致**（canonical JSON 全等、`stateKey` 全等、`gameAffectingEqual` 为真、`evaluateForCat` 输出全等），4 份权威文件自身的 sha256 也仍等于 `PROVENANCE.json` 登记值。
- **间歇失败**：`progressGuard.test.ts` 的 P25 与 `expectiminimax.test.ts` 的 T1E-B E/F/G 原先都是**依赖 100 ms deadline 的比较型断言**，在本机负载下会间歇翻面/超时。同一 P25 断言重复 12 次：用未移植的 `ai-training/` 权威局面时翻转 4 次，用仓库内夹具副本时翻转 1 次，两组翻的都是 `LUUU ↔ LLLD` 这一对边界计划——即偶发失败源于 deadline 非确定性，而非夹具失真。收尾轮已把 P25 改走 planner 自带的 `opts.now` 测试注入点（`hardTurnPlanner.ts:162`，同库既有用法），冻结时钟 + 先断言「两侧都没触发 deadline/节点预算、都跑满 `maxDepthTurns: 2`、两次 `totalNodes` 相等」，再比较计划与评价值；生产预算数值与断言强度未降。**T1E-B E/F/G 未改动**：该文件是冻结 checkpoint 的 `BOUND_PRODUCTION_SOURCE` 第 5 项（sha256 `49d1d1bf…`）且属于内容寻址源码身份的三个文件之一，改任一字节都会破坏冻结摘要，因此结构性修复停在「需重新冻结裁定」，本轮只报告成本实测（3 次大搜索 12 293 ms；单次同规格搜索 4 108 ms）。

---

## 已知限制

1. **Hard 决策不是严格确定的**：100 ms 预算意味着同一局面重放可能给出不同计划（历史测量约 5% 量级的根节点决策会翻转），因此「精确重放」类门槛在这台机器上不可满足。相关取证见 `G0.4F-2B-1.9BB`、`G0.4F-2B-1.9BE-R1-TIMING-CAL-*` 文档。
2. **`npm run lint` 现在能跑完，但退出码是 1**：原先 `eslint .` 会连同 9 018 MB 的 `ai-training/`（763 个 `.ts/.tsx`，含 5 份 2.29 MB 的 `hybridWeights.ts` 副本）与 `.r1e-head-control/`（恢复快照，366 个 `.ts/.tsx`）一起解析而耗尽内存。2026-10-14 收尾轮只在 `eslint.config.js` 的 `globalIgnores` 里加了这些非正式源码目录（另含 `build`、`.vite`、`test-results`、`scratch`），`src/`、`src/game/ai/`、`src/game/ai/__tests__/` 与 `scripts/` 全在范围内，规则等级一字未动。实测 6–7 s 跑完、检查 126 个文件，稳定报 **58 errors + 7 warnings（65 problems，12 个文件）**，全部落在本轮未触碰的正式源码（`GamePage.tsx` 30、`scripts/sim-tutorial.ts` 11、`engine.ts` 10 等，主要是 `react-hooks/refs` 与 `no-explicit-any`）。用冻结 checkpoint 那版原配置（只忽略 `dist`）单独 lint `src scripts` 得到**同样的 58/7 与同样 12 个文件**，所以这不是新引入的、也不是被忽略规则掩盖的。按本轮禁改项**只报告不消除**；要让 `npm run lint` 归零需要单独授权改正式源码或规则等级。
3. **`ai-training/`、`dist/`、`CODELY.md` 由仓库策略 gitignore**，克隆后不存在，这是设计而非缺失。
4. 本仓库工作区还有前序研究轮次留下的**本地取证产物**（`scratch/` 155 个条目，其中本轮整改新增 22 个取证文件约 5.8 MB；`ai-training.zip` 2 985 891 470 字节 ≈ 2.99 GB；`.r1e-head-control/` 903 个文件 / 21 MB 的 HEAD 对照快照）。收尾轮（P0-FINAL-CLOSE）已在 `.gitignore` 末尾加入三条**根锚定**规则 `/ai-training.zip`、`/scratch/`、`/.r1e-head-control/`；加规则前核实过 `git ls-files -- ai-training.zip scratch .r1e-head-control` = **0 个已跟踪文件**，加规则后 `git ls-files | wc -l` 仍是 309（没有任何已入库文件被隐藏），本地三份资料**一个字节都没删除、没改动**（删除别人的取证需要单独授权）。这三条规则的作用只是让 `git add` / `git status` 不再一次性面对约 3 GB。`eslint.config.js` 也已把 `scratch/` 与 `.r1e-head-control/` 加入 ESLint 忽略列表（它们不是待检查源码）。
5. 计数口径提示（如实记录，不改写历史）：上一轮「便携性」写的是 `git ls-files --cached --others --exclude-standard` 得 525 项、去掉 `scratch/` 与 `ai-training.zip` 后复制 401 个文件——那时 `.r1e-head-control/` 还没有被 ignore，所以那 401 个文件里含该快照的 78 个文件（`src` 77 + `ctl_probe.mjs` 1）。今天同一命令是 **323 项 = 309 个已入库文件 + 14 个本轮待审的新文件**，不再需要手工剔除。历史测试结果与那两轮的通过/失败记录按原样保留。

---

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [`GAMEPLAY.md`](./GAMEPLAY.md) | 玩法唯一基准（冻结，不得修改） |
| [`docs/REPORTS_INDEX.md`](./docs/REPORTS_INDEX.md) | 根目录 156 份轮次文档的阅读索引：哪些是完成报告、哪些其实是下一阶段任务书、哪些是更正声明 |
| [`docs/REPRODUCIBILITY.md`](./docs/REPRODUCIBILITY.md) | 冻结 checkpoint 的逐文件校验结果、哪些文件已入库、哪些只存在于作者本机、以及「未独立复现」的范围说明 |
| [`FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json`](./FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json) | Formal V2 primary-pass 源码 checkpoint（自述结果，未被本轮整改重跑） |
| `src/game/ai/__tests__/fixtures/PROVENANCE.json` | 测试数据的来源、摘要与缺失件清单 |
