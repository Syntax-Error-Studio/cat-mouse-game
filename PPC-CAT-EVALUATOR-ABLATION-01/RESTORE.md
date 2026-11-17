# RESTORE — PPC-CAT-EVALUATOR-ABLATION-01

Archive (OUTSIDE the repo): `F:\ppc-checkpoints\PPC-CAT-EVALUATOR-ABLATION-01-candidate.tar.gz`
Archive SHA256: `d174a6a84c35fcf095179ccb4b05cd40cf530c09a50aaf669299d7d1e05ce4a4`  bytes: 355702  members: 128

## Restore steps (run anywhere OUTSIDE the repo)
```sh
mkdir -p <restore-dir>
tar --force-local -xzf "F:\ppc-checkpoints\PPC-CAT-EVALUATOR-ABLATION-01-candidate.tar.gz" -C <restore-dir>
# members unpack under PPC-CAT-EVALUATOR-ABLATION-01/...
```

## Verify (independent, read-only)
```sh
node F:/ppc-checkpoints/verify_seal_ablation.mjs
```

## Seal facts
- Content files: 126 (sealing outputs excluded: SOURCE_MANIFEST.json, SHA256SUMS.txt, SEAL_VERIFICATION.json, RESTORE.md).
- SOURCE_MANIFEST.json SHA256: `5d5a63774675add6ee401a64e6998cd5989751e4226e7260c33761a9285f7e83` (selfExcluded, no self-SHA).
- SHA256SUMS.txt SHA256: `9218ca6f6a70ff460280c06bc43d04dede74a0bd64432a0203462076bdd57c77` (records the manifest digest externally).
- Hash algorithm: sha256 over RAW BYTES (CRLF/LF agnostic); per-file line-ending recorded + re-verified.
- Restore: filesChecked=128 mismatches=0 lineEndingMismatches=0 missing=0 extra=0.

## Working-tree integrity (DISCLOSED DIVERGENCE)
- roundModifiedProduction = false (round-start proxy 2026-11-15T12:16:23.771Z; changedDuringRound=0).
- workingTreeDiffersFromHead = true; allPatchesPredateRound = true.
- leafSourcesMatchHead (evaluation.ts, correctedHoleLeaf.ts) = true.
- HEAD = 48eaac6c4f3801d351787696ba5876995b64e8d8 (frozen 48eaac6c4f3801d351787696ba5876995b64e8d8, matches=true).
- The tree carries PRE-EXISTING uncommitted production patches (user in-progress PPC-P2-PREPARED-TRANSITION-01 + timing-repair, mtimes 11-12..11-14), ALL predating this round. This round modified NO production source. Both ablation arms shared the SAME stable substrate ⇒ the RELATIVE E1-vs-H1 comparison is valid; the ABSOLUTE baseline is HEAD+patches, not pristine HEAD. Handed to ChatGPT for ruling.
- Frozen fixture src/game/ai/__tests__/fixtures/ppcId01-human-roots.json SHA256 matches frozen value: true.
- Previous rounds overwritten: NO. Archive refused to overwrite an existing file: enforced.

## Authority
PRODUCTION_EVALUATOR_CHANGE=NOT_AUTHORIZED. NEW_EFFICACY_AUTHORITY=NONE.
This seal preserves evidence only; it does NOT wire H1 into production.
