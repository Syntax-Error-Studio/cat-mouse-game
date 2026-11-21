#!/usr/bin/env bash
# Recompute and compare every line in SHA256SUMS.txt. Exit 0 only if all match.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
total=0
while read -r sum p; do
  total=$((total+1))
  if [ ! -f "$p" ]; then echo "MISSING $p"; fail=$((fail+1)); continue; fi
  got=$(sha256sum "$p" | cut -d' ' -f1)
  if [ "$got" != "$sum" ]; then echo "MISMATCH $p"; fail=$((fail+1)); fi
done < SHA256SUMS.txt
echo "checked=$total failed=$fail"
[ "$fail" -eq 0 ]