import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("standby_soak", Path(__file__).with_name("analyze-standby-soak.py"))
soak = importlib.util.module_from_spec(spec)
spec.loader.exec_module(soak)

MINUTE = 60_000
SOURCES = {"engine:live": ["rivet_topology_discovery_heartbeat_reads_total"], "worker:stats:0": ["openorange_worker_info"]}
DEFINITION = {"durationHours": 24, "recoveryS": 120, "minSteadyCheckSuccess": 0.99, "latencyMs": {"ingest": {"p95": 500, "p99": 1000}},
              "restartingFaults": ["app-restart"], "maxWarningRunSamples": 3, "maxMedianMemoryChange": 0.05, "maxQueueSlopePerHour": 0.5,
              "maxActorRelativeSlopePerHour": 0.02, "minFreeBytes": 2 << 30, "requiredSources": SOURCES,
              "faults": [{"name": "app-restart", "kind": "app-restart", "atHours": 3}]}
FAULT_AT = 3 * 60 * MINUTE


def series():
    rows = [{"kind": "start", "definitionSha256": "d", "samples": 1441, "intervalSeconds": 60, "gaps": ["declared"], "identity": {}}]
    for index in range(1441):
        at = index * MINUTE
        restarted = at > FAULT_AT + 30_000
        guest = {"identity": {"app": "app-1", "runtime": "rt-1", "engineImage": "sha256:e", "engineConfigSha256": "c", "engineStartedAt": "t0",
                              "engineRestartCount": 0, "engineOomKilled": False},
                 "app": {"rssBytes": 800, "oldestStart": 2 if restarted else 1}, "engine": {"memoryBytes": 2000, "anonBytes": 1500},
                 "disk": {"freeBytes": 5 << 30}, "warnings": {"refusedConnect": 0, "deadline": 0},
                 "engineMetrics": {"rivet_depot_tablet_store_queue_depth": 0, "rivet_depot_volume_log_client_queued_requests": 0,
                                   "rivet_depot_alarm_parked": 0, "rivet_depot_tablet_group_reads_queued": 0},
                 "application": {}, "actors": {"observation-store": {"states": {"pending": 14}, "truncated": False}}}
        if index and index % 60 == 0:
            guest["sources"] = {"fromMs": at - 3_720_000, "toMs": at - 120_000,
                                "runtime": [{"evidence": {"releaseId": "rt-1"}, "detail": {"source": s, "status": "ok", "families": {f: {"usable": True} for f in fams}}} for s, fams in SOURCES.items()]}
        row = {"kind": "sample", "index": index, "atMs": at, "latenessSeconds": 0.1, "guest": guest}
        if index % 5 == 0:
            row["check"] = {"ok": True, "seq": str(at + 7), "steps": [{"name": "ingest", "ok": True, "ms": 90}]}
        rows.append(row)
    rows.append({"kind": "end", "complete": True})
    faults = [{"kind": "fault", "name": "app-restart", "startedAtMs": FAULT_AT, "endedAtMs": FAULT_AT + 20_000, "recoveredAfterS": 9, "error": None},
              {"kind": "ledger", "found": [r["atMs"] + 7 for r in rows if r.get("check")]}]
    return rows, faults


def judge(rows, faults):
    return soak.analyze(rows, faults, DEFINITION, "d")


class StandbySoakTests(unittest.TestCase):
    def test_a_complete_healthy_series_passes(self):
        result = judge(*series())
        self.assertEqual(result["verdict"], "pass", result)

    def test_a_lost_acknowledged_write_fails(self):
        rows, faults = series()
        faults[-1]["found"] = faults[-1]["found"][:-1]
        result = judge(rows, faults)
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("lost acknowledged writes", result["failed"])

    def test_a_restart_outside_its_fault_fails(self):
        rows, faults = series()
        for row in rows[900:-1]:
            row["guest"]["identity"]["engineStartedAt"] = "t1"
        result = judge(rows, faults)
        self.assertIn("unplanned restart or deployment change", result["failed"])

    def test_sustained_refusals_outside_faults_fail_but_inside_do_not(self):
        rows, faults = series()
        for row in rows[181:184]:
            row["guest"]["warnings"]["refusedConnect"] = 5
        self.assertEqual(judge(copy.deepcopy(rows), faults)["verdict"], "pass")
        for row in rows[600:603]:
            row["guest"]["warnings"]["deadline"] = 2
        self.assertIn("sustained Engine refusals outside fault windows", judge(rows, faults)["failed"])

    def test_missing_evidence_is_inconclusive_not_pass(self):
        rows, faults = series()
        rows[61]["guest"]["sources"] = {"unavailable": "URLError"}
        self.assertEqual(judge(rows, faults)["verdict"], "inconclusive")
        rows, faults = series()
        self.assertEqual(judge(rows[:-1] + [{"kind": "end", "complete": False}], faults)["verdict"], "inconclusive")
        rows, faults = series()
        self.assertEqual(judge(rows, faults[:-1])["verdict"], "inconclusive")

    def test_an_hour_with_a_planned_collector_restart_is_excused_but_other_gaps_are_not(self):
        rows, faults = series()
        restart_hour = rows[1 + 240]["guest"]["sources"]
        for row in restart_hour["runtime"]:
            row["evidence"], row["detail"]["status"] = None, "collector-restart"
        result = judge(rows, faults)
        self.assertEqual(result["verdict"], "pass", result)
        self.assertEqual(len(result["sourceHoursWithPlannedRestart"]), 1)
        rows[1 + 600]["guest"]["sources"]["runtime"][0]["evidence"] = None
        self.assertEqual(judge(rows, faults)["verdict"], "inconclusive")

    def test_a_fault_that_does_not_recover_in_time_fails(self):
        rows, faults = series()
        faults[0]["recoveredAfterS"] = 150
        self.assertIn("fault app-restart did not recover within 120 s", judge(rows, faults)["failed"])


if __name__ == "__main__":
    unittest.main()
