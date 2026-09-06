/**
 * G0.4F-2A.3 — Production RuleSet Ghost Parity Hotfix regression.
 *
 * RED FIRST: drives the REAL production chain
 *   mouseMove → ghost → endTurn(CAT) → computeCatAiTrajectory
 *            → planHardCatTurn → createEngineRuleSet
 * Before the fix, `createEngineRuleSet` lacks `resolveGhostBoundaryChance` and
 * still has the OLD entity-butter pickup builder, so the search throws
 * "RuleSet missing resolveGhostBoundaryChance..." at a CAT→MOUSE ghost boundary
 * → the React UI disappears (yellow screen). After the fix these tests must pass.
 */
import { describe, it, expect } from 'vitest';
import { createInitialState, mouseMove, endTurn, computeCatAiTrajectory, createEngineRuleSet, type GameEngineState } from '../../engine';
import { planHardCatTurn } from '../hardTurnPlanner';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty, GamePhase, PieceType, CellType, DIRECTIONS } from '../../types';
import { defaultRuleSet } from '../searchRules';
import { simulateSearchAction } from '../simulator';

const dir = (k: string) => DIRECTIONS.find(d => d.key === k)!;

function build(opts: { cat: [number, number]; mouse: [number, number]; butter?: [number, number][]; empty?: [number, number][] }): GameEngineState {
  const cfg = { ...DEFAULT_CONFIG, difficulty: Difficulty.Hard } as Parameters<typeof createInitialState>[0];
  const s = createInitialState(cfg);
  const b: GameEngineState['board'] = s.board.map(row => row.map(cell => ({ ...cell, piece: undefined as PieceType | undefined })));
  for (const [r, c] of opts.empty ?? []) b[r][c] = { type: CellType.Empty, piece: undefined as PieceType | undefined, hasButter: false };
  b[opts.cat[0]][opts.cat[1]] = { ...b[opts.cat[0]][opts.cat[1]], piece: PieceType.Cat };
  b[opts.mouse[0]][opts.mouse[1]] = { ...b[opts.mouse[0]][opts.mouse[1]], piece: PieceType.Mouse };
  return {
    ...s, board: b,
    catPosition: { r: opts.cat[0], c: opts.cat[1] },
    mousePosition: { r: opts.mouse[0], c: opts.mouse[1] },
    butterPositions: (opts.butter ?? []).map(([r, c]) => ({ r, c })),
    pendingButterSpawns: [],
    pendingButterPlacementDebt: 0,
    currentPlayer: PieceType.Mouse,
    phase: GamePhase.Playing,
  };
}

/** Real production chain: eat butter → ghost → cat to move (with a guaranteed ghost). */
function ghostCatState(): GameEngineState {
  let s = build({ cat: [2, 2], mouse: [4, 4], butter: [[4, 5]], empty: [[4, 4], [4, 5], [2, 2], [5, 5]] });
  s = mouseMove(s, dir('ArrowRight')); // eat → ghost announced
  if (s.pendingButterSpawns.length === 0) {
    // guarantee a ghost for a deterministic crash repro
    s = { ...s, pendingButterSpawns: [{ r: 5, c: 5, blockedMaterializations: 0 }] };
  }
  let cat = endTurn({ ...s, currentPlayer: PieceType.Mouse, mouseMovesLeft: 0 });
  if (cat.currentPlayer !== PieceType.Cat) {
    cat = endTurn({ ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0, phase: GamePhase.Playing });
  }
  return cat;
}

describe('G0.4F-2A.3 production RuleSet ghost parity', () => {
  it('P1: production createEngineRuleSet has resolveGhostBoundaryChance', () => {
    const A = createEngineRuleSet();
    expect(typeof A.resolveGhostBoundaryChance).toBe('function');
  });

  it('P12: computeCatAiTrajectory does NOT throw on a ghost root (human yellow-screen regression)', () => {
    const catState = ghostCatState();
    expect(catState.pendingButterSpawns.length).toBeGreaterThan(0);
    expect(catState.currentPlayer).toBe(PieceType.Cat);
    let traj: ReturnType<typeof computeCatAiTrajectory> | null = null;
    expect(() => { traj = computeCatAiTrajectory(catState); }).not.toThrow();
    expect(traj).not.toBeNull();
  });

  it('P11: planHardCatTurn with production createEngineRuleSet does NOT throw on a ghost root', () => {
    const catState = ghostCatState();
    const A = createEngineRuleSet();
    expect(() => {
      planHardCatTurn(catState, {
        rules: A,
        timeBudgetMs: 100,
        refutation: { enabled: false, totalTurnBudgetMs: 150 },
      });
    }).not.toThrow();
  });

  it('P2: production enumerateButterSpawns reserves pending ghosts (parity with defaultRuleSet)', () => {
    const s = build({ cat: [2, 2], mouse: [4, 4], butter: [[4, 5]], empty: [[4, 4], [4, 5], [5, 5]] });
    const ghost = { r: 5, c: 5, blockedMaterializations: 0 };
    const A = createEngineRuleSet();
    const B = defaultRuleSet;
    const withGhost = { ...s, pendingButterSpawns: [ghost] };
    const ca = A.enumerateButterSpawns(withGhost);
    const cb = B.enumerateButterSpawns(withGhost);
    // both must exclude the reserved ghost
    expect(ca.some(p => p.r === 5 && p.c === 5)).toBe(false);
    expect(cb.some(p => p.r === 5 && p.c === 5)).toBe(false);
    // exact set parity
    expect([...ca].sort((a, b) => `${a.r},${a.c}`.localeCompare(`${b.r},${b.c}`)))
      .toEqual([...cb].sort((a, b) => `${a.r},${a.c}`.localeCompare(`${b.r},${b.c}`)));
  });

  it('P3: production pickup chance adds a GHOST (not entity butter), parity with defaultRuleSet', () => {
    const s = build({ cat: [2, 2], mouse: [4, 4], butter: [[4, 5]], empty: [[4, 4], [4, 5]] });
    const A = createEngineRuleSet();
    const B = defaultRuleSet;
    // a mouseStep onto the butter
    const simA = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, A);
    const simB = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, B);
    expect(simA.kind).toBe('chance');
    expect(simB.kind).toBe('chance');
    if (simA.kind === 'chance' && simB.kind === 'chance') {
      expect(simA.outcomes.length).toBe(simB.outcomes.length);
      for (let i = 0; i < simA.outcomes.length; i++) {
        // NO entity butter re-added; +1 pending ghost
        expect(simA.outcomes[i].state.butterPositions.length).toBe(0);
        expect(simA.outcomes[i].state.pendingButterSpawns.length).toBe(1);
        expect(simA.outcomes[i].weight).toBeCloseTo(simB.outcomes[i].weight, 12);
      }
    }
  });

  it('P4: production pickup with NO candidate → placement debt (parity with defaultRuleSet)', () => {
    // giant hole → 0 candidates
    const s0 = build({ cat: [2, 2], mouse: [4, 4], butter: [[4, 5]], empty: [[4, 4], [4, 5]] });
    const s = { ...s0, config: { ...s0.config, mouseHole: { r: 1, c: 1, size: 8 } } } as GameEngineState;
    const A = createEngineRuleSet();
    const B = defaultRuleSet;
    const simA = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, A);
    const simB = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, B);
    expect(simA.kind).toBe('chance');
    expect(simB.kind).toBe('chance');
    if (simA.kind === 'chance' && simB.kind === 'chance') {
      expect(simA.outcomes.length).toBe(1);
      expect(simA.outcomes[0].state.pendingButterPlacementDebt).toBe(1);
      expect(simB.outcomes[0].state.pendingButterPlacementDebt).toBe(1);
    }
  });

  // ---- PRODUCTION vs DEFAULT parity matrix (both RuleSets must share the same
  //      ghost-rule enumeration kernel) ----

  function catBoundaryState(opts: { ghost?: { r: number; c: number; blockedMaterializations?: number }[]; debt?: number; mouseOnGhost?: boolean }): GameEngineState {
    const ghost = opts.ghost ?? [{ r: 5, c: 5 }];
    const s = build({ cat: [2, 2], mouse: [4, 4], butter: [[4, 5]], empty: [[4, 4], [4, 5], [5, 5], [6, 6]] });
    let mouse = s.mousePosition;
    if (opts.mouseOnGhost) mouse = { r: ghost[0].r, c: ghost[0].c };
    const b: GameEngineState['board'] = s.board.map(row => row.map(cell => ({ ...cell, piece: undefined as PieceType | undefined })));
    b[mouse.r][mouse.c] = { ...b[mouse.r][mouse.c], piece: PieceType.Mouse };
    b[s.catPosition.r][s.catPosition.c] = { ...b[s.catPosition.r][s.catPosition.c], piece: PieceType.Cat };
    const st: GameEngineState = {
      ...s, board: b, mousePosition: mouse,
      pendingButterSpawns: ghost.map(g => ({ r: g.r, c: g.c, blockedMaterializations: g.blockedMaterializations ?? 0 })),
      pendingButterPlacementDebt: opts.debt ?? 0,
      currentPlayer: PieceType.Cat, catMovesLeft: 0, mouseHasButter: false,
    };
    return st;
  }

  function boundaryOutcomes(A: GameEngineState, RS: ReturnType<typeof createEngineRuleSet>) {
    // force the CAT→MOUSE boundary via a no-op catStep (0 moves left)
    return simulateSearchAction(A, { type: 'catStep', direction: dir('ArrowRight') }, RS);
  }

  it('P5: production boundary normal materialization == defaultRuleSet', () => {
    const A = createEngineRuleSet();
    const B = defaultRuleSet;
    const st = catBoundaryState({ ghost: [{ r: 6, c: 6 }] }); // idle ghost, free cell
    const sa = boundaryOutcomes(st, A);
    const sb = boundaryOutcomes(st, B);
    expect(sa.kind).toBe('chance');
    expect(sb.kind).toBe('chance');
    if (sa.kind === 'chance' && sb.kind === 'chance') {
      expect(sa.outcomes).toHaveLength(sb.outcomes.length);
      // materialized: (6,6) becomes entity butter
      expect(sa.outcomes[0].state.butterPositions.some(p => p.r === 6 && p.c === 6)).toBe(true);
      expect(sb.outcomes[0].state.butterPositions.some(p => p.r === 6 && p.c === 6)).toBe(true);
    }
  });

  it('P6: production mouse-on-ghost auto-pick replacement == defaultRuleSet', () => {
    const A = createEngineRuleSet();
    const B = defaultRuleSet;
    const st = catBoundaryState({ ghost: [{ r: 5, c: 5 }], mouseOnGhost: true });
    const sa = boundaryOutcomes(st, A);
    const sb = boundaryOutcomes(st, B);
    expect(sa.kind).toBe('chance');
    expect(sb.kind).toBe('chance');
    if (sa.kind === 'chance' && sb.kind === 'chance') {
      expect(sa.outcomes).toHaveLength(sb.outcomes.length);
      // auto-picked: mouseHasButter true + replacement ghost
      for (const o of [...sa.outcomes, ...sb.outcomes]) {
        expect(o.state.mouseHasButter).toBe(true);
        expect(o.state.pendingButterSpawns.length).toBeGreaterThan(0);
      }
      // weights parity
      for (let i = 0; i < sa.outcomes.length; i++) {
        expect(sa.outcomes[i].weight).toBeCloseTo(sb.outcomes[i].weight, 12);
      }
    }
  });

  it('P7: production reroll (2nd block) == defaultRuleSet', () => {
    const A = createEngineRuleSet();
    const B = defaultRuleSet;
    // ghost at cat's cell with blocked=1 → reroll at boundary
    const st = catBoundaryState({ ghost: [{ r: 2, c: 2, blockedMaterializations: 1 }] }); // cat at (2,2)
    const sa = boundaryOutcomes(st, A);
    const sb = boundaryOutcomes(st, B);
    expect(sa.kind).toBe('chance');
    expect(sb.kind).toBe('chance');
    if (sa.kind === 'chance' && sb.kind === 'chance') {
      expect(sa.outcomes).toHaveLength(sb.outcomes.length);
      // rerolled: old position gone, a new pending ghost present
      for (const o of [...sa.outcomes, ...sb.outcomes]) {
        expect(o.state.pendingButterSpawns.some(g => g.r === 2 && g.c === 2)).toBe(false);
        expect(o.state.pendingButterSpawns.length).toBeGreaterThan(0);
      }
    }
  });

  it('P8: production debt-only boundary == defaultRuleSet', () => {
    const A = createEngineRuleSet();
    const B = defaultRuleSet;
    const st = catBoundaryState({ debt: 1 }); // debt 1, no ghosts
    const sa = boundaryOutcomes(st, A);
    const sb = boundaryOutcomes(st, B);
    expect(sa.kind).toBe('chance');
    expect(sb.kind).toBe('chance');
    if (sa.kind === 'chance' && sb.kind === 'chance') {
      expect(sa.outcomes).toHaveLength(sb.outcomes.length);
      for (let i = 0; i < sa.outcomes.length; i++) {
        expect(sa.outcomes[i].weight).toBeCloseTo(sb.outcomes[i].weight, 12);
      }
    }
  });

  it('P9: production partial candidates (requested 2, available 1) == defaultRuleSet', () => {
    const A = createEngineRuleSet();
    const B = defaultRuleSet;
    // boxed interior leaving exactly one candidate (3,3); debt 2 → requested 2, N=1
    const s0 = build({ cat: [8, 9], mouse: [8, 0], empty: [[3, 3], [8, 0], [8, 9]] });
    const b: GameEngineState['board'] = s0.board.map((row, r) => row.map((cell, c) => {
      if (r >= 1 && r <= 8 && c >= 1 && c <= 8 && !(r === 3 && c === 3) && !(r === 8 && c === 0) && !(r === 8 && c === 9)) {
        return { ...cell, type: CellType.Box, piece: undefined as PieceType | undefined };
      }
      return { ...cell, piece: undefined as PieceType | undefined };
    }));
    const st: GameEngineState = { ...s0, board: b, currentPlayer: PieceType.Cat, catMovesLeft: 0, pendingButterSpawns: [], pendingButterPlacementDebt: 2 };
    expect(A.enumerateButterSpawns(st)).toHaveLength(1);
    expect(B.enumerateButterSpawns(st)).toHaveLength(1);
    const sa = boundaryOutcomes(st, A);
    const sb = boundaryOutcomes(st, B);
    expect(sa.kind).toBe('chance');
    expect(sb.kind).toBe('chance');
    if (sa.kind === 'chance' && sb.kind === 'chance') {
      expect(sa.outcomes).toHaveLength(sb.outcomes.length);
      for (let i = 0; i < sa.outcomes.length; i++) {
        // 1 candidate used → 1 ghost; remaining 1 → debt
        expect(sa.outcomes[i].state.pendingButterSpawns.length).toBe(1);
        expect(sa.outcomes[i].state.pendingButterPlacementDebt).toBe(1);
        expect(sa.outcomes[i].weight).toBeCloseTo(sb.outcomes[i].weight, 12);
      }
    }
  });

  it('P10: PRODUCTION search never calls Math.random (ghost pickup + boundary + debt + partial)', () => {
    const A = createEngineRuleSet();
    // Pre-build ALL states BEFORE patching Math.random — the real game's random
    // map/butter generation legitimately calls Math.random (not a search path).
    const pickup = build({ cat: [2, 2], mouse: [4, 4], butter: [[4, 5]], empty: [[4, 4], [4, 5]] });
    const stB = catBoundaryState({ ghost: [{ r: 6, c: 6 }] });
    const stC = catBoundaryState({ debt: 1 });
    const s0 = build({ cat: [8, 9], mouse: [8, 0], empty: [[3, 3], [8, 0], [8, 9]] });
    const b: GameEngineState['board'] = s0.board.map((row, r) => row.map((cell, c) => {
      if (r >= 1 && r <= 8 && c >= 1 && c <= 8 && !(r === 3 && c === 3) && !(r === 8 && c === 0) && !(r === 8 && c === 9)) {
        return { ...cell, type: CellType.Box, piece: undefined as PieceType | undefined };
      }
      return { ...cell, piece: undefined as PieceType | undefined };
    }));
    const stD: GameEngineState = { ...s0, board: b, currentPlayer: PieceType.Cat, catMovesLeft: 0, pendingButterSpawns: [], pendingButterPlacementDebt: 2 };

    const origRandom = Math.random;
    Math.random = () => { throw new Error('PRODUCTION_SEARCH_USED_HIDDEN_RANDOM'); };
    let threw = false;
    try {
      // A. pickup chance (search simulation only)
      simulateSearchAction(pickup, { type: 'mouseStep', direction: dir('ArrowRight') }, A);
      // B. CAT→MOUSE pending ghost
      boundaryOutcomes(stB, A);
      // C. debt boundary
      boundaryOutcomes(stC, A);
      // D. partial-candidate boundary
      boundaryOutcomes(stD, A);
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'PRODUCTION_SEARCH_USED_HIDDEN_RANDOM') threw = true;
    } finally { Math.random = origRandom; }
    expect(threw).toBe(false);
  });
});
