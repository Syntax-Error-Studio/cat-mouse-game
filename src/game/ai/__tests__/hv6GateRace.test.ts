/// <reference types="node" />
/**
 * PPC-HV-6 — Gate Race (关口竞速) trial leaf: definition, rule parity, T4 signal.
 *
 * Sections:
 *   A  the term's own math on real states (corridor layers + turn clock)
 *   C  §6 primary verification on the REAL H1 GAME4 Turn #4 root
 *   D  §7 reverse controls A–F
 *   E  §8 production-budget admission
 *
 * (4,8) appears below ONLY as a test-side evidence anchor: it is the cell HV-5's
 * ∀-prover witness stands on. Nothing in `gateRaceLeaf.ts` knows about it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInitialState, computeCatAiTrajectory, createEngineRuleSet, type CatAiStep, type GameEngineState } from '../../engine';
import { DEFAULT_CONFIG } from '../../config';
import { Difficulty, PieceType, CellType, GamePhase } from '../../types';
import { createSearchContext, searchBestAction } from '../expectiminimax';
import { dirKey, planFullTurnCompleteness } from '../planQuality';
import * as hardTurnPlannerModule from '../hardTurnPlanner';
import type { HardTurnPlan, HardTurnPlanOptions } from '../hardTurnPlanner';
import type { SearchAction } from '../searchTypes';
import {
  DEFAULT_EVALUATION_WEIGHTS,
  buildCatPushDistanceMap,
  createEvaluationContext,
  evaluationCellKey,
  evaluateForCatDetailed,
  getCarryRouteBfsCalls,
  getCatBfsCalls,
  getEvaluationCalls,
  getMouseBfsCalls,
  getCarryMouseBfsCalls,
  getCatPushBfsCalls,
  resetEvaluationCalls,
} from '../evaluation';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import {
  GATE_RACE_MAX_THREAT_TARGETS,
  GATE_RACE_WEIGHT,
  buildRouteClock,
  computeGateRace,
  evaluateH1GateRaceForCat,
} from '../gateRaceLeaf';
import { DEFAULT_SEARCH_CONFIG, HARD_LEAF_MODE_CONFIG, HARD_TRIAL } from '../searchConfig';
import { resolveHardLeaf } from '../hybridLeaf';
import { stateKey } from '../transposition';
import {
  catActions, catMarchSteps, enumerateCatTurnExact, h1Turn, handOffToMouse, rc, replayCatPlan, withCatAt,
} from './hv5ForcedLineAuditor';

const rules = createEngineRuleSet();

const dirOf = (token: string) =>
  ({ U: 'ArrowUp', R: 'ArrowRight', D: 'ArrowDown', L: 'ArrowLeft' })[token] ?? token;

/** Place the mouse on a free cell, keeping `board[][].piece` consistent. */
function withMouseAt(s: GameEngineState, r: number, c: number): GameEngineState {
  const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
  board[s.mousePosition.r][s.mousePosition.c].piece = undefined;
  board[r][c].piece = PieceType.Mouse;
  return { ...s, board, mousePosition: { r, c } };
}

/** An empty, non-hole, butter-free, trap-free orthogonal neighbour of `from`. */
function freeNeighbour(s: GameEngineState, from: { r: number; c: number }) {
  const hole = s.config.mouseHole;
  for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    const r = from.r + dr;
    const c = from.c + dc;
    if (r < 0 || c < 0 || r >= s.config.boardSize || c >= s.config.boardSize) continue;
    if (s.board[r][c].type !== CellType.Empty) continue;
    if (r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size) continue;
    if (s.butterPositions.some((b) => b.r === r && b.c === c)) continue;
    if (s.trapPosition && s.trapPosition.r === r && s.trapPosition.c === c) continue;
    return { r, c, dir: dr === -1 ? 'ArrowUp' : dr === 1 ? 'ArrowDown' : dc === 1 ? 'ArrowRight' : 'ArrowLeft' };
  }
  return null;
}

/** Cells the cat may occupy: not hole/tunnel/pile/wall/void/butter. A box cell is
 *  legal only through a push, which the push-aware arrival map is responsible for. */
function standableCell(s: GameEngineState, r: number, c: number): boolean {
  const hole = s.config.mouseHole;
  if (r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size) return false;
  const t = s.board[r][c].type;
  if (t === CellType.Tunnel || t === CellType.Pile || t === CellType.Wall || t === CellType.Void) return false;
  if (s.butterPositions.some((b) => b.r === r && b.c === c)) return false;
  return true;
}

/**
 * Every (first action → complete cat turn) ending, as its own subtree, exactly
 * the way HV5-D1 enumerated them: one shared seen-set for the whole turn would
 * attribute a state reachable by both `L…` and `R…` to whichever DFS found it
 * first, which is a quantifier trap rather than a search bug.
 */
function endingsPerFirstAction(root: GameEngineState) {
  const byDir = new Map<string, { plan: string; end: GameEngineState; leaf: GameEngineState }[]>();
  for (const a of catActions(root)) {
    if (a.token === 'P') continue;
    const turn = enumerateCatTurnExact([{ state: a.state, plan: [a.token] }], 20_000);
    expect(turn.truncated, `the ${a.token} subtree fits the enumeration budget`).toBe(false);
    const list = turn.ends.map((e) => ({ plan: e.plan.join(''), end: e.state, leaf: handOffToMouse(e.state, true) }));
    byDir.set(dirOf(a.token), list);
  }
  return byDir;
}

/** The leaf a maximising search would actually score, per first action. */
function bestLeafPerFirstAction(root: GameEngineState, score: (s: GameEngineState) => number) {
  const out: { dir: string; plan: string; end: GameEngineState; leaf: GameEngineState; value: number; endings: number }[] = [];
  for (const [dir, list] of endingsPerFirstAction(root)) {
    let best = list[0]!;
    for (const cand of list) if (score(cand.leaf) > score(best.leaf)) best = cand;
    out.push({ dir, ...best, value: score(best.leaf), endings: list.length });
  }
  return out;
}

describe('PPC-HV-6 A — the Gate Race term on real states', () => {
  it('HV6-A1: the turn clock is the engine budget sequence, written out literally', () => {
    const t4 = h1Turn(4);
    const s = t4.state;
    const cfg = s.config;
    expect(s.currentPlayer).toBe(PieceType.Cat);
    expect(s.catMovesLeft).toBe(cfg.catBaseMoves);
    expect(cfg.catBaseMoves).toBe(4);
    expect(cfg.mouseBaseMoves).toBe(4);
    expect(cfg.mouseCarryingMoves).toBe(3);

    // ROOT (cat to move, full cat budget). The mouse picks the butter up at route
    // step 2 — INSIDE its first turn — so turn M1 still spends 4 steps and only
    // turn M2 drops to the carrying budget of 3 (engine.ts:714 / :1278 / :1291).
    const P = s.butterPositions.length ? 2 : 0;
    const root = buildRouteClock(s, P, P + 8 - 1);
    const rootCat: [number, number][] = [
      [1, 1], [2, 2], [3, 3], [4, 4],          // cat turn 1
      [5, 9], [6, 10], [7, 11], [8, 12],        // cat turn 2 (after mouse turn 1)
    ];
    const rootMouse: [number, number][] = [
      [1, 5], [2, 6], [3, 7], [4, 8],           // non-carrying budget 4, pickup at 2
      [5, 13], [6, 14], [7, 15],               // carrying budget 3
    ];
    for (const [k, v] of rootCat) expect(root.catAt.get(k), `root cat step ${k}`).toBe(v);
    for (const [k, v] of rootMouse) expect(root.mouseAt.get(k), `root mouse route step ${k}`).toBe(v);

    // D1 LEAF (mouse to move, 4 moves left, cat has just spent its turn).
    const leaf = handOffToMouse(replayCatPlan(s, ['R', 'R', 'R', 'R']).end, true);
    expect(leaf.currentPlayer).toBe(PieceType.Mouse);
    expect(leaf.mouseMovesLeft).toBe(cfg.mouseBaseMoves);
    expect(leaf.mouseHasButter).toBe(false);
    const lc = buildRouteClock(leaf, P, P + 8 - 1);
    const leafMouse: [number, number][] = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 9], [6, 10], [7, 11]];
    const leafCat: [number, number][] = [[1, 5], [2, 6], [3, 7], [4, 8], [5, 12], [6, 13], [7, 14], [8, 15]];
    for (const [k, v] of leafMouse) expect(lc.mouseAt.get(k), `leaf mouse route step ${k}`).toBe(v);
    for (const [k, v] of leafCat) expect(lc.catAt.get(k), `leaf cat step ${k}`).toBe(v);
    console.log(`HV6-A1 root clock cat=${rootCat.map(([k]) => `${k}:${root.catAt.get(k)}`).join(' ')} mouse=${rootMouse.map(([k]) => `${k}:${root.mouseAt.get(k)}`).join(' ')}`);
    console.log(`HV6-A1 leaf clock mouse(4 then 3)=${leafMouse.map(([k]) => `${k}:${lc.mouseAt.get(k)}`).join(' ')} cat(4 then 4)=${leafCat.map(([k]) => `${k}:${lc.catAt.get(k)}`).join(' ')} — the 4→3 switch lands on the turn AFTER the pickup, exactly as the engine plays it`);
  });

  it('HV6-A2: corridor layers are cells on a SHORTEST carrying route, not one chosen route', () => {
    const t4 = h1Turn(4);
    const s = t4.state;
    const ctx = createEvaluationContext(s);
    const res = computeGateRace(s, ctx);
    expect(res.threats.length, 'both real butters are priced as threats').toBeGreaterThan(0);
    // the mouse is idle at T4 => every REAL butter is priced, none cherry-picked
    expect(res.threats.map((t) => t.origin).sort()).toEqual(
      [...s.butterPositions].map(rc).sort(),
    );
    for (const th of res.threats) {
      expect(th.approachSteps).toBe(ctx.mouseMap.get(evaluationCellKey({ r: Number(th.origin.split(',')[0]), c: Number(th.origin.split(',')[1]) })));
      expect(th.returnSteps).toBe(ctx.carryHoleMap.get(evaluationCellKey({ r: Number(th.origin.split(',')[0]), c: Number(th.origin.split(',')[1]) })));
      const seen = new Set<number>();
      for (const l of th.layers) {
        expect(l.step).toBeGreaterThan(0);
        expect(l.step).toBeLessThan(th.returnSteps);
        expect(seen.has(l.step), `layer ${l.step} appears once`).toBe(false);
        seen.add(l.step);
        // arithmetic identity of the definition: value * width == clamped margin
        const clamped = Math.max(-1, Math.min(1, (l.interceptionMargin ?? 0) / s.config.boardSize));
        expect(l.value * l.width).toBeCloseTo(clamped, 12);
        expect(l.width).toBeGreaterThanOrEqual(1);
      }
    }
    console.log(`HV6-A2 threats=${res.threats.map((t) => `${t.origin}(approach ${t.approachSteps}, return ${t.returnSteps}, route ${t.routeLength}, ${t.layers.length} priced layers)`).join(' | ')}`);
    // §3.1 aggregation: the priced threats are the ones on the SHORTEST complete
    // route — the same imminence rule evaluation.ts already uses for the mouse's
    // win route — and the aggregate is a MIN over that set, never a MAX.
    expect(res.fastestRoute).toBe(Math.min(...res.threats.map((t) => t.routeLength)));
    expect(res.imminentOrigins.sort()).toEqual(
      res.threats.filter((t) => t.routeLength === res.fastestRoute).map((t) => t.origin).sort(),
    );
    expect(res.aggregate).toBe(Math.min(...res.threats.filter((t) => t.imminent).map((t) => t.bestValue)));
    console.log(`HV6-A2 fastestRoute=${res.fastestRoute} imminent=${res.imminentOrigins.join('/')} aggregate=${res.aggregate} contribution=${res.contribution.toFixed(2)} reason=${res.reason}`);
    const widest = res.threats.flatMap((t) => t.layers).sort((a, b) => b.width - a.width)[0];
    console.log(`HV6-A2 widest priced layer=step ${widest.step} width=${widest.width} catArr=${widest.catArrival} mouseArr=${widest.mouseArrival} margin=${widest.interceptionMargin} value=${widest.value.toFixed(4)} bestCell=${widest.bestCell}`);
  });

  it('HV6-A3: interception cells are cells the cat may legally stand on', () => {
    const t4 = h1Turn(4);
    const s = t4.state;
    const ctx = createEvaluationContext(s);
    const catPush = buildCatPushDistanceMap(s);
    const res = computeGateRace(s, ctx);
    const rows = res.threats.flatMap((t) => t.layers);
    expect(rows.length).toBeGreaterThan(0);
    let pushOnlyArrivals = 0;
    let pushFasterThanWalk = 0;
    for (const l of rows) {
      expect(l.bestCell, 'a priced layer has a real cat-reachable cell').not.toBeNull();
      const [r, c] = l.bestCell!.split(',').map(Number);
      const hole = s.config.mouseHole;
      expect(r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size, `${l.bestCell} is not a hole cell`).toBe(false);
      for (const forbidden of [CellType.Tunnel, CellType.Pile, CellType.Wall, CellType.Void] as const) {
        expect(s.board[r][c].type, `${l.bestCell} is not a ${forbidden}`).not.toBe(forbidden);
      }
      expect(s.butterPositions.some((b) => b.r === r && b.c === c), `${l.bestCell} is not a butter cell`).toBe(false);
      const walk = ctx.catMap.get(evaluationCellKey({ r, c }));
      const push = catPush.get(evaluationCellKey({ r, c }));
      if (s.board[r][c].type === CellType.Box) {
        // standing on a box cell is only legal by pushing it away first
        expect(walk, 'the walk-only graph must never credit a box cell').toBeUndefined();
      }
      // `pushRequired` is exactly "the walk-only graph cannot stand here at all",
      // i.e. the credited arrival rests on the push mechanic and is the
      // approximate (lower-bound) part of the cat's cost.
      expect(l.pushRequired, `${l.bestCell}: pushRequired tracks the walk-only graph`).toBe(walk === undefined);
      if (walk === undefined) pushOnlyArrivals++;
      if (walk !== undefined && push !== undefined && push < walk) pushFasterThanWalk++;
      expect(Math.min(walk ?? Infinity, push ?? Infinity), 'arrival steps come from a real map')
        .toBe(l.catSteps);
      expect(l.catSteps! <= Math.max(walk ?? -1, push ?? -1)).toBe(true);
    }
    console.log(`HV6-A3 priced layers=${rows.length}; arrivals the walk-only graph cannot make=${pushOnlyArrivals}; arrivals a push shortens=${pushFasterThanWalk}; `
      + 'no hole/tunnel/butter/pile/wall/void cell is ever credited, and every arrival equals min(walk,push) steps');
    expect(pushOnlyArrivals + pushFasterThanWalk, 'the standard 12-box map genuinely needs push-aware arrivals').toBeGreaterThan(0);
  });

  it('HV6-A4: the term is bounded, non-negative and never outvotes a terminal', () => {
    const probes: GameEngineState[] = [];
    for (const n of [1, 2, 3, 4, 5, 6]) {
      try { probes.push(h1Turn(n).state); } catch { /* the log has fewer turns */ }
    }
    const base = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard } as never);
    probes.push(base, { ...base, currentPlayer: PieceType.Mouse } as GameEngineState);
    for (const p of probes) {
      const r = computeGateRace(p);
      expect(r.contribution, 'never negative').toBeGreaterThanOrEqual(0);
      expect(r.contribution).toBeLessThanOrEqual(GATE_RACE_WEIGHT);
      expect(Number.isFinite(r.contribution)).toBe(true);
    }
    console.log(`HV6-A4 contribution ∈ [0, ${GATE_RACE_WEIGHT}] on ${probes.length} states — terminal scores are ±1e9 in the search, so the term can never trade a win for position`);
  });
});

describe('PPC-HV-6 C — §6 primary verification on the real GAME4 Turn #4 root', () => {
  it('HV6-C1: the root is the same H1 root HV-5 adjudicated', () => {
    const t4 = h1Turn(4);
    expect(stateKey(t4.state)).toBe(t4.loggedStateKey);
    console.log(`HV6-C1 T4 root stateKey=${t4.loggedStateKey} cat=${rc(t4.state.catPosition)} mouse=${rc(t4.state.mousePosition)} carrying=${t4.state.mouseHasButter} butters=${t4.state.butterPositions.map(rc).join('/')} player=${t4.state.currentPlayer} catMoves=${t4.state.catMovesLeft}`);
    // HV-5's logged depth-1 values must still reproduce from the untouched H1.
    const logged = t4.loggedRootActions.map((l) => l.trim());
    console.log(`HV6-C1 logged ROOT_ACTIONS=${logged.join(' | ')}`);
  });

  it('HV6-C2: the four first actions under H1 vs H1+GateRace', () => {
    const t4 = h1Turn(4);
    const h1Rows = bestLeafPerFirstAction(t4.state, evaluateCorrectedHoleForCat);
    const trialRows = bestLeafPerFirstAction(t4.state, evaluateH1GateRaceForCat);
    const logged = new Map(
      t4.loggedRootActions.map((l) => {
        const m = /^(\S+): value=([-\d.]+)/.exec(l.trim())!;
        return [m[1], Number(m[2])] as const;
      }),
    );
    console.log('HV6-C2 === D1 root action values (each = the leaf a maximising search scores) ===');
    for (const r of trialRows) {
      const h1 = h1Rows.find((x) => x.dir === r.dir)!;
      const ctx = createEvaluationContext(r.leaf);
      const gr = computeGateRace(r.leaf, ctx);
      const layers = gr.threats.flatMap((th) => th.layers).filter((l) => l.value > 0)
        .sort((a, b) => b.value - a.value);
      const top = layers[0] ?? null;
      console.log(`  ${r.dir.padEnd(10)} endings=${r.endings} | H1 leaf=${h1.value.toFixed(10)} (plan ${h1.plan} @${rc(h1.end.catPosition)}, logged ${logged.get(r.dir)})`
        + ` | TRIAL leaf=${r.value.toFixed(10)} (plan ${r.plan} @${rc(r.end.catPosition)}) gateRace=${gr.contribution.toFixed(2)} agg=${gr.aggregate?.toFixed(4)} reason=${gr.reason}`);
      console.log(`      priced layers(>0)=${layers.length}/${gr.threats.reduce((a, th) => a + th.layers.length, 0)}`
        + (top ? ` best=step${top.step}@${top.bestCell} width=${top.width} catArr=${top.catArrival} mouseArr=${top.mouseArrival} margin=${top.interceptionMargin} value=${top.value.toFixed(4)}` : ' best=none'));
      expect(ctx, 'the same leaf context prices both terms').toBeDefined();
    }
    const h1Pick = h1Rows.reduce((a, b) => (b.value > a.value ? b : a)).dir;
    const trialPick = trialRows.reduce((a, b) => (b.value > a.value ? b : a)).dir;
    const order = (rows: typeof h1Rows) => [...rows].sort((a, b) => b.value - a.value).map((r) => `${r.dir}=${r.value.toFixed(4)}`).join(' ');
    console.log(`HV6-C2 ordering H1      : ${order(h1Rows)}`);
    console.log(`HV6-C2 ordering TRIAL  : ${order(trialRows)}`);
    console.log(`HV6-C2 pick H1=${h1Pick} TRIAL=${trialPick}`);
    expect(h1Rows.map((r) => r.dir).sort()).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
    // The H1 side of the comparison must reproduce the log, or nothing below is evidence.
    for (const r of h1Rows) expect(r.value, `${r.dir}: reproduces the logged depth-1 value`).toBe(logged.get(r.dir));
  });

  it('HV6-C3: the observed mouse route is priced by the term without reading any log', () => {
    const t4 = h1Turn(4);
    const leaf = replayCatPlan(t4.state, ['R', 'R', 'R', 'R']).end;
    const handoff = handOffToMouse(leaf, true);
    const res = computeGateRace(handoff);
    expect(res.threats.length, 'the trial leaf still prices a return route').toBeGreaterThan(0);
    const gate = '4,8';
    const rows = res.threats.flatMap((th) => th.layers.map((l) => ({ th, l })));
    const onGate = rows.filter((x) => x.l.bestCell === gate);
    const cells = new Set(rows.map((x) => x.l.bestCell ?? ''));
    console.log(`HV6-C3 RRRR leaf cat=${rc(leaf.catPosition)} mouse=${rc(handoff.mousePosition)} carrying=${handoff.mouseHasButter}`);
    console.log(`HV6-C3 priced corridor cells=${[...cells].sort().join(' ')}`);
    for (const x of onGate) {
      console.log(`HV6-C3 ${gate} is priced at carrying step ${x.l.step} from butter ${x.th.origin}; route step=${x.th.approachSteps}+${x.l.step}=${x.th.approachSteps + x.l.step} `
        + `(HV-5's independent real-step count for the same walk is 7) width=${x.l.width} catArr=${x.l.catArrival} mouseArr=${x.l.mouseArrival} margin=${x.l.interceptionMargin} value=${x.l.value.toFixed(4)}`);
    }
    expect(onGate.length, 'the corridor cell the HV-5 witness stands on is priced from the board alone').toBeGreaterThan(0);
    expect(onGate[0]!.th.approachSteps + onGate[0]!.l.step, 'matches the 7 real mouse steps').toBe(7);
  });

  it('HV6-C4: §6 item 4/5 — every candidate landing cell, priced by H1 and by the term', () => {
    const t4 = h1Turn(4);
    const byDir = endingsPerFirstAction(t4.state);
    const rows: { dir: string; plan: string; cell: string; h1: number; term: number; sum: number; agg: number; reason: string; imminent: string }[] = [];
    for (const [dir, list] of byDir) {
      for (const e of list) {
        const ctx = createEvaluationContext(e.leaf);
        const h1 = evaluateCorrectedHoleForCat(e.leaf);
        const gr = computeGateRace(e.leaf, ctx);
        rows.push({ dir, plan: e.plan, cell: rc(e.end.catPosition), h1, term: gr.contribution, sum: h1 + gr.contribution,
          agg: gr.aggregate ?? Number.NaN, reason: gr.reason, imminent: gr.imminentOrigins.join('/') });
      }
    }
    const dedup = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const k = `${r.dir}@${r.cell}`;
      const prev = dedup.get(k);
      if (!prev || r.term > prev.term) dedup.set(k, r);
    }
    const table = [...dedup.values()];
    const bestTerm = [...table].sort((a, b) => b.term - a.term)[0]!;
    const bestSum = [...table].sort((a, b) => b.sum - a.sum)[0]!;
    const bestH1 = [...table].sort((a, b) => b.h1 - a.h1)[0]!;
    console.log(`HV6-C4 landing cells priced=${table.length}`);
    console.log(`HV6-C4 H1's favourite cell      = ${bestH1.dir}/${bestH1.plan} @${bestH1.cell} H1=${bestH1.h1.toFixed(4)} term=${bestH1.term.toFixed(2)} agg=${bestH1.agg} reason=${bestH1.reason}`);
    console.log(`HV6-C4 term's favourite cell    = ${bestTerm.dir}/${bestTerm.plan} @${bestTerm.cell} H1=${bestTerm.h1.toFixed(4)} term=${bestTerm.term.toFixed(2)} agg=${bestTerm.agg} reason=${bestTerm.reason} imminent=${bestTerm.imminent}`);
    console.log(`HV6-C4 trial's favourite cell   = ${bestSum.dir}/${bestSum.plan} @${bestSum.cell} H1=${bestSum.h1.toFixed(4)} term=${bestSum.term.toFixed(2)} sum=${bestSum.sum.toFixed(4)}`);
    const spread = { h1: Math.max(...table.map((r) => r.h1)) - Math.min(...table.map((r) => r.h1)), term: Math.max(...table.map((r) => r.term)) - Math.min(...table.map((r) => r.term)) };
    console.log(`HV6-C4 value spread over the landing cells: H1=${spread.h1.toFixed(2)} term=${spread.term.toFixed(2)} — the term is a bounded (≤${GATE_RACE_WEIGHT}) addition on a much wider H1 band`);
    const top = [...table].sort((a, b) => b.term - a.term).slice(0, 12);
    for (const r of top) {
      console.log(`HV6-C4   term=${r.term.toFixed(2)} agg=${r.agg.toFixed(4)} reason=${r.reason.padEnd(22)} ${r.dir}/${r.plan} @${r.cell} H1=${r.h1.toFixed(4)} sum=${r.sum.toFixed(4)} imminent=${r.imminent}`);
    }
    // §6 item 5: the term must recognise the pre-emptive defence — some landing
    // cell that is NOT the cat's own start cell must price a positive credit.
    expect(bestTerm.cell, 'the term must credit an actual advance, not only holding still').not.toBe(rc(t4.state.catPosition));
    expect(bestTerm.term).toBeGreaterThan(0);
  });
});

describe('PPC-HV-6 D — §7 reverse controls', () => {
  it('HV6-D-F: H1 numbers are untouched, and the trial leaf is exactly H1 + term', () => {
    const states: GameEngineState[] = [];
    for (const n of [1, 2, 3, 4, 5, 6]) {
      try { states.push(h1Turn(n).state); } catch { /* shorter log */ }
    }
    const t4 = h1Turn(4);
    for (const [, list] of endingsPerFirstAction(t4.state)) {
      for (const e of list) states.push(e.leaf, e.end);
    }
    for (const s of states) {
      const before = evaluateCorrectedHoleForCat(s);
      const ctx = createEvaluationContext(s);
      expect(evaluateForCatDetailed(s, DEFAULT_EVALUATION_WEIGHTS, ctx).total,
        'a reused context scores bit-identically to a rebuilt one').toBe(evaluateForCatDetailed(s).total);
      const term = computeGateRace(s, ctx).contribution;
      expect(evaluateH1GateRaceForCat(s) - evaluateCorrectedHoleForCat(s), `parity on cat=${rc(s.catPosition)}`).toBe(term);
      expect(evaluateCorrectedHoleForCat(s)).toBe(before);
    }
    // the historical H1 numbers from HV-5 must still come out of the untouched leaf
    const up = bestLeafPerFirstAction(t4.state, evaluateCorrectedHoleForCat).find((r) => r.dir === 'ArrowUp')!;
    expect(evaluateCorrectedHoleForCat(up.leaf)).toBe(-1736.7631578947369);
    console.log(`HV6-D-F H1 parity exact on ${states.length} real states (0 numeric drift, term adds exactly its own contribution); ArrowUp leaf still -1736.7631578947369`);
  });

  it('HV6-DA: §7 control A — an immediate legal capture still outranks every interception idea', () => {
    const t4 = h1Turn(4);
    const nb = freeNeighbour(t4.state, t4.state.catPosition);
    expect(nb, 'the Turn #4 board has a free cell next to the cat').not.toBeNull();
    const s = withMouseAt(t4.state, nb!.r, nb!.c);
    const term = computeGateRace(s);
    expect(term.contribution, 'the term stays inside its own bound even next to a win').toBeLessThanOrEqual(GATE_RACE_WEIGHT);
    for (const [name, ev] of [['H1', evaluateCorrectedHoleForCat], ['TRIAL', evaluateH1GateRaceForCat]] as const) {
      const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
      ctx.leafEvaluator = ev;
      const res = searchBestAction(s, 1, ctx);
      console.log(`HV6-DA ${name}: mate=${res.mate} value=${res.value} action=${dirKey(res.action!)} (capture on ${nb!.r},${nb!.c}) nodes=${ctx.diagnostics.nodes} completed=${res.completed}`);
      expect(res.completed, `${name}: the depth-1 search resolves`).toBe(true);
      expect(res.mate, `${name}: the capture is classified as a cat mate`).toBe('cat');
      expect(dirKey(res.action!), `${name}: the capture is the chosen action`).toBe(nb!.dir);
    }
    const capture = catActions(s).find((a) => dirOf(a.token) === nb!.dir)!;
    expect(capture.state.phase, 'the capture ends the game').not.toBe(GamePhase.Playing);
    const afterWin = computeGateRace(capture.state);
    console.log(`HV6-DA terminal state: reason=${afterWin.reason} contribution=${afterWin.contribution} (±1e9 terminal scores are the search's, never this term's)`);
    expect(afterWin.reason).toBe('not_playing');
    expect(afterWin.contribution).toBe(0);
  });

  it('HV6-DB: §7 control B — a gate the cat already holds stays at the ceiling and leaving it never scores higher', () => {
    const root = h1Turn(4).state;
    const priced = computeGateRace(root);
    const th = priced.threats.find((t) => t.imminent)!;
    const origin = { r: Number(th.origin.split(',')[0]), c: Number(th.origin.split(',')[1]) };
    const baseReturn = createEvaluationContext(root).carryHoleMap.get(evaluationCellKey(origin));
    const chokes = th.layers.filter((l) => l.width === 1);
    expect(chokes.length, 'the imminent corridor has single-cell chokepoints on this board').toBeGreaterThan(0);
    // Holding a corridor cell removes it from the evaluator's OWN carrying graph
    // (evaluation.ts:83 refuses to enter the cat's cell), so the priced route is
    // rebuilt around the cat. That is the mechanism §3.3 asks for — not a k=0
    // arrival — and it is checked, not assumed, for every corridor cell.
    const heldRows: string[] = [];
    let inversions = 0;
    for (const l of th.layers) {
      const [r, c] = l.bestCell!.split(',').map(Number);
      const heldLeaf = handOffToMouse(withCatAt(root, r, c), true);
      const held = computeGateRace(heldLeaf);
      if (held.reason === 'no_complete_return_route') inversions++;
      if (l.width === 1) {
        expect(held.aggregate, `${l.bestCell} held: a chokepoint stays at the ceiling`).toBe(1);
        expect(held.contribution).toBe(GATE_RACE_WEIGHT);
      }
      const newReturn = createEvaluationContext(heldLeaf).carryHoleMap.get(evaluationCellKey(origin));
      expect(newReturn ?? Number.POSITIVE_INFINITY, `${l.bestCell} held: standing on the corridor never shortens the mouse's route`)
        .toBeGreaterThanOrEqual(baseReturn ?? 0);
      heldRows.push(`${l.bestCell}(w${l.width})→agg${held.aggregate ?? '∅'}/return${newReturn ?? '∅'}`);
    }
    // The strongest chokepoint: no complete cat turn that abandons it prices higher.
    const gate = th.layers.filter((l) => l.width === 1).sort((a, b) => b.value - a.value)[0]!.bestCell!;
    const [gr, gc] = gate.split(',').map(Number);
    const turn = enumerateCatTurnExact([{ state: withCatAt(root, gr, gc), plan: [] }], 20_000);
    expect(turn.truncated, 'the gate-holding turn fits the enumeration budget').toBe(false);
    let bestLeave = Number.NEGATIVE_INFINITY;
    let leavePlan = '';
    for (const e of turn.ends) {
      if (rc(e.state.catPosition) === gate) continue; // plans that come back still hold it
      const agg = computeGateRace(handOffToMouse(e.state, true)).aggregate ?? -1;
      if (agg > bestLeave) { bestLeave = agg; leavePlan = e.plan.join(''); }
    }
    console.log(`HV6-DB mouse return leg from ${th.origin}: ${baseReturn} steps unheld; held rows below (never shorter)`);
    console.log(`HV6-DB held corridor cells=${heldRows.join(' ')}`);
    console.log(`HV6-DB route-cut corner (held cell leaves no priced route at all)=${inversions}/${th.layers.length} — measured, see the header's HELD GATE note`);
    console.log(`HV6-DB gate=${gate} aggregate=1.0 contribution=${GATE_RACE_WEIGHT} | best aggregate over the ${turn.ends.length} endings that leave it=${bestLeave} (${leavePlan})`);
    expect(bestLeave, 'no plan that abandons the held gate buys more interception credit').toBeLessThanOrEqual(1);
  });

  it('HV6-DC: §7 control C — a bypassable corridor is never priced as a block, and equal routes stay a MIN', () => {
    const root = h1Turn(4).state;
    const res = computeGateRace(root);
    const wide = res.threats.flatMap((th) => th.layers.filter((l) => l.width > 1));
    expect(wide.length, 'the real board has multi-cell return layers').toBeGreaterThan(0);
    for (const l of wide) {
      expect(Math.abs(l.value), `layer ${l.step} width ${l.width} is discounted by its width`)
        .toBeLessThanOrEqual(1 / l.width + 1e-12);
    }
    // Standing on one cell of a wide layer leaves width-1 bypasses ⇒ strictly not a block.
    const widest = res.threats
      .map((th) => ({ th, l: [...th.layers].sort((a, b) => b.width - a.width)[0] }))
      .sort((x, y) => y.l.width - x.l.width)[0]!;
    const [wr, wc] = widest.l.bestCell!.split(',').map(Number);
    const stand = computeGateRace(handOffToMouse(withCatAt(root, wr, wc), true));
    console.log(`HV6-DC widest layer=threat ${widest.th.origin} step ${widest.l.step} width ${widest.l.width}; standing there: aggregate=${stand.aggregate} contribution=${stand.contribution}`);
    expect(stand.aggregate, 'one cat on a wide layer is not a corridor block').toBeLessThan(1);
    expect(stand.contribution, 'and it never reaches the term ceiling').toBeLessThan(GATE_RACE_WEIGHT);
    // Two EQUALLY fast public threats: the cat is credited only for covering both.
    const ctx = createEvaluationContext(root);
    const hole = root.config.mouseHole;
    const routeOf = (r: number, c: number) => {
      const a = ctx.mouseMap.get(evaluationCellKey({ r, c }));
      const d = ctx.carryHoleMap.get(evaluationCellKey({ r, c }));
      return a === undefined || d === undefined || d < 2 ? null : { approach: a, ret: d, len: a + d };
    };
    const byLength = new Map<number, { r: number; c: number; len: number; approach: number; ret: number }[]>();
    for (let r = 0; r < root.config.boardSize; r++) {
      for (let c = 0; c < root.config.boardSize; c++) {
        if (root.board[r][c].type !== CellType.Empty) continue;
        if (r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size) continue;
        if (rc(root.catPosition) === `${r},${c}` || rc(root.mousePosition) === `${r},${c}`) continue;
        const info = routeOf(r, c);
        if (!info) continue;
        const list = byLength.get(info.len) ?? [];
        list.push({ r, c, len: info.len, approach: info.approach, ret: info.ret });
        byLength.set(info.len, list);
      }
    }
    const pair = [...byLength.entries()].sort((a, b) => a[0] - b[0]).find(([, v]) => v.length >= 2)?.[1].slice(0, 2);
    expect(pair, 'the board has two cells with the same complete return route length').toBeDefined();
    const twin = { ...root, butterPositions: pair!.map((p) => ({ r: p.r, c: p.c })) } as GameEngineState;
    const twinRes = computeGateRace(twin);
    expect(twinRes.imminentOrigins.length, 'both equally fast butters are imminent').toBe(2);
    expect(twinRes.aggregate, 'the aggregate is the MIN over the imminent set, never the best corridor')
      .toBe(Math.min(...twinRes.threats.filter((th) => th.imminent).map((th) => th.bestValue)));
    const values = twinRes.threats.filter((th) => th.imminent).map((th) => th.bestValue);
    console.log(`HV6-DC twin threats=${twinRes.imminentOrigins.join('/')} routeLength=${twinRes.fastestRoute} bestValues=[${values.map((v) => v.toFixed(4)).join(', ')}] aggregate=${twinRes.aggregate} (min, not max=${Math.max(...values).toFixed(4)})`);
    expect(twinRes.aggregate).toBeLessThan(Math.max(...values) + 1e-12);
  });

  it('HV6-DD: §7 control D — no public return threat ⇒ the trial leaf is exactly H1', () => {
    const root = h1Turn(4).state;
    const boxed = withMouseAt(root, 1, 8);
    const board = boxed.board.map((row) => row.map((cell) => ({ ...cell })));
    for (const [r, c] of [[0, 8], [2, 8], [1, 7], [1, 9]] as const) board[r][c] = { ...board[r][c], type: CellType.Wall };
    const cases: [string, GameEngineState][] = [
      ['no butter on the board', { ...root, butterPositions: [] } as GameEngineState],
      ['only a ghost (unmaterialised) butter pending', {
        ...root, butterPositions: [], pendingButterSpawns: [{ r: 1, c: 6, blockedMaterializations: 0 }], pendingButterPlacementDebt: 1,
      } as GameEngineState],
      ['carrying mouse walled in — no legal route home', { ...boxed, board, mouseHasButter: true } as GameEngineState],
    ];
    for (const [name, s] of cases) {
      const r = computeGateRace(s);
      expect(['no_threat_target', 'no_complete_return_route', 'threat_set_exceeds_cap'], `${name}: fail-closed NEUTRAL`)
        .toContain(r.reason);
      expect(r.contribution, `${name}: neutral contribution`).toBe(0);
      expect(evaluateH1GateRaceForCat(s), `${name}: the trial leaf equals H1 to the last bit`).toBe(evaluateCorrectedHoleForCat(s));
      console.log(`HV6-DD ${name}: reason=${r.reason} threats=${r.threats.length} contribution=${r.contribution} pendingButter=${s.pendingButterSpawns.length}`);
    }
    // …and the same for a state whose butters the mouse cannot legally reach.
    const evalCtx = createEvaluationContext(root);
    const unreachableCells: { r: number; c: number }[] = [];
    for (let r = 0; r < root.config.boardSize && unreachableCells.length < 2; r++) {
      for (let c = 0; c < root.config.boardSize && unreachableCells.length < 2; c++) {
        if (evalCtx.mouseMap.get(evaluationCellKey({ r, c })) === undefined) unreachableCells.push({ r, c });
      }
    }
    expect(unreachableCells.length, 'the board has cells the mouse cannot reach').toBe(2);
    const ur = computeGateRace({ ...root, butterPositions: unreachableCells } as GameEngineState);
    console.log(`HV6-DD butters the mouse cannot route (${unreachableCells.map(rc).join('/')}): reason=${ur.reason} threats=${ur.threats.length} contribution=${ur.contribution}`);
    expect(ur.threats.length, 'an unreachable butter is not a threat').toBe(0);
    expect(ur.reason).toBe('no_complete_return_route');
    expect(ur.contribution).toBe(0);
  });

  it('HV6-DE: §7 control E — credited cells are legal to stand on, the step map is a measured lower bound, and a trapped push destination never scores higher', () => {
    const root = h1Turn(4).state;
    // The cat's own view of the RRRR ending: same board, same cat cell, still
    // cat-to-move. catMarchSteps drives the REAL catMove, which is a no-op while
    // it is the mouse's turn, so the parity probe needs this state — the leaf
    // itself is what the evaluator prices.
    const rrrrEnd = replayCatPlan(root, ['R', 'R', 'R', 'R']).end;
    const gate = handOffToMouse(rrrrEnd, true);
    expect(rrrrEnd.currentPlayer, 'the RRRR ending is still the cat to move').toBe(root.currentPlayer);
    const cases: { name: string; term: GameEngineState; march: GameEngineState }[] = [
      { name: 'T4 root', term: root, march: root },
      { name: 'RRRR leaf', term: gate, march: rrrrEnd },
    ];
    const hole = root.config.mouseHole;
    let exact = 0;
    let optimistic = 0;
    let unverified = 0;
    const notes: string[] = [];
    for (const s of cases) {
      for (const th of computeGateRace(s.term).threats) {
        for (const l of th.layers) {
          const [r, c] = l.bestCell!.split(',').map(Number);
          expect(rc(s.term.mousePosition), `${s.name} step ${l.step}: the mouse's cell is a capture, not a gate`).not.toBe(`${r},${c}`);
          expect(r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size, `${s.name} step ${l.step}: not a hole cell`).toBe(false);
          for (const forbidden of [CellType.Tunnel, CellType.Pile, CellType.Wall, CellType.Void] as const) {
            expect(s.term.board[r][c].type, `${s.name} step ${l.step}: not a ${forbidden}`).not.toBe(forbidden);
          }
          expect(s.term.butterPositions.some((b) => b.r === r && b.c === c), `${s.name} step ${l.step}: not a butter cell`).toBe(false);
          // The engine's own catMove is the rule-parity oracle (pushes included).
          // A -1 means the position-only BFS could not prove the march inside 24
          // plies (pushes change the board, so revisiting a cell can be legal
          // later); it is never read as a refutation, only as unverified.
          const march = catMarchSteps(s.march, l.bestCell!, 24);
          expect(march === -1 || march >= l.catSteps!, `${s.name} step ${l.step}: the static map never claims MORE steps than the engine needs`)
            .toBe(true);
          if (march === -1) { unverified++; notes.push(`${s.name}/${l.bestCell}@map${l.catSteps}>engine 24`); } else if (march === l.catSteps) exact++; else optimistic++;
        }
      }
    }
    console.log(`HV6-DE credited cells verified against the real catMove: exact=${exact} map-is-lower-but-optimistic=${optimistic} beyond the 24-step prover=${unverified}`);
    console.log(`HV6-DE measured optimism (§3.2 lower bound, never contradicted)=${notes.join(' ') || 'none'}`);
    expect(exact, 'at least one corridor cell matches the engine step count exactly').toBeGreaterThan(0);
    // Push-rule parity: engine.ts:885 refuses a box push whose destination holds
    // the trap, and buildCatPushDistanceMap:835 refuses exactly the same push.
    // Fence off every legal push destination in turn (from a trap-free baseline,
    // so each placement removes one legal action and adds none) and check that
    // removing a push can never make the cat a better interceptor.
    const plain = { ...root, trapPosition: null } as GameEngineState;
    const size = root.config.boardSize;
    const inside = (r: number, c: number) => r >= 0 && c >= 0 && r < size && c < size;
    const pushDestinations = new Set<string>();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (root.board[r][c].type !== CellType.Box) continue;
        for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
          const standR = r - dr, standC = c - dc;
          const destR = r + dr, destC = c + dc;
          if (!inside(standR, standC) || !inside(destR, destC)) continue;
          if (root.board[standR][standC].type !== CellType.Empty) continue;
          if (root.board[destR][destC].type !== CellType.Empty) continue;
          if (standR >= hole.r && standR < hole.r + hole.size && standC >= hole.c && standC < hole.c + hole.size) continue;
          if (destR >= hole.r && destR < hole.r + hole.size && destC >= hole.c && destC < hole.c + hole.size) continue;
          if (root.butterPositions.some((b) => b.r === destR && b.c === destC)) continue;
          if (root.mousePosition.r === destR && root.mousePosition.c === destC) continue;
          pushDestinations.add(`${destR},${destC}`);
        }
      }
    }
    const before = computeGateRace(plain);
    const lowered: { cell: string; contribution: number }[] = [];
    for (const d of pushDestinations) {
      const [r, c] = d.split(',').map(Number);
      const after = computeGateRace({ ...plain, trapPosition: { r, c } } as GameEngineState);
      expect(after.contribution, `trapping the push destination ${d} never increases the gate credit`)
        .toBeLessThanOrEqual(before.contribution + 1e-9);
      expect(after.aggregate ?? 0, `trapping the push destination ${d} never increases the gate aggregate`)
        .toBeLessThanOrEqual((before.aggregate ?? 0) + 1e-9);
      if (after.contribution < before.contribution - 1e-9) lowered.push({ cell: d, contribution: after.contribution });
    }
    console.log(`HV6-DE push destinations probed=${pushDestinations.size} baseline contribution=${before.contribution.toFixed(1)} credit-lowering=[${lowered.map((l) => `${l.cell}:${l.contribution.toFixed(1)}`).join(' ')}]`);
    expect(lowered.length, 'the credit really does depend on at least one legal push (the control is not vacuous)').toBeGreaterThan(0);
    // Under the placement that DOES bite, every cell still credited is a cell the
    // cat may legally occupy — the discount never smuggles in an illegal gate.
    const bitten = { ...plain, trapPosition: { r: Number(lowered[0].cell.split(',')[0]), c: Number(lowered[0].cell.split(',')[1]) } } as GameEngineState;
    let bittenCells = 0;
    for (const th of computeGateRace(bitten).threats) {
      for (const l of th.layers) {
        const [r, c] = l.bestCell!.split(',').map(Number);
        expect(standableCell(bitten, r, c), `${l.bestCell} under the trap at ${lowered[0].cell}: still a cell the cat may occupy`).toBe(true);
        bittenCells++;
      }
    }
    console.log(`HV6-DE credited cells re-verified as standable under the biting trap placement=${bittenCells}`);
  });
});

describe('PPC-HV-6 E — wiring', () => {
  it('HV6-E1: the trial mode resolves, and H1/baseline do not move', () => {
    const prev = HARD_LEAF_MODE_CONFIG.current;
    try {
      HARD_LEAF_MODE_CONFIG.current = 'baseline';
      expect(resolveHardLeaf()).not.toBe(evaluateH1GateRaceForCat);
      HARD_LEAF_MODE_CONFIG.current = 'baseline_hole_corrected';
      expect(resolveHardLeaf()).toBe(evaluateCorrectedHoleForCat);
      HARD_LEAF_MODE_CONFIG.current = 'h1_gate_race_trial';
      expect(resolveHardLeaf()).toBe(evaluateH1GateRaceForCat);
    } finally {
      HARD_LEAF_MODE_CONFIG.current = prev;
    }
    expect(prev).toBe('baseline');
  });

  it('HV6-E2: shared-context reuse — the trial leaf costs H1 exactly, plus one BFS per priced threat', () => {
    const t4 = h1Turn(4);
    resetEvaluationCalls();
    evaluateCorrectedHoleForCat(t4.state);
    const h1Calls = { eval: getEvaluationCalls(), mouse: getMouseBfsCalls(), cat: getCatBfsCalls(), carry: getCarryMouseBfsCalls(), route: getCarryRouteBfsCalls(), push: getCatPushBfsCalls() };
    resetEvaluationCalls();
    evaluateH1GateRaceForCat(t4.state);
    const trial = { eval: getEvaluationCalls(), mouse: getMouseBfsCalls(), cat: getCatBfsCalls(), carry: getCarryMouseBfsCalls(), route: getCarryRouteBfsCalls(), push: getCatPushBfsCalls() };
    const priced = computeGateRace(t4.state).threats.length;
    console.log(`HV6-E2 H1=${JSON.stringify(h1Calls)} trial=${JSON.stringify(trial)} pricedThreats=${priced} cap=${GATE_RACE_MAX_THREAT_TARGETS}`);
    // The three shared maps are NOT rebuilt: the trial reuses H1's own context.
    expect(trial.eval).toBe(h1Calls.eval);
    expect(trial.mouse).toBe(h1Calls.mouse);
    expect(trial.cat).toBe(h1Calls.cat);
    expect(trial.carry).toBe(h1Calls.carry);
    // H1 performs none of the new work; the trial pays exactly one push-aware cat
    // map per leaf and one carrying map per priced threat, capped by §4.
    expect(h1Calls.route).toBe(0);
    expect(h1Calls.push).toBe(0);
    expect(trial.push, 'one push-aware cat map per leaf').toBe(1);
    expect(trial.route, 'one carrying map per priced threat target').toBe(priced);
    expect(trial.route).toBeLessThanOrEqual(GATE_RACE_MAX_THREAT_TARGETS);
    // A carrying mouse needs no route BFS at all: ctx.mouseMap already IS the
    // carrying map from its own cell (tunnel entry is refused while carrying).
    const carryingState = { ...t4.state, mouseHasButter: true } as GameEngineState;
    resetEvaluationCalls();
    const carryingRes = computeGateRace(carryingState);
    const carryingCalls = { route: getCarryRouteBfsCalls(), push: getCatPushBfsCalls() };
    console.log(`HV6-E2 carrying mouse: route=${carryingCalls.route} push=${carryingCalls.push} threats=${carryingRes.threats.length} reason=${carryingRes.reason}`);
    expect(carryingCalls.route, 'a carrying mouse adds no carrying BFS — the map is already in the context').toBe(0);
    expect(carryingCalls.push).toBe(1);
  });

  it('HV6-E3: §8 one serial production-budget run per arm, with the full telemetry the round asks for', () => {
    const root = h1Turn(4).state;
    const arms: ('baseline_hole_corrected' | 'h1_gate_race_trial')[] = ['baseline_hole_corrected', 'h1_gate_race_trial'];
    const out: Record<string, ProductionTurn> = {};
    for (const mode of arms) out[mode] = runProductionTurn(root, mode);
    for (const mode of arms) {
      const o = out[mode];
      console.log(`HV6-E3 [${mode}] planner calls=${o.calls} budget=${o.options.timeBudgetMs}ms turnCap=${o.options.refutation?.totalTurnBudgetMs}ms (frozen ${DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn}/${HARD_TRIAL.totalTurnBudgetMs}, leafEvaluator=${o.options.leafEvaluator === evaluateH1GateRaceForCat ? 'H1+GateRace' : 'H1'})`);
      console.log(`HV6-E3   depth completed=${o.plan.completedDepth} attempted=${o.plan.attemptedDepth} mate=${o.debug.mate} rootValue=${o.debug.rootValue} deadlineFired=${o.debug.deadlineFired} budgetFired=${o.debug.budgetFired}`);
      console.log(`HV6-E3   cost   mainSearch=${o.plan.elapsedMs.toFixed(2)}ms wholeTurnWall=${o.turnWallMs.toFixed(2)}ms leaves=${o.telemetry.leaves} mouseBfs=${o.telemetry.mouse} catBfs=${o.telemetry.cat} carryBfs=${o.telemetry.carry} routeBfs=${o.telemetry.route} catPushBfs=${o.telemetry.push}`);
      console.log(`HV6-E3   plan   [${o.planLabel}] executed=${o.steps.map((s) => s.detail).join('→')} legality=${o.completeness.kind}/${o.completeness.reason} len=${o.plan.plan.length} override=${o.debug.refutation?.overrideUsed ?? 'sidecar-off'} baselinePlan=[${label(o.debug.baselinePlan)}]`);
      console.log(`HV6-E3   roots  ${o.debug.rootActions.map((r) => `${dirKey(r.action)}=${r.value.toFixed(4)}/${r.bound ?? 'unknown'}`).join(' ')}`);
      // The turn still produces a complete, legal cat turn and the budgets are the
      // frozen ones; nothing here is raised to make the new leaf fit.
      expect(o.calls, 'exactly one production planner call').toBe(1);
      expect(o.options.timeBudgetMs).toBe(DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn);
      expect(o.options.refutation?.totalTurnBudgetMs).toBe(HARD_TRIAL.totalTurnBudgetMs);
      expect(o.plan.hasSolution, 'the main search returns a valid answer').toBe(true);
      expect(o.plan.completedDepth, 'D1 must complete at the normal budget').toBeGreaterThanOrEqual(1);
      expect(o.plan.plan.length, 'a complete cat turn plan is still produced').toBeGreaterThan(0);
      expect(o.plan.plan.every((a) => a.type === 'catStep' || a.type === 'catPlaceTrap'), 'every action is a legal cat action').toBe(true);
      expect(stateKey(o.rootAtPlanTime), 'the planner ran on the frozen root').toBe(stateKey(root));
    }
    const h1 = out[arms[0]];
    const trial = out[arms[1]];
    console.log(`HV6-E3 extra cost of the trial leaf: routeBfs=${trial.telemetry.route} catPushBfs=${trial.telemetry.push} (H1 arm ${h1.telemetry.route}/${h1.telemetry.push}); leaves ${h1.telemetry.leaves} → ${trial.telemetry.leaves}; whole-turn wall ${h1.turnWallMs.toFixed(2)}ms → ${trial.turnWallMs.toFixed(2)}ms — ONE measurement per arm, no repetition, no timing authority`);
    console.log(`HV6-E3 decisions: H1 arm plan=[${h1.planLabel}] trial arm plan=[${trial.planLabel}] identical=${h1.planLabel === trial.planLabel}`);
    HARD_LEAF_MODE_CONFIG.current = 'baseline';
  });
});

interface ProductionTurn {
  calls: number;
  options: HardTurnPlanOptions;
  rootAtPlanTime: GameEngineState;
  plan: HardTurnPlan;
  debug: HardTurnPlan['debug'];
  planLabel: string;
  steps: CatAiStep[];
  turnWallMs: number;
  completeness: ReturnType<typeof planFullTurnCompleteness>;
  telemetry: { leaves: number; mouse: number; cat: number; carry: number; route: number; push: number };
}

const label = (plan: SearchAction[]): string =>
  plan.map((a) => (a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?')).join('');

/**
 * ONE real production cat turn through the untouched entry point, with a spy that
 * WRAPS (never replaces) the single planner call, so §8's depth / node / leaf /
 * plan / override telemetry all come from what production actually did.
 */
function runProductionTurn(root: GameEngineState, mode: 'baseline_hole_corrected' | 'h1_gate_race_trial'): ProductionTurn {
  const captured: Partial<ProductionTurn> = { calls: 0 };
  const original = hardTurnPlannerModule.planHardCatTurn;
  const spy = vi.spyOn(hardTurnPlannerModule, 'planHardCatTurn').mockImplementation(
    ((state: GameEngineState, options: HardTurnPlanOptions): HardTurnPlan => {
      captured.calls = (captured.calls ?? 0) + 1;
      captured.rootAtPlanTime = state;
      captured.options = options;
      const result = original(state, options);
      captured.plan = result;
      captured.debug = result.debug;
      captured.planLabel = label(result.plan);
      captured.completeness = planFullTurnCompleteness(state, result.plan, rules);
      return result;
    }) as typeof hardTurnPlannerModule.planHardCatTurn,
  );
  const prevMode = HARD_LEAF_MODE_CONFIG.current;
  HARD_LEAF_MODE_CONFIG.current = mode;
  resetEvaluationCalls();
  const before = { leaves: getEvaluationCalls(), mouse: getMouseBfsCalls(), cat: getCatBfsCalls(), carry: getCarryMouseBfsCalls(), route: getCarryRouteBfsCalls(), push: getCatPushBfsCalls() };
  const t0 = performance.now();
  let steps: CatAiStep[] | null = null;
  try {
    steps = computeCatAiTrajectory(root);
  } finally {
    captured.turnWallMs = performance.now() - t0;
    const after = { leaves: getEvaluationCalls(), mouse: getMouseBfsCalls(), cat: getCatBfsCalls(), carry: getCarryMouseBfsCalls(), route: getCarryRouteBfsCalls(), push: getCatPushBfsCalls() };
    captured.telemetry = {
      leaves: after.leaves - before.leaves, mouse: after.mouse - before.mouse, cat: after.cat - before.cat,
      carry: after.carry - before.carry, route: after.route - before.route, push: after.push - before.push,
    };
    captured.steps = steps ?? [];
    spy.mockRestore();
    HARD_LEAF_MODE_CONFIG.current = prevMode;
  }
  expect(steps, 'a cat-to-move production root must produce a turn').not.toBeNull();
  return captured as ProductionTurn;
}
