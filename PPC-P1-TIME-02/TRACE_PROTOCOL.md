# PPC-P1-TIME-02 — TRACE PROTOCOL

How the timeline was obtained without touching `src/`.

## 1. Shape

Three arms, one process, serial:

| arm | what it is | used for |
|---|---|---|
| **A** | production `src/game`, no probe code compiled in | ground truth for the turn signature |
| **B** | instrumented arm copy, sink **disabled** | "did compiling the probes in change anything?" |
| **C** | instrumented arm copy, sink **enabled** | the timeline |

A/B answers code-presence parity; B/C answers observation parity. Only
trajectories where A = B = C are used for causal claims.

## 2. The arm

`PPC-P1-TIME-02/trace/arm/game/` is a **byte copy of `src/game`** (`__tests__`
pruned) plus the instrumentation. `src/` is not modified, not staged, not
stashed.

Reproduce it with:

```bash
python PPC-P1-TIME-02/trace/patch_arm.py
```

The script:

* verifies **SHA-256 of each source file** against the exact candidate it
  instruments, and verifies the arm copy is still byte-identical — mismatch
  aborts with **zero writes** (fail closed);
* applies **anchor-based** insertions with an expected occurrence count; an
  anchor that moved or became ambiguous aborts instead of guessing;
* writes `INSTRUMENTATION_MANIFEST.json` (source sha → instrumented sha, every
  anchor used) and `INSTRUMENTATION_DIFF.patch`;
* rebuilds the arm from `src/game` on every run (a stale arm can never be mistaken
  for a fresh one) and **preserves each file's own line endings byte-for-byte**
  — this repository mixes conventions (`engine.ts` is CRLF, the AI modules are LF),
  so anchors are authored in LF space, applied in LF space, and the result is
  converted back to the file's own convention before writing. Without this the
  diff degenerates into a whole-file rewrite and stops being reviewable.

Instrumented SHAs this round (final, after the byte-faithful rebuild):

| file | src sha256 | arm sha256 | edits |
|---|---|---|---|
| `engine.ts` | `dbb5377af22a6471…` | `63c99f62e7a50dbe…` | 37 |
| `ai/hardTurnPlanner.ts` | `27b1ce6dc62234d0…` | `0dd05e87d74f1be0…` | 9 |
| `ai/expectiminimax.ts` | `9b976ec9bdbfd2cc…` | `78a08b25b0b95c56…` | 9 |
| `ai/traceSink.ts` | *(does not exist in src)* | `f8f94d7eb1765a2b…` | — |

`INSTRUMENTATION_DIFF.patch` is 484 lines: `engine.ts` 35 hunks (+53/−3),
`ai/hardTurnPlanner.ts` 9 hunks (+18/−1), `ai/expectiminimax.ts` 8 hunks (+30/−1).
All 6 removed lines are the *re-binding* rewrites catalogued in §4 — every one of
them binds an existing expression to a local so it can be timed, and none changes
a predicate, an ordering, a budget or a random draw:
`return catAiHard(closed);` / `return catAiHard(state);` (timed, same value
returned), the sidecar's `refutation = { … }` (timed at its construction), and
`deadlineReached`'s single clock read.

## 3. What the probes are

`traceSink.ts` is an arm-only module: a bounded (6 000 event) ring of
`{t, ev, m}` where `t = performance.now()` at the mark. `TRACE.mark()` returns
immediately when disabled; `bump()` only pays a hash lookup while tracing.

Event vocabulary (fixed, 17 marks):

```
turn_enter  planner_enter  planner_return  plan_decided  step_begin
plan_action_applied  exec_done  turn_return
catAiMove_enter  catAiHard_enter  catAiHard_return  planner_return_probe
hard_body_enter  phase_mousePlans  phase_emergency  phase_trapStand
phase_candidateLoop  hard_body_leave
planner_fn_enter  planner_fn_return  search_enter  search_return  search_stats
iter_enter  search_loop_done  search_post_plan_done  sidecar_return  guard_return
deadline_first_observed
```

Counters (own-property ints on a null-prototype bag): `bfsPath`,
`bfsCatPathToStand`, `bfsDistance`, `countMouseEscapeRoutes`,
`estimateTrapBypassCost`, `chooseHardTrapStandCell`,
`findNearestHolePathForHard`, `findEmergencyHoleBlockDecision`,
`chooseHardStrategicTarget`, `shouldCommitTrapPlan`, `computeCatBoxAdjacency`,
`applyPlanCatAction`, `forceCatMoveTowardsMouse`, `catMove`, `catPlaceTrap`,
`nodeDeadlineHits`, `evalDeadlineHits`, `evalAfterDl`, `abortEvalCount`,
`abortEvalMs`.

## 4. The rewrites that are not pure insertions

Three statements (six diff lines) had to be re-bound to a local instead of inserted
around. Every one of them evaluates exactly the same expression, in the same order, and
produces the same value; the local exists only so a timer can bracket it.

**(a) `deadlineReached`** (`expectiminimax.ts:86`) used to return `clock() >= ctx.deadlineMs`
directly. In the arm it binds that single read to a local so the **first**
overrun observation of a search can be reported:

```ts
const sampled = clock();
const over = sampled >= ctx.deadlineMs;
if (over) { /* first time → mark deadline_first_observed */ }
return over;
```

The predicate, the number of clock reads, and the return value are unchanged.

**(b) the two `catAiHard` returns in `catAiMove`** — `return catAiHard(closed);` and
`return catAiHard(state);` became `const v = catAiHard(…); mark; return v;` so the heuristic
step's wall time and its `null`-ness could be recorded.

**(c) the sidecar assignment in `planHardCatTurn`** — `refutation = { …sidecar.diagnostics,
refutationWallMs: now() - refStart }` is now timed from a captured `refStart`, which changes
*when* the subtraction happens by the duration of an object spread and nothing else.

Everything else in the patch is an inserted statement.

## 5. What was NOT done

* No `Math.random` patching, no `performance.now` monkey-patching.
* No change to a budget, a deadline, a weight, an ordering, an abort rule or a
  random draw.
* No `console.log` inside a timed region — the sink buffers, the harness prints
  after the turn.
* No second search architecture, no re-implementation of any rule.

## 6. Parity results (`INSTRUMENTATION_PARITY.json`)

20/20 rows (4 roots × 5 reps) identical across A, B and C on:

```
steps, movesSpent, phase, catActionLog tail (last 6 entries), end-state stateKey,
per-step detail path, completedDepth, attemptedDepth, rootValue, mate, planLen
```

`a_vs_b_fail = 0`, `b_vs_c_fail = 0`.

Turn-level wall times are **not** a parity criterion and were not used as one:
the turn is budget-capped, so the trace cannot push it past its own deadline —
it would show up as an earlier search stop, which the depth/value fields would
have caught and did not.

## 7. Bounded-ness (0-heavy)

| probe | scale | wall |
|---|---|---|
| `run_trace` | 4 roots × 5 reps × 3 arms = 60 turns | ~8 s |
| `fallback_cost` | 2 roots × 4 steps × 3 reps | ~2 s |
| `replicate_24roots` | 24 roots × 1 turn | ~4 s |
| `micro_eval` | 2 roots × 2 evaluators × 230 calls | ~1 s |

One process at a time, `fileParallelism: false`, no self-play, no oracle, no
sweep. Node processes present during the round were the three WorkBuddy
infrastructure processes; no benchmark worker was running before, during or
after.

## 8. Commands

```bash
python PPC-P1-TIME-02/trace/patch_arm.py
PPC_REPS=5  npx vitest run --config PPC-P1-TIME-02/trace/vitest.config.mts run_trace
PPC_FB_REPS=3 npx vitest run --config PPC-P1-TIME-02/trace/vitest.config.mts fallback_cost
npx vitest run --config PPC-P1-TIME-02/trace/vitest.config.mts replicate_24roots
npx vitest run --config PPC-P1-TIME-02/trace/vitest.config.mts micro_eval
python PPC-P1-TIME-02/trace/aggregate.py
```

The sidecar probe and the repeated 24-root passes were added after the first sweep, for the
two questions the trace could not answer on its own:

```bash
# what the sidecar probed and why it stopped (reads production diagnostics, no instrumentation)
npx vitest run --config PPC-P1-TIME-02/trace/vitest.config.mts sidecar_diag

# repeated passes of the same 24-root sweep (writes pass-numbered files)
for i in 1 2 3; do PPC_PASS=$i npx vitest run \
  --config PPC-P1-TIME-02/trace/vitest.config.mts replicate_24roots; done
```

## 8. `sidecar_diag` — why it is not an instrumented probe

`sidecar_diag.test.ts` imports **production** `src/game` (not the arm) and reads
`plan.debug.refutation`, a field the planner already fills for the debug panel. The
measured path therefore contains no probe code at all; the only addition is one
`performance.now()` bracket around the whole `planHardCatTurn` call and one around its
`elapsedMs`, both reported separately. That is why its wall figures can be quoted next to
the arm's without any calibration.
