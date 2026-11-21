#!/usr/bin/env bash
# Recomputes the 3-column ledger (sha256  size  path). Exit 0 only if all match.
set -u
cd "$(dirname "$0")/../.." || exit 90
R=PPC-G6T2-DECISION-RISK-CAUSAL-01
ok=0
bad=0
while read -r h s p; do
  [ -z "${h:-}" ] && continue
  if [ ! -f "$p" ]; then echo "MISSING $p"; bad=$((bad + 1)); continue; fi
  a=$(sha256sum "$p" | cut -d' ' -f1)
  sz=$(stat -c %s "$p")
  if [ "$a" = "$h" ] && [ "$sz" = "$s" ]; then ok=$((ok + 1)); else echo "BAD $p"; bad=$((bad + 1)); fi
done <"$R/SHA256SUMS.txt"
echo "ok=$ok bad=$bad"
[ "$bad" = 0 ]