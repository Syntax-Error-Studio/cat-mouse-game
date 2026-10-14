/// <reference types="node" />
/**
 * P0-3 — fixture integrity + portability guards.
 *
 * These tests are the audit trail for the fixture rewire:
 *   F1  every bundled record verifies (canonical snapshot digest, restored
 *       `stateKey`, and every pinned key field) — the loader throws on a
 *       mismatch, so a hand-edited fixture fails here rather than silently
 *       testing a different position;
 *   F2  every record carries provenance (origin authority + selector) and no
 *       record was invented: each one names a frozen source artifact;
 *   F3  the test suite no longer reads gitignored material or author-absolute
 *       paths — the one documented survivor is the G0.3W real-corpus loader,
 *       whose corpus is missing and whose tests therefore SKIP explicitly
 *       (never a vacuous pass); adding a second such loader fails this test;
 *   F4  the bundled fixture JSON files exist, are non-empty, and live inside
 *       `src` — i.e. inside what GitHub ships. Presence and location only: this
 *       guard does not run git, so it is not a repository-tracking check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fixtureRecordIndex, restoreFrozenState, g4Boundaries, f03ThreatAuthority,
  frozenFixtureProvenance,
} from './fixtures/frozenFixtures';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const TESTS_DIR = fileURLToPath(new URL('./', import.meta.url));

describe('P0-3 bundled frozen fixtures', () => {
  it('F1: every record re-verifies (digest + stateKey + key fields) and restores', () => {
    const index = fixtureRecordIndex();
    expect(index.length).toBeGreaterThanOrEqual(9);
    for (const entry of index) {
      // restoreFrozenState throws on ANY mismatch, so this assertion is the
      // integrity check itself — no record is skipped.
      const state = restoreFrozenState(entry.record);
      expect(state).toBeTruthy();
      expect(state.catPosition).toBeTruthy();
      expect(state.mousePosition).toBeTruthy();
    }
    // the shared loaders the regressions actually use
    const g4 = g4Boundaries();
    expect(g4.goodRecord.id).toBe('G4_GOOD_boundary');
    expect(g4.badRecord.id).toBe('G4_BAD_boundary');
    expect(f03ThreatAuthority().g19t7.oracleSafePlans.length).toBeGreaterThan(0);
  });

  it('F2: every record carries provenance and an integrity digest', () => {
    for (const entry of fixtureRecordIndex()) {
      expect(entry.record.id).toBeTruthy();
      expect(entry.record.origin).toMatch(/^ai-training\/(d01|f0|f03|f2b14)\/.+\.[a-z]+$/);
      expect(entry.record.selector).toBeTruthy();
      expect(entry.record.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.record.snapshotBytes).toBeGreaterThan(0);
      expect(entry.record.stateKey).toBeTruthy();
      expect(['declared-by-origin', 'computed-at-extraction']).toContain(entry.record.stateKeySource);
    }
    const prov = frozenFixtureProvenance() as {
      purpose: string; extractionRule: string; originFiles: Record<string, unknown>;
      fixtures: string[]; notPorted: Array<{ path: string; status: string }>;
    };
    expect(prov.purpose).toBeTruthy();
    expect(prov.extractionRule).toBeTruthy();
    expect(Object.keys(prov.originFiles).length).toBeGreaterThanOrEqual(4);
    expect(prov.fixtures).toEqual(expect.arrayContaining([
      'g4_boundaries.d01.json', 'turn_roots.f0.json', 'threat_authority.f03.json', 'game5_turns.f2b14.json',
    ]));
    expect(prov.notPorted.length).toBeGreaterThanOrEqual(1);
    expect(String(prov.notPorted[0].status)).toMatch(/BLOCKED/);
  });

  it('F3: no test file reads gitignored or author-absolute material', () => {
    const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    const escaping: string[] = [];
    for (const f of files) {
      const src = readFileSync(TESTS_DIR + f, 'utf8');
      // reads that reach the git-ignored research tree, or a Windows path that
      // only exists on the author's machine
      if (/readFileSync\(\s*['"]ai-training|['"]C:[\\/]/.test(src)) escaping.push(f);
      // dynamic imports that leave the src tree entirely
      if (/import\(\s*['"]\.\.\/\.\.\/\.\.\/\.\.\//.test(src)) escaping.push(`${f} (escapes src)`);
    }
    // Exactly one documented survivor: the G0.3W real-corpus loader whose
    // corpus (post-g03h-real-failure-5games.txt) no longer exists anywhere.
    // Its 4 regressions skip explicitly. If a second one appears, FAIL.
    expect(escaping).toEqual(['boundedPlanRefutation.test.ts (escapes src)']);

    // The bundled fixture data itself must stay machine-independent.
    for (const f of readdirSync(FIXTURES_DIR)) {
      if (!f.endsWith('.json')) continue;
      const text = readFileSync(FIXTURES_DIR + f, 'utf8');
      expect(text, `${f} contains an author-absolute path`).not.toMatch(/[A-Za-z]:[\\/](Users|home)\b/);
      expect(text, `${f} reads the git-ignored research tree`).not.toMatch(/readFileSync\(\s*['"]ai-training/);
    }
  });

  it('F4: bundled fixture JSON files are present, non-empty and located under src/', () => {
    const jsons = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));
    expect(jsons.length).toBeGreaterThanOrEqual(5);
    for (const j of jsons) {
      const st = statSync(FIXTURES_DIR + j);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBeGreaterThan(0);
    }
    // Presence + location only. This deliberately does NOT consult git: it
    // proves the data files sit inside src (the tree the published repo ships),
    // not that any particular file is tracked — running `git ls-files` here
    // would add a git dependency to the unit suite and would fail in a
    // git-metadata-free copy. Tracking is checked outside the suite, by
    // `node scripts/verify-source-checkpoint.mjs` and by review of
    // `git diff --cached --name-status`.
    expect(FIXTURES_DIR.replace(/\\/g, '/')).toContain('/src/game/ai/__tests__/fixtures/');
  });
});
