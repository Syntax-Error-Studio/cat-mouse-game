# Phase 2 — fixed 100 ms budget (formal envelope)

Generated 2026-11-16T17:11:09.531Z.

## 1. Verdict

**Integrity: PASS** — 960/960 calls, 0 errors, 0 replay failures, 0 Math.random calls.

**Throughput: no detectable change.** Order-balanced arm effect 0.04% (95% CI [-1.16%, 1.67%]) in completed simulations per call, against a measured arm-order (warm-up) effect of 1.34%.

## 2. Execution

| item | value | note |
|---|---|---|
| fresh Node processes | 20/20 | serial: the next process starts only after the previous exits |
| process exit codes | 0 | 0 = clean |
| per-process wall clock | 5.0–5.1 s | includes Node startup |
| records | 960 | 24 roots x 2 arms x 20 repetitions |
| paired cells | 480 | both arms present for every (root, repetition) |
| deadline fired | 960 | the search stopped on its own 100 ms deadline |
| node cap fired | 0 | must be 0 |
| plans consuming the turn | 960/960 | replay.ts fullTurnConsumed |
| replay ok | 960/960 | real engine, step by step |

## 3. Throughput

| quantity | value |
|---|---|
| baseline simulations per call | 27.67 |
| prepared simulations per call | 27.68 |
| pooled paired difference | 0.008 |
| prepared ran second (odd reps) | 1.38% |
| prepared ran first (even reps) | -1.30% |
| order effect | 1.34%  CI [-0.42%, 4.23%] |
| order-balanced arm effect | 0.04%  CI [-1.16%, 1.67%] |

## 4. Cost, which did move

| quantity | baseline | prepared | reading |
|---|---|---|---|
| rule-internal calls per call | 2069.5 | 1092.7 | 47.2% fewer |
| rollout transitions reused per call | 0 | 236.8 | prepared-only counter |
| impure fallbacks per call | 0 | 0.0 | fail-closed path, not exercised in these roots |
| simulations per call | 27.67 | 27.68 | unchanged |
| nodes created per call | 30.30 | 30.27 | unchanged |

## 5. Time

| ms | baseline | prepared |
|---|---|---|
| searchMs P50 / P95 | 100.22 / 101.49 | 100.22 / 101.12 |
| plannerWallMs P50 / P95 | 100.77 / 102.56 | 100.80 / 102.69 |
| replayMs P50 / P95 | 0.13 / 0.22 | 0.13 / 0.22 |

`withinPlanner150ms` (authoritative): 960/960. `legacyPilotComparable150ms` (original Pilot boundary, includes offline replay): 960/960.

## 6. What is deliberately not claimed

- Not a playing-strength result. No self-play, no oracle, no ladder was run.
- Not a "faster planner" result either: planner wall clock is pinned at the 100 ms budget by construction on both arms.
- Slow or unusual samples were not removed; see the per-repetition table in `STATISTICAL_ANALYSIS.md`.

