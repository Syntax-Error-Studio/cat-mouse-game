/// <reference types="node" />
/**
 * PPC-G6T2-SELECTION-CAUSE-01 / G1 — real-rule progress audit (no search).
 *
 * Replays the three D2 candidates and the three historical controls from the
 * SAME frozen root through the real rules. "No progress" is decided by full
 * canonical state identity and state-key revisits, never by direction strings.
 * Writes PLAN_PROGRESS_AUDIT.json.
 */
import { describe, it, expect } from 'vitest';
import {
  OUT, ROOT_ID, ARM, DEPTH_TURNS,
  loadRoot, detail, replayDetailed, snapshotSha, fullStateSha, writeJson, ensureDirs,
} from './sc_lib';
import type { PlanReplay } from './sc_lib';
import { stateKey } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

const D2_PLANS = [
  { plan: 'UUDD', source: 'D2_CANDIDATE', legalIndex: 0, rootAction: 'U' },
  { plan: 'DUUD', source: 'D2_CANDIDATE', legalIndex: 1, rootAction: 'D' },
  { plan: 'LUDR', source: 'D2_CANDIDATE', legalIndex: 2, rootAction: 'L' },
];
const CONTROLS = [
  { plan: 'UURR', source: 'HISTORICAL_CONTROL', legalIndex: null, rootAction: 'U' },
  { plan: 'DRRR', source: 'HISTORICAL_CONTROL', legalIndex: null, rootAction: 'D' },
  { plan: 'DRDR', source: 'HISTORICAL_CONTROL', legalIndex: null, rootAction: 'D' },
];

function planAudit(entry: { plan: string; source: string; legalIndex: number | null; rootAction: string }) {
  const root = loadRoot();
  const rootDet = detail(root);
  const rep: PlanReplay = replayDetailed(root, entry.plan.split(''));
  const finalKeys = rep.frontier.map((f) => f.detail.stateKey);
  const finalSnap = rep.frontier.map((f) => f.detail.snapshotSha256);
  const finalFull = rep.frontier.map((f) => f.detail.fullStateSha256);
  const rootRevisited = rep.repeatedStates.some((r) =>
    r.key === rootDet.stateKey && r.firstStep === -1);
  const catReturned = rep.frontier.length > 0 && rep.frontier.every(
    (f) => f.detail.summary.cat === rootDet.summary.cat);
  const steps = rep.steps.map((s) => ({
    step: s.step,
    label: s.label,
    actionTypes: s.actionTypes,
    chance: s.chance,
    probabilitySum: s.probabilitySum,
    branchCount: s.branchCount,
    branches: s.branches.map((b) => ({
      fromStateKey: b.fromStateKey,
      action: b.action,
      transitionKind: b.transitionKind,
      weightIn: b.weightIn,
      preparedLabels: b.preparedLabels,
      boxesBefore: b.boxesBefore,
      blockedTunnelsBefore: b.from.summary.blockedTunnels,
      trapBefore: b.from.summary.trapPosition,
      butterBefore: b.from.summary.butterPositions,
      outcomes: b.outcomes.map((o) => ({
        weight: o.weight,
        stateKey: o.stateKey,
        fullStateSha256: o.fullStateSha256,
        snapshotSha256: o.snapshotSha256,
        player: o.player,
        playerChanged: o.playerChanged,
        cat: o.cat,
        mouse: o.mouse,
        catMovesLeft: o.catMovesLeft,
        mouseMovesLeft: o.mouseMovesLeft,
        boxesAfter: o.boxesAfter,
        boxesMoved: o.boxesMoved,
        boxesRemoved: o.boxesRemoved,
        boxesAdded: o.boxesAdded,
        blockedTunnelsAfter: o.summary.blockedTunnels,
        trapBefore: o.trapBefore,
        trapAfter: o.trapAfter,
        butterBefore: o.butterBefore,
        butterAfter: o.butterAfter,
        summary: o.summary,
      })),
    })),
  }));

  // "No effective change" = the whole full-state hash is back at the root.
  // A cat-only return is reported separately and never used as proof.
  const fullStateNoChange = rep.ok && finalFull.every((x) => x === rootDet.fullStateSha256);
  const snapshotNoChange = rep.ok && finalSnap.every((x) => x === rootDet.snapshotSha256);
  return {
    ...entry,
    ok: rep.ok,
    failure: rep.failedAt,
    steps,
    final: {
      frontierStatus: rep.frontierStatus,
      keys: finalKeys,
      fullStateSha256: finalFull,
      snapshotSha256: finalSnap,
      catReturnedToStart: catReturned,
      fullStateEqualsRoot: fullStateNoChange,
      snapshotEqualsRoot: snapshotNoChange,
      catReturnedButStateChanged: rep.catReturnedButStateChanged,
      changedFieldsVsRoot: rep.changedFieldsVsRoot,
      repeatedStates: rep.repeatedStates,
      rootStateVisitedAgain: rootRevisited,
      probabilitySum: rep.frontier.reduce((acc, f) => acc + f.weight, 0),
    },
    progress: fullStateNoChange
      ? 'NO_EFFECTIVE_CHANGE_FULL_STATE'
      : (rep.repeatedStates.some((r) => r.key === rootDet.stateKey)
        ? 'REVISITS_ROOT_WITHIN_PLAN_BUT_END_DIFFERS'
        : 'STATE_ADVANCED'),
  };
}

describe('G1 plan progress', () => {
  it('replays UUDD/DUUD/LUDR and UURR/DRRR/DRDR from the frozen root', () => {
    ensureDirs();
    const root = loadRoot();
    const rootDet = detail(root);
    const audits = [...D2_PLANS, ...CONTROLS].map(planAudit);
    for (const a of audits) expect(a.ok).toBe(true);

    const byPlan = new Map(audits.map((a) => [a.plan, a]));
    const finals = (plans: string[]) => plans.map((p) => byPlan.get(p)!);

    const d2Ends = finals(D2_PLANS.map((p) => p.plan));
    const allD2SameFinal = d2Ends.every((a) => a.final.keys.length === 1
      && a.final.keys[0] === d2Ends[0].final.keys[0]);
    const d2EqualToRoot = d2Ends.every((a) => a.final.fullStateEqualsRoot);
    const d2SameSnapshot = d2Ends.every((a) => a.final.snapshotSha256[0] === d2Ends[0].final.snapshotSha256[0]);

    const duplicatedFinalStates: { plans: string[]; key: string; fullStateSha256: string }[] = [];
    const seen = new Map<string, { plan: string; key: string; sha: string }>();
    for (const a of audits) {
      if (!a.ok || a.final.keys.length !== 1) continue;
      const k = a.final.keys[0];
      const prior = seen.get(k);
      if (prior) duplicatedFinalStates.push({ plans: [prior.plan, a.plan], key: k, fullStateSha256: a.final.fullStateSha256[0] });
      else seen.set(k, { plan: a.plan, key: k, sha: a.final.fullStateSha256[0] });
    }

    const payload = {
      round: OUT,
      phase: 'G1_PLAN_PROGRESS_AUDIT',
      generatedAt: new Date().toISOString(),
      rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS,
      method: 'real rules only (generatePreparedSearchActions + transition), no search, no leaf evaluator',
      noProgressCriterion: 'full canonical state SHA256 (all game-affecting fields incl. board cells) equal to the settled root, and/or state-key revisit; cat-position return alone is recorded but never accepted as proof',
      root: rootDet,
      plans: audits,
      crossPlan: {
        d2FinalKeysIdentical: allD2SameFinal,
        d2FinalFullStateEqualsRoot: d2EqualToRoot,
        d2FinalSnapshotsIdentical: d2SameSnapshot,
        duplicatedFinalStates,
        controlFinalKeys: CONTROLS.map((c) => ({ plan: c.plan, keys: byPlan.get(c.plan)!.final.keys, fullState: byPlan.get(c.plan)!.final.fullStateSha256 })),
      },
      verdicts: {
        D2_PLANS_TRULY_NON_PROGRESSING: d2EqualToRoot && allD2SameFinal,
        note: 'set from full-state evidence only; see plans[].final',
      },
    };
    writeJson(`${OUT}/PLAN_PROGRESS_AUDIT.json`, payload);

    console.log('--- G1 PLAN PROGRESS ---');
    for (const a of audits) {
      console.log(`${a.plan} [${a.source}] status=${a.final.frontierStatus} progress=${a.progress} `
        + `final=${a.final.keys.join(',')} catReturned=${a.final.catReturnedToStart} `
        + `fullEqRoot=${a.final.fullStateEqualsRoot} snapEqRoot=${a.final.snapshotEqualsRoot} `
        + `changed=${JSON.stringify(a.final.changedFieldsVsRoot)} repeats=${a.final.repeatedStates.length}`);
      for (const s of a.steps) {
        const b = s.branches[0];
        console.log(`   ${s.step}:${s.label} type=${b.action.type} kind=${b.transitionKind} `
          + `branch=${s.branchCount} probSum=${s.probabilitySum} `
          + `cat=${b.outcomes[0]?.cat} mouse=${b.outcomes[0]?.mouse} boxesMoved=${b.outcomes[0]?.boxesMoved} `
          + `trap=${b.outcomes[0]?.trapBefore}->${b.outcomes[0]?.trapAfter}`);
      }
    }
    console.log('D2 all same final:', allD2SameFinal, 'd2 equals root:', d2EqualToRoot);
    console.log('--- END ---');

    expect(rootDet.stateKey).toBe(stateKey(root));
    expect(rootDet.fullStateSha256).toBe(fullStateSha(root));
    expect(rootDet.snapshotSha256).toBe(snapshotSha(root));
    // Identity guard: all six replays start from the same root identity.
    for (const a of audits) {
      expect(a.steps[0].branches[0].fromStateKey).toBe(rootDet.stateKey);
    }
  });
});