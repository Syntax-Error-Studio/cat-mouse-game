/**
 * G0.3D — Post-G0.3C Real Failure Truth Scan (diagnostic, READ-ONLY).
 *
 * Parses the 3-game REAL failure log, runs exactness gate (stateKey round-trip
 * + gameAffectingEqual + production PLAN replay), then runs deeper truth
 * (depth 2/3/4, deadline OFF, evalCache ON, AB, TT, production search semantics)
 * for the key roots: C3, B4, A1.
 *
 * Also checks:
 *   - evaluator flatness (candidate plan boundary evals)
 *   - plan branch capture (G0.3A secondary scope)
 *   - intra-turn continuation (NON_FORCED_INTRA_TURN_TIE candidate)
 *
 * Usage:
 *   npx tsx g03d.mts <logfile>
 *   npx tsx g03d.mts "C:\Users\zheng\Downloads\real-failure-3games.txt"
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { catMove, catPlaceTrap, type GameEngineState } from './src/game/engine';
import { GamePhase, PieceType, type Direction } from './src/game/types';
import type { SearchAction, RuleSet } from './src/game/ai/searchTypes';
import {
  searchBestAction,
  searchResult,
  stepChildForParent,
  mateActionCost,
  createSearchContext,
  type MateSide,
  type SearchContext,
} from './src/game/ai/expectiminimax';
import { evaluateForCat, evaluateForCatDetailed, type EvaluationContributions } from './src/game/ai/evaluation';
import { defaultRuleSet } from './src/game/ai/searchRules';
import { restoreHardRoot, type HardRootSnapshot } from './src/game/ai/hardHistory';
import { stateKey } from './src/game/ai/transposition';
import { simulateSearchAction } from './src/game/ai/simulator';
import { generateLegalSearchActions } from './src/game/ai/legalActions';
import { gameAffectingEqual } from './src/game/ai/stateCompare';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const DIR: Record<string, Direction> = {
  ArrowUp: { key: 'ArrowUp', dr: -1, dc: 0, label: '↑' },
  ArrowDown: { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' },
  ArrowLeft: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' },
  ArrowRight: { key: 'ArrowRight', dr: 0, dc: 1, label: '→' },
};

interface TurnEntry {
  game: string;
  turn: number;
  stateKey: string;
  planText: string;
  endStateKey: string | null;
  snapshot: HardRootSnapshot;
  cDepth: number;
  aDepth: number;
  rootValue: number;
  mate: string;
  catPos: string;
  mousePos: string;
  butter: boolean;
  trap: string;
}

function parsePlan(text: string): SearchAction[] {
  const out: SearchAction[] = [];
  for (const t of text.split('→').map((x) => x.trim()).filter(Boolean)) {
    if (t === 'catPlaceTrap') out.push({ type: 'catPlaceTrap' });
    else if (t.startsWith('catStep ')) {
      const key = t.slice(8).trim() as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
      out.push({ type: 'catStep', direction: DIR[key] });
    } else throw new Error(`unparsable plan token: "${t}"`);
  }
  return out;
}

function replayPlan(root: GameEngineState, planText: string): GameEngineState | null {
  let cur = root;
  try {
    for (const a of parsePlan(planText)) {
      if (a.type === 'catStep') cur = catMove(cur, a.direction);
      else if (a.type === 'catPlaceTrap') cur = catPlaceTrap(cur);
      else return null;
    }
  } catch { return null; }
  return cur;
}

function parseFile(text: string): TurnEntry[] {
  const out: TurnEntry[] = [];
  // Split by game markers
  const gameMarkers = text.split(/===== GAME ([A-C]) =====/);
  // gameMarkers[0] = before first marker, then pairs: [letter, content]
  for (let gi = 1; gi + 1 < gameMarkers.length; gi += 2) {
    const game = gameMarkers[gi];
    const body = gameMarkers[gi + 1];
    // Parse Turn #N blocks within HARD_SEARCH_HISTORY
    const turnBlocks = body.split(/Turn\s*#(\d+)/).slice(1);
    for (let ti = 0; ti + 1 < turnBlocks.length; ti += 2) {
      const turn = Number(turnBlocks[ti]);
      const tbody = turnBlocks[ti + 1];
      const skM = tbody.match(/STATE_KEY=(\S+)/);
      const planM = tbody.match(/PLAN:\s*(.*)/);
      const execM = tbody.match(/EXEC: endState=(\S+)/);
      const snapM = tbody.match(/SNAPSHOT_JSON=(\{.*\})/);
      const searchM = tbody.match(/cDepth=(\d+)\s+aDepth=(\d+)/);
      const rootM = tbody.match(/ROOT_VALUE=(-?\d+(?:\.\d+)?)\s+mate=(\S+)/);
      const catM = tbody.match(/cat=\((\d+),(\d+)\)/);
      const mouseM = tbody.match(/mouse=\((\d+),(\d+)\)/);
      const butterM = tbody.match(/butter=(true|false)/);
      const trapM = tbody.match(/trap=\((\d+),(\d+)\)|trap=none/);
      if (!skM || !snapM) {
        console.error(`${game} Turn #${turn}: missing STATE_KEY or SNAPSHOT_JSON`);
        continue;
      }
      let snapshot: HardRootSnapshot;
      try {
        snapshot = JSON.parse(snapM[1]) as HardRootSnapshot;
      } catch (e) {
        console.error(`${game} Turn #${turn}: SNAPSHOT_JSON parse error: ${(e as Error).message}`);
        continue;
      }
      out.push({
        game: `GAME ${game}`,
        turn,
        stateKey: skM[1],
        planText: planM ? planM[1].trim() : '',
        endStateKey: execM ? execM[1] : null,
        snapshot,
        cDepth: searchM ? Number(searchM[1]) : NaN,
        aDepth: searchM ? Number(searchM[2]) : NaN,
        rootValue: rootM ? Number(rootM[1]) : NaN,
        mate: rootM ? rootM[2] : '?',
        catPos: catM ? `(${catM[1]},${catM[2]})` : '?',
        mousePos: mouseM ? `(${mouseM[1]},${mouseM[2]})` : '?',
        butter: butterM ? butterM[1] === 'true' : false,
        trap: trapM && trapM[0] !== 'trap=none' ? `(${trapM[1]},${trapM[2]})` : 'none',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exactness gate
// ---------------------------------------------------------------------------

function exactnessGate(turns: TurnEntry[]): { pass: boolean; results: { entry: TurnEntry; stateKeyOk: boolean; replayOk: boolean; restored: GameEngineState }[] } {
  const results: { entry: TurnEntry; stateKeyOk: boolean; replayOk: boolean; restored: GameEngineState }[] = [];
  let allPass = true;
  for (const t of turns) {
    const restored = restoreHardRoot(t.snapshot);
    const sk = stateKey(restored);
    const stateKeyOk = sk === t.stateKey;
    let replayOk = true;
    if (t.endStateKey !== null && t.planText) {
      const replayed = replayPlan(restored, t.planText);
      if (replayed === null || stateKey(replayed) !== t.endStateKey) {
        replayOk = false;
      }
    }
    if (!stateKeyOk || !replayOk) allPass = false;
    results.push({ entry: t, stateKeyOk, replayOk, restored });
  }
  return { pass: allPass, results };
}

// ---------------------------------------------------------------------------
// Per-action truth (fixed depth, deadline OFF, evalCache ON, AB, TT, production)
// ---------------------------------------------------------------------------

const actionKey = (a: SearchAction): string => (a.type === 'catStep' ? a.direction!.key : a.type);
const fmtMate = (m: MateSide): string => (m === null ? 'null' : m);

interface PerActionTruth {
  action: string;
  value: number;
  mate: string;
  completed: boolean;
  nodes: number;
  elapsedMs: number;
}

function perActionTruth(root: GameEngineState, depth: number, budget: number): { perAction: PerActionTruth[]; rootValue: number; rootMate: string; totalNodes: number } {
  const legal = generateLegalSearchActions(root, defaultRuleSet);
  const perAction: PerActionTruth[] = [];
  let totalNodes = 0;
  for (const a of legal) {
    const t = simulateSearchAction(root, a, defaultRuleSet);
    const cost = mateActionCost(a);
    if (t.kind !== 'deterministic') {
      perAction.push({ action: actionKey(a), value: NaN, mate: 'n/a', completed: false, nodes: 0, elapsedMs: 0 });
      continue;
    }
    const switched = root.currentPlayer !== t.state.currentPlayer;
    const childDepth = depth - (switched ? 1 : 0);
    const ctx = createSearchContext(defaultRuleSet, budget, true, true, true);
    ctx.leafEvaluator = evaluateForCat;
    ctx.capturePlan = true;
    const t0 = performance.now();
    const r = searchResult(t.state, childDepth, ctx);
    const elapsed = performance.now() - t0;
    const value = stepChildForParent(r, cost);
    perAction.push({
      action: actionKey(a),
      value,
      mate: fmtMate(r.mate),
      completed: r.completed,
      nodes: ctx.diagnostics.nodes,
      elapsedMs: elapsed,
    });
    totalNodes += ctx.diagnostics.nodes;
  }
  // Root search
  const rootCtx = createSearchContext(defaultRuleSet, budget, true, true, true);
  rootCtx.leafEvaluator = evaluateForCat;
  rootCtx.capturePlan = true;
  const rootRes = searchBestAction(root, depth, rootCtx);
  totalNodes += rootCtx.diagnostics.nodes;
  return { perAction, rootValue: rootRes.value, rootMate: fmtMate(rootRes.mate), totalNodes };
}

// ---------------------------------------------------------------------------
// Intra-turn continuation analysis (for NON_FORCED_INTRA_TURN_TIE)
// ---------------------------------------------------------------------------

interface IntraTurnStep {
  stepIdx: number;
  stateKey: string;
  catPos: string;
  candidateActions: { action: string; value: number; mate: string; completed: boolean }[];
  chosenAction: string;
  isTie: boolean;
  tieAlternatives: string[];
}

function intraTurnAnalysis(root: GameEngineState, depth: number, budget: number): IntraTurnStep[] {
  const steps: IntraTurnStep[] = [];
  let cur = root;
  let stepIdx = 0;
  const seen = new Set<string>([stateKey(root)]);
  while (cur.phase === GamePhase.Playing && cur.currentPlayer === PieceType.Cat && stepIdx < 8) {
    const legal = generateLegalSearchActions(cur, defaultRuleSet);
    const candidates: { action: string; value: number; mate: string; completed: boolean; rawScore: { value: number; mate: MateSide } }[] = [];
    for (const a of legal) {
      const t = simulateSearchAction(cur, a, defaultRuleSet);
      const cost = mateActionCost(a);
      if (t.kind !== 'deterministic') {
        candidates.push({ action: actionKey(a), value: NaN, mate: 'n/a', completed: false, rawScore: { value: 0, mate: null } });
        continue;
      }
      const switched = cur.currentPlayer !== t.state.currentPlayer;
      const childDepth = depth - (switched ? 1 : 0);
      const ctx = createSearchContext(defaultRuleSet, budget, true, true, true);
      ctx.leafEvaluator = evaluateForCat;
      const r = searchResult(t.state, childDepth, ctx);
      const value = stepChildForParent(r, cost);
      candidates.push({ action: actionKey(a), value, mate: fmtMate(r.mate), completed: r.completed, rawScore: { value, mate: r.mate } });
    }
    // Find best by compareSearchScore (same as production)
    candidates.sort((a, b) => {
      const ra = a.rawScore.mate === 'cat' ? 2 : a.rawScore.mate === null ? 1 : 0;
      const rb = b.rawScore.mate === 'cat' ? 2 : b.rawScore.mate === null ? 1 : 0;
      if (ra !== rb) return rb - ra; // higher = better for cat
      return b.value - a.value; // higher = better for cat (MAX)
    });
    const best = candidates[0];
    // Check tie: same mate rank AND same value
    const bestRank = best.rawScore.mate === 'cat' ? 2 : best.rawScore.mate === null ? 1 : 0;
    const ties = candidates.filter((c) => {
      const cr = c.rawScore.mate === 'cat' ? 2 : c.rawScore.mate === null ? 1 : 0;
      return cr === bestRank && Math.abs(c.value - best.value) < 1e-9;
    });
    // Production picks first in original legal order among ties.
    // The chosen action is the one that appears FIRST in `legal` among the ties.
    const chosenAction = best.action;
    const isTie = ties.length > 1;
    const tieAlternatives = ties.map((t2) => t2.action);

    steps.push({
      stepIdx,
      stateKey: stateKey(cur).slice(0, 50),
      catPos: `(${cur.catPosition.r},${cur.catPosition.c})`,
      candidateActions: candidates.map((c) => ({ action: c.action, value: c.value, mate: c.mate, completed: c.completed })),
      chosenAction,
      isTie,
      tieAlternatives,
    });

    // Advance along the chosen action
    const chosenAct = legal.find((a) => actionKey(a) === chosenAction);
    if (!chosenAct) break;
    const trans = simulateSearchAction(cur, chosenAct, defaultRuleSet);
    if (trans.kind !== 'deterministic') break;
    cur = trans.state;
    const nk = stateKey(cur);
    if (seen.has(nk)) break;
    seen.add(nk);
    stepIdx++;
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Evaluator flatness analysis
// ---------------------------------------------------------------------------

interface PlanEvalEntry {
  plan: string;
  catEndPos: string;
  boundaryEval: number;
  contributions: EvaluationContributions;
}

function evaluatorFlatness(root: GameEngineState, depth: number, budget: number): PlanEvalEntry[] {
  // Enumerate all full cat-turn plans (same-actor), evaluate boundary states
  const results: PlanEvalEntry[] = [];
  const visited = new Set<string>();

  function visit(state: GameEngineState, plan: SearchAction[]) {
    const needNext = state.phase === GamePhase.Playing && state.currentPlayer === PieceType.Cat;
    if (!needNext) {
      const sk = stateKey(state);
      if (visited.has(sk)) return;
      visited.add(sk);
      const breakdown = evaluateForCatDetailed(state);
      results.push({
        plan: plan.map(actionKey).join('→') || '(no actions)',
        catEndPos: `(${state.catPosition.r},${state.catPosition.c})`,
        boundaryEval: breakdown.total,
        contributions: breakdown.contributions,
      });
      return;
    }
    const legal = generateLegalSearchActions(state, defaultRuleSet);
    for (const a of legal) {
      const t = simulateSearchAction(state, a, defaultRuleSet);
      if (t.kind !== 'deterministic') continue;
      visit(t.state, [...plan, a]);
    }
  }
  visit(root, []);
  // Sort by eval descending (best for cat first)
  results.sort((a, b) => b.boundaryEval - a.boundaryEval);
  return results;
}

// ---------------------------------------------------------------------------
// Plan branch capture check (G0.3A secondary scope)
// ---------------------------------------------------------------------------

function planBranchCaptureCheck(root: GameEngineState, depth: number, budget: number): {
  rootMate: string;
  rootActions: { action: string; value: number; mate: string }[];
  primaryEqual: { action: string; value: number; mate: string }[];
  secondaryTriggered: boolean;
  secondaryReason: string;
  productionPlan: string;
  tieBrokenPlan: string | null;
} {
  const ctx = createSearchContext(defaultRuleSet, budget, true, true, true);
  ctx.leafEvaluator = evaluateForCat;
  ctx.capturePlan = true;
  const res = searchBestAction(root, depth, ctx);
  const rootActions = ctx.rootValues.map((rv) => ({ action: actionKey(rv.action), value: rv.value, mate: fmtMate(rv.mate) }));

  // Check for primary ties
  const anyMouseMate = rootActions.some((a) => a.mate === 'mouse');
  if (!anyMouseMate) {
    return {
      rootMate: fmtMate(res.mate),
      rootActions,
      primaryEqual: [],
      secondaryTriggered: false,
      secondaryReason: 'root is NOT mouse-mate → G0.3A secondary does not trigger',
      productionPlan: res.catTurnPlan.map(actionKey).join('→'),
      tieBrokenPlan: null,
    };
  }

  // Find best primary
  const best = rootActions.reduce((acc, a) => {
    const ra = a.mate === 'cat' ? 2 : a.mate === null ? 1 : 0;
    const rb = acc.mate === 'cat' ? 2 : acc.mate === null ? 1 : 0;
    if (ra > rb || (ra === rb && a.value > acc.value)) return a;
    return acc;
  });
  const primaryEqual = rootActions.filter((a) => {
    const ra = a.mate === 'cat' ? 2 : a.mate === null ? 1 : 0;
    const rb = best.mate === 'cat' ? 2 : best.mate === null ? 1 : 0;
    return ra === rb && Math.abs(a.value - best.value) < 1e-9;
  });

  const allMouseMate = primaryEqual.every((a) => a.mate === 'mouse');
  const secondaryTriggered = primaryEqual.length > 1 && allMouseMate;

  return {
    rootMate: fmtMate(res.mate),
    rootActions,
    primaryEqual,
    secondaryTriggered,
    secondaryReason: secondaryTriggered
      ? `G0.3A secondary ACTIVE: ${primaryEqual.length} primary-equal mouse-mate actions`
      : primaryEqual.length <= 1
        ? 'only 1 primary-equal action → no tie to break'
        : 'primary-equal includes non-mouse-mate → secondary does not trigger',
    productionPlan: res.catTurnPlan.map(actionKey).join('→'),
    tieBrokenPlan: secondaryTriggered ? res.catTurnPlan.map(actionKey).join('→') : null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const file = process.argv[2] ?? 'C:\\Users\\zheng\\Downloads\\real-failure-3games.txt';
  const text = readFileSync(file, 'utf8');
  const turns = parseFile(text);
  console.log(`=== G0.3D — Real Failure Truth Scan ===`);
  console.log(`file: ${file}`);
  console.log(`parsed ${turns.length} turns across ${new Set(turns.map((t) => t.game)).size} games\n`);

  // Summary of all turns
  for (const t of turns) {
    console.log(`  ${t.game} Turn#${t.turn} cat=${t.catPos} mouse=${t.mousePos} butter=${t.butter} trap=${t.trap} cDepth=${t.cDepth} root=${t.rootValue} mate=${t.mate}`);
  }
  console.log('');

  // ---- EXACTNESS GATE ----
  console.log(`=== EXACTNESS GATE ===`);
  const gate = exactnessGate(turns);
  for (const r of gate.results) {
    const status = r.stateKeyOk && r.replayOk ? 'PASS' : 'FAIL';
    console.log(`  ${r.entry.game} Turn#${r.entry.turn} ${status} stateKey=${r.stateKeyOk ? 'OK' : 'MISMATCH'} replay=${r.replayOk ? 'OK' : 'MISMATCH'}`);
  }
  if (!gate.pass) {
    console.error('BLOCKED: exactness gate failed');
    process.exit(3);
  }
  console.log(`exactness gate: ALL ${gate.results.length} PASS\n`);

  // Map for easy access
  const findTurn = (game: string, turn: number) => gate.results.find((r) => r.entry.game === game && r.entry.turn === turn)!;

  // ---- DEEPER TRUTH: C3, B4, A1 ----
  const budget = 30_000_000;
  const depths = [2, 3, 4];

  // Priority order: C3, B4, A1
  const roots: { label: string; game: string; turn: number }[] = [
    { label: 'C3', game: 'GAME C', turn: 3 },
    { label: 'B4', game: 'GAME B', turn: 4 },
    { label: 'A1', game: 'GAME A', turn: 1 },
  ];

  for (const { label, game, turn } of roots) {
    const r = findTurn(game, turn);
    const root = r.restored;
    console.log(`\n=== ${label} ${game} Turn#${turn} ===`);
    console.log(`  cat=${root.catPosition.r},${root.catPosition.c} mouse=${root.mousePosition.r},${root.mousePosition.c} butter=${root.mouseHasButter} trap=${root.trapPosition ? `(${root.trapPosition.r},${root.trapPosition.c})` : 'none'}`);
    console.log(`  production: cDepth=${r.entry.cDepth} root=${r.entry.rootValue} mate=${r.entry.mate}`);
    console.log(`  PLAN: ${r.entry.planText}`);

    for (const depth of depths) {
      console.log(`\n  --- depth ${depth} (deadline OFF, evalCache ON, AB, TT, production) ---`);
      const t0 = performance.now();
      const truth = perActionTruth(root, depth, budget);
      const totalElapsed = performance.now() - t0;
      console.log(`  rootValue=${truth.rootValue} mate=${truth.rootMate} totalNodes=${truth.totalNodes} elapsed=${totalElapsed.toFixed(0)}ms`);
      console.log(`  per-action:`);
      for (const pa of truth.perAction) {
        console.log(`    ${pa.action.padEnd(12)} value=${String(pa.value).padStart(12)} mate=${pa.mate.padEnd(5)} completed=${pa.completed} nodes=${pa.nodes} ${pa.elapsedMs.toFixed(0)}ms`);
      }
    }

    // ---- Intra-turn continuation analysis (C3 priority) ----
    if (label === 'C3') {
      console.log(`\n  --- C3 intra-turn continuation (depth 2) ---`);
      const intra = intraTurnAnalysis(root, 2, budget);
      for (const step of intra) {
        console.log(`  step ${step.stepIdx} cat=${step.catPos} chosen=${step.chosenAction}${step.isTie ? ' [TIE: ' + step.tieAlternatives.join(',') + ']' : ''}`);
        for (const ca of step.candidateActions) {
          console.log(`    ${ca.action.padEnd(12)} value=${String(ca.value).padStart(12)} mate=${ca.mate.padEnd(5)} completed=${ca.completed}`);
        }
      }
    }

    // ---- Plan branch capture check ----
    if (label === 'C3' || label === 'B4') {
      console.log(`\n  --- ${label} plan branch capture (depth 2) ---`);
      const pbc = planBranchCaptureCheck(root, 2, budget);
      console.log(`  rootMate=${pbc.rootMate}`);
      console.log(`  rootActions:`);
      for (const ra of pbc.rootActions) {
        console.log(`    ${ra.action.padEnd(12)} value=${String(ra.value).padStart(12)} mate=${ra.mate}`);
      }
      console.log(`  primaryEqual: [${pbc.primaryEqual.map((p) => p.action).join(', ')}]`);
      console.log(`  secondaryTriggered=${pbc.secondaryTriggered} reason="${pbc.secondaryReason}"`);
      console.log(`  productionPlan=${pbc.productionPlan}`);
    }

    // ---- Evaluator flatness ----
    if (label === 'C3' || label === 'B4') {
      console.log(`\n  --- ${label} evaluator flatness (boundary evals) ---`);
      const flats = evaluatorFlatness(root, 2, budget);
      console.log(`  ${flats.length} unique boundary states from all full cat-turn plans:`);
      // Show top 15 and bottom 5
      const showCount = Math.min(flats.length, 20);
      for (let i = 0; i < showCount; i++) {
        const f = flats[i];
        const c = f.contributions;
        console.log(`    [${i}] eval=${String(f.boundaryEval).padStart(10)} pos=${f.catEndPos} plan=${f.plan}`);
        if (i < 5 || i >= showCount - 3) {
          console.log(`         goal=${c.mouseGoalThreat.toFixed(0)} route=${0} hole=${c.holeControl.toFixed(0)} capture=${c.capturePressure.toFixed(0)} voronoi=${c.voronoiBalance.toFixed(0)} trap=${c.trapControl.toFixed(0)} tempo=${c.tempo.toFixed(0)}`);
        }
      }
      if (flats.length > showCount) {
        console.log(`    ... (${flats.length - showCount} more)`);
      }
      // Check for near-equal evals
      const evals = flats.map((f) => f.boundaryEval);
      const min = Math.min(...evals);
      const max = Math.max(...evals);
      const range = max - min;
      console.log(`  eval range: ${min.toFixed(1)} .. ${max.toFixed(1)} (spread=${range.toFixed(1)})`);
      // Count how many are within 5% of max
      const nearMax = evals.filter((e) => max - e < 5).length;
      console.log(`  within 5pt of max: ${nearMax}/${evals.length}`);
    }
  }

  // ---- A1 special: is it START_POSITION_FORCED_LOSS? ----
  console.log(`\n=== A1 START_POSITION_FORCED_LOSS check ===`);
  const a1 = findTurn('GAME A', 1);
  const a1Root = a1.restored;
  // Check next turn (A2) — already mate=mouse?
  const a2 = findTurn('GAME A', 2);
  console.log(`  A1: cat=${a1Root.catPosition.r},${a1Root.catPosition.c} mouse=${a1Root.mousePosition.r},${a1Root.mousePosition.c} butter=${a1Root.mouseHasButter}`);
  console.log(`  A1 production: cDepth=${a1.entry.cDepth} root=${a1.entry.rootValue} mate=${a1.entry.mate}`);
  console.log(`  A2 (next turn): cat=${a2.entry.catPos} mouse=${a2.entry.mousePos} butter=${a2.entry.butter} root=${a2.entry.rootValue} mate=${a2.entry.mate}`);
  // At A1, check if ALL first actions lead to mouse-mate at depth 2/3/4
  for (const depth of depths) {
    const truth = perActionTruth(a1Root, depth, budget);
    const allMouse = truth.perAction.every((p) => p.mate === 'mouse');
    const anyNonMouse = truth.perAction.some((p) => p.mate !== 'mouse' && p.completed);
    console.log(`  d${depth}: rootMate=${truth.rootMate} allActionsMouseMate=${allMouse} anySavingAction=${anyNonMouse}`);
    for (const pa of truth.perAction) {
      console.log(`    ${pa.action.padEnd(12)} value=${String(pa.value).padStart(12)} mate=${pa.mate.padEnd(5)} completed=${pa.completed}`);
    }
  }

  console.log(`\n=== G0.3D scan complete ===`);
}

main();
