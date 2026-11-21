/// <reference types="node" />
/**
 * PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01 / G2+G3 — full cat-turn candidates.
 *
 * G2: enumerate EVERY legal complete cat turn from the frozen G6T2 root with
 *     the production generator + simulator (no Top-K, no value ordering),
 *     replay every plan independently, keep every positive-probability CHANCE
 *     successor, dedupe by full canonical state while preserving the exact
 *     plan → state mapping, and verify the six fixed control plans.
 * G3: mechanism A (reorder the three principal candidates only) vs mechanism B
 *     (full enumeration + label-blind offline feature comparison).
 *
 * H2 labels from the historical SEAL certificate are loaded ONLY as offline
 * annotations; no ordering below reads them.
 *
 * PPC_REP=1 writes CANDIDATE_ENUMERATION.json + MECHANISM_COMPARISON.json and
 * logs/enumeration_rep1.json; PPC_REP=2/3 must reproduce the same projection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  OUT, PREV_ROUND, ROOT_ID, CONTROL_PLANS, FROZEN_D2,
  loadRoot, enumerateCompleteCatTurns, replayTurn, planFeatures, planKey,
  canonicalJson, sha256, writeJson, ensureDirs,
} from './pcfe_lib';

const REP = process.env.PPC_REP ?? '1';
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

const FEATURES = [
  'uniqueProgress', 'revisitCount', 'zeroCostActions', 'boardChangedVsRoot',
  'boxesMovedVsRoot', 'distanceStart', 'distanceEnd', 'distanceDelta',
  'frontierCount',
] as const;

describe(`G2/G3 candidate enumeration (rep ${REP})`, () => {
  it('enumerates every legal complete cat turn and compares mechanisms', () => {
    ensureDirs();
    const t0 = Date.now();
    const root = loadRoot();
    const enumStart = process.memoryUsage();
    const res = enumerateCompleteCatTurns(root);
    const enumEnd = process.memoryUsage();
    const elapsedMs = Date.now() - t0;
    const { turns, skippedNonCat, expandedStates, cyclePruned } = res;

    expect(turns.length).toBeGreaterThan(0);

    // ---- structure / counts -------------------------------------------------
    const endKindCounts: Record<string, number> = {};
    const stepCounts: Record<string, number> = {};
    let zeroCostTotal = 0;
    for (const t of turns) {
      endKindCounts[t.endKind] = (endKindCounts[t.endKind] ?? 0) + 1;
      stepCounts[String(t.steps)] = (stepCounts[String(t.steps)] ?? 0) + 1;
      zeroCostTotal += t.zeroCostActions;
      if (t.steps > 4 + t.zeroCostActions) throw new Error(`turn longer than cat budget: ${t.key}`);
      expect(t.probabilitySum).toBeGreaterThan(0);
    }
    expect(skippedNonCat).toEqual([]); // cat turns never contain mouse actions

    // ---- six fixed control plans -------------------------------------------
    const byLabels = new Map<string, typeof turns>();
    for (const t of turns) {
      const list = byLabels.get(t.labels) ?? [];
      list.push(t);
      byLabels.set(t.labels, list);
    }
    const controls: Record<string, unknown> = {};
    for (const name of CONTROL_PLANS) {
      const hits = byLabels.get(name) ?? [];
      controls[name] = {
        found: hits.length > 0,
        occurrences: hits.length,
        steps: hits.map((h) => h.steps),
        endKind: hits.map((h) => h.endKind),
        enumerationIndex: hits.map((h) => turns.indexOf(h)),
        frontierFullStateSha256: hits.map((h) => h.frontier.map((f) => f.fullStateSha256)),
        frontierPlayer: hits.map((h) => h.frontier.map((f) => f.player)),
      };
    }
    const missing = CONTROL_PLANS.filter((c) => (byLabels.get(c) ?? []).length === 0);
    if (missing.length > 0) {
      const diag = {
        round: OUT, phase: 'G2_DRRR_MISSING_DIAGNOSIS', generatedAt: new Date().toISOString(),
        missing,
        legalFirstStepLabels: [...new Set(turns.map((t) => t.labels[0]))].sort(),
        prefixAvailability: Object.fromEntries(
          [1, 2, 3, 4].map((n) => {
            const set = new Set(turns.map((t) => t.labels.slice(0, Math.min(n, t.labels.length))));
            return [`len${n}`, { DRRRPrefixPresent: set.has('DRRR'.slice(0, n)), count: set.size }];
          }),
        ),
        totalTurns: turns.length,
        allLabels: [...byLabels.keys()].sort(),
        note: 'STOP: candidate discovery halted because a fixed control plan is not among the legal cat turns.',
      };
      writeJson(`${OUT}/logs/drrr_missing_diagnosis.json`, diag);
      throw new Error(`CONTROL PLAN MISSING: ${missing.join(',')} — diagnosis written, candidate discovery stopped`);
    }
    for (const name of CONTROL_PLANS) {
      const c = controls[name] as { occurrences: number; steps: number[] };
      expect(c.occurrences).toBeGreaterThan(0);
      expect(c.steps.every((s) => s === 4)).toBe(true);
    }

    // ---- independent replay of EVERY plan ----------------------------------
    const replayFails: unknown[] = [];
    let replayOk = 0;
    let replayFrontierMismatch = 0;
    const planToState: { plan: string; labels: string; frontier: string[] }[] = [];
    for (const t of turns) {
      const rep = replayTurn(root, t.plan);
      if (!rep.ok) { replayFails.push({ plan: t.key, failedAt: rep.failedAt }); continue; }
      replayOk++;
      const want = t.frontier.map((f) => f.fullStateSha256).sort();
      const got = rep.frontier.map((f) => f.fullStateSha256).sort();
      if (canonicalJson(want) !== canonicalJson(got) || rep.endKind !== t.endKind) replayFrontierMismatch++;
      planToState.push({ plan: t.key, labels: t.labels, frontier: t.frontier.map((f) => f.fullStateSha256) });
    }
    expect(replayFails).toEqual([]);
    expect(replayOk).toBe(turns.length);
    expect(replayFrontierMismatch).toBe(0);

    // ---- canonical-state dedupe (full state, plan mapping preserved) -------
    // Two identities are reported because the full canonical state also carries
    // action history: `fullStateSha` distinguishes UUDD from DUUD although both
    // stand on the same game position; `snapshotSha` is the game-visible
    // position (board/pieces/butter/trap/tunnels/budget) without history.
    const frontierGroups = new Map<string, string[]>(); // full-frontier signature -> plan keys
    const snapshotGroups = new Map<string, string[]>(); // game-visible frontend signature -> plan keys
    const singleFrontierShas = new Set<string>();
    const singleSnapshotShas = new Set<string>();
    for (const t of turns) {
      const sig = t.frontier.map((f) => f.fullStateSha256).sort().join('|');
      const list = frontierGroups.get(sig) ?? [];
      list.push(t.key);
      frontierGroups.set(sig, list);
      const snapSig = t.frontier.map((f) => f.snapshotSha256).sort().join('|');
      const snapList = snapshotGroups.get(snapSig) ?? [];
      snapList.push(t.key);
      snapshotGroups.set(snapSig, snapList);
      if (t.frontier.length === 1) {
        singleFrontierShas.add(t.frontier[0].fullStateSha256);
        singleSnapshotShas.add(t.frontier[0].snapshotSha256);
      }
    }
    const uniqueFrontierSignatures = frontierGroups.size;
    const uniqueSingleFrontierStates = singleFrontierShas.size;
    const uniqueSnapshotSignatures = snapshotGroups.size;
    const uniqueSingleSnapshotStates = singleSnapshotShas.size;

    // ---- cross-check the six controls against the round-01 replay ----------
    let priorCrossCheck: Record<string, unknown> | null = null;
    const auditPath = `${PREV_ROUND}/PLAN_PROGRESS_AUDIT.json`;
    if (existsSync(auditPath)) {
      const audit = readJson(auditPath);
      const rows: unknown[] = [];
      for (const p of audit.plans as { plan: string; final: { keys: string[]; fullStateSha256: string[] } }[]) {
        const hits = byLabels.get(p.plan) ?? [];
        const t = hits[0];
        const match = t
          ? t.frontier.length === p.final.fullStateSha256.length
            && t.frontier.every((f, i) => f.fullStateSha256 === p.final.fullStateSha256[i])
          : false;
        rows.push({ plan: p.plan, priorSha: p.final.fullStateSha256, enumeratedSha: t?.frontier.map((f) => f.fullStateSha256) ?? null, match });
      }
      priorCrossCheck = { source: auditPath, rows };
      for (const r of rows as { match: boolean }[]) expect(r.match).toBe(true);
    }

    // ---- D2 principal candidates inside the full set -----------------------
    const d2Plans = FROZEN_D2.plans;
    const d2Rows = d2Plans.map((p) => {
      const hits = byLabels.get(p) ?? [];
      return { plan: p, found: hits.length > 0, enumerationIndex: hits.length ? turns.indexOf(hits[0]) : null };
    });
    for (const r of d2Rows) expect(r.found).toBe(true);

    // ---- label-blind features for every plan -------------------------------
    const featureRows = turns.map((t, i) => ({ index: i, labels: t.labels, planKey: t.key, features: planFeatures(root, t) }));
    const featureStats: Record<string, unknown> = {};
    for (const f of FEATURES) {
      const vals = featureRows.map((r) => (r.features as Record<string, unknown>)[f]);
      const numeric = vals.filter((v): v is number => typeof v === 'number');
      featureStats[f] = {
        numericCount: numeric.length,
        nullCount: vals.length - numeric.length,
        min: numeric.length ? Math.min(...numeric) : null,
        max: numeric.length ? Math.max(...numeric) : null,
        distinct: new Set(vals.map((v) => JSON.stringify(v))).size,
      };
    }

    // Offline (label-reading) annotation: where does each control sit under a
    // feature-only descending order? This is comparison evidence, never input.
    const percentileOf = (f: string, value: unknown) => {
      if (typeof value !== 'number') return null;
      const vals = featureRows.map((r) => (r.features as Record<string, unknown>)[f]).filter((v): v is number => typeof v === 'number');
      const below = vals.filter((v) => v < value).length;
      return Number((below / vals.length).toFixed(6));
    };
    const controlFeatures: Record<string, unknown> = {};
    for (const name of CONTROL_PLANS) {
      const row = featureRows.find((r) => r.labels === name);
      controlFeatures[name] = row
        ? {
            index: row.index,
            features: row.features,
            percentilesByFeature: Object.fromEntries(
              FEATURES.map((f) => [f, percentileOf(f, (row.features as Record<string, unknown>)[f])]),
            ),
            generatorOrderPercentile: Number((row.index / Math.max(1, featureRows.length - 1)).toFixed(6)),
          }
        : null;
    }

    // ---- mechanism A: reorder the three principal candidates only ----------
    const principalSet = new Set<string>(d2Plans);
    const mechanismA = {
      candidatePool: d2Plans,
      poolSize: principalSet.size,
      drrrInPool: principalSet.has('DRRR'),
      discoverablePlans: [...principalSet].filter((p) => (byLabels.get(p) ?? []).length > 0),
      verdict: principalSet.has('DRRR')
        ? 'DRRR_IS_IN_PRINCIPAL_POOL'
        : 'CANNOT_DISCOVER_DRRR_BY_REORDERING_PRINCIPALS',
      reasoning: 'A pure reordering of a fixed 3-plan pool cannot produce a plan outside that pool; the exhaustive set is the only source of DRRR.',
    };

    // ---- mechanism B: full enumeration + offline comparison ----------------
    const mechanismB = {
      totalLegalTurns: turns.length,
      uniqueFrontierSignatures,
      uniqueSingleFrontierStates,
      uniqueSnapshotSignatures,
      uniqueSingleSnapshotStates,
      frontierGroups: [...frontierGroups.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([sig, plans]) => ({ frontierSignature: sig, planCount: plans.length, plans: plans.slice(0, 24), truncated: plans.length > 24 })),
      snapshotGroups: [...snapshotGroups.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([sig, plans]) => ({ snapshotSignature: sig, planCount: plans.length, plans: plans.slice(0, 24), truncated: plans.length > 24 })),
      endKindCounts,
      stepCounts,
      zeroCostActions: zeroCostTotal,
      trace: { expandedStates, cyclePruned: cyclePruned.length, cyclePrunedPlans: cyclePruned },
      controls,
      controlFeatures,
      featureStats,
      d2Rows,
    };

    // ---- determinism projection (persisted once per rep) -------------------
    const projection = sha256(canonicalJson({
      round: OUT,
      root: ROOT_ID,
      turns: turns.map((t) => ({
        key: t.key, steps: t.steps, endKind: t.endKind,
        frontier: t.frontier.map((f) => f.fullStateSha256),
        probabilitySum: t.probabilitySum, zeroCostActions: t.zeroCostActions,
      })),
      frontierSignatures: [...frontierGroups.keys()].sort(),
      featureRows: featureRows.map((r) => r.features),
      controls,
      mechanismA,
      mechanismB: { ...mechanismB, trace: undefined, frontierGroups: undefined, controlFeatures: undefined },
    }));
    const repRecord = {
      round: OUT, phase: `G2_G3_ENUMERATION_REP${REP}`, rep: Number(REP),
      generatedAt: new Date().toISOString(),
      projectionSha256: projection,
      elapsedMs,
      memory: {
        rssBeforeMb: Number((enumStart.rss / 1048576).toFixed(1)),
        rssAfterMb: Number((enumEnd.rss / 1048576).toFixed(1)),
        heapUsedAfterMb: Number((enumEnd.heapUsed / 1048576).toFixed(1)),
        externalAfterMb: Number((enumEnd.external / 1048576).toFixed(1)),
      },
      counts: {
        turns: turns.length, expandedStates, uniqueFrontierSignatures,
        uniqueSingleFrontierStates, uniqueSnapshotSignatures, uniqueSingleSnapshotStates,
        zeroCostActions: zeroCostTotal,
        replayOk, replayFrontierMismatch, cyclePruned: cyclePruned.length,
      },
    };

    if (REP === '1') {
      writeJson(`${OUT}/logs/enumeration_rep1.json`, repRecord);
      writeJson(`${OUT}/CANDIDATE_ENUMERATION.json`, {
        round: OUT, phase: 'G2_FULL_CAT_TURN_CANDIDATES', generatedAt: new Date().toISOString(),
        rootId: ROOT_ID,
        method: 'generatePreparedSearchActions (production enumeration + simulator), pure cat turn walk, no search/eval',
        maxActions: 12,
        counts: repRecord.counts,
        timingAndMemory: { elapsedMs, ...repRecord.memory },
        skippedNonCat,
        plans: featureRows.map((r) => ({
          index: r.index, planKey: r.planKey, labels: r.labels,
          frontierFullStateSha256: turns[r.index].frontier.map((f) => f.fullStateSha256),
          endKind: turns[r.index].endKind,
          features: r.features,
        })),
        planToState,
        projectionSha256: projection,
      });
      writeJson(`${OUT}/MECHANISM_COMPARISON.json`, {
        round: OUT, phase: 'G3_MECHANISM_COMPARISON', generatedAt: new Date().toISOString(),
        rootId: ROOT_ID,
        mechanismA,
        mechanismB,
        priorRoundCrossCheck: priorCrossCheck,
        labelPolicy: 'H2/SEAL labels (DRRR cat-survive, UURR mouse-forced-win) are offline annotations only; no enumeration or ordering reads them.',
        projectionSha256: projection,
      });
    } else {
      const basePath = `${OUT}/logs/enumeration_rep1.json`;
      expect(existsSync(basePath)).toBe(true);
      const base = readJson(basePath);
      const equal = base.projectionSha256 === projection;
      repRecord.projectionMatchesRep1 = equal;
      repRecord.rep1ProjectionSha256 = base.projectionSha256;
      writeJson(`${OUT}/logs/enumeration_rep${REP}.json`, repRecord);
      expect(equal).toBe(true);
    }

    console.log(`rep ${REP}: turns=${turns.length} expanded=${expandedStates} uniqueFrontiers=${uniqueFrontierSignatures} elapsed=${elapsedMs}ms projection=${projection}`);
    console.log('controls:', CONTROL_PLANS.map((c) => `${c}:${(byLabels.get(c) ?? []).length}`).join(' '));
  });
});
