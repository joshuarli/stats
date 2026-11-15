import copy
import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("soak", Path(__file__).with_name("analyze-native-soak.py"))
soak = importlib.util.module_from_spec(spec)
spec.loader.exec_module(soak)


def complete():
    rows = [{"kind": "start", "samples": 1441, "intervalSeconds": 60, "gaps": [],
             "image": "stats:0123456789ab", "version": 24, "samplerPid": 3384,
             "scriptSha256": "0" * 64}]
    for index in range(1441):
        rows.append({"kind": "sample", "index": index, "atMs": index * 60_000,
                     "resources": {"startedAt": "fixed", "rssBytes": 1000, "oomKilled": False},
                     "actors": {"observation": {"states": {"unknown": 1}, "truncated": False}},
                     "application": {"cleanupBacklog": 0, "liveInvocations": index, "writes": {"accepted": index}, "databaseBytes": 100 + index},
                     "bridge": {"producer": {"queued": 0, "sent": index, "dropped": 0}}})
    rows.append({"kind": "end", "complete": True, "completedSamples": 1441, "degradedSamples": 0})
    return rows


class AnalysisTests(unittest.TestCase):
    def test_missing_identity_or_coverage_evidence_never_passes(self):
        for key in ("image", "version", "samplerPid", "scriptSha256", "gaps"):
            with self.subTest(header=key):
                rows = complete()
                del rows[0][key]
                self.assertEqual(soak.analyze(rows)["state"], "blocked")
        for key in ("startedAt", "oomKilled"):
            with self.subTest(resource=key):
                rows = complete()
                for row in rows[1:-1]:
                    del row["resources"][key]
                self.assertEqual(soak.analyze(rows)["state"], "blocked")

    def test_complete_flat_series_and_traffic(self):
        result = soak.analyze(complete())
        self.assertEqual(result["state"], "pass")
        self.assertEqual(result["traffic"]["accepted"]["delta"], 1080)
        self.assertEqual(result["retainedDatabaseBytes"]["final"], 1540)

    def test_incomplete_and_unavailable_never_pass(self):
        rows = complete()
        self.assertEqual(soak.analyze(rows[:-1])["state"], "blocked")
        rows[400]["bridge"] = {"unavailable": "TimeoutError"}
        self.assertIn("sample error or unavailable group", soak.analyze(rows)["causes"])
        rows[400]["actors"] = {"unavailable": "TimeoutError"}
        self.assertIn("sample error or unavailable group", soak.analyze(rows)["causes"])

    def test_missing_sample_and_restart_invalidate(self):
        rows = complete()
        del rows[20]
        self.assertIn("sample count or sequence mismatch", soak.analyze(rows)["causes"])
        rows = complete()
        rows[900]["resources"]["startedAt"] = "restarted"
        self.assertIn("application restart or OOM", soak.analyze(rows)["causes"])

    def test_rss_bound_and_warmup(self):
        rows = complete()
        for row in rows[1:361]:
            row["resources"]["rssBytes"] = 100000
        self.assertTrue(soak.analyze(rows)["rss"]["pass"])
        for row in rows[721:-1]:
            row["resources"]["rssBytes"] = 1060
        result = soak.analyze(rows)
        self.assertFalse(result["rss"]["pass"])
        self.assertEqual(result["state"], "fail")

    def test_growing_queue_and_actor_population(self):
        rows = complete()
        for row in rows[1:-1]:
            row["bridge"]["producer"]["queued"] = row["index"]
            row["actors"]["observation"]["states"]["unknown"] = row["index"]
        result = soak.analyze(rows)
        self.assertFalse(result["measuredPlateauPass"])
        self.assertIn("upward hourly median trend: actors:observation", result["causes"])

    def test_coverage_gaps_and_counter_regression_stay_explicit(self):
        rows = complete()
        rows[0]["gaps"] = ["runtime inbox unavailable"]
        result = soak.analyze(rows)
        self.assertTrue(result["measuredPlateauPass"])
        self.assertEqual(result["state"], "blocked")
        rows = copy.deepcopy(rows)
        rows[800]["application"]["writes"]["accepted"] = 0
        self.assertTrue(soak.analyze(rows)["traffic"]["accepted"]["counterRegression"])


if __name__ == "__main__":
    unittest.main()
