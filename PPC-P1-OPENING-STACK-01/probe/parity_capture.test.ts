/**
 * PPC-P1-OPENING-STACK-01 — semantic parity capture (READ ONLY).
 *
 * Records EVERY observable field of the certificate for a fixed case list, so
 * the pre-fix and post-fix outputs can be compared byte-for-byte:
 *   verdict / reason / horizonTurns / maxNodes / exploredNodes / prunedNodes /
 *   witnessAction, plus generation counts and the exact number of Math.random
 *   draws consumed.
 *
 * Run with PARITY_PHASE=pre|post; it writes `_raw/parity_<phase>.json`.
 * Math.random is replaced by a seeded LCG ONLY inside this probe (restored in
 * `finally`), so the default 10x10 terrain/butter draw is reproducible; the
 * draw COUNTER is the parity measurement, not the value.
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { endTurn, createEngineRuleSet, createInitialState } from '../../src/game/engine';
import type { GameEngineState } from '../../src/game/engine';
import { DEFAULT_CONFIG } from '../../src/game/config';
import type { GameConfig } from '../../src/game/config';
import { CellType, DIRECTIONS, GamePhase, PieceType } from '../../src/game/types';
import type { Direction } from '../../src/game/types';
import { PHASE_B_CONFIG } from '../../src/game/tutorial';
import {
  certifyOpening,
  generateFairOpening,
  isCatPatrolEntry,
  isExplicitLayout,
} from '../../src/game/openingFairness';
import type { OpeningCertification } from '../../src/game/openingFairness';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { stateKey } from '../../src/game/ai/transposition';
import type { RuleSet } from '../../src/game/ai/searchTypes';

type Point = { r: number; c: number };
const pt = (r: number, c: number): Point => ({ r, c });
const RIGHT: Direction = DIRECTIONS[3];
const PHASE = process.env.PARITY_PHASE ?? 'unknown';

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

const GEN_CONFIG: GameConfig = {
  ...DEFAULT_CONFIG,
  boardSize: 7,
  mouseHole: { r: 3, c: 3, size: 1 },
  mouseStart: { r: 3, c: 2 },
  catStart: { r: 0, c: 3 },
  boxCount: 0, pileCount: 0, boxPositions: [], pilePositions: [],
  butterCount: 2, butterPositions: [],
  tunnelCorners: [{ r: 0, c: 0, label: 'tl' }],
};
const UNFAIR_BUTTERS = [pt(3, 1), pt(6, 6)];
const FAIR_BUTTERS = [pt(0, 6), pt(6, 0)];

const PATROL_PILES = [pt(4, 4), pt(3, 5)];
function patrolFixture(kind: 'hole' | 'tunnel' | 'normal', spareExit: boolean): GameEngineState {
  return rbState({
    size: 7, mouse: pt(3, 3), cat: pt(3, 4),
    hole: kind === 'hole' ? { r: 3, c: 3, size: 1 } : { r: 0, c: 1, size: 1 },
    butters: [pt(0, 6)],
    piles: spareExit ? PATROL_PILES : [...PATROL_PILES, pt(2, 4)],
    corners: kind === 'tunnel' ? [pt(3, 3), pt(6, 6)] : [pt(6, 6)],
  });
}

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

/** Full, field-by-field record of a certificate. */
function cert(state: GameEngineState, opts: Parameters<typeof certifyOpening>[1] = {}): unknown {
  const c: OpeningCertification = certifyOpening(state, opts);
  return {
    verdict: c.verdict,
    reason: c.reason ?? null,
    horizonTurns: c.horizonTurns,
    maxNodes: c.maxNodes,
    exploredNodes: c.exploredNodes,
    prunedNodes: c.prunedNodes,
    witnessAction: c.witnessAction ? JSON.parse(JSON.stringify(c.witnessAction)) : null,
  };
}

const results: Record<string, unknown> = {};

/**
 * Run `fn` with a seeded, draw-counting Math.random replacement and restore the
 * original in `finally`. Used ONLY inside this probe: the terrain/butter draw of
 * a real config must be reproducible for the node count to mean anything, and
 * the DRAW COUNT is itself a parity metric.
 */
function seeded<T>(seedInit: number, fn: () => T): { value: T; draws: number } {
  const realRandom = Math.random;
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
    Math.random = realRandom;
  }
}

it('capture semantic parity for the frozen case list', () => {
  // ---- certification fixtures -------------------------------------------
  results['rush_h1'] = cert(rush(), H(1));
  results['rush_h1_cap1'] = cert(rush(), { caps: { horizonTurns: 1, maxNodes: 1 } });
  results['pushed_defended_h2'] = cert(pushed(pt(1, 2)), H(2));
  results['pushed_undefended_h2'] = cert(pushed(pt(6, 6)), H(2));
  results['detour_boxed_h2'] = cert(detour([pt(1, 2), pt(0, 3)]), H(2));
  results['detour_open_h2'] = cert(detour([]), H(2));
  results['tunnel_h2'] = cert(tunnel(), H(2));
  results['skill_h1'] = cert(skill(), H(1));
  results['skill_used_h1'] = cert({ ...skill(), mouseSkillActive: true }, H(1));
  results['rush_h1_noPrune'] = cert(rush(), { ...H(1), relaxedPrune: false });
  results['pushed_h2_noPrune'] = cert(pushed(pt(1, 2)), { ...H(2), relaxedPrune: false });
  results['tunnel_h2_noPrune'] = cert(tunnel(), { ...H(2), relaxedPrune: false });

  // deep-budget cases (the ones with a real node count, still small boards)
  results['rush_h1_cap200k'] = cert(rush(), { caps: { horizonTurns: 1, maxNodes: 200000 } });
  results['pushed_h2_cap200k'] = cert(pushed(pt(1, 2)), { caps: { horizonTurns: 2, maxNodes: 200000 } });
  results['pushed_h2_cap200k_noPrune'] = cert(pushed(pt(1, 2)), {
    caps: { horizonTurns: 2, maxNodes: 200000 }, relaxedPrune: false,
  });
  results['tunnel_h2_cap200k'] = cert(tunnel(), { caps: { horizonTurns: 2, maxNodes: 200000 } });
  results['detour_boxed_h2_cap200k'] = cert(detour([pt(1, 2), pt(0, 3)]), {
    caps: { horizonTurns: 2, maxNodes: 200000 },
  });

  // ---- CHANCE quantifier ------------------------------------------------
  const mixed = chanceRoot((st) => [
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.5 },
    { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
  ]);
  results['chance_mixed'] = cert(mixed.base, { rules: mixed.rules, caps: { horizonTurns: 1, maxNodes: 2000 } });

  const allWin = chanceRoot((st) => [
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.4 },
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.6 },
  ]);
  results['chance_allWin'] = cert(allWin.base, { rules: allWin.rules, caps: { horizonTurns: 1, maxNodes: 2000 } });

  for (const bad of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { base, rules } = chanceRoot((st) => [
      { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
      { state: { ...st, phase: GamePhase.MouseWins }, weight: bad },
    ]);
    results[`chance_badWeight_${String(bad)}`] = cert(base, { rules, caps: { horizonTurns: 1, maxNodes: 2000 } });
  }
  const shortMass = chanceRoot((st) => [
    { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.4 },
  ]);
  results['chance_shortMass'] = cert(shortMass.base, { rules: shortMass.rules, caps: { horizonTurns: 1, maxNodes: 2000 } });

  const safeFirst = chanceRoot((st) => [
    { state: { ...st, phase: GamePhase.CatWins }, weight: 0.5 },
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.5 },
  ]);
  results['chance_safeFirst_control'] = cert(safeFirst.base, {
    rules: safeFirst.rules, caps: { horizonTurns: 1, maxNodes: 2000 },
  });

  // ---- deep-chain CHANCE (outcome order must not be reordered) ----------
  // 4 outcomes with distinct weights; the first SAFE short-circuits, so the
  // number of explored nodes records exactly how many outcomes were solved.
  const quad = chanceRoot((st) => [
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.1 },
    { state: { ...st, phase: GamePhase.CatWins }, weight: 0.2 },
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.3 },
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.4 },
  ]);
  results['chance_quad_safeSecond'] = cert(quad.base, { rules: quad.rules, caps: { horizonTurns: 1, maxNodes: 2000 } });

  const quadLastSafe = chanceRoot((st) => [
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.1 },
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.2 },
    { state: { ...st, phase: GamePhase.MouseWins }, weight: 0.3 },
    { state: { ...st, phase: GamePhase.CatWins }, weight: 0.4 },
  ]);
  results['chance_quad_safeLast'] = cert(quadLastSafe.base, {
    rules: quadLastSafe.rules, caps: { horizonTurns: 1, maxNodes: 2000 },
  });

  // ---- delayed-ghost prune witness (test 18) ---------------------------
  results['ghost_clean'] = cert(ghostWitness(false), H(2));
  results['ghost_pending'] = cert(ghostWitness(true), H(2));
  results['ghost_clean_noPrune'] = cert(ghostWitness(false), { ...H(2), relaxedPrune: false });
  results['ghost_pending_noPrune'] = cert(ghostWitness(true), { ...H(2), relaxedPrune: false });

  // ---- patrol-entry legality (tests 21-23) -----------------------------
  for (const kind of ['hole', 'tunnel', 'normal'] as const) {
    results[`patrol_${kind}_spare`] = cert(patrolFixture(kind, true), H(1));
    results[`patrol_${kind}_noSpare_on`] = cert(patrolFixture(kind, false), H(1));
    results[`patrol_${kind}_noSpare_off`] = cert(patrolFixture(kind, false), { ...H(1), relaxedPrune: false });
  }

  // ---- generator (deterministic candidate list) ------------------------
  const gen = generateFairOpening(GEN_CONFIG, {
    ...H(2), maxAttempts: 2, candidateButters: [UNFAIR_BUTTERS, FAIR_BUTTERS],
  });
  results['gen_twoCandidates'] = gen.ok
    ? {
      ok: true, scope: gen.scope, counts: gen.counts,
      verdict: gen.certification.verdict,
      exploredNodes: gen.certification.exploredNodes,
      prunedNodes: gen.certification.prunedNodes,
      butters: gen.state.butterPositions, stateKey: stateKey(gen.state),
    }
    : { ok: false, reason: gen.reason, counts: gen.counts };

  const genUnknown = generateFairOpening(GEN_CONFIG, {
    caps: { horizonTurns: 2, maxNodes: 1 }, maxAttempts: 2,
    candidateButters: [UNFAIR_BUTTERS, FAIR_BUTTERS],
  });
  results['gen_unknown'] = genUnknown.ok
    ? { ok: true }
    : { ok: false, reason: genUnknown.reason, counts: genUnknown.counts };

  results['gen_explicit'] = (() => {
    const r = generateFairOpening({ ...GEN_CONFIG, butterCount: 1, butterPositions: [pt(5, 1)] });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason, counts: r.counts };
  })();
  results['gen_tutorial'] = (() => {
    const r = generateFairOpening(PHASE_B_CONFIG);
    return { isExplicit: isExplicitLayout(PHASE_B_CONFIG), ok: r.ok, reason: r.ok ? null : r.reason };
  })();
  results['patrolEntry_predicates'] = [
    isCatPatrolEntry(patrolFixture('normal', false), 3, 3),
    isCatPatrolEntry(patrolFixture('hole', true), 3, 3),
    isCatPatrolEntry(patrolFixture('tunnel', true), 3, 3),
  ];

  // ---- pickup chance shape (test 8) ------------------------------------
  const s8 = rbState({
    size: 7, mouse: pt(1, 1), cat: pt(0, 0), hole: { r: 5, c: 5, size: 1 }, butters: [pt(1, 2)],
  });
  const rules8 = createEngineRuleSet();
  const picked = simulateSearchAction(s8, { type: 'mouseStep', direction: RIGHT }, rules8);
  results['chance_shape'] = picked.kind === 'chance'
    ? {
      kind: 'chance',
      outcomes: picked.outcomes.length,
      weights: picked.outcomes.map((o) => o.weight),
      spawns: picked.outcomes.map((o) => o.state.pendingButterSpawns),
    }
    : { kind: picked.kind };
  const back = endTurn(endTurn(picked.kind === 'chance' ? picked.outcomes[0].state : s8));
  results['chance_materialize'] = {
    butters: back.butterPositions, pending: back.pendingButterSpawns,
  };

  // ---- deep legal budgets that COMPLETE on the recursive solver --------
  // The terrain draw of DEFAULT_CONFIG is random, so the RNG is seeded for
  // these two as well; only then is the node count a parity measurement.
  for (const m of [500, 1000]) {
    const r = seeded(4242 + m, () => {
      const st = createInitialState({ ...DEFAULT_CONFIG, catBaseMoves: m });
      return { cert: certifyOpening(st, H(3)), stateKey: stateKey(st) };
    });
    results[`deepM${m}`] = {
      ...(r.value.cert as unknown as Record<string, unknown>),
      witnessAction: (r.value.cert as OpeningCertification).witnessAction ?? null,
      startingStateKey: r.value.stateKey,
      randomDraws: r.draws,
    };
  }

  // ---- default 10x10 opening with a seeded RNG (draw count is the metric)
  const def = seeded(123456789, () => generateFairOpening(DEFAULT_CONFIG));
  results['default_seeded'] = def.value.ok
    ? {
      ok: true, scope: def.value.scope, counts: def.value.counts,
      verdict: def.value.certification.verdict,
      exploredNodes: def.value.certification.exploredNodes,
      prunedNodes: def.value.certification.prunedNodes,
      butters: def.value.state.butterPositions, stateKey: stateKey(def.value.state),
      randomDraws: def.draws,
    }
    : { ok: false, reason: def.value.reason, counts: def.value.counts, randomDraws: def.draws };

  writeFileSync(
    new URL(`../_raw/parity_${PHASE}.json`, import.meta.url),
    JSON.stringify({
      phase: PHASE,
      capturedAt: new Date().toISOString(),
      nodeVersion: process.version,
      caseCount: Object.keys(results).length,
      results,
    }, null, 2) + '\n',
  );
  console.log(`captured ${Object.keys(results).length} parity cases → parity_${PHASE}.json`);
}, 900_000);
