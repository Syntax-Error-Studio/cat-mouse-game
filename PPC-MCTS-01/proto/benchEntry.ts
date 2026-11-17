/**
 * PPC-MCTS-01 — fresh-process pilot entry.
 *
 * One invocation = one repetition: 24 real-human roots x 3 algorithms = 72
 * search calls, strictly sequential. The process exits after writing its JSONL
 * file; `scripts/runPilot.mjs` starts the next one only after this process has
 * exited (HEAVY_WORKER_CONCURRENCY = 1).
 *
 * Usage:
 *   node bench.mjs --rep 1 --out out/raw/rep-01.jsonl --root <repoRoot>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadRoots, runOneCall, rotatedAlgorithms,
  TOTAL_ROOTS, TOTAL_FRESH_PROCESS_REPETITIONS, HEAVY_WORKER_CONCURRENCY,
} from './harness';
import type { CallRecord } from './harness';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const rep = Number(arg('rep', '1'));
const outRel = arg('out', `PPC-MCTS-01/out/raw/rep-${String(rep).padStart(2, '0')}.jsonl`);
const repoRoot = path.resolve(arg('root', process.cwd()));
const outAbs = path.isAbsolute(outRel) ? outRel : path.join(repoRoot, outRel);

if (!Number.isInteger(rep) || rep < 1 || rep > TOTAL_FRESH_PROCESS_REPETITIONS) {
  throw new Error(`bad --rep ${rep}`);
}
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
fs.writeFileSync(outAbs, '');

const { roots, fixtureSha256 } = loadRoots(repoRoot);
console.log(`PPC-MCTS-01 PILOT`);
console.log(`TOTAL_JOBS=${TOTAL_FRESH_PROCESS_REPETITIONS}`);
console.log(`HEAVY_WORKER_CONCURRENCY=${HEAVY_WORKER_CONCURRENCY}`);
console.log(`CURRENT_JOB=${rep}/${TOTAL_FRESH_PROCESS_REPETITIONS}`);
console.log(`SERIAL_FRESH_REPETITIONS=TRUE`);
console.log(`TOTAL_ROOTS=${TOTAL_ROOTS}`);
console.log(`TOTAL_ALGORITHMS=3`);
console.log(`TOTAL_SEARCH_CALLS=${TOTAL_ROOTS * 3 * TOTAL_FRESH_PROCESS_REPETITIONS}`);
console.log(`FIXTURE_SHA256=${fixtureSha256}`);
console.log(`ALGORITHM_ORDER=${rotatedAlgorithms(rep).join(',')}`);
const tProcess = performance.now();

for (let i = 0; i < roots.length; i++) {
  const root = roots[i];
  const order = rotatedAlgorithms(rep);
  for (const algo of order) {
    const t0 = performance.now();
    let rec: CallRecord;
    try {
      rec = runOneCall(root, rep, algo);
    } catch (e) {
      rec = {
        round: 'PPC-MCTS-01', repetition: rep, algorithm: algo, rootId: root.id,
        provenance: root.provenance, sourceFile: root.file, sourceLine: root.line,
        fixtureSha256: root.fixtureSha256, rootStateKey: root.stateKey, seed: null,
        searchMs: 0, planMs: 0, totalMs: performance.now() - t0,
        withinFullTurnBudget: false, nodes: 0, simulations: null, chanceSamples: 0,
        rootAction: null, rootActionJson: null, rootVisits: 0, rootMeanReward: null,
        rootActions: [], plan: '', planJson: [], planLength: 0, planNonEmpty: false,
        replayOk: false, replayFullTurnConsumed: false, replayEndedTurn: false,
        replayTerminal: false, replayRejectedAt: -1, replayRejectedReason: null,
        replaySteps: [], searchCompleted: null, completedDepth: null,
        searchValue: null, searchMate: null, deadlineFired: null, budgetFired: null,
        mathRandomCalls: 0, error: `${(e as Error).message}\n${(e as Error).stack ?? ''}`,
      };
    }
    fs.appendFileSync(outAbs, JSON.stringify(rec) + '\n');
    console.log(
      `[rep ${rep}] ${i + 1}/${roots.length} ${root.id} ${algo} ` +
      `plan=${rec.plan || '-'} replay=${rec.replayOk ? 'OK' : 'FAIL'} ` +
      `sims=${rec.simulations ?? '-'} nodes=${rec.nodes} ` +
      `chance=${rec.chanceSamples} M1=${rec.searchMs.toFixed(2)} M2=${rec.planMs.toFixed(2)} ` +
      `root=${rec.rootAction ?? '-'}${rec.error ? ` ERROR=${rec.error}` : ''}`,
    );
  }
}

console.log(`REP=${rep} DONE elapsedMs=${(performance.now() - tProcess).toFixed(1)} out=${path.relative(repoRoot, outAbs)}`);
