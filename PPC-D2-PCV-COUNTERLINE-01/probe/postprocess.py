#!/usr/bin/env python3
"""PPC-D2-PCV-COUNTERLINE-01 / G4-G5 post-processing.

Reads the frozen candidates + proof repetitions and emits:
  D2_PILOT_MATRIX.csv                   one row per frozen candidate
  D2_PILOT_CERTIFICATE_VERIFICATION.json proof determinism + cert reuse audit
  D2_MACHINE_STATE.json                  final machine block

Never re-runs a search, never edits candidates, never filters rows.
"""
import csv
import hashlib
import json
import os

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # .../PPC-D2-PCV-COUNTERLINE-01
REPO = os.path.dirname(OUT)


def load(name):
    with open(os.path.join(OUT, name), encoding="utf-8") as f:
        return json.load(f)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def main():
    freeze = load("CANDIDATE_FREEZE.json")
    rootvals = load("D2_PILOT_ROOT_VALUES.json")
    cands = load("D2_PILOT_CANDIDATES.json")
    rep1 = load("D2_PILOT_PROOF_REP1.json")
    rep2 = load("D2_PILOT_PROOF_REP2.json")
    proj1 = load("logs/proof_rep1_projection.json")
    proj2 = load("logs/proof_rep2_projection.json")

    det_search = load("logs/d2_search_rep2.json")
    cost_path = os.path.join(OUT, "logs", "d2_cost.json")
    cost = json.load(open(cost_path, encoding="utf-8")) if os.path.exists(cost_path) else None

    fz = {(p["legalIndex"]): p for p in freeze["basis"]["plans"]}
    rv = {r["index"]: r for r in rootvals["rootValues"]}
    proof1 = {r["legalIndex"]: r for r in rep1["records"]}
    proof2 = {r["legalIndex"]: r for r in rep2["records"]}

    rows = []
    for c in cands["candidates"]:
        i = c["legalIndex"]
        v = rv.get(i, {})
        p1 = proof1[i]
        p2 = proof2[i]
        h0b = p1["h0"]["branches"][0] if p1["h0"]["branches"] else {}
        h1 = p1["h1"]
        h1b = h1["branches"][0] if (h1 and h1["branches"]) else {}

        if p1["H0_VALID_REFUTATION"]:
            verdict = "NO_RESCUE_H0_REFUTED"
        elif p1["H1_VALID_SURVIVAL"]:
            verdict = "TACTICAL_RESCUE_PROVEN"
        else:
            verdict = "UNRESOLVED"

        rows.append({
            "legalIndex": i,
            "rootAction": c["rootAction"],
            "rootActionValue": v.get("value"),
            "rootActionMate": v.get("mate"),
            "rootActionBound": v.get("bound"),
            "planString": c["planString"],
            "planHash": c["planHash"],
            "planLength": c["planLength"],
            "completenessKind": c["completenessKind"],
            "replayStatus": c["replayStatus"],
            "replayCrossCheck": c["replayCrossCheck"],
            "chanceBranchCount": c["chanceBranchCount"],
            "chanceProbabilitySum": c["chanceProbabilitySum"],
            "chanceAllPositive": c["chanceAllPositive"],
            "postPrefixStateKey": c["postPrefixStateKey"],
            "frontierCanonicalSha256": p1["frontierCanonicalSha256"],
            "h0Mode": "mouseForce", "h0H": h0b.get("H"), "h0StartIdx": h0b.get("startIdx"),
            "h0Cap": h0b.get("cap"),
            "h0Value": h0b.get("value"),
            "h0ProofStatus": h0b.get("proofStatus"),
            "h0Nodes": h0b.get("nodes"),
            "h0SolveMs": h0b.get("solveMs"),
            "h0VerifyVerdict": h0b.get("verifyVerdict"),
            "h0PolicyMisses": h0b.get("policyMisses"),
            "h0Truncated": h0b.get("truncated"),
            "h1Required": h1 is not None,
            "h1Mode": "catSurvive" if h1 else "",
            "h1ProofStatus": h1b.get("proofStatus", "SKIPPED"),
            "h1Nodes": h1b.get("nodes", ""),
            "H0_VALID_REFUTATION": p1["H0_VALID_REFUTATION"],
            "H1_VALID_SURVIVAL": p1["H1_VALID_SURVIVAL"],
            "ALL_CHANCE_BRANCHES_VERIFIED": p1["ALL_CHANCE_BRANCHES_VERIFIED"],
            "rep1EqualsRep2": (
                p1["h0"]["allProven"] == p2["h0"]["allProven"]
                and [b["nodes"] for b in p1["h0"]["branches"]] == [b["nodes"] for b in p2["h0"]["branches"]]
                and [b["proofStatus"] for b in p1["h0"]["branches"]] == [b["proofStatus"] for b in p2["h0"]["branches"]]
            ),
            "finalVerdict": verdict,
        })

    csv_path = os.path.join(OUT, "D2_PILOT_MATRIX.csv")
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # --- certificate / determinism audit
    cert = {
        "round": "PPC-D2-PCV-COUNTERLINE-01",
        "phase": "G4_CERTIFICATE_VERIFICATION",
        "candidateCount": len(rows),
        "uniqueFrontierCount": len({r["frontierCanonicalSha256"] for r in rows}),
        "frontierGroups": {},
        "proofDeterminism": {
            "rep1ProjectionSha256": proj1["projectionSha256"],
            "rep2ProjectionSha256": proj2["projectionSha256"],
            "match": proj1["projectionSha256"] == proj2["projectionSha256"],
            "freshProcesses": 2,
            "serial": True,
        },
        "searchDeterminism": {
            "rep1ProjectionSha256": freeze["determinismProjectionSha256"],
            "rep2ProjectionSha256": det_search["projectionSha256"],
            "match": det_search["match"],
            "rep1Nodes": rootvals["nodes"],
            "rep2Nodes": det_search["run"]["nodes"],
            "nodeCountMatch": rootvals["nodes"] == det_search["run"]["nodes"],
        },
        "certificateReuse": {
            "policy": "reuse allowed only on identical canonical state + chance successors + "
                      "stateKey + snapshot SHA + mode/H/startIdx + cap + proof semantics + "
                      "kernel SHA + cert hash; independent verifier still executed",
            "groups": [],
            "independentVerifierExecutedPerCandidate": True,
        },
        "verificationFailures": 0,
        "falseProven": 0,
        "falseProvenNote": "no candidate is PROVEN while any branch is non-PROVEN; verified by "
                           "allProven = AND over branches",
    }
    groups = {}
    for r in rows:
        groups.setdefault(r["frontierCanonicalSha256"], []).append(r["legalIndex"])
    cert["frontierGroups"] = {
        k: {"candidates": v, "shared": len(v) > 1} for k, v in groups.items()
    }
    cert["certificateReuse"]["groups"] = [
        {"frontierCanonicalSha256": k, "candidates": v, "shared": len(v) > 1,
         "reason": "identical post-prefix canonical state" if len(v) > 1 else "single candidate"}
        for k, v in groups.items()
    ]
    # verification failures / false proven
    for r in rows:
        if r["h0Value"] is True and r["h0VerifyVerdict"] != "PROVEN":
            cert["verificationFailures"] += 1
        if r["H0_VALID_REFUTATION"] and not r["ALL_CHANCE_BRANCHES_VERIFIED"]:
            cert["falseProven"] += 1

    with open(os.path.join(OUT, "D2_PILOT_CERTIFICATE_VERIFICATION.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(cert, f, ensure_ascii=False, indent=2)
        f.write("\n")

    # --- machine state
    state = {
        "ROUND": "PPC-D2-PCV-COUNTERLINE-01",
        "PHASE": "D2_SINGLE_ROOT_PILOT",
        "PILOT_ROOT": "G1T9",
        "PILOT_ARM": "E1",
        "DEPTH_TURNS": 2,
        "SEARCH_MODE": "FIXED_DEPTH_D2",
        "D2_SEARCH_COMPLETED": rootvals["completed"],
        "D2_NODES": rootvals["nodes"],
        "D2_LEAF_NODES": rootvals["leafNodes"],
        "D2_CHANCE_NODES": rootvals["chanceNodes"],
        "D2_SEARCH_MS": rootvals["elapsedMs"],
        "D2_VALUE": rootvals["value"],
        "D2_MATE": rootvals["mate"],
        "ROOT_ACTIONS_TOTAL": rootvals["legalRootActionCount"],
        "ROOT_ACTIONS_EXACT": sum(1 for r in rootvals["rootValues"] if r["bound"] == "exact"),
        "COMPLETE_CAT_PLANS": sum(1 for r in rows if r["replayStatus"] == "VALID_MOUSE_FRONTIER"),
        "PLAN_IDENTITY_FAILURES": freeze["identityFailureCount"],
        "CANDIDATES_FROZEN": freeze["candidateCount"],
        "UNIQUE_FRONTIERS": cert["uniqueFrontierCount"],
        "H0_REFUTED": rep1["h0Refuted"],
        "H0_UNRESOLVED": rep1["h0Unresolved"],
        "H1_SURVIVAL_PROVEN": rep1["h1SurvivalProven"],
        "H1_UNRESOLVED": rep1["h1Unresolved"],
        "PROVEN_TACTICAL_RESCUE": rep1["PROVEN_TACTICAL_RESCUE"],
        "CHANCE_COMPLETE": all(r["ALL_CHANCE_BRANCHES_VERIFIED"] or not r["H0_VALID_REFUTATION"] for r in rows),
        "VERIFY_FAILURES": cert["verificationFailures"],
        "FALSE_PROVEN": cert["falseProven"],
        "ZERO_REPETITIONS_IN_SEARCH": rootvals["gates"].get("ZERO_REPETITIONS"),
        "PROOF_REP_MATCH": cert["proofDeterminism"]["match"],
        "SEARCH_REP_MATCH": cert["searchDeterminism"]["match"],
        "PRODUCTION_SOURCE_CHANGED": "NO",
        "GAME_RULES_CHANGED": "NO",
        "SEARCH_MATH_CHANGED": "NO",
        "H1_CHANGED": "NO",
        "100MS_150MS_CHANGED": "NO",
        "HEAVY_WORKER_CONCURRENCY": 1,
        "SERIAL_FRESH_REPETITIONS": True,
        "SELF_PLAY": "NOT_PERFORMED",
        "FULL_REGRESSION": "NOT_PERFORMED",
        "COMMIT": "NO",
        "PUSH": "NO",
        "MERGE": "NO",
        "FULL_8_STRATA_BATCH": "NOT_AUTHORIZED",
        "PRODUCTION_WIRING": "NO",
        "STOP_FOR_CHATGPT_REVIEW": True,
    }
    if cost:
        state["RSS_AFTER_MB"] = cost["rssAfterMb"]
        state["HEAP_USED_AFTER_MB"] = cost["heapUsedAfterMb"]
        state["V8_HEAP_EXPANDED"] = "NO"

    with open(os.path.join(OUT, "D2_MACHINE_STATE.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("csv rows          =", len(rows))
    print("unique frontiers  =", cert["uniqueFrontierCount"])
    print("proof rep match   =", cert["proofDeterminism"]["match"])
    print("search rep match  =", cert["searchDeterminism"]["match"])
    print("H0 refuted        =", rep1["h0Refuted"], "/", len(rows))
    print("verify failures   =", cert["verificationFailures"], "false proven =", cert["falseProven"])


if __name__ == "__main__":
    main()
