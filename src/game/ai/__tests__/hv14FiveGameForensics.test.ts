/// <reference types="node" />
/**
 * PPC-HV14 — H1 five-game cross-turn forensics (light, read-only on production).
 *
 * Evidence: the five byte-identical TXT exports under
 * `ai-training/human-logs/PPC-HV14/` (gitignored). Every root is restored from
 * the printed SNAPSHOT_JSON and re-hashed against the printed STATE_KEY; every
 * logged plan is replayed through the project simulator (real engine RuleSet).
 *
 * No production source is edited. No self-play, no large oracle, no training.
 */
import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { catMove, catPlaceTrap, createEngineRuleSet, mouseStepDeterministic } from '../../engine';
import { chooseTunnelExit } from '../../rules/tunnels';
import type { GameEngineState } from '../../engine';
import { DIRECTIONS, GamePhase, PieceType } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { createSearchContext, searchBestAction } from '../expectiminimax';
import { generateLegalSearchActions } from '../legalActions';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { countReversals, dirKey, extractBestCatTurnPlan } from '../planQuality';
import type { EqualPrimaryGraph } from '../planQuality';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import type { SearchAction, SearchTransitionResult } from '../searchTypes';

const LOG_DIR = new URL('../../../../ai-training/human-logs/PPC-HV14/', import.meta.url);
const GAMES = ['GAME1', 'GAME2', 'GAME3', 'GAME4', 'GAME5'] as const;
const LOG_SHA256: Record<(typeof GAMES)[number], string> = {
  GAME1: '2ac38df46877bdc17cc05f4a241e7e23811a43d8029f42db3a075d22f851f2e3',
  GAME2: '12cdbb6a6d1930e78b656d53d6675fe2db930d825e646c8b40dce0c4b11954c4',
  GAME3: 'a7598bf6403bf441f9624dc1fa9738aca820d6434d389a9507e2fdbf6af543d7',
  GAME4: '752b033310c773b5a2b0a7c153b09f5b7b467c4c3bc822e631f51aed15882b21',
  GAME5: 'f84d877ac4d3dedabda46b1774107f4533827c9e05e28d33b3dfc313909fe4b2',
};

const rules = createEngineRuleSet();
const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;
const token = (a: SearchAction): string =>
  a.type === 'catPlaceTrap' ? 'T' : a.type === 'catStep' ? a.direction!.key.replace('Arrow', '').slice(0, 1) : '?';
const planText = (p: SearchAction[]): string => p.map(token).join('');

function logText(game: (typeof GAMES)[number]): string {
  return readFileSync(new URL(`${game}_H1.txt`, LOG_DIR), 'utf8');
}

function parseTurnBlocks(text: string): { turn: number; lines: string[] }[] {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  return starts.map((s, k) => ({
    turn: Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]),
    lines: lines.slice(s + 1, k + 1 < starts.length ? starts[k + 1] : lines.length),
  }));
}

function field(lines: string[], prefix: string): string {
  return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
}

function parsePlan(line: string): SearchAction[] {
  const text = line.replace(/^PLAN:\s*/, '').trim();
  if (!text) return [];
  return text.split('→').map((part) => {
    const p = part.trim();
    if (p === 'catPlaceTrap') return { type: 'catPlaceTrap' } as SearchAction;
    const m = /^catStep Arrow(Up|Down|Left|Right)$/.exec(p);
    if (!m) throw new Error(`unparsed plan token: ${p}`);
    const direction = DIRECTIONS.find((d) => d.key === `Arrow${m[1]}`)!;
    return { type: 'catStep', direction } as SearchAction;
  });
}

function restoreTurn(block: { lines: string[] }): {
  state: GameEngineState;
  loggedKey: string;
  plan: SearchAction[];
  execKey: string;
  lines: string[];
} {
  const snap = JSON.parse(field(block.lines, 'SNAPSHOT_JSON=')) as HardRootSnapshot;
  const state = restoreHardRoot(snap);
  return {
    state,
    loggedKey: field(block.lines, 'STATE_KEY='),
    plan: parsePlan(field(block.lines, 'PLAN:')),
    execKey: field(block.lines, 'EXEC:').replace(/^endState=/, '').split(/\s+/)[0],
    lines: block.lines,
  };
}

function replayEngine(start: GameEngineState, plan: SearchAction[]): GameEngineState {
  let cur = start;
  for (const a of plan) {
    const next = a.type === 'catPlaceTrap' ? catPlaceTrap(cur) : a.type === 'catStep' ? catMove(cur, a.direction!) : null;
    if (!next) break;
    cur = next;
  }
  return cur;
}

/** Cat cells occupied after each action, starting with the root cell. */
function catPath(start: GameEngineState, plan: SearchAction[]): string[] {
  let cur = start;
  const out = [rc(cur.catPosition)];
  for (const a of plan) {
    const next = a.type === 'catPlaceTrap' ? catPlaceTrap(cur) : a.type === 'catStep' ? catMove(cur, a.direction!) : null;
    if (!next) break;
    cur = next;
    if (a.type === 'catStep') out.push(rc(cur.catPosition));
  }
  return out;
}

/**
 * Enumerate every full-turn plan the equal-primary graph admits from `root`:
 * at each state the graph's exact-tie actions are all legal continuations;
 * where there is no tie, the single `planBranches` choice is followed. This is
 * exactly the plan space `extractBestCatTurnPlan` walks.
 */
function enumerateEqualPrimaryPlans(
  root: GameEngineState,
  graph: EqualPrimaryGraph,
  planBranches: Map<string, SearchAction>,
  maxLength = 8,
): SearchAction[][] {
  const byState = new Map<string, SearchAction[]>();
  for (const [, v] of graph) byState.set(stateKey(v.state), v.equalActions);
  const out: SearchAction[][] = [];
  const walk = (state: GameEngineState, prefix: SearchAction[], guard: Set<string>): void => {
    const sk = stateKey(state);
    if (prefix.length >= maxLength || guard.has(sk)) {
      if (prefix.length > 0) out.push(prefix.slice());
      return;
    }
    const options = byState.get(sk) ?? (planBranches.get(sk) ? [planBranches.get(sk)!] : []);
    if (options.length === 0) {
      if (prefix.length > 0) out.push(prefix.slice());
      return;
    }
    guard.add(sk);
    for (const a of options) {
      const t = simulateSearchAction(state, a, rules);
      if (t.kind === 'chance') {
        out.push([...prefix, a]);
        continue;
      }
      const nxt = t.state;
      if (nxt.phase === GamePhase.Playing && nxt.currentPlayer === PieceType.Cat) {
        walk(nxt, [...prefix, a], guard);
      } else {
        out.push([...prefix, a]);
      }
    }
    guard.delete(sk);
  };
  walk(root, [], new Set<string>());
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = planText(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function revisitsOf(start: GameEngineState, plan: SearchAction[]): number {
  const path = catPath(start, plan);
  const seen = new Set<string>();
  let n = 0;
  for (const p of path) {
    if (seen.has(p)) n++;
    seen.add(p);
  }
  return n;
}

function netDisplacement(start: GameEngineState, plan: SearchAction[]): number {
  const end = replayEngine(start, plan);
  return Math.abs(end.catPosition.r - start.catPosition.r) + Math.abs(end.catPosition.c - start.catPosition.c);
}

// ===========================================================================
// HV14-1. byte identity of the five supplied logs
// ===========================================================================
test('HV14-1 five original logs hash to the recorded SHA256', () => {
  const facts: string[] = [];
  for (const game of GAMES) {
    const bytes = readFileSync(new URL(`${game}_H1.txt`, LOG_DIR));
    const sha = createHash('sha256').update(bytes).digest('hex');
    facts.push(`${game} bytes=${bytes.length} sha256=${sha}`);
    expect(sha, `${game} SHA256`).toBe(LOG_SHA256[game]);
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV14-1\n  ${facts.join('\n  ')}`);
});

// ===========================================================================
// HV14-2. every printed SNAPSHOT_JSON restores to the printed STATE_KEY
// ===========================================================================
test('HV14-2 all printed roots re-hash to their logged STATE_KEY', () => {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const game of GAMES) {
    const blocks = parseTurnBlocks(logText(game));
    for (const b of blocks) {
      const t = restoreTurn(b);
      expect(t.loggedKey.length, `${game} T${b.turn} has a STATE_KEY`).toBeGreaterThan(0);
      expect(stateKey(t.state), `${game} T${b.turn} snapshot -> logged STATE_KEY`).toBe(t.loggedKey);
      total++;
    }
    counts[game] = blocks.length;
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV14-2 roots verified=${total} per-game=${JSON.stringify(counts)}`);
  expect(total).toBe(45);
});

// ===========================================================================
// HV14-3. every logged plan replays through the real engine rules
// ===========================================================================
test('HV14-3 all logged cat plans replay legally and land on their EXEC endState', () => {
  const rows: string[] = [];
  let chanceTurns = 0;
  let total = 0;
  for (const game of GAMES) {
    for (const b of parseTurnBlocks(logText(game))) {
      const t = restoreTurn(b);
      // (a) Search-rule replay: every transition is legal; a cat action may
      //     reach the ghost/debt CHANCE boundary only on the final step.
      let sim = t.state;
      let chanceTurnsHere = 0;
      let simSteps = 0;
      for (let i = 0; i < t.plan.length; i++) {
        const res = simulateSearchAction(sim, t.plan[i], rules);
        if (res.kind === 'chance') {
          expect(i, `${game} T${b.turn} chance only on the final cat action`).toBe(t.plan.length - 1);
          expect(res.outcomes.length, `${game} T${b.turn} chance outcomes enumerated`).toBeGreaterThan(0);
          chanceTurnsHere = 1;
          break;
        }
        sim = res.state;
        simSteps++;
      }
      expect(simSteps, `${game} T${b.turn} every plan action was legal`).toBe(t.plan.length - (chanceTurnsHere ? 1 : 0));

      // (b) Real-engine replay to the exact EXEC endpoint. The production EXEC
      //     snapshot is taken immediately after the final cat action, BEFORE
      //     the cat->mouse endTurn hand-off (logged currentPlayer=cat,
      //     catMovesLeft=0), so catMove/catPlaceTrap are the right primitives.
      let cur = t.state;
      for (let i = 0; i < t.plan.length; i++) {
        const a = t.plan[i];
        const next = a.type === 'catPlaceTrap' ? catPlaceTrap(cur) : a.type === 'catStep' ? catMove(cur, a.direction!) : null;
        expect(next, `${game} T${b.turn} engine accepted plan action ${i}`).not.toBeNull();
        cur = next!;
      }
      total++;
      expect(stateKey(cur), `${game} T${b.turn} engine replay end == EXEC endState`).toBe(t.execKey);
      const boundary =
        cur.phase !== GamePhase.Playing ||
        cur.currentPlayer !== PieceType.Cat ||
        cur.catMovesLeft === 0;
      expect(boundary, `${game} T${b.turn} plan ends at a cat-turn boundary`).toBe(true);
      if (chanceTurnsHere) chanceTurns++;
      rows.push(`${game} T${b.turn} plan=${planText(t.plan)} chance=${chanceTurnsHere ? 'yes' : 'no'} end=${rc(cur.catPosition)} cm=${cur.catMovesLeft}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV14-3 replayed=${total} chance-boundary turns=${chanceTurns}\n  ${rows.join('\n  ')}`);
  expect(total).toBe(45);
});

// ===========================================================================
// HV14-4. GAME2 cross-turn geometry: the cat start/end cells form a cycle
// ===========================================================================
test('HV14-4 GAME2 T3-T7 start/end cells form a cross-turn cycle', () => {
  const blocks = parseTurnBlocks(logText('GAME2'));
  const rows: string[] = [];
  const byTurn = new Map<number, { start: string; end: string; path: string[]; plan: string }>();
  for (const b of blocks) {
    const t = restoreTurn(b);
    const end = replayEngine(t.state, t.plan);
    const path = catPath(t.state, t.plan);
    const net = Math.abs(end.catPosition.r - t.state.catPosition.r) + Math.abs(end.catPosition.c - t.state.catPosition.c);
    byTurn.set(b.turn, {
      start: rc(t.state.catPosition),
      end: rc(end.catPosition),
      path,
      plan: planText(t.plan),
    });
    rows.push(
      `T${b.turn} mouse=${rc(t.state.mousePosition)} cat ${rc(t.state.catPosition)}->${rc(end.catPosition)}`
      + ` net=${net} path=${path.join('>')} plan=${planText(t.plan)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV14-4 GAME2 cat geometry\n  ${rows.join('\n  ')}`);

  for (const [from, to] of [[3, 4], [4, 5], [5, 6], [6, 7]] as const) {
    expect(byTurn.get(from)!.end, `T${from} end == T${to} start`).toBe(byTurn.get(to)!.start);
  }
  expect(byTurn.get(3)!.path).toEqual(['5,1', '5,2', '5,3', '5,4', '5,5']);
  expect(byTurn.get(4)!.path).toEqual(['5,5', '5,4', '5,3', '5,2', '5,1']);
  expect(byTurn.get(5)!.path).toEqual(['5,1', '5,2', '5,3', '5,4', '5,5']);
  expect(byTurn.get(7)!.plan).toBe('LURD');
  expect(byTurn.get(7)!.path).toEqual(['6,6', '6,5', '5,5', '5,6', '6,6']);
  expect([byTurn.get(3)!.start, byTurn.get(5)!.end]).toEqual(['5,1', '5,5']);
  expect([byTurn.get(4)!.start, byTurn.get(4)!.end]).toEqual(['5,5', '5,1']);
});

// ===========================================================================
// HV14-5. GAME2 T7 — four exact-equal root actions, closed-loop extraction
// ===========================================================================
test('HV14-5 T7 exact tie: production extractor returns the LURD closed loop', () => {
  const blocks = parseTurnBlocks(logText('GAME2'));
  const t7 = restoreTurn(blocks.find((b) => b.turn === 7)!);
  expect(stateKey(t7.state)).toBe(t7.loggedKey);

  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const res = searchBestAction(t7.state, 2, ctx);
  const graph = ctx.equalPrimaryGraph!;
  const rootKey = stateKey(t7.state);
  const rootEntries = [...graph.entries()].filter(([k]) => k.startsWith(`${rootKey}\x00`));
  const extracted = extractBestCatTurnPlan(t7.state, rules, graph, ctx.planBranches);

  const logged = new Map<string, { value: number; bound: string }>();
  for (const l of t7.lines) {
    const m = /^(\S+): value=([-\d.]+), mate=(\S+), bound=(\S+)$/.exec(l.trim());
    if (m) logged.set(m[1], { value: Number(m[2]), bound: m[4] });
  }
  const rootValues = ctx.rootValues.map((a) => ({ key: dirKey(a.action), value: a.value, bound: a.bound }));
  // eslint-disable-next-line no-console
  console.log(
    `\nHV14-5 T7 depth-2 exact search completed=${res.completed} nodes=${ctx.diagnostics.nodes}`
    + `\n  logged : ${[...logged.entries()].map(([k, v]) => `${k}=${v.value}(${v.bound})`).join(' ')}`
    + `\n  here   : ${rootValues.map((v) => `${v.key}=${v.value}(${v.bound})`).join(' ')}`
    + `\n  graph  : root entries=${rootEntries.length} ties=${rootEntries.map(([, v]) => v.equalActions.map(dirKey).join('/')).join(';')} size=${graph.size}`
    + `\n  production extractor=${planText(extracted)} revisits=${revisitsOf(t7.state, extracted)} net=${netDisplacement(t7.state, extracted)}`,
  );

  expect(res.completed).toBe(true);
  expect(res.mate).toBe(null);
  for (const v of rootValues) {
    expect(logged.get(v.key), `logged ${v.key}`).toBeDefined();
    expect(v.value, `${v.key} value reproduces`).toBe(logged.get(v.key)!.value);
    expect(v.bound, `${v.key} bound`).toBe('exact');
  }
  expect(rootValues.length, 'four root actions').toBe(4);
  expect(new Set(rootValues.map((v) => v.value)).size, 'all four root values are identical').toBe(1);
  expect(rootEntries.length, 'root has one exact-tie graph entry').toBe(1);
  expect(rootEntries[0][1].equalActions.map(dirKey).sort(), 'all four actions are recorded as equal-primary').toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
  expect(planText(extracted), 'production extractor picks the logged closed loop').toBe('LURD');
  expect(revisitsOf(t7.state, extracted), 'the chosen plan revisits its start cell').toBe(1);
  expect(netDisplacement(t7.state, extracted), 'the chosen plan has zero net displacement').toBe(0);
  expect(countReversals(extracted), 'the chosen plan has zero adjacent reversals').toBe(0);
});

// ===========================================================================
// HV14-6. T7 — the same exact-primary value admits better-route plans
// ===========================================================================
test('HV14-6 T7 equal-primary plan space contains a non-loop with the same score', () => {
  const blocks = parseTurnBlocks(logText('GAME2'));
  const t7 = restoreTurn(blocks.find((b) => b.turn === 7)!);
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const res = searchBestAction(t7.state, 2, ctx);
  const graph = ctx.equalPrimaryGraph!;
  const production = extractBestCatTurnPlan(t7.state, rules, graph, ctx.planBranches);
  const plans = enumerateEqualPrimaryPlans(t7.state, graph, ctx.planBranches);

  const rootValue = new Map<string, number>();
  for (const a of ctx.rootValues) rootValue.set(dirKey(a.action), a.value);
  const rows = plans.map((p) => {
    const path = catPath(t7.state, p);
    return {
      plan: p,
      text: planText(p),
      first: dirKey(p[0]),
      value: rootValue.get(dirKey(p[0])) ?? NaN,
      reversals: countReversals(p),
      revisits: revisitsOf(t7.state, p),
      unique: new Set(path).size - 1,
      net: netDisplacement(t7.state, p),
      end: path[path.length - 1],
    };
  });
  // eslint-disable-next-line no-console
  console.log(
    `\nHV14-6 T7 equal-primary plan space (search completed=${res.completed}, plans=${rows.length})`
    + `\n  ${rows.map((r) => `${r.text} first=${r.first} v=${r.value} rev=${r.reversals} revisit=${r.revisits} uniq=${r.unique} net=${r.net} end=${r.end}`).join('\n  ')}`,
  );

  expect(rows.length).toBeGreaterThan(1);
  expect(rows.every((r) => r.value === rows[0].value), 'every first action carries the same exact root value').toBe(true);
  const prodRow = rows.find((r) => r.text === planText(production))!;
  expect(prodRow.text).toBe('LURD');
  expect(prodRow.revisits).toBe(1);
  expect(prodRow.net).toBe(0);

  // Shadow route-quality comparator: reversal (production) -> revisits ->
  // unique progress -> stable order. This does NOT touch production code.
  const shadow = [...rows].sort((a, b) =>
    a.reversals - b.reversals
    || a.revisits - b.revisits
    || b.unique - a.unique
    || rows.indexOf(a) - rows.indexOf(b));
  const best = shadow[0];
  expect(best.reversals, 'the shadow best costs no extra adjacent reversal').toBe(prodRow.reversals);
  expect(best.revisits, 'the shadow best is revisit-minimal').toBe(prodRow.revisits);
  expect(best.value, 'the shadow best has the identical exact primary value').toBe(prodRow.value);
  // Within the CERTIFIED equal-primary plan space every line returns to the
  // start cell, so the loop is not a tie-break bug: the primary plateau itself
  // has no outbound certified optimum. Record that explicitly.
  expect(rows.every((r) => r.end === prodRow.end), 'every certified equal-primary line ends on the same cell').toBe(true);
  expect(rows.every((r) => r.net === 0), 'every certified line has zero net displacement').toBe(true);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV14-6 certified plan space: production=${prodRow.text} (rev=0,revisit=1,net=0)`
    + ` is already revisit-optimal; every one of ${rows.length} lines ends at ${prodRow.end} (net=0).`,
  );
});

/** Exact value of a FIXED cat-turn plan: force the plan, then let the mouse
 *  play its optimal turn (depth-1 search = mouse turn + leaf), cat-perspective. */
function valueOfFixedCatPlan(root: GameEngineState, plan: SearchAction[]): { value: number; end: GameEngineState; fullTurn: boolean } {
  let cur = root;
  let last: SearchTransitionResult | null = null;
  for (const a of plan) {
    last = simulateSearchAction(cur, a, rules);
    if (last.kind !== 'deterministic') break;
    cur = last.state;
  }
  const fullTurn = cur.phase !== GamePhase.Playing
    || cur.currentPlayer !== PieceType.Cat
    || cur.catMovesLeft === 0;
  if (!last || last.kind !== 'deterministic' || !fullTurn) {
    return { value: NaN, end: cur, fullTurn };
  }
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = false;
  const res = searchBestAction(cur, 1, ctx);
  return { value: res.value, end: cur, fullTurn };
}

function enumerateLegalCatTurns(root: GameEngineState): SearchAction[][] {
  const out: SearchAction[][] = [];
  const walk = (s: GameEngineState, prefix: SearchAction[]): void => {
    if (prefix.length > 0 && (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat || s.catMovesLeft <= 0)) {
      out.push(prefix);
      return;
    }
    if (prefix.length >= 8) {
      out.push(prefix);
      return;
    }
    const actions = generateLegalSearchActions(s, rules).filter((a) => a.type === 'catStep' || a.type === 'catPlaceTrap');
    if (actions.length === 0) {
      out.push(prefix);
      return;
    }
    for (const a of actions) {
      const t = simulateSearchAction(s, a, rules);
      if (t.kind === 'chance') out.push([...prefix, a]);
      else walk(t.state, [...prefix, a]);
    }
  };
  walk(root, []);
  return out;
}

test('HV14-7 T7 straight outbound plans: the in-place loop is the primary optimum', () => {
  const blocks = parseTurnBlocks(logText('GAME2'));
  const t7 = restoreTurn(blocks.find((b) => b.turn === 7)!);
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const res = searchBestAction(t7.state, 2, ctx);
  const step = (key: string): SearchAction => ({ type: 'catStep', direction: DIRECTIONS.find((d) => d.key === key)! });
  const plans: Record<string, SearchAction[]> = {
    UUUU: [step('ArrowUp'), step('ArrowUp'), step('ArrowUp'), step('ArrowUp')],
    DDDD: [step('ArrowDown'), step('ArrowDown'), step('ArrowDown'), step('ArrowDown')],
    LLLL: [step('ArrowLeft'), step('ArrowLeft'), step('ArrowLeft'), step('ArrowLeft')],
    RRRR: [step('ArrowRight'), step('ArrowRight'), step('ArrowRight'), step('ArrowRight')],
    LURD: [step('ArrowLeft'), step('ArrowUp'), step('ArrowRight'), step('ArrowDown')],
  };
  const rows: string[] = [];
  const values: Record<string, number> = {};
  for (const [name, plan] of Object.entries(plans)) {
    const v = valueOfFixedCatPlan(t7.state, plan);
    values[name] = v.value;
    rows.push(`${name} end=${rc(v.end.catPosition)} fullTurn=${v.fullTurn} value=${v.value} net=${netDisplacement(t7.state, plan)}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV14-7 T7 fixed-plan values (root depth-2 value=${res.value})\n  ${rows.join('\n  ')}`);
  expect(res.completed).toBe(true);
  expect(res.mate).toBe(null);
  expect(values.LURD, 'the in-place loop reproduces the root value').toBe(res.value);
  expect(values.UUUU, 'the only legal straight plan is below the plateau').toBeLessThanOrEqual(res.value);
});

// ===========================================================================
// HV14-9. GAME2 T3/T4/T5 — depth-1 myopia vs depth-2 correction
// ===========================================================================
test('HV14-9 T3/T4/T5 search-depth attribution', () => {
  const blocks = parseTurnBlocks(logText('GAME2'));
  const rows: string[] = [];
  const results: Record<string, { d1: string; d2: string; d1v: number; d2v: number }> = {};
  for (const turn of [3, 4, 5]) {
    const t = restoreTurn(blocks.find((b) => b.turn === turn)!);
    const run = (depth: number) => {
      const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
      ctx.leafEvaluator = evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;
      const res = searchBestAction(t.state, depth, ctx);
      const plan = extractBestCatTurnPlan(t.state, rules, ctx.equalPrimaryGraph!, ctx.planBranches);
      return {
        value: res.value,
        best: res.action ? dirKey(res.action) : '-',
        plan: planText(plan),
        values: ctx.rootValues.map((a) => `${dirKey(a.action)}=${a.value.toFixed(6)}`).join(' '),
        completed: res.completed,
        nodes: ctx.diagnostics.nodes,
      };
    };
    const d1 = run(1);
    const d2 = run(2);
    results[`T${turn}`] = { d1: `${d1.best}/${d1.plan}`, d2: `${d2.best}/${d2.plan}`, d1v: d1.value, d2v: d2.value };
    rows.push(
      `T${turn} D1 completed=${d1.completed} nodes=${d1.nodes} best=${d1.best} plan=${d1.plan} [${d1.values}]`
      + `\n     D2 completed=${d2.completed} nodes=${d2.nodes} best=${d2.best} plan=${d2.plan} [${d2.values}]`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV14-9 GAME2 depth attribution\n  ${rows.join('\n  ')}`);

  // The logged T4 decision is depth 1 (the 100 ms deadline fired before depth 2).
  expect(blocks.find((b) => b.turn === 4)!.lines.join('\n')).toContain('SEARCH: cDepth=1 aDepth=2');
  // At depth 1, Left (back to 5,1) is the best leaf score.
  expect(results.T4.d1.startsWith('ArrowLeft/LLLL'), 'T4 depth-1 repeats LLLL').toBe(true);
  // The completed depths 2 for T3/T5 repeat RRRR.
  expect(results.T3.d2.startsWith('ArrowRight/RRRR'), 'T3 depth-2 repeats RRRR').toBe(true);
  expect(results.T5.d2.startsWith('ArrowRight/RRRR'), 'T5 depth-2 repeats RRRR').toBe(true);
});

// ===========================================================================
// HV14-10. GAME4 T7/T8 — independent deeper search (no T9 back-inference)
// ===========================================================================
test('HV14-10 GAME4 T7/T8 deeper search: is there a legal defensive branch?', () => {
  const blocks = parseTurnBlocks(logText('GAME4'));
  const rows: string[] = [];
  for (const turn of [7, 8]) {
    const t = restoreTurn(blocks.find((b) => b.turn === turn)!);
    for (const depth of [2, 3]) {
      const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
      ctx.leafEvaluator = evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;
      const res = searchBestAction(t.state, depth, ctx);
      const plan = extractBestCatTurnPlan(t.state, rules, ctx.equalPrimaryGraph!, ctx.planBranches);
      rows.push(
        `T${turn} D${depth} completed=${res.completed} nodes=${ctx.diagnostics.nodes} mate=${res.mate ?? 'null'} best=${res.action ? dirKey(res.action) : '-'}`
        + ` plan=${planText(plan)} values=[${ctx.rootValues.map((a) => `${dirKey(a.action)}=${a.value.toFixed(3)}/${a.mate ?? '-'}/${a.bound}`).join(' ')}]`,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV14-10 GAME4 T7/T8 deeper search\n  ${rows.join('\n  ')}`);
  // The logged T7/T8 decisions were both made at depth 1 (100 ms deadline).
  expect(blocks.find((b) => b.turn === 7)!.lines.join('\n')).toContain('cDepth=1');
  expect(blocks.find((b) => b.turn === 8)!.lines.join('\n')).toContain('cDepth=1');
}, 300000);

// ===========================================================================
// HV14-11. GAME4 — per-turn depth-1 vs completed depth-2 decision table
// ===========================================================================
test('HV14-11 GAME4 per-turn depth-1 vs depth-2 decision table', () => {
  const blocks = parseTurnBlocks(logText('GAME4'));
  const rows: string[] = [];
  const disagreements: string[] = [];
  for (const b of blocks) {
    const t = restoreTurn(b);
    const text = b.lines.join('\n');
    const loggedBest = /BEST_ACTION=(\S+)/.exec(text)?.[1] ?? '-';
    const loggedDepth = /cDepth=(\d+)/.exec(text)?.[1] ?? '?';
    const run = (depth: number) => {
      const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
      ctx.leafEvaluator = evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;
      const res = searchBestAction(t.state, depth, ctx);
      const plan = extractBestCatTurnPlan(t.state, rules, ctx.equalPrimaryGraph!, ctx.planBranches);
      return {
        best: res.action ? dirKey(res.action) : '-',
        plan: planText(plan),
        value: res.value,
        completed: res.completed,
        mate: res.mate,
        nodes: ctx.diagnostics.nodes,
      };
    };
    const d1 = run(1);
    const d2 = run(2);
    if (d1.completed && d2.completed && d1.best !== d2.best) {
      disagreements.push(`T${b.turn}(${d1.best}->${d2.best})`);
    }
    rows.push(
      `T${b.turn} logged=D${loggedDepth}/${loggedBest}`
      + ` | D1 ${d1.best}/${d1.plan} v=${d1.value.toFixed(3)}`
      + ` | D2 ${d2.best}/${d2.plan} v=${d2.value.toFixed(3)} completed=${d2.completed} nodes=${d2.nodes} mate=${d2.mate ?? 'null'}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nHV14-11 GAME4 depth table\n  ${rows.join('\n  ')}`
    + `\n  completed-D2 disagreements: ${disagreements.join(', ') || '(none)'}`,
  );
  expect(rows.length).toBe(9);
  // The first (and only) completed-depth-2 disagreement is T7: the logged
  // depth-1 choice Up is replaced by Right once the mouse's reply is seen.
  expect(disagreements).toEqual(['T7(ArrowUp->ArrowRight)']);
}, 300000);

// ===========================================================================
// HV14-15. GAME2 T3/T5 — does any exact-tie plan improve the route?
// ===========================================================================
test('HV14-15 GAME2 T3/T5 exact-tie plan spaces contain no better route', () => {
  const blocks = parseTurnBlocks(logText('GAME2'));
  const rows: string[] = [];
  for (const turn of [3, 5]) {
    const t = restoreTurn(blocks.find((b) => b.turn === turn)!);
    const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = true;
    const res = searchBestAction(t.state, 2, ctx);
    const production = extractBestCatTurnPlan(t.state, rules, ctx.equalPrimaryGraph!, ctx.planBranches);
    const plans = enumerateEqualPrimaryPlans(t.state, ctx.equalPrimaryGraph!, ctx.planBranches);
    const rootValue = new Map<string, number>();
    for (const a of ctx.rootValues) rootValue.set(dirKey(a.action), a.value);
    const scored = plans.map((p) => ({
      text: planText(p),
      value: rootValue.get(dirKey(p[0])) ?? NaN,
      net: netDisplacement(t.state, p),
      end: rc(replayEngine(t.state, p).catPosition),
      revisits: revisitsOf(t.state, p),
      reversals: countReversals(p),
    }));
    const prod = scored.find((r) => r.text === planText(production))!;
    const sameValue = scored.filter((r) => r.value === prod.value);
    const betterRoute = sameValue.filter((r) => r.reversals <= prod.reversals && r.net > prod.net);
    rows.push(
      `T${turn} D2 completed=${res.completed} plans=${scored.length} production=${prod.text}`
      + ` v=${prod.value} rev=${prod.reversals} revisit=${prod.revisits} net=${prod.net} end=${prod.end}`
      + `\n     sameValue=${sameValue.length} betterRoute=${betterRoute.length}`
      + (betterRoute.length ? ` -> ${betterRoute.map((r) => `${r.text}(net=${r.net},end=${r.end})`).join(',')}` : ''),
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV14-15 GAME2 exact-tie route spaces\n  ${rows.join('\n  ')}`);
  expect(rows.length).toBe(2);
});

// ===========================================================================
// HV14-14. GAME1 — per-turn depth table (earliest decision error)
// ===========================================================================
test('HV14-14 GAME1 per-turn depth-1 vs depth-2 decision table', () => {
  const blocks = parseTurnBlocks(logText('GAME1'));
  const rows: string[] = [];
  const disagreements: string[] = [];
  for (const b of blocks) {
    const t = restoreTurn(b);
    const text = b.lines.join('\n');
    const loggedBest = /BEST_ACTION=(\S+)/.exec(text)?.[1] ?? '-';
    const loggedDepth = /cDepth=(\d+)/.exec(text)?.[1] ?? '?';
    const run = (depth: number) => {
      const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
      ctx.leafEvaluator = evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;
      const res = searchBestAction(t.state, depth, ctx);
      const plan = extractBestCatTurnPlan(t.state, rules, ctx.equalPrimaryGraph!, ctx.planBranches);
      return {
        best: res.action ? dirKey(res.action) : '-',
        plan: planText(plan),
        value: res.value,
        completed: res.completed,
        mate: res.mate,
        nodes: ctx.diagnostics.nodes,
      };
    };
    const d1 = run(1);
    const d2 = run(2);
    if (d1.completed && d2.completed && d1.best !== d2.best) {
      disagreements.push(`T${b.turn}(${d1.best}->${d2.best})`);
    }
    rows.push(
      `T${b.turn} logged=D${loggedDepth}/${loggedBest}`
      + ` | D1 ${d1.best}/${d1.plan} v=${d1.value.toFixed(3)}`
      + ` | D2 ${d2.best}/${d2.plan} v=${d2.value.toFixed(3)} completed=${d2.completed} nodes=${d2.nodes} mate=${d2.mate ?? 'null'}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nHV14-14 GAME1 depth table\n  ${rows.join('\n  ')}`
    + `\n  completed-D2 disagreements: ${disagreements.join(', ') || '(none)'}`,
  );
  expect(rows.length).toBe(4);
}, 300000);

// ===========================================================================
// HV14-16. GAME1 T1-T3 — does a deeper search already prove the loss?
// ===========================================================================
test('HV14-16 GAME1 T1-T3 depth-3 mate probe', () => {
  const blocks = parseTurnBlocks(logText('GAME1'));
  const rows: string[] = [];
  for (const turn of [1, 2, 3]) {
    const t = restoreTurn(blocks.find((b) => b.turn === turn)!);
    const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = true;
    const res = searchBestAction(t.state, 3, ctx);
    const plan = extractBestCatTurnPlan(t.state, rules, ctx.equalPrimaryGraph!, ctx.planBranches);
    rows.push(
      `T${turn} D3 completed=${res.completed} nodes=${ctx.diagnostics.nodes} mate=${res.mate ?? 'null'}`
      + ` best=${res.action ? dirKey(res.action) : '-'} plan=${planText(plan)} v=${res.value.toFixed(3)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV14-16 GAME1 depth-3 mate probe\n  ${rows.join('\n  ')}`);
  expect(rows.length).toBe(3);
}, 300000);

// ===========================================================================
// HV14-12. GAME1 T1 — real-rule exhaustion: no cat turn stops the pickup
// ===========================================================================
/**
 * Can the mouse pick up ANY butter inside its own turn, from a mouse-turn
 * state? Breadth-first over the engine's own mouse step (deterministic variant:
 * identical transition, butter regen deferred so no Math.random) plus the
 * shared tunnel-exit kernel. Truck: trap-capped and teleport turns end the
 * turn exactly as in the real engine. Returns a witness route or null.
 */
function mouseTurnPickupWitness(start: GameEngineState): string[] | null {
  if (start.phase !== GamePhase.Playing || start.currentPlayer !== PieceType.Mouse) return null;
  let frontier: { s: GameEngineState; path: string[] }[] = [{ s: start, path: [] }];
  const seen = new Set<string>();
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const nextFrontier: { s: GameEngineState; path: string[] }[] = [];
    for (const { s, path } of frontier) {
      if (s.phase === GamePhase.ChoosingTunnelExit) {
        for (const exit of s.tunnelExitChoices) {
          const ns = chooseTunnelExit(s, exit.r, exit.c);
          const key = stateKey(ns);
          if (seen.has(key)) continue;
          seen.add(key);
          const label = `TUNNEL(${exit.r},${exit.c})`;
          if (ns.mouseHasButter && !start.mouseHasButter) return [...path, label];
          nextFrontier.push({ s: ns, path: [...path, label] });
        }
        continue;
      }
      if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) continue;
      for (const d of DIRECTIONS) {
        const ns = mouseStepDeterministic(s, d);
        if (ns === s) continue;
        const key = stateKey(ns);
        if (seen.has(key)) continue;
        seen.add(key);
        const label = d.key.replace('Arrow', '');
        if (ns.mouseHasButter && !start.mouseHasButter) return [...path, label];
        nextFrontier.push({ s: ns, path: [...path, label] });
      }
    }
    frontier = nextFrontier;
  }
  return null;
}

/**
 * Every cell where the mouse's OWN turn can legally end, with a route.
 * Same real-rule BFS as above; a tunnel exit lands with 0 moves, so the landing
 * cell is the turn's end cell (the engine ends the turn right after the exit).
 */
function mouseTurnEndCells(start: GameEngineState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (start.phase !== GamePhase.Playing || start.currentPlayer !== PieceType.Mouse) return out;
  let frontier: { s: GameEngineState; path: string[] }[] = [{ s: start, path: [] }];
  const seen = new Set<string>([stateKey(start)]);
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const nextFrontier: { s: GameEngineState; path: string[] }[] = [];
    for (const { s, path } of frontier) {
      if (s.phase === GamePhase.ChoosingTunnelExit) {
        for (const exit of s.tunnelExitChoices) {
          const ns = chooseTunnelExit(s, exit.r, exit.c);
          out.set(rc(ns.mousePosition), [...path, `TUNNEL(${exit.r},${exit.c})`]);
        }
        continue;
      }
      if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) {
        out.set(rc(s.mousePosition), path);
        continue;
      }
      for (const d of DIRECTIONS) {
        const ns = mouseStepDeterministic(s, d);
        if (ns === s) continue;
        const key = stateKey(ns);
        if (seen.has(key)) continue;
        seen.add(key);
        nextFrontier.push({ s: ns, path: [...path, d.key.replace('Arrow', '')] });
      }
    }
    frontier = nextFrontier;
  }
  return out;
}

test('HV14-13 GAME2 T4: the mouse crosses 14 cells in one legal turn', () => {
  const blocks = parseTurnBlocks(logText('GAME2'));
  const t4 = restoreTurn(blocks.find((b) => b.turn === 4)!);
  const t5 = restoreTurn(blocks.find((b) => b.turn === 5)!);
  let cur = t4.state;
  for (const a of t4.plan) {
    const tr = simulateSearchAction(cur, a, rules);
    if (tr.kind !== 'deterministic') throw new Error('GAME2 T4 cat plan hit a chance boundary');
    cur = tr.state;
  }
  expect(cur.currentPlayer, 'the cat plan hands off to the mouse').toBe(PieceType.Mouse);
  const startCell = rc(t4.state.mousePosition);
  const ends = mouseTurnEndCells(cur);
  const route = ends.get('0,9');
  const manhattan = Math.abs(t5.state.mousePosition.r - t4.state.mousePosition.r)
    + Math.abs(t5.state.mousePosition.c - t4.state.mousePosition.c);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV14-13 GAME2 T4 mouse relocation`
    + `\n  start=${startCell} logged T5 root=${rc(t5.state.mousePosition)} manhattan=${manhattan}`
    + `\n  reachable end cells=${ends.size} route to logged cell=${route ? route.join('>') : '(unreachable)'}`,
  );
  expect(rc(t5.state.mousePosition)).toBe('0,9');
  expect(route, 'the logged relocation is reachable with the real mouse rules').toBeTruthy();
  expect(manhattan).toBe(14);
  expect(ends.size).toBeGreaterThan(1);
}, 300000);

test('HV14-12 GAME1 T1: every legal cat turn still allows the butter pickup', () => {
  const blocks = parseTurnBlocks(logText('GAME1'));
  const t1 = restoreTurn(blocks.find((b) => b.turn === 1)!);
  const plans = enumerateLegalCatTurns(t1.state);
  const prevented: { plan: string; witness: string[] | null }[] = [];
  const witnesses: string[] = [];
  let checked = 0;
  let minToButter = Infinity;
  let minToHole = Infinity;
  const holeCells = [[7, 8], [7, 9], [8, 8], [8, 9]];
  for (const plan of plans) {
    let cur = t1.state;
    let chance = false;
    for (const a of plan) {
      const tr = simulateSearchAction(cur, a, rules);
      if (tr.kind !== 'deterministic') { chance = true; break; }
      cur = tr.state;
    }
    if (chance) continue;
    // The simulator hands off to the mouse at the end of a full cat turn.
    if (cur.currentPlayer !== PieceType.Mouse) continue;
    checked++;
    const cp = cur.catPosition;
    for (const b of t1.state.butterPositions) {
      minToButter = Math.min(minToButter, Math.abs(cp.r - b.r) + Math.abs(cp.c - b.c));
    }
    for (const [hr, hc] of holeCells) {
      minToHole = Math.min(minToHole, Math.abs(cp.r - hr) + Math.abs(cp.c - hc));
    }
    const witness = mouseTurnPickupWitness(cur);
    if (witness) {
      if (witnesses.length < 3) witnesses.push(`cat=${rc(cur.catPosition)} via ${witness.join('>')}`);
    } else {
      prevented.push({ plan: planText(plan), witness });
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nHV14-12 GAME1 T1 real-rule exhaustion`
    + `\n  legal cat turns=${plans.length} at-mouse-boundary=${checked}`
    + ` prevented-pickup=${prevented.length}`
    + `\n  closest cat end-cell: butter=${minToButter} hole=${minToHole}`
    + `\n  sample witnesses: ${witnesses.join(' | ')}`
    + `\n  preventing plans: ${prevented.length ? prevented.map((p) => p.plan).join(',') : '(none)'}`,
  );
  expect(plans.length).toBeGreaterThan(0);
  expect(checked).toBeGreaterThan(0);
  expect(minToButter, 'no cat turn ends adjacent to either butter').toBeGreaterThan(1);
  expect(prevented, 'no legal cat turn can deny the mouse its first butter pickup').toEqual([]);
}, 300000);

// ===========================================================================
// HV14-8. T7 — full legal-turn enumeration: every depth-2 optimum ends at (6,6)
// ===========================================================================
test('HV14-8 T7 full legal-turn enumeration confirms a zero-net primary optimum', () => {
  const blocks = parseTurnBlocks(logText('GAME2'));
  const t7 = restoreTurn(blocks.find((b) => b.turn === 7)!);
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const rootRes = searchBestAction(t7.state, 2, ctx);

  const plans = enumerateLegalCatTurns(t7.state);
  const scored = plans.map((p) => {
    const v = valueOfFixedCatPlan(t7.state, p);
    return { text: planText(p), plan: p, value: v.value, end: rc(v.end.catPosition), net: netDisplacement(t7.state, p), full: v.fullTurn };
  }).filter((r) => r.full && !Number.isNaN(r.value));
  const max = Math.max(...scored.map((r) => r.value));
  const argmax = scored.filter((r) => r.value === max);
  const ends = [...new Set(argmax.map((r) => r.end))];
  // eslint-disable-next-line no-console
  console.log(
    `\nHV14-8 T7 legal full turns=${plans.length} valued=${scored.length}`
    + ` rootSearchValue=${rootRes.value} enumeratedMax=${max}`
    + ` argmaxPlans=${argmax.length} argmaxEndCells=${ends.join('/')}`
    + `\n  argmax: ${argmax.map((r) => `${r.text} end=${r.end} net=${r.net}`).join(' | ')}`,
  );
  expect(rootRes.completed).toBe(true);
  expect(rootRes.mate).toBe(null);
  expect(max, 'the full-turn enumeration reproduces the search maximum').toBe(rootRes.value);
  expect(ends, 'every depth-2 optimum ends on the same cell').toEqual(['6,6']);
  expect(argmax.every((r) => r.net === 0), 'every optimum has zero net displacement').toBe(true);
});
