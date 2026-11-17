/// <reference types="node" />
/**
 * PPC-P1-TIME-01 — PRE-FIX baseline capture.
 *
 * Runs against the CURRENT working tree (P1-ID candidate, unfixed deadline
 * plumbing) and freezes two witnesses so the post-fix run can be compared:
 *
 *   A. `fallbackPlannerReentry` — the four fallback scenarios driven through the
 *      REAL `computeCatAiTrajectory` with ONLY the planner replaced by a
 *      recording stub (same construction as
 *      PPC-NEXTGEN-01/research/search-audit/fallback_callgraph_probe.mts).
 *      Records, per planner call, the budget arguments it received and whether
 *      it received any absolute deadline at all.
 *
 *   B. `plannerFixedD1` — the 24 frozen human roots through the REAL
 *      `planHardCatTurn` on a FROZEN clock at fixed D1 (maxNodes 10000), which
 *      is deterministic and therefore directly comparable before/after.
 *
 * This file is a research artifact, NOT part of the shipped test suite, and it
 * refuses to overwrite an existing witness unless PPC_P1_TIME_FORCE=1.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_CONFIG, validateGameConfig, type GameConfig } from '../../src/game/config';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../src/game/types';
import { createGameState } from '../../src/game/newGame';
import { computeCatAiTrajectory, type GameEngineState } from '../../src/game/engine';
import { planHardCatTurn } from '../../src/game/ai/hardTurnPlanner';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { createEngineRuleSet } from '../../src/game/engine';
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
      const wallMs = performance.now();
      H.calls.push({
        call: H.calls.length + 1,
        catMovesLeft: state.catMovesLeft,
        catPosition: { ...state.catPosition },
        nominalMainBudgetMs: opts.timeBudgetMs,
        totalTurnBudgetMs: opts.refutation?.totalTurnBudgetMs,
        receivedAbsoluteDeadline: 'turnDeadline' in opts && opts.turnDeadline !== undefined,
        inheritedMainDeadlineMs: opts.turnDeadline?.mainSearchDeadlineAtMs ?? null,
        inheritedTotalDeadlineMs: opts.turnDeadline?.totalTurnDeadlineAtMs ?? null,
        // The instant this call's own `now()` would have produced. A planner
        // that mints its OWN window gets `wouldBeMainDeadlineMs` per call; a
        // planner that inherits the turn window gets one shared absolute value.
        wouldBeMainDeadlineMs: wallMs + opts.timeBudgetMs,
        wouldBeTotalDeadlineMs: wallMs + (opts.refutation?.totalTurnBudgetMs ?? 0),
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

const DIR: Record<string, Direction> = {
  U: DIRECTIONS.find((d) => d.key === 'ArrowUp')!,
  D: DIRECTIONS.find((d) => d.key === 'ArrowDown')!,
  L: DIRECTIONS.find((d) => d.key === 'ArrowLeft')!,
  R: DIRECTIONS.find((d) => d.key === 'ArrowRight')!,
};
void DIR;

function label(a: SearchAction | null): string {
  if (a === null) return 'NULL';
  if (a.type === 'catStep') return a.direction.key.slice(5)[0];
  if (a.type === 'catPlaceTrap') return 'T';
  return a.type;
}

/** 7x7 corridor map from the NEXTGEN search-audit probe (explicit layout). */
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

const FIXTURE = new URL('../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', import.meta.url);
const OUT_REENTRY = new URL('../fixtures/ppcTime01-baseline-fallback-reentry.json', import.meta.url);
const OUT_PLANNER = new URL('../../src/game/ai/__tests__/fixtures/ppcTime01-baseline-planner.json', import.meta.url);
const FORCE = process.env.PPC_P1_TIME_FORCE === '1';

function guardOverwrite(url: URL): void {
  if (existsSync(url) && !FORCE) {
    throw new Error(`refusing to overwrite frozen baseline ${url.pathname} (set PPC_P1_TIME_FORCE=1 to replace)`);
  }
}

interface RootRecord { id: string; file: string; turn: number; state: unknown }

describe('PPC-P1-TIME-01 pre-fix baseline', () => {
  it('captures fallback planner re-entry (stub planner, real trajectory)', () => {
    const cfg = scenarioConfig();
    expect(validateGameConfig(cfg).ok).toBe(true);
    const rules = createEngineRuleSet();
    void rules;
    const opening = createGameState(cfg);
    expect(opening.status.kind).toBe('explicit');
    expect(opening.state).not.toBeNull();

    const scenarios: Array<'complete' | 'truncated' | 'empty' | 'invalid'> =
      ['complete', 'truncated', 'empty', 'invalid'];
    const rows = scenarios.map((scenario) => {
      H.mode = scenario;
      H.calls.length = 0;
      const root: GameEngineState = { ...opening.state!, currentPlayer: PieceType.Cat };
      const trajectory = computeCatAiTrajectory(root);
      const calls = JSON.parse(JSON.stringify(H.calls)) as Record<string, any>[];
      const last = trajectory?.at(-1)?.state;
      return {
        scenario,
        plannerInvocations: calls.length,
        calls,
        executedSteps: trajectory?.length ?? 0,
        remainingCatMoves: last?.catMovesLeft ?? null,
        finalPhase: last?.phase ?? null,
        finalCurrentPlayer: last?.currentPlayer ?? null,
        fallbackLogs: (last?.catActionLog ?? []).filter((s: string) => s.includes('SEARCH_FALLBACK')),
        distinctWouldBeMainDeadlines: new Set(calls.map((c) => c.wouldBeMainDeadlineMs)).size,
      };
    });

    guardOverwrite(OUT_REENTRY);
    writeFileSync(OUT_REENTRY, JSON.stringify({
      sourceGitSha: '48eaac6c4f3801d351787696ba5876995b64e8d8',
      capturedOn: 'pre-fix (P1-ID candidate tree, no shared turn deadline)',
      evidenceClass: 'EXPERIMENT_MEASURED_CONTROL_FLOW_WITH_STUB',
      realSearchesExecuted: 0,
      scope: 'Real computeCatAiTrajectory routing + real movement/adjudication; only planHardCatTurn replaced. Demonstrates planner invocation count and the budget arguments each call received, not wall-clock latency.',
      rows,
    }, null, 2));

    expect(rows).toHaveLength(4);
    console.log('PPC_TIME_REENTRY', JSON.stringify(rows.map((r) => [r.scenario, r.plannerInvocations, r.distinctWouldBeMainDeadlines])));
  });

  it('captures 24-root planner fixed-D1 witness (frozen clock)', () => {
    H.mode = 'real';
    const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RootRecord[];
    expect(raw).toHaveLength(24);
    const rules = createEngineRuleSet();
    const frozenNow = () => 1000;

    const records = raw.map((rec) => {
      const state = restoreHardRoot(rec.state as never);
      const plan = planHardCatTurn(state, {
        rules,
        timeBudgetMs: 100_000,
        maxDepthTurns: 1,
        maxNodes: 10_000,
        now: frozenNow,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: false },
      });
      return {
        id: rec.id,
        completed: plan.hasSolution,
        value: plan.search.value,
        mate: plan.search.mate,
        completedDepth: plan.completedDepth,
        attemptedDepth: plan.attemptedDepth,
        deadlineFired: plan.deadlineFired,
        budgetFired: plan.budgetFired,
        plan: plan.plan.map(label),
        bestAction: label(plan.bestAction),
        planStatus: plan.debug.planStatus,
        rootActions: plan.search.rootActions.map((r) => ({
          action: label(r.action), value: r.value, mate: r.mate, bound: r.bound,
        })),
        nodes: plan.search.diagnostics.totalNodes,
        ttHits: plan.search.diagnostics.ttHits,
        ttExactHits: plan.search.diagnostics.ttExactHits,
        alphaBetaCutoffs: plan.search.diagnostics.alphaBetaCutoffs,
        orderedNodes: plan.search.diagnostics.orderedNodes,
        phase: state.phase,
      };
    });

    guardOverwrite(OUT_PLANNER);
    writeFileSync(OUT_PLANNER, `${JSON.stringify({
      sourceGitSha: '48eaac6c4f3801d351787696ba5876995b64e8d8',
      capturedOn: 'pre-fix (P1-ID candidate tree, no shared turn deadline)',
      protocol: {
        depthTurns: 1, maxNodes: 10000, clock: 'frozen at 1000ms', timeBudgetMs: 100000,
        leafEvaluator: 'evaluateCorrectedHoleForCat', refutation: 'disabled',
        note: 'Frozen clock makes the wall-clock deadline non-binding, so this witness is deterministic.',
      },
      records,
    }, null, 2)}\n`);

    const incomplete = records.filter((r) => !r.completed);
    console.log('PPC_TIME_PLANNER', `roots=${records.length} incomplete=${incomplete.length}`);
    expect(records.every((r) => r.phase === GamePhase.Playing)).toBe(true);
  });
});
