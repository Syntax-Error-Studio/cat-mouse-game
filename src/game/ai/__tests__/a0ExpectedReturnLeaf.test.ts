/// <reference types="node" />
/**
 * PPC-A0-DEV-01 §4 — targeted unit tests for the NEW DEV-only frozen A0 leaf.
 *
 * Scope: the two new modules (a0FrozenModel / a0ExpectedReturnLeaf) and the one
 * resolver branch that wires them. This is not a regression suite and not a
 * strength test — nothing here measures a full game, and no result in this file
 * may be read as "A0 is stronger".
 *
 * The authority numbers below were produced offline by
 * scratch/ppc-a0-dev-01/a0-authority-probe.ts, which bundles the FROZEN 1.9BC
 * reference adapter (ai-training/f2b19bc/bc_fast.ts `predictFrozenA0` — the
 * byte-faithful copy of the 1.9BB/1.9BA implementation certified in
 * G0.4F-2B-1.9BC sections 12/13) and runs it over the committed frozen fixture
 * states. `ai-training/` is gitignored, so nothing in this test reads it: the
 * pinned rows are the only bridge to the frozen authority, and the digests in
 * §1 are what makes that bridge checkable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createInitialState, type GameEngineState } from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { CellType, Difficulty, GamePhase, PieceType } from '../../types';
import { evaluateForCat, evaluateForCatDetailed, HEURISTIC_LIMIT, type EvaluationBreakdown } from '../evaluation';
import { stateKey } from '../transposition';
import { resolveHardLeaf } from '../hybridLeaf';
import { HARD_LEAF_MODE_CONFIG, HARD_LEAF_MODE_DEFAULT } from '../searchConfig';
import {
  A0_ARCHITECTURE, A0_BIAS, A0_BIAS_SCALED, A0_DIM_ROLES, A0_ENCODER_SHA256, A0_FEATURE_COLUMNS,
  A0_FEATURE_SCHEMA_SHA256, A0_INPUT_DIM, A0_MEAN, A0_MODEL_SHA256, A0_PARAMETER_COUNT, A0_SCALER_SHA256,
  A0_STD, A0_W, A0_W_SCALED, A0_WEIGHTS_JSON_FROZEN, A0_SCALER_JSON_FROZEN,
} from '../a0FrozenModel';
import {
  a0ExpectedReturnEvaluateForCat, a0FeatureVector, a0PredictCatWin, a0PredictCatWinFromVector,
  isA0BoundaryState, isA0EligibleLeafState, isA0FrozenDomainState,
} from '../a0ExpectedReturnLeaf';
import { fixtureRecordIndex, restoreFrozenState } from './fixtures/frozenFixtures';

/** 1.9BC §12 prediction gate and the §15 value tolerance derived from it. */
const PREDICTION_TOL = 1e-10;
const SCORE_TOL = 2 * PREDICTION_TOL * HEURISTIC_LIMIT;

interface AuthorityRow {
  boundary: boolean;
  eligible: boolean;
  /** sha256 over the 46 Float64 input slots, first 16 hex chars. */
  vecSha16: string;
  /** REFERENCE pCatWin (frozen bc_fast.predictFrozenA0) on that state. */
  pCatWinRef: number;
  /** (2 * pCatWinRef - 1) * HEURISTIC_LIMIT. */
  scoreRef: number;
}

const A0_AUTHORITY: Readonly<Record<string, AuthorityRow>> = {
  G4_BAD_boundary: { boundary: true, eligible: true, vecSha16: 'fcba9a9961c08a01', pCatWinRef: 0.06737433360926963, scoreRef: -8652.513327814608 },
  G4_GOOD_boundary: { boundary: true, eligible: true, vecSha16: '0c9ad624d1419ac0', pCatWinRef: 0.23768890349064883, scoreRef: -5246.221930187023 },
  G16T8: { boundary: false, eligible: false, vecSha16: '862e6b2a5ec5a922', pCatWinRef: 0.20025342027433354, scoreRef: -5994.9315945133285 },
  G17T2: { boundary: false, eligible: false, vecSha16: '19fd252c50d5f89c', pCatWinRef: 0.17068284792084465, scoreRef: -6586.343041583107 },
  G19T7: { boundary: false, eligible: false, vecSha16: '60d53eac3620de8c', pCatWinRef: 0.26467688413693613, scoreRef: -4706.462317261277 },
  G24T1: { boundary: false, eligible: false, vecSha16: '00d1c6c7609b03bd', pCatWinRef: 0.2855691967381579, scoreRef: -4288.616065236843 },
  game5_T4: { boundary: false, eligible: false, vecSha16: '897537a1b6cbd725', pCatWinRef: 0.5047596746491396, scoreRef: 95.19349298279245 },
  game5_T5: { boundary: false, eligible: false, vecSha16: '37f9efb473b08a7a', pCatWinRef: 0.3215723430723076, scoreRef: -3568.5531385538484 },
  game5_T14: { boundary: false, eligible: false, vecSha16: '4ecaa8f9b7f19c18', pCatWinRef: 0.010176614007104456, scoreRef: -9796.46771985791 },
  game5_T15: { boundary: false, eligible: false, vecSha16: '89c62ac3fe6e7e85', pCatWinRef: 0.018942467574068776, scoreRef: -9621.150648518626 },
};

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const vecDigest = (x: Float64Array): string =>
  createHash('sha256').update(Buffer.from(x.buffer, x.byteOffset, x.byteLength)).digest('hex').slice(0, 16);

function hardState(overrides: Record<string, unknown> = {}): GameEngineState {
  return createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard, ...overrides } as Parameters<typeof createInitialState>[0]);
}

/** The same 46 slots, rebuilt straight from the frozen schema contract. */
function vectorFromBreakdown(state: GameEngineState, det: EvaluationBreakdown): number[] {
  const f = det.features;
  const nn = (v: number | null | undefined): [number, number] => (v === null || v === undefined ? [0, 1] : [v, 0]);
  const bool = (v: boolean | undefined, whenMissing: boolean): number => ((v === undefined ? whenMissing : v) ? 1 : 0);
  const out: number[] = [];
  out.push(...nn(f.catMouseDistance), ...nn(f.mouseGoalDistance), ...nn(f.mouseButterDistance), ...nn(f.mouseWinRouteDistance));
  out.push(f.mouseMobility ?? 0, f.catMobility ?? 0, f.mouseReachableArea ?? 0, f.catReachableArea ?? 0);
  out.push(f.openTunnelCount ?? 0, f.blockedTunnelCount ?? 0, bool(f.mouseTunnelAllowed, false));
  out.push(...nn(f.mouseTunnelAccessDistance), f.reachableOpenTunnelCount ?? 0);
  out.push(bool(f.mouseCanReachTunnel, false), bool(f.mouseHasButter, false), bool(f.mouseSkillActive, false));
  out.push(bool(f.catHasTrapAvailable, true), bool(f.trapActive, false));
  out.push(...nn(f.mouseTrapDistance));
  const isCat = (f.currentPlayer ?? 'mouse') === 'cat';
  out.push(isCat ? 1 : 0, isCat ? 0 : 1, f.catMovesLeft ?? 0, f.mouseMovesLeft ?? 0, f.holeGateCount ?? 0);
  out.push(...nn(f.catHoleGateDistance), ...nn(f.mouseHoleGateDistance), ...nn(f.holeControlMargin));
  out.push(f.catControlledArea ?? 0, f.mouseControlledArea ?? 0, f.contestedArea ?? 0, f.voronoiBalance ?? 0);
  out.push(state.config.boardSize, state.butterPositions.length, state.pendingButterSpawns.length,
    state.pendingButterPlacementDebt, state.catTrapsRemaining, det.total);
  return out;
}

const frozenStates = (): Array<{ id: string; state: GameEngineState }> =>
  fixtureRecordIndex().map(({ record }) => ({ id: record.id, state: restoreFrozenState(record) }));

afterEach(() => {
  HARD_LEAF_MODE_CONFIG.current = HARD_LEAF_MODE_DEFAULT;
});

describe('PPC-A0-DEV-01 §1 — vendored frozen bundle integrity', () => {
  it('A1: the embedded weights / scaler texts re-hash to the pinned frozen digests', () => {
    expect(sha256(A0_WEIGHTS_JSON_FROZEN)).toBe('f840b70121543692c3b42a1a4d3571906010a49159472f1b96551a14ddd7f663');
    expect(sha256(A0_WEIGHTS_JSON_FROZEN)).toBe(A0_MODEL_SHA256);
    expect(sha256(A0_SCALER_JSON_FROZEN)).toBe('9aa766ce442234897392ef3a3feb90f0b0686de1e0e7b5f91045fabacf411eb6');
    expect(sha256(A0_SCALER_JSON_FROZEN)).toBe(A0_SCALER_SHA256);
    expect(A0_FEATURE_SCHEMA_SHA256).toBe('b7a9c27d4095214a5fb808e8340ec630c5627bb91f8bfd53c19b807b0fce5b58');
    expect(A0_ENCODER_SHA256).toBe('7b4cb9e5c1c4dbcb71035e2770cdd3d577a728b79bf914c0f307e74a6a29ea92');
  });

  it('A2: the architecture pins are the frozen A0_LINEAR 46-input / 47-parameter bundle', () => {
    expect(A0_ARCHITECTURE).toBe('A0_LINEAR');
    expect(A0_INPUT_DIM).toBe(46);
    expect(A0_PARAMETER_COUNT).toBe(47);
    expect(A0_W).toHaveLength(A0_INPUT_DIM);
    expect(A0_MEAN).toHaveLength(A0_INPUT_DIM);
    expect(A0_STD).toHaveLength(A0_INPUT_DIM);
    expect(A0_DIM_ROLES).toHaveLength(A0_INPUT_DIM);
    expect(A0_FEATURE_COLUMNS).toHaveLength(A0_INPUT_DIM);
    expect(A0_FEATURE_COLUMNS[2]).toBe('mouseGoalDistance_VALUE');
    expect(A0_FEATURE_COLUMNS[45]).toBe('BASE_EVAL_TOTAL');
  });

  it('A3: the shipped pre-fold is the frozen predicate applied to the frozen numbers', () => {
    const scaler = JSON.parse(A0_SCALER_JSON_FROZEN) as { constantColumns: number[] };
    const valueDimsWithZeroStd = A0_STD
      .map((std, i) => (A0_DIM_ROLES[i] === 'VALUE' && std === 0 ? i : -1))
      .filter((i) => i >= 0);
    expect(valueDimsWithZeroStd).toEqual(scaler.constantColumns);
    for (const i of valueDimsWithZeroStd) expect(Number.isInteger(A0_MEAN[i])).toBe(true);

    let bias = A0_BIAS;
    for (let i = 0; i < A0_INPUT_DIM; i++) {
      const fold = A0_DIM_ROLES[i] === 'VALUE' && A0_STD[i] > 1e-12;
      expect(Object.is(A0_W_SCALED[i], fold ? A0_W[i] / A0_STD[i] : A0_W[i])).toBe(true);
      if (fold) bias -= (A0_W[i] * A0_MEAN[i]) / A0_STD[i];
    }
    expect(Object.is(A0_BIAS_SCALED, bias)).toBe(true);
  });
});

describe('§4(3) — inference parity against the frozen A0 authority', () => {
  it('P1: every committed frozen state re-derives the pinned 46-dim vector and pCatWin', () => {
    const states = frozenStates();
    expect(states.length).toBe(10);
    let modelSide = 0;
    let baseSide = 0;
    for (const { id, state } of states) {
      const pin = A0_AUTHORITY[id];
      expect(pin, `no authority row pinned for ${id}`).toBeTruthy();
      const x = a0FeatureVector(state, evaluateForCatDetailed(state), new Float64Array(A0_INPUT_DIM));
      expect(vecDigest(x)).toBe(pin.vecSha16);
      expect(Object.is(a0PredictCatWinFromVector(x), a0PredictCatWin(state))).toBe(true);
      expect(Math.abs(a0PredictCatWin(state) - pin.pCatWinRef)).toBeLessThanOrEqual(PREDICTION_TOL);
      const leaf = a0ExpectedReturnEvaluateForCat(state);
      expect(isA0BoundaryState(state)).toBe(pin.boundary);
      expect(isA0EligibleLeafState(state)).toBe(pin.eligible);
      if (pin.eligible) {
        modelSide++;
        expect(Math.abs(leaf - pin.scoreRef)).toBeLessThanOrEqual(SCORE_TOL);
      } else {
        baseSide++;
        expect(Object.is(leaf, evaluateForCat(state))).toBe(true);
      }
    }
    expect(modelSide).toBeGreaterThan(0);
    expect(baseSide).toBeGreaterThan(0);
  });

  it('P2: the model value is far from the baseline value on the eligible pair (no coincidence)', () => {
    for (const { state } of frozenStates().filter((s) => A0_AUTHORITY[s.id].eligible)) {
      const leaf = a0ExpectedReturnEvaluateForCat(state);
      expect(Math.abs(leaf - evaluateForCat(state))).toBeGreaterThan(100);
      expect(Math.abs(leaf)).toBeLessThanOrEqual(HEURISTIC_LIMIT);
    }
  });
});

describe('§4(2) — boundary contract and fail-closed fallback', () => {
  it('B1: a canonical hard mouse-to-move leaf is the model side; a cat-to-move leaf is not', () => {
    const mouse = hardState();
    const cat = { ...mouse, currentPlayer: PieceType.Cat } as GameEngineState;
    expect(isA0EligibleLeafState(mouse)).toBe(true);
    expect(isA0BoundaryState(cat)).toBe(false);
    expect(isA0EligibleLeafState(cat)).toBe(false);
    expect(Object.is(a0ExpectedReturnEvaluateForCat(cat), evaluateForCat(cat))).toBe(true);
    expect(a0ExpectedReturnEvaluateForCat(mouse)).not.toBe(evaluateForCat(mouse));
  });

  it('B2: terminal phases and the tunnel-exit prompt never reach the model', () => {
    const base = hardState();
    for (const phase of [GamePhase.CatWins, GamePhase.MouseWins, GamePhase.ChoosingTunnelExit]) {
      const st = { ...base, phase } as GameEngineState;
      expect(isA0BoundaryState(st)).toBe(false);
      expect(Object.is(a0ExpectedReturnEvaluateForCat(st), evaluateForCat(st))).toBe(true);
    }
  });

  it('B3: every non-canonical config override fails closed to evaluateForCat', () => {
    const base = hardState();
    const cases: Record<string, unknown>[] = [
      { difficulty: Difficulty.Easy }, { difficulty: Difficulty.Medium },
      { boardSize: 9 }, { boxCount: 11 }, { pileCount: 3 }, { butterCount: 3 },
      { mouseStart: { r: 7, c: 7 } }, { catStart: { r: 1, c: 2 } },
      { mouseBaseMoves: 5 }, { mouseCarryingMoves: 2 }, { mouseSkillExtraMoves: 2 }, { catBaseMoves: 5 },
      { gameMode: 'dual' }, { tunnelCorners: [] },
      { boxPositions: [{ r: 1, c: 1 }] }, { pilePositions: [{ r: 1, c: 1 }] },
      { butterPositions: [{ r: 1, c: 1 }] }, { customTerrain: [] },
      { mouseHole: { r: 0, c: 0, size: 2 } },
    ];
    for (const ov of cases) {
      const st = { ...base, config: { ...base.config, ...ov } } as unknown as GameEngineState;
      expect(isA0FrozenDomainState(st), `override ${JSON.stringify(Object.keys(ov))} must be rejected`).toBe(false);
      expect(isA0EligibleLeafState(st)).toBe(false);
      expect(Object.is(a0ExpectedReturnEvaluateForCat(st), evaluateForCat(st))).toBe(true);
    }
  });

  it('B4: wall / void cells, ghost butter and placement debt fail closed', () => {
    const cloneBoard = (s: GameEngineState) => s.board.map((row) => row.map((c) => ({ ...c })));
    const walled = { ...hardState(), board: cloneBoard(hardState()) } as GameEngineState;
    walled.board[0][0] = { ...walled.board[0][0], type: CellType.Wall };
    const voided = { ...hardState(), board: cloneBoard(hardState()) } as GameEngineState;
    voided.board[3][4] = { ...voided.board[3][4], type: CellType.Void };
    const ghost = { ...hardState(), pendingButterSpawns: [{ r: 2, c: 3, blockedMaterializations: 0 }] } as GameEngineState;
    const debt = { ...hardState(), pendingButterPlacementDebt: 1 } as GameEngineState;
    for (const st of [walled, voided, ghost, debt]) {
      expect(isA0EligibleLeafState(st)).toBe(false);
      expect(Object.is(a0ExpectedReturnEvaluateForCat(st), evaluateForCat(st))).toBe(true);
    }
    // and the untouched canonical state beside them is still the model side
    expect(isA0EligibleLeafState(hardState())).toBe(true);
  });
});

describe('§4(4) — leaf purity', () => {
  it('U1: inference does not mutate the state', () => {
    for (const { state } of frozenStates().slice(0, 4)) {
      const before = JSON.stringify(state);
      const keyBefore = stateKey(state);
      a0ExpectedReturnEvaluateForCat(state);
      a0PredictCatWin(state);
      expect(JSON.stringify(state)).toBe(before);
      expect(stateKey(state)).toBe(keyBefore);
    }
  });

  it('U2: no Math.random, no Date.now, no performance.now on the model path', () => {
    const st = hardState();
    const realRandom = Math.random;
    const realDateNow = Date.now;
    const realPerfNow = performance.now.bind(performance);
    let randomCalls = 0;
    let dateCalls = 0;
    let perfCalls = 0;
    Math.random = () => { randomCalls++; return realRandom(); };
    Date.now = () => { dateCalls++; return realDateNow(); };
    performance.now = () => { perfCalls++; return realPerfNow(); };
    let leaf = NaN;
    try {
      leaf = a0ExpectedReturnEvaluateForCat(st);
      a0ExpectedReturnEvaluateForCat({ ...st, currentPlayer: PieceType.Cat } as GameEngineState);
    } finally {
      Math.random = realRandom;
      Date.now = realDateNow;
      performance.now = realPerfNow;
    }
    expect(Number.isFinite(leaf)).toBe(true);
    expect(randomCalls).toBe(0);
    expect(dateCalls).toBe(0);
    expect(perfCalls).toBe(0);
  });

  it('U3: repeated inference on one state is bitwise identical', () => {
    const { state } = frozenStates().find((s) => s.id === 'G4_GOOD_boundary')!;
    const first = a0ExpectedReturnEvaluateForCat(state);
    for (let i = 0; i < 5; i++) expect(Object.is(a0ExpectedReturnEvaluateForCat(state), first)).toBe(true);
  });

  it('U4: the 46 inputs are exactly evaluateForCatDetailed + 5 state scalars', () => {
    const candidates = [hardState(), ...frozenStates().map((s) => s.state)];
    for (const state of candidates) {
      const det = evaluateForCatDetailed(state);
      const x = a0FeatureVector(state, det, new Float64Array(A0_INPUT_DIM));
      const expected = vectorFromBreakdown(state, det);
      expect(expected).toHaveLength(A0_INPUT_DIM);
      for (let i = 0; i < A0_INPUT_DIM; i++) expect(Object.is(x[i], expected[i])).toBe(true);
      expect(x[45]).toBe(det.total);
    }
  });

  it('U5: log, message and debug-history fields cannot change the leaf value', () => {
    const base = hardState();
    const withNoise = {
      ...base,
      message: '完全不同的文案',
      catActionLog: ['catStep →', 'catPlaceTrap'],
      gameEventLog: ['turn 99 — 未发生过的事'],
      lastHardSearch: null,
      hardSearchHistory: [],
    } as GameEngineState;
    expect(Object.is(a0ExpectedReturnEvaluateForCat(withNoise), a0ExpectedReturnEvaluateForCat(base))).toBe(true);
  });
});

describe('§4(1)(6) — default OFF and baseline untouched', () => {
  it('D1: the shipped default mode is baseline and its leaf is evaluateForCat', () => {
    expect(HARD_LEAF_MODE_DEFAULT).toBe('baseline');
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
    expect(resolveHardLeaf()).toBe(evaluateForCat);
  });

  it('D2: the A0 mode resolves to the new leaf; every pre-existing mode is unchanged', () => {
    HARD_LEAF_MODE_CONFIG.current = 'a0_expected_return_boundary_only';
    expect(resolveHardLeaf()).toBe(a0ExpectedReturnEvaluateForCat);
    for (const mode of ['baseline', 'baseline_hole_corrected', 'hybrid_standard_only', 'hybrid_route_v2_standard_only'] as const) {
      HARD_LEAF_MODE_CONFIG.current = mode;
      const leaf = resolveHardLeaf();
      expect(typeof leaf).toBe('function');
      if (mode === 'baseline') expect(leaf).toBe(evaluateForCat);
    }
  });

  it('D3: switching to A0 and back reproduces the baseline leaf bitwise on every frozen state', () => {
    const states = frozenStates().map((s) => s.state);
    const eligible = states.find((s) => isA0EligibleLeafState(s));
    expect(eligible).toBeTruthy();
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
    const before = states.map((s) => resolveHardLeaf()(s));
    HARD_LEAF_MODE_CONFIG.current = 'a0_expected_return_boundary_only';
    expect(Object.is(resolveHardLeaf()(eligible!), before[states.indexOf(eligible!)])).toBe(false);
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
    const after = states.map((s) => resolveHardLeaf()(s));
    for (let i = 0; i < after.length; i++) expect(Object.is(after[i], before[i])).toBe(true);
  });
});
