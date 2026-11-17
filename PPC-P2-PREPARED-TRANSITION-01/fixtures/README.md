# fixtures/

This round does **not** introduce a new frozen fixture.

The 24 frozen human roots and their fixed-D1 baseline are reused verbatim:

| fixture | path | sha256 |
|---|---|---|
| 24 human roots | `src/game/ai/__tests__/fixtures/ppcId01-human-roots.json` | `1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09` |
| fixed-D1 baseline | `src/game/ai/__tests__/fixtures/ppcId01-baseline-d1.json` | recorded in `FIXED_D1_PARITY_RESULTS.json` |

Both are asserted byte-for-byte by the probes before any measurement
(`ROOT_FIXTURE_SHA256` in `probe/duplicateWitness.test.ts`,
`probe/benchD1.test.ts`, `probe/stageEvidence.test.ts` and in the in-repo test
`src/game/ai/__tests__/preparedTransition.test.ts`).

Copying them here would create a second, drift-prone copy of a frozen authority,
so the directory is intentionally empty.
