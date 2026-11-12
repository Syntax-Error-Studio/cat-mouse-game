/// <reference types="node" />
/**
 * PPC-HV-5 §4 + §5 — early interception: could the cat have stopped the mouse
 * from taking the butter and getting it home, at Turn #4 and Turn #3?
 *
 * Three claims are kept apart throughout (task book §4):
 *   OBSERVED_MOUSE_ROUTE_BLOCKABLE  a concrete cat plan stops the route the mouse
 *                                   actually walked.
 *   VALID_DEFENSIVE_CAT_PLAN_EXISTS a concrete cat plan stops EVERY candidate
 *                                   mouse line the auditor can build from that root.
 *   FORCED_CAT_SURVIVAL_PROVEN      no mouse line of any kind wins after that plan.
 * The first two are decidable with a small candidate set; the third needs a
 * mouse-universal oracle, which §8 forbids this round, so it is reported as
 * NOT_ESTABLISHED rather than quietly inferred from the second.
 */
import { describe, expect, it } from 'vitest';
import { PieceType, GamePhase, DIRECTIONS, type Direction } from '../../types';
import { mouseStepDeterministic, setWorldEntropySource } from '../../engine';
import type { GameEngineState } from '../../engine';
import { stateKey } from '../transposition';
import {
  auditMouseLine, boardText, catMarchSteps, enumerateCatTurnExact, h1Turn, handOffToMouse, holeCells,
  rc, replayCatPlan, walkMouseSegment, withCatAt, type CatBranch,
} from './hv5ForcedLineAuditor';

/** Ghost butter is drawn with the world entropy source; pin it so runs repeat. */
function withEntropy<T>(draw: () => number, fn: () => T): T {
  setWorldEntropySource(draw);
  try { return fn(); } finally { setWorldEntropySource(null); }
}

type MouseWalk = { cells: string[]; end: GameEngineState; kind: 'handoff' | 'tunnel' | 'win' };

/** Turn endings that are the same kernel state counted once, whatever path wrote them. */
function distinctEndStates(ends: CatBranch[]): Map<string, GameEngineState> {
  const out = new Map<string, GameEngineState>();
  for (const e of ends) out.set(stateKey(e.state), e.state);
  return out;
}

/** The action sequence the enumerator attached to that exact ending state. */
function planOf(ends: CatBranch[], target: GameEngineState): string[] {
  const k = stateKey(target);
  return ends.find((e) => stateKey(e.state) === k)!.plan;
}

/**
 * Every walk the REAL step function accepts for one mouse turn. A refused step
 * spends nothing, so a turn always ends by spending the whole budget, by the trap
 * (all remaining moves lost) or by a tunnel entry — the human mouse has no
 * "end turn early" control; GamePage.tsx:155-165 hands off only through the kernel.
 */
function mouseWalks(start: GameEngineState, maxSteps: number): MouseWalk[] {
  const out: MouseWalk[] = [];
  const step = (s: GameEngineState, cells: string[]): void => {
    if (s.phase === GamePhase.MouseWins) { out.push({ cells, end: s, kind: 'win' }); return; }
    if (s.phase === GamePhase.ChoosingTunnelExit) { out.push({ cells, end: s, kind: 'tunnel' }); return; }
    if (s.currentPlayer !== PieceType.Mouse || s.mouseMovesLeft <= 0 || cells.length >= maxSteps) {
      out.push({ cells, end: s, kind: 'handoff' });
      return;
    }
    for (const d of DIRECTIONS) {
      const n = mouseStepDeterministic(s, d as Direction);
      const spent = rc(n.mousePosition) !== rc(s.mousePosition) || n.mouseMovesLeft !== s.mouseMovesLeft;
      if (!spent) continue;
      step(n, [...cells, rc(n.mousePosition)]);
    }
  };
  step(start, []);
  return out;
}

/**
 * `catMarchSteps` (fewest real cat steps to a cell) lives in the audited
 * forensics module, so the cause suite ranks plans with the same metric.
 */
const shape = (n: number) => {  const t = h1Turn(n);
  const s = t.state;
  return {
    turn: n,
    cat: rc(s.catPosition),
    mouse: rc(s.mousePosition),
    carrying: s.mouseHasButter,
    butter: s.butterPositions.map(rc),
    pending: s.pendingButterSpawns.map(rc),
    trap: s.trapPosition ? rc(s.trapPosition) : null,
    trapsLeft: s.catTrapsRemaining,
    blockedTunnels: s.blockedTunnels.map(rc),
    player: s.currentPlayer,
    catMovesLeft: s.catMovesLeft,
    hole: holeCells(s).map(rc),
    boardSize: s.config.boardSize,
    catBaseMoves: s.config.catBaseMoves,
    mouseBaseMoves: s.config.mouseBaseMoves,
    mouseCarryingMoves: s.config.mouseCarryingMoves,
    plan: t.loggedPlan,
    search: t.loggedSearch,
  };
};

describe('PPC-HV-5 §4 P1 — Turn #4 and the butter pickup', () => {
  it('HV5-B0: the three snapshots, their boards and the logged plans', () => {
    for (const n of [3, 4, 5]) {
      console.log(`\nHV5-B0 shape(${n}) ` + JSON.stringify(shape(n)));
      console.log(`HV5-B0 board(${n})\n${boardText(h1Turn(n).state)}`);
    }
    const t4 = h1Turn(4);
    console.log(`HV5-B0 T4 root_actions ${t4.loggedRootActions.join(' | ')}`);
    console.log(`HV5-B0 T4 deadline ${t4.loggedDeadline}`);
    const t3 = h1Turn(3);
    console.log(`HV5-B0 T3 root_actions ${t3.loggedRootActions.join(' | ')}`);
    console.log(`HV5-B0 T3 search ${t3.loggedSearch}`);
    expect([shape(3).cat, shape(4).cat, shape(5).cat]).toEqual(['7,3', '5,1', '2,2']);
    expect([shape(3).mouse, shape(4).mouse, shape(5).mouse]).toEqual(['0,9', '1,8', '1,8']);
  });

  it('HV5-B1: the candidate pickup route is legal and rebuilds Turn #5', () => {
    const t4 = h1Turn(4);
    const logged = t4.loggedPlan.replace(/[^UDLR]/g, '');
    console.log(`HV5-B1 T4 logged plan tokens=${logged}`);
    const afterCat = replayCatPlan(t4.state, logged.split(''));
    console.log(`HV5-B1 cat replay illegalAt=${afterCat.illegalAt} end=${rc(afterCat.end.catPosition)} movesLeft=${afterCat.end.catMovesLeft}`);
    expect(rc(afterCat.end.catPosition)).toBe(rc(h1Turn(5).state.catPosition));

    // real Cat→Mouse boundary (this is where the ghost Turn #5 carries is drawn)
    const mouseTurn = withEntropy(() => 0.5, () => handOffToMouse(afterCat.end, false));
    const route = ['1,7', '1,6', '1,7', '1,8'];
    const walk = walkMouseSegment(mouseTurn, route);
    const w = walk.state;
    console.log(`HV5-B1 walk status=${walk.status} why="${walk.why}" walked=${walk.walked}`);
    console.log(`HV5-B1 walk end mouse=${rc(w.mousePosition)} carrying=${w.mouseHasButter} butter=${w.butterPositions.map(rc).join('/')} movesLeft=${w.mouseMovesLeft} player=${w.currentPlayer} phase=${w.phase} trap=${w.trapPosition ? rc(w.trapPosition) : 'none'} pending=${w.pendingButterSpawns.map(rc).join('/')} vs T5 pending=${h1Turn(5).state.pendingButterSpawns.map(rc).join('/')}`);
    expect(walk.status, `route must not break: ${walk.why}`).not.toBe('BROKEN');
    expect([rc(w.mousePosition), w.mouseHasButter, w.butterPositions.map(rc).join(','), w.phase])
      .toEqual(['1,8', true, '3,2', GamePhase.Playing]);

    // field-by-field reconciliation against the real Turn #5 snapshot
    const t5 = h1Turn(5).state;
    const fields: Record<string, (s: GameEngineState) => string> = {
      phase: (s) => String(s.phase),
      currentPlayer: (s) => String(s.currentPlayer),
      cat: (s) => rc(s.catPosition),
      mouse: (s) => rc(s.mousePosition),
      mouseHasButter: (s) => String(s.mouseHasButter),
      mouseSkillActive: (s) => String(s.mouseSkillActive),
      mouseMovesLeft: (s) => String(s.mouseMovesLeft),
      catMovesLeft: (s) => String(s.catMovesLeft),
      butter: (s) => s.butterPositions.map(rc).sort().join('/'),
      trap: (s) => (s.trapPosition ? rc(s.trapPosition) : 'none'),
      catTrapsRemaining: (s) => String(s.catTrapsRemaining),
      blockedTunnels: (s) => s.blockedTunnels.map(rc).sort().join('/'),
      board: (s) => s.board.map((row) => row.map((c) => `${c.type}${c.piece ?? '-'}`).join('')).join(''),
      pending: (s) => s.pendingButterSpawns.map(rc).sort().join('/'),
    };
    const rows = Object.entries(fields).map(([k, get]) => `${k}=${get(w) === get(t5) ? 'same' : `DIFF reconstructed="${get(w)}" logged="${get(t5)}" ${k}`}`);
    console.log(`HV5-B1 T4+UUUR+route vs T5: ${rows.join(' ')}`);
    const chanceDependent = ['pending'];
    const diffs = Object.entries(fields)
      .filter(([k, get]) => !chanceDependent.includes(k) && get(w) !== get(t5))
      .map(([k]) => k);
    console.log(`HV5-B1 non-chance mismatches=${JSON.stringify(diffs)}`);
    expect(diffs, 'the route must reproduce the real Turn #5 position').toEqual([]);
  });

  it('HV5-B2: do the two snapshots pin that route, or only its endpoints?', () => {
    const t4 = h1Turn(4);
    const logged = t4.loggedPlan.replace(/[^UDLR]/g, '');
    const mouseTurn = withEntropy(() => 0.5, () => handOffToMouse(replayCatPlan(t4.state, logged.split('')).end, false));
    const walks = mouseWalks(mouseTurn, mouseTurn.config.mouseBaseMoves);
    const home = walks.filter((x) => x.end.mouseHasButter && rc(x.end.mousePosition) === '1,8');
    const backEmpty = walks.filter((x) => !x.end.mouseHasButter && rc(x.end.mousePosition) === '1,8');
    console.log(`HV5-B2 T4 mouse-turn walks=${walks.length} end@1,8 carrying=${home.length} end@1,8 empty=${backEmpty.length} kinds=${JSON.stringify(walks.reduce<Record<string, number>>((a, x) => { a[x.kind] = (a[x.kind] ?? 0) + 1; return a; }, {}))}`);
    console.log(`HV5-B2 carrying-home routes=${home.map((x) => x.cells.join('>')).join(' || ') || 'none'}`);
    console.log(`HV5-B2 endpoint-only routes=${backEmpty.slice(0, 12).map((x) => x.cells.join('>')).join(' || ') || 'none'}`);
    const cells = home.map((x) => x.cells.join(','));
    expect(cells, 'the snapshot pair pins exactly one butter-carrying home route').toEqual(['1,7,1,6,1,7,1,8']);
    // the tunnel is the only way a turn could end elsewhere than its 4 steps; its
    // exits are corner cells, so no teleport walk can reach the observed endpoint.
    const tunnelEnds = walks.filter((x) => x.kind === 'tunnel');
    const exits = new Set(tunnelEnds.flatMap((x) => x.end.tunnelExitChoices.map((e) => rc(e))));
    console.log(`HV5-B2 tunnel-entry walks=${tunnelEnds.length} exit cells=${[...exits].sort().join(' ')}`);
    expect(exits.has('1,8'), 'no tunnel exit lands on the observed Turn #5 cell').toBe(false);
  });

  it('HV5-B3: can any Turn #4 plan stop the pickup itself?', () => {
    const t4 = h1Turn(4);
    const turn = enumerateCatTurnExact([{ state: t4.state, plan: [] }], 20_000);
    expect(turn.truncated).toBe(false);
    const ends = distinctEndStates(turn.ends);
    const route = ['1,7', '1,6', '1,7', '1,8'];
    const broken = [...ends.entries()].filter(([, e]) => walkMouseSegment(handOffToMouse(e, true), route).status === 'BROKEN').map(([k]) => k);
    const cells = [...ends.values()].map((e) => rc(e.catPosition));
    const onCorridor = cells.filter((c) => ['1,7', '1,6'].includes(c));
    const rightMost = Math.max(...cells.map((c) => Number(c.split(',')[1])));
    console.log(`HV5-B3 T4 distinct endings=${ends.size} end cells=${cells.length} pickup-blocking=${broken.length} sitting-on-1,7/1,6=${onCorridor.length} rightmost column reached=${rightMost}`);
    console.log(`HV5-B3 T4 end cells=${[...new Set(cells)].sort().join(' ')}`);
    expect(broken, 'the cat is 10 steps from the butter cell and has 4').toEqual([]);
    expect(onCorridor).toEqual([]);
    expect(rightMost).toBeLessThan(7);
  });

  it('HV5-B4: the observed line, pinned to each Turn #4 plan', () => {
    const t4 = h1Turn(4);
    const observed = ['1,7', '1,6', '1,7', '1,8', '2,8', '3,8', '4,8', '5,8', '6,8', '7,8'];
    // ghost-suppressed = the strongest cat, so a FORCED_WIN proved here holds in
    // every chance world (a butter cell only ever removes cat options).
    const OPT = { maxCatTurns: 4, nodeCap: 20_000, maximizeCatPower: true } as const;
    const free = auditMouseLine(t4.state, observed, OPT);
    console.log(`HV5-B4 unpinned ∀: ${free.outcome} :: "${free.detail}" nodes=${free.nodes} branches=${free.branches} witness=[${(free.witnessPlan ?? []).join('')}]`);

    const turn = enumerateCatTurnExact([{ state: t4.state, plan: [] }], 20_000);
    const ends = distinctEndStates(turn.ends);
    const rows: string[] = [];
    const fatal: string[] = [];
    const holding: string[] = [];
    let nodes = 0;
    for (const [, e] of ends) {
      const plan = planOf(turn.ends, e).join('');
      const r = auditMouseLine(t4.state, observed, { ...OPT, forceFirstPlan: plan.split('') });
      nodes += r.nodes;
      rows.push(`${plan}=${r.outcome}`);
      if (r.outcome === 'FORCED_WIN') fatal.push(plan);
      else holding.push(`${plan}→[${(r.witnessPlan ?? []).join('')}]${r.outcome}`);
    }
    const byFirst = (list: string[]) => ['U', 'R', 'D', 'L'].map((d) => `${d}:${list.filter((p) => p.startsWith(d)).length}`).join(' ');
    const firsts = rows.map((r) => r[0]);
    console.log(`HV5-B4 endings=${ends.size} nodes=${nodes}`);
    console.log(`HV5-B4 rows ${rows.join(' ')}`);
    console.log(`HV5-B4 ALL by first action ${byFirst(firsts)}`);
    console.log(`HV5-B4 FATAL(${fatal.length}) by first action ${byFirst(fatal)} :: ${fatal.join(' ')}`);
    console.log(`HV5-B4 HELD(${holding.length}) by first action ${byFirst(holding)} :: ${holding.slice(0, 6).join(' | ')}`);

    const logged = t4.loggedPlan.replace(/[^UDLR]/g, '');
    const loggedAudit = auditMouseLine(t4.state, observed, { ...OPT, forceFirstPlan: logged.split('') });
    const witness = (free.witnessPlan ?? []).slice(0, 4).join('');
    const witnessAudit = auditMouseLine(t4.state, observed, { ...OPT, forceFirstPlan: witness.split('') });
    console.log(`HV5-B4 logged ${logged} pinned → ${loggedAudit.outcome} :: "${loggedAudit.detail}"`);
    console.log(`HV5-B4 witness first turn ${witness} pinned → ${witnessAudit.outcome}`);
    // the same two verdicts under the REAL chance model, so the sweep is not an
    // artefact of suppressing ghost butter
    const real = { maxCatTurns: 4, nodeCap: 20_000, maximizeCatPower: false } as const;
    const realVerdicts = withEntropy(() => 0.5, () => [
      auditMouseLine(t4.state, observed, { ...real, forceFirstPlan: logged.split('') }).outcome,
      auditMouseLine(t4.state, observed, { ...real, forceFirstPlan: witness.split('') }).outcome,
      auditMouseLine(t4.state, observed, real).outcome,
    ]);
    console.log(`HV5-B4 real-chance verdicts (logged/witness/unpinned) = ${realVerdicts.join(' ')}`);
    expect([free.outcome, loggedAudit.outcome, witnessAudit.outcome]).toEqual(['NOT_FORCED', 'FORCED_WIN', 'NOT_FORCED']);
    expect(realVerdicts).toEqual(['FORCED_WIN', 'NOT_FORCED', 'NOT_FORCED']);
    expect(fatal.length, 'the fatal first-action families must be reported, not averaged').toBeGreaterThan(0);
    expect(holding.length).toBeGreaterThan(0);
    expect(nodes, 'the sweep must stay inside the light-weight budget').toBeLessThan(200_000);
  });
});

describe('PPC-HV-5 §5 P2 — Turn #3', () => {
  it('HV5-C0: the Turn #3 → Turn #4 mouse route is not pinned by the log', () => {
    const t3 = h1Turn(3);
    const logged = t3.loggedPlan.replace(/[^UDLR]/g, '');
    const afterCat = replayCatPlan(t3.state, logged.split(''));
    console.log(`HV5-C0 T3 plan=${logged} illegalAt=${afterCat.illegalAt} catEnd=${rc(afterCat.end.catPosition)} (T4 root cat=${rc(h1Turn(4).state.catPosition)})`);
    expect(rc(afterCat.end.catPosition)).toBe(rc(h1Turn(4).state.catPosition));
    const mouse = withEntropy(() => 0.5, () => handOffToMouse(afterCat.end, false));
    const walks = mouseWalks(mouse, mouse.config.mouseBaseMoves);
    const toT4 = walks.filter((x) => rc(x.end.mousePosition) === '1,8' && !x.end.mouseHasButter);
    console.log(`HV5-C0 T3 mouse walks=${walks.length} ending@1,8 empty=${toT4.length} kinds=${JSON.stringify(walks.reduce<Record<string, number>>((a, x) => { a[x.kind] = (a[x.kind] ?? 0) + 1; return a; }, {}))}`);
    console.log(`HV5-C0 T3→T4 routes=${toT4.map((x) => x.cells.join('>')).join(' || ') || 'none'}`);
    expect(toT4.length, 'several routes reach the observed endpoint, so the log pins a position, not a walk').toBeGreaterThan(1);
  });

  it('HV5-C1: was the observed line already forced at Turn #3?', () => {
    const t3 = h1Turn(3);
    // one of the twelve legal Turn #3 → Turn #4 routes, then the pinned pickup and
    // the two carrying runs: the whole line the game actually walked.
    const line = ['0,8', '0,7', '1,7', '1,8', '1,7', '1,6', '1,7', '1,8', '2,8', '3,8', '4,8', '5,8', '6,8', '7,8'];
    const OPT = { maxCatTurns: 4, nodeCap: 20_000, maximizeCatPower: true } as const;
    const free = auditMouseLine(t3.state, line, OPT);
    console.log(`HV5-C1 T3 unpinned ∀: ${free.outcome} :: "${free.detail}" nodes=${free.nodes} branches=${free.branches} witness=[${(free.witnessPlan ?? []).join('')}]`);
    const logged = t3.loggedPlan.replace(/[^UDLR]/g, '');
    const loggedAudit = auditMouseLine(t3.state, line, { ...OPT, forceFirstPlan: logged.split('') });
    console.log(`HV5-C1 T3 logged ${logged} pinned → ${loggedAudit.outcome} :: "${loggedAudit.detail}" nodes=${loggedAudit.nodes}`);
    expect([free.outcome, loggedAudit.outcome]).toEqual(['NOT_FORCED', 'NOT_FORCED']);
  });

  it('HV5-C2: which Turn #3 endings leave a defence at Turn #4 (same-board roots)', () => {
    const t3 = h1Turn(3);
    const t4 = h1Turn(4);
    const observed = ['1,7', '1,6', '1,7', '1,8', '2,8', '3,8', '4,8', '5,8', '6,8', '7,8'];
    const turn = enumerateCatTurnExact([{ state: t3.state, plan: [] }], 20_000);
    expect(turn.truncated).toBe(false);
    const ends = distinctEndStates(turn.ends);
    const t4Board = JSON.stringify(t4.state.board.map((row) => row.map((c) => c.type)));
    // the blocking cell the Turn #4 defence used was (4,8); rank the Turn #3
    // endings by the REAL march still needed to reach it, not by Manhattan
    const candidates = [...ends.values()]
      .filter((e) => JSON.stringify(e.board.map((row) => row.map((c) => c.type))) === t4Board)
      .filter((e) => !(e.catPosition.r === t4.state.mousePosition.r && e.catPosition.c === t4.state.mousePosition.c))
      .map((e) => ({ cell: rc(e.catPosition), march: catMarchSteps(e, '4,8'), plan: planOf(turn.ends, e).join('') }))
      .sort((a, b) => (a.march < 0 ? 999 : a.march) - (b.march < 0 ? 999 : b.march));
    console.log(`HV5-C1 T3 endings=${ends.size} same-board=${candidates.length} nearest-to-(4,8)=${candidates.slice(0, 5).map((s) => `${s.cell}:${s.march}`).join(' ')}`);

    // derived root = the real Turn #4 position with the cat left where Turn #3 ended
    const self = withCatAt(t4.state, 5, 1);
    console.log(`HV5-C2 derived root at 5,1 identical to the logged Turn #4 root: ${stateKey(self) === stateKey(t4.state)}`);
    expect(stateKey(self), 'the derived-root construction must be exact at the real cell').toBe(stateKey(t4.state));

    const held: string[] = [];
    const lost: string[] = [];
    let nodes = 0;
    for (const c of candidates) {
      const [r, col] = c.cell.split(',').map(Number);
      const root = withCatAt(t4.state, r, col);
      const a = auditMouseLine(root, observed, { maxCatTurns: 4, nodeCap: 20_000, maximizeCatPower: true });
      nodes += a.nodes;
      (a.outcome === 'FORCED_WIN' ? lost : held).push(`${c.cell}(march ${c.march},${a.outcome})`);
    }
    console.log(`HV5-C2 roots=${candidates.length} nodes=${nodes} LOST=${lost.join(' ')} || HELD=${held.slice(0, 10).join(' ')}${held.length > 10 ? ` …(${held.length} total)` : ''}`);
    expect(held.length, 'Turn #3 endings that still defend must be named').toBeGreaterThan(0);
    expect(nodes, 'the derived-root sweep must stay light').toBeLessThan(400_000);
  });
});
