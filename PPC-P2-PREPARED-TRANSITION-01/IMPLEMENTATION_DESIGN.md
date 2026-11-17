# IMPLEMENTATION_DESIGN — PPC-P2-PREPARED-TRANSITION-01

## 1. The defect (measured, not assumed)

`BASELINE_DUPLICATE_SIMULATION.json` was captured on the **unmodified** P1 tree before a single
production line was touched. It wraps the injected `RuleSet` and records, for every REAL engine
transition the simulator executes, the triple

```
(rule function, action identity, input stateKey)
```

Over one fixed-D1 search of the 24 frozen human roots:

| quantity | value |
|---|---|
| real engine transitions executed | **13 960** |
| distinct `(function, action, input state)` groups | **6 253** |
| groups executed more than once | **5 474** |
| redundant executions (`count − 1` summed) | **7 707** |
| groups whose repeats produced a DIFFERENT result | **0** |

Two facts follow directly:

1. **The duplication is real and large** — 7 707 of 13 960 transitions (55 %) recompute something
   the same node had already computed.
2. **The repeated work is pure** — 0 / 5 474 duplicate groups disagreed, so no input state is
   being polluted and no RNG is involved. That is what makes reuse safe rather than merely fast.

Per-node shape, exactly as the call graph predicts:

| site | simulations per legal action | evidence |
|---|---|---|
| interior node | 2 (legality pass + prepared pass) | histogram mode `2` dominates each root |
| root node | 3 (empty-check + legality + prepared) | root groups: `catMove:U/D/L/R → 3` |

After the fix, the same measurement gives:

| quantity | before | after |
|---|---|---|
| real engine transitions executed | 13 960 | **7 511** |
| distinct groups (coverage) | 6 253 | **6 253** (unchanged) |
| groups executed more than once | 5 474 | 672 |
| redundant executions | 7 707 | 1 258 |
| root `catMove:U/D/L/R` count | 3 | **1** |

The **group count is identical**, which is the strongest single statement about coverage: the fix
removed executions, not positions or actions. The 672 remaining duplicate groups are cross-node
re-expansions (the same state reached along two different paths), not one node simulating twice —
a structural consequence of there being exactly one `simulateSearchAction` per candidate per node.

All numbers: `_raw/duplicate_witness_pre.json` / `_raw/duplicate_witness_post.json`, produced by the
same probe file with `PHASE=pre|post`; the pre file was written before any source change and is
never regenerated.

## 2. Design choice: B, with A's single source of truth

The brief allowed either extending the public generator (A) or adding a search-only prepared
generator (B). I chose **B plus a shared enumerator**, because:

- extending `generateLegalSearchActions` would have changed the cost of **13 other call sites**
  (`openingFairness` DFS, the sidecar, plan extraction, turn helpers) that only want the action
  list — a semantic change to code this round must not touch;
- keeping two independent copies of "which actions, in which order, behind which precondition"
  risks exactly the silent divergence the brief warns about.

So the enumeration lives once, in `preparedActions.ts`:

```ts
enumerateSearchActionCandidates(state): { action, verifyEffectiveness }[]
```

- `generatePreparedSearchActions(state, rules)` — one simulation per candidate, keeps the transition
- `generateLegalSearchActions(state, rules)`  — public API unchanged, delegates to the same list

`verifyEffectiveness: false` exists for exactly one case: the tunnel-exit list, whose entries come
straight from `state.tunnelExitChoices`. The legacy generator never simulated them and still does
not, so a `ChoosingTunnelExit` node keeps byte-identical action generation (verified by a test that
asserts zero `chooseTunnelExit` calls during legality generation).

## 3. What the search does now

```ts
// interior node — expectiminimax.ts
const prepared: PreparedAction[] =
  preparedFromCaller?.map(toOrderable)
  ?? generatePreparedSearchActions(state, ctx.rules).map(toOrderable);

// root — runFixedSearch
const rootPrepared = generatePreparedSearchActions(state, ctx.rules);
if (rootPrepared.length === 0) { /* unchanged cacheable:false leaf */ }
...
searchActions(..., rootPrepared);
```

Everything downstream — ordering, TT hint, alpha-beta, MAX/MIN selection, tie rules, equal-primary
graph, plan extraction — is untouched and reads the same `transition` object it read before. The
only difference is that the object is the one the legality check produced.

`originalIndex` keeps its historical meaning: the index **in the legal list** (not the candidate
list), which is what the stable tie-break and the cutoff diagnostics use.

## 4. Safety of reuse

Reuse is only sound if a transition is a private, immutable snapshot. Verified two ways:

1. **Structurally**: every engine transition builds new objects (`{...state}`, `cloneBoard`,
   `[...arr]`), and `simulateSearchAction` returns a `SearchTransitionResult` that nothing writes to
   afterwards. A test asserts the root state is byte-identical after a full search.
2. **Empirically**: the same `(state, action)` simulated twice produced identical successor
   `stateKey`, identical full-state JSON, identical CHANCE outcome order/weights and identical
   probability mass — 5 474 duplicate groups, 0 disagreements (pre-fix run, which necessarily
   exercised both the discarded and the used copy).

No cross-node cache, no global mutable state, no memoisation: each node builds its own batch.

## 5. Diagnostic accounting

`SearchProfiler.legalActionsCalls` and `.transitionCalls` keep their meaning:

| counter | before | after |
|---|---|---|
| `legalActionsCalls` | 1 per batch built inside `searchActions` (root counted once) | 1 per batch built (root counted in `runFixedSearch`) — **same total** |
| `transitionCalls` | 1 per LEGAL action per node | 1 per LEGAL action per node — **same total** |
| `transitionMs` | prepared-pass time only | whole-batch time (legality of rejected candidates included) |
| `legalActionsMs` | legality pass only | whole-batch time |

The last two are wall-clock diagnostics with no decision power; their definitions are recorded here
because a reviewer comparing them to an old log would otherwise see a shape change and suspect a
regression. No test asserts their absolute values (checked: only `hv15SearchCostForensics` prints
them).

## 6. Frozen comparison arm

`arm/src` is a byte-copy of `src` with a provenance-checked delta:

| file | arm content | provenance |
|---|---|---|
| `ai/expectiminimax.ts` | pre-round bytes | `PPC-P1-CHECKPOINT-01/checkpoint/source/…` sha256 `8ac26985…` (= SEAL-01 `postSha256`) |
| `ai/legalActions.ts` | pre-round bytes | `git show 48eaac6c:src/game/ai/legalActions.ts` (blob `471f00d1…`) |
| `ai/preparedActions.ts` | absent | the module did not exist |

`BASELINE_MANIFEST.json` proves the isolation: 165 files, `onlyInArm = []`,
`onlyInSrc = [preparedActions.ts, preparedTransition.test.ts]`, `differing = [expectiminimax.ts,
legalActions.ts]`. Both arms therefore run the same engine, the same evaluator, the same config and
the same D1 protocol — 24 roots produced **0 differing fields** (`_raw/d1_parity.json`), so the
timing delta cannot be a workload delta.

## 7. Deliberately NOT done

- No change to `evaluateForCat`, H1 weights, `MATE_SCORE`, mate propagation, alpha-beta, TT
  admission (EXACT-only), `stateKey`, `EqualPrimaryGraph`, the plan bound, the 100 ms / 150 ms
  constants, `TurnDeadlineIdentity` ownership, the sidecar, the progress guard, the mouse AI or any
  `GAMEPLAY` rule.
- No second optimisation (the brief allows exactly one mechanism). The remaining 1 258 redundant
  transitions in the post-fix run are **cross-node re-expansions** — the same state reached by two
  different paths — not one node simulating twice. Removing those would need TT reuse or a
  DAG-aware search, i.e. a different mechanism and a different round.
- No change to the post-search plan extraction, which legitimately re-simulates a few root actions
  while walking the principal line (it has actions, not states, in `planBranches`).
