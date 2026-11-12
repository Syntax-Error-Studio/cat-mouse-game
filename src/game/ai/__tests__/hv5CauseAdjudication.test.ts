/// <reference types="node" />
/**
 * PPC-HV-5 §6 — cause adjudication for the Turn #4 decision.
 *
 *   A  搜索视野不足 : was the ranking produced by a horizon that cannot see the
 *                     mouse's turn at all?  → HV5-D1/D3
 *   B  H1 评价盲区  : which existing H1 term actually moved the score, and does
 *                     any term know about the butter race / the corridor?
 *                     → HV5-D2 (term-by-term gap) and HV5-D5 (the race metric)
 *   C  陷阱与推箱   : was the loss a trap/box policy failure? → HV5-D4
 *   D  精确平局选择 : was Turn #4 an exact tie that `planQuality.ts` broke?
 *                     → HV5-D1 (unique argmax) and HV5-D3 (depth 2 ties all four)
 *
 * Nothing here changes production code: the numbers are read from the frozen
 * search machinery and the frozen evaluator, and every claim is compared against
 * the prover verdicts in `hv5EarlyInterception.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createEngineRuleSet } from '../../engine';
import { evaluateForCatDetailed, DEFAULT_EVALUATION_WEIGHTS } from '../evaluation';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { createSearchContext, searchBestAction } from '../expectiminimax';
import { dirKey, buildPlanForFirstAction } from '../planQuality';
import {
  catActions, catMarchSteps, enumerateCatTurnExact, h1Turn, handOffToMouse, rc, replayCatPlan,
} from './hv5ForcedLineAuditor';
import { stateKey } from '../transposition';
import type { GameEngineState } from '../../engine';

const rules = createEngineRuleSet();

/** `ArrowUp: value=-1736.76…, mate=null, bound=exact` → map by direction key. */
function loggedRootActions(turn: number): Map<string, { value: number; mate: string; bound: string }> {
  const t = h1Turn(turn);
  const out = new Map<string, { value: number; mate: string; bound: string }>();
  for (const l of t.loggedRootActions) {
    const m = /^(\S+): value=([-\d.]+), mate=(\S+), bound=(\S+)$/.exec(l);
    if (m) out.set(m[1], { value: Number(m[2]), mate: m[3], bound: m[4] });
  }
  return out;
}

const dirOf = (token: string) => ({ U: 'ArrowUp', R: 'ArrowRight', D: 'ArrowDown', L: 'ArrowLeft' })[token] ?? token;

/**
 * Production depth-1 leaves are scored on the MOUSE-to-move state: a turn switch
 * is what consumes the depth budget (expectiminimax.ts:1090), so the cat turn is
 * fully expanded and the static eval happens after `endTurn`. The pre-switch
 * ending is scored one tempo (200) higher because `tempo` flips sign with the
 * actor (evaluation.ts:687-693).
 *
 * Each first action is enumerated as its OWN subtree. Sharing one global
 * seen-set across the whole turn — which is what `enumerateCatTurnExact` does,
 * and correctly so as a prover — would attribute a state reachable by both `L…`
 * and `R…` to whichever DFS found it first and hide it from the other root
 * action. That is a quantifier/merging trap, not a search bug.
 */
function bestEndingPerFirstAction(root: GameEngineState) {
  const best = new Map<string, { plan: string[]; state: GameEngineState; leaf: GameEngineState; h1: number; h1Pre: number; ends: number }>();
  for (const a of catActions(root)) {
    const turn = enumerateCatTurnExact([{ state: a.state, plan: [a.token] }], 20_000);
    expect(turn.truncated, `the ${a.token} subtree fits the enumeration budget`).toBe(false);
    for (const e of turn.ends) {
      const leaf = handOffToMouse(e.state, true);
      const h1 = evaluateCorrectedHoleForCat(leaf);
      const first = dirOf(a.token);
      const cur = best.get(first);
      if (!cur || h1 > cur.h1) {
        best.set(first, { plan: e.plan, state: e.state, leaf, h1, h1Pre: evaluateCorrectedHoleForCat(e.state), ends: turn.ends.length });
      }
    }
  }
  return best;
}

const CONTRIB_KEYS = [
  'capturePressure', 'mouseGoalThreat', 'butterRace', 'confinement', 'mobility',
  'trapControl', 'tunnelControl', 'holeControl', 'voronoiBalance', 'tempo',
] as const;

describe('PPC-HV-5 §6 — why Turn #4 chose ArrowUp', () => {
  it('HV5-D1: the logged depth-1 values ARE static leaf scores of the cat turn', () => {
    const t4 = h1Turn(4);
    const logged = loggedRootActions(4);
    const best = bestEndingPerFirstAction(t4.state);
    for (const [dir, rec] of best) {
      const l = logged.get(dir);
      console.log(`HV5-D1 ${dir}: logged=${l?.value} bound=${l?.bound} | leaf H1 (mouse-to-move)=${rec.h1} via [${rec.plan.join('')}] end=${rc(rec.state.catPosition)} | pre-switch H1=${rec.h1Pre} moves=${rec.state.catMovesLeft}/${rec.leaf.catMovesLeft} mouseMoves=${rec.leaf.mouseMovesLeft} player=${rec.leaf.currentPlayer} mouse=${rc(rec.leaf.mousePosition)} carrying=${rec.leaf.mouseHasButter}`);
      expect(l, `${dir} is in the logged ROOT_ACTIONS`).toBeDefined();
      expect(rec.h1, `${dir}: the depth-1 value equals the best static leaf after the turn switch`).toBe(l!.value);
    }
    expect([...best.keys()].sort()).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
    // Cause D needs this separation: the root choice is a UNIQUE argmax, so the
    // equal-primary / plan-quality machinery never had to break a tie here. The
    // three runners-up are tied with each other, which is irrelevant to the pick.
    const up = best.get('ArrowUp')!;
    for (const [dir, rec] of best) {
      if (dir !== 'ArrowUp') expect(rec.h1, `${dir} is strictly below the ArrowUp leaf`).toBeLessThan(up.h1);
    }
    console.log(`HV5-D1 unique argmax=${[...best.entries()].sort((a, b) => b[1].h1 - a[1].h1).map(([d, r]) => `${d}=${r.h1.toFixed(4)}`).join(' ')} `
      + '| logged bounds are all exact and ArrowUp alone is the maximum — no tie was broken by planQuality at Turn #4');
    expect(new Set([...best.values()].map((r) => r.h1)).size, 'the three losing directions tie with each other, ArrowUp stands apart').toBe(2);
    expect(logged.get('ArrowUp')!.bound, 'the winning root action is an exact proof').toBe('exact');
  });

  it('HV5-D2: which existing H1 term ranked the fatal direction first', () => {
    const t4 = h1Turn(4);
    const best = bestEndingPerFirstAction(t4.state);
    const rows = [...best.entries()].map(([dir, rec]) => {
      const b = evaluateForCatDetailed(rec.leaf);
      const c = b.contributions;
      return {
        dir,
        plan: rec.plan.join(''),
        cell: rc(rec.state.catPosition),
        total: b.total,
        h1: rec.h1,
        holeOld: c.holeControl,
        feats: `catMouse=${b.features.catMouseDistance} mouseButter=${b.features.mouseButterDistance} mouseHoleGate=${b.features.mouseHoleGateDistance} catHoleGate=${b.features.catHoleGateDistance} voronoi=${b.features.voronoiBalance.toFixed(3)}`,
        contrib: CONTRIB_KEYS.map((k) => `${k}=${(c[k] as number).toFixed(2)}`).join(' '),
      };
    }).sort((a, b) => b.h1 - a.h1);
    for (const r of rows) {
      console.log(`HV5-D2 ${r.dir} [${r.plan}]@${r.cell} total=${r.total.toFixed(4)} h1=${r.h1.toFixed(4)}\n   ${r.feats}\n   ${r.contrib}`);
    }
    const up = rows.find((r) => r.dir === 'ArrowUp')!;
    const right = rows.find((r) => r.dir === 'ArrowRight')!;
    const bu = evaluateForCatDetailed(best.get('ArrowUp')!.leaf).contributions;
    const br = evaluateForCatDetailed(best.get('ArrowRight')!.leaf).contributions;
    const deltas = CONTRIB_KEYS.map((k) => `${k}:${((bu[k] as number) - (br[k] as number)).toFixed(2)}`);
    console.log(`HV5-D2 gap ArrowUp−ArrowRight = ${up.h1 - right.h1} | per-term ${deltas.join(' ')}`);
    console.log(`HV5-D2 weights butterRace=${DEFAULT_EVALUATION_WEIGHTS.butterRace} mouseGoalThreat=${DEFAULT_EVALUATION_WEIGHTS.mouseGoalThreat} holeControl=${DEFAULT_EVALUATION_WEIGHTS.holeControl}`);
    expect(up.dir).toBe('ArrowUp');
    // the mouse's own butter distance is identical in every Turn #4 ending: the
    // cat cannot change it, so the term that "knows" about the butter is inert here
    const butter = [...best.values()].map((r) => evaluateForCatDetailed(r.leaf).features.mouseButterDistance);
    console.log(`HV5-D2 mouseButterDistance per ending=${JSON.stringify(butter)}`);
    expect(new Set(butter).size, 'butterRace cannot discriminate the four directions').toBe(1);
    // The two terms whose job is exactly this threat are dark in every Turn #4
    // leaf: mouseGoalThreat never fires (the mouse is not yet classified as a
    // goal threat) and butterRace is frozen (the mouse's distance to the butter
    // is 2 no matter where the cat steps). The score that decided the turn came
    // from capturePressure/holeControl/voronoi — proximity terms about the
    // mouse's CURRENT cell, not about the route it is building.
    const goal = [...best.values()].map((r) => evaluateForCatDetailed(r.leaf).contributions.mouseGoalThreat);
    const race = [...best.values()].map((r) => evaluateForCatDetailed(r.leaf).contributions.butterRace);
    console.log(`HV5-D2 mouseGoalThreat per ending=${JSON.stringify(goal)} butterRace=${JSON.stringify(race)} weights mouseGoalThreat=${DEFAULT_EVALUATION_WEIGHTS.mouseGoalThreat} capturePressure=${DEFAULT_EVALUATION_WEIGHTS.capturePressure}`);
    expect(new Set(goal).size, 'mouseGoalThreat is inert at Turn #4').toBe(1);
    expect(goal[0], 'mouseGoalThreat contributes nothing at all').toBe(0);
    expect(new Set(race).size, 'butterRace is inert at Turn #4').toBe(1);
  });

  it('HV5-D3: would depth 2 (no deadline) have seen the pickup?', () => {
    const t4 = h1Turn(4);
    const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = true;
    const started = Date.now();
    const res = searchBestAction(t4.state, 2, ctx);
    const ms = Date.now() - started;
    const logged = loggedRootActions(4);
    expect(ctx.rootValues.length, 'the root table is captured for every legal first action').toBe(4);
    const rows = ctx.rootValues.map((a) => `${dirKey(a.action)}: value=${a.value.toFixed(10)} bound=${a.bound} (logged d1 ${logged.get(dirKey(a.action))?.value})`);
    console.log(`HV5-D3 depth-2 search: completed=${res.completed} nodes=${ctx.diagnostics.nodes} ms=${ms} rootValue=${res.value.toFixed(10)} mate=${res.mate}`
      + ` | production budget is SEARCH_BUDGET_MS=100, so this is a diagnosis, not a ship proposal`);
    for (const r of rows) console.log(`HV5-D3   ${r}`);
    const best = ctx.rootValues.reduce((a, b) => (b.value > a.value ? b : a));
    const plan = buildPlanForFirstAction(t4.state, best.action, ctx);
    console.log(`HV5-D3 depth-2 best first action = ${dirKey(best.action)} cat-turn plan=[${plan.map((p) => dirKey(p)).join(' ')}]`
      + '\n  the prover says ArrowUp endings are fatal and ArrowRight endings hold (see HV5-B4)');
    expect(res.completed, 'the fixed-depth-2 search must finish to be evidence at all').toBe(true);
    expect(res.mate, 'even depth 2 does not see a mate — the mouse win is 3 cat turns away').toBe(null);
    // The headline for cause A: going deeper does not reveal the threat, it
    // ERASES the ranking. All four first actions certify the same exact value,
    // so the depth-1 preference for ArrowUp is not information the search
    // recovers with more turns — it is noise that depth 2 averages away.
    const values = new Set(ctx.rootValues.map((a) => a.value));
    console.log(`HV5-D3 distinct root values=${values.size} of ${ctx.rootValues.length}; bounds=${ctx.rootValues.map((a) => a.bound).join('/')} `
      + '(every one is an exact proof, so the tie is certified and not a window bound)');
    expect(values.size, 'depth 2 ties all four Turn #4 first actions').toBe(1);
    for (const a of ctx.rootValues) expect(a.bound, `${dirKey(a.action)} is exact, not a bound`).toBe('exact');
  });

  it('HV5-D5: the leaf H1 prefers is not the leaf that intercepts (cause B, quantified)', () => {
    const t4 = h1Turn(4);
    // (4,8) is the cell the surviving prover witness stands on (HV5-B4). After
    // Turn #4 the mouse needs 7 real steps to bring the butter back to it —
    // 1,7→1,6 (pickup) →1,7→1,8→2,8→3,8→4,8 — i.e. 2 mouse turns at 4 steps.
    // A cat leaf 4 steps away is on the gate one turn before the mouse; a leaf 8
    // steps away is a whole turn late. Real steps, not a Manhattan compare.
    const GATE = '4,8';
    const MOUSE_STEPS_TO_GATE = 7;
    const catBase = t4.state.config.catBaseMoves;
    const mouseBase = t4.state.config.mouseBaseMoves;
    const best = bestEndingPerFirstAction(t4.state);
    const rows = [...catActions(t4.state)].map((a) => {
      const dir = dirOf(a.token);
      const turn = enumerateCatTurnExact([{ state: a.state, plan: [a.token] }], 20_000);
      expect(turn.truncated, `${dir} subtree fits the enumeration budget`).toBe(false);
      const ends = new Map<string, GameEngineState>();
      for (const e of turn.ends) ends.set(stateKey(e.state), e.state);
      const marches = [...ends.values()].map((s) => ({ cell: rc(s.catPosition), march: catMarchSteps(s, GATE) }))
        .sort((x, y) => (x.march < 0 ? 999 : x.march) - (y.march < 0 ? 999 : y.march));
      const rec = best.get(dir)!;
      return {
        dir,
        endings: ends.size,
        evalCell: rc(rec.state.catPosition),
        evalMarch: catMarchSteps(rec.state, GATE),
        nearCell: marches[0].cell,
        nearMarch: marches[0].march,
      };
    });
    for (const r of rows) {
      console.log(`HV5-D5 ${r.dir}: endings=${r.endings} | H1 pick=${r.evalCell} (march to ${GATE}=${r.evalMarch}) | nearest ending in the same subtree=${r.nearCell} (${r.nearMarch} step(s) = ${Math.ceil(r.nearMarch / catBase)} cat turn(s))`);
    }
    console.log(`HV5-D5 the mouse is ${MOUSE_STEPS_TO_GATE} steps = ${Math.ceil(MOUSE_STEPS_TO_GATE / mouseBase)} mouse turn(s) from carrying butter onto ${GATE}; `
      + 'HV5-B4 shows the RRRR ending on (5,5) — 4 steps away — is the one that survives');
    for (const r of rows) {
      expect(r.evalMarch, `${r.dir}: the H1-max leaf is never better at the race than the subtree's nearest leaf`).toBeGreaterThanOrEqual(r.nearMarch);
    }
    const disagree = rows.filter((r) => r.evalMarch > r.nearMarch);
    console.log(`HV5-D5 directions where H1's favourite gives up the race=${disagree.map((r) => `${r.dir}:${r.evalCell}(${r.evalMarch})vs${r.nearCell}(${r.nearMarch})`).join(' ')}`);
    expect(disagree.length, 'at least one direction scores a leaf that is strictly worse at the interception race').toBeGreaterThan(0);
  });

  it('HV5-D4: trap and box policy at Turn #4 (cause C)', () => {
    const t4 = h1Turn(4);
    const s = t4.state;
    const place = replayCatPlan(s, ['P']);
    const witness = replayCatPlan(s, 'RRRR'.split(''));
    const pushCells: string[] = [];
    let cur = s;
    for (const tk of 'RRRR'.split('')) {
      const next = replayCatPlan(cur, [tk]).end;
      const boxMoved = JSON.stringify(next.board.map((r) => r.map((c) => c.type))) !== JSON.stringify(cur.board.map((r) => r.map((c) => c.type)));
      if (boxMoved) pushCells.push(`${rc(cur.catPosition)}→${rc(next.catPosition)}`);
      cur = next;
    }
    console.log(`HV5-D4 T4 trap=${s.trapPosition ? rc(s.trapPosition) : 'none'} catTrapsRemaining=${s.catTrapsRemaining} placeTrap legal at the start=${place.illegalAt === null} blockedTunnels=${s.blockedTunnels.map(rc).join('/') || 'none'}`);
    console.log(`HV5-D4 T4 trap=${s.trapPosition ? rc(s.trapPosition) : 'none'} catTrapsRemaining=${s.catTrapsRemaining} placeTrap legal at the start=${place.illegalAt === null} blockedTunnels=${s.blockedTunnels.map(rc).join('/') || 'none'}`);
    console.log(`HV5-D4 witness turn-1 RRRR end=${rc(witness.end.catPosition)} box pushed inside turn 1=${pushCells.length > 0 ? pushCells.join(' ') : 'no'} boardChanged=${JSON.stringify(witness.end.board.map((r) => r.map((c) => c.type))) !== JSON.stringify(s.board.map((r) => r.map((c) => c.type)))} `
      + '| the prover witness is RRRR + (mouse) + RRRU, so the box work that keeps the defence alive happens on cat turn 2 — one switch beyond a depth-1 leaf');
    // the whole Turn #4 defence the prover found is a box/corridor march with the
    // trap already spent — so the loss is not a trap-placement policy failure
    expect(place.illegalAt, 'the cat has no trap to place on Turn #4').toBe('P');
    expect(s.catTrapsRemaining).toBe(0);
  });
});
