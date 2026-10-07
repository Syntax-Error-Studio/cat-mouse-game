/**
 * G0.2-6 — Offline Point-of-No-Return scan (MEASUREMENT ONLY).
 *
 * INPUT: a JSON file containing an array of HardSearchHistoryEntry (exact deep
 * snapshots of each Hard cat-turn root from the game's
 * "[HARD_SEARCH_HISTORY]" copy export, see components/DebugInfo.tsx).
 *
 * For every saved root (newest first): restore the EXACT state, verify
 * stateKey round-trip, then run NO-deadline truth searches (big maxNodes,
 * defaultRuleSet + evaluateForCat + AB + TT + ordering) at depth 2/3/4,
 * reporting production vs deep + per-root-action values. It locates the
 * FIRST_FORCED_LOSS_ROOT (all actions mouse-mate at the deepest verified
 * proof) and reports whether a PREVIOUS root had a savable action.
 *
 * Run:  npx vite-node tools/research-archive/g02scan.mts <history.json>
 */
import { readFileSync } from 'node:fs';
import type { GameEngineState } from '../../src/game/engine';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import type { RuleSet, SearchAction } from '../../src/game/ai/searchTypes';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import {
  searchBestActionIterative as iter,
  searchResult,
  stepChildForParent,
  mateActionCost,
  createSearchContext,
  type MateSide,
} from '../../src/game/ai/expectiminimax';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { restoreHardRoot, type HardSearchHistoryEntry } from '../../src/game/ai/hardHistory';
import { stateKey } from '../../src/game/ai/transposition';

const BIG = 50_000_000;

console.log('[g02scan] starting...');

const fmtMate = (m: MateSide): string => (m === null ? 'null' : m);
const fmtKey = (a: SearchAction): string => (a.type === 'catStep' ? a.direction.key : a.type);

function truthAt(root: GameEngineState, depth: number) {
  const d = iter(root, {
    rules: defaultRuleSet,
    maxDepthTurns: depth,
    maxNodes: BIG,
    useTT: true,
    useAlphaBeta: true,
    useMoveOrdering: true,
    leafEvaluator: evaluateForCat,
  });
  const actions = generateLegalSearchActions(root, defaultRuleSet).map((a) => {
    const t = simulateSearchAction(root, a, defaultRuleSet);
    const cost = mateActionCost(a);
    if (t.kind === 'deterministic') {
      const ctx = freshCtx();
      const switched = root.currentPlayer !== t.state.currentPlayer;
      const r = searchResult(t.state, depth - (switched ? 1 : 0), ctx);
      return { action: a, value: stepChildForParent(r, cost), mate: r.mate, completed: r.completed };
    }
    // Cat root actions are never chance; keep type-safe.
    const o = t.outcomes[0];
    const ctx = freshCtx();
    const switched = root.currentPlayer !== o.state.currentPlayer;
    const r = searchResult(o.state, depth - (switched ? 1 : 0), ctx);
    return {
      action: a,
      value: stepChildForParent(r, cost),
      mate: r.mate,
      completed: r.completed,
    };
  });
  return { d, actions };
}

function freshCtx() {
  const c = createSearchContext(defaultRuleSet, BIG, true, true, true);
  c.leafEvaluator = evaluateForCat;
  return c;
}

function main() {
  const file = process.argv[2] ?? 'g02-history-sample.json';
  const entries = (JSON.parse(readFileSync(file, 'utf8')) as HardSearchHistoryEntry[]).slice().sort((a, b) => b.turn - a.turn);

  // first: verify round-trip of every snapshot
  let roundTripsOk = true;
  for (const e of entries) {
    const restored = restoreHardRoot(e.root);
    if (stateKey(restored) !== e.stateKey) {
      console.error(`  round-trip FAIL at turn ${e.turn}: ${stateKey(restored)} != ${e.stateKey}`);
      roundTripsOk = false;
    }
  }
  console.log(`round-trip verification: ${roundTripsOk ? 'ALL OK' : 'FAILED'} (${entries.length} roots)`);
  if (!roundTripsOk) {
    console.error('BLOCKED: snapshot round-trip broken — no strategy conclusion below.');
    process.exit(2);
  }

  const rows: {
    turn: number;
    prod: { cd: number; mate: string; rv: number; plan: string };
    deep: { depth: number; completed: boolean; rv: number; mate: string }[];
    actions: { action: string; value: number; mate: string; completed: boolean }[];
    allMouse: boolean;
  }[] = [];

  for (const e of entries) {
    const root = restoreHardRoot(e.root);
    const prod = {
      cd: e.production.completedDepth,
      mate: fmtMate(e.production.mate),
      rv: e.production.rootValue,
      plan: e.production.plan.map(fmtKey).join(' → ') || '(none)',
    };
    const deep: { depth: number; completed: boolean; rv: number; mate: string }[] = [];
    let actions: { action: string; value: number; mate: string; completed: boolean }[] = [];

    for (const depth of [2, 3, 4]) {
      const { d, actions: acts } = truthAt(root, depth);
      if (d.completedDepth >= depth) {
        actions = acts.map((a) => ({
          action: fmtKey(a.action),
          value: a.value,
          mate: fmtMate(a.mate),
          completed: a.completed,
        }));
        deep.push({ depth, completed: true, rv: d.value, mate: fmtMate(d.mate) });
      } else {
        deep.push({ depth, completed: false, rv: d.value, mate: fmtMate(d.mate) });
      }
    }
    const allMouse = actions.length > 0 && actions.every((a) => a.mate === 'mouse');
    rows.push({ turn: e.turn, prod, deep, actions, allMouse });
  }

  console.log('\n================ G0.2 Point-of-No-Return scan ================');
  for (const r of rows) {
    console.log(`\nTurn #${r.turn}`);
    console.log(`  production: cDepth=${r.prod.cd} mate=${r.prod.mate} rootValue=${r.prod.rv} plan=[${r.prod.plan}]`);
    for (const d of r.deep) {
      console.log(`  deep d${d.depth}: completed=${d.completed} rv=${d.rv} mate=${d.mate}`);
    }
    console.log('  ROOT ACTIONS (deepest verified):');
    for (const a of r.actions) {
      console.log(`    ${a.action.padEnd(10)} value=${a.value.toFixed(1)} mate=${a.mate} completed=${a.completed}`);
    }
    console.log(`  allMouseAtDeepest=${r.allMouse}`);
  }

  // Locate FIRST_FORCED_LOSS (newest-first order => scanning from last turn).
  const forcedLossTurns = rows.filter((r) => r.allMouse).map((r) => r.turn);
  console.log('\n--- classification ---');
  console.log(`roots scanned: ${rows.length}`);
  if (forcedLossTurns.length === 0) {
    console.log('no root with ALL-actions-mouse-mate found at depth 2..4 → no FIRST_FORCED_LOSS_ROOT yet.');
  } else {
    console.log(`FIRST_FORCED_LOSS_ROOT candidates (allMouse): turns ${forcedLossTurns.join(', ')}`);
    // The PNR = the EARLIEST chronological turn among them; a PREVIOUS
    // (lower turn) root that is savable is LAST_SAVABLE_ROOT.
    const firstForced = Math.min(...forcedLossTurns); // earliest
    const prev = rows.find((r) => r.turn === firstForced - 1);
    console.log(`earliest allMouse root = Turn #${firstForced}`);
    if (prev) {
      const savable = prev.actions.filter((a) => a.mate !== 'mouse');
      console.log(`previous savable root = Turn #${prev.turn}: ${savable.length > 0 ? `savable actions: ${savable.map((a) => a.action).join(', ')}` : 'ALSO all-mouse (loss began earlier)'}`);
    } else {
      console.log('no previous root in history → need an earlier captured root for LAST_SAVABLE_ROOT.');
    }
  }
}

main();