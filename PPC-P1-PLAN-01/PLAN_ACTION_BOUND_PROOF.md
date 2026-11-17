# PPC-P1-PLAN-01｜PLAN_ACTION_BOUND_PROOF — 合法猫回合动作数上界与终止性证明

**Claim.** For any legal cat-turn action sequence rooted at a state with remaining cat move
budget `M = catMovesLeft ≥ 0`,

```
|plan|  ≤  M + 1 + floor(M/2)
```

and every plan extractor terminates without relying on a constant cap.

Everything below is derived from the production rules as they exist on this branch. Each rule
fact cites the source line it was read from; each numeric claim is reproduced by
`src/game/ai/__tests__/planTurnActionBound.test.ts` (PLAN-0 … PLAN-6) against the real
`createEngineRuleSet`.

---

## 1. The only two cat actions

The cat's action alphabet is `{catStep, catPlaceTrap}` (`src/game/ai/legalActions.ts:52-61`,
`src/game/ai/searchTypes.ts`). `mouseStep` / `mouseSkill` / `chooseTunnel` belong to the
mouse, and `endTurn` is not an action at all: it is a FORCED transition applied by the
simulator when the actor has no moves left (`src/game/ai/simulator.ts:107-138`).

### Fact 1 — a `catStep` that is applied always consumes exactly one move

`catMove` (`src/game/engine.ts:872`) has exactly four outcomes:

| branch | line | `catMovesLeft` |
|---|---|---|
| guard: not Playing / not cat / `catMovesLeft <= 0` | 874-875 | unchanged (no-op) |
| RULE-A settle: cat has no legal spatial move | 881-882 | unchanged, **turn ends** (see §5) |
| box push | 938 | `-1` |
| normal move (incl. trap collection) | 961 | `-1` |
| illegal destination (bounds/hole/tunnel/butter/pile/void/push blocked) | 889-936 | unchanged (no-op) |

A no-op is not a legal action: `generateLegalSearchActions` keeps an action only when the
resulting state is game-affecting-different (`legalActions.isEffective`,
`src/game/ai/legalActions.ts:67-75`). Every action that can appear in `planBranches` or in an
`EqualPrimaryGraph` node is therefore one of the two `-1` branches. **One applied step = one
move.**

### Fact 2 — `catPlaceTrap` consumes no move, and cannot repeat

`catPlaceTrap` (`src/game/engine.ts:974`) never touches `catMovesLeft`; it only sets
`trapPosition` and decrements `catTrapsRemaining` (992-995). It is offered only when
`trapPosition === null && catTrapsRemaining > 0` (`legalActions.ts:57-60`) and it bails out
when a trap is already on the board (977). So:

* a placement is a **zero-move** action;
* after a placement `trapPosition ≠ null`, so the next action of the plan **cannot** be
  another placement.

### Fact 3 — the only way to collect a trap is to step onto its cell, which costs a move

The collection branch is inside `catMove`: `steppedOnTrap = trapPosition == destination`
(950-953), which clears `trapPosition` and gives the inventory back (962-963) — while
`catMovesLeft` is still decremented (961). A step is always a real displacement: `catMove`
never leaves the cat on its own cell for an applied action, and a box push moves the cat into
the box's old cell (931-937). **A collection costs exactly one move and moves the cat.**

---

## 2. Theorem

Let a legal sequence be `a₁ … aₙ`, `S` = number of `catStep`, `P` = number of
`catPlaceTrap`.

**(a) `S ≤ M`.** By Fact 1 each applied step consumes one move; `catMove` refuses to act at
`catMovesLeft ≤ 0` (875) and the turn is handed off as soon as the budget reaches 0
(`simulator.forceEndTurnIfNeeded`, 107-138). No in-turn event grants the cat extra moves:
`catMovesLeft` is only ever assigned `config.catBaseMoves` at `endTurn`
(`engine.ts:1345`), i.e. at the start of a *new* cat turn.

**(b) `P ≤ 1 + floor(S/2)`.** Order the placements `p₁ < p₂ < … < p_P`. Between `p_i` and
`p_{i+1}` the trap must be collected (Fact 2), and a collection is a step (Fact 3). After
`p_i` the cat stands **on** the trap cell, so the collecting step cannot be the immediately
following one: the cat must first leave that cell. Hence at least **two** steps lie strictly
between two consecutive placements, and those step sets are disjoint. Therefore
`S ≥ 2(P − 1)`, i.e. `P ≤ 1 + floor(S/2) ≤ 1 + floor(M/2)`.

**(c) Therefore `n = S + P ≤ M + 1 + floor(M/2)`.** ∎

### Table

| `M` | 0 | 1 | 2 | 3 | **4 (default)** | 5 | **6** | 7 | 8 | **9** | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| bound | 1 | 2 | 4 | 5 | **7** | 8 | **10** | 11 | 13 | **14** | 19 |

Two consequences explain the whole defect:

* at the production default `M = 4` the bound is **7 < 8**, so the legacy constant never
  bound and no default-map turn was ever truncated — which is why this survived every
  earlier default-map parity check;
* at `M = 6` the bound is **10 > 8**, so a legal turn could carry 9 actions the extractor
  refused to emit (`TUDTUDTDD`, `BASELINE_TRUNCATION_WITNESS.json` → `PLAN-2`), and at
  `M = 9` the search's own principal line was 9–10 actions long (`PLAN-1`).

### Tightness

The bound is **attained** on a 1-wide corridor with `M = 9`: the exhaustive DFS of §6 finds a
legal 14-action sequence (9 steps + 5 placements), exactly `9 + 1 + floor(9/2)`. So it cannot
be lowered by a trivial argument. At the production default `M = 4` the exhaustive maximum is
6 while the bound is 7 — one action of slack, and both numbers sit below the legacy constant
8, which is the last piece of the explanation for why nothing ever noticed.

An upper bound is all a safety cap needs; §6 shows it is never violated on any board shape
tested, and §2 shows why: the argument uses only "a step costs a move" and "two placements
need a collection in between".

---

## 3. Why `catBaseMoves` alone is not the bound

`catBaseMoves` has no validator in `validateGameConfig` (`src/game/config.ts:145-...` only
constrains board size, hole, starts, tunnels and fixed piece lists), so the move budget is a
free integer. More importantly, the correct quantity is the budget of the **root of the
extraction**, not of the config:

* a turn resumed mid-way (the engine's fallback re-plan path) has fewer moves left, and the
  bound computed from that state is smaller — still a valid bound for the remaining plan;
* the executor may also grant a fresh `catBaseMoves` when it starts a turn from a zero budget
  (`engine.ts:4010-4012`), in which case the state really does hold `catBaseMoves`.

That is why `maxCatTurnPlanActions(state)` reads `state.catMovesLeft` and never
`state.config.catBaseMoves`.

---

## 4. Defensive handling of an abnormal budget

`catTurnMoveBudget` clamps a non-finite or non-positive `catMovesLeft` to 0, giving a bound of
1 (a lone placement). This cannot manufacture a plan out of a corrupt state: a state with a
broken budget fails `planFullTurnCompleteness`'s move accounting anyway, and the search that
would have produced the `planBranches` cannot run on it either. The alternative — throwing —
would turn a corrupted state into a crash in the middle of a live game, and the alternative
of "keep 8" is precisely the defect being removed. `PLAN-0` pins both halves of this: the
formula for `M = 0..12` and the clamp for `NaN`, `+∞`, `-3`, `0`.

---

## 5. Edge cases (each one is a test, not a footnote)

1. **RULE-A settling step.** If the cat has no legal spatial move, `catMove` returns the
   settled state before applying anything (881-882) and `simulateSearchAction` settles the
   state before dispatching at all (`simulator.ts:41-42`). Such an "action" ends the turn, so
   it can only be the plan's **last** action, and if it appears at all it is the first one
   (nothing else could have been applied to a stranded cat). Either way the sequence length
   is ≤ the bound: a one-action plan is ≤ `M + 1 + floor(M/2)` for every `M ≥ 0`.
2. **Capture on the final step.** `catMove` runs `checkCatWin` (938 → `checkCatWin`), which
   sets `phase = CatWins`; the plan stops there and completeness reports `GAME_ENDED`. A
   capture is one step, so it only shortens the plan.
3. **CAT→MOUSE ghost/debt CHANCE boundary.** The last step of a turn may resolve into a
   chance node (`simulator.ts:115-130`). It is still one step; the extractors keep that final
   cat action and stop (`PLAN-4` asserts exactly this, plus
   `COMPLETE_CHANCE_BOUNDARY`).
4. **`catPlaceTrap` denied.** No stock (`catTrapsRemaining ≤ 0`) or a trap already on the
   board → the placement is a no-op → it is not a legal action → it never enters a plan, and
   the bound is not affected (`PLAN-5`).
5. **Trap already on the board at the root.** The plan may begin with a collection (one move)
   and then place a new trap; the pairing argument still holds for the placements *after* the
   first one, so `P ≤ 1 + floor(S/2)` still bounds the plan (`PLAN-5`).

---

## 6. Termination (the cap is not what makes the extractors stop)

Termination must not depend on `maxLength`; the task forbids `maxLength = Infinity` precisely
because a cap that is also the termination argument would be a loop hazard. Here it is not
needed:

* `stateKey` (`src/game/ai/transposition.ts:82-102`) includes `catMovesLeft`,
  `catTrapsRemaining` and `trapPosition` — the three components that change monotonically
  during a cat turn (`-1` per step, `-1`/`+1` per placement/collection, position identity per
  step). Therefore **two distinct prefixes of one turn can never share a `stateKey`**: a
  repeat would require the same `catMovesLeft`, which a strictly decreasing quantity forbids.
* Every extractor already carries a `stateKey` guard: `extractDp`'s `pathGuard` (returns `[]`
  on a repeat) and the `seen` sets of `buildCatTurnPlan` / `buildPlanForFirstAction` /
  `fallbackPlanWalk`. With the observation above those guards are never hit in a legal turn,
  and they are what makes the recursion finite in every other case.
* The DP's recursion depth is additionally bounded by the number of nodes in the
  equal-primary graph / `planBranches`, both of which are subsets of the search's own visited
  states.

**Empirical check (no analytic bound used).** `dfsLongestPlan` walks the real cat-action
graph exhaustively (every legal action, every reachable state, longest sequence recorded) and
compares against the analytic bound:

Produced by `PPC-P1-PLAN-01/probe/dfs_bound.test.ts` → `BOUND_DFS_TABLE.json`
(`dfsLongestPlan`, real rules, no analytic bound on the DFS side):

| root | `M` | trap stock | longest legal sequence found | bound | violated? |
|---|---|---|---|---|---|
| corridor (1-wide) | 1 | 1 | 2 | 2 | no |
| corridor (1-wide) | 2 | 1 | 3 | 4 | no |
| corridor (1-wide) | 3 | 1 | 5 | 5 | no |
| corridor (1-wide) | **4** | 1 | **6** | **7** | no |
| corridor (1-wide) | 5 | 1 | 8 | 8 | no |
| corridor (1-wide) | 6 | 1 | 9 | 10 | no |
| corridor (1-wide) | **9** | 1 | **14** | **14** | no |
| open 10×10 | 2 | 1 | 3 | 4 | no |
| open 10×10 | 3 | 1 | 5 | 5 | no |
| open 10×10 | **4** | 1 | **6** | **7** | no |
| open 10×10 | 6 | 1 | 9 | 10 | no |
| open 10×10 | 6 | 0 | 6 | 10 | no |

Two rows carry the argument:

* `M = 9` (corridor) — the DFS reaches **exactly** the bound (14 = 9 + 1 + 4), so the formula
  is reachable, not merely safe. From that same root the search's own principal line was
  `DDDDDTUUUU` (10 actions, `BASELINE_TRUNCATION_WITNESS.json` → `PLAN-1`), which the legacy
  cap cut to 8.
* `M = 4` (both shapes) — the exhaustive maximum is **6** and the bound is 7, both strictly
  below the legacy constant 8. That is why nothing on the default map was ever truncated.

---

## 7. What this proof does NOT claim

* It is **not** a claim about what the search will find. The bound says "no legal plan is
  longer than this"; whether the search's principal line is 5 or 10 actions is a search
  result.
* It does **not** change any rule. `catStep`/`catPlaceTrap` semantics,
  `planFullTurnCompleteness`, the CHANCE boundary and the executor are untouched; only the
  cap that the extractors apply to their own output moved from `8` to this formula.
* It does **not** license `maxLength = Infinity`. The formula is finite for every finite
  budget and the termination argument in §6 is independent of it.

---

## 8. Where the bound is used (single source of truth)

`src/game/ai/planBound.ts` → `maxCatTurnPlanActions(state)`, imported as the **default**
`maxLength` of:

| entry point | file:line | reached from |
|---|---|---|
| `buildCatTurnPlan` | `expectiminimax.ts:1885` | `searchBestAction`, iterative deepening, `finalizeCompletedIterationPlan` (`builtPlan`) |
| `buildPlanForFirstAction` | `planQuality.ts:242` | `buildCandidate` → `forcedLossTieBreak` → both plan-quality paths |
| `extractBestCatTurnPlan` | `planQuality.ts:444` | `searchBestAction`, iterative deepening, `finalizeCompletedIterationPlan`; its two bodies `extractDp` and `fallbackPlanWalk` inherit the same number |

No other fixed plan-length limit exists in `src/game` (audited in
`PLAN_EXTRACTION_CALL_GRAPH.md` §4).
