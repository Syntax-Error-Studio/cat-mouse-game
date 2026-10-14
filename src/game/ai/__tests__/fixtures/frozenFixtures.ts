/// <reference types="node" />
/**
 * P0-3 — Portable loader for the frozen experiment states the AI regression
 * tests need.
 *
 * Before this module, five test files read their positions straight out of
 * `ai-training/`, which `.gitignore` excludes (`.gitignore:24`). A fresh GitHub
 * clone therefore could not run them. The records below are verbatim copies of
 * the relevant snapshot fields from those local authorities; see
 * `./PROVENANCE.json` for origin paths, origin digests and the extraction rule.
 *
 * Every record is verified before it is handed out:
 *   - the canonical snapshot JSON must re-hash to the pinned SHA-256
 *     (tamper evidence for the fixture file itself), and
 *   - `restoreHardRoot(snapshot)` must reproduce the pinned `stateKey`
 *     (the snapshot really is the state the frozen authority says it is).
 * A mismatch throws — the loader never substitutes a similar-looking state.
 *
 * Paths resolve from `import.meta.url`, so nothing here depends on the CWD or
 * on a directory that only exists on the author's machine.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot, type HardRootSnapshot } from '../../hardHistory';
import { stateKey } from '../../transposition';
import type { GameEngineState } from '../../../engine';

export interface FrozenKeyFields {
  cat: string;
  mouse: string;
  currentPlayer: string;
  phase: string;
  catMovesLeft: number;
  mouseMovesLeft: number;
  mouseHasButter: boolean;
  mouseSkillActive: boolean;
  trap: string | null;
  catTrapsRemaining: number;
  butter: string[];
  pendingButterSpawns: number;
  pendingButterPlacementDebt: number;
  difficulty: string;
  boardSize: number;
  gameMode: string;
}

export interface FrozenRecord {
  id: string;
  origin: string;
  selector: string;
  stateKey: string;
  stateKeySource: 'declared-by-origin' | 'computed-at-extraction';
  originDeclaredStateKey?: string;
  originStateKeyMatches?: boolean;
  snapshotSha256: string;
  snapshotBytes: number;
  keyFields: FrozenKeyFields;
  snapshot: HardRootSnapshot;
}

interface FixtureFile { recordKind: string; extractedAt: string; records: FrozenRecord[] }

const fixture = (name: string): FixtureFile =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')) as FixtureFile;

const canon = (snap: HardRootSnapshot): string => JSON.stringify(snap);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const cache = new Map<string, FrozenRecord[]>();
/** The three bundled files that carry state snapshots (f03 is plan authority
 *  only, PROVENANCE is metadata). */
const SNAPSHOT_FILES = ['g4_boundaries.d01.json', 'turn_roots.f0.json', 'game5_turns.f2b14.json'] as const;
function records(file: string): FrozenRecord[] {
  let recs = cache.get(file);
  if (!recs) { recs = fixture(file).records; cache.set(file, recs); }
  return recs;
}

function byId(file: string, id: string): FrozenRecord {
  const rec = records(file).find((r) => r.id === id);
  if (!rec) throw new Error(`frozen fixture ${file} has no record "${id}"`);
  return rec;
}

/** Verify a record's pinned digests/identity, then restore the state it claims. */
export function restoreFrozenState(rec: FrozenRecord): GameEngineState {
  const actualHash = sha256(canon(rec.snapshot));
  if (actualHash !== rec.snapshotSha256) {
    throw new Error(`frozen fixture "${rec.id}" snapshot sha256 mismatch (expected ${rec.snapshotSha256}, got ${actualHash}) — the fixture file was modified`);
  }
  const state = restoreHardRoot(rec.snapshot);
  const actualKey = stateKey(state);
  if (actualKey !== rec.stateKey) {
    throw new Error(`frozen fixture "${rec.id}" stateKey mismatch (expected ${rec.stateKey}, got ${actualKey}) — the snapshot no longer restores to the frozen state`);
  }
  for (const [field, expected] of Object.entries(rec.keyFields) as Array<[keyof FrozenKeyFields, unknown]>) {
    const got = field === 'butter'
      ? state.butterPositions.map((b) => `${b.r},${b.c}`)
      : field === 'pendingButterSpawns'
        ? state.pendingButterSpawns.length
        : field === 'trap'
        ? (state.trapPosition ? `${state.trapPosition.r},${state.trapPosition.c}` : null)
        : field === 'cat' ? `${state.catPosition.r},${state.catPosition.c}`
          : field === 'mouse' ? `${state.mousePosition.r},${state.mousePosition.c}`
            : field === 'difficulty' ? state.config.difficulty
              : field === 'boardSize' ? state.config.boardSize
                : field === 'gameMode' ? state.gameMode
                  : (state as unknown as Record<string, unknown>)[field];
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      throw new Error(`frozen fixture "${rec.id}" key field "${field}" mismatch (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`);
    }
  }
  return state;
}

/** Every snapshot record in the bundle, for the integrity audit test. */
export function fixtureRecordIndex(): Array<{ file: string; record: FrozenRecord }> {
  const out: Array<{ file: string; record: FrozenRecord }> = [];
  for (const file of SNAPSHOT_FILES) for (const record of records(file)) out.push({ file, record });
  return out;
}

// ---------------------------------------------------------------------------
// G4 — the shared boundary-pair loader (P0-1's single source of the G4 states)
// ---------------------------------------------------------------------------
/**
 * The frozen G4 GOOD/BAD boundary states (d01 exact-teacher audit, records r38
 * / r39). Both are mouse-to-move ('currentPlayer': 'mouse'), phase 'playing',
 * Hard difficulty, 10x10 standard map, mouseHasButter with butter at (5,2) and
 * (2,8), catMovesLeft 0, mouseMovesLeft 3, 12 boxes on the board.
 *
 * NOT a single-variable pair — re-parsing the bundled g4_boundaries.d01.json
 * (2026-10-14) gives exactly three coupled differences:
 *   cat (3,5)→(3,7) · trap (2,4)→(2,3) · one box (4,4)→(3,8);
 * every other cell and field is equal. So GOOD > BAD is a ranking regression
 * observed on a real frozen boundary, not an ablation of the cat position.
 */
export function g4Boundaries(): { good: GameEngineState; bad: GameEngineState; goodRecord: FrozenRecord; badRecord: FrozenRecord } {
  const goodRecord = byId('g4_boundaries.d01.json', 'G4_GOOD_boundary');
  const badRecord = byId('g4_boundaries.d01.json', 'G4_BAD_boundary');
  return { good: restoreFrozenState(goodRecord), bad: restoreFrozenState(badRecord), goodRecord, badRecord };
}

// ---------------------------------------------------------------------------
// F0 — real-game turn roots
// ---------------------------------------------------------------------------
export type F0TurnRootId = 'G16T8' | 'G17T2' | 'G19T7' | 'G24T1';
export function f0TurnRoot(id: F0TurnRootId): GameEngineState {
  return restoreFrozenState(byId('turn_roots.f0.json', id));
}

// ---------------------------------------------------------------------------
// F2B-1.4 — game 5 (H1 human-validation log) turn roots
// ---------------------------------------------------------------------------
export function game5TurnRoot(turn: 4 | 5 | 14 | 15): GameEngineState {
  return restoreFrozenState(byId('game5_turns.f2b14.json', `game5_T${turn}`));
}

// ---------------------------------------------------------------------------
// F0.3 — oracle enumeration / plan authority (no state snapshot involved)
// ---------------------------------------------------------------------------
export interface F03ThreatAuthority {
  g19t7: {
    game: number; turn: number; prodPlan: string;
    totalUniqueEnds: number; safeCount: number; unsafeCount: number; infeasibleCount: number;
    AVOIDABLE_AT_ROOT: boolean;
    detail: { witness: string; forced: boolean; infeasible: boolean }[];
    oracleSafePlans: { witness: string; cat: string; mouse: string }[];
  };
  g17t2: {
    game: number; turn: number;
    PROD_PLAN: string[]; DEEP_PLAN: string[];
    PROD_ORACLE: unknown; DEEP_ORACLE: unknown;
    PROD_FORCED_PICKUP_WIN2: unknown; DEEP_FORCED_PICKUP_WIN2: unknown;
  };
}
let f03Cache: F03ThreatAuthority | null = null;
export function f03ThreatAuthority(): F03ThreatAuthority {
  if (!f03Cache) {
    const raw = JSON.parse(readFileSync(new URL('./threat_authority.f03.json', import.meta.url), 'utf8')) as
      { recordKind: string; g19t7: F03ThreatAuthority['g19t7']; g17t2: F03ThreatAuthority['g17t2'] };
    f03Cache = { g19t7: raw.g19t7, g17t2: raw.g17t2 };
  }
  return f03Cache;
}

export function frozenFixtureProvenance(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL('./PROVENANCE.json', import.meta.url), 'utf8')) as Record<string, unknown>;
}
