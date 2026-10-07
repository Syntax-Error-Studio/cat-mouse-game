# Phase D1 — EXACT Transposition Table · Final Acceptance Report

**Date:** 2026-08-17
**Scope:** D1 only (EXACT TT). No Alpha-Beta, no LOWER/UPPER bounds, no Move Ordering, no Iterative Deepening.
**Status:** ✅ All D1 auto-tests pass. Phase C / D0 results unchanged.

---

## 1. Acceptance summary

| Criterion | Result |
|---|---|
| Phase C / D0 search output unchanged (TT off = prior algorithm) | ✅ `npm test` 78/78 pass |
| Same complete state at same `depthTurns` not re-expanded on 2nd appearance | ✅ (D1-A, D1-I) |
| Total auto-test count | **78** across 3 files (incl. all D1-A…K, D1-K-min, D1-inv, D1-Purity ×2) |
| TT ON/OFF 100% consistency on complete searches | ✅ (D1-B, D1-C, D1-D, D1-J) |
| `searchBestAction` root EXACT hit requires `bestAction` | ✅ (D1-inv) |
| Typecheck (`tsc --noEmit -p tsconfig.app.json`) | ✅ clean |
| Lint (`src/game/ai/**`) | ✅ clean |

---

## 2. TT counters on a real transposition fixture

Fixture: `openArena({cat:{4,4}, mouse:{6,6}, catMovesLeft:2, mouseMovesLeft:2})` @ `depthTurns=3`
(both TT-on and TT-off searches complete: `budgetCutoffs = 0`).

| Metric | TT OFF | TT ON |
|---|---|---|
| `nodes` (internal nodes expanded) | **31,783** | **901** |
| `ttProbes` | 0 | 1,580 |
| `ttHits` | 0 | 679 |
| `ttExactHits` | 0 | 679 |
| `ttDepthMismatches` | 0 | 0 |
| `ttStores` | 0 | 126 |
| `tt.size` (entries) | 0 | 126 |
| `value` / `mate` | — | **identical to OFF** ✅ |

TT gives a **~35× node reduction** on this fixture, with identical value/mate.
(Depth-mismatch is exercised cross-search by D1-C/D1-D; within a single search the
same state is recomputed at the same remaining depth, so intra-search mismatches are 0.)

---

## 3. Each D1 requirement — verified by

- **D1-A** Simple EXACT hit: same `state+depth` twice → `ttExactHits>0`, nodes drop, value/mate identical.
- **D1-B** Real transposition within one search: two move orders reach the same state, second hits TT.
  Preconditions `budgetCutoffs===0` + `completed===true` on BOTH sides asserted before comparing.
- **D1-C** Depth mismatch (cached d=1, request d=3): entry probed, `ttDepthMismatches>0`, no exact; cached d=1 value NOT returned (values differ by depth). Also checks cached entry carries `depthTurns===1`.
- **D1-D** Depth mismatch (cached d=3, request d=1): entry probed, `ttDepthMismatches>0`, `ttExactHits===0`; TT-on == TT-off value/action/mate. Checks cached entry carries `depthTurns===3`.
- **D1-E** Mate metadata (`mate='cat'`) preserved through an EXACT hit — not degraded to `null`.
- **D1-F** Mate distance preserved node-local; parent propagation identical fresh vs hit.
- **D1-G** Repetition-dependent results never cached (table stays empty; 2nd search re-derives same value).
- **D1-H** Budget-cutoff (incomplete) root NOT cached: `ctx.tt.get(stateKey(S))` is `undefined`; raising budget re-expands and does NOT reuse the truncated value.
- **D1-I** Same **object** CHANCE root reused for both searches → proves purity + `stateKey` stability + root EXACT TT hit; `value === MATE_SCORE-1`, `mate==='cat'`.
- **D1-J** TT disabled vs enabled: identical `value`/`mate`/`bestAction` on mate + open + CHANCE fixtures; completeness (`budgetCutoffs===0`) proven first.
- **D1-K** EXACT node requires **ALL** actions completed+cacheable: a budget-cutoff sibling forbids caching the root (root `cacheable=false`).
- **D1-K-min** MIN mirror: a repetition sibling makes the root non-cacheable (`cacheable=false`, `stateKey` absent from TT).
- **D1-inv** Root EXACT entry missing `bestAction` is NOT trusted; full search runs and the entry is repaired with a real `bestAction`.
- **D1-Purity (×2)** `recursiveDeepFreeze` + same-object re-search prove the engine transitions never mutate the input root (TT off and on).

---

## 4. Bugs found & fixes

### 4.1 D1-D test-design bug (TEST, not production) — root cause of `ttDepthMismatches===0`
`catCorridor({r:1,c:3})` and `openArena` are **non-cacheable at depth 3**: their deeper
searches hit cat/mouse oscillation (repetition guard fires, root `cacheable=false`), so **no
`S@3` entry is ever written**. The original D1-D premise ("a depth-3 cached entry exists to
mismatch against") was therefore false → `ttDepthMismatches` stayed 0.
**Fix:** D1-D now uses `boxedForcedMate` — a mate-in-1 that terminates immediately, so it has
no oscillation and its root IS cacheable at depth 3 (the codebase's canonical guaranteed-
cacheable fixture, already used by D1-E). Added `ttExactHits===0` guard so a hypothetical
"mismatch treated as exact" bug would be caught.

### 4.2 D1-Purity timeout (TEST perf)
At `depth=4` + `defaultRuleSet`, `chanceRoot` triggers board-wide butter-spawn CHANCE
enumeration (~all empty cells as outcomes), exploding to ~44s/25s and exceeding the 5s limit.
**Fix:** reduced purity depth to 2. Purity is a property of the engine transitions, which any
depth exercises; depth 2 keeps both tests <60ms.

### 4.3 No production-code bugs
`probeTT` / `storeTT` / `searchBestAction` logic was already correct; MAX/MIN aggregation over
**ALL** actions (not just the chosen child) was already correct; the earlier "search mutates
input" hypothesis was disproven (D1-Purity now locks it in). No change to `engine.ts` /
`simulator.ts` was required or made.

---

## 5. Design invariants preserved (D1)
- One `TranspositionTable` per `SearchContext`; never shared across contexts/RuleSets; no singleton; no localStorage.
- `TTEntry = { depthTurns, value, mate, bestAction? }`; only `completed && cacheable` results are stored (node-local, path-independent).
- Probe order: terminal → repetition guard → depth limit → budget guard → TT probe → actions → recurse → store.
- EXACT hit requires `entry.depthTurns === requestedDepthTurns` (no `>=`, no LOWER/UPPER).
- Replacement policy: keep a deeper existing entry; overwrite only when `new.depthTurns >= old`. Exact reuse still requires exact depth match.
- Root EXACT hit requires `bestAction`; otherwise falls through to a full search.

---

## 6. Next step
**Stop.** D1 acceptance complete. Awaiting user sign-off before starting D2 (Alpha-Beta pruning).
