# PPC-D2-PCV-COUNTERLINE-02 · G0 准入报告（只读）

- 轮次：`PPC-D2-PCV-COUNTERLINE-02`
- 阶段：G0（强制身份与资源准入）
- 时间：2026-11-16 23:38–23:44 (+08:00)
- 结论：**G0_IDENTITY = PASS，G0_RESOURCE_ADMISSION = FAIL**
- 处置：按协议 §2.2「任一准入门失败，只完成只读审计并停止」——**G1–G6 全部 NOT_PERFORMED，未启动 D2，未生成候选，未跑证明**

---

## 1. 身份核对（§2.1）全部逐字节匹配

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8` | 同 | PASS |
| BRANCH | `ppc/p1-id-state-identity-fix` | 同 | PASS |
| 24-root fixture | `1a59787a…8e0db09` | 同 | PASS |
| GAMEPLAY.md | `e000778b…f2afd34` | 同 | PASS |
| P5 RESULTS | `9d50560f…5278775` | 同 | PASS |
| T2 candidate freeze | `8f5a3f9d…9f8fc3ed` | 同 | PASS |
| TAIL candidate | `39cc3569…4fcae8b8` | 同 | PASS |
| SEAL kernel（`probe/seal_lib.ts`） | `453915d3…576a779b` | 同 | PASS |

13 个受监视生产文件全部与 `PPC-D2-PCV-COUNTERLINE-01/G0_RESUME_CHECK.json` 冻结摘要逐字节一致。

工作树：69 行变更（15 tracked modified + 54 untracked），与上一轮基线一致；**未执行 checkout / reset / clean / stash**，既有未提交修改原样保留。

## 2. 资源准入（§2.2）失败

门槛：`FREE_PHYS_MB ≥ 4096`、`FREE_COMMIT_MB ≥ 8192`，串行 5 次采样。

### 2.1 ADMISSION-1（23:39:30–23:40:10）

| 采样 | FREE_PHYS_MB | FREE_COMMIT_MB | Available MBytes | 进程数 |
|---|---|---|---|---|
| s1 | 1882 | 5245 | 1658 | 393 |
| s2 | 2549 | 5763 | 2597 | 389 |
| s3 | 2907 | 6447 | 2932 | 387 |
| s4 | 3037 | **8191** | 3027 | 372 |
| s5 | **3411** | 8307 | 3266 | 371 |

- FREE_PHYS：0/5 达标，最好样本 3411，**缺 685 MB**
- FREE_COMMIT：1/5 达标（s5）；s4 = 8191，差 1 MB

### 2.2 ADMISSION-2-RETRY（23:40:24–23:41:12）

| 采样 | FREE_PHYS_MB | FREE_COMMIT_MB | Available MBytes |
|---|---|---|---|
| r1 | 2168 | 8113 | 2072 |
| r2 | 2029 | 8082 | 2012 |
| r3 | 2036 | 8072 | 2220 |
| r4 | 1944 | 8182 | 1934 |
| r5 | 2018 | 8249 | 2002 |

- FREE_PHYS：0/5 达标，最好 2168，**缺 1928 MB**
- FREE_COMMIT：1/5 达标（r5）

### 2.3 合计

10 个样本中：满足 FREE_PHYS 的 **0** 个，同时满足两项的 **0** 个。

**口径说明**：冻结口径是 `Win32_OperatingSystem.FreePhysicalMemory`（不含 standby list）。本轮额外交叉核对了 `Available MBytes`，10 个样本最大 **3266 MB**，仍低于 4096——**不存在任何一种口径能把判定翻成 PASS**，因此不涉及「换口径放宽门槛」的问题。

### 2.4 结构性原因（只记录，不处理）

- 物理内存 16088 MB，提交上限 34224 MB，当前**已提交 25.9–29.0 GB**，即整机超售约 10–13 GB。
- 页面文件：`C:\pagefile.sys` 2048 MB（用 1110）、`E:\pagefile.sys` 16087 MB（用 1422，峰值 4633）。页面文件占用并不高，说明压力来自各进程的私有提交量而非换页堆积。
- 上一轮（`PPC-D2-PCV-COUNTERLINE-01`）同日 17:28 也曾在 1561–1818 MB 判 FAIL，等外部 ESP-IDF 构建与桌面负载退出后，19:13 窗口回到 5428–5841 MB 判 PASS。**同一台机器、同一门槛，属于可恢复的瞬时环境状态，而不是门槛设计问题。**

## 3. 进程准入（PASS）

- `node.exe` 共 13 个：WorkBuddy 运行时 5、WorkBuddy MCP 2、Codex 运行时 6，**无 vitest / fork worker / D2 实例**。
- `vitest|jest|bench|mocha` 正则命中 **0**。
- 重复 benchmark 扫描（`counterline|D2_PILOT|searchBestAction|expectiminimax|e1bench|g03|vision-bench|ppc-`）原始命中 1 条，**唯一命中是采集脚本自身的 pwsh 进程**（其命令行里含本目录字面路径），真实重复实例 **0**。
- 未杀死任何无关进程；未改页面文件；未扩 V8 heap；未提并发。

## 4. 门槛矩阵

| 门槛 | 结果 |
|---|---|
| G0_IDENTITY | **PASS** |
| G0_FROZEN_INPUTS | **PASS** |
| G0_PRODUCTION_SOURCES_UNCHANGED | **PASS** |
| G0_DUPLICATE_BENCHMARK | **PASS** |
| G0_RESIDUAL_HEAVY_WORKER | **PASS** |
| **G0_RESOURCE_ADMISSION** | **FAIL（FREE_PHYS_MB）** |
| G1 既有 G6T2 证据复核 | NOT_PERFORMED |
| G2 固定深度 D2 | NOT_PERFORMED |
| G3 planBranches 身份审计 | NOT_PERFORMED |
| G4 候选生成与冻结 | NOT_PERFORMED |
| G5 独立 PCV 战术证明 | NOT_PERFORMED |
| G6 重复与封口 | NOT_PERFORMED |

## 5. 核心问题 A–I 的处置

**全部 = NOT_ANSWERABLE（本轮未产生任何证据）。**

A–I 每一项都依赖「G6T2/E1 固定 D2 搜索 + 候选冻结 + PCV 证明」这条链；G2 未启动，因此：

- 不宣称 D2 是否提取到 DRRR；
- 不宣称 D2 是否在树中访问过对应状态；
- 不宣称 E1 三个根值是否再次同分（上一轮同分结论属于 **G1T9**，不是 G6T2，**不得跨根搬运**）；
- 不宣称 FIRST_WRITE 与 LAST_WRITE 是否影响计划身份；
- 不宣称 UURR / DRRR / DRDR 的证明状态；
- 不宣称多结果 CHANCE 是否真正触发 AND 展开。

以上均按「以运行代码为准」处理，不从记忆、旧轮次或根之间类推。

## 6. 恢复条件（可操作）

要让 G0 通过，需要把 FREE_PHYS 从当前 ~2.0 GB 抬到 ≥ 4096 MB（至少 +2.1 GB；按 ADMISSION-1 峰值 3411 计算最乐观也还差 685 MB），并把 FREE_COMMIT 稳定在 ≥ 8192 MB。

建议动作（由用户执行，我不代劳）：

1. 关闭 Chrome / RoxyChrome 全部进程（当前合计约 1.3–1.4 GB）；
2. 关闭 ChatGPT 桌面包（约 700–740 MB）与 Codex 运行时（6 个 node）；
3. 保持 WorkBuddy 本体即可（其运行时 node 合计 < 150 MB）。

达成后重跑 G0 采样，通过即从 G1 继续；未通过则继续只读等待。

---

**PRODUCTION_SOURCE_CHANGED = NO ｜ GAME_RULES_CHANGED = NO ｜ SEARCH_MATH_CHANGED = NO ｜ H1_CHANGED = NO ｜ SIDECAR_CHANGED = NO ｜ GUARD_CHANGED = NO ｜ 100MS_150MS_CHANGED = NO**

**COMMIT = NO ｜ PUSH = NO ｜ MERGE = NO ｜ STOP = YES（等待裁决后另行决定是否重试准入）**
