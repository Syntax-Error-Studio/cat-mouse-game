# Phase D2 — Lexicographic Alpha-Beta · Final Acceptance Report

**Date:** 2026-08-17
**Scope:** D2 only (Alpha-Beta pruning).
**Explicitly NOT done** (per spec): Move Ordering, Killer / History heuristics, Iterative Deepening,
wall-clock timeout, LOWER/UPPER TT caching, Hard difficulty formal integration, evaluation refactor.
**Status:** ✅ 91/91 tests pass · typecheck clean · `src/game/ai/**` lint clean.

Files touched: `src/game/ai/expectiminimax.ts` (943 lines), `src/game/ai/__tests__/expectiminimax.test.ts` (2184 lines).
No engine / UI / rules file was modified. Nothing was committed.

---

## 1. Acceptance summary

| D2 acceptance criterion | Result |
|---|---|
| On complete searches, AB **OFF == ON** (value / mate / bestAction) | ✅ D2-C, D2-D, D2-F, D2-G, D2-H, D2-BENCH |
| AB **ON expands fewer nodes** than OFF on prunable fixtures | ✅ 4,622 → 715 (MAX root, −84.5%), 4,622 → 634 (MIN root, −86.3%) |
| No numeric-only alpha/beta (mate category preserved) | ✅ `ScoreBound` wraps `SearchScore {value, mate}` |
| Exactly ONE ordering definition | ✅ `compareSearchScore` (selection + pruning both route through it) |
| CHANCE never pruned | ✅ full window per outcome, `fullWindowChanceSearches === chanceNodes` (D2-F) |
| TT stays EXACT-only; no cutoff stored as EXACT | ✅ `storeTT` gates on `bound === 'exact'` (D2-I) |
| `useAlphaBeta` default **false** → Phase C/D0/D1 bit-identical | ✅ D2-K |
| `npm test` | ✅ **91 passed / 91** (3 files) |
| `npx tsc --noEmit -p tsconfig.app.json` | ✅ exit 0, no output |
| `npx eslint src/game/ai/**` | ✅ exit 0, 0 problems |

---

## 2. `SearchScore` + the single comparator (spec #1, #2)

```ts
export type MateSide = 'cat' | 'mouse' | null;          // line 50
export interface SearchScore { value: number; mate: MateSide }
```

`mateRank`: `cat → 2`, `null → 1`, `mouse → 0`. The total order is **category first, numeric second**:

```
cat-mate (2)  >  non-mate (1)  >  mouse-mate (0)
```

```ts
export function compareSearchScore(a, b) {          // line 125 — THE only ordering
  const ra = mateRank(a.mate), rb = mateRank(b.mate);
  if (ra !== rb) return ra - rb;
  return a.value - b.value;                          // numeric only WITHIN a category
}
export function preferResult(a, b, maximizing) {     // line 142 — play selection
  const cmp = compareSearchScore(a, b);
  if (cmp === 0) return false;                       // tie → keep the incumbent
  return maximizing ? cmp > 0 : cmp < 0;
}
```

Both **play selection** (`preferResult`) and **pruning** (`compareBound`/`maxBound`/`minBound`) delegate to
`compareSearchScore`, so pruning can never disagree with selection — the structural cause of the classic
"alpha-beta returns a different move than plain minimax" bug is removed by construction.

Consequence proved by test: a mixed CHANCE node (`mate = null`) whose expectation is numerically
`MATE_SCORE - 1` still ranks **below** a genuine forced cat-mate at `MATE_SCORE - 3`, because
`rank(null)=1 < rank('cat')=2`. A numeric-only comparator would flip this (D2-E).

---

## 3. The Alpha/Beta bound type (spec #3)

```ts
export type ScoreBound =                             // line 75
  | { kind: 'negative-infinity' }
  | { kind: 'score'; score: SearchScore }
  | { kind: 'positive-infinity' };

const NEG_INF: ScoreBound = { kind: 'negative-infinity' };   // line 572
const POS_INF: ScoreBound = { kind: 'positive-infinity' };
```

- `compareBound(a, b)` (line 225): ±∞ handled by `kind`, `score` vs `score` delegates to `compareSearchScore`.
- `maxBound` (236) / `minBound` (241): pure selection through `compareBound`.
- The **root always starts at the full window** `(NEG_INF, POS_INF)` — `searchResult` / `searchBestAction`.
- **No `Number.MAX_VALUE` / `Infinity` sentinel hacks anywhere.** D2-B asserts that the full window can
  never satisfy `alpha >= beta` (so a full-window node can never cut off spuriously).

Cat-mate/mouse-mate are *categories*, not big numbers, so `+∞` and "cat mates in 1" remain distinct
values — that distinction is exactly what a numeric sentinel would destroy.

---

## 4. Mate-distance window inverse propagation (spec #4)

A child's value lives one tree edge closer to the terminal than its parent's, so a parent-space window
must be re-expressed in **child space** before it is inherited:

```ts
export function stepBoundForParent(bound)   // line 194 — child space → parent space
export function unstepBoundForChild(bound)  // line 213 — parent space → child space
```

| Bound | `unstepBoundForChild` |
|---|---|
| `{cat, v}` | `{cat, v + 1}` |
| `{mouse, v}` | `{mouse, v - 1}` |
| `{null, v}` (non-mate) | unchanged |
| `-∞` / `+∞` | unchanged |

`stepBoundForParent` is the exact inverse (cat `-1`, mouse `+1`), matching `stepChildForParent`
(line 185), which is what the search actually uses to lift a child's value.

Dedicated test **D2-B** proves:
1. round-trip identity on all four categories plus both infinities;
2. **order preservation**: for every bound `b` and child result `c`,
   `sign(compareBound(b, step(c))) === sign(compareBound(unstep(b), c))`.
   This is the property that makes window inheritance sound — without it, the window would drift by
   one mate-ply per level and prune moves that are actually better.

---

## 5. MAX / MIN cutoff implementation (spec #5, #6)

`searchActions` (line 595) is the single MAX/MIN action loop, shared by interior nodes and the root:

```ts
const maximizing = state.currentPlayer === PieceType.Cat;
for (const a of actions) {
  const childAlpha = unstepBoundForChild(alpha);      // window into child space
  const childBeta  = unstepBoundForChild(beta);
  const childRes   = valueOfAction(a, ..., childAlpha, childBeta);
  const candidate  = { value: stepChildForParent(childRes), mate: childRes.mate, ... };

  if (best === null || preferResult(candidate, best, maximizing)) { best = candidate; bestAction = a; }

  if (ctx.useAlphaBeta) {
    if (maximizing) {
      alpha = maxBound(alpha, { kind: 'score', score: { value: candidate.value, mate: candidate.mate } });
      if (compareBound(alpha, beta) >= 0) { cutOff = true; /* beta-cutoff  */ break; }
    } else {
      beta  = minBound(beta,  { kind: 'score', score: { value: candidate.value, mate: candidate.mate } });
      if (compareBound(alpha, beta) >= 0) { cutOff = true; /* alpha-cutoff */ break; }
    }
  }
}
```

- MAX: `best` starts at "nothing yet" (`null`, semantically `-∞`), raises `alpha`, cuts on `alpha >= beta`.
- MIN: perfectly symmetric — lowers `beta`, cuts on the same condition.
- **Final action selection is always `preferResult`**, never the window: the window only decides *whether
  to keep searching*, never *which move wins*.
- When `ctx.useAlphaBeta === false` the whole block is skipped, so the loop is byte-for-byte the
  Phase C/D0/D1 loop (D2-K).

Probe order is unchanged from D1 (spec #12): **terminal → repetition → depth/budget → EXACT TT probe →
legal actions → Alpha-Beta**. Repetition still yields `cacheable = false` and is detected *before* any
pruning, so a cutoff can never hide a repetition.

---

## 6. Why CHANCE is never wrongly pruned (spec #7, #8)

`valueOfAction` (line 698), CHANCE branch:

```ts
ctx.diagnostics.fullWindowChanceSearches++;
for (const o of outcomes) {
  const cr = _search(o.state, nd, ctx, path, nodeCount, ply, NEG_INF, POS_INF); // FULL WINDOW
  total += o.weight * cr.value;
  if (cr.mate !== 'cat')   allCat = false;
  if (cr.mate !== 'mouse') allMouse = false;
}
const mate = allCat ? 'cat' : allMouse ? 'mouse' : null;
```

Reasoning: a CHANCE value is `Σ weight · value`, i.e. **every** outcome contributes. Dropping a
"hopeless" outcome because the partial sum already looks bad would change the number itself
(stochastic pruning is forbidden in D2 — that needs `*-minimax` style probing, not plain alpha-beta).
So each outcome is searched with `(-∞, +∞)`, and the fact is *counted* so a test can prove it.

- Mate inheritance stays explicit: all-cat → `'cat'`, all-mouse → `'mouse'`, **any mix → `null`**.
  An empty-outcome list is `null` too.
- **No extra mate-distance layer** at CHANCE: the `±1` step happens once, on the parent→action edge
  (`stepChildForParent`). D2-G proves a probability-1 chance mate scores `MATE_SCORE - 1`, **not** `- 2`.
- D2-F asserts `rOn.value` is **bit-identical** to `rOff.value` on three chance fixtures
  (99%/1% cat, 50/50 cat vs mouse, non-uniform all-cat) and `fullWindowChanceSearches === chanceNodes`.

---

## 7. Cutoff marking: `exact` / `lower` / `upper` (spec #10)

```ts
export type SearchBoundType = 'exact' | 'lower' | 'upper';   // line 339
// InternalSearchResult gained a `bound: SearchBoundType` field.
```

| Node kind | `bound` |
|---|---|
| terminal (CatWins / MouseWins) | `exact` |
| leaf (depth 0 / budget / no legal action) | `exact` |
| fully enumerated MAX or MIN | `exact` (inherits the chosen child's bound) |
| MAX that hit a **beta**-cutoff | `lower` (true value is ≥ reported) |
| MIN that hit an **alpha**-cutoff | `upper` (true value is ≤ reported) |
| CHANCE (always full window) | `exact` |
| **root** (always searched at full window) | `exact` — asserted in D2-C/D2-J |

That last row is the reason AB ON and AB OFF agree: interior nodes may return bounds, but the root's
window is never narrowed, so the *returned* value is always the true minimax value.

---

## 8. Why a non-exact result cannot pollute the TT (spec #9, #11)

`storeTT` (line 526) has exactly three gates:

```ts
if (!result.completed || !result.cacheable) return;   // D1 gate (repetition / budget)
if (result.bound !== 'exact') return;                // D2 gate (Alpha-Beta)
```

The TT remains **EXACT-only** — no LOWER/UPPER entries, no bound field in `TTEntry` (that is D2.5).

**Cutoff ≠ search abort.** These are two independent axes and the code keeps them separate:

- `completed` / `cacheable` keep their Phase C/D0/D1 meaning (was the subtree fully searched within
  budget, and is the value path-independent). They are aggregated **honestly** over the actions actually
  searched — the loop `break`s on cutoff, so `allCompleted`/`allCacheable` already describe exactly that
  subset.
- `bound` is the Alpha-Beta axis. A cutoff node is barred from the EXACT table by
  `bound !== 'exact'` **alone**, which is sufficient.

A correctness issue found and fixed *after* the main D2 implementation was already complete: the first
draft wrote `completed: cutOff ? true : allCompleted`. Forcing `completed = true` on a cutoff would
**hide a budget-truncated child from every ancestor**, letting an ancestor be stored as an EXACT entry
built on a truncated value. Now `completed: allCompleted` and `cacheable: allCompleted && allCacheable` —
budget semantics are unchanged from D1 (D2-J). This was an *additional* fix on top of the D2 production
code (the `SearchScore` comparator, `ScoreBound`, the Alpha-Beta window, and the `bound` field) — not the
sole production change of the phase.

Soundness of keeping a parent `exact` even when a child cut off: a `lower` child forces its parent to
cut off too (so the parent is not `exact` either), and an `upper` child can never be the parent's best
choice. Therefore a node labelled `exact` provably holds the true minimax value.

**D2-I** verifies this empirically: TT contents from an AB-ON search and an AB-OFF search agree on every
shared key; an interior-only table is then rebuilt and consumed by a fresh full-window search
(`ttExactHits > 0`) which reproduces the reference value.

---

## 9. AB OFF vs AB ON — test results

| Fixture | OFF nodes | ON nodes | cutoffs (max / min) | value / mate / action |
|---|---|---|---|---|
| `abArena()` @3, **cat** root (MAX) | 4,622 | **715** (−84.5%) | 206 (190 / 16) | `999992` / `cat` / `catStep ↓` — identical |
| `abArena()` @3, **mouse** root (MIN) | 4,622 | **634** (−86.3%) | 356 (16 / 340) | `999994` / `cat` / `mouseStep ↑` — identical |

Both runs had `budgetCutoffs = 0` (a precondition — an incomplete search may not be used to verify
equivalence), `completed = true`, root `bound = 'exact'`, and with AB OFF all three cutoff counters are `0`.

Every test in the D2 suite that claims equivalence asserts `budgetCutoffs === 0` first.

---

## 10. Four-group benchmark (spec #16)

Fixture: the D1-verified-complete `openArena({cat:{4,4}, mouse:{6,6}, catMovesLeft:2, mouseMovesLeft:2})`
at `depthTurns = 3`, `noTrapRuleSet`. **Move ordering unchanged** (that is D3), so these are the honest
"pruning only" numbers. Printed by `D2-BENCH`:

```
[D2 benchmark] openArena cat(4,4) mouse(6,6) moves 2/2, depthTurns=3
  A. TT OFF + AB OFF | nodes=  4622 | cutoffs=   0 (max   0 / min  0) | ttExactHits=  0 ttStores= 0 | value=999992 mate=cat
  B. TT ON  + AB OFF | nodes=   858 | cutoffs=   0 (max   0 / min  0) | ttExactHits=618 ttStores=86 | value=999992 mate=cat
  C. TT OFF + AB ON  | nodes=   715 | cutoffs= 206 (max 190 / min 16) | ttExactHits=  0 ttStores= 0 | value=999992 mate=cat
  D. TT ON  + AB ON  | nodes=   388 | cutoffs= 163 (max 147 / min 16) | ttExactHits= 97 ttStores=31 | value=999992 mate=cat
```

| Group | nodes | vs A | `value` | `mate` | `bestAction` |
|---|---|---|---|---|---|
| A. TT OFF + AB OFF | 4,622 | — | 999992 | cat | `catStep ↓` |
| B. TT ON + AB OFF | 858 | −81.4% | 999992 | cat | identical ✅ |
| C. TT OFF + AB ON | 715 | −84.5% | 999992 | cat | identical ✅ |
| D. TT ON + AB ON | 388 | **−91.6%** | 999992 | cat | identical ✅ |

All four groups: `budgetCutoffs = 0`, identical `value` / `mate` / `bestAction`.
TT and AB **compose** (388 < 715 and 388 < 858) rather than cancelling out — AB reduces the tree, and the
TT still catches the transpositions that survive inside the reduced tree. Note `ttStores` drops
86 → 31 with AB on: exactly the intended effect of the `bound !== 'exact'` gate, since cut-off nodes are
refused entry.

### Diagnostics counters added (spec #14)

`alphaBetaCutoffs`, `alphaBetaMaxCutoffs`, `alphaBetaMinCutoffs`, `fullWindowChanceSearches`
(lines 279–286), reset in `resetDiagnostics`. Invariant asserted:
`alphaBetaCutoffs === alphaBetaMaxCutoffs + alphaBetaMinCutoffs`. No per-node `console.log` was added.

---

## 11. The D2 test suite (spec #15) — 13 new tests

| ID | What it proves |
|---|---|
| **D2-A** | `compareSearchScore` total order (category dominates magnitude, numeric within category, antisymmetry, tie ⇒ no strict preference) and that `preferResult` routes through it |
| **D2-B** | `unstepBoundForChild` / `stepBoundForParent` round-trip + order preservation; `compareBound`/`maxBound`/`minBound` infinity semantics; full window never triggers `alpha >= beta` |
| **D2-C** | MAX pruning: AB OFF == ON, `alphaBetaMaxCutoffs > 0`, `nodes ON < OFF`, root `bound = 'exact'` |
| **D2-D** | MIN mirror on a mouse-to-move root: `alphaBetaMinCutoffs > 0`, identical math, fewer nodes |
| **D2-E** ×2 | Forced-mate lexical safety **through a real search**: MAX keeps a forced cat-mate (`MATE_SCORE-3`) over a numerically-higher non-mate (`MATE_SCORE-1`, injected via `leafEvaluator` and searched FIRST due to `DIRECTIONS` order); MIN mirror keeps a forced mouse-mate. A guard test asserts the rejected alternative really scores higher numerically, so a numeric window *would* flip the choice |
| **D2-F** | CHANCE exactness on 3 fixtures, bit-identical values, `fullWindowChanceSearches === chanceNodes` |
| **D2-G** | Probability-1 chance mate = `MATE_SCORE - 1`, not `- 2` (no extra mate layer at CHANCE) |
| **D2-H** | AB+TT consistency: TT ON+AB ON == TT OFF+AB OFF on 4 complete fixtures |
| **D2-I** | No cutoff is ever stored as EXACT; cross-table agreement; interior-only table re-consumed by a full-window search |
| **D2-J** | Budget semantics unchanged: `maxNodes = 1` ⇒ `completed = false`, `cacheable = false`, `tt.size = 0`, with `bound` as an independent axis |
| **D2-K** | Regression: `useAlphaBeta` defaults false; mate ladder `MATE_SCORE-1/-2/-4` intact; D1 `boxedForcedMate` unchanged; all AB counters `0` |
| **D2-BENCH** | The four-group table above |

---

## 12. Verification gate (spec #18) — all run automatically

```
npx vitest run
  Test Files  3 passed (3)
       Tests  91 passed (91)          # 52 expectiminimax + 33 searchInfra + 6 tunnels
                                      # 13 new D2 tests (78 → 91); 15 D1 tests still pass

npx tsc --noEmit -p tsconfig.app.json  → exit 0, no diagnostics
npx eslint "src/game/ai/**"            → exit 0, 0 problems
npm run lint (whole repo)              → 50 errors / 5 warnings, ALL pre-existing and
                                         ALL outside src/game/ai:
                                           scripts/sim-tutorial.ts 11E
                                           src/game/engine.ts       11E
                                           src/pages/GamePage.tsx   24E
                                           src/pages/TutorialPage.tsx 1E 2W
                                           src/pages/EditorPage.tsx   1E 2W
                                           src/game/mapStorage.ts     1E
                                           src/context/GameContext.tsx 1E
                                           src/components/Board.tsx      1W
```

No manual play-testing was required — every claim above is asserted by an automated test.

One temporary measurement file was created to capture the MIN-root numbers in §9 and was deleted;
`src/game/ai/__tests__/` contains only `expectiminimax.test.ts` and `searchInfra.test.ts`.

### D2-R. Benchmark reproducibility audit (resolved)

**Conclusion: Historical benchmark provenance unavailable / non-reproducible.**

The D1 final report quoted `openArena@3` -> TT OFF = 31,783, TT ON = 901. The current D2 code
measures the *same* fixture (identical call site, identical `noTrapRuleSet`) at TT OFF = 4,622,
TT ON = 858. The 31,783 / 901 figures are **not reproducible** in this workspace and their cause
**cannot be reliably attributed**: there is **no D1 git checkpoint** in this repository, so the
D1-era search code and measurement harness cannot be inspected or diffed. They must therefore be
marked non-reproducible and **must NOT be written as "proven to be a node-count measuring口径
change"** -- no root cause can be claimed without the D1 artifacts. Evidence:

1. **Fixture is byte-identical (rules out A).** `stateKey(openArena({cat:4,4, mouse:6,6,
   catMovesLeft:2, mouseMovesLeft:2}))` equals `stateKey(abArena())` exactly (`true`). Both D1-B and
   the D2 four-group benchmark use the same `openArena` definition, same args, and the same
   `noTrapRuleSet` (`{...defaultRuleSet, catPlaceTrap: (st) => st}`). No trap, same 3x3 open region.
2. **No D1 artifact to diff against (cannot attribute a cause).** There is **no D1 git
   checkpoint/tag** in this workspace, so we cannot run `git diff` against the D1-era code or inspect
   the D1 measurement harness. Consequently the discrepancy (31,783 / 901 vs 4,622 / 858) can be
   attributed to **no specific cause** -- it may be a different measurement harness, a different
   board/seed, or a code difference. We therefore do **not** claim it was "proven" to be a
   node-count口径 change; the root cause is simply unknown.
3. **The historical number exceeds the entire search tree (proves it was not a clean count).** On
   this fixture the full tree is only ~12,544 `_search` entries (nodes 4,622 + terminal 1,684 +
   leaf 6,238). The identity `ttProbes = nodes + ttExactHits` holds in BOTH eras -- D1: 901 + 679 =
   1,580 (matches the D1 report's stated ttProbes); current: 858 + 618 = 1,476, and the observed
   1,477 just adds the one root probe. This confirms `nodes` is counted the **same way** in both eras
   (interior expanded nodes only, at `expectiminimax.ts:845-846`). 31,783 is larger than the whole
   tree, so it was produced by a different (broader / accumulated) measurement harness, not by this
   fixture under this code.
4. **Pure D1 mode re-run on the current code (spec #5).** Using the unified fixture with
   `useTT=false, useAlphaBeta=false` and `useTT=true, useAlphaBeta=false`:
   - TT OFF: `nodes=4,622`, `value=999992`, `mate=cat`, `action=catStep (ArrowDown)`,
     `completed=true`, `budgetCutoffs=0`, `repetitions=0`, `terminalNodes=1,684`, `leafNodes=6,238`.
   - TT ON:  `nodes=858`,  `value=999992`, `mate=cat`, `action=catStep (ArrowDown)`,
     `completed=true`, `budgetCutoffs=0`, `ttExactHits=618`, `ttStores=86`, `terminalNodes=56`,
     `leafNodes=630`.
   Both complete (`completed=true`, `budgetCutoffs=0`), math identical -- exactly as D1 required.

**Resolution:** the absolute node counts in the D1 report (31,783 / 901) are **stale,
non-reproducible, and deprecated as a performance baseline** from this point forward. The
**authoritative canonical baseline for this fixture under the current code** uses the shared
`createTranspositionBenchmarkFixture()` and the current unified diagnostic口径 (interior expanded
nodes):

| Group | nodes |
|---|---|
| A. TT OFF + AB OFF | 4,622 |
| B. TT ON  + AB OFF | 858 |
| C. TT OFF + AB ON  | 715 |
| D. TT ON  + AB ON  | 388 |

All four groups agree on value / mate / bestAction, complete (`completed=true`), and report
`budgetCutoffs=0`. **From now on, every D1/D2-era absolute node count is deprecated; every D3 / D4
performance claim must be measured against this shared fixture and current口径**; the D1 report's
31,783 / 901 must be disregarded entirely. To prevent any future "same name, different board" drift,
D1-B and the D2/D3 benchmarks now share one helper, `createTranspositionBenchmarkFixture()`.


---

## 13. Stop point

**Phase D2 ends here.** Not started, and will not be started without explicit approval:
D2.5 (LOWER/UPPER TT bounds), D3 (Move Ordering / Killer / History), Iterative Deepening,
time budget, Hard difficulty integration, evaluation refactor.
