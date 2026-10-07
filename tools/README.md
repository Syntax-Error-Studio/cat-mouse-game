# Research Tools

`research-archive/` 保存历史 benchmark、forensics 与研究脚本。它们用于追溯实验过程，不是生产运行入口；部分脚本需要显式传入历史 snapshot/log 文件。

重型实验默认遵守：

- `HEAVY_WORKER_CONCURRENCY=1`
- fresh-process repetitions 串行执行
- 启动前检查重复任务
- 不通过提高并发或扩大内存掩盖算法问题

产品侧常规辅助脚本仍位于仓库根目录的 `scripts/`。
