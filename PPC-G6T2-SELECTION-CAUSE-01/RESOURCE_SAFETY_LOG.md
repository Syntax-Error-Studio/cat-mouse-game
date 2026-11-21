# RESOURCE_SAFETY_LOG — PPC-G6T2-SELECTION-CAUSE-01

云主机：`docmap` (203.195.203.152, ubuntu)，仓库 `/opt/ppc-bench/repo`（无 git 历史），
运行目录 `/opt/ppc-bench/runs/03`，node v24.19.0（nvm 路径，guard 自行设置 PATH）。

## 准入门槛（每次重型运行前重新检查，全部满足才启动）

| 门槛 | 阈值 | 实测（7 次运行前均满足） |
|---|---|---|
| MemAvailable 连续采样 | ≥ 2,621,440 kB（2.5 GiB）× 5 次连续 | 2,912,540 – 2,955,668 kB 起步，ADMISSION_SAMPLES=5_CONSECUTIVE_OK |
| SwapFree | ≥ 1,048,576 kB | 3,886,772 kB（全程不变） |
| 磁盘空闲 | ≥ 2 GiB | ≈ 21,148,000 kB |
| 其他重型任务 | 0 | HEAVY_PROCS=0 |
| 进行中的部署 | 0 | DEPLOY_PROCS=0 |
| 重复同一 benchmark | 0（同 phase result.txt 不存在） | DUPLICATE=0 |
| 受保护服务 8787/8788 | active 且 PID 不变 | PID 1129202 / 3778168，全部 precheck PASS |
| 新 swap-out / OOM | 相对基线不得新增 | 见下表，全程无新增 |
| 并发 | 重型 worker 固定 1，全部 fresh process 串行 | 执行器逐 phase 串行，未并行 |

执行器：`PPC-G6T2-SELECTION-CAUSE-01/scripts/run_03.sh`；
每个重型进程以 `nice -n 19 taskset -c 3 ./node_modules/.bin/vitest run --config ... <file>` 启动；
监控每 1 s 采样；出现 5 次 MemAvailable<1 GiB、新 pswpout、新 oom_kill、或受保护 PID 变化即中止（exit 92）。
准入采样记录：`runs/03/<phase>.admission.txt`；逐秒采样：`runs/03/<phase>.samples.csv`；前置检查：`runs/03/<phase>.precheck.txt`。

## 运行记录（全部 RC=0，ABORT=NONE）

| Phase | 开始 (UTC) | 结束 (UTC) | 墙钟 | 采样数 | MemAvailable 最低 | Job-tree 峰值 RSS | LOAD1 峰值 |
|---|---|---|---|---|---|---|---|
| g0 | 13:10:34.971 | 13:10:38.197 | 3,226 ms | 3 | 2,479,808 kB | 550,260 kB | 0.17 |
| g1 | 13:10:47.345 | 13:10:50.554 | 3,209 ms | 3 | 2,481,392 kB | 549,328 kB | 0.14 |
| g2_rep1 | 13:10:58.496 | 13:12:38.555 | 100,059 ms | 93 | 2,103,028 kB | 919,308 kB | 0.92 |
| g2_rep2 | 13:12:50.381 | 13:14:29.141 | 98,760 ms | 92 | 2,105,436 kB | 913,328 kB | 1.06 |
| g2_rep3 | 13:14:37.873 | 13:16:17.752 | 99,879 ms | 93 | 2,104,348 kB | 910,436 kB | 1.22 |
| g3 | 13:17:22.006 | 13:17:28.441 | 6,435 ms | 6 | 2,215,588 kB | 790,424 kB | 0.41 |
| g4 | 13:17:47.333 | 13:17:50.538 | 3,205 ms | 3 | 2,479,328 kB | 571,684 kB | 0.29 |

每次运行结束后再次检查：`PSWPOUT_MAX`、`OOM_KILL_MAX` 均等于基线（553,823 / 3），
SwapFree 全程 3,886,772 kB，无 swap-out、无 OOM、无受保护 PID 变化、无部署/重任务。

## 收尾再探测（报告时点，只读）

- `free -k`：Mem total 3,812,564 kB，available 2,936,840 kB；SwapFree 3,886,772 kB。
- `/proc/vmstat`：`pswpout 553823`、`oom_kill 3`（与基线相同）。
- `ss -ltn`：8787、8788 均 LISTEN；`systemctl is-active docmap-rapidocr.service` = active（MainPID 2,975,290，为宿主自有的 OCR 单元）。
- 无遗留 vitest / 本轮的 node 进程；仅宿主常驻服务（next-server、docmap-studio、tailscaled、YDService）。

## 未越界声明

- 未扩大 V8 heap，未提高 8,000,000 搜索节点上限，未降低证明正确性门槛。
- 未修改 `src/`、GAMEPLAY.md、E1、搜索数学、Sidecar、Guard 或 100ms/150ms 预算；生产源码只读。
- 未执行 self-play、全 8 根实验或生产接线；未重跑历史 H2 大证明（作为冻结正向控制标签使用）。
- 未 commit / push / merge。