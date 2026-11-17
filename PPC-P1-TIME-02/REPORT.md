# PPC-P1-TIME-02｜Hard Cat 完整回合耗时尾部精确归因 — REPORT

**Round type:** diagnostic / attribution. **0-heavy.** No self-play, no oracle, no grid, no
fresh heavy benchmark, no production source change.

**Task, in one sentence:** explain *exactly* where the tail of a Hard Cat turn goes —
especially G1T1's 196.83 ms and G1T5's 144.60 ms — without asserting
`196.83 − 103.56 ≈ 93.27 ms of heuristic moves`.

**Answer, in one sentence:** the turn *is* the planner (99.87%, measured); the planner *is*
search + bounded-refutation sidecar; the ~150 ms platform is the sidecar spending the
remainder of the turn's own wall (37–48 ms on the two platform roots, producing **zero**
verdicts); the 196.83 ms record is **not reproducible** on the current engine (0 fallbacks in
96 root-turns) and was an episode in which the engine executed 2–10× less work per
millisecond over the last nine roots of that sweep — which is what starved depth 1 and
triggered the 4-step heuristic fallback that *is* the second half of that number.

---

## 1. What was done

| Step | Artifact |
|---|---|
| Froze the measurement boundary (four different timing domains, one clock) | `TIMING_SCOPE.md` |
| Static cost & call-graph audit of the turn path | `CALL_GRAPH_COST_AUDIT.md` |
| Trace protocol, anchor-based instrumentation, three-arm calibration | `TRACE_PROTOCOL.md`, `trace/patch_arm.py`, `trace/traceSink.template.ts` |
| Deterministic instrumentation diff (the arm is **not** in `src/`) | `INSTRUMENTATION_DIFF.patch`, `INSTRUMENTATION_MANIFEST.json` |
| 4 roots × 5 reps × 3 arms (A production / B probes inert / C probes live) | `TRACE_EVENTS.jsonl`, `TIMING_BREAKDOWN.json`, `INSTRUMENTATION_PARITY.json` |
| Turn-wide accounting (median + range per phase) | `TURN_ACCOUNTING.json`, `trace/aggregate.py` |
| 24-root replication of the P1-TIME-01 sweep, **four independent passes** | `REPLICATION_24ROOTS.json`, `REPLICATION_24ROOTS_pass{1,2,3}.json` |
| Fallback cost probe (closed-window branch, production heuristic) | `FALLBACK_COST.json` |
| Leaf-evaluation micro-benchmark (200 calls, 30 warm-ups) | `LEAF_COST.json` |
| Sidecar's own diagnostics (production field, no instrumentation) | `SIDECAR_DIAG.json` |
| Attribution with evidence grades | **`ROOT_CAUSE_FINDINGS.md`** |
| Fix directions (not implemented) | **`FIX_CANDIDATES.md`** |

Source identities are recorded in `SOURCE_MANIFEST.json` (14 files, sha256). The instrumented
arm is a byte-copy of `src/game` with 55 anchor-verified insertions; every insertion is
listed in `INSTRUMENTATION_MANIFEST.json`, and the patch is 484 diff lines
(`engine.ts` 35 hunks +53/−3, `hardTurnPlanner.ts` 9 hunks +18/−1, `expectiminimax.ts`
8 hunks +30/−1). The six removed lines are all *re-binding* rewrites, listed in
`TRACE_PROTOCOL.md` §2 — none changes a predicate, an order, a budget or a random draw.

---

## 2. The §4.2 correction, stated plainly

The task asked for the deadline-detection granularity to be checked, not inherited. It was:

* `DEADLINE_CHECK_INTERVAL = 1` (`expectiminimax.ts:52`, gate `:88`) — the clock is read at
  **every** interior node. The source comment at `:45`–`:51` says the 64-node cadence was
  the *old* overshoot mechanism and was replaced by 1.
* `EVAL_DEADLINE_CHECK_INTERVAL = 64` (`:67`, gate `:113`) — a **separate** leaf-batch
  observer, every 64th evaluation.

Measured overrun (first overrun observed − deadline): **0.013 – 0.406 ms**, n=20. A 64-node
blind window would be 7–10 ms at the measured per-leaf cost. Detection is per-node and it is
on time.

**So the overshoot is not detection latency.** It is what happens after detection:

* `firstDlNode == nodes` in **20/20** traced turns — not a single node is expanded after the
  deadline is seen;
* the remaining 1.0–16.2 ms is the **unwind**, in which each still-pending sibling re-enters
  the gate, takes the abort path, and **evaluates one leaf first** (`:1713`);
* 7–20 siblings on G1T1 (1.4–1.7 ms), **78–98** on G1T5 (**8.67 ms**, 69% of a 12.52 ms
  walk), 36–38 on G5T4 (3.74 ms).

That is the whole tail mechanism, and it is structural (fan-out), not accidental.

---

## 3. G1T1 — the 196.83 ms number, decomposed and then rejected

**Rejected:** “the excess is four heuristic cat moves”. The four steps cost **9.63 / 25.24 /
38.68 ms** in three direct measurements (production branch, production heuristic, real rule
set). 93.27 ms is 2.4–9.7× that.

**Reproduced:** the same 24 frozen roots, same order, same source, four independent passes:

```
min 104.19–105.50  p50 143.72–150.34  p95 150.55–150.62  max 151.35–151.81  withFallback = [] × 4
```

**0 fallbacks in 96 root-turns.** 196.83 ms is not a property of the current engine + roots.

**What it was.** Nodes expanded per 100 ms of search, P1-TIME-01 pass vs this round:

```
index  0–14 (G6*, G5*, G2*)   0.78 – 1.08×      ← identical
index 15     (G1T1)          128 nodes vs 1017/1207/1235/920   = 7.2 – 9.7×
index 16–18  (G1T2–T4)       2.1 – 5.8×
index 19     (G1T5)           79 nodes vs 555/566/598/569      = 7.0 – 7.6×
index 20–23  (G1T6–T9)       3.2 – 5.0×
```

Per-node cost 0.809 ms then vs 0.082–0.110 ms now on G1T1; 1.830 vs 0.187–0.203 on G1T5 —
while G5T4 (0.154 vs 0.141–0.144) and G2T6 (0.091 vs 0.096–0.109) are within 5–20% in both
worlds. The split is by **sweep position**, sharp,
and stable across four passes. Under that throughput G1T1's depth-1 iteration could not
finish (128 nodes / 100 ms ⇒ `completedDepth 0` ⇒ `no_hard_plan` ⇒ 4 heuristic steps ⇒
196.83 ms).

**Decomposition of the frozen event:** ≈150.4 ms planner (measured on the same source:
150.46) + 9.6–38.7 ms fallback + **≈7.7 ms `UNOBSERVED` residual**. The *cause* of the
throughput collapse is `UNOBSERVED` — the frozen artifact cannot carry it, and this round
deliberately does not re-run heavy work to find out.

**The current engine's real tail is 150 ms + ≤1.81 ms**, and it never falls back.

---

## 4. G1T5 — where the extra 32 ms went

Frozen: `searchElapsedMs 144.60` with `nodes 79`. This round: 112.54 [111.72, 116.22] with
437–603 nodes. Detection was on time in both worlds; the difference is the post-detection
walk priced per leaf (≈0.45–0.50 ms then, 0.107 ms now) over the same structural length
(≈79–100 siblings). `SUPPORTED_MECHANISM`.

Current G1T5, exactly: 150.38 = 112.54 search (100 budget + **12.52 ms walk**, 8.2% of the
turn, 69% of the walk being leaf evaluations whose values are then discarded) + 37.52 sidecar
+ 0.32 tax.

---

## 5. Why the platform is 150 ms and not 100 ms

```
G1T1  101.73 search + 48.27 sidecar = 149.998 → wall 150.459
G1T5  112.54 search + 37.52 sidecar = 150.058 → wall 150.384
G1T4  101.97 search + 18.58 sidecar = 120.552 → wall 120.967   (sidecar finished early)
G5T4  104.29 search +  0.00 sidecar = 104.288 → wall 104.561   (sidecar gated off)
```

`SIDECAR_DIAG.json` (production diagnostics, no instrumentation) explains the two 150s:

* `candidateCount = 6`, each candidate capped at `FIXED_CPU_MS = 20`, total bounded **only**
  by the shared turn deadline;
* on G1T1/G1T5 the **first** candidate was still expanding when the turn wall hit
  (`deadlineAbort = true`, `candidatesProbed = 0`, abort phase `probe_loop`/`probe_expansion`)
  — it spent 36.0–49.4 ms and produced no verdict, fail-closed to the baseline plan;
* on G1T4 all 6 candidates completed in 18.9–22.0 ms (`NO_REFUTATION_FOUND` ×6);
* on G5T4 the sidecar was gated off (`mate_bypass`);
* **0 overrides, 0 refutations** on the four roots: 32 measured turns (12 in `SIDECAR_DIAG`,
  20 traced), the sidecar actually entered on 24 of them, gated off on the 8 G5T4 turns.

The turn is not overshooting the 150 ms wall: it *is* the 150 ms wall, with ≤0.72 ms of
overshoot (the sidecar's own last clock read is 0.017–0.165 ms past it).

---

## 6. Inside the 100 ms (for completeness, and for the next round)

`evaluate` is the largest item (38.9 / 74.9 / 37.9 / 49.6 ms = 38/67/37/48%), corroborated by
an independent micro-benchmark (p50 0.104–0.133 ms vs in-search 0.112–0.153 ms — the profiler
is not flattering itself). `legalActions` is second on G1T1 (24.7 ms / 638 calls).
`ordering` is negligible (0.15–0.35 ms). **6.5–17.7% of the search is unattributed** — the
profiler's blind spot (TT, node accounting, allocation, call overhead).
`UNATTRIBUTED_RESIDUAL_MS` is registered as such, not absorbed into a story.

---

## 7. Instrumentation calibration (task §7.3)

Three arms, one process, serial, 4 roots × 5 reps:

* **A = B**, **B = C**: `INSTRUMENTATION_PARITY.json` — 20/20 trajectories identical on
  `steps / movesSpent / phase / catActionLog tail / endStateKey / detailPath / completedDepth
  / attemptedDepth / rootValue / mate / planLen`; `a_vs_b_fail = 0`, `b_vs_c_fail = 0`.
* **Wall effect:** C − A = −0.06 / −0.03 / +0.08 / **+0.44 ms** (−0.04% … +0.43%). The
  largest is G5T4 at +0.44 ms, which is inside A's own within-arm spread (103.9–105.6).
  The trace does not move the deadline stop, the depth reached, or the plan.
* Budget note: `catMove` counters of 3 597–4 362 per turn are **rule simulations** inside the
  search (`simulator.ts:46`), not executed moves; executed cat actions are 4–5 per turn
  (`applyPlanCatAction`). Registered so this number is never read as turn execution.

---

## 8. What this round did not do (and will not do without a new mandate)

* No production source change of any kind (`src/` untouched; `transposition.ts` still
  `7b4aa8eb…` from P1-ID, `deadlineContext.ts` `ced44944…`, `hardTurnPlanner.ts`
  `27b1ce6d…`, `engine.ts` `dbb5377a…` from P1-TIME-01).
* No fix implemented — `FIX_CANDIDATES.md` is a ranking, not a plan of record.
* No heavy benchmark, no self-play, no oracle, no new grid; the 24-root replication is 24
  turns × 4 passes and the trace is 4 roots × 5 reps.
* No commit, push, merge, rebase, reset, stash or clean.
* No efficacy claim about the sidecar beyond the four measured roots.

---

## 9. Final status block

```
PPC_P1_TIME_02_STATUS            = COMPLETE_WITH_REGISTERED_OPEN_ITEM
PRODUCTION_SOURCE_CHANGE         = NO
SOURCE_PROVENANCE                = src/game @ worktree (branch ppc/p1-id-state-identity-fix,
                                   HEAD 48eaac6 + P1-ID + P1-TIME-01, uncommitted);
                                   14 files sha256 in SOURCE_MANIFEST.json
P1_ID_PRESERVED                  = YES (transposition.ts 7b4aa8eb3fab994a4abc77fdf38800ab2a5f9da57d5eb33a1b37075e106c2d64, unmodified)
P1_TIME_01_PRESERVED             = YES (deadlineContext.ts ced44944…, hardTurnPlanner.ts 27b1ce6d…,
                                   engine.ts dbb5377a…, unmodified; P1-TIME-01 artifacts not overwritten)

G1T1_TRACE_CAPTURE               = CAPTURED_NOT_REPRODUCED_AS_RECORDED
                                   (frozen 196.83 ms / depth 0; this round 150.46 ms / depth 1, 5/5 reps)
G1T1_WALL_ACCOUNTING             = planner 150.262 (99.87%) + outside 0.197 (exec 0.051 + finalize 0.021 + 0.125)
G1T1_MAIN_COST_SOURCE            = planned-search 101.733 (evaluate 38.94, legalActions 24.67, transition 13.39,
                                   stateKey 8.61, ordering 0.35, unattributed 15.77) + sidecar 48.265 (0 candidates probed)
G1T5_TRACE_CAPTURE               = CAPTURED_MAGNITUDE_DIFFERS
                                   (frozen search 144.60 ms; this round 112.54 [111.72, 116.22], 5/5 reps)
G1T5_DEADLINE_DETECTION          = ON_TIME (first overrun 0.023 ms; cadence 1; 0 nodes expanded after detection)
G1T5_POST_DETECTION_RETURN       = 12.518 ms (78–98 sibling aborts, 8.674 ms = 69% in abort-path leaf evaluations)
TRACE_SEMANTIC_PARITY            = 20/20 A=B=C (a_vs_b_fail 0, b_vs_c_fail 0)
TRACE_OVERHEAD_CHARACTERIZED     = C−A ∈ [−0.06, +0.44] ms ([−0.04%, +0.43%]); within arm A's own spread
TURN_EXECUTION_RULE_PARITY       = PRESERVED (same executed moves, same end stateKey, same phase, same plan length)
ROOT_CAUSE_CLASSIFICATION        = PLATFORM: PROVEN_CAUSAL  (turn = planner = search + sidecar spending the turn wall)
                                   TAIL_196_83: NOT_REPRODUCIBLE + SUPPORTED_MECHANISM decomposition
                                   TAIL_196_83_TRIGGER: SUPPORTED_MECHANISM (depth-1 starvation under 2–10× lower throughput,
                                   sweep indices 15–23)
                                   TAIL_196_83_TRIGGER_CAUSE: UNOBSERVED
                                   POST_DEADLINE_WORK: PROVEN_CAUSAL (one discarded leaf eval per pending sibling)
                                   SIDECAR_DOMINANCE_OF_THE_100_150_WINDOW: PROVEN_CAUSAL
UNATTRIBUTED_RESIDUAL_MS         = search-internal 6.5%–17.7% (7.27–18.06 ms per turn, profiler blind spot);
                                   frozen-196.83 event ≈7.7 ms (UNOBSERVED)

ABSOLUTE_DEADLINE_GATE           = BLOCKED  (no frozen complete-cat-turn manifest exists; nothing here is a gate verdict)
NEW_EFFICACY_AUTHORITY           = NONE
FORMAL_PRIMARY_AUTHORIZED        = FALSE
COMMIT/PUSH/MERGE                = NO
```

**Open item carried forward (the only one):** the cause of the 2–10× throughput collapse that
confined itself to sweep indices 15–23 in the P1-TIME-01 pass is `UNOBSERVED`. It is
registered rather than explained, because explaining it would require exactly the kind of
repeat heavy sweep this round is not authorised to run.
