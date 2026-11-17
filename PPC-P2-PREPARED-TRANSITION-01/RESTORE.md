# RESTORE — 如何在仓库外精确重建本轮候选

本轮：`PPC-P2-PREPARED-TRANSITION-01` ｜ HEAD：`48eaac6c4f3801d351787696ba5876995b64e8d8`（未提交、未推送）

归档：`F:/ppc-checkpoints/PPC-P2-PREPARED-TRANSITION-01-candidate.tar.gz`
成员清单 + 逐文件 sha256/字节：归档内 `ARCHIVE_MANIFEST.json`
验证结果：`RESTORE_VERIFICATION.json`（由 `probe/verify_restore.mjs` 生成）

---

## 0. 三句话

1. **本归档不是自包含的。**它只装"本轮动过的 4 个文件 + 全部证据"，其余 161 个未触碰文件来自
   `git 48eaac6c`，冻结对照臂来自 `BASELINE_MANIFEST.json`。
2. **绝不要用 `git apply` / `git checkout` 复原。**本仓库 `core.autocrlf=true`，`git diff` 是 LF 归一补丁，
   直接 apply 会得到"内容同、字节不同"的文件（本仓库历史上多次静默 `Skipped patch` 且 exit 0）。
3. 复原一律：`git archive` 拿干净树 → 按轮次**逐层覆盖** `files/src/` → 逐文件比 sha256 **和字节数**。

---

## 1. 重建冻结基线（本轮 A 臂 = P1 全部修复在位的工作树）

工作目录建议放仓库外（例如 `$TEMP/ppc-p2-restore/`）。

```bash
BASE=$(mktemp -d)/baseline
mkdir -p "$BASE"

# (1) HEAD 的干净树（注意关掉 autocrlf，否则 CRLF 成员会对不上）
git -c core.autocrlf=false archive 48eaac6c | tar -x -C "$BASE"

# (2) P1-CHECKPOINT-01：24 个源文件（含 expectiminimax.ts 的封口字节）
tar -xzf "F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz" --force-local \
    -C "$BASE" --strip-components=2 ./checkpoint/source/ 2>/dev/null \
  || tar -xzf "F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz" --force-local -C "$BASE"

# (3) P1-OPENING-STACK-01：2 个源文件（openingFairness.ts + 其测试）
tar -xzf "F:/ppc-checkpoints/PPC-P1-OPENING-STACK-01-candidate.tar.gz" --force-local \
    -C "$BASE" ./files/src/ --strip-components=2

# (4) P1-OPENING-SEAL-01：1 个源文件（openingFairnessStackSafety.test.ts 的封口版）
tar -xzf "F:/ppc-checkpoints/PPC-P1-OPENING-SEAL-01-candidate.tar.gz" --force-local \
    -C "$BASE" ./files/src/ --strip-components=2
```

> 覆盖顺序不可交换：(2) 的 `checkpoint/source` 覆盖 HEAD，(3)(4) 再覆盖 (2)。反过来会把 P1 修复冲掉。
> 仓库内也可直接用已解包的副本：`PPC-P1-CHECKPOINT-01/checkpoint/source/`（24 文件）、
> `PPC-P1-OPENING-SEAL-01/archive-staging/files/src/`（1 文件）；STACK 的 2 个文件只在它自己的 tar 里。

**验收（26 文件逐字节）**：拿 `PPC-P1-OPENING-SEAL-01/SOURCE_MANIFEST.json` 的 `files[]`（26 条），
对 `$BASE` 下同名文件逐个比 `sha256` + `bytes` + 行尾，必须 26/26 相同。行尾说明见 §4。

---

## 2. 重建本轮候选（B 臂）

```bash
CAND=$(mktemp -d)/candidate
cp -r "$BASE" "$CAND"
tar -xzf "F:/ppc-checkpoints/PPC-P2-PREPARED-TRANSITION-01-candidate.tar.gz" --force-local \
    -C "$CAND" ./files/src/ --strip-components=2
```

这就得到 4 个文件：`preparedActions.ts`（新增）、`legalActions.ts`、`expectiminimax.ts`、
`__tests__/preparedTransition.test.ts`（新增）。

**验收（4 文件逐字节）**：与归档内 `SOURCE_MANIFEST.json` 的 `post.sha256` 比：

| 文件 | sha256 | 字节 | 行尾 |
|---|---|---|---|
| `src/game/ai/preparedActions.ts` | `67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764` | 5 405 | LF |
| `src/game/ai/legalActions.ts` | `27ae2f468d19043425326c2fc42923aeae894a5f84d2e0684ee374808b50eb22` | 2 368 | LF |
| `src/game/ai/expectiminimax.ts` | `50d27da5e9d0d47a1ad70efb542a3ec1510507fd14b825a52729ebb90f6d690c` | 109 353 | LF |
| `src/game/ai/__tests__/preparedTransition.test.ts` | 见 `SOURCE_MANIFEST.json` | — | LF |

---

## 3. 重建冻结对照臂（A/B 实验的 A 臂 = `arm/src`）

`arm/` 是 6 MB 的 `src` 副本，**故意不进归档**（可由清单精确重建，装进去只是把证据体积翻倍）。
重建方法见 `BASELINE_MANIFEST.json` 的 `arm` 段：

- `base.files[]`：165 条，每条 `rel` + `sha256`；
- `base.arm.differing[]`：本轮真正不同的 2 条 ——
  - `game/ai/expectiminimax.ts` → 取自 `PPC-P1-CHECKPOINT-01/checkpoint/source/src/game/ai/expectiminimax.ts`（= `8ac26985…`，封口字节）
  - `game/ai/legalActions.ts` → 取自 `git show HEAD:src/game/ai/legalActions.ts`
- `base.arm.onlyInSrc[]`：只在候选侧存在的 1 个文件（`game/ai/preparedActions.ts`，A 臂无此文件）。

`verify_restore.mjs` 就是按这个规则把 165 条**全部**解出来（165/165 resolved = 0 unresolved），
其中 163 条直接对当前 `src/<rel>` 的 sha256。

---

## 4. 行尾（本仓库最容易踩的坑）

`core.autocrlf=true`。同一份内容在本仓库可以有两个合法 sha256：

| 形态 | 何时出现 |
|---|---|
| LF | `git show` / `git archive` / 本归档 `files/src/` / `SOURCE_MANIFEST.post` |
| CRLF | 工作树里被 checkout 过的文件（如 `engine.ts`、部分测试文件） |

因此**任何 sha256 断言必须声明行尾**。本轮 3 个改动的生产文件最终都是 **LF**，与归档一致，
与工作树也一致（工作树本来就是 LF）；但 `legalActions.ts` 修复前的工作树副本是 CRLF，
所以 `SOURCE_MANIFEST.json` 同时记了 `sha256Lf` 与 `sha256WorktreeCrlf` 两个值——这不是矛盾，是两件事。

---

## 5. 一键验证

```bash
node PPC-P2-PREPARED-TRANSITION-01/probe/verify_restore.mjs
```

它做四件事，任一不满足即 `verdict: FAIL`：

1. 把归档解到**仓库外**的 `mkdtemp`（不会污染工作树）；
2. 对 `ARCHIVE_MANIFEST.json` 的双向清单：`missing == 0 && extra == 0`，逐成员 `sha256` + `bytes`；
3. 归档内 4 个源文件与**当前工作树**逐字节相同（证明归档真的装的是候选，不是别的版本）；
4. 按 §3 规则重建 165 个对照臂文件并全部解析。

Windows 两个硬坑已在脚本里处理：GNU tar 对 `F:/...` 会当远端主机，必须 `--force-local`；
`path.join` 产反斜杠，传 tar 前 `.replace(/\\/g,'/')`。
