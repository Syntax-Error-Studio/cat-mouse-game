/**
 * PPC-HV-8 forensics module — a push distance map whose every claim carries a
 * legal-action witness.
 *
 * THE ERROR BEING FIXED: production `ctx.catMap` is a walk-only BFS, so the 12
 * boxes read as walls and a cat that legally squeezes past a box is priced as
 * being 10 steps away instead of 4 (HV-7). HV-6's `buildCatPushDistanceMap`
 * fixes the distance and breaks the rules: it freezes the box layout, so a later
 * push may use a box an earlier push already moved (HV-7 B4/E3 both produced
 * fabricated arrivals). HV-7's complete prover is exact and costs 460-1517 ms per
 * leaf against a 150 ms turn budget.
 *
 * THIS MODULE IS THE THIRD ROUTE: walk, then AT MOST ONE push, then walk again on
 * the board that push actually produced. No state-space search, and no claim
 * without a replayed witness.
 *
 * RULE NON-DUPLICATION: the two distance fields come from the production kernels
 * (`buildCatDistanceMap`), the push itself comes from the engine's own `catMove`,
 * and every cell that is allowed into a scored or proved view is validated by
 * replaying its whole action sequence through `catMove`. Nothing here re-implements
 * movement legality; the engine is the referee, and a witness the engine refuses is
 * replaced by the next-shorter witness for that cell or dropped — never reported.
 * The only way to get an unreplayed record is to pass `verify: false`, which exists
 * for cost measurement and labels every one of its records `verification = 'skipped'`.
 *
 * CLAIM BOUNDARY — read this before using any number from here:
 *  - PATH LEGALITY: PROVEN. A reported route is a legal action sequence.
 *  - SHORTEST-PATH EXACTNESS: NOT claimed. `reportedSteps` is the length of a
 *    feasible route under a FIXED mouse position; a shorter route, or a route
 *    needing two pushes, may exist.
 *  - REAL-DUEL INTERCEPTABILITY: NOT claimed. The mouse does not stand still.
 *  - A cell ABSENT from the map is REACHABILITY = UNKNOWN, never unreachable. The
 *    map is a superset of the production walk field, so absence is exactly as
 *    informative (and no more) than production already is.
 *  - VERIFICATION STATUS IS PART OF THE CLAIM. `witnessVerified` means ONLY that
 *    `replayWitness` ran this sequence through `catMove` and the engine agreed step
 *    by step (HV-9 §四: an un-replayed route may not be labelled as verified, and a
 *    record that skipped the replay carries `verification = 'skipped'`). Every
 *    consumer that may feed a proof reads the verified subset, never `cells` raw.
 *
 * BUDGET CONVENTION: `catMovesLeft` is re-banked to `catBaseMoves` before every
 * replayed step, so a route may cross the four-step turn boundary. That makes the
 * number a POTENTIAL cat walking distance against a frozen opponent, which is what
 * a static distance feature measures, and it is NOT a proven two-player line.
 */
import { catMove, type GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../types';
import { buildCatDistanceMap, createEvaluationContext, evaluationCellKey } from '../evaluation';

export type WitnessToken = 'U' | 'D' | 'L' | 'R';

/**
 * HOW a record earned its `witnessVerified` flag.
 * `replayed` — `replayWitness` ran the sequence through `catMove`.
 * `skipped` — the caller passed `verify: false`; nothing was checked and the record
 * is a model hypothesis only. It may appear in a cost measurement, never in a proof.
 */
export type WitnessVerification = 'replayed' | 'skipped';

export interface WitnessRecord {
  target: string;
  reportedSteps: number;
  legalActionWitness: WitnessToken[];
  /** Engine-confirmed final layout. `''` when the replay was skipped. */
  finalBoxLayout: string;
  /** TRUE only for a witness the engine actually accepted, step by step. */
  witnessVerified: boolean;
  verification: WitnessVerification;
  /** Engine-counted pushes when verified; the model's estimate when verification was skipped. */
  pushes: number;
  endsInCapture: boolean;
  source: 'walk' | 'one-push';
  pushBase: string | null;
}

export interface WitnessStats {
  walkCells: number;
  boxFacesProbed: number;
  legalPushes: number;
  fieldsBuilt: number;
  pushesPruned: number;
  pushCandidatesBetter: number;
  /** Candidates whose replay the engine refused (each attempt counted). */
  fabricatedDropped: number;
  rejectedThroughCapture: number;
  walkCellsWithoutWitness: number;
  descendFailures: number;
  incomplete: boolean;
  incompleteReason: string | null;
  replayedSteps: number;
  /** How many candidate sequences were replayed — >= one per reported cell when verifying. */
  replayAttempts: number;
  /** Cells where the shortest candidate failed and a longer witness took its place. */
  fallbacksUsed: number;
  /** Times a cell's displaced-candidate chain was trimmed to its cap. */
  alternatesCapped: number;
  /** Records emitted WITHOUT a replay (`verify: false`), counted so no reader mistakes them for proof. */
  verificationSkipped: number;
}

export interface WitnessPushMap {
  view: GameEngineState;
  walkField: Map<string, number>;
  /**
   * Every candidate the model produced, verified or not. Read `verifiedCells` /
   * `witnessDistances` / `mergeWithProduction` for anything that may back a claim;
   * a `verify: false` run puts unverified hypotheses in here on purpose.
   */
  cells: Map<string, WitnessRecord>;
  stats: WitnessStats;
}

export interface ReplayResult {
  ok: boolean;
  reason: string | null;
  steps: number;
  finalCell: string;
  finalBoxLayout: string;
  pushes: number;
  endsInCapture: boolean;
  finalState: GameEngineState;
}

const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;

const TOKENS: Record<string, WitnessToken> = {
  ArrowUp: 'U',
  ArrowDown: 'D',
  ArrowLeft: 'L',
  ArrowRight: 'R',
};

/** The forensic turn-budget replenishment: a fresh four-step turn at every ply. */
export function bankTurn(s: GameEngineState): GameEngineState {
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    phase: s.phase === GamePhase.Playing ? GamePhase.Playing : s.phase,
    catMovesLeft: s.config.catBaseMoves,
  };
}

/** Box layout as a single comparable string — the witness's finalBoxLayout. */
export function boxLayout(state: GameEngineState): string {
  const out: string[] = [];
  for (let r = 0; r < state.config.boardSize; r++) {
    for (let c = 0; c < state.config.boardSize; c++) {
      if (state.board[r][c].type === CellType.Box) out.push(rc({ r, c }));
    }
  }
  return out.join(' ');
}

function tokenOf(dir: Direction): WitnessToken {
  return TOKENS[dir.key];
}

function cellOf(key: string): { r: number; c: number } {
  const [r, c] = key.split(',').map(Number);
  return { r, c };
}

/**
 * Reconstruct a route out of a BFS field by walking strictly down to zero. No rule
 * is re-checked here on purpose — the engine referee is the single replay below,
 * which costs one `catMove` per step instead of four probes per step.
 *
 * `avoid` is the mouse's cell: stepping onto it is a capture, so a route that passes
 * it is a terminal line, not a positioning route. A cell whose recorded shortest
 * route goes through the mouse therefore gets NO witness here (it stays UNKNOWN to
 * this model); it does not become unreachable.
 */
function descend(field: Map<string, number>, target: string, avoid: string | null): Direction[] | null {
  const dist = field.get(target);
  if (dist === undefined) return null;
  if (dist === 0) return [];
  const banned = target === avoid ? null : avoid;
  const picked: Direction[] = [];
  let cur = target;
  for (let step = dist; step > 0; step--) {
    const here = cellOf(cur);
    let found: Direction | null = null;
    for (const d of DIRECTIONS) {
      const prev = rc({ r: here.r - d.dr, c: here.c - d.dc });
      if (prev === banned) continue;
      if (field.get(prev) === step - 1) {
        found = d;
        cur = prev;
        break;
      }
    }
    if (found === null) return null;
    picked.push(found);
  }
  return picked.reverse();
}

/**
 * The referee: replay a direction sequence with the real `catMove` and report what
 * the engine actually did — landing cells, box-layout changes (a change IS a push),
 * and a capture. A step the engine refuses shows up as an unchanged position.
 */
export function replayWitness(view: GameEngineState, tokens: Direction[]): ReplayResult {
  let s = view;
  let pushes = 0;
  let illegalAt = -1;
  let captureAt = -1;
  for (let i = 0; i < tokens.length; i++) {
    const at = bankTurn(s);
    const before = rc(at.catPosition);
    const moved = catMove(at, tokens[i]);
    const after = rc(moved.catPosition);
    if (after === before) {
      illegalAt = i;
      s = moved;
      break;
    }
    if (boxLayout(moved) !== boxLayout(at)) pushes++;
    if (moved.phase !== GamePhase.Playing) captureAt = i;
    s = moved;
  }
  const finalCell = rc(s.catPosition);
  const endsInCapture = captureAt === tokens.length - 1 && s.phase !== GamePhase.Playing;
  let reason: string | null = null;
  if (captureAt >= 0 && captureAt < tokens.length - 1)
    reason = `step ${captureAt + 1} already captures the mouse; a route may not continue past a terminal`;
  else if (illegalAt >= 0) reason = `step ${illegalAt + 1} is not a legal cat action`;
  return {
    ok: reason === null,
    reason,
    steps: tokens.length,
    finalCell,
    finalBoxLayout: boxLayout(s),
    pushes,
    endsInCapture,
    finalState: s,
  };
}

/** A push the engine itself confirms, plus the board it produced. */
interface PushMove {
  from: string; // the cell the cat must stand on
  box: string; // the box being pushed (the cell the cat lands on)
  to: string; // the new box position
  dir: Direction;
  after: GameEngineState; // the engine's own post-push state
  prefixSteps: number; // walk distance to `from`
}

/**
 * Enumerate the legal single pushes reachable with zero further pushes. Legality is
 * asked of the engine, never computed here: the probe steps onto the box and the
 * answer is a push only if the box layout changed and the game is still playing.
 */
function reachablePushes(
  view: GameEngineState,
  walk: Map<string, number>,
  probeCounter?: { n: number },
): PushMove[] {
  const out: PushMove[] = [];
  const size = view.config.boardSize;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (view.board[r][c].type !== CellType.Box) continue;
      for (const d of DIRECTIONS) {
        const from = rc({ r: r - d.dr, c: c - d.dc });
        const base = walk.get(from);
        if (base === undefined) continue; // the cat cannot get behind that box by walking
        if (from === rc(view.mousePosition)) continue; // standing there is already a capture
        if (probeCounter) probeCounter.n++;
        const probe = catMove(bankTurn({ ...view, catPosition: cellOf(from) }), d);
        if (rc(probe.catPosition) !== rc({ r, c })) continue; // not a push (illegal, or a walk)
        if (boxLayout(probe) === boxLayout(view)) continue; // the box did not move
        if (probe.phase !== GamePhase.Playing) continue; // the push captures: terminal, no field after it
        out.push({
          from,
          box: rc({ r, c }),
          to: rc({ r: r + 2 * d.dr, c: c + 2 * d.dc }),
          dir: d,
          after: probe,
          prefixSteps: base,
        });
      }
    }
  }
  return out;
}

function manhattan(a: string, b: string): number {
  const p = cellOf(a);
  const q = cellOf(b);
  return Math.abs(p.r - q.r) + Math.abs(p.c - q.c);
}

export interface WitnessPushOptions {
  /** Only these cells get a materialized witness; distances to all others stay UNKNOWN. */
  targets?: string[];
  /** Hard cap on post-push distance fields. Exceeding it marks the result incomplete. */
  maxFields?: number;
  /** Attach the production walk cells to the output too (they get witnesses as well). */
  includeWalk?: boolean;
  /**
   * Replay every witness through `catMove` before reporting it. Default true.
   * `false` exists ONLY for cost measurement: it labels each record
   * `verification = 'skipped'` and therefore removes it from every proved view —
   * `mergeWithProduction`, `witnessDistances` and the scored field all become the
   * plain production walk field, because an un-replayed route proves nothing.
   */
  verify?: boolean;
}

interface Candidate {
  steps: number;
  tokens: Direction[];
  source: 'walk' | 'one-push';
  pushBase: string | null;
}

/** How many displaced candidates a cell keeps as fallback witnesses. */
const MAX_ALTERNATES = 4;

/**
 * Remember a candidate that just got beaten by a shorter one, so that if the shorter
 * one turns out to be unplayable the engine-signed longer route is still there (HV-9
 * §四-3: a failed shorter candidate may not silently destroy a valid longer witness).
 */
function displace(
  alternates: Map<string, Candidate[]>,
  cell: string,
  prev: Candidate,
  stats: WitnessStats,
): void {
  const list = alternates.get(cell) ?? [];
  list.push(prev);
  list.sort((a, b) => a.steps - b.steps);
  if (list.length > MAX_ALTERNATES) {
    list.length = MAX_ALTERNATES;
    stats.alternatesCapped++;
  }
  alternates.set(cell, list);
}

/**
 * walk → one legal push → walk again on the board that push produced.
 *
 * Verification order matters and is deliberate: candidates are collected first (with
 * the beaten ones kept as a per-cell fallback chain), then each cell is replayed
 * shortest-first until the engine signs one. A cell whose every candidate is refused
 * is dropped and counted; it is UNKNOWN to this model, not unreachable. With
 * `verify: false` nothing is replayed and every record is labelled
 * `verification = 'skipped'`, `witnessVerified = false`.
 */
export function buildWitnessPushMap(
  view: GameEngineState,
  opts: WitnessPushOptions = {},
): WitnessPushMap {
  const verify = opts.verify ?? true;
  const includeWalk = opts.includeWalk ?? true;
  const maxFields = opts.maxFields ?? Number.POSITIVE_INFINITY;
  const stats: WitnessStats = {
    walkCells: 0,
    boxFacesProbed: 0,
    legalPushes: 0,
    fieldsBuilt: 0,
    pushesPruned: 0,
    pushCandidatesBetter: 0,
    fabricatedDropped: 0,
    rejectedThroughCapture: 0,
    walkCellsWithoutWitness: 0,
    descendFailures: 0,
    incomplete: false,
    incompleteReason: null,
    replayedSteps: 0,
    replayAttempts: 0,
    fallbacksUsed: 0,
    alternatesCapped: 0,
    verificationSkipped: 0,
  };
  const walk = buildCatDistanceMap(bankTurn(view));
  stats.walkCells = walk.size;
  const mouse = rc(view.mousePosition);

  // best[cell] = the shortest candidate route found so far (verified later, in order).
  const best = new Map<string, Candidate>();
  // Every candidate that `best` beat, shortest first — the fallback chain.
  const alternates = new Map<string, Candidate[]>();
  const wanted = opts.targets ? new Set(opts.targets) : null;

  const seedCells = wanted ? [...wanted] : [...walk.keys()];
  if (includeWalk) for (const cell of seedCells) {
    const steps = walk.get(cell);
    if (steps === undefined) continue;
    const tokens = descend(walk, cell, mouse);
    if (tokens === null) {
      if (wanted === null) stats.walkCellsWithoutWitness++;
      stats.descendFailures++;
      continue;
    }
    best.set(cell, { steps, tokens, source: 'walk', pushBase: null });
  }

  const probes = { n: 0 };
  const pushes = reachablePushes(view, walk, probes);
  stats.legalPushes = pushes.length;
  stats.boxFacesProbed = probes.n;

  for (const p of pushes) {
    // Admissible pruning: walking distance is never below the Manhattan distance,
    // so a push that cannot beat every current best is not worth a distance field.
    if (wanted) {
      let hopeless = true;
      for (const t of wanted) {
        const cur = best.get(t)?.steps ?? walk.get(t);
        const lb = p.prefixSteps + 1 + manhattan(p.box, t);
        if (cur === undefined || lb < cur) {
          hopeless = false;
          break;
        }
      }
      if (hopeless) {
        stats.pushesPruned++;
        continue;
      }
    }
    if (stats.fieldsBuilt >= maxFields) {
      stats.incomplete = true;
      stats.incompleteReason = `maxFields=${maxFields} reached with ${pushes.length - stats.fieldsBuilt} pushes unexamined`;
      break;
    }
    const field = buildCatDistanceMap(bankTurn(p.after));
    stats.fieldsBuilt++;
    const head = descend(walk, p.from, mouse);
    if (head === null) {
      stats.descendFailures++;
      continue; // no witness for the prefix to this push position
    }
    for (const [cell, d] of field) {
      if (wanted && !wanted.has(cell)) continue;
      const steps = p.prefixSteps + 1 + d;
      const prev = best.get(cell);
      if (prev !== undefined && prev.steps <= steps) continue;
      const tail = descend(field, cell, mouse);
      if (tail === null) {
        stats.descendFailures++;
        continue;
      }
      stats.pushCandidatesBetter++;
      if (prev !== undefined) displace(alternates, cell, prev, stats);
      best.set(cell, {
        steps,
        tokens: [...head, p.dir, ...tail],
        source: 'one-push',
        pushBase: `${p.from}>${p.box}>${p.to}`,
      });
    }
  }

  const cells = new Map<string, WitnessRecord>();
  for (const [cell, cand] of best) {
    // Try the candidates for this cell shortest-first. A refused shorter route hands
    // the cell to the next-longer one instead of erasing it (HV-9 §四-3).
    const chain = [cand, ...(alternates.get(cell) ?? [])];
    let winner: Candidate | null = null;
    let replay: ReplayResult | null = null;
    for (let i = 0; verify && i < chain.length; i++) {
      const c = chain[i];
      const r = replayWitness(view, c.tokens);
      stats.replayAttempts++;
      stats.replayedSteps += r.steps;
      const matches = r.ok && r.finalCell === cell && r.steps === c.steps;
      // A claimed one-push route the engine replayed as zero or two pushes is a model
      // bug, not a finding: the walk arm can only be 0 pushes and the push arm 1.
      const pushMismatch = c.source === 'one-push' ? r.pushes !== 1 : r.pushes !== 0;
      if (matches && !pushMismatch) {
        winner = c;
        replay = r;
        if (i > 0) stats.fallbacksUsed++;
        break;
      }
      if (r.reason !== null && r.reason.includes('captures the mouse')) stats.rejectedThroughCapture++;
      else stats.fabricatedDropped++;
    }
    if (!verify) {
      // Nothing was replayed, so nothing is verified — the record is kept ONLY so the
      // cost of the model can be measured, and it is labelled as such.
      stats.verificationSkipped++;
      cells.set(cell, {
        target: cell,
        reportedSteps: cand.steps,
        legalActionWitness: cand.tokens.map(tokenOf),
        finalBoxLayout: '',
        witnessVerified: false,
        verification: 'skipped',
        pushes: cand.source === 'one-push' ? 1 : 0,
        endsInCapture: false,
        source: cand.source,
        pushBase: cand.pushBase,
      });
      continue;
    }
    if (winner === null || replay === null) {
      continue; // every candidate for this cell failed: the cell stays UNKNOWN to this model
    }
    cells.set(cell, {
      target: cell,
      reportedSteps: winner.steps,
      legalActionWitness: winner.tokens.map(tokenOf),
      finalBoxLayout: replay.finalBoxLayout,
      witnessVerified: true,
      verification: 'replayed',
      pushes: replay.pushes,
      endsInCapture: replay.endsInCapture,
      source: winner.source,
      pushBase: winner.pushBase,
    });
  }

  return { view, walkField: walk, cells, stats };
}

/** The claims that may back a conclusion: only routes the engine actually replayed. */
export function verifiedCells(w: WitnessPushMap): Map<string, WitnessRecord> {
  const out = new Map<string, WitnessRecord>();
  for (const [cell, rec] of w.cells) if (rec.witnessVerified) out.set(cell, rec);
  return out;
}

/** The distance field a counterfactual evaluator would read: REPLAYED witnesses only. */
export function witnessDistances(w: WitnessPushMap): Map<string, number> {
  const out = new Map<string, number>();
  for (const [cell, rec] of w.cells) if (rec.witnessVerified) out.set(cell, rec.reportedSteps);
  return out;
}

/**
 * Where a distance in the scored field came from (HV-9 §四-5): a route the engine
 * replayed, or the production walk map the merge inherited without touching.
 */
export type ArrivalOrigin = 'witnessed' | 'production';

export interface ArrivalClaim {
  steps: number;
  /** Which number this is: a route the engine replayed, or the production walk map. */
  origin: ArrivalOrigin;
  /** The shortest replayed witness for the cell, if the model has one at any length. */
  witness: WitnessRecord | null;
}

/**
 * The three-state answer §四-4 demands: `witnessed` (the engine replayed a route that
 * is at least as good as production's), `production` (only the walk map claims the
 * cell — the merge inherited that number untouched), or `null` = UNKNOWN. UNKNOWN
 * means this model has no evidence, NOT that the cat cannot get there.
 */
export function classifyArrival(w: WitnessPushMap, cell: string): ArrivalClaim | null {
  const rec = w.cells.get(cell);
  const witness = rec !== undefined && rec.witnessVerified ? rec : null;
  const walk = w.walkField.get(cell);
  if (witness !== null && (walk === undefined || witness.reportedSteps < walk)) {
    return { steps: witness.reportedSteps, origin: 'witnessed', witness };
  }
  if (walk !== undefined) return { steps: walk, origin: 'production', witness };
  return null;
}

/**
 * The same field as `mergeWithProduction`, but every entry says whether it is an
 * engine-replayed witness or an inherited production number.
 */
export function mergeWithProvenance(w: WitnessPushMap): Map<string, ArrivalClaim> {
  const out = new Map<string, ArrivalClaim>();
  const cells = new Set<string>(w.walkField.keys());
  for (const cell of w.cells.keys()) cells.add(cell);
  for (const cell of cells) {
    const claim = classifyArrival(w, cell);
    if (claim !== null) out.set(cell, claim);
  }
  return out;
}

/**
 * The field used for scoring: the production walk map plus every WITNESSED route
 * that is strictly shorter, and nothing removed.
 *
 * Why the union and not the model alone: a cell missing from the model is UNKNOWN,
 * and treating UNKNOWN as unreachable would subtract reachability the production map
 * already (less reliably) claims — that would let the arm score better or worse for
 * reasons unrelated to the push fix. The production route through a capture is left
 * exactly as production reports it and counted separately as `walkCellsWithoutWitness`;
 * HV-8 neither repairs it nor pretends it is gone.
 *
 * The consequence worth stating: this field is never larger than production's
 * distances and never smaller than the true legal distance, so a cell can only move
 * closer to the cat, never farther.
 *
 * Only REPLAYED witnesses shorten it. With `verify: false` the merge is the plain
 * production walk field, because nothing was checked — which is also why switching
 * the replay off is not a saving, it is a different (unusable) object. Use
 * `mergeWithProvenance` to tell an inherited production distance apart from a
 * witnessed one.
 */
export function mergeWithProduction(w: WitnessPushMap): Map<string, number> {
  const out = new Map<string, number>();
  for (const [cell, claim] of mergeWithProvenance(w)) out.set(cell, claim.steps);
  return out;
}

/**
 * The production context with the cat-side arrival field swapped and the Voronoi
 * scan re-run over it. Everything else, including every contribution formula, is
 * production code: `evaluateForCatDetailed(state, weights, ctx)` reads these fields
 * and nothing else on the cat side changes.
 */
export function buildSubstitutedContext(
  state: GameEngineState,
  catField: Map<string, number>,
): ReturnType<typeof createEvaluationContext> {
  const ctx = createEvaluationContext(state);
  const voronoi = { catControlled: 0, mouseControlled: 0, contested: 0, strategicArea: 0 };
  const hole = state.config.mouseHole;
  for (let r = 0; r < state.config.boardSize; r++) {
    for (let c = 0; c < state.config.boardSize; c++) {
      const t = state.board[r][c].type;
      if (t === CellType.Tunnel || t === CellType.Box || t === CellType.Pile || t === CellType.Wall || t === CellType.Void) continue;
      if (r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size) continue;
      const k = evaluationCellKey({ r, c });
      const cd = catField.get(k);
      const md = ctx.mouseMap.get(k);
      if (cd === undefined && md === undefined) continue;
      voronoi.strategicArea++;
      if (cd !== undefined && md === undefined) voronoi.catControlled++;
      else if (md !== undefined && cd === undefined) voronoi.mouseControlled++;
      else if (cd !== undefined && md !== undefined) {
        if (cd < md) voronoi.catControlled++;
        else if (md < cd) voronoi.mouseControlled++;
        else voronoi.contested++;
      }
    }
  }
  return { ...ctx, catMap: catField, voronoi };
}

export interface TwoPushEntry {
  steps: number;
  witness: WitnessToken[];
  pushes: number;
}

export interface TwoPushRefused extends TwoPushEntry {
  reason: string | null;
}

export interface TwoPushResult {
  /**
   * target -> route using at most two pushes. EVERY entry here is a route the engine
   * replayed (`verified` is true by construction); a candidate the engine refused goes
   * to `refused` instead, where it cannot be mistaken for a proof, and it never
   * displaces a shorter route that did replay (HV-9 §四-2/3).
   */
  found: Map<string, TwoPushEntry & { verified: true }>;
  /** target -> candidates whose replay the engine refused, kept for the audit trail. */
  refused: Map<string, TwoPushRefused[]>;
  fieldsBuilt: number;
  incomplete: boolean;
  reason: string | null;
}

/**
 * OFFLINE ONLY — the question "is one push enough to restore the defensive route?"
 * asks whether a second push exists at all, so this walks two push levels deep for a
 * HANDFUL of targets. It is deliberately not shaped like something a leaf evaluator
 * could call: the field count is quadratic in the number of reachable pushes.
 */
export function twoPushWitness(
  view: GameEngineState,
  targets: string[],
  maxFields: number,
): TwoPushResult {
  const found = new Map<string, TwoPushEntry & { verified: true }>();
  const refused = new Map<string, TwoPushRefused[]>();
  const refuse = (t: string, tokens: Direction[], replay: ReplayResult): void => {
    const list = refused.get(t) ?? [];
    list.push({ steps: tokens.length, witness: tokens.map(tokenOf), reason: replay.reason, pushes: replay.pushes });
    refused.set(t, list);
  };
  const record = (t: string, tokens: Direction[], pushes: number): void => {
    const replay = replayWitness(view, tokens);
    if (!(replay.ok && replay.finalCell === t && replay.steps === tokens.length && replay.pushes === pushes)) {
      refuse(t, tokens, replay);
      return; // keep whatever verified route this cell already had
    }
    const cur = found.get(t);
    if (cur !== undefined && cur.steps <= replay.steps) return;
    found.set(t, { steps: replay.steps, witness: tokens.map(tokenOf), pushes: replay.pushes, verified: true });
  };
  const walk = buildCatDistanceMap(bankTurn(view));
  const mouse = rc(view.mousePosition);
  let secondLevel = 0;
  for (const t of targets) {
    const d = walk.get(t);
    if (d === undefined) continue;
    const tokens = descend(walk, t, mouse);
    if (tokens === null) continue;
    record(t, tokens, 0);
  }
  const first = reachablePushes(view, walk);
  let fields = 0;
  let incomplete = false;
  for (const p1 of first) {
    const field1 = buildCatDistanceMap(bankTurn(p1.after));
    fields++;
    const head = descend(walk, p1.from, mouse);
    if (head === null) continue;
    const second = reachablePushes(p1.after, field1);
    secondLevel += second.length;
    for (const p2 of second) {
      if (fields >= maxFields) {
        incomplete = true;
        break;
      }
      const base2 = field1.get(p2.from);
      if (base2 === undefined) continue;
      const mid = descend(field1, p2.from, mouse);
      if (mid === null) continue;
      const field2 = buildCatDistanceMap(bankTurn(p2.after));
      fields++;
      for (const t of targets) {
        const d = field2.get(t);
        if (d === undefined) continue;
        const steps = p1.prefixSteps + 1 + base2 + 1 + d;
        const cur = found.get(t);
        if (cur !== undefined && cur.steps <= steps) continue;
        const tail = descend(field2, t, mouse);
        if (tail === null) continue;
        record(t, [...head, p1.dir, ...mid, p2.dir, ...tail], 2);
      }
    }
    if (incomplete) break;
  }
  return {
    found,
    refused,
    fieldsBuilt: fields,
    incomplete,
    reason: incomplete ? `maxFields=${maxFields} (${secondLevel} second-level pushes discovered)` : null,
  };
}
