/// <reference types="node" />
/**
 * PPC-G6T2-SELECTION-CAUSE-01 / G0 — read-only identity verification.
 *
 * Confirms, without touching any production file:
 *   - the round-01 ledger (160 entries) and every registered artifact digest;
 *   - the frozen D2 manifest (39 production sources) recomputed byte-for-byte;
 *   - fixture / kernel / root-snapshot identity;
 *   - the historical SEAL certificate fields used as the positive control;
 *   - that probe/expectiminimax_observed.ts is exactly transform(production).
 * Writes logs/g0_identity.json.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  OUT, PREV_ROUND, ROOT_ID, ARM, DEPTH_TURNS, MAX_NODES,
  FIXTURE, FIXTURE_SHA, KERNEL, KERNEL_SHA,
  sha256, fileSha, loadRoot, snapshotSha, writeJson, ensureDirs,
} from './sc_lib';
import { stateKey, canonicalJson, summarize as sealSummarize } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';
// @ts-expect-error untyped .mjs generator module
import { transform, SOURCE_REL } from './gen_observed.mjs';

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const shaOf = (s: string) => createHash('sha256').update(s).digest('hex');

describe('G0 identity', () => {
  it('verifies the frozen D2 artifacts and current closure', () => {
    ensureDirs();
    const out: Record<string, unknown> = {
      round: OUT, phase: 'G0_IDENTITY', generatedAt: new Date().toISOString(),
      rootId: ROOT_ID, arm: ARM, depthTurns: DEPTH_TURNS,
    };

    // ---- 1. round-01 ledger (all 160 entries, sizes and hashes) --------------
    // The delivery ledger exists only in the local worktree (the cloud snapshot
    // never received it); when absent we record that and verify the freeze
    // digests instead, which bind the cloud-produced originals.
    const ledgerPath = `${PREV_ROUND}/SHA256SUMS.txt`;
    const ledgerAvailable = existsSync(ledgerPath);
    const ledgerMismatch: unknown[] = [];
    let ledgerEntries = 0;
    if (ledgerAvailable) {
      const ledgerLines = readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      ledgerEntries = ledgerLines.length;
      for (const line of ledgerLines) {
        const m = /^([0-9a-f]{64})\s+(\d+)\s+(.+)$/.exec(line);
        if (!m) { ledgerMismatch.push({ line, reason: 'unparsed' }); continue; }
        const [, hash, size, rel] = m;
        const abs = resolve(PREV_ROUND, rel);
        if (!existsSync(abs)) { ledgerMismatch.push({ rel, reason: 'missing' }); continue; }
        const got = sha256(readFileSync(abs));
        const bytes = statSync(abs).size;
        if (got !== hash || bytes !== Number(size)) {
          ledgerMismatch.push({ rel, expected: hash, got, expectedBytes: Number(size), bytes });
        }
      }
      expect(ledgerMismatch).toEqual([]);
    }
    out.round01Ledger = {
      available: ledgerAvailable,
      entries: ledgerEntries,
      allMatch: ledgerAvailable ? true : null,
      note: ledgerAvailable
        ? 'local worktree delivery ledger verified entry-by-entry'
        : `ledger not present on this host (${ledgerPath}); freeze artifact digests verified instead`,
    };

    // ---- 2. registered artifact digests (freeze) ----------------------------
    const freeze = readJson(`${PREV_ROUND}/CANDIDATE_FREEZE.json`);
    const digests = freeze.artifactDigests as Record<string, string> & { searchReps: string[] };
    // The freeze binds the cloud-produced replay/closure originals. On the local
    // worktree those originals were preserved as *.cloud.json twins and the
    // local regenerated twins differ in generatedAt only; on the cloud host the
    // originals are the plain names. Select by availability, then verify bytes.
    const cloudTwin = (base: string) => {
      const twin = `${PREV_ROUND}/logs/${base}.cloud.json`;
      return existsSync(twin) ? twin : `${PREV_ROUND}/logs/${base}.json`;
    };
    const fileFor: Record<string, string> = {
      d2RootValues: `${PREV_ROUND}/D2_ROOT_VALUES.json`,
      d2Candidates: `${PREV_ROUND}/D2_CANDIDATES.json`,
      branchConflictAudit: `${PREV_ROUND}/BRANCH_CONFLICT_AUDIT.json`,
      g0Replay: cloudTwin('g0_replay'),
      g0Closure: cloudTwin('g0_closure'),
    };
    const freezeCheck: Record<string, unknown> = {};
    for (const [key, rel] of Object.entries(fileFor)) {
      const got = fileSha(rel);
      freezeCheck[key] = { expected: digests[key], got, match: got === digests[key] };
      expect(got).toBe(digests[key]);
    }
    const repFiles = ['1', '2', '3'].map((n) => `${PREV_ROUND}/logs/d2_search_rep${n}.json`);
    const repCheck = repFiles.map((rel, i) => {
      const got = fileSha(rel);
      return { rep: i + 1, expected: digests.searchReps[i], got, match: got === digests.searchReps[i] };
    });
    for (const r of repCheck) expect(r.match).toBe(true);
    // g0_replay twins may differ only in generatedAt. The cloud g0_closure twin
    // has NO git history (git* hashes null, classification falls back to
    // NEW_IN_ROUND), so there we require per-file currentSha256 equality.
    // Twin comparison only where both members exist (local worktree). On the
    // cloud host the originals ARE the plain names, so there is nothing to pair.
    let twins: Record<string, unknown> | null = null;
    if (existsSync(`${PREV_ROUND}/logs/g0_replay.cloud.json`)) {
      const replayL = readJson(`${PREV_ROUND}/logs/g0_replay.json`);
      const replayC = readJson(`${PREV_ROUND}/logs/g0_replay.cloud.json`);
      const stripTs = (o: Record<string, unknown>) => { const { generatedAt: _g, ...rest } = o; return rest; };
      expect(stripTs(replayC)).toEqual(stripTs(replayL));
      const closureL = readJson(`${PREV_ROUND}/logs/g0_closure.json`);
      const closureC = readJson(`${PREV_ROUND}/logs/g0_closure.cloud.json`);
      expect(closureL.files.length).toBe(39);
      expect(closureC.files.length).toBe(39);
      const curL = (closureL.files as { path: string; currentSha256: string }[]).map((f) => [f.path, f.currentSha256]);
      const curC = (closureC.files as { path: string; currentSha256: string }[]).map((f) => [f.path, f.currentSha256]);
      expect(curC).toEqual(curL);
      twins = {
        g0_replay: {
          localSha256: fileSha(`${PREV_ROUND}/logs/g0_replay.json`),
          cloudSha256: fileSha(`${PREV_ROUND}/logs/g0_replay.cloud.json`),
          equalExceptGeneratedAt: true,
        },
        g0_closure: {
          localSha256: fileSha(`${PREV_ROUND}/logs/g0_closure.json`),
          cloudSha256: fileSha(`${PREV_ROUND}/logs/g0_closure.cloud.json`),
          perFileCurrentShaEqual: true,
          classificationDivergence: 'cloud twin has NO_GIT_HISTORY (git* hashes null, NEW_IN_ROUND fallback); local twin refines classification via 21fa941. Recorded, not a byte divergence.',
        },
      };
    }
    out.registeredDigests = { artifacts: freezeCheck, searchReps: repCheck, localCloudTwins: twins };

    // ---- 3. previous SOURCE_MANIFEST: 39 production sources recomputed -----
    const prevManifest = readJson(`${PREV_ROUND}/SOURCE_MANIFEST.json`);
    const sources = prevManifest.productionSources as { path: string; sha256: string; bytes: number; frozenSha256: string | null; classification: string }[];
    expect(sources.length).toBe(39);
    const sourceMismatch = sources.filter((s) => {
      const got = fileSha(s.path);
      return got === null || got !== s.sha256;
    });
    expect(sourceMismatch).toEqual([]);
    const productionChanged = sources.filter((s) => s.frozenSha256 !== null && s.frozenSha256 !== s.sha256);
    out.previousClosure = {
      productionSources: sources.length,
      allRecomputedMatch: true,
      byClass: prevManifest.closure.byClass,
      unresolved: prevManifest.closure.unresolved,
      contentChangedVsHistorical: productionChanged.map((s) => s.path),
    };

    // ---- 4. fixture / kernel / root identity -------------------------------
    expect(fileSha(FIXTURE)).toBe(FIXTURE_SHA);
    expect(fileSha(KERNEL)).toBe(KERNEL_SHA);
    const fixture = readJson(FIXTURE) as { id: string; canonicalSnapshotSha256: string }[];
    const fixtureRec = fixture.find((r) => r.id === ROOT_ID);
    expect(fixtureRec).toBeTruthy();
    expect(fixtureRec!.canonicalSnapshotSha256).toBe('30a54a57fbf5747d0e1f0f073420809653fb58f9ef2f89e608042ffbc4446656');

    const historicalSnap = fixtureRec!.canonicalSnapshotSha256;
    const root = loadRoot();
    const rootSnap = snapshotSha(root);
    const sealSnap = sha256(canonicalJson(sealSummarize(root)));
    expect(rootSnap).toBe(sealSnap);
    const prevReplay = readJson(`${PREV_ROUND}/logs/g0_replay.json`);
    // Historical SEAL identity is the fixture/recert label; current summary
    // hashes are recomputed independently and recorded alongside it.
    expect(prevReplay.root.canonicalSnapshotSha256).toBe(historicalSnap);
    expect(prevReplay.root.historicalCanonicalSnapshotSha256).toBe(historicalSnap);
    expect(prevReplay.root.snapshotMatch).toBe(true);
    const rootKey = stateKey(root);
    expect(rootKey).toBe(prevReplay.root.rootStateKey);
    out.identity = {
      fixture: { path: FIXTURE, sha256: FIXTURE_SHA },
      kernel: { path: KERNEL, sha256: KERNEL_SHA },
      root: {
        id: ROOT_ID,
        stateKey: rootKey,
        historicalCanonicalSnapshotSha256: historicalSnap,
        currentSummarySha256: rootSnap,
        currentSummaryEqualsHistorical: rootSnap === historicalSnap,
        sealUtilSummarySha256: sealSnap,
      },
    };

    // ---- 5. historical SEAL certificate (positive control labels) ----------
    const recert = readJson('PPC-CAT-STRATEGY-SEAL-01/G6T2_RECERTIFICATION.json');
    expect(recert.fixtureSha256).toBe(FIXTURE_SHA);
    expect(recert.canonicalSnapshotSha256).toBe(historicalSnap);
    expect(recert.rootClassification.class).toBe('UNRESOLVED');
    expect(recert.rootClassification.rootSurvivalCertificate).toBeNull();
    expect(recert.horizon.H1).toBe(2);
    expect(recert.cap).toBe(600000);
    const safePrefixes = recert.drUniqueness.twoStepPrefixes
      .filter((p: { catSurvive: boolean }) => p.catSurvive === true)
      .map((p: { prefix: string }) => p.prefix);
    expect(safePrefixes).toEqual(['DR']);
    const drrr = recert.fullTurnPrefixes.find((p: { name: string }) => p.name === 'DRRR');
    expect(drrr).toBeTruthy();
    expect(drrr.catSurvive).toBe(true);
    expect(drrr.certificates[0].verified.verdict).toBe('PROVEN');
    expect(drrr.certificates[0].verified.leaves).toBe(117382);
    expect(drrr.certificates[0].verified.branches).toBe(31236);
    expect(drrr.certificates[0].verified.chanceNodes).toBe(549);
    expect(drrr.certificates[0].verified.policyMisses).toBe(0);
    out.historicalCertificate = {
      status: 'FROZEN_POSITIVE_CONTROL_NOT_RERUN',
      fixtureSha256: recert.fixtureSha256,
      canonicalSnapshotSha256: recert.canonicalSnapshotSha256,
      rootClassification: recert.rootClassification.class,
      horizon: recert.horizon,
      cap: recert.cap,
      safeFirstMoves: recert.drUniqueness.legalFirstSteps,
      safeTwoStepPrefixes: safePrefixes,
      drrr: {
        catSurvive: drrr.catSurvive,
        mouseForcedWin: drrr.mouseForcedWin,
        certificates: drrr.certificates.map((c: { verified: unknown }) => c.verified),
        endState: drrr.endState,
      },
      contractNote: 'H2/600000 certificate is a FROZEN positive-control label; not re-run this round. H1/5000 remains UNRESOLVED for every plan.',
    };

    // ---- 6. observed copy === transform(production) ------------------------
    const srcText = readFileSync(SOURCE_REL, 'utf8');
    const { text } = transform(srcText);
    const observedText = readFileSync('PPC-G6T2-SELECTION-CAUSE-01/probe/expectiminimax_observed.ts', 'utf8');
    expect(shaOf(observedText)).toBe(shaOf(text));
    expect(observedText).toBe(text);
    const meta = readJson('PPC-G6T2-SELECTION-CAUSE-01/probe/expectiminimax_observed.meta.json');
    expect(meta.sourceSha256Raw).toBe(shaOf(srcText));
    expect(meta.observedSha256Raw).toBe(shaOf(observedText));
    out.observedCopy = {
      source: SOURCE_REL,
      sourceSha256: meta.sourceSha256Raw,
      observedSha256: meta.observedSha256Raw,
      byteEqualTransform: true,
      hookLines: meta.transformation.hookLines,
      productionSourceModified: meta.productionSourceModified,
    };

    // ---- 7. frozen parity target ------------------------------------------
    const rootValues = readJson(`${PREV_ROUND}/D2_ROOT_VALUES.json`);
    expect(rootValues.nodes).toBe(1_283_054);
    expect(rootValues.leafNodes).toBe(2_600_863);
    expect(rootValues.chanceNodes).toBe(7_889);
    expect(rootValues.value).toBe(-658.2105263157898);
    const plans = (readJson(`${PREV_ROUND}/D2_CANDIDATES.json`).candidates as { planString: string }[]).map((c) => c.planString);
    expect(plans).toEqual(['UUDD', 'DUUD', 'LUDR']);
    expect(rootValues.bestAction).toBeNull();
    expect(rootValues.argmaxActions.length).toBe(3);
    out.parityTarget = {
      nodes: rootValues.nodes, leafNodes: rootValues.leafNodes, chanceNodes: rootValues.chanceNodes,
      value: rootValues.value, searchStatus: rootValues.searchStatus, completed: rootValues.completed,
      bestAction: rootValues.bestAction, legalRootActionCount: rootValues.legalRootActionCount,
      rootValues: rootValues.rootValues.map((r: { action: string; value: number; mate: string | null }) => [r.action, r.value, r.mate]),
      plans,
      maxNodes: MAX_NODES,
      projectionSha256: readJson(`${PREV_ROUND}/logs/d2_search_rep1.json`).projectionSha256,
    };

    writeJson(`${OUT}/logs/g0_identity.json`, out);
    console.log('G0 identity: all checks passed');
    console.log('root snapshot =', rootSnap);
    console.log('plans =', JSON.stringify(plans));
  });
});