/**
 * PPC-HV-9 P2 — Bounded Tactical Reachability (forensic prototype, NOT production).
 *
 * WHY THIS EXISTS. HV-8 proved that a per-leaf post-push distance map cannot fit the
 * budget (19.1 full-board BFS fields per leaf, 7-8 ms/leaf against a 244 µs/leaf
 * allowance), and HV-9 P0 then proved why the one-push family could never see the T4
 * defensive line: (5,5)→(4,8) in four steps needs THREE pushes (`RRRU`/`RRUR`), so no
 * walk→push→walk route can represent it at any price. The four shapes this prototype
 * is NOT allowed to use are exactly the disqualified ones: full-board one-push BFS,
 * full-board two-push BFS, per-leaf exhaustive state-space search, and a fixed-box
 * optimistic push map presented as a route.
 *
 * WHAT IT DOES INSTEAD. Two cheap, local, engine-only questions:
 *  1. DERIVE a handful of interception cells from the CURRENT PUBLIC STATE only —
 *     production gate cells (the Gate Race threat layer), butter on the board, the
 *     cells that feed the mouse hole, and the cells lying on the mouse's own shortest
 *     return route. Nothing is read from a human log; in particular (4,8) is NEVER
 *     derived, it exists only as a fixture inside the test (§五).
 *  2. ASK the engine whether the cat can stand on each cell within at most
 *     `maxSteps` legal move actions, playing the Manhattan-shortest direction
 *     permutations first. Every step is a real `catMove`; the box layout is whatever
 *     the engine returned last; a capture mid-route ends the line as a terminal; and
 *     the movement budget is set ONCE for the turn and never refilled inside a line.
 *
 * CLAIM GRAMMAR (the point of the shape):
 *  - `REACHABLE_WITHIN_4` — only with a complete legal witness the engine accepted.
 *  - `UNKNOWN` — permutations failed and no exhaustive local sweep was run. Silence
 *    is NEVER read as unreachable: HV-9 P0 found a real 4-step route that every
 *    distance model before it priced at 20.
 *  - `UNREACHABLE_WITHIN_4` — only from `boundedTurnSweep`, which expands EVERY
 *    engine-legal action at EVERY depth up to the cap and reports its own coverage.
 *    A cap or any unexpanded frontier turns the verdict back into UNKNOWN instead of
 *    pretending.
 *
 * Multi-route honesty: the output is a per-cell table. Holding one interception cell
 * is not "the defence is complete" — the mouse has several return routes and each
 * cell claims only what its own witness proves.
 */
import { catMove, type GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GamePhase, type Direction } from '../../types';
import { createEvaluationContext } from '../evaluation';
import { bankTurn, boxLayout, type WitnessToken } from './hv8WitnessPush';

const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;

const TOKENS: Record<string, WitnessToken> = {
  ArrowUp: 'U',
  ArrowDown: 'D',
  ArrowLeft: 'L',
  ArrowRight: 'R',
};

export type TargetKind = 'gate' | 'butter' | 'hole-feed' | 'mouse-return';

export interface TacticalTarget {
  cell: string;
  kinds: TargetKind[];
  /** Production mouse distance, when the mouse can stand there at all. */
  mouseDist: number | null;
  /** Carrying-mode distance from the hole set — how close the cell is to home. */
  holeDist: number | null;
  manhattanFromCat: number;
}

const parseCell = (key: string): { r: number; c: number } => {
  const [r, c] = key.split(',').map(Number);
  return { r, c };
};

/**
 * Interception cells derived from the current public state. Everything comes from the
 * production evaluation context (which the leaf already builds) or from the state
 * itself:
 *  - `gateCells` — the Gate Race threat layer, production geometry.
 *  - `butterPositions` — butter that is on the board right now.
 *  - hole-feed cells — the passable cells orthogonally adjacent to the hole block.
 *  - mouse-return cells — cells on a shortest mouse→hole route, i.e. where
 *    `mouseMap + carryHoleMap` attains the best such sum. That is a route the CURRENT
 *    state says the mouse can walk home along, not a prediction of the future.
 * Only cells within `maxManhattan` of the cat survive: a route longer than the turn
 * budget cannot be witnessed inside this model at all.
 */
export function deriveInterceptionTargets(
  view: GameEngineState,
  ctx: ReturnType<typeof createEvaluationContext>,
  opts: { maxManhattan?: number; maxTargets?: number } = {},
): TacticalTarget[] {
  const maxManhattan = opts.maxManhattan ?? view.config.catBaseMoves;
  const maxTargets = opts.maxTargets ?? 8;
  const size = view.config.boardSize;
  const kinds = new Map<string, TargetKind[]>();
  const add = (cell: string, kind: TargetKind): void => {
    const list = kinds.get(cell) ?? [];
    if (!list.includes(kind)) list.push(kind);
    kinds.set(cell, list);
  };
  for (const g of ctx.gateCells) add(rc(g), 'gate');
  for (const b of view.butterPositions) add(rc(b), 'butter');

  const hole = view.config.mouseHole;
  const isHole = (r: number, c: number): boolean =>
    r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;
  const orthoToHole = (r: number, c: number): boolean =>
    isHole(r - 1, c) || isHole(r + 1, c) || isHole(r, c - 1) || isHole(r, c + 1);
  for (let r = hole.r - 1; r <= hole.r + hole.size; r++) {
    for (let c = hole.c - 1; c <= hole.c + hole.size; c++) {
      if (r < 0 || c < 0 || r >= size || c >= size) continue;
      if (isHole(r, c) || !orthoToHole(r, c)) continue;
      const t = view.board[r][c].type;
      if (t === CellType.Wall || t === CellType.Void) continue;
      add(rc({ r, c }), 'hole-feed');
    }
  }

  let best = Number.POSITIVE_INFINITY;
  const sums = new Map<string, number>();
  for (const [cell, md] of ctx.mouseMap) {
    const hd = ctx.carryHoleMap.get(cell);
    if (hd === undefined) continue;
    const s = md + hd;
    sums.set(cell, s);
    if (s < best) best = s;
  }
  for (const [cell, s] of sums) if (s === best) add(cell, 'mouse-return');

  const cat = rc(view.catPosition);
  const out: TacticalTarget[] = [];
  for (const [cell, list] of kinds) {
    if (cell === cat) continue;
    const p = parseCell(cell);
    if (p.r < 0 || p.c < 0 || p.r >= size || p.c >= size) continue;
    const t = view.board[p.r][p.c].type;
    if (t === CellType.Wall || t === CellType.Void || t === CellType.MouseHole) continue;
    const man = Math.abs(p.r - view.catPosition.r) + Math.abs(p.c - view.catPosition.c);
    if (man > maxManhattan) continue;
    out.push({
      cell,
      kinds: list,
      mouseDist: ctx.mouseMap.get(cell) ?? null,
      holeDist: ctx.carryHoleMap.get(cell) ?? null,
      manhattanFromCat: man,
    });
  }
  // Nearest the hole first — a cell the mouse needs on its way home is the whole point
  // of intercepting — then the cheapest to read.
  out.sort((a, b) =>
    (a.holeDist ?? 1e9) - (b.holeDist ?? 1e9) || a.manhattanFromCat - b.manhattanFromCat || a.cell.localeCompare(b.cell));
  return out.slice(0, maxTargets);
}

/** The direction multiset a Manhattan-shortest route to `to` is made of. */
export function shortestDirections(from: string, to: string): Direction[] {
  const a = parseCell(from);
  const b = parseCell(to);
  const out: Direction[] = [];
  for (let i = 0; i < Math.abs(b.r - a.r); i++) out.push(b.r < a.r ? DIRECTIONS[0] : DIRECTIONS[1]);
  for (let i = 0; i < Math.abs(b.c - a.c); i++) out.push(b.c < a.c ? DIRECTIONS[2] : DIRECTIONS[3]);
  return out;
}

/** Unique permutations of a direction multiset, generated in direction-key order. */
export function permutations(dirs: Direction[], cap = 24): Direction[][] {
  const sorted = [...dirs].sort((a, b) => a.key.localeCompare(b.key));
  const out: Direction[][] = [];
  const used = new Array<boolean>(sorted.length).fill(false);
  const walk = (acc: Direction[]): void => {
    if (out.length >= cap) return;
    if (acc.length === sorted.length) {
      out.push([...acc]);
      return;
    }
    for (let i = 0; i < sorted.length; i++) {
      if (used[i]) continue;
      if (i > 0 && !used[i - 1] && sorted[i].key === sorted[i - 1].key) continue; // one order per equal run
      used[i] = true;
      acc.push(sorted[i]);
      walk(acc);
      acc.pop();
      used[i] = false;
    }
  };
  walk([]);
  return out;
}

export interface PlayOutcome {
  /** Index of the first step the engine refused, or -1. */
  refusedAt: number;
  /** Index of the step that captured the mouse, or -1. A capture ends the line. */
  captureAt: number;
  stepsApplied: number;
  pushes: number;
  end: GameEngineState;
}

/**
 * Play one action sequence on the real engine. The turn budget is set ONCE at the
 * start; nothing inside the four steps re-banks it, so a line longer than the turn
 * simply stops being legal. The box layout the engine returned is what the next step
 * sees — no frozen layout anywhere in this file.
 */
export function playLine(view: GameEngineState, tokens: Direction[]): PlayOutcome {
  let s = bankTurn(view);
  let pushes = 0;
  let refusedAt = -1;
  let captureAt = -1;
  let applied = 0;
  for (let i = 0; i < tokens.length; i++) {
    const before = rc(s.catPosition);
    const layoutBefore = boxLayout(s);
    s = catMove(s, tokens[i]);
    if (rc(s.catPosition) === before) {
      refusedAt = i;
      break;
    }
    applied++;
    if (boxLayout(s) !== layoutBefore) pushes++;
    if (s.phase !== GamePhase.Playing) {
      captureAt = i;
      break;
    }
  }
  return { refusedAt, captureAt, stepsApplied: applied, pushes, end: s };
}

export type ReachVerdict = 'REACHABLE_WITHIN_4' | 'UNREACHABLE_WITHIN_4' | 'UNKNOWN';

export interface Witness {
  steps: number;
  witness: WitnessToken[];
  pushes: number;
  endsInCapture: boolean;
}

export interface TacticalClaim {
  cell: string;
  manhattan: number;
  verdict: ReachVerdict;
  steps: number | null;
  witness: WitnessToken[] | null;
  pushes: number;
  endsInCapture: boolean;
  /** Why nothing was proved — and why that is NOT a claim of impossibility. */
  note: string | null;
}

export interface BtrStats {
  targets: number;
  permutationsPlayed: number;
  catMoveCalls: number;
  refusedAttempts: number;
  terminalCaptures: number;
  witnesses: number;
  sweepNodes: number;
  sweepFrontierNodes: number;
  sweepDuplicateStatesSkipped: number;
  sweepTerminalCaptures: number;
  sweepExhaustive: boolean;
  sweepReason: string | null;
}

export interface BtrOptions {
  /** Cat move actions available in the turn. Defaults to the config budget (4). */
  maxSteps?: number;
  /** Run the exhaustive local sweep — the only thing allowed to answer NO. */
  sweep?: boolean;
  /** Dedup the sweep by (cat, boxes, blocked tunnels, trap, mouse). Default true. */
  dedup?: boolean;
}

export interface BtrResult {
  claims: Map<string, TacticalClaim>;
  /** The sweep's complete answer set; empty when `sweep` was not asked for. */
  reachableWithinBudget: Map<string, Witness>;
  stats: BtrStats;
}

/**
 * Targets in, claims out. For each cell play its Manhattan-shortest permutations
 * through the engine; then — only if asked — run ONE exhaustive local sweep, which
 * answers every target at once, so a negative costs nothing extra per cell.
 */
export function boundedTacticalReach(
  view: GameEngineState,
  targets: string[],
  opts: BtrOptions = {},
): BtrResult {
  const maxSteps = opts.maxSteps ?? view.config.catBaseMoves;
  const dedup = opts.dedup ?? true;
  const stats: BtrStats = {
    targets: targets.length,
    permutationsPlayed: 0,
    catMoveCalls: 0,
    refusedAttempts: 0,
    terminalCaptures: 0,
    witnesses: 0,
    sweepNodes: 0,
    sweepFrontierNodes: 0,
    sweepDuplicateStatesSkipped: 0,
    sweepTerminalCaptures: 0,
    sweepExhaustive: false,
    sweepReason: null,
  };
  const claims = new Map<string, TacticalClaim>();
  const from = rc(view.catPosition);
  const mouse = rc(view.mousePosition);

  for (const cell of targets) {
    const dirs = shortestDirections(from, cell);
    const man = dirs.length;
    const base = { cell, manhattan: man, steps: null as number | null, witness: null as WitnessToken[] | null, pushes: 0, endsInCapture: false };
    if (man > maxSteps) {
      claims.set(cell, { ...base, verdict: 'UNKNOWN', note: `Manhattan ${man} exceeds the ${maxSteps}-action budget — this model does not look that far` });
      continue;
    }
    let won: Witness | null = null;
    let tried = 0;
    let refused = 0;
    let captured = 0;
    for (const perm of permutations(dirs)) {
      tried++;
      stats.permutationsPlayed++;
      stats.catMoveCalls += perm.length;
      const out = playLine(view, perm);
      if (out.refusedAt >= 0) refused++;
      if (out.captureAt >= 0) captured++;
      const landed = rc(out.end.catPosition) === cell;
      // A route that catches the mouse on the way is a WIN line, not a positioning
      // route — so it only counts when the target IS the mouse.
      const clean = out.refusedAt === -1 && (out.captureAt === -1 || (cell === mouse && landed));
      if (landed && clean) {
        won = { steps: perm.length, witness: perm.map((d) => TOKENS[d.key]), pushes: out.pushes, endsInCapture: out.captureAt >= 0 };
        break;
      }
    }
    stats.refusedAttempts += refused;
    stats.terminalCaptures += captured;
    if (won !== null) {
      stats.witnesses++;
      claims.set(cell, { ...base, steps: won.steps, witness: won.witness, pushes: won.pushes, endsInCapture: won.endsInCapture, verdict: 'REACHABLE_WITHIN_4', note: null });
    } else {
      const why = refused === tried ? 'every shortest permutation was refused by the engine' : 'no shortest permutation ended on the cell';
      claims.set(cell, { ...base, verdict: 'UNKNOWN', note: `${why}; shortest-permutation checking alone cannot prove impossibility` });
    }
  }

  let reachableWithinBudget = new Map<string, Witness>();
  if (opts.sweep) {
    const sweep = boundedTurnSweep(view, maxSteps, dedup);
    reachableWithinBudget = sweep.reachable;
    stats.catMoveCalls += sweep.catMoveCalls;
    stats.sweepNodes = sweep.nodesExpanded;
    stats.sweepFrontierNodes = sweep.frontierNodes;
    stats.sweepDuplicateStatesSkipped = sweep.duplicateStatesSkipped;
    stats.sweepTerminalCaptures = sweep.terminalCaptures;
    stats.sweepExhaustive = sweep.exhaustive;
    stats.sweepReason = sweep.reason;
    if (sweep.exhaustive) {
      // The only place a NO may come from: a locally exhaustive sweep with stated coverage.
      for (const [cell, claim] of claims) {
        if (claim.verdict === 'REACHABLE_WITHIN_4' || claim.manhattan > maxSteps) continue;
        const w = reachableWithinBudget.get(cell);
        if (w !== undefined) {
          claims.set(cell, { ...claim, steps: w.steps, witness: w.witness, pushes: w.pushes, endsInCapture: w.endsInCapture, verdict: 'REACHABLE_WITHIN_4', note: null });
          stats.witnesses++;
          continue;
        }
        claims.set(cell, {
          ...claim,
          verdict: 'UNREACHABLE_WITHIN_4',
          note: `exhaustive sweep of all legal move actions to depth ${maxSteps}: ${sweep.nodesExpanded} nodes, coverage complete`,
        });
      }
    }
  }
  return { claims, reachableWithinBudget, stats };
}

export interface SweepResult {
  /** cell -> the SHORTEST engine-accepted way to stand on it inside this turn. */
  reachable: Map<string, Witness>;
  catMoveCalls: number;
  nodesExpanded: number;
  frontierNodes: number;
  duplicateStatesSkipped: number;
  terminalCaptures: number;
  exhaustive: boolean;
  reason: string | null;
}

/**
 * Expand EVERY engine-legal move action at EVERY depth up to `maxSteps`. This is the
 * coverage proof a negative verdict needs, and it stays inside one cat turn: the
 * budget is set once, a capture ends its line, and only states the engine itself
 * produced are expanded. It is bounded by the TURN, not by the board — which is why it
 * is affordable where HV-8's per-push full-board fields were not.
 *
 * Dedup merges only states that agree on cat cell, box layout, blocked tunnels, trap,
 * traps left and mouse cell, so different box layouts are never folded together.
 */
export function boundedTurnSweep(
  view: GameEngineState,
  maxSteps: number,
  dedup = true,
  capNodes = Number.POSITIVE_INFINITY,
): SweepResult {
  const reachable = new Map<string, Witness>();
  const root = bankTurn(view);
  const seen = new Set<string>();
  const stamp = (s: GameEngineState): string =>
    `${rc(s.catPosition)}|${boxLayout(s)}|${s.blockedTunnels.map(rc).sort().join(' ')}|${s.trapPosition ? rc(s.trapPosition) : '-'}|${s.catTrapsRemaining}|${rc(s.mousePosition)}`;
  reachable.set(rc(root.catPosition), { steps: 0, witness: [], pushes: 0, endsInCapture: false });
  seen.add(stamp(root));
  let frontier: { state: GameEngineState; tokens: Direction[]; pushes: number }[] = [{ state: root, tokens: [], pushes: 0 }];
  let catMoveCalls = 0;
  let nodesExpanded = 0;
  let frontierNodes = 0;
  let duplicateStatesSkipped = 0;
  let terminalCaptures = 0;
  let exhaustive = true;
  let reason: string | null = null;
  for (let depth = 0; depth < maxSteps; depth++) {
    const next: { state: GameEngineState; tokens: Direction[]; pushes: number }[] = [];
    for (const node of frontier) {
      nodesExpanded++;
      const layoutBefore = boxLayout(node.state);
      for (const d of DIRECTIONS) {
        catMoveCalls++;
        const before = rc(node.state.catPosition);
        const after = catMove(node.state, d);
        const here = rc(after.catPosition);
        if (here === before) continue; // the engine refused: not a legal action, nothing to expand
        const tokens = [...node.tokens, d];
        const pushed = boxLayout(after) !== layoutBefore;
        const entry: Witness = {
          steps: tokens.length,
          witness: tokens.map((t) => TOKENS[t.key]),
          pushes: node.pushes + (pushed ? 1 : 0),
          endsInCapture: after.phase !== GamePhase.Playing,
        };
        if (!reachable.has(here)) reachable.set(here, entry);
        if (entry.endsInCapture) {
          terminalCaptures++;
          continue; // a capture ends the line; nothing continues past a terminal
        }
        if (dedup) {
          const k = stamp(after);
          if (seen.has(k)) {
            duplicateStatesSkipped++;
            continue;
          }
          seen.add(k);
        }
        next.push({ state: after, tokens, pushes: entry.pushes });
      }
    }
    frontierNodes += next.length;
    if (next.length > capNodes) {
      exhaustive = false;
      reason = `frontier ${next.length} exceeds the ${capNodes}-node cap at depth ${depth + 1}: states were left unexpanded, so absence there is UNKNOWN, not impossible`;
      frontier = [];
      break;
    }
    frontier = next;
  }
  return { reachable, catMoveCalls, nodesExpanded, frontierNodes, duplicateStatesSkipped, terminalCaptures, exhaustive, reason };
}
