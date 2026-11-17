/**
 * PPC-MCTS-01 — pilot aggregation.
 *
 * Reads the 20 fresh-process JSONL files and produces:
 *   data/per-root.json   per root x algorithm aggregates
 *   data/summary.json    global stats + paired comparisons
 *   data/summary.csv     flat per-root/algorithm table
 *
 * The 24 roots are the historical REAL-HUMAN-REPLAY development set. This is
 * NOT a formal win-rate experiment and the output says so explicitly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const roundDir = path.join(here, '..');
const rawDir = path.join(roundDir, 'out', 'raw');
const dataDir = path.join(roundDir, 'data');
const logsDir = path.join(roundDir, 'logs');
fs.mkdirSync(dataDir, { recursive: true });

const REPS = 20;
const ROOTS = 24;
const ALGOS = ['RACE', 'UCT-R', 'UCT-H'];
const CALLS = 1440;
const FULL_BUDGET_MS = 150;
const allowPartial = process.argv.includes('--allow-partial');

function pad(n) { return String(n).padStart(2, '0'); }

function readAll() {
  const missing = [];
  const records = [];
  for (let rep = 1; rep <= REPS; rep++) {
    const file = path.join(rawDir, `rep-${pad(rep)}.jsonl`);
    if (!fs.existsSync(file)) { missing.push(file); continue; }
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const r = JSON.parse(line);
      if (r.repetition !== rep) throw new Error(`${file}: repetition mismatch ${r.repetition} != ${rep}`);
      records.push(r);
    }
  }
  if (missing.length > 0 && !allowPartial) {
    throw new Error(`missing ${missing.length} repetition file(s): ${missing.map((f) => path.basename(f)).join(', ')}`);
  }
  return records;
}

function checkRecords(records) {
  const errors = [];
  if (records.length !== CALLS) errors.push(`record count ${records.length} != ${CALLS}`);
  const byKey = new Map();
  for (const r of records) {
    const k = `${r.repetition}|${r.rootId}|${r.algorithm}`;
    if (byKey.has(k)) errors.push(`duplicate ${k}`);
    byKey.set(k, r);
    if (r.error) errors.push(`${k}: error=${r.error}`);
    if (r.mathRandomCalls !== 0) errors.push(`${k}: Math.random calls=${r.mathRandomCalls}`);
    if (!r.replayOk) errors.push(`${k}: replay failed at ${r.replayRejectedAt} (${r.replayRejectedReason})`);
    if (!r.withinFullTurnBudget) errors.push(`${k}: total ${r.totalMs.toFixed(1)}ms > ${FULL_BUDGET_MS}ms`);
  }
  return { errors, byKey };
}

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, mean: null, min: null, p50: null, p95: null, p99: null, max: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, mean, min: v[0], p50: pct(v, 0.5), p95: pct(v, 0.95), p99: pct(v, 0.99), max: v[v.length - 1] };
}

function round(x, d = 6) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function scaleStats(s) {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'n' ? v : round(v, 3)]));
}

function modeOf(labels) {
  const counts = new Map();
  for (const x of labels) if (x !== null && x !== undefined) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = null;
  let bestN = -1;
  for (const [k, n] of [...counts.entries()].sort((a, b) => (a[1] === b[1] ? String(a[0]).localeCompare(String(b[0])) : b[1] - a[1]))) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return { mode: best, count: bestN < 0 ? 0 : bestN, distinct: counts.size, counts: Object.fromEntries([...counts.entries()].sort()) };
}

function aggregateActionDetails(records) {
  const map = new Map();
  for (const r of records) {
    for (const a of r.rootActions ?? []) {
      const k = a.action;
      const cur = map.get(k) ?? { action: k, reps: 0, visits: 0, visitsN: 0, value: 0, valueN: 0, transitionKinds: new Set() };
      cur.reps++;
      if (typeof a.visits === 'number') { cur.visits += a.visits; cur.visitsN++; }
      const v = typeof a.value === 'number' ? a.value : a.meanReward;
      if (typeof v === 'number' && Number.isFinite(v)) { cur.value += v; cur.valueN++; }
      if (a.transitionKind) cur.transitionKinds.add(a.transitionKind);
      map.set(k, cur);
    }
  }
  return [...map.values()]
    .map((x) => ({
      action: x.action,
      reps: x.reps,
      meanVisits: x.visitsN ? round(x.visits / x.visitsN, 3) : null,
      meanValue: x.valueN ? round(x.value / x.valueN, 6) : null,
      transitionKinds: [...x.transitionKinds].sort(),
    }))
    .sort((a, b) => (b.meanVisits ?? -1) - (a.meanVisits ?? -1) || a.action.localeCompare(b.action));
}

function perRoot(records) {
  const roots = [...new Set(records.map((r) => r.rootId))].sort();
  const out = [];
  for (const rootId of roots) {
    const rootRecs = records.filter((r) => r.rootId === rootId);
    const fixtureSha = rootRecs[0]?.fixtureSha256 ?? null;
    for (const algo of ALGOS) {
      const rs = rootRecs.filter((r) => r.algorithm === algo);
      const rootActions = rs.map((r) => r.rootAction);
      const plans = rs.map((r) => r.plan);
      const ra = modeOf(rootActions);
      const pa = modeOf(plans);
      out.push({
        rootId,
        algorithm: algo,
        fixtureSha256: fixtureSha,
        provenance: rs[0]?.provenance ?? null,
        repetitions: rs.length,
        rootActionMode: ra.mode,
        rootActionModeCount: ra.count,
        rootActionRepetitionRate: rs.length ? round(ra.count / rs.length, 4) : null,
        rootActionDistinct: ra.distinct,
        rootActionCounts: ra.counts,
        planMode: pa.mode,
        planModeCount: pa.count,
        planRepetitionRate: rs.length ? round(pa.count / rs.length, 4) : null,
        planDistinct: pa.distinct,
        fullPlanRate: rs.length ? round(rs.filter((r) => r.replayOk && r.replayFullTurnConsumed && r.planNonEmpty).length / rs.length, 4) : null,
        replayOkRate: rs.length ? round(rs.filter((r) => r.replayOk).length / rs.length, 4) : null,
        meanPlanLength: rs.length ? round(rs.reduce((a, r) => a + r.planLength, 0) / rs.length, 3) : null,
        meanNodes: round(stats(rs.map((r) => r.nodes)).mean, 1),
        simulations: scaleStats(stats(rs.map((r) => r.simulations).filter((x) => typeof x === 'number'))),
        chanceSamples: scaleStats(stats(rs.map((r) => r.chanceSamples))),
        searchMs: scaleStats(stats(rs.map((r) => r.searchMs))),
        planMs: scaleStats(stats(rs.map((r) => r.planMs))),
        totalMs: scaleStats(stats(rs.map((r) => r.totalMs))),
        actions: aggregateActionDetails(rs),
      });
    }
  }
  return out;
}

function agreement(records, a, b, field) {
  const index = new Map();
  for (const r of records) index.set(`${r.repetition}|${r.rootId}|${r.algorithm}`, r);
  let n = 0;
  let same = 0;
  const roots = [...new Set(records.map((r) => r.rootId))];
  for (let rep = 1; rep <= REPS; rep++) {
    for (const rootId of roots) {
      const x = index.get(`${rep}|${rootId}|${a}`);
      const y = index.get(`${rep}|${rootId}|${b}`);
      if (!x || !y) continue;
      n++;
      if (x[field] === y[field]) same++;
    }
  }
  return { pairs: n, same, rate: n ? round(same / n, 4) : null };
}

function modalAgreement(pr, a, b) {
  const roots = [...new Set(pr.map((r) => r.rootId))];
  let n = 0;
  let same = 0;
  for (const rootId of roots) {
    const x = pr.find((r) => r.rootId === rootId && r.algorithm === a);
    const y = pr.find((r) => r.rootId === rootId && r.algorithm === b);
    if (!x || !y) continue;
    n++;
    if (x.rootActionMode === y.rootActionMode) same++;
  }
  return { roots: n, same, rate: n ? round(same / n, 4) : null };
}

const records = readAll();
const check = checkRecords(records);
const pr = perRoot(records);
const roots = [...new Set(records.map((r) => r.rootId))].sort();

const byAlgo = {};
for (const algo of ALGOS) {
  const rs = records.filter((r) => r.algorithm === algo);
  const rows = pr.filter((r) => r.algorithm === algo);
  byAlgo[algo] = {
    calls: rs.length,
    errors: rs.filter((r) => r.error).length,
    mathRandomCalls: rs.reduce((a, r) => a + (r.mathRandomCalls ?? 0), 0),
    replayOkRate: rs.length ? round(rs.filter((r) => r.replayOk).length / rs.length, 4) : null,
    fullPlanRate: rs.length ? round(rs.filter((r) => r.replayOk && r.replayFullTurnConsumed && r.planNonEmpty).length / rs.length, 4) : null,
    meanRootActionRepetitionRate: rows.length ? round(rows.reduce((a, r) => a + r.rootActionRepetitionRate, 0) / rows.length, 4) : null,
    stableRoots: rows.filter((r) => r.rootActionRepetitionRate === 1).length,
    searchMs: scaleStats(stats(rs.map((r) => r.searchMs))),
    planMs: scaleStats(stats(rs.map((r) => r.planMs))),
    totalMs: scaleStats(stats(rs.map((r) => r.totalMs))),
    nodes: scaleStats(stats(rs.map((r) => r.nodes))),
    simulations: scaleStats(stats(rs.map((r) => r.simulations).filter((x) => typeof x === 'number'))),
    chanceSamples: scaleStats(stats(rs.map((r) => r.chanceSamples))),
    withinBudgetRate: rs.length ? round(rs.filter((r) => r.withinFullTurnBudget).length / rs.length, 4) : null,
  };
}

const summary = {
  round: 'PPC-MCTS-01',
  generatedAt: new Date().toISOString(),
  status: allowPartial ? 'PARTIAL_ALLOWED' : 'COMPLETE',
  authority: {
    roots: 'PPC-CAT-STRATEGY-SEAL-01 REAL-HUMAN-REPLAY 24 roots',
    repetitions: REPS,
    algorithms: ALGOS,
    searchCalls: CALLS,
    budgetsMs: { main: 100, fullTurn: 150 },
    nodeCap: 500_000,
    horizonHandoffs: 4,
    note: '24-root development validation only; NOT a formal win-rate conclusion.',
  },
  files: {
    rawDir,
    logsDir,
    perRoot: path.join(dataDir, 'per-root.json'),
    summary: path.join(dataDir, 'summary.json'),
    csv: path.join(dataDir, 'summary.csv'),
  },
  integrity: {
    records: records.length,
    roots: roots.length,
    repetitions: [...new Set(records.map((r) => r.repetition))].sort((a, b) => a - b),
    fixtureSha256: [...new Set(records.map((r) => r.fixtureSha256))],
    errors: check.errors,
  },
  byAlgorithm: byAlgo,
  paired: {
    rootActionAgreement: {
      'RACE_vs_UCT-R': agreement(records, 'RACE', 'UCT-R', 'rootAction'),
      'RACE_vs_UCT-H': agreement(records, 'RACE', 'UCT-H', 'rootAction'),
      'UCT-R_vs_UCT-H': agreement(records, 'UCT-R', 'UCT-H', 'rootAction'),
    },
    fullPlanAgreement: {
      'RACE_vs_UCT-R': agreement(records, 'RACE', 'UCT-R', 'plan'),
      'RACE_vs_UCT-H': agreement(records, 'RACE', 'UCT-H', 'plan'),
      'UCT-R_vs_UCT-H': agreement(records, 'UCT-R', 'UCT-H', 'plan'),
    },
    perRootModalActionAgreement: {
      'RACE_vs_UCT-R': modalAgreement(pr, 'RACE', 'UCT-R'),
      'RACE_vs_UCT-H': modalAgreement(pr, 'RACE', 'UCT-H'),
      'UCT-R_vs_UCT-H': modalAgreement(pr, 'UCT-R', 'UCT-H'),
    },
  },
  perRoot: pr,
};

fs.writeFileSync(path.join(dataDir, 'per-root.json'), `${JSON.stringify(pr, null, 2)}\n`);
fs.writeFileSync(path.join(dataDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const csvCols = [
  'rootId', 'algorithm', 'repetitions', 'rootActionMode', 'rootActionRepetitionRate',
  'rootActionDistinct', 'planRepetitionRate', 'fullPlanRate', 'replayOkRate', 'meanPlanLength',
  'meanNodes', 'simulationsMean', 'chanceSamplesMean', 'searchMsP50', 'searchMsP95', 'searchMsP99',
  'searchMsMax', 'planMsP50', 'planMsP95', 'planMsP99', 'planMsMax', 'totalMsP50', 'totalMsP95',
  'totalMsP99', 'totalMsMax',
];
const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const csv = [csvCols.join(',')];
for (const r of pr) {
  csv.push([
    r.rootId, r.algorithm, r.repetitions, r.rootActionMode, r.rootActionRepetitionRate,
    r.rootActionDistinct, r.planRepetitionRate, r.fullPlanRate, r.replayOkRate, r.meanPlanLength,
    r.meanNodes, r.simulations.mean, r.chanceSamples.mean,
    r.searchMs.p50, r.searchMs.p95, r.searchMs.p99, r.searchMs.max,
    r.planMs.p50, r.planMs.p95, r.planMs.p99, r.planMs.max,
    r.totalMs.p50, r.totalMs.p95, r.totalMs.p99, r.totalMs.max,
  ].map(esc).join(','));
}
fs.writeFileSync(path.join(dataDir, 'summary.csv'), `${csv.join('\n')}\n`);

console.log(`PPC-MCTS-01 ANALYSIS status=${summary.status} records=${records.length} roots=${roots.length}`);
for (const algo of ALGOS) {
  const a = byAlgo[algo];
  console.log(`${algo}: calls=${a.calls} replayOk=${a.replayOkRate} fullPlan=${a.fullPlanRate} rootActionRep=${a.meanRootActionRepetitionRate} stableRoots=${a.stableRoots}/24 M1p50=${a.searchMs.p50} M1p99=${a.searchMs.p99} M2p99=${a.planMs.p99} totalMax=${a.totalMs.max}`);
}
if (check.errors.length > 0) {
  console.log(`INTEGRITY_ERRORS=${check.errors.length}`);
  for (const e of check.errors.slice(0, 20)) console.log(`  ${e}`);
} else {
  console.log('INTEGRITY_ERRORS=0');
}
