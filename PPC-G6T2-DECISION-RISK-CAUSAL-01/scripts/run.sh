#!/usr/bin/env bash
# PPC-G6T2-DECISION-RISK-CAUSAL-01 — ONE fresh process per invocation (serial by construction).
# Usage: run.sh PHASE TESTFILE [PPC_PROD_REP=N]
set -u
PHASE=$1
TESTFILE=$2
EXTRA_ENV=${3:-}
cd "$(dirname "$0")/../.." || exit 90
mkdir -p "PPC-G6T2-DECISION-RISK-CAUSAL-01/logs"
LOG="PPC-G6T2-DECISION-RISK-CAUSAL-01/logs/${PHASE}.stdout.log"
if [ -n "$EXTRA_ENV" ]; then
  export "$EXTRA_ENV"
fi
npx vitest run --config PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/vitest.config.mts "$TESTFILE" >"$LOG" 2>&1
RC=$?
echo "RC=$RC LOG=$LOG"
exit $RC