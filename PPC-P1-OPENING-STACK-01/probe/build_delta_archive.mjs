/**
 * PPC-P1-OPENING-STACK-01 — versioned incremental archive builder.
 *
 * Produces a NEW archive next to (never over) the CHECKPOINT-01 one. It holds
 * the actual bytes of every file this round touched, plus the pre/post git
 * snapshots and a restore note, so the candidate can be rebuilt on top of the
 * base commit without touching the old checkpoint.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';


const ROUND = 'PPC-P1-OPENING-STACK-01';
const STAGE = path.join(ROUND, 'archive-staging');
const OUT_DIR = 'F:/ppc-checkpoints'; // POSIX separators: tar reads 'F:////' as a remote host
const OUT = path.join(OUT_DIR, `${ROUND}-candidate.tar.gz`);

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const MEMBERS = [
  { repo: 'src/game/openingFairness.ts', kind: 'production-changed' },
  { repo: 'src/game/__tests__/openingFairnessStackSafety.test.ts', kind: 'test-new' },
  { repo: `${ROUND}/REPORT.md`, kind: 'report' },
  { repo: `${ROUND}/BASELINE_FAILURE_WITNESS.json`, kind: 'evidence' },
  { repo: `${ROUND}/ITERATIVE_SOLVER_DESIGN.md`, kind: 'design' },
  { repo: `${ROUND}/SEMANTIC_PARITY_RESULTS.json`, kind: 'evidence' },
  { repo: `${ROUND}/DEEP_STACK_RESULTS.json`, kind: 'evidence' },
  { repo: `${ROUND}/REGRESSION_RESULTS.json`, kind: 'evidence' },
  { repo: `${ROUND}/SOURCE_MANIFEST.json`, kind: 'evidence' },
  { repo: `${ROUND}/_raw/pre_fix/sha256_pre.txt`, kind: 'snapshot' },
  { repo: `${ROUND}/_raw/pre_fix/status_pre.txt`, kind: 'snapshot' },
  { repo: `${ROUND}/_raw/pre_fix/tracked.diff.bin`, kind: 'snapshot' },
  { repo: `${ROUND}/_raw/parity_pre.json`, kind: 'raw' },
  { repo: `${ROUND}/_raw/parity_post.json`, kind: 'raw' },
  { repo: `${ROUND}/_raw/parity_pre_run1.json`, kind: 'raw' },
  { repo: `${ROUND}/_raw/baseline_witness_pre.json`, kind: 'raw' },
  { repo: `${ROUND}/_raw/baseline_witness_post.json`, kind: 'raw' },
  { repo: `${ROUND}/_raw/stack_threshold_pre.json`, kind: 'raw' },
  { repo: `${ROUND}/_raw/stack_threshold_post.json`, kind: 'raw' },
  { repo: `${ROUND}/probe/baseline_witness.test.ts`, kind: 'probe' },
  { repo: `${ROUND}/probe/stack_threshold.test.ts`, kind: 'probe' },
  { repo: `${ROUND}/probe/parity_capture.test.ts`, kind: 'probe' },
  { repo: `${ROUND}/probe/semantic_gates.test.ts`, kind: 'probe' },
  { repo: `${ROUND}/probe/compare_parity.mjs`, kind: 'probe' },
  { repo: `${ROUND}/probe/assemble_results.mjs`, kind: 'probe' },
  { repo: `${ROUND}/probe/build_source_manifest.mjs`, kind: 'probe' },
  { repo: `${ROUND}/probe/build_delta_archive.mjs`, kind: 'probe' },
  { repo: `${ROUND}/probe/verify_restore.mjs`, kind: 'probe' },
  { repo: `${ROUND}/probe/vitest.config.mts`, kind: 'probe' },
];

const missing = MEMBERS.filter((m) => !existsSync(m.repo));
if (missing.length) {
  console.error('MISSING BEFORE ARCHIVE: ' + missing.map((m) => m.repo).join(', '));
  process.exit(1);
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const entries = [];
for (const m of MEMBERS) {
  const dest = path.join(STAGE, 'files', m.repo);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(m.repo, dest);
  const buf = readFileSync(dest);
  let crlf = 0, lf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) crlf++;
    else if (buf[i] === 10 && buf[i - 1] !== 13) lf++;
  }
  entries.push({
    repoPath: m.repo,
    archivePath: path.posix.join('files', m.repo),
    kind: m.kind,
    sha256: sha256(dest),
    bytes: buf.length,
    lineEnding: crlf > 0 && lf === 0 ? 'CRLF' : crlf === 0 ? 'LF' : 'MIXED',
  });
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const baseSha = JSON.parse(readFileSync(`${ROUND}/SOURCE_MANIFEST.json`, 'utf8')).files
  .find((f) => f.path === 'src/game/openingFairness.ts').preRoundSha256;

writeFileSync(path.join(STAGE, 'RESTORE.md'), `# ${ROUND} — 增量归档恢复说明

本归档**不是**离线自包含的候选快照。它只包含本轮实际改动的文件字节 + 取证。

## 依赖的基线

- 基础 commit：\`${head}\`（与 PPC-P1-CHECKPOINT-01 相同，本轮未 commit）
- 完整前序候选：\`F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz\`（未修改）
- 本轮改动的两个文件之外的源码，全部与 CHECKPOINT-01 归档逐字节一致

## 恢复步骤

1. 在仓库外新建临时目录，解包本归档：
   \`tar -xzf ${ROUND}-candidate.tar.gz -C <tmp>\`
2. 以 \`${head}\` 为基线检出仓库（或在已有工作树上操作）：
   \`git checkout ${head}\`（**会丢弃工作区改动，先备份**）
3. 覆盖本归档 \`files/\` 下的路径到仓库同名路径：
   \`cp -r <tmp>/files/* <repo>/\`
4. 逐文件核对 \`CHECKPOINT_MANIFEST\` 中的 sha256 / bytes / 行尾。
   注意：**不要**用 \`git apply\` 的退出码当作成功证明（本仓库上它曾静默 Skipped 且 exit 0）。

## 本轮两个改动文件

| 路径 | 行尾 | 说明 |
|---|---|---|
| \`src/game/openingFairness.ts\` | LF | 递归 DFS → 显式栈迭代 DFS（+284/−103） |
| \`src/game/__tests__/openingFairnessStackSafety.test.ts\` | LF | 新增 26 项：栈安全 / 语义门 / 固定 parity 计数 |

openingFairness.ts 修复前 sha256 = \`${baseSha}\`（29272 B / 723 行，LF），修复后见清单。
`);

const manifest = {
  artifactId: 'OPENING_STACK_DELTA_ARCHIVE_MANIFEST',
  round: ROUND,
  base: { commit: head, previousArchive: 'F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz', previousArchiveOverwritten: false },
  selfContained: false,
  selfContainedNote: 'Only this round\'s changed bytes + evidence. Rebuilding the whole candidate needs the base commit and the CHECKPOINT-01 archive.',
  members: entries,
  totals: {
    files: entries.length,
    bytes: entries.reduce((a, e) => a + e.bytes, 0),
    CRLF: entries.filter((e) => e.lineEnding === 'CRLF').length,
    LF: entries.filter((e) => e.lineEnding === 'LF').length,
  },
};
writeFileSync(path.join(STAGE, 'CHECKPOINT_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

mkdirSync(OUT_DIR, { recursive: true });
// tar on Windows treats a backslash path (`F:\...`) as host:path — pass POSIX form.
execFileSync('tar', ['--force-local', '-czf', OUT.replace(/\\/g, '/'), '-C', STAGE.replace(/\\/g, '/'), '.'], { stdio: 'inherit' });

console.log('staged files=' + entries.length + ' bytes=' + manifest.totals.bytes + ' (CRLF ' + manifest.totals.CRLF + ' / LF ' + manifest.totals.LF + ')');
console.log('archive=' + OUT + ' bytes=' + statSync(OUT).size + ' sha256=' + sha256(OUT));
