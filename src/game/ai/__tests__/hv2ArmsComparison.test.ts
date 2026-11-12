/// <reference types="node" />
/**
 * PPC-HV-2 §5 — controlled same-root comparison on the four fixed human roots.
 *
 * Arms, all serial, all on the SAME restored snapshot and the SAME production
 * budgets (100ms main search, 150ms total turn, refutation sidecar as shipped):
 *   BASELINE  = leaf evaluateForCat                (what the human games played)
 *   H1        = leaf evaluateCorrectedHoleForCat   (existing production flag,
 *                                                 hole sign corrected only)
 *   LEGACY    = the `medium` dispatch target catAiHard, reached by cloning the
 *                                                 board and flipping ONLY
 *                                                 config.difficulty to 'medium'
 *                                                 (engine.ts:3841 fall-through)
 * Printed, not asserted: this is the comparison table, and every arm records
 * whether it fell back. Known caveat: the 100ms wall clock makes a small
 * fraction of root decisions flip between re-runs, so BASELINE here is compared
 * against the LOGGED plan, not assumed equal to it.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import type { GameEngineState } from '../../engine';
import { catMove, catPlaceTrap, catAiMove, createEngineRuleSet } from '../../engine';
import { GamePhase, PieceType } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { evaluateForCat, evaluateForCatDetailed } from '../evaluation';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { planHardCatTurn } from '../hardTurnPlanner';
import { DEFAULT_SEARCH_CONFIG, HARD_TRIAL } from '../searchConfig';
import { stateKey } from '../transposition';
import type { SearchAction } from '../searchTypes';

interface PinnedRoot { id: string; stateKey: string; snapshot: HardRootSnapshot; loggedPlan: string }

function loadPinned(): PinnedRoot[] {
  const raw = readFileSync(
    new URL('../../../../ai-training/human-logs/PPC-HV2/roots.json', import.meta.url),
    'utf8',
  ) as string;
  return JSON.parse(raw) as PinnedRoot[];
}

const rules = createEngineRuleSet();

function token(a: SearchAction): string {
  if (a.type === 'catPlaceTrap') return 'Trap';
  if (a.type === 'catStep') return a.direction.key.replace('Arrow', '').slice(0, 1);
  return '?';
}

/** Execute a cat plan for the rest of the turn with the REAL engine moves. */
function executeTurn(start: GameEngineState, actions: SearchAction[]): { end: GameEngineState; path: string[] } {
  let s = start;
  const path: string[] = [`${s.catPosition.r},${s.catPosition.c}`];
  for (const a of actions) {
    if (s.currentPlayer !== PieceType.Cat || s.phase !== GamePhase.Playing || s.catMovesLeft <= 0) break;
    const next = a.type === 'catPlaceTrap' ? catPlaceTrap(s) : a.type === 'catStep' ? catMove(s, a.direction!) : null;
    if (!next) continue;
    s = next;
    path.push(`${s.catPosition.r},${s.catPosition.c}`);
    // The engine hands the turn over itself when catMovesLeft hits 0.
    if (s.currentPlayer !== PieceType.Cat) break;
  }
  return { end: s, path };
}

function displacement(path: string[]): { net: number; revisits: number } {
  const [r0, c0] = path[0].split(',').map(Number);
  const last = path[path.length - 1].split(',').map(Number);
  // A free trap repeats the current square by design — collapse consecutive
  // duplicates so `revisits` counts squares the cat physically re-entered.
  const collapsed = path.filter((p, i) => i === 0 || p !== path[i - 1]);
  const seen = new Set<string>();
  let revisits = 0;
  for (const p of collapsed) {
    if (seen.has(p)) revisits++;
    seen.add(p);
  }
  return { net: Math.abs(last[0] - r0) + Math.abs(last[1] - c0), revisits };
}

function report(label: string, end: GameEngineState, path: string[], extra: string): void {
  const { net, revisits } = displacement(path);
  const f = evaluateForCatDetailed(end).features;
  console.log(
    `  ${label.padEnd(9)} path=${path.join(' ')} net=${net} revisits=${revisits}`
    + ` trap=${end.trapPosition ? `${end.trapPosition.r},${end.trapPosition.c}` : 'none'}/${end.catTrapsRemaining}`
    + ` leaf=${evaluateForCat(end).toFixed(1)}`
    + ` | end: catMouseDist=${f.catMouseDistance} winRoute=${f.mouseWinRouteDistance} mouseGoal=${f.mouseGoalDistance}`
    + ` mobility(m/c)=${f.mouseMobility}/${f.catMobility} area(m/c)=${f.mouseReachableArea}/${f.catReachableArea}`
    + `\n  ${''.padEnd(9)}${extra}`,
  );
}

test('HV2-S1. BASELINE / H1 / LEGACY on the four fixed roots', () => {
  for (const r of loadPinned()) {
    const root = restoreHardRoot(r.snapshot) as GameEngineState;
    console.log(`\n===== ${r.id}  root=(${root.catPosition.r},${root.catPosition.c}) LOGGED PLAN: ${r.loggedPlan}`);

    for (const [arm, leaf] of [['BASELINE', evaluateForCat], ['H1', evaluateCorrectedHoleForCat]] as const) {
      const plan = planHardCatTurn(root, {
        rules,
        timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
        refutation: { enabled: HARD_TRIAL.refutationEnabled, totalTurnBudgetMs: HARD_TRIAL.totalTurnBudgetMs },
        leafEvaluator: leaf,
      });
      const exec = executeTurn(root, plan.plan);
      const ref = plan.debug.refutation;
      report(
        arm, exec.end, exec.path,
        `plan=${plan.plan.map(token).join('')} depth=${plan.completedDepth}/${plan.attemptedDepth}`
        + ` deadline=${plan.deadlineFired} nodes=${plan.budgetFired} elapsed=${plan.elapsedMs.toFixed(1)}ms`
        + ` hasSolution=${plan.hasSolution} status=${plan.debug.planStatus ?? 'n/a'} mate=${plan.debug.mate ?? 'n/a'}`
        + ` rootValue=${plan.debug.rootValue.toFixed(2)}`
        + ` refutation=${ref ? `${ref.refutationTriggered}/${ref.baselineProbeStatus ?? 'n/a'}/${ref.overrideUsed}/${ref.selectedPlanSource}` : 'off'}`
        + ` rootActions=${plan.debug.rootActions.map((a) => `${token(a.action)}:${a.value.toFixed(2)}(${a.bound ?? 'unknown'})`).join(' ')}`,
      );
    }

    // LEGACY arm: the only change is config.difficulty, which is what routes
    // catAiMove to catAiHard (engine.ts:3841). Steps are taken one engine call
    // at a time, exactly as a medium game does.
    let s: GameEngineState = { ...root, config: { ...root.config, difficulty: 'medium' } };
    const path: string[] = [`${s.catPosition.r},${s.catPosition.c}`];
    const tokens: string[] = [];
    let guard = 0;
    while (s.currentPlayer === PieceType.Cat && s.phase === GamePhase.Playing && s.catMovesLeft > 0 && guard++ < 12) {
      const before = s;
      const next = catAiMove(s);
      if (!next || stateKey(next) === stateKey(before)) {
        console.log(`  LEGACY    STALLED after ${tokens.join('')} (catAiMove returned no progress)`);
        break;
      }
      const moved = next.catPosition.r !== before.catPosition.r || next.catPosition.c !== before.catPosition.c;
      tokens.push(moved ? `${next.catPosition.r},${next.catPosition.c}` : 'Trap');
      s = next;
      path.push(`${s.catPosition.r},${s.catPosition.c}`);
    }
    report('LEGACY', { ...s, config: root.config }, path, `actions=${tokens.join(' ')} catMovesLeft=${s.catMovesLeft}`);
    // The engine only hands the turn over inside the game loop, so an offline
    // walk ends with the moves exhausted; assert the walk consumed the turn.
    expect(s.catMovesLeft === 0 || s.currentPlayer !== PieceType.Cat || s.phase !== GamePhase.Playing, `${r.id} legacy turn consumed`).toBe(true);
  }
  expect(loadPinned().length).toBe(4);
});

// ===========================================================================
// HV2-S2 — is the §5 result an artifact of the 100ms wall clock? The known
// deadline nondeterminism flips a few percent of root decisions between
// re-runs, so each search arm is repeated on the same frozen root and the
// plan/displacement signature is compared.
// ===========================================================================
test('HV2-S2. repeat each search arm three times on the same root', () => {
  for (const r of loadPinned()) {
    const root = restoreHardRoot(r.snapshot) as GameEngineState;
    const out: string[] = [`\n===== ${r.id}  logged=${r.loggedPlan}`];
    for (const [arm, leaf] of [['BASELINE', evaluateForCat], ['H1', evaluateCorrectedHoleForCat]] as const) {
      const sigs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const plan = planHardCatTurn(root, {
          rules,
          timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
          refutation: { enabled: HARD_TRIAL.refutationEnabled, totalTurnBudgetMs: HARD_TRIAL.totalTurnBudgetMs },
          leafEvaluator: leaf,
        });
        const exec = executeTurn(root, plan.plan);
        const d = displacement(exec.path);
        sigs.push(`${plan.plan.map(token).join('')}(net=${d.net},rev=${d.revisits},depth=${plan.completedDepth})`);
      }
      const stable = new Set(sigs).size === 1;
      out.push(`  ${arm.padEnd(9)} ${sigs.join('  |  ')}  ${stable ? 'STABLE' : 'UNSTABLE'}`);
    }
    // Printed measurement only: a deadline flip here is the KNOWN clock
    // nondeterminism, not a gate, so nothing in this test asserts stability.
    console.log(out.join('\n'));
  }
  expect(loadPinned().length).toBe(4);
});
