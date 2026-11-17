# PPC-P1-CLOSURE-01｜四轮正确性修复集成审计与遗留失败定性

日期：2026-11-13
分支：`ppc/p1-id-state-identity-fix`　HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`
本轮：**只读审计**（0 生产源码改动、0 commit/push/merge、0 重型实验）

---

## 一、人话总结

四轮的改动是**干净且互不打架**的。七个冻结文件的指纹与任务书给的前缀逐一对上，每处改动都能明确归到某一轮，没有出现"同一段代码被两轮各改一半"的情况。

两个红着的测试，**都不是引擎的错**，而且**都不是这四轮造成的**：

1. **T1E-B 是超时，不是算错。** 这个用例要做两次"无剪枝、深度 4、上限 100 万节点"的穷举搜索，它自己没写超时，沿用全局的 30 秒。2026-11-12 那台机器跑这个约 18.5 秒，通过；今天同样的代码要跑约 40 秒，所以撞线。我把六个生产文件逐字节回退到 HEAD 做了一个冻结对照臂——**旧代码今天也撞线，42.37 秒**，当前候选 43.41 秒，差 1 秒。给足时间后两臂都通过（39.73s / 41.88s），断言内容一模一样。所以：机器慢了约 2.2 倍，不是代码慢了。

2. **FLT-HV14-4 是黄金值过期，不是引擎算错。** 这个用例要求"在当前深度重跑，结果要等于当年人类验证日志里记的那个值"。日志对 GAME3 T4 记的是 `-1052.947`（无将死），当前引擎给 `999996`（猫将死）。我用真实引擎把这一步的**全部 212 条合法猫动作序列**穷举了一遍，第 4 步内**有且只有一条**杀法：`下 下 下 左`，猫站到 (8,0) 把老鼠关在左下角。老鼠那边四个方向：上是猫、下和左是边界、右是箱子——它一步都走不了。这是**真的将死**，不是估值错觉。而当年日志里的构建走的是 `下 右 右 右`，**把这一局放掉了**。

   换句话说：**引擎比当年那份日志更强了，所以那份日志不再是它的完全可复现基线。** 45 个根里 44 个逐值复现，只有这一根不一致，而这一根恰恰是引擎变强的地方。

**四轮候选具备建立本地 checkpoint 的条件。** 技术上没有阻塞项；真正需要决定的是一件事——要不要承认 HV14 那份取证语料里的这一根已经作废（改它属于动冻结取证，需要授权）。绝对时限权威仍然缺失，`ABSOLUTE_DEADLINE_GATE` 保持 `BLOCKED`。

---

## 二、第一阶段：工作区与来源审计

### 2.1 七项指纹：全部一致

| 文件 | 实测（前 8 位） | 任务书预期 | 字节 |
|---|---|---|---|
| `transposition.ts` | `7b4aa8eb` | `7b4aa8eb` ✅ | 6784 |
| `deadlineContext.ts` | `ced44944` | `ced44944` ✅ | 14411 |
| `hardTurnPlanner.ts` | `27b1ce6d` | `27b1ce6d` ✅ | 36060 |
| `engine.ts` | `dbb5377a` | `dbb5377a` ✅ | 188461 |
| `planBound.ts` | `99c269f9` | `99c269f9` ✅ | 4193 |
| `expectiminimax.ts` | `42b6e71f` | `42b6e71f` ✅ | 107383 |
| `planQuality.ts` | `f97dd204` | `f97dd204` ✅ | 28873 |

### 2.2 manifest 交叉核对：30 条声明，0 处真实分歧

四份 `SOURCE_MANIFEST.json` 的全部 path+sha 逐条与磁盘比对：**28 条直接命中，2 条属于"被后续轮次覆盖"**（`planQuality c777b1bc → f97dd204`、`expectiminimax 9b976ec9 → 42b6e71f`），时序解释得通，不是不一致。

**一个缺口**：`PPC-P1-ID-01/` 没有 `SOURCE_MANIFEST.json`——四轮里唯一缺 manifest 的正好是第一轮。它的 `transposition.ts` 指纹靠两处互证（该轮 REPORT.md 与 P1-TIME-01 的 `p1IdCandidate`，均与实测相同），结论不受影响，但建 checkpoint 前应补上。

### 2.3 历史工件：全部在，没有被覆盖

24 根人类根 fixture `1a59787a`、D1 基线 `80635906`、P1-TIME-01 基线 `2c1bab71`、`TIMING_RESULTS.json` `74ff5aff`、5 份 HV14 日志（与测试内 `LOG_SHA256` 表逐份相同）——**全部未变**。无关的 `.doc` 文件 `505bd083…`，89600 B，mtime 仍是 `2026-10-16 20:50:04`，**未触碰**。

### 2.4 工作树：10 个修改 + 17 条未跟踪，**不是 clean**

全部为预期内容（四轮的生产改动、四轮的测试、五个交付目录、以及那个 `.doc`）。逐文件 diff 归属见 `INTEGRATION_DIFF_AUDIT.md §2`：每个生产文件只有一个（planQuality 两个）责任轮次。

---

## 三、第二阶段：T1E-B

**裁决：`TEST_EXPECTATION_OR_HARNESS_ISSUE`**

六次运行的完整证据表（明细见 `T1EB_FINDINGS.md`）：

| 环境 | 源码 | 超时 | 结果 | 耗时 |
|---|---|---|---|---|
| 2026-11-12 隔离 | bare HEAD | 30s | **PASS** | 18.51s |
| 2026-11-12 整文件 | bare HEAD | 30s | FAIL 超时 | 文件 207.65s |
| 本轮 隔离 | 当前候选 | 30s | FAIL 超时 | 43.41s |
| 本轮 隔离 | **冻结 HEAD 臂** | 30s | **FAIL 超时** | 42.37s |
| 本轮 隔离 | 冻结 HEAD 臂 | 240s | **PASS** | 39.73s |
| 本轮 隔离 | 当前候选 | 240s | **PASS** | 41.88s |

决定性的一对是第 3、4 行：**字节回退到 HEAD 之后同样撞线**，耗时差 1.04s（2.4%）。⇒ 与四轮补丁无因果关系。

- **不是正确性问题**：给足时间后断言成立（两臂 `far.*` 与 `nd.*` 逐字段相同）。
- **不是终止性问题**：搜索有界、确定性、两臂都能跑完。
- **是预算线过期**：30s 这个值配置注释自己写着是"为了全量套件不被 5s 默认卡住而取的折中"，而同一文件里同量级的 `T1E-B E/F/G` 显式写了 `120_000` 并注释"environmental (serial heavy run), not part of any correctness gate"。
- **顺带排除的替代解释**：`stateKey` 微基准两臂 5.816 / 5.716 µs/call（比值 1.017），key 长度都是 379——P1-ID 加固身份**没有**带来可测量的单次成本回归，那 +2.15s（+5.4%，单次配对观测）不足以判定为回归，我不把它算成回归。

**没有做的事**：没有靠"把 30000 改成 120000"宣布解决。这条记录为过期权威 `REG-T1EB-WALL`，附两臂实测值。

---

## 四、第三阶段：FLT-HV14-4

**裁决：`TEST_EXPECTATION_OR_HARNESS_ISSUE`**

### 4.1 先把"状态恢复不忠实"这条排除

`stateKey(restored) === loggedStateKey`，379 字符逐字相同；根上 `noMoveLossAtRoot=false`；`catMovesLeft=4 / mouseMovesLeft=0 / trap=(1,1) / remain=0` 与日志一致。测试用的 flags 与生产**逐项相同**（50 万节点、TT/AB/ordering 开、threatExtensions 0、threatOrdering 关、H1 leaf）。

### 4.2 当前引擎在任何深度都是同一个答案

深度 1/2/3/4 全部 `999996 / mate=cat / completed=true`，`terminalNodes` 恒为 1，节点数 22 / 554 / 794 / 66,922。深度 1 只要 **22 个节点**就触到终端。

### 4.3 这个将死是真的（三重验证）

1. **真实引擎穷举**：212 条合法猫动作序列，ARM-REAL（`catMove` + `endTurn` + 判负内核）与 ARM-SIM（AI 自己的转移）各找到 **1** 条，且是同一条 `下 下 下 左`，猫 (8,0)、鼠 (9,0)、`cat_wins`。两臂 212 条结果完全一致 ⇒ 无"模拟器与真实引擎分歧"。
2. **独立于判负内核**：老鼠四个邻居分别是猫 / 出界 / 出界 / **箱子**，直接调真实 `mouseStep` 四个方向 `mouseMoved` 全为 false ⇒ `MOUSE_HAS_NO_LEGAL_STEP`。
3. **当前生产规划器真的会走**：`planHardCatTurn`（100ms 预算）产出 `下 下 下 左`，用真实引擎重放走到 `cat_wins`；而日志里的旧计划 `下 右 右 右` 重放后仍是 `playing`，**没赢**。

### 4.4 全 45 根复算（不依赖那个会提前中止的测试）

`FLT-HV14-4` 首次不符就 throw，只验证到第 20 个根，所以它自己的日志**不能**说明"其余 44 个根没问题"。为此单独做了全量复算（`P3-E`）：

```
roots=45   identityOk=true   valueMatches=44   mateMatches=44   deviations=1
DEVIATION  GAME3 T4 depth=2  log=-1052.9473684210527/null  now=999996/cat
```

⇒ 偏差**恰好一个**，就是那个被证明为真将死的位置。

### 4.5 这条裁决的真正含义（要写进后续所有引用）

> **HV14 语料不再是当前引擎的完全可复现基线：45 根里 44 根复现，GAME3 T4 因引擎变强而不可复现。**
> 任何以 HV14 根值为前提的后续实验，都必须显式扣除这一根，否则会把"引擎变强"误读成"回归"。

同时必须如实登记：该测试第 494 行之后的断言（bound 剖面、`conflictTurns`、`firingRoots=['GAME1T4']`、`truncatedRootCandidates`、`planOverwriteChanged`）**在本轮从未被执行到**，修好黄金值之后要重新确认它们仍成立。

---

## 五、第四阶段：四轮集成边界

逐项结论（细节见 `INTEGRATION_DIFF_AUDIT.md §3`）：

| 检查项 | 结论 |
|---|---|
| 新状态身份是否贯穿计划提取 | **是**。key 分量集合未变；45/45 根身份匹配；默认地图 key 逐字节相同 |
| 共享 deadline 是否覆盖全部 fallback | **是**（限于 `computeCatAiTrajectory` 入口）。唯一铸造点 + 三处 fallback 全传身份 + 窗口关闭后拒绝再搜索 |
| 计划长度扩大是否引入未受控后处理 | **否**。默认地图上界 7 **小于**旧常量 8；后处理是线性扫描，`M=12` 时上界 19 |
| 新反向评分是否保持同主值与稳定排序 | **是**。24/24 主值全同；同分仍首位记录者胜出；memo key 未变 |
| Progress Guard 记忆是否与新计划一致 | **级联存在，真实行为未退步**。T14/T15 现在都产 `DRUL` 且签名相同，真实记忆仍触发救回 `DDLD` |
| 上界证明的定义域 | 代码成立，**文档不精确**（§3 未限定非负整数、未讨论小数）。取整只会收紧上界，无正确性缺口 |
| 异常输入边界 | 三处未认证：小数预算、极大预算、`catAiMove` 省略身份 |

**唯一真实的跨轮耦合**：QUALITY-01 改了计划文本 ⇒ `LoopSignature`（含计划标签）随之改变 ⇒ guard 的签名空间被改写。后续再动计划选择，必须重跑那条 guard 探针，不能只看 `progressGuard.test.ts` 是否绿。

**一条要写进 P1-ID 结论范围的边界**：地形编码只在 `trap`（`t→r`）与 `butter_spot`（`b→u`）上与原实现不同。默认地图不含这两种地形；现有 45+24 个根全部匹配；但含这两种地形的历史 `stateKey` 工件与新实现不再相等。

---

## 六、第五阶段：验证范围与纪律

| 项 | 状态 |
|---|---|
| `tsc -b` | **PASS**（exit 0，日志 0 字节） |
| 全量 982 项回归 | **未重跑**（任务禁止 1713s 全套）；沿用 QUALITY-01 的 976/2/4 |
| `npm run build` | **未跑**（本轮 0 生产改动）；上次 exit 0 |
| 重型任务 | 0 次 self-play / oracle / primary / METHOD_A / timing benchmark |
| `HEAVY_WORKER_CONCURRENCY=1` | 遵守：所有 vitest 均 `--maxWorkers=1 --no-file-parallelism` 串行 |
| 启动前检查遗留进程 | 已做（无重复任务） |
| 100ms/150ms 常量、`vitest.config.ts` 超时、冻结门槛、fixture | **全部未改** |
| 对照臂 | 建在 `PPC-P1-CLOSURE-01/arm-head/`，六个生产文件与 `git show HEAD:` **逐字节全等**；不在 `tsconfig` include 内；未动工作树 |
| 探针类型检查 | 探针与对照臂**不被** `tsc -b` 覆盖（`include: ["src"]`），由 vitest 直接转译运行 |

---

## 七、第六阶段：裁决与 checkpoint 条件

### 7.1 两项失败的最终分类

| 测试 | 分类 | 一票否决证据 |
|---|---|---|
| `T1E-B` | `TEST_EXPECTATION_OR_HARNESS_ISSUE` | 冻结 HEAD 臂同样 30s 超时（42.37s）；给足预算后两臂都通过 |
| `FLT-HV14-4` | `TEST_EXPECTATION_OR_HARNESS_ISSUE` | 当前值 `999996` 经真实引擎穷举 + 真实走子规则证明为**真将死**；全 45 根偏差恰为 1 |

`PREEXISTING_ENGINE_CORRECTNESS_FAILURE`：**0 项**
`PERFORMANCE_OR_TERMINATION_FAILURE`：**0 项**
`UNRESOLVED`：**0 项**

### 7.2 是否具备本地 checkpoint 条件

**具备。** 理由：

1. 四轮改动来源可逐字节锁定，责任归属唯一，无交叉污染；
2. 生产侧无未认证的算法分歧：搜索数学（value/mate/depth/TT）在 24 个人类根上 24/24 未变；
3. 两个失败项都不指向生产正确性，且都在 HEAD 就存在；
4. `tsc -b` 通过，生产源码 0 改动。

**建议的 checkpoint 形态**（本轮不执行，等裁决）：由于工作树里带着 982 项的最后一次全量结论与 2 个已知红，最稳的是**按 SHA 固定一个未提交快照**（七个生产文件 + 六个新测试 + 三个 fixture + 五个交付目录），而不是立刻做成一个"看起来全绿"的提交。

### 7.3 哪些问题**阻碍合并**

无技术阻塞项。但有两条**决策阻塞**，必须由人拍板：

1. **B2 / HV14 黄金值**：是否承认 GAME3 T4 这一根已作废。不决定的话，`FLT-HV14-4` 会一直红，合并后默认套件带红。
2. **B1 / 30s 超时**：是否给该用例显式预算。不决定的话，本机跑全套必红一条，任何"全绿"声明都依赖机器性能。

### 7.4 哪些问题可以留到独立后续阶段

| 项 | 为什么可以延后 |
|---|---|
| `ABSOLUTE_DEADLINE_GATE` 缺失 | 纯属"缺新证据"，不影响代码正确性；需要一次预注册 timing 实验 |
| `NEW_EFFICACY_AUTHORITY` 缺失 | 本轮无棋力主张；QUALITY-01 的行为变更需要独立 A/B，与合并无关 |
| C1 `catAiMove` 身份参数可选 | 生产三处已全覆盖，当前无暴露；属架构加固 |
| C2 P1-ID 缺 manifest | 纯 provenance 补档，不动源码 |
| C3 / D1 / D2 | 文档与边界 fixture，均为精度问题 |

### 7.5 保留的门

```
ABSOLUTE_DEADLINE_GATE = BLOCKED
NEW_EFFICACY_AUTHORITY = NONE
NEW_STRENGTH_CLAIM     = NONE
```

本轮**不宣称**任何棋力提升或完整时限 PASS。第 4.3 节"当前引擎会走旧构建放掉的杀法"是一条**单点行为差异**，不是系统性强弱证据。

---

## 八、交付物

| 文件 | 内容 |
|---|---|
| `REPORT.md` | 本文 |
| `SOURCE_MANIFEST.json` | 七项冻结指纹 + 本轮全部工件指纹 + 保全声明 |
| `ARM_MANIFEST.json` | 冻结 HEAD 对照臂的构造方式、六个 sha256、与 `git show HEAD:` 全等校验、两次运行记录 |
| `INTEGRATION_DIFF_AUDIT.md` | 来源锁定、逐文件归属、累积影响面、七项交叉边界、本轮未做之事 |
| `T1EB_FINDINGS.md` | 六次运行证据表、为什么是预算过期、stateKey 机制排除 |
| `FLT_HV14_4_FINDINGS.md` | 三重验证、45 根复算、影响面、三条后续选项 |
| `REGRESSION_AUTHORITY_STATUS.json` | 哪条回归/时序权威仍有效、哪条已过期、两项失败分类 |
| `REMAINING_GATES.md` | 五组仍未关闭的门（权威 / 测试黄金值 / 架构风险 / 文档精度 / 本轮未产生的门） |
| `probe/` | 6 个只读探针 + 2 份 vitest 配置 |
| `_raw/` | 6 份原始测量 JSON |
| `logs/` | 4 份 T1E-B 定点日志 + `tsc.log` |
