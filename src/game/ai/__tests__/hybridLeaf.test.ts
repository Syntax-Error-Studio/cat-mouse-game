/**
 * G0.4E-1.1 — hybridLeaf production integration HARDENED tests.
 *
 * §1 single flag source; §2 strict eligibility; §3 golden ValueNet parity;
 * §4 exact fingerprint; §5 real fail-closed (composition + guards);
 * §6 REAL G4 regression (restored frozen states through the live production
 * evaluator); §8 default OFF.
 *
 * The real CALL-OBSERVATION evidence (§7 — the leaf being INVOKED by the
 * production search) lives in `hybridLeafCallObservation.test.ts`, because that
 * file has to mock `../hybridLeaf` to instrument the resolved leaf. Mocking here
 * would destroy the §1/§8 resolver-IDENTITY claims, which are separate evidence
 * and are kept intact.
 *
 * P0-1 remediation notes:
 *   - S6 used to compare two pinned literals against each other, which no
 *     model change could ever fail. It now restores the frozen G4 GOOD/BAD
 *     boundary states and calls the CURRENT production `hybridEvaluateForCat`.
 *   - G4 evidence here is a LEAF-RANKING claim (one static state vs another).
 *     Whole-search/whole-game G4 behaviour is a different claim and is NOT made
 *     here; see boundedPlanRefutation.test.ts §10-§12 for the search-level G4
 *     regressions (those still need the non-portable real-game corpus).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createInitialState, endTurn, type GameEngineState } from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty } from '../../types';
import { evaluateForCat } from '../evaluation';
import {
  isHybridEligibleState, hybridEvaluateForCat, productionValueNet,
  resolveHardLeaf, setHardLeafMode, getHardLeafMode,
  buildProductionFeatures, computeHybridFromParts,
} from '../hybridLeaf';
import { HYBRID_WEIGHTS_FINGERPRINT } from '../hybridWeights';
import { HARD_LEAF_MODE_CONFIG, HARD_LEAF_MODE_DEFAULT } from '../searchConfig';
import { stateKey } from '../transposition';
import { g4Boundaries } from './fixtures/frozenFixtures';
import { G4_AUDIT_GOLDENS, G4_BASELINE_RECORDED } from './fixtures/g4Goldens';

function freshState(difficulty: Difficulty = Difficulty.Hard, overrides: Record<string, unknown> = {}): GameEngineState {
  return createInitialState({ ...DEFAULT_CONFIG, difficulty, ...overrides } as Parameters<typeof createInitialState>[0]);
}

/** The frozen G4 scores. See `./fixtures/g4Goldens.ts` for the provenance of
 *  each class: the audit goldens VERIFY the live model output, they are no
 *  longer operands of a constant-vs-constant comparison. */
const G4_FROZEN = {
  ...G4_AUDIT_GOLDENS,
  baselineGood: G4_BASELINE_RECORDED.good,
  baselineBad: G4_BASELINE_RECORDED.bad,
};

describe('G0.4E-1.1 hybridLeaf hardening', () => {
  beforeEach(() => { setHardLeafMode('baseline'); });

  // ---- §1 single source of truth ----
  it('S1: setHardLeafMode writes the single config source; no second state', () => {
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
    setHardLeafMode('hybrid_standard_only');
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('hybrid_standard_only');
    expect(getHardLeafMode()).toBe('hybrid_standard_only');
    setHardLeafMode('baseline');
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
  });

  it('S1: resolveHardLeaf reads HARD_LEAF_MODE_CONFIG', () => {
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
    expect(resolveHardLeaf()).toBe(evaluateForCat);
    HARD_LEAF_MODE_CONFIG.current = 'hybrid_standard_only';
    expect(resolveHardLeaf()).toBe(hybridEvaluateForCat);
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
  });

  // ---- §8 default OFF ----
  it('S8: default leaf mode is exactly baseline, no setter needed', () => {
    expect(HARD_LEAF_MODE_DEFAULT).toBe('baseline');
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
    expect(resolveHardLeaf()).toBe(evaluateForCat);
  });

  // ---- §2 strict eligibility ----
  it('S2: canonical hard state eligible; non-hard difficulty ineligible', () => {
    expect(isHybridEligibleState(freshState(Difficulty.Hard))).toBe(true);
    expect(isHybridEligibleState(freshState(Difficulty.Easy))).toBe(false);
    expect(isHybridEligibleState(freshState(Difficulty.Medium))).toBe(false);
  });

  it('S2: every config override is rejected (strict canonical domain)', () => {
    const base = freshState(Difficulty.Hard);
    // each override must make it ineligible
    const cases: Record<string, unknown>[] = [
      { boxCount: 11 }, { pileCount: 3 }, { butterCount: 3 },
      { mouseStart: { r: 7, c: 7 } }, { catStart: { r: 1, c: 2 } },
      { mouseBaseMoves: 5 }, { mouseCarryingMoves: 2 }, { mouseSkillExtraMoves: 2 }, { catBaseMoves: 5 },
      { gameMode: 'dual' },
      { tunnelCorners: [] },
      { boxPositions: [{ r: 1, c: 1 }] },
      { pilePositions: [{ r: 1, c: 1 }] },
      { butterPositions: [{ r: 1, c: 1 }] },
      { customTerrain: [[{ type: 'empty' as never, hasButter: false }]] },
      { boardSize: 9 },
      { mouseHole: { r: 0, c: 0, size: 2 } },
    ];
    for (const ov of cases) {
      const st = { ...base, config: { ...base.config, ...ov } } as unknown as GameEngineState;
      expect(isHybridEligibleState(st)).toBe(false);
    }
  });

  it('S2: wall / void anywhere -> ineligible', () => {
    const st = freshState(Difficulty.Hard);
    const w = { ...st, board: st.board.map((row) => row.map((c) => ({ ...c }))) } as GameEngineState;
    w.board[0][0] = { ...w.board[0][0], type: 'wall' as never };
    expect(isHybridEligibleState(w)).toBe(false);
    const v = { ...st, board: st.board.map((row) => row.map((c) => ({ ...c }))) } as GameEngineState;
    v.board[1][1] = { ...v.board[1][1], type: 'void' as never };
    expect(isHybridEligibleState(v)).toBe(false);
  });

  it('S2: NO_TRAP quirk preserved (no-trap -> trap channel at (0,0))', () => {
    const st = freshState(Difficulty.Hard);
    expect(st.trapPosition).toBeNull();
    const feat = buildProductionFeatures(st);
    expect(feat[7 * 100 + 0 * 10 + 0]).toBe(1);
  });

  // ---- §3 golden ValueNet parity (independent, not circular) ----
  it('S3b: productionValueNet matches pinned golden values on a DETERMINISTIC state', () => {
    // Deterministic canonical-hard state (fixed positions, no random map).
    // The golden values were computed by the OFFLINE optimized ValueNet
    // authority on the EXACT same state — independent of productionValueNet.
    const cfg = {
      ...DEFAULT_CONFIG, difficulty: Difficulty.Hard,
      boxPositions: [{ r: 2, c: 2 }, { r: 4, c: 4 }, { r: 6, c: 6 }, { r: 8, c: 2 }],
      pilePositions: [{ r: 1, c: 5 }, { r: 5, c: 8 }],
      butterPositions: [{ r: 3, c: 3 }, { r: 7, c: 7 }],
    } as unknown as Parameters<typeof createInitialState>[0];
    const base = createInitialState(cfg);
    const golden = { normal: 0.5863335630920006, carrying: 0.32636118704001577, trap: 0.29933293051788606 };
    expect(Math.abs(productionValueNet(base) - golden.normal)).toBeLessThan(1e-12);
    const carrying = { ...base, mouseHasButter: true } as GameEngineState;
    expect(Math.abs(productionValueNet(carrying) - golden.carrying)).toBeLessThan(1e-12);
    const trap = { ...base, trapPosition: { r: 2, c: 3 } } as GameEngineState;
    expect(Math.abs(productionValueNet(trap) - golden.trap)).toBeLessThan(1e-12);
    expect(Math.abs(productionValueNet(base) - golden.normal)).toBeLessThan(1e-12); // no-trap == normal
  });

  // ---- §4 exact fingerprint ----
  it('S4: weights fingerprint is the exact frozen value', () => {
    expect(HYBRID_WEIGHTS_FINGERPRINT).toBe('b9f00caec35954329e6987a6b796b473e3fa29f84d951b750f8ed313f32cafba');
  });

  // ---- §5 real fail-closed ----
  it('S5: computeHybridFromParts returns NaN for nonfinite ValueNet; clamps nonfinite eval', () => {
    // nonfinite ValueNet -> NaN (fail-closed signal to the wrapper)
    expect(Number.isNaN(computeHybridFromParts(1, NaN))).toBe(true);
    expect(Number.isNaN(computeHybridFromParts(1, Infinity))).toBe(true);
    expect(Number.isNaN(computeHybridFromParts(1, -Infinity))).toBe(true);
    // nonfinite evaluateForCat is safely clamped by tanh (finite, safe) — not a model fault
    const h = computeHybridFromParts(Infinity, 1);
    expect(Number.isNaN(h)).toBe(false);
    expect(Math.abs(h - 1.0)).toBeLessThan(1e-9);
    // finite path
    expect(computeHybridFromParts(0, 0)).toBeCloseTo(0, 9);
  });

  it('S5: hybridEvaluateForCat on ineligible state returns exact evaluateForCat', () => {
    const st = freshState(Difficulty.Hard);
    const wall = { ...st, board: st.board.map((row) => row.map((c) => ({ ...c }))) } as GameEngineState;
    wall.board[0][0] = { ...wall.board[0][0], type: 'wall' as never };
    expect(hybridEvaluateForCat(wall)).toBe(evaluateForCat(wall));
    // non-hard difficulty -> baseline (same single state)
    const easy = freshState(Difficulty.Easy);
    expect(hybridEvaluateForCat(easy)).toBe(evaluateForCat(easy));
  });

  it('S5: the production wrapper composes exactly evaluateForCat + ValueNet on eligible states and never leaks a nonfinite leaf', () => {
    // Wrapper contract, checked against the LIVE model rather than against a
    // hand-fed NaN: on an eligible state the returned value must be precisely
    // computeHybridFromParts(e, productionValueNet(s)) — the finite branch — and
    // on an ineligible state precisely evaluateForCat(s) — the fallback branch.
    const eligible = freshState(Difficulty.Hard);
    expect(isHybridEligibleState(eligible)).toBe(true);
    const e = evaluateForCat(eligible);
    const v = productionValueNet(eligible);
    expect(hybridEvaluateForCat(eligible)).toBe(computeHybridFromParts(e, v));
    expect(Number.isFinite(hybridEvaluateForCat(eligible))).toBe(true);

    // no leaf the production wrapper can produce may be nonfinite: sweep real
    // search-successor-shaped states (ghost + debt + wall + non-hard included).
    const wall = { ...eligible, board: eligible.board.map((row) => row.map((c) => ({ ...c }))) } as GameEngineState;
    wall.board[0][0] = { ...wall.board[0][0], type: 'wall' as never };
    const corpus: GameEngineState[] = [
      eligible,
      { ...eligible, pendingButterSpawns: [{ r: 2, c: 3, blockedMaterializations: 0 }] } as GameEngineState,
      { ...eligible, pendingButterPlacementDebt: 2 } as GameEngineState,
      wall,
      freshState(Difficulty.Easy),
      endTurn(freshState(Difficulty.Hard)),
    ];
    for (const st of corpus) {
      const out = hybridEvaluateForCat(st);
      expect(Number.isFinite(out)).toBe(true);
      if (!isHybridEligibleState(st)) expect(out).toBe(evaluateForCat(st));
    }
  });

  // ---- §6 REAL G4 regression (P0-1) ----
  it('S6: G4 GOOD > BAD — the LIVE production Hybrid V1 evaluator on the restored frozen states', () => {
    const { good, bad, goodRecord, badRecord } = g4Boundaries();
    // identity: the restored state IS the frozen audit state (loader already
    // verified snapshot digest + stateKey; assert the key we hold matches).
    expect(stateKey(good)).toBe(goodRecord.stateKey);
    expect(stateKey(bad)).toBe(badRecord.stateKey);
    // The pair is NOT single-variable: parsed from the frozen records, the three
    // differences are cat (3,5)->(3,7), trap (2,4)->(2,3) and one box
    // (4,4)->(3,8); mouse (4,7), butter, side-to-move and the counters match.
    // The assertions below pin only the cat coordinate and the key difference.
    expect(`${good.catPosition.r},${good.catPosition.c}`).toBe('3,7');
    expect(`${bad.catPosition.r},${bad.catPosition.c}`).toBe('3,5');
    expect(stateKey(good)).not.toBe(stateKey(bad));

    // domain: this may be called a Hybrid V1 regression only if both states are
    // inside V1's legal enable domain (otherwise the wrapper would silently be
    // reporting the baseline it fell back to).
    expect(isHybridEligibleState(good)).toBe(true);
    expect(isHybridEligibleState(bad)).toBe(true);

    // the actual production call.
    const vGood = hybridEvaluateForCat(good);
    const vBad = hybridEvaluateForCat(bad);

    // golden values now VERIFY the model output (they were the whole test before).
    expect(vGood).toBe(G4_FROZEN.v1Good);
    expect(vBad).toBe(G4_FROZEN.v1Bad);
    expect(productionValueNet(good)).toBe(G4_FROZEN.vNetGood);
    expect(productionValueNet(bad)).toBe(G4_FROZEN.vNetBad);

    // the ranking claim, produced by the model rather than asserted over literals.
    expect(vGood).toBeGreaterThan(vBad);

    // it must be the Hybrid path, not a silent baseline fallback: the baseline
    // heuristic MISRANKS this pair, so a fallback would fail the ordering above.
    expect(evaluateForCat(good)).toBe(G4_FROZEN.baselineGood);
    expect(evaluateForCat(bad)).toBe(G4_FROZEN.baselineBad);
    expect(evaluateForCat(good)).toBeLessThan(evaluateForCat(bad));
    expect(vGood).not.toBe(evaluateForCat(good));
    expect(vBad).not.toBe(evaluateForCat(bad));
  });

  // ---- §8 default ----
  it('S8: HARD_LEAF_MODE_CONFIG initial value is exactly baseline', () => {
    expect(HARD_LEAF_MODE_CONFIG.current).toBe('baseline');
  });
});
