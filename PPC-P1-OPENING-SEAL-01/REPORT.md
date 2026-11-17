# PPC-P1-OPENING-SEAL-01｜证据封口与完整恢复核验

本轮**不修改任何生产源码**，不修改游戏规则与 AI，不跑完整回归、不跑 benchmark。只做三件事：修正归档恢复说明并用真实解包证明可恢复、给深预算测试装上确定性种子、把与原始逐行数据不符的汇总数字改对。

## 最终裁决字段

```text
ROUND = PPC-P1-OPENING-SEAL-01

SOURCE_INTEGRITY        = PASS      （26/26 与上一轮清单一致；本轮只改 1 个测试文件，生产源码 0 改动）
PRE_FIX_STACK_FAILURE   = N/A       （本轮不重复复现；上一轮 REPRODUCED 的原始日志未改动）
ITERATIVE_SOLVER        = UNCHANGED （openingFairness.ts 本轮零改动）

RESTORE_INSTRUCTIONS    = CORRECTED （RESTORE.md 重写：git archive 基线 + 三次覆盖，不再 checkout 真实工作树）
CHECKPOINT_RESTORABILITY= PASS      （26/26 sha/bytes/EOL；缺失 0 / 多余 0；整树 165/165）
PRIOR_ARCHIVES          = UNCHANGED （5cd73282… / a6a7795c… 恢复前后同值）

TEST_DETERMINISM        = FIXED     （OS-2 四个深预算用例改为种子化，随机状态在 finally 恢复）
EVIDENCE_SUMMARY_FIXED  = preFixThrew 0 → 8；原始取证 JSON 未改动

TARGETED_TESTS          = PASS      （27/27 + 相关套件 31/31）
TYPESCRIPT_BUILD        = PASS      （tsc -b exit 0）
FULL_REGRESSION         = NOT_PERFORMED （不必要：生产源码与既有验证合同均未变）

GAME_RULES_CHANGED = NO   SEARCH_MATH_CHANGED = NO   H1_CHANGED = NO   SIDECAR_CHANGED = NO
ABSOLUTE_DEADLINE_GATE = BLOCKED      NEW_EFFICACY_AUTHORITY = NONE
HEAVY_WORKER_CONCURRENCY = 1
COMMIT = NO   PUSH = NO   MERGE = NO
```

## 一、任务一：恢复说明修正 + 完整恢复核验

### 1.1 上一版的错在哪

上一轮 `RESTORE.md` 第 2 步写的是「以 `48eaac6c` 为基线检出仓库：`git checkout 48eaac6c`」。这在本仓库上是**破坏性指令**：真实工作树里有 14 个被修改的跟踪文件、13 个未跟踪的源/夹具文件、10 个未跟踪的取证目录，`git checkout` 会把它们全部丢掉。恢复说明不能要求读者先毁掉待恢复的对象。

修正版把基线改成 `git archive` 导出：`git archive` 只从对象库读 493 个跟踪文件写到仓库外的目录，**不读取工作树、不写工作树、不创建 `.git`**，因此对真实仓库零风险。

### 1.2 修正后的顺序（`RESTORE.md`，以本归档根目录同名文件为准）

| 步骤 | 动作 | 文件数 |
|---|---|---|
| 1 | `git -c core.autocrlf=false archive … 48eaac6c` → 仓库外隔离目录 | 493（= 该 commit 跟踪文件全集，集合双向相等） |
| 2 | 解包 `PPC-P1-CHECKPOINT-01-candidate.tar.gz`，覆盖其 `source/` | 24 |
| 3 | 解包 `PPC-P1-OPENING-STACK-01-candidate.tar.gz`，覆盖其 `files/src/` | 2 |
| 4 | 解包本归档，覆盖其 `files/src/` | 1 |
| 5 | 对 26 个源/夹具逐字节核验 sha256 / 字节数 / 行尾 | 26/26 |
| 6 | 清单双向核对（缺失、多余都必须为 0） | 165 = 153 跟踪 + 12 新增 |

累计写入 27 次，落在 26 个不同路径（`openingFairnessStackSafety.test.ts` 被步骤 3、4 各写一次，后者为准）。这也解释了为什么步骤 3 必须早于步骤 4。

### 1.3 为什么要写 `core.autocrlf=false`

这是本轮**实测踩到的坑**，不是理论：本机 `core.autocrlf=true`，直接 `git archive` 会在导出时做 EOL 转换。实测 `src/game/ai/legalActions.ts` 导出成 **2926 B / 75 个 CRLF**，而仓库里的 blob 是 **2851 B / 纯 LF**。于是「恢复后逐字节比对」在基线上大面积假失败（首次运行 139 个基线文件只有 2 个对上）。

修正两处：导出加 `-c core.autocrlf=false`；同时把比对口径写清楚——**26 个覆盖文件比工作树原始字节**（它们来自归档的二进制拷贝，行尾随之而来），**139 个基线文件比 `git archive` 导出的 blob 身份**，再补一次「EOL 归一后与工作树比对」。三者全符合才算 PASS。

`autocrlf=false` 的代价是：基线里有 **3 个文件**在工作树是 CRLF、在仓库 blob 是 LF，因此恢复出的字节与工作树只在行尾上不同——`src/game/ai/turnLazy.ts`（29878 CRLF / 29164 LF）、`src/game/ai/__tests__/m3MemoryRepair.test.ts`（18562 / 18226）、`src/game/ai/__tests__/planCompletionRepair.test.ts`（9397 / 9207）。三者都在 26 个候选文件**之外**，不影响候选自身的哈希；且 `git status` 视它们为干净（内容相同），所以这不是分歧，是 `autocrlf=true` 的正常表现。整树因此是 162/165 原始字节一致、165/165 行尾归一一致。若改用不带 `-c` 的 `git archive`，这 3 个会「碰巧对上」而另外 136 个全部错——所以宁可显式声明口径。

### 1.4 恢复核验实测结果（`RESTORE_VERIFICATION.json`，由 `probe/verify_restore.mjs` 对**已发布归档**跑出）

```text
base export              : 493 exported / 493 tracked / 集合双向相等 / 无 .git
overlays                 : 24 + 2 + 1 = 27 次写入，26 个不同路径
per-file                 : sha256 26/26、bytes 26/26、EOL 26/26、mismatch 0
file list (bidirectional): expected 165、restored 165、missing 0、extra 0、tracked-missing 0
whole tree               : 覆盖文件 26/26 与工作树原始字节一致
                           基线文件 139/139 与 blob 身份一致
                           与工作树原始字节一致 162/165；其余 3 个仅行尾不同（见 1.3）
                           EOL 归一后 165/165 与工作树一致，工作树独有 0
prior archives           : checkpoint01 5cd73282… 前后同值；openingStack01 a6a7795c… 前后同值
repository untouched     : HEAD 前后同值（48eaac6c）；status 条目数前后同值
=> CHECKPOINT_RESTORABILITY = PASS
```

「整树 165/165」是本轮额外加的：只证明「清单那 26 个对上」还不够，要证明**恢复出来的整棵 `src/` 就是实际跑测试与构建的那一棵**，否则清单之外的文件可以悄悄不一致。

### 1.5 两个旧归档只读

`PPC-P1-CHECKPOINT-01-candidate.tar.gz`（4,051,823 B / `5cd732828856f2b3cd903cc20c584bbb0fec7906d283ec08415bd2653a9425d5`）与 `PPC-P1-OPENING-STACK-01-candidate.tar.gz`（85,538 B / `a6a7795c4f31533a8127ec9e8594a4974aad019b73f69a1421a5c04930c2d015`）**未被覆盖**。核验脚本在解包前后各算一次 sha256 并比对，结果同值。修正后的 `RESTORE.md` 放在本归档根目录，旧包内的错误指令原样保留、由本文件显式取代。

## 二、任务二：深预算测试的确定性种子

### 2.1 问题

OS-2 的四个用例用 `DEFAULT_CONFIG` 调 `createInitialState` / `createGameState`，而 `DEFAULT_CONFIG` 没有显式地形——`createInitialState` 用 `Math.random` 随机撒箱子、货物堆与黄油（`engine.ts:332` / `engine.ts:410`）。所以每次运行认证的是**另一张地图**。深预算的判决恒为 `UNKNOWN / NODE_CAP / exploredNodes=20000`（节点预算封顶，与地图无关），但「恰好稳定」不等于「可复现」，节点计数无法当作求解器性质的测量。

### 2.2 改法（只改测试，不动生产）

参照 `_raw` 里已有的 parity 探针做法：装一个带计数的 LCG 替换 `Math.random`，**只包住一次调用**，`finally` 里无条件还原：

```ts
const OPENING_SEED = 4242;
function withSeededRandom<T>(seedInit: number, fn: () => T): { value: T; draws: number } {
  const native = Math.random;
  let draws = 0, seed = seedInit >>> 0;
  Math.random = () => { draws++; seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  try { return { value: fn(), draws }; } finally { Math.random = native; }
}
```

四个用例（M=100000 认证、M=100000 建局、M=1500/20000、M=1000）全部改成经 `seededOpening()` 取状态，并在**任何断言之前**断言两件事：`draws > 0`（种子真的在起作用，不是没撒地形）和 `Math.random === native`（原生随机已恢复）。`certifyOpening` 放在种子块**外面**执行，证书是在冻结地图上测的。

新增第 27 个用例把这个性质本身钉住：同一种子连建两次 → 抽取次数相同、`stateKey` 相同；换种子 → `stateKey` 不同；并且种子地图仍是合法开局（`validateGameConfig.ok`、`phase=Playing`）。

**没有**缩小节点预算（仍 `maxNodes=20000`）、**没有**删断言、**没有**降深度、**没有**改超时。

### 2.3 一个必须说明的副作用

种子化之后 `M=100000` 的认证从 **25,938ms** 降到 **738ms**，因为固定的那张地图比原先随机抽到的那张便宜得多（同样打满 20000 节点）。**这不是性能提升**，是同一条断言换了地图；判据（`exploredNodes=20000`、`UNKNOWN`、`NODE_CAP`、无 witness）逐条未变。这也反过来证明为什么必须固定地图：同一条测试的墙钟能被地图支配 35 倍。

## 三、任务三：`preFixThrew` 汇总修正

- 记录值 `0`，正确值 `8`（`1500 / 2000 / 2500 / 3000 / 4000 / 6000 / 20000 / 100000` 八档在修复前抛 `RangeError`；`500 / 1000` 两档是 `COMPLETED`）。
- 根因：派生脚本 `probe/assemble_results.mjs` 用 `outcome === 'THROW'` 精确匹配，而原始行记的是 `'THROW RangeError'`，谓词永远不成立。
- 处置：① 直接改证据 JSON 的 `thresholdSweep.summary.preFixThrew`，并附加 `preFixThrewDerivation` 与 `corrections[]`（含原因、原始来源 sha256）；② 同时把派生脚本的谓词改成 `startsWith('THROW')`，避免以后重跑又错。
- **原始取证数据未改动**：`_raw/stack_threshold_pre.json` 的 sha256 仍为 `071440717d4473f0960a297ab2e805643dd26750e84f7f5f3ad0cb1855cb4ab6`。
- 修正前的字节可从只读归档逐字节取回并核对：`./files/PPC-P1-OPENING-STACK-01/DEEP_STACK_RESULTS.json` → sha256 `ee74e832aba34fb72e68500ef18888506eb0e47bb7de1ef870d039948038cb41`（副本存于 `_raw/from_archive/`）。
- 同轮复核了相邻汇总字段，均本已正确：`preFixCompleted=2`、`postFixCompleted=10`、`postFixThrew=0`、`postFixAllUnknownNodeCap=true`。

## 四、定点测试与构建

| 项 | 结果 |
|---|---|
| `src/game/__tests__/openingFairnessStackSafety.test.ts` | 27/27 passed，Test Files 1 passed，33.84s（tests 32.37s） |
| `src/game/__tests__/openingFairness.test.ts` + `smallBoardConfig.test.ts` | 2 files / 31 tests passed，2.99s |
| `npx tsc -b` | exit 0，无输出 |
| 完整 1026 项回归 | NOT_PERFORMED —— 生产源码零改动、既有验证合同零改动，按任务书不重跑 |

日志：`logs/01_sealed_test_file.log`（种子化后的测试文件）、`02_source_manifest.log`、`05_related_suites.log`、`06_restore_verification_final.log`（对已发布归档的完整解包核验 transcript；按设计留在仓库目录，不入包）。

## 五、本轮没有做的事

- 没有改任何生产源码：`git status` 仍是进入本轮前的样子（14 个已修改跟踪文件、13 个未跟踪源/夹具文件、10 个未跟踪取证目录，另加一个全程未触碰的 `.doc`），`src/game/openingFairness.ts` 的 sha256 与上一轮清单一致。
- 没有改 H1 / Search Math / TT / Move Ordering / Sidecar / 陷阱策略 / GAMEPLAY 规则 / 100ms / 150ms。
- 没有 commit / push / merge / reset / clean / stash / checkout；HEAD 仍 `48eaac6c4f3801d351787696ba5876995b64e8d8`。
- 没有覆盖两个旧归档；没有跑完整回归、self-play、oracle、benchmark。

## 六、交付物

| 文件 | 内容 |
|---|---|
| `REPORT.md` | 本报告 |
| `RESTORE.md` | **修正后的恢复顺序**（取代旧归档内同名文件） |
| `SOURCE_MANIFEST.json` | 26 个源/夹具的最终 sha256 / 字节 / 行尾；本轮唯一改动文件的前后对照；三个归档哈希 |
| `RESTORE_VERIFICATION.json` | 对已发布归档的一次完整解包核验（机器生成，仓库目录内） |
| `EVIDENCE_CORRECTIONS.json` | `preFixThrew` 修正的字段级账本（含原始来源哈希与修正前后字节哈希） |
| `ARCHIVE_SHA256.txt` | 本归档自身的 sha256 / 字节 / 成员数（打包后计算——包内不能含自身哈希） |
| `probe/verify_restore.mjs` | 可重复执行的恢复核验脚本（`node verify_restore.mjs <归档> <仓库外目录>`） |
| `probe/build_source_manifest.mjs`、`probe/build_archive.mjs` | 清单与归档的生成脚本 |
| `logs/` | 全部原始运行日志（恢复核验的运行记录按设计留在仓库目录，不入包——每次运行都会重写自己的 transcript，入包会让归档描述另一份归档；见 `CHECKPOINT_MANIFEST.excludedOnPurpose`） |
| `_raw/pre_state.json`、`_raw/from_archive/` | 开工前的 26 文件哈希与归档哈希；修正前的证据字节 |

归档成员、字节与 sha256 见包内 `CHECKPOINT_MANIFEST.json` 及包外 `ARCHIVE_SHA256.txt`。
