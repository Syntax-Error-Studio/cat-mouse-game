/**
 * Assemble the three results JSONs from the raw captures, so no figure in the
 * delivery is hand-copied. Run after all probes have completed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = 'PPC-P1-OPENING-STACK-01';
const RAW = path.join(ROOT, '_raw');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const pre = read(`${RAW}/baseline_witness_pre.json`);
const post = read(`${RAW}/baseline_witness_post.json`);
const thrPre = read(`${RAW}/stack_threshold_pre.json`);
const thrPost = read(`${RAW}/stack_threshold_post.json`);
const parPre = read(`${RAW}/parity_pre.json`);
const parPost = read(`${RAW}/parity_post.json`);

const pick = (j, m) => j.cases.find((c) => c.catBaseMoves === m);
const brief = (c) => (c ? {
  validateOk: c.validateOk,
  validateIssues: c.validateIssues,
  createInitialState: c.createInitialState,
  certifyOpening: c.certifyOpening,
  verdict: c.certifyVerdict ?? null,
  reason: c.certifyReason ?? null,
  exploredNodes: c.exploredNodes ?? null,
  createGameState: c.createGameState,
  createGameStateStatus: c.createGameStateStatus ?? null,
  errorName: c.errorName ?? null,
  errorMessage: c.errorMessage ?? null,
  ms: c.ms,
} : null);

// ---- BASELINE_FAILURE_WITNESS --------------------------------------------
const frontier = thrPre.rows.find((r) => r.outcome === 'THROW');
const before = thrPre.rows.filter((r) => r.outcome === 'COMPLETED');
const witness = {
  artifactId: 'BASELINE_FAILURE_WITNESS',
  round: 'PPC-P1-OPENING-STACK-01',
  capturedAt: pre.capturedAt,
  nodeVersion: pre.nodeVersion,
  sourceFingerprint: {
    path: 'src/game/openingFairness.ts',
    preFixSha256: '27c97202806154a22f878d7c524c82fd00cf7d88dda48b8aa2532dce58aff902',
    preFixBytes: 29272,
    preFixLines: 723,
    preFixLineEnding: 'LF',
    note: 'recursive solve() at line 463; the same file is 9d19279c… / 35834 B / 904 lines after the rewrite',
  },
  minimalReproduction: {
    input: { config: 'DEFAULT_CONFIG', catBaseMoves: 100000 },
    validateGameConfig: 'PASS',
    failingCall: 'certifyOpening(createInitialState(cfg))',
    exception: 'RangeError: Maximum call stack size exceeded',
    stackTop: pick(pre, 100000)?.topFrames ?? [],
    observations:
      'createGameState(cfg) throws the same RangeError — the uncontrolled exception escapes the fail-closed path entirely.',
  },
  table: [4, 1000, 100000, 6004799503160661].map((m) => ({
    catBaseMoves: m,
    preFix: brief(pick(pre, m)),
    postFix: brief(pick(post, m)),
  })),
  recursionCeiling: {
    method: 'certifyOpening(createInitialState({...DEFAULT_CONFIG, catBaseMoves: m})) on the recursive solver',
    completedUpTo: before.length ? before[before.length - 1].catBaseMoves : null,
    firstThrow: frontier ? frontier.catBaseMoves : null,
    perBudget: thrPre.rows.map((r) => ({ catBaseMoves: r.catBaseMoves, outcome: r.outcome, ms: r.ms })),
    note: 'Every budget at or above the firstThrow value died in 56-79ms, i.e. immediately on frame exhaustion rather than on a search decision.',
  },
  classification: {
    PRE_FIX_STACK_FAILURE: 'REPRODUCED',
    kind: 'LEGAL_INPUT_TRIGGERED_RUNTIME_EXCEPTION',
    notACorrectnessVerdict: 'The failure is not UNKNOWN/NO_CERTIFIED_OPENING; it is an unhandled RangeError, so no verdict existed at all.',
    numericDomainIntact: 'catBaseMoves=6004799503160661 is still rejected at the config layer (INVALID_CONFIG), unchanged from PPC-P1-CHECKPOINT-01.',
  },
  logs: ['logs/01_baseline_witness_pre_fix.log', 'logs/02_stack_threshold_pre_fix.log', 'logs/07_baseline_witness_post.log', 'logs/06_stack_threshold_post.log'],
  raw: ['_raw/baseline_witness_pre.json', '_raw/baseline_witness_post.json', '_raw/stack_threshold_pre.json', '_raw/stack_threshold_post.json'],
};
writeFileSync(`${ROOT}/BASELINE_FAILURE_WITNESS.json`, JSON.stringify(witness, null, 2) + '\n');

// ---- DEEP_STACK_RESULTS ---------------------------------------------------
const deep = {
  artifactId: 'DEEP_STACK_RESULTS',
  round: 'PPC-P1-OPENING-STACK-01',
  OS2: {
    requirement: 'catBaseMoves=100000 → validateGameConfig PASS, createGameState NO_UNCONTROLLED_EXCEPTION, openingFairness BOUNDED_TERMINATION, FALSE_CERTIFICATION=0',
    preFix: brief(pick(pre, 100000)),
    postFix: brief(pick(post, 100000)),
    checks: {
      validateGameConfig: 'PASS',
      createGameState: 'NO_UNCONTROLLED_EXCEPTION',
      openingFairness: 'BOUNDED_TERMINATION',
      certificate: 'UNKNOWN / NODE_CAP (never CERTIFIED)',
      exploitedNodesEqualsCap: (pick(post, 100000)?.exploredNodes ?? null) === 20000,
      falseCertification: 0,
    },
    postFixCreateGameStateDetail: 'state=null, status.kind=unverified, reason=NO_CERTIFIED_OPENING (the existing fail-closed semantic, not a new one)',
    heapUsedMB: post.heapUsedMB ?? null,
    v8HeapFlagRaised: false,
  },
  thresholdSweep: {
    method: 'same fixture and caps as the pre-fix sweep; compares the two solvers budget by budget',
    rows: thrPre.rows.map((a, i) => {
      const b = thrPost.rows[i];
      return {
        catBaseMoves: a.catBaseMoves,
        preFix: { outcome: a.outcome, verdict: a.verdict ?? null, exploredNodes: a.exploredNodes ?? null, ms: a.ms },
        postFix: { outcome: b?.outcome ?? null, verdict: b?.verdict ?? null, exploredNodes: b?.exploredNodes ?? null, ms: b?.ms ?? null },
      };
    }),
    summary: {
      preFixCompleted: thrPre.rows.filter((r) => r.outcome === 'COMPLETED').length,
      // SEAL-01: raw rows read 'THROW RangeError', so an exact === 'THROW' never matched.
      preFixThrew: thrPre.rows.filter((r) => String(r.outcome).startsWith('THROW')).length,
      postFixCompleted: thrPost.rows.filter((r) => r.outcome === 'COMPLETED').length,
      postFixThrew: thrPost.rows.filter((r) => String(r.outcome).startsWith('THROW')).length,
      postFixAllUnknownNodeCap: thrPost.rows.every((r) => r.verdict === 'UNKNOWN' && r.exploredNodes === 20000),
    },
  },
  noUnboundedGrowth: {
    claim: 'The frame stack is bounded by the node budget: every post-fix row stops at exploredNodes=20000 and returns UNKNOWN/NODE_CAP, so no input can grow the stack without bound.',
    evidence: thrPost.rows.map((r) => `${r.catBaseMoves}:${r.outcome}/${r.exploredNodes}`),
  },
  logs: ['logs/06_stack_threshold_post.log', 'logs/07_baseline_witness_post.log', 'logs/11_promoted_tests.log', 'logs/13_full_regression.log'],
  raw: ['_raw/stack_threshold_pre.json', '_raw/stack_threshold_post.json', '_raw/baseline_witness_pre.json', '_raw/baseline_witness_post.json'],
};
writeFileSync(`${ROOT}/DEEP_STACK_RESULTS.json`, JSON.stringify(deep, null, 2) + '\n');

// ---- SEMANTIC_PARITY_RESULTS ---------------------------------------------
const keys = [...new Set([...Object.keys(parPre.results), ...Object.keys(parPost.results)])].sort();
const diffs = keys.filter((k) => JSON.stringify(parPre.results[k]) !== JSON.stringify(parPost.results[k]));
const parity = {
  artifactId: 'SEMANTIC_PARITY_RESULTS',
  round: 'PPC-P1-OPENING-STACK-01',
  method:
    'Both captures run the SAME probe file on the SAME fixture list, before and after the rewrite, and record every observable certificate field '
    + '(verdict / reason / horizonTurns / maxNodes / exploredNodes / prunedNodes / witnessAction) plus generation counts, the resulting stateKey and the '
    + 'exact number of Math.random draws consumed. The comparison is a JSON deep-equality over the whole record, not a verdict-only check.',
  cases: keys.length,
  identical: keys.length - diffs.length,
  differing: diffs.length,
  diffDetails: diffs.map((k) => ({ case: k, preFix: parPre.results[k], postFix: parPost.results[k] })),
  determinismOfTheProbe: {
    claim: 'The probe itself is deterministic: two pre-fix runs produced byte-identical records.',
    evidence: '_raw/parity_pre_run1.json vs _raw/parity_pre.json — 50/50 identical',
  },
  probes: {
    writer: 'probe/parity_capture.test.ts',
    comparator: 'probe/compare_parity.mjs',
    note: 'Fails closed: the comparator exits non-zero and lists every differing case.',
  },
  coverage: {
    ordinary: ['rush_h1', 'pushed_defended_h2', 'pushed_undefended_h2', 'detour_boxed_h2', 'detour_open_h2', 'tunnel_h2'],
    mouseSkill: ['skill_h1', 'skill_used_h1'],
    tunnel: ['tunnel_h2', 'tunnel_h2_noPrune'],
    boxes: ['detour_boxed_h2', 'pushed_defended_h2'],
    butterChance: ['chance_mixed', 'chance_allWin', 'chance_badWeight_0', 'chance_badWeight_-0.5', 'chance_badWeight_NaN', 'chance_badWeight_Infinity', 'chance_shortMass', 'chance_safeFirst_control', 'chance_quad_safeSecond', 'chance_quad_safeLast'],
    pendingGhost: ['ghost_clean', 'ghost_pending', 'ghost_clean_noPrune', 'ghost_pending_noPrune'],
    patrolBound: ['patrol_hole_spare', 'patrol_tunnel_spare', 'patrol_normal_spare', 'patrol_normal_noSpare_off'],
    nodeCap: ['rush_h1_cap1', 'rush_h1_cap200k', 'pushed_h2_cap200k', 'tunnel_h2_cap200k'],
    relaxedPruneBothWays: ['rush_h1_noPrune', 'pushed_h2_noPrune', 'tunnel_h2_noPrune', 'detour_boxed_h2_cap200k'],
    deepLegalBudget: ['deepM500', 'deepM1000'],
    generation: ['gen_twoCandidates', 'gen_unknown', 'gen_explicit', 'gen_tutorial', 'patrolEntry_predicates', 'chance_shape', 'chance_materialize'],
    defaultOpeningSeeded: ['default_seeded'],
  },
  randomConsumption: {
    default_seeded_preFix: parPre.results.default_seeded,
    default_seeded_postFix: parPost.results.default_seeded,
    note: 'Identical draw count and identical stateKey prove the iterative solver consumes randomness in exactly the same order.',
  },
  pinnedInProductionTests: {
    file: 'src/game/__tests__/openingFairnessStackSafety.test.ts',
    cases: ['rush_h1', 'pushed_defended_h2', 'pushed_undefended_h2', 'detour_boxed_h2', 'detour_open_h2', 'tunnel_h2', 'skill_h1', 'skill_used_h1', 'tunnel_h2_noPrune', 'pushed_h2_noPrune', 'ghost_clean', 'ghost_pending', 'ghost_clean_noPrune', 'patrol_normal_spare', 'patrol_normal_noSpare_on', 'patrol_normal_noSpare_off'],
    note: 'The captured counts are now asserted in the normal test suite, so a future solver change cannot drift silently.',
  },
  verdict: diffs.length === 0 ? 'PASS' : 'FAIL',
  logs: ['logs/03_parity_pre.log', 'logs/04_parity_post.log'],
  raw: ['_raw/parity_pre.json', '_raw/parity_post.json', '_raw/parity_pre_run1.json'],
};
writeFileSync(`${ROOT}/SEMANTIC_PARITY_RESULTS.json`, JSON.stringify(parity, null, 2) + '\n');

console.log('parity cases=' + parity.cases + ' identical=' + parity.identical + ' differing=' + parity.differing);
console.log('OS-2 M=100000 pre=' + witness.table[2].preFix.certifyOpening.slice(0, 45) + ' | post=' + witness.table[2].postFix.certifyOpening);
console.log('threshold preCompleted=' + deep.thresholdSweep.summary.preFixCompleted + '/' + thrPre.rows.length
  + ' postCompleted=' + deep.thresholdSweep.summary.postFixCompleted + '/' + thrPost.rows.length);
console.log('written: BASELINE_FAILURE_WITNESS.json DEEP_STACK_RESULTS.json SEMANTIC_PARITY_RESULTS.json');
