/**
 * G0.4F-2A.1 — Ghost Butter Edge Correctness tests (U1-U11).
 *
 * Focus: replacement obligations are NEVER dropped; debt is a game-affecting
 * state field; search NEVER falls through to random endTurn; UI layering.
 *
 * Deterministic board control:
 *   - "giant hole" config (mouseHole size 8) → enumerateButterSpawns returns []
 *     → every candidate-dependent path hits the no-candidate branch.
 *   - "boxed" board (all interior cells Box except a chosen set) → exact
 *     candidate counts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInitialState, mouseMove, endTurn, mouseStepDeterministic, type GameEngineState } from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty, GamePhase, PieceType, CellType, DIRECTIONS } from '../../types';
import { simulateSearchAction } from '../simulator';
import { defaultRuleSet } from '../searchRules';
import { stateKey } from '../transposition';
import { gameAffectingEqual } from '../stateCompare';
import { captureHardRoot, restoreHardRoot } from '../hardHistory';

const dir = (k: string) => DIRECTIONS.find(d => d.key === k)!;
type P = [number, number];

/** Fresh canonical-hard state (random map). */
function baseState(): GameEngineState {
  const cfg = { ...DEFAULT_CONFIG, difficulty: Difficulty.Hard } as Parameters<typeof createInitialState>[0];
  return createInitialState(cfg);
}

/** Build a state with a custom mouseHole (to force 0 candidates) and clean
 *  board, cat/mouse/butter/ghosts placed. */
function build(opts: {
  cat: P; mouse: P; butter?: P[]; ghost?: { r: number; c: number; blockedMaterializations?: number }[];
  box?: P[]; empty?: P[]; trap?: P; debt?: number;
  mouseHoleSize?: number; mouseMoves?: number; catMoves?: number;
}): GameEngineState {
  const s = baseState();
  const config = opts.mouseHoleSize
    ? { ...s.config, mouseHole: { r: 1, c: 1, size: opts.mouseHoleSize } }
    : s.config;
  const b: GameEngineState['board'] = s.board.map(row => row.map(cell => ({ ...cell, piece: undefined as PieceType | undefined })));
  for (const [r, c] of opts.empty ?? []) b[r][c] = { type: CellType.Empty, piece: undefined as PieceType | undefined, hasButter: false };
  for (const [r, c] of opts.box ?? []) b[r][c] = { ...b[r][c], type: CellType.Box };
  b[opts.cat[0]][opts.cat[1]] = { ...b[opts.cat[0]][opts.cat[1]], piece: PieceType.Cat };
  b[opts.mouse[0]][opts.mouse[1]] = { ...b[opts.mouse[0]][opts.mouse[1]], piece: PieceType.Mouse };
  return {
    ...s, config, board: b,
    catPosition: { r: opts.cat[0], c: opts.cat[1] },
    mousePosition: { r: opts.mouse[0], c: opts.mouse[1] },
    butterPositions: (opts.butter ?? []).map(([r, c]) => ({ r, c })),
    pendingButterSpawns: (opts.ghost ?? []).map(g => ({ r: g.r, c: g.c, blockedMaterializations: g.blockedMaterializations ?? 0 })),
    pendingButterPlacementDebt: opts.debt ?? 0,
    trapPosition: opts.trap ? { r: opts.trap[0], c: opts.trap[1] } : null,
    catMovesLeft: opts.catMoves ?? s.config.catBaseMoves,
    mouseMovesLeft: opts.mouseMoves ?? s.config.mouseBaseMoves,
    currentPlayer: PieceType.Mouse,
    phase: GamePhase.Playing,
  };
}

/** Box ALL interior cells (1..8) EXCEPT the given open cells + the cat/mouse
 *  cells (kept non-box). Returns the board. */
function boxedInterior(s: GameEngineState, open: { r: number; c: number }[]): GameEngineState['board'] {
  const openSet = new Set<string>([
    ...open.map(p => `${p.r},${p.c}`),
    `${s.catPosition.r},${s.catPosition.c}`,
    `${s.mousePosition.r},${s.mousePosition.c}`,
  ]);
  const b = s.board.map((row, r) => row.map((cell, c) => {
    if (r >= 1 && r <= 8 && c >= 1 && c <= 8 && !openSet.has(`${r},${c}`)) {
      return { ...cell, type: CellType.Box, piece: undefined as PieceType | undefined };
    }
    return { ...cell, piece: undefined as PieceType | undefined };
  }));
  return b;
}

describe('G0.4F-2A.1 ghost butter edge correctness', () => {
  // U1: pickup candidate=0 → debt=1
  it('U1: pickup with NO legal candidate increments placement debt (never drops)', () => {
    // Giant mouseHole (size 8) covers all interior cells → 0 candidates.
    const s = build({ cat: [0, 9], mouse: [5, 5], butter: [[5, 6]], empty: [[5, 5], [5, 6]], mouseHoleSize: 8 });
    // confirm 0 candidates via the deterministic core's candidate kernel
    const picked = mouseStepDeterministic(s, dir('ArrowRight'));
    const cands = defaultRuleSet.enumerateButterSpawns(picked);
    expect(cands.length).toBe(0);
    const after = mouseMove(s, dir('ArrowRight')); // eats butter, no candidates
    expect(after.mouseHasButter).toBe(true);
    expect(after.pendingButterSpawns.length).toBe(0); // no ghost could be placed
    expect(after.pendingButterPlacementDebt).toBe(1); // obligation preserved as debt
  });

  // U2: later candidate available → debt converted to visible ghost
  it('U2: carried debt converts to a visible ghost at the next boundary with candidates', () => {
    // Normal board (candidates exist — force a center cell empty so ≥1 exists),
    // mouse NOT carrying, debt=1, cat ends turn.
    const s = build({ cat: [1, 1], mouse: [8, 0], debt: 1, empty: [[8, 0], [1, 1], [4, 4], [4, 5]] });
    expect(defaultRuleSet.enumerateButterSpawns(s).length).toBeGreaterThan(0);
    const after = endTurn({ ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0, mouseHasButter: false });
    expect(after.currentPlayer).toBe(PieceType.Mouse);
    expect(after.pendingButterPlacementDebt).toBe(0); // debt consumed
    expect(after.pendingButterSpawns.length).toBe(1); // one visible ghost announced
  });

  // U3: auto-pick no-candidate → debt preserved
  it('U3: auto-pick with NO candidate keeps debt (replacement not dropped)', () => {
    const s = build({ cat: [0, 0], mouse: [4, 4], ghost: [{ r: 4, c: 4 }], empty: [[4, 4]], mouseHoleSize: 8 });
    // put mouse on the ghost cell, cat ends turn → auto-pick
    const st: GameEngineState = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0, mouseHasButter: false };
    const after = endTurn(st);
    expect(after.mouseHasButter).toBe(true); // auto-picked
    expect(after.pendingButterSpawns.length).toBe(0); // replacement ghost could not be placed (0 candidates)
    expect(after.pendingButterPlacementDebt).toBe(1); // preserved as debt
  });

  // U4: reroll no-candidate → debt preserved
  it('U4: reroll with NO candidate keeps debt', () => {
    const s = build({ cat: [4, 4], mouse: [8, 8], ghost: [{ r: 4, c: 4, blockedMaterializations: 1 }], empty: [[4, 4], [8, 8]], mouseHoleSize: 8 });
    const st: GameEngineState = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0 };
    const after = endTurn(st);
    // reroll triggered (blocked=1 → 2nd → reroll) but no candidate → debt
    expect(after.pendingButterSpawns.some(g => g.r === 4 && g.c === 4)).toBe(false);
    expect(after.pendingButterPlacementDebt).toBe(1);
  });

  // U5: requested=2 candidates=1 → 1 ghost + debt1
  it('U5: partial candidates (requested 2, available 1) → 1 ghost + debt 1', () => {
    // Boxed board: exactly one candidate cell (3,3). debt=2 → requested=2, N=1.
    const s0 = build({ cat: [8, 9], mouse: [8, 0], empty: [[3, 3], [8, 0], [8, 9]], debt: 2 });
    const s: GameEngineState = { ...s0, board: boxedInterior(s0, [{ r: 3, c: 3 }]), currentPlayer: PieceType.Cat, catMovesLeft: 0 };
    const cands = defaultRuleSet.enumerateButterSpawns(s);
    expect(cands.length).toBe(1); // exactly one candidate (3,3)
    const after = endTurn(s);
    // all 1 candidate used → 1 ghost; remaining 1 → debt
    expect(after.pendingButterSpawns.length).toBe(1);
    expect(after.pendingButterPlacementDebt).toBe(1);
  });

  // U6: search candidate=0 → NO Math.random, deterministic debt outcome
  it('U6: search with 0 candidates does NOT call Math.random (debt deterministic)', () => {
    // Giant hole (0 candidates). Mouse on a ghost cell; cat has 0 moves left so
    // any catStep no-ops and the simulator forces the CAT→MOUSE boundary.
    const s = build({ cat: [1, 1], mouse: [4, 4], ghost: [{ r: 4, c: 4 }], empty: [[1, 1], [4, 4]], mouseHoleSize: 8 });
    const catSt: GameEngineState = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0, mouseHasButter: false };
    const origRandom = Math.random;
    Math.random = () => { throw new Error('SEARCH_USED_HIDDEN_RANDOM'); };
    let sim: ReturnType<typeof simulateSearchAction>;
    let threw = false;
    try {
      // catStep no-ops (0 moves) → forceEndTurnIfNeeded → ghost/debt chance.
      sim = simulateSearchAction(catSt, { type: 'catStep', direction: dir('ArrowRight') }, defaultRuleSet);
    } catch { threw = true; } finally { Math.random = origRandom; }
    expect(threw).toBe(false); // must NOT fall to engine.endTurn (Math.random)
    if (!threw && sim!.kind === 'chance') {
      for (const o of sim!.outcomes) {
        // deterministic-equivalent: auto-pick resolved, replacement → debt
        expect(o.state.pendingButterSpawns.length).toBe(0);
        expect(o.state.pendingButterPlacementDebt).toBe(1);
        expect(o.state.mouseHasButter).toBe(true);
      }
    }
  });

  // U7: search partial (requested 2, candidate 1) → NO Math.random
  it('U7: search partial candidates does NOT call Math.random', () => {
    // Boxed board: only interior-open cell is (3,3) → exactly 1 candidate.
    const s0 = build({ cat: [8, 9], mouse: [8, 0], empty: [[3, 3], [8, 0], [8, 9]], debt: 2 });
    const s: GameEngineState = {
      ...s0,
      board: boxedInterior(s0, [{ r: 3, c: 3 }]),
      currentPlayer: PieceType.Cat, catMovesLeft: 0,
    };
    expect(defaultRuleSet.enumerateButterSpawns(s).length).toBe(1);
    const origRandom = Math.random;
    Math.random = () => { throw new Error('SEARCH_USED_HIDDEN_RANDOM'); };
    let sim: ReturnType<typeof simulateSearchAction>;
    let threw = false;
    try {
      // catStep no-ops (0 moves) → CAT→MOUSE, totalRequests=2, N=1
      sim = simulateSearchAction(s, { type: 'catStep', direction: dir('ArrowUp') }, defaultRuleSet);
    } catch { threw = true; } finally { Math.random = origRandom; }
    expect(threw).toBe(false);
    if (!threw && sim!.kind === 'chance') {
      for (const o of sim!.outcomes) {
        // 1 candidate used → 1 ghost; remaining 1 → debt
        expect(o.state.pendingButterSpawns.length).toBe(1);
        expect(o.state.pendingButterPlacementDebt).toBe(1);
      }
    }
  });

  // U8: stateKey debt different → key different
  it('U8: stateKey differs when placement debt differs', () => {
    const s = build({ cat: [1, 1], mouse: [8, 0], debt: 0, empty: [[8, 0], [1, 1]] });
    const k0 = stateKey(s);
    const k1 = stateKey({ ...s, pendingButterPlacementDebt: 1 });
    expect(k1).not.toBe(k0);
  });

  // U9: snapshot debt roundtrip
  it('U9: snapshot/restore preserves placement debt', () => {
    const s = build({ cat: [1, 1], mouse: [8, 0], debt: 3, empty: [[8, 0], [1, 1]] });
    const restored = restoreHardRoot(captureHardRoot(s));
    expect(restored.pendingButterPlacementDebt).toBe(3);
    expect(stateKey(restored)).toBe(stateKey(s));
  });

  // U10: gameAffectingEqual includes debt
  it('U10: gameAffectingEqual includes placement debt', () => {
    const s = build({ cat: [1, 1], mouse: [8, 0], debt: 0, empty: [[8, 0], [1, 1]] });
    expect(gameAffectingEqual(s, { ...s, pendingButterPlacementDebt: 1 })).toBe(false);
    expect(gameAffectingEqual(s, { ...s, pendingButterPlacementDebt: 0 })).toBe(true);
  });

  // U11: UI structural layering (source assertion — no component-test infra)
  it('U11: Board source asserts ghost underlay (zIndex 0) under box/trap/entity (zIndex 1) under pieces (10)', () => {
    const src = readFileSync('src/components/Board.tsx', 'utf8');
    // ghost underlay is absolute at zIndex 0
    expect(src).toContain("position: 'absolute'");
    expect(src).toContain('zIndex: 0');
    expect(src).toContain('ghostUnderlayStyle');
    // main entities wrapper at zIndex 1
    expect(src).toContain('zIndex: 1');
    expect(src).toContain('cellItemStyle');
    // pieces stay at zIndex 10
    expect(src).toContain('zIndex: 10');
    // ghost rendered inside the underlay wrapper (isGhost && !isButter)
    expect(src).toContain('isGhost && !isButter');
  });
});
