# PPC-P1-PLAN-01｜PLAN_EXTRACTION_CALL_GRAPH — 计划提取数据流与全部长度限制审计

Scope: everything in `src/game` that can decide **how many actions a cat-turn plan may
contain**, and every consumer that depends on that number. Verified by grep on this branch
(see `SOURCE_MANIFEST.json` for the exact file hashes).

---

## 1. Data flow

```
                       ┌─────────────────────────────── search (unchanged) ───────────────────────────────┐
  GameEngineState ───▶ │ searchBestActionIterative → runFixedSearch → _searchInner                        │
                       │   writes, per visited node:                                                        │
                       │     ctx.planBranches[stateKey(state)]  = bestAction      (F1B-2 principal line)    │
                       │     ctx.equalPrimaryGraph[stateKey|depth] = {state, equalActions}   (proved ties)   │
                       └───────────────────────────────────────┬───────────────────────────────────────────┘
                                                               │  post-search, no clock, no second search
        ┌──────────────────────────────────────────────────────┼──────────────────────────────────────────┐
        │                                                      ▼                                          │
        │   finalizeCompletedIterationPlan ──▶ forcedLossTieBreak ──▶ buildCandidate ──▶ buildPlanForFirstAction
        │            (previousCompletedPlan)                      └─▶ extractBestCatTurnPlan (mate=null)     │
        │   searchBestAction / iterative loop ──▶ buildCatTurnPlan ──▶ extractBestCatTurnPlan (if a tie)    │
        └──────────────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                               ▼
                     HardTurnPlan.plan / debug.plan / debug.baselinePlan
                                                               │
              ┌────────────────────────────────────────────────┼──────────────────────────────────┐
              ▼                                                ▼                                  ▼
   runRefutationSidecar(plan)                       runProgressGuard(plan)            executor loop in
   (may override; policy unchanged)                 (may replace with R1;             computeCatAiTrajectory
                                                     policy unchanged)                 applyPlanCatAction per action
```

Key property of the fix: **only the boxed extractors changed**, and only their default
`maxLength`. The search, the sidecar, the guard, the executor and the deadline plumbing are
byte-identical.

---

## 2. The extractors (all of them)

| # | function | file:line | returns | pre-fix cap | post-fix default |
|---|---|---|---|---|---|
| 1 | `buildCatTurnPlan` | `expectiminimax.ts:1885` | principal-line walk from `planBranches` | `8` | `maxCatTurnPlanActions(state)` |
| 2 | `buildPlanForFirstAction` | `planQuality.ts:242` | plan starting with one forced first action | `8` | `maxCatTurnPlanActions(root)` |
| 3 | `extractBestCatTurnPlan` | `planQuality.ts:444` | DP over the equal-primary graph, else fallback walk | `8` | `maxCatTurnPlanActions(root)` |
| 3a | `extractDp` | `planQuality.ts` (recursive body of 3) | best plan under a prefix context | inherits 3, decremented per action | inherits |
| 3b | `fallbackPlanWalk` | `planQuality.ts` (fallback body of 3) | `planBranches` walk | inherits 3 | inherits |
| 4 | `buildCandidate` | `planQuality.ts:296` | scored candidate for the forced-loss tie-break | delegates to 2 | delegates to 2 |
| 5 | `finalizeCompletedIterationPlan` | `expectiminimax.ts:1928` | previous-completed-depth plan | delegates to 1 (via `iter.builtPlan`) / 2 / 3 | delegates |

### Call sites of each

| call site | file:line | what it feeds |
|---|---|---|
| `buildCatTurnPlan(state, ctx)` | `expectiminimax.ts:1971` | `searchBestAction().catTurnPlan` |
| `buildCatTurnPlan(state, ctx)` | `expectiminimax.ts:2295` | iterative-deepening `lastCatTurnPlan` (per completed depth) |
| `extractBestCatTurnPlan(...)` | `expectiminimax.ts:1973` | `searchBestAction().catTurnPlan` when `mate === null` |
| `extractBestCatTurnPlan(...)` | `expectiminimax.ts:2334` | final plan after the iterative loop (`mate === null`) |
| `extractBestCatTurnPlan(...)` / `forcedLossTieBreak(...)` | `expectiminimax.ts:1946-1948` | `finalizeCompletedIterationPlan` (`mate === null` / `mate === 'mouse'`) |
| `buildCandidate(root, pe.action, ctx, idx)` | `forcedLossTieBreak.ts:92` | candidate set for a proved primary tie |
| `buildPlanForFirstAction(root, firstAction, ctx)` | `planQuality.ts:303` | inside `buildCandidate` |
| `buildCatTurnPlan` / `extractBestCatTurnPlan` / `buildCandidate` | tests + probes only | — |

Consumers of the *final* plan, none of which has a length limit of its own:

| consumer | file:line | note |
|---|---|---|
| `HardTurnPlan.plan` | `hardTurnPlanner.ts:276, 381, 434, 444` | the plan, `debug.baselinePlan` (pre-override), `debug.plan` |
| `runRefutationSidecar(state, plan, …)` | `hardTurnPlanner.ts:375` | may replace the plan; its own budget/policy is out of scope this round |
| `runProgressGuard(...)` | `hardTurnPlanner.ts:395` | may replace with `search.previousCompletedPlan` |
| `applyPlanCatAction` per action | `engine.ts:4120-4139` | re-validates each action against the live state |
| `plan_exhausted` fallback | `engine.ts:4154-4166` | logs and hands the rest of the turn to the heuristic if the plan runs out early |
| `replayCatPlanLabel` | `progressGuard.ts:114` | replays whatever the label has; **no cap** |

---

## 3. Why the DP memo does not need the remaining capacity (task §5.3)

`extractDp` keys its memo on `(stateKey|depthTurns, prevCatStepKey)` while `maxLength` is
decremented along the recursion, so two paths reaching the same state at different depths
carry different remaining capacity. This is sound **because the capacity never binds**:

For a path that has spent `k` actions, the remaining capacity is `bound − k`. Since
`bound = maxCatTurnPlanActions(root)` bounds the length of *any* legal sequence from `root`,
and `k + (actions from here) ≤ bound` for every legal continuation, we get
`bound − k ≥ (actions from here)`. The `maxLength <= 0` cut is therefore unreachable for a
legal sequence, and a memo entry is a function of `(state, prefix)` alone.

This is a *proof of non-binding*, not a claim that `maxLength` should be removed: the argument
holds only while the default is used, which is why the default is now the proven bound and
never a constant. `PLAN-3` / `PLAN-6` check the observable consequence: every extractor's
output is identical to its `maxLength = 1000` output.

---

## 4. Every other length-ish limit in `src/game`, and why it is not this bug

| location | what it is | verdict |
|---|---|---|
| `expectiminimax.ts` `buildCatTurnPlan(maxLength=8)` | plan walk cap | **fixed** |
| `planQuality.ts` `buildPlanForFirstAction(maxLength=8)` | plan walk cap | **fixed** |
| `planQuality.ts` `extractBestCatTurnPlan(maxLength=8)` | plan cap (DP + fallback) | **fixed** |
| `planQuality.ts` `extractDp(maxLength)` | recursion budget of the DP | inherits the fixed default |
| `planQuality.ts` `fallbackPlanWalk(maxLength)` | plan walk cap | inherits the fixed default |
| `boundedPlanRefutation.ts:388` `actor === 'mouse' ? mouseMovesLeft : catMovesLeft` | `arrivalTime`: how many *steps* an actor can still take, used for **timing arithmetic** (arrival ordering), not for building a plan | not a plan-length cap; changing it would be a sidecar policy change (explicitly out of scope) |
| `boundedPlanRefutation.ts` `catExactReachWithin4` (`if (d >= 4) continue`) | a bounded reach set: "can the cat answer within 4 actions" | a *question*, not a plan; out of scope |
| `boundedPlanRefutation.ts` `FIXED_PATHS=32 / FIXED_CPU_MS=20 / FIXED_EXACT=16` | sidecar work caps | policy; out of scope (`SIDECAR_POLICY_CHANGE = NO`) |
| `progressGuard.ts:114` `replayCatPlanLabel` | iterates the label string; no cap | already unbounded |
| `engine.ts:4124` `maxSafety = catBaseMoves * 8 + 20` | executor loop guard (iterations, not plan length) | `1.5·M + 1 < 8·M + 20` for every `M ≥ 0`, so the plan bound is always inside it — no change needed |
| `engine.ts:1826` `plans.slice(0, 4)` | legacy heuristic (`catAiHard`) candidate list | different subsystem (not the hard plan path) |
| `hybridLeaf.ts:108` `butterPositions.slice(0, 8)` | feature-vector width in the evaluation | evaluation, not plan length |
| `engine.ts:240`, `3746`, `3750` `.slice(0, 3/4/6)` | UI/debug strings | not plans |
| `expectiminimax.ts` `maxDepthTurns`, `maxNodes` | search depth / node budget | search authority, unchanged |

No `slice(0, 8)`, `length > 8`, `=== 8` or any other fixed 8 related to plans remains in
`src/game` (grep `slice(0, *[0-9])|length > 8|length < 8|=== 8`).

---

## 5. Consumer-side invariants that did NOT change

| invariant | where | status |
|---|---|---|
| a plan is complete only if `planFullTurnCompleteness` says so | `planQuality.ts:175` | unchanged; `PLAN-2` shows an 8-action prefix is still `TRUNCATED` |
| a candidate with an incomplete plan is rejected (fail-closed) | `planQuality.ts:308`, `forcedLossTieBreak.ts:99` | unchanged; `PLAN-2` asserts `buildCandidate === null` for a truncated chain |
| the executor re-validates every action | `engine.ts:4434+` (`applyPlanCatAction`) | unchanged |
| a plan that runs out early triggers `plan_exhausted` | `engine.ts:4154` | unchanged |
| the sidecar's override rules | `boundedPlanRefutation.ts` | unchanged |
| the guard's rescue rules | `hardTurnPlanner.ts:499-693` | unchanged |
| one absolute deadline per cat turn | `deadlineContext.ts`, `engine.ts:4059` | unchanged |

---

## 6. What the fix does NOT reach

* No second search, no extra planner call, no new deadline read: the extractors take no clock
  at all (the only clock in the post-processing path is `buildCandidate`'s existing
  `isSearchDeadlineExceeded` fail-closed check, which is untouched).
* No rule change: `catMove` / `catPlaceTrap` / `simulateSearchAction` /
  `planFullTurnCompleteness` / the CHANCE boundary are not modified.
* No search-math change: `value`, `mate`, `bound`, `completed`, `cacheable`, TT behaviour,
  alpha-beta, move ordering, depth definition and the H1 evaluator are untouched. The proof
  is structural: the plan is extracted **after** the search returns, from
  `planBranches`/`equalPrimaryGraph`, and is not read by any search node.
