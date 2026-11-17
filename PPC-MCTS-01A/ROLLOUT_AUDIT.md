# PPC-MCTS-01A — ROLLOUT_AUDIT

**问题**：UCT-H 的 rollout 每一步做了什么？为什么它比 UCT-R 贵近一个数量级？鼠方最小化、种子化 tie-break、循环与终止条件是否正确？

证据标签：**[源码]** / **[日志]** / **[统计]** / **[假设]**。

---

## 1. Rollout 主循环

- **[源码]** 每次 simulation 从树内停止点调用 `rollout`（`uct.ts:448`, `519-564`）。
- **[源码]** 每步先检查 `terminalReward`；终局立即以 ±1 结束，不评价。
- **[源码]** 若 `handoffs >= maxHandoffs(4)` 则停止；否则（非第一次 simulation）检查 deadline，超时则整条 simulation 作废。
- **[源码]** 调用 `generateLegalSearchActions` 取得动作；若为空则停止。
- **[源码]** 由 `selectRolloutAction` 选择动作；simulate 一次；若结果是 CHANCE，则按权重采样 **1 个** outcome；更新 handoffs、steps、key 集合。
- **[源码]** 在 `maxRolloutActions=40` 或路径内出现重复状态时停止；最后以 `evaluateLeaf` 收尾。

**[源码]** `allowOverrunForFirst` 只允许第一次 simulation 越过 deadline，用于保证至少有一个完整 simulation；之后任何超时都返回 `completed=false`，不提交。

---

## 2. UCT-H 的 Hybrid 引导

### 2.1 选择逻辑

- **[源码]** `selectRolloutAction`（`uct.ts:222-245`）：
  - 只有一个合法动作：直接返回，不评价。
  - `mode='random'`：`actions[rng.int(n)]`，不评价。
  - `mode='hybrid'`：遍历**全部**合法动作；每个动作调用 `guidanceValue`。
- **[源码]** `guidanceValue`（`uct.ts:209-220`）：
  - 先 `simulateSearchAction`；
  - deterministic：评价后继一次；
  - chance：对**所有** outcome 分别评价，再加权求和（不是采样一个）。
- **[源码]** 选择规则：猫节点取最大，鼠节点取最小；非有限值跳过；浮点相等（`1e-12`）的动作进入候选集，用 `policyRng.int(best.length)` 均匀选一个。
- **[源码]** 没有任何排序；一次线性扫描完成“评价 + argmax/argmin + tie 收集”。

### 2.2 与随机 rollout 的差别

| 行为 | UCT-R | UCT-H |
| --- | --- | --- |
| 遍历合法动作 | 否，均匀抽 1 个 | 是，评价全部 |
| 每步叶评价 | 0（只有最后 1 次 evaluateLeaf） | 每候选 1 次；chance 候选 × outcome 数 |
| 鼠方视角 | 不涉及 | 取最小值 |
| tie-break | 均匀随机 | 均匀随机（在最优集合内） |
| 每步 simulate 次数 | 1（选定动作） | 候选数 × 2 + 1（见 §3） |

---

## 3. 重复模拟：一步到底模拟了几次

**[源码]** 每个 rollout 步骤至少有三层 simulate：

1. `generateLegalSearchActions` 内部：对每个候选动作调用 `simulateSearchAction` 验证“是否产生游戏相关变化”（`legalActions.ts:38-42`, `48-56`）。
2. `guidanceValue`：对每个候选动作再调用一次 `simulateSearchAction`，并对 chance outcome 评价。
3. 选定动作后，rollout 主循环再调用一次 `simulateSearchAction` 得到真实后继。

因此多动作状态下每个被选中的动作至少被模拟 **3 次**：合法验证 1 次 + 引导 1 次 + 实际执行 1 次；未被选中的候选也被模拟 **2 次**（合法验证 + 引导）。单动作状态跳过引导，选定动作被模拟 **2 次**（合法验证 + 实际执行）。

**[统计]** coverage 精确计数（UCT-H）：

```text
selectRolloutAction 调用             = 1,161
guidanceValue 调用                   = 4,019   → 平均 3.462 个候选/步
simulateSearchAction 调用            = 10,151  → 平均 8.74 次/步
evaluateLeaf                         = 4,595   → 平均 3.96 次/步
```

`8.74 ≈ 3.46（合法验证）+ 3.46（引导）+ 1（选定执行）+ CHANCE/边界额外模拟`，与源码结构一致。

**[统计]** 对照 UCT-R：`selectRolloutAction 24,723`，`simulateSearchAction 131,668`，平均 `5.32` 次/步；`guidance=0`，`evaluateLeaf/sim=0.951`（几乎只有终局叶）。

### 3.1 候选动作的重复评价

- **[源码]** 同一状态下，合法动作列表每次重新生成；没有按 `stateKey` 缓存“合法动作 + 有效性模拟结果”。
- **[源码]** 同一个候选动作的 transition 在合法验证和引导阶段各算一次，选定后第三次算；三次结果相同但没有复用。
- **[源码]** 一个吃黄油候选在引导阶段会对 24–34 个 spawn outcome 各做一次 `evaluateLeaf`；即使该候选未被选中，这些评价也已经付出。
- **[源码]** 没有跨 simulation 的 evaluation cache；相同 rollout 状态在后续 simulation 中会完整重算。

---

## 4. 鼠方 MIN、种子与循环

### 4.1 鼠方最小化

- **[源码]** `maximize = state.currentPlayer === Cat`；鼠节点选择最小引导值。
- **[源码]** 评价本身是猫视角（`hybridEvaluateForCat`），因此鼠方是在最小化“猫的评估”，与零和树回传一致。
- **[假设]** 这会让鼠方在同一启发式下“配合”猫的评估尺度；是否造成双方策略同质化，本轮没有对弈证据。

### 4.2 种子与 tie-break

- **[源码]** rollout 只用 `policyRng`（由 `seedFor([seed,'policy'])` 派生）；chance 采样只用 `chanceRng`；`Math.random` 被 harness 的 guard 禁止。
- **[源码]** `policyRng` 同时用于树内 `selectEdge` 的并列选择与 rollout 的并列选择，因此两个决策点的随机流是耦合的；仍然是确定性的，但不是“每类决策独立流”。
- **[源码]** 若所有候选值都非有限，`best.length===0` 时回退到均匀随机，不会抛错。

### 4.3 振荡与重复状态

- **[源码]** rollout 维护 `keys`，每一步把后继 key 加入；若 key 已存在，则把 `state` 设为该后继并 `break`，随后做一次 `evaluateLeaf`。
- **[源码]** 因此不会在同一条 rollout 内无限往返；代价是重复状态被当作“停止点”评价，而不是被惩罚或跳过。
- **[源码]** 该 `keys` 只覆盖当前 rollout 路径；跨 simulation 不共享，不能防止不同 simulation 反复走同一条线。

### 4.4 终止条件

- 终局：立即返回 ±1。
- `handoffs >= 4`：停止并评价当前非终局。
- 无合法动作：停止并评价。
- 重复状态：停止并评价。
- `steps >= 40`：停止并评价。
- deadline：整条 simulation 作废（不评价、不回传）。
- **[源码]** 所有终止路径都返回 `completed=true` 或 `completed=false`，没有“未定义”返回值。

---

## 5. 每步实际成本对比

| 指标（coverage） | UCT-R | UCT-H | 比值 |
| --- | ---: | ---: | ---: |
| rollout/扩展步数 | 24,723 | 1,161 | — |
| 每步 simulate | 5.32 | 8.74 | 1.64× |
| 每步 guidance 评价 | 0 | 3.46 | ∞ |
| 每步 leaf 评价 | 0.073 | 3.96 | 54× |
| 每 simulation 步数 | 13.09 | 11.27 | 0.86× |
| 每 simulation CPU（未插桩诊断） | 0.345ms | 3.161ms | 9.16× |

- **[统计]** UCT-H 每步的 **simulate 调用**只多 1.64×，但每步的 **leaf 评价**多约 54×；真正的成本差来自 Hybrid 评价（3 BFS + ValueNet），不是循环次数。
- **[统计]** UCT-H 每 simulation 的 rollout 步数反而略少（11.27 vs 13.09），因为它更早因 handoff/终局/重复状态停止；但每步贵得多。
- **[统计]** 用未插桩诊断折算：UCT-H 每 rollout 步约 `3,161µs / 8.52 步 = 371µs`；UCT-R 约 `345µs / 11.65 步 = 29.6µs`，约 **12.5×**（统计推导，非正式计时）。

---

## 6. 计划补全中的 rollout

- **[源码]** `extractPlan`（`uct.ts:627-645`）使用**同一个** `selectRolloutAction` 和同一个 `policyRng` 补全猫回合；只补猫动作，遇到 CHANCE 边界保留该动作后停止。
- **[源码]** 补全在树搜索结束后执行；此时 `policyRng` 已被搜索推进，因此补全的具体选择不是“搜索开始时根 rollout 会选的那一个”，而是同一确定性序列的后续值。
- **[统计]** 诊断中补全共 27 步、99 次评价、0.384ms/根；相对搜索本身很小，但它意味着最终计划里约 39.6% 的猫动作没有树内访问证据。
- **[源码]** 补全同样会为每个候选动作做合法验证 + 引导 + 选定执行，因此“补一步”并不便宜；只是步数少。

---

## 7. 回答重点问题

1. **Hybrid 是否遍历全部合法动作？**
   - 是（单动作除外）；每个候选都模拟 + 评价。[源码]
2. **是否重复模拟候选？**
   - 是，至少 2 次（合法验证 + 引导），选定后再 1 次，共 3 次；CHANCE 候选还会展开全部 outcome。[源码 + 统计]
3. **是否有排序/评价重复？**
   - 无排序；一次线性扫描；评价重复存在于合法验证与引导之间，且跨 simulation 不缓存。[源码]
4. **鼠方是否 MIN？**
   - 是，`-Q` 视角/最小引导值。[源码]
5. **tie-break 是否 seeded？**
   - 是，`policyRng`；不用 `Math.random`；但它与树内 tie-break 共用同一条流。[源码]
6. **是否会振荡？**
   - 单条 rollout 内不会无限振荡（重复 key 即停）；跨 simulation 不去重。[源码]
7. **UCT-R 与 UCT-H 每步成本？**
   - 每步 simulate 1.64×，每步 leaf 评价约 54×，每 simulation CPU 9.16×；差距由 Hybrid 评价主导。[统计]
