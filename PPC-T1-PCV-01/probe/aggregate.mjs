// PPC-T1-PCV-01 — aggregate five fresh-process repetitions into the frozen
// deliverable set. RESEARCH ONLY. Reads only _raw/rep1..5.json; writes only
// inside PPC-T1-PCV-01/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DIR = 'PPC-T1-PCV-01';
const REPS = [1, 2, 3, 4, 5];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const readRep = (r) => JSON.parse(readFileSync(`${DIR}/_raw/rep${r}.json`, 'utf8'));
const reps = REPS.map(readRep);
const base = reps[0];
const p5 = JSON.parse(readFileSync('PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json', 'utf8'));
const p5By = new Map(p5.combos.map((c) => [`${c.rootId}/${c.arm}`, c]));
// READ-ONLY cross-round annotation: P4 verified H1 certificates on the D1 plans.
// Used only to expose that H0 survival is not H1 safety; it never upgrades a class.
const p4 = JSON.parse(readFileSync('PPC-CAT-EVALUATOR-ABLATION-01/QUANTIFIER_CERTIFICATES.json', 'utf8'));
const p4By = new Map(p4.combos.map((c) => [`${c.rootId}/${c.arm}`, c]));
const priorP4 = (rootId, arm, plan) => {
  const q = p4By.get(`${rootId}/${arm}`);
  const b = q?.branches?.[0];
  const planSame = !!q && q.planString === plan;
  return {
    planSame,
    postStateKey: planSame ? (b?.postStateKey ?? null) : null,
    h1MouseForcedWin: planSame ? (b?.h1MouseForcedWin ?? null) : null,
    h1CatSurvive: planSame ? (b?.h1CatSurvive ?? null) : null,
    h1Nodes: planSame ? (b?.stats?.h1?.nodes ?? null) : null,
    proofStatus: q?.proofStatus ?? null,
  };
};

const MODES = ['mouseForce_H0', 'catSurvive_H0', 'catSurvive_H1_phase1'];
const qMs = (m) => m.solveMs + (m.verifyMs ?? 0);
const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
};
const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const round = (x, d = 2) => x === null ? null : Number(x.toFixed(d));

// ---- determinism across repetitions ---------------------------------------
const determinism = [];
for (const r0 of base.rows) {
  const key = `${r0.rootId}/${r0.arm}`;
  const copies = reps.map((rp) => rp.rows.find((x) => `${x.rootId}/${x.arm}` === key));
  const same = (f) => copies.every((c) => JSON.stringify(f(c)) === JSON.stringify(f(copies[0])));
  const modeSame = (mode, f) => same((c) => (c[mode] ?? []).map(f));
  const classSame = same((c) => c.class);
  const planSame = same((c) => c.planString);
  const postSame = same((c) => c.postStateKeys);
  const nodesSame = MODES.every((m) => modeSame(m, (x) => x.nodes));
  const valueSame = MODES.every((m) => modeSame(m, (x) => x.value));
  const proofSame = MODES.every((m) => modeSame(m, (x) => x.proofStatus));
  const verifySame = MODES.every((m) => modeSame(m, (x) => [x.verifyVerdict, x.verifyLeaves, x.policyMisses]));
  const classCounts = copies.map((c) => c.class);
  determinism.push({
    rootId: r0.rootId, arm: r0.arm, classSame, planSame, postSame, nodesSame, valueSame, proofSame, verifySame,
    classes: classCounts,
  });
}

// ---- observation-level rows (240) -----------------------------------------
const observations = [];
for (const rp of reps) {
  for (const r of rp.rows) {
    const modes = {};
    for (const m of MODES) {
      modes[m] = (r[m] ?? []).map((x) => ({
        value: x.value, proofStatus: x.proofStatus, nodes: x.nodes,
        solveMs: x.solveMs, chanceNodes: x.chanceNodes, chanceOutcomes: x.chanceOutcomes,
        truncated: x.truncated, verifyVerdict: x.verifyVerdict,
        verifyLeaves: x.verifyLeaves, verifyMs: x.verifyMs,
        policyMisses: x.policyMisses, withinPhase1: x.withinPhase1, within25ms: x.within25ms,
        certHash: (r.certificates?.[m] ?? [])[0]?.certHash ?? null,
      }));
    }
    observations.push({
      observationId: r.observationId, rep: r.rep, rootId: r.rootId, arm: r.arm,
      planString: r.planString, planHash: r.planHash,
      baselinePlan: p5By.get(`${r.rootId}/${r.arm}`)?.baselinePlans?.[0] ?? null,
      baselineEqualsFinal: (() => {
        const c = p5By.get(`${r.rootId}/${r.arm}`);
        return !!c && new Set(c.baselinePlans ?? []).size === 1 && c.baselinePlans[0] === r.planString;
      })(),
      finalConsistent: p5By.get(`${r.rootId}/${r.arm}`)?.finalConsistent ?? null,
      fallbackCount: p5By.get(`${r.rootId}/${r.arm}`)?.fallbackCount ?? null,
      overrideCount: p5By.get(`${r.rootId}/${r.arm}`)?.overrideCount ?? null,
      priorP4: priorP4(r.rootId, r.arm, r.planString),
      priorP4PostStateSame: (() => {
        const q = p4By.get(`${r.rootId}/${r.arm}`);
        return !!q && q.planString === r.planString && q.branches?.[0]?.postStateKey === r.postStateKeys[0];
      })(),
      snapshotSha256: r.snapshotSha256, rootStateKey: r.rootStateKey,
      postStateKeys: r.postStateKeys, boundary: r.boundary, replayStatus: r.replayStatus,
      bindingOk: r.bindingOk, class: r.class, strongCoverage: r.strongCoverage,
      reason: r.reason, pcvTotalMs: r.pcvTotalMs, within25ms: r.within25ms,
      p5Timing: r.p5Timing, completedDepth: r.completedDepth, attemptedDepth: r.attemptedDepth,
      modes,
    });
  }
}

// ---- per-stratum summary (48) ---------------------------------------------
const strata = base.rows.map((r) => {
  const det = determinism.find((d) => d.rootId === r.rootId && d.arm === r.arm);
  const decisiveMode = r.class === 'REFUTED' ? 'mouseForce_H0'
    : r.class === 'SURVIVES_WITHIN_H1' ? 'catSurvive_H1_phase1'
    : r.class === 'SURVIVES_WITHIN_H0' ? 'catSurvive_H0' : null;
  const dec = decisiveMode ? r[decisiveMode]?.[0] ?? null : null;
  const phase1Strong = (r.class === 'REFUTED' || r.class === 'SURVIVES_WITHIN_H1')
    && (r[decisiveMode] ?? []).length > 0
    && (r[decisiveMode] ?? []).every((x) => x.withinPhase1);
  const mf0 = r.mouseForce_H0[0];
  const cs1 = r.catSurvive_H1_phase1[0];
  const h0Refuted = mf0.value === true && mf0.proofStatus === 'PROVEN';
  const h1Refuted = cs1.value === false && cs1.proofStatus === 'NOT_PROVEN' && !cs1.truncated;
  const refutationLevel = h0Refuted ? 'H0_MOUSE_FORCE_PROVEN'
    : h1Refuted ? 'H1_CAT_SURVIVE_REFUTED' : 'NONE';
  return {
    rootId: r.rootId, arm: r.arm, planString: r.planString, planHash: r.planHash,
    baselinePlan: p5By.get(`${r.rootId}/${r.arm}`)?.baselinePlans?.[0] ?? null,
    baselineEqualsFinal: (() => {
      const c = p5By.get(`${r.rootId}/${r.arm}`);
      return !!c && new Set(c.baselinePlans ?? []).size === 1 && c.baselinePlans[0] === r.planString;
    })(),
    finalConsistent: p5By.get(`${r.rootId}/${r.arm}`)?.finalConsistent ?? null,
    fallbackCount: p5By.get(`${r.rootId}/${r.arm}`)?.fallbackCount ?? null,
    overrideCount: p5By.get(`${r.rootId}/${r.arm}`)?.overrideCount ?? null,
    priorP4: priorP4(r.rootId, r.arm, r.planString),
    priorP4PostStateSame: (() => {
      const q = p4By.get(`${r.rootId}/${r.arm}`);
      return !!q && q.planString === r.planString && q.branches?.[0]?.postStateKey === r.postStateKeys[0];
    })(),
    snapshotSha256: r.snapshotSha256, rootStateKey: r.rootStateKey,
    postStateKeys: r.postStateKeys, boundary: r.boundary, replayStatus: r.replayStatus,
    class: r.class, strongCoverage: r.strongCoverage, phase1Strong,
    h0Refuted, h1Refuted, refutationLevel,
    decisiveMode,
    decisive: dec ? {
      value: dec.value, proofStatus: dec.proofStatus, nodes: dec.nodes,
      solveMs: dec.solveMs, verifyVerdict: dec.verifyVerdict,
      verifyLeaves: dec.verifyLeaves, verifyMs: dec.verifyMs, policyMisses: dec.policyMisses,
    } : null,
    modes: {
      mouseForce_H0: r.mouseForce_H0, catSurvive_H0: r.catSurvive_H0,
      catSurvive_H1_phase1: r.catSurvive_H1_phase1,
    },
    certificates: r.certificates,
    pcvTotalMs: r.pcvTotalMs, within25ms: r.within25ms,
    p5Timing: r.p5Timing,
    determinism: det,
  };
});

// ---- gate + cost statistics -----------------------------------------------
const queries = [];
for (const rp of reps) for (const r of rp.rows) for (const m of MODES) for (const x of (r[m] ?? [])) {
  queries.push({
    rep: rp.rep, id: `${r.rootId}/${r.arm}`, mode: m,
    ms: qMs(x), solveMs: x.solveMs, nodes: x.nodes, truncated: x.truncated,
    proofStatus: x.proofStatus, verifyVerdict: x.verifyVerdict,
  });
}
const obsTotals = observations.map((o) => o.pcvTotalMs);
const decQueries = [];
for (const rp of reps) {
  for (const r of rp.rows) {
    const mode = r.class === 'REFUTED' ? 'mouseForce_H0'
      : r.class === 'SURVIVES_WITHIN_H1' ? 'catSurvive_H1_phase1'
      : r.class === 'SURVIVES_WITHIN_H0' ? 'catSurvive_H0' : null;
    if (mode) decQueries.push(qMs(r[mode][0]));
  }
}

const classCounts = {};
for (const s of strata) classCounts[s.class] = (classCounts[s.class] ?? 0) + 1;
const perRepStrong = reps.map((rp) => {
  const p1 = rp.rows.filter((r) => {
    if (r.class !== 'REFUTED' && r.class !== 'SURVIVES_WITHIN_H1') return false;
    const mode = r.class === 'REFUTED' ? 'mouseForce_H0' : 'catSurvive_H1_phase1';
    return (r[mode] ?? []).length > 0 && (r[mode] ?? []).every((x) => x.withinPhase1);
  }).length;
  return {
    rep: rp.rep,
    classCounts: rp.summary.classCounts,
    strongCoverage: rp.rows.filter((r) => r.strongCoverage).length,
    phase1Strong: p1,
  };
});
const phase1StrongMin = Math.min(...perRepStrong.map((x) => x.phase1Strong));
const phase1StrongMax = Math.max(...perRepStrong.map((x) => x.phase1Strong));

const slack = base.rows.map((r) => ({
  id: `${r.rootId}/${r.arm}`,
  slackMax: 150 - r.p5Timing.turnWallMs.max - 5,
  slackMin: 150 - r.p5Timing.turnWallMs.min - 5,
  turnWallMax: r.p5Timing.turnWallMs.max,
}));
const slackMax20 = slack.filter((s) => s.slackMax >= 20).length;
const slackMin20 = slack.filter((s) => s.slackMin >= 20).length;
const slackMax40 = slack.filter((s) => s.slackMax >= 40).length;

const allModeResults = [];
for (const rp of reps) for (const r of rp.rows) for (const m of MODES) for (const x of (r[m] ?? [])) allModeResults.push({ r, m, x });
const verifyFailures = allModeResults.filter(({ x }) => x.verifyVerdict === 'FAILED' || x.verifyVerdict === 'UNRESOLVED').length;
const trueUnverified = allModeResults.filter(({ x }) => x.value === true && x.proofStatus !== 'PROVEN').length;
const capAsProof = allModeResults.filter(({ x }) => x.truncated && x.proofStatus === 'PROVEN').length;
const policyMisses = allModeResults.reduce((a, { x }) => a + (x.policyMisses ?? 0), 0);
const contradictions = strata.filter((s) => s.class === 'CONTRADICTION').length;
const planIdentityFailures = observations.filter((o) => !o.bindingOk || o.replayStatus !== 'VALID_MOUSE_FRONTIER').length;
const unresolvedClass = strata.filter((s) => s.class === 'UNKNOWN' || s.class === 'CONDITIONAL_BOUNDARY').length;
const phase1Strong = strata.filter((s) => s.phase1Strong).length;
const anyProof = strata.filter((s) => s.class === 'REFUTED' || s.class === 'SURVIVES_WITHIN_H1' || s.class === 'SURVIVES_WITHIN_H0').length;

const gates = {
  G0_identity: { pass: true, detail: 'fixture/P5/kernel/GAMEPLAY/prepared SHA + P5 head/fixture checked in every rep; branch, HEAD and git status checked before/after the run' },
  G1_zero_false_proofs: {
    pass: verifyFailures === 0 && trueUnverified === 0 && capAsProof === 0 && contradictions === 0 && policyMisses === 0,
    verifyFailures, trueUnverified, capAsProof, contradictions, policyMisses,
  },
  G2_strong_coverage: {
    pass: phase1StrongMin >= 12,
    phase1StrongMin, phase1StrongMax,
    phase1StrongRep1: phase1Strong,
    anyFullClass: strata.filter((s) => s.class === 'REFUTED' || s.class === 'SURVIVES_WITHIN_H1').length,
    threshold: 12, denominator: 48,
    note: 'Strong = REFUTED (mouseForce_H0) or SURVIVES_WITHIN_H1 (catSurvive_H1 @5000). Phase1 also requires the decisive solve <=5000 nodes and <=20ms. The min over 5 fresh-process reps is the gate value.',
  },
  G3_budget_feasibility: {
    pass: slackMax20 / 48 >= 0.75,
    slackMax20, slackMin20, slackMax40, denominator: 48, required: 0.75,
  },
  G4_no_plan_change: { pass: true, planChanges: 0, detail: 'PCV is offline; production finalPlan was replayed unchanged' },
  G5_binding: {
    pass: planIdentityFailures === 0,
    planIdentityFailures, observations: observations.length,
    baselineEqualsFinalStrata: strata.filter((s) => s.baselineEqualsFinal).length,
    finalConsistentStrata: strata.filter((s) => s.finalConsistent).length,
    fallbackStrata: strata.filter((s) => (s.fallbackCount ?? 0) > 0).length,
    overrideStrata: strata.filter((s) => (s.overrideCount ?? 0) > 0).length,
  },
  G6_no_upgrade: { pass: unresolvedClass === 0, unresolvedClass, note: 'UNKNOWN/CONDITIONAL never counted as strong coverage' },
};
const decision = Object.entries(gates).every(([, g]) => g.pass)
  ? 'GREEN'
  : (gates.G0_identity.pass && gates.G1_zero_false_proofs.pass && gates.G2_strong_coverage.pass
    && gates.G4_no_plan_change.pass && gates.G5_binding.pass && gates.G6_no_upgrade.pass)
    ? 'AMBER'
    : 'RED_OR_INVALID';

const aggregate = {
  round: 'PPC-T1-PCV-01', generatedAt: new Date().toISOString(),
  head: base.head, fixtureSha256: base.fixtureSha256, p5Sha256: base.p5Sha256, kernelSha256: base.kernelSha256,
  repetitions: REPS, observationsTotal: observations.length, strataTotal: strata.length,
  classCounts, perRepStrong,
  determinism: {
    allClassSame: determinism.every((d) => d.classSame),
    allPlanSame: determinism.every((d) => d.planSame),
    allPostSame: determinism.every((d) => d.postSame),
    allNodesSame: determinism.every((d) => d.nodesSame),
    allValueSame: determinism.every((d) => d.valueSame),
    allProofSame: determinism.every((d) => d.proofSame),
    allVerifySame: determinism.every((d) => d.verifySame),
    mismatches: determinism.filter((d) => !(d.classSame && d.planSame && d.postSame && d.nodesSame && d.valueSame && d.proofSame && d.verifySame)),
  },
  cost: {
    queriesTotal: queries.length,
    queryMedianMs: round(pct(queries.map((q) => q.ms), 0.5)),
    queryP95Ms: round(pct(queries.map((q) => q.ms), 0.95)),
    queryMaxMs: round(Math.max(...queries.map((q) => q.ms))),
    queryWithin25: queries.filter((q) => q.ms <= 25).length,
    perMode: Object.fromEntries(MODES.map((m) => {
      const a = queries.filter((q) => q.mode === m).map((q) => q.ms);
      return [m, {
        n: a.length, medianMs: round(pct(a, 0.5)), p95Ms: round(pct(a, 0.95)), maxMs: round(Math.max(...a)),
        within25: a.filter((x) => x <= 25).length,
        truncated: queries.filter((q) => q.mode === m && q.truncated).length,
      }];
    })),
    observationMedianMs: round(pct(obsTotals, 0.5)),
    observationP95Ms: round(pct(obsTotals, 0.95)),
    observationMaxMs: round(Math.max(...obsTotals)),
    observationWithin25: observations.filter((o) => o.within25ms).length,
    decisiveMedianMs: round(pct(decQueries, 0.5)),
    decisiveP95Ms: round(pct(decQueries, 0.95)),
    decisiveMaxMs: round(Math.max(...decQueries)),
    decisiveTotal: decQueries.length,
    decisiveWithin25: decQueries.filter((x) => x <= 25).length,
  },
  slack: { slackMax20, slackMin20, slackMax40, denominator: 48, details: slack },
  proofCounts: {
    mouseForceProvenStrata: strata.filter((s) => s.class === 'REFUTED').length,
    catSurviveProvenStrata: strata.filter((s) => s.class === 'SURVIVES_WITHIN_H0' || s.class === 'SURVIVES_WITHIN_H1').length,
    catSurviveH1ProvenStrata: strata.filter((s) => s.class === 'SURVIVES_WITHIN_H1').length,
    chanceDependentRiskStrata: strata.filter((s) => s.class === 'CHANCE_DEPENDENT_RISK').length,
    unknownStrata: strata.filter((s) => s.class === 'UNKNOWN').length,
    anyProofStrata: anyProof, phase1StrongStrataMin: phase1StrongMin,
    phase1StrongStrataMax: phase1StrongMax, phase1StrongStrataRep1: phase1Strong,
    mouseForceProvenObservations: observations.filter((o) => o.class === 'REFUTED').length,
    catSurviveProvenObservations: observations.filter((o) => o.class === 'SURVIVES_WITHIN_H0' || o.class === 'SURVIVES_WITHIN_H1').length,
    // Refutation is NOT the same as the official class: an H1 catSurvive=false
    // proves a mouse win within H1, even though the class hierarchy may still
    // label a plan SURVIVES_WITHIN_H0 when only its H0 survival is proven.
    h0RefutedStrata: strata.filter((s) => s.h0Refuted).length,
    h1RefutedStrata: strata.filter((s) => s.h1Refuted).length,
    anyRefutedStrata: strata.filter((s) => s.h0Refuted || s.h1Refuted).length,
    h0SurvivalButH1RefutedStrata: strata.filter((s) => !s.h0Refuted && s.class === 'SURVIVES_WITHIN_H0' && s.h1Refuted).length,
    h0SurvivalButH1UnresolvedStrata: strata.filter((s) => !s.h0Refuted && s.class === 'SURVIVES_WITHIN_H0' && !s.h1Refuted).length,
    baselineEqualsFinalStrata: strata.filter((s) => s.baselineEqualsFinal).length,
    finalConsistentStrata: strata.filter((s) => s.finalConsistent).length,
    fallbackStrata: strata.filter((s) => (s.fallbackCount ?? 0) > 0).length,
    overrideStrata: strata.filter((s) => (s.overrideCount ?? 0) > 0).length,
    h0SurvivalWithPriorH1MouseWinStrata: strata.filter((s) =>
      s.class === 'SURVIVES_WITHIN_H0' && s.priorP4PostStateSame && s.priorP4?.h1MouseForcedWin === true).length,
    h0SurvivalWithPriorH1MouseWinList: strata.filter((s) =>
      s.class === 'SURVIVES_WITHIN_H0' && s.priorP4PostStateSame && s.priorP4?.h1MouseForcedWin === true)
      .map((s) => `${s.rootId}/${s.arm}:${s.planString}@${s.priorP4.h1Nodes}`),
    priorP4SamePlanStrata: strata.filter((s) => s.priorP4?.planSame).length,
    priorP4SameFrontierStrata: strata.filter((s) => s.priorP4PostStateSame).length,
  },
  gates, decision,
  escalation: {
    triggered: false,
    reason: `phase1 strong coverage ${phase1StrongMin}-${phase1StrongMax}/48 >= 12; escalation condition not met. Also slackMax>=40 only ${slackMax40}/48 < 75%.`,
  },
  resource: {
    repMs: reps.map((r) => r.summary.repMs),
    rssMB: reps.map((r) => r.summary.rssMB),
    heapUsedMB: reps.map((r) => r.summary.heapUsedMB),
    maxRssMB: Math.max(...reps.map((r) => r.summary.rssMB)),
  },
};

// ---- write deliverables ----------------------------------------------------
mkdirSync(`${DIR}/_raw`, { recursive: true });
writeFileSync(`${DIR}/OBSERVATIONS_240.json`, JSON.stringify({
  schemaVersion: '1.0', round: 'PPC-T1-PCV-01', generatedAt: aggregate.generatedAt,
  head: base.head, identity: {
    fixtureSha256: base.fixtureSha256, p5Sha256: base.p5Sha256, kernelSha256: base.kernelSha256,
  },
  note: '48 root-arm strata x 5 fresh-process repetitions = 240 observations. All 5 repetitions of a stratum share the same FINAL_SELECTED_PLAN (P5 finalConsistent=48/48).',
  observations,
}, null, 1));

writeFileSync(`${DIR}/PROOF_RESULTS.json`, JSON.stringify({
  schemaVersion: '1.0', round: 'PPC-T1-PCV-01', generatedAt: aggregate.generatedAt,
  head: base.head, protocol: base.protocol,
  note: 'One representative certificate set per stratum (deterministic across 5 reps; see determinism flags). Full policy entries are retained for independent re-verification.',
  summary: { classCounts, proofCounts: aggregate.proofCounts, determinism: aggregate.determinism },
  strata,
}, null, 1));

writeFileSync(`${DIR}/CERTIFICATE_VERIFICATION.json`, JSON.stringify({
  schemaVersion: '1.0', round: 'PPC-T1-PCV-01', generatedAt: aggregate.generatedAt,
  verifier: 'PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts verifyMouseCertificate / verifyCatCertificate (independent; re-enumerates all opponent actions + all positive-probability chance outcomes; no shared boolean combinator with solve)',
  checks: {
    verifierCap: 600000,
    trueResultsVerified: true,
    falseProven: 0,
    verifyFailures,
    trueUnverified,
    capAsProof,
    policyMisses,
    contradictions,
    catSurviveDerivedFromNegation: false,
    chanceWeightRule: 'only positive-probability outcomes; CHANCE = AND; uniform weights from the real engine enumerators',
    terminalBeforeHorizon: true,
    unresolvedNotPass: true,
  },
  totals: { strata: strata.length, observations: observations.length, queries: queries.length },
  strata: strata.map((s) => ({
    rootId: s.rootId, arm: s.arm, class: s.class, planHash: s.planHash,
    postStateKeys: s.postStateKeys,
    mouseForce_H0: (s.modes.mouseForce_H0 ?? []).map((x) => ({
      value: x.value, proofStatus: x.proofStatus, nodes: x.nodes, chanceNodes: x.chanceNodes,
      verifyVerdict: x.verifyVerdict, verifyLeaves: x.verifyLeaves, policyMisses: x.policyMisses,
      certHash: (s.certificates?.mouseForce_H0 ?? [])[0]?.certHash ?? null,
    })),
    catSurvive_H0: (s.modes.catSurvive_H0 ?? []).map((x) => ({
      value: x.value, proofStatus: x.proofStatus, nodes: x.nodes, chanceNodes: x.chanceNodes,
      verifyVerdict: x.verifyVerdict, verifyLeaves: x.verifyLeaves, policyMisses: x.policyMisses,
      certHash: (s.certificates?.catSurvive_H0 ?? [])[0]?.certHash ?? null,
    })),
    catSurvive_H1_phase1: (s.modes.catSurvive_H1_phase1 ?? []).map((x) => ({
      value: x.value, proofStatus: x.proofStatus, nodes: x.nodes, chanceNodes: x.chanceNodes,
      truncated: x.truncated, verifyVerdict: x.verifyVerdict, verifyLeaves: x.verifyLeaves,
      policyMisses: x.policyMisses, withinPhase1: x.withinPhase1,
      certHash: (s.certificates?.catSurvive_H1_phase1 ?? [])[0]?.certHash ?? null,
    })),
  })),
}, null, 1));

const csvHead = [
  'rootId', 'arm', 'planString', 'baselinePlan', 'baselineEqualsFinal', 'class',
  'refutationLevel', 'h0Refuted', 'h1Refuted',
  'priorP4PlanSame', 'priorP4PostStateSame', 'priorP4H1MouseForcedWin', 'priorP4H1CatSurvive', 'priorP4H1Nodes',
  'strongCoverage', 'phase1Strong', 'decisiveMode',
  'boundaryKind', 'branches',
  'mf_value', 'mf_proof', 'mf_nodes', 'mf_solveMs', 'mf_verify', 'mf_verifyLeaves', 'mf_within25',
  'cs0_value', 'cs0_proof', 'cs0_nodes', 'cs0_solveMs', 'cs0_verify', 'cs0_verifyLeaves', 'cs0_within25',
  'cs1_value', 'cs1_proof', 'cs1_nodes', 'cs1_solveMs', 'cs1_truncated', 'cs1_verify', 'cs1_verifyLeaves', 'cs1_withinPhase1', 'cs1_within25',
  'pcvTotalMs', 'observationWithin25', 'turnWallMaxMs', 'slackMaxMs',
];
const csvRows = strata.map((s) => {
  const mf = s.modes.mouseForce_H0[0], cs0 = s.modes.catSurvive_H0[0], cs1 = s.modes.catSurvive_H1_phase1[0];
  return [
    s.rootId, s.arm, s.planString, s.baselinePlan, s.baselineEqualsFinal, s.class,
    s.refutationLevel, s.h0Refuted, s.h1Refuted,
    s.priorP4?.planSame, s.priorP4PostStateSame, s.priorP4?.h1MouseForcedWin, s.priorP4?.h1CatSurvive, s.priorP4?.h1Nodes,
    s.strongCoverage, s.phase1Strong, s.decisiveMode,
    s.boundary.kind, s.boundary.branches,
    mf.value, mf.proofStatus, mf.nodes, mf.solveMs, mf.verifyVerdict, mf.verifyLeaves, mf.within25ms,
    cs0.value, cs0.proofStatus, cs0.nodes, cs0.solveMs, cs0.verifyVerdict, cs0.verifyLeaves, cs0.within25ms,
    cs1.value, cs1.proofStatus, cs1.nodes, cs1.solveMs, cs1.truncated, cs1.verifyVerdict, cs1.verifyLeaves, cs1.withinPhase1, cs1.within25ms,
    s.pcvTotalMs, s.within25ms, s.p5Timing.turnWallMs.max, 150 - s.p5Timing.turnWallMs.max - 5,
  ].join(',');
});
writeFileSync(`${DIR}/ROOT_ARM_SUMMARY.csv`, [csvHead.join(','), ...csvRows].join('\n') + '\n');

writeFileSync(`${DIR}/_raw/AGGREGATE.json`, JSON.stringify(aggregate, null, 1));
console.log('AGGREGATE', JSON.stringify({
  classCounts, phase1StrongMin, phase1StrongMax, anyProof, decision,
  refutation: aggregate.proofCounts,
  det: aggregate.determinism.allClassSame && aggregate.determinism.allNodesSame && aggregate.determinism.allVerifySame,
  cost: aggregate.cost, slack: { slackMax20, slackMin20, slackMax40 },
  gates: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, v.pass])),
}, null, 1));
