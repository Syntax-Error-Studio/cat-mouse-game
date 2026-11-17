/// <reference types="node" />
/**
 * PPC-P1-CLOSURE-01 / P3-C — what does the CURRENT production planner do on the
 * GAME3 T4 root? Read-only.
 *
 * The logged build reported value -1052.9473 / mate=null / cDepth=2 and played
 * Down,Right,Right,Right (which does NOT win). P3-B proved with the REAL engine
 * that a one-turn kill exists: Down,Down,Down,Left. This probe asks whether the
 * shipped planner (100 ms main budget, identity clock, sidecar + guard exactly
 * as production) now finds it.
 *
 * Emits PPC-P1-CLOSURE-01/_raw/hv14_t4_planner.json.
 */
import { test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createEngineRuleSet, endTurn } from '../../src/game/engine';
import type { GameEngineState } from '../../src/game/engine';
import { GamePhase, PieceType } from '../../src/game/types';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { applyNoMoveLoss } from '../../src/game/rules/mobility';
import { planHardCatTurn } from '../../src/game/ai/hardTurnPlanner';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { DEFAULT_SEARCH_CONFIG } from '../../src/game/ai/searchConfig';

const OUT = new URL('../_raw/hv14_t4_planner.json', import.meta.url);
const LOG = new URL('../../ai-training/human-logs/PPC-HV14/GAME3_H1.txt', import.meta.url);
const rules = createEngineRuleSet();
const nm = (a: SearchAction): string =>
  a.type === 'catStep' ? a.direction!.key!.replace('Arrow', '') : a.type === 'catPlaceTrap' ? 'T' : a.type;

function rootState(turn: number): GameEngineState {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  const idx = starts.findIndex((s) => Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]) === turn);
  const block = lines.slice(starts[idx], idx + 1 < starts.length ? starts[idx + 1] : lines.length);
  const snapLine = block.find((l) => l.startsWith('SNAPSHOT_JSON='))!;
  return restoreHardRoot(JSON.parse(snapLine.slice('SNAPSHOT_JSON='.length)) as HardRootSnapshot);
}

test('P3-C GAME3 T4 — current production planner decision', () => {
  const root = rootState(4);
  const t = planHardCatTurn(root, {
    rules,
    timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
    maxDepthTurns: 4,
    maxNodes: 500_000,
    leafEvaluator: evaluateCorrectedHoleForCat,
  });

  const plan = t.plan.map(nm);
  // Execute the produced plan with the REAL engine and report the outcome.
  let cur = root;
  const trail: unknown[] = [];
  for (const a of t.plan) {
    if (a.type === 'catPlaceTrap') {
      cur = rules.catPlaceTrap(cur);
      trail.push({ step: 'T', cat: `${cur.catPosition.r},${cur.catPosition.c}`, phase: cur.phase });
      continue;
    }
    const next = rules.catMove(cur, a.direction!);
    if (next === cur) { trail.push({ step: nm(a), result: 'ILLEGAL' }); break; }
    cur = applyNoMoveLoss(next);
    if (cur.phase === GamePhase.Playing && cur.currentPlayer === PieceType.Cat && cur.catMovesLeft <= 0) {
      cur = applyNoMoveLoss(endTurn(cur));
    }
    trail.push({
      step: nm(a),
      cat: `${cur.catPosition.r},${cur.catPosition.c}`,
      mouse: `${cur.mousePosition.r},${cur.mousePosition.c}`,
      phase: cur.phase,
      player: cur.currentPlayer,
    });
    if (cur.phase !== GamePhase.Playing) break;
  }

  const out = {
    loggedPlan: 'Down,Right,Right,Right',
    loggedValue: -1052.9473684210527,
    loggedMate: null,
    loggedCompletedDepth: 2,
    budgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
    currentPlan: plan,
    currentBestAction: t.bestAction ? nm(t.bestAction) : null,
    currentValue: t.search.value,
    currentMate: t.search.mate,
    currentCompletedDepth: t.completedDepth,
    currentAttemptedDepth: t.attemptedDepth,
    deadlineFired: t.deadlineFired,
    budgetFired: t.budgetFired,
    elapsedMs: t.elapsedMs,
    nodes: t.search.diagnostics.nodes,
    planEndsGame: cur.phase !== GamePhase.Playing,
    planOutcome: cur.phase,
    replayTrail: trail,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
}, 300_000);
