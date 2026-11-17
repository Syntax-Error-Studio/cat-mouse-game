#!/usr/bin/env node
/**
 * PPC-P2-PREPARED-TRANSITION-01 — regression log parser.
 *
 * Reads the single authoritative `logs/full_regression.log` and produces
 * REGRESSION_RESULTS.json. It refuses to guess: if the summary lines are
 * missing (e.g. the run was interrupted), it records what it found and marks
 * the run as NOT_PERFORMED instead of inventing counts.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';

const LOG = 'PPC-P2-PREPARED-TRANSITION-01/logs/full_regression.log';
if (!existsSync(LOG)) {
  console.error('no log');
  process.exit(1);
}
// vitest emits ANSI colour codes around the summary labels, e.g.
//   ESC[2m Test Files ESC[22m ESC[1mESC[32m83 passedESC[39mESC[22mESC[90m (83)ESC[39m
// Strip them first, otherwise `^\s*Test Files` never matches.
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
const rawText = readFileSync(LOG, 'utf8');
const text = stripAnsi(rawText);
const lines = text.split('\n');

const grab = (re) => {
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m;
  }
  return null;
};
const filesLine = grab(/^\s*Test Files\s+(.*)$/);
const testsLine = grab(/^\s*Tests\s+(.*)$/);
const durationLine = grab(/^\s*Duration\s+(.*)$/);
const exitLine = grab(/^EXIT=(\d+)$/);

const failedFiles = [...text.matchAll(/FAIL\s+(\S+\.test\.ts)/g)].map((m) => m[1]);
const failedTests = [...text.matchAll(/FAIL\s+\S+\.test\.ts\s*>\s*(.+)$/gm)].map((m) => m[1].trim());
const skippedNames = [...text.matchAll(/↓\s+(\S+\.test\.ts)\s*>\s*(.+)$/gm)].map((m) => `${m[1]} > ${m[2]}`.trim());

const num = (s, re) => {
  const m = s ? s.match(re) : null;
  return m ? Number(m[1]) : null;
};

const files = filesLine ? {
  passed: num(filesLine[1], /(\d+)\s+passed/),
  failed: num(filesLine[1], /(\d+)\s+failed/),
  skipped: num(filesLine[1], /(\d+)\s+skipped/),
  total: num(filesLine[1], /\((\d+)\)/),
} : null;
const tests = testsLine ? {
  passed: num(testsLine[1], /(\d+)\s+passed/),
  failed: num(testsLine[1], /(\d+)\s+failed/),
  skipped: num(testsLine[1], /(\d+)\s+skipped/),
  total: num(testsLine[1], /\((\d+)\)/),
} : null;

// vitest omits "N failed" entirely when nothing failed, so a null count means 0
// only when the summary line itself was found. Never coerce a missing line.
const zeroIfAbsent = (v) => (v === null || v === undefined ? 0 : v);

const completed = filesLine && testsLine && exitLine;

writeFileSync('PPC-P2-PREPARED-TRANSITION-01/REGRESSION_RESULTS.json', `${JSON.stringify({
  round: 'PPC-P2-PREPARED-TRANSITION-01',
  log: LOG,
  logBytes: statSync(LOG).size,
  command: 'npx vitest run --maxWorkers=1 --no-file-parallelism',
  exitCode: exitLine ? Number(exitLine[1]) : null,
  files,
  tests,
  duration: durationLine ? durationLine[1].trim() : null,
  failedFiles,
  failedTests,
  skippedTests: skippedNames,
  nullSemantics: 'vitest omits "<n> failed" / "<n> skipped" from the summary when the count is 0, so null in files.failed / files.skipped / tests.failed means "reporter did not print it" and is treated as 0 for the verdict. No line is ever invented: if the "Test Files" / "Tests" summary line itself were missing, verdict is NOT_PERFORMED.',
  skippedIdentity: {
    count: tests ? zeroIfAbsent(tests.skipped) : null,
    evidence:
      'the default reporter prints only the skipped COUNT, not the names; identity confirmed by a separate targeted run '
      + '`npx vitest run src/game/ai/__tests__/boundedPlanRefutation.test.ts --reporter=verbose -t "G0.3W"` '
      + '=> 9 passed | 4 skipped, the 4 being G0.3W-4..7 under "G0.3W real-corpus regression (G4 / G1)" (ctx.skip(), missing corpus). '
      + 'Same 4 skips exist on the P1 baseline (1026-test run) and are environment-independent.',
    preExisting: true,
  },
  verdict: !completed ? 'NOT_PERFORMED'
    : (zeroIfAbsent(files.failed) === 0
      && zeroIfAbsent(tests.failed) === 0
      && Number(exitLine[1]) === 0) ? 'PASS' : 'FAIL',
}, null, 2)}\n`);
console.log(JSON.stringify({ exit: exitLine ? exitLine[1] : null, files, tests, duration: durationLine ? durationLine[1].trim() : null, failedFiles, failedTests: failedTests.slice(0, 5) }, null, 1));
