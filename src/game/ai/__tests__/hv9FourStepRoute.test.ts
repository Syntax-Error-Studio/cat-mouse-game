/// <reference types="node" />
/**
 * PPC-HV-9 P0 — the four-step route (5,5) → (4,8), found by the real engine or not at all.
 *
 * HV-7's depth-12 prover priced this cell at 4 steps; HV-8's walk→push→walk witness model
 * could not beat the 20-step walk. One of the two instruments describes the rules
 * differently, and §三 settles it the cheap way: (5,5)→(4,8) is Manhattan 4, so ANY legal
 * four-step route is one `U` and three `R` in some order — four sequences, at most sixteen
 * steps, every one executed by the production `catMove` under a SINGLE four-move budget
 * (no refill inside a route, no trap placement, mouse frozen where HV-7 and HV-8 froze it).
 *
 * INSTRUMENT ONLY. Nothing here is read by production code.
 */
import { describe, expect, it } from 'vitest';
import { catMove, type GameEngineState } from '../../engine';
import { GamePhase, PieceType, type Direction } from '../../types';
import { buildCatDistanceMap } from '../evaluation';
import {
  catActions,
  h1Turn,
  handOffToMouse,
  rc,
  replayCatPlan,
  tokenToDirection,
} from './hv5ForcedLineAuditor';
import { boxLayout } from './hv8WitnessPush';

const START = '5,5';
const TARGET = '4,8';

/** The counterfactual view: cat turn, four fresh moves, every board element untouched. */
function viewOf(s: GameEngineState): GameEngineState {
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    phase: s.phase === GamePhase.Playing ? GamePhase.Playing : s.phase,
    catMovesLeft: s.config.catBaseMoves,
  };
}

interface StepRecord {
  token: string;
  from: string;
  to: string;
  pushed: string | null;
  boxesBefore: string;
  boxesAfter: string;
  legal: boolean;
  terminal: string | null;
  movesLeft: number;
  capturedMouse: boolean;
}

/** Which box moved, in engine terms: compare the two layouts cell by cell. */
function pushDelta(before: GameEngineState, after: GameEngineState): string | null {
  const b = new Set(boxLayout(before).split(' ').filter(Boolean));
  const a = new Set(boxLayout(after).split(' ').filter(Boolean));
  const vacated = [...b].filter((c) => !a.has(c));
  const landed = [...a].filter((c) => !b.has(c));
  if (vacated.length === 0) return null;
  return `${vacated[0]}>${landed[0] ?? '?'}`;
}

/**
 * Real engine, ONE budget, no refill: the view carries four moves, so `catMove` itself
 * refuses a fifth step (`catMovesLeft <= 0`), which is what makes "four moves" mean
 * four moves here rather than four steps of an unlimited march.
 */
function marchOnce(view: GameEngineState, tokens: string[]): { steps: StepRecord[]; end: GameEngineState } {
  const steps: StepRecord[] = [];
  let cur = view;
  for (const token of tokens) {
    const before = cur;
    const after = catMove(before, tokenToDirection(token) as Direction);
    const moved = rc(after.catPosition) !== rc(before.catPosition);
    steps.push({
      token,
      from: rc(before.catPosition),
      to: rc(after.catPosition),
      pushed: moved ? pushDelta(before, after) : null,
      boxesBefore: boxLayout(before),
      boxesAfter: boxLayout(after),
      legal: moved,
      terminal: after.phase !== before.phase ? after.phase : null,
      movesLeft: after.catMovesLeft,
      capturedMouse: rc(after.catPosition) === rc(after.mousePosition),
    });
    cur = after;
    if (after.phase !== GamePhase.Playing) break;
  }
  return { steps, end: cur };
}

const rrrrView = (): GameEngineState => viewOf(replayCatPlan(h1Turn(4).state, ['R', 'R', 'R', 'R']).end);

describe('PPC-HV-9 A — provenance: the same view HV-7 and HV-8 measured', () => {
  it('HV9-A1: T4 root then RRRR puts the cat at (5,5) with the board untouched', () => {
    const root = h1Turn(4).state;
    console.log(`HV9-A1 T4 root: cat=${rc(root.catPosition)} mouse=${rc(root.mousePosition)} phase=${root.phase} player=${root.currentPlayer} catMoves=${root.catMovesLeft} trapsLeft=${root.catTrapsRemaining} trap=${root.trapPosition ? rc(root.trapPosition) : 'none'} butter=[${root.butterPositions.map(rc).join(' ')}]`);
    const replayed = replayCatPlan(root, ['R', 'R', 'R', 'R']);
    expect(replayed.illegalAt, 'RRRR is legal on the real engine').toBeNull();
    expect(replayed.applied.length, 'all four steps applied').toBe(4);
    const end = replayed.end;
    const view = viewOf(end);
    expect(rc(view.catPosition), 'the cat stands at (5,5)').toBe(START);
    expect(view.catMovesLeft, 'the counterfactual view restores four moves').toBe(4);
    expect(boxLayout(view), 'restoring the budget changed no box').toBe(boxLayout(end));
    expect(rc(view.catPosition), 'and no piece moved either').toBe(rc(end.catPosition));
    const leaf = handOffToMouse(end, true);
    expect(rc(leaf.mousePosition), 'the mouse did not move between the leaf and this view').toBe(rc(end.mousePosition));
    console.log(`HV9-A1 after RRRR: cat=${rc(view.catPosition)} mouse=${rc(leaf.mousePosition)} phase=${view.phase} trapsLeft=${view.catTrapsRemaining} trap=${view.trapPosition ? rc(view.trapPosition) : 'none'} butter=[${view.butterPositions.map(rc).join(' ')}] blockedTunnels=[${view.blockedTunnels.map(rc).join(' ')}]`);
    console.log(`HV9-A1 boxes(${boxLayout(view).split(' ').filter(Boolean).length})=[${boxLayout(view)}]`);
    const walk = buildCatDistanceMap(view);
    console.log(`HV9-A1 walk field from (5,5): cells=${walk.size} ${TARGET}=${walk.get(TARGET) ?? '∞'} mouse=${walk.get(rc(leaf.mousePosition)) ?? '∞'} — HV-7 B1 printed 20 and 17, HV-8 D3 printed 20 and 17`);
    expect(walk.get(TARGET), 'the static walk value both earlier rounds saw').toBe(20);
    expect(walk.get(rc(leaf.mousePosition)), 'and the cat-to-mouse walk value').toBe(17);
    expect(boxLayout(view).split(' ').filter(Boolean).length, 'twelve boxes, as the config says').toBe(view.config.boxCount);
  });
});

describe('PPC-HV-9 B — the only four sequences a Manhattan-4 route can be', () => {
  const PLANS = ['URRR', 'RURR', 'RRUR', 'RRRU'];

  it('HV9-B1: each candidate stepped through the real catMove under one budget', () => {
    const view = rrrrView();
    const verified: string[] = [];
    for (const plan of PLANS) {
      const { steps, end } = marchOnce(view, plan.split(''));
      const trace = steps.map((s) => `${s.from}-${s.token}→${s.to}${s.pushed ? `[push ${s.pushed}]` : ''}${s.legal ? '' : '[REFUSED]'}${s.terminal ? `[${s.terminal}]` : ''}`).join(' ');
      const pushes = steps.filter((s) => s.pushed !== null);
      const arrived = rc(end.catPosition) === TARGET && steps.every((s) => s.legal);
      if (arrived) verified.push(plan);
      console.log(`HV9-B1 ${plan}: ${trace} | end=${rc(end.catPosition)} movesLeft=${end.catMovesLeft} steps=${steps.length} pushes=${pushes.length}${pushes.length ? ` [${pushes.map((s) => s.pushed).join(' ')}]` : ''} arrived=${arrived}`);
      const firstPush = steps.find((s) => s.pushed !== null);
      if (firstPush !== undefined) console.log(`HV9-B1 ${plan} boxes after that push: [${firstPush.boxesAfter}]`);
    }
    console.log(`HV9-B1 verdict: four-step witnesses the engine accepts = ${verified.length ? verified.join(',') : 'NONE'}`);
    console.log(`HV9-B1 CASE readout: NONE means HV-7's saved 4-step price must be withdrawn (CASE C); a witness with zero or one push means HV-8 missed a route that exists (CASE B); a witness with two or more pushes means the route is outside the one-push family (CASE A)`);
    expect(verified.length, 'this line reports the case, it does not force an outcome').toBeGreaterThanOrEqual(0);
  });

  it('HV9-B2: exhaustive depth-4 cross-check over every legal action, not only monotone ones', () => {
    const view = rrrrView();
    let nodes = 0;
    const arrivals: { plan: string; pushes: number; chain: boolean; terminal: boolean }[] = [];
    const seenStates = new Set<string>();
    const walk = (s: GameEngineState, plan: string[], pushes: number, pushed: string[]): void => {
      if (rc(s.catPosition) === TARGET) {
        arrivals.push({ plan: plan.join(''), pushes, chain: new Set(pushed).size < pushed.length, terminal: s.phase !== GamePhase.Playing });
        return;
      }
      if (plan.length >= view.config.catBaseMoves) return;
      for (const a of catActions(s)) {
        if (a.token === 'P') continue;
        nodes++;
        const before = boxLayout(s);
        const after = boxLayout(a.state);
        const delta = before === after ? null : pushDelta(s, a.state);
        walk(a.state, [...plan, a.token], pushes + (delta === null ? 0 : 1), delta === null ? pushed : [...pushed, delta]);
      }
    };
    walk(view, [], 0, []);
    // Deduplication note: this sweep is a plain tree (no state merging), so a box layout
    // that leads to the same cell twice is still counted twice — depth 4 makes that cheap.
    for (const a of arrivals) seenStates.add(`${a.plan}|${a.pushes}`);
    const best = arrivals.length ? Math.min(...arrivals.map((a) => a.plan.length)) : Infinity;
    console.log(`HV9-B2 depth-4 tree from (5,5): nodes=${nodes} distinct arrival plans=${seenStates.size} arrivals=${arrivals.length ? arrivals.map((a) => `${a.plan}@${a.plan.length}push${a.pushes}${a.chain ? '(same box chained)' : ''}${a.terminal ? '+CAPTURE' : ''}`).join(', ') : 'NONE'}`);
    console.log(`HV9-B2 shortest arrival = ${best === Infinity ? 'NONE' : `${best} steps`}`);
    expect(nodes, 'a depth-4 tree is a handful of states, not an oracle run').toBeLessThan(5000);
    for (const a of arrivals) {
      expect(a.plan.length, 'every recorded arrival stays inside four moves').toBeLessThanOrEqual(4);
      expect(a.pushes, 'and its push count comes from the engine layout delta').toBeGreaterThanOrEqual(0);
    }
    const monotone = arrivals.filter((a) => [...a.plan].sort().join('') === 'RRRU');
    console.log(`HV9-B2 monotone (one U, three R) arrivals: ${monotone.length ? monotone.map((a) => `${a.plan}/push${a.pushes}`).join(', ') : 'NONE'} | non-monotone arrivals: ${arrivals.filter((a) => [...a.plan].sort().join('') !== 'RRRU').map((a) => `${a.plan}@${a.plan.length}`).join(', ') || 'none'}`);
  });
});
