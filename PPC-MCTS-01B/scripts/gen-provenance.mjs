/**
 * PPC-MCTS-01B-PHASE0 — provenance generator (read-only w.r.t. the repo).
 * Writes PPC-MCTS-01B/SOURCE_PROVENANCE.json.
 * Never includes its own hash or the output file's hash (self-reference).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const outDir = path.join(root, 'PPC-MCTS-01B');
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

function sha256(p) {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}
function sha256OrNull(p) {
  try { return sha256(p); } catch { return null; }
}

const sh = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();

const head = sh('git rev-parse HEAD');
const branch = sh('git rev-parse --abbrev-ref HEAD');
const statusLines = sh('git -c core.quotepath=false status --porcelain=v1').split('\n').filter(Boolean);
const tracked = new Set(sh('git ls-files').split('\n').filter(Boolean));
const modified = statusLines.filter((l) => /^ ?M/.test(l)).map((l) => l.slice(3).trim());
const untracked = statusLines.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());

const sourceRead = [
  'GAMEPLAY.md',
  'src/game/ai/preparedActions.ts',
  'src/game/ai/legalActions.ts',
  'src/game/ai/simulator.ts',
  'src/game/ai/stateCompare.ts',
  'src/game/ai/transposition.ts',
  'src/game/ai/hybridLeaf.ts',
  'src/game/ai/searchTypes.ts',
  'src/game/ai/evaluation.ts',
  'src/game/ai/expectiminimax.ts',
  'src/game/ai/hardHistory.ts',
  'src/game/ai/__tests__/preparedTransition.test.ts',
  'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json',
  'src/game/engine.ts',
  'src/game/config.ts',
  'src/game/rules/mobility.ts',
  'PPC-MCTS-01/proto/uct.ts',
  'PPC-MCTS-01/proto/chance.ts',
  'PPC-MCTS-01/proto/seededRng.ts',
  'PPC-MCTS-01/proto/value.ts',
];

const probeFiles = [
  'PPC-MCTS-01B/probe/vitest.config.mts',
  'PPC-MCTS-01B/probe/parity.test.ts',
  'PPC-MCTS-01B/probe/callsite.test.ts',
];

const artifacts = [
  'PPC-MCTS-01B/data/parity.json',
  'PPC-MCTS-01B/data/callsites.json',
  'PPC-MCTS-01B/logs/probe-run.log',
  'PPC-MCTS-01B/logs/run1/parity.run1.json',
  'PPC-MCTS-01B/logs/run1/callsites.run1.json',
  'PPC-MCTS-01B/logs/run2-parity.json',
  'PPC-MCTS-01B/logs/run2-callsites.json',
  'PPC-MCTS-01B/PREPARED_TRANSITION_CONTRACT_AUDIT.md',
  'PPC-MCTS-01B/CALLSITE_REUSE_MATRIX.md',
  'PPC-MCTS-01B/STATE_IMMUTABILITY_AND_CHANCE_AUDIT.md',
  'PPC-MCTS-01B/RECOMMENDATION.md',
];

const parity = JSON.parse(readFileSync(path.join(outDir, 'data/parity.json'), 'utf8'));
const callsites = JSON.parse(readFileSync(path.join(outDir, 'data/callsites.json'), 'utf8'));

const doc = {
  round: 'PPC-MCTS-01B-PHASE0',
  kind: 'READ_ONLY_AUDIT',
  generatedAt: new Date().toISOString(),
  generatedBy: 'PPC-MCTS-01B/scripts/gen-provenance.mjs',
  selfExcluded: ['PPC-MCTS-01B/SOURCE_PROVENANCE.json', 'PPC-MCTS-01B/SHA256SUMS.txt', 'PPC-MCTS-01B/scripts/gen-provenance.mjs'],
  git: {
    head,
    headMatchesBrief: head === '48eaac6c4f3801d351787696ba5876995b64e8d8',
    branch,
    branchMatchesBrief: branch === 'ppc/p1-id-state-identity-fix',
    statusEntryCount: statusLines.length,
    trackedModifiedCount: modified.length,
    trackedModified: modified,
    untrackedTopLevel: [...new Set(untracked.map((p) => p.split('/')[0]))].sort(),
    auditStartStatusEntryCount: 67,
    auditEndStatusEntryCount: statusLines.length,
    delta: [
      'PPC-MCTS-01B/ (created by this round — expected)',
      'PPC-D2-PCV-COUNTERLINE-01/ (NOT created by this round — written by a sibling audit round on the same workspace at 17:10-17:13; not read, not modified, not killed)',
    ],
    concurrentWorkspaceChangeNote:
      'A sibling audit round (PPC-D2-PCV-COUNTERLINE-01/) wrote D2_SEARCH_CONTRACT.md and PHASE_STATUS.json into the workspace during this audit window, and per .workbuddy/memory/2026-11-16.md that round stopped on its own resource-admission gate while observing this round\'s probe processes. It does not touch src/, GAMEPLAY.md or PPC-MCTS-01/; this round neither read, modified nor killed anything in it. This round\'s probes were single-process (maxWorkers=1) one-off runs of roughly 4 minutes total — within HEAVY_WORKER_CONCURRENCY=1, but their time window did overlap the sibling round, which is disclosed here rather than hidden.',
  },
  rulesAuthority: {
    path: 'GAMEPLAY.md',
    sha256: sha256('GAMEPLAY.md'),
    matchesPilotReport: sha256('GAMEPLAY.md') === 'e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34',
  },
  rootFixture: {
    path: 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json',
    sha256: sha256('src/game/ai/__tests__/fixtures/ppcId01-human-roots.json'),
    matchesPilotReport: '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09',
    roots: parity.totals.roots,
  },
  sourceRead: sourceRead.map((p) => ({
    path: p,
    sha256: sha256OrNull(p),
    gitTracked: tracked.has(p),
    worktreeModified: modified.includes(p),
  })),
  probe: {
    files: probeFiles.map((p) => ({ path: p, sha256: sha256OrNull(p) })),
    command: 'npx vitest run --config PPC-MCTS-01B/probe/vitest.config.mts',
    concurrency: { maxWorkers: 1, minWorkers: 1, fileParallelism: false, note: 'HEAVY_WORKER_CONCURRENCY=1 / SERIAL' },
    runs: 2,
    determinism:
      'two independent runs of the FINAL probe code produced byte-identical data/parity.json and data/callsites.json (logs/run2-* are pre-rerun backups of those same bytes). logs/run1/ holds snapshots from an EARLIER probe version (BFS depth 4) and is history only — see logs/run1/README.txt.',
    parity: {
      states: parity.totals.states,
      candidates: parity.totals.candidates,
      legal: parity.totals.legal,
      illegalCandidates: parity.totals.illegalCandidates,
      deterministicTransitions: parity.totals.deterministicTransitions,
      chanceTransitions: parity.totals.chanceTransitions,
      chanceOutcomes: parity.totals.chanceOutcomes,
      multiPathHits: parity.totals.multiPathHits,
      droppedStates: parity.totals.droppedStates,
      bfsMaxDepth: parity.provenance.bfsMaxDepth,
      bfsMaxStatesPerRoot: parity.provenance.bfsMaxStatesPerRoot,
      mismatches: parity.mismatches.length,
      evalUnstable: parity.evaluationStability.unstable.length,
      reuseUnstable: parity.reuseReadStability.unstable.length,
      trapButterOverlapStates: parity.trapButterOverlapStates.length,
      emptyLegalWhilePlaying: parity.emptyLegalWhilePlaying.length,
      ruleCalls: parity.ruleCalls,
    },
    callsites: {
      termination: callsites.provenance.termination,
      roots: callsites.provenance.roots,
      modes: callsites.provenance.modes,
      totalRuleCalls: callsites.totalRuleCalls,
      preparedRuleCalls: callsites.preparedRuleCalls,
      removableByReuse: callsites.removableByReuse,
      savingFraction: Number(callsites.savingFraction.toFixed(6)),
      categoryTotals: callsites.categoryTotals,
      unknownTotal: callsites.unknownTotal,
    },
  },
  existingTestsRerun: {
    file: 'src/game/ai/__tests__/preparedTransition.test.ts',
    command: 'npx vitest run src/game/ai/__tests__/preparedTransition.test.ts',
    result: '18 passed / 1 file / 0 failed',
    wallClockMs: 176,
  },
  artifacts: artifacts.map((p) => ({ path: p, sha256: sha256OrNull(p) })),
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    vitest: '4.1.10',
    logicalCores: 24,
    note: 'probe results are computed with now: () => 0 (no wall clock), so they are load-independent',
  },
  notTouched: [
    'src/** (no byte changed by this round)',
    'GAMEPLAY.md',
    'PPC-MCTS-01/** (Pilot artifacts and proto/uct.ts untouched; read-only import)',
    'PPC-MCTS-01A/**',
    'any git operation beyond read (no add/commit/push/merge/reset/stash/checkout/clean)',
  ],
  notPerformed: [
    'PPC-MCTS-01 pilot / 1700-group Formal V2 / self-play',
    'any wall-clock benchmark or fresh-process batch',
    'any change to budgets, UCB1, c, maxHandoffs, maxNodes, Hybrid evaluation, CHANCE weights',
    'production Hard AI integration',
  ],
  resourceSafety: {
    duplicateBenchmarkCheck: 'no node process running runPilot.mjs / bench.mjs / long vitest; out/raw untouched (20 files)',
    concurrency: 1,
    heavyRunsPerformed: 0,
  },
};

writeFileSync(path.join(outDir, 'SOURCE_PROVENANCE.json'), `${JSON.stringify(doc, null, 2)}\n`);
console.log('wrote SOURCE_PROVENANCE.json');
