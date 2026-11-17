// PPC-P1-CHECKPOINT-01 · parse the full-regression log into REGRESSION_RESULTS.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const LOG = 'PPC-P1-CHECKPOINT-01/logs/09_full_regression.log';
let text = readFileSync(LOG, 'utf8');
text = text.replace(/\x1b\[[0-9;]*m/g, '');
const lines = text.split('\n');

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const tests = [];
const failures = [];
let current = null;
for (const raw of lines) {
  const line = strip(raw).trimEnd();
  const t = line.match(/^\s*(✓|×|✗|↓)\s+(.*?)(?:\s+(\d+)ms)?$/);
  if (t) {
    current = { mark: t[1], name: t[2].trim(), ms: t[3] ? Number(t[3]) : null };
    tests.push(current);
    if (t[1] === '×' || t[1] === '✗') failures.push(current);
  }
}

const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
const testFilesLine = grab(/Test Files\s+(.+)/);
const testsLine = grab(/^\s*Tests\s+(.+)/m);
const durationLine = grab(/Duration\s+(.+)/);
const startLine = grab(/Start at\s+(.+)/);

const num = (s, word) => {
  if (!s) return null;
  const m = s.match(new RegExp(`(\\d+)\\s+${word}`));
  return m ? Number(m[1]) : null;
};

const passed = num(testsLine, 'passed');
const failed = num(testsLine, 'failed');
const skipped = num(testsLine, 'skipped');
const filesPassed = num(testFilesLine, 'passed');
const filesFailed = num(testFilesLine, 'failed');

const slowest = [...tests].filter((t) => t.ms !== null).sort((a, b) => b.ms - a.ms).slice(0, 15);

const result = {
  artifactId: 'REGRESSION_RESULTS',
  round: 'PPC-P1-CHECKPOINT-01',
  command: 'HEAVY_WORKER_CONCURRENCY=1 npx vitest run --maxWorkers=1 --no-file-parallelism --reporter=verbose',
  log: LOG,
  config: {
    globalTestTimeoutMs: 30000,
    fileParallelism: 'disabled (--no-file-parallelism)',
    maxWorkers: 1,
    heapRaised: false,
    testScopeReduced: false,
    depthReduced: false,
    nodeLimitReduced: false,
    assertionsModified: false,
    duplicateHeavyTaskRunning: false,
  },
  totals: {
    testFilesLine,
    testsLine,
    durationLine,
    startedAt: startLine,
    passed, failed, skipped,
    filesPassed, filesFailed,
    enumeratedByRunner: tests.length,
    nonzeroExit: failures.length > 0 || /Test Files\s+\d+ failed/.test(text),
  },
  failures,
  slowestTests: slowest,
  throughputSensitive: slowest.filter((t) => t.ms >= 5000).map((t) => t.name),
  rawTail: lines.slice(-12).join('\n'),
};
writeFileSync('PPC-P1-CHECKPOINT-01/REGRESSION_RESULTS.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.totals, null, 2));
console.log('failures =', failures.length);
console.log('slowest:'); for (const s of slowest.slice(0, 6)) console.log('  ', s.ms + 'ms', s.name);
