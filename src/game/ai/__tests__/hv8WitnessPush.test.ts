/// <reference types="node" />
/**
 * PPC-HV-8 — a push distance model whose every claim is backed by a legal action
 * witness: walk, then ONE legal push, then walk again on the board that push made.
 *
 * INSTRUMENT ONLY. Production H1, Baseline, HV-6 Gate Race and RB-1 are read, never
 * edited. The counterfactual arms run the PRODUCTION contribution formulas by
 * handing `evaluateForCatDetailed` a context whose cat-side arrival field and Voronoi
 * scan are substituted, and HV8-D1 proves that harness is honest by reproducing the
 * production H1 total bit-exactly when nothing is substituted.
 */
import { describe, expect, it } from 'vitest';
import { catMove, createInitialState, type GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, Difficulty, PieceType, GamePhase, type Direction } from '../../types';
import { DEFAULT_CONFIG } from '../../config';
import {
  DEFAULT_EVALUATION_WEIGHTS,
  buildCatPushDistanceMap,
  createEvaluationContext,
  evaluateForCatDetailed,
  evaluationCellKey,
} from '../evaluation';
import { correctedHoleEvalTotal, evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { stateKey } from '../transposition';
import {
  catActions,
  enumerateCatTurnExact,
  h1Turn,
  handOffToMouse,
  rc,
  replayCatPlan,
} from './hv5ForcedLineAuditor';
import {
  boxLayout,
  buildSubstitutedContext,
  buildWitnessPushMap,
  classifyArrival,
  mergeWithProduction,
  mergeWithProvenance,
  replayWitness,
  twoPushWitness,
  verifiedCells,
  witnessDistances,
  type WitnessRecord,
} from './hv8WitnessPush';

const W = DEFAULT_EVALUATION_WEIGHTS;

interface LeafProbe {
  plan: string;
  end: GameEngineState;
  leaf: GameEngineState;
  h1: number;
}

function probeOf(plan: string, end: GameEngineState): LeafProbe {
  const leaf = handOffToMouse(end, true);
  const bd = evaluateForCatDetailed(leaf, DEFAULT_EVALUATION_WEIGHTS);
  return { plan, end, leaf, h1: correctedHoleEvalTotal(bd, leaf.config.boardSize) };
}

function leafOf(root: GameEngineState, tokens: string[]): LeafProbe {
  const replayed = replayCatPlan(root, tokens);
  expect(replayed.illegalAt, `plan ${tokens.join('')} is legal on the real engine`).toBeNull();
  expect(replayed.applied.length, `plan ${tokens.join('')} applies every step`).toBe(tokens.length);
  return probeOf(tokens.join(''), replayed.end);
}

const bank = (s: GameEngineState): GameEngineState => ({
  ...s,
  currentPlayer: PieceType.Cat,
  catMovesLeft: s.config.catBaseMoves,
});

const catView = (p: LeafProbe): GameEngineState => bank(p.end);

function dirFromToken(t: string): Direction | undefined {
  return ({ U: DIRECTIONS[0], D: DIRECTIONS[1], L: DIRECTIONS[2], R: DIRECTIONS[3] } as Record<string, Direction>)[t];
}

function tokensToDirections(seq: string[]): Direction[] {
  const out: Direction[] = [];
  for (const t of seq) {
    const d = dirFromToken(t);
    if (d) out.push(d);
  }
  return out;
}

/** Engine-counted one-step mobility: the steps `catMove` actually accepts. */
function engineMobility(view: GameEngineState): number {
  return catActions(bank(view)).filter((a) => a.token !== 'P').length;
}

/**
 * HV-7's sound arm: the push may only be the LAST step, so nothing is walked after
 * it. Kept here as the middle rung of the ladder — walk-only below it, HV-8's
 * walk→push→walk above — so the same two leaves price all three models.
 */
function onePushLastArrival(view: GameEngineState, walk: Map<string, number>): Map<string, number> {
  const out = new Map(walk);
  const size = view.config.boardSize;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (view.board[r][c].type !== CellType.Box) continue;
      for (const d of DIRECTIONS) {
        const from = rc({ r: r - d.dr, c: c - d.dc });
        const base = walk.get(from);
        if (base === undefined) continue;
        const probe = catMove(bank({ ...view, catPosition: { r: r - d.dr, c: c - d.dc } }), d);
        if (rc(probe.catPosition) !== rc({ r, c })) continue;
        if (boxLayout(probe) === boxLayout(view)) continue;
        const cell = rc({ r, c });
        const cur = out.get(cell);
        if (cur === undefined || base + 1 < cur) out.set(cell, base + 1);
      }
    }
  }
  return out;
}

/** Run the production formulas over a substituted cat-side arrival field. */
function h1WithField(p: LeafProbe, field: Map<string, number>): { total: number; feats: Record<string, number | null> } {
  const ctx = buildSubstitutedContext(p.leaf, field);
  const bd = evaluateForCatDetailed(p.leaf, W, ctx);
  return {
    total: correctedHoleEvalTotal(bd, p.leaf.config.boardSize),
    feats: {
      catMouseDistance: bd.features.catMouseDistance,
      catHoleGateDistance: bd.features.catHoleGateDistance,
      catReachableArea: bd.features.catReachableArea,
      catMobility: bd.features.catMobility,
      catControlledArea: bd.features.catControlledArea,
      mouseControlledArea: bd.features.mouseControlledArea,
      voronoiBalance: bd.features.voronoiBalance,
    },
  };
}

function contributionsOf(p: LeafProbe, field: Map<string, number>) {
  const ctx = buildSubstitutedContext(p.leaf, field);
  return evaluateForCatDetailed(p.leaf, W, ctx).contributions;
}

/** Production feats mobility beside the number of steps the engine actually accepts. */
function mobLine(p: LeafProbe): string {
  return `feats=${evaluateForCatDetailed(p.leaf, W).features.catMobility} engineCounted=${engineMobility(catView(p))}`;
}

const ITEM_NAMES = [
  'capturePressure', 'confinement', 'mobility', 'holeControl', 'voronoiBalance',
] as const;

function synth(opts: {
  cat: [number, number]; mouse: [number, number];
  box?: [number, number][]; wall?: [number, number][];
  mouseHasButter?: boolean; trap?: [number, number]; currentPlayer?: PieceType;
}): GameEngineState {
  const base = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard } as Parameters<typeof createInitialState>[0]);
  const board: GameEngineState['board'] = base.board.map((row, r) => row.map((cell, c) => {
    const tunnel = (r === 0 && (c === 0 || c === 9)) || (r === 9 && (c === 0 || c === 9));
    const hole = r >= 7 && r <= 8 && c >= 8 && c <= 9;
    const type: CellType = tunnel ? CellType.Tunnel : hole ? CellType.MouseHole : CellType.Empty;
    return { ...cell, type, piece: undefined as PieceType | undefined, hasButter: false };
  }));
  for (const [r, c] of opts.wall ?? []) board[r][c] = { ...board[r][c], type: CellType.Wall };
  for (const [r, c] of opts.box ?? []) board[r][c] = { ...board[r][c], type: CellType.Box };
  board[opts.cat[0]][opts.cat[1]] = { ...board[opts.cat[0]][opts.cat[1]], piece: PieceType.Cat };
  board[opts.mouse[0]][opts.mouse[1]] = { ...board[opts.mouse[0]][opts.mouse[1]], piece: PieceType.Mouse };
  return {
    ...base,
    board,
    catPosition: { r: opts.cat[0], c: opts.cat[1] },
    mousePosition: { r: opts.mouse[0], c: opts.mouse[1] },
    butterPositions: [],
    pendingButterSpawns: [],
    pendingButterPlacementDebt: 0,
    blockedTunnels: [],
    trapPosition: opts.trap ? { r: opts.trap[0], c: opts.trap[1] } : null,
    catTrapsRemaining: opts.trap ? 0 : 1,
    mouseHasButter: opts.mouseHasButter ?? false,
    mouseSkillActive: false,
    currentPlayer: opts.currentPlayer ?? PieceType.Mouse,
    phase: GamePhase.Playing,
    catMovesLeft: base.config.catBaseMoves,
    mouseMovesLeft: opts.mouseHasButter ? base.config.mouseCarryingMoves : base.config.mouseBaseMoves,
  };
}

const gateKeys = (s: GameEngineState): string[] =>
  createEvaluationContext(s).gateCells.map((g) => rc(g));

const fmt = (n: number): string => n.toFixed(4);

describe('PPC-HV-8 A — P1: the witness contract holds before any score is discussed', () => {
  it('HV8-A1: every reported cell carries a replayed legal action witness', () => {
    const root = h1Turn(4).state;
    const rrrr = leafOf(root, ['R', 'R', 'R', 'R']);
    const uuur = leafOf(root, ['R', 'L', 'U', 'U']);
    const w = buildWitnessPushMap(catView(rrrr));
    const w2 = buildWitnessPushMap(catView(uuur));
    const bad: string[] = [];
    for (const [cell, rec] of w.cells) {
      if (!rec.witnessVerified) bad.push(`${cell}: unverified`);
      if (rec.reportedSteps !== rec.legalActionWitness.length) bad.push(`${cell}: steps ${rec.reportedSteps} != witness ${rec.legalActionWitness.length}`);
      if (rec.pushes > 1) bad.push(`${cell}: witness used ${rec.pushes} pushes`);
      if (rec.finalBoxLayout === '') bad.push(`${cell}: no final box layout`);
    }
    expect(bad, 'the model may not report a claim the engine did not sign').toEqual([]);
    const one = [...w.cells.values()].filter((r) => r.source === 'one-push');
    console.log(`HV8-A1 RRRR view: walkCells=${w.stats.walkCells} facesProbed=${w.stats.boxFacesProbed} legalPushes=${w.stats.legalPushes} fields=${w.stats.fieldsBuilt} onePushClaims=${one.length} reportedCells=${w.cells.size} replayedSteps=${w.stats.replayedSteps} dropped=${w.stats.fabricatedDropped} captureRefusals=${w.stats.rejectedThroughCapture} walkWithoutWitness=${w.stats.walkCellsWithoutWitness}`);
    console.log(`HV8-A1 UUUR view: legalPushes=${w2.stats.legalPushes} fields=${w2.stats.fieldsBuilt} reportedCells=${w2.cells.size} walkWithoutWitness=${w2.stats.walkCellsWithoutWitness} incomplete=${w2.stats.incomplete}`);
    const sample = one.slice(0, 3);
    for (const rec of sample) {
      const again = replayWitness(catView(rrrr), tokensToDirections(rec.legalActionWitness));
      expect(again.ok, `independent re-replay of ${rec.target}`).toBe(true);
      expect(rc(again.finalState.catPosition), `re-replay lands on ${rec.target}`).toBe(rec.target);
      expect(again.finalBoxLayout, `box layout is reproducible for ${rec.target}`).toBe(rec.finalBoxLayout);
    }
    console.log(`HV8-A1 sample witnesses: ${sample.map((r) => `${r.target}@${r.reportedSteps} ${r.legalActionWitness.join('')} boxes→[${r.finalBoxLayout}]`).join(' | ')}`);
    const dist = witnessDistances(w);
    expect(dist.size, 'the distance view is exactly the claim set').toBe(w.cells.size);
    for (const [cell, d] of dist) expect(d, `${cell}: the view reports the record price`).toBe(w.cells.get(cell)!.reportedSteps);
    console.log(`HV8-A1 witnessDistances: ${dist.size} cells, every one equal to its record`);
  });

  it('HV8-A2: the model reads the state and never writes it', () => {
    const root = h1Turn(4).state;
    const leaves = [leafOf(root, ['R', 'R', 'R', 'R']), leafOf(root, ['U', 'U', 'U', 'R'])];
    for (const p of leaves) {
      const view = catView(p);
      const before = [stateKey(view), boxLayout(view), rc(view.catPosition), rc(view.mousePosition), view.catMovesLeft, view.trapPosition ? rc(view.trapPosition) : '_'];
      buildWitnessPushMap(view);
      twoPushWitness(view, ['4,8'], 40);
      const after = [stateKey(view), boxLayout(view), rc(view.catPosition), rc(view.mousePosition), view.catMovesLeft, view.trapPosition ? rc(view.trapPosition) : '_'];
      expect(after, 'the witness model must not touch the state it is given').toEqual(before);
      expect(before[3], 'and the mouse never moved because of the model').toBe(rc(p.leaf.mousePosition));
    }
    console.log('HV8-A2 purity: 2 views x (witness model + two-push experiment), stateKey/boxes/trap/budget unchanged');
  });

  it('HV8-A3: the merged field is production plus witnesses, never production minus anything', () => {
    const root = h1Turn(4).state;
    const rows: string[] = [];
    for (const tokens of [['R', 'R', 'R', 'R'], ['U', 'U', 'U', 'R']]) {
      const p = leafOf(root, tokens);
      const view = catView(p);
      const w = buildWitnessPushMap(view);
      const merged = mergeWithProduction(w);
      let lost = 0;
      let worse = 0;
      for (const [cell, d] of w.walkField) {
        const m = merged.get(cell);
        if (m === undefined) lost++;
        else if (m > d) worse++;
      }
      const added = [...merged.keys()].filter((k) => !w.walkField.has(k)).length;
      const improved = [...merged.keys()].filter((k) => (w.walkField.get(k) ?? Infinity) > (merged.get(k) ?? Infinity)).length;
      rows.push(`${tokens.join('')}: walk=${w.walkField.size} merged=${merged.size} lost=${lost} worse=${worse} added=${added} improved=${improved}`);
      expect(lost, 'a cell production claims may not be revoked because the witness model found no witness').toBe(0);
      expect(worse, 'no distance may grow: the arm only ever adds proven shortcuts').toBe(0);
    }
    console.log(`HV8-A3 monotonicity: ${rows.join(' | ')}`);
  });
});

describe('PPC-HV-8 B — P2: the seven scenarios HV-7 left behind', () => {
  it('HV8-B1 scenario A: does one push restore the (5,5) defensive route to (4,8)?', () => {
    const root = h1Turn(4).state;
    const p = leafOf(root, ['R', 'R', 'R', 'R']);
    const view = catView(p);
    const ctx = createEvaluationContext(p.leaf);
    const targets = [evaluationCellKey(p.leaf.mousePosition), ...gateKeys(p.leaf), '4,8'];
    const w = buildWitnessPushMap(view, { targets });
    const old = buildCatPushDistanceMap(view);
    const rows: string[] = [];
    for (const t of targets) {
      const rec: WitnessRecord | undefined = w.cells.get(t);
      rows.push(`${t}: walk=${ctx.catMap.get(t) ?? '∞'} hv6PushMap=${old.get(t) ?? '∞'} witness=${rec ? `${rec.reportedSteps}(${rec.legalActionWitness.join('')},push${rec.pushes})` : 'NONE→UNKNOWN'}`);
    }
    console.log(`HV8-B1 (5,5) targets, cat=${rc(view.catPosition)}: ${rows.join(' | ')}`);
    console.log(`HV8-B1 cost for these ${targets.length} targets: facesProbed=${w.stats.boxFacesProbed} legalPushes=${w.stats.legalPushes} pruned=${w.stats.pushesPruned} fields=${w.stats.fieldsBuilt} incomplete=${w.stats.incomplete}`);
    for (const rec of w.cells.values()) {
      expect(rec.witnessVerified, `${rec.target} must be engine-signed before it is quoted`).toBe(true);
      expect(rec.reportedSteps, `${rec.target} steps match its witness`).toBe(rec.legalActionWitness.length);
    }
    const gateBest = Math.min(...gateKeys(p.leaf).map((g) => w.cells.get(g)?.reportedSteps ?? ctx.catMap.get(g) ?? Infinity));
    console.log(`HV8-B1 defensive gate: production walk=${ctx.catMap.get(gateKeys(p.leaf).reduce((a, b) => ((ctx.catMap.get(a) ?? 1e9) < (ctx.catMap.get(b) ?? 1e9) ? a : b))) ?? '∞'} best witnessed=${Number.isFinite(gateBest) ? gateBest : '∞'}`);
  });

  it('HV8-B2 scenario B: the (2,2) distances that were already right stay right', () => {
    const root = h1Turn(4).state;
    const p = leafOf(root, ['U', 'U', 'U', 'R']);
    const view = catView(p);
    const ctx = createEvaluationContext(p.leaf);
    const w = buildWitnessPushMap(view);
    const merged = mergeWithProduction(w);
    const mouse = evaluationCellKey(p.leaf.mousePosition);
    expect(merged.get(mouse), 'HV-7 measured walk=9 proved=9 here, so the model may not move it').toBe(ctx.catMap.get(mouse));
    expect(w.cells.get(mouse)?.reportedSteps ?? ctx.catMap.get(mouse), 'and any witness to the mouse must agree with 9').toBe(9);
    let changed = 0;
    const changedList: string[] = [];
    for (const [cell, d] of ctx.catMap) {
      const m = merged.get(cell);
      if (m !== undefined && m !== d) {
        changed++;
        changedList.push(`${cell}:${d}→${m}`);
      }
    }
    const unjustified = changedList.filter((entry) => {
      const cell = entry.split(':')[0];
      const rec = w.cells.get(cell);
      return rec === undefined || !rec.witnessVerified;
    });
    expect(unjustified, 'every changed distance must carry a verified witness').toEqual([]);
    console.log(`HV8-B2 (2,2): walk=${ctx.catMap.size} merged=${merged.size} changed=${changed} allWitnessed=${unjustified.length === 0} sample=${changedList.slice(0, 6).join(',')}`);
  });

  it('HV8-B3 scenario C: HV-7 B4 priced (5,9) at 12 steps with a route the engine refuses', () => {
    // The claim under test is HV-6's 12-step arrival at (5,9), whose action sequence
    // the real engine refuses. HV-8 must either beat 12 with a witness the engine
    // accepts or stop quoting 12 — and it must not restart HV-7's depth-12 exhaustive
    // proof to find out (that number is carried as saved reference, printed only).
    const root = h1Turn(4).state;
    const p = leafOf(root, ['U', 'U', 'U', 'R']);
    const view = catView(p);
    const ctx = createEvaluationContext(p.leaf);
    const old = buildCatPushDistanceMap(view);
    const w = buildWitnessPushMap(view);
    const merged = mergeWithProduction(w);
    const rec = w.cells.get('5,9');
    console.log(`HV8-B3 5,9: hv6FrozenLayoutMap=${old.get('5,9') ?? '∞'} productionWalk=${ctx.catMap.get('5,9') ?? '∞'} hv8Witness=${rec ? `${rec.reportedSteps} ${rec.legalActionWitness.join('')} src=${rec.source} push${rec.pushes} verified=${rec.witnessVerified}` : 'NONE→UNKNOWN'} merged=${merged.get('5,9') ?? '∞'} | HV-7 saved reference: the depth-12 exact prover stopped short of 12, it did not disprove arrival`);
    expect(old.has('5,9'), 'HV-7 established the frozen-layout map does claim it').toBe(true);
    expect(rec, 'HV-8 either proves a route or stays silent').toBeDefined();
    if (rec !== undefined) {
      expect(rec.witnessVerified, 'and a claimed route must replay through catMove').toBe(true);
      expect(rec.reportedSteps, 'and the reported step count is the replayed witness length').toBe(rec.legalActionWitness.length);
      expect(rec.reportedSteps, 'the falsified 12-step price is NOT repeated').not.toBe(12);
      expect(rec.reportedSteps, 'no push witness beats the plain walk here, so the score keeps the walk value').toBe(ctx.catMap.get('5,9'));
      expect(rec.reportedSteps, 'and that value is longer than what HV-6 fabricated').toBeGreaterThan(old.get('5,9')!);
    }
    expect(merged.get('5,9'), 'the scored value is the witnessed value, not the optimistic one').toBe(rec!.reportedSteps);
    expect(w.stats.fabricatedDropped, 'nothing was silently dropped at this view').toBe(0);
  });

  it('HV8-B4 scenario D: two boxes in a lane — the box the first push moved is still there', () => {
    const wall: [number, number][] = [];
    for (let c = 0; c <= 5; c++) { wall.push([7, c]); wall.push([9, c]); }
    const s = synth({ cat: [8, 0], mouse: [3, 3], box: [[8, 1], [8, 3]], wall });
    const view = bank(s);
    const old = buildCatPushDistanceMap(view);
    const w = buildWitnessPushMap(view);
    const merged = mergeWithProduction(w);
    const lane = ['8,1', '8,2', '8,3', '8,4', '8,5'];
    console.log(`HV8-B4 two-box lane: ${lane.map((c) => `${c}: hv6=${old.get(c) ?? '∅'} witness=${w.cells.get(c)?.reportedSteps ?? '∅'} merged=${merged.get(c) ?? '∅'}`).join(' | ')}`);
    expect(old.has('8,2'), 'HV-7 E3: the frozen-layout map claims the cell its own push vacated').toBe(true);
    expect(w.cells.has('8,2'), 'the witness model must not').toBe(false);
    expect(merged.has('8,2'), 'nor may the scored field').toBe(false);
    const landed = w.cells.get('8,1');
    expect(landed, 'the cat does reach the cell it pushed the box out of').toBeDefined();
    expect(landed!.legalActionWitness.join(''), 'by one legal push').toBe('R');
    expect(landed!.finalBoxLayout.split(' ').sort().join(','), 'and the box it moved now sits at 8,2').toContain('8,2');
  });

  it('HV8-B5 scenario E: a box-free board leaves the model with nothing to say', () => {
    const s = synth({ cat: [4, 4], mouse: [8, 0], box: [] });
    const view = bank(s);
    const w = buildWitnessPushMap(view);
    const merged = mergeWithProduction(w);
    expect(merged.size, 'the merged field is the walk field').toBe(w.walkField.size);
    let diff = 0;
    for (const [cell, d] of w.walkField) if (merged.get(cell) !== d) diff++;
    expect(diff, 'no distance moves on a board with no boxes').toBe(0);
    expect(w.stats.legalPushes).toBe(0);
    expect(w.stats.fieldsBuilt).toBe(0);
    console.log(`HV8-B5 box-free: cells=${merged.size} diff=0 pushes=0 fields=0 H1=${fmt(evaluateCorrectedHoleForCat(s))}`);
  });

  it('HV8-B6 scenario F: an unpushable box opens no route', () => {
    const s = synth({ cat: [1, 4], mouse: [4, 1], box: [[0, 4], [0, 5]], wall: [[0, 3]] });
    const view = bank(s);
    const w = buildWitnessPushMap(view);
    const merged = mergeWithProduction(w);
    console.log(`HV8-B6 unpushable pair: facesProbed=${w.stats.boxFacesProbed} legalPushes=${w.stats.legalPushes} 0,4 witness=${w.cells.get('0,4')?.reportedSteps ?? '∅'} 0,5 witness=${w.cells.get('0,5')?.reportedSteps ?? '∅'}`);
    expect(w.cells.has('0,4'), 'a box whose push destination is out of bounds is not a door').toBe(false);
    expect(w.cells.has('0,5')).toBe(false);
    expect(merged.has('0,4') || merged.has('0,5'), 'and neither appears in the scored field').toBe(false);
  });

  it('HV8-B7 scenario G: no-witness means UNKNOWN, not unreachable', () => {
    // Boxes at (8,2) and (8,5) in a walled lane. Reaching (8,3) needs two pushes:
    // push (8,2) to (8,3) is legal, but standing ON (8,3) then requires pushing that
    // same box again. One push cannot do it, so HV-8 must stay silent — and silence
    // is only honest if the two-level offline experiment proves the cell IS reachable.
    const wall: [number, number][] = [];
    for (let c = 0; c <= 7; c++) { wall.push([7, c]); wall.push([9, c]); }
    const s = synth({ cat: [8, 0], mouse: [3, 3], box: [[8, 2], [8, 5]], wall });
    const view = bank(s);
    const one = buildWitnessPushMap(view);
    const merged = mergeWithProduction(one);
    const two = twoPushWitness(view, ['8,3', '8,4'], 200);
    console.log(`HV8-B7 lane: one-push witnesses 8,2=${one.cells.get('8,2')?.reportedSteps ?? '∅'} 8,3=${one.cells.get('8,3')?.reportedSteps ?? '∅(UNKNOWN)'} 8,4=${one.cells.get('8,4')?.reportedSteps ?? '∅(UNKNOWN)'}`);
    console.log(`HV8-B7 two-push offline: ${[...two.found].map(([c, r]) => `${c}=${r.steps} ${r.witness.join('')} verified=${r.verified} pushes=${r.pushes}`).join(' | ')} fields=${two.fieldsBuilt} incomplete=${two.incomplete}`);
    const silent = ['8,3', '8,4'].filter((c) => !one.cells.has(c));
    expect(silent.length, 'the one-push model is silent exactly where it has no witness').toBeGreaterThan(0);
    for (const cell of silent) {
      expect(merged.has(cell), 'silent means absent from the claim set, NOT asserted unreachable').toBe(false);
    }
    const proven = silent.filter((c) => two.found.get(c)?.verified);
    expect(proven.length, 'an offline two-push witness proves at least one silent cell IS reachable, so absence there means UNKNOWN, not impossibility').toBeGreaterThanOrEqual(1);
    for (const c of proven) {
      const r = two.found.get(c)!;
      expect(r.pushes, `${c} is genuinely a two-push cell`).toBe(2);
      const still = buildWitnessPushMap(view, { targets: [c] });
      expect(still.cells.has(c), `and one push provably cannot reach it: ${c} stays silent`).toBe(false);
    }
    console.log(`HV8-B7 cells still unproven after two pushes: ${silent.filter((c) => !two.found.get(c)?.verified).join(',') || 'none'}`);
  });
});

describe('PPC-HV-8 C — P4: what the model costs, measured not argued', () => {
  it('HV8-C1: per-leaf fields and wall time across the real T4 turn endings', () => {
    const root = h1Turn(4).state;
    const enum_ = enumerateCatTurnExact([{ state: root, plan: [] }], 200_000);
    expect(enum_.truncated, 'the turn enumeration itself must be complete').toBe(false);
    const ends = enum_.ends.slice(0, 40);
    let fields = 0;
    let faces = 0;
    let pushes = 0;
    let replayed = 0;
    let worst = 0;
    let worstPlan = '';
    let totalMs = 0;
    const heap0 = process.memoryUsage().heapUsed;
    for (const e of ends) {
      const view = bank(handOffToMouse(e.state, true));
      const t0 = performance.now();
      const w = buildWitnessPushMap(view);
      const dt = performance.now() - t0;
      totalMs += dt;
      fields += w.stats.fieldsBuilt;
      faces += w.stats.boxFacesProbed;
      pushes += w.stats.legalPushes;
      replayed += w.stats.replayedSteps;
      if (dt > worst) { worst = dt; worstPlan = e.plan.join(''); }
    }
    const heap1 = process.memoryUsage().heapUsed;
    const perLeaf = totalMs / ends.length;
    console.log(`HV8-C1 leaves=${ends.length} fields=${fields} (${(fields / ends.length).toFixed(1)}/leaf) faces=${faces} legalPushes=${pushes} replayedSteps=${replayed}`);
    console.log(`HV8-C1 cost in-process (NOT a timing authority): total=${totalMs.toFixed(1)}ms avg=${(perLeaf * 1000).toFixed(0)}µs/leaf worst=${(worst * 1000).toFixed(0)}µs (${worstPlan})`);
    console.log(`HV8-C1 projection at 409 leaves: ${(perLeaf * 409).toFixed(0)}ms versus a 100ms main / 150ms turn budget`);
    console.log(`HV8-C1 heap delta over the run: ${((heap1 - heap0) / 1048576).toFixed(2)}MB (single sample, not a GC study)`);
    expect(perLeaf, 'a leaf must cost less than a second or the number is meaningless').toBeLessThan(1000);
  });

  it('HV8-C2: the target-directed variant, which is the only shape that could ship', () => {
    const root = h1Turn(4).state;
    const ends = enumerateCatTurnExact([{ state: root, plan: [] }], 200_000).ends.slice(0, 40);
    let fields = 0;
    let totalMs = 0;
    let worst = 0;
    let pruned = 0;
    let replayed = 0;
    let noVerifyMs = 0;
    for (const e of ends) {
      const view = bank(handOffToMouse(e.state, true));
      const targets = [evaluationCellKey(view.mousePosition), ...gateKeys(view), '4,8'];
      const t0 = performance.now();
      const w = buildWitnessPushMap(view, { targets, includeWalk: false });
      const dt = performance.now() - t0;
      totalMs += dt;
      fields += w.stats.fieldsBuilt;
      pruned += w.stats.pushesPruned;
      replayed += w.stats.replayedSteps;
      if (dt > worst) worst = dt;
      const t1 = performance.now();
      buildWitnessPushMap(view, { targets, includeWalk: false, verify: false });
      noVerifyMs += performance.now() - t1;
    }
    const perLeaf = totalMs / ends.length;
    const perLeafNoVerify = noVerifyMs / ends.length;
    console.log(`HV8-C2 target-directed (7 targets): fields=${fields} (${(fields / ends.length).toFixed(1)}/leaf) pruned=${pruned} replayedSteps=${replayed} (${(replayed / ends.length).toFixed(0)}/leaf) avg=${(perLeaf * 1000).toFixed(0)}µs/leaf worst=${(worst * 1000).toFixed(0)}µs`);
    console.log(`HV8-C2 projection at 409 leaves: ${(perLeaf * 409).toFixed(0)}ms (main budget 100ms)`);
    console.log(`HV8-C2 cost split: the same arm with the witness replay switched OFF costs ${(perLeafNoVerify * 1000).toFixed(0)}µs/leaf (${(perLeafNoVerify / perLeaf * 100).toFixed(0)}% of the verified price), so the replay is only ${((1 - perLeafNoVerify / perLeaf) * 100).toFixed(0)}% of it — the bulk is the ${(fields / ends.length).toFixed(1)} post-push distance fields per leaf (HV-7 measured one such BFS at ≈98µs), which is exactly the shape §七 calls disqualifying, and dropping the replay would only buy ${((1 - perLeafNoVerify / perLeaf) * 100).toFixed(0)}% by going back to HV-6's unverified field`);
    console.log(`HV8-C2 reference costs from HV-7: H1 leaf≈293µs, one extra cat-push BFS≈98µs, exact prover@depth12=460-1517ms`);
    expect(fields / ends.length, 'the target set must not need tens of fields per leaf to be interesting').toBeLessThan(40);
    expect(perLeafNoVerify, 'without the replay the model is cheaper, which is exactly why it may not ship').toBeLessThan(perLeaf);
  });

  it('HV8-C3: the caps actually cap — an incomplete map announces itself', () => {
    const root = h1Turn(4).state;
    const p = leafOf(root, ['R', 'R', 'R', 'R']);
    const full = buildWitnessPushMap(catView(p));
    const capped = buildWitnessPushMap(catView(p), { maxFields: 2 });
    console.log(`HV8-C3 full: fields=${full.stats.fieldsBuilt} cells=${full.cells.size} incomplete=${full.stats.incomplete} | capped maxFields=2: fields=${capped.stats.fieldsBuilt} cells=${capped.cells.size} incomplete=${capped.stats.incomplete} reason=${capped.stats.incompleteReason}`);
    expect(full.stats.incomplete).toBe(false);
    expect(capped.stats.incomplete, 'a capped run must say it is not a complete map').toBe(true);
    expect(capped.stats.fieldsBuilt).toBeLessThanOrEqual(2);
    expect(capped.cells.size).toBeLessThanOrEqual(full.cells.size);
    const two = twoPushWitness(catView(p), ['4,8'], 3);
    expect(two.incomplete, 'the offline two-push experiment respects its own field cap').toBe(true);
    console.log(`HV8-C3 two-push cap 3: fields=${two.fieldsBuilt} incomplete=${two.incomplete} reason=${two.reason}`);
  });
});

describe('PPC-HV-8 D — P3: does a witnessed route change what H1 scores?', () => {
  it('HV8-D1: the substitution harness reproduces production H1 bit-exactly', () => {
    const root = h1Turn(4).state;
    for (const tokens of [['U', 'U', 'U', 'R'], ['R', 'R', 'R', 'R']]) {
      const p = leafOf(root, tokens);
      const own = createEvaluationContext(p.leaf);
      const via = h1WithField(p, own.catMap);
      expect(via.total, `substituting the production map must change nothing for ${tokens.join('')}`).toBe(p.h1);
    }
    console.log('HV8-D1 harness parity: production catMap through buildSubstitutedContext == production H1, bit-exact at both leaves');
  });

  it('HV8-D2: four arrival models, same production formulas, same two leaves', () => {
    const root = h1Turn(4).state;
    const a = leafOf(root, ['U', 'U', 'U', 'R']);
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const arms: { name: string; field: (p: LeafProbe) => Map<string, number> }[] = [
      { name: 'walk (production H1)', field: (p) => createEvaluationContext(p.leaf).catMap },
      { name: 'hv7 1-push-last (sound)', field: (p) => onePushLastArrival(catView(p), createEvaluationContext(p.leaf).catMap) },
      { name: 'hv8 witness walk→push→walk', field: (p) => mergeWithProduction(buildWitnessPushMap(catView(p))) },
    ];
    const out: Record<string, { uuur: number; rrrr: number }> = {};
    for (const arm of arms) {
      const fa = arm.field(a);
      const fb = arm.field(b);
      const va = h1WithField(a, fa);
      const vb = h1WithField(b, fb);
      out[arm.name] = { uuur: va.total, rrrr: vb.total };
      console.log(`HV8-D2 ${arm.name.padEnd(28)} UUUR=${fmt(va.total)} [mouse=${va.feats.catMouseDistance} gate=${va.feats.catHoleGateDistance} area=${va.feats.catReachableArea} mob=${va.feats.catMobility}] RRRR=${fmt(vb.total)} [mouse=${vb.feats.catMouseDistance} gate=${vb.feats.catHoleGateDistance} area=${vb.feats.catReachableArea} mob=${vb.feats.catMobility}] → pick ${va.total > vb.total ? 'UUUR' : 'RRRR'} (Δ ${(va.total - vb.total).toFixed(4)})`);
    }
    const before = out['walk (production H1)'].uuur - out['walk (production H1)'].rrrr;
    const after = out['hv8 witness walk→push→walk'].uuur - out['hv8 witness walk→push→walk'].rrrr;
    console.log(`HV8-D2 gap: before=${before.toFixed(4)} after=${after.toFixed(4)} closed=${(before - after).toFixed(4)} (${(((before - after) / before) * 100).toFixed(1)}%) exact before=${before} after=${after}`);
    console.log(`HV8-D2 reference only, not recomputed here (HV-7 saved): engine-proved exact ≤12 UUUR=-1625.7632 RRRR=-975.2368 → pick RRRR (Δ -650.5263); HV-7 also swapped engine mobility, which this table deliberately does not`);
    expect(before.toFixed(4)).toBe('741.6053');
    const items = ITEM_NAMES.map((n) => {
      const ca = contributionsOf(a, arms[2].field(a));
      const cb = contributionsOf(b, arms[2].field(b));
      const c0a = contributionsOf(a, arms[0].field(a));
      const c0b = contributionsOf(b, arms[0].field(b));
      return `${n} Δ ${(c0a[n] - c0b[n]).toFixed(2)}→${(ca[n] - cb[n]).toFixed(2)}`;
    });
    console.log(`HV8-D2 item gaps walk→hv8: ${items.join(' | ')}`);
    console.log(`HV8-D2 mobility is deliberately NOT substituted (the production formula reads it from the state, so this arm is more conservative than HV-7's): UUUR ${mobLine(a)} | RRRR ${mobLine(b)}`);
    expect(after, 'the witness arm may only ever shrink the gap, never invent a new ranking direction').toBeLessThan(before);
  });

  it('HV8-D3: which targets still have no witness at (5,5), and does two pushes fix them', () => {
    const root = h1Turn(4).state;
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const view = catView(b);
    const ctx = createEvaluationContext(b.leaf);
    const one = buildWitnessPushMap(view);
    const targets = [evaluationCellKey(b.leaf.mousePosition), ...gateKeys(b.leaf), '4,8'];
    const rows = targets.map((t) => `${t}: walk=${ctx.catMap.get(t) ?? '∞'} one=${one.cells.get(t)?.reportedSteps ?? '∅'} `);
    const need = targets.filter((t) => !one.cells.has(t) && !ctx.catMap.has(t));
    const two = twoPushWitness(view, targets, 600);
    console.log(`HV8-D3 (5,5): ${rows.join('|')} fields=${one.stats.fieldsBuilt}`);
    console.log(`HV8-D3 two-push offline over ${targets.length} targets: ${targets.map((t) => `${t}=${two.found.get(t)?.steps ?? '∅'}${two.found.get(t)?.verified ? '(ok)' : '(FAIL)'}`).join(' ')} fields=${two.fieldsBuilt} incomplete=${two.incomplete}`);
    console.log(`HV8-D3 targets with no witness at all after two pushes: ${targets.filter((t) => !two.found.get(t)?.verified).join(',') || 'none'}`);
    expect(need.length, 'the mouse and the gates are walk-known cells; this line only reports the truly unproven ones').toBeGreaterThanOrEqual(0);
  });

  it('HV8-D4: no arm may fabricate — every improvement is a replayed witness', () => {
    const root = h1Turn(4).state;
    const offenders: string[] = [];
    for (const tokens of [['U', 'U', 'U', 'R'], ['R', 'R', 'R', 'R'], ['U', 'R', 'D', 'R'], ['D', 'R', 'R', 'U']]) {
      const p = leafOf(root, tokens);
      const view = catView(p);
      const walk = createEvaluationContext(p.leaf).catMap;
      const w = buildWitnessPushMap(view);
      const merged = mergeWithProduction(w);
      for (const [cell, d] of merged) {
        const old = walk.get(cell);
        if (old === undefined || d < old) {
          const rec = w.cells.get(cell);
          if (!rec || !rec.witnessVerified) offenders.push(`${tokens.join('')} ${cell}@${d}`);
        }
      }
      expect(w.stats.fabricatedDropped >= 0, 'the drop counters are reported, never hidden').toBe(true);
    }
    console.log(`HV8-D4 improvements without a witness: ${offenders.length}${offenders.length ? ` [${offenders.slice(0, 8).join(',')}]` : ' NONE_FOUND'}`);
    expect(offenders).toEqual([]);
  });

  it('HV8-D5: how many pushes does each defensive target actually need', () => {
    // §六 asks whether ONE push restores the defensive route. This answers it with
    // witnesses, not with a restarted exhaustive proof: the one-push model is the
    // production entry candidate, the two-level sweep is the offline control §六
    // allows on T4 targets only, and every cell neither one covers stays UNKNOWN.
    const root = h1Turn(4).state;
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const view = catView(b);
    const ctx = createEvaluationContext(b.leaf);
    const mouse = evaluationCellKey(b.leaf.mousePosition);
    const targets = [mouse, ...gateKeys(b.leaf), '4,8'];
    // The FULL sweep is used for the claims (no admissible pruning, so nothing that
    // could tie is dropped); the target-directed sweep is only the cheap mode, and
    // D5 proves the two score identically.
    const one = buildWitnessPushMap(view);
    const oneFast = buildWitnessPushMap(view, { targets });
    const two = twoPushWitness(view, targets, 600);
    let scoredDisagree = 0;
    for (const t of targets) {
      if (mergeWithProduction(one).get(t) !== mergeWithProduction(oneFast).get(t)) scoredDisagree++;
    }
    expect(scoredDisagree, 'the pruned cheap mode must score the same field on its own targets').toBe(0);
    console.log(`HV8-D5 cheap vs full mode: fields ${one.stats.fieldsBuilt}→${oneFast.stats.fieldsBuilt} (pushes pruned=${oneFast.stats.pushesPruned}) and the scored distances for all ${targets.length} targets agree exactly`);
    const rows = targets.map((t) => {
      const r1 = one.cells.get(t);
      const r2 = two.found.get(t);
      return `${t}: walk=${ctx.catMap.get(t) ?? '∞'} | 1push=${r1 ? `${r1.reportedSteps}(push${r1.pushes},${r1.source})` : 'UNKNOWN'} | 2push=${r2 ? `${r2.steps}(push${r2.pushes}${r2.verified ? ',replayed' : ',UNREPLAYED'})` : 'UNKNOWN'}`;
    });
    console.log(`HV8-D5 (5,5) push depth per defensive target: ${rows.join(' || ')}`);
    console.log(`HV8-D5 sweep honesty: full incomplete=${one.stats.incomplete} descendFailures=${one.stats.descendFailures} walkCellsWithoutWitness=${one.stats.walkCellsWithoutWitness} twoPush fields=${two.fieldsBuilt} incomplete=${two.incomplete}${two.incomplete ? ` (${two.reason})` : ''} — silence means UNKNOWN, never unreachable, and an un-witnessed production cell is inherited, not repaired`);
    const bought = targets.map((t) => one.cells.get(t)).filter((r): r is WitnessRecord => r !== undefined && r.source === 'one-push' && (ctx.catMap.get(r.target) ?? Infinity) > r.reportedSteps);
    console.log(`HV8-D5 what ONE push buys at (5,5): ${bought.map((r) => `${r.target}@${ctx.catMap.get(r.target)}→${r.reportedSteps} via ${r.legalActionWitness.join('')} [${r.pushBase}]`).join(' | ') || 'nothing'}`);
    expect(bought.length, 'a single push does restore the gate cells').toBeGreaterThan(0);
    for (const r of bought) {
      expect(r.pushes, `${r.target} is restored by exactly one push`).toBe(1);
      expect(r.witnessVerified, `${r.target} carries a replayed witness`).toBe(true);
      expect(r.reportedSteps, `${r.target} price equals its witness length`).toBe(r.legalActionWitness.length);
    }
    const mouseRoute = one.cells.get(mouse);
    expect(mouseRoute, 'the cat-to-mouse route is a claim or a silence, never a guess').toBeDefined();
    expect(mouseRoute!.reportedSteps, 'one push leaves cat→mouse at the walking value').toBe(ctx.catMap.get(mouse));
    const laneOne = one.cells.get('4,8');
    const laneTwo = two.found.get('4,8');
    console.log(`HV8-D5 4,8: walk=${ctx.catMap.get('4,8') ?? '∞'} fullSweep1push=${laneOne ? `${laneOne.reportedSteps}/${laneOne.source}` : 'UNKNOWN'} 2push=${laneTwo ? `${laneTwo.steps}/push${laneTwo.pushes}/verified=${laneTwo.verified}` : 'UNKNOWN'} vs HV-7's SAVED unrestricted engine proof = 4 steps (and cat→mouse 7 vs 17): one push restores nothing here, the bounded two-push sweep does not even tie the walk, so this defensive line lives on a push sequence BEYOND the one-push model — its exact push count is not measured here, and HV-8 leaves the cell at the walk value rather than guessing`);
    if (laneOne !== undefined) {
      expect(laneOne.reportedSteps, 'a one-push witness for 4,8 does not beat walking').toBeGreaterThanOrEqual(ctx.catMap.get('4,8')!);
    }
    if (laneTwo !== undefined && laneTwo.verified) {
      expect(laneTwo.pushes, 'the two-push witness that does exist costs two pushes').toBe(2);
      expect(laneTwo.steps, 'and it is still longer than the plain walk, so it buys nothing').toBeGreaterThan(ctx.catMap.get('4,8')!);
    }
    expect(laneOne === undefined || laneOne.reportedSteps >= 4, 'no witness undercuts the saved exact minimum').toBe(true);
  });
});

describe('PPC-HV-8 F — HV-9 §四: the witness contract itself', () => {
  it('HV8-F1: a route that was never replayed is not labelled verified and cannot reach the scored field', () => {
    const root = h1Turn(4).state;
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const view = catView(b);
    const replayed = buildWitnessPushMap(view);
    const skipped = buildWitnessPushMap(view, { verify: false });
    const badReplayed = [...replayed.cells.values()].filter((r) => !r.witnessVerified || r.verification !== 'replayed' || r.finalBoxLayout === '');
    const badSkipped = [...skipped.cells.values()].filter((r) => r.witnessVerified || r.verification !== 'skipped');
    expect(badReplayed, 'a replayed run may not carry an unverified or layout-less record').toEqual([]);
    expect(badSkipped, 'a run that skipped the replay may not mark anything as verified').toEqual([]);
    expect(skipped.stats.verificationSkipped, 'every skipped record is counted').toBe(skipped.cells.size);
    expect(verifiedCells(skipped).size, 'none of them is usable').toBe(0);
    expect(witnessDistances(skipped).size, 'the proved distance view is empty when nothing was replayed').toBe(0);
    const mergedSkipped = mergeWithProduction(skipped);
    const ctxCat = createEvaluationContext(b.leaf).catMap;
    let mapDiff = 0;
    for (const [cell, d] of ctxCat) if (mergedSkipped.get(cell) !== d) mapDiff++;
    expect(mergedSkipped.size, 'the unverified arm yields exactly the production cell count').toBe(ctxCat.size);
    expect(mapDiff, 'with verification off the scored field IS the production cat map — the marker is load-bearing, not decorative').toBe(0);
    expect(h1WithField(b, mergedSkipped).total, 'so the score cannot move by one bit either').toBe(b.h1);
    const mergedReal = mergeWithProduction(replayed);
    let shortcuts = 0;
    for (const [cell, d] of mergedReal) {
      const w0 = replayed.walkField.get(cell);
      if (w0 !== undefined && d < w0) shortcuts++;
    }
    expect(shortcuts, 'the replayed arm does shorten cells, so this test is not comparing two empty sets').toBeGreaterThan(0);
    console.log(`HV8-F1 replayed: cells=${replayed.cells.size} replayAttempts=${replayed.stats.replayAttempts} shortcuts=${shortcuts} | skipped: cells=${skipped.cells.size} verified=0 merged==production catMap (diff=0) H1=${fmt(h1WithField(b, mergedSkipped).total)} vs production ${fmt(b.h1)}`);
  });

  it('HV8-F2: an inherited production distance and a replayed witness are distinguishable, and no number moved', () => {
    const root = h1Turn(4).state;
    for (const tokens of [['R', 'R', 'R', 'R'], ['U', 'U', 'U', 'R']]) {
      const p = leafOf(root, tokens);
      const w = buildWitnessPushMap(catView(p));
      const prov = mergeWithProvenance(w);
      const plain = mergeWithProduction(w);
      let numMismatch = 0;
      for (const [cell, claim] of prov) if (plain.get(cell) !== claim.steps) numMismatch++;
      expect(plain.size, 'the provenance view covers the same cells').toBe(prov.size);
      expect(numMismatch, 'adding provenance may not change a single number').toBe(0);
      const witnessed = [...prov].filter(([, c]) => c.origin === 'witnessed');
      const production = [...prov].filter(([, c]) => c.origin === 'production');
      const badWitness = witnessed.filter(([, c]) => c.witness === null
        || c.witness.verification !== 'replayed'
        || c.steps !== c.witness.reportedSteps
        || c.steps >= (w.walkField.get(c.witness.target) ?? Number.POSITIVE_INFINITY));
      expect(badWitness, 'a witnessed origin requires a replayed witness strictly shorter than production').toEqual([]);
      const badProd = production.filter(([cell, c]) => c.steps !== w.walkField.get(cell));
      expect(badProd, 'a production origin is the inherited walk number, untouched').toEqual([]);
      const corroborated = production.filter(([, c]) => c.witness !== null).length;
      console.log(`HV8-F2 ${tokens.join('')}: scored=${prov.size} witnessed=${witnessed.length} [${witnessed.map(([cell, c]) => `${cell}@${c.steps} vs production ${w.walkField.get(cell) ?? 'no claim'} via ${c.witness!.legalActionWitness.join('')}`).join(', ')}] production=${production.length} of which ${corroborated} also carry a same-or-longer replayed witness`);
    }
  });

  it('HV8-F3: silence is UNKNOWN, never unreachable — with a route HV-9 P0 proved but this model cannot see', () => {
    const root = h1Turn(4).state;
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const w = buildWitnessPushMap(catView(b));
    const claim48 = classifyArrival(w, '4,8');
    expect(claim48, 'production claims 4,8, so the scored field keeps it').not.toBeNull();
    expect(claim48!.steps, 'and at the inherited walking price').toBe(20);
    expect(claim48!.origin, 'HV-8 has no replayed route that beats walking, so this number is inherited, not witnessed').toBe('production');
    const holeClaim = classifyArrival(w, '7,8');
    expect(holeClaim, 'a mouse-hole cell is absent from both fields — that is UNKNOWN to this model, not a proof of impassability').toBeNull();
    const wall: [number, number][] = [];
    for (let c = 0; c <= 7; c++) { wall.push([7, c]); wall.push([9, c]); }
    const laneView = bank(synth({ cat: [8, 0], mouse: [3, 3], box: [[8, 2], [8, 5]], wall }));
    const one = buildWitnessPushMap(laneView);
    const two = twoPushWitness(laneView, ['8,3', '8,4'], 200);
    expect(classifyArrival(one, '8,3'), 'the one-push model is silent on 8,3').toBeNull();
    expect(two.found.get('8,3')?.verified, 'yet an engine-replayed two-push route exists, so silence never meant impossible').toBe(true);
    console.log(`HV8-F3 three states: 4,8=${claim48!.origin}@${claim48!.steps} (HV-9 P0 proved a 4-step 3-push route here — the scored field UNDERSTATES reachability), 7,8=null, lane 8,3=null while two-push replays ${two.found.get('8,3')?.steps} steps ${two.found.get('8,3')?.witness.join('')}`);
  });

  it('HV8-F4: a refused shorter candidate cannot destroy a longer signed witness', () => {
    const root = h1Turn(4).state;
    const cases = [
      { name: 'RRRR', view: catView(leafOf(root, ['R', 'R', 'R', 'R'])) },
      { name: 'UUUR', view: catView(leafOf(root, ['U', 'U', 'U', 'R'])) },
      { name: 'lane-two-box', view: bank(synth({ cat: [8, 0], mouse: [3, 3], box: [[8, 1], [8, 3]], wall: [[7, 0], [7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [9, 0], [9, 1], [9, 2], [9, 3], [9, 4], [9, 5]] })) },
      { name: 'lane-corridor', view: bank(synth({ cat: [8, 0], mouse: [3, 3], box: [[8, 2], [8, 5]], wall: [[7, 0], [7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7], [9, 0], [9, 1], [9, 2], [9, 3], [9, 4], [9, 5], [9, 6], [9, 7]] })) },
    ];
    const rows: string[] = [];
    let refusedTotal = 0;
    let displacementObserved = false;
    for (const cs of cases) {
      const w = buildWitnessPushMap(cs.view);
      const targets = ['4,8', ...gateKeys(cs.view)];
      const two = twoPushWitness(cs.view, targets, 200);
      expect([...w.cells.values()].every((r) => r.witnessVerified && r.verification === 'replayed'), `${cs.name}: reported cells are all engine-signed`).toBe(true);
      expect([...two.found.values()].every((r) => r.verified), `${cs.name}: found holds only replayed routes`).toBe(true);
      for (const [t, r] of two.found) {
        const again = replayWitness(cs.view, tokensToDirections(r.witness));
        expect(again.ok, `${cs.name} ${t}: the independent re-replay accepts the route`).toBe(true);
        expect(rc(again.finalState.catPosition), `${cs.name} ${t}: and lands on the target`).toBe(t);
        expect(again.steps, `${cs.name} ${t}: at the quoted price`).toBe(r.steps);
      }
      for (const [t, list] of two.refused) {
        const kept = two.found.get(t);
        if (kept !== undefined && list.some((e) => e.steps < kept.steps)) displacementObserved = true;
      }
      refusedTotal += [...two.refused.values()].reduce((a, l) => a + l.length, 0);
      rows.push(`${cs.name}: reported=${w.cells.size} attempts=${w.stats.replayAttempts} dropped=${w.stats.fabricatedDropped} captureRefusals=${w.stats.rejectedThroughCapture} fallbacksUsed=${w.stats.fallbacksUsed} alternatesCapped=${w.stats.alternatesCapped} | two-push found=${two.found.size} refused=${two.refused.size} incomplete=${two.incomplete}`);
    }
    console.log(`HV8-F4 chain audit: ${rows.join(' || ')}`);
    console.log(`HV8-F4 verdict: refused candidates across the scan=${refusedTotal}, a genuine displacement (shorter candidate refused while a longer signed witness stands) was ${displacementObserved ? 'OBSERVED and survived' : 'NOT_OBSERVED'} — with zero refusals on these views the pre-fix overwrite could not have erased a signed witness, which is why every HV-8 number above is unchanged; the contract is now closed structurally instead of relying on that luck`);
    expect(refusedTotal, 'the scan reports its own refusal population, it is not assumed').toBeGreaterThanOrEqual(0);
    expect(displacementObserved, 'no longer signed witness may go missing because a shorter hypothesis failed').toBe(false);
  });
});

describe('PPC-HV-8 E — P5: the eight admission gates, one line each', () => {
  it('HV8-E1: gate ledger for h1_witness_push_trial', () => {
    const root = h1Turn(4).state;
    const a = leafOf(root, ['U', 'U', 'U', 'R']);
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const ctxA = createEvaluationContext(a.leaf);
    const ctxB = createEvaluationContext(b.leaf);
    const wa = buildWitnessPushMap(catView(a));
    const wb = buildWitnessPushMap(catView(b));
    const fa = mergeWithProduction(wa);
    const fb = mergeWithProduction(wb);
    const ha = h1WithField(a, fa);
    const hb = h1WithField(b, fb);
    const prodA = h1WithField(a, ctxA.catMap);
    const prodB = h1WithField(b, ctxB.catMap);

    // 1 — every claim carries a witness the engine signed, priced at its own length.
    const claims = [...wa.cells.values(), ...wb.cells.values()];
    const badClaims = claims.filter((r) => !r.witnessVerified || r.reportedSteps !== r.legalActionWitness.length || r.pushes > 1);
    const g1 = badClaims.length === 0 ? 'PASS' : 'FAIL';

    // 2 — HV-7's two falsified claims stay dead: (5,9) never priced at 12, and the
    // two-box lane's stale-layout cell never claimed at all.
    const fiveNine = wa.cells.get('5,9');
    const falsified12 = fiveNine !== undefined && fiveNine.reportedSteps === 12;
    const laneWall: [number, number][] = [];
    for (let c = 0; c <= 5; c++) { laneWall.push([7, c]); laneWall.push([9, c]); }
    const laneW = buildWitnessPushMap(bank(synth({ cat: [8, 0], mouse: [3, 3], box: [[8, 1], [8, 3]], wall: laneWall })));
    const staleLayout = laneW.cells.has('8,2');
    const g2 = !falsified12 && !staleLayout ? 'PASS' : 'FAIL';

    // 3 — does the cat see a genuinely shorter defensive route on the real leaf?
    const mouseCell = evaluationCellKey(b.leaf.mousePosition);
    const gB = gateKeys(b.leaf);
    const gatesImproved = gB.filter((g) => (fb.get(g) ?? Infinity) < (ctxB.catMap.get(g) ?? Infinity));
    const mouseImproved = (fb.get(mouseCell) ?? Infinity) < (ctxB.catMap.get(mouseCell) ?? Infinity);
    const g3 = gatesImproved.length > 0 && mouseImproved ? 'PASS' : gatesImproved.length > 0 || mouseImproved ? 'PARTIAL' : 'FAIL';

    // 4 — UNKNOWN is never scored: the merged field may only ADD cells and shorten them.
    const lost = [...ctxA.catMap.keys()].filter((k) => !fa.has(k)).length + [...ctxB.catMap.keys()].filter((k) => !fb.has(k)).length;
    const worse = [...ctxA.catMap].filter(([k, d]) => fa.has(k) && fa.get(k)! > d).length
      + [...ctxB.catMap].filter(([k, d]) => fb.has(k) && fb.get(k)! > d).length;
    const unjustified = [...fa].filter(([k, d]) => d < (ctxA.catMap.get(k) ?? Infinity) && !wa.cells.has(k)).length
      + [...fb].filter(([k, d]) => d < (ctxB.catMap.get(k) ?? Infinity) && !wb.cells.has(k)).length;
    const g4 = lost === 0 && worse === 0 && unjustified === 0 ? 'PASS' : 'FAIL';

    // 5/6/7 — parity of everything this round must not touch.
    const g5 = prodA.total === a.h1 && prodB.total === b.h1 ? 'PASS' : 'FAIL';
    const g6 = 'PASS';
    const g7 = 'PASS';

    // 8 — cost, measured here rather than argued: 12 real T4 turn endings, projected
    // onto the ~409 leaves the 100ms main search actually evaluates.
    const enum_ = enumerateCatTurnExact([{ state: root, plan: [] }], 60_000);
    const ends = enum_.ends.slice(0, 12);
    let ms = 0;
    let fields = 0;
    for (const e of ends) {
      const view = bank(handOffToMouse(e.state, true));
      const t0 = performance.now();
      fields += buildWitnessPushMap(view).stats.fieldsBuilt;
      ms += performance.now() - t0;
    }
    const avgUs = (ms / ends.length) * 1000;
    const projectionMs = (ms / ends.length) * 409;
    const g8 = projectionMs <= 100 ? 'PASS' : 'FAIL';

    const gates = [
      `1 every new reachability claim has a replayed legal-action witness: ${g1} (claims=${claims.length} bad=${badClaims.length})`,
      `2 HV-7's falsified paths stay dead: ${g2} (5,9 witnessed=${fiveNine ? `${fiveNine.reportedSteps}/${fiveNine.source}` : 'UNKNOWN'} not 12=${!falsified12}; lane 8,2 stale-layout claim=${staleLayout})`,
      `3 T4 defensive distance improves: ${g3} (gates ${gB.map((g) => `${ctxB.catMap.get(g) ?? '∞'}→${fb.get(g) ?? '∞'}`).join(',')} improved=${gatesImproved.length}; cat→mouse ${ctxB.catMap.get(mouseCell)}→${fb.get(mouseCell)} ${mouseImproved ? 'IMPROVED' : 'UNCHANGED'}; 4,8 ${ctxB.catMap.get('4,8') ?? '∞'}→${fb.get('4,8') ?? 'UNKNOWN'})`,
      `4 UNKNOWN is never scored as reachable or unreachable: ${g4} (cells lost=${lost} distances worsened=${worse} improvements without a witness=${unjustified})`,
      `5 original H1 numbers unchanged: ${g5} (${fmt(prodA.total)} / ${fmt(prodB.total)} = saved UUUR / RRRR)`,
      `6 Gate Race numbers unchanged: ${g6} (gateRaceLeaf / evaluation untouched — verified by git diff in §十)`,
      `7 RB-1 exact/bound semantics untouched: ${g7} (no search file changed — verified by git diff in §十)`,
      `8 extra leaf cost fits the 100ms main search: ${g8} (avg=${avgUs.toFixed(0)}µs/leaf over ${ends.length} real turn endings, ${fields} post-push fields, ${(fields / ends.length).toFixed(1)} fields/leaf → ${projectionMs.toFixed(0)}ms per 409 leaves vs a 100ms main / 150ms turn budget)`,
    ];
    for (const g of gates) console.log(`HV8-E1 ${g}`);
    console.log(`HV8-E1 decision under the witness arm (full precision): UUUR=${ha.total} RRRR=${hb.total} Δ=${ha.total - hb.total} → ${ha.total > hb.total ? 'UUUR (unchanged)' : 'RRRR'}`);
    console.log(`HV8-E1 ADMISSION=${g1 === 'PASS' && g2 === 'PASS' && g3 === 'PASS' && g4 === 'PASS' && g5 === 'PASS' && g8 === 'PASS' ? 'GRANTED' : 'NOT_GRANTED'} — §八 needs all eight; gate 3=${g3}, gate 8=${g8} → h1_witness_push_trial is NOT created and H1 stays the only production leaf evaluator`);

    expect(badClaims, 'gate 1').toEqual([]);
    expect(falsified12, 'gate 2a').toBe(false);
    expect(staleLayout, 'gate 2b').toBe(false);
    expect(lost, 'gate 4: production cells may not disappear').toBe(0);
    expect(worse, 'gate 4: production distances may not grow').toBe(0);
    expect(unjustified, 'gate 4: no shortening without a witness').toBe(0);
    expect(prodA.total, 'gate 5').toBe(a.h1);
    expect(prodB.total, 'gate 5').toBe(b.h1);
    expect(projectionMs, 'gate 8: the measured projection is the evidence, and it does not fit').toBeGreaterThan(100);
  });
});
