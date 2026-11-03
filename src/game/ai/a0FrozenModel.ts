/* eslint-disable no-loss-of-precision */
/**
 * PPC-A0-DEV-01 — GENERATED FILE, DO NOT EDIT BY HAND.
 * Generator: scratch/ppc-a0-dev-01/gen-frozen-model.mjs (offline, one-off).
 *
 * The FROZEN G0.4F-2B-1.9AX A0_LINEAR expected-return bundle, copied verbatim
 * out of the research artifacts so a browser build needs no fs, no network and
 * no async load. Nothing here is fitted, tuned, quantised or re-derived:
 * MODEL_RETRAINED = FALSE, SCALER_CHANGED = FALSE, FEATURE_CHANGED = FALSE,
 * ARCH_CHANGED = FALSE. The runtime math is the 1.9BC-certified adapter
 * (predictFrozenA0Fast — G0.4F-2B-1.9BC sections 10-16: feature parity
 * 220754/220754 dims, max prediction error 9.992e-16 over 4799 states,
 * search parity D1 24/24 / D2 24/24 / D3 8/8, purity PASS).
 *
 * Byte-exact provenance (re-checked by a0ExpectedReturnLeaf.test.ts):
 *   ai-training/f2b19ax/ax_model_predev.weights.json        sha256 f840b70121543692c3b42a1a4d3571906010a49159472f1b96551a14ddd7f663
 *   ai-training/f2b19ax/ax_scaler_train.json                sha256 9aa766ce442234897392ef3a3feb90f0b0686de1e0e7b5f91045fabacf411eb6
 *   ai-training/f2b19ax/ax_frozen_model/feature_schema.json sha256 b7a9c27d4095214a5fb808e8340ec630c5627bb91f8bfd53c19b807b0fce5b58
 *   ai-training/f2b19ax/trainer/ts_model.mts (encoder)      sha256 7b4cb9e5c1c4dbcb71035e2770cdd3d577a728b79bf914c0f307e74a6a29ea92
 * (ai-training/f2b19ax/ax_state_dataset.json sha256 863c48841cd5c52216db8187a7dbb8510765b06f8aa00423bb38b69d3229b0c1 was read by
 *  this generator only, to cross-check scaler.constantColumns against the TRAIN
 *  split; the per-column support it reports goes in the DEV report, not here.)
 *
 * The two JSON texts below are escaped single-line string literals, so a CRLF
 * checkout of this .ts file cannot change the bytes that hash to those digests.
 */

export const A0_MODEL_SHA256 = 'f840b70121543692c3b42a1a4d3571906010a49159472f1b96551a14ddd7f663';
export const A0_SCALER_SHA256 = '9aa766ce442234897392ef3a3feb90f0b0686de1e0e7b5f91045fabacf411eb6';
export const A0_FEATURE_SCHEMA_SHA256 = 'b7a9c27d4095214a5fb808e8340ec630c5627bb91f8bfd53c19b807b0fce5b58';
export const A0_ENCODER_SHA256 = '7b4cb9e5c1c4dbcb71035e2770cdd3d577a728b79bf914c0f307e74a6a29ea92';

export const A0_ARCHITECTURE = 'A0_LINEAR';
export const A0_INPUT_DIM = 46;
export const A0_PARAMETER_COUNT = 47;

/** Verbatim text of ax_model_predev.weights.json (46 x 1 weights + 1 bias). */
export const A0_WEIGHTS_JSON_FROZEN = "{\n \"section\": \"G0.4F-2B-1.9AX final model weights (frozen pre-DEV)\",\n \"architecture\": \"A0_LINEAR\",\n \"shape\": [\n  46,\n  1\n ],\n \"w\": [\n  -0.18480632528450086,\n  -0.055225772162181025,\n  -0.3000159886791549,\n  0.12971163631803093,\n  0.4465185794826033,\n  -0.11566202642488772,\n  0.35988545117210835,\n  0.21406084815368343,\n  -0.01723322796652388,\n  -0.09029999847014837,\n  0.02625457170440072,\n  -0.01612664484983164,\n  -0.010129353284552485,\n  0.06060108160754339,\n  0.41363845694163814,\n  0.06122607192074934,\n  -0.24238958339834435,\n  0.12455689521928141,\n  0.3876303667235319,\n  0.2986126139002657,\n  0.10242520196726848,\n  0.28651634982671026,\n  0.15382455901860762,\n  -0.14740108833873428,\n  0.21781450172896064,\n  0.33113412809272913,\n  0.43947890172668247,\n  -0.32073106692591585,\n  0.1924719216404027,\n  -0.09723322594650456,\n  0.044071162978712164,\n  -0.2710637374350895,\n  0.0362977167851917,\n  0.18049699394563434,\n  -0.0543099341900751,\n  0.1425109325308355,\n  -0.050234722270844426,\n  0.06468337036695443,\n  -0.05876187783253606,\n  0.019815343051430397,\n  -0.1780697583964638,\n  -0.15953090377515664,\n  -0.27327143873639836,\n  -0.09031228764244408,\n  -0.29323670269816315,\n  0.13235648377030373\n ],\n \"b\": [\n  0.13350010598704945\n ]\n}";

/** Verbatim text of ax_scaler_train.json (FIT-only TRAIN mean / std). */
export const A0_SCALER_JSON_FROZEN = "{\n \"section\": \"G0.4F-2B-1.9AX §17 TRAIN scaler (216 roots; DEV only transforms)\",\n \"trainRootCount\": 216,\n \"trainStateCount\": 1726,\n \"inputDim\": 46,\n \"mean\": [\n  7.553302433371958,\n  0,\n  0,\n  0,\n  3.3302433371958284,\n  0,\n  10.84125144843569,\n  0,\n  2.8157589803012746,\n  2.6245654692931635,\n  82.8603707995365,\n  73.61239860950174,\n  4,\n  0,\n  0,\n  3.726535341830823,\n  0,\n  4,\n  0,\n  0,\n  0,\n  0,\n  0,\n  4.40324449594438,\n  0,\n  0,\n  0,\n  0,\n  4,\n  4.22595596755504,\n  11.398030127462341,\n  0,\n  2.458864426419467,\n  0,\n  8.939165701042874,\n  0,\n  25.004055619930476,\n  48.3018539976825,\n  2.574159907300116,\n  -0.30710209384810405,\n  10,\n  2,\n  0,\n  0,\n  0.4101969872537659,\n  -1140.6707083863314\n ],\n \"std\": [\n  5.978262873528703,\n  0,\n  0,\n  0,\n  1.5180950468090753,\n  0,\n  3.4619687512079445,\n  0,\n  0.8010029040036951,\n  0.7927533988521488,\n  0.4368255355251682,\n  1.5054352415070071,\n  0,\n  0,\n  0,\n  2.8641432808272445,\n  0,\n  0,\n  0,\n  0,\n  0,\n  0,\n  0,\n  4.190381154992408,\n  0,\n  0,\n  0,\n  0,\n  0,\n  0.7387146978244667,\n  1.9648642112708525,\n  0,\n  0.6223806638817684,\n  0,\n  2.0018259912665513,\n  0,\n  8.071198656123928,\n  7.378436766926108,\n  3.5742421776882707,\n  0.19843241883989762,\n  0,\n  0,\n  0,\n  0,\n  0.49186931079475005,\n  373.0510560756825\n ],\n \"constantColumns\": [\n  2,\n  12,\n  13,\n  17,\n  27,\n  28,\n  40,\n  41,\n  42,\n  43\n ]\n}";

/** The frozen encoder's feature specification, in input order (ts_model.mts). */
export const A0_FEATURE_SPECS = [
  ['catMouseDistance', 'nullnum'],
  ['mouseGoalDistance', 'nullnum'],
  ['mouseButterDistance', 'nullnum'],
  ['mouseWinRouteDistance', 'nullnum'],
  ['mouseMobility', 'num'],
  ['catMobility', 'num'],
  ['mouseReachableArea', 'num'],
  ['catReachableArea', 'num'],
  ['openTunnelCount', 'num'],
  ['blockedTunnelCount', 'num'],
  ['mouseTunnelAllowed', 'bool'],
  ['mouseTunnelAccessDistance', 'nullnum'],
  ['reachableOpenTunnelCount', 'num'],
  ['mouseCanReachTunnel', 'bool'],
  ['mouseHasButter', 'bool'],
  ['mouseSkillActive', 'bool'],
  ['catHasTrapAvailable', 'bool'],
  ['trapActive', 'bool'],
  ['mouseTrapDistance', 'nullnum'],
  ['currentPlayer', 'cat'],
  ['catMovesLeft', 'num'],
  ['mouseMovesLeft', 'num'],
  ['holeGateCount', 'num'],
  ['catHoleGateDistance', 'nullnum'],
  ['mouseHoleGateDistance', 'nullnum'],
  ['holeControlMargin', 'nullnum'],
  ['catControlledArea', 'num'],
  ['mouseControlledArea', 'num'],
  ['contestedArea', 'num'],
  ['voronoiBalance', 'num'],
  ['boardSize', 'num'],
  ['butterPositions.length', 'num'],
  ['pendingButterSpawns.length', 'num'],
  ['pendingButterPlacementDebt', 'num'],
  ['catTrapsRemaining', 'num'],
  ['BASE_EVAL_TOTAL', 'num']
] as const;

/** The 46 schema columns in order (== ax_frozen_model/feature_schema.json). */
export const A0_FEATURE_COLUMNS = [
  'catMouseDistance_VALUE', 'catMouseDistance_MISSING', 'mouseGoalDistance_VALUE', 'mouseGoalDistance_MISSING',
  'mouseButterDistance_VALUE', 'mouseButterDistance_MISSING', 'mouseWinRouteDistance_VALUE', 'mouseWinRouteDistance_MISSING',
  'mouseMobility', 'catMobility', 'mouseReachableArea', 'catReachableArea',
  'openTunnelCount', 'blockedTunnelCount', 'mouseTunnelAllowed', 'mouseTunnelAccessDistance_VALUE',
  'mouseTunnelAccessDistance_MISSING', 'reachableOpenTunnelCount', 'mouseCanReachTunnel', 'mouseHasButter',
  'mouseSkillActive', 'catHasTrapAvailable', 'trapActive', 'mouseTrapDistance_VALUE',
  'mouseTrapDistance_MISSING', 'CURRENT_CAT', 'CURRENT_MOUSE', 'catMovesLeft',
  'mouseMovesLeft', 'holeGateCount', 'catHoleGateDistance_VALUE', 'catHoleGateDistance_MISSING',
  'mouseHoleGateDistance_VALUE', 'mouseHoleGateDistance_MISSING', 'holeControlMargin_VALUE', 'holeControlMargin_MISSING',
  'catControlledArea', 'mouseControlledArea', 'contestedArea', 'voronoiBalance',
  'boardSize', 'butterPositions.length', 'pendingButterSpawns.length', 'pendingButterPlacementDebt',
  'catTrapsRemaining', 'BASE_EVAL_TOTAL'
] as const;

/** Per-dimension role: VALUE is standardised; MISSING / BOOL / ONEHOT are not. */
export const A0_DIM_ROLES = [
  'VALUE', 'MISSING', 'VALUE', 'MISSING', 'VALUE', 'MISSING', 'VALUE', 'MISSING',
  'VALUE', 'VALUE', 'VALUE', 'VALUE', 'VALUE', 'VALUE', 'BOOL', 'VALUE',
  'MISSING', 'VALUE', 'BOOL', 'BOOL', 'BOOL', 'BOOL', 'BOOL', 'VALUE',
  'MISSING', 'ONEHOT', 'ONEHOT', 'VALUE', 'VALUE', 'VALUE', 'VALUE', 'MISSING',
  'VALUE', 'MISSING', 'VALUE', 'MISSING', 'VALUE', 'VALUE', 'VALUE', 'VALUE',
  'VALUE', 'VALUE', 'VALUE', 'VALUE', 'VALUE', 'VALUE'
] as const;

const a0WeightsParsed = JSON.parse(A0_WEIGHTS_JSON_FROZEN) as { w: number[]; b: number[] };
const a0ScalerParsed = JSON.parse(A0_SCALER_JSON_FROZEN) as { mean: number[]; std: number[] };

/** Raw frozen weights / bias / TRAIN mean / TRAIN std (reference head input). */
export const A0_W: readonly number[] = a0WeightsParsed.w;
export const A0_BIAS: number = a0WeightsParsed.b[0];
export const A0_MEAN: readonly number[] = a0ScalerParsed.mean;
export const A0_STD: readonly number[] = a0ScalerParsed.std;

/**
 * Scaler pre-fold, statement-for-statement identical to
 * ai-training/f2b19bc/bc_fast.ts buildFastModel():
 *   z = A0_BIAS_SCALED + SUM_i A0_W_SCALED[i] * x[i]
 * Only dims whose role is VALUE with std > 1e-12 are folded — the frozen
 * predicate (NOT the standardize() std !== 0 test).
 */
const a0FoldFastModel = (): { wScaled: Float64Array; biasScaled: number } => {
  const n = A0_INPUT_DIM;
  const wScaled = new Float64Array(n);
  let biasScaled = A0_BIAS;
  for (let i = 0; i < n; i++) {
    if (A0_DIM_ROLES[i] === 'VALUE' && A0_STD[i] > 1e-12) {
      wScaled[i] = A0_W[i] / A0_STD[i];
      biasScaled -= (A0_W[i] * A0_MEAN[i]) / A0_STD[i];
    } else {
      wScaled[i] = A0_W[i];
    }
  }
  return { wScaled, biasScaled };
};
const a0Fast = a0FoldFastModel();
export const A0_W_SCALED: Float64Array = a0Fast.wScaled;
export const A0_BIAS_SCALED: number = a0Fast.biasScaled;
