/// <reference types="node" />
/**
 * PPC-HV-7 — P0/P1 forensics: why does H1 score the legally intercepting
 * `RRRR → (5,5)` ~741 points below `UUUR → (2,2)`?
 *
 * INSTRUMENT ONLY. Nothing here changes production evaluation: the counterfactual
 * "push-aware" recomputation lives in this file, mirrors evaluation.ts:636-709, and
 * is self-checked by reproducing the PRODUCTION H1 total bit-exactly when it is run
 * with the walk-only features (HV7-B2). If the copy ever drifts from production,
 * that self-check fails instead of silently producing a flattering number.
 */
import { describe, expect, it } from 'vitest';
import { catMove, createInitialState, type GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, Difficulty, PieceType, GamePhase, type Direction } from '../../types';
import { DEFAULT_CONFIG } from '../../config';
import { computeGateRace, evaluateH1GateRaceForCat } from '../gateRaceLeaf';
import {
  DEFAULT_EVALUATION_WEIGHTS,
  buildCatPushDistanceMap,
  createEvaluationContext,
  evaluateForCatDetailed,
  evaluationCellKey,
  mouseCarryingDistanceToHole,
  type EvaluationBreakdown,
} from '../evaluation';
import { correctedHoleControlValue, correctedHoleEvalTotal, evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { stateKey } from '../transposition';
import {
  catActions,
  enumerateCatTurnExact,
  h1Turn,
  handOffToMouse,
  rc,
  replayCatPlan,
} from './hv5ForcedLineAuditor';

const W = DEFAULT_EVALUATION_WEIGHTS;
const KEYS = [
  'capturePressure', 'mouseGoalThreat', 'butterRace', 'confinement', 'mobility',
  'trapControl', 'tunnelControl', 'holeControl', 'voronoiBalance', 'tempo',
] as const;

interface LeafProbe {
  plan: string;
  end: GameEngineState;
  leaf: GameEngineState;
  bd: EvaluationBreakdown;
  h1: number;
}

/** Run one complete cat turn with the real engine, then take the leaf the search scores. */
function probeOf(plan: string, end: GameEngineState): LeafProbe {
  const leaf = handOffToMouse(end, true);
  const bd = evaluateForCatDetailed(leaf, DEFAULT_EVALUATION_WEIGHTS);
  return { plan, end, leaf, bd, h1: correctedHoleEvalTotal(bd, leaf.config.boardSize) };
}

function leafOf(root: GameEngineState, tokens: string[]): LeafProbe {
  const replayed = replayCatPlan(root, tokens);
  expect(replayed.illegalAt, `plan ${tokens.join('')} is legal on the real engine`).toBeNull();
  expect(replayed.applied.length, `plan ${tokens.join('')} applies every step`).toBe(tokens.length);
  return probeOf(tokens.join(''), replayed.end);
}

/** Take an already-mouse-to-move state (a synthetic fixture) as the leaf itself. */
function leafOfState(plan: string, leaf: GameEngineState): LeafProbe {
  const bd = evaluateForCatDetailed(leaf, DEFAULT_EVALUATION_WEIGHTS);
  return { plan, end: leaf, leaf, bd, h1: correctedHoleEvalTotal(bd, leaf.config.boardSize) };
}

/**
 * The cat's own legal-step view of a leaf: `catMove` is a no-op while the mouse
 * moves and also refuses to step when the bank is empty, so the engine oracle
 * needs the cat-to-move state with a full budget (the static maps do not read
 * either field, so this changes nothing about the distances being compared).
 */
const bank = (s: GameEngineState): GameEngineState => ({
  ...s,
  currentPlayer: PieceType.Cat,
  catMovesLeft: s.config.catBaseMoves,
});

const catView = (p: LeafProbe): GameEngineState => bank(p.end);

/**
 * Complete multi-turn cat reachability prover: BFS over REAL engine states,
 * deduplicated by the full `stateKey` (so a box layout that changes the future is
 * never merged with the one that does not), one full cat budget banked per ply —
 * the same quantity the static maps measure, but proved instead of assumed.
 */
function marchComplete(s: GameEngineState, maxDepth: number, nodeCap: number) {
  const dist = new Map<string, number>();
  let frontier: GameEngineState[] = [s];
  const seen = new Set<string>([stateKey(s)]);
  dist.set(rc(s.catPosition), 0);
  let nodes = 0;
  let truncated = false;
  for (let depth = 1; depth <= maxDepth && !truncated; depth++) {
    const next: GameEngineState[] = [];
    for (const cur of frontier) {
      const banked = { ...cur, catMovesLeft: cur.config.catBaseMoves } as GameEngineState;
      for (const a of catActions(banked)) {
        if (a.token === 'P') continue; // trap placement is not a step
        const cell = rc(a.state.catPosition);
        if (a.state.phase !== GamePhase.Playing) {
          // Stepping onto the mouse ENDS the game: it is a legal arrival, so it is
          // recorded, but there is no state left to expand.
          if (!dist.has(cell)) dist.set(cell, depth);
          continue;
        }
        const k = stateKey(a.state);
        if (seen.has(k)) continue;
        seen.add(k);
        nodes++;
        if (nodes >= nodeCap) { truncated = true; break; }
        if (!dist.has(cell)) dist.set(cell, depth);
        next.push(a.state);
      }
      if (truncated) break;
    }
    frontier = next;
  }
  return { dist, states: nodes, truncated };
}

/**
 * The push map's OWN witness for one of its cells: a shortest chain of map cells at
 * strictly increasing distances, where every step is validated by the real step
 * function applied to the FROZEN board the map was built from (engine legality on
 * that board is exactly the predicate the map expands with, so no rule is
 * re-implemented here). `cells[j+1]` is where the map believes step j lands.
 */
function mapWitness(
  view: GameEngineState,
  push: Map<string, number>,
  target: string,
): { tokens: string[]; cells: string[] } | null {
  const want = push.get(target);
  if (want === undefined) return null;
  const mouse = rc(view.mousePosition);
  const token = (d: Direction): string => d.key.replace('Arrow', '').slice(0, 1);
  let frontier = [{ cell: rc(view.catPosition), tokens: [] as string[], cells: [rc(view.catPosition)] }];
  const seen = new Set([frontier[0]!.cell]);
  for (let step = 0; step < want; step++) {
    const next: typeof frontier = [];
    for (const cur of frontier) {
      if (cur.cell === mouse) continue; // the map never expands through a capture
      const [r, c] = cur.cell.split(',').map(Number);
      const at = { ...view, catPosition: { r, c } } as GameEngineState;
      for (const d of DIRECTIONS) {
        const moved = catMove(at, d);
        if (moved.catPosition.r === r && moved.catPosition.c === c) continue;
        const to = rc(moved.catPosition);
        if (push.get(to) !== step + 1) continue;
        const walk = { cell: to, tokens: [...cur.tokens, token(d)], cells: [...cur.cells, to] };
        if (to === target) return walk;
        if (seen.has(to)) continue;
        seen.add(to);
        next.push(walk);
      }
    }
    frontier = next;
    if (frontier.length === 0) return null;
  }
  return null;
}

/**
 * The counterfactual: the SAME formulas as production, with the cat-side arrival
 * features taken from an arbitrary arrival map (and, optionally, an engine-counted
 * mobility). `null` means "production walk values", which must reproduce the
 * production H1 total bit-exactly.
 */
function h1WithArrival(
  p: LeafProbe,
  arrival: Map<string, number> | null,
  mobility: number | null,
): { total: number; parts: Record<string, number>; feats: Record<string, number | null> } {
  const { leaf, bd } = p;
  const size = leaf.config.boardSize;
  const ctx = createEvaluationContext(leaf);
  const catArrival = arrival ?? ctx.catMap;

  // --- the five cat-side features, recomputed -------------------------------
  const catMouseDistance = catArrival.get(evaluationCellKey(leaf.mousePosition)) ?? null;
  const catReachableArea = catArrival.size;
  let catHoleGateDistance: number | null = null;
  for (const g of ctx.gateCells) {
    const d = catArrival.get(evaluationCellKey(g));
    if (d !== undefined && (catHoleGateDistance === null || d < catHoleGateDistance)) catHoleGateDistance = d;
  }
  const catMobility = mobility ?? bd.features.catMobility;
  // Voronoi v1 with the swapped cat side, mouse side untouched (evaluation.ts:458-480).
  let catControlled = 0;
  let mouseControlled = 0;
  let strategicArea = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const t = leaf.board[r][c].type;
      if (t === CellType.Tunnel || t === CellType.Box || t === CellType.Pile || t === CellType.Wall || t === CellType.Void) continue;
      const hole = leaf.config.mouseHole;
      if (r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size) continue;
      const cd = catArrival.get(evaluationCellKey({ r, c }));
      const md = ctx.mouseMap.get(evaluationCellKey({ r, c }));
      if (cd === undefined && md === undefined) continue;
      strategicArea++;
      if (cd !== undefined && md === undefined) catControlled++;
      else if (md !== undefined && cd === undefined) mouseControlled++;
      else if (cd !== undefined && md !== undefined) {
        if (cd < md) catControlled++;
        else if (md < cd) mouseControlled++;
      }
    }
  }
  const voronoiBalance = strategicArea > 0 ? (catControlled - mouseControlled) / strategicArea : 0;
  const mouseHoleGateDistance = bd.features.mouseHoleGateDistance;

  // --- the SAME contribution formulas (evaluation.ts:636-709) ---------------
  const parts: Record<string, number> = {
    capturePressure: catMouseDistance === null ? -W.capturePressure : -((catMouseDistance / size) * W.capturePressure),
    mouseGoalThreat: bd.contributions.mouseGoalThreat,
    butterRace: bd.contributions.butterRace,
    confinement: (catReachableArea / (size * size) - bd.features.mouseReachableArea / (size * size)) * W.confinement,
    mobility: ((catMobility - bd.features.mouseMobility) / 4) * W.mobility,
    trapControl: bd.contributions.trapControl,
    tunnelControl: bd.contributions.tunnelControl,
    holeControl: 0,
    voronoiBalance: voronoiBalance * W.voronoiBalance,
    tempo: bd.contributions.tempo,
  };
  // H1's corrected holeControl on top of the (possibly push-aware) gate distance.
  if (catHoleGateDistance !== null && mouseHoleGateDistance !== null) {
    parts.holeControl = Math.max(-1, Math.min(1, (mouseHoleGateDistance - catHoleGateDistance) / size)) * W.holeControl;
  } else if (catHoleGateDistance !== null) {
    parts.holeControl = W.holeControl; // cat reaches, mouse does not → full cat control
  } else if (mouseHoleGateDistance !== null) {
    parts.holeControl = -W.holeControl; // mouse reaches, cat does not → full mouse control
  }
  const sum = KEYS.reduce((acc, k) => acc + parts[k], 0);
  // Production applies HEURISTIC_LIMIT clamping to the total; mirror it or prove it
  // is not engaged at these states.
  expect(Math.abs(sum), 'these leaves stay inside the heuristic limit (no clamping to model)').toBeLessThan(1e8);
  return {
    total: sum,
    parts,
    feats: {
      catMouseDistance, catReachableArea, catHoleGateDistance, catMobility, mouseHoleGateDistance,
      catControlled, mouseControlled, strategicArea, voronoiBalance,
    },
  };
}

/** The cat's real one-step action count: the engine, not the walk graph, decides. */
function engineMobility(view: GameEngineState): number {
  return new Set(catActions(view).filter((a) => a.token !== 'P').map((a) => rc(a.state.catPosition))).size;
}

/** HV-7 B2's two arms: production walk features vs the static (optimistic) push map. */
function pushAwareH1(p: LeafProbe, usePush: boolean) {
  if (!usePush) return h1WithArrival(p, null, null);
  return h1WithArrival(p, buildCatPushDistanceMap(catView(p)), engineMobility(catView(p)));
}

/**
 * The affordable SOUND arrival model: a route whose ONLY push is its LAST step, so
 * the cat never walks a metre after its own box has drifted. Every claim it makes is
 * engine-verifiable; what it cannot do is price a route that needs two pushes, so it
 * is a lower bound on the cat's real capability rather than an exact distance.
 * Legality comes from the real `catMove`, never from a re-implemented rule.
 */
function onePushArrival(view: GameEngineState, walk: Map<string, number>): Map<string, number> {
  const out = new Map(walk);
  const size = view.config.boardSize;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (view.board[r][c].type !== CellType.Box) continue;
      for (const d of DIRECTIONS) {
        const from = { r: r - d.dr, c: c - d.dc };
        const fd = walk.get(rc(from));
        if (fd === undefined) continue;
        const at = { ...view, catPosition: from } as GameEngineState;
        if (rc(catMove(at, d).catPosition) !== `${r},${c}`) continue;
        const cell = `${r},${c}`;
        const cur = out.get(cell);
        if (cur === undefined || fd + 1 < cur) out.set(cell, fd + 1);
      }
    }
  }
  return out;
}

describe('PPC-HV-7 A — P0: the 741.61 gap, item by item', () => {
  it('HV7-A1: both plans execute legally and the H1 breakdown reconstructs the logged leaf values', () => {
    const root = h1Turn(4).state;
    const a = leafOf(root, ['U', 'U', 'U', 'R']);
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    expect(rc(a.leaf.catPosition), 'UUUR lands the cat on (2,2)').toBe('2,2');
    expect(rc(b.leaf.catPosition), 'RRRR lands the cat on (5,5)').toBe('5,5');

    for (const p of [a, b]) {
      const corrected = correctedHoleControlValue(p.bd, p.leaf.config.boardSize);
      const rows = KEYS.map((k) => [k, k === 'holeControl' ? corrected : p.bd.contributions[k]] as [string, number]);
      const sum = rows.reduce((acc, [, v]) => acc + v, 0);
      // The float-sum contract: the reconstruction must equal the production entry point.
      expect(p.h1, `${p.plan}: correctedHoleEvalTotal equals the production H1 leaf`).toBe(evaluateCorrectedHoleForCat(p.leaf));
      expect(Math.abs(sum - p.h1), `${p.plan}: the 10 items re-sum to the H1 total`).toBeLessThanOrEqual(1e-9);
      console.log(`HV7-A1 ${p.plan} @${rc(p.leaf.catPosition)}: ${rows.map(([k, v]) => `${k}=${v.toFixed(4)}`).join(' ')}`);
      console.log(`HV7-A1 ${p.plan}: baseline holeControl=${p.bd.contributions.holeControl.toFixed(4)} → H1 corrected=${corrected.toFixed(4)} (Δ ${(corrected - p.bd.contributions.holeControl).toFixed(4)}); H1 total=${p.h1}`);
    }
    expect(a.h1, 'UUUR reproduces the logged ArrowUp root value bit-exactly').toBe(-1736.7631578947369);

    const gap = a.h1 - b.h1;
    console.log(`HV7-A1 gap UUUR−RRRR = ${gap} (the round's 741.61)`);
    expect(gap).toBeGreaterThan(741);
    expect(gap).toBeLessThan(742);

    const rows = KEYS.map((k) => {
      const va = k === 'holeControl' ? correctedHoleControlValue(a.bd, a.leaf.config.boardSize) : a.bd.contributions[k];
      const vb = k === 'holeControl' ? correctedHoleControlValue(b.bd, b.leaf.config.boardSize) : b.bd.contributions[k];
      console.log(`HV7-A1  ${k.padEnd(16)} UUUR=${va.toFixed(4).padStart(12)}  RRRR=${vb.toFixed(4).padStart(12)}  Δ=${(va - vb).toFixed(4).padStart(12)}`);
      return va - vb;
    });
    expect(Math.abs(rows.reduce((x, y) => x + y, 0) - gap), 'the per-item deltas sum to the gap').toBeLessThanOrEqual(1e-9);

    const f = (p: LeafProbe, name: string) => console.log(`HV7-A1 features ${name}: ${JSON.stringify(p.bd.features)}`);
    f(a, 'UUUR');
    f(b, 'RRRR');
  });
});

describe('PPC-HV-7 B — P1: static walk BFS versus legal box pushes', () => {
  it('HV7-B1: the five cat-side features, static vs push-aware vs engine-proved', () => {
    const root = h1Turn(4).state;
    const a = leafOf(root, ['U', 'U', 'U', 'R']);
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    for (const p of [a, b]) {
      const ctx = createEvaluationContext(p.leaf);
      const push = buildCatPushDistanceMap(catView(p));
      const proved = marchComplete(catView(p), 12, 400_000);
      const gate = (map: Map<string, number>) => {
        let best: number | null = null;
        for (const g of ctx.gateCells) {
          const d = map.get(evaluationCellKey(g));
          if (d !== undefined && (best === null || d < best)) best = d;
        }
        return best;
      };
      const walkMouse = ctx.catMap.get(evaluationCellKey(p.leaf.mousePosition)) ?? null;
      const pushMouse = push.get(evaluationCellKey(p.leaf.mousePosition)) ?? null;
      const provedMouse = proved.dist.get(rc(p.leaf.mousePosition)) ?? null;
      const keyCell = '4,8';
      console.log(`HV7-B1 ${p.plan}: gates walk=${gate(ctx.catMap)} push=${gate(push)} proved=${gate(proved.dist)} | cat→mouse walk=${walkMouse} push=${pushMouse} proved=${provedMouse}`);
      console.log(`HV7-B1 ${p.plan}: reachable walk=${ctx.catMap.size} push=${push.size} proved=${proved.dist.size} (states=${proved.states}${proved.truncated ? ', TRUNCATED' : ', complete'}) | mobility walk=${p.bd.features.catMobility} engine=${catActions(catView(p)).filter((x) => x.token !== 'P').length}`);
      console.log(`HV7-B1 ${p.plan}: key cell ${keyCell} walk=${ctx.catMap.get(keyCell) ?? '∅'} push=${push.get(keyCell) ?? '∅'} proved=${proved.dist.get(keyCell) ?? '∅'}`);
      expect(proved.truncated, 'the prover finishes inside its node cap on this board').toBe(false);
    }
  });

  it('HV7-B2: the counterfactual — push-aware features, everything else identical', () => {
    const root = h1Turn(4).state;
    const a = leafOf(root, ['U', 'U', 'U', 'R']);
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    for (const p of [a, b]) {
      const asCopy = pushAwareH1(p, false);
      expect(Math.abs(asCopy.total - p.h1), `${p.plan}: the forensic copy reproduces production H1 bit-exactly with walk features`).toBeLessThanOrEqual(1e-9);
      const withPush = pushAwareH1(p, true);
      const swing = withPush.total - asCopy.total;
      const moved = KEYS.filter((k) => Math.abs(withPush.parts[k] - asCopy.parts[k]) > 1e-9);
      console.log(`HV7-B2 ${p.plan}: walk-model H1=${asCopy.total.toFixed(4)} push-model=${withPush.total.toFixed(4)} swing=${swing.toFixed(4)} over [${moved.join(',')}]`);
      for (const k of moved) console.log(`HV7-B2   ${k.padEnd(16)} ${asCopy.parts[k].toFixed(4)} → ${withPush.parts[k].toFixed(4)}`);
      console.log(`HV7-B2   feats walk=${JSON.stringify(asCopy.feats)} push=${JSON.stringify(withPush.feats)}`);
    }
    const wa = pushAwareH1(a, true).total;
    const wb = pushAwareH1(b, true).total;
    console.log(`HV7-B2 ranking: real H1 UUUR=${a.h1.toFixed(4)} RRRR=${b.h1.toFixed(4)} → pick ${a.h1 > b.h1 ? 'UUUR' : 'RRRR'}`);
    console.log(`HV7-B2 ranking: push-model UUUR=${wa.toFixed(4)} RRRR=${wb.toFixed(4)} → pick ${wa > wb ? 'UUUR' : 'RRRR'} (Δ ${(wa - wb).toFixed(4)})`);
  });

  it('HV7-B3: is the push map an exact reachability claim or an optimistic bound?', () => {
    const root = h1Turn(4).state;
    const MAX = 12;
    for (const tokens of [['U', 'U', 'U', 'R'], ['R', 'R', 'R', 'R']] as string[][]) {
      const p = leafOf(root, tokens);
      const view = catView(p);
      const push = buildCatPushDistanceMap(view);
      const t0 = performance.now();
      const proved = marchComplete(view, MAX, 400_000);
      const proverMs = performance.now() - t0;
      let agree = 0;
      let optimistic = 0;
      let falseReach = 0;
      let beyondDepth = 0;
      const notes: string[] = [];
      for (const [cell, d] of push) {
        // Fairness: the prover only proves arrivals at ≤ MAX steps. A push-map cell
        // deeper than MAX is UNVERIFIED, not a counterexample, and must not be
        // counted as a false reachability claim.
        if (d > MAX) { beyondDepth++; continue; }
        const e = proved.dist.get(cell);
        if (e === undefined) { falseReach++; notes.push(`${cell}@push${d}(unreachable)`); continue; }
        if (e === d) agree++;
        else { optimistic++; notes.push(`${cell}@push${d}<proved${e}`); }
        // The map is never PESSIMISTIC about a cell the engine can reach at ≤ MAX:
        // a miss there would be an under-credit, a different (and unobserved) defect.
        if (e !== undefined) expect(d, `${p.plan}: ${cell} push cost ≤ proved cost`).toBeLessThanOrEqual(e);
      }
      let provedOnly = 0;
      for (const [cell, e] of proved.dist) {
        const d = push.get(cell);
        if (d === undefined && e <= MAX) { provedOnly++; notes.push(`${cell}@proved${e}(map miss)`); }
      }
      console.log(`HV7-B3 ${p.plan}: pushCells=${push.size} agree=${agree} pushUnderestimates=${optimistic} pushClaimsUnreachable=${falseReach} deeperThanProver=${beyondDepth} provedButNotInPushMap=${provedOnly} | prover depth≤${MAX} states=${proved.states}${proved.truncated ? ', TRUNCATED' : ', complete'} in ${proverMs.toFixed(1)}ms`);
      console.log(`HV7-B3 ${p.plan} detail: ${notes.slice(0, 16).join(' ')}${notes.length > 16 ? ` …(${notes.length} total)` : ''}`);
      expect(provedOnly, `${p.plan}: the push map does not miss an arrival the engine can do within ${MAX}`).toBe(0);
    }
  });

  it('HV7-B4: replay the map witness path itself on the real engine', () => {
    // A step cost model over a FROZEN box layout may price a route the cat cannot
    // actually walk, because its own earlier pushes moved the boxes. This takes each
    // reachability claim the complete prover refutes, reads the map's own witness,
    // and hands that witness to the real step function. The round asks for exactly
    // this evidence (§五: 建立 Push Map 低估真实代价的负向测试 / §八-3 连续箱子假路径).
    const root = h1Turn(4).state;
    const MAX = 12;
    for (const tokens of [['U', 'U', 'U', 'R'], ['R', 'R', 'R', 'R']] as string[][]) {
      const p = leafOf(root, tokens);
      const view = catView(p);
      const push = buildCatPushDistanceMap(view);
      const proved = marchComplete(view, MAX, 400_000);
      const suspects: string[] = [];
      for (const [cell, d] of push) {
        if (d > MAX || proved.dist.has(cell)) continue;
        suspects.push(`${cell}@${d}`);
        const witness = mapWitness(view, push, cell);
        if (witness === null) {
          console.log(`HV7-B4 ${p.plan} ${cell}@push${d}: the map has no distance-consistent witness chain (internally inconsistent field)`);
          continue;
        }
        let s = view;
        let brokeAt = -1;
        for (let j = 0; j < witness.tokens.length; j++) {
          const dir = DIRECTIONS.find((x) => x.key.replace('Arrow', '').slice(0, 1) === witness.tokens[j])!;
          // Re-bank the budget exactly like `marchComplete`: the maps price steps
          // across turn boundaries, so a refusal caused by a spent 4-step bank would
          // be an artifact of the replay, not a property of the model.
          const moved = catMove({ ...s, catMovesLeft: s.config.catBaseMoves } as GameEngineState, dir);
          if (rc(moved.catPosition) === witness.cells[j + 1]) { s = moved; continue; }
          brokeAt = j;
          const [r, c] = witness.cells[j + 1].split(',').map(Number);
          const intended = witness.cells[j + 1];
          console.log(`HV7-B4 ${p.plan} ${cell}@push${d}: witness=${witness.tokens.join('')} breaks at step ${j + 1} into ${intended}: model sees ${view.board[r][c].type}${view.trapPosition && rc(view.trapPosition) === intended ? '+trap' : ''}, the board after the cat's own pushes sees ${s.board[r][c].type}${s.trapPosition && rc(s.trapPosition) === intended ? '+trap' : ''} (cat now ${rc(s.catPosition)}, butter there=${s.board[r][c].hasButter})`);
          break;
        }
        expect(brokeAt, `${p.plan}: if the engine follows the map's own witness to ${cell}, the prover — not the map — is wrong`).not.toBe(-1);
        expect(rc(s.catPosition), `${p.plan}: the replayed witness does not land the cat on ${cell}`).not.toBe(cell);
      }
      console.log(`HV7-B4 ${p.plan}: reachability claims the complete prover refutes = ${suspects.length} [${suspects.join(' ')}]`);
    }
  });
});

describe('PPC-HV-7 C — P3 pricing: which arrival model, and what exactness costs', () => {
  it('HV7-B5: four cat-arrival models, same formulas, same leaves', () => {
    const root = h1Turn(4).state;
    const a = leafOf(root, ['U', 'U', 'U', 'R']);
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const MAX = 12;
    const arms = ['walk (production H1)', '1-push-last (sound)', 'static push (optimistic)', `engine-proved (exact ≤${MAX})`];
    const totals: number[][] = [[], [], [], []];
    for (const p of [a, b]) {
      const view = catView(p);
      const ctx = createEvaluationContext(p.leaf);
      const exact = marchComplete(view, MAX, 400_000);
      const models = [
        null,
        onePushArrival(view, ctx.catMap),
        buildCatPushDistanceMap(view),
        exact.dist,
      ];
      for (const [m, arrival] of models.entries()) {
        const mobility = arrival === null ? null : engineMobility(catView(p));
        const r = h1WithArrival(p, arrival, mobility);
        totals[m].push(r.total);
        const f = r.feats;
        console.log(`HV7-B5 ${p.plan} arm=${arms[m]}: H1=${r.total.toFixed(4)} | mouseDist=${f.catMouseDistance} gates=${f.catHoleGateDistance} area=${f.catReachableArea} mobility=${f.catMobility} voronoi=${(f.voronoiBalance as number).toFixed(4)}`);
      }
      expect(exact.truncated, `${p.plan}: the exact arm is a complete proof, not a truncated search`).toBe(false);
    }
    for (const [m, col] of totals.entries()) {
      const [ua, ub] = [col[0]!, col[1]!];
      console.log(`HV7-B5 ranking arm=${arms[m].padEnd(26)} UUUR=${ua.toFixed(4)} RRRR=${ub.toFixed(4)} → pick ${ua > ub ? 'UUUR' : 'RRRR'} (Δ ${(ua - ub).toFixed(4)})`);
    }
    expect(totals[0]![1], 'the walk arm is production H1 at RRRR').toBe(b.h1);
    expect(totals[0]![0], 'the walk arm is production H1 at UUUR').toBe(a.h1);

    // Dismissed candidate, measured rather than argued: cap the walk-model
    // capturePressure at its own weight (−900) so an inflated maze distance cannot
    // bill beyond the term's declared scale. It narrows the gap; it does not close it.
    const cap = [-W.capturePressure, -W.capturePressure].map((_, i) => {
      const p = i === 0 ? a : b;
      const cp = h1WithArrival(p, null, null).parts.capturePressure;
      return totals[0]![i]! + (Math.max(cp, -W.capturePressure) - cp);
    });
    console.log(`HV7-B5 counterfactual clamp-only: UUUR=${cap[0]!.toFixed(4)} RRRR=${cap[1]!.toFixed(4)} → pick ${cap[0]! > cap[1]! ? 'UUUR' : 'RRRR'} (Δ ${(cap[0]! - cap[1]!).toFixed(4)}); it removes scale, not the model error`);
  });

  it('HV7-B6: cost of the exact arrival model versus the budget it would live in', () => {
    const root = h1Turn(4).state;
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const view = catView(b);
    let depth12Ms = 0;
    for (const depth of [2, 4, 6, 8, 10, 12]) {
      const t0 = performance.now();
      const proved = marchComplete(view, depth, 2_000_000);
      const ms = performance.now() - t0;
      if (depth === 12) depth12Ms = ms;
      console.log(`HV7-B6 RRRR prover depth=${depth}: states=${proved.states} cells=${proved.dist.size}${proved.truncated ? ' TRUNCATED' : ''} ${ms.toFixed(2)}ms/leaf → ${Math.round(ms * 409)}ms per 409-leaf turn`);
    }
    const leaf = b.leaf;
    const t1 = performance.now();
    for (let i = 0; i < 5_000; i++) evaluateCorrectedHoleForCat(leaf);
    const perLeafUs = ((performance.now() - t1) / 5_000) * 1000;
    const t2 = performance.now();
    for (let i = 0; i < 5_000; i++) buildCatPushDistanceMap(view);
    const pushUs = ((performance.now() - t2) / 5_000) * 1000;
    console.log(`HV7-B6 in-process instrument cost (NOT a timing authority): H1 leaf=${perLeafUs.toFixed(1)}µs  extra cat-push BFS=${pushUs.toFixed(1)}µs  exact prover@depth12=${depth12Ms.toFixed(1)}ms = ${(depth12Ms / perLeafUs).toFixed(0)}× a leaf`);
    expect(perLeafUs, 'the H1 leaf evaluator itself is the cheap part').toBeLessThan(5000);
  });
});

/**
 * The production board with every Box cell replaced by Empty. A DIAGNOSTIC clone used
 * only to answer "is the model disagreement caused by boxes at all?" — nothing is
 * scored from it in production, and no rule is changed.
 */
function withoutBoxes(s: GameEngineState): GameEngineState {
  return { ...s, board: s.board.map((row) => row.map((cell) => (cell.type === CellType.Box ? { ...cell, type: CellType.Empty } : cell))) };
}

/** A deterministic synthetic leaf, for the P2 counterexamples and the §8 controls. */
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

/** Column 7 walled except the single cell (8,7): the hole has exactly one entrance. */
const ONE_ENTRANCE = [[0, 7], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7], [9, 7]] as [number, number][];
const ALL_ENTRANCES_WALLED = [[0, 7], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7], [8, 7], [9, 7]] as [number, number][];

describe('PPC-HV-7 D — P2: do H1 and Gate Race judge the same interception oppositely?', () => {
  it('HV7-D1: two cat-arrival models, one interception opportunity', () => {
    const root = h1Turn(4).state;
    const a = leafOf(root, ['U', 'U', 'U', 'R']);
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const rows: { name: string; state: GameEngineState }[] = [
      { name: 'root', state: root },
      { name: 'UUUR leaf', state: a.leaf },
      { name: 'RRRR leaf', state: b.leaf },
    ];
    for (const row of rows) {
      const gr = computeGateRace(row.state);
      const ctx = createEvaluationContext(row.state);
      const push = buildCatPushDistanceMap(bank(row.state));
      const credited = gr.threats.flatMap((t) => t.layers.filter((l) => l.value > 0)).sort((x, y) => y.value - x.value);
      const best = credited[0] ?? null;
      const viaPush = credited.filter((l) => l.pushRequired || ctx.catMap.get(l.bestCell ?? '') === undefined);
      const bestNote = best
        ? ` | best layer=${best.step}:${best.bestCell}@cat${best.catSteps} (walk=${ctx.catMap.get(best.bestCell ?? '') ?? '∞'}, push=${push.get(best.bestCell ?? '') ?? '∞'}, mouseAt=${best.mouseArrival})`
        : '';
      console.log(`HV7-D1 ${row.name}: H1=${evaluateCorrectedHoleForCat(row.state).toFixed(4)} gateRace=${gr.contribution.toFixed(4)} (reason=${gr.reason} aggregate=${gr.aggregate === null ? 'null' : gr.aggregate.toFixed(4)} threats=${gr.threats.length} imminent=${gr.imminentOrigins.join('|')}) → combined=${(evaluateCorrectedHoleForCat(row.state) + gr.contribution).toFixed(4)}`);
      console.log(`HV7-D1 ${row.name}: credited layers=${credited.length} of which the walk map cannot reach / needs a push=${viaPush.length}${bestNote}`);
    }
  });

  it('HV7-D2: remove the boxes and the two models coincide (causality)', () => {
    const root = h1Turn(4).state;
    for (const tokens of [['U', 'U', 'U', 'R'], ['R', 'R', 'R', 'R']] as string[][]) {
      const p = leafOf(root, tokens);
      const boxFree = probeOf(`${p.plan}/noBox`, { ...p.end, ...withoutBoxes(p.end) } as GameEngineState);
      const walkArm = h1WithArrival(boxFree, null, null);
      const pushArm = h1WithArrival(boxFree, buildCatPushDistanceMap(catView(boxFree)), engineMobility(catView(boxFree)));
      const swing = pushArm.total - walkArm.total;
      console.log(`HV7-D2 ${p.plan}: with boxes removed walk=${walkArm.total.toFixed(4)} push=${pushArm.total.toFixed(4)} swing=${swing.toFixed(10)} (with boxes the swing was ${pushAwareH1(p, true).total - p.h1} )`);
      expect(Math.abs(swing), `${p.plan}: on a box-free board the push model is the walk model, so the whole swing is box-caused`).toBeLessThanOrEqual(1e-9);
    }
  });

  it('HV7-D3: one modelling error is billed by five H1 items', () => {
    const root = h1Turn(4).state;
    for (const tokens of [['U', 'U', 'U', 'R'], ['R', 'R', 'R', 'R']] as string[][]) {
      const p = leafOf(root, tokens);
      const walk = h1WithArrival(p, null, null);
      const push = h1WithArrival(p, buildCatPushDistanceMap(catView(p)), engineMobility(catView(p)));
      const moved = KEYS.filter((k) => Math.abs(push.parts[k] - walk.parts[k]) > 1e-9);
      const billed = moved.reduce((acc, k) => acc + (push.parts[k] - walk.parts[k]), 0);
      console.log(`HV7-D3 ${p.plan}: items fed by the cat arrival map and moved by it = [${moved.join(', ')}] (${moved.length}/10), total mis-billing ${billed.toFixed(4)}`);
      expect(moved, 'the walk map feeds exactly these five contributions').toEqual(expect.arrayContaining(
        tokens[0] === 'R'
          ? ['capturePressure', 'confinement', 'mobility', 'holeControl', 'voronoiBalance']
          : ['confinement', 'holeControl'],
      ));
    }
  });

  it('HV7-D4: turn endings the static model ranks below a legally better one', () => {
    const root = h1Turn(4).state;
    const endings: LeafProbe[] = [];
    for (const first of catActions(root).filter((x) => x.token !== 'P')) {
      const turn = enumerateCatTurnExact([{ state: first.state, plan: [first.token] }], 20_000);
      expect(turn.truncated, `the ${first.token} subtree fits the enumeration budget`).toBe(false);
      for (const e of turn.ends) endings.push(probeOf(e.plan.join(''), e.state));
    }
    const scored = endings.map((p) => {
      const walk = h1WithArrival(p, null, null).total;
      const push = h1WithArrival(p, buildCatPushDistanceMap(catView(p)), engineMobility(catView(p))).total;
      return { plan: p.plan, walk, push, delta: push - walk };
    });
    const byWalk = [...scored].sort((x, y) => y.walk - x.walk);
    const byPush = [...scored].sort((x, y) => y.push - x.push);
    const rankOfPushBest = byWalk.findIndex((s) => s.plan === byPush[0]!.plan);
    console.log(`HV7-D4 endings=${scored.length}: walk-best=${byWalk[0]!.plan}@${byWalk[0]!.walk.toFixed(4)}  push-best=${byPush[0]!.plan}@${byPush[0]!.push.toFixed(4)} (walk-score ${byWalk[rankOfPushBest]!.walk.toFixed(4)} → rank ${rankOfPushBest + 1})`);
    console.log(`HV7-D4 top5 byWalk: ${byWalk.slice(0, 5).map((s) => `${s.plan}=${s.walk.toFixed(1)}/${s.push.toFixed(1)}`).join(' ')} | top5 byPush: ${byPush.slice(0, 5).map((s) => `${s.plan}=${s.push.toFixed(1)}/${s.walk.toFixed(1)}`).join(' ')}`);
    // The winner of the optimistic model is then re-proved with the engine so the
    // sweep conclusion does not itself rest on an optimistic bound.
    const champ = endings.find((p) => p.plan === byPush[0]!.plan)!;
    const runnerUp = endings.find((p) => p.plan === byWalk[0]!.plan)!;
    for (const [tag, p] of [['push-best', champ], ['walk-best', runnerUp]] as [string, LeafProbe][]) {
      const exact = marchComplete(catView(p), 8, 400_000);
      const exactArm = h1WithArrival(p, exact.dist, engineMobility(catView(p)));
      console.log(`HV7-D4 ${tag}=${p.plan}: exact(≤8 steps, ${exact.states} states, complete=${!exact.truncated}) H1=${exactArm.total.toFixed(4)} | walk=${h1WithArrival(p, null, null).total.toFixed(4)} push=${h1WithArrival(p, buildCatPushDistanceMap(catView(p)), engineMobility(catView(p))).total.toFixed(4)}`);
      expect(exact.truncated, `${tag}: the exact arm stayed inside its node cap`).toBe(false);
    }
  });

  it('HV7-D5: a cat on the single entrance scores ZERO gate credit while an off-lane cat scores the maximum', () => {
    const held = synth({ cat: [8, 7], mouse: [8, 0], box: ONE_ENTRANCE, mouseHasButter: true });
    const offLane = synth({ cat: [7, 6], mouse: [8, 0], box: ONE_ENTRANCE, mouseHasButter: true });
    const sealed = synth({ cat: [7, 6], mouse: [8, 0], box: ALL_ENTRANCES_WALLED, mouseHasButter: true });

    expect(mouseCarryingDistanceToHole(held), 'the cat occupies the only entrance, so the carrying mouse has no route').toBeNull();
    expect(mouseCarryingDistanceToHole(sealed), 'a fully walled column also severs the route (rule check, not a model check)').toBeNull();
    expect(mouseCarryingDistanceToHole(offLane), 'with the entrance free, the carrying mouse does have a route').not.toBeNull();

    const terms = [
      { name: 'cat ON the chokepoint (route severed)', s: held },
      { name: 'cat beside the lane (route open)', s: offLane },
      { name: 'lane walled off by boxes (route severed)', s: sealed },
    ];
    for (const t of terms) {
      const gr = computeGateRace(t.s);
      const h1 = evaluateCorrectedHoleForCat(t.s);
      const f = evaluateForCatDetailed(t.s, DEFAULT_EVALUATION_WEIGHTS).features;
      console.log(`HV7-D5 ${t.name}: H1=${h1.toFixed(4)} (catGate=${f.catHoleGateDistance ?? '∞'} mouseGate=${f.mouseHoleGateDistance ?? '∞'} holeMargin=${f.holeControlMargin ?? '∞'}) gateRace=${gr.contribution.toFixed(4)} reason=${gr.reason} aggregate=${gr.aggregate === null ? 'null' : gr.aggregate.toFixed(3)} → combined=${(h1 + gr.contribution).toFixed(4)}`);
    }
    expect(computeGateRace(held).contribution, 'the strongest possible block — total severance by occupation — earns no gate credit').toBe(0);
    expect(computeGateRace(offLane).contribution, 'a weaker block that leaves the lane open does earn it').toBeGreaterThan(0);
  });
});

describe('PPC-HV-7 E — §8 reverse controls on the arrival models', () => {
  it('HV7-E1: a direct capture is never made to look farther by either model', () => {
    const s = synth({ cat: [5, 4], mouse: [5, 5], box: [[2, 2], [6, 6]] });
    const view = bank(s);
    const ctx = createEvaluationContext(s);
    const walk = ctx.catMap.get(evaluationCellKey(s.mousePosition)) ?? null;
    const push = buildCatPushDistanceMap(view).get(evaluationCellKey(s.mousePosition)) ?? null;
    const proved = marchComplete(view, 4, 200_000).dist.get(rc(s.mousePosition)) ?? null;
    console.log(`HV7-E1 cat ${rc(s.catPosition)} mouse ${rc(s.mousePosition)}: walk=${walk} push=${push} proved=${proved}`);
    expect(walk).toBe(1);
    expect(push).toBe(1);
    expect(proved).toBe(1);
  });

  it('HV7-E2: an unpushable box yields no fabricated arrival', () => {
    // (0,4) and (0,5) are boxes in the top row; (0,3) is a wall. Every push that
    // would land the cat on them needs an out-of-bounds or box-occupied destination.
    const s = synth({ cat: [1, 4], mouse: [4, 1], box: [[0, 4], [0, 5]], wall: [[0, 3]] });
    const view = bank(s);
    const push = buildCatPushDistanceMap(view);
    const proved = marchComplete(view, 6, 400_000);
    console.log(`HV7-E2 unpushable pair: push claims 0,4=${push.get('0,4') ?? '∅'} 0,5=${push.get('0,5') ?? '∅'} | proved 0,4=${proved.dist.get('0,4') ?? '∅'} 0,5=${proved.dist.get('0,5') ?? '∅'} (states=${proved.states}${proved.truncated ? ' TRUNCATED' : ''})`);
    expect(push.has('0,4'), 'the model may not invent a cell behind an unpushable box').toBe(false);
    expect(push.has('0,5'), 'the model may not invent a cell behind an unpushable box').toBe(false);
    expect(proved.dist.has('0,5')).toBe(false);
  });

  it('HV7-E3: two boxes in a lane — the static map prices a route the engine refuses', () => {
    // One-metre lane on row 8 (walls above and below), box at (8,1) and box at (8,3).
    // The map walks the cat through the cell its FIRST push vacated, then pushes the
    // second box into a cell the first box now occupies.
    const wall: [number, number][] = [];
    for (let c = 0; c <= 5; c++) { wall.push([7, c]); wall.push([9, c]); }
    const s = synth({ cat: [8, 0], mouse: [3, 3], box: [[8, 1], [8, 3]], wall });
    const view = bank(s);
    const push = buildCatPushDistanceMap(view);
    const proved = marchComplete(view, 6, 400_000);
    const lane = ['8,1', '8,2', '8,3', '8,4', '8,5'];
    const rows = lane.map((cell) => `${cell}: push=${push.get(cell) ?? '∅'} proved=${proved.dist.get(cell) ?? '∅'}`);
    console.log(`HV7-E3 two-box lane (states=${proved.states}${proved.truncated ? ' TRUNCATED' : ', complete'}): ${rows.join(' | ')}`);
    expect(proved.truncated).toBe(false);
    expect(push.get('8,2'), 'the frozen-layout map does claim the cell').toBeDefined();
    expect(proved.dist.has('8,2'), 'the real engine never gets the cat there: its own push parked a box against a second box').toBe(false);
    const witness = mapWitness(view, push, '8,2')!;
    expect(witness.tokens.join(''), 'the witness is one push then one walk step').toBe('RR');
  });

  it('HV7-E4: a held gate stays the better cell under the walk and exact models', () => {
    const onGate = synth({ cat: [8, 7], mouse: [8, 0], box: ONE_ENTRANCE, mouseHasButter: true });
    const offGate = synth({ cat: [7, 6], mouse: [8, 0], box: ONE_ENTRANCE, mouseHasButter: true });
    const arms: { name: string; value: (s: GameEngineState) => number }[] = [
      { name: 'walk (production H1)', value: (s) => evaluateCorrectedHoleForCat(s) },
      { name: 'static push (optimistic)', value: (s) => h1WithArrival(leafOfState('s', s), buildCatPushDistanceMap(bank(s)), engineMobility(bank(s))).total },
      { name: '1-push-last (sound)', value: (s) => h1WithArrival(leafOfState('s', s), onePushArrival(bank(s), createEvaluationContext(s).catMap), engineMobility(bank(s))).total },
      { name: 'engine-proved (exact ≤8)', value: (s) => h1WithArrival(leafOfState('s', s), marchComplete(bank(s), 8, 400_000).dist, engineMobility(bank(s))).total },
    ];
    let violations = 0;
    for (const arm of arms) {
      const on = arm.value(onGate);
      const off = arm.value(offGate);
      if (off > on) violations++;
      console.log(`HV7-E4 arm=${arm.name.padEnd(24)} onGate=${on.toFixed(4)} offGate=${off.toFixed(4)} → keeps the cat on the gate: ${on >= off ? 'YES' : 'NO'}`);
    }
    console.log(`HV7-E4 verdict: models that would pull the cat off a held gate = ${violations}/${arms.length}`);
    expect(violations, 'no arrival model may prefer abandoning a held single-cell gate').toBe(0);
  });

  it('HV7-E5: on a box-free board the two models are the same model', () => {
    const s = synth({ cat: [4, 4], mouse: [8, 1] });
    const view = bank(s);
    const ctx = createEvaluationContext(s);
    const push = buildCatPushDistanceMap(view);
    const diff: string[] = [];
    for (const [cell, d] of ctx.catMap) if (push.get(cell) !== d) diff.push(`${cell}: walk=${d} push=${push.get(cell) ?? '∅'}`);
    for (const [cell, d] of push) if (!ctx.catMap.has(cell)) diff.push(`${cell}: walk=∅ push=${d}`);
    expect(diff, 'identical cells and identical distances whenever there is nothing to push').toEqual([]);
    const p = leafOfState('boxfree', s);
    expect(h1WithArrival(p, push, engineMobility(view)).total, 'and therefore an identical H1 total').toBe(p.h1);
    expect(engineMobility(view), 'the engine action count equals the walk-neighbour count').toBe(p.bd.features.catMobility);
    console.log(`HV7-E5 box-free: cells=${ctx.catMap.size} identical, H1=${p.h1.toFixed(4)}, mobility=${p.bd.features.catMobility}`);
  });

  it('HV7-E6: the models one-step edge set is the engine step set, everywhere tested', () => {
    // The engine ALLOWS the cat to stand on its own trap (engine.ts:846-872 guards a
    // plain step by bounds/hole/tunnel/butter/pile/void/box, and only forbids a trap
    // as a PUSH DESTINATION), so the control is agreement with the step function —
    // not agreement with a guess about what the rules ought to say.
    const laneWall: [number, number][] = [];
    for (let c = 0; c <= 5; c++) { laneWall.push([7, c]); laneWall.push([9, c]); }
    const root = h1Turn(4).state;
    const cases: { name: string; s: GameEngineState }[] = [
      { name: 'T4 root', s: root },
      { name: 'UUUR leaf', s: leafOf(root, ['U', 'U', 'U', 'R']).leaf },
      { name: 'RRRR leaf', s: leafOf(root, ['R', 'R', 'R', 'R']).leaf },
      { name: 'trap fixture', s: synth({ cat: [5, 5], mouse: [5, 8], trap: [6, 6], box: [[5, 6], [7, 4]] }) },
      { name: 'two-box lane', s: synth({ cat: [8, 0], mouse: [3, 3], box: [[8, 1], [8, 3]], wall: laneWall }) },
    ];
    for (const c of cases) {
      const view = bank(c.s);
      const push = buildCatPushDistanceMap(view);
      const walk = createEvaluationContext(c.s).catMap;
      const engine = new Set(catActions(view).filter((a) => a.token !== 'P').map((a) => rc(a.state.catPosition)));
      const dist1 = new Set([...push.entries()].filter(([, d]) => d === 1).map(([cell]) => cell));
      const walk1 = new Set([...walk.entries()].filter(([, d]) => d === 1).map(([cell]) => cell));
      const missing = [...engine].filter((cell) => !dist1.has(cell));
      const invented = [...dist1].filter((cell) => !engine.has(cell));
      const walkInvented = [...walk1].filter((cell) => !engine.has(cell));
      console.log(`HV7-E6 ${c.name}: engineSteps=${engine.size} pushDist1=${dist1.size} walkDist1=${walk1.size} | engineNotPriced=${missing.join('|') || 'none'} pushInvented=${invented.join('|') || 'none'} walkInvented=${walkInvented.join('|') || 'none'}`);
      expect(missing, `${c.name}: every engine-legal step is priced as exactly one step`).toEqual([]);
      expect(invented, `${c.name}: the push model prices no step the engine refuses`).toEqual([]);
      expect(walkInvented, `${c.name}: the walk model prices no step the engine refuses`).toEqual([]);
      for (const k of ['7,8', '7,9', '8,8', '8,9']) {
        expect(push.has(k), `${c.name}: a mouse-hole cell is never a cat arrival (${k})`).toBe(false);
      }
    }
    const carrying = synth({ cat: [4, 4], mouse: [8, 0], box: ALL_ENTRANCES_WALLED, mouseHasButter: true });
    const idle = synth({ cat: [4, 4], mouse: [8, 0], box: ALL_ENTRANCES_WALLED, mouseHasButter: false });
    const idleTunnelEnterable = createEvaluationContext(idle).mouseMap.has('9,0');
    expect(mouseCarryingDistanceToHole(carrying), 'carrying: tunnels are not a way into the hole').toBeNull();
    expect(idleTunnelEnterable, 'not carrying: the corner tunnel IS enterable').toBe(true);
    expect(evaluateForCatDetailed(idle, DEFAULT_EVALUATION_WEIGHTS).features.mouseTunnelAllowed, 'and the evaluator records the tunnel as allowed').toBe(true);
    console.log(`HV7-E6 carrying/non-carrying tunnel boundary: carryingSevered=${mouseCarryingDistanceToHole(carrying) === null} idleTunnelEnterable=${idleTunnelEnterable}`);
  });

  it('HV7-E7: evaluation and forensics do not touch the state', () => {
    const root = h1Turn(4).state;
    const b = leafOf(root, ['R', 'R', 'R', 'R']);
    const targets: { name: string; run: (s: GameEngineState) => unknown }[] = [
      { name: 'H1 leaf', run: (s) => evaluateCorrectedHoleForCat(s) },
      { name: 'Gate Race term', run: (s) => computeGateRace(s) },
      { name: 'combined trial leaf', run: (s) => evaluateH1GateRaceForCat(s) },
      { name: 'push arrival map', run: (s) => buildCatPushDistanceMap(bank(s)) },
      { name: 'complete prover', run: (s) => marchComplete(bank(s), 6, 200_000) },
    ];
    for (const s of [root, b.leaf]) {
      const before = stateKey(s);
      for (const t of targets) {
        t.run(s);
        expect(stateKey(s), `${t.name} must not modify the state it scores`).toBe(before);
      }
      expect(stateKey(s), 'and the whole battery leaves it untouched too').toBe(before);
    }
    console.log(`HV7-E7 purity: ${targets.length} entry points × 2 states, stateKey unchanged`);
  });
});
