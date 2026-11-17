# PPC-P1-TIME-02 — CALL GRAPH & COST AUDIT

Every number below is a **median of 5 traced turns** of the same frozen root on
this machine in this session (`TURN_ACCOUNTING.json`), or a counter taken from
the same run. They are diagnostic, not an authority.

## 1. The graph, with measured cost (ms)

```
computeCatAiTrajectory(state)                          engine.ts:3989           150.4  G1T1 / 150.4  G1T5
├─ makeTurnDeadlineIdentity(now(),100,150)             engine.ts:~4050            ~0.00   one clock read
├─ planHardCatTurn(state,{turnDeadline})               hardTurnPlanner.ts:237    150.2   150.2
│  ├─ searchBestActionIterative                        expectiminimax.ts:2198    101.7   113.7
│  │  ├─ runFixedSearch × depth                        expectiminimax.ts:1817
│  │  │  └─ _searchInner                               expectiminimax.ts:1672
│  │  │     ├─ deadlineReached (cadence 1)              expectiminimax.ts:86      0.05 overrun
│  │  │     ├─ searchActions (legal + transitions)      expectiminimax.ts:1197   21.5 / 10.3
│  │  │     │  └─ valueOfAction → _search → evaluateLeaf
│  │  │     └─ abort site → evaluateLeaf                expectiminimax.ts:1704    ← 1 leaf per aborting node
│  │  └─ plan extraction (tie-break / equal-primary)    expectiminimax.ts:2320     0.12   0.10
│  ├─ runRefutationSidecar                             boundedPlanRefutation:951  48.3   36.4
│  └─ progressGuard (OFF in production)                                         0      0
├─ plan execution loop (applyPlanCatAction / catMove)   engine.ts:~4160            0.08   0.06
├─ buildHardTurnExecutionStatus / pushHardHistory      engine.ts:~4330            0.02   0.03
└─ progress-guard memory bookkeeping (flag OFF)        engine.ts:~4350            0.01   0.01
```

`CAT_TRAJECTORY_COMPUTE_MS` closes as

```
wall = planner call + plan execution + history/memory finalize + residual
150.43 = 150.25   + 0.079        + 0.024                  + 0.08     (G1T1)
150.41 = 150.25   + 0.056        + 0.025                  + 0.08     (G1T5)
```

The residual outside the planner is **< 0.1 ms**. All the time is inside
`planHardCatTurn`; there is no hidden post-processing block.

## 2. Inside the main search: the profiler ledger

`SearchProfiler` (production code, G0.3C/G0.4F-2B-1.9L) was enabled **only in the
instrumented arm**; the arm is a copy and `src/` was not modified.

| root | search | evaluate | stateKey | legalActions | transition | ordering | ledger sum | residual |
|---|---|---|---|---|---|---|---|---|
| G1T1 | 101.7 | **41.8** | 7.0 | 21.5 | 14.5 | 0.3 | 85.1 | 16.6 (16%) |
| G1T5 | 113.7 | **72.1** | 11.2 | 10.3 | 8.6 | 0.2 | 102.4 | 11.3 (10%) |
| G1T4 | 101.6 | **40.6** | 9.9 | 19.8 | 14.7 | 0.2 | 85.3 | 16.3 (16%) |
| G5T4 | 104.0 | **49.7** | 8.0 | 18.9 | 13.0 | 0.2 | 89.9 | 14.1 (14%) |

* `evaluate` is the **largest single block**: 40–64 % of the search.
* `stateKey` is 7–11 ms — the P1-ID-fixed function is still a top-4 consumer.
* `transition` (simulate every legal action once per node) is 13–15 ms.
* `legalActions` 10–22 ms.
* 10–16 % residual = TT probing, bound arithmetic, plan capture, recursion.
  Kept as residual; not attributed by instrumentation.

Per-turn evaluation counts: 266 (G1T1), 635 (G1T5), 340 (G1T4), 453 (G5T4)
unique leaf evaluations, of which 248 / 358 / 397 / 210 were **cache hits**
(`repeatedLeafEvals`), so the eval cache is already doing real work.

## 3. Leaf evaluator, measured outside the search

`LEAF_COST.json`, 200 timed calls after 30 warm-up calls, no profiler, no trace,
no deadline:

| evaluator | per call (mean) | median | min | max | graph searches per call |
|---|---|---|---|---|---|
| `evaluateForCat` (production default) | 0.144 ms | 0.128 | 0.104 | 0.60 | 3 (mouse BFS, cat BFS, carry BFS) |
| `evaluateCorrectedHoleForCat` | 0.109 ms | 0.098 | — | — | 3 |

The in-search figure (evaluateMs / unique evals = 0.110–0.157 ms) matches this
independent measurement, so the profiler is not inflating the leaf cost.

`HARD_LEAF_MODE_DEFAULT = 'baseline'` → production uses `evaluateForCat`
(`searchConfig.ts:81`), not the corrected-hole leaf.

## 4. `catAiHard` (fallback path), static + measured

Not "cheap legacy code". Per call on G1T1 it does, in order:

| step | code | cost | repeated work |
|---|---|---|---|
| tactical mouse plans | `buildMousePlansForHard` engine.ts:1733 | 0.4–1.3 ms | 1 hole BFS + per-butter BFS **and** per-butter hole BFS → O(B²) |
| emergency hole gate | `findEmergencyHoleBlockDecision` engine.ts:1921 | 0.002–0.11 ms | cheap on these roots |
| trap stand selection | `chooseHardTrapStandCell` engine.ts:1566 | **4.2–6.9 ms** | one `bfsCatPathToStand` per walkable cell: **73 calls** counted per call on G1T1 |
| direction scoring | loop at engine.ts:~3085 | 0.2–0.95 ms | per direction: 2–4 `bfsDistance` + 2 `countMouseEscapeRoutes` |
| bypass estimates | `estimateTrapBypassCost` engine.ts:1893 | inside trap stand | 26 calls per step on G1T1 |

Measured whole fallback turn (4 steps, closed window, real rules —
`FALLBACK_COST.json`):

| root | per step | 4 steps total |
|---|---|---|
| G1T1 | 2.2 – 13.4 ms (cold first step highest) | **9.6 – 38.7 ms** across 3 reps |
| G1T5 | 0.5 – 1.0 ms | **2.6 – 3.0 ms** |

`chooseHardTrapStandCell` accounts for 72–78 % of a G1T1 fallback step. On
G1T5 the trap is already placed / inventory empty, the sweep never runs, and the
step costs 0.6 ms.

**Note on `catMove` counters**: `catMove` shows 3 597–4 362 "calls" per turn
because the search simulator goes through `RuleSet.catMove`
(`simulator.ts:46`); only 4–5 are real executed cat actions.

## 5. Static findings that were NOT confirmed as costs here

| suspicion | verdict |
|---|---|
| "`catAiHard` rebuilds the strategic target from scratch every step" | **TRUE by code** (`buildMousePlansForHard` is called per step, no memo) but it costs only 0.4–1.3 ms/step; the expensive part is the trap-stand sweep |
| "nested loops cause super-linear cost" | trap-stand is O(cells × BFS) = quadratic in board size; nothing worse found |
| "duplicate array copies / sorting" | `orderingSortMs` = 0.16–0.33 ms/turn; not a cost |
| "logging in the hot loop" | `catAiHard` builds strings per step (~0.05 ms), search does not log per node |
| "sidecar re-runs the main search" | not observed: sidecar wall is bounded by the turn's remaining wall and `abort=deadline` |
| "the 20 ms CPU cap bounds the sidecar" | **FALSE by code and by measurement**: `maxCpuMs = FIXED_CPU_MS = 20` is applied **per candidate** (`boundedPlanRefutation.ts:523/:574/:617`) and `candidateCount = 6`; the sum is bounded only by the shared turn deadline. Measured: 35.5–49.4 ms on the two platform roots (`SIDECAR_DIAG.json`) |
| "`evalCache` thrashes" | 210–397 hits per 340–635 evaluations; the cache is effective |

## 6. Two structural facts that reframe the "tail"

1. **The ~150 ms plateau is by construction.** Main search stops at T0+100
   (+0.013–0.406 ms overrun + 1.0–16.2 ms unwind, both measured with the
   instrumented arm), then the bounded-refutation sidecar runs until T0+150.
   On the turns that land at 150 ms the sidecar's own reason is `deadline`, and
   its own diagnostics show that **not one candidate probe completed** — it spent
   36–49 ms of the turn's remaining wall and returned no verdict at all. A
   turn whose sidecar finishes early stops at 121 ms (`baseline_not_refuted`,
   6/6 candidates probed), and one whose sidecar is gated off stops at 104 ms
   (`mate_bypass`).
2. **The only un-deadlined work in a turn is the fallback execution path.**
   Once the plan is empty/truncated/invalid, `catAiMove` → `catAiHard` runs the
   remaining cat moves with no deadline at all. That is where a turn can exceed
   150 ms; it is not where it usually spends its time.
