# Phase 2 — statistical analysis (fixed 100 ms budget)

Generated 2026-11-16T17:11:09.531Z. Inputs: 20 raw JSONL files under `PPC-MCTS-01B/data/phase2-formal/`.

## 1. Data integrity first

| check | value | meaning |
|---|---|---|
| records | 960 | 24 roots x 2 arms x 20 repetitions = 960 |
| paired cells | 480 | both arms present for the same (root, repetition) |
| errors | 0 | must be 0 |
| replay failures | 0 | must be 0 |
| plans consuming the full cat turn | 960 | replay.ts fullTurnConsumed |
| Math.random calls | 0 | must be 0 (count-only tap) |
| deadline fired | 960 | search stopped on its own 100 ms deadline |
| node cap fired | 0 | must be 0 |

## 2. Simulation efficiency — the headline

| quantity | value |
|---|---|
| baseline mean | 27.67 |
| prepared mean | 27.68 |
| mean paired difference | 0.01 |
| relative gain | 0.0% |
| 95% CI of the mean difference | [-0.49, 0.31] |
| 95% CI of the relative gain | [-1.2%, 1.7%] |
| share of bootstrap resamples with a positive difference | 57.2% |
| bootstrap | 10000 iterations, seed 20261117, cluster = root |

Pooled verdict on "more completed simulations in the same 100 ms": **NOT supported by this sample: the order-balanced 95% CI of the relative gain includes 0**.

### 2.1 Arm order is a confounder, and it is larger than the effect

Each fresh process runs both arms back to back, and the order alternates by repetition (odd: baseline first; even: prepared first). The arm that runs first in a cold process pays JIT warm-up and therefore completes fewer simulations. Pooling the two halves makes that bias cancel — which is exactly why the pooled number must not be read alone.

| subgroup | n | relative gain in completed simulations |
|---|---|---|
| prepared ran SECOND (odd repetitions) | 240 cells | 1.4% |
| prepared ran FIRST (even repetitions) | 240 cells | -1.3% |
| measured order (warm-up) effect | half the gap | 1.3%  CI [-0.4%, 4.2%] |
| **order-balanced arm effect** | the number to quote | **0.0%**  CI [-1.2%, 1.7%] |

The order effect is 1.3%, i.e. the first arm in a fresh process loses about that much throughput to warm-up. Any mechanism whose true effect is smaller than this cannot be resolved without an order-balanced design, and with 20 repetitions the order-balanced CI is [-1.2%, 1.7%].

## 3. Time distributions (never mixing offline replay into planning)

| quantity (ms) | baseline P50 | baseline P95 | prepared P50 | prepared P95 |
|---|---|---|---|---|
| searchMs (searcher self-report) | 100.22 | 101.49 | 100.22 | 101.12 |
| plannerWallMs (construct→plan) | 100.77 | 102.56 | 100.80 | 102.69 |
| replayMs (offline) | 0.13 | 0.22 | 0.13 | 0.22 |
| validationEndToEndMs | 100.91 | 102.83 | 100.94 | 102.98 |

- `withinPlanner150ms` (authoritative): **960/960** calls.
- `legacyPilotComparable150ms` (Pilot boundary, replay-inclusive): **960/960** calls.
- Calls above the planner budget, kept as measured: **0**.

## 4. Search structure — where the saved work went

| mean per call | baseline | prepared |
|---|---|---|
| simulations | 27.67 | 27.68 |
| nodesCreated | 30.30 | 30.27 |
| rolloutSteps | 229.54 | 231.80 |
| chanceSamples | 13.19 | 13.29 |
| treePlanLength | 2.73 | 2.78 |
| extensionSteps | 1.44 | 1.39 |
| planLength | 4.17 | 4.17 |
| planActionCost | 4.00 | 4.00 |
| ruleCalls | 2069.53 | 1092.65 |
| plan extended share | 90.4% | 88.8% |

## 5. Per-root gain — the grand mean is not the whole story

| root | baseline sims | prepared sims | diff | relative | cells improved |
|---|---|---|---|---|---|
| G1T1 | 16.05 | 16.50 | 0.45 | 2.8% | 10/20 |
| G1T2 | 15.75 | 16.00 | 0.25 | 1.6% | 5/20 |
| G1T3 | 18.15 | 18.50 | 0.35 | 1.9% | 8/20 |
| G1T4 | 20.85 | 21.15 | 0.30 | 1.4% | 4/20 |
| G1T5 | 7.65 | 7.75 | 0.10 | 1.3% | 2/20 |
| G1T6 | 15.00 | 15.15 | 0.15 | 1.0% | 8/20 |
| G1T7 | 17.55 | 17.80 | 0.25 | 1.4% | 4/20 |
| G1T8 | 37.30 | 37.35 | 0.05 | 0.1% | 5/20 |
| G1T9 | 13.65 | 13.75 | 0.10 | 0.7% | 3/20 |
| G2T1 | 16.65 | 17.05 | 0.40 | 2.4% | 7/20 |
| G2T2 | 20.95 | 21.35 | 0.40 | 1.9% | 8/20 |
| G2T3 | 18.20 | 18.75 | 0.55 | 3.0% | 12/20 |
| G2T4 | 13.50 | 13.70 | 0.20 | 1.5% | 5/20 |
| G2T5 | 19.95 | 20.15 | 0.20 | 1.0% | 4/20 |
| G2T6 | 37.95 | 38.15 | 0.20 | 0.5% | 8/20 |
| G2T7 | 22.15 | 22.40 | 0.25 | 1.1% | 8/20 |
| G2T8 | 57.15 | 56.70 | -0.45 | -0.8% | 2/20 |
| G5T1 | 12.00 | 12.20 | 0.20 | 1.7% | 6/20 |
| G5T2 | 17.70 | 17.85 | 0.15 | 0.8% | 6/20 |
| G5T3 | 19.95 | 20.55 | 0.60 | 3.0% | 12/20 |
| G5T4 | 164.85 | 159.85 | -5.00 | -3.0% | 0/20 |
| G6T1 | 14.80 | 15.35 | 0.55 | 3.7% | 10/20 |
| G6T2 | 11.55 | 12.10 | 0.55 | 4.8% | 10/20 |
| G6T3 | 54.70 | 54.10 | -0.60 | -1.1% | 1/20 |

## 6. Per-repetition gain — environment drift check

| rep | arm order | baseline mean | prepared mean | diff | relative |
|---|---|---|---|---|---|
| 1 | baseline first | 27.71 | 28.21 | 0.50 | 1.8% |
| 2 | prepared first | 27.75 | 27.63 | -0.13 | -0.5% |
| 3 | baseline first | 27.38 | 27.96 | 0.58 | 2.1% |
| 4 | prepared first | 27.88 | 27.50 | -0.38 | -1.3% |
| 5 | baseline first | 27.75 | 28.13 | 0.38 | 1.4% |
| 6 | prepared first | 27.83 | 27.58 | -0.25 | -0.9% |
| 7 | baseline first | 27.58 | 27.88 | 0.29 | 1.1% |
| 8 | prepared first | 28.00 | 27.75 | -0.25 | -0.9% |
| 9 | baseline first | 27.38 | 27.79 | 0.42 | 1.5% |
| 10 | prepared first | 27.83 | 27.42 | -0.42 | -1.5% |
| 11 | baseline first | 27.50 | 27.88 | 0.38 | 1.4% |
| 12 | prepared first | 27.83 | 27.42 | -0.42 | -1.5% |
| 13 | baseline first | 27.33 | 27.63 | 0.29 | 1.1% |
| 14 | prepared first | 28.00 | 27.50 | -0.50 | -1.8% |
| 15 | baseline first | 27.38 | 27.67 | 0.29 | 1.1% |
| 16 | prepared first | 27.63 | 27.13 | -0.50 | -1.8% |
| 17 | baseline first | 27.50 | 27.67 | 0.17 | 0.6% |
| 18 | prepared first | 27.63 | 27.33 | -0.29 | -1.1% |
| 19 | baseline first | 27.54 | 28.04 | 0.50 | 1.8% |
| 20 | prepared first | 27.92 | 27.42 | -0.50 | -1.8% |

## 7. What this does and does not establish

- **Rule-call reduction**: measured (`structure.ruleCalls`), a cost statement.
- **Simulation increase under a fixed budget**: measured on paired cells with a bootstrap CI.
- **Playing strength**: NOT measured. No self-play, no oracle, no ladder. Do not translate throughput into strength.
- Slow or odd calls are retained; the per-repetition table above is the place to see environment noise.

