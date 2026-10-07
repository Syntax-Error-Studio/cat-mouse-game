# Project Perfect Cat Research Index

这里保存研究报告与历史实验记录。

**权威顺序：**
1. 当前玩法规则：根目录 `GAMEPLAY.md`
2. Formal V2 机器检查点：根目录 `FORMAL_V2_PRIMARY_PASS_SOURCE_CHECKPOINT.json`
3. 冻结源码：tag `perfect-cat-formal-v2-primary-pass-20261006`
4. 本目录中的研究报告与历史记录

## 关键证据

| 主题 | 文件 |
|---|---|
| TT 精确缓存 | [D1](./evidence/D1-final-report.md) |
| Alpha-Beta 正确性与基准 | [D2](./evidence/D2-final-report.md) |
| Iterative Deepening | [D4](./evidence/D4-final-report.md) |
| 战略评价器 | [E1](./evidence/E1-final-report.md) |
| 搜索正确性 | [F1A](./evidence/F1A-search-correctness-report.md) |
| Hard AI 生产接入 | [F1B](./evidence/F1B-hard-production-integration-report.md) |
| 叶评价缓存与实时效率 | [G0.3C](./evidence/G0.3C-exact-search-efficiency.md) |
| forced-region 失败取证 | [G0.3P](./evidence/G0.3P-forced-region-escape-proof.md) |
| 10k Self-Play ValueNet | [G0.4B-2](./evidence/G0.4B-2-canonical-valuenet-learning-audit.md) |
| ValueNet 延迟隔离 | [G0.4C-1.1](./evidence/G0.4C-1.1-valuenet-latency-isolation.md) |
| Hybrid 生产硬化 | [G0.4E-1.1](./evidence/G0.4E-1.1-hybrid-integration-hardening.md) |
| 幽灵黄油规则接入 | [G0.4F-2A](./evidence/G0.4F-2A-ghost-butter-rule-integration.md) |
| 生产搜索边界审计 | [G0.4F-2B-1.9L](./evidence/G0.4F-2B-1.9L-production-search-boundary-audit.md) |

## Archive

`archive/` 保存完整研究轨迹，包括失败实验、候选方案和已被后续阶段替代的结论。它们用于审计研究过程，不应覆盖当前机器权威。

`artifacts/` 只保存少量历史输出样本；大体积训练和 benchmark artifact 继续按仓库策略不入 Git。
