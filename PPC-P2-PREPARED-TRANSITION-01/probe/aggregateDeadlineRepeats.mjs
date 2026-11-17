#!/usr/bin/env node
/**
 * PPC-P2-PREPARED-TRANSITION-01 — aggregate the repeated 100 ms / 150 ms
 * production-turn diagnostic.
 *
 * Why this exists: the first pass through this gate produced ONE table that was
 * quoted in the report ("plans 22→23, fallback 2→1, only G1T1 changed"). A second
 * pass — same code, same command — produced different numbers. The gate sits on a
 * hard 100 ms cliff, so a single sample cannot distinguish "the optimisation moved
 * the outcome" from "the machine happened to be faster this second". Rather than
 * pick the flattering sample, this script measures the variance:
 *
 *   robust  = candidate draws more nodes in every run
 *   fragile = how many roots change plan / depth, per run
 *
 * Input : _raw/deadline_integration_run{1..5}.json (each a full 24-row capture)
 * Output: _raw/deadline_integration_repeat.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = 'PPC-P2-PREPARED-TRANSITION-01/';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const stats = (d) => {
  let nb = 0, nc = 0, plannedB = 0, plannedC = 0, fbB = 0, fbC = 0, dB = 0, dC = 0;
  const ratios = [];
  const changed = [];
  for (const r of d.rows) {
    const b = r.baseline, c = r.candidate;
    nb += b.nodes; nc += c.nodes;
    if (b.planStatus === 'planned') plannedB++;
    if (c.planStatus === 'planned') plannedC++;
    if (b.fallbackLogged) fbB++;
    if (c.fallbackLogged) fbC++;
    if (b.completedDepth >= 1) dB++;
    if (c.completedDepth >= 1) dC++;
    if (b.nodes > 0) ratios.push(c.nodes / b.nodes);
    if (JSON.stringify(b.plan) !== JSON.stringify(c.plan) ||
        b.completedDepth !== c.completedDepth) {
      changed.push({
        id: r.id,
        baseline: { depth: b.completedDepth, nodes: b.nodes, plan: b.plan.join(''), status: b.planStatus, rootValue: b.rootValue },
        candidate: { depth: c.completedDepth, nodes: c.nodes, plan: c.plan.join(''), status: c.planStatus, rootValue: c.rootValue },
      });
    }
  }
  ratios.sort((a, b) => a - b);
  return {
    roots: d.rows.length,
    totalNodes: { baseline: nb, candidate: nc },
    totalNodeRatio: Number((nc / nb).toFixed(6)),
    perRootNodeRatio: {
      min: Number(ratios[0].toFixed(4)),
      median: Number(ratios[Math.floor(ratios.length / 2)].toFixed(4)),
      max: Number(ratios[ratios.length - 1].toFixed(4)),
      rootsWithMoreNodes: ratios.filter((x) => x > 1).length,
      rootsWithFewerNodes: ratios.filter((x) => x < 1).length,
    },
    planned: { baseline: plannedB, candidate: plannedC },
    fallbackLogged: { baseline: fbB, candidate: fbC },
    completedDepthAtLeast1: { baseline: dB, candidate: dC },
    changedRoots: changed,
    medianTurnWallMs: {
      baseline: Number(d.summary.medianTurnWallMs.baseline.toFixed(2)),
      candidate: Number(d.summary.medianTurnWallMs.candidate.toFixed(2)),
    },
    maxTurnWallMs: {
      baseline: Number(d.summary.maxTurnWallMs.baseline.toFixed(2)),
      candidate: Number(d.summary.maxTurnWallMs.candidate.toFixed(2)),
    },
  };
};

const runs = [];
for (let i = 1; i <= 5; i++) {
  const rel = `_raw/deadline_integration_run${i}.json`;
  const p = ROOT + rel;
  if (!existsSync(p)) { console.log('missing', rel); continue; }
  const d = JSON.parse(readFileSync(p, 'utf8'));
  runs.push({ index: i, rawFile: rel, rawSha256: sha(p), stats: stats(d), rows: d.rows });
}

const ratios = runs.map((r) => r.stats.totalNodeRatio);
const nChanged = runs.map((r) => r.stats.changedRoots.length);
const medRatio = runs.map((r) => r.stats.perRootNodeRatio.median);

const out = {
  round: 'PPC-P2-PREPARED-TRANSITION-01',
  authority: 'DIAGNOSTIC_ONLY',
  what: 'Full production cat turn (planHardCatTurn on the real engine) at a fixed 100 ms main-search budget / 150 ms whole-turn wall, both arms, over the 24 frozen human roots. Repeated 5 times because the first two passes disagreed.',
  whyRepeated:
    'Pass 1 reported plans 22→23, fallback 2→1 and a single changed root (G1T1). Pass 2, identical code and command, '
    + 'reported 23→23, 1→1 and a different changed root (G1T3). A 100 ms cliff cannot be sampled once. '
    + 'Neither sample was discarded; both are kept and 3 more were added.',
  robustFindings: {
    moreNodesInEveryRun: runs.every((r) => r.stats.totalNodeRatio > 1),
    totalNodeRatioRange: { min: Math.min(...ratios), max: Math.max(...ratios) },
    perRootMedianNodeRatioRange: { min: Math.min(...medRatio), max: Math.max(...medRatio) },
    medianTurnWallUnchanged:
      runs.every((r) => Math.abs(r.stats.medianTurnWallMs.candidate - r.stats.medianTurnWallMs.baseline) <= 1.0),
    noRootEverLostAPlan: runs.every((r) => r.stats.planned.candidate >= r.stats.planned.baseline),
    noNewFallbackEver: runs.every((r) => r.stats.fallbackLogged.candidate <= r.stats.fallbackLogged.baseline),
  },
  fragileFindings: {
    planOrDepthChangedRootsPerRun: nChanged,
    range: { min: Math.min(...nChanged), max: Math.max(...nChanged) },
    unionOfChangedRootIds: [...new Set(runs.flatMap((r) => r.stats.changedRoots.map((c) => c.id)))].sort(),
    note: 'Which roots change — and whether any changes at all — flips run to run. '
      + 'This gate therefore does NOT support "the optimisation produces better plans"; it only supports "it explores more within the same budget".',
  },
  runs,
};

writeFileSync(ROOT + '_raw/deadline_integration_repeat.json', `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({
  runs: runs.length,
  totalNodeRatio: ratios,
  perRootMedianRatio: medRatio,
  changedRootsPerRun: nChanged,
  union: out.fragileFindings.unionOfChangedRootIds,
}, null, 1));
