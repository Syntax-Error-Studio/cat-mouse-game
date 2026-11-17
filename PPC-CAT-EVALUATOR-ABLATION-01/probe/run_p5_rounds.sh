#!/usr/bin/env bash
# PPC-CAT-EVALUATOR-ABLATION-01 §5 — P5 real-100ms production rounds (SERIAL).
# GATED wall-clock experiment: run ONLY after re-probing census_min.ps1 and
# confirming the host is quiescent (no external heavy benchmark). One fresh
# process per round; arm order alternates by (round+rootIndex)%2 inside the probe.
# Usage: bash PPC-CAT-EVALUATOR-ABLATION-01/probe/run_p5_rounds.sh [lastRound]
#   lastRound defaults to 5; pass 10 to run the pre-registered extension.
set -euo pipefail
cd "F:/小猫小鼠"
CFG=PPC-CAT-EVALUATOR-ABLATION-01/probe/vitest.config.mts
PROD=PPC-CAT-EVALUATOR-ABLATION-01/probe/p5_production.test.ts
AGG=PPC-CAT-EVALUATOR-ABLATION-01/probe/p5_aggregate.test.ts
LOG=PPC-CAT-EVALUATOR-ABLATION-01/logs/p5_production.log
LAST="${1:-5}"
: > "$LOG"
for r in $(seq 1 "$LAST"); do
  echo "=== P5 ROUND $r ===" >> "$LOG"
  ABLATION_ROUND="$r" npx vitest run --config "$CFG" "$PROD" >> "$LOG" 2>&1
done
echo "=== P5 AGGREGATE (N=$LAST) ===" >> "$LOG"
npx vitest run --config "$CFG" "$AGG" >> "$LOG" 2>&1
echo "P5 DONE (rounds 1..$LAST)" >> "$LOG"