/// <reference types="node" />
/**
 * PPC-P1-TIME-01 — Hard cat turn: ONE absolute deadline per turn (engine level).
 *
 * The planner-level file (`hardTurnAbsoluteDeadline.test.ts`) proves the
 * identity is honoured once a window is handed in. THIS file proves the turn
 * entry point is the thing that hands it in, and that the fallback ladder can no
 * longer mint a second one — driven through the REAL
 * `computeCatAiTrajectory`, the REAL executor and the REAL rules.
 *
 * The planner is mocked ONLY to observe its arguments (call count, the identity
 * it received). `mode: 'real'` delegates to the production planner, and the
 * movement / adjudication below is always the production code path — this is
 * not a simulation of the game.
 *
 * Gates covered (task §8):
 *   TIME-3  complete / truncated(shorter plan = "short") / empty / invalid plan:
 *           every planner call of the turn shares ONE absolute pair
 *           (`NO_DEADLINE_REGRANT`), while the invocation ladder itself is
 *           unchanged from the pre-fix witness (1 / 4 / 5 / 5).
 *   TIME-2  (engine half) a turn whose main window is already closed calls the
 *           planner exactly ONCE and finishes its moves on the cheap heuristic.
 *   TIME-5  real-rule replay: every executed step is a legal cat transition,
 *           `catBaseMoves` is configurable, and a zero-cost trap action is not
 *           mistaken for a stuck cat.
 */
import { describe, it, expect, vi } from 'vitest';
import { CellType, GamePhase, PieceType } from '../../types';
import { DEFAULT_CONFIG, validateGameConfig, type GameConfig } from '../../config';
import { createGameState } from '../../newGame';
import { catAiMove, computeCatAiTrajectory, type GameEngineState } from '../../engine';
import { makeTurnDeadlineIdentity } from '../deadlineContext';
import type { SearchAction } from '../searchTypes';

/**
 * Pre-fix invocation ladder, measured on this exact scenario and frozen in
 * `PPC-P1-TIME-01/fixtures/ppcTime01-baseline-fallback-reentry.json`
 * (plannerInvocations = 1 / 4 / 5 / 5). Kept here so the post-fix run proves the
 * CONTROL FLOW did not change — only the budget ownership did.
 */
const PREFIX_INVOCATIONS: Record<string, number> = {
  complete: 1, truncated: 4, empty: 5, invalid: 5,
};

const H = vi.hoisted(() => ({
  mode: 'real' as 'real' | 'complete' | 'truncated' | 'empty' | 'invalid' | 'trap',
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../hardTurnPlanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hardTurnPlanner')>();
  const down = { type: 'catStep', direction: { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' } };
  const left = { type: 'catStep', direction: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' } };
  const trap = { type: 'catPlaceTrap' };
  return {
    ...actual,
    planHardCatTurn: (state: GameEngineState, opts: any) => {
      // Record FIRST, in every mode: the observation is the argument the real
      // planner would have received, not a synthetic one.
      const firstCall = H.calls.length === 0;
      H.calls.push({
        call: H.calls.length + 1,
        catMovesLeft: state.catMovesLeft,
        nominalMainBudgetMs: opts.timeBudgetMs,
        receivedTurnIdentity: opts.turnDeadline !== undefined,
        inheritedMainDeadlineMs: opts.turnDeadline?.mainSearchDeadlineAtMs ?? null,
        inheritedTotalDeadlineMs: opts.turnDeadline?.totalTurnDeadlineAtMs ?? null,
        inheritedStartedAtMs: opts.turnDeadline?.startedAtMs ?? null,
        wouldBeOwnMainDeadlineMs: opts.turnDeadline
          ? null
          : (opts.now?.() ?? 0) + opts.timeBudgetMs,
      });
      if (H.mode === 'real') return actual.planHardCatTurn(state, opts);

      let plan: SearchAction[] = [down as unknown as SearchAction];
      if (firstCall) {
        if (H.mode === 'complete') {
          plan = Array.from({ length: state.catMovesLeft }, () => down as unknown as SearchAction);
        } else if (H.mode === 'empty') {
          plan = [];
        } else if (H.mode === 'invalid') {
          plan = [left as unknown as SearchAction];
        } else if (H.mode === 'trap') {
          plan = [trap as unknown as SearchAction];
        }
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

/** 7x7 corridor map — the same explicit layout the pre-fix witness used, so the
 *  planner-call ladder is directly comparable. */
function scenarioConfig(overrides: Partial<GameConfig> = {}): GameConfig {
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
    ...overrides,
  } as GameConfig;
}

function catTurnRoot(cfg: GameConfig): GameEngineState {
  const opening = createGameState(cfg);
  expect(opening.status.kind).toBe('explicit');
  expect(opening.state).not.toBeNull();
  return { ...opening.state!, currentPlayer: PieceType.Cat };
}

function fallbackLogs(s: GameEngineState | undefined): string[] {
  return (s?.catActionLog ?? []).filter((line: string) => line.includes('SEARCH_FALLBACK'));
}

describe('PPC-P1-TIME-01 engine: the turn entry point owns the only window', () => {
  // -------------------------------------------------------------------------
  describe('TIME-3 — four fallback kinds share ONE absolute pair', () => {
    it('complete / short / empty / invalid all inherit a single turn deadline', () => {
      const cfg = scenarioConfig();
      expect(validateGameConfig(cfg).ok).toBe(true);

      for (const mode of ['complete', 'truncated', 'empty', 'invalid'] as const) {
        H.mode = mode;
        H.calls.length = 0;
        // A stepping clock that stays inside the turn's 150 ms: nothing here is
        // allowed to expire, so a call that re-mints its own window is visible
        // purely as a DIFFERENT absolute deadline, not as a timing artefact.
        let t = 1000;
        const now = () => (t += 1);
        const trajectory = computeCatAiTrajectory(catTurnRoot(cfg), now);
        expect(trajectory, `${mode}: trajectory`).not.toBeNull();

        const calls = H.calls;
        expect(calls.length, `${mode}: planner invocation ladder is unchanged`)
          .toBe(PREFIX_INVOCATIONS[mode]);

        // Every single call received the turn identity (pre-fix: none did).
        expect(calls.every((c) => c.receivedTurnIdentity), `${mode}: identity on every call`).toBe(true);

        // NO_DEADLINE_REGRANT: one start instant, one main deadline, one total
        // deadline for the whole turn — no matter how many calls the fallback
        // ladder makes.
        expect(new Set(calls.map((c) => c.inheritedStartedAtMs)).size, `${mode}: one turn start`).toBe(1);
        expect(new Set(calls.map((c) => c.inheritedMainDeadlineMs)).size, `${mode}: one main deadline`).toBe(1);
        expect(new Set(calls.map((c) => c.inheritedTotalDeadlineMs)).size, `${mode}: one total deadline`).toBe(1);

        // And the numbers are the turn's: start + 100 / start + 150.
        const start = calls[0].inheritedStartedAtMs as number;
        expect(calls[0].inheritedMainDeadlineMs).toBe(start + 100);
        expect(calls[0].inheritedTotalDeadlineMs).toBe(start + 150);

        // A re-granted window would have been strictly later each call.
        expect(calls.some((c) => c.wouldBeOwnMainDeadlineMs !== null), `${mode}: no self-minted window`)
          .toBe(false);
      }
    });

    it('the empty-plan fallback still ends the turn legitimately (not a stuck cat)', () => {
      H.mode = 'empty';
      H.calls.length = 0;
      const trajectory = computeCatAiTrajectory(catTurnRoot(scenarioConfig()), () => 1000);
      expect(trajectory).not.toBeNull();
      const last = trajectory!.at(-1)!.state;
      // The cat spent its moves (heuristic) instead of freezing or dying.
      expect(last.catMovesLeft).toBe(0);
      expect(last.phase).toBe(GamePhase.Playing);
      expect(fallbackLogs(last).some((l) => l.includes('no_hard_plan'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('TIME-2 — a closed main window ends the searching, not the turn', () => {
    it('calls the planner exactly once when the turn’s main window is already spent', () => {
      H.mode = 'real'; // production planner: this is the behaviour that matters
      H.calls.length = 0;

      // Every clock read advances 200 ms, so the very first sampling of the
      // 100 ms main window already finds it closed. Pre-fix this scenario gave
      // the planner a brand-new `now() + 100` on each of the 4 fallback steps.
      let t = 1000;
      const burned = () => (t += 200);
      const trajectory = computeCatAiTrajectory(catTurnRoot(scenarioConfig()), burned);

      expect(trajectory).not.toBeNull();
      // ONE planning attempt for the turn — not one per remaining cat move.
      // This is the whole point: if the closed window were not honoured,
      // `catAiMove` would re-enter the planner on every remaining move.
      expect(H.calls.length).toBe(1);

      const last = trajectory!.at(-1)!.state;
      // The turn's moves were still spent, and the game is still running: an AI
      // that ran out of time is not a cat that has no legal move (RULE-A).
      expect(last.catMovesLeft).toBe(0);
      expect(last.phase).toBe(GamePhase.Playing);
      expect(fallbackLogs(last).some((l) => l.includes('no_hard_plan'))).toBe(true);
    });

    it('catAiMove with a closed window never reaches the planner', () => {
      H.mode = 'real';

      const root = catTurnRoot(scenarioConfig());

      // Closed: the main window was consumed by the turn's first plan.
      H.calls.length = 0;
      const closedIdentity = makeTurnDeadlineIdentity(1000, 100, 150, () => 1200);
      const closed = catAiMove(root, closedIdentity);
      expect(H.calls.length, 'closed window ⇒ zero planner calls').toBe(0);
      // The legacy heuristic may itself decline (pre-existing behaviour); what
      // matters is that declining is NOT a search and NOT a rules verdict.
      expect(closed === null || closed.phase === GamePhase.Playing).toBe(true);

      // Open: the same call, same state, is allowed to spend the remainder.
      H.calls.length = 0;
      const openIdentity = makeTurnDeadlineIdentity(1000, 100, 150, () => 1050);
      catAiMove(root, openIdentity);
      expect(H.calls.length, 'open window ⇒ the planner is reachable again').toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('TIME-5 — real rules still produce a legal turn', () => {
    function assertLegalTurn(
      trajectory: NonNullable<ReturnType<typeof computeCatAiTrajectory>>,
      rootState: GameEngineState,
    ) {
      expect(trajectory.length).toBeGreaterThan(0);
      for (let i = 0; i < trajectory.length; i++) {
        // `steps` starts at the FIRST action, not at the root state, so the
        // predecessor of step 0 is the root itself.
        const prev = i === 0 ? rootState : trajectory[i - 1].state;
        const next = trajectory[i].state;
        const stayed = next.catPosition.r === prev.catPosition.r
          && next.catPosition.c === prev.catPosition.c;

        if (stayed) {
          // A legal zero-cost action (trap place / reclaim) — allowed to keep
          // the move count, but the trap bookkeeping MUST have changed.
          expect(next.catMovesLeft, `step ${i}: zero-cost action keeps moves`).toBe(prev.catMovesLeft);
          const trapChanged =
            prev.trapPosition?.r !== next.trapPosition?.r
            || prev.trapPosition?.c !== next.trapPosition?.c
            || prev.catTrapsRemaining !== next.catTrapsRemaining;
          expect(trapChanged, `step ${i}: stationary step must be a trap action`).toBe(true);
        } else {
          // Exactly one orthogonal step, exactly one move spent.
          const dr = Math.abs(next.catPosition.r - prev.catPosition.r);
          const dc = Math.abs(next.catPosition.c - prev.catPosition.c);
          expect(dr + dc, `step ${i}: one orthogonal step`).toBe(1);
          expect(next.catMovesLeft, `step ${i}: one move spent`).toBe(prev.catMovesLeft - 1);
        }
        expect(next.catMovesLeft).toBeGreaterThanOrEqual(0);
      }
    }

    it('a normal Hard turn spends exactly catBaseMoves (4)', () => {
      H.mode = 'real';
      const root = catTurnRoot(scenarioConfig());
      const trajectory = computeCatAiTrajectory(root);
      expect(trajectory).not.toBeNull();
      assertLegalTurn(trajectory!, root);
      const last = trajectory!.at(-1)!.state;
      expect(root.catMovesLeft - last.catMovesLeft).toBe(4);
      expect(last.phase).toBe(GamePhase.Playing);
    });

    it('catBaseMoves is configurable — 6 is not truncated to 4', () => {
      H.mode = 'real';
      const cfg = scenarioConfig({ catBaseMoves: 6 });
      expect(validateGameConfig(cfg).ok).toBe(true);
      const root = catTurnRoot(cfg);
      expect(root.catMovesLeft).toBe(6);
      const trajectory = computeCatAiTrajectory(root);
      expect(trajectory).not.toBeNull();
      assertLegalTurn(trajectory!, root);
      expect(root.catMovesLeft - trajectory!.at(-1)!.state.catMovesLeft).toBe(6);
    });

    it('placing a trap costs no move and keeps the turn alive', () => {
      H.mode = 'trap';
      H.calls.length = 0;
      const root = catTurnRoot(scenarioConfig());
      expect(root.catTrapsRemaining).toBeGreaterThan(0);
      expect(root.trapPosition).toBeNull();

      const trajectory = computeCatAiTrajectory(root);
      expect(trajectory).not.toBeNull();
      // Step 0 places the trap without spending a move…
      expect(trajectory![0].detail).toBe('放置陷阱');
      const afterTrap = trajectory![0].state;
      expect(afterTrap.trapPosition).not.toBeNull();
      expect(afterTrap.catMovesLeft).toBe(root.catMovesLeft);
      expect(afterTrap.catTrapsRemaining).toBe(root.catTrapsRemaining - 1);
      // …and the turn continues afterwards: the cat still finishes its moves.
      // (A zero-cost action must NOT be read as "the cat is stuck".)
      const last = trajectory!.at(-1)!.state;
      expect(last.catMovesLeft).toBe(0);
      assertLegalTurn(trajectory!, root);
    });

    it('the turn never teleports the cat onto an unreachable cell', () => {
      H.mode = 'real';
      const root = catTurnRoot(scenarioConfig());
      const trajectory = computeCatAiTrajectory(root);
      for (const step of trajectory!) {
        expect(step.state.board[step.state.catPosition.r][step.state.catPosition.c].type)
          .toBe(CellType.Empty);
      }
    });

    it('capturing the mouse mid-turn ends the game legally, without extra moves', () => {
      H.mode = 'real';
      // Cat one step away from the mouse: the capture happens on step 1 and the
      // turn must stop there (the remaining 3 moves are not spent).
      const cfg = scenarioConfig({
        catStart: { r: 4, c: 4 }, mouseStart: { r: 4, c: 5 },
      });
      const root = catTurnRoot(cfg);
      expect(root.catMovesLeft).toBe(4);
      const trajectory = computeCatAiTrajectory(root);
      expect(trajectory).not.toBeNull();
      const last = trajectory!.at(-1)!.state;
      expect(last.phase).toBe(GamePhase.CatWins);
      expect(trajectory!.length).toBeLessThanOrEqual(2);
      // The clock window was irrelevant to the outcome: a rules win is a rules win.
      expect(last.catPosition).toEqual(root.mousePosition);
    });
  });

  // -------------------------------------------------------------------------
  describe('TIME-7 — the identity never leaks into the state', () => {
    it('a full turn leaves no deadline artefact in the serialized state', () => {
      H.mode = 'real';
      const trajectory = computeCatAiTrajectory(catTurnRoot(scenarioConfig()));
      const serialized = JSON.stringify(trajectory!.at(-1)!.state);
      expect(serialized).not.toContain('mainSearchDeadlineAtMs');
      expect(serialized).not.toContain('totalTurnDeadlineAtMs');
      expect(serialized).not.toContain('startedAtMs');
    });

    it('two consecutive turns mint two independent windows', () => {
      H.mode = 'complete';
      H.calls.length = 0;
      const cfg = scenarioConfig();
      const now = () => 1000;
      computeCatAiTrajectory(catTurnRoot(cfg), now);
      const firstStart = H.calls[0].inheritedStartedAtMs;
      H.calls.length = 0;
      computeCatAiTrajectory(catTurnRoot(cfg), () => 5000);
      expect(H.calls[0].inheritedStartedAtMs).toBe(5000);
      expect(H.calls[0].inheritedStartedAtMs).not.toBe(firstStart);
    });
  });
});

