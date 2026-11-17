# PPC-P1-ID-01 来源清单补档说明

**Round:** PPC-P1-CLOSURE-FIX-01
**Target:** `PPC-P1-ID-01/SOURCE_MANIFEST.json`
**Status:** `RECONSTRUCTED_PROVENANCE_MANIFEST = TRUE`

---

## 1. 为什么需要补档

四轮生产候选（P1-ID / P1-TIME-01 / P1-PLAN-01 / P1-QUALITY-01）中，**只有第一轮 PPC-P1-ID-01 没有留下 `SOURCE_MANIFEST.json`**。上一轮（PPC-P1-CLOSURE-01）的来源审计只能靠该轮 `REPORT.md` 的散文与 P1-TIME-01 里携带的 `p1IdCandidate` 块互证，缺少一份结构化清单。

本轮把它补齐，并**显式标注为事后重建**——它不是第一轮运行时生成的文件，任何情况下都不得当作"当时就有的证据"引用。

## 2. 重建依据（四类材料，互相独立）

| 来源 | 用途 |
|---|---|
| `PPC-P1-ID-01/REPORT.md` | §2 ID-0 门写明 HEAD blob `2eea65ff…` 与候选 `7b4aa8eb…`；§3 给出 `git diff --stat`（1 file / +43 −1）与三个新增文件路径 |
| `PPC-P1-ID-01/logs/` 13 份日志 | 修复前/后测试现场、性能微基准、构建日志的可执行证据 |
| `PPC-P1-ID-01/perf/` 8 份工件 | 性能协议与原始 `jsonl` 结果（含被否决的 S1 实现数据） |
| `PPC-P1-TIME-01/SOURCE_MANIFEST.json` → `p1IdCandidate` | 第二轮把第一轮候选 SHA 原样携带下来的独立副本 |
| `git show HEAD:<path>` | 基线 blob 的**权威**字节 |

## 3. 指纹不是从散文抄的

清单里**每一个 sha256 都是重新算出来的**：

- 磁盘文件：以二进制方式读取原始字节（1 MiB 分块）后哈希；
- HEAD 基线：对 `git show HEAD:<path>` 的 **stdout 原始字节**哈希；
- 不做换行归一化、不 checkout、不改文件、不使用编辑器缓存。

## 4. 交叉核验结果

| 检查 | 结果 |
|---|---|
| `transposition.ts` 候选 SHA 前缀 = 报告声明的 `7b4aa8eb` | **true** |
| `transposition.ts` HEAD 基线 SHA 前缀 = 报告声明的 `2eea65ff` | **true** |
| `ppcId01-human-roots.json` SHA 前缀 = 预注册的 `1a59787a` | **true** |
| `stateIdentityCollision.test.ts` 在 HEAD 存在 | **false（ABSENT）** —— 与"第一轮新增文件"一致 |
| 两份 fixture 在 HEAD 存在 | **false（ABSENT）** —— 同上 |

完整 SHA-256（64 位）：

```text
src/game/ai/transposition.ts
  HEAD 基线  2eea65ff6e6402313efe58fab65eaf81dd352a40b7254596e4a96a32e9fdf60c
  候选       7b4aa8eb3fab994a4abc77fdf38800ab2a5f9da57d5eb33a1b37075e106c2d64

src/game/ai/__tests__/stateIdentityCollision.test.ts
  候选       4be1cf487e4af828…（26,215 bytes，HEAD 不存在）

src/game/ai/__tests__/fixtures/ppcId01-human-roots.json
  候选       1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09（264,328 bytes）

src/game/ai/__tests__/fixtures/ppcId01-baseline-d1.json
  候选       80635906377dbe1e…（42,327 bytes）
```

## 5. 补档后四轮交叉校验

补档前，四轮里第一轮的来源只能靠散文。补档后重新执行全部 manifest 交叉校验（`PPC-P1-CLOSURE-FIX-01/_raw/manifest_crosscheck.json`）：

```text
被声明的生产/测试/工件路径总数   31
直接命中当前磁盘               26
本轮（CLOSURE-FIX-01）再次修改   5
未解释分歧                      0
```

5 处非命中的完整清单，每一处都由**本轮自己的改动**解释（见 `SOURCE_MANIFEST.json` 的 `explainedDivergences`）：

| 路径 | 旧声明 | 当前 | 归因 |
|---|---|---|---|
| `src/game/ai/expectiminimax.ts` | `42b6e71f`（P1-PLAN-01）| `8ac26985` | 本轮加 `buildCatTurnPlan` 失败关闭门 |
| `src/game/ai/planBound.ts` | `99c269f9`（P1-PLAN-01）| `f1427ae1` | 本轮加输入域判定，去掉 floor 猜测 |
| `src/game/ai/planQuality.ts` | `f97dd204`（P1-QUALITY-01）| `d8ecdd26` | 本轮加 4 处失败关闭门 |
| `src/game/engine.ts` | `dbb5377a`（P1-TIME-01）| `5a51e837` | 本轮加 `createInitialState` 前置断言 |
| `src/game/ai/__tests__/planActionBoundFixtures.ts` | `1da29be5`（P1-PLAN-01）| `9e6357cd` | 本轮让 `catTurnRoot` 真正吃 `opts.catBaseMoves` |

⇒ `UNEXPLAINED_DIVERGENCE = 0`。

## 6. 一处必须说明的细节

`planActionBoundFixtures.ts` 的修改不是"为了测试方便"，而是**修掉一个夹具与合同不一致的地方**：`catTurnRoot` 一直把 `catBaseMoves` 固定为 4，即使调用方传入别的值，所以 `M=9` 的用例实际构造的是 `catMovesLeft=4` 的根。修好之后 `M=9 ⇒ 14` 的用例才真的在测 9。P1-PLAN-01 的 19 项断言在新的夹具下全部依旧通过（本轮日志 `02_plan_bound.log`），说明旧断言不是靠这个错位才成立的。
