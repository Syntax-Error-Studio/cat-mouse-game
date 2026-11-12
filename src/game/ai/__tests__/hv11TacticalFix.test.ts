/// <reference types="node" />
/**
 * PPC-HV-11 — the correctness fixes to the HV-10 root-level tactical instrument, and the
 * production-seam question it must answer before anything is wired.
 *
 * INSTRUMENT ONLY, and more so than HV-10: no production file is edited this round. The
 * rules kernel, `evaluation.ts`, `correctedHoleLeaf.ts`, `gateRaceLeaf.ts`,
 * `expectiminimax.ts`, `hardTurnPlanner.ts`, the TT / Alpha-Beta / mate / bound machinery
 * and `planQuality.ts` are read, never written. `HARD_LEAF_MODE_CONFIG` stays
 * 'baseline_hole_corrected' in every test here: the Gate Race trial arm is not enabled and
 * this round does not enable it.
 *
 * SECTIONS
 *  A — §3 P0: the ordering is one lexicographic sweep, with the five statuses.
 *  B — §4 P1: does a cell the cat ALREADY stands on defend anything? Counterfactual proof.
 *  C — §5 P2: which cells are legal cat landings at all, and what the caps really bind.
 *  D — §6 P3: two headrooms, not one, and a median that is a real sample.
 *  E — §7 P4: is there a production seam that pays for this without a new budget?
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catMove, createEngineRuleSet, type GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType } from '../../types';
import { correctedHoleEvalTotal, evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { evaluateForCat, evaluateForCatDetailed } from '../evaluation';
import { computeGateRace, evaluateH1GateRaceForCat } from '../gateRaceLeaf';
import { planHardCatTurn, type HardTurnPlan } from '../hardTurnPlanner';
import { DEFAULT_SEARCH_CONFIG, HARD_TRIAL } from '../searchConfig';
import { stateKey } from '../transposition';
import { h1Turn, handOffToMouse, rc, withCatAt } from './hv5ForcedLineAuditor';
import {
  classifyCatTarget,
  DEFAULT_CAPS,
  headroomReport,
  pairedRuns,
  preferenceFromCells,
  proveHeldChoke,
  scoutRoot,
  tacticalPreference,
  type PreferenceCell,
  type PlanRow,
  type ScoutCaps,
} from './hv10RootScout';

const t4Root = (): GameEngineState => h1Turn(4).state;

const uncapped: ScoutCaps = { ...DEFAULT_CAPS, maxEndStates: 400, maxTargetsPerEnd: 32, maxCatMoveCalls: 1e9, maxHoldProofs: 400 };

/** A compared row with every field named, so a test can state one number and mean it. */
const cell = (key: string, over: Partial<PreferenceCell> = {}): PreferenceCell => ({
  key,
  plans: [key],
  scanned: true,
  timely: 0,
  chokeTimely: 0,
  uncovered: 0,
  held: 0,
  reachable: 0,
  ...over,
});

/** A cell the cat may stand on, orthogonally adjacent to the mouse (for the capture arm). */
function catPerchNextToMouse(s: GameEngineState): { r: number; c: number } | null {
  const hole = s.config.mouseHole;
  for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    const r = s.mousePosition.r + dr;
    const c = s.mousePosition.c + dc;
    if (r < 0 || c < 0 || r >= s.config.boardSize || c >= s.config.boardSize) continue;
    if (r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size) continue;
    if (s.board[r][c].type !== CellType.Empty) continue;
    return { r, c };
  }
  return null;
}

/** The production key of a state whose box layout differs — used by A8 only. */
function moveOneBox(s: GameEngineState): GameEngineState | null {
  const size = s.config.boardSize;
  const board = s.board.map((row) => row.map((c) => ({ ...c })));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c + 1 < size; c++) {
      if (board[r][c].type !== CellType.Box) continue;
      if (board[r][c + 1].type !== CellType.Empty) continue;
      board[r][c].type = CellType.Empty;
      board[r][c + 1].type = CellType.Box;
      return { ...s, board };
    }
  }
  return null;
}

describe('PPC-HV-11 A — §3 P0: the preference is one lexicographic sweep', () => {
  it('HV11-A1: the round-book counterexample — A has chokeTimely 3 / uncovered 2, B has 1 / 0, and A wins', () => {
    const a = cell('KEY-A', { plans: ['UUUU'], chokeTimely: 3, timely: 9, uncovered: 2, reachable: 12, held: 0 });
    const b = cell('KEY-B', { plans: ['RRRR'], chokeTimely: 1, timely: 1, uncovered: 0, reachable: 6, held: 1 });
    const forward = preferenceFromCells([a, b]);
    const reversed = preferenceFromCells([b, a]);
    console.log(`HV11-A1 forward: status=${forward.status} best=[${forward.best.join(' ')}] - ${forward.reason}`);
    console.log(`HV11-A1 reversed: best=[${reversed.best.join(' ')}] status=${reversed.status}`);
    // The contract says chokeTimely FIRST. B is better on the SECOND key; that does not
    // entitle it to the answer, and it must not empty the answer either.
    expect(forward.best, 'chokeTimely is the first key, so the row with 3 wins').toEqual(['UUUU']);
    expect(forward.status, 'and both rows were scanned, so this is a full comparison').toBe('FULL_PREFERENCE');
    expect(forward.separates, 'the two rows do differ on a contract key').toBe(true);
    expect(reversed.best, 'input order cannot move the winner').toEqual(['UUUU']);
    expect(reversed.status, 'and cannot move the status').toBe('FULL_PREFERENCE');
    expect(forward.ranking.map((r) => r.key), 'the ranking uses the same relation').toEqual(['KEY-A', 'KEY-B']);
  });

  it('HV11-A2: the old shape — the key-1 winner and the key-2 winner were different rows', () => {
    // The defect HV-11 §3 names: max(chokeTimely) and min(uncovered) were taken as two
    // separate maxima and intersected, and the minimum was seeded with 0 — so on any root
    // where no row has uncovered = 0 the intersection was empty and the table answered [].
    const rows = [cell('K1', { chokeTimely: 3, uncovered: 2 }), cell('K2', { chokeTimely: 2, uncovered: 5 }), cell('K3', { chokeTimely: 1, uncovered: 3 })];
    const maxChoke = rows.reduce((m, r) => Math.max(m, r.chokeTimely), 0);
    const minUncovered = rows.reduce((m, r) => Math.min(m, r.uncovered), 0);
    const oldBest = rows.filter((r) => r.chokeTimely === maxChoke && r.uncovered === minUncovered);
    const out = preferenceFromCells(rows);
    console.log(`HV11-A2 old filter recomputed: maxChoke=${maxChoke} minUncovered=${minUncovered} survivors=${oldBest.length} — the old code seeded the minimum with 0, so an empty answer here was guaranteed`);
    console.log(`HV11-A2 new sweep: status=${out.status} best=[${out.best.join(' ')}] - ${out.reason}`);
    expect(oldBest.length, 'this input is exactly the case that used to answer nothing').toBe(0);
    expect(out.best.length, 'the lexicographic sweep answers with the first-key winner').toBe(1);
    expect(out.best[0]).toBe('K1');
    expect(out.ranking.map((r) => r.key), 'and the ranking is a total order, not a filter').toEqual(['K1', 'K2', 'K3']);
  });

  it('HV11-A3: every row NOT_SCANNED is an explicit NO_PREFERENCE', () => {
    const rows = [cell('U1', { scanned: false }), cell('U2', { scanned: false })];
    const out = preferenceFromCells(rows);
    console.log(`HV11-A3 all-UNKNOWN: status=${out.status} best=[${out.best.join(' ')}] scanned=${out.scannedEndStates} unscanned=[${out.unscannedEndStates.join(' ')}] - ${out.reason}`);
    expect(out.status, 'nothing was compared, so nothing is preferred').toBe('NO_PREFERENCE');
    expect(out.best, 'and the best set is empty — empty here means UNKNOWN, not loser').toEqual([]);
    expect(out.scannedEndStates).toBe(0);
    expect(out.unscannedEndStates, 'every key is listed as unscanned').toEqual(['U1', 'U2']);
    expect(out.reason, 'the reason names the absence as UNKNOWN').toContain('UNKNOWN');
  });

  it('HV11-A4: a partial scan says PARTIAL_PREFERENCE and cannot present itself as the global optimum', () => {
    const rows = [cell('S1', { plans: ['RRRR'], chokeTimely: 3, uncovered: 2 }), cell('S2', { plans: ['UUUU'], chokeTimely: 1, uncovered: 0 }), cell('X1', { scanned: false, plans: ['DDDD'] })];
    const out = preferenceFromCells(rows);
    console.log(`HV11-A4 partial: status=${out.status} best=[${out.best.join(' ')}] scanned=${out.scannedEndStates}/${rows.length} unscanned=[${out.unscannedEndStates.join(' ')}]`);
    console.log(`HV11-A4 reason: ${out.reason}`);
    expect(out.status, 'one UNKNOWN row makes the whole answer a statement about a subset').toBe('PARTIAL_PREFERENCE');
    expect(out.best.join(' '), 'the scanned comparison still runs, and its first key still decides').toBe('RRRR');
    expect(out.unscannedEndStates, 'and the unscanned key is named, not silently dropped').toEqual(['X1']);
    expect(out.reason, 'the reason says the answer is not the global best').toContain('never the global best');
    expect(out.ranking.some((r) => r.key === 'X1' && !r.scanned), 'the UNKNOWN row stays in the table').toBe(true);
    // An unscanned row has no evidence, so it has no claim: it must not be able to win.
    const favourUnknown = preferenceFromCells([cell('S3', { plans: ['LLL'], chokeTimely: 0, uncovered: 9 }), cell('X2', { scanned: false, plans: ['DDD'] })]);
    console.log(`HV11-A4 one scanned + one UNKNOWN: status=${favourUnknown.status} best=[${favourUnknown.best.join(' ')}] - ${favourUnknown.reason}`);
    expect(favourUnknown.best, 'a scanned row with nothing timely still beats a row that was never read').toEqual(['LLL']);
    expect(favourUnknown.status, 'and with nothing to compare it to, the answer is a subset statement, not a preference').toBe('PARTIAL_NO_SEPARATION');
    expect(favourUnknown.reason, 'the reason says the subset explicitly').toContain('PARTIAL');
  });

  it('HV11-A5: a complete scan with no timely interception does not manufacture an advantage', () => {
    const rows = [cell('N1', { plans: ['AAAA'], chokeTimely: 0, uncovered: 1, reachable: 5, held: 1 }), cell('N2', { plans: ['BBBB'], chokeTimely: 0, uncovered: 1 })];
    const out = preferenceFromCells(rows);
    console.log(`HV11-A5 no separation: status=${out.status} separates=${out.separates} best=[${out.best.join(' ')}] - ${out.reason}`);
    expect(out.status, 'no row is timely on a choke and both leave the same route open').toBe('NO_TACTICAL_SEPARATION');
    expect(out.separates, 'so the table does not claim a winner').toBe(false);
    expect(out.best, 'the tie is listed in full rather than broken by a key or a diagnostic').toEqual(['AAAA', 'BBBB']);
    expect(out.ranking.map((r) => r.key), 'the key orders the REPORT only').toEqual(['N1', 'N2']);
    expect(out.reason, 'and the reason says no advantage is claimed').toContain('no tactical advantage is claimed');
  });

  it('HV11-A6: a legal immediate capture always outranks the defensive table', () => {
    const root = t4Root();
    const perch = catPerchNextToMouse(root)!;
    const scan = scoutRoot(withCatAt(root, perch.r, perch.c), uncapped);
    const out = tacticalPreference(scan.plans);
    console.log(`HV11-A6 SYNTHETIC perch cat=${rc(perch)} (the real T4 root has no in-turn capture): plans=${scan.stats.totalPlans} captures=${scan.stats.captures} best=[${out.best.join(' ')}] - ${out.reason}`);
    expect(scan.stats.captures, 'the enumeration must separate the winning plans').toBeGreaterThan(0);
    expect(out.status, 'a terminal win is not a comparison, it is the answer').toBe('IMMEDIATE_CAPTURE_PRIORITY');
    expect(out.ranking, 'no defensive row is ranked against it').toEqual([]);
    expect(out.immediateCapture.length, 'every legal capture plan is listed').toBe(scan.stats.captures);
    expect(out.best, 'and the best set is exactly the capture set').toEqual(out.immediateCapture);
  });

  it('HV11-A7: held and reachable are DIAGNOSTIC fields — the doc and the code now agree', () => {
    const againstChoke = preferenceFromCells([cell('H1', { plans: ['HOLD'], chokeTimely: 0, uncovered: 1, held: 1, reachable: 9 }), cell('H2', { plans: ['CHOKE'], chokeTimely: 2, uncovered: 4 })]);
    console.log(`HV11-A7 held=1 reachable=9 vs chokeTimely=2 uncovered=4: best=[${againstChoke.best.join(' ')}] status=${againstChoke.status}`);
    expect(againstChoke.best, 'the proven choke interception wins although it is worse on both diagnostics and on the second key').toEqual(['CHOKE']);
    const tieByDiag = preferenceFromCells([cell('D1', { plans: ['P1'], chokeTimely: 2, uncovered: 1, held: 1, reachable: 8 }), cell('D2', { plans: ['P2'], chokeTimely: 2, uncovered: 1 })]);
    expect(tieByDiag.status, 'two rows equal on the contract keys stay a tie').toBe('NO_TACTICAL_SEPARATION');
    expect(tieByDiag.best, 'neither held nor reachable breaks it').toEqual(['P1', 'P2']);
    const keyOrder = preferenceFromCells([cell('b', { plans: ['B'] }), cell('a', { plans: ['A'] })]);
    expect(keyOrder.ranking.map((r) => r.key), 'the key orders the report deterministically').toEqual(['a', 'b']);
    expect(keyOrder.best, 'but never decides who is preferred').toEqual(['A', 'B']);
  });

  it('HV11-A8: the table groups by FULL state key, so a different box layout is a different position', () => {
    const scan = scoutRoot(t4Root(), uncapped);
    const plans = scan.plans.filter((p) => p.kind !== 'capture');
    const keys = new Set(plans.map((p) => p.endStateKey));
    const positions = new Set(plans.map((p) => p.endPosition));
    const out = tacticalPreference(plans);
    console.log(`HV11-A8 plans=${plans.length} distinct end states=${keys.size} distinct cat cells=${positions.size} ranking=${out.ranking.length} status=${out.status} best=[${out.best.join(' ')}]`);
    expect(out.ranking.length, 'one ranking entry per distinct FULL state key, never per cat cell').toBe(keys.size);
    expect(out.scannedEndStates, 'the caps did not bind on this uncapped scan').toBe(keys.size);
    // The §3 requirement stated as a construction: the same cat cell over a different box
    // layout is a different row. The key is production `stateKey`, so the split is real.
    const pushed = plans.find((p) => p.boxesMoved > 0 && p.row.scanned);
    expect(pushed, 'this root must contain at least one plan that moved a box').toBeDefined();
    const moved = moveOneBox(pushed!.endState);
    expect(moved, 'and a free neighbour cell to move a box into').not.toBeNull();
    const key2 = stateKey(handOffToMouse(moved!, true));
    expect(rc(moved!.catPosition), 'the cat cell is unchanged').toBe(pushed!.endPosition);
    expect(key2 === pushed!.endStateKey, 'the production key does change with the box layout').toBe(false);
    const twin: PlanRow = { ...pushed!, endState: moved!, endStateKey: key2 };
    const pairRows = tacticalPreference([pushed!, twin]);
    console.log(`HV11-A8 same cell ${pushed!.endPosition} over two box layouts: ranking=${pairRows.ranking.length} status=${pairRows.status}`);
    expect(pairRows.ranking.length, 'and the table keeps them as two positions').toBe(2);
    expect(pairRows.scannedEndStates).toBe(2);
    expect(positions.size, 'the root itself has plans landing on shared cells (the full key is what separates them)').toBeLessThanOrEqual(keys.size);
  });

  it('HV11-A9: the real root under a binding cap cannot claim a global optimum', () => {
    const scan = scoutRoot(t4Root(), { ...DEFAULT_CAPS, maxEndStates: 3 });
    const out = tacticalPreference(scan.plans);
    console.log(`HV11-A9 maxEndStates=3: scanned=${out.scannedEndStates} unscanned=${out.unscannedEndStates.length} status=${out.status} separates=${out.separates} best=[${out.best.join(' ')}]`);
    console.log(`HV11-A9 reason: ${out.reason}`);
    expect(scan.stats.notScannedEndStates, 'the caps left end states unscanned').toBeGreaterThan(0);
    expect(out.unscannedEndStates.length, 'and the preference names each of them').toBe(scan.stats.notScannedEndStates);
    expect(out.status === 'FULL_PREFERENCE', 'a truncated scan is never presented as a full comparison').toBe(false);
    expect(['PARTIAL_PREFERENCE', 'PARTIAL_NO_SEPARATION'].includes(out.status), 'it is either a subset preference or an explicit subset no-separation').toBe(true);
    const unscanned = new Set(out.unscannedEndStates);
    expect(out.ranking.filter((r) => unscanned.has(r.key)).every((r) => r.plans.every((p) => !out.best.includes(p))), 'no NOT_SCANNED row appears in best').toBe(true);
    expect(out.ranking.filter((r) => !unscanned.has(r.key)).length, 'every scanned key stays in the table').toBe(out.scannedEndStates);
  });

  it('HV11-A10: the repaired ordering reproduces what HV-10 measured on the real root', () => {
    const scan = scoutRoot(t4Root(), uncapped);
    const rrrr = scan.plans.find((p) => p.plan === 'RRRR') as PlanRow;
    const uuur = scan.plans.find((p) => p.plan === 'UUUR') as PlanRow;
    const pair = tacticalPreference([rrrr, uuur]);
    console.log(`HV11-A10 pair RRRR/UUUR: status=${pair.status} best=[${pair.best.join(' ')}] - ${pair.reason}`);
    expect(pair.best, 'the HV-10 §4 answer is reproduced by the repaired ordering').toEqual(['RRRR']);
    expect(pair.reason).toContain('PREFERRED');
    const all = tacticalPreference(scan.plans);
    console.log(`HV11-A10 full root: status=${all.status} best=[${all.best.join(' ')}] head=${all.ranking.slice(0, 3).map((r) => `${r.plans.join('/')} choke=${r.chokeTimely} uncov=${r.uncovered}`).join(' | ')}`);
    expect(all.best, 'and the whole-root answer is unchanged too').toEqual(['RRRR']);
    expect(scan.plans.every((p) => p.kind !== 'capture'), 'the real T4 root has no in-turn capture plan').toBe(true);
  });
});

// ===========================================================================
// B — §4 P1: what does the cell the cat ALREADY stands on defend?
// ===========================================================================

/** The hold report of the first legal complete turn that ends on `cell`. */
function heldReport(scan: ReturnType<typeof scoutRoot>, cell: string) {
  const keeper = scan.plans.find((p) => p.kind === 'turn_complete' && p.endPosition === cell);
  expect(keeper, `a legal complete cat turn ends on ${cell}`).toBeDefined();
  const rep = keeper!.row.heldChoke;
  expect(rep, `the hold proof ran for the end state on ${cell}`).not.toBeNull();
  return { keeper: keeper!, rep: rep! };
}

describe('HV-11 B — the held-choke counterfactual', () => {
  it('HV11-B1 control C re-run: the T4 hold is worth one step but is NOT maintained to the crossing', () => {
    const root = t4Root();
    const th = computeGateRace(root).threats.find((t) => t.imminent)!;
    const gate = th.layers.filter((l) => l.width === 1).sort((a, b) => b.value - a.value)[0]!;
    const [r, c] = gate.bestCell!.split(',').map(Number);
    const scan = scoutRoot(withCatAt(root, r, c), uncapped);
    const { keeper, rep } = heldReport(scan, gate.bestCell!);
    const row = rep.rows.find((x) => x.onShortestRouteWithoutHold === true);
    expect(row, 'the counterfactual puts the held cell on the mouse shortest route').toBeDefined();
    console.log(
      `HV11-B1 keep=${gate.bestCell} verdict=${rep.verdict} contrast=${rep.contrastCell} tried=${rep.contrastsTried} blocked=${row!.routeBlocked} alt=${row!.alternativeRouteExists} len=${row!.routeLengthHeld}/${row!.routeLengthFree} delay=${row!.routeDelaySteps} covers=${row!.holdCoversCrossing} crossing=${row!.mouseCrossingAtomic} catNext=${row!.catNextTurnFirstAtomic}`,
    );
    // The old control assumed an already-held choke is worth keeping. The counterfactual
    // prices the hold at exactly +1 legal mouse step, and then shows the mouse crosses the
    // cell only at atomic 16 — after the cat, which must spend its next turn's moves, is
    // no longer there. The hold is not an interception, so no bonus is invented for it.
    expect(row!.onShortestRouteWithoutHold, 'with the cat off 5,8 the mouse route does need that cell').toBe(true);
    expect(row!.routeBlocked, 'and the real mouse step into it is refused while the cat holds it').toBe('YES');
    expect(row!.alternativeRouteExists, 'a carrying-return route still exists in the hold world').toBe('YES');
    expect(row!.routeDelaySteps, 'the hold costs the mouse exactly one legal step').toBe(1);
    expect(row!.holdCoversCrossing, 'but the crossing lands after the cat must move again').toBe('NO');
    expect(rep.verdict, 'so the verdict is NOT_PROVEN, not a standing bonus').toBe('NOT_PROVEN');
    expect(rep.provenChokeCells.length, 'nothing enters the ordering visible set').toBe(0);
    expect(keeper.row.timely.some((t) => t.steps === 0), 'and no zero-step row is manufactured').toBe(false);
    const pref = tacticalPreference(scan.plans);
    console.log(`HV11-B1 ordering after the fix: ${pref.status} best=[${pref.best.join(' ')}] (evidence, not a sorting defect)`);
  });

  it('HV11-B2 a true single-cell passage is PROVEN and enters the timely grammar', () => {
    // T5: the mouse carries from 1,8 to the 2x2 hole at 7,8; the cat on 3,8 sits on the
    // column-8 return lane and the only equal-length alternative is the adjacent lane.
    const scan = scoutRoot(withCatAt(h1Turn(5).state, 3, 8), uncapped);
    const { keeper, rep } = heldReport(scan, '3,8');
    const row = rep.rows.find((x) => x.verdict === 'PROVEN')!;
    console.log(
      `HV11-B2 hold=3,8 verdict=${rep.verdict} contrast=${rep.contrastCell} tried=${rep.contrastsTried} origin=${row.origin} step=${row.crossingStep} width=${row.crossingLayerWidth} blocked=${row.routeBlocked} delay=${row.routeDelaySteps} covers=${row.holdCoversCrossing} crossing=${row.mouseCrossingAtomic} catNext=${row.catNextTurnFirstAtomic}`,
    );
    expect(rep.verdict).toBe('PROVEN');
    expect(row.onShortestRouteWithoutHold, 'the cell is on the mouse shortest route without the hold').toBe(true);
    expect(row.crossingLayerWidth, 'a genuine single-cell layer').toBe(1);
    expect(row.routeBlocked, 'the engine refuses the mouse step into the held cell').toBe('YES');
    expect(row.routeDelaySteps, 'the detour costs legal mouse steps').toBeGreaterThanOrEqual(1);
    expect(row.holdCoversCrossing, 'the crossing happens before the cat must move again').toBe('YES');
    expect(rep.provenChokeCells.length, 'the visible set names the hold').toBeGreaterThan(0);
    const zeroStep = keeper.row.timely.filter((t) => t.steps === 0 && t.routeOrigin === row.origin);
    expect(zeroStep.length, 'the ordering sees it as a zero-step width-1 row').toBe(1);
    expect(zeroStep[0]!.layerWidth).toBe(1);
    expect(zeroStep[0]!.verdict).toBe('CAT_CAN_ARRIVE_BEFORE_MOUSE');
  });

  it('HV11-B3 standing beside an ordinary route is NOT_PROVEN: the mouse never needs that cell', () => {
    const scan = scoutRoot(withCatAt(t4Root(), 5, 7), uncapped);
    const { rep } = heldReport(scan, '5,7');
    const row = rep.rows[0]!;
    console.log(`HV11-B3 hold=5,7 verdict=${rep.verdict} origin=${row.origin} onRoute=${row.onShortestRouteWithoutHold} blocked=${row.routeBlocked}`);
    expect(row.onShortestRouteWithoutHold, 'no shortest mouse route passes through 5,7').toBe(false);
    expect(rep.verdict).toBe('NOT_PROVEN');
    expect(rep.provenChokeCells.length).toBe(0);
  });

  it('HV11-B4 an equivalent detour is worth zero steps and is NOT a hold', () => {
    const scan = scoutRoot(withCatAt(t4Root(), 3, 6), uncapped);
    const { rep } = heldReport(scan, '3,6');
    const row = rep.rows.find((x) => x.onShortestRouteWithoutHold === true)!;
    console.log(
      `HV11-B4 hold=3,6 verdict=${rep.verdict} origin=${row.origin} step=${row.crossingStep} width=${row.crossingLayerWidth} blocked=${row.routeBlocked} delay=${row.routeDelaySteps} covers=${row.holdCoversCrossing}`,
    );
    expect(row.onShortestRouteWithoutHold, 'the free route does pass 3,6').toBe(true);
    expect(row.crossingLayerWidth, 'but the layer has a parallel lane').toBeGreaterThan(1);
    expect(row.routeDelaySteps, 'rerouting around the held cell costs the mouse nothing').toBe(0);
    expect(rep.verdict, 'so standing there buys no step and is not a hold').toBe('NOT_PROVEN');
    expect(rep.provenChokeCells.length).toBe(0);
  });

  it('HV11-B5 leaving to capture the mouse always outranks any defensive row', () => {
    const scan = scoutRoot(withCatAt(t4Root(), 1, 7), uncapped);
    const captures = scan.plans.filter((p) => p.kind === 'capture');
    const pref = tacticalPreference(scan.plans);
    console.log(`HV11-B5 captures=${captures.length} preference=${pref.status} [${pref.best.join(' ')}] ranking=${pref.ranking.length}`);
    expect(captures.length, 'the cat can end the game this turn by stepping onto the mouse').toBeGreaterThan(0);
    expect(pref.status).toBe('IMMEDIATE_CAPTURE_PRIORITY');
    expect(pref.immediateCapture).toEqual([...new Set(captures.map((p) => p.plan))].sort());
    expect(pref.ranking, 'no defensive row is compared against a legal capture').toEqual([]);
  });

  it('HV11-B6 without an urgent carrying-return threat the verdict is UNKNOWN, never a hold', () => {
    const leaf = handOffToMouse(h1Turn(4).state, true);
    const board = leaf.board.map((row) => row.map((cell) => ({ ...cell })));
    const starved: GameEngineState = { ...leaf, mouseHasButter: false, butterPositions: [], board };
    const a = withCatAt(starved, 5, 8);
    const b = withCatAt(starved, 5, 6);
    const rep = proveHeldChoke(a, [b]);
    console.log(`HV11-B6 verdict=${rep.verdict} skipped=${rep.skipped} rows=${rep.rows.length} why=${rep.skipReason}`);
    expect(rep.verdict).toBe('UNKNOWN');
    expect(rep.skipped).toBe(true);
    expect(rep.rows.length).toBe(0);
    expect(rep.skipReason).toContain('no legal alternative ending');
  });

  it('HV11-B7 the proof is bounded: a hard contrast cap and a counted root cost', () => {
    const scan = scoutRoot(withCatAt(h1Turn(5).state, 3, 8), uncapped);
    const { rep } = heldReport(scan, '3,8');
    console.log(`HV11-B7 contrastsTried=${rep.contrastsTried} holdRun=${scan.stats.holdProofsRun}/${scan.stats.scannedEndStates} holdMs=${scan.stats.holdMs.toFixed(2)}`);
    expect(rep.contrastsTried, 'the contrast cap is 4 per proof').toBeLessThanOrEqual(4);
    expect(scan.stats.holdProofsRun, 'every scanned end state got a proof under the lifted cap').toBe(scan.stats.scannedEndStates);
    expect(scan.stats.holdMs, 'and the cost is counted into the root totals').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C — §5 P2: which cells are legal cat landings at all, and what the caps bind
// ---------------------------------------------------------------------------

describe('HV11 §5 P2 — target legality and truncation contract', () => {
  /** T4 with the box at 2,5 moved to 0,5, so a clean push lane exists on an empty row. */
  function pushLaneState(): GameEngineState {
    const root = t4Root();
    const board = root.board.map((row) => row.map((c) => ({ ...c })));
    expect(board[2][5].type, 'the fixture really has a box at 2,5').toBe(CellType.Box);
    expect(board[0][5].type, 'and 0,5/0,6 are empty so the lane is real').toBe(CellType.Empty);
    expect(board[0][6].type).toBe(CellType.Empty);
    board[2][5].type = CellType.Empty;
    board[0][5].type = CellType.Box;
    return { ...root, board, currentPlayer: PieceType.Cat, catMovesLeft: root.config.catBaseMoves, catPosition: { r: 0, c: 4 }, phase: GamePhase.Playing };
  }

  it('HV11-C1 the classifier follows the ENGINE, not the tile table', () => {
    const s = t4Root();
    // A box is never excluded: only a push can put the cat there, and the engine decides.
    const push = pushLaneState();
    const verdict = classifyCatTarget(push, 0, 5);
    console.log(`HV11-C1 box 0,5 → ${verdict.legality} (${verdict.note})`);
    expect(verdict.legality).toBe('PUSH_REQUIRED_POTENTIAL');
    const moved = catMove(push, DIRECTIONS[3]);
    expect(rc(moved.catPosition), 'the engine really accepts standing on the box cell after the push').toBe('0,5');
    expect(moved.board[0][6].type, 'and the box really moved one cell on').toBe(CellType.Box);

    // A tunnel TILE that is not a corner is walkable; a tunnel CORNER is not, whatever is painted.
    const tileBoard = s.board.map((row) => row.map((c) => ({ ...c })));
    tileBoard[0][6].type = CellType.Tunnel;
    const tile: GameEngineState = { ...s, board: tileBoard, currentPlayer: PieceType.Cat, catMovesLeft: s.config.catBaseMoves, catPosition: { r: 0, c: 5 }, phase: GamePhase.Playing };
    expect(classifyCatTarget(tile, 0, 6).legality, 'a non-corner tunnel tile is an ordinary step').toBe('CURRENTLY_ENTERABLE');
    expect(rc(catMove(tile, DIRECTIONS[3]).catPosition)).toBe('0,6');

    const cornerBoard = s.board.map((row) => row.map((c) => ({ ...c })));
    cornerBoard[0][0].type = CellType.Empty;
    const corner: GameEngineState = { ...s, board: cornerBoard, currentPlayer: PieceType.Cat, catMovesLeft: s.config.catBaseMoves, catPosition: { r: 0, c: 1 }, phase: GamePhase.Playing };
    expect(classifyCatTarget(corner, 0, 0).legality, 'a corner is a tunnel even when painted empty').toBe('NEVER_ENTERABLE');
    expect(rc(catMove(corner, DIRECTIONS[2]).catPosition), 'and the engine refuses the step').toBe('0,1');

    // A butter ENTITY is unenterable whatever the terrain says.
    const butter = s.butterPositions[0]!;
    const butterVerdict = classifyCatTarget(s, butter.r, butter.c);
    console.log(`HV11-C1 butter ${butter.r},${butter.c} → ${butterVerdict.legality} (${butterVerdict.note})`);
    expect(butterVerdict.legality).toBe('NEVER_ENTERABLE');
    expect(butterVerdict.note).toContain('butter');
    // Fixed obstacles, void and the hole are rule-level refusals too.
    expect(classifyCatTarget(s, 2, 4).legality, 'pile at 2,4').toBe('NEVER_ENTERABLE');
    expect(classifyCatTarget(s, s.config.mouseHole.r, s.config.mouseHole.c).legality, 'hole cell').toBe('NEVER_ENTERABLE');
  });

  it('HV11-C2 butter cells are derived as targets and must be rejected, with the reason kept', () => {
    const butter = t4Root().butterPositions.map((b) => `${b.r},${b.c}`);
    const scan = scoutRoot(t4Root(), uncapped);
    const rejected = scan.scanned.flatMap((r) => r.rejectedNever);
    console.log(`HV11-C2 rejected=${scan.stats.targetsRejectedByRules} cells=[${[...new Set(rejected.map((x) => x.cell))].join(' ')}] butter=[${butter.join(' ')}]`);
    expect(rejected.length, 'the derivation proposes butter cells, so the classifier must reject them').toBeGreaterThan(0);
    expect(rejected.every((x) => butter.includes(x.cell)), 'every rejection is a butter position on this fixture').toBe(true);
    for (const row of scan.scanned) {
      for (const x of row.rejectedNever) {
        expect(row.claims.has(x.cell), `a rejected cell is never probed (${x.cell})`).toBe(false);
        expect(row.reachableTargets.includes(x.cell)).toBe(false);
      }
    }
  });

  it('HV11-C3 box cells stay in the proposal set and are priced by the real catMove', () => {
    const scan = scoutRoot(t4Root(), uncapped);
    console.log(`HV11-C3 legality=${JSON.stringify(scan.stats.targetLegalityTotal)} targets=${scan.stats.targetsTotal}`);
    expect(scan.stats.targetLegalityTotal.PUSH_REQUIRED_POTENTIAL, 'real box cells were proposed, not blacklisted').toBeGreaterThan(0);
    expect(scan.stats.targetLegalityTotal.NEVER_ENTERABLE, 'refusals leave as rejections, never as probed targets').toBe(0);
    const sum = Object.values(scan.stats.targetLegalityTotal).reduce((a, b) => a + b, 0);
    expect(sum, 'every probed target carries exactly one legality class').toBe(scan.stats.targetsTotal);
    // A box target is UNKNOWN here, not NO: the engine has not proven it either way.
    const boxClaims = scan.scanned.flatMap((r) => [...r.claims.values()]).filter((c) => c.cell === '7,7');
    expect(boxClaims.length, 'the box at 7,7 was proposed on some end states').toBeGreaterThan(0);
    expect(boxClaims.some((c) => c.verdict === 'UNKNOWN'), 'and left UNKNOWN rather than silently excluded').toBe(true);
  });

  it('HV11-C4 a binding target cap makes the scan INCOMPLETE and bars a global preference', () => {
    const wide = scoutRoot(t4Root(), uncapped);
    expect(wide.stats.scanStatus, 'with room, the same root is complete').toBe('COMPLETE');
    expect(wide.stats.unscanned.reasons).toEqual([]);
    expect(wide.stats.unscanned.targetCells).toEqual([]);

    const tight = scoutRoot(t4Root(), { ...uncapped, maxTargetsPerEnd: 2 });
    console.log(
      `HV11-C4 tight status=${tight.stats.scanStatus} reasons=[${tight.stats.unscanned.reasons.join(' | ')}] dropped=${tight.stats.targetsDroppedByCap} truncatedRows=${tacticalPreference(tight.plans).truncatedEndStates.length}`,
    );
    expect(tight.stats.scanStatus).toBe('INCOMPLETE');
    expect(tight.stats.unscanned.status).toBe('INCOMPLETE');
    expect(tight.stats.unscanned.reasons.join(' ')).toContain('per-end target cap 2');
    expect(tight.stats.targetsDroppedByCap).toBeGreaterThan(0);
    expect(tight.stats.unscanned.targetCells.length, 'every dropped cell is listed, not just counted').toBe(tight.stats.targetsDroppedByCap);
    expect(tight.stats.unscanned.targetCells.every((t) => t.cell.length > 0 && t.endStateKey.length > 0)).toBe(true);

    const pref = tacticalPreference(tight.plans);
    expect(['FULL_PREFERENCE', 'NO_TACTICAL_SEPARATION'], 'a partially probed row may not read as a global answer').not.toContain(pref.status);
    expect(pref.truncatedEndStates.length).toBeGreaterThan(0);

    const shipped = scoutRoot(t4Root(), DEFAULT_CAPS);
    console.log(`HV11-C4 shipped status=${shipped.stats.scanStatus} dropped=${shipped.stats.targetsDroppedByCap} reasons=[${shipped.stats.unscanned.reasons.join(' | ')}]`);
    expect(shipped.stats.targetsDroppedByCap, 'the shipped caps really bind on this root').toBeGreaterThan(0);
    expect(shipped.stats.scanStatus).toBe('INCOMPLETE');
  });

  it('HV11-C5 the catMove cap is a declared soft cap with a measured overrun', () => {
    const few = scoutRoot(t4Root(), { ...uncapped, maxCatMoveCalls: 30 });
    const b = few.stats.catMoveBudget;
    console.log(`HV11-C5 contract=${b.contract} cap=${b.cap} used=${b.used} overrun=${b.overrun} maxOnOneState=${few.stats.catMoveCallsMaxOnOneState} status=${few.stats.scanStatus}`);
    expect(b.contract).toBe('SOFT_CAP_WITH_OVERRUN');
    expect(b.cap).toBe(30);
    expect(b.used).toBe(few.stats.catMoveCallsTotal);
    expect(b.overrun, 'overrun is the measured difference, not a claim of zero').toBe(Math.max(0, b.used - b.cap));
    expect(b.overrun, 'and it can never exceed one end state of work').toBeLessThanOrEqual(few.stats.catMoveCallsMaxOnOneState);
    expect(few.stats.scanStatus).toBe('INCOMPLETE');
    expect(few.stats.unscanned.reasons.join(' ')).toContain('catMove-call cap');
    expect(scoutRoot(t4Root(), uncapped).stats.catMoveBudget.overrun, 'no cap, no overrun').toBe(0);
  });

  it('HV11-C6 enumeration and every probe stage are inside the root cost', () => {
    const scan = scoutRoot(t4Root(), uncapped);
    console.log(
      `HV11-C6 total=${scan.stats.totalMs.toFixed(2)}ms enum=${scan.stats.enumerationMs.toFixed(2)} gateRace=${scan.stats.gateRaceMs.toFixed(2)} derive=${scan.stats.deriveMs.toFixed(2)} reach=${scan.stats.reachMs.toFixed(2)} hold=${scan.stats.holdMs.toFixed(2)}`,
    );
    expect(scan.stats.enumerationMs, 'the turn enumeration has a nonzero wall cost').toBeGreaterThan(0);
    const stages = scan.stats.enumerationMs + scan.stats.gateRaceMs + scan.stats.deriveMs + scan.stats.reachMs + scan.stats.holdMs;
    expect(scan.stats.totalMs, 'the stages are a partition of the root cost, so their sum cannot exceed it').toBeGreaterThanOrEqual(stages);
  });

  it('HV11-C7 the derivation cap is measured, and an unbound cap loses nothing silently', () => {
    const scan = scoutRoot(t4Root(), uncapped);
    const unbound = scan.scanned.filter((r) => !r.deriveCapHit);
    expect(unbound.length, 'the derivation cap does not bind on this fixture, so the check below means something').toBeGreaterThan(0);
    for (const row of unbound) {
      expect(row.targetCount + row.rejectedNever.length, 'proposals kept + proposals refused must fit under the derivation cap').toBeLessThanOrEqual(32);
    }
    expect(scan.scanned.every((r) => typeof r.deriveCapHit === 'boolean')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D — §6 P3: two headrooms, not one, and a median that is a real sample
// ---------------------------------------------------------------------------

describe('HV11 §6 P3 — timing accounting', () => {
  it('HV11-D1 the median is the run that produced it, not an index into an unsorted list', () => {
    // The HV-10 defect: sort the TIMES, then index the UNSORTED runs with times.indexOf(median).
    const runs = [
      { id: 'a', ms: 5, calls: 50 },
      { id: 'b', ms: 1, calls: 10 },
      { id: 'c', ms: 9, calls: 90 },
    ];
    const s = pairedRuns(runs, (r) => r.ms);
    const oldPick = runs[[...runs.map((r) => r.ms)].sort((x, y) => x - y).indexOf(s.median)]!;
    console.log(`HV11-D1 median=${s.median} paired=${s.medianRun.id}(${s.medianRun.ms}ms,${s.medianRun.calls} calls) — the old sort-then-index would have read ${oldPick.id}(${oldPick.ms}ms,${oldPick.calls} calls)`);
    expect(s.median, 'the middle of 1/5/9 is 5').toBe(5);
    expect(s.medianRun.id, 'and the sample that measured 5 is run a').toBe('a');
    expect(s.medianRun.ms, 'the pair is self-consistent: the run measures the median it reports').toBe(s.median);
    expect(oldPick.id, 'the old arithmetic really did pair the median with a different run').not.toBe(s.medianRun.id);

    // Duplicate times: any tie is fine as long as the pair stays one run.
    const ties = [
      { id: 'x', ms: 3 },
      { id: 'y', ms: 3 },
      { id: 'z', ms: 7 },
    ];
    const t = pairedRuns(ties, (r) => r.ms);
    expect(t.medianRun.ms).toBe(t.median);
    expect(t.medianRun).toBe(t.pairs[1]!.run);
    expect(t.min).toBe(3);
    expect(t.max).toBe(7);
    expect(t.spread).toBe(4);
  });

  it('HV11-D2 MAIN_HEADROOM and TURN_HEADROOM use different denominators and never blend', () => {
    const budgets = { mainSearchBudgetMs: 100, wholeTurnCapMs: 150 };

    // The scan fits inside the search budget but not after the turn.
    const a = headroomReport(60, 120, 35, budgets);
    console.log(`HV11-D2 main=${a.mainHeadroomMs} turn=${a.turnHeadroomMs} fits=${JSON.stringify(a.fits)} verdict=${a.verdict}`);
    expect(a.mainHeadroomMs).toBe(40);
    expect(a.turnHeadroomMs).toBe(30);
    expect(a.fits).toEqual({ main: true, turn: false });
    expect(a.verdict).toBe('FITS_MAIN_ONLY');
    // The forbidden blend would have been 100 − 120 = −20 and wrongly said "fits nothing".
    expect(100 - a.wholeTurnWallMs).toBe(-20);

    // The mirror image: no room left in the search, plenty after the turn.
    const b = headroomReport(95, 110, 10, budgets);
    console.log(`HV11-D2 main=${b.mainHeadroomMs} turn=${b.turnHeadroomMs} fits=${JSON.stringify(b.fits)} verdict=${b.verdict}`);
    expect(b.fits).toEqual({ main: false, turn: true });
    expect(b.verdict).toBe('FITS_TURN_ONLY');

    const c = headroomReport(40, 80, 5, budgets);
    expect(c.verdict).toBe('FITS_BOTH');
    const d = headroomReport(99, 149, 5, budgets);
    expect(d.verdict).toBe('FITS_NEITHER');
    expect(headroomReport(60, 120, 35, budgets).note, 'the report states the distinction it exists for').toContain('never interchangeable');
  });

  it('HV11-D3 live: one production turn and three scan repetitions, each priced on its own budget', () => {
    const root = t4Root();
    scoutRoot(root, uncapped); // warm, not measured
    const runs = [0, 1, 2].map(() => scoutRoot(root, uncapped));
    const { min, median, max, medianRun } = pairedRuns(runs, (r) => r.stats.totalMs);
    expect(runs.length, 'three serial in-process repetitions, single worker').toBe(3);
    expect(medianRun.stats.totalMs).toBe(median);

    const t0 = performance.now();
    const plan = planHardCatTurn(root, {
      rules: createEngineRuleSet(),
      timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
      refutation: { enabled: HARD_TRIAL.refutationEnabled, totalTurnBudgetMs: HARD_TRIAL.totalTurnBudgetMs },
    });
    const wallMs = performance.now() - t0;
    const h = headroomReport(plan.elapsedMs, wallMs, median, {
      mainSearchBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
      wholeTurnCapMs: HARD_TRIAL.totalTurnBudgetMs,
    });
    console.log(
      `HV11-D3 scan min/median/max=${min.toFixed(2)}/${median.toFixed(2)}/${max.toFixed(2)}ms (median run scanned ${medianRun.stats.scannedEndStates} states); production search=${h.mainSearchElapsedMs.toFixed(2)}ms wholeTurn=${h.wholeTurnWallMs.toFixed(2)}ms → MAIN_HEADROOM=${h.mainHeadroomMs.toFixed(1)}ms (${h.mainSearchBudgetMs}ms) TURN_HEADROOM=${h.turnHeadroomMs.toFixed(1)}ms (${h.wholeTurnCapMs}ms) verdict=${h.verdict}`,
    );
    expect(h.mainSearchBudgetMs, 'the main budget is the frozen 100ms').toBe(100);
    expect(h.wholeTurnCapMs, 'the turn cap is the frozen 150ms').toBe(150);
    expect(h.mainHeadroomMs, 'main headroom is priced against the SEARCH time').toBe(100 - plan.elapsedMs);
    expect(h.turnHeadroomMs, 'turn headroom is priced against the WHOLE TURN wall').toBe(150 - wallMs);
    expect(h.mainHeadroomMs, 'the two numbers are not the same quantity').not.toBe(h.turnHeadroomMs);
    expect(Number.isFinite(h.mainHeadroomMs) && Number.isFinite(h.turnHeadroomMs), 'both are real measurements, even when both are negative').toBe(true);
    expect(plan.elapsedMs, 'the search time is a measurement, not a placeholder').toBeGreaterThan(0);
    // The deadline is checked between nodes, so a 100ms budget may end slightly over it; the
    // report must therefore price it, never assert that it cannot happen.
    console.log(`HV11-D3 production deadlineFired=${plan.deadlineFired} budgetFired=${plan.budgetFired} depth=${plan.completedDepth}/${plan.attemptedDepth}`);
  });
});

// ---------------------------------------------------------------------------
// E — §7 P4: is there a production seam that pays for this without a new budget?
// ---------------------------------------------------------------------------

describe('HV11 §7 P4 — root-once replacement seam (read-only instrumentation)', () => {
  /**
   * The leaf production actually resolves on this build: main.tsx sets
   * HARD_LEAF_MODE_CONFIG.current = 'baseline_hole_corrected' before the UI mounts,
   * so `resolveHardLeaf()` returns this function for every Hard leaf.
   */
  const h1Leaf = (s: GameEngineState): number => evaluateCorrectedHoleForCat(s);

  interface CapturedLeaves {
    leaves: GameEngineState[];
    calls: number;
    distinct: number;
    leafMs: number;
    plan: HardTurnPlan;
  }

  /** One production-shaped turn (H1 leaf), counting and timing every leaf call. */
  function captureLeaves(max: number): CapturedLeaves {
    const seen = new Set<string>();
    const leaves: GameEngineState[] = [];
    let calls = 0;
    let leafMs = 0;
    const plan = planHardCatTurn(t4Root(), {
      rules: createEngineRuleSet(),
      timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
      leafEvaluator: (s) => {
        calls++;
        const k = stateKey(s);
        if (!seen.has(k)) {
          seen.add(k);
          if (leaves.length < max) leaves.push(s);
        }
        const t = performance.now();
        const v = h1Leaf(s);
        leafMs += performance.now() - t;
        return v;
      },
    });
    return { leaves, calls, distinct: seen.size, leafMs, plan };
  }

  it('HV11-E1 production-shaped turn: H1 is paid per distinct leaf, and the TT is the only reuse', { timeout: 30000 }, () => {
    const r = captureLeaves(0);
    const usPerLeaf = (r.leafMs * 1000) / Math.max(1, r.calls);
    console.log(
      `HV11-E1 search=${r.plan.elapsedMs.toFixed(2)}ms depth=${r.plan.completedDepth}/${r.plan.attemptedDepth} nodes=${r.plan.debug.nodes} | H1 calls=${r.calls} distinct stateKeys=${r.distinct} repeated=${r.calls - r.distinct} | H1 total=${r.leafMs.toFixed(2)}ms (${((100 * r.leafMs) / Math.max(1e-9, r.plan.elapsedMs)).toFixed(1)}% of the search) = ${usPerLeaf.toFixed(1)}us/leaf`,
    );
    expect(r.plan.elapsedMs, 'the turn really searched').toBeGreaterThan(0);
    expect(r.calls, 'the leaf was really called').toBeGreaterThan(0);
    expect(r.distinct, 'the TT can only dedupe what it has already seen').toBeLessThanOrEqual(r.calls);
    expect(r.leafMs, 'the leaf time is spent inside the search, so it cannot exceed the search wall').toBeLessThanOrEqual(r.plan.elapsedMs + 1);
    expect(usPerLeaf, 'the per-leaf price is a real positive measurement').toBeGreaterThan(0);
    console.log('HV11-E1 reading: each call is answered by a state-dependent leaf; a root-once report has no per-leaf call site to replace — only a constant it could add uniformly (E4).');
  });

  it('HV11-E2 the HV-6 trial is a second whole evaluation per leaf, and its gate term is mostly neutral', { timeout: 30000 }, () => {
    const { leaves } = captureLeaves(16);
    expect(leaves.length, 'the turn produced real leaves to price').toBeGreaterThan(0);
    for (const s of leaves) {
      evaluateForCat(s);
      evaluateCorrectedHoleForCat(s);
      evaluateH1GateRaceForCat(s);
    }
    // Rotating arms, three rounds, min per arm (this host drifts; the minimum is the
    // least-drifted honest sample for a fixed workload).
    const arms = [
      { name: 'baseline', fn: evaluateForCat },
      { name: 'H1', fn: evaluateCorrectedHoleForCat },
      { name: 'HV6', fn: evaluateH1GateRaceForCat },
    ] as const;
    const timed: Record<string, number> = { baseline: Infinity, H1: Infinity, HV6: Infinity };
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < arms.length; i++) {
        const arm = arms[(i + round) % arms.length]!;
        const t0 = performance.now();
        for (const s of leaves) arm.fn(s);
        timed[arm.name] = Math.min(timed[arm.name]!, performance.now() - t0);
      }
    }
    const n = leaves.length;
    const us = (k: string) => (timed[k]! * 1000) / n;

    let identity = 0;
    let gateNonZero = 0;
    let trialDiffers = 0;
    for (const s of leaves) {
      const detailed = evaluateForCatDetailed(s);
      if (Math.abs(correctedHoleEvalTotal(detailed, s.config.boardSize) - evaluateCorrectedHoleForCat(s)) < 1e-9) identity++;
      if (computeGateRace(s).contribution !== 0) gateNonZero++;
      if (evaluateH1GateRaceForCat(s) !== evaluateCorrectedHoleForCat(s)) trialDiffers++;
    }
    console.log(
      `HV11-E2 ${n} real leaves, serial, min of 3 rotated rounds: baseline=${us('baseline').toFixed(1)}us H1=${us('H1').toFixed(1)}us HV6-trial=${us('HV6').toFixed(1)}us | H1 adds ${(us('H1') - us('baseline')).toFixed(1)}us/leaf; the trial adds ${(us('HV6') - us('H1')).toFixed(1)}us/leaf over H1 | H1 identity (detailed + correction) ${identity}/${n} | gate term nonzero ${gateNonZero}/${n} | trial value differs from H1 ${trialDiffers}/${n}`,
    );
    expect(identity, 'H1 is exactly the detailed evaluation plus the correction, nothing else').toBe(n);
    expect(timed.H1, 'H1 has a real per-leaf cost').toBeGreaterThan(0);
    expect(timed.HV6, 'the trial is a real evaluation, not a shortcut').toBeGreaterThan(0);
    expect(timed.HV6, 'and it cannot be cheaper than the leaf it extends').toBeGreaterThanOrEqual(timed.H1 * 0.9);
    // The trial is NOT enabled and must not be: this is the price of an experiment, not of production.
    console.log('HV11-E2 reading: the per-leaf Gate Race arm is an extra whole evaluation context; it is not part of H1, so it cannot be a source of reclaimed budget under the current mode.');
  });

  it('HV11-E3 the bounded sidecar on the real T4 root: what it does, what it costs, what it leaves unused', { timeout: 30000 }, () => {
    expect(HARD_TRIAL.refutationEnabled, 'the production trial really enables the sidecar').toBe(true);
    expect(HARD_TRIAL.totalTurnBudgetMs, 'and the whole-turn wall is the frozen 150ms').toBe(150);

    const t0 = performance.now();
    const plan = planHardCatTurn(t4Root(), {
      rules: createEngineRuleSet(),
      timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
      refutation: { enabled: HARD_TRIAL.refutationEnabled, totalTurnBudgetMs: HARD_TRIAL.totalTurnBudgetMs },
      leafEvaluator: h1Leaf,
    });
    const wallMs = performance.now() - t0;
    const r = plan.debug.refutation;
    expect(r, 'the Hard trial path always returns sidecar diagnostics').toBeDefined();
    const d = r!;
    const entryRemainingMs = HARD_TRIAL.totalTurnBudgetMs - plan.elapsedMs;
    const afterSidecarMs = HARD_TRIAL.totalTurnBudgetMs - plan.elapsedMs - d.refutationWallMs;
    console.log(
      `HV11-E3 search=${plan.elapsedMs.toFixed(2)}ms depth=${plan.completedDepth}/${plan.attemptedDepth} mate=${plan.debug.mate} planLen=${plan.plan.length} | sidecar triggered=${d.refutationTriggered} reason=${d.sidecarAbortReason} candidates=${d.candidateCount} probed=${d.candidatesProbed} pathCount=${d.pathCount} exactChecks=${d.exactLocalChecks} cpu=${d.refutationCpuMs.toFixed(2)}ms wall=${d.refutationWallMs.toFixed(2)}ms override=${d.overrideUsed} source=${d.selectedPlanSource} baselineProbe=${d.baselineProbeStatus}`,
    );
    console.log(
      `HV11-E3 budget: entry-remaining=${entryRemainingMs.toFixed(2)}ms of the 150ms wall, sidecar wall=${d.refutationWallMs.toFixed(2)}ms, left after the sidecar=${afterSidecarMs.toFixed(2)}ms, whole turn=${wallMs.toFixed(2)}ms (search+sidecar=${(plan.elapsedMs + d.refutationWallMs).toFixed(2)}ms) | deadlineAbort=${d.deadlineControl?.deadlineAbort ?? 'n/a'} abortPhase=${d.deadlineControl?.abortPhase ?? 'n/a'} partialCommits=${d.deadlineControl?.partialCommitCount ?? 'n/a'} clockReads=${d.deadlineControl?.finite?.totalDeadlineClockReads ?? 'n/a'}`,
    );
    expect(d.refutationEnabled).toBe(true);
    expect(d.candidatesProbed, 'a probe is only counted for a candidate that was really probed').toBeLessThanOrEqual(d.candidateCount);
    expect(d.refutationWallMs, 'the wall is a measurement').toBeGreaterThanOrEqual(0);
    expect(d.refutationCpuMs, 'the CPU sum is a measurement').toBeGreaterThanOrEqual(0);
    if (d.refutationTriggered && d.sidecarAbortReason !== 'deadline') {
      expect(d.candidatesProbed, 'a completed pass probed every candidate it selected').toBe(d.candidateCount);
    }
    expect(d.deadlineControl?.partialCommitCount ?? 0, 'no partial result may ever be committed').toBe(0);
    console.log('HV11-E3 reading: the sidecar is a post-search consumer of the SAME 150ms wall, gated on a legal completed non-mate baseline. Its cost is the entry-remaining minus what is left (or the full remaining if it aborted).');
  });

  it('HV11-E4 a root-once number is constant across the turn leaves, so it cannot carry the per-leaf information H1 carries', { timeout: 30000 }, () => {
    // 1) Static: H1 itself contains no Gate Race — the production default has no
    //    per-leaf Gate Race cost to remove, so "reclaim it for the root scan" is void.
    const h1Src = readFileSync('src/game/ai/correctedHoleLeaf.ts', 'utf8');
    console.log(`HV11-E4 correctedHoleLeaf.ts mentions computeGateRace: ${h1Src.includes('computeGateRace')} — H1 is evaluateForCatDetailed + the corrected-hole arithmetic (correctedHoleLeaf.ts:57).`);
    expect(h1Src, 'H1 is not the trial leaf; the Gate Race arm lives in gateRaceLeaf.ts').not.toContain('computeGateRace');
    expect(h1Src, 'and the whole H1 leaf is these two calls').toContain('correctedHoleEvalTotal');
    expect(h1Src).toContain('evaluateForCatDetailed');

    // 2) Live: real leaves of one turn carry different H1 values. Any root-derived
    //    bonus is ONE constant added to all of them; a constant preserves every
    //    comparison, so it cannot encode the difference the leaves actually carry.
    const { leaves } = captureLeaves(16);
    expect(leaves.length).toBeGreaterThan(1);
    const values = leaves.map(h1Leaf);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min;
    const C = 37.5;
    const pairs = values.slice(0, Math.min(6, values.length));
    for (let i = 1; i < pairs.length; i++) {
      const v0 = pairs[0]!;
      const vi = pairs[i]!;
      expect(Math.max(v0 + C, vi + C) - C, 'a constant bonus cannot change which leaf wins').toBeCloseTo(Math.max(v0, vi), 9);
      expect(Math.min(v0 + C, vi + C) - C, 'nor which one loses').toBeCloseTo(Math.min(v0, vi), 9);
    }
    console.log(
      `HV11-E4 ${leaves.length} distinct real leaves: H1 spread=${spread.toFixed(3)} (min=${min.toFixed(3)} max=${max.toFixed(3)}); with a root-once constant C=${C} every comparison is unchanged (max/C−C = max, min/C−C = min). A root-once report can only be that constant, so it is decision-invariant inside one depth and cannot reproduce the per-leaf term.`,
    );
    expect(spread, 'the leaves really differ — there is per-leaf information to lose').toBeGreaterThan(1e-6);
    console.log('HV11-E4 verdicts: ROOT_ONCE_REPLACES_H1_LEAF_EVAL=INVALID; ROOT_ONCE_REPLACES_GATE_RACE_PER_LEAF=INVALID (H1 has none to reclaim, and the trial term is state-dependent); EXISTING_SIDECAR_REPLACEMENT_SEAM is decided by E3 measurements, not by this arithmetic.');
  });
});
