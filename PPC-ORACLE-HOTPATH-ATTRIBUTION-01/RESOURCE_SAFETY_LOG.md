# RESOURCE_SAFETY_LOG — PPC-ORACLE-HOTPATH-ATTRIBUTION-01

记录本轮的准入判定、重型执行窗口与保护文件状态。判定工具：`scripts/admission.mjs`（五次连续探测，floor = 2560 MB，取 `Win32_OperatingSystem.FreePhysicalMemory`，并统计本树内 vitest 进程、树外 vitest、重复基准进程）。

## 0. 为什么准入在进程外

vitest worker 自身占用约 0.3–0.5 GB；如果在测试内部采样可用内存，等于用一个已经被自身占满的内存去对照 floor，会出现“进程内永远失败、进程外刚好通过”的假象。因此：

- 每次重型启动**之前**、在独立 node 进程里跑 `admission.mjs`；
- 只有五次探测全部 ≥ floor、且本树无残留 vitest / 无重复基准进程，才允许启动；
- 测试文件内部不再做准入（`logs/g1_note_admission.json` 记录该决定）。

## 1. 探测记录

| 记录文件 | 目的 | 五次 freeMB | 结论 |
|---|---|---|---|
| `logs/g0_admission.json` | G0 初检（进程内，已废弃的口径） | 1958 / 1986 / 2025 / … | REFUSED（且发现 3 个树内 vitest 进程） |
| `logs/admission_2026-11-20T13-55-14-865Z.json` | G1+G3 第一次尝试 | 3608.6 / 3548.6 / 3544 / 3534 / 3683.5 | ADMITTED |
| `logs/admission_2026-11-20T13-58-46-091Z.json` | 中途复检 | 1888.7 / 1827.8 / 1950.9 / … | REFUSED（保持静态工作） |
| `logs/admission_2026-11-20T14-07-48-924Z.json` | G1+G3 最终取证运行 | 2809.5 / 2779.7 / 2854.7 / 2895.9 / 2940.3 | ADMITTED |
| `logs/admission_2026-11-20T14-11-16-997Z.json` | G4 第一次尝试 | 2127.4 / 1904.5 / 1891.7 / 1901.3 / 1846.9 | REFUSED → 转后台有界等待 |
| `logs/admission_2026-11-20T14-12-02-846Z.json` … `14-22-58-548Z`（7 条） | G4 rep1 前的连续重试 | 1.94–3.26 GB 间波动，最高一次 3262.1 但随后跌破 floor | REFUSED（第 1–9 次尝试） |
| `logs/admission_2026-11-20T14-25-39-569Z.json` | G4 rep1 启动 | 3039.1 / 3071 / 3097.8 / 3132.6 / 3130.8 | ADMITTED → rep1 运行完成（165.6 s，pid 2136） |
| `logs/admission_2026-11-20T14-28-49-901Z.json` | G4 rep2 启动 | 2711 / 2675.5 / 2658.4 / 2687.7 / 2735.2 | ADMITTED → rep2 完成（pid 6344） |
| `logs/admission_2026-11-20T14-31-43-807Z.json` | G4 rep3 启动 | 3734.9 / 3825.1 / 3757.9 / 3721.7 / 3485.3 | ADMITTED → rep3 完成（158.1 s，pid 37520） |
| `logs/admission_2026-11-20T14-38-42-832Z.json` … `14-46-27-933Z`（7 条） | 记账/保活 microbench 前重试 | 1.06–3.92 GB 间波动 | 第 6 次 ADMITTED |
| `logs/admission_2026-11-20T14-47-48-744Z.json` | `cache_wiring_microbench` | 3778.2 / 3910.8 / 3890 / 3924.9 / 3793.3 | ADMITTED（1.2 s 测试） |
| `logs/admission_2026-11-20T14-48-27-369Z.json` | `g4_gc_retention` | 2888.9 / 2945.1 / 2910 / 2905.5 / 2897.3 | ADMITTED（11.8 s 测试） |

所有记录都显示：`vitestProcesses=0`、`duplicates=0`、`foreignNodeProcesses=2`（用户自己的常驻 node，与本轮无关，未触碰）。拒绝的窗口一律只做静态工作（文档/脚本），从未在未准入的状态下启动重型任务；等待过程没有降低任何门槛（root/上限/重复次数不变）。

## 2. 重型执行规则的实际执行

- `HEAVY_WORKER_CONCURRENCY=1`：任何时刻只有一个 vitest 进程；G1+G3 合并运行、G4 逐 rep 串行，均由 `scripts/run_round.sh` 顺序驱动。
- `SERIAL_FRESH_REPETITIONS=TRUE`：G4 rep 1/2/3 各起一个全新 vitest 进程（日志内记录 `pid`）。
- `DUPLICATE_BENCHMARK_CHECK=REQUIRED`：每次启动前的五次探测都检查本树 vitest 与重复基准；等待循环（`scripts/wait_admit.sh`）在 REFUSED 时只重试准入，不降低 root/上限/重复次数。
- 未降低任何门槛：roots 仍为 DUUD/UURR/DRRR(mouseForce+catSurvive)/LLLD，cap 仍为 QCAP_LOCAL，H=2、start=1，缓存上限 20,000。
- 环境波动：会话中页面文件在用量峰值约 2.8–6 GB，可用物理内存在 1.2–3.7 GB 间摆动（用户 Chrome 常驻，非本实验进程）。REFUSED 的窗口只做静态分析与文档，不做重型执行。
- 未联系任何云端主机；未扩大 V8 heap；未增加并发。

## 3. 保护文件

以下文件在本轮中**只读**（被读取核对，从未写回）：`GAMEPLAY.md`、`src/**` 全部生产源码、`PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts`（SEAL）、H0/H1、E1、PCV、搜索数学、`stateKey` 实现、100ms/150ms 时限配置。

所有探针代码位于 `PPC-ORACLE-HOTPATH-ATTRIBUTION-01/probe/`，日志位于 `.../logs/`，均为研究副本。工作区中他人未提交的改动未被触碰（`COMMIT=NO` `PUSH=NO` `MERGE=NO` `PRODUCTION_WIRING=NO`）。