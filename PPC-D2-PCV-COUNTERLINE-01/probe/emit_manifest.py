#!/usr/bin/env python3
"""
PPC-D2-PCV-COUNTERLINE-01 — manifest + checksum emitter.

Writes:
  SOURCE_MANIFEST.json   (never contains its own hash)
  SHA256SUMS.txt         (never contains its own hash)

Two self-reference rules carried over from earlier rounds:
  1. a manifest must not register its own digest -> `selfHashIncluded: false`;
  2. the checksum file is computed AFTER every other file is final, and is
     excluded from its own listing (otherwise it records a stale value).
"""
import datetime
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROUND = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(ROUND, ".."))


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def rel_repo(p):
    return os.path.relpath(p, REPO).replace("\\", "/")


def read_text(path):
    """PowerShell's Tee-Object on this host writes UTF-16LE; tolerate both."""
    raw = open(path, "rb").read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig")
    return raw.decode("utf-8")


def main():
    identity = json.load(open(os.path.join(ROUND, "logs", "preflight_identity.json"), encoding="utf-8"))
    status = json.load(open(os.path.join(ROUND, "PHASE_STATUS.json"), encoding="utf-8"))

    resume_path = os.path.join(ROUND, "G0_RESUME_CHECK.json")
    resume = json.load(open(resume_path, encoding="utf-8")) if os.path.exists(resume_path) else None

    state_path = os.path.join(ROUND, "D2_MACHINE_STATE.json")
    pilot = json.load(open(state_path, encoding="utf-8")) if os.path.exists(state_path) else None

    resource = {}
    for line in read_text(os.path.join(ROUND, "logs", "resource_preflight.txt")).splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("HEAVY_WORKER pid"):
            k, _, v = line.partition("=")
            resource[k] = v

    deliverables = []
    for dirpath, _dirnames, filenames in os.walk(ROUND):
        for name in sorted(filenames):
            p = os.path.join(dirpath, name)
            # 自指排除：本清单不得登记自己的摘要（否则记录的是上一版的值）
            if name in ("SHA256SUMS.txt", "SOURCE_MANIFEST.json"):
                continue
            deliverables.append(
                {"path": rel_repo(p), "sha256": sha256(p), "bytes": os.path.getsize(p)}
            )
    deliverables.sort(key=lambda d: d["path"])

    manifest = {
        "round": "PPC-D2-PCV-COUNTERLINE-01",
        "type": "OFFLINE_RESEARCH / SOURCE_AUDIT / D2_PILOT",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "selfHashIncluded": False,
        "selfHashNote": "ARCHIVE_MANIFEST/SOURCE_MANIFEST must not contain its own digest; "
                        "the authoritative copy is the entry in SHA256SUMS.txt, which is computed after this file is final.",
        "phaseCompleted": ["G0", "G1"],
        "phaseNotPerformed": ["G2", "G3", "G4", "G5"],
        "identity": {
            "head": identity["head"],
            "branch": identity["branch"],
            "gitStatusLineCount": identity["gitStatusLineCount"],
            "gitStatusTrackedModified": identity["gitStatusTrackedModified"],
            "gitStatusUntracked": identity["gitStatusUntracked"],
            "workingTreeDiffersFromHead": True,
            "preExistingChangesDisclosure": "The working tree carries pre-existing uncommitted changes "
                                            "(15 tracked modifications) that predate this round and were preserved untouched.",
        },
        "frozenInputs": identity["frozenIdentities"],
        "productionSources": identity["productionSources"],
        "gates": status["gates"],
        "blockers": status["blockers"],
        "resource": {
            "capturedAt": resource.get("CAPTURED_AT"),
            "freePhysMb": int(resource.get("FREE_PHYS_MB", -1)),
            "freeCommitMb": int(resource.get("FREE_COMMIT_MB", -1)),
            "committedMb": int(resource.get("COMMITTED_MB", -1)),
            "commitLimitMb": int(resource.get("COMMIT_LIMIT_MB", -1)),
            "processCount": int(resource.get("PROCESS_COUNT", -1)),
            "cpuLoadPct": int(resource.get("CPU_LOAD_PCT", -1)),
            "gateFreePhysMb": 4096,
            "gateFreeCommitMb": 8192,
            "admission": "FAIL",
        },
        "concurrency": {
            "heavyWorkerCount": int(resource.get("HEAVY_WORKER_COUNT", -1)),
            "heavyWorkerCommands": [
                l.split("cmd=", 1)[1]
                for l in read_text(os.path.join(ROUND, "logs", "resource_preflight.txt")).splitlines()
                if "HEAVY_WORKER pid" in l
            ],
            "belongsToThisRound": False,
            "actionTaken": "NONE (not terminated, not suspended, not reprioritised)",
        },
        "priorArtifactsOverwritten": False,
        "productionSourceChanged": False,
        "d2SearchPerformed": False,
        "deliverables": deliverables,
        "selfExcluded": ["SOURCE_MANIFEST.json", "SHA256SUMS.txt"],
    }

    # --- RESUME-CHECK overlay (2026-11-16 17:27..17:31) --------------------
    # The `resource` / `concurrency` blocks above are the ORIGINAL preflight
    # records and must stay untouched. The resume check is reported separately
    # so that neither snapshot can be mistaken for the other.
    if resume is not None:
        rs = resume["resourceSummary"]
        rg = resume["gates"]
        manifest["phaseNotPerformedNote"] = (
            "G2..G5 remain NOT_PERFORMED after the resume check: "
            "RESOURCE_ADMISSION = FAIL on FREE_PHYS_MB."
        )
        manifest["admissionLatest"] = resume.get("admissionLatest", "FAIL")
        manifest["admissionHistory"] = resume.get("admissionHistory")
        manifest["resumeCheck"] = {
            "round": resume["round"],
            "generatedAt": resume["generatedAt"],
            "siblingTask": resume["siblingTask"],
            "samples": len(resume["samples"]),
            "freePhysMbMin": rs["freePhysMin"],
            "freePhysMbMax": rs["freePhysMax"],
            "freeCommitMbMin": rs["freeCommitMin"],
            "freeCommitMbMax": rs["freeCommitMax"],
            "committedMbMin": rs["committedMin"],
            "committedMbMax": rs["committedMax"],
            "pagefileUsedMbMin": rs["pagefileUsedMin"],
            "pagefileUsedMbMax": rs["pagefileUsedMax"],
            "processCountMin": rs["processCountMin"],
            "processCountMax": rs["processCountMax"],
            "gates": rg,
            "heavyWorkerCount": resume["processInventory"]["heavyWorkerCount"],
            "externalBuildSessionPresent": resume["processInventory"]["externalBuildSessionPresent"],
            "d2SearchStarted": resume["execution"]["d2SearchStarted"],
        }

        rt = resume.get("retry")
        if rt is not None:
            manifest["phaseNotPerformedNote"] = (
                "RESOURCE_ADMISSION = PASS at RETRY (19:13). G2..G5 still NOT_PERFORMED: "
                "the task instruction is to stop after admission and wait for ChatGPT confirmation."
            )
            manifest["retryCheck"] = {
                "attempt": rt["attempt"],
                "window": rt["window"],
                "samples": len(rt["samples"]),
                "freePhysMbMin": rt["summary"]["freePhysMin"],
                "freePhysMbMax": rt["summary"]["freePhysMax"],
                "freeCommitMbMin": rt["summary"]["freeCommitMin"],
                "freeCommitMbMax": rt["summary"]["freeCommitMax"],
                "committedMbMin": rt["summary"]["committedMin"],
                "committedMbMax": rt["summary"]["committedMax"],
                "pagefileUsedMbMin": rt["summary"]["pagefileUsedMin"],
                "pagefileUsedMbMax": rt["summary"]["pagefileUsedMax"],
                "processCountMin": rt["summary"]["processCountMin"],
                "processCountMax": rt["summary"]["processCountMax"],
                "gates": rt["gates"],
                "heavyWorkerCount": rt["heavyWorkerCount"],
                "externalBuildSessionPresent": rt["externalBuildSessionPresent"],
                "systemRebooted": rt["systemRebooted"],
                "d2SearchStarted": rt["execution"]["d2SearchStarted"],
            }

    if pilot is not None:
        manifest["phaseCompleted"] = ["G0", "G1", "G2", "G3", "G4", "G5"]
        manifest["phaseNotPerformed"] = []
        manifest["d2SearchPerformed"] = bool(pilot["D2_SEARCH_COMPLETED"])
        manifest["phaseNotPerformedNote"] = (
            "G2..G5 performed on the single authorised root G1T9/E1 only. "
            "FULL_8_STRATA_BATCH remains NOT_AUTHORIZED and PRODUCTION_WIRING = NO."
        )
        manifest["pilot"] = pilot
        manifest["retryCheck"]["d2SearchStartedAfterRetry"] = True
        manifest["retryCheck"]["noteAfterRetry"] = (
            "Admission PASS at RETRY; G2 pilot executed afterwards under explicit user instruction.")

    out = os.path.join(ROUND, "SOURCE_MANIFEST.json")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    # Recompute AFTER the manifest is final, so its digest is the real one.
    lines = []
    for dirpath, _dirnames, filenames in os.walk(ROUND):
        for name in sorted(filenames):
            p = os.path.join(dirpath, name)
            if name == "SHA256SUMS.txt":
                continue
            lines.append(f"{sha256(p)}  {rel_repo(p)}")
    lines.sort(key=lambda l: l.split("  ", 1)[1])
    with open(os.path.join(ROUND, "SHA256SUMS.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")

    print(f"manifest entries: {len(deliverables)}")
    print(f"sha256sums lines: {len(lines)}")


if __name__ == "__main__":
    main()
