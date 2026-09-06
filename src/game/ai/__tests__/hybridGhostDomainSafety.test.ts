/**
 * G0.4F-2A.2 — Legacy Hybrid Ghost-Domain Safety Gate tests (A-L).
 *
 * Confirms the frozen 808-feature ValueNet does NOT represent pending
 * ghost-butter spawns or placement debt (representation aliasing), and that
 * `isHybridEligibleState` now rejects such states so Hybrid V1/V2 fail-closed
 * to baseline evaluateForCat. Search rules still see ghosts/debt as
 * game-affecting (unchanged from F2A.1).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInitialState, type GameEngineState } from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty } from '../../types';
import { evaluateForCat } from '../evaluation';
import {
  isHybridEligibleState, hybridEvaluateForCat,
  buildProductionFeatures, resolveHardLeaf, setHardLeafMode,
} from '../hybridLeaf';
import { hybridRouteV2EvaluateForCat } from '../hybridRouteLeaf';
import { HARD_LEAF_MODE_CONFIG, HARD_LEAF_MODE_DEFAULT } from '../searchConfig';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { enumerateFullTurnLegacy } from '../turnBoundary';
import { simulateSearchAction } from '../simulator';
import { createEngineRuleSet } from '../../engine';
import { stateKey } from '../transposition';
import { PieceType, GamePhase, DIRECTIONS, type Direction } from '../../types';
import type { SearchAction } from '../searchTypes';

const rules = createEngineRuleSet();
const label = (a: SearchAction): string => a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?';

/** Restore a game turn root from the F0 timeline SNAPSHOT_JSON authority. */
function restoreTurnRoot(game: number, turn: number): GameEngineState {
  const t = JSON.parse(readFileSync('ai-training/f0/f0_timelines.json', 'utf8'));
  const entry = t[String(game)].turns.find((x: { turn: number }) => x.turn === turn);
  expect(entry).toBeTruthy();
  return restoreHardRoot(entry.root as HardRootSnapshot);
}

/** G19 real end states (from F03 authority). */
function g19EndStates(): { state: GameEngineState; witness: string; forced: boolean }[] {
  const f03 = JSON.parse(readFileSync('ai-training/f03/threat_onset.json', 'utf8'));
  const enumData = f03.games['G19_T7_ENUM'];
  const forcedMap = new Map<string, boolean>();
  for (const d of enumData.detail) forcedMap.set(d.witness as string, d.forced as boolean);
  const root = restoreTurnRoot(19, 7);
  const ends = enumerateFullTurnLegacy(root, rules);
  const seen = new Set<string>();
  const out: { state: GameEngineState; witness: string; forced: boolean }[] = [];
  for (const b of ends.boundaries) {
    if (b.state.currentPlayer !== PieceType.Mouse || b.state.phase !== GamePhase.Playing) continue;
    const k = stateKey(b.state);
    if (seen.has(k)) continue;
    seen.add(k);
    const wit = b.witness.map(label).join('');
    const forced = forcedMap.get(wit);
    if (forced === undefined) continue;
    out.push({ state: b.state, witness: wit, forced });
  }
  return out;
}

const DIR_BY_CHAR: Record<string, Direction> = {
  U: DIRECTIONS.find((d) => d.key === 'ArrowUp')!,
  D: DIRECTIONS.find((d) => d.key === 'ArrowDown')!,
  L: DIRECTIONS.find((d) => d.key === 'ArrowLeft')!,
  R: DIRECTIONS.find((d) => d.key === 'ArrowRight')!,
};
function replayPlan(root: GameEngineState, tokens: string[]): GameEngineState {
  let cur = root;
  for (const tok of tokens) {
    const a: SearchAction = tok === 'T' ? { type: 'catPlaceTrap' } : { type: 'catStep', direction: DIR_BY_CHAR[tok] };
    const r = simulateSearchAction(cur, a, rules);
    if (r.kind === 'chance') break;
    cur = r.state;
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return cur;
}
/** G17 safe/unsafe pair (from F03 arms authority). */
function g17Pair(): { safe: GameEngineState; unsafe: GameEngineState } {
  const f03 = JSON.parse(readFileSync('ai-training/f03/threat_onset.json', 'utf8'));
  const arm = f03.arms['G17T2'];
  const root = restoreTurnRoot(17, 2);
  return {
    safe: replayPlan(root, arm.PROD_PLAN.map((t: string) => (t === 'PT' ? 'T' : t))),
    unsafe: replayPlan(root, arm.DEEP_PLAN.map((t: string) => (t === 'PT' ? 'T' : t))),
  };
}

function freshCanonical(): GameEngineState {
  return createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard } as Parameters<typeof createInitialState>[0]);
}

describe('G0.4F-2A.2 legacy hybrid ghost-domain safety', () => {
  beforeEach(() => setHardLeafMode('baseline'));

  it('A: canonical no-ghost/no-debt state is eligible', () => {
    const s = freshCanonical();
    expect(s.pendingButterSpawns.length).toBe(0);
    expect(s.pendingButterPlacementDebt).toBe(0);
    expect(isHybridEligibleState(s)).toBe(true);
  });

  it('B: ghost count 1 → ineligible', () => {
    const s = { ...freshCanonical(), pendingButterSpawns: [{ r: 2, c: 3, blockedMaterializations: 0 }] };
    expect(isHybridEligibleState(s)).toBe(false);
  });

  it('C: debt 1 → ineligible', () => {
    const s = { ...freshCanonical(), pendingButterPlacementDebt: 1 };
    expect(isHybridEligibleState(s)).toBe(false);
  });

  it('D: ghost A/B produce IDENTICAL 808 features (representation alias) but BOTH ineligible', () => {
    const base = freshCanonical();
    const a = { ...base, pendingButterSpawns: [{ r: 2, c: 3, blockedMaterializations: 0 }] };
    const b = { ...base, pendingButterSpawns: [{ r: 7, c: 6, blockedMaterializations: 0 }] };
    // frozen 808 does not encode ghost → identical features (expected alias)
    const fa = buildProductionFeatures(a);
    const fb = buildProductionFeatures(b);
    expect([...fa]).toEqual([...fb]);
    // but both are ineligible so the old network is never used
    expect(isHybridEligibleState(a)).toBe(false);
    expect(isHybridEligibleState(b)).toBe(false);
  });

  it('E: debt0 vs debt2 produce IDENTICAL 808 features; debt2 ineligible', () => {
    const base = freshCanonical();
    const d0 = { ...base, pendingButterPlacementDebt: 0 };
    const d2 = { ...base, pendingButterPlacementDebt: 2 };
    const f0 = buildProductionFeatures(d0);
    const f2 = buildProductionFeatures(d2);
    expect([...f0]).toEqual([...f2]); // 808 does not encode debt
    expect(isHybridEligibleState(d0)).toBe(true);
    expect(isHybridEligibleState(d2)).toBe(false);
  });

  it('F: V1 ghost state → EXACT evaluateForCat fallback', () => {
    const s = { ...freshCanonical(), pendingButterSpawns: [{ r: 2, c: 3, blockedMaterializations: 0 }] };
    expect(hybridEvaluateForCat(s)).toBe(evaluateForCat(s));
  });

  it('G: V1 debt state → EXACT evaluateForCat fallback', () => {
    const s = { ...freshCanonical(), pendingButterPlacementDebt: 1 };
    expect(hybridEvaluateForCat(s)).toBe(evaluateForCat(s));
  });

  it('H: V2 ghost state → EXACT evaluateForCat fallback', () => {
    const s = { ...freshCanonical(), pendingButterSpawns: [{ r: 2, c: 3, blockedMaterializations: 0 }] };
    expect(hybridRouteV2EvaluateForCat(s)).toBe(evaluateForCat(s));
  });

  it('I: V2 debt state → EXACT evaluateForCat fallback', () => {
    const s = { ...freshCanonical(), pendingButterPlacementDebt: 1 };
    expect(hybridRouteV2EvaluateForCat(s)).toBe(evaluateForCat(s));
  });

  it('J: G19/G17/G4 results UNCHANGED on no-ghost fixtures (only eligibility gate added)', () => {
    // G19: oracle-safe UUDD rank #1 under V2 (on the frozen no-ghost corpus).
    const g19 = g19EndStates();
    expect(g19.length).toBeGreaterThan(0);
    // ensure no fixture carries ghosts/debt
    for (const e of g19) {
      expect(e.state.pendingButterSpawns.length).toBe(0);
      expect(e.state.pendingButterPlacementDebt).toBe(0);
    }
    const scored = g19.map(e => ({ witness: e.witness, forced: e.forced, score: hybridRouteV2EvaluateForCat(e.state) }));
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    expect(ranked[0].forced).toBe(false); // TOP1 oracle-safe
    const safeRanks = scored.filter(s => !s.forced).map(s => ranked.findIndex(r => r.witness === s.witness) + 1);
    expect(safeRanks[0]).toBe(1);
    // G17
    const g17 = g17Pair();
    expect(hybridRouteV2EvaluateForCat(g17.safe)).toBeGreaterThan(hybridRouteV2EvaluateForCat(g17.unsafe));
    // G4
    const lines = readFileSync('ai-training/d01/exact_teacher_audit_roots.ndjson', 'utf8').trim().split('\n').filter((l: string) => l.length > 0);
    let goodSnap: HardRootSnapshot | null = null, badSnap: HardRootSnapshot | null = null;
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (rec.source === 'G4_GOOD_boundary') goodSnap = rec.snapshot as HardRootSnapshot;
      else if (rec.source === 'G4_BAD_boundary') badSnap = rec.snapshot as HardRootSnapshot;
    }
    expect(goodSnap).toBeTruthy(); expect(badSnap).toBeTruthy();
    const good = restoreHardRoot(goodSnap!); const bad = restoreHardRoot(badSnap!);
    expect(hybridRouteV2EvaluateForCat(good)).toBeGreaterThan(hybridRouteV2EvaluateForCat(bad));
  });

  it('K: default leaf mode unchanged (baseline)', () => {
    expect(HARD_LEAF_MODE_DEFAULT).toBe('baseline');
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
    expect(resolveHardLeaf()).toBe(evaluateForCat);
  });

  it('L: single eligibility source — V1 and V2 both gate via isHybridEligibleState', () => {
    // V2 wrapper reuses isHybridEligibleState (not a separate copy); assert the
    // wrapper's eligibility path IS the shared source by checking an ineligible
    // (ghost) state returns baseline through the production wrapper.
    const s = { ...freshCanonical(), pendingButterSpawns: [{ r: 2, c: 3, blockedMaterializations: 0 }] };
    expect(hybridRouteV2EvaluateForCat(s)).toBe(evaluateForCat(s));
    expect(hybridEvaluateForCat(s)).toBe(evaluateForCat(s));
    // and a canonical state stays eligible through both
    const c = freshCanonical();
    expect(isHybridEligibleState(c)).toBe(true);
    expect(Number.isFinite(hybridRouteV2EvaluateForCat(c))).toBe(true);
    expect(Number.isFinite(hybridEvaluateForCat(c))).toBe(true);
  });
});
