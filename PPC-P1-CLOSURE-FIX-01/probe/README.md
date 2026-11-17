# probe/

本轮**没有新增探针**。

四项修复都不需要新的取证脚本：

- 猫步数输入域 —— 直接写成正式测试 `src/game/__tests__/catMoveBudgetInputDomain.test.ts`（13 项），不留在 `probe/`；
- T1E-B —— 复用 PPC-P1-CLOSURE-01 建立的冻结对照臂结论，本轮只在同一份日志里补测了预算放宽后的耗时；
- FLT-HV14-4 —— 复用的五支探针全部在上一轮目录里，本轮只做了一次只读组装（生成 `HV14_REPRODUCTION_GAP.json`）：

| 探针 | 位置 | 作用 |
|---|---|---|
| `hv14_t4_probe.test.ts` | `PPC-P1-CLOSURE-01/probe/` | 日志值 vs 当前值、深度 1–4 扫描 |
| `hv14_t4_planner.test.ts` | 同上 | 当前生产规划器在该根的实际产出 + 真实引擎重放 |
| `hv14_t4_winsearch.test.ts` | 同上 | 真实引擎 & 模拟器双路穷举 212 条序列 |
| `hv14_t4_terminal.test.ts` | 同上 | 独立于判负内核的"鼠四向走不动"验证 |
| `hv14_all_roots.test.ts` | 同上 | 45 根不中止复算 |

原始测量 JSON 也在 `PPC-P1-CLOSURE-01/_raw/`。本轮没有重跑这些探针——它们的输入（HV14 日志、规则、搜索配置）本轮没有任何改动，重跑只会重复同一组数字。
