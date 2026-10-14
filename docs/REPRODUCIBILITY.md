# 可复现性说明（源码 checkpoint 与测试数据的真实可校验范围）

> 本文件由 P0 工程可信度整改新增（2026-10-13）。所有「已验证」字样都指**本轮在同一台机器上实际重算过的结果**，不是引用他人结论。

## 一句话结论

`FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json` 里一共写了 **21 条文件引用**（`BOUND_PRODUCTION_SOURCE` 6 条 + `DIGEST_BOUND_FORMAL_TOOLING` 14 条 + `T1G_FINAL_ARTIFACT` 1 条），它们指向 **20 个不同文件**：`T1G_FINAL_ARTIFACT` 与 14 条工具项中的最后一条是**同一个路径**（`ai-training/f2b19be-r1-formal-pregrid-v2/t1g/formal_v2_t1g_primary_1700_pair_authority_v1.json`），所以它是第 21 条*引用*，不是第 21 个*文件*。

```
UNIQUE_BOUND_FILES          = 20   = 6 生产源码 + 14 形式化工具/产物
CHECKPOINT_FILE_REFERENCES  = 21   = 上面 20 个 + 最终产物被重复引用 1 次
```

口径由仪器重新产出（`node -e` 读 checkpoint 后计数：`refs=21`、`unique=20`、`tool.includes(artifact)=true`、生产列表与工具列表内部均无重复）。

**本轮实测：21 条引用的摘要与本机字节全部一致（20 个不同文件各校验 2 次或 1 次，无一条 MISMATCH）；其中只有 6 件生产源码在 Git 里，其余 15 条引用（14 个不同文件）全部位于 gitignore 的 `ai-training/`。**

因此：

- ✅ 一个 GitHub 克隆可以**校验**冻结源码是不是那 6 个字节。
- ❌ 一个 GitHub 克隆**无法重跑** Formal V2 primary-pass 的任何环节（重放信封、broker、T1G worker/analyzer/supervisor/sampler、契约与 plan JSON、1700 配对权威文件都不在仓库里）。
- ⚠ 该 checkpoint 自述的 `T1G_FORMAL_V2_PRIMARY_AUTHORITY = PASS` / `T1G_PRIMARY_RESULT.*` **不是本轮独立复现的结果**，本轮既没有重跑基准（`HEAVY_BENCHMARK_RUN: false`），也没有重跑主实验（`PRIMARY_RERUN: false`）——这两个字段是 checkpoint 自己写的。同一文件另有 `NOT_A_PERFECT_PLAY_PROOF` 字段，意为「这不构成 Perfect Cat 的证明」。

## 怎么自己校验（轻量，不跑实验）

```bash
node scripts/verify-source-checkpoint.mjs
```

脚本只读 checkpoint 里声明的路径与 `sha256`，对工作树重算摘要，并用 `git ls-files` 判断该文件是否入库。它**不重跑任何实验、不重新生成任何数据**。

实测输出（本机 2026-10-14 01:10 两次运行，逐字相同；`CHECKPOINT_FILE_REFERENCES` / `UNIQUE_BOUND_FILES` 两行由脚本自己计数产出，不是人工填写）：

```
production-source files declared : 6
  committed in git + digest MATCH: 6
tooling/artifact files declared  : 15
  absent on this clone (gitignored ai-training/): 0
  present + digest MATCH         : 15
CHECKPOINT_FILE_REFERENCES       : 21  (6 production + 14 tooling + 1 duplicate ref to the final artifact)
UNIQUE_BOUND_FILES               : 20  (the final artifact is one of the 14, not a 21st file)
problems (MISMATCH / tracked-but-missing): 0

VERDICT: DIGEST_CONSISTENT_FOR_COMMITTED_SOURCE  (this verifies bytes only — it is NOT a re-run of any experiment and NOT an independent reproduction of any PASS)
```

（`absent … : 0` 是因为这台机器保留了 `ai-training/`。在一个干净克隆里这 15 条会变成 `ABSENT-LOCAL-ONLY`，判定不变——判定只约束已入库的源码。）

## 已入库、可校验的冻结源码（6 件，全部 MATCH + committed）

期望摘要的来源是 checkpoint 自身（`BOUND_PRODUCTION_SOURCE[i].sha256`），此处不重复抄写以免与本文件产生新的漂移；下表只给路径、角色、本机字节数与状态。

| 路径 | 角色（checkpoint 自述） | 字节 | 状态 |
| --- | --- | --- | --- |
| `src/game/engine.ts` | 规则内核 + 猫 AI 路由 | 171 021 | MATCH / committed |
| `src/game/ai/expectiminimax.ts` | Hard 搜索内核 | 103 314 | MATCH / committed |
| `src/game/ai/forcedLossTieBreak.ts` | 强制负局破平 | 3 996 | MATCH / committed |
| `src/game/ai/hybridWeights.ts` | 冻结 ValueNet 权重（808→128→64→1） | 2 391 157 | MATCH / committed |
| `src/game/ai/__tests__/expectiminimax.test.ts` | 搜索/计时回归 | 158 535 | MATCH / committed |
| `GAMEPLAY.md` | 玩法唯一基准 | 12 661 | MATCH / committed |

`GAMEPLAY.md` 与上面 5 个源码文件在本轮整改中**一个字节都没有改动**（P0 禁改项）。

## 只存在于作者本机的部分（15 条声明 = 14 个不同文件，全部 MATCH / 未入库）

下面第 1 组 14 条是 14 个不同文件；第 2 组那 1 条与第 1 组最后一条同路径，因此本机侧「需要校验的文件」是 14 个，而 checkpoint 里的「引用行」是 15 行。校验脚本按引用行逐条重算，所以它的输出写的是 `declared : 15`（同一路径会被打印两次，见上面输出里 `TOOLING` 与 `ARTIFACT` 各出现一次的那行）。

| 组 | 条数 | 位置 | 克隆后的状态 |
| --- | --- | --- | --- |
| `DIGEST_BOUND_FORMAL_TOOLING` | 14 | `ai-training/c1/`、`ai-training/f2b19be-r1-formal-pregrid-v2/**`（recorder、envelope、`t1d_broker.mjs`、`t1g_task.ts`、`t1g_analyze.ts`、两个 `dist/*.mjs`、`remote/t1g_{supervisor,sampler,proc}.mjs`、`T1G_PRIMARY_CONTRACT.json`、`t1g_plan.json`、1700 配对权威 json） | 缺失（`.gitignore:24` 明确忽略 `ai-training/`） |
| `T1G_FINAL_ARTIFACT` | 1（路径与上面最后一条相同） | `ai-training/f2b19be-r1-formal-pregrid-v2/t1g/formal_v2_t1g_primary_1700_pair_authority_v1.json`（6 673 字节） | 缺失 |

checkpoint 的 `NOT_COMMITTED_ON_PURPOSE` 自述理由是「仓库策略 + 本轮分类：大体积/轮次产物不属于源码 checkpoint」，并列出被策略忽略的两项 `ai-training/** (.gitignore:24)` 与 `dist/ (.gitignore:2)`。这与实测一致，**不是**漏提交。

## 行尾（CRLF）与字节一致性

本机 `core.autocrlf=true` 且仓库没有 `.gitattributes`，因此「工作树显示为修改」并不等于内容漂移（本轮 `git status` 里被标成 `M` 的 src 文件即属此类）。对冻结字节真正要紧的是 git blob 与工作树是否同摘要，本轮用 3 个代表文件实测：

| 文件 | 工作树 sha256 | `git show HEAD:<path>` sha256 | 相同 |
| --- | --- | --- | --- |
| `src/game/engine.ts` | `8e923666…` | `8e923666…` | ✅ |
| `GAMEPLAY.md` | `1b19a8b5…` | `1b19a8b5…` | ✅ |
| `src/game/ai/hybridWeights.ts` | `70b1e09e…` | `70b1e09e…` | ✅ |

结论：这三件在克隆里得到的字节与本机一致，摘要校验不会被行尾转换破坏。（其余文件如需严格结论，请对每个文件重跑同一比较。）

## 测试数据的可复现性

- 5 个测试文件原先用 14 处 `readFileSync('ai-training/…')` 直接读本机目录（`correctedHoleLeaf` 3 处、`hybridGhostDomainSafety` 4 处、`hybridRouteLeaf` 4 处、`progressGuard` 2 处、`m3liteHumanValidationLogging` 1 处；这 5 个文件共 79 个用例）。现在这些读取全部改指 `src/game/ai/__tests__/fixtures/` 内的仓库副本，**断言与期望值一字未改**。复核方式：`src/` 下已不存在任何对 `ai-training/` 的实际读取（剩下的匹配全是注释、夹具里的 `origin` 溯源字符串，以及 `frozenFixtureIntegrity.test.ts` 自己的检测正则）。
- `hybridLeaf.test.ts` 原本不读 `ai-training/`（只在注释里提到 `ai-training/ts-bridge/valuenet_infer_opt.ts`）；它的问题是 P0-1 的 S6 伪造，不属于便携性缺陷。
- 夹具加载器 `fixtures/frozenFixtures.ts` 会在还原时校验每条记录的 `snapshotSha256`、`stateKey` 与关键局面字段，不匹配就抛错，绝不静默降级。
- 夹具与权威的逐条保真比对（10 份快照，canonical JSON 全等 / `stateKey` 全等 / `gameAffectingEqual` 真 / `evaluateForCat` 输出全等）与 4 份权威文件 sha256 复算，本轮**实测通过**。方法可复述：对 10 份记录分别用 `restoreHardRoot(权威 snapshot)` 与 `restoreFrozenState(夹具)` 还原后比较上述四项；另对 4 份权威文件重算 sha256 与 `PROVENANCE.json` 登记值比较。该比对本身必须读 `ai-training/`，所以它是**一次性取证**，没有做成提交进仓库的测试（否则会破坏便携性自检 `frozenFixtureIntegrity.test.ts` 的「测试不得读 gitignore 目录」规则）。
- 便携性实测：把「本仓库会被提交的内容」——`git ls-files --cached --others --exclude-standard`（525 项）里再剔掉本机 `scratch/` 与 `ai-training.zip` 后的 **401 个文件**——复制进一个临时目录（其中 `ai-training/`、`g03o_lib.mts`、`dist/`、`CODELY.md` 均不存在，`node_modules` 单独复制一份），在该目录里运行：
  - **关键 10 个 AI 套件（120 用例）**：`Test Files 10 passed (10)`，`Tests 116 passed | 4 skipped`，exit 0 → 日志 `scratch/portability-clean-10.log`。
  - **全量 26 套件（414 用例）**：`1 failed | 25 passed (26)`，`409 passed | 4 skipped`，exit 1 → 日志 `scratch/portability-clean-full.log`。唯一失败是 `expectiminimax.test.ts` 的 T1E-B E/F/G 超过 30 s 默认 timeout（该轮整轮 133.93 s，本机同套件 55.19 s：冷缓存 + 单进程）；**没有任何用例因为夹具或权威文件缺失而失败**。
  - 另两次早期样本供参考：`scratch/portability.log`（10 套件，P25 出现一次 `LUUU ↔ LLLD` 翻转，`1 failed | 115 passed | 4 skipped`）与 `scratch/portability-2.log` / `scratch/portability-full-2.log`（同一结构的复测）。翻转与超时都是下一节第 1 条的 deadline 计时门，不是便携性缺陷。
  - **任何读者都能自行复现**：`git clone` 本仓库 → `npm install` → `npx vitest run --maxWorkers=1 --no-file-parallelism`；GitHub 内容里本来就没有 `ai-training/` 与 `g03o_lib.mts`。注意上面引用的 `scratch/*.log` 在被 gitignore 的目录里，只作为本机取证，不是读者可以打开的仓库文件。
- **重要口径**：上面这些隔离环境运行是把本机现成的 `node_modules` 复制进临时目录后跑的。**「复制 `node_modules` 的隔离环境测试」不等于「全新安装依赖后的完整验证」**——它只证明「仓库内容本身不再依赖被 gitignore 的夹具」，不证明 `package.json` / `package-lock.json` 能被一次干净安装完整还原（未验证 lockfile 与新装版本的依赖可解析性、可选 postinstall 脚本、平台相关二进制包）。要做后一条需要另行授权一次 `npm ci` 全新安装运行。
- 唯一缺失件：`g03o_lib.mts`（也被 gitignore，`.gitignore:117`）所指向的真实失败语料 `post-g03h-real-failure-5games.txt`。它**从未入库且已不在本机**，因此 `boundedPlanRefutation.test.ts` 的 4 条回归保持 SKIP，记为 `BLOCKED`。没有用合成局面替代，也没有凭记忆重建。

## 已知的不可复现项（不是整改没做完）

1. **100 ms deadline 使 Hard 决策本身不确定**。比较型断言因此在负载下间歇翻转：实测 `progressGuard.test.ts` P25 重复 12 次，用**未移植的权威局面**时 4 次翻转，用**仓库内夹具副本**时 1 次翻转，翻的都是 `LUUU ↔ LLLD` 同一对边界计划。这说明夹具没有失真，翻面来自时钟。
   2026-10-14 收尾轮的处理：P25 已改用 planner 自带的测试时钟注入点（`hardTurnPlanner.ts:162` 的 `opts.now`，同库 `boundedPlanRefutation.test.ts:125`、本文件 P2/P3/P20 早就在用）把时钟冻结为 `() => 0`，并**新增**了「`deadlineFired === false`、`budgetFired === false`、`completedDepth === 2`、两次 `diagnostics.totalNodes` 相等」四道前置断言，先证明两侧都跑满了 `maxDepthTurns: 2`，再比较计划与评价值——即这条用例现在检验的是**语义一致性**而不是两次独立墙钟搜索偶然到达的深度。生产侧的 `timeBudgetMs: 100` 字面值、`maxDepthTurns`、评价函数与搜索器都未改动，原有一条计划比较 + 一条评价值比较断言都保留。真实墙钟预算路径仍由 `productionGhostRuleSet.test.ts` 的 P11（不注入 `now`，直接跑一次 100 ms 生产回合）与 `expectiminimax.test.ts` 的 deadline 节律用例覆盖。
   仍未解决的是 `expectiminimax.test.ts` 的 **T1E-B E/F/G** 计时门：该文件是 checkpoint 的 `BOUND_PRODUCTION_SOURCE` 第 5 项（sha256 `49d1d1bf…`，role 自述「seam tests (self-calibrating deadline expectations)」），同时是 `CONTENT_ADDRESSED_SOURCE_IDENTITY.changedTrackedFiles` 三个文件之一，**改它任何一个字节都会破坏冻结摘要与那份 1700 配对主结果的源码身份**，因此本轮按禁改项停在报告状态、未做结构调整。成本实测（本机 3.0 GB 空闲，verbose reporter，同文件 89 用例全绿 43 s）：该用例 3 次「depth 4 / 无 TT / 无 α-β / 无排序 / maxNodes 1e6」大搜索合计 **12 293 ms**；单次同规格搜索 **4 108 ms**（见 §15 用例），相邻的 A/B/K 与 L 各 2 次搜索 = 8 277 ms / 8 232 ms。据此，「合并前两次重复搜索 + 拆成两个用例」会把每个用例压到 1～2 次搜索（约 4.1–8.2 s 空闲），在慢机状态（见下：慢轮整轮耗时约为快轮的 2.3–2.4 倍，且本机墙钟存在约 5 倍的两态漂移）下才可能稳定低于 30 s；只合并而不拆分（≈8.2 s 空闲）不足以覆盖慢态。此改动需要一次重新冻结裁定，不属于本轮授权范围。
   本机与临时目录里共 8 次全量串行运行（`--maxWorkers=1 --no-file-parallelism`）真实记录：① 22:33 改动前基线 `23 files / 398 passed / 4 skipped`，64.59 s（`scratch/baseline-suite.txt`）；② 23:13 放宽 timeout 的一次运行 `progressGuard.test.ts` P25 翻转失败（`scratch/suite-extended-timeout.txt`）；③ 23:41 以默认配置运行 → **26 files 全绿，410 passed / 4 skipped（414）**（`scratch/final-suite.txt`）；④ 00:17 在只含仓库内容（无 `ai-training/`）的临时目录里 → `1 failed | 25 passed (26)`，失败项是 T1E-B E/F/G 的 30 s 超时（`scratch/portability-clean-full.log`）；⑤ 00:22 回到本机重跑 → 同样 `1 failed | 409 passed | 4 skipped`，失败项仍是 T1E-B E/F/G 超时（`scratch/final-suite-2.txt`）；⑥ 00:29 交付前再跑一次 → **仍然 `1 failed / 409 passed / 4 skipped`，同一个 T1E-B E/F/G 超时，整轮 133.17 s**（`scratch/final-suite-3.txt`）。②④⑤⑥ 都是负载相关的间歇失败，不是已被修复的缺陷，也没有被任何配置改动掩盖：**失败的那几轮整轮耗时 129～134 s，全绿的轮次是 55 s 与 65 s**，而 00:22 与 00:29 两次运行时系统空闲内存分别只剩 2.2 GB 与 1.55 GB（同机有别的大任务在跑）。
   收尾轮（2026-10-14）新增两次全量串行运行，均为**单次执行、未重试**：⑦ 01:13 `26 files / 410 passed / 4 skipped`，Duration 52.34 s，exit 0（`scratch/p0d-full-suite-1.txt`，运行前空闲内存 2 662 MB）；⑧ 01:14 同样 `26 files / 410 passed / 4 skipped`，Duration 52.27 s，exit 0（`scratch/p0d-full-suite-2.txt`，运行前空闲内存 2 450 MB）。**这两轮绿色不等于问题已消除**：P25 的翻面来源是被结构性地消除了（冻结时钟 + 深度/预算前置断言，见上），而 T1E-B E/F/G 仍然只是「在这次机器状态下 12 s 级别地跑进了 30 s 门限」，其结构缺陷因冻结摘要未能修改。①～⑧ 里凡是失败的历史记录都按原样保留，没有任何一条被改写或删减。
2. **全仓 ESLint 现在可以跑完了，但它不是零报告**：`eslint .` 原先连同 8.9 GB 的 `ai-training/`（本机实测 9 018 MB，其中 763 个 `.ts/.tsx`，含 5 份 2.29 MB 的 `hybridWeights.ts` 副本）与 `.r1e-head-control/`（恢复快照，366 个 `.ts/.tsx`）一起解析而耗尽内存。2026-10-14 收尾轮只在 `eslint.config.js` 的 `globalIgnores` 里增加了这些非正式源码目录（`dist`、`build`、`.vite`、`test-results`、`ai-training`、`scratch`、`.r1e-head-control`），规则等级与 `files: ['**/*.{ts,tsx}']` 范围未改动。**实测（2 次独立运行 + 1 次 JSON 运行，同机 3.0 GB 空闲）**：`npx eslint .` 6–7 s 跑完、不再 OOM，共检查 126 个文件，结果稳定为 **58 errors + 7 warnings（65 problems），分布在 12 个文件**，全部位于本轮未触碰的正式源码；因此 `npm run lint` 退出码是 **1，不是 0**。用 checkpoint 那版原始配置（只忽略 `dist`）单独对 `src scripts` 复核，得到**同样的 58 errors / 7 warnings / 同样 12 个文件**，证明这些报告既不是新增的，也不是被忽略规则掩盖的。7 条 warning 里没有解析错误，全部是「unused eslint-disable 指令」（`hybridWeights.ts` 文件头的两条在 ESLint 10 / typescript-eslint 8 下已不再需要，`EditorPage.tsx`、`TutorialPage.tsx` 各若干条）。按本轮禁改项，这些正式源码问题**只做报告，不通过降规则、扩大忽略范围或改动正式源码来消除**。
3. **Formal V2 primary-pass 的执行环境**：其工具链与产物见上一节，均不在仓库内；相关轮次本身也记录了 `TIMING_ENVIRONMENT_NOT_COMPARABLE` 等阻断结论（见 `G0.4F-2B-1.9BE-R1-*` 系列文档）。

## 交付检查清单（本轮）

- [x] `node scripts/verify-source-checkpoint.mjs` → 6/6 已入库生产源码摘要一致，15/15 本机工具引用 MATCH，0 问题，exit 0；并打印统一计数口径 `CHECKPOINT_FILE_REFERENCES = 21` / `UNIQUE_BOUND_FILES = 20`（01:10 两次运行逐字相同）
- [x] 6 件 digest 绑定文件 + `GAMEPLAY.md` 与 HEAD 无内容漂移（`git status` 中它们未被标记）
- [x] 夹具 ↔ 权威逐条保真比对通过（含 4 份权威文件 sha256 复算）
- [x] 只含仓库内容的临时目录（401 个文件，无 `ai-training/`）中：10 个关键套件 `116 passed / 4 skipped`，exit 0（`scratch/portability-clean-10.log`）；全量 26 套件 `409 passed / 1 failed / 4 skipped`，唯一失败是 T1E-B E/F/G 的 30 s 计时超时（`scratch/portability-clean-full.log`）
- [x] `frozenFixtureIntegrity.test.ts` 通过：没有测试重新读取 gitignore 目录、作者绝对路径或跨出 `src/` 的 import
- [x] `npm run build`（`tsc -b && vite build`）通过，87 modules，产物 `dist/assets/index-CwsTdLRG.js`（vite 打印 2 673.65 kB，磁盘实际 2 679 934 字节；两处数字口径不同，都如实记录），2026-10-14 00:20、00:26 与收尾轮 01:11 三次构建 bundle 名与字节数相同
- [x] 上一轮触碰的 14 个文件（10 个 `*.test.ts` + `fixtures/frozenFixtures.ts` + `fixtures/g4Goldens.ts` + 2 个 `scripts/*.mjs`）用 `npx eslint` 一次检查 → 无告警无错误，exit 0
- [x] 收尾轮触碰的 3 个文件（`eslint.config.js`、`src/game/ai/__tests__/progressGuard.test.ts`、`scripts/verify-source-checkpoint.mjs`）单独 `npx eslint` → exit 0；全仓 `npm run lint` 见「已知的不可复现项」第 2 条（不再 OOM，但正式源码原有 58 errors / 7 warnings 使退出码为 1）
- [x] `npx tsc -b`（两个 project 都是 `noEmit: true`，纯类型检查）→ exit 0
- [x] 全量串行套件：上一轮（P0 整改）交付时刻**并非全部通过**——默认配置三次运行里 23:41 那次 `26 files / 410 passed / 4 skipped` exit 0，但 00:22 与 00:29 两次都是 `1 failed / 409 passed / 4 skipped` exit 1，失败项始终是 `expectiminimax.test.ts` T1E-B E/F/G 的 30 s 计时超时；这条历史结论按原样保留，没有为了文档好看而改写。收尾轮（2026-10-14 01:13 / 01:14）两次独立全量运行为 `26 files / 410 passed / 4 skipped`，Duration 52.34 s / 52.27 s，exit 0；其成因是 P25 被改成冻结时钟的语义比较，而 T1E-B E/F/G 仍只是「在这次的机器状态下 12.3 s 通过了 30 s 门限」，其结构性缺陷因该文件被 checkpoint 摘要绑定而未动（详见「已知的不可复现项」第 1 条）。全量运行每轮单次执行、未重试碰运气，`--maxWorkers=1 --no-file-parallelism` 单进程串行。
- [x] 4 条 SKIP 仍是 `boundedPlanRefutation.test.ts` 的 G0.3W 真实语料回归（夹具缺失后 `ctx.skip()`），**记为 BLOCKED，不计入通过**；`410 passed + 4 skipped = 414` 的口径在所有轮次一致
- [x] 断言完整性核对：5 个被改接夹具的测试文件里共减少 10 行 `expect(`，全部是被删掉的**本地加载器 helper 内的存在性断言**（`expect(entry).toBeTruthy()` / `expect(goodSnap)` / `expect(rec)`），其职责由 `frozenFixtures.ts` 的「记录缺失即抛错 + sha256/stateKey/关键字段校验」取代（更严格）；**没有删除或弱化任何关于玩法、搜索或评价语义的断言**
- [x] 用例数量核对（如实记录）：`hybridLeaf.test.ts` 相对 HEAD 少了 2 个 `it` 声明，共 4 个旧用例名消失 —— `S5: nonfinite ValueNet result falls back…` 改名为 `S5: computeHybridFromParts returns NaN for nonfinite ValueNet; clamps nonfinite eval`；`S6: … pinned hybrid values from the frozen authority`（正是 P0-1 指出的伪造金样）替换为 `S6: … the LIVE production Hybrid V1 evaluator on the restored frozen states`；`S7: catAiMove…` 与 `S7: computeCatAiTrajectory…` 两条只验证「模式开关/函数身份」的接线断言迁移进新文件 `hybridLeafCallObservation.test.ts`，在那里变成 8 条行为观测（O1–O7，含「被搜索真正调用的求值器算出的是模型值」与「域外局面在搜索内部逐点 fail-closed」）。本轮同时**新增 3 个文件共 14 个用例**（`frozenFixtureIntegrity` 4 + `hybridLeafCallObservation` 8 + `hybridLeafG4Falsification` 2），所以套件总数是 402 → 414（净 +12 = 新增 14 − 上面被替换/迁移的 2）。**没有为了变绿而删掉的用例。**
- [ ] 4 条 G0.3W 真实语料回归复现 —— **BLOCKED**（原始语料已丢失，需作者重新提供 `post-g03h-real-failure-5games.txt`）
- [ ] Formal V2 primary-pass 独立重跑 —— **未执行**（属重基准，超出本轮授权范围，且工具链不在仓库内）

## 提交整理轮（P0-FINAL-CLOSE，2026-10-14）

本轮只做「让提交不会误吞大体积本地资料 + 显式暂存已审阅文件 + 导出审核补丁」，**没有**修改任何测试、算法、benchmark、冻结文件，也**没有**运行新的 benchmark 或重复全量测试（按作者裁定：58 条 lint error 作为已记录的既有债务接受；T1E-B E/F/G 保留冻结文件与原 30 s 限制；`correctedHoleLeaf` 的同类墙钟测试不动；4 条 SKIP 继续记 BLOCKED）。

- **`.gitignore` 三条新根规则**：`/ai-training.zip`、`/scratch/`、`/.r1e-head-control/`。加规则前的前置核实：`git ls-files -- ai-training.zip scratch .r1e-head-control` → **0 个已跟踪文件**（所以规则不会让任何已入库内容消失）；加规则后 `git ls-files | wc -l` 仍是 309，`git check-ignore -v` 三条分别命中 `.gitignore:167/168/169`。**本地资料一律保留**：`ai-training.zip` 2 985 891 470 字节、`scratch/` 155 个条目、`.r1e-head-control/` 903 个文件，一个字节都没删除或改动。
- **计数口径联动（不改写历史）**：上述三份目录/文件此前未被 ignore，因此「便携性」那两条历史记录里的 `525 项 / 去掉 scratch 与 ZIP 后 401 个文件` 是当时的真实测量，予以保留；今天同一条命令 `git ls-files --cached --others --exclude-standard` 输出 **323 项 = 309 个已入库 + 14 个本轮待审新文件**，不再需要手工剔除（README「已知限制」第 4/5 条同步记录）。
- **暂存方式**：逐条 `git add <path>`，未使用 `git add -A` / `git add .` / `git add -f`；未暂存 `ai-training/`、`scratch/`、ZIP、缓存或恢复快照。
- **补丁导出**：`git diff --cached --output=scratch/p0-final-staged.patch`（由 git 自己写字节，避开 PowerShell 旧版文本重定向的 UTF-16/换行改写），配套清单 `scratch/p0-final-staged-summary.txt`。
- **状态**：本轮**未 commit、未 push**，停在已暂存待审核。
