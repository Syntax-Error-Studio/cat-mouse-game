/**
 * G0.4E-1 — Feature-flagged Hybrid leaf (production, browser-safe, fail-closed).
 *
 * Math (FROZEN — D0.3b/D0.3c validated):
 *   HYBRID(state) = 0.5 * tanh(evaluateForCat(state) / S) + 0.5 * ValueNet(state)
 *   S = 1016.1052856445312
 *
 * Behavior:
 *   - Default HardLeafMode = 'baseline' (byte-identical to current production).
 *   - 'hybrid_standard_only' enables the hybrid ONLY on states provably inside the
 *     canonical standard-map domain; every actual leaf state is re-checked (not
 *     just the root). Anything unknown/custom/unsupported -> baseline evaluateForCat.
 *   - Any model fault / nonfinite -> baseline. Kill switch = flip flag back to baseline.
 *
 * This module touches NO rules, NO Hard search math, NO evaluateForCat semantics.
 * Browser-safe: weights from the generated readonly module; no fs/fetch/async.
 */
import { evaluateForCat } from './evaluation';
import { evaluateCorrectedHoleForCat } from './correctedHoleLeaf';
import {
  HYBRID_W1f, HYBRID_W2f, HYBRID_W3f, HYBRID_b1, HYBRID_b2, HYBRID_b3, HYBRID_S,
} from './hybridWeights';
import { DEFAULT_CONFIG } from '../config';
import { GamePhase, Difficulty } from '../types';
import type { GameEngineState } from '../engine';
import { HARD_LEAF_MODE_CONFIG, type HardLeafModeConfig } from './searchConfig';
// G0.4F-1.3: V2 leaf (call-time only — safe module cycle, see resolveHardLeaf).
import { hybridRouteV2EvaluateForCat } from './hybridRouteLeaf';

export const HYBRID_MATH_FROZEN = {
  S: HYBRID_S,
  catWeight: 0.5,
  valueNetWeight: 0.5,
};

export type HardLeafMode = HardLeafModeConfig;

/**
 * SINGLE SOURCE OF TRUTH (G0.4E-1.1 §1): the runtime flag is
 * HARD_LEAF_MODE_CONFIG.current in searchConfig.ts. hybridLeaf.ts does NOT
 * maintain its own state. setHardLeafMode is kept only as a thin setter over
 * the same config object (used by tests / explicit enable).
 */
export function setHardLeafMode(m: HardLeafMode): void { HARD_LEAF_MODE_CONFIG.current = m; }
/** Read the current mode from the single source. */
export function getHardLeafMode(): HardLeafMode { return HARD_LEAF_MODE_CONFIG.current; }

// ---------------------------------------------------------------------------
// Reusable scratch (module-global). PRODUCTION search is synchronous,
// single-threaded (no workers / no nested evaluator), so this is safe.
// ---------------------------------------------------------------------------
const N1 = 128, N2 = 64, DIN = 808;
const feat = new Float32Array(DIN);
const nz = new Int32Array(DIN);
const h1 = new Float64Array(N1);
const h2 = new Float64Array(N2);

function codeOf(t: string): number {
  switch (t) {
    case 'empty': return 0;
    case 'box': return 1;
    case 'trap': return 2;
    case 'tunnel': return 3;
    case 'mouse_hole': return 4;
    case 'butter_spot': return 5;
    case 'pile': return 6;
    case 'wall': return 7;
    case 'void': return 8;
    default: return 0;
  }
}
function phaseCode(p: string): number {
  if (p === 'cat_wins') return 1;
  if (p === 'mouse_wins') return 2;
  if (p === 'choosing_tunnel_exit') return 3;
  return 0;
}

const off = (ch: number, r: number, c: number) => ch * 100 + r * 10 + c;

/** Build the 808 feature vector (identical to python build_tensors incl. NO_TRAP quirk). */
export function buildProductionFeatures(state: GameEngineState): Float32Array {
  feat.fill(0);
  const board = state.board;
  const catR = state.catPosition.r, catC = state.catPosition.c;
  const mouseR = state.mousePosition.r, mouseC = state.mousePosition.c;
  const trapR = state.trapPosition ? state.trapPosition.r : 0;
  const trapC = state.trapPosition ? state.trapPosition.c : 0;
  feat[off(0, catR, catC)] = 1;
  feat[off(1, mouseR, mouseC)] = 1;
  for (let r = 0; r < 10; r++) {
    const row = board[r];
    for (let c = 0; c < 10; c++) {
      const code = codeOf(row[c].type);
      if (code === 1) feat[off(2, r, c)] = 1;
      else if (code === 6) feat[off(3, r, c)] = 1;
      else if (code === 4) feat[off(4, r, c)] = 1;
      else if (code === 3) feat[off(5, r, c)] = 1;
      else if (code === 2) feat[off(7, r, c)] = 1;
    }
  }
  for (const bt of state.butterPositions.slice(0, 8)) {
    if (bt && bt.r >= 0 && bt.c >= 0 && bt.r < 10 && bt.c < 10) feat[off(6, bt.r, bt.c)] = 1;
  }
  // NO_TRAP quirk preserved (scatter trapR/trapC = 0,0 when no trap)
  feat[off(7, trapR, trapC)] = 1;
  feat[800] = state.currentPlayer === 'cat' ? 0 : 1;
  feat[801] = state.catMovesLeft / 4;
  feat[802] = state.mouseMovesLeft / 4;
  feat[803] = state.mouseHasButter ? 1 : 0;
  feat[804] = state.mouseSkillActive ? 1 : 0;
  feat[805] = state.catTrapsRemaining / 3;
  feat[806] = (state.blockedTunnels?.length ?? 0) / 4;
  feat[807] = phaseCode(state.phase) / 3;
  return feat;
}

/** Sparse forward on the scratch feature vector (same math as valuenet_infer_opt). */
export function productionValueNet(state: GameEngineState): number {
  buildProductionFeatures(state);
  let n = 0;
  for (let i = 0; i < DIN; i++) if (feat[i] !== 0) nz[n++] = i;
  for (let j = 0; j < N1; j++) {
    let acc = HYBRID_b1[j];
    for (let k = 0; k < n; k++) { const i = nz[k]; acc += feat[i] * HYBRID_W1f[i * N1 + j]; }
    h1[j] = Math.tanh(acc);
  }
  for (let j = 0; j < N2; j++) {
    let acc = HYBRID_b2[j];
    for (let i = 0; i < N1; i++) acc += h1[i] * HYBRID_W2f[i * N2 + j];
    h2[j] = Math.tanh(acc);
  }
  let out = HYBRID_b3;
  for (let i = 0; i < N2; i++) out += h2[i] * HYBRID_W3f[i];
  return Math.tanh(out);
}

// ---------------------------------------------------------------------------
// ELIGIBILITY (STRICT, §3/§8 — fail-closed; UNKNOWN => baseline)
// ---------------------------------------------------------------------------
/**
 * True only for states provably inside the formal canonical standard-map domain:
 *   canonical-v1 generator = { ...DEFAULT_CONFIG, difficulty: 'hard' }, no custom
 *   overrides (no customTerrain, no position lists, no tunnelCorners override,
 *   default gameMode single, default moves), board = standard 10x10 with NO
 *   wall/void anywhere, phase = playing, default mouseHole.
 * Every actual LEAF state is re-checked (a search successor may change phase to
 * ChoosingTunnelExit etc. -> then hybrid falls back to baseline for that leaf).
 */
export function isHybridEligibleState(state: GameEngineState): boolean {
  const cfg = state.config;
  // --- G0.4E-1.1 §2: full strict equality to canonical generator domain
  // canonical-v1 = { ...DEFAULT_CONFIG, difficulty: 'hard' } (no overrides) ---
  if (cfg.boardSize !== DEFAULT_CONFIG.boardSize) return false;                 // 10
  if (cfg.mouseHole.r !== 7 || cfg.mouseHole.c !== 8 || cfg.mouseHole.size !== 2) return false;
  if (cfg.boxCount !== DEFAULT_CONFIG.boxCount) return false;                   // 12
  if (cfg.pileCount !== DEFAULT_CONFIG.pileCount) return false;                 // 4
  if (cfg.butterCount !== DEFAULT_CONFIG.butterCount) return false;             // 2
  if (cfg.mouseStart.r !== DEFAULT_CONFIG.mouseStart.r || cfg.mouseStart.c !== DEFAULT_CONFIG.mouseStart.c) return false;
  if (cfg.catStart.r !== DEFAULT_CONFIG.catStart.r || cfg.catStart.c !== DEFAULT_CONFIG.catStart.c) return false;
  if (cfg.mouseBaseMoves !== DEFAULT_CONFIG.mouseBaseMoves) return false;       // 4
  if (cfg.mouseCarryingMoves !== DEFAULT_CONFIG.mouseCarryingMoves) return false; // 3
  if (cfg.mouseSkillExtraMoves !== DEFAULT_CONFIG.mouseSkillExtraMoves) return false; // 3
  if (cfg.catBaseMoves !== DEFAULT_CONFIG.catBaseMoves) return false;           // 4
  if (cfg.gameMode !== DEFAULT_CONFIG.gameMode) return false;                   // 'single'
  if (cfg.difficulty !== Difficulty.Hard) return false;                         // MUST be hard
  if (cfg.customTerrain !== undefined) return false;                            // custom terrain -> baseline
  if (cfg.tunnelCorners !== undefined) return false;                            // custom tunnel layout -> baseline
  if (cfg.boxPositions !== undefined) return false;
  if (cfg.pilePositions !== undefined) return false;
  if (cfg.butterPositions !== undefined) return false;
  // phase gate (ChoosingTunnelExit / terminal -> baseline)
  if (state.phase !== GamePhase.Playing) return false;
  // G0.4F-2A.2: pending ghost-butter spawns and placement debt are NOT part of
  // the frozen 808-feature ValueNet representation. Any unfinished future-butter
  // information (visible ghost OR placement debt) is outside the trained domain,
  // so Hybrid V1/V2 must fail-closed to baseline for those states. This is the
  // SINGLE eligibility source — V1 and V2 both call isHybridEligibleState.
  if ((state.pendingButterSpawns?.length ?? 0) > 0) return false;
  if ((state.pendingButterPlacementDebt ?? 0) > 0) return false;
  // board content: no wall/void anywhere (808 does not represent them)
  for (let r = 0; r < 10; r++) {
    const row = state.board[r];
    for (let c = 0; c < 10; c++) {
      const t = row[c].type;
      if (t === 'wall' || t === 'void') return false;
    }
  }
  return true;
}

/**
 * Testable hybrid computation from parts (G0.4E-1.1 §5). Pure: given the
 * evaluateForCat score and the ValueNet score, apply the frozen formula with
 * nonfinite guards. Throws on nonfinite inputs by returning NaN (caller decides).
 * The production hybridEvaluateForCat wraps this with the eligibility gate +
 * model call + try/catch.
 */
export function computeHybridFromParts(e: number, v: number): number {
  if (!Number.isFinite(v)) return NaN;       // nonfinite ValueNet -> not a usable hybrid
  const h = 0.5 * Math.tanh(e / HYBRID_S) + 0.5 * v;
  return Number.isFinite(h) ? h : NaN;       // nonfinite result -> not usable
}

// ---------------------------------------------------------------------------
// Fail-closed hybrid (§9)
// ---------------------------------------------------------------------------
export function hybridEvaluateForCat(state: GameEngineState): number {
  if (!isHybridEligibleState(state)) return evaluateForCat(state);
  try {
    const e = evaluateForCat(state);
    const v = productionValueNet(state);
    const h = computeHybridFromParts(e, v);
    if (!Number.isFinite(h)) return e;
    return h;
  } catch {
    return evaluateForCat(state);
  }
}

/** Resolve the active leaf by HardLeafMode (single source = HARD_LEAF_MODE_CONFIG).
 *  Per-leaf eligibility is re-checked inside hybridEvaluateForCat /
 *  hybridRouteV2EvaluateForCat for EVERY leaf state (not just the root).
 *
 *  Mode wiring (G0.4F-1.3 §6 + G0.4F-2B-1.2 §7):
 *    baseline                       → evaluateForCat
 *    baseline_hole_corrected        → evaluateCorrectedHoleForCat (H1, F2B-1.1)
 *    hybrid_standard_only           → hybridEvaluateForCat        (V1, unchanged)
 *    hybrid_route_v2_standard_only  → hybridRouteV2EvaluateForCat (V2, F12-confirmed)
 *
 *  H1 (baseline_hole_corrected) has NO eligibility gate: it is not a ValueNet,
 *  so ghost/debt states evaluate normally (G0.4F-2B-1.2 §8). The real ghost
 *  gameplay changes are still handled by the search transitions, not by H1.
 *
 *  NOTE: the hybridRouteV2EvaluateForCat import is call-time only (used inside
 *  resolveHardLeaf), so the hybridLeaf ↔ hybridRouteLeaf module cycle never
 *  touches the other's exports during module initialisation (no TDZ). */
export function resolveHardLeaf(): (s: GameEngineState) => number {
  const mode = getHardLeafMode();
  if (mode === 'baseline_hole_corrected') return evaluateCorrectedHoleForCat;
  if (mode === 'hybrid_standard_only') return hybridEvaluateForCat;
  if (mode === 'hybrid_route_v2_standard_only') return hybridRouteV2EvaluateForCat;
  return evaluateForCat;
}