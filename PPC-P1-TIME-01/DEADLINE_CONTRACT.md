# PPC-P1-TIME-01 — Deadline contract

## 1. Authoritative parameters (unchanged this round)

| Name | Value | Source |
|---|---|---|
| `DEFAULT_SEARCH_CONFIG.timeBudgetMsPerCatTurn` | **100 ms** | `src/game/ai/searchConfig.ts:18` |
| `HARD_TRIAL.totalTurnBudgetMs` | **150 ms** | `src/game/ai/searchConfig.ts:39` |
| `R1_AMEND.contract.MAIN_BUDGET_MS` | **100 ms** | `ai-training/f2b19be-r1-timing-cal-r1amend/r1_amend_timing_contract.json` |
| `R1_AMEND.contract.TOTAL_HARD_WALL_MS` | **150 ms** | same |
| `M1` gate family on `SEARCH_CORE_MS` | P95 120 / P99 125 / MAX 150 | `r2_timing_thresholds.pre.json` (via R1_AMEND bound authority) |
| `M2` gate family on `PLANNER_CALL_WALL_MS` | P95 165 / P99 190 / MAX 225 | same |

No budget constant was modified. `searchConfig.ts` is byte-identical to HEAD.

## 2. The intent was already written down — and contradicted

`searchConfig.ts:8-11` states:

> `timeBudgetMsPerCatTurn`: the search time budget is measured per COMPLETE cat
> turn, NOT per individual step. This avoids the old pattern of four independent
> ~100ms budgets inside computeCatAiTrajectory blocking the main thread four
> times per turn.

Measured behaviour before this round (`BASELINE_WITNESS`): a turn with an empty
plan received **5** independent full windows. The documentation described the
contract; the fallback path violated it.

## 3. What "one turn, one budget" means now

```
TurnDeadlineIdentity  (created ONCE, in computeCatAiTrajectory)
  startedAtMs             = T0                      ← one clock read
  mainSearchDeadlineAtMs  = T0 + 100
  totalTurnDeadlineAtMs   = T0 + 150
  now                     = the turn's clock (by reference)
```

Rules enforced:

1. **One owner.** Only `computeCatAiTrajectory` mints. `catAiMove` receives and
   forwards; `planHardCatTurn` inherits. A caller that passes no identity
   (standalone planner use, offline experiments, unit tests) keeps the legacy
   "this call owns its own turn" semantics — that is the ONLY place `t0 + budget`
   still exists.
2. **No re-basing.** `planHardCatTurn` computes `t0 = now()` for `elapsedMs`
   only. The deadlines come from the identity, verbatim.
3. **No second search after the wall.** `catAiMove(state, id)` checks
   `now < id.mainSearchDeadlineAtMs` before entering the planner; when closed it
   logs `SEARCH_FALLBACK reason=turn_main_window_closed` and uses `catAiHard`
   (a heuristic: no search, no clock, no budget).
4. **Sidecar and guard share one object.** `makeFiniteDeadline(totalTurnDeadlineAtMs)`
   is built once and passed to both. With an identity, `guardDeadline === turnDeadline`
   (asserted by object identity in `hardTurnAbsoluteDeadline.test.ts`).
5. **One clock.** `monotonicNow()` is exported from `deadlineContext.ts` and is
   the single clock reference of the AI layer; the identity carries it by
   reference so no consumer can open a second origin.

### Explicit non-guarantees

- The deadline is a **soft** stop: `deadlineReached()` samples the clock every 64
  interior nodes and `evalBatchDeadlineObserved()` every N evaluations. Nothing
  preempts a synchronous region. Overshoot is real and is measured (§5).
- `TOTAL_HARD_WALL_MS = 150` does **not** bound physical wall time of the whole
  turn: move execution, sidecar probes and bookkeeping all happen inside the
  turn and are not interruptible.

## 4. Absolute-deadline gate authority: MISSING

The repository contains gate families only for **two narrower measurement
domains**:

- `M1` = `SEARCH_CORE_MS` — the search core, not the turn.
- `M2` = `PLANNER_CALL_WALL_MS` — **one planner call**, explicitly not a turn.

There is no frozen manifest that defines a statistic, a sampling protocol and a
pass/fail threshold for "one complete Hard cat turn". Notion was not reachable
from this environment; the local search over `*.md` / `*.json` for
`absolute deadline gate manifest`, `M1_MAX_VALIDATION_GATE` and
`M2_MAX_VALIDATION_GATE` returns only the two domains above.

Consequently:

```
ABSOLUTE_DEADLINE_AUTHORITY = BLOCKED_MISSING_MANIFEST
ABSOLUTE_DEADLINE_GATE      = BLOCKED
```

This round neither invents a threshold nor borrows M2's 225 ms as a turn
allowance — those are different measurement domains and the R1_AMEND artifact
says so.

## 5. Measured overshoot (diagnostic, not a gate)

From `TIMING_RESULTS.json` — 24 frozen human roots, one real turn each,
production settings (guard OFF, sidecar ON):

| statistic | turn wall (ms) |
|---|---|
| min | 106.65 |
| p50 | 150.57 |
| p95 | 153.15 |
| max | 196.83 |

15 / 24 turns exceeded 150 ms of *physical* wall time, by 0.36–3.15 ms, except
`G1T1` at 196.83 ms (the fallback turn, which spends 4 heuristic moves plus the
search it already paid for). The search core itself measured 100.69–144.60 ms
inside the same turns.

Repeating the caveat that matters: **this is not a gate result.** It is the
honest measurement of a soft budget. The number that this round *can* prove is
the one that was broken: **planner invocations per turn = 1 in all 24 real
turns**, and every fallback call inherits the same absolute pair.

## 6. RULE-A separation

`applyNoMoveLoss` (rules/mobility) is untouched and remains the only source of a
"cat has no move ⇒ loss" verdict. An exhausted search budget produces
`catAiMove → null`, which the trajectory answers with
`forceCatMoveTowardsMouse` (a real legal move) — never a loss. The new
`turn_main_window_closed` log line exists precisely so that a time abort is
distinguishable from a rules verdict in the action log.
