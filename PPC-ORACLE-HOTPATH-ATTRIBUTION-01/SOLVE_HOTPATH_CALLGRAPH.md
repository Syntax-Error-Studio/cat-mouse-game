# SOLVE_HOTPATH_CALLGRAPH — 两鼠回合证明的调用图与成本分解点

轮次：`PPC-ORACLE-HOTPATH-ATTRIBUTION-01`。本文件描述冻结内核的真实调用顺序，并标明每一段由哪个探针计数器计量（`probe/seal_instrumented.ts`）。冻结文件 `PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts` 未改动。

## 0. 调用事实（已核验）

`seal_lib.ts:94-156` 的 `solve()` 中，每个结点的顺序是：

1. `game.settle(state)` → `applyNoMoveLoss`（`seal_lib.ts:104`）
2. `game.terminal(s)`（:105-107）
3. `game.player(s)`（:108）
4. 窗口截断：`player==='cat' && idx >= 2*H` → horizon 值（:109）
5. **`key = `${idx}|${game.key(s)}`**（:111）→ `stateKey`（`src/game/ai/transposition.ts:81`）
6. **`memo.get(key)`（:112）——发生在 `game.transitions(s)`（:118）之前**
7. memo miss → `nodes++`、cap 检查（:114-116）
8. `trs = game.transitions(s)`（:118）→ `realGame.transitions` →
   `generatePreparedSearchActions(s, rules)`（`seal_lib.ts:203-208`，`src/game/ai/preparedActions.ts:118-135`）
9. 逐转移：`childPlayer = player(settle(outcomes[0].state))`（:123），`ci = idx 或 idx+1`（:124）
10. 确定性转移 `outcomes.length===1 && weight===1` → 递归 `walk`（:127）
11. CHANCE（其余所有情况）→ `chanceNodes++`、`chanceOutcomes += outcomes.length`，对 `weight>0` 的结果做 **AND**（:129-141）
12. 截断/见 null 语义、`memo.set`（:144）、OR 侧 `policy.set`（:145）

**结论**：memo 命中会跳过第 8 步的全部动作生成；本轮的缓存只能作用在“已经通过 memo miss 的新展开结点”上。动作生成调用次数 = expansions（烟测已核对 `genCalls === expansions`）。

## 1. 动作生成内部（`preparedActions.ts`）

```
generatePreparedSearchActions(state, rules)          // :118
├─ enumerateSearchActionCandidates(state)            // :51（纯枚举，无模拟）
│   ├─ CatWins/MouseWins → []
│   ├─ ChoosingTunnelExit → 每个 tunnelExitChoices 一条（构造合法）
│   └─ Playing: 鼠 → 4×mouseStep (+mouseSkill)；猫 → 4×catStep (+catPlaceTrap)
└─ 对每个候选：simulateSearchAction(state, action, rules)   // :125
    ├─ RuleSet.mouseStep / catMove / mouseSkill / catPlaceTrap / chooseTunnelExit / endTurn
    ├─ forceEndTurnIfNeeded → 触发 CAT→MOUSE 的 CHANCE（ghost announcement / boundary）
    └─ 合法性 = kind==='chance' 或 !gameAffectingEqual(state, transition.state)  // :126-128
```

成本分解点（`profileGen` 模式，计时重实现 + 前 400 个结点与真实生成器逐项校验）：

- `profEnumMs` / `profEnumCandidates`：候选枚举；
- `profSimMs` / `profSimCalls`：每个候选一次引擎模拟（含后继生成，引擎内部不再细分——不改生产源码的前提下不可分）；
- `profCompareMs` / `profCompareCalls`：`gameAffectingEqual`；
- `mapLabelMs`：转成 `{label, outcomes}`。

## 2. 每个展开结点（self time）的计量

`walk` 每次调用记录 `(自身耗时 − 所有子 walk 耗时)` 之和为 `selfMs`；其中：

| 段落 | 计数器 |
|---|---|
| settle（结点 + 子结点 player 探测） | `settleCalls/settleMs` |
| terminal / player | `terminalMs` / `playerMs` |
| stateKey 串构造 | `keyCalls/keyMs/keyChars` |
| memo.get / memo.set / policy.set | `memoGetMs` / `memoSetMs` / `policySetMs` |
| 动作生成 + 映射（含全部候选模拟） | `transitionsMs`（＝`genMs`+`mapLabelMs`） |
| 递归 | `childWalkMs`（= `elapsedMs − selfMs`） |

一致性校验：**`selfMs ≈ elapsedMs`**（实测两者差 < 1% + 20 ms，DUUD 首次全量运行通过）。注意 `childWalkMs` 是“所有后代 walk 之和”（按深度重复计权），不能与 `elapsedMs` 相减——例如 LLLD cap 3000 时 `childWalkMs`=1635 ms 而 `elapsedMs`=132 ms。`selfMs` 的定义是 `Σ每层(自身 − 直接子层)`，求和后各层宿主开销互相抵消，只剩最外层墙钟。

## 3. CHANCE 分支

- `chanceNodes`：带 CHANCE 的转移数；`chanceOutcomes`：其全部结果数（含 weight≤0，冻结语义）。
- 真实树中 CHANCE 结果数远大于 CHANCE 结点数（DUUD 实测：2,122 个 CHANCE 转移 → 53,766 个结果），
  因此子 `walk` 调用的规模主要由 CHANCE 结果数决定，而不是“动作数”。
- 缓存能省的只有“同一状态的动作/后继重建”，**不能**省 CHANCE 结果的递归本身。

## 4. 缓存接入点（原型）

```
expansion(s)                                   // 唯一需要动作生成的位置
├─ 若 guardMemory != null → 生成并跳过缓存
├─ key = stateKey(s)
├─ cache.has(key) → 命中：复用 Transition[]（只读），cacheHits++
│                   shadowCompare 时仍生成基线并逐项比对
└─ 否则：生成，写入（FIFO 上限），cacheMisses++
```

缓存生命周期 = 一次 `solve()`；跨根/跨计划的交集只作为离线统计记录，**禁止**作为缓存基础。

## 5. 实测结果（已生成）

- `NODE_COST_BREAKDOWN.json`：DUUD 实根的 self-time 分解（生成 55.9%、stateKey 26.1%、memoGet 5.2%、settle 3.5%，其余 <1%），并附 131 个采样结点上的 microbench 复核；
- `CACHE_HIT_UPPER_BOUND.json`：per-solve 重复展开率（分母 = expansions）：DUUD 0.20%、UURR 0.26%、DRRR-mf 0.06%、DRRR-cs 0.14%、LLLD 0%（同 idx 重复一律 0）；
- `PAIRED_PERFORMANCE_RESULTS.json`：ABBA 配对的端到端比值（三次独立新进程）。