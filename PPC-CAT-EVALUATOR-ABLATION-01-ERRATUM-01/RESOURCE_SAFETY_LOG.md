# RESOURCE_SAFETY_LOG — PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01

**目的**: 记录本轮只读复核、证书补证与派生指标修正的资源使用、串行性、重复基准检查和原始工件保护情况。

**执行窗口**: 2026-11-15T16:38:40Z — 2026-11-15T16:38:43Z（测试进程）；文件写入持续到 16:38:43Z。
**HEAD**: `48eaac6c4f3801d351787696ba5876995b64e8d8`
**平台**: Windows 10.0.26200 x64，Git Bash，Node v24.13.0，vitest 4.1.10。

---

## 1. 约束遵守清单

| 约束 | 状态 | 证据 |
|---|---|---|
| `HEAVY_WORKER_CONCURRENCY = 1` | 遵守 | `vitest.config.mts`: `fileParallelism:false`, `maxWorkers:1`；只有 1 个 test file，T1/T2 顺序执行 |
| `SERIAL_FRESH_REPETITIONS = TRUE` | 遵守 | 本轮只启动 1 次 vitest；没有并行重复；P5 的 5 个 fresh-process 轮次是既有工件，只读 |
| `DUPLICATE_BENCHMARK_CHECK = REQUIRED` | 遵守 | 运行前 census 无 ablation/vitest 进程；运行后无 vitest/esbuild 残留；只执行 1 次本测试命令 |
| `PRODUCTION_SOURCE_CHANGE = NO` | 遵守 | 15 个 `src/game/**` 源文件测试前后 SHA-256 与 mtime 一致；本轮只写 `PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01/` |
| `GAME_RULES_CHANGE = NO` | 遵守 | 未修改 `src/game/engine.ts`、`types.ts`、`rules/**`；仅调用真实 RuleSet 回放 |
| `SEARCH_MATH_CHANGE = NO` | 遵守 | 未修改 `expectiminimax.ts`、`hardTurnPlanner.ts`、`searchConfig.ts` 等 |
| `H1_CHANGE = NO` | 遵守 | 未修改 hybrid leaf / H1 配置或代码 |
| `100MS_150MS_CHANGE = NO` | 遵守 | 未修改搜索/回合预算；P5 契约仍为 100ms 主搜索、150ms 名义回合墙 |
| `FULL_24_ROOT_RERUN = NO` | 遵守 | 24 根仅做工件读取与派生计数（无搜索）；搜索仅发生在 6 个未覆盖的实际计划上 |
| `P5_P6_RERUN = NO` | 遵守 | 只读取既有 P5 5 轮工件和 P6/性能结果，未重新执行 |
| `SELF_PLAY = NO` | 遵守 | 未运行任何 self-play |
| `COMMIT = NO` | 遵守 | 未执行 git commit |
| `PUSH = NO` | 遵守 | 未执行 git push |
| `MERGE = NO` | 遵守 | 未执行 git merge |
| 原始 P7 / REPORT / seal 包不得覆盖 | 遵守 | 原始工件 SHA-256 前后一致，并与 `SHA256SUMS.txt` 记录一致 |

---

## 2. 执行命令与结果

```bash
cd "F:\小猫小鼠"
npx vitest run --config PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01/probe/vitest.config.mts
```

- 退出码：**0**
- Test Files：**1 passed (1)**
- Tests：**2 passed (2)**
- T1（只读重算）：65ms
- T2（独立证书 + 复用审计）：1394ms
- vitest 总耗时：**2.58s**（transform 819ms，setup 0ms，import 972ms，tests 1.46s）
- 日志：`logs/erratum_run.log`

测试自身写入范围仅限：
`PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01/{_raw,logs,*.json,*.csv}`；没有写 `src/` 或原始工件目录。

---

## 3. 工作量核算

本轮**没有**运行 24 根主搜索、P5/P6 性能矩阵或 self-play。搜索工作量仅来自 6 个实际计划的证书：

| 计划 | 证书求解数 | 证书总耗时 |
|---|---:|---:|
| G1T3/E1 UUUL | 4（H0 mouse、H1 mouse、H1 survive、H1 catForce） | 47ms |
| G5T3/E1 LLDR | 4 | 120ms |
| G2T2/E1 DLUL | 4 | 20ms |
| G2T2/H1 DDDD | 4 | 15ms |
| G2T6/H1 LUUU | 4 | 214ms |
| G1T4/H1 LLLL | 4 | 555ms |
| **合计** | 24 个 solve + 6 个独立 verifier | **971ms** |

- 所有证书 `solveTruncated=false`；cap 600000 未触及。
- CHANCE 节点按“所有正概率后继 AND”展开；其中 G1T4/H1 23 个、G2T6/H1 7 个、G5T3/E1 2 个、G2T2 各 1 个；G1T3/E1 为 0。
- H1/G1T3/RRRR 没有重新求解；身份审计全部通过后复用 P4 PROVEN 证据。
- 读取 P5 工件：5 个 `p5_round*.json`，共 240 行；只读，无重算生产路径。

---

## 4. 资源普查

### 4.1 运行前（`_raw/census_before.txt`）

```text
FreePhysical_MB=1740
UsedPct=89.2
CPU_LoadPct=12
--- ABLATION / VITEST PROCESSES ---
（空）
--- EXTERNAL BENCHMARK (must NOT kill) ---
PID=29008 WS_MB=0
PID=22028 WS_MB=0
PID=19904 WS_MB=52
--- END ---
```

### 4.2 运行后（测试进程已退出）

```text
FreePhysical_MB=440.7
Total_MB=16087.8
UsedPct=97.3
ProcessCount=440
```

- **没有 vitest / esbuild 残留进程**；本测试的 node 进程已随退出码 0 结束。
- 仍存在多个长期运行的 Node/MCP 进程，例如 PID 35588（WorkingSet 885.7MB，累计 CPU 133.8s）和
  PID 4696（62.1MB，累计 CPU 181.3s）。这些累计 CPU 远大于本轮 2.58s 的测试窗口，不是本轮测试进程；
  本轮**没有**启动、终止或杀死任何外部 benchmark / dev server / MCP 进程。
- 运行后空闲物理内存降至 440.7MB（97.3% used）。这是外部长期进程与系统缓存共同作用的观测结果；
  本轮测试本身已正常退出。由于内存余量偏低，**没有在本轮之后再启动任何重型测试**。
- 若后续需要重跑 P5/P6，应先释放外部进程内存并重新做 census；不得在 440MB 余量下并发启动重型 worker。

---

## 5. 重复基准检查

- 运行前：`--- ABLATION / VITEST PROCESSES ---` 为空，未发现已有的 ablation/vitest worker。
- 运行中：`fileParallelism:false`、`maxWorkers:1`，vitest 只创建 1 个 worker 进程。
- 运行后：无 vitest/esbuild 进程；没有第二个 benchmark 在运行。
- 本轮只执行了 1 次测试命令，没有并发或重复的 benchmark 实例。

结论：**未发现重复基准；串行约束成立。**

---

## 6. 原始工件与源码保护

### 6.1 原始工件（测试前后一致；ABLATION 工件另与 SHA256SUMS 记录匹配）

| 文件 | SHA-256 |
|---|---|
| `PPC-CAT-EVALUATOR-ABLATION-01/REPORT.md` | `579a0ccd5cdef5cbfe8208fad564d44ff21dde1d8d7f66ed2bb8d3aa8d231364` |
| `PPC-CAT-EVALUATOR-ABLATION-01/_raw/p7_decision.json` | `a0f13ec2f8cd5b61b1d634e702178fbda679680bdb882a54baed901f8731b7b1` |
| `PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json` | `9d50560f107da52107cb68be94f4ac90214f8a50aabbc948f8f3114215278775` |
| `PPC-CAT-EVALUATOR-ABLATION-01/QUANTIFIER_CERTIFICATES.json` | `2a0a807740bc1f6108958898ec0912d404b83e37224ff44110983ced7ceee4e9` |
| `PPC-CAT-EVALUATOR-ABLATION-01/PERFORMANCE_RESULTS.json` | `16e8f1d62d43f880b493aea0929c98c3d8d1e1e31aac393e2e63334204a2dd7e` |
| `PPC-CAT-EVALUATOR-ABLATION-01/SEAL_VERIFICATION.json` | `5c39d22d51bbbf87c45f1c70c2b9709f24823bda702ae6a3ea38fac7dd81e6d7` |
| `PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts` | `453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b` |
| `src/game/ai/__tests__/fixtures/ppcId01-human-roots.json` | `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09` |

- `SOURCE_AND_ARTIFACT_IDENTITY.json`:
  - `originalsUnchanged=true`
  - `sourcesUnchanged=true`
  - `allPriorSumsMatch=true`
  - `sourcesPredateErratumStart=true`
  - `productionSourceChanged=false`
  - `priorArtifactsOverwritten=false`
- seal archive `F:/ppc-checkpoints/PPC-CAT-EVALUATOR-ABLATION-01-candidate.tar.gz`：
  SHA-256 `d174a6a84c35fcf095179ccb4b05cd40cf530c09a50aaf669299d7d1e05ce4a4`，与封口记录一致。
- 15 个生产源文件测试前后 SHA-256、字节数、mtime 完全一致；本轮没有写 `src/`。

### 6.2 工作树披露

`SOURCE_AND_ARTIFACT_IDENTITY.json` 的 `git status --porcelain=v1 -- src` 显示 15 个已修改文件和
14 个未跟踪文件。这些是**本轮之前已存在**的未提交生产补丁（与 PPC-CAT-EVALUATOR-ABLATION-01 同一底材），
不是本轮产生的修改；本轮既没有新增也没有回滚它们。`headLive` 仍为
`48eaac6c4f3801d351787696ba5876995b64e8d8`。

---

## 7. 本轮新增文件

全部位于 `PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01/`：

- `ERRATUM.md`
- `ERRATUM_RESULTS.json`
- `CORRECTED_ROOT_TABLE.csv`
- `G1T3_E1_100MS_CERTIFICATE.json`
- `SOURCE_AND_ARTIFACT_IDENTITY.json`
- `RESOURCE_SAFETY_LOG.md`（本文件）
- `ADDITIONAL_100MS_PLAN_CERTIFICATES.json`
- `_raw/erratum_metrics.json`
- `_raw/identity_before.json`
- `_raw/run_timing.json`
- `logs/erratum_run.log`
- `probe/vitest.config.mts`
- `probe/erratum_lib.ts`
- `probe/erratum.test.ts`

新增工件的 SHA-256 见 `ERRATUM.md` §7.2。

---

## 8. 结论

- 本轮以**单 worker、串行、单次调用**完成；退出码 0，2/2 tests passed。
- 没有完整 24 根搜索重跑、P5/P6 重跑或 self-play；搜索仅限 6 个实际计划证书（合计 971ms）。
- 没有修改生产源码、规则、搜索数学、H1 或预算；原始 P7/REPORT/seal 包与 fixture 均未被覆盖。
- 运行后无 vitest/esbuild 残留；外部长期 Node 进程未被终止。
- 运行后空闲内存仅 440.7MB（97.3% used）；为安全起见，本轮不再启动重型任务，后续性能重跑需先恢复内存余量。
- 最终判定：`PROVEN_100MS_TACTICAL_GAIN = FALSE`。停止，提交 ChatGPT 进行最终架构裁决。
