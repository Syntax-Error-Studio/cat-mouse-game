/**
 * PPC-P1-OPENING-STACK-01 — opening-fairness deep-budget stack safety.
 *
 * The production `solve()` used to be a recursive DFS. Its depth is proportional
 * to `catBaseMoves`, so a LEGAL budget (`catBaseMoves = 1500` and up, all of
 * which pass `validateGameConfig`) blew the JS call stack with
 * `RangeError: Maximum call stack size exceeded` before any verdict could be
 * produced. The solver is now an explicit-stack iterative DFS; these tests pin
 * the two things that must hold afterwards:
 *
 *   OS-2  a legal-but-large budget terminates with a BOUNDED verdict and never
 *         hands out a certificate it cannot prove;
 *   OS-3  node-cap / horizon / CHANCE / settlement semantics are unchanged, and
 *         the pre-fix node counts are reproduced exactly on fixed fixtures.
 *
 * The pinned counts in `PARITY` were captured from the recursive solver before
 * the rewrite (`PPC-P1-OPENING-STACK-01/_raw/parity_pre.json`); the iterative
 * solver reproduces all 50 captured cases byte-for-byte.
 */
import { describe, expect, it } from 'vitest';
import { createEngineRuleSet, createInitialState } from '../engine';
import type { GameEngineState } from '../engine';
import { DEFAULT_CONFIG, validateGameConfig } from '../config';
import type { GameConfig } from '../config';
import { CellType, GamePhase, PieceType } from '../types';
import { createGameState } from '../newGame';
import { certifyOpening } from '../openingFairness';
import type { OpeningCertification } from '../openingFairness';
import type { RuleSet } from '../ai/searchTypes';
import { stateKey } from '../ai/transposition';

type Point = { r: number; c: number };
const pt = (r: number, c: number): Point => ({ r, c });

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
}

/** Deterministic fixture: every terrain item is explicit, so no Math.random. */
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
  };
}

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

const H = (horizonTurns: number, maxNodes = 20000) => ({ caps: { horizonTurns, maxNodes } });

const rush = () => rbState({
  size: 7, mouse: pt(3, 2), cat: pt(0, 3), hole: { r: 3, c: 3, size: 1 }, butters: [pt(3, 1)],
});
const pushed = (cat: Point) => rbState({
  size: 7, mouse: pt(3, 5), cat, hole: { r: 3, c: 0, size: 1 }, butters: [pt(3, 4)], boxes: [pt(2, 2)],
});
const detour = (boxes: Point[]) => rbState({
  size: 5, mouse: pt(0, 1), cat: pt(4, 2), hole: { r: 2, c: 2, size: 1 }, butters: [pt(0, 2)], boxes,
});
const tunnel = () => rbState({
  size: 8, mouse: pt(5, 1), cat: pt(7, 7), hole: { r: 1, c: 6, size: 1 },
  butters: [pt(5, 2), pt(0, 5)], corners: [pt(5, 0), pt(0, 6)],
});
const skill = () => rbState({
  size: 8, mouse: pt(0, 1), cat: pt(7, 0), hole: { r: 1, c: 5, size: 1 },
  butters: [pt(0, 4)], corners: [pt(7, 7)], mouseHasButter: true,
});

const PATROL_PILES = [pt(4, 4), pt(3, 5)];
const patrolNormal = (spareExit: boolean) => rbState({
  size: 7, mouse: pt(3, 3), cat: pt(3, 4), hole: { r: 0, c: 1, size: 1 },
  butters: [pt(0, 6)],
  piles: spareExit ? PATROL_PILES : [...PATROL_PILES, pt(2, 4)],
  corners: [pt(6, 6)],
});

/**
 * Cat walled in by boxes/piles: no permanent patrol entry, so the relaxed prune
 * cannot fire and the search has to walk to the horizon to stop.
 */
const boxedCat = () => rbState({
  size: 7, mouse: pt(1, 1), cat: pt(3, 4), hole: { r: 6, c: 0, size: 1 },
  boxes: [pt(2, 4)],
  piles: [pt(4, 4), pt(3, 3), pt(3, 5)],
  butters: [pt(6, 6)],
});

function ghostWitness(withGhost: boolean): GameEngineState {
  const cfg: GameConfig = {
    ...DEFAULT_CONFIG,
    boardSize: 7,
    mouseHole: { r: 6, c: 0, size: 1 },
    mouseStart: pt(6, 6),
    catStart: pt(0, 1),
    boxCount: 0, pileCount: 0, boxPositions: [], pilePositions: [],
    butterCount: 1, butterPositions: [pt(0, 6)],
    tunnelCorners: [{ r: 3, c: 3, label: 'c' }],
    catBaseMoves: 2,
  };
  const base = createInitialState(cfg);
  const walled = wallOff(base, [pt(0, 0), pt(0, 1), pt(0, 6), pt(6, 5), pt(6, 6)]);
  return {
    ...walled,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: cfg.mouseBaseMoves,
    catMovesLeft: cfg.catBaseMoves,
    catTrapsRemaining: 0,
    trapPosition: null,
    pendingButterSpawns: withGhost ? [{ r: 0, c: 0, blockedMaterializations: 1 }] : [],
  };
}

/**
 * Mouse-turn root whose ONLY legal action is a butter pickup, so the injected
 * CHANCE node is the root's entire action set.
 */
function chanceRoot(buildChance: RuleSet['buildButterChance']): {
  base: GameEngineState;
  rules: RuleSet;
} {
  const rules: RuleSet = { ...createEngineRuleSet(), buildButterChance: buildChance };
  const raw = rbState({
    size: 7, mouse: pt(3, 1), cat: pt(6, 6), hole: { r: 3, c: 3, size: 1 }, butters: [pt(3, 2)],
  });
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

// ---------------------------------------------------------------------------
// Determinism seam for the randomized opening.
//
// `DEFAULT_CONFIG` has no explicit terrain: `createInitialState` scatters boxes,
// piles and butters with native `Math.random`, so an unseeded build certifies a
// DIFFERENT board on every run and its node count says nothing about the
// solver. The OS-2 budgets are deep enough that the verdict is cap-bound either
// way, but "happens to be stable" is not a measurement — the board has to be
// fixed for the numbers to mean anything.
//
// This is the same replacement the parity probe uses (a seeded LCG), installed
// for exactly one call and removed in `finally`; the draw count is returned so a
// caller can prove the seed was in force AND that the native RNG came back.
// ---------------------------------------------------------------------------

/** Fixed seed for every randomized-opening build in this file. */
const OPENING_SEED = 4242;

function withSeededRandom<T>(seedInit: number, fn: () => T): { value: T; draws: number } {
  const native = Math.random;
  let draws = 0;
  let seed = seedInit >>> 0;
  Math.random = () => {
    draws++;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  try {
    return { value: fn(), draws };
  } finally {
    Math.random = native;
  }
}

/** Deterministic `createInitialState` for a config that randomizes its terrain. */
function seededOpening(cfg: GameConfig, seed = OPENING_SEED): { state: GameEngineState; draws: number } {
  const r = withSeededRandom(seed, () => createInitialState(cfg));
  return { state: r.value, draws: r.draws };
}

// ---------------------------------------------------------------------------
// OS-2 — legal-but-large budgets must terminate bounded, never overflow.
// ---------------------------------------------------------------------------

describe('OS-2 legal deep budgets terminate bounded (pre-fix: RangeError)', () => {
  it('catBaseMoves=100000 is accepted and never throws', () => {
    const cfg: GameConfig = { ...DEFAULT_CONFIG, catBaseMoves: 100_000 };
    expect(validateGameConfig(cfg).ok).toBe(true);

    const native = Math.random;
    const built = seededOpening(cfg);
    expect(built.draws).toBeGreaterThan(0); // the seeded scatter really ran
    expect(Math.random).toBe(native); // and the native RNG is back before asserting

    const state = built.state;
    expect(state.catMovesLeft).toBe(100_000);

    let cert: OpeningCertification | undefined;
    expect(() => { cert = certifyOpening(state); }).not.toThrow();
    const c = cert as OpeningCertification;

    // Bounded: the node cap is the terminator, not the call stack.
    expect(c.exploredNodes).toBeLessThanOrEqual(c.maxNodes);
    expect(c.exploredNodes).toBe(20000);
    // And an exhausted budget proves nothing about the opening.
    expect(c.verdict).toBe('UNKNOWN');
    expect(c.reason).toBe('NODE_CAP');
    expect(c.witnessAction).toBeUndefined();
  }, 600_000);

  it('createGameState fails closed instead of overflowing for the same config', () => {
    const cfg: GameConfig = { ...DEFAULT_CONFIG, catBaseMoves: 100_000 };
    const native = Math.random;
    const built = withSeededRandom(OPENING_SEED, () => createGameState(cfg));
    expect(built.draws).toBeGreaterThan(0);
    expect(Math.random).toBe(native);
    let res: ReturnType<typeof createGameState> | undefined;
    expect(() => { res = built.value; }).not.toThrow();
    const r = res as ReturnType<typeof createGameState>;
    expect(r.state).toBeNull();
    expect(r.status.kind).toBe('unverified');
    expect(r.status.kind === 'unverified' && r.status.reason).toBe('NO_CERTIFIED_OPENING');
  }, 900_000);

  it('budgets past the old recursion ceiling all terminate with UNKNOWN/NODE_CAP', () => {
    // 1500 was the first budget that overflowed on the recursive solver (the
    // stack ceiling sat between 1000 and 1500 on this machine); 20000 is
    // comfortably past it.
    const native = Math.random;
    for (const m of [1500, 20000]) {
      const built = seededOpening({ ...DEFAULT_CONFIG, catBaseMoves: m });
      expect(built.draws, `M=${m}`).toBeGreaterThan(0);
      expect(Math.random, `M=${m}`).toBe(native);
      const c = certifyOpening(built.state);
      expect(c.verdict, `M=${m}`).toBe('UNKNOWN');
      expect(c.reason, `M=${m}`).toBe('NODE_CAP');
      expect(c.exploredNodes, `M=${m}`).toBe(20000);
    }
  }, 600_000);

  it('M=1000 keeps its pre-fix verdict exactly (UNKNOWN/NODE_CAP at the cap)', () => {
    const native = Math.random;
    const built = seededOpening({ ...DEFAULT_CONFIG, catBaseMoves: 1000 });
    expect(built.draws).toBeGreaterThan(0);
    expect(Math.random).toBe(native);
    const c = certifyOpening(built.state);
    expect(c.verdict).toBe('UNKNOWN');
    expect(c.reason).toBe('NODE_CAP');
    expect(c.exploredNodes).toBe(20000);
  }, 300_000);

  it('the same seed rebuilds the same opening, a different seed does not', () => {
    // Without this the node counts above would be measuring whichever board the
    // ambient RNG produced; with it they are a property of the solver.
    const cfg: GameConfig = { ...DEFAULT_CONFIG, catBaseMoves: 4 };
    const native = Math.random;

    const a = seededOpening(cfg);
    expect(Math.random).toBe(native);
    const b = seededOpening(cfg);
    expect(b.draws).toBe(a.draws); // identical draw count ⇒ identical code path
    expect(a.draws).toBeGreaterThan(0); // the scatter is random, so the seed matters
    expect(stateKey(b.state)).toBe(stateKey(a.state));

    const other = seededOpening(cfg, OPENING_SEED + 1);
    expect(stateKey(other.state)).not.toBe(stateKey(a.state));

    // The seeded board is still a legal opening: the seam only fixes the draw.
    expect(validateGameConfig(cfg).ok).toBe(true);
    expect(a.state.phase).toBe(GamePhase.Playing);
  });

  it('the numeric domain still rejects the unrepresentable budget at config level', () => {
    const cfg: GameConfig = { ...DEFAULT_CONFIG, catBaseMoves: 6004799503160661 };
    const v = validateGameConfig(cfg);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.kind === 'invalid')).toBe(true);
    expect(() => createInitialState(cfg)).toThrow(RangeError);
    const res = createGameState(cfg);
    expect(res.state).toBeNull();
    expect(res.status.kind === 'unverified' && res.status.reason).toBe('INVALID_CONFIG');
  });
});

// ---------------------------------------------------------------------------
// OS-3 — the three-valued semantics and the budgets that stop them.
// ---------------------------------------------------------------------------

describe('OS-3 budget and CHANCE semantics are unchanged', () => {
  it('node-cap exhaustion is UNKNOWN/NODE_CAP, never a certificate', () => {
    const capped = certifyOpening(rush(), { caps: { horizonTurns: 1, maxNodes: 1 } });
    expect(capped.verdict).toBe('UNKNOWN');
    expect(capped.reason).toBe('NODE_CAP');
    expect(capped.exploredNodes).toBe(1);

    const atCap = certifyOpening(pushed(pt(1, 2)), { caps: { horizonTurns: 2, maxNodes: 50 } });
    expect(atCap.exploredNodes).toBeLessThanOrEqual(50);
    if (atCap.verdict === 'UNKNOWN') expect(atCap.exploredNodes).toBe(50);
  });

  it('horizon exhaustion is UNKNOWN/HORIZON and the relaxed prune does not change it', () => {
    const on = certifyOpening(boxedCat(), { caps: { horizonTurns: 1, maxNodes: 200000 } });
    const off = certifyOpening(boxedCat(), {
      caps: { horizonTurns: 1, maxNodes: 200000 }, relaxedPrune: false,
    });
    for (const [label, c] of [['on', on], ['off', off]] as const) {
      expect(c.verdict, label).toBe('UNKNOWN');
      expect(c.reason, label).toBe('HORIZON');
      expect(c.exploredNodes, label).toBeGreaterThan(1);
    }
    expect(on.exploredNodes).toBe(off.exploredNodes);
  });

  it('malformed CHANCE mass is INVALID_CHANCE even when a SAFE outcome is listed first', () => {
    // The first outcome is SAFE: a short-circuit on it would be a false
    // certificate, so mass validation must complete before any outcome is solved.
    const safeFirst = (badWeight: number) => chanceRoot((st) => [
      { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
      { state: { ...st, phase: GamePhase.MouseWins }, weight: badWeight },
    ]);
    for (const bad of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { base, rules } = safeFirst(bad);
      const c = certifyOpening(base, { rules, caps: { horizonTurns: 1, maxNodes: 2000 } });
      expect(c.verdict, `weight ${String(bad)}`).toBe('UNKNOWN');
      expect(c.reason, `weight ${String(bad)}`).toBe('INVALID_CHANCE');
    }

    const shortMass = chanceRoot((st) => [
      { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
      { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.4 },
    ]);
    const short = certifyOpening(shortMass.base, {
      rules: shortMass.rules, caps: { horizonTurns: 1, maxNodes: 2000 },
    });
    expect(short.verdict).toBe('UNKNOWN');
    expect(short.reason).toBe('INVALID_CHANCE');

    // Control: legal mass on the same SAFE-first list certifies, so the
    // failures above come from the weights and not from the fixture.
    const control = safeFirst(0.5);
    const ok = certifyOpening(control.base, {
      rules: control.rules, caps: { horizonTurns: 1, maxNodes: 2000 },
    });
    expect(ok.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
  });

  it('a normal settlement still terminates with its witness', () => {
    const c = certifyOpening(rush(), H(1));
    expect(c.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');
    expect(c.witnessAction?.type).toBe('mouseStep');
    expect(c.exploredNodes).toBe(19);
    expect(c.prunedNodes).toBe(0);
  });

  it('repeated runs are deterministic (no hidden iteration order)', () => {
    for (const maxNodes of [50, 500, 5000]) {
      const a = certifyOpening(pushed(pt(1, 2)), { caps: { horizonTurns: 2, maxNodes } });
      const b = certifyOpening(pushed(pt(1, 2)), { caps: { horizonTurns: 2, maxNodes } });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

// ---------------------------------------------------------------------------
// Pinned node counts: the iterative DFS must explore and prune EXACTLY as many
// nodes as the recursive one did on the same input.
// ---------------------------------------------------------------------------

describe('PARITY pinned counts (captured from the recursive solver)', () => {
  const PARITY: {
    name: string;
    build: () => GameEngineState;
    opts?: Parameters<typeof certifyOpening>[1];
    verdict: string;
    reason?: string | null;
    explored: number;
    pruned: number;
  }[] = [
    { name: 'rush_h1', build: rush, opts: H(1), verdict: 'PROVEN_EARLY_FORCED_LOSS', reason: null, explored: 19, pruned: 0 },
    { name: 'pushed_defended_h2', build: () => pushed(pt(1, 2)), opts: H(2), verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', reason: null, explored: 2004, pruned: 102 },
    { name: 'pushed_undefended_h2', build: () => pushed(pt(6, 6)), opts: H(2), verdict: 'PROVEN_EARLY_FORCED_LOSS', reason: null, explored: 2209, pruned: 0 },
    { name: 'detour_boxed_h2', build: () => detour([pt(1, 2), pt(0, 3)]), opts: H(2), verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', reason: null, explored: 792, pruned: 12 },
    { name: 'detour_open_h2', build: () => detour([]), opts: H(2), verdict: 'PROVEN_EARLY_FORCED_LOSS', reason: null, explored: 4, pruned: 0 },
    { name: 'tunnel_h2', build: tunnel, opts: H(2), verdict: 'PROVEN_EARLY_FORCED_LOSS', reason: null, explored: 4839, pruned: 3 },
    { name: 'skill_h1', build: skill, opts: H(1), verdict: 'PROVEN_EARLY_FORCED_LOSS', reason: null, explored: 91, pruned: 0 },
    { name: 'skill_used_h1', build: () => ({ ...skill(), mouseSkillActive: true }), opts: H(1), verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', reason: null, explored: 1, pruned: 1 },
    { name: 'tunnel_h2_noPrune', build: tunnel, opts: { ...H(2), relaxedPrune: false }, verdict: 'PROVEN_EARLY_FORCED_LOSS', reason: null, explored: 4849, pruned: 0 },
    { name: 'pushed_h2_noPrune', build: () => pushed(pt(1, 2)), opts: { ...H(2), relaxedPrune: false }, verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', reason: null, explored: 3471, pruned: 0 },
    { name: 'ghost_clean', build: () => ghostWitness(false), opts: H(2), verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', reason: null, explored: 1, pruned: 1 },
    { name: 'ghost_pending', build: () => ghostWitness(true), opts: H(2), verdict: 'PROVEN_EARLY_FORCED_LOSS', reason: null, explored: 11, pruned: 0 },
    { name: 'ghost_clean_noPrune', build: () => ghostWitness(false), opts: { ...H(2), relaxedPrune: false }, verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', reason: null, explored: 11, pruned: 0 },
    { name: 'patrol_normal_spare', build: () => patrolNormal(true), opts: H(1), verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', reason: null, explored: 1, pruned: 1 },
    { name: 'patrol_normal_noSpare_on', build: () => patrolNormal(false), opts: H(1), verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', reason: null, explored: 1, pruned: 1 },
    { name: 'patrol_normal_noSpare_off', build: () => patrolNormal(false), opts: { ...H(1), relaxedPrune: false }, verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', reason: null, explored: 78, pruned: 0 },
  ];

  for (const c of PARITY) {
    it(`${c.name} → ${c.verdict} nodes=${c.explored} pruned=${c.pruned}`, () => {
      const r = certifyOpening(c.build(), c.opts);
      expect(r.verdict).toBe(c.verdict);
      expect(r.reason ?? null).toBe(c.reason ?? null);
      expect(r.exploredNodes).toBe(c.explored);
      expect(r.prunedNodes).toBe(c.pruned);
    });
  }
});
