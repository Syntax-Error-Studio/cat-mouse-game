# 猫基础移动预算的输入域合同

**Round:** PPC-P1-CLOSURE-FIX-01
**Date:** 2026-11-13
**Scope:** `GameConfig.catBaseMoves` → `GameEngineState.catMovesLeft` → 计划提取上界

---

## 1. 合同

```text
catBaseMoves 必须是有限安全正整数
  Number.isSafeInteger(catBaseMoves) === true
  catBaseMoves >= 1
```

`0` 不是合法的基础预算。

## 2. 依据：游戏规则本身就是离散的

一条猫回合是**单位代价动作序列**：

| 动作 | 步数代价 | 实现位置 |
|---|---:|---|
| `catMove`（含推箱）| 1 | `engine.ts` `catMove`，两条分支都返回 `catMovesLeft - 1` |
| `catPlaceTrap` | 0 | 不触碰 `catMovesLeft` |
| 收回陷阱 | 1 | 踩上陷阱格（`steppedOnTrap` 分支）|
| 回合交接 | — | `catMovesLeft === 0` 时 `endTurn` |

因此 `catMovesLeft` 的语义是**剩余步数计数**，不是可连续的标量。`catMove` 的准入判据是 `catMovesLeft <= 0`（`engine.ts:892`），扣减恒为 1。

## 3. 为什么每一种非法值都必须拒绝（不是"能跑就行"）

| 值 | 后果 |
|---|---|
| `2.5` | `catMove` 允许**三步**（2.5 → 1.5 → 0.5 → −0.5），而 `floor(2.5)=2` 的计划上界只预算两步 ⇒ 计划长度与真实步数**互相矛盾** |
| `NaN` | `NaN <= 0` 为假 ⇒ 回合**永不交接**；同时完整性残差检查 `catMovesLeft > 0` 也为假 ⇒ 一个被截断的单动作计划会被认证为 **COMPLETE** |
| `+Infinity` | 无界回合：回合永不结束，计划上界无意义 |
| `−Infinity` / 负数 | 回合已经结束却仍标记 `Playing`；`catMove` 永久拒绝，计划提取拿到负预算 |
| 不安全整数（`2^53+2`）| `M + 1 + floor(M/2)` 不再保证是安全整数，上界推导失效 |
| `0` | 回合开始时猫就无法行动（`catMove` 第一道判据即返回原状态）|

**`catMovesLeft === 0` 在运行时是合法值**：它是回合边界（预算已花完），只产生"0 步预算"，必须与"损坏预算"区分。这一点在 `hasCertifiableCatMoveBudget` 与测试 `a genuine zero-move boundary is NOT treated as an illegal budget` 中都显式成立。

## 4. 三层实施

### 4.1 配置层（唯一的正式对局入口）

`src/game/config.ts` → `validateGameConfig()`，新增一个 issue：

```ts
const catBaseMoves = config.catBaseMoves as number;
if (!Number.isSafeInteger(catBaseMoves) || catBaseMoves < 1) {
  issues.push({ kind: 'invalid', message: `猫每回合的基础步数必须是不小于 1 的整数（当前 …）。` });
}
```

选这里的理由：`createGameState()`（`newGame.ts:59`）在**任何状态被构造之前**就调用它，且它已经承担所有结构校验（边界、洞、启动位、箱子、黄油）。因此修复落在一个既有闸门上，不新增调用链。

失败关闭沿用**原有**返回类型，没有新造型：

```ts
// newGame.ts:61-71
return { state: null, status: { kind: 'unverified', reason: 'INVALID_CONFIG', detail } };
```

`reason` 为 `INVALID_CONFIG`（因为新 issue 的 `kind` 是 `'invalid'`，不是 `'unsupported'`）。

### 4.2 原始构造器（堵后门）

`src/game/engine.ts` → `createInitialState()` 前置断言：

```ts
if (!Number.isSafeInteger(config.catBaseMoves) || config.catBaseMoves < 1) {
  throw new RangeError('createInitialState: config.catBaseMoves must be a positive safe integer …');
}
```

为什么是**抛错**而不是静默规整：`createInitialState` 是公开的原始构造器，`catMovesLeft` 直接从 `config.catBaseMoves` 拷贝。若在此 floor/clamp，就是把非法配置变成"看起来合理的一回合"——正是本轮要消灭的东西。想拿"失败关闭的**返回值**"的调用方应走 `createGameState`（`state: null`）。

影响面：生产代码中 `createInitialState` 的调用点只有 `newGame.ts`（已在上游校验）；其余调用点全在测试与本轮新增测试里。

### 4.3 运行时层（搜索与计划提取）

`src/game/ai/planBound.ts` 新增唯一判定：

```ts
export function hasCertifiableCatMoveBudget(state): boolean {
  const raw = state.catMovesLeft;
  return Number.isSafeInteger(raw) && raw >= 0;
}
export function catTurnMoveBudget(state): number {
  return hasCertifiableCatMoveBudget(state) ? state.catMovesLeft : 0;
}
```

**关键：非法预算返回 0，绝不 `floor` 猜测。** 旧实现是 `Math.floor(raw)`，会把 `2.5` 默默变成"2 步预算"——这正是"把非法状态解释成合理计划"的原始缺陷。

四个消费点全部失败关闭：

| 函数 | 文件 | 非法预算时的行为 |
|---|---|---|
| `planFullTurnCompleteness` | `planQuality.ts:235` | 返回 `TRUNCATED` + `invalid cat move budget` |
| `buildPlanForFirstAction` | `planQuality.ts:318` | 返回 `[]` ⇒ `buildCandidate` 为 `null` |
| `extractBestCatTurnPlan` | `planQuality.ts:522` | 返回 `[]` |
| `extractDp`（DP 递归每个节点）| `planQuality.ts:575` | 返回 `[]` |
| `buildCatTurnPlan`（日志走查）| `expectiminimax.ts:1897` | 返回 `[]` |

`planFullTurnCompleteness` 的门放在**重放之前**：`NaN` 时 `NaN > 0` 为假，残差检查会把截断计划判成 COMPLETE，所以必须在入口拒绝，而不是在出口补救。

## 5. 明确拒绝的"修法"

**没有**把 `Math.floor` 改成 `Math.ceil`。

理由：小数预算本身不符合离散移动合同。`ceil` 只修好了上界的某一处，真实引擎的交接条件（`catMovesLeft <= 0`）与 `planFullTurnCompleteness` 的 `catMovesLeft === 0` 判断仍会与它矛盾。正确方向是**拒绝非法基础预算** + **运行时非法状态不被认证**。

## 6. 没有添加最大上限

代码库中没有既有的"猫基础步数最大值"约束，本轮**不发明**一个会影响正常配置的游戏规则上限。只保证上界计算本身是安全整数：

- `maxCatTurnPlanActions` 对 `M` 安全整数返回 `M + 1 + floor(M/2)`；
- 测试 `M = 1_000_000 ⇒ 1_500_001`，`Number.isSafeInteger(bound) === true`；
- 上界的实际安全域由 `Number.isSafeInteger` 判定，超过安全整数即在配置层被拒。

## 7. 兼容性与不变性

| 项 | 结果 |
|---|---|
| 默认地图 `catBaseMoves = 4` | 接受，`catMovesLeft = 4`，状态逐字段不变 |
| `M = 4` 计划上界 | 仍为 **7**（小于旧常量 8）|
| `M = 9` 计划上界 | 仍为 **14** |
| `validateGameConfig(DEFAULT_CONFIG).ok` | `true`，`issues` 为空 |
| `createInitialState` 默认配置 | `catMovesLeft=4`、`mouseMovesLeft`、`catTrapsRemaining=1`、`trapPosition=null` 全不变 |
| 同一输入两次构造的 `stateKey` | 相同（固定黄油布局下逐字节相同）|
| P1-PLAN-01 原 19 项 | 全绿 |
| 有无新增 UI 入口 | **无**。设置界面本来就没有猫基础步数输入，本轮不新增 |

## 8. 未覆盖边界（如实登记）

1. **`mouseBaseMoves` 未加同样校验。** 本轮授权范围只到猫预算。鼠步数若为非整数，会走 `mouseMovesLeft` 的同类路径，但鼠 AI 处于 PAUSED 且不影响猫计划上界推导——**登记为后续独立缺口，未修改**。
2. **`catMovesLeft` 在回合中途被外部写入非法值** 只能靠运行时门兜住；本轮不新增"状态不变式断言扫描"，因为那会侵入热路径。
3. **`config.catBaseMoves` 类型仍是 `number`。** 没有改成 branded type / 枚举，因为那属于类型重构，超出最小修复范围；合同由运行时校验保证。
