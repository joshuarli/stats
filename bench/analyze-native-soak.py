import argparse
import hashlib
import json
from pathlib import Path
import re
import statistics


HOUR_MS = 3_600_000
GROUPS = ("resources", "actors", "application", "bridge")


def analyze(records):
    problems = []
    if not records or records[0].get("kind") != "start":
        return {"state": "blocked", "causes": ["missing start record"]}
    start = records[0]
    if (not isinstance(start.get("image"), str) or not re.fullmatch(r"stats:[a-f0-9]{12}", start["image"])
            or type(start.get("version")) is not int or start["version"] <= 0
            or type(start.get("samplerPid")) is not int or start["samplerPid"] <= 0
            or not isinstance(start.get("scriptSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", start["scriptSha256"])):
        problems.append("missing or invalid collector or deployment identity")
    if not isinstance(start.get("gaps"), list) or any(not isinstance(gap, str) or not gap for gap in start["gaps"]):
        problems.append("missing or invalid coverage declaration")
    samples = [row for row in records if row.get("kind") == "sample"]
    ends = [row for row in records if row.get("kind") == "end"]
    if len(ends) != 1 or records[-1].get("kind") != "end" or not ends[0].get("complete"):
        problems.append("collection not complete")
    if len(samples) != start.get("samples") or [s.get("index") for s in samples] != list(range(len(samples))):
        problems.append("sample count or sequence mismatch")
    if ends and (ends[0].get("completedSamples") != len(samples) or ends[0].get("degradedSamples") != 0):
        problems.append("completion counts or unavailable groups")
    for sample in samples:
        if sample.get("error") or any(not isinstance(sample.get(key), dict) or "unavailable" in sample[key] for key in GROUPS):
            problems.append("sample error or unavailable group")
            break
    if any(any(isinstance(actor, dict) and actor.get("truncated") for actor in s.get("actors", {}).values()) for s in samples):
        problems.append("truncated actor population")
    resources = [s.get("resources", {}) for s in samples]
    if any(not isinstance(r, dict) or not isinstance(r.get("startedAt"), str) or not r["startedAt"]
           or type(r.get("oomKilled")) is not bool for r in resources):
        problems.append("missing application process identity")
    elif len({r["startedAt"] for r in resources}) != 1 or any(r["oomKilled"] for r in resources):
        problems.append("application restart or OOM")
    if not samples or samples[-1]["atMs"] - samples[0]["atMs"] < 24 * HOUR_MS:
        problems.append("less than 24 hours observed")
    if any(b["atMs"] <= a["atMs"] for a, b in zip(samples, samples[1:])):
        problems.append("nonmonotonic sample timestamps")
    if any(s.get("latenessSeconds", 0) > start.get("intervalSeconds", 60) for s in samples):
        problems.append("sample delayed by more than one interval")
    result = {"state": "blocked", "causes": sorted(set(problems)), "samples": len(samples),
              "deployment": {"image": start.get("image"), "version": start.get("version")},
              "coverageGaps": start.get("gaps"), "warmupHours": 6}
    if problems:
        return result
    anchor = samples[0]["atMs"]
    prior = [s for s in samples if 6 * HOUR_MS <= s["atMs"] - anchor < 12 * HOUR_MS]
    final = [s for s in samples if 12 * HOUR_MS <= s["atMs"] - anchor <= 24 * HOUR_MS]
    if not prior or not final:
        result["causes"].append("missing comparison windows")
        return result
    try:
        old_rss = statistics.median(s["resources"]["rssBytes"] for s in prior)
        new_rss = statistics.median(s["resources"]["rssBytes"] for s in final)
        result["rss"] = {"precedingSixHourMedianBytes": old_rss, "finalTwelveHourMedianBytes": new_rss,
                         "relativeChange": new_rss / old_rss - 1, "pass": abs(new_rss / old_rss - 1) <= .05}
        selectors = {"cleanupBacklog": lambda s: s["application"]["cleanupBacklog"],
                     "bridgeQueued": lambda s: s["bridge"]["producer"]["queued"]}
        names = set().union(*(s["actors"] for s in final))
        for name in sorted(names):
            selectors["actors:" + name] = lambda s, name=name: sum(s["actors"][name]["states"].values())
        result["trends"] = {}
        for name, select in selectors.items():
            medians = []
            for hour in range(12, 24):
                values = [select(s) for s in final if hour * HOUR_MS <= s["atMs"] - anchor < (hour + 1) * HOUR_MS]
                if not values:
                    raise ValueError("missing hourly window")
                medians.append(statistics.median(values))
            center = statistics.mean(medians)
            slope = sum((i - 5.5) * (v - center) for i, v in enumerate(medians)) / sum((i - 5.5) ** 2 for i in range(12))
            result["trends"][name] = {"hourlyMedians": medians, "slopePerHour": slope,
                                      "noUpwardTrendDemonstrated": slope <= 0}
        counters = {"liveInvocations": lambda s: s["application"]["liveInvocations"],
                    "accepted": lambda s: s["application"]["writes"]["accepted"],
                    "bridgeSent": lambda s: s["bridge"]["producer"]["sent"],
                    "bridgeDropped": lambda s: s["bridge"]["producer"]["dropped"]}
        result["traffic"] = {}
        retained = samples[len([s for s in samples if s["atMs"] - anchor < 6 * HOUR_MS]):]
        for name, select in counters.items():
            values = [select(s) for s in retained]
            reset = any(b < a for a, b in zip(values, values[1:]))
            result["traffic"][name] = {"delta": values[-1] - values[0], "counterRegression": reset}
            if reset:
                result["causes"].append("counter regression: " + name)
        result["retainedDatabaseBytes"] = {"afterWarmup": retained[0]["application"]["databaseBytes"],
                                           "final": retained[-1]["application"]["databaseBytes"]}
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        result["causes"].append("missing or invalid required metric")
        return result
    if not result["rss"]["pass"]:
        result["causes"].append("RSS median outside 5 percent bound")
    for name, trend in result["trends"].items():
        if not trend["noUpwardTrendDemonstrated"]:
            result["causes"].append("upward hourly median trend: " + name)
    result["measuredPlateauPass"] = not result["causes"]
    if result["coverageGaps"]:
        result["causes"].append("unobserved queue or lifecycle coverage remains")
    result["state"] = "fail" if not result["rss"]["pass"] else "blocked" if result["causes"] else "pass"
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Read-only native soak analysis; incomplete collection never passes")
    parser.add_argument("input")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    raw = Path(args.input).read_bytes()
    records = [json.loads(line) for line in raw.splitlines()]
    result = analyze(records)
    result["inputSha256"] = hashlib.sha256(raw).hexdigest()
    with open(args.output, "x", encoding="utf-8") as output:
        output.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"state": result["state"], "causes": result["causes"], "samples": result.get("samples")}))
