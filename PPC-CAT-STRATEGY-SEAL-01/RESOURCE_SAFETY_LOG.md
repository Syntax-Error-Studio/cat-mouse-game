# RESOURCE_SAFETY_LOG — PPC-CAT-STRATEGY-SEAL-01

Round: PPC-CAT-STRATEGY-SEAL-01 (independent correctness seal of PPC-CAT-STRATEGY-01)
Recorded: 2026-11-15 (live re-probe at seal time, not carried from an earlier snapshot)
Scope: research only. Zero production edits. Previous-round artifacts preserved.

## 1. Source identity (live-verified)

| item | value |
|---|---|
| HEAD | `48eaac6c4f3801d351787696ba5876995b64e8d8` |
| branch | `ppc/p1-id-state-identity-fix` |
| working tree | 15 `src/` files show ` M` (real uncommitted prior-round changes, NOT CRLF artifacts); all PPC-* dirs untracked |

All 29 modified/untracked `src/` rows and all 16 read-only dependencies are
**byte-identical** to the frozen `PPC-CAT-STRATEGY-01/SOURCE_MANIFEST.json`
(0 mismatches; machine evidence `_raw/source_integrity.json`). Therefore
`PRODUCTION_SOURCE_CHANGED = NO`, `GAME_RULES_CHANGED = NO`,
`SEARCH_MATH_CHANGED = NO`, `H1_CHANGED = NO`, `SIDECAR_CHANGED = NO`.

The ` M` markers are NOT this round's edits, but they are also NOT CRLF artifacts.
`git diff --stat -- src` reports 15 files / 1015 insertions / 219 deletions, and
`git diff --ignore-cr-at-eol --stat -- src` reports the SAME 1015+/219- — proving
real content changes (e.g. `config.ts` adds the PPC-P1-CLOSURE-FIX-01 cat-move-budget
validation, importing `MAX_CERTIFIABLE_CAT_MOVE_BUDGET` from `./ai/planBound`). These
are pre-existing uncommitted prior-round production changes (P1-ID / P2 /
P1-CLOSURE-FIX). All 15 are **byte-identical** to the frozen
`PPC-CAT-STRATEGY-01/SOURCE_MANIFEST.json` baseline (`_raw/source_integrity.json`:
29 modified + 16 deps checked, 0 mismatches). This seal round wrote only to
`PPC-CAT-STRATEGY-SEAL-01/` (untracked) and `F:/ppc-checkpoints/` (outside the repo);
HEAD is unchanged at `48eaac6c`. The prior-round changes are left intact (other
tasks' work is not disturbed), so `PRODUCTION_SOURCE_CHANGED = NO` holds relative to
the frozen baseline this round sealed against.

## 2. Archive integrity (4 tarballs, binary SHA256 + byte length)

| archive | sha256 | bytes | matches prev manifest |
|---|---|---|---|
| F:/ppc-checkpoints/PPC-P1-CHECKPOINT-01-candidate.tar.gz | `5cd732828856f2b3cd903cc20c584bbb0fec7906d283ec08415bd2653a9425d5` | 4051823 | YES |
| F:/ppc-checkpoints/PPC-P1-OPENING-STACK-01-candidate.tar.gz | `a6a7795c4f31533a8127ec9e8594a4974aad019b73f69a1421a5c04930c2d015` | 85538 | YES |
| F:/ppc-checkpoints/PPC-P1-OPENING-SEAL-01-candidate.tar.gz | `27dbc3c2f4ad183f75808ab3394f0ff3675505ea6781591000b5a5594706dd2f` | 34119 | YES |
| F:/ppc-checkpoints/PPC-P2-PREPARED-TRANSITION-01-candidate.tar.gz | `8da211e034dd514ed58f3871381a458183c737336c9a6ca99b59d261a3e70f58` | 461609 | YES |

## 3. Frozen reference inputs (binary SHA256 + byte length)

| input | sha256 | bytes |
|---|---|---|
| src/game/ai/__tests__/fixtures/ppcId01-human-roots.json (24 roots) | `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09` | 264328 |
| GAMEPLAY.md (rule authority) | `e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34` | 21128 |

24 frozen roots present and intact:
G6T1 G6T2 G6T3 G5T1 G5T2 G5T3 G5T4 G2T1 G2T2 G2T3 G2T4 G2T5 G2T6 G2T7 G2T8
G1T1 G1T2 G1T3 G1T4 G1T5 G1T6 G1T7 G1T8 G1T9.
No root deleted; H0=1 / H1=2 and the 600000 node cap are carried unchanged.

## 4. Process / benchmark census (live, read-only — nothing killed)

Large node processes inspected by command line:

| PID | WS | identity | belongs to this repo? |
|---|---|---|---|
| 36308 | ~263 MB | `F:\docmap-studio\...\next\dist\server\lib\start-server.js` | NO (external docmap-studio) |
| 5348 | ~92 MB | same docmap-studio Next.js server; **owns port 3255** | NO |
| 42484 | ~69 MB | `tools/ai-eval/reliability-final-run.mjs --base=http://127.0.0.1:3255 --out=.local/ai-reliability-cont-20261115/final-run --repeats=3 --interval=65000` | NO |
| 28624 | ~48 MB | `.local/ai-reliability-cont-20261115/review/watch.mjs` | NO |

The remaining ~30 `node.exe` / `node_repl.exe` at ~1.5 MB are idle Qoder MCP
servers (not benchmark workers).

**DUPLICATE_BENCHMARK_CHECK = REQUIRED → result: no benchmark for THIS repo.**
`tools/ai-eval/reliability-final-run.mjs` and `.local/ai-reliability-cont-20261115/`
do **not exist** under `F:\小猫小鼠`; the running reliability benchmark targets
port 3255, which is the external docmap-studio server. It is unrelated to this
repo's AI and does not consume this repo's frozen fixtures. It was left running
(external process; killing it would be an unauthorized destructive action).

Impact on this seal: the external benchmark adds CPU contention, but the seal
verdicts are **correctness** tree-search results (boolean quantifier proofs), not
timing gates. `elapsedMs` is recorded as informational only;
`ABSOLUTE_DEADLINE_GATE = BLOCKED` and no timing metric is a seal criterion.

## 5. Concurrency discipline

- `HEAVY_WORKER_CONCURRENCY = 1` for every probe invocation.
- vitest config `PPC-CAT-STRATEGY-SEAL-01/probe/vitest.config.mts`:
  `fileParallelism:false`, `maxWorkers:1`, run with `--no-file-parallelism`.
- `SERIAL_FRESH_REPETITIONS = TRUE` (each root re-searched fresh; no cross-root
  memo reuse; no parallel workers).
- No leftover Node worker from this round is spawned outside the serial vitest
  process; the process exits when the suite finishes.

## 6. Artifact preservation

- Previous round `PPC-CAT-STRATEGY-01/` is **read-only** this round; no file in it
  is overwritten. Corrected results are written under `PPC-CAT-STRATEGY-SEAL-01/`
  with `_V2` / `RECERTIFICATION` names.
- `COMMIT = NO`, `PUSH = NO`, `MERGE = NO`.