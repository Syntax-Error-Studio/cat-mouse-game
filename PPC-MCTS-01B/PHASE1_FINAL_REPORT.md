# Phase 1 — fixed completed-simulation parity (formal envelope)

Generated 2026-11-16T17:06:43.085Z. **Verdict: PASS**

## 1. What was run

| item | value | note |
|---|---|---|
| roots | 24 | the 24 frozen human roots |
| repetitions | 20 | one fresh Node process each |
| arms | 2 | UCT-H-BASELINE / UCT-H-PREPARED, both hybrid rollout |
| completed simulations per call | 200 | enforced by the `maxCompletedSimulations` seam between simulations |
| search calls | 960/960 | 24 x 20 x 2 |
| simulations | 192000/192000 | K x calls |
| fresh processes executed | 20 | serial, previous must exit first |
| envelope wall clock | 938.5 s | single heavy worker |

## 2. Acceptance table (pre-registered, asserted not described)

| gate | expected | actual | result |
|---|---|---|---|
| TOTAL_SEARCH_CALLS | 960 | 960 | **PASS** |
| COMPLETED_SIMULATIONS_PER_CALL | 200 | [200] | **PASS** |
| EXPECTED_TOTAL_SIMULATIONS | 192000 | 192000 | **PASS** |
| ALL_CALLS_COMPLETE | — | — | **PASS** |
| ALL_SIMULATION_DIGESTS_MATCH | — | 96000 comparisons | **PASS** |
| ALL_TREE_FINGERPRINTS_MATCH | — | — | **PASS** |
| ALL_PLANS_MATCH | — | — | **PASS** |
| MATH_RANDOM_DRAWS | 0 | 0 | **PASS** |
| NODE_CAP_HITS | 0 | 0 | **PASS** |
| DEADLINE_HITS | 0 | 0 | **PASS** |
| ABORTED_SIMULATIONS | 0 | 0 | **PASS** |
| SEEDS_PRESENT | — | — | **PASS** |
| NO_FAILURES | — | — | **PASS** |

## 3. What was compared on every cell

- simulations
- nodesCreated
- nodes created per kind (nodesCreated + chanceNodes)
- chanceSamples
- maxChanceMassError
- rolloutSteps
- maxHandoffsReached
- treeDigest (whole tree: kind, handoffs, stateKey, visits, total/mean reward, edge keys, CHANCE weights and outcome stateKeys)
- per-simulation digest x 200
- rootVisits
- rootTotalReward
- rootMeanReward
- plan
- planCost
- planExtended
- treePlanLength
- extensionSteps
- rootAction
- rootActionStats (key, transitionKind, visits, meanReward, totalReward, childStateKey)
- planTraceDigest
- mathRandomDraws
- abortedSimulations
- postDeadlineNodeCreations

The stop mechanism is identical on both arms by construction: the same seam at the same place in the simulation loop, so "both arms ran K simulations" is not an assertion about equal work, it is the same control flow.

## 4. Per-repetition roll-up

| rep | cells | PASS | ruleCalls baseline | ruleCalls prepared | wall s baseline | wall s prepared |
|---|---|---|---|---|---|---|
| 1 | 24 | 24 | 433591 | 225500 | 24.5 | 23.3 |
| 2 | 24 | 24 | 434470 | 225994 | 23.9 | 22.8 |
| 3 | 24 | 24 | 434785 | 226259 | 24.0 | 23.2 |
| 4 | 24 | 24 | 433637 | 225648 | 23.6 | 22.7 |
| 5 | 24 | 24 | 434591 | 226086 | 23.9 | 23.0 |
| 6 | 24 | 24 | 434286 | 225821 | 23.6 | 22.6 |
| 7 | 24 | 24 | 434496 | 226354 | 23.7 | 22.8 |
| 8 | 24 | 24 | 431548 | 224861 | 23.7 | 22.8 |
| 9 | 24 | 24 | 434107 | 225863 | 23.6 | 22.7 |
| 10 | 24 | 24 | 435031 | 226504 | 24.2 | 23.1 |
| 11 | 24 | 24 | 434988 | 226446 | 23.8 | 22.9 |
| 12 | 24 | 24 | 432835 | 225564 | 23.4 | 22.4 |
| 13 | 24 | 24 | 434445 | 226057 | 23.7 | 22.9 |
| 14 | 24 | 24 | 431975 | 225188 | 23.5 | 22.6 |
| 15 | 24 | 24 | 432989 | 225653 | 23.3 | 22.4 |
| 16 | 24 | 24 | 435434 | 226578 | 23.8 | 22.7 |
| 17 | 24 | 24 | 433556 | 225959 | 23.7 | 22.8 |
| 18 | 24 | 24 | 435013 | 226283 | 23.8 | 23.0 |
| 19 | 24 | 24 | 432678 | 225551 | 23.9 | 22.8 |
| 20 | 24 | 24 | 435169 | 226372 | 23.7 | 22.6 |

## 5. Rule calls — a cost observation, not a correctness claim

- baseline: **8,679,624** rule-internal calls
- prepared: **4,518,541** rule-internal calls
- reduction: **47.94%**

Wall clock is reported but is NOT a result here: Phase 1 freezes the clock (`now() => 0`) precisely so that the number of simulations, not the wall clock, decides when work stops.

## 6. Files

| file | content |
|---|---|
| `PHASE1_ANALYSIS/summary.json` | acceptance table, per-cell table, input digests |
| `PHASE1_ANALYSIS/cells.csv` | one row per (root, repetition) for spreadsheet review |
| `data/phase1-formal/rep-NN.jsonl` | raw records, appended, never truncated |
| `data/phase1-formal/rep-NN.summary.json` | per-repetition summary |
| `data/phase1-formal/ENVELOPE.json` | per-process exit codes, wall times, per-rep validation |

