/**
 * PPC-P1-OPENING-STACK-01 — OS-2 / OS-3 semantic gates.
 *
 * OS-2: a legal-but-large cat budget (`catBaseMoves = 100000`) must terminate
 * with a bounded verdict instead of a stack overflow, and must NOT hand out a
 * certified state.
 * OS-3: node-cap exhaustion, horizon exhaustion, malformed CHANCE, and a
 * normal depth-first settlement must all keep their original meanings, and no
 * finite budget may loop forever.
 */
import { describe, expect, it } from 'vitest';
import { createEngineRuleSet, createInitialState } from '../../src/game/engine';
import type { GameEngineState } from '../../src/game/engine';
import { DEFAULT_CONFIG, validateGameConfig } from '../../src/game/config';
import type { GameConfig } from '../../src/game/config';
import { CellType, GamePhase, PieceType } from '../../src/game/types';
import { createGameState } from '../../src/game/newGame';
import { certifyOpening } from '../../src/game/openingFairness';
import type { OpeningCertification } from '../../src/game/openingFairness';
import type { RuleSet } from '../../src/game/ai/searchTypes';

const pt = (r: number, c: number) => ({ r, c });

/** Deterministic 7x7 fixture builder (explicit terrain, no random draw). */
function fixture(cfg: Partial<GameConfig> = {}): GameEngineState {
  return createInitialState({
    ...DEFAULT_CONFIG,
    boardSize: 7,
    boxCount: 0,
    pileCount: 0,
    boxPositions: [],
    pilePositions: [],
    butterCount: 0,
    butterPositions: [],
    tunnelCorners: [{ r: 0, c: 0, label: 't' }],
    mouseHole: { r: 6, c: 0, size: 1 },
    mouseStart: pt(1, 1),
    catStart: pt(3, 4),
    ...cfg,
  } as GameConfig);
}

/** Cat walled in by boxes/piles: no permanent patrol entry, but a legal push. */
const boxedCat = () => fixture({
  boxPositions: [pt(2, 4)],
  pilePositions: [pt(4, 4), pt(3, 3), pt(3, 5)],
  butterCount: 1,
  butterPositions: [pt(6, 6)],
});

function wallOff(state: GameEngineState, open: { r: number; c: number }[]): GameEngineState {
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
 * CHANCE node is the root's entire action set (same technique as the production
 * `openingFairness.test.ts` D0 chance cases).
 */
function chanceRoot(buildChance: RuleSet['buildButterChance']): { base: GameEngineState; rules: RuleSet } {
  const rules: RuleSet = { ...createEngineRuleSet(), buildButterChance: buildChance };
  const raw = fixture({
    mouseStart: pt(3, 1),
    catStart: pt(6, 6),
    mouseHole: { r: 3, c: 3, size: 1 },
    butterCount: 1,
    butterPositions: [pt(3, 2)],
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

describe('OS-3 — the three-valued semantics are unchanged', () => {
  it('node-cap exhaustion is UNKNOWN/NODE_CAP and never a certificate', () => {
    const capped = certifyOpening(boxedCat(), { caps: { horizonTurns: 2, maxNodes: 1 } });
    expect(capped.verdict).toBe('UNKNOWN');
    expect(capped.reason).toBe('NODE_CAP');
    expect(capped.exploredNodes).toBe(1);

    // A bounded budget either decides before the cap or stops exactly AT it.
    const atCap = certifyOpening(boxedCat(), { caps: { horizonTurns: 3, maxNodes: 50 } });
    expect(atCap.exploredNodes).toBeLessThanOrEqual(50);
    if (atCap.verdict === 'UNKNOWN') expect(atCap.exploredNodes).toBe(50);
    console.log(`maxNodes=50 -> ${atCap.verdict} ${atCap.reason ?? ''} nodes=${atCap.exploredNodes}`);
  });

  it('horizon exhaustion is UNKNOWN/HORIZON on both prune settings', () => {
    const on = certifyOpening(boxedCat(), { caps: { horizonTurns: 1, maxNodes: 200000 } });
    const off = certifyOpening(boxedCat(), {
      caps: { horizonTurns: 1, maxNodes: 200000 }, relaxedPrune: false,
    });
    for (const c of [on, off]) {
      expect(c.verdict).toBe('UNKNOWN');
      expect(c.reason).toBe('HORIZON');
      expect(c.exploredNodes).toBeGreaterThan(1);
    }
    expect(on.exploredNodes).toBe(off.exploredNodes);
  });

  it('a horizon hit on a cat-turn root is UNKNOWN/HORIZON, never SAFE', () => {
    const catRoot: GameEngineState = {
      ...boxedCat(), phase: GamePhase.Playing, currentPlayer: PieceType.Cat, catMovesLeft: 2,
    };
    const cert = certifyOpening(catRoot, { caps: { horizonTurns: 0, maxNodes: 2000 } });
    expect(cert.verdict).toBe('UNKNOWN');
    expect(cert.reason).toBe('HORIZON');
    expect(cert.exploredNodes).toBe(1);
  });

  it('malformed CHANCE mass is INVALID_CHANCE before any SAFE short-circuit', () => {
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

    const shortMass = chanceRoot((st) => [
      { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
      { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.4 },
    ]);
    const short = certifyOpening(shortMass.base, {
      rules: shortMass.rules, caps: { horizonTurns: 1, maxNodes: 2000 },
    });
    expect(short.verdict).toBe('UNKNOWN');
    expect(short.reason).toBe('INVALID_CHANCE');

    // Control: the same SAFE-first list with legal mass certifies, so the
    // failures above come from the weights and not from the fixture.
    const control = safeFirst(0.5);
    const ok = certifyOpening(control.base, {
      rules: control.rules, caps: { horizonTurns: 1, maxNodes: 2000 },
    });
    expect(ok.verdict).toBe('CERTIFIED_NO_CERTAIN_CAT_LOSS');
  });

  it('a normal settlement still terminates at depth 1 with a witness', () => {
    const state = fixture({
      mouseStart: pt(3, 2),
      mouseHole: { r: 3, c: 3, size: 1 },
      catStart: pt(0, 3),
      butterCount: 1,
      butterPositions: [pt(3, 1)],
    });
    const cert = certifyOpening(state, { caps: { horizonTurns: 1, maxNodes: 20000 } });
    expect(cert.verdict).toBe('PROVEN_EARLY_FORCED_LOSS');
    expect(cert.witnessAction?.type).toBe('mouseStep');
    expect(cert.prunedNodes).toBe(0);
    expect(cert.exploredNodes).toBeLessThan(100);
  });

  it('repeated runs are deterministic (no hidden iteration order)', () => {
    for (const maxNodes of [50, 500, 5000]) {
      const a = certifyOpening(boxedCat(), { caps: { horizonTurns: 2, maxNodes } });
      const b = certifyOpening(boxedCat(), { caps: { horizonTurns: 2, maxNodes } });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe('OS-2 — deep legal budget', () => {
  it('catBaseMoves=100000 terminates bounded and never certifies', () => {
    const cfg: GameConfig = { ...DEFAULT_CONFIG, catBaseMoves: 100_000 };
    expect(validateGameConfig(cfg).ok).toBe(true);

    const state = createInitialState(cfg);
    expect(state.catMovesLeft).toBe(100_000);

    let cert: OpeningCertification | undefined;
    expect(() => { cert = certifyOpening(state); }).not.toThrow();
    const c = cert as OpeningCertification;
    console.log(`M=100000 -> ${c.verdict} ${c.reason ?? ''} nodes=${c.exploredNodes} pruned=${c.prunedNodes}`
      + ` heapUsedMB=${Math.round(process.memoryUsage().heapUsed / 1048576)}`);
    expect(c.exploredNodes).toBeLessThanOrEqual(c.maxNodes);
    expect(c.verdict).toBe('UNKNOWN');
    expect(c.reason).toBe('NODE_CAP');
    expect(c.witnessAction).toBeUndefined();
  }, 600_000);

  it('createGameState fails closed (no uncontrolled exception) for the same config', () => {
    const cfg: GameConfig = { ...DEFAULT_CONFIG, catBaseMoves: 100_000 };
    let res: ReturnType<typeof createGameState> | undefined;
    expect(() => { res = createGameState(cfg); }).not.toThrow();
    const r = res as ReturnType<typeof createGameState>;
    expect(r.state).toBeNull();
    expect(r.status.kind).toBe('unverified');
    console.log(`createGameState(M=100000) -> state=${r.state === null ? 'null' : 'present'}`
      + ` status=${r.status.kind}${r.status.kind === 'unverified' ? ':' + r.status.reason : ''}`);
  }, 900_000);

  it('M=1000 keeps its pre-fix verdict (a bounded UNKNOWN at the cap)', () => {
    const state = createInitialState({ ...DEFAULT_CONFIG, catBaseMoves: 1000 });
    const cert = certifyOpening(state);
    expect(cert.verdict).toBe('UNKNOWN');
    expect(cert.reason).toBe('NODE_CAP');
    expect(cert.exploredNodes).toBe(20000);
  }, 300_000);

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
