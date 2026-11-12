/**
 * PPC-SEARCH-01 — shared harness for the PVS single-variable experiment.
 *
 * ARM A      : `src/game/ai/expectiminimax.ts`  (production authority)
 * ARM A_FORK : `PPC-SEARCH-01/proto/expectiminimaxPvs.ts` with PVS_ENABLED=false
 *              (fork control — must be bit-identical to A, proving the fork
 *               itself introduced no behaviour change)
 * ARM B      : the same fork with PVS_ENABLED=true  (the ONLY variable)
 *
 * Everything else is held identical by construction: one RuleSet instance, one
 * leaf-function instance, the same EXACT-only TT policy with a fresh table per
 * search, the same move ordering, the same CHANCE weights (the simulator's own
 * deterministic enumeration), the same roots, depth, node budget and deadline.
 *
 * NOTHING here writes to `src/`.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GamePhase, PieceType, CellType } from '../src/game/types';
import type { GameEngineState } from '../src/game/engine';
import { createEngineRuleSet } from '../src/game/engine';
import { generateLegalSearchActions } from '../src/game/ai/legalActions';
import { simulateSearchAction } from '../src/game/ai/simulator';
import { resolveHardLeaf, getHardLeafMode } from '../src/game/ai/hybridLeaf';
import { stateKey } from '../src/game/ai/transposition';
import type { SearchAction } from '../src/game/ai/searchTypes';
import type { SearchContext } from '../src/game/ai/expectiminimax';
import {
  createSearchContext as createProdContext,
  searchBestAction as searchProd,
  searchBestActionIterative as searchProdIterative,
} from '../src/game/ai/expectiminimax';
import {
  createSearchContext as createForkContext,
  searchBestAction as searchFork,
  searchBestActionIterative as searchForkIterative,
  setPvsEnabled,
  setPvsChanceExempt,
  setPvsStrictBounds,
  resetPvsCounters,
  pvsCounters,
} from './proto/expectiminimaxPvs';
import { parseThreeGames, restoreTurnRoot } from '../ai-training/f2b19c/f2b19c_lib.mts';

export const MAX_NODES = 2_000_000;
export const RULES = createEngineRuleSet();
export const LEAF = resolveHardLeaf();
export const LEAF_MODE = getHardLeafMode();

export type Arm = 'A' | 'A_FORK' | 'B' | 'C';

export interface PvsStats {
  scouts: number;
  research: number;
  skip: number;
  abortScouts: number;
  strictNodes: number;
  chanceExempt: number;
}

export interface ArmResult {
  arm: Arm;
  rootId: string;
  depth: number;
  value: number;
  mate: string | null;
  completed: boolean;
  bestAction: string | null;
  plan: string;
  nodes: number;
  chanceNodes: number;
  cutoffs: number;
  maxCutoffs: number;
  minCutoffs: number;
  ttExactHits: number;
  ttHits: number;
  ttStores: number;
  ttSize: number;
  leafNodes: number;
  terminalNodes: number;
  firstMoveCutoffs: number;
  orderedNodes: number;
  fullWindowChanceSearches: number;
  budgetCutoffs: number;
  deadlineCutoffs: number;
  wallMs: number;
  pvs: PvsStats | null;
}

export function labelAction(a: SearchAction | null | undefined): string | null {
  if (!a) return null;
  if (a.type === 'catStep') return `S:${a.direction.key.split(':').pop()}`;
  if (a.type === 'catPlaceTrap') return 'T';
  if (a.type === 'mouseStep') return `M:${a.direction.key.split(':').pop()}`;
  if (a.type === 'mouseSkill') return 'K';
  if (a.type === 'chooseTunnel') return `X:${a.r},${a.c}`;
  return '?';
}

export function labelPlan(plan: SearchAction[]): string {
  return plan
    .map((a) => {
      if (a.type === 'catStep') return a.direction.key.split(':').pop()!;
      if (a.type === 'catPlaceTrap') return 'T';
      if (a.type === 'mouseStep') return `m${a.direction.key.split(':').pop()}`;
      if (a.type === 'mouseSkill') return 'K';
      return 'X';
    })
    .join('');
}

function armCtx(
  arm: Arm,
  useTT: boolean,
  deadline: { at: number; now: () => number } | null,
  maxNodes: number = MAX_NODES,
): SearchContext {
  const make = arm === 'A' ? createProdContext : createForkContext;
  // planHardCatTurn's exact arguments: TT / Alpha-Beta / ordering ON, 0 threat
  // extension credits, threat ordering explicitly OFF.
  const ctx = make(RULES, maxNodes, useTT, true, true, 0, false);
  ctx.capturePlan = true;
  ctx.leafEvaluator = LEAF;
  if (deadline) {
    ctx.deadlineMs = deadline.at;
    ctx.now = deadline.now;
  } else {
    ctx.now = () => 0; // frozen clock: no wall-clock abort on fixed-depth runs
  }
  return ctx;
}

function switchArm(arm: Arm): void {
  // A / A_FORK → PVS off.  B → PVS on, chance-blind scouting (pre-registered).
  // C → PVS on, chance-exempt (secondary mechanism, reported separately).
  if (arm === 'A' || arm === 'A_FORK') setPvsEnabled(false);
  else setPvsEnabled(true);
  setPvsChanceExempt(arm === 'C');
  // Arm isolation: the bound-contract switch belongs to none of A..C. Resetting
  // it here is what stops a previously-run arm D from leaking into arm B.
  setPvsStrictBounds(false);
  resetPvsCounters();
}

function pvsSnapshot(arm: Arm): PvsStats | null {
  return arm === 'A' ? null : { ...pvsCounters };
}

/** Fixed-depth run: frozen clock, generous node budget, no iterative deepening. */
export function runFixed(
  arm: Arm,
  state: GameEngineState,
  depth: number,
  opts: { useTT?: boolean; maxNodes?: number } = {},
): ArmResult {
  switchArm(arm);
  const useTT = opts.useTT ?? true;
  const ctx = armCtx(arm, useTT, null, opts.maxNodes ?? MAX_NODES);
  const t0 = performance.now();
  const r = arm === 'A' ? searchProd(state, depth, ctx) : searchFork(state, depth, ctx);
  const wall = performance.now() - t0;
  const d = r.diagnostics;
  return {
    arm,
    rootId: '',
    depth,
    value: r.value,
    mate: r.mate,
    completed: r.completed,
    bestAction: labelAction(r.action),
    plan: labelPlan(r.catTurnPlan ?? []),
    nodes: d.nodes,
    chanceNodes: d.chanceNodes,
    cutoffs: d.alphaBetaCutoffs,
    maxCutoffs: d.alphaBetaMaxCutoffs,
    minCutoffs: d.alphaBetaMinCutoffs,
    ttExactHits: d.ttExactHits,
    ttHits: d.ttHits,
    ttStores: d.ttStores,
    ttSize: ctx.tt.size,
    leafNodes: d.leafNodes,
    terminalNodes: d.terminalNodes,
    firstMoveCutoffs: d.firstMoveCutoffCount,
    orderedNodes: d.orderedNodes,
    fullWindowChanceSearches: d.fullWindowChanceSearches,
    budgetCutoffs: d.budgetCutoffs,
    deadlineCutoffs: d.deadlineCutoffs,
    wallMs: +wall.toFixed(3),
    pvs: pvsSnapshot(arm),
  };
}

export interface DeadlineResult {
  arm: Arm;
  completedDepth: number;
  attemptedDepth: number;
  fallback: boolean;
  planLen: number;
  plan: string;
  wallMs: number;
  nodes: number;
  deadlineExceeded: boolean;
  budgetExhausted: boolean;
  value: number;
  mate: string | null;
  pvs: PvsStats | null;
}

/** 100 ms main-search wall, iterative deepening — the production call shape. */
export function runDeadline(
  arm: Arm,
  state: GameEngineState,
  budgetMs: number,
  maxDepthTurns = 4,
): DeadlineResult {
  switchArm(arm);
  const nowFn = () => performance.now();
  const t0 = nowFn();
  const deadline = { at: t0 + budgetMs, now: nowFn };
  const ctx = armCtx(arm, true, deadline);
  const opts = {
    rules: RULES,
    maxDepthTurns,
    maxNodes: 500_000,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    useThreatOrdering: false,
    leafEvaluator: LEAF,
    deadlineMs: t0 + budgetMs,
    now: nowFn,
    maxThreatExtensions: 0,
  };
  const r = arm === 'A' ? searchProdIterative(state, opts) : searchForkIterative(state, opts);
  const wall = nowFn() - t0;
  return {
    arm,
    completedDepth: r.completedDepth,
    attemptedDepth: r.attemptedDepth,
    fallback: !(r.completed && r.catTurnPlan.length > 0),
    planLen: r.catTurnPlan.length,
    plan: labelPlan(r.catTurnPlan),
    wallMs: +wall.toFixed(3),
    nodes: r.diagnostics.totalNodes ?? r.diagnostics.nodes,
    deadlineExceeded: r.deadlineExceeded,
    budgetExhausted: r.budgetExhausted,
    value: r.value,
    mate: r.mate,
    pvs: pvsSnapshot(arm),
  };
}

// ---------------------------------------------------------------------------
// ROOTS — the 25 frozen G0.4F-2B-1.9D corpus roots (3 human games, per turn).
// ---------------------------------------------------------------------------
export interface CorpusEntry {
  id: string;
  root: GameEngineState;
}

let corpusCache: CorpusEntry[] | null = null;

export function corpus(): CorpusEntry[] {
  if (corpusCache) return corpusCache;
  const out: CorpusEntry[] = [];
  for (const sg of parseThreeGames()) {
    for (const t of sg.game.turns) {
      out.push({ id: `G${sg.gameNo}T${t.turn}`, root: restoreTurnRoot(t) });
    }
  }
  corpusCache = out;
  return out;
}

function findRoot(id: string): GameEngineState {
  const hit = corpus().find((c) => c.id === id);
  if (!hit) throw new Error(`root ${id} not in corpus`);
  return hit.root;
}

function cloneBoard(s: GameEngineState): GameEngineState['board'] {
  return s.board.map((row) => row.map((cell) => ({ ...cell })));
}

function firstEmptyCell(s: GameEngineState): { r: number; c: number } {
  for (let r = 0; r < s.config.boardSize; r++) {
    for (let c = 0; c < s.config.boardSize; c++) {
      const cell = s.board[r][c];
      if (cell.type !== CellType.Empty || cell.piece || cell.hasButter) continue;
      if (s.catPosition.r === r && s.catPosition.c === c) continue;
      if (s.mousePosition.r === r && s.mousePosition.c === c) continue;
      return { r, c };
    }
  }
  throw new Error('no empty cell');
}

export interface Control {
  id: string;
  note: string;
  state: GameEngineState;
  legalActions: number;
  stateKey: string;
}

/**
 * Ruleset-v2 edge controls, derived from one real corpus root by MINIMAL field
 * mutation so both arms are handed ONE identical, key-able state. Each control
 * records how many actions the REAL generator produces at its root — 0 for the
 * no-legal-action path, which is the only way that branch is reachable.
 */
export function controls(): Control[] {
  const out: Control[] = [];
  const base = findRoot('G1T5');
  const mk = (id: string, note: string, s: GameEngineState): void => {
    out.push({
      id,
      note,
      state: s,
      legalActions: generateLegalSearchActions(s, RULES).length,
      stateKey: stateKey(s),
    });
  };

  mk('C_TRAP', 'trap armed adjacent to the mouse', {
    ...base,
    board: cloneBoard(base),
    trapPosition: { r: base.mousePosition.r, c: base.mousePosition.c + 1 },
    catTrapsRemaining: 0,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
  } as GameEngineState);

  mk('C_TRAP_RECLAIM', 'cat standing on its own trap (0-cost reclaim)', {
    ...base,
    board: cloneBoard(base),
    catPosition: { r: 4, c: 4 },
    trapPosition: { r: 4, c: 4 },
    catTrapsRemaining: 1,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
  } as GameEngineState);

  {
    const board = cloneBoard(base);
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      board[4 + dr][4 + dc] = { type: CellType.Wall } as never;
    }
    mk('C_NO_LEGAL', 'cat walled in -> no legal action (RULE_EDGE_CASE)', {
      ...base,
      board,
      catPosition: { r: 4, c: 4 },
      trapPosition: null,
      catTrapsRemaining: 0,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
    } as GameEngineState);
  }

  {
    const n = base.config.boardSize - 1;
    mk('C_TUNNEL', 'phase=choosing_tunnel_exit with 3 exits', {
      ...base,
      phase: GamePhase.ChoosingTunnelExit,
      tunnelExitChoices: [{ r: 0, c: 0 }, { r: 0, c: n }, { r: n, c: 0 }],
      currentPlayer: PieceType.Mouse,
    } as GameEngineState);
  }

  {
    const e1 = firstEmptyCell(base);
    // ONE ghost, no placement debt. Two ghosts + debt makes the boundary
    // resolution enumerate every injective assignment over the free cells
    // (measured: >60k nodes / 139 s at D2 with a 60k cap), which is a property
    // of the CHANCE enumerator, not of PVS. The single-ghost form exercises the
    // same code path and stays affordable.
    mk('C_GHOST', 'one pending ghost spawn at the cat->mouse boundary', {
      ...base,
      board: cloneBoard(base),
      pendingButterSpawns: [e1],
      pendingButterPlacementDebt: 0,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
    } as GameEngineState);
  }

  {
    const board = cloneBoard(base);
    const mr = base.mousePosition.r;
    const mc = base.mousePosition.c;
    const target = mc + 1 < base.config.boardSize ? { r: mr, c: mc + 1 } : { r: mr, c: mc - 1 };
    board[target.r][target.c] = { ...board[target.r][target.c], hasButter: true } as never;
    mk('C_BUTTER_PICKUP', 'mouse beside butter -> pickup opens a CHANCE node', {
      ...base,
      board,
      butterPositions: [target],
      mouseHasButter: false,
      mouseSkillActive: true,
      currentPlayer: PieceType.Mouse,
      mouseMovesLeft: 3,
      catMovesLeft: 0,
      trapPosition: null,
      catTrapsRemaining: 0,
    } as GameEngineState);
  }

  {
    const board = cloneBoard(base);
    board[4][5] = { type: CellType.Box } as never;
    board[4][6] = { type: CellType.Empty } as never;
    mk('C_PUSH', 'box pushable from the cat cell', {
      ...base,
      board,
      catPosition: { r: 4, c: 4 },
      trapPosition: null,
      catTrapsRemaining: 0,
      currentPlayer: PieceType.Cat,
      catMovesLeft: 4,
    } as GameEngineState);
  }

  for (const k of [3, 5]) {
    mk(`C_CAT${k}`, `cat has ${k} steps (config.catBaseMoves=${k})`, {
      ...base,
      board: cloneBoard(base),
      config: { ...base.config, catBaseMoves: k } as GameEngineState['config'],
      currentPlayer: PieceType.Cat,
      catMovesLeft: k,
      trapPosition: null,
      catTrapsRemaining: 0,
    } as GameEngineState);
  }

  return out;
}

/**
 * Replay a cat-turn plan through the REAL engine transitions (the same
 * `simulateSearchAction` the search itself used). A plan that the real engine
 * refuses is a hard failure — this is the executability gate, not a value test.
 */
export function replayPlan(state: GameEngineState, plan: SearchAction[]): {
  applied: number;
  ok: boolean;
  terminal: string;
  endPlayer: string;
  error: string | null;
} {
  let cur = state;
  let applied = 0;
  for (const a of plan) {
    if (cur.phase !== GamePhase.Playing) break;
    const sim = simulateSearchAction(cur, a, RULES);
    if (sim.kind !== 'deterministic') {
      return { applied, ok: false, terminal: String(cur.phase), endPlayer: String(cur.currentPlayer), error: `action ${labelAction(a)} hit a chance node` };
    }
    const next = sim.state;
    if (stateKey(next) === stateKey(cur)) {
      return { applied, ok: false, terminal: String(cur.phase), endPlayer: String(cur.currentPlayer), error: `action ${labelAction(a)} was a no-op` };
    }
    cur = next;
    applied++;
  }
  return { applied, ok: true, terminal: String(cur.phase), endPlayer: String(cur.currentPlayer), error: null };
}

export function writeOut(dir: string, name: string, payload: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(payload, null, 1));
}

export function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, 'utf8'));
}

export { GamePhase, PieceType, CellType };
export type { GameEngineState, SearchAction };
