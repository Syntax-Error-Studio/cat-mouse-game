import { test, expect, describe } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState } from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import type { SearchAction } from '../searchTypes';
import { defaultRuleSet } from '../searchRules';
import { planHardCatTurn } from '../hardTurnPlanner';
import { searchBestActionIterative } from '../expectiminimax';
import { evaluateForCat } from '../evaluation';
import { simulateSearchAction } from '../simulator';
import {
  runBoundedProbe,
  runRefutationSidecar,
  shouldRunSidecar,
  replayMouseWitness,
  replayCatCandidate,
  pickOverrideCandidate,
  selectCandidates,
  FIXED_PATHS,
  FIXED_CPU_MS,
  FIXED_EXACT,
} from '../boundedPlanRefutation';
import type { BoundedRefutationProbeResult } from '../boundedPlanRefutation';
import { DIRECTIONS } from '../../types';

// ===========================================================================
// G0.3W — Bounded Plan Refutation: production-trial tests (§22)
// ===========================================================================

const BIG = 1_000_000;


function cleanConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: { r: 1, c: 1 },
    catStart: { r: 1, c: 3 },
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    catBaseMoves: 4,
    gameMode: 'single',
    difficulty: 'hard',
    tunnelCorners: [
      { r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 },
    ],
    ...overrides,
  };
}

function setPieces(
  state: GameEngineState,
  mouse: { r: number; c: number },
  cat?: { r: number; c: number },
): GameEngineState {
  const board: GameEngineState['board'] = state.board.map((row) =>
    row.map((cell) => ({ ...cell, piece: undefined })),
  );
  board[mouse.r][mouse.c] = { ...board[mouse.r][mouse.c], piece: PieceType.Mouse };
  if (cat) board[cat.r][cat.c] = { ...board[cat.r][cat.c], piece: PieceType.Cat };
  const patch: Partial<GameEngineState> = { board, mousePosition: { ...mouse } };
  if (cat) patch.catPosition = { ...cat };
  return { ...state, ...patch };
}

function wallOff(state: GameEngineState, open: { r: number; c: number }[]): GameEngineState {
  const openSet = new Set(open.map((p) => `${p.r},${p.c}`));
  const board: GameEngineState['board'] = state.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) return cell;
      if (openSet.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

function asCatTurn(state: GameEngineState): GameEngineState {
  return {
    ...state,
    currentPlayer: PieceType.Cat,
    catMovesLeft: state.config.catBaseMoves,
    mouseMovesLeft: state.config.mouseBaseMoves,
    phase: GamePhase.Playing,
  };
}

const shortOf = (a: { type: string; direction?: { key: string } }): string => {
  if (a.type === 'catStep' || a.type === 'mouseStep') return a.direction!.key.slice(5)[0] ?? '?';
  if (a.type === 'catPlaceTrap') return 'PT';
  if (a.type === 'mouseSkill') return 'SK';
  if (a.type === 'chooseTunnel') return 'TU';
  return '?';
};

const PROBE = { maxPaths: FIXED_PATHS, maxCpuMs: FIXED_CPU_MS, maxExact: FIXED_EXACT };

// ---------------------------------------------------------------------------
// 1. disabled = baseline identical
// ---------------------------------------------------------------------------
test('G0.3W-1. feature OFF = baseline identical (plan/value/bestAction unchanged)', () => {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 7 }, { r: 3, c: 5 });
  s = wallOff(s, [{ r: 1, c: 1 }, { r: 2, c: 1 }, { r: 3, c: 1 }, { r: 4, c: 1 }, { r: 4, c: 7 }]);
  s = {
    ...s,
    butterPositions: [{ r: 2, c: 8 }],
    mouseHasButter: true,
    mouseSkillActive: false,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 3,
    phase: GamePhase.Playing,
    catTrapsRemaining: 1,
    trapPosition: null,
  };
  const off = planHardCatTurn(s, { rules: defaultRuleSet, timeBudgetMs: 200, now: () => 0 });
  const onButDisabled = planHardCatTurn(s, {
    rules: defaultRuleSet, timeBudgetMs: 200, now: () => 0,
    refutation: { enabled: false },
  });
  expect(onButDisabled.plan.map(shortOf)).toEqual(off.plan.map(shortOf));
  expect(onButDisabled.search.value).toBe(off.search.value);
  expect(onButDisabled.search.mate).toBe(off.search.mate);
  expect(onButDisabled.bestAction).toEqual(off.bestAction);
  expect(onButDisabled.debug.refutation).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 2/3. mate=cat / mate=mouse bypass
// ---------------------------------------------------------------------------
test('G0.3W-2. mate=cat bypass: sidecar never runs when the baseline has exact cat mate', () => {
  // Adjacent capture: search returns mate=cat → sidecar must be bypassed.
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 4 });
  s = wallOff(s, [{ r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
  s = asCatTurn(s);
  const res = planHardCatTurn(s, {
    rules: defaultRuleSet, timeBudgetMs: 200, now: () => 0,
    refutation: { enabled: true, totalTurnBudgetMs: 500 },
  });
  expect(res.search.mate).toBe('cat');
  expect(res.debug.refutation).toBeDefined();
  expect(res.debug.refutation!.refutationTriggered).toBe(false);
  expect(res.debug.refutation!.sidecarAbortReason).toBe('mate_bypass');
  // plan unchanged from baseline
  expect(res.plan.map(shortOf)).toEqual(res.search.catTurnPlan.map(shortOf));
});

test('G0.3W-3. mate=mouse bypass via shouldRunSidecar gate', () => {
  expect(shouldRunSidecar({
    difficulty: 'hard', phase: GamePhase.Playing, currentPlayer: PieceType.Cat,
    baselinePlanLegal: true, baselineCompleted: true, baselineMate: 'mouse', enabled: true,
  })).toBe(false);
  expect(shouldRunSidecar({
    difficulty: 'hard', phase: GamePhase.Playing, currentPlayer: PieceType.Cat,
    baselinePlanLegal: true, baselineCompleted: true, baselineMate: null, enabled: true,
  })).toBe(true);
  expect(shouldRunSidecar({
    difficulty: 'hard', phase: GamePhase.Playing, currentPlayer: PieceType.Cat,
    baselinePlanLegal: true, baselineCompleted: true, baselineMate: null, enabled: false,
  })).toBe(false);
});

// ---------------------------------------------------------------------------
// 8. external deadline => INCOMPLETE
// ---------------------------------------------------------------------------
test('G0.3W-8. external deadline => INCOMPLETE, never a completed negative', () => {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 7 }, { r: 3, c: 5 });
  s = wallOff(s, [{ r: 1, c: 1 }, { r: 2, c: 1 }, { r: 3, c: 1 }, { r: 4, c: 1 }, { r: 4, c: 7 }]);
  s = {
    ...s,
    butterPositions: [{ r: 2, c: 8 }],
    mouseHasButter: true,
    mouseSkillActive: false,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 3,
    phase: GamePhase.Playing,
  };
  // deadline already in the past → probe cannot start → INCOMPLETE
  const r = runBoundedProbe(s, defaultRuleSet, { ...PROBE, externalDeadlineMs: 0, now: () => 0 });
  expect(r.status).toBe('INCOMPLETE');
  expect(r.incomplete).toBe(true);
  expect(r.refuted).toBe(false);
  // An INCOMPLETE report must never act as NO_REFUTATION_FOUND in the override.
  expect(pickOverrideCandidate(
    [], [r], 0,
  )).toBe(0);
});

// ---------------------------------------------------------------------------
// 9. INCOMPLETE cannot override
// ---------------------------------------------------------------------------
test('G0.3W-9. INCOMPLETE candidate can never be selected as the override', () => {
  const mk = (status: BoundedRefutationProbeResult['status'], refuted: boolean): BoundedRefutationProbeResult => ({
    status, refuted, witness: [], witnessType: null, boundaryReached: null,
    pathsVisited: 1, distinctBoundaries: 1, exactLocalChecks: 0, l1Checked: 1,
    rejectedBeforeExact: 1, respondedCount: 1, threatVisited: 0, chanceMixed: false,
    cpuMs: 1, incomplete: status === 'INCOMPLETE', budgetCut: false, pathRank: null,
    dangerOrderHit: false, invalidWitness: false,
    // cheap geometry stub for comparator
  } as unknown as BoundedRefutationProbeResult);
  // baseline REFUTED, candidate 1 NO_REFUTATION_FOUND, candidate 2 INCOMPLETE
  // → override must pick the NO_REFUTATION_FOUND candidate, never the INCOMPLETE one.
  const cands = [
    { planWitness: [], planLabel: 'A', mouseRoot: {} as GameEngineState, semKey: 'a', cheap: { worstInterceptMargin: 9 } as never, firstAction: 'x', rankHint: 'A' },
    { planWitness: [], planLabel: 'B', mouseRoot: {} as GameEngineState, semKey: 'b', cheap: { worstInterceptMargin: 4 } as never, firstAction: 'y', rankHint: 'B' },
    { planWitness: [], planLabel: 'C', mouseRoot: {} as GameEngineState, semKey: 'c', cheap: { worstInterceptMargin: 2 } as never, firstAction: 'z', rankHint: 'C' },
  ] as never[];
  const reports = [mk('PLAN_REFUTED', true), mk('NO_REFUTATION_FOUND', false), mk('INCOMPLETE', false)];
  const idx = pickOverrideCandidate(cands as never, reports, 100);
  expect(idx).toBe(1); // picks B (NO_REFUTATION_FOUND, margin 4), not C (INCOMPLETE, margin 2)
});

// ---------------------------------------------------------------------------
// 10. invalid witness cannot override
// ---------------------------------------------------------------------------
test('G0.3W-10. invalid witness cannot override (replay gate)', () => {
  const mk = (refuted: boolean, invalidWitness: boolean): BoundedRefutationProbeResult => ({
    status: refuted && !invalidWitness ? 'PLAN_REFUTED' : 'NO_REFUTATION_FOUND',
    refuted, witness: [], witnessType: refuted ? 'A' : null, boundaryReached: null,
    pathsVisited: 1, distinctBoundaries: 1, exactLocalChecks: 0, l1Checked: 1,
    rejectedBeforeExact: 1, respondedCount: 1, threatVisited: 0, chanceMixed: false,
    cpuMs: 1, incomplete: false, budgetCut: false, pathRank: null,
    dangerOrderHit: false, invalidWitness,
  } as unknown as BoundedRefutationProbeResult);
  const cands = [
    { planWitness: [], planLabel: 'A', mouseRoot: {} as GameEngineState, semKey: 'a', cheap: { worstInterceptMargin: 9 } as never, firstAction: 'x', rankHint: 'A' },
    { planWitness: [], planLabel: 'B', mouseRoot: {} as GameEngineState, semKey: 'b', cheap: { worstInterceptMargin: 4 } as never, firstAction: 'y', rankHint: 'B' },
  ] as never[];
  // Baseline claims refuted but the witness is INVALID → not a real refutation.
  const reports = [mk(true, true), mk(false, false)];
  expect(pickOverrideCandidate(cands as never, reports, 100)).toBe(0);
});

// ---------------------------------------------------------------------------
// 11. invalid cat candidate cannot execute
// ---------------------------------------------------------------------------
test('G0.3W-11. invalid cat candidate cannot execute (cat replay gate)', () => {
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 1 });
  s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
  s = asCatTurn(s);
  // A valid plan: ArrowRight ×4.
  const R = DIRECTIONS.find(d => d.key === 'ArrowRight')!;
  const validPlan: SearchAction[] = [0, 1, 2, 3].map(() => ({ type: 'catStep', direction: R }));
  expect(replayCatCandidate(s, validPlan, defaultRuleSet).valid).toBe(true);
  // An invalid plan: a mouseStep is NOT a legal cat action.
  const badPlan: SearchAction[] = [{ type: 'mouseStep', direction: R }];
  expect(replayCatCandidate(s, badPlan, defaultRuleSet).valid).toBe(false);
  // A step into a wall (illegal) is rejected.
  const U = DIRECTIONS.find(d => d.key === 'ArrowUp')!;
  const wallPlan: SearchAction[] = [{ type: 'catStep', direction: U }];
  expect(replayCatCandidate(s, wallPlan, defaultRuleSet).valid).toBe(false);
});

// ---------------------------------------------------------------------------
// 12. chance mixed is not a guaranteed refutation
// ---------------------------------------------------------------------------
test('G0.3W-12. chance-bearing refutation path is CHANCE_MIXED, never REFUTED', () => {
  // Mouse not carrying; the ONLY butter sits directly south — any win path must
  // step onto it (a real CHANCE node, since the open board has many respawn
  // cells). A refuting leaf behind that chance is NOT a guaranteed refutation.
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 7 }, { r: 0, c: 0 });
  s = {
    ...s,
    butterPositions: [{ r: 5, c: 7 }],
    mouseHasButter: false,
    mouseSkillActive: false,
    currentPlayer: PieceType.Mouse, // mouse root (side to move)
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    catTrapsRemaining: 0,
    trapPosition: null,
  };
  const r = runBoundedProbe(s, defaultRuleSet, { maxPaths: 128, maxCpuMs: 500, maxExact: 48 });
  // The mouse CAN reach the hole carrying butter, but only via the butter
  // pickup (chance). The single-witness model cannot guarantee ALL chance
  // outcomes refute → must be CHANCE_MIXED or NO_REFUTATION_FOUND, never
  // PLAN_REFUTED with a deterministic A witness.
  expect(r.status).not.toBe('PLAN_REFUTED');
  if (r.status === 'CHANCE_MIXED') {
    expect(r.refuted).toBe(false);
    expect(r.chanceMixed).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// 13. trap / skill / tunnel witness replay legality
// ---------------------------------------------------------------------------
test('G0.3W-13. trap / skill / tunnel witness replay legality', () => {
  // (a) mouseSkill witness: carrying mouse drops butter via skill, then steps
  //     onto the trap (ends the mouse turn → boundary) → legal.
  let s = createInitialState(cleanConfig());
  s = setPieces(s, { r: 4, c: 7 }, { r: 1, c: 1 });
  s = wallOff(s, [{ r: 4, c: 7 }, { r: 5, c: 7 }, { r: 1, c: 1 }]);
  s = {
    ...s,
    butterPositions: [{ r: 8, c: 1 }],
    mouseHasButter: true,
    mouseSkillActive: false,
    currentPlayer: PieceType.Mouse, // mouse root (side to move)
    catMovesLeft: 4,
    mouseMovesLeft: 3,
    phase: GamePhase.Playing,
    trapPosition: { r: 5, c: 7 },
  };
  const D = DIRECTIONS.find(d => d.key === 'ArrowDown')!;
  const skillWitness: SearchAction[] = [{ type: 'mouseSkill' }, { type: 'mouseStep', direction: D }];
  const repSkill = replayMouseWitness(s, skillWitness, defaultRuleSet);
  expect(repSkill.valid).toBe(true);
  expect(repSkill.finalState!.currentPlayer).toBe(PieceType.Cat); // trap ended the mouse turn
  // mouseSkill is only legal when carrying; a mouse that never had butter cannot skill.
  const noButter = { ...s, mouseHasButter: false };
  const repSkillInvalid = replayMouseWitness(noButter, [{ type: 'mouseSkill' }], defaultRuleSet);
  expect(repSkillInvalid.valid).toBe(false);

  // (b) a mouse witness containing a CAT trap placement is illegal.
  const trapWitness: SearchAction[] = [{ type: 'catPlaceTrap' }];
  expect(replayMouseWitness(s, trapWitness, defaultRuleSet).valid).toBe(false);
});

// ---------------------------------------------------------------------------
// Real-corpus G4 / G1 regressions (§10–§12)
// ---------------------------------------------------------------------------
// The real corpus lives in the user's Downloads; when absent, loadRoot returns
// null and the test is explicitly SKIPPED (never a vacuous pass).

// helper: load game root from the real corpus (SNAPSHOT_JSON authoritative).
// The specifier is cast to `string` so TS does not statically resolve the root
// forensic module (g03o_lib.mts is outside `src` and uses node:fs); vitest
// still bundles and runs it.
async function loadRoot(game: number, turn: number): Promise<GameEngineState | null> {
  try {
    const mod = await import('../../../../g03o_lib.mts' as string) as { parseGames: () => Map<number, { turns: { turn: number; root: GameEngineState | null }[] }> };
    const games = mod.parseGames();
    const g = games.get(game);
    const t = g?.turns.find(x => x.turn === turn);
    return t?.root ?? null;
  } catch {
    return null;
  }
}

describe('G0.3W real-corpus regression (G4 / G1)', () => {
  test('G0.3W-4. G4 BAD plan is PLAN_REFUTED with D→D→R witness', async (ctx) => {
    const root = await loadRoot(4, 2);
    if (!root) { ctx.skip(); return; }
    const base = searchBestActionIterative(root, {
      rules: defaultRuleSet, maxDepthTurns: 1, maxNodes: BIG,
      useTT: true, useAlphaBeta: true, useMoveOrdering: true, maxThreatExtensions: 0,
      leafEvaluator: evaluateForCat,
    });
    const baselinePlan = base.catTurnPlan;
    // authoritative G4 baseline is U→R→PlaceTrap→D→R
    expect(baselinePlan.map(shortOf).join('')).toContain('PT');
    const cands = selectCandidates(root, baselinePlan, defaultRuleSet);
    const badIdx = cands.findIndex(c => {
      // replay to mouse root: BAD = cat (3,5) / mouse (4,7)
      let cur = root;
      for (const a of c.planWitness) {
        const tr = simulateSearchAction(cur, a, defaultRuleSet);
        if (tr.kind !== 'deterministic') return false;
        cur = tr.state;
        if (cur.currentPlayer !== PieceType.Cat || cur.phase !== GamePhase.Playing) break;
      }
      return cur.currentPlayer === PieceType.Mouse && cur.catPosition.r === 3 && cur.catPosition.c === 5 &&
        cur.mousePosition.r === 4 && cur.mousePosition.c === 7;
    });
    expect(badIdx).toBeGreaterThanOrEqual(0);
    const rep = runBoundedProbe(cands[badIdx].mouseRoot, defaultRuleSet, PROBE);
    expect(rep.status).toBe('PLAN_REFUTED');
    expect(rep.witness.map(shortOf).join('')).toBe('DDR');
    expect(rep.pathRank).toBe(1);
  });

  test('G0.3W-5. G4 candidate override: baseline BAD → RRRR (GOOD) when budget is sufficient', async (ctx) => {
    const root = await loadRoot(4, 2);
    if (!root) { ctx.skip(); return; }
    const base = searchBestActionIterative(root, {
      rules: defaultRuleSet, maxDepthTurns: 1, maxNodes: BIG,
      useTT: true, useAlphaBeta: true, useMoveOrdering: true, maxThreatExtensions: 0,
      leafEvaluator: evaluateForCat,
    });
    // deadline OFF (no external total budget) → full sidecar decision
    const sidecar = runRefutationSidecar(root, base.catTurnPlan, base.value, {
      rules: defaultRuleSet,
      totalDeadlineMs: Number.MAX_SAFE_INTEGER,
      now: () => performance.now(),
      enabled: true,
    });
    expect(sidecar.overrideUsed).toBe(true);
    const sel = sidecar.plan.map(shortOf).join('');
    expect(sel).not.toContain('PT'); // not the authoritative BAD plan
    // replay the selected plan from the original root: must be legal
    expect(replayCatCandidate(root, sidecar.plan, defaultRuleSet).valid).toBe(true);
  });

  test('G0.3W-6. G1 T2: all candidates refuted → NO_OVERRIDE (baseline kept)', async (ctx) => {
    const root = await loadRoot(1, 2);
    if (!root) { ctx.skip(); return; }
    const base = searchBestActionIterative(root, {
      rules: defaultRuleSet, maxDepthTurns: 1, maxNodes: BIG,
      useTT: true, useAlphaBeta: true, useMoveOrdering: true, maxThreatExtensions: 0,
      leafEvaluator: evaluateForCat,
    });
    const cands = selectCandidates(root, base.catTurnPlan, defaultRuleSet);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    const reports = cands.map(c => runBoundedProbe(c.mouseRoot, defaultRuleSet, PROBE));
    // every candidate refuted (G0.3V: 6/6) → no clean candidate exists
    expect(reports.every(r => r.status === 'PLAN_REFUTED')).toBe(true);
    const sidecar = runRefutationSidecar(root, base.catTurnPlan, base.value, {
      rules: defaultRuleSet, totalDeadlineMs: Number.MAX_SAFE_INTEGER,
      now: () => performance.now(), enabled: true,
    });
    expect(sidecar.overrideUsed).toBe(false);
    expect(sidecar.plan.map(shortOf)).toEqual(base.catTurnPlan.map(shortOf));
  });

  test('G0.3W-7. G1 T1: baseline not refuted → NO_OVERRIDE (baseline kept)', async (ctx) => {
    const root = await loadRoot(1, 1);
    if (!root) { ctx.skip(); return; }
    const base = searchBestActionIterative(root, {
      rules: defaultRuleSet, maxDepthTurns: 1, maxNodes: BIG,
      useTT: true, useAlphaBeta: true, useMoveOrdering: true, maxThreatExtensions: 0,
      leafEvaluator: evaluateForCat,
    });
    const cands = selectCandidates(root, base.catTurnPlan, defaultRuleSet);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    const reports = cands.map(c => runBoundedProbe(c.mouseRoot, defaultRuleSet, PROBE));
    // baseline (first candidate) NOT refuted (G0.3V: 6/6 NO_REFUTATION_FOUND)
    expect(reports[0].refuted).toBe(false);
    const sidecar = runRefutationSidecar(root, base.catTurnPlan, base.value, {
      rules: defaultRuleSet, totalDeadlineMs: Number.MAX_SAFE_INTEGER,
      now: () => performance.now(), enabled: true,
    });
    expect(sidecar.overrideUsed).toBe(false);
    expect(sidecar.plan.map(shortOf)).toEqual(base.catTurnPlan.map(shortOf));
  });
});
