#!/usr/bin/env bash
# Serial G4 round: three repetitions, each a fresh vitest process.
# Every launch is preceded by the five-consecutive-probe admission gate (floor 2560 MB).
# A launch is never retried with reduced roots/cap/repetitions.
set -euo pipefail
cd "$(dirname "$0")/../.."

VITEST="npx vitest run --config PPC-ORACLE-HOTPATH-ATTRIBUTION-01/probe/vitest.config.mts PPC-ORACLE-HOTPATH-ATTRIBUTION-01/probe/g4_parity_perf.test.ts"

for rep in 1 2 3; do
  echo "=== rep $rep: waiting for admission ==="
  bash PPC-ORACLE-HOTPATH-ATTRIBUTION-01/scripts/wait_admit.sh 25 60
  echo "=== rep $rep: launching (fresh process) ==="
  REP="$rep" $VITEST 2>&1 | tail -25
  echo "=== rep $rep done ==="
done
echo "ALL_REPS_DONE"