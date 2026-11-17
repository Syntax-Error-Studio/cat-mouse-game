# RESOURCE_SAFETY_LOG — PPC-CAT-EVALUATOR-ABLATION-01

Authorization: `AUTHORIZED_FOR_ISOLATED_RESEARCH`. Production source modification: **NO**.
Heavy-worker concurrency: **1**. Serial fresh repetitions: **TRUE**. Duplicate-benchmark check: **REQUIRED**.

This log records every resource probe, contention decision, and cleanup action. Wall-clock
phases (P5/P6) are GATED on a quiescent host; correctness phases (P2/P3/P4 — boolean/exact,
timing-independent) may proceed under light contention. External processes are NEVER killed.

## Host toolchain
- Windows 10.0.26200, Git Bash, Node v24.22.1, vitest 4.1.10 (only TS runner).
- Probe config `PPC-CAT-EVALUATOR-ABLATION-01/probe/vitest.config.mts`: `fileParallelism:false`,
  `maxWorkers:1` (serial by construction). Fresh-process reps = separate invocations (env vars).
- Known host quirk: the Bash tool expands inline PowerShell `$_` → write `.ps1` files instead
  (`census_min.ps1`, `inspect_ext.ps1`, `kill_ablation.ps1` under `F:/ppc-checkpoints/`).

## Census probes (live, read-only)

### During P3/P4 (prior segment)
- External heavy benchmark RUNNING: PID 5304 `resume-run.mjs`, PID 40872 `watch-v5.mjs`.
  → P5/P6 wall-clock GATED. P2/P3/P4 correctness proceeded (timing-independent).
- DocMap agent PID 3160 `codebuddy-headless` = a DIFFERENT task (not killed, not disturbed).
- Orphaned vitest workers after a TaskStop (node children 9488/20416/20072 survived the bash
  parent kill). Cleaned with `kill_ablation.ps1` matching ONLY
  `PPC-CAT-EVALUATOR-ABLATION-01/probe` node command lines. Killed 9488/20416 (20072 already
  gone); confirmed CLEAN; external benchmark + DocMap untouched. Free RAM recovered 2741→3281 MB.

### P4 re-run gate (this segment, after fixing the UNRESOLVED classification defect)
- `census_min.ps1`: FreePhysical_MB=3089, UsedPct=80.8, CPU_LoadPct=20. No ablation/vitest workers.
- External match: PID 28052 (WS 18 MB), 33560 (WS 2 MB), 25516 (WS 84 MB, exited before inspect).
- `inspect_ext.ps1`: 28052/33560 = `node .../docmap-studio/.next/ai-reliability-cont-20261115/dev/build/postcss.js`
  (light CSS build workers, 2–18 MB WS). The earlier HEAVY benchmark (`resume-run.mjs`/`watch-v5.mjs`)
  is GONE. 25516 GONE.
- Decision: P4 is a CORRECTNESS re-run (deterministic boolean/exact verdicts; ~5.7 min; peak a few
  hundred MB, well within 3089 MB free; it already completed once at this memory level). Proceed in
  background. No V8 heap enlargement. P5/P6 remain GATED until a fresh census confirms quiescence.

## Resource-anomaly stop rule (standing)
If OOM, sustained near-full memory, a duplicate benchmark, whole-machine stall, or any other
resource anomaly occurs: STOP expansion immediately, preserve logs + checkpoint, do NOT enlarge
heap / lower depth / cut reps / delete failing roots / shrink CHANCE branches to manufacture PASS.

## Pending wall-clock gate (P5/P6)
Before executing `run_p5_rounds.sh` / `run_p6_pairs.sh`: re-probe `census_min.ps1` live. If an
external HEAVY task is present, WAIT (never kill it). Record the pre-run census here.

### P5/P6 gate decision (this segment, after P4 closed)
- `census_min.ps1`: FreePhysical_MB=3366, UsedPct=79.1, **CPU_LoadPct=1** (idle). No ablation workers.
- `inspect_bench.ps1`: **HEAVY_BENCHMARK_PRESENT=NO** (no `resume-run`/`watch-v5` node process).
  Census-matched PIDs: 29008/22028 = docmap-studio `postcss.js` build workers (21–46 MB WS);
  40156 = `tools/ai-eval/reliability-final-run.mjs --confirmed-free --only=mindmap --repeats=1
  --base=http://127.0.0.1:3255` (85 MB WS) — a LIGHT, I/O-bound single-repeat mindmap validation
  (a different task), NOT a heavy CPU search grid. TOTAL_NODE_PROCS=6.
- Ruling: the gate condition (external **HEAVY** task) is NOT met — the heavy search benchmark is
  gone and the host is idle (1% CPU). P5 (decision-consistency, robust to timing variance via
  5→10 rounds) proceeds. P6 carries an explicit A/A calibration guard: if the light external eval
  contaminates timing, A/A CI excludes 1 → PERFORMANCE BLOCKED (reported, never fabricated).
  Re-probe census again immediately before P6. External processes NEVER killed.

### P6 pre-run gate (this segment, after P5 closed 48/48 consistent, needsExtension=false)
- `census_min.ps1`: FreePhysical_MB=3639, UsedPct=77.4, **CPU_LoadPct=7**. No ablation/vitest workers.
- `inspect_bench_live.ps1` (fresh, CPU-time delta over 4s — stale hardcoded PIDs in `inspect_bench.ps1`
  were NOT trusted): the `resume-run`/`watch-v5` HEAVY benchmark is GONE. Matches are
  PID 29008/22028 = docmap `postcss.js` build workers (WS 1.1/1.2 MB, **Delta4s=0**),
  PID 1904 = `reliability-final-run.mjs --confirmed-free --only=edit-9-0 --repeats=1` (WS 85.5 MB,
  **Delta4s=0**) — a LIGHT, I/O-bound single-repeat docmap eval (a different task). Other node procs:
  codebuddy-sdk-probe (284 MB, idle), next dev start-server (126 MB, idle). TOTAL_NODE_PROCS=7.
- Ruling: every external candidate has **zero CPU delta over 4s** → host quiescent, no active HEAVY
  task. Gate NOT met. P6 (80 serial fresh-process pairs + eval self-cost + aggregate) proceeds in
  background. A/A calibration is the noise backstop: if the light external eval contaminates timing,
  A/A CI excludes 1 → PERFORMANCE BLOCKED (reported, never fabricated). External processes NEVER killed.

### P6 wall-clock run outcome (this segment)
- `run_p6_pairs.sh` completed exit 0: 80 serial fresh-process runs (20 A/A + 20 A/B pairs) + §7.1 eval
  self-cost (40 reps) + §7 aggregate. No OOM, no stall, no duplicate benchmark, no heap enlargement,
  no rep reduction. HEAVY_WORKER_CONCURRENCY=1 throughout.
- §7.1 eval self-cost ratioGM=0.9785 CI=[0.9462,1.0119] (contains 1 → no significant difference).
- §7.3 **A/A calibration FAIL**: GM=0.9869 CI=[0.9744,0.9997] excludes 1 (marginal systematic
  second-process ordering bias, noiseSdLog=0.1433). Per pre-registration → **PERFORMANCE=BLOCKED_AA_CALIBRATION**.
  A/B GM=1.0296 confounded by the same bias. NOT relaxed, NOT re-run to cherry-pick, NOT post-hoc
  corrected; correctness evidence (P2/P3/P4/P5) preserved unchanged. A measurement-noise verdict,
  NOT a resource anomaly (host stayed quiescent).

### P8 seal: self-reference defect + cleanup (this segment)
- Seal attempt 1 FAILED on ONE file: the console log was teed to `logs/seal_run.log` INSIDE the round
  dir, so the content walk hashed it empty (0 bytes) and `tee` wrote it during the run → restore
  byte/line-ending mismatch (the "closing instrument must exempt its own output" trap). All other
  content files byte-identical; missing=0 extra=0; working-tree integrity already PASS.
- Cleanup: preserved attempt-1 sealing outputs + log OUTSIDE the repo at `F:/ppc-checkpoints/seal_attempt1/`;
  removed the defective archive + restore dir (own just-created outputs, NOT prior-round history);
  removed the round-dir `logs/seal_run.log`. Re-sealed with the console log OUTSIDE the repo
  (`F:/ppc-checkpoints/seal_run_ablation.log`). PASS: 126 content files, restore 128/128 byte-identical,
  0 line-ending mismatch, missing=0 extra=0. Independent external verifier INDEPENDENT_VERIFY=PASS.

### Baseline divergence detected at P8 (DISCLOSED, not a round violation)
- `git diff -- src GAMEPLAY.md` NON-EMPTY: 15 files (+1015/−219) — the user's in-progress
  PPC-P2-PREPARED-TRANSITION-01 candidate-enumeration refactor + timing-repair production patches.
- EVERY changed src file mtime ∈ [2026-11-12 21:11, 2026-11-14 13:07], ALL predating the round's first
  artifact (2026-11-15 20:16:23) ⇒ `changedDuringRound=[]`, `roundModifiedProduction=FALSE`. This round
  wrote NO production source (all round writes confined to the round dir + F:/ppc-checkpoints).
- E1/H1 leaf sources `evaluation.ts` + `correctedHoleLeaf.ts` byte-identical to HEAD (empty diff).
- Both arms ran against the SAME stable substrate ⇒ RELATIVE E1-vs-H1 comparison valid; ABSOLUTE
  baseline = HEAD+pre-existing-patches, NOT pristine HEAD. Disclosed in REPORT.md «一之补»,
  SOURCE_MANIFEST.json.sourceIntegrity, SEAL_VERIFICATION.json.workingTree. NO gate edited, NO evidence
  deleted, NO user work disturbed (STASH/CLEAN/RESET all NO). Priced routes A/B/C handed to ChatGPT.