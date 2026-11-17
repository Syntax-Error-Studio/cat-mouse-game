/**
 * PPC-MCTS-01B — Phase 1 verification and report.
 *
 * Reads PPC-MCTS-01B/data/phase1-formal/ (rep-NN.jsonl + ENVELOPE.json) and
 * writes:
 *   PPC-MCTS-01B/PHASE1_ANALYSIS/summary.json
 *   PPC-MCTS-01B/PHASE1_ANALYSIS/cells.csv
 *   PPC-MCTS-01B/PHASE1_FINAL_REPORT.md
 *
 * It asserts the pre-registered acceptance table rather than describing it:
 * every cell must report verdict PASS, both arms must show exactly K completed
 * simulations reached by the stop seam, per-simulation digest streams must be
 * identical element by element, and the whole-tree fingerprints must match.
 *
 * Usage: node PPC-MCTS-01B/scripts/analyzePhase1.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const round = resolve(repo, 'PPC-MCTS-01B');
const dataDir = resolve(round, 'data/phase1-formal');
const outDir = resolve(round, 'PHASE1_ANALYSIS');
mkdirSync(outDir, { recursive: true });

const K = 200;
const ROOTS = 24;
const REPS = 20;
const ARMS = 2;
const EXPECTED_CALLS = ROOTS * REPS * ARMS;

const files = existsSync(dataDir) ? readdirSync(dataDir).filter((f) => /^rep-\d\d\.jsonl$/.test(f)).sort() : [];
if (files.length === 0) throw new Error(`no Phase 1 jsonl under ${dataDir}`);

const records = [];
for (const f of files) {
  for (const line of readFileSync(resolve(dataDir, f), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line);
    r.__file = f;
    records.push(r);
  }
}

const envelope = existsSync(resolve(dataDir, 'ENVELOPE.json'))
  ? JSON.parse(readFileSync(resolve(dataDir, 'ENVELOPE.json'), 'utf8'))
  : null;

const failures = [];
const perCell = [];
let armCalls = 0;
let simulations = 0;
let digestComparisons = 0;

for (const r of records) {
  const problems = [];
  if (r.verdict !== 'PASS') problems.push(`verdict=${r.verdict}`);
  if (r.anomaly !== null) problems.push(`anomaly=${r.anomaly}`);
  if (r.digestDiffCount !== 0) problems.push(`digestDiffCount=${r.digestDiffCount}`);
  if (!r.isPhase1Formal) problems.push('isPhase1Formal=false');
  if (r.completedSimulationsPerCall !== K) problems.push(`K=${r.completedSimulationsPerCall}`);

  for (const side of ['baseline', 'prepared']) {
    const a = r.arms[side];
    armCalls++;
    simulations += a.simulations;
    if (a.simulations !== K) problems.push(`${side}.simulations=${a.simulations}`);
    if (a.abortedSimulations !== 0) problems.push(`${side}.aborted=${a.abortedSimulations}`);
    if (a.nodeCapHit) problems.push(`${side}.nodeCapHit`);
    if (a.deadlineHit) problems.push(`${side}.deadlineHit`);
    if (!a.completedSimulationLimitHit) problems.push(`${side}.seamNotReached`);
    if (a.mathRandomDraws !== 0) problems.push(`${side}.mathRandomDraws=${a.mathRandomDraws}`);
    if (a.simulations !== K) problems.push(`${side}.simsShort`);
  }

  const bd = r.simulationDigests.baseline;
  const pd = r.simulationDigests.prepared;
  if (bd.length !== K || pd.length !== K) problems.push(`digestLengths=${bd.length}/${pd.length}`);
  for (let i = 0; i < K; i++) {
    digestComparisons++;
    if (bd[i] !== pd[i]) { problems.push(`sim#${i} digest differs`); break; }
  }
  if (r.comparison.baseline.treeDigest !== r.comparison.prepared.treeDigest) problems.push('treeDigest differs');
  if (r.comparison.baseline.plan !== r.comparison.prepared.plan) problems.push('plan differs');
  if (r.comparison.baseline.planCost !== r.comparison.prepared.planCost) problems.push('planCost differs');
  if (r.comparison.baseline.rootAction !== r.comparison.prepared.rootAction) problems.push('rootAction differs');
  if (r.comparison.baseline.nodesCreated !== r.comparison.prepared.nodesCreated) problems.push('nodesCreated differs');
  if (r.comparison.baseline.chanceSamples !== r.comparison.prepared.chanceSamples) problems.push('chanceSamples differs');
  if (r.comparison.baseline.maxChanceMassError !== r.comparison.prepared.maxChanceMassError) problems.push('maxChanceMassError differs');

  if (problems.length > 0) failures.push({ root: r.root, repetition: r.repetition, problems });

  perCell.push({
    root: r.root, repetition: r.repetition, seed: r.seed,
    verdict: r.verdict,
    simsBaseline: r.arms.baseline.simulations, simsPrepared: r.arms.prepared.simulations,
    nodesBaseline: r.arms.baseline.nodesCreated, nodesPrepared: r.arms.prepared.nodesCreated,
    chanceBaseline: r.arms.baseline.chanceSamples, chancePrepared: r.arms.prepared.chanceSamples,
    ruleCallsBaseline: r.arms.baseline.ruleCalls, ruleCallsPrepared: r.arms.prepared.ruleCalls,
    wallMsBaseline: r.arms.baseline.wallMs, wallMsPrepared: r.arms.prepared.wallMs,
    treeDigest: r.comparison.baseline.treeDigest,
    plan: r.comparison.baseline.plan,
    planCost: r.comparison.baseline.planCost,
    treePlanLength: r.comparison.baseline.treePlanLength,
    extensionSteps: r.comparison.baseline.extensionSteps,
    digestAggregateBaseline: r.simulationDigestAggregate.baseline,
    digestAggregatePrepared: r.simulationDigestAggregate.prepared,
    file: r.__file,
  });
}

const mathRandomDraws = records.reduce((s, r) => s + r.arms.baseline.mathRandomDraws + r.arms.prepared.mathRandomDraws, 0);
const nodeCapHits = records.filter((r) => r.arms.baseline.nodeCapHit || r.arms.prepared.nodeCapHit).length;
const deadlineHits = records.filter((r) => r.arms.baseline.deadlineHit || r.arms.prepared.deadlineHit).length;
const aborted = records.reduce((s, r) => s + r.arms.baseline.abortedSimulations + r.arms.prepared.abortedSimulations, 0);
const uniqueSeedsPerCell = records.every((r) => typeof r.seed === 'string' && r.seed.length > 0);

const acceptance = {
  TOTAL_SEARCH_CALLS: { expected: EXPECTED_CALLS, actual: armCalls, pass: armCalls === EXPECTED_CALLS },
  COMPLETED_SIMULATIONS_PER_CALL: { expected: K, actual: [...new Set(records.flatMap((r) => [r.arms.baseline.simulations, r.arms.prepared.simulations]))], pass: records.every((r) => r.arms.baseline.simulations === K && r.arms.prepared.simulations === K) },
  EXPECTED_TOTAL_SIMULATIONS: { expected: EXPECTED_CALLS * K, actual: simulations, pass: simulations === EXPECTED_CALLS * K },
  ALL_CALLS_COMPLETE: { detail: `${records.length} cells x ${ARMS} arms`, pass: records.length === ROOTS * REPS },
  ALL_SIMULATION_DIGESTS_MATCH: {
    // One comparison per (cell, simulation) compares BOTH arms: 480 cells x 200 = 96 000
    // digest pairs, i.e. 192 000 arm-simulations.
    comparisons: digestComparisons,
    expectedComparisons: ROOTS * REPS * K,
    pass: digestComparisons === ROOTS * REPS * K && records.every((r) => r.digestDiffCount === 0),
  },
  ALL_TREE_FINGERPRINTS_MATCH: { pass: records.every((r) => r.comparison.baseline.treeDigest === r.comparison.prepared.treeDigest) },
  ALL_PLANS_MATCH: { pass: records.every((r) => r.comparison.baseline.plan === r.comparison.prepared.plan && r.comparison.baseline.planCost === r.comparison.prepared.planCost) },
  MATH_RANDOM_DRAWS: { expected: 0, actual: mathRandomDraws, pass: mathRandomDraws === 0 },
  NODE_CAP_HITS: { expected: 0, actual: nodeCapHits, pass: nodeCapHits === 0 },
  DEADLINE_HITS: { expected: 0, actual: deadlineHits, pass: deadlineHits === 0 },
  ABORTED_SIMULATIONS: { expected: 0, actual: aborted, pass: aborted === 0 },
  SEEDS_PRESENT: { pass: uniqueSeedsPerCell },
  NO_FAILURES: { pass: failures.length === 0, failures: failures.slice(0, 10) },
};
const allPass = Object.values(acceptance).every((a) => a.pass === true);

const deterministicFieldsCompared = [
  'simulations', 'nodesCreated', 'nodes created per kind (nodesCreated + chanceNodes)',
  'chanceSamples', 'maxChanceMassError', 'rolloutSteps', 'maxHandoffsReached',
  'treeDigest (whole tree: kind, handoffs, stateKey, visits, total/mean reward, edge keys, CHANCE weights and outcome stateKeys)',
  'per-simulation digest x 200',
  'rootVisits', 'rootTotalReward', 'rootMeanReward',
  'plan', 'planCost', 'planExtended', 'treePlanLength', 'extensionSteps',
  'rootAction', 'rootActionStats (key, transitionKind, visits, meanReward, totalReward, childStateKey)',
  'planTraceDigest', 'mathRandomDraws', 'abortedSimulations', 'postDeadlineNodeCreations',
];

const summary = {
  artefact: 'PHASE1_ANALYSIS',
  generatedAt: new Date().toISOString(),
  inputs: {
    dir: 'PPC-MCTS-01B/data/phase1-formal',
    files,
    sha256: files.map((f) => ({ file: f, sha256: createHash('sha256').update(readFileSync(resolve(dataDir, f))).digest('hex') })),
    envelope: envelope ? {
      verdict: envelope.verdict,
      freshNodeProcessesExecuted: envelope.freshNodeProcessesExecuted,
      totals: envelope.totals,
      wallMs: envelope.wallMs,
    } : null,
  },
  acceptance,
  verdict: allPass ? 'PASS' : 'FAIL',
  comparedFields: deterministicFieldsCompared,
  cells: perCell,
  ruleCalls: {
    baseline: records.reduce((s, r) => s + r.arms.baseline.ruleCalls, 0),
    prepared: records.reduce((s, r) => s + r.arms.prepared.ruleCalls, 0),
  },
  wallMs: {
    baseline: records.reduce((s, r) => s + r.arms.baseline.wallMs, 0),
    prepared: records.reduce((s, r) => s + r.arms.prepared.wallMs, 0),
  },
};
writeFileSync(resolve(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

const csv = ['root,repetition,verdict,sims_baseline,sims_prepared,nodes_baseline,nodes_prepared,chance_baseline,chance_prepared,ruleCalls_baseline,ruleCalls_prepared,wallMs_baseline,wallMs_prepared,treeDigest,plan,planCost']
  .concat(perCell.map((c) => [
    c.root, c.repetition, c.verdict, c.simsBaseline, c.simsPrepared, c.nodesBaseline, c.nodesPrepared,
    c.chanceBaseline, c.chancePrepared, c.ruleCallsBaseline, c.ruleCallsPrepared,
    c.wallMsBaseline.toFixed(1), c.wallMsPrepared.toFixed(1), c.treeDigest, `"${c.plan}"`, c.planCost,
  ].join(',')))
  .join('\n');
writeFileSync(resolve(outDir, 'cells.csv'), `${csv}\n`, 'utf8');

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const tbl = (rowsArr, head) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rowsArr.map((r) => `| ${r.join(' | ')} |`),
].join('\n');

const md = [];
md.push('# Phase 1 — fixed completed-simulation parity (formal envelope)');
md.push('');
md.push(`Generated ${summary.generatedAt}. **Verdict: ${summary.verdict}**`);
md.push('');
md.push('## 1. What was run');
md.push('');
md.push(tbl([
  ['roots', ROOTS, 'the 24 frozen human roots'],
  ['repetitions', REPS, 'one fresh Node process each'],
  ['arms', ARMS, 'UCT-H-BASELINE / UCT-H-PREPARED, both hybrid rollout'],
  ['completed simulations per call', K, 'enforced by the `maxCompletedSimulations` seam between simulations'],
  ['search calls', `${armCalls}/${EXPECTED_CALLS}`, '24 x 20 x 2'],
  ['simulations', `${simulations}/${EXPECTED_CALLS * K}`, 'K x calls'],
  ['fresh processes executed', envelope ? envelope.freshNodeProcessesExecuted : 'n/a', 'serial, previous must exit first'],
  ['envelope wall clock', envelope ? `${(envelope.wallMs / 1000).toFixed(1)} s` : 'n/a', 'single heavy worker'],
], ['item', 'value', 'note']));
md.push('');
md.push('## 2. Acceptance table (pre-registered, asserted not described)');
md.push('');
md.push(tbl(Object.entries(acceptance).map(([k, v]) => [
  k, 'expected' in v ? String(v.expected) : '—',
  'actual' in v ? JSON.stringify(v.actual) : (v.comparisons !== undefined ? `${v.comparisons} comparisons` : '—'),
  v.pass ? '**PASS**' : '**FAIL**',
]), ['gate', 'expected', 'actual', 'result']));
md.push('');
md.push('## 3. What was compared on every cell');
md.push('');
for (const f of deterministicFieldsCompared) md.push(`- ${f}`);
md.push('');
md.push('The stop mechanism is identical on both arms by construction: the same seam at the same place in the simulation loop, so "both arms ran K simulations" is not an assertion about equal work, it is the same control flow.');
md.push('');
md.push('## 4. Per-repetition roll-up');
md.push('');
const reps = [...new Set(perCell.map((c) => c.repetition))].sort((a, b) => a - b);
md.push(tbl(reps.map((rep) => {
  const cs = perCell.filter((c) => c.repetition === rep);
  const rc = (side) => cs.reduce((s, c) => s + (side === 'b' ? c.ruleCallsBaseline : c.ruleCallsPrepared), 0);
  const wm = (side) => cs.reduce((s, c) => s + (side === 'b' ? c.wallMsBaseline : c.wallMsPrepared), 0);
  return [rep, cs.length, cs.filter((c) => c.verdict === 'PASS').length, rc('b'), rc('p'), (wm('b') / 1000).toFixed(1), (wm('p') / 1000).toFixed(1)];
}), ['rep', 'cells', 'PASS', 'ruleCalls baseline', 'ruleCalls prepared', 'wall s baseline', 'wall s prepared']));
md.push('');
md.push('## 5. Rule calls — a cost observation, not a correctness claim');
md.push('');
const rcB = summary.ruleCalls.baseline;
const rcP = summary.ruleCalls.prepared;
md.push(`- baseline: **${rcB.toLocaleString('en-US')}** rule-internal calls`);
md.push(`- prepared: **${rcP.toLocaleString('en-US')}** rule-internal calls`);
md.push(`- reduction: **${(100 * (1 - rcP / rcB)).toFixed(2)}%**`);
md.push('');
md.push('Wall clock is reported but is NOT a result here: Phase 1 freezes the clock (`now() => 0`) precisely so that the number of simulations, not the wall clock, decides when work stops.');
md.push('');
md.push('## 6. Files');
md.push('');
md.push(tbl([
  ['`PHASE1_ANALYSIS/summary.json`', 'acceptance table, per-cell table, input digests'],
  ['`PHASE1_ANALYSIS/cells.csv`', 'one row per (root, repetition) for spreadsheet review'],
  ['`data/phase1-formal/rep-NN.jsonl`', 'raw records, appended, never truncated'],
  ['`data/phase1-formal/rep-NN.summary.json`', 'per-repetition summary'],
  ['`data/phase1-formal/ENVELOPE.json`', 'per-process exit codes, wall times, per-rep validation'],
], ['file', 'content']));
md.push('');
writeFileSync(resolve(round, 'PHASE1_FINAL_REPORT.md'), `${md.join('\n')}\n`, 'utf8');

console.log(`cells=${perCell.length} armCalls=${armCalls} simulations=${simulations} digestComparisons=${digestComparisons}`);
console.log(`mathRandomDraws=${mathRandomDraws} nodeCapHits=${nodeCapHits} deadlineHits=${deadlineHits} aborted=${aborted}`);
console.log(`failures=${failures.length}`);
console.log(`PHASE1_VERDICT=${summary.verdict}`);
for (const [k, v] of Object.entries(acceptance)) if (!v.pass) console.log(`  FAIL ${k}: ${JSON.stringify(v)}`);
