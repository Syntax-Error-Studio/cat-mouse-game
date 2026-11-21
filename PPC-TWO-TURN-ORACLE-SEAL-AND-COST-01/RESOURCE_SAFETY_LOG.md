# 资源与安全记录（RESOURCE_SAFETY_LOG）

- 主机：16,087.8 MB 物理内存。确定性轮共执行 **两批** 三次串行新进程（第一批 3,527.5 / 3,500.0 / 2,863.2 MB；
  修正一处工件文字后整批重跑，第二批 **3,800.9 / 2,705.0 / 3,903.7 MB**，
  `logs/rep{1,2,3}/g0_admission.json` 现为第二批）。
- 准入线：可用物理内存 ≥ 1,200 MB 且无重复 heavy worker；三次均 `LOCAL_ADMITTED`。
- 无重复 worker：每次查询 `vitest` 进程 3 个，其中 **0 个在本进程树之外**；唯一的外部 node 进程是
  Qoder 的 `computerUseClientLauncher.cjs mcp`（12 MB），与本轮无关。
- `HEAVY_WORKER_CONCURRENCY=1`：三次重复严格串行、每次独立新 vitest 进程；未并行跑两个 heavy。
- 峰值内存：本轮最重路径（G2 DUUD 证明 + 验证器）实测 RSS **268.0 MB**；G4 各层 110–334 MB；
  无 V8 heap 扩大参数，无 `--max-old-space-size` 调整。
- 未接触云端：没有访问、停止或重启 8787/8788 上任何服务；本轮不需要云端准入。
- 未修改：`GAMEPLAY.md`、`src/` 生产源、E1、H0/H1、PCV、搜索数学、`stateKey`、100ms/150ms 常量。
  受保护的既有未提交修改（`src/game/mapDefinition.ts`、`src/pages/EditorPage.tsx`、
  `src/pages/GamePage.tsx`、D2-PCV-02 三件）保持原样，未被覆盖、回滚或暂存。
- 未执行：full-grid、self-play、排序器调权、实时 H2 接线、跨根/跨前沿证书移植、冻结工件覆盖。
- 时间/环境波动只进性能摘要，不进语义摘要（`probe/digest.mjs` 的 VOLATILE 列表含
  `elapsedMs/peakRssMB/freeMB/host/withinCheapBudget` 等）。
- 已知限制：RSS 是各自 worker 进程的读数，G4 L0（约 20–110 MB）是冷进程基线，不与 G2 的 268.0 MB 混淆。