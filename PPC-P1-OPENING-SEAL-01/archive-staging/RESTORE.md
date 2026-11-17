# PPC-P1-OPENING-SEAL-01 — 候选恢复说明（修正版，取代 OPENING-STACK-01 归档内 `RESTORE.md`）

本文件是**候选源码的唯一权威恢复顺序**。上一轮 `PPC-P1-OPENING-STACK-01-candidate.tar.gz` 里的 `RESTORE.md` 让读者在真实工作树上 `git checkout 48eaac6c`，这会丢弃工作区改动，是错误指令；该归档保持只读、未被覆盖，本文件取代它。

## 0. 三条不可违反的前提

1. **真实工作树只读**。全程不 `git checkout` / `reset` / `clean` / `stash`，不覆盖任何工作区文件。所有恢复动作发生在仓库外的隔离目录。
2. **前两个归档只读**。`PPC-P1-CHECKPOINT-01-candidate.tar.gz` 与 `PPC-P1-OPENING-STACK-01-candidate.tar.gz` 的字节不得改动；恢复完成后必须复核它们的 sha256 与恢复前一致。
3. **不得用 `git apply` 的退出码当成功证明**。本仓库上 `git apply` 曾对相关路径静默输出 `Skipped patch` 并返回 exit 0（什么都没做）。本流程完全不用 `git apply`，只用 `git archive` + `tar` + 逐字节校验。

## 1. 依赖的三个归档

| 归档 | sha256 | 字节 | 角色 |
|---|---|---|---|
| `F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz` | `5cd732828856f2b3cd903cc20c584bbb0fec7906d283ec08415bd2653a9425d5` | 4,051,823 | 24 份源码 + 396 份历史取证（只读） |
| `F:/ppc-checkpoints/PPC-P1-OPENING-STACK-01-candidate.tar.gz` | `a6a7795c4f31533a8127ec9e8594a4974aad019b73f69a1421a5c04930c2d015` | 85,538 | 栈安全修复的 2 份文件 + 该轮取证（只读） |
| `F:/ppc-checkpoints/PPC-P1-OPENING-SEAL-01-candidate.tar.gz` | 见 `CHECKPOINT_MANIFEST.json` 的 `archive.sha256` | 见同处 | 本轮的 1 份重封测试文件 + 封口取证 |

基础提交：`48eaac6c4f3801d351787696ba5876995b64e8d8`（分支 `ppc/p1-id-state-identity-fix`）。本轮与上一轮都**没有** commit，所以基础提交之后的所有候选字节只能来自这三个归档。

## 2. 恢复顺序（严格按此顺序执行）

以下命令在 Git Bash 下执行，`<tmp>` 是仓库外的隔离目录（例如 `F:/ppc-checkpoints/restore-seal-01/run`）。

### 步骤 1 — 用 `git archive` 取出基础提交

```bash
mkdir -p <tmp>/repo
git -C "F:/小猫小鼠" archive --format=tar -o <tmp>/base.tar 48eaac6c4f3801d351787696ba5876995b64e8d8
tar -xf <tmp>/base.tar -C <tmp>/repo
```

`git archive` 只从对象库导出，**不读取也不修改工作树**，也不会创建 `.git`。导出结果是该提交的 493 个跟踪文件；未跟踪的候选文件不在其中，所以才需要后面的三次覆盖。

### 步骤 2 — 覆盖 CHECKPOINT-01 的 `source/`（24 份文件）

```bash
mkdir -p <tmp>/cp01
tar --force-local -xzf "F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz" -C <tmp>/cp01
cp -r <tmp>/cp01/source/. <tmp>/repo/
```

这 24 份 = 13 个被修改的跟踪文件 + 11 个新增（未跟踪）的源/夹具文件，覆盖到 `repo/src/...` 同名路径。

### 步骤 3 — 覆盖 OPENING-STACK-01 的两个源码文件

```bash
mkdir -p <tmp>/os01
tar --force-local -xzf "F:/ppc-checkpoints/PPC-P1-OPENING-STACK-01-candidate.tar.gz" -C <tmp>/os01
cp -r <tmp>/os01/files/src/. <tmp>/repo/src/
```

只取 `files/src/`（该归档的 `files/PPC-P1-OPENING-STACK-01/` 是取证，不属于源码树）：

- `src/game/openingFairness.ts` — 递归 DFS → 显式栈迭代 DFS
- `src/game/__tests__/openingFairnessStackSafety.test.ts` — 该轮捕获的 26 项测试

### 步骤 4 — 覆盖本归档重封的那一份测试文件

```bash
mkdir -p <tmp>/seal01
tar --force-local -xzf "F:/ppc-checkpoints/PPC-P1-OPENING-SEAL-01-candidate.tar.gz" -C <tmp>/seal01
cp -r <tmp>/seal01/files/src/. <tmp>/repo/src/
```

只覆盖 `src/game/__tests__/openingFairnessStackSafety.test.ts`：本轮的确定性种子改造（27 项测试）取代步骤 3 的版本。步骤 3 的写入**必须**先发生，因为本轮只重封这一份文件。

**累计**：24 + 2 + 1 = 27 次写入，落在 26 个不同路径上（测试文件被写两次，后者为准）。

### 步骤 5 — 对 26 个源/夹具逐字节核验

以本归档 `evidence/PPC-P1-OPENING-SEAL-01/SOURCE_MANIFEST.json` 的 `files[]` 为准，对每个 `path` 核验：

- `sha256(文件原始字节)` == `postSha256`
- `字节数` == `bytes`
- 行尾 == `lineEnding`（只有 `src/game/engine.ts` 是 CRLF，其余 LF）

一只读脚本即可，不必人工：

```bash
node <tmp>/seal01/evidence/PPC-P1-OPENING-SEAL-01/probe/verify_restore.mjs \
  "F:/ppc-checkpoints/PPC-P1-OPENING-SEAL-01-candidate.tar.gz" <tmp>
```

该脚本会自己完成步骤 1–6（含隔离目录、覆盖、双向清单核对）并输出 `RESTORE_VERIFICATION.json`。手写校验时注意：**sha256 必须连同行尾声明一起比较**，否则 `engine.ts` 的 CRLF/LF 差异会伪装成分歧。

另有一条正常现象，别当失败：基线里有 3 个文件在工作树是 CRLF、在仓库 blob 是 LF —— `src/game/ai/turnLazy.ts`、`src/game/ai/__tests__/m3MemoryRepair.test.ts`、`src/game/ai/__tests__/planCompletionRepair.test.ts`。它们**不在** 26 个候选文件里，与工作树只有行尾差异；这是本机 `core.autocrlf=true` 的表现，不是恢复出错。

### 步骤 6 — 清单双向核对

对恢复目录做双向集合核对，两项都必须为 0：

- **缺失**：`SOURCE_MANIFEST.files[].path` 中任何一个在 `<tmp>/repo` 里不存在 → 必须为 0
- **多余**：`<tmp>/repo/src/**` 中存在、却既不在基础提交的跟踪文件列表、也不在清单 26 条里的文件 → 必须为 0

期望集合 = `git ls-tree -r --name-only 48eaac6c -- src`（153 个）∪ 清单 26 条。

## 3. 恢复失败的常见原因

| 现象 | 原因 |
|---|---|
| `tar: Cannot connect to F:` | Windows 版 GNU tar 把 `F:/...` 当远端主机，必须加 `--force-local` |
| 清单里某个 `src/game/ai/*.ts` 缺失 | 漏了步骤 2（11 个新增文件不在基础提交里） |
| `openingFairnessStackSafety.test.ts` 哈希不符 | 漏了步骤 4，或步骤 4 早于步骤 3 |
| `engine.ts` 哈希不符 | 用文本模式复制过（行尾被改写）。必须二进制复制 `cp`/`tar` |
| 恢复目录里没有 `.git` | 正常：`git archive` 不带版本库，本流程不需要 `.git` |

## 4. 本归档的自包含性

**不是**离线自包含。本归档只含 1 份重封的测试文件字节 + 封口取证；重建整个候选还需要基础提交 `48eaac6c` 和前两个归档，三者缺一不可。
