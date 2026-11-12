"""PPC-SEARCH-01 — read-only summariser for the sweep artefacts.

Reads out/s1..s5 .jsonl (append-only, one row per root) and prints the numbers
that the report quotes. It never writes into src/ and never re-runs a search.
"""
import json
import os
import statistics as st

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


def rows(name):
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        return []
    out = []
    with open(p, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def d1():
    r = rows("s1_d1_parity.jsonl")
    print("== S1 D1 parity: %d roots ==" % len(r))
    fork_bad = [x["id"] for x in r if x["forkDiff"] or x["forkNodeDelta"] != 0]
    ab_bad = [x for x in r if x["abDiff"]]
    print("  fork-control failures:", fork_bad or "NONE")
    print("  A-vs-B field diffs   :", len(ab_bad), [x["id"] for x in ab_bad] or "")
    node_ratio = [x["b"]["nodes"] / max(1, x["a"]["nodes"]) for x in r]
    wall_ratio = [x["b"]["ms"] / max(0.001, x["a"]["ms"]) for x in r]
    print("  node ratio B/A  median %.3f  min %.3f  max %.3f" % (st.median(node_ratio), min(node_ratio), max(node_ratio)))
    print("  wall ratio B/A  median %.3f  min %.3f  max %.3f" % (st.median(wall_ratio), min(wall_ratio), max(wall_ratio)))


def d2():
    r = rows("s2_d2_parity.jsonl")
    print("== S2 D2 parity: %d roots ==" % len(r))
    bad = [x for x in r if x["diff"]]
    print("  A-vs-B field diffs:", len(bad))
    for x in bad:
        print("   ", x["id"], x["diff"])
    capped = [x["id"] for x in r if x["budgetCut"] > 0]
    print("  budget-truncated rows:", capped or "NONE")
    replay_bad = [x["id"] for x in r if not x["replay"]["ok"]]
    print("  plan replay failures:", replay_bad or "NONE")

    def col(k):
        return [x[k] for x in r]

    nr = [x["nodesB"] / max(1, x["nodesA"]) for x in r]
    sp = [x["msA"] / max(0.001, x["msB"]) for x in r]
    print("  nodes  A total %d  B total %d  ratio %.3f" % (sum(col("nodesA")), sum(col("nodesB")), sum(col("nodesB")) / max(1, sum(col("nodesA")))))
    print("  wall   A total %.0f ms  B total %.0f ms" % (sum(col("msA")), sum(col("msB"))))
    print("  per-root node ratio B/A: median %.3f  max %.3f (%s)" % (st.median(nr), max(nr), r[nr.index(max(nr))]["id"]))
    print("  per-root speedup A/B  : median %.3f  min %.3f (%s)  max %.3f (%s)" % (
        st.median(sp), min(sp), r[sp.index(min(sp))]["id"], max(sp), r[sp.index(max(sp))]["id"]))
    print("  PRIMARY GATE (median speedup >= 1.25):", "PASS" if st.median(sp) >= 1.25 else "FAIL")
    print()
    print("  %-7s %10s %10s %7s %8s %8s %7s %9s" % ("root", "nodesA", "nodesB", "B/A", "cutA", "cutB", "chA", "chB"))
    for x in r:
        print("  %-7s %10d %10d %7.2f %8d %8d %7d %9d" % (
            x["id"], x["nodesA"], x["nodesB"], x["nodesB"] / max(1, x["nodesA"]), x["cutA"], x["cutB"], x["chanceA"], x["chanceB"]))
    return r


def controls_():
    r = rows("s3_controls.jsonl")
    print("== S3 controls: %d runs ==" % len(r))
    bad = [x for x in r if x["diff"]]
    print("  failures:", len(bad))
    for x in bad:
        print("   ", x["id"], "D%d" % x["d"], x["diff"])
    for x in r:
        print("   %-16s D%d legal=%-2d valueA=%-8s valueB=%-8s nodes %d/%d" % (
            x["id"], x["d"], x["legalActions"], x["a"]["value"], x["b"]["value"], x["a"]["nodes"], x["b"]["nodes"]))


def tt():
    r = rows("s4_tt_soundness.jsonl")
    print("== S4 TT ON vs OFF (D1): %d runs ==" % len(r))
    bad = [x for x in r if x["diff"]]
    print("  value/plan diffs:", len(bad), [x["id"] + "/" + x["arm"] for x in bad] or "")
    for arm in ("A", "B"):
        sub = [x for x in r if x["arm"] == arm]
        if sub:
            print("   %s nodesOn total %d  nodesOff total %d  ratio %.2f" % (
                arm, sum(x["nodesOn"] for x in sub), sum(x["nodesOff"] for x in sub),
                sum(x["nodesOff"] for x in sub) / max(1, sum(x["nodesOn"] for x in sub))))


def live():
    r = rows("s5_live_100ms.jsonl")
    print("== S5 100 ms deadline lane: %d runs ==" % len(r))
    ids = []
    for x in r:
        if x["id"] not in ids:
            ids.append(x["id"])
    print("  %-7s %-3s %8s %10s %10s %9s %8s" % ("root", "arm", "depthMed", "wallMed", "fallbacks", "planLen", "nodesMed"))
    for i in ids:
        for arm in ("A", "B"):
            sub = [x for x in r if x["id"] == i and x["arm"] == arm]
            if not sub:
                continue
            print("  %-7s %-3s %8.1f %10.1f %10d %9.1f %8d" % (
                i, arm, st.median([x["completedDepth"] for x in sub]),
                st.median([x["wallMs"] for x in sub]),
                sum(1 for x in sub if x["fallback"]),
                st.median([x["planLen"] for x in sub]),
                st.median([x["nodes"] for x in sub])))


if __name__ == "__main__":
    d1()
    print()
    d2()
    print()
    controls_()
    print()
    tt()
    print()
    live()
