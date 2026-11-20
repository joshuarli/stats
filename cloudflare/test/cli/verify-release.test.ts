import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readReleaseEvidence } from "../../src/cli/verify/release-evidence.ts";
import { decideRelease } from "../../src/cli/verify/release-decide.ts";
import { runCli } from "./support.ts";

const now = 1200;
function bundle() {
  const root = resolve(import.meta.dirname, "../../../.work/tmp"); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "release-"));
  const workload = { id: "load", corpusSha256: "a".repeat(64), seed: 1, requestMix: { read: 100 }, concurrency: 1, payloadSizes: [10] };
  const workloadText = JSON.stringify(workload);
  const policy = { schema: "stats-release-policy/1", id: "test", baselineRelease: "old", candidateRelease: "new", workloadId: "load", workloadSha256: createHash("sha256").update(workloadText).digest("hex"), requiredSources: [{ source: "app", producer: "one" }], windows: { startMs: 1000, warmupMs: 0, measureMs: 100 }, minRequests: 100, maxEvidenceAgeMs: 500, limits: { maxErrorShare: 0.01, latency: { p95Ms: 20, p99Ms: 20, maxRelativeIncreasePercent: 10, absoluteFloorMs: 2 }, maxCpuRelativeIncreasePercent: 20, maxMemoryRelativeIncreasePercent: 20, maxRestarts: 0, maxQueueDepth: 2 }, histogramMaxRelativeError: 0.05, recovery: { required: true, method: "rollback" } };
  const cohort = (releaseId: string) => ({ releaseId, workloadId: "load", attempted: 100, succeeded: 100, failures: {}, bodyMismatches: 0, acknowledgedWrites: 10, readbackVerified: 10, lostWrites: 0, duplicateMismatches: 0, histogram: { relativeError: 0.01, buckets: [[10000, 100]] }, windowStartMs: 1000, windowEndMs: 1100, truncated: false });
  const observation = (releaseId: string) => ({ observer: { status: "ok", checkedAtMs: 1150 }, sources: [{ source: "app", producer: "one", releaseId, lastSeenMs: 1150, sequenceStart: { startedAtMs: 900, atMs: 1000, accepted: 0, dropped: 0, queued: 0 }, sequenceEnd: { startedAtMs: 900, atMs: 1100, accepted: 100, dropped: 0, queued: 0 }, received: 100 }], truncated: false, hostConfounded: false, resources: { cpuSeconds: 10, memoryPeakBytes: 100, restarts: 0 } });
  const files = { "policy.json": policy, "baseline.manifest.json": { releaseId: "old", components: { app: "b".repeat(64) } }, "candidate.manifest.json": { releaseId: "new", components: { app: "c".repeat(64) } }, "workload.json": workload, "ledger.json": { schema: "stats-release-evidence/1", baseline: cohort("old"), candidate: cohort("new") }, "observations.json": { schema: "stats-release-evidence/1", baseline: observation("old"), candidate: observation("new") }, "recovery.json": { method: "rollback", verifiedAtMs: 1150, previousRelease: "old", readbackVerified: true } };
  const write = () => { for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value)); };
  const decide = (at = now) => { write(); return decideRelease(readReleaseEvidence(dir, false), at); };
  return { dir, files, write, decide };
}

await test("release eligibility requires complete and correct evidence", () => {
  assert.equal(bundle().decide().verdict, "pass");
  const cases: [string, (b: ReturnType<typeof bundle>) => void, string, string][] = [
    ["missing source", b => { b.files["observations.json"].candidate.sources = []; }, "inconclusive", "source-missing"],
    ["producer absent", b => { b.files["policy.json"].requiredSources.push({ source: "app", producer: "two" }); }, "inconclusive", "source-missing"],
    ["mixed release", b => { b.files["observations.json"].candidate.sources[0]!.releaseId = "old"; }, "reject", "mixed-release"],
    ["lost write", b => { b.files["ledger.json"].candidate.lostWrites = 1; b.files["ledger.json"].candidate.readbackVerified = 9; }, "reject", "lost-writes"],
    ["wrong body", b => { b.files["ledger.json"].candidate.bodyMismatches = 1; }, "reject", "body-mismatch"],
    ["p99", b => { b.files["ledger.json"].candidate.histogram.buckets = [[30000, 100]]; }, "reject", "latency-p99"],
    ["observer", b => { b.files["observations.json"].candidate.observer.status = "failed"; }, "inconclusive", "observer-failed"],
    ["stale", b => { b.files["observations.json"].candidate.observer.checkedAtMs = 1; }, "inconclusive", "stale-evidence"],
    ["truncated", b => { b.files["ledger.json"].candidate.truncated = true; }, "inconclusive", "truncated"],
    ["drops", b => { b.files["observations.json"].candidate.sources[0]!.sequenceEnd.dropped = 1; }, "inconclusive", "delivery-incomplete"],
    ["queue not drained", b => { b.files["observations.json"].candidate.sources[0]!.sequenceEnd.queued = 1; }, "inconclusive", "delivery-incomplete"],
    ["sequence gap", b => { b.files["observations.json"].candidate.sources[0]!.received = 99; }, "inconclusive", "delivery-incomplete"],
    ["producer restarted", b => { b.files["observations.json"].candidate.sources[0]!.sequenceEnd.startedAtMs = 1050; }, "inconclusive", "delivery-incomplete"],
    ["recovery", b => { b.files["recovery.json"].readbackVerified = false; }, "inconclusive", "recovery-unverified"],
    ["coarse histogram", b => { b.files["ledger.json"].candidate.histogram.relativeError = 0.1; }, "inconclusive", "histogram-unusable"]
  ];
  for (const [name, change, verdict, code] of cases) { const b = bundle(); change(b); const result = b.decide(); assert.equal(result.verdict, verdict, name); assert.ok(result.reasons.some(reason => reason.code === code), name); }
  const absent = bundle(); absent.write(); rmSync(join(absent.dir, "recovery.json")); const withoutRecovery = decideRelease(readReleaseEvidence(absent.dir, false), now); assert.equal(withoutRecovery.verdict, "inconclusive"); assert.ok(withoutRecovery.reasons.some(reason => reason.code === "recovery-unverified"));
  const b = bundle(); b.files["ledger.json"].candidate.histogram.buckets = [[11000, 100]]; b.files["policy.json"].limits.latency.p99Ms = 10; assert.equal(b.decide().verdict, "pass");
  const pending = bundle(); pending.files["observations.json"].baseline.observer.checkedAtMs = 1050; pending.files["observations.json"].candidate.observer.checkedAtMs = 1050; for (const side of ["baseline", "candidate"] as const) { pending.files["observations.json"][side].sources[0]!.lastSeenMs = 1050; pending.files["observations.json"][side].sources[0]!.sequenceEnd.atMs = 1050; } pending.files["recovery.json"].verifiedAtMs = 1050; assert.equal(pending.decide(1050).verdict, "pending");
});

await test("improvement is independent of eligibility and decoding rejects unknown fields", () => {
  const b = bundle(); Object.assign(b.files["policy.json"], { improvement: { metric: "cpuSeconds", direction: "decrease", minChangePercent: 5 } }); b.files["observations.json"].candidate.resources.cpuSeconds = 11;
  assert.equal(b.decide().improvement, "regressed"); assert.equal(b.decide().verdict, "pass");
  Object.assign(b.files["policy.json"], { unexpected: true }); assert.throws(() => b.decide(), /unknown field/u);
});

await test("real CLI replays a recorded decision and rejects tampering", async () => {
  const b = bundle(); const result = b.decide();
  writeFileSync(join(b.dir, "decision.json"), JSON.stringify({ evaluatedAtMs: now, verdict: result.verdict, reasonCodes: result.reasons.map(reason => reason.code) }));
  const args = ["verify", "release", "--evidence", b.dir, "--replay", "--json"];
  const pass = await runCli(args, {}); assert.equal(pass.code, 0, pass.stderr); assert.equal((JSON.parse(pass.stdout) as { payload: { verdict: string } }).payload.verdict, "pass");
  writeFileSync(join(b.dir, "decision.json"), JSON.stringify({ evaluatedAtMs: now, verdict: "reject", reasonCodes: [] }));
  const mismatch = await runCli(args, {}); assert.equal(mismatch.code, 4); assert.equal((JSON.parse(mismatch.stdout) as { error: { code: string } }).error.code, "contract");
});
