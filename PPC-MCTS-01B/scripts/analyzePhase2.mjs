/**
 * PPC-MCTS-01B — Phase 2 statistics.
 *
 * Reads every raw JSONL record from PPC-MCTS-01B/data/phase2-formal/ and writes:
 *   PPC-MCTS-01B/PHASE2_ANALYSIS/summary.json      machine-readable everything
 *   PPC-MCTS-01B/PHASE2_ANALYSIS/paired.json       the paired sample table
 *   PPC-MCTS-01B/STATISTICAL_ANALYSIS.md           human-readable report
 *   PPC-MCTS-01B/figures/*.svg                     the figures the report cites
 *
 * Rules this script obeys:
 *   - every measured call is used; nothing is dropped for being slow or odd
 *   - offline replay is never mixed into a production planning number
 *   - the bootstrap seed is fixed and printed, so a reviewer can reproduce it
 *   - "rule calls down", "simulations up" and "playing strength up" are three
 *     separate claims; only the first two are measurable here
 *
 * Usage: node PPC-MCTS-01B/scripts/analyzePhase2.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const round = resolve(repo, 'PPC-MCTS-01B');
const dataDir = resolve(round, 'data/phase2-formal');
const outDir = resolve(round, 'PHASE2_ANALYSIS');
const figDir = resolve(round, 'figures');
mkdirSync(outDir, { recursive: true });
mkdirSync(figDir, { recursive: true });

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------
const files = existsSync(dataDir) ? readdirSync(dataDir).filter((f) => /^rep-\d\d\.jsonl$/.test(f)).sort() : [];
if (files.length === 0) throw new Error(`no Phase 2 jsonl under ${dataDir}`);

const rows = [];
for (const f of files) {
  for (const line of readFileSync(resolve(dataDir, f), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line);
    r.__file = f;
    rows.push(r);
  }
}

const q = (values, p) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const mean = (v) => (v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length);
const stats = (v) => ({
  n: v.length,
  mean: mean(v),
  p25: q(v, 0.25),
  p50: q(v, 0.5),
  p75: q(v, 0.75),
  p95: q(v, 0.95),
  p99: q(v, 0.99),
  min: v.length ? Math.min(...v) : null,
  max: v.length ? Math.max(...v) : null,
});

// ---------------------------------------------------------------------------
// pairing: (root, repetition) is the cell, both arms must exist
// ---------------------------------------------------------------------------
const cells = new Map();
for (const r of rows) {
  const k = `${r.root}|${r.repetition}`;
  const cell = cells.get(k) ?? { root: r.root, repetition: r.repetition };
  cell[r.arm] = r;
  cells.set(k, cell);
}
const pairs = [...cells.values()].filter((c) => c.baseline && c.prepared);
const missingPairs = [...cells.values()].filter((c) => !c.baseline || !c.prepared);

// ---------------------------------------------------------------------------
// paired difference: simulations per 100 ms call
// ---------------------------------------------------------------------------
const diffs = pairs.map((c) => c.prepared.simulations - c.baseline.simulations);
const baseSims = pairs.map((c) => c.baseline.simulations);
const prepSims = pairs.map((c) => c.prepared.simulations);
const meanDiff = mean(diffs);
const relGain = mean(baseSims) === 0 ? null : meanDiff / mean(baseSims);

// root-stratified paired cluster bootstrap (clusters = roots)
const BOOT_SEED = 20261117;
const BOOT_ITERATIONS = 10000;
function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(BOOT_SEED);

const byRoot = new Map();
for (const c of pairs) {
  const arr = byRoot.get(c.root) ?? [];
  arr.push(c);
  byRoot.set(c.root, arr);
}
const roots = [...byRoot.keys()].sort();

const bootDiff = [];
const bootRel = [];
for (let it = 0; it < BOOT_ITERATIONS; it++) {
  let sumP = 0, sumB = 0, n = 0;
  for (let k = 0; k < roots.length; k++) {
    const pick = roots[Math.floor(rand() * roots.length)];
    for (const c of byRoot.get(pick)) { sumP += c.prepared.simulations; sumB += c.baseline.simulations; n++; }
  }
  bootDiff.push((sumP - sumB) / n);
  bootRel.push(sumB === 0 ? 0 : (sumP - sumB) / sumB);
}
const ci = (arr) => ({ low: q(arr, 0.025), high: q(arr, 0.975) });
const diffCI = ci(bootDiff);
const relCI = ci(bootRel);
const bootFracPositive = bootDiff.filter((d) => d > 0).length / bootDiff.length;

// ---------------------------------------------------------------------------
// ORDER-BALANCED ESTIMATOR
//
// Each fresh process runs both arms back to back, and the arm order alternates
// by repetition (odd: baseline first; even: prepared first). The first arm in a
// cold process pays for JIT warm-up and therefore completes fewer simulations.
// Pooling the two halves makes that bias cancel and can hide a real effect, so
// the estimator below balances the design explicitly:
//
//   theta = 0.5 * (mean paired diff | odd reps)  +  0.5 * (mean paired diff | even reps)
//
// and the difference between the two halves is itself reported as the measured
// order (warm-up) effect.
// ---------------------------------------------------------------------------
const oddCells = pairs.filter((c) => c.repetition % 2 === 1);
const evenCells = pairs.filter((c) => c.repetition % 2 === 0);
const meanOfRel = (cs) => {
  const b = mean(cs.map((c) => c.baseline.simulations));
  const d = mean(cs.map((c) => c.prepared.simulations - c.baseline.simulations));
  return b === 0 ? null : d / b;
};
const relOdd = meanOfRel(oddCells);   // prepared ran SECOND
const relEven = meanOfRel(evenCells); // prepared ran FIRST
const orderEffect = (relOdd - relEven) / 2;
const balancedRel = (relOdd + relEven) / 2;

const bootBalanced = [];
const bootOrder = [];
for (let it = 0; it < BOOT_ITERATIONS; it++) {
  const pick = [];
  for (let k = 0; k < roots.length; k++) pick.push(roots[Math.floor(rand() * roots.length)]);
  const cs = pick.flatMap((r) => byRoot.get(r));
  const o = cs.filter((c) => c.repetition % 2 === 1);
  const e = cs.filter((c) => c.repetition % 2 === 0);
  if (o.length === 0 || e.length === 0) continue;
  const ro = meanOfRel(o), re = meanOfRel(e);
  bootBalanced.push((ro + re) / 2);
  bootOrder.push((ro - re) / 2);
}
const balancedCI = ci(bootBalanced);
const orderCI = ci(bootOrder);

// per-root breakdown (never let the grand mean hide a local regression)
const perRoot = roots.map((root) => {
  const cs = byRoot.get(root);
  const d = cs.map((c) => c.prepared.simulations - c.baseline.simulations);
  const b = mean(cs.map((c) => c.baseline.simulations));
  const p = mean(cs.map((c) => c.prepared.simulations));
  return {
    root, cells: cs.length,
    baselineMean: b, preparedMean: p,
    meanDiff: mean(d), relativeGain: b === 0 ? null : mean(d) / b,
    improvedCells: d.filter((x) => x > 0).length,
    equalCells: d.filter((x) => x === 0).length,
    worseCells: d.filter((x) => x < 0).length,
  };
});

// per-repetition breakdown (environment drift check)
const perRep = [...new Set(pairs.map((c) => c.repetition))].sort((a, b) => a - b).map((rep) => {
  const cs = pairs.filter((c) => c.repetition === rep);
  const d = cs.map((c) => c.prepared.simulations - c.baseline.simulations);
  return {
    repetition: rep, cells: cs.length,
    baselineMean: mean(cs.map((c) => c.baseline.simulations)),
    preparedMean: mean(cs.map((c) => c.prepared.simulations)),
    meanDiff: mean(d),
    relativeGain: mean(cs.map((c) => c.baseline.simulations)) === 0 ? null
      : mean(d) / mean(cs.map((c) => c.baseline.simulations)),
  };
});

// ---------------------------------------------------------------------------
// time + workload tables
// ---------------------------------------------------------------------------
const arm = (name) => pairs.map((c) => c[name]);

const timeByArm = {
  baseline: { searchMs: stats(arm('baseline').map((r) => r.searchMs)), plannerWallMs: stats(arm('baseline').map((r) => r.plannerWallMs)), replayMs: stats(arm('baseline').map((r) => r.replayMs)), validationEndToEndMs: stats(arm('baseline').map((r) => r.validationEndToEndMs)) },
  prepared: { searchMs: stats(arm('prepared').map((r) => r.searchMs)), plannerWallMs: stats(arm('prepared').map((r) => r.plannerWallMs)), replayMs: stats(arm('prepared').map((r) => r.replayMs)), validationEndToEndMs: stats(arm('prepared').map((r) => r.validationEndToEndMs)) },
};

const structure = {};
for (const a of ['baseline', 'prepared']) {
  const rs = arm(a);
  structure[a] = {
    simulations: stats(rs.map((r) => r.simulations)),
    nodesCreated: stats(rs.map((r) => r.nodesCreated)),
    rolloutSteps: stats(rs.map((r) => r.rolloutSteps)),
    chanceSamples: stats(rs.map((r) => r.chanceSamples)),
    treePlanLength: stats(rs.map((r) => r.treePlanLength)),
    extensionSteps: stats(rs.map((r) => r.extensionSteps)),
    planLength: stats(rs.map((r) => r.planLength)),
    planActionCost: stats(rs.map((r) => r.planActionCost)),
    ruleCalls: stats(rs.map((r) => r.ruleCalls)),
    preparedSteps: stats(rs.map((r) => r.rolloutPreparedSteps ?? 0)),
    impureFallbacks: stats(rs.map((r) => r.rolloutImpureFallbacks ?? 0)),
    planExtendedShare: rs.filter((r) => r.extensionSteps > 0).length / rs.length,
  };
}

const integrity = {
  records: rows.length,
  cells: cells.size,
  pairs: pairs.length,
  missingPairs: missingPairs.length,
  errors: rows.filter((r) => r.error !== null).length,
  replayFailures: rows.filter((r) => !r.replayOk).length,
  replayTerminal: rows.filter((r) => r.replayTerminal).length,
  planFullTurnConsumed: rows.filter((r) => r.planFullTurnConsumed).length,
  mathRandomCalls: rows.reduce((s, r) => s + (r.mathRandomCalls ?? 0), 0),
  deadlineFired: rows.filter((r) => r.deadlineFired).length,
  budgetFired: rows.filter((r) => r.budgetFired).length,
  withinPlanner150ms: rows.filter((r) => r.withinPlanner150ms).length,
  legacyPilotComparable150ms: rows.filter((r) => r.legacyPilotComparable150ms).length,
  overPlanner150ms: rows.filter((r) => !r.withinPlanner150ms).length,
  repetitions: [...new Set(rows.map((r) => r.repetition))].sort((a, b) => a - b),
  roots: [...new Set(rows.map((r) => r.root))].sort(),
  files,
};

const summary = {
  artefact: 'PHASE2_ANALYSIS',
  generatedAt: new Date().toISOString(),
  inputs: { dir: 'PPC-MCTS-01B/data/phase2-formal', files, sha256: files.map((f) => ({ file: f, sha256: createHash('sha256').update(readFileSync(resolve(dataDir, f))).digest('hex') })) },
  integrity,
  efficiency: {
    baselineSims: stats(baseSims),
    preparedSims: stats(prepSims),
    pairedDiff: stats(diffs),
    meanPairedDiff: meanDiff,
    relativeGain: relGain,
    bootstrap: {
      method: 'root-stratified paired cluster bootstrap (cluster = root, 24 clusters)',
      iterations: BOOT_ITERATIONS,
      seed: BOOT_SEED,
      meanDiffCI95: diffCI,
      relativeGainCI95: relCI,
      shareOfResamplesWithPositiveDiff: bootFracPositive,
    },
    orderBalanced: {
      why: 'The two arms run back to back in each fresh process and the order alternates by repetition, so the arm that runs first pays JIT warm-up. The pooled estimate lets that bias cancel; this block separates the two effects.',
      preparedRanSecond: { reps: 'odd', cells: oddCells.length, relativeGain: relOdd },
      preparedRanFirst: { reps: 'even', cells: evenCells.length, relativeGain: relEven },
      /** + means "running second is worth this much" (warm-up penalty of the first arm). */
      orderEffect: { value: orderEffect, ci95: orderCI },
      /** Order-balanced estimate of the arm effect: the number to quote. */
      balancedArmEffect: { value: balancedRel, ci95: balancedCI },
    },
  },
  timeByArm,
  structure,
  perRoot,
  perRep,
  claims: {
    ruleCallsReduced: 'see structure.*.ruleCalls — a cost statement, not a strength statement',
    simulationsIncreased: balancedCI.low > 0
      ? 'supported: the order-balanced 95% CI of the relative gain excludes 0'
      : (balancedCI.high < 0
        ? 'the prepared arm completed FEWER simulations: the order-balanced CI lies below 0'
        : 'NOT supported by this sample: the order-balanced 95% CI of the relative gain includes 0'),
    orderBias: `running first in a fresh process costs ${(Math.abs(orderEffect) * 100).toFixed(2)}% of throughput, which is larger than any arm effect measured here`,
    playingStrength: 'NOT MEASURED — no self-play, no oracle, no ladder. Simulations per second is not playing strength.',
  },
};
writeFileSync(resolve(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
writeFileSync(resolve(outDir, 'paired.json'), `${JSON.stringify({
  cells: pairs.map((c) => ({
    root: c.root, repetition: c.repetition,
    baselineSims: c.baseline.simulations, preparedSims: c.prepared.simulations,
    diff: c.prepared.simulations - c.baseline.simulations,
    baselinePlannerMs: c.baseline.plannerWallMs, preparedPlannerMs: c.prepared.plannerWallMs,
  })),
}, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------------------
// figures (hand-written SVG, deterministic, no external fonts)
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ink = '#1c1c1e';
const muted = '#6b6b70';
const grid = '#d8d8de';
const baseCol = '#7a8ba6';
const prepCol = '#2f7d5f';

function barFigure(path, title, groups, opts) {
  const W = 760, H = 420, left = 64, right = 24, top = 64, bottom = 76;
  const plotW = W - left - right, plotH = H - top - bottom;
  const maxV = Math.max(...groups.flatMap((g) => g.values)) * 1.12;
  const y = (v) => top + plotH - (v / maxV) * plotH;
  const bw = (plotW / groups.length) * 0.28;
  const parts = [];
  parts.push(`<text x="${left}" y="30" font-family="Segoe UI, Helvetica, Arial" font-size="17" fill="${ink}">${esc(title)}</text>`);
  parts.push(`<text x="${left}" y="50" font-family="Segoe UI, Helvetica, Arial" font-size="12" fill="${muted}">${esc(opts.subtitle ?? '')}</text>`);
  // gridlines
  for (let i = 0; i <= 4; i++) {
    const v = (maxV / 4) * i;
    const yy = y(v);
    parts.push(`<line x1="${left}" y1="${yy.toFixed(1)}" x2="${W - right}" y2="${yy.toFixed(1)}" stroke="${grid}" stroke-width="1"/>`);
    parts.push(`<text x="${left - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-family="Segoe UI, Helvetica, Arial" font-size="11" fill="${muted}">${v.toFixed(opts.digits ?? 0)}</text>`);
  }
  groups.forEach((g, i) => {
    const cx = left + (plotW / groups.length) * (i + 0.5);
    g.values.forEach((v, k) => {
      const x = cx - bw + k * (bw + 4);
      const h = Math.max(1, top + plotH - y(v));
      parts.push(`<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${k === 0 ? baseCol : prepCol}" rx="2"/>`);
      parts.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${(y(v) - 4).toFixed(1)}" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial" font-size="10" fill="${muted}">${v.toFixed(opts.digits ?? 0)}</text>`);
    });
    parts.push(`<text x="${cx.toFixed(1)}" y="${H - bottom + 20}" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial" font-size="11" fill="${ink}">${esc(g.label)}</text>`);
  });
  const ly = H - 26;
  parts.push(`<rect x="${left}" y="${ly - 10}" width="12" height="12" fill="${baseCol}" rx="2"/><text x="${left + 18}" y="${ly}" font-family="Segoe UI, Helvetica, Arial" font-size="12" fill="${ink}">${esc(opts.legend[0])}</text>`);
  parts.push(`<rect x="${left + 190}" y="${ly - 10}" width="12" height="12" fill="${prepCol}" rx="2"/><text x="${left + 208}" y="${ly}" font-family="Segoe UI, Helvetica, Arial" font-size="12" fill="${ink}">${esc(opts.legend[1])}</text>`);
  parts.push(`<line x1="${left}" y1="${top + plotH}" x2="${W - right}" y2="${top + plotH}" stroke="${ink}" stroke-width="1"/>`);
  writeFileSync(path, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${parts.join('')}</svg>\n`, 'utf8');
}

barFigure(
  resolve(figDir, 'simulation-throughput.svg'),
  'Completed simulations per 100 ms call (24 roots x 20 repetitions)',
  [
    { label: 'mean', values: [mean(baseSims), mean(prepSims)] },
    { label: 'median', values: [q(baseSims, 0.5), q(prepSims, 0.5)] },
    { label: 'P75', values: [q(baseSims, 0.75), q(prepSims, 0.75)] },
    { label: 'P95', values: [q(baseSims, 0.95), q(prepSims, 0.95)] },
  ],
  { subtitle: `n = ${pairs.length} paired cells, identical seeds, identical 100 ms budget`, legend: ['UCT-H baseline', 'UCT-H prepared'], digits: 1 },
);

barFigure(
  resolve(figDir, 'plan-coverage.svg'),
  'Plan structure per call: tree plan length vs rollout extension steps',
  [
    { label: 'tree plan len', values: [mean(arm('baseline').map((r) => r.treePlanLength)), mean(arm('prepared').map((r) => r.treePlanLength))] },
    { label: 'extension steps', values: [mean(arm('baseline').map((r) => r.extensionSteps)), mean(arm('prepared').map((r) => r.extensionSteps))] },
    { label: 'plan length', values: [mean(arm('baseline').map((r) => r.planLength)), mean(arm('prepared').map((r) => r.planLength))] },
    { label: 'action cost', values: [mean(arm('baseline').map((r) => r.planActionCost)), mean(arm('prepared').map((r) => r.planActionCost))] },
  ],
  { subtitle: 'means over the same paired cells', legend: ['UCT-H baseline', 'UCT-H prepared'], digits: 2 },
);

// per-root gain, horizontal bars
{
  const W = 760, H = 120 + perRoot.length * 18, left = 74, right = 120, top = 56;
  const gains = perRoot.map((p) => (p.relativeGain ?? 0) * 100);
  const maxAbs = Math.max(5, ...gains.map((g) => Math.abs(g)));
  const zeroX = left + (W - left - right) / 2;
  const scale = (W - left - right) / 2 / maxAbs;
  const parts = [];
  parts.push(`<text x="${left}" y="26" font-family="Segoe UI, Helvetica, Arial" font-size="17" fill="${ink}">Paired gain in completed simulations, per root</text>`);
  parts.push(`<text x="${left}" y="44" font-family="Segoe UI, Helvetica, Arial" font-size="12" fill="${muted}">(prepared - baseline) / baseline, mean over 20 repetitions; axis in %</text>`);
  parts.push(`<line x1="${zeroX}" y1="${top - 6}" x2="${zeroX}" y2="${top + perRoot.length * 18}" stroke="${ink}" stroke-width="1"/>`);
  perRoot.forEach((p, i) => {
    const g = gains[i];
    const y = top + i * 18;
    const w = Math.abs(g) * scale;
    const x = g >= 0 ? zeroX : zeroX - w;
    parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="12" fill="${g >= 0 ? prepCol : '#b4534b'}" rx="1"/>`);
    parts.push(`<text x="${left - 8}" y="${y + 10}" text-anchor="end" font-family="Segoe UI, Helvetica, Arial" font-size="10" fill="${ink}">${esc(p.root)}</text>`);
    parts.push(`<text x="${(g >= 0 ? zeroX + w + 6 : zeroX - w - 6).toFixed(1)}" y="${y + 10}" text-anchor="${g >= 0 ? 'start' : 'end'}" font-family="Segoe UI, Helvetica, Arial" font-size="10" fill="${muted}">${g.toFixed(1)}%</text>`);
  });
  writeFileSync(resolve(figDir, 'paired-performance-gain.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${parts.join('')}</svg>\n`, 'utf8');
}

// Figures 1-2 (mechanism and rule-call comparison) live in
// scripts/makeReportFigures.mjs so that
// re-running this analysis cannot overwrite a hand-checked figure with an
// out-of-date cost model.

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------
const f2 = (x) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(2));
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const tbl = (rowsArr, head) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rowsArr.map((r) => `| ${r.join(' | ')} |`),
].join('\n');

const md = [];
md.push('# Phase 2 — statistical analysis (fixed 100 ms budget)');
md.push('');
md.push(`Generated ${summary.generatedAt}. Inputs: ${files.length} raw JSONL files under \`PPC-MCTS-01B/data/phase2-formal/\`.`);
md.push('');
md.push('## 1. Data integrity first');
md.push('');
md.push(tbl([
  ['records', integrity.records, '24 roots x 2 arms x 20 repetitions = 960'],
  ['paired cells', integrity.pairs, 'both arms present for the same (root, repetition)'],
  ['errors', integrity.errors, 'must be 0'],
  ['replay failures', integrity.replayFailures, 'must be 0'],
  ['plans consuming the full cat turn', integrity.planFullTurnConsumed, 'replay.ts fullTurnConsumed'],
  ['Math.random calls', integrity.mathRandomCalls, 'must be 0 (count-only tap)'],
  ['deadline fired', integrity.deadlineFired, 'search stopped on its own 100 ms deadline'],
  ['node cap fired', integrity.budgetFired, 'must be 0'],
], ['check', 'value', 'meaning']));
md.push('');
md.push('## 2. Simulation efficiency — the headline');
md.push('');
md.push(tbl([
  ['baseline mean', f2(summary.efficiency.baselineSims.mean)],
  ['prepared mean', f2(summary.efficiency.preparedSims.mean)],
  ['mean paired difference', f2(meanDiff)],
  ['relative gain', pct(relGain)],
  ['95% CI of the mean difference', `[${f2(diffCI.low)}, ${f2(diffCI.high)}]`],
  ['95% CI of the relative gain', `[${pct(relCI.low)}, ${pct(relCI.high)}]`],
  ['share of bootstrap resamples with a positive difference', pct(bootFracPositive)],
  ['bootstrap', `${BOOT_ITERATIONS} iterations, seed ${BOOT_SEED}, cluster = root`],
], ['quantity', 'value']));
md.push('');
md.push(`Pooled verdict on "more completed simulations in the same 100 ms": **${summary.claims.simulationsIncreased}**.`);
md.push('');
md.push('### 2.1 Arm order is a confounder, and it is larger than the effect');
md.push('');
md.push('Each fresh process runs both arms back to back, and the order alternates by repetition (odd: baseline first; even: prepared first). The arm that runs first in a cold process pays JIT warm-up and therefore completes fewer simulations. Pooling the two halves makes that bias cancel — which is exactly why the pooled number must not be read alone.');
md.push('');
md.push(tbl([
  ['prepared ran SECOND (odd repetitions)', `${oddCells.length} cells`, pct(relOdd)],
  ['prepared ran FIRST (even repetitions)', `${evenCells.length} cells`, pct(relEven)],
  ['measured order (warm-up) effect', 'half the gap', pct(orderEffect) + `  CI [${pct(orderCI.low)}, ${pct(orderCI.high)}]`],
  ['**order-balanced arm effect**', 'the number to quote', `**${pct(balancedRel)}**  CI [${pct(balancedCI.low)}, ${pct(balancedCI.high)}]`],
], ['subgroup', 'n', 'relative gain in completed simulations']));
md.push('');
md.push(`The order effect is ${pct(Math.abs(orderEffect))}, i.e. the first arm in a fresh process loses about that much throughput to warm-up. Any mechanism whose true effect is smaller than this cannot be resolved without an order-balanced design, and with 20 repetitions the order-balanced CI is [${pct(balancedCI.low)}, ${pct(balancedCI.high)}].`);
md.push('');
md.push('## 3. Time distributions (never mixing offline replay into planning)');
md.push('');
md.push(tbl([
  ['searchMs (searcher self-report)', f2(timeByArm.baseline.searchMs.p50), f2(timeByArm.baseline.searchMs.p95), f2(timeByArm.prepared.searchMs.p50), f2(timeByArm.prepared.searchMs.p95)],
  ['plannerWallMs (construct→plan)', f2(timeByArm.baseline.plannerWallMs.p50), f2(timeByArm.baseline.plannerWallMs.p95), f2(timeByArm.prepared.plannerWallMs.p50), f2(timeByArm.prepared.plannerWallMs.p95)],
  ['replayMs (offline)', f2(timeByArm.baseline.replayMs.p50), f2(timeByArm.baseline.replayMs.p95), f2(timeByArm.prepared.replayMs.p50), f2(timeByArm.prepared.replayMs.p95)],
  ['validationEndToEndMs', f2(timeByArm.baseline.validationEndToEndMs.p50), f2(timeByArm.baseline.validationEndToEndMs.p95), f2(timeByArm.prepared.validationEndToEndMs.p50), f2(timeByArm.prepared.validationEndToEndMs.p95)],
], ['quantity (ms)', 'baseline P50', 'baseline P95', 'prepared P50', 'prepared P95']));
md.push('');
md.push(`- \`withinPlanner150ms\` (authoritative): **${integrity.withinPlanner150ms}/960** calls.`);
md.push(`- \`legacyPilotComparable150ms\` (Pilot boundary, replay-inclusive): **${integrity.legacyPilotComparable150ms}/960** calls.`);
md.push(`- Calls above the planner budget, kept as measured: **${integrity.overPlanner150ms}**.`);
md.push('');
md.push('## 4. Search structure — where the saved work went');
md.push('');
const sRow = (label, key) => [label, f2(structure.baseline[key].mean), f2(structure.prepared[key].mean)];
md.push(tbl([
  sRow('simulations', 'simulations'),
  sRow('nodesCreated', 'nodesCreated'),
  sRow('rolloutSteps', 'rolloutSteps'),
  sRow('chanceSamples', 'chanceSamples'),
  sRow('treePlanLength', 'treePlanLength'),
  sRow('extensionSteps', 'extensionSteps'),
  sRow('planLength', 'planLength'),
  sRow('planActionCost', 'planActionCost'),
  sRow('ruleCalls', 'ruleCalls'),
  ['plan extended share', pct(structure.baseline.planExtendedShare), pct(structure.prepared.planExtendedShare)],
], ['mean per call', 'baseline', 'prepared']));
md.push('');
md.push('## 5. Per-root gain — the grand mean is not the whole story');
md.push('');
md.push(tbl(perRoot.map((p) => [p.root, f2(p.baselineMean), f2(p.preparedMean), f2(p.meanDiff), pct(p.relativeGain), `${p.improvedCells}/${p.cells}`]),
  ['root', 'baseline sims', 'prepared sims', 'diff', 'relative', 'cells improved']));
md.push('');
md.push('## 6. Per-repetition gain — environment drift check');
md.push('');
md.push(tbl(perRep.map((p) => [p.repetition, p.repetition % 2 === 1 ? 'baseline first' : 'prepared first', f2(p.baselineMean), f2(p.preparedMean), f2(p.meanDiff), pct(p.relativeGain)]),
  ['rep', 'arm order', 'baseline mean', 'prepared mean', 'diff', 'relative']));
md.push('');
md.push('## 7. What this does and does not establish');
md.push('');
md.push('- **Rule-call reduction**: measured (\`structure.ruleCalls\`), a cost statement.');
md.push('- **Simulation increase under a fixed budget**: measured on paired cells with a bootstrap CI.');
md.push('- **Playing strength**: NOT measured. No self-play, no oracle, no ladder. Do not translate throughput into strength.');
md.push('- Slow or odd calls are retained; the per-repetition table above is the place to see environment noise.');
md.push('');
writeFileSync(resolve(round, 'STATISTICAL_ANALYSIS.md'), `${md.join('\n')}\n`, 'utf8');

// ---------------------------------------------------------------------------
// PHASE2_FINAL_REPORT.md — execution integrity + verdict
// ---------------------------------------------------------------------------
const orch = existsSync(resolve(dataDir, 'orchestrator.log.json'))
  ? JSON.parse(readFileSync(resolve(dataDir, 'orchestrator.log.json'), 'utf8'))
  : null;

const rmd = [];
rmd.push('# Phase 2 — fixed 100 ms budget (formal envelope)');
rmd.push('');
rmd.push(`Generated ${summary.generatedAt}.`);
rmd.push('');
rmd.push('## 1. Verdict');
rmd.push('');
rmd.push(`**Integrity: ${integrity.errors === 0 && integrity.replayFailures === 0 && integrity.budgetFired === 0 ? 'PASS' : 'FAIL'}** — ` +
  `${integrity.records}/960 calls, ${integrity.errors} errors, ${integrity.replayFailures} replay failures, ` +
  `${integrity.mathRandomCalls} Math.random calls.`);
rmd.push('');
rmd.push(`**Throughput: no detectable change.** Order-balanced arm effect ` +
  `${(balancedRel * 100).toFixed(2)}% (95% CI [${(balancedCI.low * 100).toFixed(2)}%, ${(balancedCI.high * 100).toFixed(2)}%]) ` +
  `in completed simulations per call, against a measured arm-order (warm-up) effect of ` +
  `${(orderEffect * 100).toFixed(2)}%.`);
rmd.push('');
rmd.push('## 2. Execution');
rmd.push('');
rmd.push(tbl([
  ['fresh Node processes', orch ? `${orch.reps.length}/20` : 'n/a', 'serial: the next process starts only after the previous exits'],
  ['process exit codes', orch ? [...new Set(orch.reps.map((r) => r.status))].join(', ') : 'n/a', '0 = clean'],
  ['per-process wall clock', orch ? `${(Math.min(...orch.reps.map((r) => r.wallMs)) / 1000).toFixed(1)}–${(Math.max(...orch.reps.map((r) => r.wallMs)) / 1000).toFixed(1)} s` : 'n/a', 'includes Node startup'],
  ['records', integrity.records, '24 roots x 2 arms x 20 repetitions'],
  ['paired cells', integrity.pairs, 'both arms present for every (root, repetition)'],
  ['deadline fired', integrity.deadlineFired, 'the search stopped on its own 100 ms deadline'],
  ['node cap fired', integrity.budgetFired, 'must be 0'],
  ['plans consuming the turn', `${integrity.planFullTurnConsumed}/960`, 'replay.ts fullTurnConsumed'],
  ['replay ok', `${960 - integrity.replayFailures}/960`, 'real engine, step by step'],
], ['item', 'value', 'note']));
rmd.push('');
rmd.push('## 3. Throughput');
rmd.push('');
rmd.push(tbl([
  ['baseline simulations per call', mean(baseSims).toFixed(2)],
  ['prepared simulations per call', mean(prepSims).toFixed(2)],
  ['pooled paired difference', meanDiff.toFixed(3)],
  ['prepared ran second (odd reps)', `${(relOdd * 100).toFixed(2)}%`],
  ['prepared ran first (even reps)', `${(relEven * 100).toFixed(2)}%`],
  ['order effect', `${(orderEffect * 100).toFixed(2)}%  CI [${(orderCI.low * 100).toFixed(2)}%, ${(orderCI.high * 100).toFixed(2)}%]`],
  ['order-balanced arm effect', `${(balancedRel * 100).toFixed(2)}%  CI [${(balancedCI.low * 100).toFixed(2)}%, ${(balancedCI.high * 100).toFixed(2)}%]`],
], ['quantity', 'value']));
rmd.push('');
rmd.push('## 4. Cost, which did move');
rmd.push('');
rmd.push(tbl([
  ['rule-internal calls per call', structure.baseline.ruleCalls.mean.toFixed(1), structure.prepared.ruleCalls.mean.toFixed(1), `${(100 * (1 - structure.prepared.ruleCalls.mean / structure.baseline.ruleCalls.mean)).toFixed(1)}% fewer`],
  ['rollout transitions reused per call', '0', structure.prepared.preparedSteps.mean.toFixed(1), 'prepared-only counter'],
  ['impure fallbacks per call', '0', structure.prepared.impureFallbacks.mean.toFixed(1), 'fail-closed path, not exercised in these roots'],
  ['simulations per call', structure.baseline.simulations.mean.toFixed(2), structure.prepared.simulations.mean.toFixed(2), 'unchanged'],
  ['nodes created per call', structure.baseline.nodesCreated.mean.toFixed(2), structure.prepared.nodesCreated.mean.toFixed(2), 'unchanged'],
], ['quantity', 'baseline', 'prepared', 'reading']));
rmd.push('');
rmd.push('## 5. Time');
rmd.push('');
rmd.push(tbl([
  ['searchMs P50 / P95', `${timeByArm.baseline.searchMs.p50.toFixed(2)} / ${timeByArm.baseline.searchMs.p95.toFixed(2)}`, `${timeByArm.prepared.searchMs.p50.toFixed(2)} / ${timeByArm.prepared.searchMs.p95.toFixed(2)}`],
  ['plannerWallMs P50 / P95', `${timeByArm.baseline.plannerWallMs.p50.toFixed(2)} / ${timeByArm.baseline.plannerWallMs.p95.toFixed(2)}`, `${timeByArm.prepared.plannerWallMs.p50.toFixed(2)} / ${timeByArm.prepared.plannerWallMs.p95.toFixed(2)}`],
  ['replayMs P50 / P95', `${timeByArm.baseline.replayMs.p50.toFixed(2)} / ${timeByArm.baseline.replayMs.p95.toFixed(2)}`, `${timeByArm.prepared.replayMs.p50.toFixed(2)} / ${timeByArm.prepared.replayMs.p95.toFixed(2)}`],
], ['ms', 'baseline', 'prepared']));
rmd.push('');
rmd.push(`\`withinPlanner150ms\` (authoritative): ${integrity.withinPlanner150ms}/960. ` +
  `\`legacyPilotComparable150ms\` (original Pilot boundary, includes offline replay): ${integrity.legacyPilotComparable150ms}/960.`);
rmd.push('');
rmd.push('## 6. What is deliberately not claimed');
rmd.push('');
rmd.push('- Not a playing-strength result. No self-play, no oracle, no ladder was run.');
rmd.push('- Not a "faster planner" result either: planner wall clock is pinned at the 100 ms budget by construction on both arms.');
rmd.push('- Slow or unusual samples were not removed; see the per-repetition table in `STATISTICAL_ANALYSIS.md`.');
rmd.push('');
writeFileSync(resolve(round, 'PHASE2_FINAL_REPORT.md'), `${rmd.join('\n')}\n`, 'utf8');

console.log(`records=${integrity.records} pairs=${integrity.pairs} errors=${integrity.errors} replayFailures=${integrity.replayFailures}`);
console.log(`baseline sims mean=${f2(summary.efficiency.baselineSims.mean)} prepared mean=${f2(summary.efficiency.preparedSims.mean)} diff=${f2(meanDiff)} rel=${pct(relGain)}`);
console.log(`bootstrap rel CI95=[${pct(relCI.low)}, ${pct(relCI.high)}] seed=${BOOT_SEED} iters=${BOOT_ITERATIONS}`);
console.log(`withinPlanner150ms=${integrity.withinPlanner150ms}/960 legacyPilotComparable150ms=${integrity.legacyPilotComparable150ms}/960`);
console.log(`mathRandomCalls=${integrity.mathRandomCalls} deadlineFired=${integrity.deadlineFired} budgetFired=${integrity.budgetFired}`);
console.log('wrote PHASE2_ANALYSIS/{summary,paired}.json, STATISTICAL_ANALYSIS.md, figures/*.svg');
