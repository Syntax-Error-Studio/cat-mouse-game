# PPC-P1-TIME-01 — Call graph of the cat-turn budget (pre-fix, source `48eaac6` + P1-ID candidate)

All line numbers refer to the pre-fix working tree
(`src/game/ai/transposition.ts` = P1-ID candidate `7b4aa8eb…`, everything else
identical to `48eaac6c4f3801d351787696ba5876995b64e8d8`).

## 1. Production entry points

```
src/pages/GamePage.tsx:204      computeCatAiTrajectory(catState)      ← ONE call per cat turn
src/game/engine.ts:3954         computeCatAiTrajectory(state)
src/game/engine.ts:3859         catAiMove(state)                    ← exported; 3 internal callers only
src/game/ai/hardTurnPlanner.ts:220  planHardCatTurn(state, opts)
src/game/ai/expectiminimax.ts:2198  searchBestActionIterative(state, opts)  ← ONE production caller
```

`catAiMove` has **no caller outside `computeCatAiTrajectory`** in `src/`
(verified: `grep -rn "catAiMove(" src --include=*.ts`). It is exported, so an
external caller would still be allowed — and, standalone, it legitimately owns
the whole turn.

## 2. The trajectory

```
computeCatAiTrajectory                                    engine.ts:3954
├─ early returns (not cat / not playing / no moves)        :3955-3956
├─ isHardTurn                                              :3969
├─ [Hard] planHardCatTurn(current, …)      ← planner #1    :3997
│     timeBudgetMs = 100, refutation.totalTurnBudgetMs = 150
├─ current.lastHardSearch = planned.debug                  :4008
├─ pendingHistoryEntry (from planner #1 only)              :4017
├─ no plan → execFacts.fallbackOccurred + log              :4042-4051
└─ while (catMovesLeft > 0 && Playing && stuck < 5)        :4059
   ├─ plan-driven step: applyPlanCatAction → real catMove / catPlaceTrap   :4072
   ├─ plan_action_invalid  → catAiMove(current)  ← planner #2..N           :4083
   ├─ plan_exhausted       → catAiMove(current)  ← planner #2..N           :4100
   ├─ no plan (null)       → catAiMove(current)  ← planner #2..N           :4102
   └─ AI returned null     → forceCatMoveTowardsMouse (no planner)         :4109 / :4168
```

`catAiMove` on the fallback path re-enters the **Hard** planner before it ever
reaches the cheap heuristic:

```
catAiMove(state)                                          engine.ts:3859
├─ sanitizeItemOverlaps
├─ difficulty === Hard → planHardCatTurn(state, {…})      :3874   ← planner #N
│    └─ plan available → catMove / catPlaceTrap           :3886-3887
└─ no plan → logFallback("no_hard_plan") → catAiHard      :3891-3893
```

`catAiHard` (engine.ts:2754) is a pure heuristic — BFS/score ordering, **no
search**. So the "legacy fallback" is not itself expensive; the expense is the
full 100 ms search that `catAiMove` performs *before* it will fall back.

## 3. Where budget is minted (the defect)

`planHardCatTurn` is the only place a main-search window is created:

```
hardTurnPlanner.ts:224   const now = opts.now ?? performance.now
hardTurnPlanner.ts:225   const t0 = now()                                     ← fresh origin per CALL
hardTurnPlanner.ts:226   const deadlineMs = t0 + opts.timeBudgetMs            ← fresh 100 ms per CALL
hardTurnPlanner.ts:271   makeFiniteDeadline(t0 + (sidecarBudgetMs ?? guardBudgetMs), now)
                                                                              ← fresh 150 ms per CALL
hardTurnPlanner.ts:292   turnDeadline.remainingMs()   (sidecar entry gate)
hardTurnPlanner.ts:334   runRefutationSidecar(… deadline: turnDeadline …)
hardTurnPlanner.ts:354   runProgressGuard(… deadline: guardDeadline …)
```

Because `t0` is read *inside the call*, the 100 ms / 150 ms windows are
per-**call** windows, not per-**turn** windows. Within one call the sidecar and
the guard already share one object (R1E §6/§8); nothing shares anything
*across* calls.

## 4. Answers to the audit questions (§5.1)

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Max `planHardCatTurn` per real turn | `1 + catBaseMoves` (1 + 4 = 5 at the default) | `BASELINE_WITNESS`: empty = 5, invalid = 5, truncated = 4, complete = 1 |
| 2 | Paths recomputing `now() + 100` | every `planHardCatTurn` call, i.e. planner #1 plus each fallback step | hardTurnPlanner.ts:225-226 |
| 3 | Paths recomputing `now() + 150` | the same call, hardTurnPlanner.ts:271 → sidecar **and** guard | hardTurnPlanner.ts:271/292/334/354 |
| 4 | `catAiMove` called outside the trajectory? | No production caller; 3 internal call sites, all inside the loop | `grep -rn "catAiMove(" src` |
| 5 | Several entries each owning a full turn budget? | **Yes** — `computeCatAiTrajectory` and `catAiMove` both mint; the second entry always wins | planner #2..N each got 100/150 |
| 6 | Does a normal complete-plan turn plan once? | Yes, 1 invocation | `BASELINE_WITNESS.complete.plannerInvocations = 1` |
| 7 | Is the fallback's "legacy heuristic" really the heuristic? | **No, not immediately** — `catAiMove` re-enters the Hard planner first (engine.ts:3874) and only reaches `catAiHard` (engine.ts:3893) after that search yields nothing | planner #2..N present in all three fallback scenarios |
| 8 | Other expensive synchronous work after the wall? | No further search. Post-turn work is `buildHardTurnExecutionStatus`, `pushHardHistory`, and — only when the guard flag is ON — `classifyExecutedCatTurn`. All O(board) bookkeeping, no clock, no search | engine.ts:4229-4301 |

## 5. Why this is a contract violation, quantitatively

One turn at `catBaseMoves = 4` can be *granted* `5 × 100 ms` of main search and
`5 × 150 ms` of total-turn wall — against a contract that says 100 ms / 150 ms
**per turn**. That is a grant bug, not a measurement: the witness records the
arguments each call received, and every one of them is a full, freshly-minted
window (`receivedAbsoluteDeadline = false` on all 15 calls across the three
fallback scenarios).

The defect does **not** prove any real turn actually spent 500 ms — a search
that finishes early returns early. It proves that nothing in the code prevents
it, and that the number of granted windows is a function of how the plan fails.

---

# 6. Post-fix call graph (candidate tree)

The entry point is `computeCatAiTrajectory`. It mints the turn's identity ONCE,
before the first planner call, and threads the same object by reference into
every planner call the turn makes.

```
computeCatAiTrajectory(state, now = monotonicNow)          engine.ts:3989
├─ isHardTurn                                              :4017
├─ hardTurnDeadline = makeTurnDeadlineIdentity(            :4056
│      now(), 100, 150, now)          ← THE ONLY clock read that creates a window
│      startedAt            = T0
│      mainSearchDeadlineAt = T0 + 100
│      totalTurnDeadlineAt  = T0 + 150
├─ planHardCatTurn(current, { …, turnDeadline })   ← planner #1   :4062
│      main search deadline = turnDeadline.mainSearchDeadlineAtMs   (absolute)
│      sidecar/guard wall   = turnDeadline.totalTurnDeadlineAtMs    (absolute)
└─ while (…)
   ├─ plan_action_invalid → catAiMove(current, hardTurnDeadline)   :4150
   ├─ plan_exhausted      → catAiMove(current, hardTurnDeadline)   :4167
   └─ no plan             → catAiMove(current, hardTurnDeadline)   :4169
```

```
catAiMove(state, turnDeadline?)                            engine.ts:3863
├─ Easy   → catAiEasy
├─ Hard ─┬─ turnDeadline present AND main window CLOSED    :3897
│        │    → logFallback("… turn_main_window_closed …") :3898
│        │    → catAiHard    (heuristic, NO search)        :3904
│        └─ otherwise → planHardCatTurn({ …, turnDeadline }) :3906
└─ no plan → logFallback("no_hard_plan") → catAiHard        :3926
```

```
planHardCatTurn(state, opts)                               hardTurnPlanner.ts:237
├─ now     = opts.now ?? opts.turnDeadline?.now ?? monotonicNow   ← ONE clock
├─ t0      = now()                       ← per-CALL origin (elapsedMs only)
├─ mainDeadlineAtMs =
│     opts.turnDeadline ? turnDeadline.mainSearchDeadlineAtMs
│                       : t0 + opts.timeBudgetMs        ← legacy standalone path
├─ searchBestActionIterative({ …, deadlineMs: mainDeadlineAtMs, now })
├─ turnTotalDeadlineAtMs =
│     opts.turnDeadline ? turnDeadline.totalTurnDeadlineAtMs
│                       : t0 + (sidecarBudgetMs ?? guardBudgetMs)
├─ turnDeadline  = makeFiniteDeadline(turnTotalDeadlineAtMs, now)   ← ONE object
└─ guardDeadline = opts.turnDeadline ? turnDeadline : (…)
      → runRefutationSidecar({ deadline: turnDeadline })
      → runProgressGuard({ deadline: guardDeadline })
```

## 6.1 What changed, in one line of causality

`t0` used to be **both** the metric origin **and** the budget origin. It is now
only the metric origin; the budget origin is `TurnDeadlineIdentity.startedAtMs`,
created once per turn at the only place that knows a turn exists.

## 6.2 Re-audit of the §5.1 questions

| # | Question | Post-fix answer |
|---|---|---|
| 1 | Max `planHardCatTurn` per turn | still `1 + catBaseMoves` *invocations*, but at most **1** can search: every later call gets the same absolute main deadline and returns immediately once it has passed |
| 2 | Paths recomputing `now() + 100` | only the standalone (no-identity) path, which by definition owns its own turn. Zero such paths inside `computeCatAiTrajectory` |
| 3 | Paths recomputing `now() + 150` | none when an identity is supplied — `turnTotalDeadlineAtMs` is inherited |
| 4 | `catAiMove` outside the trajectory | unchanged: no production caller |
| 5 | Several entries owning a full turn budget | **no** — `catAiMove` receives the identity; it cannot mint |
| 6 | Normal turn plans once | unchanged, 1 invocation (`TIMING_RESULTS.json`: max = 1 over 24 real roots) |
| 7 | Fallback re-enters the search? | only while the ORIGINAL window is still open; once it closed the call goes straight to `catAiHard` |
| 8 | Other expensive sync work after the wall | unchanged (O(board) bookkeeping, no search, no clock) |
