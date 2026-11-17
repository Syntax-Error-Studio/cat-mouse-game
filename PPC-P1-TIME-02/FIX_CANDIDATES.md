# PPC-P1-TIME-02 — FIX CANDIDATES

**Nothing here was implemented.** Task §9 asks for at least two *genuinely different*
directions with an honest cost/benefit and gate list; the choice belongs to the next round's
authority, not to this one.

Every expected-effect figure is derived from a number measured in this round
(`ROOT_CAUSE_FINDINGS.md` §7 / `TURN_ACCOUNTING.json`); none is extrapolated from a
different build.

Reference turn (G1T5, median): **150.38 ms** = 112.54 search + 37.52 sidecar + 0.32 tax.
Reference turn (G1T1, median): **150.46 ms** = 101.73 search + 48.27 sidecar + 0.46 tax.

---

## Candidate A — Stop paying for leaf evaluations the search is about to throw away

**Bottleneck.** The deadline abort path evaluates one leaf per returning sibling
(`expectiminimax.ts:1713`), and the leaf/horizon/budget return paths are checked *before* the
deadline gate, so they also evaluate in full. Measured: 78–98 abort-path evaluations on
G1T5 = **8.67 ms**, 69% of a **12.52 ms** post-detection walk; a further **30** full
evaluations leave through the pre-gate return paths. On G5T4 the same mechanism costs
3.74 ms of a 4.23 ms walk.

**Phase affected.** The last 1–12% of the main search. Does **not** touch the 100 ms of
useful search.

**Expected effect.**

| Root | measured post-detection return | recoverable (eval + pre-gate leaves) | share of turn |
|---|---|---|---|
| G1T5 | 12.52 ms | **~8.7–9.7 ms** | 5.8 – 6.5% |
| G5T4 | 4.23 ms | ~3.7–4.2 ms | 3.5 – 4.0% |
| G1T1 | 1.66 ms | ~1.4 ms | 0.9% |
| G1T4 | 1.82 ms | ~1.5 ms | 1.2% |

Tail-relevant: it shrinks the *variance* the host sees on the turn path, and it directly
reduces the 12.4 ms by which G1T5's search exceeds its 100 ms budget.

**Does it change strategy / rules / reproducibility?** No to rules, no to reproducibility,
**conditionally no to strategy** — the values computed at an aborted node are consumed by
the parent's min/max, so they are only safely droppable if the whole iteration is
guaranteed to be discarded. That guarantee exists today (an incomplete iteration is dropped
in `searchBestActionIterative`), but it is currently *implicit*: it holds because every
ancestor independently re-reads the clock. Making it explicit (a sticky
`ctx.deadlineTripped` that forces every subsequent gate open and forbids the iteration from
being adopted) is what turns “probably safe” into “provably safe”.

**Minimal code scope.** `expectiminimax.ts` only: one field on `SearchContext`, one
assignment in the gate, and a guard at `:1713` (+ optionally reordering the three
pre-gate return paths behind the gate). No planner, engine, config or TT change.

**Gates required.** The full existing search-equivalence suite (fixed-depth results must be
bit-identical when no deadline is set), the 24-root D1 regression, tree-size/TT-change
counters, and a *new* assertion that a turn whose deadline tripped never adopts a value from
the tripped iteration.

**Why it might not pay off.** It only recovers time on turns that actually hit the deadline,
and those are exactly the turns where the sidecar then absorbs the saving (§3 of the
findings) — the saving becomes sidecar work, not a shorter turn, unless Candidate B lands
too. **A alone does not shorten a 150 ms turn; it shortens the search inside it.** That is
the single most important caveat in this document.

---

## Candidate B — Give the bounded-refutation sidecar a *total* budget instead of a
## per-candidate one

**Bottleneck.** The sidecar's 6 candidates each get `maxCpuMs = FIXED_CPU_MS = 20`, and the
only bound on their sum is the shared turn deadline. Measured: on G1T1/G1T5 the **first**
candidate never completed (`candidatesProbed = 0`) and consumed **35.5–49.4 ms** — 24–33% of
the whole turn — producing no verdict at all. On G1T4 all 6 candidates completed in
**18.9–22.0 ms** and also produced no refutation. Across 32 measured turns (24 of which actually
entered the sidecar): **0 overrides**.

**Phase affected.** The 100 ms → 150 ms window; it is the *only* reason that window is
occupied at all.

**Expected effect.** A total cap of, say, 20 ms would move G1T1/G1T5 from ~150 ms to
**~120–125 ms** (−17 to −20%), with zero change to what the sidecar concluded (nothing, in
every observed case). G1T4 and G5T4 would be unaffected. This is by far the largest single
lever available.

**Does it change strategy / rules / reproducibility?** **Yes — strategy.** The sidecar exists
to override the baseline plan when it can be refuted; shortening its budget changes which
turns *can* be overridden, on positions not in this evidence set. Reproducibility is
preserved (no randomness), rules are untouched.

**Minimal code scope.** `boundedPlanRefutation.ts` (one accumulated-budget counter checked in
the candidate loop, plus a new `sidecarAbortReason` for it) + `hardTurnPlanner.ts` (pass the
total instead of the per-candidate number). No engine change.

**Gates required.** This is **not a timing fix, it is an efficacy change**, and it must be
pre-registered as such: an A/B over the frozen human corpus with the refutation-override rate,
the plan-agreement rate, and the G0.3V contract re-verified. It cannot be accepted on latency
grounds alone — and this round explicitly has no efficacy authority
(`NEW_EFFICACY_AUTHORITY = NONE`).

**Why it might not pay off.** If the sidecar's value is concentrated in *long* probes (the
ones that look deep enough to find a refutation), a hard total cap removes exactly the
probes that matter while keeping the cheap ones that never refute anything — the worst
possible trade. The observed data (0/32 overrides on the four hardest roots) is consistent
with both “the sidecar is not earning its time here” and “these four roots are simply
unrefutable”, and this round cannot tell them apart.

---

## Candidate C — Make the dominant per-turn work cheaper: 254–667 leaf evaluations at
## ~0.12 ms

**Bottleneck.** `evaluate` is 37–67% of the main search (§7 of the findings), 0.107–0.153 ms
per call, corroborated by an independent micro-benchmark (p50 0.104–0.133 ms). Each call
performs one mouse BFS + one cat BFS + one carry-aware mouse BFS (`evaluations == mouseBfs
== catBfs == carryMouseBfs` in every measurement).

**Phase affected.** The whole 100 ms main search, i.e. the part that produces the plan.

**Expected effect.** Linear in the reduction: a 25% cheaper evaluation removes 9.7 ms of
G1T1's 38.9 ms and 18.7 ms of G1T5's 74.9 ms — but see the caveat, which is the same as
Candidate A: on a 150 ms turn the saving is re-spent by the sidecar.

**Does it change strategy / rules / reproducibility?** **Potentially yes to strategy** —
any change to the evaluator's value changes leaf scores, which changes move ordering, TT
contents and the plan. Only a *numerically identical but faster* implementation (same
inputs → same float) is strategy-neutral, and proving that is the hard part (BFS visit
order, tie-breaking, early exits).

**Minimal code scope.** `evaluation.ts` (the three BFS helpers and their call sites), with
the existing module counters as the equivalence harness. No search, planner or engine change.

**Gates required.** Leaf-value bit-equality over a frozen corpus of states (the
`LEAF_COST.json` checksums are a starting point: `evaluateForCat` returns
`-314115.789474` / `30857.894737` on the two probe states), plus the D1 regression and the
full search-equivalence suite.

**Why it might not pay off.** The BFS calls are already the cheap, table-driven part; the
expensive residue is spread across them. Prior rounds' experience (documented in project
memory) is that per-leaf BFS work is ~0.01–0.03 ms and that the *repeated* evaluation count,
not the per-call cost, is what scales the total — so the better-shaped version of this
candidate is “evaluate fewer distinct leaves”, not “make each evaluation faster”.

---

## Candidate D — Stop enumerating legal actions 638 times

**Bottleneck.** `legalActions` is the second-largest item on G1T1: **24.67 ms**, 638 calls,
38.7 µs each. On G1T4/G5T4 it is 20.10 / 18.76 ms. Unlike `evaluate`, this is not
memoized per state key.

**Phase affected.** The whole main search, uniformly.

**Expected effect.** Up to −10 to −20 ms of useful search time on the G1 roots (i.e. more
depth inside the same 100 ms, not a shorter turn). Turn-wall effect: none directly.

**Does it change strategy / rules / reproducibility?** It changes strategy through the same
channel as Candidate C (better depth in the same budget ⇒ different plan). A
state-key-keyed cache of the *ordered* action list would be numerically identical **only if**
the ordering keys are pure functions of the state — they are not, today: ordering consumes
TT moves and history, so the cache would have to key on those too, which is exactly how a
subtle bug gets in.

**Minimal code scope.** `expectiminimax.ts` (`searchActions`) + a cache on `SearchContext`;
no rule or engine change.

**Gates required.** Cache-hit accounting, tree-size comparison, D1 regression, and an
explicit argument for why the ordering inputs are part of the key.

**Why it might not pay off.** 38.7 µs per enumeration is already the cost of *generating*,
not of allocating; if the generation itself is the floor, caching only helps where the same
state is revisited — which the TT already prevents at EXACT depth. The hit rate is unknown
and would have to be measured before any code is written.

---

## Candidate E — The fallback amplifier (`catAiHard` at ~6–13 ms per step)

**Bottleneck.** When depth 1 does not complete, `catAiMove` takes the closed-window branch
and runs the legacy heuristic for each remaining move. Measured 4-step cost: **9.6–38.7 ms**
on G1T1, of which **72–79% is `chooseHardTrapStandCell`** (73 `bfsCatPathToStand` + 26
`estimateTrapBypassCost` per step — the cell × BFS sweep runs even when the trap decision
cannot change).

**Phase affected.** Only turns that fail depth 1: **0 of 96** root-turns this round, 1 of 24
in the P1-TIME-01 sweep.

**Expected effect.** Would have converted 196.83 ms into ~170–185 ms in that episode. It does
**not** touch the 150 ms platform, and on the current engine it would save nothing measurable.
Its value is entirely as a tail-risk reduction.

**Does it change strategy / rules / reproducibility?** **Yes to strategy** (it *is* the
legacy heuristic's choice of cell). Reproducibility preserved.

**Minimal code scope.** `hardTurnPlanner.ts` / the `catAiHard` trap-stand helper — outside
the AI search entirely, and therefore outside everything this round measured.

**Gates required.** Trap-placement behavioural equivalence on a frozen corpus (the PPC
CAT-STRATEGY-01 finding that the heuristic over-places traps is relevant here and argues for
*not* touching it casually), plus the D1 regression.

**Why it might not pay off.** Zero measured occurrences in the current engine. Optimising it
is optimising a path that does not execute; the honest ranking of this candidate is *last*.

---

## Explicitly out of scope (carried from prior verdicts)

* **No PVS / narrow-window / aspiration variants.** `SEARCH-01` already returned
  `NO_GO_PVS` on this exact tree (node counts the primary evidence, +19.2% nodes on D2).
* **No increase in worker concurrency, no V8 heap tuning.** Project rule; also irrelevant —
  the turn is bounded by a wall clock, not by throughput.
* **No second expectiminimax implementation for the mouse.** `MOUSE-01` closed that door.
* **No change to the 100 ms / 150 ms constants.** They are the contract this round measured;
  moving them is an authority decision, not an engineering one.

---

## Ranking by *measured* evidence, not by taste

| Rank | Candidate | Measured upside on the four roots | Strategy risk | Gate weight |
|---|---|---|---|---|
| 1 | **B** (sidecar total budget) | −25 to −32% of turn wall on 2 of 4 roots | **high** | **heavy (efficacy A/B)** |
| 2 | **A** (abort-path leaf evaluations) | −1.4 to −9.7 ms, mostly variance | low | medium |
| 3 | **C** (cheaper evaluation) | −10 to −19 ms of search work | medium | heavy (bit-equality) |
| 4 | **D** (legal-action caching) | more depth, no wall change | medium | medium |
| 5 | **E** (fallback amplifier) | 0 on the current engine | medium | light but pointless |

The uncomfortable observation this round leaves on the table: **A, C and D all buy search
work inside the 100 ms budget, and on a turn that lands on the 150 ms wall that work is
immediately re-consumed by the sidecar.** Any of them can be correct and still produce no
visible latency improvement. Only B changes the wall itself. That is why B is ranked first
despite being the one this round is least authorised to recommend.
