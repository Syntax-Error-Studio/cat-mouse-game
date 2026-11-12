/**
 * PPC-MOUSE-01 — shared harness for the Mouse-root search audit and the M0
 * mouse controller prototype.
 *
 * SCOPE / SAFETY
 *  - READ-ONLY with respect to the product. Nothing here is imported by src/.
 *  - The search core is the PRODUCTION `searchBestActionIterative`. There is NO
 *    second Expectiminimax implementation in this round. The only recursive
 *    evaluator written here (`oracleTurnValue`) is a TEST ORACLE: no TT, no
 *    alpha-beta, no move ordering, no plan capture, no budget — it exists so
 *    MIN/MAX/CHANCE can be checked against something that is not the thing
 *    being checked.
 *  - Transitions come from the PRODUCTION ruleset (`createEngineRuleSet`) and
 *    the leaf is the production baseline leaf (`evaluateForCat`, which is what
 *    `resolveHardLeaf()` returns while HARD_LEAF_MODE_CONFIG.current ===
 *    'baseline' — asserted in the tests).
 *
 * Every fixture is a `validateGameConfig`-clean ruleset-v2 map built from
 * `customTerrain`, so no box/pile/butter placement ever calls Math.random.
 */

import {
  createInitialState,
  createEngineRuleSet,
  mouseMove,
  mouseSkill,
  endTurn,
  catMove,
  catPlaceTrap,
} from '../src/game/engine';
import type { GameEngineState } from '../src/game/engine';
import { CellType, GamePhase, PieceType, DIRECTIONS } from '../src/game/types';
import {
  deriveDefaultLayout,
  validateGameConfig,
  DEFAULT_CONFIG as DEFAULT_CONFIG_10,
  type GameConfig,
} from '../src/game/config';
import { chooseTunnelExit } from '../src/game/rules/tunnels';
import { applyNoMoveLoss } from '../src/game/rules/mobility';
import { generateLegalSearchActions } from '../src/game/ai/legalActions';
import { simulateSearchAction } from '../src/game/ai/simulator';
import { gameAffectingEqual } from '../src/game/ai/stateCompare';
import { stateKey } from '../src/game/ai/transposition';
import {
  searchBestActionIterative,
  searchBestAction,
  createSearchContext,
  mateActionCost,
  stepChildForParent,
  compareSearchScore,
  MATE_SCORE,
  type IterativeSearchResult,
  type MateSide,
} from '../src/game/ai/expectiminimax';
import { evaluateForCat } from '../src/game/ai/evaluation';
import type { RuleSet, SearchAction } from '../src/game/ai/searchTypes';

// ---------------------------------------------------------------------------
// Frozen production profile (mirrors planHardCatTurn's arguments exactly)
// ---------------------------------------------------------------------------

export const RULES: RuleSet = createEngineRuleSet();
export const LEAF = evaluateForCat;

/** Whole-mouse-turn MAIN search budget. ALL replans of one turn share it. */
export const MOUSE_TURN_BUDGET_MS = 100;
/** The 150 ms total-turn wall the cat planner is held to. Measured, not implied. */
export const HARD_TURN_WALL_MS = 150;
export const MOUSE_TURN_MAX_DEPTH = 4;
export const MOUSE_TURN_MAX_NODES = 500_000;
/** A step below this remaining budget cannot even pay for one legal-action scan. */
export const MIN_STEP_BUDGET_MS = 2;
/** Hard cap on replans inside one mouse turn (safety valve, not a game rule). */
export const MAX_TURN_STEPS = 12;

export const now = (): number => performance.now();

// ---------------------------------------------------------------------------
// Map construction — deterministic 6x6 v2 map
// ---------------------------------------------------------------------------

const SIZE = 6;

/** Empty 6x6 with the derived hole (rows 3-4, cols 4-5) and the 4 tunnel corners. */
export function baseGrid(): CellType[][] {
  const hole = deriveDefaultLayout(SIZE).mouseHole;
  const g: CellType[][] = [];
  for (let r = 0; r < SIZE; r++) {
    const row: CellType[] = [];
    for (let c = 0; c < SIZE; c++) {
      const inHole = r >= hole.r && r < hole.r + hole.size
        && c >= hole.c && c < hole.c + hole.size;
      const corners = (r === 0 || r === SIZE - 1) && (c === 0 || c === SIZE - 1);
      row.push(inHole ? CellType.MouseHole : corners ? CellType.Tunnel : CellType.Empty);
    }
    g.push(row);
  }
  return g;
}

export function cloneGrid(g: CellType[][]): CellType[][] {
  return g.map((row) => row.slice());
}

export function makeConfig(
  grid: CellType[][],
  starts?: { mouse: { r: number; c: number }; cat: { r: number; c: number } },
): GameConfig {
  const d = deriveDefaultLayout(SIZE);
  return {
    boardSize: SIZE,
    mouseHole: d.mouseHole,
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    // The starts mirror the ACTUAL placement, so validateGameConfig checks the
    // cells the pieces really occupy (a wall under the cat is a rejected map,
    // not a silent teleport). createInitialState is then overridden anyway.
    mouseStart: starts ? { ...starts.mouse } : d.mouseStart,
    catStart: starts ? { ...starts.cat } : d.catStart,
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    catBaseMoves: 4,
    gameMode: 'single',
    difficulty: 'hard',
    customTerrain: cloneGrid(grid),
  };
}

export interface PiecePlacement {
  mouse: { r: number; c: number };
  cat: { r: number; c: number };
  mouseMovesLeft: number;
  catMovesLeft: number;
  currentPlayer?: typeof PieceType.Cat | typeof PieceType.Mouse;
  mouseHasButter?: boolean;
  mouseSkillActive?: boolean;
  trapPosition?: { r: number; c: number } | null;
  catTrapsRemaining?: number;
  phase?: string;
}

const BLOCKING = new Set<string>([CellType.Void, CellType.Wall, CellType.Box, CellType.Pile]);

/**
 * Build a state from a terrain grid + explicit piece placement. The config is
 * run through `validateGameConfig` so no fixture can be an illegal map.
 */
export function buildState(grid: CellType[][], p: PiecePlacement): GameEngineState {
  const config = makeConfig(grid, { mouse: p.mouse, cat: p.cat });
  const v = validateGameConfig(config);
  if (!v.ok) throw new Error(`fixture map rejected: ${v.issues.map((i) => i.message).join('; ')}`);
  if (BLOCKING.has(grid[p.mouse.r][p.mouse.c])) throw new Error('mouse on blocking terrain');
  if (BLOCKING.has(grid[p.cat.r][p.cat.c])) throw new Error('cat on blocking terrain');

  const base = createInitialState(config); // deterministic: customTerrain, no RNG
  const board = base.board.map((row) => row.map((cell) => ({ ...cell, piece: undefined })));
  board[p.cat.r][p.cat.c] = { ...board[p.cat.r][p.cat.c], piece: PieceType.Cat };
  board[p.mouse.r][p.mouse.c] = { ...board[p.mouse.r][p.mouse.c], piece: PieceType.Mouse };

  return {
    ...base,
    board,
    catPosition: { ...p.cat },
    mousePosition: { ...p.mouse },
    mouseMovesLeft: p.mouseMovesLeft,
    catMovesLeft: p.catMovesLeft,
    currentPlayer: p.currentPlayer ?? PieceType.Mouse,
    mouseHasButter: p.mouseHasButter ?? false,
    mouseSkillActive: p.mouseSkillActive ?? false,
    trapPosition: p.trapPosition ?? null,
    catTrapsRemaining: p.catTrapsRemaining ?? 1,
    phase: (p.phase as GamePhase) ?? GamePhase.Playing,
  };
}

export interface Fixture {
  id: string;
  note: string;
  state: GameEngineState;
}

// hole cells for this map: (3,4) (3,5) (4,4) (4,5)
const HOLE = { r: 3, c: 4 };

function cornerOf(g: CellType[][]): { r: number; c: number }[] {
  return [
    { r: 0, c: 0 }, { r: 0, c: SIZE - 1 },
    { r: SIZE - 1, c: 0 }, { r: SIZE - 1, c: SIZE - 1 },
  ].filter((p) => g[p.r][p.c] === CellType.Tunnel);
}

export function fixtures(): Fixture[] {
  const out: Fixture[] = [];

  // (1) carrying butter, 2 steps from the hole, plenty of moves -> forced win
  out.push({
    id: 'M_CARRY_HOME',
    note: 'mouse carries butter at (3,2); hole entry is 2 steps away; cat far',
    state: buildState(baseGrid(), {
      mouse: { r: 3, c: 2 }, cat: { r: 0, c: 2 },
      mouseMovesLeft: 3, catMovesLeft: 0, mouseHasButter: true,
    }),
  });

  // (2) butter on the map, not yet carried -> stepping on it is a CHANCE node
  {
    const g = baseGrid();
    g[2][2] = CellType.ButterSpot;
    out.push({
      id: 'M_BUTTER_PICKUP',
      note: 'butter at (2,2); stepping onto it announces a ghost spawn (CHANCE)',
      state: buildState(g, {
        mouse: { r: 2, c: 1 }, cat: { r: 4, c: 1 },
        mouseMovesLeft: 3, catMovesLeft: 0,
      }),
    });
  }

  // (3) 1-cell pocket: only exit is a tunnel corner, and carrying butter forbids it
  {
    const g = baseGrid();
    g[1][4] = CellType.Wall;
    g[2][5] = CellType.Wall;
    out.push({
      id: 'M_SKILL_ONLY',
      note: 'mouse at (1,5) with butter; (0,5) tunnel blocked by butter, both other exits walled -> skill is the ONLY legal action and RULE-A must not fire',
      state: buildState(g, {
        mouse: { r: 1, c: 5 }, cat: { r: 4, c: 1 },
        mouseMovesLeft: 1, catMovesLeft: 0, mouseHasButter: true,
      }),
    });
  }

  // (4) tunnel entry: multi-exit choice, then the turn hands off
  out.push({
    id: 'M_TUNNEL',
    note: 'mouse at (0,1) walks into the (0,0) tunnel; 3 other corners are open -> ChoosingTunnelExit with 4 choices (3 + stay)',
    state: buildState(baseGrid(), {
      mouse: { r: 0, c: 1 }, cat: { r: 2, c: 3 },
      mouseMovesLeft: 2, catMovesLeft: 0,
    }),
  });

  // (5) trap is the ONLY legal move -> stepping on it burns the whole turn.
  // NOTE the pocket must NOT use (1,1): that is the config's catStart and
  // validateGameConfig would (correctly) reject a wall there.
  {
    const g = baseGrid();
    g[0][5] = CellType.Wall;   // kill the tunnel escape
    g[0][3] = CellType.Wall;
    g[1][4] = CellType.Trap;
    out.push({
      id: 'M_TRAP_ONLY',
      note: 'mouse at (0,4) boxed in; the only legal step lands on the trap at (1,4) -> all remaining moves lost, turn ends',
      state: buildState(g, {
        mouse: { r: 0, c: 4 }, cat: { r: 3, c: 1 },
        mouseMovesLeft: 3, catMovesLeft: 0,
        trapPosition: { r: 1, c: 4 },
      }),
    });
  }

  // (6) RULE-A: fully boxed, no butter -> the mouse has already lost
  {
    const g = baseGrid();
    g[0][5] = CellType.Wall;   // remove the tunnel escape
    g[1][4] = CellType.Wall;
    g[2][5] = CellType.Wall;
    out.push({
      id: 'M_STRANDED',
      note: 'mouse at (1,5) WITHOUT butter, all three exits walled, no skill available -> RULE-A loss before any action',
      state: buildState(g, {
        mouse: { r: 1, c: 5 }, cat: { r: 4, c: 1 },
        mouseMovesLeft: 2, catMovesLeft: 0,
      }),
    });
  }

  // (7) cat adjacent with a full budget -> mouse must not walk into it
  out.push({
    id: 'M_CAT_ADJACENT',
    note: 'cat at (4,3) one step from the mouse at (3,3); cat keeps 4 moves so any mouse line that ends beside it is lost',
    state: buildState(baseGrid(), {
      mouse: { r: 3, c: 3 }, cat: { r: 4, c: 3 },
      mouseMovesLeft: 2, catMovesLeft: 4,
    }),
  });

  // (8) ONE remaining mouse move -> a depth-2 oracle becomes affordable
  out.push({
    id: 'M_MICRO',
    note: 'mouse at (2,3) with ONE move and butter, cat at (4,1): depth 2 = one mouse step + the whole cat turn',
    state: buildState(baseGrid(), {
      mouse: { r: 2, c: 3 }, cat: { r: 4, c: 1 },
      mouseMovesLeft: 1, catMovesLeft: 0, mouseHasButter: true,
    }),
  });

  // (9) the same, but the ONE move steps onto butter -> a CHANCE node inside
  //     the depth-2 horizon
  {
    const g = baseGrid();
    g[2][4] = CellType.ButterSpot;
    out.push({
      id: 'M_BUTTER_MICRO',
      note: 'mouse at (2,3), ONE move, butter at (2,4): the single legal step is the CHANCE pickup, then the cat turn',
      state: buildState(g, {
        mouse: { r: 2, c: 3 }, cat: { r: 4, c: 1 },
        mouseMovesLeft: 1, catMovesLeft: 0,
      }),
    });
  }

  // (10) forced cat mate: a 1-wide corridor, the mouse has one move and the
  //      cat walks it down. Distance 1 (mouse) + 2 (cat) = 3.
  {
    const g = baseGrid();
    for (const c of [1, 2, 3]) { g[1][c] = CellType.Wall; g[3][c] = CellType.Wall; }
    out.push({
      id: 'M_CAT_MATE3',
      note: 'corridor row 2; mouse at (2,2) with ONE move can only go right to (2,3), the cat at (2,1) then needs 2 steps -> mate in 3',
      state: buildState(g, {
        mouse: { r: 2, c: 2 }, cat: { r: 2, c: 1 },
        mouseMovesLeft: 1, catMovesLeft: 0,
      }),
    });
  }

  // (11) the default 10x10 world, one mouse move, a real multi-outcome CHANCE
  out.push(bigWorldFixture());

  return out;
}

/**
 * A 10x10 ruleset-v2 world (the default board size) with a fully pinned layout.
 * Boxes/piles are EMPTY ARRAYS, not "0 count": `createInitialBoard` uses
 * `config.boxPositions || generateBoxPositions(...)`, so an empty array is the
 * only way to get a deterministic box-free board without customTerrain.
 *
 * This exists because the 6x6 map CANNOT always produce a butter spawn: the
 * candidate loop only scans rows/cols 1..S-2 and then drops everything within
 * Chebyshev-3 of the hole / mouse / cat, which on 6x6 frequently leaves zero
 * candidates. There the ghost rule degenerates to placement debt, so a 6x6
 * chance node is not enough to exercise the expectation arithmetic.
 */
export function bigWorldFixture(): Fixture {
  const cfg: GameConfig = {
    ...DEFAULT_CONFIG_10,
    boxPositions: [],
    pilePositions: [],
    butterPositions: [{ r: 5, c: 5 }],
    mouseStart: { r: 5, c: 4 },
    catStart: { r: 9, c: 1 },
  };
  const v = validateGameConfig(cfg);
  if (!v.ok) throw new Error(`10x10 fixture rejected: ${v.issues.map((i) => i.message).join('; ')}`);
  const base = createInitialState(cfg);
  const p = { mouse: { r: 5, c: 4 }, cat: { r: 9, c: 1 } };
  const board = base.board.map((row) => row.map((cell) => ({ ...cell, piece: undefined })));
  board[p.cat.r][p.cat.c] = { ...board[p.cat.r][p.cat.c], piece: PieceType.Cat };
  board[p.mouse.r][p.mouse.c] = { ...board[p.mouse.r][p.mouse.c], piece: PieceType.Mouse };
  return {
    id: 'M10_BUTTER',
    note: 'default 10x10, no boxes/piles, ONE mouse move, butter at (5,5): a real multi-outcome CHANCE node',
    state: {
      ...base, board,
      catPosition: p.cat, mousePosition: p.mouse,
      mouseMovesLeft: 1, catMovesLeft: 0,
      currentPlayer: PieceType.Mouse,
      mouseHasButter: false, mouseSkillActive: false,
      trapPosition: null, catTrapsRemaining: 1, phase: GamePhase.Playing,
    },
  };
}

export function fixtureById(id: string): GameEngineState {
  const f = fixtures().find((x) => x.id === id);
  if (!f) throw new Error(`unknown fixture ${id}`);
  return f.state;
}

// ---------------------------------------------------------------------------
// TEST ORACLE — independent minimax over the REAL transitions
// ---------------------------------------------------------------------------

interface OVal { value: number; mate: MateSide }

/**
 * Plain recursive minimax/expectiminimax with NO alpha-beta, NO TT, NO move
 * ordering, NO budget and NO plan capture. Same rules, same leaf, same
 * mate-distance stepping — so a disagreement is a real semantic difference,
 * never a pruning artefact.
 */
export function oracleTurnValue(
  s: GameEngineState,
  depthTurns: number,
  path: Set<string> = new Set<string>(),
): OVal {
  if (s.phase === GamePhase.CatWins) return { value: MATE_SCORE, mate: 'cat' };
  if (s.phase === GamePhase.MouseWins) return { value: -MATE_SCORE, mate: 'mouse' };

  const key = stateKey(s);
  if (path.has(key)) return { value: LEAF(s), mate: null };
  if (depthTurns <= 0) return { value: LEAF(s), mate: null };

  const actions = generateLegalSearchActions(s, RULES);
  if (actions.length === 0) return { value: LEAF(s), mate: null };

  const maximizing = s.currentPlayer === PieceType.Cat;
  path.add(key);
  try {
    let best: OVal | null = null;
    for (const a of actions) {
      const cost = mateActionCost(a);
      const tr = simulateSearchAction(s, a, RULES);
      const child = oracleTransition(s, tr, depthTurns, path);
      const cand: OVal = {
        value: stepChildForParent({ value: child.value, mate: child.mate } as never, cost),
        mate: child.mate,
      };
      if (best === null) best = cand;
      else if (compareSearchScore(cand as never, best as never) * (maximizing ? 1 : -1) > 0) best = cand;
    }
    return best!;
  } finally {
    path.delete(key);
  }
}

function oracleTransition(
  s: GameEngineState,
  tr: ReturnType<typeof simulateSearchAction>,
  depthTurns: number,
  path: Set<string>,
): OVal {
  if (tr.kind === 'deterministic') {
    const switched = s.currentPlayer !== tr.state.currentPlayer;
    return oracleTurnValue(tr.state, depthTurns - (switched ? 1 : 0), path);
  }
  const outcomes = tr.outcomes;
  const switched = outcomes.length > 0 && s.currentPlayer !== outcomes[0].state.currentPlayer;
  const nd = depthTurns - (switched ? 1 : 0);
  let total = 0;
  let allCat = true;
  let allMouse = true;
  for (const o of outcomes) {
    const r = oracleTurnValue(o.state, nd, path);
    total += o.weight * r.value;
    if (r.mate !== 'cat') allCat = false;
    if (r.mate !== 'mouse') allMouse = false;
  }
  return { value: total, mate: allCat ? 'cat' : allMouse ? 'mouse' : null };
}

/** Brute-force argmin/argmax of the oracle's root action list (for MIN checks). */
export function oracleRootActions(
  s: GameEngineState,
  depthTurns: number,
): { action: SearchAction; value: number; mate: MateSide }[] {
  const maximizing = s.currentPlayer === PieceType.Cat;
  const rows: { action: SearchAction; value: number; mate: MateSide }[] = [];
  const path = new Set<string>([stateKey(s)]);
  for (const a of generateLegalSearchActions(s, RULES)) {
    const cost = mateActionCost(a);
    const tr = simulateSearchAction(s, a, RULES);
    const child = oracleTransition(s, tr, depthTurns, path);
    rows.push({
      action: a,
      value: stepChildForParent({ value: child.value, mate: child.mate } as never, cost),
      mate: child.mate,
    });
  }
  const sign = maximizing ? 1 : -1;
  rows.sort((x, y) => -sign * compareSearchScore(x as never, y as never));
  return rows;
}

// ---------------------------------------------------------------------------
// Planner — ONE production search call, exactly like planHardCatTurn
// ---------------------------------------------------------------------------

export interface MouseSearchCall {
  result: IterativeSearchResult;
  wallMs: number;
  deadlineMs: number;
}

export function planMouseSearch(
  state: GameEngineState,
  opts: { budgetMs: number; maxNodes?: number; maxDepthTurns?: number; clock?: () => number },
): MouseSearchCall {
  const clock = opts.clock ?? now;
  const t0 = clock();
  const deadlineMs = t0 + opts.budgetMs;
  const result = searchBestActionIterative(state, {
    rules: RULES,
    maxDepthTurns: opts.maxDepthTurns ?? MOUSE_TURN_MAX_DEPTH,
    maxNodes: opts.maxNodes ?? MOUSE_TURN_MAX_NODES,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    useThreatOrdering: false,   // production ruling (G0.3B FINAL)
    maxThreatExtensions: 0,     // production rolled back to 0 credits
    leafEvaluator: LEAF,
    deadlineMs,
    now: clock,
  });
  return { result, wallMs: clock() - t0, deadlineMs };
}

// ---------------------------------------------------------------------------
// Real-engine execution + parity
// ---------------------------------------------------------------------------

export type ExecOutcome = {
  next: GameEngineState;
  rejected: boolean;
  /** How the real transition compares with the simulator's model. */
  parity: 'exact' | 'chance_masked' | 'MISMATCH';
  detail?: string;
};

const PARITY_FIELDS: (keyof GameEngineState)[] = [
  'phase', 'currentPlayer', 'catMovesLeft', 'mouseMovesLeft', 'mouseHasButter',
  'mouseSkillActive', 'catTrapsRemaining',
];

function pointEq(a: { r: number; c: number } | null, b: { r: number; c: number } | null): boolean {
  if (a === null || b === null) return a === b;
  return a.r === b.r && a.c === b.c;
}

function setEq(a: { r: number; c: number }[], b: { r: number; c: number }[]): boolean {
  if (a.length !== b.length) return false;
  const k = (p: { r: number; c: number }) => `${p.r},${p.c}`;
  const sa = a.map(k).sort().join('|');
  const sb = b.map(k).sort().join('|');
  return sa === sb;
}

function parityDetail(a: GameEngineState, b: GameEngineState): string {
  const diffs: string[] = [];
  for (const f of PARITY_FIELDS) if (a[f] !== b[f]) diffs.push(`${String(f)}: ${String(a[f])} != ${String(b[f])}`);
  if (!pointEq(a.catPosition, b.catPosition)) diffs.push('catPosition');
  if (!pointEq(a.mousePosition, b.mousePosition)) diffs.push('mousePosition');
  if (!pointEq(a.trapPosition, b.trapPosition)) diffs.push('trapPosition');
  if (!setEq(a.butterPositions, b.butterPositions)) diffs.push('butterPositions');
  if (!setEq(a.blockedTunnels, b.blockedTunnels)) diffs.push('blockedTunnels');
  if (!setEq(a.tunnelExitChoices, b.tunnelExitChoices)) diffs.push('tunnelExitChoices');
  return diffs.join(', ');
}

/**
 * Execute ONE SearchAction through the REAL engine functions and check the
 * result against the simulator's model of the same action.
 *
 * The mouse's butter pickup is the ONLY divergence the model permits: the
 * search defers the ghost announcement into a CHANCE node, while the real
 * engine samples one spawn immediately. That case is reported as
 * 'chance_masked' with the pending-ghost count checked explicitly.
 */
export function executeReal(state: GameEngineState, action: SearchAction): ExecOutcome {
  const model = simulateSearchAction(state, action, RULES);
  let next: GameEngineState;

  switch (action.type) {
    case 'mouseStep':
      next = mouseMove(state, action.direction);
      break;
    case 'mouseSkill':
      next = mouseSkill(state);
      break;
    case 'chooseTunnel': {
      const afterExit = chooseTunnelExit(state, action.r, action.c);
      next = afterExit === state
        ? state
        : (afterExit.phase === GamePhase.Playing && afterExit.mouseMovesLeft <= 0
          ? endTurn(afterExit)
          : afterExit);
      break;
    }
    case 'catStep':
      next = catMove(state, action.direction);
      break;
    case 'catPlaceTrap':
      next = catPlaceTrap(state);
      break;
    default:
      throw new Error(`unsupported action ${(action as { type: string }).type}`);
  }

  const rejected = gameAffectingEqual(state, next);
  if (rejected) return { next, rejected: true, parity: 'MISMATCH', detail: 'engine made no game-affecting change (illegal)' };

  if (model.kind === 'deterministic') {
    const diff = parityDetail(next, model.state);
    return diff
      ? { next, rejected: false, parity: 'MISMATCH', detail: diff }
      : { next, rejected: false, parity: 'exact' };
  }

  // CHANCE: the real engine announces exactly ONE outcome (a ghost at a drawn
  // cell, or a placement-debt increment when no spawn is legal). The model
  // enumerates all of them. Parity therefore means: the announced shape (ghost
  // count + debt) is one of the enumerated outcomes, and every DETERMINISTIC
  // field agrees. The ghost's CELL is deliberately not compared — that is the
  // draw, and it happens after the decision, not inside it.
  const match = model.outcomes.find((o) =>
    o.state.pendingButterSpawns.length === next.pendingButterSpawns.length
    && (o.state.pendingButterPlacementDebt ?? 0) === (next.pendingButterPlacementDebt ?? 0));
  if (!match) {
    return {
      next, rejected: false, parity: 'MISMATCH',
      detail: `announced (ghosts=${next.pendingButterSpawns.length}, debt=${next.pendingButterPlacementDebt}) matches no enumerated outcome `
        + `[${model.outcomes.map((o) => `${o.state.pendingButterSpawns.length}/${o.state.pendingButterPlacementDebt ?? 0}`).join(' ')}]`,
    };
  }
  const diff = parityDetail(next, { ...match.state, pendingButterSpawns: next.pendingButterSpawns });
  return diff === ''
    ? { next, rejected: false, parity: 'chance_masked' }
    : { next, rejected: false, parity: 'MISMATCH', detail: diff };
}

// ---------------------------------------------------------------------------
// M0 controller — single-step decision, observe, replan, ONE shared budget
// ---------------------------------------------------------------------------

export type AllocPolicy = 'SHARED_GREEDY' | 'SHARED_EVEN';

export interface StepRecord {
  index: number;
  phaseIn: string;
  playerIn: string;
  action: string;
  /** Budget granted to THIS replan (ms) and what it actually spent. */
  budgetMs: number;
  searchMs: number;
  completed: boolean;
  completedDepth: number;
  attemptedDepth: number;
  nodes: number;
  value: number;
  mate: MateSide;
  rootActionCount: number;
  /** Every legal action of the searched root, as labels (audit trail). */
  legalActions: string[];
  parity: string;
  rejected: boolean;
  detail?: string;
  /** Cumulative turn wall after this step. */
  turnWallMs: number;
}

export interface MouseTurnRun {
  fixtureId: string;
  policy: AllocPolicy;
  budgetMs: number;
  maxDepthTurns: number;
  steps: StepRecord[];
  /** Final observable facts. */
  endPhase: string;
  endPlayer: string;
  endMouse: string;
  endCat: string;
  terminal: 'none' | 'MouseWins' | 'CatWins';
  /** True when the mouse's turn genuinely ended (not stuck on the same actor). */
  fullTurnExecuted: boolean;
  totalWallMs: number;
  turnOverrunMs: number;
  fallbacks: number;
  rejects: number;
  mismatches: number;
  /** Math.random calls observed while planning (must be 0). */
  randomCallsDuringPlanning: number;
  abortReason: string | null;
}

export function labelAction(a: SearchAction | null): string {
  if (!a) return 'none';
  switch (a.type) {
    case 'mouseStep': return `mouse${a.direction.label}`;
    case 'catStep': return `cat${a.direction.label}`;
    case 'mouseSkill': return 'skill';
    case 'catPlaceTrap': return 'trap';
    case 'chooseTunnel': return `exit(${a.r},${a.c})`;
  }
}

/**
 * Run ONE mouse turn under M0.
 *
 * Budget contract: `budgetMs` is the MAIN-SEARCH budget for the WHOLE turn.
 * Every replan draws from the same remaining pool — there is no per-step
 * re-grant. `SHARED_GREEDY` gives each replan everything that is left;
 * `SHARED_EVEN` splits what is left across the mouse's remaining moves.
 */
export function runMouseTurnM0(
  fixtureId: string,
  root: GameEngineState,
  opts: {
    budgetMs?: number;
    policy?: AllocPolicy;
    maxNodes?: number;
    /** Search horizon per decision. 4 = production depth; 1 = M0's own horizon. */
    maxDepthTurns?: number;
    clock?: () => number;
  } = {},
): MouseTurnRun {
  const clock = opts.clock ?? now;
  const budgetMs = opts.budgetMs ?? MOUSE_TURN_BUDGET_MS;
  const policy = opts.policy ?? 'SHARED_GREEDY';
  const maxDepthTurns = opts.maxDepthTurns ?? MOUSE_TURN_MAX_DEPTH;
  const turnStart = clock();

  let state = root;
  const steps: StepRecord[] = [];
  let fallbacks = 0;
  let rejects = 0;
  let mismatches = 0;
  let randomCalls = 0;
  let abortReason: string | null = null;

  // RULE-A check BEFORE any planning: if the actor is already stranded, the
  // position is over and the controller must not "act" in it.
  const settled = applyNoMoveLoss(state);
  if (settled !== state) {
    return {
      fixtureId, policy, budgetMs, maxDepthTurns, steps,
      endPhase: settled.phase, endPlayer: settled.currentPlayer,
      endMouse: pt(state.mousePosition), endCat: pt(state.catPosition),
      terminal: settled.phase === GamePhase.MouseWins ? 'MouseWins' : 'CatWins',
      fullTurnExecuted: false, totalWallMs: clock() - turnStart, turnOverrunMs: 0,
      fallbacks, rejects, mismatches, randomCallsDuringPlanning: 0,
      abortReason: 'rule_a_terminal_before_planning',
    };
  }

  while (steps.length < MAX_TURN_STEPS) {
    const isMouseTurn = state.phase === GamePhase.ChoosingTunnelExit
      || (state.phase === GamePhase.Playing && state.currentPlayer === PieceType.Mouse);
    if (!isMouseTurn) break;

    const remaining = budgetMs - (clock() - turnStart);
    if (remaining < MIN_STEP_BUDGET_MS) {
      abortReason = 'turn_budget_exhausted';
      break;
    }
    const share = policy === 'SHARED_EVEN'
      ? Math.max(MIN_STEP_BUDGET_MS, remaining / Math.max(1, state.mouseMovesLeft))
      : remaining;
    const stepBudget = Math.max(MIN_STEP_BUDGET_MS, Math.min(share, remaining));

    const legal = generateLegalSearchActions(state, RULES);
    const phaseIn = state.phase;
    const playerIn = state.currentPlayer;

    // Info-visibility guard: the planner must not consume a random draw.
    const realRandom = Math.random;
    let calls = 0;
    let call: MouseSearchCall;
    try {
      Math.random = () => { calls++; return realRandom(); };
      call = planMouseSearch(state, {
        budgetMs: stepBudget, maxNodes: opts.maxNodes, maxDepthTurns, clock,
      });
    } finally {
      Math.random = realRandom;
    }
    randomCalls += calls;

    const action = call.result.bestAction;
    if (!action) {
      fallbacks++;
      abortReason = call.result.completedDepth === 0 ? 'no_completed_depth' : 'no_legal_action';
      break;
    }

    const exec = executeReal(state, action);
    if (exec.rejected) rejects++;
    if (exec.parity === 'MISMATCH') mismatches++;

    steps.push({
      index: steps.length,
      phaseIn, playerIn,
      action: labelAction(action),
      budgetMs: +stepBudget.toFixed(2),
      searchMs: +call.wallMs.toFixed(2),
      completed: call.result.completed,
      completedDepth: call.result.completedDepth,
      attemptedDepth: call.result.attemptedDepth,
      nodes: call.result.diagnostics.totalNodes,
      value: call.result.value,
      mate: call.result.mate,
      rootActionCount: legal.length,
      legalActions: legal.map((a) => labelAction(a)),
      parity: exec.parity,
      rejected: exec.rejected,
      detail: exec.detail,
      turnWallMs: +(clock() - turnStart).toFixed(2),
    });

    if (exec.rejected) { abortReason = 'engine_rejected_action'; break; }
    state = exec.next;
  }

  const totalWallMs = +(clock() - turnStart).toFixed(2);
  const terminal = state.phase === GamePhase.MouseWins ? 'MouseWins'
    : state.phase === GamePhase.CatWins ? 'CatWins' : 'none';
  const mouseTurnOver = state.phase !== GamePhase.ChoosingTunnelExit
    && (state.phase === GamePhase.MouseWins || state.phase === GamePhase.CatWins
      || state.currentPlayer !== PieceType.Mouse);

  return {
    fixtureId, policy, budgetMs, maxDepthTurns, steps,
    endPhase: state.phase, endPlayer: state.currentPlayer,
    endMouse: pt(state.mousePosition), endCat: pt(state.catPosition),
    terminal,
    fullTurnExecuted: mouseTurnOver && steps.length > 0,
    totalWallMs,
    turnOverrunMs: +(totalWallMs - budgetMs).toFixed(2),
    fallbacks, rejects, mismatches,
    randomCallsDuringPlanning: randomCalls,
    abortReason,
  };
}

function pt(p: { r: number; c: number }): string {
  return `(${p.r},${p.c})`;
}

// ---------------------------------------------------------------------------
// Artefact output
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
export const OUT_DIR = path.join(REPO, 'PPC-MOUSE-01', 'out');
if (!fs.existsSync(path.join(REPO, 'src', 'game', 'engine.ts'))) {
  throw new Error(`run from the repository root, got cwd=${REPO}`);
}
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

export function writeOut(name: string, obj: unknown): void {
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 1), 'utf8');
}

const touched = new Set<string>();

/**
 * Append one row, TRUNCATING the file on first touch within this process.
 * Without the truncate a second run of the same suite would silently double
 * every row and poison both the aggregate and the determinism digest.
 */
export function appendJsonl(name: string, obj: unknown): void {
  const p = path.join(OUT_DIR, name);
  if (!touched.has(name)) {
    touched.add(name);
    fs.writeFileSync(p, '', 'utf8');
  }
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

export { DIRECTIONS, GamePhase, PieceType, CellType, stateKey, applyNoMoveLoss };
export { generateLegalSearchActions, simulateSearchAction, gameAffectingEqual, mateActionCost, MATE_SCORE, compareSearchScore, endTurn, mouseMove, mouseSkill };
export { searchBestAction, createSearchContext, evaluateForCat };
export type { IterativeSearchResult, SearchAction, GameEngineState, GameConfig };
