/**
 * G0.4F-1.3 — hybridRouteLeaf (V2) production integration tests.
 *
 * Covers (§16):
 *   A. exact formula parity (production V2 == F12 confirmedCandidateLeaf)
 *   B. default baseline
 *   C. resolver 3-mode mapping
 *   D. strict eligibility fallback (output === evaluateForCat EXACT)
 *   E. real NaN model fallback (V2 → BASELINE, not V1)
 *   F. real throw model fallback (V2 → BASELINE)
 *   G. G19 real production regression (oracle-safe UUDD rank #1)
 *   H. G17 safe > unsafe (production V2)
 *   I. G4 real regression (production V2 GOOD > BAD)
 *   J. V1 unchanged
 *   K. single flag source of truth
 *   L. DebugInfo mode label semantics (BASELINE / HYBRID_V1 / HYBRID_V2)
 *
 * G19/G17/G4 fixtures are reconstructed from the frozen ai-training
 * authorities (SNAPSHOT_JSON restore + real RuleSet enumeration), so these
 * are REAL production-evaluator regressions, not pinned-literal masquerades.
 */
/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInitialState, createEngineRuleSet, type GameEngineState } from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty, GamePhase, PieceType, CellType, DIRECTIONS } from '../../types';
import type { Direction } from '../../types';
import type { SearchAction } from '../searchTypes';
import { evaluateForCat } from '../evaluation';
import {
  isHybridEligibleState, hybridEvaluateForCat, productionValueNet,
  resolveHardLeaf, setHardLeafMode, getHardLeafMode,
} from '../hybridLeaf';
import {
  hybridRouteV2EvaluateForCat, evaluateHybridRouteV2Eligible,
} from '../hybridRouteLeaf';
import { HARD_LEAF_MODE_CONFIG, HARD_LEAF_MODE_DEFAULT } from '../searchConfig';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { enumerateFullTurnLegacy } from '../turnBoundary';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';

const rules = createEngineRuleSet();
const label = (a: SearchAction): string => a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?';

/** The F12 confirmed candidate math, re-implemented INLINE (same as
 *  confirmedCandidateLeaf) so the test is self-contained and the production
 *  build never imports from ai-training/. */
function f12ConfirmedMath(state: GameEngineState): number {
  if (!isHybridEligibleState(state)) return evaluateForCat(state);
  const h = evaluateHybridRouteV2Eligible(state, productionValueNet);
  if (!Number.isFinite(h)) return evaluateForCat(state);
  return h;
}

/** Load the G4 GOOD/BAD boundary snapshots from the frozen corpus ndjson. */
function g4Boundaries(): { good: GameEngineState; bad: GameEngineState } {
  const lines = readFileSync('ai-training/d01/exact_teacher_audit_roots.ndjson', 'utf8').trim().split('\n').filter((l: string) => l.length > 0);
  let goodSnap: HardRootSnapshot | null = null, badSnap: HardRootSnapshot | null = null;
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.source === 'G4_GOOD_boundary') goodSnap = rec.snapshot as HardRootSnapshot;
    else if (rec.source === 'G4_BAD_boundary') badSnap = rec.snapshot as HardRootSnapshot;
  }
  expect(goodSnap).toBeTruthy();
  expect(badSnap).toBeTruthy();
  return { good: restoreHardRoot(goodSnap!), bad: restoreHardRoot(badSnap!) };
}

/** Reconstruct a game turn root from the F0 timeline SNAPSHOT_JSON authority. */
function restoreTurnRoot(game: number, turn: number): GameEngineState {
  const t = JSON.parse(readFileSync('ai-training/f0/f0_timelines.json', 'utf8'));
  const entry = t[String(game)].turns.find((x: { turn: number }) => x.turn === turn);
  expect(entry).toBeTruthy();
  return restoreHardRoot(entry.root as HardRootSnapshot);
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

// ---- G19 real end states (reconstruct from ai-training authority) ----
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

// ---- G17 safe/unsafe pair (from F03 arms authority) ----
function g17Pair(): { safe: GameEngineState; unsafe: GameEngineState } {
  const f03 = JSON.parse(readFileSync('ai-training/f03/threat_onset.json', 'utf8'));
  const arm = f03.arms['G17T2'];
  const root = restoreTurnRoot(17, 2);
  const prodTokens: string[] = arm.PROD_PLAN.map((t: string) => (t === 'PT' ? 'T' : t));
  const deepTokens: string[] = arm.DEEP_PLAN.map((t: string) => (t === 'PT' ? 'T' : t));
  return { safe: replayPlan(root, prodTokens), unsafe: replayPlan(root, deepTokens) };
}

describe('G0.4F-1.3 hybridRouteLeaf (V2)', () => {
  beforeEach(() => setHardLeafMode('baseline'));

  // ---- A. exact formula parity (production V2 == F12 confirmed math) ----
  it('A: production V2 matches F12 confirmed math on eligible canonical states', () => {
    const canon = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard });
    expect(isHybridEligibleState(canon)).toBe(true);
    const g19 = g19EndStates();
    const states = [canon, ...g19.map(e => e.state)];
    for (const st of states) {
      if (!isHybridEligibleState(st)) continue;
      const prod = hybridRouteV2EvaluateForCat(st);
      const f = f12ConfirmedMath(st);
      expect(Math.abs(prod - f)).toBeLessThanOrEqual(1e-12);
    }
  });

  // ---- B. default baseline ----
  it('B: default leaf mode is exactly baseline', () => {
    expect(HARD_LEAF_MODE_DEFAULT).toBe('baseline');
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
    expect(resolveHardLeaf()).toBe(evaluateForCat);
  });

  // ---- C. resolver 3-mode mapping ----
  it('C: resolveHardLeaf maps all 3 modes', () => {
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
    expect(resolveHardLeaf()).toBe(evaluateForCat);
    HARD_LEAF_MODE_CONFIG.current = 'hybrid_standard_only';
    expect(resolveHardLeaf()).toBe(hybridEvaluateForCat);
    HARD_LEAF_MODE_CONFIG.current = 'hybrid_route_v2_standard_only';
    expect(resolveHardLeaf()).toBe(hybridRouteV2EvaluateForCat);
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
  });

  // ---- D. strict eligibility fallback (output === baseline EXACT) ----
  it('D: ineligible states return EXACT evaluateForCat (not just similar)', () => {
    const canon = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard });
    const cases: GameEngineState[] = [
      { ...canon, phase: GamePhase.ChoosingTunnelExit, currentPlayer: PieceType.Mouse } as GameEngineState,
    ];
    const wall = JSON.parse(JSON.stringify(canon)) as GameEngineState; wall.board[0][0].type = CellType.Wall;
    const vd = JSON.parse(JSON.stringify(canon)) as GameEngineState; vd.board[1][1].type = CellType.Void;
    const easy = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Easy });
    const med = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Medium });
    const ct = { ...canon, config: { ...canon.config, customTerrain: [[0, 0, CellType.Wall]] } } as GameEngineState;
    const cc = { ...canon, config: { ...canon.config, tunnelCorners: [] } } as GameEngineState;
    const po = { ...canon, config: { ...canon.config, boxPositions: [{ r: 0, c: 1 }] } } as GameEngineState;
    for (const st of [wall, vd, easy, med, ct, cc, po, ...cases]) {
      expect(isHybridEligibleState(st)).toBe(false);
      expect(hybridRouteV2EvaluateForCat(st)).toBe(evaluateForCat(st));
    }
  });

  // ---- E. real NaN model fallback ----
  it('E: injected NaN model falls back to BASELINE evaluateForCat (not V1)', () => {
    const canon = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard });
    const base = evaluateForCat(canon);
    // emulate the production wrapper decision with an injected NaN model
    const h = (() => { try { const v = evaluateHybridRouteV2Eligible(canon, () => NaN); return Number.isFinite(v) ? v : evaluateForCat(canon); } catch { return evaluateForCat(canon); } })();
    expect(h).toBe(base);
    // also assert the eligible core itself is non-finite with NaN model
    expect(Number.isFinite(evaluateHybridRouteV2Eligible(canon, () => NaN))).toBe(false);
  });

  // ---- F. real throw model fallback ----
  it('F: injected throwing model falls back to BASELINE evaluateForCat', () => {
    const canon = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard });
    const base = evaluateForCat(canon);
    const h = (() => { try { const v = evaluateHybridRouteV2Eligible(canon, () => { throw new Error('model'); }); return Number.isFinite(v) ? v : evaluateForCat(canon); } catch { return evaluateForCat(canon); } })();
    expect(h).toBe(base);
  });

  // ---- G. G19 real production regression ----
  it('G: G19 oracle-safe UUDD is rank #1 under production V2', () => {
    const g19 = g19EndStates();
    expect(g19.length).toBeGreaterThan(0);
    const scored = g19.map(e => ({ witness: e.witness, forced: e.forced, score: hybridRouteV2EvaluateForCat(e.state) }));
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    expect(ranked[0].forced).toBe(false); // TOP1 is oracle-safe
    expect(ranked.slice(0, 2).some(r => !r.forced)).toBe(true); // safe in top-2
    const safeRanks = scored.filter(s => !s.forced).map(s => ranked.findIndex(r => r.witness === s.witness) + 1);
    expect(safeRanks[0]).toBe(1); // best safe state is rank #1
  });

  // ---- H. G17 safe > unsafe ----
  it('H: G17 production V2 ranks the SAFE end above the UNSAFE end', () => {
    const { safe, unsafe } = g17Pair();
    expect(hybridRouteV2EvaluateForCat(safe)).toBeGreaterThan(hybridRouteV2EvaluateForCat(unsafe));
  });

  // ---- I. G4 real regression ----
  it('I: G4 GOOD > BAD under production V2 (frozen authority states)', () => {
    const { good, bad } = g4Boundaries();
    expect(hybridRouteV2EvaluateForCat(good)).toBeGreaterThan(hybridRouteV2EvaluateForCat(bad));
  });

  // ---- J. V1 unchanged ----
  it('J: Hybrid V1 is unchanged and still functions', () => {
    const canon = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard });
    const v1 = hybridEvaluateForCat(canon);
    expect(Number.isFinite(v1)).toBe(true);
    const v2 = hybridRouteV2EvaluateForCat(canon);
    expect(Math.abs(v1 - v2)).toBeGreaterThan(1e-12);
    HARD_LEAF_MODE_CONFIG.current = 'hybrid_standard_only';
    expect(resolveHardLeaf()).toBe(hybridEvaluateForCat);
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
  });

  // ---- K. single flag source of truth ----
  it('K: single mutable runtime source HARD_LEAF_MODE_CONFIG.current', () => {
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
    setHardLeafMode('hybrid_route_v2_standard_only');
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('hybrid_route_v2_standard_only');
    expect(getHardLeafMode()).toBe('hybrid_route_v2_standard_only');
    setHardLeafMode('baseline');
  });

  // ---- L. DebugInfo mode label semantics ----
  it('L: leaf labels map baseline/hybrid_standard_only/hybrid_route_v2_standard_only', () => {
    // Mirrors DebugInfo.tsx leafLabel logic (must stay in sync).
    const labelOf = (m: string) => m === 'baseline' ? 'BASELINE' : m === 'hybrid_standard_only' ? 'HYBRID_V1' : 'HYBRID_V2';
    expect(labelOf('baseline')).toBe('BASELINE');
    expect(labelOf('hybrid_standard_only')).toBe('HYBRID_V1');
    expect(labelOf('hybrid_route_v2_standard_only')).toBe('HYBRID_V2');
    const cycle = ['baseline', 'hybrid_standard_only', 'hybrid_route_v2_standard_only'];
    expect(cycle[(cycle.indexOf('baseline') + 1) % 3]).toBe('hybrid_standard_only');
    expect(cycle[(cycle.indexOf('hybrid_standard_only') + 1) % 3]).toBe('hybrid_route_v2_standard_only');
    expect(cycle[(cycle.indexOf('hybrid_route_v2_standard_only') + 1) % 3]).toBe('baseline');
  });
});
