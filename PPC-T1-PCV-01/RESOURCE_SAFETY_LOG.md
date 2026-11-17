# PPC-T1-PCV-01 — 资源与安全检查日志

**日期**: 2026-11-16
**轮次类型**: READ_ONLY_POSTHOC_MEASUREMENT
**工作树**: `F:\小猫小鼠`（唯一权威）
**分支 / HEAD**: `ppc/p1-id-state-identity-fix` / `48eaac6c4f3801d351787696ba5876995b64e8d8`
**重负载并发**: `HEAVY_WORKER_CONCURRENCY = 1`
**重复方式**: `SERIAL_FRESH_REPETITIONS = TRUE`

---

## 1. 开始前检查

### 1.1 身份

| 项目 | 结果 |
|---|---|
| 分支 | `ppc/p1-id-state-identity-fix` |
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8` |
| `GAMEPLAY.md` SHA256 | `e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34` |
| fixture SHA256 | `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09` |
| P5 结果 SHA256 | `9d50560f107da52107cb68be94f4ac90214f8a50aabbc948f8f3114215278775` |
| SEAL kernel SHA256 | `453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b` |
| `preparedActions.ts` SHA256 | `67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764` |
| `expectiminimax.ts` SHA256 | `50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c` |
| `engine.ts` SHA256 | `099f9a7b6d97b838c664aa7186be58465e5b01b8052af4b4e4e19a5644d19f06` |
| FOUNDATION 预注册 SHA256 | `3dd79a40fda42af91056c3662fbb92ae0ad0da2c9fa9e50670eea139f3b06bfc` |

与任务书给定值一致。工作树的 15 个已跟踪源码修改是**本轮之前已存在**的 P1/P2 状态；本轮没有触碰这些文件，也没有覆盖/重建任何冻结源。

### 1.2 重复 benchmark 检查

- 开始前检查：没有正在运行的 `PPC-T1-PCV-01` Node/Vitest 进程；
- 没有其他 PCV 结果目录或并行 benchmark；
- `_raw/` 只由本轮 5 次串行重复生成；
- 未发现遗留 worker pool / shell 循环 / 后台重复任务。

### 1.3 系统资源

| 项目 | 开始值 |
|---|---:|
| 物理 RAM | 15.71 GB |
| 空闲物理 RAM | 约 2.1–2.25 GB |
| Commit limit | 33.42 GB |
| 空闲 commit | 约 6.7–7.0 GB |

系统内存偏紧但不是 OOM 边缘；本轮峰值 RSS 321.7MB，未触发 swap/OOM。

### 1.4 无关工作负载

开始前/期间存在的无关 Node 进程：

| PID | 用途 | 处理 |
|---:|---|---|
| 2500 | `next dev --hostname 127.0.0.1 --port 3255` | 未终止 |
| 11644 | `docmap-studio` Next start-server | 未终止 |
| 40300 / 14184 | `docmap-studio` PostCSS dev build workers | 未终止 |
| 10492 | `.local/ai-reliability.../review/resume-run.mjs`（13:49:16 启动，低 CPU，77.4MB） | 未终止 |

这些进程不属于 PCV，也不是本轮创建。它们与测量窗口重叠，可能是 G1T9/G1T5 墙钟尖峰的环境噪声来源。**没有终止任何用户工作负载。**

---

## 2. 执行方式

### 2.1 串行新进程

5 次重复各自在独立 Node 进程中运行，逐次启动；没有 `Promise.all`、worker pool、并行 Vitest、V8 heap 扩展或 `--max-old-space-size`。

`logs/run_log.txt`：

```
START rep=1 at=2026-11-16T05:54:11.151Z
END rep=1 rows=48 ms=5913 rssMB=320.8
START rep=2 at=2026-11-16T05:55:01.333Z
END rep=2 rows=48 ms=9771 rssMB=300.1
START rep=3 at=2026-11-16T05:55:14.147Z
END rep=3 rows=48 ms=6877 rssMB=318.7
START rep=4 at=2026-11-16T05:55:23.280Z
END rep=4 rows=48 ms=13840 rssMB=299.6
START rep=5 at=2026-11-16T05:55:39.505Z
END rep=5 rows=48 ms=13271 rssMB=321.7
```

START/END 无重叠。`repMs` 是 48 个 strata 的测量循环时间，不含进程启动/导入/收尾；日志中相邻 START 的间隔包含这些开销。总测量窗口约 101.6s（05:54:11–05:55:53Z）。

### 2.2 每次重复

- RSS：300.1–321.7 MB；heapUsed：143.4–172.9 MB；
- 每次 48 个 strata，3 个查询 + verifier，约 144 次 solve/verifier 组合；
- 5 次合计 240 个观测、720 个查询结果；
- 没有减少观测、没有替换根、没有提前停止。

### 2.3 查询上限

- H0 `mouseForce` / `catSurvive`：600000 节点；未降低；
- H1 `catSurvive`：5000 节点（预注册 phase1）；未升级到 20000；
- 量词内核无墙钟 deadline；墙钟为事后测量；
- 100 个 H1 截断全部保留为 `UNRESOLVED_CAP`，没有当成 true/false。

---

## 3. 测量噪声

- 同一 G1T9 `mouseForce` 查询：节点数始终 659，但 5 次重复中 2 次为 19–22ms，3 次为 56–85ms；两臂合计 10 次查询只有 4 次 `<=25ms`；
- G1T5 H0 存活：6978 节点，单次 solve 约 209–213ms，加 verifier 约 418–425ms；5 次重复中最大 1318ms；
- 完整 PCV 观测中位数 153.37ms，p95 620.35ms，最大 1756.13ms；同一 strata 的节点/value/证书完全确定，只有墙钟变化；
- 这些尖峰与无关 Node 进程、GC、系统调度一致，但没有做因果归因；本轮只记录“墙钟不稳定”，不把噪声当作算法成本。

**结论**：`WITHIN_25MS=FALSE` 是保守结论；即使某些重复偶然低于 25ms，也不能保证生产实时性。

---

## 4. 产物与写盘范围

本轮只写 `PPC-T1-PCV-01/`：

- 9 个交付物；
- `_raw/`：5 个 rep、AGGREGATE、replay_all、pilot；
- `logs/run_log.txt`；
- `probe/`：PCV 测试与库（研究代码，不进入生产）。

没有修改：

- `src/` 下任何生产文件；
- `GAMEPLAY.md`；
- P1/P2/SEAL/ERRATUM/FOUNDATION 历史工件；
- 100ms/150ms 配置；
- Sidecar / Guard / 鼠 AI / H1 生产逻辑。

没有执行：

- 自对弈；
- 完整回归；
- METHOD_A；
- 大搜索 benchmark；
- 正式计时 benchmark；
- commit / push / merge / reset / clean / stash。

---

## 5. 结束状态

| 项目 | 结果 |
|---|---|
| 分支 / HEAD | 不变 |
| 工作树 | 65 条 porcelain：15 个已跟踪修改（预先存在）+ 50 个未跟踪（含本轮 `PPC-T1-PCV-01/`） |
| 物理 RAM | 15.71 GB |
| 空闲物理 RAM | 2.25 GB |
| Commit limit / free | 33.42 GB / 6.69 GB |
| 本轮峰值 RSS | 321.7 MB |
| 无关 Node 进程 | 仍在运行，未终止 |
| 重复 benchmark | 无 |
| 生产源码改动 | 无 |
| Git 写操作 | 无 |

---

## 6. 结论

资源使用在安全范围内；没有终止任何用户工作负载；5 次重复严格串行、独立进程；240 个观测和 720 个查询完整保留。墙钟存在明显环境噪声，因此 25ms 结论只能作为离线可行性标签，不能作为生产实时保证。
