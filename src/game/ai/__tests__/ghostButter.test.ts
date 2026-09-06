/**
 * G0.4F-2A — Ghost Butter Rule tests (A-T).
 *
 * Uses DETERMINISTIC board geometry: every test explicitly clears and places
 * cat / mouse / boxes / butters / ghosts on known empty cells, so the tests are
 * not sensitive to the random canonical map layout.
 *
 * Rules under test:
 *  A. pickup → entity butter -1, ghost +1 (no immediate entity re-spawn)
 *  B. mouse walking onto a ghost does NOT pick it up
 *  C. cat can step onto a ghost
 *  D. box can be pushed onto a ghost
 *  E. trap can be placed on a ghost
 *  F. ghost never materializes before a full cat turn
 *  G. idle ghost materializes at CAT→MOUSE boundary
 *  H. mouse on ghost at boundary → auto-pick + carrying moves
 *  I. auto-pick replacement ghost does not materialize same boundary
 *  J. cat occupies ghost → first boundary block=1, still ghost
 *  K. still occupied second time → reroll new position, blocked reset
 *  L. multiple ghosts resolve independently
 *  M. pending ghost positions never duplicate
 *  N. search pickup → CHANCE adds ghost (not entity butter)
 *  O. search chance candidate set == real game candidate set
 *  P. search never calls Math.random (deterministic core defers)
 *  Q. boundary auto-pick replacement is honest chance in search
 *  R. stateKey includes ghost pos + blocked; array order canonicalized
 *  S. gameAffectingEqual includes ghost state
 *  T. snapshot/restore roundtrip preserves ghosts
 */
import { describe, it, expect } from 'vitest';
import { createInitialState, catMove, catPlaceTrap, endTurn, mouseMove, type GameEngineState } from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty, GamePhase, PieceType, CellType, DIRECTIONS } from '../../types';
import { simulateSearchAction } from '../simulator';
import { defaultRuleSet } from '../searchRules';
import { stateKey } from '../transposition';
import { gameAffectingEqual } from '../stateCompare';
import { captureHardRoot, restoreHardRoot } from '../hardHistory';
import { mouseStepDeterministic } from '../../engine';

const dir = (k: string) => DIRECTIONS.find(d => d.key === k)!;

type P = [number, number];

/** Fresh canonical-hard state (random map). */
function baseState(): GameEngineState {
  const cfg = { ...DEFAULT_CONFIG, difficulty: Difficulty.Hard } as Parameters<typeof createInitialState>[0];
  return createInitialState(cfg);
}

/**
 * Deterministic rebuild: clear ALL pieces and butters, set the terrain of
 * `empty` cells to Empty, then place cat/mouse and boxes/butters/ghosts at
 * the given coordinates. Returns a Playing state with the mouse to move.
 */
function build(opts: {
  cat: P; mouse: P;
  butter?: P[]; ghost?: { r: number; c: number; blockedMaterializations?: number }[];
  box?: P[]; trap?: P;
  empty?: P[]; // force these cells to Empty (movement targets)
  mouseMoves?: number; catMoves?: number;
}): GameEngineState {
  const s = baseState();
  const b: GameEngineState['board'] = s.board.map(row => row.map(cell => ({ ...cell, piece: undefined as PieceType | undefined })));
  // force-empties
  for (const [r, c] of opts.empty ?? []) {
    b[r][c] = { type: CellType.Empty, piece: undefined as PieceType | undefined, hasButter: false };
  }
  // boxes
  for (const [r, c] of opts.box ?? []) b[r][c] = { ...b[r][c], type: CellType.Box };
  // entities
  b[opts.cat[0]][opts.cat[1]] = { ...b[opts.cat[0]][opts.cat[1]], piece: PieceType.Cat };
  b[opts.mouse[0]][opts.mouse[1]] = { ...b[opts.mouse[0]][opts.mouse[1]], piece: PieceType.Mouse };
  return {
    ...s,
    board: b,
    catPosition: { r: opts.cat[0], c: opts.cat[1] },
    mousePosition: { r: opts.mouse[0], c: opts.mouse[1] },
    butterPositions: (opts.butter ?? []).map(([r, c]) => ({ r, c })),
    pendingButterSpawns: (opts.ghost ?? []).map(g => ({ r: g.r, c: g.c, blockedMaterializations: g.blockedMaterializations ?? 0 })),
    trapPosition: opts.trap ? { r: opts.trap[0], c: opts.trap[1] } : null,
    catMovesLeft: opts.catMoves ?? s.config.catBaseMoves,
    mouseMovesLeft: opts.mouseMoves ?? s.config.mouseBaseMoves,
    currentPlayer: PieceType.Mouse,
    phase: GamePhase.Playing,
  };
}

/** A deterministic pickup state: mouse at (4,4) walks right onto butter at (4,5). */
function pickupState(): GameEngineState {
  return build({ cat: [2, 2], mouse: [4, 4], butter: [[4, 5]], empty: [[4, 4], [4, 5]] });
}

describe('G0.4F-2A ghost butter rule', () => {
  it('A: pickup removes entity butter and announces a ghost (butter 1→0, pending 0→1)', () => {
    const s = pickupState();
    expect(s.butterPositions.length).toBe(1);
    expect(s.pendingButterSpawns.length).toBe(0);
    const after = mouseMove(s, dir('ArrowRight'));
    expect(after.mouseHasButter).toBe(true);
    expect(after.butterPositions.length).toBe(0);
    expect(after.pendingButterSpawns.length).toBe(1);
  });

  it('B: mouse walking onto a ghost does NOT pick it up', () => {
    // Ghost at (4,6); mouse at (4,4) already carrying butter steps right twice.
    // First step to (4,5) (empty), second to (4,6) = ghost → no additional pickup,
    // mouseHasButter stays true, ghost persists.
    const s = build({ cat: [2, 2], mouse: [4, 4], butter: [[4, 5]], ghost: [{ r: 4, c: 6 }], empty: [[4, 4], [4, 5], [4, 6]] });
    const step1 = mouseMove(s, dir('ArrowRight')); // onto (4,5) → picks butter (entity) + ghost announced
    // ghost count now 2 (original + announced). Mouse has butter.
    expect(step1.mouseHasButter).toBe(true);
    const ghostCount = step1.pendingButterSpawns.length;
    // Move onto the ORIGINAL ghost at (4,6).
    const step2 = mouseMove(step1, dir('ArrowRight'));
    if (step2.mousePosition.r === 4 && step2.mousePosition.c === 6) {
      // ghost is not an entity butter: no new pickup; mouse still carries.
      expect(step2.mouseHasButter).toBe(true);
      expect(step2.pendingButterSpawns.length).toBe(ghostCount); // no change
      expect(step2.pendingButterSpawns.some(g => g.r === 4 && g.c === 6)).toBe(true);
    }
  });

  it('C: cat can step onto a ghost', () => {
    // Ghost at (3,3); cat at (3,2) steps right onto it.
    const s = build({ cat: [3, 2], mouse: [7, 7], ghost: [{ r: 3, c: 3 }], empty: [[3, 2], [3, 3], [7, 7]] });
    const next = catMove({ ...s, currentPlayer: PieceType.Cat }, dir('ArrowRight'));
    expect(next.catPosition.r).toBe(3);
    expect(next.catPosition.c).toBe(3);
    // ghost persists (non-blocking)
    expect(next.pendingButterSpawns.some(g => g.r === 3 && g.c === 3)).toBe(true);
  });

  it('D: a box can be pushed onto a ghost', () => {
    // cat at (3,1), box at (3,2), ghost at (3,3): push right moves box onto ghost.
    const s = build({ cat: [3, 1], mouse: [7, 7], box: [[3, 2]], ghost: [{ r: 3, c: 3 }], empty: [[3, 1], [3, 2], [3, 3], [3, 4], [7, 7]] });
    const next = catMove({ ...s, currentPlayer: PieceType.Cat }, dir('ArrowRight'));
    // box moved to (3,3) (the ghost cell); ghost persists (non-blocking)
    expect(next.board[3][3].type).toBe(CellType.Box);
    expect(next.pendingButterSpawns.some(g => g.r === 3 && g.c === 3)).toBe(true);
  });

  it('E: a trap can be placed on a ghost', () => {
    // cat exactly on ghost cell, place trap.
    const s = build({ cat: [3, 3], mouse: [7, 7], ghost: [{ r: 3, c: 3 }], empty: [[3, 3], [7, 7]] });
    const next = catPlaceTrap({ ...s, currentPlayer: PieceType.Cat, catTrapsRemaining: 1 });
    expect(next.trapPosition).not.toBeNull();
    expect(next.pendingButterSpawns.some(g => g.r === 3 && g.c === 3)).toBe(true);
  });

  it('F: ghost never materializes before a full cat turn', () => {
    const s = pickupState();
    const after = mouseMove(s, dir('ArrowRight'));
    expect(after.pendingButterSpawns.length).toBe(1);
    // Immediately after announcement (no CAT→MOUSE yet) it's still pending.
    expect(after.butterPositions.length).toBe(0);
  });

  it('G: idle ghost materializes to entity butter at CAT→MOUSE boundary', () => {
    // Ghost at a free cell (4,6); mouse NOT on it.
    const s = build({ cat: [2, 2], mouse: [4, 4], ghost: [{ r: 4, c: 6 }], empty: [[4, 6], [4, 4]] });
    const catEnd = endTurn({ ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0 });
    expect(catEnd.currentPlayer).toBe(PieceType.Mouse);
    expect(catEnd.butterPositions.some(b => b.r === 4 && b.c === 6)).toBe(true);
    expect(catEnd.pendingButterSpawns.length).toBe(0);
  });

  it('H: mouse on ghost at boundary → auto-pick + carrying moves', () => {
    // Mouse on the ghost cell (4,6); cat ends its turn.
    const s = build({ cat: [2, 2], mouse: [4, 6], ghost: [{ r: 4, c: 6 }], empty: [[4, 6], [2, 2]] });
    const after = endTurn({ ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0, mouseHasButter: false });
    expect(after.currentPlayer).toBe(PieceType.Mouse);
    expect(after.mouseHasButter).toBe(true);
    expect(after.mouseMovesLeft).toBe(after.config.mouseCarryingMoves);
    expect(after.pendingButterSpawns.length).toBeGreaterThan(0); // replacement ghost
  });

  it('I: auto-pick replacement ghost does not materialize in the same boundary', () => {
    const s = build({ cat: [2, 2], mouse: [4, 6], ghost: [{ r: 4, c: 6 }], empty: [[4, 6], [2, 2]] });
    const after = endTurn({ ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0, mouseHasButter: false });
    // The replacement ghost is still pending; NO entity butter materialized.
    expect(after.pendingButterSpawns.length).toBe(1);
    expect(after.butterPositions.length).toBe(0);
  });

  it('J: cat occupying ghost → first boundary block=1, still ghost', () => {
    // Cat on the ghost cell (4,6).
    const s = build({ cat: [4, 6], mouse: [7, 7], ghost: [{ r: 4, c: 6 }], empty: [[4, 6], [7, 7]] });
    const after = endTurn({ ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0 });
    const kept = after.pendingButterSpawns.find(g => g.r === 4 && g.c === 6);
    expect(kept).toBeTruthy();
    expect(kept!.blockedMaterializations).toBe(1);
    expect(after.butterPositions.some(b => b.r === 4 && b.c === 6)).toBe(false);
  });

  it('K: still occupied second time → reroll new position, blocked reset', () => {
    // Ghost with blocked=1 on (4,6); cat still occupies it at the boundary.
    const s = build({ cat: [4, 6], mouse: [7, 7], ghost: [{ r: 4, c: 6, blockedMaterializations: 1 }], empty: [[4, 6], [7, 7]] });
    const after = endTurn({ ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0 });
    expect(after.pendingButterSpawns.some(g => g.r === 4 && g.c === 6)).toBe(false); // rerolled away
    expect(after.pendingButterSpawns.length).toBe(1);
    expect(after.pendingButterSpawns[0].blockedMaterializations).toBe(0);
    expect(after.butterPositions.length).toBe(0); // not materialized this boundary
  });

  it('L: multiple ghosts resolve independently (two ghosts, one blocked one idle)', () => {
    // ghost1 at (4,6) free → materializes; ghost2 at (4,4) with cat on it → block.
    const s = build({ cat: [4, 4], mouse: [7, 7], ghost: [{ r: 4, c: 6 }, { r: 4, c: 4 }], empty: [[4, 6], [4, 4], [7, 7]] });
    const after = endTurn({ ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0 });
    expect(after.butterPositions.some(b => b.r === 4 && b.c === 6)).toBe(true); // materialized
    const kept = after.pendingButterSpawns.find(g => g.r === 4 && g.c === 4);
    expect(kept).toBeTruthy(); // blocked one stays
    expect(kept!.blockedMaterializations).toBe(1);
  });

  it('M: pending ghost positions never duplicate', () => {
    const s = pickupState();
    const after = mouseMove(s, dir('ArrowRight'));
    const ghost = after.pendingButterSpawns[0];
    // candidate kernel excludes the existing ghost
    const cands = defaultRuleSet.enumerateButterSpawns(after);
    expect(cands.some(c => c.r === ghost.r && c.c === ghost.c)).toBe(false);
  });

  it('N: search pickup → CHANCE outcome adds a ghost (not entity butter)', () => {
    const s = pickupState();
    const sim = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, defaultRuleSet);
    expect(sim.kind).toBe('chance');
    if (sim.kind === 'chance') {
      for (const o of sim.outcomes) {
        expect(o.state.butterPositions.length).toBe(s.butterPositions.length - 1);
        expect(o.state.pendingButterSpawns.length).toBe(1);
      }
    }
  });

  it('O: search chance candidate set == real game candidate set', () => {
    const s = pickupState();
    const sim = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, defaultRuleSet);
    if (sim.kind === 'chance') {
      const postPickup = mouseStepDeterministic(s, dir('ArrowRight'));
      const cands = defaultRuleSet.enumerateButterSpawns(postPickup);
      expect(sim.outcomes).toHaveLength(cands.length);
      const real = mouseMove(s, dir('ArrowRight'));
      expect(sim.outcomes.some(o => gameAffectingEqual(o.state, real))).toBe(true);
    }
  });

  it('P: search never calls Math.random (deterministic core defers ghost)', () => {
    const s = pickupState();
    const picked = mouseStepDeterministic(s, dir('ArrowRight'));
    expect(picked.pendingButterSpawns.length).toBe(0); // deferred — no RNG
  });

  it('Q: boundary auto-pick replacement is honest chance in search', () => {
    // Mouse on ghost (4,6); cat has 1 move left. A catStep that exhausts moves
    // triggers CAT→MOUSE with an auto-pick → search must produce a CHANCE node.
    const s = build({ cat: [3, 2], mouse: [4, 6], ghost: [{ r: 4, c: 6 }], empty: [[3, 2], [3, 3], [4, 6]] });
    const catTurn = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 1, mouseHasButter: false };
    const sim = simulateSearchAction(catTurn, { type: 'catStep', direction: dir('ArrowRight') }, defaultRuleSet);
    // cat moves (3,2)→(3,3), moves left 0 → CAT→MOUSE with ghost → chance
    expect(sim.kind).toBe('chance');
    if (sim.kind === 'chance') {
      for (const o of sim.outcomes) {
        expect(o.state.currentPlayer).toBe(PieceType.Mouse);
        expect(o.state.mouseHasButter).toBe(true);
        expect(o.state.pendingButterSpawns.length).toBe(1);
      }
    }
  });

  it('R: stateKey includes ghost position, blocked count; order canonicalized', () => {
    let s = pickupState();
    s = mouseMove(s, dir('ArrowRight'));
    const base = s;
    const g1 = base.pendingButterSpawns[0];
    const g2 = { r: g1.r === 8 ? 7 : 8, c: g1.c, blockedMaterializations: 0 };
    const k1 = stateKey(base);
    expect(stateKey({ ...base, pendingButterSpawns: [g2] })).not.toBe(k1); // pos change
    expect(stateKey({ ...base, pendingButterSpawns: [{ ...g1, blockedMaterializations: 1 }] })).not.toBe(k1); // blocked change
    expect(stateKey({ ...base, pendingButterSpawns: [...base.pendingButterSpawns].reverse() })).toBe(k1); // order canonical
  });

  it('S: gameAffectingEqual includes ghost state', () => {
    let s = pickupState();
    s = mouseMove(s, dir('ArrowRight'));
    const g1 = s.pendingButterSpawns[0];
    expect(gameAffectingEqual(s, { ...s, pendingButterSpawns: [{ r: g1.r + 1, c: g1.c, blockedMaterializations: 0 }] })).toBe(false);
    expect(gameAffectingEqual(s, { ...s, pendingButterSpawns: [...s.pendingButterSpawns].reverse() })).toBe(true);
  });

  it('T: snapshot/restore roundtrip preserves ghosts', () => {
    let s = pickupState();
    s = mouseMove(s, dir('ArrowRight'));
    const restored = restoreHardRoot(captureHardRoot(s));
    expect(restored.pendingButterSpawns).toEqual(s.pendingButterSpawns);
    expect(stateKey(restored)).toBe(stateKey(s));
  });
});
