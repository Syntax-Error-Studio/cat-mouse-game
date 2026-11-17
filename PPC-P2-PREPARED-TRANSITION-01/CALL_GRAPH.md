# CALL_GRAPH — PPC-P2-PREPARED-TRANSITION-01

All line numbers refer to the **candidate** tree (`src/`) unless stated otherwise. This file
documents only what was read on the real call chain; nothing here is inferred from a text search
alone.

## 1. Entry points into the search

```
engine.computeCatAiTrajectory(state)                     src/game/engine.ts:4025
  └─ planHardCatTurn(state, opts)                        src/game/ai/hardTurnPlanner.ts:237
       └─ searchBestActionIterative(state, opts)         src/game/ai/expectiminimax.ts:2247
            └─ runFixedSearch(state, depth, ctx, nodeCount)   expectiminimax.ts:1844
                 ├─ stateKey(state)
                 ├─ generatePreparedSearchActions(state, rules)   ← ROOT batch (once)
                 ├─ probeTT(ctx, rootKey, depth, ext)
                 └─ searchActions(..., preparedFromCaller = rootBatch)   expectiminimax.ts:1208
```

`searchBestAction` (the public fixed-depth entry, used by every frozen D1 fixture) is the same path
without the iterative wrapper:

```
searchBestAction(state, depthTurns, ctx)                 expectiminimax.ts:2001
  ├─ runFixedSearch(...)
  │    ├─ generatePreparedSearchActions (ROOT)
  │    └─ searchActions(..., rootBatch)
  └─ buildCatTurnPlan / extractBestCatTurnPlan            (post-search plan extraction)
```

## 2. Node expansion

```
searchActions(state, depth, ctx, path, nodeCount, ply, alpha, beta, ext, key, inRootCatTurn, prepared?)
  ├─ prepared  = preparedFromCaller ?? generatePreparedSearchActions(state, ctx.rules)
  ├─ if prepared.length === 0 → RULE_EDGE_CASE_NO_LEGAL_ACTIONS (leaf eval, cacheable)
  ├─ ordering: computeOrderingScore(state, pa.transition, threat)   [ordering ONLY]
  ├─ TT bestAction hint → front of the sort (stable, originalIndex tie-break)
  └─ for each prepared action
       valueOfAction(pa.transition, ...)               expectiminimax.ts:1477
         ├─ deterministic → _search(next, ...)
         └─ chance        → Σ weight·_search(outcome.state, ...)   FULL WINDOW
```

`valueOfAction` receives the transition **object** — it never re-simulates. That was already true
before this round; what changed is where the transition comes from.

## 3. Action generation (the duplication that was removed)

### Before (baseline arm)

```
legalActions.generateLegalSearchActions(state, rules)
  └─ for each candidate: simulateSearchAction(state, cand, rules)   ← 1 sim per CANDIDATE
       └─ isEffective → gameAffectingEqual(state, res.state)

searchActions(state, ...)
  ├─ generateLegalSearchActions(...)                                 ← the sims above, then DISCARDED
  └─ prepared = actions.map(a => simulateSearchAction(state, a, rules))  ← 1 sim per LEGAL action

runFixedSearch(state, ...)
  └─ generateLegalSearchActions(state, rules)   ← ONLY to test `length === 0`, sims DISCARDED
```

Cost per expanded node: `candidates + legal` simulations. At the root: `candidates + legal` twice
(the empty-check pass and the `searchActions` pass) plus `legal` again for the prepared batch.

### After (candidate)

```
preparedActions.enumerateSearchActionCandidates(state)      ← pure, no simulation, one source of order
  ├─ terminal → []
  ├─ ChoosingTunnelExit → one per tunnelExitChoices (verifyEffectiveness = false)
  └─ Playing → DIRECTIONS… (+ mouseSkill / catPlaceTrap), verifyEffectiveness = true

preparedActions.generatePreparedSearchActions(state, rules)
  └─ for each candidate: simulateSearchAction ONCE → keep {action, transition, originalIndex}

legalActions.generateLegalSearchActions(state, rules)       ← public API unchanged
  └─ for each candidate: keep it if !verifyEffectiveness || isEffective(cand)
```

Cost per expanded node: `candidates` simulations total, root included.

## 4. Consumers that still call `generateLegalSearchActions` (deliberately untouched)

These are **not** the search node loop; they keep the legacy API and its exact semantics:

| Consumer | Site | Why it stays |
|---|---|---|
| `boundedPlanRefutation.ts` | sidecar refutation probe | not the main search; changing it would be a second optimisation |
| `planQuality.ts` | plan extraction / equal-primary | post-search, walks a plan once |
| `turnBoundary.ts`, `turnLazy.ts` | turn-level helpers | outside the node loop |
| `forcedLossTieBreak.ts` | tie-break plan walks | post-search |
| `openingFairness.ts` | opening certification DFS | separate solver (P1-OPENING-STACK), untouched |
| tests / fixtures | 20+ files | contract unchanged, they exercise the legacy API |

## 5. Files touched this round

| File | Change |
|---|---|
| `src/game/ai/preparedActions.ts` | **new** — candidate enumeration + prepared batch |
| `src/game/ai/legalActions.ts` | re-expressed on the shared enumeration; same output |
| `src/game/ai/expectiminimax.ts` | root + interior use the prepared batch; ~30 lines net |
| `src/game/ai/__tests__/preparedTransition.test.ts` | **new** — 18 contract tests |

Not touched: `engine.ts`, `config.ts`, `openingFairness.ts`, `evaluation.ts`, `transposition.ts`,
`hardTurnPlanner.ts`, `planQuality.ts`, `simulator.ts`, `searchTypes.ts`, the sidecar, the guard,
the mouse AI, `GAMEPLAY` rules, H1 weights, the 100 ms / 150 ms constants.
