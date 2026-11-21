#!/usr/bin/env bash
# Recompute every SHA256SUMS.txt line. Usage: verify_ledger.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
SUM=PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/SHA256SUMS.txt
ok=0; bad=0
while read -r h s p; do
  [ -z "${p:-}" ] && continue
  ah=$(sha256sum "$p" | cut -d' ' -f1)
  as=$(stat -c%s "$p")
  if [ "$h" = "$ah" ] && [ "$s" = "$as" ]; then ok=$((ok+1)); else bad=$((bad+1)); echo "BAD $p"; fi
done < "$SUM"
echo "ok=$ok bad=$bad"
[ "$bad" -eq 0 ]