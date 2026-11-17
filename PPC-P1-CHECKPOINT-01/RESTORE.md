# PPC-P1-CHECKPOINT-01 — restore instructions

Baseline commit: `48eaac6c4f3801d351787696ba5876995b64e8d8`
Branch: `ppc/p1-id-state-identity-fix`
`core.autocrlf` at capture time: `true`

## What this archive is

A byte-exact copy of the candidate DELTA over the baseline commit, plus every
evidence directory produced by this line of work (P1-ID / TIME-01 / TIME-02 /
PLAN-01 / QUALITY-01 / CLOSURE-01 / CLOSURE-FIX-01). It is **not** a full tree:
files this line never touched are not included.

## How to rebuild the candidate

1. Clone the repository and check out `48eaac6c4f3801d351787696ba5876995b64e8d8` (a clean tree, no local changes).
2. Extract this archive to any directory **outside** the clone.
3. Copy `source/src/...` over the clone, overwriting (bytes, not patches).
4. Verify every path in `CHECKPOINT_MANIFEST.json` hashes to its recorded
   `sha256` with the recorded byte length. Any mismatch = restore failed.
5. `evidence/` is documentation only; nothing in it is needed to build.
6. `npx tsc -b` and `npx vitest run` should then behave exactly as this round
   reported.

## Hard rules

* **Do not use `git apply` on this repository.** In this repo it prints
  `Skipped patch` for these paths and still exits 0 — a silent no-op. Copy bytes.
* **Do not normalise line endings.** `src/game/engine.ts` is CRLF; every other
  source member is LF. A CRLF/LF conversion changes `sha256`, so the restore
  check would fail (correctly).
* **Nothing here is committed.** The candidate lives in the working tree only;
  this archive is the only durable copy of it.
