/**
 * PPC-A0-DEV-01 — Frozen G0.4F-2B-1.9AX A0 expected-return model as a DEV-only
 * Hard leaf (browser-safe, pure, fail-closed).
 *
 * CONTRACT (G0.4F-2B-1.9BA §5/§6 `MODEL_BOUNDARY_ELIGIBLE_HYBRID_LEAF`, frozen):
 *   phase === Playing AND currentPlayer === Mouse  ->  frozen A0 score
 *   every other leaf                              ->  production evaluateForCat
 * Terminal states are decided by the search kernel and never reach an evaluator,
 * so A0 never replaces a mate score. The A0 target was trained on states where
 * the Cat turn has finished and the Mouse holds the move, which is exactly why
 * Cat-to-move leaves keep the BASE evaluator; GLOBAL_MODEL_LEAF was NOT used.
 *
 * SCORE TRANSFORM (1.9BA §7, affine, no logit / temperature / calibration):
 *   MODEL_SEARCH_SCORE = (2 * pCatWin - 1) * HEURISTIC_LIMIT
 *
 * MODEL MATH: none of it is re-implemented, re-fitted or altered. The 46 inputs,
 * the TRAIN scaler, the weights, the bias and the sigmoid are the frozen bundle
 * in ./a0FrozenModel; the read order and the scaler pre-fold are the 1.9BC
 * `predictFrozenA0Fast` adapter, certified against the 1.9BB/BA reference
 * (feature parity 220754/220754 dims, max prediction error 9.992e-16 over 4799
 * states, search parity D1 24/24 / D2 24/24 / D3 8/8, purity PASS).
 *
 * DEV-SAFETY GATE ADDED ON TOP OF THE FROZEN CONTRACT (see isA0FrozenDomainState):
 * A0 is only consulted inside the canonical Hard standard-map domain the frozen
 * corpus was generated on. Inside that domain the leaf is byte-for-byte the
 * certified arm; outside it the leaf falls back to evaluateForCat. This can
 * only ever REDUCE model usage, never invent a third evaluator.
 *
 * DISCLOSED LIMITATION (measured, not assumed — and the frozen round, not this
 * file, owns the decision): across the 1728 TRAIN boundary states of
 * ax_state_dataset.json (sha256 863c48841cd5c522…) 23 of the 46 input columns
 * never moved, among them mouseHasButter, mouseSkillActive, blockedTunnelCount,
 * reachableOpenTunnelCount, catMovesLeft, mouseMovesLeft and the
 * mouseGoalDistance value/null pair. A coefficient on a column that never moved
 * is unidentified — while x is constant, w·x is indistinguishable from the bias
 * — so a live state that moves one of those columns is scored by untrained
 * extrapolation (per-column constants + weights:
 * scratch/ppc-a0-dev-01/a0_train_support_evidence.txt). Gating on that would
 * narrow 1.9BA §5/§6, which defines the eligibility domain as the actor boundary
 * and kept it that way deliberately ("未为提高 model usage 取消该 gate"), so the
 * runtime gate here is the frozen one plus map identity, and the support
 * question is handed to review instead of being decided inside the adapter.
 *
 * Purity: no Math.random, no clock, no fs/network, no cache across states, no
 * write into the state. The only cross-call memory is the 46-slot working
 * buffer below, fully overwritten on every call (production search is
 * synchronous and single-threaded — same pattern as hybridLeaf.ts).
 */
import { evaluateForCat, evaluateForCatDetailed, HEURISTIC_LIMIT } from './evaluation';
import type { EvaluationBreakdown } from './evaluation';
import { DEFAULT_CONFIG } from '../config';
import { CellType, Difficulty, GamePhase, PieceType } from '../types';
import type { GameEngineState } from '../engine';
import { A0_BIAS_SCALED, A0_INPUT_DIM, A0_W_SCALED } from './a0FrozenModel';

export { A0_MODEL_SHA256, A0_INPUT_DIM, A0_PARAMETER_COUNT } from './a0FrozenModel';

/** The frozen affine transform factor, kept next to the code that applies it. */
export const A0_SCORE_TRANSFORM = '(2 * pCatWin - 1) * HEURISTIC_LIMIT';

const SCRATCH = new Float64Array(A0_INPUT_DIM);

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * The frozen 46-dim input vector, read in FEATURE_SPECS order. Statement-for-
 * statement the 1.9BC `fastFeatureVector` (ai-training/f2b19bc/bc_fast.ts):
 * 30 evaluation features from the SAME evaluateForCatDetailed() the baseline
 * uses, 5 exact state scalars, and BASE_EVAL_TOTAL.
 */
export function a0FeatureVector(
  state: GameEngineState,
  det: EvaluationBreakdown,
  out: Float64Array,
): Float64Array {
  const f = det.features;
  let v: number | null;
  v = f.catMouseDistance ?? null; out[0] = v === null ? 0 : v; out[1] = v === null ? 1 : 0;
  v = f.mouseGoalDistance ?? null; out[2] = v === null ? 0 : v; out[3] = v === null ? 1 : 0;
  v = f.mouseButterDistance ?? null; out[4] = v === null ? 0 : v; out[5] = v === null ? 1 : 0;
  v = f.mouseWinRouteDistance ?? null; out[6] = v === null ? 0 : v; out[7] = v === null ? 1 : 0;
  out[8] = f.mouseMobility ?? 0;
  out[9] = f.catMobility ?? 0;
  out[10] = f.mouseReachableArea ?? 0;
  out[11] = f.catReachableArea ?? 0;
  out[12] = f.openTunnelCount ?? 0;
  out[13] = f.blockedTunnelCount ?? 0;
  out[14] = (f.mouseTunnelAllowed ?? false) ? 1 : 0;
  v = f.mouseTunnelAccessDistance ?? null; out[15] = v === null ? 0 : v; out[16] = v === null ? 1 : 0;
  out[17] = f.reachableOpenTunnelCount ?? 0;
  out[18] = (f.mouseCanReachTunnel ?? false) ? 1 : 0;
  out[19] = (f.mouseHasButter ?? false) ? 1 : 0;
  out[20] = (f.mouseSkillActive ?? false) ? 1 : 0;
  out[21] = (f.catHasTrapAvailable ?? true) ? 1 : 0;
  out[22] = (f.trapActive ?? false) ? 1 : 0;
  v = f.mouseTrapDistance ?? null; out[23] = v === null ? 0 : v; out[24] = v === null ? 1 : 0;
  const isCat = (f.currentPlayer ?? 'mouse') === 'cat';
  out[25] = isCat ? 1 : 0;
  out[26] = isCat ? 0 : 1;
  out[27] = f.catMovesLeft ?? 0;
  out[28] = f.mouseMovesLeft ?? 0;
  out[29] = f.holeGateCount ?? 0;
  v = f.catHoleGateDistance ?? null; out[30] = v === null ? 0 : v; out[31] = v === null ? 1 : 0;
  v = f.mouseHoleGateDistance ?? null; out[32] = v === null ? 0 : v; out[33] = v === null ? 1 : 0;
  v = f.holeControlMargin ?? null; out[34] = v === null ? 0 : v; out[35] = v === null ? 1 : 0;
  out[36] = f.catControlledArea ?? 0;
  out[37] = f.mouseControlledArea ?? 0;
  out[38] = f.contestedArea ?? 0;
  out[39] = f.voronoiBalance ?? 0;
  const bsRaw = state.config.boardSize;
  out[40] = Number.isFinite(bsRaw) && bsRaw > 0 ? bsRaw : 10;
  out[41] = state.butterPositions?.length ?? 0;
  out[42] = state.pendingButterSpawns?.length ?? 0;
  const debt = state.pendingButterPlacementDebt ?? 0;
  out[43] = Number.isFinite(debt) && debt >= 0 ? debt : 0;
  const traps = state.catTrapsRemaining;
  out[44] = Number.isFinite(traps) && traps >= 0 ? traps : 0;
  out[45] = det.total;
  return out;
}

/** Frozen linear head + sigmoid on an already-encoded 46-dim vector. */
export function a0PredictCatWinFromVector(x: Float64Array): number {
  let z = A0_BIAS_SCALED;
  for (let i = 0; i < A0_INPUT_DIM; i++) z += A0_W_SCALED[i] * x[i];
  return sigmoid(z);
}

/** pCatWin under the frozen policy-conditioned target, for one live state. */
export function a0PredictCatWin(state: GameEngineState): number {
  const det = evaluateForCatDetailed(state);
  a0FeatureVector(state, det, SCRATCH);
  return a0PredictCatWinFromVector(SCRATCH);
}

// ---------------------------------------------------------------------------
// ELIGIBILITY
// ---------------------------------------------------------------------------
/** The frozen contract itself (1.9BA §5/§6): mouse-to-move, still playing. */
export function isA0BoundaryState(state: GameEngineState): boolean {
  return state.phase === GamePhase.Playing && state.currentPlayer === PieceType.Mouse;
}

/**
 * Fail-closed domain guard (DEV safety, stricter than the frozen contract and
 * never looser). Every clause is a property of the canonical Hard generator the
 * 1.9AX corpus was sampled from:
 *   - boardSize 10 / butterCount 2 layouts, canonical move budgets and mouse
 *     hole, 'single' mode, Difficulty.Hard only;
 *   - no editor terrain, no custom tunnel layout, no fixed piece lists;
 *   - no wall / void cell anywhere on the board (same fail-closed rule the
 *     hybrid V1/V2 guard applies — canonical generator boards never contain
 *     one, so this only refuses hand-mutated or future terrain maps);
 *   - the corpus contains no pending ghost butter and no placement debt.
 * boardSize / butter count / ghost / debt also appear as input columns 40..43,
 * which were constant across TRAIN. The config clauses are O(1); the board
 * clause is one pass over 100 cells and runs only on mouse-to-move leaves,
 * which already pay the full detailed evaluation.
 */
export function isA0FrozenDomainState(state: GameEngineState): boolean {
  const cfg = state.config;
  if (cfg.boardSize !== DEFAULT_CONFIG.boardSize) return false;
  if (cfg.boxCount !== DEFAULT_CONFIG.boxCount) return false;
  if (cfg.pileCount !== DEFAULT_CONFIG.pileCount) return false;
  if (cfg.butterCount !== DEFAULT_CONFIG.butterCount) return false;
  if (cfg.mouseBaseMoves !== DEFAULT_CONFIG.mouseBaseMoves) return false;
  if (cfg.mouseCarryingMoves !== DEFAULT_CONFIG.mouseCarryingMoves) return false;
  if (cfg.mouseSkillExtraMoves !== DEFAULT_CONFIG.mouseSkillExtraMoves) return false;
  if (cfg.catBaseMoves !== DEFAULT_CONFIG.catBaseMoves) return false;
  if (cfg.gameMode !== DEFAULT_CONFIG.gameMode) return false;
  if (cfg.difficulty !== Difficulty.Hard) return false;
  if (cfg.mouseHole.r !== DEFAULT_CONFIG.mouseHole.r || cfg.mouseHole.c !== DEFAULT_CONFIG.mouseHole.c
    || cfg.mouseHole.size !== DEFAULT_CONFIG.mouseHole.size) return false;
  if (cfg.mouseStart.r !== DEFAULT_CONFIG.mouseStart.r || cfg.mouseStart.c !== DEFAULT_CONFIG.mouseStart.c) return false;
  if (cfg.catStart.r !== DEFAULT_CONFIG.catStart.r || cfg.catStart.c !== DEFAULT_CONFIG.catStart.c) return false;
  if (cfg.customTerrain !== undefined) return false;
  if (cfg.tunnelCorners !== undefined) return false;
  if (cfg.boxPositions !== undefined) return false;
  if (cfg.pilePositions !== undefined) return false;
  if (cfg.butterPositions !== undefined) return false;
  if ((state.pendingButterSpawns?.length ?? 0) > 0) return false;
  if ((state.pendingButterPlacementDebt ?? 0) > 0) return false;
  for (let r = 0; r < state.board.length; r++) {
    const row = state.board[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c].type === CellType.Wall || row[c].type === CellType.Void) return false;
    }
  }
  return true;
}

/** Leaf-level eligibility = frozen boundary contract AND frozen domain. */
export function isA0EligibleLeafState(state: GameEngineState): boolean {
  return isA0BoundaryState(state) && isA0FrozenDomainState(state);
}

/**
 * The resolved A0 leaf. Ineligible leaves — cat-to-move, terminal, tunnel-exit
 * prompt, non-canonical map, ghost / debt state — keep production evaluateForCat.
 * Any model fault also falls back (fail-closed, like hybridEvaluateForCat).
 */
export function a0ExpectedReturnEvaluateForCat(state: GameEngineState): number {
  if (!isA0EligibleLeafState(state)) return evaluateForCat(state);
  try {
    const p = a0PredictCatWin(state);
    if (!Number.isFinite(p)) return evaluateForCat(state);
    return (2 * p - 1) * HEURISTIC_LIMIT;
  } catch {
    return evaluateForCat(state);
  }
}
