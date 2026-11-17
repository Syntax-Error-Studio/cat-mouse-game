# PPC-T2-PCV-TAIL-01 — Resource Safety Log

- 类型：`READ_ONLY_TAIL_CERTIFICATION`
- 结论：资源与并发约束全部满足；未修改生产源码；未终止外部进程。

## 1. Preflight

- 项目目录：`F:\小猫小鼠`
- HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`
- 分支：`ppc/p1-id-state-identity-fix`
- fixture SHA256：`1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`
- CPU：Intel Core i7-14650HX，16 核 / 24 线程，preflight 负载约 24%
- 物理内存：总量 16,473,912 KB（约 15.71 GiB），空闲 1,346,992 KB（约 1.28 GiB）
- 提交/页面文件虚拟内存：总量 35,044,976 KB（约 33.42 GiB），空闲 8,499,540 KB（约 8.11 GiB）
- 未发现 Node/vitest/mutool 残留 worker；未发现重复 TAIL/T2 benchmark；未发现需处理的外部重负载任务。
- Git 状态 preflight 记录 66 条：15 个 tracked 修改 + 51 个未跟踪条目；未触碰既有修改和未跟踪文件。本轮所有写入仅位于新目录 `PPC-T2-PCV-TAIL-01/`。
- 工作树中既有 `src/game/ai/expectiminimax.ts`、`src/game/engine.ts` 等修改属于本轮开始前状态，已完整保留；冻结生产文件哈希与预检一致。
- 完成时 Git 状态为 67 条，增量仅为新的 `PPC-T2-PCV-TAIL-01/` 未跟踪目录。

## 2. 冻结与证明的串行约束

- `HEAVY_WORKER_CONCURRENCY=1`
- `SERIAL_FRESH_REPETITIONS=TRUE`
- Vitest：`fileParallelism=false`、`maxWorkers=1`、`minWorkers=1`
- 未使用 `Promise.all`、worker pool、后台并发或 V8 heap 扩容参数。
- Rep1 进程完全结束后才启动 Rep2。
- generate、Rep1、Rep2、aggregate 均单独执行，没有并行 benchmark。
- 未降低 600,000 H0 cap、5,000 H1 cap、候选数量或任何正确性检查。
- 未终止 DocMap、MCP 或其他 agent 的外部进程；未修改外部进程状态。

## 3. 运行资源

| 阶段 | 耗时/测试时长 | RSS | heapUsed |
|---|---:|---:|---:|
| generate + freeze | 95 ms test / 1.29 s process | 未采集 | 未采集 |
| Rep1 | 244 ms test / 1.34 s process | 141.4 MB | 78.6 MB |
| Rep2 | 157 ms test / 1.24 s process | 148.0 MB | 63.6 MB |

- 峰值 RSS：148.0 MB，约占 15.71 GiB 物理内存的 0.92%。
- 峰值 heapUsed：78.6 MB。
- 未发生 OOM、页面文件耗尽、进程崩溃或需要重试的资源异常。
- 两次 repetition 均正常退出；没有残留 Node/vitest worker。
- T3 H0 solve 为 48.976 ms / 43.926 ms，超过 25 ms，但 H0 没有 25 ms 门限；未因此降低 cap 或跳过证明。

## 4. 只读边界

- 未修改 `src/`、`GAMEPLAY.md`、`evaluateForCat`/corrected-hole、H1、Alpha-Beta/TT/Expectiminimax、Sidecar、Guard、100ms/150ms 预算。
- 冻结生产文件哈希在运行后复核一致：
  - `GAMEPLAY.md`：`e000778b…`
  - fixture：`1a59787a…`
  - `preparedActions.ts`：`67b76ad3…`
  - `expectiminimax.ts`：`50d27da5…`
  - `engine.ts`：`099f9a7b…`
  - SEAL kernel：`453915d3…`
- 未运行 24-root 全搜索、P5/P6、self-play 或 exhaustive oracle。
- 未 commit、push、merge；未进入 D2；未接生产。

## 5. 完成时状态

```text
HEAVY_WORKER_CONCURRENCY=1
SERIAL_FRESH_REPETITIONS=TRUE
DUPLICATE_BENCHMARK=FALSE
OOM=FALSE
PAGEFILE_EXHAUSTED=FALSE
PRODUCTION_SOURCE_MODIFIED_BY_THIS_ROUND=FALSE
PREEXISTING_WORKTREE_CHANGES_PRESERVED=TRUE
PREEXISTING_TRACKED_MODIFICATIONS=15
PREEXISTING_UNTRACKED_ENTRIES=51
EXTERNAL_PROCESSES_KILLED=FALSE
V8_HEAP_EXPANSION=FALSE
NODE_CAP_REDUCED=FALSE
CANDIDATE_COUNT_REDUCED=FALSE
RESIDUAL_WORKERS=FALSE
```
