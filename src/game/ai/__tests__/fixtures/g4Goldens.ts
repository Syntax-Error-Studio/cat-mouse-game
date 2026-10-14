/**
 * Frozen G4 goldens, shared by `hybridLeaf.test.ts` (the S6 regression) and
 * `hybridLeafG4Falsification.test.ts` (the model-sensitivity proof).
 *
 * Two provenance classes, deliberately kept apart:
 *
 *  - `G4_AUDIT_GOLDENS` are the G0.4E-1.1 node-audit numbers for the frozen G4
 *    GOOD/BAD boundary states. They predate this round and were, in the audited
 *    test, the entire content of the claim. Here they are the EXPECTED OUTPUT of
 *    the live production evaluator, so a model/weights change breaks them.
 *  - `G4_BASELINE_RECORDED` are the plain heuristic values of the same two
 *    restored states, re-recorded from the current production `evaluateForCat`
 *    during the P0-3 fixture extraction (2026-10-13). They are a regression
 *    guard on the heuristic and the evidence that baseline MISRANKS this pair;
 *    they are NOT an independent audit number.
 */
export const G4_AUDIT_GOLDENS = {
  v1Good: 0.13444009609896948,
  v1Bad: -0.010821052917053802,
  vNetGood: 0.6572226744572904,
  vNetBad: -0.06693379475773628,
} as const;

export const G4_BASELINE_RECORDED = {
  good: -416.4473684210527,
  bad: 46.05263157894737,
} as const;
