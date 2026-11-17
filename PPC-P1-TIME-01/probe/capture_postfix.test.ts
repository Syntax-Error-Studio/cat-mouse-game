/// <reference types="node" />
/**
 * PPC-P1-TIME-01 — POST-FIX counterpart of `capture_baseline.test.ts`.
 *
 * IDENTICAL construction to the pre-fix capture (same 7x7 corridor map, same
 * four stub plans, same real `computeCatAiTrajectory` + real executor), so the
 * two JSON files are directly comparable:
 *
 *   fixtures/ppcTime01-baseline-fallback-reentry.json   ← pre-fix  (1 / 4 / 5 / 5)
 *   fixtures/ppcTime01-postfix-fallback-shared.json     ← post-fix (same ladder, ONE window)
 *
 * The only difference recorded per call is the argument the planner actually
 * received: pre-fix every call got `receivedAbsoluteDeadline: false`; post-fix
 * every call gets the SAME two absolute instants.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { DEFAULT_CONFIG, validateGameConfig, type GameConfig } from '../../src/game/config';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../src/game/types';
import { createGameState } from '../../src/game/newGame';
import { computeCatAiTrajectory, type GameEngineState } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';

const H = vi.hoisted(() => ({
  mode: 'real' as 'real' | 'complete' | 'truncated' | 'empty' | 'invalid',
  calls: [] as Record<string, unknown>[],
}));

vi.mock('../../src/game/ai/hardTurnPlanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/game/ai/hardTurnPlanner')>();
  const down = { type: 'catStep', direction: { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' } };
  const left = { type: 'catStep', direction: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } };
  return {
    ...actual,
    planHardCatTurn: (state: any, opts: any) => {
      if (H.mode === 'real') return actual.planHardCatTurn(state, opts);
      const firstCall = H.calls.length === 0;
      H.calls.push({
        call: H.calls.length + 1,
        catMovesLeft: state.catMovesLeft,
        nominalMainBudgetMs: opts.timeBudgetMs,
        totalTurnBudgetMs: opts.refutation?.totalTurnBudgetMs,
        receivedAbsoluteDeadline: opts.turnDeadline !== undefined,
        inheritedStartedAtMs: opts.turnDeadline?.startedAtMs ?? null,
        inheritedMainDeadlineMs: opts.turnDeadline?.mainSearchDeadlineAtMs ?? null,
        inheritedTotalDeadlineMs: opts.turnDeadline?.totalTurnDeadlineAtMs ?? null,
      });
      let plan: any[] = [down];
      if (firstCall) {
        if (H.mode === 'complete') plan = Array.from({ length: state.catMovesLeft }, () => down);
        else if (H.mode === 'empty') plan = [];
        else if (H.mode === 'invalid') plan = [left];
      }
      const hasSolution = plan.length > 0;
      return {
        plan, bestAction: plan[0] ?? null,
        completedDepth: hasSolution ? 1 : 0, attemptedDepth: 1,
        hasSolution, deadlineFired: !hasSolution, budgetFired: false,
        search: null, elapsedMs: 0,
        debug: {
          cat: { ...state.catPosition }, mouse: { ...state.mousePosition },
          mouseHasButter: false, completedDepth: hasSolution ? 1 : 0,
          attemptedDepth: 1, nodes: 0, elapsedMs: 0, rootValue: 0, mate: null,
          plan, rootActions: [], planStatus: hasSolution ? 'planned' : 'search_incomplete',
        },
      };
    },
  };
});

void DIRECTIONS;
void ((_d: Direction) => undefined);

function label(a: SearchAction | null): string {
  if (a === null) return 'NULL';
  if (a.type === 'catStep') return a.direction.key.slice(5)[0];
  if (a.type === 'catPlaceTrap') return 'T';
  return a.type;
}

function scenarioConfig(): GameConfig {
  const size = 7;
  const terrain = Array.from({ length: size }, () => Array(size).fill(CellType.Wall));
  for (let r = 0; r < size; r++) terrain[r][2] = CellType.Empty;
  for (let r = 4; r < size; r++) for (let c = 4; c < size; c++) terrain[r][c] = CellType.Empty;
  terrain[5][6] = CellType.MouseHole;
  return {
    ...DEFAULT_CONFIG, boardSize: size, catBaseMoves: 4,
    catStart: { r: 1, c: 2 }, mouseStart: { r: 5, c: 5 },
    mouseHole: { r: 5, c: 6, size: 1 },
    boxCount: 0, pileCount: 0, butterCount: 0,
    boxPositions: [], pilePositions: [], butterPositions: [], tunnelCorners: [],
    customTerrain: terrain as never, difficulty: 'hard',
  } as GameConfig;
}

const OUT = new URL('../fixtures/ppcTime01-postfix-fallback-shared.json', import.meta.url);

describe('PPC-P1-TIME-01 post-fix capture', () => {
  it('every fallback step inherits the ONE turn window', () => {
    const cfg = scenarioConfig();
    expect(validateGameConfig(cfg).ok).toBe(true);
    const opening = createGameState(cfg);
    expect(opening.status.kind).toBe('explicit');

    const scenarios: Array<'complete' | 'truncated' | 'empty' | 'invalid'> =
      ['complete', 'truncated', 'empty', 'invalid'];

    const rows = scenarios.map((scenario) => {
      H.mode = scenario;
      H.calls.length = 0;
      // A stepping clock, so a call that minted its own window would be
      // visible as a strictly increasing absolute deadline.
      let t = 1000;
      const now = () => (t += 1);
      const root: GameEngineState = { ...opening.state!, currentPlayer: PieceType.Cat };
      const trajectory = computeCatAiTrajectory(root, now);
      const calls = JSON.parse(JSON.stringify(H.calls)) as Record<string, any>[];
      const last = trajectory?.at(-1)?.state;
      return {
        scenario,
        plannerInvocations: calls.length,
        calls,
        executedSteps: trajectory?.length ?? 0,
        executedPlanLabels: (trajectory ?? []).map((s) => s.detail),
        remainingCatMoves: last?.catMovesLeft ?? null,
        finalPhase: last?.phase ?? null,
        finalCurrentPlayer: last?.currentPlayer ?? null,
        fallbackLogs: (last?.catActionLog ?? []).filter((s: string) => s.includes('SEARCH_FALLBACK')),
        distinctInheritedMainDeadlines: new Set(calls.map((c) => c.inheritedMainDeadlineMs)).size,
        distinctInheritedTotalDeadlines: new Set(calls.map((c) => c.inheritedTotalDeadlineMs)).size,
        distinctInheritedStarts: new Set(calls.map((c) => c.inheritedStartedAtMs)).size,
        allCallsInherited: calls.every((c) => c.receivedAbsoluteDeadline),
      };
    });

    writeFileSync(OUT, JSON.stringify({
      sourceGitSha: '48eaac6c4f3801d351787696ba5876995b64e8d8',
      capturedOn: 'post-fix (PPC-P1-TIME-01 turn deadline identity)',
      evidenceClass: 'EXPERIMENT_MEASURED_CONTROL_FLOW_WITH_STUB',
      realSearchesExecuted: 0,
      scope: 'Identical construction to ppcTime01-baseline-fallback-reentry.json. Only the planner is replaced; routing, execution and adjudication are the production code path.',
      rows,
    }, null, 2));

    for (const r of rows) {
      expect(r.allCallsInherited, `${r.scenario}: identity on every call`).toBe(true);
      expect(r.distinctInheritedMainDeadlines, `${r.scenario}: one main deadline`).toBe(1);
      expect(r.distinctInheritedTotalDeadlines, `${r.scenario}: one total deadline`).toBe(1);
      expect(r.distinctInheritedStarts, `${r.scenario}: one turn start`).toBe(1);
      expect(r.finalPhase).toBe(GamePhase.Playing);
      expect(r.remainingCatMoves).toBe(0);
    }
    console.log('PPC_TIME_POSTFIX', JSON.stringify(rows.map(
      (r) => [r.scenario, r.plannerInvocations, r.distinctInheritedMainDeadlines, r.allCallsInherited])));
    void label;
  });
});
