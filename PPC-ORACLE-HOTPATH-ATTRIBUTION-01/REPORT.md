# REPORT — PPC-ORACLE-HOTPATH-ATTRIBUTION-01

两鼠回合（`mouseForce` + `catSurvive`）证明的实际耗时归因，以及“局部合法动作 / 后继缓存”是否值得实施。

- 轮次目录：`PPC-ORACLE-HOTPATH-ATTRIBUTION-01/`
- 冻结文件未改动：`PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts`、`src/**`、`GAMEPLAY.md`、H0/H1、E1、PCV、`stateKey`、100/150 ms 时限
- 所有代码是 `probe/` 下的研究副本；`COMMIT=NO PUSH=NO MERGE=NO PRODUCTION_WIRING=NO`
- 终裁：**PASS**，结论 **B `CACHE_NO_GO_LOW_REUSE`**

---

## 1. 证明时间到底花在哪

冻结内核 `solve()`（`seal_lib.ts:94-156`）每个结点的顺序已静态核验并在运行时确认：

`settle` → `terminal` → `player` → horizon 截断 → `key = idx|stateKey` → **`memo.get`（在 `transitions` 之前，:112 vs :118）** → `nodes++`/cap → **动作生成** → 逐转移子结点探测（`player(settle(...))`）→ 确定性转移直接递归 / 其余按 CHANCE 做 AND → `memo.set` → OR 侧 `policy.set`。

所以每个“memo miss 的新展开”都要付一次完整的“枚举候选 + 逐候选模拟 + 合法性比较”。计时副本与冻结副本在 DUUD 上**全部计数器逐项相等**（nodes 65,585；transitions 193,117；chanceNodes 2,122；chanceOutcomes 53,766；memoHits 58,328；cutoffs 10,196；策略摘要 `85eee90f…` 一致；证书 `PROVEN`，110,921 leaves，0 misses），因此分解只改变计量、不改变搜索。

**DUUD（mouseForce）self-time 分解**（`NODE_COST_BREAKDOWN.json`；计时副本 6,656.8 ms vs 冻结 2,031.5 ms，开销比 3.28× —— 只看比例，不看绝对毫秒）：

| 段落 | 毫秒（计时副本） | 占比 |
|---|---|---|
| 动作生成（枚举+模拟+比较+映射） | 3,684.5 | **55.9%** |
| `stateKey` 串构造（123,913 次，47.3M 字符） | 1,722.3 | **26.1%** |
| `memo.get`（123,913 次） | 342.4 | 5.2% |
| `settle`（392,062 次） | 233.7 | 3.5% |
| `memo.set` | 64.8 | 1.0% |
| `player`（391,052 次） | 56.2 | 0.9% |
| `terminal` / `policy.set` | 33.4 / 12.4 | 0.5% / 0.2% |
| 未归因 | — | 6.8% |

**对照 microbench（在 131 个采样展开结点上、求解之外测得，无计时器开销）**：生成 3,854.6 ms、`stateKey` 1,716.1 ms、`settle` 288.6、`terminal` 38.7、`player` 67.4，其中生成内部的 `gameAffectingEqual` 约 838.7 ms —— 与计时副本的比例互相印证（生成 ≈56%，key ≈25%）。

**生成内部再拆一层**（LLLD，`profGen` 计时重实现 + 前 400 个结点与真实生成器逐项校验 400/400 一致，`g1_llld_profile.json`）：候选枚举 19.4 ms（1.2%）、**逐候选引擎模拟 1,169.1 ms（70.2%）**、`gameAffectingEqual` 443.5 ms（26.6%）、映射打标签 34.2 ms（2.1%）；96,663 个候选模拟出 83,328 个合法动作，每次模拟约 12 µs。也就是说，真正的“贵”是**对每个候选跑一次完整引擎模拟**（其中含 `forceEndTurnIfNeeded` 触发的 CAT→MOUSE CHANCE 后继生成），而不是枚举。

**CHANCE**：DUUD 有 2,122 个 CHANCE 转移 → 53,766 个结果（每个结果都要一次子 `walk`）。CHANCE 把树“变宽”，是后继被反复走到的原因；但它本身不产生动作生成。

**GC**：基线全程 heapUsed 54 → 149 MB，观察器报 0 次 GC。但同一观察器在加缓存的运行里也报 0（尽管堆涨到 1.2 GB），所以 **GC 计数不能当证据**；能说的是基线没有 GB 级保活、分配规模与本轮结论无关。

回答：**证明时间 = 动作生成（约 56%，其中约 70% 是逐候选引擎模拟） + `stateKey` 构造（约 26%） + 哈希表操作与 settle（约 9%）**。`elapsedMs/nodes` 这种指标把这三个完全不同的成本混在一起，不能当作证据；本次是分段计量得出的。

## 2. memo 已经省了多少，缓存还能省多少

`memo.get` 在 `transitions` 之前，所以 memo 命中已经完全跳过了动作生成。实测（DUUD）：65,585 次展开 / 65,585 次 `nodes++`，而 memo 命中 **58,328** 次、动作生成调用 **65,585** 次（`genCalls === expansions` 已核对）。换言之，本次搜索里“同一状态被再次走到”的比例约 47%（58,328 / 123,913 次 key 查询），**这部分已经由 memo 吃掉了**。

那么“在 memo miss 之后再加一层动作缓存”的上限是多少？分母取“真正需要动作生成的展开数”，键只允许用 `stateKey`（一次 solve 的生命周期，不跨根/计划/回合/规则）：

| 目标 | expansions | 同键重复（不同 idx） | 同键重复（同 idx） | 潜在命中率 |
|---|---|---|---|---|
| DUUD/mouseForce | 65,585 | 134 | 0 | **0.20%** |
| DUUD/catSurvive | 23,041 | 1 | 0 | 0.004% |
| UURR/mouseForce | 78,839 | 205 | 0 | **0.26%** |
| UURR/catSurvive | 48,142 | 101 | 0 | 0.21% |
| DRRR/mouseForce | 3,513 | 2 | 0 | 0.06% |
| DRRR/catSurvive | 92,963 | 134 | 0 | **0.14%** |
| LLLD/mouseForce | 24,075 | 0 | 0 | 0% |
| LLLD/catSurvive | 4,822 | 0 | 0 | 0% |

（`CACHE_HIT_UPPER_BOUND.json`；同 idx 重复恒为 0，意味着重复总是出现在“同一状态、不同剩余深度”的路径汇合处。）

跨根/跨计划交集很大（DUUD∩UURR=19,361 个键），但简报明确禁止把它当作缓存基础，因此只作离线统计记录，不进入任何原型。

**结论**：memo 已经把“重复状态”这条路基本走完；剩下可省的动作生成最多是 0–0.26% 的展开。即使按最乐观的算法（一次命中省下一整次生成 58.8 µs，缓存键直接复用 memo 已算好的 `stateKey`、查询成本≈0）：134 × 58.8 µs ≈ 7.9 ms，也只占 DUUD 2.03 s 的 **0.39%**；若命中时还要重建一次 key（13.8 µs），收益降到 ≈0.30%。这是“收益上限”，不是预测。

## 3. 缓存是真的更快，还是只是更占内存

三组独立新进程的 ABBA 配对实测（A=无缓存，B=同内核+单次 solve 缓存，cap 20,000，guard-memory 状态绕过；A/B/B/A 顺序相减抵消线性漂移）：

| 目标 | rep1 比值 | rep2 比值 | rep3 比值 | 中位 | 缓存命中（rep1） |
|---|---|---|---|---|---|
| DUUD/mouseForce | 1.396 | 1.468 | 1.272 | **1.396** | 59 / 65,585 |
| UURR/mouseForce | 1.359 | 1.003 | 1.307 | **1.307** | 111 / 78,839 |
| DRRR/mouseForce | 1.226 | 1.008 | 1.157 | **1.157** | 2 / 3,513 |
| LLLD/mouseForce | 1.242 | 1.268 | 1.201 | **1.242** | 0 / 24,075 |

比值 >1 表示“加缓存后更慢”。12 个“计划×rep”格子全部 ≥1.0，没有一个格子快于基线；命中数与第 2 节的重复率一致（59 + 111 + 2 + 0，均低于理论上限）。

**慢在哪，已单独量化**：Map 本身的记账（20k 条 1.2 KB 键的 get/set/淘汰 × 65,585 次）只要 **3.1 ms**（`logs/cache_wiring_microbench.json`），所以慢不是哈希开销，而是**保活**：缓存持有 20,000 份 `Transition[]`，等于把整棵后继状态图钉在堆上（`logs/g4_gc_retention.json`，DUUD 同根同进程）：

| | 无缓存 | 加缓存 |
|---|---|---|
| 墙钟 | 2,839.2 ms | 8,056.1 ms |
| heapUsed（结束后） | 149 MB | **1,234 MB** |
| RSS（结束后） | 286 MB | 1,397 MB |
| GC 事件（观察器） | 0 | 0（未上报，见下） |

GC 观察器两次都报 0（Node 24 未把这些增量标记事件报成 `gc` entry），因此**不把 GC 次数当证据**，只把它当方向：加缓存后堆从 149 MB 涨到 1.2 GB，而墙钟在 ABBA 配对里 12 个格子中 10 个慢 15–47%、2 个在噪声内（1.003 / 1.008）、没有一个快于基线。这是“缓存动作表”这种做法的固有代价，换实现方式（LRU、序列化、只存 label 再重算）也不能把 0.2% 的收益翻正。

配对设计的解释：Windows 上进程间耗时方差约 3×，所以比值取 `(B1+B2)/(A1+A2)`；每个 rep 都是全新进程，三次 rep 的 PID 均记录在 `PAIRED_PERFORMANCE_RESULTS.json`（2136 / 6344 / 37520）。

正确性方面（`BASELINE_VS_PROTOTYPE_PARITY.json`，三次 rep × 5 个目标）：布尔值、nodes、transitions、chanceNodes、chanceOutcomes、memoHits、cutoffs、truncated、maxIdx、策略摘要**逐项相等**（`allCountersIdentical=true`、三次 rep 策略摘要一致）；mouseForce 真值目标 4 个证书 `PROVEN`、catSurvive 真值目标 1 个证书 `PROVEN`（`allCertificatesProven=true`），反例均为 null。

内存方面：缓存不是“用几 GB 换几毫秒”，而是**换不到毫秒、还要付一 GB 级的堆**——它保活的正是后继状态图，而命中只有 0.2%。

## 4. 这一步对“真实猫 AI 强度”意味着什么

不改变在线猫 AI 的任何一行代码（`PRODUCTION_WIRING=NO`）。这次测量的价值是**排除了一个方向**并**指出下一步该量化什么**：

1. **动作缓存方向可以关掉**：重复率 0.26% 以下、同 idx 重复为 0，说明搜索是“每层新状态占绝对多数”的展开，不是“同一状态反复展开”的结构。在 memo 之后再加缓存，只会增加保活（后继状态图）与记账成本，不会减少任何实质工作。
2. **真正值得做的是降低单次展开成本**：约 56% 的时间在动作生成，其中 70% 是“每个候选都完整模拟一次引擎”（`simulateSearchAction`），26% 是比较 `gameAffectingEqual`；另外 26% 在 `stateKey` 串构造（每结点 1 次、DUUD 共 12.4 万次、4,730 万字符）。还有一个更直接的重复：内核里每个子状态被 `settle` 至少两次 —— 一次是父结点里 `player(settle(outcome0.state))` 探测轮到谁，一次是子 `walk` 入口的 `settle(state)`；DUUD 共 392,062 次 settle、只对应 123,913 个结点（约 3.2×）。
3. **离线证明规模**：即使把生成成本砍半，DUUD 也要 ~1.0 s 级别；100/150 ms 在线时限完全靠的是剪枝与启发式，不是这类微优化。因此本轮结论只用于离线 oracle 的吞吐，不能外推为在线强度。

## 5. 结论

**终裁 B `CACHE_NO_GO_LOW_REUSE`**：局部合法动作/后继缓存**不值得实施**。三重证据同向：潜在命中 ≤0.26%（同 idx 重复为 0）、理论收益上限 ≈0.3–0.4% 墙钟、实测 12 个配对格子无一快于基线且保活 1.1 GB 堆。建议的替代优化方向：

- **P1**：`simulateSearchAction` 的候选级模拟复用（同一父状态下的候选共享 `endTurn`/CHANCE 展开），或惰性合法性判断（先廉价预筛再模拟）；
- **P2**：`stateKey` 构造降本（避免同时构造 boardKey/positions/… 的字符串拼接，或改为增量/结构化哈希——但不得改变 `stateKey` 语义，需另立轮次验证等价性）；
- **P3**：把 `player(settle(outcome0.state))` 的 settle 与父结点 settle 合并（同一 state 被 settle 两次，DUUD 共 392,062 次 settle 调用）。

## 6. 证据与复现

- 精度核验：`logs/g1_duud.json`（冻结 vs 计时副本逐计数器相等 + microbench + `gc` 0 次）
- 分解：`NODE_COST_BREAKDOWN.json`、`SOLVE_HOTPATH_CALLGRAPH.md`
- 缓存上限：`CACHE_HIT_UPPER_BOUND.json`
- 键等价性（G3）：`logs/g3_key_equivalence.json`（475 次重复展开，签名比对 0 不一致）、`logs/g3_chance_witness.json`（CHANCE 见证：shadow 比对通过）
- 安全契约：`CACHE_KEY_SAFETY_CONTRACT.md`
- 一致性与性能：`BASELINE_VS_PROTOTYPE_PARITY.json`、`PAIRED_PERFORMANCE_RESULTS.json`
- 缓存开销归因：`logs/cache_wiring_microbench.json`（Map 记账 3.1 ms）、`logs/g4_gc_retention.json`（heap 149→1,234 MB）
- 资源：`RESOURCE_SAFETY_LOG.md`

复现（每条命令都在独立进程、且前置五次准入）：

```bash
node PPC-ORACLE-HOTPATH-ATTRIBUTION-01/scripts/admission.mjs 2560
npx vitest run --config PPC-ORACLE-HOTPATH-ATTRIBUTION-01/probe/vitest.config.mts PPC-ORACLE-HOTPATH-ATTRIBUTION-01/probe/g1_hotpath.test.ts PPC-ORACLE-HOTPATH-ATTRIBUTION-01/probe/g3_cache_safety.test.ts
bash PPC-ORACLE-HOTPATH-ATTRIBUTION-01/scripts/run_round.sh   # G4 rep 1..3，串行、每次准入
node PPC-ORACLE-HOTPATH-ATTRIBUTION-01/scripts/summary.mjs    # 汇总 + manifest + SHA256SUMS
bash PPC-ORACLE-HOTPATH-ATTRIBUTION-01/scripts/verify_ledger.sh
```

## 7. 未决 / 交给 ChatGPT

1. 是否同意终裁 B（缓存不实施），并把优化预算改投 P1（模拟复用）？
2. `stateKey` 降本（P2）会触及冻结语义，需要新轮次的等价性证明设计——本轮不启动。
3. 本机可用内存长期在 1.2–3.7 GB 波动，G4 的执行窗口需要按五次准入排队；如要求更严格的性能带宽（更多 reps），需要用户先释放宿主机内存或给出新的准入 floor 裁定。

`HEAVY_WORKER_CONCURRENCY=1` `SERIAL_FRESH_REPETITIONS=TRUE` `DUPLICATE_BENCHMARK_CHECK=REQUIRED` `COMMIT=NO` `PUSH=NO` `MERGE=NO` `PRODUCTION_WIRING=NO` `STOP_FOR_CHATGPT_REVIEW=TRUE`