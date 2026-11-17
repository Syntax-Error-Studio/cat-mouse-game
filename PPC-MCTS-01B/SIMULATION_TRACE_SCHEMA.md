# SIMULATION_TRACE_SCHEMA

`PPC-MCTS-01B/proto/trace.ts` — read-only, RNG-neutral per-simulation trace for the
Phase 1 fixed-completed-simulation parity experiment.

Scope: **only** the isolated prototype under `PPC-MCTS-01B/`. Nothing in `src/`,
`PPC-MCTS-01/` or `PPC-MCTS-01A/` is instrumented.

---

## 1. Non-negotiable properties (task §3.3, items 1–8)

| # | Requirement | How it is guaranteed | Where it is checked |
|---|---|---|---|
| 1 | trace must not consume random numbers | the collector calls no RNG anywhere; every recorded number was already computed by the search | H4 (with-trace ≡ without-trace, whole tree) |
| 2 | trace must not change the RNG order | `countingTraceRng` delegates `next()` / `int(n)` straight through; mulberry32's `int` advances its own private `next` exactly once and is recorded once | H4, H5 |
| 3 | trace must not mutate state objects | every recorded field is a primitive; the only state access is `stateKey(state)`, a pure projection | H4 (tree digest identical) |
| 4 | no instrumentation in production code | the instrumentation lives in `proto/uctBaseline.ts` and `proto/uctPrepared.ts`, both inside `PPC-MCTS-01B/` | `BASELINE_FORK_PROVENANCE.json` |
| 5 | deterministic canonical serialisation + SHA256 | each event is a JSON **array** whose element order is fixed by the call site; numbers go through `num()` | §3 below |
| 6 | one digest per simulation | an incremental SHA256 is opened in `simulationBegin` and closed in `simulationEnd` | `TraceCollector.sims[i].digest` |
| 7 | first difference keeps its full event detail | `captureSimulation = i` retains that one simulation's event body; the driver re-runs the cell to recover it | `drivers/phase1Parity.ts` → `forensics` |
| 8 | never compare only the root action or the final plan | Phase 1 compares per-simulation digests, the whole tree, node statistics, cumulative/average reward, plan and plan-phase digest | `drivers/lib/phase1.ts` → `diffPhase1` |
### 1.1 Why "no extra RNG draw" is structural, not a promise

`mulberry32(seed)` returns `{ next, int }`. Its `int(n)` closure calls the module-local
`next`, **not** the object property. Therefore:

```
wrap(base).int(n)  →  base.int(n)  →  private next()  →  1 state advance  →  1 record
wrap(base).next()  →  base.next()  →  1 state advance  →  1 record
```

There is no code path in which the tap can advance the stream twice or zero times.

---

## 2. Event model

Every event is emitted as a JSON array:

```
["<kind>", <field 1>, <field 2>, ...]
```

Nothing else is written into the digest stream. Object key order can therefore never
influence a digest.

### 2.1 Number encoding (`num`)

| input | encoding |
|---|---|
| `NaN` | `"NaN"` |
| `+Infinity` / `-Infinity` | `"Inf"` / `"-Inf"` |
| `-0` | `"-0"` |
| any other finite double | `String(x)` (shortest round-trip) |

`num(a) === num(b)` ⟺ `Object.is(a, b)` for all doubles. This is what makes a digest
comparison equivalent to a bit-exact numeric comparison.

### 2.2 Strings

`JSON.stringify(value)` — no locale, no escaping drift.

### 2.3 Arrays

`[e1,e2,...]` recursively. Used for CHANCE weights and outcome state keys, so a
CHANCE layer with identical weights in identical order can never produce a different
digest just because the encoding differed.

---

## 3. Events

`sim.begin … sim.end` form one simulation's stream. `plan.*` events form the separate
plan-phase stream (`planTraceDigest`), emitted after the last simulation.

| kind | fields (in order) | meaning |
|---|---|---|
| `sim.begin` | `index:int`, `rootStateKey:string` | a new simulation starts; `index` is 0-based |
| `rng.draw` | `stream:"chance"\|"policy"`, `method:"next"\|"int"`, `n:int` (−1 for `next`), `value:number`, `drawIndex:int` | one public draw, recorded **after** it happened |
| `tree.visit` | `nodeKind:"decision"\|"chance"`, `stateKey`, `actor:"cat"\|"mouse"`, `handoffs:int`, `visitCount:int`, `pathLength:int` | the descent reaches this node |
| `tree.expand` | `stateKey`, `legalCount:int` | legal actions were generated (`legalCount = 0` ⇒ no legal action) |
| `tree.edge` | `parentStateKey`, `edgeKey`, `transitionKind`, `childStateKey \| null` | which edge UCB1 selected at this decision node |
| `tree.chanceLayer` | `parentStateKey`, `actionKey`, `outcomeCount:int`, `weights:number[]`, `outcomeStateKeys:string[]` | a CHANCE node was created from a real transition |
| `tree.chancePick` | `chanceNodeStateKey`, `outcomeIndex:int`, `outcomeStateKey`, `outcomeCount:int` | which validated outcome this simulation sampled |
| `tree.cycle` | `stateKey`, `reason` ∈ `terminal` \| `handoff-cap` \| `empty-chance` \| `chance-outcome` \| `deterministic` | the descent stopped descending |
| `rollout.step` | `stepIndex:int`, `stateKey`, `actor`, `handoffs:int`, `legalCount:int` | one rollout step begins |
| `rollout.guidance` | `stateKey`, `actionKey`, `value:number` | the guidance value of **one** candidate; emitted for every candidate, in original order |
| `rollout.pick` | `stateKey`, `actionKey`, `legalCount:int` | the action the rollout policy chose |
| `rollout.chance` | `stateKey`, `outcomeIndex:int`, `nextStateKey`, `outcomeCount:int` | the rollout sampled a CHANCE outcome |
| `rollout.next` | `nextStateKey`, `handoffs:int`, `cycled:boolean` | the rollout advanced one primitive action |
| `rollout.empty` | `stateKey` | no legal action in the rollout |
| `rollout.stop` | `reason:"handoff-cap"\|"deadline"`, `stepIndex:int` | the rollout stopped without reaching a leaf |
| `rollout.leaf` | `stateKey`, `leafValue:number`, `terminal:boolean`, `stepIndex:int` | the value this simulation backpropagated |
| `sim.end` | `index:int`, `completed:boolean`, `reward:number`, `leafValue:number`, `terminal:boolean`, `pathLength:int`, `rolloutSteps:int`, `chanceSamples:int`, `policyDraws:int`, `chanceDraws:int`, `maxHandoffs:int` | closes the digest |
| `plan.edge` | `stateKey`, `edgeKey`, `transitionKind` | principal-line walk step |
| `plan.stop` | `reason:"actor"\|"no-child"`, `stateKey` | why the tree walk ended |
| `plan.guidance` | `stateKey`, `actionKey`, `value:number` | guidance during plan extension |
| `plan.pick` | `stateKey`, `actionKey`, `legalCount:int` | extension action chosen |
| `plan.extension` | `stateKey`, `actionKey`, `kind:"step"\|"handoff"` | one extension step appended to the plan |

### 3.1 What is deliberately NOT recorded

Recording any of these would make the two arms' digests differ for reasons that are
not decision semantics:

- which arm produced the event (`baseline` / `prepared`);
- the number of internal rule calls, or whether a prepared batch was used;
- whether a rollout step took the fail-closed legacy path;
- timing of any kind (`elapsedMs`, wall clock);
- the `UctNode` object identity, pointer addresses, or object key order.

The trace records **decisions and their inputs**, so equal decisions in the two arms
must produce byte-identical event streams. `phase1Seam.test.ts` H5 asserts exactly
that for a real cell.

---

## 4. Memory model

An event stream is fed into an incremental SHA256 as it is produced. A 200-simulation
call therefore retains:

- 200 digests (64 hex characters each),
- 200 small summary objects (counters + reward + leaf value),
- optionally, the event body of **one** simulation (`captureSimulation = i`).

Nothing else. The event body of a non-captured simulation is never materialised, so a
full Phase 1 repetition cannot grow with the trace length.

Forensics on a mismatch: `phase1Parity` re-runs the same `(root, repetition, arm)` with
`captureSimulation = <first divergent index>` and `capturePlan = true`. The call is
deterministic (frozen clock, fixed seed, fixed K, fixed seed stub for the one known
`Math.random` impurity), so the re-run reproduces the same events.

---

## 5. Failure modes

| symptom | meaning |
|---|---|
| `sim.end` has `completed = false` | a simulation was aborted; in Phase 1 this is always a harness execution anomaly (the clock is frozen and K < node cap) |
| `digest` differs at simulation *i* but every earlier digest matches | the two arms took the same decisions for *i* simulations and diverged on the *i*-th |
| `planTraceDigest` differs while all 200 digests match | the search agreed and only the plan walk disagreed — recorded separately on purpose |
| `TraceCollector.record` called with no open phase | silently ignored by design (`hash === null`), which keeps every call site unconditional |

---

## 6. Files

| file | role |
|---|---|
| `PPC-MCTS-01B/proto/trace.ts` | encoding, collector, RNG tap, canonical digest |
| `PPC-MCTS-01B/proto/uctBaseline.ts` | baseline arm + seam + event points |
| `PPC-MCTS-01B/proto/uctPrepared.ts` | prepared arm + identical seam + identical event points |
| `PPC-MCTS-01B/drivers/lib/phase1.ts` | arm runner, whole-tree digest, comparable projection, diff, anomaly gate |
| `PPC-MCTS-01B/drivers/phase1Parity.ts` | per-repetition driver, JSONL append, forensics capture |
| `PPC-MCTS-01B/probe/impl/phase1Seam.test.ts` | H1–H6 harness correctness |
