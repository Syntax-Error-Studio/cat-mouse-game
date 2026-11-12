/// <reference types="node" />
/**
 * PPC-HV-9 P2 — is a LOCAL, four-action tactical check both legal and cheap?
 *
 * Forensic only. Production H1, the search, the budget, GAMEPLAY rules, HV-3 range
 * assist, HV-6 Gate Race, HV-7 and HV-8 are read, never edited. The engine is the
 * single referee: every step below goes through `catMove`, and a claim without an
 * engine-accepted sequence is reported as UNKNOWN, never as reachable.
 *
 * (4,8) appears here ONLY as a test fixture, to price the route HV-9 P0 verified. The
 * production-facing question is whether the interception cells a state derives BY
 * ITSELF (butter, hole feeds, Gate Race gates, the mouse own return route) can be
 * checked within four legal actions at a cost a leaf could actually afford.
 */
import { describe, expect, it } from 'vitest';
import { catMove, type GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GamePhase, type Direction } from '../../types';
import { DEFAULT_EVALUATION_WEIGHTS, createEvaluationContext, evaluateForCatDetailed } from '../evaluation';
import { correctedHoleEvalTotal, evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { h1Game4, h1Turn, handOffToMouse, rc, replayCatPlan, withCatAt } from './hv5ForcedLineAuditor';
import { bankTurn, boxLayout } from './hv8WitnessPush';
import {
  boundedTacticalReach,
  boundedTurnSweep,
  deriveInterceptionTargets,
  playLine,
  type SweepResult,
} from './hv9BoundedTactical';

const FIXTURE_LANE_CELL = '4,8'; // test-only, never a production target (HV-9 §五)

const TOKEN_TO_DIR: Record<string, Direction> = {
  U: DIRECTIONS[0],
  D: DIRECTIONS[1],
  L: DIRECTIONS[2],
  R: DIRECTIONS[3],
};

function leaf(root: GameEngineState, tokens: string[]): GameEngineState {
  const replayed = replayCatPlan(root, tokens);
  expect(replayed.illegalAt, `plan ${tokens.join('')} is legal on the real engine`).toBeNull();
  return replayed.end;
}

/** The turn-complete engine state — the same object HV-7 evaluated its H1 leaf from. */
const endOf = (tokens: string[]): GameEngineState => leaf(h1Turn(4).state, tokens);
const viewOf = (s: GameEngineState): GameEngineState => bankTurn(s);
const rrrrEnd = (): GameEngineState => endOf(['R', 'R', 'R', 'R']);
const uuurEnd = (): GameEngineState => endOf(['U', 'U', 'U', 'R']);
const rrrr = (): GameEngineState => viewOf(rrrrEnd());
const uuur = (): GameEngineState => viewOf(uuurEnd());

const fmt = (n: number): string => n.toFixed(4);
const micros = (ms: number): string => (ms * 1000).toFixed(0);

/**
 * Production H1 on the mouse-to-move leaf, by the production route: real hand-off via
 * `endTurn`, then `evaluateForCatDetailed`, then the corrected-hole total. HV-7 A1
 * (hv7ScoreGapAttribution.test.ts:295-313) froze this pair at UUUR=-1736.7631578947369
 * and a 741.6052631578948 gap, i.e. RRRR=-2478.3684210526317.
 */
function h1Of(end: GameEngineState): number {
  const mouseToMove = handOffToMouse(end, true);
  const bd = evaluateForCatDetailed(mouseToMove, DEFAULT_EVALUATION_WEIGHTS);
  const total = correctedHoleEvalTotal(bd, mouseToMove.config.boardSize);
  expect(total, 'the detailed path and the production entry point give one number').toBe(evaluateCorrectedHoleForCat(mouseToMove));
  return total;
}

describe('PPC-HV-9 C — P2a: the interception cells come from the state, not from a log', () => {
  it('HV9-C1: derivation is a pure function of the public state and stays inside the budget', () => {
    const root = h1Turn(4).state;
    for (const [name, make] of [['RRRR', rrrr], ['UUUR', uuur]] as [string, () => GameEngineState][]) {
      const view = make();
      const ctx = createEvaluationContext(view);
      const a = deriveInterceptionTargets(view, ctx);
      const b = deriveInterceptionTargets(view, ctx);
      expect(a.map((t) => t.cell), 'the same state must give the same cells').toEqual(b.map((t) => t.cell));
      const bad = a.filter((t) => t.manhattanFromCat > 4 || t.cell === rc(view.catPosition));
      expect(bad, 'a derived target must sit inside the four-action budget and not on the cat').toEqual([]);
      // Independence test 1 — the SET follows the state: the same mouse, a different
      // cat landing, a different answer. Nothing here is a hard-coded list.
      const other = name === 'RRRR' ? uuur() : rrrr();
      const otherSet = deriveInterceptionTargets(other, createEvaluationContext(other)).map((t) => t.cell).join(',');
      expect(otherSet, `${name}: the other T4 landing must not give the same answer set — the cells are read from this state`).not.toBe(a.map((t) => t.cell).join(','));
      // Independence test 2 — every cell is justified by the state it came from. The
      // four layers are audited here against the public board, not taken on trust.
      const hole = view.config.mouseHole;
      const inHole = (r: number, c: number): boolean =>
        r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;
      const feedOk = (cell: string): boolean => {
        const [r, c] = cell.split(',').map(Number);
        return !inHole(r, c) && (inHole(r - 1, c) || inHole(r + 1, c) || inHole(r, c - 1) || inHole(r, c + 1));
      };
      let best = Number.POSITIVE_INFINITY;
      for (const [cell, md] of ctx.mouseMap) {
        const hd = ctx.carryHoleMap.get(cell);
        if (hd !== undefined && md + hd < best) best = md + hd;
      }
      const gates = new Set(ctx.gateCells.map((g) => rc(g)));
      const butters = new Set(view.butterPositions.map((b) => rc(b)));
      const unjustified = a.filter((t) => !t.kinds.every((k) => {
        if (k === 'gate') return gates.has(t.cell);
        if (k === 'butter') return butters.has(t.cell);
        if (k === 'hole-feed') return feedOk(t.cell);
        return (t.mouseDist ?? Number.POSITIVE_INFINITY) + (t.holeDist ?? Number.POSITIVE_INFINITY) === best;
      }));
      expect(unjustified.map((t) => `${t.cell}${t.kinds.join('/')}`), 'each derived cell must be attributable to butter, the hole, the Gate Race layer or a shortest mouse return route that this state itself shows').toEqual([]);
      console.log(`HV9-C1 ${name} cat=${rc(view.catPosition)} mouse=${rc(view.mousePosition)}: derived=${a.length} [${a.map((t) => `${t.cell}${t.kinds.map((k) => `(${k})`).join('')} m${t.manhattanFromCat} md${t.mouseDist ?? '-'} hd${t.holeDist ?? '-'}`).join(' | ')}]`);
      console.log(`HV9-C1 ${name}: fixture ${FIXTURE_LANE_CELL} in the derived set = ${a.some((t) => t.cell === FIXTURE_LANE_CELL)} — if true it is there because the mouse route says so, not because a human log does`);
    }
    expect(boxLayout(rrrr()).split(' ').filter(Boolean).length, 'twelve boxes, and this module moved none of them').toBe(12);
    console.log(`HV9-C1 T4 root reproduced: cat=${rc(root.catPosition)} mouse=${rc(root.mousePosition)} catMovesLeft=${root.catMovesLeft} budget=${root.config.catBaseMoves}`);
    console.log(`HV9-C1 what the log itself recorded for T4: PLAN=[${h1Turn(4).loggedPlan}] — condition 5 of §六 is judged against THIS line, not against a route we chose`);
  });

  it('HV9-C2: the four-action question on the derived cells, with the engine as the only referee', () => {
    const view = rrrr();
    const derived = deriveInterceptionTargets(view, createEvaluationContext(view)).map((t) => t.cell);
    const targets = [...new Set([...derived, FIXTURE_LANE_CELL, rc(view.mousePosition)])];
    const cheap = boundedTacticalReach(view, targets, { sweep: false });
    const full = boundedTacticalReach(view, targets, { sweep: true });
    const walk = createEvaluationContext(view).catMap;
    for (const cell of targets) {
      const c = cheap.claims.get(cell)!;
      const f = full.claims.get(cell)!;
      if (f.witness !== null) {
        const again = playLine(view, f.witness.map((t) => TOKEN_TO_DIR[t]));
        expect(again.refusedAt, `${cell}: the claimed witness is refused nowhere`).toBe(-1);
        expect(rc(again.end.catPosition), `${cell}: and the engine lands on the cell`).toBe(cell);
        expect(again.stepsApplied, `${cell}: every token of the witness was applied`).toBe(f.steps);
      }
      if (f.verdict === 'REACHABLE_WITHIN_4') expect(f.witness, `${cell}: a YES always carries a sequence`).not.toBeNull();
      console.log(`HV9-C2 ${cell} m${c.manhattan}: cheap=${c.verdict}${c.witness ? `[${c.witness.join('')}@${c.steps} push${c.pushes}${c.endsInCapture ? ' CAPTURE' : ''}]` : ''} | swept=${f.verdict}${f.witness ? `[${f.witness.join('')}@${f.steps} push${f.pushes}${f.endsInCapture ? ' CAPTURE' : ''}]` : ''} | production walk=${walk.get(cell) ?? 'no claim'}`);
    }
    const fixture = full.claims.get(FIXTURE_LANE_CELL)!;
    console.log(`HV9-C2 fixture ${FIXTURE_LANE_CELL}: ${fixture.verdict} at ${fixture.steps ?? '-'} steps with ${fixture.pushes} pushes [${fixture.witness ? fixture.witness.join('') : 'no witness'}] — production walk says ${walk.get(FIXTURE_LANE_CELL)}, HV-9 P0 proved 4 steps and 3 pushes`);
    expect(fixture.verdict, 'a route P0 proved with the engine may not come out as impossible').toBe('REACHABLE_WITHIN_4');
    expect(fixture.steps, 'and this local model finds it at the true length').toBe(4);
    expect(fixture.pushes, 'which costs at least the three pushes P0 measured').toBeGreaterThanOrEqual(3);
    expect(cheap.stats.permutationsPlayed, 'the cheap mode plays only Manhattan-shortest permutations').toBeLessThanOrEqual(4 * targets.length);
    console.log(`HV9-C2 volume: cheap catMoveCalls=${cheap.stats.catMoveCalls} over ${cheap.stats.permutationsPlayed} permutations, ${cheap.stats.witnesses} witnesses; one local tree adds ${full.stats.sweepNodes} nodes / ${full.stats.catMoveCalls - cheap.stats.catMoveCalls} calls and answers all ${full.stats.targets} targets at once`);
  });
});

describe('PPC-HV-9 D — P2b: what the model is allowed to say when it finds nothing', () => {
  it('HV9-D1: without a coverage proof absence is UNKNOWN, with one it is a stated NO', () => {
    const view = rrrr();
    const shell: string[] = [];
    for (let r = 0; r < view.config.boardSize; r++) {
      for (let c = 0; c < view.config.boardSize; c++) {
        if (Math.abs(r - view.catPosition.r) + Math.abs(c - view.catPosition.c) === 4) shell.push(`${r},${c}`);
      }
    }
    const cheap = boundedTacticalReach(view, shell, { sweep: false });
    const full = boundedTacticalReach(view, shell, { sweep: true });
    const count = (map: Map<string, { verdict: string }>, v: string): number => [...map.values()].filter((c) => c.verdict === v).length;
    expect(count(cheap.claims, 'UNKNOWN'), 'the permutation-only mode must leave refusals as UNKNOWN, never as impossible').toBeGreaterThan(0);
    for (const c of cheap.claims.values()) {
      expect(c.verdict, `${c.cell}: the cheap mode may not answer NO at all`).not.toBe('UNREACHABLE_WITHIN_4');
      if (c.verdict === 'UNKNOWN') expect(c.note, `${c.cell}: and it must say why nothing was proved`).not.toBeNull();
    }
    expect(full.stats.sweepExhaustive, 'a NO needs complete coverage').toBe(true);
    expect(full.stats.sweepReason).toBeNull();
    for (const [cell, c] of full.claims) {
      if (c.verdict === 'UNREACHABLE_WITHIN_4') expect(full.reachableWithinBudget.has(cell), `${cell}: a NO means the sweep really never landed there`).toBe(false);
      if (c.verdict === 'REACHABLE_WITHIN_4') expect(full.reachableWithinBudget.has(cell), `${cell}: a YES means the sweep has it too`).toBe(true);
    }
    console.log(`HV9-D1 depth-4 shell around (5,5): ${shell.length} cells | cheap: yes=${count(cheap.claims, 'REACHABLE_WITHIN_4')} unknown=${count(cheap.claims, 'UNKNOWN')} no=${count(cheap.claims, 'UNREACHABLE_WITHIN_4')} | swept: yes=${count(full.claims, 'REACHABLE_WITHIN_4')} no=${count(full.claims, 'UNREACHABLE_WITHIN_4')} unknown=${count(full.claims, 'UNKNOWN')}`);
    console.log(`HV9-D1 tree: ${full.stats.sweepNodes} nodes, ${full.stats.catMoveCalls} catMove calls, ${full.stats.sweepDuplicateStatesSkipped} duplicate states skipped, ${full.stats.sweepTerminalCaptures} capture terminals | refused permutation attempts=${cheap.stats.refusedAttempts}`);
  });

  it('HV9-D2: a truncated sweep withdraws its NOs and invents nothing', () => {
    const view = rrrr();
    const targets = [...new Set([...deriveInterceptionTargets(view, createEvaluationContext(view)).map((t) => t.cell), '0,0', '9,9'])];
    const uncapped = boundedTacticalReach(view, targets, { sweep: true });
    const tiny = boundedTurnSweep(view, 4, true, 8);
    expect(tiny.exhaustive, 'a frontier cap must announce itself').toBe(false);
    expect(tiny.reason, 'and name the depth where it stopped').not.toBeNull();
    const invented = [...tiny.reachable.keys()].filter((k) => !uncapped.reachableWithinBudget.has(k));
    expect(invented, 'a truncated sweep may not reach cells the complete sweep does not').toEqual([]);
    const unsoundClaim = [...uncapped.claims.values()].filter((c) => c.verdict === 'UNREACHABLE_WITHIN_4' && !uncapped.stats.sweepExhaustive);
    expect(unsoundClaim, 'no NO may exist while coverage is incomplete').toEqual([]);
    console.log(`HV9-D2 coverage discipline: complete tree=${uncapped.stats.sweepNodes} nodes exhaustive=${uncapped.stats.sweepExhaustive} NOs=${[...uncapped.claims.values()].filter((c) => c.verdict === 'UNREACHABLE_WITHIN_4').length} | capped at 8 frontier states: nodes=${tiny.nodesExpanded} reachable=${tiny.reachable.size} exhaustive=${tiny.exhaustive} reason=${tiny.reason}`);
  });
});

describe('PPC-HV-9 E — P2c: cost and rule discipline, on the two T4 landings only', () => {
  it('HV9-E1: the cheap mode and the local tree, priced per state and projected', () => {
    const calls = 2000;
    const view0 = rrrr();
    const t0 = performance.now();
    for (let i = 0; i < calls; i++) catMove(view0, DIRECTIONS[3]);
    const perCallMs = (performance.now() - t0) / calls;

    const REPS = 7;
    const timed = (f: () => unknown): { median: number; min: number; max: number } => {
      const xs: number[] = [];
      for (let i = 0; i < REPS; i++) {
        const a = performance.now();
        f();
        xs.push(performance.now() - a);
      }
      xs.sort((p, q) => p - q);
      return { median: xs[(REPS - 1) / 2], min: xs[0], max: xs[REPS - 1] };
    };

    let cheapMs = 0;
    let treeMs = 0;
    let bothMs = 0;
    let treeNoDedupMs = 0;
    let nodes = 0;
    let nodesNoDedup = 0;
    let probesNoDedup = 0;
    let probesDedup = 0;
    let skips = 0;
    let targetsTotal = 0;
    let witnessesTotal = 0;
    let permutationsTotal = 0;
    let cheapCallsTotal = 0;
    for (const [name, make] of [['RRRR (5,5)', rrrr], ['UUUR (2,2)', uuur]] as [string, () => GameEngineState][]) {
      const view = make();
      const targets = deriveInterceptionTargets(view, createEvaluationContext(view)).map((t) => t.cell);
      const cheap = boundedTacticalReach(view, targets, { sweep: false });
      const swept = boundedTacticalReach(view, targets, { sweep: true });
      const tree = boundedTurnSweep(view, 4, true);
      const nod = boundedTurnSweep(view, 4, false);
      const cheapT = timed(() => boundedTacticalReach(view, targets, { sweep: false }));
      const bothT = timed(() => boundedTacticalReach(view, targets, { sweep: true }));
      const treeT = timed(() => boundedTurnSweep(view, 4, true));
      const nodT = timed(() => boundedTurnSweep(view, 4, false));
      cheapMs += cheapT.median;
      bothMs += bothT.median;
      treeMs += treeT.median;
      treeNoDedupMs += nodT.median;
      nodes += tree.nodesExpanded;
      nodesNoDedup += nod.nodesExpanded;
      probesDedup += tree.catMoveCalls;
      probesNoDedup += nod.catMoveCalls;
      skips += tree.duplicateStatesSkipped;
      targetsTotal += swept.stats.targets;
      witnessesTotal += swept.stats.witnesses;
      permutationsTotal += cheap.stats.permutationsPlayed;
      cheapCallsTotal += cheap.stats.catMoveCalls;
      const yes = [...swept.claims.values()].filter((c) => c.verdict === 'REACHABLE_WITHIN_4').length;
      console.log(`HV9-E1 ${name}: targets=${targets.length} [${targets.join(' ')}] yes=${yes}/${swept.stats.targets} witnesses=${swept.stats.witnesses} | cheap median=${micros(cheapT.median)}µs [min ${micros(cheapT.min)} max ${micros(cheapT.max)}] (${cheap.stats.permutationsPlayed} permutations, ${cheap.stats.catMoveCalls} calls) | tree median=${micros(treeT.median)}µs [min ${micros(treeT.min)} max ${micros(treeT.max)}] (${tree.nodesExpanded} nodes, ${tree.catMoveCalls} probes, ${tree.duplicateStatesSkipped} dedup skips) | both=${micros(bothT.median)}µs | tree without dedup=${micros(nodT.median)}µs (${nod.nodesExpanded} nodes, ${nod.catMoveCalls} probes)`);
    }
    console.log(`HV9-E1 raw catMove cost on this box: ${(perCallMs * 1000).toFixed(3)}µs per call over ${calls} calls (median of means; each call clones the state)`);
    console.log(`HV9-E1 per state (mean of the two medians): cheap=${micros(cheapMs / 2)}µs, tree=${micros(treeMs / 2)}µs, cheap+tree=${micros(bothMs / 2)}µs — the tree is ${(treeMs / cheapMs).toFixed(1)}x the permutation mode`);
    console.log(`HV9-E1 §五 volumes over the two T4 landings: targets=${targetsTotal} permutations verified=${permutationsTotal} catMove calls(cheap)=${cheapCallsTotal} witnesses=${witnessesTotal} tree probes=${probesDedup} duplicate states skipped=${skips}`);
    console.log(`HV9-E1 budget arithmetic: a leaf may spend 244µs (100ms / ~409 leaves) = ${(244 / (perCallMs * 1000)).toFixed(1)} catMove calls; the cheap mode used ${(cheapCallsTotal / targetsTotal).toFixed(1)} calls per target on average (${micros(cheapMs / targetsTotal)}µs/target), the tree ${(probesDedup / 2).toFixed(0)} probes per state (${micros((probesDedup / 2) * perCallMs)}µs)`);
    console.log(`HV9-E1 projection over the ~409 leaves the 100ms main search evaluates: cheap=${((cheapMs / 2) * 409).toFixed(0)}ms, cheap+tree=${((bothMs / 2) * 409).toFixed(0)}ms, tree alone=${((treeMs / 2) * 409).toFixed(0)}ms against a 100ms main / 150ms turn budget`);
    console.log(`HV9-E1 dedup effect, different box layouts never merged: nodes ${nodesNoDedup} without dedup vs ${nodes} with, probes ${probesNoDedup} vs ${probesDedup} (${(((probesNoDedup - probesDedup) / probesNoDedup) * 100).toFixed(0)}% fewer), states skipped ${skips}, tree cost ${micros(treeNoDedupMs / 2)}µs → ${micros(treeMs / 2)}µs per state`);
    console.log(`HV9-E1 references: production H1 leaf≈293µs (HV-7), HV-8 witness arm 6997-8032µs/leaf (HV-8 C1/E1), one extra push BFS≈98µs (HV-7)`);
    expect(cheapMs / 2, 'a number above a second per state means the harness is broken, not the model').toBeLessThan(100);
    expect(treeMs / 2, 'same guard for the tree').toBeLessThan(100);
    expect(probesDedup, 'dedup must be doing real work, or the comparison proves nothing').toBeGreaterThan(0);
  });

  it('HV9-E2: one turn of budget, and a capture ends the line', () => {
    const view = rrrr();
    const four = playLine(view, [DIRECTIONS[3], DIRECTIONS[3], DIRECTIONS[3], DIRECTIONS[0]]);
    expect(rc(four.end.catPosition), 'the route P0 proved plays out here').toBe(FIXTURE_LANE_CELL);
    expect(four.stepsApplied, 'all four actions applied').toBe(4);
    expect(four.pushes, 'at the three pushes P0 measured').toBe(3);
    expect(four.end.catMovesLeft, 'and the turn is now spent').toBe(0);
    const five = playLine(view, [DIRECTIONS[3], DIRECTIONS[3], DIRECTIONS[3], DIRECTIONS[0], DIRECTIONS[1]]);
    expect(five.stepsApplied, 'four actions are all the turn has').toBe(4);
    expect(five.refusedAt, 'the fifth is refused').toBe(4);
    expect(five.end.catMovesLeft, 'and nothing re-banked it inside the line').toBe(0);
    const fifthAlone = playLine(four.end, [DIRECTIONS[1]]);
    expect(fifthAlone.stepsApplied, 'that same fifth step is legal on this board — only the budget refused it').toBe(1);
    const boardRefused = playLine(view, [DIRECTIONS[3], DIRECTIONS[3], DIRECTIONS[3], DIRECTIONS[3]]);
    expect(boardRefused.refusedAt, 'a fourth R is refused by the board, not by the clock').toBe(3);
    expect(boardRefused.end.catMovesLeft, 'and one action is still in hand there').toBe(1);
    const three = playLine(view, [DIRECTIONS[3], DIRECTIONS[3], DIRECTIONS[3]]);
    expect(three.end.catMovesLeft, 'three steps leave exactly one').toBe(1);
    expect(three.pushes, 'and all three of those were pushes').toBe(3);

    // Capture terminals. T4 has none inside one cat turn — the exhaustive sweep says
    // so — so the terminal rule needs a state that actually offers one.
    const t4 = boundedTurnSweep(viewOf(h1Turn(4).state), 4);
    const man = Math.abs(h1Turn(4).state.catPosition.r - h1Turn(4).state.mousePosition.r)
      + Math.abs(h1Turn(4).state.catPosition.c - h1Turn(4).state.mousePosition.c);
    expect(t4.terminalCaptures, 'the exhaustive T4 tree contains no capture').toBe(0);
    expect(man, 'because the cat is further than four actions from the mouse there').toBeGreaterThan(4);
    // Scan EVERY logged root of this game for a capture inside one cat turn. If no
    // real state offers one, that finding is reported as the finding, and the terminal
    // rule itself is exercised on a clearly labelled synthetic adjacency (the same
    // `withCatAt` probe shape HV-6 used) — a labelled stand-in, never a real claim.
    let playable = 0;
    let realRootsWithCapture = 0;
    let nearest = Number.POSITIVE_INFINITY;
    let nearestTurn = -1;
    let demo: { label: string; view: GameEngineState; sweep: SweepResult } | null = null;
    for (const t of h1Game4()) {
      if (t.state.phase !== GamePhase.Playing) continue;
      playable++;
      const m = Math.abs(t.state.catPosition.r - t.state.mousePosition.r)
        + Math.abs(t.state.catPosition.c - t.state.mousePosition.c);
      if (m < nearest) { nearest = m; nearestTurn = t.turn; }
      const s = boundedTurnSweep(viewOf(t.state), t.state.config.catBaseMoves);
      if (s.terminalCaptures === 0) continue;
      realRootsWithCapture++;
      demo ??= { label: `logged T${t.turn}`, view: viewOf(t.state), sweep: s };
    }
    if (demo === null) {
      const base = h1Turn(nearestTurn >= 0 ? nearestTurn : 4).state;
      const spot = DIRECTIONS
        .map((d) => ({ r: base.mousePosition.r + d.dr, c: base.mousePosition.c + d.dc }))
        .find((p) => p.r >= 0 && p.c >= 0 && p.r < base.config.boardSize && p.c < base.config.boardSize
          && base.board[p.r][p.c].type === CellType.Empty && base.board[p.r][p.c].piece === undefined);
      expect(spot, 'the mouse must have an empty orthogonal cell beside it for the stand-in').not.toBeUndefined();
      const synth = withCatAt(base, spot!.r, spot!.c);
      demo = {
        label: `synthetic: cat teleported to ${rc(spot!)} beside the T${nearestTurn} mouse (labelled stand-in, not a logged state)`,
        view: viewOf(synth),
        sweep: boundedTurnSweep(viewOf(synth), synth.config.catBaseMoves),
      };
    }
    const f = demo!;
    expect(f.sweep.terminalCaptures, 'the tree must see the capture it is claiming').toBeGreaterThan(0);
    const captureLines = [...f.sweep.reachable.values()].filter((w) => w.endsInCapture);
    expect(captureLines.length, 'every terminal is recorded as ending in a capture').toBeGreaterThan(0);
    for (const w of captureLines) {
      const replayed = playLine(f.view, w.witness.map((t) => TOKEN_TO_DIR[t]));
      expect(replayed.captureAt, 'the engine agrees it is a capture').toBeGreaterThanOrEqual(0);
      expect(rc(replayed.end.catPosition), 'and the terminal lands on the mouse cell').toBe(rc(f.view.mousePosition));
      expect(replayed.end.phase, 'and that the game is over there').not.toBe(GamePhase.Playing);
      expect(replayed.stepsApplied, 'with no step applied past the terminal').toBe(w.steps);
    }
    console.log(`HV9-E2 turn discipline: RRRU reaches ${FIXTURE_LANE_CELL} in ${four.stepsApplied} actions / ${four.pushes} pushes and spends the turn; the same line plus one D stops at index ${five.refusedAt} with ${five.end.catMovesLeft} left, while that D alone is legal (${fifthAlone.stepsApplied} action, landing ${rc(fifthAlone.end.catPosition)}) — so the stop was the budget, not the board; RRRR refuses at index ${boardRefused.refusedAt} with ${boardRefused.end.catMovesLeft} still in hand (a board refusal)`);
    console.log(`HV9-E2 capture terminals: the T4 root sweep has 0 captures (cat ${rc(h1Turn(4).state.catPosition)} is Manhattan ${man} from mouse ${rc(h1Turn(4).state.mousePosition)}); across ${playable} playable logged roots the closest cat-mouse gap is Manhattan ${nearest} (T${nearestTurn}) and ${realRootsWithCapture} of them contain a capture inside four actions; proof state: ${f.label} — ${f.sweep.terminalCaptures} terminal(s) over ${f.sweep.nodesExpanded} nodes, shortest witness ${captureLines.map((w) => `${w.steps}[${w.witness.join('')}]`).join(' ')}, each re-played through catMove above`);
    console.log(`HV9-E2 trap placement is deliberately out of a move-reachability tree: it consumes no movement and never moves the cat, so it cannot enlarge the reachable set`);
  });

  it('HV9-E3: what the state points at, and where the static walk field overstates the cat', () => {
    const view = rrrr();
    const ctx = createEvaluationContext(view);
    const derived = deriveInterceptionTargets(view, ctx);
    const byKind = new Map<string, string[]>();
    for (const t of derived) for (const k of t.kinds) byKind.set(k, [...(byKind.get(k) ?? []), t.cell]);
    const swept = boundedTacticalReach(view, derived.map((t) => t.cell), { sweep: true });
    const yes = [...swept.claims.values()].filter((c) => c.verdict === 'REACHABLE_WITHIN_4');
    const no = [...swept.claims.values()].filter((c) => c.verdict === 'UNREACHABLE_WITHIN_4');
    expect(derived.length, 'the state must offer at least one interception cell inside four actions').toBeGreaterThan(0);
    for (const c of yes) {
      expect(c.witness!.length, `${c.cell}: witness length equals the quoted price`).toBe(c.steps);
      expect(c.pushes, `${c.cell}: pushes come from the engine, never from an assumption`).toBeGreaterThanOrEqual(0);
    }
    const overstated = yes.filter((c) => (ctx.catMap.get(c.cell) ?? 99) > c.steps!);
    // §五 multi-route honesty: the answer is a per-cell table. This state holds one
    // interception cell and cannot hold another, so "the defence is complete" is not
    // even expressible in this output shape.
    expect(swept.stats.targets, 'the state offered more than one interception cell').toBeGreaterThan(1);
    expect(yes.length, 'one of them is held inside four actions').toBeGreaterThan(0);
    expect(no.length, 'and with a coverage proof, another one is provably not — no blanket verdict').toBeGreaterThan(0);
    console.log(`HV9-E3 derived layers at (5,5): ${[...byKind].map(([k, v]) => `${k}=[${v.join(' ')}]`).join(' ')}`);
    console.log(`HV9-E3 answer: reachable=${yes.map((c) => `${c.cell}@${c.steps}[${c.witness!.join('')}]push${c.pushes}`).join(' ')} | NO-with-coverage=${no.map((c) => c.cell).join(' ') || 'none'} | UNKNOWN=${swept.stats.targets - yes.length - no.length}`);
    console.log(`HV9-E3 where the static walk field overstates the cat: ${overstated.map((c) => `${c.cell}: walk ${ctx.catMap.get(c.cell)} vs four-action witness ${c.steps}`).join(' | ') || 'none'}`);
    console.log(`HV9-E3 production H1 on these leaves, computed by the production route: RRRR=${fmt(h1Of(rrrrEnd()))} and UUUR=${fmt(h1Of(uuurEnd()))} — HV-7 A1 saved -2478.3684 / -1736.7632 (gap 741.6053)`);
    expect(h1Of(rrrrEnd()), 'this round may not move a production H1 number').toBe(-2478.3684210526317);
    expect(h1Of(uuurEnd()), 'on either T4 landing').toBe(-1736.7631578947369);
    expect(h1Of(uuurEnd()) - h1Of(rrrrEnd()), 'and their gap is still the 741.61 HV-7 attributed').toBeCloseTo(741.6052631578948, 9);
  });
});
