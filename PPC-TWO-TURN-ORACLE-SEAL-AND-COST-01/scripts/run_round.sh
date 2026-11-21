#!/usr/bin/env bash
# One serial fresh-process repetition of G1..G4. Usage: run_round.sh <n>
set -euo pipefail
R="${1:?round number required}"
cd "$(dirname "$0")/../.."
CFG=PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/vitest.config.mts
LOG=PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/logs
mkdir -p "$LOG"
{
  echo "=== fresh process round $R start $(date -Is) ==="
  npx vitest run --config "$CFG" \
    PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/g1_lineage.test.ts \
    PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/g2_duud_proof.test.ts \
    PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/g3_counterexamples.test.ts \
    PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/g3b_rule_isolation.test.ts \
    PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/g4_cost_ablation.test.ts \
    PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/g0_identity.test.ts
} 2>&1 | tee "$LOG/det_r$R.log"
node PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/digest.mjs | tee -a "$LOG/det_r$R.log"
cp "$LOG/digest.json" "$LOG/digest_r$R.json"
mkdir -p "$LOG/rep$R"
cp PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/DUUD_INDEPENDENT_PROOF.json \
   PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/INDEPENDENT_VERIFIER_RESULT.json \
   PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/QUANTIFIER_COUNTEREXAMPLES.json \
   PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/WITNESS_COST_ABLATION.json "$LOG/rep$R/"
cp "$LOG"/g[0-9]_*.json "$LOG/rep$R/"
echo "=== round $R done $(date -Is) ===" | tee -a "$LOG/det_r$R.log"