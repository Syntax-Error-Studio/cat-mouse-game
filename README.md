# 小猫小鼠：严格实时预算下的对抗智能决策与混合博弈搜索

《小猫小鼠》是一个有限行动点、非对称、回合制猫鼠博弈，也是 **Project Perfect Cat** 的实验载体。项目重点不是“让猫看起来聪明”，而是在不修改基础游戏规则的前提下，研究 **严格实时预算下的对抗搜索、状态价值学习、失败取证与可复现验证**。

## Formal V2 正式结果

在冻结的 Protocol V2 canonical mouse policy 与成对随机性控制下：

- BASELINE 猫方胜率：**72.75%**（1223 / 1681）
- FROZEN_HYBRID 猫方胜率：**81.38%**（1368 / 1681）
- 配对增益：**+8.63 个百分点**
- 95% Bootstrap CI：**[+7.02, +10.29] 个百分点**
- Exact two-sided McNemar：**p = 5.7211e-25**

> 这不是对真人玩家的胜率估计，也不构成 Perfect Play、optimal 或 unbeatable 证明。

正式冻结检查点：

- Commit: `8a34be767fe23e3d5540fb46e46793fed79d0213`
- Tag: `perfect-cat-formal-v2-primary-pass-20261006`
- Machine authority: `FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json`

## 技术链

```text
游戏状态
  → 精确规则模拟
  → 回合感知 Expectiminimax
  → TT / Alpha-Beta / Move Ordering / Iterative Deepening
  → 规则战略评价 + ValueNet
  → Hybrid Leaf
  → 100 ms 主搜索预算 / 150 ms 完整猫回合预算
  → Exact Replay / Failure Forensics / Formal Evaluation
```

Hard AI 的改动只改变决策策略，不修改合法动作、行动点、资源规则或胜负条件。当前玩法唯一权威见 [GAMEPLAY.md](./GAMEPLAY.md)。

## 运行

需要 Node.js 与 npm。

```bash
npm ci
npm run dev
```

常用检查：

```bash
npm test
npm run build
npm run lint
```

## 仓库结构

```text
src/                         产品代码、游戏引擎与 AI 核心
public/                      静态资源
scripts/                     产品侧辅助脚本
tools/research-archive/      历史研究/取证脚本
docs/research/evidence/      关键研究证据
docs/research/archive/       完整历史实验记录
docs/research/artifacts/     少量历史输出样本
GAMEPLAY.md                  当前玩法与规则权威
FORMAL_V2_...json            Formal V2 机器检查点
```

## 重点入口

- 搜索内核：`src/game/ai/expectiminimax.ts`
- 规则战略评价：`src/game/ai/evaluation.ts`
- Hybrid / ValueNet：`src/game/ai/hybridLeaf.ts`
- Hard 回合规划：`src/game/ai/hardTurnPlanner.ts`
- AI 测试：`src/game/ai/__tests__/`
- 研究证据索引：[docs/research/README.md](./docs/research/README.md)

## 研究边界

当前长期目标是 **Toward Perfect Play**。Formal V2 证明了冻结条件下的显著配对强度提升，但尚未证明整局最优策略。下一阶段重点是更强的 avoidability oracle，以及在独立新 population 上重新冻结验证。
