/**
 * PPC-MCTS-01B-HARNESS-REPAIR — FIXED-WORKLOAD PARITY DRIVER.
 *
 * THIS FILE WAS CORRECTED. Its previous version called itself a
 * "fixed-simulation" driver but stopped on `maxNodes`, which is a fixed amount
 * of TREE GROWTH, not a fixed amount of SIMULATIONS. Two arms only run the same
 * number of simulations under a node cap if they already agree on every
 * decision — i.e. the driver could not detect the very divergence it claimed to
 * test. It is now driven by the test-only `maxCompletedSimulations` seam, which
 * fires only between simulations, never inside one.
 *
 * TWO MODES (the 96-cell fixed-node sweep is kept as a regression baseline):
 *
 *   --sims=K              (DEFAULT) both arms run exactly K COMPLETE simulations.
 *                         Clock frozen (`now() = 0`), so the deadline cannot fire.
 *                         `maxNodes` stays at its production value (500 000) as a
 *                         safety net; if it fires first the cell is an anomaly.
 *
 *   --legacy-nodes=64,200 the ORIGINAL fixed-`maxNodes` sweep. Reproduces
 *                         `data/impl-parity-breadth.json` (96 cells) unchanged,
 *                         so the pre-existing regression evidence stays checkable.
 *
 * Usage
 *   node PPC-MCTS-01B/build/parityFixedSims.mjs --sims=200
 *   node PPC-MCTS-01B/build/parityFixedSims.mjs --sims=64,200 --modes=hybrid,random
 *   node PPC-MCTS-01B/build/parityFixedSims.mjs --legacy-nodes=64,200 --modes=hybrid,random
 *   node PPC-MCTS-01B/build/parityFixedSims.mjs --smoke
 *
 * THIS IS NOT PHASE 1. Phase 1 (24 roots x 20 repetitions x 2 arms, K=200, one
 * fresh process per repetition) is `drivers/phase1Parity.ts` and must not be
 * launched before review.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  loadRoots, runArm, comparable, diffCell, countingRules,
  ROOT_FIXTURE_SHA256, MAX_HANDOFFS, UCB_C,
} from './lib/arms';
import type { Mode } from './lib/arms';
import {
  runPhase1Arm, diffPhase1, phase1ExecutionAnomaly, phase1Comparable,
  PHASE1_MAX_NODES, COMPLETED_SIMULATIONS_PER_CALL,
} from './lib/phase1';
import { uctSeed } from '../../PPC-MCTS-01/proto/uct';

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const hasFlag = (f: string): boolean => process.argv.includes(`--${f}`);

const smoke = hasFlag('smoke');
const legacyArg = arg('legacy-nodes', '');
const legacyMode = legacyArg !== '';
const simsArg = arg('sims', '');
if (legacyMode && simsArg !== '') {
  throw new Error('choose one workload: --sims=K (completed simulations) or --legacy-nodes=... (node cap)');
}

const modes = arg('modes', smoke ? 'hybrid' : 'hybrid').split(',').map((s) => s.trim()) as Mode[];
const rootSel = arg('roots', smoke ? 'G1T1,G2T6' : 'all');
const kValues = legacyMode
  ? legacyArg.split(',').map((s) => Number(s.trim()))
  : (smoke ? '20' : (simsArg || String(COMPLETED_SIMULATIONS_PER_CALL)))
    .split(',').map((s) => Number(s.trim()));
for (const k of kValues) {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`bad workload value ${String(k)}`);
}
if (smoke) {
  // Smoke must never be mistakable for evidence, and must stay cheap.
  if (kValues.some((k) => k > 64)) throw new Error('--smoke allows K <= 64 only');
}

// Default outputs never collide with a previously frozen artefact:
// the 96-cell fixed-node evidence stays where it is, and this run writes beside
// it unless `--out` says otherwise.
const defaultOut = legacyMode
  ? 'PPC-MCTS-01B/data/impl-parity-breadth.legacy-rerun.json'
  : (smoke ? 'PPC-MCTS-01B/data/parity-fixed-sims-smoke.json' : 'PPC-MCTS-01B/data/parity-fixed-sims.json');
const outPath = resolve(process.cwd(), arg('out', defaultOut));

const { roots, fixtureSha256 } = loadRoots();
const selected = rootSel === 'all' ? roots : roots.filter((r) => rootSel.split(',').map((s) => s.trim()).includes(r.id));
if (selected.length === 0) throw new Error(`no roots matched --roots=${rootSel}`);

// ---------------------------------------------------------------------------
// mode A — fixed COMPLETE simulations (the corrected workload)
// ---------------------------------------------------------------------------
interface SimsCell {
  root: string;
  mode: Mode;
  K: number;
  pass: boolean;
  anomaly: string | null;
  fieldDiffs: string[];
  digestDiffCount: number;
  firstDivergentSimulation: number | null;
  simulations: number;
  nodesCreated: number;
  rolloutSteps: number;
  chanceSamples: number;
  ruleCalls: { baseline: number; prepared: number };
  impureFallbacks: number;
  treeDigest: string;
  planTraceDigest: string | null;
}

const simsCells: SimsCell[] = [];
// ---------------------------------------------------------------------------
// mode B — fixed maxNodes (the original 96-cell regression sweep)
// ---------------------------------------------------------------------------
interface NodeCell {
  root: string; mode: Mode; budget: number; pass: boolean; diffs: string[];
  simulations: number; nodesCreated: number; rolloutSteps: number; chanceSamples: number;
  ruleCalls: { baseline: number; prepared: number }; impureFallbacks: number; digest: string;
}
const nodeCells: NodeCell[] = [];

const started = Date.now();

if (legacyMode) {
  for (const root of selected) {
    for (const mode of modes) {
      for (const budget of kValues) {
        const seed = uctSeed(root.id, 'UCT-H', 0);
        const opts = { mode, seed, fixedNodes: budget };
        const base = runArm('baseline', root.state, opts);
        const prep = runArm('prepared', root.state, opts);
        const a = comparable(base.result);
        const b = comparable(prep.result);
        const diffs = diffCell(a, b);
        const prepDiag = (prep.result as { diagnostics: { rolloutImpureFallbacks?: number } }).diagnostics;
        nodeCells.push({
          root: root.id, mode, budget, pass: diffs.length === 0, diffs,
          simulations: a.diagnostics.simulations,
          nodesCreated: a.diagnostics.nodesCreated,
          rolloutSteps: a.diagnostics.rolloutSteps,
          chanceSamples: a.diagnostics.chanceSamples,
          ruleCalls: { baseline: base.ruleCalls, prepared: prep.ruleCalls },
          impureFallbacks: prepDiag.rolloutImpureFallbacks ?? 0,
          digest: a.digest,
        });
        process.stdout.write(
          `${diffs.length === 0 ? 'PASS' : 'FAIL'} ${root.id.padEnd(6)} ${mode.padEnd(6)} N=${String(budget).padEnd(4)} ` +
          `sims=${String(a.diagnostics.simulations).padEnd(4)} rules ${base.ruleCalls}->${prep.ruleCalls}\n`,
        );
        for (const d of diffs.slice(0, 12)) process.stdout.write(`      ${d}\n`);
      }
    }
  }
} else {
  for (const root of selected) {
    for (const mode of modes) {
      for (const K of kValues) {
        const seed = uctSeed(root.id, 'UCT-H', 0);
        const base = runPhase1Arm('UCT-H-BASELINE', root.state, seed, {
          completedSimulations: K, rollout: mode, maxNodes: PHASE1_MAX_NODES,
        });
        const prep = runPhase1Arm('UCT-H-PREPARED', root.state, seed, {
          completedSimulations: K, rollout: mode, maxNodes: PHASE1_MAX_NODES,
        });
        const anomaly = phase1ExecutionAnomaly(base, K) ?? phase1ExecutionAnomaly(prep, K);
        const diff = diffPhase1(base, prep);
        const pass = anomaly === null && diff.fieldDiffs.length === 0 && diff.digestDiffs.length === 0;
        simsCells.push({
          root: root.id, mode, K, pass, anomaly,
          fieldDiffs: diff.fieldDiffs,
          digestDiffCount: diff.digestDiffs.length,
          firstDivergentSimulation: diff.firstDivergentSimulation,
          simulations: base.result.diagnostics.simulations,
          nodesCreated: base.result.diagnostics.nodesCreated,
          rolloutSteps: base.result.diagnostics.rolloutSteps,
          chanceSamples: base.result.diagnostics.chanceSamples,
          ruleCalls: { baseline: base.ruleCalls, prepared: prep.ruleCalls },
          impureFallbacks: (prep.result.diagnostics as { rolloutImpureFallbacks?: number }).rolloutImpureFallbacks ?? 0,
          treeDigest: phase1Comparable(base).treeDigest,
          planTraceDigest: base.result.planTraceDigest === prep.result.planTraceDigest
            ? base.result.planTraceDigest : 'differ',
        });
        process.stdout.write(
          `${pass ? 'PASS' : 'FAIL'} ${root.id.padEnd(6)} ${mode.padEnd(6)} K=${String(K).padEnd(4)} ` +
          `sims=${String(base.result.diagnostics.simulations).padEnd(4)} ` +
          `nodes=${String(base.result.diagnostics.nodesCreated).padEnd(6)} rules ${base.ruleCalls}->${prep.ruleCalls}` +
          `${anomaly ? ` ANOMALY=${anomaly}` : ''}\n`,
        );
        if (!pass) {
          for (const d of diff.fieldDiffs.slice(0, 12)) process.stdout.write(`      ${d}\n`);
          for (const d of diff.digestDiffs.slice(0, 5)) process.stdout.write(`      sim#${d.index} ${d.baseline.slice(0, 16)} != ${d.prepared.slice(0, 16)}\n`);
        }
      }
    }
  }
}

const wallMs = Date.now() - started;

const out = legacyMode
  ? (() => {
      const passed = nodeCells.filter((c) => c.pass).length;
      const totalBase = nodeCells.reduce((s, c) => s + c.ruleCalls.baseline, 0);
      const totalPrep = nodeCells.reduce((s, c) => s + c.ruleCalls.prepared, 0);
      return {
        driver: 'parityFixedSims',
        label: smoke ? 'SMOKE_NOT_EVIDENCE' : arg('label', 'fixed-nodes-legacy'),
        phase: 'FIXED_NODE_PARITY',
        isPhase1: false,
        note: 'LEGACY MODE — fixed maxNodes sweep, kept byte-compatible with the previous 96-cell regression artefact.',
        generatedAt: new Date().toISOString(),
        wallMs, node: process.version,
        fixture: { path: 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', sha256: fixtureSha256, expected: ROOT_FIXTURE_SHA256 },
        config: {
          workload: 'maxNodes (legacy)',
          now: 'const 0 (deadline cannot fire)',
          maxNodes: kValues, maxHandoffs: MAX_HANDOFFS, c: UCB_C,
          rolloutModes: modes, seedFormula: "uctSeed(rootId,'UCT-H',0)",
        },
        cells: nodeCells,
        totals: {
          cells: nodeCells.length, passed, failed: nodeCells.length - passed,
          ruleCalls: { baseline: totalBase, prepared: totalPrep },
          savingFraction: totalBase === 0 ? 0 : 1 - totalPrep / totalBase,
          impureFallbacks: nodeCells.reduce((s, c) => s + c.impureFallbacks, 0),
        },
        verdict: passed === nodeCells.length ? 'PASS' : 'FAIL',
      };
    })()
  : (() => {
      const passed = simsCells.filter((c) => c.pass).length;
      const anomalies = simsCells.filter((c) => c.anomaly !== null).length;
      const totalBase = simsCells.reduce((s, c) => s + c.ruleCalls.baseline, 0);
      const totalPrep = simsCells.reduce((s, c) => s + c.ruleCalls.prepared, 0);
      return {
        driver: 'parityFixedSims',
        label: smoke ? 'SMOKE_NOT_EVIDENCE' : arg('label', 'fixed-sims'),
        phase: 'FIXED_COMPLETED_SIMULATION_PARITY',
        isPhase1: false,
        note: smoke
          ? 'SMOKE ONLY — proves the fixed-completed-simulation workload executes. Not the pre-registered 960-call Phase 1.'
          : 'Fixed completed-simulation parity over the selected roots. Still not the 960-call Phase 1 envelope.',
        generatedAt: new Date().toISOString(),
        wallMs, node: process.version,
        fixture: { path: 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', sha256: fixtureSha256, expected: ROOT_FIXTURE_SHA256 },
        config: {
          workload: 'maxCompletedSimulations (test-only seam)',
          now: 'const 0 (deadline cannot fire)',
          completedSimulations: kValues,
          maxNodesSafetyNet: PHASE1_MAX_NODES,
          maxHandoffs: MAX_HANDOFFS, c: UCB_C,
          rolloutModes: modes, seedFormula: "uctSeed(rootId,'UCT-H',0)",
        },
        cells: simsCells,
        totals: {
          cells: simsCells.length, passed, failed: simsCells.length - passed, anomalies,
          simulationsPerCell: kValues,
          ruleCalls: { baseline: totalBase, prepared: totalPrep },
          savingFraction: totalBase === 0 ? 0 : 1 - totalPrep / totalBase,
          impureFallbacks: simsCells.reduce((s, c) => s + c.impureFallbacks, 0),
        },
        verdict: passed === simsCells.length && anomalies === 0 ? 'PASS' : 'FAIL',
      };
    })();

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

const totals = out.totals as { cells: number; passed: number; failed: number; ruleCalls: { baseline: number; prepared: number } };
process.stdout.write(
  `\n${out.verdict}: ${totals.passed}/${totals.cells} cells | rule calls ${totals.ruleCalls.baseline} -> ${totals.ruleCalls.prepared} ` +
  `(${(100 * (1 - totals.ruleCalls.prepared / Math.max(1, totals.ruleCalls.baseline))).toFixed(2)}% fewer)\n` +
  `wrote ${outPath}\n`,
);
if (out.verdict !== 'PASS') process.exit(1);
