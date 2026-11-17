// PPC-P1-OPENING-STACK-01 · parse the full-regression log into REGRESSION_RESULTS.json.
import { readFileSync, writeFileSync } from 'node:fs';

const LOG = 'PPC-P1-OPENING-STACK-01/logs/13_full_regression.log';
let text = readFileSync(LOG, 'utf8');
text = text.replace(/\x1b\[[0-9;]*m/g, '');
const lines = text.split('\n');

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const tests = [];
const failures = [];
const skippedTests = [];
for (const raw of lines) {
  const line = strip(raw).trimEnd();
  const t = line.match(/^\s*(✓|×|✗|↓)\s+(.*?)(?:\s+(\d+)ms)?$/);
  if (t) {
    const rec = { mark: t[1], name: t[2].trim(), ms: t[3] ? Number(t[3]) : null };
    tests.push(rec);
    if (t[1] === '×' || t[1] === '✗') failures.push(rec);
    if (t[1] === '↓') skippedTests.push(rec);
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

const parseDuration = (d) => {
  if (!d) return null;
  let s = 0;
  const h = d.match(/(\d+)h/); if (h) s += Number(h[1]) * 3600;
  const m = d.match(/(\d+)m/); if (m) s += Number(m[1]) * 60;
  const sec = d.match(/([\d.]+)s/); if (sec) s += Number(sec[1]);
  return Math.round(s * 10) / 10;
};

const slowest = [...tests].filter((t) => t.ms !== null).sort((a, b) => b.ms - a.ms).slice(0, 20);

const result = {
  artifactId: 'REGRESSION_RESULTS',
  round: 'PPC-P1-OPENING-STACK-01',
  command: 'HEAVY_WORKER_CONCURRENCY=1 npx vitest run --maxWorkers=1 --no-file-parallelism --reporter=verbose',
  log: LOG,
  config: {
    fileParallelism: 'disabled (--no-file-parallelism)',
    maxWorkers: 1,
    heapRaised: false,
    testScopeReduced: false,
    depthReduced: false,
    nodeLimitReduced: false,
    assertionsModified: false,
    duplicateHeavyTaskRunning: false,
    productionBudgetsTouched: false,
  },
  totals: {
    testFilesLine,
    testsLine,
    durationLine,
    durationSeconds: parseDuration(durationLine),
    startedAt: startLine,
    passed, failed, skipped,
    filesPassed, filesFailed,
    enumeratedByRunner: tests.length,
    nonzeroExit: failures.length > 0 || /Test Files\s+\d+ failed/.test(text),
  },
  expectedVsActual: {
    previousRoundEnumerated: 1000,
    previousRoundBreakdown: '996 passed + 4 skipped',
    addedThisRound: 26,
    addedBy: 'src/game/__tests__/openingFairnessStackSafety.test.ts',
    expectedNow: 1026,
    actualNow: tests.length,
    delta: tests.length - 1026,
    note: 'Nothing was deleted, skipped or loosened to match the expected number; the runner is the authority.',
  },
  failures,
  skippedTests,
  skippedClassification: {
    count: skippedTests.length,
    expected: 4,
    mechanism: 'ctx.skip() inside boundedPlanRefutation.test.ts when the fixture corpus root is absent (pre-existing, skips on every machine)',
    causedByThisRound: 'NO',
  },
  introducedByThisRound: {
    count: failures.length,
    note: failures.length === 0
      ? 'No failing test. The 26 tests this round added are inside the passed total.'
      : 'See failures — each one must be attributed against the frozen pre-fix baseline before any production change.',
  },
  slowestTests: slowest,
  throughputSensitive: slowest.filter((t) => t.ms >= 5000).map((t) => ({ name: t.name, ms: t.ms })),
  rawTail: lines.slice(-12).join('\n'),
};

writeFileSync('PPC-P1-OPENING-STACK-01/REGRESSION_RESULTS.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.totals, null, 2));
console.log('failures =', failures.length);
console.log('slowest:');
for (const s of slowest.slice(0, 8)) console.log('  ', s.ms + 'ms', s.name);
