/// <reference types="node" />
/**
 * PPC-P1-TIME-01 — BOUNDED real-turn timing DIAGNOSTIC.
 *
 * NOT an authority and NOT a benchmark: it exists to answer "how long does one
 * real Hard cat turn take now, and how many times does it plan?", on the 24
 * frozen human roots at production settings, single process, serial.
 *
 * What it can prove: the per-turn shape (planner calls, fallback presence,
 * wall time) after the fix.
 * What it CANNOT prove: compliance with an absolute-deadline gate — that
 * manifest does not exist in the repo (ABSOLUTE_DEADLINE_GATE = BLOCKED).
 *
 * One fresh-ish turn per root, one process, no repetitions loop, no parallelism:
 * this is deliberately far below any heavy-benchmark threshold.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { computeCatAiTrajectory, type GameEngineState } from '../../src/game/engine';
import { HARD_PROGRESS_GUARD_CONFIG, HARD_TRIAL } from '../../src/game/ai/searchConfig';

const H = vi.hoisted(() => ({ calls: [] as number[] }));

vi.mock('../../src/game/ai/hardTurnPlanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/game/ai/hardTurnPlanner')>();
  return {
    ...actual,
    planHardCatTurn: (state: any, opts: any) => {
      H.calls.push(1);
      return actual.planHardCatTurn(state, opts);
    },
  };
});

const ROOTS = new URL('../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', import.meta.url);
const OUT = new URL('../TIMING_RESULTS.json', import.meta.url);

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

describe('PPC-P1-TIME-01 real-turn timing (diagnostic)', () => {
  it('measures one real Hard turn per frozen root', () => {
    const raw = JSON.parse(readFileSync(ROOTS, 'utf8')) as Array<{ id: string; state: unknown }>;
    const rows: Array<Record<string, unknown>> = [];

    for (const rec of raw) {
      const root: GameEngineState = restoreHardRoot(rec.state as never);
      H.calls.length = 0;
      const t0 = performance.now();
      const trajectory = computeCatAiTrajectory(root);
      const wallMs = performance.now() - t0;

      const last = trajectory?.at(-1)?.state;
      const debug = last?.lastHardSearch;
      const logs = (last?.catActionLog ?? []).filter((l: string) => l.includes('SEARCH_FALLBACK'));
      rows.push({
        id: rec.id,
        catMovesLeftAtRoot: root.catMovesLeft,
        plannerInvocations: H.calls.length,
        turnWallMs: Number(wallMs.toFixed(2)),
        steps: trajectory?.length ?? 0,
        movesSpent: root.catMovesLeft - (last?.catMovesLeft ?? root.catMovesLeft),
        fallbackLogged: logs.length > 0,
        fallbackReasons: logs.map((l: string) => (l.match(/reason=(\w+)/) ?? [])[1] ?? '?'),
        searchElapsedMs: debug?.elapsedMs ?? null,
        searchNodes: debug?.nodes ?? null,
        completedDepth: debug?.completedDepth ?? null,
        finalPhase: last?.phase ?? null,
      });
    }

    const walls = rows.map((r) => r.turnWallMs as number).sort((a, b) => a - b);
    const summary = {
      n: walls.length,
      p50: Number(quantile(walls, 0.5).toFixed(2)),
      p95: Number(quantile(walls, 0.95).toFixed(2)),
      p99: Number(quantile(walls, 0.99).toFixed(2)),
      max: Number(walls[walls.length - 1].toFixed(2)),
      min: Number(walls[0].toFixed(2)),
      plannerInvocationsMax: Math.max(...rows.map((r) => r.plannerInvocations as number)),
      turnsWithFallback: rows.filter((r) => r.fallbackLogged).length,
      turnsWithMoreThanOnePlan: rows.filter((r) => (r.plannerInvocations as number) > 1).length,
    };

    writeFileSync(OUT, JSON.stringify({
      protocol: 'DIAGNOSTIC_ONLY — 1 real turn per frozen root, single process, serial, no repetitions loop, no parallelism. NOT a pre-registered protocol and NOT an absolute-deadline authority.',
      machine: {
        os: 'Windows',
        ram_gb: 16,
        runtime: process.version,
        runner: 'vitest (node env)',
      },
      productionSettings: {
        mainSearchBudgetMs: 100,
        totalTurnBudgetMs: HARD_TRIAL.totalTurnBudgetMs,
        refutationEnabled: HARD_TRIAL.refutationEnabled,
        progressGuardEnabled: HARD_PROGRESS_GUARD_CONFIG.enabled,
      },
      caveat: 'Per-turn wall includes rule simulation and sidecar work, not just the search. A turn is NOT bounded by 150 ms physically: the deadline is a SOFT stop sampled every 64 interior nodes, and nothing preempts a synchronous region.',
      summary,
      rows,
    }, null, 2));

    console.log('PPC_TIME_TIMING', JSON.stringify(summary));
    expect(rows).toHaveLength(24);
    expect(summary.plannerInvocationsMax).toBe(1);
  });
});
