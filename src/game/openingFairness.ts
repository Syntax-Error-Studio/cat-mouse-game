/**
 * RULE-B — bounded opening fairness certification (initial butter only).
 *
 * The auto-generated opening places butter by static distance rules today
 * (`generateButterPositions`). That is NOT a fairness proof: it ignores the
 * mouse's actual pickup → hole route, the cat's legal defence (pushes, trap,
 * capture, lane blocking) and the real alternating turn economy. This module
 * adds a BOUNDED, PURE-verdict check over the REAL rule transitions:
 *
 *   CERTIFIED_NO_CERTAIN_CAT_LOSS
 *                               inside the declared caps/horizon the mouse has
 *                               NO probability-1 forced win: every mouse
 *                               strategy has at least one legal cat defence, or
 *                               one positive-probability chance outcome in
 *                               which the win is not certain. This excludes
 *                               only the C-class CERTAIN cat loss. B-class risk
 *                               (a mouse win with positive but < 1 probability)
 *                               is explicitly NOT excluded — the certificate
 *                               never claims every chance outcome is safe, and
 *                               never claims the mouse cannot win;
 *   PROVEN_EARLY_FORCED_LOSS    some mouse strategy wins against EVERY legal
 *                               cat response and EVERY positive-probability
 *                               chance outcome (probability 1) within the
 *                               horizon — a C-class certain cat loss;
 *   UNKNOWN                     the caps/horizon were exhausted first, or a
 *                               CHANCE node was malformed. It is NEVER treated
 *                               as safe.
 *
 * Soundness notes (do not weaken without re-reading the spec):
 *  - All nodes are expanded with the engine's own RuleSet
 *    (`createEngineRuleSet`) and the shared legal-action enumeration, so boxes,
 *    obstacles, pushes, trap retrieval, capture, tunnels, the skill, carrying
 *    speed and the real turn hand-off are the production rules — not a
 *    Manhattan model.
 *  - CHANCE nodes are the real ghost-announcement / ghost-boundary nodes. A
 *    probability-1 mouse win needs EVERY positive-probability outcome to win
 *    (the mouse cannot foresee or choose the random spawn); a single SAFE
 *    outcome refutes that guarantee — and only that guarantee. It says nothing
 *    about the other outcomes' safety. All weights are validated (finite,
 *    strictly positive, total mass 1) BEFORE any short-circuit, so a malformed
 *    CHANCE node is UNKNOWN, never certified.
 *  - The cat is an AND node: it picks the first response that survives, so a
 *    proven loss means the cat had no defence at all.
 *  - A finite-horizon certificate is NOT a global game-theoretic proof. This
 *    module never claims more than the horizon it actually completed.
 *
 * This module is generation-time only: it must never be called per action, and
 * it must not touch the H1 evaluator, the Sidecar, or the search budgets.
 */
import { createEngineRuleSet, createInitialState } from './engine';
import type { GameEngineState } from './engine';
import type { GameConfig } from './config';
import { BOARD_SIZE_MAX, BOARD_SIZE_MIN } from './config';
import { CellType, DIRECTIONS, GamePhase, PieceType } from './types';
import { catHasLegalSpatialMove, mouseHasLegalSpatialMove } from './rules/mobility';
import {
  getMouseHoleCells,
  getTunnelCorners,
  hasButterAt,
  isInBounds,
  isMouseHoleCell,
  isTunnelCornerCell,
} from './rules/tunnelRules';
import { generateLegalSearchActions } from './ai/legalActions';
import { simulateSearchAction } from './ai/simulator';
import { stateKey } from './ai/transposition';
import type { RuleSet, SearchAction } from './ai/searchTypes';

export const SUPPORTED_BOARD_MIN = BOARD_SIZE_MIN;
export const SUPPORTED_BOARD_MAX = BOARD_SIZE_MAX;

export interface OpeningCaps {
  /** Deterministic node budget. A cap hit yields UNKNOWN (fail closed). */
  maxNodes: number;
  /** Mouse turns the mouse may use to force a win. */
  horizonTurns: number;
}

export const DEFAULT_OPENING_CAPS: OpeningCaps = {
  maxNodes: 20_000,
  horizonTurns: 3,
};

export type OpeningUnknownReason =
  | 'NODE_CAP'
  | 'HORIZON'
  | 'UNSUPPORTED_CONFIG'
  | 'INVALID_CHANCE';

/**
 * Three-valued verdict of the bounded opening certificate.
 *
 * - `CERTIFIED_NO_CERTAIN_CAT_LOSS` — no probability-1 mouse win within the
 *   declared caps/horizon. B-class risk stays: with positive probability the
 *   mouse may still win. Only the C-class CERTAIN cat loss is excluded.
 * - `PROVEN_EARLY_FORCED_LOSS` — a probability-1 mouse win: the mouse wins
 *   against every legal cat response and every positive-probability chance
 *   outcome within the horizon (a C-class certain cat loss).
 * - `UNKNOWN` — caps/horizon exhausted or a malformed CHANCE node. Never
 *   treated as safe.
 */
export type OpeningVerdict =
  | 'CERTIFIED_NO_CERTAIN_CAT_LOSS'
  | 'PROVEN_EARLY_FORCED_LOSS'
  | 'UNKNOWN';

export interface OpeningCertification {
  /** See `OpeningVerdict`; never a stronger claim than the caps allow. */
  verdict: OpeningVerdict;
  horizonTurns: number;
  maxNodes: number;
  exploredNodes: number;
  /** Nodes cut by the sound relaxed bound (never expanded). */
  prunedNodes: number;
  /** Present when verdict === 'UNKNOWN'. */
  reason?: OpeningUnknownReason;
  /** Present when verdict === 'PROVEN_EARLY_FORCED_LOSS' (first winning action). */
  witnessAction?: SearchAction;
}

type Tri = 'WIN' | 'SAFE' | 'UNKNOWN';

interface InternalTri {
  tri: Tri;
  reason?: OpeningUnknownReason;
  witness?: SearchAction;
}

const WIN: InternalTri = { tri: 'WIN' };
const SAFE: InternalTri = { tri: 'SAFE' };
const unknown = (reason: OpeningUnknownReason): InternalTri => ({ tri: 'UNKNOWN', reason });

interface SolveCtx {
  rules: RuleSet;
  nodes: number;
  maxNodes: number;
  /** Only fully-decided results are memoized; UNKNOWN never is. */
  memo: Map<string, Tri>;
  capHit: boolean;
  horizonHit: boolean;
  relaxed: RelaxedGeometry;
  relaxedPrune: boolean;
  prunedNodes: number;
}

// ---------------------------------------------------------------------------
// Sound relaxed bound (the only thing that makes default boards tractable)
// ---------------------------------------------------------------------------

/**
 * Geometry of the RELAXED model used to prove "the mouse cannot win within the
 * remaining horizon". EVERY assumption must make the mouse stronger than it
 * really is, so the resulting step count is a LOWER bound on the true number of
 * mouse steps needed:
 *  - the cat is absent (it cannot block a route or capture the mouse);
 *  - every in-bounds cell is walkable (boxes, piles, walls, the trap and even
 *    the hole itself are treated as open floor);
 *  - a tunnel hop costs one step (stepping onto the entrance) and lands for
 *    free, with no butter-carrying restriction and no turn-end penalty.
 *
 * The mouse also cannot win by stranding the cat: it never moves a box, so the
 * cat's mobility is decided by the cat's own moves only. `catHasPatrolEscape`
 * below proves the cat can keep one empty neighbour forever (patrol back and
 * forth), which rules that win out before the bound is used.
 */
interface RelaxedGeometry {
  boardSize: number;
  holeCells: { r: number; c: number }[];
  corners: { r: number; c: number }[];
  /** min over hole cells of the Manhattan distance (tunnel-free lower bound). */
  exitToHole: number;
}

function manhattan(a: { r: number; c: number }, b: { r: number; c: number }): number {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

function buildRelaxedGeometry(state: GameEngineState): RelaxedGeometry {
  const holeCells = getMouseHoleCells(state.config);
  const corners = getTunnelCorners(state.config).map((t) => ({ r: t.r, c: t.c }));
  return {
    boardSize: state.config.boardSize,
    holeCells,
    corners,
    exitToHole: Math.min(...corners.map((t) => Math.min(...holeCells.map((h) => manhattan(t, h))))),
  };
}

/** Relaxed Manhattan distance between two arbitrary cells (one tunnel hop allowed). */
function relaxedNear(geo: RelaxedGeometry, from: { r: number; c: number }, to: { r: number; c: number }): number {
  let best = manhattan(from, to);
  for (const e of geo.corners) {
    const reach = manhattan(from, e);
    for (const x of geo.corners) {
      if (x.r === e.r && x.c === e.c) continue;
      best = Math.min(best, reach + manhattan(x, to));
    }
  }
  return best;
}

/** Relaxed distance from a cell to the nearest hole cell (one tunnel hop allowed). */
function relaxedToHole(geo: RelaxedGeometry, from: { r: number; c: number }): number {
  let best = Infinity;
  for (const h of geo.holeCells) best = Math.min(best, relaxedNear(geo, from, h));
  return best;
}

/**
 * Lower bound on the number of mouse STEPS needed to win from `state`.
 *
 * A mouse win needs butter carried into the hole (the only other MouseWins
 * source is RULE-A cat stranding, excluded by `catHasPatrolEscape`). When not
 * carrying, the FIRST pickup must be a butter that already exists (an initial
 * butter or an already-announced ghost): a future ghost only exists after a
 * pickup, so every winning line passes through one of these cells. The path
 * `pos -> g -> hole` is therefore contained in every winning line, and the
 * relaxed distance underestimates both legs.
 */
function relaxedMinStepsAt(
  geo: RelaxedGeometry,
  pos: { r: number; c: number },
  carrying: boolean,
  targets: { r: number; c: number }[],
): number {
  if (carrying) return relaxedToHole(geo, pos);
  let best = Infinity;
  for (const g of targets) best = Math.min(best, relaxedNear(geo, pos, g) + relaxedToHole(geo, g));
  return best;
}

function relaxedMinSteps(state: GameEngineState, geo: RelaxedGeometry): number {
  return relaxedMinStepsAt(
    geo,
    state.mousePosition,
    state.mouseHasButter,
    [...state.butterPositions, ...state.pendingButterSpawns],
  );
}

/**
 * Upper bound on the mouse steps available within `depthTurns` mouse turns.
 * Deliberately generous:
 *  - the current turn keeps whatever budget it already has, plus the skill's
 *    extra moves. A pickup is a normal step INSIDE that budget, so it does NOT
 *    reduce the bound: 4 moves + 3 skill = 1 pickup step + 6 remaining steps;
 *  - every later turn uses the skill once (it resets at the end of each mouse
 *    turn), whether the turn starts carrying (3 + 3) or not (4 + 3).
 * A mouse turn can never exceed these values under the real engine.
 */
function relaxedMaxSteps(state: GameEngineState, depthTurns: number): number {
  const cfg = state.config;
  const extra = Math.max(0, cfg.mouseSkillExtraMoves);
  const first = Math.max(0, state.mouseMovesLeft) + (state.mouseSkillActive ? 0 : extra);
  const future = Math.max(cfg.mouseBaseMoves, cfg.mouseBaseMoves + extra, cfg.mouseCarryingMoves + extra);
  return first + Math.max(0, depthTurns - 1) * future;
}

/**
 * Is (r,c) a cell the cat can actually STEP INTO as a permanent patrol entry?
 *
 * Mirrors the enterability order of `canCatStepTo` (the RULE-A kernel) and the
 * real `catMove`: mouse hole, tunnel corner, entity butter, fixed obstacle and
 * void are rejected BEFORE any capture is considered, so a mouse standing on
 * such a cell never makes it enterable — the cat can neither capture there nor
 * patrol through it. Boxes are rejected as well: a push is a one-off transit,
 * never a repeatable two-cell patrol path.
 *
 * Exported for the directed legality comparison against the real engine.
 */
export function isCatPatrolEntry(state: GameEngineState, r: number, c: number): boolean {
  const { config, board } = state;
  if (!isInBounds(r, c, config.boardSize)) return false;
  if (isMouseHoleCell(r, c, config.mouseHole)) return false;
  if (isTunnelCornerCell(r, c, getTunnelCorners(config))) return false;
  if (hasButterAt(r, c, state.butterPositions)) return false;
  if (board[r][c].hasButter) return false;
  const type = board[r][c].type;
  if (type === CellType.Pile || type === CellType.Wall) return false;
  if (type === CellType.Void) return false;
  if (type === CellType.Box) return false; // push-only, never a patrol path
  return true;
}

/**
 * Can the cat guarantee it is never stranded, whatever the mouse does?
 *
 * True when the cat has an adjacent legal NON-PUSH entry (`isCatPatrolEntry`).
 * The cat can then patrol X <-> A forever: the mouse cannot create boxes, and
 * ghost butter never spawns within 3 steps of the cat at the boundary, so the
 * pair can never gain a blocker. This is what makes the relaxed step bound
 * safe: it excludes RULE-A MouseWins without enumerating it.
 *
 * A stranded cat has no such entry, so a mouse standing on a hole or tunnel
 * corner (which the cat can never enter, let alone capture on) can never
 * justify this premise.
 */
function catHasPatrolEscape(state: GameEngineState): boolean {
  const { catPosition: p } = state;
  for (const d of DIRECTIONS) {
    if (isCatPatrolEntry(state, p.r + d.dr, p.c + d.dc)) return true;
  }
  return false;
}


/** Number of mouse half-turns consumed by a transition. */
function depthAfter(actionActor: PieceType, nextActor: PieceType, depthTurns: number): number {
  return actionActor === PieceType.Mouse && nextActor !== PieceType.Mouse
    ? depthTurns - 1
    : depthTurns;
}

/**
 * Deterministic action ORDERING. Pure performance heuristic — the search still
 * tries every legal action until one settles the node. Moving the mouse closer
 * (in the relaxed metric) to a pickup-and-return line is tried first, so a
 * forced win is found before the node budget is wasted on irrelevant wandering.
 * Cat actions keep their generated order (they act as AND, where the first
 * surviving response is enough).
 */
function orderActions(state: GameEngineState, actions: SearchAction[], ctx: SolveCtx): SearchAction[] {
  const geo = ctx.relaxed;
  const targets = [...state.butterPositions, ...state.pendingButterSpawns];
  const key = (a: SearchAction): number => {
    if (a.type === 'mouseStep') {
      const np = {
        r: state.mousePosition.r + a.direction.dr,
        c: state.mousePosition.c + a.direction.dc,
      };
      const idx = targets.findIndex((t) => t.r === np.r && t.c === np.c);
      const carrying = state.mouseHasButter || idx >= 0;
      const remaining = idx >= 0 ? targets.filter((_, i) => i !== idx) : targets;
      return relaxedMinStepsAt(geo, np, carrying, remaining);
    }
    if (a.type === 'mouseSkill') {
      return relaxedMinStepsAt(geo, state.mousePosition, false, targets);
    }
    if (a.type === 'chooseTunnel') {
      return relaxedMinStepsAt(geo, { r: a.r, c: a.c }, state.mouseHasButter, targets);
    }
    return Infinity;
  };
  return actions
    .map((a, i) => ({ a, i, k: key(a) }))
    .sort((x, y) => (x.k === y.k ? x.i - y.i : x.k - y.k))
    .map((e) => e.a);
}

// ---------------------------------------------------------------------------
// Explicit-stack DFS
//
// One real transition used to be one `solve` call, so a cat turn with M
// remaining steps nested M `solve` frames — each of them carrying its own
// `generateLegalSearchActions` / `simulateSearchAction` frames. The node cap is
// 20000, but the JS call stack dies at roughly a thousand of those levels, so
// the two disagreed: `catBaseMoves >= ~1500` made `certifyOpening` throw
// `RangeError: Maximum call stack size exceeded`, and took `createGameState`
// with it (PPC-P1-OPENING-STACK-01).
//
// The traversal below is the SAME depth-first search in the SAME order, driven
// by a heap stack instead of the call stack. Every observable is preserved:
//   - `ctx.nodes++` still runs once per expanded state, in DFS order, BEFORE
//     the terminal / horizon / memo / prune tests, so `exploredNodes`, the node
//     at which the cap trips and every downstream verdict are unchanged;
//   - the memo is consulted at the same point and written only when a node is
//     fully decided (UNKNOWN is never memoized);
//   - the legal-action list is generated and ordered at the same moment;
//   - the OR (mouse) / AND (cat) short-circuits and the CHANCE validation pass
//     keep their original order, so `witnessAction` and `prunedNodes` match;
//   - no frame copies a board: it holds only a reference to the state its
//     transition produced, so peak live memory stays O(depth), exactly what the
//     call stack used to hold.
// ---------------------------------------------------------------------------

interface NodeFrame {
  kind: 'node';
  state: GameEngineState;
  depthTurns: number;
  /** Aggregation of this node (actor, not phase). Filled at entry. */
  mouseActor: boolean;
  /** Memo key; '' until the node passes the terminal/horizon tests. */
  memoKey: string;
  actions: SearchAction[];
  /** Index of the action whose transition has just been (or is about to be) run. */
  index: number;
  entered: boolean;
  winWitness: SearchAction | null;
  sawSafe: boolean;
  sawUnknown: boolean;
  unknownReason: OpeningUnknownReason | null;
}

interface ChanceFrame {
  kind: 'chance';
  outcomes: { state: GameEngineState; weight: number }[];
  actionActor: PieceType;
  depthTurns: number;
  index: number;
  validated: boolean;
  allWin: boolean;
  sawUnknown: OpeningUnknownReason | null;
}

type Frame = NodeFrame | ChanceFrame;

/** One stack step: the frame is decided, or a child frame must run first. */
type Step = { kind: 'done'; result: InternalTri } | { kind: 'child'; frame: Frame };

function newNodeFrame(state: GameEngineState, depthTurns: number): NodeFrame {
  return {
    kind: 'node',
    state,
    depthTurns,
    mouseActor: false,
    memoKey: '',
    actions: [],
    index: 0,
    entered: false,
    winWitness: null,
    sawSafe: false,
    sawUnknown: false,
    unknownReason: null,
  };
}

/**
 * Node entry — the original prologue of `solve`, unchanged in content and
 * order. Returns a decided result, or `null` when the node must expand its
 * actions.
 */
function enterNode(f: NodeFrame, ctx: SolveCtx): InternalTri | null {
  const state = f.state;
  if (ctx.nodes >= ctx.maxNodes) {
    ctx.capHit = true;
    return unknown('NODE_CAP');
  }
  ctx.nodes++;

  if (state.phase === GamePhase.MouseWins) return WIN;
  if (state.phase === GamePhase.CatWins) return SAFE;

  // The actor decides the aggregation, not the phase: a ChoosingTunnelExit
  // state is still the MOUSE's choice (OR), never a cat AND node.
  const mouseActor = state.currentPlayer === PieceType.Mouse;
  f.mouseActor = mouseActor;
  const mouseTurn = state.phase === GamePhase.Playing && mouseActor;

  if (f.depthTurns <= 0) {
    // The mouse's (H+1)-th turn starts here: outside the declared "H mouse
    // turns" horizon, so the certificate says nothing about it.
    if (mouseActor) return SAFE;
    // A cat turn after the last mouse turn can only end in a mouse win if the
    // cat strands itself; a cat that can patrol forever cannot.
    if (catHasPatrolEscape(state)) return SAFE;
    ctx.horizonHit = true;
    return unknown('HORIZON');
  }

  const memoKey = `${stateKey(state)}|d${f.depthTurns}`;
  f.memoKey = memoKey;
  const memoHit = ctx.memo.get(memoKey);
  if (memoHit) return memoHit === 'WIN' ? WIN : SAFE;

  // Sound relaxed bound: the cat can keep itself mobile forever and the mouse
  // cannot physically cover the required steps inside the remaining turns.
  //
  // Pending ghosts/debt must be EMPTY for the patrol premise. A delayed ghost
  // (blocked at a boundary) was announced while the cat stood elsewhere, so
  // the >=3 spawn rule does not keep it away from this node's patrol pair; it
  // can materialize on the pair and strand the cat (a RULE-A MouseWins the
  // bound would wrongly dismiss). With no pending ghost, every future spawn is
  // drawn while the cat stands on the pair, so the >=3 rule excludes the pair
  // itself and both of its neighbours. Fail closed by skipping the prune.
  const ghostsPending = (state.pendingButterSpawns?.length ?? 0) > 0
    || (state.pendingButterPlacementDebt ?? 0) > 0;
  if (ctx.relaxedPrune && mouseTurn && !ghostsPending && catHasPatrolEscape(state)) {
    if (relaxedMinSteps(state, ctx.relaxed) > relaxedMaxSteps(state, f.depthTurns)) {
      ctx.prunedNodes++;
      ctx.memo.set(memoKey, 'SAFE');
      return SAFE;
    }
  }

  f.actions = orderActions(state, generateLegalSearchActions(state, ctx.rules), ctx);
  if (f.actions.length === 0) {
    // A settled mouse with no action is CatWins (RULE-A), a settled cat with no
    // action is MouseWins; both are terminal phases and were handled above. A
    // Playing dead end can only come from a non-real RuleSet — fail closed.
    return unknown('UNSUPPORTED_CONFIG');
  }
  return null;
}

/** Node exit — the original epilogue of `solve`, unchanged. */
function finishNode(f: NodeFrame, ctx: SolveCtx): InternalTri {
  let result: InternalTri;
  if (f.winWitness) result = { tri: 'WIN', witness: f.winWitness };
  else if (f.mouseActor) result = f.sawUnknown ? unknown(f.unknownReason ?? 'NODE_CAP') : SAFE;
  else if (f.sawSafe) result = SAFE;
  else if (f.sawUnknown) result = unknown(f.unknownReason ?? 'NODE_CAP');
  else result = WIN;

  // Only a fully decided node is memoized; UNKNOWN never is. `memoKey` is
  // always set here (a frame only reaches the action loop through `enterNode`).
  if (f.memoKey !== '' && (result.tri === 'WIN' || result.tri === 'SAFE')) {
    ctx.memo.set(f.memoKey, result.tri);
  }
  return result;
}

/**
 * Build the child frame for one action — the original `applyAction`, split into
 * "run the real transition" + "decide which frame kind it yields".
 */
function childFrame(
  state: GameEngineState,
  action: SearchAction,
  depthTurns: number,
  ctx: SolveCtx,
): Frame {
  const result = simulateSearchAction(state, action, ctx.rules);
  if (result.kind === 'chance') {
    return {
      kind: 'chance',
      outcomes: result.outcomes,
      actionActor: state.currentPlayer,
      depthTurns,
      index: 0,
      validated: false,
      allWin: true,
      sawUnknown: null,
    };
  }
  return newNodeFrame(
    result.state,
    depthAfter(state.currentPlayer, result.state.currentPlayer, depthTurns),
  );
}

/**
 * CHANCE aggregation, adversarial to the mouse's probability-1 guarantee.
 *
 * A forced mouse win needs EVERY positive-probability outcome to win. One SAFE
 * outcome refutes that guarantee, so the solve may short-circuit there — but
 * only AFTER the whole outcome list is validated: every weight must be finite
 * and strictly positive and the weights must sum to 1. A malformed CHANCE node
 * (zero/negative/NaN/Infinity weight, wrong total mass, empty list) is
 * UNKNOWN/INVALID_CHANCE and can never be certified, regardless of which
 * outcome happens to be listed first.
 */
function advanceChance(f: ChanceFrame): Step {
  if (!f.validated) {
    f.validated = true;
    // Pass 1 — mass validation. Nothing here may depend on an outcome's verdict.
    if (f.outcomes.length === 0) return { kind: 'done', result: unknown('INVALID_CHANCE') };
    let weightSum = 0;
    for (const outcome of f.outcomes) {
      if (!Number.isFinite(outcome.weight) || outcome.weight <= 0) {
        return { kind: 'done', result: unknown('INVALID_CHANCE') };
      }
      weightSum += outcome.weight;
    }
    if (!Number.isFinite(weightSum) || Math.abs(weightSum - 1) > 1e-6) {
      return { kind: 'done', result: unknown('INVALID_CHANCE') };
    }
  }

  if (f.index >= f.outcomes.length) {
    // Pass 2 finished. SAFE only refutes a probability-1 win; it does not make
    // the remaining outcomes safe.
    return { kind: 'done', result: f.allWin ? WIN : unknown(f.sawUnknown ?? 'NODE_CAP') };
  }
  const outcome = f.outcomes[f.index];
  return {
    kind: 'child',
    frame: newNodeFrame(
      outcome.state,
      depthAfter(f.actionActor, outcome.state.currentPlayer, f.depthTurns),
    ),
  };
}

/** Feed one completed child result back into a node frame. */
function onNodeChild(f: NodeFrame, r: InternalTri, ctx: SolveCtx): Step {
  if (f.mouseActor) {
    // OR: one winning strategy is enough; otherwise one unproven strategy
    // blocks a SAFE certificate.
    if (r.tri === 'WIN') {
      f.winWitness = r.witness ?? f.actions[f.index];
      return { kind: 'done', result: finishNode(f, ctx) };
    }
    if (r.tri === 'SAFE') {
      f.sawSafe = true;
    } else {
      f.sawUnknown = true;
      f.unknownReason = f.unknownReason ?? (r.reason ?? 'NODE_CAP');
    }
  } else {
    // AND: one surviving cat response is enough; otherwise one unproven
    // response blocks a PROVEN loss.
    if (r.tri === 'SAFE') {
      f.sawSafe = true;
      return { kind: 'done', result: finishNode(f, ctx) };
    }
    if (r.tri === 'UNKNOWN') {
      f.sawUnknown = true;
      f.unknownReason = f.unknownReason ?? (r.reason ?? 'NODE_CAP');
    }
  }

  f.index++;
  if (f.index >= f.actions.length) return { kind: 'done', result: finishNode(f, ctx) };
  return { kind: 'child', frame: childFrame(f.state, f.actions[f.index], f.depthTurns, ctx) };
}

/** Feed one completed child result back into a CHANCE frame. */
function onChanceChild(f: ChanceFrame, r: InternalTri): Step {
  if (r.tri === 'SAFE') return { kind: 'done', result: SAFE }; // one survivable spawn refutes a forced win
  if (r.tri === 'UNKNOWN') {
    f.allWin = false;
    f.sawUnknown = f.sawUnknown ?? (r.reason ?? 'NODE_CAP');
  }
  f.index++;
  if (f.index >= f.outcomes.length) {
    return { kind: 'done', result: f.allWin ? WIN : unknown(f.sawUnknown ?? 'NODE_CAP') };
  }
  const outcome = f.outcomes[f.index];
  return {
    kind: 'child',
    frame: newNodeFrame(
      outcome.state,
      depthAfter(f.actionActor, outcome.state.currentPlayer, f.depthTurns),
    ),
  };
}

/**
 * Three-valued AND/OR over real transitions, driven by an explicit stack.
 *
 * Mouse nodes are OR (the mouse needs one winning strategy → WIN on the first
 * winning action). Cat nodes are AND (the cat needs one surviving response →
 * SAFE on the first safe action). CHANCE is adversarial to the guarantee.
 *
 * Depth is bounded by the node budget (`maxNodes`), not by the JS stack, so a
 * legal-but-large cat move budget now terminates with UNKNOWN/NODE_CAP instead
 * of throwing.
 */
function solve(rootState: GameEngineState, rootDepthTurns: number, ctx: SolveCtx): InternalTri {
  const stack: Frame[] = [newNodeFrame(rootState, rootDepthTurns)];
  /** Result of the child that just finished; consumed by the frame below it. */
  let pending: InternalTri | null = null;

  for (;;) {
    if (pending !== null) {
      if (stack.length === 0) return pending; // the root finished
      const top = stack[stack.length - 1];
      const child: InternalTri = pending;
      pending = null;
      const step: Step = top.kind === 'node' ? onNodeChild(top, child, ctx) : onChanceChild(top, child);
      if (step.kind === 'done') {
        stack.pop();
        pending = step.result;
      } else {
        stack.push(step.frame);
      }
      continue;
    }

    // `pending === null` and an empty stack is unreachable: the root's result is
    // consumed above. The guard makes an accidental invariant break loud.
    if (stack.length === 0) throw new Error('openingFairness: empty frame stack');

    const top = stack[stack.length - 1];
    const step = top.kind === 'node' ? advanceNode(top, ctx) : advanceChance(top);
    if (step.kind === 'done') {
      stack.pop();
      pending = step.result;
    } else {
      stack.push(step.frame);
    }
  }
}

/** Advance a node frame: run its entry, then descend into the next action. */
function advanceNode(f: NodeFrame, ctx: SolveCtx): Step {
  if (!f.entered) {
    f.entered = true;
    const decided = enterNode(f, ctx);
    if (decided) return { kind: 'done', result: decided };
  }
  if (f.index >= f.actions.length) return { kind: 'done', result: finishNode(f, ctx) };
  return { kind: 'child', frame: childFrame(f.state, f.actions[f.index], f.depthTurns, ctx) };
}

export interface CertifyOptions {
  caps?: Partial<OpeningCaps>;
  /** Injectable RuleSet for deterministic constructs; defaults to production. */
  rules?: RuleSet;
  /**
   * Differential-testing seam for the sound relaxed bound. Production always
   * uses it; disabling it can only make the search more conservative (slower,
   * more UNKNOWN), never change a sound verdict.
   */
  relaxedPrune?: boolean;
}

/**
 * Certify one opening state. Pure and deterministic for fixed inputs/caps.
 *
 * The strongest positive answer is `CERTIFIED_NO_CERTAIN_CAT_LOSS`: inside the
 * declared caps/horizon the mouse has no probability-1 forced win. A mouse win
 * that keeps positive, sub-probability risk (B-class) may remain — this is not
 * a claim that the mouse cannot win, and not a claim that every chance outcome
 * is safe for the cat.
 */
export function certifyOpening(
  state: GameEngineState,
  opts: CertifyOptions = {},
): OpeningCertification {
  const caps: OpeningCaps = { ...DEFAULT_OPENING_CAPS, ...(opts.caps ?? {}) };
  const boardSize = state.config.boardSize;
  if (boardSize < SUPPORTED_BOARD_MIN || boardSize > SUPPORTED_BOARD_MAX) {
    return {
      verdict: 'UNKNOWN', reason: 'UNSUPPORTED_CONFIG', prunedNodes: 0,
      horizonTurns: caps.horizonTurns, maxNodes: caps.maxNodes, exploredNodes: 0,
    };
  }
  if (state.phase === GamePhase.MouseWins) {
    return {
      verdict: 'PROVEN_EARLY_FORCED_LOSS', prunedNodes: 0,
      horizonTurns: caps.horizonTurns, maxNodes: caps.maxNodes, exploredNodes: 0,
    };
  }
  if (state.phase === GamePhase.CatWins) {
    return {
      verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', prunedNodes: 0,
      horizonTurns: caps.horizonTurns, maxNodes: caps.maxNodes, exploredNodes: 0,
    };
  }

  const ctx: SolveCtx = {
    rules: opts.rules ?? createEngineRuleSet(),
    nodes: 0,
    maxNodes: caps.maxNodes,
    memo: new Map(),
    capHit: false,
    horizonHit: false,
    relaxed: buildRelaxedGeometry(state),
    relaxedPrune: opts.relaxedPrune ?? true,
    prunedNodes: 0,
  };
  const root = solve(state, caps.horizonTurns, ctx);
  const base = {
    horizonTurns: caps.horizonTurns,
    maxNodes: caps.maxNodes,
    exploredNodes: ctx.nodes,
    prunedNodes: ctx.prunedNodes,
  };
  if (root.tri === 'WIN') {
    return { verdict: 'PROVEN_EARLY_FORCED_LOSS', ...base, witnessAction: root.witness };
  }
  if (root.tri === 'SAFE') return { verdict: 'CERTIFIED_NO_CERTAIN_CAT_LOSS', ...base };
  return {
    verdict: 'UNKNOWN',
    ...base,
    // A malformed CHANCE node is a RuleSet contract violation: report it even
    // when an unrelated branch also exhausted the node cap.
    reason: root.reason === 'INVALID_CHANCE'
      ? 'INVALID_CHANCE'
      : ctx.capHit ? 'NODE_CAP' : (root.reason ?? (ctx.horizonHit ? 'HORIZON' : 'NODE_CAP')),
  };
}

// ---------------------------------------------------------------------------
// Bounded generation policy
// ---------------------------------------------------------------------------

export type GenerationScope = 'AUTO' | 'EXPLICIT';

export interface GenerationOptions extends CertifyOptions {
  /** Bounded retry cap (no infinite random loop). Default 12. */
  maxAttempts?: number;
  /**
   * Deterministic candidate source for tests / replay: full initial butter
   * placements to try, in order. When omitted the game's own random draw is
   * used (`createInitialState`).
   */
  candidateButters?: { r: number; c: number }[][];
  /** Override candidate construction (tests); defaults to the real engine. */
  build?: (butters?: { r: number; c: number }[]) => GameEngineState;
}

export interface GenerationCounts {
  attempts: number;
  unsafe: number;      // PROVEN_EARLY_FORCED_LOSS
  unknown: number;     // UNKNOWN (never accepted as fair)
  underGenerated: number; // fewer butters than configured
  noLegalOpening: number; // an actor already has no legal move
}

export type OpeningGenerationResult =
  | {
      ok: true;
      state: GameEngineState;
      certification: OpeningCertification;
      scope: GenerationScope;
      counts: GenerationCounts;
    }
  | {
      ok: false;
      reason:
        | 'EXPLICIT_LAYOUT'
        | 'UNSUPPORTED_CONFIG'
        | 'NO_CERTIFIED_OPENING'
        | 'UNDER_GENERATED'
        | 'NO_LEGAL_OPENING';
      scope: GenerationScope;
      counts: GenerationCounts;
      /** A full-butter, legal-actions candidate kept only as evidence (UNKNOWN). */
      lastState?: GameEngineState;
    };

/** True when the config supplies its own layout/butter and must not be touched. */
export function isExplicitLayout(config: GameConfig): boolean {
  return (config.customTerrain?.length ?? 0) > 0
    || (config.butterPositions?.length ?? 0) > 0;
}

/**
 * Generate an auto opening that passes the bounded fairness check, or fail
 * closed with a reason. NEVER returns an unverified layout as `ok: true`, and
 * NEVER returns a layout with fewer butters than `config.butterCount`.
 */
export function generateFairOpening(
  config: GameConfig,
  opts: GenerationOptions = {},
): OpeningGenerationResult {
  if (isExplicitLayout(config)) {
    return {
      ok: false, reason: 'EXPLICIT_LAYOUT', scope: 'EXPLICIT',
      counts: { attempts: 0, unsafe: 0, unknown: 0, underGenerated: 0, noLegalOpening: 0 },
    };
  }
  const caps: OpeningCaps = { ...DEFAULT_OPENING_CAPS, ...(opts.caps ?? {}) };
  if (config.boardSize < SUPPORTED_BOARD_MIN || config.boardSize > SUPPORTED_BOARD_MAX) {
    return {
      ok: false, reason: 'UNSUPPORTED_CONFIG', scope: 'AUTO',
      counts: { attempts: 0, unsafe: 0, unknown: 0, underGenerated: 0, noLegalOpening: 0 },
    };
  }

  const build = opts.build ?? ((butters?: { r: number; c: number }[]) =>
    butters
      ? createInitialState({ ...config, butterPositions: butters })
      : createInitialState(config));
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 12);
  const counts: GenerationCounts = { attempts: 0, unsafe: 0, unknown: 0, underGenerated: 0, noLegalOpening: 0 };
  let lastFullLegal: GameEngineState | undefined;
  let allUnderGenerated = true;
  let unsupported = false;

  for (let i = 0; i < maxAttempts; i++) {
    counts.attempts++;
    const injected = opts.candidateButters?.[i];
    const state = build(injected);

    if (state.butterPositions.length !== config.butterCount) {
      counts.underGenerated++;
      continue;
    }
    allUnderGenerated = false;

    // Both sides must be able to act in the produced opening. RULE-A would
    // already have ended a blocked state, but check explicitly so the generator
    // never ships an instantly-decided map.
    const mouseOk = state.phase !== GamePhase.CatWins && mouseHasLegalSpatialMove(state);
    const catOk = state.phase !== GamePhase.MouseWins && catHasLegalSpatialMove(state);
    if (!mouseOk || !catOk) {
      counts.noLegalOpening++;
      continue;
    }

    lastFullLegal = state;
    const cert = certifyOpening(state, { ...opts, caps });
    if (cert.verdict === 'CERTIFIED_NO_CERTAIN_CAT_LOSS') {
      return { ok: true, state, certification: cert, scope: 'AUTO', counts };
    }
    if (cert.verdict === 'PROVEN_EARLY_FORCED_LOSS') counts.unsafe++;
    else {
      counts.unknown++;
      if (cert.reason === 'UNSUPPORTED_CONFIG') unsupported = true;
    }
  }

  const reason = unsupported
    ? 'UNSUPPORTED_CONFIG'
    : allUnderGenerated
      ? 'UNDER_GENERATED'
      : counts.noLegalOpening > 0 && !lastFullLegal
        ? 'NO_LEGAL_OPENING'
        : 'NO_CERTIFIED_OPENING';
  return { ok: false, reason, scope: 'AUTO', counts, lastState: lastFullLegal };
}
