/// <reference types="node" />
/**
 * PPC-G6T2-PLAN-CANDIDATE-FEASIBILITY-01 / G0 — read-only identity closure.
 *
 * Verifies (never modifies) the frozen basis this round is allowed to build on:
 *   - the round-01 39-source closure manifest, recomputed byte-for-byte;
 *   - the round-01 delivery ledger for every entry present on this host
 *     (missing entries are recorded, never treated as divergence);
 *   - fixture / kernel / root canonical identity;
 *   - the frozen D2 parity targets and the historical SEAL labels used later
 *     as OFFLINE-ONLY annotations;
 *   - production source file set unchanged since round 01.
 * Writes logs/g0_identity.json.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OUT, PREV_ROUND, ROOT_ID, ARM, FROZEN_D2, FROZEN_FORCED,
  FIXTURE, FIXTURE_SHA, KERNEL, KERNEL_SHA,
  sha256, fileSha, loadRoot, snapshotSha, summarize, writeJson, ensureDirs,
} from './pcfe_lib';
import { stateKey, canonicalJson, summarize as sealSummarize } from '../../PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib';

const ROOT_SNAPSHOT_SHA = '30a54a57fbf5747d0e1f0f073420809653fb58f9ef2f89e608042ffbc4446656';
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('G0 identity', () => {
  it('verifies frozen closure, ledger and root identity', () => {
    ensureDirs();
    const out: Record<string, unknown> = {
      round: OUT, phase: 'G0_IDENTITY', generatedAt: new Date().toISOString(),
      rootId: ROOT_ID, arm: ARM,
    };

    // ---- 1. round-01 source closure: every registered digest recomputed -----
    // The round-01 manifest/ledger are delivered HERE as read-only reference
    // copies (the cloud snapshot never received them); the historical round
    // directory itself is only ever read.
    const manifestPath = [`${OUT}/reference/PPC-G6T2-SELECTION-CAUSE-01.SOURCE_MANIFEST.json`, `${PREV_ROUND}/SOURCE_MANIFEST.json`].find(existsSync);
    expect(manifestPath).toBeTruthy();
    const prevManifest = readJson(manifestPath!);
    const sources = prevManifest.productionSources as { path: string; sha256: string; bytes: number }[];
    expect(sources.length).toBe(39);
    const sourceMismatch = sources.filter((s) => fileSha(s.path) !== s.sha256);
    expect(sourceMismatch).toEqual([]);
    const manifestSelfSha = fileSha(manifestPath!);
    out.previousClosure = {
      manifest: { path: manifestPath, sha256: manifestSelfSha, available: true },
      productionSources: sources.length,
      allRecomputedMatch: true,
      byClass: prevManifest.closure.byClass,
      unresolved: prevManifest.closure.unresolved,
    };

    // ---- 2. round-01 delivery ledger: verify what exists on this host ------
    const ledgerPath = [`${OUT}/reference/PPC-G6T2-SELECTION-CAUSE-01.SHA256SUMS.txt`, `${PREV_ROUND}/SHA256SUMS.txt`].find(existsSync);
    const ledgerAvailable = Boolean(ledgerPath);
    const verified: string[] = [];
    const missing: string[] = [];
    const mismatch: unknown[] = [];
    if (ledgerPath) {
      for (const line of readFileSync(ledgerPath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = /^([0-9a-f]{64})\s+(\d+)\s+(.+)$/.exec(line);
        if (!m) { mismatch.push({ line, reason: 'unparsed' }); continue; }
        const [, hash, size, rel] = m;
        const abs = resolve(PREV_ROUND, rel);
        if (!existsSync(abs)) { missing.push(rel); continue; }
        const got = sha256(readFileSync(abs));
        const bytes = statSync(abs).size;
        if (got !== hash || bytes !== Number(size)) {
          mismatch.push({ rel, expected: hash, got, expectedBytes: Number(size), bytes });
        } else {
          verified.push(rel);
        }
      }
    }
    expect(mismatch).toEqual([]);
    out.round01Ledger = {
      available: ledgerAvailable,
      verified: verified.length,
      missingOnHost: missing.length,
      missing,
      mismatch: 0,
      note: ledgerAvailable
        ? 'every ledger entry present on this host recomputed byte-for-byte; absent entries are local-worktree-only deliverables'
        : 'ledger not present on this host; manifest closure verified instead',
    };

    // ---- 3. fixture / kernel / root identity -------------------------------
    expect(fileSha(FIXTURE)).toBe(FIXTURE_SHA);
    expect(fileSha(KERNEL)).toBe(KERNEL_SHA);
    const fixture = readJson(FIXTURE) as { id: string; canonicalSnapshotSha256: string }[];
    const fixtureRec = fixture.find((r) => r.id === ROOT_ID);
    expect(fixtureRec).toBeTruthy();
    expect(fixtureRec!.canonicalSnapshotSha256).toBe(ROOT_SNAPSHOT_SHA);

    const root = loadRoot();
    const rootSnap = snapshotSha(root);
    const sealSnap = sha256(canonicalJson(sealSummarize(root)));
    expect(rootSnap).toBe(sealSnap);
    const rootKey = stateKey(root);

    const replayPath = `${PREV_ROUND}/logs/g0_replay.json`;
    const replayAvailable = existsSync(replayPath);
    let replayRootKey: string | null = null;
    if (replayAvailable) {
      const prevReplay = readJson(replayPath);
      replayRootKey = prevReplay.root.rootStateKey;
      expect(rootKey).toBe(replayRootKey);
    }
    out.identity = {
      fixture: { path: FIXTURE, sha256: FIXTURE_SHA },
      kernel: { path: KERNEL, sha256: KERNEL_SHA },
      root: {
        id: ROOT_ID,
        stateKey: rootKey,
        previousRoundStateKey: replayRootKey,
        canonicalSnapshotSha256: ROOT_SNAPSHOT_SHA,
        currentSummarySha256: rootSnap,
        summaryMatchesHistorical: rootSnap === ROOT_SNAPSHOT_SHA,
        sealUtilSummarySha256: sealSnap,
        summary: summarize(root),
      },
    };

    // ---- 4. frozen D2 parity targets (values only, no re-run) --------------
    const rootValuesPath = `${PREV_ROUND}/D2_ROOT_VALUES.json`;
    const candidatesPath = `${PREV_ROUND}/D2_CANDIDATES.json`;
    const artifactsAvailable = existsSync(rootValuesPath) && existsSync(candidatesPath);
    let d2Plans: string[] = [];
    if (artifactsAvailable) {
      const rootValues = readJson(rootValuesPath);
      expect(rootValues.nodes).toBe(FROZEN_D2.nodes);
      expect(rootValues.leafNodes).toBe(FROZEN_D2.leafNodes);
      expect(rootValues.chanceNodes).toBe(FROZEN_D2.chanceNodes);
      expect(rootValues.value).toBe(FROZEN_D2.value);
      d2Plans = (readJson(candidatesPath).candidates as { planString: string }[]).map((c) => c.planString);
      expect(d2Plans).toEqual(FROZEN_D2.plans);
    }
    out.frozenTargets = {
      artifactsAvailable,
      d2: { ...FROZEN_D2, plans: d2Plans.length ? d2Plans : FROZEN_D2.plans },
      forcedComparison: { ...FROZEN_FORCED, label: 'round-01 forced-DUUD vs forced-DRRR comparison, NOT re-run this round' },
    };

    // ---- 5. historical SEAL labels (offline annotations only) --------------
    const recertPath = 'PPC-CAT-STRATEGY-SEAL-01/G6T2_RECERTIFICATION.json';
    const recert = readJson(recertPath);
    expect(recert.fixtureSha256).toBe(FIXTURE_SHA);
    expect(recert.canonicalSnapshotSha256).toBe(ROOT_SNAPSHOT_SHA);
    const turn = (name: string) => recert.fullTurnPrefixes.find((p: { name: string }) => p.name === name);
    const drrr = turn('DRRR');
    const uerr = turn('UURR');
    const drdr = turn('DRDR');
    expect(drrr).toBeTruthy();
    expect(uerr).toBeTruthy();
    expect(drdr).toBeTruthy();
    expect(drrr.catSurvive).toBe(true);
    expect(uerr.mouseForcedWin).toBe(true);
    expect(drdr.catSurvive).not.toBe(true);
    expect(drdr.mouseForcedWin).not.toBe(true);
    out.offlineLabels = {
      source: recertPath,
      frozenStatus: 'FROZEN_POSITIVE_CONTROLS_NOT_RERUN',
      labels: {
        UUDD: 'UNLABELED',
        DUUD: 'UNLABELED',
        LUDR: 'UNLABELED',
        UURR: 'MOUSE_FORCED_WIN_PROVEN',
        DRRR: 'CAT_SURVIVAL_PROVEN_H2',
        DRDR: 'UNLABELED',
      },
      drrrCertificate: drrr.certificates[0].verified,
      note: 'Labels are recorded for OFFLINE adjudication only; enumeration and any ordering must never read them.',
    };

    // ---- 6. production file set unchanged since round 01 -------------------
    const nowMismatch = sources.filter((s) => fileSha(s.path) !== s.sha256);
    expect(nowMismatch).toEqual([]);
    out.productionUnchanged = true;

    writeJson(`${OUT}/logs/g0_identity.json`, out);
    console.log(`G0 identity: ${sources.length}/39 production sources match, ledger verified=${verified.length} missing=${missing.length}`);
    console.log('root snapshot =', rootSnap, 'stateKey =', rootKey);
  });
});
