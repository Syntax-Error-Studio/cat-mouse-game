# HARNESS_CORRECTNESS_REPORT

`PPC-MCTS-01B-HARNESS-REPAIR` — correctness evidence for the repaired infrastructure.

Everything below was produced inside `PPC-MCTS-01B/`. No production source, no
`GAMEPLAY.md`, no `PPC-MCTS-01/`, no `PPC-MCTS-01A/` file was modified.

---

## 1. Verdict table

| # | Gate | Command | Result | Evidence |
|---|---|---|---|---|
| G-1 | Baseline fork ≡ frozen parent, 96 fixed-node cells | `vitest … -t H1` | **PASS** | `probe/impl/phase1Seam.test.ts` |
| G-2 | Seam yields exactly K complete simulations | `vitest … -t H2` | **PASS** | 32 arm-calls, K ∈ {1,2,3,5} |
| G-3 | Seam stops BETWEEN simulations (digest prefix) | `vitest … -t H3` | **PASS** | k ∈ {1,3,7,12} on baseline, {2,9} on prepared |
| G-4 | Trace is RNG-neutral (with ≡ without) | `vitest … -t H4` | **PASS** | both arms, K=30 |
| G-5 | Trace is deterministic and arm-independent | `vitest … -t H5` | **PASS** | sim#4 events byte-identical across arms |
| G-6 | CHANCE is actually reached and stays in lockstep | `vitest … -t H6` | **PASS** | 10/24 cells, 144 samples at K=8 (`repetition=0` seed; the `--rep=1` smoke run gives 139 — see §7) |
| G-7 | Tree digest is stable and discriminating | `vitest … -t H7` | **PASS** | K=10 twice ≡, K=11 ≢ |
| G-8 | Existing A–F rollout-reuse correctness | `vitest …` (all) | **PASS** | see §3 |
| G-9 | 96/96 fixed-node parity regression | `--legacy-nodes=64,200 --modes=hybrid,random` | **PASS** | `data/impl-parity-breadth.json`, 878 625 → 570 561 rule calls |
| G-10 | Fixed-completed-simulation parity, all 24 roots | `--smoke --roots=all --sims=8` | **PASS** | 24/24 cells, per-simulation digests equal |
| G-11 | Phase 1 driver end-to-end | `node build/phase1Parity.mjs --smoke` | **PASS** | 2/2 calls, `SMOKE_NOT_EVIDENCE` |
| G-12 | Phase 2 driver end-to-end (bundled) | `node build/perfBudget100.mjs --smoke` | **PASS** | 4/4 calls, three timings separated |
| G-13 | Type check | `tsc --noEmit --strict` over all new/modified files | **PASS** | 0 errors |
| G-14 | Bundle build | `node scripts/build-drivers.mjs` | **PASS** | 3 entries, digests in `BUILD_OUTPUTS.json` |

---

## 2. Why the old Phase 1 driver could not have worked

`parityFixedSims.ts` used `maxNodes`. Under a node cap, two arms execute the same
number of simulations only if they already take identical decisions — a node is
created by exactly the decisions that are in question. So the driver's "fixed
simulation count" was a *consequence* of parity, never a *test* of it: a divergent
arm would simply run fewer simulations and the comparison would still be
"self-consistent" on the fields it looked at.

Worse, the per-simulation identity of the two runs was never established. A tree
fingerprint at the end says "the two trees differ"; it cannot say *which
simulation* diverged, nor whether the divergence was in the tree walk, the
rollout, or the CHANCE draw.

The repair therefore does three things at once:

1. a workload fixed in **completed simulations** (`maxCompletedSimulations`),
2. a **per-simulation SHA256** over the full event stream,
3. a **forensics re-run** that materialises the first divergent simulation's
   events for both arms.

---

## 3. Existing A–F correctness, and the one thing that was wrong with it

### 3.1 What was already right

A (action set/order/index), B (transition identity), C (guidance bit-exactness),
D (RNG draw count and choice), E (whole-tree parity at fixed node budgets),
F (fail-closed on the trap/butter impurity) were all green before this round and
remain green, unchanged in intent.

### 3.2 The random-stream isolation defect

The corpus builder added a **synthetic CAT-turn state with `trapPosition` sitting
on a butter**. That state is not a function of its inputs: `engine.catMove` calls
`sanitizeItemOverlaps`, which relocates the overlapping butter through
`Math.random`. Two consequences:

- **nondeterminism**: test A enumerates that state twice (legacy + prepared); the
  two enumerations can disagree because each one draws fresh entropy to move the
  butter, so A could fail intermittently;
- **stream pollution**: the global `Math.random` was advanced during corpus
  construction and enumeration, i.e. outside any guard, so no other suite could
  reason about the entropy it consumed.

### 3.3 The fix

- the overlap coverage point is now carried by a **MOUSE-turn** synthetic state:
  `mouseStep` does not sanitise, so the overlap survives into the successors
  without ever touching `Math.random`;
- corpus construction, `infoOf(...)` and the whole test-A enumeration now run
  under a **throw-on-call** `Math.random` guard that counts draws and aborts if
  any occurs, and the test asserts `draws === 0`;
- a structural assertion records that every overlap state in the corpus is a
  mouse turn, so a future edit cannot reintroduce the cat-turn version silently;
- the fail-closed fallback itself is verified by **F alone**, under a
  deterministic LCG stub with a reset stream, which is the only place where the
  impurity is supposed to happen.

This changes test *inputs*, not test *semantics*: A–F assert exactly what they
asserted before.

---

## 4. H1 in detail — is the fork really the parent?

96 cells = 24 roots × {hybrid, random} × {maxNodes 64, 200}. Both runs use
`now() => 0`, so neither can be stopped by a clock.

Per cell the following must be **identical**:

- whole-tree fingerprint (`treeFingerprint`: node kind, hand-off depth, stateKey,
  visit count, total/mean reward, edge key + transition kind, CHANCE weight,
  per-outcome sample counter, per-outcome stateKey)
- plan string, `planCost`, `planExtended`, `treePlanLength`, `extensionSteps`
- `rootAction`, `rootVisits`, `rootMeanReward`, every `rootActionStats` entry
- every comparable diagnostic: `simulations`, `abortedSimulations`,
  `nodesCreated`, `chanceNodes`, `chanceSamples`, `maxChanceMassError`,
  `rolloutSteps`, `maxHandoffsReached`, `deadlineHit`, `nodeCapHit`,
  `postDeadlineNodeCreations`
- `chanceSamples`

Observed: **96/96 identical, 11 101 simulations compared, 0 differences.**

Note on what this does *not* claim: it does not claim that a text-level stripping
of the instrumentation reproduces the parent (that kind of proof is unfalsifiable —
a stripper that deletes the wrong brace still yields an empty diff). It claims
that with the seam and the sink absent, the fork and the parent are
indistinguishable on every observable the experiment uses. The complete diff and
a per-category classification of every changed line are in
`BASELINE_FORK_PROVENANCE.json` and `DIFF_uct_to_uctBaseline.patch`.

---

## 5. H2/H3 in detail — is the seam honest?

**H2** — for K ∈ {1,2,3,5} and both arms on 4 roots (32 arm-calls):

- `simulations === K` exactly;
- `completedSimulationLimitHit === true` (the seam, not the node cap, stopped it);
- `nodeCapHit === false`, `deadlineHit === false`, `abortedSimulations === 0`;
- `digests.length === K`.

**H3** — the prefix property. A K=20 run produces 20 digests; a K=k run must
produce the same first k digests *as strings*. Checked for k ∈ {1,3,7,12} on the
baseline arm and {2,9} on the prepared arm. A stop in the middle of a simulation
would consume RNG and create nodes that the longer run had already used
differently, so the prefix would break. It does not.

Additionally, at K=20 the baseline and prepared arms produce **20/20 identical
digests** on G2T6 — the two arms already agree per simulation, not merely at the
end.

---

## 6. H4/H5 in detail — is the trace really inert?

**H4** — same root, same seed, K=30, both arms: run once with no sink and once
with a `TraceCollector`. Tree fingerprint, plan, root statistics and every
comparable diagnostic must be equal. They are. If the tap consumed a single
number, the two runs would diverge at the first rollout choice.

**H5** — the same call run twice produces identical digests and identical
plan-phase digests; the retained event body of simulation #4 is byte-identical
across the two runs **and across the two arms**. 68 events, of which 9 are
`rng.draw`. This is the strongest available statement that the trace records
*decisions*, not *mechanisms*: a trace that leaked "prepared vs legacy" would
differ between arms here.

Each event is a JSON array, so object key order can never enter a digest; the test
parses every event to confirm it is valid JSON.

---

## 7. Coverage honesty

| aspect | covered by | note |
|---|---|---|
| deterministic tree descent | H1, H3, H4, G-9, G-10 | |
| CHANCE layer | H6 (10/24 cells, 144 samples at K=8, `repetition=0`), probe B/C/D (1032 CHANCE transitions) | Phase 1 formal envelope reaches far more |
| single-legal-action rollout step (no RNG draw) | probe A/D, H1 | |
| trap/butter impurity | F (dedicated, deterministic stub) | deliberately excluded from the shared corpus |
| tunnel-exit phase | probe A, `data/parity.json` | |
| plan extension (`extensionSteps > 0`) | G-12 smoke (`treePlanLength 3`, `extensionSteps 1`) | |
| `deadlineHit` path | G-12 smoke (`deadlineFired: true`) | Phase 1 freezes the clock, so it must never occur there |

### 7.1 Why H6 says 144 and the smoke driver says 139

The two numbers are both correct and are not evidence of an environment split.
H6 seeds each root with `uctSeed(root.id, 'UCT-H', 0)`; `phase1Parity` defaults to
`--rep=1` and therefore seeds with repetition 1. The corpus size is identical
(10/24 cells reach the CHANCE layer either way), but the sampled workloads differ
on exactly the three roots with non-trivial CHANCE pressure:

| root | `repetition=0` | `repetition=1` |
|---|---|---|
| `G5T1` | 8 | 6 |
| `G2T4` | 24 | 25 |
| `G1T5` | 24 | 20 |
| 21 other roots | identical | identical |

This was closed by bundling one throw-away probe **with esbuild and running it
under plain `node`** (the driver's runtime, not vitest's SSR shim) over both
repetitions: rep 0 → `144`, rep 1 → `139`, each matching its counterpart
root-for-root. So the vitest environment and the bundled environment produce
byte-identical results for the same seed, and the only variable was the seed.
`mathRandomDraws` is 0 on both sides in every configuration.

The probe lived outside the repository and was deleted after use; nothing in
`PPC-MCTS-01B/` depends on it.

Not covered by this round, on purpose: the formal 960-call Phase 1, the formal
960-call Phase 2, self-play, Formal V2 (1700 groups), exhaustive oracle.

---

## 8. Reproduction

```bash
# type check
./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target ES2022 \
  --module ESNext --moduleResolution bundler --skipLibCheck --types node \
  --lib ES2022,DOM \
  PPC-MCTS-01B/proto/trace.ts PPC-MCTS-01B/proto/uctBaseline.ts \
  PPC-MCTS-01B/proto/uctPrepared.ts PPC-MCTS-01B/drivers/lib/phase1.ts \
  PPC-MCTS-01B/drivers/lib/arms.ts PPC-MCTS-01B/drivers/phase1Parity.ts \
  PPC-MCTS-01B/drivers/parityFixedSims.ts PPC-MCTS-01B/drivers/perfBudget100.ts

# harness correctness (H1 alone is ~5 min under vitest; that is expected —
# vitest's SSR shims are ~7x slower, which is exactly why timing runs use bundles)
./node_modules/.bin/vitest run --config PPC-MCTS-01B/probe/impl/vitest.config.mts

# bundle + smoke
node PPC-MCTS-01B/scripts/build-drivers.mjs
node PPC-MCTS-01B/build/phase1Parity.mjs --smoke
node PPC-MCTS-01B/build/parityFixedSims.mjs --smoke
node PPC-MCTS-01B/build/perfBudget100.mjs --smoke

# 96-cell fixed-node regression
node PPC-MCTS-01B/build/parityFixedSims.mjs --legacy-nodes=64,200 \
  --roots=all --modes=hybrid,random --out=PPC-MCTS-01B/data/impl-parity-breadth.json

# fixed-completed-simulation breadth (not Phase 1)
node PPC-MCTS-01B/build/parityFixedSims.mjs --sims=200

# provenance + manifest
node PPC-MCTS-01B/scripts/verify-baseline-fork.mjs
node PPC-MCTS-01B/scripts/gen-build-manifest.mjs
```
