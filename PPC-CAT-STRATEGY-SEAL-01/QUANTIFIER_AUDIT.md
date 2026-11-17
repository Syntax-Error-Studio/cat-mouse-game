# QUANTIFIER_AUDIT — PPC-CAT-STRATEGY-SEAL-01

独立审查对象：`PPC-CAT-STRATEGY-01/probe/lib.ts`、`tactical_tree.test.ts`、
`cat_defense_probe.test.ts`、`chance_enumeration.test.ts`，以及真实规则源
（`src/game/ai/preparedActions.ts`、`simulator.ts`、`src/game/rules/mobility.ts`、
`src/game/engine.ts`）。本轮**不修改任何生产源**；所有修正都在隔离探针
`PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts` 内完成。

证据等级：A=代码级可复核（给出 file:line）；B=逻辑推导＋反例实证；C=推测/次要。

---

## 1. 真实转移与节点语义（审查基线， sound 部分）

搜索的动作来源是生产代码，探针未自建第二套规则：

- `generatePreparedSearchActions(s, rules)`（preparedActions.ts）枚举当前 actor 的
  全部合法动作；`rules = createEngineRuleSet()` 绑定 engine 的
  catMove/mouseStep/mouseSkill/catPlaceTrap/chooseTunnelExit/endTurn。
- `simulateSearchAction`（simulator.ts）只在**鼠吃黄油**时产生 CHANCE：对每个合法
  ghost 生成格均匀 1/N；CAT→MOUSE 的 ghost/debt 边界用均匀 k-子集 1/C(N,k)。
  搜索内**无 Math.random**。
- 终局：`GamePhase.MouseWins`（鼠带黄油入洞，engine.ts:762；或 RULE-A 猫被困，
  mobility.ts:158-162）与 `GamePhase.CatWins`（鼠被困，mobility.ts:149-153）。
- 回合交接：cat 最后一步 / mouse 选隧道出口后 `forceEndTurnIfNeeded`；mouse 自身
  最后一步在 `rules.mouseStep` 内部经共享 `endTurn` 交接。

量词方向（上一轮 `forcesWinWithin`，lib.ts:950-987）：

| 节点 | side='mouse' | side='cat' | 含义 |
|---|---|---|---|
| mouse | OR（∃，遇 true 截断） | AND（∀，遇 false 截断） | 存在/全称鼠策略 |
| cat | AND（∀） | OR（∃） | 全称/存在猫策略 |
| CHANCE | AND（∀ 正概率 outcome） | AND（∀） | 强制胜对全部 chance |

CHANCE 恒为 AND（lib.ts:969-975）对“强制胜”是正确的：必须对**每个**正概率
outcome 都成立。memo 键 `${idx}|${stateKey(s)}`（lib.ts:939）含回合 idx，
stateKey 为注入式地形编码（transposition.ts，P1-ID 已修复单射性），故 memo 不串味。
节点 cap 超出返回 `null`（UNRESOLVED，lib.ts:944），与“真无胜”区分。**这些是 sound 的。**

---

## 2. 缺陷 F1（A＋B 级，核心）：用 `!mouseForcesWin()` 推导猫存活

**代码证据：**
- lib.ts:890-892 注释明言：「`false` ⇒ CAT_SURVIVAL_CERTIFIED_WITHIN_H（猫在每条
  分支都挡住鼠，搜索刚以反驳找到它）」。
- tactical_tree.test.ts:77-84 `classify()`：当 `h0=false, h1=false, catH1=false`
  时**直接 fall-through** 返回 `CAT_SURVIVAL_CERTIFIED_WITHIN_H1`（第 83 行）。
  全程**没有独立的 catSurvive 搜索**。

**逻辑错误：** `mouseForcesWin` 计算的是
`∃σ_m ∀σ_c ∀chance → MouseWins`。其否定为
`∀σ_m ∃σ_c ∃chance ¬MouseWins`，而猫存活要求
`∃σ_c ∀σ_m ∀chance ¬MouseWins`。两者在两个量词上不同：

1. **猫/鼠量词顺序**：否定式是 `∀σ_m ∃σ_c`（猫可针对每条鼠策略自适应回应）；
   存活是 `∃σ_c ∀σ_m`（猫先承诺一个策略，对全部鼠策略都成立）。否定式更弱。
2. **CHANCE 量词**：否定式是 `∃chance`（存在某个 outcome 不输即可）；存活是
   `∀chance`（每个 outcome 都不输）。一个坏 outcome 就能破坏存活，却不破坏否定式。

**反例实证（本轮 counterexamples.test.ts 测试 A，已 PASS）：** 一个 CHANCE 分支鼠胜、
另一个分支不输 ⇒ `mouseForcesWin=false` 且 `catSurvive=false`。旧代码会因
`!false=true` 误判为 CERTIFIED_SURVIVAL；正确类别是 `CHANCE_DEPENDENT_OUTCOME`。

**影响范围：** 上一轮 18 个 `CAT_SURVIVAL_CERTIFIED_WITHIN_H1` 标签全部经此路径
产生，故**全部待重验**。6 个鼠强制胜标签不受 F1 影响（见 §6）。

---

## 3. 缺陷 F2（A 级）：`catForcesWin` 终局极性写反

**代码证据：** lib.ts:931-932
```
if (s.phase === GamePhase.MouseWins) return true;
if (s.phase === GamePhase.CatWins) return false;
```
这两行**与 `side` 无关**地硬编码。当 `side='cat'`（tactical_tree.test.ts:95 的
`catForcesWin`）时，MouseWins 被当作成功、CatWins 被当作失败 ⇒ 实际计算的是
「猫能否强制**鼠**胜」，与 §7.4 的 `∃σ_c ∀σ_m ∀chance → CatWins` 相反。

**影响：** 24 根的 `catH1` 全部返回 false，故没有根被误标 CAT_FORCED_WIN；但
“猫强制胜”这一问题本身在上一轮**不可信**。修正：终局极性随 mode 翻转
（seal_lib.ts:89-91，`terminalMouse = mode==='mouseForce'`，
`terminalCat = mode!=='mouseForce'`）。

---

## 4. 缺陷 F3（A 级）：prune 忽略 RULE-A 猫被困鼠胜路径

**代码证据：**
- lib.ts:133-146 `cannotReachHoleInHorizon`：仅以「带黄油入洞所需 Manhattan 步数 >
  预算」判定鼠无胜，返回 false（剪掉该节点）。
- 但 mobility.ts:158-162 给出**第二条 MouseWins 路径**：猫无合法空间移动 ⇒
  `MouseWins`（reason `cat_no_legal_spatial_move`），**不需要鼠入洞**。

**错误：** 当鼠暂时够不到洞、却能把猫困死时，prune 仍返回 false，把一个真实的
RULE-A 鼠胜剪掉。该 prune 在 `forcesWinWithin`（lib.ts:934-937）与
`verifyCatPolicy/verifyMousePolicy` 中都被调用，故猫防证书（DRRR/DRDR）同样继承此缺陷。

---

## 5. 缺陷 F4（C 级，次要/潜在）：prune 每回合预算 6 的紧性

**代码证据：** lib.ts:143-144 `budget = mouseMovesLeft + 6*laterMouseTurns`，
注释（lib.ts:127）称「6 = 3 carrying + 3 skill」。真实每回合预算见
tactical_tree.test.ts:61-63：`base = mouseHasButter ? 3 : 4`，`skillBonus = 3`，
即**非携带**回合可达 4+3=7 > 6。

**诚实分级：** prune 仅在 `mouseHasButter=true` 时启用（lib.ts:134），而携带态会一直
持续到入洞获胜，故后续回合通常仍为携带（3+3=6），6 对携带回合是安全上界；技能
一次性（mouseSkillActive）使 +3 被高估，方向偏 fail-open。因此 F4 是**潜在/次要**
问题，不是主缺陷；一旦 F3 成立，prune 已不可信。本轮**整体禁用该 prune**
（seal_lib.ts 不调用任何 reachability 剪枝），F3/F4 一并消除。

**方向性结论（重要）：** F3/F4 只会把“真鼠胜”变成“无胜”（prune 返回 false），
即只能制造**假阴性**（漏掉真胜）→ 经 F1 变成假存活；**绝不会**把“无胜”变成
“鼠强制胜”。故鼠强制胜的 TRUE 结果不受 F3/F4 污染。

---

## 6. 哪些上一轮结论仍然 sound

- **6 个鼠强制胜根**（H0：G6T3/G5T4/G2T8；H1：G5T3/G2T7/G1T9）：TRUE 结果来自
  真实胜树，prune 只能删胜不能造胜，F1 不影响 TRUE 方向 ⇒ **可信**，本轮仍独立重验。
- **CHANCE 枚举**（chance_enumeration.test.ts，29 分支吃黄油审计）：对“鼠强制胜”
  用 ∀chance 方向正确 ⇒ sound。
- **stateKey 单射性**（P1-ID 修复，transposition.ts）：memo/TT 不串味 ⇒ sound。

**待重验：** 18 个存活标签（F1＋F3/F4），以及 DRRR/DRDR 猫防证书（继承 prune）。

---

## 7. 修正后的契约（seal_lib.ts，五类＋UNRESOLVED）

独立搜索三个量词问题，**不再用否定推导**：

| mode | 量词 | 终局成功 | 视界成功 |
|---|---|---|---|
| mouseForce | ∃mouse ∀cat ∀chance → MouseWins | MouseWins | false |
| catSurvive | ∃cat ∀mouse ∀chance → ¬MouseWins | CatWins | **true**（撑过视界即存活） |
| catForce | ∃cat ∀mouse ∀chance → CatWins | CatWins | false |

CHANCE 在三个 mode 中恒为 AND（∀ 正概率 outcome）。终局判定**先于**视界截断
（seal_lib.ts:97-101，反例“terminal-before-horizon”已 PASS）。节点 cap 超出 ⇒
`null` ⇒ UNRESOLVED，绝不冒充 PASS。

`classifySeal(h0,h1,survive,catForce)`（seal_lib.ts:402-412）：
任一 null ⇒ UNRESOLVED；`h1&&survive` 抛矛盾；h0⇒H0 鼠胜；h1⇒H1 鼠胜；
catForce⇒CAT_FORCED_WIN；survive⇒CAT_SURVIVAL；否则 **CHANCE_DEPENDENT_OUTCOME**。
`CAT_SURVIVAL` 与 `CHANCE_DEPENDENT` 由**独立的 catSurvive 搜索**区分，而非
`!mouseForcesWin`。

**证书独立验证：** `verifyCatCertificate`/`verifyMouseCertificate`
（seal_lib.ts:235-382）不调用 `solve`、不共享布尔组合子、不用 prune；在每个全称
节点重新枚举**全部**合法对手动作与**全部**正概率 CHANCE outcome，在存在节点按
提取的策略走；策略缺失=硬失败。证明者与验证者**不共享**未验证的布尔否定函数。

---

## 8. 反例覆盖（Phase 3，7/7 PASS，logs/counterexamples_run.log）

A 混合 chance→双方都不认证；B 全 chance 鼠胜→鼠强制/猫不存活；C 全 chance 不输→
猫存活；D 猫单一防守动作挡住全部鼠动作＋chance（∃ 只在猫动作上）；E 自适应鼠策略
（MA→p、MB→q，非固定串）破全部猫防；F cap→UNRESOLVED 与真无胜区分；
terminal-before-horizon：最后一步鼠胜先于视界判定。