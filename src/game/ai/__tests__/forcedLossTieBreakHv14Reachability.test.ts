/// <reference types="node" />
/**
 * PPC-FLT-AUDIT-1 — REAL HV14 reachability measurement.
 *
 * Read-only: no production source is touched. Every root is restored from the
 * five byte-identical H1 logs (gitignored, verified by the HV14 suite) and every
 * transition uses the real engine RuleSet.
 *
 * Measured here, over the 45 real HV14 cat turns:
 *   T1 — forced-loss gate over the LOGGED root actions (production truth):
 *        how many roots are mouse-mate, how many primary-equal actions are
 *        CERTIFIED exact, and whether forcedLossTieBreak can fire at all.
 *   T2 — CHANCE-boundary acceptance of the LOGGED production plans: the fixed
 *        builder now keeps the final catStep that hands off at a ghost/debt
 *        CHANCE boundary, records the final cat cell, and signs boundaryEval
 *        with the injected H1 leaf as the WEIGHTED EXPECTATION over ALL chance
 *        outcomes (outcomes[0] is never used). The pre-fix shortfall is still
 *        measured for provenance.
 *   T3 — zero-move trap acceptance of the LOGGED production plans: catPlaceTrap
 *        stays in the plan, but it no longer duplicates the cat's current cell
 *        in `positions`; real movement revisits are still counted. The pre-fix
 *        inflation is still measured for provenance.
 *   T4 — fixed-depth rerun of every root at its logged completed depth
 *        (deterministic, no wall-clock deadline): reproduces the root score,
 *        re-runs the forced-loss gate on the rerun's own bound metadata,
 *        measures candidate completeness for every mouse-mate root action,
 *        and records planBranches overwrite conflicts.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEngineRuleSet } from '../../engine';
import type { GameEngineState } from '../../engine';
import { GamePhase, PieceType, DIRECTIONS } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import {
  buildCatTurnPlan,
  compareSearchScore,
  createSearchContext,
  searchResult,
  type SearchContext,
  type MateSide,
} from '../expectiminimax';
import { forcedLossTieBreak } from '../forcedLossTieBreak';
import {
  buildCandidate,
  dirKey,
  planFullTurnCompleteness,
} from '../planQuality';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { generateLegalSearchActions } from '../legalActions';
import type { SearchAction } from '../searchTypes';

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
const actionText = (a: SearchAction): string =>
  a.type === 'catStep' ? a.direction!.key : a.type === 'catPlaceTrap' ? 'catPlaceTrap' : a.type;

interface ParsedRootAction {
  action: SearchAction;
  value: number;
  mate: MateSide;
  bound: 'exact' | 'lower' | 'upper';
}

interface ParsedTurn {
  game: (typeof GAMES)[number];
  turn: number;
  state: GameEngineState;
  loggedKey: string;
  completedDepth: number;
  rootValue: number;
  rootMate: MateSide;
  rootActions: ParsedRootAction[];
  plan: SearchAction[];
  hardLeaf: string;
}

function parsePlan(line: string): SearchAction[] {
  const text = line.replace(/^PLAN:\s*/, '').trim();
  if (!text || text === '(empty)') return [];
  return text.split('→').map((part) => {
    const p = part.trim();
    if (p === 'catPlaceTrap') return { type: 'catPlaceTrap' } as SearchAction;
    const m = /^catStep Arrow(Up|Down|Left|Right)$/.exec(p);
    if (!m) throw new Error(`unparsed plan token: ${p}`);
    const direction = DIRECTIONS.find((d) => d.key === `Arrow${m[1]}`)!;
    return { type: 'catStep', direction } as SearchAction;
  });
}

function parseRootActions(lines: string[]): ParsedRootAction[] {
  const start = lines.findIndex((l) => l.trim() === 'ROOT_ACTIONS:');
  if (start < 0) return [];
  const out: ParsedRootAction[] = [];
  for (const raw of lines.slice(start + 1)) {
    const l = raw.trim();
    if (!l) break;
    const m = /^(Arrow(?:Up|Down|Left|Right)|catPlaceTrap): value=([-\d.e+]+), mate=(null|cat|mouse), bound=(exact|lower|upper|unknown)$/.exec(l);
    if (!m) {
      if (/^(Arrow|catPlaceTrap)/.test(l)) throw new Error(`unparsed root action: ${l}`);
      break;
    }
    const action: SearchAction = m[1] === 'catPlaceTrap'
      ? { type: 'catPlaceTrap' }
      : { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === m[1])! };
    if (m[4] === 'unknown') throw new Error(`root action without a bound: ${l}`);
    out.push({
      action,
      value: Number(m[2]),
      mate: m[3] === 'null' ? null : (m[3] as 'cat' | 'mouse'),
      bound: m[4] as 'exact' | 'lower' | 'upper',
    });
  }
  return out;
}

function loadTurns(): ParsedTurn[] {
  const out: ParsedTurn[] = [];
  for (const game of GAMES) {
    const path = new URL(`${game}_H1.txt`, LOG_DIR);
    const text = readFileSync(path, 'utf8');
    // Byte identity of the supplied evidence (same hashes as HV14-1).
    const sha = createHash('sha256').update(text).digest('hex');
    expect(sha, `${game} log bytes`).toBe(LOG_SHA256[game]);
    const lines = text.split(/\r?\n/);
    const starts: number[] = [];
    lines.forEach((l, i) => {
      if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
    });
    starts.forEach((s, k) => {
      const block = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length);
      const field = (prefix: string): string =>
        block.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
      const depthMatch = /^cDepth=(\d+) aDepth=(\d+)/.exec(field('SEARCH:'));
      if (!depthMatch) return;
      const rv = /^(-?[\d.e+]+) mate=(null|cat|mouse)$/.exec(field('ROOT_VALUE='));
      if (!rv) return;
      const snap = JSON.parse(field('SNAPSHOT_JSON=')) as HardRootSnapshot;
      const state = restoreHardRoot(snap);
      out.push({
        game,
        turn: Number(/^Turn #(\d+)$/.exec(block[0].trim())![1]),
        state,
        loggedKey: field('STATE_KEY='),
        completedDepth: Number(depthMatch[1]),
        rootValue: Number(rv[1]),
        rootMate: rv[2] === 'null' ? null : (rv[2] as 'cat' | 'mouse'),
        rootActions: parseRootActions(block),
        plan: parsePlan(field('PLAN:')),
        // HARD_LEAF is a one-line file header, not a per-turn field.
        hardLeaf: /^HARD_LEAF=(.*)$/m.exec(text.slice(0, 200))?.[1] ?? '',
      });
    });
  }
  return out;
}

const TURNS = loadTurns();

/** Replay a cat plan with the real simulator; stop at the first CHANCE node. */
function replayPlan(
  root: GameEngineState,
  plan: SearchAction[],
): {
  states: GameEngineState[];
  chanceAt: number;
  chancePre: GameEngineState | null;
  chanceOutcomes: { state: GameEngineState; weight: number }[] | null;
  switchAt: number;
} {
  let cur = root;
  const states: GameEngineState[] = [root];
  for (let i = 0; i < plan.length; i++) {
    const t = simulateSearchAction(cur, plan[i], rules);
    if (t.kind === 'chance') {
      return { states, chanceAt: i, chancePre: cur, chanceOutcomes: t.outcomes, switchAt: -1 };
    }
    cur = t.state;
    states.push(cur);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) {
      return { states, chanceAt: -1, chancePre: null, chanceOutcomes: null, switchAt: i };
    }
  }
  return { states, chanceAt: -1, chancePre: null, chanceOutcomes: null, switchAt: -1 };
}

/** Cat cells as `buildCandidate` records them (includes zero-move trap cells). */
function candidatePositions(root: GameEngineState, plan: SearchAction[]): string[] {
  const positions: string[] = [rc(root.catPosition)];
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
    positions.push(rc(cur.catPosition));
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return positions;
}

function revisitsOf(positions: string[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const p of positions) {
    if (seen.has(p)) n++;
    seen.add(p);
  }
  return n;
}

/**
 * The cat-cell sequence `buildCandidate` must produce after FIX-3/FIX-2:
 * only real cell CHANGES are recorded (a zero-move trap adds nothing), and a
 * final CHANCE action's cell IS recorded (all outcomes must agree).
 */
function spatialSequence(root: GameEngineState, plan: SearchAction[]): string[] {
  const out: string[] = [rc(root.catPosition)];
  let cur = root;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind === 'chance') {
      const cells = new Set(t.outcomes.map((o) => rc(o.state.catPosition)));
      expect(cells.size).toBe(1);
      const cell = [...cells][0];
      if (cell !== out[out.length - 1]) out.push(cell);
      break;
    }
    cur = t.state;
    const cell = rc(cur.catPosition);
    if (cell !== out[out.length - 1]) out.push(cell);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return out;
}

/** planBranches seeded from a logged plan, so buildCandidate replays exactly it. */
function planCtxFor(root: GameEngineState, plan: SearchAction[]): SearchContext {
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat; // production HARD_LEAF=H1
  let cur = root;
  for (const a of plan) {
    ctx.planBranches.set(stateKey(cur), a);
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
  }
  return ctx;
}

test('FLT-HV14-1 forced-loss gate over the 45 logged production roots', () => {
  expect(TURNS.length).toBe(45);
  const firing: string[] = [];
  const exactTieRoots: string[] = [];
  let mouseMateRoots = 0;

  for (const t of TURNS) {
    expect(stateKey(t.state), `${t.game} T${t.turn} root hash`).toBe(t.loggedKey);
    const exact = t.rootActions.filter((a) => a.bound === 'exact');
    if (exact.length > 1 && new Set(exact.map((a) => a.value)).size === 1) {
      exactTieRoots.push(`${t.game}T${t.turn}(mate=${String(t.rootMate)})`);
    }
    const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
    const out = forcedLossTieBreak(t.state, ctx, t.rootActions);
    if (out !== null) firing.push(`${t.game}T${t.turn}`);
    if (t.rootMate !== 'mouse') continue;

    mouseMateRoots++;
    const exactMouse = exact.filter((a) => a.mate === 'mouse');
    // Production truth: only the incumbent's score is certified; the other
    // root actions are upper bounds from the narrowed root alpha window, so a
    // PROVED tie cannot form and the selector must abstain.
    console.log(
      `\nFLT-HV14-1 ${t.game} T${t.turn} mate=mouse leaf=${t.hardLeaf}`
      + ` rootActions=${t.rootActions.map((a) => `${actionText(a.action)}=${a.value}(${a.bound})`).join(' ')}`
      + ` exact=${exact.length} exactMouse=${exactMouse.length} tieBreak=${out === null ? 'null' : out.map(actionText).join('>')}`,
    );
    expect(exactMouse.length).toBe(1);
    expect(out).toBeNull();
  }

  console.log(
    `\nFLT-HV14-1 totals: turns=${TURNS.length} mouseMateRoots=${mouseMateRoots}`
    + ` exactTieRoots=${exactTieRoots.length} [${exactTieRoots.join(' ')}]`
    + ` selectorFiringRoots=${firing.length} [${firing.join(' ')}]`,
  );
  expect(mouseMateRoots).toBe(2);
  expect(firing.length).toBe(0);
});

test('FLT-HV14-2 CHANCE boundary acceptance over the 45 logged production plans', () => {
  let chanceTurns = 0;
  let oldMissingFinalCell = 0;
  let oldRevisitShort = 0;
  let fixedRevisitMatch = 0;
  let fixedBoundaryMatch = 0;
  const rows: string[] = [];

  for (const t of TURNS) {
    const r = replayPlan(t.state, t.plan);
    const verdict = planFullTurnCompleteness(t.state, t.plan, rules);
    if (verdict.kind === 'TRUNCATED' && t.plan.length > 0) {
      console.log(`\nFLT-HV14-2 TRUNCATED ${t.game} T${t.turn} plan=${t.plan.map(actionText).join('>')} ${verdict.reason}`);
    }
    if (r.chanceAt < 0) continue;
    chanceTurns++;
    expect(verdict.kind, `${t.game} T${t.turn} logged chance plan completes`).toBe('COMPLETE_CHANCE_BOUNDARY');
    // A plan must never run PAST a chance transition.
    expect(r.chanceAt, `${t.game} T${t.turn} chance must be the final action`).toBe(t.plan.length - 1);
    expect(r.chancePre, `${t.game} T${t.turn} chance pre-state`).not.toBeNull();
    const outcomes = r.chanceOutcomes!;
    expect(outcomes.length).toBeGreaterThan(0);
    const weightSum = outcomes.reduce((s, o) => s + o.weight, 0);
    expect(weightSum, `${t.game} T${t.turn} chance weights normalized`).toBeCloseTo(1, 9);
    // The cat does not move during ghost/debt resolution: every outcome agrees
    // on the final cat cell.
    const finalCells = new Set(outcomes.map((o) => rc(o.state.catPosition)));
    expect(finalCells.size, `${t.game} T${t.turn} outcomes agree on cat cell`).toBe(1);
    const finalCell = [...finalCells][0];

    // Historical (pre-FIX) accounting: candidatePositions breaks BEFORE the
    // chance action, so the final step's cell is missing.
    const oldPositions = candidatePositions(t.state, t.plan);
    const oldRevisits = revisitsOf(oldPositions);
    if (oldPositions[oldPositions.length - 1] === rc(r.chancePre!.catPosition) && finalCell !== rc(r.chancePre!.catPosition)) {
      oldMissingFinalCell++;
    }

    // FIX-2 acceptance: the built candidate records the final CHANCE cell and
    // signs the boundary with the injected H1 leaf over ALL outcomes.
    const spatial = spatialSequence(t.state, t.plan);
    const honestRevisits = revisitsOf(spatial);
    if (honestRevisits !== oldRevisits) oldRevisitShort++;
    const expectH1 = outcomes.reduce((s, o) => s + o.weight * evaluateCorrectedHoleForCat(o.state), 0);
    const cand = buildCandidate(t.state, t.plan[0], planCtxFor(t.state, t.plan), 0);
    expect(cand, `${t.game} T${t.turn} chance-first plan builds`).not.toBeNull();
    expect(cand!.plan.map(actionText), `${t.game} T${t.turn} replays the logged plan`).toEqual(t.plan.map(actionText));
    expect(planFullTurnCompleteness(t.state, cand!.plan, rules).kind).toBe('COMPLETE_CHANCE_BOUNDARY');
    if (cand!.revisitCount === honestRevisits) fixedRevisitMatch++;
    if (Math.abs(cand!.boundaryEval - expectH1) < 1e-9) fixedBoundaryMatch++;
    expect(cand!.revisitCount, `${t.game} T${t.turn} fixed revisit`).toBe(honestRevisits);
    expect(cand!.boundaryEval, `${t.game} T${t.turn} fixed boundary = weighted H1`).toBeCloseTo(expectH1, 9);

    rows.push(
      `${t.game} T${t.turn} cells=${spatial.join('/')}`
      + ` oldRevisit=${oldRevisits} fixedRevisit=${cand!.revisitCount}`
      + ` boundary oldH1(preFinal)=${evaluateCorrectedHoleForCat(r.chancePre!).toFixed(2)} fixedH1=${cand!.boundaryEval.toFixed(2)} expectH1=${expectH1.toFixed(2)}`
      + ` outcomes=${outcomes.length}`,
    );
  }

  console.log(
    `\nFLT-HV14-2 chance boundaries=${chanceTurns} fixedRevisitMatch=${fixedRevisitMatch} fixedBoundaryMatch=${fixedBoundaryMatch}`
    + ` oldMissingFinalCell=${oldMissingFinalCell} oldRevisitUnderCount=${oldRevisitShort}\n  ${rows.join('\n  ')}`,
  );
  expect(chanceTurns).toBe(10);
  // FIX acceptance: every logged chance plan now builds, records the final cell
  // and uses the weighted H1 expectation. The old count is kept as the
  // measured defect magnitude (not an acceptance criterion).
  expect(fixedRevisitMatch).toBe(10);
  expect(fixedBoundaryMatch).toBe(10);
  expect(oldMissingFinalCell + oldRevisitShort).toBeGreaterThan(0);
});

test('FLT-HV14-3 zero-move trap acceptance over the 45 logged production plans', () => {
  let trapTurns = 0;
  let oldInflated = 0;
  let fixedMismatch = 0;
  const rows: string[] = [];
  for (const t of TURNS) {
    const trapIdx = t.plan.findIndex((a) => a.type === 'catPlaceTrap');
    if (trapIdx < 0) continue;
    trapTurns++;
    // Historical pre-FIX sequence (a trap duplicates the current cell).
    const oldPositions = candidatePositions(t.state, t.plan);
    const oldRevisits = revisitsOf(oldPositions);
    // The fixed sequence records only real cell changes.
    const spatial = spatialSequence(t.state, t.plan);
    const movementRevisits = revisitsOf(spatial);
    if (oldRevisits > movementRevisits) oldInflated++;

    const cand = buildCandidate(t.state, t.plan[0], planCtxFor(t.state, t.plan), 0);
    expect(cand, `${t.game} T${t.turn} trap plan builds`).not.toBeNull();
    expect(cand!.plan.map(actionText), `${t.game} T${t.turn} replays the logged plan`).toEqual(t.plan.map(actionText));
    // FIX-3 acceptance: the plan keeps catPlaceTrap, but it is NOT a revisit.
    expect(cand!.plan[trapIdx].type).toBe('catPlaceTrap');
    if (cand!.revisitCount !== movementRevisits) fixedMismatch++;
    expect(cand!.revisitCount, `${t.game} T${t.turn} fixed trap revisit`).toBe(movementRevisits);
    rows.push(
      `${t.game} T${t.turn} trap@${trapIdx} oldRevisit=${oldRevisits} fixedRevisit=${cand!.revisitCount} spatial=${spatial.join('/')}`,
    );
  }
  console.log(
    `\nFLT-HV14-3 trap plans=${trapTurns} oldProductionInflated=${oldInflated} fixedMismatch=${fixedMismatch}\n  ${rows.join('\n  ')}`,
  );
  expect(trapTurns).toBeGreaterThan(0);
  expect(fixedMismatch).toBe(0);
});

// ---------------------------------------------------------------------------
// T4 — fixed-depth rerun of every root (deterministic, no deadline)
// ---------------------------------------------------------------------------

class TrackedBranches extends Map<string, SearchAction> {
  writes: { key: string; action: SearchAction }[] = [];
  override set(key: string, value: SearchAction): this {
    this.writes.push({ key, action: value });
    return super.set(key, value);
  }
}

function keyTail(k: string): string {
  const parts = k.split('#');
  return parts.slice(Math.max(0, parts.length - 17)).join('#');
}

/**
 * Mirror of the root MAX selection rule (PPC-RB1): a certified (exact) score
 * beats an uncertified bound at an equal primary; between two equal certified
 * actions the earliest ORIGINAL legal index wins. The search's own best action
 * must equal this, otherwise `plan.plan[0]` silently replaces it.
 */
function stableWinner(
  records: { action: SearchAction; value: number; mate: MateSide; bound: 'exact' | 'lower' | 'upper' }[],
  legal: SearchAction[],
): SearchAction | null {
  const indexOf = (a: SearchAction): number => legal.findIndex((l) => dirKey(l) === dirKey(a));
  let best: (typeof records)[number] | null = null;
  let bestIdx = Number.POSITIVE_INFINITY;
  let bestCert = false;
  for (const r of records) {
    const idx = indexOf(r.action);
    const cert = r.bound === 'exact';
    if (best === null) {
      best = r; bestIdx = idx; bestCert = cert;
      continue;
    }
    const cmp = compareSearchScore({ value: r.value, mate: r.mate }, { value: best.value, mate: best.mate });
    if (cmp > 0) { best = r; bestIdx = idx; bestCert = cert; continue; }
    if (cmp !== 0) continue;
    if (!bestCert && cert) { best = r; bestIdx = idx; bestCert = true; continue; }
    if (bestCert && !cert) continue;
    if (idx < bestIdx) { best = r; bestIdx = idx; }
  }
  return best?.action ?? null;
}

function rerunRoot(t: ParsedTurn): {
  ctx: SearchContext;
  res: ReturnType<typeof searchResult>;
  tracked: TrackedBranches;
} {
  const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
  const tracked = new TrackedBranches();
  ctx.planBranches = tracked;
  ctx.capturePlan = true;
  ctx.leafEvaluator = evaluateCorrectedHoleForCat; // production HARD_LEAF=H1
  const res = searchResult(t.state, t.completedDepth, ctx);
  return { ctx, res, tracked };
}

test('FLT-HV14-4 fixed-depth rerun: root score, gate, candidate completeness, branch conflicts', () => {
  let reproduced = 0;
  let boundMismatch = 0;
  let conflicts = 0;
  let conflictTurns = 0;
  let planOverwriteChanged = 0;
  let gateFires = 0;
  const firingRoots: string[] = [];
  let totalNodes = 0;
  const conflictRows: string[] = [];
  const boundRows: string[] = [];
  let missingSuccessorBranches = 0;
  let truncatedRootCandidates = 0;
  let selectorPlanChanges = 0;
  const coverageRows: string[] = [];

  for (const t of TURNS) {
    const { ctx, res, tracked } = rerunRoot(t);
    totalNodes += ctx.diagnostics.nodes;
    expect(res.completed, `${t.game} T${t.turn} depth ${t.completedDepth} completed`).toBe(true);
    expect(res.value, `${t.game} T${t.turn} root value reproduces`).toBe(t.rootValue);
    expect(res.mate, `${t.game} T${t.turn} root mate reproduces`).toBe(t.rootMate);
    reproduced++;

    // ---- planBranches overwrite diagnosis -------------------------------
    const byKey = new Map<string, Set<string>>();
    for (const w of tracked.writes) {
      const set = byKey.get(w.key) ?? new Set<string>();
      set.add(dirKey(w.action));
      byKey.set(w.key, set);
    }
    const conflictKeys = [...byKey.entries()].filter(([, ks]) => ks.size > 1);
    if (conflictKeys.length > 0) {
      conflictTurns++;
      conflicts += conflictKeys.length;
      // Does the LAST write (what the production map walk sees) change the
      // returned plan versus first-write-wins?
      const firstWins = new Map<string, SearchAction>();
      for (const w of tracked.writes) if (!firstWins.has(w.key)) firstWins.set(w.key, w.action);
      const planLast = buildCatTurnPlan(t.state, ctx);
      ctx.planBranches = firstWins;
      const planFirst = buildCatTurnPlan(t.state, ctx);
      ctx.planBranches = tracked;
      const changed = planLast.map(dirKey).join('>') !== planFirst.map(dirKey).join('>');
      if (changed) planOverwriteChanged++;
      for (const [k, ks] of conflictKeys) {
        // The equal-primary graph is keyed `${stateKey}\x00${depthTurns}`; it
        // tells us whether this state was seen at more than one depth.
        const graphDepths = [...(ctx.equalPrimaryGraph ?? new Map<string, unknown>()).keys()]
          .filter((gk) => gk.startsWith(`${k}\x00`))
          .map((gk) => gk.slice(k.length + 1));
        conflictRows.push(
          `${t.game}T${t.turn} key=…${keyTail(k)} writes=${[...ks].join('/')}`
          + ` graphDepths=[${graphDepths.join(',') || 'not-in-graph'}]`
          + ` planFirst=${planFirst.map(dirKey).join('>') || '(empty)'}`
          + ` planLast=${planLast.map(dirKey).join('>') || '(empty)'} planChanged=${changed}`,
        );
      }
    }

    // P0-A real precondition: is EVERY root action's successor recorded in
    // planBranches? A TT-hit child is expanded without a planBranches write, so
    // buildPlanForFirstAction for that root action would return a 1-action plan.
    const legalRoot = generateLegalSearchActions(t.state, rules);
    let missing = 0;
    for (const a of legalRoot) {
      const tr = simulateSearchAction(t.state, a, rules);
      if (tr.kind !== 'deterministic') continue;
      if (tr.state.phase !== GamePhase.Playing || tr.state.currentPlayer !== PieceType.Cat) continue;
      if (!ctx.planBranches.has(stateKey(tr.state))) missing++;
    }
    if (missing > 0) {
      missingSuccessorBranches += missing;
      coverageRows.push(`${t.game}T${t.turn}:${missing}/${legalRoot.length}`);
    }
    // And how many legal root actions would build a TRUNCATED 1-action plan?
    for (const a of legalRoot) {
      const idx = legalRoot.findIndex((l) => dirKey(l) === dirKey(a));
      const cand = buildCandidate(t.state, a, ctx, idx);
      if (!cand) continue; // chance-first action
      const verdict = planFullTurnCompleteness(t.state, cand.plan, rules);
      if (verdict.kind === 'TRUNCATED') truncatedRootCandidates++;
    }

    const loggedBound = new Map(t.rootActions.map((a) => [actionText(a.action), a.bound]));
    const diffEntries = ctx.rootValues
      .filter((a) => loggedBound.get(actionText(a.action)) !== a.bound)
      .map((a) => `${actionText(a.action)} run=${a.bound} log=${loggedBound.get(actionText(a.action))}`);
    if (diffEntries.length > 0) {
      boundMismatch += diffEntries.length;
      boundRows.push(`${t.game}T${t.turn}[${diffEntries.join(', ')}]`);
    }

    // Re-run the forced-loss gate on the RERUN's own bound metadata.
    const preSel = buildCatTurnPlan(t.state, ctx);
    const out = forcedLossTieBreak(t.state, ctx, ctx.rootValues);
    if (out !== null && out.map(dirKey).join('>') !== preSel.map(dirKey).join('>')) selectorPlanChanges++;
    if (t.rootMate === 'mouse') {
      const exact = ctx.rootValues.filter((a) => a.bound === 'exact');
      const exactMouse = exact.filter((a) => a.mate === 'mouse');
      const legal = generateLegalSearchActions(t.state, rules);
      const winner = stableWinner(ctx.rootValues, legal);
      if (out !== null) {
        gateFires++;
        firingRoots.push(`${t.game}T${t.turn}`);
      }

      // FIX-5/FIX-1 admission mirror: only exact entries form the pool, and the
      // selector can only fire when EVERY primary-equal candidate builds a
      // complete plan (>= 2 of them).
      const best = exact[0];
      const primaryEqual = best
        ? exact.filter((a) => compareSearchScore(
          { value: a.value, mate: a.mate },
          { value: best.value, mate: best.mate },
        ) === 0)
        : [];
      const allMouse = primaryEqual.every((a) => a.mate === 'mouse');
      const candRows: string[] = [];
      let failClosed = 0;
      let built = 0;
      for (const a of primaryEqual) {
        const idx = legal.findIndex((l) => dirKey(l) === dirKey(a.action));
        const cand = buildCandidate(t.state, a.action, ctx, idx >= 0 ? idx : 999);
        if (!cand) {
          failClosed++;
          candRows.push(`${actionText(a.action)}=FAIL_CLOSED`);
          continue;
        }
        built++;
        const verdict = planFullTurnCompleteness(t.state, cand.plan, rules);
        candRows.push(`${actionText(a.action)}=${cand.plan.map(actionText).join('>')}(${verdict.kind})`);
      }
      console.log(
        `\nFLT-HV14-4 ${t.game} T${t.turn} mouse-mate root (depth ${t.completedDepth}, nodes ${ctx.diagnostics.nodes})`
        + `\n  rerunActions=${ctx.rootValues.map((a) => `${actionText(a.action)}=${a.value}(${a.bound})`).join(' ')}`
        + `\n  stablePrimary=${actionText(winner ?? { type: 'catPlaceTrap' })} loggedBestAction=${actionText(t.plan[0] ?? { type: 'catPlaceTrap' })}`
        + `\n  exact=${exact.length} exactMouse=${exactMouse.length} primaryEqual=${primaryEqual.length} allMouse=${allMouse}`
        + `\n  searchPlan=${preSel.map(actionText).join('>') || '(empty)'}`
        + `\n  tieBreak=${out === null ? 'null' : out.map(actionText).join('>')}`
        + ` changed=${out !== null && out.map(dirKey).join('>') !== preSel.map(dirKey).join('>')}`
        + `\n  candidates: ${candRows.join(' ')}`,
      );

      if (out !== null) {
        // Firing requires a proved (>=2), ALL-mouse, fully buildable tie set.
        expect(primaryEqual.length).toBeGreaterThanOrEqual(2);
        expect(allMouse, `${t.game} T${t.turn} primary tie is all mouse-mate`).toBe(true);
        expect(failClosed, `${t.game} T${t.turn} every admitted candidate builds`).toBe(0);

        const first = out[0];
        const rec = primaryEqual.find((a) => dirKey(a.action) === dirKey(first));
        expect(rec, `${t.game} T${t.turn} tie-break first action is certified exact primary-equal`).toBeDefined();
        // Choosing among primary-equal actions cannot move the main value.
        expect(compareSearchScore(
          { value: rec!.value, mate: rec!.mate },
          { value: best!.value, mate: best!.mate },
        )).toBe(0);
        const verdict = planFullTurnCompleteness(t.state, out, rules);
        expect(['COMPLETE_TURN_BOUNDARY', 'COMPLETE_CHANCE_BOUNDARY', 'GAME_ENDED', 'NO_LEGAL_ACTIONS'])
          .toContain(verdict.kind);
      } else {
        // Fail-closed: abstention is only admissible when fewer than two
        // COMPLETE candidates could be built for the proved tie set.
        expect(built, `${t.game} T${t.turn} abstention has an admissible reason`).toBeLessThan(2);
      }
    } else {
      expect(out, `${t.game} T${t.turn} selector abstains`).toBeNull();
    }
  }

  console.log(
    `\nFLT-HV14-4 reruns=${TURNS.length} reproduced=${reproduced} boundMismatchEntries=${boundMismatch}`
    + ` planBranchesConflictKeys=${conflicts} conflictTurns=${conflictTurns}`
    + ` overwrittenPlanChanges=${planOverwriteChanged}`
    + ` forcedLossFiringRoots=${gateFires} [${firingRoots.join(' ')}] totalNodes=${totalNodes}`
    + ` selectorPlanChanges=${selectorPlanChanges}`
    + ` missingSuccessorBranches=${missingSuccessorBranches} truncatedRootCandidates=${truncatedRootCandidates}`
    + `\n  coverageMisses=[${coverageRows.join(' ')}]`
    + `\n  boundMismatchTurns=${boundRows.length}: ${boundRows.join(' ')}`
    + `\n  conflicts:\n  ${conflictRows.join('\n  ')}`,
  );
  expect(reproduced).toBe(TURNS.length);
  // The fixed-depth rerun must reproduce the PRODUCTION root score/mate even
  // when its bound profile differs (11 entries observed), but bound metadata
  // itself is search-order dependent.
  expect(boundMismatch).toBeGreaterThan(0);
  // P0-A real precondition. Measured over the 45 real runs; if zero here the
  // defect stays a constructed-contract risk rather than a fired one.
  console.log(
    `FLT-HV14-4 P0A missingSuccessorBranches=${missingSuccessorBranches}`
    + ` truncatedRootCandidates=${truncatedRootCandidates}`,
  );
  // A real transposed state can be expanded twice inside one search and the
  // second bestAction overwrites the first (P5). Whether the plan walk changes
  // is measured above.
  expect(conflictTurns).toBeGreaterThan(0);
  // The forced-loss selector remains reachable at exactly one real HV14 root
  // under the same depth/leaf/flags (fixed-depth deterministic rerun).
  expect(firingRoots).toEqual(['GAME1T4']);
  // FIX-1: on that root both exact mouse-mate candidates build COMPLETE plans
  // (no truncated / chance-dropped / fail-closed candidate).
  expect(truncatedRootCandidates).toBe(0);
  // FIX-6 evidence: overwrites exist but never change the returned plan.
  expect(planOverwriteChanged).toBe(0);
}, 900_000);
