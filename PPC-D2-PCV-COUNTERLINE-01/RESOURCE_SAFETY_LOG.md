# PPC-D2-PCV-COUNTERLINE-01 — Resource Safety Log

- 类型：`READ_ONLY_AUDIT_ONLY`（`RESOURCE_ADMISSION = FAIL` ⇒ 未进入任何重型阶段）
- 结论：**资源准入未通过，本轮回退为纯只读审计**；未修改生产源码；未终止任何进程。

---

## 1. Preflight 状态

- 项目目录：`F:\小猫小鼠`
- HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`
- 分支：`ppc/p1-id-state-identity-fix`
- 工作树：69 条（15 tracked 修改 + 54 未跟踪）；本轮只新增 `PPC-D2-PCV-COUNTERLINE-01/`
- CPU：Intel Core i7-14650HX，16 核 / 24 线程；采样时负载 3%（内存是瓶颈，CPU 不是）
- 物理内存：总 16 088 MB（约 15.7 GiB）
- 提交/页面文件：上限 34 224 MB（约 33.4 GiB），已提交 29 266 MB（87%）

原始采集：`logs/resource_preflight.txt`、`logs/preflight_identity.json`。

---

## 2. 资源准入判定（硬门）

任务书 §3 要求启动 D2 重型试点前同时满足：

```text
FREE_PHYS_MB   >= 4096
FREE_COMMIT_MB >= 8192
```

实测（`probe/resource_snapshot.ps1 -Tag preflight`）：

```text
FREE_PHYS_MB   = 755      -> 4096 门槛 FAIL（缺 3341 MB）
FREE_COMMIT_MB = 4957     -> 8192 门槛 FAIL（缺 3235 MB）
```

多批次采样证明这不是瞬时抖动（5 个样本，`FREE_PHYS` 352–2094，`FREE_COMMIT` 4080–5134，
**无一样本达标**）。

```text
RESOURCE_ADMISSION = FAIL
```

按任务书 §3 的处置规定：**只完成只读审计并停止**，不通过扩大 pagefile、
V8 heap 或提高并发绕过门槛。本轮照此执行。

### 2.1 Postflight 复核（诚实记录一个反转）

完成审计后（17:13:27）再采一次：`FREE_COMMIT_MB` 回到 **8298**（越过 8192 门槛），
但 `FREE_PHYS_MB` 只有 **1815**（门槛 4096，仍缺 2281 MB）。
同时并发 vitest **换了 PID 继续跑**（41868/27920/7560 → 34796/3224/…），
说明那一侧的任务是连续多轮，不是一次性。

如何解读（这很重要，不能拿来给自己的决定翻案）：

- 准入判定必须发生在**准入时刻**（preflight），当时两项都不达标；事后回升不改变准入结论。
- 更关键的是 **`FREE_PHYS` 在整个观测窗口内一次都没接近 4096**
  （最高 2094，只有门槛的 51%）。这是本机的结构性约束：
  16 088 MB 物理内存，仅 IDEA + 浏览器 + WorkBuddy 就占掉大半。
- `FREE_COMMIT` 的回升，恰恰是"另一个会话的 job 释放/重建"造成的抖动，
  说明这个数值在并发环境下**不是稳定量**。用它做准入必须在无并发时测。

⇒ 结论不变：`RESOURCE_ADMISSION = FAIL`，且**物理内存是真正的绑定约束**，
不是靠等一会儿就能过的。

---

## 3. 并发重型任务（第二道硬阻断）

在本轮 preflight 时，同一工作区内**已有一个 vitest 重基准在飞行中**：

```text
pid 41868  npx-cli.js vitest run --config PPC-MCTS-01B/probe/vitest.config.mts
pid 27920  vitest.mjs    run --config PPC-MCTS-01B/probe/vitest.config.mts
pid 7560   vitest/dist/workers/forks.js
```

- 属于 `PPC-MCTS-01B`（另一个轮次），不在本轮之前的未跟踪清单内，mtime 晚于本轮开工。
- 该 worker 的工作集在本轮观测期内从 155 MB 增长到 315 MB ⇒ 真实运行，不是僵尸。

处置：**未终止、未挂起、未改优先级**。理由：任务书 §3"不允许杀死无关的外部进程"，
且处置权不在本轮。

连带结论：即使内存达标，任务书 §8 也禁止"同时运行多个后台重型任务 / 多个 D2 搜索"，
所以本轮同样不能启动。这是**独立的第二道阻断**。

---

## 4. 本轮实际执行的动作清单

| 动作 | 是否执行 | 说明 |
|---|---|---|
| `git rev-parse` / `git status`（只读） | 是 | |
| SHA256 计算（5 个冻结件 + 13 个生产文件） | 是 | 只读 |
| 内存 / 进程 / pagefile 采样 | 是 | 只读 |
| 源码阅读（`expectiminimax.ts` 等） | 是 | 只读 |
| 新建 `PPC-D2-PCV-COUNTERLINE-01/` 及其 `probe/` `logs/` | 是 | 唯一写入 |
| D2 固定深度搜索 | **否** | `D2_SEARCH_PERFORMED = FALSE` |
| 候选生成 / 回放 / 冻结 | **否** | `NOT_PERFORMED` |
| PCV H0 / H1 证明 | **否** | `NOT_PERFORMED` |
| Rep1 / Rep2 重复 | **否** | `NOT_PERFORMED` |
| 回归 / 全量测试 | **否** | 任务书本就禁止 |
| 终止任何进程 | **否** | `EXTERNAL_PROCESSES_KILLED = FALSE` |
| 扩大 pagefile / V8 heap | **否** | `V8_HEAP_EXPANSION = FALSE` |
| 降低 cap / 缩减候选 | **否** | 未进入该阶段 |
| `git add` / commit / push / merge / reset / stash | **否** | `COMMIT = NO` `PUSH = NO` `MERGE = NO` |

---

## 5. 运行资源

**无重型运行。** 本轮进程开销仅限：

| 阶段 | 形态 | 峰值 RSS | 备注 |
|---|---|---:|---|
| preflight 身份核验 | `python` 单进程，同步 | < 30 MB | 秒级退出 |
| 资源采样 | PowerShell 同步 | < 80 MB | 秒级退出 |

- 未发生 OOM、未发生页面文件耗尽、未发生进程崩溃。
- 未使用 `Promise.all`、worker pool、后台并发。
- `HEAVY_WORKER_CONCURRENCY = 1` 在本轮是**平凡成立**（本轮自己一个重型 worker 都没起）。

---

## 6. 只读边界复核

未修改：

```text
src/**                      未改动（13 个受监视文件 SHA256 前后一致，见 SOURCE_MANIFEST.json）
GAMEPLAY.md                 未改动（e000778b…）
evaluation.ts               未改动
correctedHoleLeaf.ts        未改动
expectiminimax.ts           未改动（50d27da5…）
hardTurnPlanner.ts          未改动（27b1ce6d…）
Sidecar / Progress Guard    未接触
H1                          未接触
100ms budget / 150ms wall   未接触
```

未覆盖任何 T1 / T2 / TAIL / SEAL 原始工件（只读其 SHA256）。

---

## 7. 完成时状态

```text
HEAVY_WORKER_CONCURRENCY        = 1            (本轮未起任何重型 worker, trivially)
SERIAL_FRESH_REPETITIONS        = TRUE         (无 repetition 可序列化——未进入证明阶段)
DUPLICATE_BENCHMARK             = FALSE
CONCURRENT_BENCHMARK_IN_FLIGHT  = TRUE         (PPC-MCTS-01B, 非本轮)
OOM                             = FALSE
PAGEFILE_EXHAUSTED              = FALSE
RESOURCE_ADMISSION              = FAIL
PRODUCTION_SOURCE_MODIFIED      = FALSE
PREEXISTING_WORKTREE_PRESERVED  = TRUE
PREEXISTING_TRACKED_MODIFICATIONS = 15
PREEXISTING_UNTRACKED_ENTRIES     = 54 (含本轮新目录与 PPC-MCTS-01B)
EXTERNAL_PROCESSES_KILLED       = FALSE
V8_HEAP_EXPANSION               = FALSE
NODE_CAP_REDUCED                = FALSE
CANDIDATE_COUNT_REDUCED         = FALSE
RESIDUAL_WORKERS_FROM_THIS_ROUND = FALSE
```

---

## 8. RESUME-CHECK 追加段（2026-11-16 17:27–17:31）

背景：`PPC-MCTS-01B` 已由用户确认完成，故对同一轮次重做准入。
本节**追加**，不覆盖 §1–§7 的原始记录（§1–§7 是 preflight 时刻的证据，事后不得改写）。

### 8.1 兄弟任务退出确认

```text
SIBLING_VITEST_ALIVE         = 0        (HEAVY_WORKER_COUNT 连续 9 次采样为 0)
SIBLING_FORK_WORKER_ALIVE    = 0
SIBLING_EXIT_CONFIRMED       = TRUE
SIBLING_LAST_PROBE_END       ≈ 2026-11-16T17:20:10+08:00   (17:17:47 + 142.76s, 2/2 passed)
SIBLING_LAST_ARTIFACT_WRITE  = 2026-11-16T17:24+08:00
SIBLING_KILLED_BY_THIS_ROUND = NO
```

§3 记录的 vitest 集群（41868 / 27920 / 7560 及其后续 PID）已全部消失。
现存 6 个 `node.exe` 均为 WorkBuddy 扩展宿主与 MCP 连接器，无一为 vitest。

### 8.2 外部构建会话（新发现，记录但不处置）

`ninja.exe`×1 / `python.exe`×2 / `xtensa-esp32s3-elf-gcc.exe`×4 / `ccache.exe`×4，
合计 11 进程。全部 `Status=Unknown`、CPU Time `0:00:00`（ninja 累计 1 秒）、单进程 ≤ 8 MB。
17:31:07 与 17:31:20 间隔 12 秒两清点 PID 稳定。

判定：**不是 vitest 级并发重型任务**（无持续 CPU、无数百 MB 工作集）。
未终止——任务书禁止杀无关进程。

### 8.3 资源采样（9 次，串行）

| # | 时刻 | FREE_PHYS_MB | FREE_COMMIT_MB | COMMITTED_MB | PAGEFILE_USED_MB | PROCS | CPU% |
|---|---|---:|---:|---:|---:|---:|---:|
| s1 | 17:28:01 | 1751 | 8253 | 25971 | 2501 | 346 | 35 |
| 1 | 17:28:12 | 1561 | 8195 | 26029 | 2327 | 346 | 1 |
| 2 | 17:28:17 | 1661 | 8327 | 25896 | 2327 | 347 | 0 |
| 3 | 17:28:23 | 1672 | 8368 | 25855 | 2323 | 349 | 29 |
| 4 | 17:28:28 | 1818 | 8427 | 25796 | 2390 | 346 | 8 |
| 5 | 17:28:33 | 1806 | 8407 | 25816 | 2387 | 346 | 5 |
| 6 | 17:29:39 | 2216 | 8396 | 25827 | 2116 | 350 | 16 |
| 7 | 17:29:49 | 2297 | 8710 | 25514 | 2042 | 335 | 16 |
| 8 | 17:29:59 | 2023 | 8536 | 25688 | 2008 | 343 | 20 |

```text
FREE_PHYS_MB    MIN=1561  MAX=2297  GATE=4096  => FAIL  (最好样本缺 1799 MB)
FREE_COMMIT_MB  MIN=8195  MAX=8710  GATE=8192  => PASS  (余量 3 MB)
PROCESS_GATE                                => PASS
------------------------------------------------------------
RESOURCE_ADMISSION                          => FAIL
RESOURCE_ADMISSION_BLOCKING_ITEM            => FREE_PHYS_MB
```

### 8.4 口径观察（不得用于放宽门槛）

`Get-Counter` 单次核对：`FreePhysicalMemory` 2,653 MB / `Available MBytes` 2,691 MB /
standby 1,403 + 979 = 2,382 MB / committed 25,685 MB / commit limit 34,224 MB。

`FreePhysicalMemory`（任务书口径）**不含** standby。若把 standby 计入，
17:29 那一刻为 5,035 MB，可越过 4,096。但本轮**不擅自改口径**，仅上呈裁决方。

### 8.5 本轮动作（与 §4 同格式，仅列增量）

| 动作 | 是否执行 |
|---|---|
| 进程枚举（tasklist / Get-CimInstance） | 是（只读） |
| `probe/resource_snapshot.ps1` 运行 9 次 | 是（只读） |
| `probe/d2_pilot_preflight.py` 运行 1 次 | 是（只读） |
| D2 搜索 / 候选 / 证明 / Rep1-Rep2 | **否**（`NOT_PERFORMED`） |
| 终止任何进程 | **否** |
| 改 pagefile / V8 heap / 并发度 | **否** |
| 改 `src/**` / 规则 / 搜索数学 / 100ms·150ms | **否** |
| commit / push / merge | **否** |

### 8.6 RESUME-CHECK 完成时状态

```text
ROUND                            = PPC-D2-G0-RESUME-CHECK
RESOURCE_SAMPLE_COUNT            = 9
FREE_PHYS_MB_MIN/MAX             = 1561 / 2297
FREE_COMMIT_MB_MIN/MAX           = 8195 / 8710
RESOURCE_ADMISSION               = FAIL
PROCESS_GATE                     = PASS
HEAVY_WORKER_COUNT               = 0
D2_SEARCH_STARTED                = NO
D2_NODES                         = 0
EXTERNAL_PROCESSES_KILLED        = FALSE
V8_HEAP_EXPANSION                = FALSE
PAGEFILE_CHANGED                 = FALSE
CONCURRENCY_RAISED               = FALSE
PRODUCTION_SOURCE_MODIFIED       = FALSE
OOM                              = FALSE
PREEXISTING_WORKTREE_PRESERVED   = TRUE  (69 = 15 + 54)
RESIDUAL_WORKERS_FROM_THIS_ROUND = FALSE
```

---

## 9. RETRY 追加段（2026-11-16 19:12–19:14）— **RESOURCE_ADMISSION = PASS**

同一天第三次准入。§1–§8 全部原样保留（它们是各自时刻的证据，不得改写）。

### 9.1 触发与前提

用户侧释放内存后重试。系统 **未重启**（`BOOT_TIME = 2026-11-12 09:00:25`，`UPTIME = 106.22 h`），
故工作树与身份基线同 17:28 完全可比。

### 9.2 进程检查

```text
HEAVY_WORKER_COUNT      = 0        (6/6 次采样; 正则 vitest|jest|bench|mocha)
SIBLING_VITEST_ALIVE    = 0
EXTERNAL_BUILD_SESSION  = ABSENT   (17:28 的 11 个 ESP-IDF 残留已自行退出)
NODE_PROCESS_TOTAL      = 5        (edge-sync / ima / baas-v2 / sheetagent MCP / weixinpay MCP)
PROCESS_GATE            = PASS
UNRELATED_PROCESSES_KILLED = NO
```

### 9.3 资源采样（6 次串行）

| # | 时刻 | FREE_PHYS_MB | FREE_COMMIT_MB | COMMITTED_MB | PAGEFILE_USED_MB | PROCS | CPU% |
|---|---|---:|---:|---:|---:|---:|---:|
| s1 | 19:13:00 | 5428 | 18649 | 15575 | 333 | 269 | 2 |
| 1 | 19:13:09 | 5655 | 18655 | 15568 | 342 | 269 | 7 |
| 2 | 19:13:15 | 5761 | 18654 | 15570 | 356 | 270 | 0 |
| 3 | 19:13:21 | 5811 | 18661 | 15563 | 373 | 268 | 0 |
| 4 | 19:13:27 | 5777 | 18656 | 15568 | 373 | 269 | 4 |
| 5 | 19:13:34 | 5841 | 18658 | 15565 | 371 | 269 | 15 |

```text
FREE_PHYS_MB    MIN=5428  MAX=5841   GATE=4096  => PASS   (最差样本余量 +1332 MB)
FREE_COMMIT_MB  MIN=18649 MAX=18661  GATE=8192  => PASS   (最差样本余量 +10457 MB)
------------------------------------------------------------
RESOURCE_ADMISSION                          => PASS
```

### 9.4 与 17:28 的差异归因（不是抖动，是应用被关闭）

| 指标 | 17:28 | 19:13 | 变化 |
|---|---:|---:|---:|
| COMMITTED_MB | 25514–26029 | 15563–15575 | **−10 GB** |
| PAGEFILE_USED_MB | 2008–2501 | 333–373 | −2.1 GB |
| PROCESS_COUNT | 335–350 | 268–270 | −77 |
| FREE_PHYS_MB | 1561–2297 | 5428–5841 | +3.4 GB |

变化幅度（10 GB committed）远超任何采样抖动，且进程数与 pagefile 使用同步下降，
与"用户关闭了浏览器组与 IDE"一致。**不是操作系统临时回收缓存。**

### 9.5 身份复核

```text
HEAD             = 48eaac6c4f3801d351787696ba5876995b64e8d8  MATCH
BRANCH           = ppc/p1-id-state-identity-fix               MATCH
FROZEN_IDENTITIES = 5/5 MATCH
PRODUCTION_SOURCES = 13/13 identical to 17:27 baseline
GIT_STATUS_LINES  = 69  (15 tracked + 54 untracked)
IDENTITY_GATE     = PASS
```

### 9.6 本轮动作（增量）

| 动作 | 是否执行 |
|---|---|
| `resource_snapshot.ps1` 运行 6 次 | 是（只读） |
| 进程枚举 + 系统 uptime 读取 | 是（只读） |
| `d2_pilot_preflight.py` 运行 1 次 | 是（只读） |
| D2 搜索 / 候选 / 证明 / Rep1-Rep2 | **否**（`RESOURCE_ADMISSION = PASS` 但仍在等 ChatGPT 确认） |
| 终止任何进程 | **否** |
| 改 pagefile / V8 heap / 并发度 | **否** |
| 改 `src/**` / 规则 / 搜索数学 / 100ms·150ms | **否** |
| commit / push / merge | **否** |

### 9.7 RETRY 完成时状态

```text
ROUND                            = PPC-D2-G0-RESUME-CHECK
ATTEMPT                          = RETRY
RESOURCE_SAMPLE_COUNT            = 6
FREE_PHYS_MB_MIN/MAX             = 5428 / 5841
FREE_COMMIT_MB_MIN/MAX           = 18649 / 18661
RESOURCE_ADMISSION               = PASS
PROCESS_GATE                     = PASS
IDENTITY_GATE                    = PASS
HEAVY_WORKER_COUNT               = 0
D2_SEARCH_STARTED                = NO
D2_NODES                         = 0
EXTERNAL_PROCESSES_KILLED        = FALSE
V8_HEAP_EXPANSION                = FALSE
PAGEFILE_CHANGED                 = FALSE
CONCURRENCY_RAISED               = FALSE
PRODUCTION_SOURCE_MODIFIED       = FALSE
OOM                              = FALSE
PREEXISTING_WORKTREE_PRESERVED   = TRUE  (69 = 15 + 54)
RESIDUAL_WORKERS_FROM_THIS_ROUND = FALSE
STOP_FOR_CHATGPT_REVIEW          = TRUE
```

**注**：`PASS` 只表示"有资格进入 G2"，不等于"已进入 G2"。按任务书 §第四阶段，
PASS 后须等待 ChatGPT 最终确认才可启动 G1T9/E1 试点。

---

## 10. G2–G5 重型执行段（2026-11-16 19:19–19:43）— 用户授权后启动

准入 PASS 且用户明确"直接开始"后，执行单根试点。§1–§9 原样保留。

### 10.1 并发与串行约束

```text
HEAVY_WORKER_CONCURRENCY       = 1     (同一时刻只有一个 vitest 进程)
SERIAL_FRESH_REPETITIONS       = TRUE  (逐个启动、逐个退出，无重叠)
PROMISE_ALL                    = NOT_USED
WORKER_POOL                    = NOT_USED
BACKGROUND_HEAVY_JOBS          = 1     (同一时刻仅 1 个)
```

每个 vitest 进程用 `--maxWorkers=1 --no-file-parallelism` 启动，
前一个进程完全退出后才启动下一个。共启动 **6 个**独立进程（含 1 次失败重跑）。

### 10.2 各进程实测成本

| # | 用途 | 形态 | 节点 | 耗时 | 内存 | 结果 |
|---:|---|---|---:|---:|---|---|
| 1 | 冒烟（D2 搜索） | vitest 单进程 | 2,727,890 | 204.6 s | — | 通过 |
| 2 | 候选提取（首次） | vitest 单进程 | 2,727,890 | 213.5 s | — | **失败**：`GamePhase` 导入路径错误（研究代码 bug，非引擎问题） |
| 3 | 候选提取 + 冻结 | vitest 单进程 | 2,727,890 | 217.2 s | — | 通过，4/4 提取 |
| 4 | PCV 证明 REP1 | vitest 单进程 | 774×4 | 0.29 s | — | 通过，4/4 H0 PROVEN |
| 5 | PCV 证明 REP2 | vitest 单进程 | 774×4 | 0.31 s | — | 通过，与 REP1 投影一致 |
| 6 | 搜索确定性重复 | vitest 单进程 | 2,727,890 | 220.2 s | — | 通过，投影 SHA 一致 |
| 7 | 成本核算 | vitest 单进程 | 2,727,890 | 162.6 s | RSS 288.6 MB / heap 104.3 MB | 通过 |

（表中 1–7 为记录顺序，进程本身严格串行。）

### 10.3 资源安全判定

```text
OOM                      = FALSE
PAGEFILE_EXHAUSTED       = FALSE
SYSTEM_UNRESPONSIVE      = FALSE
V8_HEAP_EXPANSION        = FALSE   (未加 --max-old-space-size)
NODE_CAP_RAISED          = FALSE   (8,000,000 硬上限未动)
CAP_HIT                  = FALSE   (实际用 34.1%)
RETRY_AFTER_CAP          = NOT_PERFORMED  (未触及上限，无重试)
CANDIDATES_REDUCED       = FALSE
FAILED_RECORD_DELETED    = FALSE   (首次失败的提取运行如实记在本表第 2 行)
```

峰值内存 ~290 MB（RSS）远低于 4096 MB 准入余量，未出现内存压力。

### 10.4 失败记录（不删除）

第 2 次运行（19:25）以 `TypeError: Cannot read properties of undefined (reading 'CatWins')`
失败：研究目录的 harness 从 `src/game/engine` 导入 `GamePhase`，
而该常量实际定义在 `src/game/types.ts`。**这是研究代码的导入错误，与引擎/规则无关**，
修正后同一搜索（节点数完全相同 2,727,890）通过。
按纪律保留记录，不隐藏。

### 10.5 G2 后生产隔离复核

```text
PRODUCTION_SOURCES_UNCHANGED_AFTER_G2 = TRUE (13/13, 与 19:13 基线逐字节一致)
HEAD_SAME                             = TRUE
FROZEN_IDENTITIES                     = 5/5 MATCH
GIT_STATUS_LINES                       = 69 (15 tracked + 54 untracked)
RESIDUAL_WORKERS_FROM_THIS_ROUND       = FALSE
```

### 10.6 收尾采样（19:44，如实记录一个低于门槛的读数）

```text
FREE_PHYS_MB      = 3937     (< 4096 !)
FREE_COMMIT_MB    = 17045
PROCESS_COUNT     = 272
HEAVY_WORKER_COUNT = 0
```

说明：这是**试点跑完之后**的采样，不是准入时刻的采样。准入判定按纪律固定在
准入时刻（19:13，5428–5841 MB 全过），事后读数不改变准入结论——这一点在 §2.1
已经用同样口径处理过一次，此处保持一致。

读数下降的原因很可能是 6 个 vitest 进程反复分配/释放后 standby 与工作集尚未回落，
而不是有残留进程（`HEAVY_WORKER_COUNT = 0` 已确认）。

**但它意味着：如果还要再跑重型批次（例如扩到其余 7 个根），必须重新做一次准入采样，
不能沿用 19:13 的数字。** 这是下一次启动的前置条件。
