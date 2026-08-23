/**
 * G0.3E C3 — exact fixture validation + interior-tie propagation.
 * Read-only. Uses ONLY the REAL Game-C Turn3 snapshot.
 */
import { readFileSync } from 'node:fs';
import { restoreHardRoot, type HardRootSnapshot } from './src/game/ai/hardHistory';
import {
  searchBestAction,
  createSearchContext,
  type SearchContext,
} from './src/game/ai/expectiminimax';
import { defaultRuleSet } from './src/game/ai/searchRules';
import { evaluateForCat } from './src/game/ai/evaluation';
import { simulateSearchAction } from './src/game/ai/simulator';
import { generateLegalSearchActions } from './src/game/ai/legalActions';
import { stateKey } from './src/game/ai/transposition';
import { countReversals } from './src/game/ai/planQuality';
import type { SearchAction } from './src/game/ai/searchTypes';
import { GamePhase, PieceType } from './src/game/types';

const LOG_FILE = 'C:\\Users\\zheng\\Downloads\\real-failure-3games.txt';

const DIR: Record<string, { key: string; dr: number; dc: number; label: string }> = {
  ArrowUp: { key: 'ArrowUp', dr: -1, dc: 0, label: '↑' },
  ArrowDown: { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' },
  ArrowLeft: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' },
  ArrowRight: { key: 'ArrowRight', dr: 0, dc: 1, label: '→' },
};

function actionKey(a: SearchAction): string {
  return a.type === 'catStep' ? a.direction!.key : a.type;
}

function dirToAction(key: string): SearchAction {
  return { type: 'catStep', direction: DIR[key] };
}

function getGameBody(text: string, game: 'A' | 'B' | 'C'): string {
  const idx = text.indexOf(`===== GAME ${game} =====`);
  if (idx < 0) throw new Error(`game ${game} not found`);
  const bodyStart = idx;
  const afterMarker = text.slice(idx + `===== GAME ${game} =====`.length);
  const nextIdx = afterMarker.search(/===== GAME [A-C] =====/);
  const end = nextIdx < 0 ? text.length : idx + `===== GAME ${game} =====`.length + nextIdx;
  return text.slice(bodyStart, end);
}

function getTurnSnapshot(body: string, turnNum: number): HardRootSnapshot {
  const turns = body.split(/Turn\s*#(\d+)/).slice(1);
  for (let i = 0; i + 1 < turns.length; i += 2) {
    if (Number(turns[i]) === turnNum) {
      const m = turns[i + 1].match(/SNAPSHOT_JSON=(\{.*\})/);
      if (m) return JSON.parse(m[1]) as HardRootSnapshot;
    }
  }
  throw new Error(`turn ${turnNum} snapshot not found in body`);
}

interface Metrics {
  reversalCount: number;
  revisitCount: number;
  uniqueProgress: number;
  finalCatPos: string;
  finalTrapPos: string;
  boundaryEval: number;
}

function planMetrics(rootState: ReturnType<typeof restoreHardRoot>, plan: SearchAction[]): Metrics {
  const positions: string[] = [`${rootState.catPosition.r},${rootState.catPosition.c}`];
  let cur = rootState;
  let reversalCount = 0;
  const OPP: Record<string, string> = { ArrowUp: 'ArrowDown', ArrowDown: 'ArrowUp', ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft' };
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    if (i > 0 && a.type === 'catStep' && plan[i - 1].type === 'catStep') {
      if (OPP[plan[i - 1].direction!.key] === a.direction!.key) reversalCount++;
    }
    const t = simulateSearchAction(cur, a, defaultRuleSet);
    if (t.kind !== 'deterministic') break;
    cur = t.state;
    positions.push(`${cur.catPosition.r},${cur.catPosition.c}`);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  let revisitCount = 0;
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p)) revisitCount++;
    seen.add(p);
  }
  const uniqueProgress = new Set(positions).size - 1;
  return {
    reversalCount,
    revisitCount,
    uniqueProgress,
    finalCatPos: `${cur.catPosition.r},${cur.catPosition.c}`,
    finalTrapPos: cur.trapPosition ? `(${cur.trapPosition.r},${cur.trapPosition.c})` : 'none',
    boundaryEval: evaluateForCat(cur),
  };
}

function makeCtx(): SearchContext {
  const ctx = createSearchContext(defaultRuleSet, 5_000_000, true, true, true);
  ctx.leafEvaluator = evaluateForCat;
  ctx.capturePlan = true;
  return ctx;
}

function main(): void {
  const text = readFileSync(LOG_FILE, 'utf8');
  const body = getGameBody(text, 'C');
  const root = restoreHardRoot(getTurnSnapshot(body, 3));

  // 1. Fixture identity
  const fixtureOk =
    root.catPosition.r === 1 && root.catPosition.c === 1 &&
    root.mousePosition.r === 2 && root.mousePosition.c === 7 &&
    root.mouseHasButter === true &&
    root.trapPosition?.r === 2 && root.trapPosition?.c === 1;
  if (!fixtureOk) {
    console.error('C3 FIXTURE FAIL',
      `cat=(${root.catPosition.r},${root.catPosition.c})`,
      `mouse=(${root.mousePosition.r},${root.mousePosition.c})`,
      `butter=${root.mouseHasButter}`,
      `trap=${root.trapPosition ? `(${root.trapPosition.r},${root.trapPosition.c})` : 'none'}`);
    process.exit(1);
  }
  console.log('C3 fixture identity: PASS');
  console.log('  cat=(1,1) mouse=(2,7) butter=true trap=(2,1)');

  // 2. Search d2 (R1 ON)
  const ctx = makeCtx();
  const res = searchBestAction(root, 2, ctx);
  console.log(`\nC3 d2 search (R1 ON): rootValue=${res.value} mate=${res.mate ?? 'null'} completed=${res.completed}`);
  console.log('  rootActions:');
  for (const ra of ctx.rootValues) {
    console.log(`    ${actionKey(ra.action).padEnd(10)} value=${ra.value} mate=${ra.mate ?? 'null'}`);
  }

  const newPlan = res.catTurnPlan;
  console.log(`\n  NEW catTurnPlan: ${newPlan.map(actionKey).join('→')}`);
  const newM = planMetrics(root, newPlan);
  console.log(`    NEW reversal=${newM.reversalCount} revisit=${newM.revisitCount} uniqueProgress=${newM.uniqueProgress} finalCatPos=${newM.finalCatPos} finalTrapPos=${newM.finalTrapPos} boundaryEval=${newM.boundaryEval.toFixed(2)}`);

  // 3. OLD plan (production)
  const oldPlan: SearchAction[] = [
    dirToAction('ArrowDown'),
    dirToAction('ArrowUp'),
    dirToAction('ArrowRight'),
    { type: 'catPlaceTrap' },
    dirToAction('ArrowLeft'),
  ];
  const oldM = planMetrics(root, oldPlan);
  console.log(`\n  OLD catTurnPlan: ${oldPlan.map(actionKey).join('→')}`);
  console.log(`    OLD reversal=${oldM.reversalCount} revisit=${oldM.revisitCount} uniqueProgress=${oldM.uniqueProgress} finalCatPos=${oldM.finalCatPos} finalTrapPos=${oldM.finalTrapPos} boundaryEval=${oldM.boundaryEval.toFixed(2)}`);

  console.log(`\n  Improvement: NEW reversal (${newM.reversalCount}) < OLD (${oldM.reversalCount}): ${newM.reversalCount < oldM.reversalCount ? 'YES ⬇' : 'NO'}`);
  console.log(`               NEW finalPos (${newM.finalCatPos}) ≠ (1,1): ${newM.finalCatPos !== '(1,1)' ? 'YES' : 'NO'}`);

  // 4. Interior tie after firstAction=Down
  console.log(`\n=== C3 INTERIOR TIE (firstAction=Down) ===`);
  const downAction = dirToAction('ArrowDown');
  const step1 = simulateSearchAction(root, downAction, defaultRuleSet);
  if (step1.kind !== 'deterministic') { console.error('down transition non-deterministic'); process.exit(2); }
  const s1 = step1.state;
  const s1Key = stateKey(s1);
  console.log(`step1: cat=(${s1.catPosition.r},${s1.catPosition.c}) after Down`);
  const s1Legal = generateLegalSearchActions(s1, defaultRuleSet);
  console.log(`  stateKey=${s1Key.slice(0, 60)}...`);
  console.log(`  legal: ${s1Legal.map(actionKey).join(', ')}`);

  for (const a of s1Legal) {
    const t = simulateSearchAction(s1, a, defaultRuleSet);
    if (t.kind !== 'deterministic') { console.log(`  ${actionKey(a)}: chance`); continue; }
    const switched = s1.currentPlayer !== t.state.currentPlayer;
    const childDepth = 2 - (switched ? 1 : 0);
    const c = makeCtx();
    const r = searchBestAction(t.state, childDepth, c);
    const cont = [downAction, a, ...r.catTurnPlan];
    const m = planMetrics(root, cont);
    console.log(`  ${actionKey(a).padEnd(10)} child=value=${String(r.value).padStart(9)} mate=${r.mate ?? 'null'} contPlan=${cont.map(actionKey).join('→')} contRev=${m.reversalCount} contVisit=${m.revisitCount}`);
  }

  // 5. planBranches
  console.log(`\n  planBranches[step1Key]: ${ctx.planBranches.has(s1Key) ? actionKey(ctx.planBranches.get(s1Key)!) : 'ABSENT'}`);
}

main();