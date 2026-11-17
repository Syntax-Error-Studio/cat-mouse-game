# RESOURCE_SAFETY_LOG — PPC-P2-PREPARED-TRANSITION-01

Host: Windows, 16 GB RAM (16 088 MB visible). All heavy work in this round was serialised by
construction; nothing was ever run in parallel.

## 1. Pre-flight (before the first heavy task)

| check | result |
|---|---|
| `node -v` | v22.22.2 |
| `vitest` | 4.1.10 |
| running `node.exe` processes | 23, all ≤ 22 MB working set — WorkBuddy runtime / language servers, **not** vitest, **not** a benchmark. None were touched. |
| free physical RAM | 2 317 MB of 16 088 MB |
| stale benchmark lock | none (created by the driver itself, see §4) |
| other heavy runner in flight | none |

Heavy tasks were launched one at a time:

1. correctness / probe suites (single `vitest` process, `--maxWorkers=1 --no-file-parallelism`)
2. A/A benchmark (driver, 40 fresh processes, serial)
3. A/B benchmark (driver, 40 fresh processes, serial)
4. full regression (single `vitest` process) — **started only after** both benchmark runs finished

No `Promise.all`, no worker pool, no `xargs -P`, no second background benchmark, no
`--max-old-space-size` change, no reduction of roots / repetitions / depth / test count.

## 2. Benchmark resource shape (measured, not estimated)

Per fresh benchmark process, from `_raw/bench/*.json` → `process`:

| metric | value |
|---|---|
| RSS | ≈ 135 MB |
| heap used | ≈ 60–75 MB |
| process wall time | 3.5–7 s (≈ 2 s of measurement + vitest startup) |
| peak `maxRSS` (Windows) | reported 0 by `process.resourceUsage()` — the field is a no-op on Windows, so RSS is recorded instead of peak RSS |

80 benchmark processes total (40 A/A + 40 A/B), one at a time → peak concurrent benchmark memory
≈ 135 MB. No paging, no OOM, no swap pressure observed. Total benchmark wall time: 196 s (A/A
replicate #1), 153 s (A/A authoritative), 149 s (A/B).

## 3. Duplicate-benchmark check

The driver refuses to start when `PPC-P2-PREPARED-TRANSITION-01/_raw/.bench.lock` exists **and** its
pid is alive (`process.kill(pid, 0)`). A stale lock from a dead pid is cleared and logged. Every
measurement is a `spawnSync` call, so the next arm cannot start before the previous process has
fully exited — the guarantee is structural, not a timing convention.

## 4. Incident: interrupted first A/A run

The very first `runBench.mjs aa 20` invocation was executed by the shell inside a sandbox that was
terminated after the run had already completed (`logs/bench_aa.log` ends with
`# driver done … totalSec=196.1`), which left the lock file behind and made the *next* invocation
abort with `another benchmark driver holds the lock`.

Handling (no data destroyed, no threshold moved):

- the 40 completed measurements are kept verbatim as `_raw/bench/run1_*` and are **not** used for
  the reported statistics; they are an independent replicate (see below);
- the lock was cleared only after confirming the pid was dead;
- the driver gained a pid-liveness check so this cannot recur;
- A/A was re-run from scratch (`aa_*`, 40 files) and that clean run is the authoritative one.

Replicate consistency, for the record:

| A/A replicate | pairs | geometric mean | CI95 |
|---|---|---|---|
| run 1 (kept as `run1_*`) | 20 | 1.00065 | [0.99278, 1.00858] |
| run 2 (authoritative `aa_*`) | 20 | 0.99545 | [0.98796, 1.00300] |

Two independent 20-repetition A/A runs agree to within 0.6 %, and neither interval is wider than
±1 %. That is what makes the A/B interval interpretable rather than lucky.

## 5. What was NOT run concurrently

- No regression while a benchmark was running (the regression was started after the A/B run
  reported `# driver done`).
- No compiler/build while a benchmark was running.
- No second probe suite in parallel with the full regression.

## 6. Post-benchmark phase (all serial, after the regression finished)

The regression was the last heavy task; everything below ran afterwards, one command at a time:

| order | command | wall | why serial |
|---|---|---|---|
| 1 | `node probe/parseRegression.mjs` | <1 s | pure file parse |
| 2 | `npx tsc -b` | ~20 s | build must not overlap anything timing-related |
| 3 | `npm run build` (`tsc -b && vite build`) | 7.29 s | same |
| 4 | `npx vitest run --config probe/vitest.config.mts probe/stageEvidence.test.ts` ×4 | 8.6 s each | the deadline block inside it is timing-sensitive; never run two at once |
| 5 | `npx vitest run src/game/ai/__tests__/preparedTransition.test.ts` | 1.2 s | confirms the 18 tests independently of the full run |
| 6 | `npx vitest run src/game/ai/__tests__/boundedPlanRefutation.test.ts --reporter=verbose -t "G0.3W"` | 1.2 s | identifies the 4 pre-existing skips the default reporter will not name |
| 7 | `node probe/buildArchive.mjs`, `node probe/verify_restore.mjs` | ~3 s | archive + out-of-tree extraction |

Nothing in this list overlapped the full regression or the benchmarks. The 5 deadline samples were
produced by 5 sequential invocations of the same test file; no `--repeat`, no parallel workers.

## 7. Artefacts

- `logs/bench_aa.log`, `logs/bench_ab.log` — every driver line, including per-repetition
  `medianSweep`.
- `logs/full_regression.log` — the single authoritative regression run (291 726 B, never rerun).
- `logs/tsc.log` (empty, exit 0), `logs/build.log`.
- `_raw/bench/` — 122 JSON files (2 trial + 40 replicate A/A + 40 authoritative A/A + 40 A/B).
  Each file carries `run / arm / role / rep / sweeps / sweepTotalMs / process / roots`.
- `_raw/deadline_integration_run{1..5}.json` — the 5 independent 100 ms diagnostic captures, plus
  `_raw/deadline_integration_repeat.json` (the aggregate). The probe's own `deadline_integration.json`
  was deleted after the aggregate was built because it was byte-identical to `run5`
  (`ed83c997…`) and keeping both would let one sample masquerade as two.
- `_raw/rng_audit.json` — 0 `Math.random` draws across 24 roots.
