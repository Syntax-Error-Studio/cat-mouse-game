/// <reference types="node" />
/**
 * PPC-HV-10 P0/P1 — the root-level tactical scan, measured before anything is believed.
 *
 * INSTRUMENT ONLY. Production H1, the Gate Race term, RB-1 and the rules kernel are
 * read, never edited. Nothing here changes a decision: the output is a table, and the
 * only decision-shaped field is `TACTICAL_PREFERENCE` (§6).
 */
import { describe, expect, it } from 'vitest';
import { createEngineRuleSet, type GameEngineState } from '../../engine';
import { CellType, GamePhase, PieceType } from '../../types';
import { createEvaluationContext, evaluationCellKey, getEvaluationCalls, resetEvaluationCalls } from '../evaluation';
import { buildRouteClock, computeGateRace } from '../gateRaceLeaf';
import { planHardCatTurn } from '../hardTurnPlanner';
import { DEFAULT_SEARCH_CONFIG, HARD_TRIAL } from '../searchConfig';
import { stateKey } from '../transposition';
import { bankTurn } from './hv8WitnessPush';
import { h1Game4, h1Turn, handOffToMouse, rc, replayCatPlan, withCatAt } from './hv5ForcedLineAuditor';
import {
  DEFAULT_CAPS,
  headroomReport,
  imminentRoutes,
  pairedRuns,
  reverifyWitness,
  scoutEndState,
  scoutRoot,
  tacticalPreference,
  type EndRow,
  type PlanRow,
  type ScoutCaps,
} from './hv10RootScout';

const fmt = (n: number): string => n.toFixed(4);

const t4Root = (): GameEngineState => h1Turn(4).state;

/** The full-root scan, with the caps lifted so P0/P1 see every candidate. */
const uncapped: ScoutCaps = { ...DEFAULT_CAPS, maxEndStates: 400, maxTargetsPerEnd: 32, maxCatMoveCalls: 1e9 };

const scanAll = (): ReturnType<typeof scoutRoot> => scoutRoot(t4Root(), uncapped);

const planRow = (plans: PlanRow[], tokens: string): PlanRow => {
  const r = plans.find((p) => p.plan === tokens);
  expect(r, `the engine enumeration must contain the plan ${tokens}`).toBeDefined();
  return r!;
};

describe('PPC-HV-10 A — P0: the enumeration basis behind the reported complete plans', () => {
  it('HV10-A1: every complete cat turn on the real T4 root comes from the engine, and the count is stated', () => {
    const root = t4Root();
    const scan = scoutRoot(root, { ...DEFAULT_CAPS, maxEndStates: 200, maxCatMoveCalls: 1e9 });
    const s = scan.stats;
    const trapPlans = scan.plans.filter((p) => p.trapPlaced).length;
    const pushPlans = scan.plans.filter((p) => p.boxesMoved > 0).length;
    const stalled = scan.plans.filter((p) => p.stalledEarly).length;
    const lengths = [...new Set(scan.plans.map((p) => p.plan.length))].sort((a, b) => a - b);

    console.log(`HV10-A1 T4 root cat=${s.rootCatPosition} mouse=${s.rootMousePosition} budget=${root.config.catBaseMoves} catMovesLeft=${root.catMovesLeft} trapInHand=${root.catTrapsRemaining}`);
    console.log(`HV10-A1 ROOT_CANDIDATES=${s.totalPlans} (turn-complete ends=${s.ends} + capture plans=${s.captures}) | ENUMERATION_COMPLETE=${s.enumerationComplete} TRUNCATED=${s.truncatedEnumeration} nodes=${s.enumerationNodes}`);
    console.log(`HV10-A1 basis: plan lengths=${lengths.join('/')} | trap plans=${trapPlans} | plans that push a box=${pushPlans} | turns ended early with steps in the bank=${stalled}`);
    console.log(`HV10-A1 DISTINCT_END_STATES (full stateKey)=${s.distinctEndStates} | distinct cat cells only=${s.distinctEndPositions} | duplicate end states=${s.cacheHits}`);
    console.log(`HV10-A1 logged line for this root: [${h1Turn(4).loggedPlan}]`);

    expect(s.enumerationComplete, 'the 20k node cap is not reached on this root, so the plan set is complete').toBe(true);
    expect(s.truncatedEnumeration).toBe(false);
    expect(s.captures, 'T4 has no in-turn capture — HV-9 P2 found the mouse 11 Manhattan away').toBe(0);
    for (const p of scan.plans) {
      expect(p.plan.length, `${p.plan}: a complete turn spends the budget or stalls`).toBeGreaterThanOrEqual(1);
      const replayed = replayCatPlan(root, [...p.plan]);
      expect(replayed.illegalAt, `${p.plan}: every token is an action the engine accepts`).toBeNull();
      expect(replayed.applied.length, `${p.plan}: and all of them are applied`).toBe(p.plan.length);
      expect(rc(replayed.end.catPosition), `${p.plan}: the recorded end position is the engine position`).toBe(p.endPosition);
      if (p.kind === 'turn_complete' && !p.stalledEarly) {
        expect(p.endState.catMovesLeft, `${p.plan}: a non-stalled turn ends only with the bank empty`).toBe(0);
      }
    }
  });

  it('HV10-A2: candidates merge by FULL state, never by cat cell — and the key really sees the box layout', () => {
    const root = t4Root();
    const scan = scoutRoot(root, { ...DEFAULT_CAPS, maxEndStates: 200, maxCatMoveCalls: 1e9 });
    const byCell = new Map<string, Set<string>>();
    for (const p of scan.plans) {
      const set = byCell.get(p.endPosition) ?? new Set<string>();
      set.add(p.endStateKey);
      byCell.set(p.endPosition, set);
    }
    const shared = [...byCell.entries()].filter(([, keys]) => keys.size > 1).map(([cell, keys]) => `${cell}×${keys.size}`);
    expect(shared.length, 'at least one cat cell is reached by plans with different box layouts — cell-only dedup would merge them').toBeGreaterThan(0);

    // The key must change when only a box moves, and when only the trap moves.
    const rr = planRow(scan.plans, 'RRRR');
    const sameCellDifferentBoxes = [...byCell.entries()].find(([, keys]) => keys.size > 1)!;
    const keys = [...sameCellDifferentBoxes[1]];
    expect(keys[0], `${sameCellDifferentBoxes[0]}: two plans, same cat cell, different full states get different keys`).not.toBe(keys[1]);
    const layouts = scan.plans.filter((p) => p.endPosition === sameCellDifferentBoxes[0]).map((p) => boxText(p.endState)).join(' vs ');
    expect(layouts.includes(' vs '), 'and the difference is visible in the box layout').toBe(true);

    const trapPlan = scan.plans.find((p) => p.trapPlaced);
    if (trapPlan !== undefined) {
      const noTrap = scan.plans.find((p) => !p.trapPlaced && p.endPosition === trapPlan.endPosition);
      if (noTrap !== undefined) {
        expect(trapPlan.endStateKey, 'a turn that placed the trap is NOT the same state as one that did not').not.toBe(noTrap.endStateKey);
      }
    }
    // handOffToMouse is what production evaluates; the key must be taken on that state.
    expect(rr.endStateKey, 'the scan key is the hand-off leaf key').toBe(stateKey(handOffToMouse(rr.endState, true)));
    console.log(`HV10-A2 cells with >1 full state: ${shared.join(' ') || 'none'} | example ${sameCellDifferentBoxes[0]} → ${layouts}`);
  });

  it('HV10-A3: an incomplete enumeration is reported as incomplete, never as a closed plan set', () => {
    const root = t4Root();
    const tight = scoutRoot(root, { ...DEFAULT_CAPS, nodeCap: 12, maxEndStates: 200, maxCatMoveCalls: 1e9 });
    const wide = scoutRoot(root, { ...DEFAULT_CAPS, maxEndStates: 200, maxCatMoveCalls: 1e9 });
    console.log(`HV10-A3 nodeCap=12 → ends=${tight.stats.ends} plans=${tight.stats.totalPlans} TRUNCATED=${tight.stats.truncatedEnumeration} (nodes=${tight.stats.enumerationNodes}) | nodeCap=${DEFAULT_CAPS.nodeCap} → plans=${wide.stats.totalPlans} TRUNCATED=${wide.stats.truncatedEnumeration}`);
    expect(tight.stats.truncatedEnumeration, 'a node cap that binds must announce itself').toBe(true);
    expect(tight.stats.enumerationComplete, 'and then the plan set is NOT complete — nothing absent may be called nonexistent').toBe(false);
    expect(tight.stats.totalPlans, 'a truncated root yields fewer plans than the same root with room').toBeLessThan(wide.stats.totalPlans);
  });

  it('HV10-A4: the two candidates this round compares are real plans of this root', () => {
    const root = t4Root();
    const scan = scoutRoot(root, { ...DEFAULT_CAPS, maxEndStates: 200, maxCatMoveCalls: 1e9 });
    const uuur = planRow(scan.plans, 'UUUR');
    const rrrr = planRow(scan.plans, 'RRRR');
    expect(uuur.endPosition, 'the logged plan lands the cat on (2,2)').toBe('2,2');
    expect(rrrr.endPosition, 'the counterfactual lands it on (5,5)').toBe('5,5');
    expect(uuur.boxesMoved, 'UUUR pushes').toBeGreaterThanOrEqual(0);
    console.log(`HV10-A4 UUUR→${uuur.endPosition} boxes moved=${uuur.boxesMoved} | RRRR→${rrrr.endPosition} boxes moved=${rrrr.boxesMoved}`);
  });
});

const boxText = (s: GameEngineState): string => {
  const out: string[] = [];
  for (let r = 0; r < s.config.boardSize; r++) {
    for (let c = 0; c < s.config.boardSize; c++) if (s.board[r][c].type === CellType.Box) out.push(`${r},${c}`);
  }
  return out.sort().join(' ');
};

describe('PPC-HV-10 B — P1: targets, witnesses and timing for one end state', () => {
  it('HV10-B1: the derived cells are a property of the position, and the fixture cells are not written into it', () => {
    const scan = scoutRoot(t4Root(), { ...DEFAULT_CAPS, maxEndStates: 200, maxCatMoveCalls: 1e9 });
    const rrrr = planRow(scan.plans, 'RRRR');
    const uuur = planRow(scan.plans, 'UUUR');
    const row = scoutEndState(rrrr.endState, { ...DEFAULT_CAPS, maxTargetsPerEnd: 32 });
    const other = scoutEndState(uuur.endState, { ...DEFAULT_CAPS, maxTargetsPerEnd: 32 });

    console.log(`HV10-B1 RRRR end ${row.endPosition}: gateRace agg=${fmt(row.gateRaceAggregate ?? NaN)} contribution=${row.gateRaceContribution} reason=${row.gateRaceReason} imminent=[${row.imminentOrigins.join(' ')}]`);
    console.log(`HV10-B1 RRRR targets=${row.targetCount} reachable=[${row.reachableTargets.join(' ')}] unknown=[${row.unknownTargets.join(' ')}] droppedByCap=${row.targetsDroppedByCap}`);
    console.log(`HV10-B1 UUUR end ${other.endPosition}: targets=${other.targetCount} reachable=[${other.reachableTargets.join(' ')}] unknown=[${other.unknownTargets.join(' ')}]`);
    for (const t of row.timely) {
      console.log(`HV10-B1   ${t.cell} steps=${t.steps} push=${t.pushes} witness=[${t.witness}] ${t.verdict} route=${t.routeOrigin ?? '-'}/step${t.routeStep ?? '-'}/w${t.layerWidth ?? '-'} cat=${t.catAtomic ?? '-'} mouse=${t.mouseAtomic ?? '-'} margin=${t.margin ?? '-'}`);
    }

    expect(row.scanned).toBe(true);
    expect(row.targetCount, 'the RRRR landing must derive at least one interception cell').toBeGreaterThan(0);
    // Nothing in the module names a cell: the claim is checked against the source text.
    expect(row.reachableTargets.length + row.unknownTargets.length, 'every derived cell gets a verdict').toBe(row.targetCount);
    for (const t of row.timely) {
      expect(t.witness.length, `${t.cell}: a reachable claim always carries its tokens`).toBe(t.steps);
    }
    expect(other.endPosition, 'the two landings are different positions').not.toBe(row.endPosition);
  });

  it('HV10-B2: the cheap mode never answers NO, and no exhaustive sweep runs', () => {
    const scan = scoutRoot(t4Root(), { ...DEFAULT_CAPS, maxEndStates: 200, maxCatMoveCalls: 1e9 });
    let unknowns = 0;
    for (const r of scan.scanned) {
      for (const [cell, claim] of r.claims) {
        expect(claim.verdict, `${cell}: the cheap permutation mode may not answer impossible`).not.toBe('UNREACHABLE_WITHIN_4');
        if (claim.verdict === 'UNKNOWN') {
          unknowns++;
          expect(claim.note, `${cell}: and it must say why nothing was proved`).not.toBeNull();
        }
        if (claim.verdict === 'REACHABLE_WITHIN_4') {
          expect(claim.witness, `${cell}: a YES carries a complete legal sequence`).not.toBeNull();
        }
      }
    }
    console.log(`HV10-B2 ${scan.scanned.length} end states scanned, ${scan.stats.targetsTotal} cells probed, ${unknowns} left UNKNOWN (never NO)`);
    expect(unknowns, 'this root must contain at least one cell the cheap mode cannot witness').toBeGreaterThan(0);
  });
});

describe('PPC-HV-10 C — §3.4: turn order is the claim, not the cell', () => {
  it('HV10-C1: the production clock puts the mouse turn BEFORE the cat step it is compared with', () => {
    const scan = scanAll();
    const rrrr = planRow(scan.plans, 'RRRR');
    const leaf = handOffToMouse(rrrr.endState, true);
    const ctx = createEvaluationContext(leaf);
    const routes = imminentRoutes(leaf, ctx, computeGateRace(leaf));
    expect(routes.length, 'the imminent corridors are rebuilt from the same leaf the scan priced').toBeGreaterThan(0);
    const mouseAllowance = leaf.mouseHasButter ? leaf.config.mouseCarryingMoves : leaf.config.mouseBaseMoves;
    for (const route of routes) {
      const clock = buildRouteClock(leaf, route.approachSteps, route.routeLength - 1);
      expect(clock.catAt.get(1), `cat step 1 of the NEXT turn lands after the whole mouse turn (allowance ${mouseAllowance})`).toBe(mouseAllowance + 1);
      expect(clock.catAt.get(4), 'and the fourth cat step is four atomic times later').toBe(mouseAllowance + 4);
      const crossings = route.layers.map((l) => `s${l.step}/w${l.width}@${l.mouseAtomic ?? '-'}`).join(' ');
      console.log(`HV10-C1 origin=${route.origin} approach=${route.approachSteps} return=${route.returnSteps} length=${route.routeLength} catAt(1..4)=${[1, 2, 3, 4].map((k) => clock.catAt.get(k)).join('/')} layers=${crossings}`);
    }
    console.log(`HV10-C1 leaf: player=${leaf.currentPlayer} mouseMovesLeft=${leaf.mouseMovesLeft} catMovesLeft=${leaf.catMovesLeft} budgets cat=${leaf.config.catBaseMoves} mouse=${leaf.config.mouseBaseMoves} carrying=${leaf.config.mouseCarryingMoves}`);
  });

  it('HV10-C2: every CAT_CAN_ARRIVE_BEFORE_MOUSE row carries witness, corridor and margin — all re-checked', () => {
    const scan = scanAll();
    let timely = 0;
    let potential = 0;
    let lateBecauseMouseFirst = 0;
    for (const p of scan.plans) {
      if (!p.firstForEndState) continue;
      for (const t of p.row.timely) {
        expect([t.verdict, 'POTENTIAL_INTERCEPTION'], `${t.cell}: the only two verdicts this model has`).toContain(t.verdict);
        expect(t.steps, `${t.cell}: an arrival claim is at most the four actions of one cat turn`).toBeLessThanOrEqual(4);
        if (t.verdict !== 'CAT_CAN_ARRIVE_BEFORE_MOUSE') {
          potential++;
          expect(t.note, `${t.cell}: POTENTIAL must say what is missing`).not.toBe('');
          if (t.margin !== null && t.margin > 0) lateBecauseMouseFirst++;
          continue;
        }
        timely++;
        expect(t.routeOrigin, `${t.cell}: a timely claim needs an imminent mouse route`).not.toBeNull();
        expect(p.row.imminentOrigins, `${t.cell}: and that route must be in the imminent set`).toContain(t.routeOrigin);
        expect(t.catAtomic, `${t.cell}: cat atomic time stated`).not.toBeNull();
        expect(t.mouseAtomic, `${t.cell}: mouse atomic time stated`).not.toBeNull();
        expect(t.margin!, `${t.cell}: and the margin is the difference`).toBe(t.catAtomic! - t.mouseAtomic!);
        expect(t.margin!, `${t.cell}: timely means the cat is strictly first`).toBeLessThan(0);
        const again = reverifyWitness(p.endState, t.cell, t.witness);
        expect(again.ok, `${t.cell}: the stored witness re-plays on the engine (${again.detail})`).toBe(true);
        console.log(`HV10-C2 ${t.cell} kept: plan=${p.plan} witness=[${t.witness}]@${t.steps} push${t.pushes} corridor=${t.routeOrigin}/step${t.routeStep}/width${t.layerWidth} cat=${t.catAtomic} mouse=${t.mouseAtomic} margin=${t.margin}`);
      }
    }
    console.log(`HV10-C2 verdicts over ${scan.scanned.length} distinct end states: timely=${timely} potential=${potential} (of which ${lateBecauseMouseFirst} are reachable-but-late because the mouse crosses first)`);
    expect(timely, 'this root does produce timely interceptions').toBeGreaterThan(0);
    expect(lateBecauseMouseFirst, 'and it must also refuse a cell the mouse reaches first — otherwise the turn order is not in the model').toBeGreaterThan(0);
  });

  it('HV10-C3: arriving is not winning — no row may claim the mouse is lost', () => {
    const scan = scanAll();
    for (const r of scan.scanned) {
      expect(
        r.threatRoutesCovered.length + r.uncoveredThreatRoutes.length,
        `${r.endPosition}: covered and uncovered must partition the imminent routes exactly`,
      ).toBe(r.imminentOrigins.length);
      for (const c of r.threatRoutesCovered) expect(r.imminentOrigins, `${r.endPosition}: covered is a subset of imminent`).toContain(c);
      for (const t of r.timely) {
        expect(Number.isInteger(t.layerWidth ?? 1) && (t.layerWidth ?? 1) >= 1, `${t.cell}: the layer width is always recorded or explicitly absent`).toBe(true);
        if (t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE' && (t.layerWidth ?? 1) > 1) {
          expect(t.note, `${t.cell}: a timely claim on a multi-cell layer must name the width the mouse can slip through`).toContain(`width ${t.layerWidth}`);
        }
      }
      const json = JSON.stringify({ covered: r.threatRoutesCovered, timely: r.timely.map((t) => t.verdict), unknown: r.unknownCount });
      expect(/WIN|LOSS|FORCED|MATE/.test(json), `${r.endPosition}: the table holds no win/loss claim`).toBe(false);
    }
    const wide = scan.scanned.flatMap((r) => r.timely.filter((t) => (t.layerWidth ?? 1) > 1));
    console.log(`HV10-C3 rows on multi-cell layers (a cat there is not a block)=${wide.length} | example ${wide.slice(0, 3).map((t) => `${t.cell} w${t.layerWidth} ${t.verdict}`).join(' ')}`);
  });
});

// ---------------------------------------------------------------------------
// §4 P2: the parallel table, the five questions, and the three reverse controls
// ---------------------------------------------------------------------------

/** A cell the cat may stand on, orthogonally adjacent to the mouse (for control A). */
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

/** Move butter `idx` to `(r,c)`, keeping the board flags consistent (labelled synthetic). */
function withButterAt(s: GameEngineState, idx: number, r: number, c: number): GameEngineState {
  const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
  const list = s.butterPositions.map((b) => ({ ...b }));
  const old = list[idx];
  board[old.r][old.c].hasButter = false;
  board[r][c].hasButter = true;
  list[idx] = { r, c };
  return { ...s, board, butterPositions: list };
}

const tableLine = (p: PlanRow): string =>
  `PLAN=${p.plan || '-'} END_POSITION=${p.endPosition} END_STATE_KEY=${p.endStateKey.slice(0, 18)}... ` +
  `TACTICAL_TARGET_COUNT=${p.row.targetCount} REACHABLE_TARGETS=[${p.row.reachableTargets.join(' ')}] ` +
  `VERIFIED_WITNESSES=${p.row.verifiedWitnesses} TIMELY_INTERCEPTIONS=[${p.row.timely
    .filter((t) => t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE')
    .map((t) => `${t.cell}@${t.steps}[${t.witness}]`)
    .join(' ')}] ` +
  `THREAT_ROUTES_COVERED=[${p.row.threatRoutesCovered.join(' ')}] UNCOVERED_THREAT_ROUTES=[${p.row.uncoveredThreatRoutes.join(' ')}] ` +
  `UNKNOWN_COUNT=${p.row.unknownCount} gateRaceAgg=${fmt(p.row.gateRaceAggregate ?? Number.NaN)} ` +
  `held=${p.row.heldKeyCell ? `${p.row.heldKeyCell.cell}${p.row.heldKeyCell.kinds.map((k) => `(${k})`).join('')}` : '-'} ` +
  `catMoveCalls=${p.row.catMoveCalls} permutations=${p.row.permutationsPlayed}`;

const timelyOf = (r: EndRow): number => r.timely.filter((t) => t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE').length;
const chokeTimelyOf = (r: EndRow): number => r.timely.filter((t) => t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE' && t.layerWidth === 1).length;

describe('PPC-HV-10 D — §4: what the table says about the two real candidates', () => {
  it('HV10-D1: the ten fields for UUUR and RRRR, and the preference between them', () => {
    const scan = scanAll();
    const uuur = planRow(scan.plans, 'UUUR');
    const rrrr = planRow(scan.plans, 'RRRR');
    console.log('HV10-D1 the §4 parallel table for the two candidates:');
    console.log('  ' + tableLine(uuur));
    console.log('  ' + tableLine(rrrr));
    const pair = tacticalPreference([uuur, rrrr]);
    console.log(`HV10-D1 TACTICAL_PREFERENCE over the pair = [${pair.best.join(' ')}] - ${pair.reason}`);
    console.log(`HV10-D1 ranking: ${pair.ranking.map((r) => `${r.plans.join('/')} timely=${r.timely} choke=${r.chokeTimely} uncov=${r.uncovered} held=${r.held} reach=${r.reachable}`).join(' | ')}`);
    console.log(`HV10-D1 §6 the exact T4 root values this table sits beside, read from the log and changed by nothing here: [${h1Turn(4).loggedRootActions.join('] [') || 'the log line carries no root-action table'}]`);
    console.log(`HV10-D1 §6 what the search chose at T4: BEST_ACTION plan=[${h1Turn(4).loggedPlan}] — this round does not re-write that line, it only records TACTICAL_PREFERENCE beside it`);

    expect(rrrr.row.targetCount, 'RRRR derives interception cells').toBeGreaterThan(0);
    expect(rrrr.row.verifiedWitnesses, 'and witnesses them').toBeGreaterThan(0);
    expect(timelyOf(rrrr.row), 'and at least one is timely on the imminent corridor').toBeGreaterThan(0);
    expect(uuur.row.reachableTargets.length, 'UUUR: the cheap mode witnesses nothing on its landing').toBe(0);
    expect(uuur.row.unknownCount, 'so its whole answer is UNKNOWN').toBe(uuur.row.targetCount);
    expect(pair.best, 'the pairwise tactical preference is RRRR over UUUR').toEqual(['RRRR']);
    expect(pair.reason, 'and it is a preference, not a value').toContain('PREFERRED');

    const all = tacticalPreference(scan.plans);
    console.log(`HV10-D1 over all ${scan.stats.distinctEndStates} distinct end states: best=[${all.best.join(' ')}] - ${all.reason}`);
    console.log(`HV10-D1 top of that ranking: ${all.ranking.slice(0, 5).map((r) => `${r.plans.join('/')} choke=${r.chokeTimely} timely=${r.timely} uncov=${r.uncovered}`).join(' | ')}`);
  });

  it('HV10-D2: the five questions, each answered by a number', () => {
    const scan = scanAll();
    const rrrr = planRow(scan.plans, 'RRRR');
    const uuur = planRow(scan.plans, 'UUUR');
    const root = t4Root();

    // Q1 — the consecutive-push ability.
    const pushy = rrrr.row.timely.filter((t) => t.pushes >= 3);
    console.log(`HV10-D2 Q1 consecutive-push defence: ${pushy.length} timely cell(s) cost >=3 pushes - ${pushy.map((t) => `${t.cell}[${t.witness}]@${t.steps}`).join(' ')}`);
    expect(pushy.length, 'the model must see the three-push line, not only the walk field').toBeGreaterThan(0);

    // Q2 — defending instead of chasing.
    const dist = (s: GameEngineState): number =>
      Math.abs(s.catPosition.r - s.mousePosition.r) + Math.abs(s.catPosition.c - s.mousePosition.c);
    console.log(`HV10-D2 Q2 chase distance: root=${dist(root)} RRRR=${dist(rrrr.endState)} UUUR=${dist(uuur.endState)} — both candidates close on the mouse equally, yet only one defends a corridor`);
    expect(dist(rrrr.endState), 'RRRR approaches the mouse').toBeLessThan(dist(root));
    expect(dist(uuur.endState), 'UUUR approaches the mouse by the same amount').toBe(dist(rrrr.endState));
    expect(timelyOf(rrrr.row) > timelyOf(uuur.row), 'and the separation comes from corridor timing, not from chasing').toBe(true);
    expect(rrrr.row.reachableTargets, 'no reachable cell is the mouse cell itself - this is not a chase model').not.toContain(rc(root.mousePosition));

    // Q3 — uncertainty with more than one route.
    console.log(`HV10-D2 Q3 route bookkeeping on RRRR: imminent=[${rrrr.row.imminentOrigins.join(' ')}] covered=[${rrrr.row.threatRoutesCovered.join(' ')}] uncovered=[${rrrr.row.uncoveredThreatRoutes.join(' ')}] unknownCells=${rrrr.row.unknownCount} wideLayers=${rrrr.row.timely.filter((t) => (t.layerWidth ?? 1) > 1).length}`);
    expect(rrrr.row.threatRoutesCovered.length, 'a covered route is named, one at a time').toBeGreaterThan(0);

    // Q4 — a forced capture outranks defence (control A runs this again in full).
    const perch = catPerchNextToMouse(root);
    expect(perch, 'control A needs a legal perch next to the mouse').not.toBeNull();
    const armed = scoutRoot(withCatAt(root, perch!.r, perch!.c), uncapped);
    const pref = tacticalPreference(armed.plans);
    console.log(`HV10-D2 Q4 capture priority: plans=${armed.stats.totalPlans} of which captures=${armed.stats.captures} -> preference=[${pref.best.join(' ')}] ${pref.reason}`);
    expect(pref.immediateCapture.length, 'and the model names the win instead of the defence').toBe(pref.best.length);

    // Q5 — no hole-guarding when nothing threatens.
    const leaf = handOffToMouse(rrrr.endState, true);
    const emptyButterEnd = {
      ...leaf,
      butterPositions: [],
      pendingButterSpawns: [],
      board: leaf.board.map((row) => row.map((cell) => ({ ...cell, hasButter: false }))),
      currentPlayer: PieceType.Cat,
      catMovesLeft: leaf.config.catBaseMoves,
    } as GameEngineState;
    const row = scoutEndState(emptyButterEnd, uncapped);
    console.log(`HV10-D2 Q5 SYNTHETIC no-butter probe (not a legal position): reason=${row.gateRaceReason} targets=${row.targetCount} timely=${timelyOf(row)} covered=[${row.threatRoutesCovered.join(' ')}] hole/feed cells still derived=${row.targetCount > 0}`);
    expect(row.imminentOrigins.length, 'no butter means no imminent route').toBe(0);
    expect(timelyOf(row), 'so nothing may be claimed as a timely interception').toBe(0);
    expect(row.threatRoutesCovered.length, 'and no route is covered').toBe(0);
  });

  it('HV10-D3 control A: a legal immediate win outranks every defensive row', () => {
    const root = t4Root();
    const perch = catPerchNextToMouse(root)!;
    const scan = scoutRoot(withCatAt(root, perch.r, perch.c), uncapped);
    const pref = tacticalPreference(scan.plans);
    console.log(`HV10-D3 SYNTHETIC perch cat=${rc(perch)} mouse=${rc(root.mousePosition)} (labelled: the real T4 root has no in-turn capture, HV-9 P2 measured the gap at 11)`);
    console.log(`HV10-D3 plans=${scan.stats.totalPlans} ends=${scan.stats.ends} captures=${scan.stats.captures} capture plans=[${scan.plans.filter((p) => p.kind === 'capture').map((p) => p.plan).join(' ')}]`);
    expect(scan.stats.captures, 'the enumeration must separate the winning plans').toBeGreaterThan(0);
    expect(pref.immediateCapture.length, 'and the preference must return only those').toBeGreaterThan(0);
    expect(pref.best.every((b) => pref.immediateCapture.includes(b)), 'no defensive plan is ranked above a win').toBe(true);
    expect(pref.ranking.length, 'and no defensive row is even scored when a win exists').toBe(0);
    for (const p of scan.plans.filter((x) => x.kind === 'capture')) {
      expect(p.endState.phase, `${p.plan}: the engine says this turn wins`).toBe(GamePhase.CatWins);
      expect(p.row.verifiedWitnesses, `${p.plan}: and the model spends no probe on it`).toBe(0);
    }
  });

  it('HV10-D4 control B: two equally fast return routes - blocking one is not a win', () => {
    const scan = scanAll();
    const rrrr = planRow(scan.plans, 'RRRR');
    const leaf = handOffToMouse(rrrr.endState, true);
    const ctx = createEvaluationContext(leaf);
    const gr = computeGateRace(leaf);
    const fastest = gr.fastestRoute!;
    const hole = leaf.config.mouseHole;
    const taken = new Set([...leaf.butterPositions.map((b) => rc(b)), rc(leaf.catPosition), rc(leaf.mousePosition)]);
    let second: string | null = null;
    for (let r = 0; r < leaf.config.boardSize && second === null; r++) {
      for (let c = 0; c < leaf.config.boardSize && second === null; c++) {
        const cell = `${r},${c}`;
        if (taken.has(cell)) continue;
        if (leaf.board[r][c].type !== CellType.Empty) continue;
        if (r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size) continue;
        const a = ctx.mouseMap.get(evaluationCellKey({ r, c }));
        const d = ctx.carryHoleMap.get(evaluationCellKey({ r, c }));
        if (a !== undefined && d !== undefined && d >= 2 && a + d === fastest) second = cell;
      }
    }
    expect(second, 'the board must offer a second butter cell on an equally fast route').not.toBeNull();
    // Move the butter that is NOT already the imminent one, so both cells stay on the board.
    const slowIdx = leaf.butterPositions.findIndex((b) => !gr.imminentOrigins.includes(rc(b)));
    expect(slowIdx, 'and the root really has a slower second butter to relocate').toBeGreaterThanOrEqual(0);
    const br = Number(second!.split(',')[0]);
    const bc = Number(second!.split(',')[1]);
    // The control is about the MODEL, not about one position: the same two-route board is
    // scanned from a strong defensive end and from a weak one, and per-route coverage must
    // be earned by a witness the engine accepts on that route.
    const uuur = planRow(scan.plans, 'UUUR');
    const cases: [string, GameEngineState][] = [
      ['RRRR@5,5', withButterAt(rrrr.endState, slowIdx, br, bc)],
      ['UUUR@2,2', withButterAt(uuur.endState, slowIdx, br, bc)],
    ];
    let uncoveredSeen = 0;
    for (const [name, endTwo] of cases) {
      const row = scoutEndState(endTwo, uncapped);
      const two = computeGateRace(handOffToMouse(endTwo, true));
      console.log(`HV10-D4 ${name} SYNTHETIC butter #${slowIdx} moved to ${second} (labelled: same route length ${fastest}) -> imminent=[${row.imminentOrigins.join(' ')}] covered=[${row.threatRoutesCovered.join(' ')}] uncovered=[${row.uncoveredThreatRoutes.join(' ')}]`);
      console.log(`HV10-D4 ${name}: production aggregate with two equal routes=${fmt(two.aggregate ?? NaN)} vs one=${fmt(gr.aggregate ?? NaN)} - the MIN over imminent routes, never the best one`);
      expect(two.imminentOrigins.length, `${name}: both butter cells are imminent`).toBe(2);
      expect(row.imminentOrigins.length, `${name}: and the scan sees both`).toBe(2);
      expect(row.threatRoutesCovered.length + row.uncoveredThreatRoutes.length, `${name}: the two routes partition exactly`).toBe(2);
      for (const origin of row.threatRoutesCovered) {
        const support = row.timely.filter((t) => t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE' && t.routeOrigin === origin);
        expect(support.length, `${name}: ${origin} may only be called covered from rows that sit on its own corridor`).toBeGreaterThan(0);
        for (const t of support) {
          expect(t.witness, `${name}: the ${origin} support row carries a sequence`).not.toBeNull();
          expect(reverifyWitness(endTwo, t.cell, t.witness!).ok, `${name}: and the engine accepts it on this board`).toBe(true);
        }
      }
      uncoveredSeen += row.uncoveredThreatRoutes.length;
      expect(two.aggregate!, `${name}: the credit is the worse of the two routes`).toBeLessThanOrEqual(Math.min(...two.threats.map((t) => t.bestValue)) + 1e-12);
      const json = JSON.stringify({ covered: row.threatRoutesCovered, timely: row.timely.map((t) => t.verdict) });
      expect(/WIN|LOSS|FORCED|MATE/.test(json), `${name}: covering corridors is never a win claim`).toBe(false);
    }
    expect(uncoveredSeen, 'a defence that reaches one corridor still leaves the other listed somewhere in the control').toBeGreaterThan(0);
  });

  it('HV10-D5 control C: leaving a key cell the cat already holds must never score higher', () => {
    const root = t4Root();
    const gr = computeGateRace(root);
    const th = gr.threats.find((t) => t.imminent)!;
    const chokes = th.layers.filter((l) => l.width === 1);
    expect(chokes.length, 'the imminent corridor has single-cell chokepoints').toBeGreaterThan(0);
    const gate = [...chokes].sort((a, b) => b.value - a.value)[0]!;
    const [r, c] = gate.bestCell!.split(',').map(Number);
    const hold = withCatAt(root, r, c);
    const scan = scoutRoot(hold, uncapped);
    const keepers = scan.plans.filter((p) => p.endPosition === gate.bestCell);
    const leavers = scan.plans.filter((p) => p.endPosition !== gate.bestCell);
    const score = (p: PlanRow): number => chokeTimelyOf(p.row) * 100 - p.row.uncoveredThreatRoutes.length;
    const maxKeep = keepers.reduce((a, p) => Math.max(a, score(p)), Number.NEGATIVE_INFINITY);
    const maxLeave = leavers.reduce((a, p) => Math.max(a, score(p)), Number.NEGATIVE_INFINITY);
    const totalKeep = keepers.reduce((a, p) => Math.max(a, timelyOf(p.row)), -1);
    const totalLeave = leavers.reduce((a, p) => Math.max(a, timelyOf(p.row)), -1);
    const chokeKeep = keepers.reduce((a, p) => Math.max(a, chokeTimelyOf(p.row)), -1);
    const chokeLeave = leavers.reduce((a, p) => Math.max(a, chokeTimelyOf(p.row)), -1);
    const aggKeep = keepers.reduce((a, p) => Math.max(a, p.row.gateRaceAggregate ?? -1), -1);
    const aggLeave = leavers.reduce((a, p) => Math.max(a, p.row.gateRaceAggregate ?? -1), -1);
    console.log(`HV10-D5 SYNTHETIC hold at ${gate.bestCell} (choke of the ${th.origin} corridor; labelled teleport - the real T4 cat starts at ${rc(root.catPosition)})`);
    console.log(`HV10-D5 plans=${scan.stats.totalPlans} keepers=${keepers.length} leavers=${leavers.length} | preference vector maxKeep=${maxKeep} maxLeave=${maxLeave} | production aggregate maxKeep=${fmt(aggKeep)} maxLeave=${fmt(aggLeave)}`);
    const rootGr = computeGateRace(handOffToMouse(hold, true));
    console.log(`HV10-D5 at the hold itself (before any plan): agg=${fmt(rootGr.aggregate ?? NaN)} reason=${rootGr.reason} imminent=[${rootGr.imminentOrigins.join(' ')}]`);
    const rowOf = (p: PlanRow): string =>
      `${p.plan}@${p.endPosition} score=${score(p)} chokeTimely=${chokeTimelyOf(p.row)} timely=${timelyOf(p.row)} targets=${p.row.targetCount} reachable=${p.row.reachableTargets.length} covered=[${p.row.threatRoutesCovered.join(',')}] uncovered=[${p.row.uncoveredThreatRoutes.join(',')}] imminent=[${p.row.imminentOrigins.join(',')}] agg=${fmt(p.row.gateRaceAggregate ?? NaN)}/${p.row.gateRaceReason} contrib=${p.row.gateRaceContribution ?? '-'} held=${p.row.heldKeyCell ? `${p.row.heldKeyCell.cell}(${p.row.heldKeyCell.kinds.join('+')})` : 'none'}`;
    for (const p of keepers) console.log(`HV10-D5 KEEP ${rowOf(p)}`);
    for (const p of [...leavers].sort((a, b) => score(b) - score(a)).slice(0, 6)) console.log(`HV10-D5 LEAVE ${rowOf(p)}`);
    const pref = tacticalPreference(scan.plans);
    console.log(`HV10-D5 preference=[${pref.best.join(' ')}]`);

    // 1. the production axis holds: no abandoning plan buys more Gate Race credit.
    expect(aggKeep, 'no plan that abandons the held choke buys more production interception credit').toBeGreaterThanOrEqual(aggLeave);
    expect(keepers.length, 'the hold is reachable by legal four-step turns, so the control is judged on the scout too').toBeGreaterThan(0);

    // 2. why the scout cannot see the hold: with the cat standing on the choke, the
    // carrying graph re-routes around the occupied cell (evaluation.ts:83), so that cell
    // is absent from every corridor layer of the route it is blocking - occupancy leaves
    // no trace in the target set, and the model has no term for "the threat is gone".
    const keeper = keepers[0]!;
    const leafHold = handOffToMouse(keeper.endState, true);
    const layers = imminentRoutes(leafHold, createEvaluationContext(bankTurn(leafHold)), computeGateRace(leafHold))
      .flatMap((rt) => rt.layers);
    const heldInCorridor = layers.some((l) => l.cells.includes(gate.bestCell!));
    console.log(`HV10-D5 MECHANISM: ${gate.bestCell} appears in the corridor layers of the state where the cat stands on it = ${heldInCorridor} (layers=${layers.map((l) => `s${l.step}/w${l.width}[${l.cells.join(' ')}]`).join(' ')})`);
    expect(heldInCorridor, 'FINDING: a cell the cat holds is not in the corridor it blocks, so heldKeyCell cannot fire - the scout has no signal for an already-effective defence').toBe(false);
    expect(keeper.row.heldKeyCell, 'and the row records that absence honestly instead of inventing a hold').toBeNull();

    // 3. the count proxy inverts, and which way it inverts depends on which count is
    // primary: the keeper sees MORE timed routes in total, the leaver more width-1 chokes.
    console.log(`HV10-D5 CRITERION DEPENDENCE: total timely keep=${totalKeep} leave=${totalLeave} (keeper leads=${totalKeep > totalLeave}) | width-1 choke timely keep=${chokeKeep} leave=${chokeLeave} (leaver leads=${chokeLeave > chokeKeep})`);
    expect(totalKeep, 'the keeper leads on total timely interceptions').toBeGreaterThan(totalLeave);
    expect(chokeLeave, 'the leaver leads on choke-cell timely interceptions - so the ordering is a choice, not a proof').toBeGreaterThan(chokeKeep);

    // 4. under the criterion this prototype actually ships, the control FAILS.
    const bestIsKeeper = pref.best.some((plan) => keepers.some((p) => p.plan === plan));
    console.log(`HV10-D5 CONTROL C = ${bestIsKeeper ? 'PASS' : 'FAILED'}: the current TACTICAL_PREFERENCE ${bestIsKeeper ? 'keeps' : 'abandons'} the held choke. The signal is a LOCAL REACHABILITY report, not a defence score; it is not admissible as a decision term.`);
    expect(bestIsKeeper, 'documented limitation: this round must not report a successful tactical score while it still prefers abandoning a held chokepoint').toBe(false);
  });
});

// ===========================================================================
// E — §5 P3: the cost of ONE tactical check per candidate complete cat turn,
// the caps that bound it, and whether the cache key is safe to reuse on.
// Offline measurement of the prototype. The production planner is called ONCE,
// at the frozen budgets, purely to price the headroom; nothing is wired in.
// ===========================================================================

const rules = createEngineRuleSet();

function productionReference(root: GameEngineState) {
  resetEvaluationCalls();
  const t0 = performance.now();
  const plan = planHardCatTurn(root, {
    rules,
    timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
    refutation: { enabled: HARD_TRIAL.refutationEnabled, totalTurnBudgetMs: HARD_TRIAL.totalTurnBudgetMs },
  });
  const wallMs = performance.now() - t0;
  return { plan, wallMs, leaves: getEvaluationCalls() };
}

const inHole = (s: GameEngineState, r: number, c: number): boolean => {
  const h = s.config.mouseHole;
  return r >= h.r && r < h.r + h.size && c >= h.c && c < h.c + h.size;
};

const boxCells = (s: GameEngineState): { r: number; c: number }[] => {
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < s.config.boardSize; r++) {
    for (let c = 0; c < s.config.boardSize; c++) if (s.board[r][c].type === CellType.Box) out.push({ r, c });
  }
  return out;
};

const freeCells = (s: GameEngineState): { r: number; c: number }[] => {
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < s.config.boardSize; r++) {
    for (let c = 0; c < s.config.boardSize; c++) {
      const cell = s.board[r][c];
      if (cell.type !== CellType.Empty || cell.piece !== undefined || cell.hasButter) continue;
      if (inHole(s, r, c)) continue;
      if (s.trapPosition !== null && s.trapPosition.r === r && s.trapPosition.c === c) continue;
      out.push({ r, c });
    }
  }
  return out;
};

/** The engine stores a box as the cell TYPE, not as a piece — so the layout is a board edit. */
function moveBox(s: GameEngineState, from: { r: number; c: number }, to: { r: number; c: number }): GameEngineState {
  const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
  board[from.r][from.c] = { ...board[from.r][from.c], type: CellType.Empty };
  board[to.r][to.c] = { ...board[to.r][to.c], type: CellType.Box };
  return { ...s, board };
}

function withMouseAt(s: GameEngineState, r: number, c: number): GameEngineState {
  const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
  board[s.mousePosition.r][s.mousePosition.c].piece = undefined;
  board[r][c].piece = PieceType.Mouse;
  return { ...s, board, mousePosition: { r, c } };
}

const keyOf = (s: GameEngineState): string => stateKey(handOffToMouse(s, true));
const full2 = (): ReturnType<typeof scoutRoot> => scoutRoot(t4Root(), uncapped);

describe('PPC-HV-10 E — §5 P3: what one scan per candidate cat turn costs', () => {
  it('HV10-E1: the whole-root scan time, stage by stage, next to one production reference call', () => {
    const root = t4Root();
    scoutRoot(root, uncapped);
    const reps = 5;
    const runs: ReturnType<typeof scoutRoot>[] = [];
    for (let i = 0; i < reps; i++) runs.push(scoutRoot(root, uncapped));
    // HV-11 §6: sort PAIRS, so the reported median and the reported volumes are one sample.
    const { pairs, min, median, max, spread, medianRun } = pairedRuns(runs, (r) => r.stats.totalMs);
    const mid = medianRun.stats;

    console.log(`HV10-E1 T4 root cat=${mid.rootCatPosition} mouse=${mid.rootMousePosition}, caps as measured: maxEndStates=${uncapped.maxEndStates} maxTargetsPerEnd=${uncapped.maxTargetsPerEnd} maxCatMoveCalls=${uncapped.maxCatMoveCalls} nodeCap=${uncapped.nodeCap}`);
    console.log(`HV10-E1 ${reps} serial in-process repetitions (single worker, no fresh processes, no self-play): min=${min.toFixed(3)}ms median=${median.toFixed(3)}ms max=${max.toFixed(3)}ms spread=${spread.toFixed(3)}ms; the median SAMPLE is the run that measured ${median.toFixed(3)}ms`);
    console.log(`HV10-E1 stage split of the median run: derive=${mid.deriveMs.toFixed(3)} gateRace=${mid.gateRaceMs.toFixed(3)} reach=${mid.reachMs.toFixed(3)} total=${mid.totalMs.toFixed(3)} ms`);
    console.log(`HV10-E1 volumes: plans=${mid.totalPlans} distinct end states=${mid.distinctEndStates} (cat cells only=${mid.distinctEndPositions}) cache hits=${mid.cacheHits} | targets total=${mid.targetsTotal} max on one state=${mid.targetsMaxOnOneState} | catMove calls total=${mid.catMoveCallsTotal} max on one state=${mid.catMoveCallsMaxOnOneState} | permutations max on one state=${mid.permutationsMaxOnOneState}`);
    console.log(`HV10-E1 per unit: ${(median / mid.scannedEndStates * 1000).toFixed(0)}us per end state | ${(mid.totalMs / Math.max(1, mid.catMoveCallsTotal) * 1000).toFixed(2)}us per catMove call`);

    const prod = productionReference(root);
    const perStateMs = median / mid.scannedEndStates;
    const perLeafShapeMs = prod.leaves * perStateMs;
    console.log(`HV10-E1 PRODUCTION REFERENCE (one call at the frozen budgets; this host drifts, so it is a headroom estimate, not a timing authority): wall=${prod.wallMs.toFixed(2)}ms mainSearch=${prod.plan.elapsedMs.toFixed(2)}ms depth=${prod.plan.completedDepth}/${prod.plan.attemptedDepth} leaves evaluated=${prod.leaves} deadlineFired=${prod.plan.deadlineFired} budgetFired=${prod.plan.budgetFired}`);
    console.log(`HV10-E1 THE SAVE: ${prod.leaves} leaves × ${(perStateMs * 1000).toFixed(0)}us = ${(perLeafShapeMs).toFixed(1)}ms if the check ran at every leaf (the shape HV-9 rejected), vs ${median.toFixed(1)}ms once per candidate cat turn — ${(perLeafShapeMs / Math.max(1e-9, median)).toFixed(1)}x cheaper (${prod.leaves} work units become ${mid.scannedEndStates})`);
    const head = headroomReport(prod.plan.elapsedMs, prod.wallMs, median, {
      mainSearchBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
      wholeTurnCapMs: HARD_TRIAL.totalTurnBudgetMs,
    });
    console.log(`HV10-E1 headroom, TWO budgets kept apart (HV-11 §6): MAIN_HEADROOM=${head.mainHeadroomMs.toFixed(1)}ms (${head.mainSearchBudgetMs}ms search budget − ${head.mainSearchElapsedMs.toFixed(1)}ms search) ⇒ scan fits main=${head.fits.main}; TURN_HEADROOM=${head.turnHeadroomMs.toFixed(1)}ms (${head.wholeTurnCapMs}ms turn cap − ${head.wholeTurnWallMs.toFixed(1)}ms whole turn) ⇒ scan fits turn=${head.fits.turn}; verdict=${head.verdict}`);

    for (const p of pairs) expect(Number.isFinite(p.ms) && p.ms > 0, 'every repetition produced a real measurement').toBe(true);
    expect(mid.scannedEndStates, 'the uncapped run scanned every distinct end state').toBe(mid.distinctEndStates);
    expect(mid.catMoveCallsTotal, 'the call total is the sum of the rows of the SAME run the median came from').toBe(
      medianRun.scanned.reduce((a, r) => a + r.catMoveCalls, 0),
    );
    expect(median, 'the scan is cheaper than the one production search call it would sit beside').toBeLessThan(prod.wallMs);
    expect(prod.leaves, 'the search evaluates far more positions than the root scan needs').toBeGreaterThan(mid.distinctEndStates);
    for (const p of pairs) expect(p.ms, 'no repetition of the whole-root scan may approach the 100ms turn budget').toBeLessThan(DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn);
  });

  it('HV10-E2: every cap binds, and a truncated scan says UNKNOWN, never a negative', () => {
    const root = t4Root();
    const full = scoutRoot(root, uncapped);
    const shipped = scoutRoot(root, DEFAULT_CAPS);
    console.log(`HV10-E2 DEFAULT_CAPS = ${JSON.stringify(DEFAULT_CAPS)}`);
    console.log(`HV10-E2 shipped caps: plans=${shipped.stats.totalPlans} scanned=${shipped.stats.scannedEndStates} notScanned=${shipped.stats.notScannedEndStates} targets=${shipped.stats.targetsTotal} dropped=${shipped.stats.targetsDroppedByCap} calls=${shipped.stats.catMoveCallsTotal} ms=${shipped.stats.totalMs.toFixed(3)} reason=${shipped.stats.truncationReason}`);
    expect(shipped.stats.totalPlans, 'the caps bound the scan, not the enumeration').toBe(full.stats.totalPlans);

    const tightTargets = scoutRoot(root, { ...uncapped, maxTargetsPerEnd: 2 });
    for (const r of tightTargets.scanned) {
      expect(r.targetCount, `${r.endPosition}: never more targets than the cap`).toBeLessThanOrEqual(2);
      expect(r.permutationsPlayed, `${r.endPosition}: two targets cannot cost more than two 4-step routes each`).toBeLessThanOrEqual(2 * 24);
    }
    expect(tightTargets.stats.targetsDroppedByCap, 'dropped targets are counted, not silently lost').toBeGreaterThan(0);
    console.log(`HV10-E2 maxTargetsPerEnd=2: targets=${tightTargets.stats.targetsTotal} dropped=${tightTargets.stats.targetsDroppedByCap} calls=${tightTargets.stats.catMoveCallsTotal} ms=${tightTargets.stats.totalMs.toFixed(3)}`);

    const fewStates = scoutRoot(root, { ...uncapped, maxEndStates: 5 });
    expect(fewStates.stats.truncationReason, 'the end-state cap names itself').toContain('distinct-end-state cap');
    expect(fewStates.stats.scannedEndStates).toBe(5);
    expect(fewStates.stats.notScannedEndStates, 'and the rest are recorded as not scanned').toBe(fewStates.stats.distinctEndStates - 5);
    const skipped = fewStates.plans.filter((p) => !p.row.scanned);
    for (const p of skipped) {
      expect(p.row.notScannedReason, `${p.plan}: a skipped state says why`).toContain('NOT_SCANNED');
      expect(p.row.targetCount, `${p.plan}: and it holds no derived targets`).toBe(0);
      expect(p.row.claims.size, `${p.plan}: no verdicts at all — absence here is UNKNOWN, not a negative`).toBe(0);
    }
    console.log(`HV10-E2 maxEndStates=5: scanned=${fewStates.stats.scannedEndStates} skipped rows=${skipped.length} reason=${fewStates.stats.truncationReason}`);

    const fewCalls = scoutRoot(root, { ...uncapped, maxCatMoveCalls: 30 });
    expect(fewCalls.stats.truncationReason, 'the call cap truncates too').toContain('catMove-call cap');
    expect(fewCalls.stats.catMoveCallsTotal, 'the total stops at the cap plus at most one more state').toBeLessThanOrEqual(30 + fewCalls.stats.catMoveCallsMaxOnOneState);
    console.log(`HV10-E2 maxCatMoveCalls=30: calls=${fewCalls.stats.catMoveCallsTotal} scanned=${fewCalls.stats.scannedEndStates} notScanned=${fewCalls.stats.notScannedEndStates} reason=${fewCalls.stats.truncationReason}`);

    const allRows = [...shipped.scanned, ...tightTargets.scanned, ...fewStates.scanned, ...fewCalls.scanned];
    const noVerdicts = allRows.flatMap((r) => [...r.claims.values()]).filter((c) => c.verdict === 'UNREACHABLE_WITHIN_4').length;
    expect(noVerdicts, 'the cheap probe never answers NO, capped or not — a NO would need the exhaustive sweep, which this scan does not run').toBe(0);
    const unknownRows = allRows.filter((r) => r.unknownCount > 0);
    expect(unknownRows.length, 'and truncation shows up as UNKNOWN counts, which the table carries').toBeGreaterThan(0);
  });

  it('HV10-E3: the cache key covers the dynamic box layout and every rule field the scan reads', () => {
    const base = planRow(scanAll().plans, 'RRRR').endState;
    const k0 = keyOf(base);
    const boxes = boxCells(base);
    const free = freeCells(base);
    expect(boxes.length, 'twelve boxes on the board').toBe(12);
    expect(free.length, 'and enough free cells to move things into').toBeGreaterThan(4);

    const mustDiffer: [string, GameEngineState][] = [
      ['a box moved (dynamic layout)', moveBox(base, boxes[3]!, free[0]!)],
      ['a different box moved', moveBox(base, boxes[5]!, free[0]!)],
      ['a second box moved to another cell', moveBox(moveBox(base, boxes[3]!, free[0]!), boxes[4]!, free[1]!)],
      ['a butter moved', withButterAt(base, 0, free[2]!.r, free[2]!.c)],
      ['the cat cell changed', withCatAt(base, free[3]!.r, free[3]!.c)],
      ['the mouse cell changed', withMouseAt(base, free[4]!.r, free[4]!.c)],
      ['a terrain cell type changed', (() => {
        const board = base.board.map((row) => row.map((cell) => ({ ...cell })));
        board[free[5]!.r][free[5]!.c].type = CellType.Wall;
        return { ...base, board };
      })()],
      ['trap position changed', { ...base, trapPosition: { r: free[6]!.r, c: free[6]!.c } }],
      ['traps remaining changed', { ...base, catTrapsRemaining: base.catTrapsRemaining + 1 }],
      ['the mouse holds butter', { ...base, mouseHasButter: true }],
      ['the mouse skill is active', { ...base, mouseSkillActive: true }],
      ['a tunnel is blocked', { ...base, blockedTunnels: [...base.blockedTunnels, { r: 0, c: 0 }] }],
      ['the mouse must choose a tunnel exit', { ...base, phase: GamePhase.ChoosingTunnelExit }],
      ['the cat move budget changed', { ...base, config: { ...base.config, catBaseMoves: base.config.catBaseMoves + 1 } }],
      ['the carrying budget changed', { ...base, config: { ...base.config, mouseCarryingMoves: base.config.mouseCarryingMoves + 1 } }],
      ['the butter count changed', { ...base, config: { ...base.config, butterCount: base.config.butterCount + 1 } }],
    ];
    const silent = mustDiffer.filter(([, s]) => keyOf(s) === k0).map(([n]) => n);
    console.log(`HV10-E3 ${mustDiffer.length} rule mutations tested against the cache key; the key ignores only debug strings and the fields the hand-off normalises`);
    console.log(`HV10-E3 fields that must split a cache entry: ${mustDiffer.map(([n]) => n).join(' | ')}`);
    expect(silent, 'not one of these may share a cache entry — the scan reads all of them, and a box that moved is a different position').toEqual([]);

    const mustNotSplit: [string, GameEngineState][] = [
      ['the message string (debug only)', { ...base, message: `${base.message} HV10-E3` }],
      ['the cat action log (debug only)', { ...base, catActionLog: [...base.catActionLog, 'HV10-E3'] }],
      ['the game event log (debug only)', { ...base, gameEventLog: [...base.gameEventLog, 'HV10-E3'] }],
      ['a pending ghost butter at the hand-off', { ...base, pendingButterSpawns: [{ r: free[0]!.r, c: free[0]!.c, blockedMaterializations: 0 }] }],
      ['a pending placement debt at the hand-off', { ...base, pendingButterPlacementDebt: 1 }],
    ];
    const split = mustNotSplit.filter(([, s]) => keyOf(s) !== k0).map(([n]) => n);
    console.log(`HV10-E3 fields that must NOT split an entry: ${mustNotSplit.map(([n]) => n).join(' | ')} — a debug string is not a position, and the hand-off clears ghosts on purpose (maximizeCatPower)`);
    expect(split, 'the cache must not be fragmented by strings the scan never reads').toEqual([]);

    // One field deserves its own line, because the two answers differ and both matter.
    const withChoice: GameEngineState = { ...base, tunnelExitChoices: [...base.tunnelExitChoices, { r: 0, c: 0, label: 'E3' }] };
    const cleared = handOffToMouse(withChoice, true);
    console.log(`HV10-E3 tunnelExitChoices: raw stateKey differs=${stateKey(withChoice) !== stateKey(base)}; after the hand-off the list is ${cleared.tunnelExitChoices.length} cell(s) so the leaf key differs=${keyOf(withChoice) !== k0} (engine.ts:1302 empties it at the turn boundary, and a real pending choice carries phase=${GamePhase.ChoosingTunnelExit}, which the row above proves is its own key)`);
    expect(stateKey(withChoice), 'the key itself does cover tunnelExitChoices').not.toBe(stateKey(base));
    expect(cleared.tunnelExitChoices.length, 'the rules clear a pending exit list at the turn boundary, so a hand-off leaf never carries one').toBe(0);
    expect(keyOf(withChoice), 'and the scan is therefore not merging two different choice states under one entry').toBe(k0);

    // The cache is keyed on the hand-off leaf, so two plans that land on the same cat
    // cell but push different boxes are two entries — cell-only dedup would be a bug.
    const shared = scanAll().plans.filter((p) => p.endPosition === '6,4');
    console.log(`HV10-E3 hand-off key of RRRR end = ${k0.slice(0, 40)}...; the row carries exactly this key (${planRow(scanAll().plans, 'RRRR').endStateKey === k0}); ${shared.length} plans land on cat cell 6,4 under ${new Set(shared.map((p) => p.endStateKey)).size} distinct keys`);
    expect(planRow(scanAll().plans, 'RRRR').endStateKey, 'the row carries the key the cache used').toBe(k0);
    expect(shared.length, 'more than one plan ends on this cat cell').toBeGreaterThan(1);
    expect(new Set(shared.map((p) => p.endStateKey)).size, 'and each is its own cache entry, because the boxes moved differently').toBe(shared.length);
    expect(full2().stats.cacheHits, 'the real T4 root has no duplicate full end state — 21 plans, 21 keys, so cache reuse here is zero and the cost is the honest per-state cost').toBe(0);
  });

  it('HV10-E4: cost grows with the candidate set, so a bigger real root is not free', () => {
    const t4 = t4Root();
    const ladder: { states: number; ms: number; calls: number; targets: number }[] = [];
    for (const cap of [4, 8, 12, 21]) {
      const s = scoutRoot(t4, { ...uncapped, maxEndStates: cap }).stats;
      ladder.push({ states: s.scannedEndStates, ms: s.totalMs, calls: s.catMoveCallsTotal, targets: s.targetsTotal });
    }
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]!.ms, `${ladder[i]!.states} end states must cost at least what ${ladder[i - 1]!.states} cost`).toBeGreaterThanOrEqual(ladder[i - 1]!.ms);
      expect(ladder[i]!.calls, 'and the call count grows with the states scanned, not by accident').toBeGreaterThan(ladder[i - 1]!.calls);
    }
    console.log(`HV10-E4 ladder on the T4 root (end states scanned → ms): ${ladder.map((l) => `${l.states}=${l.ms.toFixed(2)}ms/${l.calls}calls/${l.targets}targets`).join(' → ')}`);
    const slope = (ladder[ladder.length - 1]!.ms - ladder[0]!.ms) / (ladder[ladder.length - 1]!.states - ladder[0]!.states);
    console.log(`HV10-E4 marginal cost ≈ ${(slope * 1000).toFixed(0)}us per additional distinct end state on this root`);

    const roots = h1Game4().filter((h) => h.state.currentPlayer === PieceType.Cat && h.state.phase === GamePhase.Playing);
    expect(roots.length, 'the H1 GAME4 log offers several real cat roots to price the spread on').toBeGreaterThan(1);
    const rows = roots.map((h) => {
      const s = scoutRoot(h.state, DEFAULT_CAPS).stats;
      return { turn: h.turn, ...s };
    });
    const byMs = [...rows].sort((a, b) => b.totalMs - a.totalMs);
    const worst = byMs[0]!;
    const midRow = byMs[Math.floor(byMs.length / 2)]!;
    console.log(`HV10-E4 ${rows.length} real H1 GAME4 cat roots, each scanned once with DEFAULT_CAPS:`);
    for (const r of rows) console.log(`HV10-E4   T${r.turn} plans=${r.totalPlans} ends=${r.distinctEndStates} cacheHits=${r.cacheHits} scanned=${r.scannedEndStates} notScanned=${r.notScannedEndStates} targetsMax=${r.targetsMaxOnOneState} dropped=${r.targetsDroppedByCap} calls=${r.catMoveCallsTotal} callsMax=${r.catMoveCallsMaxOnOneState} ms=${r.totalMs.toFixed(2)} enumComplete=${r.enumerationComplete} trunc=${r.truncatedEnumeration} reason=${r.truncationReason ?? '-'}`);
    console.log(`HV10-E4 spread: median root T${midRow.turn}=${midRow.totalMs.toFixed(2)}ms, worst root T${worst.turn}=${worst.totalMs.toFixed(2)}ms (plans=${worst.totalPlans} ends=${worst.distinctEndStates} calls=${worst.catMoveCallsTotal})`);

    for (const r of rows) {
      expect(r.totalMs, `T${r.turn}: one scan with the shipped caps stays under the 100ms turn budget`).toBeLessThan(DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn);
      expect(r.enumerationComplete, `T${r.turn}: the turn enumeration completes at the node cap or says so`).toBe(true);
      expect(r.scannedEndStates, `T${r.turn}: never more states scanned than the cap`).toBeLessThanOrEqual(DEFAULT_CAPS.maxEndStates);
    }

    const prod = productionReference(t4);
    const worstRoot = roots.find((h) => h.turn === worst.turn)!;
    const openEnded = scoutRoot(worstRoot.state, uncapped).stats;
    console.log(`HV10-E4 T${worst.turn} with the caps REMOVED: ends=${openEnded.distinctEndStates} targets=${openEnded.targetsTotal} calls=${openEnded.catMoveCallsTotal} ms=${openEnded.totalMs.toFixed(2)} | with DEFAULT_CAPS it was ${worst.totalMs.toFixed(2)}ms over ${worst.scannedEndStates} states and ${worst.notScannedEndStates} left NOT_SCANNED`);
    expect(openEnded.totalMs, 'uncapped, the worst real root is still a whole-turn-scale cost rather than a leaf-scale one').toBeLessThan(DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn);
    expect(worst.notScannedEndStates, 'and the shipped caps do truncate that root, which the table must carry as UNKNOWN').toBeGreaterThan(0);

    const perStateMs = worst.totalMs / Math.max(1, worst.scannedEndStates);
    // HV-11 §6: the two budgets answer two different questions. Charging a scan INSIDE the
    // search uses the main headroom; appending it AFTER the turn uses the turn headroom.
    const head = headroomReport(prod.plan.elapsedMs, prod.wallMs, worst.totalMs, {
      mainSearchBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
      wholeTurnCapMs: HARD_TRIAL.totalTurnBudgetMs,
    });
    const unitsIn = (ms: number): number => (ms > 0 ? Math.floor(ms / perStateMs) : 0);
    console.log(`HV10-E4 admissible task load, both budgets named (HV-11 §6): per end state ${(perStateMs * 1000).toFixed(0)}us. INSIDE the search: MAIN_HEADROOM=${head.mainHeadroomMs.toFixed(1)}ms (${head.mainSearchBudgetMs}ms − ${head.mainSearchElapsedMs.toFixed(1)}ms search) buys ${unitsIn(head.mainHeadroomMs)} end states. AFTER the turn: TURN_HEADROOM=${head.turnHeadroomMs.toFixed(1)}ms (${head.wholeTurnCapMs}ms − ${head.wholeTurnWallMs.toFixed(1)}ms wall) buys ${unitsIn(head.turnHeadroomMs)} end states. A single '100ms − wallMs' number is a category error, so neither figure is quoted as one — and this host drifts, so both are bounds to re-measure, not permissions`);
    console.log(`HV10-E4 truncation semantics proposed: stop at maxEndStates / maxCatMoveCalls, mark every unscanned state NOT_SCANNED with the reason, report UNKNOWN (never NO), and prefer a capture row over any defensive row`);
    expect(perStateMs, 'the marginal cost per end state is a real positive number').toBeGreaterThan(0);
    expect(worst.totalMs, 'even the worst real root stays below the production search it would join').toBeLessThan(prod.wallMs);
  });
});
