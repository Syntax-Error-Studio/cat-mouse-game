#!/usr/bin/env bash
# PPC-CAT-EVALUATOR-ABLATION-01 §7.2/§7.3 — P6 search-cost pairs (SERIAL).
# GATED wall-clock experiment: run ONLY after re-probing census_min.ps1 and
# confirming a quiescent host. 20 A/A pairs (both E1) + 20 A/B pairs (E1,H1),
# ONE fresh process per run, HEAVY_WORKER_CONCURRENCY=1. Then §7.1 eval self-cost
# and the §7 aggregate. NO heap enlargement, NO rep reduction.
# Usage: bash PPC-CAT-EVALUATOR-ABLATION-01/probe/run_p6_pairs.sh
set -euo pipefail
cd "F:/小猫小鼠"
CFG=PPC-CAT-EVALUATOR-ABLATION-01/probe/vitest.config.mts
RUN=PPC-CAT-EVALUATOR-ABLATION-01/probe/p6_search_run.test.ts
EVAL=PPC-CAT-EVALUATOR-ABLATION-01/probe/p6_eval_cost.test.ts
AGG=PPC-CAT-EVALUATOR-ABLATION-01/probe/p6_perf_aggregate.test.ts
LOG=PPC-CAT-EVALUATOR-ABLATION-01/logs/p6_pairs.log
: > "$LOG"
for i in $(seq -w 1 20); do
  for spec in "aa_a:E1" "aa_b:E1" "ab_a:E1" "ab_b:H1"; do
    prefix="${spec%%:*}"; arm="${spec##*:}"
    rid="${prefix}_${i}"
    echo "=== P6 RUN $rid arm=$arm ===" >> "$LOG"
    ABLATION_ARM="$arm" ABLATION_RUN_ID="$rid" npx vitest run --config "$CFG" "$RUN" >> "$LOG" 2>&1
  done
done
echo "=== P6 §7.1 EVAL SELF-COST ===" >> "$LOG"
npx vitest run --config "$CFG" "$EVAL" >> "$LOG" 2>&1
echo "=== P6 §7 AGGREGATE ===" >> "$LOG"
npx vitest run --config "$CFG" "$AGG" >> "$LOG" 2>&1
echo "P6 DONE (80 runs + eval cost + aggregate)" >> "$LOG"