"""Judges a standby soak against its frozen definition.

  python3 bench/analyze-standby-soak.py SAMPLES.jsonl FAULTS.jsonl DEFINITION.json

SAMPLES is bench/standby-soak.py's output and FAULTS is bench/standby-soak-faults.py's. The
definition fixes every threshold before the run; its SHA-256 must equal the one the sampler bound
into its start record. Prints one JSON verdict: "pass", "fail" (with the failed criteria) or
"inconclusive" (with the missing evidence). Fault windows, including each one's recovery
allowance, are judged separately from steady operation; user-visible failures are counted in
both views.
"""
import hashlib
import json
from pathlib import Path
import statistics
import sys

HOUR_MS = 3_600_000


def load(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def trend(samples, select, anchor, hours):
    medians = []
    for hour in hours:
        values = [v for s in samples if hour * HOUR_MS <= s["atMs"] - anchor < (hour + 1) * HOUR_MS for v in [select(s)] if v is not None]
        if not values:
            return None
        medians.append(statistics.median(values))
    center = statistics.mean(medians)
    xs = list(range(len(medians)))
    slope = sum((x - statistics.mean(xs)) * (y - center) for x, y in zip(xs, medians)) / sum((x - statistics.mean(xs)) ** 2 for x in xs)
    return {"hourlyMedians": medians, "slopePerHour": slope, "relativeSlope": slope / center if center else (0 if slope == 0 else None)}


def analyze(records, faults, definition, definition_sha):
    missing, failed = [], []
    if not records or records[0].get("kind") != "start":
        return {"verdict": "inconclusive", "missing": ["no start record"]}
    start = records[0]
    if start.get("definitionSha256") != definition_sha:
        missing.append("sampler was not bound to this definition")
    samples = [r for r in records if r.get("kind") == "sample"]
    ends = [r for r in records if r.get("kind") == "end"]
    if len(ends) != 1 or not ends[0].get("complete"):
        missing.append("collection incomplete")
    if [s["index"] for s in samples] != list(range(len(samples))) or len(samples) != start["samples"]:
        missing.append("sample count or sequence mismatch")
    interval = start["intervalSeconds"]
    late = [s["index"] for s in samples if s["latenessSeconds"] > interval]
    if late:
        missing.append(f"{len(late)} samples later than one interval")
    if not samples or samples[-1]["atMs"] - samples[0]["atMs"] < definition["durationHours"] * HOUR_MS:
        missing.append("shorter than the declared duration")
    planned = [f for f in faults if f.get("kind") == "fault"]
    declared = definition["faults"]
    if [f["name"] for f in planned] != [f["name"] for f in declared]:
        missing.append("fault schedule differs from the definition")
    allowance = definition["recoveryS"] * 1000
    windows = [(f["startedAtMs"], f["endedAtMs"] + allowance, f["name"]) for f in planned if f.get("endedAtMs")]

    def in_fault(at):
        return next((name for begin, end, name in windows if begin <= at <= end), None)

    steady = [s for s in samples if in_fault(s["atMs"]) is None]
    unavailable = [s["index"] for s in steady if "unavailable" in s["guest"] or any(isinstance(s["guest"].get(k), dict) and "unavailable" in s["guest"][k] for k in ("application", "actors", "engineMetrics", "sources"))]
    if unavailable:
        missing.append(f"{len(unavailable)} steady samples with unavailable groups")
    result = {"samples": len(samples), "steadySamples": len(steady), "identity": start.get("identity"), "coverageGaps": start.get("gaps")}

    checks = [s for s in samples if "check" in s]
    steady_checks = [s for s in checks if in_fault(s["atMs"]) is None]
    ok = [s for s in steady_checks if s["check"].get("ok")]
    result["availability"] = {"checks": len(checks), "failedChecks": sum(1 for s in checks if not s["check"].get("ok")),
                              "steadyChecks": len(steady_checks), "steadyFailed": len(steady_checks) - len(ok)}
    if steady_checks and len(ok) / len(steady_checks) < definition["minSteadyCheckSuccess"]:
        failed.append("steady availability below the limit")
    for step, limits in definition["latencyMs"].items():
        values = sorted(next(x["ms"] for x in s["check"]["steps"] if x["name"] == step) for s in ok)
        if not values:
            missing.append(f"no {step} latency")
            continue
        q = lambda p: values[min(len(values) - 1, int(p * len(values)))]
        result.setdefault("latency", {})[step] = {"p95": q(0.95), "p99": q(0.99), "max": values[-1]}
        if q(0.95) > limits["p95"] or q(0.99) > limits["p99"]:
            failed.append(f"{step} latency above the limit")

    # Faults: each recovers to a passing check within the allowance.
    result["faults"] = []
    for f in planned:
        recovered = f.get("recoveredAfterS")
        result["faults"].append({"name": f["name"], "recoveredAfterS": recovered, "error": f.get("error")})
        if f.get("error") or recovered is None or recovered > definition["recoveryS"]:
            failed.append(f"fault {f['name']} did not recover within {definition['recoveryS']} s")

    # Restarts: identities change only inside a fault that restarts them.
    restarts = definition["restartingFaults"]
    previous = None
    unplanned = []
    for s in samples:
        guest = s["guest"]
        if "unavailable" in guest:
            continue
        current = (guest["identity"]["engineStartedAt"], guest["app"]["oldestStart"], guest["identity"]["app"], guest["identity"]["runtime"], guest["identity"]["engineImage"], guest["identity"]["engineConfigSha256"])
        if previous and current != previous:
            name = in_fault(s["atMs"])
            if name not in restarts or current[2:] != previous[2:]:
                unplanned.append({"index": s["index"], "fault": name})
        if guest["identity"]["engineOomKilled"]:
            unplanned.append({"index": s["index"], "oom": True})
        previous = current
    result["unplannedChanges"] = unplanned
    if unplanned:
        failed.append("unplanned restart or deployment change")

    # Engine loop: no run of refusals or deadline warnings outside fault windows.
    run, longest = 0, 0
    for s in steady:
        w = s["guest"].get("warnings") or {}
        run = run + 1 if (w.get("refusedConnect") or w.get("deadline")) else 0
        longest = max(longest, run)
    result["engineWarningRunSamples"] = longest
    if longest >= definition["maxWarningRunSamples"]:
        failed.append("sustained Engine refusals outside fault windows")

    # Bounded resources: plateau over the final half, as in P8.
    anchor = samples[0]["atMs"] if samples else 0
    half = definition["durationHours"] // 2
    final = [s for s in steady if s["atMs"] - anchor >= half * HOUR_MS and "unavailable" not in s["guest"]]
    prior = [s for s in steady if (half // 2) * HOUR_MS <= s["atMs"] - anchor < half * HOUR_MS and "unavailable" not in s["guest"]]
    plateau = {}
    for name, select in (("appRss", lambda s: s["guest"]["app"]["rssBytes"]), ("engineAnon", lambda s: s["guest"]["engine"]["anonBytes"])):
        if not prior or not final:
            missing.append("missing plateau windows")
            break
        old, new = statistics.median(select(s) for s in prior), statistics.median(select(s) for s in final)
        if old <= 0:
            plateau[name] = {"priorMedian": old, "finalMedian": new, "relativeChange": None}
            missing.append(f"{name} has no measured baseline")
            continue
        plateau[name] = {"priorMedian": old, "finalMedian": new, "relativeChange": new / old - 1}
        if abs(new / old - 1) > definition["maxMedianMemoryChange"]:
            failed.append(f"{name} did not plateau")
    queues = {"tabletStoreQueue": "rivet_depot_tablet_store_queue_depth", "logClientQueue": "rivet_depot_volume_log_client_queued_requests",
              "alarmParked": "rivet_depot_alarm_parked", "groupReadsQueued": "rivet_depot_tablet_group_reads_queued"}
    for name, family in queues.items():
        t = trend(final, lambda s, f=family: (s["guest"].get("engineMetrics") or {}).get(f), anchor, range(half, definition["durationHours"]))
        plateau[name] = t
        if t is None:
            missing.append(f"{name} has an hour without samples")
        elif t["slopePerHour"] > definition["maxQueueSlopePerHour"]:
            failed.append(f"{name} grows")
    actor_names = {n for s in final for n, v in (s["guest"].get("actors") or {}).items() if isinstance(v, dict)}
    for actor in sorted(actor_names):
        t = trend(final, lambda s, a=actor: sum(((s["guest"].get("actors") or {}).get(a) or {}).get("states", {}).values()) or None, anchor, range(half, definition["durationHours"]))
        plateau["actors:" + actor] = t
        if t and t["relativeSlope"] is not None and t["relativeSlope"] > definition["maxActorRelativeSlopePerHour"]:
            failed.append(f"actor population {actor} grows")
    result["plateau"] = plateau
    free = [s["guest"]["disk"]["freeBytes"] for s in samples if "unavailable" not in s["guest"]]
    result["disk"] = {"minFreeBytes": min(free) if free else None, "first": free[0] if free else None, "last": free[-1] if free else None}
    if free and min(free) < definition["minFreeBytes"]:
        failed.append("guest free disk below the floor")

    # Source coverage: every hourly export has every declared source attributed with usable families.
    # A planned collector restart leaves no attributable evidence for the hour that contains it, so
    # an export overlapping a restarting fault must report the restart and is listed apart.
    exports = [s["guest"]["sources"] for s in samples if isinstance(s["guest"].get("sources"), dict)]
    restarting = [(f["startedAtMs"], f["endedAtMs"]) for f in planned if f["name"] in restarts and f.get("endedAtMs")]
    gaps, excused = [], []
    if len(exports) < definition["durationHours"]:
        missing.append("fewer hourly source exports than hours")
    for export in exports:
        if "unavailable" in export:
            gaps.append({"fromMs": None, "unavailable": export["unavailable"]})
            continue
        if any(begin <= export["toMs"] and end >= export["fromMs"] for begin, end in restarting):
            statuses = sorted({r["detail"]["status"] for r in export["runtime"]})
            excused.append({"fromMs": export["fromMs"], "statuses": statuses})
            if any(r["detail"]["status"] not in ("ok", "collector-restart") for r in export["runtime"]):
                gaps.append({"fromMs": export["fromMs"], "statuses": statuses})
            continue
        rows = {r["detail"]["source"]: r for r in export["runtime"]}
        for source, families in definition["requiredSources"].items():
            row = rows.get(source)
            unusable = [f for f in families if not (row and row["detail"]["families"].get(f, {}).get("usable"))]
            if not row or not row["evidence"] or unusable:
                gaps.append({"fromMs": export["fromMs"], "source": source, "evidence": bool(row and row["evidence"]), "unusable": unusable})
    result["sourceGaps"] = gaps
    result["sourceHoursWithPlannedRestart"] = excused
    if gaps:
        missing.append(f"{len(gaps)} hourly source gaps")

    result["verdict"] = "fail" if failed else "inconclusive" if missing else "pass"
    result["failed"] = sorted(set(failed))
    result["missing"] = sorted(set(missing))
    return result


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: analyze-standby-soak.py SAMPLES.jsonl FAULTS.jsonl DEFINITION.json")
    definition_bytes = Path(sys.argv[3]).read_bytes()
    print(json.dumps(analyze(load(sys.argv[1]), load(sys.argv[2]), json.loads(definition_bytes), hashlib.sha256(definition_bytes).hexdigest()), indent=2))
