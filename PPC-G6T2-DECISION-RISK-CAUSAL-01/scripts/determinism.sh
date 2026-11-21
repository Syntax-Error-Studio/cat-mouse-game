#!/usr/bin/env bash
# G5 determinism: N serial rounds, each round = 3 fresh vitest processes (G1/G3/G4)
# followed by a normalized digest. No two processes overlap.
set -u
N=${1:-3}
cd "$(dirname "$0")/../.." || exit 90
R=PPC-G6T2-DECISION-RISK-CAUSAL-01
P=$R/probe
mkdir -p "$R/logs"
for i in $(seq 1 "$N"); do
  for t in g1_cache_errata g3_risk g4_cross_root; do
    npx vitest run --config "$P/vitest.config.mts" "$P/$t.test.ts" \
      >"$R/logs/det_r${i}_${t}.log" 2>&1 || { echo "FAIL round=$i test=$t"; tail -40 "$R/logs/det_r${i}_${t}.log"; exit 1; }
  done
  mkdir -p "$R/logs/snap_r$i"
  cp "$R"/TACTICAL_RISK_WITNESSES.json "$R"/CROSS_ROOT_SHADOW_RESULTS.json "$R/logs/snap_r$i/" 2>/dev/null
  node "$P/digest.mjs" >"$R/logs/digest_r${i}.json" || exit 2
  echo "round $i done: $(node -e "console.log(require('./$R/logs/digest_r${i}.json').__combined)")"
done
node -e '
const fs=require("fs");
const n=Number(process.argv[1]);
const ds=[];
for(let i=1;i<=n;i++) ds.push(JSON.parse(fs.readFileSync(`PPC-G6T2-DECISION-RISK-CAUSAL-01/logs/digest_r${i}.json`,"utf8")));
const combined=new Set(ds.map(d=>d.__combined));
const keys=Object.keys(ds[0]).filter(k=>k!=="__combined");
const perKey={};
for(const k of keys) perKey[k]=new Set(ds.map(d=>d[k])).size;
const ok=combined.size===1 && Object.values(perKey).every(v=>v===1);
const out={rounds:n,combined:[...combined],perFileDistinctCounts:perKey,verdict:ok?"DETERMINISTIC":"DRIFT"};
fs.writeFileSync("PPC-G6T2-DECISION-RISK-CAUSAL-01/logs/determinism_summary.json",JSON.stringify(out,null,2));
console.log(JSON.stringify(out));
process.exit(ok?0:3);
' "$N"