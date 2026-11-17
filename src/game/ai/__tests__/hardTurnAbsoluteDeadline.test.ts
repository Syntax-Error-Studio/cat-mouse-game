/// <reference types="node" />
/**
 * PPC-P1-TIME-01 — Hard cat turn: ONE absolute deadline per turn (planner level).
 *
 * Defect: `planHardCatTurn` read `now()` at every call and built
 * `deadlineMs = now() + timeBudgetMs` plus a fresh `now() + totalTurnBudgetMs`
 * wall for the sidecar. A cat turn that fell back to the legacy heuristic
 * re-entered the planner once per remaining cat move (`engine.catAiMove`), so a
 * four-move turn could be granted 5 x 100 ms of main search and 5 x 150 ms of
 * turn wall against a 100 / 150 ms per-TURN contract.
 *
 * Fix under test: the cat-turn entry point mints ONE `TurnDeadlineIdentity`
 * (two absolute instants + the turn's clock) and threads it into every planner
 * call of that turn; a call that inherits it never mints a window again.
 *
 * Gates covered here (task §8):
 *   TIME-2  shared time identity: expired main window ⇒ no search at all;
 *           an open but smaller-than-nominal window really bounds the search;
 *           a fallback before the main deadline may still use the remainder
 *   TIME-4  24 frozen human roots, fixed D1 — full-field parity against the
 *           PRE-FIX baseline witness, both with and without an identity
 *   TIME-6  sidecar and Progress Guard receive the turn's total instant
 *   TIME-7  input immutability, per-turn freshness, no serialized deadline
 *   TIME-8  an identity-less call (offline / standalone) is unchanged
 *
 * Not claimed here: real wall-clock compliance of a full turn (that needs the
 * missing absolute-deadline authority manifest), and no strength claim.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEngineRuleSet, type GameEngineState } from '../../engine';
import { GamePhase } from '../../types';
import { planHardCatTurn } from '../hardTurnPlanner';
import { restoreHardRoot } from '../hardHistory';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { makeTurnDeadlineIdentity, monotonicNow } from '../deadlineContext';
import { DEFAULT_SEARCH_CONFIG, HARD_PROGRESS_GUARD_CONFIG, HARD_TRIAL } from '../searchConfig';
import type { SearchAction } from '../searchTypes';

const rules = createEngineRuleSet();

function label(a: SearchAction | null): string {
  if (a === null) return 'NULL';
  if (a.type === 'catStep') return a.direction.key.slice(5)[0];
  if (a.type === 'catPlaceTrap') return 'T';
  return a.type;
}

const ROOT_FIXTURE = new URL('./fixtures/ppcId01-human-roots.json', import.meta.url);
const BASELINE_PLANNER = new URL('./fixtures/ppcTime01-baseline-planner.json', import.meta.url);

interface RootRecord { id: string; file: string; turn: number; state: unknown }

function loadRoots(): RootRecord[] {
  return JSON.parse(readFileSync(ROOT_FIXTURE, 'utf8')) as RootRecord[];
}

function root(i = 0): GameEngineState {
  return restoreHardRoot(loadRoots()[i].state as never);
}

/** The exact planner call the pre-fix witness was captured with. */
function planFixedD1(
  state: GameEngineState,
  now: () => number,
  turnDeadline?: ReturnType<typeof makeTurnDeadlineIdentity>,
) {
  return planHardCatTurn(state, {
    rules,
    timeBudgetMs: 100_000,
    maxDepthTurns: 1,
    maxNodes: 10_000,
    now,
    leafEvaluator: evaluateCorrectedHoleForCat,
    refutation: { enabled: false },
    turnDeadline,
  });
}

function signature(plan: ReturnType<typeof planHardCatTurn>, state: GameEngineState) {
  return {
    // `phase` is part of the frozen witness because a plan must never be
    // produced for a non-playing turn; it is read off the root, not the plan.
    phase: state.phase,
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
  };
}

describe('PPC-P1-TIME-01 planner: one absolute deadline per turn', () => {
  // -------------------------------------------------------------------------
  describe('TIME-2 — the turn identity, not the call, owns the wall', () => {
    it('does not search at all when the turn’s main window has already closed', () => {
      const state = root();
      // Turn began at 1000ms; main window closed at 1100ms; the turn itself is
      // still open until 1150ms.
      const identity = makeTurnDeadlineIdentity(1000, 100, 150, () => 1100);

      const plan = planHardCatTurn(state, {
        rules,
        timeBudgetMs: 100,
        maxDepthTurns: 4,
        maxNodes: 500_000,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: false },
        turnDeadline: identity,
      });

      // No plan — but this is "the AI had no time", NOT "the cat has no legal
      // move" (RULE-A is a rules verdict and never comes from here).
      expect(plan.hasSolution).toBe(false);
      expect(plan.plan).toEqual([]);
      expect(plan.deadlineFired).toBe(true);
      // The root node aborts on entry: essentially zero expansion.
      expect(plan.search.diagnostics.totalNodes).toBeLessThanOrEqual(1);
      expect(plan.completedDepth).toBe(0);

      // Control: the SAME clock, the SAME nominal budget, but no identity — the
      // old behaviour mints `now() + 100 = 1200` and happily searches. This is
      // the exact re-grant the turn identity removes. Held to D1/10k nodes so
      // the control proves "the search was ALLOWED and produced a plan" without
      // paying for a full 4-turn tree (which is minutes, not milliseconds).
      const regranted = planHardCatTurn(state, {
        rules,
        timeBudgetMs: 100,
        maxDepthTurns: 1,
        maxNodes: 10_000,
        now: () => 1100,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: false },
      });
      expect(regranted.hasSolution).toBe(true);
    });

    it('an open but smaller-than-nominal window really bounds the search', () => {
      const state = root();

      // 8 ms of what the turn is allowed to give the main search this time.
      const base = monotonicNow();
      const narrow = makeTurnDeadlineIdentity(base, 8, HARD_TRIAL.totalTurnBudgetMs, monotonicNow);
      const tNarrow = monotonicNow();
      const narrowPlan = planHardCatTurn(state, {
        rules,
        timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
        maxDepthTurns: 4,
        maxNodes: 500_000,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: false },
        turnDeadline: narrow,
      });
      const narrowWall = monotonicNow() - tNarrow;

      // Control: identical call, no identity ⇒ a full 100 ms window.
      const tControl = monotonicNow();
      const controlPlan = planHardCatTurn(state, {
        rules,
        timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
        maxDepthTurns: 4,
        maxNodes: 500_000,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: false },
      });
      const controlWall = monotonicNow() - tControl;

      // The difference is the point: the child spends the window it was given.
      expect(narrowWall).toBeLessThan(60);
      expect(controlWall).toBeGreaterThan(60);
      // And it expands materially less of the tree, because it had less time.
      expect(narrowPlan.search.diagnostics.totalNodes)
        .toBeLessThan(controlPlan.search.diagnostics.totalNodes);
    });

    it('a fallback BEFORE the main deadline may still use the remainder of it', () => {
      // Frozen clock at 1070ms: the turn's 1100ms main deadline has not been
      // reached, so a re-plan in this turn is still allowed to search — it just
      // cannot be given anything beyond 1100ms.
      const state = root();
      const identity = makeTurnDeadlineIdentity(1000, 100, 150, () => 1070);
      const plan = planHardCatTurn(state, {
        rules,
        timeBudgetMs: 100,
        maxDepthTurns: 1,
        maxNodes: 10_000,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: false },
        turnDeadline: identity,
      });
      // The frozen clock never advances, so nothing here can expire mid-search:
      // the ONLY thing asserted is that the search was ALLOWED to run.
      expect(plan.hasSolution).toBe(true);
      expect(plan.deadlineFired).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('TIME-6 — sidecar and guard inherit the turn’s total instant', () => {
    /** D1/10k is the shape where BOTH post-processors actually run (the sidecar
     *  needs a completed, mate-free, legal baseline plan with candidates). */
    function runBounded(state: GameEngineState, identity: ReturnType<typeof makeTurnDeadlineIdentity>) {
      return planHardCatTurn(state, {
        rules,
        timeBudgetMs: DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
        maxDepthTurns: 1,
        maxNodes: 10_000,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: true, totalTurnBudgetMs: HARD_TRIAL.totalTurnBudgetMs },
        turnDeadline: identity,
      });
    }

    it('the bounded refutation sidecar is bounded by the turn’s total deadline', () => {
      const state = root();
      const base = monotonicNow();
      // Production shape: 100 ms main + 150 ms turn.
      const identity = makeTurnDeadlineIdentity(
        base,
        DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
        HARD_TRIAL.totalTurnBudgetMs,
        monotonicNow,
      );
      const plan = runBounded(state, identity);

      const ref = plan.debug.refutation;
      expect(ref, 'sidecar diagnostics present').toBeDefined();
      expect(ref!.refutationTriggered, 'sidecar actually ran').toBe(true);
      const ctl = ref!.deadlineControl;
      expect(ctl, 'sidecar transactional control present').toBeDefined();
      // THE assertion: the wall the sidecar ran against is the TURN's instant,
      // computed once at turn start — not `sidecarStart + 150`. It is the same
      // absolute instant even though the sidecar started later.
      expect(ctl!.deadline.deadlineAtMs).toBe(identity.totalTurnDeadlineAtMs);
      // A sidecar that stopped on the wall never commits an override.
      if (ctl!.deadlineAbort) {
        expect(ref!.overrideUsed).toBe(false);
        expect(ctl!.partialCommitCount).toBe(0);
        expect(ref!.selectedPlanSource).toBe('baseline');
      }
    });

    it('the Progress Guard and the sidecar share ONE wall object, not two', () => {
      const state = root();
      const identity = makeTurnDeadlineIdentity(
        monotonicNow(),
        DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn,
        HARD_TRIAL.totalTurnBudgetMs,
        monotonicNow,
      );
      // The guard is OFF in production; switching it on for one call is the only
      // way to observe the wall it would have used.
      const saved = HARD_PROGRESS_GUARD_CONFIG.enabled;
      HARD_PROGRESS_GUARD_CONFIG.enabled = true;
      try {
        const plan = runBounded(state, identity);
        const guard = plan.debug.progressGuard;
        expect(guard, 'guard debug present').toBeDefined();
        expect(guard!.enabled).toBe(true);
        expect(guard!.deadlineControl).toBeDefined();
        expect(guard!.deadlineControl!.deadline.deadlineAtMs).toBe(identity.totalTurnDeadlineAtMs);
        expect(guard!.deadlineControl!.partialCommitCount).toBe(0);

        const sideDeadline = plan.debug.refutation?.deadlineControl?.deadline;
        expect(sideDeadline, 'sidecar control present').toBeDefined();
        // Identity, not equality: one `FINITE_ABSOLUTE` context is built at
        // planner entry and handed to both consumers. A second object could
        // still hold the same number today and drift tomorrow.
        expect(sideDeadline).toBe(guard!.deadlineControl!.deadline);
      } finally {
        HARD_PROGRESS_GUARD_CONFIG.enabled = saved;
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('TIME-4 — normal path parity (24 frozen human roots, fixed D1)', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PLANNER, 'utf8')) as {
      capturedOn: string;
      records: Array<{ id: string } & Record<string, unknown>>;
    };

    it('the frozen witness is the pre-fix one and is untouched', () => {
      expect(baseline.capturedOn).toContain('pre-fix');
      expect(baseline.records).toHaveLength(24);
      // Fixture identity is asserted, not assumed: this file must never be
      // regenerated on top of the P1-ID candidate tree.
      expect(createHash('sha256').update(readFileSync(BASELINE_PLANNER)).digest('hex'))
        .toBe('2c1bab71e11ac59aab2eb2acc93fe221359d44d5e50a90b0651d59ca6c673885');
      // The 24 roots themselves are the frozen P1-ID fixture.
      expect(createHash('sha256').update(readFileSync(ROOT_FIXTURE)).digest('hex'))
        .toBe('1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09');
    });

    it('no-identity calls are byte-identical to the pre-fix witness', () => {
      const frozen = () => 1000;
      for (const [i, rec] of baseline.records.entries()) {
        const state = root(i);
        const actual = { id: rec.id, ...signature(planFixedD1(state, frozen), state) };
        expect(actual, `${rec.id} identity-less parity`).toEqual(rec);
      }
    });

    it('calls that inherit the turn identity are byte-identical too', () => {
      const frozen = () => 1000;
      for (const [i, rec] of baseline.records.entries()) {
        const state = root(i);
        // Same instants the pre-fix call would have minted on its own.
        const identity = makeTurnDeadlineIdentity(1000, 100_000, 100_000, frozen);
        const actual = {
          id: rec.id,
          ...signature(planFixedD1(state, frozen, identity), state),
        };
        expect(actual, `${rec.id} identity parity`).toEqual(rec);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('TIME-7 — isolation and freshness', () => {
    it('planning with a turn identity does not mutate the input state', () => {
      const state = root();
      const before = JSON.stringify(state);
      const identity = makeTurnDeadlineIdentity(monotonicNow(), 100, 150, monotonicNow);
      planHardCatTurn(state, {
        rules,
        timeBudgetMs: 40,
        maxDepthTurns: 2,
        maxNodes: 50_000,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: false },
        turnDeadline: identity,
      });
      expect(JSON.stringify(state)).toBe(before);
    });

    it('the identity is data, not state: it never appears in a serialized game state', () => {
      const state = root();
      const identity = makeTurnDeadlineIdentity(monotonicNow(), 100, 150, monotonicNow);
      const plan = planHardCatTurn(state, {
        rules,
        timeBudgetMs: 20,
        maxDepthTurns: 1,
        maxNodes: 5_000,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: false },
        turnDeadline: identity,
      });
      const serialized = JSON.stringify({ ...state, lastHardSearch: plan.debug });
      expect(serialized).not.toContain('mainSearchDeadlineAtMs');
      expect(serialized).not.toContain('totalTurnDeadlineAtMs');
      expect(serialized).not.toContain('startedAtMs');
    });

    it('every cat turn mints its own window (no cross-turn carry-over)', () => {
      const a = makeTurnDeadlineIdentity(1000, 100, 150, () => 1000);
      const b = makeTurnDeadlineIdentity(9000, 100, 150, () => 9000);
      expect(a.mainSearchDeadlineAtMs).not.toBe(b.mainSearchDeadlineAtMs);
      expect(a.totalTurnDeadlineAtMs).not.toBe(b.totalTurnDeadlineAtMs);
      expect(a.totalTurnDeadlineAtMs - a.startedAtMs).toBe(150);
      expect(b.totalTurnDeadlineAtMs - b.startedAtMs).toBe(150);
      // A window may not outlive the turn it belongs to.
      expect(() => makeTurnDeadlineIdentity(1000, 200, 150, () => 1000)).toThrow(/may not outlive/);
      expect(() => makeTurnDeadlineIdentity(Number.NaN, 100, 150)).toThrow(/not a finite instant/);
    });
  });

  // -------------------------------------------------------------------------
  describe('TIME-8 — the identity-less (offline) path is unchanged', () => {
    it('a call without a turn identity still owns its own window', () => {
      const state = root();
      // 100 ms nominal, frozen clock: nothing can expire mid-search, so the
      // result is the plain D1 answer — exactly HEAD's behaviour.
      const plan = planHardCatTurn(state, {
        rules,
        timeBudgetMs: 100,
        maxDepthTurns: 1,
        maxNodes: 10_000,
        now: () => 1000,
        leafEvaluator: evaluateCorrectedHoleForCat,
        refutation: { enabled: false },
      });
      expect(plan.hasSolution).toBe(true);
      expect(plan.deadlineFired).toBe(false);
      expect(plan.debug.budgetMs).toBe(100);
      // `elapsedMs` stays a per-call measurement, not a turn measurement.
      expect(plan.elapsedMs).toBeLessThan(10_000);
    });

    it('the state in the fixture set is still a live Hard turn root', () => {
      for (let i = 0; i < 24; i++) {
        const s = root(i);
        expect(s.phase).toBe(GamePhase.Playing);
        expect(s.catMovesLeft).toBeGreaterThan(0);
      }
    });
  });
});
