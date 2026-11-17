# RESOURCE_SAFETY_LOG — 资源与范围纪律（TACT-9）

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows 10/11（Git Bash 5.x / MSYS） |
| Node | v22.22.2 |
| vitest | 4.1.10 |
| TS 运行 | `tsx`（一次性脚本）+ `vitest`（正式探针） |
| 仓库 | `F:\小猫小鼠`，HEAD `48eaac6c4f3801d351787696ba5876995b64e8d8`，分支 `ppc/p1-id-state-identity-fix` |

## 2. 并发纪律（全程遵守）

| 约束 | 执行方式 |
|---|---|
| `HEAVY_WORKER_CONCURRENCY = 1` | 每条跑测命令都显式 `HEAVY_WORKER_CONCURRENCY=1` |
| `--maxWorkers=1 --no-file-parallelism` | 所有 vitest 调用都带；`probe/vitest.config.mts` 里也写死 `fileParallelism:false`、`maxWorkers:1` |
| 串行、单进程 | 所有 `npx` 调用逐条串行；没有并行跑两个搜索 |
| 不 spawn 子进程池 | 探针内部不做 worker 池；`machineForcesWin` 是单线程递归 |

## 3. 节点/内存上限（全部显式）

| 用途 | 上限 | 是否触发 |
|---|---|---|
| 24 根筛选（H0/H1/猫侧） | 600,000 节点/根 | **未触发**（最大 G2T7 198,646） |
| 单开局判定 / 计划战术判定 | 600,000 | 未触发 |
| 猫防守线上鼠回应覆盖 | 300,000/次 | 未触发 |
| 固定深度 D1/D2/D3 | 400,000 | **D3 触发**（`completed=false`，已如实标 UNRESOLVED） |
| 拾取公告 29 分支 | 200,000/分支 | 未触发（每分支 138 节点） |

### 3.1 一次真实的内存事故（已修复，如实记录）

`mouseForcesWin` 初版带一个 `prepCache`，把每个访问过的节点的**转移对象**（含着全部后继状态）永久钉住。
在 `G2T7` 跑到约 50 万节点时 V8 堆爆到 **4 GB → FATAL ERROR: Reached heap limit**，进程被 OOM 杀掉。

- 定位：崩溃发生在 `G2T7`（该根鼠未带油 ⇒ 可靠下界剪枝不可用 ⇒ 树最大）。
- 根因：缓存**没有收益**（每个节点只算一次，memo 命中在缓存之前就返回了），却有 O(节点数) 的常驻内存。
- 修复：删掉 `prepCache`（`probe/lib.ts`，注释里写明原因）。
- 复测：`G2T7` 198,646 节点 / 8.5 s 正常完成；全 24 根再次零截断。
- 副作用检查：`G6T2` 根 H1 结果不变（105,544 节点），说明重构没有改变语义（还顺带把耗时从 9.6 s 降到 3.5 s）。

## 4. 随机性纪律

- 搜索/枚举期**零次** `Math.random`：`probe/chance_enumeration.test.ts` 用 stub 替换 `Math.random`，
  断言枚举过程中 `calls === 0`，并在 `finally` 里还原。
- 所有 24 根局面来自冻结 fixture（`stateKey` 由 P1-ID-01 的 injective terrain code 计算），无采样。
- 没有使用"固定种子"这类替代品（不需要：CHANCE 是全枚举，不是采样）。

## 5. 范围纪律（本轮没有做的事）

| 禁止项 | 状态 |
|---|---|
| 改生产搜索算法 / 评价权重 H1 / 游戏规则 / AI 策略 | **未做**（`src/` 本轮零改动） |
| 改 100 ms / 150 ms 常量 | **未做** |
| 改 `boundedPlanRefutation.ts` Sidecar / Progress Guard | **未做** |
| 改 Alpha-Beta / Expectiminimax 数学 / TT 语义 | **未做** |
| 改鼠 AI / P2 Prepared Transition | **未做** |
| DAG 再展开 / 3400-job primary / 大规模 self-play | **未做** |
| exhaustive oracle / METHOD_A | **未做** |
| 宣称棋力提升 | **未做**（报告只写战术判定，不写棋力） |
| `commit` / `push` / `merge` / `reset` / `checkout` / `clean` / `stash` | **未做** |
| 把研究原型放进生产源码目录 | **未做**（全部在 `PPC-CAT-STRATEGY-01/` 下） |

`src/` 的 13 个 `M` 状态文件是 **P1/P2 轮次留下的既有改动**（与本轮无关）。
本轮通过"逐文件 SHA256 与 P2 `SOURCE_MANIFEST.json` 全等"证明这一点，见 `SOURCE_MANIFEST.json` 的 `srcUnchangedThisRound` 段。

## 6. 磁盘与产物

| 项 | 值 |
|---|---|
| 新增目录 | `PPC-CAT-STRATEGY-01/{probe,fixtures/real_human,fixtures/synthetic,logs,_raw}` |
| 探针文件 | 7 个 `*.test.ts` + 1 个 `lib.ts` + 1 个 `vitest.config.mts` + 4 个工件生成脚本（`export_real_human.mjs` / `make_manifest.mjs` / `make_correctness.mjs` / `opening_tempo.mts`） |
| 合成局面 | 13 个 JSON（`fixtures/synthetic/`），全部标 `provenance: SYNTHETIC` |
| 真人局面 | 24 个 JSON + `INDEX.json`（`fixtures/real_human/`），全部标 `provenance: REAL_HUMAN_REPLAY`；由 `export_real_human.mjs` 从冻结 fixture（SHA `1a59787a…`）导出，导出时逐根复算 canonical 快照哈希并断言与原值相等（24/24 通过）。真实与合成**分目录存放**，不混。 |

## 7. 一次完整套件的耗时（见 `logs/probe-suite.log`）

最终权威运行：**7 个文件 / 24 个用例 / 264.73 s / exit 0**（串行、`maxWorkers=1`）。
其中最贵的是 `planner_audit`（约 105 s，含固定 D3 撞 400 k 上限）与
`tactical_tree`（约 65 s，24 根 × H0/H1/猫侧 + 3 个开局）。

> 说明：本轮所有时间数字都来自**单次**运行。按 `PPC-CAT-TIMING` 的教训，
> 亚秒级墙钟数字不能当结论；本报告只用它做"是否超出预算数量级"的判断（30–70× 这种量级差是安全的）。
> 同一条命令在同一天内跑过三次（262.33 s / 258.30 s / 264.73 s），而 `G6T2` 的 H1 节点数
> 三次都是 **105,544**、`G2T7` 三次都是 **198,646**，逐次完全相同，
> 只有墙钟有 ±2.5% 的抖动 —— 因此所有结论都以**节点数**为主要证据，墙钟只作量级参考。
