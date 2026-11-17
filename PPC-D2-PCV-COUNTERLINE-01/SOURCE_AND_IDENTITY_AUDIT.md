# SOURCE 与身份审计（G0）

- 轮次：`PPC-D2-PCV-COUNTERLINE-01`
- 项目目录：`F:\小猫小鼠`
- 采集时间：2026-11-16T17:11:03+08:00
- 采集方式：`probe/d2_pilot_preflight.py`（只读）+ `probe/resource_snapshot.ps1`（只读）
- 原始输出：`logs/preflight_identity.json`、`logs/resource_preflight.txt`

---

## 1. Git 身份

| 项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8` | 同 | PASS |
| BRANCH | `ppc/p1-id-state-identity-fix` | 同 | PASS |
| 工作树 | 允许 dirty（既有未提交修改必须保留） | 69 条：15 tracked 修改 + 54 未跟踪 | 记录 |
| 本轮写入 | 仅 `PPC-D2-PCV-COUNTERLINE-01/` | 仅该目录 | PASS |

工作树 69 条与上一轮 `PPC-T2-PCV-TAIL-01` 记录的 67 条相比，增量不是本轮的：

- 上一轮完成时：15 tracked 修改 + 52 未跟踪（其 manifest 记 `currentUntrackedEntries: 52`）。
- 本轮 preflight：15 tracked 修改 + **54** 未跟踪。
- 本轮只新建了 `PPC-D2-PCV-COUNTERLINE-01/`（+1）。
- 剩余 **+1** 是 `PPC-MCTS-01B/`——**不是本轮产生的**，且它此刻正在跑 vitest（见第 5 节）。

本轮**未**执行 `git add` / `commit` / `push` / `merge` / `reset` / `stash` / `checkout`。

---

## 2. 五个冻结身份（完整 SHA256，非前缀）

| 名称 | 文件（相对仓库根） | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| `FIXTURE_SHA256` | `src/game/ai/__tests__/fixtures/ppcId01-human-roots.json` | `1a59787a…db09` | 全等 | **PASS** |
| `P5_SHA256` | `PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json` | `9d50560f…8775` | 全等 | **PASS** |
| `T2_CANDIDATE_FREEZE_SHA256` | `PPC-T2-PCV-RESCUE-01/CANDIDATE_PLANS.json` | `8f5a3f9d…c3ed` | 全等 | **PASS** |
| `TAIL_CANDIDATE_SHA256` | `PPC-T2-PCV-TAIL-01/TAIL_CANDIDATES.json` | `39cc3569…e8b8` | 全等 | **PASS** |
| `SEAL_KERNEL_SHA256` | `PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts` | `453915d3…779b` | 全等 | **PASS** |

逐字节完整值见 `logs/preflight_identity.json` 的 `frozenIdentities[].actual`。

补充核对（未在任务书清单内，但属身份链的一部分）：

- `PPC-T2-PCV-RESCUE-01` 的 manifest 里 `results.freeze.frozenSha256 = 8f5a3f9d…`
  与 `CANDIDATE_PLANS.json` 的实算值一致 ⇒ 该文件确实是"冻结件本身"，不是它的副本。
- `PPC-CAT-STRATEGY-SEAL-01` 的 `SEAL_KERNEL_SHA256` 指向 `probe/seal_lib.ts`（21012 B），
  是**内核源码**而非压缩包；与 ERRATUM-01 的 `originalsBefore[10]` 登记值一致。

---

## 3. 生产源码当前 SHA256（本轮禁止改动，用于前后比对）

| 文件 | SHA256 | 字节 |
|---|---|---:|
| `src/game/ai/expectiminimax.ts` | `50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c` | 109352 |
| `src/game/ai/hardTurnPlanner.ts` | `27b1ce6dc62234d0c822b2b0b6341205ac189b5f76d7662a5d29d9e17ded75ff` | 36060 |
| `src/game/ai/planQuality.ts` | `46979485d568dfff12e2f998353cda95616502a7433ac84c3d31801726090952` | 30693 |
| `src/game/ai/legalActions.ts` | `27ae2f468d19043425326c2fc42923aeae894a5f84d2e0684ee374808b50eb22` | 2368 |
| `src/game/ai/preparedActions.ts` | `67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764` | 5405 |
| `src/game/ai/planBound.ts` | `4a212b75de6b5c47b6402c0745593169f6271a06d0f91fed99b7479f679b3dab` | 8012 |
| `src/game/ai/transposition.ts` | `7b4aa8eb3fab994a4abc77fdf38800ab2a5f9da57d5eb33a1b37075e106c2d64` | 6784 |
| `src/game/ai/deadlineContext.ts` | `ced449445d70d1ba88cb20d88415b3c641d670aa886536fcacefa36b4aa50235` | 14411 |
| `src/game/ai/simulator.ts` | `6d24d4f36d9f7e076fa36c9460ec51c674f1006f9cae00f7f5fb64771516df32` | 8365 |
| `src/game/config.ts` | `60e38c491c81f0b6d962bd32b306373de462cffcc9508b76c5bed02f9f70caae` | 15048 |
| `src/game/engine.ts` | `099f9a7b6d97b838c664aa7186be58465e5b01b8052af4b4e4e19a5644d19f06` | 190506 |
| `src/game/openingFairness.ts` | `9d19279cafefe545ea6fd2d49cd2d412986c0002977c7b37cf3e72787efd7908` | 35834 |
| `GAMEPLAY.md` | `e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34` | 21128 |

与上一轮 `PPC-T2-PCV-TAIL-01` 资源日志记录的冻结值比对（全部一致）：
`GAMEPLAY.md` `e000778b…`、fixture `1a59787a…`、`preparedActions.ts` `67b76ad3…`、
`expectiminimax.ts` `50d27da5…`、`engine.ts` `099f9a7b…`、SEAL kernel `453915d3…`。
⇒ 跨轮工作树未被上一轮以后的任何动作改动。

---

## 4. 重复任务检查

| 检查项 | 结果 |
|---|---|
| `PPC-D2-PCV-COUNTERLINE-01/` 是否已存在（本轮开工前） | **不存在** |
| 是否存在其它 `*D2*PCV*` 目录 | 仅 `PPC-D2-PCV-COUNTERLINE-01`（本轮新建） |
| 是否存在同名 D2 benchmark / 同名 JSON | 否 |
| 是否会覆盖 T1/T2/TAIL 原始文件 | 否——本轮只读它们，写入全部在新目录 |

```text
DUPLICATE_BENCHMARK = FALSE
PRIOR_ARTIFACTS_OVERWRITTEN = FALSE
```

---

## 5. 遗留 Node / Vitest / worker / 后台 benchmark

**发现：有，且正在运行。** 这是本轮的硬性阻断项之一。

`logs/resource_preflight.txt` 原始记录：

```text
HEAVY_WORKER_COUNT=3
HEAVY_WORKER pid=41868 ppid=8268  npx-cli.js vitest run --config PPC-MCTS-01B/probe/vitest.config.mts
HEAVY_WORKER pid=27920 ppid=28912 vitest.mjs    run --config PPC-MCTS-01B/probe/vitest.config.mts
HEAVY_WORKER pid=7560  ppid=27920 vitest/dist/workers/forks.js
```

事实：
- 三者构成一次完整的 `vitest run`：npx 壳 → vitest 主进程 → fork worker。
- 目标配置是 **`PPC-MCTS-01B/probe/vitest.config.mts`**，属于**另一个轮次**。
- 该目录 `PPC-MCTS-01B/` 的 mtime 为 2026-11-16 17:07–17:09，**晚于本轮开工**，
  且不在本轮之前的未跟踪清单里。
- 实测启动时间 17:09:28 起，本轮 preflight 采样时仍在存活
  （worker 常驻工作集从 155 MB 涨到 315 MB，说明它在真实跑）。

判定：

```text
RESIDUAL_HEAVY_WORKER        = TRUE
CONCURRENT_BENCHMARK_IN_FLIGHT = TRUE
WORKER_BELONGS_TO_THIS_ROUND = FALSE
ACTION_TAKEN                 = NONE  (未终止、未挂起、未调优先级)
```

**处理原则与理由**：任务书 §3 写明"不允许杀死无关的外部进程"。
该 worker 不属于本轮，它可能是用户另一个会话正在跑的合法任务；
处置权不在本轮。因此本轮**只记录、不处置**，并把"存在并发重型任务"直接作为
资源准入不通过的依据之一（见 `RESOURCE_SAFETY_LOG.md` §2）。

旁证（说明它确实是兄弟轮而非僵尸）：本项目今日工作记忆
（`.workbuddy/memory/2026-11-16.md`）记录了 `PPC-MCTS-01` 试点完成，并写明
"下一步：停在此，等 ChatGPT 复核是否进 `PPC-MCTS-01B`"。
`PPC-MCTS-01B/` 目录与其中的 `probe/vitest.config.mts` 存在，
且 postflight 时 vitest **换了新 PID 继续跑**（41868/27920/7560 → 34796/3224/…），
说明那一侧在连续多轮推进。⇒ 它是进行中的兄弟轮，**不是遗留僵尸**。

**注意**：这也意味着即使内存侥幸达标，本轮也不能启动 D2——
任务书 §8 禁止"同时运行多个 D2 搜索""多个后台重型任务"，
而当前已有一个重型基准在飞行中。

---

## 6. 资源准入

`probe/resource_snapshot.ps1 -Tag preflight`，2026-11-16T17:11:03+08:00：

```text
TOTAL_PHYS_MB    = 16088
FREE_PHYS_MB     = 755        (门槛 4096)   -> FAIL
COMMIT_LIMIT_MB  = 34224
FREE_COMMIT_MB   = 4957       (门槛 8192)   -> FAIL
COMMITTED_MB     = 29266
PAGEFILE_ALLOCATED_MB = 18135
PAGEFILE_USED_MB      = 3044
PROCESS_COUNT    = 349
CPU_LOAD_PCT     = 3
```

同一时段内多次采样（空闲物理内存波动很大，但**两次门槛没有一次达标**）。
采样时刻为会话内相对时间（约值，未逐次打时间戳）：

| 采样批次 | FREE_PHYS_MB | FREE_COMMIT_MB | 备注 |
|---|---:|---:|---|
| 第 1 批（约 17:05） | 352 | 5134 | 本轮首次采样（python/git 工作时） |
| 第 2 批 a（约 17:08） | 2091 | 4089 | |
| 第 2 批 b | 2094 | 4090 | |
| 第 2 批 c | 2060 | 4080 | |
| 第 3 批（17:11:03，已带时间戳） | **755** | **4957** | 并发 vitest worker 涨到 315 MB 之后 |

- `FREE_PHYS_MB` 观测区间 **352 – 2094**，上限仍只有门槛 4096 的 51%。
- `FREE_COMMIT_MB` 观测区间 **4080 – 5134**，上限只有门槛 8192 的 63%。
- 已提交内存 29.3 GB / 上限 33.4 GB（87%），页面文件已用 3044 MB。

```text
FREE_PHYS_GATE   = FAIL
FREE_COMMIT_GATE = FAIL
RESOURCE_ADMISSION = FAIL
```

完成审计后的 postflight 复核（17:13:27，`logs/resource_postflight.txt`）：
`FREE_PHYS_MB = 1815`（仍 FAIL）、`FREE_COMMIT_MB = 8298`（已越过 8192）、
`HEAVY_WORKER_COUNT = 3`（换成新 PID，说明那一侧在连续跑）。
准入时刻两项皆 FAIL，因此判定以 preflight 为准；且 `FREE_PHYS` 全程最高 2094，
**物理内存才是绑定约束**。详见 `RESOURCE_SAFETY_LOG.md` §2.1。

按任务书 §3："若不满足，只完成只读审计并停止，不通过扩大 pagefile、V8 heap 或提高并发绕过门槛。"
⇒ 本轮**就此停在 G1**，G2–G5 全部 `NOT_PERFORMED`。

本轮**未**：扩大 pagefile、加大 V8 heap、提高并发、降低 cap、
缩减候选数、杀死任何进程。

---

## 7. 审计结论

```text
IDENTITY_GATE            = PASS   (HEAD / BRANCH / 5 项冻结 SHA256 全等)
PRODUCTION_SOURCE_CHANGED = NO
GAME_RULES_CHANGED       = NO
DUPLICATE_BENCHMARK      = FALSE
RESIDUAL_HEAVY_WORKER    = TRUE   (PPC-MCTS-01B vitest run, 3 procs)
RESOURCE_ADMISSION       = FAIL   (FREE_PHYS 755 < 4096 ; FREE_COMMIT 4957 < 8192)
D2_SEARCH_PERFORMED      = FALSE
STOP_REASON              = RESOURCE_ADMISSION_FAIL + CONCURRENT_HEAVY_WORKER
```
