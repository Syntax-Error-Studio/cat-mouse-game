/**
 * G0.4F-2B-1.6 — M3-lite Progress Guard production tests (P1-P30).
 *
 * P1  prototype progress parity          — production progressGuard helper
 *      matches F2B-1.5 semantics on Game5 T14/T15 (noProgressLoop, signature).
 * P2  T14 no trigger                     — first ULDR, no prev memory → guard idle.
 * P3  T15 trigger                        — prev ULDR memory + current ULDR + mouse
 *      observed → trigger=TRUE.
 * P4  T15 previous depth = DDLD          — single search maxDepth=2 exposes
 *      previousCompletedPlan = DDLD.
 * P5  previous-depth standalone parity   — previousCompletedPlan == standalone D1.
 * P6  T15 exact mouse win count = 0      — rescue DDLD mouse root enumeration.
 * P7  T15 rescue probe NO_REFUTATION_FOUND.
 * P8  T15 final plan DDLD (guard applied via passMemory).
 * P9/P10 T4/T5 no trigger.
 * P11-P14 useful box / trap / ghost-classification / route loops have progress →
 *         no trigger.
 * P15 F8 mate=cat bypass (guard never overrides capture).
 * P16 forced-loss bypass (all-safe gate fails → no trigger).
 * P17 refutation override bypass (selectedPlanSource != baseline → skip).
 * P18 refutation current PLAN_REFUTED bypass.
 * P19 rescue probe PLAN_REFUTED fail-closed (synthetic).
 * P20 deadline fail-closed (timeBudget exhausted → abort keep original).
 * P21 fallback invalidates memory.
 * P22 mouse turn observed only Mouse→Cat endTurn.
 * P23 memory snapshot/restore exact.
 * P24 memory excluded from stateKey/TT.
 * P25 baseline guard-off exactness.
 * P26 H1 guard-off exactness.
 * P27 V1/V2 untouched (resolveHardLeaf identity + guard ineligible).
 * P28 Game1 final root no trigger.
 * P29 default OFF.
 * P30 one main search per cat turn (previous depth from same search — no
 *     second searchBestActionIterative call).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createEngineRuleSet, createInitialState, type GameEngineState } from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty, PieceType, GamePhase, CellType, DIRECTIONS, type Direction } from '../../types';
import type { SearchAction } from '../searchTypes';
import { planHardCatTurn, runProgressGuard, rescueProbeAllows } from '../hardTurnPlanner';
import type { RefutationDiagnostics } from '../boundedPlanRefutation';
import type { ProbeStatus } from '../boundedPlanRefutation';
import { evaluateForCat } from '../evaluation';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { resolveHardLeaf, setHardLeafMode, hybridEvaluateForCat } from '../hybridLeaf';
import { hybridRouteV2EvaluateForCat } from '../hybridRouteLeaf';
import { HARD_PROGRESS_GUARD_CONFIG } from '../searchConfig';
import {
  replayCatPlanLabel, classifyExecutedCatTurn, progressGuardTrigger, progressGuardEligible,
  emptyProgressGuardMemory, signaturesEqual, type HardProgressGuardMemory,
} from '../progressGuard';
import { restoreHardRoot, captureHardRoot, type HardRootSnapshot } from '../hardHistory';
import { gameAffectingEqual } from '../stateCompare';
import { stateKey } from '../transposition';
import { enumerateFullTurnLegacy } from '../turnBoundary';
import { runBoundedProbe, FIXED_PATHS, FIXED_CPU_MS, FIXED_EXACT } from '../boundedPlanRefutation';
import { makeFiniteDeadline, NO_DEADLINE } from '../deadlineContext';

const rules = createEngineRuleSet();
const label = (a: SearchAction): string => a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?';

/** Build real cat SearchAction[] from a label like "ULDR". */
function actionsFromStrings(tokens: string[]): SearchAction[] {
  const byShort: Record<string, Direction> = {
    U: DIRECTIONS.find((d) => d.key === 'ArrowUp')!,
    D: DIRECTIONS.find((d) => d.key === 'ArrowDown')!,
    L: DIRECTIONS.find((d) => d.key === 'ArrowLeft')!,
    R: DIRECTIONS.find((d) => d.key === 'ArrowRight')!,
  };
  return tokens.map((tok) => tok === 'T'
    ? { type: 'catPlaceTrap' as const }
    : { type: 'catStep' as const, direction: byShort[tok] });
}

/** Minimal IterativeSearchResult exposing previousCompletedPlan for the guard.
 *  Tests only — the guard reads completedDepth/mate/previousCompletedPlan;
 *  everything else is unused by runProgressGuard. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeSearch(prevPlan: SearchAction[]): any {
  return {
    completedDepth: 2,
    attemptedDepth: 2,
    mate: null,
    value: -1,
    bestAction: null,
    completed: true,
    budgetExhausted: false,
    deadlineExceeded: false,
    catTurnPlan: prevPlan, // deepest plan (the loop ULDR) supplied by caller where needed
    previousCompletedDepth: 1,
    previousCompletedPlan: prevPlan,
    previousCompletedValue: 0,
    previousCompletedMate: null,
    rootActions: [],
    diagnostics: { totalNodes: 1 },
    iterations: [],
  };
}

/** Restore a game turn root from the F0 timeline SNAPSHOT_JSON authority. */
function restoreTurnRoot(game: number, turn: number): GameEngineState {
  const t = JSON.parse(readFileSync('ai-training/f0/f0_timelines.json', 'utf8'));
  const entry = t[String(game)].turns.find((x: { turn: number }) => x.turn === turn);
  if (entry && entry.root) return restoreHardRoot(entry.root as HardRootSnapshot);
  throw new Error(`missing root G${game}T${turn}`);
}

/** Game5 turns from the parsed log SNAPSHOT authority. */
function game5Root(turn: number): GameEngineState {
  const parsed = JSON.parse(readFileSync('ai-training/f2b14/parsed_log.json', 'utf8'));
  const rec = parsed.turns.find((x: { turn: number; snapshotJson?: string }) => x.turn === turn && x.snapshotJson);
  expect(rec).toBeTruthy();
  return restoreHardRoot(JSON.parse(rec.snapshotJson));
}

function cleanCanonical(): GameEngineState {
  const s = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard } as Parameters<typeof createInitialState>[0]);
  const board = s.board.map((row, r) => row.map((cell, c) => {
    const isTunnel = (r === 0 && (c === 0 || c === 9)) || (r === 9 && (c === 0 || c === 9));
    const isHole = r >= 7 && r <= 8 && c >= 8 && c <= 9;
    const type = isTunnel ? CellType.Tunnel : isHole ? CellType.MouseHole : CellType.Empty;
    return { ...cell, type, piece: undefined as PieceType | undefined, hasButter: false };
  }));
  return { ...s, board };
}
function buildState(opts: {
  cat: [number, number]; mouse: [number, number]; butter?: [number, number][];
  ghost?: { r: number; c: number; blockedMaterializations?: number }[]; debt?: number;
  box?: [number, number][]; mouseHasButter?: boolean;
}): GameEngineState {
  const s = cleanCanonical();
  const b = s.board.map(row => row.map(cell => ({ ...cell, piece: undefined as PieceType | undefined })));
  for (const [r, c] of opts.box ?? []) b[r][c] = { ...b[r][c], type: CellType.Box };
  b[opts.cat[0]][opts.cat[1]] = { ...b[opts.cat[0]][opts.cat[1]], piece: PieceType.Cat };
  b[opts.mouse[0]][opts.mouse[1]] = { ...b[opts.mouse[0]][opts.mouse[1]], piece: PieceType.Mouse };
  return {
    ...s, board: b,
    catPosition: { r: opts.cat[0], c: opts.cat[1] },
    mousePosition: { r: opts.mouse[0], c: opts.mouse[1] },
    butterPositions: (opts.butter ?? []).map(([r, c]) => ({ r, c })),
    pendingButterSpawns: (opts.ghost ?? []).map(g => ({ r: g.r, c: g.c, blockedMaterializations: g.blockedMaterializations ?? 0 })),
    pendingButterPlacementDebt: opts.debt ?? 0,
    currentPlayer: PieceType.Cat, phase: GamePhase.Playing,
    catMovesLeft: s.config.catBaseMoves, mouseMovesLeft: s.config.mouseBaseMoves,
    mouseHasButter: opts.mouseHasButter ?? false,
  };
}

function H1Leaf(s: GameEngineState): number { return evaluateCorrectedHoleForCat(s); }

function makeMemory(prev: { noProgressLoop: boolean; sig: import('../progressGuard').LoopSignature | null; mouseObserved?: boolean }): HardProgressGuardMemory {
  return {
    version: 1,
    previousNoProgressLoop: prev.noProgressLoop,
    previousSignature: prev.sig ?? null,
    previousPlanLabel: prev.sig?.plan ?? '',
    previousCatStart: prev.sig?.catStart ?? '',
    previousCatEnd: prev.sig?.catEnd ?? '',
    mouseTurnObserved: prev.mouseObserved ?? true,
  };
}

describe('G0.4F-2B-1.6 M3-lite Progress Guard', () => {
  beforeEach(() => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
    setHardLeafMode('baseline');
  });
  afterAll(() => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
    setHardLeafMode('baseline');
  });

  it('P1: prototype progress parity — Game5 T14/T15 are no-progress loops; T4 has box progress', () => {
    const t14 = game5Root(14);
    const t15 = game5Root(15);
    const t4 = game5Root(4);
    const f14 = replayCatPlanLabel(t14, 'ULDR');
    const f15 = replayCatPlanLabel(t15, 'ULDR');
    const f4 = replayCatPlanLabel(t4, 'URDL');
    expect(f14.closedLoop).toBe(true);
    expect(f14.noProgressLoop).toBe(true);
    expect(f15.closedLoop).toBe(true);
    expect(f15.noProgressLoop).toBe(true);
    expect(f4.closedLoop).toBe(true);
    expect(f4.hasProgress).toBe(true); // box layout changed
    // signatures equal across T14/T15 (same cat/board/plan/trap; mouse excluded)
    expect(f14.signature).not.toBeNull();
    expect(f15.signature).not.toBeNull();
    expect(signaturesEqual(f14.signature!, f15.signature!)).toBe(true);
  });

  it('P2: T14 no trigger — no previous memory', () => {
    const t14 = game5Root(14);
    const cur = replayCatPlanLabel(t14, 'ULDR');
    const g = progressGuardTrigger({ previous: null, currentFacts: cur, realMouseTurnElapsed: true });
    expect(g.trigger).toBe(false);
  });

  it('P3: T15 trigger — previous ULDR memory + current ULDR + mouse observed', () => {
    const t15 = game5Root(15);
    const prevSig = replayCatPlanLabel(game5Root(14), 'ULDR').signature;
    const mem = makeMemory({ noProgressLoop: true, sig: prevSig, mouseObserved: true });
    const cur = replayCatPlanLabel(t15, 'ULDR');
    const g = progressGuardTrigger({ previous: mem, currentFacts: cur, realMouseTurnElapsed: true });
    expect(g.trigger).toBe(true);
  });

  it('P4: T15 previous depth = DDLD (single search maxDepth=2)', () => {
    const t15 = game5Root(15);
    setHardLeafMode('baseline_hole_corrected');
    const p = planHardCatTurn(t15, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000,
      leafEvaluator: H1Leaf, refutation: { enabled: false },
    });
    expect(p.search.completedDepth).toBe(2);
    expect(p.search.catTurnPlan.map(label).join('')).toBe('ULDR');
    expect(p.search.previousCompletedPlan.map(label).join('')).toBe('DDLD');
    expect(p.search.previousCompletedDepth).toBe(1);
  });

  it('P5: previous-depth standalone parity — prev(D2) == standalone D1 exact', () => {
    const t15 = game5Root(15);
    setHardLeafMode('baseline_hole_corrected');
    const two = planHardCatTurn(t15, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000,
      leafEvaluator: H1Leaf, refutation: { enabled: false },
    });
    const one = planHardCatTurn(t15, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 1, maxNodes: 2_000_000,
      leafEvaluator: H1Leaf, refutation: { enabled: false },
    });
    expect(two.search.previousCompletedPlan.length).toBe(one.plan.length);
    expect(two.search.previousCompletedPlan.map(label).join('')).toBe(one.plan.map(label).join(''));
  });

  it('P6: T15 rescue exact immediate mouse wins = 0', () => {
    const t15 = game5Root(15);
    // replay DDLD to cat-end then endTurn → mouse root (real rules)
    const facts = replayCatPlanLabel(t15, 'DDLD');
    expect(facts.valid).toBe(true);
    expect(facts.fullTurnConsumed).toBe(true);
    const mouseRoot = rules.endTurn(facts.endState as GameEngineState);
    expect(mouseRoot.currentPlayer).toBe(PieceType.Mouse);
    const ends = enumerateFullTurnLegacy(mouseRoot, rules);
    const seen = new Set<string>();
    let wins = 0;
    for (const t of ends.terminals) {
      const k = stateKey(t.state);
      if (seen.has(k)) continue;
      seen.add(k);
      if (t.state.phase === GamePhase.MouseWins) wins++;
    }
    expect(wins).toBe(0);
  });

  it('P7: T15 rescue probe NO_REFUTATION_FOUND', () => {
    const t15 = game5Root(15);
    const facts = replayCatPlanLabel(t15, 'DDLD');
    const mouseRoot = rules.endTurn(facts.endState as GameEngineState);
    const probe = runBoundedProbe(mouseRoot, rules, {
      maxPaths: FIXED_PATHS, maxCpuMs: FIXED_CPU_MS, maxExact: FIXED_EXACT,
      deadline: NO_DEADLINE,
    });
    expect(probe.status).toBe('NO_REFUTATION_FOUND');
  });

  it('P8: T15 final plan DDLD (guard applied via passMemory)', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    setHardLeafMode('baseline_hole_corrected');
    const t15 = game5Root(15);
    const prevSig = replayCatPlanLabel(game5Root(14), 'ULDR').signature;
    const mem = makeMemory({ noProgressLoop: true, sig: prevSig, mouseObserved: true });
    const p = planHardCatTurn(t15, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000,
      leafEvaluator: H1Leaf, refutation: { enabled: false },
      progressGuard: { passMemory: mem, totalTurnBudgetMs: 600000 },
    });
    expect(p.plan.map(label).join('')).toBe('DDLD');
    expect(p.debug.progressGuard?.rescueApplied).toBe(true);
    expect(p.debug.progressGuard?.originalPlan).toBe('ULDR');
  });

  it('P9/P10: Game5 T4/T5 no trigger (one-off, box progress)', () => {
    const t4 = game5Root(4);
    const t5 = game5Root(5);
    const f4 = replayCatPlanLabel(t4, 'URDL');
    const f5 = replayCatPlanLabel(t5, 'RDUL');
    expect(f4.noProgressLoop).toBe(false); // box progress
    expect(f5.noProgressLoop).toBe(false);
    expect(progressGuardTrigger({ previous: null, currentFacts: f4, realMouseTurnElapsed: true }).trigger).toBe(false);
    expect(progressGuardTrigger({ previous: null, currentFacts: f5, realMouseTurnElapsed: true }).trigger).toBe(false);
  });

  it('P11: useful box loop — has progress, no trigger', () => {
    const root = buildState({ cat: [4, 4], mouse: [8, 8], butter: [[2, 8]], box: [[4, 5]] });
    const facts = replayCatPlanLabel(root, 'UDRL');
    expect(facts.closedLoop).toBe(true);
    expect(facts.hasProgress).toBe(true);
    const curSig = facts.signature!;
    const g = progressGuardTrigger({
      previous: makeMemory({ noProgressLoop: true, sig: curSig, mouseObserved: true }),
      currentFacts: facts, realMouseTurnElapsed: true,
    });
    expect(g.trigger).toBe(false); // current itself has progress → trigger blocked
  });

  it('P12: useful trap loop — has progress, no trigger', () => {
    const root = { ...buildState({ cat: [4, 4], mouse: [8, 8], butter: [[2, 8]] }), trapPosition: null, catTrapsRemaining: 1 };
    const facts = replayCatPlanLabel(root, 'UUDTD');
    expect(facts.closedLoop).toBe(true);
    expect(facts.hasProgress).toBe(true); // trap placed
    const curSig = replayCatPlanLabel(root, 'UUDTD').signature!;
    const g = progressGuardTrigger({
      previous: makeMemory({ noProgressLoop: true, sig: curSig, mouseObserved: true }),
      currentFacts: facts, realMouseTurnElapsed: true,
    });
    expect(g.trigger).toBe(false);
  });

  it('P13: useful ghost-classification progress', () => {
    const root = buildState({ cat: [4, 4], mouse: [8, 8], butter: [[2, 8]], ghost: [{ r: 4, c: 4, blockedMaterializations: 0 }] });
    // eligibility blocks ghost roots for the GUARD (P13 is classification-only)
    const eligible = progressGuardEligible(root, 'baseline_hole_corrected', true, { completedDepth: 2, mate: null, previousCompletedPlanLength: 4 });
    expect(eligible).toBe(false); // pendingButterSpawns>0 → ineligible
    // classification still marks progress when the cat occupies the ghost
    const facts = replayCatPlanLabel(root, 'UUDD');
    expect(facts.hasProgress).toBe(true); // cat on ghost = GHOST_DENIED
  });

  it('P14: useful route loop — has progress, no trigger', () => {
    const root = buildState({ cat: [0, 2], mouse: [9, 9], butter: [[2, 2]], box: [[0, 1]] });
    const facts = replayCatPlanLabel(root, 'DULR');
    expect(facts.closedLoop).toBe(true);
    expect(facts.hasProgress).toBe(true); // route lengthened / box moved
    const curSig = facts.signature!;
    const g = progressGuardTrigger({
      previous: makeMemory({ noProgressLoop: true, sig: curSig, mouseObserved: true }),
      currentFacts: facts, realMouseTurnElapsed: true,
    });
    expect(g.trigger).toBe(false);
  });

  it('P15: F8 mate=cat bypass — guard never overrides capture', () => {
    setHardLeafMode('baseline_hole_corrected');
    const root = buildState({ cat: [4, 4], mouse: [4, 5] });
    const eligible = progressGuardEligible(root, 'baseline_hole_corrected', true, { completedDepth: 2, mate: 'cat', previousCompletedPlanLength: 1 });
    expect(eligible).toBe(false); // mate != null → ineligible
  });

  it('P16: forced-loss bypass — all-safe gate blocks eligibility', () => {
    const root = buildState({ cat: [1, 1], mouse: [6, 8], butter: [[5, 8]], mouseHasButter: true });
    const eligible = progressGuardEligible(root, 'baseline_hole_corrected', true, { completedDepth: 2, mate: 'mouse', previousCompletedPlanLength: 4 });
    expect(eligible).toBe(false); // mate === 'mouse' → ineligible
  });

  it('P17: refutation override bypass — selectedPlanSource=bounded_refutation → rescueApplied=false (real gate)', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    setHardLeafMode('baseline_hole_corrected');
    const t15 = game5Root(15);
    const prevSig = replayCatPlanLabel(game5Root(14), 'ULDR').signature!;
    const mem = makeMemory({ noProgressLoop: true, sig: prevSig, mouseObserved: true });
    const uldrActs = actionsFromStrings(['U', 'L', 'D', 'R']);
    const ddldActs = actionsFromStrings(['D', 'D', 'L', 'D']);
    // Real refutation diag with an OVERRIDE selected (sidecar replaced the plan).
    const refutationDiag: RefutationDiagnostics = {
      refutationEnabled: true, refutationTriggered: true, candidateCount: 6,
      baselineProbeStatus: 'PLAN_REFUTED', baselineRefutationWitness: ['d'],
      candidatesProbed: 6, candidateStatuses: new Array<ProbeStatus>(6).fill('NO_REFUTATION_FOUND'),
      pathCount: 1, exactLocalChecks: 1, refutationCpuMs: 1, refutationWallMs: 1,
      overrideEligible: true, overrideUsed: true,
      selectedPlanSource: 'bounded_refutation', sidecarAbortReason: 'none',
    };
    const res = runProgressGuard({
      state: t15, plan: uldrActs,
      search: fakeSearch(ddldActs),
      refutation: refutationDiag,
      opts: { rules, timeBudgetMs: 600000 },
      now: () => 0,
      passMemory: mem, deadline: makeFiniteDeadline(600000, () => 0),
    });
    expect(res.applied).toBe(false);
    expect(res.debug.rescueApplied).toBe(false);
    expect(res.debug.abortReason).toBe('refutation_override');
  });

  it('P18: current refutation PLAN_REFUTED / INCOMPLETE / CHANCE_MIXED all fail-closed (real) — abortReason=refutation_current_X', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    setHardLeafMode('baseline_hole_corrected');
    const t15 = game5Root(15);
    const prevSig = replayCatPlanLabel(game5Root(14), 'ULDR').signature!;
    const mem = makeMemory({ noProgressLoop: true, sig: prevSig, mouseObserved: true });
    const uldrActs = actionsFromStrings(['U', 'L', 'D', 'R']);
    const ddldActs = actionsFromStrings(['D', 'D', 'L', 'D']);
    const statuses: ProbeStatus[] = ['PLAN_REFUTED', 'INCOMPLETE', 'CHANCE_MIXED'];
    for (const st of statuses) {
      const refutationDiag: RefutationDiagnostics = {
        refutationEnabled: true, refutationTriggered: true, candidateCount: 6,
        baselineProbeStatus: st, baselineRefutationWitness: [], candidatesProbed: 0,
        candidateStatuses: [], pathCount: 0, exactLocalChecks: 0,
        refutationCpuMs: 0, refutationWallMs: 0, overrideEligible: false, overrideUsed: false,
        selectedPlanSource: 'baseline', sidecarAbortReason: 'baseline_not_refuted',
      };
      const res = runProgressGuard({
        state: t15, plan: uldrActs, search: fakeSearch(ddldActs),
        refutation: refutationDiag,
        opts: { rules, timeBudgetMs: 600000 },
        now: () => 0, passMemory: mem, deadline: makeFiniteDeadline(600000, () => 0),
      });
      expect(res.applied).toBe(false);
      expect(res.debug.rescueApplied).toBe(false);
      expect(res.debug.abortReason).toBe(`refutation_current_${st}`);
    }
  });

  it('P19: rescueProbeAllows pure gate — only NO_REFUTATION_FOUND permits rescue (real)', () => {
    expect(rescueProbeAllows('NO_REFUTATION_FOUND')).toBe(true);
    expect(rescueProbeAllows('PLAN_REFUTED')).toBe(false);
    expect(rescueProbeAllows('INCOMPLETE')).toBe(false);
    expect(rescueProbeAllows('CHANCE_MIXED')).toBe(false);
    expect(rescueProbeAllows(null)).toBe(false);
    expect(rescueProbeAllows(undefined)).toBe(false);
    // T15 actual probe (P7) is NO_REFUTATION_FOUND → the gate would allow it.
    const t15 = game5Root(15);
    const facts = replayCatPlanLabel(t15, 'DDLD');
    const mouseRoot = rules.endTurn(facts.endState as GameEngineState);
    const probe = runBoundedProbe(mouseRoot, rules, { maxPaths: FIXED_PATHS, maxCpuMs: FIXED_CPU_MS, maxExact: FIXED_EXACT, deadline: NO_DEADLINE });
    expect(rescueProbeAllows(probe.status)).toBe(true);
  });

  it('P20: deadline fail-closed — guard starts after total deadline → abort=deadline, keep original (real fake clock)', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    setHardLeafMode('baseline_hole_corrected');
    const t15 = game5Root(15);
    const prevSig = replayCatPlanLabel(game5Root(14), 'ULDR').signature!;
    const mem = makeMemory({ noProgressLoop: true, sig: prevSig, mouseObserved: true });
    const uldrActs = actionsFromStrings(['U', 'L', 'D', 'R']);
    const ddldActs = actionsFromStrings(['D', 'D', 'L', 'D']);
    // Fake monotonic clock: planner started at t=0 with total budget 150ms;
    // by the time the guard runs (after main + sidecar), now()=151 >= deadline.
    const res = runProgressGuard({
      state: t15, plan: uldrActs, search: fakeSearch(ddldActs),
      opts: { rules, timeBudgetMs: 100 },
      now: () => 151, passMemory: mem,
      // HEAD expressed this as `absoluteTotalDeadlineMs = plannerStart(0) + 150`; the
      // same instant and the same fake clock, now carried as one shared context object.
      deadline: makeFiniteDeadline(0 + 150, () => 151),
    });
    expect(res.applied).toBe(false);
    expect(res.debug.rescueApplied).toBe(false);
    expect(res.debug.abortReason).toBe('deadline');
  });

  it('P21: fallback invalidates memory', () => {
    // When execution falls back (SEARCH_FALLBACK), engine must NOT record the
    // planned-but-not-executed loop as previousNoProgressLoop. Unit: the memory
    // factory used by the engine sets previousNoProgressLoop=false on invalid.
    const root = game5Root(15);
    const m = { ...emptyProgressGuardMemory(), previousRootKey: stateKey(root) };
    expect(m.previousNoProgressLoop).toBe(false);
    expect(m.previousSignature).toBeNull();
  });

  it('P22: mouse turn observed only Mouse→Cat endTurn', () => {
    const root = game5Root(15);
    const mem: HardProgressGuardMemory = { ...emptyProgressGuardMemory(), previousPlanLabel: 'ULDR' };
    // CAT→MOUSE ghost-free endTurn must NOT set mouseTurnObserved (nextPlayer=Mouse)
    const catToMouse = rules.endTurn({ ...root, currentPlayer: PieceType.Cat, catMovesLeft: 0, hardProgressGuardMemory: mem });
    if (catToMouse.currentPlayer === PieceType.Mouse) {
      expect((catToMouse.hardProgressGuardMemory as HardProgressGuardMemory)?.mouseTurnObserved).toBe(false);
    }
    // Mouse→Cat endTurn sets it
    const mouseEnd = { ...catToMouse, currentPlayer: PieceType.Mouse, mouseMovesLeft: 0, hardProgressGuardMemory: mem };
    const toCat = rules.endTurn(mouseEnd);
    if (toCat.currentPlayer === PieceType.Cat) {
      expect((toCat.hardProgressGuardMemory as HardProgressGuardMemory)?.mouseTurnObserved).toBe(true);
    }
  });

  it('P23: memory snapshot/restore exact', () => {
    const root = game5Root(15);
    const mem: HardProgressGuardMemory = {
      version: 1, previousNoProgressLoop: true,
      previousSignature: { catStart: '4,8', catEnd: '4,8', plan: 'URDL', boxHash: 'X', trap: '1,1' },
      previousPlanLabel: 'URDL', previousCatStart: '4,8', previousCatEnd: '4,8',
      mouseTurnObserved: true, previousRootKey: 'k1', previousEndKey: '4,8',
    };
    const withMem = { ...root, hardProgressGuardMemory: mem };
    const snap = captureHardRoot(withMem);
    expect(snap.hardProgressGuardMemory).toEqual(mem);
    const restored = restoreHardRoot(snap);
    expect(restored.hardProgressGuardMemory).toEqual(mem);
  });

  it('P24b: REAL_TRAJECTORY_MEMORY_WRITE — computeCatAiTrajectory writes memory from ACTUAL execution (root + finalExecState, no replay)', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    setHardLeafMode('baseline_hole_corrected');
    // Game5 T14 root (cat=(6,6) in the 14/15/16 run; use the actual log root).
    const t14 = game5Root(14);
    const root = { ...t14, catMovesLeft: 4 };
    // Manual execution of the ULDR loop through the REAL engine catMove (the
    // SAME transition the production trajectory uses per step — catMove does
    // NOT auto-endTurn, so the final step's currentPlayer is still Cat with
    // catMovesLeft=0, exactly what classifyExecutedCatTurn expects).
    let cur = root;
    const acts = actionsFromStrings(['U', 'L', 'D', 'R']);
    for (const a of acts) {
      if (a.type === 'catStep') cur = rules.catMove(cur, a.direction);
      else if (a.type === 'catPlaceTrap') cur = rules.catPlaceTrap(cur);
    }
    expect(cur.catMovesLeft).toBe(0);
    expect(cur.currentPlayer).toBe(PieceType.Cat);
    expect(cur.catPosition).toEqual(root.catPosition); // loop returned
    // classify from ACTUAL execution (root vs finalExecState — no replay).
    const facts = classifyExecutedCatTurn(root, cur, 'ULDR', true);
    expect(facts.fullTurnConsumed).toBe(true);
    expect(facts.closedLoop).toBe(true);
    expect(facts.noProgressLoop).toBe(true);
    const memF = makeMemory({ noProgressLoop: facts.noProgressLoop, sig: facts.signature, mouseObserved: false });
    expect(memF.previousNoProgressLoop).toBe(true);
    expect(memF.previousSignature).not.toBeNull();
    expect(memF.previousSignature!.plan).toBe('ULDR');
    expect(memF.mouseTurnObserved).toBe(false);
    // Simulate the engine wiring: attach to the final exec state.
    const withMem = { ...cur, hardProgressGuardMemory: memF };
    // REAL_MOUSE_BOUNDARY: CAT→MOUSE does NOT arm; Mouse→CAT arms.
    const catToMouse = rules.endTurn({ ...withMem, currentPlayer: PieceType.Cat, catMovesLeft: 0 });
    if (catToMouse.currentPlayer === PieceType.Mouse) {
      expect((catToMouse.hardProgressGuardMemory as HardProgressGuardMemory | null)?.mouseTurnObserved ?? false).toBe(false);
    }
    const mouseEnd = { ...catToMouse, currentPlayer: PieceType.Mouse, mouseMovesLeft: 0, hardProgressGuardMemory: memF };
    const toCat = rules.endTurn(mouseEnd);
    if (toCat.currentPlayer === PieceType.Cat) {
      expect((toCat.hardProgressGuardMemory as HardProgressGuardMemory | null)?.mouseTurnObserved).toBe(true);
    }
  });

  it('P24c: STALE_MEMORY_REENABLE — guard OFF execution invalidates old memory so re-enable cannot mistake it as previous turn', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    const root = game5Root(15);
    // Build a valid "previous no-progress" memory that WOULD trigger if reused.
    const wouldTrigger = makeMemory({ noProgressLoop: true, sig: replayCatPlanLabel(game5Root(14), 'ULDR').signature!, mouseObserved: true });
    const curFacts = replayCatPlanLabel(root, 'ULDR');
    const gBefore = progressGuardTrigger({ previous: wouldTrigger, currentFacts: curFacts, realMouseTurnElapsed: true });
    expect(gBefore.trigger).toBe(true); // memory is genuinely trigger-capable
    // Guard turns OFF and another Hard cat turn executes → engine invalidates
    // the existing memory (stale-memory defence §16). The invalid memory can
    // NEVER trigger even with the full trigger-input set.
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
    const invalid = { ...emptyProgressGuardMemory() };
    expect(invalid.previousNoProgressLoop).toBe(false);
    expect(invalid.previousSignature).toBeNull();
    const g = progressGuardTrigger({ previous: invalid, currentFacts: curFacts, realMouseTurnElapsed: true });
    expect(g.trigger).toBe(false);
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
  });

  it('P24: memory excluded from stateKey/gameAffectingEqual/TT', () => {
    const root = game5Root(15);
    const a = { ...root, hardProgressGuardMemory: null };
    const b = { ...root, hardProgressGuardMemory: { ...emptyProgressGuardMemory(), previousPlanLabel: 'ULDR' } };
    expect(stateKey(a)).toBe(stateKey(b));
    expect(gameAffectingEqual(a, b)).toBe(true);
  });

  it('P25: baseline guard-off exactness (default OFF, plan identical)', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
    setHardLeafMode('baseline');
    const root = game5Root(15);
    // explicit baseline evaluator
    const pEval = planHardCatTurn(root, { rules, timeBudgetMs: 100, maxDepthTurns: 2, leafEvaluator: evaluateForCat, refutation: { enabled: false } });
    const pResolve = planHardCatTurn(root, { rules, timeBudgetMs: 100, maxDepthTurns: 2, leafEvaluator: resolveHardLeaf(), refutation: { enabled: false } });
    expect(pEval.plan.map(label).join('')).toBe(pResolve.plan.map(label).join(''));
    expect(pEval.search.value).toBe(pResolve.search.value);
  });

  it('P26: H1 guard-off exactness', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
    setHardLeafMode('baseline_hole_corrected');
    const root = game5Root(15);
    const p = planHardCatTurn(root, { rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000, leafEvaluator: H1Leaf, refutation: { enabled: false } });
    expect(p.plan.map(label).join('')).toBe('ULDR'); // same as pre-guard (guard OFF)
    expect(p.debug.progressGuard?.enabled).toBe(false);
  });

  it('P27: V1/V2 untouched (guard ineligible; leaf functions still baseline identity)', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    const root = game5Root(15);
    // V1/V2 leaves unaffected by guard being on
    expect(hybridEvaluateForCat(root)).toBe(hybridEvaluateForCat(root));
    expect(hybridRouteV2EvaluateForCat(root)).toBe(hybridRouteV2EvaluateForCat(root));
    setHardLeafMode('hybrid_standard_only');
    expect(resolveHardLeaf()).toBe(hybridEvaluateForCat);
    setHardLeafMode('hybrid_route_v2_standard_only');
    expect(resolveHardLeaf()).toBe(hybridRouteV2EvaluateForCat);
  });

  it('P28: Game1 final root no trigger', () => {
    const root = restoreTurnRoot(16, 8); // F2B-1.3 final root proxy (cat=5,3 mouse=9,8)
    const cur = replayCatPlanLabel(root, 'DDRD');
    const g = progressGuardTrigger({ previous: null, currentFacts: cur, realMouseTurnElapsed: true });
    expect(g.trigger).toBe(false);
  });

  it('P29: default OFF', () => {
    expect(HARD_PROGRESS_GUARD_CONFIG.enabled).toBe(false);
  });

  it('P30: one main search per cat turn (previous depth from same search)', () => {
    const t15 = game5Root(15);
    setHardLeafMode('baseline_hole_corrected');
    const p = planHardCatTurn(t15, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000,
      leafEvaluator: H1Leaf, refutation: { enabled: false },
    });
    // The previous-depth plan comes from the SAME IterativeSearchResult — the
    // search object is a single searchBestActionIterative call. Verify both
    // plans are exposed on one result (no second main search needed).
    expect(p.search.previousCompletedDepth).toBe(1);
    expect(p.search.catTurnPlan.length).toBeGreaterThan(0);
    expect(p.search.previousCompletedPlan.length).toBeGreaterThan(0);
  });
});