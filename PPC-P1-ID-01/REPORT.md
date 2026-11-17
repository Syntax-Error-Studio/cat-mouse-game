# PPC-P1-ID-01 · 搜索状态身份编码修复（地形编码碰撞）

- 仓库：`F:\小猫小鼠`（`Syntax-Error-Studio/cat-mouse-game`）
- 分支：`ppc/p1-id-state-identity-fix`（自 `ppc/perfect-cat-research-baseline-20261112` 创建）
- 基线 HEAD / 源码 SHA：`48eaac6c4f3801d351787696ba5876995b64e8d8`
- 生产源码改动：**仅** `src/game/ai/transposition.ts`
- 结论：`IMPLEMENTED_WITH_BLOCKED_GATES`（唯一阻塞项 = `ABSOLUTE_DEADLINE_GATE`，缺权威门槛清单）
- 未 commit / 未 push / 未 merge / 未 rebase

---

## 1. 人话总结

- **原来的错误是什么**：`stateKey()` 用 `cell.type[0]` 编码地形，`box` 与 `butter_spot` 都变成 `b`，`trap` 与 `tunnel` 都变成 `t`。于是两个真实棋盘不同、后续合法动作也不同、叶评价也不同的局面会得到同一个 key；共用 `evalCache` / TT / `planBranches` 时，后访问者会直接取到前一个局面的数值。
- **改了什么**：把地形字符换成 9 个互不相同的固定码（`e b r t m u p w v`），用**穷尽 `switch`** 实现。新增地形会编译失败（`const unknownTerrain: never = type`），运行期遇到非法地形直接抛错，并且因为完全不查对象属性，`toString` / `constructor` / `__proto__` 这类继承名不可能被当成地形码。
- **真实反例是否关闭**：关闭。Pro 的正式反例（合法显式地图 → 正式开局 → 鼠 `LRUD` → 猫 `DR` / `RD`）现在 `stateKey(A) ≠ stateKey(B)`，A/B 各自拿到自己的真实叶评价（baseline `-263.4761904761904` / `-316.80952380952374`），与顺序无关。
- **默认地图猫 AI 是否保持原样**：是。24 个真人根的 key 与修复前**逐字节相同**，固定 D1 全字段输出（value / mate / bestAction / catTurnPlan / 全部诊断 / TT 规模）与修复前基线工件逐字段相等。
- **有无明显性能退化**：最终实现没有。固定工作量 20 组配对：几何均值比 `0.9947`，95% CI `[0.9708, 1.0192]`，上端 1.019 ≤ 1.05；单函数微基准中 `stateKey` 与原实现持平（≈3.3–3.6 µs/call）。**需要说明**：第一版实现（普通对象 + `hasOwnProperty` 守卫）在同一协议下测得 `+5.3%`（CI 上端 1.073），未通过 1.05 门，因此换成规格同样允许的穷尽 `switch`；两版数据都保留在 `perf/`。
- **有没有影响游戏规则**：没有。移动、推箱、传送、捕鼠夹、黄油/幽灵、RULE-A/RULE-B、H1 评价、搜索数学、100ms/150ms 参数全部未改。

---

## 2. 正确性结果

| Gate | 结果 | 证据 |
|---|---|---|
| ID-0 来源 | **PASS** | `git rev-parse HEAD` = `48eaac6…`；`git show HEAD:src/game/ai/transposition.ts` 的 sha256 = `2eea65ff6e6402313efe58fab65eaf81dd352a40b7254596e4a96a32e9fdf60c`，与 Pro `KEY_COPY_MANIFEST_V2.json` 的 `baseline_transposition_sha256` 完全一致；候选 sha256 = `7b4aa8eb3fab994a4abc77fdf38800ab2a5f9da57d5eb33a1b37075e106c2d64`；`git diff` 只含一个文件 |
| ID-1 枚举 | **PASS** | 9 个地形码互异且等于规格表；9×3×2 = **54** 个 schema 向量两两不同（明确标注为 schema 覆盖，不是 54 个可达局面）；`toString` / `constructor` / `__proto__` / `unknown-terrain` 四种输入全部抛 `Unknown terrain in state identity` |
| ID-2 可达反例 | **PASS** | 通过 `validateGameConfig` → `createGameState`（`status.kind = explicit`）→ `mouseMove` × 4 → `catMove` × 2 得到同一根的两个后继；语义比较 `gameAffectingEqual = false`，箱位不同；合法动作集 A 无 `R`、B 有 `R`（规则层真实输出）；`stateKey(A) ≠ stateKey(B)`，且 key 长度与旧码相同 |
| ID-3 缓存因果 | **PASS** | `evaluateForCat` 与 `evaluateCorrectedHoleForCat` × 顺序 `A→B` / `B→A`，4 种组合的 `searchResult(...,0,ctx)` 值全部等于**无缓存**独立评价；每次同 context 内产生 2 条 cache 记录（修复前 4/4 组合串值）；同一局面的克隆仍只占 1 条 |
| ID-4 缓存消费者 | **PASS**（范围受限） | 静态审计：`stateKey()` 是唯一入口，`evalCache` / TT / path repetition / `planBranches` / `equalPrimaryGraph` 都由它派生，生产代码中已无第二处地形编码；动态：同一 context 先 A 后 B，各自结果与独立 fresh 搜索逐字段相等，TT 中两条独立 entry 并存，`planBranches` 分别以自己的根为键；人工写入 `depthTurns=7` 的 entry 不被 1 层搜索复用（`ttDepthMismatches>0`、`ttExactHits=0`）。**不宣称**这是完整 TT 搜索正确性证明 |
| ID-5 默认地图 parity | **PASS** | 24 个真人根（fixture sha256 `1a59787a…`，与预注册一致）：新旧 key 逐字节相等（24/24）；固定 D1（depth 1 / maxNodes 10000 / 无 deadline / 显式 `evaluateCorrectedHoleForCat` / TT+αβ+ordering / `maxThreatExtensions=0` / `capturePlan`）输出与**修复前现场捕获的基线工件** `fixtures/ppcId01-baseline-d1.json` 逐字段相等（value、mate、action、catTurnPlan、全部 diagnostics、ttSize） |
| ID-6 既有回归 | **PASS** | 13 个文件 270 个用例：269 通过、1 失败。失败项 `expectiminimax > T1E-B A/B/K` 为 **30s 超时**，在基线源码下同文件跑同样失败（`logs/baseline_full_expectiminimax.log`），属预存环境/耗时问题，非本轮引入；另 `forcedLossTieBreakHv14Reachability > FLT-HV14-4` 在基线同样失败（`logs/baseline_flt_hv14.log`，同一断言 `expected 999996 to be -1052.947…`），为预存失败，本轮未纳入串行集合并单独记录 |
| ID-7 语义字段 | **PASS** | 单字段变更各自改变 key：phase、actor、`catMovesLeft`、`mouseMovesLeft`、carry、skill、pending 坐标、pending blocked 次数（0 vs 1 vs 2）、debt、trap、库存、`blockedTunnels`、`tunnelExitChoices`、config 签名、board 地形，共 16 项 |
| ID-8 非语义字段 | **PASS** | `message`、`catActionLog`、`gameEventLog`、`lastHardSearch` 不改变 key；`butterPositions` / `pendingButterSpawns` / `blockedTunnels` / `tunnelExitChoices` 合法重排不改变 key，且检测过程未改动原数组 |
| ID-9 输入隔离 | **PASS** | `stateKey` 冷/暖调用结果一致且不改输入；完整 D1 搜索前后根状态 JSON 完全相同；两个 context 的 `evalCache` / `tt` / `planBranches` 互不共享 |
| ID-10 工程构建 | **PASS** | `npx tsc -b` → exit 0；`npm run build`（`tsc -b && vite build`）→ exit 0，`✓ built in 5.42s`（`logs/build_final.log`）。本轮未出现 safe-delete 拦截 |

### 测试现场（修复前 vs 修复后）

新增测试文件 `src/game/ai/__tests__/stateIdentityCollision.test.ts`，35 个用例：

| 时点 | 结果 |
|---|---|
| 修复前（基线 `transposition.ts`，sha `2eea65ff…`） | **7 失败 / 28 通过**。失败项精确对应已知碰撞：地形码唯一性、54 向量互异、非法地形拒绝、两后继 key 不同、两种叶评价下的缓存串值（2 项）、TT entry 被复用（`nodes=0`、`ttExactHits=1`） |
| 修复后（候选 `7b4aa8eb…`） | **35 / 35 通过** |

日志：`logs/pre_fix_test_run_final.log`、`logs/post_fix_test_run_final.log`。

---

## 3. 实际改动

```text
branch            : ppc/p1-id-state-identity-fix   (base: ppc/perfect-cat-research-baseline-20261112)
HEAD              : 48eaac6c4f3801d351787696ba5876995b64e8d8   (未新增 commit)
baseline source   : src/game/ai/transposition.ts sha256 2eea65ff6e6402313efe58fab65eaf81dd352a40b7254596e4a96a32e9fdf60c
candidate source  : src/game/ai/transposition.ts sha256 7b4aa8eb3fab994a4abc77fdf38800ab2a5f9da57d5eb33a1b37075e106c2d64
git diff --stat   : src/game/ai/transposition.ts | 44 +++++++++++++++++++++++++++++++++++++++++++-
                    1 file changed, 43 insertions(+), 1 deletion(-)
```

**修改文件（tracked，1 个）**

- `src/game/ai/transposition.ts`：新增 `terrainKeyCode(type: CellType): string` 穷尽 `switch`；`boardKey()` 内 `cell.type[0]` → `terrainKeyCode(cell.type)`。单元结构仍是 `terrain + piece + butter` 三字符，`stateKey()` 的全部字段、顺序、config 签名一字未改。

**新增文件（untracked，未提交）**

- `src/game/ai/__tests__/stateIdentityCollision.test.ts`（ID-1/2/3/4/5/7/8/9 用例，含修复前编码的 legacy 参考实现，仅用于 parity 比较）
- `src/game/ai/__tests__/fixtures/ppcId01-human-roots.json`（24 真人根，sha256 `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09`，与预注册 `root_fixture_sha256` 一致）
- `src/game/ai/__tests__/fixtures/ppcId01-baseline-d1.json`（**修复前**现场捕获的 24 根固定 D1 结果工件）
- `PPC-P1-ID-01/`（报告、日志、性能协议与原始工件）

**未触碰**：`纸制版作业-…第二次.doc`（仍为未跟踪，未改动）、`GAMEPLAY.md`、`searchConfig.ts`、任何规则/评价/搜索数学文件。

---

## 4. 性能结果

协议：`PREREGISTRATION_DRAFT.json` 的 `fixed_work` + `timing`；每阶段 20 个**串行 fresh 进程**，每进程每臂 2 次 warmup，24 根顺序按 `rep mod 24` 左旋，逐根 AB/BA 交替；统计单位 = 每 repetition 的 24 根总耗时；估计量 = 配对 log 比的几何均值，df=19，t=2.093024054408263；无离群剔除、无提前停止、无强制 GC。`HEAVY_WORKER_CONCURRENCY=1`、`SERIAL_FRESH_REPETITIONS=TRUE`，全程无并行 heavy job。

| 会话 | 实现 | A/A 校准 | A/B 结果 |
|---|---|---|---|
| S1 | 普通对象 + `hasOwnProperty` 守卫（sha `55eb1dc6…`） | geo `0.9883`，CI `[0.9482, 1.0302]`，半宽 `0.0415` ≤ ln1.05 → **有效** | geo **`1.0532`**，CI `[1.0339, 1.0729]`，上端 **1.073 > 1.05 → 未通过** |
| S2 | 穷尽 `switch`（最终实现，sha `7b4aa8eb…`） | geo `0.9890`，CI `[0.9676, 1.0109]`，半宽 `0.0219` → **有效** | geo **`0.9947`**，CI `[0.9708, 1.0192]`，上端 **1.019 ≤ 1.05 → 通过** |

- 输出一致性：S1/S2 各 20 reps × 24 根 × 2 臂，value/mate/action/completed 签名**零不一致**（数学 parity 成立，性能差异不代表招式或数值变化）。
- 成本归因（`logs/micro_statekey.log`，24 万次调用，6 轮轮转）：基线 `3.25–3.62 µs/call`；`hasOwnProperty` 版 `4.76–5.04 µs/call`（≈+45%）；`switch` 版 `3.33–3.57 µs/call`（与基线持平）。修复前 `stateKey` 未做任何缓存，故 `+45%/call` 直接放大到整轮 `+5.3%`。
- 关于两版实现：S2 与 S1 的**协议、根集、重复次数、统计方法、门槛全部未变**，唯一差别是地形映射写法，而“穷尽 `switch`”与“无原型对象”本来就是任务书与规格 §3 明确允许的等价安全实现。两版原始工件均保留，未删除 S1 的失败结果。
- 观察到的环境非平稳：S2 的第 10–13 次 repetition 总耗时降到 ~270–320 ms（其余 ~700–860 ms），属机器负载变化；配对设计使比值仍可用，但这一点如实记录。

工件：`perf/results_aa.jsonl`、`perf/results_ab.jsonl`、`perf/results_aa_v2.jsonl`、`perf/results_ab_v2.jsonl`、`perf/STATS.json`、`perf/{measure,adapt,aa.test,ab.test,micro.test}.ts`、`perf/prepare_arms.sh`（重建隔离臂；臂本身为临时目录，已删除）。

**`ABSOLUTE_DEADLINE_GATE = BLOCKED`**：没有正式的绝对 deadline 权威门槛清单（`must_freeze_before_execution` 中的 “original absolute deadline gate manifest” 缺失），本轮不虚构宽限。`MAIN_SEARCH_SEMANTIC_BUDGET_MS = 100`、`TOTAL_TURN_HARD_WALL_MS = 150` 均未改动；也因为 fallback 重复领取预算的问题仍未修复，本轮**不宣称** 150 ms 整回合合同已合规。

---

## 5. 下一阶段状态

```text
PPC_P1_ID_STATUS = IMPLEMENTED_WITH_BLOCKED_GATES

SOURCE_BASELINE = 48eaac6c4f3801d351787696ba5876995b64e8d8

TERRAIN_ENCODING_INJECTIVE = PASS
UNKNOWN_TERRAIN_FAIL_CLOSED = PASS
REAL_REACHABLE_COLLISION_FIXED = PASS
EVAL_CACHE_CROSS_STATE_POLLUTION_FIXED = PASS
DEFAULT_STATEKEY_PARITY = PASS
DEFAULT_D1_SEARCH_PARITY = PASS
TT_CONSUMER_SCOPE = PASS_WITH_DECLARED_SCOPE (人工/小型 TT 隔离验证，非完整 TT 搜索证明)
INPUT_IMMUTABILITY = PASS
EXISTING_REGRESSION_TESTS = PASS (269/270；1 项为基线可复现的预存超时)
TYPESCRIPT_BUILD = PASS
VITE_BUILD = PASS
AA_TIMING_GATE = PASS (S2: CI95 [0.9676, 1.0109], 半宽 0.0219)
AB_TIMING_GATE = PASS (S2: CI95 [0.9708, 1.0192], 上端 1.019 <= 1.05；S1 为 FAIL，已保留)
ABSOLUTE_DEADLINE_GATE = BLOCKED (缺权威门槛清单，未执行)

PRODUCTION_SOURCE_CHANGE = 1 file / +43 -1 (src/game/ai/transposition.ts)
GAMEPLAY_CHANGE = NO
H1_CHANGE = NO
SIDECAR_CHANGE = NO
SEARCH_MATH_CHANGE = NO
BUDGET_CHANGE = NO
MOUSE_AI_CHANGE = NO

HEAVY_WORKER_CONCURRENCY = 1
SERIAL_FRESH_REPETITIONS = TRUE

COMMIT = NO
PUSH = NO

RECOMMENDED_VERDICT = IMPLEMENTED_WITH_BLOCKED_GATES
```

## 6. 只登记、未修复（下一轮由 ChatGPT 单独设计）

1. fallback 重新领取预算（`ABSOLUTE_DEADLINE_GATE` 因此不可认证）。
2. `catTurnPlan` 计划长度截断 / `maxLength=8`。
3. 反向评分漏边（计划层评价）。
4. `gameAffectingEqual` 不比较完整 config、部分列表按集合处理 —— 已登记的范围限制，本补丁未扩大其承诺。
5. 预存测试失败：`expectiminimax > T1E-B A/B/K`（30s 超时，基线同样超时）、`forcedLossTieBreakHv14Reachability > FLT-HV14-4`（基线同样失败）。
