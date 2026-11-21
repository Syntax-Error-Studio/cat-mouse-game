# RESOURCE_SAFETY_LOG — PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01

云主机：`docmap` (203.195.203.152, ubuntu)，仓库 `/opt/ppc-bench/repo`，运行目录 `/opt/ppc-bench/runs/04`，
node v24.19.0（guard 自行设置 PATH）。主机 uptime 86 天，全程未重启、未部署、未改动线上服务。

## 准入门槛（guard 内固定）

| 项 | 门槛 | 结果 |
| --- | --- | --- |
| MemAvailable | 连续 5 次采样 ≥ 2.5 GiB | 全部 6 个阶段 PRECHECK=PASS |
| SwapFree | ≥ 1 GiB | 3886772 KB（≈3.71 GiB）恒定 |
| 新 swap-out / 新 OOM | 运行期间不得增加 | PSWPOUT 553823、OOM_KILL 3 全程不变 |
| 受保护服务 8787/8788 | active 且 MainPID 不变 | `catmouse-web` 1129202、`catmouse-research` 3778168，全程不变 |
| 其他 heavy / 部署 / 重复任务 | 必须为 0 | 全部为 0（重复检查按阶段名独立） |
| 磁盘 | ≥ 2 GiB | ≈20 GiB |

执行方式：`nice -n 19 taskset -c 3 vitest run --config ... <单个测试文件>`；每阶段一个 fresh process，
严格串行，无并发、无 heap 扩容、无 800 万节点上限调整。

## 逐阶段记录（runs/04）

| 阶段 | 测试 | 耗时 ms | 采样 | 运行期 MemAvailable 最低 KB | 峰值 job tree RSS KB | RC | ABORT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| g0 | g0_identity.test.ts | 3195 | 3 | 2492112 | 552632 | 0 | NONE |
| enum_rep1 | enumeration.test.ts (PPC_REP=1) | 4251 | 4 | 2250720 | 589836 | 0 | NONE |
| enum_rep2 | enumeration.test.ts (PPC_REP=2) | 4268 | 4 | 2255732 | 737964 | 0 | NONE |
| enum_rep3 | enumeration.test.ts (PPC_REP=3) | 4247 | 4 | 2246616 | 565652 | 0 | NONE |
| decompose | decompose.test.ts（首跑，horizon 字段名有误） | 6423 | 6 | 2217752 | 787816 | 0 | NONE |
| decompose2 | decompose.test.ts（修正 horizon 读取后的正式件） | 6393 | 6 | 2216432 | 785336 | 0 | NONE |

- 运行期 MemAvailable 最低 2216432 KB ≈ 2.11 GiB：高于 guard 的 1 GiB 中止线；准入时的 5 连采样 ≥ 2.5 GiB 均已满足。
- 阶段内部测试统计（来自 stdout）：枚举 110 条完整猫回合、46 个展开状态、55/54/53 ms；分解两次 depth-1 搜索
  合计约 0.9 s 测试体时间（含 2×~11k 节点）。
- 全程 0 进程残留（报告前复查 `ps | grep vitest` = 0）。

## 报告时点复查（2026-11-19T13:44Z，只读）

- MemAvailable 2868 MB，SwapFree 3795 MB，load1 0.48。
- `catmouse-web` / `catmouse-research` 均 active，MainPID 与开跑前一致（1129202 / 3778168）。
- `pswpout=553823`、`oom_kill=3` 与准入基线相同；无新 swap-out、无 OOM。
- `runs/04` 共 30 个文件（6 阶段 × 5 件，decompose 与 decompose2 各一套）；轮次目录工件齐备。

## 约束遵守

- 未修改 `src/`、GAMEPLAY.md、E1、搜索数学、Sidecar、Guard，未提高并发或 V8 heap，未调整 800 万节点上限。
- 未执行 self-play、全 8 根实验或生产接线；未 commit / push / merge。
- 历史目录 `PPC-G6T2-SELECTION-CAUSE-01` 仅被读取；其 SOURCE_MANIFEST 与 SHA256SUMS 以只读副本形式
  放在本轮 `reference/`，未写入历史目录。
