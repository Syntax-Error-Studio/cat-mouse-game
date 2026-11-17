#!/usr/bin/env python3
"""
PPC-D2-PCV-COUNTERLINE-01 / G0 preflight — READ-ONLY.

Writes nothing outside its own stdout. Reads:
  - git HEAD / branch / status (via `git rev-parse` / `git status --porcelain`)
  - the five frozen artifact identities (full SHA256, never prefixes)
  - the live production source hashes that must NOT change
  - the presence/absence of a same-named D2 benchmark directory

Resource admission (FREE_PHYS_MB >= 4096, FREE_COMMIT_MB >= 8192) is measured by
`probe/resource_snapshot.ps1` and merged into the manifest, because Python has no
authoritative Windows memory API here.

Run:
  python PPC-D2-PCV-COUNTERLINE-01/probe/d2_pilot_preflight.py
"""
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

EXPECTED_HEAD = "48eaac6c4f3801d351787696ba5876995b64e8d8"
EXPECTED_BRANCH = "ppc/p1-id-state-identity-fix"

FROZEN = [
    (
        "FIXTURE_SHA256",
        "src/game/ai/__tests__/fixtures/ppcId01-human-roots.json",
        "1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09",
    ),
    (
        "P5_SHA256",
        "PPC-CAT-EVALUATOR-ABLATION-01/PRODUCTION_100MS_RESULTS.json",
        "9d50560f107da52107cb68be94f4ac90214f8a50aabbc948f8f3114215278775",
    ),
    (
        "T2_CANDIDATE_FREEZE_SHA256",
        "PPC-T2-PCV-RESCUE-01/CANDIDATE_PLANS.json",
        "8f5a3f9d99ac2f61c895255e72650b3761418cb58ff5152b7d5e94619f8fc3ed",
    ),
    (
        "TAIL_CANDIDATE_SHA256",
        "PPC-T2-PCV-TAIL-01/TAIL_CANDIDATES.json",
        "39cc3569fbe2a9e7955b37e91ef203b07486ff7a02f3998dd32bc8004fcae8b8",
    ),
    (
        "SEAL_KERNEL_SHA256",
        "PPC-CAT-STRATEGY-SEAL-01/probe/seal_lib.ts",
        "453915d3fd3a69bda5d113dd7e5732d20424a7f97cff739cf9b0aeee576a779b",
    ),
]

# Live production sources this round must not touch (values are the preflight
# readings; the contract is "unchanged before and after", recorded both times).
PRODUCTION_SOURCES = [
    "src/game/ai/expectiminimax.ts",
    "src/game/ai/hardTurnPlanner.ts",
    "src/game/ai/planQuality.ts",
    "src/game/ai/legalActions.ts",
    "src/game/ai/preparedActions.ts",
    "src/game/ai/planBound.ts",
    "src/game/ai/transposition.ts",
    "src/game/ai/deadlineContext.ts",
    "src/game/ai/simulator.ts",
    "src/game/config.ts",
    "src/game/engine.ts",
    "src/game/openingFairness.ts",
    "GAMEPLAY.md",
]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git(*args):
    return subprocess.run(
        ["git"] + list(args), cwd=ROOT, capture_output=True, text=True, encoding="utf-8"
    ).stdout.strip()


def main():
    out = {"round": "PPC-D2-PCV-COUNTERLINE-01", "probe": "d2_pilot_preflight", "readOnly": True}

    out["head"] = git("rev-parse", "HEAD")
    out["branch"] = git("branch", "--show-current")
    status = [l for l in git("status", "--porcelain").splitlines() if l.strip()]
    out["gitStatusLineCount"] = len(status)
    out["gitStatusTrackedModified"] = sum(1 for l in status if l[:2].strip() and not l.startswith("??"))
    out["gitStatusUntracked"] = sum(1 for l in status if l.startswith("??"))

    out["frozenIdentities"] = []
    for name, rel, expected in FROZEN:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            out["frozenIdentities"].append(
                {"name": name, "path": rel, "present": False, "match": False}
            )
            continue
        actual = sha256(p)
        out["frozenIdentities"].append(
            {
                "name": name,
                "path": rel,
                "present": True,
                "bytes": os.path.getsize(p),
                "expected": expected,
                "actual": actual,
                "match": actual == expected,
            }
        )

    out["productionSources"] = [
        {"path": rel, "sha256": sha256(os.path.join(ROOT, rel)), "bytes": os.path.getsize(os.path.join(ROOT, rel))}
        for rel in PRODUCTION_SOURCES
        if os.path.exists(os.path.join(ROOT, rel))
    ]

    out["duplicateD2Benchmark"] = {
        "sameNamedDirectoryPresent": os.path.isdir(os.path.join(ROOT, "PPC-D2-PCV-COUNTERLINE-01")),
        "note": "the directory this probe lives in IS the round directory; the check is whether a "
                "second, pre-existing D2 pilot artifact set exists",
        "preExistingD2Artifacts": sorted(
            n
            for n in os.listdir(ROOT)
            if os.path.isdir(os.path.join(ROOT, n)) and "D2" in n and "PCV" in n
        ),
    }

    ok_head = out["head"] == EXPECTED_HEAD
    ok_branch = out["branch"] == EXPECTED_BRANCH
    ok_frozen = all(f["match"] for f in out["frozenIdentities"])
    out["gates"] = {
        "HEAD_MATCH": ok_head,
        "BRANCH_MATCH": ok_branch,
        "ALL_FROZEN_IDENTITIES_MATCH": ok_frozen,
        "IDENTITY_GATE": "PASS" if (ok_head and ok_branch and ok_frozen) else "FAIL",
    }

    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
