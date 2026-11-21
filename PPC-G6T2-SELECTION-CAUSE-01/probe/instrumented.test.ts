/// <reference types="node" />
/**
 * PPC-G6T2-SELECTION-CAUSE-01 / G2 — fixed-depth D2 search on the ISOLATED
 * observed copy (fresh process, selected by PPC_INSTR_REP=1..3, serial).
 *
 * The observation sink is inert unless observationBegin() is called and records
 * only nodes at ply <= 3 (root, after D, after DR, after DRR). Parity against
 * the frozen D2 numbers is required BEFORE any score is used; on failure the
 * file writes INSTRUMENTATION_PARITY_FAIL and the audit is unusable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  OUT, ROOT_ID, ARM, DEPTH_TURNS, MAX_NODES, FROZEN_D2,
  loadRoot, detail, replayDetailed, makeObservedCtx, observedProjection,
  writeJson, ensureDirs, sha256, canonicalJson,
} from './sc_lib';
import { observedSearchBestAction as search } from './sc_lib';
import { observationBegin, observationEnd } from './observe';
import type { ObservedNode } from './observe';
import { label, rules } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
import { buildCandidate, buildPlanForFirstAction } from '../../src/game/ai/planQuality';
import { generatePreparedSearchActions } from './sc_lib';
// @ts-expect-error untyped .mjs generator module
import { transform, SOURCE_REL } from './gen_observed.mjs';

const REP = Number(process.env.PPC_INSTR_REP ?? '1');
const REP1_LOG = `${OUT}/logs/d2_instrumented_rep1.json`;
const SUMS = 1e-12;

const close = (a: number, b: number) => Math.abs(a - b) <= SUMS * Math.max(1, Math.abs(a), Math.abs(b));

function nodeView(n: ObservedNode | undefined) {
  if (!n) return null;
  const values = n.actions.map((a) => a.value);
  const best = n.resultValue;
  const tiedLabels = best === null ? [] : n.actions.filter((a) => a.value === best).map((a) => a.label);
  return {
    key: n.key,
    depthTurns: n.depthTurns,
    ply: n.ply,
    legalActionCount: n.actions.length,
    actions: n.actions.map((a) => ({
      label: a.label, type: a.type, originalIndex: a.originalIndex,
      value: a.value, mate: a.mate, bound: a.bound,
      completed: a.completed, cacheable: a.cacheable,
    })),
    choiceLabel: n.choiceLabel,
    choiceOriginalIndex: n.choiceOriginalIndex,
    resultValue: n.resultValue,
    resultMate: n.resultMate,
    resultBound: n.resultBound,
    exactTieLabels: tiedLabels,
    tieBreakRule: 'strict improvement wins; on an exact tie the smaller original legal index is kept (stable order), with a certified-before-uncertified upgrade rule',
    distinctValueCount: new Set(values).size,
  };
}

describe(`G2 instrumented D2 rep${REP}`, () => {
  it('reproduces the frozen D2 search and captures child values', () => {
    ensureDirs();

    // ---- byte identity of the observed copy (re-applied transform) ---------
    const srcText = readFileSync(SOURCE_REL, 'utf8');
    const { text } = transform(srcText);
    const observedText = readFileSync(`${OUT}/probe/expectiminimax_observed.ts`, 'utf8');
    expect(observedText).toBe(text);
    const meta = JSON.parse(readFileSync(`${OUT}/probe/expectiminimax_observed.meta.json`, 'utf8'));

    const root = loadRoot();
    const rootDet = detail(root);
    const ctx = makeObservedCtx(true);
    observationBegin();
    const started = Date.now();
    const res = search(root, DEPTH_TURNS, ctx);
    const elapsedMs = Date.now() - started;
    const obs = observationEnd();
    const d = res.diagnostics;

    const rootValues = (ctx.rootValues as { action: { type: string; direction?: { key: string } }; value: number; mate: string | null; bound: string }[])
      .map((r) => ({ label: label(r.action as never), value: r.value, mate: r.mate, bound: r.bound }));
    const planLabels = (res.catTurnPlan as never[]).map((a) => label(a));
    const bestLabel = res.action ? label(res.action as never) : null;

    // ---- the two extraction channels ---------------------------------------
    // (1) direct planBranches walk per root action (the channel the D2 round
    //     published as candidates); (2) the production catTurnPlan returned by
    //     searchBestAction (context-aware extractor). They may differ; that is
    //     recorded as evidence, never assumed away.
    const preparedRoot = generatePreparedSearchActions(root, rules);
    const directPlans = preparedRoot.map((p, i) => {
      const direct = buildPlanForFirstAction(root, p.action, ctx as never);
      const cand = buildCandidate(root, p.action, ctx as never, p.originalIndex ?? i);
      return {
        legalIndex: i,
        rootAction: label(p.action),
        directWalkPlan: direct.map((a) => label(a as never)).join(''),
        candidatePlan: cand ? cand.plan.map((a) => label(a as never)).join('') : null,
      };
    });
    const directStrings = directPlans.map((d) => d.directWalkPlan);
    const productionPlan = planLabels.join('');
    const extractionDivergence = productionPlan !== (bestLabel === 'U' ? directPlans.find((d) => d.rootAction === bestLabel)?.directWalkPlan : null);
    const productionReplay = replayDetailed(root, planLabels);

    // ---- parity gate (frozen D2 numbers) -----------------------------------
    const parityChecks = {
      NODES_MATCH: d.nodes === FROZEN_D2.nodes,
      LEAF_NODES_MATCH: d.leafNodes === FROZEN_D2.leafNodes,
      CHANCE_NODES_MATCH: d.chanceNodes === FROZEN_D2.chanceNodes,
      VALUE_EXACT_MATCH: res.value === FROZEN_D2.value,
      COMPLETED: res.completed === true,
      MATE_NULL: res.mate === null,
      BUDGET_CUTOFFS_ZERO: (d.budgetCutoffs ?? 0) === 0,
      DEADLINE_CUTOFFS_ZERO: (d.deadlineCutoffs ?? 0) === 0,
      EXTENSION_ABORTS_ZERO: (d.extensionAbortCount ?? 0) === 0,
      ROOT_VALUES_EXACT: rootValues.length === 3
        && rootValues.every((r) => r.value === FROZEN_D2.value)
        && rootValues.map((r) => r.label).join('') === 'UDL',
      PLANS_MATCH_FROZEN: directStrings.join(',') === FROZEN_D2.plans.join(','),
      PRODUCTION_PLAN_REPLAY_OK: productionReplay.ok,
      REPETITIONS_ZERO: (d.repetitions ?? 0) === 0,
      NODE_CAP_NOT_HIT: d.nodes < MAX_NODES,
      OBSERVATION_SINK_ACTIVE_OFF: obs.active === false,
    };
    const parity = Object.values(parityChecks).every(Boolean);

    // ---- the three D2 plans from planBranches at the root tie set ----------
    const rootGraph = (ctx.equalPrimaryGraph as Map<string, { equalActions: { type: string; direction?: { key: string } }[] }>)
      .get(`${rootDet.stateKey}\x00${DEPTH_TURNS}`) ?? null;
    const equalRootLabels = rootGraph ? rootGraph.equalActions.map((a) => label(a as never)) : [];

    // prefix keys from real-rule replay (the search states must coincide)
    const prefixKey = (labels: string[]) => {
      const r = replayDetailed(root, labels);
      if (!r.ok || r.frontier.length !== 1) throw new Error(`prefix ${labels.join('')} replay failed: ${r.failedAt}`);
      return { key: r.frontier[0].detail.stateKey, detail: r.frontier[0].detail };
    };
    const pD = prefixKey(['D']);
    const pDR = prefixKey(['D', 'R']);
    const pDRR = prefixKey(['D', 'R', 'R']);

    const findNode = (key: string, ply: number) =>
      obs.nodes.find((n) => n.key === key && n.ply === ply) ?? null;

    const rootNode = nodeView(findNode(rootDet.stateKey, 0));
    const dNode = nodeView(findNode(pD.key, 1));
    const drNode = nodeView(findNode(pDR.key, 2));
    const drrNode = nodeView(findNode(pDRR.key, 3));

    const dU = dNode?.actions.find((a) => a.label === 'U') ?? null;
    const dR = dNode?.actions.find((a) => a.label === 'R') ?? null;
    const dL = dNode?.actions.find((a) => a.label === 'L') ?? null;

    const audit = {
      round: OUT,
      phase: 'G2_D2_CHILD_VALUE_AUDIT',
      generatedAt: new Date().toISOString(),
      rep: REP,
      pid: process.pid,
      rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS, maxNodes: MAX_NODES,
      searchMode: 'FIXED_DEPTH_D2',
      instrumentation: {
        source: SOURCE_REL,
        sourceSha256Raw: sha256(Buffer.from(srcText, 'utf8')),
        observedPath: `${OUT}/probe/expectiminimax_observed.ts`,
        observedSha256Raw: sha256(Buffer.from(observedText, 'utf8')),
        metaSourceSha256Raw: meta.sourceSha256Raw,
        metaObservedSha256Raw: meta.observedSha256Raw,
        byteEqualToTransform: true,
        hooks: meta.transformation.hookLines,
        scope: 'observe-only; records candidate values and decided actions at ply <= 3 inside the SAME search; no change to control flow, arithmetic, ordering, pruning or leaf evaluation',
        observedNodeCount: obs.nodeCount,
      },
      search: {
        elapsedMs,
        nodes: d.nodes, leafNodes: d.leafNodes, chanceNodes: d.chanceNodes,
        maxDepthReached: d.maxDepthReached, repetitions: d.repetitions,
        value: res.value, mate: res.mate, completed: res.completed,
        bestAction: bestLabel, catTurnPlan: planLabels,
        rootValues,
        equalRootActions: equalRootLabels,
        diagnostics: d,
        plans: {
          publishedD2Candidates: FROZEN_D2.plans,
          directWalkPlans: directPlans,
          directWalkStrings: directStrings,
          productionCatTurnPlan: productionPlan,
          productionPlanReplay: {
            ok: productionReplay.ok,
            frontierStatus: productionReplay.frontierStatus,
            finalKeys: productionReplay.frontier.map((f) => f.detail.stateKey),
            finalFullStateEqualsRoot: productionReplay.finalEqualsRoot,
            catReturnedButStateChanged: productionReplay.catReturnedButStateChanged,
          },
          extractionDivergence,
          note: 'directWalkPlan = buildPlanForFirstAction (planBranches walk, the D2 candidate channel); productionCatTurnPlan = searchBestAction().catTurnPlan (context-aware extractor). A difference is a real extraction divergence, reported as CASE C evidence.',
        },
      },
      parityChecks,
      parity,
      nodes: {
        root: rootNode,
        afterD: dNode,
        afterDR: drNode,
        afterDRR: drrNode,
        prefixKeys: {
          root: { key: rootDet.stateKey, fullStateSha256: rootDet.fullStateSha256 },
          afterD: pD.detail, afterDR: pDR.detail, afterDRR: pDRR.detail,
        },
      },
      childValueEvidence: {
        note: 'All values below are produced INSIDE the one root search, at the same depthTurns, with the same E1 leaf evaluator and the same node budget.',
        afterD: {
          depthTurns: dNode?.depthTurns ?? null,
          U: dU, R: dR, L: dL,
          deltaUminusR: dU && dR ? dU.value - dR.value : null,
          uEqualsRExactly: dU !== null && dR !== null && dU.value === dR.value,
          chosen: dNode?.choiceLabel ?? null,
          nodeValue: dNode?.resultValue ?? null,
          legalActionCount: dNode?.legalActionCount ?? null,
        },
      },
    };

    if (REP === 1) {
      writeJson(`${OUT}/D2_CHILD_VALUE_AUDIT.json`, audit);
      writeJson(`${OUT}/D2_INSTRUMENTATION_PARITY.json`, {
        round: OUT, phase: 'G2_INSTRUMENTATION_PARITY', generatedAt: new Date().toISOString(),
        rep: REP, pid: process.pid, parity, checks: parityChecks,
        expected: FROZEN_D2,
        actual: {
          nodes: d.nodes, leafNodes: d.leafNodes, chanceNodes: d.chanceNodes,
          value: res.value, mate: res.mate, completed: res.completed,
          bestAction: bestLabel, catTurnPlan: planLabels, rootValues,
        },
        verdict: parity ? 'PARITY_PASS' : 'INSTRUMENTATION_PARITY_FAIL',
        note: parity ? 'scores from this search are admissible' : 'scores MUST NOT be used',
      });
    }

    const projection = observedProjection(obs.nodes);
    const projectionSha256 = sha256(projection);
    writeJson(`${OUT}/logs/d2_instrumented_rep${REP}.json`, {
      round: OUT, phase: 'G2_INSTRUMENTED_REP', rep: REP, pid: process.pid,
      startedAtIso: new Date(started).toISOString(), elapsedMs,
      nodes: d.nodes, leafNodes: d.leafNodes, chanceNodes: d.chanceNodes,
      value: res.value, mate: res.mate, completed: res.completed,
      bestAction: bestLabel, catTurnPlan: planLabels, rootValues,
      parity, parityChecks,
      observedNodeCount: obs.nodeCount,
      observedNodes: obs.nodes,
      projectionSha256,
      observedFileSha256: sha256(Buffer.from(observedText, 'utf8')),
    });

    if (REP !== 1) {
      expect(existsSync(REP1_LOG)).toBe(true);
      const rep1 = JSON.parse(readFileSync(REP1_LOG, 'utf8')) as {
        projectionSha256: string; nodes: number; observedNodeCount: number; catTurnPlan: string[];
      };
      expect(projectionSha256).toBe(rep1.projectionSha256);
      expect(d.nodes).toBe(rep1.nodes);
      expect(obs.nodeCount).toBe(rep1.observedNodeCount);
      expect(planLabels).toEqual(rep1.catTurnPlan);
    }

    console.log(`--- INSTRUMENTED REP${REP} ---`);
    console.log('nodes', d.nodes, 'leaf', d.leafNodes, 'chance', d.chanceNodes,
      'elapsedMs', elapsedMs, 'value', res.value, 'plan', planLabels.join(''));
    console.log('parity', parity, JSON.stringify(parityChecks));
    console.log('rootValues', JSON.stringify(rootValues));
    if (rootNode) console.log('rootNode', rootNode.key.slice(0, 24), 'choice', rootNode.choiceLabel,
      'values', JSON.stringify(rootNode.actions.map((a) => [a.label, a.value, a.mate, a.bound])));
    if (dNode) console.log('D-node', JSON.stringify(dNode.actions.map((a) => [a.label, a.value, a.mate, a.bound])),
      'choice', dNode.choiceLabel, 'deltaU-R', dU && dR ? dU.value - dR.value : null);
    if (drNode) console.log('DR-node', JSON.stringify(drNode.actions.map((a) => [a.label, a.value, a.bound])), 'choice', drNode.choiceLabel);
    if (drrNode) console.log('DRR-node', JSON.stringify(drrNode.actions.map((a) => [a.label, a.value, a.bound])), 'choice', drrNode.choiceLabel);
    console.log('projectionSha256', projectionSha256);
    console.log('--- END ---');

    expect(parity).toBe(true);
    expect(rootNode).not.toBeNull();
    expect(dNode).not.toBeNull();
    expect(drNode).not.toBeNull();
    expect(drrNode).not.toBeNull();
  });
});