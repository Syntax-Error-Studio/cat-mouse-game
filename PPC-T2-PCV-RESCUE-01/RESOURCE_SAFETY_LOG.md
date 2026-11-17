# PPC-T2-PCV-RESCUE-01 资源安全日志

## 0. 结论

本轮为离线、单进程、串行证明，无生产接入，无 self-play，无完整回归，无并发重负载。资源使用保持在预设范围内，未发现需要停止扩展的异常。

## 1. 开工预检

| 项目 | 观测值 |
|---|---|
| 物理内存总量 | 16,473,912 KB |
| 物理内存可用 | 2,754,804 KB |
| 页面/虚拟内存总量 | 35,044,976 KB |
| 页面/虚拟内存可用 | 5,510,856 KB |
| 既有无关 Node 进程 | PID 2500、11644、40300、14184（docmap 相关工作） |
| 本轮是否终止既有进程 | 否 |
| worktree 条目 | 65（15 个既有 tracked 修改 + 50 个未跟踪条目） |

判断：

- 可用物理内存约 2.75GB，足够固定 D1 与证书复验；本轮没有扩大 V8 heap，也没有同时启动多个重负载进程。
- 既有 Node 进程与 mutool/docmap 相关，不是本轮基准，未被终止或复用。
- 未发现同轮 T2 的重复基准进程；开工前没有另一个 PPC-T2-PCV-RESCUE-01 实例在运行。

## 2. 重复基准检查

执行前检查了：

- 同名目录 / 同名任务是否有第二份正在运行的证明；
- 是否有残留的 vitest 进程或 worker；
- 是否已有 T2 候选/证明原始文件。

结果：

- 没有重复 T2 基准；
- 没有复用上一轮的运行目录；
- 只读取 T1 与 P3 的冻结产物，未覆盖任何历史文件；
- 唯一一次“交叉核对”是读取 `PPC-CAT-EVALUATOR-ABLATION-01/_raw/d1_rep1.json` 并比较，没有重跑 P3 全量搜索。

## 3. 串行约束

`probe/vitest.config.mts` 显式设置：

```
fileParallelism: false
maxWorkers: 1
minWorkers: 1
testTimeout: 3_600_000
```

执行方式：

- 每个 fresh process 串行处理 8 个 strata；
- 候选证明严格按冻结顺序逐条执行；
- 没有 `Promise.all`；
- 没有 worker pool；
- 没有并行启动两个 proof repetition；
- rep1 完成后才开始 rep2；
- 聚合脚本在两次重复都完成后单进程运行。

`HEAVY_WORKER_CONCURRENCY = 1`。

## 4. 计算量约束

| 约束 | 本轮实际 |
|---|---|
| strata 上限 | 8（全部使用，无扩展） |
| 每 strata 候选上限 | 2（全部 2 条，共 16 条） |
| 24-root 全搜索 | 未执行 |
| self-play | 未执行 |
| 完整回归 | 未执行 |
| 大规模 oracle | 未执行 |
| D1 节点上限 | 8,000,000（固定，未提高） |
| H0 节点上限 | 600,000（固定，未降低） |
| H1 节点上限 | 5,000（固定；本轮 0 次运行） |
| V8 heap 扩展 | 无 |
| 正确性上限降低 | 无 |

D1 只对 8 个 strata 各运行一次；16 条候选续写均来自同一搜索的 `planBranches`，0 次 fresh fallback。没有对 24 个根做全量 D1。

## 5. 运行窗口与峰值

| 项目 | rep1 | rep2 |
|---|---|---|
| RSS | 166.7 MB | 166.3 MB |
| heapUsed | 84.9 MB | 84.8 MB |
| 测量段耗时 | 161.74 ms | 163.40 ms |
| 判定 | 完成 | 完成 |

- 候选冻结：`2026-11-16T06:59:08.770Z`，冻结哈希 `8f5a3f9d99ac2f61c895255e72650b3761418cb58ff5152b7d5e94619f8fc3ed`。
- 聚合完成：`2026-11-16T07:01:05.908Z`。
- 两次重复的基线判定、候选判定、节点数、策略和汇总完全一致。
- 峰值 RSS 约 167MB，远低于可用内存；没有出现堆压力或进程重启。

## 6. 证明成本

| 项目 | 数值 |
|---|---|
| 基线独立复验叶节点 | 226 |
| 替代 H0 独立复验叶节点 | 492（最大单条 131） |
| H0 solve 中位数 | 2.49 ms |
| H0 solve+verify 中位数 | 2.59 ms |
| H0 solve+verify 最大 | 30.918 ms |
| H0 总时间 <=25ms | 13/16 |
| H1 运行 | 0 |
| verify failures | 0 |
| false PROVEN | 0 |

说明：25ms 是离线观测阈值，不是生产门；G1T9 有 3 条超过 25ms（最大 30.918ms），已如实保留，没有通过降低节点上限、跳过 verifier 或删除候选来修饰。

## 7. 生产隔离

本轮**没有**修改：

- 生产源码；
- 游戏规则；
- 搜索数学；
- H1；
- Sidecar；
- Guard；
- 100ms/150ms 预算。

没有 commit、push、merge。新增内容仅在 `PPC-T2-PCV-RESCUE-01/` 下；历史 T1/P3/P5/SEAL 产物未被覆盖。

## 8. 异常与处置

- 未发现内存、句柄、进程数或磁盘异常。
- 未发现重复基准或残留 worker。
- 未发现需要停止扩展的资源异常。
- 运行结束后没有遗留本轮 vitest/Node 进程。

## 9. 最终资源状态

```
HEAVY_WORKER_CONCURRENCY = 1
SERIAL_FRESH_REPETITIONS = COMPLETED (2)
DUPLICATE_BENCHMARK_CHECK = PASS
RSS_PEAK_MB = 166.7
HEAP_USED_PEAK_MB = 84.9
WORKER_POOL = NONE
PROMISE_ALL = NONE
V8_HEAP_EXPANSION = NONE
PRODUCTION_SOURCE_CHANGED = NO
PRODUCTION_WIRING = NO
SELF_PLAY = NOT_PERFORMED
FULL_REGRESSION = NOT_PERFORMED
COMMIT = NO
PUSH = NO
MERGE = NO
RESOURCE_ANOMALY = NONE
```
