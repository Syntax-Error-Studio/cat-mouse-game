import { test, expect, vi } from 'vitest';
import type { GameEngineState } from '../../engine';
import { createInitialState } from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import {
  evaluateForCat,
  evaluateForCatDetailed,
  extractEvaluationFeatures,
  HEURISTIC_LIMIT,
  buildMouseDistanceMap,
  buildCatDistanceMap,
  bfsMouseDistance,
  bfsCatDistance,
  resetEvaluationCalls,
  getEvaluationCalls,
  getMouseBfsCalls,
  getCatBfsCalls,
  getCarryMouseBfsCalls,
  DEFAULT_EVALUATION_WEIGHTS,
} from '../evaluation';
import {
  defaultLeafEval,
  createSearchContext,
  searchBestAction,
  MATE_SCORE,
} from '../expectiminimax';
import { defaultRuleSet } from '../searchRules';
import { EVALUATION_CORPUS } from './evaluationCorpus';
import type { RuleSet } from '../searchTypes';

const BIG = 1_000_000;

// Local (mirrors expectiminimax.test.ts): a RuleSet with trap placement disabled
// so the search cannot win via trap — keeps the E0-L sanity check deterministic.
const noTrapRuleSet: RuleSet = { ...defaultRuleSet, catPlaceTrap: (st) => st };

// --- mirrored helpers ---
const RC = (r: number, c: number) => ({ r, c });

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
      { r: 0, c: 0 },
      { r: 0, c: 9 },
      { r: 9, c: 0 },
      { r: 9, c: 9 },
    ],
    ...overrides,
  };
}

// NOTE: the evaluators read `state.mousePosition` / `state.catPosition` and the
// board *cell types* — never `cell.piece` — so we only need to (re)set the
// positions here. This also sidesteps the cell `piece` field typing.
function setPieces(state: GameEngineState, mouse: { r: number; c: number }, cat?: { r: number; c: number }): GameEngineState {
  const patch: Partial<GameEngineState> = { mousePosition: { ...mouse } };
  if (cat) patch.catPosition = { ...cat };
  return { ...state, ...patch };
}

function wallOff(state: GameEngineState, open: { r: number; c: number }[]): GameEngineState {
  const openSet = new Set(open.map((p) => `${p.r},${p.c}`));
  const board = state.board.map((row, r) =>
    row.map((cell, c) => {
      const special = cell.type === CellType.MouseHole || cell.type === CellType.Tunnel;
      if (special) return cell;
      if (openSet.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

function blockTunnel(s: GameEngineState, rc: { r: number; c: number }): GameEngineState {
  const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
  board[rc.r][rc.c] = { ...board[rc.r][rc.c], type: CellType.Box, piece: undefined };
  return { ...s, board, blockedTunnels: [...s.blockedTunnels, { r: rc.r, c: rc.c }] };
}

function base(opts: {
  cat: { r: number; c: number };
  mouse: { r: number; c: number };
  open?: { r: number; c: number }[];
  overrides?: Partial<GameConfig>;
  patch?: (s: GameEngineState) => GameEngineState;
}): GameEngineState {
  let s = createInitialState(cleanConfig(opts.overrides));
  s = setPieces(s, opts.mouse, opts.cat);
  if (opts.open) s = wallOff(s, opts.open);
  s = {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
    mouseSkillActive: false,
    trapPosition: null,
    catTrapsRemaining: 1,
    blockedTunnels: [],
  };
  if (opts.patch) s = opts.patch(s);
  return s;
}

const ALL_OPEN: { r: number; c: number }[] = [];
for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) ALL_OPEN.push({ r, c });

/** deepFreeze (mirrors the one used in expectiminimax.test.ts). */
function recursiveDeepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o as unknown as Record<string, unknown>)) {
      recursiveDeepFreeze((o as unknown as Record<string, unknown>)[k]);
    }
    Object.freeze(o);
  }
  return o;
}

// ===========================================================================
// E0-A. Evaluator purity
// ===========================================================================
test('E0-A. evaluateForCat / Detailed is pure and deterministic', () => {
  const s = base({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 }, open: ALL_OPEN });

  // No RNG / clock use while evaluating.
  const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => 0.5);
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => 0);

  const first = evaluateForCatDetailed(s);
  const second = evaluateForCatDetailed(structuredClone(s));
  expect(first.total).toBe(second.total);
  expect(first.features).toEqual(second.features);
  expect(first.contributions).toEqual(second.contributions);
  expect(randomSpy).not.toHaveBeenCalled();
  expect(nowSpy).not.toHaveBeenCalled();

  randomSpy.mockRestore();
  nowSpy.mockRestore();

  // diagnostics counter (spec #20): increments per call, never affects value.
  resetEvaluationCalls();
  expect(getEvaluationCalls()).toBe(0);
  evaluateForCat(s);
  evaluateForCat(s);
  expect(getEvaluationCalls()).toBe(2);

  // Input is not mutated by evaluation.
  const before = structuredClone(s);
  evaluateForCat(s);
  evaluateForCatDetailed(s);
  expect(s).toEqual(before);

  // Frozen input does not throw (read-only access only).
  const frozen = recursiveDeepFreeze(structuredClone(s));
  expect(() => evaluateForCatDetailed(frozen)).not.toThrow();
});

// ===========================================================================
// E0-B. Heuristic bounded below the mate region
// ===========================================================================
test('E0-B. heuristic total is clamped far below MATE_SCORE', () => {
  expect(HEURISTIC_LIMIT).toBeLessThan(MATE_SCORE - 1000);
  for (const c of EVALUATION_CORPUS) {
    const v = evaluateForCat(c.state);
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(HEURISTIC_LIMIT);
  }
  // A deliberately extreme confinement still cannot escape the clamp.
  const extreme = base({
    cat: { r: 1, c: 1 },
    mouse: { r: 8, c: 8 },
    open: ALL_OPEN,
    patch: (s) => blockTunnel(blockTunnel(blockTunnel(blockTunnel(s, RC(0, 0)), RC(0, 9)), RC(9, 0)), RC(9, 9)),
  });
  const b = evaluateForCatDetailed(extreme);
  expect(Math.abs(b.total)).toBeLessThanOrEqual(HEURISTIC_LIMIT);
  // The clamp flag may or may not trip; the bound always holds.
  expect(Math.abs(b.total)).toBeLessThan(MATE_SCORE - 1000);
});

// ===========================================================================
// E0-C. Mouse distance respects obstacles + tunnel-as-edge
// ===========================================================================
test('E0-C. mouse BFS: reachable, blocked→null, tunnel route', () => {
  // Reachable via normal steps.
  const s1 = base({ cat: { r: 4, c: 4 }, mouse: { r: 1, c: 1 }, open: ALL_OPEN });
  expect(bfsMouseDistance(s1, [RC(1, 4)])).toBe(3); // (1,1)→(1,2)→(1,3)→(1,4)
  expect(buildMouseDistanceMap(s1).get('1,4')).toBe(3);

  // Unreachable: target walled off.
  const s2 = base({
    cat: { r: 4, c: 4 },
    mouse: { r: 1, c: 1 },
    open: [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 2, c: 1 }],
  });
  expect(bfsMouseDistance(s2, [RC(5, 5)])).toBeNull();

  // Tunnel route: (1,1)→(0,1)→(0,0) then teleport to (9,9) = 3 steps,
  // far shorter than going around the walled board.
  const s3 = base({
    cat: { r: 4, c: 4 },
    mouse: { r: 1, c: 1 },
    open: [{ r: 1, c: 1 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 0, c: 0 }, { r: 9, c: 9 }],
  });
  expect(bfsMouseDistance(s3, [RC(9, 9)])).toBe(3);
});

// ===========================================================================
// E0-D. Cat distance respects forbidden cells (hole / tunnel / butter)
// ===========================================================================
test('E0-D. cat BFS excludes hole, tunnel, and butter cells', () => {
  // Butter + tunnel corner adjacent to the cat → excluded from the map.
  const s1 = base({
    cat: { r: 1, c: 1 },
    mouse: { r: 4, c: 4 },
    open: [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 2, c: 1 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 0, c: 0 }],
    patch: (st) => ({ ...st, butterPositions: [RC(1, 2)] }),
  });
  const catMap1 = buildCatDistanceMap(s1);
  expect(catMap1.has('1,2')).toBe(false); // butter excluded
  expect(catMap1.has('0,0')).toBe(false); // tunnel corner excluded
  expect(catMap1.has('2,1')).toBe(true); // normal empty cell included
  expect(catMap1.has('0,1')).toBe(true); // normal empty cell included
  expect(bfsCatDistance(s1, [RC(1, 2)])).toBeNull(); // can't enter butter

  // Hole adjacent to the cat → excluded.
  const s2 = base({
    cat: { r: 7, c: 7 },
    mouse: { r: 1, c: 1 },
    open: [{ r: 7, c: 7 }, { r: 6, c: 7 }, { r: 7, c: 6 }, { r: 6, c: 6 }],
  });
  const catMap2 = buildCatDistanceMap(s2);
  expect(catMap2.has('7,8')).toBe(false); // mouse-hole cell excluded
});

// ===========================================================================
// E0-E. Carrying butter forbids tunnel use
// ===========================================================================
test('E0-E. mouseCanReachTunnel respects the butter rule', () => {
  // No butter → tunnel usable and reachable.
  const open = [{ r: 1, c: 1 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 0, c: 0 }, { r: 2, c: 5 }, { r: 1, c: 5 }];
  const noButter = base({ cat: { r: 2, c: 5 }, mouse: { r: 1, c: 1 }, open });
  expect(extractEvaluationFeatures(noButter).mouseCanReachTunnel).toBe(true);
  expect(extractEvaluationFeatures(noButter).mouseTunnelAllowed).toBe(true);

  // Carrying butter → tunnel forbidden.
  const carry = base({ cat: { r: 2, c: 5 }, mouse: { r: 1, c: 1 }, open, patch: (s) => ({ ...s, mouseHasButter: true }) });
  const fCarry = extractEvaluationFeatures(carry);
  expect(fCarry.mouseHasButter).toBe(true);
  expect(fCarry.mouseTunnelAllowed).toBe(false);
  expect(fCarry.mouseCanReachTunnel).toBe(false);
  expect(fCarry.mouseTunnelAccessDistance).toBeNull();

  // Skill active (butter consumed) → tunnel usable again.
  const skill = base({ cat: { r: 2, c: 5 }, mouse: { r: 1, c: 1 }, open, patch: (s) => ({ ...s, mouseHasButter: false, mouseSkillActive: true }) });
  expect(extractEvaluationFeatures(skill).mouseTunnelAllowed).toBe(true);
  expect(extractEvaluationFeatures(skill).mouseCanReachTunnel).toBe(true);
});

// ===========================================================================
// E0-F. Blocked tunnel accounting
// ===========================================================================
test('E0-F. open / blocked tunnel counts', () => {
  const open = base({ cat: { r: 4, c: 4 }, mouse: { r: 1, c: 1 }, open: ALL_OPEN });
  const fOpen = extractEvaluationFeatures(open);
  expect(fOpen.openTunnelCount).toBe(4);
  expect(fOpen.blockedTunnelCount).toBe(0);
  expect(fOpen.mouseCanReachTunnel).toBe(true);

  let blocked = open;
  for (const corner of [
    RC(0, 0), RC(0, 9), RC(9, 0), RC(9, 9),
  ]) blocked = blockTunnel(blocked, corner);
  const fBlocked = extractEvaluationFeatures(blocked);
  expect(fBlocked.openTunnelCount).toBe(0);
  expect(fBlocked.blockedTunnelCount).toBe(4);
  expect(fBlocked.mouseTunnelAllowed).toBe(false);
  expect(fBlocked.mouseCanReachTunnel).toBe(false);
  expect(fBlocked.mouseTunnelAccessDistance).toBeNull();
});

// ===========================================================================
// E0-G. Mouse-hole goal semantics
// ===========================================================================
test('E0-G. mouseGoalDistance only meaningful when carrying butter', () => {
  const carry = base({ cat: { r: 8, c: 7 }, mouse: { r: 7, c: 7 }, open: [{ r: 7, c: 7 }, { r: 8, c: 7 }, { r: 7, c: 8 }, { r: 8, c: 8 }, { r: 6, c: 7 }, { r: 7, c: 6 }, { r: 8, c: 6 }, { r: 6, c: 8 }], patch: (s) => ({ ...s, mouseHasButter: true }) });
  const fCarry = extractEvaluationFeatures(carry);
  expect(fCarry.mouseHasButter).toBe(true);
  expect(fCarry.mouseGoalDistance).toBe(1); // 1 step to the hole = real win threat

  const noButter = base({ cat: { r: 8, c: 7 }, mouse: { r: 7, c: 7 }, open: [{ r: 7, c: 7 }, { r: 8, c: 7 }, { r: 7, c: 8 }, { r: 8, c: 8 }, { r: 6, c: 7 }, { r: 7, c: 6 }, { r: 8, c: 6 }, { r: 6, c: 8 }] });
  const fNo = extractEvaluationFeatures(noButter);
  expect(fNo.mouseHasButter).toBe(false);
  expect(fNo.mouseGoalDistance).toBeNull(); // without butter, reaching hole ≠ win
});

// ===========================================================================
// E0-H. Mobility / reachable area
// ===========================================================================
test('E0-H. mobility and reachable-area features', () => {
  const open = base({ cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 }, open: ALL_OPEN });
  const fOpen = extractEvaluationFeatures(open);
  expect(fOpen.mouseReachableArea).toBeGreaterThan(10);
  expect(fOpen.mouseMobility).toBeGreaterThanOrEqual(2);
  expect(fOpen.catMobility).toBeGreaterThanOrEqual(2);

  const confined = base({ cat: { r: 5, c: 5 }, mouse: { r: 2, c: 2 }, open: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }] });
  const fConf = extractEvaluationFeatures(confined);
  expect(fConf.mouseReachableArea).toBeLessThan(6);
  expect(fConf.mouseReachableArea).toBeLessThan(fOpen.mouseReachableArea);
});

// ===========================================================================
// E0-I. Board-size normalization
// ===========================================================================
test('E0-I. evaluator is board-size aware (5x5 vs 20x20)', () => {
  const makeOpen = (n: number) => {
    const cells: { r: number; c: number }[] = [];
    for (let r = 1; r < n - 1; r++) for (let c = 1; c < n - 1; c++) cells.push({ r, c });
    return cells;
  };
  const cfg5 = {
    boardSize: 5,
    mouseHole: { r: 0, c: 0, size: 1 } as { r: number; c: number; size: number },
    tunnelCorners: [RC(0, 0), RC(0, 4), RC(4, 0), RC(4, 4)],
    mouseStart: RC(2, 2),
    catStart: RC(1, 1),
  } as Partial<GameConfig>;
  const cfg20 = {
    boardSize: 20,
    mouseHole: { r: 0, c: 0, size: 1 } as { r: number; c: number; size: number },
    tunnelCorners: [RC(0, 0), RC(0, 19), RC(19, 0), RC(19, 19)],
    mouseStart: RC(9, 9),
    catStart: RC(1, 1),
  } as Partial<GameConfig>;

  const s5 = base({ cat: RC(2, 1), mouse: RC(2, 2), open: makeOpen(5), overrides: cfg5 });
  const s20 = base({ cat: RC(9, 8), mouse: RC(9, 9), open: makeOpen(20), overrides: cfg20 });

  const v5 = evaluateForCat(s5);
  const v20 = evaluateForCat(s20);
  for (const v of [v5, v20]) {
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(HEURISTIC_LIMIT);
  }
  // Same relative open fraction → 20x20 yields a far larger raw area.
  expect(extractEvaluationFeatures(s20).mouseReachableArea).toBeGreaterThan(
    extractEvaluationFeatures(s5).mouseReachableArea,
  );
});

// ===========================================================================
// E0-J. Non-game fields do not affect evaluation
// ===========================================================================
test('E0-J. message / logs / debug fields are evaluation-invariant', () => {
  const s = base({ cat: { r: 4, c: 4 }, mouse: { r: 6, c: 6 }, open: ALL_OPEN });
  const baseline = evaluateForCat(s);

  const mutated = structuredClone(s);
  mutated.message = 'totally different message';
  mutated.catActionLog = ['x', 'y', 'z'];
  mutated.gameEventLog = ['a', 'b'];
  mutated.tunnelExitChoices = [{ r: 0, c: 0, label: 'x' }];

  expect(evaluateForCat(mutated)).toBe(baseline);

  const detailed = evaluateForCatDetailed(mutated);
  const detailedBase = evaluateForCatDetailed(structuredClone(s));
  expect(detailed.features).toEqual(detailedBase.features);
});

// ===========================================================================
// E0-K. Corpus fixture validity + rule expectations
// ===========================================================================
test('E0-K. corpus states are valid and RULE expectations hold', () => {
  const scores = new Map<string, number>();
  for (const c of EVALUATION_CORPUS) scores.set(c.name, evaluateForCat(c.state));

  let ruleChecks = 0;
  let rulePass = 0;
  let hardStrategicChecks = 0;
  let hardStrategicPass = 0;
  let softStrategicChecks = 0;
  let softStrategicPass = 0;
  let observations = 0;

  for (const c of EVALUATION_CORPUS) {
    // --- validity ---
    const s = c.state;
    const n = s.config.boardSize;
    expect(['cat', 'mouse'].includes(s.currentPlayer === PieceType.Cat ? 'cat' : 'mouse')).toBe(true);
    for (const p of [s.catPosition, s.mousePosition]) {
      expect(p.r >= 0 && p.r < n && p.c >= 0 && p.c < n).toBe(true);
    }
    const catCell = s.board[s.catPosition.r][s.catPosition.c];
    const mouseCell = s.board[s.mousePosition.r][s.mousePosition.c];
    const blocked: CellType[] = [CellType.Wall, CellType.Pile, CellType.Void];
    expect(blocked.includes(catCell.type)).toBe(false);
    expect(blocked.includes(mouseCell.type)).toBe(false);
    if (s.trapPosition) {
      expect(s.trapPosition.r >= 0 && s.trapPosition.r < n && s.trapPosition.c >= 0 && s.trapPosition.c < n).toBe(true);
    }

    // --- evaluate + check expectations ---
    const b = evaluateForCatDetailed(s);
    for (const e of c.expectations) {
      if (e.type === 'rule') {
        ruleChecks++;
        const ok = e.assert(b, s);
        if (ok) rulePass++;
        expect(ok, `RULE failed [${c.name}]: ${e.description}`).toBe(true);
      } else if (e.type === 'strategic') {
        const mine = scores.get(c.name)!;
        let ok = true;
        for (const other of e.betterThan ?? []) {
          if (!(mine > (scores.get(other) ?? -Infinity))) ok = false;
        }
        for (const other of e.worseThan ?? []) {
          if (!(mine < (scores.get(other) ?? Infinity))) ok = false;
        }
        if (e.confidence === 'hard') {
          hardStrategicChecks++;
          if (ok) hardStrategicPass++;
          expect(ok, `HARD STRATEGIC failed [${c.name}]: ${e.description}`).toBe(true);
        } else {
          softStrategicChecks++;
          if (ok) softStrategicPass++;
          if (!ok) console.warn(`SOFT STRATEGIC mismatch [${c.name}]: ${e.description}`);
        }
      } else {
        observations++;
      }
    }
  }

  // Report summary (does not fail the suite).
  console.log(
    `CORPUS summary: ${EVALUATION_CORPUS.length} cases | rule ${rulePass}/${ruleChecks} | hard ${hardStrategicPass}/${hardStrategicChecks} | soft ${softStrategicPass}/${softStrategicChecks} | observations ${observations}`,
  );
  expect(rulePass).toBe(ruleChecks); // hard gate: all RULE invariants must hold
  expect(hardStrategicPass).toBe(hardStrategicChecks); // E1 gate: hard strategic 100%
});

// ===========================================================================
// E0-L. Existing 110-test regression (search baseline untouched — spec #22)
// ===========================================================================
test('E0-L. search still uses unchanged defaultLeafEval (AI answers unchanged)', () => {
  // The live search leaf evaluator is defaultLeafEval (manhattan-based), NOT
  // the new evaluateForCat. Prove it is byte-for-byte the prior baseline.
  const arena = [
    RC(4, 4), RC(4, 5), RC(4, 6),
    RC(5, 4), RC(5, 5), RC(5, 6),
    RC(6, 4), RC(6, 5), RC(6, 6),
  ];
  const s = base({ cat: RC(4, 4), mouse: RC(6, 6), open: arena, patch: (st) => ({ ...st, catMovesLeft: 2, mouseMovesLeft: 2 }) });
  // cat (4,4) vs mouse (6,6): manhattan = 4 → 200 - 4*5 = 180.
  expect(defaultLeafEval(s)).toBe(180);

  // The new evaluator is a separate, explainable foundation and must not disturb
  // the search's baseline. With TT/AB/ordering the small arena completes (D4 canonical).
  const ref = searchBestAction(s, 3, createSearchContext(noTrapRuleSet, BIG, true, true, true));
  expect(ref.completed).toBe(true);
  expect(ref.mate).toBe('cat'); // canonical cat-favorable open arena
});

// ===========================================================================
// Phase E1 — Strategic Evaluation v1
// ===========================================================================

test('E1-A. reachable tunnel semantics', () => {
  // Tunnel reachable (corridor to corner (0,0)).
  const reach = base({
    cat: { r: 4, c: 4 }, mouse: { r: 3, c: 3 },
    open: [
      { r: 3, c: 3 }, { r: 3, c: 4 }, { r: 2, c: 4 }, { r: 4, c: 4 },
      { r: 2, c: 3 }, { r: 2, c: 2 }, { r: 2, c: 1 },
      { r: 1, c: 1 }, { r: 0, c: 1 }, { r: 0, c: 0 },
    ],
  });
  const fR = extractEvaluationFeatures(reach);
  expect(fR.mouseCanReachTunnel).toBe(true);
  expect(fR.mouseTunnelAccessDistance).not.toBeNull();
  expect(fR.mouseTunnelAccessDistance!).toBeGreaterThan(0);
  expect(fR.reachableOpenTunnelCount).toBeGreaterThan(0);
});

test('E1-B. unreachable tunnel gives NO false benefit to the cat', () => {
  // Identical pocket; the only difference is whether a tunnel is reachable.
  const pocket = [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }, { r: 4, c: 4 }];
  const sealed = base({ cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 }, open: pocket });
  const reachable = base({
    cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 },
    open: [...pocket, { r: 2, c: 1 }, { r: 1, c: 1 }, { r: 0, c: 1 }, { r: 0, c: 0 }],
  });

  const bSealed = evaluateForCatDetailed(sealed);
  const bReach = evaluateForCatDetailed(reachable);

  // Feature-level: sealed → null distance; reachable → finite distance.
  expect(bSealed.features.mouseTunnelAccessDistance).toBeNull();
  expect(bReach.features.mouseTunnelAccessDistance).not.toBeNull();

  // Contribution-level: unreachable tunnel contributes exactly 0 (never a
  // "penalty", never a "bonus"). The reachable tunnel penalizes the cat.
  expect(bSealed.contributions.tunnelControl).toBe(0);
  expect(bReach.contributions.tunnelControl).toBeLessThan(0);

  // Strategic: a REACHABLE escape tunnel is worse for the cat than none.
  expect(bReach.total).toBeLessThan(bSealed.total);
});

test('E1-C. carry / skill tunnel transition', () => {
  const open = [
    { r: 1, c: 1 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 0, c: 0 },
    { r: 2, c: 5 }, { r: 1, c: 5 },
  ];

  // No butter → tunnel usable & reachable.
  const none = base({ cat: { r: 2, c: 5 }, mouse: { r: 1, c: 1 }, open });
  expect(extractEvaluationFeatures(none).mouseTunnelAllowed).toBe(true);

  // Carrying butter → forbidden.
  const carry = base({ cat: { r: 2, c: 5 }, mouse: { r: 1, c: 1 }, open, patch: (s) => ({ ...s, mouseHasButter: true }) });
  expect(extractEvaluationFeatures(carry).mouseTunnelAllowed).toBe(false);

  // Skill active + butter consumed → usable again.
  const skill = base({ cat: { r: 2, c: 5 }, mouse: { r: 1, c: 1 }, open, patch: (s) => ({ ...s, mouseHasButter: false, mouseSkillActive: true }) });
  expect(extractEvaluationFeatures(skill).mouseTunnelAllowed).toBe(true);

  // Carrying + skill active (mid-turn edge case) → STILL forbidden: the
  // engine's tunnel gate is `mouseHasButter` (skill activation consumed the
  // butter; picking up a new one while skilled does not re-open tunnels).
  const carrySkill = base({ cat: { r: 2, c: 5 }, mouse: { r: 1, c: 1 }, open, patch: (s) => ({ ...s, mouseHasButter: true, mouseSkillActive: true }) });
  expect(extractEvaluationFeatures(carrySkill).mouseTunnelAllowed).toBe(false);
  expect(extractEvaluationFeatures(carrySkill).mouseCanReachTunnel).toBe(false);
});

test('E1-D. two-stage mouse win route', () => {
  // Mouse (4,4), butter (4,5), hole (7,8)-(8,9): win route = 1 + 6 = 7.
  const noCarry = base({
    cat: { r: 1, c: 1 }, mouse: { r: 4, c: 4 }, open: ALL_OPEN,
    patch: (s) => ({ ...s, butterPositions: [RC(4, 5)] }),
  });
  const f = extractEvaluationFeatures(noCarry);
  expect(f.mouseHasButter).toBe(false);
  expect(f.mouseWinRouteDistance).toBe(7);
  expect(f.mouseWinRouteDistance).toBe(f.mouseButterDistance! + 6);

  // Carrying: win route == goal distance (no two-stage needed).
  const carrying = base({
    cat: { r: 1, c: 1 }, mouse: { r: 4, c: 4 }, open: ALL_OPEN,
    patch: (s) => ({ ...s, mouseHasButter: true }),
  });
  const fC = extractEvaluationFeatures(carrying);
  expect(fC.mouseHasButter).toBe(true);
  expect(fC.mouseWinRouteDistance).toBe(fC.mouseGoalDistance);
});

test('E1-E. two butter choices select the shorter winning route', () => {
  const both = base({
    cat: { r: 1, c: 1 }, mouse: { r: 4, c: 4 }, open: ALL_OPEN,
    patch: (s) => ({ ...s, butterPositions: [RC(4, 5), RC(2, 8)] }),
  });
  const nearOnly = base({
    cat: { r: 1, c: 1 }, mouse: { r: 4, c: 4 }, open: ALL_OPEN,
    patch: (s) => ({ ...s, butterPositions: [RC(4, 5)] }),
  });
  const farOnly = base({
    cat: { r: 1, c: 1 }, mouse: { r: 4, c: 4 }, open: ALL_OPEN,
    patch: (s) => ({ ...s, butterPositions: [RC(2, 8)] }),
  });
  const bothR = extractEvaluationFeatures(both).mouseWinRouteDistance!;
  const nearR = extractEvaluationFeatures(nearOnly).mouseWinRouteDistance!;
  const farR = extractEvaluationFeatures(farOnly).mouseWinRouteDistance!;
  expect(bothR).toBe(nearR); // the shorter option wins
  expect(nearR).toBeLessThan(farR);
});

test('E1-F. blocked butter / hole route yields null win route', () => {
  // Butter walled away from the mouse → null.
  const blockedButter = base({
    cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 },
    open: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }, { r: 3, c: 2 }, { r: 3, c: 3 }, { r: 3, c: 4 }, { r: 4, c: 4 }],
    patch: (s) => ({ ...s, butterPositions: [RC(8, 8)] }),
  });
  expect(extractEvaluationFeatures(blockedButter).mouseWinRouteDistance).toBeNull();

  // Carrying butter but the hole is walled away → null goal, null win route.
  const blockedHole = base({
    cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 },
    open: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }, { r: 3, c: 2 }, { r: 3, c: 3 }, { r: 3, c: 4 }, { r: 4, c: 4 }],
    patch: (s) => ({ ...s, mouseHasButter: true }),
  });
  const f = extractEvaluationFeatures(blockedHole);
  expect(f.mouseGoalDistance).toBeNull();
  expect(f.mouseWinRouteDistance).toBeNull();
});

test('E1-G. hole gate control margin direction', () => {
  // Cat adjacent to the gate → negative margin (cat closer).
  const catClose = base({ cat: { r: 6, c: 8 }, mouse: { r: 1, c: 1 }, open: ALL_OPEN });
  const fCat = extractEvaluationFeatures(catClose);
  expect(fCat.holeGateCount).toBeGreaterThan(0);
  expect(fCat.catHoleGateDistance).toBe(0);
  expect(fCat.holeControlMargin).not.toBeNull();
  expect(fCat.holeControlMargin!).toBeLessThan(0);

  // Mouse near the gate → positive margin (mouse closer).
  const mouseClose = base({ cat: { r: 1, c: 1 }, mouse: { r: 7, c: 6 }, open: ALL_OPEN });
  const fMouse = extractEvaluationFeatures(mouseClose);
  expect(fMouse.holeControlMargin!).toBeGreaterThan(0);
});

test('E1-H. Voronoi normalization (confined vs open, and across board sizes)', () => {
  const confined = base({
    cat: { r: 5, c: 5 }, mouse: { r: 2, c: 2 },
    open: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }, { r: 5, c: 5 }, { r: 5, c: 6 }, { r: 6, c: 5 }, { r: 6, c: 6 }],
  });
  const fC = extractEvaluationFeatures(confined);
  expect(fC.catControlledArea).toBeGreaterThan(fC.mouseControlledArea);
  expect(fC.voronoiBalance).toBeGreaterThan(0);
  expect(fC.voronoiBalance).toBeLessThanOrEqual(1);

  // Balance is normalized: an extreme case cannot exceed [-1,1] on any size.
  const makeCfg = (n: number) => ({
    boardSize: n,
    mouseHole: { r: 0, c: 0, size: 1 } as { r: number; c: number; size: number },
    tunnelCorners: [RC(0, 0), RC(0, n - 1), RC(n - 1, 0), RC(n - 1, n - 1)],
    mouseStart: RC(1, 1),
    catStart: RC(1, 1),
  } as Partial<GameConfig>);
  const makeCells = (n: number) => {
    const cells: { r: number; c: number }[] = [];
    for (let r = 1; r < n - 1; r++) for (let c = 1; c < n - 1; c++) cells.push({ r, c });
    return cells;
  };
  for (const n of [5, 10, 20]) {
    const s = base({ cat: RC(1, 1), mouse: RC(n - 2, n - 2), open: makeCells(n), overrides: makeCfg(n) });
    const f = extractEvaluationFeatures(s);
    expect(f.voronoiBalance).toBeGreaterThanOrEqual(-1);
    expect(f.voronoiBalance).toBeLessThanOrEqual(1);
    expect(f.holeControlMargin ?? 0).toBeGreaterThanOrEqual(-n);
    expect(f.holeControlMargin ?? 0).toBeLessThanOrEqual(n);
  }
});

test('E1-I. trap reachable vs isolated (mouse-side)', () => {
  const reachable = base({
    cat: { r: 3, c: 3 }, mouse: { r: 1, c: 1 },
    open: [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 3, c: 3 }],
    patch: (s) => ({ ...s, trapPosition: RC(1, 2), catTrapsRemaining: 0 }),
  });
  const bR = evaluateForCatDetailed(reachable);
  expect(bR.features.mouseTrapDistance).toBe(1);
  expect(bR.contributions.trapControl).toBeGreaterThan(0);

  // Isolated: the trap is NOT in the mouse's reachable region → null, and the
  // cat gets no trap bonus from geometric proximity alone.
  const isolated = base({
    cat: { r: 3, c: 3 }, mouse: { r: 1, c: 1 },
    open: [{ r: 1, c: 1 }, { r: 2, c: 1 }, { r: 3, c: 1 }, { r: 3, c: 2 }, { r: 3, c: 3 }],
    patch: (s) => ({ ...s, trapPosition: RC(8, 8), catTrapsRemaining: 0 }),
  });
  const bI = evaluateForCatDetailed(isolated);
  expect(bI.features.mouseTrapDistance).toBeNull();
  expect(bI.contributions.trapControl).toBe(0);
});

test('E1-J. tempo pair (identical geometry, different player/moves)', () => {
  const catTurn = base({
    cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 }, open: ALL_OPEN,
    patch: (s) => ({ ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 1 }),
  });
  const mouseTurn = base({
    cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 }, open: ALL_OPEN,
    patch: (s) => ({ ...s, currentPlayer: PieceType.Mouse, catMovesLeft: 1, mouseMovesLeft: 4 }),
  });
  const bC = evaluateForCatDetailed(catTurn);
  const bM = evaluateForCatDetailed(mouseTurn);
  // Tempo flips sign with the player; the pair differs by exactly 2×|tempo|.
  expect(bC.contributions.tempo).toBeGreaterThan(0);
  expect(bM.contributions.tempo).toBeLessThan(0);
  expect(bC.contributions.tempo).toBe(-bM.contributions.tempo);
  // The effect is small and cannot reverse a dangerous position.
  expect(Math.abs(bC.contributions.tempo)).toBeLessThan(DEFAULT_EVALUATION_WEIGHTS.tempo * 2);
  expect(bC.total).toBeGreaterThan(bM.total);
});

test('E1-K. hard strategic corpus gate = 100%', () => {
  const scores = new Map<string, number>();
  for (const c of EVALUATION_CORPUS) scores.set(c.name, evaluateForCat(c.state));
  let hardChecks = 0;
  for (const c of EVALUATION_CORPUS) {
    for (const e of c.expectations) {
      if (e.type !== 'strategic' || e.confidence !== 'hard') continue;
      hardChecks++;
      const mine = scores.get(c.name)!;
      for (const other of e.betterThan ?? []) {
        expect(mine, `${c.name} betterThan ${other}`).toBeGreaterThan(scores.get(other) ?? -Infinity);
      }
      for (const other of e.worseThan ?? []) {
        expect(mine, `${c.name} worseThan ${other}`).toBeLessThan(scores.get(other) ?? Infinity);
      }
    }
  }
  expect(hardChecks).toBeGreaterThan(0);
});

test('E1-L. purity / deepFreeze regression on the E1 feature set', () => {
  const s = base({
    cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 }, open: ALL_OPEN,
    patch: (st) => ({ ...st, butterPositions: [RC(4, 5)], trapPosition: RC(8, 8) }),
  });
  const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => 0.5);
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => 0);
  const first = evaluateForCatDetailed(s);
  const second = evaluateForCatDetailed(structuredClone(s));
  expect(first.total).toBe(second.total);
  expect(first.features).toEqual(second.features);
  expect(first.contributions).toEqual(second.contributions);
  expect(randomSpy).not.toHaveBeenCalled();
  expect(nowSpy).not.toHaveBeenCalled();
  randomSpy.mockRestore();
  nowSpy.mockRestore();

  // BFS diagnostics counters (metadata only — reset & count).
  resetEvaluationCalls();
  expect(getMouseBfsCalls()).toBe(0);
  expect(getCatBfsCalls()).toBe(0);
  expect(getCarryMouseBfsCalls()).toBe(0);
  evaluateForCatDetailed(s);
  expect(getEvaluationCalls()).toBe(1);
  expect(getMouseBfsCalls()).toBe(1);
  expect(getCatBfsCalls()).toBe(1);
  expect(getCarryMouseBfsCalls()).toBe(1);

  // Frozen input does not throw; input is never mutated.
  const before = structuredClone(s);
  const frozen = recursiveDeepFreeze(structuredClone(s));
  expect(() => evaluateForCatDetailed(frozen)).not.toThrow();
  expect(s).toEqual(before);
  expect(evaluateForCat(s)).toBeLessThanOrEqual(HEURISTIC_LIMIT);
  expect(evaluateForCat(s)).toBeGreaterThanOrEqual(-HEURISTIC_LIMIT);
});

test('E1-M. board sizes 5 / 10 / 20 stay bounded and normalized', () => {
  const makeCfg = (n: number) => ({
    boardSize: n,
    mouseHole: { r: 0, c: 0, size: 1 } as { r: number; c: number; size: number },
    tunnelCorners: [RC(0, 0), RC(0, n - 1), RC(n - 1, 0), RC(n - 1, n - 1)],
    mouseStart: RC(1, 1),
    catStart: RC(1, 1),
  } as Partial<GameConfig>);
  const makeCells = (n: number) => {
    const cells: { r: number; c: number }[] = [];
    for (let r = 1; r < n - 1; r++) for (let c = 1; c < n - 1; c++) cells.push({ r, c });
    return cells;
  };
  for (const n of [5, 10, 20]) {
    const s = base({ cat: RC(1, 1), mouse: RC(n - 2, n - 2), open: makeCells(n), overrides: makeCfg(n) });
    const b = evaluateForCatDetailed(s);
    expect(Number.isFinite(b.total)).toBe(true);
    expect(Math.abs(b.total)).toBeLessThanOrEqual(HEURISTIC_LIMIT);
    // Normalized features stay in their stable ranges on every board size.
    expect(b.features.voronoiBalance).toBeGreaterThanOrEqual(-1);
    expect(b.features.voronoiBalance).toBeLessThanOrEqual(1);
    if (b.features.holeControlMargin !== null) {
      expect(b.features.holeControlMargin).toBeGreaterThanOrEqual(-n);
      expect(b.features.holeControlMargin).toBeLessThanOrEqual(n);
    }
  }
});
