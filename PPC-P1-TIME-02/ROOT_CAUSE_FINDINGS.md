# PPC-P1-TIME-02 — ROOT CAUSE FINDINGS

Diagnostic attribution of the Hard Cat turn tail. **No production source was changed in
this round.** Every number below is reproducible from an artifact in this directory.

Evidence grades used throughout (task §8):

| Grade | Meaning |
|---|---|
| `PROVEN_CAUSAL` | The components add up to the observed total within measurement resolution, **and** the mechanism is separately observed (a counter, a log line, a source branch) — not inferred from the arithmetic alone. |
| `SUPPORTED_MECHANISM` | A mechanism is observed and is sufficient in magnitude, but the arithmetic does not close to measurement resolution, or the mechanism was observed in a different (but matched) run. |
| `POSSIBLE` | A mechanism is consistent with the numbers but was not observed directly. |
| `NOT_SUPPORTED` | The hypothesis is contradicted by measurement. |
| `UNOBSERVED` | The quantity was not measurable in this round; explicitly left open. |

---

## 1. The four objects, in one table

All values are **medians of 5 traced turns of the same frozen root** (`TURN_ACCOUNTING.json`),
with the full 5-sample range in brackets. `wall` = `computeCatAiTrajectory` (see
`TIMING_SCOPE.md` §1).

| Root | wall ms | planner block | main search | sidecar | outside planner | depth done/attempted |
|---|---|---|---|---|---|---|
| **G1T1** | 150.459 [150.358, 150.735] | 150.262 (99.87%) | 101.733 | 48.265 | 0.197 | 1 / 2 |
| **G1T5** | 150.384 [150.316, 150.421] | 150.229 (99.90%) | 112.543 | 37.518 | 0.155 | 1 / 2 |
| **G1T4** | 120.967 [119.224, 121.847] | 120.832 (99.89%) | 101.974 | 18.577 | 0.135 | 2 / 3 |
| **G5T4** | 104.561 [104.183, 105.215] | 104.422 (99.87%) | 104.288 | 0 (not triggered) | 0.139 | 2 / 3 |

Two facts hold for all four and are the frame for everything else:

1. **The planner call is the turn.** `outside planner` is 0.135–0.197 ms, i.e. **≤0.13%** of
   the turn. Plan execution is 0.037–0.051 ms, history finalization 0.020–0.025 ms.
   There is no hidden post-processing after planning. `PROVEN_CAUSAL` (component identity:
   `wall = planner + outside`, residual ≤0.001 ms).
2. Within the planner call, `search + sidecar` leave a tax of **0.134–0.281 ms**
   (diagnostics construction, deadline object construction, log formatting). So
   `planner ≈ search + sidecar` to within 0.19% of the turn. `PROVEN_CAUSAL`.

---

## 2. Deadline detection granularity — source truth, and the corrected story

Task §4.2 asked for this to be checked against the source rather than carried over. Checked
(`src/game/ai/expectiminimax.ts`, sha `9b976ec9…`, unmodified this round):

| Constant | Value | Line | Role |
|---|---|---|---|
| `DEADLINE_CHECK_INTERVAL` | **1** | `:52` (gate `:88`) | node gate: the clock is read at **every** interior node |
| `EVAL_DEADLINE_CHECK_INTERVAL` | **64** | `:67` (gate `:113`) | leaf-batch observer: every 64th evaluation sets `ctx.evalDeadlineHit`, which the node gate consumes |

The source comment at `:45`–`:51` states the history explicitly: *“the 64-node cadence was
the dominant overshoot mechanism … So the node cadence is now 1.”* The claim “sampled every
64 interior nodes” is therefore obsolete by exactly one design revision, and
`PPC-P1-TIME-01/TIMING_RESULTS.json`'s caveat sentence still carries it (frozen artifact,
not edited; erratum registered in `TIMING_SCOPE.md` §4).

**Measured confirmation** (`deadline_first_observed − deadlineAtMs`, n=20 traced turns):

* overrun **0.013 – 0.406 ms**, median 0.046 ms;
* at the measured 0.11–0.15 ms per leaf, a 64-node blind window would be 7–10 ms. The
  observation is off by two orders of magnitude from that. `PROVEN_CAUSAL` that detection
  is per-node.

**Consequence (this is the correction that matters).** The 100 ms search does *not*
overshoot because detection is late. It overshoots because of what happens **after** the
first overrun is observed. The trace records, per turn, the node at which the deadline was
first seen (`search_loop_done.firstDlNode`) and the final node count:

```
G1T1   firstDlNode  636  738 1108 1063 1139      nodes  636  738 1108 1063 1139
G1T5   firstDlNode  437  569  544  567  603      nodes  437  569  544  567  603
G1T4   firstDlNode  925  943  944  988  988      nodes  925  943  944  988  988
G5T4   firstDlNode  726  752  758  778  747      nodes  726  752  758  778  747
```

`firstDlNode == nodes` in **20/20** rows: after the deadline is seen, **zero** further nodes
are expanded. The work that follows is the **unwind**: each pending sibling re-enters the
node gate, sees the deadline, and returns through the abort path — and that path evaluates
one leaf before returning (`expectiminimax.ts:1713`).

| Root | deadline cutoffs (5 reps) | evals on the abort path | cost of those evals | total post-detection return | share of the unwind |
|---|---|---|---|---|---|
| G1T1 | 7, 15, 16, 19 | same | 1.376 ms | 1.661 ms | 82.8% |
| G1T5 | **78, 85, 86, 98** | same | **8.674 ms** | **12.518 ms** | 69.3% |
| G1T4 | 10, 12, 15 | same | 1.489 ms | 1.816 ms | 82.0% |
| G5T4 | 36, 37, 38 | same | 3.737 ms | 4.232 ms | 88.3% |

So the real overshoot mechanism is **“one leaf evaluation per still-pending sibling”**, and
its size is a structural property of the position (the fan-out of the ancestor chain at the
moment the deadline lands): 7–20 siblings on G1T1, 78–98 on G1T5. `PROVEN_CAUSAL` for the
mechanism and the shares (the abort-path timer brackets exactly the `evaluateLeaf` call at
`:1713`; the remainder of the unwind is call-return bookkeeping).

A secondary, smaller source of post-deadline work: `evalAfterDl` (leaf evaluations that
happen after the first observation) exceeds the abort-path count by exactly **30** in every
G1T5 repetition and by 0 in the other three roots. Those 30 leaves exit through the
**leaf/horizon/budget return paths that are checked *before* the deadline gate**
(`:1218`, `:1563`, `:1650`, `:1690`), so they pay full evaluation and never register as a
cutoff. `SUPPORTED_MECHANISM` (constant offset reproduced 5/5; the individual return path
used by each of the 30 was not itemised).

---

## 3. Why so many turns land on ~150 ms: the sidecar, not the search

The arithmetic identity is exact:

```
G1T1   0.02 (planner entry→search) + 101.73 (search) + 48.27 (sidecar) = 150.02   wall 150.46
G1T5   0.01                          + 112.54          + 37.52         = 150.07   wall 150.38
G1T4   0.01                          + 101.97          + 18.58         = 120.56   wall 120.97
G5T4   0.01                          + 104.29          +  0.00         = 104.30   wall 104.56
```

`SIDECAR_DIAG.json` (uninstrumented production source, reading the diagnostics field the
planner already fills) closes the mechanism:

| Root | `candidateCount` | `candidatesProbed` | probe statuses | abort | sidecar own wall |
|---|---|---|---|---|---|
| G1T1 | 6 | **0** | — (none completed) | `deadline` | 47.8 – 49.1 ms |
| G1T5 | 6 | **0** | — (none completed) | `deadline` | 35.5 – 37.5 ms |
| G1T4 | 6 | 6 | 6× `NO_REFUTATION_FOUND` | `baseline_not_refuted` | 18.9 – 22.0 ms |
| G5T4 | 0 | 0 | — | `mate_bypass` (not triggered) | 0 |

* On G1T1/G1T5 the sidecar's **first** candidate probe was still expanding when the *turn*
  wall hit: `deadlineAbort = true`, `abortPhase ∈ {probe_loop, probe_expansion}`,
  `deadlineObservedAtMs − deadlineAtMs =` 0.018 – 0.136 ms (its own clock read is on time;
  the wall is respected to sub-millisecond). Zero candidates produced a verdict; the
  fail-closed contract kept the baseline plan.
* Its own `maxCpuMs = FIXED_CPU_MS = 20` is **per candidate**, and there are 6 candidates —
  the total is bounded only by the shared turn deadline. That is why the sidecar can and
  does run 36–49 ms. `PROVEN_CAUSAL` for the budget topology
  (`boundedPlanRefutation.ts:523/:574/:617`, `hardTurnPlanner.ts:292–309`); the reason a
  *single* candidate probe can consume 37–48 ms despite the 20 ms cap (one expensive
  internal call, or the cap only being re-read between frontier iterations) is
  `POSSIBLE` — both readings are consistent with the data and were not separated.
* When the sidecar is gated off (G5T4) or finishes its own work early (G1T4) the turn lands
  at 104 / 121 ms. The ~150 ms “platform” is therefore **not a floor and not an overshoot:
  it is the sidecar spending whatever is left of the turn's own wall.** `PROVEN_CAUSAL`.

Efficacy note, scoped to this evidence set only: across **32 measured turns** (12 in
`SIDECAR_DIAG.json`, 20 traced), the sidecar was entered on **24** of them (it is gated off
on all 8 G5T4 turns by `mate_bypass`) and produced **0 overrides and 0 refutations** on
these four roots. This says nothing about other positions.

---

## 4. G1T1 — what the 196.83 ms event was, and what it was not

### 4.1 The hypothesis this round had to test

The obvious reading of the P1-TIME-01 record (`turnWallMs 196.83`, `searchElapsedMs 103.56`)
is “196.83 − 103.56 ≈ 93.27 ms of heuristic cat moves”. **`NOT_SUPPORTED`.**

Four-step heuristic fallback cost was measured directly in `FALLBACK_COST.json` (production
`catAiMove` closed-window branch, production `catAiHard`, real rule set, 3 reps):

| Root | 4 steps total | per step | of which `chooseHardTrapStandCell` |
|---|---|---|---|
| G1T1 | **9.63 / 25.24 / 38.68 ms** | 1.8 – 13.4 ms | 72 – 79% (73 `bfsCatPathToStand` + 26 `estimateTrapBypassCost` per step) |
| G1T5 | 2.62 / 2.69 / 3.00 ms | 0.5 – 1.0 ms | 0% (trap already placed / stock empty ⇒ sweep skipped) |

93.27 ms is 2.4× – 9.7× the measured cost of the entire fallback. The fallback cannot be
the 93 ms.

### 4.2 What is actually different in that run

`REPLICATION_24ROOTS.json` (uninstrumented, same frozen roots, same order, same source)
plus three further passes (`REPLICATION_24ROOTS_pass{1,2,3}.json`) give a clean answer.
Nodes expanded per 100 ms of main search, TIME-01 pass vs the four passes of this round:

| roots (fixture index) | TIME-01 `nodes` | this round `nodes` (4 passes) | **ratio** |
|---|---|---|---|
| G6T1 … G2T8 (index 0–14, n=15) | 295 … 1107 | 230 … 1218 | **0.78 – 1.08×** |
| G1T1 (index 15) | **128** | 1017 / 1207 / 1235 / 920 | **7.2 – 9.7×** |
| G1T2 … G1T4 (16–18) | 247 / 152 / 474 | 1043 … 1112 / 845 … 883 / 986 … 1029 | 2.1 – 5.8× |
| G1T5 (19) | **79** | 555 / 566 / 598 / 569 | **7.0 – 7.6×** |
| G1T6 … G1T9 (20–23) | 215 / 250 / 162 / 133 | 693 … 760 / 914 … 934 / 545 … 571 / 639 … 663 | 3.2 – 5.0× |

Per-node cost (`searchElapsedMs / nodes`), the quantity that separates “slower machine” from
“different tree”:

```
G5T4   0.154 (TIME-01)  vs 0.143 0.144 0.141 0.144 (this round)   → identical
G2T6   0.091            vs 0.109 0.100 0.096 0.098                → within +20%
G1T4   0.213            vs 0.103 0.102 0.098 0.098                → 2.1× slower then
G1T1   0.809            vs 0.100 0.084 0.082 0.110                → 7.4 – 9.9× slower then
G1T5   1.830            vs 0.203 0.200 0.187 0.198                → 9.0 – 9.8× slower then
```

The split is sharp and it is aligned with **sweep position, not with the position**:
indices 0–14 agree within 0.78–1.08×, indices 15–23 all differ by >2×. The current numbers
repeat across four independent passes (node-count spread per root: 3% G5T4, 4% G1T4, 13%
G2T6, 34% G1T1), i.e. nowhere near the 7–10× gap, so this is not random noise — it is a
property of *that* run.

Therefore, `SUPPORTED_MECHANISM`:

> In the P1-TIME-01 sweep the engine executed 2–10× less work per millisecond over the last
> nine roots of the sweep than it does in any pass of this round. For G1T1 that collapse is
> decisive: the depth-1 iteration could not finish 128 nodes inside 100 ms, so
> `completedDepth = 0`, `no_hard_plan` was logged, and the four heuristic steps ran
> (`fallbackReasons = [no_hard_plan, turn_main_window_closed ×4]`, `plannerInvocations = 1`
> — both inherited from the frozen artifact). The 196.83 ms is that fallback **on top of** an
> already-complete 150 ms planner block.

Decomposition of the frozen event, with grades:

| Claim | Value | Grade |
|---|---|---|
| planner block consumed its full turn wall (search 103.56 + sidecar remainder) | ≈150.4 ms | `SUPPORTED_MECHANISM` (measured directly on the same source: 150.46; the frozen row does not carry the sidecar split) |
| four heuristic cat steps | 9.6 – 38.7 ms measured | `SUPPORTED_MECHANISM` |
| **residual** 196.83 − 150.4 − 38.7 (worst case) | **≈ 7.7 ms** | `UNOBSERVED` — the frozen row has no per-phase data; candidates are a slower-than-worst-case fallback step under the same degraded throughput, or plan-execution overhead |
| “93.27 ms is the four heuristic moves” | — | `NOT_SUPPORTED` |
| trigger = depth-1 non-completion caused by the throughput collapse | — | `SUPPORTED_MECHANISM` |
| *cause of* the throughput collapse | — | **`UNOBSERVED`** — not inferable from the frozen artifact; candidates: CPU contention on the host, GC/heap growth over a 24-turn sweep, per-process throttling. Not investigated further, by design (no heavy reruns in this round) |

### 4.3 The current engine does not reproduce it, and that is itself the finding

Four independent 24-root passes (96 root-turns): min 104.19–105.50, p50 143.72–150.34,
p95 150.55–150.62, **max 151.35–151.81**, `withFallback = []` in all four.

> Number of turns in 96 root-turns that triggered the heuristic fallback: **0**.
> Number that exceeded 152 ms: **0**.

So the reproducible tail of the current engine is **150 ms + ≤1.81 ms**, and the 196.83 ms
record is an episode of degraded execution throughput, not a property of the current
engine + roots. `PROVEN_CAUSAL` for “not reproducible in 96 root-turns”; `UNOBSERVED` for
the cause of the original episode.

---

## 5. G1T5 — where the extra 32 ms of “search time” went

Frozen record: `searchElapsedMs 144.60`, `nodes 79`. This round: `112.54`
[111.72, 116.22], `nodes 437–603`. Detection is not the difference — it is on time in both
worlds (§2). The difference is the **post-detection return walk**, priced per leaf:

| | frozen sweep | this round |
|---|---|---|
| per-node cost implied | 1.83 ms | 0.20 ms |
| deadline cutoffs (sibling aborts) | ≈ 87–100 (same structure) | 78, 85, 86, 98 |
| cost per abort-path leaf eval | ≈ 0.45–0.50 ms (implied) | 0.107 ms measured |
| post-detection return | ≈ 44 ms (144.6 − 100.6) | **12.518 ms** measured |

The walk length is structural (fan-out), the price per leaf is environmental. Both terms are
measured in this round; only the product was inferred for the frozen sweep.
`SUPPORTED_MECHANISM`.

Consequence: for G1T5 the search legitimately *ends* at ~112 ms against a 100 ms budget —
**12.4 ms (8.2% of the turn)** is spent unwinding a deadline that was detected on time, and
~69% of that unwind is leaf evaluations whose values the search then discards (the iteration
is incomplete, so neither the value nor the plan is used).

---

## 6. The control roots confirm the model

* **G1T4** (120.97): depth 2 completed, sidecar probed all 6 candidates, all
  `NO_REFUTATION_FOUND`, ended on its own in 18.6 ms → turn ends 29.0 ms **before** the turn
  wall (`turnOvershootVsTotalWallMs = −29.04`). Nothing here is near a limit.
* **G5T4** (104.56): sidecar gated off (`mate_bypass`) → the turn is main search + 0.36 ms.
  This is the clean measurement of “search only”: 104.29 ms against a 100 ms budget, i.e.
  **4.3 ms of post-detection return**, 88% of which is abort-path leaf evaluation.

Both are consistent with §2 to within the sizes predicted by the cutoff counts. No residual
mechanism is needed to explain either. `PROVEN_CAUSAL`.

---

## 7. Inside the search: what the 100–112 ms is made of

`SearchProfiler` medians per turn (production profiler, already in the source; the
instrumented arm reports the same object):

| Root | core ms | evaluate | legalActions | transition | stateKey | ordering | Σ | **unattributed residual** |
|---|---|---|---|---|---|---|---|---|
| G1T1 | 101.63 | **38.94 (38%)** | 24.67 (24%) | 13.39 (13%) | 8.61 (8%) | 0.35 | 85.96 | **15.77 (15.5%)** |
| G1T5 | 112.44 | **74.94 (67%)** | 10.47 (9%) | 8.18 (7%) | 11.53 (10%) | 0.15 | 105.27 | **7.27 (6.5%)** |
| G1T4 | 101.84 | **37.87 (37%)** | 20.10 (20%) | 15.09 (15%) | 10.60 (10%) | 0.26 | 83.91 | **18.06 (17.7%)** |
| G5T4 | 104.16 | **49.56 (48%)** | 18.76 (18%) | 12.40 (12%) | 8.95 (9%) | 0.27 | 89.94 | **14.35 (13.8%)** |

Cross-check that the profiler is not inflating the evaluator: in-search cost per evaluation
is 0.112–0.153 ms; the independent micro-benchmark (`LEAF_COST.json`, 200 timed calls after
30 warm-ups, no deadline, no profiler) gives p50 0.104–0.133 ms and mean 0.144–0.161 ms for
`evaluateForCat`. Same number. `PROVEN_CAUSAL` that `evaluate` dominates because it is
called 254–667 times per turn at ~0.12 ms, not because it is measured generously.

`legalActions` at 24.7 ms on G1T1 is the second-largest single item — 638 calls, 38.7 µs
each. This is action enumeration, not evaluation.

**`UNATTRIBUTED_RESIDUAL_MS`**: the ledger leaves **6.5% – 17.7%** of the core search time
unexplained (7.27 – 18.06 ms). This is the profiler's blind spot: TT probe/store, node
accounting, allocation, and the JS call overhead itself. It is *not* claimed to be any
particular mechanism. Any future fix that only targets `evaluate` inherits this residual.

---

## 8. Claim ledger

| # | Claim | Grade | Evidence |
|---|---|---|---|
| 1 | `wall = planner + outside`, outside ≤0.13% | `PROVEN_CAUSAL` | 4 roots × 5 reps, residual ≤0.001 ms |
| 2 | `planner ≈ search + sidecar` (tax ≤0.28 ms) | `PROVEN_CAUSAL` | same |
| 3 | Node deadline cadence is 1; detection overrun 0.013–0.406 ms | `PROVEN_CAUSAL` | source `:52/:88` + 20 traces |
| 4 | Zero nodes are expanded after the first overrun | `PROVEN_CAUSAL` | `firstDlNode == nodes`, 20/20 |
| 5 | Post-100 ms cost = one abort-path leaf eval per pending sibling | `PROVEN_CAUSAL` | abort timer vs unwind, 4 roots |
| 6 | ~150 ms platform = sidecar spending the turn's remainder | `PROVEN_CAUSAL` | identity + `SIDECAR_DIAG` abort phases |
| 7 | Sidecar budget is per-candidate (6 candidates), total bounded only by the turn wall | `PROVEN_CAUSAL` | source topology + `candidateCount`/wall |
| 8 | Why one candidate probe exceeds 20 ms | `POSSIBLE` | two readings fit; not separated |
| 9 | 196.83 ms is not reproducible: 0/96 root-turns, max 151.8 | `PROVEN_CAUSAL` | 4 passes |
| 10 | 196.83 ms = 150 ms planner + 4 fallback steps + ≈7.7 ms residual | `SUPPORTED_MECHANISM` | frozen row + measured fallback cost |
| 11 | “93.27 ms = four heuristic moves” | `NOT_SUPPORTED` | fallback measured at 9.6–38.7 ms |
| 12 | Trigger of the fallback was depth-1 non-completion under 2–10× lower throughput on sweep indices 15–23 | `SUPPORTED_MECHANISM` | per-node cost table, 4 passes, sharp index split |
| 13 | Cause of that throughput collapse | `UNOBSERVED` | not measurable from the frozen artifact |
| 14 | G1T5's frozen 144.6 ms = on-time detection + a 44 ms walk priced at ~0.5 ms/leaf | `SUPPORTED_MECHANISM` | walk length + measured per-leaf cost |
| 15 | G1T5 current 112.5 ms = 100 + 12.5 ms walk (8.2% of turn) | `PROVEN_CAUSAL` | abort timer + cutoff counts |
| 16 | G1T4/G5T4 need no mechanism beyond §2 | `PROVEN_CAUSAL` | sidecar diag + accounting |
| 17 | `evaluate` is the largest search item (37–67%) and its per-call cost is corroborated independently | `PROVEN_CAUSAL` | profiler + micro-benchmark |
| 18 | 6.5–17.7% of search time is unattributed | `UNOBSERVED` | profiler blind spot |
| 19 | Traces are semantically identical to production (no strategy change) | `PROVEN_CAUSAL` | `INSTRUMENTATION_PARITY.json`, 20/20 A=B=C |
| 20 | Sidecar produced 0 overrides / 0 refutations on these 4 roots | `PROVEN_CAUSAL` | 32 invocations |

---

## 9. What this round does **not** establish

* Nothing about the other 20 roots' internals — only their wall time and node count were
  replicated.
* Nothing about distribution tails in real play: 4 roots × 5 reps, one process.
* Nothing about whether the sidecar is worth its 0–48 ms — that is an efficacy question, and
  `NEW_EFFICACY_AUTHORITY = NONE`.
* Nothing about the game-level UI cost: `TIMING_SCOPE.md` §1 shows the synchronous call is
  what blocks, but animation was never measured here.
* `ABSOLUTE_DEADLINE_GATE` remains `BLOCKED`: no frozen manifest exists for a complete cat
  turn, so none of these numbers is a gate verdict.
