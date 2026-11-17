# PPC-P1-TIME-02 — TIMING SCOPE

What is measured, with what clock, in which domain — and what the numbers are NOT.

## 1. The three (four) different measurement domains

| Domain | Definition here | Owner | Where it shows up |
|---|---|---|---|
| `SEARCH_CORE_MS` | `searchBestActionIterative` entry → end of the deepening loop, i.e. the iterative-deepening work only | `expectiminimax.ts` | `search_loop_done` − `iter_enter` |
| `SEARCH_CALL_MS` | `searchBestActionIterative` entry → return, **including** post-search plan extraction / forced-loss tie-break | `expectiminimax.ts` | `search_loop_done`..`search_post_plan_done` add the difference |
| `PLANNER_CALL_WALL_MS` | `planHardCatTurn` entry → return, i.e. search + sidecar + guard + diagnostics construction | `hardTurnPlanner.ts` | `planner_fn_return` − `planner_fn_enter` |
| `CAT_TRAJECTORY_COMPUTE_MS` | `computeCatAiTrajectory` entry → return: planning **plus** plan execution / fallback **plus** history & memory bookkeeping | `engine.ts` | `turn_return` − `turn_enter` |

`turnWallMs` in PPC-P1-TIME-01 and in this round is `CAT_TRAJECTORY_COMPUTE_MS`.

It is **not** `CAT_TURN_UI_ANIMATION_MS`: `GamePage.tsx:204` calls
`computeCatAiTrajectory(catState)` synchronously and only then animates the
returned steps (`isAnimatingRef`), so the synchronous call is the part that
blocks the first visible cat step. The animation and the following mouse turn
are outside every number here.

Historical gates (`M1 = SEARCH_CORE_MS`, `M2 = PLANNER_CALL_WALL_MS`) are
narrower domains than `CAT_TRAJECTORY_COMPUTE_MS`. **Nothing in this round is a
gate verdict**: `ABSOLUTE_DEADLINE_GATE = BLOCKED` still stands, because the repo
has no frozen manifest for a *complete cat turn*.

## 2. Clock

One clock for everything: `performance.now()` (the same base
`deadlineContext.monotonicNow()` uses). The trace sink, the search's `ctx.now`,
and the turn's `TurnDeadlineIdentity` therefore share one origin, so
`deadline_first_observed − search_enter.deadlineAtMs` is a real overrun and not a
difference of two time bases.

No `Date.now()` is mixed in anywhere on the measured paths.

## 3. The budget contract the numbers sit against

```
T0                     = the turn's single clock read        (engine.ts computeCatAiTrajectory)
MAIN_SEARCH_DEADLINE   = T0 + 100 ms     (soft: sampled at every interior node)
TOTAL_TURN_DEADLINE    = T0 + 150 ms     (bounds the bounded-refutation sidecar)
```

`searchConfig.ts` states the intent ("per COMPLETE cat turn"); PPC-P1-TIME-01
made the code match it.

Consequence that this round establishes empirically: **a turn that reaches
~150 ms is not overshooting — it is the sidecar spending the remainder of the
turn's own wall.** In the traces the sidecar's own `sidecarAbortReason` is
`deadline` exactly on the turns that land at ~150 ms (G1T1, G1T5), and
`baseline_not_refuted` on the turn that lands at 121 ms (G1T4). A turn whose
sidecar is not triggered at all finishes at ~104 ms (G5T4).

## 4. Erratum carried forward from PPC-P1-TIME-01

`PPC-P1-TIME-01/TIMING_RESULTS.json` contains the sentence

> the deadline is a SOFT stop sampled every 64 interior nodes

That sentence is **wrong** and was never true of this source. The current code is

* `DEADLINE_CHECK_INTERVAL = 1` — the clock is sampled at **every** interior node
  (`expectiminimax.ts:52`, gate at `:88`);
* `EVAL_DEADLINE_CHECK_INTERVAL = 64` — a *separate* evaluator-batch observation
  that sets a flag the node gate consumes (`:67`, `:113`).

This round measured the real overrun (`deadline_first_observed −
deadlineAtMs`) and found it is **0.013–0.406 ms** (n=20 traced turns), which is
consistent with cadence 1 and inconsistent with cadence 64 (at ~0.11–0.15 ms of
evaluation per leaf, 64 nodes of undetected work would be several ms).

The frozen P1-TIME-01 artifact has **not** been edited (it is an artifact of that
round). The correction lives here, and every claim in this round is based on the
source as it is now.

## 5. What this round is not

* Not a benchmark: 4 roots × 5 traced repetitions, 1 process, serial.
* Not an authority: no pre-registered protocol, no gate thresholds, no PASS.
* Not a distribution claim: 4 roots cannot characterise 24, let alone the game.
  `REPLICATION_24ROOTS.json` is a 24-root *replication attempt* of the
  P1-TIME-01 sweep, not a timing authority either.
