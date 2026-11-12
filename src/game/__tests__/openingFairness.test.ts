import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catMove, createEngineRuleSet, createInitialState, endTurn, mouseMove } from '../engine';
import type { GameEngineState } from '../engine';
import { DEFAULT_CONFIG } from '../config';
import type { GameConfig } from '../config';
import { CellType, DIRECTIONS, GamePhase, PieceType } from '../types';
import type { Direction } from '../types';
import { PHASE_B_CONFIG } from '../tutorial';
import {
  DEFAULT_OPENING_CAPS,
  SUPPORTED_BOARD_MAX,
  SUPPORTED_BOARD_MIN,
  certifyOpening,
  generateFairOpening,
  isCatPatrolEntry,
  isExplicitLayout,
} from '../openingFairness';
import { catHasLegalSpatialMove, noMoveLossVerdict } from '../rules/mobility';
import { simulateSearchAction } from '../ai/simulator';
import { stateKey } from '../ai/transposition';
import type { RuleSet } from '../ai/searchTypes';

type Point = { r: number; c: number };
const pt = (r: number, c: number): Point => ({ r, c });
const RIGHT: Direction = DIRECTIONS[3];

interface RbOpts {
  size: number;
  mouse: Point;
  cat: Point;
  hole: { r: number; c: number; size: number };
  butters?: Point[];
  boxes?: Point[];
  piles?: Point[];
  corners?: Point[];
  mouseHasButter?: boolean;
  mouseSkillActive?: boolean;
  mouseMoves?: number;
}

/**
 * Fully deterministic RULE-B fixture. Only boxCount/pileCount are set to 0 and
 * every position is explicit, so the board (terrain, boxes, butters, starts)
 * never depends on Math.random.
 */
function rbState(o: RbOpts): GameEngineState {
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    boardSize: o.size,
    mouseHole: o.hole,
    mouseStart: o.mouse,
    catStart: o.cat,
    boxCount: 0,
    pileCount: 0,
    boxPositions: o.boxes ?? [],
    pilePositions: o.piles ?? [],
    butterCount: (o.butters ?? []).length,
    butterPositions: o.butters ?? [],
    tunnelCorners: (o.corners ?? [pt(0, 0)]).map((c, i) => ({ r: c.r, c: c.c, label: `t${i}` })),
  };
  const base = createInitialState(config);
  return {
    ...base,
    mouseHasButter: o.mouseHasButter ?? false,
    mouseSkillActive: o.mouseSkillActive ?? false,
    mouseMovesLeft: o.mouseMoves ?? base.mouseMovesLeft,
  };
}

const H = (horizonTurns: number, maxNodes = 20000) => ({ caps: { horizonTurns, maxNodes } });

function wallOff(state: GameEngineState, open: Point[]): GameEngineState {
  const openSet = new Set(open.map((p) => `${p.r},${p.c}`));
  const board = state.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) return cell;
      if (openSet.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

/**
 * Mouse-turn root whose ONLY legal action is a butter pickup, so the injected
 * CHANCE node is the root's entire action set. The caller supplies the outcome
 * states; terminal phases make the aggregation quantifier explicit (the same
 * technique the expectiminimax D0 chance tests use). Only the WEIGHTS of those
 * outcomes are the certificate's business.
 */
function chanceRoot(buildChance: RuleSet['buildButterChance']): {
  base: GameEngineState;
  rules: RuleSet;
} {
  const rules: RuleSet = {
    ...createEngineRuleSet(),
    buildButterChance: buildChance,
  };
  const raw = rbState({
    size: 7,
    mouse: pt(3, 1),
    cat: pt(6, 6),
    hole: { r: 3, c: 3, size: 1 },
    butters: [pt(3, 2)],
  });
  // Keep only: mouse (3,1), butter (3,2), cat patrol pair (6,6)-(6,5). The
  // hole (3,3) survives wallOff; nothing else is reachable from the mouse.
  const walled = wallOff(raw, [pt(3, 1), pt(3, 2), pt(6, 6), pt(6, 5)]);
  const base: GameEngineState = {
    ...walled,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: raw.config.mouseBaseMoves,
    catMovesLeft: raw.config.catBaseMoves,
    mouseHasButter: false,
    mouseSkillActive: false,
  };
  return { base, rules };
}

// --- Fixtures (all previously probed) -------------------------------------

/** One-turn rush: butter adjacent to the mouse, hole 2 steps away, cat far. */
const rush = () => rbState({
  size: 7, mouse: pt(3, 2), cat: pt(0, 3), hole: { r: 3, c: 3, size: 1 }, butters: [pt(3, 1)],
});

/** Same pickup geometry, but a box at (2,2) and a defending cat at (1,2). */
const pushed = (cat: Point) => rbState({
  size: 7, mouse: pt(3, 5), cat, hole: { r: 3, c: 0, size: 1 }, butters: [pt(3, 4)], boxes: [pt(2, 2)],
});

/** Boxes (1,2) and (0,3) force the mouse to backtrack after the pickup. */
const detour = (boxes: Point[]) => rbState({
  size: 5, mouse: pt(0, 1), cat: pt(4, 2), hole: { r: 2, c: 2, size: 1 }, butters: [pt(0, 2)], boxes,
});

/** Tunnel route: the win needs chooseTunnel from (5,0) to (0,6). */
const tunnel = () => rbState({
  size: 8, mouse: pt(5, 1), cat: pt(7, 7), hole: { r: 1, c: 6, size: 1 },
  butters: [pt(5, 2), pt(0, 5)], corners: [pt(5, 0), pt(0, 6)],
});

/** Carrying start: only the skill's extra moves reach the hole inside turn 1. */
const skill = () => rbState({
  size: 8, mouse: pt(0, 1), cat: pt(7, 0), hole: { r: 1, c: 5, size: 1 },
  butters: [pt(0, 4)], corners: [pt(7, 7)], mouseHasButter: true,
});

const GEN_CONFIG: GameConfig = {
  ...DEFAULT_CONFIG,
  boardSize: 7,
  mouseHole: { r: 3, c: 3, size: 1 },
  mouseStart: { r: 3, c: 2 },
  catStart: { r: 0, c: 3 },
  boxCount: 0,
  pileCount: 0,
  boxPositions: [],
  pilePositions: [],
  butterCount: 2,
  butterPositions: [],
  tunnelCorners: [{ r: 0, c: 0, label: 'tl' }],
};
const UNFAIR_BUTTERS = [pt(3, 1), pt(6, 6)];
const FAIR_BUTTERS = [pt(0, 6), pt(6, 0)];

const sizedConfig = (size: number): GameConfig => ({
  ...DEFAULT_CONFIG,
  boardSize: size,
  mouseHole: { r: size - 2, c: size - 2, size: 1 },
  mouseStart: { r: 0, c: 0 },
  catStart: { r: 0, c: size - 1 },
  boxCount: 0,
  pileCount: 0,
  boxPositions: [],
  pilePositions: [],
  butterCount: 0,
  butterPositions: [],
  tunnelCorners: [{ r: 0, c: 0, label: 'tl' }],
});

describe('RULE-B — bounded opening fairness certification', () => {
  it('1. an unstoppable one-turn rush is PROVEN_EARLY_FORCED_LOSS', () => {
    const cert = certifyOpening(rush(), H(1));
    expect(cert.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');
    expect(cert.witnessAction?.type).toBe('mouseStep');
    expect(cert.exploredNodes).toBeLessThanOrEqual(cert.maxNodes);
    expect(cert.horizonTurns).toBe(1);
  });

  it('2. a full cat defence certifies SAFE inside a finite horizon', () => {
    const cert = certifyOpening(pushed(pt(1, 2)), H(2));
    expect(cert.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
    expect(cert.reason).toBeUndefined();
    expect(cert.exploredNodes).toBeLessThanOrEqual(cert.maxNodes);
  });

  it('3. boxes forcing a real detour turn a proven rush into SAFE', () => {
    const boxed = certifyOpening(detour([pt(1, 2), pt(0, 3)]), H(2));
    expect(boxed.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');

    const open = certifyOpening(detour([]), H(2));
    expect(open.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');
  });

  it('4. the cat (with a pushable box) is not misjudged as absent', () => {
    const defended = certifyOpening(pushed(pt(1, 2)), H(2));
    expect(defended.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');

    const undefended = certifyOpening(pushed(pt(6, 6)), H(2));
    expect(undefended.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');
  });

  it('5. a tunnel route is part of the certificate', () => {
    const cert = certifyOpening(tunnel(), H(2));
    expect(cert.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');
    expect(cert.witnessAction?.type).toBe('chooseTunnel');
    if (cert.witnessAction?.type === 'chooseTunnel') {
      expect({ r: cert.witnessAction.r, c: cert.witnessAction.c }).toEqual(pt(0, 6));
    }
  });

  it('6. the skill route is part of the certificate (and its absence refutes it)', () => {
    const withSkill = certifyOpening(skill(), H(1));
    expect(withSkill.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');

    const noSkill = certifyOpening({ ...skill(), mouseSkillActive: true }, H(1));
    expect(noSkill.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
  });

  it('7. an exhausted node cap is UNKNOWN, never SAFE', () => {
    const cert = certifyOpening(rush(), { caps: { horizonTurns: 1, maxNodes: 1 } });
    expect(cert.verdict).toBe('UNKNOWN');
    expect(cert.reason).toBe('NODE_CAP');
    expect(cert.exploredNodes).toBeLessThanOrEqual(1);
  });

  it('8. ghost chance follows real timing and uniform official probability', () => {
    const s = rbState({
      size: 7, mouse: pt(1, 1), cat: pt(0, 0), hole: { r: 5, c: 5, size: 1 }, butters: [pt(1, 2)],
    });
    const rules = createEngineRuleSet();
    const picked = simulateSearchAction(s, { type: 'mouseStep', direction: RIGHT }, rules);
    expect(picked.kind).toBe('chance');
    if (picked.kind !== 'chance') return;

    // Uniform 1/N over exactly the shared legal-spawn set.
    const postPickup = rules.mouseStep(s, RIGHT);
    const expected = rules.enumerateButterSpawns(postPickup);
    expect(picked.outcomes.length).toBe(expected.length);
    const sum = picked.outcomes.reduce((a, o) => a + o.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    picked.outcomes.forEach((o, i) => {
      expect(o.weight).toBeCloseTo(1 / picked.outcomes.length, 12);
      expect(o.state.pendingButterSpawns).toHaveLength(1);
      expect(o.state.butterPositions).toHaveLength(0); // announced, not materialized
      const g = o.state.pendingButterSpawns[0];
      expect({ r: g.r, c: g.c }).toEqual({ r: expected[i].r, c: expected[i].c });
      expect(g.r).toBeGreaterThanOrEqual(1);
      expect(g.c).toBeGreaterThanOrEqual(1);
      const dMouse = Math.abs(g.r - o.state.mousePosition.r) + Math.abs(g.c - o.state.mousePosition.c);
      const dCat = Math.abs(g.r - o.state.catPosition.r) + Math.abs(g.c - o.state.catPosition.c);
      const dHole = Math.abs(g.r - s.config.mouseHole.r) + Math.abs(g.c - s.config.mouseHole.c);
      expect(dMouse).toBeGreaterThanOrEqual(3);
      expect(dCat).toBeGreaterThanOrEqual(3);
      expect(dHole).toBeGreaterThanOrEqual(3);
    });

    // Materialization happens ONLY at the CAT→MOUSE boundary, not before.
    const ghostCell = picked.outcomes[0].state.pendingButterSpawns[0];
    const catTurn = endTurn(picked.outcomes[0].state);
    expect(catTurn.currentPlayer).toBe(PieceType.Cat);
    expect(catTurn.pendingButterSpawns).toHaveLength(1);
    expect(catTurn.butterPositions).toHaveLength(0);

    const back = endTurn(catTurn);
    expect(back.currentPlayer).toBe(PieceType.Mouse);
    expect(back.pendingButterSpawns).toHaveLength(0);
    expect(back.butterPositions).toEqual([{ r: ghostCell.r, c: ghostCell.c }]);
  });

  it('9. the generator rejects one unfair butter layout and accepts the next', () => {
    const res = generateFairOpening(GEN_CONFIG, {
      ...H(2),
      maxAttempts: 2,
      candidateButters: [UNFAIR_BUTTERS, FAIR_BUTTERS],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.counts.attempts).toBe(2);
    expect(res.counts.unsafe).toBe(1);
    expect(res.state.butterPositions).toEqual(FAIR_BUTTERS);
    expect(res.certification.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
  });

  it('10. UNKNOWN candidates are never accepted as fair', () => {
    const res = generateFairOpening(GEN_CONFIG, {
      caps: { horizonTurns: 2, maxNodes: 1 },
      maxAttempts: 2,
      candidateButters: [UNFAIR_BUTTERS, FAIR_BUTTERS],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('NO_CERTIFIED_OPENING');
    expect(res.counts.unknown).toBe(2);
    expect(res.counts.unsafe).toBe(0);
  });

  it('11. insufficient butter spots fail closed with a bounded attempt count', () => {
    const tooMany: GameConfig = {
      ...sizedConfig(5),
      butterCount: 5,
    };
    const res = generateFairOpening(tooMany, { maxAttempts: 3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('UNDER_GENERATED');
    expect(res.counts.attempts).toBe(3);
    expect(res.counts.underGenerated).toBe(3);
    expect(res.lastState).toBeUndefined();
  });

  it('12. explicit / tutorial / editor layouts are never regenerated', () => {
    const explicit: GameConfig = {
      ...GEN_CONFIG,
      butterCount: 1,
      butterPositions: [{ r: 5, c: 1 }],
    };
    expect(isExplicitLayout(explicit)).toBe(true);
    const explicitRes = generateFairOpening(explicit, { maxAttempts: 4 });
    expect(explicitRes.ok).toBe(false);
    if (explicitRes.ok) return;
    expect(explicitRes.reason).toBe('EXPLICIT_LAYOUT');
    expect(explicitRes.counts.attempts).toBe(0);
    expect(createInitialState(explicit).butterPositions).toEqual([{ r: 5, c: 1 }]);

    expect(isExplicitLayout(PHASE_B_CONFIG)).toBe(true);
    const tutorialRes = generateFairOpening(PHASE_B_CONFIG);
    expect(tutorialRes.ok).toBe(false);
    if (tutorialRes.ok) return;
    expect(tutorialRes.reason).toBe('EXPLICIT_LAYOUT');
    expect(tutorialRes.counts.attempts).toBe(0);
  });

  it('13. fixed inputs are deterministic', () => {
    const a = certifyOpening(tunnel(), H(2));
    const b = certifyOpening(tunnel(), H(2));
    expect(a.verdict).toBe(b.verdict);
    expect(a.exploredNodes).toBe(b.exploredNodes);
    expect(a.prunedNodes).toBe(b.prunedNodes);

    const g1 = generateFairOpening(GEN_CONFIG, {
      ...H(2), maxAttempts: 2, candidateButters: [UNFAIR_BUTTERS, FAIR_BUTTERS],
    });
    const g2 = generateFairOpening(GEN_CONFIG, {
      ...H(2), maxAttempts: 2, candidateButters: [UNFAIR_BUTTERS, FAIR_BUTTERS],
    });
    expect(g1.ok && g2.ok).toBe(true);
    if (g1.ok && g2.ok) expect(stateKey(g1.state)).toBe(stateKey(g2.state));
  });

  it('14. the default 10x10 / 2-butter auto opening certifies safe', () => {
    expect(DEFAULT_CONFIG.boardSize).toBe(10);
    expect(DEFAULT_CONFIG.butterCount).toBe(2);
    expect(isExplicitLayout(DEFAULT_CONFIG)).toBe(false);

    const res = generateFairOpening(DEFAULT_CONFIG);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope).toBe('AUTO');
    expect(res.state.butterPositions).toHaveLength(2);
    expect(res.certification.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');

    // The returned layout is itself stable under re-certification.
    const again = certifyOpening(res.state, { caps: res.certification });
    expect(again.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
  }, 120000);

  it('15. only board sizes 5..20 are supported (and UNKNOWN fails closed)', () => {
    expect(SUPPORTED_BOARD_MIN).toBe(5);
    expect(SUPPORTED_BOARD_MAX).toBe(20);

    for (const size of [4, 21]) {
      const st = createInitialState(sizedConfig(size));
      const cert = certifyOpening(st, H(2, 200));
      expect(cert.verdict).toBe('UNKNOWN');
      expect(cert.reason).toBe('UNSUPPORTED_CONFIG');
      const gen = generateFairOpening(sizedConfig(size), { maxAttempts: 1 });
      expect(gen.ok).toBe(false);
      if (!gen.ok) expect(gen.reason).toBe('UNSUPPORTED_CONFIG');
    }

    for (const size of [5, 20]) {
      const st = createInitialState(sizedConfig(size));
      const cert = certifyOpening(st, H(2, 200));
      expect(cert.reason).not.toBe('UNSUPPORTED_CONFIG');
      const gen = generateFairOpening(sizedConfig(size), H(2, 200));
      expect(gen.ok).toBe(true);
    }
  });

  it('16. the sound relaxed bound never changes a decided verdict', () => {
    const cases: [string, GameEngineState, number][] = [
      ['rush', rush(), 1],
      ['detour-boxed', detour([pt(1, 2), pt(0, 3)]), 2],
      ['pushed', pushed(pt(1, 2)), 2],
      ['tunnel', tunnel(), 2],
    ];
    for (const [name, state, h] of cases) {
      const on = certifyOpening(state, { caps: { horizonTurns: h, maxNodes: 200000 } });
      const off = certifyOpening(state, {
        caps: { horizonTurns: h, maxNodes: 200000 }, relaxedPrune: false,
      });
      expect(on.verdict, name).toBe(off.verdict);
      if (on.verdict !== 'UNKNOWN') {
        expect(on.verdict, name).not.toBe('UNKNOWN');
        expect(off.verdict, name).not.toBe('UNKNOWN');
      }
    }
  });

  it('17. generation is isolated from the AI evaluator and search budgets', () => {
    const src = readFileSync(fileURLToPath(new URL('../openingFairness.ts', import.meta.url)), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    expect(imports).not.toMatch(/hybridWeights|expectiminimax|searchConfig|hardTurnPlanner|sidecar/i);
    expect(src).not.toContain('compareSearchScore');
    expect(src).not.toContain('Math.random');
    // Full-game rules constants stay pinned by the module contract.
    expect(DEFAULT_OPENING_CAPS).toEqual({ maxNodes: 20000, horizonTurns: 3 });

    // No engine -> openingFairness runtime dependency (would be a cycle).
    const engineSrc = readFileSync(fileURLToPath(new URL('../engine.ts', import.meta.url)), 'utf8');
    expect(engineSrc).not.toContain('openingFairness');
  });

  it('18. the relaxed prune never dismisses a delayed-ghost cat stranding', () => {
    // 7x7: an isolated 2-cell cat corridor (top-left) and an isolated 2-cell
    // mouse corridor (bottom-right). One far initial butter keeps the relaxed
    // step count above the generous per-horizon upper bound, so the distance
    // prune WOULD fire here — unless a ghost is pending.
    const cfg: GameConfig = {
      ...DEFAULT_CONFIG,
      boardSize: 7,
      mouseHole: { r: 6, c: 0, size: 1 },
      mouseStart: pt(6, 6),
      catStart: pt(0, 1),
      boxCount: 0,
      pileCount: 0,
      boxPositions: [],
      pilePositions: [],
      butterCount: 1,
      butterPositions: [pt(0, 6)],
      tunnelCorners: [{ r: 3, c: 3, label: 'c' }],
      catBaseMoves: 2, // even: the forced corridor walk ends next to the ghost
    };
    const witness = (withGhost: boolean): GameEngineState => {
      const base = createInitialState(cfg);
      const walled = wallOff(base, [pt(0, 0), pt(0, 1), pt(0, 6), pt(6, 5), pt(6, 6)]);
      return {
        ...walled,
        phase: GamePhase.Playing,
        currentPlayer: PieceType.Mouse,
        mouseMovesLeft: cfg.mouseBaseMoves,
        catMovesLeft: cfg.catBaseMoves,
        catTrapsRemaining: 0, // no trap may neutralise the ghost
        trapPosition: null,
        pendingButterSpawns: withGhost
          ? [{ r: 0, c: 0, blockedMaterializations: 1 }] // delayed announcement
          : [],
      };
    };

    // Control: no pending ghost → the sound prune settles the position SAFE.
    const clean = certifyOpening(witness(false), H(2));
    expect(clean.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
    expect(clean.prunedNodes).toBeGreaterThan(0);

    // Witness: the delayed ghost materialises on the cat's only exit at the
    // CAT→MOUSE boundary and strands it (RULE-A) → a forced mouse win that the
    // premise-checked prune must not dismiss.
    const ghosted = certifyOpening(witness(true), H(2));
    expect(ghosted.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');

    // Direct engine replay of the claimed mechanism (not a distance model):
    // the mouse bounces out its 4 moves, the cat walks its forced 2 moves, and
    // the CAT→MOUSE boundary materialises the delayed ghost on the cat's only
    // exit → RULE-A stranded-cat MouseWins.
    const LEFT = DIRECTIONS[2];
    const RIGHT = DIRECTIONS[3];
    let replay = witness(true);
    for (let i = 0; i < 4; i++) replay = mouseMove(replay, i % 2 === 0 ? LEFT : RIGHT);
    expect(replay.currentPlayer).toBe(PieceType.Cat);
    expect(replay.catMovesLeft).toBe(2);
    replay = catMove(replay, LEFT);
    expect(replay.catPosition).toEqual(pt(0, 0));
    replay = catMove(replay, RIGHT);
    expect(replay.catPosition).toEqual(pt(0, 1));
    expect(replay.catMovesLeft).toBe(0);
    // CAT→MOUSE boundary: the delayed ghost materialises on (0,0), the cat's
    // only exit. The cat's own 0-move hand-off window is never re-judged, so
    // the verdict lands when the cat's NEXT turn starts with a real budget.
    replay = endTurn(replay);
    expect(replay.phase).toBe(GamePhase.Playing);
    expect(replay.butterPositions).toContainEqual(pt(0, 0));
    expect(replay.pendingButterSpawns).toHaveLength(0);
    for (let i = 0; i < 4; i++) replay = mouseMove(replay, i % 2 === 0 ? LEFT : RIGHT);
    expect(replay.phase).toBe(GamePhase.MouseWins);
    expect(replay.message).toBe('鼠获胜：猫已无路可走');

    // Differential: switching the prune off must not change either decided
    // verdict (the bound is only a shortcut, never a different rule).
    const cleanOff = certifyOpening(witness(false), { ...H(2), relaxedPrune: false });
    const ghostedOff = certifyOpening(witness(true), { ...H(2), relaxedPrune: false });
    expect(cleanOff.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
    expect(ghostedOff.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');
  });

  it('19. CHANCE quantifier: one SAFE outcome refutes a probability-1 win, B-class risk stays', () => {
    // 50% forced mouse win + 50% non-win. One SAFE outcome refutes ONLY the
    // probability-1 guarantee, so the opening is not a C-class PROVEN loss —
    // and the remaining positive-probability mouse win (B-class risk) is NOT
    // upgraded into a rejection.
    const { base, rules } = chanceRoot((st) => [
      { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.5 },
      { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
    ]);
    const mixed = certifyOpening(base, { rules, caps: { horizonTurns: 1, maxNodes: 2000 } });
    expect(mixed.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
    expect(mixed.witnessAction).toBeUndefined();

    // All positive-probability outcomes win → probability-1 forced win → the
    // C-class certain loss the certificate exists to exclude.
    const allWin = chanceRoot((st) => [
      { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.4 },
      { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.6 },
    ]);
    const certain = certifyOpening(allWin.base, {
      rules: allWin.rules, caps: { horizonTurns: 1, maxNodes: 2000 },
    });
    expect(certain.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');
    expect(certain.witnessAction?.type).toBe('mouseStep');
  });

  it('20. CHANCE weights are validated before the SAFE short-circuit', () => {
    // The FIRST listed outcome is SAFE. Every malformed weight must still be
    // reported as INVALID_CHANCE — never short-circuited into a certificate.
    const safeFirst = (badWeight: number) => chanceRoot((st) => [
      { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
      { state: { ...st, phase: GamePhase.MouseWins }, weight: badWeight },
    ]);

    for (const bad of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { base, rules } = safeFirst(bad);
      const cert = certifyOpening(base, { rules, caps: { horizonTurns: 1, maxNodes: 2000 } });
      expect(cert.verdict, `weight ${String(bad)}`).toBe('UNKNOWN');
      expect(cert.reason, `weight ${String(bad)}`).toBe('INVALID_CHANCE');
    }

    // Individually legal weights whose total mass is not 1 are equally invalid.
    const shortMass = chanceRoot((st) => [
      { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
      { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.4 },
    ]);
    const short = certifyOpening(shortMass.base, {
      rules: shortMass.rules, caps: { horizonTurns: 1, maxNodes: 2000 },
    });
    expect(short.verdict).toBe('UNKNOWN');
    expect(short.reason).toBe('INVALID_CHANCE');

    // Control: the same SAFE-first list with legal mass is certifiable, so the
    // failures above come from the weights, not from the fixture.
    const control = safeFirst(0.5);
    const ok = certifyOpening(control.base, {
      rules: control.rules, caps: { horizonTurns: 1, maxNodes: 2000 },
    });
    expect(ok.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
  });

  // ---------------------------------------------------------------------------
  // Patrol-entry legality (PPC-GAMEPLAY-01T)
  //
  // The cat can never enter a mouse hole or a tunnel corner (real `catMove`
  // rejects them before any capture), so a mouse standing on such a cell is not
  // a patrol entry. These fixtures are legal `createInitialState` layouts
  // (fixed terrain via explicit pile / corner / hole placement) — NOT
  // auto-generated openings. They show the predicate is unsound on a legal
  // state; no real AUTO-opening mis-certification was found or claimed.
  // ---------------------------------------------------------------------------

  /** Two of the cat's three non-target neighbours; the third is added per case. */
  const PATROL_PILES = [pt(4, 4), pt(3, 5)];

  /**
   * Cat (3,4), mouse (3,3). `kind` decides what the mouse stands on. With
   * `spareExit` the cat keeps an open (2,4) so RULE-A never settles a probe;
   * without it the mouse's cell is the ONLY candidate patrol admission.
   */
  function patrolFixture(kind: 'hole' | 'tunnel' | 'normal', spareExit: boolean): GameEngineState {
    return rbState({
      size: 7,
      mouse: pt(3, 3),
      cat: pt(3, 4),
      hole: kind === 'hole' ? { r: 3, c: 3, size: 1 } : { r: 0, c: 1, size: 1 },
      butters: [pt(0, 6)],
      piles: spareExit ? PATROL_PILES : [...PATROL_PILES, pt(2, 4)],
      corners: kind === 'tunnel' ? [pt(3, 3), pt(6, 6)] : [pt(6, 6)],
    });
  }

  it('21. the patrol-entry predicate matches real catMove enterability per direction', () => {
    const neighbours = DIRECTIONS.map((d) => ({ d, at: pt(3 + d.dr, 4 + d.dc) }));
    for (const kind of ['hole', 'tunnel', 'normal'] as const) {
      const state = patrolFixture(kind, true);
      // Cat-turn copy: (2,4) is open, so RULE-A never replaces the probe.
      const probe: GameEngineState = {
        ...state, currentPlayer: PieceType.Cat, catMovesLeft: 2, phase: GamePhase.Playing,
      };
      for (const { d, at } of neighbours) {
        const after = catMove(probe, d);
        const entered = after.phase === GamePhase.CatWins
          || (after.catPosition.r === at.r && after.catPosition.c === at.c);
        expect(entered, `${kind} ${d.label} -> (${at.r},${at.c})`)
          .toBe(isCatPatrolEntry(state, at.r, at.c));
      }

      // The mouse's own cell is a patrol entry only where the cat can step in.
      expect(isCatPatrolEntry(state, 3, 3), kind).toBe(kind === 'normal');

      const capture = catMove(probe, DIRECTIONS[2]); // LEFT, onto the mouse
      if (kind === 'normal') {
        expect(capture.phase).toBe(GamePhase.CatWins);
      } else {
        // Hole / tunnel corner: no capture, no move, budget untouched.
        expect(capture.phase).toBe(GamePhase.Playing);
        expect(capture.catPosition).toEqual(pt(3, 4));
        expect(capture.catMovesLeft).toBe(2);
      }
    }
  });

  it('22. without another exit, a hole/tunnel neighbour is never a patrol escape (prune on/off agree)', () => {
    for (const kind of ['hole', 'tunnel'] as const) {
      const state = patrolFixture(kind, false);
      expect(state.mousePosition).toEqual(pt(3, 3)); // the illegal neighbour
      expect(isCatPatrolEntry(state, 3, 3), kind).toBe(false);
      expect(catHasLegalSpatialMove(state), kind).toBe(false);

      // Real rules: the stranded cat is a mouse win, so any SAFE certificate
      // here would be a false "no certain cat loss".
      const catTurn: GameEngineState = {
        ...state, currentPlayer: PieceType.Cat, catMovesLeft: 2, phase: GamePhase.Playing,
      };
      expect(catMove(catTurn, DIRECTIONS[2]).phase, kind).toBe(GamePhase.MouseWins);
      expect(noMoveLossVerdict(catTurn)?.phase, kind).toBe(GamePhase.MouseWins);

      // Differential: neither prune setting may certify; the illegal
      // neighbour no longer proves a permanent patrol.
      const on = certifyOpening(state, H(1));
      const off = certifyOpening(state, { ...H(1), relaxedPrune: false });
      expect(on.verdict, `${kind} prune on`).toBe('PROVEN_EARLY_FORCED_LOSS');
      expect(off.verdict, `${kind} prune off`).toBe('PROVEN_EARLY_FORCED_LOSS');
      expect(on.prunedNodes, `${kind} must never prune`).toBe(0);
    }
  });

  it('23. a genuinely enterable neighbour still certifies SAFE through the prune', () => {
    const state = patrolFixture('normal', false);
    expect(state.mousePosition).toEqual(pt(3, 3));
    // Mouse on a plain cell: the cat can capture, and can patrol once it leaves.
    expect(isCatPatrolEntry(state, 3, 3)).toBe(true);
    expect(catHasLegalSpatialMove(state)).toBe(true);

    const on = certifyOpening(state, H(1));
    const off = certifyOpening(state, { ...H(1), relaxedPrune: false });
    expect(on.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
    expect(off.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
    expect(on.prunedNodes).toBeGreaterThan(0);
  });
});
