# FINAL GATE REPORT — Phase 1 / Phase 2 prerequisites

Round: **PPC-MCTS-01B final execution** (FINAL GATE → Phase 1 → Phase 2 → report integration)
Repository: `F:\小猫小鼠`, branch `ppc/p1-id-state-identity-fix`, HEAD `48eaac6c4f3801d351787696ba5876995b64e8d8`
Writable scope for this round: `PPC-MCTS-01B/` only.

Verdict: **GATE A = PASS, GATE B = PASS, GATE C = PASS.**

---

## 0. Pre-flight (identity, resources, duplicate tasks)

| check | result |
|---|---|
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8` (unchanged) |
| branch | `ppc/p1-id-state-identity-fix` (unchanged) |
| worktree | 15 modified + 55 untracked, identical to the state at task start; no reset / clean / stash / checkout was run |
| `GAMEPLAY.md` | `e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34` (untouched) |
| `PPC-MCTS-01/proto/uct.ts` | `508a65bf53b63555bc4d3f8de7199b8607a8544572bb0e55850445cdffa2c53a` (frozen, untouched) |
| `PPC-MCTS-01B/proto/uctBaseline.ts` | `7df9d8d1bb42f984f5f866c8444b40f7133b1aa84d43f8229e5b731f38eff068` |
| `PPC-MCTS-01B/proto/uctPrepared.ts` | `0e6f105088b8df98e3d4a3e45a2ac6ab55f4231c837bdb1f861e4f701c27e3b2` |
| 24-root fixture | `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09` |
| leftover Pilot / Phase 1 / Phase 2 workers | none (`HEAVY=0` in every sample) |
| other-agent heavy benchmarks | none; the 12 live `node.exe` processes are WorkBuddy and Codex runtimes (MCP servers), no vitest / bench / driver |
| partial formal raw data | none — `data/phase1-formal/` and `data/phase2-formal/` did not exist before this round |

### Resource sampling (two rounds, 3 s interval, ≥ 30 s total)

Round 1 (00:41:00 – 00:42:06, 12 samples): free physical 1695–2416 MB, `Available MBytes` 1776–2329, commit headroom 7321–7484 MB, pagefile used 2235–2887 MB, CPU 1–9 %, node 12.
One `Pages Output/sec` spike of 11 048 at 00:41:25, zero in all other samples of round 1 and in all of round 2. Round 2 was taken to decide whether that spike was sustained.

Round 2 (00:42:23 – 00:43:26, 12 samples): free physical **2207–2410 MB**, available 2236–2410 MB, commit headroom **7339–7471 MB**, pagefile used **2758–2774 MB (falling)**, `Pages Output/sec` **0 in all 12 samples**, `Pages Input/sec` ≤ 451, CPU 0–26 %.

Decision: **ADMISSION = PASS**, with the caveat recorded here that free physical memory sits around 2.2 GB and that a single 11 048 pages-out spike was observed once. The gate conditions in the task book (below 1 GB, sustained decline, sustained non-zero pages-out, pagefile visibly growing) were not met in the authoritative round. No other process was killed, no concurrency raised, no heap enlarged.

---

## GATE A — Phase 1 serial fresh-process orchestrator

New file: `PPC-MCTS-01B/scripts/runPhase1.mjs`.

| requirement | implementation |
|---|---|
| `TOTAL_REPETITIONS = 20` | `TOTAL_JOBS = 20`, `REPS = 1..20` |
| `TOTAL_ROOTS = 24`, `TOTAL_ARMS = 2` | asserted per repetition by the validator |
| `TOTAL_SEARCH_CALLS = 960` | `TOTAL_CALLS = 24 * 2 * 20`, checked against the raw files |
| `FRESH_NODE_PROCESSES = 20` | one `spawnSync` per repetition |
| `HEAVY_WORKER_CONCURRENCY = 1` | `spawnSync` blocks until the child exits; no `Promise.all`, no pool, no background shell |
| cheap log lines | prints `TOTAL_JOBS=20`, `HEAVY_WORKER_CONCURRENCY=1`, `CURRENT_JOB=n/20`, `JOB n/20 EXITED CLEANLY` |
| per-call persistence | the child appends each record to `rep-NN.jsonl` immediately and rewrites the checkpoint |
| post-repetition validation | 24 records, 2 arm-calls each, `K=200` per arm, seam reached, no node-cap/deadline stop, 0 aborted, 0 `Math.random` draws, 200 digests per arm and element-wise equality |
| no overwrite | refuses to start if the output directory is non-empty unless `--resume`; on resume it validates existing repetitions instead of re-running them |
| no silent re-run | a repetition whose files exist is skipped and validated; it is never deleted or truncated |

Dry run output (`node PPC-MCTS-01B/scripts/runPhase1.mjs --dry-run`):

```
TOTAL_JOBS=20
HEAVY_WORKER_CONCURRENCY=1
SERIAL_FRESH_REPETITIONS=TRUE
FRESH_NODE_PROCESSES=20
TOTAL_ROOTS=24 TOTAL_ARMS=2 K=200
TOTAL_SEARCH_CALLS=960
EXPECTED_TOTAL_SIMULATIONS=192000
OUT_DIR=PPC-MCTS-01B/data/phase1-formal
```

---

## GATE B — baseline fork diff classification

`UNCLASSIFIED_DIFF_LINES = 0`, and the count is *conserved*: the classified lines sum to exactly the diff size.

```
diff    +195 / -39
HEADER_COMMENT             + 30 -  0
COMMENT_OR_BLANK           + 26 - 13
IMPORT_SPECIFIER           +  7 -  5
CLASS_RENAME               +  1 -  1
SEAM_STOP_HOOK             +  8 -  0
RNG_INIT_BRANCH            + 14 -  2
TRACE_PLUMBING             + 27 -  0
TRACE_EVENT_CALL           + 27 -  0
TRACE_CALL_ARGUMENT        + 15 -  0
LEAF_VALUE_CARRY           + 10 -  0
GUIDANCE_TAP_ARGUMENT      +  2 -  2
STRUCTURAL_LINE            + 16 -  0
STATEMENT_SPLIT            +  1 -  3
RE_EXPORT_FOR_COMPANION    +  1 -  0
SIGNATURE_WIDENED_SOURCE   +  0 -  1
STATEMENT_SPLIT_OPEN       +  4 -  0
CONDITION_HOIST            +  1 -  0
CONDITION_HOIST_USE        +  1 -  0
INLINE_BODY_SPLIT          +  4 -  0
STATEMENT_SPLIT_SOURCE     +  0 - 12
UNCLASSIFIED_DIFF_LINES=0
```

Conservation: added `+30+26+7+1+8+14+27+27+15+10+2+16+1+1+4+1+1+4 = 195`; removed `13+5+1+2+14+1+12 = 39`. Both equal the diff stat exactly.

How the residue was actually closed (not by a catch-all bucket): every fork line in a residue category must name the parent line it replaces, and every parent line must name the fork lines that carry its parts. The classifier is cross-referenced, so the evidence is checkable line by line in `BASELINE_FORK_PROVENANCE.json → classification.perLine`, where each entry carries `side`, `lineNo`, `parentAnchor`, 2-line `context`, `category`, `evidence` and a line-specific `why`.

Worked examples (verified against the two files by hand):

| parent | fork | category |
|---|---|---|
| `if (isTerminal(cur.state)) break;` | `if (isTerminal(cur.state)) { this.tr('tree.cycle', …); break; }` | `STATEMENT_SPLIT_SOURCE` → evidence cites the fork line |
| `if (keys.has(k)) { state = next; break; }` | `const cycled = keys.has(k);` + `if (cycled) { state = next; break; }` | `STATEMENT_SPLIT_SOURCE` (hoist path) → evidence cites both fork lines |
| `if (this.opts.now() >= this.deadlineAt) { this.deadlineReached = true; return {…}; }` | `if (this.opts.now() >= this.deadlineAt) {` … `this.deadlineReached = true;` … | `STATEMENT_SPLIT_SOURCE` + `STATEMENT_SPLIT_OPEN` + `INLINE_BODY_SPLIT` |
| `return { completed: true, reward: evaluateLeaf(state), … }` | `const leafValue = evaluateLeaf(state);` … `reward: leafValue` | `LEAF_VALUE_CARRY` — still exactly one evaluation, same value |

**No behavioural difference was found.** The 96-cell regression was therefore not re-run for a fork fix; it was re-run anyway as part of the ordinary gate (`Tests 14 passed (14)`), and the fork hash is unchanged from the harness-repair round (`7df9d8d1…`).

Two classifier bugs were found and fixed while doing this, and are disclosed because they had produced a *false* zero in the previous round's favour:
1. the multi-line trace-call tracker used a text pattern instead of paren depth, so a balanced one-liner mentioning `this.trace.planEnd()` opened a span that never closed and swallowed 29 subsequent lines as "trace arguments";
2. a residue counter used `counts[cat]++` on a key initialised only for the declared categories, yielding `NaN` and silently dropping a bucket from the summary.

Both are fixed; the numbers above are from the fixed classifier.

---

## GATE C — Phase 2 timing semantics

Read from source, not from prose:

| fact | location |
|---|---|
| `FULL_TURN_BUDGET_MS = 150` | `PPC-MCTS-01/proto/harness.ts:35` |
| `withinFullTurnBudget: base.totalMs <= FULL_TURN_BUDGET_MS` | `PPC-MCTS-01/proto/harness.ts:204` |
| `const t0 = performance.now();` before `new UctSearch(...)`, `totalMs = performance.now() - t0` **after** `replayPlanWithEngine` | `PPC-MCTS-01/proto/harness.ts:290–310` |
| orchestrator is a plain serial `spawnSync` loop | `PPC-MCTS-01/scripts/runPilot.mjs:31–53` |

Conclusion: the original Pilot's 150 ms test is **replay-inclusive**. This round's task book fixes a different headline (`withinPlanner150ms = plannerWallMs <= 150`, production planning without the offline replay) and requires the Pilot value to survive untouched. Both are emitted:

| field | expression | status |
|---|---|---|
| `withinPlanner150ms` | `plannerWallMs <= 150` | **AUTHORITATIVE** |
| `legacyPilotComparable150ms` | `plannerWallMs + replayMs <= 150` | recorded separately, never substituted |
| `validationEndToEndMs` | `plannerWallMs + replayMs` | validation quantity, never a budget |
| `withinFullTurnBudget` / `plannerWithinFullTurnBudget` | deprecated aliases | kept so earlier artefacts stay readable |

New fields added to `drivers/perfBudget100.ts`: `validationEndToEndMs`, `withinPlanner150ms`, `legacyPilotComparable150ms`, `planFullTurnConsumed` (from `replay.ts` `fullTurnConsumed`). `PHASE2_PREREGISTRATION.json` was updated to match, including a `changeFromHarnessRepairRound` note stating that no measured Phase 2 data existed yet, so nothing is reinterpreted.

Smoke proof that the fields populate (`data/phase2-smoke-gatec/`, **not evidence**):

```
baseline G2T6 rep=1 planner=101.0ms search=100.0ms replay=1.1ms sims=21
prepared G2T6 rep=1 planner=101.5ms search=100.1ms replay=0.2ms sims=34
withinPlanner150ms (AUTHORITATIVE, replay excluded): baseline 2/2, prepared 2/2
legacyPilotComparable150ms (Pilot, replay-inclusive): baseline 2/2, prepared 2/2
planFullTurnConsumed: baseline 2/2, prepared 2/2
math.random draws = 0
```

---

## Post-gate rebuild and verification

| step | result |
|---|---|
| `tsc --noEmit --strict` over 8 source files | 0 errors |
| `node scripts/build-drivers.mjs` | 3 bundles rebuilt; `perfBudget100.mjs` = `94c7dffa…` (changed by GATE C), `phase1Parity.mjs` = `26f4c66c…` (unchanged), `parityFixedSims.mjs` = `1cef6942…` (unchanged) |
| harness correctness suite | `Test Files 2 passed (2) · Tests 14 passed (14)`, exit 0 — `data/vitest-gate-recheck.log` |
| provenance regenerated | `BASELINE_FORK_PROVENANCE.json`, `UNCLASSIFIED_DIFF_LINES=0` |
| `src/`, `GAMEPLAY.md`, `PPC-MCTS-01/`, `PPC-MCTS-01A/` | unchanged (hashes above; `git status` unchanged) |

All three gates passed, so the run proceeded to Phase 1 automatically as instructed.
