/// <reference types="node" />
/**
 * TACT-2 — human root reconstruction & identity certification.
 *
 * For all 24 frozen cat-turn roots:
 *   - the fixture file itself must hash to the frozen SHA256;
 *   - each root's `sourceSha256` must match the on-disk human log byte-for-byte;
 *   - each root's reconstructed canonical snapshot must hash back to
 *     `canonicalSnapshotSha256` (i.e. the snapshot we search on IS the one the
 *     fixture certified), and `captureHardRoot(restore(snap))` must round-trip;
 *   - the root must be a legal, live cat-turn state (no RULE-A verdict pending).
 *
 * Classification discipline (report §5): a root is REAL_HUMAN_REPLAY only if the
 * state came out of a human log AND its identity round-trips. Everything
 * constructed later for the synthetic matrix is labelled SYNTHETIC and never
 * counted as a human game.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot, captureHardRoot } from '../../src/game/ai/hardHistory';
import { applyNoMoveLoss, noMoveLossVerdict } from '../../src/game/rules/mobility';
import { stateKey } from '../../src/game/ai/transposition';
import { summarize, renderBoard, legalLabels, canonicalJson } from './lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const FROZEN_FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const OUT_DIR = 'PPC-CAT-STRATEGY-01/_raw';
const LOG_DIR = 'ai-training/f2b19a';

interface RootRecord {
  id: string; file: string; line: number; state: unknown;
  sourceSha256: string; canonicalSnapshotSha256: string;
}

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

describe('TACT-2 human root reconstruction', () => {
  it('reconstructs and certifies all 24 roots', () => {
    const raw = readFileSync(FIXTURE);
    const fixtureSha = sha256(raw);
    expect(fixtureSha).toBe(FROZEN_FIXTURE_SHA);

    const records = JSON.parse(raw.toString('utf8')) as RootRecord[];
    expect(records.length).toBe(24);

    // Source logs: one hash map, recomputed from disk now (not copied from the fixture).
    const logSha = new Map<string, string>();
    for (const f of ['log_gameA.txt', 'log_gameB.txt', 'log_gameC.txt', 'log_gameD.txt']) {
      logSha.set(f, sha256(readFileSync(`${LOG_DIR}/${f}`)));
    }

    const out = records.map((r) => {
      const state: GameEngineState = restoreHardRoot(r.state as never);
      const snapBack = captureHardRoot(state);
      const canonicalSha = sha256(canonicalJson(snapBack));
      const sourceShaNow = logSha.get(r.file) ?? 'MISSING_FILE';
      const verdict = noMoveLossVerdict(state);
      const legal = legalLabels(state);

      return {
        id: r.id,
        source: { file: `${LOG_DIR}/${r.file}`, line: r.line },
        identity: {
          frozenSourceSha256: r.sourceSha256,
          recomputedSourceSha256: sourceShaNow,
          sourceMatches: sourceShaNow === r.sourceSha256,
          frozenCanonicalSnapshotSha256: r.canonicalSnapshotSha256,
          recomputedCanonicalSnapshotSha256: canonicalSha,
          canonicalMatches: canonicalSha === r.canonicalSnapshotSha256,
          stateKey: stateKey(state),
        },
        classification: sourceShaNow === r.sourceSha256 && canonicalSha === r.canonicalSnapshotSha256
          ? 'REAL_HUMAN_REPLAY'
          : 'HUMAN_ROOT_RECONSTRUCTION',
        state: summarize(state),
        ruleAVerdictAtRoot: verdict ? verdict.reason : null,
        legalCatActions: legal,
        board: renderBoard(state),
      };
    });

    const allSourceOk = out.every((o) => o.identity.sourceMatches);
    const allCanonOk = out.every((o) => o.identity.canonicalMatches);
    const allLive = out.every((o) => o.ruleAVerdictAtRoot === null);

    mkdirSync(OUT_DIR, { recursive: true });
    const payload = JSON.stringify({
      generatedAt: new Date().toISOString(),
      fixture: FIXTURE,
      fixtureSha256: fixtureSha,
      frozenFixtureSha256: FROZEN_FIXTURE_SHA,
      sourceLogSha256: Object.fromEntries(logSha),
      count: out.length,
      allSourceShaMatch: allSourceOk,
      allCanonicalSnapshotMatch: allCanonOk,
      allLiveSeat: allLive,
      roots: out,
    }, null, 2);
    // Deliverable (§13) lives at the package root; the _raw copy keeps the
    // byte-identical working artifact next to the other raw dumps.
    writeFileSync('PPC-CAT-STRATEGY-01/HUMAN_ROOT_RECONSTRUCTION.json', payload);
    writeFileSync(`${OUT_DIR}/human-root-reconstruction.json`, payload);

    expect(allSourceOk).toBe(true);
    expect(allCanonOk).toBe(true);
    expect(allLive).toBe(true);
  });

  it('G6T2 and G6T3 are the states the tactic narrative claims', () => {
    const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as RootRecord[];
    const g2: GameEngineState = restoreHardRoot(records.find((r) => r.id === 'G6T2')!.state as never);
    const g3: GameEngineState = restoreHardRoot(records.find((r) => r.id === 'G6T3')!.state as never);

    // G6T2: cat to move at (3,3), mouse at (1,6), entity butter at (2,6),
    //       mouse already carrying, one pending ghost at (5,1).
    expect(g2.currentPlayer).toBe('cat');
    expect(g2.catMovesLeft).toBe(4);
    expect(`${g2.catPosition.r},${g2.catPosition.c}`).toBe('3,3');
    expect(`${g2.mousePosition.r},${g2.mousePosition.c}`).toBe('1,6');
    expect(g2.butterPositions.map((b) => `${b.r},${b.c}`)).toEqual(['2,6']);
    expect(g2.mouseHasButter).toBe(true);
    expect(g2.mouseSkillActive).toBe(false);
    expect((g2.pendingButterSpawns ?? []).map((p) => `${p.r},${p.c}:${p.blockedMaterializations}`)).toEqual(['5,1:0']);

    // G6T3 is a DIFFERENT, later state: the mouse already ran its 6-step turn.
    // This is what makes "the loss was decided at G6T2" checkable.
    expect(`${g3.catPosition.r},${g3.catPosition.c}`).toBe('1,5');
    expect(`${g3.mousePosition.r},${g3.mousePosition.c}`).toBe('7,6');
    expect(g3.mouseHasButter).toBe(true);

    // Restoring must not mutate the fixture: capture is a deep copy.
    expect(applyNoMoveLoss(g2)).toBe(g2);
  });

  it('every root is a legal cat seat with a complete 4-move budget', () => {
    const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as RootRecord[];
    for (const r of records) {
      const s: GameEngineState = restoreHardRoot(r.state as never);
      expect(s.phase, r.id).toBe('playing');
      expect(s.currentPlayer, r.id).toBe('cat');
      expect(s.catMovesLeft, r.id).toBe(s.config.catBaseMoves);
      expect(noMoveLossVerdict(s), r.id).toBeNull();
    }
  });
});
