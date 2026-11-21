#!/usr/bin/env bash
# Wait (bounded) for the host to pass the FIVE-consecutive-probe admission gate.
# Usage: wait_admit.sh [maxAttempts] [sleepSeconds]
set -euo pipefail
cd "$(dirname "$0")/../.."
MAX="${1:-20}"
SLEEP="${2:-45}"
for i in $(seq 1 "$MAX"); do
  if node PPC-ORACLE-HOTPATH-ATTRIBUTION-01/scripts/admission.mjs 2560; then
    exit 0
  fi
  echo "admission refused (attempt $i/$MAX); waiting ${SLEEP}s"
  sleep "$SLEEP"
done
echo "admission never passed"; exit 1