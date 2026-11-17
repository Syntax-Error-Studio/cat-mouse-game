#!/usr/bin/env bash
# PPC-P1-ID-01 — rebuild the isolated timing arms.
#
# The arms are THROWAWAY copies of `src/game` (never committed, never imported
# by production code). They exist only so one process can load two independent
# copies of the search stack and compare encoders under one harness.
#
#   arm-base    baseline encoder            (git show HEAD:src/game/ai/transposition.ts)
#   arm-base2   byte-identical copy of base (A/A calibration arm)
#   arm-cand    production candidate        (current working tree)
#   arm-v1      first candidate variant (own-property guard) — cost attribution only
#
# Usage:  bash PPC-P1-ID-01/perf/prepare_arms.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

ARMS=PPC-P1-ID-01/perf/.arms
rm -rf "$ARMS"

for n in arm-base arm-base2 arm-cand arm-v1; do
  mkdir -p "$ARMS/$n"
  cp -r src/game "$ARMS/$n/"
  find "$ARMS/$n" -type d -name __tests__ -prune -exec rm -rf {} +
done

git show HEAD:src/game/ai/transposition.ts > "$ARMS/arm-base/game/ai/transposition.ts"
cp "$ARMS/arm-base/game/ai/transposition.ts" "$ARMS/arm-base2/game/ai/transposition.ts"
cp "$ARMS/arm-base/game/ai/transposition.ts" "$ARMS/arm-v1/game/ai/transposition.ts"
cp src/game/ai/transposition.ts "$ARMS/arm-cand/game/ai/transposition.ts"

# arm-v1 = baseline boardKey with the hasOwnProperty guard (rejected variant).
python - "$ARMS/arm-v1/game/ai/transposition.ts" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
t = p.read_text(encoding='utf-8')
t = t.replace("import type { GameEngineState } from '../engine';",
              "import type { GameEngineState } from '../engine';\nimport type { CellType } from '../types';", 1)
needle = "function boardKey(board: GameEngineState['board']): string {"
insert = ("const TERRAIN_KEY_CODES: Readonly<Record<CellType, string>> = Object.freeze({\n"
          "  empty: 'e', box: 'b', trap: 'r', tunnel: 't', mouse_hole: 'm',\n"
          "  butter_spot: 'u', pile: 'p', wall: 'w', void: 'v',\n"
          "});\n\n")
t = t.replace(needle, insert + needle, 1)
old = '      parts.push(`${cell.type[0]}${piece[0]}${butter}`);'
new = ("      if (!Object.prototype.hasOwnProperty.call(TERRAIN_KEY_CODES, cell.type)) {\n"
       "        throw new Error(`Unknown terrain in state identity: ${cell.type}`);\n"
       "      }\n"
       "      const terrain = TERRAIN_KEY_CODES[cell.type];\n"
       "      parts.push(`${terrain}${piece[0]}${butter}`);")
assert t.count(old) == 1
p.write_text(t.replace(old, new), encoding='utf-8')
PY

for n in arm-base arm-base2 arm-cand arm-v1; do
  printf '%-9s %s\n' "$n" "$(sha256sum "$ARMS/$n/game/ai/transposition.ts" | cut -d' ' -f1)"
done
