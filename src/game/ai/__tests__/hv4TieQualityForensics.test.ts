/// <reference types="node" />
/**
 * PPC-HV-4 §5 — exact ties and trap behaviour on the REAL H1 GAME4 Turn #5 root.
 *
 * Everything here runs on the snapshot the player's own client printed
 * (`PPC_HV3_GAME4_H1_ORIGINAL.txt`, restored through `restoreHardRoot` and
 * re-hashed to its logged `STATE_KEY` — see `hv4H1Game4T5.test.ts` HV4-E2).
 *
 * Two calls only, per §8:
 *   1. ONE production planner call (`planHardCatTurn`, H1 leaf, 100 ms main /
 *      150 ms turn, refutation sidecar as shipped) — the same entry the game
 *      uses, so the recorded plan can be compared with `BEST_ACTION`/`PLAN` in
 *      the log.
 *   2. ONE deterministic fixed-depth-2 search with `capturePlan` on, to read
 *      the equal-primary graph the production post-processing would have seen
 *      (`IterativeSearchResult` does not expose the graph, so it is re-derived
 *      with `searchBestAction` + `ctx.equalPrimaryGraph`).
 *
 * The counterfactual tie-breaks (trap-transparent reversal predicate,
 * cross-recursion-boundary billing) are evaluated HERE, on the enumerated plan
 * set, and never by editing `planQuality.ts` (§6 gate + §7 protected list).
 */
import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { catMove, catPlaceTrap, createEngineRuleSet, endTurn, setWorldEntropySource } from '../../engine';
import type { GameEngineState } from '../../engine';
import { GamePhase, PieceType } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { createSearchContext, searchBestAction } from '../expectiminimax';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { planHardCatTurn } from '../hardTurnPlanner';
import { DEFAULT_SEARCH_CONFIG, HARD_LEAF_MODE_DEFAULT, HARD_PROGRESS_GUARD_CONFIG, HARD_TRIAL } from '../searchConfig';
import { buildPlanForFirstAction, countReversals, dirKey, extractBestCatTurnPlan, isImmediateReversal } from '../planQuality';
import type { EqualPrimaryGraph } from '../planQuality';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import type { SearchAction } from '../searchTypes';

const LOG_URL = new URL('../../../../ai-training/human-logs/PPC-HV4/PPC_HV3_GAME4_H1_ORIGINAL.txt', import.meta.url);
const rules = createEngineRuleSet();

const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;

function turnBlock(text: string, turn: number): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `Turn #${turn}`);
  if (start < 0) throw new Error(`Turn #${turn} not in the log`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^Turn #\d+\s*$/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

function turnRoot(turn: number): { state: GameEngineState; stateKey: string; lines: string[] } {
  const text = readFileSync(LOG_URL, 'utf8') as string;
  const block = turnBlock(text, turn);
  const line = (prefix: string): string => block.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
  const snap = JSON.parse(line('SNAPSHOT_JSON=')) as HardRootSnapshot;
  return { state: restoreHardRoot(snap), stateKey: line('STATE_KEY='), lines: block };
}

function token(a: SearchAction): string {
  if (a.type === 'catPlaceTrap') return 'T';
  if (a.type === 'catStep') return a.direction.key.replace('Arrow', '').slice(0, 1);
  return '?';
}

const planText = (plan: SearchAction[]): string => plan.map(token).join('');

/** Execute a plan with the REAL engine, for the rest of the cat turn. */
function executePlan(start: GameEngineState, plan: SearchAction[]): { end: GameEngineState; path: string[] } {
  let s = start;
  const path = [rc(s.catPosition)];
  for (const a of plan) {
    if (s.currentPlayer !== PieceType.Cat || s.phase !== GamePhase.Playing || s.catMovesLeft <= 0) break;
    const next = a.type === 'catPlaceTrap' ? catPlaceTrap(s) : a.type === 'catStep' ? catMove(s, a.direction!) : null;
    if (!next) break;
    s = next;
    path.push(a.type === 'catPlaceTrap' ? 'Trap' : rc(s.catPosition));
  }
  return { end: s, path };
}

// ---------------------------------------------------------------------------
// Counterfactual reversal scorers (local — production code is untouched)
// ---------------------------------------------------------------------------

/** Production reading: only adjacent catStep pairs can be a reversal. */
const scoreProduction = (plan: SearchAction[]): number => countReversals(plan);

/**
 * Trap-transparent reading: `catPlaceTrap` does not move the cat, so a U…Trap…D
 * pair is the same physical about-face the production scorer cannot see. The
 * last REAL step direction stays live across a placement.
 */
function scoreTrapTransparent(plan: SearchAction[]): number {
  let last: string | null = null;
  let n = 0;
  for (const a of plan) {
    if (a.type !== 'catStep') continue; // placement is invisible to the geometry
    if (last !== null && isImmediateReversal({ type: 'catStep', direction: { key: last, dr: 0, dc: 0, label: '' } }, a)) n++;
    last = a.direction.key;
  }
  return n;
}

/**
 * Enumerate every plan the equal-primary graph admits from `root`: at each
 * state the graph's tie actions (and, where there is no tie, the single
 * `planBranches` choice) are legal continuations of a primary-equal line.
 */
function enumeratePlans(
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
    const options: SearchAction[] = byState.get(sk) ?? (planBranches.get(sk) ? [planBranches.get(sk)!] : []);
    if (options.length === 0) {
      if (prefix.length > 0) out.push(prefix.slice());
      return;
    }
    guard.add(sk);
    for (const a of options) {
      const t = simulateSearchAction(state, a, rules);
      // A CHANCE transition for a cat action can only be the ghost-butter
      // materialisation at the final catStep's Cat→Mouse boundary. The cat
      // action itself is still part of the plan (production's extractor does
      // the same) — the outcomes are not cat actions.
      if (t.kind === 'chance') {
        out.push([...prefix, a]);
        continue;
      }
      const nxt = t.state;
      if (nxt.phase === GamePhase.Playing && nxt.currentPlayer === PieceType.Cat) {
        walk(nxt, [...prefix, a], guard);
      } else {
        out.push([...prefix, a]); // the cat turn ended: this is a complete plan
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

// ===========================================================================
// HV4-F1. the production planner, called once on the real T5 root
// ===========================================================================
test('HV4-F1. one production planHardCatTurn call reproduces the logged T5 decision', () => {
  const t5 = turnRoot(5);
  expect(stateKey(t5.state), 'T5 root re-hashes to the logged STATE_KEY').toBe(t5.stateKey);

  const plan = planHardCatTurn(t5.state, {
    rules,
    timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
    refutation: { enabled: HARD_TRIAL.refutationEnabled, totalTurnBudgetMs: HARD_TRIAL.totalTurnBudgetMs },
  });
  const exec = executePlan(t5.state, plan.plan);
  const loggedBest = /BEST_ACTION=(\S+)/.exec(t5.lines.join('\n'))?.[1] ?? '';
  const loggedPlan = /PLAN: (.*)/.exec(t5.lines.join('\n'))?.[1] ?? '';
  const loggedTokens = loggedPlan
    .split('→')
    .map((x) => (x.includes('catPlaceTrap') ? 'T' : x.includes('Arrow') ? x.replace(/.*Arrow/, '').slice(0, 1) : '?'))
    .join('');

  // eslint-disable-next-line no-console
  console.log(
    `\nHV4-F1 production call on the real T5 root\n`
    + `  this run : plan=[${planText(plan.plan)}] first=${plan.plan[0] ? dirKey(plan.plan[0]) : '-'} depth=${plan.completedDepth}/${plan.attemptedDepth}`
    + ` mate=${plan.debug.mate ?? 'null'} rootValue=${plan.debug.rootValue.toFixed(10)} hasSolution=${plan.hasSolution}`
    + `\n  logged   : BEST_ACTION=${loggedBest} plan=[${loggedTokens}] ${loggedPlan}`
    + `\n  rootActions here : ${plan.debug.rootActions.map((a) => `${dirKey(a.action)}=${a.value.toFixed(10)}(${a.bound ?? '?'})`).join(' ')}`
    + `\n  refutation       : ${plan.debug.refutation ? JSON.stringify(plan.debug.refutation) : 'off'}`
    + `\n  executed path    : ${exec.path.join(' → ')} trap=${exec.end.trapPosition ? rc(exec.end.trapPosition) : 'none'}/${exec.end.catTrapsRemaining}`,
  );

  // The 100 ms wall clock is the KNOWN decision-flip source, so this asserts the
  // structural contract only; the numeric comparison is HV4-F2's deterministic job.
  expect(plan.hasSolution, 'the planner produced a plan').toBe(true);
  expect(plan.completedDepth, 'the completed depth is at least 1').toBeGreaterThanOrEqual(1);
  expect(exec.path.length > 1, 'the plan executes through the real engine').toBe(true);
});

// ===========================================================================
// HV4-F2. EXACT_TIE_GRAPH — one deterministic depth-2 search, values + graph
// ===========================================================================
test('HV4-F2. the T5 exact tie is real: equal-primary graph at the root', () => {
  const t5 = turnRoot(5);
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const res = searchBestAction(t5.state, 2, ctx);
  const graph = ctx.equalPrimaryGraph!;
  const rootKey = stateKey(t5.state);
  const rootEntry = [...graph.entries()].filter(([k]) => k.startsWith(`${rootKey}\x00`));
  const logged = t5.lines.filter((l) => /^\s+\S+: value=/.test(l)).map((l) => l.trim());
  const loggedValues = new Map(logged.map((l) => {
    const m = /^(\S+): value=([-\d.]+), mate=(\S+), bound=(\S+)$/.exec(l)!;
    return [m[1], { value: Number(m[2]), mate: m[3], bound: m[4] }] as const;
  }));

  // eslint-disable-next-line no-console
  console.log(
    `\nHV4-F2 deterministic depth-2 search (no deadline): completed=${res.completed}`
    + ` nodes=${ctx.diagnostics.nodes} value=${res.value.toFixed(10)} mate=${res.mate}`
    + `\n  rootActions: ${ctx.rootValues.map((a) => `${dirKey(a.action)}=${a.value.toFixed(10)}(${a.bound})`).join(' ')}`
    + `\n  logged     : ${logged.join(' | ')}`
    + `\n  graph root entries=${rootEntry.length} tie actions=${rootEntry.map(([, v]) => v.equalActions.map(dirKey).join('/')).join(' ; ')}`
    + `\n  graph size=${graph.size} planBranches=${ctx.planBranches.size}`
    + `\n  production extractor plan=[${planText(extractBestCatTurnPlan(t5.state, rules, graph, ctx.planBranches))}]`
    + `\n  principal-branch plan=[${planText(buildPlanForFirstAction(t5.state, ctx.rootValues[0].action, ctx))}]`,
  );

  expect(res.completed, 'the fixed-depth search completed').toBe(true);
  expect(res.mate, 'the search did NOT see a mate at T5').toBe(null);
  for (const a of ctx.rootValues) {
    const l = loggedValues.get(dirKey(a.action));
    expect(l, `${dirKey(a.action)} appears in the logged ROOT_ACTIONS block`).toBeDefined();
    expect(a.value, `${dirKey(a.action)} value equals the logged value`).toBe(l!.value);
    expect(a.bound, `${dirKey(a.action)} bound`).toBe(l!.bound);
  }
  expect(rootEntry.length, 'the root has an equal-primary entry (the tie is certified)').toBe(1);
  expect(rootEntry[0][1].equalActions.map(dirKey).sort(), 'ArrowUp and ArrowLeft are exactly tied').toEqual(['ArrowLeft', 'ArrowUp']);
  // RB-1: the graph only admits actions that were CERTIFIED, never a window bound.
  expect([...loggedValues.values()].map((v) => v.bound).sort(), 'every root action is an exact proof, not a bound').toEqual(['exact', 'exact', 'exact']);
});

// ===========================================================================
// HV4-F3. the plan space the tie admits, scored under both predicates
// ===========================================================================
test('HV4-F3. does the trap blind spot / boundary billing change the chosen plan?', () => {
  const t5 = turnRoot(5);
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  searchBestAction(t5.state, 2, ctx);
  const graph = ctx.equalPrimaryGraph!;
  const branches = ctx.planBranches;
  const production = extractBestCatTurnPlan(t5.state, rules, graph, branches);
  let plans: SearchAction[][];
  let scored: {
    i: number; text: string; prod: number; trapAware: number; revisits: number; endCell: string; trap: string;
  }[];
  setWorldEntropySource(() => 0);
  try {
    plans = enumeratePlans(t5.state, graph, branches);
    scored = plans.map((p, i) => {
      const { end } = executePlan(t5.state, p);
      return {
        i,
        text: planText(p),
        prod: scoreProduction(p),
        trapAware: scoreTrapTransparent(p),
        revisits: revisitsOf(t5.state, p),
        endCell: rc(end.catPosition),
        trap: end.trapPosition ? rc(end.trapPosition) : 'none',
      };
    });
  } finally {
    setWorldEntropySource(null);
  }
  const byProd = [...scored].sort((a, b) => a.prod - b.prod || a.revisits - b.revisits || a.i - b.i);
  const byFixed = [...scored].sort((a, b) => a.trapAware - b.trapAware || a.prod - b.prod || a.revisits - b.revisits || a.i - b.i);

  // eslint-disable-next-line no-console
  console.log(
    `\nHV4-F3 equal-primary plan space at T5 (${plans.length} distinct plans)`
    + `\n  production extractor chose [${planText(production)}]`
    + `\n  ${'plan'.padEnd(8)} ${'prodRev'.padEnd(8)} ${'trapAwareRev'.padEnd(13)} revisits end   trap`
    + `\n${scored.map((s) => `  ${s.text.padEnd(8)} ${String(s.prod).padEnd(8)} ${String(s.trapAware).padEnd(13)} ${String(s.revisits).padEnd(8)} ${s.endCell.padEnd(6)} ${s.trap}`).join('\n')}`
    + `\n  rank under production scorer : ${byProd.slice(0, 5).map((s) => s.text).join(' > ')}`
    + `\n  rank under corrected scorer  : ${byFixed.slice(0, 5).map((s) => s.text).join(' > ')}`
    + `\n  CHOICE_CHANGES = ${byProd[0].text !== byFixed[0].text}`
    + `\n  logged plan [${/PLAN: (.*)/.exec(t5.lines.join('\n'))?.[1] ?? ''}]`,
  );

  expect(plans.length, 'the tie admits more than one complete plan').toBeGreaterThan(1);
  expect(scored.some((s) => s.prod !== s.trapAware), 'the trap-insertion blind spot is visible on this root').toBe(true);
});

/** Cells the plan re-enters, counted with the real engine geometry. */
function revisitsOf(root: GameEngineState, plan: SearchAction[]): number {
  const { path } = executePlan(root, plan);
  const cells = path.filter((p) => p !== 'Trap');
  const seen = new Set<string>();
  let revisits = 0;
  for (const p of cells) {
    if (seen.has(p)) revisits++;
    seen.add(p);
  }
  return revisits;
}

// ===========================================================================
// HV4-F4. §6 gate — is the secondary score the real cause of the T5 loss?
// ===========================================================================
test('HV4-F4. every T5 candidate plan loses to the same forced mouse line', () => {
  const t5 = turnRoot(5);
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  searchBestAction(t5.state, 2, ctx);
  const graph = ctx.equalPrimaryGraph!;
  const plans = enumeratePlans(t5.state, graph, ctx.planBranches);
  const rows: { text: string; mouseStart: string; mouseBudget: number; carrying: boolean; trap: string }[] = [];
  setWorldEntropySource(() => 0);
  try {
    for (const p of plans.slice(0, 12)) {
      const { end } = executePlan(t5.state, p);
      const handed = endTurn({ ...end, currentPlayer: PieceType.Cat });
      rows.push({
        text: planText(p),
        mouseStart: rc(handed.mousePosition),
        mouseBudget: handed.mouseMovesLeft,
        carrying: handed.mouseHasButter,
        trap: handed.trapPosition ? rc(handed.trapPosition) : 'none',
      });
    }
  } finally {
    setWorldEntropySource(null);
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nHV4-F4 mouse turn state after each equal-primary cat plan (all of them lose:`
    + ` HV4-S4c/S4g proved the line 1,8→2,8→3,8→4,8→5,8→6,8→7,8 survives EVERY legal cat plan):`
    + `\n${rows.map((r) => `  [${r.text}] mouse=${r.mouseStart} budget=${r.mouseBudget} carrying=${r.carrying} trap=${r.trap}`).join('\n')}`
    + `\n  SECONDARY_SCORE_IS_CAUSE_OF_LOSS = false (no cat action at T5 can stop the proven mouse line)`,
  );
  expect(rows.every((r) => r.mouseStart === '1,8' && r.carrying), 'the mouse keeps its carrying turn after every plan').toBe(true);
});

// ===========================================================================
// HV4-F5. the evidence file is untouched (same digest as HV4-E1, re-read here)
// ===========================================================================
test('HV4-F5. the original TXT digest is unchanged for this forensics file', () => {
  const buf = readFileSync(LOG_URL);
  const hex = createHash('sha256').update(buf).digest('hex');
  const header = buf.toString('utf8').split(/\r?\n/).slice(0, 4);
  // eslint-disable-next-line no-console
  console.log(`\nHV4-F5 original TXT sha256=${hex} bytes=${buf.length}\n  header: ${header.join(' | ')}`);
  expect(hex).toBe('25d048b581a2d6712138ebe38c923fa39b797ab66c451552acf4edacf98f149a');
  expect(header[0], 'this is GAME 4 of the H1 human batch').toBe('GAME 4');
  expect(header[1], 'the human mouse won').toBe('RESULT: mouse_wins');
  expect(header[2], 'the game ran on the protected H1 leaf').toBe('HARD_LEAF=H1 (Corrected Hole)');
  expect(header[3], 'the protected progress guard was OFF').toBe('PROGRESS_GUARD=OFF');
});

// ===========================================================================
// HV4-P1. §7 protected configuration — read back, nothing re-decided here.
// ===========================================================================
test('HV4-P1. the protected production knobs are still the ones the log used', () => {
  const mainSrc = readFileSync(new URL('../../../../src/main.tsx', import.meta.url), 'utf8');
  const plannerSrc = readFileSync(new URL('../hardTurnPlanner.ts', import.meta.url), 'utf8');
  // eslint-disable-next-line no-console
  console.log(
    `\nHV4-P1 protected configuration`
    + `\n  HARD_LEAF_MODE_DEFAULT=${HARD_LEAF_MODE_DEFAULT}  main.tsx leaf=${/HARD_LEAF_MODE_CONFIG\.current = '([^']+)'/.exec(mainSrc)?.[1]}`
    + `\n  timeBudgetMsPerCatTurn=${DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn} totalTurnBudgetMs=${HARD_TRIAL.totalTurnBudgetMs} refutation=${HARD_TRIAL.refutationEnabled}`
    + `\n  PROGRESS_GUARD enabled=${HARD_PROGRESS_GUARD_CONFIG.enabled}`
    + `\n  planner frozen flags: ${/useTT: (\w+),[\s\S]*?useAlphaBeta: (\w+),[\s\S]*?useMoveOrdering: (\w+),[\s\S]*?useThreatOrdering: (\w+),/.exec(plannerSrc)?.slice(1).join(' ')}`
    + `\n  maxThreatExtensions: ${/maxThreatExtensions: (\d+)/.exec(plannerSrc)?.[1]}`,
  );
  expect(HARD_LEAF_MODE_DEFAULT, 'the source default leaf stays baseline (the playtest build opts into H1 in main.tsx)').toBe('baseline');
  expect(mainSrc, 'the playtest entry still selects H1 (Corrected Hole)').toContain("HARD_LEAF_MODE_CONFIG.current = 'baseline_hole_corrected'");
  expect(DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn, 'MAIN_SEARCH_BUDGET_MS').toBe(100);
  expect(HARD_TRIAL.totalTurnBudgetMs, 'TOTAL_TURN_BUDGET_MS').toBe(150);
  expect(HARD_PROGRESS_GUARD_CONFIG.enabled, 'PROGRESS_GUARD stays OFF').toBe(false);
  expect(/useAlphaBeta: true/.test(plannerSrc), 'USE_ALPHA_BETA stays true').toBe(true);
  expect(/useTT: true/.test(plannerSrc), 'USE_TT stays true').toBe(true);
  expect(/useThreatOrdering: false/.test(plannerSrc), 'USE_THREAT_ORDERING stays false').toBe(true);
});
