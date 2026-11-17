# RESOURCE_SAFETY_LOG · PPC-D2-PCV-COUNTERLINE-02

**范围**：本轮到 G0 为止，未启动任何 heavy 任务。
**结论**：G0 资源准入 FAIL，按协议停止，未执行任何消耗型负载。

## 1. 环境基线

| 项 | 值 |
|---|---|
| 采样主机 | 本地 Windows（win32），24 逻辑核 |
| 物理内存 | 16088 MB |
| 提交上限 | 34224 MB |
| 已提交（10 样本区间） | 25917 – 28978 MB |
| 系统 uptime | 110.7 h（2026-11-12 09:00 起，未重启） |
| 页面文件 | C:\pagefile.sys 2048 MB（用 1110）；E:\pagefile.sys 16087 MB（用 1422，峰 4633） |
| 进程总数 | 370 – 393 |

## 2. 准入采样

- `logs/g0_resource_samples.json`：ADMISSION-1，5 样本，23:39:30–23:40:10，间隔 10 s
- `logs/g0_resource_samples_retry.json`：ADMISSION-2-RETRY，5 样本，23:40:24–23:41:12，间隔 12 s

门槛：FREE_PHYS_MB ≥ 4096、FREE_COMMIT_MB ≥ 8192。

| 尝试 | freePhys 区间 | freeCommit 区间 | FREE_PHYS | FREE_COMMIT |
|---|---|---|---|---|
| ADMISSION-1 | 1882 – 3411 | 5245 – 8307 | FAIL（缺 685 MB @最好样本） | FAIL（仅 s5 达标；s4=8191，差 1 MB） |
| ADMISSION-2 | 1944 – 2168 | 8072 – 8249 | FAIL（缺 1928 MB） | FAIL（仅 r5 达标） |

10 样本中 0 个同时满足两项。

## 3. 口径纪律

- 冻结口径：`Win32_OperatingSystem.FreePhysicalMemory`（**不含 standby list**）。
- 交叉核对 `Available MBytes`：10 样本最大 3266 MB，仍 < 4096。
- **未**改用其它口径来放宽门槛（与 `PPC-D2-PCV-COUNTERLINE-01` 的处理方式一致）。

## 4. 并发与负载

| 项 | 值 |
|---|---|
| HEAVY_WORKER_CONCURRENCY | 1（未启动任何 worker，实际并发 0） |
| 本机 heavy worker（vitest/jest/bench/mocha） | 0 |
| 重复 D2 实例 | 0（扫描唯一命中为采集脚本自身） |
| node.exe 总数 | 13（WorkBuddy 7 + Codex 6，全部为 MCP/运行时宿主） |
| CPU 负载（采样） | 0 – 14 % |

## 5. 禁止项执行情况

| 禁止项 | 状态 |
|---|---|
| 杀死无关进程 | 未执行（0 个进程被终止） |
| 扩大 V8 heap | NO（未传 `--max-old-space-size`） |
| 扩大 pagefile | NO（未改任何页面文件设置） |
| 提高并发 | NO |
| `git checkout / reset / clean / stash` | NO |
| commit / push / merge | NO |
| 生产源码修改 | NO |
| 完整 8 strata / self-play / 完整回归 | NOT_PERFORMED（亦未授权） |

## 6. 停止点

G0 资源准入 FAIL → 协议要求「只完成只读审计并停止」。
本轮实际消耗：仅文件读取与 10 次内存采样；**D2 节点数 0，候选 0，证明 0**。
恢复方式：待桌面负载释放、FREE_PHYS ≥ 4096 且 FREE_COMMIT ≥ 8192 后重跑 G0，再进 G1。

## 7. 旁见（不处理，仅记录）

- 整机提交量长期高于物理内存 10 GB 以上，是本机多次准入失败的**结构性原因**；它不影响本轮任何判定的正确性，只影响能否开工。
- 本轮 `G0_PROCESS_INVENTORY` 采集脚本在写入文件后，其 shell 调用被沙箱策略拒绝（用户侧 deny）。文件在拒绝前已完整落盘（28999 B），内容可用；**未重试该命令**。这属于工具层限制，不影响任何门槛判定。
