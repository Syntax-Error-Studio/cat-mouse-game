/// <reference types="node" />
/**
 * PPC-P1-ID-01 — State identity: terrain encoding collision regression.
 *
 * Defect: `boardKey()` in `src/game/ai/transposition.ts` encoded a cell's
 * terrain with `cell.type[0]`, so `box`/`butter_spot` both became `b` and
 * `trap`/`tunnel` both became `t`. Two genuinely different positions could
 * therefore produce the same `stateKey`, and the per-search `evalCache` (and
 * TT / planBranches / path repetition, all keyed by `stateKey`) could return a
 * value computed for the other position.
 *
 * Gates covered here (FIRST_STAGE_ENGINEERING_SPEC.md §5):
 *   ID-1  terrain encoding is injective over the CellType domain, 54 schema
 *         vectors, unknown terrain fails closed (incl. inherited property names)
 *   ID-2  reachable counterexample: explicit map -> formal opening -> mouse
 *         LRUD -> cat DR / RD; A != B semantically, keys must differ
 *   ID-3  evalCache causality: A->B and B->A in one context equal the
 *         independent (cache-free) leaf value, for both cat leaves
 *   ID-4  stateKey consumers stay isolated (evalCache, TT, planBranches) while
 *         identical states still share; TT admission gates untouched
 *   ID-5  24 human roots, fixed D1, full structured parity vs the pre-fix
 *         baseline artifact (`fixtures/ppcId01-baseline-d1.json`)
 *   ID-7  semantic fields still separate keys
 *   ID-8  non-semantic / diagnostic fields and legal list reordering do not
 *   ID-9  stateKey and search do not mutate their input; contexts stay isolated
 *
 * Not claimed here: full TT search correctness, reachability of every schema
 * vector, cross-config injectivity, any performance or strength result.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  catMove,
  createEngineRuleSet,
  mouseMove,
  setWorldEntropySource,
  type GameEngineState,
} from '../../engine';
import { createGameState } from '../../newGame';
import { DEFAULT_CONFIG, validateGameConfig, type GameConfig } from '../../config';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../types';
import { generateLegalSearchActions } from '../legalActions';
import { evaluateForCat } from '../evaluation';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { stateKey } from '../transposition';
import { gameAffectingEqual, pendingSpawnsKey, pointSetKey } from '../stateCompare';
import {
  createSearchContext,
  searchBestAction,
  searchResult,
  type SearchContext,
} from '../expectiminimax';
import { restoreHardRoot } from '../hardHistory';
import type { SearchAction } from '../searchTypes';

const rules = createEngineRuleSet();

const DIR: Record<string, Direction> = {
  U: DIRECTIONS.find((d) => d.key === 'ArrowUp')!,
  D: DIRECTIONS.find((d) => d.key === 'ArrowDown')!,
  L: DIRECTIONS.find((d) => d.key === 'ArrowLeft')!,
  R: DIRECTIONS.find((d) => d.key === 'ArrowRight')!,
};

/** Stable, human-readable label for a search action (direction letter / T). */
function label(a: SearchAction | null): string {
  if (a === null) return 'NULL';
  if (a.type === 'catStep') return a.direction.key.slice(5)[0];
  if (a.type === 'catPlaceTrap') return 'T';
  return a.type;
}

function clone(s: GameEngineState): GameEngineState {
  return JSON.parse(JSON.stringify(s)) as GameEngineState;
}

/**
 * Pre-fix reference encoder for `boardKey`'s terrain nibble.
 *
 * This is the exact baseline behaviour (`cell.type[0]`) kept HERE ONLY so the
 * default-map parity gate can compare old-key vs new-key byte for byte without
 * importing a second copy of production code. It is never used by production.
 */
const LEGACY_TERRAIN = (type: string): string => type[0];

function legacyStateKey(state: GameEngineState): string {
  const s = state;
  const cfg = s.config;
  const parts: string[] = [];
  for (const row of s.board) {
    for (const cell of row) {
      parts.push(`${LEGACY_TERRAIN(cell.type)}${(cell.piece ?? '_')[0]}${cell.hasButter ? 'B' : '_'}`);
    }
  }
  return [
    parts.join(''),
    s.gameMode,
    s.phase,
    s.currentPlayer,
    `${s.catPosition.r},${s.catPosition.c}`,
    `${s.mousePosition.r},${s.mousePosition.c}`,
    s.catMovesLeft,
    s.mouseMovesLeft,
    pointSetKey(s.butterPositions),
    pendingSpawnsKey(s.pendingButterSpawns),
    s.pendingButterPlacementDebt ?? 0,
    s.mouseHasButter ? 1 : 0,
    s.mouseSkillActive ? 1 : 0,
    s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : '_',
    s.catTrapsRemaining,
    pointSetKey(s.blockedTunnels),
    pointSetKey(s.tunnelExitChoices),
    `${cfg.boardSize}:${cfg.mouseBaseMoves}:${cfg.mouseCarryingMoves}:${cfg.mouseSkillExtraMoves}:${cfg.catBaseMoves}:${cfg.butterCount}:${cfg.gameMode}:${cfg.difficulty}`,
  ].join('#');
}

// ---------------------------------------------------------------------------
// Reachable counterexample (explicit map, formal opening, real rules)
// ---------------------------------------------------------------------------
const BOARD_N = 10;
const CELL_CHARS = 3;
const BOARD_KEY_LEN = BOARD_N * BOARD_N * CELL_CHARS;

function boardSegment(key: string, r: number, c: number): string {
  const i = (r * BOARD_N + c) * CELL_CHARS;
  return key.slice(i, i + CELL_CHARS);
}

interface Witness {
  /** Cat-turn root reached by the legal mouse sequence L,R,U,D. */
  root: GameEngineState;
  /** Cat DR (down then right). */
  left: GameEngineState;
  /** Cat RD (right then down). */
  right: GameEngineState;
  legalA: string[];
  legalB: string[];
}

let cachedWitness: Witness | null = null;

/**
 * Builds the Pro-verified witness through the FORMAL entry points only:
 * validated explicit map -> createGameState -> mouseMove x4 -> catMove x2.
 * No hand-written runtime field is injected to force the collision.
 */
function witness(): Witness {
  if (cachedWitness) return cachedWitness;

  const terrain: CellType[][] = Array.from({ length: BOARD_N }, () =>
    Array<CellType>(BOARD_N).fill(CellType.Empty),
  );
  for (let r = 7; r < 9; r++) for (let c = 8; c < 10; c++) terrain[r][c] = CellType.MouseHole;
  for (const [r, c] of [[0, 0], [0, 9], [9, 0], [9, 9]] as const) terrain[r][c] = CellType.Tunnel;
  terrain[3][3] = CellType.Box;
  terrain[3][4] = CellType.ButterSpot;
  terrain[4][3] = CellType.ButterSpot;
  terrain[3][5] = CellType.Wall;

  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    customTerrain: terrain,
    boxCount: 1,
    pileCount: 0,
    catStart: { r: 2, c: 2 },
    mouseStart: { r: 4, c: 4 },
    difficulty: 'hard',
  };

  const validation = validateGameConfig(config);
  expect(validation.ok).toBe(true);

  const opening = createGameState(config);
  expect(opening.status.kind).toBe('explicit');
  expect(opening.state).not.toBeNull();
  let cur = opening.state as GameEngineState;

  // Mouse turn: L picks butter at (4,3), R returns, U picks butter at (3,4),
  // D returns. WORLD entropy injected only for the formal announcement draw.
  setWorldEntropySource(() => 0);
  try {
    for (const ch of 'LRUD') {
      const before = cur;
      cur = mouseMove(cur, DIR[ch]);
      expect(cur.mousePosition).not.toEqual(before.mousePosition);
    }
  } finally {
    setWorldEntropySource(null);
  }

  const root = cur;
  expect(root.currentPlayer).toBe(PieceType.Cat);
  expect(root.catMovesLeft).toBe(4);
  expect(root.butterPositions.length).toBe(0);
  expect(root.mouseHasButter).toBe(true);

  const catLine = (line: string): GameEngineState => {
    let s = root;
    for (const ch of line) {
      const before = s;
      s = catMove(s, DIR[ch]);
      expect(s.catPosition).not.toEqual(before.catPosition);
    }
    return s;
  };

  const left = catLine('DR');
  const right = catLine('RD');

  cachedWitness = {
    root,
    left,
    right,
    legalA: generateLegalSearchActions(left, rules).map(label),
    legalB: generateLegalSearchActions(right, rules).map(label),
  };
  return cachedWitness;
}

function mkCtx(leaf: (s: GameEngineState) => number, opts?: { tt?: boolean; ab?: boolean; order?: boolean; plan?: boolean; maxNodes?: number }): SearchContext {
  const ctx = createSearchContext(
    rules,
    opts?.maxNodes ?? 100,
    opts?.tt ?? false,
    opts?.ab ?? false,
    opts?.order ?? false,
    0,
    false,
  );
  // MUST be explicit: createSearchContext() silently leaves `leafEvaluator`
  // undefined and `evaluateLeaf` would then use `defaultLeafEval`.
  ctx.leafEvaluator = leaf;
  if (opts?.plan) ctx.capturePlan = true;
  return ctx;
}

// ---------------------------------------------------------------------------
// ID-1 terrain encoding
// ---------------------------------------------------------------------------
describe('ID-1 · terrain encoding is injective and fails closed', () => {
  const PROBE = { r: 2, c: 5 } as const;

  function segmentFor(type: string, piece?: string, hasButter = false): string {
    const s = clone(witness().root);
    s.board[PROBE.r][PROBE.c] = {
      type: type as CellType,
      piece: piece as GameEngineState['board'][number][number]['piece'],
      hasButter,
    };
    const key = stateKey(s);
    return boardSegment(key, PROBE.r, PROBE.c);
  }

  it('keeps the three-character cell layout (terrain + piece + butter flag)', () => {
    const key = stateKey(witness().root);
    expect(key.split('#')[0].length).toBe(BOARD_KEY_LEN);
    const seg = segmentFor(CellType.Empty, undefined, false);
    expect(seg.length).toBe(3);
    expect(seg[1]).toBe('_');
    expect(seg[2]).toBe('_');
    const withPiece = segmentFor(CellType.Empty, PieceType.Cat, true);
    expect(withPiece[1]).toBe('c');
    expect(withPiece[2]).toBe('B');
  });

  it('assigns a unique declared code per CellType', () => {
    const expected: Record<string, string> = {
      empty: 'e',
      box: 'b',
      trap: 'r',
      tunnel: 't',
      mouse_hole: 'm',
      butter_spot: 'u',
      pile: 'p',
      wall: 'w',
      void: 'v',
    };
    const types = Object.values(CellType);
    expect(types.length).toBe(9);
    const codes = new Set<string>();
    for (const t of types) {
      const code = segmentFor(t)[0];
      codes.add(code);
      expect(code, `terrain code for ${t}`).toBe(expected[t]);
    }
    expect(codes.size).toBe(9);
  });

  it('makes all 9 x 3 x 2 = 54 schema vectors distinct (schema coverage only)', () => {
    const keys = new Set<string>();
    for (const t of Object.values(CellType)) {
      for (const piece of [undefined, PieceType.Cat, PieceType.Mouse]) {
        for (const hasButter of [false, true]) {
          keys.add(segmentFor(t, piece, hasButter));
        }
      }
    }
    // Schema coverage of the cell encoder, NOT 54 reachable game states.
    expect(keys.size).toBe(54);
  });

  it('rejects unknown and inherited-property terrain names', () => {
    for (const bad of ['toString', 'constructor', '__proto__', 'unknown-terrain']) {
      const s = clone(witness().root);
      s.board[PROBE.r][PROBE.c] = {
        type: bad as unknown as CellType,
        piece: undefined,
        hasButter: false,
      };
      expect(() => stateKey(s), `terrain ${bad}`).toThrow(/Unknown terrain in state identity/);
    }
  });
});

// ---------------------------------------------------------------------------
// ID-2 reachable counterexample
// ---------------------------------------------------------------------------
describe('ID-2 · two reachable successors are not the same position', () => {
  it('reaches both successors through formal rules and keeps them semantically different', () => {
    const w = witness();

    // Same cat-turn root: both branches start from one legal root position.
    expect(w.left.catPosition).toEqual(w.right.catPosition);
    expect(w.left.catMovesLeft).toBe(w.right.catMovesLeft);
    expect(w.left.currentPlayer).toBe(PieceType.Cat);

    // Different terrain: the pushed box lands on different cells.
    expect(w.left.board[3][4].type).not.toBe(w.right.board[3][4].type);
    expect(w.left.board[4][3].type).not.toBe(w.right.board[4][3].type);
    expect(gameAffectingEqual(w.left, w.right)).toBe(false);

    // Different legal action sets, produced by the real rule layer.
    expect(w.legalA).not.toEqual(w.legalB);
    expect(w.legalA.includes('R')).toBe(false);
    expect(w.legalB.includes('R')).toBe(true);
  });

  it('gives the two successors different state keys', () => {
    const w = witness();
    expect(stateKey(w.left)).not.toBe(stateKey(w.right));
    // Same length: the fix must not change the key shape / order.
    expect(stateKey(w.left).length).toBe(legacyStateKey(w.left).length);
  });
});

// ---------------------------------------------------------------------------
// ID-3 evalCache causality
// ---------------------------------------------------------------------------
describe('ID-3 · shared evalCache never crosses the two successors', () => {
  it('records the pre-fix baseline leaf values the collision used to mix up', () => {
    const w = witness();
    expect(evaluateForCat(w.left)).toBeCloseTo(-263.4761904761904, 9);
    expect(evaluateForCat(w.right)).toBeCloseTo(-316.80952380952374, 9);
    expect(evaluateForCat(w.left)).not.toBeCloseTo(evaluateForCat(w.right), 6);
  });

  for (const [leafName, leaf] of [
    ['evaluateForCat', evaluateForCat],
    ['evaluateCorrectedHoleForCat', evaluateCorrectedHoleForCat],
  ] as const) {
    it(`A->B and B->A in one context equal the independent ${leafName} value`, () => {
      const w = witness();
      for (const order of [[w.left, w.right], [w.right, w.left]] as const) {
        const ctx = mkCtx(leaf);
        const orderName = order[0] === w.left ? 'A_B' : 'B_A';
        const cache = ctx.evalCache!;
        const sizeBefore = cache.size;
        const values = order.map((s) => searchResult(s, 0, ctx).value);
        const independent = order.map((s) => leaf(s));

        expect(values, `${leafName} order ${orderName}`).toEqual(independent);
        // Two genuinely different positions -> two cache entries, no reuse.
        expect(cache.size - sizeBefore, `${leafName} order ${orderName} cache entries`).toBe(2);
      }
    });
  }

  it('still reuses one cache entry for an identical position', () => {
    const w = witness();
    const ctx = mkCtx(evaluateForCat);
    const first = searchResult(w.left, 0, ctx).value;
    const again = searchResult(clone(w.left), 0, ctx).value;
    expect(again).toBe(first);
    expect(ctx.evalCache!.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ID-4 consumers
// ---------------------------------------------------------------------------
describe('ID-4 · stateKey consumers stay isolated', () => {
  it('does not let the second successor reuse the first one’s TT entry', () => {
    const w = witness();
    const opts = { tt: true, ab: true, order: true, plan: true, maxNodes: 10000 } as const;

    // `diagnostics` is a LIVE object owned by the context and `planBranches` is
    // replaced by a fresh Map on every `searchBestAction` call, so each result
    // must be snapshotted immediately after its own call.
    const shared = mkCtx(evaluateCorrectedHoleForCat, opts);
    const a = searchBestAction(w.left, 1, shared);
    const aSnap = { value: a.value, completed: a.completed, action: label(a.action), diagnostics: JSON.stringify(a.diagnostics) };
    const aPlanKeys = [...shared.planBranches.keys()];
    const b = searchBestAction(w.right, 1, shared);
    const bSnap = { value: b.value, completed: b.completed, action: label(b.action), diagnostics: JSON.stringify(b.diagnostics) };
    const bPlanKeys = [...shared.planBranches.keys()];

    const freshA = searchBestAction(w.left, 1, mkCtx(evaluateCorrectedHoleForCat, opts));
    const freshASnap = { value: freshA.value, completed: freshA.completed, action: label(freshA.action), diagnostics: JSON.stringify(freshA.diagnostics) };
    const freshB = searchBestAction(w.right, 1, mkCtx(evaluateCorrectedHoleForCat, opts));
    const freshBSnap = { value: freshB.value, completed: freshB.completed, action: label(freshB.action), diagnostics: JSON.stringify(freshB.diagnostics) };

    // Shared-context results must equal each state's own independent search.
    expect(aSnap).toEqual(freshASnap);
    expect(bSnap).toEqual(freshBSnap);
    // Sanity: the two successors are not the same search problem.
    expect(aSnap.diagnostics).not.toBe(freshBSnap.diagnostics);

    // Two distinct TT entries survive side by side in one table.
    const keyA = stateKey(w.left);
    const keyB = stateKey(w.right);
    expect(keyA).not.toBe(keyB);
    expect(shared.tt.get(keyA)).toBeDefined();
    expect(shared.tt.get(keyB)).toBeDefined();
    expect(shared.tt.get(keyA)).not.toBe(shared.tt.get(keyB));
    // Each search's own principal-line log is keyed by its own root.
    expect(aPlanKeys).toContain(keyA);
    expect(bPlanKeys).toContain(keyB);
  });

  it('keeps the TT admission contract (depth mismatch is not reused)', () => {
    const w = witness();
    const ctx = mkCtx(evaluateCorrectedHoleForCat, { tt: true, ab: false, order: false, maxNodes: 10000 });
    ctx.tt.set(stateKey(w.left), {
      depthTurns: 7,
      extensionsRemaining: 0,
      value: 12345,
      mate: null,
      bestAction: { type: 'catPlaceTrap' },
    });
    const r = searchBestAction(w.left, 1, ctx);
    expect(r.value).not.toBe(12345);
    expect(r.diagnostics.ttDepthMismatches).toBeGreaterThan(0);
    expect(r.diagnostics.ttExactHits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ID-5 default-map parity on the 24 frozen human roots
// ---------------------------------------------------------------------------
const ROOT_FIXTURE = new URL('./fixtures/ppcId01-human-roots.json', import.meta.url);
const BASELINE_D1 = new URL('./fixtures/ppcId01-baseline-d1.json', import.meta.url);
const ROOT_FIXTURE_SHA256 = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const CAPTURE_BASELINE = process.env.PPC_P1_ID_CAPTURE === '1';

interface RootRecord {
  id: string;
  file: string;
  line: number;
  state: unknown;
  sourceSha256: string;
  canonicalSnapshotSha256: string;
}

interface D1Record {
  id: string;
  key: string;
  completed: boolean;
  value: number;
  mate: string | null;
  action: string;
  plan: string[];
  ttSize: number;
  diagnostics: unknown;
}

function loadRoots(): RootRecord[] {
  const raw = readFileSync(ROOT_FIXTURE);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(ROOT_FIXTURE_SHA256);
  return JSON.parse(raw.toString('utf8')) as RootRecord[];
}

/** Fixed D1 protocol (frozen): explicit leaf, no deadline, full deterministic output. */
function runFixedD1(state: GameEngineState): D1Record {
  const ctx = createSearchContext(rules, 10000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const res = searchBestAction(state, 1, ctx);
  return {
    id: '',
    key: stateKey(state),
    completed: res.completed,
    value: res.value,
    mate: res.mate,
    action: label(res.action),
    plan: res.catTurnPlan.map(label),
    ttSize: ctx.tt.size,
    diagnostics: res.diagnostics,
  };
}

describe('ID-5 · 24 human roots keep byte-identical keys and identical D1 output', () => {
  it('preserves the legacy key byte for byte on the default-map terrain closure', () => {
    const roots = loadRoots();
    expect(roots.length).toBe(24);
    for (const rec of roots) {
      const state = restoreHardRoot(rec.state as never);
      expect(stateKey(state), `${rec.id} legacy key`).toBe(legacyStateKey(state));
    }
  });

  it('reproduces the pre-fix fixed-D1 result structure exactly', () => {
    const roots = loadRoots();
    if (CAPTURE_BASELINE) {
      const captured = roots.map((rec) => {
        const record = runFixedD1(restoreHardRoot(rec.state as never));
        return { ...record, id: rec.id };
      });
      writeFileSync(BASELINE_D1, `${JSON.stringify({
        sourceSha: '48eaac6c4f3801d351787696ba5876995b64e8d8',
        capturedOnEncoding: 'pre-fix cell.type[0] (legacy reference)',
        protocol: {
          depthTurns: 1,
          maxNodes: 10000,
          deadline: null,
          leaf: 'explicit evaluateCorrectedHoleForCat',
          tt: true,
          alphaBeta: true,
          moveOrdering: true,
          maxThreatExtensions: 0,
          capturePlan: true,
        },
        records: captured,
      }, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE_D1, 'utf8')) as { records: D1Record[] };
    expect(baseline.records.length).toBe(24);
    const byId = new Map(baseline.records.map((r) => [r.id, r]));
    for (const rec of roots) {
      const expected = byId.get(rec.id);
      expect(expected, `baseline record for ${rec.id}`).toBeDefined();
      const actual = runFixedD1(restoreHardRoot(rec.state as never));
      expect({ ...actual, id: rec.id }, `${rec.id} fixed-D1 parity`).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// ID-7 semantic fields
// ---------------------------------------------------------------------------
describe('ID-7 · every semantic field still changes the key', () => {
  const base = (): GameEngineState => clone(witness().left);

  const cases: [string, (s: GameEngineState) => void][] = [
    ['phase', (s) => { s.phase = GamePhase.ChoosingTunnelExit; }],
    ['currentPlayer', (s) => { s.currentPlayer = PieceType.Mouse; }],
    ['catMovesLeft', (s) => { s.catMovesLeft -= 1; }],
    ['mouseMovesLeft', (s) => { s.mouseMovesLeft += 1; }],
    ['mouseHasButter', (s) => { s.mouseHasButter = !s.mouseHasButter; }],
    ['mouseSkillActive', (s) => { s.mouseSkillActive = true; }],
    ['pendingButterSpawns position', (s) => {
      s.pendingButterSpawns = [{ r: 5, c: 5, blockedMaterializations: 0 }];
    }],
    ['pendingButterSpawns blocked count', (s) => {
      s.pendingButterSpawns = [{ r: 5, c: 5, blockedMaterializations: 1 }];
    }],
    ['pendingButterPlacementDebt', (s) => { s.pendingButterPlacementDebt = 1; }],
    ['trapPosition', (s) => { s.trapPosition = { r: 6, c: 6 }; }],
    ['catTrapsRemaining', (s) => { s.catTrapsRemaining = 0; }],
    ['blockedTunnels', (s) => { s.blockedTunnels = [{ r: 0, c: 0 }]; }],
    ['tunnelExitChoices', (s) => { s.tunnelExitChoices = [{ r: 9, c: 9, label: 'X' }]; }],
    ['config signature', (s) => { s.config = { ...s.config, butterCount: s.config.butterCount + 1 }; }],
    ['board terrain', (s) => { s.board[5][5] = { type: CellType.Pile, piece: undefined, hasButter: false }; }],
  ];

  for (const [name, mutate] of cases) {
    it(`${name} separates the key`, () => {
      const a = base();
      const b = base();
      mutate(b);
      expect(stateKey(b), name).not.toBe(stateKey(a));
    });
  }

  it('treats the two ghost-butter blocked counts differently', () => {
    const a = base();
    a.pendingButterSpawns = [{ r: 5, c: 5, blockedMaterializations: 0 }];
    const b = clone(a);
    b.pendingButterSpawns = [{ r: 5, c: 5, blockedMaterializations: 2 }];
    expect(stateKey(b)).not.toBe(stateKey(a));
  });
});

// ---------------------------------------------------------------------------
// ID-8 non-semantic fields
// ---------------------------------------------------------------------------
describe('ID-8 · diagnostics and list order do not change the key', () => {
  it('ignores message / action log / event log / last search record', () => {
    const a = clone(witness().left);
    const before = stateKey(a);
    a.message = '完全无关的调试文本';
    a.catActionLog = ['debug-only action log line'];
    a.gameEventLog = ['debug-only event log line'];
    a.lastHardSearch = { nodes: 1 } as unknown as GameEngineState['lastHardSearch'];
    expect(stateKey(a)).toBe(before);
  });

  it('ignores legal reordering of set-like fields (without touching the input)', () => {
    const a = clone(witness().left);
    a.butterPositions = [{ r: 1, c: 1 }, { r: 2, c: 2 }];
    a.pendingButterSpawns = [
      { r: 1, c: 1, blockedMaterializations: 0 },
      { r: 2, c: 2, blockedMaterializations: 1 },
    ];
    a.blockedTunnels = [{ r: 0, c: 0 }, { r: 0, c: 9 }];
    a.tunnelExitChoices = [{ r: 9, c: 0, label: 'A' }, { r: 9, c: 9, label: 'B' }];
    const before = stateKey(a);
    const snapshot = JSON.stringify(a);

    {
      const b = clone(a);
      b.butterPositions.reverse();
      b.pendingButterSpawns.reverse();
      b.blockedTunnels.reverse();
      b.tunnelExitChoices.reverse();
      expect(stateKey(b)).toBe(before);
    }
    // The reordering probe must not have mutated the reference state.
    expect(JSON.stringify(a)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// ID-9 input immutability and context isolation
// ---------------------------------------------------------------------------
describe('ID-9 · keying and searching never mutate the input', () => {
  it('stateKey is pure and stable across cold/warm calls', () => {
    const s = witness().left;
    const snapshot = JSON.stringify(s);
    const cold = stateKey(s);
    const warm = stateKey(s);
    expect(warm).toBe(cold);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('a full D1 search leaves the root untouched', () => {
    const s = clone(witness().left);
    const snapshot = JSON.stringify(s);
    const ctx = mkCtx(evaluateCorrectedHoleForCat, { tt: true, ab: true, order: true, plan: true, maxNodes: 10000 });
    searchBestAction(s, 1, ctx);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('keeps each context’s caches private', () => {
    const a = mkCtx(evaluateForCat);
    const b = mkCtx(evaluateForCat);
    expect(a.evalCache).not.toBe(b.evalCache);
    expect(a.tt).not.toBe(b.tt);
    expect(a.planBranches).not.toBe(b.planBranches);

    searchResult(witness().left, 0, a);
    expect(a.evalCache!.size).toBe(1);
    expect(b.evalCache!.size).toBe(0);
    expect(b.tt.size).toBe(0);
  });
});
