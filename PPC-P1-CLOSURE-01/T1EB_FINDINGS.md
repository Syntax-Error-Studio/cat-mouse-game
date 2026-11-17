# T1E-B 归因报告

测试：`src/game/ai/__tests__/expectiminimax.test.ts > T1E-B A/B/K. NO_DEADLINE and far-deadline searches return the EXACT same result`
表现：`Error: Test timed out in 30000ms.`
裁决：**`TEST_EXPECTATION_OR_HARNESS_ISSUE`**（测试预算/环境问题，不是引擎正确性问题，也不是本轮引入）

---

## 1. 这个测试到底在算什么

```ts
const t1ebBase = { rules: noTrapRuleSet, maxDepthTurns: 4, maxNodes: 1_000_000,
                   useTT: false, useAlphaBeta: false, useMoveOrdering: false } as const;
const t1ebBig  = () => openArena({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 } });

test('T1E-B A/B/K ...', () => {
  const s   = t1ebBig();
  const nd  = searchBestActionIterative(s, { ...t1ebBase, deadlineMs: undefined });
  const far = searchBestActionIterative(s, { ...t1ebBase, deadlineMs: T1EB_FAR, now: () => 1 });
  // 断言 far 与 nd 逐字段相同
});
```

关键点，逐条对应任务书的检查项：

| 检查项 | 事实 |
|---|---|
| 精确输入根与固定参数 | `openArena(cat 4,4 / mouse 6,6)`；`maxDepthTurns=4`，`maxNodes=1_000_000` |
| 无 deadline vs 远期 deadline | 第一臂 `deadlineMs=undefined`；第二臂 `deadlineMs=1e9` 且 `now: () => 1`（常量时钟，永不到期） |
| 深度 / 节点预算 | 4 个完整回合、节点上限 1,000,000 |
| chance 分支 | 该 arena 有黄油，CHANCE 节点存在 |
| TT 使用 | **关闭**（`useTT:false`），同时关 AB 与排序 ⇒ 这是**穷举级**搜索，不是带剪枝的搜索 |
| 超时发生在哪 | 测试函数体（两次搜索本体），不是构造、不是断言、不是运行器 |

**两次**无剪枝、深度 4、上限 100 万节点的穷举搜索。这是整份 `expectiminimax.test.ts` 里最重的用例。

同一文件里紧接着的 `T1E-B E/F/G` 做的是同一量级的工作，但它显式写了 `}, 120_000);`，并且原注释直接承认：

> `// ~1M-node exhaustive arena searches; ... this budget is environmental (serial heavy run), not part of any correctness gate.`

而 T1E-B 自己**没有**显式超时，落到 `vitest.config.ts` 的全局 `testTimeout: 30000`。

> 该配置文件自己的注释也写着：`// Search benchmarks (D2/D3/D4) can exceed the 5s default in a full suite run due to GC/context pressure; 30s matches the explicit timeouts used by the D3 tests`。也就是说 30s 是为了**加快**全局而设的折中值，不是这个用例的设计预算。

---

## 2. 证据链（全部是本轮或前轮落盘的日志）

| # | 环境 | 源码 | 超时 | 结果 | 耗时 | 日志 |
|---|---|---|---|---|---|---|
| 1 | 2026-11-12 | bare HEAD | 30s | **PASS** | 18.51s | `PPC-P1-ID-01/logs/baseline_t1eb.log` |
| 2 | 2026-11-12 | bare HEAD，整个文件一起跑 | 30s | **FAIL 超时** | 文件 207.65s | `PPC-P1-ID-01/logs/baseline_full_expectiminimax.log` |
| 3 | 本轮 | 当前候选（四轮） | 30s | **FAIL 超时** | 43.41s | `logs/t1eb_isolated.log` |
| 4 | 本轮 | **HEAD 对照臂**（冻结旧源码） | 30s | **FAIL 超时** | 42.37s | `logs/t1eb_arm_head.log` |
| 5 | 本轮 | HEAD 对照臂 | 240s | **PASS** | tests 39.73s | `logs/t1eb_arm_head_long.log` |
| 6 | 本轮 | 当前候选 | 240s | **PASS** | tests 41.88s | `logs/t1eb_candidate_long.log` |

**第 3 与第 4 行是本轮最关键的对照**：把六个生产文件逐字节回退到 HEAD blob 之后（`ARM_MANIFEST.json` 里六个 sha256 与 `git show HEAD:` 全等），同一个用例同样 30s 超时，耗时 42.37s 对当前候选的 43.41s——差 1.04s，2.4%，在抖动范围内。

⇒ **与本轮四轮补丁无因果关系。**

**第 5 与第 6 行**：给足预算后两臂都**通过**，说明
- 搜索是**确定性终止**的（有界、可复现）；
- 断言内容本身**成立**（`far.*` 与 `nd.*` 逐字段相同）；
- 唯一不满足的是 **30s 这条人为预算线**。

---

## 3. 为什么现在才崩：环境吞吐变化，不是代码变慢

同一天、同一台机器，把同一份冻结旧源码跑出 39.73s，而 2026-11-12 只需 18.51s——**机器吞吐掉了约 2.2 倍**。30s 这条线当初留的余量（18.5 → 30，1.6×）已经被吃穿。

为排除"是新代码让它变慢"这条替代解释，本轮做了机制级对照：

`P4-A`（`_raw/statekey_micro.json`，诊断级，非基准权威）在同一进程内交替采样 5 轮 × 60,000 次：

```
current : median 5.816 µs/call   (样本 5.90 / 5.66 / 5.71 / 5.82 / 22.20)
HEAD arm: median 5.716 µs/call   (样本 5.57 / 5.72 / 5.54 / 14.04 / 19.51)
ratio   : 1.017      keyLength: 379 两臂完全相同
```

P1-ID 加固 `stateKey` 最可疑（它在 `_search` 里每节点都调用），但实测**每条 key 的成本只差 1.7%**，且默认地图上的 key 长度一模一样（编码只在 `trap`/`butter_spot` 两种地形上换了字符）。⇒ 两臂 40s 量级的差异里，`stateKey` 不构成可归因来源；剩余的 2.15s（+5.4%，单次配对观测）不足以判定为回归，我**不**声称它是。

---

## 4. 裁决与它的边界

**裁决：`TEST_EXPECTATION_OR_HARNESS_ISSUE`**

- 不是 `PREEXISTING_ENGINE_CORRECTNESS_FAILURE`：断言在给足时间后成立，值逐字段相同。
- 不是 `PERFORMANCE_OR_TERMINATION_FAILURE`：终止性有界且确定性，两臂都能跑完；"没跑完"是因为预算线低于当前机器跑完所需时间。
- 不是本轮引入：冻结 HEAD 臂同样超时。

**明确不做的两件事**（按任务书要求）：

1. **不**通过"把 30000 改成 120000 然后宣布解决"来处理。本轮只把它记录为一条**过期权威**：`REG-T1EB-WALL`，并附上两臂实测 39.73 / 41.88s。是否真正调整，属于后续独立决定（改配置会同时影响全部 89 个用例的超时语义）。
2. **不**把它算进四轮的正确性账本。

**留待后续的选项**（本轮不实施，只登记）：给该用例显式 `}, 120_000);`（与同文件同量级的 E/F/G 一致），或把它的两臂搜索降到可承受深度。两者都改测试意图边界，需要单独授权。

**这条裁决对合并的含义**：T1E-B 不阻塞。但它说明**本机当前的 30s 全局超时已经不足以承载 100 万节点的穷举用例**，后续任何"全量回归绿"的声明都必须附带机器性能前提，否则不可比。
